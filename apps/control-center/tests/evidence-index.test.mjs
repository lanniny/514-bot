import test from "node:test";
import assert from "node:assert/strict";
import {
  projectEvidenceArtifact,
  collectRunEvidenceArtifacts,
  computeWorktreeDigest,
} from "../src/run-artifacts.mjs";

const BASE = {
  runId: "run-abc",
  kind: "handoff",
  name: "codex-to-claude__fix-auth__20260901-1200.md",
  exists: true,
  endpoint: "/api/observability/handoffs/test.md",
};

test("OB-03: projectEvidenceArtifact includes asOfSequence and worktreeDigest", () => {
  const card = projectEvidenceArtifact({ ...BASE, asOfSequence: 42, worktreeDigest: "deadbeef01234567" });
  assert.equal(card.asOfSequence, 42);
  assert.equal(card.worktreeDigest, "deadbeef01234567");
});

test("OB-03: projectEvidenceArtifact defaults both to null", () => {
  const card = projectEvidenceArtifact(BASE);
  assert.equal(card.asOfSequence, null);
  assert.equal(card.worktreeDigest, null);
});

test("OB-03: artifactId is deterministic across calls", () => {
  const a = projectEvidenceArtifact({ ...BASE, asOfSequence: 10, worktreeDigest: "aa" });
  const b = projectEvidenceArtifact({ ...BASE, asOfSequence: 10, worktreeDigest: "aa" });
  assert.equal(a.id, b.id, "same inputs must produce same artifact id");
});

test("OB-03: artifactId changes when asOfSequence changes", () => {
  const a = projectEvidenceArtifact({ ...BASE, asOfSequence: 10, worktreeDigest: "aa" });
  const b = projectEvidenceArtifact({ ...BASE, asOfSequence: 11, worktreeDigest: "aa" });
  assert.notEqual(a.id, b.id, "different asOfSequence must produce different id");
});

test("OB-03: artifactId changes when worktreeDigest changes", () => {
  const a = projectEvidenceArtifact({ ...BASE, asOfSequence: 10, worktreeDigest: "aa" });
  const b = projectEvidenceArtifact({ ...BASE, asOfSequence: 10, worktreeDigest: "bb" });
  assert.notEqual(a.id, b.id, "different worktreeDigest must produce different id");
});

test("OB-03: computeWorktreeDigest returns null when no worktreePath", async () => {
  assert.equal(await computeWorktreeDigest({}), null);
  assert.equal(await computeWorktreeDigest({ id: "r1" }), null);
  assert.equal(await computeWorktreeDigest({ id: "r1", worktreePath: "" }), null);
});

test("OB-03: computeWorktreeDigest returns null for invalid path", async () => {
  const result = await computeWorktreeDigest({ id: "r1", worktreePath: "/nonexistent/path/that/does/not/exist" });
  assert.equal(result, null, "invalid path should fail closed to null");
});

test("OB-03: collectRunEvidenceArtifacts threads asOfSequence and worktreeDigest", () => {
  const run = { id: "run-xyz" };
  const handoffs = [
    { name: "codex-to-claude__run-xyz__20260901-1200.md", exists: true, runId: "run-xyz" },
  ];
  const deltas = [
    { id: "d1", agent: "codex", score: 1, evidence: "fixed auth", runId: "run-xyz" },
  ];
  const cards = collectRunEvidenceArtifacts({
    run,
    handoffs,
    deltas,
    asOfSequence: 77,
    worktreeDigest: "cafe1234abcd5678",
  });
  assert.equal(cards.length, 2);
  for (const card of cards) {
    assert.equal(card.asOfSequence, 77, `card ${card.kind} should carry asOfSequence`);
    assert.equal(card.worktreeDigest, "cafe1234abcd5678", `card ${card.kind} should carry worktreeDigest`);
  }
});

test("OB-03: collectRunEvidenceArtifacts defaults to null when not provided", () => {
  const run = { id: "run-xyz" };
  const handoffs = [
    { name: "codex-to-claude__run-xyz__20260901-1200.md", exists: true, runId: "run-xyz" },
  ];
  const cards = collectRunEvidenceArtifacts({ run, handoffs });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].asOfSequence, null);
  assert.equal(cards[0].worktreeDigest, null);
});
