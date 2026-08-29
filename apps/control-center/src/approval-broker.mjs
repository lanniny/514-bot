import { createHash, randomUUID } from "node:crypto";
import { sanitizeForPersistence } from "./redaction.mjs";

/**
 * 审批积压上限（F-047）。
 * 正常路径下每个 agent 都会阻塞等待自己的审批，pending 数的天然上界≈并发席位数；
 * 这两个闸只在两种异常下触发：审批泄漏（agent 崩溃、承诺永不结算，只能等 TTL 兜底）
 * 与洪水式请求。超限一律**拒绝新请求** —— 绝不自动放行，也不伪造操作者决策。
 */
export const DEFAULT_MAX_PENDING = 128;
export const DEFAULT_MAX_PENDING_PER_RUN = 32;
/** 审计写入的等待上限：挂起的审计不能把审批永久钉死在 resolving（见 #audit）。 */
export const DEFAULT_AUDIT_TIMEOUT_MS = 5_000;

/** 上限必须是有限正整数：0 / NaN / Infinity / 负数都等于"无上限"，一律回落到默认值。 */
function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** 审计字段一律截断：账本是追加式的，放任一个超长字符串进来就是永久的写放大。 */
function auditText(value, fallback, max = 128) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : fallback;
}

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
  constructor({
    eventStore,
    ttlMs = 300_000,
    maxPending = DEFAULT_MAX_PENDING,
    maxPendingPerRun = DEFAULT_MAX_PENDING_PER_RUN,
    auditTimeoutMs = DEFAULT_AUDIT_TIMEOUT_MS,
  } = {}) {
    this.eventStore = eventStore;
    this.ttlMs = ttlMs;
    this.maxPending = positiveInt(maxPending, DEFAULT_MAX_PENDING);
    this.maxPendingPerRun = positiveInt(maxPendingPerRun, DEFAULT_MAX_PENDING_PER_RUN);
    this.auditTimeoutMs = positiveInt(auditTimeoutMs, DEFAULT_AUDIT_TIMEOUT_MS);
    this.pending = new Map();
    this.snapshotEpoch = randomUUID();
    this.revision = 0;
  }

  list() {
    return [...this.pending.values()].map(({ resolve, reject, timer, raw, ...item }) => item);
  }

  snapshot() {
    // capacity 让"正在被限流"这件事对外可见 —— 一个看不见的限制等于没有限制。
    return { approvals: this.list(), epoch: this.snapshotEpoch, revision: this.revision, capacity: this.capacity() };
  }

  capacity() {
    return { pending: this.pending.size, maxPending: this.maxPending, maxPendingPerRun: this.maxPendingPerRun };
  }

  /**
   * 容量闸门。返回 null 表示可受理；否则返回拒绝详情（此时不创建任何 pending 条目）。
   * 超限时**拒绝受理**，既不淘汰最老的（那会伪造一次操作者决策），也不自动批准。
   */
  #capacityRejection(runId) {
    if (this.pending.size >= this.maxPending) {
      return {
        scope: "global",
        limit: this.maxPending,
        count: this.pending.size,
        message: `approval backlog is full (${this.pending.size}/${this.maxPending}); refusing to queue another request`,
      };
    }
    if (!runId) return null;
    let perRun = 0;
    for (const item of this.pending.values()) if (item.runId === runId) perRun += 1;
    if (perRun >= this.maxPendingPerRun) {
      return {
        scope: "run",
        limit: this.maxPendingPerRun,
        count: perRun,
        message: `run ${runId} already has ${perRun} pending approvals (limit ${this.maxPendingPerRun}); refusing to queue another`,
      };
    }
    return null;
  }

  /**
   * 有界审计写入。resolve() 在写入前已经 clearTimeout 并把状态置成 resolving，
   * 若 emit 永久挂起（磁盘/队列阻塞），这条审批就再没有恢复路径：超时器已清、
   * 状态又不是 pending（resolve 不可重入），操作台只能看着它卡死。
   * 这里给审计一个上限，超时后走与 APPROVAL_AUDIT_FAILED 相同的 fail-closed 分支。
   */
  async #audit(type, data, meta) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(
          new Error(`audit record did not settle within ${this.auditTimeoutMs}ms`),
          { code: "APPROVAL_AUDIT_TIMEOUT" },
        ));
      }, this.auditTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.eventStore.emit(type, data, meta), timeout]);
    } finally {
      clearTimeout(timer);
    }
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
        // actor 三件套与 resolve/deny* 对齐：过期不是"没人决策"，而是系统按策略拒绝。
        { id, actionSha256: item.actionSha256, decision: "deny", actor: "ttl-expiry", actorSource: "internal", clientActor: null },
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
    const runId = context.runId || null;
    const rejection = this.#capacityRejection(runId);
    if (rejection) {
      // 拒绝受理要留痕：否则账本上看不到"曾经有过一次没能进队列的申请"。
      // 这里审计失败不阻断拒绝本身（fail-open on audit, fail-closed on approval）。
      await this.eventStore.emit(
        "approval.capacity_rejected",
        { method: message.method, runId, ...rejection },
        { runId, sessionId: context.sessionId || null, agentId: "codex-technical", sensitivity: "sensitive" },
      ).catch(() => {});
      throw Object.assign(new Error(rejection.message), { code: "APPROVAL_CAPACITY", ...rejection });
    }
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
      runId,
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

  /**
   * actor / actorSource / clientActor 三者必须一起读：
   *  - actor        服务端盖章的身份标签（控制面只有一份共享 bearer 凭证，标识的是凭证不是人）
   *  - actorSource  这个身份是怎么认定的（local-bearer / policy / internal / self-asserted）
   *  - clientActor  请求体自称的身份，留档但不得当作证据
   * 不做这一步的话，F-048 那条不可篡改的哈希链里就会固化一个调用方随便填的字符串，
   * 事后调查极易被误读成"某个人做了这个决定"。
   */
  async resolve(id, { decision, actionSha256: suppliedHash, actor = "operator", actorSource = "self-asserted", clientActor = null } = {}) {
    const item = this.pending.get(id);
    if (!item) throw Object.assign(new Error("approval request not found or expired"), { code: "APPROVAL_NOT_FOUND" });
    if (item.status !== "pending") throw Object.assign(new Error("approval decision is already being persisted"), { code: "APPROVAL_IN_PROGRESS" });
    if (suppliedHash !== item.actionSha256) throw Object.assign(new Error("approval action hash does not match"), { code: "APPROVAL_HASH_MISMATCH" });
    if (!["approve", "deny"].includes(decision)) throw Object.assign(new Error("decision must be approve or deny"), { code: "INVALID_DECISION" });
    const approved = decision === "approve";
    // 三个身份字段一律先截断再入账：账本是追加式的，一个超长字符串进来就是永久的写放大。
    const auditActor = auditText(actor, "operator", 64);
    const auditSource = auditText(actorSource, "self-asserted", 64);
    const auditClientActor = auditText(clientActor, null, 128);
    // responseFor 在这里是**校验闸门**而不是取值：某些审批类型（宽权限授予）根本不允许被批准。
    // 它的返回值下面用不到，但它的抛错是关键路径 —— 不要当死代码删掉。
    try {
      responseFor(item.method, approved);
    } catch (error) {
      // 不可批准的请求不能被"批准"，但也不能让 agent 干等到 TTL 才拿到答复。
      // 走与超时/撤销同一条策略性拒绝路径立即结算，同时把原因抛回给操作者。
      clearTimeout(item.timer);
      item.status = "resolving";
      this.pending.delete(id);
      this.revision += 1;
      item.resolve(responseFor(item.method, false, id));
      this.eventStore.emit(
        "approval.resolved",
        {
          id,
          actionSha256: item.actionSha256,
          decision: "deny",
          actor: "control-plane",
          actorSource: "policy",
          clientActor: auditClientActor,
          reason: error.message,
        },
        { runId: item.runId, sessionId: item.sessionId, agentId: "codex-technical", sensitivity: "sensitive" },
      ).catch(() => {});
      throw error;
    }
    clearTimeout(item.timer);
    item.status = "resolving";
    try {
      await this.#audit(
        "approval.resolved",
        { id, actionSha256: item.actionSha256, decision, actor: auditActor, actorSource: auditSource, clientActor: auditClientActor },
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
      // actionSha256 补齐后，三类终态事件（resolved / denied / expired）形状一致，
      // 下游按字段解析不会再拿到 undefined。
      await this.eventStore.emit(
        "approval.resolved",
        { id, actionSha256: item.actionSha256, decision: "deny", reason, actor: "control-plane", actorSource: "internal", clientActor: null },
        { runId: item.runId, sessionId: item.sessionId, agentId: "codex-technical" },
      ).catch(() => {});
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
      await this.eventStore.emit(
        "approval.resolved",
        { id, actionSha256: item.actionSha256, decision: "deny", reason, actor: "control-plane", actorSource: "internal", clientActor: null },
        { runId, sessionId: item.sessionId, agentId: "control-plane" },
      ).catch(() => {});
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
