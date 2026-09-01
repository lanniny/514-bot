import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RELEASE_COMMAND_DEFS,
  RELEASE_RUNNER_SCHEMA,
  createReleaseCommandRunner,
} from "../src/release-command-runner.mjs";
import { createReleaseCommandEvidenceStore } from "../src/release-record.mjs";

const CLEAN_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const RUNTIME_IDENTITY = Object.freeze({
  pid: 4242,
  generation: 7,
  startedAt: "2026-08-18T20:00:00.000Z",
});

function createTestReleaseCommandRunner(options = {}) {
  return createReleaseCommandRunner(
    {
      ...options,
      collectRuntimeIdentity: options.collectRuntimeIdentity
        || (async () => ({ ...RUNTIME_IDENTITY })),
    },
  );
}

function fakeRunner(resultsByCommand, {
  commits = ["abc123def4567890"],
  worktrees = [""],
} = {}) {
  let npmIndex = 0;
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "git") {
      if (args.includes("status")) {
        const status = worktrees[Math.min(npmIndex, worktrees.length - 1)];
        return { code: 0, stdout: status, stderr: "" };
      }
      const commit = commits[Math.min(npmIndex, commits.length - 1)];
      return { code: 0, stdout: `${commit}\n`, stderr: "" };
    }
    const result = resultsByCommand[command];
    if (!result) throw new Error(`unexpected command ${command}`);
    npmIndex += 1;
    return result;
  };
  runner.calls = calls;
  return runner;
}

test("command catalog is fixed, shell-free, and covers all release command ids", () => {
  for (const def of Object.values(RELEASE_COMMAND_DEFS)) {
    assert.equal(typeof def.command, "string");
    assert.ok(def.args.every((arg) => typeof arg === "string"));
    assert.ok(def.timeoutMs > 0);
    assert.ok(!def.command.includes(" ") && !def.command.includes(";"));
  }
  assert.deepEqual(
    [...Object.keys(RELEASE_COMMAND_DEFS)].sort(),
    ["browserQa", "focusedTests", "fullTests", "validate"],
  );
});

