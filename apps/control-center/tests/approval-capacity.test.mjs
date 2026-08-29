import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalBroker, DEFAULT_MAX_PENDING, DEFAULT_MAX_PENDING_PER_RUN, DEFAULT_AUDIT_TIMEOUT_MS } from "../src/approval-broker.mjs";

/**
 * F-047 审批面收敛测试。
 *
 * 覆盖四块新增能力：
 *   1. 容量闸（全局 / 单 run 两种超限 → 拒绝受理而非淘汰或自动批准）
 *   2. 审计写入超时兜底（emit 挂起 → fail-closed 恢复 pending）
 *   3. actor 三件套（actor / actorSource / clientActor 入账与截断）
 *   4. 宽权限授予 approve 立即拒绝结算（responseFor 校验闸门）
 */

// ─── 辅助 ────────────────────────────────────────────────────────────────────

/** 记录所有 emit 事件的假 eventStore。flags 是可变对象，测试中途可改。 */
function recordingStore(flags = {}) {
  const events = [];
  const store = {
    events,
    flags,
    async emit(type, data, meta) {
      events.push({ type, data, meta });
      if (type === "approval.resolved" && flags.slowResolvedMs) {
        await new Promise((r) => setTimeout(r, flags.slowResolvedMs));
      }
      if (type === "approval.resolved" && flags.failOnResolved) {
        throw new Error("audit disk full");
      }
    },
  };
  return store;
}

function tick() {
  return new Promise((r) => setImmediate(r));
}

const FILE_CHANGE = { method: "item/fileChange/requestApproval", params: { path: "src/a.mjs" } };
const PERMISSIONS = { method: "item/permissions/requestApproval", params: { permissions: {} } };

// ─── 1. 容量闸 ──────────────────────────────────────────────────────────────

test("capacity gate: global limit refuses new requests with APPROVAL_CAPACITY", async () => {
  const store = recordingStore();
  const broker = new ApprovalBroker({ eventStore: store, ttlMs: 60_000, maxPending: 2, maxPendingPerRun: 100 });

  // 填满 2 个 pending
  const p1 = broker.request(FILE_CHANGE, { runId: "r1" });
  const p2 = broker.request(FILE_CHANGE, { runId: "r2" });
  await tick();
  assert.equal(broker.pending.size, 2);

  // 第 3 个必须被拒绝
  await assert.rejects(
    () => broker.request(FILE_CHANGE, { runId: "r3" }),
    (err) => {
      assert.equal(err.code, "APPROVAL_CAPACITY");
      assert.equal(err.scope, "global");
      assert.equal(err.limit, 2);
      assert.match(err.message, /backlog is full/);
      return true;
    },
  );

  // 拒绝本身要留痕审计
  assert.ok(store.events.some((e) => e.type === "approval.capacity_rejected"));
  // pending 数没有增加
  assert.equal(broker.pending.size, 2);

  // 清理
  await broker.denyAll("test cleanup");
  await Promise.allSettled([p1, p2]);
});

test("capacity gate: per-run limit refuses when a single run exceeds its quota", async () => {
  const store = recordingStore();
  const broker = new ApprovalBroker({ eventStore: store, ttlMs: 60_000, maxPending: 100, maxPendingPerRun: 2 });

  const p1 = broker.request(FILE_CHANGE, { runId: "run-a" });
  const p2 = broker.request(FILE_CHANGE, { runId: "run-a" });
  await tick();
  assert.equal(broker.pending.size, 2);

  // 同一个 run 的第 3 个 → 拒绝
  await assert.rejects(
    () => broker.request(FILE_CHANGE, { runId: "run-a" }),
    (err) => {
      assert.equal(err.code, "APPROVAL_CAPACITY");
      assert.equal(err.scope, "run");
      assert.equal(err.limit, 2);
      assert.match(err.message, /run-a/);
      return true;
    },
  );

  // 不同 run 不受影响
  const p3 = broker.request(FILE_CHANGE, { runId: "run-b" });
  await tick();
  assert.equal(broker.pending.size, 3);

  await broker.denyAll("test cleanup");
  await Promise.allSettled([p1, p2, p3]);
});

