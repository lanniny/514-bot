import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventStore } from "../src/event-store.mjs";
import { projectRunReplay } from "../src/run-replay.mjs";
import { projectMissionControl } from "../src/mission-control.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

async function createStore() {
  const root = await mkdtemp(resolve(appRoot, ".test-ob02-"));
  const store = await new EventStore(resolve(root, "events.jsonl")).init();
  return { root, store };
}

test("OB-02: sequenceTip returns current event sequence counter", async (t) => {
  const fx = await createStore();
  t.after(async () => { await fx.store.close().catch(() => {}); await rm(fx.root, { recursive: true, force: true }); });

  assert.equal(fx.store.sequenceTip(), 0, "empty store starts at sequence 0");

  await fx.store.emit("run.created", { runId: "r1" }, { runId: "r1" });
  await fx.store.emit("run.updated", { runId: "r1" }, { runId: "r1" });
  assert.equal(fx.store.sequenceTip(), 2, "sequence advances with each emit");

  await fx.store.emit("run.completed", { runId: "r1" }, { runId: "r1" });
  assert.equal(fx.store.sequenceTip(), 3, "sequence is monotonic");
});

test("OB-02: projectRunReplay includes asOfSequence in output", () => {
  const run = { id: "run-001", status: "completed", createdAt: "2026-01-01T00:00:00Z" };
  const result = projectRunReplay({
    run,
    events: [],
    busMessages: [],
    approvals: [],
    asOfSequence: 42,
  });
  assert.equal(result.asOfSequence, 42, "asOfSequence should be in replay output");
});

test("OB-02: projectRunReplay defaults asOfSequence to null", () => {
  const run = { id: "run-002", status: "running", createdAt: "2026-01-01T00:00:00Z" };
  const result = projectRunReplay({ run });
  assert.equal(result.asOfSequence, null, "asOfSequence should default to null when not provided");
});

test("OB-02: projectMissionControl includes asOfSequence in output", () => {
  const run = {
    id: "run-003",
    status: "completed",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T01:00:00Z",
    prompt: "test",
    taskType: "coding",
    startAgentId: "codex",
  };
  const result = projectMissionControl({
    run,
    events: [],
    busMessages: [],
    approvals: [],
    health: [],
    asOfSequence: 99,
  });
  assert.equal(result.asOfSequence, 99, "asOfSequence should be in mission control output");
});

test("OB-02: projectMissionControl defaults asOfSequence to null", () => {
  const run = {
    id: "run-004",
    status: "running",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T01:00:00Z",
    prompt: "test",
    taskType: "coding",
    startAgentId: "codex",
  };
  const result = projectMissionControl({ run });
  assert.equal(result.asOfSequence, null, "asOfSequence should default to null when not provided");
});

test("OB-02: events endpoint cursor filters by afterSequence", async (t) => {
  const fx = await createStore();
  t.after(async () => { await fx.store.close().catch(() => {}); await rm(fx.root, { recursive: true, force: true }); });

  await fx.store.emit("run.created", { index: 1 }, { runId: "run-x" });
  await fx.store.emit("run.updated", { index: 2 }, { runId: "run-x" });
  await fx.store.emit("run.updated", { index: 3 }, { runId: "run-x" });
  await fx.store.emit("run.completed", { index: 4 }, { runId: "run-x" });

  const allEvents = await fx.store.listByRun("run-x", 100);
  assert.equal(allEvents.length, 4, "all 4 events for run-x");

  const afterSequence = 2;
  const filtered = allEvents.filter((event) => event.sequence > afterSequence);
  assert.equal(filtered.length, 2, "after=2 should yield events with sequence 3 and 4");
  assert.equal(filtered[0].data.index, 3);
  assert.equal(filtered[1].data.index, 4);

  const asOfSequence = fx.store.sequenceTip();
  assert.equal(asOfSequence, 4, "asOfSequence should reflect total emits");

  const nextCursor = filtered.length ? filtered[filtered.length - 1].sequence : null;
  assert.equal(nextCursor, 4, "nextCursor should be the last returned event's sequence");
});
