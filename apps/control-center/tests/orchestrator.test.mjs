import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isUnlimitedBudgetValue, normalizeConversationRecipientIds, normalizeRunSources, Orchestrator, renameWithRetry, resolveBudgetUsdPerTurn, UNLIMITED_BUDGET } from "../src/orchestrator.mjs";
import { ConversationContextStore } from "../src/conversation-contexts.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

test("Conversation recipient normalization keeps stable member identity and direct topology", () => {
  const direct = { kind: "direct", directMemberId: "codex-technical", memberIds: ["codex-technical"] };
  const group = { kind: "workspace_group", memberIds: ["claude-fable", "codex-technical"] };
  assert.equal(normalizeConversationRecipientIds(undefined, direct), null);
  assert.equal(normalizeConversationRecipientIds([], group), null);
  assert.deepEqual(normalizeConversationRecipientIds(["codex-technical"], direct), ["codex-technical"]);
  assert.deepEqual(normalizeConversationRecipientIds(["codex-technical"], group), ["codex-technical"]);
  assert.throws(() => normalizeConversationRecipientIds("codex-technical", group), { code: "VALIDATION_FAILED" });
  assert.throws(() => normalizeConversationRecipientIds(["codex-technical", "codex-technical"], group), { code: "VALIDATION_FAILED" });
  assert.throws(() => normalizeConversationRecipientIds(["claude-fable", "codex-technical"], group), { code: "VALIDATION_FAILED" });
  assert.throws(() => normalizeConversationRecipientIds(["claude-fable"], direct), { code: "NOT_TEAM_MEMBER" });
  assert.throws(() => normalizeConversationRecipientIds(["outside-agent"], group), { code: "NOT_TEAM_MEMBER" });
});

function policy() {
  return {
    version: 1,
    modes: {
      plan: { write: false, approvalRequired: false },
      review: { write: false, shell: "read-only", approvalRequired: false },
      build: { write: "workspace", approvalRequired: true },
    },
    limits: { maxRounds: 6, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 10_000 },
  };
}

function route(selectedId = "codex-technical") {
  const independentId = selectedId === "claude-fable" ? "codex-technical" : "claude-fable";
  return {
    taskType: "coding",
    risk: "high",
    selected: { id: selectedId, label: selectedId },
    independent: { id: independentId, label: independentId },
    independentRequired: true,
    reason: "test route",
  };
}

test("renameWithRetry retries only transient Windows replacement failures", async () => {
  const attempts = [];
  const sleeps = [];
  await renameWithRetry("source", "target", {
    async renameFile(source, target) {
      attempts.push([source, target]);
      if (attempts.length < 3) throw Object.assign(new Error("file is temporarily locked"), { code: "EPERM" });
    },
    async sleep(delayMs) { sleeps.push(delayMs); },
  });
  assert.equal(attempts.length, 3);
  assert.deepEqual(sleeps, [10, 25]);

  let permanentAttempts = 0;
  await assert.rejects(
    renameWithRetry("source", "target", {
      async renameFile() {
        permanentAttempts += 1;
        throw Object.assign(new Error("missing directory"), { code: "ENOENT" });
      },
      async sleep() { throw new Error("must not sleep for permanent failures"); },
    }),
    { code: "ENOENT" },
  );
  assert.equal(permanentAttempts, 1);
});

async function fixture({
  approvalRequest,
  capabilities = { agentDisabledSkills: async () => new Set() },
  policy: policyOverride = null,
  models = null,
  interruptTimeoutMs = 30_000,
  conversationContexts = null,
  extraAdapterIds = [],
  route: routeOverride = null,
} = {}) {
  const root = await mkdtemp(resolve(appRoot, ".test-orchestrator-"));
  const calls = [];
  const adapter = (id) => ({
    id,
    cwd: root,
    async send(input) {
      calls.push({ id, ...input });
      await input.onSessionStarted?.({ sessionId: `${id}-session`, protocol: `${id}-mock` });
      await input.onTurnSubmitting?.({ sessionId: `${id}-session`, protocol: `${id}-mock`, clientUserMessageId: `${id}-message-${calls.length}` });
      await input.onTurnAccepted?.({ sessionId: `${id}-session`, protocol: `${id}-mock`, clientUserMessageId: `${id}-message-${calls.length}`, turnId: `${id}-turn-${calls.length}` });
      return { sessionId: `${id}-session`, text: `${id}-round-${calls.length}`, protocol: `${id}-mock`, tokens: 1000 + calls.length, costUsd: 0.01 * calls.length };
    },
    async compactThread(threadId, options = {}) {
      calls.push({ id, compactThread: true, threadId, ...options });
      return { turnId: `${id}-compact-${calls.length}` };
    },
    async close() {},
  });
  const adapters = new Map([
    ["claude-fable", adapter("claude-fable")],
    ["codex-technical", adapter("codex-technical")],
    ["codex-technical-fallback", adapter("codex-fallback")],
    ...extraAdapterIds.map((id) => [id, adapter(id)]),
  ]);
  const approvalBroker = {
    request: approvalRequest || (async () => ({ decision: "accept", approvalId: "approval-fixture" })),
    denyRun() {},
  };
  const events = [];
  const orchestrator = await new Orchestrator({
    router: { preview: async ({ requestedProvider } = {}) => routeOverride || route(requestedProvider || "codex-technical") },
    adapters,
    eventStore: { emit: async (type, data) => { events.push({ type, data }); } },
    dataRoot: root,
    policy: policyOverride || policy(),
    approvalBroker,
    capabilities,
    models,
    interruptTimeoutMs,
    conversationContexts,
  }).init();
  return { root, calls, orchestrator, approvalBroker, events };
}

test("init quarantines runs with malformed createdAt and list() never 500s", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-orch-malformed-createdat-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const runDir = join(root, "runs");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(runDir, { recursive: true });
  const badRun = {
    id: "bad-created-at",
    status: "active",
    prompt: "x",
    createdAt: null,
    conversationKind: "legacy_pipeline",
  };
  await writeFile(join(runDir, "bad-created-at.json"), JSON.stringify(badRun), "utf8");
  const orchestrator = await new Orchestrator({
    router: { preview: async () => null },
    adapters: new Map(),
    eventStore: { emit: async () => undefined },
    dataRoot: root,
    policy: policy(),
    approvalBroker: { request: async () => ({ decision: "accept" }), denyRun() {} },
  }).init();
  t.after(async () => { try { await orchestrator.close(); } catch {} });
  // list() 不得因 createdAt:null 崩溃（P0-07）
  const list = orchestrator.list();
  assert.equal(list.length, 1, "malformed run stays diagnosable, not dropped");
  assert.equal(list[0].id, "bad-created-at");
  assert.equal(list[0].recoveryIssue?.code, "RUN_CREATED_AT_INVALID", "quarantined from automatic recovery");
  assert.equal(list[0].status, "recovery_required");
});

async function waitTerminal(orchestrator, id) {
  // A wider deadline only affects a failing run under full-suite contention; ownership must still
  // drain before success, and the timeout retains enough phase data to expose a genuine hang.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const run = orchestrator.get(id);
    const executionActive = orchestrator.executions.has(id) || orchestrator.executions.has(`continue:${id}`);
    const controllerActive = orchestrator.controllers.has(id);
    // execute() persists terminal state before its final audit event. The execution entry is removed
    // only after that event settles, so waiting on ownership release avoids observing a false partial end.
    if (["succeeded", "failed", "cancelled", "recovery_required"].includes(run.status) && !executionActive && !controllerActive) {
      return orchestrator.get(id);
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  const stuck = orchestrator.get(id);
  throw new Error(`run did not finish | diag=${JSON.stringify({
    status: stuck.status,
    round: stuck.round,
    maxRounds: stuck.maxRounds,
    controllers: [...orchestrator.controllers.keys()],
    executions: [...orchestrator.executions.keys()],
    attempts: (stuck.turnAttempts || []).map((attempt) => `${attempt.agentId}:${attempt.phase}`),
  })}`);
}

test("high-risk execution performs planner, specialist and independent verifier rounds", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "plan" });
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "succeeded");
  assert.deepEqual(fx.calls.map((call) => call.id), ["claude-fable", "codex-technical", "claude-fable"]);
  assert.ok(fx.calls.every((call) => call.permissionMode === "plan"), "Plan must reach every Adapter as native plan");
  assert.equal(completed.result.final, completed.result.critique);
  assert.equal(completed.turnAttempts.length, 3);
  assert.ok(completed.turnAttempts.every((attempt) => attempt.phase === "completed" && attempt.sessionId));
  const delegations = completed.taskGraph.delegations;
  assert.deepEqual(delegations.map((edge) => [edge.fromAgentId, edge.toAgentId, edge.kind]), [
    ["claude-fable", "codex-technical", "pipeline-dispatch"],
    ["codex-technical", "claude-fable", "pipeline-review"],
  ]);
  assert.equal(delegations[0].sourceAttemptId, completed.turnAttempts[0].attemptId);
  assert.equal(delegations[0].targetAttemptId, completed.turnAttempts[1].attemptId);
  assert.equal(delegations[1].sourceAttemptId, completed.turnAttempts[1].attemptId);
  assert.equal(delegations[1].targetAttemptId, completed.turnAttempts[2].attemptId);
  assert.ok(delegations.every((edge) => edge.state === "completed"));
});

test("simple 任务短路 pipeline：打招呼只跑主脑一轮，不派工不复核", async (t) => {
  const fx = await fixture({
    route: {
      taskType: "simple",
      risk: "low",
      selected: { id: "codex-technical", label: "codex-technical" },
      reason: "greeting",
    },
  });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "plan" });
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "succeeded");
  assert.deepEqual(fx.calls.map((call) => call.id), ["claude-fable"], "simple 只允许一轮主脑调用，specialist/verifier 一律不跑");
  assert.equal(completed.result.simpleShortCircuit, true);
  assert.equal(completed.result.final, completed.result.plan);
  assert.deepEqual(completed.taskGraph.delegations, [], "短路轮不得伪造 pipeline 委派边");
});

test("budget_exhausted 止损闸：未确认的续聊被拒，确认后放行并清除失败标记", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: false, permissionMode: "plan" });
  const run = fx.orchestrator.get(created.id);
  run.status = "failed";
  run.failureKind = "budget_exhausted";
  run.error = "API Error 403: 额度不足";

  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "继续" }),
    { code: "BUDGET_EXHAUSTED" },
  );
  assert.equal(fx.calls.length, 0, "止损闸必须挡在 provider 调用之前，不能先烧一轮再失败");

  const resumed = await fx.orchestrator.continue(created.id, { prompt: "余额已充值，继续", acknowledgeRecovery: true });
  assert.equal(resumed.status, "succeeded");
  assert.equal(fx.calls.length, 1);
  assert.equal(resumed.failureKind, null, "成功交互必须清除止损标记，否则后续消息被陈旧值误拦");
  assert.equal(resumed.error, null);
});

test("direct conversations dispatch only to the selected member and keep its native session", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const linkedRuns = [];
  fx.orchestrator.conversations = {
    get(id) {
      assert.equal(id, "conversation-1");
      return { id, kind: "direct", directMemberId: "codex-technical", memberIds: ["codex-technical"] };
    },
    async attachRun(id, runId) { linkedRuns.push([id, runId]); },
    async detachRun() { throw new Error("successful persistence must not roll back the conversation link"); },
  };
  const created = await fx.orchestrator.create({
    prompt: "只和 Codex 对话",
    execute: true,
    conversationKind: "direct",
    conversationId: "conversation-1",
    orchestrationMode: "pipeline",
    startAgentId: "codex-technical",
    requestedProvider: "codex-technical",
    maxRounds: 1,
    permissionMode: "plan",
  });
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.conversationKind, "direct");
  assert.equal(completed.conversationId, "conversation-1");
  assert.deepEqual(linkedRuns, [["conversation-1", completed.id]]);
  assert.deepEqual(fx.calls.map((call) => call.id), ["codex-technical"]);
  assert.equal(completed.result.direct, completed.result.final);
  assert.equal(completed.turnAttempts.length, 1);

  await fx.orchestrator.continue(completed.id, { prompt: "继续单聊", waitForTurn: true });
  const resumed = await waitTerminal(fx.orchestrator, completed.id);
  assert.equal(resumed.status, "succeeded");
  assert.deepEqual(fx.calls.map((call) => call.id), ["codex-technical", "codex-technical"]);
  assert.equal(fx.calls[1].sessionId, "codex-technical-session");
});

test("Conversation message admission keeps an active Run instead of creating a second Run", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const firstTurn = deferred();
  const runtimeAdapter = fx.orchestrator.adapters.get("codex-technical");
  const originalSend = runtimeAdapter.send.bind(runtimeAdapter);
  let sendCount = 0;
  runtimeAdapter.send = async (input) => {
    sendCount += 1;
    if (sendCount === 1) await firstTurn.promise;
    return originalSend(input);
  };
  const conversation = {
    id: "conversation-active",
    kind: "direct",
    scope: "global",
    roomRole: "task",
    projectId: null,
    directMemberId: "codex-technical",
    memberIds: ["codex-technical"],
    runIds: [],
    activeRunId: null,
  };
  fx.orchestrator.conversations = {
    get(id) {
      assert.equal(id, conversation.id);
      return conversation;
    },
    async attachRun(_id, runId) {
      conversation.runIds.push(runId);
      conversation.activeRunId = runId;
    },
    async detachRun() {},
  };
  const created = await fx.orchestrator.create({
    prompt: "active first turn",
    execute: true,
    conversationKind: "direct",
    conversationId: conversation.id,
    orchestrationMode: "pipeline",
    startAgentId: "codex-technical",
    requestedProvider: "codex-technical",
    maxRounds: 1,
    permissionMode: "plan",
  });
  const admitted = await fx.orchestrator.conversationMessage(conversation.id, {
    prompt: "queue through Conversation identity",
    messageIntent: "steer",
    recipientMemberIds: ["codex-technical"],
    waitForTurn: false,
  });
  assert.equal(admitted.created, false);
  assert.equal(admitted.run.id, created.id);
  assert.equal(conversation.runIds.length, 1);
  assert.equal(admitted.run.pendingSteer.length, 1);
  assert.equal(admitted.run.pendingSteer[0].prompt, "queue through Conversation identity");
  assert.equal(admitted.run.pendingSteer[0].agentId, "codex-technical");
  firstTurn.resolve();
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(sendCount, 2);
});

test("a completed direct Conversation epoch carries its native session into the next Run only", async (t) => {
  const contextRoot = await mkdtemp(resolve(appRoot, ".test-conversation-epoch-"));
  const conversationContexts = await new ConversationContextStore({ dataRoot: contextRoot }).init();
  const fx = await fixture({ conversationContexts });
  t.after(async () => {
    await fx.orchestrator.close();
    await conversationContexts.close();
    await rm(fx.root, { recursive: true, force: true });
    await rm(contextRoot, { recursive: true, force: true });
  });
  const runtimeAdapter = fx.orchestrator.adapters.get("codex-technical");
  runtimeAdapter.id = "codex-app-server";
  const linkedRuns = [];
  fx.orchestrator.conversations = {
    get(id) {
      return {
        id,
        kind: "direct",
        scope: "global",
        roomRole: "task",
        projectId: null,
        directMemberId: "codex-technical",
        memberIds: ["codex-technical"],
      };
    },
    async attachRun(id, runId) { linkedRuns.push([id, runId]); },
    async detachRun() {},
  };
  const createDirect = () => fx.orchestrator.create({
    prompt: "跨 Run 保持会话",
    execute: true,
    conversationKind: "direct",
    conversationId: "conversation-epoch",
    orchestrationMode: "pipeline",
    startAgentId: "codex-technical",
    requestedProvider: "codex-technical",
    maxRounds: 1,
    permissionMode: "plan",
  });

  const first = await createDirect();
  const firstDone = await waitTerminal(fx.orchestrator, first.id);
  assert.equal(firstDone.contextEpoch, 1);
  assert.deepEqual(firstDone.contextInheritedMembers, []);
  assert.equal(contextRoot === fx.root, false, "the context ledger is independent from Run persistence in this fixture");

  const second = await createDirect();
  const secondDone = await waitTerminal(fx.orchestrator, second.id);
  assert.equal(secondDone.contextEpoch, 1);
  assert.deepEqual(secondDone.contextInheritedMembers, ["codex-technical"]);
  assert.equal(secondDone.contextInheritedFromRunId, first.id);
  assert.equal(fx.calls[1].sessionId, "codex-technical-session");
  assert.equal(secondDone.permissionMode, "plan", "session inheritance must not copy a prior Run permission state");
  assert.equal(secondDone.buildApproval, null);
  assert.equal(linkedRuns.length, 2);
});

test("concurrent Run creation cannot inherit one Conversation native session twice", async (t) => {
  const contextRoot = await mkdtemp(resolve(appRoot, ".test-conversation-epoch-race-"));
  const conversationContexts = await new ConversationContextStore({ dataRoot: contextRoot }).init();
  await conversationContexts.claim({
    conversationId: "conversation-race",
    topologyKey: "seed-topology",
    runId: "seed-run",
    candidates: [],
  });
  const fx = await fixture({ conversationContexts });
  t.after(async () => {
    await fx.orchestrator.close();
    await conversationContexts.close();
    await rm(fx.root, { recursive: true, force: true });
    await rm(contextRoot, { recursive: true, force: true });
  });
  const runtimeAdapter = fx.orchestrator.adapters.get("codex-technical");
  runtimeAdapter.id = "codex-app-server";
  const conversation = {
    id: "conversation-race",
    kind: "direct",
    scope: "global",
    roomRole: "task",
    projectId: null,
    directMemberId: "codex-technical",
    memberIds: ["codex-technical"],
  };
  fx.orchestrator.conversations = {
    get: () => conversation,
    async attachRun() {},
    async detachRun() {},
  };
  const seedPlan = fx.orchestrator.conversationContextPlan({
    conversation,
    conversationKind: "direct",
    projectId: null,
    sessionCwd: null,
    sessionRemote: null,
    teamRoster: null,
    executionOwnerId: "codex-technical",
  });
  await conversationContexts.claim({
    conversationId: conversation.id,
    topologyKey: seedPlan.topologyKey,
    runId: "seed-run",
    candidates: [],
  });
  await conversationContexts.publish({
    conversationId: conversation.id,
    topologyKey: seedPlan.topologyKey,
    runId: "seed-run",
    binding: {
      memberId: "codex-technical",
      sessionId: "seed-session",
      runtimeProfileId: "codex-technical",
      adapterId: "codex-app-server",
      protocol: "app-server-v2",
      providerBinding: fx.orchestrator.providerBindingFor(runtimeAdapter, "codex-technical", { remote: false }),
      sourceAttemptId: "seed-attempt",
      cwdKey: null,
      remoteKey: null,
    },
  });

  const originalClaim = conversationContexts.claim.bind(conversationContexts);
  const firstClaimed = deferred();
  const releaseFirst = deferred();
  let claimCount = 0;
  conversationContexts.claim = async (input) => {
    const result = await originalClaim(input);
    claimCount += 1;
    if (claimCount === 1) {
      firstClaimed.resolve();
      await releaseFirst.promise;
    }
    return result;
  };
  const createDirect = (prompt) => fx.orchestrator.create({
    prompt,
    execute: true,
    conversationKind: "direct",
    conversationId: conversation.id,
    orchestrationMode: "pipeline",
    startAgentId: "codex-technical",
    requestedProvider: "codex-technical",
    maxRounds: 1,
    permissionMode: "plan",
  });

  const firstPromise = createDirect("first concurrent run");
  await firstClaimed.promise;
  const second = await createDirect("second concurrent run");
  releaseFirst.resolve();
  const first = await firstPromise;
  assert.deepEqual(first.contextInheritedMembers, ["codex-technical"]);
  assert.equal(first.contextInheritedFromRunId, "seed-run");
  assert.deepEqual(second.contextInheritedMembers, []);
  assert.equal(second.contextInheritedFromRunId, null);
});

test("cancel invalidates an in-flight context publication without waiting for the provider lifecycle", async (t) => {
  const contextRoot = await mkdtemp(resolve(appRoot, ".test-conversation-cancel-publication-"));
  const conversationContexts = await new ConversationContextStore({ dataRoot: contextRoot }).init();
  const fx = await fixture({ conversationContexts });
  t.after(async () => {
    await fx.orchestrator.close();
    await conversationContexts.close();
    await rm(fx.root, { recursive: true, force: true });
    await rm(contextRoot, { recursive: true, force: true });
  });
  fx.orchestrator.adapters.get("codex-technical").id = "codex-app-server";
  const conversation = {
    id: "conversation-cancel-publication",
    kind: "direct",
    scope: "global",
    roomRole: "task",
    projectId: null,
    directMemberId: "codex-technical",
    memberIds: ["codex-technical"],
    runIds: [],
    activeRunId: null,
  };
  fx.orchestrator.conversations = {
    get: () => conversation,
    async attachRun(_id, runId) {
      conversation.runIds.push(runId);
      conversation.activeRunId = runId;
    },
    async detachRun() {},
  };
  const publicationStarted = deferred();
  const releasePublication = deferred();
  const originalPublish = conversationContexts.publish.bind(conversationContexts);
  conversationContexts.publish = async (input) => {
    publicationStarted.resolve();
    await releasePublication.promise;
    return originalPublish(input);
  };

  const created = await fx.orchestrator.create({
    prompt: "cancel while publishing context",
    execute: true,
    conversationKind: "direct",
    conversationId: conversation.id,
    orchestrationMode: "pipeline",
    startAgentId: "codex-technical",
    requestedProvider: "codex-technical",
    maxRounds: 1,
    permissionMode: "plan",
  });
  await publicationStarted.promise;
  const cancellation = fx.orchestrator.cancel(created.id);
  const cancelled = await cancellation;
  assert.equal(cancelled.status, "cancelled");
  const execution = fx.orchestrator.executions.get(created.id);
  assert.ok(execution, "the blocked provider lifecycle remains owned until publication settles");
  releasePublication.resolve();
  await execution;
  assert.deepEqual(conversationContexts.get(conversation.id).bindings, {});

  const next = await fx.orchestrator.create({
    prompt: "fresh context after cancellation",
    execute: true,
    conversationKind: "direct",
    conversationId: conversation.id,
    orchestrationMode: "pipeline",
    startAgentId: "codex-technical",
    requestedProvider: "codex-technical",
    maxRounds: 1,
    permissionMode: "plan",
  });
  assert.deepEqual(next.contextInheritedMembers, []);
  assert.equal(next.contextInheritedFromRunId, null);
});

test("direct conversations reject social orchestration", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  await assert.rejects(
    fx.orchestrator.create({
      prompt: "invalid topology",
      execute: false,
      conversationKind: "direct",
      orchestrationMode: "social",
      startAgentId: "codex-technical",
    }),
    { code: "VALIDATION_FAILED" },
  );
});

test("persisted conversation inputs fail closed without their stores", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  await assert.rejects(
    fx.orchestrator.create({
      prompt: "missing conversation store",
      execute: false,
      conversationId: "conversation-missing",
      conversationKind: "direct",
      startAgentId: "codex-technical",
      permissionMode: "plan",
    }),
    { code: "CONVERSATION_STORE_UNAVAILABLE" },
  );
  await assert.rejects(
    fx.orchestrator.create({
      prompt: "unpersisted workspace",
      execute: false,
      conversationKind: "workspace_group",
      orchestrationMode: "social",
      cwd: fx.root,
      permissionMode: "plan",
    }),
    { code: "CONVERSATION_STORE_UNAVAILABLE" },
  );
});

test("project conversations derive projectId and cwd from the persisted server-side scope", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const project = { projectId: "project-1", canonicalCwd: fx.root, title: "Project" };
  const conversation = {
    id: "conversation-project-1",
    kind: "workspace_group",
    scope: "project",
    roomRole: "default",
    projectId: project.projectId,
    memberIds: ["claude-fable", "codex-technical"],
  };
  const linkedRuns = [];
  fx.orchestrator.projects = { get: (id) => id === project.projectId ? project : null };
  fx.orchestrator.conversations = {
    get: (id) => id === conversation.id ? conversation : null,
    async attachRun(id, runId) { linkedRuns.push([id, runId]); },
    async detachRun() {},
  };
  fx.orchestrator.teams = {
    materializeEphemeral(input) {
      return { id: null, name: input.name, coordinator: input.coordinator, members: [...input.members], skills: [], mcp: [], ephemeral: true };
    },
    briefFor() { return "project fixture"; },
  };
  const ephemeralTeam = {
    name: "Project fixture",
    coordinator: "claude-fable",
    members: [...conversation.memberIds],
  };
  const created = await fx.orchestrator.create({
    prompt: "project route",
    execute: false,
    conversationId: conversation.id,
    conversationKind: conversation.kind,
    orchestrationMode: "social",
    startAgentId: "claude-fable",
    requestedAgentIds: ["codex-technical"],
    ephemeralTeam,
    permissionMode: "plan",
  });
  assert.equal(created.projectId, project.projectId);
  assert.equal(created.cwd, fx.root);
  assert.deepEqual(linkedRuns, [[conversation.id, created.id]]);
  conversation.memberIds = [];
  await assert.rejects(
    fx.orchestrator.create({
      prompt: "empty project room must stay idle",
      execute: false,
      conversationId: conversation.id,
      conversationKind: conversation.kind,
      orchestrationMode: "social",
      startAgentId: "claude-fable",
      requestedAgentIds: ["codex-technical"],
      ephemeralTeam,
      permissionMode: "plan",
    }),
    { code: "VALIDATION_FAILED" },
  );
  conversation.memberIds = ["claude-fable", "codex-technical"];
  await assert.rejects(
    fx.orchestrator.create({
      prompt: "attempt client override",
      execute: false,
      conversationId: conversation.id,
      conversationKind: conversation.kind,
      orchestrationMode: "social",
      startAgentId: "claude-fable",
      requestedAgentIds: ["codex-technical"],
      ephemeralTeam,
      cwd: resolve(fx.root, "other"),
      permissionMode: "plan",
    }),
    { code: "INVALID_CWD" },
  );
  project.archivedAt = new Date().toISOString();
  await assert.rejects(
    fx.orchestrator.create({
      prompt: "archived project",
      execute: false,
      conversationId: conversation.id,
      conversationKind: conversation.kind,
      orchestrationMode: "social",
      startAgentId: "claude-fable",
      requestedAgentIds: ["codex-technical"],
      ephemeralTeam,
      permissionMode: "plan",
    }),
    { code: "PROJECT_ARCHIVED" },
  );
  await assert.rejects(
    fx.orchestrator.continue(created.id, { prompt: "continue archived project" }),
    { code: "PROJECT_ARCHIVED" },
  );
  project.archivedAt = null;
  await fx.orchestrator.continue(created.id, { prompt: "continue restored project", waitForTurn: true });
  assert.equal((await waitTerminal(fx.orchestrator, created.id)).status, "succeeded");
  conversation.memberIds = ["claude-fable"];
  await assert.rejects(
    fx.orchestrator.continue(created.id, { prompt: "continue stale membership" }),
    { code: "CONVERSATION_MEMBERS_CHANGED" },
  );
  const archived = await fx.orchestrator.archiveFinishedByProjectId(project.projectId);
  assert.deepEqual(archived.runIds, [created.id]);
  assert.equal(archived.matchedBy, "projectId");
});

