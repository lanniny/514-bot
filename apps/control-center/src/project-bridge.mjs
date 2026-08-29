import { createHash } from "node:crypto";
import { realpath as fsRealpath } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { runProcess } from "./process-runner.mjs";

export const PROJECT_BRIDGE_SCHEMA = "514cc.project-bridge/v1";
export const BRIDGE_FACE_STATUSES = Object.freeze(["ok", "stale", "degraded", "missing", "unknown"]);
export const BRIDGE_CONSISTENCY = Object.freeze(["consistent", "stale", "degraded", "unknown"]);

function digestHex(label, parts, length) {
  return createHash("sha256").update([label, ...parts].join("\0"), "utf8").digest("hex").slice(0, length);
}

function pathKey(value) {
  const normalized = resolve(String(value)).split(sep).join("/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  if (!left || !right) return false;
  return pathKey(left) === pathKey(right);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

export function normalizeProjectCwd(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.includes("\0") || !isAbsolute(raw)) {
    throw Object.assign(new Error("project cwd must be an absolute path"), { code: "PROJECT_PATH_REJECTED" });
  }
  return resolve(raw);
}

export function projectIdFromCwd(canonicalCwd) {
  return digestHex("514cc.projectId/v1", [pathKey(canonicalCwd)], 16);
}

export function repositoryFingerprint({ gitCommonDir = null, firstCommit = null, canonicalCwd }) {
  if (firstCommit) {
    return digestHex("514cc.repoFp/v1", [String(firstCommit)], 32);
  }
  return digestHex("514cc.pathFp/v1", [pathKey(canonicalCwd)], 32);
}

export function anchorIdFromFingerprint(fingerprint) {
  return digestHex("514cc.anchorId/v1", [String(fingerprint)], 32);
}

export function createAnchorStore(seed = []) {
  const byFingerprint = new Map();
  const byCwd = new Map();
  for (const record of seed) remember(record);

  function remember(record) {
    const prior = byFingerprint.get(record.fingerprint);
    if (prior && !samePath(prior.canonicalCwd, record.canonicalCwd)) {
      byCwd.delete(pathKey(prior.canonicalCwd));
    }
    const next = {
      anchorId: record.anchorId,
      projectId: record.projectId,
      canonicalCwd: record.canonicalCwd,
      fingerprint: record.fingerprint,
    };
    byFingerprint.set(record.fingerprint, next);
    byCwd.set(pathKey(record.canonicalCwd), next);
    return next;
  }

  return {
    lookupByFingerprint(fingerprint) {
      return byFingerprint.get(fingerprint) || null;
    },
    lookupByCwd(cwd) {
      return byCwd.get(pathKey(cwd)) || null;
    },
    remember,
  };
}

export function resolveProjectAnchor({ canonicalCwd, fingerprint, store = null } = {}) {
  const projectId = projectIdFromCwd(canonicalCwd);
  const anchorId = anchorIdFromFingerprint(fingerprint);
  const prior = store?.lookupByFingerprint(fingerprint) || store?.lookupByCwd(canonicalCwd);
  const relocated = Boolean(prior?.canonicalCwd && !samePath(prior.canonicalCwd, canonicalCwd));
  const previousCwd = relocated ? prior.canonicalCwd : null;
  store?.remember({ anchorId, projectId, canonicalCwd, fingerprint });
  return { projectId, anchorId, relocated, previousCwd };
}

export function classifyBridgeConsistency(faces) {
  const statuses = [faces?.source?.status, faces?.runtime?.status, faces?.process?.status, faces?.evidence?.status];
  if (faces?.source?.status === "missing") return "unknown";
  if (statuses.includes("degraded") || faces?.evidence?.status === "failed") return "degraded";
  if (statuses.includes("stale")) return "stale";
  if (statuses.every((status) => status === "ok")) return "consistent";
  return "unknown";
}

function face(status, extra = {}) {
  return { status: BRIDGE_FACE_STATUSES.includes(status) ? status : "unknown", ...extra };
}

function normalizeEvidence(value) {
  if (!value || typeof value !== "object") {
    return { status: "unknown", sourceCommit: null, branch: null, runtimePid: null, runtimeGeneration: null };
  }
  return {
    status: ["passed", "failed", "unknown"].includes(value.status) ? value.status : "unknown",
    sourceCommit: value.sourceCommit || null,
    branch: value.branch || null,
    runtimePid: Number.isSafeInteger(value.runtimePid) ? value.runtimePid : null,
    runtimeGeneration: value.runtimeGeneration ?? null,
  };
}

async function inspectSource(canonicalCwd, { runner, realpathImpl }) {
  let exists = true;
  let resolved = canonicalCwd;
  try {
    resolved = await realpathImpl(canonicalCwd);
  } catch (error) {
    exists = error?.code !== "ENOENT";
    if (error?.code === "ENOENT") {
      return {
        exists: false,
        canonicalCwd,
        gitCommonDir: null,
        firstCommit: null,
        head: null,
        branch: null,
      };
    }
  }
  const git = async (args) => runner("git", ["-C", resolved, ...args], { timeoutMs: 8_000, provider: null });
  const common = await git(["rev-parse", "--git-common-dir"]).catch(() => ({ code: 1, stdout: "" }));
  const head = await git(["rev-parse", "HEAD"]).catch(() => ({ code: 1, stdout: "" }));
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ({ code: 1, stdout: "" }));
  const first = await git(["rev-list", "--max-parents=0", "HEAD"]).catch(() => ({ code: 1, stdout: "" }));
  const gitCommonDir = common.code === 0 ? String(common.stdout || "").trim() : null;
  return {
    exists,
    canonicalCwd: resolved,
    gitCommonDir: gitCommonDir ? resolve(resolved, gitCommonDir) : null,
    firstCommit: first.code === 0 ? String(first.stdout || "").trim().split(/\s+/)[0] || null : null,
    head: head.code === 0 ? String(head.stdout || "").trim() || null : null,
    branch: branch.code === 0 ? String(branch.stdout || "").trim() || null : null,
  };
}

