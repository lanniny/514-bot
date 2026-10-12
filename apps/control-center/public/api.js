/**
 * api.js — 514cc Console API 客户端
 *
 * 从 app.js 抽取的 API 请求层。
 * v4.0 app.js 组件化第二步：API 请求 + token 管理独立模块。
 */

import { createControlConnectionState } from "./modules/control-connection-state.js";

export const controlConnection = createControlConnectionState();

const API = Object.freeze({
  bootstrap: "/api/bootstrap",
  health: "/api/health",
  sources: "/api/config/sources",
  runs: "/api/runs",
  projects: "/api/projects",
  project: (id) => `/api/projects/${encodeURIComponent(id)}`,
  conversations: "/api/conversations",
  purgeDeletedConversations: "/api/conversations/deleted",
  conversation: (id) => `/api/conversations/${encodeURIComponent(id)}`,
  duplicateConversation: (id) => `/api/conversations/${encodeURIComponent(id)}/duplicate`,
  forkConversation: (id) => `/api/conversations/${encodeURIComponent(id)}/fork`,
  parseConversationFile: (id) => `/api/conversations/${encodeURIComponent(id)}/parse-file`,
  conversationCheckpoints: (id) => `/api/conversations/${encodeURIComponent(id)}/checkpoints`,
  conversationEvidenceMatrix: (id) => `/api/conversations/${encodeURIComponent(id)}/evidence-matrix`,
  conversationDistillWorkflow: (id) => `/api/conversations/${encodeURIComponent(id)}/distill-workflow`,
  run: (id) => `/api/runs/${encodeURIComponent(id)}`,
  runCheckpoints: (id) => `/api/runs/${encodeURIComponent(id)}/checkpoints`,
  runEvidenceMatrix: (id) => `/api/runs/${encodeURIComponent(id)}/evidence-matrix`,
  runDeliverable: (id) => `/api/runs/${encodeURIComponent(id)}/deliverable`,
  runDistillWorkflow: (id) => `/api/runs/${encodeURIComponent(id)}/distill-workflow`,
  assistantMemories: "/api/assistant/memories",
  assistantMemory: (id) => `/api/assistant/memories/${encodeURIComponent(id)}`,
  assistantMemoryPromptChunk: "/api/assistant/memories/prompt-chunk",
  assistantResidence: "/api/assistant/residence",
  assistantHeartbeat: "/api/assistant/residence/heartbeat",
  assistantDismissHint: "/api/assistant/residence/dismiss-hint",
  assistantResumeRun: "/api/assistant/residence/resume-run",
  routerPreview: "/api/router/preview",
  events: "/api/events",
  approvals: "/api/approvals",
  leases: "/api/leases",
  runtimeReload: "/api/runtime/reload",
  remoteGates: "/api/security/remote-gates",
  remoteGateGrant: "/api/security/remote-gates/grant",
  remoteGateRevoke: "/api/security/remote-gates/revoke",
  obsSummary: "/api/observability/summary",
  obsRouteGate: "/api/observability/routegate",
  obsDelta: "/api/observability/delta",
  obsHandoffs: "/api/observability/handoffs",
  obsDrift: "/api/observability/drift",
  obsOps: "/api/observability/ops",
  // v48 S0 · P-21 产品行为埋点（纯本地，不外发）
  telemetryRecord: "/api/telemetry/record",
  telemetrySummary: "/api/telemetry/summary",
  telemetrySettings: "/api/telemetry/settings",
  telemetryClear: "/api/telemetry",
  // v48 S0-5 · P-24 产品反馈闭环
  feedback: "/api/feedback",
  feedbackStatus: (id) => `/api/feedback/${encodeURIComponent(id)}/status`,
  worktrees: "/api/system/worktrees",
  sessions: "/api/sessions",
  sessionProjects: "/api/sessions/projects",
  capabilities: "/api/capabilities",
  hooks: "/api/hooks",
  teams: "/api/teams",
  teamBackground: (teamId) => `/api/team-backgrounds/${encodeURIComponent(teamId)}`,
  globalWallpaper: "/api/wallpapers/global",
  teamInbox: (teamId) => `/api/teams/${encodeURIComponent(teamId)}/inbox`,
  teamAttention: (teamId) => `/api/teams/${encodeURIComponent(teamId)}/attention`,
  teamInboxAction: (teamId, action) => `/api/teams/${encodeURIComponent(teamId)}/inbox/${encodeURIComponent(action)}`,
  runReplay: (runId) => `/api/runs/${encodeURIComponent(runId)}/replay`,
  runSettlement: (runId) => `/api/runs/${encodeURIComponent(runId)}/settlement`,
  readiness: "/api/readiness",
  readinessDraft: "/api/readiness/draft",
  teamMembers: "/api/team-members",
  adapterTemplates: "/api/adapter-templates",
  runtimeSeats: "/api/runtime-seats",
  agentActions: "/api/agents/actions",
  agentNativeSettings: (agent) => `/api/agents/native-settings?agent=${encodeURIComponent(agent)}`,
  providers: "/api/providers",
  providerLive: "/api/providers/live",
  providerSwitch: "/api/providers/switch",
  providerPreview: "/api/providers/preview",
  providerApplyTeam: "/api/providers/apply-team",
  providerTestEndpoints: "/api/providers/test-endpoints",
  providerUsageTemplates: "/api/providers/usage-templates",
  providerPresets: "/api/providers/presets",
  providerFetchModels: "/api/providers/fetch-models",
  providerUsageTest: "/api/providers/usage-test",
  providerSort: "/api/providers/sort",
  providerExport: "/api/providers/export",
  providerImport: "/api/providers/import",
  providerParseDeeplink: "/api/providers/parse-deeplink",
  providerImportDeeplink: "/api/providers/import-deeplink",
  providerEnvConflicts: "/api/providers/env-conflicts",
  providerCommonConfig: "/api/providers/common-config",
  providerBackups: "/api/providers/backups",
  providerBackup: (name) => `/api/providers/backups/${encodeURIComponent(name)}`,
  providerBackupRestore: (name) => `/api/providers/backups/${encodeURIComponent(name)}/restore`,
  providerFailover: (app) => `/api/providers/failover/${encodeURIComponent(app)}`,
  providerDuplicate: (id) => `/api/providers/${encodeURIComponent(id)}/duplicate`,
  providerCheck: (id) => `/api/providers/${encodeURIComponent(id)}/check`,
  providerModelTest: (id) => `/api/providers/${encodeURIComponent(id)}/model-test`,
  providerUsage: (id) => `/api/providers/${encodeURIComponent(id)}/usage`,
  ccswitchDomain: "/api/ccswitch/domain",
  ccswitchProxy: "/api/ccswitch/proxy",
  ccswitchProxyUsageOverview: "/api/ccswitch/proxy/usage/overview",
  ccswitchAuth: "/api/ccswitch/auth",
  workbenchEnvironment: "/api/workbench/environment",
  projectBridge: "/api/project-bridge",
  releaseRecord: "/api/release-record",
  releaseRecordCommands: "/api/release-record/commands",
  releaseTruth: "/api/release-truth",
  workbenchGitPlan: "/api/workbench/git/plan",
  workbenchGitExecute: "/api/workbench/git/execute",
  operatorProfile: "/api/operator-profile",
  operatorAvatar: "/api/avatars/operator",
  memberAvatar: (id) => `/api/avatars/members/${encodeURIComponent(id)}`,
  preferences: "/api/preferences",
});