test("capacity gate: invalid limits fall back to defaults", () => {
  const broker = new ApprovalBroker({ eventStore: recordingStore(), maxPending: 0, maxPendingPerRun: -1 });
  assert.equal(broker.maxPending, DEFAULT_MAX_PENDING);
  assert.equal(broker.maxPendingPerRun, DEFAULT_MAX_PENDING_PER_RUN);

  const broker2 = new ApprovalBroker({ eventStore: recordingStore(), maxPending: NaN, maxPendingPerRun: Infinity });
  assert.equal(broker2.maxPending, DEFAULT_MAX_PENDING);
  assert.equal(broker2.maxPendingPerRun, DEFAULT_MAX_PENDING_PER_RUN);
});

test("capacity gate: snapshot exposes current capacity utilization", async () => {
  const broker = new ApprovalBroker({ eventStore: recordingStore(), ttlMs: 60_000, maxPending: 10, maxPendingPerRun: 5 });
  const p1 = broker.request(FILE_CHANGE, { runId: "r1" });
  await tick();
  const snap = broker.snapshot();
  assert.deepEqual(snap.capacity, { pending: 1, maxPending: 10, maxPendingPerRun: 5 });
  await broker.denyAll("cleanup");
  await p1;
});

// ─── 2. 审计超时兜底 ─────────────────────────────────────────────────────────

test("audit timeout: slow emit causes fail-closed recovery to pending", async () => {
  // emit 延迟 500ms，但审计超时 50ms 先触发 → fail-closed
  const flags = { slowResolvedMs: 500 };
  const store = recordingStore(flags);
  const broker = new ApprovalBroker({ eventStore: store, ttlMs: 60_000, auditTimeoutMs: 50 });

  const responsePromise = broker.request(FILE_CHANGE, { runId: "r1" });
  await tick();
  const [pending] = broker.list();
  assert.equal(pending.status, "pending");

  // resolve 应该因为审计超时而失败
  await assert.rejects(
    () => broker.resolve(pending.id, { decision: "approve", actionSha256: pending.actionSha256 }),
    (err) => {
      assert.equal(err.code, "APPROVAL_AUDIT_FAILED");
      return true;
    },
  );

  // 关键：审批必须恢复到 pending 状态（不是卡死在 resolving）
  const after = broker.list()[0];
  assert.ok(after, "审批条目应仍在 pending 列表中");
  assert.equal(after.status, "pending");

  // 关闭延迟后用 denyAll 清理
  flags.slowResolvedMs = 0;
  await broker.denyAll("cleanup");
  await responsePromise;
});

test("audit timeout: failing emit also triggers fail-closed recovery", async () => {
  const flags = { failOnResolved: true };
  const store = recordingStore(flags);
  const broker = new ApprovalBroker({ eventStore: store, ttlMs: 60_000 });

  const responsePromise = broker.request(FILE_CHANGE, { runId: "r1" });
  await tick();
  const [pending] = broker.list();

  await assert.rejects(
    () => broker.resolve(pending.id, { decision: "approve", actionSha256: pending.actionSha256 }),
    { code: "APPROVAL_AUDIT_FAILED" },
  );

  // 恢复到 pending，可以重新尝试
  assert.equal(broker.list()[0].status, "pending");

  // 修好 store 后应该能正常 resolve
  flags.failOnResolved = false;
  store.events.length = 0;
  const result = await broker.resolve(pending.id, { decision: "approve", actionSha256: pending.actionSha256 });
  assert.equal(result.decision, "approve");
  assert.deepEqual(await responsePromise, { decision: "accept" });
});

// ─── 3. actor 三件套 ─────────────────────────────────────────────────────────

