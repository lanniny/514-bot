import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderStore } from "../src/providers.mjs";
import { CcSwitchProxyService } from "../src/ccswitch/proxy.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const syncWaitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => {
      server.close(resolveClose);
      server.closeAllConnections?.();
    }),
  };
}

async function fixture(t, proxyOptions = {}) {
  const root = await mkdtemp(resolve(appRoot, ".test-ccswitch-proxy-"));
  let proxy = null;
  t.after(async () => {
    try {
      await proxy?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const dataRoot = join(root, "data");
  const runtimeHome = join(root, "home");
  await mkdir(runtimeHome, { recursive: true });
  const { providerStoreOptions = {}, ...serviceOptions } = proxyOptions;
  const providers = await new ProviderStore({ ...providerStoreOptions, dataRoot, runtimeHome }).init();
  proxy = await new CcSwitchProxyService({ ...serviceOptions, dataRoot, providerStore: providers }).init();
  return { root, dataRoot, runtimeHome, providers, proxy };
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(predicate, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

async function assertProxyListenerReachable(proxy, app = "claude") {
  const response = await fetch(`${proxy.origin}/${app}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 401);
}

async function proxyServer({ username = "", password = "" } = {}) {
  let hits = 0;
  let authorizedHits = 0;
  const expected = username ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` : null;
  const server = createServer((request, response) => {
    hits += 1;
    if (expected && request.headers["proxy-authorization"] !== expected) {
      response.writeHead(407, { "proxy-authenticate": "Basic" });
      response.end();
      return;
    }
    authorizedHits += 1;
    response.writeHead(204, { "x-test-proxy": "true" });
    response.end();
  });
  server.on("connect", (request, client, head) => {
    hits += 1;
    if (expected && request.headers["proxy-authorization"] !== expected) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n");
      return;
    }
    authorizedHits += 1;
    const separator = request.url.lastIndexOf(":");
    const host = request.url.slice(0, separator);
    const port = Number(request.url.slice(separator + 1));
    const upstream = connect({ host, port }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("error", () => client.destroy());
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  return {
    url: `http://${username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : ""}127.0.0.1:${port}`,
    port,
    counts: () => ({ hits, authorizedHits }),
    close: () => new Promise((resolveClose) => { server.close(resolveClose); server.closeAllConnections?.(); }),
  };
}

test("全局出站代理：凭据不回显、真实 dispatcher 生效、连接测试与本地扫描", async (t) => {
  const target = await listen((request, response) => {
    response.writeHead(204);
    response.end();
  });
  const outbound = await proxyServer({ username: "proxy-user", password: "proxy-secret" });
  t.after(target.close);
  t.after(outbound.close);

  const { proxy } = await fixture(t);
  const tested = await proxy.testUpstreamProxy(outbound.url, { targetUrl: target.origin, timeoutMs: 3_000 });
  assert.equal(tested.success, true);
  assert.equal(tested.status, 204);

  const status = await proxy.updateUpstreamProxy(outbound.url);
  assert.equal(status.upstreamProxy.enabled, true);
  assert.match(status.upstreamProxy.urlMasked, /%E2%80%A2|••••/);
  assert.equal(JSON.stringify(status).includes("proxy-secret"), false);

  const response = await fetch(target.origin, { method: "HEAD" });
  assert.equal(response.status, 204);
  assert.ok(outbound.counts().authorizedHits >= 2, "test and process-wide fetch must traverse the authenticated proxy");

  const found = await proxy.scanLocalProxies({ ports: [{ port: outbound.port, type: "http", mixed: true }], timeoutMs: 500 });
  assert.deepEqual(found.map((item) => item.proxyType), ["http", "socks5"]);
  await proxy.updateUpstreamProxy(null);
  assert.equal(proxy.status().upstreamProxy.enabled, false);
});

test("本地代理 takeover：Anthropic 请求真实转发、用量计价、停止后恢复 live", async (t) => {
  let seen = null;
  const upstream = await listen(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen = { url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "msg-1",
      type: "message",
      model: "claude-test",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1000, output_tokens: 500 },
    }));
  });
  t.after(upstream.close);

  const { providers, proxy, runtimeHome } = await fixture(t);
  const provider = await providers.create({
    name: "Anthropic upstream",
    baseUrl: upstream.origin,
    apiKey: "sk-upstream-secret",
    apps: { claude: true },
    models: { claude: { model: "claude-test" } },
    meta: { apiFormat: "anthropic", costMultiplier: 2 },
  });
  await providers.switchTo("claude", provider.id);
  await proxy.updateConfig({ listenPort: 0, pricing: { "claude-test": { inputPerMillion: 3, outputPerMillion: 15 } } });
  await proxy.start();
  await proxy.setTakeover("claude", true);

  const liveTaken = JSON.parse(await readFile(join(runtimeHome, ".claude", "settings.json"), "utf8"));
  assert.equal(liveTaken.env.ANTHROPIC_BASE_URL, `${proxy.origin}/claude`);
  assert.equal(liveTaken.env.ANTHROPIC_AUTH_TOKEN, proxy.config.token);

  const response = await fetch(`${proxy.origin}/claude/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": proxy.config.token },
    body: JSON.stringify({ model: "claude-test", max_tokens: 8, messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, "ok");
  assert.equal(seen.url, "/v1/messages");
  assert.equal(seen.headers["x-api-key"], "sk-upstream-secret");
  assert.equal(seen.body.messages[0].content, "hello");

  const logs = proxy.requestLogs();
  assert.equal(logs.total, 1);
  assert.equal(logs.items[0].inputTokens, 1000);
  assert.equal(logs.items[0].outputTokens, 500);
  assert.equal(logs.items[0].costUsd, 0.021);
  assert.equal(JSON.stringify(logs).includes("sk-upstream-secret"), false);

  await proxy.stop({ restore: true });
  const liveRestored = JSON.parse(await readFile(join(runtimeHome, ".claude", "settings.json"), "utf8"));
  assert.equal(liveRestored.env.ANTHROPIC_BASE_URL, upstream.origin);
  assert.equal(liveRestored.env.ANTHROPIC_AUTH_TOKEN, "sk-upstream-secret");
});

test("Codex 完整请求 URL 经本地代理原样转发，不重复追加 responses", async (t) => {
  let seenUrl = null;
  const upstream = await listen(async (request, response) => {
    seenUrl = request.url;
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "response-full-url",
      object: "response",
      status: "completed",
      model: "gpt-full-url",
      output_text: "ok",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  t.after(upstream.close);

  const { providers, proxy } = await fixture(t);
  const provider = await providers.create({
    name: "Full URL upstream",
    baseUrl: `${upstream.origin}/custom/responses?api-version=2026-08-13`,
    apiKey: "full-url-key",
    apps: { codex: true },
    models: { codex: { model: "gpt-full-url" } },
    meta: { apiFormat: "openai_responses", isFullUrl: true },
  });
  await providers.switchTo("codex", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  const response = await fetch(`${proxy.origin}/codex/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${proxy.config.token}` },
    body: JSON.stringify({ model: "gpt-full-url", input: "hello", max_output_tokens: 1 }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).output_text, "ok");
  assert.equal(seenUrl, "/custom/responses?api-version=2026-08-13");
});

test("档案级代理覆盖：UA/Header 注入上游、Body 浅合并、认证头不受影", async (t) => {
  let seen = null;
  const upstream = await listen(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen = { url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "msg-1",
      type: "message",
      model: "claude-test",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  t.after(upstream.close);

  const { providers, proxy } = await fixture(t);
  const provider = await providers.create({
    name: "Override upstream",
    baseUrl: upstream.origin,
    apiKey: "sk-upstream-secret",
    apps: { claude: true },
    models: { claude: { model: "claude-test" } },
    meta: {
      apiFormat: "anthropic",
      proxyOverrides: {
        userAgent: "Mozilla/5.0 cc-test",
        headers: { "X-Provider": "cc-switch" },
        body: { temperature: 0.2 },
      },
    },
  });
  await providers.switchTo("claude", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();
  await proxy.setTakeover("claude", true);

  const response = await fetch(`${proxy.origin}/claude/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": proxy.config.token },
    body: JSON.stringify({ model: "claude-test", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(seen.headers["user-agent"], "Mozilla/5.0 cc-test"); // 自定义 UA 注入
  assert.equal(seen.headers["x-provider"], "cc-switch"); // 自定义 Header 注入
  assert.equal(seen.headers["x-api-key"], "sk-upstream-secret"); // 认证头不被覆盖
  assert.equal(seen.body.temperature, 0.2); // Body 浅合并生效
  assert.equal(seen.body.messages[0].content, "hi"); // 原请求体字段保留
});

test("请求级 failover + 熔断：503 供应商打开断路器并切到下一项", async (t) => {
  let failedCalls = 0;
  let healthyCalls = 0;
  const failed = await listen((request, response) => {
    failedCalls += 1;
    response.writeHead(503, { "content-type": "application/json" });
    response.end('{"error":"down"}');
  });
  const healthy = await listen((request, response) => {
    healthyCalls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "ok", model: "m", content: [{ type: "text", text: "fallback" }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  t.after(failed.close);
  t.after(healthy.close);

  const { providers, proxy } = await fixture(t);
  const first = await providers.create({ name: "Failed", baseUrl: failed.origin, apiKey: "k1", apps: { claude: true }, models: { claude: { model: "m" } }, meta: { apiFormat: "anthropic" } });
  const second = await providers.create({ name: "Healthy", baseUrl: healthy.origin, apiKey: "k2", apps: { claude: true }, models: { claude: { model: "m" } }, meta: { apiFormat: "anthropic" } });
  await providers.switchTo("claude", first.id);
  await providers.setFailover("claude", { queue: [first.id, second.id], autoFailover: true });
  await proxy.updateConfig({ listenPort: 0, circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000, successThreshold: 1 } });
  await proxy.start();

  const call = () => fetch(`${proxy.origin}/claude/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${proxy.config.token}` },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 1 }),
  });
  let response = await call();
  assert.equal(response.status, 200);
  const firstRequestId = response.headers.get("x-514cc-proxy-request-id");
  assert.match(firstRequestId, /^request-[0-9a-f-]{36}$/);
  assert.equal(response.headers.get("x-514cc-upstream-provider-id"), second.id);
  assert.equal((await response.json()).content[0].text, "fallback");
  assert.equal(failedCalls, 1);
  assert.equal(healthyCalls, 1);
  await waitFor(() => providers.current.claude === second.id, "successful failover did not persist the current provider");
  assert.equal(providers.current.claude, second.id);
  assert.equal(proxy.requestDetail(firstRequestId).providerId, second.id);
  assert.equal(proxy.requestDetail(firstRequestId).attempts.length, 2);
  assert.equal(proxy.health("claude").find((item) => item.providerId === first.id).state, "open");

  response = await call();
  assert.equal(response.status, 200);
  const secondRequestId = response.headers.get("x-514cc-proxy-request-id");
  await response.json();
  assert.equal(failedCalls, 1, "open breaker must skip the failed provider");
  assert.equal(healthyCalls, 2);
  // 请求日志在响应发出后才异步写盘，需等待第二条请求日志落库后再断言 attempts
  await waitFor(() => proxy.requestLogs().items[0]?.id === secondRequestId, "second request log not yet recorded");
  const detail = proxy.requestLogs().items[0];
  assert.equal(detail.attempts.length, 1);
  assert.equal(proxy.resetBreaker("claude", first.id).state, "closed");
});

test("协议转换与流式透传：首块无需尾包，客户端取消不 failover、不污染熔断器且关闭后无晚写", async (t) => {
  const convertedUpstream = await listen(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(body.messages[0].role, "user");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chat-1",
      model: "chat-model",
      choices: [{ message: { role: "assistant", content: "converted" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }));
  });
  t.after(convertedUpstream.close);
  const { root, providers, proxy } = await fixture(t);
  const provider = await providers.create({
    name: "Chat upstream",
    baseUrl: convertedUpstream.origin,
    apiKey: "chat-key",
    apps: { claude: true },
    models: { claude: { model: "chat-model" } },
    meta: { apiFormat: "openai_chat" },
  });
  await providers.switchTo("claude", provider.id);
  await proxy.updateConfig({ listenPort: 0, circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000, successThreshold: 1 } });
  await proxy.start();
  let response = await fetch(`${proxy.origin}/claude/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": proxy.config.token },
    body: JSON.stringify({ model: "chat-model", messages: [{ role: "user", content: "hello" }], max_tokens: 4 }),
  });
  const converted = await response.json();
  assert.equal(converted.type, "message");
  assert.equal(converted.content[0].text, "converted");
  assert.equal(converted.usage.input_tokens, 4);

  let streamCalls = 0;
  let observeStreamClosed;
  const streamClosed = new Promise((resolveClosed) => { observeStreamClosed = resolveClosed; });
  const streamUpstream = await listen((request, streamResponse) => {
    streamCalls += 1;
    const closed = () => observeStreamClosed();
    request.once("aborted", closed);
    streamResponse.once("close", closed);
    streamResponse.writeHead(200, { "content-type": "text/event-stream" });
    streamResponse.write('data: {"type":"content_block_delta","delta":{"text":"first"}}\n\n');
  });
  t.after(streamUpstream.close);
  let fallbackCalls = 0;
  const fallbackUpstream = await listen((request, fallbackResponse) => {
    fallbackCalls += 1;
    fallbackResponse.writeHead(200, { "content-type": "application/json" });
    fallbackResponse.end(JSON.stringify({ id: "fallback", model: "m", content: [{ type: "text", text: "wrong failover" }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  t.after(fallbackUpstream.close);
  const streamProvider = await providers.create({ name: "Stream", baseUrl: streamUpstream.origin, apiKey: "s", apps: { claude: true }, models: { claude: { model: "m" } }, meta: { apiFormat: "anthropic" } });
  const fallbackProvider = await providers.create({ name: "Fallback", baseUrl: fallbackUpstream.origin, apiKey: "f", apps: { claude: true }, models: { claude: { model: "m" } }, meta: { apiFormat: "anthropic" } });
  await providers.switchTo("claude", streamProvider.id);
  await providers.setFailover("claude", { queue: [streamProvider.id, fallbackProvider.id], autoFailover: true });
  response = await fetch(`${proxy.origin}/claude/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": proxy.config.token },
    body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "x" }], max_tokens: 1 }),
  });
  const reader = response.body.getReader();
  const firstChunk = await reader.read();
  assert.equal(firstChunk.done, false);
  assert.ok(new TextDecoder().decode(firstChunk.value).includes("first"));
  await reader.cancel("test client cancellation");
  await withTimeout(streamClosed, 1_000, "upstream did not observe cancellation from the proxy");
  await waitFor(() => proxy.status().activeRequests === 0, "cancelled streaming handler did not settle");
  assert.equal(streamCalls, 1);
  assert.equal(fallbackCalls, 0, "client cancellation must not fail over to another provider");
  const breaker = proxy.health("claude").find((item) => item.providerId === streamProvider.id);
  assert.equal(breaker.state, "closed");
  assert.equal(breaker.failures, 0);
  const cancelled = proxy.requestLogs().items[0];
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.errorCode, "CLIENT_DISCONNECTED");
  const closeStarted = performance.now();
  const closeStatus = await proxy.close();
  assert.ok(performance.now() - closeStarted < 750, "cooperative proxy close unexpectedly consumed the hard deadline");
  assert.equal(closeStatus.warnings.some((item) => item.code === "PROXY_REQUEST_DRAIN_TIMEOUT"), false);
  assert.equal(proxy.status().activeRequests, 0, "proxy close must drain cancelled streaming handlers");
  await rm(root, { recursive: true, force: true });
  await delay(80);
  await assert.rejects(access(root), { code: "ENOENT" });
});

