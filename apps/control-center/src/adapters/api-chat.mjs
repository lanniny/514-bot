import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { createHash, randomUUID } from "node:crypto";
import { assertHostAllowed } from "../security/egress-guard.mjs";
import { scrub } from "../redaction.mjs";
import { apiChatConfiguration, apiChatError, apiChatReadiness } from "../api-chat-config.mjs";
import { apiChatRequestMessages } from "../api-chat-history.mjs";

const PROTOCOL = "openai-chat-completions";
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const bindingSignature = (provider, model, url) => createHash("sha256")
  .update(JSON.stringify([provider.id, model, url.href, provider.apiKey])).digest("hex");

// Validate the very DNS answers used by the socket; no validation/fetch lookup gap.
function guardedLookup(host, options, callback) {
  const cb = typeof options === "function" ? options : callback;
  const opts = options && typeof options === "object" ? options : {};
  lookup(host, { all: true, verbatim: true }).then((addresses) => {
    if (!addresses.length) throw new Error("empty DNS response");
    for (const item of addresses) assertHostAllowed(item.address, { policy: "lan" });
    if (opts.all) cb(null, addresses);
    else cb(null, addresses[0].address, addresses[0].family);
  }).catch(() => cb(apiChatError("API_TARGET_BLOCKED", "无法验证模型服务地址，已停止请求")));
}

