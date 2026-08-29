import { createHash } from "node:crypto";
import { BUS_TAIL_LIMITS } from "./bus.mjs";
import { scrub } from "./redaction.mjs";
import { synthesizeRunSettlement } from "./run-settlement.mjs";

export const MISSION_CONTROL_SCHEMA = "514cc.mission-control.snapshot/v3";

export const MISSION_CONTROL_LIMITS = Object.freeze({
  events: 200,
  attempts: 96,
  messageRoutes: 96,
  agents: 32,
  connections: 32,
  approvals: 32,
  evidenceTypes: 16,
  evidenceItems: 24,
  graphNodes: 112,
  graphEdges: 192,
  titleCharacters: 180,
  busBytes: BUS_TAIL_LIMITS.defaultMaxBytes,
  busMessages: BUS_TAIL_LIMITS.defaultMaxMessages,
});

const SPECIAL_PARTICIPANTS = new Set(["", "all", "lo", "memo", "system", "team"]);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function shortText(value, limit = 80, fallback = "") {
  const clean = scrub(String(value ?? ""))
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!clean) return fallback;
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function participant(value) {
  return shortText(value, 64).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
}

function runParticipantIds(run) {
  const team = new Set(list(run?.teamMembers)
    .map(participant)
    .filter((id) => id && !SPECIAL_PARTICIPANTS.has(id.toLowerCase())));
  if (team.size) return team;

  const fallback = new Set();
  for (const value of [run?.coordinatorId, run?.executionOwnerId, run?.startAgentId, run?.route?.selected?.id]) {
    const id = participant(value);
    if (id && !SPECIAL_PARTICIPANTS.has(id.toLowerCase())) fallback.add(id);
  }
  return fallback;
}

function claimsOnlyRunParticipants(item, participants) {
  const claimed = [item?.agentId, item?.from, item?.to]
    .map(participant)
    .filter((id) => id && !SPECIAL_PARTICIPANTS.has(id.toLowerCase()));
  return claimed.every((id) => participants.has(id));
}

function timestamp(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function positiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Math.floor(Number(value));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : 0;
}

function nullableInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (value == null) return null;
  const parsed = Math.floor(Number(value));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : null;
}

function diagnosticCode(value, fallback) {
  const clean = String(value ?? "").toUpperCase();
  return /^[A-Z0-9_]{1,64}$/.test(clean) ? clean : fallback;
}

function normalizeBusDiagnostics(value, messageCount) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rawStatus = String(source.status ?? "ok").toLowerCase();
  const status = ["degraded", "missing", "ok"].includes(rawStatus) ? rawStatus : "degraded";
  const issues = list(source.issues).slice(0, 16).map((item) => ({
    code: diagnosticCode(item?.code, "BUS_DIAGNOSTIC_INVALID"),
    message: shortText(item?.message, 160, "bus diagnostic unavailable"),
    systemCode: item?.systemCode == null ? null : diagnosticCode(item.systemCode, "UNKNOWN"),
    tailLine: nullableInteger(item?.tailLine, 1_000_000),
  }));
  if (status === "degraded" && issues.length === 0) {
    issues.push({
      code: "BUS_DIAGNOSTIC_DEGRADED",
      message: "bus integrity is degraded",
      systemCode: null,
      tailLine: null,
    });
  }
  if (status === "missing" && messageCount > 0) {
    issues.push({
      code: "BUS_DIAGNOSTIC_INCONSISTENT",
      message: "bus diagnostics report a missing file with visible messages",
      systemCode: null,
      tailLine: null,
    });
  }
  return {
    status: status === "missing" && messageCount > 0 ? "degraded" : status,
    issues,
    fileSizeBytes: nullableInteger(source.fileSizeBytes),
    bytesRead: positiveInteger(source.bytesRead),
    parsedMessages: Math.max(messageCount, positiveInteger(source.parsedMessages)),
    malformedLines: positiveInteger(source.malformedLines),
    truncated: {
      bytes: source.truncated?.bytes === true,
      messages: source.truncated?.messages === true,
    },
  };
}

