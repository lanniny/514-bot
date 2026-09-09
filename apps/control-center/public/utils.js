/**
 * utils.js — 514cc Console 通用工具函数
 *
 * 从 app.js 抽取的纯函数，无副作用，可被任何模块复用。
 * v4.0 app.js 组件化第一步：把 9000 行巨石按职责拆分。
 */

// ─── HTML 转义 ───────────────────────────────────────────────

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeAttr(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ─── 脱敏 ───────────────────────────────────────────────────

export function redact(value) {
  return String(value ?? "")
    .replace(/(bearer\s+)[a-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]")
    .replace(/(basic\s+)[a-z0-9+/=]{12,}/gi, "$1[REDACTED]")
    .replace(/((?:api[-_]?key|access[-_]?key|secret|token|password|passwd|passphrase|auth(?:orization)?|credential|private[-_]?key|cookie)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-(?:proj-)?|xai-|gh[pousr]_|github_pat_)[a-z0-9_.-]{12,}\b/gi, "[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}

// ─── 格式化 ─────────────────────────────────────────────────

export function formatDate(value, fallback = "--") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatTime(value, fallback = "--") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatRelative(value, fallback = "--") {
  if (!value) return fallback;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return String(value);
  const diff = Date.now() - time;
  if (diff < 0) return formatDate(value, fallback);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDate(value, fallback);
}

// Grok 式会话列表日期徽章：当天 → HH:mm；当年 → M/d；跨年 → Y/M/d。
export function formatConversationStamp(value, fallback = "") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  const now = new Date();
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export function formatDuration(value) {  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  const milliseconds = number > 0 && number < 20 ? number * 1000 : number;
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)} s`;
}

export function compactHash(value) {
  const hash = String(value ?? "").trim();
  if (!hash) return "--";
  return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

// ─── 状态规范化 ──────────────────────────────────────────────

export function normalizeStatus(value) {
  if (value === true) return "ok";
  if (value === false) return "error";
  const raw = String(value ?? "unknown").toLowerCase().replaceAll("-", "_");
  if (["ok", "healthy", "ready", "connected", "online", "available", "consistent", "pass", "passed", "dormant"].includes(raw)) return "ok";
  if (["warn", "warning", "degraded", "drift", "stale", "partial", "interrupted", "pending", "connecting", "external_unverified", "unconfigured", "disabled"].includes(raw)) return raw === "pending" || raw === "connecting" ? "pending" : "warning";
  if (["error", "failed", "down", "offline", "unavailable", "invalid", "blocked", "missing"].includes(raw)) return "error";
  return "unknown";
}

export function statusText(value) {
  const raw = String(value ?? "").toLowerCase().replaceAll("-", "_");
  const special = { dormant: "待命", missing: "未安装", unconfigured: "未配置", disabled: "已禁用" };
  if (special[raw]) return special[raw];
  const status = normalizeStatus(value);
  return { ok: "正常", warning: "需关注", error: "异常", pending: "检查中", unknown: "未知" }[status];
}

export function runStatusText(value, run = null) {
  if (run?.pendingAsk && String(value).toLowerCase().replaceAll("-", "_") === "waiting_agent") return "等你回答";
  const status = String(value ?? "unknown").toLowerCase().replaceAll("-", "_");
  return {
    planning: "规划中", waiting_for_approval: "等待审批", waiting_approval: "等待审批",
    waiting_agent: "等待 Agent", recovery_required: "需人工恢复", queued: "已排队",
    executing: "执行中", running: "执行中", active: "执行中", integrating: "综合中",
    verifying: "验证中", complete: "已完成", completed: "已完成", succeeded: "已完成",
    interrupted: "已中断，可继续", blocked: "已阻塞", failed: "失败", cancelled: "已取消", canceled: "已取消",
  }[status] ?? "未知";
}

// ─── 数据工具 ────────────────────────────────────────────────

export function unwrapList(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of [...keys, "items", "data", "results"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

export function objectList(payload, keys = []) {
  const list = unwrapList(payload, keys);
  if (list.length) return list;
  if (!payload || typeof payload !== "object") return [];
  for (const key of keys) {
    const value = payload[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.entries(value).map(([id, item]) =>
        item && typeof item === "object" ? { id, ...item } : { id, status: item },
      );
    }
  }
  return [];
}
