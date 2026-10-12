/**
 * 团队运行面 v2：Agent 身份来自 /api/teams，provider 只是绑定，不把 CLI profile
 * 冒充成 514cc 治理花名册。状态只由持久 run/taskGraph 和 health 探针推导。
 * v4.0 Forge：Lucide 图标 + --agent-* 品牌变量（零硬编码 hex，色彩全走 forge tokens）。
 */
import { lucideIcon } from "./lucide.js";
import { memberAvatarMarkup, officialCliIconMarkup } from "./modules/avatars.js";
import { escapeHtml } from "./utils.js";

const ACTIVE_RUN_STATES = new Set([
  "queued", "planning", "running", "waiting_agent", "executing", "integrating", "verifying", "active",
]);
const ACTIVE_TASK_STATES = new Set(["queued", "running", "waiting_agent", "executing", "integrating", "verifying", "active"]);
const ACTIVE_ATTEMPT_PHASES = new Set(["prepared", "session_ready", "submitting", "submitted"]);
const DEFAULT_TEAM_ID = "team-514cc";

/** 契约品牌变量（forge tokens）：--agent-claude/codex/grok/kimi/pi/cursor；其余走 team.css 本地扩展。 */
const CONTRACT_BRANDS = new Set(["claude", "codex", "grok", "kimi", "pi", "cursor"]);
const AGENT_ALIAS_BRAND = Object.freeze({
  "烛": "codex", "织": "grok", "匠": "other", "策": "other", "鉴": "other",
});
const PROVIDER_ALIAS_BRAND = Object.freeze({
  anthropic: "claude",
  openai: "codex",
  xai: "grok",
  moonshot: "kimi",
  google: "gemini",
  "multi-provider": "pi",
});

export const PROFILE_META = Object.freeze({
  "claude-fable": { name: "Claude Fable", title: "规划编排席", provider: "claude", role: "规划 · 编排 · 综合" },
  "codex-technical": { name: "烛", title: "Codex 技术", provider: "codex", role: "实现 · 评审 · 验证" },
  "grok-search": { name: "织", title: "Grok 情报", provider: "grok", role: "检索 · 调研 · 取证" },
  "grok-build": { name: "Grok Build", title: "快速执行", provider: "grok", role: "快执行 · 快综合" },
  "kimi-frontend": { name: "Kimi", title: "前端工程", provider: "kimi", role: "前端 · UI · 走查" },
  "pi-resident": { name: "Pi", title: "Resident", provider: "pi", role: "RPC · 工具编排" },
  "gemini-research": { name: "Gemini", title: "研究席", provider: "gemini", role: "研究 · 长上下文" },
});

const PROFILE_ROLE_PRESENTATION = Object.freeze({
  "primary-coordinator": { title: "规划编排席", role: "规划 · 编排 · 综合" },
  "technical-executor": { title: "技术执行席", role: "实现 · 评审 · 验证" },
  "current-intelligence": { title: "情报研究席", role: "检索 · 调研 · 取证" },
  "fast-executor": { title: "快速执行席", role: "快执行 · 快综合" },
  "frontend-engineer": { title: "前端工程席", role: "前端 · UI · 走查" },
  "resident-agent": { title: "常驻代理席", role: "RPC · 工具编排" },
  "research-specialist": { title: "研究席", role: "研究 · 长上下文" },
});

/** 由 provider / agentId / 花名推导品牌 key（claude|codex|grok|kimi|pi|cursor|gemini|other）。 */
export function agentBrandKey(raw = "") {
  const text = String(raw ?? "").toLowerCase();
  for (const [provider, brand] of Object.entries(PROVIDER_ALIAS_BRAND)) {
    if (text.includes(provider)) return brand;
  }
  for (const brand of CONTRACT_BRANDS) if (text.includes(brand)) return brand;
  if (text.includes("gemini")) return "gemini";
  for (const [alias, brand] of Object.entries(AGENT_ALIAS_BRAND)) {
    if (String(raw ?? "").includes(alias)) return brand;
  }
  return "other";
}