test("close 封门后取消尚未执行的 start，关闭后禁止重新启动", async (t) => {
  const { proxy } = await fixture(t);
  const starting = proxy.start({ listenPort: 0 });
  const closing = proxy.close();
  await assert.rejects(starting, { code: "PROXY_CLOSED" });
  await closing;
  assert.equal(proxy.status().running, false);
  await assert.rejects(() => proxy.start(), { code: "PROXY_CLOSED" });
});

test("close 取消被 eventStore 阻塞的在途 start，并关闭已发布 listener", async (t) => {
  let notifyStartedEvent;
  let releaseStartedEvent;
  const startedEvent = new Promise((resolveStarted) => { notifyStartedEvent = resolveStarted; });
  const eventGate = new Promise((resolveEvent) => { releaseStartedEvent = resolveEvent; });
  const eventStore = {
    emit(type) {
      if (type !== "ccswitch.proxy_started") return Promise.resolve();
      notifyStartedEvent();
      return eventGate;
    },
  };
  const { proxy } = await fixture(t, { eventStore, shutdownTimeoutMs: 80 });
  const starting = proxy.start({ listenPort: 0 });
  await withTimeout(startedEvent, 1_000, "start did not reach the blocked lifecycle event");
  assert.equal(proxy.status().running, true);

  const closed = await withTimeout(proxy.close(), 750, "close waited indefinitely for the lifecycle queue");
  assert.equal(proxy.status().running, false);
  assert.equal(closed.warnings.some((item) => item.code === "PROXY_LIFECYCLE_DRAIN_TIMEOUT"), false);

  const startRejected = assert.rejects(starting, { code: "PROXY_CLOSED" });
  releaseStartedEvent();
  await startRejected;
});

