import test from "node:test";
import assert from "node:assert/strict";
import {
  auditBusDiagnostics,
  MISSION_CONTROL_LIMITS,
  MISSION_CONTROL_SCHEMA,
  projectMissionControl,
} from "../src/mission-control.mjs";

function fixture() {
  const runId = "11111111-1111-4111-8111-111111111111";
  return {
    run: {
      id: runId,
      prompt: "password=plain-secret-value\n完成 Mission Control 纵向切片",
      status: "waiting_agent",
      taskType: "coding",
      orchestrationMode: "social",
      conversationKind: "workspace_group",
      permissionMode: "build",
      teamId: "team-514cc",
      coordinatorId: "claude-fable",
      startAgentId: "claude-fable",
      executionOwnerId: "codex-technical",
      teamMembers: ["claude-fable", "codex-technical"],
      route: { selected: { id: "codex-technical" } },
      sessions: { "codex-technical": "session-secret-do-not-emit" },
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:03:00.000Z",
      round: 2,
      maxRounds: 6,
      worktreePath: "C:\\Users\\private-name\\repo-wt-20260723000000-12345678",
      worktreeBase: "C:\\Users\\private-name\\repo",
      turnAttempts: Array.from({ length: 120 }, (_, index) => ({
        attemptId: `attempt-${index}`,
        round: index + 1,
        agentId: index % 2 ? "codex-technical" : "claude-fable",
        phase: index % 5 ? "completed" : "failed",
        promptSha256: "not-needed",
        sessionId: `native-secret-${index}`,
        createdAt: new Date(index * 1_000).toISOString(),
        updatedAt: new Date(index * 1_000 + 500).toISOString(),
      })),
    },
    busMessages: Array.from({ length: 130 }, (_, index) => ({
      id: `message-${index}`,
      runId,
      from: index % 2 ? "claude-fable" : "codex-technical",
      to: index % 2 ? "codex-technical" : "claude-fable",
      kind: "say",
      text: `token=bus-secret-${index}-${"x".repeat(2_000)}`,
      ts: new Date(index * 2_000).toISOString(),
      refs: { password: "approval-secret" },
    })),
    approvals: Array.from({ length: 40 }, (_, index) => ({
      id: `approval-${index}`,
      runId,
      method: "item/fileChange/requestApproval",
      status: "pending",
      params: { authorization: `Bearer approval-secret-${index}` },
      createdAt: new Date(index * 3_000).toISOString(),
      expiresAt: new Date(index * 3_000 + 60_000).toISOString(),
    })),
    health: Array.from({ length: 40 }, (_, index) => ({
      id: index === 0 ? "claude-fable" : index === 1 ? "codex-technical" : `provider-${index}`,
      status: index % 2 ? "offline" : "online",
      available: index % 2 === 0,
      reason: `password=health-secret-${index}`,
      latencyMs: index * 10,
    })),
    events: Array.from({ length: 260 }, (_, index) => ({
      eventId: `event-${index}`,
      sequence: index + 1,
      timestamp: new Date(index * 4_000).toISOString(),
      type: index % 2 ? "agent.turn_completed" : "bus.routed",
      runId,
      agentId: index % 2 ? "codex-technical" : "claude-fable",
      data: { text: `api_key=event-secret-${index}-${"y".repeat(4_000)}` },
    })),
  };
}