export async function inspectProjectIdentity(cwd, {
  runner = runProcess,
  realpathImpl = fsRealpath,
} = {}) {
  const requested = normalizeProjectCwd(cwd);
  const source = await inspectSource(requested, { runner, realpathImpl });
  if (!source.exists) {
    throw Object.assign(new Error(`project cwd does not exist: ${requested}`), { code: "INVALID_CWD" });
  }
  const fingerprint = repositoryFingerprint({
    gitCommonDir: source.gitCommonDir,
    firstCommit: source.firstCommit,
    canonicalCwd: source.canonicalCwd,
  });
  return {
    projectId: projectIdFromCwd(source.canonicalCwd),
    anchorId: anchorIdFromFingerprint(fingerprint),
    canonicalCwd: source.canonicalCwd,
    fingerprint,
    gitCommonDir: source.gitCommonDir,
    firstCommit: source.firstCommit,
  };
}

export async function collectProjectBridge({
  cwd,
  runtime = {},
  processes = [],
  evidence = null,
  store = null,
  now = () => new Date().toISOString(),
  runner = runProcess,
  realpathImpl = fsRealpath,
} = {}) {
  const lexical = normalizeProjectCwd(cwd);
  const inspected = await inspectSource(lexical, { runner, realpathImpl });
  const fingerprint = repositoryFingerprint({
    gitCommonDir: inspected.gitCommonDir,
    firstCommit: inspected.firstCommit,
    canonicalCwd: inspected.canonicalCwd,
  });
  const identity = resolveProjectAnchor({
    canonicalCwd: inspected.canonicalCwd,
    fingerprint,
    store,
  });
  const normalizedEvidence = normalizeEvidence(evidence);
  const pid = Number(runtime.pid);
  const pidAlive = processIsAlive(pid);
  const processItems = Array.isArray(processes) ? processes.slice(0, 32) : [];

  let sourceStatus = "unknown";
  if (!inspected.exists) sourceStatus = "missing";
  else if (identity.relocated) sourceStatus = "stale";
  else if (normalizedEvidence.branch && inspected.branch && normalizedEvidence.branch !== inspected.branch) sourceStatus = "stale";
  else if (inspected.gitCommonDir && inspected.head) sourceStatus = "ok";
  else if (inspected.exists) sourceStatus = "unknown";

  let runtimeStatus = "unknown";
  if (normalizedEvidence.runtimePid && Number.isSafeInteger(pid) && normalizedEvidence.runtimePid !== pid) runtimeStatus = "stale";
  else if (normalizedEvidence.runtimeGeneration != null && runtime.generation != null && normalizedEvidence.runtimeGeneration !== runtime.generation) {
    runtimeStatus = "stale";
  } else if (Number.isSafeInteger(pid) && pidAlive && runtime.generation != null) runtimeStatus = "ok";

  const processStatus = Array.isArray(processes) ? "ok" : "unknown";

  let evidenceStatus = "unknown";
  if (normalizedEvidence.status === "failed") evidenceStatus = "degraded";
  else if (normalizedEvidence.status === "passed" && normalizedEvidence.sourceCommit && inspected.head && normalizedEvidence.sourceCommit !== inspected.head) {
    evidenceStatus = "stale";
  } else if (normalizedEvidence.status === "passed" && normalizedEvidence.sourceCommit && normalizedEvidence.sourceCommit === inspected.head) {
    evidenceStatus = "ok";
  }

  const faces = {
    source: face(sourceStatus, {
      fingerprint,
      headDigest: inspected.head ? digestHex("514cc.head/v1", [inspected.head], 16) : null,
      branch: inspected.branch,
      relocated: identity.relocated,
      name: basename(inspected.canonicalCwd),
    }),
    runtime: face(runtimeStatus, {
      pid: Number.isSafeInteger(pid) ? pid : null,
      generation: runtime.generation ?? null,
      startedAt: runtime.startedAt ?? null,
      alive: pidAlive,
    }),
    process: face(processStatus, {
      running: processItems.length,
      pids: processItems.map((item) => Number(item.pid) || null).filter(Boolean).slice(0, 12),
    }),
    evidence: face(evidenceStatus, {
      sourceCommit: normalizedEvidence.sourceCommit,
      checkedAt: evidence?.checkedAt || null,
      commands: Array.isArray(evidence?.commands) ? evidence.commands.slice(0, 8) : [],
    }),
  };

  const consistency = classifyBridgeConsistency(faces);
  return Object.freeze({
    schema: PROJECT_BRIDGE_SCHEMA,
    capturedAt: now(),
    projectId: identity.projectId,
    anchorId: identity.anchorId,
    canonicalCwd: inspected.canonicalCwd,
    previousCwd: identity.previousCwd,
    faces,
    consistency,
    diagnosis: consistency === "unknown"
      ? "四面未齐，不能称为项目已接通"
      : consistency === "consistent"
        ? `锚点 ${identity.anchorId.slice(0, 12)} 四面一致`
        : `项目桥 ${consistency}`,
  });
}
