import { createHash, randomUUID } from "node:crypto";
import { runProcess } from "./process-runner.mjs";
import { RELEASE_COMMAND_IDS } from "./release-record.mjs";

// Server-observed QA runner: commands are fixed server-side and never use a shell.
export const RELEASE_RUNNER_SCHEMA = "514cc.release-command-runner/v1";

export const RELEASE_COMMAND_DEFS = Object.freeze({
  validate: Object.freeze({ id: "validate", command: "npm", args: Object.freeze(["run", "validate"]), timeoutMs: 300_000 }),
  focusedTests: Object.freeze({ id: "focusedTests", command: "npm", args: Object.freeze([
    "run", "test", "--",
    "tests/release-record.test.mjs",
    "tests/release-truth.test.mjs",
    "tests/release-command-runner.test.mjs",
    "tests/app-close.test.mjs",
    "tests/http-e2e.test.mjs",
  ]), timeoutMs: 300_000 }),
  fullTests: Object.freeze({ id: "fullTests", command: "npm", args: Object.freeze(["run", "test"]), timeoutMs: 1_800_000 }),
  browserQa: Object.freeze({ id: "browserQa", command: "npm", args: Object.freeze(["run", "qa:environment"]), timeoutMs: 1_800_000 }),
});

function runnerError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function normalizeCommandIds(commandIds) {
  if (commandIds == null) return [...RELEASE_COMMAND_IDS];
  if (!Array.isArray(commandIds) || commandIds.length === 0 || commandIds.length > RELEASE_COMMAND_IDS.length) {
    throw runnerError("RELEASE_RUNNER_INVALID_SELECTION", "release command selection must contain one to four command ids");
  }
  if (commandIds.some((id) => typeof id !== "string" || !RELEASE_COMMAND_IDS.includes(id))) {
    throw runnerError("RELEASE_RUNNER_UNKNOWN_COMMAND", "release command selection contains an unknown id");
  }
  if (new Set(commandIds).size !== commandIds.length) {
    throw runnerError("RELEASE_RUNNER_DUPLICATE_COMMAND", "release command selection contains duplicate ids");
  }
  return [...commandIds];
}

function executionFailureNote(error) {
  const code = String(error?.code || "EXECUTION_ERROR").trim();
  if (code === "ABORTED") return "execution aborted by server lifecycle";
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? `execution error (${code})`
    : "execution error";
}

function cloneActive(active) {
  if (!active) return null;
  return {
    ...active,
    commandIds: [...active.commandIds],
    progress: active.progress.map((item) => ({ ...item })),
  };
}

function normalizeRuntimeIdentity(value) {
  const pid = Number(value?.pid);
  const generation = Number(value?.generation);
  const startedAt = String(value?.startedAt ?? "").trim();
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(generation) || generation < 0 || !startedAt) {
    return null;
  }
  return { pid, generation, startedAt };
}

function runtimeIdentityMatches(left, right) {
  return Boolean(left && right
    && left.pid === right.pid
    && left.generation === right.generation
    && left.startedAt === right.startedAt);
}

