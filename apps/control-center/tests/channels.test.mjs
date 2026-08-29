import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannelService, publicChannel, normalizeWebhookUrl } from "../src/channels.mjs";

function hmac(secret, payload) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * 出站守卫要解析 DNS 才能判断域名目标是否安全。CI 或本机若开了 fake-ip 代理
 * （Clash 一类，常见 198.18.0.0/15），真实 DNS 会把所有域名解析到保留段，
 * 守卫就会一律误报。测试注入固定公网 IP，让断言只依赖被测逻辑、不依赖本机网络栈。
 */
const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 }];

async function fixture(t, fetchImpl, dnsLookup = PUBLIC_DNS) {
  const dir = await mkdtemp(join(tmpdir(), "514cc-channels-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const events = [];
  const eventStore = { emit: async (type, detail) => { events.push({ type, detail }); } };
  const service = await createChannelService({ dataRoot: dir, eventStore, fetchImpl, pollIdleMs: 10, dnsLookup }).init();
  t.after(() => service.close());
  return { dir, service, events };
}

test("channels: CRUD persists atomically and secrets never leak to public shape", async (t) => {
  const { dir, service } = await fixture(t);
  const channel = await service.create({ type: "webhook_in", name: "入站", config: { secret: "s3cr3t-514" }, enabled: true });
  assert.equal(channel.config.secret, "***", "public shape redacts secret");

  const raw = JSON.parse(await readFile(join(dir, "channels.json"), "utf8"));
  assert.equal(raw.channels[0].config.secret, "s3cr3t-514", "disk keeps the real secret");

  const listed = service.list();
  assert.equal(listed[0].config.secret, "***");
  assert.equal(publicChannel(null), null);

  const updated = await service.update(channel.id, { enabled: false, name: "改名" });
  assert.equal(updated.name, "改名");
  assert.equal(updated.enabled, false);

  assert.equal(await service.remove(channel.id), true);
  assert.equal(service.list().length, 0);
  assert.equal(await service.remove(channel.id), false);
});

test("channels: webhook_out signs body with HMAC header", async (t) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const { service } = await fixture(t, fetchImpl);
  const channel = await service.create({ type: "webhook_out", name: "出站", config: { url: "https://hooks.example.com/x", secret: "topsecret" } });
  const result = await service.send(channel.id, { hello: "world" });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const signature = calls[0].options.headers["x-signature-sha256"];
  assert.equal(signature, hmac("topsecret", JSON.stringify({ hello: "world" })));
});

test("channels: webhook_in verifies HMAC over raw body (good and bad paths)", async (t) => {
  const { service } = await fixture(t);
  const channel = await service.create({ type: "webhook_in", name: "入站", config: { secret: "s3cr3t-514" } });
  const id = channel.id;
  const rawText = '{"event":"deploy","n":1}';

  await assert.rejects(
    () => service.receiveWebhook(id, rawText, hmac("wrong", rawText)),
    { code: "CHANNEL_BAD_SIGNATURE" },
  );
  const ok = await service.receiveWebhook(id, rawText, hmac("s3cr3t-514", rawText));
  assert.equal(ok.ok, true);

  const events = service.recentEvents();
  assert.equal(events[0].kind, "inbound");
  assert.equal(events[0].payload.event, "deploy");
});

test("channels: webhook_in rate limit trips at 60/min", async (t) => {
  const { service } = await fixture(t);
  const channel = await service.create({ type: "webhook_in", name: "限流", config: { secret: "rate-limit-secret" } });
  const rawText = "x";
  const signature = hmac("rate-limit-secret", rawText);
  for (let index = 0; index < 60; index += 1) {
    await service.receiveWebhook(channel.id, rawText, signature);
  }
  await assert.rejects(
    () => service.receiveWebhook(channel.id, rawText, signature),
    { code: "CHANNEL_RATE_LIMITED" },
  );
});

test("channels: webhook_in create/update enforce 8+ char secret (parity with probe and UI)", async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(
    () => service.create({ type: "webhook_in", config: { secret: "short" } }),
    { code: "CHANNEL_CONFIG" },
  );
  const channel = await service.create({ type: "webhook_in", config: { secret: "long-enough-514" } });
  // 掩码回传不算改动；真实新值低于下限必须拒写
  const masked = await service.update(channel.id, { config: { secret: "***" } });
  assert.equal(masked.config.secret, "***");
  await assert.rejects(
    () => service.update(channel.id, { config: { secret: "tiny" } }),
    { code: "CHANNEL_CONFIG" },
  );
});