test("a targeted workspace Conversation message keeps the full roster but starts with the mentioned member", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const project = { projectId: "project-targeted", canonicalCwd: fx.root, title: "Targeted" };
  const conversation = {
    id: "conversation-targeted",
    kind: "workspace_group",
    scope: "project",
    roomRole: "task",
    projectId: project.projectId,
    title: "Targeted room",
    memberIds: ["claude-fable", "codex-technical"],
    runIds: [],
    activeRunId: null,
  };
  fx.orchestrator.projects = { get: (id) => id === project.projectId ? project : null };
  fx.orchestrator.conversations = {
    get: (id) => id === conversation.id ? conversation : null,
    async attachRun(_id, runId) {
      conversation.runIds.push(runId);
      conversation.activeRunId = runId;
    },
    async detachRun() {},
  };
  fx.orchestrator.teams = {
    materializeEphemeral(input) {
      return { id: null, name: input.name, coordinator: input.coordinator, members: [...input.members], skills: [], mcp: [], ephemeral: true };
    },
    briefFor() { return "targeted conversation fixture"; },
  };
  const admitted = await fx.orchestrator.conversationMessage(conversation.id, {
    prompt: "only Codex should answer this message",
    recipientMemberIds: ["codex-technical"],
  });
  assert.equal(admitted.created, true);
  assert.equal(admitted.run.startAgentId, "codex-technical");
  assert.deepEqual(admitted.run.requestedAgentIds, []);
  assert.deepEqual(admitted.run.teamMembers, ["claude-fable", "codex-technical"]);
  assert.equal(admitted.run.conversationId, conversation.id);
  await waitTerminal(fx.orchestrator, admitted.run.id);
});

test("idempotency keys are isolated by conversation", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const conversations = new Map([
    ["conversation-a", { id: "conversation-a", kind: "direct", scope: "global", directMemberId: "codex-technical", memberIds: ["codex-technical"] }],
    ["conversation-b", { id: "conversation-b", kind: "direct", scope: "global", directMemberId: "codex-technical", memberIds: ["codex-technical"] }],
  ]);
  fx.orchestrator.conversations = {
    get: (id) => conversations.get(id) || null,
    async attachRun() {},
    async detachRun() {},
  };
  const input = {
    prompt: "conversation-scoped retry",
    execute: false,
    conversationKind: "direct",
    orchestrationMode: "pipeline",
    startAgentId: "codex-technical",
    requestedProvider: "codex-technical",
    permissionMode: "plan",
    idempotencyKey: "client:retry:1",
  };
  const [first, concurrentReplay] = await Promise.all([
    fx.orchestrator.create({ ...input, conversationId: "conversation-a" }),
    fx.orchestrator.create({ ...input, conversationId: "conversation-a" }),
  ]);
  const replay = await fx.orchestrator.create({ ...input, conversationId: "conversation-a" });
  const isolated = await fx.orchestrator.create({ ...input, conversationId: "conversation-b" });
  assert.equal(concurrentReplay.id, first.id);
  assert.equal(replay.id, first.id);
  assert.notEqual(isolated.id, first.id);
  assert.equal(isolated.conversationId, "conversation-b");
});

test("a failed run-link compensation marks the conversation store inconsistent", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  let inconsistent = null;
  fx.orchestrator.conversations = {
    get: (id) => ({ id, kind: "direct", scope: "global", directMemberId: "codex-technical", memberIds: ["codex-technical"] }),
    async attachRun() {},
    async detachRun() { throw Object.assign(new Error("detach run failed"), { code: "DETACH_RUN_FAILED" }); },
    markTransactionInconsistent(operation, cause, compensationError) {
      inconsistent = { operation, cause, compensationError };
      return Object.assign(new Error("store inconsistent"), { code: "TRANSACTION_INCONSISTENT", recoveryRequired: true });
    },
  };
  fx.orchestrator.save = async () => { throw Object.assign(new Error("run persistence failed"), { code: "RUN_PERSIST_FAILED" }); };
  await assert.rejects(
    fx.orchestrator.create({
      prompt: "persist run",
      execute: false,
      conversationId: "conversation-a",
      conversationKind: "direct",
      startAgentId: "codex-technical",
      requestedProvider: "codex-technical",
      permissionMode: "plan",
    }),
    (error) => error.code === "TRANSACTION_INCONSISTENT" && error.recoveryRequired === true,
  );
  assert.equal(inconsistent.operation, "run-create rollback");
  assert.equal(inconsistent.cause.code, "RUN_PERSIST_FAILED");
  assert.equal(inconsistent.compensationError.code, "DETACH_RUN_FAILED");
});

test("missing capability provider blocks every provider dispatch", async (t) => {
  const fx = await fixture({ capabilities: null });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "must fail closed", execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "plan" });
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "failed");
  assert.equal(fx.calls.length, 0);
  assert.ok(fx.events.some((event) => event.type === "run.failed" && event.data?.code === "CAPABILITY_CONFIG_UNAVAILABLE"));
});

test("historical runs cannot continue through a provider removed from the live adapter graph", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "preview", execute: false, permissionMode: "plan" });
  const retainedClaude = fx.orchestrator.adapters.get("claude-fable");
  await fx.orchestrator.replaceRuntime({
    router: fx.orchestrator.router,
    adapters: new Map([["claude-fable", retainedClaude]]),
    policy: fx.orchestrator.policy,
    models: { profiles: [{ id: "claude-fable", enabled: true }, { id: "codex-technical", enabled: false }] },
  });
  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "must stay disabled", agentId: "codex-technical" }),
    { code: "ADAPTER_UNAVAILABLE" },
  );
});

test("settled Grok upstream failure preserves its preassigned native session for the next continuation", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "preview", execute: false, permissionMode: "plan" });
  const target = fx.orchestrator.adapters.get("codex-technical");
  const nativeSessionId = "01a0034a-771d-7b62-b97d-bf7089aaa07b";
  const receivedSessionIds = [];
  let callCount = 0;
  target.send = async (input) => {
    callCount += 1;
    receivedSessionIds.push(input.sessionId);
    if (callCount === 1) {
      await input.onTurnSubmitting?.({
        sessionId: null,
        tentativeSessionId: nativeSessionId,
        sessionResumable: false,
        protocol: "grok-headless-resume",
        clientUserMessageId: "grok-preassigned-message",
      });
      throw Object.assign(new Error("Grok Responses upstream returned HTTP 400"), {
        code: "GROK_BUILD_FAILED",
        sessionId: nativeSessionId,
        tentativeSessionId: nativeSessionId,
        sessionResumable: true,
        protocol: "grok-headless-resume",
        nativeTurnSettled: true,
        interruptConfirmed: true,
      });
    }
    await input.onSessionStarted?.({ sessionId: input.sessionId, protocol: "grok-headless-resume" });
    await input.onTurnSubmitting?.({
      sessionId: input.sessionId,
      protocol: "grok-headless-resume",
      clientUserMessageId: "grok-resumed-message",
    });
    return {
      sessionId: input.sessionId,
      text: "resumed",
      protocol: "grok-headless-resume",
      tokens: 10,
    };
  };

  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "first attempt", agentId: "codex-technical" }),
    { code: "GROK_BUILD_FAILED" },
  );
  const failed = fx.orchestrator.get(created.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.sessions["codex-technical"], nativeSessionId);
  assert.equal(failed.turnAttempts.at(-1).phase, "failed");
  assert.equal(failed.turnAttempts.at(-1).sessionId, nativeSessionId);
  assert.equal(failed.turnAttempts.at(-1).tentativeSessionId, nativeSessionId);
  assert.equal(failed.turnAttempts.at(-1).sessionResumable, true);

  await fx.orchestrator.continue(created.id, { prompt: "继续", agentId: "codex-technical" });
  const resumed = fx.orchestrator.get(created.id);
  assert.equal(resumed.status, "succeeded");
  assert.deepEqual(receivedSessionIds, [null, nativeSessionId]);
  assert.equal(resumed.turns.at(-1).sessionId, nativeSessionId);
});

test("settled Codex context exhaustion compacts the same thread before a new durable attempt", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "preview", execute: false, permissionMode: "plan" });
  const target = fx.orchestrator.adapters.get("codex-technical");
  const sessionId = "01a0178b-e92f-77c2-af6e-0762934fba1c";
  const prompts = [];
  const compactCalls = [];
  target.id = "codex-app-server";
  target.compactThread = async (threadId, options) => {
    compactCalls.push({ threadId, options });
    return { sessionId: threadId, turnId: "compact-turn", protocol: "app-server-v2" };
  };
  target.send = async (input) => {
    prompts.push(input.prompt);
    await input.onSessionStarted?.({ sessionId, protocol: "app-server-v2" });
    await input.onTurnSubmitting?.({
      sessionId,
      protocol: "app-server-v2",
      clientUserMessageId: `context-message-${prompts.length}`,
    });
    await input.onTurnAccepted?.({
      sessionId,
      protocol: "app-server-v2",
      clientUserMessageId: `context-message-${prompts.length}`,
      turnId: `context-turn-${prompts.length}`,
    });
    if (prompts.length === 1) {
      throw Object.assign(new Error("context exhausted"), {
        code: "CONTEXT_WINDOW_EXCEEDED",
        nativeTurnSettled: true,
        requiresContextCompaction: true,
        safeToFallback: false,
        sessionId,
        protocol: "app-server-v2",
        clientUserMessageId: "context-message-1",
        turnId: "context-turn-1",
      });
    }
    return { sessionId, text: "continued after compaction", protocol: "app-server-v2" };
  };

  const completed = await fx.orchestrator.continue(created.id, {
    prompt: "继续",
    agentId: "codex-technical",
  });
  assert.equal(completed.status, "succeeded");
  assert.equal(compactCalls.length, 1);
  assert.equal(compactCalls[0].threadId, sessionId);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1], prompts[0], "retry must not duplicate member/team prompt wrappers");
  assert.deepEqual(completed.turnAttempts.slice(-2).map((attempt) => attempt.phase), ["failed", "completed"]);
  assert.notEqual(completed.turnAttempts.at(-2).attemptId, completed.turnAttempts.at(-1).attemptId);
  assert.equal(completed.turnAttempts.at(-1).round, completed.turnAttempts.at(-2).round + 1);
  assert.equal(completed.sessions["codex-technical"], sessionId);
  assert.equal(completed.contextRecovery?.state, "completed");
  assert.equal(fx.events.some((event) => event.type === "adapter.replay_blocked"), false);
});

test("failed Codex context compaction invalidates the old thread before recovery acknowledgement", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "preview", execute: false, permissionMode: "plan" });
  const target = fx.orchestrator.adapters.get("codex-technical");
  const oldSessionId = "01a0178b-e92f-77c2-af6e-0762934fba1c";
  const receivedSessionIds = [];
  let shouldFail = true;
  target.id = "codex-app-server";
  target.compactThread = async () => {
    throw Object.assign(new Error("compact turn failed"), { code: "CONTEXT_COMPACTION_FAILED" });
  };
  target.send = async (input) => {
    receivedSessionIds.push(input.sessionId);
    const sessionId = input.sessionId || (shouldFail ? oldSessionId : "fresh-thread");
    await input.onSessionStarted?.({ sessionId, protocol: "app-server-v2" });
    await input.onTurnSubmitting?.({ sessionId, protocol: "app-server-v2", clientUserMessageId: `message-${receivedSessionIds.length}` });
    await input.onTurnAccepted?.({ sessionId, protocol: "app-server-v2", clientUserMessageId: `message-${receivedSessionIds.length}`, turnId: `turn-${receivedSessionIds.length}` });
    if (shouldFail) {
      throw Object.assign(new Error("context exhausted"), {
        code: "CONTEXT_WINDOW_EXCEEDED",
        nativeTurnSettled: true,
        requiresContextCompaction: true,
        safeToFallback: false,
        sessionId,
        protocol: "app-server-v2",
      });
    }
    return { sessionId, text: "fresh session continued", protocol: "app-server-v2" };
  };

  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "继续", agentId: "codex-technical" }),
    { code: "RECOVERY_REQUIRED" },
  );
  const blocked = fx.orchestrator.get(created.id);
  assert.equal(blocked.status, "recovery_required");
  assert.equal(blocked.sessions["codex-technical"], undefined);
  assert.equal(blocked.contextRecovery?.state, "failed");
  assert.equal(blocked.invalidatedSessions.at(-1)?.sessionId, oldSessionId);

  shouldFail = false;
  await fx.orchestrator.continue(created.id, {
    prompt: "确认后继续",
    agentId: "codex-technical",
    acknowledgeRecovery: true,
  });
  const recovered = fx.orchestrator.get(created.id);
  assert.equal(recovered.status, "succeeded");
  assert.deepEqual(receivedSessionIds, [null, null], "the invalidated native thread must never be retried");
  assert.equal(recovered.sessions["codex-technical"], "fresh-thread");
});

// 「继续」循环是否真的收敛，唯一硬断言就在这里：压缩过一次之后再耗尽必须终止，不得再开窗口。
test("a second context exhaustion after compaction ends the interaction instead of compacting again", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "preview", execute: false, permissionMode: "plan" });
  const target = fx.orchestrator.adapters.get("codex-technical");
  const sessionId = "01a0178b-e92f-77c2-af6e-0762934fba1c";
  const compactCalls = [];
  let sends = 0;
  target.id = "codex-app-server";
  target.compactThread = async (threadId) => {
    compactCalls.push(threadId);
    return { sessionId: threadId, turnId: `compact-turn-${compactCalls.length}`, protocol: "app-server-v2" };
  };
  target.send = async (input) => {
    sends += 1;
    await input.onSessionStarted?.({ sessionId, protocol: "app-server-v2" });
    await input.onTurnSubmitting?.({ sessionId, protocol: "app-server-v2", clientUserMessageId: `message-${sends}` });
    await input.onTurnAccepted?.({ sessionId, protocol: "app-server-v2", clientUserMessageId: `message-${sends}`, turnId: `turn-${sends}` });
    throw Object.assign(new Error("context exhausted"), {
      code: "CONTEXT_WINDOW_EXCEEDED",
      nativeTurnSettled: true,
      requiresContextCompaction: true,
      safeToFallback: false,
      sessionId,
      protocol: "app-server-v2",
    });
  };

  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "继续", agentId: "codex-technical" }),
    { code: "RECOVERY_REQUIRED" },
  );
  assert.equal(compactCalls.length, 1, "单次交互最多压缩一次——第二次耗尽必须终止，不得再开一个压缩窗口");
  assert.equal(sends, 2, "压缩后只重试一轮");
  const blocked = fx.orchestrator.get(created.id);
  assert.equal(blocked.status, "recovery_required");
  assert.equal(blocked.interactionContextCompactions, 1);
  assert.equal(blocked.sessions["codex-technical"], undefined, "耗尽的原生线程必须作废，否则下一次「继续」原地重演");
});

// fail-closed 必须 abort-safe：压缩窗口最长 5 分钟，窗口内点中断是最高频的真实操作。
test("interrupting inside the compaction window still invalidates the exhausted native thread", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "preview", execute: false, permissionMode: "plan" });
  const target = fx.orchestrator.adapters.get("codex-technical");
  const sessionId = "01a0178b-e92f-77c2-af6e-0762934fba1c";
  const compactionEntered = deferred();
  target.id = "codex-app-server";
  target.compactThread = async (threadId, { signal } = {}) => {
    compactionEntered.resolve();
    // 真实适配器同样是"挂在压缩上、被 abort 才 reject"，这里复刻该形状
    await new Promise((_, rejectCompaction) => {
      const fail = () => rejectCompaction(Object.assign(new Error("compaction aborted"), { code: "ABORTED", sessionId: threadId }));
      if (signal?.aborted) { fail(); return; }
      signal?.addEventListener("abort", fail, { once: true });
    });
  };
  target.send = async (input) => {
    await input.onSessionStarted?.({ sessionId, protocol: "app-server-v2" });
    await input.onTurnSubmitting?.({ sessionId, protocol: "app-server-v2", clientUserMessageId: "message-1" });
    await input.onTurnAccepted?.({ sessionId, protocol: "app-server-v2", clientUserMessageId: "message-1", turnId: "turn-1" });
    throw Object.assign(new Error("context exhausted"), {
      code: "CONTEXT_WINDOW_EXCEEDED",
      nativeTurnSettled: true,
      requiresContextCompaction: true,
      safeToFallback: false,
      sessionId,
      protocol: "app-server-v2",
    });
  };

  const continuation = fx.orchestrator.continue(created.id, { prompt: "继续", agentId: "codex-technical" });
  void continuation.catch(() => {});
  await compactionEntered.promise;
  await fx.orchestrator.interrupt(created.id);
  // 中断的续聊按 interrupted/cancelled 正常收束（不抛），本条契约要照的是"线程有没有被作废"
  await continuation.catch(() => {});

  const interrupted = fx.orchestrator.get(created.id);
  assert.equal(
    interrupted.sessions["codex-technical"],
    undefined,
    "压缩窗口内的中断同样必须作废耗尽线程——否则下一次「继续」会 resume 它并再次撞满上下文",
  );
  assert.equal(interrupted.contextRecovery?.state, "failed");
  assert.equal(interrupted.invalidatedSessions.at(-1)?.sessionId, sessionId);
  assert.ok(
    fx.events.some((event) => event.type === "run.context_compaction_failed" && event.data?.sessionInvalidated === true),
    "作废动作必须留下可见事件",
  );
});

// 压缩链与自动续跑链会互相嵌套；任何一条递归漏掉 allowContextRecovery:false 都会让上限失效。
test("auto-recovered turns must not reopen the context compaction budget", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "preview", execute: false, permissionMode: "plan" });
  const target = fx.orchestrator.adapters.get("codex-technical");
  const sessionId = "01a0178b-e92f-77c2-af6e-0762934fba1c";
  let compactions = 0;
  let sends = 0;
  target.id = "codex-app-server";
  target.compactThread = async (threadId) => {
    compactions += 1;
    return { sessionId: threadId, turnId: "compact-turn", protocol: "app-server-v2" };
  };
  target.send = async (input) => {
    sends += 1;
    await input.onSessionStarted?.({ sessionId, protocol: "app-server-v2" });
    await input.onTurnSubmitting?.({ sessionId, protocol: "app-server-v2", clientUserMessageId: `message-${sends}` });
    await input.onTurnAccepted?.({ sessionId, protocol: "app-server-v2", clientUserMessageId: `message-${sends}`, turnId: `turn-${sends}` });
    if (sends === 1) {
      throw Object.assign(new Error("Codex turn silent for 300s"), {
        code: "TURN_IDLE_TIMEOUT",
        interruptConfirmed: true,
        safeToFallback: false,
        sessionId,
        protocol: "app-server-v2",
      });
    }
    throw Object.assign(new Error("context exhausted"), {
      code: "CONTEXT_WINDOW_EXCEEDED",
      nativeTurnSettled: true,
      requiresContextCompaction: true,
      safeToFallback: false,
      sessionId,
      protocol: "app-server-v2",
    });
  };

  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "继续", agentId: "codex-technical" }),
    { code: "RECOVERY_REQUIRED" },
  );
  assert.equal(sends, 2, "超时轮自动续跑一次后即遇上下文耗尽");
  assert.equal(compactions, 0, "自动续跑轮不得重新打开压缩预算——否则单次「继续」会被拉成数轮 5 分钟静默");
  assert.equal(fx.orchestrator.get(created.id).sessions["codex-technical"], undefined);
});

test("native slash command turns reach the adapter raw and flagged (Claude passthrough)", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "start", execute: true, orchestrationMode: "pipeline", permissionMode: "plan" });
  await waitTerminal(fx.orchestrator, created.id);

  await fx.orchestrator.continue(created.id, { prompt: "/compact", agentId: "claude-fable", nativeCommand: true });
  await waitTerminal(fx.orchestrator, created.id);
  const nativeCall = fx.calls.at(-1);
  assert.equal(nativeCall.prompt, "/compact", "raw command only — no attachment/declaration/persona wrapping");
  assert.equal(nativeCall.nativeCommand, true, "adapter sees the native command flag");
  assert.equal(nativeCall.compactThread, undefined);

  await fx.orchestrator.continue(created.id, { prompt: "普通续聊 /compact 只是文本", agentId: "claude-fable" });
  await waitTerminal(fx.orchestrator, created.id);
  const normalCall = fx.calls.at(-1);
  assert.equal(normalCall.nativeCommand, false);
  assert.ok(normalCall.prompt.includes("普通续聊"), "normal turns keep full prompt assembly");
});

test("Codex /compact uses compactThread instead of a prompt turn", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "start", execute: true, orchestrationMode: "pipeline", permissionMode: "plan" });
  await waitTerminal(fx.orchestrator, created.id);
  const sendsBefore = fx.calls.filter((call) => !call.compactThread).length;

  await fx.orchestrator.continue(created.id, { prompt: "/compact", agentId: "codex-technical", nativeCommand: true });
  await waitTerminal(fx.orchestrator, created.id);
  const compactCall = fx.calls.find((call) => call.compactThread && call.id === "codex-technical");
  assert.ok(compactCall, "Codex compact hook fired");
  assert.equal(compactCall.threadId, "codex-technical-session");
  assert.equal(fx.calls.filter((call) => !call.compactThread).length, sendsBefore, "compact is not sent as a prompt");
  assert.ok(fx.events.some((event) => event.type === "run.context_compaction_completed" && event.data?.operator === true));
});

test("unknown native slash commands fail closed", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "start", execute: true, orchestrationMode: "pipeline", permissionMode: "plan" });
  await waitTerminal(fx.orchestrator, created.id);
  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "/not-a-real-cli", agentId: "codex-technical", nativeCommand: true }),
    { code: "NATIVE_COMMAND_UNSUPPORTED" },
  );
});

test("native command turns reject invalid shapes at admission", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "start", execute: true, orchestrationMode: "pipeline", permissionMode: "plan" });
  await waitTerminal(fx.orchestrator, created.id);

  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "not-a-slash-command", agentId: "codex-technical", nativeCommand: true }),
    { code: "VALIDATION_FAILED" },
  );
  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "/compact leftover", agentId: "codex-technical", nativeCommand: true }),
    { code: "NATIVE_COMMAND_INVALID" },
  );
  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "/compact\n第二行走私", agentId: "codex-technical", nativeCommand: true }),
    { code: "VALIDATION_FAILED" },
  );
  const notePath = join(fx.root, "note.txt");
  await writeFile(notePath, "x", "utf8");
  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "/compact", agentId: "codex-technical", nativeCommand: true, sources: [notePath] }),
    { code: "VALIDATION_FAILED" },
  );
  const runAfter = fx.orchestrator.get(created.id);
  assert.equal(runAfter.status, "succeeded", "rejected admissions leave the run untouched");
});

test("unconfirmed Grok sessions never enter run.sessions and failed attempts settle", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const target = fx.orchestrator.adapters.get("codex-technical");
  const cases = [
    {
      label: "spawn rejected",
      code: "ENOENT",
      expectedPhase: "rejected",
      submissionRejected: true,
    },
    {
      label: "first Responses call failed",
      code: "GROK_BUILD_FAILED",
      expectedPhase: "failed",
      submissionRejected: false,
    },
  ];

  for (const [index, item] of cases.entries()) {
    const created = await fx.orchestrator.create({ prompt: `preview ${index}`, execute: false, permissionMode: "plan" });
    const tentativeSessionId = `01a0034a-771d-7b62-b97d-bf7089aaa08${index}`;
    target.send = async (input) => {
      await input.onTurnSubmitting?.({
        sessionId: null,
        tentativeSessionId,
        sessionResumable: false,
        protocol: "grok-headless-resume",
        clientUserMessageId: `grok-unconfirmed-${index}`,
      });
      throw Object.assign(new Error(item.label), {
        code: item.code,
        submissionRejected: item.submissionRejected,
        nativeTurnSettled: true,
        interruptConfirmed: true,
        sessionId: null,
        tentativeSessionId,
        sessionResumable: false,
        protocol: "grok-headless-resume",
      });
    };

    await assert.rejects(
      () => fx.orchestrator.continue(created.id, { prompt: item.label, agentId: "codex-technical" }),
      { code: item.code },
    );
    const failed = fx.orchestrator.get(created.id);
    const attempt = failed.turnAttempts.at(-1);
    assert.equal(failed.sessions["codex-technical"], undefined);
    assert.equal(attempt.phase, item.expectedPhase);
    assert.equal(attempt.sessionId, null);
    assert.equal(attempt.tentativeSessionId, tentativeSessionId);
    assert.equal(attempt.sessionResumable, false);
    assert.equal(failed.inflightTurns["codex-technical"], undefined);
  }
});

