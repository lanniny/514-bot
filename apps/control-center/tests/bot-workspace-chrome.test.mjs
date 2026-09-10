import test from "node:test";
import assert from "node:assert/strict";
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
  assert.match(markup, /bot-active-run-group-title">进行中/);
  assert.match(markup, /bot-active-run-meta/);
  assert.match(markup, />烛</);
  assert.match(markup, />3 分钟前</);
  assert.doesNotMatch(markup, />interrupted</);
  assert.doesNotMatch(markup, />waiting_agent</);
  assert.doesNotMatch(markup, />recovery_required</);

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
