import { scrub } from "./redaction.mjs";
import { formatEvidenceMatrixMarkdown } from "./evidence-matrix.mjs";

export const UNIFIED_DELIVERABLE_SCHEMA = "514cc.unified-deliverable/v1";

function asText(value, limit = 300, fallback = "") {
  const clean = scrub(String(value ?? ""))
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!clean) return fallback;
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function normalizeIsoTimestamp(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

export function createUnifiedDeliverable({
  run = null,
  checkpoints = [],
  evidenceMatrix = null,
  settlement = null,
  valueProof = null,
  title = null,
  summary = null,
  now = () => new Date().toISOString(),
} = {}) {
  const runId = asText(run?.id || settlement?.runId, 80) || "direct-task";
  const runStatus = asText(run?.status || settlement?.status, 40, "completed").toLowerCase();
  const deliverableTitle = asText(title || run?.title, 160, `交付成果: ${runId}`);
  const timestamp = typeof now === "function" ? now() : normalizeIsoTimestamp(now);

  // 1. 检查点概要提取
  const validCheckpoints = Array.isArray(checkpoints) ? checkpoints.filter(Boolean) : [];
  const latestCheckpoint = validCheckpoints.length > 0 ? validCheckpoints[validCheckpoints.length - 1] : null;
  const completedPhasesCount = validCheckpoints.filter((c) => c.status === "completed").length;
  const overallProgress = latestCheckpoint ? latestCheckpoint.progress : 100;
  
  const allFindings = [];
  for (const cp of validCheckpoints) {
    if (Array.isArray(cp.findings)) {
      for (const f of cp.findings) {
        if (!allFindings.some((existing) => existing.text === f.text)) {
          allFindings.push(f);
        }
      }
    }
  }

  const checkpointsSummary = {
    total: validCheckpoints.length,
    completedPhasesCount,
    latestPhase: latestCheckpoint?.phase || null,
    latestPhaseLabel: latestCheckpoint?.phaseLabel || null,
    overallProgress,
    findingsCount: allFindings.length,
    keyFindings: allFindings.slice(0, 10),
  };

  // 2. 证据表概要提取
  const matrix = evidenceMatrix && typeof evidenceMatrix === "object" ? evidenceMatrix : { metrics: { totalCount: 0, verifiedCount: 0, byType: {} }, items: [] };
  const evidenceSummary = {
    totalCount: matrix.metrics?.totalCount || 0,
    verifiedCount: matrix.metrics?.verifiedCount || 0,
    byType: matrix.metrics?.byType || {},
    keyItems: (matrix.items || []).slice(0, 12),
  };

  // 3. 预算与价值证明提取
  const budgetSummary = {
    turnsUsed: run?.turnCount || latestCheckpoint?.budget?.turnsUsed || 0,
    tokensUsed: run?.tokenUsageTotal || latestCheckpoint?.budget?.tokensUsed || 0,
    costUsd: Number((run?.costUsdTotal ?? latestCheckpoint?.budget?.costUsd ?? 0).toFixed(4)),
    durationMs: valueProof?.signals?.find((s) => s.id === "duration")?.ms || null,
    budgetExhausted: Boolean(latestCheckpoint?.budget?.budgetExhausted || run?.failureKind === "budget_exhausted"),
  };

  // 4. DELTA 净增量提取
  const deltaItem = (matrix.items || []).find((i) => i.type === "delta");
  const deltaSummary = deltaItem ? {
    agent: deltaItem.metadata?.agent || null,
    score: deltaItem.metadata?.score ?? null,
    evidence: deltaItem.snippet || null,
    topic: deltaItem.metadata?.topic || null,
  } : null;

  // 5. 整体状态判定
  let status = "completed";
  if (runStatus === "failed" || settlement?.verdict === "blocked") status = "blocked";
  else if (settlement?.verdict === "partial" || overallProgress < 100) status = "partial";

  const deliverableSummary = asText(
    summary,
    800,
    status === "completed"
      ? `任务已顺利执行完成。涵盖 ${checkpointsSummary.total} 个阶段检查点，核验 ${evidenceSummary.totalCount} 项多源证据。`
      : `任务已部分交付（状态: ${status}）。已确认 ${checkpointsSummary.completedPhasesCount} 个阶段，核验 ${evidenceSummary.verifiedCount} 项有效证据。`
  );

  // 6. 下一步动作规划
  const nextActions = [];
  if (settlement?.nextAction?.reason) {
    nextActions.push({
      id: settlement.nextAction.id || "settlement",
      label: "结算后续",
      reason: settlement.nextAction.reason,
    });
  }
  if (allFindings.some((f) => f.category === "risk")) {
    nextActions.push({
      id: "review-risks",
      label: "审查风险项",
      reason: "本次研究中标记了潜在风险，建议在合入或上线前复核。",
    });
  }
  if (!nextActions.length) {
    nextActions.push({
      id: "done",
      label: "交付闭环",
      reason: "所有预定成果已落实并核对，可供审阅或分发。",
    });
  }

  return {
    schema: UNIFIED_DELIVERABLE_SCHEMA,
    runId,
    title: deliverableTitle,
    status,
    summary: deliverableSummary,
    timestamp,
    checkpoints: checkpointsSummary,
    evidenceMatrix: evidenceSummary,
    budget: budgetSummary,
    delta: deltaSummary,
    nextActions,
  };
}

export function formatUnifiedDeliverableMarkdown(deliverable) {
  if (!deliverable || typeof deliverable !== "object") {
    return "*(交付成果不可用)*";
  }

  const sections = [];

  // Header
  sections.push(`# ${deliverable.title || "任务交付成果"}\n`);
  sections.push(`> 状态：**${deliverable.status?.toUpperCase()}** ｜ 交付时间：${deliverable.timestamp} ｜ 运行 ID：\`${deliverable.runId}\`\n`);
  sections.push(`## 核心成果摘要\n\n${deliverable.summary}\n`);

  // Key findings
  if (deliverable.checkpoints?.keyFindings?.length) {
    sections.push(`## 关键事实与发现\n`);
    for (const finding of deliverable.checkpoints.keyFindings) {
      const cat = finding.category ? `[${finding.category.toUpperCase()}] ` : "";
      const src = finding.source ? ` *(来源: ${finding.source})*` : "";
      sections.push(`- ${cat}${finding.text}${src}`);
    }
    sections.push("");
  }

  // Evidence matrix
  if (deliverable.evidenceMatrix?.keyItems?.length) {
    sections.push(`## 结构化证据汇总表\n`);
    sections.push(formatEvidenceMatrixMarkdown({ items: deliverable.evidenceMatrix.keyItems }));
    sections.push("");
  }

  // DELTA
  if (deliverable.delta) {
    sections.push(`## 治理核验 (DELTA)\n`);
    sections.push(`\`__DELTA__: ${deliverable.delta.agent || "未知"} | ${deliverable.delta.score ?? 0} | 证据：${deliverable.delta.evidence || "无"}\`\n`);
  }

  // Next steps
  if (deliverable.nextActions?.length) {
    sections.push(`## 后续行动建议\n`);
    for (const act of deliverable.nextActions) {
      sections.push(`- **${act.label}**: ${act.reason}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

export function validateUnifiedDeliverable(deliverable) {
  if (!deliverable || typeof deliverable !== "object" || Array.isArray(deliverable)) {
    return { ok: false, reason: "交付物必须是有效对象" };
  }
  if (deliverable.schema !== UNIFIED_DELIVERABLE_SCHEMA) {
    return { ok: false, reason: "交付物 schema 不匹配" };
  }
  if (!deliverable.runId || typeof deliverable.runId !== "string") {
    return { ok: false, reason: "缺少 runId" };
  }
  if (!deliverable.status || typeof deliverable.status !== "string") {
    return { ok: false, reason: "缺少 status" };
  }
  return { ok: true, data: deliverable };
}