function stableId(kind, ...parts) {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 20);
  return `mc-${kind}-${digest}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) output[key] = canonicalize(value[key]);
  }
  return output;
}

function projectionSnapshotId(projection) {
  const digest = createHash("sha256").update(JSON.stringify(canonicalize(projection))).digest("hex");
  return `mc-snapshot-${digest}`;
}

function orderedIdentity(explicit, kind, ...parts) {
  return `${String(explicit ?? "")}\u0000${stableId(kind, ...parts)}`;
}

function socialRunExpectsBus(run, rawAttempts) {
  if (shortText(run?.orchestrationMode, 24, "pipeline").toLowerCase() !== "social") return false;
  const turns = list(run?.turns);
  const sessions = run?.sessions && typeof run.sessions === "object" && !Array.isArray(run.sessions)
    ? Object.keys(run.sessions)
    : [];
  // Persisted immediately before the first append, busExpectedAt is the
  // write-ahead audit marker that closes the append -> run-save crash window.
  if (timestamp(run?.busExpectedAt) || timestamp(run?.busMaterializedAt)) return true;
  if (run?.execute === false) return false;
  if (positiveInteger(run?.round, 10_000) > 0 || rawAttempts.length || turns.length || sessions.length) return true;
  // Backward compatibility for completed social runs persisted before busMaterializedAt existed.
  return run?.result?.mode === "social" || typeof run?.result?.bus === "string";
}

function requireExpectedBusEvidence(run, rawAttempts, diagnostics) {
  if (!socialRunExpectsBus(run, rawAttempts)) return diagnostics;
  const missing = diagnostics.status === "missing";
  const emptyAfterMaterialization = diagnostics.status === "ok"
    && diagnostics.fileSizeBytes !== null
    && diagnostics.parsedMessages === 0;
  if (!missing && !emptyAfterMaterialization) return diagnostics;
  return {
    ...diagnostics,
    status: "degraded",
    issues: [
      ...diagnostics.issues,
      {
        code: missing ? "BUS_AUDIT_MISSING" : "BUS_AUDIT_EMPTY_AFTER_MATERIALIZATION",
        message: missing
          ? "executed social run is missing its bus audit file"
          : "materialized social run has an empty bus audit file",
        systemCode: null,
        tailLine: null,
      },
    ].slice(0, 16),
  };
}

export function auditBusDiagnostics(run, diagnostics, messageCount = 0) {
  return requireExpectedBusEvidence(
    run,
    list(run?.turnAttempts),
    normalizeBusDiagnostics(diagnostics, positiveInteger(messageCount, BUS_TAIL_LIMITS.maxMessages)),
  );
}

function orderedByTime(items, readTime, readIdentity) {
  return [...items].sort((left, right) => {
    const leftTime = timestamp(readTime(left)) ?? "";
    const rightTime = timestamp(readTime(right)) ?? "";
    return compareText(leftTime, rightTime) || compareText(readIdentity(left), readIdentity(right));
  });
}

function compareText(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a < b ? -1 : a > b ? 1 : 0;
}

function lastTimestamp(values) {
  return values
    .map(timestamp)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
}

function connectionStatus(item) {
  if (item?.available === true) return "online";
  const status = shortText(item?.status, 32, "unknown").toLowerCase();
  if (item?.available === false && status === "online") return "degraded";
  return ["degraded", "disabled", "external-unverified", "missing", "offline", "online", "unknown", "unconfigured"]
    .includes(status) ? status : "unknown";
}

const CONNECTION_RISK = Object.freeze({
  online: 0,
  disabled: 1,
  "external-unverified": 2,
  unknown: 3,
  unconfigured: 4,
  missing: 5,
  offline: 6,
  degraded: 7,
});

function compareConnectionRisk(left, right) {
  const risk = (CONNECTION_RISK[left.status] ?? 3) - (CONNECTION_RISK[right.status] ?? 3);
  if (risk) return risk;
  if (left.available !== right.available) return left.available ? -1 : 1;
  const leftLatency = left.latencyMs ?? -1;
  const rightLatency = right.latencyMs ?? -1;
  if (leftLatency !== rightLatency) return leftLatency - rightLatency;
  return compareText(JSON.stringify(canonicalize(left)), JSON.stringify(canonicalize(right)));
}

function attemptState(phase) {
  if (phase === "completed") return "completed";
  if (["failed", "ambiguous"].includes(phase)) return "attention";
  return "active";
}

function eventState(type) {
  if (/fail|error|denied|dropped|blocked|expired/i.test(type)) return "attention";
  if (/complete|succeed|approved|resolved/i.test(type)) return "completed";
  return "recorded";
}

function buildEvidenceGraph({ task, attempts, messageRoutes, agents, approvals, artifacts, evidenceItems }) {
  const nodes = [];
  const nodeIds = new Set();
  let nodesTruncated = false;
  const addNode = (item) => {
    if (!item?.id || nodeIds.has(item.id)) return item?.id ?? null;
    if (nodes.length >= MISSION_CONTROL_LIMITS.graphNodes) {
      nodesTruncated = true;
      return null;
    }
    nodeIds.add(item.id);
    nodes.push(item);
    return item.id;
  };

  const edgeCandidates = [];
  const addEdge = (from, to, kind, source, state = "recorded") => {
    if (!from || !to) return;
    edgeCandidates.push({
      id: stableId("edge", task.id, kind, from, to, source),
      from,
      to,
      kind,
      state,
    });
  };

  addNode({ id: task.id, kind: "task", label: task.title, state: task.status, timestamp: task.createdAt });
  const agentNodes = new Map();
  const ensureAgent = (agentId, state = "unknown", role = "participant") => {
    const clean = participant(agentId);
    if (!clean) return null;
    if (agentNodes.has(clean)) return agentNodes.get(clean);
    const id = stableId("graph-agent", clean);
    const accepted = addNode({ id, kind: "agent", label: clean, state, role, agentId: clean, timestamp: null });
    if (accepted) agentNodes.set(clean, accepted);
    return accepted;
  };

  for (const agent of agents) {
    const agentNode = ensureAgent(agent.agentId, agent.status, agent.role);
    addEdge(task.id, agentNode, "assigned", agent.id, agent.status);
  }

  for (const attempt of attempts.slice(-24)) {
    const attemptNode = addNode({
      id: attempt.id,
      kind: "attempt",
      label: `${attempt.agentId} · 第 ${attempt.round} 轮`,
      state: attempt.state,
      agentId: attempt.agentId,
      attemptId: attempt.id,
      timestamp: attempt.updatedAt ?? attempt.createdAt,
    });
    const agentNode = ensureAgent(attempt.agentId);
    addEdge(task.id, attemptNode, "contains", attempt.id, attempt.state);
    addEdge(agentNode, attemptNode, "performed", attempt.id, attempt.state);
  }

  for (const route of messageRoutes.slice(-24)) {
    const from = ensureAgent(route.from);
    const to = ensureAgent(route.to);
    addEdge(from, to, "routed", route.id, route.state);
    // 可导航：为路由边补一条消息节点（带 sourceAttemptId 时挂回 attempt）
    if (route.id) {
      const msgNode = addNode({
        id: stableId("graph-msg", route.id),
        kind: "message",
        label: `${route.from || "?"} → ${route.to || "?"}`,
        state: route.state || "routed",
        agentId: route.from,
        attemptId: route.sourceAttemptId || null,
        timestamp: route.timestamp || null,
      });
      addEdge(from, msgNode, "said", route.id, route.state || "routed");
      if (route.sourceAttemptId) addEdge(route.sourceAttemptId, msgNode, "produced", route.id, "recorded");
    }
  }

  for (const approval of approvals.slice(-12)) {
    const approvalNode = addNode({
      id: approval.id,
      kind: "approval",
      label: approval.method,
      state: approval.status,
      timestamp: approval.createdAt,
    });
    addEdge(task.id, approvalNode, "gated-by", approval.id, approval.status);
  }

  for (const artifact of artifacts) {
    const artifactNode = addNode({
      id: artifact.id,
      kind: "artifact",
      label: artifact.label,
      state: artifact.availability,
      timestamp: null,
    });
    // This surface catalogs run-scoped projections; it does not prove producer attempt lineage.
    addEdge(task.id, artifactNode, "references", artifact.id, artifact.availability);
  }

  for (const evidence of evidenceItems.slice(0, 16)) {
    const evidenceNode = addNode({
      id: evidence.id,
      kind: "event",
      label: evidence.type,
      state: evidence.state,
      agentId: evidence.agentId,
      timestamp: evidence.timestamp,
    });
    const source = evidence.agentId ? ensureAgent(evidence.agentId) : task.id;
    addEdge(source, evidenceNode, "recorded", evidence.id, evidence.state);
  }

  const seenEdges = new Set();
  const eligibleEdges = edgeCandidates.filter((edge) => {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || seenEdges.has(edge.id)) return false;
    seenEdges.add(edge.id);
    return true;
  });
  const edges = eligibleEdges.slice(0, MISSION_CONTROL_LIMITS.graphEdges);
  return {
    schema: "514cc.evidence-graph/v1",
    rootId: task.id,
    nodes,
    edges,
    truncated: {
      nodes: nodesTruncated,
      edges: eligibleEdges.length > MISSION_CONTROL_LIMITS.graphEdges,
    },
  };
}

/**
 * Build the read-only Mission Control view model. The projection intentionally
 * omits event data, bus text, approval params, native session ids and absolute
 * paths. It is deterministic for the same inputs and never mutates them.
 */
export function projectMissionControl({
  run,
  busMessages = [],
  approvals = [],
  health = [],
  events = [],
  eventsMayBeTruncated = false,
  busDiagnostics = null,
  evidenceArtifacts = [],
} = {}) {
  if (!run || typeof run !== "object" || !run.id) {
    throw Object.assign(new Error("run is required for a mission snapshot"), { code: "VALIDATION_FAILED" });
  }

  const runId = String(run.id);
  const participantIds = runParticipantIds(run);
  const rawAttempts = list(run.turnAttempts)
    .filter((item) => participantIds.has(participant(item?.agentId)));
  // The projector is a trust boundary even when the usual caller reads a
  // per-run bus file. Reject mixed/stale caller input instead of projecting it
  // into the current run's message-route, agent and evidence surfaces.
  const rawMessages = list(busMessages).filter((item) => item?.runId === runId);
  const rawApprovals = list(approvals).filter((item) => item?.runId === runId);
  const rawHealth = list(health).filter((item) => participantIds.has(participant(item?.id)));
  const rawEvents = list(events)
    .filter((item) => String(item?.runId ?? "") === runId)
    .filter((item) => claimsOnlyRunParticipants(item, participantIds));
  const busEvidence = auditBusDiagnostics(run, busDiagnostics, rawMessages.length);
  const busDegraded = busEvidence.status === "degraded";

  const boundedAttempts = orderedByTime(
    rawAttempts,
    (item) => item?.createdAt ?? item?.updatedAt,
    (item) => orderedIdentity(
      item?.attemptId,
      "attempt-order",
      positiveInteger(item?.round, 10_000),
      participant(item?.agentId),
      shortText(item?.phase, 32),
      shortText(item?.protocol, 48),
      Boolean(item?.sessionId),
      timestamp(item?.createdAt),
      timestamp(item?.updatedAt),
    ),
  )
    .slice(-MISSION_CONTROL_LIMITS.attempts);
  const attemptOccurrences = new Map();
  const attempts = boundedAttempts.map((item) => {
    const agentId = participant(item?.agentId) || "unknown";
    const phase = shortText(item?.phase, 32, "unknown").toLowerCase();
    const protocol = shortText(item?.protocol, 48) || null;
    const hasSession = Boolean(item?.sessionId);
    const createdAt = timestamp(item?.createdAt);
    const updatedAt = timestamp(item?.updatedAt);
    const publicIdentity = [
      String(item?.attemptId ?? ""),
      positiveInteger(item?.round, 10_000),
      agentId,
      phase,
      protocol,
      hasSession,
      createdAt,
      updatedAt,
    ];
    const occurrenceKey = JSON.stringify(publicIdentity);
    const occurrence = attemptOccurrences.get(occurrenceKey) ?? 0;
    attemptOccurrences.set(occurrenceKey, occurrence + 1);
    return {
      id: stableId("attempt", runId, publicIdentity, occurrence),
      round: positiveInteger(item?.round, 10_000),
      agentId,
      phase,
      state: attemptState(phase),
      protocol,
      hasSession,
      createdAt,
      updatedAt,
    };
  });

  const rawDirectMessages = rawMessages.filter((item) => {
    const from = participant(item?.from);
    const to = participant(item?.to);
    return participantIds.has(from) && participantIds.has(to);
  });
  const directMessages = orderedByTime(
    rawDirectMessages,
    (item) => item?.ts ?? item?.timestamp,
    (item) => orderedIdentity(
      item?.id,
      "message-order",
      participant(item?.from),
      participant(item?.to),
      shortText(item?.kind, 24, "say").toLowerCase(),
      timestamp(item?.ts ?? item?.timestamp),
    ),
  ).slice(-MISSION_CONTROL_LIMITS.messageRoutes);
  const routeOccurrences = new Map();
  const messageRoutes = directMessages.map((item) => {
    const from = participant(item?.from) || "unknown";
    const to = participant(item?.to) || "unknown";
    const kind = shortText(item?.kind, 24, "say").toLowerCase();
    const at = timestamp(item?.ts ?? item?.timestamp);
    const publicIdentity = [String(item?.id ?? ""), from, to, kind, at];
    const occurrenceKey = JSON.stringify(publicIdentity);
    const occurrence = routeOccurrences.get(occurrenceKey) ?? 0;
    routeOccurrences.set(occurrenceKey, occurrence + 1);
    return {
      id: stableId("message-route", runId, publicIdentity, occurrence),
      from,
      to,
      kind,
      state: "routed",
      timestamp: at,
      sourceAttemptId: item?.refs?.sourceAttemptId || item?.sourceAttemptId || null,
      busMessageId: item?.id || null,
    };
  });

  const connectionsByIdentity = new Map();
  for (const item of rawHealth) {
    const agentId = participant(item?.id) || "unknown";
    const candidate = {
      id: stableId("connection", agentId),
      agentId,
      status: connectionStatus(item),
      available: item?.available === true,
      latencyMs: item?.latencyMs == null ? null : positiveInteger(item.latencyMs, 600_000),
    };
    const current = connectionsByIdentity.get(agentId);
    if (!current || compareConnectionRisk(candidate, current) > 0) connectionsByIdentity.set(agentId, candidate);
  }
  const allConnections = [...connectionsByIdentity.values()]
    .sort((left, right) => compareText(left.agentId, right.agentId));
  const connections = allConnections.slice(0, MISSION_CONTROL_LIMITS.connections);
  const connectionsByAgent = new Map(connections.map((item) => [item.agentId, item]));

  const agentIds = new Set(participantIds);

  const allActivity = [...rawAttempts, ...rawDirectMessages, ...rawEvents];
  const agents = [...agentIds]
    .sort()
    .slice(0, MISSION_CONTROL_LIMITS.agents)
    .map((agentId) => {
      const activityTimes = [];
      for (const item of allActivity) {
        if ([item?.agentId, item?.from, item?.to].some((value) => participant(value) === agentId)) {
          activityTimes.push(item?.updatedAt, item?.createdAt, item?.timestamp, item?.ts);
        }
      }
      const connection = connectionsByAgent.get(agentId);
      const executionOwnerId = participant(run.executionOwnerId || run.startAgentId || run.route?.selected?.id);
      const role = agentId === participant(run.coordinatorId)
        ? "coordinator"
        : agentId === executionOwnerId
          ? "execution-owner"
          : list(run.teamMembers).map(participant).includes(agentId)
            ? "member"
            : "participant";
      return {
        id: stableId("agent", agentId),
        agentId,
        role,
        status: connection?.status ?? (run.sessions?.[agentId] ? "session-ready" : "unknown"),
        available: connection?.available ?? null,
        hasSession: Boolean(run.sessions?.[agentId]),
        attempts: rawAttempts.filter((item) => participant(item?.agentId) === agentId).length,
        lastActiveAt: lastTimestamp(activityTimes),
        connectionId: connection?.id ?? null,
      };
    });

  const approvalOccurrences = new Map();
  const boundedApprovals = orderedByTime(
    rawApprovals,
    (item) => item?.createdAt,
    (item) => orderedIdentity(
      item?.id,
      "approval-order",
      shortText(item?.method, 80, "approval"),
      shortText(item?.status, 24, "pending").toLowerCase(),
      timestamp(item?.createdAt),
      timestamp(item?.expiresAt),
    ),
  )
    .slice(-MISSION_CONTROL_LIMITS.approvals)
    .map((item) => {
      const method = shortText(item?.method, 80, "approval");
      const status = shortText(item?.status, 24, "pending").toLowerCase();
      const createdAt = timestamp(item?.createdAt);
      const expiresAt = timestamp(item?.expiresAt);
      const publicIdentity = [String(item?.id ?? ""), method, status, createdAt, expiresAt];
      const occurrenceKey = JSON.stringify(publicIdentity);
      const occurrence = approvalOccurrences.get(occurrenceKey) ?? 0;
      approvalOccurrences.set(occurrenceKey, occurrence + 1);
      return {
        id: stableId("approval", runId, publicIdentity, occurrence),
        method,
        status,
        createdAt,
        expiresAt,
      };
    });

  const worktreeAvailable = Boolean(run.worktreePath && run.worktreeBase);
  const workspaceAvailable = Boolean(run.worktreePath || run.cwd);
  const artifacts = [
    {
      id: stableId("artifact", runId, "bus"),
      kind: "bus",
      label: "团队消息总线",
      availability: busDegraded ? "degraded" : rawMessages.length ? "available" : "empty",
      count: rawMessages.length,
      endpoint: `/api/runs/${encodeURIComponent(runId)}/bus`,
      diagnostics: busEvidence,
    },
    {
      id: stableId("artifact", runId, "worktree"),
      kind: "worktree",
      label: "隔离工作树",
      availability: worktreeAvailable ? "available" : "unavailable",
      count: null,
      endpoint: null,
    },
    {
      id: stableId("artifact", runId, "workspace"),
      kind: "workspace",
      label: worktreeAvailable ? "工作树文件" : "项目文件",
      availability: workspaceAvailable ? "available" : "unavailable",
      count: null,
      endpoint: workspaceAvailable ? `/api/runs/${encodeURIComponent(runId)}/workspace` : null,
    },
    {
      id: stableId("artifact", runId, "diff"),
      kind: "diff",
      label: "变更 Diff",
      availability: worktreeAvailable ? "available" : "unavailable",
      count: null,
      endpoint: worktreeAvailable ? `/api/runs/${encodeURIComponent(runId)}/diff` : null,
    },
    ...list(evidenceArtifacts).map((item) => ({
      id: shortText(item?.id, 80) || stableId("artifact", runId, item?.kind, item?.label),
      kind: shortText(item?.kind, 24, "handoff"),
      label: shortText(item?.label, 180, "证据"),
      availability: shortText(item?.availability, 24, "unavailable"),
      count: Number.isSafeInteger(item?.count) ? item.count : null,
      endpoint: item?.endpoint || null,
      digest: item?.digest || null,
      generatedAt: timestamp(item?.generatedAt),
      verifyCommand: shortText(item?.verifyCommand, 160) || null,
      published: false,
    })),
  ];

  const boundedEvents = orderedByTime(
    rawEvents,
    (item) => item?.timestamp,
    (item) => orderedIdentity(
      item?.eventId ?? item?.sequence,
      "event-order",
      shortText(item?.type, 80, "unknown"),
      participant(item?.agentId),
      timestamp(item?.timestamp),
    ),
  )
    .slice(-MISSION_CONTROL_LIMITS.events);
  const eventTypeCounts = new Map();
  for (const item of boundedEvents) {
    const type = shortText(item?.type, 80, "unknown");
    eventTypeCounts.set(type, (eventTypeCounts.get(type) ?? 0) + 1);
  }
  const evidenceTypes = [...eventTypeCounts.entries()]
    .sort(([leftType, leftCount], [rightType, rightCount]) => rightCount - leftCount || compareText(leftType, rightType))
    .slice(0, MISSION_CONTROL_LIMITS.evidenceTypes)
    .map(([type, count]) => ({ type, count }));
  const evidenceOccurrences = new Map();
  const evidenceItems = boundedEvents.slice(-MISSION_CONTROL_LIMITS.evidenceItems).reverse().map((item) => {
    const type = shortText(item?.type, 80, "unknown");
    const publicIdentity = [
      String(item?.eventId ?? ""),
      nullableInteger(item?.sequence),
      type,
      participant(item?.agentId),
      timestamp(item?.timestamp),
    ];
    const occurrenceKey = JSON.stringify(publicIdentity);
    const occurrence = evidenceOccurrences.get(occurrenceKey) ?? 0;
    evidenceOccurrences.set(occurrenceKey, occurrence + 1);
    return {
      id: stableId("evidence", runId, publicIdentity, occurrence),
      type,
      state: eventState(type),
      agentId: participant(item?.agentId) || null,
      timestamp: timestamp(item?.timestamp),
    };
  });

  const observedTimes = [
    run.updatedAt,
    run.createdAt,
    ...boundedAttempts.flatMap((item) => [item?.updatedAt, item?.createdAt]),
    ...directMessages.map((item) => item?.ts ?? item?.timestamp),
    ...boundedEvents.map((item) => item?.timestamp),
    ...rawApprovals.flatMap((item) => [item?.createdAt, item?.expiresAt]),
  ];
  const round = positiveInteger(run.round, 10_000);
  const maxStepsPerInteraction = positiveInteger(run.maxStepsPerInteraction ?? run.maxRounds, 10_000);
  const interactionStep = Math.min(
    positiveInteger(run.interactionStep, 10_000),
    maxStepsPerInteraction || 10_000,
  );
  const interactionSeq = positiveInteger(run.activeInteractionSeq ?? run.interactionSeq, 10_000);
  const taskStatus = shortText(run.status, 32, "unknown").toLowerCase();
  const asOf = lastTimestamp(observedTimes);
  const auditDegraded = run.auditDegraded === true || busDegraded;
  const evidenceStatus = auditDegraded
    ? "degraded"
    : boundedEvents.length || rawMessages.length
      ? "available"
      : "empty";
  const task = {
    id: stableId("task", runId),
    title: shortText(run.title ?? run.prompt, MISSION_CONTROL_LIMITS.titleCharacters, "未命名任务"),
    status: taskStatus,
    taskType: shortText(run.taskType, 48, "unknown"),
    orchestrationMode: shortText(run.orchestrationMode, 24, "pipeline").toLowerCase(),
    conversationKind: shortText(run.conversationKind, 32, "legacy_pipeline").toLowerCase(),
    permissionMode: shortText(run.permissionMode, 24, "plan").toLowerCase(),
    teamId: participant(run.teamId) || null,
    coordinatorId: participant(run.coordinatorId) || null,
    startAgentId: participant(run.startAgentId) || null,
    executionOwnerId: participant(run.executionOwnerId || run.startAgentId || run.route?.selected?.id) || null,
    selectedAgentId: participant(run.route?.selected?.id) || null,
    createdAt: timestamp(run.createdAt),
    updatedAt: timestamp(run.updatedAt),
    progress: { round, interactionSeq, interactionStep, maxStepsPerInteraction },
    waitingForInput: Boolean(run.pendingAsk),
    auditDegraded,
  };

  // run.status 是根任务权威状态；持久 TaskGraph 只补子任务与边，不能用陈旧根节点
  // 把已终止 run 重新显示为 running。save() 会同步二者，读模型仍保持纵深防御。
  const childTasks = attempts.map((attempt, index) => ({
    id: stableId("subtask", runId, attempt.id || attempt.agentId || index),
    parentTaskId: task.id,
    kind: "attempt",
    title: shortText(`${attempt.agentId || "agent"} · r${attempt.round ?? "?"}`, 80, "子任务"),
    status: shortText(attempt.state || attempt.phase, 32, "unknown").toLowerCase(),
    assigneeId: participant(attempt.agentId) || null,
    attemptId: attempt.id || null,
    createdAt: attempt.createdAt || null,
    updatedAt: attempt.updatedAt || null,
  }));
  const graphChildren = Array.isArray(run.taskGraph?.tasks)
    ? run.taskGraph.tasks
      .filter((item) => item?.parentTaskId || item?.kind === "attempt")
      .map((item, index) => ({
        id: stableId("graph-task", runId, item.id || index),
        parentTaskId: task.id,
        kind: shortText(item.kind, 24, "task"),
        title: shortText(item.title, 80, "子任务"),
        status: shortText(item.status, 32, "unknown").toLowerCase(),
        assigneeId: participant(item.assigneeId) || null,
        attemptId: item.attemptId || null,
        createdAt: timestamp(item.createdAt),
        updatedAt: timestamp(item.updatedAt),
        source: "task-graph",
      }))
    : [];
  const tasks = [task, ...childTasks, ...graphChildren].slice(0, 64);
  const persistedDelegations = Array.isArray(run.taskGraph?.delegations)
    ? run.taskGraph.delegations.slice(-MISSION_CONTROL_LIMITS.messageRoutes).map((edge, index) => ({
      id: stableId("graph-delegation", runId, edge.id || index),
      fromAgentId: participant(edge.fromAgentId || edge.from) || "unknown",
      toAgentId: participant(edge.toAgentId || edge.to) || "unknown",
      kind: shortText(edge.kind, 24, "route"),
      state: shortText(edge.state, 24, "recorded"),
      parentTaskId: task.id,
      timestamp: timestamp(edge.timestamp || edge.at),
      source: "task-graph",
    }))
    : [];
  const routeDelegations = messageRoutes.slice(-MISSION_CONTROL_LIMITS.messageRoutes).map((route) => ({
    id: stableId("delegation", runId, route.id || route.from, route.to, route.kind),
    fromAgentId: route.from,
    toAgentId: route.to,
    kind: route.kind || "say",
    state: route.state || "routed",
    parentTaskId: task.id,
    timestamp: route.timestamp || null,
    source: "message-route",
  }));
  const delegations = [...persistedDelegations, ...routeDelegations].slice(-MISSION_CONTROL_LIMITS.messageRoutes);

  const graph = buildEvidenceGraph({ task, attempts, messageRoutes, agents, approvals: boundedApprovals, artifacts, evidenceItems });

  const projection = {
    schema: MISSION_CONTROL_SCHEMA,
    schemaVersion: 3,
    asOf,
    runId,
    task,
    tasks,
    delegations,
    attempts,
    messageRoutes,
    agents,
    connections,
    approvals: boundedApprovals,
    artifacts,
    settlement: synthesizeRunSettlement({
      run,
      artifacts,
      now: () => asOf || timestamp(run.updatedAt) || timestamp(run.createdAt) || "1970-01-01T00:00:00.000Z",
    }),
    evidence: {
      status: evidenceStatus,
      eventCount: boundedEvents.length,
      busMessageCount: rawMessages.length,
      bus: busEvidence,
      completedAttempts: attempts.filter((item) => item.state === "completed").length,
      attentionAttempts: attempts.filter((item) => item.state === "attention").length,
      pendingApprovals: boundedApprovals.filter((item) => item.status === "pending").length,
      types: evidenceTypes,
      latest: evidenceItems,
      graph,
    },
    bounds: {
      limits: { ...MISSION_CONTROL_LIMITS },
      observed: {
        events: rawEvents.length,
        attempts: rawAttempts.length,
        messageRoutes: rawDirectMessages.length,
        agents: agentIds.size,
        connections: rawHealth.length,
        approvals: rawApprovals.length,
        busMessages: busEvidence.parsedMessages,
        busBytes: busEvidence.bytesRead,
      },
      truncated: {
        events: eventsMayBeTruncated || rawEvents.length > MISSION_CONTROL_LIMITS.events,
        attempts: rawAttempts.length > MISSION_CONTROL_LIMITS.attempts,
        messageRoutes: busEvidence.truncated.bytes
          || busEvidence.truncated.messages
          || rawDirectMessages.length > MISSION_CONTROL_LIMITS.messageRoutes,
        agents: agentIds.size > MISSION_CONTROL_LIMITS.agents,
        connections: allConnections.length > MISSION_CONTROL_LIMITS.connections,
        approvals: rawApprovals.length > MISSION_CONTROL_LIMITS.approvals,
        busBytes: busEvidence.truncated.bytes,
        busMessages: busEvidence.truncated.messages,
      },
    },
  };
  return { ...projection, snapshotId: projectionSnapshotId(projection) };
}
