import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeLedger } from "../src/worktree-ledger.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wt-ledger-"));
  return root;
}

test("ledger records creation and removal and folds an active view", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = createWorktreeLedger({ dataRoot: root });

  await ledger.recordCreated({ path: "I:/repo/wt-a", base: "I:/repo", runId: "run-1", source: "run" });
  await ledger.recordCreated({ path: "I:/repo/wt-b", base: "I:/repo", runId: null, source: "manual" });
  await ledger.recordRemoved({ path: "I:/repo/wt-a" });

  const view = await ledger.list();
  assert.equal(view.total, 2);
  assert.equal(view.activeCount, 1);
  const wtA = view.worktrees.find((item) => item.path === "I:/repo/wt-a");
  const wtB = view.worktrees.find((item) => item.path === "I:/repo/wt-b");
  assert.ok(wtA.removedAt, "removed worktree carries removal timestamp");
  assert.equal(wtB.removedAt, null);
  assert.equal(wtB.runId, null);
  assert.equal(wtB.source, "manual");

  const raw = await readFile(join(root, "worktrees.jsonl"), "utf8");
  assert.equal(raw.trim().split("\n").length, 3, "ledger is append-only (3 raw records)");
});

test("ledger tolerates corrupt tail lines and missing files", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = createWorktreeLedger({ dataRoot: root });
  const empty = await ledger.list();
  assert.deepEqual(empty.worktrees, []);

  await writeFile(join(root, "worktrees.jsonl"), `${JSON.stringify({ kind: "created", path: "I:/x/wt-c", createdAt: "2026-08-30T00:00:00.000Z" })}\n{broken json\n`, "utf8");
  const view = await ledger.list();
  assert.equal(view.total, 1, "corrupt lines skipped, valid entries kept");
});

test("ledger rejects entries without a path", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = createWorktreeLedger({ dataRoot: root });
  await assert.rejects(() => ledger.recordCreated({ base: "x" }), { code: "VALIDATION_FAILED" });
  await assert.rejects(() => ledger.recordRemoved({}), { code: "VALIDATION_FAILED" });
  assert.throws(() => createWorktreeLedger({}), { name: "TypeError" });
});
