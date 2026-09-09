/**
 * collab-flow.js — 团队协作旗舰视图（view-team）自举模块
 *
 * 挂载点（shell 在 index.html 提供，全部 null-guard，缺任一根即静默跳过该区块）：
 *   #team-starmap-root 协作星图（当前团队席位 + TaskGraph 连线；不进骨架擦除）
 *   #team-hero-root    英雄统计（活跃席位 / 今日交接 / 平均 DELTA）
 *   #team-roster-root  花名册卡片（复用 team-panel 席位卡）
 *   #team-flow-root    SVG 协作流图（节点=席位，边=真实委派/交接）
 *   #team-delta-root   DELTA 摘要（byScore + 最近条目）
 *   #team-heatmap-root 活跃度热力图（席位 × 近 7 天）
 *   #team-routing-root 最近闸门（服务端预览工作台在 #team-router-workbench）
 *   #team-inbox-root   消息收发局（当前团队 run 的 ask/answer/治理消息）
 *
 * 数据源全部是既有真实端点：/api/teams /api/runs /api/health
 *   /api/observability/delta /api/observability/handoffs /api/observability/routegate
 *   /api/teams/:id/attention（队列/在岗/Inbox 同一 read model）
 * 消息收发局复用 run bus 的有界只读投影；任何端点失败只做区块级降级，不拖垮整页。
 */
import { API, request } from "./api.js";
import { lucideIcon } from "./lucide.js";
import { state } from "./state.js";
import { buildTeamPanelData, teamAgentCardHtml, agentBrandKey, applyLoadMeters, runsForTeam } from "./team-panel.js";
import { mountTeamStarmap } from "./hero-starmap.js";

let teamStarmap = null;

const DAY_MS = 86_400_000;
const HEAT_DAYS = 7;

const TEAM_KEY = "514cc-selected-team";
const COLLAB_SOURCE_NAMES = Object.freeze(["teams", "runs", "health", "delta", "handoffs", "routegate"]);
let refreshVersion = 0;
let refreshController = null;
const attentionSeqByTeam = new Map();

export function buildCollabLoadResult(settled = [], data = null, details = {}) {
  // settled 顺序可能不是全集（如 refreshCollabFlow 的快源轨道不含 health），
  // 由调用方通过 details.sourceNames 显式声明归因表，缺省回退全集顺序。
  const { sourceNames, ...rest } = details;
  const names = sourceNames || COLLAB_SOURCE_NAMES;
  const failures = settled.flatMap((result, index) => {
    if (result?.status !== "rejected") return [];
    return [{
      source: names[index] || `source-${index + 1}`,
      message: String(result.reason?.message ?? result.reason ?? "unknown error"),
    }];
  });
  if (!failures.length) {
    return {
      __forgeLoadResult: true,
      ok: true,
      data,
      status: "success",
      partial: false,
      failedSources: [],
      failures: [],
      ...rest,
    };
  }
  const partial = failures.length < settled.length;
  const failedSources = failures.map((failure) => failure.source);
  return {
    __forgeLoadResult: true,
    ok: false,
    data,
    status: partial ? "partial" : "failure",
    partial,
    failedSources,
    failures,
    error: new Error(`团队协作数据加载失败：${failedSources.join(", ")}`),
    ...rest,
  };
}

/** 重新加载并渲染所有已挂载区块（重试按钮也走这里）。
    health 探针逐 CLI 探测动辄 5s+：不堵首屏、不算整载失败——本地快源（teams/runs/
    delta/handoffs/routegate）3.5s 预算先渲染，health 走 12s 独立轨道，到达后按当前
    版本补载席位状态；探针失败则保持"未核验"，诚实不伪装。 */
