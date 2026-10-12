import test from "node:test";
import assert from "node:assert/strict";
import {
  UNIFIED_DELIVERABLE_SCHEMA,
  createUnifiedDeliverable,
  formatUnifiedDeliverableMarkdown,
  validateUnifiedDeliverable,
} from "../src/unified-deliverable.mjs";
import { createResearchCheckpoint } from "../src/research-checkpoint.mjs";
import { createEvidenceMatrix, addFileEvidence, addDeltaEvidence } from "../src/evidence-matrix.mjs";

test("createUnifiedDeliverable combines checkpoints, evidence matrix, and settlement correctly", () => {
  const c1 = createResearchCheckpoint({
    phase: "plan",
    progress: 20,
    status: "completed",
    findings: [{ text: "需求边界清晰", category: "decision" }],
  });
  const c2 = createResearchCheckpoint({
    phase: "verify",
    progress: 100,
    status: "completed",
    findings: [{ text: "所有测试绿灯通过", category: "fact" }],
  });

  let matrix = createEvidenceMatrix({ runId: "run-u-1" });
  matrix = addFileEvidence(matrix, {
    relativePath: "src/server.mjs",
    startLine: 1,
    endLine: 20,
    content: "import ...",
  });
  matrix = addDeltaEvidence(matrix, {
    agent: "烛",
    score: 1,
    evidence: "新增统一成果模型",
    topic: "deliverable",
  });

  const deliverable = createUnifiedDeliverable({
    run: { id: "run-u-1", title: "功能交付 run-u-1", turnCount: 3, tokenUsageTotal: 1500, costUsdTotal: 0.05 },
    checkpoints: [c1, c2],
    evidenceMatrix: matrix,
    settlement: { verdict: "reviewable", nextAction: { id: "review-diff", reason: "核对产物 diff" } },
  });

  assert.equal(deliverable.schema, UNIFIED_DELIVERABLE_SCHEMA);
  assert.equal(deliverable.runId, "run-u-1");
  assert.equal(deliverable.title, "功能交付 run-u-1");
  assert.equal(deliverable.status, "completed");
  assert.equal(deliverable.checkpoints.total, 2);
  assert.equal(deliverable.checkpoints.findingsCount, 2);
  assert.equal(deliverable.evidenceMatrix.totalCount, 2);
  assert.equal(deliverable.budget.turnsUsed, 3);
  assert.equal(deliverable.budget.costUsd, 0.05);
  assert.equal(deliverable.delta.agent, "烛");
  assert.equal(deliverable.delta.score, 1);
  assert.ok(deliverable.nextActions.some((a) => a.id === "review-diff"));
});

test("createUnifiedDeliverable detects blocked status and highlights risks in nextActions", () => {
  const c1 = createResearchCheckpoint({
    phase: "analyze",
    progress: 50,
    status: "in_progress",
    findings: [{ text: "存在未通过的越权校验", category: "risk" }],
  });

  const deliverable = createUnifiedDeliverable({
    run: { id: "run-u-2", status: "failed" },
    checkpoints: [c1],
    settlement: { verdict: "blocked", nextAction: { id: "permission", reason: "缺少工作区写权限" } },
  });

  assert.equal(deliverable.status, "blocked");
  assert.ok(deliverable.nextActions.some((a) => a.id === "review-risks"));
  assert.ok(deliverable.nextActions.some((a) => a.id === "permission"));
});

test("formatUnifiedDeliverableMarkdown produces structured markdown report", () => {
  const c1 = createResearchCheckpoint({
    phase: "verify",
    progress: 100,
    status: "completed",
    findings: [{ text: "接口契约测试 100% 覆盖", category: "fact", source: "tests/server.test.mjs" }],
  });

  let matrix = createEvidenceMatrix();
  matrix = addDeltaEvidence(matrix, {
    agent: "织(Gemini)",
    score: 1,
    evidence: "A4 统一成果交付",
  });

  const deliverable = createUnifiedDeliverable({
    run: { id: "run-u-3", title: "A4 验收" },
    checkpoints: [c1],
    evidenceMatrix: matrix,
    now: "2026-09-18T10:00:00.000Z",
  });

  const md = formatUnifiedDeliverableMarkdown(deliverable);
  assert.match(md, /# A4 验收/);
  assert.match(md, /状态：\*\*COMPLETED\*\*/);
  assert.match(md, /接口契约测试 100% 覆盖/);
  assert.match(md, /__DELTA__: 织\(Gemini\) \| 1 \| 证据：A4 统一成果交付/);
});

test("validateUnifiedDeliverable validates schema and properties", () => {
  const valid = createUnifiedDeliverable({ run: { id: "run-v-1" } });
  assert.equal(validateUnifiedDeliverable(valid).ok, true);

  assert.equal(validateUnifiedDeliverable(null).ok, false);
  assert.equal(validateUnifiedDeliverable({}).ok, false);
  assert.equal(validateUnifiedDeliverable({ ...valid, schema: "unknown" }).ok, false);
  assert.equal(validateUnifiedDeliverable({ ...valid, status: null }).ok, false);
});