test("non-Grok lifecycle checkpoints remain resumable without the Grok marker", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "preview", execute: false, permissionMode: "plan" });
  const target = fx.orchestrator.adapters.get("codex-technical");
  const nativeSessionId = "claude-native-session";
  target.send = async (input) => {
    await input.onSessionStarted?.({ sessionId: nativeSessionId, protocol: "stream-json-resume" });
    await input.onTurnSubmitting?.({
      sessionId: nativeSessionId,
      protocol: "stream-json-resume",
      clientUserMessageId: "legacy-adapter-message",
    });
    throw Object.assign(new Error("provider failed after session creation"), {
      code: "PROVIDER_FAILED",
      sessionId: nativeSessionId,
      protocol: "stream-json-resume",
      nativeTurnSettled: true,
      interruptConfirmed: true,
    });
  };

  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "start", agentId: "codex-technical" }),
    { code: "PROVIDER_FAILED" },
  );
  const failed = fx.orchestrator.get(created.id);
  const attempt = failed.turnAttempts.at(-1);
  assert.equal(failed.sessions["codex-technical"], nativeSessionId);
  assert.notEqual(attempt.sessionResumable, false);
  assert.equal(attempt.phase, "failed");
});

test("successful Grok session confirmation stays submitting and cannot be refunded before adapter return", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "preview", execute: false, permissionMode: "plan" });
  const target = fx.orchestrator.adapters.get("codex-technical");
  const nativeSessionId = "01a0034a-771d-7b62-b97d-bf7089aaa099";
  target.send = async (input) => {
    await input.onTurnSubmitting?.({
      sessionId: null,
      tentativeSessionId: nativeSessionId,
      sessionResumable: false,
      protocol: "grok-headless-resume",
      clientUserMessageId: "grok-success-window",
    });
    await input.onTurnSubmitting?.({
      sessionId: nativeSessionId,
      tentativeSessionId: nativeSessionId,
      sessionResumable: true,
      protocol: "grok-headless-resume",
      clientUserMessageId: "grok-success-window",
    });
    throw Object.assign(new Error("simulated crash after end before adapter return"), { code: "ADAPTER_RETURN_WINDOW" });
  };

  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "start", agentId: "codex-technical" }),
    { code: "ADAPTER_RETURN_WINDOW" },
  );
  const interrupted = fx.orchestrator.get(created.id);
  const attempt = interrupted.turnAttempts.at(-1);
  assert.equal(interrupted.sessions["codex-technical"], nativeSessionId);
  assert.equal(attempt.phase, "submitting");
  assert.equal(attempt.sessionResumable, true);
  assert.equal(fx.orchestrator.canRefundAbandonedRound(interrupted), false);
});

test("default full capability marker stays neutral for an identity-only legacy roster", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "preview", execute: false, permissionMode: "plan" });
  const run = fx.orchestrator.get(created.id);
  run.teamRoster = [{
    id: "codex-technical",
    runtimeProfileId: "codex-technical",
    label: "codex-technical",
    role: "",
    description: "",
    systemPrompt: "",
    capabilities: ["*"],
    defaultModel: null,
    defaultEffort: null,
    teamMemberEligible: true,
    coordinatorEligible: true,
  }];
  run.teamRosterVersion = 0;
  assert.equal(fx.orchestrator.memberPromptForRun(run, "codex-technical"), "");
});

test("round budget cannot bypass mandatory independent verification", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  await assert.rejects(
    () => fx.orchestrator.create({ prompt: "implement", execute: true, orchestrationMode: "pipeline", maxRounds: 1, permissionMode: "plan" }),
    { code: "INSUFFICIENT_ROUNDS" },
  );
});

test("run creation reuses a persisted idempotency key and validates its wire format", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const input = {
    prompt: "idempotent automation launch",
    execute: false,
    permissionMode: "plan",
    idempotencyKey: "automation:fixture:11111111-1111-4111-8111-111111111111",
  };
  const first = await fx.orchestrator.create(input);
  const second = await fx.orchestrator.create(input);
  assert.equal(second.id, first.id);
  assert.equal(second.idempotencyKey, input.idempotencyKey);
  assert.equal(fx.orchestrator.list().length, 1);
  assert.equal(fx.events.filter((event) => event.type === "run.created").length, 1);
  await assert.rejects(
    () => fx.orchestrator.create({ ...input, idempotencyKey: "bad key with spaces" }),
    { code: "VALIDATION_FAILED" },
  );
});

test("build execution waits for approval and binds workspace-write to the selected executor", async (t) => {
  let decide;
  const decision = new Promise((resolveDecision) => { decide = resolveDecision; });
  const fx = await fixture({ approvalRequest: async () => decision });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "build" });
  assert.equal(created.status, "waiting_approval");
  await assert.rejects(() => fx.orchestrator.continue(created.id, { prompt: "bypass", agentId: "codex-technical" }), { code: "APPROVAL_REQUIRED" });
  assert.equal(fx.calls.length, 0);
  decide({ decision: "accept", approvalId: "approval-deferred" });
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.buildApproval.status, "approved");
  assert.equal(completed.buildApproval.approvalId, "approval-deferred");
  assert.equal(fx.calls.find((call) => call.id === "codex-technical").permissionMode, "workspace-write");
  assert.ok(fx.calls.filter((call) => call.id === "claude-fable").every((call) => call.permissionMode === "plan"));
  assert.equal(fx.orchestrator.buildApprovalIsValid(completed), true);
  assert.ok(fx.orchestrator.activeCapabilityLease(completed), "approved build must issue an active capability lease");
  assert.equal(completed.buildApproval.lease?.status, "active");
  assert.equal(fx.events.filter((event) => event.type === "capability.lease_issued").length, 1);
  const approvedMessage = fx.orchestrator.buildApprovalMessage(completed);
  assert.equal(approvedMessage.params.workspace, resolve(fx.root));
  assert.equal(approvedMessage.params.workspaceSource, "adapter.cwd");
  assert.equal(approvedMessage.params.isolation, "none");
  completed.cwd = join(fx.root, "different-workspace");
  assert.equal(fx.orchestrator.buildApprovalIsValid(completed), false, "changing the execution workspace invalidates approval");
  assert.equal(fx.orchestrator.activeCapabilityLease(completed), null, "invalid approval also voids lease");
  completed.cwd = null;
  assert.equal(fx.orchestrator.buildApprovalIsValid(completed), true);
  assert.ok(fx.orchestrator.activeCapabilityLease(completed));
  completed.route.selected.id = "claude-fable";
  assert.equal(fx.orchestrator.buildApprovalIsValid(completed), false);
});

// LO 2026-08-09：Codex 官方权限档（桌面批准菜单同款）。composer mode 必须映射到
// 原生 sandbox+approvalPolicy 组合 id，且只有声明预设族的 adapter（codex）能用；
// 官方语义不经过 514cc 的 build 审批/租约门，其余成员保持只读/plan。
function codexPresetFixture(extra = {}) {
  const presetPolicy = policy();
  presetPolicy.modes.ask = { write: "workspace", approvalRequired: false };
  presetPolicy.modes.auto = { write: "workspace", approvalRequired: false };
  presetPolicy.modes["full-access"] = { write: true, approvalRequired: false };
  presetPolicy.modes.config = { write: "config.toml", approvalRequired: false };
  return fixture({
    policy: presetPolicy,
    models: { profiles: [
      { id: "codex-technical", adapter: "codex-app-server" },
      { id: "claude-fable", adapter: "claude-stream-json" },
    ] },
    ...extra,
  });
}

test("Codex official presets map to native sandbox/approval combos without the 514cc build gate", async (t) => {
  let approvals = 0;
  const fx = await codexPresetFixture({
    approvalRequest: async () => { approvals += 1; return { decision: "accept", approvalId: "approval-preset" }; },
  });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const cases = [
    ["ask", "workspace-write"],
    ["auto", "workspace-write:on-failure"],
    ["full-access", "danger-full-access"],
    ["config", "config-default"],
  ];
  for (const [composerMode, nativeMode] of cases) {
    fx.calls.length = 0;
    const created = await fx.orchestrator.create({
      prompt: `preset ${composerMode}`, execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: composerMode,
    });
    const completed = await waitTerminal(fx.orchestrator, created.id);
    assert.equal(completed.status, "succeeded", `${composerMode} run must complete`);
    assert.equal(fx.calls.find((call) => call.id === "codex-technical")?.permissionMode, nativeMode, `${composerMode} native mode`);
    assert.ok(fx.calls.filter((call) => call.id === "claude-fable").every((call) => call.permissionMode === "plan"),
      `${composerMode}: 非执行拥有者保持 plan，写面不扩散`);
  }
  assert.equal(approvals, 0, "Codex 官方档不得触发 514cc build 审批门（审批发生在 Codex 层或按官方语义不询问）");
});

test("Codex official presets are rejected on adapters outside the preset family", async (t) => {
  const fx = await codexPresetFixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  for (const mode of ["ask", "auto", "full-access", "config"]) {
    await assert.rejects(
      () => fx.orchestrator.create({
        prompt: "preset on claude", execute: false, orchestrationMode: "pipeline", maxRounds: 3,
        permissionMode: mode, startAgentId: "claude-fable",
      }),
      { code: "UNSUPPORTED_PERMISSION" },
      `${mode} 不得在 claude 模板上放行——ask 原生映射与 build 同为 workspace-write，不能绕过 build 审批门`,
    );
  }
  await assert.rejects(
    () => fx.orchestrator.create({ prompt: "unknown", execute: false, permissionMode: "yolo" }),
    { code: "VALIDATION_FAILED" },
  );
});

// LO 2026-08-10：会话配置不应一刀切固化。模型（per-turn 覆盖）、Effort 与权限白名单迁移
// （降档 / Codex ask↔auto）可会话中热改、下一轮生效；Codex 沙箱轴随原生 thread 固化，不开口子。
test("hot control updates apply next turn and enforce the transition whitelist", async (t) => {
  const fx = await codexPresetFixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({
    prompt: "hot", execute: false, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "ask",
  });

  // Effort 设置 + 清除
  await fx.orchestrator.updateRunControls(created.id, { effort: "high" });
  assert.equal(fx.orchestrator.get(created.id).effortOverride, "high");
  await assert.rejects(
    () => fx.orchestrator.updateRunControls(created.id, { effort: "turbo" }),
    { code: "INVALID_EFFORT" },
  );
  await fx.orchestrator.updateRunControls(created.id, { effort: "ultra" });
  assert.equal(fx.orchestrator.get(created.id).effortOverride, "ultra");
  await fx.orchestrator.updateRunControls(created.id, { effort: "" });
  assert.equal(fx.orchestrator.get(created.id).effortOverride, null);

  // 权限白名单：ask↔auto 放行（同 sandbox，只动 turn 级 approvalPolicy）
  await fx.orchestrator.updateRunControls(created.id, { permissionMode: "auto" });
  assert.equal(fx.orchestrator.get(created.id).permissionMode, "auto");
  await fx.orchestrator.updateRunControls(created.id, { permissionMode: "ask" });
  assert.equal(fx.orchestrator.get(created.id).permissionMode, "ask");
  // 沙箱轴变动 / 跨族 / 升档一律拒绝并如实说明
  for (const target of ["full-access", "config", "review", "plan", "build"]) {
    await assert.rejects(
      () => fx.orchestrator.updateRunControls(created.id, { permissionMode: target }),
      { code: "CONTROL_TRANSITION_FORBIDDEN" },
      `ask → ${target} 不得热改`,
    );
  }
  // 同档幂等：不产生变更事件
  const eventsBefore = fx.events.filter((event) => event.type === "run.control_changed").length;
  await fx.orchestrator.updateRunControls(created.id, { permissionMode: "ask", effort: "" });
  assert.equal(fx.events.filter((event) => event.type === "run.control_changed").length, eventsBefore);

  // 热改后的下一轮派工使用新值（模型经 0.146.0 实测：turn/start 接受 per-turn 覆盖）
  await fx.orchestrator.updateRunControls(created.id, { effort: "high", permissionMode: "auto", model: "gpt-5.5" });
  assert.equal(fx.orchestrator.get(created.id).modelOverride, "gpt-5.5");
  await assert.rejects(
    () => fx.orchestrator.updateRunControls(created.id, { model: "not a model!" }),
    { code: "INVALID_MODEL" },
  );
  fx.calls.length = 0;
  await fx.orchestrator.continue(created.id, { prompt: "go" });
  const codexCall = fx.calls.find((call) => call.id === "codex-technical");
  assert.equal(codexCall.permissionMode, "workspace-write:on-failure", "下一轮必须用上热切后的原生档");
  assert.equal(codexCall.effort, "high", "下一轮必须用上热改的 Effort");
  assert.equal(codexCall.model, "gpt-5.5", "下一轮必须用上热改的模型");
  const controlEvents = fx.events.filter((event) => event.type === "run.control_changed");
  assert.ok(controlEvents.length >= 1, "热改必须落审计事件");
  assert.deepEqual(controlEvents.at(-1).data.changes, [
    { field: "model", from: null, to: "gpt-5.5" },
    { field: "effort", from: null, to: "high" },
    { field: "permissionMode", from: "ask", to: "auto" },
  ]);
});

test("514cc permission downgrades are hot-switchable, upgrades stay creation-gated", async (t) => {
  let approvals = 0;
  const fx = await codexPresetFixture({
    approvalRequest: async () => { approvals += 1; return { decision: "accept", approvalId: "approval-downgrade" }; },
  });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({
    prompt: "build then downgrade", execute: false, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "build",
  });
  const approvalsAtCreation = approvals;
  // 降档链：build→review→plan 全部放行，无需审批
  await fx.orchestrator.updateRunControls(created.id, { permissionMode: "review" });
  assert.equal(fx.orchestrator.get(created.id).permissionMode, "review");
  await fx.orchestrator.updateRunControls(created.id, { permissionMode: "plan" });
  assert.equal(fx.orchestrator.get(created.id).permissionMode, "plan");
  assert.equal(approvals, approvalsAtCreation, "降档不得触发审批门");
  // 升档（plan→review/build）与跨族（plan→ask）拒绝
  for (const target of ["review", "build", "ask"]) {
    await assert.rejects(
      () => fx.orchestrator.updateRunControls(created.id, { permissionMode: target }),
      { code: "CONTROL_TRANSITION_FORBIDDEN" },
      `plan → ${target} 不得热改`,
    );
  }
  // 降档后下一轮只读
  fx.calls.length = 0;
  await fx.orchestrator.continue(created.id, { prompt: "read only now" });
  assert.ok(fx.calls.every((call) => ["plan", "read-only"].includes(call.permissionMode)), "降档后任何成员不得拿写档");
});

// T2：grok 原生审批档透传（native:*）——permissionOverride 创建与热改同源校验，
// 仅执行拥有者拿到 native 值，写面不扩散；非法值/未声明模板一律 fail-closed。
function grokNativeFixture(extra = {}) {
  return fixture({
    models: { profiles: [
      { id: "grok-build", adapter: "grok-build-headless" },
      { id: "claude-fable", adapter: "claude-stream-json" },
    ] },
    extraAdapterIds: ["grok-build"],
    ...extra,
  });
}

test("native permission overrides validate against the template and reach only the execution owner", async (t) => {
  const fx = await grokNativeFixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({
    prompt: "native auto", execute: true, orchestrationMode: "pipeline", maxRounds: 3,
    permissionMode: "plan", permission: "native:auto", requestedProvider: "grok-build",
  });
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.permissionOverride, "native:auto");
  const grokCall = fx.calls.find((call) => call.id === "grok-build");
  assert.equal(grokCall?.nativeApprovalMode, "native:auto", "执行拥有者必须拿到原生透传档");
  assert.ok(fx.calls.filter((call) => call.id !== "grok-build").every((call) => call.nativeApprovalMode === null),
    "非执行拥有者不得拿原生透传档，写面不扩散");
  // fail-closed：未知值与未声明模板在创建时即拒绝并回报原因
  await assert.rejects(
    () => fx.orchestrator.create({ prompt: "bad value", execute: false, permission: "native:yolo", requestedProvider: "grok-build" }),
    { code: "INVALID_PERMISSION" },
  );
  await assert.rejects(
    () => fx.orchestrator.create({ prompt: "bad on claude", execute: false, permission: "native:auto", startAgentId: "claude-fable" }),
    { code: "INVALID_PERMISSION" },
    "claude 模板未声明 native:*，不得放行",
  );
});

test("native permission override hot-update uses the same validation and applies next turn", async (t) => {
  const fx = await grokNativeFixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({
    prompt: "hot native", execute: true, orchestrationMode: "pipeline", maxRounds: 3,
    permissionMode: "plan", requestedProvider: "grok-build",
  });
  await waitTerminal(fx.orchestrator, created.id);
  // 首次设置（无值）允许任意白名单档 + 非法值拒绝（与创建路径一致）
  await fx.orchestrator.updateRunControls(created.id, { permission: "native:always-approve" });
  assert.equal(fx.orchestrator.get(created.id).permissionOverride, "native:always-approve");
  await assert.rejects(
    () => fx.orchestrator.updateRunControls(created.id, { permission: "native:turbo" }),
    { code: "INVALID_PERMISSION" },
  );
  assert.equal(fx.orchestrator.get(created.id).permissionOverride, "native:always-approve", "非法热改不得改掉原值");
  // 降档链通过：always-approve → acceptEdits → auto（写面收缩，不触发审批门）
  await fx.orchestrator.updateRunControls(created.id, { permission: "native:acceptEdits" });
  assert.equal(fx.orchestrator.get(created.id).permissionOverride, "native:acceptEdits");
  await fx.orchestrator.updateRunControls(created.id, { permission: "native:auto" });
  assert.equal(fx.orchestrator.get(created.id).permissionOverride, "native:auto");
  // 升档被拒：已有值只允许同级保持/降档/清除，服务端与前端降档表同源把守，不得经 API 绕开审批门升档
  for (const target of ["native:acceptEdits", "native:always-approve"]) {
    await assert.rejects(
      () => fx.orchestrator.updateRunControls(created.id, { permission: target }),
      { code: "CONTROL_TRANSITION_FORBIDDEN" },
      `native:auto → ${target} 不得热改`,
    );
  }
  assert.equal(fx.orchestrator.get(created.id).permissionOverride, "native:auto", "升档被拒不得改掉原值");
  // 清除通过：空串回席位默认（收缩到底，永远放行）
  await fx.orchestrator.updateRunControls(created.id, { permission: "" });
  assert.equal(fx.orchestrator.get(created.id).permissionOverride, null);
  // 热改后的下一轮派工使用新值（清除后再设 = 首次设置，任意白名单档放行）
  await fx.orchestrator.updateRunControls(created.id, { permission: "native:always-approve" });
  fx.calls.length = 0;
  await fx.orchestrator.continue(created.id, { prompt: "go" });
  const grokCall = fx.calls.find((call) => call.id === "grok-build");
  assert.equal(grokCall?.nativeApprovalMode, "native:always-approve", "下一轮必须用上热改后的原生档");
  await fx.orchestrator.updateRunControls(created.id, { permission: "" });
  assert.equal(fx.orchestrator.get(created.id).permissionOverride, null);
});

test("hot control gates mirror continuation admission: approval-pending and recovery block, idle allows", async (t) => {
  let decide;
  const decision = new Promise((resolveDecision) => { decide = resolveDecision; });
  const fx = await fixture({ approvalRequest: async () => decision });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  // 审批待决：改动会污染动作绑定审批语义，拒绝
  const pending = await fx.orchestrator.create({
    prompt: "approval pending", execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "build",
  });
  assert.equal(pending.status, "waiting_approval");
  await assert.rejects(
    () => fx.orchestrator.updateRunControls(pending.id, { permissionMode: "review" }),
    { code: "APPROVAL_REQUIRED" },
  );
  decide({ decision: "accept", approvalId: "approval-gate" });
  await waitTerminal(fx.orchestrator, pending.id);
  // succeeded 的闲置会话可热改（续聊场景正是两轮之间），下一轮生效
  const idle = fx.orchestrator.get(pending.id);
  assert.equal(idle.status, "succeeded");
  await fx.orchestrator.updateRunControls(pending.id, { permissionMode: "plan", effort: "low" });
  assert.equal(fx.orchestrator.get(pending.id).permissionMode, "plan");
  assert.equal(fx.orchestrator.get(pending.id).effortOverride, "low");
  // 恢复未确认：提交状态不明，拒绝
  idle.status = "recovery_required";
  idle.inflightTurns = { "codex-technical": { round: 1, phase: "submitted" } };
  await assert.rejects(
    () => fx.orchestrator.updateRunControls(pending.id, { effort: "high" }),
    { code: "RECOVERY_REQUIRED" },
  );
  // 确认携带但校验失败：必须整体回滚——claim 不能白白作废、状态不能半翻页
  await assert.rejects(
    () => fx.orchestrator.updateRunControls(pending.id, { effort: "turbo" }, { acknowledgeRecovery: true }),
    { code: "INVALID_EFFORT" },
  );
  const rolledBack = fx.orchestrator.get(pending.id);
  assert.equal(rolledBack.status, "recovery_required", "校验失败后必须回滚到 recovery_required");
  assert.ok(rolledBack.inflightTurns["codex-technical"], "校验失败后 inflight 记账必须回滚");
  // 确认随热改一次性携带：原子完成"放弃 claim + 改档"，停在可续聊的闲置终态
  await fx.orchestrator.updateRunControls(pending.id, { effort: "high" }, { acknowledgeRecovery: true });
  const acked = fx.orchestrator.get(pending.id);
  assert.equal(acked.status, "failed", "确认后不跑轮：停在 failed 闲置终态");
  assert.equal(acked.effortOverride, "high");
  assert.deepEqual(acked.inflightTurns, {}, "确认后 inflight 记账必须作废");
  assert.ok(acked.recoveryAcknowledgedAt, "确认时间必须落账");
  assert.ok(
    fx.events.some((event) => event.type === "run.recovery_acknowledged"),
    "确认恢复必须落审计事件——热改路径不静默",
  );
  assert.ok(
    fx.events.some((event) => event.type === "run.control_changed"
      && event.data.changes.some((change) => change.field === "effort" && change.to === "high")),
    "热改本身仍落 control_changed 审计",
  );
  // 确认后状态已翻页：再热改不再需要 acknowledgeRecovery
  await fx.orchestrator.updateRunControls(pending.id, { effort: "low" });
  assert.equal(fx.orchestrator.get(pending.id).effortOverride, "low");
});

test("capability lease can be revoked mid-run and blocks workspace-write", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "build" });
  const completed = await waitTerminal(fx.orchestrator, created.id);
  const lease = fx.orchestrator.activeCapabilityLease(completed);
  assert.ok(lease, "build approval path must issue active lease");
  assert.equal(lease.status, "active");
  assert.equal(lease.actionSha256, completed.buildApproval.actionSha256);
  // 吊销租约本身（不依赖 turn 生命周期）
  const revoked = await fx.orchestrator.revokeCapabilityLeaseForRun(completed.id, {
    reason: "operator-revoke",
    actor: "test-operator",
  });
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.revokedBy, "test-operator");
  assert.equal(fx.orchestrator.activeCapabilityLease(completed), null);
  assert.ok(fx.events.some((event) => event.type === "capability.lease_revoked"));
  // 过期语义：伪造 expiresAt 也应使 activeCapabilityLease 返回 null
  completed.buildApproval.lease = {
    ...lease,
    status: "active",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  };
  assert.equal(fx.orchestrator.activeCapabilityLease(completed), null);
  assert.equal(completed.buildApproval.lease.status, "expired");
});

test("taskGraph records social delegations and cancel marks edges cancelled", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const run = await fx.orchestrator.create({ prompt: "route graph", execute: false, permissionMode: "plan" });
  fx.orchestrator.recordTaskGraphDelegation(run, {
    fromAgentId: "claude-fable",
    toAgentId: "codex-technical",
    busMessageId: "bus-msg-1",
    kind: "route",
    state: "queued",
  });
  await fx.orchestrator.save(run);
  const reloaded = fx.orchestrator.get(run.id);
  assert.equal(reloaded.taskGraph.delegations.length, 1);
  assert.equal(reloaded.taskGraph.delegations[0].toAgentId, "codex-technical");
  assert.ok(reloaded.taskGraph.tasks.some((item) => item.kind === "attempt" && item.assigneeId === "codex-technical"));
  const cancelled = await fx.orchestrator.cancel(run.id);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.taskGraph.delegations.every((edge) => edge.state === "cancelled"));
  assert.ok(cancelled.taskGraph.tasks.every((task) => ["cancelled", "succeeded", "failed"].includes(task.status)));
});

test("taskGraph binds target attempts and converges attempt and root lifecycle states", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const run = await fx.orchestrator.create({ prompt: "lifecycle graph", execute: false, permissionMode: "plan" });
  run.status = "waiting_agent";
  const phases = ["prepared", "completed", "failed", "ambiguous"];
  for (const [index, phase] of phases.entries()) {
    const busMessageId = `bus-lifecycle-${index}`;
    fx.orchestrator.recordTaskGraphDelegation(run, {
      fromAgentId: "claude-fable",
      toAgentId: "codex-technical",
      busMessageId,
    });
    run.turnAttempts.push({
      attemptId: `attempt-lifecycle-${index}`,
      agentId: "codex-technical",
      phase,
      sourceBusMessageId: busMessageId,
    });
  }
  await fx.orchestrator.save(run);

  const expected = [
    ["running", "running"],
    ["succeeded", "completed"],
    ["failed", "failed"],
    ["recovery_required", "ambiguous"],
  ];
  phases.forEach((_, index) => {
    const busMessageId = `bus-lifecycle-${index}`;
    const task = run.taskGraph.tasks.find((item) => item.busMessageId === busMessageId);
    const edge = run.taskGraph.delegations.find((item) => item.busMessageId === busMessageId);
    assert.deepEqual([task.status, edge.state], expected[index]);
    assert.equal(task.attemptId, `attempt-lifecycle-${index}`);
    assert.equal(edge.targetAttemptId, `attempt-lifecycle-${index}`);
  });

  run.status = "succeeded";
  await fx.orchestrator.save(run);
  assert.equal(run.taskGraph.tasks.find((item) => item.kind === "root").status, "succeeded");
  assert.equal(run.taskGraph.tasks.find((item) => item.busMessageId === "bus-lifecycle-0").status, "skipped");
  assert.equal(run.taskGraph.delegations.find((item) => item.busMessageId === "bus-lifecycle-0").state, "skipped");

  run.status = "failed";
  await fx.orchestrator.save(run);
  assert.equal(run.taskGraph.tasks.find((item) => item.kind === "root").status, "failed");
});