test("mission projection is deterministic, bounded and excludes raw bodies and secrets", () => {
  const input = fixture();
  const before = structuredClone(input);
  const first = projectMissionControl(input);
  const second = projectMissionControl(input);

  assert.deepEqual(first, second);
  assert.deepEqual(input, before, "projection must not mutate orchestrator state or evidence inputs");
  assert.equal(first.schema, MISSION_CONTROL_SCHEMA);
  assert.equal(first.schemaVersion, 3);
  assert.equal(first.task.executionOwnerId, "codex-technical");
  assert.equal(first.task.conversationKind, "workspace_group");
  assert.match(first.snapshotId, /^mc-snapshot-[0-9a-f]{64}$/);
  assert.equal(first.attempts.length, MISSION_CONTROL_LIMITS.attempts);
  assert.equal(first.messageRoutes.length, MISSION_CONTROL_LIMITS.messageRoutes);
  assert.ok(Array.isArray(first.tasks) && first.tasks.length >= 1, "tasks projection includes root");
  assert.ok(Array.isArray(first.delegations), "delegations projection is always an array");
  assert.equal(first.delegations.length, first.messageRoutes.length);
  assert.equal(first.connections.length, 2);
  assert.equal(first.approvals.length, MISSION_CONTROL_LIMITS.approvals);
  assert.equal(first.evidence.eventCount, MISSION_CONTROL_LIMITS.events);
  assert.equal(first.evidence.latest.length, MISSION_CONTROL_LIMITS.evidenceItems);
  assert.deepEqual(first.bounds.truncated, {
    events: true,
    attempts: true,
    messageRoutes: true,
    agents: false,
    connections: false,
    approvals: true,
    busBytes: false,
    busMessages: false,
  });

  const serialized = JSON.stringify(first);
  for (const forbidden of [
    "plain-secret-value",
    "bus-secret",
    "approval-secret",
    "health-secret",
    "event-secret",
    "session-secret-do-not-emit",
    "native-secret",
    "private-name",
    "promptSha256",
    "worktreePath",
    "params",
    "data",
    "text",
  ]) assert.ok(!serialized.includes(forbidden), `snapshot leaked ${forbidden}`);
  assert.match(first.task.title, /password=\[REDACTED\]/);
  assert.ok(first.attempts.every((item) => /^mc-attempt-[0-9a-f]{20}$/.test(item.id)));
  assert.ok(first.messageRoutes.every((item) => /^mc-message-route-[0-9a-f]{20}$/.test(item.id)));
  assert.ok(first.messageRoutes.every((item) => item.state === "routed"));
  assert.deepEqual(first.artifacts.map((item) => [item.kind, item.availability]), [
    ["bus", "available"],
    ["worktree", "available"],
    ["workspace", "available"],
    ["diff", "available"],
  ]);
  assert.equal(first.evidence.graph.schema, "514cc.evidence-graph/v1");
  assert.equal(first.evidence.graph.rootId, first.task.id);
  assert.ok(first.evidence.graph.nodes.length <= MISSION_CONTROL_LIMITS.graphNodes);
  assert.ok(first.evidence.graph.edges.length <= MISSION_CONTROL_LIMITS.graphEdges);
  const nodeIds = new Set(first.evidence.graph.nodes.map((item) => item.id));
  assert.ok(first.evidence.graph.edges.every((item) => nodeIds.has(item.from) && nodeIds.has(item.to)), "graph edges must reference visible nodes");
  assert.ok(first.evidence.graph.nodes.some((item) => item.kind === "attempt"));
  assert.ok(first.evidence.graph.nodes.some((item) => item.kind === "artifact"));
  assert.ok(first.evidence.graph.edges.some((item) => item.kind === "references"));
  assert.ok(!first.evidence.graph.edges.some((item) => ["delegated", "produced"].includes(item.kind)));
});

test("mission projection isolates one run and reports empty optional surfaces", () => {
  const input = fixture();
  input.run.turnAttempts = [];
  input.run.sessions = {};
  input.run.worktreePath = null;
  input.run.worktreeBase = null;
  input.busMessages = [];
  input.events = [{ runId: "22222222-2222-4222-8222-222222222222", type: "foreign.secret", data: { token: "nope" } }];
  input.approvals.push({ runId: "22222222-2222-4222-8222-222222222222", params: { token: "nope" } });

  const snapshot = projectMissionControl(input);
  assert.equal(snapshot.evidence.status, "empty");
  assert.equal(snapshot.evidence.eventCount, 0);
  assert.equal(snapshot.evidence.busMessageCount, 0);
  assert.equal(snapshot.approvals.length, MISSION_CONTROL_LIMITS.approvals);
  assert.deepEqual(snapshot.artifacts.map((item) => item.availability), ["empty", "unavailable", "unavailable", "unavailable"]);
});

