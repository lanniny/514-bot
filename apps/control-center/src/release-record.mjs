import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { collectDeliveryManifest } from "../scripts/qa-delivery-manifest.mjs";
import { collectReleaseTruth } from "./release-truth.mjs";

export const RELEASE_RECORD_SCHEMA = "514cc.releaseRecord/v1";
export const RELEASE_COMMAND_EVIDENCE_SCHEMA = "514cc.release-command-evidence/v1";
export const RELEASE_COMMAND_IDS = Object.freeze([
  "validate",
  "focusedTests",
  "fullTests",
  "browserQa",
]);
export const RELEASE_COMMAND_STATUSES = Object.freeze([
  "passed",
  "failed",
  "unknown",
  "partial",
  "blocked",
  "skipped",
]);
export const RELEASE_GATE_VERDICTS = Object.freeze(["unknown", "blocked", "partial", "ready"]);
export const RELEASE_COMMAND_PROVENANCE = Object.freeze(["operator-attested", "server-observed"]);
export const RELEASE_EVIDENCE_TRUST = Object.freeze(["none", "operator-attested", "independent"]);
export const AUTO_GIT_ACTIONS = Object.freeze({ add: false, commit: false, push: false });

const COMMAND_LABELS = Object.freeze({
  validate: "validate",
  focusedTests: "focused tests",
  fullTests: "full tests",
  browserQa: "browser QA",
});

function asText(value, fallback = "") {
  const clean = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  return clean || fallback;
}

function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asSafeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function commandMap(commands) {
  if (Array.isArray(commands)) {
    return Object.fromEntries(commands
      .filter((item) => item && typeof item === "object" && item.id)
      .map((item) => [item.id, item]));
  }
  return commands && typeof commands === "object" ? commands : {};
}

function commandProvenance(value) {
  return value?.provenance === "server-observed" ? "server-observed" : "operator-attested";
}

function evidenceTrustFor(provenance) {
  return provenance === "server-observed" ? "independent" : "operator-attested";
}

function runtimeIdentityFrom(value, { prefix = "" } = {}) {
  const key = (name) => prefix ? `${prefix}${name[0].toUpperCase()}${name.slice(1)}` : name;
  const pid = asSafeInteger(value?.[key("pid")]);
  const generation = asSafeInteger(value?.[key("generation")]);
  const startedAt = asText(value?.[key("startedAt")]) || null;
  return { pid, generation, startedAt };
}

function runtimeIdentityMatches(left, right) {
  return Boolean(left?.pid > 0
    && right?.pid > 0
    && left.generation != null
    && right.generation != null
    && left.startedAt
    && right.startedAt
    && left.pid === right.pid
    && left.generation === right.generation
    && left.startedAt === right.startedAt);
}

function commandEvidenceIsReleaseReady(command) {
  return command?.status === "passed"
    && command?.matchesSource === true
    && command?.matchesWorkspace === true
    && command?.matchesRuntime === true
    && command?.provenance === "server-observed"
    && command?.evidenceTrust === "independent";
}

