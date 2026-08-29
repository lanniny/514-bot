import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MISSION_CONTROL_LIMITS, MISSION_CONTROL_SCHEMA } from "../src/mission-control.mjs";
import { INBOX_SCHEMA } from "../src/collaboration-inbox.mjs";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

async function waitForResponseLeaseCount(origin, token, key, expected, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let observed = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/test/response-leases?key=${encodeURIComponent(key)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    observed = await response.json();
    if (observed.activeForKey === expected) return observed;
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  }
  assert.fail(`timed out waiting for response lease ${key}=${expected}; observed ${JSON.stringify(observed)}`);
}

async function waitForHealthStats(origin, token, predicate, description, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let observed = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/test/health-stats`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    observed = await response.json();
    if (predicate(observed)) return observed;
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  }
  assert.fail(`timed out waiting for health stats (${description}); observed ${JSON.stringify(observed)}`);
}

async function stopProductionServer(child, { timeoutMs = 5_000 } = {}) {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = new Promise((resolveExit, rejectExit) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = () => {
      cleanup();
      resolveExit();
    };
    const onError = (error) => {
      cleanup();
      rejectExit(error);
    };
    timer = setTimeout(() => {
      cleanup();
      rejectExit(new Error(`production-mode test server did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
  if (!child.kill() && child.exitCode == null && child.signalCode == null) {
    throw new Error("production-mode test server did not accept SIGTERM");
  }
  await exited;
}