test("mission projection rejects unowned events, approvals and same-run ghost participants", () => {
  const input = fixture();
  const runId = input.run.id;
  input.run.turnAttempts = [
    { attemptId: "owned-attempt", agentId: "codex-technical", round: 1, phase: "completed" },
    { attemptId: "ghost-attempt", agentId: "foreign-agent", round: 1, phase: "completed" },
  ];
  input.busMessages = [
    { id: "owned-route", runId, from: "claude-fable", to: "codex-technical", kind: "say" },
    { id: "ghost-route", runId, from: "foreign-agent", to: "codex-technical", kind: "say" },
    { id: "human-route", runId, from: "lo", to: "codex-technical", kind: "say" },
  ];
  input.events = [
    { eventId: "owned-event", runId, agentId: "codex-technical", type: "agent.turn_completed" },
    { eventId: "missing-run-event", agentId: "codex-technical", type: "agent.turn_completed" },
    { eventId: "ghost-event", runId, agentId: "foreign-agent", type: "agent.turn_completed" },
  ];
  input.approvals = [
    { id: "owned-approval", runId, method: "item/fileChange/requestApproval", status: "pending" },
    { id: "foreign-approval", runId: "22222222-2222-4222-8222-222222222222", method: "item/fileChange/requestApproval", status: "pending" },
  ];
  input.health = [
    { id: "codex-technical", status: "online", available: true },
    { id: "foreign-agent", status: "online", available: true },
  ];

  const snapshot = projectMissionControl(input);
  assert.deepEqual(snapshot.attempts.map((item) => item.agentId), ["codex-technical"]);
  assert.deepEqual(snapshot.messageRoutes.map((item) => [item.from, item.to]), [["claude-fable", "codex-technical"]]);
  assert.deepEqual(snapshot.evidence.latest.map((item) => item.agentId), ["codex-technical"]);
  assert.deepEqual(snapshot.approvals.map((item) => item.method), ["item/fileChange/requestApproval"]);
  assert.deepEqual(snapshot.connections.map((item) => item.agentId), ["codex-technical"]);
  assert.ok(!snapshot.agents.some((agent) => agent.agentId === "foreign-agent"));
  assert.ok(!snapshot.evidence.graph.nodes.some((node) => node.agentId === "foreign-agent" || node.label === "foreign-agent"));
  assert.equal(snapshot.evidence.graph.edges.filter((edge) => edge.kind === "routed").length, 1);
});

test("mission projection rejects bus messages owned by another run", () => {
  const input = fixture();
  const currentMessage = {
    id: "current-message",
    runId: input.run.id,
    from: "claude-fable",
    to: "codex-technical",
    kind: "say",
    text: "current run message",
    ts: "2026-07-23T00:04:00.000Z",
  };
  input.busMessages = [
    currentMessage,
    {
      ...currentMessage,
      id: "foreign-message",
      runId: "22222222-2222-4222-8222-222222222222",
      from: "foreign-agent",
      text: "foreign run message",
      ts: "2026-07-23T00:05:00.000Z",
    },
  ];

  const snapshot = projectMissionControl(input);
  assert.equal(snapshot.evidence.busMessageCount, 1);
  assert.equal(snapshot.bounds.observed.busMessages, 1);
  assert.equal(snapshot.bounds.observed.messageRoutes, 1);
  assert.equal(snapshot.messageRoutes.length, 1);
  assert.equal(snapshot.messageRoutes[0].from, "claude-fable");
  assert.ok(!snapshot.agents.some((agent) => agent.agentId === "foreign-agent"));
});

test("mission projection makes bus corruption auditable and snapshots health or diagnostic changes", () => {
  const input = fixture();
  input.events = [];
  const healthy = projectMissionControl({
    ...input,
    busDiagnostics: {
      status: "ok",
      fileSizeBytes: 900_000,
      bytesRead: MISSION_CONTROL_LIMITS.busBytes,
      parsedMessages: 400,
      malformedLines: 0,
      issues: [],
      truncated: { bytes: true, messages: true },
    },
  });
  assert.equal(healthy.evidence.status, "available", "bounded bus evidence remains available");
  assert.equal(healthy.bounds.truncated.busBytes, true);
  assert.equal(healthy.bounds.truncated.busMessages, true);
  assert.equal(healthy.bounds.truncated.messageRoutes, true);

  const degraded = projectMissionControl({
    ...input,
    busMessages: [],
    busDiagnostics: {
      status: "degraded",
      fileSizeBytes: null,
      bytesRead: 0,
      parsedMessages: 0,
      malformedLines: 0,
      issues: [{ code: "BUS_READ_FAILED", message: "bus JSONL could not be read", systemCode: "EACCES" }],
      truncated: { bytes: false, messages: false },
    },
  });
  assert.equal(degraded.task.auditDegraded, true);
  assert.equal(degraded.evidence.status, "degraded");
  assert.equal(degraded.evidence.bus.issues[0].systemCode, "EACCES");
  assert.equal(degraded.artifacts.find((item) => item.kind === "bus")?.availability, "degraded");
  assert.ok(degraded.evidence.graph.nodes.some((item) => item.kind === "artifact" && item.state === "degraded"));
  assert.notEqual(degraded.snapshotId, healthy.snapshotId, "bus evidence state must participate in snapshot identity");

  const changedHealth = projectMissionControl({
    ...input,
    health: input.health.map((item, index) => index === 0
      ? { ...item, status: "offline", available: false, latencyMs: item.latencyMs + 1 }
      : item),
    busDiagnostics: healthy.evidence.bus,
  });
  assert.notEqual(changedHealth.snapshotId, healthy.snapshotId, "agent/connection health must participate in snapshot identity");
});