export function normalizeCommandEvidence(raw, { sourceCommit = null, diffDigest = null, runtime = null } = {}) {
  const incoming = commandMap(raw);
  const currentRuntime = runtimeIdentityFrom(runtime || {});
  return RELEASE_COMMAND_IDS.map((id) => {
    const value = incoming[id];
    if (!value || typeof value !== "object") {
      return {
        id,
        label: COMMAND_LABELS[id],
        status: "unknown",
        exitCode: null,
        durationMs: null,
        sourceCommit: null,
        diffDigest: null,
        workspaceClean: false,
        checkedAt: null,
        matchesSource: false,
        matchesWorkspace: false,
        matchesRuntime: false,
        provenance: null,
        evidenceTrust: "none",
        runId: null,
        runtimePid: null,
        runtimeGeneration: null,
        runtimeStartedAt: null,
      };
    }
    const exitCode = asFiniteNumber(value.exitCode);
    const durationMs = asFiniteNumber(value.durationMs);
    const evidenceCommit = asText(value.sourceCommit) || null;
    const evidenceDiffDigest = asText(value.diffDigest) || null;
    const workspaceClean = value.workspaceClean === true;
    const evidenceRuntime = runtimeIdentityFrom(value, { prefix: "runtime" });
    let status = RELEASE_COMMAND_STATUSES.includes(value.status) ? value.status : "unknown";
    if (status === "passed" && exitCode !== 0) status = "failed";
    if (status === "passed" && !evidenceCommit) status = "unknown";
    if (status === "passed" && (durationMs == null || durationMs < 0)) status = "partial";
    const matchesSource = Boolean(evidenceCommit && sourceCommit && evidenceCommit === sourceCommit);
    const matchesWorkspace = Boolean(
      workspaceClean
      && evidenceDiffDigest
      && diffDigest
      && evidenceDiffDigest === diffDigest,
    );
    const provenance = commandProvenance(value);
    const matchesRuntime = runtimeIdentityMatches(evidenceRuntime, currentRuntime);
    return {
      id,
      label: COMMAND_LABELS[id],
      status,
      exitCode,
      durationMs: durationMs == null || durationMs < 0 ? null : durationMs,
      sourceCommit: evidenceCommit,
      diffDigest: evidenceDiffDigest,
      workspaceClean,
      checkedAt: asText(value.checkedAt) || null,
      matchesSource,
      matchesWorkspace,
      matchesRuntime,
      provenance,
      evidenceTrust: evidenceTrustFor(provenance),
      runId: asText(value.runId) || null,
      runtimePid: evidenceRuntime.pid,
      runtimeGeneration: evidenceRuntime.generation,
      runtimeStartedAt: evidenceRuntime.startedAt,
    };
  });
}

export function summarizeServerObservedValidation(raw, { runtime = null } = {}) {
  const incoming = commandMap(raw);
  const currentRuntime = runtimeIdentityFrom(runtime || {});
  const rows = RELEASE_COMMAND_IDS.map((id) => incoming[id]);
  if (rows.some((value) => !value || typeof value !== "object")) return null;
  const eligible = rows.every((value) => {
    const evidenceRuntime = runtimeIdentityFrom(value, { prefix: "runtime" });
    const durationMs = asFiniteNumber(value.durationMs);
    return value.status === "passed"
      && asFiniteNumber(value.exitCode) === 0
      && durationMs != null
      && durationMs >= 0
      && value.workspaceClean === true
      && commandProvenance(value) === "server-observed"
      && runtimeIdentityMatches(evidenceRuntime, currentRuntime)
      && Boolean(asText(value.sourceCommit))
      && Boolean(asText(value.diffDigest))
      && Boolean(asText(value.checkedAt));
  });
  if (!eligible) return null;
  const sourceCommits = new Set(rows.map((value) => asText(value.sourceCommit)));
  const diffDigests = new Set(rows.map((value) => asText(value.diffDigest)));
  if (sourceCommits.size !== 1 || diffDigests.size !== 1) return null;
  const checkedAt = rows
    .map((value) => asText(value.checkedAt))
    .sort()
    .at(-1);
  return {
    status: "passed",
    sourceCommit: [...sourceCommits][0],
    diffDigest: [...diffDigests][0],
    workspaceClean: true,
    commands: [...RELEASE_COMMAND_IDS],
    checkedAt,
    complete: true,
    provenance: "server-observed",
    evidenceTrust: "independent",
    runtimePid: currentRuntime.pid,
    runtimeGeneration: currentRuntime.generation,
    runtimeStartedAt: currentRuntime.startedAt,
  };
}

function undeclaredPaths(deliveryManifest) {
  const owned = deliveryManifest?.ownership?.undeclaredSourceOrTests;
  if (Array.isArray(owned)) return owned;
  return Array.isArray(deliveryManifest?.untrackedSourceOrTests) ? deliveryManifest.untrackedSourceOrTests : [];
}

function missingPaths(deliveryManifest) {
  return Array.isArray(deliveryManifest?.missingSourceOrTests) ? deliveryManifest.missingSourceOrTests : [];
}