test("social delegation enforces real multi-hop depth before provider dispatch", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const team = {
    id: "team-depth",
    name: "Depth Team",
    coordinator: "claude-fable",
    members: ["claude-fable", "codex-technical", "grok-build"],
    skills: [],
  };
  fx.orchestrator.teams = {
    get(id) {
      if (id !== team.id) throw Object.assign(new Error("team not found"), { code: "SOURCE_NOT_FOUND" });
      return team;
    },
    brief() { return "Depth Team"; },
  };
  const calls = new Map();
  const responseForAgent = {
    "claude-fable": (count) => count === 1 ? "[[msg:codex-technical]] depth one" : "final synthesis",
    "codex-technical": () => "[[msg:grok-build]] depth two",
    "grok-build": () => "[[msg:claude-fable]] depth three must be rejected",
  };
  for (const agentId of team.members) {
    fx.orchestrator.adapters.set(agentId, {
      cwd: fx.root,
      async send(input) {
        const count = (calls.get(agentId) || 0) + 1;
        calls.set(agentId, count);
        await input.onSessionStarted?.({ sessionId: `${agentId}-session`, protocol: `${agentId}-mock` });
        await input.onTurnSubmitting?.({ sessionId: `${agentId}-session`, protocol: `${agentId}-mock`, clientUserMessageId: `${agentId}-message-${count}` });
        await input.onTurnAccepted?.({ sessionId: `${agentId}-session`, protocol: `${agentId}-mock`, clientUserMessageId: `${agentId}-message-${count}`, turnId: `${agentId}-turn-${count}` });
        return { sessionId: `${agentId}-session`, text: responseForAgent[agentId](count), protocol: `${agentId}-mock`, tokens: 10, costUsd: 0.001 };
      },
      async close() {},
    });
  }

  const created = await fx.orchestrator.create({
    prompt: "prove delegation depth",
    execute: true,
    teamId: team.id,
    orchestrationMode: "social",
    delegationDepthLimit: 2,
    maxRounds: 6,
    permissionMode: "plan",
  });
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "succeeded");
  assert.deepEqual(completed.taskGraph.delegations.map((edge) => edge.depth), [1, 2, 3]);
  const rejected = completed.taskGraph.delegations.find((edge) => edge.depth === 3);
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.depthLimitReached, true);
  assert.equal(rejected.limit, 2);
  assert.equal(completed.turnAttempts.some((attempt) => attempt.sourceBusMessageId === rejected.busMessageId), false);
  assert.equal(completed.resumeQueue.length, 0);
  assert.ok(completed.taskGraph.tasks.some((task) => task.busMessageId === rejected.busMessageId && task.status === "blocked"));
  const bus = await fx.orchestrator.bus.read(completed.id);
  assert.ok(bus.some((message) => message.kind === "system" && message.text.includes("委派深度上限 2")));
});

test("heterogeneous resume hints stay provider-native", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const run = await fx.orchestrator.create({ prompt: "resume map", execute: false });
  run.sessions = {
    "claude-fable": "claude-sess-1",
    "codex-technical": "codex-sess-1",
  };
  // mock adapter ids so resumeHints can classify
  fx.orchestrator.adapters.get("claude-fable").id = "claude-stream-json";
  fx.orchestrator.adapters.get("codex-technical").id = "codex-exec-json";
  const hints = fx.orchestrator.resumeHintsForRun(run);
  assert.equal(hints.length, 2);
  const claude = hints.find((item) => item.agentId === "claude-fable");
  const codex = hints.find((item) => item.agentId === "codex-technical");
  assert.equal(claude.canResume, true);
  assert.match(claude.command, /claude -r /);
  assert.equal(codex.canResume, true);
  assert.match(codex.command, /codex resume /);
  assert.notEqual(claude.command, codex.command);
});

test("interactiveCliSpecForRun returns a spawnable interactive resume spec", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const run = await fx.orchestrator.create({ prompt: "handoff map", execute: false, cwd: fx.root });
  run.sessions = { "claude-fable": "claude-sess-1", "kimi-frontend": "kimi-sess-9" };
  fx.orchestrator.adapters.get("claude-fable").id = "claude-stream-json";
  fx.orchestrator.adapters.get("claude-fable").command = "claude";
  fx.orchestrator.adapters.get("codex-technical").id = "codex-app-server";

  // 无指定成员：执行所有者（codex-technical）没有原生会话 → 回落到第一个有会话的成员
  const ownerSpec = fx.orchestrator.interactiveCliSpecForRun(run);
  assert.equal(ownerSpec.agentId, "claude-fable");
  assert.equal(ownerSpec.command, "claude");
  assert.deepEqual(ownerSpec.args, ["-r", "claude-sess-1"]);
  assert.equal(ownerSpec.cwd, fx.root);
  assert.equal(ownerSpec.protocol, "claude-stream-json");

  // 显式指定成员：用该成员的原生会话
  const claudeSpec = fx.orchestrator.interactiveCliSpecForRun(run, "claude-fable");
  assert.equal(claudeSpec.agentId, "claude-fable");
  assert.equal(claudeSpec.command, "claude");
  assert.deepEqual(claudeSpec.args, ["-r", "claude-sess-1"]);

  // Codex 交互接续必须是 TUI `codex resume <uuid>`，不能走无交互的 `exec resume`
  const shared = fx.orchestrator.adapters.get("codex-technical");
  shared.id = "codex-app-server";
  shared.command = "codex";
  run.sessions = { "codex-technical": "rollout-2026-07-17T09-21-00-019f0000-0000-7000-8000-000000000000.jsonl" };
  const codexSpec = fx.orchestrator.interactiveCliSpecForRun(run);
  assert.equal(codexSpec.command, "codex");
  assert.deepEqual(codexSpec.args, ["resume", "019f0000-0000-7000-8000-000000000000"]);
  run.sessions = { "codex-technical": "019f0000-0000-7000-8000-000000000000" };
  assert.deepEqual(fx.orchestrator.interactiveCliSpecForRun(run).args, ["resume", "019f0000-0000-7000-8000-000000000000"]);

  // OpenCode / Pi 席位同样有交互接续特征（TUI --session / --session-id，均经 --help 实证）
  shared.id = "opencode-run-json";
  shared.command = "opencode";
  run.sessions = { "codex-technical": "ses_opencode_1" };
  const opencodeSpec = fx.orchestrator.interactiveCliSpecForRun(run);
  assert.equal(opencodeSpec.command, "opencode");
  assert.deepEqual(opencodeSpec.args, ["--session", "ses_opencode_1"]);
  shared.id = "pi-rpc";
  shared.command = "pi";
  run.sessions = { "codex-technical": "019f0000-0000-7000-8000-000000000000" };
  const piSpec = fx.orchestrator.interactiveCliSpecForRun(run);
  assert.equal(piSpec.command, "pi");
  assert.deepEqual(piSpec.args, ["--session-id", "019f0000-0000-7000-8000-000000000000"]);

  // 没有任何已验证 resume 特征的成员全部跳过 → null（调用方如实报不支持）
  run.sessions = { "kimi-frontend": "kimi-sess-9" }; // fixture 无该席位 adapter → 无 resume 特征
  assert.equal(fx.orchestrator.interactiveCliSpecForRun(run), null);
});

test("interactiveCliSpecsForRun lists every resumable member spec, execution owner first", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const run = await fx.orchestrator.create({ prompt: "handoff members", execute: false, cwd: fx.root });
  fx.orchestrator.adapters.get("claude-fable").id = "claude-stream-json";
  fx.orchestrator.adapters.get("claude-fable").command = "claude";
  const owner = fx.orchestrator.adapters.get("codex-technical");
  owner.id = "opencode-run-json";
  owner.command = "opencode";
  run.sessions = {
    "claude-fable": "claude-sess-1",
    "codex-technical": "ses_opencode_1",
    "kimi-frontend": "kimi-sess-9", // fixture 无该席位 adapter → 不具接续特征，跳过
  };
  const specs = fx.orchestrator.interactiveCliSpecsForRun(run);
  // 执行所有者（codex-technical）排最前；无 adapter 特征的成员不进清单
  assert.deepEqual(specs.map((spec) => spec.agentId), ["codex-technical", "claude-fable"]);
  assert.equal(specs[0].command, "opencode");
  assert.deepEqual(specs[0].args, ["--session", "ses_opencode_1"]);
  assert.equal(specs[1].command, "claude");
  assert.deepEqual(specs[1].args, ["-r", "claude-sess-1"]);
  // 单数入口语义不变：显式成员不具接续特征时回落全成员清单第一条（执行所有者）
  assert.equal(fx.orchestrator.interactiveCliSpecForRun(run, "kimi-frontend").agentId, "codex-technical");
  // 严格模式（罩层成员页签点名）：点名落空如实 null，不静默回落到别人的会话
  assert.equal(fx.orchestrator.interactiveCliSpecForRun(run, "kimi-frontend", { strict: true }), null);
  assert.equal(fx.orchestrator.interactiveCliSpecForRun(run, "claude-fable", { strict: true }).agentId, "claude-fable");
  // 全无可接续成员 → 空数组
  run.sessions = { "kimi-frontend": "kimi-sess-9" };
  assert.deepEqual(fx.orchestrator.interactiveCliSpecsForRun(run), []);
});

test("dry-run build metadata cannot grant workspace-write through continue", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: false, permissionMode: "build" });
  await fx.orchestrator.continue(created.id, { prompt: "inspect", agentId: "codex-technical" });
  assert.equal(fx.calls.length, 1);
  assert.equal(fx.calls[0].permissionMode, "read-only");
});

test("review permission mode is accepted without approval and stays non-writing", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({
    prompt: "deep review current tree",
    execute: true,
    orchestrationMode: "pipeline",
    maxRounds: 3,
    permissionMode: "review",
  });
  assert.equal(created.permissionMode, "review");
  assert.equal(created.buildApproval, null);
  assert.notEqual(created.status, "waiting_approval");
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "succeeded");
  assert.ok(fx.calls.length >= 1);
  assert.ok(fx.calls.every((call) => call.permissionMode === "read-only"), "Review must reach every Adapter as native read-only");
});

test("an explicit active member is both the capability-validated route and build owner", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({
    prompt: "coordinator-owned build",
    execute: true,
    orchestrationMode: "pipeline",
    maxRounds: 3,
    permissionMode: "build",
    startAgentId: "claude-fable",
  });
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.route.selected.id, "claude-fable");
  assert.equal(completed.startAgentId, "claude-fable");
  assert.equal(completed.executionOwnerId, "claude-fable");
  assert.equal(fx.calls[0].id, "claude-fable");
  assert.equal(fx.calls[0].permissionMode, "workspace-write");
  assert.equal(fx.calls.some((call) => call.id === "codex-technical" && call.permissionMode === "workspace-write"), false);
  const approval = fx.orchestrator.buildApprovalMessage(completed).params;
  assert.equal(approval.executionOwnerId, "claude-fable");
  assert.equal(approval.routeSelectedAgent, "claude-fable");
});

test("an explicit active member fails closed when the router returns a different runtime", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  fx.orchestrator.router.preview = async () => route("codex-technical");

  await assert.rejects(() => fx.orchestrator.create({
    prompt: "router must not split validation from execution",
    execute: true,
    orchestrationMode: "pipeline",
    maxRounds: 3,
    permissionMode: "build",
    startAgentId: "claude-fable",
  }), {
    code: "TRANSACTION_INCONSISTENT",
    expectedRuntimeProfileId: "claude-fable",
    actualRuntimeProfileId: "codex-technical",
  });
  assert.equal(fx.calls.length, 0);
});

test("source continuation counts unique paths at the 16-item boundary", async (t) => {
  const fx = await fixture({
    models: { profiles: [{ id: "codex-technical", capabilities: ["image-analysis"] }] },
  });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({
    prompt: "legacy source boundary",
    execute: false,
    startAgentId: "codex-technical",
  });
  const legacyImage = resolve(fx.root, "legacy.png");
  const existingPaths = [
    legacyImage,
    ...Array.from({ length: 14 }, (_, index) => resolve(fx.root, `existing-${index}.md`)),
  ];
  const live = fx.orchestrator.get(created.id);
  live.sources = normalizeRunSources(existingPaths);
  await fx.orchestrator.save(live);

  const newSource = resolve(fx.root, "new-source.md");
  const merged = await fx.orchestrator.addSources(created.id, [legacyImage, newSource], { targetAgentId: "codex-technical" });
  assert.equal(merged.sources.length, 16);
  assert.equal(merged.sources.at(-1).path, newSource);

  const duplicateOnly = await fx.orchestrator.addSources(created.id, [legacyImage], { targetAgentId: "codex-technical" });
  assert.equal(duplicateOnly.sources.length, 16, "an existing visual source must remain a no-op at the cap");
  await assert.rejects(
    () => fx.orchestrator.addSources(created.id, [resolve(fx.root, "seventeenth.md")], { targetAgentId: "codex-technical" }),
    { code: "VALIDATION_FAILED" },
  );
  assert.equal(fx.orchestrator.get(created.id).sources.length, 16);
});

test("attachments are scoped to the user interaction instead of being replayed on every later turn", async (t) => {
  const fx = await fixture({
    models: { profiles: [{ id: "codex-technical", capabilities: ["image-analysis"] }] },
  });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, startAgentId: "codex-technical" });
  const firstImage = resolve(fx.root, "first.png");
  const secondImage = resolve(fx.root, "second.png");

  await fx.orchestrator.continue(created.id, { prompt: "看第一张", agentId: "codex-technical", sources: [firstImage] });
  assert.match(fx.calls.at(-1).prompt, new RegExp(firstImage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await fx.orchestrator.continue(created.id, { prompt: "看第二张", agentId: "codex-technical", sources: [secondImage] });
  assert.match(fx.calls.at(-1).prompt, new RegExp(secondImage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(fx.calls.at(-1).prompt, new RegExp(firstImage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await fx.orchestrator.continue(created.id, { prompt: "纯文字继续", agentId: "codex-technical" });
  assert.doesNotMatch(fx.calls.at(-1).prompt, /first\.png|second\.png/);
  const done = fx.orchestrator.get(created.id);
  assert.deepEqual(done.sources.map((source) => source.path), [firstImage, secondImage], "全局附件台账仍须保留供历史与生命周期保护");
  assert.deepEqual(done.activeInteractionSources, []);
  assert.deepEqual(done.pendingInteractionSources, []);

  // 同一路径已在全局台账中时，重新附加仍必须绑定到下一条消息。
  await fx.orchestrator.continue(created.id, { prompt: "重新看第一张", agentId: "codex-technical", sources: [firstImage] });
  assert.match(fx.calls.at(-1).prompt, /first\.png/);
  assert.equal(done.sources.length, 2, "重新引用不得复制全局台账条目");
});

test("visual attachments follow the requested member without capability subset checks", async (t) => {
  const fx = await fixture({
    models: {
      profiles: [
        { id: "codex-technical", capabilities: [] },
        { id: "claude-fable", capabilities: [] },
      ],
    },
  });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false });
  const image = resolve(fx.root, "default-full-capability.png");

  await fx.orchestrator.continue(created.id, {
    prompt: "交给当前成员处理图片",
    agentId: "claude-fable",
    sources: [image],
  });
  assert.equal(fx.calls.at(-1).id, "claude-fable");
  assert.match(fx.calls.at(-1).prompt, /default-full-capability\.png/);
});

test("source staging needs no target and non-PNG formats stay scoped to one interaction", async (t) => {
  const fx = await fixture({
    models: { profiles: [{ id: "codex-technical", capabilities: [] }] },
  });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, startAgentId: "codex-technical" });
  const webp = resolve(fx.root, "format-not-prejudged.webp");

  await fx.orchestrator.addSources(created.id, [webp]);
  assert.deepEqual(fx.orchestrator.get(created.id).pendingInteractionSources.map((source) => source.path), [webp]);
  await fx.orchestrator.continue(created.id, { prompt: "处理预存附件", agentId: "codex-technical" });
  assert.match(fx.calls.at(-1).prompt, /format-not-prejudged\.webp/);

  await fx.orchestrator.continue(created.id, { prompt: "纯文字继续", agentId: "codex-technical" });
  assert.doesNotMatch(fx.calls.at(-1).prompt, /format-not-prejudged\.webp/);
});

test("attachment registration rolls back both the global ledger and next-interaction queue when persistence fails", async (t) => {
  const fx = await fixture({
    models: { profiles: [{ id: "codex-technical", capabilities: ["image-analysis"] }] },
  });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, startAgentId: "codex-technical" });
  const imagePath = resolve(fx.root, "rollback.png");
  const originalSave = fx.orchestrator.save.bind(fx.orchestrator);
  fx.orchestrator.save = async () => {
    throw Object.assign(new Error("disk unavailable"), { code: "EIO" });
  };

  await assert.rejects(
    () => fx.orchestrator.addSources(created.id, [imagePath], { targetAgentId: "codex-technical" }),
    { code: "EIO" },
  );
  const rolledBack = fx.orchestrator.get(created.id);
  assert.deepEqual(rolledBack.sources, []);
  assert.deepEqual(rolledBack.pendingInteractionSources, []);

  fx.orchestrator.save = originalSave;
  await fx.orchestrator.addSources(created.id, [imagePath], { targetAgentId: "codex-technical" });
  assert.deepEqual(rolledBack.sources.map((source) => source.path), [imagePath]);
  assert.deepEqual(rolledBack.pendingInteractionSources.map((source) => source.path), [imagePath]);
});

test("attachments added during an active turn stay bound to their own queued steers", async (t) => {
  const fx = await fixture({
    models: { profiles: [{ id: "codex-technical", capabilities: ["image-analysis"] }] },
  });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, startAgentId: "codex-technical" });
  const paths = [1, 2, 3].map((index) => resolve(fx.root, `queued-${index}.png`));
  const target = fx.orchestrator.adapters.get("codex-technical");
  const originalSend = target.send.bind(target);
  const entered = deferred();
  const release = deferred();
  let first = true;
  target.send = async (input) => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return originalSend(input);
  };

  const active = fx.orchestrator.continue(created.id, { prompt: "第一条", agentId: "codex-technical", sources: [paths[0]] });
  await entered.promise;
  await fx.orchestrator.continue(created.id, { prompt: "第二条", agentId: "codex-technical", sources: [paths[1]] });
  await fx.orchestrator.continue(created.id, { prompt: "第三条", agentId: "codex-technical", sources: [paths[2]] });
  release.resolve();
  await active;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (fx.orchestrator.controllers.has(created.id) || fx.orchestrator.executions.size)) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }

  assert.equal(fx.calls.length, 3);
  for (let index = 0; index < 3; index += 1) {
    assert.match(fx.calls[index].prompt, new RegExp(`queued-${index + 1}\\.png`));
    for (let other = 0; other < 3; other += 1) {
      if (other !== index) assert.doesNotMatch(fx.calls[index].prompt, new RegExp(`queued-${other + 1}\\.png`));
    }
  }
});

test("a pipeline steer image never contaminates the original topology interaction", async (t) => {
  const fx = await fixture({
    models: { profiles: [{ id: "codex-technical", capabilities: ["image-analysis"] }] },
  });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const initialImage = resolve(fx.root, "pipeline-initial.png");
  const steerImage = resolve(fx.root, "pipeline-steer.png");
  const claude = fx.orchestrator.adapters.get("claude-fable");
  const originalClaudeSend = claude.send.bind(claude);
  const entered = deferred();
  const release = deferred();
  let first = true;
  claude.send = async (input) => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return originalClaudeSend(input);
  };

  const created = await fx.orchestrator.create({
    prompt: "pipeline 主任务",
    execute: true,
    orchestrationMode: "pipeline",
    collaborationMode: "standard",
    maxRounds: 6,
    permissionMode: "plan",
    startAgentId: "codex-technical",
    sources: [initialImage],
  });
  await entered.promise;
  await fx.orchestrator.continue(created.id, {
    prompt: "只处理这条图片插话",
    agentId: "codex-technical",
    sources: [steerImage],
  });
  release.resolve();
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "succeeded", completed.error);

  const steerCalls = fx.calls.filter((call) => call.prompt.includes(steerImage));
  assert.equal(steerCalls.length, 1, "插话图片只能进入插话自己的 provider turn");
  assert.match(steerCalls[0].prompt, /只处理这条图片插话/);
  assert.doesNotMatch(steerCalls[0].prompt, /pipeline-initial\.png/);
  const topologyCalls = fx.calls.filter((call) => call !== steerCalls[0]);
  assert.ok(topologyCalls.length >= 3, `原拓扑调用不足：${topologyCalls.length}`);
  for (const call of topologyCalls) assert.doesNotMatch(call.prompt, /pipeline-steer\.png/);
  assert.ok(topologyCalls.some((call) => call.prompt.includes(initialImage)), "原拓扑没有恢复初始附件");
  assert.deepEqual(completed.activeInteractionSources.map((source) => source.path), [initialImage]);
  assert.ok(completed.interactionStep >= 3, "原拓扑的 step 账本被插话 interaction 覆盖");
  const steerState = Object.values(completed.interactionStates || {}).find((state) =>
    state.sources?.some((source) => source.path === steerImage));
  assert.equal(steerState?.interactionStep, 1);
});

test("an explicit start member cannot route-check a different provider", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  await assert.rejects(() => fx.orchestrator.create({
    prompt: "must not validate Codex and execute Claude",
    execute: false,
    permissionMode: "plan",
    startAgentId: "claude-fable",
    requestedProvider: "codex-technical",
  }), { code: "VALIDATION_FAILED" });
  assert.equal(fx.calls.length, 0);
  assert.equal(fx.orchestrator.list().length, 0);
});

test("unknown permission modes fail closed while omission still defaults to build", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  await assert.rejects(() => fx.orchestrator.create({
    prompt: "must reject unknown permission",
    execute: false,
    permissionMode: "superuser",
  }), { code: "VALIDATION_FAILED" });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false });
  assert.equal(created.permissionMode, "build");
});

// LO 2026-08-14 决策（协作台对话逻辑报障）：续聊的写权限**沿用建 run 时批过的授权**，
// 由 capability lease 界定有效范围——lease 本来就是「时间窗 + 动作哈希 + 可吊销」的持续
// 授权凭据，UI 也一直在展示「执行租约有效 / 到期时间」。
// 本用例原先断言的是相反语义（"an approved build grant is not reused by a later manual
// continuation"，终止后续聊恒为只读）。那条语义的实际后果是：LO 说「请你继续执行」，执行
// 所有者只拿到只读，只能反复回「请确认是否要我立即执行」，指令与权限两端一起锁死（run
// d63b839d 第 3–6 轮）。改后仍然守住授权窗口的两面——窗口开着能写，窗口一关立刻回落只读。
test("终止后的手动续聊受租约界定：租约有效沿用写权限，吊销后立刻回落只读", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "build" });
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "succeeded");
  // 等收尾窗口关闭（terminal 置位后 controller 释放前 continue 会按设计排队而非直接执行）
  while (fx.orchestrator.controllers.has(created.id)) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  }
  const continued = await fx.orchestrator.continue(created.id, { prompt: "inspect the result", agentId: "codex-technical" });
  assert.equal(continued.status, "succeeded");
  assert.equal(fx.calls.at(-1).permissionMode, "workspace-write", "租约仍有效的续聊被降级为只读");
  // 授权窗口关上 = 立刻失去写权限（这是本用例真正要守的安全边界）
  const live = fx.orchestrator.get(created.id);
  fx.orchestrator.revokeCapabilityLease(live, "test-revocation");
  await fx.orchestrator.save(live);
  while (fx.orchestrator.controllers.has(created.id)) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  }
  await fx.orchestrator.continue(created.id, { prompt: "inspect again", agentId: "codex-technical" });
  assert.equal(fx.calls.at(-1).permissionMode, "read-only", "租约吊销后仍在写盘");
  assert.ok(fx.events.some((event) => event.type === "run.write_degraded" && event.data.reason === "CAPABILITY_LEASE_INACTIVE"));
});

test("an ambiguous Codex transport failure never replays the prompt through fallback", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  let fallbackCalls = 0;
  fx.orchestrator.adapters.get("codex-technical").send = async () => {
    throw Object.assign(new Error("transport closed after submit"), {
      code: "APP_SERVER_EXIT",
      safeToFallback: false,
      codexPhase: "turn-submitted-or-unknown",
      clientUserMessageId: "client-message-1",
    });
  };
  fx.orchestrator.adapters.get("codex-technical-fallback").send = async () => {
    fallbackCalls += 1;
    return { sessionId: "fallback", text: "duplicate", protocol: "fallback" };
  };
  const created = await fx.orchestrator.create({ prompt: "implement once", execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "plan" });
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "recovery_required");
  assert.equal(fallbackCalls, 0);
  assert.match(completed.error, /transport closed/);
});

test("a confirmed-interrupted read-only timeout auto-continues natively instead of gating", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  let codexCalls = 0;
  const seen = [];
  fx.orchestrator.adapters.get("codex-technical").send = async (input) => {
    codexCalls += 1;
    seen.push({ sessionId: input.sessionId, prompt: input.prompt });
    await input.onSessionStarted?.({ sessionId: "codex-session", protocol: "mock" });
    await input.onTurnSubmitting?.({ sessionId: "codex-session", protocol: "mock", clientUserMessageId: `m-${codexCalls}` });
    await input.onTurnAccepted?.({ sessionId: "codex-session", protocol: "mock", clientUserMessageId: `m-${codexCalls}`, turnId: `t-${codexCalls}` });
    if (codexCalls === 1) {
      throw Object.assign(new Error("Codex turn timed out"), {
        code: "TURN_TIMEOUT",
        safeToFallback: false,
        interruptConfirmed: true,
        sessionId: "codex-session",
        codexPhase: "turn-submitted-or-unknown",
      });
    }
    return { sessionId: "codex-session", text: "recovered-final", protocol: "mock", tokens: 5, costUsd: 0.01 };
  };
  const created = await fx.orchestrator.create({ prompt: "deep investigation", execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "plan" });
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(codexCalls, 2, "失败轮自动原生续跑一次，不进人工闸");
  assert.equal(seen[1].sessionId, "codex-session", "续跑必须回到同一个原生会话");
  assert.match(seen[1].prompt, /自动恢复/, "续跑用续接指令而不是原 prompt 盲重放");
  assert.equal(completed.autoRecoveries, 1);
  const codexAttempts = completed.turnAttempts.filter((attempt) => attempt.agentId === "codex-technical");
  assert.deepEqual(codexAttempts.map((attempt) => attempt.phase), ["failed", "completed"]);
  assert.equal(codexAttempts[1].round, codexAttempts[0].round + 1, "自动续跑必须消耗一个新的持久化 round");
  assert.equal(completed.result.specialist, "recovered-final");
  assert.equal(completed.result.truncated, true, "恢复用尽轮次后必须如实标记独立复核未执行");
  assert.equal(completed.result.critique, null);
  assert.ok(fx.events.some((event) => event.type === "run.auto_recovery" && event.data.count === 1));
  assert.ok(!fx.events.some((event) => event.type === "adapter.replay_blocked"), "自动续跑成功时不产生阻断事件");
});

