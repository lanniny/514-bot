import test from "node:test";
import assert from "node:assert/strict";
import {
  settlementRunSignature,
  settlementViewNeedsRefresh,
  createConversationRunProjection,
  SETTLEMENT_VIEW_TTL_MS,
} from "../public/modules/conversation-run-projection.js";

function makeRun(id, overrides = {}) {
  return { id, status: "completed", updatedAt: "2026-09-01T00:00:00Z", round: 1, ...overrides };
}

function makeProjection({ runs = [], now = 0, surfaces } = {}) {
  let clock = now;
  const projection = createConversationRunProjection({
    getRuns: () => runs,
    surfaces: surfaces ?? { workbench: { capacity: 1 }, bot: {} },
    now: () => clock,
    queueMicrotaskFn: (fn) => fn(),
  });
  return { projection, advance: (ms) => { clock += ms; }, setClock: (ms) => { clock = ms; } };
}

test("settlementRunSignature: golden vector", () => {
  const run = makeRun("abc-123", {
    status: "completed",
    updatedAt: "2026-09-01T00:00:00Z",
    round: 2,
    worktreePath: "/tmp/wt",
    worktreeBase: "main",
    remote: { hostId: "h1", path: "/remote/p" },
    recoveryRequired: true,
    error: "boom",
  });
  const sig = settlementRunSignature(run);
  assert.equal(sig, "abc-123|completed|2026-09-01T00:00:00Z|2|/tmp/wt|main|h1:/remote/p|recovery|boom");
});

test("settlementRunSignature: null/undefined run returns empty string", () => {
  assert.equal(settlementRunSignature(null), "");
  assert.equal(settlementRunSignature(undefined), "");
  assert.equal(settlementRunSignature({}), "");
});

test("settlementViewNeedsRefresh: null view needs refresh", () => {
  assert.equal(settlementViewNeedsRefresh(null, makeRun("x"), SETTLEMENT_VIEW_TTL_MS), true);
});

test("settlementViewNeedsRefresh: loading view never needs refresh", () => {
  const view = { status: "loading", runSignature: "sig" };
  assert.equal(settlementViewNeedsRefresh(view, makeRun("x"), SETTLEMENT_VIEW_TTL_MS), false);
});

test("settlementViewNeedsRefresh: signature mismatch triggers refresh", () => {
  const view = { status: "ok", runSignature: "old-sig", loadedAt: Date.now() };
  const run = makeRun("x", { status: "failed" });
  assert.equal(settlementViewNeedsRefresh(view, run, SETTLEMENT_VIEW_TTL_MS), true);
});

test("settlementViewNeedsRefresh: TTL boundary uses >=", () => {
  const run = makeRun("x");
  const sig = settlementRunSignature(run);
  const ttl = 500;
  const fresh = { status: "ok", runSignature: sig, loadedAt: Date.now() };
  assert.equal(settlementViewNeedsRefresh(fresh, run, ttl), false);
  const expired = { status: "ok", runSignature: sig, loadedAt: Date.now() - ttl };
  assert.equal(settlementViewNeedsRefresh(expired, run, ttl), true);
});

test("resolveRun: authoritative list takes priority over snapshot", () => {
  const authoritative = makeRun("r1", { status: "running" });
  const snapshot = makeRun("r1", { status: "completed" });
  const { projection } = makeProjection({ runs: [authoritative] });
  projection.rememberSnapshot(snapshot);
  assert.equal(projection.resolveRun("r1").status, "running");
});

test("resolveRun: falls back to unexpired snapshot", () => {
  const { projection, advance } = makeProjection({ runs: [] });
  projection.rememberSnapshot(makeRun("r1"));
  assert.ok(projection.resolveRun("r1"));
  advance(SETTLEMENT_VIEW_TTL_MS + 1);
  assert.equal(projection.resolveRun("r1"), null);
});

test("resolveRunStrict: never falls back to snapshot", () => {
  const { projection } = makeProjection({ runs: [] });
  projection.rememberSnapshot(makeRun("r1"));
  assert.equal(projection.resolveRunStrict("r1"), null);
});

test("isOptimistic: true for unexpired snapshot, false after expiry", () => {
  const { projection, advance } = makeProjection({ runs: [] });
  projection.rememberSnapshot(makeRun("r1"));
  assert.equal(projection.isOptimistic("r1"), true);
  advance(SETTLEMENT_VIEW_TTL_MS + 1);
  assert.equal(projection.isOptimistic("r1"), false);
});

test("rememberSnapshot with optimistic=false has no expiry", () => {
  const { projection, advance } = makeProjection({ runs: [] });
  projection.rememberSnapshot(makeRun("r1"), { optimistic: false });
  advance(SETTLEMENT_VIEW_TTL_MS * 100);
  assert.ok(projection.resolveRun("r1"));
  assert.equal(projection.isOptimistic("r1"), false);
});