test("mission projection degrades a missing bus only after a social run starts execution", () => {
  const input = fixture();
  input.busMessages = [];
  input.events = [];
  input.approvals = [];
  input.health = [];
  input.run = {
    ...input.run,
    status: "queued",
    execute: true,
    round: 0,
    turns: [],
    turnAttempts: [],
    sessions: {},
    worktreePath: null,
    worktreeBase: null,
  };
  const missing = {
    status: "missing",
    fileSizeBytes: null,
    bytesRead: 0,
    parsedMessages: 0,
    malformedLines: 0,
    issues: [],
    truncated: { bytes: false, messages: false },
  };

  const queued = projectMissionControl({ ...input, busDiagnostics: missing });
  assert.equal(queued.task.auditDegraded, false);
  assert.equal(queued.evidence.status, "empty");
  assert.equal(queued.evidence.bus.status, "missing");
  assert.equal(queued.artifacts.find((item) => item.kind === "bus")?.availability, "empty");

  const preMaterialization = projectMissionControl({
    ...input,
    run: { ...input.run, status: "running" },
    busDiagnostics: missing,
  });
  assert.equal(preMaterialization.task.auditDegraded, false, "running can precede the first durable bus append");
  assert.equal(preMaterialization.evidence.bus.status, "missing");

  const running = projectMissionControl({
    ...input,
    run: { ...input.run, status: "running", busMaterializedAt: "2026-07-23T00:00:01.000Z" },
    busDiagnostics: missing,
  });
  assert.equal(running.task.auditDegraded, true);
  assert.equal(running.evidence.status, "degraded");
  assert.equal(running.evidence.bus.status, "degraded");
  assert.equal(running.evidence.bus.issues[0]?.code, "BUS_AUDIT_MISSING");
  assert.equal(running.artifacts.find((item) => item.kind === "bus")?.availability, "degraded");

  const emptied = projectMissionControl({
    ...input,
    run: { ...input.run, status: "running", busMaterializedAt: "2026-07-23T00:00:01.000Z" },
    busDiagnostics: { ...missing, status: "ok", fileSizeBytes: 0 },
  });
  assert.equal(emptied.task.auditDegraded, true);
  assert.equal(emptied.evidence.bus.issues[0]?.code, "BUS_AUDIT_EMPTY_AFTER_MATERIALIZATION");

  const dryRun = projectMissionControl({
    ...input,
    run: {
      ...input.run,
      status: "succeeded",
      execute: false,
      round: 1,
      turnAttempts: [{ attemptId: "continued-preview", round: 1, agentId: "claude-fable", phase: "completed" }],
      sessions: { "claude-fable": "continued-preview-session" },
    },
    busDiagnostics: missing,
  });
  assert.equal(dryRun.task.auditDegraded, false);
  assert.equal(dryRun.evidence.status, "empty");
});

test("snapshotId hashes the complete bounded public projection", () => {
  const input = fixture();
  input.events = input.events.slice(0, 5);
  input.run.turnAttempts = input.run.turnAttempts.slice(0, 5);
  input.approvals = input.approvals.slice(0, 5);
  input.health = input.health.slice(0, 5);
  input.busMessages = input.busMessages.slice(0, 5);
  const baseline = projectMissionControl(input);

  const variants = [
    ["task status", (next) => { next.run.status = "succeeded"; }],
    ["attempt phase", (next) => { next.run.turnAttempts[0].phase = "ambiguous"; }],
    ["approval status", (next) => { next.approvals[0].status = "approved"; }],
    ["artifact availability", (next) => { next.run.worktreePath = null; next.run.worktreeBase = null; }],
  ];
  for (const [label, mutate] of variants) {
    const next = structuredClone(input);
    mutate(next);
    assert.notEqual(projectMissionControl(next).snapshotId, baseline.snapshotId, `${label} must change snapshot identity`);
  }

  const truncated = projectMissionControl({ ...input, eventsMayBeTruncated: true });
  assert.notEqual(truncated.snapshotId, baseline.snapshotId, "bounds changes must change snapshot identity");
  assert.equal(truncated.bounds.truncated.events, true);
});