export function collectUnfinishedItems({
  deliveryManifest = null,
  commands = [],
  releaseTruth = null,
  formalRelease = false,
  workflow = null,
} = {}) {
  const items = [];
  const undeclared = undeclaredPaths(deliveryManifest);
  const missing = missingPaths(deliveryManifest);
  if (undeclared.length) {
    items.push({
      id: "undeclared-source",
      status: "blocked",
      reason: `${undeclared.length} 个未声明源码/测试；未获逐字授权前不 git add`,
    });
  }
  if (missing.length) {
    items.push({
      id: "missing-source",
      status: "blocked",
      reason: `${missing.length} 个已跟踪源码/测试在磁盘上消失`,
    });
  }
  if (deliveryManifest?.strictFailure && !undeclared.length && !missing.length) {
    items.push({
      id: "delivery-strict",
      status: "blocked",
      reason: "交付所有权闸 strict 失败",
    });
  }
  if (releaseTruth?.dirty) {
    items.push({
      id: "dirty-worktree",
      status: "partial",
      reason: "工作区有未提交差异，不能把运行态说成已对账",
    });
  }
  if (releaseTruth?.consistency !== "consistent") {
    const consistency = asText(releaseTruth?.consistency, "unknown");
    items.push({
      id: "runtime-consistency",
      status: consistency === "stale" || consistency === "degraded" ? "blocked" : "partial",
      reason: consistency === "unknown"
        ? "运行态一致性未知，不能把客户端声明当作 readback"
        : `运行态一致性为 ${consistency}，必须重新验证并回读`,
    });
  }
  if (!releaseTruth?.activation?.claimed) {
    items.push({
      id: "runtime-not-activated",
      status: "blocked",
      reason: releaseTruth?.activation?.text || "没有当轮 readback，运行态未激活",
    });
  }
  for (const command of commands) {
    if (commandEvidenceIsReleaseReady(command)) continue;
    items.push({
      id: `command:${command.id}`,
      status: command.status === "failed" ? "blocked" : "partial",
      reason: command.status === "failed"
        ? `${command.label} 失败 exit=${command.exitCode ?? "unknown"}`
        : command.status === "skipped"
          ? `${command.label} 被收口策略跳过（前一命令未通过），需全链重跑`
          : command.status === "passed" && command.matchesSource && command.evidenceTrust !== "independent"
          ? `${command.label} 仅有操作者自述，缺少服务端独立观测证据`
        : command.status === "passed" && command.matchesSource && command.matchesWorkspace !== true
          ? `${command.label} 证据未绑定当前干净工作树`
          : command.status === "passed" && command.matchesSource && command.matchesRuntime !== true
            ? `${command.label} 证据未绑定当前运行实例`
          : command.matchesSource === false && command.status === "passed"
              ? `${command.label} 证据不指向当前提交`
              : `还没有当轮 ${command.label} 的退出码和时间`,
    });
  }
  if (formalRelease !== true) {
    items.push({
      id: "formal-release",
      status: "partial",
      reason: "正式版本升格未授权，记录再绿也不能当已发布",
    });
  }
  const workflowStatus = asText(workflow?.status);
  if (workflowStatus && !["complete", "blocked", "cancelled", "superseded"].includes(workflowStatus)) {
    items.push({
      id: "workflow",
      status: "partial",
      reason: `工作流仍是 ${workflowStatus}，不能当成已结算`,
    });
  }
  return items;
}

export function classifyReleaseGate({ commands = [], unfinished = [], releaseTruth = null } = {}) {
  if (unfinished.some((item) => item.status === "blocked")) return "blocked";
  if (commands.some((item) => item.status === "failed")) return "blocked";
  if (releaseTruth?.consistency === "unknown" || !releaseTruth?.sourceCommit) return "unknown";
  if (releaseTruth?.consistency !== "consistent") return "blocked";
  const commandsReady = commands.every(commandEvidenceIsReleaseReady);
  // formal-release 只挡 publishable，不挡工程门 ready——否则「工程齐、版本未升」永远到不了 ready。
  const engineeringGaps = unfinished.filter((item) => item.id !== "formal-release");
  if (commandsReady && engineeringGaps.length === 0 && releaseTruth?.activation?.claimed === true) return "ready";
  return "partial";
}