const TOKEN_KEY = "514cc-control-token";
let accessToken = "";

let _apiReadyResolve;
/** 首次 token 初始化完成后 resolve——自举模块（collab-flow/memory-browser）在就绪前不发请求，避免 401 竞态。 */
export const apiReady = new Promise((resolve) => { _apiReadyResolve = resolve; });
function resolveApiReady() {
  if (!_apiReadyResolve) return;
  _apiReadyResolve(getAccessToken() || null);
  _apiReadyResolve = null;
}

export { API, TOKEN_KEY };

export function getAccessToken() {
  return accessToken;
}

export function setAccessToken(token) {
  if (accessToken !== token) controlConnection.reset();
  accessToken = token;
  resolveApiReady(); // 无论哪条引导路径（api.js 或 app.js 本地 initializeAccessToken），token 落定即放行自举模块
}

export class ApiError extends Error {
  constructor(message, status = 0, payload = null, { outcomeUnknown = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
    // 结果未确认标记：网络层失败时非幂等请求可能已被服务端接收并落库。
    // 创建类流程（assistant-start 对话框等）靠它进「核对」而非「重试」分支，
    // 缺此标记会把「可能已创建」误报成「没创建」，诱导用户重试造成重复创建。
    this.outcomeUnknown = outcomeUnknown;
    const errorPayload = payload && typeof payload === "object" ? payload.error ?? payload : null;
    this.code = typeof errorPayload?.code === "string" ? errorPayload.code : null;
  }
}

// 网络层失败（fetch 自身抛出且非 AbortError）的统一出口：
// GET/HEAD 无副作用直报；其余方法的结果对调用方未确认。
function networkFailure(method, error) {
  if (method === "GET" || method === "HEAD") {
    return new ApiError(`网络请求失败：${error?.message ?? error}`, 0, null);
  }
  return new ApiError("网络请求失败，服务端可能已接收——状态未确认，请刷新列表核对", 0, null, { outcomeUnknown: true });
}

function sameOriginApiPath(path) {
  const raw = String(path ?? "");
  const origin = globalThis.location?.origin;
  if (origin && origin !== "null") {
    let target;
    try {
      target = new URL(raw, origin);
    } catch {
      throw new ApiError("API 路径无效", 0, null);
    }
    if (target.origin !== origin) {
      throw new ApiError("API 请求必须保持同源，已拒绝外部地址", 0, null);
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) {
    // Node 行为测试没有 location；此时仍拒绝绝对/协议相对 URL，避免测试或未来复用把 token 带出本机。
    throw new ApiError("API 请求必须使用同源相对路径", 0, null);
  }
  return raw;
}

/**
 * 通用 API 请求函数
 * @param {string} path - API 路径
 * @param {Object} options - fetch 选项
 * @returns {Promise<any>} 响应数据
 */
export async function request(path, options = {}) {
  const safePath = sameOriginApiPath(path);
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers ?? {});
  headers.set("Accept", "application/json");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const init = { method, headers, signal: options.signal };
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    // 调用方传已序列化的字符串时不能再包一层：双重序列化会让服务端 JSON.parse 出一个
    // 字符串字面量而非对象，取字段全是 undefined——请求照样 200，但参数被整个丢掉。
    // （LO 2026-08-08「终端输入不了」的根因：input 每次都写入空串。）
    init.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }

  const ticket = controlConnection.begin(safePath, { method });
  let response;
  try {
    response = await fetch(safePath, init);
  } catch (error) {
    controlConnection.finish(ticket, { aborted: error?.name === "AbortError" });
    if (error?.name === "AbortError") throw error;
    throw networkFailure(method, error);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  let payload;
  try {
    payload = isJson ? await response.json() : await response.text();
  } catch (error) {
    if (error?.name === "AbortError") {
      controlConnection.finish(ticket, { status: response.status, aborted: true });
      throw error;
    }
    payload = null;
  }
  controlConnection.finish(ticket, { status: response.status, payload, decoded: isJson && payload !== null });

  if (!response.ok) {
    const errorPayload = payload && typeof payload === "object" ? payload.error ?? payload : null;
    // 认证失效是**全局**故障，不是某个功能的局部故障：令牌按内核进程签发，内核一重启
    // 旧凭据即全废，于是每个后台加载都会失败、各自弹一条服务端英文诊断——把「一个原因」
    // 说成「N 个功能坏了」（2026-09-11 截图实证）。这里在唯一咽喉点归一成可执行的中文，
    // 由 toast() 收敛成一条；原始 payload 仍随 ApiError 上抛供诊断。
    if (response.status === 401 && String(errorPayload?.code ?? "") === "UNAUTHORIZED") {
      throw new ApiError("会话凭据已失效", 401, payload);
    }
    const detail =
      errorPayload && typeof errorPayload === "object"
        ? errorPayload.message ?? errorPayload.detail ?? errorPayload.code
        : errorPayload ?? (payload && typeof payload === "object" ? payload.message ?? payload.detail : payload);
    throw new ApiError(detail ? String(detail) : `${method} ${safePath} 返回 HTTP ${response.status}`, response.status, payload);
  }
  return payload;
}

export async function requestBlob(path, options = {}) {
  const safePath = sameOriginApiPath(path);
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers ?? {});
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const ticket = controlConnection.begin(safePath, { method, data: false });
  let response;
  try {
    response = await fetch(safePath, { method, headers, signal: options.signal });
  } catch (error) {
    controlConnection.finish(ticket, { aborted: error?.name === "AbortError" });
    if (error?.name === "AbortError") throw error;
    throw networkFailure(method, error);
  }
  controlConnection.finish(ticket, { status: response.status });
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : await response.text().catch(() => null);
    const errorPayload = payload && typeof payload === "object" ? payload.error ?? payload : null;
    // 与 request() 同一约定：认证失效归一成可执行的中文，不在二进制路径上漏出原始英文诊断。
    if (response.status === 401 && String(errorPayload?.code ?? "") === "UNAUTHORIZED") {
      throw new ApiError("会话凭据已失效", 401, payload);
    }
    const detail = errorPayload && typeof errorPayload === "object"
      ? errorPayload.message ?? errorPayload.detail ?? errorPayload.code
      : errorPayload ?? (typeof payload === "string" ? payload : null);
    throw new ApiError(detail ? String(detail) : `${method} ${safePath} 返回 HTTP ${response.status}`, response.status, payload);
  }
  return response.blob();
}

