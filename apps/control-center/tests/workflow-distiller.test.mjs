import test from "node:test";
import assert from "node:assert/strict";
import {
  isDistillableRun,
  distillWorkflowFromRun,
  distillWorkflowFromConversation,
} from "../src/workflow-distiller.mjs";
import { ROUTINE_SCHEMA } from "../src/bots/routines.mjs";

test("isDistillableRun recognizes completed or outcome-bearing runs", () => {
  assert.equal(isDistillableRun(null), false);
  assert.equal(isDistillableRun({}), false);
  assert.equal(isDistillableRun({ status: "running" }), false);
  assert.equal(isDistillableRun({ status: "completed" }), true);
  assert.equal(isDistillableRun({ status: "succeeded" }), true);
  assert.equal(isDistillableRun({ outcome: "completed" }), true);
  assert.equal(isDistillableRun({ turns: [{ text: "done", outcome: "completed" }] }), true);
});

test("distillWorkflowFromRun produces valid routine draft with checkpoints and evidence", () => {
  const run = {
    id: "run-abc-123",
    conversationId: "conv-xyz-789",
    directMemberId: "assistant",
    prompt: "重构 control-center 路由并补全单元测试",
    result: { final: "重构完成，全套测试绿灯通过" },
    status: "completed",
  };

  const checkpoints = [
    { phase: "plan", label: "方案设计", status: "completed", description: "制定重构计划", findings: [{ statement: "路由存在重复注册" }] },
    { phase: "execute", label: "代码编写", status: "completed", description: "重构 server.mjs", findings: [] },
    { phase: "verify", label: "测试验证", status: "completed", description: "运行 node --test", findings: [{ statement: "所有用例通过" }] },
  ];

  const evidenceMatrix = {
    items: [
      { type: "file", title: "server.mjs", locator: "server.mjs:100-150" },
      { type: "tool", title: "node --test", locator: "exit: 0" },
    ],
  };

  const deliverable = {
    summary: "成功完成 server.mjs 路由重构并实现 100% 绿灯",
  };

  const draft = distillWorkflowFromRun(run, { checkpoints, evidenceMatrix, deliverable });

  assert.equal(draft.schema, ROUTINE_SCHEMA);
  assert.match(draft.id, /^routine-distilled-run-abc-123/);
  assert.equal(draft.owningMemberId, "assistant");
  assert.equal(draft.title, "重构 control-center 路由并补全单元测试");
  assert.ok(draft.instructions.includes("方案设计"));
  assert.ok(draft.instructions.includes("server.mjs:100-150"));
  assert.ok(draft.instructions.includes("重构完成，全套测试绿灯通过"));
  assert.equal(draft.expectedOutput, "成功完成 server.mjs 路由重构并实现 100% 绿灯");
  assert.equal(draft.enabled, false);
  assert.equal(draft.noDataPolicy, "report-failure");
  assert.equal(draft.inputSource.kind, "conversation");
  assert.equal(draft.inputSource.conversationId, "conv-xyz-789");
  assert.equal(draft.distilledFrom.checkpointCount, 3);
  assert.equal(draft.distilledFrom.evidenceCount, 2);
});

test("distillWorkflowFromConversation aggregates multi-run conversation workflow", () => {
  const conversation = {
    id: "conv-long-task",
    title: "数据分析全套流程",
    directMemberId: "analyst-bot",
    runIds: ["run-1", "run-2"],
  };

  const runsMap = new Map([
    ["run-1", { id: "run-1", prompt: "收集销售数据", status: "completed" }],
    ["run-2", { id: "run-2", prompt: "生成可视化图表与报告", status: "completed" }],
  ]);

  const checkpointsMap = new Map([
    ["run-1", [{ phase: "search", label: "抓取数据" }]],
    ["run-2", [{ phase: "deliver", label: "交付图表" }]],
  ]);

  const draft = distillWorkflowFromConversation(conversation, runsMap, { checkpointsMap });

  assert.equal(draft.schema, ROUTINE_SCHEMA);
  assert.equal(draft.owningMemberId, "analyst-bot");
  assert.equal(draft.title, "会话工作流 - 数据分析全套流程");
  assert.ok(draft.instructions.includes("抓取数据"));
  assert.ok(draft.instructions.includes("交付图表"));
  assert.equal(draft.distilledFrom.runCount, 2);
  assert.equal(draft.distilledFrom.checkpointCount, 2);
});
