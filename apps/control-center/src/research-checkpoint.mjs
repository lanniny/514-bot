import { createHash } from "node:crypto";
import { scrub } from "./redaction.mjs";

export const RESEARCH_CHECKPOINT_SCHEMA = "514cc.research-checkpoint/v1";

export const STANDARD_RESEARCH_PHASES = Object.freeze([
  Object.freeze({ id: "plan", label: "规划大纲", index: 0, defaultProgress: 15 }),
  Object.freeze({ id: "search", label: "检索收集", index: 1, defaultProgress: 35 }),
  Object.freeze({ id: "analyze", label: "分析定位", index: 2, defaultProgress: 55 }),
  Object.freeze({ id: "execute", label: "方案执行", index: 3, defaultProgress: 75 }),
  Object.freeze({ id: "verify", label: "验证测试", index: 4, defaultProgress: 90 }),
  Object.freeze({ id: "deliver", label: "成果交付", index: 5, defaultProgress: 100 }),
]);

export const CHECKPOINT_STATUSES = Object.freeze([
  "pending",
  "in_progress",
  "completed",
  "interrupted",
  "failed",
]);

function asText(value, limit = 240, fallback = "") {
  const clean = scrub(String(value ?? ""))
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!clean) return fallback;
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function clampProgress(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function normalizeIsoTimestamp(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function computeCheckpointId(runId, phase, timestamp) {
  return `chk-${createHash("sha256")
    .update(`${runId || "direct"}\0${phase}\0${timestamp}`, "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}

export function sanitizeFinding(finding, index = 0) {
  if (!finding || typeof finding !== "object") {
    return {
      id: `finding-${index + 1}`,
      text: asText(finding, 300, "未说明事实"),
      category: "fact",
      source: null,
      confidence: 1.0,
    };
  }
  const text = asText(finding.text || finding.content || finding.title, 500, "未说明事实");
  const category = ["fact", "decision", "risk", "hypothesis"].includes(finding.category)
    ? finding.category
    : "fact";
  const confidence = Number.isFinite(Number(finding.confidence))
    ? Math.max(0, Math.min(1.0, Number(finding.confidence)))
    : 1.0;
  const source = finding.source ? asText(finding.source, 200) : null;
  const id = finding.id ? asText(finding.id, 64) : `finding-${createHash("sha256").update(`${text}\0${category}`, "utf8").digest("hex").slice(0, 10)}`;

  return {
    id,
    text,
    category,
    source,
    confidence,
  };
}

export function normalizeBudgetUsage(budget = {}) {
  const turnsUsed = Math.max(0, parseInt(budget?.turnsUsed, 10) || 0);
  const turnsLimit = budget?.turnsLimit != null && Number.isFinite(Number(budget.turnsLimit))
    ? Math.max(0, parseInt(budget.turnsLimit, 10))
    : null;

  const tokensUsed = Math.max(0, parseInt(budget?.tokensUsed, 10) || 0);
  const tokensLimit = budget?.tokensLimit != null && Number.isFinite(Number(budget.tokensLimit))
    ? Math.max(0, parseInt(budget.tokensLimit, 10))
    : null;

  const costUsd = Math.max(0, Number(budget?.costUsd) || 0);
  const costLimitUsd = budget?.costLimitUsd != null && Number.isFinite(Number(budget.costLimitUsd))
    ? Math.max(0, Number(budget.costLimitUsd))
    : null;

  const elapsedMs = Math.max(0, parseInt(budget?.elapsedMs, 10) || 0);

  const budgetExhausted = Boolean(
    budget?.budgetExhausted
    || (turnsLimit !== null && turnsUsed >= turnsLimit)
    || (tokensLimit !== null && tokensUsed >= tokensLimit)
    || (costLimitUsd !== null && costUsd >= costLimitUsd)
  );

  return {
    turnsUsed,
    turnsLimit,
    tokensUsed,
    tokensLimit,
    costUsd: Number(costUsd.toFixed(4)),
    costLimitUsd: costLimitUsd !== null ? Number(costLimitUsd.toFixed(4)) : null,
    elapsedMs,
    budgetExhausted,
  };
}

export function checkBudgetLimits(budget, limits = {}) {
  const current = normalizeBudgetUsage(budget);
  const turnsLimit = limits?.turnsLimit != null ? Number(limits.turnsLimit) : current.turnsLimit;
  const tokensLimit = limits?.tokensLimit != null ? Number(limits.tokensLimit) : current.tokensLimit;
  const costLimitUsd = limits?.costLimitUsd != null ? Number(limits.costLimitUsd) : current.costLimitUsd;

  const exhaustedLimits = [];
  const warningLimits = [];

  if (turnsLimit != null && turnsLimit > 0) {
    if (current.turnsUsed >= turnsLimit) exhaustedLimits.push(`轮次用尽 (${current.turnsUsed}/${turnsLimit})`);
    else if (current.turnsUsed >= turnsLimit * 0.8) warningLimits.push(`轮次接近上限 (${current.turnsUsed}/${turnsLimit})`);
  }

  if (tokensLimit != null && tokensLimit > 0) {
    if (current.tokensUsed >= tokensLimit) exhaustedLimits.push(`Token 用尽 (${current.tokensUsed}/${tokensLimit})`);
    else if (current.tokensUsed >= tokensLimit * 0.8) warningLimits.push(`Token 接近上限 (${current.tokensUsed}/${tokensLimit})`);
  }

  if (costLimitUsd != null && costLimitUsd > 0) {
    if (current.costUsd >= costLimitUsd) exhaustedLimits.push(`费用超限 ($${current.costUsd.toFixed(2)}/$${costLimitUsd.toFixed(2)})`);
    else if (current.costUsd >= costLimitUsd * 0.8) warningLimits.push(`费用接近上限 ($${current.costUsd.toFixed(2)}/$${costLimitUsd.toFixed(2)})`);
  }

  if (exhaustedLimits.length > 0) {
    return {
      ok: false,
      status: "exhausted",
      reason: exhaustedLimits.join("; "),
      exhaustedLimits,
      warningLimits,
    };
  }

  if (warningLimits.length > 0) {
    return {
      ok: true,
      status: "warning",
      reason: warningLimits.join("; "),
      exhaustedLimits: [],
      warningLimits,
    };
  }

  return {
    ok: true,
    status: "normal",
    reason: null,
    exhaustedLimits: [],
    warningLimits,
  };
}

export function createResearchCheckpoint(input = {}) {
  const runId = input.runId ? asText(input.runId, 80) : null;
  const conversationId = input.conversationId ? asText(input.conversationId, 80) : null;
  const phase = asText(input.phase, 40, "analyze").toLowerCase();
  const matchedPhase = STANDARD_RESEARCH_PHASES.find((p) => p.id === phase);
  const phaseLabel = asText(input.phaseLabel || input.label, 60, matchedPhase ? matchedPhase.label : phase);
  const createdAt = normalizeIsoTimestamp(input.createdAt);
  const updatedAt = normalizeIsoTimestamp(input.updatedAt || createdAt);
  const id = input.id ? asText(input.id, 64) : computeCheckpointId(runId || conversationId, phase, createdAt);
  const progress = clampProgress(input.progress ?? matchedPhase?.defaultProgress ?? 50);
  const status = CHECKPOINT_STATUSES.includes(input.status) ? input.status : "in_progress";
  const summary = asText(input.summary, 500, "");

  const findings = Array.isArray(input.findings)
    ? input.findings.map(sanitizeFinding)
    : [];

  const evidenceRefs = Array.isArray(input.evidenceRefs)
    ? [...new Set(input.evidenceRefs.map((r) => asText(r, 80)).filter(Boolean))]
    : [];

  const budget = normalizeBudgetUsage(input.budget);

  return {
    schema: RESEARCH_CHECKPOINT_SCHEMA,
    id,
    runId,
    conversationId,
    phase,
    phaseLabel,
    progress,
    status,
    findings,
    budget,
    evidenceRefs,
    summary,
    createdAt,
    updatedAt,
  };
}

export function updateResearchCheckpoint(checkpoint, updates = {}) {
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new Error("checkpoint 必须是有效对象");
  }

  const updatedPhase = updates.phase ? asText(updates.phase, 40).toLowerCase() : checkpoint.phase;
  const matchedPhase = STANDARD_RESEARCH_PHASES.find((p) => p.id === updatedPhase);
  const phaseLabel = updates.phaseLabel
    ? asText(updates.phaseLabel, 60)
    : (updates.phase && matchedPhase ? matchedPhase.label : checkpoint.phaseLabel);

  const progress = updates.progress != null
    ? clampProgress(updates.progress)
    : checkpoint.progress;

  const status = CHECKPOINT_STATUSES.includes(updates.status)
    ? updates.status
    : checkpoint.status;

  const summary = updates.summary != null
    ? asText(updates.summary, 500)
    : checkpoint.summary;

  let findings = checkpoint.findings;
  if (Array.isArray(updates.findings)) {
    findings = updates.findings.map(sanitizeFinding);
  }

  let evidenceRefs = checkpoint.evidenceRefs;
  if (Array.isArray(updates.evidenceRefs)) {
    evidenceRefs = [...new Set([...evidenceRefs, ...updates.evidenceRefs.map((r) => asText(r, 80)).filter(Boolean)])];
  }

  const budget = normalizeBudgetUsage({
    ...checkpoint.budget,
    ...(updates.budget || {}),
  });

  return {
    ...checkpoint,
    phase: updatedPhase,
    phaseLabel,
    progress,
    status,
    findings,
    budget,
    evidenceRefs,
    summary,
    updatedAt: new Date().toISOString(),
  };
}

export function appendFindingToCheckpoint(checkpoint, newFinding) {
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new Error("checkpoint 必须是有效对象");
  }
  const finding = sanitizeFinding(newFinding, checkpoint.findings?.length || 0);
  const existing = Array.isArray(checkpoint.findings) ? checkpoint.findings : [];
  
  // 防止重复文本
  const isDuplicate = existing.some((f) => f.id === finding.id || f.text === finding.text);
  if (isDuplicate) {
    return checkpoint;
  }

  return {
    ...checkpoint,
    findings: [...existing, finding],
    updatedAt: new Date().toISOString(),
  };
}

export function calculateOverallProgress(checkpoints = []) {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return { overallProgress: 0, latestPhase: null, status: "pending", completedPhasesCount: 0 };
  }

  const valid = checkpoints.filter((c) => c && typeof c === "object");
  if (!valid.length) {
    return { overallProgress: 0, latestPhase: null, status: "pending", completedPhasesCount: 0 };
  }

  const latest = valid[valid.length - 1];
  const completedPhasesCount = valid.filter((c) => c.status === "completed").length;

  return {
    overallProgress: latest.progress,
    latestPhase: latest.phase,
    latestPhaseLabel: latest.phaseLabel,
    status: latest.status,
    completedPhasesCount,
    totalCheckpoints: valid.length,
  };
}

export function validateResearchCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return { ok: false, reason: "检查点数据必须是对象" };
  }
  if (checkpoint.schema !== RESEARCH_CHECKPOINT_SCHEMA) {
    return { ok: false, reason: "检查点 schema 不匹配" };
  }
  if (!checkpoint.id || typeof checkpoint.id !== "string") {
    return { ok: false, reason: "缺少有效的检查点 id" };
  }
  if (!checkpoint.phase || typeof checkpoint.phase !== "string") {
    return { ok: false, reason: "缺少检查点 phase" };
  }
  if (typeof checkpoint.progress !== "number" || checkpoint.progress < 0 || checkpoint.progress > 100) {
    return { ok: false, reason: "检查点 progress 必须在 0-100 之间" };
  }
  if (!CHECKPOINT_STATUSES.includes(checkpoint.status)) {
    return { ok: false, reason: `检查点 status 非法: ${checkpoint.status}` };
  }
  if (!Array.isArray(checkpoint.findings)) {
    return { ok: false, reason: "检查点 findings 必须是数组" };
  }
  return { ok: true, data: checkpoint };
}
