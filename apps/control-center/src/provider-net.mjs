// cc-switch 网络服务面移植（farion1231/cc-switch，Rust → Node 等价复刻）：
// ① speedtest.rs → testEndpoints（并发 GET + 热身一次再计时，timeout clamp 2-30s）
// ② stream_check.rs → checkReachability（任意 HTTP 响应=可达，TTFB 三档，仅超时重试）
// ③ usage_script.rs → queryUsageScript（一次性 Worker + node:vm 隔离执行，同字段同安全闸：
//    HTTPS 强制 loopback 豁免 + 非 custom 模板同源同端口检查 + 结果类型校验）
// ④ deeplink/parser.rs provider 分支 → parseDeeplink（ccswitch://v1/import?resource=provider）
// ⑤ testConfig 真实小请求 → testModelRequest（claude /v1/messages、openai /chat/completions）
import { Worker } from "node:worker_threads";
import { codexBaseUrl } from "./providers.mjs";
import { assertHostAllowed } from "./security/egress-guard.mjs";

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

/**
 * 自建端点守卫（F-044）。
 *
 * base_url / 候选端点列表都是用户可编辑输入，等于把「让本机去请求任意地址」
 * 的能力交了出去；而 testEndpoints 还会把延迟和 HTTP 状态回显出来，天然构成
 * 内网测绘探针。
 *
 * 这里用 `lan` 策略：环回与私网段放行（Ollama / LM Studio / 公司内网网关是
 * 正当用法，一刀切会直接弄坏产品），云元数据 169.254.169.254、链路本地、
 * RFC2544 测速段这类**不存在正当模型服务**的地址一律拒绝。
 */
function assertProviderHostAllowed(parsed, label) {
  try {
    assertHostAllowed(parsed.hostname, { policy: "lan" });
  } catch (error) {
    fail(`${label}指向了不允许的地址：${error.message}`, "PROVIDER_TARGET_BLOCKED");
  }
  return parsed;
}

const clampTimeout = (secs, fallback = 8) => {
  const num = Number(secs);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(30, Math.max(2, Math.round(num)));
};

const trimUrl = (url) => String(url ?? "").trim().replace(/\/+$/, "");
const MODEL_FETCH_TIMEOUT_MS = 8000;
const MODEL_FETCH_MAX_BYTES = 1024 * 1024;
const MODEL_FETCH_MAX_REDIRECTS = 3;
const MODEL_FETCH_MAX_MODELS = 500;

function isLoopbackHost(url) {
  const host = url.hostname.toLowerCase();
  if (host === "localhost") return true;
  if (host === "::1" || host === "[::1]") return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return Boolean(v4 && Number(v4[1]) === 127);
}

function parseUrl(raw, label) {
  try {
    return new URL(raw);
  } catch (error) {
    fail(`${label}: ${error.message}`, "USAGE_URL_INVALID");
  }
}

function validateProviderHttpUrl(raw, label = "请求地址") {
  const parsed = parseUrl(String(raw ?? "").trim(), `${label}无效`);
  if (!/^https?:$/.test(parsed.protocol)) fail(`${label}仅支持 HTTP(S)`, "MODEL_FETCH_URL_INVALID");
  if (parsed.username || parsed.password) fail(`${label}不能包含 URL 用户名或密码`, "MODEL_FETCH_URL_INVALID");
  if (parsed.protocol !== "https:" && !isLoopbackHost(parsed)) {
    fail(`${label}必须使用 HTTPS（localhost 除外）`, "MODEL_FETCH_HTTPS_REQUIRED");
  }
  parsed.hash = "";
  return parsed;
}

function appendUniqueUrl(target, seen, parsed) {
  const href = parsed.href;
  if (seen.has(href)) return;
  seen.add(href);
  target.push(href);
}

/** Derive OpenAI-compatible /models endpoints without ad-hoc string replacement. */
export function buildModelsUrlCandidates(baseUrl, { isFullUrl = false } = {}) {
  const parsed = validateProviderHttpUrl(baseUrl);
  const candidates = [];
  const seen = new Set();
  const sourcePath = parsed.pathname.replace(/\/+$/, "") || "/";
  const add = (pathname) => {
    const candidate = new URL(parsed.href);
    candidate.pathname = pathname.replace(/\/{2,}/g, "/");
    appendUniqueUrl(candidates, seen, candidate);
  };

  if (isFullUrl) {
    if (/\/models$/i.test(sourcePath)) add(sourcePath);
    else if (/\/chat\/completions$/i.test(sourcePath)) add(sourcePath.replace(/\/chat\/completions$/i, "/models"));
    else if (/\/(?:responses|completions)$/i.test(sourcePath)) add(sourcePath.replace(/\/(?:responses|completions)$/i, "/models"));
    else add("/v1/models");
    if (!/\/v1\/models$/i.test(candidates[0] ? new URL(candidates[0]).pathname : "")) add("/v1/models");
  } else if (/\/models$/i.test(sourcePath)) {
    add(sourcePath);
  } else if (/\/v\d+(?:beta)?$/i.test(sourcePath)) {
    add(`${sourcePath}/models`);
  } else {
    add(`${sourcePath === "/" ? "" : sourcePath}/v1/models`);
    add(`${sourcePath === "/" ? "" : sourcePath}/models`);
  }
  return candidates;
}