/** 配置目录给出 provider 时以它为真源；只有目录缺值才使用静态身份兜底。 */
export function resolveCatalogBrand(provider, fallback = "") {
  const configured = String(provider ?? "").trim();
  return agentBrandKey(configured || fallback);
}

/** 品牌 key → 色彩变量引用（供 SVG style 等需要值的场景；绝不返回 hex）。 */
export function agentBrandVar(brand) {
  if (CONTRACT_BRANDS.has(brand)) return `var(--agent-${brand})`;
  if (brand === "gemini") return "var(--agent-gemini, var(--muted-foreground))";
  return "var(--agent-other, var(--muted-foreground))";
}

export function sessionAgentId(session) {
  if (typeof session === "string") return session.trim();
  if (!session || typeof session !== "object") return "";
  return String(session.agentId ?? session.agent_id ?? session.agent ?? session.name ?? "").trim();
}

export function normalizeRunSessions(rawSessions, coordinatorId = "") {
  const arrayInput = Array.isArray(rawSessions);
  const entries = arrayInput
    ? rawSessions.map((session) => [sessionAgentId(session), session])
    : rawSessions && typeof rawSessions === "object"
      ? Object.entries(rawSessions)
      : [];
  return entries.map(([key, value]) => {
    const base = value && typeof value === "object" ? value : { sessionId: value };
    const agentId = arrayInput
      ? sessionAgentId(base) || String(key || "").trim()
      : String(key || "").trim() || sessionAgentId(base);
    const declaredRole = String(base.role ?? base.kind ?? "").trim();
    const role = coordinatorId
      ? agentId === coordinatorId
        ? "orchestrator"
        : declaredRole === "orchestrator" ? "worker" : declaredRole || "worker"
      : declaredRole || "worker";
    return {
      ...base,
      agentId,
      sessionId: base.sessionId ?? base.session_id ?? base.id ?? null,
      role,
    };
  });
}

export function sessionAgentIds(sessions) {
  return [...new Set(normalizeRunSessions(sessions).map(sessionAgentId).filter(Boolean))];
}

export function selectPipelineRoot(sessions, coordinatorId = "") {
  const list = Array.isArray(sessions) ? sessions : [];
  if (coordinatorId) {
    const coordinator = list.find((session) => sessionAgentId(session) === coordinatorId);
    if (coordinator) return coordinator;
  }
  const explicit = list.find((session) => session?.role === "orchestrator");
  if (explicit) return explicit;
  return list.find((session) => session && (
    (Object.hasOwn(session, "parent_session_id") && session.parent_session_id === null)
      || (Object.hasOwn(session, "parentSessionId") && session.parentSessionId === null)
  )) || null;
}

export function profileRolePresentation(role, known = {}) {
  const raw = String(role || "").trim();
  const mapped = PROFILE_ROLE_PRESENTATION[raw];
  if (mapped) return mapped;
  if (raw) {
    const label = raw.replace(/[-_]+/g, " · ");
    return { title: label, role: label };
  }
  return { title: known.title || "运行席", role: known.role || "团队成员" };
}

function memberMeta(id, coordinatorId, catalogById) {
  const known = PROFILE_META[id] || {};
  const catalog = catalogById.get(id) || {};
  const provider = String(catalog.provider || known.provider || String(id).split("-")[0] || "unknown");
  const presentation = profileRolePresentation(catalog.role, known);
  return {
    id,
    name: catalog.label || known.name || id,
    title: presentation.title,
    provider,
    brand: resolveCatalogBrand(catalog.provider, `${known.provider || ""} ${id}`),
    avatar: catalog.avatar === "custom" ? "custom" : "",
    role: presentation.role,
    layer: id === coordinatorId ? "leader" : "member",
  };
}

function matchingHealth(components, agent) {
  const normalized = components.map((item) => ({ ...item, key: String(item?.id ?? item?.name ?? "").toLowerCase() }));
  const exact = normalized.find((item) => item.key === agent.id.toLowerCase());
  if (exact) return exact;
  return normalized.find((item) => item.key === agent.provider || item.key.includes(agent.provider)) || null;
}