export async function refreshCollabFlow({ teamId = selectedTeamId() } = {}) {
  const version = ++refreshVersion;
  refreshController?.abort();
  const controller = new AbortController();
  refreshController = controller;
  const roots = collectRoots();
  if (!roots) return buildCollabLoadResult([], null, { skipped: true });
  renderSkeletons(roots);

  const withTimeout = (promise, label, ms = 3500) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时`)), ms)),
  ]);
  const FAST_SOURCES = ["teams", "runs", "delta", "handoffs", "routegate"];
  const healthTrack = withTimeout(request(API.health, { signal: controller.signal }), "health", 12_000)
    .then((value) => ({ status: "fulfilled", value }))
    .catch((reason) => ({ status: "rejected", reason }));
  const settled = await Promise.allSettled([
    withTimeout(request(API.teams, { signal: controller.signal }), "teams"),
    withTimeout(request(API.runs, { signal: controller.signal }), "runs"),
    withTimeout(request(API.obsDelta, { signal: controller.signal }), "delta"),
    withTimeout(request(API.obsHandoffs, { signal: controller.signal }), "handoffs"),
    withTimeout(request(API.obsRouteGate, { signal: controller.signal }), "routegate"),
  ]);
  if (version !== refreshVersion) return buildCollabLoadResult([], null, { stale: true });
  const [teams, runs, delta, handoffs, routegate] = settled;

  const data = {
    teams: teams.status === "fulfilled" ? unwrapList(teams.value, "teams") : null,
    runs: runs.status === "fulfilled" ? unwrapList(runs.value, "runs") : [],
    components: [],
    delta: delta.status === "fulfilled" ? delta.value : null,
    handoffs: handoffs.status === "fulfilled" ? unwrapList(handoffs.value, "handoffs") : [],
    routegate: routegate.status === "fulfilled" ? routegate.value : null,
    failed: settled.filter((r) => r.status === "rejected").length,
  };

  const team = pickTeam(data.teams, teamId);
  const teamRuns = team ? runsForTeam(team, data.runs) : [];
  const inboxSettled = team
    ? await Promise.allSettled([withTimeout(request(API.teamAttention(team.id), { signal: controller.signal }), "attention")])
    : [];
  if (version !== refreshVersion) return buildCollabLoadResult([], null, { stale: true });
  const inboxResult = inboxSettled[0];
  const attention = inboxResult?.status === "fulfilled" ? inboxResult.value : null;
  const attentionSeq = Number(attention?.fetchSeq);
  const previousSeq = attentionSeqByTeam.get(team?.id) || 0;
  const attentionFresh = !attention || !Number.isFinite(attentionSeq) || attentionSeq >= previousSeq;
  if (attentionFresh && Number.isFinite(attentionSeq) && team?.id) attentionSeqByTeam.set(team.id, attentionSeq);
  data.attention = attentionFresh ? attention : null;
  data.inbox = data.attention?.inbox || null;
  if (inboxResult?.status === "rejected") data.failed += 1;
  const buildPanel = () => team ? buildTeamPanelData({
    team,
    runs: teamRuns,
    components: data.components,
    catalog: state.bootstrap?.teamCatalog,
  }) : null;

  renderHero(roots.hero, data, buildPanel(), team);
  renderStarmap(buildPanel());
  renderRoster(roots.roster, buildPanel());
  renderFlow(roots.flow, buildPanel());
  renderDeltaMini(roots.delta, data.delta);
  renderHeatmap(roots.heatmap, buildPanel(), team, teamRuns);
  renderRouting(roots.routing, data);
  renderInbox(roots.inbox, data.attention || data.inbox, inboxResult?.status === "rejected" ? inboxResult.reason : null);

  // 健康补载：只在该次刷新仍是最新时才重算 panel，覆盖健康相关区块
  void healthTrack.then((health) => {
    if (version !== refreshVersion || health.status !== "fulfilled") return;
    data.components = unwrapList(health.value, "items");
    renderHero(roots.hero, data, buildPanel(), team);
    renderStarmap(buildPanel());
    renderRoster(roots.roster, buildPanel());
    renderFlow(roots.flow, buildPanel());
    renderRouting(roots.routing, data);
  });

  const allSettled = inboxSettled.length ? [...settled, ...inboxSettled] : settled;
  const sourceNames = inboxSettled.length ? [...FAST_SOURCES, "attention"] : FAST_SOURCES;
  return buildCollabLoadResult(allSettled, data, { teamId: team?.id ?? null, failed: data.failed, sourceNames });
}

function collectRoots() {
  const roots = {
    hero: document.getElementById("team-hero-root"),
    roster: document.getElementById("team-roster-root"),
    flow: document.getElementById("team-flow-root"),
    delta: document.getElementById("team-delta-root"),
    heatmap: document.getElementById("team-heatmap-root"),
    routing: document.getElementById("team-routing-root"),
    inbox: document.getElementById("team-inbox-root"),
  };
  return Object.values(roots).some(Boolean) ? roots : null;
}

function renderSkeletons(roots) {
  // CSP：骨架高度走 data-h + CSSOM，不用内联 style
  const block = (h) => `<div class="cf-skeleton forge-shimmer" data-h="${h}"></div>`;
  if (roots.hero) roots.hero.innerHTML = `<div class="cf-hero">${block(96)}${block(96)}${block(96)}${block(96)}</div>`;
  if (roots.roster) roots.roster.innerHTML = `<div class="cf-grid">${block(140)}${block(140)}${block(140)}</div>`;
  if (roots.flow) roots.flow.innerHTML = block(320);
  if (roots.delta) roots.delta.innerHTML = block(120);
  if (roots.heatmap) roots.heatmap.innerHTML = block(180);
  if (roots.routing) roots.routing.innerHTML = block(140);
  if (roots.inbox) roots.inbox.innerHTML = block(180);
  setInboxStatus(roots.inbox, "加载中", "pending");
  for (const root of Object.values(roots)) {
    root?.querySelectorAll(".cf-skeleton[data-h]").forEach((el) => { el.style.minHeight = `${el.dataset.h}px`; });
  }
}

function renderStarmap(panel) {
  const root = document.getElementById("team-starmap-root");
  if (!root) return;
  teamStarmap ??= mountTeamStarmap(root);
  teamStarmap.setFromPanel(panel);
}

// ─── 英雄统计 ────────────────────────────────────────────────

export function buildAttentionHeroStat(attention = null) {
  const counts = attention?.counts;
  if (!counts || !Number.isFinite(counts.activeSeats)) {
    return { value: "—", sub: "注意力数据未知", known: false };
  }
  const queueDepth = Number.isFinite(counts.queueDepth) ? counts.queueDepth : null;
  const pendingAsks = Number.isFinite(counts.pendingAskCount) ? counts.pendingAskCount : null;
  let sub = "队列与待答数据未知";
  if (queueDepth != null && pendingAsks != null) {
    sub = queueDepth > 0
      ? `队列 ${queueDepth} · 待答 ${pendingAsks}`
      : pendingAsks > 0
        ? `待 LO 回答 ${pendingAsks}`
        : "当前无执行中任务";
  }
  return { value: counts.activeSeats, sub, known: true };
}

function renderHero(root, data, panel, team) {
  if (!root) return;
  if (!team || !panel) {
    root.innerHTML = stateCard("users", "团队数据不可用", "未能加载 /api/teams 花名册", true);
    wireRetry(root);
    return;
  }
  const agents = panel.agents || [];
  const attentionStat = buildAttentionHeroStat(data.attention);
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const handoffsToday = data.handoffs.filter((h) => Date.parse(h?.modifiedAt || 0) >= todayStart).length;
  const byScore = data.delta?.byScore || {};
  const scored = (byScore[0] || 0) + (byScore[1] || 0) + (byScore[2] || 0);
  const avgDelta = scored ? (((byScore[1] || 0) + 2 * (byScore[2] || 0)) / scored).toFixed(2) : "—";

  const stats = [
    { icon: "users", value: agents.length, label: "协作席位", sub: escapeHtml(team.name || "未选择团队") },
    { icon: "activity", value: attentionStat.value, label: "执行中席位", sub: attentionStat.sub },
    { icon: "send", value: handoffsToday, label: "全局今日交接", sub: `累计 ${data.handoffs.length} 份 handoff` },
    { icon: "zap", value: avgDelta, label: "全局平均 DELTA", sub: `共 ${data.delta?.total ?? 0} 条账本` },
  ];

  root.innerHTML = `<div class="cf-hero">
    ${stats.map((s, i) => `
      <div class="cf-stat forge-enter">
        <div class="cf-stat-icon">${lucideIcon(s.icon)}</div>
        <div class="cf-stat-body">
          <span class="cf-stat-value num">${s.value}</span>
          <span class="cf-stat-label">${s.label}</span>
          <span class="cf-stat-sub">${s.sub}</span>
        </div>
      </div>`).join("")}
  </div>`;
}

// ─── 花名册 ──────────────────────────────────────────────────

function renderRoster(root, panel) {
  if (!root) return;
  const agents = panel?.agents || [];
  if (!agents.length) {
    root.innerHTML = stateCard("users", "花名册为空", "运行席位由 /api/teams 花名册驱动");
    return;
  }
  root.innerHTML = `<div class="cf-grid">${agents.map((a, i) => teamAgentCardHtml(a, i)).join("")}</div>`;
  applyLoadMeters(root);
}

// ─── 协作流图 ────────────────────────────────────────────────

function renderFlow(root, panel) {
  if (!root) return;
  const agents = panel?.agents || [];
  if (!agents.length) {
    root.innerHTML = stateCard("workflow", "暂无协作流", "团队花名册就绪后自动绘制");
    return;
  }

  const W = 720, H = 380, cx = W / 2, cy = H / 2 + 8, rx = 270, ry = 135;
  const positions = agents.map((agent, index) => {
    const angle = (index / agents.length) * Math.PI * 2 - Math.PI / 2;
    return { ...agent, x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
  });
  const byId = new Map(positions.map((p) => [p.id, p]));

  // 团队流图只消费该团队持久 TaskGraph；全局治理 handoff 无 teamId，不能归入这里。
  const edges = new Map();
  const addEdge = (fromId, toId, kind, count = 1) => {
    if (!byId.has(fromId) || !byId.has(toId) || fromId === toId) return;
    const key = `${fromId}\u0000${toId}`;
    const prev = edges.get(key);
    edges.set(key, { from: fromId, to: toId, kinds: { ...(prev?.kinds || {}), [kind]: (prev?.kinds?.[kind] || 0) + count }, weight: (prev?.weight || 0) + count });
  };
  for (const flow of panel.flows || []) addEdge(flow.from, flow.to, flow.type || "delegate", flow.count || 1);

  const edgeList = [...edges.values()];
  const edgeSvg = edgeList.map((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    // 中点向圆心反方向偏移，避免所有弦挤在中心
    const dx = mx - cx, dy = my - cy;
    const len = Math.hypot(dx, dy) || 1;
    const qx = mx + (dx / len) * 36;
    const qy = my + (dy / len) * 36;
    const width = Math.min(4, 1 + edge.weight * 0.6);
    return `
      <path class="cf-edge" data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}" data-brand="${escapeHtml(from.brand || "other")}"
        d="M ${from.x} ${from.y} Q ${qx} ${qy} ${to.x} ${to.y}"
        stroke-width="${width.toFixed(1)}" fill="none" />
      ${edge.weight > 1 ? `<text class="cf-edge-count num" x="${qx}" y="${qy}" text-anchor="middle" dominant-baseline="central">×${edge.weight}</text>` : ""}`;
  }).join("");

  const nodeSvg = positions.map((agent) => {
    const status = ["busy", "ready", "degraded", "offline"].includes(agent.status) ? agent.status : "unknown";
    return `
      <g class="cf-node is-${status}" data-agent="${escapeHtml(agent.id)}" data-brand="${escapeHtml(agent.brand || "other")}" tabindex="0" role="img" aria-label="${escapeHtml(agent.name)}">
        <circle class="cf-node-ring" cx="${agent.x}" cy="${agent.y}" r="26" />
        <circle class="cf-node-core" cx="${agent.x}" cy="${agent.y}" r="26" />
        <text class="cf-node-glyph" x="${agent.x}" y="${agent.y}" text-anchor="middle" dominant-baseline="central">${escapeHtml(agent.name.slice(0, 1))}</text>
        <text class="cf-node-label" x="${agent.x}" y="${agent.y + 40}" text-anchor="middle">${escapeHtml(truncate(agent.name, 8))}</text>
      </g>`;
  }).join("");

  root.innerHTML = `
    <div class="cf-flow-wrap">
      <svg class="cf-flow-svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="协作流图">
        ${edgeSvg || ""}${nodeSvg}
      </svg>
      ${edgeList.length ? "" : `<div class="cf-flow-note">当前团队 TaskGraph 中未观测到席位间互动</div>`}
    </div>`;

  wireFlowHover(root, byId, edgeList);
}

function wireFlowHover(root, byId, edgeList) {
  const svg = root.querySelector(".cf-flow-svg");
  if (!svg) return;
  const adjacency = new Map();
  for (const edge of edgeList) {
    (adjacency.get(edge.from) || adjacency.set(edge.from, new Set()).get(edge.from)).add(edge.to);
    (adjacency.get(edge.to) || adjacency.set(edge.to, new Set()).get(edge.to)).add(edge.from);
  }
  const highlight = (agentId) => {
    const related = new Set([agentId, ...(adjacency.get(agentId) || [])]);
    svg.querySelectorAll(".cf-node").forEach((node) => {
      node.classList.toggle("is-dim", !related.has(node.dataset.agent));
      node.classList.toggle("is-hot", node.dataset.agent === agentId);
    });
    svg.querySelectorAll(".cf-edge").forEach((edge) => {
      const hot = edge.dataset.from === agentId || edge.dataset.to === agentId;
      edge.classList.toggle("is-hot", hot);
      edge.classList.toggle("is-dim", !hot);
    });
  };
  const clear = () => {
    svg.querySelectorAll(".is-dim, .is-hot").forEach((el) => el.classList.remove("is-dim", "is-hot"));
  };
  svg.querySelectorAll(".cf-node").forEach((node) => {
    node.addEventListener("mouseenter", () => highlight(node.dataset.agent));
    node.addEventListener("mouseleave", clear);
    node.addEventListener("focus", () => highlight(node.dataset.agent));
    node.addEventListener("blur", clear);
  });
}

// ─── DELTA 摘要 ──────────────────────────────────────────────

function renderDeltaMini(root, delta) {
  if (!root) return;
  if (!delta) {
    root.innerHTML = stateCard("zap", "DELTA 账本不可用", "/api/observability/delta 加载失败", true);
    wireRetry(root);
    return;
  }
  const byScore = delta.byScore || {};
  const recent = Array.isArray(delta.deltas) ? delta.deltas : Array.isArray(delta.recent) ? delta.recent : [];
  const chips = [
    { label: "白发", count: byScore[0] || 0, cls: "is-muted" },
    { label: "补强", count: byScore[1] || 0, cls: "is-success" },
    { label: "推翻", count: byScore[2] || 0, cls: "is-primary" },
  ];
  root.innerHTML = `
    <div class="cf-delta">
      <div class="cf-delta-chips">
        ${chips.map((c) => `<span class="cf-chip ${c.cls}">${c.label} <span class="num">${c.count}</span></span>`).join("")}
        <span class="cf-chip">共 <span class="num">${delta.total ?? recent.length}</span> 条</span>
      </div>
      ${recent.length ? `<div class="cf-delta-recent">
        ${recent.slice(0, 3).map((entry) => {
          return `<div class="cf-delta-row">
            <span class="cf-delta-agent" data-brand="${escapeHtml(agentBrandKey(entry?.agent || ""))}">${escapeHtml(entry?.agent || "未知")}</span>
            <span class="cf-delta-evidence">${escapeHtml(truncate(entry?.evidence || entry?.topic || "无证据", 64))}</span>
          </div>`;
        }).join("")}
      </div>` : `<div class="cf-flow-note">账本暂无明细</div>`}
    </div>`;
}

// ─── 活跃度热力图 ────────────────────────────────────────────

export function buildTeamActivityCounts({ team = null, agents = [], runs = [], days = [] } = {}) {
  const counts = new Map(agents.map((agent) => [agent.id, new Array(days.length).fill(0)]));
  const bucketOf = (ts) => {
    const parsed = Date.parse(ts || "");
    if (!Number.isFinite(parsed)) return -1;
    const day = new Date(parsed);
    day.setHours(0, 0, 0, 0);
    return days.indexOf(day.getTime());
  };
  const bump = (agentId, ts) => {
    const bucket = bucketOf(ts);
    if (bucket < 0 || !counts.has(agentId)) return;
    counts.get(agentId)[bucket] += 1;
  };
  for (const run of team ? runsForTeam(team, runs) : []) {
    for (const attempt of run?.turnAttempts || []) {
      bump(attempt?.agentId, attempt?.updatedAt ?? attempt?.createdAt ?? run?.updatedAt);
    }
    for (const edge of run?.taskGraph?.delegations || []) {
      bump(edge?.fromAgentId, edge?.updatedAt ?? edge?.timestamp ?? run?.updatedAt);
    }
  }
  return counts;
}

function renderHeatmap(root, panel, team, runs) {
  if (!root) return;
  const agents = panel?.agents || [];
  if (!agents.length) {
    root.innerHTML = stateCard("radar", "暂无活动数据", "席位活动来自当前团队 run turnAttempts 与 TaskGraph 时间戳");
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: HEAT_DAYS }, (_, i) => today.getTime() - (HEAT_DAYS - 1 - i) * DAY_MS);
  const counts = buildTeamActivityCounts({ team, agents, runs, days });

  const max = Math.max(0, ...[...counts.values()].flat());
  const dayLabel = (t) => {
    const d = new Date(t);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  root.innerHTML = `
    <div class="cf-heat" role="table" aria-label="席位活跃度热力图">
      <div class="cf-heat-row cf-heat-head" role="row">
        <span class="cf-heat-name"></span>
        ${days.map((t) => `<span class="cf-heat-day num" role="columnheader">${dayLabel(t)}</span>`).join("")}
      </div>
      ${agents.map((agent) => {
        const row = counts.get(agent.id) || [];
        return `<div class="cf-heat-row" role="row">
          <span class="cf-heat-name" role="rowheader" data-brand="${escapeHtml(agent.brand || "other")}">${escapeHtml(truncate(agent.name, 6))}</span>
          ${row.map((count, i) => {
            const level = !count ? 0 : Math.min(4, 1 + Math.floor((count / Math.max(1, max)) * 3));
            const label = `${agent.name} · ${dayLabel(days[i])} · ${count} 次活动`;
            return `<span class="cf-heat-cell hm-l${level}" role="cell" title="${escapeHtml(label)}"></span>`;
          }).join("")}
        </div>`;
      }).join("")}
      <div class="cf-heat-legend">
        <span>少</span>
        ${[0, 1, 2, 3, 4].map((l) => `<span class="cf-heat-cell hm-l${l}"></span>`).join("")}
        <span>多</span>
      </div>
      ${max === 0 ? `<div class="cf-flow-note">近 ${HEAT_DAYS} 天未观测到席位活动时间戳</div>` : ""}
    </div>`;
}

// ─── 消息收发局（CCB Message Bureau 的本地只读投影） ─────────────

function renderInbox(root, payload, error = null) {
  if (!root?.isConnected) return;
  if (error) {
    setInboxStatus(root, "消息源降级", "error");
    root.innerHTML = stateCard("inbox", "消息收发局暂不可用", error.message || "当前团队 bus 读取失败", true);
    wireRetry(root);
    return;
  }
  if (!payload || typeof payload !== "object") {
    setInboxStatus(root, "等待消息", "neutral");
    root.innerHTML = stateCard("inbox", "暂无消息收发局数据", "团队就绪后会从关联 run 的有界消息尾部载入");
    return;
  }
  const inbox = payload?.inbox && payload.schema === "514cc.team-attention/v1" ? payload.inbox : payload;
  const counts = payload?.schema === "514cc.team-attention/v1" ? payload.counts : null;
  const messages = Array.isArray(inbox.messages) ? inbox.messages : [];
  const pending = counts
    ? { length: counts.pendingAskCount }
    : (Array.isArray(inbox.pendingAsks) ? inbox.pendingAsks : messages.filter((item) => item.needsOperator));
  const answers = Array.isArray(inbox.recentAnswers) ? inbox.recentAnswers : messages.filter((item) => item.kind === "answer");
  const blocked = counts
    ? { length: counts.blockedCount }
    : (Array.isArray(inbox.blockedRuns) ? inbox.blockedRuns : []);
  const diagnostics = inbox.diagnostics || payload.diagnostics || {};
  const partial = diagnostics.status === "partial";
  setInboxStatus(
    root,
    partial
      ? `部分可见 · ${diagnostics.runsRead ?? 0}/${diagnostics.runsTotal ?? 0} 个任务`
      : `${messages.length} 条消息`,
    partial ? "warning" : "ok",
  );
  const summary = [
    { icon: "message-circle", value: pending.length, label: "待 LO 回答" },
    { icon: "message-square", value: answers.length, label: "最近答复" },
    { icon: "triangle-alert", value: blocked.length, label: "需要关注的任务" },
  ];
  const kindLabel = { ask: "Ask", answer: "Answer", decide: "决策", steer: "插话", system: "系统" };
  const rows = messages.slice(0, 8).map((message, messageIndex) => `
    <article class="team-inbox-row${message.needsOperator ? " is-actionable" : ""}">
      <div class="team-inbox-row-head">
        <span class="cf-chip ${message.needsOperator ? "is-primary" : "is-muted"}">${kindLabel[message.kind] || "消息"}</span>
        <span class="team-inbox-route">${escapeHtml(message.from)} → ${escapeHtml(message.to)}</span>
        <time class="num" datetime="${escapeHtml(message.ts || "")}">${escapeHtml(formatGateTime(message.ts))}</time>
      </div>
      <p class="team-inbox-text">${escapeHtml(message.text)}</p>
      <div class="team-inbox-row-foot">
        <span class="team-inbox-run-title">${escapeHtml(truncate(message.runTitle || message.runId, 54))}</span>
        ${message.lifecycle ? `<span class="cf-chip is-muted">${escapeHtml(message.lifecycle)}</span>` : ""}
        ${message.kind === "ask" && message.lifecycle === "answered"
          ? `<button type="button" class="button quiet" data-inbox-action="acknowledge" data-run-id="${escapeHtml(message.runId)}" data-message-id="${escapeHtml(message.id)}" data-revision="${escapeHtml(message.lifecycleRevision ?? "")}" title="ACK 只确认消息交付">确认收到</button>`
          : ""}
        <button type="button" class="button quiet team-inbox-open" data-run-select="${escapeHtml(message.runId)}" title="打开对应任务">
          ${lucideIcon("arrow-up-right", "icon lucide")}打开任务
        </button>
      </div>
      ${message.kind === "ask" && message.needsOperator
        ? `<form class="team-inbox-answer-form" data-inbox-answer-form data-run-id="${escapeHtml(message.runId)}" data-message-id="${escapeHtml(message.id)}" data-revision="${escapeHtml(message.lifecycleRevision ?? "")}">
            <label class="sr-only" for="team-inbox-answer-${messageIndex}">回复 ${escapeHtml(message.from)}</label>
            <input id="team-inbox-answer-${messageIndex}" name="answer" maxlength="320" autocomplete="off" placeholder="输入答复" required />
            <button type="submit" class="icon-button" title="写入答复，不触发 provider" aria-label="发送答复">${lucideIcon("send", "icon lucide")}</button>
            <span class="team-inbox-answer-status" aria-live="polite"></span>
          </form>`
        : ""}
    </article>`).join("");
  root.innerHTML = `
    <div class="team-inbox" data-inbox-schema="${escapeHtml(inbox.schema || payload.schema || "")}">
      <div class="team-inbox-summary">
        ${summary.map((item) => `<div class="team-inbox-stat"><span class="team-inbox-stat-icon">${lucideIcon(item.icon, "icon lucide")}</span><strong class="num">${item.value}</strong><span>${item.label}</span></div>`).join("")}
      </div>
      ${rows ? `<div class="team-inbox-list">${rows}</div>` : `<div class="cf-flow-note">当前团队还没有可展示的 Ask、答复或治理消息。</div>`}
      ${partial ? `<div class="team-inbox-diagnostic" role="status">${lucideIcon("triangle-alert", "icon lucide")}部分 run 读取失败，以上内容不是完整历史。</div>` : ""}
    </div>`;
  root.querySelectorAll("[data-inbox-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.inboxAction;
      const teamId = payload.team?.id;
      if (!teamId) return;
      try {
        await request(API.teamInboxAction(teamId, action), {
          method: "POST",
          body: {
            runId: button.dataset.runId,
            messageId: button.dataset.messageId,
            text: "",
            idempotencyKey: `${action}:${button.dataset.runId}:${button.dataset.messageId}`,
            expectedRevision: button.dataset.revision === "" ? null : Number(button.dataset.revision),
          },
        });
        refreshCollabFlow({ teamId });
      } catch (error) {
        setInboxStatus(root, error.message || "Inbox 写入失败", "error");
      }
    });
  });
  root.querySelectorAll("[data-inbox-answer-form]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const teamId = payload.team?.id;
      const input = form.elements.namedItem("answer");
      const submit = form.querySelector('button[type="submit"]');
      const status = form.querySelector(".team-inbox-answer-status");
      const text = String(input?.value || "").trim();
      if (!teamId || !text) {
        input?.focus();
        return;
      }
      form.setAttribute("aria-busy", "true");
      if (submit) submit.disabled = true;
      if (status) status.textContent = "发送中";
      try {
        await request(API.teamInboxAction(teamId, "answer"), {
          method: "POST",
          body: {
            runId: form.dataset.runId,
            messageId: form.dataset.messageId,
            text,
            idempotencyKey: `answer:${form.dataset.runId}:${form.dataset.messageId}`,
            expectedRevision: form.dataset.revision === "" ? null : Number(form.dataset.revision),
          },
        });
        if (status) status.textContent = "已写入";
        await refreshCollabFlow({ teamId });
      } catch (error) {
        if (status) status.textContent = error.message || "答复写入失败";
        form.removeAttribute("aria-busy");
        if (submit) submit.disabled = false;
      }
    });
  });
}

function setInboxStatus(root, text, tone = "neutral") {
  const section = root?.closest?.(".team-inbox-block, .content-section");
  const status = section?.querySelector?.("#team-inbox-status");
  if (!status) return;
  status.textContent = text;
  status.className = `status-label is-${tone}`;
}

// ─── 最近闸门（派工预览已并入 #team-router-workbench） ─────────

/** 本地启发式：镜像 src/router.mjs classifyTask 的关键词口径，供单测与旧探针复用。
    gemini-research 已除名——该 profile 当前禁用（.ai-shared/context.md），不建议不可执行席位。 */
const SUGGEST_RULES = Object.freeze([
  { type: "current-research", label: "实时情报", re: /最新|当前|今天|实时|搜索|调研|search|news/i, prefer: ["codex-technical"], why: "执行后端调用检索工具" },
  { type: "frontend", label: "前端工程", re: /前端|界面|样式|页面|组件|UI|CSS|HTML/i, prefer: ["kimi-frontend"], why: "前端/UI 专席" },
  { type: "review", label: "评审审计", re: /评审|审计|安全|review|security/i, prefer: ["codex-technical"], why: "评审与验证" },
  { type: "debugging", label: "排障修复", re: /修复|报错|错误|异常|故障|失败|debug|bug/i, prefer: ["codex-technical", "grok-build"], why: "实现与排障" },
  { type: "resident", label: "扩展与 RPC", re: /扩展|插件|RPC|工具编排|resident|extension/i, prefer: ["pi-resident"], why: "RPC/工具编排" },
  { type: "long-context", label: "长上下文", re: /长文档|全文|研究|论文|document|research/i, prefer: ["claude-fable", "grok-build"], why: "研究/长上下文" },
  { type: "coding", label: "编码实现", re: /实现|写代码|开发|编码|构建|implement|code|build/i, prefer: ["codex-technical", "grok-build"], why: "编码执行" },
  { type: "planning", label: "规划架构", re: /规划|方案|架构|设计|plan|architecture/i, prefer: [], why: "当前团队主脑规划" },
]);

function renderRouting(root, data) {
  if (!root) return;
  const gate = data.routegate;
  const rows = Array.isArray(gate?.recent) ? gate.recent.slice(0, 8) : [];
  const table = !gate
    ? stateCard("compass", "闸门数据不可用", "/api/observability/routegate 加载失败", true)
    : rows.length
      ? `<div class="cf-route-table-wrap"><table class="cf-route-table">
          <thead><tr><th>时间</th><th>闸门</th><th>原因</th><th>召唤</th><th>提示词</th></tr></thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                <td class="num">${escapeHtml(formatGateTime(row.ts))}</td>
                <td><span class="cf-chip ${row.flag === "red" ? "is-danger" : "is-muted"}">${row.flag === "red" ? "RED" : "GRAY"}</span></td>
                <td>${escapeHtml(row.reason || "-")}</td>
                <td>${summonedLabel(row.summoned)}</td>
                <td class="cf-route-prompt" title="${escapeHtml(row.prompt || "")}">${escapeHtml(truncate(row.prompt || "-", 42))}</td>
              </tr>`).join("")}
          </tbody>
        </table></div>`
      : `<div class="cf-flow-note">近 7 天没有闸门记录。派工预览用上方任务画像，走服务端 router。</div>`;

  root.innerHTML = `<div class="cf-route-decisions">${table}</div>`;
  if (!gate) wireRetry(root);
}

