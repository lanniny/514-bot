import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  retireWorkbenchView,
  isRetiredWorkbenchHash,
  botConversationForRun,
  conversationListsRun,
  listActiveRuns,
  listFinishedRuns,
  listRecoverableRuns,
  botActiveRunsMarkup,
  botActiveRunFiltersMarkup,
  botActiveRunsToolbarMarkup,
  botRunStatusChip,
  botRunAgentId,
  groupActiveRuns,
  botOpsApprovalsMarkup,
  botOpsInboxMarkup,
  botOpsInboxCount,
  botMemberConnectionsMarkup,
  botHostConnectionsMarkup,
  botMemberComputerRows,
  botUnassignedHostRows,
  botMemberComputerCount,
  botMemberAssignedHost,
  botHostConnectionTone,
  isWorkbenchViewActive,
  selectOptionsMarkup,
  normalizeComposerPermission,
} from "../public/modules/bot-workspace-chrome.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const source = async (path) => (await readFile(`${appRoot}/${path}`, "utf8")).replace(/\r\n/g, "\n");

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

test("chrome helpers remap retired workbench and render Bot folds", () => {
  assert.equal(retireWorkbenchView("workbench"), "bot");
  assert.equal(isRetiredWorkbenchHash("#config/workbench"), false);
  assert.equal(isRetiredWorkbenchHash("#workbench?run=r"), true);

  const conversations = [
    { id: "c1", activeRunId: "r-old" },
    { id: "c2", runIds: ["r-live", "r-done"] },
  ];
  assert.equal(botConversationForRun(conversations, "r-live")?.id, "c2");
  assert.equal(botConversationForRun(conversations, "missing"), null);
  assert.equal(botConversationForRun(conversations, "r-via-id", { id: "r-via-id", conversationId: "c1" })?.id, "c1");
  assert.equal(conversationListsRun(conversations[1], "r-live"), true);
  assert.equal(conversationListsRun(conversations[0], "r-live"), false);

  const runs = [
    { id: "r1", status: "running", title: "正在写补丁", startAgentId: "codex-technical", updatedAt: "2026-09-10T05:00:00.000Z" },
    { id: "r2", status: "completed", title: "已结束" },
    { id: "r3", status: "interrupted", title: "被打断的长标题".repeat(8) },
  ];
  assert.deepEqual(listActiveRuns(runs).map((run) => run.id), ["r1", "r3"]);
  assert.deepEqual(listFinishedRuns(runs).map((run) => run.id), ["r2"]);
  assert.deepEqual(listRecoverableRuns(runs).map((run) => run.id), ["r3"]);
  assert.equal(botRunAgentId(runs[0]), "codex-technical");
  const grouped = groupActiveRuns(runs);
  assert.deepEqual(grouped.groups.map((group) => group.id), ["running", "warning"]);

  const markup = botActiveRunsMarkup(runs, {
    escapeHtml,
    selectedRunId: "r1",
    agentLabel: (id) => id === "codex-technical" ? "烛" : id,
    formatRelative: () => "3 分钟前",
  });
  assert.match(markup, /data-bot-active-run="r1"/);
  assert.match(markup, /is-current/);
  assert.match(markup, /data-bot-active-run="r3"/);
  assert.doesNotMatch(markup, /data-bot-active-run="r2"/);
  assert.match(markup, /bot-run-status-chip is-running/);
  assert.match(markup, />进行中</);
  assert.match(markup, />已中断</);
  // 分组标题行**本身**就是折叠开关（整行可点，不只 chevron）：钉死按钮语义 + aria 双向绑定。
  // 2026-10-11 前它是 `<div class="bot-active-run-group-title">`——不可点，「正在工作」区因此无法折叠。
  assert.match(markup, /<button class="bot-active-run-group-title" type="button" aria-expanded="true" aria-controls="bot-run-group-rows-running" data-bot-run-group-toggle="running">/);
  assert.match(markup, /<span>进行中<\/span><b>1<\/b>/);
  assert.match(markup, /id="bot-run-group-rows-running" role="group">/);
  assert.match(markup, /bot-active-run-meta/);
  assert.match(markup, />烛</);
  assert.match(markup, />3 分钟前</);
  assert.doesNotMatch(markup, />interrupted</);
  assert.doesNotMatch(markup, />waiting_agent</);
  assert.doesNotMatch(markup, />recovery_required</);

  // 分组折叠：只藏行不丢行（展开即时，不需要重新取 runs 快照），且不连带未折叠的兄弟组
  const groupCollapsed = botActiveRunsMarkup(runs, { escapeHtml, collapsedGroups: new Set(["running"]) });
  assert.match(groupCollapsed, /<section class="bot-active-run-group is-collapsed" data-bot-run-group="running">/);
  assert.match(groupCollapsed, /aria-expanded="false" aria-controls="bot-run-group-rows-running"/);
  assert.match(groupCollapsed, /id="bot-run-group-rows-running" role="group" hidden>/);
  assert.match(groupCollapsed, /data-bot-active-run="r1"/, "折叠只许藏行，不许把行从 DOM 里删掉");
  assert.match(groupCollapsed, /id="bot-run-group-rows-warning" role="group">/, "未折叠的兄弟组不得被连带藏掉");
  // 数组形态也要吃（调用方不保证传 Set）
  const arrayForm = botActiveRunsMarkup(runs, { escapeHtml, collapsedGroups: ["warning"] });
  // id 作用域断言：中缀写法（data-bot-run-group=...[\s\S]*?hidden）会跨过分组边界，
  // 把兄弟组的 hidden 算到本组头上——恒真/恒假就在这里滋生。
  assert.match(arrayForm, /id="bot-run-group-rows-warning" role="group" hidden>/, "数组形态的 warning 组必须折叠");
  assert.match(arrayForm, /id="bot-run-group-rows-running" role="group">/, "数组形态的 running 组不得被连带折叠");

  const filters = botActiveRunFiltersMarkup(runs, { escapeHtml, filter: "running" });
  assert.match(filters, /data-bot-run-filter="all"/);
  assert.match(filters, /bot-active-run-filter is-active"[^>]*data-bot-run-filter="running"/);
  assert.match(filters, /data-bot-run-filter="warning"/);
  const filtered = botActiveRunsMarkup(runs, { escapeHtml, filter: "running" });
  assert.match(filtered, /data-bot-active-run="r1"/);
  assert.doesNotMatch(filtered, /data-bot-active-run="r3"/);

  const toolbar = botActiveRunsToolbarMarkup(runs, { escapeHtml });
  assert.match(toolbar, /data-bot-clear-finished/);
  assert.match(toolbar, /清理已结束 · 1/);
  assert.match(toolbar, /需恢复 1 项/);

  assert.equal(botRunStatusChip("waiting_agent").label, "等待中");
  assert.equal(botRunStatusChip("recovery_required").label, "需恢复");
  assert.equal(botRunStatusChip("interrupted").label, "已中断");
  assert.equal(isWorkbenchViewActive({
    getElementById: () => ({ classList: { contains: () => false } }),
  }), false);

  const many = Array.from({ length: 8 }, (_, index) => ({
    id: `r-extra-${index}`,
    status: "waiting_agent",
    title: `任务 ${index + 1}`,
  }));
  const collapsed = botActiveRunsMarkup(many, { escapeHtml });
  assert.match(collapsed, /还有 2 项工作/);
  assert.equal([...collapsed.matchAll(/data-bot-active-run="/g)].length, 6);
  const expanded = botActiveRunsMarkup(many, { escapeHtml, expanded: true });
  assert.match(expanded, /收起列表/);
  assert.equal([...expanded.matchAll(/data-bot-active-run="/g)].length, 8);

  assert.match(
    botOpsApprovalsMarkup([{ id: "a1", method: "tool", runId: "r1", status: "pending" }], { escapeHtml }),
    /data-approval-id="a1"/,
  );
  assert.match(
    botMemberConnectionsMarkup([{ id: "codex-technical", label: "烛", cli: "lo@host", tone: "ok", configured: true }], { escapeHtml }),
    /已连接/,
  );
  assert.match(
    botHostConnectionsMarkup([{ id: "h1", name: "书房", user: "lo", host: "192.168.1.8", enabled: true, tone: "unknown", statusLabel: "未探测" }], { escapeHtml }),
    /书房/,
  );
  assert.doesNotMatch(
    botHostConnectionsMarkup([{ id: "h1", name: "书房", user: "lo", host: "192.168.1.8", enabled: true, tone: "unknown", statusLabel: "未探测" }], { escapeHtml }),
    /已连接/,
  );

  assert.match(
    selectOptionsMarkup([{ value: "plan", label: "只读计划" }], "plan", { escapeHtml }),
    /selected/,
  );
  assert.equal(normalizeComposerPermission("review"), "review");
  assert.equal(normalizeComposerPermission("build"), "build");
  assert.equal(normalizeComposerPermission("auto"), "plan");
});

test("member computers ignore agent pulse and stay 未配置 without a host", () => {
  const rows = botMemberComputerRows({
    members: [
      { id: "claude-fable", label: "Claude", tone: "ok", cli: "Claude" },
      { id: "codex-technical", label: "烛", tone: "live", cli: "Codex" },
    ],
    hosts: [],
    probes: {},
  });
  assert.deepEqual(rows.map((row) => row.tone), ["none", "none"]);
  assert.equal(rows.every((row) => row.configured === false), true);
  assert.deepEqual(botMemberComputerCount(rows), { connected: 0, configured: 0, total: 2 });
  const markup = botMemberConnectionsMarkup(rows, { escapeHtml });
  assert.match(markup, /未配置/);
  assert.doesNotMatch(markup, /已连接/);
  assert.doesNotMatch(markup, /工作中/);
  assert.equal(botMemberAssignedHost({ id: "claude-fable" }, []), null);
});

test("assigned member host uses probe status, never pulse live/ok", () => {
  const hosts = [{ id: "h1", name: "书房", user: "lo", host: "192.168.1.8", enabled: true }];
  assert.equal(botMemberAssignedHost({ id: "claude-fable", hostId: "h1" }, hosts)?.id, "h1");
  const down = botMemberComputerRows({
    members: [{ id: "claude-fable", label: "Claude", hostId: "h1", tone: "live" }],
    hosts,
    probes: { h1: { status: "error" } },
  });
  assert.equal(down[0].tone, "error");
  assert.equal(down[0].configured, true);
  assert.match(botMemberConnectionsMarkup(down, { escapeHtml }), /断开/);
  assert.doesNotMatch(botMemberConnectionsMarkup(down, { escapeHtml }), /工作中/);
  assert.equal(botHostConnectionTone(hosts[0], null).tone, "unknown");
  assert.equal(botUnassignedHostRows([{ id: "claude-fable", hostId: "h1" }], hosts, {}).length, 0);
  assert.equal(botUnassignedHostRows([{ id: "claude-fable" }], hosts, { h1: { status: "ok" } })[0].tone, "ok");

  const viaHostMember = botMemberComputerRows({
    members: [{ id: "grok-builder", label: "织" }],
    hosts: [{ id: "h2", name: "工位", user: "lo", host: "10.0.0.8", enabled: true, memberId: "grok-builder" }],
    probes: { h2: { status: "ok" } },
  });
  assert.equal(viaHostMember[0].configured, true);
  assert.equal(viaHostMember[0].tone, "ok");
  assert.deepEqual(botMemberComputerCount(viaHostMember), { connected: 1, configured: 1, total: 1 });
  assert.match(botMemberConnectionsMarkup(viaHostMember, { escapeHtml }), /已连接/);
});

test("会话协作收件箱：失败如实报错、降级如实标注、待办计数排除已回答", () => {
  // 读取失败：只呈现失败原因，绝不拿旧载荷冒充新鲜
  const failed = botOpsInboxMarkup(null, { escapeHtml, error: "HTTP 500" });
  assert.match(failed, /收件箱读取失败/);
  assert.match(failed, /HTTP 500/);
  assert.match(failed, /data-tone="error"/);

  // 尚未加载：给引导，不伪装成「没有待办」
  assert.match(botOpsInboxMarkup(null, { escapeHtml }), /还没有协作收件箱/);
  assert.equal(botOpsInboxCount(null), 0);
  assert.equal(botOpsInboxCount({}), 0);

  const inbox = {
    pendingAsks: [
      { id: "a1", from: "织", text: "请确认巡检范围", lifecycle: "delivered", runId: "r1", runTitle: "巡检" },
      { id: "a2", from: "烛", text: "已回话", lifecycle: "answered", runId: "r1" },
    ],
    diagnostics: { status: "ok", runsRead: 1, runsTotal: 1, issues: [] },
  };
  const markup = botOpsInboxMarkup(inbox, { escapeHtml });
  assert.match(markup, /织 在等你回答/);
  assert.match(markup, /请确认巡检范围/);
  assert.match(markup, /待你回答/);
  assert.match(markup, /已回答/);
  assert.match(markup, /data-bot-ask-id="a1"/);
  assert.equal(botOpsInboxCount(inbox), 1, "已回答的 ask 不再计入「待我处理」");
  assert.doesNotMatch(botOpsInboxMarkup(inbox, { escapeHtml }), /仅显示可读部分/);

  // 降级：如实说明看到的不全，并带上源诊断
  const degraded = botOpsInboxMarkup({
    pendingAsks: [],
    diagnostics: { status: "partial", runsRead: 1, runsTotal: 3, issues: [{ message: "run x 总线不可读" }] },
  }, { escapeHtml });
  assert.match(degraded, /仅显示可读部分/);
  assert.match(degraded, /1\/3/);
  assert.match(degraded, /run x 总线不可读/);

  // 消息窗口满：降级原因必须来自真实成因（此处 runsRead===runsTotal，不能谎称「运行没读全」），
  // 且空态**不得**断言「没有待办」——那正是最该被提醒的场景，静默假阴性比不说更糟。
  const windowFull = botOpsInboxMarkup({
    pendingAsks: [],
    diagnostics: {
      status: "partial",
      runsRead: 1,
      runsTotal: 1,
      issues: [{ code: "INBOX_MESSAGES_TRUNCATED", message: "消息窗口已达上限（128 条），更早的待办可能未列出" }],
    },
  }, { escapeHtml });
  assert.match(windowFull, /仅显示可读部分/);
  assert.match(windowFull, /消息窗口已达上限/);
  assert.doesNotMatch(windowFull, /1\/1 个运行/, "运行读全时不得把降级原因归给运行");
  assert.match(windowFull, /当前窗口内没有待你回答的事项（更早的可能未列出）/);
  assert.doesNotMatch(windowFull, /没有需要你回答的协作事项/);

  // 注入：ask 正文与来源都必须转义
  const injected = botOpsInboxMarkup({
    pendingAsks: [{ id: "a<b>", from: "<img>", text: "<script>alert(1)</script>", lifecycle: "delivered" }],
    diagnostics: { status: "ok" },
  }, { escapeHtml });
  assert.doesNotMatch(injected, /<script>/);
  assert.match(injected, /&lt;script&gt;/);
});

test("待办行必须真的可作答：待答行给按钮语义，已回答行不给", () => {
  // 2026-10-09 审计：渲染器只发了 data-bot-ask-id / data-run-id 而全仓零消费者，
  // 行是死文本——用户看到「等你回答」却无从下手。这里把「有动作」这件事钉住。
  const pending = botOpsInboxMarkup({
    pendingAsks: [{ id: "a1", from: "织", text: "请确认范围", lifecycle: "delivered", runId: "r1" }],
    diagnostics: { status: "ok" },
  }, { escapeHtml });
  assert.match(pending, /data-bot-ask-open/, "待答行必须带可操作钩子");
  assert.match(pending, /role="button"/);
  assert.match(pending, /tabindex="0"/);
  assert.match(pending, /aria-label="[^"]*织[^"]*"/, "按钮必须有无障碍名");
  assert.match(pending, /class="bot-ops-ask is-actionable"/);

  // 已回答的行没有可执行的动作：做成按钮是另一种谎
  const answered = botOpsInboxMarkup({
    pendingAsks: [{ id: "a2", from: "烛", text: "已回话", lifecycle: "answered", runId: "r1" }],
    diagnostics: { status: "ok" },
  }, { escapeHtml });
  assert.doesNotMatch(answered, /data-bot-ask-open/);
  assert.doesNotMatch(answered, /role="button"/);
  assert.match(answered, /class="bot-ops-ask"/);
  assert.doesNotMatch(answered, /is-actionable/);
});

test("可操作钩子在 app.js 有唯一消费者，且走既有作答路径（不新造第二套机制）", async () => {
  const app = await source("public/app.js");
  // 生产端与消费端必须同时存在——只发不收就是死行
  assert.match(app, /closest\("\[data-bot-ask-open\]"\)/);
  assert.match(app, /function openBotOpsAskRow\(/);
  // 唯一出口：复用 botPendingAskContext（自带新鲜度闸）+ botPrepareAnswerTarget
  const body = /function openBotOpsAskRow\([\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.match(body, /botPendingAskContext\(/, "必须走新鲜度闸，不能直接把陈旧 ask 塞进 composer");
  assert.match(body, /botPrepareAnswerTarget\(/, "必须复用既有作答目标路径");
  assert.match(body, /openBotForRun\(runId\)/, "必须先打开 run 所属会话，否则对着别的会话作答");
  // 键盘可达：role=button 的 div/article 没有原生激活行为
  assert.match(app, /event\.key !== "Enter" && event\.key !== " "/);
});
