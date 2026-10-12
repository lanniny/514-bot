import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { collaborationProcessModel } from "../public/modules/collaboration-process.js";
import { enhancedCollaborationProcessMarkup, collaborationTimelineMarkup, expandMemoryFor } from "../public/modules/collaboration-process-enhanced.js";

// 每个用例独立根元素，避免自动展开记忆在用例间串味（记忆按渲染根存续）
const fakeRoot = () => ({});
const render = (model, options = {}) => enhancedCollaborationProcessMarkup(model, { expandMemory: expandMemoryFor(fakeRoot()), ...options });

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");
// 注释里提到的令牌名/断点不是真实引用。断言前必须剥掉注释，
// 否则「文件头解释为什么不能引用 X」会被读成「引用了 X」。
const readCode = (relative) => read(relative)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const readCss = (relative) => read(relative).replace(/\/\*[\s\S]*?\*\//g, "");

const runWith = (overrides = {}) => collaborationProcessModel({
  run: {
    id: "run-1",
    status: "succeeded",
    coordinatorId: "candle",
    executionOwnerId: "candle",
    teamMembers: ["candle", "weave"],
    taskGraph: {
      tasks: [
        { id: "root", kind: "root", status: "succeeded", assigneeId: "candle" },
        { id: "work", status: "succeeded", assigneeId: "candle", busMessageId: "m1" },
        { id: "review", status: "succeeded", assigneeId: "weave", busMessageId: "m2" },
      ],
      delegations: [
        { id: "d1", kind: "pipeline-review", fromAgentId: "candle", toAgentId: "weave", state: "completed", busMessageId: "m2" },
      ],
    },
    ...overrides,
  },
});

test("attention 任务自动展开，普通任务保持折叠", () => {
  const model = runWith({ taskGraph: { tasks: [
    { id: "root", kind: "root", status: "succeeded" },
    { id: "broken", status: "lost", assigneeId: "candle" },
    { id: "fine", status: "succeeded", assigneeId: "candle" },
  ], delegations: [] } });
  const markup = render(model);
  assert.match(markup, /data-bot-task-id="broken"[^>]*data-tone="attention" open/);
  assert.match(markup, /data-bot-task-id="fine"[^>]*data-tone="complete">/);
});

test("复核任务自动展开，但「按复核补强」不算复核任务", () => {
  const model = runWith({ taskGraph: {
    tasks: [
      { id: "root", kind: "root", status: "succeeded" },
      { id: "review", status: "succeeded", assigneeId: "weave", busMessageId: "m2" },
      { id: "rework", status: "succeeded", assigneeId: "candle", busMessageId: "m3" },
    ],
    delegations: [
      { id: "d1", kind: "pipeline-review", fromAgentId: "candle", toAgentId: "weave", state: "completed", busMessageId: "m2" },
      { id: "d2", kind: "pipeline-rework", fromAgentId: "weave", toAgentId: "candle", state: "completed", busMessageId: "m3" },
    ],
  } });
  // 两者都是质量关键节点，都自动展开
  const markup = render(model);
  assert.match(markup, /data-bot-task-id="review"[^>]* open>/);
  assert.match(markup, /data-bot-task-id="rework"[^>]* open>/);
  // 但复核进度只数 review 边，不把补强算进去
  assert.equal(model.reviewProgress.total, 1);
  assert.equal(model.reviewProgress.complete, 1);
  assert.equal(model.reviewProgress.reworkTotal, 1);
});

test("只有补强、没有复核时，时间轴不得声称存在复核记录", () => {
  const model = runWith({ taskGraph: {
    tasks: [
      { id: "root", kind: "root", status: "succeeded" },
      { id: "rework", status: "succeeded", assigneeId: "candle", busMessageId: "m3" },
    ],
    delegations: [
      { id: "d2", kind: "pipeline-rework", fromAgentId: "weave", toAgentId: "candle", state: "completed", busMessageId: "m3" },
    ],
  } });
  assert.equal(model.reviewProgress.total, 0);
  const timeline = collaborationTimelineMarkup(model);
  assert.doesNotMatch(timeline, /交叉复核/, "无复核边时不得渲染复核进度");
  assert.match(timeline, /按复核补强/);
});

/**
 * 从整段 markup 里切出某条委派交接的 `<li>` 区块。
 *
 * ⚠️ 不能用「起点 + N 字符窗口」做邻近断言：单个 Lucide 图标就是 ~90 字符，
 * 一条交接在状态徽章之前已经排了 600+ 字符的 SVG，窗口给小了会**恒不命中**
 * （断言永远通过 = 假保护，实测该写法连注入缺陷都拦不住）。
 * 按区块边界切，与 markup 长度解耦。
 */
function delegationBlock(markup, id) {
  const start = markup.indexOf(`data-bot-delegation-id="${id}"`);
  if (start < 0) return "";
  const rest = markup.slice(start + 1);
  const next = rest.indexOf("data-bot-delegation-id=");
  return next < 0 ? markup.slice(start) : markup.slice(start, start + 1 + next);
}

test("已停止 Run 的交接不得显示为「执行中」（与模型投影一致）", () => {
  for (const status of ["succeeded", "failed", "cancelled", "recovery_required", "interrupted"]) {
    const model = runWith({ status, taskGraph: {
      tasks: [{ id: "root", kind: "root", status: "succeeded" }],
      delegations: [{ id: "edge", kind: "pipeline-review", fromAgentId: "candle", toAgentId: "weave", state: "running" }],
    } });
    const block = delegationBlock(render(model), "edge");
    assert.ok(block, `${status}: 未渲染出该交接`);
    assert.doesNotMatch(block, /执行中/,
      `${status}: 渲染层不得重新解释原始 state，必须消费 edge.stateView`);
    assert.match(block, /执行状态待核对/, `${status}: 应显示模型投影后的待核对态`);
  }
});

test("运行中的交接仍显示「执行中」（防止上一条修过头）", () => {
  const model = runWith({ status: "running", taskGraph: {
    tasks: [{ id: "root", kind: "root", status: "running" }],
    delegations: [{ id: "edge", kind: "pipeline-review", fromAgentId: "candle", toAgentId: "weave", state: "running" }],
  } });
  const block = delegationBlock(render(model), "edge");
  assert.match(block, /执行中/, "未停止的 Run 应保留真实的执行中状态");
  assert.doesNotMatch(block, /执行状态待核对/);
});

test("时间轴终态四态分明：失败不得显示成功勾选", () => {
  const failed = collaborationTimelineMarkup(runWith({ status: "failed" }));
  assert.match(failed, /运行未成功/);
  assert.doesNotMatch(failed, /运行结束/);

  const cancelled = collaborationTimelineMarkup(runWith({ status: "cancelled" }));
  assert.match(cancelled, /运行未成功/);

  // succeeded 但 truncated —— 不得宣称干净完成
  const truncated = collaborationTimelineMarkup(runWith({ status: "succeeded", result: { truncated: true } }));
  assert.match(truncated, /运行结束（未闭环）/);

  const clean = collaborationTimelineMarkup(runWith({ status: "succeeded" }));
  assert.match(clean, /运行结束/);
  assert.doesNotMatch(clean, /未闭环|未成功/);
});

test("失败复核计入 attention，不显示为执行中", () => {
  const model = runWith({ taskGraph: {
    tasks: [{ id: "root", kind: "root", status: "succeeded" }],
    delegations: [{ id: "d1", kind: "pipeline-review", fromAgentId: "candle", toAgentId: "weave", state: "failed" }],
  } });
  assert.equal(model.reviewProgress.attention, 1);
  const timeline = collaborationTimelineMarkup(model);
  assert.match(timeline, /data-event-type="review" data-tone="attention"/);
  assert.doesNotMatch(timeline, /data-event-type="review" data-tone="running"/);
});

test("流水线时间轴只列 run 自身可证明的里程碑", () => {
  const timeline = collaborationTimelineMarkup(runWith());
  assert.match(timeline, /派工决策/);
  assert.match(timeline, /交叉复核/);
  assert.match(timeline, /运行结束/);
  // DELTA 无 run 级归属 —— 时间轴不得出现推翻/白发类事件
  assert.doesNotMatch(timeline, /推翻|白发|补强主驾|DELTA=/);
});

test("无 run 时不渲染时间轴", () => {
  assert.equal(collaborationTimelineMarkup(collaborationProcessModel({})), "");
});

test("增强版与原版共享转义行为，恶意数据不得逃逸", () => {
  const model = collaborationProcessModel({ run: { id: "r", prompt: '<img src=x onerror="alert(1)">', teamMembers: ["<script>"], taskGraph: { tasks: [
    { id: 'bad" onclick="x', title: "<script>attack</script>", status: "failed" },
  ] } } });
  const markup = render(model);
  assert.doesNotMatch(markup, /<script>|<img src=x/);
  assert.match(markup, /&lt;script&gt;attack/);
  assert.match(markup, /data-stream-key="task:bad&quot;/);
});

test("增强渲染不得注入伪造的 DELTA 数据通道", () => {
  const source = readCode("public/modules/collaboration-process-enhanced.js");
  // 关联字段在数据契约上不存在（observability.mjs deltas[] = {id,ts,agent,score,topic,evidence}）
  assert.doesNotMatch(source, /d\.taskId|d\.attemptId/, "DELTA 记录无任务级归属，不得按 taskId/attemptId 猜关联");
  assert.doesNotMatch(source, /delta-badge/, "DELTA 徽章依赖不存在的关联字段");
  const app = readCode("public/app.js");
  assert.doesNotMatch(app, /state\.deltaData/, "state.deltaData 是无人消费的死状态，不得回流");
});

test("增强样式只消费已定义的令牌，不自造", () => {
  const css = readCss("public/forge/collaboration-enhanced.css");
  // 全仓零定义的令牌（曾导致玻璃底/描边静默失效）
  for (const dead of ["--forge-glass-bg", "--forge-surface-1", "--forge-surface-2", "--forge-line", "--bot-secondary"]) {
    assert.ok(!css.includes(dead), `${dead} 在全仓零定义，引用即静默失效`);
  }
  // 暗色走 [data-theme] 令牌翻转，不得用系统偏好媒体查询
  assert.doesNotMatch(css, /prefers-color-scheme/, "Forge 暗色由 [data-theme] 驱动，prefers-color-scheme 不会响应用户切换");
  assert.match(css, /prefers-reduced-motion/, "新增动效必须提供降级");
});

test("增强样式不覆盖原版任务卡 grid 布局", () => {
  const css = readCss("public/forge/collaboration-enhanced.css");
  assert.doesNotMatch(css, /\.collaboration-task\s*>\s*summary\s*\{[^}]*display\s*:\s*flex/,
    "原版 summary 是 grid（76px 阶段列 + 70px 行高），flex 覆盖会抹掉布局");
});

test("响应式走容器查询而非视口断点", () => {
  const css = readCss("public/forge/collaboration-enhanced.css");
  assert.match(css, /@container/, "作用域是 #workspace-insights 的行内尺寸，视口宽不等于容器宽");
  assert.doesNotMatch(css, /@media[^{]*max-width/, "容器内布局不得用视口断点");
});

test("自动展开只在任务首次出现时生效，之后用户折叠优先", () => {
  const model = runWith({ taskGraph: { tasks: [
    { id: "root", kind: "root", status: "succeeded" },
    { id: "broken", status: "lost", assigneeId: "candle" },
  ], delegations: [] } });
  const memory = expandMemoryFor(fakeRoot());

  // 首次渲染：关键节点自动展开
  const first = enhancedCollaborationProcessMarkup(model, { expandMemory: memory });
  assert.match(first, /data-bot-task-id="broken"[^>]* open>/);

  // 协调器会按 fresh markup 重新同步 open 属性（bounded-message-view.js:46-48），
  // 所以后续渲染必须不再输出 open，否则用户折叠会被下一次刷新顶开。
  const second = enhancedCollaborationProcessMarkup(model, { expandMemory: memory });
  assert.doesNotMatch(second, /data-bot-task-id="broken"[^>]* open>/,
    "第二次渲染不得再强制展开——那会覆盖用户的手动折叠");
});

test("展开记忆按渲染根隔离，不同 surface 各自展开一次", () => {
  const model = runWith({ taskGraph: { tasks: [
    { id: "root", kind: "root", status: "succeeded" },
    { id: "broken", status: "lost", assigneeId: "candle" },
  ], delegations: [] } });
  const a = expandMemoryFor(fakeRoot());
  const b = expandMemoryFor(fakeRoot());
  assert.notEqual(a, b, "不同根必须拿到不同记忆");
  assert.match(enhancedCollaborationProcessMarkup(model, { expandMemory: a }), /data-bot-task-id="broken"[^>]* open>/);
  assert.match(enhancedCollaborationProcessMarkup(model, { expandMemory: b }), /data-bot-task-id="broken"[^>]* open>/,
    "另一个 surface 应仍能自动展开一次");
  assert.doesNotMatch(enhancedCollaborationProcessMarkup(model, { expandMemory: a }), /data-bot-task-id="broken"[^>]* open>/);
});

test("非关键节点永远不自动展开", () => {
  const model = runWith({ taskGraph: { tasks: [
    { id: "root", kind: "root", status: "succeeded" },
    { id: "fine", status: "succeeded", assigneeId: "candle" },
  ], delegations: [] } });
  const memory = expandMemoryFor(fakeRoot());
  const markup = enhancedCollaborationProcessMarkup(model, { expandMemory: memory });
  assert.doesNotMatch(markup, /data-bot-task-id="fine"[^>]* open>/);
  // 记忆不得因为普通任务而被污染
  assert.equal(memory.size, 0);
});

test("提供 memberAvatar 时渲染交接与任务的席位头像流", () => {
  const model = runWith({
    taskGraph: {
      tasks: [
        { id: "root", kind: "root", status: "succeeded" },
        { id: "review", status: "succeeded", assigneeId: "weave", busMessageId: "m2" },
      ],
      delegations: [
        { id: "d1", kind: "pipeline-review", fromAgentId: "candle", toAgentId: "weave", state: "completed", busMessageId: "m2" },
      ],
    },
  });
  const markup = enhancedCollaborationProcessMarkup(model, {
    memberAvatar: (member) => `<img alt="${member.id}" src="/avatars/${member.id}.png">`,
  });
  assert.match(markup, /class="collaboration-mini-avatar"/);
  assert.match(markup, /src="\/avatars\/candle\.png"/);
  assert.match(markup, /src="\/avatars\/weave\.png"/);
  assert.match(markup, /class="collaboration-handoff-flow"/);
});

test("流水线时间轴带有步进索引节点", () => {
  const timeline = collaborationTimelineMarkup(runWith());
  assert.match(timeline, /class="timeline-step-index">1<\/span>/);
  assert.match(timeline, /class="timeline-step-index">2<\/span>/);
});
