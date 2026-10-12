import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionResidenceStore, SESSION_RESIDENCE_SCHEMA } from "../src/session-residence.mjs";

test("SessionResidenceStore initializes clean state and updates heartbeats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-residence-test-"));
  try {
    const store = new SessionResidenceStore({ dataRoot: dir });
    await store.init();

    const initial = store.getResidenceState();
    assert.equal(initial.schema, SESSION_RESIDENCE_SCHEMA);
    assert.equal(initial.activeConversationId, null);
    assert.equal(initial.residenceMode, "detached");
    assert.equal(initial.recoveryHints.length, 0);

    // Heartbeat
    const updated = await store.recordHeartbeat({
      conversationId: "conv-123",
      residenceMode: "resident",
    });
    assert.equal(updated.activeConversationId, "conv-123");
    assert.equal(updated.residenceMode, "resident");
    assert.ok(updated.lastHeartbeat);

    // Clean shutdown
    await store.recordCleanShutdown();
    const afterShutdown = store.getResidenceState();
    assert.ok(afterShutdown.lastCleanShutdown);
    assert.equal(afterShutdown.residenceMode, "detached");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionResidenceStore detects unclean exits with running tasks and creates recovery hints", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-residence-crash-"));
  try {
    // 1. First run: system was running and sent heartbeat, but did NOT clean shutdown
    const store1 = new SessionResidenceStore({ dataRoot: dir });
    await store1.init();
    await store1.recordHeartbeat({ conversationId: "conv-unclean", residenceMode: "resident" });
    store1.close();

    // 2. Restart: simulate crashed state with 1 unfinished run
    const fakeRuns = new Map([
      ["run-interrupted-1", {
        id: "run-interrupted-1",
        title: "分析代码库复杂度",
        status: "running",
        conversationId: "conv-unclean",
      }],
      ["run-completed-2", {
        id: "run-completed-2",
        title: "已完成的任务",
        status: "completed",
        conversationId: "conv-unclean",
      }],
    ]);

    const fakeCheckpointStore = {
      list: async () => [
        {
          id: "cp-1",
          runId: "run-interrupted-1",
          conversationId: "conv-unclean",
          phase: "analyze",
          label: "代码分析阶段",
          status: "in_progress",
        },
      ],
    };

    const store2 = new SessionResidenceStore({ dataRoot: dir });
    await store2.init({ runs: fakeRuns, checkpointStore: fakeCheckpointStore });

    const recoveryState = store2.getResidenceState();
    assert.equal(recoveryState.recoveryHints.length, 1);
    const hint = recoveryState.recoveryHints[0];
    assert.equal(hint.runId, "run-interrupted-1");
    assert.equal(hint.type, "interrupted_run");
    assert.equal(hint.status, "pending");

    // 3. User claims the hint（认领 + 回到会话；不重放执行）
    const resumeRes = await store2.claimRecoveryHint(hint.id);
    assert.equal(resumeRes.success, true);
    assert.equal(resumeRes.runResumed, false, "认领提示不得宣称已恢复执行——它只做导航");
    assert.equal(store2.getResidenceState().recoveryHints.length, 0, "resumed hints should not be pending");
    assert.equal(store2.getResidenceState().activeConversationId, "conv-unclean");

    // 4. Test dismiss
    store2.state.recoveryHints.push({
      id: "hint-dismiss-me",
      title: "待忽略提示",
      status: "pending",
    });
    assert.equal(store2.getResidenceState().recoveryHints.length, 1);
    await store2.dismissRecoveryHint("hint-dismiss-me");
    assert.equal(store2.getResidenceState().recoveryHints.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
