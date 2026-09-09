import { createHash, randomUUID } from "node:crypto";
import { approvalResponseFor } from "./approval-methods.mjs";
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

/**
 * 回程摘要（v50 · 2026-09-04）——把**实际回灌给子进程的那个对象**摘进账本。
 *
 * ── 缺口 ──
 * `actionSha256` 只摘入站 `{method, params}`。终态事件记的 `decision: "approve"|"deny"`
 * 是操作者**意图的抽象**，而子进程真正收到的是 `responseFor()` 造出的线上对象
 * （v2 家族 `{decision:"accept",approvalId}` / legacy `{decision:"approved"}` /
 * 宽权限拒绝 `{permissions:{},scope:"turn"}`）。二者从 `decision` 各自独立派生，
 * **从不交叉核对** —— 账本记意图、线上走实体，中间没有任何一步把它们对上。
 *
 * 这不是假想缺陷。本文件上游 `approval-methods.mjs` 头部记录的烛实测就是这条缝的
 * 一次具体命中：浅冻结下运行时 `spec.approvable = true`，即可让宽权限授予回灌
 * `{write:true,network:true}` 而账本仍记 `decision:"deny"`。deepFreeze 补掉了那**一个**
 * 入口，但"账本与线上可以不一致且无人发现"这个**形状**仍在（任何篡改 responseFor
 * 取值链的路径都能重现）。
 *
 * ── 治法 ──
 * 事后加校验没有意义（校验代码与被校验代码同源，一起被改就一起失效）。
 * 改成结构上只算一次：resolve() 先 `responseFor()` 拿到唯一的回灌对象，摘它得
 * `responseSha256` 入账，然后**放行同一个对象引用**。账本里的摘要与线上收到的字节
 * 因此同源 —— 不是"校验过一致"，是"没有第二个可以不一致的东西"。
 *
 * 键序稳定化：JSON.stringify 依赖属性插入序，构造器写法不同会让同一语义摘出不同值。
 * 排序后再摘，使摘要只反映内容。
 */
function responseHash(response) {
  if (response === undefined) return null;
  return createHash("sha256").update(stableStringify(response)).digest("hex");
}

/** 键序无关的 JSON 序列化（仅用于摘要，不用于线上传输）。 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

/**
 * 线格式派发：委托 `approval-methods.mjs` 的单一真相表。
 *
 * 2026-09-04 起本函数不再自己维护方法→线格式的映射（原为三处手写之一，与
 * codex-app-server.mjs 的 APPROVAL_METHODS 及其 resolver 缺失兜底白名单各自演化，
 * 后者只覆盖 2/5 方法）。语义逐字保留：
 *   · 未登记方法            → UNSUPPORTED_APPROVAL `unsupported approval method: …`
 *   · permissions 被批准    → UNSUPPORTED_APPROVAL `broad permission grants are not supported…`
 *     （下方 resolve() 接住它走策略性拒绝分支立即结算，不让 agent 等到 TTL）
 * 契约测试 `tests/approval-methods.test.mjs` 的 INV5 用真实 broker 往返逐字段交叉验证。
 */