test("known failed-turn cost reaches the interaction cap before automatic recovery", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  let codexCalls = 0;
  fx.orchestrator.adapters.get("codex-technical").send = async (input) => {
    codexCalls += 1;
    await input.onSessionStarted?.({ sessionId: "budget-session", protocol: "mock" });
    await input.onTurnSubmitting?.({ sessionId: "budget-session", protocol: "mock", clientUserMessageId: "budget-message" });
    await input.onTurnAccepted?.({ sessionId: "budget-session", protocol: "mock", clientUserMessageId: "budget-message", turnId: "budget-turn" });
    throw Object.assign(new Error("timeout after reaching the interaction budget"), {
      code: "TURN_TIMEOUT",
      safeToFallback: false,
      interruptConfirmed: true,
      sessionId: "budget-session",
      codexPhase: "turn-submitted-or-unknown",
      costUsd: 0.15,
      tokens: 9,
    });
  };
  const created = await fx.orchestrator.create({
    prompt: "bounded investigation",
    execute: true,
    orchestrationMode: "pipeline",
    maxRounds: 3,
    maxBudgetUsdPerTurn: 0.05,
    permissionMode: "plan",
  });
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "failed");
  assert.equal(codexCalls, 1, "known failed-turn cost at the cap must block the automatic continuation");
  assert.equal(completed.interactionCostUsd, 0.16, "协调员规划轮的已知成本也必须计入 interaction 闸");
  assert.equal(completed.costUsdTotal, 0.16);
  assert.equal(completed.turnAttempts.at(-1).failureCostUsd, 0.15);
  assert.equal(completed.turnAttempts.at(-1).failureTokens, 9);
  assert.equal(completed.autoRecoveries ?? 0, 0);
  assert.equal(completed.interactionAutoRecoveries ?? 0, 0);
  assert.equal(fx.events.filter((event) => event.type === "run.auto_recovery").length, 0);
  const exhausted = fx.events.find((event) => event.type === "run.budget_exhausted");
  assert.equal(exhausted?.data.source, "failed-turn");
  assert.equal(exhausted?.data.interactionCostUsd, 0.16);
});

test("known primary failure cost reaches the interaction cap before fallback dispatch", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({
    prompt: "route only",
    execute: false,
    permissionMode: "plan",
    maxBudgetUsdPerTurn: 0.05, // 预算合同下限 0.05（resolveBudgetUsdPerTurn floor）
  });
  const primary = fx.orchestrator.adapters.get("codex-technical");
  const fallback = fx.orchestrator.adapters.get("codex-technical-fallback");
  let fallbackCalls = 0;
  primary.send = async () => {
    throw Object.assign(new Error("billable app server exit"), {
      code: "APP_SERVER_EXIT",
      safeToFallback: true,
      costUsd: 0.31,
      tokens: 11,
    });
  };
  fallback.send = async () => {
    fallbackCalls += 1;
    return { sessionId: "must-not-run", text: "unexpected", protocol: "mock" };
  };

  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "bounded fallback", agentId: "codex-technical" }),
    { code: "APP_SERVER_EXIT" },
  );
  const failed = fx.orchestrator.get(created.id);
  assert.equal(fallbackCalls, 0);
  assert.equal(failed.costUsdTotal, 0.31);
  assert.equal(failed.interactionCostUsd, 0.31);
  assert.equal(failed.turnAttempts.at(-1).failureCostUsd, 0.31);
  assert.equal(failed.turnAttempts.at(-1).failureTokens, 11);
  assert.equal(fx.events.filter((event) => event.type === "adapter.fallback").length, 0);
  const exhausted = fx.events.find((event) => event.type === "run.budget_exhausted");
  assert.equal(exhausted?.data.source, "failed-turn-fallback");
  assert.equal(exhausted?.data.interactionCostUsd, 0.31);
});

test("an unconfirmed-interrupt timeout keeps the strict manual recovery gate", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  let codexCalls = 0;
  fx.orchestrator.adapters.get("codex-technical").send = async () => {
    codexCalls += 1;
    throw Object.assign(new Error("Codex turn timed out"), {
      code: "TURN_TIMEOUT",
      safeToFallback: false,
      interruptConfirmed: false,
      sessionId: "codex-session",
      codexPhase: "turn-submitted-or-unknown",
    });
  };
  const created = await fx.orchestrator.create({ prompt: "investigate", execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "plan" });
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "recovery_required");
  assert.equal(codexCalls, 1, "打断未确认 = 原生轮可能仍活着，绝不自动续跑");
  assert.equal(completed.autoRecoveries ?? 0, 0);
  assert.match(completed.recoveryNote, /may still own a native turn/, "未确认时保持严格文案");
  const blocked = fx.events.find((event) => event.type === "adapter.replay_blocked");
  assert.ok(blocked);
  assert.equal(blocked.data.interruptConfirmed, false);
  assert.ok(!fx.events.some((event) => event.type === "run.auto_recovery"));
});

test("a failed auto-continuation falls back to the graded manual gate", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  let codexCalls = 0;
  fx.orchestrator.adapters.get("codex-technical").send = async () => {
    codexCalls += 1;
    throw Object.assign(new Error("Codex turn timed out"), {
      code: "TURN_TIMEOUT",
      safeToFallback: false,
      interruptConfirmed: true,
      sessionId: "codex-session",
      codexPhase: "turn-submitted-or-unknown",
    });
  };
  const created = await fx.orchestrator.create({ prompt: "investigate twice", execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "plan" });
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "recovery_required");
  assert.equal(codexCalls, 2, "一次失败最多自动续跑一次：续跑失败直接交人工，不递归白烧");
  assert.equal(completed.autoRecoveries, 1);
  const failedAttempts = completed.turnAttempts.filter((attempt) => attempt.agentId === "codex-technical");
  assert.deepEqual(failedAttempts.map((attempt) => attempt.round), [2, 3], "两次可能触达 provider 的派发必须占用两个不同 round");
  assert.match(completed.recoveryNote, /confirmed interrupted/, "已确认打断的文案如实降级，不再谎称可能有活跃占用");
  assert.equal(fx.events.filter((event) => event.type === "run.auto_recovery").length, 1);
  assert.equal(fx.events.filter((event) => event.type === "adapter.replay_blocked").length, 1);
});

test("autoRecoveryDecision gates on timeout family, confirmation, mode, session and cap", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const orchestrator = fx.orchestrator;
  const run = {
    sessions: { "codex-technical": "thread-1" },
    maxRounds: 6,
    maxStepsPerInteraction: 6,
    interactionStep: 0,
    interactionAutoRecoveries: 0,
  };
  const confirmedTimeout = Object.assign(new Error("timeout"), { code: "TURN_TIMEOUT", interruptConfirmed: true, sessionId: "thread-1" });
  assert.equal(orchestrator.autoRecoveryDecision(run, "codex-technical", confirmedTimeout, "read-only").ok, true);
  assert.equal(orchestrator.autoRecoveryDecision(run, "codex-technical", confirmedTimeout, "plan").ok, true);
  assert.equal(
    orchestrator.autoRecoveryDecision(run, "codex-technical", Object.assign(new Error("limit"), { code: "OUTPUT_LIMIT", interruptConfirmed: true }), "read-only").reason,
    "not-a-timeout",
  );
  assert.equal(
    orchestrator.autoRecoveryDecision(run, "codex-technical", Object.assign(new Error("timeout"), { code: "TURN_IDLE_TIMEOUT", interruptConfirmed: false }), "read-only").reason,
    "interrupt-unconfirmed",
  );
  assert.equal(orchestrator.autoRecoveryDecision(run, "codex-technical", confirmedTimeout, "workspace-write").reason, "write-turn");
  assert.equal(
    orchestrator.autoRecoveryDecision({ ...run, sessions: {} }, "codex-technical", Object.assign(new Error("timeout"), { code: "TURN_TIMEOUT", interruptConfirmed: true }), "read-only").reason,
    "no-native-session",
  );
  assert.equal(orchestrator.autoRecoveryDecision({ ...run, interactionAutoRecoveries: 2 }, "codex-technical", confirmedTimeout, "read-only").reason, "cap-exhausted");
  assert.equal(
    orchestrator.autoRecoveryDecision({ ...run, round: 99, interactionStep: 6 }, "codex-technical", confirmedTimeout, "read-only").reason,
    "step-limit",
  );
  assert.equal(
    orchestrator.autoRecoveryDecision({ ...run, round: 99, interactionStep: 0 }, "codex-technical", confirmedTimeout, "read-only").ok,
    true,
    "全会话 round 只做单调审计，不得封死新交互",
  );
});

test("a pre-submit Codex setup failure may use the explicit read-only fallback", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  let fallbackCalls = 0;
  fx.orchestrator.adapters.get("codex-technical").send = async () => {
    throw Object.assign(new Error("app-server missing"), { code: "ENOENT", safeToFallback: true, codexPhase: "session-setup" });
  };
  fx.orchestrator.adapters.get("codex-technical-fallback").send = async () => {
    fallbackCalls += 1;
    return { sessionId: "fallback", text: "verified", protocol: "fallback" };
  };
  const created = await fx.orchestrator.create({ prompt: "implement", execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "plan" });
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(fallbackCalls, 1);
});

test("a failed durable checkpoint prevents the adapter from submitting the prompt", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, permissionMode: "plan" });
  let submitted = false;
  fx.orchestrator.adapters.get("codex-technical").send = async (input) => {
    await input.onSessionStarted({ sessionId: "checkpoint-session", protocol: "mock" });
    await input.onTurnSubmitting({ sessionId: "checkpoint-session", protocol: "mock", clientUserMessageId: "checkpoint-message" });
    submitted = true;
    return { sessionId: "checkpoint-session", text: "should not happen", protocol: "mock" };
  };
  const save = fx.orchestrator.save.bind(fx.orchestrator);
  fx.orchestrator.save = async (run) => {
    if ((run.turnAttempts || []).some((attempt) => attempt.phase === "submitting")) throw new Error("checkpoint volume unavailable");
    return save(run);
  };
  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "inspect", agentId: "codex-technical" }),
    /checkpoint volume unavailable/,
  );
  assert.equal(submitted, false);
});

test("restart marks a submitted native turn as recovery-required and blocks blind continuation", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, permissionMode: "plan" });
  const run = fx.orchestrator.get(created.id);
  run.status = "waiting_agent";
  run.turnAttempts = [{ attemptId: "a1", round: 1, agentId: "codex-technical", phase: "submitted", sessionId: "thread-1" }];
  await fx.orchestrator.save(run);
  await fx.orchestrator.close();
  const restarted = await new Orchestrator({
    router: { preview: async () => route() },
    adapters: new Map(),
    eventStore: { emit: async () => {} },
    dataRoot: fx.root,
    policy: policy(),
    approvalBroker: { denyRun: async () => {} },
  }).init();
  assert.equal(restarted.get(created.id).status, "recovery_required");
  await assert.rejects(
    () => restarted.continue(created.id, { prompt: "replay", agentId: "codex-technical" }),
    { code: "RECOVERY_REQUIRED" },
  );
});

test("clearFinished removes terminal runs and their files but keeps active and recovery runs", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const mk = async (id, status) => fx.orchestrator.save({ id, status, prompt: "t", createdAt: new Date().toISOString(), route: route() });
  await mk("done-1", "succeeded");
  await mk("done-2", "failed");
  await mk("done-3", "cancelled");
  await mk("live-1", "waiting_agent");
  await mk("stuck-1", "recovery_required");
  const result = await fx.orchestrator.clearFinished();
  assert.equal(result.cleared, 3);
  const ids = fx.orchestrator.list().map((run) => run.id).sort();
  assert.deepEqual(ids, ["live-1", "stuck-1"], "active and recovery runs survive");
  const files = (await readdir(join(fx.root, "runs"))).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(files, ["live-1.json", "stuck-1.json"], "terminal run files removed from disk");
});

test("session cwd: rejects relative, missing and file paths; accepts a real directory", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  await assert.rejects(
    () => fx.orchestrator.create({ prompt: "p", execute: false, cwd: "relative/path" }),
    { code: "INVALID_CWD" },
  );
  await assert.rejects(
    () => fx.orchestrator.create({ prompt: "p", execute: false, cwd: resolve(fx.root, "does-not-exist") }),
    { code: "INVALID_CWD" },
  );
  const { writeFile: wf } = await import("node:fs/promises");
  const filePath = resolve(fx.root, "a-file.txt");
  await wf(filePath, "x", "utf8");
  await assert.rejects(
    () => fx.orchestrator.create({ prompt: "p", execute: false, cwd: filePath }),
    { code: "INVALID_CWD" },
  );
  const ok = await fx.orchestrator.create({ prompt: "p", execute: false, cwd: fx.root });
  assert.equal(ok.cwd, fx.root, "valid directory is persisted on the run");
  const none = await fx.orchestrator.create({ prompt: "p", execute: false });
  assert.equal(none.cwd, null, "omitted cwd stays null (repoRoot default)");
});

test("steer during an active execution queues and auto-injects at the next turn boundary", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  // 门闩阻塞主脑第一轮：run 保持活跃，期间的 continue 只能排队，不得打断子进程
  let releaseFirstTurn;
  const firstTurnGate = new Promise((resolveGate) => { releaseFirstTurn = resolveGate; });
  let markFirstTurnEntered;
  const firstTurnEntered = new Promise((resolveEnter) => { markFirstTurnEntered = resolveEnter; });
  const fable = fx.orchestrator.adapters.get("claude-fable");
  const originalSend = fable.send.bind(fable);
  let first = true;
  fable.send = async (input) => {
    if (first) {
      first = false;
      markFirstTurnEntered();
      await firstTurnGate;
    }
    return originalSend(input);
  };
  const created = await fx.orchestrator.create({ prompt: "implement", execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "plan" });
  await firstTurnEntered;
  const queued = await fx.orchestrator.continue(created.id, { prompt: "插话：记得保留证据" });
  assert.equal(queued.pendingSteer.length, 1, "活跃 run 的 continue 进队列而不是抛 RUN_ACTIVE");
  assert.equal(queued.pendingSteer[0].prompt, "插话：记得保留证据");
  assert.equal(fx.calls.length, 0, "排队不得打断进行中的第一轮（turn 原子性）");
  assert.equal(fx.events.filter((event) => event.type === "user.message").length, 0, "排队时不发 user.message——注入时才发，避免重复气泡");
  assert.ok(fx.events.some((event) => event.type === "run.steer_queued" && event.data.text === "插话：记得保留证据"));
  releaseFirstTurn();
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "succeeded");
  assert.deepEqual(completed.pendingSteer, [], "注入后队列清空并持久化");
  // 拓扑：plan(fable) -> specialist(codex) -> critique(fable)；未显式指定成员的
  // legacy continue 仍绑定持久化 execution owner，不得偷偷回退到 coordinator。
  assert.equal(fx.calls.length, 4);
  assert.match(fx.calls[0].prompt, /规划阶段/);
  assert.equal(created.executionOwnerId, "codex-technical");
  assert.equal(fx.calls[1].id, created.executionOwnerId);
  assert.equal(fx.calls[1].prompt, "插话：记得保留证据");
  assert.equal(fx.calls[2].id, "codex-technical");
  const userMessages = fx.events.filter((event) => event.type === "user.message" && event.data.text === "插话：记得保留证据");
  assert.equal(userMessages.length, 1, "注入前先发一条 user.message 让前端可见");
});

test("steers queued during an active continuation drain in FIFO order after the turn", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, permissionMode: "plan" });
  // 门闩阻塞续聊那一轮：续聊活跃期间两条插话排队，本轮结束后后台 driver 逐条排干
  let releaseTurn;
  const gate = new Promise((resolveGate) => { releaseTurn = resolveGate; });
  let markEntered;
  const turnEntered = new Promise((resolveEnter) => { markEntered = resolveEnter; });
  const codex = fx.orchestrator.adapters.get("codex-technical");
  const originalSend = codex.send.bind(codex);
  let first = true;
  codex.send = async (input) => {
    if (first) {
      first = false;
      markEntered();
      await gate;
    }
    return originalSend(input);
  };
  const continuing = fx.orchestrator.continue(created.id, { prompt: "第一轮追问", agentId: "codex-technical" });
  await turnEntered;
  await fx.orchestrator.continue(created.id, { prompt: "插话一", agentId: "codex-technical" });
  await fx.orchestrator.continue(created.id, { prompt: "插话二", agentId: "codex-technical" });
  assert.deepEqual(
    fx.orchestrator.get(created.id).pendingSteer.map((steer) => steer.prompt),
    ["插话一", "插话二"],
    "两条插话按到达顺序排队",
  );
  releaseTurn();
  await continuing; // HTTP 语义：本请求只等自己那轮，不等排干
  // 排干是后台 driver：等到队列清空且 driver 释放 controller（收尾 save 完成）再断言终态
  const deadline = Date.now() + 5_000;
  let done = fx.orchestrator.get(created.id);
  while (Date.now() < deadline && ((done.pendingSteer || []).length || fx.orchestrator.controllers.has(created.id))) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
    done = fx.orchestrator.get(created.id);
  }
  assert.deepEqual(done.pendingSteer, []);
  assert.equal(done.status, "succeeded");
  assert.deepEqual(fx.calls.map((call) => call.prompt), ["第一轮追问", "插话一", "插话二"], "FIFO 顺序自动排干");
});

test("continue on an inactive run is unchanged: immediate turn, no queue, no steer events", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, permissionMode: "plan" });
  const continued = await fx.orchestrator.continue(created.id, { prompt: "inspect", agentId: "codex-technical" });
  assert.equal(continued.status, "succeeded");
  assert.equal(fx.calls.length, 1);
  assert.equal(fx.calls[0].prompt, "inspect");
  assert.equal(continued.pendingSteer, undefined, "非活跃续聊不产生排队字段");
  assert.ok(!fx.events.some((event) => event.type === "run.steer_queued"));
  assert.equal(fx.events.filter((event) => event.type === "user.message").length, 1, "既有路径照旧先发 user.message");
});

test("two direct continuations cannot overwrite the run controller or execution owner", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, permissionMode: "plan" });
  const codex = fx.orchestrator.adapters.get("codex-technical");
  const originalCodexSend = codex.send.bind(codex);
  const entered = deferred();
  const release = deferred();
  codex.send = async (input) => {
    entered.resolve();
    await release.promise;
    return originalCodexSend(input);
  };

  const first = fx.orchestrator.continue(created.id, { prompt: "第一条慢续聊", agentId: "codex-technical" });
  const firstController = fx.orchestrator.controllers.get(created.id);
  const firstExecution = fx.orchestrator.executions.get(`continue:${created.id}`);
  assert.ok(firstController);
  assert.ok(firstExecution);
  await entered.promise;

  const second = await fx.orchestrator.continue(created.id, { prompt: "第二条并发续聊", agentId: "claude-fable" });
  assert.equal(fx.orchestrator.controllers.get(created.id), firstController, "第二条续聊覆盖了第一条 controller");
  assert.equal(fx.orchestrator.executions.get(`continue:${created.id}`), firstExecution, "第二条续聊覆盖了第一条 execution owner");
  assert.deepEqual(second.pendingSteer.map((item) => item.prompt), ["第二条并发续聊"]);

  release.resolve();
  await first;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (fx.orchestrator.controllers.has(created.id) || fx.orchestrator.executions.size)) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  const done = fx.orchestrator.get(created.id);
  assert.equal(done.status, "succeeded", done.error);
  assert.deepEqual(done.pendingSteer, []);
  assert.deepEqual(fx.calls.map((call) => [call.id, call.prompt]), [
    ["codex-technical", "第一条慢续聊"],
    ["claude-fable", "第二条并发续聊"],
  ]);
  assert.equal(fx.orchestrator.controllers.has(created.id), false);
  assert.equal(fx.orchestrator.executions.has(`continue:${created.id}`), false);
});

test("a legacy 6/6 run migrates on the next message instead of permanently blocking the conversation", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "legacy route only", execute: false, permissionMode: "plan" });
  const run = fx.orchestrator.get(created.id);
  run.status = "succeeded";
  run.round = 6;
  run.maxRounds = 6;
  for (const field of [
    "maxStepsPerInteraction", "interactionSeq", "activeInteractionId", "activeInteractionSeq",
    "interactionStep", "interactionCostUsd", "interactionStepsRefunded", "interactionAutoRecoveries",
    "interactionStartedAt", "refundedAttemptIds",
  ]) delete run[field];
  await fx.orchestrator.save(run);

  const continued = await fx.orchestrator.continue(created.id, { prompt: "第七条消息", agentId: "codex-technical" });
  assert.equal(continued.status, "succeeded");
  assert.equal(continued.round, 7);
  assert.equal(continued.maxStepsPerInteraction, 6);
  assert.equal(continued.interactionSeq, 2);
  assert.equal(continued.interactionStep, 1, "新消息不继承旧会话已经消耗的六轮");
});

test("more than six sequential user messages remain valid while every message resets the autonomous step budget", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, permissionMode: "plan" });
  const interactionIds = [];
  for (let index = 1; index <= 8; index += 1) {
    const continued = await fx.orchestrator.continue(created.id, { prompt: `消息${index}`, agentId: "codex-technical" });
    interactionIds.push(continued.activeInteractionId);
    assert.equal(continued.interactionStep, 1, `消息${index} 没有获得独立 step 预算`);
  }
  const done = fx.orchestrator.get(created.id);
  assert.equal(done.round, 8);
  assert.equal(done.interactionSeq, 9, "初始目标 + 8 条续聊应形成 9 次用户交互");
  assert.equal(new Set(interactionIds).size, 8);
  assert.ok(!fx.events.some((event) => event.type === "run.steer_dropped"));
});

test("queued steers are unbounded across the conversation and each receives an independent interaction budget", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, permissionMode: "plan" });
  // 门闩阻塞续聊轮，再排入 7 条插话。maxRounds=6 只限制每条消息内部的自主步骤，
  // 不得把第 7/8 条用户消息当成超额工作丢弃。
  let releaseTurn;
  const gate = new Promise((resolveGate) => { releaseTurn = resolveGate; });
  let markEntered;
  const turnEntered = new Promise((resolveEnter) => { markEntered = resolveEnter; });
  const codex = fx.orchestrator.adapters.get("codex-technical");
  const originalSend = codex.send.bind(codex);
  let first = true;
  codex.send = async (input) => {
    if (first) {
      first = false;
      markEntered();
      await gate;
    }
    return originalSend(input);
  };
  const continuing = fx.orchestrator.continue(created.id, { prompt: "第一轮追问", agentId: "codex-technical" });
  await turnEntered;
  for (let index = 1; index <= 7; index += 1) {
    await fx.orchestrator.continue(created.id, { prompt: `插话${index}`, agentId: "codex-technical" });
  }
  releaseTurn();
  await continuing;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && fx.orchestrator.controllers.has(created.id)) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  const done = fx.orchestrator.get(created.id);
  assert.equal(done.status, "succeeded");
  assert.equal(done.round, 8, "全局轮次只记录 8 次真实 provider 派发");
  assert.equal(fx.calls.length, 8, "续聊 1 条和排队 7 条必须全部消费");
  assert.deepEqual(done.pendingSteer, []);
  assert.deepEqual(fx.calls.map((call) => call.prompt), [
    "第一轮追问", "插话1", "插话2", "插话3", "插话4", "插话5", "插话6", "插话7",
  ]);
  const dropped = fx.events.filter((event) => event.type === "run.steer_dropped");
  assert.equal(dropped.length, 0);
  const interactions = fx.events
    .filter((event) => event.type === "user.message")
    .map((event) => event.data.interactionId);
  assert.equal(new Set(interactions).size, 8, "每条用户消息必须拥有独立 interactionId");
  assert.equal(done.interactionStep, 1, "最后一条消息使用自己的 step 预算，而不是继承累计轮数");
});

test("interrupt stops only the active provider turn and preserves the session, authorization and queued conversation", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, permissionMode: "plan" });
  const target = fx.orchestrator.adapters.get("codex-technical");
  const successfulSend = target.send.bind(target);
  const entered = deferred();
  target.send = async (input) => {
    fx.calls.push({ id: "codex-technical", ...input });
    await input.onSessionStarted?.({ sessionId: "preserved-session", protocol: "mock" });
    await input.onTurnSubmitting?.({ sessionId: "preserved-session", protocol: "mock", clientUserMessageId: "interrupt-message" });
    await input.onTurnAccepted?.({ sessionId: "preserved-session", protocol: "mock", clientUserMessageId: "interrupt-message", turnId: "interrupt-turn" });
    entered.resolve();
    await new Promise((resolveTurn, rejectTurn) => {
      const rejectAbort = () => rejectTurn(Object.assign(new Error("turn interrupted"), {
        code: "ABORTED",
        interruptConfirmed: true,
        nativeTurnSettled: true,
      }));
      if (input.signal.aborted) rejectAbort();
      else input.signal.addEventListener("abort", rejectAbort, { once: true });
    });
  };

  const active = fx.orchestrator.continue(created.id, { prompt: "长任务", agentId: "codex-technical" });
  await entered.promise;
  const live = fx.orchestrator.get(created.id);
  live.buildApproval = {
    status: "approved",
    approvalId: "approval-preserved",
    lease: { id: "lease-preserved", status: "active", expiresAt: "2099-01-01T00:00:00.000Z" },
  };
  live.worktreePath = "I:\\sentinel-worktree";
  await fx.orchestrator.continue(created.id, { prompt: "排队插话", agentId: "codex-technical" });

  const interrupted = await fx.orchestrator.interrupt(created.id);
  await active;
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.sessions["codex-technical"], "preserved-session");
  assert.equal(interrupted.buildApproval.status, "approved");
  assert.equal(interrupted.buildApproval.lease.status, "active");
  assert.equal(interrupted.worktreePath, "I:\\sentinel-worktree");
  assert.deepEqual(interrupted.pendingSteer.map((item) => item.prompt), ["排队插话"]);
  assert.equal(interrupted.turnAttempts.at(-1).phase, "interrupted");

  target.send = successfulSend;
  await fx.orchestrator.continue(created.id, { prompt: "中断后继续", agentId: "codex-technical" });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (fx.orchestrator.controllers.has(created.id) || fx.orchestrator.executions.size)) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  const resumed = fx.orchestrator.get(created.id);
  assert.equal(resumed.status, "succeeded");
  assert.deepEqual(resumed.pendingSteer, []);
  assert.deepEqual(fx.calls.slice(-2).map((call) => call.prompt), ["中断后继续", "排队插话"]);
});

