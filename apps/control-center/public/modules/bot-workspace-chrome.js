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

export function listActiveRuns(runs = []) {
  return (Array.isArray(runs) ? runs : []).filter((run) => (
    ACTIVE_RUN_STATES.has(run?.status) || run?.status === "interrupted"
  ));
}

export function botActiveRunsMarkup(runs, { escapeHtml, selectedRunId = "" } = {}) {
  const items = listActiveRuns(runs);
  if (!items.length || typeof escapeHtml !== "function") return "";
  return items.map((run) => {
    const id = String(run.id || "");
    const title = String(run.title || run.prompt || "未命名任务").replace(/\s+/g, " ").trim();
    const preview = title.length > 64 ? `${title.slice(0, 64)}…` : title;
    const current = id === String(selectedRunId);
    return `<button class="bot-active-run${current ? " is-current" : ""}" type="button" data-bot-active-run="${escapeHtml(id)}" aria-current="${current ? "true" : "false"}">
      <strong>${escapeHtml(preview || "未命名任务")}</strong>
      <span>${escapeHtml(String(run.status || "running"))}</span>
    </button>`;
  }).join("");
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
