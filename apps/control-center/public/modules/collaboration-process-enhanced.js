/**
 * collaboration-process-enhanced.js — 协作过程可见性增强模块
 *
 * 增强点（纯渲染层，数据模型沿用 collaboration-process.js，不改投影）：
 * 1. 关键节点自动展开（attention 状态、复核任务）
 * 2. 协作流水线时间轴（run 级里程碑）
 *
 * ⚠️ 关于 DELTA —— 本模块**不**把 DELTA 记录内联到任务卡，且**不**在 run 时间轴里
 * 呈现 DELTA 事件。这是 2026-10-02 核验后的结论，不是遗漏：
 *
 *   · DELTA 账本的产出形状是 `{id, ts, agent, score, topic, evidence}`
 *     （`src/observability.mjs:159-166`），**既无 taskId 也无 attemptId** ——
 *     「某个任务被推翻」在数据契约上不存在，任何此类呈现都是伪造的。
 *   · `/api/observability/delta` 返回的是**全局**账本，不带 run 过滤；
 *     把它当作「本 run 的推翻次数」同样是伪造。
 *   · 系统内唯一带 run 归属的 DELTA 投影是 `collectRunEvidenceArtifacts`
 *     （`src/run-artifacts.mjs:106`，经 `evidenceBelongsToRun` 按 token 匹配），
 *     但它只产出 artifact 卡（`{id, kind, availability, endpoint, published}`），
 *     不携带 agent / score / evidence，不足以渲染。
 *
 * 因此 DELTA 的呈现继续由 `public/delta-timeline.js`（观测页，全局账本）承担。
 * 若要把 DELTA 提到协作主线（v48 P-02），前置是补一个 run 级 DELTA 契约，
 * 而不是在渲染层猜关联。
 */

import { escapeHtml as esc } from "../utils.js";
import { lucideIcon } from "../lucide.js";
import { collaborationPage } from "./collaboration-process.js";

const badge = (state) => `<span class="collaboration-state" data-tone="${state.tone}">${lucideIcon(state.icon)}${esc(state.label)}</span>`;
const identity = (name, value) => value ? `<div><dt>${name}</dt><dd>${esc(value)}</dd></div>` : "";

/**
 * 判断任务是否为关键节点（应自动展开）。
 *
 * 只认运行态投影里**确实存在**的信号：attention 需要处理、复核/补强是质量关键节点。
 * 复核判定走结构化 `edgeKind`（pipeline-review / pipeline-rework），
 * **不用** `stage.includes("复核")` —— 「按复核补强」也含「复核」二字，子串匹配会误判。
 * 不按 DELTA 展开——DELTA 无任务级归属（见文件头说明）。
 */
function isKeyTask(task) {
  if (task.state.tone === "attention") return true;
  if (task.edgeKind === "pipeline-review" || task.edgeKind === "pipeline-rework") return true;
  return false;
}

/**
 * 自动展开只在任务**首次**出现时生效——一旦渲染过，用户的手动折叠就必须赢。
 *
 * 为什么需要这层记忆：`reconcileMessageMarkup` 的协调器对 `open` 属性是
 * **单向**的（`bounded-message-view.js:46` 把 DETAILS 的 open 从「删除豁免」里
 * 排除，但 `:48` 仍会在 fresh 带 open 时把它加回去）。若每次都输出 open，
 * 用户折叠后只要该行数据一变（状态推进、标题更新）就会被顶开。
 *
 * 键按 `${runId}:${taskId}` 组合，跨 Run 互不干扰；有上限，防长会话无界增长。
 *
 * 记忆的作用域必须与**渲染面**同寿命，不能是模块级单例：同一个 Run 可能同时出现在
 * 多个 surface 上，模块级单例会让后一个 surface 永远不展开。调用方（app.js）
 * 按根元素取记忆，见 `expandMemoryFor(root)`。
 */
const EXPAND_MEMORY_LIMIT = 500;
const memoryByRoot = new WeakMap();
// 无根元素可依附时的兜底（例如一次性离屏渲染）。有 surface 的调用方一律走 expandMemoryFor。
let fallbackMemory = new Set();