function safeModelSource(raw) {
  const parsed = new URL(raw);
  for (const key of [...parsed.searchParams.keys()]) {
    if (/(?:api[-_]?key|token|secret|authorization)/i.test(key)) parsed.searchParams.set(key, "[REDACTED]");
  }
  return parsed.href;
}

async function readBoundedResponse(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) fail("模型列表响应超过大小上限", "MODEL_FETCH_RESPONSE_TOO_LARGE");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) fail("模型列表响应超过大小上限", "MODEL_FETCH_RESPONSE_TOO_LARGE");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        fail("模型列表响应超过大小上限", "MODEL_FETCH_RESPONSE_TOO_LARGE");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock?.();
  }
}

function normalizeFetchedModels(payload) {
  const source = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : null;
  if (!source) fail("模型接口没有返回 data、models 或顶层数组", "MODEL_FETCH_INVALID_RESPONSE");
  const seen = new Set();
  const models = [];
  for (const item of source) {
    const id = String(typeof item === "string" ? item : item?.id ?? item?.name ?? item?.slug ?? item?.model ?? "").trim();
    if (!id || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    const ownedBy = typeof item === "object" && item
      ? String(item.owned_by ?? item.ownedBy ?? item.provider ?? item.organization ?? "").trim().slice(0, 120)
      : "";
    models.push({ id, ...(ownedBy ? { ownedBy } : {}) });
    if (models.length >= MODEL_FETCH_MAX_MODELS) break;
  }
  return models;
}

async function fetchModelCandidate(url, { apiKey, customUserAgent, fetchImpl, signal, maxResponseBytes }) {
  let current = validateProviderHttpUrl(url, "模型地址");
  for (let redirects = 0; redirects <= MODEL_FETCH_MAX_REDIRECTS; redirects += 1) {
    const headers = { accept: "application/json", "accept-encoding": "identity", authorization: `Bearer ${apiKey}` };
    if (customUserAgent) headers["user-agent"] = customUserAgent;
    const response = await fetchImpl(current, { headers, signal, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers?.get?.("location");
      if (!location) fail("模型接口重定向缺少 Location", "MODEL_FETCH_REDIRECT_BLOCKED");
      if (redirects >= MODEL_FETCH_MAX_REDIRECTS) fail("模型接口重定向次数过多", "MODEL_FETCH_REDIRECT_LIMIT");
      const next = validateProviderHttpUrl(new URL(location, current).href, "模型重定向地址");
      if (next.origin !== current.origin) fail("模型接口拒绝携带凭据跨源重定向", "MODEL_FETCH_REDIRECT_BLOCKED");
      current = next;
      continue;
    }
    const text = await readBoundedResponse(response, maxResponseBytes);
    if (response.status === 404) return { notFound: true, source: current.href };
    if (response.status === 401 || response.status === 403) {
      fail(`模型接口拒绝凭据（HTTP ${response.status}）`, "MODEL_FETCH_UNAUTHORIZED");
    }
    if (!response.ok) fail(`模型接口返回 HTTP ${response.status}`, "MODEL_FETCH_UPSTREAM_FAILED");
    let payload;
    try { payload = JSON.parse(text); } catch { fail("模型接口返回的不是有效 JSON", "MODEL_FETCH_INVALID_RESPONSE"); }
    return { notFound: false, source: current.href, models: normalizeFetchedModels(payload) };
  }
  fail("模型接口重定向次数过多", "MODEL_FETCH_REDIRECT_LIMIT");
}

export async function fetchProviderModels({
  baseUrl,
  apiKey,
  isFullUrl = false,
  customUserAgent = "",
  fetchImpl = globalThis.fetch,
  timeoutMs = MODEL_FETCH_TIMEOUT_MS,
  maxResponseBytes = MODEL_FETCH_MAX_BYTES,
} = {}) {
  const key = String(apiKey ?? "").trim();
  if (!key) fail("API Key 不能为空", "VALIDATION_FAILED");
  const userAgent = String(customUserAgent ?? "").trim();
  if (userAgent.length > 200 || /[\r\n]/.test(userAgent)) fail("User-Agent 必须是 200 字符以内的单行文本", "VALIDATION_FAILED");
  // 候选地址全部由 baseUrl 推导，且请求头带 apiKey —— 在派生之前就审掉
  assertProviderHostAllowed(parseUrl(String(baseUrl ?? "").trim(), "base_url 无效"), "base_url");
  const candidates = buildModelsUrlCandidates(baseUrl, { isFullUrl });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(30000, Math.max(100, Number(timeoutMs) || MODEL_FETCH_TIMEOUT_MS)));
  try {
    for (const candidate of candidates) {
      const result = await fetchModelCandidate(candidate, {
        apiKey: key,
        customUserAgent: userAgent,
        fetchImpl,
        signal: controller.signal,
        maxResponseBytes: Math.min(4 * 1024 * 1024, Math.max(1024, Number(maxResponseBytes) || MODEL_FETCH_MAX_BYTES)),
      });
      if (!result.notFound) return { source: safeModelSource(result.source), models: result.models };
    }
    fail("模型接口候选地址均返回 HTTP 404", "MODEL_FETCH_NOT_FOUND");
  } catch (error) {
    if (error?.name === "AbortError") fail("获取模型列表超时", "MODEL_FETCH_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const portOf = (url) => url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");

function withTimeoutSignal(timeoutSecs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clampTimeout(timeoutSecs) * 1000);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

// ── ① 端点测速（speedtest.rs 复刻）────────────────────────────────────────
// UI 展示多个 baseUrl 候选的延迟；热身请求复用连接，第二次计时为准。
export async function testEndpoints(urls, timeoutSecs = 8) {
  if (!Array.isArray(urls)) fail("urls must be an array", "VALIDATION_FAILED");
  const timeout = clampTimeout(timeoutSecs);
  return Promise.all(urls.slice(0, 24).map(async (raw) => {
    const url = String(raw ?? "").trim();
    if (!url) return { url: raw, latency: null, status: null, error: "URL 不能为空" };
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      return { url, latency: null, status: null, error: `URL 无效: ${error.message}` };
    }
    if (!/^https?:$/.test(parsed.protocol)) return { url, latency: null, status: null, error: "仅支持 http(s) URL" };
    try {
      assertProviderHostAllowed(parsed, "候选端点");
    } catch (error) {
      return { url, latency: null, status: null, error: error.message };
    }
    try {
      const first = withTimeoutSignal(timeout);
      await fetch(parsed, { signal: first.signal, redirect: "manual" }).then((r) => r.arrayBuffer().catch(() => {})).catch(() => {});
      first.done();
      const second = withTimeoutSignal(timeout);
      const start = performance.now();
      try {
        const response = await fetch(parsed, { signal: second.signal, redirect: "manual" });
        await response.arrayBuffer().catch(() => {});
        return { url, latency: Math.round(performance.now() - start), status: response.status, error: null };
      } finally {
        second.done();
      }
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      return {
        url,
        latency: null,
        status: null,
        error: timedOut ? "请求超时" : `连接失败: ${error?.cause?.code ?? error.message}`,
      };
    }
  }));
}

// ── ② 连通性检查（stream_check.rs 复刻）──────────────────────────────────
// 设计取舍照抄：可达 ≠ 配置正确。任意 HTTP 状态（含 401/403/5xx）都算可达——
// 只回答"能不能到"，鉴权/模型正确性由 testModelRequest 回答。
export const HEALTH_STATUS = Object.freeze({ OPERATIONAL: "operational", DEGRADED: "degraded", FAILED: "failed" });

export async function checkReachability(baseUrl, testConfig = {}) {
  const url = trimUrl(baseUrl);
  if (!url) fail("base_url 为空", "VALIDATION_FAILED");
  const parsed = parseUrl(url, "base_url 无效");
  if (!/^https?:$/.test(parsed.protocol)) fail("base_url 必须是 http(s)", "VALIDATION_FAILED");
  assertProviderHostAllowed(parsed, "base_url");
  const timeoutSecs = clampTimeout(testConfig.timeoutSecs, 8);
  const maxRetries = Math.min(5, Math.max(0, Number(testConfig.maxRetries) || 0));
  const degradedThresholdMs = Math.min(60000, Math.max(100, Number(testConfig.degradedThresholdMs) || 6000));

  let last = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    last = await probeOnce(url, timeoutSecs, degradedThresholdMs);
    if (last.success) return { ...last, retryCount: attempt };
    // 仅超时类抖动值得重试；连接拒绝/DNS 立即返回（should_retry 复刻）
    const msg = last.message.toLowerCase();
    if (!(msg.includes("timeout") || msg.includes("timed out") || msg.includes("abort")) || attempt >= maxRetries) {
      return { ...last, retryCount: attempt };
    }
  }
  return { ...last, retryCount: maxRetries };
}

async function probeOnce(url, timeoutSecs, degradedThresholdMs) {
  const { signal, done } = withTimeoutSignal(timeoutSecs);
  const start = performance.now();
  try {
    const response = await fetch(url, {
      signal,
      redirect: "manual",
      headers: { accept: "*/*", "accept-encoding": "identity" },
    });
    await response.arrayBuffer().catch(() => {});
    const latency = Math.round(performance.now() - start);
    return {
      status: latency <= degradedThresholdMs ? HEALTH_STATUS.OPERATIONAL : HEALTH_STATUS.DEGRADED,
      success: true,
      message: "Reachable",
      responseTimeMs: latency,
      httpStatus: response.status,
      testedAt: Date.now(),
    };
  } catch (error) {
    const latency = Math.round(performance.now() - start);
    const timedOut = error?.name === "AbortError";
    return {
      status: HEALTH_STATUS.FAILED,
      success: false,
      message: timedOut ? "Request timeout" : `Connection failed: ${error?.cause?.code ?? error.message}`,
      responseTimeMs: latency,
      httpStatus: null,
      testedAt: Date.now(),
    };
  } finally {
    done();
  }
}

// ── ③ 用量查询脚本（usage_script.rs + UsageScriptModal 模板复刻）─────────
// 模板全文一字不动搬自 cc-switch src/components/UsageScriptModal.tsx PRESET_TEMPLATES。
export const USAGE_TEMPLATES = Object.freeze({
  custom: `({
  request: {
    url: "",
    method: "GET",
    headers: {}
  },
  extractor: function(response) {
    return {
      remaining: 0,
      unit: "USD"
    };
  }
})`,
  general: `({
  request: {
    url: "{{baseUrl}}/user/balance",
    method: "GET",
    headers: {
      "Authorization": "Bearer {{apiKey}}",
      "User-Agent": "cc-switch/1.0"
    }
  },
  extractor: function(response) {
    return {
      isValid: response.is_active || true,
      remaining: response.balance,
      unit: "USD"
    };
  }
})`,
  "new-api": `({
  request: {
    url: "{{baseUrl}}/api/user/self",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer {{accessToken}}",
      "User-Agent": "cc-switch/1.0",
      "New-Api-User": "{{userId}}"
    },
  },
  extractor: function (response) {
    if (response.success && response.data) {
      return {
        planName: response.data.group || "默认套餐",
        remaining: response.data.quota / 500000,
        used: response.data.used_quota / 500000,
        total: (response.data.quota + response.data.used_quota) / 500000,
        unit: "USD",
      };
    }
    return {
      isValid: false,
      invalidMessage: response.message || "查询失败"
    };
  },
})`,
});

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);
const USAGE_FIELDS = Object.freeze({
  isValid: "boolean",
  invalidMessage: "string",
  remaining: "number",
  total: "number",
  used: "number",
  unit: "string",
  planName: "string",
  extra: "string",
});

