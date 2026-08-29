import test from "node:test";
import assert from "node:assert/strict";
import {
  compareApprovalSnapshotVersions,
  normalizeApprovalRuntimeGeneration,
} from "../public/modules/approval-snapshot.js";

function snapshot({ epoch = "epoch-a", revision = 0, runtimeGeneration = 1, approvals = [] } = {}) {
  return { approvals, epoch, revision, runtimeGeneration };
}

test("approval snapshot runtime generations are normalized as non-negative safe integers", () => {
  assert.equal(normalizeApprovalRuntimeGeneration("2"), 2);
  assert.equal(normalizeApprovalRuntimeGeneration(0), 0);
  assert.equal(normalizeApprovalRuntimeGeneration(""), null);
  assert.equal(normalizeApprovalRuntimeGeneration("not-a-generation"), null);
  assert.equal(normalizeApprovalRuntimeGeneration(-1), null);
});

test("a late response from the previous runtime generation cannot overwrite the new baseline", () => {
  const first = compareApprovalSnapshotVersions({}, snapshot({ revision: 1, runtimeGeneration: 1 }));
  assert.equal(first.accepted, true);

  const reloaded = compareApprovalSnapshotVersions(
    { epoch: first.epoch, revision: first.revision, runtimeGeneration: first.runtimeGeneration },
    snapshot({ revision: 1, runtimeGeneration: 2, approvals: [] }),
  );
  assert.equal(reloaded.accepted, true);

  const late = compareApprovalSnapshotVersions(
    { epoch: reloaded.epoch, revision: reloaded.revision, runtimeGeneration: reloaded.runtimeGeneration },
    snapshot({ revision: 2, runtimeGeneration: 1, approvals: [{ id: "stale" }] }),
  );
  assert.equal(late.accepted, false);
  assert.equal(late.stale, true);
  assert.match(late.reason, /运行时代际/);
});

test("a new broker epoch requires a strictly newer runtime generation", () => {
  const sameGeneration = compareApprovalSnapshotVersions(
    { epoch: "epoch-a", revision: 4, runtimeGeneration: 3 },
    snapshot({ epoch: "epoch-b", revision: 0, runtimeGeneration: 3 }),
  );
  assert.equal(sameGeneration.accepted, false);

  const newerGeneration = compareApprovalSnapshotVersions(
    { epoch: "epoch-a", revision: 4, runtimeGeneration: 3 },
    snapshot({ epoch: "epoch-b", revision: 0, runtimeGeneration: 4 }),
  );
  assert.equal(newerGeneration.accepted, true);
  assert.equal(newerGeneration.resetRevision, true);
});

test("once anchored, snapshots without runtime generation fail closed", () => {
  const result = compareApprovalSnapshotVersions(
    { epoch: "epoch-a", revision: 1, runtimeGeneration: 2 },
    snapshot({ runtimeGeneration: null, revision: 2 }),
  );
  assert.equal(result.accepted, false);
  assert.equal(result.stale, true);
});
