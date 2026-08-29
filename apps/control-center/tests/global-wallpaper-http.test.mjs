import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

// 全局壁纸（对标 dsh-wallpaper-engine 全局设置面）HTTP 契约：
// 1) /api/wallpapers/global 走 team-backgrounds 同款字节管线（伪 id "__global__"），
//    鉴权 / 404 语义 / 字节往返 / 幂等 DELETE / 跨进程持久化全覆盖；
// 2) 514cc-global-wallpaper 进入外观偏好白名单（服务端双写通道），白名单外键仍被丢弃。
const appRoot = fileURLToPath(new URL("..", import.meta.url));

function minimalJpeg() {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0xff, 0xd9,
  ]);
}

async function jsonRequest(origin, path, token, { method = "GET", body = undefined } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { response, payload };
}

test("global wallpaper bytes round-trip through the team-background pipeline and persist across restart", { timeout: 90_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-global-wallpaper-"));
  const token = "e2e-global-wallpaper-token-0123456789";
  const env = {
    CONTROL_CENTER_TOKEN: token,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_PORT: "0",
  };
  let child = spawnTestServer({ env });
  t.after(async () => {
    if (child && child.exitCode == null && child.signalCode == null) {
      await stopTestServer(child, { token });
    }
    await rm(dataRoot, { recursive: true, force: true });
  });

  const origin = new URL(await waitForUrl(child)).origin;
  const dataUrl = `data:image/jpeg;base64,${minimalJpeg().toString("base64")}`;

  // 鉴权：无 token 一律 401（GET/POST/DELETE 同面）
  assert.equal((await fetch(`${origin}/api/wallpapers/global`)).status, 401);
  assert.equal((await fetch(`${origin}/api/wallpapers/global`, { method: "DELETE" })).status, 401);

  // 上传前：404 BACKGROUND_NOT_FOUND（与团队背景缺失同语义）
  const missing = await jsonRequest(origin, "/api/wallpapers/global", token);
  assert.equal(missing.response.status, 404);
  assert.equal(missing.payload?.error?.code, "BACKGROUND_NOT_FOUND");

  // 上传：返回媒体摘要；字节回读逐字节一致
  const uploaded = await jsonRequest(origin, "/api/wallpapers/global", token, {
    method: "POST",
    body: { dataUrl },
  });
  assert.equal(uploaded.response.status, 200);
  assert.equal(uploaded.payload.mediaKind, "image");

  const image = await fetch(`${origin}/api/wallpapers/global`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.ok(Buffer.from(await image.arrayBuffer()).equals(minimalJpeg()));

  // 幂等删除：首次 200，重复 DELETE 仍 200，删除后回 404
  const removed = await jsonRequest(origin, "/api/wallpapers/global", token, { method: "DELETE" });
  assert.equal(removed.response.status, 200);
  const removedAgain = await jsonRequest(origin, "/api/wallpapers/global", token, { method: "DELETE" });
  assert.equal(removedAgain.response.status, 200);
  const goneAfterDelete = await jsonRequest(origin, "/api/wallpapers/global", token);
  assert.equal(goneAfterDelete.response.status, 404);

  // 跨进程持久化：重新上传后重启服务端，字节仍在（dataRoot 落盘，伪 id 与团队字节同目录管理）
  await jsonRequest(origin, "/api/wallpapers/global", token, { method: "POST", body: { dataUrl } });
  await stopTestServer(child, { token });
  child = spawnTestServer({ env });
  const nextOrigin = new URL(await waitForUrl(child)).origin;
  const persisted = await fetch(`${nextOrigin}/api/wallpapers/global`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(persisted.status, 200);
  assert.ok(Buffer.from(await persisted.arrayBuffer()).equals(minimalJpeg()));
});

test("oversized wallpapers (>1MB) survive the read path and HEAD probes existence without bytes", { timeout: 90_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-global-wallpaper-large-"));
  const token = "e2e-global-wallpaper-large-0123456789";
  const env = {
    CONTROL_CENTER_TOKEN: token,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_PORT: "0",
  };
  const child = spawnTestServer({ env });
  t.after(async () => {
    if (child && child.exitCode == null && child.signalCode == null) {
      await stopTestServer(child, { token });
    }
    await rm(dataRoot, { recursive: true, force: true });
  });
  const origin = new URL(await waitForUrl(child)).origin;

  // 回归靶：readFileRecord 曾复用头像 1MB 上限，>1MB 壁纸 GET 恒 404、
  // 客户端随即自愈回滚偏好——用户视角即「切什么背景都不生效」。
  // 构造：合法 JPEG 头段 + 2MB 熵数据 + 末尾 EOI（validJpeg 按标记游走，熵区全 0 合法）。
  const header = minimalJpeg().subarray(0, minimalJpeg().length - 2); // 去掉头段里自带的 EOI
  const large = Buffer.concat([header, Buffer.alloc(2 * 1024 * 1024, 0x00), Buffer.from([0xff, 0xd9])]);
  const dataUrl = `data:image/jpeg;base64,${large.toString("base64")}`;
  const uploaded = await jsonRequest(origin, "/api/wallpapers/global", token, {
    method: "POST",
    body: { dataUrl },
  });
  assert.equal(uploaded.response.status, 200);
  assert.equal(uploaded.payload.mediaKind, "image");
  assert.equal(uploaded.payload.bytes, large.length);

  const image = await fetch(`${origin}/api/wallpapers/global`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(image.status, 200);
  assert.equal(Number(image.headers.get("content-length")), large.length);
  assert.ok(Buffer.from(await image.arrayBuffer()).equals(large));

  // HEAD：只探存在性（客户端启动对账 hasCustom 用），无 token 仍 401
  const head = await fetch(`${origin}/api/wallpapers/global`, {
    method: "HEAD",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(`${origin}/api/wallpapers/global`, { method: "HEAD" })).status, 401);
});

test("514cc-global-wallpaper joins the server-side appearance preference whitelist", { timeout: 90_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-global-wallpaper-pref-"));
  const token = "e2e-global-wallpaper-pref-0123456789";
  const env = {
    CONTROL_CENTER_TOKEN: token,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_PORT: "0",
  };
  const child = spawnTestServer({ env });
  t.after(async () => {
    if (child && child.exitCode == null && child.signalCode == null) {
      await stopTestServer(child, { token });
    }
    await rm(dataRoot, { recursive: true, force: true });
  });

  const origin = new URL(await waitForUrl(child)).origin;
  const snapshot = JSON.stringify({
    preset: "aurora",
    fit: "cover",
    overrideTeam: true,
    rotate: { enabled: true, intervalMin: 10, order: "shuffle" },
    hasCustom: false,
  });
  const put = await jsonRequest(origin, "/api/preferences", token, {
    method: "PUT",
    body: {
      "514cc-global-wallpaper": snapshot,
      "514cc-not-a-real-key": "should be dropped",
    },
  });
  assert.equal(put.response.status, 200);

  const read = await jsonRequest(origin, "/api/preferences", token);
  assert.equal(read.response.status, 200);
  assert.equal(read.payload.preferences["514cc-global-wallpaper"], snapshot);
  assert.equal(read.payload.preferences["514cc-not-a-real-key"], undefined);
});