/** build_script_with_vars 复刻：四变量直替换（脚本永不出服务端，key 不进前端）。 */
function buildScriptWithVars(code, { apiKey = "", baseUrl = "", accessToken = "", userId = "" }) {
  return String(code)
    .replaceAll("{{apiKey}}", apiKey)
    .replaceAll("{{baseUrl}}", trimUrl(baseUrl))
    .replaceAll("{{accessToken}}", accessToken)
    .replaceAll("{{userId}}", userId);
}

/** validate_base_url 复刻：非 custom 模板强制 HTTPS（loopback 豁免）+ 有效主机名。 */
function validateBaseUrl(baseUrl) {
  if (!baseUrl) fail("base_url 不能为空", "USAGE_BASE_URL_EMPTY");
  const parsed = parseUrl(baseUrl, "无效的 base_url");
  if (parsed.protocol !== "https:" && !isLoopbackHost(parsed)) {
    fail("base_url 必须使用 HTTPS 协议（localhost 除外）", "USAGE_HTTPS_REQUIRED");
  }
  if (!parsed.hostname) fail("base_url 必须包含有效的主机名", "USAGE_BASE_URL_INVALID");
}

/** validate_request_url 复刻：HTTPS 强制 + 非 custom 同源同端口（port_or_known_default 语义）。 */
function validateRequestUrl(requestUrl, baseUrl, isCustomTemplate) {
  const parsedRequest = parseUrl(requestUrl, "无效的请求 URL");
  // 自建端点守卫：custom 模板会跳过下面的同源校验，请求地址完全由脚本决定，
  // 而请求头里带着 apiKey / accessToken —— 必须挡住元数据与保留段目标。
  assertProviderHostAllowed(parsedRequest, "用量脚本请求地址");
  if (!isCustomTemplate && parsedRequest.protocol !== "https:" && !isLoopbackHost(parsedRequest)) {
    fail("请求 URL 必须使用 HTTPS 协议（localhost 除外）", "USAGE_HTTPS_REQUIRED");
  }
  if (baseUrl && !isCustomTemplate) {
    const parsedBase = parseUrl(baseUrl, "无效的 base_url");
    if (parsedRequest.hostname !== parsedBase.hostname) {
      fail(`请求域名 ${parsedRequest.hostname} 与 base_url 域名 ${parsedBase.hostname} 不匹配（必须是同源请求）`, "USAGE_HOST_MISMATCH");
    }
    if (portOf(parsedRequest) !== portOf(parsedBase)) {
      fail(`请求端口 ${portOf(parsedRequest)} 必须与 base_url 端口 ${portOf(parsedBase)} 匹配`, "USAGE_PORT_MISMATCH");
    }
  }
}

