/**
 * channels.mjs — Wave G 渠道核心（Telegram 长轮询 + 双向 webhook）。
 *
 * 契约（v40 设计 §3.1）：
 *   - 渠道 CRUD 原子持久化；secret/token 绝不进响应与日志
 *   - webhook_out：HMAC-SHA256 签名头 fire-and-forget
 *   - webhook_in：HMAC 验签 + 每渠道 60/min 内存限流
 *   - Telegram：注入式 fetch（测试 mock），offset 持久化防重
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { scrub } from "./redaction.mjs";
import { assertEgressAllowed, assertHostAllowed } from "./security/egress-guard.mjs";

const CHANNEL_TYPES = new Set(["telegram", "webhook_out", "webhook_in"]);
const EVENTS_CAP = 500;
const RATE_LIMIT_PER_MIN = 60;

function channelError(code, message, httpStatus = 400) {
  return Object.assign(new Error(message), { code, httpStatus });
}

function hmacSha256(secret, payload) {
  return createHmac("sha256", String(secret)).update(String(payload)).digest("hex");
}

function secureEqualHex(a, b) {
  const left = Buffer.from(String(a || ""), "hex");
  const right = Buffer.from(String(b || ""), "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function normalizeWebhookUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw channelError("CHANNEL_CONFIG", "出站 Webhook 需要合法的 http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw channelError("CHANNEL_CONFIG", "出站 Webhook 只接受 http 或 https");
  }
  // F-044 SSRF：只查协议等于没查。目标必须不是环回/内网/链路本地（云元数据），
  // 否则用户可以借服务端之手去打 169.254.169.254 或本机控制面 127.0.0.1:51400。
  // 这里只挡 IP 字面量与保留域名；普通域名由发送前的 assertEgressAllowed 解析 DNS 后判决。
  assertHostAllowed(parsed.hostname);
  return parsed.toString();
}

/** 响应白名单：剥离一切密钥面字段。 */
export function publicChannel(channel) {
  if (!channel) return null;
  const { config = {}, ...rest } = channel;
  const safeConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (/token|secret|password|key/i.test(key)) {
      safeConfig[key] = value ? "***" : "";
    } else {
      safeConfig[key] = value;
    }
  }
  const published = { ...rest, config: safeConfig };
  if (channel.type === "webhook_in") published.inboundPath = `/api/channels/webhook/${channel.id}`;
  return published;
}