export function suggestMarkup(text, members, coordinatorId = null, seats = null) {
  const matched = SUGGEST_RULES.filter((rule) => rule.re.test(text));
  const rule = matched[0] || {
    type: "planning",
    label: "规划（默认）",
    prefer: coordinatorId ? [coordinatorId] : [],
    why: "未命中关键词，交由当前团队主脑规划",
    re: null,
  };
  if (rule.type === "planning" && !coordinatorId) {
    return `<span class="cf-suggest-hint">当前团队未指定主脑</span>`;
  }
  const preferred = rule.type === "planning" && coordinatorId
    ? [coordinatorId, ...rule.prefer.filter((id) => id !== coordinatorId)]
    : rule.prefer;
  const hitWords = matched.length ? [...new Set(matched.flatMap((r) => (text.match(r.re) || []).slice(0, 2)))].slice(0, 4) : [];
  // 席位状态感知：离线席位不可执行，直接跳过；无席位数据（seats=null）不臆造过滤，保持旧行为
  const usable = (id) => seats?.get(id)?.status !== "offline";
  const candidate = preferred.find((id) => (!members.size || members.has(id)) && usable(id))
    || (members.size ? [...members].find(usable) : preferred.find(usable));
  if (!candidate) return `<span class="cf-suggest-hint">当前团队没有可建议的席位（席位可能离线）</span>`;
  const seat = seats?.get(candidate) || null;
  const statusChip = seat?.status === "busy"
    ? `<span class="cf-chip is-muted">执行中${seat.activeRunCount > 1 ? ` · ${seat.activeRunCount} 任务` : ""}</span>`
    : seat?.status === "degraded"
      ? `<span class="cf-chip is-muted">降级</span>`
      : seat?.status === "unknown"
        ? `<span class="cf-chip is-muted">未核验</span>`
        : "";
  return `
    <div class="cf-suggest-pick forge-enter" data-suggest-agent="${escapeHtml(candidate)}" role="button" tabindex="0" title="点击切换协作台直接发送目标">
      <span class="cf-suggest-agent" data-brand="${escapeHtml(agentBrandKey(candidate))}">${escapeHtml(candidate)}</span>
      <div class="cf-suggest-chips">
        <span class="cf-chip is-primary">${escapeHtml(rule.label)}</span>
        <span class="cf-chip">${escapeHtml(rule.why)}</span>
        ${statusChip}
        ${hitWords.map((w) => `<span class="cf-chip is-muted">命中 “${escapeHtml(w)}”</span>`).join("")}
      </div>
      <p class="cf-suggest-note">建议仅供参考：服务端路由还会叠加健康探针、能力评分与策略权重。点击此卡可切换直接发送目标。</p>
    </div>`;
}

