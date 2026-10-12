import { escapeHtml as esc, runStatusText } from "../utils.js";
import { lucideIcon } from "../lucide.js";
import { collabStatusOf } from "./collab/collab-status.js";

const PAGE_SIZE = 50;
const KINDS = {
  "pipeline-dispatch": "派工执行", "pipeline-review": "交叉复核",
  "pipeline-rework": "按复核补强", "pipeline-synthesis": "汇总结论",
  route: "定向交接", task: "任务指派", "initial-target": "点名执行",
};
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const list = (value) => Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
// 状态文案与图标走 collab-status 唯一词典。tone 沿用 process 语义色词汇
// （queued|running|complete|attention|inactive|unknown），counts.* 按它分桶，键值冻结；
// 未收录状态的回退仍是「状态未知 / unknown」（tests/collaboration-process.test.mjs:27 锁定）。
const stateOf = (value) => {
  const view = collabStatusOf(value);
  return { label: view.label, tone: view.tone, icon: view.icon };
};

// A read-only projection of the selected Run, never an execution or acceptance store.
export function collaborationProcessModel({ conversation = null, run = null, memberLabel = (id) => id } = {}) {
  const executionStopped = TERMINAL.has(run?.status) || ["recovery_required", "interrupted"].includes(run?.status);
  const executionState = (status) => executionStopped && stateOf(status).tone === "running" ? stateOf("unsettled") : stateOf(status);
  const tasks = list(run?.taskGraph?.tasks);
  const edges = list(run?.taskGraph?.delegations);
  const attempts = list(run?.turnAttempts);
  const snapshot = list(run?.teamRoster);
  const snapshots = new Map(snapshot.map((member) => [member.id, member]));
  const label = (id) => id === "lo" || id === "LO" ? "LO" : !id ? "未分配" : String(snapshots.get(id)?.name || snapshots.get(id)?.label || memberLabel(id) || id);
  const edgeByMessage = new Map(edges.filter((edge) => edge.busMessageId).map((edge) => [edge.busMessageId, edge]));
  const projectedTasks = tasks.map((task) => {
    const edge = edgeByMessage.get(task.busMessageId);
    const root = task.kind === "root" || task.id === run?.taskGraph?.rootTaskId;
    // edgeKind 是**结构化**的交接类型（pipeline-review / pipeline-rework / …），
    // 供消费方按类型判断；stage 只是它的中文文案，文案子串匹配会误伤
    // （「按复核补强」包含「复核」二字）。渲染层不得再自行解释 state——
    // 已停止 Run 的残留 running 必须走 state 的投影结果。
    return { ...task, root, edgeKind: edge?.kind || null, owner: label(task.assigneeId), stage: root ? "目标" : KINDS[edge?.kind] || "成员执行", state: executionState(task.status) };
  });
  const linkedAttempts = new Set(tasks.map((task) => task.attemptId).filter(Boolean));
  const linkedMessages = new Set(tasks.map((task) => task.busMessageId).filter(Boolean));
  const standalone = attempts.filter((attempt) => !linkedAttempts.has(attempt.attemptId) && !(attempt.sourceBusMessageId && linkedMessages.has(attempt.sourceBusMessageId))).map((attempt) => {
    const status = ["prepared", "session_ready", "submitting", "submitted"].includes(attempt.phase) ? "running" : attempt.phase;
    return { id: `attempt:${attempt.attemptId}`, attemptId: attempt.attemptId, root: false, edgeKind: null, assigneeId: attempt.agentId, owner: label(attempt.agentId), title: `第 ${attempt.round || "-"} 轮 · ${label(attempt.agentId)}`, stage: "成员执行", status, state: executionState(status) };
  });
  projectedTasks.splice(projectedTasks[0]?.root ? 1 : 0, 0, ...standalone);
  const work = projectedTasks.filter((task) => !task.root);
  const counts = { total: work.length, running: 0, queued: 0, complete: 0, attention: 0, inactive: 0, unknown: 0 };
  for (const task of work) counts[task.state.tone] += 1;
  // A Run's roster is historical evidence. Live Conversation members are only a draft fallback.
  const memberIds = run
    ? [...new Set([...(Array.isArray(run.teamMembers) ? run.teamMembers : []), ...snapshot.map((member) => member.id), run.coordinatorId, run.executionOwnerId, ...projectedTasks.map((task) => task.assigneeId), ...edges.flatMap((edge) => [edge.fromAgentId, edge.toAgentId])].filter((id) => id && !["lo", "LO", "team", "memo", "system"].includes(id)))]
    : [...new Set(conversation?.memberIds || [])];
  const members = memberIds.map((id) => {
    const roles = [];
    if (id === run?.coordinatorId) roles.push("协调");
    if (id === run?.executionOwnerId || (!run && id === conversation?.directMemberId)) roles.push("执行");
    if (edges.some((edge) => edge.kind === "pipeline-review" && edge.toAgentId === id)) roles.push("复核");
    const ownTasks = work.filter((task) => task.assigneeId === id);
    return { id, label: label(id), snapshot: snapshots.get(id), roles: roles.length ? roles : ["协作成员"], running: ownTasks.filter((task) => task.state.tone === "running").length, total: ownTasks.length };
  });
  const reviewEdges = edges.filter((edge) => edge.kind === "pipeline-review");
  const reworkEdges = edges.filter((edge) => edge.kind === "pipeline-rework");
  const result = run?.result || {};
  const reviewText = typeof result.critique === "string" ? result.critique : typeof result.independent === "string" ? result.independent : "";
  const reworked = result.reworked === true || reworkEdges.some((edge) => edge.state === "completed");
  const reviewed = Boolean(reviewText.trim()) || reviewEdges.some((edge) => edge.state === "completed");
  const review = { recorded: reviewed, text: reviewText, reworked, reworkText: reworked && typeof result.verified === "string" ? result.verified : "", label: reviewed ? "已有复核记录" : reviewEdges.length ? "复核尚未完成" : "暂无复核记录" };
  // 复核进度按**结构化交接类型**分桶，不按 stage 中文文案做子串匹配：
  // 「按复核补强」也含「复核」二字，子串匹配会把补强任务算成复核任务。
  // 数据源用 edges（有 kind），不用投影后的 tasks（stage 已被翻译成中文）。
  const reviewProgress = {
    total: reviewEdges.length,
    complete: reviewEdges.filter((edge) => edge.state === "completed").length,
    // 失败/丢失等走同一状态词典判 attention，避免在模型层再维护一份状态名单
    attention: reviewEdges.filter((edge) => stateOf(edge.state).tone === "attention").length,
    reworkTotal: reworkEdges.length,
    reworkComplete: reworkEdges.filter((edge) => edge.state === "completed").length,
  };
  const method = !run ? "尚未编排" : result.simpleShortCircuit || run.conversationKind === "direct" ? "单席直达" : run.orchestrationMode === "social" ? "按需协作" : run.collaborationMode === "deep" ? "执行、复核与补强" : "执行与复核";
  const incomplete = result.truncated === true || counts.attention > 0 || counts.queued > 0 || counts.running > 0 || counts.unknown > 0;
  const status = !run ? "尚未运行" : run.status === "succeeded" ? incomplete ? "运行结束，仍有未闭环事项" : "运行结束，验收待确认" : runStatusText(run.status, run);
  const attention = run?.pendingAsk ? "等待你的回答" : ["waiting_approval", "waiting_for_approval"].includes(run?.status) ? "等待你的审批" : run?.status === "recovery_required" ? "执行状态待确认恢复" : result.truncated ? "本轮已到执行限制，流程未完整收束" : counts.attention ? `${counts.attention} 项执行需要处理` : "";
  return {
    runId: String(run?.id || ""), title: String(run?.prompt || conversation?.title || "尚未选择工作对话"),
    method, status, attention, tasks: projectedTasks, counts, members, review, reviewProgress,
    delegations: edges.map((edge) => ({ ...edge, from: label(edge.fromAgentId), to: label(edge.toAgentId), stage: KINDS[edge.kind] || "成员交接", stateView: executionState(edge.state) })),
    steps: Number.isFinite(run?.interactionStep) ? run.interactionStep : null,
    stepLimit: Number.isFinite(run?.maxStepsPerInteraction ?? run?.maxRounds) ? run.maxStepsPerInteraction ?? run.maxRounds : null,
    depthLimit: run?.socialContract?.delegationDepthLimit ?? run?.delegationDepthLimit ?? null,
    queuedMessages: Array.isArray(run?.pendingSteer) ? run.pendingSteer.length : 0,
    terminal: TERMINAL.has(run?.status),
    // 运行终态语义：渲染层据此区分「干净收束」与「失败/取消/未闭环」，
    // 不得只看 counts.attention（那只覆盖任务级注意力，漏掉 truncated 与失败终态）。
    outcome: !run ? "none" : !TERMINAL.has(run?.status) ? "running" : run.status === "succeeded" ? (result.truncated === true || incomplete ? "incomplete" : "clean") : "failed",
  };
}