test("authenticated run mission endpoint returns a bounded redacted snapshot", { timeout: 90_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-mission-http-"));
  const token = "mission-http-token";
  const runId = "11111111-1111-4111-8111-111111111111";
  const workspaceRoot = join(dataRoot, "workspace");
  await mkdir(join(dataRoot, "runs"), { recursive: true });
  await mkdir(join(dataRoot, "bus"), { recursive: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "index.js"), "const token = 'workspace-http-secret';\n", "utf8");
  await writeFile(join(workspaceRoot, "src", "editable.js"), "export const value = 1;\n", "utf8");

  const run = {
    id: runId,
    prompt: "token=mission-root-secret 完成 Mission Control",
    status: "succeeded",
    taskType: "coding",
    orchestrationMode: "social",
    permissionMode: "review",
    coordinatorId: "claude-fable",
    startAgentId: "claude-fable",
    teamMembers: ["claude-fable", "codex-technical"],
    route: { selected: { id: "codex-technical" } },
    sessions: { "codex-technical": "private-native-session" },
    cwd: workspaceRoot,
    turns: [],
    turnAttempts: Array.from({ length: 110 }, (_, index) => ({
      attemptId: `attempt-${index}`,
      round: index + 1,
      agentId: index % 2 ? "codex-technical" : "claude-fable",
      phase: "completed",
      sessionId: `native-${index}`,
      createdAt: new Date(index * 1_000).toISOString(),
      updatedAt: new Date(index * 1_000 + 10).toISOString(),
    })),
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:10:00.000Z",
    round: 4,
    maxRounds: 8,
    buildApproval: {
      status: "approved",
      approvalId: "approval-http-fixture",
      policySha256: "a".repeat(64),
      actionSha256: "b".repeat(64),
      approvedAt: "2026-07-23T00:00:00.000Z",
      lease: {
        id: `lease-${runId}`,
        approvalId: "approval-http-fixture",
        status: "active",
        issuedAt: "2026-07-23T00:00:00.000Z",
        revokedAt: null,
        expiresAt: "2099-01-01T00:00:00.000Z",
        actionSha256: "b".repeat(64),
        policySha256: "a".repeat(64),
        runId,
        sessionId: null,
        method: "control/runBuild/requestApproval",
        actor: "operator",
        revocable: true,
        scope: "attempt+action-hash+ttl+worktree",
        workspace: workspaceRoot,
      },
    },
    result: null,
    error: null,
  };
  await writeFile(join(dataRoot, "runs", `${runId}.json`), `${JSON.stringify(run)}\n`, "utf8");

  const events = Array.from({ length: 250 }, (_, index) => ({
    schemaVersion: 1,
    eventId: `event-${index}`,
    sequence: index + 1,
    timestamp: new Date(index * 2_000).toISOString(),
    type: index % 2 ? "agent.turn_completed" : "bus.routed",
    runId,
    agentId: index % 2 ? "codex-technical" : "claude-fable",
    data: { text: `password=event-http-secret-${index}-${"x".repeat(500)}` },
  }));
  await writeFile(join(dataRoot, "events.jsonl"), `${events.map(JSON.stringify).join("\n")}\n`, "utf8");

  const messages = Array.from({ length: 2_000 }, (_, index) => ({
    id: `bus-${index}`,
    ts: new Date(index * 3_000).toISOString(),
    runId,
    from: index % 2 ? "claude-fable" : "codex-technical",
    to: index === 1_998 ? "lo" : index % 2 ? "codex-technical" : "claude-fable",
    kind: index === 1_998 ? "ask" : index === 1_999 ? "answer" : "say",
    text: `authorization=Bearer bus-http-secret-${index}-${"y".repeat(200)}`,
  }));
  const busPath = join(dataRoot, "bus", `${runId}.jsonl`);
  await writeFile(busPath, `${messages.map(JSON.stringify).join("\n")}\n`, "utf8");

  const child = spawnTestServer({
    env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
  });
  t.after(async () => {
    await stopTestServer(child, { token });
    await rm(dataRoot, { recursive: true, force: true });
  });
  const origin = new URL(await waitForUrl(child)).origin;
  const endpoint = `${origin}/api/runs/${runId}/mission`;

  const unauthorized = await fetch(endpoint);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const snapshot = await response.json();
  assert.equal(snapshot.schema, MISSION_CONTROL_SCHEMA);
  assert.equal(snapshot.runId, runId);
  assert.equal(snapshot.evidence.eventCount, MISSION_CONTROL_LIMITS.events);
  assert.equal(snapshot.attempts.length, MISSION_CONTROL_LIMITS.attempts);
  assert.equal(snapshot.messageRoutes.length, MISSION_CONTROL_LIMITS.messageRoutes);
  assert.equal(snapshot.bounds.truncated.events, true);
  assert.equal(snapshot.bounds.truncated.attempts, true);
  assert.equal(snapshot.bounds.truncated.messageRoutes, true);
  assert.equal(snapshot.evidence.busMessageCount, MISSION_CONTROL_LIMITS.busMessages);
  assert.equal(snapshot.bounds.truncated.busBytes, true);
  assert.equal(snapshot.bounds.truncated.busMessages, true);
  assert.ok(snapshot.bounds.observed.busBytes <= MISSION_CONTROL_LIMITS.busBytes);
  assert.ok(snapshot.bounds.observed.busMessages > MISSION_CONTROL_LIMITS.busMessages);
  assert.equal(snapshot.evidence.graph.schema, "514cc.evidence-graph/v1");
  assert.ok(snapshot.evidence.graph.nodes.length <= MISSION_CONTROL_LIMITS.graphNodes);

  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ["mission-root-secret", "event-http-secret", "bus-http-secret", "private-native-session", "native-109", "data", "text"]) {
    assert.ok(!serialized.includes(forbidden), `HTTP snapshot leaked ${forbidden}`);
  }

  const busResponse = await fetch(`${origin}/api/runs/${runId}/bus`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(busResponse.status, 200);
  const bus = await busResponse.json();
  assert.equal(bus.messages.length, MISSION_CONTROL_LIMITS.busMessages);
  assert.equal(bus.diagnostics.status, "ok");
  assert.equal(bus.diagnostics.truncated.bytes, true);
  assert.equal(bus.diagnostics.truncated.messages, true);
  assert.ok(bus.diagnostics.bytesRead <= MISSION_CONTROL_LIMITS.busBytes);
  assert.equal(bus.messages[0]?.id, `bus-${messages.length - MISSION_CONTROL_LIMITS.busMessages}`);
  assert.equal(bus.messages.at(-1)?.id, `bus-${messages.length - 1}`);
  assert.equal(JSON.stringify(bus).includes("bus-http-secret-0-"), false, "bounded tail must exclude old records");

  const inboxResponse = await fetch(`${origin}/api/teams/team-514cc/inbox`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(inboxResponse.status, 200);
  const inbox = await inboxResponse.json();
  assert.equal(inbox.schema, INBOX_SCHEMA);
  assert.equal(inbox.team.id, "team-514cc");
  assert.ok(inbox.sources.some((source) => source.runId === runId));
  assert.equal(inbox.pendingAsks[0]?.id, "bus-1998");
  assert.equal(inbox.recentAnswers[0]?.id, "bus-1999");
  assert.equal(JSON.stringify(inbox).includes(dataRoot), false);

  const unauthorizedInbox = await fetch(`${origin}/api/teams/team-514cc/inbox`);
  assert.equal(unauthorizedInbox.status, 401);

  await writeFile(busPath, `${messages.map(JSON.stringify).join("\n")}\n{"id":`, "utf8");
  const degradedResponse = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(degradedResponse.status, 200);
  const degraded = await degradedResponse.json();
  assert.equal(degraded.evidence.status, "degraded");
  assert.equal(degraded.task.auditDegraded, true);
  assert.equal(degraded.artifacts.find((item) => item.kind === "bus")?.availability, "degraded");
  assert.ok(degraded.evidence.bus.issues.some((item) => item.code === "BUS_JSONL_TRUNCATED_LINE"));
  assert.notEqual(degraded.snapshotId, snapshot.snapshotId);

  const degradedBusResponse = await fetch(`${origin}/api/runs/${runId}/bus`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(degradedBusResponse.status, 200);
  const degradedBus = await degradedBusResponse.json();
  assert.equal(degradedBus.diagnostics.status, "degraded");
  assert.ok(degradedBus.diagnostics.issues.some((item) => item.code === "BUS_JSONL_TRUNCATED_LINE"));

  await writeFile(busPath, "", "utf8");
  const emptiedBusResponse = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(emptiedBusResponse.status, 200);
  const emptiedBus = await emptiedBusResponse.json();
  assert.equal(emptiedBus.evidence.status, "degraded");
  assert.ok(emptiedBus.evidence.bus.issues.some((item) => item.code === "BUS_AUDIT_EMPTY_AFTER_MATERIALIZATION"));
  const emptiedTopologyResponse = await fetch(`${origin}/api/runs/${runId}/bus`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(emptiedTopologyResponse.status, 200);
  const emptiedTopology = await emptiedTopologyResponse.json();
  assert.equal(emptiedTopology.diagnostics.status, "degraded");
  assert.ok(emptiedTopology.diagnostics.issues.some((item) => item.code === "BUS_AUDIT_EMPTY_AFTER_MATERIALIZATION"));

  await rm(busPath, { force: true });
  const missingBusResponse = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(missingBusResponse.status, 200);
  const missingBus = await missingBusResponse.json();
  assert.equal(missingBus.evidence.status, "degraded");
  assert.equal(missingBus.evidence.bus.status, "degraded");
  assert.ok(missingBus.evidence.bus.issues.some((item) => item.code === "BUS_AUDIT_MISSING"));
  assert.equal(missingBus.artifacts.find((item) => item.kind === "bus")?.availability, "degraded");
  const missingTopologyResponse = await fetch(`${origin}/api/runs/${runId}/bus`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(missingTopologyResponse.status, 200);
  const missingTopology = await missingTopologyResponse.json();
  assert.equal(missingTopology.diagnostics.status, "degraded");
  assert.ok(missingTopology.diagnostics.issues.some((item) => item.code === "BUS_AUDIT_MISSING"));

  const leasesResponse = await fetch(`${origin}/api/leases`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(leasesResponse.status, 200);
  const leases = (await leasesResponse.json()).leases;
  assert.equal(leases.length, 1);
  assert.equal(leases[0].id, `lease-${runId}`);
  assert.equal(leases[0].gateOpen, false, "stale approval binding must never be presented as executable");
  assert.equal(leases[0].invalidReason, "APPROVAL_BINDING_INVALID");

  const revokeResponse = await fetch(`${origin}/api/runs/${runId}/lease/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ reason: "http-test-revoke", actor: "http-test" }),
  });
  assert.equal(revokeResponse.status, 200);
  const revokedLease = await revokeResponse.json();
  assert.equal(revokedLease.status, "revoked");
  assert.equal(revokedLease.revokedBy, "http-test");

  const missing = await fetch(`${origin}/api/runs/22222222-2222-4222-8222-222222222222/mission`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error?.code, "RUN_NOT_FOUND");

  const settlement = await fetch(`${origin}/api/runs/${runId}/settlement?diff=0`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(settlement.status, 200);
  const settlementPayload = await settlement.json();
  assert.equal(settlementPayload.schema, "514cc.run-settlement/v1");
  assert.equal(settlementPayload.runId, runId);
  assert.deepEqual(settlementPayload.autoLanding, {
    merge: false,
    rebase: false,
    commit: false,
    push: false,
    gitAdd: false,
  });

  const missingSettlement = await fetch(`${origin}/api/runs/22222222-2222-4222-8222-222222222222/settlement`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(missingSettlement.status, 404);
  assert.equal((await missingSettlement.json()).error?.code, "RUN_NOT_FOUND");

  const workspace = await fetch(`${origin}/api/runs/${runId}/workspace?path=src`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(workspace.status, 200);
  const workspaceSnapshot = await workspace.json();
  assert.equal(workspaceSnapshot.type, "directory");
  assert.deepEqual(workspaceSnapshot.entries.map((item) => item.path), ["src/editable.js", "src/index.js"]);
  assert.equal(JSON.stringify(workspaceSnapshot).includes(workspaceRoot), false);

  const preview = await fetch(`${origin}/api/runs/${runId}/workspace?path=src%2Findex.js`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(preview.status, 200);
  const file = await preview.json();
  assert.equal(file.file.redacted, true);
  assert.equal(file.file.content.includes("workspace-http-secret"), false);

  const editableResponse = await fetch(`${origin}/api/runs/${runId}/workspace?path=src%2Feditable.js`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(editableResponse.status, 200);
  const editable = await editableResponse.json();
  assert.equal(editable.file.editable, true);
  const save = await fetch(`${origin}/api/runs/${runId}/workspace?path=src%2Feditable.js`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ content: "export const value = 2;\n", expectedRevision: editable.file.revision }),
  });
  assert.equal(save.status, 200);
  const saved = await save.json();
  assert.equal(saved.file.content, "export const value = 2;\n");
  assert.equal(await readFile(join(workspaceRoot, "src", "editable.js"), "utf8"), "export const value = 2;\n");

  const stale = await fetch(`${origin}/api/runs/${runId}/workspace?path=src%2Feditable.js`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ content: "stale\n", expectedRevision: editable.file.revision }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error?.code, "WORKSPACE_VERSION_CONFLICT");

  const traversal = await fetch(`${origin}/api/runs/${runId}/workspace?path=..%2Foutside`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(traversal.status, 422);
  assert.equal((await traversal.json()).error?.code, "PATH_BOUNDARY");
});

test("bus endpoint releases its bounded response lease when the HTTP client disconnects", { timeout: 30_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-bus-http-abort-"));
  const token = "bus-http-abort-token";
  const runId = "33333333-3333-4333-8333-333333333333";
  await mkdir(join(dataRoot, "runs"), { recursive: true });
  await mkdir(join(dataRoot, "bus"), { recursive: true });
  await writeFile(join(dataRoot, "runs", `${runId}.json`), `${JSON.stringify({
    id: runId,
    prompt: "verify bounded bus cancellation",
    status: "succeeded",
    taskType: "coding",
    orchestrationMode: "social",
    permissionMode: "plan",
    execute: false,
    coordinatorId: "claude-fable",
    startAgentId: "claude-fable",
    teamMembers: ["claude-fable"],
    route: { selected: { id: "claude-fable" } },
    sessions: {},
    turns: [],
    turnAttempts: [],
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:01.000Z",
    round: 0,
    maxRounds: 3,
  })}\n`, "utf8");
  await writeFile(join(dataRoot, "bus", `${runId}.jsonl`), `${JSON.stringify({
    id: "message-1",
    runId,
    from: "lo",
    to: "claude-fable",
    kind: "task",
    text: "bounded",
    ts: "2026-07-23T00:00:01.000Z",
  })}\n`, "utf8");

  const child = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: token,
      CONTROL_CENTER_DATA_DIR: dataRoot,
      CONTROL_CENTER_PORT: "0",
      CONTROL_CENTER_TEST_BUS_TAIL_GATE: "1",
    },
  });
  t.after(async () => {
    await stopTestServer(child, { token });
    await rm(dataRoot, { recursive: true, force: true });
  });
  const origin = new URL(await waitForUrl(child)).origin;
  const endpoint = `${origin}/api/runs/${runId}/bus`;
  const headers = { authorization: `Bearer ${token}` };
  const blockers = Array.from({ length: 4 }, () => {
    const controller = new AbortController();
    return { controller, response: fetch(endpoint, { headers, signal: controller.signal }) };
  });
  await waitForResponseLeaseCount(origin, token, `bus:${runId}`, 4);

  const saturated = await fetch(endpoint, { headers });
  assert.equal(saturated.status, 503);
  assert.equal((await saturated.json()).error?.code, "EVENT_INDEX_BUSY");

  blockers[0].controller.abort();
  await assert.rejects(blockers[0].response, (error) => error?.name === "AbortError");
  await waitForResponseLeaseCount(origin, token, `bus:${runId}`, 3);
  const replacementPromise = fetch(endpoint, { headers });
  await waitForResponseLeaseCount(origin, token, `bus:${runId}`, 4);

  const released = await fetch(`${origin}/api/test/bus-tail-gate/release`, { method: "POST", headers });
  assert.equal(released.status, 200);
  assert.equal((await released.json()).released, 4);

  const replacement = await replacementPromise;
  assert.equal(replacement.status, 200, "disconnect must release a same-run lease before other reads finish");
  assert.equal((await replacement.json()).messages.length, 1);

  const remaining = await Promise.all(blockers.slice(1).map((item) => item.response));
  for (const item of remaining) {
    assert.equal(item.status, 200);
    await item.arrayBuffer();
  }
});

test("mission endpoint cancels its health wait and releases the response lease on disconnect", { timeout: 60_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-mission-http-abort-"));
  const token = "mission-http-abort-token";
  const runId = "44444444-4444-4444-8444-444444444444";
  await mkdir(join(dataRoot, "runs"), { recursive: true });
  await mkdir(join(dataRoot, "bus"), { recursive: true });
  await writeFile(join(dataRoot, "runs", `${runId}.json`), `${JSON.stringify({
    id: runId,
    prompt: "verify mission health cancellation",
    status: "running",
    taskType: "coding",
    orchestrationMode: "social",
    permissionMode: "plan",
    execute: true,
    busExpectedAt: "2026-07-23T00:00:00.500Z",
    busMaterializedAt: "2026-07-23T00:00:01.000Z",
    coordinatorId: "claude-fable",
    startAgentId: "claude-fable",
    teamMembers: ["claude-fable"],
    route: { selected: { id: "claude-fable" } },
    sessions: {},
    turns: [],
    turnAttempts: [],
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:01.000Z",
    round: 0,
    maxRounds: 3,
  })}\n`, "utf8");
  await writeFile(join(dataRoot, "bus", `${runId}.jsonl`), `${JSON.stringify({
    id: "message-1",
    runId,
    from: "lo",
    to: "claude-fable",
    kind: "task",
    text: "bounded mission",
    ts: "2026-07-23T00:00:01.000Z",
  })}\n`, "utf8");

  const child = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: token,
      CONTROL_CENTER_DATA_DIR: dataRoot,
      CONTROL_CENTER_PORT: "0",
      CONTROL_CENTER_TEST_MISSION_HEALTH_DELAY_MS: "30000",
    },
  });
  t.after(async () => {
    await stopTestServer(child, { token });
    await rm(dataRoot, { recursive: true, force: true });
  });
  const origin = new URL(await waitForUrl(child)).origin;
  const endpoint = `${origin}/api/runs/${runId}/mission`;
  const headers = { authorization: `Bearer ${token}` };
  const blockers = Array.from({ length: 4 }, () => {
    const controller = new AbortController();
    return { controller, response: fetch(endpoint, { headers, signal: controller.signal }) };
  });
  let replacementController;
  let replacementPromise;
  try {
    await waitForResponseLeaseCount(origin, token, `mission:${runId}`, 4);

    const saturated = await fetch(endpoint, { headers });
    assert.equal(saturated.status, 503);
    assert.equal((await saturated.json()).error?.code, "EVENT_INDEX_BUSY");

    blockers[0].controller.abort();
    await assert.rejects(blockers[0].response, (error) => error?.name === "AbortError");
    await waitForResponseLeaseCount(origin, token, `mission:${runId}`, 3);

    replacementController = new AbortController();
    replacementPromise = fetch(endpoint, { headers, signal: replacementController.signal });
    await waitForResponseLeaseCount(origin, token, `mission:${runId}`, 4);

    const saturatedAgain = await fetch(endpoint, { headers });
    assert.equal(saturatedAgain.status, 503);
    assert.equal((await saturatedAgain.json()).error?.code, "EVENT_INDEX_BUSY");
  } finally {
    replacementController?.abort();
    for (const blocker of blockers) blocker.controller.abort();
    await Promise.allSettled([
      ...blockers.map((item) => item.response),
      ...(replacementPromise ? [replacementPromise] : []),
    ]);
  }
  await waitForResponseLeaseCount(origin, token, `mission:${runId}`, 0);
});

test("mission waiters share one health batch and disconnects retire it end-to-end", { timeout: 60_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-mission-http-health-"));
  const token = "mission-http-health-token";
  const runId = "55555555-5555-4555-8555-555555555555";
  await mkdir(join(dataRoot, "runs"), { recursive: true });
  await mkdir(join(dataRoot, "bus"), { recursive: true });
  await writeFile(join(dataRoot, "runs", `${runId}.json`), `${JSON.stringify({
    id: runId,
    prompt: "verify mission shared health batch",
    status: "running",
    taskType: "coding",
    orchestrationMode: "social",
    permissionMode: "plan",
    execute: true,
    busExpectedAt: "2026-07-23T00:00:00.500Z",
    busMaterializedAt: "2026-07-23T00:00:01.000Z",
    coordinatorId: "claude-fable",
    startAgentId: "claude-fable",
    teamMembers: ["claude-fable"],
    route: { selected: { id: "claude-fable" } },
    sessions: {},
    turns: [],
    turnAttempts: [],
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:01.000Z",
    round: 0,
    maxRounds: 3,
  })}\n`, "utf8");
  await writeFile(join(dataRoot, "bus", `${runId}.jsonl`), `${JSON.stringify({
    id: "message-1",
    runId,
    from: "lo",
    to: "claude-fable",
    kind: "task",
    text: "shared health batch",
    ts: "2026-07-23T00:00:01.000Z",
  })}\n`, "utf8");

  const child = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: token,
      CONTROL_CENTER_DATA_DIR: dataRoot,
      CONTROL_CENTER_PORT: "0",
      CONTROL_CENTER_TEST_HEALTH_PROBE_DELAY_MS: "30000",
    },
  });
  t.after(async () => {
    await stopTestServer(child, { token });
    await rm(dataRoot, { recursive: true, force: true });
  });
  const origin = new URL(await waitForUrl(child)).origin;
  const endpoint = `${origin}/api/runs/${runId}/mission`;
  const headers = { authorization: `Bearer ${token}` };

  // 3 个并发 mission 请求必须汇合到同一个共享 health batch（probe 计数只涨一轮）。
  const waiters = Array.from({ length: 3 }, () => {
    const controller = new AbortController();
    return { controller, response: fetch(endpoint, { headers, signal: controller.signal }) };
  });
  try {
    const joined = await waitForHealthStats(origin, token,
      (stats) => stats.inflight && stats.waiters === 3 && stats.probeCalls >= 1,
      "three mission waiters join one inflight health batch");
    const batchProbeCalls = joined.probeCalls;

    // 一个 waiter 断连：其余 waiter 不被波及，底层 batch 继续、不重新探测。
    waiters[0].controller.abort();
    await assert.rejects(waiters[0].response, (error) => error?.name === "AbortError");
    await waitForHealthStats(origin, token,
      (stats) => stats.inflight && stats.waiters === 2 && stats.probeCalls === batchProbeCalls,
      "surviving waiters keep the shared batch");
    const survivors = await Promise.race([
      Promise.allSettled(waiters.slice(1).map((item) => item.response)).then(() => "settled"),
      new Promise((resolvePending) => setTimeout(resolvePending, 300, "pending")),
    ]);
    assert.equal(survivors, "pending", "surviving waiters must keep waiting on the shared batch");

    // 最后一个 waiter 断连：底层 batch 被 abort，inflight/retiring 最终清空。
    for (const item of waiters.slice(1)) item.controller.abort();
    await Promise.allSettled(waiters.slice(1).map((item) => item.response));
    await waitForHealthStats(origin, token,
      (stats) => !stats.inflight && stats.waiters === 0 && stats.retiring === 0,
      "retired batch fully drains");

    // 下一次请求重新创建 batch：被取消的批次不会污染缓存或卡住后续探测。
    const replacementController = new AbortController();
    const replacement = fetch(endpoint, { headers, signal: replacementController.signal });
    try {
      await waitForHealthStats(origin, token,
        (stats) => stats.inflight && stats.probeCalls > batchProbeCalls,
        "a fresh health batch starts for the next request");
    } finally {
      replacementController.abort();
      await assert.rejects(replacement, (error) => error?.name === "AbortError");
    }
    await waitForHealthStats(origin, token,
      (stats) => !stats.inflight && stats.retiring === 0,
      "replacement batch drains after its last waiter disconnects");
  } finally {
    for (const item of waiters) item.controller.abort();
    await Promise.allSettled(waiters.map((item) => item.response));
  }
  await waitForResponseLeaseCount(origin, token, `mission:${runId}`, 0);
});

test("production mode keeps test-only HTTP controls unavailable", { timeout: 60_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-production-http-"));
  const token = "production-http-token";
  const env = {
    ...process.env,
    CONTROL_CENTER_OPEN: "0",
    CONTROL_CENTER_TOKEN: token,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_PORT: "0",
  };
  delete env.CONTROL_CENTER_TEST_MODE;
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("CONTROL_CENTER_TEST_")) delete env[key];
  }
  const child = spawn(process.execPath, [resolve(appRoot, "server.mjs")], {
    cwd: appRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(async () => {
    await stopProductionServer(child);
    await rm(dataRoot, { recursive: true, force: true });
  });
  const origin = new URL(await waitForUrl(child)).origin;
  const headers = { authorization: `Bearer ${token}` };

  for (const [path, method] of [
    ["/api/test/shutdown", "POST"],
    ["/api/test/response-leases", "GET"],
    ["/api/test/bus-tail-gate/release", "POST"],
  ]) {
    const response = await fetch(`${origin}${path}`, { method, headers });
    assert.equal(response.status, 404, `${method} ${path} must not exist outside test mode`);
    assert.equal((await response.json()).error?.code, "NOT_FOUND");
  }

  const health = await fetch(`${origin}/api/health`, { headers });
  assert.equal(health.status, 200);
  assert.ok(Array.isArray((await health.json()).items));
});