function summonedLabel(value) {
  if (value === "yes") return `<span class="cf-chip is-success">已召唤</span>`;
  if (value === "no") return `<span class="cf-chip is-danger">未召唤</span>`;
  return `<span class="cf-chip is-muted">未知</span>`;
}

// ─── 通用状态卡 / 工具 ───────────────────────────────────────

function stateCard(icon, title, hint, isError = false) {
  return `
    <div class="cf-state${isError ? " is-error" : ""}"${isError ? ' role="alert"' : ""}>
      ${lucideIcon(isError ? "circle-alert" : icon, "icon lucide cf-state-icon")}
      <p>${escapeHtml(title)}</p>
      ${hint ? `<p class="cf-state-hint">${escapeHtml(hint)}</p>` : ""}
      ${isError ? `<button type="button" class="cf-retry">重试</button>` : ""}
    </div>`;
}

function wireRetry(root) {
  root.querySelector(".cf-retry")?.addEventListener("click", () => refreshCollabFlow());
}

function selectedTeamId() {
  if (typeof localStorage === "undefined") return null;
  // 与 app.js 同一存储键：localStorage 持久（跨重启恢复），sessionStorage 旧值兜底
  return localStorage.getItem(TEAM_KEY) || sessionStorage.getItem(TEAM_KEY);
}

export function pickTeam(teams, teamId = null) {
  if (!Array.isArray(teams) || !teams.length) return null;
  if (teamId) {
    const selected = teams.find((item) => item?.id === teamId);
    if (selected) return selected;
  }
  return teams.find((item) => item?.builtin) || teams[0];
}

function unwrapList(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload[key])) return payload[key];
  return [];
}

function formatGateTime(ts) {
  const parsed = Date.parse(String(ts || "").replace(" ", "T"));
  if (!Number.isFinite(parsed)) return String(ts || "-");
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(parsed));
}

function truncate(s, len) {
  s = String(s ?? "");
  return s.length > len ? s.slice(0, len) + "…" : s;
}

function escapeHtml(s) {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