test("close 取消阻塞中的 takeover，迟到 ProviderStore 不发布 live CLI 配置或复活数据根", async (t) => {
  const { root, runtimeHome, providers, proxy } = await fixture(t, { shutdownTimeoutMs: 80 });
  const provider = await providers.create({
    name: "Delayed takeover",
    baseUrl: "https://delayed-takeover.invalid",
    apiKey: "delayed-key",
    apps: { claude: true },
    models: { claude: { model: "m" } },
    meta: { apiFormat: "anthropic" },
  });
  await providers.switchTo("claude", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  const settingsPath = join(runtimeHome, ".claude", "settings.json");
  const before = await readFile(settingsPath, "utf8");
  const originalTakeover = providers.setProxyTakeover.bind(providers);
  let notifyTakeoverEntered;
  let releaseTakeover;
  let notifyProviderSettled;
  const takeoverEntered = new Promise((resolveEntered) => { notifyTakeoverEntered = resolveEntered; });
  const takeoverGate = new Promise((resolveTakeover) => { releaseTakeover = resolveTakeover; });
  const providerSettled = new Promise((resolveSettled) => { notifyProviderSettled = resolveSettled; });
  providers.setProxyTakeover = async (...args) => {
    notifyTakeoverEntered();
    try {
      await takeoverGate;
      return await originalTakeover(...args);
    } finally {
      notifyProviderSettled();
    }
  };

  const takeover = proxy.setTakeover("claude", true);
  await withTimeout(takeoverEntered, 1_000, "takeover did not reach the injected provider gate");
  const takeoverRejected = assert.rejects(takeover, { code: "PROXY_CLOSED" });
  const closed = await withTimeout(proxy.close(), 750, "close waited for the blocked takeover");
  assert.equal(closed.warnings.some((item) => item.code === "PROXY_LIFECYCLE_DRAIN_TIMEOUT"), false);
  await takeoverRejected;

  releaseTakeover();
  await withTimeout(providerSettled, 1_000, "late ProviderStore takeover did not settle");
  assert.equal(await readFile(settingsPath, "utf8"), before);
  assert.equal(providers.proxyRuntime.takeover.has("claude"), false);

  await rm(root, { recursive: true, force: true });
  await delay(80);
  await assert.rejects(access(root), { code: "ENOENT" });
});

test("close 可脱离异步 takeover 准备，但迟到发布计划没有写盘能力", async (t) => {
  const { root, dataRoot, runtimeHome, providers, proxy } = await fixture(t, { shutdownTimeoutMs: 80 });
  const provider = await providers.create({
    name: "Prepared takeover",
    baseUrl: "https://prepared-takeover.invalid/v1",
    apiKey: "prepared-key",
    apps: { codex: true },
    models: { codex: { model: "gpt-test", reasoningEffort: "high" } },
    meta: { apiFormat: "openai_responses" },
  });
  await providers.switchTo("codex", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  const authPath = join(runtimeHome, ".codex", "auth.json");
  const tomlPath = join(runtimeHome, ".codex", "config.toml");
  const proxyConfigPath = join(dataRoot, "ccswitch-proxy.json");
  const beforeAuth = await readFile(authPath, "utf8");
  const beforeToml = await readFile(tomlPath, "utf8");
  const beforeProxyConfig = await readFile(proxyConfigPath, "utf8");
  let notifyPlanReady;
  let releasePlan;
  const planReady = new Promise((resolveReady) => { notifyPlanReady = resolveReady; });
  const planGate = new Promise((resolveGate) => { releasePlan = resolveGate; });
  providers.beforeLiveConfigPlanCommit = async ({ app, enabled, targets }) => {
    if (app !== "codex" || !enabled) return;
    assert.deepEqual(targets, [authPath, tomlPath, proxyConfigPath]);
    notifyPlanReady();
    await planGate;
  };

  const takeover = proxy.setTakeover("codex", true);
  await withTimeout(planReady, 1_000, "takeover did not finish its read-only publication plan");
  assert.equal(
    providers.proxyRuntime.takeover.has("codex"),
    false,
    "Provider runtime must retain the committed state while publication is still preparing",
  );
  assert.equal(proxy.config.takeover.codex, false);
  const rejected = assert.rejects(takeover, { code: "PROXY_CLOSED" });
  await withTimeout(proxy.close(), 750, "close waited for read-only takeover preparation");
  await rejected;
  assert.equal(await readFile(authPath, "utf8"), beforeAuth);
  assert.equal(await readFile(tomlPath, "utf8"), beforeToml);
  assert.equal(await readFile(proxyConfigPath, "utf8"), beforeProxyConfig);

  await rm(root, { recursive: true, force: true });
  releasePlan();
  await waitFor(() => !providers.proxyRuntime.takeover.has("codex"), "late publication plan did not settle");
  await delay(80);
  await assert.rejects(access(root), { code: "ENOENT" });
});

test("close 插入单文件 live rename 临界点时取消发布，并同步回滚 proxy 配置", async (t) => {
  const { root, dataRoot, runtimeHome, providers, proxy } = await fixture(t, { shutdownTimeoutMs: 80 });
  const provider = await providers.create({
    name: "Single-file publish gate",
    baseUrl: "https://single-publish.invalid",
    apiKey: "single-key",
    apps: { claude: true },
    models: { claude: { model: "m" } },
    meta: { apiFormat: "anthropic" },
  });
  await providers.switchTo("claude", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  const settingsPath = join(runtimeHome, ".claude", "settings.json");
  const proxyConfigPath = join(dataRoot, "ccswitch-proxy.json");
  const beforeSettings = await readFile(settingsPath, "utf8");
  const beforeProxyConfig = await readFile(proxyConfigPath, "utf8");
  let closing = null;
  providers.beforeLiveConfigPublish = ({ target }) => {
    if (target === settingsPath && !closing) closing = proxy.close();
  };

  const takeover = proxy.setTakeover("claude", true);
  const rejected = assert.rejects(takeover, { code: "PROXY_CLOSED" });
  await waitFor(() => closing, "single-file publish hook did not invoke close");
  await withTimeout(closing, 750, "close waited for a cancelled single-file publish");
  await rejected;
  assert.equal(await readFile(settingsPath, "utf8"), beforeSettings);
  assert.equal(await readFile(proxyConfigPath, "utf8"), beforeProxyConfig);
  assert.equal(providers.proxyRuntime.takeover.has("claude"), false);

  await rm(root, { recursive: true, force: true });
  await delay(80);
  await assert.rejects(access(root), { code: "ENOENT" });
});

test("close 插入 Codex 第二文件发布前时，同步回滚第一文件且无晚 rollback", async (t) => {
  const { root, dataRoot, runtimeHome, providers, proxy } = await fixture(t, { shutdownTimeoutMs: 80 });
  const provider = await providers.create({
    name: "Multi-file publish gate",
    baseUrl: "https://multi-publish.invalid/v1",
    apiKey: "multi-key",
    apps: { codex: true },
    models: { codex: { model: "gpt-test", reasoningEffort: "high" } },
    meta: { apiFormat: "openai_responses" },
  });
  await providers.switchTo("codex", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  const authPath = join(runtimeHome, ".codex", "auth.json");
  const tomlPath = join(runtimeHome, ".codex", "config.toml");
  const proxyConfigPath = join(dataRoot, "ccswitch-proxy.json");
  const beforeAuth = await readFile(authPath, "utf8");
  const beforeToml = await readFile(tomlPath, "utf8");
  const beforeProxyConfig = await readFile(proxyConfigPath, "utf8");
  const publishes = [];
  let closing = null;
  let firstFileWasPublished = false;
  providers.beforeLiveConfigPublish = ({ target }) => {
    if (!new Set([authPath, tomlPath]).has(target)) return;
    publishes.push(target);
    if (publishes.length === 2 && !closing) {
      firstFileWasPublished = readFileSync(authPath, "utf8") !== beforeAuth;
      closing = proxy.close();
    }
  };

  const takeover = proxy.setTakeover("codex", true);
  const rejected = assert.rejects(takeover, { code: "PROXY_CLOSED" });
  await waitFor(() => closing, "multi-file publish hook did not reach the second target");
  await withTimeout(closing, 750, "close waited for multi-file rollback");
  await rejected;
  assert.deepEqual(publishes, [authPath, tomlPath]);
  assert.equal(firstFileWasPublished, true);
  assert.equal(await readFile(authPath, "utf8"), beforeAuth);
  assert.equal(await readFile(tomlPath, "utf8"), beforeToml);
  assert.equal(await readFile(proxyConfigPath, "utf8"), beforeProxyConfig);
  assert.equal(providers.proxyRuntime.takeover.has("codex"), false);

  await rm(root, { recursive: true, force: true });
  await delay(80);
  await assert.rejects(access(root), { code: "ENOENT" });
});

test("setTakeover 的 proxy sidecar rename 失败时，live、runtime、proxy 文件与内存全部保留旧态", async (t) => {
  const { dataRoot, runtimeHome, providers, proxy } = await fixture(t, { shutdownTimeoutMs: 500 });
  const provider = await providers.create({
    name: "Sidecar publish failure",
    baseUrl: "https://sidecar-publish.invalid/v1",
    apiKey: "sidecar-key",
    apps: { codex: true },
    models: { codex: { model: "gpt-test", reasoningEffort: "high" } },
    meta: { apiFormat: "openai_responses" },
  });
  await providers.switchTo("codex", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  const authPath = join(runtimeHome, ".codex", "auth.json");
  const tomlPath = join(runtimeHome, ".codex", "config.toml");
  const proxyConfigPath = join(dataRoot, "ccswitch-proxy.json");
  const beforeAuth = await readFile(authPath, "utf8");
  const beforeToml = await readFile(tomlPath, "utf8");
  const beforeProxyConfig = await readFile(proxyConfigPath, "utf8");
  let sidecarAttempted = false;
  providers.beforeLiveConfigPublish = ({ target, temp }) => {
    if (target !== proxyConfigPath || sidecarAttempted) return;
    sidecarAttempted = true;
    rmSync(temp, { force: true });
  };

  await assert.rejects(proxy.setTakeover("codex", true), { code: "ENOENT" });
  assert.equal(sidecarAttempted, true);
  assert.equal(await readFile(authPath, "utf8"), beforeAuth);
  assert.equal(await readFile(tomlPath, "utf8"), beforeToml);
  assert.equal(await readFile(proxyConfigPath, "utf8"), beforeProxyConfig);
  assert.equal(proxy.config.takeover.codex, false);
  assert.equal(providers.proxyRuntime.takeover.has("codex"), false);
});

test("takeover 审计 sink 在提交后同步 close 重入时，内存先可见且 close 最终恢复四态", async (t) => {
  let proxyRef = null;
  let closing = null;
  const eventStore = {
    emit(type, data) {
      if (type === "provider.proxy_takeover" && data.enabled && !closing) closing = proxyRef.close();
      return Promise.resolve();
    },
  };
  const { dataRoot, runtimeHome, providers, proxy } = await fixture(t, { eventStore, shutdownTimeoutMs: 3000 });
  proxyRef = proxy;
  const provider = await providers.create({
    name: "Audit reentry",
    baseUrl: "https://audit-reentry.invalid",
    apiKey: "audit-reentry-key",
    apps: { claude: true },
    models: { claude: { model: "m" } },
    meta: { apiFormat: "anthropic" },
  });
  await providers.switchTo("claude", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  const settingsPath = join(runtimeHome, ".claude", "settings.json");
  const proxyConfigPath = join(dataRoot, "ccswitch-proxy.json");
  const beforeSettings = await readFile(settingsPath, "utf8");
  const beforeProxyConfig = await readFile(proxyConfigPath, "utf8");

  await proxy.setTakeover("claude", true);
  assert.ok(closing, "provider audit sink did not synchronously re-enter close");
  await withTimeout(closing, 3_000, "reentrant close did not settle");
  assert.equal(await readFile(settingsPath, "utf8"), beforeSettings);
  assert.equal(await readFile(proxyConfigPath, "utf8"), beforeProxyConfig);
  assert.equal(proxy.config.takeover.claude, false);
  assert.equal(providers.proxyRuntime.takeover.has("claude"), false);
});

test("sidecar 提交尾部已排队的 microtask close 不得把已提交事务误判为取消", async (t) => {
  const { dataRoot, runtimeHome, providers, proxy } = await fixture(t, { shutdownTimeoutMs: 3000 });
  const provider = await providers.create({
    name: "Commit microtask race",
    baseUrl: "https://commit-microtask.invalid",
    apiKey: "commit-microtask-key",
    apps: { claude: true },
    models: { claude: { model: "m" } },
    meta: { apiFormat: "anthropic" },
  });
  await providers.switchTo("claude", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  const settingsPath = join(runtimeHome, ".claude", "settings.json");
  const proxyConfigPath = join(dataRoot, "ccswitch-proxy.json");
  const beforeSettings = await readFile(settingsPath, "utf8");
  const beforeProxyConfig = await readFile(proxyConfigPath, "utf8");
  let closing = null;
  providers.beforeLiveConfigPublish = ({ target }) => {
    if (target !== proxyConfigPath || closing) return;
    queueMicrotask(() => { closing = proxy.close(); });
  };

  await proxy.setTakeover("claude", true);
  await waitFor(() => closing, "queued close did not run after the sidecar commit");
  await withTimeout(closing, 3_000, "queued close did not settle");
  assert.equal(await readFile(settingsPath, "utf8"), beforeSettings);
  assert.equal(await readFile(proxyConfigPath, "utf8"), beforeProxyConfig);
  assert.equal(proxy.config.takeover.claude, false);
  assert.equal(providers.proxyRuntime.takeover.has("claude"), false);
});

test("事务为 rollback 预留独立 deadline：第一目标已发布、第二目标超时后仍恢复全部旧字节", async (t) => {
  const { dataRoot, runtimeHome, providers, proxy } = await fixture(t, { shutdownTimeoutMs: 500 });
  const provider = await providers.create({
    name: "Reserved rollback budget",
    baseUrl: "https://rollback-budget.invalid/v1",
    apiKey: "rollback-key",
    apps: { codex: true },
    models: { codex: { model: "gpt-test", reasoningEffort: "high" } },
    meta: { apiFormat: "openai_responses" },
  });
  await providers.switchTo("codex", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  const authPath = join(runtimeHome, ".codex", "auth.json");
  const tomlPath = join(runtimeHome, ".codex", "config.toml");
  const proxyConfigPath = join(dataRoot, "ccswitch-proxy.json");
  await writeFile(authPath, `${JSON.stringify({
    OPENAI_API_KEY: "pre-takeover-key",
    padding: "x".repeat(95_000),
  }, null, 2)}\n`, "utf8");
  const beforeAuth = await readFile(authPath, "utf8");
  const beforeToml = await readFile(tomlPath, "utf8");
  const beforeProxyConfig = await readFile(proxyConfigPath, "utf8");
  const nextConfig = {
    ...proxy.config,
    takeover: { ...proxy.config.takeover, codex: true },
  };
  // deadline 只在同步提交阶段（commit）arm，且预算须覆盖慢盘（I: 盘）上的备份 + 快照写入
  let overallDeadline = Infinity;
  let firstFileWasPublished = false;
  let rollbackSnapshotPrepared = false;
  providers.beforeLiveConfigPlanCommit = async () => {
    overallDeadline = Date.now() + 1500;
  };
  providers.beforeLiveConfigPublish = ({ target }) => {
    if (target !== tomlPath) return;
    firstFileWasPublished = readFileSync(authPath, "utf8") !== beforeAuth;
    rollbackSnapshotPrepared = readdirSync(dirname(authPath))
      .filter((name) => name.startsWith(".514forge-rollback.") && name.endsWith(".tmp"))
      .some((name) => readFileSync(join(dirname(authPath), name), "utf8") === beforeAuth);
    const waitMs = overallDeadline - Date.now() - 95;
    if (waitMs > 0) Atomics.wait(syncWaitCell, 0, 0, waitMs);
  };

  await assert.rejects(
    providers.setProxyTakeover("codex", true, {
      signal: new AbortController().signal,
      deadline: () => overallDeadline,
      sidecarWrites: [{ target: proxyConfigPath, content: `${JSON.stringify(nextConfig, null, 2)}\n` }],
    }),
    { code: "PROXY_CLOSE_TIMEOUT" },
  );
  assert.equal(firstFileWasPublished, true);
  assert.equal(rollbackSnapshotPrepared, true);
  assert.equal(await readFile(authPath, "utf8"), beforeAuth);
  assert.equal(await readFile(tomlPath, "utf8"), beforeToml);
  assert.equal(await readFile(proxyConfigPath, "utf8"), beforeProxyConfig);
  assert.equal(proxy.config.takeover.codex, false);
  assert.equal(providers.proxyRuntime.takeover.has("codex"), false);
});

test("最终 rename 前再次复核 live 快照：并发外部编辑触发 LIVE_CONFIG_CHANGED 且不被回滚覆盖", async (t) => {
  const { dataRoot, runtimeHome, providers, proxy } = await fixture(t, { shutdownTimeoutMs: 500 });
  const provider = await providers.create({
    name: "Final snapshot guard",
    baseUrl: "https://snapshot-guard.invalid",
    apiKey: "snapshot-key",
    apps: { claude: true },
    models: { claude: { model: "claude-test" } },
  });
  await providers.switchTo("claude", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  const settingsPath = join(runtimeHome, ".claude", "settings.json");
  const proxyConfigPath = join(dataRoot, "ccswitch-proxy.json");
  const beforeProxyConfig = await readFile(proxyConfigPath, "utf8");
  const externalSettings = `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://external-edit.invalid" } }, null, 2)}\n`;
  let edited = false;
  providers.beforeLiveConfigPublish = ({ target }) => {
    if (edited || target !== settingsPath) return;
    edited = true;
    writeFileSync(settingsPath, externalSettings, "utf8");
  };

  await assert.rejects(proxy.setTakeover("claude", true), { code: "LIVE_CONFIG_CHANGED" });
  providers.beforeLiveConfigPublish = null;
  assert.equal(edited, true);
  assert.equal(await readFile(settingsPath, "utf8"), externalSettings);
  assert.equal(await readFile(proxyConfigPath, "utf8"), beforeProxyConfig);
  assert.equal(proxy.config.takeover.claude, false);
  assert.equal(providers.proxyRuntime.takeover.has("claude"), false);
});

test("Windows rename 瞬时失败后的每次 retry 都重做 CAS，重试间外部编辑不会被覆盖", async (t) => {
  let protectedTarget = null;
  let armed = false;
  let renameAttempts = 0;
  const externalSettings = `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://retry-external-edit.invalid" } }, null, 2)}\n`;
  const liveRenameSync = (source, target) => {
    if (armed && target === protectedTarget) {
      renameAttempts += 1;
      if (renameAttempts === 1) {
        writeFileSync(target, externalSettings, "utf8");
        throw Object.assign(new Error("target was locked while another CLI saved it"), { code: "EBUSY" });
      }
    }
    renameSync(source, target);
  };
  const { dataRoot, runtimeHome, providers, proxy } = await fixture(t, {
    shutdownTimeoutMs: 500,
    providerStoreOptions: { liveRenameSync },
  });
  const provider = await providers.create({
    name: "Retry CAS guard",
    baseUrl: "https://retry-cas.invalid",
    apiKey: "retry-cas-key",
    apps: { claude: true },
    models: { claude: { model: "claude-test" } },
  });
  await providers.switchTo("claude", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  protectedTarget = join(runtimeHome, ".claude", "settings.json");
  const proxyConfigPath = join(dataRoot, "ccswitch-proxy.json");
  const beforeProxyConfig = await readFile(proxyConfigPath, "utf8");
  armed = true;
  await assert.rejects(proxy.setTakeover("claude", true), { code: "LIVE_CONFIG_CHANGED" });
  armed = false;
  assert.equal(renameAttempts, 1, "the second rename syscall must be blocked by its pre-attempt CAS");
  assert.equal(await readFile(protectedTarget, "utf8"), externalSettings);
  assert.equal(await readFile(proxyConfigPath, "utf8"), beforeProxyConfig);
  assert.equal(proxy.config.takeover.claude, false);
  assert.equal(providers.proxyRuntime.takeover.has("claude"), false);
});

test("rollback 每次 attempt 前验证事务写值，提交后的外部编辑只报诊断而不被旧快照覆盖", async (t) => {
  const { dataRoot, runtimeHome, providers, proxy } = await fixture(t, { shutdownTimeoutMs: 500 });
  const provider = await providers.create({
    name: "Rollback CAS guard",
    baseUrl: "https://rollback-cas.invalid/v1",
    apiKey: "rollback-cas-key",
    apps: { codex: true },
    models: { codex: { model: "gpt-test", reasoningEffort: "high" } },
    meta: { apiFormat: "openai_responses" },
  });
  await providers.switchTo("codex", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  const authPath = join(runtimeHome, ".codex", "auth.json");
  const tomlPath = join(runtimeHome, ".codex", "config.toml");
  const proxyConfigPath = join(dataRoot, "ccswitch-proxy.json");
  const beforeToml = await readFile(tomlPath, "utf8");
  const beforeProxyConfig = await readFile(proxyConfigPath, "utf8");
  const externalAuth = `${JSON.stringify({ OPENAI_API_KEY: "external-after-commit" }, null, 2)}\n`;
  providers.beforeLiveConfigPublish = ({ target }) => {
    if (target !== tomlPath) return;
    writeFileSync(authPath, externalAuth, "utf8");
    throw Object.assign(new Error("injected second-target failure"), { code: "EIO" });
  };

  let caught = null;
  await assert.rejects(proxy.setTakeover("codex", true), (error) => {
    caught = error;
    return error?.code === "EIO";
  });
  providers.beforeLiveConfigPublish = null;
  assert.match(caught.rollbackErrors?.join("\n") ?? "", /published live config changed before rollback/);
  assert.equal(await readFile(authPath, "utf8"), externalAuth);
  assert.equal(await readFile(tomlPath, "utf8"), beforeToml);
  assert.equal(await readFile(proxyConfigPath, "utf8"), beforeProxyConfig);
  assert.equal(proxy.config.takeover.codex, false);
  assert.equal(providers.proxyRuntime.takeover.has("codex"), false);
});

test("慢 rename 已提交并越过 deadline 后启用独立补偿窗口，live 与 sidecar 都恢复旧字节", async (t) => {
  let slowPublication = false;
  let delayed = false;
  let overallDeadline = Infinity;
  const liveRenameSync = (source, target) => {
    renameSync(source, target);
    if (!slowPublication || delayed || String(source).includes(".514forge-rollback.")) return;
    delayed = true;
    const waitMs = overallDeadline - Date.now() + 10;
    if (waitMs > 0) Atomics.wait(syncWaitCell, 0, 0, waitMs);
  };
  const { dataRoot, runtimeHome, providers, proxy } = await fixture(t, {
    shutdownTimeoutMs: 500,
    providerStoreOptions: { liveRenameSync },
  });
  const provider = await providers.create({
    name: "Slow committed rename",
    baseUrl: "https://slow-rename.invalid",
    apiKey: "slow-key",
    apps: { claude: true },
    models: { claude: { model: "claude-test" } },
  });
  await providers.switchTo("claude", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  const settingsPath = join(runtimeHome, ".claude", "settings.json");
  const proxyConfigPath = join(dataRoot, "ccswitch-proxy.json");
  const beforeSettings = await readFile(settingsPath, "utf8");
  const beforeProxyConfig = await readFile(proxyConfigPath, "utf8");
  const nextConfig = {
    ...proxy.config,
    takeover: { ...proxy.config.takeover, claude: true },
  };
  slowPublication = true;
  // deadline 以惰性函数传入，并在 commit 阶段才 arm——避免异步准备吃掉预算；
  // 预算须覆盖慢盘（I: 盘）上的备份 + 快照写入，rename 侧再单独阻塞越过 deadline
  providers.beforeLiveConfigPlanCommit = async () => {
    overallDeadline = Date.now() + 1500;
  };
  let caught = null;
  await assert.rejects(
    providers.setProxyTakeover("claude", true, {
      signal: new AbortController().signal,
      deadline: () => overallDeadline,
      sidecarWrites: [{ target: proxyConfigPath, content: `${JSON.stringify(nextConfig, null, 2)}\n` }],
    }),
    (error) => {
      caught = error;
      return error?.code === "RENAME_DEADLINE_EXCEEDED" && error.renameCommitted === true;
    },
  );
  assert.equal(delayed, true);
  assert.equal(caught.rollbackErrors, undefined);
  assert.equal(await readFile(settingsPath, "utf8"), beforeSettings);
  assert.equal(await readFile(proxyConfigPath, "utf8"), beforeProxyConfig);
  assert.equal(providers.proxyRuntime.takeover.has("claude"), false);
});

test("close restore 的 proxy sidecar rename 失败时保留可用 listener 与 takeover 四态，解除故障后可重试", async (t) => {
  const { dataRoot, runtimeHome, providers, proxy } = await fixture(t, { shutdownTimeoutMs: 3000 });
  const provider = await providers.create({
    name: "Close sidecar failure",
    baseUrl: "https://close-sidecar.invalid/v1",
    apiKey: "close-sidecar-key",
    apps: { codex: true },
    models: { codex: { model: "gpt-test", reasoningEffort: "high" } },
    meta: { apiFormat: "openai_responses" },
  });
  await providers.switchTo("codex", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();
  await proxy.setTakeover("codex", true);

  const authPath = join(runtimeHome, ".codex", "auth.json");
  const tomlPath = join(runtimeHome, ".codex", "config.toml");
  const proxyConfigPath = join(dataRoot, "ccswitch-proxy.json");
  const beforeAuth = await readFile(authPath, "utf8");
  const beforeToml = await readFile(tomlPath, "utf8");
  const beforeProxyConfig = await readFile(proxyConfigPath, "utf8");
  let sidecarAttempted = false;
  providers.beforeLiveConfigPublish = ({ target, temp }) => {
    if (target !== proxyConfigPath || sidecarAttempted) return;
    sidecarAttempted = true;
    rmSync(temp, { force: true });
  };

  const closed = await withTimeout(proxy.close(), 1_000, "close waited after sidecar publication failed");
  const warning = closed.warnings.find((item) => item.code === "PROXY_TAKEOVER_RESTORE_FAILED");
  assert.equal(sidecarAttempted, true);
  assert.ok(warning);
  assert.match(warning.error, /ccswitch-proxy\.json/);
  assert.equal(await readFile(authPath, "utf8"), beforeAuth);
  assert.equal(await readFile(tomlPath, "utf8"), beforeToml);
  assert.equal(await readFile(proxyConfigPath, "utf8"), beforeProxyConfig);
  assert.equal(proxy.config.takeover.codex, true);
  assert.equal(providers.proxyRuntime.takeover.has("codex"), true);
  assert.equal(closed.closed, false);
  assert.equal(closed.running, true);
  assert.ok(closed.warnings.some((item) => item.code === "PROXY_CLOSE_INCOMPLETE"));
  await assertProxyListenerReachable(proxy, "codex");

  providers.beforeLiveConfigPublish = null;
  const retried = await withTimeout(proxy.close(), 1_000, "close retry did not settle after the sidecar fault cleared");
  assert.equal(retried.closed, true);
  assert.equal(retried.running, false);
});

test("手动 stop restore 的 proxy sidecar rename 失败时保留可用 listener 与 takeover 四态", async (t) => {
  // shutdownTimeoutMs 提升以覆盖慢盘（I: 盘）上 restore 的 live + sidecar 写入
  const { dataRoot, runtimeHome, providers, proxy } = await fixture(t, { shutdownTimeoutMs: 3000 });
  const provider = await providers.create({
    name: "Stop sidecar failure",
    baseUrl: "https://stop-sidecar.invalid",
    apiKey: "stop-sidecar-key",
    apps: { claude: true },
    models: { claude: { model: "m" } },
    meta: { apiFormat: "anthropic" },
  });
  await providers.switchTo("claude", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();
  await proxy.setTakeover("claude", true);

  const settingsPath = join(runtimeHome, ".claude", "settings.json");
  const proxyConfigPath = join(dataRoot, "ccswitch-proxy.json");
  const beforeSettings = await readFile(settingsPath, "utf8");
  const beforeProxyConfig = await readFile(proxyConfigPath, "utf8");
  let sidecarAttempted = false;
  providers.beforeLiveConfigPublish = ({ target, temp }) => {
    if (target !== proxyConfigPath || sidecarAttempted) return;
    sidecarAttempted = true;
    rmSync(temp, { force: true });
  };

  const stopped = await withTimeout(proxy.stop(), 1_000, "stop waited after sidecar publication failed");
  const warning = stopped.warnings.find((item) => item.app === "claude");
  assert.equal(sidecarAttempted, true);
  assert.ok(warning);
  assert.match(warning.error, /ccswitch-proxy\.json/);
  assert.equal(await readFile(settingsPath, "utf8"), beforeSettings);
  assert.equal(await readFile(proxyConfigPath, "utf8"), beforeProxyConfig);
  assert.equal(proxy.config.takeover.claude, true);
  assert.equal(providers.proxyRuntime.takeover.has("claude"), true);
  assert.equal(stopped.stopped, false);
  assert.equal(stopped.running, true);
  assert.ok(stopped.warnings.some((item) => item.code === "PROXY_STOP_INCOMPLETE"));
  await assertProxyListenerReachable(proxy);

  providers.beforeLiveConfigPublish = null;
  const retried = await withTimeout(proxy.stop(), 3_000, "stop retry did not settle after the sidecar fault cleared");
  assert.equal(retried.stopped, true);
  assert.equal(retried.running, false);
});

test("close warning 展开 Provider rollbackErrors 并保留具体 live 目标", async (t) => {
  // shutdownTimeoutMs 提升以覆盖慢盘（I: 盘）上 restore 的 live + sidecar 写入
  const { runtimeHome, providers, proxy } = await fixture(t, { shutdownTimeoutMs: 3000 });
  const provider = await providers.create({
    name: "Rollback diagnostic",
    baseUrl: "https://rollback-diagnostic.invalid",
    apiKey: "rollback-diagnostic-key",
    apps: { claude: true },
    models: { claude: { model: "m" } },
    meta: { apiFormat: "anthropic" },
  });
  await providers.switchTo("claude", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();
  await proxy.setTakeover("claude", true);

  const settingsPath = join(runtimeHome, ".claude", "settings.json");
  const originalTakeover = providers.setProxyTakeover.bind(providers);
  providers.setProxyTakeover = async (_app, enabled) => {
    assert.equal(enabled, false);
    throw Object.assign(new Error("restore failed"), {
      rollbackErrors: [`${settingsPath}: EBUSY`],
    });
  };

  const closed = await withTimeout(proxy.close(), 1_000, "close waited after rollback diagnostics failed");
  const warning = closed.warnings.find((item) => item.code === "PROXY_TAKEOVER_RESTORE_FAILED");
  assert.ok(warning);
  assert.ok(warning.error.includes(settingsPath));
  assert.match(warning.error, /rollback:/);
  assert.equal(closed.closed, false);
  assert.equal(closed.running, true);
  await assertProxyListenerReachable(proxy);

  providers.setProxyTakeover = originalTakeover;
  const retried = await withTimeout(proxy.close(), 3_000, "close retry did not settle after rollback diagnostics cleared");
  assert.equal(retried.closed, true);
});

test("close restore 超时时有界返回，takeover 内存与磁盘保持一致且迟到计划不复活目录", async (t) => {
  const { root, dataRoot, providers, proxy } = await fixture(t, { shutdownTimeoutMs: 80 });
  const provider = await providers.create({
    name: "Blocked restore",
    baseUrl: "https://blocked-restore.invalid/v1",
    apiKey: "restore-key",
    apps: { codex: true },
    models: { codex: { model: "gpt-test", reasoningEffort: "high" } },
    meta: { apiFormat: "openai_responses" },
  });
  await providers.switchTo("codex", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();
  await proxy.setTakeover("codex", true);

  const configPath = join(dataRoot, "ccswitch-proxy.json");
  const beforeConfig = await readFile(configPath, "utf8");
  let notifyRestoreReady;
  let releaseRestore;
  const restoreReady = new Promise((resolveReady) => { notifyRestoreReady = resolveReady; });
  const restoreGate = new Promise((resolveGate) => { releaseRestore = resolveGate; });
  providers.beforeLiveConfigPlanCommit = async ({ app, enabled }) => {
    if (app !== "codex" || enabled) return;
    notifyRestoreReady();
    await restoreGate;
  };

  const startedAt = performance.now();
  const closing = proxy.close();
  await withTimeout(restoreReady, 1_000, "close restore did not reach the prepared publication gate");
  assert.equal(
    providers.proxyRuntime.takeover.has("codex"),
    true,
    "Provider runtime must retain takeover until restore publication commits",
  );
  assert.equal(proxy.config.takeover.codex, true);
  const closed = await withTimeout(closing, 750, "close waited indefinitely for blocked restore");
  assert.ok(performance.now() - startedAt < 400);
  assert.equal(closed.warnings.some((item) => item.code === "PROXY_TAKEOVER_RESTORE_TIMEOUT"), true);
  assert.equal(closed.closed, false);
  assert.equal(closed.running, true);
  assert.equal(proxy.config.takeover.codex, true);
  assert.equal(await readFile(configPath, "utf8"), beforeConfig);
  await assertProxyListenerReachable(proxy, "codex");

  releaseRestore();
  proxy.shutdownTimeoutMs = 3000;
  const retried = await withTimeout(proxy.close(), 5_000, "close retry did not settle after the restore gate opened");
  assert.equal(retried.closed, true);
  await rm(root, { recursive: true, force: true });
  await delay(100);
  await assert.rejects(access(root), { code: "ENOENT" });
});

test("close 插入 proxy 配置发布前时，updateConfig 的内存与磁盘都恢复旧快照", async (t) => {
  const { root, dataRoot, proxy } = await fixture(t, { shutdownTimeoutMs: 80 });
  const configPath = join(dataRoot, "ccswitch-proxy.json");
  const before = await readFile(configPath, "utf8");
  const beforeTimeout = proxy.config.requestTimeoutMs;
  let closing = null;
  proxy.beforeConfigPublish = () => {
    if (!closing) closing = proxy.close();
  };

  const updating = proxy.updateConfig({ requestTimeoutMs: beforeTimeout + 1_000 });
  const rejected = assert.rejects(updating, { code: "PROXY_CLOSED" });
  await waitFor(() => closing, "proxy config publish hook did not invoke close");
  await withTimeout(closing, 750, "close waited for proxy config rollback");
  await rejected;
  assert.equal(proxy.config.requestTimeoutMs, beforeTimeout);
  assert.equal(await readFile(configPath, "utf8"), before);

  await rm(root, { recursive: true, force: true });
  await delay(80);
  await assert.rejects(access(root), { code: "ENOENT" });
});

test("close 对不响应 abort 的 fetch 有界返回，迟到 handler 不会重建已清理目录", async (t) => {
  let resolveFetch;
  let notifyFetchStarted;
  let observedSignal = null;
  const fetchStarted = new Promise((resolveStarted) => { notifyFetchStarted = resolveStarted; });
  const { root, providers, proxy } = await fixture(t, {
    shutdownTimeoutMs: 80,
    fetchImpl: (_url, options) => {
      observedSignal = options.signal;
      notifyFetchStarted();
      return new Promise((resolveUpstream) => { resolveFetch = resolveUpstream; });
    },
  });
  const provider = await providers.create({ name: "Non-cooperative", baseUrl: "https://non-cooperative.invalid", apiKey: "k", apps: { claude: true }, models: { claude: { model: "m" } }, meta: { apiFormat: "anthropic" } });
  await providers.switchTo("claude", provider.id);
  await proxy.updateConfig({ listenPort: 0, circuitBreaker: { failureThreshold: 1 } });
  await proxy.start();

  const clientRequest = fetch(`${proxy.origin}/claude/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": proxy.config.token },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 1 }),
  }).then((result) => result, (error) => error);
  await withTimeout(fetchStarted, 1_000, "proxy did not call the injected fetch");
  await waitFor(() => proxy.status().activeRequests === 1, "proxy request did not become active");

  const closed = await withTimeout(proxy.close(), 750, "proxy close exceeded its configured drain deadline");
  assert.equal(observedSignal.aborted, true);
  assert.ok(closed.warnings.some((item) => item.code === "PROXY_REQUEST_DRAIN_TIMEOUT"));
  await rm(root, { recursive: true, force: true });

  resolveFetch(new Response(JSON.stringify({ id: "late", type: "message", model: "m", content: [{ type: "text", text: "late" }], usage: { input_tokens: 1, output_tokens: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  await clientRequest;
  await waitFor(() => proxy.status().activeRequests === 0, "late handler did not settle after its fetch resolved");
  await delay(80);
  await assert.rejects(access(root), { code: "ENOENT" });
  const breaker = proxy.health("claude").find((item) => item.providerId === provider.id);
  assert.equal(breaker.failures, 0, "shutdown cancellation must not mutate the breaker");
});

test("close 对已越过日志门闩的慢写仍有界，request path 不创建已删除数据根", async (t) => {
  const upstream = await listen((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "ok", type: "message", model: "m", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  t.after(upstream.close);
  let notifyLogStarted;
  let releaseLog;
  const logStarted = new Promise((resolveStarted) => { notifyLogStarted = resolveStarted; });
  const logGate = new Promise((resolveLog) => { releaseLog = resolveLog; });
  const { root, providers, proxy } = await fixture(t, {
    shutdownTimeoutMs: 80,
    requestLogAppend: async (...args) => {
      notifyLogStarted();
      await logGate;
      return appendFile(...args);
    },
  });
  const provider = await providers.create({ name: "Slow log", baseUrl: upstream.origin, apiKey: "k", apps: { claude: true }, models: { claude: { model: "m" } }, meta: { apiFormat: "anthropic" } });
  await providers.switchTo("claude", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  const response = await fetch(`${proxy.origin}/claude/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": proxy.config.token },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 1 }),
  });
  assert.equal(response.status, 200);
  await response.json();
  await withTimeout(logStarted, 1_000, "request did not enter the delayed log append");

  const closed = await withTimeout(proxy.close(), 750, "close waited indefinitely for an accepted log write");
  assert.ok(closed.warnings.some((item) => item.code === "PROXY_LOG_DRAIN_TIMEOUT"));
  await rm(root, { recursive: true, force: true });
  releaseLog();
  await waitFor(() => proxy.status().activeRequests === 0, "delayed log handler did not settle");
  await delay(80);
  await assert.rejects(access(root), { code: "ENOENT" });
});

test("本地 current 与请求日志持久化失败只降级诊断，不污染成功供应商 breaker", async (t) => {
  let failedCalls = 0;
  let healthyCalls = 0;
  const failed = await listen((request, response) => {
    failedCalls += 1;
    response.writeHead(503, { "content-type": "application/json" });
    response.end('{"error":"down"}');
  });
  const healthy = await listen((request, response) => {
    healthyCalls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "ok", type: "message", model: "m", content: [{ type: "text", text: "healthy" }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  t.after(failed.close);
  t.after(healthy.close);
  const diskError = Object.assign(new Error("simulated local persistence failure"), { code: "EIO" });
  const { providers, proxy } = await fixture(t, {
    requestLogAppend: async () => { throw diskError; },
  });
  const first = await providers.create({ name: "Failed upstream", baseUrl: failed.origin, apiKey: "a", apps: { claude: true }, models: { claude: { model: "m" } }, meta: { apiFormat: "anthropic" } });
  const second = await providers.create({ name: "Healthy upstream", baseUrl: healthy.origin, apiKey: "b", apps: { claude: true }, models: { claude: { model: "m" } }, meta: { apiFormat: "anthropic" } });
  await providers.switchTo("claude", first.id);
  await providers.setFailover("claude", { queue: [first.id, second.id], autoFailover: true });
  providers.markProxyCurrent = async () => { throw diskError; };
  await proxy.updateConfig({ listenPort: 0, circuitBreaker: { failureThreshold: 1 } });
  await proxy.start();

  const response = await fetch(`${proxy.origin}/claude/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": proxy.config.token },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 1 }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, "healthy");
  await waitFor(() => proxy.status().activeRequests === 0, "successful request did not settle after persistence warnings");
  assert.equal(failedCalls, 1);
  assert.equal(healthyCalls, 1);
  assert.equal(providers.current.claude, first.id, "failed current persistence must remain explicit");
  const firstBreaker = proxy.health("claude").find((item) => item.providerId === first.id);
  const secondBreaker = proxy.health("claude").find((item) => item.providerId === second.id);
  assert.equal(firstBreaker.state, "open");
  assert.equal(secondBreaker.state, "closed");
  assert.equal(secondBreaker.failures, 0);
  assert.match(proxy.status().storeStatus.runtimeWarning, /proxy-current/);
  assert.match(proxy.status().storeStatus.logsWarning, /request-log/);
  assert.equal(proxy.requestLogs().total, 0, "failed durable append must not appear as a durable in-memory log");
});

test("手动 stop 取消长期流时记录 PROXY_STOPPING，不 failover、不改变 breaker", async (t) => {
  let notifyUpstreamClosed;
  const upstreamClosed = new Promise((resolveClosed) => { notifyUpstreamClosed = resolveClosed; });
  const stream = await listen((request, response) => {
    const closed = () => notifyUpstreamClosed();
    request.once("aborted", closed);
    response.once("close", closed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"type":"content_block_delta","delta":{"text":"first"}}\n\n');
  });
  let fallbackCalls = 0;
  const fallback = await listen((request, response) => {
    fallbackCalls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  t.after(stream.close);
  t.after(fallback.close);
  const { providers, proxy } = await fixture(t);
  const first = await providers.create({ name: "Stop stream", baseUrl: stream.origin, apiKey: "a", apps: { claude: true }, models: { claude: { model: "m" } }, meta: { apiFormat: "anthropic" } });
  const second = await providers.create({ name: "Stop fallback", baseUrl: fallback.origin, apiKey: "b", apps: { claude: true }, models: { claude: { model: "m" } }, meta: { apiFormat: "anthropic" } });
  await providers.switchTo("claude", first.id);
  await providers.setFailover("claude", { queue: [first.id, second.id], autoFailover: true });
  await proxy.updateConfig({ listenPort: 0, circuitBreaker: { failureThreshold: 1 } });
  await proxy.start();

  const response = await fetch(`${proxy.origin}/claude/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": proxy.config.token },
    body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "x" }], max_tokens: 1 }),
  });
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  const stopped = await proxy.stop({ restore: false });
  await withTimeout(upstreamClosed, 1_000, "manual stop did not cancel the upstream stream");
  assert.equal(stopped.running, false);
  assert.equal(fallbackCalls, 0);
  const breaker = proxy.health("claude").find((item) => item.providerId === first.id);
  assert.equal(breaker.failures, 0);
  const cancellation = proxy.requestLogs().items[0];
  assert.equal(cancellation.cancelled, true);
  assert.equal(cancellation.errorCode, "PROXY_STOPPING");
  await reader.cancel().catch(() => {});
});

test("手动 stop 的绝对 deadline 覆盖阻塞的 stopped 事件，超时后生命周期队列可继续", async (t) => {
  let notifyStoppedEvent;
  let releaseStoppedEvent;
  const stoppedEvent = new Promise((resolveStopped) => { notifyStoppedEvent = resolveStopped; });
  const eventGate = new Promise((resolveEvent) => { releaseStoppedEvent = resolveEvent; });
  const eventStore = {
    emit(type) {
      if (type !== "ccswitch.proxy_stopped") return Promise.resolve();
      notifyStoppedEvent();
      return eventGate;
    },
  };
  const { proxy } = await fixture(t, { eventStore, shutdownTimeoutMs: 500 });
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  const stopStarted = performance.now();
  const stopping = proxy.stop({ restore: false });
  await withTimeout(stoppedEvent, 3_000, "stop did not reach the blocked lifecycle event");
  const stopped = await withTimeout(stopping, 1_000, "stop waited indefinitely for proxy_stopped");
  assert.ok(performance.now() - stopStarted < 1_000);
  assert.equal(stopped.running, false);
  assert.ok(stopped.warnings.some((item) => item.code === "PROXY_STOP_TIMEOUT"));

  const restarted = await withTimeout(proxy.start({ listenPort: 0 }), 2_000, "timed-out stop poisoned the lifecycle queue");
  assert.equal(restarted.running, true);
  releaseStoppedEvent();
});

test("手动 stop 将已提交 rename 的 deadline 信号归一为可恢复超时", async (t) => {
  let injectCommittedDeadline = false;
  const { proxy } = await fixture(t, {
    shutdownTimeoutMs: 500,
    beforeConfigPublish() {
      if (!injectCommittedDeadline) return;
      throw Object.assign(new Error("injected committed publication deadline"), {
        code: "RENAME_DEADLINE_EXCEEDED",
        renameCommitted: true,
      });
    },
  });
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  injectCommittedDeadline = true;
  const stopped = await proxy.stop({ restore: false });
  injectCommittedDeadline = false;
  assert.equal(stopped.running, false);
  assert.equal(stopped.stopped, false);
  assert.ok(stopped.warnings.some((item) => item.code === "PROXY_STOP_TIMEOUT"));

  const restarted = await proxy.start({ listenPort: 0 });
  assert.equal(restarted.running, true);
});

test("手动 stop 不吞掉未提交 rename 的 deadline 错误", async (t) => {
  let injectUncommittedDeadline = false;
  const { proxy } = await fixture(t, {
    beforeConfigPublish() {
      if (!injectUncommittedDeadline) return;
      throw Object.assign(new Error("injected pre-publication deadline"), {
        code: "RENAME_DEADLINE_EXCEEDED",
      });
    },
  });
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  injectUncommittedDeadline = true;
  await assert.rejects(
    proxy.stop({ restore: false }),
    (error) => error?.code === "RENAME_DEADLINE_EXCEEDED" && error.renameCommitted !== true,
  );
});

test("requestTimeoutMs 只取消当次上游并计入 provider failure，仍可 failover", async (t) => {
  const { providers, proxy } = await fixture(t, {
    fetchImpl: (url, options) => {
      if (String(url).startsWith("https://slow.invalid/")) {
        return new Promise((_, reject) => {
          if (options.signal.aborted) reject(options.signal.reason);
          else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ id: "fallback", type: "message", model: "m", content: [{ type: "text", text: "fallback" }], usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    },
  });
  const slow = await providers.create({ name: "Timed out", baseUrl: "https://slow.invalid", apiKey: "a", apps: { claude: true }, models: { claude: { model: "m" } }, meta: { apiFormat: "anthropic" } });
  const fallback = await providers.create({ name: "Timeout fallback", baseUrl: "https://fallback.invalid", apiKey: "b", apps: { claude: true }, models: { claude: { model: "m" } }, meta: { apiFormat: "anthropic" } });
  await providers.switchTo("claude", slow.id);
  await providers.setFailover("claude", { queue: [slow.id, fallback.id], autoFailover: true });
  await proxy.updateConfig({ listenPort: 0, requestTimeoutMs: 1_000, circuitBreaker: { failureThreshold: 1 } });
  await proxy.start();

  const response = await fetch(`${proxy.origin}/claude/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": proxy.config.token },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 1 }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, "fallback");
  const slowBreaker = proxy.health("claude").find((item) => item.providerId === slow.id);
  const fallbackBreaker = proxy.health("claude").find((item) => item.providerId === fallback.id);
  assert.equal(slowBreaker.state, "open");
  assert.equal(slowBreaker.failures, 1);
  assert.equal(fallbackBreaker.failures, 0);
});

test("early proxy rejection exposes the same request id as its audit log", async (t) => {
  const { proxy } = await fixture(t);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();

  const response = await fetch(`${proxy.origin}/claude/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer invalid-token" },
    body: "{}",
  });
  assert.equal(response.status, 401);
  const requestId = response.headers.get("x-514cc-proxy-request-id");
  assert.match(requestId, /^request-[0-9a-f-]{36}$/);
  assert.equal((await response.json()).error.code, "PROXY_UNAUTHORIZED");
  const detail = proxy.requestDetail(requestId);
  assert.equal(detail.id, requestId);
  assert.equal(detail.success, false);
  assert.equal(detail.errorCode, "PROXY_UNAUTHORIZED");
  assert.equal(proxy.status().activeRequests, 0);
});

test("early proxy rejects method, JSON and app boundaries with auditable request ids", async (t) => {
  const { proxy } = await fixture(t);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();
  const cases = [
    { label: "method", path: "/claude/v1/messages", method: "GET", body: undefined, status: 405, code: "METHOD_NOT_ALLOWED" },
    { label: "json", path: "/claude/v1/messages", method: "POST", body: "{", status: 400, code: "INVALID_JSON" },
    { label: "app", path: "/unsupported/v1/messages", method: "POST", body: "{}", status: 404, code: "UNKNOWN_PROXY_APP" },
  ];
  for (const item of cases) {
    const response = await fetch(`${proxy.origin}${item.path}`, {
      method: item.method,
      headers: { "content-type": "application/json", "x-api-key": proxy.config.token },
      ...(item.body === undefined ? {} : { body: item.body }),
    });
    assert.equal(response.status, item.status, item.label);
    const requestId = response.headers.get("x-514cc-proxy-request-id");
    assert.match(requestId, /^request-[0-9a-f-]{36}$/, item.label);
    assert.equal((await response.json()).error.code, item.code, item.label);
    const detail = proxy.requestDetail(requestId);
    assert.equal(detail.id, requestId, item.label);
    assert.equal(detail.success, false, item.label);
    assert.equal(detail.errorCode, item.code, item.label);
  }
});

test("限额在发请求前执行：0 USD 日限额直接拒绝且不触达上游", async (t) => {
  let calls = 0;
  const upstream = await listen((request, response) => {
    calls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  t.after(upstream.close);
  const { providers, proxy } = await fixture(t);
  const provider = await providers.create({ name: "Limited", baseUrl: upstream.origin, apiKey: "k", apps: { claude: true }, models: { claude: { model: "m" } }, meta: { apiFormat: "anthropic", limitDailyUsd: 0 } });
  await providers.switchTo("claude", provider.id);
  await proxy.updateConfig({ listenPort: 0 });
  await proxy.start();
  const response = await fetch(`${proxy.origin}/claude/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": proxy.config.token },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 1 }),
  });
  assert.equal(response.status, 429);
  const requestId = response.headers.get("x-514cc-proxy-request-id");
  assert.match(requestId, /^request-[0-9a-f-]{36}$/);
  assert.equal(calls, 0);
  assert.equal((await response.json()).error.code, "PROVIDER_LIMIT_REACHED");
  const detail = proxy.requestDetail(requestId);
  assert.equal(detail.id, requestId);
  assert.equal(detail.success, false);
  assert.equal(detail.errorCode, "PROVIDER_LIMIT_REACHED");
});

test("usage overview counts failures and does not drop successful request totals", async (t) => {
  const { proxy } = await fixture(t);
  const now = Date.now();
  proxy.logs.push(
    {
      id: "ok-1",
      startedAt: new Date(now - 3_600_000).toISOString(),
      success: true,
      app: "claude",
      model: "claude-sonnet",
      providerId: "prov-a",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.02,
      durationMs: 400,
    },
    {
      id: "fail-1",
      startedAt: new Date(now - 1_800_000).toISOString(),
      success: false,
      app: "claude",
      model: "claude-sonnet",
      providerId: "prov-a",
      durationMs: 1200,
    },
  );
  const summary = proxy.usageSummary({ days: 1 });
  assert.equal(summary.requests, 1);
  assert.equal(summary.failedRequests, 1);
  assert.equal(summary.totalRequests, 2);
  assert.equal(summary.tokens, 150);
  assert.equal(summary.costUsd, 0.02);
  assert.ok(Math.abs(summary.successRate - 0.5) < 1e-9);
  assert.ok(summary.avgDurationMs > 0);
  const overview = proxy.usageOverview({ days: 1 });
  assert.equal(overview.source, "ccswitch-proxy");
  assert.ok(overview.trends.length >= 20);
  assert.equal(overview.models[0].key, "claude-sonnet");
  assert.equal(overview.models[0].failed, 1);
  assert.equal(overview.logs.length, 2);
  assert.equal(overview.logs[0].id, "fail-1");
  assert.equal(overview.logs[1].inputTokens, 100);
  assert.equal(overview.logs[1].secret, undefined);
  assert.deepEqual(Object.keys(overview.logs[1]).sort(), [
    "app",
    "costUsd",
    "durationMs",
    "httpStatus",
    "id",
    "inputTokens",
    "model",
    "outputTokens",
    "providerId",
    "providerName",
    "startedAt",
    "success",
  ]);
});