const USAGE_WORKER_URL = new URL("./usage-script-worker.mjs", import.meta.url);
const USAGE_WORKER_TIMEOUT_MS = 1500;

function waitForUsageWorker(worker, expectedType, errorCode) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      callback(value);
    };
    const onMessage = (message) => {
      if (message?.type === "error") {
        finish(reject, Object.assign(new Error(message.message || "usage script worker failed"), { code: errorCode }));
      } else if (message?.type === expectedType) {
        finish(resolve, message);
      }
    };
    const onError = (error) => finish(reject, Object.assign(error, { code: errorCode }));
    const onExit = (code) => finish(reject, Object.assign(new Error(`usage script worker exited before ${expectedType} (code ${code})`), { code: errorCode }));
    const timer = setTimeout(() => {
      finish(reject, Object.assign(new Error(`usage script ${expectedType} timed out`), { code: errorCode }));
    }, USAGE_WORKER_TIMEOUT_MS);
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

async function closeUsageWorker(compiled) {
  if (!compiled || compiled.closed) return;
  compiled.closed = true;
  await compiled.worker.terminate().catch(() => {});
}

async function compileUsageScript(scriptSource) {
  const worker = new Worker(USAGE_WORKER_URL, {
    workerData: { scriptSource },
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 1 },
  });
  const compiled = { worker, request: null, closed: false };
  try {
    const message = await waitForUsageWorker(worker, "compiled", "USAGE_CONFIG_INVALID");
    compiled.request = JSON.parse(message.requestJson);
    return compiled;
  } catch (error) {
    await closeUsageWorker(compiled);
    fail(`执行配置脚本失败: ${error.message}`, error.code || "USAGE_CONFIG_INVALID");
  }
}