test("actor triplet: resolve records actor/actorSource/clientActor in audit", async () => {
  const store = recordingStore();
  const broker = new ApprovalBroker({ eventStore: store, ttlMs: 60_000 });

  const responsePromise = broker.request(FILE_CHANGE, { runId: "r1" });
  await tick();
  const [pending] = broker.list();

  await broker.resolve(pending.id, {
    decision: "approve",
    actionSha256: pending.actionSha256,
    actor: "local-operator",
    actorSource: "local-bearer",
    clientActor: "LO",
  });

  const resolved = store.events.find((e) => e.type === "approval.resolved");
  assert.ok(resolved, "应有 approval.resolved 审计事件");
  assert.equal(resolved.data.actor, "local-operator");
  assert.equal(resolved.data.actorSource, "local-bearer");
  assert.equal(resolved.data.clientActor, "LO");
  assert.ok(resolved.data.actionSha256, "终态事件必须含 actionSha256");

  await responsePromise;
});

test("actor triplet: defaults are operator / self-asserted / null", async () => {
  const store = recordingStore();
  const broker = new ApprovalBroker({ eventStore: store, ttlMs: 60_000 });

  const responsePromise = broker.request(FILE_CHANGE);
  await tick();
  const [pending] = broker.list();

  // 不传 actor 相关参数
  await broker.resolve(pending.id, { decision: "approve", actionSha256: pending.actionSha256 });

  const resolved = store.events.find((e) => e.type === "approval.resolved");
  assert.equal(resolved.data.actor, "operator");
  assert.equal(resolved.data.actorSource, "self-asserted");
  assert.equal(resolved.data.clientActor, null);

  await responsePromise;
});

test("actor triplet: values are truncated to prevent write amplification", async () => {
  const store = recordingStore();
  const broker = new ApprovalBroker({ eventStore: store, ttlMs: 60_000 });

  const responsePromise = broker.request(FILE_CHANGE);
  await tick();
  const [pending] = broker.list();

  const longActor = "x".repeat(200);
  const longSource = "y".repeat(200);
  const longClient = "z".repeat(200);

  await broker.resolve(pending.id, {
    decision: "approve",
    actionSha256: pending.actionSha256,
    actor: longActor,
    actorSource: longSource,
    clientActor: longClient,
  });

  const resolved = store.events.find((e) => e.type === "approval.resolved");
  // actor 和 actorSource 截断到 64
  assert.equal(resolved.data.actor.length, 64);
  assert.equal(resolved.data.actorSource.length, 64);
  // clientActor 截断到 128
  assert.equal(resolved.data.clientActor.length, 128);

  await responsePromise;
});

test("actor triplet: denyAll/denyRun/expire events include actionSha256 and actor triplet", async () => {
  const store = recordingStore();
  const broker = new ApprovalBroker({ eventStore: store, ttlMs: 60_000 });

  const p1 = broker.request(FILE_CHANGE, { runId: "run-x" });
  const p2 = broker.request(FILE_CHANGE, { runId: "run-y" });
  await tick();

  // denyRun 只拒绝 run-x 的
  await broker.denyRun("run-x", "test");
  const denyRunEvent = store.events.find((e) => e.type === "approval.resolved" && e.data.actor === "control-plane");
  assert.ok(denyRunEvent);
  assert.ok(denyRunEvent.data.actionSha256, "denyRun 事件必须含 actionSha256");
  assert.equal(denyRunEvent.data.actorSource, "internal");

  // denyAll 清掉剩余的
  await broker.denyAll("shutdown");
  const denyAllEvents = store.events.filter((e) => e.type === "approval.resolved" && e.data.reason === "shutdown");
  assert.ok(denyAllEvents.length >= 1);
  for (const evt of denyAllEvents) {
    assert.ok(evt.data.actionSha256, "denyAll 事件必须含 actionSha256");
    assert.equal(evt.data.actor, "control-plane");
    assert.equal(evt.data.actorSource, "internal");
  }

  await Promise.allSettled([p1, p2]);
});

