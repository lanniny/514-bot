import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { collectRunSettlement, RUN_SETTLEMENT_SCHEMA } from "../src/run-settlement.mjs";
import {
  VALUE_PROOF_CARD,
  VALUE_PROOF_TARGETS,
  formatValueProofDuration,
  projectValueProof,
  runDurationMs,
  valueProofCardMarkup,
} from "../public/modules/value-proof-card.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

const SUCCEEDED_RUN = Object.freeze({
  id: "run-settlement-1",
  status: "succeeded",
  createdAt: "2026-09-09T10:00:00.000Z",
  completedAt: "2026-09-09T10:02:14.000Z",
  orchestrationMode: "social",
  startAgentId: "claude-fable",
  startRuntimeProfileId: "claude-fable",
  worktreePath: "I:/tmp/demo-repo-wt-20260818153000-abcd1234",
  worktreeBase: "I:/tmp/demo-repo",
  taskGraph: { tasks: [{ id: "t1" }, { id: "t2" }] },
});

function assertNoFabricatedMetrics(value) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /savedMinutes|valueUsd|hoursSaved|手工步骤|¥|￥/);
  assert.doesNotMatch(text, /"roi"|worthUsd|estimatedSavings/);
}

test("duration comes from createdAt/completedAt and stays omitted when clocks are missing", () => {
  assert.equal(runDurationMs(SUCCEEDED_RUN), 134_000);
  assert.equal(formatValueProofDuration(134_000), "2 分 14 秒");
  assert.equal(runDurationMs({ id: "run-x", status: "succeeded" }), null);
  const bare = projectValueProof({ run: { id: "run-x", status: "succeeded" } });
  assert.equal(bare.shown, true);
  assert.ok(!bare.signals.some((item) => item.id === "duration"));
  assertNoFabricatedMetrics(bare);
});

test("failed runs do not get a value-proof card", () => {
  const model = projectValueProof({
    run: { ...SUCCEEDED_RUN, status: "failed" },
    settlement: { schema: RUN_SETTLEMENT_SCHEMA, artifacts: [{ id: "a", kind: "delta" }] },
  });
  assert.equal(model.shown, false);
  assert.equal(valueProofCardMarkup(model), "");
});

