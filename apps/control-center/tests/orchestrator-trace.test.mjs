import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

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

async function setup() {
  const root = await mkdtemp(resolve(appRoot, ".test-orchestrator-trace-"));
  const emitted = [];
  const adapter = (id) => ({
    id,
    cwd: root,
    async send(input) {
      await input.onSessionStarted?.({ sessionId: `${id}-session`, protocol: `${id}-mock` });
      await input.onTurnSubmitting?.({ sessionId: `${id}-session`, protocol: `${id}-mock`, clientUserMessageId: `${id}-msg` });
      await input.onTurnAccepted?.({ sessionId: `${id}-session`, protocol: `${id}-mock`, clientUserMessageId: `${id}-msg`, turnId: `${id}-turn` });
      return { sessionId: `${id}-session`, text: `${id}-ok`, protocol: `${id}-mock`, tokens: 100, costUsd: 0.01 };
    },
    async close() {},
  });
  const adapters = new Map([
    ["claude-fable", adapter("claude-fable")],
    ["codex-technical", adapter("codex-technical")],
  ]);
  const orchestrator = await new Orchestrator({
    router: { preview: async ({ requestedProvider } = {}) => route(requestedProvider || "codex-technical") },
    adapters,
    eventStore: { emit: async (type, data, context) => { emitted.push({ type, data, context }); } },
    dataRoot: root,
    policy: policy(),
    approvalBroker: { request: async () => ({ decision: "accept", approvalId: "approval-fix" }), denyRun() {} },
  }).init();
  return { root, orchestrator, emitted };
}

test("OB-01: create() with correlationId threads it into subsequent emitEvent calls", async (t) => {
  const fx = await setup();
  t.after(async () => { try { await fx.orchestrator.close(); } catch {} await rm(fx.root, { recursive: true, force: true }); });

  const run = await fx.orchestrator.create(
    { prompt: "hello", idempotencyKey: "ob01-create-test" },
    { correlationId: "req-abc-123" },
  );
  assert.ok(run.id, "run should be created");

  await fx.orchestrator.emitEvent(run, "test.trace", { hello: "world" });

  const traceEvent = fx.emitted.find((e) => e.type === "test.trace");
  assert.ok(traceEvent, "emitEvent should have been captured");
  assert.equal(traceEvent.context.correlationId, "req-abc-123", "correlationId should propagate to event envelope");
});

test("OB-01: cancel() with correlationId threads it into subsequent emitEvent calls", async (t) => {
  const fx = await setup();
  t.after(async () => { try { await fx.orchestrator.close(); } catch {} await rm(fx.root, { recursive: true, force: true }); });

  const run = await fx.orchestrator.create({ prompt: "to cancel" });
  await fx.orchestrator.cancel(run.id, { correlationId: "req-cancel-456" });

  await fx.orchestrator.emitEvent(run, "test.cancel-trace", {});

  const traceEvent = fx.emitted.find((e) => e.type === "test.cancel-trace");
  assert.ok(traceEvent, "emitEvent after cancel should be captured");
  assert.equal(traceEvent.context.correlationId, "req-cancel-456", "cancel correlationId should propagate");
});

test("OB-01: emitEvent context correlationId takes precedence over WeakMap value", async (t) => {
  const fx = await setup();
  t.after(async () => { try { await fx.orchestrator.close(); } catch {} await rm(fx.root, { recursive: true, force: true }); });

  const run = await fx.orchestrator.create(
    { prompt: "override test" },
    { correlationId: "req-original" },
  );

  await fx.orchestrator.emitEvent(run, "test.explicit", {}, { correlationId: "req-explicit-override" });

  const traceEvent = fx.emitted.find((e) => e.type === "test.explicit");
  assert.ok(traceEvent);
  assert.equal(traceEvent.context.correlationId, "req-explicit-override", "explicit context should win over WeakMap");
});

test("OB-01: emitEvent without any correlationId produces null", async (t) => {
  const fx = await setup();
  t.after(async () => { try { await fx.orchestrator.close(); } catch {} await rm(fx.root, { recursive: true, force: true }); });

  const run = await fx.orchestrator.create({ prompt: "no trace" });

  await fx.orchestrator.emitEvent(run, "test.no-trace", {});

  const traceEvent = fx.emitted.find((e) => e.type === "test.no-trace");
  assert.ok(traceEvent);
  assert.equal(traceEvent.context.correlationId, null, "no correlationId should produce null");
});

test("OB-01: createShadowPair threads correlationId to both primary and shadow", async (t) => {
  const fx = await setup();
  t.after(async () => { try { await fx.orchestrator.close(); } catch {} await rm(fx.root, { recursive: true, force: true }); });

  const { primary, shadow } = await fx.orchestrator.createShadowPair(
    { prompt: "shadow test", shadowAgentId: "claude-fable" },
    { correlationId: "req-shadow-789" },
  );

  await fx.orchestrator.emitEvent(primary, "test.primary-trace", {});
  await fx.orchestrator.emitEvent(shadow, "test.shadow-trace", {});

  const primaryEvent = fx.emitted.find((e) => e.type === "test.primary-trace");
  const shadowEvent = fx.emitted.find((e) => e.type === "test.shadow-trace");
  assert.ok(primaryEvent);
  assert.ok(shadowEvent);
  assert.equal(primaryEvent.context.correlationId, "req-shadow-789", "primary should carry shadow pair correlationId");
  assert.equal(shadowEvent.context.correlationId, "req-shadow-789", "shadow should carry shadow pair correlationId");
});
