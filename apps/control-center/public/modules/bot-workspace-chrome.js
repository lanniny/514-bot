/**
 * bot-workspace-chrome.js — 协作台退役后，Bot 侧栏 / overflow / 设置共用的纯函数。
 * 不渲染工作台 CSS，不把 workbench 当可导航表面。
 */
import { ACTIVE_RUN_STATES, TERMINAL_RUN_STATES } from "../state.js";
import { conversationListsRun } from "./conversation-run-ownership.js";
import { COLLAB_STATUS, collabStatusOf, COLLAB_SEMANTICS } from "./collab/collab-status.js";

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

// 运行 chip 文案 = collab-status 唯一词典的 compact 用语（紧凑列表用语）。
// 此前 21 条本地映射与 collaboration-process / utils 三套并存且互相矛盾；
// 现在只保留「词典 → chip 形态」这一层投影，值刻意与历史文案一致以免改变既有观感
// （tests/bot-workspace-chrome.test.mjs:74/97-99 锁定）。
export const BOT_RUN_STATUS_CHIPS = Object.freeze(Object.fromEntries(
  Object.entries(COLLAB_STATUS)
    .filter(([, view]) => view.layer === "run")
    .map(([key, view]) => [key, Object.freeze({ label: view.compact, tone: view.chipTone })]),
));

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

export function botRunStatusChip(status, { pendingAsk = false } = {}) {
  const view = collabStatusOf(status, { pendingAsk });
  return { label: view.compact, tone: view.chipTone };
}

/**
 * 运行状态阻塞在谁身上。null = 不表达阻塞归属。
 * waiting-user（等你动手）与 waiting-peer（等同伴接手）必须可区分——
 * 二者此前同归 attention，用户无法判断该谁行动。
 * @returns {{key: string, label: string, icon: string, tone: string}|null}
 */
