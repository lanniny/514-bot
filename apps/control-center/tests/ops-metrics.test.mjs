import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  OPS_METRICS_SCHEMA,
  collectOpsMetrics,
  synthesizeOpsMetrics,
} from "../src/ops-metrics.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const NOW = Date.parse("2026-08-18T10:00:00.000Z");

test("empty live window keeps rates and cost means unknown, not zero", () => {
  const metrics = synthesizeOpsMetrics({ now: NOW });
  assert.equal(metrics.schema, OPS_METRICS_SCHEMA);
  assert.equal(metrics.outcomes.successRate, null);
  assert.equal(metrics.outcomes.failureRate, null);
  assert.equal(metrics.outcomes.recoveryRate, null);
  assert.equal(metrics.evidence.rate, null);
  assert.equal(metrics.costUsd.availability, null);
  assert.equal(metrics.costUsd.knownTotalUsd, null);
  assert.equal(metrics.costUsd.knownMeanUsd, null);
  assert.equal(metrics.firstUsefulResponse.p50Ms, null);
  assert.equal(metrics.approvalWait.p50Ms, null);
  assert.equal(metrics.promptTransport.failures, 0);
});

test("missing costUsd is unknown and never averaged as zero", () => {
  const metrics = synthesizeOpsMetrics({
    now: NOW,
    runs: [{
      id: "run-cost",
      execute: true,
      status: "succeeded",
      createdAt: "2026-08-18T09:59:00.000Z",
      turns: [
        { role: "assistant", outcome: "completed", text: "ok", createdAt: "2026-08-18T09:59:02.000Z", costUsd: 1.5 },
        { role: "assistant", outcome: "completed", text: "also", createdAt: "2026-08-18T09:59:04.000Z", costUsd: null },
        { role: "assistant", outcome: "incomplete", text: "", createdAt: "2026-08-18T09:59:05.000Z" },
      ],
    }],
  });
  assert.equal(metrics.costUsd.receiptTurns, 3);
  assert.equal(metrics.costUsd.known, 1);
  assert.equal(metrics.costUsd.unknown, 2);
  assert.equal(metrics.costUsd.availability, 1 / 3);
  assert.equal(metrics.costUsd.knownTotalUsd, 1.5);
  assert.equal(metrics.costUsd.knownMeanUsd, 1.5);
  assert.notEqual(metrics.costUsd.knownMeanUsd, 0.5);
});

test("first useful response ignores dry-run previews and missing timestamps", () => {
  const metrics = synthesizeOpsMetrics({
    now: NOW,
    runs: [
      {
        id: "preview",
        execute: false,
        status: "succeeded",
        createdAt: "2026-08-18T09:59:00.000Z",
        result: { type: "route-preview" },
      },
      {
        id: "useful",
        execute: true,
        status: "succeeded",
        createdAt: "2026-08-18T09:59:00.000Z",
        turns: [{
          role: "assistant",
          outcome: "completed",
          text: "你好",
          createdAt: "2026-08-18T09:59:04.000Z",
          costUsd: 0.2,
        }],
      },
      {
        id: "no-clock",
        execute: true,
        status: "failed",
        createdAt: "not-a-date",
        turns: [],
      },
    ],
  });
  assert.equal(metrics.firstUsefulResponse.samples, 1);
  assert.equal(metrics.firstUsefulResponse.unknown, 1);
  assert.equal(metrics.firstUsefulResponse.p50Ms, 4000);
  assert.equal(metrics.outcomes.successRate, 2 / 3);
  assert.equal(metrics.outcomes.failureRate, 1 / 3);
  assert.equal(metrics.evidence.terminal, 2);
  assert.equal(metrics.evidence.complete, 1);
});

test("first useful response uses the earliest valid timestamp, not array order", () => {
  const metrics = synthesizeOpsMetrics({
    now: NOW,
    runs: [{
      id: "out-of-order",
      execute: true,
      status: "succeeded",
      createdAt: "2026-08-18T09:59:00.000Z",
      turns: [
        { role: "assistant", outcome: "completed", text: "later", createdAt: "2026-08-18T09:59:09.000Z" },
        { role: "assistant", outcome: "completed", text: "invalid", createdAt: "not-a-date" },
        { role: "assistant", outcome: "completed", text: "earliest", createdAt: "2026-08-18T09:59:02.000Z" },
      ],
    }],
  });
  assert.equal(metrics.firstUsefulResponse.samples, 1);
  assert.equal(metrics.firstUsefulResponse.unknown, 0);
  assert.equal(metrics.firstUsefulResponse.p50Ms, 2000);
});