function abortable(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function usageOf(value) {
  if (!value || ![value.prompt_tokens, value.completion_tokens, value.total_tokens].every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
  return { inputTokens: value.prompt_tokens, outputTokens: value.completion_tokens, totalTokens: value.total_tokens };
}

export class ApiChatAdapter {
  id = "api-chat";
  active = new Set();
  closed = false;
  lastVerification = null;

  constructor({ profile, providerStore, eventStore }) {
    this.profile = profile;
    this.providerStore = providerStore;
    this.eventStore = eventStore;
  }

  async health({ signal } = {}) {
    signal?.throwIfAborted();
    const issue = apiChatReadiness(this.profile, this.providerStore);
    const config = issue ? null : apiChatConfiguration(this.profile, this.providerStore);
    const verified = Boolean(config && this.lastVerification
      && this.lastVerification.signature === bindingSignature(config.provider, this.profile.model, config.url)
      && Date.now() - this.lastVerification.at < 300_000);
    return { id: this.profile.id, available: !issue && !this.closed, status: issue ? "unconfigured" : verified ? "online" : "configured",
      reason: issue?.message || (verified ? "最近五分钟内收到过完整模型回答" : "文本连接配置就绪；尚未通过真实请求验证上游"), verified };
  }

  async close() {
    this.closed = true;
    for (const controller of this.active) controller.abort(apiChatError("ABORTED", "文本请求已停止"));
  }

  async send(input) {
    if (this.closed) throw apiChatError("API_ADAPTER_CLOSED", "文本连接已关闭，请刷新后重试");
    if (this.active.size >= 4) throw apiChatError("API_CAPACITY", "此文本连接已有四个请求在执行，请稍后发送");
    const { provider, url } = apiChatConfiguration({ ...this.profile, model: input.model || this.profile.model }, this.providerStore);
    if (!["plan", "read-only"].includes(input.permissionMode) || input.nativeCommand || input.effort) {
      throw apiChatError("API_CAPABILITY_UNSUPPORTED", "此连接支持文本聊天，不支持本地执行、原生命令或推理档位覆盖");
    }
    const messages = apiChatRequestMessages(input.chatMessages, input.chatSystemPrompt || "", input.chatMemoryPrompt || "");
    const key = String(provider.apiKey).trim();
    const model = input.model || this.profile.model;
    const signature = bindingSignature(provider, model, url);
    const controller = new AbortController();
    const signal = controller.signal;
    const stop = () => controller.abort(apiChatError("ABORTED", "文本请求已停止"));
    input.signal?.addEventListener("abort", stop, { once: true });
    if (input.signal?.aborted) stop();
    this.active.add(controller);
    const timer = setTimeout(() => controller.abort(apiChatError("API_TIMEOUT", "模型响应超时；请求未自动重试")), Math.min(600_000, Math.max(100, input.timeoutMs || 120_000)));
    let idleTimer;
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(apiChatError("API_IDLE_TIMEOUT", "模型长时间未返回数据；请求未自动重试")), Math.min(120_000, Math.max(100, input.idleTimeoutMs || 45_000)));
    };
    const correlationId = randomUUID();
    const meta = { runId: input.runId, agentId: input.agentId, sessionId: null, correlationId };
    const lifecycle = { protocol: PROTOCOL, sessionId: null, clientUserMessageId: correlationId, sessionResumable: false };
    const emit = (type, data) => abortable(this.eventStore?.emit(type, data, meta), signal);
    const safe = (value) => scrub(String(value).split(key).join("[REDACTED]"));
    let req;
    let response;
    let text = "";
    let emittedLength = 0;
    let lastEmit = 0;
    let usage = null;
    let submitted = false;
    let settled = false;
    let finish = null;
    let refused = false;
    let done = false;
    let effectiveModel = null;
    // Keep a possible split API key suffix out of live events.
    const publishDelta = async (force = false) => {
      if (!force && Date.now() - lastEmit < 80) return;
      let end = text.length;
      if (!force) {
        for (let n = Math.min(key.length - 1, text.length); n > 0; n--) {
          if (text.endsWith(key.slice(0, n))) { end -= n; break; }
        }
      }
      const output = safe(text.slice(0, end));
      const delta = output.slice(emittedLength);
      if (delta) await emit("assistant.delta", { delta });
      emittedLength = output.length;
      lastEmit = Date.now();
    };
    try {
      signal.throwIfAborted();
      await abortable(input.onTurnSubmitting?.(lifecycle), signal);
      signal.throwIfAborted();
      const body = JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true }, store: false });
      submitted = true;
      touch();
      response = await new Promise((resolve, reject) => {
        req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
          method: "POST", signal, agent: false, lookup: guardedLookup,
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "text/event-stream", "accept-encoding": "identity" },
        }, resolve);
        req.on("error", reject);
        req.end(body);
      });
      touch();
      if (response.statusCode !== 200) {
        settled = true;
        throw apiChatError("API_HTTP_ERROR", `模型服务返回 HTTP ${response.statusCode}；请检查连接、模型和额度`);
      }
      if (!String(response.headers["content-type"] || "").toLowerCase().startsWith("text/event-stream")) {
        throw apiChatError("API_STREAM_INVALID", "模型服务未返回预期的文本事件流");
      }
      await abortable(input.onTurnAccepted?.(lifecycle), signal);
      let buffer = "";
      let data = [];
      let eventBytes = 0;
      let bytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const dispatch = async () => {
        const payload = data.join("\n");
        data = []; eventBytes = 0;
        if (!payload) return;
        if (payload === "[DONE]") { done = true; return; }
        let chunk;
        try { chunk = JSON.parse(payload); } catch { throw apiChatError("API_STREAM_INVALID", "模型事件格式无效"); }
        if (chunk.error) throw apiChatError("API_UPSTREAM_ERROR", "模型在生成过程中返回错误；请求未自动重试");
        if (chunk.usage) usage = usageOf(chunk.usage);
        if (typeof chunk.model === "string" && chunk.model.length <= 200) effectiveModel = safe(chunk.model);
        if (!chunk.choices && chunk.usage) return;
        if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) throw apiChatError("API_STREAM_INVALID", "模型事件缺少单条回答");
        const choice = chunk.choices[0];
        if (!choice) return;
        if (choice.index !== 0 || finish !== null) throw apiChatError("API_STREAM_INVALID", "模型事件顺序无效");
        if (choice.delta?.tool_calls || choice.delta?.function_call) throw apiChatError("API_TOOLS_UNSUPPORTED", "模型返回工具请求，但此连接仅支持文本");
        if (choice.delta?.refusal) refused = true;
        if (choice.delta?.content != null) {
          if (typeof choice.delta.content !== "string") throw apiChatError("API_STREAM_INVALID", "模型返回了不支持的内容类型");
          text += choice.delta.content;
          await publishDelta();
        }
        if (choice.finish_reason != null) finish = choice.finish_reason;
      };
      for await (const bytesChunk of response) {
        signal.throwIfAborted(); touch();
        bytes += bytesChunk.length;
        if (bytes > MAX_STREAM_BYTES) throw apiChatError("API_OUTPUT_LIMIT", "模型输出超过本轮大小上限");
        buffer += decoder.decode(bytesChunk, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, boundary).replace(/\r$/, "");
          buffer = buffer.slice(boundary + 1);
          eventBytes += Buffer.byteLength(line);
          if (eventBytes > MAX_EVENT_BYTES) throw apiChatError("API_EVENT_LIMIT", "单条模型事件过大");
          if (!line) await dispatch();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          if (done) break;
        }
        if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES) throw apiChatError("API_EVENT_LIMIT", "单条模型事件过大");
        if (done) break;
      }
      if (!done || !finish) throw apiChatError("API_STREAM_TRUNCATED", "模型响应中断，未收到完整结束标记；请求未自动重试");
      settled = true;
      if (refused || finish !== "stop" || !text.trim()) throw apiChatError("API_RESPONSE_INCOMPLETE", "模型未完成文本回答，可能达到输出上限或被过滤");
      await publishDelta(true);
      await emit("assistant.message", { text: safe(text), tools: [] });
      this.lastVerification = { signature, at: Date.now() };
      return { sessionId: null, protocol: PROTOCOL, text: safe(text), tokens: usage?.totalTokens ?? null,
        usage, costUsd: null, stopReason: "stop", requestedModel: model, effectiveModel };
    } catch (cause) {
      this.lastVerification = null;
      const error = signal.aborted ? signal.reason : String(cause?.code || "").startsWith("API_") ? cause
        : apiChatError("API_CONNECTION_FAILED", "模型连接失败；请求未自动重试");
      Object.assign(error, { protocol: PROTOCOL, safeToFallback: false, submissionRejected: !submitted,
        nativeTurnSettled: settled, tokens: usage?.totalTokens ?? null, costUsd: null });
      // Preserve partial text on stop without turning it into a completed answer.
      // Persistence remains bounded even though the transport signal is aborted.
      if (text) {
        const persistence = new AbortController();
        const persistTimer = setTimeout(() => persistence.abort(), 1000);
        try { await abortable(this.eventStore?.emit("assistant.partial_message", { text: safe(text), code: error.code }, meta), persistence.signal); }
        catch {} finally { clearTimeout(persistTimer); }
      }
      throw error;
    } finally {
      clearTimeout(timer); clearTimeout(idleTimer);
      input.signal?.removeEventListener("abort", stop);
      response?.destroy(); req?.destroy();
      this.active.delete(controller);
    }
  }
}
