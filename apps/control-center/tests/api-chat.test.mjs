import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { ApiChatAdapter } from "../src/adapters/api-chat.mjs";
import { apiChatConfiguration } from "../src/api-chat-config.mjs";
import { apiChatHistory, compactHistoryMessages } from "../src/api-chat-history.mjs";
import { createAdapters, createRemoteAdapter } from "../src/adapters/index.mjs";
import { createTeamCatalog } from "../src/adapters/manifest.mjs";
import { resolve } from "node:path";

const profile = { id: "text-assistant", builtin: false, adapter: "api-chat", providerId: "provider-local-test", model: "fixture-model", enabled: true };
const delta = (content, finish_reason = null) => `data: ${JSON.stringify({ model: "fixture-model", choices: [{ index: 0, delta: { content }, finish_reason }] })}\r\n\r\n`;
const usage = 'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}\n\n';
const done = "data: [DONE]\n\n";

async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    requests.push({ path: req.url, body: JSON.parse(body), auth: req.headers.authorization });
    await handler(res, requests.at(-1));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const provider = { id: profile.providerId, name: "本地测试", baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "fixture-key-private", apps: {}, meta: {} };
  const store = { get(id) { assert.equal(id, profile.providerId); return provider; }, withProviderProjection() { throw new Error("must never project"); } };
  const events = [];
  const adapter = new ApiChatAdapter({ profile, providerStore: store, eventStore: { emit: async (type, data) => { events.push({ type, data }); } } });
  t.after(async () => { await adapter.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const send = (extra = {}) => adapter.send({ prompt: "你好", chatMessages: [{ role: "user", content: "你好" }], agentId: "text-assistant", runId: "run-1", permissionMode: "read-only", timeoutMs: 3000, ...extra });
  return { adapter, send, events, requests, provider, store };
}

test("actual HTTP stream handles split UTF-8, usage and terminal framing without CLI projection", async (t) => {
  const fx = await fixture(t, async (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const bytes = Buffer.from(delta("你好🙂", "stop") + usage + done);
    for (let i = 0; i < bytes.length; i += 3) { res.write(bytes.subarray(i, i + 3)); await new Promise(setImmediate); }
    res.end();
  });
  const lifecycle = [];
  const result = await fx.send({ onTurnSubmitting: async () => lifecycle.push("submitting"), onTurnAccepted: async () => lifecycle.push("accepted") });
  assert.equal(result.text, "你好🙂");
  assert.equal(result.sessionId, null);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 8, totalTokens: 20 });
  assert.equal(result.costUsd, null);
  assert.equal((await fx.adapter.health()).verified, true);
  fx.provider.apiKey = "different-fixture-key";
  assert.equal((await fx.adapter.health()).verified, false);
  assert.deepEqual(lifecycle, ["submitting", "accepted"]);
  assert.equal(fx.requests[0].path, "/v1/chat/completions");
  assert.equal(fx.requests[0].body.store, false);
  assert.equal(fx.requests[0].body.tools, undefined);
  assert.ok(fx.events.some((e) => e.type === "assistant.delta"));
  assert.equal(fx.events.filter((e) => e.type === "assistant.message").length, 1);
  const adapters = createAdapters({ profiles: [profile], eventStore: { emit: async () => {} }, cwd: resolve("../.."), providerStore: fx.store });
  assert.equal(adapters.get(profile.id).getProviderBinding().routeMode, "direct-api");
  assert.equal((await adapters.get(profile.id).health()).status, "configured");
  assert.equal(createTeamCatalog([profile], { providerStore: fx.store })[0].teamMemberEligible, true);
  assert.throws(() => createRemoteAdapter({ profile }), { code: "REMOTE_ADAPTER_UNSUPPORTED" });
});