test("projects honest signals from a real collectRunSettlement envelope", async () => {
  const settlement = await collectRunSettlement({
    run: SUCCEEDED_RUN,
    handoffs: [
      { name: "codex-to-claude__run-settlement-1__20260909-1200.md", modifiedAt: "2026-09-09T12:00:00.000Z", exists: true },
      { name: "codex-to-claude__other-run__20260909-1201.md", modifiedAt: "2026-09-09T12:01:00.000Z", exists: true },
    ],
    deltas: [
      { id: "handoff#1", agent: "烛", score: 1, topic: "settlement-1", evidence: "run-settlement-1 diff" },
      { id: "handoff#2", agent: "烛", score: 1, topic: "other-run", evidence: "unrelated" },
    ],
  });
  assert.equal(settlement.schema, RUN_SETTLEMENT_SCHEMA);
  assert.deepEqual(settlement.artifacts.map((item) => item.kind), ["handoff", "delta"]);

  const model = projectValueProof({
    run: SUCCEEDED_RUN,
    settlement,
    events: [
      { runId: "run-settlement-1", type: "run.completed" },
      { runId: "other-run", type: "run.completed" },
    ],
  });
  assert.equal(model.schema, VALUE_PROOF_CARD);
  assert.equal(model.shown, true);
  assert.equal(model.signals.find((item) => item.id === "route")?.value, "social · claude-fable · claude-fable");
  assert.equal(model.signals.find((item) => item.id === "duration")?.value, "2 分 14 秒");
  assert.equal(model.signals.find((item) => item.id === "evidence")?.count, 2);
  assert.equal(model.signals.find((item) => item.id === "delta")?.count, 1);
  assert.equal(model.signals.find((item) => item.id === "handoff")?.value, "1 份交接 · 2 项任务");
  assert.ok(!model.signals.some((item) => item.id === "budget"));
  assert.deepEqual(model.links.map((item) => item.dest), [
    VALUE_PROOF_TARGETS.evidence.dest,
    VALUE_PROOF_TARGETS.delta.dest,
    VALUE_PROOF_TARGETS.replay.dest,
  ]);
  assertNoFabricatedMetrics({ settlement, model });

  const botHtml = valueProofCardMarkup(model, { surface: "bot", variant: "stream" });
  assert.match(botHtml, /data-value-proof="1"/);
  assert.match(botHtml, /这次留下了什么/);
  assert.match(botHtml, /data-value-proof-open="evidence"/);
  assert.match(botHtml, new RegExp(`data-value-proof-dest="${VALUE_PROOF_TARGETS.evidence.dest}"`));
  assert.match(botHtml, /data-value-proof-open="delta"/);
  assert.match(botHtml, new RegExp(`data-value-proof-dest="${VALUE_PROOF_TARGETS.delta.dest}"`));
  assert.match(botHtml, /data-value-proof-open="replay"/);
  assert.match(botHtml, new RegExp(`data-value-proof-dest="${VALUE_PROOF_TARGETS.replay.dest}"`));
  assert.doesNotMatch(botHtml, /省了|¥|hours saved/i);

  const workbenchHtml = valueProofCardMarkup(model, { surface: "workbench" });
  assert.match(workbenchHtml, /class="value-proof-card/);
  assert.match(workbenchHtml, /data-value-proof-surface="workbench"/);
  assert.match(workbenchHtml, /收获证明/);
});

test("unloaded settlement omits evidence/DELTA counts instead of inventing zero", () => {
  const model = projectValueProof({
    run: SUCCEEDED_RUN,
    settlement: null,
    events: [],
  });
  assert.ok(!model.signals.some((item) => item.id === "evidence"));
  assert.ok(!model.signals.some((item) => item.id === "delta"));
  assert.deepEqual(model.links.map((item) => item.id), ["evidence"]);
  const html = valueProofCardMarkup(model, { surface: "bot" });
  assert.doesNotMatch(html, /data-value-proof-open="delta"/);
  assert.doesNotMatch(html, /data-value-proof-open="replay"/);
  assert.match(html, /data-value-proof-open="evidence"/);
  assert.doesNotMatch(html, /0 条收获证明|0 份产物/);
});

test("loaded empty settlement is an honest empty, and budget/stop only appear when present", async () => {
  const empty = await collectRunSettlement({ run: SUCCEEDED_RUN });
  const emptyModel = projectValueProof({ run: SUCCEEDED_RUN, settlement: empty, events: [] });
  assert.equal(emptyModel.signals.find((item) => item.id === "evidence")?.empty, true);
  assert.equal(emptyModel.signals.find((item) => item.id === "delta")?.empty, true);
  assert.match(emptyModel.signals.find((item) => item.id === "delta").value, /没有 DELTA/);
  assert.ok(!emptyModel.links.some((item) => item.id === "delta"));

  const stopped = projectValueProof({
    run: {
      ...SUCCEEDED_RUN,
      stopReason: { type: "budget_exhausted" },
      costUsdTotal: 0,
    },
    settlement: empty,
  });
  assert.equal(stopped.signals.find((item) => item.id === "budget")?.value, "预算用尽后停下");

  const spent = projectValueProof({
    run: { ...SUCCEEDED_RUN, costUsdTotal: 1.25, maxBudgetUsdPerTurn: 5 },
    settlement: empty,
  });
  assert.equal(spent.signals.find((item) => item.id === "budget")?.value, "$1.25 / 上限 $5");
  const zeroCost = projectValueProof({
    run: { ...SUCCEEDED_RUN, costUsdTotal: 0 },
    settlement: empty,
  });
  assert.ok(!zeroCost.signals.some((item) => item.id === "budget"));
});

test("Bot and workbench settlement surfaces render the card and keep link targets", async () => {
  const [app, settlement, css] = await Promise.all([
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/modules/bot-settlement.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-grok-parity.css`, "utf8"),
  ]);
  assert.match(settlement, /from "\.\/value-proof-card\.js"/);
  assert.match(settlement, /projectValueProof\(/);
  assert.match(settlement, /valueProofCardMarkup\(/);
  assert.match(app, /from "\.\/modules\/value-proof-card\.js"/);
  assert.match(app, /function botValueProofStreamMarkup\(/);
  assert.match(app, /class="bot-proof-fold"/);
  assert.match(app, /class="bot-proof-summary">详情/);
  assert.match(app, /function openValueProofTarget\(/);
  assert.match(app, /botWorkspace\?\.setTab/);
  assert.match(app, /botWorkspace\.setTab\("results"\)/);
  assert.match(app, /case "delta":/);
  assert.match(app, /obs-delta-title/);
  assert.match(app, /activateTab\?\.\("activity"\)/);
  assert.match(app, /data-replay-mount/);
  assert.match(app, /data-value-proof-open/);
  assert.match(css, /Phase C4：收获证明/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.value-proof-actions/);
});