/**
 * 初始化访问 token（从 sessionStorage 或 URL fragment 恢复）
 * @returns {Promise<boolean>} 是否成功获取 token
 */
/**
 * 启动凭据的早期快照。
 *
 * 为什么必须在模块加载期抓：凭据可能以 `#bootstrap=<nonce>` 片段形式进来，而应用自己的
 * hash 路由会在启动早期把 `location.hash` 改写成 `#bot`，把凭据片段一起顶掉。
 * 2026-09-18 隔离复现坐实：内核打印 `#bootstrap=…` → 页面落地 `#bot` → hasToken=false →
 * 所有 `/api/*` 401（用户看到「运行与配置工作台加载失败：会话凭据已失效」）。
 * 本模块被 app.js 在最顶部 import，模块求值早于任何路由代码，因此这里是可靠的最早点。
 *
 * 修法两条并行：①内核改印查询串（凭据不再与路由共享 `#`，见 server.mjs 启动打印处）；
 * ②这里保留快照，让**片段形态**（旧外壳/其它启动器）也不再依赖竞态顺序。
 */
const EARLY_CREDENTIAL_SNAPSHOT = (() => {
  try {
    return { search: String(globalThis.location?.search ?? ""), hash: String(globalThis.location?.hash ?? "") };
  } catch {
    return { search: "", hash: "" };
  }
})();

function credentialFromParams(raw) {
  const params = new URLSearchParams(raw.startsWith("#") ? raw.slice(1) : raw);
  const nonce = params.get("bootstrap")?.trim();
  if (nonce) return { kind: "bootstrap", value: nonce };
  const token = params.get("token")?.trim();
  if (token) return { kind: "token", value: token };
  return null;
}

/** 按「当前 URL → 早期快照」的顺序找启动凭据（片段与查询串都认）。 */
export function readStartupCredential() {
  let search = "";
  let hash = "";
  try {
    search = String(globalThis.location?.search ?? "");
    hash = String(globalThis.location?.hash ?? "");
  } catch {
    // 无 location（Node 行为测试）：只依赖快照
  }
  for (const raw of [hash, EARLY_CREDENTIAL_SNAPSHOT.hash, search, EARLY_CREDENTIAL_SNAPSHOT.search]) {
    if (!raw) continue;
    const found = credentialFromParams(raw);
    if (found) return found;
  }
  return null;
}

/**
 * 兑换掉凭据后把它从地址栏摘干净。
 * 必须真的删掉 `bootstrap`/`token` 参数：单次 nonce 留在 URL 上，刷新时会拿已消费的 nonce
 * 再兑换一次，直接抛「兑换失败」并且**不会**退回已存 token —— 那会把刷新变成一次故障。
 * 路由 hash 若已不是凭据则原样保留，别把用户的视图位置一并抹掉。
 */
export function stripStartupCredential() {
  try {
    const location = globalThis.location;
    const params = new URLSearchParams(location.search);
    params.delete("bootstrap");
    params.delete("token");
    const query = params.toString();
    const hash = /bootstrap=|token=/.test(location.hash) ? "" : location.hash;
    globalThis.history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${hash}`);
  } catch {
    // 无 history（Node 行为测试）时无可摘
  }
}

export async function initializeAccessToken() {
  try {
  const credential = readStartupCredential();
  const stored = sessionStorage.getItem(TOKEN_KEY)?.trim() ?? "";

  if (credential?.kind === "bootstrap") {
    let response;
    try {
      response = await fetch("/auth/bootstrap", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ nonce: credential.value }),
      });
      const payload = await response.json().catch(() => null);
      const issuedToken = typeof payload?.token === "string" ? payload.token.trim() : "";
      if (!response.ok || !issuedToken) {
        const detail = payload?.error?.message ?? payload?.error ?? payload?.message ?? `HTTP ${response.status}`;
        throw new ApiError(`启动登录凭据兑换失败：${detail}`, response.status, payload);
      }
      sessionStorage.setItem(TOKEN_KEY, issuedToken);
      setAccessToken(issuedToken);
    } catch (error) {
      // 已消费/过期的 nonce 不该毁掉一个本来可用的会话：手上还有 token 就继续用它。
      // 没有可用的 token 才把错误抛出去——那才是真的登不进去。
      if (!stored) throw error;
      setAccessToken(stored);
    } finally {
      stripStartupCredential();
    }
    return true;
  }

  if (credential?.kind === "token") {
    sessionStorage.setItem(TOKEN_KEY, credential.value);
    setAccessToken(credential.value);
    stripStartupCredential();
    return true;
  }

  if (stored) {
    setAccessToken(stored);
    return true;
  }

  return false;
  } finally {
    resolveApiReady();
  }
}
