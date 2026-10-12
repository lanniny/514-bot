import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_CHECKPOINT_SCHEMA,
  STANDARD_RESEARCH_PHASES,
  createResearchCheckpoint,
  updateResearchCheckpoint,
  appendFindingToCheckpoint,
  sanitizeFinding,
  normalizeBudgetUsage,
  checkBudgetLimits,
  calculateOverallProgress,
  validateResearchCheckpoint,
} from "../src/research-checkpoint.mjs";

test("createResearchCheckpoint populates defaults, clamps progress and assigns schema", () => {
  const chk = createResearchCheckpoint({
    runId: "run-test-1",
    phase: "analyze",
    progress: 120, // should clamp to 100
  });

  assert.equal(chk.schema, RESEARCH_CHECKPOINT_SCHEMA);
  assert.equal(chk.runId, "run-test-1");
  assert.equal(chk.phase, "analyze");
  assert.equal(chk.phaseLabel, "分析定位");
  assert.equal(chk.progress, 100);
  assert.equal(chk.status, "in_progress");
  assert.ok(chk.id.startsWith("chk-"));
  assert.deepEqual(chk.findings, []);
  assert.equal(chk.budget.budgetExhausted, false);
});

test("sanitizeFinding correctly parses objects, clamps confidence and sanitizes strings", () => {
  const f1 = sanitizeFinding({
    text: "发现潜在路径穿越漏洞",
    category: "risk",
    confidence: 1.5, // should clamp to 1.0
    source: "src/file-evidence.mjs#L20-L40",
  });
  assert.equal(f1.text, "发现潜在路径穿越漏洞");
  assert.equal(f1.category, "risk");
  assert.equal(f1.confidence, 1.0);
  assert.equal(f1.source, "src/file-evidence.mjs#L20-L40");

  const f2 = sanitizeFinding("纯文本格式的事实");
  assert.equal(f2.text, "纯文本格式的事实");
  assert.equal(f2.category, "fact");
  assert.equal(f2.confidence, 1.0);
});

test("updateResearchCheckpoint updates progress, phase and status without mutating original", () => {
  const original = createResearchCheckpoint({
    runId: "run-test-2",
    phase: "search",
    progress: 30,
    status: "in_progress",
  });

  const updated = updateResearchCheckpoint(original, {
    phase: "execute",
    progress: 75,
    status: "completed",
    summary: "代码编写与执行完成",
  });

  assert.notEqual(original, updated);
  assert.equal(original.phase, "search");
  assert.equal(original.progress, 30);
  assert.equal(updated.phase, "execute");
  assert.equal(updated.phaseLabel, "方案执行");
  assert.equal(updated.progress, 75);
  assert.equal(updated.status, "completed");
  assert.equal(updated.summary, "代码编写与执行完成");
});

test("appendFindingToCheckpoint appends and deduplicates identical findings", () => {
  const chk = createResearchCheckpoint({ runId: "run-test-3" });
  const withOne = appendFindingToCheckpoint(chk, { id: "f-1", text: "事实 A" });
  assert.equal(withOne.findings.length, 1);

  // 重复 ID
  const withDupId = appendFindingToCheckpoint(withOne, { id: "f-1", text: "事实 A 修改版" });
  assert.equal(withDupId.findings.length, 1);

  // 重复文本
  const withDupText = appendFindingToCheckpoint(withOne, { id: "f-2", text: "事实 A" });
  assert.equal(withDupText.findings.length, 1);

  // 新事实
  const withTwo = appendFindingToCheckpoint(withOne, { id: "f-3", text: "事实 B" });
  assert.equal(withTwo.findings.length, 2);
});

test("checkBudgetLimits detects normal, warning, and exhausted thresholds", () => {
  const normalBudget = { turnsUsed: 2, turnsLimit: 10, tokensUsed: 1000, tokensLimit: 10000, costUsd: 0.1, costLimitUsd: 2.0 };
  const resNormal = checkBudgetLimits(normalBudget);
  assert.equal(resNormal.ok, true);
  assert.equal(resNormal.status, "normal");

  const warningBudget = { turnsUsed: 8, turnsLimit: 10, tokensUsed: 1000, tokensLimit: 10000 };
  const resWarning = checkBudgetLimits(warningBudget);
  assert.equal(resWarning.ok, true);
  assert.equal(resWarning.status, "warning");
  assert.match(resWarning.reason, /轮次接近上限/);

  const exhaustedBudget = { turnsUsed: 10, turnsLimit: 10, tokensUsed: 15000, tokensLimit: 10000 };
  const resExhausted = checkBudgetLimits(exhaustedBudget);
  assert.equal(resExhausted.ok, false);
  assert.equal(resExhausted.status, "exhausted");
  assert.match(resExhausted.reason, /轮次用尽/);
});

test("calculateOverallProgress summarizes multiple checkpoints correctly", () => {
  const c1 = createResearchCheckpoint({ phase: "plan", progress: 15, status: "completed" });
  const c2 = createResearchCheckpoint({ phase: "search", progress: 35, status: "completed" });
  const c3 = createResearchCheckpoint({ phase: "analyze", progress: 55, status: "in_progress" });

  const progress = calculateOverallProgress([c1, c2, c3]);
  assert.equal(progress.overallProgress, 55);
  assert.equal(progress.latestPhase, "analyze");
  assert.equal(progress.status, "in_progress");
  assert.equal(progress.completedPhasesCount, 2);
  assert.equal(progress.totalCheckpoints, 3);
});

test("validateResearchCheckpoint strictly verifies schema and mandatory fields", () => {
  const valid = createResearchCheckpoint({ runId: "run-valid" });
  assert.equal(validateResearchCheckpoint(valid).ok, true);

  assert.equal(validateResearchCheckpoint(null).ok, false);
  assert.equal(validateResearchCheckpoint({}).ok, false);
  assert.equal(validateResearchCheckpoint({ ...valid, schema: "unknown" }).ok, false);
  assert.equal(validateResearchCheckpoint({ ...valid, progress: -5 }).ok, false);
  assert.equal(validateResearchCheckpoint({ ...valid, status: "invalid_status" }).ok, false);
});
