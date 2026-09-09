/**
 * pet 面契约：瞬态脉冲枢纽、路由 kind 白名单、SSE 广播、静态资产放行。
 * 桌宠是装饰面：脉冲不落事件账本，静态白名单不放宽路径逃逸检查。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, readFile } from "node:fs/promises";

import { createPetHub } from "../src/pet/hub.mjs";
import { registerPetRoutes, petHubForTest } from "../src/pet/routes.mjs";
import {
  PUBLIC_ASSET_EXTS,
  PUBLIC_ASSET_PREFIXES,
  STATIC_ROUTES,
  contentTypeFor,
  createStaticServer,
  resolvePublicAsset,
} from "../src/static-assets.mjs";

function mockRouter() {
  const routes = new Map();
  const router = {
    use(method, prefix, handler) {
      routes.set(`${method} ${prefix}`, handler);
    },
  };
  router.get = (prefix, handler) => router.use("GET", prefix, handler);
  router.post = (prefix, handler) => router.use("POST", prefix, handler);
  return { router, routes };
}

function mockCtx() {
  const jsonCalls = [];
  let bodyPayload = { kind: "typing" };
  return {
    jsonCalls,
    setBody: (payload) => {
      bodyPayload = payload;
    },
    ctx: {
      body: async () => bodyPayload,
      json: (response, status, payload) => jsonCalls.push({ status, payload }),
    },
  };
}

function mockResponse() {
  const response = new EventEmitter();
  response.writeHeadCalls = [];
  response.written = [];
  response.writeHead = (status, headers) => {
    response.writeHeadCalls.push({ status, headers });
  };
  response.write = (chunk) => {
    response.written.push(String(chunk));
    return true;
  };
  response.end = () => {};
  return response;
}

test("pet hub broadcasts to subscribers and tolerates listener failures", () => {
  const hub = createPetHub();
  const seen = [];
  const unsubscribe = hub.subscribe((event) => seen.push(event));
  hub.subscribe(() => {
    throw new Error("listener boom");
  });
  assert.equal(hub.publish({ kind: "typing" }), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "typing");
  assert.equal(typeof seen[0].at, "number");
  unsubscribe();
  assert.equal(hub.publish({ kind: "typing" }), true);
  assert.equal(seen.length, 1, "unsubscribed listener no longer receives");
  assert.equal(hub.publish({ kind: "" }), false, "empty kind is rejected");
});

test("pet hub fails closed at subscriber capacity", () => {
  const hub = createPetHub();
  for (let index = 0; index < 8; index += 1) hub.subscribe(() => {});
  assert.throws(() => hub.subscribe(() => {}), /PET_HUB_CAPACITY|full/);
});

test("pet routes reject unknown input kinds and forward known pulses to the hub", async () => {
  const { router, routes } = mockRouter();
  const { ctx, jsonCalls, setBody } = mockCtx();
  registerPetRoutes(router, ctx);

  const inputHandler = routes.get("POST /api/pet/input");
  assert.ok(inputHandler, "POST /api/pet/input must be registered");

  setBody({ kind: "arbitrary" });
  const badResponse = mockResponse();
  const handledBad = await inputHandler({ on: () => {} }, badResponse, new URL("http://127.0.0.1/api/pet/input"), ctx);
  assert.equal(handledBad, true);
  assert.equal(jsonCalls[0].status, 400);
  assert.equal(jsonCalls[0].payload.code, "PET_INPUT_KIND");

  const hub = petHubForTest();
  const seen = [];
  const unsubscribe = hub.subscribe((event) => seen.push(event));
  setBody({ kind: "typing" });
  const goodResponse = mockResponse();
  await inputHandler({ on: () => {} }, goodResponse, new URL("http://127.0.0.1/api/pet/input"), ctx);
  setBody({ kind: "mouse" });
  const mouseResponse = mockResponse();
  await inputHandler({ on: () => {} }, mouseResponse, new URL("http://127.0.0.1/api/pet/input"), ctx);
  assert.deepEqual(seen.map((event) => event.kind), ["typing", "mouse"]);
  assert.equal(jsonCalls[1].status, 202);
  assert.equal(jsonCalls[2].status, 202);
  unsubscribe();
});

test("pet stream is a live SSE of hub pulses without replay", async () => {
  const { router, routes } = mockRouter();
  const { ctx } = mockCtx();
  registerPetRoutes(router, ctx);

  const streamHandler = routes.get("GET /api/pet/stream");
  assert.ok(streamHandler, "GET /api/pet/stream must be registered");

  const request = new EventEmitter();
  const response = mockResponse();
  const handled = await streamHandler(request, response, new URL("http://127.0.0.1/api/pet/stream"), ctx);
  assert.equal(handled, true);
  assert.equal(response.writeHeadCalls[0].status, 200);
  assert.match(response.writeHeadCalls[0].headers["content-type"], /text\/event-stream/);

  // 广播后帧到达；关流后不再收到
  petHubForTest().publish({ kind: "poke" });
  assert.ok(response.written.some((chunk) => chunk.includes("event: poke")));
  request.emit("close");
  petHubForTest().publish({ kind: "poke" });
  const pokesAfterClose = response.written.filter((chunk) => chunk.includes("event: poke")).length;
  assert.equal(pokesAfterClose, 1, "closed stream must not receive further pulses");
});

test("pet stream rejects capacity before SSE headers and releases a disconnected response", async () => {
  const { router, routes } = mockRouter();
  const { ctx, jsonCalls } = mockCtx();
  registerPetRoutes(router, ctx);
  const handler = routes.get("GET /api/pet/stream");
  const subscriptions = Array.from({ length: 8 }, () => petHubForTest().subscribe(() => {}));
  try {
    const response = mockResponse();
    await handler(new EventEmitter(), response, new URL("http://127.0.0.1/api/pet/stream"), ctx);
    assert.equal(response.writeHeadCalls.length, 0);
    assert.equal(jsonCalls[0].status, 503);
  } finally { subscriptions.forEach((unsubscribe) => unsubscribe()); }
  const response = mockResponse();
  await handler(new EventEmitter(), response, new URL("http://127.0.0.1/api/pet/stream"), ctx);
  assert.equal(petHubForTest().subscriberCount(), 1);
  response.emit("close");
  assert.equal(petHubForTest().subscriberCount(), 0);
});

test("static layer serves the pet page and its model assets without opening path escapes", async () => {
  assert.equal(STATIC_ROUTES["/pet"], "pet/index.html");
  assert.ok(PUBLIC_ASSET_PREFIXES.includes("/pet/"));
  for (const ext of [".png", ".moc3", ".flac"]) {
    assert.ok(PUBLIC_ASSET_EXTS.has(ext), `${ext} must be whitelisted for pet assets`);
  }
  assert.equal(resolvePublicAsset("/pet/pet-engine.js"), "pet/pet-engine.js");
  assert.equal(resolvePublicAsset("/vendor/pet/pixi.min.js"), "vendor/pet/pixi.min.js");
  assert.equal(resolvePublicAsset("/vendor/pet-models/bongo-standard/demomodel.moc3"), "vendor/pet-models/bongo-standard/demomodel.moc3");
  assert.equal(resolvePublicAsset("/pet/../server.mjs"), null);
  assert.equal(resolvePublicAsset("/pet/..\\server.mjs"), null);
  assert.equal(contentTypeFor("pet/index.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("x.png"), "image/png");
  assert.equal(contentTypeFor("x.moc3"), "application/octet-stream");
  assert.equal(contentTypeFor("x.flac"), "audio/flac");
});

test("all pinned BongoCat model modes ship complete referenced assets", async () => {
  const catalogRoot = new URL("../public/vendor/pet-models/", import.meta.url);
  const catalog = JSON.parse(await readFile(new URL("catalog.json", catalogRoot), "utf8"));
  assert.equal(catalog.commit, "5b979d85fe2cbddb064ac40cfd3e32de437891e2");
  assert.deepEqual(catalog.models.map((model) => model.id), ["standard", "keyboard", "gamepad"]);
  for (const model of catalog.models) {
    const manifestUrl = new URL(model.entry, catalogRoot);
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
    const modelRoot = new URL("./", manifestUrl);
    const refs = [
      manifest.FileReferences.Moc,
      manifest.FileReferences.DisplayInfo,
      ...manifest.FileReferences.Textures,
      ...manifest.FileReferences.Expressions.map((entry) => entry.File),
      ...Object.values(manifest.FileReferences.Motions).flat().flatMap((entry) => [entry.File, entry.Sound].filter(Boolean)),
      "resources/background.png",
      "resources/cover.png",
    ];
    await Promise.all(refs.map((relative) => access(new URL(relative, modelRoot))));
  }
  await access(new URL("LICENSE-MIT", catalogRoot));
  await access(new URL("NOTICE.md", catalogRoot));
});

test("pet page keeps the transparent-window contract and QA hooks gated", async () => {
  const appRoot = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const html = await readFile(`${appRoot}/public/pet/index.html`, "utf8");
  const css = await readFile(`${appRoot}/public/pet/pet.css`, "utf8");
  const engine = await readFile(`${appRoot}/public/pet/pet-engine.js`, "utf8");
  assert.doesNotMatch(html, /<style|style="/, "CSP style-src 'self' forbids inline styles");
  assert.match(html, /data-pet-state="loading"/);
  assert.match(css, /background:\s*transparent/, "pet window must stay transparent");
  assert.match(engine, /beforeModelUpdate/, "params must be applied after motions");
  assert.match(engine, /get\("qa"\) === "1"/, "test injection must be qa-gated");
});

test("only pet document aliases allow same-origin framing including cached responses", async () => {
  const { fileURLToPath } = await import("node:url");
  const securityHeaders = { "content-security-policy": "default-src 'self'; frame-ancestors 'none'; script-src 'self'", "x-frame-options": "DENY" };
  const server = createStaticServer({ publicRoot: fileURLToPath(new URL("../public", import.meta.url)), securityHeaders });
  for (const path of ["/pet", "/pet/", "/pet/index.html"]) {
    const response = mockResponse();
    assert.equal(await server.serveStatic(path, response), true);
    const headers = response.writeHeadCalls[0].headers;
    assert.equal(headers["x-frame-options"], "SAMEORIGIN");
    assert.match(headers["content-security-policy"], /frame-ancestors 'self'/);
    assert.doesNotMatch(headers["content-security-policy"], /frame-ancestors 'none'/);
    const cached = mockResponse();
    await server.serveStatic(path, cached, { headers: { "if-none-match": headers.etag } });
    assert.equal(cached.writeHeadCalls[0].status, 304);
    assert.equal(cached.writeHeadCalls[0].headers["x-frame-options"], "SAMEORIGIN");
  }
  const main = mockResponse();
  await server.serveStatic("/", main);
  assert.equal(main.writeHeadCalls[0].headers["x-frame-options"], "DENY");
  assert.equal(securityHeaders["x-frame-options"], "DENY");
  assert.equal(resolvePublicAsset("/pet/other.html"), null);
});
