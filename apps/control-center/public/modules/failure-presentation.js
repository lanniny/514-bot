const DEFAULT_SUMMARY_LIMIT = 400;

const ORIGIN_TIMEOUT_NAMES = new Set([
  "origin_response_timeout",
  "connection_timeout",
]);

function structuredPayload(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function numericStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

export function providerFailurePresentation(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const payload = structuredPayload(raw);
  const apiStatus = numericStatus(raw.match(/^\s*API Error:\s*(\d{3})\b/i)?.[1]);
  if (!apiStatus) return null;
  const status = apiStatus;
  const errorName = String(payload?.error_name ?? payload?.error?.name ?? "").trim().toLowerCase();
  const originTimeout = status === 524 || ORIGIN_TIMEOUT_NAMES.has(errorName);

  if (originTimeout) {
    return {
      kind: "origin-timeout",
      status: status || 524,
      title: "上游响应超时",
      summary: payload?.owner_action_required === true
        ? "服务已建立连接，但上游没有在代理窗口内返回完整响应。当前原生轮已结束，可稍后显式重试。"
        : "服务已建立连接，但未在代理等待窗口内返回完整响应。请查看当前运行状态后再决定是否继续。",
      detail: raw,
    };
  }

  return {
    kind: "provider-error",
    status,
    title: "上游服务请求失败",
    summary: `本轮没有得到可确认的完整响应${status ? `（HTTP ${status}）` : ""}。请查看技术详情，并按当前恢复状态继续。`,
    detail: raw,
  };
}

export function failurePresentation(value, { summaryLimit = DEFAULT_SUMMARY_LIMIT } = {}) {
  const raw = String(value ?? "").trim();
  const provider = providerFailurePresentation(raw);
  if (provider) return provider;

  if (/reached maximum budget|CLAUDE_BUDGET_EXHAUSTED/i.test(raw)) {
    return {
      kind: "budget-exhausted",
      status: null,
      title: "本轮预算已耗尽",
      summary: "原生轮已在预算边界结束。调整下一轮预算或降低 Effort 后，再显式发送消息继续。",
      detail: raw,
    };
  }

  if (/content block not found/i.test(raw)) {
    return {
      kind: "content-block-error",
      status: null,
      title: "原生会话上下文块失效",
      summary: "当前轮已结束，但这个原生会话可能无法继续稳定重放。可先执行 /compact，或新建会话。",
      detail: raw,
    };
  }

  if (/^Recovery acknowledgement could not drain durable work\b/i.test(raw)) {
    return {
      kind: "recovery-blocked",
      status: null,
      title: "仍有待核对的原生工作",
      summary: "上一轮仍有提交状态不明的原生工作。为避免重复执行，系统已阻止自动重放。",
      detail: raw,
    };
  }

  if (raw.length > summaryLimit) {
    return {
      kind: "long-error",
      status: null,
      title: "错误详情",
      summary: `${raw.slice(0, summaryLimit)}…`,
      detail: raw,
    };
  }

  return {
    kind: "error",
    status: null,
    title: "错误详情",
    summary: raw,
    detail: null,
  };
}
