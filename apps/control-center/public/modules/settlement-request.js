/**
 * Bounded, cancellable settlement requests shared by the Bot and Workbench
 * surfaces.  Ownership of the response remains with the caller's generation
 * gate; this module only bounds transport time and exposes cancellation.
 */

export function createSettlementRequester({
  request,
  pathForRun,
  timeoutMs = 12_000,
  AbortControllerImpl = globalThis.AbortController,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  if (typeof request !== "function") throw new TypeError("settlement requester needs request()");
  if (typeof pathForRun !== "function") throw new TypeError("settlement requester needs pathForRun()");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("settlement timeout must be positive");

  const records = new Map();
  const keyFor = (surface, runId) => `${String(surface || "")}:${String(runId || "")}`;

  function cancel(surface, runId) {
    const key = keyFor(surface, runId);
    const record = records.get(key);
    if (!record) return false;
    records.delete(key);
    record.controller?.abort();
    return true;
  }

  function cancelSurface(surface) {
    const prefix = `${String(surface || "")}:`;
    let cancelled = 0;
    for (const [key, record] of records) {
      if (!key.startsWith(prefix)) continue;
      records.delete(key);
      record.controller?.abort();
      cancelled += 1;
    }
    return cancelled;
  }

  async function load(surface, runId) {
    const key = keyFor(surface, runId);
    cancel(surface, runId);
    const controller = typeof AbortControllerImpl === "function" ? new AbortControllerImpl() : null;
    const record = { controller, timedOut: false, timer: null };
    records.set(key, record);
    const timeout = new Promise((_, reject) => {
      record.timer = setTimeoutFn(() => {
        record.timedOut = true;
        controller?.abort();
        const error = new Error("结算读取超时，请重试");
        error.code = "SETTLEMENT_TIMEOUT";
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        request(pathForRun(runId), controller ? { signal: controller.signal } : undefined),
        timeout,
      ]);
    } catch (error) {
      if (record.timedOut) {
        const timeoutError = new Error("结算读取超时，请重试");
        timeoutError.code = "SETTLEMENT_TIMEOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeoutFn(record.timer);
      if (records.get(key) === record) records.delete(key);
    }
  }

  return Object.freeze({
    load,
    cancel,
    cancelSurface,
    pending: () => records.size,
  });
}