test("mission projection resolves duplicate health records deterministically and fail-closed", () => {
  const input = fixture();
  input.health = [
    { id: "claude-fable", status: "online", available: true, latencyMs: 10 },
    { id: "claude-fable", status: "online", available: false, latencyMs: 10 },
  ];
  const forward = projectMissionControl(input);
  const reverse = projectMissionControl({ ...input, health: [...input.health].reverse() });

  assert.deepEqual(forward.connections, reverse.connections);
  assert.equal(forward.connections.length, 1);
  assert.equal(forward.connections[0].status, "degraded");
  assert.equal(forward.connections[0].available, false);
  assert.equal(forward.snapshotId, reverse.snapshotId);
});

test("mission projection deterministically orders id-less records with equal timestamps", () => {
  const input = fixture();
  const timestamp = "2026-07-23T00:00:01.000Z";
  input.busMessages = [
    { runId: input.run.id, from: "claude-fable", to: "codex-technical", kind: "say", text: "hidden-alpha", ts: timestamp },
    { runId: input.run.id, from: "claude-fable", to: "codex-technical", kind: "say", text: "hidden-beta", ts: timestamp },
  ];
  const forward = projectMissionControl(input);
  const reverse = projectMissionControl({ ...input, busMessages: [...input.busMessages].reverse() });
  const changedBodies = projectMissionControl({
    ...input,
    busMessages: input.busMessages.map((item, index) => ({ ...item, text: `different-hidden-body-${index}` })),
  });

  assert.deepEqual(forward.messageRoutes, reverse.messageRoutes);
  assert.equal(new Set(forward.messageRoutes.map((item) => item.id)).size, 2);
  assert.equal(forward.snapshotId, reverse.snapshotId);
  assert.equal(forward.snapshotId, changedBodies.snapshotId, "omitted bus bodies must not fingerprint the public snapshot");
});

test("write-ahead bus marker makes a missing social audit fail closed", () => {
  const input = fixture();
  input.run = {
    ...input.run,
    status: "running",
    execute: true,
    round: 0,
    turns: [],
    sessions: {},
    turnAttempts: [],
    busExpectedAt: "2026-07-23T00:00:01.000Z",
    busMaterializedAt: null,
  };
  input.busMessages = [];
  input.busDiagnostics = {
    status: "missing",
    issues: [],
    fileSizeBytes: null,
    bytesRead: 0,
    parsedMessages: 0,
    malformedLines: 0,
    truncated: { bytes: false, messages: false },
  };

  const audited = auditBusDiagnostics(input.run, input.busDiagnostics, 0);
  assert.equal(audited.status, "degraded");
  assert.ok(audited.issues.some((item) => item.code === "BUS_AUDIT_MISSING"));
  assert.equal(projectMissionControl(input).task.auditDegraded, true);
});

test("an immutable run snapshot cannot mix a later bus marker with an earlier missing read", () => {
  const input = fixture();
  input.run = {
    ...input.run,
    status: "running",
    execute: true,
    round: 0,
    turns: [],
    sessions: {},
    turnAttempts: [],
    busExpectedAt: null,
    busMaterializedAt: null,
  };
  input.busMessages = [];
  input.busDiagnostics = {
    status: "missing",
    issues: [],
    fileSizeBytes: null,
    bytesRead: 0,
    parsedMessages: 0,
    malformedLines: 0,
    truncated: { bytes: false, messages: false },
  };

  const capturedRun = structuredClone(input.run);
  input.run.busExpectedAt = "2026-07-23T00:00:01.000Z";
  assert.equal(projectMissionControl({ ...input, run: capturedRun }).task.auditDegraded, false);
  assert.equal(projectMissionControl(input).task.auditDegraded, true);
});

test("duplicate explicit record ids still produce unique deterministic public ids", () => {
  const input = fixture();
  const timestamp = "2026-07-23T00:00:01.000Z";
  input.run.turnAttempts = [0, 1].map(() => ({
    attemptId: "duplicate-attempt",
    round: 1,
    agentId: "codex-technical",
    phase: "completed",
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  input.approvals = [0, 1].map(() => ({
    id: "duplicate-approval",
    runId: input.run.id,
    method: "item/fileChange/requestApproval",
    status: "pending",
    createdAt: timestamp,
    expiresAt: timestamp,
  }));
  input.events = [0, 1].map(() => ({
    eventId: "duplicate-event",
    sequence: 1,
    timestamp,
    type: "agent.turn_completed",
    runId: input.run.id,
    agentId: "codex-technical",
  }));

  const first = projectMissionControl(input);
  const second = projectMissionControl(structuredClone(input));
  assert.equal(new Set(first.attempts.map((item) => item.id)).size, 2);
  assert.equal(new Set(first.approvals.map((item) => item.id)).size, 2);
  assert.equal(new Set(first.evidence.latest.map((item) => item.id)).size, 2);
  assert.deepEqual(first, second);
});