async function runUsageExtractor(compiled, responseJson) {
  compiled.worker.postMessage({ type: "extract", responseJson });
  try {
    const message = await waitForUsageWorker(compiled.worker, "extracted", "USAGE_EXTRACTOR_FAILED");
    return JSON.parse(message.resultJson);
  } catch (error) {
    fail(`执行 extractor 失败: ${error.message}`, error.code || "USAGE_EXTRACTOR_FAILED");
  } finally {
    await closeUsageWorker(compiled);
  }
}

function validateUsageResult(result) {
  const items = Array.isArray(result) ? result : [result];
  if (Array.isArray(result) && result.length === 0) fail("脚本返回的数组不能为空", "USAGE_RESULT_INVALID");
  items.forEach((item, index) => {
    if (typeof item !== "object" || item === null) fail(`数组索引[${index}]验证失败: 必须是对象`, "USAGE_RESULT_INVALID");
    for (const [key, type] of Object.entries(USAGE_FIELDS)) {
      if (key in item && item[key] !== null && item[key] !== undefined && typeof item[key] !== type) {
        fail(`数组索引[${index}]验证失败: ${key} 必须是 ${type} 或 null`, "USAGE_RESULT_INVALID");
      }
    }
  });
  return items;
}

/** execute_usage_script 复刻：模板替换 → base_url 闸 → eval 取 request → URL 闸 →
    发请求（非 2xx 截断 200 字符报错）→ eval extractor(response) → 结果校验。 */