export function collaborationPage(entries, requested = 0) {
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const page = Math.max(0, Math.min(pages - 1, Math.trunc(Number(requested)) || 0));
  return { page, pages, total: entries.length, entries: entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) };
}

const badge = (state) => `<span class="collaboration-state" data-tone="${state.tone}">${lucideIcon(state.icon)}${esc(state.label)}</span>`;
const identity = (name, value) => value ? `<div><dt>${name}</dt><dd>${esc(value)}</dd></div>` : "";

function paging(kind, page) {
  if (page.pages < 2) return "";
  return `<nav class="workspace-message-paging" aria-label="${kind === "tasks" ? "任务分工" : "委派与交接"}分页"><button type="button" data-workspace-graph-page="${kind}" data-page="${page.page}" data-direction="-1" title="上一页" aria-label="上一页"${page.page === 0 ? " disabled" : ""}>${lucideIcon("arrow-left")}</button><span>${page.page + 1} / ${page.pages} · ${page.total} 条</span><button type="button" data-workspace-graph-page="${kind}" data-page="${page.page}" data-direction="1" title="下一页" aria-label="下一页"${page.page + 1 >= page.pages ? " disabled" : ""}>${lucideIcon("arrow-right")}</button></nav>`;
}

export function collaborationProcessMarkup(model, { tasksPage = 0, delegationsPage = 0, filter = "all", memberAvatar = () => "" } = {}) {
  const filtered = filter === "attention" ? model.tasks.filter((task) => task.state.tone === "attention") : model.tasks;
  const tasks = collaborationPage(filtered, tasksPage);
  const edges = collaborationPage(model.delegations, delegationsPage);
  const taskRows = tasks.entries.map((task) => `<details class="collaboration-task" data-bot-task-id="${esc(task.id)}" data-stream-key="task:${esc(task.id)}" data-tone="${task.state.tone}">
    <summary><span class="collaboration-task-stage">${esc(task.stage)}</span><span class="collaboration-task-title"><strong>${esc(task.title || "未命名任务")}</strong><small>${esc(task.owner)}</small></span>${badge(task.state)}${lucideIcon("chevron-down", "icon lucide collaboration-expand")}</summary>
    <dl class="collaboration-identities">${identity("任务", task.id)}${identity("执行记录", task.attemptId)}${identity("上游任务", task.parentTaskId)}${identity("交接来源", task.sourceAttemptId)}</dl>
  </details>`).join("");
  const handoffs = edges.entries.map((edge) => `<li data-bot-delegation-id="${esc(edge.id)}" data-stream-key="edge:${esc(edge.id)}"><span class="collaboration-handoff-mark">${lucideIcon(edge.kind === "pipeline-review" ? "shield-check" : "git-branch")}</span><details class="collaboration-handoff"><summary><span><strong>${esc(edge.from)} ${lucideIcon("arrow-right")} ${esc(edge.to)}</strong><small>${esc(edge.stage)}</small></span>${badge(edge.stateView)}${lucideIcon("chevron-down", "icon lucide collaboration-expand")}</summary><dl class="collaboration-identities">${identity("交接", edge.id)}${identity("来源执行", edge.sourceAttemptId)}${identity("接收执行", edge.targetAttemptId)}${identity("层级", edge.depth)}</dl></details></li>`).join("");
  return `<header class="workspace-insights-heading collaboration-heading" data-stream-key="collaboration-heading"><div><h3>协作过程</h3><span>${esc(model.method)}</span></div><span>${esc(model.status)}</span></header>
    <div class="collaboration-objective" data-stream-key="collaboration-objective"><span>本轮目标</span><p>${esc(model.title)}</p></div>
    ${model.attention ? `<div class="collaboration-attention" data-stream-key="collaboration-attention">${lucideIcon("circle-alert")}<span>${esc(model.attention)}</span></div>` : ""}
    <dl class="collaboration-counts" data-stream-key="collaboration-counts">${[["执行中", model.counts.running, "running"], ["待执行", model.counts.queued, "queued"], ["已完成", model.counts.complete, "complete"], ["需处理", model.counts.attention, "attention"]].map(([label, count, tone]) => `<div data-tone="${tone}"><dt>${label}</dt><dd>${count}</dd></div>`).join("")}</dl>
    <div class="collaboration-columns" data-stream-key="collaboration-columns"><div class="collaboration-main">
      <section class="collaboration-section"><header><h4>任务分工</h4><nav class="collaboration-filters" aria-label="任务筛选"><button type="button" data-workspace-task-filter="all" aria-pressed="${filter !== "attention"}">全部</button><button type="button" data-workspace-task-filter="attention" aria-pressed="${filter === "attention"}">需处理</button></nav></header>${taskRows || `<p class="workspace-empty">${filter === "attention" ? "没有需要处理的任务记录" : "暂无执行分工"}</p>`}${paging("tasks", tasks)}</section>
      <section class="collaboration-section"><header><h4>委派与交接</h4><span>${model.delegations.length} 次</span></header>${handoffs ? `<ol class="collaboration-handoffs">${handoffs}</ol>` : '<p class="workspace-empty">尚无成员交接</p>'}${paging("delegations", edges)}</section>
    </div><aside class="collaboration-sidebar" aria-label="本轮协作成员与限制"><section class="collaboration-section"><header><h4>责任成员</h4><span>${model.members.length} 位</span></header><ul class="collaboration-members">${model.members.map((member) => `<li data-stream-key="member:${esc(member.id)}"><span class="bot-agent-avatar">${memberAvatar(member)}</span><span><strong>${esc(member.label)}</strong><small>${esc(member.roles.join(" / "))}</small></span>${member.running ? `<span class="collaboration-member-active">执行中</span>` : ""}</li>`).join("") || '<li class="workspace-empty">尚未配置成员</li>'}</ul></section>
      <section class="collaboration-section"><header><h4>本轮记录</h4></header><dl class="collaboration-facts"><div><dt>执行步骤</dt><dd>${model.steps ?? "-"} / ${model.stepLimit ?? "-"}</dd></div><div><dt>复核</dt><dd>${esc(model.review.label)}</dd></div><div><dt>补强</dt><dd>${model.review.reworked ? "已有补强记录" : "暂无补强记录"}</dd></div>${model.depthLimit != null ? `<div><dt>交接深度上限</dt><dd>${esc(model.depthLimit)}</dd></div>` : ""}<div><dt>待处理消息</dt><dd>${model.queuedMessages}</dd></div></dl></section>
    </aside></div>`;
}

export function collaborationReviewMarkup(model, renderMarkdown) {
  if (!model.runId) return "";
  return `<section class="collaboration-review" data-stream-key="collaboration-review"><header><h4>复核与补强</h4><span>${esc(model.review.label)}</span></header>${model.review.text ? `<details data-stream-key="review-text"><summary>${lucideIcon("shield-check")}复核意见${lucideIcon("chevron-down", "icon lucide collaboration-expand")}</summary><div class="md-body">${renderMarkdown(model.review.text)}</div></details>` : '<p class="workspace-empty">暂无可展示的复核意见</p>'}${model.review.reworkText ? `<details data-stream-key="rework-text"><summary>${lucideIcon("git-branch")}补强交卷${lucideIcon("chevron-down", "icon lucide collaboration-expand")}</summary><div class="md-body">${renderMarkdown(model.review.reworkText)}</div></details>` : ""}</section>`;
}