test("cancel terminates the whole task and rejects every later continuation", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, permissionMode: "plan" });
  const live = fx.orchestrator.get(created.id);
  live.buildApproval = {
    status: "approved",
    approvalId: "approval-to-revoke",
    lease: { id: "lease-to-revoke", status: "active", expiresAt: "2099-01-01T00:00:00.000Z" },
  };

  const cancelled = await fx.orchestrator.cancel(created.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.buildApproval.status, "revoked");
  assert.equal(cancelled.buildApproval.lease.status, "revoked");
  await assert.rejects(
    fx.orchestrator.continue(created.id, { prompt: "不得复活", agentId: "codex-technical" }),
    { code: "RUN_TERMINAL" },
  );
  assert.equal(fx.calls.length, 0);
});

test("interrupt timeout keeps the admission gate closed until the native execution actually settles", async (t) => {
  const fx = await fixture({ interruptTimeoutMs: 20 });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, permissionMode: "plan" });
  const target = fx.orchestrator.adapters.get("codex-technical");
  const entered = deferred();
  const release = deferred();
  target.send = async (input) => {
    await input.onSessionStarted?.({ sessionId: "slow-stop-session", protocol: "mock" });
    await input.onTurnSubmitting?.({ sessionId: "slow-stop-session", protocol: "mock", clientUserMessageId: "slow-message" });
    await input.onTurnAccepted?.({ sessionId: "slow-stop-session", protocol: "mock", clientUserMessageId: "slow-message", turnId: "slow-turn" });
    entered.resolve();
    await release.promise; // 故意忽略 abort，模拟原生进程迟迟不确认退出
    return { sessionId: "slow-stop-session", text: "late", protocol: "mock" };
  };

  const active = fx.orchestrator.continue(created.id, { prompt: "无法立即停下", agentId: "codex-technical" });
  await entered.promise;
  const timedOut = await fx.orchestrator.interrupt(created.id);
  assert.equal(timedOut.status, "recovery_required");
  assert.match(timedOut.error, /20 ms/);
  await assert.rejects(
    fx.orchestrator.continue(created.id, { prompt: "不得并发", agentId: "codex-technical", acknowledgeRecovery: true }),
    { code: "RUN_INTERRUPTING" },
  );
  release.resolve();
  await active;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && fx.orchestrator.interruptingRuns.has(created.id)) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  assert.equal(fx.orchestrator.interruptingRuns.has(created.id), false);
  assert.ok(fx.events.some((event) => event.type === "run.interrupt_timeout"));
});

test("cancel wins over a concurrent interrupt and late provider settlement cannot revive the run", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, permissionMode: "plan" });
  const entered = deferred();
  const release = deferred();
  fx.orchestrator.adapters.get("codex-technical").send = async (input) => {
    await input.onSessionStarted?.({ sessionId: "cancel-wins-session", protocol: "mock" });
    await input.onTurnSubmitting?.({ sessionId: "cancel-wins-session", protocol: "mock", clientUserMessageId: "cancel-wins-message" });
    await input.onTurnAccepted?.({ sessionId: "cancel-wins-session", protocol: "mock", clientUserMessageId: "cancel-wins-message", turnId: "cancel-wins-turn" });
    entered.resolve();
    await release.promise; // 故意忽略 abort，制造 interrupt/cancel 后的迟到 settlement
    return { sessionId: "cancel-wins-session", text: "late", protocol: "mock" };
  };

  const active = fx.orchestrator.continue(created.id, { prompt: "长任务", agentId: "codex-technical" });
  await entered.promise;
  await fx.orchestrator.continue(created.id, { prompt: "取消后不得消费的插话", agentId: "codex-technical" });
  const live = fx.orchestrator.get(created.id);
  live.pendingInteractionSources = normalizeRunSources([resolve(fx.root, "cancel-pending.png")]);
  await fx.orchestrator.save(live);

  const interrupting = fx.orchestrator.interrupt(created.id);
  const cancelled = await fx.orchestrator.cancel(created.id);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.pendingSteer, []);
  assert.deepEqual(cancelled.pendingInteractionSources, []);

  release.resolve();
  await Promise.allSettled([active, interrupting]);
  const done = fx.orchestrator.get(created.id);
  assert.equal(done.status, "cancelled");
  assert.equal(done.result?.interrupted, undefined);
  assert.equal(fx.orchestrator.interruptingRuns.has(created.id), false);
  assert.equal(fx.events.some((event) => event.type === "run.interrupted"), false);
  assert.equal(fx.events.some((event) => event.type === "run.interrupt_timeout"), false);
  const persisted = JSON.parse(await readFile(join(fx.root, "runs", `${created.id}.json`), "utf8"));
  assert.equal(persisted.status, "cancelled");
  assert.deepEqual(persisted.pendingSteer, []);
  assert.deepEqual(persisted.pendingInteractionSources, []);
  await assert.rejects(
    fx.orchestrator.continue(created.id, { prompt: "不得复活", agentId: "codex-technical" }),
    { code: "RUN_TERMINAL" },
  );
});

test("agent.turn_completed events carry adapter tokens and cost for message-level badges", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "plan" });
  await waitTerminal(fx.orchestrator, created.id);
  const turnEvents = fx.events.filter((event) => event.type === "agent.turn_completed");
  assert.ok(turnEvents.length >= 1, "至少一轮收尾事件");
  for (const event of turnEvents) {
    assert.equal(typeof event.data.tokens, "number", "tokens 计量随事件出仓（消息级徽标数据源）");
    assert.equal(typeof event.data.costUsd, "number", "costUsd 随事件出仓");
    assert.equal(event.data.providerBinding?.mode, "adapter-managed", "每轮必须带实际 Provider 绑定模式");
    assert.equal(event.data.providerBinding?.effectiveProviderId, null);
  }
  const persisted = fx.orchestrator.get(created.id);
  assert.ok(persisted.turnAttempts.every((attempt) => attempt.providerBinding?.mode === "adapter-managed"));
  assert.ok(persisted.turns.every((turn) => turn.providerBinding?.mode === "adapter-managed"));
});

test("failed provider turns persist the error binding and emit agent.turn_failed", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "preview", execute: false, permissionMode: "plan" });
  const target = fx.orchestrator.adapters.get("codex-technical");
  const dispatchBinding = {
    requestedProviderId: "provider-a",
    effectiveProviderId: "provider-a",
    mode: "bound",
    degradedReason: null,
    degradedDetail: null,
    providerApp: "codex",
    adapterId: "codex-app-server",
  };
  const errorBinding = { ...dispatchBinding, effectiveProviderId: "provider-b" };
  target.id = "codex-app-server";
  target.getProviderBinding = () => dispatchBinding;
  target.send = async () => {
    throw Object.assign(new Error("provider failed after dispatch"), {
      code: "PROVIDER_DOWN",
      providerBinding: errorBinding,
      costUsd: 0.25,
      tokens: 17,
    });
  };

  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "run", agentId: "codex-technical" }),
    { code: "PROVIDER_DOWN" },
  );
  const failed = fx.orchestrator.get(created.id);
  assert.equal(failed.turnAttempts.at(-1).phase, "failed");
  assert.deepEqual(failed.turnAttempts.at(-1).providerBinding, errorBinding);
  assert.equal(failed.turnAttempts.at(-1).failureCostUsd, 0.25);
  assert.equal(failed.turnAttempts.at(-1).failureTokens, 17);
  assert.equal(failed.turnAttempts.at(-1).failureUsageAccounted, true);
  assert.equal(failed.turnAttempts.at(-1).failureUsages.length, 1);
  assert.equal(failed.turnAttempts.at(-1).failureUsages[0].adapterId, "codex-app-server");
  assert.equal(failed.costUsdTotal, 0.25);
  assert.equal(failed.interactionCostUsd, 0.25);
  const failureEvent = fx.events.find((event) => event.type === "agent.turn_failed");
  assert.deepEqual(failureEvent?.data.providerBinding, errorBinding);
  assert.equal(failureEvent?.data.costUsd, 0.25);
  assert.equal(failureEvent?.data.tokens, 17);
  const persisted = JSON.parse(await readFile(join(fx.root, "runs", `${created.id}.json`), "utf8"));
  assert.equal(persisted.turnAttempts.at(-1).failureCostUsd, 0.25);
  assert.equal(persisted.costUsdTotal, 0.25);
  assert.equal(persisted.interactionCostUsd, 0.25);
});

test("successful fallback preserves its response binding and accounts the primary failure usage", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "preview", execute: false, permissionMode: "plan" });
  const primary = fx.orchestrator.adapters.get("codex-technical");
  const fallback = fx.orchestrator.adapters.get("codex-technical-fallback");
  const primaryBinding = {
    requestedProviderId: "provider-primary",
    effectiveProviderId: "provider-primary",
    mode: "bound",
    degradedReason: null,
    degradedDetail: null,
    providerApp: "codex",
    adapterId: "codex-app-server",
    routeMode: "direct-projection",
    bindingScope: "upstream",
    upstreamProviderId: "provider-primary",
    upstreamAttribution: "exact",
  };
  const fallbackDispatchBinding = {
    ...primaryBinding,
    requestedProviderId: "provider-fallback",
    effectiveProviderId: "provider-fallback",
    adapterId: "codex-exec-json",
  };
  const fallbackResponseBinding = {
    ...fallbackDispatchBinding,
    effectiveProviderId: "provider-fallback-actual",
    upstreamProviderId: "provider-fallback-actual",
  };
  primary.id = "codex-app-server";
  primary.getProviderBinding = () => primaryBinding;
  primary.send = async () => {
    throw Object.assign(new Error("app server exited after billable work"), {
      code: "APP_SERVER_EXIT",
      safeToFallback: true,
      providerBinding: primaryBinding,
      costUsd: 0.25,
      tokens: 10,
    });
  };
  fallback.id = "codex-exec-json";
  fallback.getProviderBinding = () => fallbackDispatchBinding;
  fallback.send = async () => ({
    sessionId: "fallback-session",
    text: "fallback succeeded",
    protocol: "codex-exec-json",
    tokens: 20,
    costUsd: 0.5,
    providerBinding: fallbackResponseBinding,
  });

  const completed = await fx.orchestrator.continue(created.id, { prompt: "run", agentId: "codex-technical" });
  const attempt = completed.turnAttempts.at(-1);
  assert.equal(attempt.phase, "completed");
  assert.deepEqual(attempt.providerBinding, fallbackResponseBinding);
  assert.equal(attempt.failureCostUsd, 0.25);
  assert.equal(attempt.failureTokens, 10);
  assert.equal(attempt.failureUsages.length, 1);
  assert.deepEqual(completed.turns.at(-1).providerBinding, fallbackResponseBinding);
  assert.equal(completed.costUsdTotal, 0.75);
  assert.equal(completed.interactionCostUsd, 0.75);
  const fallbackEvent = fx.events.find((event) => event.type === "adapter.fallback");
  assert.deepEqual(fallbackEvent?.data.fromProviderBinding, primaryBinding);
  assert.deepEqual(fallbackEvent?.data.toProviderBinding, fallbackDispatchBinding);
  assert.equal(fallbackEvent?.data.fromCostUsd, 0.25);
  assert.equal(fallbackEvent?.data.fromTokens, 10);
  const completedEvent = fx.events.find((event) => event.type === "agent.turn_completed");
  assert.deepEqual(completedEvent?.data.providerBinding, fallbackResponseBinding);
});

test("fallback failures replace the prepared binding with the fallback error binding", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "preview", execute: false, permissionMode: "plan" });
  const primary = fx.orchestrator.adapters.get("codex-technical");
  const fallback = fx.orchestrator.adapters.get("codex-technical-fallback");
  const primaryBinding = {
    requestedProviderId: "provider-primary",
    effectiveProviderId: "provider-primary",
    mode: "bound",
    degradedReason: null,
    degradedDetail: null,
    providerApp: "codex",
    adapterId: "codex-app-server",
    routeMode: "direct-projection",
    bindingScope: "upstream",
    upstreamProviderId: "provider-primary",
    upstreamAttribution: "exact",
  };
  const fallbackDispatchBinding = {
    ...primaryBinding,
    requestedProviderId: "provider-fallback",
    effectiveProviderId: "provider-fallback",
    adapterId: "codex-exec-json",
  };
  const fallbackErrorBinding = {
    ...fallbackDispatchBinding,
    effectiveProviderId: null,
    mode: "adapter-managed",
    degradedReason: "provider-missing",
    routeMode: "adapter-managed",
    bindingScope: "adapter",
    upstreamProviderId: null,
    upstreamAttribution: "unavailable",
  };
  primary.id = "codex-app-server";
  primary.getProviderBinding = () => primaryBinding;
  primary.send = async () => {
    throw Object.assign(new Error("app server exited"), {
      code: "APP_SERVER_EXIT",
      safeToFallback: true,
      providerBinding: primaryBinding,
      costUsd: 0.25,
      tokens: 10,
    });
  };
  fallback.id = "codex-exec-json";
  fallback.getProviderBinding = () => fallbackDispatchBinding;
  fallback.send = async () => {
    throw Object.assign(new Error("fallback also failed"), {
      code: "FALLBACK_FAILED",
      providerBinding: fallbackErrorBinding,
      costUsd: 0.5,
      tokens: 20,
    });
  };

  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "run", agentId: "codex-technical" }),
    { code: "FALLBACK_FAILED" },
  );
  const failed = fx.orchestrator.get(created.id);
  assert.equal(failed.turnAttempts.at(-1).phase, "failed");
  assert.deepEqual(failed.turnAttempts.at(-1).providerBinding, fallbackErrorBinding);
  assert.equal(failed.turnAttempts.at(-1).failureCostUsd, 0.75);
  assert.equal(failed.turnAttempts.at(-1).failureTokens, 30);
  assert.equal(failed.turnAttempts.at(-1).failureUsages.length, 2);
  assert.deepEqual(failed.turnAttempts.at(-1).failureUsages.map((usage) => usage.adapterId), [
    "codex-app-server",
    "codex-exec-json",
  ]);
  assert.equal(failed.costUsdTotal, 0.75);
  assert.equal(failed.interactionCostUsd, 0.75);
  const fallbackEvent = fx.events.find((event) => event.type === "adapter.fallback");
  assert.deepEqual(fallbackEvent?.data.fromProviderBinding, primaryBinding);
  assert.deepEqual(fallbackEvent?.data.toProviderBinding, fallbackDispatchBinding);
  assert.equal(fallbackEvent?.data.fromCostUsd, 0.25);
  const failureEvent = fx.events.find((event) => event.type === "agent.turn_failed");
  assert.equal(failureEvent?.data.adapterId, "codex-exec-json");
  assert.deepEqual(failureEvent?.data.providerBinding, fallbackErrorBinding);
  assert.equal(failureEvent?.data.costUsd, 0.5, "costUsd is the final provider failure increment");
  assert.equal(failureEvent?.data.tokens, 20, "tokens is the final provider failure increment");
  assert.equal(failureEvent?.data.usageScope, "provider-failure");
  assert.equal(failureEvent?.data.attemptFailureCostUsd, 0.75);
  assert.equal(failureEvent?.data.attemptFailureTokens, 30);
  assert.equal(failureEvent?.data.attemptFailureUsageCount, 2);
});

test("legacy accounted failure usage survives restart without duplicate billing", async (t) => {
  const fx = await fixture();
  let restarted = null;
  t.after(async () => {
    await restarted?.close();
    await fx.orchestrator.close();
    await rm(fx.root, { recursive: true, force: true });
  });
  const created = await fx.orchestrator.create({ prompt: "legacy route", execute: false, permissionMode: "plan" });
  const run = fx.orchestrator.get(created.id);
  const prompt = "resume legacy failure";
  const attemptId = "legacy-failure-attempt";
  run.round = 1;
  run.interactionStep = 1;
  run.costUsdTotal = 0.25;
  run.interactionCostUsd = 0.25;
  run.turnAttempts = [{
    attemptId,
    round: 1,
    interactionId: run.activeInteractionId,
    interactionSeq: run.activeInteractionSeq,
    interactionStep: 1,
    agentId: "codex-technical",
    phase: "prepared",
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    sessionId: null,
    tentativeSessionId: null,
    sessionResumable: null,
    protocol: null,
    clientUserMessageId: null,
    nativeTurnId: null,
    providerBinding: null,
    sourceWorkItemId: "legacy-work",
    sourceBusMessageId: null,
    failureCostUsd: 0.25,
    failureTokens: 10,
    failureUsageAccounted: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }];
  await fx.orchestrator.save(run);
  await fx.orchestrator.close();

  const events = [];
  restarted = await new Orchestrator({
    router: fx.orchestrator.router,
    adapters: fx.orchestrator.adapters,
    eventStore: { emit: async (type, data) => { events.push({ type, data }); } },
    dataRoot: fx.root,
    policy: fx.orchestrator.policy,
    approvalBroker: fx.orchestrator.approvalBroker,
    capabilities: fx.orchestrator.capabilities,
    models: fx.orchestrator.models,
  }).init();
  const target = restarted.adapters.get("codex-technical");
  target.send = async () => {
    throw Object.assign(new Error("same legacy billed failure"), {
      code: "PROVIDER_DOWN",
      costUsd: 0.25,
      tokens: 10,
    });
  };
  const reloaded = restarted.get(created.id);
  const controller = new AbortController();
  restarted.controllers.set(created.id, controller);
  await assert.rejects(
    () => restarted.turn(reloaded, "codex-technical", prompt, {
      sourceWorkItemId: "legacy-work",
      allowAutoRecovery: false,
    }),
    { code: "PROVIDER_DOWN" },
  );
  restarted.controllers.delete(created.id);

  const failed = restarted.get(created.id);
  const attempt = failed.turnAttempts.find((item) => item.attemptId === attemptId);
  assert.equal(failed.costUsdTotal, 0.25);
  assert.equal(failed.interactionCostUsd, 0.25);
  assert.equal(attempt.failureCostUsd, 0.25);
  assert.equal(attempt.failureTokens, 10);
  assert.equal(attempt.failureUsages.length, 1);
  assert.equal(attempt.failureUsages[0].legacy, true);
  assert.equal(events.filter((event) => event.type === "agent.turn_failed").length, 1);
});

test("save never clobbers concurrent steer mutations; memory and disk converge losslessly", async (t) => {
  // 竞态护栏（烛 wave2 P1）：旧实现"快照 → await 写盘 → 回写旧快照"会把写盘窗口内的
  // 并发 push 抹掉。交错风暴属非确定性触发（旧代码高概率红），新实现（同 tick 快照回写 +
  // per-run 写盘链）下必须恒绿。
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: false, permissionMode: "plan" });
  const run = fx.orchestrator.get(created.id);
  run.pendingSteer = [];
  const saves = [];
  for (let i = 0; i < 12; i += 1) {
    run.pendingSteer.push({ prompt: `插话${i}`, agentId: "claude-fable", queuedAt: new Date().toISOString() });
    saves.push(fx.orchestrator.save(run));
    await new Promise((resolveTick) => setImmediate(resolveTick)); // 打开写盘交错窗口
  }
  await Promise.all(saves);
  const latest = fx.orchestrator.get(created.id);
  assert.equal(latest.pendingSteer.length, 12, "内存不得丢失任何并发排队项");
  const disk = JSON.parse(await readFile(join(fx.root, "runs", `${created.id}.json`), "utf8"));
  assert.equal(disk.pendingSteer.length, 12, "磁盘最终态收敛到全部排队项");
  assert.deepEqual(
    disk.pendingSteer.map((steer) => steer.prompt),
    latest.pendingSteer.map((steer) => steer.prompt),
    "磁盘与内存逐项一致（无丢失、无重复、无回退）",
  );
});

test("clearFinished waits for in-flight save chains so cleared runs cannot resurrect", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: false, permissionMode: "plan" });
  const runPath = join(fx.root, "runs", `${created.id}.json`);
  // 门闩模拟迟到的写盘：释放后才把快照写回磁盘（旧实现 rm 不等链，该写回会让已清除 run 复活）
  let releaseSave;
  const gate = new Promise((resolveGate) => { releaseSave = resolveGate; });
  fx.orchestrator.saveChains.set(created.id, gate.then(async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(runPath, JSON.stringify(fx.orchestrator.get(created.id)), "utf8");
  }));
  const clearing = fx.orchestrator.clearFinished();
  releaseSave();
  const result = await clearing;
  assert.ok(result.runIds.includes(created.id), "终态 run 被清除");
  await assert.rejects(() => readFile(runPath, "utf8"), { code: "ENOENT" }, "在途写盘收敛后文件被删净，不复活");
});

test("close drains pending save chains before returning", async (t) => {
  const fx = await fixture();
  t.after(async () => { await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: false, permissionMode: "plan" });
  let flushed = false;
  fx.orchestrator.saveChains.set(created.id, new Promise((resolveSlow) => setTimeout(resolveSlow, 120)).then(() => { flushed = true; }));
  await fx.orchestrator.close();
  assert.equal(flushed, true, "close 返回前全部在途写链已收敛（进程 exit 不截断写盘）");
});

test("recovery acknowledgement is not written when admission checks reject the continue", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: false, permissionMode: "plan" });
  const run = fx.orchestrator.get(created.id);
  run.status = "recovery_required";
  await assert.rejects(
    () => fx.orchestrator.continue(created.id, { prompt: "retry", agentId: "no-such-agent", acknowledgeRecovery: true }),
    { code: "ADAPTER_UNAVAILABLE" },
  );
  assert.equal(run.recoveryAcknowledgedAt, undefined, "校验拒绝时不留未持久化的孤儿确认字段");
});

test("init rejects when the run directory cannot be enumerated instead of presenting an empty store", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-orchestrator-init-readdir-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  let readdirCalls = 0;
  const orchestrator = new Orchestrator({
    router: { preview: async () => route() },
    adapters: new Map(),
    eventStore: { emit: async () => {} },
    dataRoot: root,
    policy: policy(),
    approvalBroker: { request: async () => ({ decision: "accept" }), denyRun() {} },
    storage: {
      async readdir() {
        readdirCalls += 1;
        throw Object.assign(new Error("run directory unavailable"), { code: "EIO" });
      },
    },
  });

  await assert.rejects(() => orchestrator.init(), { code: "RUN_STORE_UNAVAILABLE" });
  assert.equal(readdirCalls, 1, "init 必须实际枚举 run store，不能静默降级为空列表");
  await orchestrator.close();
});

test("init rejects visibly when an enumerated valid run cannot be read", async (t) => {
  const fx = await fixture();
  const root = fx.root;
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "persisted valid run", execute: false, permissionMode: "plan" });
  const runPath = join(root, "runs", `${created.id}.json`);
  await fx.orchestrator.close();

  for (const ioCode of ["EACCES", "EIO"]) {
    let attemptedPath = null;
    const reloaded = new Orchestrator({
      router: { preview: async () => route() },
      adapters: new Map(),
      eventStore: { emit: async () => {} },
      dataRoot: root,
      policy: policy(),
      approvalBroker: { request: async () => ({ decision: "accept" }), denyRun() {} },
      storage: {
        async readFile(path) {
          attemptedPath = path;
          throw Object.assign(new Error(`cannot read persisted run: ${ioCode}`), { code: ioCode });
        },
      },
    });

    await assert.rejects(() => reloaded.init(), { code: "RUN_STORE_READ_FAILED" }, `${ioCode} 不能被伪装成缺失 run/404`);
    assert.equal(resolve(attemptedPath), resolve(runPath), `${ioCode} 来自已枚举的有效 run 文件`);
    await reloaded.close();
  }
});

test("init may leave malformed JSON on disk while still loading valid runs", async (t) => {
  const fx = await fixture();
  const root = fx.root;
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "valid persisted run", execute: false, permissionMode: "plan" });
  const malformedPath = join(root, "runs", "malformed.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(malformedPath, "{ definitely-not-json", "utf8");
  await fx.orchestrator.close();

  const reloaded = await new Orchestrator({
    router: { preview: async () => route() },
    adapters: new Map(),
    eventStore: { emit: async () => {} },
    dataRoot: root,
    policy: policy(),
    approvalBroker: { request: async () => ({ decision: "accept" }), denyRun() {} },
  }).init();
  assert.equal(reloaded.get(created.id).id, created.id, "语法损坏不能阻止其他有效 run 恢复可见性");
  assert.equal(await readFile(malformedPath, "utf8"), "{ definitely-not-json", "损坏文件原样留盘待查");
  await reloaded.close();
});

test("restart-restated run statuses are persisted back to disk during init", async (t) => {
  const fx = await fixture();
  const root = fx.root;
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: false, permissionMode: "plan" });
  const runPath = join(root, "runs", `${created.id}.json`);
  const record = JSON.parse(await readFile(runPath, "utf8"));
  record.status = "running"; // 模拟控制面中断时的活跃态
  const { writeFile } = await import("node:fs/promises");
  await writeFile(runPath, JSON.stringify(record), "utf8");
  await fx.orchestrator.close();
  const { Orchestrator: Reloaded } = await import("../src/orchestrator.mjs");
  const second = await new Reloaded({
    router: { preview: async () => route() },
    adapters: new Map(),
    eventStore: { emit: async () => {} },
    dataRoot: root,
    policy: policy(),
    approvalBroker: { request: async () => ({ decision: "accept" }), denyRun() {} },
  }).init();
  assert.equal(second.get(created.id).status, "waiting_agent", "重启改写进内存");
  const persisted = JSON.parse(await readFile(runPath, "utf8"));
  assert.equal(persisted.status, "waiting_agent", "重启改写同步落盘，内存与磁盘不分叉");
  await second.close();
});