test("a worktree path alone is not complete run evidence", () => {
  const metrics = synthesizeOpsMetrics({
    now: NOW,
    runs: [{
      id: "failed-worktree-only",
      execute: true,
      status: "failed",
      createdAt: "2026-08-18T09:59:00.000Z",
      worktreePath: "C:/worktrees/stale-run",
      turns: [],
    }],
  });
  assert.equal(metrics.evidence.terminal, 1);
  assert.equal(metrics.evidence.complete, 0);
  assert.equal(metrics.evidence.rate, 0);
});

test("stale health cache and stale in-flight runs add, and prompt transport is counted by code", () => {
  const metrics = synthesizeOpsMetrics({
    now: NOW,
    runs: [
      {
        id: "stale-run",
        execute: true,
        status: "running",
        createdAt: "2026-08-18T09:50:00.000Z",
        updatedAt: "2026-08-18T09:50:00.000Z",
        route: { fallbackUsed: true },
        adapterFallbackCount: 2,
        error: { code: "PROMPT_TRANSPORT_CORRUPT" },
      },
    ],
    approvals: [{ id: "appr-1", status: "pending", createdAt: "2026-08-18T09:59:30.000Z" }],
    healthMeta: {
      available: false,
      stale: true,
      ageMs: null,
      ttlMs: 30_000,
      items: [],
      profileCount: 4,
    },
  });
  assert.equal(metrics.stale.staleHealthItemCount, 4);
  assert.equal(metrics.stale.staleRunCount, 1);
  assert.equal(metrics.stale.total, 5);
  assert.equal(metrics.routeFallback.runs, 1);
  assert.equal(metrics.routeFallback.adapterEvents, 2);
  assert.equal(metrics.routeFallback.events, 3);
  assert.equal(metrics.approvalWait.pending, 1);
  assert.equal(metrics.approvalWait.p50Ms, 30_000);
  assert.equal(metrics.promptTransport.failures, 1);
  assert.equal(metrics.promptTransport.codes.PROMPT_TRANSPORT_CORRUPT, 1);
});

test("collectOpsMetrics reads live stores without inventing a health probe", () => {
  let peeked = 0;
  const metrics = collectOpsMetrics({
    now: NOW,
    orchestrator: { list: () => [] },
    approvalBroker: { list: () => [] },
    healthService: {
      peekMeta() {
        peeked += 1;
        return { available: true, stale: false, ageMs: 12, ttlMs: 30_000, items: [{ id: "a" }], profileCount: 1 };
      },
      all() {
        throw new Error("ops metrics must not probe health");
      },
    },
  });
  assert.equal(peeked, 1);
  assert.equal(metrics.stale.healthCacheStale, false);
  assert.equal(metrics.stale.staleHealthItemCount, 0);
});

test("observability UI and API expose ops metrics without treating unknown as zero", async () => {
  const [api, html, app, mod, server] = await Promise.all([
    readFile(`${root}/public/api.js`, "utf8"),
    readFile(`${root}/public/index.html`, "utf8"),
    readFile(`${root}/public/app.js`, "utf8"),
    readFile(`${root}/public/modules/observability-page.js`, "utf8"),
    readFile(`${root}/server.mjs`, "utf8"),
  ]);
  assert.match(api, /obsOps:\s*"\/api\/observability\/ops"/);
  assert.match(server, /\/api\/observability\/ops/);
  assert.match(html, /id="obs-ops-body"/);
  assert.match(html, /运营指标/);
  assert.match(mod, /API\.obsOps/);
  assert.match(mod, /未知/);
  assert.match(mod, /knownMeanUsd/);
  assert.doesNotMatch(mod, /costUsd\.knownMeanUsd \|\| 0/);
});
