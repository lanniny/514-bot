import { basename } from "node:path";
import { collectRunEvidenceArtifacts } from "./run-artifacts.mjs";
import { summarizeRunDiff } from "./run-diff.mjs";
import { replayActionability } from "./run-replay.mjs";

export const RUN_SETTLEMENT_SCHEMA = "514cc.run-settlement/v1";
export const AUTO_LANDING_ACTIONS = Object.freeze({
  merge: false,
  rebase: false,
  commit: false,
  push: false,
  gitAdd: false,
});
export const SETTLEMENT_VERDICTS = Object.freeze([
  "unknown",
  "remote-unsupported",
  "blocked",
  "partial",
  "reviewable",
]);

const TERMINAL = new Set([
  "complete", "completed", "succeeded", "failed", "blocked", "cancelled", "canceled",
]);

function asText(value, fallback = "") {
  const clean = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  return clean || fallback;
}

function statusOf(run) {
  return asText(run?.status, "unknown").toLowerCase();
}

function evidenceReadRisk(evidenceSource) {
  if (!evidenceSource || typeof evidenceSource !== "object") return null;
  const issues = Array.isArray(evidenceSource.issues) ? evidenceSource.issues : [];
  const failed = issues
    .filter((item) => item && typeof item === "object" && item.ok === false)
    .map((item) => ({
      id: asText(item.id, "evidence-source-unavailable").slice(0, 80),
      status: "blocked",
      reason: asText(item.reason || item.error || "治理证据源读取失败", "治理证据源读取失败").slice(0, 180),
    }));
  if (failed.length) return failed;
  if (evidenceSource.status === "unavailable" || evidenceSource.available === false) {
    return [{ id: "evidence-source-unavailable", status: "blocked", reason: "治理证据源不可用，不能确认交付记录完整性" }];
  }
  return null;
}

function nextActionFor(verdict, risks, { dirty = false } = {}) {
  const first = risks[0];
  if (verdict === "remote-unsupported") {
    return { id: "remote-unsupported", reason: first?.reason || "远程 run 不支持本机 worktree 结算" };
  }
  if (verdict === "blocked" && first) return { id: first.id, reason: first.reason };
  if (dirty) return { id: "review-diff", reason: "先核对产物 diff 与风险，再决定是否在新工作树继续——不会自动 merge" };
  if (verdict === "reviewable") {
    return { id: "reviewable", reason: "工作树可核对。系统只生成 plan、差异和风险，不自动 merge" };
  }
  return { id: first?.id || verdict, reason: first?.reason || "准备交付记录不完整" };
}

