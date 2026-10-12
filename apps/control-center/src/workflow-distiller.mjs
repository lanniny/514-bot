/**
 * workflow-distiller.mjs — 514cc 成功工作流提炼与自动化沉淀引擎 (A5 / v48 P-05 / v49 G-5)。
 *
 * 从成功完成的 Run 或 Conversation（经历 A4 检查点与证据矩阵）中，
 * 自动萃取提炼出可重复触发执行的例行任务（Routine Draft）或可复用工作流配方。
 * 生成的草稿严格对齐 bots/routines.mjs 契约（514cc.bot-routines/v1）。
 */

import { randomUUID } from "node:crypto";
import { ROUTINE_SCHEMA, ROUTINE_LIMITS, NO_DATA_POLICIES } from "./bots/routines.mjs";

export const WORKFLOW_DISTILLER_SCHEMA = "514cc.workflow-distiller/v1";

const SUCCESS_STATUSES = new Set(["completed", "complete", "succeeded", "ok"]);

function clip(text, max) {
  const value = String(text ?? "").trim();
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function firstNonEmpty(...values) {
  for (const val of values) {
    const s = String(val ?? "").trim();
    if (s) return s;
  }
  return "";
}

export function isDistillableRun(run) {
  if (!run || typeof run !== "object") return false;
  const status = String(run.status || "").toLowerCase();
  if (SUCCESS_STATUSES.has(status)) return true;
  // If run has outcome or result, it is also distillable
  if (run.outcome === "completed" || run.result) return true;
  // If run has turns with text
  if (Array.isArray(run.turns) && run.turns.some((t) => t.outcome === "completed" || t.text)) return true;
  return false;
}

export function extractRunGoal(run) {
  return firstNonEmpty(run?.prompt, run?.title, run?.chatUserText);
}

export function extractRunOutcome(run) {
  if (run?.result && typeof run.result === "object") {
    const fromResult = firstNonEmpty(
      run.result.final,
      run.result.verified,
      run.result.summary,
      run.result.plan,
      run.result.deliverable
    );
    if (fromResult) return fromResult;
  }
  const turns = Array.isArray(run?.turns) ? run.turns : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const text = String(turns[i]?.text || "").trim();
    if (text) return text;
  }
  return "";
}

/**
 * 从一次 Run 及其挂载的检查点、证据矩阵提炼出标准的例行任务草稿 (Routine Draft)。
 */
export function distillWorkflowFromRun(
  run,
  { checkpoints = [], deliverable = null, evidenceMatrix = null, owningMemberId = null } = {}
) {
  if (!run || typeof run !== "object") {
    throw new Error("run must be a valid object");
  }

  const goal = extractRunGoal(run);
  const outcome = extractRunOutcome(run);
  const runId = String(run.id || randomUUID());

  // 1. 标题 (Title)
  const baseTitle = goal ? goal.split(/\r?\n/)[0].trim() : `自动化任务 - ${runId.slice(0, 8)}`;
  const title = clip(baseTitle, ROUTINE_LIMITS.titleMax);

  // 2. 归属成员 (OwningMemberId)
  const member = firstNonEmpty(
    owningMemberId,
    run.directMemberId,
    run.agentId,
    run.memberIds?.[0],
    "assistant"
  );

  // 3. 指令集 (Instructions)
  const instructionSections = [];
  instructionSections.push(`## 任务目标\n${goal || "(未捕获具体目标，请在此补全)"}`);

  if (checkpoints && checkpoints.length > 0) {
    instructionSections.push("## 执行阶段流程 (来自已验证检查点)");
    checkpoints.forEach((cp, idx) => {
      const label = cp.phaseLabel || cp.label || cp.phase;
      const status = cp.status === "completed" ? "✔" : "·";
      instructionSections.push(`${idx + 1}. [${status}] ${label}: ${cp.description || cp.summary || "执行该阶段任务"}`);
      if (Array.isArray(cp.findings) && cp.findings.length > 0) {
        cp.findings.slice(0, 3).forEach((f) => {
          instructionSections.push(`   - 关键发现: ${clip(f.statement || f.text, 120)}`);
        });
      }
    });
  }

  if (evidenceMatrix?.items?.length) {
    instructionSections.push("## 关键证据与依赖来源");
    const topEvidence = evidenceMatrix.items.slice(0, 5);
    topEvidence.forEach((e) => {
      instructionSections.push(`- [${e.type}] ${e.title}: ${e.locator}`);
    });
  }

  if (outcome) {
    instructionSections.push(`## 历史有效产出参考\n${clip(outcome, 800)}`);
  }

  const instructions = clip(instructionSections.join("\n\n"), ROUTINE_LIMITS.instructionsMax);

  // 4. 期望产出 (Expected Output)
  let expectedOutput = "完成上述步骤并输出结构化成果与测试验证记录";
  if (deliverable?.summary) {
    expectedOutput = clip(deliverable.summary, ROUTINE_LIMITS.expectedOutputMax);
  } else if (outcome) {
    expectedOutput = clip(outcome.split(/\r?\n/)[0], ROUTINE_LIMITS.expectedOutputMax);
  }

  // 5. 审批边界与数据策略
  const approvalBoundary = "涉及工作区文件修改或外部发布前必须经过人工审批确认";
  const noDataPolicy = NO_DATA_POLICIES[0]; // "report-failure"

  // 6. 输入源
  const inputSource = run.conversationId
    ? { kind: "conversation", conversationId: String(run.conversationId) }
    : { kind: "prompt", prompt: clip(goal || title, 200) };

  const id = `routine-distilled-${runId.slice(0, 16)}`;

  return {
    schema: ROUTINE_SCHEMA,
    id,
    owningMemberId: member,
    title,
    skillRef: null,
    instructions,
    schedule: null, // 按需执行，用户可后续配置定时
    inputSource,
    expectedOutput,
    approvalBoundary,
    noDataPolicy,
    enabled: false, // 默认草稿态，待用户确认启用
    notes: `由成功 Run ${runId} 自动提炼生成于 ${new Date().toISOString()}`,
    distilledFrom: {
      type: "run",
      runId,
      conversationId: run.conversationId || null,
      checkpointCount: Array.isArray(checkpoints) ? checkpoints.length : 0,
      evidenceCount: Array.isArray(evidenceMatrix?.items) ? evidenceMatrix.items.length : 0,
      hasDeliverable: Boolean(deliverable),
    },
  };
}