export async function queryUsageScript({
  code,
  apiKey = "",
  baseUrl = "",
  timeout = 10,
  accessToken = "",
  userId = "",
  templateType = "custom",
}) {
  if (!String(code ?? "").trim()) fail("脚本内容不能为空", "USAGE_SCRIPT_EMPTY");
  const isCustomTemplate = templateType === "custom";
  const scriptSource = buildScriptWithVars(code, { apiKey, baseUrl, accessToken, userId });

  if (baseUrl && !isCustomTemplate) validateBaseUrl(trimUrl(baseUrl));

  const compiled = await compileUsageScript(scriptSource);
  try {
    const request = compiled.request;
    if (typeof request !== "object" || request === null) fail("缺少 request 配置", "USAGE_CONFIG_INVALID");
    const requestUrl = String(request.url ?? "");
    if (!requestUrl) fail("request.url 不能为空", "USAGE_CONFIG_INVALID");
    validateRequestUrl(requestUrl, trimUrl(baseUrl), isCustomTemplate);

    const method = String(request.method ?? "GET").toUpperCase();
    if (!HTTP_METHODS.has(method)) fail(`不支持的 HTTP 方法: ${method}`, "USAGE_METHOD_INVALID");
    const headers = {};
    if (request.headers && typeof request.headers === "object") {
      for (const [key, value] of Object.entries(request.headers)) headers[key] = String(value);
    }

    const { signal, done } = withTimeoutSignal(clampTimeout(timeout, 10));
    let response;
    try {
      response = await fetch(requestUrl, {
        method,
        headers,
        body: request.body != null && !["GET", "HEAD"].includes(method) ? String(request.body) : undefined,
        signal,
        redirect: "follow",
      });
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      fail(timedOut ? "请求失败: 超时" : `请求失败: ${error?.cause?.code ?? error.message}`, "USAGE_REQUEST_FAILED");
    } finally {
      done();
    }
    const text = await response.text().catch((error) => fail(`读取响应失败: ${error.message}`, "USAGE_READ_FAILED"));
    if (!response.ok) {
      const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
      fail(`HTTP ${response.status} : ${preview}`, "USAGE_HTTP_ERROR");
    }

    let responseJson;
    try {
      responseJson = JSON.parse(text);
    } catch (error) {
      fail(`解析响应 JSON 失败: ${error.message}`, "USAGE_RESPONSE_INVALID");
    }
    const extracted = await runUsageExtractor(compiled, responseJson);
    const data = validateUsageResult(extracted);
    return { success: true, data, error: null };
  } finally {
    await closeUsageWorker(compiled);
  }
}

/** query_usage 服务层：从 provider 解析凭据（script 显式值优先，回落 provider 主配置）。 */
export async function queryProviderUsage(provider, scriptOverride = null) {
  try {
    const script = scriptOverride ?? provider.meta?.usageScript;
    if (!script) fail("未配置用量查询脚本", "USAGE_SCRIPT_MISSING");
    if (scriptOverride === null && !script.enabled) fail("用量查询未启用", "USAGE_DISABLED");
    const apiKey = String(script.apiKey ?? "").trim() || provider.apiKey || "";
    const baseUrl = trimUrl(String(script.baseUrl ?? "").trim() || provider.baseUrl || "");
    return await queryUsageScript({
      code: script.code,
      apiKey,
      baseUrl,
      timeout: script.timeout ?? 10,
      accessToken: script.accessToken ?? "",
      userId: script.userId ?? "",
      templateType: script.templateType ?? "custom",
    });
  } catch (error) {
    // cc-switch 错误通道语义：确定性失败折叠成 success:false 展示文案
    return { success: false, data: null, error: error.message, code: error.code ?? null };
  }
}

/**
 * 缺省余额探测（无/未启用用量脚本时的回落）：one-api/new-api 兼容的 OpenAI 计费端点约定
 * （/v1/dashboard/billing/subscription + usage，Bearer sk- key；514claude/micu 实测可用）。
 * 第一方固定实现，不经脚本沙箱；apiKey 永不出服务端。total_usage 单位为美分（实测：795432.669 ↔ $7954.33）。
 */
