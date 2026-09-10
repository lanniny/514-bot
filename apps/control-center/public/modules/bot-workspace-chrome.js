/**
 * bot-workspace-chrome.js — 协作台退役后，Bot 侧栏 / overflow / 设置共用的纯函数。
 * 不渲染工作台 CSS，不把 workbench 当可导航表面。
 */
import { ACTIVE_RUN_STATES, TERMINAL_RUN_STATES } from "../state.js";
import { conversationListsRun } from "./conversation-run-ownership.js";

export { conversationListsRun };

export function retireWorkbenchView(view) {
  return view === "workbench" || view === "experience" ? "bot" : view;
}

export function isRetiredWorkbenchHash(hash) {
  return /^#\/?workbench(?:[/?]|$)/.test(String(hash || ""));
}

export function botConversationForRun(conversations = [], runId, run = null) {
  const id = String(runId || run?.id || "");
  if (!id) return null;
  const items = Array.isArray(conversations) ? conversations : [];
  if (run?.conversationId) {
    return items.find((item) => String(item?.id || "") === String(run.conversationId)) || null;
  }
  const claimed = items.filter((item) => conversationListsRun(item, id));
  if (claimed.length === 1) return claimed[0];
  if (claimed.length > 1) {
    return claimed.find((item) => String(item?.activeRunId || "") === id) || claimed[0];
  }
  return null;
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

export const BOT_RUN_STATUS_GROUPS = Object.freeze([
  { id: "attention", label: "待审批", tone: "attention" },
  { id: "running", label: "进行中", tone: "running" },
  { id: "waiting", label: "等待中", tone: "waiting" },
  { id: "warning", label: "已中断", tone: "warning" },
  { id: "error", label: "需恢复", tone: "error" },
]);

export const BOT_CONNECTION_TONES = Object.freeze({
  ok: { label: "已连接", tone: "ok" },
  warn: { label: "待确认", tone: "warn" },
  error: { label: "断开", tone: "error" },
  probing: { label: "探测中", tone: "probing" },
  unknown: { label: "未探测", tone: "unknown" },
  none: { label: "未配置", tone: "none" },
});

const MEMBER_HOST_KEYS = Object.freeze([
  "hostId",
  "sshHostId",
  "computerHostId",
  "remoteHostId",
]);

export function botMemberAssignedHost(member, hosts = []) {
  const items = Array.isArray(hosts) ? hosts : [];
  const memberId = String(member?.id || "").trim();
  const declared = MEMBER_HOST_KEYS
    .map((key) => String(member?.[key] || member?.computer?.[key] || "").trim())
    .filter(Boolean);
  if (declared.length) {
    return items.find((host) => declared.includes(String(host?.id || ""))) || {
      id: declared[0],
      missing: true,
    };
  }
  if (!memberId) return null;
  return items.find((host) => (
    String(host?.memberId || "") === memberId
    || String(host?.agentId || "") === memberId
  )) || null;
}

export function botHostConnectionTone(host, probe) {
  if (!host || host.missing || host.enabled === false) {
    return host?.missing ? BOT_CONNECTION_TONES.error : BOT_CONNECTION_TONES.unknown;
  }
  const status = String(probe?.status || "").toLowerCase();
  if (status === "ok" || status === "healthy") return BOT_CONNECTION_TONES.ok;
  if (status === "error" || status === "failed") return BOT_CONNECTION_TONES.error;
  if (status === "loading" || status === "probing") return BOT_CONNECTION_TONES.probing;
  if (status === "unconfirmed" || status === "warning") return BOT_CONNECTION_TONES.warn;
  return BOT_CONNECTION_TONES.unknown;
}

export function botMemberComputerRows({
  members = [],
  hosts = [],
  probes = {},
} = {}) {
  const hostList = Array.isArray(hosts) ? hosts.filter((host) => host && host.id) : [];
  const probeMap = probes instanceof Map ? probes : new Map(Object.entries(probes || {}));
  return (Array.isArray(members) ? members : []).map((member) => {
    const assigned = botMemberAssignedHost(member, hostList);
    if (!assigned) {
      return {
        id: member?.id || "",
        label: member?.label || member?.id || "未命名成员",
        cli: member?.cli || "",
        tone: "none",
        hostId: "",
        configured: false,
      };
    }
    const tone = botHostConnectionTone(assigned, probeMap.get(String(assigned.id)));
    const target = assigned.missing
      ? "主机缺失"
      : assigned.enabled === false
        ? "已停用"
        : assigned.user && assigned.host
          ? `${assigned.user}@${assigned.host}`
          : assigned.name || assigned.host || assigned.id;
    return {
      id: member?.id || "",
      label: member?.label || member?.id || "未命名成员",
      cli: target,
      tone: tone.tone,
      hostId: String(assigned.id || ""),
      configured: true,
    };
  });
}

export function botUnassignedHostRows(members = [], hosts = [], probes = {}) {
  const assignedIds = new Set(
    (Array.isArray(members) ? members : [])
      .map((member) => botMemberAssignedHost(member, hosts)?.id)
      .filter(Boolean)
      .map(String),
  );
  const probeMap = probes instanceof Map ? probes : new Map(Object.entries(probes || {}));
  return (Array.isArray(hosts) ? hosts : [])
    .filter((host) => host && host.id && !assignedIds.has(String(host.id)))
    .map((host) => {
      const tone = botHostConnectionTone(host, probeMap.get(String(host.id)));
      return {
        ...host,
        tone: tone.tone,
        statusLabel: host.enabled === false ? "已停用" : tone.label,
      };
    });
}

export function botMemberComputerCount(rows = []) {
  const items = Array.isArray(rows) ? rows : [];
  return {
    connected: items.filter((row) => row?.tone === "ok").length,
    configured: items.filter((row) => row?.configured).length,
    total: items.length,
  };
}

export function botRunStatusChip(status) {
  const key = String(status || "").toLowerCase().replaceAll("-", "_");
  return BOT_RUN_STATUS_CHIPS[key] || { label: "状态未知", tone: "muted" };
}

export function listActiveRuns(runs = []) {
  return (Array.isArray(runs) ? runs : []).filter((run) => (
    ACTIVE_RUN_STATES.has(run?.status) || run?.status === "interrupted"
  ));
}

export function listFinishedRuns(runs = []) {
  return (Array.isArray(runs) ? runs : []).filter((run) => TERMINAL_RUN_STATES.has(run?.status));
}

export function listRecoverableRuns(runs = []) {
  return listActiveRuns(runs).filter((run) => {
    const tone = botRunStatusChip(run.status).tone;
    return tone === "error" || tone === "warning";
  });
}

export function botRunAgentId(run) {
  return String(run?.executionOwnerId || run?.startAgentId || run?.coordinatorId || run?.agentId || "").trim();
}

export function botRunTimestamp(run) {
  return run?.updatedAt || run?.createdAt || run?.startedAt || "";
}

export function groupActiveRuns(runs = [], filter = "all") {
  const items = listActiveRuns(runs).filter((run) => (
    filter === "all" || botRunStatusChip(run.status).tone === filter
  ));
  const groups = BOT_RUN_STATUS_GROUPS
    .map((group) => ({
      ...group,
      items: items.filter((run) => botRunStatusChip(run.status).tone === group.tone),
    }))
    .filter((group) => group.items.length);
  return { items, groups };
}

export function isWorkbenchViewActive(root = globalThis.document) {
  return Boolean(root?.getElementById?.("view-workbench")?.classList.contains("is-active"));
}

function botActiveRunRowMarkup(run, {
  escapeHtml,
  selectedRunId = "",
  agentLabel = (id) => id,
  formatRelative = () => "",
} = {}) {
  const id = String(run.id || "");
  const title = String(run.title || run.prompt || "未命名任务").replace(/\s+/g, " ").trim();
  const preview = title.length > 72 ? `${title.slice(0, 72)}…` : title;
  const current = id === String(selectedRunId);
  const chip = botRunStatusChip(run.status);
  const agentId = botRunAgentId(run);
  const agent = agentId ? String(agentLabel(agentId) || agentId).trim() : "";
  const stamp = formatRelative(botRunTimestamp(run), "");
  const meta = [agent, stamp].filter(Boolean);
  return `<button class="bot-active-run${current ? " is-current" : ""}" type="button" data-bot-active-run="${escapeHtml(id)}" aria-current="${current ? "true" : "false"}">
      <span class="bot-active-run-main">
        <strong>${escapeHtml(preview || "未命名任务")}</strong>
        ${meta.length ? `<span class="bot-active-run-meta">${meta.map((part) => `<span>${escapeHtml(part)}</span>`).join("<i aria-hidden=\"true\">·</i>")}</span>` : ""}
      </span>
      <span class="bot-run-status-chip is-${escapeHtml(chip.tone)}" data-bot-run-status="${escapeHtml(String(run.status || ""))}">${escapeHtml(chip.label)}</span>
    </button>`;
}

export function botActiveRunFiltersMarkup(runs = [], { escapeHtml, filter = "all" } = {}) {
  if (typeof escapeHtml !== "function") return "";
  const items = listActiveRuns(runs);
  if (!items.length) return "";
  const counts = Object.fromEntries(BOT_RUN_STATUS_GROUPS.map((group) => [
    group.id,
    items.filter((run) => botRunStatusChip(run.status).tone === group.tone).length,
  ]));
  const chips = [
    { id: "all", label: "全部", count: items.length },
    ...BOT_RUN_STATUS_GROUPS
      .map((group) => ({ id: group.id, label: group.label, count: counts[group.id] }))
      .filter((chip) => chip.count),
  ];
  return `<div class="bot-active-run-filters" role="tablist" aria-label="按状态筛选正在工作">
      ${chips.map((chip) => {
        const current = chip.id === String(filter || "all");
        return `<button class="bot-active-run-filter${current ? " is-active" : ""}" type="button" role="tab" aria-selected="${current ? "true" : "false"}" data-bot-run-filter="${escapeHtml(chip.id)}">${escapeHtml(chip.label)}<b>${chip.count}</b></button>`;
      }).join("")}
    </div>`;
}

export function botActiveRunsToolbarMarkup(runs = [], { escapeHtml } = {}) {
  if (typeof escapeHtml !== "function") return "";
  const finished = listFinishedRuns(runs).length;
  const recoverable = listRecoverableRuns(runs).length;
  if (!finished && !recoverable) return "";
  const parts = [];
  if (finished) {
    parts.push(`<button class="bot-active-runs-clean" type="button" data-bot-clear-finished>清理已结束 · ${finished}</button>`);
  }
  if (recoverable) {
    parts.push(`<span class="bot-active-runs-hint">需恢复 ${recoverable} 项，点开任务确认</span>`);
  }
  return `<div class="bot-active-runs-actions">${parts.join("")}</div>`;
}

export function botActiveRunsMarkup(runs, {
  escapeHtml,
  selectedRunId = "",
  expanded = false,
  previewLimit = BOT_ACTIVE_RUNS_PREVIEW,
  filter = "all",
  agentLabel = (id) => id,
  formatRelative = () => "",
} = {}) {
  const { items, groups } = groupActiveRuns(runs, filter);
  if (!items.length || typeof escapeHtml !== "function") return "";
  const limit = Number.isFinite(previewLimit) ? Math.max(1, previewLimit) : BOT_ACTIVE_RUNS_PREVIEW;
  const visibleItems = expanded || items.length <= limit ? items : items.slice(0, limit);
  const visibleIds = new Set(visibleItems.map((run) => String(run.id || "")));
  const hiddenCount = items.length - visibleItems.length;
  const rowOptions = { escapeHtml, selectedRunId, agentLabel, formatRelative };
  const grouped = groups
    .map((group) => {
      const rows = group.items.filter((run) => visibleIds.has(String(run.id || "")));
      if (!rows.length) return "";
      return `<section class="bot-active-run-group" data-bot-run-group="${escapeHtml(group.id)}">
          <div class="bot-active-run-group-title">${escapeHtml(group.label)}<b>${rows.length}</b></div>
          ${rows.map((run) => botActiveRunRowMarkup(run, rowOptions)).join("")}
        </section>`;
    })
    .filter(Boolean)
    .join("");
  if (!hiddenCount) {
    return items.length > limit
      ? `${grouped}<button class="bot-active-runs-more" type="button" data-bot-active-runs-collapse>收起列表</button>`
      : grouped;
  }
  return `${grouped}<button class="bot-active-runs-more" type="button" data-bot-active-runs-expand>还有 ${hiddenCount} 项工作</button>`;
}

export function botPendingApprovals(approvals = []) {
  return (Array.isArray(approvals) ? approvals : []).filter((item) => (item?.status ?? "pending") === "pending");
}

export function botOpsApprovalsMarkup(approvals = [], { escapeHtml } = {}) {
  if (typeof escapeHtml !== "function") return "";
  const pending = botPendingApprovals(approvals);
  if (!pending.length) {
    return `<p class="bot-ops-empty">没有待处理审批</p>`;
  }
  return pending.map((item) => {
    const id = String(item.id || "");
    const method = String(item.method || "unknown");
    const runId = String(item.runId || "--");
    const broadPermission = method === "item/permissions/requestApproval";
    return `<article class="bot-ops-approval">
        <div class="bot-ops-approval-copy">
          <strong>${escapeHtml(method)}</strong>
          <span>Run ${escapeHtml(runId)}</span>
        </div>
        <div class="bot-ops-approval-actions">
          <button class="bot-text-button" type="button" data-approval-id="${escapeHtml(id)}" data-approval-decision="deny">拒绝</button>
          <button class="bot-text-button" type="button" data-approval-id="${escapeHtml(id)}" data-approval-decision="approve"${broadPermission ? " disabled" : ""}>批准</button>
        </div>
      </article>`;
  }).join("");
}

export function botMemberConnectionsMarkup(members = [], { escapeHtml } = {}) {
  if (typeof escapeHtml !== "function") return "";
  const items = Array.isArray(members) ? members : [];
  if (!items.length) return `<p class="bot-ops-empty">还没有可观测的成员席位</p>`;
  return items.map((member) => {
    const tone = BOT_CONNECTION_TONES[member?.tone] || BOT_CONNECTION_TONES.none;
    const label = String(member?.label || member?.id || "未命名成员");
    const detail = member?.configured
      ? [member?.cli, tone.label].filter(Boolean).join(" · ")
      : tone.label;
    return `<div class="bot-connection-row is-${escapeHtml(tone.tone)}" data-bot-connection="${escapeHtml(String(member?.id || ""))}">
        <span class="bot-connection-dot" aria-hidden="true"></span>
        <span class="bot-connection-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></span>
      </div>`;
  }).join("");
}

export function botHostConnectionsMarkup(hosts = [], { escapeHtml } = {}) {
  if (typeof escapeHtml !== "function") return "";
  const items = (Array.isArray(hosts) ? hosts : []).filter((host) => host && host.id);
  if (!items.length) return "";
  return `<div class="bot-connection-hosts" aria-label="已登记主机">
      ${items.map((host) => {
        const tone = BOT_CONNECTION_TONES[host?.tone] || botHostConnectionTone(host);
        const label = String(host.name || host.host || host.id);
        const target = host.user && host.host ? `${host.user}@${host.host}` : host.host;
        const detail = [target, host.statusLabel || tone.label].filter(Boolean).join(" · ");
        return `<div class="bot-connection-row is-${escapeHtml(tone.tone)}" data-bot-host="${escapeHtml(String(host.id))}">
            <span class="bot-connection-dot" aria-hidden="true"></span>
            <span class="bot-connection-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></span>
          </div>`;
      }).join("")}
    </div>`;
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