/** 取某个渲染根专属的展开记忆；同一根元素反复渲染共享，不同根互不影响。 */
export function expandMemoryFor(root) {
  if (!root || (typeof root !== "object" && typeof root !== "function")) return fallbackMemory;
  let memory = memoryByRoot.get(root);
  if (!memory) {
    memory = new Set();
    memoryByRoot.set(root, memory);
  }
  return memory;
}

function shouldAutoOpen(model, task, memory) {
  if (!isKeyTask(task)) return false;
  const key = `${model.runId}:${task.id}`;
  if (memory.has(key)) return false;
  memory.add(key);
  if (memory.size > EXPAND_MEMORY_LIMIT) {
    for (const oldest of memory) {
      memory.delete(oldest);
      if (memory.size <= EXPAND_MEMORY_LIMIT) break;
    }
  }
  return true;
}

/**
 * 协作流水线时间轴 —— 只列 **run 自身** 可证明的里程碑。
 *
 * 状态语义全部取自模型，不在渲染层重新解释：
 *  · 复核进度用 `model.reviewProgress`（按结构化交接类型分桶），
 *    不用 stage 中文文案做子串匹配（「按复核补强」也含「复核」）。
 *  · 终态用 `model.outcome`（clean / incomplete / failed / running），
 *    不只看 counts.attention——那只覆盖任务级注意力。
 */
export function collaborationTimelineMarkup(model) {
  if (!model.runId) return "";

  const events = [];

  // 1. 派工决策
  if (model.method && model.method !== "尚未编排") {
    events.push({ type: "dispatch", label: "派工决策", detail: model.method, icon: "git-branch", tone: "complete" });
  }

  // 2. 交叉复核进度（结构化分桶）
  const progress = model.reviewProgress || { total: 0, complete: 0, attention: 0, reworkTotal: 0, reworkComplete: 0 };
  if (progress.total > 0) {
    const done = progress.complete === progress.total;
    events.push({
      type: "review",
      label: "交叉复核",
      detail: `${progress.complete}/${progress.total} 已完成`,
      icon: "shield-check",
      // 有失败复核时用 attention，未跑完用 running，全完成才 complete
      tone: progress.attention > 0 ? "attention" : done ? "complete" : "running",
    });
  }

  // 3. 按复核补强
  if (model.review.reworked) {
    const reworkDone = progress.reworkTotal > 0 && progress.reworkComplete === progress.reworkTotal;
    events.push({
      type: "rework",
      label: "按复核补强",
      detail: progress.reworkTotal > 0 ? `${progress.reworkComplete}/${progress.reworkTotal} 已完成` : "已交卷",
      icon: "refresh-cw",
      tone: reworkDone || progress.reworkTotal === 0 ? "complete" : "running",
    });
  }

  // 4. 运行终态 —— 四态分明，不把「没 attention」等同于成功
  if (model.terminal) {
    const outcome = model.outcome || "clean";
    const terminalMeta = {
      clean: { icon: "circle-check", tone: "complete", label: "运行结束" },
      incomplete: { icon: "circle-alert", tone: "attention", label: "运行结束（未闭环）" },
      failed: { icon: "circle-alert", tone: "attention", label: "运行未成功" },
    }[outcome] || { icon: "circle-check", tone: "complete", label: "运行结束" };
    events.push({
      type: "terminal",
      label: terminalMeta.label,
      detail: model.status,
      icon: terminalMeta.icon,
      tone: terminalMeta.tone,
    });
  }

  if (events.length === 0) return "";

  const eventItems = events.map((evt, idx) => `
    <li class="timeline-event" data-event-type="${esc(evt.type)}" data-tone="${esc(evt.tone)}">
      <span class="timeline-step-index">${idx + 1}</span>
      <span class="timeline-icon">${lucideIcon(evt.icon)}</span>
      <span class="timeline-content">
        <strong>${esc(evt.label)}</strong>
        <small>${esc(evt.detail)}</small>
      </span>
    </li>
  `).join("");

  return `<div class="collaboration-timeline" data-stream-key="collaboration-timeline">
    <h4>协作流水线</h4>
    <ol class="timeline-events">${eventItems}</ol>
  </div>`;
}