function nextActionFor(verdict, unfinished, publishable) {
  const blocked = unfinished.find((item) => item.status === "blocked");
  if (verdict === "blocked" && blocked) {
    return { id: blocked.id, text: blocked.reason };
  }
  if (verdict === "unknown") {
    const consistency = unfinished.find((item) => item.id === "runtime-consistency");
    if (consistency) return { id: consistency.id, text: consistency.reason };
  }
  const missingCommand = unfinished.find((item) => String(item.id).startsWith("command:"));
  if (missingCommand) {
    return { id: missingCommand.id, text: missingCommand.reason };
  }
  if (verdict === "ready" && publishable) {
    return { id: "publishable", text: "当轮发布记录可引用，仍不会自动 commit/push" };
  }
  if (verdict === "ready") {
    return { id: "formal-release", text: "工程门已齐，正式发布仍未授权" };
  }
  const first = unfinished[0];
  return { id: first?.id || "partial", text: first?.reason || "发布记录不完整，不能涂绿" };
}

export function synthesizeReleaseRecord({
  deliveryManifest = null,
  releaseTruth = null,
  commands: rawCommands = null,
  workflow = null,
  now = () => new Date().toISOString(),
} = {}) {
  const sourceCommit = asText(releaseTruth?.sourceCommit) || null;
  const diffDigest = asText(releaseTruth?.diffDigest) || null;
  const commands = normalizeCommandEvidence(rawCommands, {
    sourceCommit,
    diffDigest,
    runtime: {
      pid: releaseTruth?.pid,
      generation: releaseTruth?.runtimeGeneration,
      startedAt: releaseTruth?.startedAt,
    },
  });
  const formalRelease = deliveryManifest?.ownership?.cut?.formalRelease === true;
  const activationClaimed = releaseTruth?.consistency === "consistent"
    && releaseTruth?.activation?.claimed === true;
  const unfinished = collectUnfinishedItems({
    deliveryManifest,
    commands,
    releaseTruth,
    formalRelease,
    workflow,
  });
  const verdict = classifyReleaseGate({ commands, unfinished, releaseTruth });
  const publishable = verdict === "ready"
    && formalRelease === true
    && releaseTruth?.consistency === "consistent"
    && activationClaimed
    && commands.every(commandEvidenceIsReleaseReady);
  return {
    schema: RELEASE_RECORD_SCHEMA,
    capturedAt: typeof now === "function" ? now() : now,
    verdict,
    publishable,
    formalRelease,
    cut: deliveryManifest?.ownership?.cut || null,
    autoGit: { ...AUTO_GIT_ACTIONS },
    sourceCommit,
    diffDigest: asText(releaseTruth?.diffDigest) || null,
    dirty: releaseTruth?.dirty === true,
    runtime: {
      pid: releaseTruth?.pid ?? null,
      cwd: releaseTruth?.cwd || null,
      generation: releaseTruth?.runtimeGeneration ?? null,
      startedAt: releaseTruth?.startedAt || null,
      reloaded: activationClaimed,
      activated: activationClaimed,
      consistency: releaseTruth?.consistency || "unknown",
    },
    delivery: {
      clean: deliveryManifest?.clean === true,
      strictFailure: deliveryManifest?.strictFailure === true,
      undeclaredSourceOrTests: undeclaredPaths(deliveryManifest),
      missingSourceOrTests: missingPaths(deliveryManifest),
    },
    commands,
    unfinished,
    nextAction: nextActionFor(verdict, unfinished, publishable),
    activation: activationClaimed
      ? releaseTruth.activation
      : {
          claimed: false,
          text: releaseTruth?.consistency === "consistent"
            ? releaseTruth?.activation?.text || "未知：本轮没有可引用的 readback"
            : "未知：运行态一致性未得到独立 readback",
        },
  };
}

export async function collectReleaseRecord({
  repoRoot,
  runtime = {},
  releaseTruth = null,
  deliveryManifest = null,
  commandEvidence = null,
  workflow = null,
  executeCommands = false,
  collectManifest = collectDeliveryManifest,
  collectTruth = collectReleaseTruth,
  now = () => new Date().toISOString(),
} = {}) {
  if (executeCommands === true) {
    throw Object.assign(new Error("release record does not execute validate/tests/browser QA"), {
      code: "RELEASE_RECORD_NO_EXECUTE",
    });
  }
  const truth = releaseTruth || await collectTruth({ repoRoot, runtime, now });
  const manifest = deliveryManifest || await collectManifest({ repoRoot });
  return synthesizeReleaseRecord({
    deliveryManifest: manifest,
    releaseTruth: truth,
    commands: commandEvidence,
    workflow,
    now,
  });
}