export function botRunSemantic(status, { pendingAsk = false } = {}) {
  const key = collabStatusOf(status, { pendingAsk }).semantic;
  if (!key) return null;
  const view = COLLAB_SEMANTICS[key];
  return view ? { key, ...view } : null;
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
  collapsedGroups = null,
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
  // 分组折叠集合：调用方传 Set 或数组都吃。折叠只藏行、不丢行——展开是即时的，
  // 不需要重新取一次 runs 快照。
  const collapsed = collapsedGroups instanceof Set
    ? collapsedGroups
    : new Set((Array.isArray(collapsedGroups) ? collapsedGroups : []).map(String).filter(Boolean));
  const grouped = groups
    .map((group) => {
      const rows = group.items.filter((run) => visibleIds.has(String(run.id || "")));
      if (!rows.length) return "";
      const isCollapsed = collapsed.has(group.id);
      const rowsId = `bot-run-group-rows-${group.id}`;
      return `<section class="bot-active-run-group${isCollapsed ? " is-collapsed" : ""}" data-bot-run-group="${escapeHtml(group.id)}">
          <button class="bot-active-run-group-title" type="button" aria-expanded="${isCollapsed ? "false" : "true"}" aria-controls="${rowsId}" data-bot-run-group-toggle="${escapeHtml(group.id)}">
            <svg class="icon lucide bot-active-run-chevron" aria-hidden="true"><use href="#lucide-chevron-down"></use></svg>
            <span>${escapeHtml(group.label)}</span><b>${rows.length}</b>
          </button>
          <div class="bot-active-run-rows" id="${rowsId}" role="group"${isCollapsed ? " hidden" : ""}>${rows.map((run) => botActiveRunRowMarkup(run, rowOptions)).join("")}</div>
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

/**
 * 「待我处理」计数：已回答的 ask 不再计入待办。
 * 面板摘要行与 chip 都用它，避免两处各算一遍算歪。
 */
export function botOpsInboxCount(inbox) {
  const asks = Array.isArray(inbox?.pendingAsks) ? inbox.pendingAsks : [];
  return asks.filter((ask) => String(ask?.lifecycle || "") !== "answered").length;
}

/**
 * 会话协作收件箱（方案 B）的行内渲染。
 *
 * 数据来自 GET /api/bots/inbox?conversationId=，该路由复用 collaboration-inbox 的投影
 * （见 src/bots/inbox.mjs 头注）。这里只做呈现，不加工语义。
 * 纪律：源降级必须如实显示，不得让 partial/degraded 看起来像完整的 ok。
 *
 * @param {object|null} inbox 接口载荷；null = 当前会话没有收件箱（尚未运行 / 会话不存在）
 * @param {string} [error] 读取失败原因；非空时只呈现失败，绝不拿旧载荷冒充新鲜
 */
export function botOpsInboxMarkup(inbox, { escapeHtml, error } = {}) {
  if (typeof escapeHtml !== "function") return "";
  const failure = String(error || "").trim();
  if (failure) {
    // 读取失败必须自己说出来（同 loadApprovals 的失败纪律）：静默保留旧载荷 = 把陈旧当新鲜。
    // 不在这里加 role="status"：容器 #bot-ops-inbox-list 已是 aria-live="polite"，
    // 再嵌一层 live region 会让同一条消息被播报两次（2026-09-11 W4 / 审计 S6）。
    return `<p class="bot-ops-empty" data-tone="error">收件箱读取失败：${escapeHtml(failure)}</p>`;
  }
  if (!inbox) return `<p class="bot-ops-empty">当前会话还没有协作收件箱——发送消息启动运行后这里会出现等你回答的事项</p>`;
  const asks = Array.isArray(inbox.pendingAsks) ? inbox.pendingAsks : [];
  const diagnostics = inbox.diagnostics && typeof inbox.diagnostics === "object" ? inbox.diagnostics : {};
  const issues = Array.isArray(diagnostics.issues) ? diagnostics.issues : [];
  const degraded = diagnostics.status === "partial" || diagnostics.status === "degraded";
  // 「看到的不全」要按**真实成因**说，不能一律归给「运行没读全」：
  // 运行级截断看 runsRead/runsTotal，消息窗口满则来自 INBOX_MESSAGES_TRUNCATED
  // （messages 先被截断再过滤 pendingAsks，旧 ask 会掉出窗口）。
  const runsTruncated = diagnostics.runsTruncated === true
    || Number(diagnostics.runsRead ?? 0) < Number(diagnostics.runsTotal ?? 0);
  const reasons = [];
  if (runsTruncated) {
    reasons.push(`${escapeHtml(String(diagnostics.runsRead ?? 0))}/${escapeHtml(String(diagnostics.runsTotal ?? 0))} 个运行`);
  }
  for (const issue of issues.slice(0, 2)) {
    reasons.push(escapeHtml(String(issue?.message || "部分来源不可读")));
  }
  const notice = degraded
    ? `<p class="bot-ops-inbox-notice" data-tone="warning">仅显示可读部分${reasons.length ? `（${reasons.join("；")}）` : ""}</p>`
    : "";
  if (!asks.length) {
    // 消息窗口满时不得断言「没有待办」——那正是最该被提醒的场景，静默假阴性比不说更糟。
    const emptyText = issues.some((issue) => issue?.code === "INBOX_MESSAGES_TRUNCATED")
      ? "当前窗口内没有待你回答的事项（更早的可能未列出）"
      : "没有需要你回答的协作事项";
    return `${notice}<p class="bot-ops-empty">${emptyText}</p>`;
  }
  const rows = asks.map((ask) => {
    const from = String(ask?.from || "未知成员");
    const text = String(ask?.text || "").trim();
    const runTitle = String(ask?.runTitle || "").trim();
    const lifecycle = String(ask?.lifecycle || "");
    const lifecycleLabel = lifecycle === "answered" ? "已回答" : lifecycle === "delivered" ? "待你回答" : "";
    // 可回答的行必须是**真的可操作**：此前只发了 data-bot-ask-id / data-run-id
    // 却零消费者，行是死的——用户看到「等你回答」却无从回答（2026-10-09 审计）。
    // 这里补上按钮语义（role/tabindex/aria-label），点击与键盘由 app.js 的
    // 委托处理器接（唯一出口：复用 transcript 卡片的作答目标路径）。
    // 已回答的行**不给**按钮语义——它没有可执行的动作，做成按钮是另一种谎。
    const actionable = lifecycle !== "answered";
    const openAttrs = actionable
      ? ` role="button" tabindex="0" data-bot-ask-open aria-label="${escapeHtml(`${from} 的问题，${lifecycleLabel || "打开作答"}`)}"`
      : "";
    return `<article class="bot-ops-ask${actionable ? " is-actionable" : ""}" data-bot-ask-id="${escapeHtml(String(ask?.id || ""))}" data-run-id="${escapeHtml(String(ask?.runId || ""))}"${openAttrs}>
        <div class="bot-ops-approval-copy">
          <strong>${escapeHtml(from)} 在等你回答</strong>
          <span>${escapeHtml(text || "（无正文）")}</span>
          ${runTitle ? `<small>${escapeHtml(runTitle)}</small>` : ""}
        </div>
        ${lifecycleLabel ? `<span class="bot-ops-ask-state" data-state="${escapeHtml(lifecycle)}">${escapeHtml(lifecycleLabel)}</span>` : ""}
      </article>`;
  }).join("");
  return `${notice}<div class="bot-ops-ask-list">${rows}</div>`;
}

export function botMemberConnectionsMarkup(members = [], { escapeHtml } = {}) {
  if (typeof escapeHtml !== "function") return "";
  const items = Array.isArray(members) ? members : [];
  if (!items.length) return `<p class="bot-ops-empty">还没有可观测的成员席位</p>`;
  // 零信息态不必列 N 行：全席位同为「没配置主机」时，5 行说的是同一件事
  // （2026-09-11 截图实测：计数 0/5，下面 5 行文字完全相同）。
  // 收敛成一行摘要；**任一席位有差异**（有人连上 / 有人断开）才逐行——那才是需要分辨的时候。
  if (items.every((member) => member?.configured !== true)) {
    return `<p class="bot-ops-empty">${escapeHtml(String(items.length))} 个席位均未配置主机</p>`;
  }
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