/**
 * 增强版协作过程渲染：在原版基础上加时间轴与关键节点自动展开。
 *
 * 渲染契约（转义/身份键/空态）与原版 `collaboration-process.js` 的
 * `collaborationProcessMarkup` 保持一致——该函数保留为可回退的基线实现，
 * 目前无调用方（由本模块整体接管），由 tests/collaboration-process.test.mjs 覆盖。
 */
export function enhancedCollaborationProcessMarkup(model, options = {}) {
  const {
    tasksPage = 0, delegationsPage = 0, filter = "all", memberAvatar = () => "",
    expandMemory = fallbackMemory,
  } = options;

  const memberMap = new Map((model.members || []).map((m) => [m.id, m]));
  const renderMiniAvatar = (agentId) => {
    if (!agentId || agentId === "lo" || agentId === "LO") return "";
    const member = memberMap.get(agentId) || { id: agentId };
    const html = memberAvatar(member);
    if (!html) return "";
    return `<span class="collaboration-mini-avatar" aria-hidden="true">${html}</span>`;
  };

  const filtered = filter === "attention" ? model.tasks.filter((task) => task.state.tone === "attention") : model.tasks;
  const tasks = collaborationPage(filtered, tasksPage);
  const edges = collaborationPage(model.delegations, delegationsPage);

  const taskRows = tasks.entries.map((task) => `<details class="collaboration-task" data-bot-task-id="${esc(task.id)}" data-stream-key="task:${esc(task.id)}" data-tone="${task.state.tone}"${shouldAutoOpen(model, task, expandMemory) ? " open" : ""}>
    <summary><span class="collaboration-task-stage">${esc(task.stage)}</span><span class="collaboration-task-title"><strong>${esc(task.title || "未命名任务")}</strong><small class="collaboration-task-owner">${renderMiniAvatar(task.assigneeId)}${esc(task.owner)}</small></span>${badge(task.state)}${lucideIcon("chevron-down", "icon lucide collaboration-expand")}</summary>
    <dl class="collaboration-identities">${identity("任务", task.id)}${identity("执行记录", task.attemptId)}${identity("上游任务", task.parentTaskId)}${identity("交接来源", task.sourceAttemptId)}</dl>
  </details>`).join("");

  const paging = (kind, page) => {
    if (page.pages < 2) return "";
    return `<nav class="workspace-message-paging" aria-label="${kind === "tasks" ? "任务分工" : "委派与交接"}分页">
      <button type="button" data-workspace-graph-page="${kind}" data-page="${page.page}" data-direction="-1" title="上一页" aria-label="上一页"${page.page === 0 ? " disabled" : ""}>${lucideIcon("arrow-left")}</button>
      <span>${page.page + 1} / ${page.pages} · ${page.total} 条</span>
      <button type="button" data-workspace-graph-page="${kind}" data-page="${page.page}" data-direction="1" title="下一页" aria-label="下一页"${page.page + 1 >= page.pages ? " disabled" : ""}>${lucideIcon("arrow-right")}</button>
    </nav>`;
  };

  const handoffs = edges.entries.map((edge) => `
    <li data-bot-delegation-id="${esc(edge.id)}" data-stream-key="edge:${esc(edge.id)}">
      <span class="collaboration-handoff-mark">${lucideIcon(edge.kind === "pipeline-review" ? "shield-check" : "git-branch")}</span>
      <details class="collaboration-handoff">
        <summary>
          <span>
            <strong class="collaboration-handoff-flow">
              <span class="collaboration-peer">${renderMiniAvatar(edge.fromAgentId)}${esc(edge.from)}</span>
              ${lucideIcon("arrow-right", "collaboration-handoff-arrow")}
              <span class="collaboration-peer">${renderMiniAvatar(edge.toAgentId)}${esc(edge.to)}</span>
            </strong>
            <small>${esc(edge.stage)}</small>
          </span>
          ${badge(edge.stateView)}
          ${lucideIcon("chevron-down", "icon lucide collaboration-expand")}
        </summary>
        <dl class="collaboration-identities">
          ${identity("交接", edge.id)}
          ${identity("来源执行", edge.sourceAttemptId)}
          ${identity("接收执行", edge.targetAttemptId)}
          ${identity("层级", edge.depth)}
        </dl>
      </details>
    </li>`).join("");

  return `
    <header class="workspace-insights-heading collaboration-heading" data-stream-key="collaboration-heading">
      <div>
        <h3>协作过程</h3>
        <span>${esc(model.method)}</span>
      </div>
      <span>${esc(model.status)}</span>
    </header>

    <div class="collaboration-objective" data-stream-key="collaboration-objective">
      <span>本轮目标</span>
      <p>${esc(model.title)}</p>
    </div>

    ${model.attention ? `<div class="collaboration-attention" data-stream-key="collaboration-attention">${lucideIcon("circle-alert")}<span>${esc(model.attention)}</span></div>` : ""}

    ${collaborationTimelineMarkup(model)}

    <dl class="collaboration-counts" data-stream-key="collaboration-counts">
      ${[["执行中", model.counts.running, "running"], ["待执行", model.counts.queued, "queued"], ["已完成", model.counts.complete, "complete"], ["需处理", model.counts.attention, "attention"]]
        .map(([label, count, tone]) => `<div data-tone="${tone}"><dt>${label}</dt><dd>${count}</dd></div>`)
        .join("")}
    </dl>

    <div class="collaboration-columns" data-stream-key="collaboration-columns">
      <div class="collaboration-main">
        <section class="collaboration-section">
          <header>
            <h4>任务分工</h4>
            <nav class="collaboration-filters" aria-label="任务筛选">
              <button type="button" data-workspace-task-filter="all" aria-pressed="${filter !== "attention"}">全部</button>
              <button type="button" data-workspace-task-filter="attention" aria-pressed="${filter === "attention"}">需处理</button>
            </nav>
          </header>
          ${taskRows || `<p class="workspace-empty">${filter === "attention" ? "没有需要处理的任务记录" : "暂无执行分工"}</p>`}
          ${paging("tasks", tasks)}
        </section>

        <section class="collaboration-section">
          <header>
            <h4>委派与交接</h4>
            <span>${model.delegations.length} 次</span>
          </header>
          ${handoffs ? `<ol class="collaboration-handoffs">${handoffs}</ol>` : '<p class="workspace-empty">尚无成员交接</p>'}
          ${paging("delegations", edges)}
        </section>
      </div>

      <aside class="collaboration-sidebar" aria-label="本轮协作成员与限制">
        <section class="collaboration-section">
          <header>
            <h4>责任成员</h4>
            <span>${model.members.length} 位</span>
          </header>
          <ul class="collaboration-members">
            ${model.members.map((member) => `
              <li data-stream-key="member:${esc(member.id)}">
                <span class="bot-agent-avatar">${memberAvatar(member)}</span>
                <span>
                  <strong>${esc(member.label)}</strong>
                  <small>${esc(member.roles.join(" / "))}</small>
                </span>
                ${member.running ? `<span class="collaboration-member-active">执行中</span>` : ""}
              </li>
            `).join("") || '<li class="workspace-empty">尚未配置成员</li>'}
          </ul>
        </section>

        <section class="collaboration-section">
          <header><h4>本轮记录</h4></header>
          <dl class="collaboration-facts">
            <div><dt>执行步骤</dt><dd>${model.steps ?? "-"} / ${model.stepLimit ?? "-"}</dd></div>
            <div><dt>复核</dt><dd>${esc(model.review.label)}</dd></div>
            <div><dt>补强</dt><dd>${model.review.reworked ? "已有补强记录" : "暂无补强记录"}</dd></div>
            ${model.depthLimit != null ? `<div><dt>交接深度上限</dt><dd>${esc(model.depthLimit)}</dd></div>` : ""}
            <div><dt>待处理消息</dt><dd>${model.queuedMessages}</dd></div>
          </dl>
        </section>
      </aside>
    </div>
  `;
}