export function createReleaseCommandEvidenceStore({ dataRoot }) {
  const path = join(dataRoot, "release-command-evidence.json");
  let cache = null;
  let chain = Promise.resolve();

  async function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      cache = {
        schema: RELEASE_COMMAND_EVIDENCE_SCHEMA,
        updatedAt: parsed.updatedAt || null,
        commands: parsed.commands && typeof parsed.commands === "object" ? parsed.commands : {},
      };
    } catch {
      cache = { schema: RELEASE_COMMAND_EVIDENCE_SCHEMA, updatedAt: null, commands: {} };
    }
    return cache;
  }

  async function persist(next) {
    await mkdir(dataRoot, { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next)}\n`, "utf8");
    await rename(tmp, path);
    cache = next;
  }

  function serialize(operation) {
    const next = chain.then(operation, operation);
    chain = next.then(() => undefined, () => undefined);
    return next;
  }

  return {
    async snapshot() {
      const state = await load();
      return { ...state.commands };
    },
    async save(commands = {}) {
      return saveWithProvenance(commands, "operator-attested");
    },
    async saveObserved(commands = {}) {
      return saveWithProvenance(commands, "server-observed");
    },
  };

  function saveWithProvenance(commands, provenance) {
    return serialize(async () => {
        const incoming = commandMap(commands);
        const nextCommands = {};
        for (const id of RELEASE_COMMAND_IDS) {
          if (!incoming[id] || typeof incoming[id] !== "object") continue;
          const value = incoming[id];
          const exitCode = asFiniteNumber(value.exitCode);
          const durationMs = asFiniteNumber(value.durationMs);
          const evidenceCommit = asText(value.sourceCommit) || null;
          const evidenceDiffDigest = asText(value.diffDigest) || null;
          const workspaceClean = value.workspaceClean === true;
          const evidenceRuntime = runtimeIdentityFrom(value, { prefix: "runtime" });
          let status = RELEASE_COMMAND_STATUSES.includes(value.status) ? value.status : "unknown";
          if (status === "passed" && (exitCode !== 0 || !evidenceCommit || durationMs == null || durationMs < 0)) {
            throw Object.assign(new Error(`command evidence ${id} is incomplete for passed`), {
              code: "RELEASE_COMMAND_EVIDENCE_INCOMPLETE",
            });
          }
          if (provenance === "server-observed" && status === "passed" && (
            !workspaceClean
            || !evidenceDiffDigest
            || evidenceRuntime.pid == null
            || evidenceRuntime.generation == null
            || !evidenceRuntime.startedAt
          )) {
            throw Object.assign(new Error(`server-observed command evidence ${id} lacks a clean worktree or runtime anchor`), {
              code: "RELEASE_COMMAND_EVIDENCE_INCOMPLETE",
            });
          }
          nextCommands[id] = {
            status,
            exitCode,
            durationMs: durationMs == null || durationMs < 0 ? null : durationMs,
            sourceCommit: evidenceCommit,
            diffDigest: evidenceDiffDigest,
            workspaceClean,
            checkedAt: asText(value.checkedAt) || new Date().toISOString(),
            provenance,
            evidenceTrust: evidenceTrustFor(provenance),
            attested: provenance === "operator-attested",
            runId: asText(value.runId) || null,
            runtimePid: provenance === "server-observed" ? evidenceRuntime.pid : null,
            runtimeGeneration: provenance === "server-observed" ? evidenceRuntime.generation : null,
            runtimeStartedAt: provenance === "server-observed" ? evidenceRuntime.startedAt : null,
            note: asText(value.note).slice(0, 180) || null,
          };
        }
        const previous = await load();
        const next = {
          schema: RELEASE_COMMAND_EVIDENCE_SCHEMA,
          updatedAt: new Date().toISOString(),
          commands: { ...previous.commands, ...nextCommands },
        };
        await persist(next);
        return next;
    });
  }
}