export function createChannelService({
  dataRoot,
  eventStore = null,
  fetchImpl = globalThis.fetch,
  pollIdleMs = 500,
  // DNS 注入点：出站守卫要靠解析结果判断目标是否安全，测试必须能替换掉真实 DNS。
  // 本机若开了 fake-ip 代理（Clash 一类，常见 198.18.0.0/15），真实 DNS 会把
  // 所有域名解析到保留段，导致守卫一律误报——因此生产环境也可能需要显式注入。
  dnsLookup = null,
} = {}) {
  const root = String(dataRoot);
  const storePath = join(root, "channels.json");
  const eventsPath = join(root, "channel-events.jsonl");
  const state = {
    channels: new Map(),
    writeChain: Promise.resolve(),
    pollers: new Map(), // channelId → { stopped, promise }
    rateBuckets: new Map(), // channelId → { minute, count }
    events: [],
    storeStatus: "ready", // ready | unavailable（channels.json 损坏时 fail-closed）
    initError: null,
  };

  function audit(type, detail) {
    void eventStore?.emit?.(type, detail, { sensitivity: "internal", agentId: "control-plane" })?.catch?.(() => {});
  }

  async function recordEvent(entry) {
    const event = { at: new Date().toISOString(), ...entry };
    state.events.push(event);
    if (state.events.length > EVENTS_CAP) state.events.splice(0, state.events.length - EVENTS_CAP);
    await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8").catch(() => {});
    audit(`channels.${entry.kind || "event"}`, { channelId: entry.channelId, type: entry.type });
  }

  function persist() {
    const payload = JSON.stringify({ schema: "514cc.channels/v1", channels: [...state.channels.values()] }, null, 2);
    // pid+uuid 临时名：固定 `.tmp` 在跨进程/崩溃残留场景会互相踩写（对齐全仓原子写惯例）
    const tmp = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
    state.writeChain = state.writeChain.then(async () => {
      await mkdir(dirname(storePath), { recursive: true });
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, storePath);
    });
    return state.writeChain;
  }

  /** store 不可用（读盘损坏）时拒绝一切会 persist 的写操作，防止空集合覆盖真源。 */
  function assertStoreWritable() {
    if (state.storeStatus !== "ready") {
      throw channelError("CHANNELS_STORE_UNAVAILABLE", `channels.json 不可读（${state.initError || "未知错误"}），已拒绝写入以防清空渠道配置`, 503);
    }
  }

  async function init() {
    let parsed = null;
    try {
      parsed = JSON.parse(await readFile(storePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        state.storeStatus = "unavailable";
        state.initError = error.message;
        throw error;
      }
    }
    for (const channel of parsed?.channels ?? []) {
      if (channel?.id && CHANNEL_TYPES.has(channel.type)) state.channels.set(channel.id, channel);
    }
    for (const channel of state.channels.values()) {
      if (channel.type === "telegram" && channel.enabled) startTelegramPoller(channel.id);
    }
    // 事件时间线回填：jsonl 是 append-only 账本（recordEvent），此前只写不读——重启后
    // 「最近事件」归零、文件却无限增长。读尾部恢复最近事件，损坏行跳过。
    try {
      const raw = await readFile(eventsPath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      for (const line of lines.slice(-EVENTS_CAP)) {
        try {
          const event = JSON.parse(line);
          if (event && typeof event === "object") state.events.push(event);
        } catch { /* 单行损坏不致命 */ }
      }
      if (state.events.length > EVENTS_CAP) state.events.splice(0, state.events.length - EVENTS_CAP);
    } catch { /* 无历史文件属正常首启 */ }
    return service;
  }

  function list() {
    return [...state.channels.values()].map(publicChannel);
  }

  function getRaw(id) {
    return state.channels.get(String(id)) ?? null;
  }

  async function create({ type, name, config = {}, enabled = false } = {}) {
    assertStoreWritable();
    if (!CHANNEL_TYPES.has(type)) throw channelError("CHANNEL_BAD_TYPE", `type must be one of ${[...CHANNEL_TYPES].join("/")}`);
    if (type === "telegram" && !config.token) throw channelError("CHANNEL_CONFIG", "telegram channel requires config.token");
    if (type === "webhook_out" && !config.url) throw channelError("CHANNEL_CONFIG", "webhook_out channel requires config.url");
    if (type === "webhook_in" && !config.secret) throw channelError("CHANNEL_CONFIG", "webhook_in channel requires config.secret");
    // 与 probe() 同口径：跳过验通直接创建也不得落下弱签名密钥
    if (type === "webhook_in" && String(config.secret).trim().length < 8) throw channelError("CHANNEL_CONFIG", "验签 Secret 至少 8 位");
    const nextConfig = { ...config };
    if (type === "webhook_out") nextConfig.url = normalizeWebhookUrl(config.url);
    const channel = {
      id: randomUUID().slice(0, 8),
      type,
      name: String(name || type),
      enabled: Boolean(enabled),
      config: nextConfig,
      createdAt: new Date().toISOString(),
    };
    state.channels.set(channel.id, channel);
    await persist();
    audit("channels.create", { channelId: channel.id, type });
    if (channel.type === "telegram" && channel.enabled) startTelegramPoller(channel.id);
    return publicChannel(channel);
  }

  async function update(id, patch = {}) {
    const channel = getRaw(id);
    if (!channel) throw channelError("CHANNEL_NOT_FOUND", `channel not found: ${id}`, 404);
    assertStoreWritable();
    if (patch.name != null) channel.name = String(patch.name);
    if (patch.config && typeof patch.config === "object") {
      // publicChannel 会把密钥字段掩码成 "***"；前端整体回传时视为"未修改"，绝不落盘。
      const merged = { ...channel.config };
      for (const [key, value] of Object.entries(patch.config)) {
        if (/token|secret|password|key/i.test(key) && (value === "***" || value === "")) continue;
        merged[key] = value;
      }
      channel.config = merged;
    }
    // 更新入口同样守住最小密钥长度（跳过掩码未改动的旧值不受影响）
    if (channel.type === "webhook_in" && String(channel.config.secret ?? "").trim().length < 8) {
      throw channelError("CHANNEL_CONFIG", "验签 Secret 至少 8 位");
    }
    if (patch.enabled != null) channel.enabled = Boolean(patch.enabled);
    await persist();
    if (channel.type === "telegram") {
      await stopTelegramPoller(channel.id);
      if (channel.enabled) startTelegramPoller(channel.id);
    }
    audit("channels.update", { channelId: channel.id, enabled: channel.enabled });
    return publicChannel(channel);
  }

  async function remove(id) {
    const channel = getRaw(id);
    if (!channel) return false;
    assertStoreWritable();
    await stopTelegramPoller(id);
    state.channels.delete(id);
    await persist();
    audit("channels.delete", { channelId: id, type: channel.type });
    return true;
  }

  /** webhook_out 推送：HMAC 签名头 + fire-and-forget（调用方拿 promise，不阻塞业务链）。 */
  async function sendWebhookOut(channel, payload) {
    const bodyText = JSON.stringify(payload ?? {});
    const signature = channel.config.secret ? hmacSha256(channel.config.secret, bodyText) : null;
    const headers = { "content-type": "application/json" };
    if (signature) headers["x-signature-sha256"] = signature;
    // F-044：配置期只挡得住 IP 字面量。域名随时可能被 DNS 重绑定到内网，
    // 所以真正发送前必须解析 DNS 再判一次（防 TOCTOU / DNS rebinding）。
    const url = await assertEgressAllowed(channel.config.url, { dnsLookup });
    const response = await fetchImpl(url, { method: "POST", headers, body: bodyText });
    await recordEvent({ kind: "outbound", channelId: channel.id, type: channel.type, status: response?.status ?? 0 });
    return { ok: Boolean(response?.ok), status: response?.status ?? 0 };
  }

  /** 创建前验通：telegram getMe / 出站试投 / 入站 secret 就绪。不落渠道、不写事件。 */
  async function probe({ type, config = {} } = {}) {
    if (!CHANNEL_TYPES.has(type)) throw channelError("CHANNEL_BAD_TYPE", `type must be one of ${[...CHANNEL_TYPES].join("/")}`);
    if (type === "telegram") {
      if (!config.token) throw channelError("CHANNEL_CONFIG", "telegram channel requires config.token");
      const response = await fetchImpl(`https://api.telegram.org/bot${config.token}/getMe`);
      const payload = await response.json().catch(() => ({}));
      if (!payload?.ok) {
        throw channelError("CHANNEL_PROBE", payload?.description || "Telegram token 无法通过 getMe", 502);
      }
      return {
        ok: true,
        type,
        detail: {
          username: payload.result?.username || "",
          name: payload.result?.first_name || "",
          botId: payload.result?.id ?? null,
        },
      };
    }
    if (type === "webhook_out") {
      // 探测同样会真的把请求发出去，是带回显的 SSRF 面，必须走同一道出站守卫
      const url = await assertEgressAllowed(normalizeWebhookUrl(config.url), { dnsLookup });
      const body = JSON.stringify({ type: "514cc.channel.probe", at: new Date().toISOString() });
      const headers = { "content-type": "application/json" };
      if (config.secret) headers["x-signature-sha256"] = hmacSha256(config.secret, body);
      let response;
      try {
        response = await fetchImpl(url, { method: "POST", headers, body });
      } catch (error) {
        throw channelError("CHANNEL_PROBE", error.message || "出站 Webhook 探测失败", 502);
      }
      return { ok: Boolean(response?.ok), type, status: response?.status ?? 0, detail: { url } };
    }
    if (!String(config.secret || "").trim()) throw channelError("CHANNEL_CONFIG", "webhook_in channel requires config.secret");
    if (String(config.secret).trim().length < 8) throw channelError("CHANNEL_CONFIG", "验签 Secret 至少 8 位");
    return { ok: true, type, detail: { secretReady: true } };
  }

  /** telegram 出站消息。 */
  async function sendTelegram(channel, { chatId, text }) {
    const target = chatId ?? channel.config.chatId;
    if (target == null || target === "") {
      throw channelError("CHANNEL_CONFIG", "telegram send requires chatId（先对 bot 说一句话，或在渠道里填写对话 ID）");
    }
    const url = `https://api.telegram.org/bot${channel.config.token}/sendMessage`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: target, text: String(text ?? "") }),
    });
    const payload = await response.json().catch(() => ({}));
    await recordEvent({ kind: "outbound", channelId: channel.id, type: "telegram", status: response.status });
    return { ok: Boolean(response.ok && payload?.ok), status: response.status };
  }

  async function send(id, payload = {}) {
    const channel = getRaw(id);
    if (!channel) throw channelError("CHANNEL_NOT_FOUND", `channel not found: ${id}`, 404);
    if (channel.type === "webhook_out") return sendWebhookOut(channel, payload);
    if (channel.type === "telegram") return sendTelegram(channel, payload);
    throw channelError("CHANNEL_READONLY", "webhook_in channels cannot send");
  }

  /** webhook_in 验签 + 限流 + 记录。rawBody 为字符串原文。 */
  async function receiveWebhook(id, rawBody, signature) {
    const channel = getRaw(id);
    if (!channel || channel.type !== "webhook_in") {
      throw channelError("CHANNEL_NOT_FOUND", `inbound webhook not found: ${id}`, 404);
    }
    if (!secureEqualHex(hmacSha256(channel.config.secret, rawBody), signature)) {
      throw channelError("CHANNEL_BAD_SIGNATURE", "webhook signature mismatch", 401);
    }
    const now = Math.floor(Date.now() / 60_000);
    const bucket = state.rateBuckets.get(id) ?? { minute: now, count: 0 };
    if (bucket.minute !== now) {
      bucket.minute = now;
      bucket.count = 0;
    }
    bucket.count += 1;
    state.rateBuckets.set(id, bucket);
    if (bucket.count > RATE_LIMIT_PER_MIN) {
      throw channelError("CHANNEL_RATE_LIMITED", "webhook rate limit exceeded", 429);
    }
    let payload = null;
    try {
      payload = JSON.parse(rawBody);
    } catch { /* 非 JSON 也记录原文长度 */ }
    await recordEvent({ kind: "inbound", channelId: id, type: "webhook_in", bytes: rawBody.length, payload });
    return { ok: true, count: bucket.count };
  }

  /** Telegram 长轮询：注入式 fetch，offset 存渠道 config（持久化防重）。 */
  function startTelegramPoller(id) {
    if (state.pollers.has(id)) return;
    const control = { stopped: false };
    const loop = (async () => {
      while (!control.stopped) {
        const channel = getRaw(id);
        if (!channel || !channel.enabled) break;
        try {
          const offset = Number(channel.config.offset || 0);
          const response = await fetchImpl(`https://api.telegram.org/bot${channel.config.token}/getUpdates`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ offset, timeout: 25 }),
          });
          const payload = await response.json().catch(() => ({}));
          for (const update of payload?.result ?? []) {
            const message = update?.message;
            if (message?.text) {
              if (message.chat?.id != null && channel.config.chatId == null) {
                channel.config.chatId = message.chat.id;
              }
              await recordEvent({
                kind: "inbound",
                channelId: id,
                type: "telegram",
                chatId: message.chat?.id,
                from: message.from?.username || message.from?.first_name || "",
                // 聊天原文可能夹带密钥，入账前过脱敏（与会话 jsonl 同基线）
                text: scrub(String(message.text)).slice(0, 500),
              });
            }
            channel.config.offset = update.update_id + 1;
          }
          if ((payload?.result ?? []).length) await persist();
          // 轮询节奏：真 Telegram 服务端长等 25s 自带节流；mock/快回场景必须让出事件循环，
          // 否则空结果微任务自旋会饿死定时器（2026-07-25 测试挂起根因）
          await new Promise((resolveWait) => setTimeout(resolveWait, pollIdleMs));
        } catch (error) {
          await recordEvent({ kind: "error", channelId: id, type: "telegram", message: error.message });
          await new Promise((resolveWait) => setTimeout(resolveWait, 5000));
        }
      }
      state.pollers.delete(id);
    })();
    control.promise = loop;
    state.pollers.set(id, control);
  }

  /** 停止并等待轮询循环退出（最多 30s，容忍 in-flight 的 25s 长轮询），防止 update 重启后双轮询。 */
  async function stopTelegramPoller(id) {
    const poller = state.pollers.get(id);
    if (!poller) return;
    poller.stopped = true;
    state.pollers.delete(id);
    await Promise.race([
      poller.promise?.catch(() => {}),
      new Promise((resolveStop) => setTimeout(resolveStop, 30_000)),
    ]);
  }

  function recentEvents(limit = 50) {
    return state.events.slice(-Math.min(EVENTS_CAP, Math.max(1, Number(limit) || 50))).reverse();
  }

  async function close() {
    await Promise.all([...state.pollers.keys()].map((id) => stopTelegramPoller(id)));
    await state.writeChain;
  }

  const service = {
    init, list, create, update, remove, send, probe, receiveWebhook,
    recentEvents, close, publicChannel,
    _state: state, // 测试观测用
  };
  return service;
}