function healthStatus(component) {
  if (!component) return "unknown";
  const status = String(component.rawStatus ?? component.status ?? component.state ?? "unknown").toLowerCase();
  if (["degraded", "warning", "external-unverified", "dormant"].includes(status)) return "degraded";
  if (component.available === false || ["disabled", "missing", "offline", "error", "failed"].includes(status)) return "offline";
  if (["ok", "online", "healthy", "ready", "active"].includes(status) || component.available === true) return "ready";
  return "unknown";
}

function runTimestamp(run) {
  const parsed = Date.parse(run?.updatedAt ?? run?.createdAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function runsForTeam(team, runs) {
  if (!team?.id) return runs;
  return runs.filter((run) => (run?.teamId || DEFAULT_TEAM_ID) === team.id);
}

export function buildTeamPanelData({ team = null, runs = [], components = [], catalog = [], now = new Date().toISOString() } = {}) {
  const members = Array.isArray(team?.members) ? [...new Set(team.members.map(String).filter(Boolean))] : [];
  const coordinatorId = members.includes(team?.coordinator) ? team.coordinator : null;
  const catalogById = new Map((Array.isArray(catalog) ? catalog : []).map((profile) => [String(profile?.id || ""), profile]));
  const agents = members.map((id) => memberMeta(id, coordinatorId, catalogById));
  const memberIds = new Set(members);
  const assignments = new Map(members.map((id) => [id, new Map()]));
  const lastActive = new Map();
  const flows = new Map();

  for (const run of runsForTeam(team, Array.isArray(runs) ? runs : [])) {
    for (const attempt of run?.turnAttempts || []) {
      if (!memberIds.has(attempt?.agentId)) continue;
      const at = attempt.updatedAt ?? attempt.createdAt ?? run.updatedAt ?? null;
      if (at && Date.parse(at) > Date.parse(lastActive.get(attempt.agentId) || 0)) lastActive.set(attempt.agentId, at);
      if (ACTIVE_RUN_STATES.has(run.status) && ACTIVE_ATTEMPT_PHASES.has(attempt.phase)) {
        assignments.get(attempt.agentId).set(run.id, { title: run.title || run.prompt || run.id, at: runTimestamp(run) });
      }
    }
    if (!ACTIVE_RUN_STATES.has(run?.status)) continue;
    let assigned = false;
    for (const task of run?.taskGraph?.tasks || []) {
      if (!memberIds.has(task?.assigneeId) || !ACTIVE_TASK_STATES.has(task?.status)) continue;
      assignments.get(task.assigneeId).set(run.id, { title: run.title || run.prompt || task.title || run.id, at: runTimestamp(run) });
      assigned = true;
    }
    if (!assigned) {
      const fallback = memberIds.has(run.startAgentId) ? run.startAgentId : memberIds.has(run.coordinatorId) ? run.coordinatorId : null;
      if (fallback) assignments.get(fallback).set(run.id, { title: run.title || run.prompt || run.id, at: runTimestamp(run) });
    }
    for (const edge of run?.taskGraph?.delegations || []) {
      if (!memberIds.has(edge?.fromAgentId) || !memberIds.has(edge?.toAgentId)) continue;
      if (["cancelled", "failed", "rejected", "skipped"].includes(edge.state)) continue;
      const key = `${edge.fromAgentId}\u0000${edge.toAgentId}\u0000${edge.kind || "delegate"}`;
      const previous = flows.get(key);
      flows.set(key, {
        from: edge.fromAgentId,
        to: edge.toAgentId,
        type: edge.kind || "delegate",
        count: (previous?.count || 0) + 1,
        at: edge.updatedAt ?? edge.timestamp ?? run.updatedAt ?? null,
      });
    }
  }

  return {
    status: agents.length ? "available" : "unavailable",
    teamName: team?.name || "未选择团队",
    coordinatorId,
    updatedAt: now,
    agents: agents.map((agent) => {
      const health = matchingHealth(Array.isArray(components) ? components : [], agent);
      const active = [...assignments.get(agent.id).values()].sort((left, right) => right.at - left.at);
      return {
        ...agent,
        status: active.length ? "busy" : healthStatus(health),
        activeRunCount: active.length,
        currentTask: active[0]?.title || null,
        lastActive: lastActive.get(agent.id) || null,
        healthDetail: health?.detail || health?.reason || null,
      };
    }),
    flows: [...flows.values()]
      .sort((left, right) => Date.parse(right.at || 0) - Date.parse(left.at || 0))
      .slice(0, 8),
  };
}

let _panelEl = null;
let _teamData = null;

/**
 * 初始化团队面板
 * @param {HTMLElement} container - 面板容器
 */
export function initTeamPanel(container) {
  _panelEl = container;
  renderTeamPanel();
}

/**
 * 更新团队状态数据
 * @param {Object} data - { agents: [{id, status, load, lastActive, currentTask}], flows: [{from, to, type, count}] }
 */
export function updateTeamData(data) {
  _teamData = data;
  renderTeamPanel();
}

const STATUS_TEXT = Object.freeze({ busy: "执行中", ready: "可用", degraded: "降级", offline: "离线", unknown: "未核验" });

function agentStatus(agent) {
  return ["busy", "ready", "degraded", "offline"].includes(agent.status) ? agent.status : "unknown";
}

/** 单席位卡片（overview 团队面板与 view-team 花名册共用；index 驱动入场 stagger）。 */
export function teamAgentCardHtml(agent, index = 0) {
  const status = agentStatus(agent);
  const statusText = STATUS_TEXT[status] || STATUS_TEXT.unknown;
  const brand = agent.brand || agentBrandKey(agent.provider || agent.id);
  const taskPct = Math.min(100, Math.max(0, Number(agent.activeRunCount) || 0) * 25);

  return `
    <div class="tp-card forge-enter is-${status}" data-agent="${escapeHtml(agent.id)}" data-brand="${escapeHtml(brand)}">
      <div class="tp-card-head">
        <div class="tp-avatar" aria-hidden="true">${memberAvatarMarkup(agent, {
          className: "avatar-photo",
          iconClass: "cli-logo tp-avatar-icon",
          fallback: officialCliIconMarkup(brand, "cli-logo tp-avatar-icon")
            || `<span class="tp-initials">${escapeHtml(String(agent.name || agent.id || "?").slice(0, 2))}</span>`,
        })}</div>
        <div class="tp-id">
          <span class="tp-name">${escapeHtml(agent.name)}</span>
          <span class="tp-title">${escapeHtml(agent.title)} · ${escapeHtml(agent.provider)}</span>
        </div>
        <span class="tp-dot is-${status}" role="status" title="${statusText}"></span>
      </div>
      <div class="tp-role">${escapeHtml(agent.role)}</div>
      <div class="tp-load" role="meter" aria-label="活跃任务" aria-valuemin="0" aria-valuemax="4" aria-valuenow="${Math.min(4, agent.activeRunCount || 0)}">
        <div class="tp-load-fill" data-load-pct="${taskPct}"></div>
      </div>
      <div class="tp-meta">
        <span class="tp-layer">${agent.layer === "leader" ? "leader" : statusText}</span>
        <span class="num">${agent.activeRunCount ? `${agent.activeRunCount} 个活跃任务` : agent.lastActive ? formatRelativeTime(agent.lastActive) : statusText}</span>
      </div>
      ${agent.currentTask ? `<div class="tp-task" title="${escapeHtml(agent.currentTask)}">${escapeHtml(truncate(agent.currentTask, 40))}</div>` : ""}
    </div>
  `;
}

function renderTeamPanel() {
  if (!_panelEl) return;
  const agents = Array.isArray(_teamData?.agents) ? _teamData.agents : [];
  const available = _teamData?.status === "available";

  _panelEl.innerHTML = `
    <div class="team-panel">
      <div class="tp-header">
        <h3 class="tp-heading">
          ${lucideIcon("users")}
          ${escapeHtml(_teamData?.teamName || "协作团队")}
        </h3>
        <div class="tp-header-meta">
          <span class="tp-freshness is-${available ? "available" : "unavailable"}" role="status">${available ? `同步于 ${formatRelativeTime(_teamData.updatedAt)}` : "等待团队数据"}</span>
          <span class="tp-badge num">${agents.length} 个运行席位</span>
        </div>
      </div>

      <div class="tp-grid">
        ${agents.length ? agents.map((a, i) => teamAgentCardHtml(a, i)).join("") : renderEmptyState("团队数据尚未就绪", "运行席位由 /api/teams 花名册驱动")}
      </div>

      <div class="tp-section">
        <h4 class="tp-section-title">${lucideIcon("workflow")} 协作流</h4>
        ${renderFlows(agents)}
      </div>

      <div class="tp-section">
        <h4 class="tp-section-title">${lucideIcon("network")} 拓扑</h4>
        ${renderTopology(agents)}
      </div>
    </div>
  `;
  applyLoadMeters(_panelEl);
  applyTopologyPins(_panelEl);
}

/** CSP：负载条宽度走 CSSOM（内联 style 被 style-src 拦截）。collab-flow 复用卡片标记时也要调用。 */
export function applyLoadMeters(root) {
  root?.querySelectorAll(".tp-load-fill[data-load-pct]").forEach((el) => {
    el.style.width = `${el.dataset.loadPct}%`;
  });
}

export function applyTopologyPins(root) {
  root?.querySelectorAll("[data-topo-x]").forEach((el) => {
    el.style.left = `${Number(el.dataset.topoX) * 100}%`;
    el.style.top = `${Number(el.dataset.topoY) * 100}%`;
  });
}

function renderEmptyState(text, hint = "") {
  return `<div class="tp-empty">${lucideIcon("users", "icon lucide tp-empty-icon")}<p>${escapeHtml(text)}</p>${hint ? `<p class="tp-empty-hint">${escapeHtml(hint)}</p>` : ""}</div>`;
}

function renderFlows(agents) {
  const flows = _teamData?.flows || [];
  if (!flows.length) {
    return `<div class="tp-empty tp-empty--small">当前没有活跃委派</div>`;
  }
  return `<div class="tp-flow-list">
    ${flows.map((f) => {
      const fromAgent = agents.find((a) => a.id === f.from);
      const toAgent = agents.find((a) => a.id === f.to);
      if (!fromAgent || !toAgent) return "";
      const typeLabel = f.type === "review" ? "评审" : f.type === "research" ? "调研" : f.type === "delegate" ? "委派" : f.type === "route" ? "路由" : f.type || "通信";
      return `<div class="tp-flow-item">
        <span class="tp-flow-side" data-brand="${escapeHtml(fromAgent.brand || agentBrandKey(fromAgent.provider))}">${escapeHtml(fromAgent.name)}</span>
        ${lucideIcon("arrow-right", "icon lucide tp-flow-arrow")}
        <span class="tp-flow-side" data-brand="${escapeHtml(toAgent.brand || agentBrandKey(toAgent.provider))}">${escapeHtml(toAgent.name)}</span>
        <span class="tp-flow-type">${escapeHtml(typeLabel)}</span>
        ${f.count ? `<span class="tp-flow-count num">×${f.count}</span>` : ""}
      </div>`;
    }).join("")}
  </div>`;
}

export function satelliteAngle(index, count) {
  if (count <= 1) return 0;
  if (count === 2) return index === 0 ? (Math.PI * 5) / 6 : Math.PI / 6;
  return (index / count) * Math.PI * 2 - Math.PI / 2;
}

export function layoutTeamTopology(agents, coordinatorId, { width = 720, height = 300 } = {}) {
  const items = Array.isArray(agents) ? agents : [];
  const coordinator = items.find((item) => item.id === coordinatorId) || items[0] || null;
  if (!coordinator) return { width, height, cx: width / 2, cy: height / 2, positions: [] };
  const others = items.filter((item) => item.id !== coordinator.id);
  const cx = width / 2;
  const cy = others.length === 2 ? 118 : height / 2 - 8;
  const radius = others.length <= 2 ? 118 : Math.min(width / 2 - 88, height / 2 - 64);
  const positions = [
    { ...coordinator, x: cx, y: cy, role: "hub", labelDy: others.length === 2 ? -34 : 38 },
    ...others.map((agent, index) => ({
      ...agent,
      x: cx + radius * Math.cos(satelliteAngle(index, others.length)),
      y: cy + radius * Math.sin(satelliteAngle(index, others.length)),
      role: "spoke",
      labelDy: 38,
    })),
  ];
  return { width, height, cx, cy, positions };
}

export function nodeInitial(name) {
  const chars = [...String(name || "").trim()];
  if (!chars.length) return "?";
  return /[\u4e00-\u9fff]/.test(chars[0]) ? chars[0] : chars.slice(0, 2).join("").toUpperCase();
}

function topologyFaceMarkup(agent) {
  const brand = agent.brand || agentBrandKey(agent.provider || agent.id);
  return memberAvatarMarkup(agent, {
    className: "avatar-photo tp-topo-photo",
    iconClass: "cli-logo tp-topo-icon",
    fallback: officialCliIconMarkup(brand, "cli-logo tp-topo-icon")
      || `<span class="tp-initials">${escapeHtml(nodeInitial(agent.name || agent.id))}</span>`,
  });
}

export function renderTeamTopologyMarkup(agents, { coordinatorId = null, flows = [] } = {}) {
  if (!agents.length) return `<div class="tp-empty tp-empty--small">暂无团队拓扑</div>`;
  const { width, height, cx, cy, positions } = layoutTeamTopology(agents, coordinatorId);
  const coordinator = positions.find((item) => item.role === "hub") || positions[0];
  const others = positions.filter((item) => item.id !== coordinator.id);
  const byId = new Map(positions.map((item) => [item.id, item]));
  const connected = new Set(flows.flatMap((flow) => [flow.from, flow.to]));
  const lines = others.map((agent) => {
    const target = byId.get(agent.id);
    const flow = flows.find((item) =>
      (item.from === coordinator.id && item.to === agent.id) || (item.to === coordinator.id && item.from === agent.id));
    const brandKey = agent.brand || agentBrandKey(agent.provider);
    const opacity = flow ? 0.72 : 0.28;
    const strokeWidth = flow ? 2.2 : 1.2;
    return `<line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${target.x.toFixed(1)}" y2="${target.y.toFixed(1)}" class="tp-topo-link" data-brand="${escapeHtml(brandKey)}" stroke-width="${strokeWidth}" opacity="${opacity}" stroke-dasharray="${flow ? "none" : "5 5"}" />`;
  }).join("");
  const pins = positions.map((agent) => {
    const brandKey = agent.brand || agentBrandKey(agent.provider);
    return `<div class="tp-topo-pin${connected.has(agent.id) ? " is-connected" : ""}${agent.role === "hub" ? " is-hub" : ""}${agent.labelDy < 0 ? " is-label-above" : ""}" data-agent="${escapeHtml(agent.id)}" data-brand="${escapeHtml(brandKey)}" data-topo-x="${(agent.x / width).toFixed(4)}" data-topo-y="${(agent.y / height).toFixed(4)}">
      <span class="tp-topo-face" aria-hidden="true">${topologyFaceMarkup(agent)}</span>
      <span class="tp-topo-name">${escapeHtml(truncate(agent.name, 8))}</span>
    </div>`;
  }).join("");
  return `<div class="tp-topology" role="img" aria-label="团队拓扑">
    <svg class="tp-topology-svg" viewBox="0 0 ${width} ${height}" aria-hidden="true">${lines}</svg>
    <div class="tp-topo-pins">${pins}</div>
  </div>`;
}

function renderTopology(agents) {
  return renderTeamTopologyMarkup(agents, { coordinatorId: _teamData?.coordinatorId, flows: _teamData?.flows || [] });
}

// ─── 工具函数 ────────────────────────────────────────────────

// escapeHtml 统一来自 ./utils.js（本文件此前自带副本，且未转义单引号，与规范不一致）

function truncate(s, len) {
  s = String(s ?? "");
  return s.length > len ? s.slice(0, len) + "…" : s;
}

function formatRelativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}