test("channels: telegram poller parses updates into inbound events with offset persistence", async (t) => {
  const updates = [
    { update_id: 100, message: { text: "你好", chat: { id: 42 }, from: { username: "lo" } } },
    { update_id: 101, message: { text: "第二条", chat: { id: 42 }, from: { first_name: "L" } } },
  ];
  let polled = 0;
  const fetchImpl = async (url) => {
    polled += 1;
    if (url.includes("getUpdates")) {
      const batch = polled === 1 ? updates : [];
      return { ok: true, status: 200, json: async () => ({ ok: true, result: batch }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const { dir, service } = await fixture(t, fetchImpl);
  const channel = await service.create({
    type: "telegram",
    name: "tg",
    config: { token: "123:abc" },
    enabled: true,
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  const events = service.recentEvents();
  assert.equal(events.filter((event) => event.kind === "inbound").length, 2);
  assert.equal(events[1].from, "lo");
  // offset 已推进并持久化（重启不重复消费）
  const raw = JSON.parse(await readFile(join(dir, "channels.json"), "utf8"));
  assert.equal(raw.channels.find((entry) => entry.id === channel.id).config.offset, 102);
  // token 不出现在公开形态
  assert.equal(service.list()[0].config.token, "***");
});

test("channels: telegram send posts to Bot API with token in URL only", async (t) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  const { service } = await fixture(t, fetchImpl);
  const channel = await service.create({ type: "telegram", name: "tg", config: { token: "123:abc" } });
  const result = await service.send(channel.id, { chatId: 42, text: "ping" });
  assert.equal(result.ok, true);
  assert.ok(calls[0].url.includes("bot123:abc/sendMessage"));
  assert.equal(JSON.parse(calls[0].options.body).chat_id, 42);
});

test("channels: probe validates telegram via getMe and webhook_out via signed POST", async (t) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (String(url).includes("getMe")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 9, username: "forge_bot", first_name: "Forge" } }) };
    }
    return { ok: true, status: 204, json: async () => ({}) };
  };
  const { service } = await fixture(t, fetchImpl);
  const telegram = await service.probe({ type: "telegram", config: { token: "123:abc" } });
  assert.equal(telegram.ok, true);
  assert.equal(telegram.detail.username, "forge_bot");
  assert.ok(calls[0].url.includes("bot123:abc/getMe"));

  const outbound = await service.probe({
    type: "webhook_out",
    config: { url: "https://hooks.example.com/x", secret: "topsecret" },
  });
  assert.equal(outbound.ok, true);
  assert.equal(outbound.status, 204);
  assert.equal(calls[1].options.headers["x-signature-sha256"], hmac("topsecret", calls[1].options.body));

  const inbound = await service.probe({ type: "webhook_in", config: { secret: "longenough" } });
  assert.equal(inbound.detail.secretReady, true);
  await assert.rejects(() => service.probe({ type: "webhook_in", config: { secret: "short" } }), { code: "CHANNEL_CONFIG" });
  assert.throws(() => normalizeWebhookUrl("ftp://x.example"), { code: "CHANNEL_CONFIG" });
});

test("channels: telegram remembers inbound chatId and refuses send without one", async (t) => {
  const updates = [
    { update_id: 200, message: { text: "hi", chat: { id: 77 }, from: { username: "lo" } } },
  ];
  let polled = 0;
  const fetchImpl = async (url, options) => {
    polled += 1;
    if (String(url).includes("getUpdates")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: polled === 1 ? updates : [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }), options };
  };
  const { service } = await fixture(t, fetchImpl);
  const channel = await service.create({ type: "telegram", name: "tg", config: { token: "123:abc" }, enabled: true });
  await assert.rejects(() => service.send(channel.id, { text: "no chat" }), { code: "CHANNEL_CONFIG" });
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.equal(service.list()[0].config.chatId, 77);
  const sent = await service.send(channel.id, { text: "ping" });
  assert.equal(sent.ok, true);
  assert.equal(service.list()[0].inboundPath, undefined);
});

test("channels: inbound public shape exposes path and redacts secret", async (t) => {
  const { service } = await fixture(t);
  const channel = await service.create({ type: "webhook_in", name: "入站", config: { secret: "s3cr3t-ok" } });
  assert.equal(channel.inboundPath, `/api/channels/webhook/${channel.id}`);
  assert.equal(channel.config.secret, "***");
});

test("channels: update with masked secret values never overwrites the real secret", async (t) => {
  const { dir, service } = await fixture(t);
  const channel = await service.create({ type: "telegram", name: "tg", config: { token: "123:abc" } });
  // 前端常规编辑流：读取（token 已掩码）→ 改名整体回传
  const updated = await service.update(channel.id, {
    name: "改名",
    config: { token: "***", chatId: "42" },
  });
  assert.equal(updated.name, "改名");
  assert.equal(updated.config.chatId, "42");
  const raw = JSON.parse(await readFile(join(dir, "channels.json"), "utf8"));
  assert.equal(raw.channels[0].config.token, "123:abc", "real token survives masked write-back");
});

test("channels: corrupted store fails closed — writes rejected, file untouched", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "514cc-channels-corrupt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "channels.json"), "{not json", "utf8");
  const service = createChannelService({ dataRoot: dir });
  await assert.rejects(() => service.init(), /not json|JSON/i);
  await assert.rejects(() => service.create({ type: "webhook_in", config: { secret: "s3cr3t-ok" } }), { code: "CHANNELS_STORE_UNAVAILABLE" });
  const onDisk = await readFile(join(dir, "channels.json"), "utf8");
  assert.equal(onDisk, "{not json", "corrupt store must not be overwritten by empty state");
});

test("channels: remove awaits telegram poller exit (no double poll on restart)", async (t) => {
  let polled = 0;
  const fetchImpl = async (url) => {
    polled += 1;
    if (String(url).includes("getUpdates")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const { service } = await fixture(t, fetchImpl);
  const channel = await service.create({ type: "telegram", name: "tg", config: { token: "123:abc" }, enabled: true });
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  assert.ok(service._state.pollers.has(channel.id), "poller running");
  await service.remove(channel.id);
  assert.equal(service._state.pollers.size, 0, "poller entry cleaned up");
  const polledAtRemove = polled;
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.equal(polled, polledAtRemove, "loop fully stopped — no further polls after remove");
});
