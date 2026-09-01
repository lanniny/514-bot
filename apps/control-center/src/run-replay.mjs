import { createHash } from "node:crypto";
import { scrub } from "./redaction.mjs";

export const RUN_REPLAY_SCHEMA = "514cc.run-replay/v1";
export const RUN_REPLAY_LIMITS = Object.freeze({
  events: 400,
  busMessages: 128,
  attempts: 96,
  approvals: 32,
});

const AUTO_REPLAY_BLOCKED = new Set(["submitting", "submitted", "ambiguous"]);

function shortText(value, limit = 160, fallback = "") {
  const clean = scrub(String(value ?? ""))
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!clean) return fallback;
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function timestamp(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function eventId(kind, runId, parts) {
  return `replay-${createHash("sha256")
    .update(["514cc.run-replay/v1", kind, runId, ...parts.map((part) => String(part ?? ""))].join("\0"), "utf8")
    .digest("hex")
    .slice(0, 20)}`;
}

function statusOf(run) {
  return shortText(run?.status, 32, "unknown").toLowerCase();
}

function nativeIdentity(label, value) {
  const clean = shortText(value, 160);
  return clean ? `${label}:${clean}` : null;
}

export function replayActionability(run = {}) {
  const status = statusOf(run);
  const turnState = shortText(run?.resumeClaim?.state || run?.activeTurn?.state, 32).toLowerCase();
  const blockedState = AUTO_REPLAY_BLOCKED.has(status) || AUTO_REPLAY_BLOCKED.has(turnState);
  const recoveryRequired = status === "recovery_required" || run?.recoveryRequired === true;
  return {
    replayable: false,
    canContinue: recoveryRequired && !blockedState,
    canAbandon: recoveryRequired || blockedState || ["failed", "blocked"].includes(status),
    continueVia: recoveryRequired ? "PATCH /api/runs/:id/controls acknowledgeRecovery" : null,
    abandonVia: "existing orchestrator controls",
    reason: blockedState
      ? `${status || turnState} 默认不可自动 replay，避免重复调用 provider`
      : recoveryRequired
        ? "继续/放弃只走现有 Orchestrator 准入，不从文本重建 DAG"
        : "回放是只读时间线，不会新建 provider 请求",
  };
}

function projectEvent(runId, item, index) {
  const type = shortText(item?.type, 80, "unknown");
  const ts = timestamp(item?.timestamp || item?.ts);
  const identity = nativeIdentity("eventId", item?.eventId)
    || (Number.isSafeInteger(item?.sequence) ? `sequence:${item.sequence}` : null);
  return {
    id: eventId("event", runId, identity ? [identity] : [type, ts, index]),
    source: "event-store",
    type,
    timestamp: ts,
    agentId: shortText(item?.agentId, 64) || null,
    sequence: Number.isSafeInteger(item?.sequence) ? item.sequence : null,
  };
}

function projectBus(runId, item, index) {
  const kind = shortText(item?.kind, 24, "say");
  const ts = timestamp(item?.ts);
  const identity = nativeIdentity("messageId", item?.id);
  return {
    id: eventId("bus", runId, identity ? [identity] : [kind, ts, index]),
    source: "bus",
    type: `bus.${kind}`,
    timestamp: ts,
    agentId: shortText(item?.from, 64) || null,
    messageId: shortText(item?.id, 160) || null,
  };
}

function projectAttempt(runId, item, index) {
  const phase = shortText(item?.phase || item?.state, 32, "unknown");
  const ts = timestamp(item?.updatedAt || item?.createdAt);
  const identity = nativeIdentity("attemptId", item?.attemptId || item?.id);
  return {
    id: eventId("attempt", runId, identity ? [identity] : [item?.agentId, phase, ts, index]),
    source: "attempt",
    type: `attempt.${phase}`,
    timestamp: ts,
    agentId: shortText(item?.agentId, 64) || null,
    attemptId: shortText(item?.attemptId || item?.id, 80) || null,
  };
}

function projectApproval(runId, item, index) {
  const status = shortText(item?.status, 24, "unknown");
  const ts = timestamp(item?.createdAt);
  const identity = nativeIdentity("approvalId", item?.id);
  return {
    id: eventId("approval", runId, identity ? [identity] : [item?.method, status, ts, index]),
    source: "approval",
    type: `approval.${status}`,
    timestamp: ts,
    agentId: null,
    approvalId: shortText(item?.id, 80) || null,
  };
}

function projectNote(runId, type, value, extra = {}) {
  const ts = timestamp(extra.timestamp || extra.ts);
  if (!value && !ts) return null;
  return {
    id: eventId(type, runId, [value, ts]),
    source: type,
    type,
    timestamp: ts,
    agentId: extra.agentId || null,
    text: shortText(value, 240) || null,
  };
}

export function projectRunReplay({
  run,
  events = [],
  busMessages = [],
  approvals = [],
  eventsMayBeTruncated = false,
  busTruncated = false,
  asOfSequence = null,
} = {}) {
  const runId = shortText(run?.id, 80);
  if (!runId) {
    throw Object.assign(new Error("run is required for replay projection"), { code: "VALIDATION_FAILED" });
  }
  const attempts = Array.isArray(run?.turnAttempts) ? run.turnAttempts : [];
  const items = [
    ...events.slice(-RUN_REPLAY_LIMITS.events).map((item, index) => projectEvent(runId, item, index)),
    ...busMessages.slice(-RUN_REPLAY_LIMITS.busMessages).map((item, index) => projectBus(runId, item, index)),
    ...attempts.slice(-RUN_REPLAY_LIMITS.attempts).map((item, index) => projectAttempt(runId, item, index)),
    ...approvals.slice(-RUN_REPLAY_LIMITS.approvals).map((item, index) => projectApproval(runId, item, index)),
    projectNote(runId, "interrupt", run?.interruptReason || run?.interruptedBy, { timestamp: run?.interruptedAt }),
    projectNote(runId, "resume-claim", run?.resumeClaim?.itemId, {
      timestamp: run?.resumeClaim?.claimedAt || run?.resumeClaim?.updatedAt,
      agentId: run?.resumeClaim?.agentId,
    }),
    projectNote(runId, "recovery-note", run?.recoveryNote, { timestamp: run?.updatedAt }),
  ].filter(Boolean);
  items.sort((left, right) => (Date.parse(left.timestamp || 0) - Date.parse(right.timestamp || 0)) || left.id.localeCompare(right.id));
  return {
    schema: RUN_REPLAY_SCHEMA,
    runId,
    status: statusOf(run),
    generatedAt: new Date().toISOString(),
    asOfSequence,
    actionability: replayActionability(run),
    taskGraph: run?.taskGraph
      ? {
          taskCount: Array.isArray(run.taskGraph.tasks) ? run.taskGraph.tasks.length : 0,
          edgeCount: Array.isArray(run.taskGraph.delegations) ? run.taskGraph.delegations.length : 0,
          source: "persisted",
        }
      : null,
    timeline: items,
    truncated: {
      events: eventsMayBeTruncated || events.length > RUN_REPLAY_LIMITS.events,
      bus: busTruncated === true || busMessages.length > RUN_REPLAY_LIMITS.busMessages,
      attempts: attempts.length > RUN_REPLAY_LIMITS.attempts,
      approvals: approvals.length > RUN_REPLAY_LIMITS.approvals,
    },
    filters: {
      sources: [...new Set(items.map((item) => item.source))],
      types: [...new Set(items.map((item) => item.type))],
    },
  };
}