export async function defaultBillingProbe(provider, fetchImpl = fetch) {
  const apiKey = String(provider?.apiKey ?? "").trim();
  const baseUrl = trimUrl(String(provider?.baseUrl ?? "").trim());
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    return { success: false, data: null, error: "供应商缺少请求地址，无法查询余额", code: "BALANCE_UNSUPPORTED" };
  }
  // 余额探测会把 Bearer apiKey 发往该地址，守卫不能省
  assertProviderHostAllowed(parseUrl(baseUrl, "无效的 base_url"), "base_url");
  if (!apiKey) {
    return { success: false, data: null, error: "供应商缺少 API Key，无法查询余额", code: "BALANCE_UNSUPPORTED" };
  }
  const origin = new URL(baseUrl).origin;
  const getJson = async (path) => {
    const res = await fetchImpl(origin + path, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* SPA/错误页等非 JSON 响应按不支持处理 */ }
    return { status: res.status, json };
  };
  try {
    const subscription = await getJson("/v1/dashboard/billing/subscription");
    if (subscription.status === 401 || subscription.status === 403) {
      return { success: false, data: null, error: `余额查询凭据被拒（HTTP ${subscription.status}）`, code: "BALANCE_UNAUTHORIZED" };
    }
    if (subscription.json?.object !== "billing_subscription") {
      return {
        success: false, data: null,
        error: "该供应商不支持余额查询（无 one-api 计费端点）；可在供应商用量脚本中自定义查询",
        code: "BALANCE_UNSUPPORTED",
      };
    }
    const usage = await getJson("/v1/dashboard/billing/usage");
    const usedCents = usage.json?.object === "list" ? Number(usage.json.total_usage) : Number.NaN;
    const used = Number.isFinite(usedCents) ? Math.round(usedCents) / 100 : null;
    const hardLimit = Number(subscription.json.hard_limit_usd) || 0;
    // 硬顶 ≥ 1e6 是 one-api 无限占位（默认 1e8）——如实标注无限，不假装精确余额
    if (hardLimit >= 1_000_000) {
      return {
        success: true,
        data: [{ planName: "默认额度", remaining: null, used, total: null, unit: "USD", extra: used != null ? `额度无限 · 已用 ${used} USD` : "额度无限" }],
        error: null,
      };
    }
    const remaining = used == null ? null : Math.max(0, Math.round((hardLimit - used) * 100) / 100);
    return {
      success: true,
      data: [{ planName: "默认额度", remaining, used, total: hardLimit, unit: "USD", ...(remaining === 0 ? { extra: "额度已用尽" } : {}) }],
      error: null,
    };
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "TimeoutError";
    return { success: false, data: null, error: `余额查询失败：${timedOut ? "超时" : (error?.cause?.code ?? error.message)}`, code: "BALANCE_REQUEST_FAILED" };
  }
}