for (const [name, content, code] of [
  ["truncated stream", delta("部分"), "API_STREAM_TRUNCATED"],
  ["missing finish reason", delta("部分") + done, "API_STREAM_TRUNCATED"],
  ["output limit finish", delta("部分", "length") + done, "API_RESPONSE_INCOMPLETE"],
  ["conflicting finish", delta("部分", "length") + delta("", "stop") + done, "API_STREAM_INVALID"],
  ["refusal followed by stop", 'data: {"choices":[{"index":0,"delta":{"refusal":"no","content":"partial"},"finish_reason":"stop"}]}\n\n' + done, "API_RESPONSE_INCOMPLETE"],
  ["tool request", 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{}]}}]}\n\n' + done, "API_TOOLS_UNSUPPORTED"],
  ["invalid event", "data: broken\n\n", "API_STREAM_INVALID"],
  ["overlarge event", `data: ${"a".repeat(270000)}`, "API_EVENT_LIMIT"],
]) {
  test(`${name} fails without successful answer or replay`, async (t) => {
    const fx = await fixture(t, async (res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(content); });
    await assert.rejects(fx.send(), { code, safeToFallback: false });
    assert.equal(fx.requests.length, 1);
    assert.ok(!fx.events.some((e) => e.type === "assistant.message"));
  });
}

test("HTTP error and redirects neither expose body/key nor follow/retry", async (t) => {
  const fx = await fixture(t, async (res) => { res.writeHead(307, { location: "http://169.254.169.254/" }); res.end("fixture-key-private internal trace"); });
  await assert.rejects(fx.send(), (error) => {
    assert.equal(error.code, "API_HTTP_ERROR");
    assert.equal(error.nativeTurnSettled, true);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /fixture-key|internal trace|169\.254/);
    return true;
  });
  assert.equal(fx.requests.length, 1);
});

test("cancel, idle timeout, close and lifecycle timeout settle locally", async (t) => {
  const fx = await fixture(t, async (res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(delta("正在生成")); });
  const controller = new AbortController();
  await assert.rejects(fx.send({ signal: controller.signal, onTurnAccepted: () => controller.abort() }), { code: "ABORTED" });
  await assert.rejects(fx.send({ idleTimeoutMs: 100 }), { code: "API_IDLE_TIMEOUT" });
  await assert.rejects(fx.send({ timeoutMs: 100, onTurnSubmitting: () => new Promise(() => {}) }), { code: "API_TIMEOUT", submissionRejected: true });
  await assert.rejects(fx.send({ onTurnAccepted: () => fx.adapter.close() }), { code: "ABORTED" });
  assert.equal(fx.adapter.active.size, 0);
  assert.equal(fx.requests.length, 3);
});

test("key echoed across separate deltas stays out of events and answer", async (t) => {
  const fx = await fixture(t, async (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(delta("hello fixture-key-"));
    await new Promise((r) => setTimeout(r, 100));
    res.end(delta("private done", "stop") + done);
  });
  const result = await fx.send();
  assert.equal(result.text, "hello [REDACTED] done");
  assert.doesNotMatch(JSON.stringify(fx.events), /fixture-key/);
});

test("missing/mismatched connection fails closed with no native authentication fallback", () => {
  const provider = { apiKey: "fixture", baseUrl: "https://model.example/v1", meta: {} };
  const store = { get: () => provider };
  assert.throws(() => apiChatConfiguration({ ...profile, providerId: null }, store), { code: "API_PROVIDER_REQUIRED" });
  assert.throws(() => apiChatConfiguration(profile, { get() { throw new Error("private details"); } }), { code: "API_PROVIDER_MISSING" });
  assert.throws(() => apiChatConfiguration({ ...profile, model: null }, store), { code: "API_MODEL_REQUIRED" });
  for (const baseUrl of ["http://remote.example/v1", "https://user:secret@example.com", "http://169.254.169.254", "https://model.example?key=secret"]) {
    assert.throws(() => apiChatConfiguration(profile, { get: () => ({ ...provider, baseUrl }) }), { code: "API_ENDPOINT_INVALID" });
  }
  assert.throws(() => apiChatConfiguration(profile, { get: () => ({ ...provider, meta: { apiFormat: "anthropic" } }) }), { code: "API_PROTOCOL_UNSUPPORTED" });
  for (const apiFormat of ["openai-compatible", "openai_compatible", "chat_completions", "openai_chat"]) {
    assert.equal(apiChatConfiguration(profile, { get: () => ({ ...provider, meta: { apiFormat } }) }).provider.meta.apiFormat, apiFormat);
  }
  const unavailable = createTeamCatalog([profile], { providerStore: null })[0];
  assert.equal(unavailable.teamMemberEligible, false);
  assert.equal(unavailable.eligibilityReason, "API_PROVIDER_MISSING");
});