test("runner executes server-side and stores evidence as server-observed", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "cc-runner-"));
  try {
    const store = createReleaseCommandEvidenceStore({ dataRoot });
    const runner = fakeRunner({ npm: { code: 0, stdout: "ok", stderr: "" } });
    const service = createTestReleaseCommandRunner({
      appRoot: "I:/514claude/514cc/apps/control-center",
      evidenceStore: store,
      runner,
      now: () => "2026-08-18T21:00:00.000Z",
    });
    const result = await service.run();
    assert.equal(result.schema, RELEASE_RUNNER_SCHEMA);
    assert.equal(result.sourceCommit, "abc123def4567890");
    assert.deepEqual(result.runtime, RUNTIME_IDENTITY);
    for (const id of ["validate", "focusedTests", "fullTests", "browserQa"]) {
      assert.equal(result.evidence[id].status, "passed");
      assert.equal(result.evidence[id].exitCode, 0);
      assert.equal(result.evidence[id].sourceCommit, "abc123def4567890");
      assert.equal(result.evidence[id].diffDigest, CLEAN_DIGEST);
      assert.equal(result.evidence[id].workspaceClean, true);
      assert.equal(result.evidence[id].runtimePid, RUNTIME_IDENTITY.pid);
      assert.equal(result.evidence[id].runtimeGeneration, RUNTIME_IDENTITY.generation);
      assert.equal(result.evidence[id].runtimeStartedAt, RUNTIME_IDENTITY.startedAt);
      assert.ok(result.evidence[id].durationMs >= 0);
    }
    const snapshot = await store.snapshot();
    assert.equal(snapshot.validate.provenance, "server-observed");
    assert.equal(snapshot.fullTests.evidenceTrust, "independent");
    assert.equal(snapshot.fullTests.workspaceClean, true);
    // 命令全部走固定目录且 cwd 固定为 appRoot
    const qa = runner.calls.filter((call) => call.command === "npm");
    assert.equal(qa.length, 4);
    assert.ok(qa.every((call) => call.options.cwd.endsWith("apps/control-center")));
    assert.ok(service.snapshot().commands.length === 4);
    assert.equal(service.snapshot().active, null);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runner records failed exits instead of throwing", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "cc-runner-"));
  try {
    const store = createReleaseCommandEvidenceStore({ dataRoot });
    const service = createTestReleaseCommandRunner({
      appRoot: "I:/514claude/514cc/apps/control-center",
      evidenceStore: store,
      runner: fakeRunner({ npm: { code: 3, stdout: "", stderr: "boom" } }),
    });
    const result = await service.run({ commandIds: ["validate"] });
    assert.equal(result.evidence.validate.status, "failed");
    assert.equal(result.evidence.validate.exitCode, 3);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.validate.status, "failed");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("W1.1 stopOnFailure halts the chain after the first non-passed command and records skipped evidence", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "cc-runner-"));
  try {
    const store = createReleaseCommandEvidenceStore({ dataRoot });
    let npmCalls = 0;
    const runner = fakeRunner({
      get npm() {
        npmCalls += 1;
        return { code: npmCalls === 1 ? 0 : 4, stdout: "", stderr: npmCalls === 1 ? "" : "focused boom" };
      },
    });
    const service = createTestReleaseCommandRunner({
      appRoot: "I:/514claude/514cc/apps/control-center",
      evidenceStore: store,
      runner,
    });
    const result = await service.run({
      commandIds: ["validate", "focusedTests", "fullTests", "browserQa"],
      stopOnFailure: true,
    });
    // validate 通过，focusedTests 失败即停
    assert.equal(result.evidence.validate.status, "passed");
    assert.equal(result.evidence.focusedTests.status, "failed");
    assert.equal(result.evidence.focusedTests.exitCode, 4);
    assert.equal(result.evidence.fullTests.status, "skipped");
    assert.equal(result.evidence.browserQa.status, "skipped");
    assert.match(String(result.evidence.fullTests.note), /stop-on-failure after "focusedTests"/);
    // 实际只执行了两个 npm 命令（validate + focusedTests），后两个未跑
    const npmCount = runner.calls.filter((call) => call.command === "npm").length;
    assert.equal(npmCount, 2);
    // skipped 落账且不构成 release-ready 证据
    const snapshot = await store.snapshot();
    assert.equal(snapshot.fullTests.status, "skipped");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("W1.1 default stopOnFailure=false runs the full selection (backward compatible)", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "cc-runner-"));
  try {
    const store = createReleaseCommandEvidenceStore({ dataRoot });
    const service = createTestReleaseCommandRunner({
      appRoot: "I:/514claude/514cc/apps/control-center",
      evidenceStore: store,
      runner: fakeRunner({ npm: { code: 2, stdout: "", stderr: "always fails" } }),
    });
    const result = await service.run({ commandIds: ["validate", "focusedTests"] });
    assert.equal(result.evidence.validate.status, "failed");
    assert.equal(result.evidence.focusedTests.status, "failed");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runner refuses invalid selections, duplicate ids, and missing source commit", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "cc-runner-"));
  try {
    const store = createReleaseCommandEvidenceStore({ dataRoot });
    const service = createTestReleaseCommandRunner({
      appRoot: "I:/514claude/514cc/apps/control-center",
      evidenceStore: store,
      runner: fakeRunner({ npm: { code: 0, stdout: "", stderr: "" } }),
    });
    await assert.rejects(
      () => service.run({ commandIds: ["validate", "deployProd"] }),
      (error) => error.code === "RELEASE_RUNNER_UNKNOWN_COMMAND",
    );
    await assert.rejects(
      () => service.run({ commandIds: [] }),
      (error) => error.code === "RELEASE_RUNNER_INVALID_SELECTION",
    );
    await assert.rejects(
      () => service.run({ commandIds: ["validate", "validate"] }),
      (error) => error.code === "RELEASE_RUNNER_DUPLICATE_COMMAND",
    );
    await assert.rejects(
      () => service.run({ commandIds: "validate" }),
      (error) => error.code === "RELEASE_RUNNER_INVALID_SELECTION",
    );
    const noCommit = createTestReleaseCommandRunner({
      appRoot: "I:/514claude/514cc/apps/control-center",
      evidenceStore: store,
      runner: async (command) => {
        if (command === "git") return { code: 128, stdout: "", stderr: "no git" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await assert.rejects(
      () => noCommit.run({ commandIds: ["validate"] }),
      (error) => error.code === "RELEASE_RUNNER_SOURCE_COMMIT_UNAVAILABLE",
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runner blocks evidence when HEAD or worktree moves during the run", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "cc-runner-"));
  try {
    const store = createReleaseCommandEvidenceStore({ dataRoot });
    const service = createTestReleaseCommandRunner({
      appRoot: "I:/514claude/514cc/apps/control-center",
      evidenceStore: store,
      // 两次 git 调用（执行前后）返回不同 commit，模拟 run 期间 HEAD 移动
      runner: fakeRunner({ npm: { code: 0, stdout: "", stderr: "" } }, { commits: ["aaa111", "bbb222", "bbb222"] }),
    });
    const result = await service.run({ commandIds: ["validate"] });
    assert.equal(result.evidence.validate.status, "blocked");
    assert.match(result.evidence.validate.note, /HEAD changed/);
    assert.equal(result.evidence.validate.sourceCommit, "aaa111");
    const snapshot = await store.snapshot();
    assert.equal(snapshot.validate.status, "blocked");
    assert.equal(snapshot.validate.provenance, "server-observed");

    const worktreeChange = createTestReleaseCommandRunner({
      appRoot: "I:/514claude/514cc/apps/control-center",
      evidenceStore: store,
      runner: fakeRunner(
        { npm: { code: 0, stdout: "", stderr: "" } },
        { worktrees: ["", " M src/app.mjs\n"] },
      ),
    });
    const changed = await worktreeChange.run({ commandIds: ["validate"] });
    assert.equal(changed.evidence.validate.status, "blocked");
    assert.match(changed.evidence.validate.note, /worktree changed/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runner blocks evidence when the runtime identity changes during the run", async () => {
  let generation = RUNTIME_IDENTITY.generation;
  let persisted = null;
  const service = createTestReleaseCommandRunner({
    appRoot: "I:/514claude/514cc/apps/control-center",
    evidenceStore: { saveObserved: async (value) => { persisted = value; } },
    collectRuntimeIdentity: async () => ({ ...RUNTIME_IDENTITY, generation }),
    runner: async (command, args) => {
      if (command === "git") {
        return args.includes("status")
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 0, stdout: "abc123def4567890\n", stderr: "" };
      }
      generation += 1;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const result = await service.run({ commandIds: ["validate"] });
  assert.equal(result.evidence.validate.status, "blocked");
  assert.match(result.evidence.validate.note, /runtime changed/);
  assert.equal(persisted.validate.status, "blocked");
});

test("runner treats sourceCommit as an expectation and refuses dirty worktrees before QA", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "cc-runner-"));
  try {
    const store = createReleaseCommandEvidenceStore({ dataRoot });
    const mismatchRunner = fakeRunner({ npm: { code: 0, stdout: "", stderr: "" } });
    const mismatch = createTestReleaseCommandRunner({
      appRoot: "I:/514claude/514cc/apps/control-center",
      evidenceStore: store,
      runner: mismatchRunner,
    });
    await assert.rejects(
      () => mismatch.run({ commandIds: ["validate"], sourceCommit: "client-value" }),
      (error) => error.code === "RELEASE_RUNNER_SOURCE_COMMIT_MISMATCH"
        && error.sourceCommit === "abc123def4567890",
    );
    assert.equal(mismatchRunner.calls.filter((call) => call.command === "npm").length, 0);

    const dirtyRunner = fakeRunner(
      { npm: { code: 0, stdout: "", stderr: "" } },
      { worktrees: [" M src/app.mjs\n"] },
    );
    const dirty = createTestReleaseCommandRunner({
      appRoot: "I:/514claude/514cc/apps/control-center",
      evidenceStore: store,
      runner: dirtyRunner,
    });
    await assert.rejects(
      () => dirty.run({ commandIds: ["validate"] }),
      (error) => error.code === "RELEASE_RUNNER_DIRTY_WORKTREE",
    );
    assert.equal(dirtyRunner.calls.filter((call) => call.command === "npm").length, 0);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runner normalizes commit probe exceptions and releases its lock after persistence failure", async () => {
  const unavailable = createTestReleaseCommandRunner({
    appRoot: "I:/514claude/514cc/apps/control-center",
    evidenceStore: { saveObserved: async () => {} },
    collectSourceCommit: async () => { throw new Error("spawn ENOENT at private path"); },
    collectWorkspaceState: async () => ({ clean: true, diffDigest: CLEAN_DIGEST }),
    runner: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  await assert.rejects(
    () => unavailable.run({ commandIds: ["validate"] }),
    (error) => error.code === "RELEASE_RUNNER_SOURCE_COMMIT_UNAVAILABLE"
      && !error.message.includes("private path"),
  );
  assert.equal(unavailable.snapshot().active, null);

  let saveAttempts = 0;
  const recoverable = createTestReleaseCommandRunner({
    appRoot: "I:/514claude/514cc/apps/control-center",
    evidenceStore: {
      saveObserved: async () => {
        saveAttempts += 1;
        if (saveAttempts === 1) throw new Error("injected persistence failure");
      },
    },
    collectSourceCommit: async () => "abc123def4567890",
    collectWorkspaceState: async () => ({ clean: true, diffDigest: CLEAN_DIGEST }),
    runner: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  await assert.rejects(() => recoverable.run({ commandIds: ["validate"] }), /persistence failure/);
  assert.equal(recoverable.snapshot().active, null);
  const retried = await recoverable.run({ commandIds: ["validate"] });
  assert.equal(retried.evidence.validate.status, "passed");
  assert.equal(saveAttempts, 2);
});

test("runner serializes concurrent runs", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "cc-runner-"));
  try {
    const store = createReleaseCommandEvidenceStore({ dataRoot });
    const slow = (async () => ({ code: 0, stdout: "abc123def4567890\n", stderr: "" }));
    const service = createTestReleaseCommandRunner({
      appRoot: "I:/514claude/514cc/apps/control-center",
      evidenceStore: store,
      runner: async (command, args, options) => {
        if (command === "git") {
          return args.includes("status")
            ? { code: 0, stdout: "", stderr: "" }
            : { code: 0, stdout: "abc123def4567890\n", stderr: "" };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(options.signal.aborted, false);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const first = service.run({ commandIds: ["validate"] });
    await assert.rejects(
      () => service.run({ commandIds: ["fullTests"] }),
      (error) => error.code === "RELEASE_RUNNER_BUSY",
    );
    const done = await first;
    assert.equal(done.evidence.validate.status, "passed");
    assert.equal(service.snapshot().active, null);
    void slow;
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runner close aborts the active command, records blocked evidence, and stays closed", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "cc-runner-"));
  try {
    const store = createReleaseCommandEvidenceStore({ dataRoot });
    let commandStarted;
    const started = new Promise((resolveStarted) => { commandStarted = resolveStarted; });
    const service = createTestReleaseCommandRunner({
      appRoot: "I:/514claude/514cc/apps/control-center",
      evidenceStore: store,
      runner: async (command, args, options) => {
        if (command === "git") {
          return args.includes("status")
            ? { code: 0, stdout: "", stderr: "" }
            : { code: 0, stdout: "abc123def4567890\n", stderr: "" };
        }
        commandStarted();
        return new Promise((resolveRun, rejectRun) => {
          options.signal.addEventListener("abort", () => {
            rejectRun(Object.assign(new Error("private path must not persist"), { code: "ABORTED" }));
          }, { once: true });
        });
      },
    });
    const running = service.run({ commandIds: ["validate"] });
    await started;
    await service.close();
    const result = await running;
    assert.equal(result.evidence.validate.status, "blocked");
    assert.equal(result.evidence.validate.note, "execution aborted by server lifecycle");
    const persisted = await store.snapshot();
    assert.doesNotMatch(persisted.validate.note, /private path/);
    assert.equal(service.snapshot().accepting, false);
    assert.equal(service.snapshot().active, null);
    await assert.rejects(
      () => service.run({ commandIds: ["validate"] }),
      (error) => error.code === "RELEASE_RUNNER_CLOSED",
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runner rejects missing wiring instead of silently no-oping", () => {
  assert.throws(() => createTestReleaseCommandRunner({}), /appRoot/);
  assert.throws(
    () => createTestReleaseCommandRunner({ appRoot: "I:/x" }),
    /evidence store/,
  );
  assert.throws(
    () => createReleaseCommandRunner(
      { appRoot: "I:/x", evidenceStore: { saveObserved: async () => {} } },
    ),
    /collectRuntimeIdentity/,
  );
});
