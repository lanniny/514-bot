import test from "node:test";
import assert from "node:assert/strict";
import { artifactAvailability, collectRunEvidenceArtifacts, projectEvidenceArtifact } from "../src/run-artifacts.mjs";

const run = { id: "run-alpha", title: "trusted baseline", createdAt: "2026-08-18T00:00:00.000Z" };

test("artifact availability distinguishes missing, truncated, digest change and stale run", () => {
  assert.equal(artifactAvailability({ exists: false }), "missing");
  assert.equal(artifactAvailability({ truncated: true }), "truncated");
  assert.equal(artifactAvailability({ digest: "aaa", expectedDigest: "bbb" }), "digest-changed");
  assert.equal(artifactAvailability({ sourceRunId: "old", runId: "new" }), "stale-run");
  assert.equal(artifactAvailability({ exists: true }), "available");
});

test("evidence cards never claim a formal publish", () => {
  const card = projectEvidenceArtifact({
    runId: run.id,
    kind: "handoff",
    name: "codex-to-claude__trusted-baseline__20260818-0720.md",
    content: `${run.id}\n__DELTA__: 烛 | 1 | evidence`,
  });
  assert.equal(card.published, false);
  assert.equal(card.availability, "available");
  assert.match(card.digest, /^[0-9a-f]{16}$/);
});

test("only handoffs and DELTA rows that mention the run become cards", () => {
  const cards = collectRunEvidenceArtifacts({
    run,
    handoffs: [
      { name: "codex-to-claude__other__20260818-0000.md", modifiedAt: "2026-08-18T01:00:00.000Z" },
      { name: `codex-to-claude__${run.id}__20260818-0100.md`, modifiedAt: "2026-08-18T01:00:00.000Z", exists: false },
    ],
    deltas: [
      { id: "decisions.md#1", agent: "烛", score: 1, evidence: `apps/control-center ${run.id}`, ts: "2026-08-18T01:01:00.000Z" },
    ],
  });
  assert.equal(cards.some((item) => item.availability === "missing"), true);
  assert.equal(cards.some((item) => item.kind === "delta"), true);
  assert.equal(cards.every((item) => item.published === false), true);
});

test("explicit cross-run evidence is excluded even when its prose mentions the target", () => {
  const cards = collectRunEvidenceArtifacts({
    run,
    handoffs: [
      {
        name: `codex-to-claude__${run.id}__20260818-0200.md`,
        runId: "run-other",
        content: `references ${run.id} but belongs elsewhere`,
      },
      {
        name: `codex-to-claude__${run.id}__20260818-0201.md`,
        content: `references ${run.id} and has no explicit owner`,
      },
    ],
    deltas: [
      { id: "delta-other", runId: "run-other", topic: run.id, evidence: run.id },
      { id: "delta-owned", topic: run.id, evidence: "verified" },
    ],
  });
  assert.equal(cards.length, 2);
  assert.ok(cards.every((item) => item.availability !== "stale-run"));
});

test("run id matching accepts handoff separators but rejects a longer id prefix", () => {
  const cards = collectRunEvidenceArtifacts({
    run: { id: "run-1", title: "short" },
    handoffs: [
      { name: "codex-to-claude__run-1__20260818-0300.md" },
      { name: "codex-to-claude__run-10__20260818-0301.md" },
    ],
  });
  assert.equal(cards.length, 1);
  assert.match(cards[0].label, /run-1/);
});
