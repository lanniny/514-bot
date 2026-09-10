/**
 * bot-workspace-chrome.js — 协作台退役后，Bot 侧栏 / overflow / 设置共用的纯函数。
 * 不渲染工作台 CSS，不把 workbench 当可导航表面。
 */
import { ACTIVE_RUN_STATES } from "../state.js";

export function retireWorkbenchView(view) {
  return view === "workbench" || view === "experience" ? "bot" : view;
}

export function isRetiredWorkbenchHash(hash) {
  return /^#\/?workbench(?:[/?]|$)/.test(String(hash || ""));
}

export function botConversationForRun(conversations = [], runId) {
  const id = String(runId || "");
  if (!id) return null;
  return conversations.find((item) => (
    String(item?.activeRunId || "") === id
    || (Array.isArray(item?.runIds) && item.runIds.map(String).includes(id))
  )) || null;
}

export const BOT_ACTIVE_RUNS_PREVIEW = 6;

export const BOT_RUN_STATUS_CHIPS = Object.freeze({
  queued: { label: "排队中", tone: "waiting" },
  waiting_agent: { label: "等待中", tone: "waiting" },
  waiting_user: { label: "等待中", tone: "waiting" },
  waiting_input: { label: "等待中", tone: "waiting" },
  waiting: { label: "等待中", tone: "waiting" },
  waiting_approval: { label: "待审批", tone: "attention" },
  waiting_for_approval: { label: "待审批", tone: "attention" },
  planning: { label: "规划中", tone: "running" },
  executing: { label: "进行中", tone: "running" },
  integrating: { label: "进行中", tone: "running" },
  verifying: { label: "验证中", tone: "running" },
  active: { label: "进行中", tone: "running" },
  running: { label: "进行中", tone: "running" },
  recovery_required: { label: "需恢复", tone: "error" },
  interrupted: { label: "已中断", tone: "warning" },
  succeeded: { label: "已完成", tone: "complete" },
  complete: { label: "已完成", tone: "complete" },
  completed: { label: "已完成", tone: "complete" },
  failed: { label: "失败", tone: "error" },
  cancelled: { label: "已取消", tone: "muted" },
  canceled: { label: "已取消", tone: "muted" },
});

export function botRunStatusChip(status) {
  const key = String(status || "").toLowerCase().replaceAll("-", "_");
  return BOT_RUN_STATUS_CHIPS[key] || { label: "状态未知", tone: "muted" };
}

export function listActiveRuns(runs = []) {
  return (Array.isArray(runs) ? runs : []).filter((run) => (
    ACTIVE_RUN_STATES.has(run?.status) || run?.status === "interrupted"
  ));
}

export function isWorkbenchViewActive(root = globalThis.document) {
  return Boolean(root?.getElementById?.("view-workbench")?.classList.contains("is-active"));
}

function botActiveRunRowMarkup(run, { escapeHtml, selectedRunId = "" } = {}) {
  const id = String(run.id || "");
  const title = String(run.title || run.prompt || "未命名任务").replace(/\s+/g, " ").trim();
  const preview = title.length > 64 ? `${title.slice(0, 64)}…` : title;
  const current = id === String(selectedRunId);
  const chip = botRunStatusChip(run.status);
  return `<button class="bot-active-run${current ? " is-current" : ""}" type="button" data-bot-active-run="${escapeHtml(id)}" aria-current="${current ? "true" : "false"}">
      <strong>${escapeHtml(preview || "未命名任务")}</strong>
      <span class="bot-run-status-chip is-${escapeHtml(chip.tone)}" data-bot-run-status="${escapeHtml(String(run.status || ""))}">${escapeHtml(chip.label)}</span>
    </button>`;
}

export function botActiveRunsMarkup(runs, {
  escapeHtml,
  selectedRunId = "",
  expanded = false,
  previewLimit = BOT_ACTIVE_RUNS_PREVIEW,
} = {}) {
  const items = listActiveRuns(runs);
  if (!items.length || typeof escapeHtml !== "function") return "";
  const limit = Number.isFinite(previewLimit) ? Math.max(1, previewLimit) : BOT_ACTIVE_RUNS_PREVIEW;
  const visible = expanded || items.length <= limit ? items : items.slice(0, limit);
  const hiddenCount = items.length - visible.length;
  const rows = visible.map((run) => botActiveRunRowMarkup(run, { escapeHtml, selectedRunId })).join("");
  if (!hiddenCount) {
    return items.length > limit
      ? `${rows}<button class="bot-active-runs-more" type="button" data-bot-active-runs-collapse>收起列表</button>`
      : rows;
  }
  return `${rows}<button class="bot-active-runs-more" type="button" data-bot-active-runs-expand>还有 ${hiddenCount} 项工作</button>`;
}

export function selectOptionsMarkup(options, selected, { escapeHtml } = {}) {
  if (typeof escapeHtml !== "function") return "";
  return (Array.isArray(options) ? options : []).map((option) => {
    const value = String(option?.value ?? option?.id ?? "");
    const label = String(option?.label ?? value);
    const current = value === String(selected ?? "");
    return `<option value="${escapeHtml(value)}"${current ? " selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
}

export function normalizeComposerPermission(value) {
  return value === "build" || value === "review" ? value : "plan";
}