test("clearFinished keeps waiting when a new save chain appears mid-drain", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: false, permissionMode: "plan" });
  const runPath = join(fx.root, "runs", `${created.id}.json`);
  const { writeFile } = await import("node:fs/promises");
  let releaseFirst;
  const firstGate = new Promise((resolveGate) => { releaseFirst = resolveGate; });
  // 链 A settle 前夕挂上更迟的链 B（旧实现只等 A 且误删 B 引用，B 的迟到写盘会让文件复活）
  fx.orchestrator.saveChains.set(created.id, firstGate.then(async () => {
    await writeFile(runPath, JSON.stringify(fx.orchestrator.get(created.id)), "utf8");
    fx.orchestrator.saveChains.set(created.id, (async () => {
      await new Promise((resolveSlow) => setTimeout(resolveSlow, 60));
      await writeFile(runPath, JSON.stringify(fx.orchestrator.get(created.id)), "utf8");
    })());
  }));
  const clearing = fx.orchestrator.clearFinished();
  releaseFirst();
  const result = await clearing;
  assert.ok(result.runIds.includes(created.id));
  await assert.rejects(() => readFile(runPath, "utf8"), { code: "ENOENT" }, "循环收敛把链 B 也等完，文件不复活");
});

test("close keeps draining save chains that appear while it is waiting", async (t) => {
  const fx = await fixture();
  t.after(async () => { await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: false, permissionMode: "plan" });
  let secondFlushed = false;
  fx.orchestrator.saveChains.set(created.id, new Promise((resolveSlow) => setTimeout(resolveSlow, 60)).then(() => {
    // 首链收敛瞬间挂上新链（一次性快照会漏掉它）
    fx.orchestrator.saveChains.set(created.id, new Promise((resolveNext) => setTimeout(resolveNext, 60)).then(() => { secondFlushed = true; }));
  }));
  await fx.orchestrator.close();
  assert.equal(secondFlushed, true, "close 循环收敛等待期间新增的写链");
});

test("direct continuation registers its execution key before admission save and close waits for settlement", async (t) => {
  const fx = await fixture();
  const diskPredecessor = deferred();
  const admissionEntered = deferred();
  const admissionPersisted = deferred();
  const releaseAdmission = deferred();
  let continuing;
  let closing;
  const originalSave = fx.orchestrator.save.bind(fx.orchestrator);
  t.after(async () => {
    diskPredecessor.resolve();
    releaseAdmission.resolve();
    await Promise.allSettled([continuing, closing].filter(Boolean));
    fx.orchestrator.save = originalSave;
    await fx.orchestrator.close();
    await rm(fx.root, { recursive: true, force: true });
  });

  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, permissionMode: "plan" });
  const runPath = join(fx.root, "runs", `${created.id}.json`);
  const continuationPrompt = "continue during shutdown admission";
  let gateAdmissionSave = true;
  fx.orchestrator.saveChains.set(created.id, diskPredecessor.promise);
  fx.orchestrator.save = async (candidate) => {
    if (gateAdmissionSave && candidate.id === created.id && candidate.status === "running") {
      gateAdmissionSave = false;
      admissionEntered.resolve();
      const saved = await originalSave(candidate);
      admissionPersisted.resolve();
      await releaseAdmission.promise;
      return saved;
    }
    return originalSave(candidate);
  };

  continuing = fx.orchestrator.continue(created.id, {
    prompt: continuationPrompt,
    agentId: "claude-fable",
  });
  await admissionEntered.promise;
  assert.ok(fx.orchestrator.transitionChains.has(created.id), "admission 仍在 per-run transition 内");
  assert.ok(fx.orchestrator.controllers.has(created.id), "controller 已占位，close 必须赢得取消所有权");
  const executionKey = `continue:${created.id}`;
  assert.ok(fx.orchestrator.executions.has(executionKey), "execution 必须在 admission 首个 await 前可见，从机械上删除注册窗口");

  let closeSettled = false;
  closing = fx.orchestrator.close().then(() => { closeSettled = true; });
  diskPredecessor.resolve();
  await admissionPersisted.promise;
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  const closeReturnedBeforeAdmissionSettled = closeSettled;

  releaseAdmission.resolve();
  await Promise.allSettled([continuing, closing]);
  fx.orchestrator.save = originalSave;
  const memory = fx.orchestrator.get(created.id);
  const persisted = JSON.parse(await readFile(runPath, "utf8"));
  const userMessages = fx.events.filter((event) => event.type === "user.message" && event.data.text === continuationPrompt);
  assert.deepEqual({
    closeReturnedBeforeAdmissionSettled,
    memoryStatus: memory.status,
    diskStatus: persisted.status,
    memoryRecoveryNote: memory.recoveryNote,
    diskRecoveryNote: persisted.recoveryNote,
    userMessageCount: userMessages.length,
    providerDispatches: fx.calls.length,
  }, {
    closeReturnedBeforeAdmissionSettled: false,
    memoryStatus: "cancelled",
    diskStatus: "cancelled",
    memoryRecoveryNote: "Control plane shutdown cancelled this continuation before prompt was projected.",
    diskRecoveryNote: "Control plane shutdown cancelled this continuation before prompt was projected.",
    userMessageCount: 0,
    providerDispatches: 0,
  }, "close 必须线性化 admission：等待、取消落盘，并明示 prompt 尚未投影");
});

test("direct social continuation keeps its durable prompt fact when close aborts the projection postcheck", async (t) => {
  const fx = await fixture();
  const projectionEntered = deferred();
  const releaseProjection = deferred();
  const controllerAborted = deferred();
  let continuing;
  let closing;
  const originalEmit = fx.orchestrator.eventStore.emit.bind(fx.orchestrator.eventStore);
  t.after(async () => {
    releaseProjection.resolve();
    await Promise.allSettled([continuing, closing].filter(Boolean));
    fx.orchestrator.eventStore.emit = originalEmit;
    await fx.orchestrator.close();
    await rm(fx.root, { recursive: true, force: true });
  });

  const created = await fx.orchestrator.create({
    prompt: "route only",
    execute: false,
    permissionMode: "plan",
    orchestrationMode: "social",
  });
  const continuationPrompt = "durable social prompt at shutdown boundary";
  let gateProjection = true;
  fx.orchestrator.eventStore.emit = async (type, data, context) => {
    const result = await originalEmit(type, data, context);
    if (gateProjection && type === "user.message" && data.text === continuationPrompt) {
      gateProjection = false;
      projectionEntered.resolve();
      await releaseProjection.promise;
    }
    return result;
  };

  continuing = fx.orchestrator.continue(created.id, {
    prompt: continuationPrompt,
    agentId: "claude-fable",
  });
  await projectionEntered.promise;
  const durableBoundary = await fx.orchestrator.bus.read(created.id);
  assert.equal(durableBoundary.length, 1, "projection postcheck 前 durable bus 中恰有一条消息");
  assert.deepEqual({
    kind: durableBoundary[0].kind,
    from: durableBoundary[0].from,
    to: durableBoundary[0].to,
    text: durableBoundary[0].text,
    directContinuation: durableBoundary[0].refs?.directContinuation,
  }, {
    kind: "steer",
    from: "lo",
    to: "claude-fable",
    text: continuationPrompt,
    directContinuation: true,
  });
  assert.equal(fx.calls.length, 0, "provider 尚未派发");

  const controller = fx.orchestrator.controllers.get(created.id);
  assert.ok(controller, "direct continuation controller 在 projection 边界仍持有所有权");
  controller.signal.addEventListener("abort", () => controllerAborted.resolve(), { once: true });
  let closeSettled = false;
  closing = fx.orchestrator.close().then(() => { closeSettled = true; });
  await controllerAborted.promise;
  assert.equal(closeSettled, false, "close 必须等待 projection postcheck 与取消状态落盘");

  releaseProjection.resolve();
  await Promise.all([continuing, closing]);
  fx.orchestrator.eventStore.emit = originalEmit;
  const memory = fx.orchestrator.get(created.id);
  const persisted = JSON.parse(await readFile(join(fx.root, "runs", `${created.id}.json`), "utf8"));
  const messages = await fx.orchestrator.bus.read(created.id);
  assert.deepEqual({
    memoryStatus: memory.status,
    diskStatus: persisted.status,
    memoryRecoveryNote: memory.recoveryNote,
    diskRecoveryNote: persisted.recoveryNote,
    busMessages: messages.length,
    providerDispatches: fx.calls.length,
  }, {
    memoryStatus: "cancelled",
    diskStatus: "cancelled",
    memoryRecoveryNote: "Control plane shutdown cancelled this continuation after the prompt was recorded but before provider completion.",
    diskRecoveryNote: "Control plane shutdown cancelled this continuation after the prompt was recorded but before provider completion.",
    busMessages: 1,
    providerDispatches: 0,
  }, "durable prompt 不能被 shutdown recoveryNote 谎报为尚未投影");
});

test("close installs its latch before abort listeners can synchronously reenter shutdown", async (t) => {
  const fx = await fixture();
  const projectionEntered = deferred();
  const releaseProjection = deferred();
  const abortReentered = deferred();
  const adapterCloseEntered = deferred();
  const releaseAdapterClose = deferred();
  let continuing;
  let outerCompletion;
  let reentrantCompletion;
  const originalEmit = fx.orchestrator.eventStore.emit.bind(fx.orchestrator.eventStore);
  const adapter = fx.orchestrator.adapters.get("claude-fable");
  const originalAdapterClose = adapter.close.bind(adapter);
  t.after(async () => {
    releaseProjection.resolve();
    releaseAdapterClose.resolve();
    await Promise.allSettled([continuing, outerCompletion, reentrantCompletion].filter(Boolean));
    fx.orchestrator.eventStore.emit = originalEmit;
    adapter.close = originalAdapterClose;
    await fx.orchestrator.close();
    await rm(fx.root, { recursive: true, force: true });
  });

  const created = await fx.orchestrator.create({
    prompt: "route only",
    execute: false,
    permissionMode: "plan",
    orchestrationMode: "social",
  });
  const continuationPrompt = "reentrant shutdown latch";
  let gateProjection = true;
  fx.orchestrator.eventStore.emit = async (type, data, context) => {
    const result = await originalEmit(type, data, context);
    if (gateProjection && type === "user.message" && data.text === continuationPrompt) {
      gateProjection = false;
      projectionEntered.resolve();
      await releaseProjection.promise;
    }
    return result;
  };
  let adapterCloseCalls = 0;
  adapter.close = async () => {
    adapterCloseCalls += 1;
    adapterCloseEntered.resolve();
    await releaseAdapterClose.promise;
  };
  // 关闭面只留一个唯一 adapter，让“一次 close”成为精确可判定契约。
  fx.orchestrator.adapters = new Map([["claude-fable", adapter]]);

  continuing = fx.orchestrator.continue(created.id, {
    prompt: continuationPrompt,
    agentId: "claude-fable",
  });
  await projectionEntered.promise;
  const controller = fx.orchestrator.controllers.get(created.id);
  assert.ok(controller, "abort reentry test requires an owned continuation controller");

  let latchInstalledBeforeAbort = false;
  let outerSettled = false;
  let reentrantSettled = false;
  controller.signal.addEventListener("abort", () => {
    latchInstalledBeforeAbort = Boolean(fx.orchestrator.closePromise);
    reentrantCompletion = Promise.resolve(fx.orchestrator.close()).then(() => { reentrantSettled = true; });
    abortReentered.resolve();
  }, { once: true });

  outerCompletion = Promise.resolve(fx.orchestrator.close()).then(() => { outerSettled = true; });
  await abortReentered.promise;
  assert.equal(latchInstalledBeforeAbort, true, "close latch 必须先安装，再同步 abort controller");
  assert.deepEqual({ outerSettled, reentrantSettled, adapterCloseCalls }, {
    outerSettled: false,
    reentrantSettled: false,
    adapterCloseCalls: 0,
  }, "abort listener 重入的 close 不能提前完成");

  releaseProjection.resolve();
  await adapterCloseEntered.promise;
  assert.deepEqual({ outerSettled, reentrantSettled, adapterCloseCalls }, {
    outerSettled: false,
    reentrantSettled: false,
    adapterCloseCalls: 1,
  }, "两个 close 调用都必须等待同一个 adapter 收口，且 adapter 只关闭一次");

  releaseAdapterClose.resolve();
  await Promise.all([continuing, outerCompletion, reentrantCompletion]);
  assert.deepEqual({ outerSettled, reentrantSettled, adapterCloseCalls }, {
    outerSettled: true,
    reentrantSettled: true,
    adapterCloseCalls: 1,
  }, "共享收口释放后两个 close 调用才一起完成");
});

test("close waits for an untracked resumePendingAsk bus projection to settle", async (t) => {
  const fx = await fixture();
  const appendEntered = deferred();
  const releaseAppend = deferred();
  const appendSettled = deferred();
  let resuming;
  let closing;
  const originalAppend = fx.orchestrator.bus.append.bind(fx.orchestrator.bus);
  t.after(async () => {
    releaseAppend.resolve();
    await Promise.allSettled([resuming, closing].filter(Boolean));
    fx.orchestrator.bus.append = originalAppend;
    await fx.orchestrator.close();
    await rm(fx.root, { recursive: true, force: true });
  });

  const created = await fx.orchestrator.create({
    prompt: "answer projection close boundary",
    execute: false,
    permissionMode: "plan",
    orchestrationMode: "social",
  });
  const run = fx.orchestrator.get(created.id);
  run.status = "waiting_agent";
  const ask = await fx.orchestrator.appendBus(run, {
    from: "claude-fable",
    to: "lo",
    kind: "ask",
    text: "continue?",
  });
  run.pendingAsk = { id: ask.id, from: ask.from, text: ask.text, at: ask.ts };
  run.pausedForInput = true;
  await fx.orchestrator.save(run);

  let gateAnswerAppend = true;
  fx.orchestrator.bus.append = async (...args) => {
    const message = args[1];
    if (gateAnswerAppend && message?.kind === "answer") {
      gateAnswerAppend = false;
      appendEntered.resolve();
      await releaseAppend.promise;
      try {
        return await originalAppend(...args);
      } finally {
        appendSettled.resolve();
      }
    }
    return originalAppend(...args);
  };

  resuming = fx.orchestrator.resumePendingAsk(created.id, "continue", { answerToAskId: ask.id });
  await appendEntered.promise;
  assert.ok(fx.orchestrator.projectionChains.has(created.id), "answer append 已在 projection chain 内");
  assert.ok(
    !fx.orchestrator.executions.has(created.id) && !fx.orchestrator.executions.has(`continue:${created.id}`),
    "resumePendingAsk projection 不依赖 executions 可见性",
  );

  let closeSettled = false;
  closing = fx.orchestrator.close().then(() => { closeSettled = true; });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  const closeReturnedBeforeAppendSettled = closeSettled;

  releaseAppend.resolve();
  await Promise.allSettled([resuming, closing]);
  await appendSettled.promise;
  fx.orchestrator.bus.append = originalAppend;
  const busMessages = await fx.orchestrator.bus.read(created.id);
  assert.equal(closeReturnedBeforeAppendSettled, false, "close 不得漏等未纳入 executions 的回答投影");
  assert.equal(
    busMessages.filter((message) => message.kind === "answer" && message.refs?.answerToAskId === ask.id).length,
    1,
    "close 返回前 durable answer append 已精确收口且不重复",
  );
});

test("init keeps a run visible in recovery_required when restart restatement cannot be persisted", async (t) => {
  const fx = await fixture();
  const root = fx.root;
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: false, permissionMode: "plan" });
  const runPath = join(root, "runs", `${created.id}.json`);
  const { writeFile } = await import("node:fs/promises");
  const record = JSON.parse(await readFile(runPath, "utf8"));
  record.status = "running";
  await writeFile(runPath, JSON.stringify(record), "utf8");
  await fx.orchestrator.close();
  const { Orchestrator: Reloaded } = await import("../src/orchestrator.mjs");
  class PersistFailing extends Reloaded {
    // 模拟基类真实失败序：同步段已 runs.set，之后 writeFile/rename 才抛。
    async save(run) {
      this.runs.set(run.id, run);
      throw new Error("disk full");
    }
  }
  const second = await new PersistFailing({
    router: { preview: async () => route() },
    adapters: new Map(),
    eventStore: { emit: async () => {} },
    dataRoot: root,
    policy: policy(),
    approvalBroker: { request: async () => ({ decision: "accept" }), denyRun() {} },
  }).init();
  const visible = second.get(created.id);
  assert.equal(visible.status, "recovery_required", "控制面保留可见性并阻止自动调度");
  assert.equal(visible.persistenceDegraded, true);
  assert.equal(visible.recoveryIssue?.code, "RESTART_PERSISTENCE_FAILED");
  const persisted = JSON.parse(await readFile(runPath, "utf8"));
  assert.equal(persisted.status, "running", "磁盘原样保留 forensic 状态");
  await second.close();
});

test("a late save from a lingering coroutine cannot resurrect a cleared run", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: false, permissionMode: "plan" });
  const run = fx.orchestrator.get(created.id); // 模拟终态尾巴协程仍持有的 run 引用
  const runPath = join(fx.root, "runs", `${created.id}.json`);
  const result = await fx.orchestrator.clearFinished();
  assert.ok(result.runIds.includes(created.id));
  await fx.orchestrator.save(run); // 迟到写盘（emitEvent 降级 / drain 收尾路径）
  await assert.rejects(() => readFile(runPath, "utf8"), { code: "ENOENT" }, "墓碑丢弃迟到写盘，文件不复活");
  assert.throws(() => fx.orchestrator.get(created.id), { code: "RUN_NOT_FOUND" }, "run 不回内存 Map");
});

test("a failed disk removal restores the run instead of orphaning it in memory", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: false, permissionMode: "plan" });
  const runPath = join(fx.root, "runs", `${created.id}.json`);
  // node 打开文件带 FILE_SHARE_DELETE，句柄锁不住删除——把 run 文件换成非空目录让 rm 必然抛错
  const { mkdir, writeFile } = await import("node:fs/promises");
  await rm(runPath, { force: true });
  await mkdir(runPath);
  await writeFile(join(runPath, "hold.txt"), "block non-recursive rm", "utf8");
  const result = await fx.orchestrator.clearFinished();
  assert.ok(!result.runIds.includes(created.id), "删盘失败不谎报已清除");
  assert.equal(fx.orchestrator.get(created.id).id, created.id, "run 恢复内存可见性（磁盘还在就不装作已清除）");
});

test("a direct HTTP continuation is tracked in executions so close waits for it", async (t) => {
  const fx = await fixture();
  t.after(async () => { await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: false, permissionMode: "plan" });
  let releaseTurn;
  const gate = new Promise((resolveGate) => { releaseTurn = resolveGate; });
  fx.orchestrator.adapters.get("claude-fable").send = async () => {
    await gate;
    return { sessionId: "s", text: "done", protocol: "mock" };
  };
  const continuing = fx.orchestrator.continue(created.id, { prompt: "go", agentId: "claude-fable" });
  // continue 入口有多个 await（save/emitEvent）才到注册点，轮询等待而非赌单 tick
  const registerDeadline = Date.now() + 1_000;
  while (!fx.orchestrator.executions.has(`continue:${created.id}`) && Date.now() < registerDeadline) {
    await new Promise((resolveTick) => setImmediate(resolveTick));
  }
  assert.ok(fx.orchestrator.executions.has(`continue:${created.id}`), "在途续聊注册进 executions（close 可等待）");
  assert.equal(fx.orchestrator.isBusy(), true);
  releaseTurn();
  await continuing;
  assert.ok(!fx.orchestrator.executions.has(`continue:${created.id}`), "完成后自清");
  await fx.orchestrator.close();
});

test("cancel returns multi-CLI cascade visibility for team members and sessions", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({
    prompt: "long collaboration",
    execute: true,
    orchestrationMode: "pipeline",
    maxRounds: 3,
    permissionMode: "plan",
  });
  // let first turns start
  await new Promise((resolveTick) => setTimeout(resolveTick, 30));
  const cancelled = await fx.orchestrator.cancel(created.id);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.cancelCascade);
  assert.equal(cancelled.cancelCascade.scope, "self|descendants|provider-tree");
  assert.ok(Array.isArray(cancelled.cancelCascade.agents));
  assert.ok(cancelled.cancelCascade.agents.includes("claude-fable") || cancelled.cancelCascade.agents.length >= 1);
});

test("cancelling a run with queued steers does not restart consumption afterwards", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, permissionMode: "plan" });
  let releaseTurn;
  const gate = new Promise((resolveGate) => { releaseTurn = resolveGate; });
  let markEntered;
  const turnEntered = new Promise((resolveEnter) => { markEntered = resolveEnter; });
  fx.orchestrator.adapters.get("claude-fable").send = async () => {
    markEntered();
    await gate;
    return { sessionId: "s", text: "done", protocol: "mock" };
  };
  const continuing = fx.orchestrator.continue(created.id, { prompt: "第一轮", agentId: "claude-fable" });
  await turnEntered;
  await fx.orchestrator.continue(created.id, { prompt: "排队插话", agentId: "claude-fable" });
  await fx.orchestrator.cancel(created.id);
  releaseTurn();
  await continuing.catch(() => {}); // 取消路径抛错属预期
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 50)); // 让链尾 ensure 有机会（不该）触发
  const done = fx.orchestrator.get(created.id);
  assert.equal(done.status, "cancelled");
  assert.deepEqual(done.pendingSteer, [], "取消整场任务必须丢弃尚未消费的插话");
  assert.equal(fx.orchestrator.executions.size, 0, "无补启的排干协程");
});

test("a save already queued behind the chain is discarded once the tombstone lands", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: false, permissionMode: "plan" });
  const run = fx.orchestrator.get(created.id);
  const runPath = join(fx.root, "runs", `${created.id}.json`);
  // 门闩占住写链 → save 通过入口检查排在链上 → 墓碑落地 → 释放门闩 → flush 的写盘前复查应丢弃
  let releaseChain;
  fx.orchestrator.saveChains.set(created.id, new Promise((resolveChain) => { releaseChain = resolveChain; }));
  const lateSave = fx.orchestrator.save(run);
  fx.orchestrator.runs.delete(created.id);
  fx.orchestrator.clearedRuns.add(created.id);
  await rm(runPath, { force: true });
  releaseChain();
  await lateSave;
  await assert.rejects(() => readFile(runPath, "utf8"), { code: "ENOENT" }, "链上迟到写盘被墓碑复查丢弃，文件不复活");
});

test("clearFinished skips a terminal run whose execution coroutine has not finished", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  // 门闩 run.completed 事件写盘：execute 已置 succeeded 但协程卡在 emitEvent 的 await 窗口
  let releaseEmit;
  const emitGate = new Promise((resolveGate) => { releaseEmit = resolveGate; });
  const originalEmit = fx.orchestrator.eventStore.emit.bind(fx.orchestrator.eventStore);
  fx.orchestrator.eventStore.emit = async (type, data, context) => {
    if (type === "run.completed") await emitGate;
    return originalEmit(type, data, context);
  };
  const created = await fx.orchestrator.create({ prompt: "implement", execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "plan" });
  const statusDeadline = Date.now() + 5_000;
  while (Date.now() < statusDeadline && fx.orchestrator.get(created.id).status !== "succeeded") {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  assert.equal(fx.orchestrator.get(created.id).status, "succeeded");
  assert.ok(fx.orchestrator.executions.has(created.id), "协程仍在（卡在事件写盘）");
  const skipped = await fx.orchestrator.clearFinished();
  assert.ok(!skipped.runIds.includes(created.id), "终态但协程未收尾——本轮跳过不清");
  assert.equal(fx.orchestrator.get(created.id).id, created.id, "run 未被删除，协程不会 RUN_NOT_FOUND");
  releaseEmit();
  const drainDeadline = Date.now() + 5_000;
  while (Date.now() < drainDeadline && (fx.orchestrator.executions.has(created.id) || fx.orchestrator.controllers.has(created.id))) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  const secondPass = await fx.orchestrator.clearFinished();
  assert.ok(secondPass.runIds.includes(created.id), "协程收尾后再次清理成功");
});

test("session effort override validates the CLI whitelist and reaches the execution owner turn", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  await assert.rejects(
    () => fx.orchestrator.create({ prompt: "x", execute: false, permissionMode: "plan", effort: "ultra;rm" }),
    { code: "INVALID_EFFORT" },
  );
  const created = await fx.orchestrator.create({ prompt: "x", execute: false, permissionMode: "plan", effort: "XHigh" });
  assert.equal(created.effortOverride, "xhigh", "大小写归一后固化");
  await fx.orchestrator.continue(created.id, { prompt: "go", agentId: "codex-technical" });
  assert.equal(fx.calls.at(-1).effort, "xhigh", "执行所有者轮携带 /effort 覆盖到 adapter");
  const plain = await fx.orchestrator.create({ prompt: "y", execute: false, permissionMode: "plan" });
  assert.equal(plain.effortOverride, null, "未选择时不传（CLI 用自身默认档）");
  await assert.rejects(
    () => fx.orchestrator.create({ prompt: "z", execute: false, permissionMode: "plan", effort: "ultracode" }),
    { code: "INVALID_EFFORT" },
    "ultracode 是 514cc 工作流，不是 Claude CLI effort",
  );
});

test("run meta updates are whitelisted and legacy project archive matches by canonical cwd", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "meta target", execute: false, permissionMode: "plan", cwd: fx.root });
  const pinned = await fx.orchestrator.updateMeta(created.id, { pinned: true, unread: true, title: "改名后的任务", ignored: "x" });
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.unread, true);
  assert.equal(pinned.title, "改名后的任务");
  assert.equal(pinned.ignored, undefined, "白名单外字段不落盘");
  await assert.rejects(() => fx.orchestrator.updateMeta(created.id, { title: "   " }), { code: "VALIDATION_FAILED" });
  const other = await fx.orchestrator.create({ prompt: "other cwd", execute: false, permissionMode: "plan" });
  const archiveCwd = process.platform === "win32" ? fx.root.toUpperCase() : fx.root;
  const archived = await fx.orchestrator.archiveFinishedByCwd(archiveCwd);
  assert.deepEqual(archived.runIds, [created.id], "仅归档 cwd 匹配的终态任务");
  assert.equal(archived.matchedBy, "legacy-cwd");
  assert.equal(fx.orchestrator.get(created.id).archived, true);
  assert.equal(fx.orchestrator.get(other.id).archived, undefined, "其他 cwd 不受影响");
});

