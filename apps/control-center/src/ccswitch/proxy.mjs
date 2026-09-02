import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PROVIDER_APPS, codexBaseUrl } from "../providers.mjs";
import { renameSyncWithRetry } from "../atomic-rename.mjs";
import {
  configureUpstreamProxy,
  normalizeUpstreamProxyUrl,
  scanLocalProxies,
  testUpstreamProxy,
  upstreamProxyStatus,
} from "./upstream-proxy.mjs";

const LOOPBACKS = new Set(["127.0.0.1", "::1", "localhost"]);
const FAILURE_STATUSES = new Set([401, 403, 408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_LOGS_IN_MEMORY = 20_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

function fail(message, code, httpStatus = 400) {
  throw Object.assign(new Error(message), { code, httpStatus });
}

function cancellationError(message, code) {
  return Object.assign(new Error(message), { name: "AbortError", code, httpStatus: 499 });
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : cancellationError("proxy request aborted", "ABORTED");
}

function closedError(deadline = null) {
  const error = Object.assign(new Error("proxy service is closing or closed"), { code: "PROXY_CLOSED", httpStatus: 409 });
  if (Number.isFinite(Number(deadline))) error.deadline = Number(deadline);
  return error;
}

async function settleBefore(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    void Promise.resolve(promise).catch(() => {});
    return { settled: false, value: undefined, error: null };
  }
  let timer = null;
  const completion = Promise.resolve(promise).then(
    (value) => ({ settled: true, value, error: null }),
    (error) => ({ settled: true, value: undefined, error }),
  );
  try {
    return await Promise.race([
      completion,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ settled: false, value: undefined, error: null }), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cleanInt(value, min, max, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${label} must be a number`, "VALIDATION_FAILED");
  return Math.max(min, Math.min(max, Math.round(number)));
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function inUsageWindow(entry, { app = null, since = 0 } = {}) {
  if (app && entry.app !== app) return false;
  const started = Date.parse(entry.startedAt);
  return Number.isFinite(started) && started >= since;
}

function addUsageTotals(totals, entry) {
  if (entry.success) {
    totals.requests += 1;
    totals.inputTokens += Number(entry.inputTokens) || 0;
    totals.outputTokens += Number(entry.outputTokens) || 0;
    totals.costUsd += Number(entry.costUsd) || 0;
  } else {
    totals.failed += 1;
  }
  const duration = Number(entry.durationMs);
  if (Number.isFinite(duration) && duration >= 0) {
    totals.durationMs += duration;
    totals.durationCount += 1;
  }
  return totals;
}

function finalizeUsageSummary(totals, { windowDays, since }) {
  const totalRequests = totals.requests + totals.failed;
  const tokens = totals.inputTokens + totals.outputTokens;
  const windowMinutes = Math.max(1, (Date.now() - since) / 60_000);
  const avgDurationMs = totals.durationCount ? totals.durationMs / totals.durationCount : null;
  const durationSeconds = totals.durationMs / 1000;
  return {
    requests: totals.requests,
    failedRequests: totals.failed,
    totalRequests,
    successRate: totalRequests ? totals.requests / totalRequests : null,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    tokens,
    costUsd: totals.costUsd,
    avgDurationMs,
    windowDays,
    windowMinutes,
    rpm: totals.requests / windowMinutes,
    tpm: tokens / windowMinutes,
    throughputTps: durationSeconds > 0 ? totals.outputTokens / durationSeconds : null,
  };
}

function usageBucketKey(startedAt, grain) {
  const iso = String(startedAt || "");
  return grain === "hour" ? iso.slice(0, 13) : iso.slice(0, 10);
}

function publicUsageLog(entry) {
  return {
    id: entry.id,
    startedAt: entry.startedAt,
    app: entry.app || null,
    providerId: entry.providerId || null,
    providerName: entry.providerName || entry.providerId || null,
    model: entry.model || null,
    inputTokens: Number(entry.inputTokens) || 0,
    outputTokens: Number(entry.outputTokens) || 0,
    costUsd: Number(entry.costUsd) || 0,
    success: Boolean(entry.success),
    httpStatus: entry.httpStatus ?? null,
    durationMs: Number.isFinite(Number(entry.durationMs)) ? Number(entry.durationMs) : null,
  };
}

function emptyTrendBucket(key, grain) {
  const bucket = {
    key,
    day: key.slice(0, 10),
    requests: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    models: {},
  };
  if (grain === "hour") bucket.hour = Number(key.slice(11, 13));
  return bucket;
}

function defaultConfig() {
  return {
    listenAddress: "127.0.0.1",
    listenPort: 15721,
    token: randomBytes(32).toString("base64url"),
    requestTimeoutMs: 120_000,
    upstreamProxyUrl: null,
    circuitBreaker: {
      failureThreshold: 3,
      cooldownMs: 30_000,
      successThreshold: 1,
    },
    takeover: Object.fromEntries(PROVIDER_APPS.map((app) => [app, false])),
    pricing: {},
  };
}

function maskToken(token) {
  const value = String(token ?? "");
  return value ? `••••${value.slice(-4)}` : "";
}

function appProtocol(provider, app) {
  const config = provider.meta?.appConfig?.[app] ?? {};
  const settings = config.settingsConfig ?? {};
  const raw = String(
    provider.meta?.apiFormat
      || config.apiFormat
      || settings.api
      || settings.api_mode
      || settings.apiMode
      || "",
  ).toLowerCase();
  if (raw.includes("gemini")) return "gemini";
  if (raw.includes("anthropic")) return "anthropic";
  if (raw.includes("responses")) return "openai-responses";
  if (raw.includes("chat") || raw.includes("completions")) return "openai-chat";
  if (app === "gemini") return "gemini";
  if (app === "claude" || app === "claude-desktop") return "anthropic";
  if (app === "grokbuild") return "openai-responses";
  return "openai-chat";
}

function pathProtocol(pathname, app) {
  const path = pathname.toLowerCase();
  if (path.includes("/messages")) return "anthropic";
  if (path.includes("/chat/completions")) return "openai-chat";
  if (path.includes("/responses")) return "openai-responses";
  if (path.includes("/v1beta/") || path.includes(":generatecontent")) return "gemini";
  if (app === "gemini") return "gemini";
  if (app === "claude" || app === "claude-desktop") return "anthropic";
  if (app === "codex" || app === "grokbuild") return "openai-responses";
  return "openai-chat";
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => typeof part === "string" ? part : part?.text ?? part?.content ?? "")
    .filter(Boolean)
    .join("\n");
}

function normalizeRequest(body, protocol) {
  if (protocol === "anthropic") {
    return {
      model: body.model,
      system: textFromContent(body.system),
      messages: (body.messages ?? []).map((item) => ({ role: item.role, content: textFromContent(item.content) })),
      maxTokens: body.max_tokens,
      stream: Boolean(body.stream),
      temperature: body.temperature,
    };
  }
  if (protocol === "openai-chat") {
    const messages = body.messages ?? [];
    return {
      model: body.model,
      system: messages.filter((item) => item.role === "system").map((item) => textFromContent(item.content)).join("\n"),
      messages: messages.filter((item) => item.role !== "system").map((item) => ({ role: item.role, content: textFromContent(item.content) })),
      maxTokens: body.max_tokens ?? body.max_completion_tokens,
      stream: Boolean(body.stream),
      temperature: body.temperature,
    };
  }
  if (protocol === "openai-responses") {
    const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : (body.input ?? []);
    return {
      model: body.model,
      system: body.instructions ?? "",
      messages: input.map((item) => ({ role: item.role ?? "user", content: textFromContent(item.content ?? item) })),
      maxTokens: body.max_output_tokens,
      stream: Boolean(body.stream),
      temperature: body.temperature,
    };
  }
  const contents = body.contents ?? [];
  return {
    model: body.model,
    system: textFromContent(body.systemInstruction?.parts),
    messages: contents.map((item) => ({ role: item.role === "model" ? "assistant" : "user", content: textFromContent(item.parts) })),
    maxTokens: body.generationConfig?.maxOutputTokens,
    stream: String(body.alt ?? "").toLowerCase() === "sse" || Boolean(body.stream),
    temperature: body.generationConfig?.temperature,
  };
}

function convertRequest(body, from, to, fallbackModel) {
  if (from === to) return { ...body, model: body.model || fallbackModel };
  const request = normalizeRequest(body, from);
  const model = request.model || fallbackModel;
  if (!model) fail("proxy request has no model and the provider has no default model", "MODEL_REQUIRED", 422);
  if (to === "anthropic") {
    return {
      model,
      ...(request.system ? { system: request.system } : {}),
      messages: request.messages,
      max_tokens: request.maxTokens || 1024,
      stream: request.stream,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
  }
  if (to === "openai-chat") {
    return {
      model,
      messages: [...(request.system ? [{ role: "system", content: request.system }] : []), ...request.messages],
      max_tokens: request.maxTokens || 1024,
      stream: request.stream,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
  }
  if (to === "openai-responses") {
    return {
      model,
      ...(request.system ? { instructions: request.system } : {}),
      input: request.messages,
      max_output_tokens: request.maxTokens || 1024,
      stream: request.stream,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
  }
  return {
    contents: request.messages.map((item) => ({ role: item.role === "assistant" ? "model" : "user", parts: [{ text: item.content }] })),
    ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
    generationConfig: {
      maxOutputTokens: request.maxTokens || 1024,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    },
  };
}

function extractResponse(payload, protocol) {
  if (protocol === "anthropic") {
    return {
      text: textFromContent(payload.content),
      model: payload.model,
      stopReason: payload.stop_reason,
      inputTokens: Number(payload.usage?.input_tokens) || 0,
      outputTokens: Number(payload.usage?.output_tokens) || 0,
    };
  }
  if (protocol === "openai-chat") {
    return {
      text: textFromContent(payload.choices?.[0]?.message?.content),
      model: payload.model,
      stopReason: payload.choices?.[0]?.finish_reason,
      inputTokens: Number(payload.usage?.prompt_tokens) || 0,
      outputTokens: Number(payload.usage?.completion_tokens) || 0,
    };
  }
  if (protocol === "openai-responses") {
    const output = payload.output_text
      ?? payload.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("")
      ?? "";
    return {
      text: output,
      model: payload.model,
      stopReason: payload.status === "completed" ? "stop" : payload.status,
      inputTokens: Number(payload.usage?.input_tokens) || 0,
      outputTokens: Number(payload.usage?.output_tokens) || 0,
    };
  }
  return {
    text: payload.candidates?.[0]?.content?.parts?.map((item) => item.text ?? "").join("") ?? "",
    model: payload.modelVersion,
    stopReason: payload.candidates?.[0]?.finishReason,
    inputTokens: Number(payload.usageMetadata?.promptTokenCount) || 0,
    outputTokens: Number(payload.usageMetadata?.candidatesTokenCount) || 0,
  };
}

function convertResponse(payload, from, to, requestBody) {
  if (from === to) return payload;
  const result = extractResponse(payload, from);
  const id = payload.id || `proxy-${randomUUID()}`;
  const model = result.model || requestBody.model || "unknown";
  if (to === "anthropic") {
    return {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: result.text }],
      stop_reason: result.stopReason || "end_turn",
      stop_sequence: null,
      usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
    };
  }
  if (to === "openai-chat") {
    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: result.stopReason || "stop" }],
      usage: { prompt_tokens: result.inputTokens, completion_tokens: result.outputTokens, total_tokens: result.inputTokens + result.outputTokens },
    };
  }
  if (to === "openai-responses") {
    return {
      id,
      object: "response",
      status: "completed",
      model,
      output_text: result.text,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: result.text }] }],
      usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens, total_tokens: result.inputTokens + result.outputTokens },
    };
  }
  return {
    candidates: [{ content: { role: "model", parts: [{ text: result.text }] }, finishReason: result.stopReason || "STOP" }],
    usageMetadata: { promptTokenCount: result.inputTokens, candidatesTokenCount: result.outputTokens, totalTokenCount: result.inputTokens + result.outputTokens },
    modelVersion: model,
  };
}

function streamDelta(payload, protocol) {
  if (protocol === "openai-chat") return payload.choices?.[0]?.delta?.content ?? "";
  if (protocol === "openai-responses") return payload.delta ?? (payload.type === "response.output_text.delta" ? payload.delta : "");
  if (protocol === "anthropic") return payload.delta?.text ?? "";
  return payload.candidates?.[0]?.content?.parts?.map((item) => item.text ?? "").join("") ?? "";
}

function encodeStreamDelta(text, protocol, model) {
  if (!text) return "";
  if (protocol === "anthropic") {
    return `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`;
  }
  if (protocol === "openai-chat") {
    return `data: ${JSON.stringify({ id: `proxy-${Date.now()}`, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
  }
  if (protocol === "openai-responses") {
    return `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`;
  }
  return `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] } }] })}\n\n`;
}

function modelOf(provider, app, requestBody) {
  return requestBody.model
    || provider.models?.[app]?.model
    || provider.models?.claude?.model
    || provider.meta?.appConfig?.[app]?.settingsConfig?.models?.[0]?.id
    || Object.keys(provider.meta?.appConfig?.[app]?.settingsConfig?.models ?? {})[0]
    || null;
}

function targetUrl(provider, app, protocol, model) {
  const configured = String(provider.baseUrl ?? "").trim();
  if (app === "codex" && provider.meta?.isFullUrl) {
    if (!configured) fail(`provider ${provider.name} has no baseUrl`, "PROVIDER_BASE_URL_MISSING", 422);
    return configured;
  }
  const base = configured.replace(/\/+$/, "");
  if (!base) fail(`provider ${provider.name} has no baseUrl`, "PROVIDER_BASE_URL_MISSING", 422);
  if (protocol === "anthropic") return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  if (protocol === "openai-chat") return `${codexBaseUrl(base)}/chat/completions`;
  if (protocol === "openai-responses") return `${codexBaseUrl(base)}/responses`;
  return `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(provider.apiKey || "")}`;
}

function targetHeaders(provider, protocol) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (protocol === "anthropic") {
    headers["x-api-key"] = provider.apiKey || "";
    headers.authorization = `Bearer ${provider.apiKey || ""}`;
    headers["anthropic-version"] = "2023-06-01";
  } else if (protocol !== "gemini") headers.authorization = `Bearer ${provider.apiKey || ""}`;
  // 档案级代理覆盖（meta.proxyOverrides）：UA 与自定义 Header——认证/协议头校验期已禁覆，这里直接信任
  const overrides = provider.meta?.proxyOverrides;
  if (overrides?.userAgent) headers["user-agent"] = overrides.userAgent;
  for (const [key, value] of Object.entries(overrides?.headers ?? {})) headers[key] = value;
  return headers;
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) fail("proxy request body is too large", "BODY_TOO_LARGE", 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("proxy request body must be JSON", "INVALID_JSON", 400);
  }
}

export class CcSwitchProxyService {
  constructor({
    dataRoot,
    providerStore,
    eventStore = null,
    fetchImpl = fetch,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    requestLogAppend = appendFile,
    beforeConfigPublish = null,
  }) {
    this.dataRoot = dataRoot;
    this.providerStore = providerStore;
    this.eventStore = eventStore;
    this.fetchImpl = fetchImpl;
    this.requestLogAppend = requestLogAppend;
    this.beforeConfigPublish = typeof beforeConfigPublish === "function" ? beforeConfigPublish : null;
    this.path = join(dataRoot, "ccswitch-proxy.json");
    this.logsPath = join(dataRoot, "ccswitch-request-logs.jsonl");
    this.config = defaultConfig();
    this.storeStatus = { state: "missing", message: null };
    this.logs = [];
    this.breakers = new Map();
    this.server = null;
    this.startingServer = null;
    this.origin = null;
    this.activeRequests = 0;
    this.requestTasks = new Set();
    this.requestControllers = new Set();
    this.shutdownTimeoutMs = Number.isFinite(Number(shutdownTimeoutMs))
      ? Math.max(10, Math.round(Number(shutdownTimeoutMs)))
      : DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.acceptRequestLogs = true;
    this.closing = false;
    this.closed = false;
    this.closePromise = null;
    this.#queue = Promise.resolve();
    this.#logQueue = Promise.resolve();
    this.#lifecycleGeneration = 0;
    this.#lifecycleController = new AbortController();
  }

  #queue;
  #logQueue;
  #lifecycleGeneration;
  #lifecycleController;

  #serialize(task, { allowClosing = false, allowBlocked = false } = {}) {
    if (!allowClosing && (this.closing || this.closed)) return Promise.reject(closedError());
    const run = () => {
      if (!allowClosing && (this.closing || this.closed)) throw closedError();
      if (!allowBlocked && this.storeStatus.state === "blocked") fail(`proxy store is blocked: ${this.storeStatus.message}`, "PROXY_STORE_BLOCKED", 503);
      return task();
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }

  #assertOpen() {
    if (this.closing || this.closed) throw closedError();
  }

  #lifecycleToken() {
    return {
      generation: this.#lifecycleGeneration,
      controller: this.#lifecycleController,
    };
  }

  #assertLifecycle(lifecycle) {
    if (lifecycle?.controller?.signal.aborted) throw abortReason(lifecycle.controller.signal);
    if (lifecycle && lifecycle.generation !== this.#lifecycleGeneration) throw closedError();
    this.#assertOpen();
  }

  #rotateLifecycle(reason) {
    if (!this.#lifecycleController.signal.aborted) this.#lifecycleController.abort(reason);
    this.#lifecycleGeneration += 1;
    this.#lifecycleController = new AbortController();
    return this.#lifecycleToken();
  }

  #abortLifecycle(lifecycle, reason, { renew = false } = {}) {
    if (!lifecycle?.controller.signal.aborted) lifecycle.controller.abort(reason);
    if (renew && lifecycle.generation === this.#lifecycleGeneration && lifecycle.controller === this.#lifecycleController) {
      this.#lifecycleGeneration += 1;
      this.#lifecycleController = new AbortController();
    }
  }

  async #awaitLifecycle(operation, lifecycle, { isCommitted = null } = {}) {
    this.#assertLifecycle(lifecycle);
    const signal = lifecycle.controller.signal;
    const promise = operation();
    const committed = () => Boolean(isCommitted?.());
    let onAbort = null;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => {
        if (!committed()) reject(abortReason(signal));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const value = await Promise.race([Promise.resolve(promise), cancelled]);
      if (!committed()) this.#assertLifecycle(lifecycle);
      return value;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async init() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("proxy settings root is invalid", "PROXY_STORE_CORRUPT");
      this.config = this.#validateConfig({ ...this.config, ...parsed, circuitBreaker: { ...this.config.circuitBreaker, ...(parsed.circuitBreaker ?? {}) } });
      this.storeStatus = { state: "ready", message: null };
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.storeStatus = { state: "missing", message: null };
        await mkdir(this.dataRoot, { recursive: true });
        await this.#commit();
      } else {
        this.storeStatus = { state: "blocked", message: String(error.message || error).slice(0, 300) };
      }
    }
    try {
      const raw = await readFile(this.logsPath, "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean).slice(-MAX_LOGS_IN_MEMORY);
      this.logs = lines.flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    } catch (error) {
      if (error?.code !== "ENOENT") this.storeStatus.logsWarning = String(error.message || error).slice(0, 200);
    }
    if (this.storeStatus.state !== "blocked") {
      try {
        await configureUpstreamProxy(this.config.upstreamProxyUrl);
      } catch (error) {
        this.storeStatus = { state: "blocked", message: `failed to apply upstream proxy: ${String(error.message || error).slice(0, 240)}` };
      }
    }
    this.providerStore.configureLocalProxy({ origin: `http://${this.config.listenAddress}:${this.config.listenPort}`, token: this.config.token });
    return this;
  }

  #validateConfig(input) {
    const listenAddress = String(input.listenAddress ?? "127.0.0.1").trim();
    if (!LOOPBACKS.has(listenAddress)) fail("local proxy may only bind a loopback address", "VALIDATION_FAILED");
    const takeover = Object.fromEntries(PROVIDER_APPS.map((app) => [app, Boolean(input.takeover?.[app])]));
    const pricing = {};
    for (const [model, value] of Object.entries(input.pricing ?? {})) {
      if (!model || model.length > 160 || !value || typeof value !== "object") continue;
      const inputPerMillion = Number(value.inputPerMillion ?? 0);
      const outputPerMillion = Number(value.outputPerMillion ?? 0);
      if (![inputPerMillion, outputPerMillion].every((number) => Number.isFinite(number) && number >= 0 && number <= 1_000_000)) continue;
      pricing[model] = { inputPerMillion, outputPerMillion };
    }
    return {
      listenAddress,
      listenPort: cleanInt(input.listenPort, 0, 65535, 15721, "listenPort"),
      token: String(input.token || this.config?.token || randomBytes(32).toString("base64url")).slice(0, 300),
      requestTimeoutMs: cleanInt(input.requestTimeoutMs, 1_000, 600_000, 120_000, "requestTimeoutMs"),
      upstreamProxyUrl: normalizeUpstreamProxyUrl(input.upstreamProxyUrl),
      circuitBreaker: {
        failureThreshold: cleanInt(input.circuitBreaker?.failureThreshold, 1, 20, 3, "failureThreshold"),
        cooldownMs: cleanInt(input.circuitBreaker?.cooldownMs, 1_000, 3_600_000, 30_000, "cooldownMs"),
        successThreshold: cleanInt(input.circuitBreaker?.successThreshold, 1, 20, 1, "successThreshold"),
      },
      takeover,
      pricing,
    };
  }

  #lifecycleDeadline(lifecycle) {
    const candidates = [
      Number(lifecycle?.deadline),
      Number(lifecycle?.controller?.signal?.reason?.deadline),
    ].filter(Number.isFinite);
    return candidates.length ? Math.min(...candidates) : Infinity;
  }

  #serializedConfig(config) {
    return `${JSON.stringify(config, null, 2)}\n`;
  }

  #takeoverSidecar(config) {
    return [{ target: this.path, content: this.#serializedConfig(config) }];
  }

  #providerFailureDetail(error) {
    const detail = [String(error?.message || error)];
    if (Array.isArray(error?.rollbackErrors) && error.rollbackErrors.length) {
      detail.push(`rollback: ${error.rollbackErrors.join("; ")}`);
    }
    return detail.join(" | ");
  }

  #emitProviderTakeover(app, enabled, providerId) {
    if (!this.eventStore) return;
    try {
      // 内存、live 与 sidecar 已一起提交后才允许外部 sink 重入；事件本身不占生命周期队列。
      void Promise.resolve(
        this.eventStore.emit("provider.proxy_takeover", { app, enabled, providerId }),
      ).catch(() => {});
    } catch {}
  }

  #writeConfigSync(config, { deadline = Infinity } = {}) {
    const absoluteDeadline = Number(typeof deadline === "function" ? deadline() : deadline);
    if (Number.isFinite(absoluteDeadline) && Date.now() >= absoluteDeadline) {
      throw Object.assign(new Error("proxy config publication deadline expired"), {
        code: "PROXY_CONFIG_PERSIST_TIMEOUT",
      });
    }
    const temp = join(this.dataRoot, `.ccswitch-proxy.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, this.#serializedConfig(config), { encoding: "utf8", mode: 0o600 });
      renameSyncWithRetry(temp, this.path, { deadline });
      this.storeStatus = { state: "ready", message: null };
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch {}
      throw error;
    }
  }

  async #commit(lifecycle = null, config = this.config) {
    if (lifecycle) this.#assertLifecycle(lifecycle);
    const temp = join(this.dataRoot, `.ccswitch-proxy.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, this.#serializedConfig(config), { encoding: "utf8", mode: 0o600 });
      if (lifecycle) this.#assertLifecycle(lifecycle);
      if (lifecycle) {
        this.beforeConfigPublish?.({ operation: "rename", target: this.path, temp });
        this.#assertLifecycle(lifecycle);
        renameSyncWithRetry(temp, this.path, { deadline: () => this.#lifecycleDeadline(lifecycle) });
        this.#assertLifecycle(lifecycle);
      } else {
        await rename(temp, this.path);
      }
      this.storeStatus = { state: "ready", message: null };
    } catch (error) {
      if (lifecycle) {
        try { rmSync(temp, { force: true }); } catch {}
      }
      else await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  status() {
    return {
      running: Boolean(this.server),
      closing: this.closing,
      closed: this.closed,
      origin: this.origin,
      listenAddress: this.config.listenAddress,
      listenPort: this.config.listenPort,
      tokenMasked: maskToken(this.config.token),
      takeover: { ...this.config.takeover },
      circuitBreaker: { ...this.config.circuitBreaker },
      activeRequests: this.activeRequests,
      requestLogCount: this.logs.length,
      upstreamProxy: upstreamProxyStatus(),
      storeStatus: { ...this.storeStatus },
    };
  }

  async start(input = {}) {
    const lifecycle = this.#lifecycleToken();
    return this.#serialize(async () => {
      this.#assertLifecycle(lifecycle);
      if (this.server) return this.status();
      this.config = this.#validateConfig({ ...this.config, ...input });
      const server = createServer((request, response) => {
        const controller = new AbortController();
        const abortClientRequest = () => {
          if (!controller.signal.aborted) {
            controller.abort(cancellationError("proxy client connection closed", "CLIENT_DISCONNECTED"));
          }
        };
        const abortClientResponse = () => {
          if (!response.writableEnded) abortClientRequest();
        };
        request.once("aborted", abortClientRequest);
        response.once("close", abortClientResponse);
        this.requestControllers.add(controller);
        const task = this.#handle(request, response, controller.signal).catch((error) => {
          try {
            if (controller.signal.aborted || response.destroyed) {
              if (!response.destroyed) response.destroy();
              return;
            }
            if (response.headersSent) {
              response.destroy(error);
              return;
            }
            response.writeHead(error.httpStatus || 502, { "content-type": "application/json; charset=utf-8" });
            response.end(JSON.stringify({ error: { code: error.code || "PROXY_ERROR", message: error.message } }));
          } catch {
            if (!response.destroyed) response.destroy();
          }
        }).finally(() => {
          request.off("aborted", abortClientRequest);
          response.off("close", abortClientResponse);
          this.requestControllers.delete(controller);
          this.requestTasks.delete(task);
        });
        this.requestTasks.add(task);
      });
      this.startingServer = server;
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(this.config.listenPort, this.config.listenAddress, () => {
            server.off("error", reject);
            resolve();
          });
        });
      } catch (error) {
        if (this.startingServer === server) this.startingServer = null;
        throw error;
      }
      if (this.startingServer === server) this.startingServer = null;
      if (this.closing || this.closed) {
        await this.#closeServer(server, Date.now() + this.shutdownTimeoutMs, []);
        throw closedError();
      }
      this.server = server;
      const address = server.address();
      const host = this.config.listenAddress === "::1" ? "[::1]" : this.config.listenAddress;
      this.config.listenPort = typeof address === "object" && address ? address.port : this.config.listenPort;
      this.origin = `http://${host}:${this.config.listenPort}`;
      this.providerStore.configureLocalProxy({ origin: this.origin, token: this.config.token });
      const warnings = [];
      for (const app of PROVIDER_APPS) {
        if (!this.config.takeover[app]) continue;
        let committed = false;
        try {
          const result = await this.#awaitLifecycle(
            () => this.providerStore.setProxyTakeover(app, true, {
              signal: lifecycle.controller.signal,
              deadline: () => this.#lifecycleDeadline(lifecycle),
              onCommitted: () => { committed = true; },
            }),
            lifecycle,
            { isCommitted: () => committed },
          );
          this.#emitProviderTakeover(app, true, result.providerId);
        }
        catch (error) {
          if (["PROXY_CLOSED", "PROXY_STOPPING", "PROXY_STOP_TIMEOUT"].includes(error?.code)) throw error;
          this.config.takeover[app] = false;
          warnings.push({ app, error: error.message });
        }
      }
      await this.#commit(lifecycle);
      await this.#awaitLifecycle(
        () => this.eventStore?.emit("ccswitch.proxy_started", { origin: this.origin, warnings }).catch(() => {}),
        lifecycle,
      );
      return { ...this.status(), warnings };
    });
  }

  async stop({ restore = true } = {}) {
    this.#assertOpen();
    const deadline = Date.now() + this.shutdownTimeoutMs;
    const warnings = [];
    const stoppingError = cancellationError("proxy lifecycle was superseded by stop", "PROXY_STOPPING");
    stoppingError.deadline = deadline;
    const lifecycle = this.#rotateLifecycle(stoppingError);
    lifecycle.deadline = deadline;
    const timeoutError = cancellationError(
      `proxy stop exceeded ${this.shutdownTimeoutMs}ms`,
      "PROXY_STOP_TIMEOUT",
    );
    timeoutError.deadline = deadline;
    const timer = setTimeout(() => this.#abortLifecycle(lifecycle, timeoutError), this.shutdownTimeoutMs);

    const operation = this.#serialize(async () => {
      this.#assertLifecycle(lifecycle);
      return this.#stopInternal({ restore, persist: true, warnings, lifecycle, deadline });
    });

    try {
      const settled = await settleBefore(operation, deadline);
      if (!settled.settled) {
        this.#abortLifecycle(lifecycle, timeoutError, { renew: true });
        this.#addWarning(warnings, "PROXY_STOP_TIMEOUT", timeoutError.message);
        return { ...this.status(), stopped: false, warnings: [...warnings] };
      }
      if (settled.error) {
        const publicationCommittedAfterDeadline = settled.error?.code === "RENAME_DEADLINE_EXCEEDED"
          && settled.error?.renameCommitted === true;
        if (["PROXY_STOP_TIMEOUT", "PROXY_STOPPING"].includes(settled.error?.code) || publicationCommittedAfterDeadline) {
          const stopError = publicationCommittedAfterDeadline ? timeoutError : settled.error;
          this.#abortLifecycle(lifecycle, stopError, { renew: true });
          this.#addWarning(warnings, stopError.code, String(stopError.message || stopError));
          return { ...this.status(), stopped: false, warnings: [...warnings] };
        }
        throw settled.error;
      }
      return settled.value;
    } finally {
      clearTimeout(timer);
    }
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    const previousAcceptRequestLogs = this.acceptRequestLogs;
    this.closing = true;
    this.acceptRequestLogs = false;
    const deadline = Date.now() + this.shutdownTimeoutMs;
    this.#abortLifecycle(this.#lifecycleToken(), closedError(deadline));
    const lifecycleQueue = this.#queue;
    this.closePromise = (async () => {
      const warnings = [];
      try {
        const lifecycle = await settleBefore(lifecycleQueue, deadline);
        if (!lifecycle.settled) {
          this.#addWarning(warnings, "PROXY_LIFECYCLE_DRAIN_TIMEOUT", `proxy lifecycle queue exceeded ${this.shutdownTimeoutMs}ms`);
        } else if (lifecycle.error) {
          this.#addWarning(warnings, "PROXY_LIFECYCLE_DRAIN_FAILED", String(lifecycle.error?.message || lifecycle.error));
        }

        const restored = await this.#restoreTakeoversForClose(deadline, warnings);
        if (!restored) {
          this.#addWarning(
            warnings,
            "PROXY_CLOSE_INCOMPLETE",
            "takeover restore did not complete; the listener remains active and close may be retried",
          );
          return { ...this.status(), closing: false, closed: false, warnings };
        }

        await this.#quiesceRuntime(deadline, warnings);

        const logDrain = await settleBefore(this.#logQueue, deadline);
        if (!logDrain.settled) {
          this.#addWarning(warnings, "PROXY_LOG_DRAIN_TIMEOUT", `proxy request log queue exceeded ${this.shutdownTimeoutMs}ms`);
        } else if (logDrain.error) {
          this.#addWarning(warnings, "PROXY_LOG_DRAIN_FAILED", String(logDrain.error?.message || logDrain.error));
        }

        const reset = await settleBefore(
          configureUpstreamProxy(null, { closeTimeoutMs: Math.max(0, deadline - Date.now()) }),
          deadline,
        );
        if (!reset.settled) {
          this.#addWarning(warnings, "UPSTREAM_PROXY_CLOSE_TIMEOUT", `upstream proxy reset exceeded ${this.shutdownTimeoutMs}ms`);
        } else if (reset.error) {
          this.#addWarning(warnings, "UPSTREAM_PROXY_CLOSE_FAILED", String(reset.error?.message || reset.error));
        } else if (reset.value?.dispatcherCloseTimedOut) {
          this.#addWarning(warnings, "UPSTREAM_PROXY_CLOSE_TIMEOUT", `upstream dispatcher exceeded ${this.shutdownTimeoutMs}ms`);
        } else if (reset.value?.dispatcherCloseError) {
          this.#addWarning(warnings, "UPSTREAM_PROXY_CLOSE_FAILED", reset.value.dispatcherCloseError);
        }

        this.closed = true;
        return { ...this.status(), closing: false, closed: true, warnings };
      } finally {
        this.closing = false;
        if (!this.closed) {
          this.acceptRequestLogs = previousAcceptRequestLogs;
          this.#rotateLifecycle(cancellationError("proxy close attempt did not complete", "PROXY_CLOSE_INCOMPLETE"));
          this.closePromise = null;
        }
      }
    })();
    return this.closePromise;
  }

  #addWarning(warnings, code, error) {
    if (!warnings.some((item) => item.code === code)) warnings.push({ code, error });
  }

  #abortRequests() {
    for (const controller of this.requestControllers) {
      if (!controller.signal.aborted) {
        controller.abort(cancellationError("proxy is stopping", "PROXY_STOPPING"));
      }
    }
  }

  async #closeServer(server, deadline, warnings) {
    if (!server) return;
    const completion = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        server.close(finish);
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      } catch (error) {
        this.#addWarning(warnings, "PROXY_SERVER_CLOSE_FAILED", String(error.message || error));
        finish();
      }
    });
    const result = await settleBefore(completion, deadline);
    if (!result.settled) {
      server.closeAllConnections?.();
      this.#addWarning(warnings, "PROXY_SERVER_CLOSE_TIMEOUT", `proxy listener exceeded ${this.shutdownTimeoutMs}ms`);
    }
  }

  async #quiesceRuntime(deadline, warnings) {
    const servers = [...new Set([this.server, this.startingServer].filter(Boolean))];
    this.server = null;
    this.startingServer = null;
    this.origin = null;
    this.#abortRequests();
    await Promise.all(servers.map((server) => this.#closeServer(server, deadline, warnings)));
    const drained = await this.#drainRequests(deadline);
    if (!drained) {
      this.#addWarning(
        warnings,
        "PROXY_REQUEST_DRAIN_TIMEOUT",
        `${this.requestTasks.size} proxy request handler(s) remained after ${this.shutdownTimeoutMs}ms`,
      );
    }
  }

  async #restoreTakeoversForClose(deadline, warnings) {
    const apps = PROVIDER_APPS.filter((app) => this.config.takeover[app]);
    if (!apps.length) return true;
    const controller = new AbortController();
    let complete = true;
    for (const app of apps) {
      const nextConfig = {
        ...this.config,
        takeover: { ...this.config.takeover, [app]: false },
      };
      const operation = this.providerStore.setProxyTakeover(app, false, {
        signal: controller.signal,
        deadline,
        sidecarWrites: this.#takeoverSidecar(nextConfig),
        queueIfProjectionHeld: true,
        onCommitted: () => {
          this.config = nextConfig;
          this.storeStatus = { state: "ready", message: null };
        },
      });
      const result = await settleBefore(operation, deadline);
      if (!result.settled) {
        const timeout = cancellationError("proxy close takeover restore timed out", "PROXY_CLOSE_TIMEOUT");
        timeout.deadline = deadline;
        controller.abort(timeout);
        this.#addWarning(
          warnings,
          "PROXY_TAKEOVER_RESTORE_TIMEOUT",
          `takeover restore exceeded ${this.shutdownTimeoutMs}ms`,
        );
        complete = false;
        break;
      }
      if (result.error) {
        warnings.push({
          code: "PROXY_TAKEOVER_RESTORE_FAILED",
          error: `${app}: ${this.#providerFailureDetail(result.error)}`,
        });
        complete = false;
        continue;
      }
      this.#emitProviderTakeover(app, false, result.value.providerId);
    }
    return complete;
  }

  async #stopInternal({ restore, persist, warnings, lifecycle, deadline }) {
    this.#assertLifecycle(lifecycle);
    let restoreComplete = true;
    if (restore) {
      for (const app of PROVIDER_APPS) {
        if (!this.config.takeover[app]) continue;
        const nextConfig = {
          ...this.config,
          takeover: { ...this.config.takeover, [app]: false },
        };
        let committed = false;
        try {
          const result = await this.#awaitLifecycle(
            () => this.providerStore.setProxyTakeover(app, false, {
              signal: lifecycle.controller.signal,
              deadline: () => this.#lifecycleDeadline(lifecycle),
              sidecarWrites: this.#takeoverSidecar(nextConfig),
              queueIfProjectionHeld: true,
              onCommitted: () => {
                this.config = nextConfig;
                this.storeStatus = { state: "ready", message: null };
                committed = true;
              },
            }),
            lifecycle,
            { isCommitted: () => committed },
          );
          this.#emitProviderTakeover(app, false, result.providerId);
        } catch (error) {
          if (["PROXY_CLOSED", "PROXY_STOPPING", "PROXY_STOP_TIMEOUT"].includes(error?.code)) throw error;
          restoreComplete = false;
          warnings.push({ app, error: this.#providerFailureDetail(error) });
        }
      }
    }
    if (restore && !restoreComplete) {
      this.#addWarning(
        warnings,
        "PROXY_STOP_INCOMPLETE",
        "takeover restore did not complete; the listener remains active and stop may be retried",
      );
      return { ...this.status(), stopped: false, warnings: [...warnings] };
    }
    await this.#quiesceRuntime(deadline, warnings);
    this.#assertLifecycle(lifecycle);
    if (persist && !restore) await this.#commit(lifecycle);
    await this.#awaitLifecycle(
      () => this.eventStore?.emit("ccswitch.proxy_stopped", { restore, warnings }).catch(() => {}),
      lifecycle,
    );
    return { ...this.status(), stopped: true, warnings: [...warnings] };
  }

  async #drainRequests(deadline) {
    while (this.requestTasks.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer = null;
      const settled = await Promise.race([
        Promise.allSettled([...this.requestTasks]).then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), remaining);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!settled) return false;
    }
    return true;
  }

  updateConfig(input = {}) {
    const lifecycle = this.#lifecycleToken();
    return this.#serialize(async () => {
      this.#assertLifecycle(lifecycle);
      if (this.server && (input.listenAddress !== undefined || input.listenPort !== undefined)) {
        fail("stop the proxy before changing its listen address or port", "PROXY_RESTART_REQUIRED", 409);
      }
      const previous = this.config;
      this.config = this.#validateConfig({ ...this.config, ...input, circuitBreaker: { ...this.config.circuitBreaker, ...(input.circuitBreaker ?? {}) } });
      this.providerStore.configureLocalProxy({ origin: this.origin || `http://${this.config.listenAddress}:${this.config.listenPort}`, token: this.config.token });
      try {
        await this.#commit(lifecycle);
        if (input.upstreamProxyUrl !== undefined) {
          await this.#awaitLifecycle(() => configureUpstreamProxy(this.config.upstreamProxyUrl), lifecycle);
        }
      } catch (error) {
        this.config = previous;
        this.providerStore.configureLocalProxy({
          origin: this.origin || `http://${previous.listenAddress}:${previous.listenPort}`,
          token: previous.token,
        });
        if (lifecycle.controller.signal.aborted) {
          const cancellation = abortReason(lifecycle.controller.signal);
          // 回滚写不得复用 close/stop 的 deadline：此时 #commit 的 rename 尚未发生，磁盘仍是旧快照，
          // 回滚只是兜底保证一致性。若被已过期的 deadline 拦下抛 PROXY_CONFIG_PERSIST_TIMEOUT，
          // 旧实现会把 this.config 覆盖回新值，导致内存与磁盘不一致（回归已由 ccswitch-proxy 测试覆盖）。
          try {
            this.#writeConfigSync(previous);
          } catch (rollbackError) {
            cancellation.rollbackError = String(rollbackError?.message || rollbackError);
          }
          if (input.upstreamProxyUrl !== undefined) {
            void configureUpstreamProxy(this.config.upstreamProxyUrl, { closeTimeoutMs: 0 }).catch((rollbackError) => {
              this.storeStatus.runtimeWarning = `upstream rollback failed: ${String(rollbackError?.message || rollbackError).slice(0, 200)}`;
            });
          }
          throw cancellation;
        }
        if (this.closing || this.closed || error?.code === "PROXY_CLOSED") throw closedError();
        await this.#commit().catch(() => {});
        await configureUpstreamProxy(previous.upstreamProxyUrl).catch(() => {});
        throw error;
      }
      return this.status();
    });
  }

  updateUpstreamProxy(value) {
    return this.updateConfig({ upstreamProxyUrl: value });
  }

  testUpstreamProxy(value, options = {}) {
    return testUpstreamProxy(value, options);
  }

  scanLocalProxies(options = {}) {
    return scanLocalProxies(options);
  }

  setTakeover(app, enabled) {
    if (!PROVIDER_APPS.includes(app)) fail(`unknown app: ${app}`, "VALIDATION_FAILED");
    const lifecycle = this.#lifecycleToken();
    return this.#serialize(async () => {
      this.#assertLifecycle(lifecycle);
      if (enabled && !this.server) fail("start the local proxy before enabling takeover", "PROXY_NOT_RUNNING", 409);
      const previous = this.config;
      const nextConfig = {
        ...this.config,
        takeover: { ...this.config.takeover, [app]: Boolean(enabled) },
      };
      let committed = false;
      try {
        const result = await this.#awaitLifecycle(
          () => this.providerStore.setProxyTakeover(app, Boolean(enabled), {
            signal: lifecycle.controller.signal,
            deadline: () => this.#lifecycleDeadline(lifecycle),
            sidecarWrites: this.#takeoverSidecar(nextConfig),
            onCommitted: () => {
              this.config = nextConfig;
              this.storeStatus = { state: "ready", message: null };
              committed = true;
            },
          }),
          lifecycle,
          { isCommitted: () => committed },
        );
        this.#emitProviderTakeover(app, Boolean(enabled), result.providerId);
        return { ...result, status: this.status() };
      } catch (error) {
        if (!committed) this.config = previous;
        if (lifecycle.controller.signal.aborted) {
          const cancellation = abortReason(lifecycle.controller.signal);
          if (error.rollbackErrors) cancellation.rollbackErrors = error.rollbackErrors;
          throw cancellation;
        }
        throw error;
      }
    });
  }

  #breakerKey(app, providerId) {
    return `${app}:${providerId}`;
  }

  #breaker(app, providerId) {
    const key = this.#breakerKey(app, providerId);
    if (!this.breakers.has(key)) this.breakers.set(key, { state: "closed", failures: 0, successes: 0, openedAt: null, lastFailure: null });
    const breaker = this.breakers.get(key);
    if (breaker.state === "open" && Date.now() - breaker.openedAt >= this.config.circuitBreaker.cooldownMs) {
      breaker.state = "half-open";
      breaker.successes = 0;
    }
    return breaker;
  }

  #recordFailure(app, providerId, message) {
    const breaker = this.#breaker(app, providerId);
    breaker.failures += 1;
    breaker.successes = 0;
    breaker.lastFailure = String(message ?? "request failed").slice(0, 300);
    if (breaker.state === "half-open" || breaker.failures >= this.config.circuitBreaker.failureThreshold) {
      breaker.state = "open";
      breaker.openedAt = Date.now();
    }
  }

  #recordSuccess(app, providerId) {
    const breaker = this.#breaker(app, providerId);
    breaker.successes += 1;
    if (breaker.state === "half-open" && breaker.successes < this.config.circuitBreaker.successThreshold) return;
    breaker.state = "closed";
    breaker.failures = 0;
    breaker.successes = 0;
    breaker.openedAt = null;
    breaker.lastFailure = null;
  }

  health(app = null) {
    const items = [];
    for (const provider of this.providerStore.providers.values()) {
      for (const candidateApp of PROVIDER_APPS) {
        if (app && candidateApp !== app) continue;
        if (!provider.apps?.[candidateApp]) continue;
        items.push({ app: candidateApp, providerId: provider.id, providerName: provider.name, ...this.#breaker(candidateApp, provider.id) });
      }
    }
    return items;
  }

  resetBreaker(app, providerId) {
    this.providerStore.get(providerId);
    this.breakers.delete(this.#breakerKey(app, providerId));
    return { app, providerId, ...this.#breaker(app, providerId) };
  }

  #candidates(app) {
    const current = this.providerStore.current[app];
    if (!current) fail(`no current provider for ${app}`, "NO_CURRENT_PROVIDER", 503);
    const failover = this.providerStore.autoFailover[app]
      ? this.providerStore.failoverQueue[app]
      : [];
    const ids = [current, ...failover.filter((id) => id !== current)];
    const available = ids.filter((id) => this.#breaker(app, id).state !== "open");
    if (!available.length) fail(`all providers are circuit-open for ${app}`, "ALL_PROVIDERS_UNAVAILABLE", 503);
    return available.map((id) => this.providerStore.get(id));
  }

  #spent(providerId, period) {
    const now = new Date();
    const prefix = period === "day"
      ? now.toISOString().slice(0, 10)
      : now.toISOString().slice(0, 7);
    return this.logs
      .filter((entry) => entry.providerId === providerId && String(entry.startedAt).startsWith(prefix) && entry.success)
      .reduce((sum, entry) => sum + (Number(entry.costUsd) || 0), 0);
  }

  checkLimits(provider) {
    const dailySpentUsd = this.#spent(provider.id, "day");
    const monthlySpentUsd = this.#spent(provider.id, "month");
    const dailyLimitUsd = provider.meta?.limitDailyUsd ?? null;
    const monthlyLimitUsd = provider.meta?.limitMonthlyUsd ?? null;
    const allowed = !(dailyLimitUsd != null && dailySpentUsd >= dailyLimitUsd)
      && !(monthlyLimitUsd != null && monthlySpentUsd >= monthlyLimitUsd);
    return { providerId: provider.id, allowed, dailySpentUsd, monthlySpentUsd, dailyLimitUsd, monthlyLimitUsd };
  }

  #cost(model, inputTokens, outputTokens, multiplier = 1) {
    const price = this.config.pricing[model] ?? { inputPerMillion: 0, outputPerMillion: 0 };
    return ((inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) / 1_000_000) * multiplier;
  }

  #record(entry) {
    if (!this.acceptRequestLogs) return Promise.resolve(null);
    const log = { ...entry, id: entry.id || `request-${randomUUID()}` };
    const write = async () => {
      if (!this.acceptRequestLogs && (this.closing || this.closed)) return null;
      this.logs.push(log);
      if (this.logs.length > MAX_LOGS_IN_MEMORY) this.logs.splice(0, this.logs.length - MAX_LOGS_IN_MEMORY);
      try {
        await this.requestLogAppend(this.logsPath, `${JSON.stringify(log)}\n`, { encoding: "utf8", mode: 0o600 });
        return log;
      } catch (error) {
        const index = this.logs.findIndex((item) => item.id === log.id);
        if (index !== -1) this.logs.splice(index, 1);
        throw error;
      }
    };
    const next = this.#logQueue.then(write, write);
    this.#logQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  #notePersistenceWarning(kind, error) {
    const key = kind === "request-log" ? "logsWarning" : "runtimeWarning";
    const message = `${kind}: ${String(error?.message || error).slice(0, 240)}`;
    this.storeStatus = { ...this.storeStatus, [key]: message };
    void this.eventStore?.emit("ccswitch.proxy_persistence_warning", { kind, message }).catch(() => {});
  }

  async #recordSafely(entry) {
    try {
      return await this.#record(entry);
    } catch (error) {
      this.#notePersistenceWarning("request-log", error);
      return null;
    }
  }

  #authorized(request, url) {
    const bearer = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const apiKey = request.headers["x-api-key"] ?? request.headers["x-goog-api-key"] ?? url.searchParams.get("key") ?? "";
    return safeEqual(bearer, this.config.token) || safeEqual(apiKey, this.config.token);
  }

  async #handle(request, response, signal) {
    const requestId = `request-${randomUUID()}`;
    response.setHeader("x-514cc-proxy-request-id", requestId);
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const url = new URL(request.url, "http://127.0.0.1");
    const segments = url.pathname.split("/").filter(Boolean);
    const app = segments.shift() ?? null;
    const attempts = [];
    let clientProtocol = null;
    let clientBody = {};
    let activeRequestCounted = false;
    let lastError = null;
    try {
      if (!PROVIDER_APPS.includes(app)) fail("proxy path must begin with a supported app id", "UNKNOWN_PROXY_APP", 404);
      if (!this.#authorized(request, url)) fail("invalid local proxy token", "PROXY_UNAUTHORIZED", 401);
      if (request.method !== "POST") fail("local model proxy only accepts POST", "METHOD_NOT_ALLOWED", 405);
      const pathname = `/${segments.join("/")}`;
      clientProtocol = pathProtocol(pathname, app);
      clientBody = await readRequestBody(request);
      const candidates = this.#candidates(app);
      this.activeRequests += 1;
      activeRequestCounted = true;
      for (const provider of candidates) {
        if (signal.aborted) throw abortReason(signal);
        const limits = this.checkLimits(provider);
        if (!limits.allowed) {
          const message = `provider limit reached (daily ${limits.dailySpentUsd}/${limits.dailyLimitUsd ?? "∞"}, monthly ${limits.monthlySpentUsd}/${limits.monthlyLimitUsd ?? "∞"})`;
          attempts.push({ providerId: provider.id, error: message, code: "PROVIDER_LIMIT_REACHED" });
          lastError = Object.assign(new Error(message), { code: "PROVIDER_LIMIT_REACHED", httpStatus: 429 });
          continue;
        }
        const upstreamProtocol = appProtocol(provider, app);
        const model = modelOf(provider, app, clientBody);
        const upstreamBody = convertRequest(clientBody, clientProtocol, upstreamProtocol, model);
        // 档案级 Body 覆盖（meta.proxyOverrides.body）：浅合并标量到协议转换后的请求体
        const bodyOverrides = provider.meta?.proxyOverrides?.body;
        const finalBody = bodyOverrides ? { ...upstreamBody, ...bodyOverrides } : upstreamBody;
        const upstreamUrl = targetUrl(provider, app, upstreamProtocol, model || upstreamBody.model);
        try {
          const upstream = await this.fetchImpl(upstreamUrl, {
            method: "POST",
            headers: targetHeaders(provider, upstreamProtocol),
            body: JSON.stringify(finalBody),
            signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]),
          });
          if (signal.aborted) throw abortReason(signal);
          attempts.push({ providerId: provider.id, status: upstream.status, protocol: upstreamProtocol });
          if (FAILURE_STATUSES.has(upstream.status)) {
            const preview = (await upstream.text()).slice(0, 500);
            this.#recordFailure(app, provider.id, `HTTP ${upstream.status}: ${preview}`);
            lastError = Object.assign(new Error(`upstream ${provider.name} returned HTTP ${upstream.status}: ${preview}`), { code: "UPSTREAM_FAILED", httpStatus: 502 });
            continue;
          }
          response.setHeader("x-514cc-upstream-provider-id", provider.id);
          const usage = await this.#forward(upstream, response, { from: upstreamProtocol, to: clientProtocol, requestBody: clientBody, model, signal });
          this.#recordSuccess(app, provider.id);
          let persistenceWarning = null;
          if (provider.id !== this.providerStore.current[app]) {
            try {
              await this.providerStore.markProxyCurrent(app, provider.id, { proxyObserved: true });
            } catch (error) {
              persistenceWarning = `proxy-current: ${String(error?.message || error).slice(0, 240)}`;
              this.#notePersistenceWarning("proxy-current", error);
            }
          }
          const inputTokens = usage.inputTokens || 0;
          const outputTokens = usage.outputTokens || 0;
          const costUsd = this.#cost(model || usage.model || "unknown", inputTokens, outputTokens, provider.meta?.costMultiplier ?? 1);
          await this.#recordSafely({
            id: requestId,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - started),
            app,
            providerId: provider.id,
            providerName: provider.name,
            model: model || usage.model || null,
            clientProtocol,
            upstreamProtocol,
            httpStatus: upstream.status,
            success: true,
            ...(persistenceWarning ? { persistenceWarning } : {}),
            inputTokens,
            outputTokens,
            costUsd,
            attempts,
          });
          return;
        } catch (error) {
          if (signal.aborted) throw abortReason(signal);
          this.#recordFailure(app, provider.id, error.message);
          attempts.push({ providerId: provider.id, error: error.message, code: error.code ?? null });
          if (response.headersSent) throw error;
          lastError = error;
        }
      }
      throw lastError || Object.assign(new Error("no provider could serve the request"), { code: "ALL_PROVIDERS_FAILED", httpStatus: 503 });
    } catch (error) {
      const terminalError = signal.aborted ? abortReason(signal) : error;
      await this.#recordSafely({
        id: requestId,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        app,
        providerId: attempts.at(-1)?.providerId ?? null,
        model: clientBody?.model ?? null,
        clientProtocol,
        httpStatus: terminalError.httpStatus || 502,
        success: false,
        cancelled: signal.aborted,
        errorCode: terminalError.code || "PROXY_ERROR",
        error: String(terminalError.message || terminalError).slice(0, 500),
        attempts,
      });
      throw terminalError;
    } finally {
      if (activeRequestCounted) this.activeRequests -= 1;
    }
  }

  async #forward(upstream, response, { from, to, requestBody, model, signal }) {
    if (signal.aborted) throw abortReason(signal);
    const contentType = upstream.headers.get("content-type") || "application/json";
    const streaming = contentType.includes("text/event-stream") || Boolean(requestBody.stream);
    response.statusCode = upstream.status;
    response.setHeader("cache-control", "no-cache");
    response.setHeader("x-514cc-upstream-protocol", from);
    if (!streaming) {
      const text = await upstream.text();
      if (signal.aborted) throw abortReason(signal);
      let payload;
      try { payload = JSON.parse(text); }
      catch {
        response.setHeader("content-type", contentType);
        response.end(text);
        return { inputTokens: 0, outputTokens: 0, model };
      }
      const converted = convertResponse(payload, from, to, requestBody);
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(converted));
      return extractResponse(payload, from);
    }

    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    const reader = upstream.body?.getReader();
    if (!reader) {
      response.end();
      return { inputTokens: 0, outputTokens: 0, model };
    }
    const decoder = new TextDecoder();
    let pending = "";
    let captured = "";
    let outputText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw abortReason(signal);
      if (done) break;
      if (from === to) {
        response.write(Buffer.from(value));
        if (captured.length < 262_144) captured += decoder.decode(value, { stream: true });
        continue;
      }
      pending += decoder.decode(value, { stream: true });
      const events = pending.split(/\r?\n\r?\n/);
      pending = events.pop() ?? "";
      for (const event of events) {
        const dataLine = event.split(/\r?\n/).find((line) => line.startsWith("data:"));
        if (!dataLine) continue;
        const data = dataLine.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const payload = JSON.parse(data);
          const delta = streamDelta(payload, from);
          if (delta) {
            outputText += delta;
            response.write(encodeStreamDelta(delta, to, model));
          }
        } catch {
          // 无法识别的事件不伪造；继续等待下一条可转换事件。
        }
      }
    }
    if (to === "openai-chat") response.write("data: [DONE]\n\n");
    else if (to === "openai-responses") response.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`);
    else if (to === "anthropic") response.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    response.end();
    const usage = captured ? this.#usageFromSse(captured, from) : { inputTokens: 0, outputTokens: 0 };
    return { ...usage, model, outputText };
  }

  #usageFromSse(text, protocol) {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const match of text.matchAll(/^data:\s*(\{.*\})\s*$/gm)) {
      try {
        const usage = extractResponse(JSON.parse(match[1]), protocol);
        inputTokens = Math.max(inputTokens, usage.inputTokens || 0);
        outputTokens = Math.max(outputTokens, usage.outputTokens || 0);
      } catch {
        // 非 JSON 或非 usage 事件跳过。
      }
    }
    return { inputTokens, outputTokens };
  }

  requestLogs({ limit = 100, offset = 0, app = null, providerId = null } = {}) {
    const count = cleanInt(limit, 1, 1000, 100, "limit");
    const start = cleanInt(offset, 0, Number.MAX_SAFE_INTEGER, 0, "offset");
    const filtered = this.logs.filter((entry) => (!app || entry.app === app) && (!providerId || entry.providerId === providerId));
    return { total: filtered.length, items: filtered.slice().reverse().slice(start, start + count) };
  }

  requestDetail(id) {
    const item = this.logs.find((entry) => entry.id === id);
    if (!item) fail("request log not found", "SOURCE_NOT_FOUND", 404);
    return item;
  }

  usageSummary({ app = null, days = 30 } = {}) {
    const windowDays = cleanInt(days, 1, 3650, 30, "days");
    const since = Date.now() - windowDays * 86_400_000;
    const totals = { requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, durationCount: 0 };
    for (const entry of this.logs) {
      if (!inUsageWindow(entry, { app, since })) continue;
      addUsageTotals(totals, entry);
    }
    return finalizeUsageSummary(totals, { windowDays, since });
  }

  usageTrends({ days = 30, app = null, granularity = null } = {}) {
    const count = cleanInt(days, 1, 365, 30, "days");
    const grain = granularity === "hour" || granularity === "day"
      ? granularity
      : (count <= 1 ? "hour" : "day");
    const since = Date.now() - count * 86_400_000;
    const step = grain === "hour" ? 3_600_000 : 86_400_000;
    const buckets = new Map();
    const ensure = (key) => {
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = emptyTrendBucket(key, grain);
        buckets.set(key, bucket);
      }
      return bucket;
    };
    const aligned = grain === "hour"
      ? Math.floor(since / step) * step
      : Date.parse(`${new Date(since).toISOString().slice(0, 10)}T00:00:00.000Z`);
    for (let ts = aligned; Number.isFinite(ts) && ts <= Date.now(); ts += step) {
      ensure(usageBucketKey(new Date(ts).toISOString(), grain));
    }
    for (const entry of this.logs) {
      if (!inUsageWindow(entry, { app, since })) continue;
      const bucket = ensure(usageBucketKey(entry.startedAt, grain));
      const modelKey = entry.model || "unknown";
      const model = bucket.models[modelKey] ?? (bucket.models[modelKey] = { requests: 0, failed: 0, costUsd: 0, tokens: 0 });
      if (entry.success) {
        const tokens = (Number(entry.inputTokens) || 0) + (Number(entry.outputTokens) || 0);
        const costUsd = Number(entry.costUsd) || 0;
        bucket.requests += 1;
        bucket.inputTokens += Number(entry.inputTokens) || 0;
        bucket.outputTokens += Number(entry.outputTokens) || 0;
        bucket.costUsd += costUsd;
        model.requests += 1;
        model.costUsd += costUsd;
        model.tokens += tokens;
      } else {
        bucket.failed += 1;
        model.failed += 1;
      }
    }
    return [...buckets.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  usageStats(groupBy, { app = null, days = null } = {}) {
    const windowDays = days == null || days === "" ? null : cleanInt(days, 1, 3650, 30, "days");
    const since = windowDays == null ? 0 : Date.now() - windowDays * 86_400_000;
    const groups = new Map();
    for (const entry of this.logs) {
      if (!inUsageWindow(entry, { app, since })) continue;
      const key = groupBy === "model" ? entry.model || "unknown" : entry.providerId || "unknown";
      const item = groups.get(key) ?? { key, requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      if (entry.success) {
        item.requests += 1;
        item.inputTokens += Number(entry.inputTokens) || 0;
        item.outputTokens += Number(entry.outputTokens) || 0;
        item.costUsd += Number(entry.costUsd) || 0;
      } else {
        item.failed += 1;
      }
      groups.set(key, item);
    }
    return [...groups.values()]
      .map((item) => {
        const totalRequests = item.requests + item.failed;
        return {
          ...item,
          tokens: item.inputTokens + item.outputTokens,
          totalRequests,
          successRate: totalRequests ? item.requests / totalRequests : null,
        };
      })
      .sort((left, right) => right.costUsd - left.costUsd || right.requests - left.requests || right.failed - left.failed);
  }

  usageOverview({ app = null, days = 7 } = {}) {
    const windowDays = cleanInt(days, 1, 365, 7, "days");
    const since = Date.now() - windowDays * 86_400_000;
    const logs = this.logs
      .filter((entry) => inUsageWindow(entry, { app, since }))
      .slice()
      .reverse()
      .slice(0, 80)
      .map(publicUsageLog);
    return {
      source: "ccswitch-proxy",
      summary: this.usageSummary({ app, days: windowDays }),
      trends: this.usageTrends({ app, days: windowDays }),
      models: this.usageStats("model", { app, days: windowDays }),
      providers: this.usageStats("provider", { app, days: windowDays }),
      logs,
    };
  }

  pricing() {
    return jsonClone(this.config.pricing);
  }

  setPricing(model, input = {}) {
    const key = String(model ?? "").trim();
    if (!key || key.length > 160) fail("model is required", "VALIDATION_FAILED");
    return this.#serialize(async () => {
      const inputPerMillion = Number(input.inputPerMillion);
      const outputPerMillion = Number(input.outputPerMillion);
      if (![inputPerMillion, outputPerMillion].every((value) => Number.isFinite(value) && value >= 0 && value <= 1_000_000)) {
        fail("pricing values must be non-negative numbers", "VALIDATION_FAILED");
      }
      this.config.pricing[key] = { inputPerMillion, outputPerMillion };
      await this.#commit();
      return { model: key, ...this.config.pricing[key] };
    });
  }

  removePricing(model) {
    return this.#serialize(async () => {
      delete this.config.pricing[String(model)];
      await this.#commit();
      return { removed: String(model) };
    });
  }
}
