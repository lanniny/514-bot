/**
 * api.js — 514cc Console API 客户端
 *
 * 从 app.js 抽取的 API 请求层。
 * v4.0 app.js 组件化第二步：API 请求 + token 管理独立模块。
 */

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
  run: (id) => `/api/runs/${encodeURIComponent(id)}`,
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
  accessToken = token;
  resolveApiReady(); // 无论哪条引导路径（api.js 或 app.js 本地 initializeAccessToken），token 落定即放行自举模块
}

export class ApiError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
    const errorPayload = payload && typeof payload === "object" ? payload.error ?? payload : null;
    this.code = typeof errorPayload?.code === "string" ? errorPayload.code : null;
  }
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

  let response;
  try {
    response = await fetch(safePath, init);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ApiError(`网络请求失败：${error?.message ?? error}`, 0, null);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await response.json().catch(() => null) : await response.text().catch(() => null);

  if (!response.ok) {
    const errorPayload = payload && typeof payload === "object" ? payload.error ?? payload : null;
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
  let response;
  try {
    response = await fetch(safePath, { method, headers, signal: options.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ApiError(`网络请求失败：${error?.message ?? error}`, 0, null);
  }
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : await response.text().catch(() => null);
    const errorPayload = payload && typeof payload === "object" ? payload.error ?? payload : null;
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
export async function initializeAccessToken() {
  try {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const fragmentToken = fragment.get("token")?.trim() ?? "";
  const bootstrapNonce = fragment.get("bootstrap")?.trim() ?? "";

  if (bootstrapNonce) {
    let response;
    try {
      response = await fetch("/auth/bootstrap", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ nonce: bootstrapNonce }),
      });
      const payload = await response.json().catch(() => null);
      const issuedToken = typeof payload?.token === "string" ? payload.token.trim() : "";
      if (!response.ok || !issuedToken) {
        const detail = payload?.error?.message ?? payload?.error ?? payload?.message ?? `HTTP ${response.status}`;
        throw new ApiError(`启动登录凭据兑换失败：${detail}`, response.status, payload);
      }
      sessionStorage.setItem(TOKEN_KEY, issuedToken);
      accessToken = issuedToken;
    } finally {
      history.replaceState(null, "", `${url.pathname}${url.search}`);
    }
    return true;
  }

  if (fragmentToken) {
    sessionStorage.setItem(TOKEN_KEY, fragmentToken);
    accessToken = fragmentToken;
    history.replaceState(null, "", `${url.pathname}${url.search}`);
    return true;
  }

  const stored = sessionStorage.getItem(TOKEN_KEY)?.trim() ?? "";
  if (stored) {
    accessToken = stored;
    return true;
  }

  return false;
  } finally {
    resolveApiReady();
  }
}