// ── ④ ccswitch:// 深链接（deeplink/parser.rs provider 分支复刻）──────────
export function parseDeeplink(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl ?? "").trim());
  } catch (error) {
    fail(`Invalid deep link URL: ${error.message}`, "DEEPLINK_INVALID");
  }
  if (url.protocol !== "ccswitch:") fail(`Invalid scheme: expected 'ccswitch', got '${url.protocol.replace(":", "")}'`, "DEEPLINK_INVALID");
  if (url.hostname !== "v1") fail(`Unsupported protocol version: ${url.hostname}`, "DEEPLINK_INVALID");
  if (url.pathname !== "/import") fail(`Invalid path: expected '/import', got '${url.pathname}'`, "DEEPLINK_INVALID");
  const params = url.searchParams;
  const resource = params.get("resource");
  if (resource !== "provider") fail(`Unsupported resource type: ${resource ?? "(missing)"}`, "DEEPLINK_INVALID");

  const app = params.get("app") ?? "";
  if (!["claude", "codex", "gemini"].includes(app)) fail(`Invalid app type: must be claude/codex/gemini, got '${app}'`, "DEEPLINK_INVALID");
  const name = (params.get("name") ?? "").trim();
  if (!name) fail("Missing 'name' parameter", "DEEPLINK_INVALID");

  const endpointParam = params.get("endpoint") ?? "";
  const endpoints = endpointParam.split(",").map((item) => item.trim()).filter(Boolean);
  for (const endpoint of endpoints) {
    if (!/^https?:\/\//i.test(endpoint)) fail(`Invalid endpoint url: ${endpoint}`, "DEEPLINK_INVALID");
  }
  const homepage = (params.get("homepage") ?? "").trim();
  if (homepage && !/^https?:\/\//i.test(homepage)) fail(`Invalid homepage url: ${homepage}`, "DEEPLINK_INVALID");

  // endpoint 逗号分隔：第一个作主 baseUrl，其余进 customEndpoints（deeplink/provider.rs 语义）
  const usageEnabled = params.get("usageEnabled") === "true";
  const usageScriptCode = params.get("usageScript") ?? "";
  const meta = {};
  if (endpoints.length > 1) {
    meta.customEndpoints = endpoints.slice(1).map((endpoint) => ({ url: trimUrl(endpoint), addedAt: new Date().toISOString(), lastUsed: null }));
  }
  if (usageEnabled && usageScriptCode) {
    meta.usageScript = {
      enabled: true,
      code: usageScriptCode,
      timeout: 10,
      templateType: "custom",
      apiKey: params.get("usageApiKey") ?? "",
      baseUrl: params.get("usageBaseUrl") ?? "",
      accessToken: params.get("usageAccessToken") ?? "",
      userId: params.get("usageUserId") ?? "",
      autoQueryInterval: Math.min(1440, Math.max(0, Number(params.get("usageAutoInterval")) || 0)),
    };
  }

  const models = {};
  if (app === "claude") {
    const model = params.get("model") ?? "";
    if (model || params.get("haikuModel") || params.get("sonnetModel") || params.get("opusModel")) {
      models.claude = {
        ...(model ? { model } : {}),
        ...(params.get("haikuModel") ? { haikuModel: params.get("haikuModel") } : {}),
        ...(params.get("sonnetModel") ? { sonnetModel: params.get("sonnetModel") } : {}),
        ...(params.get("opusModel") ? { opusModel: params.get("opusModel") } : {}),
      };
    }
  } else if (params.get("model")) {
    models[app] = { model: params.get("model") };
  }

  return {
    name,
    baseUrl: trimUrl(endpoints[0] ?? ""),
    apiKey: params.get("apiKey") ?? "",
    websiteUrl: homepage,
    notes: params.get("notes") ?? "",
    icon: (params.get("icon") ?? "").trim().toLowerCase(),
    apps: { claude: app === "claude", codex: app === "codex", gemini: app === "gemini" },
    models,
    meta: Object.keys(meta).length ? meta : undefined,
  };
}

// ── ⑤ 模型可用性真实请求（testConfig.testModel/testPrompt 字段落地）──────
// cc-switch 3.x 只做可达性探测；真实小请求是其旧版能力——我们保留为可选加强：
// 回答"鉴权对不对、模型存不存在"（可达性检查刻意不回答的问题）。
export async function testModelRequest(provider, app) {
  const testConfig = provider.meta?.testConfig ?? {};
  const timeoutSecs = clampTimeout(testConfig.timeoutSecs, 8);
  const prompt = testConfig.testPrompt || "Hi";
  const baseUrl = trimUrl(provider.baseUrl);
  if (!baseUrl) fail("provider 缺少 baseUrl，无法发起模型测试", "VALIDATION_FAILED");
  if (!provider.apiKey) fail("provider 缺少 apiKey，无法发起模型测试", "VALIDATION_FAILED");
  assertProviderHostAllowed(parseUrl(baseUrl, "base_url 无效"), "base_url");

  const appConfig = provider.meta?.appConfig?.[app] ?? {};
  const settingsConfig = appConfig.settingsConfig ?? {};
  const declaredProtocol = String(
    provider.meta?.apiFormat
      || appConfig.apiFormat
      || settingsConfig.api
      || settingsConfig.api_mode
      || settingsConfig.apiMode
      || "",
  ).toLowerCase();
  const protocol = declaredProtocol.includes("gemini")
    ? "gemini"
    : declaredProtocol.includes("anthropic")
      ? "anthropic"
      : declaredProtocol.includes("responses")
        ? "openai-responses"
        : declaredProtocol.includes("chat") || declaredProtocol.includes("completions")
          ? "openai-chat"
          : app === "gemini"
            ? "gemini"
            : app === "claude" || app === "claude-desktop"
              ? "anthropic"
              : app === "grokbuild"
                ? "openai-responses"
                : "openai-chat";
  const model = testConfig.testModel || provider.models?.[app]?.model || provider.models?.claude?.model;
  if (!model) fail(`缺少测试模型（testConfig.testModel 或 models.${app}.model）`, "VALIDATION_FAILED");

  let request;
  if (protocol === "anthropic") {
    // Claude Code 端约定：baseUrl 已带 /v1 时不双写
    const url = baseUrl.endsWith("/v1") ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
    request = {
      url,
      headers: { "content-type": "application/json", "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01", authorization: `Bearer ${provider.apiKey}` },
      body: { model, max_tokens: 1, messages: [{ role: "user", content: prompt }] },
    };
  } else if (protocol === "openai-chat") {
    request = {
      url: app === "codex" && provider.meta?.isFullUrl ? baseUrl : `${codexBaseUrl(baseUrl)}/chat/completions`,
      headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
      body: { model, max_tokens: 1, messages: [{ role: "user", content: prompt }] },
    };
  } else if (protocol === "openai-responses") {
    request = {
      url: app === "codex" && provider.meta?.isFullUrl ? baseUrl : `${codexBaseUrl(baseUrl)}/responses`,
      headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
      body: { model, input: prompt, max_output_tokens: 1 },
    };
  } else if (protocol === "gemini") {
    request = {
      url: `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`,
      headers: { "content-type": "application/json" },
      body: { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1 } },
    };
  }

  const { signal, done } = withTimeoutSignal(timeoutSecs);
  const start = performance.now();
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    });
    const latency = Math.round(performance.now() - start);
    const text = await response.text().catch(() => "");
    if (response.ok) {
      return { success: true, status: "operational", httpStatus: response.status, responseTimeMs: latency, message: "模型可用" };
    }
    const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
    return { success: false, status: "failed", httpStatus: response.status, responseTimeMs: latency, message: `HTTP ${response.status}: ${preview}` };
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    return {
      success: false,
      status: "failed",
      httpStatus: null,
      responseTimeMs: Math.round(performance.now() - start),
      message: timedOut ? "Request timeout" : `Connection failed: ${error?.cause?.code ?? error.message}`,
    };
  } finally {
    done();
  }
}