export function synthesizeRunSettlement({
  run = null,
  artifacts = [],
  diffSummary = null,
  evidenceSource = null,
  now = () => new Date().toISOString(),
} = {}) {
  const runId = asText(run?.id, "") || null;
  const status = statusOf(run);
  const recovery = replayActionability(run);
  const remote = Boolean(run?.remote);
  const worktreePath = asText(run?.worktreePath) || null;
  const worktreeBase = asText(run?.worktreeBase) || null;
  const isolation = remote
    ? "remote-unsupported"
    : worktreePath
      ? "git-worktree"
      : run?.cwd
        ? "none"
        : "none";
  const risks = [];
  const evidenceRisks = evidenceReadRisk(evidenceSource);
  if (evidenceRisks) risks.push(...evidenceRisks);

  if (!runId) {
    return {
      schema: RUN_SETTLEMENT_SCHEMA,
      capturedAt: typeof now === "function" ? now() : now,
      runId: null,
      status,
      verdict: "unknown",
      isolation,
      autoLanding: { ...AUTO_LANDING_ACTIONS },
      workspace: { kind: "unknown", path: null, base: null },
      diff: { available: false, endpoint: null, dirty: false },
      artifacts: [],
      recovery,
      risks: [{ id: "missing-run", status: "blocked", reason: "没有任务，不能结算" }],
      nextAction: { id: "missing-run", reason: "没有任务，不能结算" },
    };
  }

  if (remote) {
    risks.push({
      id: "remote-unsupported",
      status: "blocked",
      reason: "远程 run 的隔离是 remote-unsupported：本机不建 worktree，也不在远端自动 merge",
    });
  } else if (!worktreePath || !worktreeBase) {
    risks.push({
      id: "no-worktree",
      status: TERMINAL.has(status) ? "partial" : "blocked",
      reason: "没有隔离工作树（plan 模式或未提供项目地址），不能按产物结算",
    });
  }

  if (recovery.canContinue || status === "recovery_required" || run?.recoveryRequired === true) {
    risks.push({
      id: "recovery",
      status: "blocked",
      reason: recovery.reason || "需要先走恢复/放弃，不能从终态文本反推合并",
    });
  }

  if (diffSummary?.available === false && diffSummary?.error) {
    risks.push({
      id: "diff-unavailable",
      status: "partial",
      reason: asText(diffSummary.error, "差异探测失败").slice(0, 180),
    });
  }

  const dirty = diffSummary?.dirty === true;
  if (worktreePath && !remote && diffSummary?.available === true && dirty !== true && TERMINAL.has(status)) {
    risks.push({
      id: "clean-worktree",
      status: "partial",
      reason: "工作树相对 HEAD 无未提交改动——agent 未落盘或改动已在别处",
    });
  }
  if (worktreePath && !remote && !diffSummary) {
    risks.push({
      id: "diff-unprobed",
      status: "partial",
      reason: "尚未探测工作树差异；打开结算或产物 diff 才会生成摘要",
    });
  }

  let verdict = "partial";
  if (!runId) verdict = "unknown";
  else if (remote) verdict = "remote-unsupported";
  else if (risks.some((item) => item.status === "blocked")) verdict = "blocked";
  else if (worktreePath && TERMINAL.has(status) && dirty) verdict = "reviewable";

  const artifactCards = (Array.isArray(artifacts) ? artifacts : []).slice(0, 16).map((item) => ({
    id: asText(item?.id, "") || null,
    kind: asText(item?.kind, "artifact"),
    availability: asText(item?.availability, "unavailable"),
    endpoint: item?.endpoint || null,
    published: false,
  }));

  return {
    schema: RUN_SETTLEMENT_SCHEMA,
    capturedAt: typeof now === "function" ? now() : now,
    runId,
    status,
    verdict,
    isolation,
    autoLanding: { ...AUTO_LANDING_ACTIONS },
    workspace: {
      kind: remote ? "remote" : worktreePath ? "worktree" : run?.cwd ? "workspace" : "unknown",
      path: remote ? null : (worktreePath ? basename(worktreePath.replace(/[\\/]+$/, "")) : null),
      base: remote ? null : (worktreeBase ? basename(worktreeBase.replace(/[\\/]+$/, "")) : null),
    },
    diff: {
      available: diffSummary?.available === true,
      endpoint: worktreePath && !remote ? `/api/runs/${encodeURIComponent(runId)}/diff` : null,
      dirty,
      truncated: diffSummary?.truncated === true,
      filesChanged: Number.isFinite(Number(diffSummary?.filesChanged)) ? Number(diffSummary.filesChanged) : null,
      additions: Number.isFinite(Number(diffSummary?.additions)) ? Number(diffSummary.additions) : null,
      deletions: Number.isFinite(Number(diffSummary?.deletions)) ? Number(diffSummary.deletions) : null,
      stat: asText(diffSummary?.stat) || null,
    },
    gitPlan: {
      endpoint: "/api/workbench/git/plan",
      allowedActions: ["commit", "push"],
      forbiddenActions: ["merge", "rebase", "reset", "checkout"],
      worktreeCommit: "blocked-detached",
    },
    artifacts: artifactCards,
    recovery,
    risks,
    nextAction: nextActionFor(verdict, risks, { dirty }),
  };
}

export async function collectRunSettlement({
  run,
  artifacts = null,
  includeDiff = false,
  handoffs = [],
  deltas = [],
  evidenceSource = null,
  summarizeDiff = summarizeRunDiff,
  now = () => new Date().toISOString(),
} = {}) {
  const cards = artifacts || collectRunEvidenceArtifacts({ run, handoffs, deltas });
  let diffSummary = null;
  if (includeDiff === true && run?.worktreePath && !run?.remote) {
    try {
      diffSummary = await summarizeDiff(run);
    } catch (error) {
      diffSummary = {
        available: false,
        error: error?.message || String(error),
        code: error?.code || "DIFF_UNAVAILABLE",
      };
    }
  }
  return synthesizeRunSettlement({
    run,
    artifacts: cards,
    diffSummary,
    evidenceSource,
    now,
  });
}
