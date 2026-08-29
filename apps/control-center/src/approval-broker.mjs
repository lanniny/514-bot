import { createHash, randomUUID } from "node:crypto";
import { sanitizeForPersistence } from "./redaction.mjs";

function actionHash(message) {
  return createHash("sha256").update(JSON.stringify({ method: message.method, params: message.params })).digest("hex");
}

function responseFor(method, approved, approvalId = null) {
  if (method === "control/runBuild/requestApproval") {
    return { decision: approved ? "accept" : "decline", approvalId };
  }
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) {
    return { decision: approved ? "accept" : "decline" };
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: approved ? "approved" : "denied" };
  }
  if (method === "item/permissions/requestApproval") {
    if (!approved) return { permissions: {}, scope: "turn" };
    throw Object.assign(new Error("broad permission grants are not supported by Control Center v1"), { code: "UNSUPPORTED_APPROVAL" });
  }
  throw Object.assign(new Error(`unsupported approval method: ${method}`), { code: "UNSUPPORTED_APPROVAL" });
}

export class ApprovalBroker {
  constructor({ eventStore, ttlMs = 300_000 }) {
    this.eventStore = eventStore;
    this.ttlMs = ttlMs;
    this.pending = new Map();
    this.snapshotEpoch = randomUUID();
    this.revision = 0;
  }

  list() {
    return [...this.pending.values()].map(({ resolve, reject, timer, raw, ...item }) => item);
  }

  snapshot() {
    return { approvals: this.list(), epoch: this.snapshotEpoch, revision: this.revision };
  }

  scheduleExpiry(id, item) {
    const remainingMs = Math.max(0, Date.parse(item.expiresAt) - Date.now());
    item.timer = setTimeout(() => void this.expire(id, item), remainingMs);
  }

  async expire(id, item) {
    if (this.pending.get(id) !== item || item.status !== "pending") return;
    item.status = "resolving";
    clearTimeout(item.timer);
    try {
      await this.eventStore.emit(
        "approval.expired",
        { id, actionSha256: item.actionSha256 },
        { runId: item.runId, sessionId: item.sessionId, agentId: "codex-technical" },
      );
    } catch {
      // Expiry is fail-closed even when the audit sink is unavailable.
    }
    if (this.pending.get(id) !== item) return;
    this.pending.delete(id);
    this.revision += 1;
    item.resolve(responseFor(item.method, false));
  }

  async request(message, context = {}) {
    responseFor(message.method, false);
    const id = randomUUID();
    const sha256 = actionHash(message);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    const visibleParams = sanitizeForPersistence(message.params || {});
    const item = {
      id,
      method: message.method,
      actionSha256: sha256,
      createdAt,
      expiresAt,
      status: "pending",
      params: visibleParams,
      runId: context.runId || null,
      sessionId: context.sessionId || null,
    };
    await this.eventStore.emit("approval.pending", item, {
      runId: item.runId,
      sessionId: item.sessionId,
      agentId: "codex-technical",
      sensitivity: "sensitive",
    });
    return new Promise((resolve, reject) => {
      const pending = { ...item, raw: message, resolve, reject, timer: null };
      this.pending.set(id, pending);
      this.revision += 1;
      this.scheduleExpiry(id, pending);
    });
  }

  async resolve(id, { decision, actionSha256: suppliedHash, actor = "operator" }) {
    const item = this.pending.get(id);
    if (!item) throw Object.assign(new Error("approval request not found or expired"), { code: "APPROVAL_NOT_FOUND" });
    if (item.status !== "pending") throw Object.assign(new Error("approval decision is already being persisted"), { code: "APPROVAL_IN_PROGRESS" });
    if (suppliedHash !== item.actionSha256) throw Object.assign(new Error("approval action hash does not match"), { code: "APPROVAL_HASH_MISMATCH" });
    if (!["approve", "deny"].includes(decision)) throw Object.assign(new Error("decision must be approve or deny"), { code: "INVALID_DECISION" });
    const approved = decision === "approve";
    const response = responseFor(item.method, approved);
    clearTimeout(item.timer);
    item.status = "resolving";
    try {
      await this.eventStore.emit(
        "approval.resolved",
        { id, actionSha256: item.actionSha256, decision, actor },
        { runId: item.runId, sessionId: item.sessionId, agentId: "codex-technical", sensitivity: "sensitive" },
      );
    } catch (error) {
      item.status = "pending";
      this.scheduleExpiry(id, item);
      throw Object.assign(new Error(`approval decision was not released because its audit record failed: ${error.message}`), {
        code: "APPROVAL_AUDIT_FAILED",
        cause: error,
      });
    }
    if (this.pending.get(id) !== item) {
      throw Object.assign(new Error("approval was cancelled while the decision was being persisted"), { code: "APPROVAL_NOT_FOUND" });
    }
    this.pending.delete(id);
    this.revision += 1;
    item.resolve(responseFor(item.method, approved, id));
    return {
      id,
      decision,
      actionSha256: item.actionSha256,
      runId: item.runId,
      method: item.method,
    };
  }

  async denyAll(reason = "control plane shutdown") {
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      item.status = "resolving";
      await this.eventStore.emit("approval.resolved", { id, decision: "deny", reason }, { runId: item.runId, sessionId: item.sessionId, agentId: "codex-technical" }).catch(() => {});
      try {
        item.resolve(responseFor(item.method, false));
      } catch (error) {
        item.reject(error);
      }
      this.pending.delete(id);
      this.revision += 1;
    }
  }

  async denyRun(runId, reason = "run cancelled") {
    for (const [id, item] of this.pending) {
      if (item.runId !== runId) continue;
      clearTimeout(item.timer);
      item.status = "resolving";
      await this.eventStore.emit("approval.resolved", { id, decision: "deny", reason }, { runId, sessionId: item.sessionId, agentId: "control-plane" }).catch(() => {});
      try {
        item.resolve(responseFor(item.method, false));
      } catch (error) {
        item.reject(error);
      }
      this.pending.delete(id);
      this.revision += 1;
    }
  }
}
