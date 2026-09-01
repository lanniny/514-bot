import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPRESS_MIN_BYTES,
  STATIC_MAX_AGE_SECONDS,
  createStaticServer,
  encodeBody,
  preferredEncoding,
  resolvePublicAsset,
} from "../src/static-assets.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const publicRoot = join(appRoot, "public");

function fakeRequest({ acceptEncoding = "", method = "GET", ifNoneMatch = null } = {}) {
  const headers = {};
  if (acceptEncoding) headers["accept-encoding"] = acceptEncoding;
  if (ifNoneMatch) headers["if-none-match"] = ifNoneMatch;
  return { method, headers };
}

function fakeResponse() {
  return {
    status: null,
    headers: {},
    body: undefined,
    ended: false,
    writeHead(code, headers) { this.status = code; this.headers = headers ?? {}; },
    end(data) { this.body = data; this.ended = true; },
  };
}

function makeStatic() {
  return createStaticServer({ publicRoot, securityHeaders: { "x-content-type-options": "nosniff" } });
}

// ─── 1. 路径白名单（安全基线，不能因性能重构而放宽） ─────────────────────────

test("resolvePublicAsset allows allowlisted subdirs and rejects traversal", () => {
  assert.equal(resolvePublicAsset("/forge/tokens.css"), "forge/tokens.css");
  assert.equal(resolvePublicAsset("/modules/nav-config.js"), "modules/nav-config.js");
  assert.equal(resolvePublicAsset("/../server.mjs"), null);
  assert.equal(resolvePublicAsset("/forge/../server.mjs"), null);
  assert.equal(resolvePublicAsset("/forge/secret.txt"), null, "扩展名必须在白名单内");
  assert.equal(resolvePublicAsset("/src/app.mjs"), null, "src 目录不得被静态伺服");
});

test("serveStatic refuses to serve files outside public/", async () => {
  const { serveStatic } = makeStatic();
  const response = fakeResponse();
  const served = await serveStatic("/../server.mjs", response, fakeRequest());
  assert.equal(served, false, "越界路径必须落到 404 而不是被伺服");
});

// ─── 2. 压缩协商（UI-AUDIT P0-3 核心收益） ───────────────────────────────────

test("preferredEncoding negotiates br > gzip > identity", () => {
  assert.equal(preferredEncoding(fakeRequest({ acceptEncoding: "gzip, deflate, br" })), "br");
  assert.equal(preferredEncoding(fakeRequest({ acceptEncoding: "gzip" })), "gzip");
  assert.equal(preferredEncoding(fakeRequest({ acceptEncoding: "" })), "identity");
  assert.equal(preferredEncoding(null), "identity");
});

test("app.js is served brotli-compressed with a large size win", async () => {
  const { serveStatic } = makeStatic();
  const response = fakeResponse();
  await serveStatic("/app.js", response, fakeRequest({ acceptEncoding: "br" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-encoding"], "br");
  assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
  const raw = (await stat(join(publicRoot, "app.js"))).size;
  const ratio = response.body.length / raw;
  assert.ok(ratio < 0.35, `压缩后应小于原体积 35%，实测 ${(ratio * 100).toFixed(1)}%`);
});

test("small assets skip compression to avoid negative gains", () => {
  const entry = { size: COMPRESS_MIN_BYTES - 1, body: Buffer.from("x".repeat(100)), encodings: new Map() };
  const result = encodeBody(entry, "br");
  assert.equal(result.encoding, "identity");
});

test("compression result is cached per encoding", async () => {
  const { serveStatic, loadStaticEntry } = makeStatic();
  const first = fakeResponse();
  await serveStatic("/styles.css", first, fakeRequest({ acceptEncoding: "br" }));
  const entry = await loadStaticEntry("styles.css");
  assert.equal(entry.encodings.has("br"), true, "首次压缩结果应入缓存");
  const second = fakeResponse();
  await serveStatic("/styles.css", second, fakeRequest({ acceptEncoding: "br" }));
  assert.equal(second.body.length, first.body.length, "二次请求应命中压缩缓存");
});

// ─── 3. ETag 条件请求与缓存策略 ─────────────────────────────────────────────

test("static assets carry ETag + short max-age and HTML revalidates every time", async () => {
  const { serveStatic } = makeStatic();
  const html = fakeResponse();
  await serveStatic("/", html, fakeRequest({ acceptEncoding: "br" }));
  assert.equal(html.headers["cache-control"], "no-cache", "HTML 壳可能变，必须每次重验");
  assert.match(html.headers.etag, /^W\/"/);

  const asset = fakeResponse();
  await serveStatic("/app.js", asset, fakeRequest({ acceptEncoding: "br" }));
  assert.equal(
    asset.headers["cache-control"],
    `public, max-age=${STATIC_MAX_AGE_SECONDS}, must-revalidate`,
  );
  assert.equal(asset.headers.vary, "Accept-Encoding");
  assert.equal(asset.headers["x-content-type-options"], "nosniff", "安全头必须透传");
});

test("conditional request returns 304 without a body", async () => {
  const { serveStatic } = makeStatic();
  const warm = fakeResponse();
  await serveStatic("/app.js", warm, fakeRequest());
  const conditional = fakeResponse();
  const served = await serveStatic("/app.js", conditional, fakeRequest({ ifNoneMatch: warm.headers.etag }));
  assert.equal(served, true);
  assert.equal(conditional.status, 304);
  assert.equal(conditional.headers["content-length"], 0);
  assert.ok(!conditional.body, "304 不得携带响应体");
});

test("ETag tracks file content", async () => {
  const { loadStaticEntry } = makeStatic();
  const entry = await loadStaticEntry("app.js");
  const disk = await readFile(join(publicRoot, "app.js"));
  assert.equal(entry.size, disk.length);
  // ETag 必须是内容的摘要（弱校验子 + 16 位 base64url），而不是时间戳——
  // 否则「内容没变但 mtime 变了」会白白击穿客户端缓存。
  const expected = `W/"${createHash("sha1").update(disk).digest("base64url").slice(0, 16)}"`;
  assert.equal(entry.etag, expected);
});

// ─── 4. HEAD 与新资产可达性 ─────────────────────────────────────────────────

test("HEAD requests send headers but no body", async () => {
  const { serveStatic } = makeStatic();
  const response = fakeResponse();
  await serveStatic("/app.js", response, fakeRequest({ method: "HEAD", acceptEncoding: "br" }));
  assert.equal(response.status, 200);
  assert.ok(response.headers["content-length"] > 0);
  assert.equal(response.body, undefined);
});

test("UI-AUDIT 新增资产可被静态伺服（forge/ 与 modules/ 白名单）", async () => {
  const { serveStatic } = makeStatic();
  for (const path of ["/forge/placeholders.css", "/modules/placeholders.js"]) {
    const response = fakeResponse();
    const served = await serveStatic(path, response, fakeRequest());
    assert.equal(served, true, `${path} 应可达`);
    assert.equal(response.status, 200);
  }
});

test("favicon returns 204 without touching the filesystem", async () => {
  const { serveStatic } = makeStatic();
  const response = fakeResponse();
  const served = await serveStatic("/favicon.ico", response, fakeRequest());
  assert.equal(served, true);
  assert.equal(response.status, 204);
});