test("promoteSnapshot: removes expiry", () => {
  const { projection, advance } = makeProjection({ runs: [] });
  projection.rememberSnapshot(makeRun("r1"));
  projection.promoteSnapshot(makeRun("r1", { status: "running" }));
  advance(SETTLEMENT_VIEW_TTL_MS + 1);
  assert.ok(projection.resolveRun("r1"));
  assert.equal(projection.isOptimistic("r1"), false);
});

test("pruneExpiredSnapshots: keeps live + unexpired, drops expired orphans", () => {
  const { projection, advance } = makeProjection({ runs: [makeRun("live")] });
  projection.rememberSnapshot(makeRun("live"));
  projection.rememberSnapshot(makeRun("orphan-expired"));
  advance(SETTLEMENT_VIEW_TTL_MS + 1);
  projection.rememberSnapshot(makeRun("orphan-alive"));
  projection.pruneExpiredSnapshots(["live"]);
  assert.ok(projection.resolveRun("live"));
  assert.equal(projection.resolveRun("orphan-expired"), null);
  assert.ok(projection.resolveRun("orphan-alive"));
});

test("forgetSnapshot: removes both snapshot and expiry", () => {
  const { projection } = makeProjection({ runs: [] });
  projection.rememberSnapshot(makeRun("r1"));
  projection.forgetSnapshot("r1");
  assert.equal(projection.resolveRun("r1"), null);
});

test("settlement cache: workbench capacity=1 evicts previous run", () => {
  const { projection } = makeProjection();
  projection.setSettlementView("workbench", "r1", { status: "ok", data: {} });
  projection.setSettlementView("workbench", "r2", { status: "ok", data: {} });
  assert.equal(projection.settlementView("workbench", "r1"), null);
  assert.ok(projection.settlementView("workbench", "r2"));
});

test("settlement cache: bot surface has no capacity limit", () => {
  const { projection } = makeProjection();
  projection.setSettlementView("bot", "r1", { status: "ok" });
  projection.setSettlementView("bot", "r2", { status: "ok" });
  assert.ok(projection.settlementView("bot", "r1"));
  assert.ok(projection.settlementView("bot", "r2"));
});

test("settlement cache: surface isolation", () => {
  const { projection } = makeProjection();
  projection.setSettlementView("workbench", "r1", { status: "ok", data: "wb" });
  projection.setSettlementView("bot", "r1", { status: "ok", data: "bot" });
  assert.equal(projection.settlementView("workbench", "r1").data, "wb");
  assert.equal(projection.settlementView("bot", "r1").data, "bot");
});

test("clearSettlementView bumps generation", () => {
  const { projection } = makeProjection();
  projection.setSettlementView("bot", "r1", { status: "ok" });
  const gen = projection.clearSettlementView("bot", "r1");
  assert.equal(gen, 1);
  assert.equal(projection.settlementView("bot", "r1"), null);
  assert.equal(projection.settlementGeneration("bot", "r1"), 1);
});

test("clearSettlementSurface bumps all generations on surface", () => {
  const { projection } = makeProjection();
  projection.setSettlementView("bot", "r1", { status: "ok" });
  projection.setSettlementView("bot", "r2", { status: "ok" });
  projection.clearSettlementSurface("bot");
  assert.equal(projection.settlementView("bot", "r1"), null);
  assert.equal(projection.settlementView("bot", "r2"), null);
  assert.ok(projection.settlementGeneration("bot", "r1") >= 1);
  assert.ok(projection.settlementGeneration("bot", "r2") >= 1);
});

test("nextSettlementGeneration: bumps and returns", () => {
  const { projection } = makeProjection();
  assert.equal(projection.nextSettlementGeneration("bot", "r1"), 1);
  assert.equal(projection.nextSettlementGeneration("bot", "r1"), 2);
  assert.equal(projection.settlementGeneration("bot", "r1"), 2);
});

test("queueSettlementLoad: deduplicates within same microtask", () => {
  const calls = [];
  const tasks = [];
  const { projection } = makeProjection();
  const projectionWithSyncQueue = createConversationRunProjection({
    getRuns: () => [],
    surfaces: { bot: {} },
    queueMicrotaskFn: (fn) => tasks.push(fn),
  });
  projectionWithSyncQueue.queueSettlementLoad("bot", "r1", () => calls.push("a"));
  projectionWithSyncQueue.queueSettlementLoad("bot", "r1", () => calls.push("b"));
  assert.equal(tasks.length, 1);
  tasks.forEach((fn) => fn());
  assert.deepEqual(calls, ["a"]);
});

test("settlementNeedsRefresh: delegates to view + run signature check", () => {
  const { projection } = makeProjection();
  const run = makeRun("r1");
  assert.equal(projection.settlementNeedsRefresh("bot", "r1", run), true);
  projection.setSettlementView("bot", "r1", {
    status: "ok",
    runSignature: settlementRunSignature(run),
    loadedAt: Date.now(),
  });
  assert.equal(projection.settlementNeedsRefresh("bot", "r1", run), false);
});