test("logical team members sharing one runtime profile keep isolated sessions and member defaults", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-orchestrator-members-"));
  const memberRecords = new Map([
    ["member-alpha", {
      id: "member-alpha",
      runtimeProfileId: "codex-technical",
      label: "Alpha",
      role: "implementation lead",
      description: "Owns the primary implementation pass.",
      systemPrompt: "ALPHA_PERSONA: preserve implementation evidence.",
      capabilities: ["coding", "review"],
      defaultModel: "gpt-alpha-default",
      defaultEffort: "high",
      teamMemberEligible: true,
      coordinatorEligible: true,
    }],
    ["member-beta", {
      id: "member-beta",
      runtimeProfileId: "codex-technical",
      label: "Beta",
      role: "independent verifier",
      description: "Challenges the first member with an isolated identity.",
      personaPrompt: "BETA_PERSONA: challenge unsupported completion claims.",
      capabilities: ["review"],
      defaultModel: "gpt-beta-default",
      defaultEffort: "xhigh",
      teamMemberEligible: true,
      coordinatorEligible: true,
    }],
  ]);
  const team = {
    id: "team-custom-codex-pair",
    name: "Custom Codex Pair",
    coordinator: "member-alpha",
    members: ["member-alpha", "member-beta"],
    skills: [],
  };
  const rosterSnapshots = [];
  const teamMembers = {
    snapshot(ids) {
      rosterSnapshots.push([...ids]);
      return ids.map((id) => memberRecords.get(id));
    },
    get(id) {
      const member = memberRecords.get(id);
      if (!member) throw Object.assign(new Error("member not found"), { code: "SOURCE_NOT_FOUND" });
      return member;
    },
  };
  const routeInputs = [];
  const discoveryProfiles = [];
  const calls = [];
  const adapter = {
    id: "codex-app-server",
    cwd: root,
    async send(input) {
      calls.push({ ...input });
      const sessionId = input.sessionId || `session-${input.agentId}`;
      await input.onSessionStarted?.({ sessionId, protocol: "codex-app-server" });
      await input.onTurnSubmitting?.({ sessionId, protocol: "codex-app-server", clientUserMessageId: `message-${input.agentId}` });
      await input.onTurnAccepted?.({ sessionId, protocol: "codex-app-server", clientUserMessageId: `message-${input.agentId}`, turnId: `turn-${input.agentId}` });
      return { sessionId, text: `${input.agentId} completed`, protocol: "codex-app-server", tokens: 100, costUsd: 0.01 };
    },
    async close() {},
  };
  const orchestratorOptions = {
    router: {
      async preview(input) {
        routeInputs.push(input);
        return {
          taskType: "coding",
          risk: "medium",
          selected: { id: "codex-technical", label: "Codex runtime" },
          independent: { id: "codex-technical", label: "Codex runtime" },
          independentRequired: false,
          reason: "shared runtime test route",
        };
      },
    },
    adapters: new Map([["codex-technical", adapter]]),
    eventStore: { emit: async () => {} },
    dataRoot: root,
    policy: policy(),
    approvalBroker: { request: async () => ({ decision: "accept" }), denyRun() {} },
    teams: {
      get(id) {
        if (id !== team.id) throw Object.assign(new Error("team not found"), { code: "SOURCE_NOT_FOUND" });
        return team;
      },
      brief() { return "[团队配置] Custom Codex Pair"; },
    },
    teamMembers,
    modelDiscovery: {
      async forAgent(runtimeProfileId) {
        discoveryProfiles.push(runtimeProfileId);
        return {
          models: [{ id: "gpt-explicit" }],
          effortLevels: ["max"],
        };
      },
    },
    capabilities: { agentDisabledSkills: async () => new Set() },
  };
  let orchestrator = await new Orchestrator(orchestratorOptions).init();
  t.after(async () => { await orchestrator.close(); await rm(root, { recursive: true, force: true }); });

  const originalSnapshot = teamMembers.snapshot;
  const originalGet = teamMembers.get;
  teamMembers.snapshot = () => [];
  teamMembers.get = () => undefined;
  await assert.rejects(
    () => orchestrator.snapshotTeamRoster(["missing-member"]),
    { code: "TEAM_MEMBER_SNAPSHOT_INVALID" },
    "缺失成员记录不能退化成同名 runtime identity",
  );
  teamMembers.snapshot = originalSnapshot;
  teamMembers.get = originalGet;

  const singleMemberRoster = [memberRecords.get("member-alpha")];
  const optionalSingleMemberRoute = orchestrator.mapRuntimeRoute({
    selected: { id: "codex-technical" },
    independent: { id: "codex-technical" },
    independentRequired: false,
  }, singleMemberRoster, ["member-alpha"]);
  assert.equal(optionalSingleMemberRoute.independent, null, "可选复核没有第二逻辑席时不伪装独立成员");
  assert.throws(
    () => orchestrator.mapRuntimeRoute({
      selected: { id: "codex-technical" },
      independent: { id: "codex-technical" },
      independentRequired: true,
    }, singleMemberRoster, ["member-alpha"]),
    { code: "NO_INDEPENDENT_ROUTE" },
    "强制独立复核必须映射到不同逻辑成员",
  );

  const preview = await orchestrator.create({
    prompt: "validate explicit runtime catalog",
    execute: false,
    permissionMode: "plan",
    teamId: team.id,
    startAgentId: "member-beta",
    model: "gpt-explicit",
    effort: "max",
  });
  assert.deepEqual(discoveryProfiles, ["codex-technical", "codex-technical"], "模型与 effort 目录按 runtime profile 查询");
  assert.equal(preview.startAgentId, "member-beta");

  const created = await orchestrator.create({
    prompt: "run both logical members",
    execute: true,
    permissionMode: "plan",
    teamId: team.id,
    orchestrationMode: "social",
    requestedAgentIds: ["member-alpha", "member-beta"],
    maxRounds: 6,
  });
  const completed = await waitTerminal(orchestrator, created.id);
  assert.equal(completed.status, "succeeded");
  assert.deepEqual(routeInputs.at(-1).allowedProviders, ["codex-technical"], "路由器只接收 runtime profile 白名单");
  assert.deepEqual(completed.teamMembers, ["member-alpha", "member-beta"]);
  assert.equal(completed.route.selected.id, "member-alpha");
  assert.equal(completed.route.selected.runtimeProfileId, "codex-technical");
  assert.equal(completed.route.independent.id, "member-beta", "相同 runtime 的独立席位仍映射到另一个逻辑成员");
  assert.equal(completed.route.independent.runtimeProfileId, "codex-technical");
  assert.ok(completed.teamRoster.every((member) => member.capabilities.length === 1 && member.capabilities[0] === "*"));
  const approvalMessage = orchestrator.buildApprovalMessage(completed);
  assert.equal(approvalMessage.params.selectedAgent, "member-alpha");
  assert.equal(approvalMessage.params.selectedRuntimeProfileId, "codex-technical");
  assert.equal(approvalMessage.params.model, "gpt-alpha-default");
  assert.equal(approvalMessage.params.effort, "high");
  assert.deepEqual(completed.sessions, {
    "member-alpha": "session-member-alpha",
    "member-beta": "session-member-beta",
  }, "同一 adapter 上的原生会话按逻辑成员隔离");
  assert.ok(completed.turns.every((turn) => ["member-alpha", "member-beta"].includes(turn.agentId)));

  const alphaCall = calls.find((call) => call.agentId === "member-alpha");
  const betaCall = calls.find((call) => call.agentId === "member-beta");
  assert.ok(alphaCall && betaCall);
  assert.equal(alphaCall.model, "gpt-alpha-default");
  assert.equal(alphaCall.effort, "high");
  assert.match(alphaCall.prompt, /memberId: member-alpha/);
  assert.match(alphaCall.prompt, /capabilities: \*/);
  assert.doesNotMatch(alphaCall.prompt, /capabilities: coding、review/);
  assert.match(alphaCall.prompt, /ALPHA_PERSONA: preserve implementation evidence/);
  assert.equal(betaCall.model, "gpt-beta-default");
  assert.equal(betaCall.effort, "xhigh");
  assert.match(betaCall.prompt, /memberId: member-beta/);
  assert.match(betaCall.prompt, /BETA_PERSONA: challenge unsupported completion claims/);
  assert.ok(calls.every((call) => call.sessionId == null || call.sessionId === `session-${call.agentId}`));

  const persisted = JSON.parse(await readFile(join(root, "runs", `${completed.id}.json`), "utf8"));
  assert.equal(persisted.teamRosterVersion, 1);
  assert.ok(persisted.teamRoster.every((member) => member.teamMemberEligible === true));
  assert.ok(persisted.teamRoster.every((member) => member.capabilities.length === 1 && member.capabilities[0] === "*"));
  assert.deepEqual(persisted.teamRoster.map(({ id, runtimeProfileId }) => ({ id, runtimeProfileId })), [
    { id: "member-alpha", runtimeProfileId: "codex-technical" },
    { id: "member-beta", runtimeProfileId: "codex-technical" },
  ]);
  assert.ok(rosterSnapshots.some((ids) => ids.join(",") === team.members.join(",")));
  const hints = orchestrator.resumeHintsForRun(completed);
  assert.deepEqual(hints.map(({ agentId, runtimeProfileId }) => ({ agentId, runtimeProfileId })), [
    { agentId: "member-alpha", runtimeProfileId: "codex-technical" },
    { agentId: "member-beta", runtimeProfileId: "codex-technical" },
  ]);
  assert.ok(hints.every((hint) => hint.canResume && hint.command.startsWith("codex resume ")));

  const continued = await orchestrator.continue(completed.id, {
    agentId: "member-beta",
    prompt: "continue the verifier session",
  });
  assert.equal(continued.status, "succeeded");
  const continuationCall = calls.at(-1);
  assert.equal(continuationCall.agentId, "member-beta");
  assert.equal(continuationCall.sessionId, "session-member-beta", "续聊沿逻辑成员取回隔离 session");

  const legacyRun = JSON.parse(await readFile(join(root, "runs", `${completed.id}.json`), "utf8"));
  legacyRun.teamRoster[0].capabilities = ["coding", "review"];
  legacyRun.teamRoster[1].capabilities = { review: true };
  await writeFile(join(root, "runs", `${completed.id}.json`), `${JSON.stringify(legacyRun, null, 2)}\n`, "utf8");
  await orchestrator.close();
  orchestrator = await new Orchestrator(orchestratorOptions).init();
  const migratedRun = orchestrator.get(completed.id);
  assert.ok(migratedRun.teamRoster.every((member) => member.capabilities.length === 1 && member.capabilities[0] === "*"));
  const migratedDisk = JSON.parse(await readFile(join(root, "runs", `${completed.id}.json`), "utf8"));
  assert.ok(migratedDisk.teamRoster.every((member) => member.capabilities.length === 1 && member.capabilities[0] === "*"), "旧 run roster 必须在重启恢复时回写默认全能力");
  await orchestrator.continue(completed.id, {
    agentId: "member-beta",
    prompt: "continue after legacy roster migration",
  });
  assert.match(calls.at(-1).prompt, /capabilities: \*/);
  assert.doesNotMatch(calls.at(-1).prompt, /capabilities: review/);

  orchestrator.adapters.delete("codex-technical");
  await assert.rejects(
    () => orchestrator.continue(completed.id, {
      agentId: "member-alpha",
      prompt: "must fail when the bound runtime disappears",
    }),
    { code: "ADAPTER_UNAVAILABLE" },
    "continue 的可用性检查必须解析到 runtime profile",
  );

  const primaryFallbackAttempts = [];
  const fallbackCalls = [];
  orchestrator.adapters.set("codex-technical", {
    id: "codex-app-server",
    cwd: root,
    async send(input) {
      primaryFallbackAttempts.push({ ...input });
      throw Object.assign(new Error("pre-submit app-server exit"), {
        code: "APP_SERVER_EXIT",
        safeToFallback: true,
      });
    },
    async close() {},
  });
  orchestrator.adapters.set("codex-technical-fallback", {
    id: "codex-cli",
    cwd: root,
    async send(input) {
      fallbackCalls.push({ ...input });
      return {
        sessionId: `fallback-${input.agentId}`,
        text: `${input.agentId} fallback completed`,
        protocol: "codex-exec-json",
      };
    },
    async close() {},
  });
  const fallbackResult = await orchestrator.continue(completed.id, {
    agentId: "member-alpha",
    prompt: "exercise the runtime fallback boundary",
  });
  assert.equal(fallbackResult.status, "succeeded");
  assert.equal(primaryFallbackAttempts.length, 1);
  assert.equal(primaryFallbackAttempts[0].agentId, "member-alpha");
  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0].agentId, "member-alpha", "fallback 仍接收逻辑成员身份");
  assert.equal(fallbackResult.sessions["member-alpha"], "fallback-member-alpha");
  assert.equal(fallbackResult.turns.at(-1).agentId, "member-alpha");

  const damagedRoster = { ...fallbackResult, teamRoster: null, teamRosterVersion: 1 };
  assert.throws(
    () => orchestrator.resumeHintsForRun(damagedRoster),
    { code: "TEAM_MEMBER_SNAPSHOT_INVALID" },
    "带版本的新 run 缺失 roster 时必须 fail-closed，不能走 legacy identity",
  );
  const missingRuntimeBinding = {
    ...fallbackResult,
    teamRoster: fallbackResult.teamRoster.map(({ runtimeProfileId, ...member }) => member),
    teamRosterVersion: 1,
  };
  assert.throws(
    () => orchestrator.resumeHintsForRun(missingRuntimeBinding),
    { code: "TEAM_MEMBER_SNAPSHOT_INVALID" },
    "v1 roster 必须显式持久化 runtimeProfileId",
  );
});

// LO 2026-08-08：Codex 余额不足 403 → 轮次判定 ambiguous、run 进入 recovery_required，
// 但 inflightTurns 仍挂着该成员。UI 据此显示"正在准备会话"，新消息被当成排队——
// 充值后既发不出去也恢复不了。inflight 是记账而非并发守卫，放弃该轮时必须一并作废。
test("acknowledging recovery clears the inflight turn bookkeeping so the run can continue", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: false, permissionMode: "plan" });
  const run = fx.orchestrator.get(created.id);
  run.status = "recovery_required";
  run.error = 'unexpected status 403 Forbidden: {"code":"INSUFFICIENT_BALANCE"}';
  run.inflightTurns = { "codex-technical": "attempt-ambiguous" };
  run.resumeClaim = { itemId: "item-1" };

  await fx.orchestrator.continue(created.id, { prompt: "余额已充值，继续", acknowledgeRecovery: true });

  const after = fx.orchestrator.get(created.id);
  assert.deepEqual(after.inflightTurns, {}, "确认恢复后 inflight 记账必须清空，否则成员永远显示在跑");
  assert.equal(after.resumeClaim, null);
  assert.ok(after.recoveryAcknowledgedAt, "确认时间戳应落盘");
});

test("HTTP-style continue returns after admission while the provider turn is still running", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, permissionMode: "plan" });
  const entered = deferred();
  const release = deferred();
  const target = fx.orchestrator.adapters.get("codex-technical");
  target.send = async (input) => {
    await input.onSessionStarted?.({ sessionId: "async-session", protocol: "mock" });
    entered.resolve();
    await release.promise;
    return { sessionId: "async-session", text: "done", protocol: "mock" };
  };

  const admitted = await Promise.race([
    fx.orchestrator.continue(created.id, {
      prompt: "长任务不要堵死 HTTP",
      agentId: "codex-technical",
      waitForTurn: false,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("admission timed out")), 3_000)),
  ]);
  assert.equal(admitted.status, "running");
  assert.equal(admitted.recoveryNote, null);
  const pending = fx.orchestrator.executions.get(`continue:${created.id}`);
  assert.ok(pending, "turn must keep running in executions after HTTP admission");
  await entered.promise;
  assert.ok(["running", "waiting_agent"].includes(fx.orchestrator.get(created.id).status));
  assert.equal(fx.orchestrator.controllers.has(created.id), true);

  release.resolve();
  const settled = await pending;
  assert.equal(settled.status, "succeeded");
});

test("HTTP-style background provider failure is owned and never becomes an unhandled rejection", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, permissionMode: "plan" });
  const failed = deferred();
  const target = fx.orchestrator.adapters.get("codex-technical");
  target.id = "codex-app-server";
  target.send = async (input) => {
    await input.onSessionStarted?.({ sessionId: "async-failed-session", protocol: "app-server-v2" });
    await input.onTurnSubmitting?.({ sessionId: "async-failed-session", protocol: "app-server-v2", clientUserMessageId: "async-failed-message" });
    failed.resolve();
    throw Object.assign(new Error("thread already has an active writer"), {
      code: "TURN_ACTIVE",
      submissionRejected: true,
      nativeSessionBusy: true,
      safeToFallback: false,
      sessionId: "async-failed-session",
    });
  };
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const admitted = await fx.orchestrator.continue(created.id, {
      prompt: "后台失败也必须有人接住",
      agentId: "codex-technical",
      waitForTurn: false,
    });
    assert.equal(admitted.status, "running");
    await failed.promise;
    const blocked = await waitTerminal(fx.orchestrator, created.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(blocked.status, "recovery_required");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("interrupt withdraws a pending build approval instead of no-op", async (t) => {
  const fx = await fixture({
    approvalRequest: () => new Promise(() => {}),
  });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({
    prompt: "write files",
    execute: true,
    permissionMode: "build",
    orchestrationMode: "pipeline",
  });
  assert.equal(created.status, "waiting_approval");

  const interrupted = await fx.orchestrator.interrupt(created.id);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.buildApproval.status, "withdrawn");
  assert.match(interrupted.recoveryNote, /withdrawn/i);
  assert.equal(fx.calls.length, 0, "撤回审批后不得开跑");
});

test("a late build approval cannot resurrect a withdrawn run", async (t) => {
  const hold = deferred();
  const fx = await fixture({
    approvalRequest: async () => {
      await hold.promise;
      return { decision: "accept", approvalId: "late-accept" };
    },
  });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const creating = fx.orchestrator.create({
    prompt: "write files",
    execute: true,
    permissionMode: "build",
    orchestrationMode: "pipeline",
  });
  let created;
  for (let i = 0; i < 50; i += 1) {
    created = [...fx.orchestrator.runs.values()].find((run) => run.status === "waiting_approval");
    if (created) break;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  assert.ok(created, "create must reach waiting_approval before the late accept");
  const interrupted = await fx.orchestrator.interrupt(created.id);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.buildApproval.status, "withdrawn");
  hold.resolve();
  await creating;
  const after = fx.orchestrator.get(created.id);
  assert.equal(after.status, "interrupted");
  assert.equal(after.buildApproval.status, "withdrawn");
  assert.equal(fx.calls.length, 0, "迟到的批准不得开跑");
});

test("interrupt discards the claimed social work so the next message does not revive it", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "route only", execute: false, permissionMode: "plan" });
  const run = fx.orchestrator.get(created.id);
  run.orchestrationMode = "social";
  run.teamMembers = ["codex-technical", "claude-fable"];
  run.coordinatorId = "claude-fable";
  run.resumeQueue = [{
    itemId: "claimed-work",
    to: "codex-technical",
    kind: "mention",
    busMessageId: "bus-claimed",
  }];
  run.resumeClaim = { itemId: "claimed-work", to: "codex-technical" };

  const entered = deferred();
  const target = fx.orchestrator.adapters.get("codex-technical");
  const successfulSend = target.send.bind(target);
  target.send = async (input) => {
    fx.calls.push({ id: "codex-technical", ...input });
    await input.onSessionStarted?.({ sessionId: "social-session", protocol: "mock" });
    entered.resolve();
    await new Promise((resolveTurn, rejectTurn) => {
      const rejectAbort = () => rejectTurn(Object.assign(new Error("turn interrupted"), {
        code: "ABORTED",
        interruptConfirmed: true,
        nativeTurnSettled: true,
      }));
      if (input.signal.aborted) rejectAbort();
      else input.signal.addEventListener("abort", rejectAbort, { once: true });
    });
  };

  const active = fx.orchestrator.continue(created.id, {
    prompt: "先派给 Codex",
    agentId: "codex-technical",
  });
  await entered.promise;
  const interrupted = await fx.orchestrator.interrupt(created.id);
  await active;
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.resumeClaim, null);
  assert.equal((interrupted.resumeQueue || []).some((item) => item.itemId === "claimed-work"), false);

  target.send = successfulSend;
  await fx.orchestrator.continue(created.id, { prompt: "换个方向", agentId: "claude-fable" });
  assert.equal(fx.calls.at(-1).prompt, "换个方向");
  assert.equal(fx.calls.filter((call) => call.prompt === "换个方向").length, 1);
  assert.equal(fx.orchestrator.get(created.id).resumeClaim, null);
});

test("an ambiguous attempt phase releases its inflight slot", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({ prompt: "implement", execute: false, permissionMode: "plan" });
  const run = fx.orchestrator.get(created.id);
  run.turnAttempts = [{ attemptId: "a1", round: 1, agentId: "codex-technical", phase: "submitted" }];
  run.inflightTurns = { "codex-technical": "a1" };

  await fx.orchestrator.checkpointTurn(run, "codex-technical", "a1", "ambiguous", {});

  assert.equal(run.inflightTurns["codex-technical"], undefined, "ambiguous 是终结相位，不得继续占用 inflight 槽位");
});

// LO 2026-08-30 预算"无限"语义：unlimited 哨兵贯穿解析/创建/热改/adapter 透传。
// "无限"= 真无限（不按美元止损）——硬上限门槛已废；数字预算仅受 50 防手滑天花板约束。
test("unlimited budget resolves to true infinity without a hard cap and numeric paths stay clamped", () => {
  assert.equal(UNLIMITED_BUDGET, "unlimited");
  assert.equal(isUnlimitedBudgetValue("unlimited"), true);
  assert.equal(isUnlimitedBudgetValue("∞"), true);
  assert.equal(isUnlimitedBudgetValue("Infinity"), true);
  assert.equal(isUnlimitedBudgetValue(2), false);
  assert.equal(isUnlimitedBudgetValue(null), false);
  // "无限"就是无限：遗留 maxBudgetUsdPerTurn（安全硬上限）不再参与钳制
  assert.equal(resolveBudgetUsdPerTurn("unlimited", policy()), Number.POSITIVE_INFINITY);
  assert.equal(resolveBudgetUsdPerTurn("unlimited", { limits: { maxBudgetUsdPerTurn: 2 } }), Number.POSITIVE_INFINITY);
  assert.equal(resolveBudgetUsdPerTurn("unlimited", {}), Number.POSITIVE_INFINITY);
  // 数字预算：防手滑天花板 50；低于下限回 legacy 默认、缺省走默认预算（既有行为不变）
  assert.equal(resolveBudgetUsdPerTurn(80, {}), 50);
  assert.equal(resolveBudgetUsdPerTurn(undefined, { limits: { defaultBudgetUsdPerTurn: "unlimited" } }), Number.POSITIVE_INFINITY);
  assert.equal(resolveBudgetUsdPerTurn(0.5, { limits: { defaultBudgetUsdPerTurn: "unlimited" } }), 0.5);
  assert.equal(resolveBudgetUsdPerTurn(undefined, { limits: { maxBudgetUsdPerTurn: 2, defaultBudgetUsdPerTurn: "unlimited" } }), Number.POSITIVE_INFINITY);
  assert.equal(resolveBudgetUsdPerTurn(0.01, policy()), 0.75);
  assert.equal(resolveBudgetUsdPerTurn(undefined, policy()), 0.75);
});

test("unlimited budget run stores the sentinel, withholds the numeric cap from adapters and hot-round-trips", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const created = await fx.orchestrator.create({
    prompt: "unlimited", execute: true, orchestrationMode: "pipeline", maxRounds: 3, permissionMode: "plan",
    maxBudgetUsdPerTurn: "unlimited",
  });
  assert.equal(created.maxBudgetUsdPerTurn, "unlimited", "run must persist the sentinel verbatim (JSON-safe)");
  const completed = await waitTerminal(fx.orchestrator, created.id);
  assert.equal(completed.status, "succeeded", "unlimited budget must not stop a cheap run");
  assert.equal(fx.calls[0].maxBudgetUsd, null, "adapters get null (=omit budget flag) instead of a fake numeric cap");

  // 热改往返：unlimited ↔ 数字；别名 ∞ 归一为哨兵；非法值仍被拒
  await fx.orchestrator.updateRunControls(created.id, { maxBudgetUsdPerTurn: 1 });
  assert.equal(fx.orchestrator.get(created.id).maxBudgetUsdPerTurn, 1);
  await fx.orchestrator.updateRunControls(created.id, { maxBudgetUsdPerTurn: "∞" });
  assert.equal(fx.orchestrator.get(created.id).maxBudgetUsdPerTurn, "unlimited");
  await assert.rejects(
    () => fx.orchestrator.updateRunControls(created.id, { maxBudgetUsdPerTurn: 0.01 }),
    { code: "VALIDATION_FAILED" },
  );
});

test("W3.5 shadow pair forks a second read-only run with shadowOf linkage", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const { primary, shadow } = await fx.orchestrator.createShadowPair({
    prompt: "shadow task",
    execute: false,
    permissionMode: "plan",
    startAgentId: "claude-fable",
    shadowAgentId: "codex-technical",
  });
  assert.notEqual(primary.id, shadow.id);
  assert.equal(shadow.shadowOf, primary.id);
  assert.equal(shadow.startAgentId, "codex-technical");
  assert.equal(shadow.permissionMode, "plan");
  assert.equal(primary.permissionMode, "plan");

  await assert.rejects(
    () => fx.orchestrator.createShadowPair({ prompt: "no shadow target", execute: false }),
    { code: "VALIDATION_FAILED" },
  );
});