function responseFor(method, approved, approvalId = null) {
  return approvalResponseFor(method, approved, { approvalId });
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
    // 这个定时器**刻意不 unref**（与 #audit 的超时器不同，那个可以）。
    // 2026-09-04 试过 unref 以避免"没走 denyAll 就退出时被挂满 TTL"，实测证明
    // 那是危险的：unref 后若进程只剩一个"在等审批结果"的 promise，事件循环
    // 就认为无事可做，TTL **永不触发** —— fail-closed 的时限保证从
    // "最多 ttlMs" 退化成 "可能永远悬着"。
    // 生产路径靠 denyAll 清理（app-close.test.mjs 锁死关停顺序）；
    // 测试里请显式 denyAll，不要靠改这里来加快退出。
    item.timer = setTimeout(() => void this.expire(id, item), remainingMs);
  }

  async expire(id, item) {
    if (this.pending.get(id) !== item || item.status !== "pending") return;
    item.status = "resolving";
    clearTimeout(item.timer);
    // 与 resolve() 同构：先构造唯一的回灌对象，摘它入账，再原样放行。
    const wireResponse = responseFor(item.method, false);
    try {
      await this.eventStore.emit(
        "approval.expired",
        // actor 三件套与 resolve/deny* 对齐：过期不是"没人决策"，而是系统按策略拒绝。
        {
          id,
          actionSha256: item.actionSha256,
          responseSha256: responseHash(wireResponse),
          decision: "deny",
          actor: "ttl-expiry",
          actorSource: "internal",
          clientActor: null,
        },
        { runId: item.runId, sessionId: item.sessionId, agentId: "codex-technical" },
      );
    } catch {
      // Expiry is fail-closed even when the audit sink is unavailable.
    }
    if (this.pending.get(id) !== item) return;
    this.pending.delete(id);
    this.revision += 1;
    item.resolve(wireResponse);
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
    // 归属置信度（v49）：adapter 把审批请求对应到某轮 run 时用了哪一层匹配。
    // "exact" 是协议保证的精确命中，adapter 不传该字段；其余层（conversation /
    // turn-scan / sole-active）是推断出来的，必须一路带到操作者面前 ——
    // 操作者要在"这条审批属于哪个 run"上做决定，而归属可能是猜的这件事
    // 若只留在事件流里、不进审批卡，等于没告诉他。
    const attribution = typeof context.attribution === "string" ? context.attribution : null;
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
      ...(attribution ? { attribution } : {}),
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
    // responseFor 在这里既是**校验闸门**又是**唯一取值点**（v50）：
    //   · 校验：某些审批类型（宽权限授予）根本不允许被批准，抛错走下方策略性拒绝分支
    //   · 取值：拿到的 wireResponse 就是最终回灌给子进程的那个对象引用，
    //           摘要入账后**原样放行**，不再第二次构造 —— 见 responseHash() 的说明。
    let wireResponse;
    try {
      wireResponse = responseFor(item.method, approved, id);
    } catch (error) {
      // 不可批准的请求不能被"批准"，但也不能让 agent 干等到 TTL 才拿到答复。
      // 走与超时/撤销同一条策略性拒绝路径立即结算，同时把原因抛回给操作者。
      clearTimeout(item.timer);
      item.status = "resolving";
      this.pending.delete(id);
      this.revision += 1;
      // 这条分支恰好是宽权限授予实际走的路径 —— 最需要账本的一条，
      // 所以同样只构造一次：摘要与放行同源。
      const declineResponse = responseFor(item.method, false, id);
      item.resolve(declineResponse);
      this.eventStore.emit(
        "approval.resolved",
        {
          id,
          actionSha256: item.actionSha256,
          responseSha256: responseHash(declineResponse),
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
        {
          id,
          actionSha256: item.actionSha256,
          // 回程摘要与下方 item.resolve() 放行的是同一个对象引用，中间无第二次构造。
          responseSha256: responseHash(wireResponse),
          decision,
          actor: auditActor,
          actorSource: auditSource,
          clientActor: auditClientActor,
        },
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
    // 放行**已被摘要的那个对象**。这里若改回 responseFor(...) 重新构造，
    // 账本与线上就又成了两个可以各自演化的东西 —— v50 修的正是这一点。
    item.resolve(wireResponse);
    return {
      id,
      decision,
      actionSha256: item.actionSha256,
      responseSha256: responseHash(wireResponse),
      runId: item.runId,
      method: item.method,
    };
  }

  async denyAll(reason = "control plane shutdown") {
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      item.status = "resolving";
      // 构造在 emit 之前：拒绝形态构造失败时 responseSha256 记 null，
      // 账本如实反映"这一条没有成功回灌任何东西"，而不是记一个从未上线的摘要。
      let wireResponse;
      let constructError = null;
      try {
        wireResponse = responseFor(item.method, false);
      } catch (error) {
        constructError = error;
      }
      // actionSha256 补齐后，三类终态事件（resolved / denied / expired）形状一致，
      // 下游按字段解析不会再拿到 undefined。
      await this.eventStore.emit(
        "approval.resolved",
        {
          id,
          actionSha256: item.actionSha256,
          responseSha256: constructError ? null : responseHash(wireResponse),
          decision: "deny",
          reason,
          actor: "control-plane",
          actorSource: "internal",
          clientActor: null,
        },
        { runId: item.runId, sessionId: item.sessionId, agentId: "codex-technical" },
      ).catch(() => {});
      if (constructError) item.reject(constructError);
      else item.resolve(wireResponse);
      this.pending.delete(id);
      this.revision += 1;
    }
  }

  async denyRun(runId, reason = "run cancelled") {
    for (const [id, item] of this.pending) {
      if (item.runId !== runId) continue;
      clearTimeout(item.timer);
      item.status = "resolving";
      let wireResponse;
      let constructError = null;
      try {
        wireResponse = responseFor(item.method, false);
      } catch (error) {
        constructError = error;
      }
      await this.eventStore.emit(
        "approval.resolved",
        {
          id,
          actionSha256: item.actionSha256,
          responseSha256: constructError ? null : responseHash(wireResponse),
          decision: "deny",
          reason,
          actor: "control-plane",
          actorSource: "internal",
          clientActor: null,
        },
        { runId, sessionId: item.sessionId, agentId: "control-plane" },
      ).catch(() => {});
      if (constructError) item.reject(constructError);
      else item.resolve(wireResponse);
      this.pending.delete(id);
      this.revision += 1;
    }
  }
}
