import test from "node:test";
import assert from "node:assert/strict";
import {
  retireWorkbenchView,
  isRetiredWorkbenchHash,
  botConversationForRun,
  listActiveRuns,
  botActiveRunsMarkup,
  botRunStatusChip,
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

  const runs = [
    { id: "r1", status: "running", title: "正在写补丁" },
    { id: "r2", status: "completed", title: "已结束" },
    { id: "r3", status: "interrupted", title: "被打断的长标题".repeat(8) },
  ];
  assert.deepEqual(listActiveRuns(runs).map((run) => run.id), ["r1", "r3"]);
  const markup = botActiveRunsMarkup(runs, { escapeHtml, selectedRunId: "r1" });
  assert.match(markup, /data-bot-active-run="r1"/);
  assert.match(markup, /is-current/);
  assert.match(markup, /data-bot-active-run="r3"/);
  assert.doesNotMatch(markup, /data-bot-active-run="r2"/);
  assert.match(markup, /bot-run-status-chip is-running/);
  assert.match(markup, />进行中</);
  assert.match(markup, />已中断</);
  assert.doesNotMatch(markup, />interrupted</);
  assert.doesNotMatch(markup, />waiting_agent</);
  assert.doesNotMatch(markup, />recovery_required</);

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
    selectOptionsMarkup([{ value: "plan", label: "只读计划" }], "plan", { escapeHtml }),
    /selected/,
  );
  assert.equal(normalizeComposerPermission("review"), "review");
  assert.equal(normalizeComposerPermission("build"), "build");
  assert.equal(normalizeComposerPermission("auto"), "plan");
});