// ─── 4. 宽权限授予 approve 立即拒绝结算 ──────────────────────────────────────

test("broad permission approve is immediately denied and settled", async () => {
  const store = recordingStore();
  const broker = new ApprovalBroker({ eventStore: store, ttlMs: 60_000 });

  const responsePromise = broker.request(PERMISSIONS, { runId: "r1" });
  await tick();
  const [pending] = broker.list();
  assert.equal(pending.status, "pending");

  // 尝试 approve 宽权限 → 抛错 + 立即按策略拒绝结算
  await assert.rejects(
    () => broker.resolve(pending.id, { decision: "approve", actionSha256: pending.actionSha256 }),
    { code: "UNSUPPORTED_APPROVAL" },
  );

  // 审批已被结算（从 pending 中移除）
  assert.equal(broker.pending.size, 0);

  // 调用方拿到的是策略性拒绝（空权限），不是干等到 TTL
  const response = await responsePromise;
  assert.deepEqual(response, { permissions: {}, scope: "turn" });

  // 审计事件记录为 deny，且原因可追溯
  const resolved = store.events.find((e) => e.type === "approval.resolved");
  assert.ok(resolved, "必须有审计事件");
  assert.equal(resolved.data.decision, "deny");
  assert.equal(resolved.data.actor, "control-plane");
  assert.equal(resolved.data.actorSource, "policy");
  assert.match(resolved.data.reason, /broad permission/);
});

test("broad permission deny is allowed normally", async () => {
  const store = recordingStore();
  const broker = new ApprovalBroker({ eventStore: store, ttlMs: 60_000 });

  const responsePromise = broker.request(PERMISSIONS);
  await tick();
  const [pending] = broker.list();

  // deny 宽权限是正常的
  await broker.resolve(pending.id, { decision: "deny", actionSha256: pending.actionSha256 });
  const response = await responsePromise;
  assert.deepEqual(response, { permissions: {}, scope: "turn" });
});

// ─── 5. 补充边界 ─────────────────────────────────────────────────────────────

test("hash mismatch is rejected even under capacity pressure", async () => {
  const broker = new ApprovalBroker({ eventStore: recordingStore(), ttlMs: 60_000 });
  const responsePromise = broker.request(FILE_CHANGE);
  await tick();
  const [pending] = broker.list();

  await assert.rejects(
    () => broker.resolve(pending.id, { decision: "approve", actionSha256: "wrong-hash" }),
    { code: "APPROVAL_HASH_MISMATCH" },
  );

  // pending 没有被消费
  assert.equal(broker.pending.size, 1);
  assert.equal(broker.list()[0].status, "pending");

  await broker.denyAll("cleanup");
  await responsePromise;
});

test("resolving an already-resolving approval recovers to pending after audit timeout", async () => {
  const flags = { slowResolvedMs: 500 };
  const broker = new ApprovalBroker({ eventStore: recordingStore(flags), ttlMs: 60_000, auditTimeoutMs: 50 });

  const responsePromise = broker.request(FILE_CHANGE);
  await tick();
  const [pending] = broker.list();

  // 第一次 resolve 会因审计超时而失败
  await assert.rejects(
    () => broker.resolve(pending.id, { decision: "approve", actionSha256: pending.actionSha256 }),
    { code: "APPROVAL_AUDIT_FAILED" },
  );

  // 条目恢复到 pending，可以重试
  assert.equal(broker.list()[0].status, "pending");

  flags.slowResolvedMs = 0;
  await broker.denyAll("cleanup");
  await responsePromise;
});

test("DEFAULT exports match documented values", () => {
  assert.equal(DEFAULT_MAX_PENDING, 128);
  assert.equal(DEFAULT_MAX_PENDING_PER_RUN, 32);
  assert.equal(DEFAULT_AUDIT_TIMEOUT_MS, 5_000);
});