test("context follows persisted direct identity and excludes failed turns/other members", () => {
  const conversation = { id: "c", kind: "direct", directMemberId: "a", runIds: ["r1", "r2"] };
  const turn = { agentId: "a", outcome: "completed", protocol: "openai-chat-completions", chatUserText: "记住蓝色", text: "已记住" };
  const prior = { id: "r1", conversationId: "c", conversationKind: "direct", turns: [turn, { ...turn, outcome: "incomplete", text: "partial" }, { ...turn, agentId: "other", text: "private" }] };
  const run = { id: "r2", conversationId: "c", conversationKind: "direct", turns: [] };
  // Serialize/readback models a restart: no adapter-local history is retained.
  const runs = new Map(JSON.parse(JSON.stringify([["r1", prior], ["r2", run]])));
  const args = { conversation, run, runs, agentId: "a", prompt: "是什么颜色" };
  assert.deepEqual(apiChatHistory(args).map((m) => m.content), ["记住蓝色", "已记住", "是什么颜色"]);
  assert.throws(() => apiChatHistory({ ...args, agentId: "other" }), { code: "API_CHAT_DIRECT_ONLY" });
  runs.get("r1").conversationId = "private-conversation";
  assert.throws(() => apiChatHistory(args), { code: "API_HISTORY_UNAVAILABLE" });
  runs.set("r1", prior);
  assert.throws(() => apiChatHistory({ ...args, prompt: "a".repeat(140000) }), { code: "API_CONTEXT_LIMIT" });
});

test("context gracefully tolerates cleared historical runs and respects branched conversation lineage", () => {
  const conversation = { id: "c-branch", kind: "direct", directMemberId: "a", runIds: ["r-cleared", "r-ancestor", "r-new"], sourceConversationId: "c-origin" };
  const turn = { agentId: "a", outcome: "completed", protocol: "openai-chat-completions", chatUserText: "源头问题", text: "源头回答" };
  const ancestorRun = { id: "r-ancestor", conversationId: "c-origin", conversationKind: "direct", turns: [turn] };
  const newRun = { id: "r-new", conversationId: "c-branch", conversationKind: "direct", turns: [] };
  // "r-cleared" is absent from the runs map, simulating orchestrator.clearFinished()
  const runs = new Map([["r-ancestor", ancestorRun], ["r-new", newRun]]);
  const args = { conversation, run: newRun, runs, agentId: "a", prompt: "分支追问" };
  const history = apiChatHistory(args);
  assert.deepEqual(history.map((m) => m.content), ["源头问题", "源头回答", "分支追问"]);
});

test("usage chunk without choices array is handled gracefully in event stream", async (t) => {
  const fx = await fixture(t, async (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(delta("回答内容", "stop") + 'data: {"usage":{"prompt_tokens":5,"completion_tokens":5,"total_tokens":10}}\n\n' + done);
  });
  const result = await fx.send();
  assert.equal(result.text, "回答内容");
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 5, totalTokens: 10 });
});

test("compactHistoryMessages slides window to keep paired turns within count and byte limits", () => {
  // 100 historical messages (50 turns of Q&A) + 1 current prompt = 101 messages
  const manyMessages = [];
  for (let i = 0; i < 50; i++) {
    manyMessages.push({ role: "user", content: `第 ${i + 1} 问` }, { role: "assistant", content: `第 ${i + 1} 答` });
  }
  manyMessages.push({ role: "user", content: "最新提问" });

  const compacted = compactHistoryMessages([...manyMessages], 112 * 1024, 80);
  assert.ok(compacted.length <= 80);
  // Preserves sequence: user, assistant, user, assistant, ... user
  assert.equal(compacted[0].role, "user");
  assert.equal(compacted[1].role, "assistant");
  assert.equal(compacted[compacted.length - 1].content, "最新提问");
  // Total turns is 39 historical turns (78 msgs) + 1 prompt = 79 messages
  assert.equal(compacted.length, 79);
  assert.equal(compacted[0].content, "第 12 问");

  // Single prompt exceeding maxBytes fails closed
  assert.throws(() => compactHistoryMessages([{ role: "user", content: "x".repeat(120000) }], 100000), { code: "API_CONTEXT_LIMIT" });
});
