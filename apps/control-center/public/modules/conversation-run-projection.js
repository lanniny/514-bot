/**
 * ConversationRunProjection — unified run resolution, optimistic snapshot
 * storage, and settlement cache shared by the Workbench and Bot surfaces.
 *
 * Eliminates the dual state maintenance between:
 *   - Workbench: state.runs.find + state.runSettlementView (single-slot)
 *   - Bot: botState.runSnapshots + botState.settlementViews (per-run)
 */

export const SETTLEMENT_VIEW_TTL_MS = 15_000;

export function settlementRunSignature(run) {
  if (!run?.id) return "";
  const remote = run.remote && typeof run.remote === "object"
    ? `${run.remote.hostId || ""}:${run.remote.path || ""}`
    : "";
  return [
    run.id,
    run.status,
    run.updatedAt || run.completedAt || run.createdAt || "",
    run.round || 0,
    run.worktreePath || "",
    run.worktreeBase || "",
    remote,
    run.recoveryRequired === true ? "recovery" : "",
    run.error || "",
  ].join("|");
}

export function settlementViewNeedsRefresh(view, run, ttlMs) {
  if (!view) return true;
  if (view.status === "loading") return false;
  const signature = settlementRunSignature(run);
  if (signature && view.runSignature && signature !== view.runSignature) return true;
  const loadedAt = Number(view.loadedAt);
  return !Number.isFinite(loadedAt) || Date.now() - loadedAt >= ttlMs;
}