/**
 * 从 Conversation 及其关联的所有 Runs 与检查点提炼工作流草稿。
 */
export function distillWorkflowFromConversation(
  conversation,
  runsMap = new Map(),
  { checkpointsMap = new Map(), deliverable = null } = {}
) {
  if (!conversation || typeof conversation !== "object") {
    throw new Error("conversation must be a valid object");
  }

  const convId = String(conversation.id);
  const runIds = Array.isArray(conversation.runIds) ? conversation.runIds : [];
  const validRuns = runIds
    .map((id) => (runsMap instanceof Map ? runsMap.get(id) : runsMap[id]))
    .filter(Boolean);

  // 收集所有 checkpoints
  const allCheckpoints = [];
  for (const runId of runIds) {
    const cps = checkpointsMap instanceof Map ? checkpointsMap.get(runId) : checkpointsMap[runId];
    if (Array.isArray(cps)) {
      allCheckpoints.push(...cps);
    }
  }

  const primaryGoal = conversation.title || (validRuns[0] ? extractRunGoal(validRuns[0]) : "");
  const baseTitle = `会话工作流 - ${conversation.title || convId.slice(0, 8)}`;
  const title = clip(baseTitle, ROUTINE_LIMITS.titleMax);

  const member = firstNonEmpty(
    conversation.directMemberId,
    conversation.memberIds?.[0],
    "assistant"
  );

  const instructionSections = [
    `## 会话核心目标\n${primaryGoal || "(未捕获具体目标，请在此补全)"}`,
  ];

  if (allCheckpoints.length > 0) {
    instructionSections.push("## 历经研究与执行检查点");
    allCheckpoints.forEach((cp, idx) => {
      instructionSections.push(`${idx + 1}. [${cp.phase}] ${cp.phaseLabel || cp.label || cp.phase}: ${cp.description || cp.summary || ""}`);
    });
  } else if (validRuns.length > 0) {
    instructionSections.push("## 执行步骤序列");
    validRuns.forEach((r, idx) => {
      const g = extractRunGoal(r);
      instructionSections.push(`${idx + 1}. 执行任务: ${clip(g || r.id, 100)}`);
    });
  }

  const instructions = clip(instructionSections.join("\n\n"), ROUTINE_LIMITS.instructionsMax);
  const expectedOutput = deliverable?.summary
    ? clip(deliverable.summary, ROUTINE_LIMITS.expectedOutputMax)
    : "完成全会话工作流程定义的所有任务";

  const id = `routine-distilled-conv-${convId.slice(0, 16)}`;

  return {
    schema: ROUTINE_SCHEMA,
    id,
    owningMemberId: member,
    title,
    skillRef: null,
    instructions,
    schedule: null,
    inputSource: { kind: "conversation", conversationId: convId },
    expectedOutput,
    approvalBoundary: "全流程自动化执行涉及写操作需确认审批",
    noDataPolicy: NO_DATA_POLICIES[0],
    enabled: false,
    notes: `由会话 ${convId} (含 ${validRuns.length} 个任务) 自动提炼生成于 ${new Date().toISOString()}`,
    distilledFrom: {
      type: "conversation",
      conversationId: convId,
      runCount: validRuns.length,
      checkpointCount: allCheckpoints.length,
      hasDeliverable: Boolean(deliverable),
    },
  };
}