export function createReleaseCommandRunner({
  appRoot,
  evidenceStore,
  collectSourceCommit,
  collectWorkspaceState,
  collectRuntimeIdentity,
  runner = runProcess,
  now = () => new Date().toISOString(),
} = {}) {
  if (!appRoot) throw new Error("release command runner requires appRoot");
  if (!evidenceStore || typeof evidenceStore.saveObserved !== "function") {
    throw new Error("release command runner requires an evidence store with saveObserved");
  }
  if (typeof collectRuntimeIdentity !== "function") {
    throw new Error("release command runner requires collectRuntimeIdentity");
  }
  const resolveCommit = typeof collectSourceCommit === "function"
    ? collectSourceCommit
    : (root, options) => defaultCollectSourceCommit(root, runner, options);
  const resolveWorkspace = typeof collectWorkspaceState === "function"
    ? collectWorkspaceState
    : (root, options) => defaultCollectWorkspaceState(root, runner, options);
  let active = null;
  let activeController = null;
  let activePromise = null;
  let closed = false;

  function snapshot() {
    return {
      schema: RELEASE_RUNNER_SCHEMA,
      accepting: !closed,
      active: cloneActive(active),
      commands: RELEASE_COMMAND_IDS.map((id) => ({
        id,
        command: RELEASE_COMMAND_DEFS[id].command,
        args: [...RELEASE_COMMAND_DEFS[id].args],
        timeoutMs: RELEASE_COMMAND_DEFS[id].timeoutMs,
      })),
    };
  }

  async function collectCommit(signal) {
    try {
      return String(await resolveCommit(appRoot, { signal }) ?? "").trim() || null;
    } catch {
      return null;
    }
  }

  async function collectWorkspace(signal) {
    try {
      const value = await resolveWorkspace(appRoot, { signal });
      if (typeof value?.clean !== "boolean" || typeof value?.diffDigest !== "string" || !value.diffDigest) return null;
      return { clean: value.clean, diffDigest: value.diffDigest };
    } catch {
      return null;
    }
  }

  async function collectRuntime() {
    try {
      return normalizeRuntimeIdentity(await collectRuntimeIdentity());
    } catch {
      return null;
    }
  }

  function blockAll(evidence, note, workspaceClean = false) {
    return Object.fromEntries(Object.entries(evidence).map(([id, value]) => [id, {
      ...value,
      status: "blocked",
      workspaceClean,
      note: value.status === "blocked" && value.note ? value.note : note,
    }]));
  }

  async function executeAttempt({ attempt, expectedSourceCommit, requested, controller, stopOnFailure }) {
    const { signal } = controller;
    const runtimeIdentity = await collectRuntime();
    if (!runtimeIdentity) {
      throw runnerError("RELEASE_RUNNER_RUNTIME_IDENTITY_UNAVAILABLE", "server could not attest the runtime identity");
    }
    const evidenceCommit = await collectCommit(signal);
    if (!evidenceCommit) {
      throw runnerError("RELEASE_RUNNER_SOURCE_COMMIT_UNAVAILABLE", "server could not resolve the source commit");
    }
    if (expectedSourceCommit && expectedSourceCommit !== evidenceCommit) {
      throw runnerError("RELEASE_RUNNER_SOURCE_COMMIT_MISMATCH", "requested source commit does not match server HEAD", {
        expectedSourceCommit,
        sourceCommit: evidenceCommit,
      });
    }
    const initialWorkspace = await collectWorkspace(signal);
    if (!initialWorkspace) {
      throw runnerError("RELEASE_RUNNER_WORKSPACE_STATE_UNAVAILABLE", "server could not attest the worktree state");
    }
    if (!initialWorkspace.clean) {
      throw runnerError("RELEASE_RUNNER_DIRTY_WORKTREE", "server refuses independent QA evidence from a dirty worktree", {
        sourceCommit: evidenceCommit,
        diffDigest: initialWorkspace.diffDigest,
      });
    }

    attempt.sourceCommit = evidenceCommit;
    attempt.diffDigest = initialWorkspace.diffDigest;
    attempt.runtime = { ...runtimeIdentity };
    active.sourceCommit = evidenceCommit;
    active.diffDigest = initialWorkspace.diffDigest;
    active.runtime = { ...runtimeIdentity };
    const executed = [];
    for (const id of requested) {
      const def = RELEASE_COMMAND_DEFS[id];
      active.current = id;
      const startedMs = Date.now();
      let outcome;
      try {
        const result = await runner(def.command, def.args, {
          cwd: appRoot,
          timeoutMs: def.timeoutMs,
          maxOutputBytes: 2 * 1024 * 1024,
          windowsHide: true,
          signal,
        });
        const [endedCommit, endedWorkspace, endedRuntime] = await Promise.all([
          collectCommit(signal),
          collectWorkspace(signal),
          collectRuntime(),
        ]);
        const headMatches = endedCommit === evidenceCommit;
        const workspaceMatches = endedWorkspace?.clean === true
          && endedWorkspace.diffDigest === initialWorkspace.diffDigest;
        const runtimeMatches = runtimeIdentityMatches(endedRuntime, runtimeIdentity);
        outcome = {
          status: headMatches && workspaceMatches && runtimeMatches
            ? (result.code === 0 ? "passed" : "failed")
            : "blocked",
          exitCode: result.code,
          durationMs: Date.now() - startedMs,
          sourceCommit: evidenceCommit,
          diffDigest: initialWorkspace.diffDigest,
          workspaceClean: workspaceMatches,
          checkedAt: now(),
          runId: attempt.runId,
          runtimePid: runtimeIdentity.pid,
          runtimeGeneration: runtimeIdentity.generation,
          runtimeStartedAt: runtimeIdentity.startedAt,
          note: !headMatches
            ? "HEAD changed during command execution"
            : !workspaceMatches
              ? "worktree changed during command execution"
              : !runtimeMatches
                ? "runtime changed during command execution"
                : undefined,
        };
      } catch (error) {
        outcome = {
          status: "blocked",
          exitCode: null,
          durationMs: Date.now() - startedMs,
          sourceCommit: evidenceCommit,
          diffDigest: initialWorkspace.diffDigest,
          workspaceClean: false,
          checkedAt: now(),
          runId: attempt.runId,
          runtimePid: runtimeIdentity.pid,
          runtimeGeneration: runtimeIdentity.generation,
          runtimeStartedAt: runtimeIdentity.startedAt,
          note: executionFailureNote(error),
        };
      }
      executed.push([id, outcome]);
      active.progress.push({ id, status: outcome.status, exitCode: outcome.exitCode, durationMs: outcome.durationMs });
      // 一键收口语义（W1.1）：stopOnFailure=true 时首个未通过命令即停，剩余命令记 skipped。
      // 策略由服务端固定解释——客户端只能开关该策略，不能改命令目录或判定标准。
      if (stopOnFailure && outcome.status !== "passed") {
        for (const restId of requested.slice(executed.length)) {
          active.progress.push({ id: restId, status: "skipped", exitCode: null, durationMs: 0 });
          executed.push([restId, {
            status: "skipped",
            exitCode: null,
            durationMs: 0,
            sourceCommit: evidenceCommit,
            diffDigest: initialWorkspace.diffDigest,
            workspaceClean: true,
            checkedAt: now(),
            runId: attempt.runId,
            runtimePid: runtimeIdentity.pid,
            runtimeGeneration: runtimeIdentity.generation,
            runtimeStartedAt: runtimeIdentity.startedAt,
            note: `skipped: stop-on-failure after "${id}" ${outcome.status}`,
          }]);
        }
        break;
      }
    }

    let evidence = Object.fromEntries(executed);
    const [finalCommit, finalWorkspace, finalRuntime] = await Promise.all([
      collectCommit(signal),
      collectWorkspace(signal),
      collectRuntime(),
    ]);
    const finalWorkspaceMatches = finalWorkspace?.clean === true
      && finalWorkspace.diffDigest === initialWorkspace.diffDigest;
    const finalMatches = finalCommit === evidenceCommit
      && finalWorkspaceMatches
      && runtimeIdentityMatches(finalRuntime, runtimeIdentity);
    if (!finalMatches) {
      evidence = blockAll(evidence, "source, worktree, or runtime changed before evidence persistence", finalWorkspaceMatches);
    }
    await evidenceStore.saveObserved(evidence);
    return {
      schema: RELEASE_RUNNER_SCHEMA,
      runId: attempt.runId,
      sourceCommit: evidenceCommit,
      diffDigest: initialWorkspace.diffDigest,
      runtime: { ...runtimeIdentity },
      startedAt: attempt.startedAt,
      finishedAt: now(),
      evidence,
      note: finalMatches ? undefined : "source, worktree, or runtime changed; recorded evidence is blocked",
    };
  }

  async function run(opts = {}) {
    const { commandIds = null, sourceCommit = null, expectedSourceCommit = sourceCommit } = opts;
    const requested = normalizeCommandIds(commandIds);
    if (closed) throw runnerError("RELEASE_RUNNER_CLOSED", "release command runner is closed");
    if (active) {
      throw runnerError("RELEASE_RUNNER_BUSY", "release command runner is busy", { runId: active.runId });
    }
    const expected = String(expectedSourceCommit ?? "").trim() || null;
    const attempt = {
      runId: randomUUID(),
      startedAt: now(),
      sourceCommit: null,
      diffDigest: null,
      runtime: null,
      commandIds: [...requested],
    };
    const controller = new AbortController();
    active = { ...attempt, current: null, progress: [] };
    activeController = controller;
    const pending = executeAttempt({
      attempt,
      expectedSourceCommit: expected,
      requested,
      controller,
      stopOnFailure: opts.stopOnFailure === true,
    });
    activePromise = pending;
    try {
      return await pending;
    } finally {
      if (active?.runId === attempt.runId) active = null;
      if (activeController === controller) activeController = null;
      if (activePromise === pending) activePromise = null;
    }
  }

  async function close() {
    closed = true;
    const pending = activePromise;
    activeController?.abort();
    await pending?.catch(() => {});
    return { closed: true, active: active !== null };
  }

  return { snapshot, run, close };
}

async function defaultCollectSourceCommit(appRoot, runner, { signal } = {}) {
  const result = await runner("git", ["-C", appRoot, "rev-parse", "--verify", "HEAD^{commit}"], {
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
    provider: null,
    signal,
  });
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

async function defaultCollectWorkspaceState(appRoot, runner, { signal } = {}) {
  const result = await runner("git", ["-C", appRoot, "status", "--porcelain=v1", "--untracked-files=all"], {
    timeoutMs: 10_000,
    maxOutputBytes: 2 * 1024 * 1024,
    provider: null,
    signal,
  });
  if (result.code !== 0) return null;
  const statusText = String(result.stdout || "");
  return {
    clean: statusText.trim().length === 0,
    diffDigest: createHash("sha256").update(statusText, "utf8").digest("hex"),
  };
}