export function createConversationRunProjection({
  getRuns,
  snapshotTtlMs = SETTLEMENT_VIEW_TTL_MS,
  settlementTtlMs = SETTLEMENT_VIEW_TTL_MS,
  surfaces = { workbench: { capacity: 1 }, bot: {} },
  now = () => Date.now(),
  queueMicrotaskFn = globalThis.queueMicrotask,
} = {}) {
  if (typeof getRuns !== "function") throw new TypeError("conversation-run-projection needs getRuns()");

  const snapshots = new Map();
  const snapshotExpiry = new Map();
  const settlementCache = new Map();
  const settlementGens = new Map();
  const settlementQueued = new Map();

  const surfaceKeys = new Map();
  for (const [name, config] of Object.entries(surfaces)) {
    surfaceKeys.set(name, { capacity: config?.capacity ?? Infinity });
  }

  function surfaceKey(surface, runId) {
    return `${String(surface || "")}:${String(runId || "")}`;
  }

  function resolveRun(runId) {
    const id = String(runId || "").trim();
    if (!id) return null;
    const authoritative = getRuns().find((run) => String(run?.id || "") === id);
    if (authoritative) return authoritative;
    const expiry = snapshotExpiry.get(id);
    if (expiry !== undefined && expiry > now()) return snapshots.get(id) || null;
    if (expiry === undefined && snapshots.has(id)) return snapshots.get(id);
    return null;
  }

  function resolveRunStrict(runId) {
    const id = String(runId || "").trim();
    if (!id) return null;
    return getRuns().find((run) => String(run?.id || "") === id) || null;
  }

  function isOptimistic(runId) {
    const id = String(runId || "").trim();
    if (!id) return false;
    const expiry = snapshotExpiry.get(id);
    return expiry !== undefined && expiry > now() && snapshots.has(id);
  }

  function rememberSnapshot(run, { optimistic = true } = {}) {
    if (!run?.id) return;
    const id = String(run.id);
    snapshots.set(id, run);
    if (optimistic) {
      snapshotExpiry.set(id, now() + snapshotTtlMs);
    } else {
      snapshotExpiry.delete(id);
    }
  }

  function promoteSnapshot(run) {
    if (!run?.id) return;
    const id = String(run.id);
    snapshots.set(id, run);
    snapshotExpiry.delete(id);
  }

  function pruneExpiredSnapshots(liveRunIds) {
    const live = new Set([...liveRunIds].map(String));
    for (const runId of [...snapshots.keys()]) {
      if (!live.has(runId)) {
        const expiry = snapshotExpiry.get(runId);
        if (expiry === undefined || expiry <= now()) {
          snapshots.delete(runId);
          snapshotExpiry.delete(runId);
        }
      }
    }
  }

  function forgetSnapshot(runId) {
    const id = String(runId || "").trim();
    snapshots.delete(id);
    snapshotExpiry.delete(id);
  }

  function settlementView(surface, runId) {
    return settlementCache.get(surfaceKey(surface, runId)) || null;
  }

  function setSettlementView(surface, runId, view) {
    const key = surfaceKey(surface, runId);
    const config = surfaceKeys.get(surface);
    if (config && config.capacity === 1 && view) {
      for (const [existingKey] of settlementCache) {
        if (existingKey.startsWith(`${String(surface)}:`) && existingKey !== key) {
          settlementCache.delete(existingKey);
          settlementGens.delete(existingKey);
        }
      }
    }
    settlementCache.set(key, view);
  }

  function clearSettlementView(surface, runId) {
    const key = surfaceKey(surface, runId);
    settlementCache.delete(key);
    const gen = (settlementGens.get(key) || 0) + 1;
    settlementGens.set(key, gen);
    return gen;
  }

  function clearSettlementSurface(surface) {
    const prefix = `${String(surface)}:`;
    const seen = new Set();
    for (const key of [...settlementCache.keys()]) {
      if (key.startsWith(prefix)) {
        settlementCache.delete(key);
        seen.add(key);
      }
    }
    for (const key of [...settlementGens.keys()]) {
      if (key.startsWith(prefix)) seen.add(key);
    }
    for (const key of seen) {
      settlementGens.set(key, (settlementGens.get(key) || 0) + 1);
    }
  }

  function nextSettlementGeneration(surface, runId) {
    const key = surfaceKey(surface, runId);
    const gen = (settlementGens.get(key) || 0) + 1;
    settlementGens.set(key, gen);
    return gen;
  }

  function settlementGeneration(surface, runId) {
    return settlementGens.get(surfaceKey(surface, runId)) || 0;
  }

  function queueSettlementLoad(surface, runId, task) {
    const key = surfaceKey(surface, runId);
    if (settlementQueued.get(key)) return;
    settlementQueued.set(key, true);
    queueMicrotaskFn(() => {
      settlementQueued.delete(key);
      task();
    });
  }

  function settlementNeedsRefresh(surface, runId, run) {
    const view = settlementView(surface, runId);
    return settlementViewNeedsRefresh(view, run, settlementTtlMs);
  }

  async function loadSettlement(surface, runId, {
    force = false,
    runSignature = "",
    skipLoadingGuard = false,
    request,
    validate,
    onChange,
    dropStaleResponses = false,
    getRun = () => resolveRun(runId),
  } = {}) {
    if (typeof request !== "function") throw new TypeError("loadSettlement needs request()");
    if (typeof validate !== "function") throw new TypeError("loadSettlement needs validate()");
    const id = String(runId || "").trim();
    if (!id) return;
    const currentRun = getRun();
    const existing = settlementView(surface, id);
    if (!skipLoadingGuard && existing?.status === "loading") return;
    const ttlMs = settlementTtlMs;
    if (!force && existing && !settlementViewNeedsRefresh(existing, currentRun, ttlMs)) return;
    const signature = runSignature || settlementRunSignature(currentRun);
    const generation = nextSettlementGeneration(surface, id);
    setSettlementView(surface, id, { runId: id, status: "loading", runSignature: signature });
    try {
      const data = await request(id);
      if (settlementGeneration(surface, id) !== generation) return;
      if (dropStaleResponses) {
        const latestRun = getRun();
        if (latestRun && settlementRunSignature(latestRun) !== signature) {
          clearSettlementView(surface, id);
          if (typeof onChange === "function") onChange(null, { stale: true });
          return;
        }
      }
      const validation = validate(data, id);
      const view = validation.ok
        ? { runId: id, status: "ok", data: validation.data, loadedAt: Date.now(), runSignature: signature }
        : { runId: id, status: "invalid", error: validation.reason, loadedAt: Date.now(), runSignature: signature };
      setSettlementView(surface, id, view);
      if (typeof onChange === "function") onChange(view, { stale: false });
    } catch (error) {
      if (error?.name === "AbortError") return;
      if (settlementGeneration(surface, id) !== generation) return;
      const view = { runId: id, status: "error", error: error.message, loadedAt: Date.now(), runSignature: signature };
      setSettlementView(surface, id, view);
      if (typeof onChange === "function") onChange(view, { stale: false });
    }
  }

  return Object.freeze({
    resolveRun,
    resolveRunStrict,
    isOptimistic,
    rememberSnapshot,
    promoteSnapshot,
    pruneExpiredSnapshots,
    forgetSnapshot,
    settlementView,
    setSettlementView,
    clearSettlementView,
    clearSettlementSurface,
    nextSettlementGeneration,
    settlementGeneration,
    queueSettlementLoad,
    settlementNeedsRefresh,
    loadSettlement,
    settlementTtlMs,
  });
}
