/**
 * 审批方法契约测试（v49 · 2026-09-04）。
 *
 * 核心是 **INV5：与真实 broker 交叉验证**——新契约表若与 `approval-broker.mjs`
 * 的 `responseFor()` 线格式有任何不一致，这里直接变红。这条不是可选的：
 * 抽单一真相源的全部价值就在于两处不再各自演化，而"不再各自演化"必须由
 * 机械断言保证，不能靠我记得同步。
 *
 * 交叉验证的做法：用真实 ApprovalBroker 走完整 request→resolve 往返，
 * 拿它实际回灌给 adapter 的对象与契约表的构造器输出逐字段比对。
 * 不 mock responseFor（那样就变成拿我的假设验我的假设了）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ApprovalBroker } from "../src/approval-broker.mjs";
import {
  APPROVAL_METHODS,
  approvalMethodNames,
  approvalMethodSpec,
  approvalResponseFor,
  fallbackDeclineFor,
  inboundApprovalMethodNames,
  isApprovable,
  isApprovalMethod,
  isInboundApprovalMethod,
} from "../src/approval-methods.mjs";

/**
 * ═══ 入站门闸黄金快照（烛评审致命 1 · 2026-09-04）═══
 *
 * 独立手写，依据 `git show HEAD:src/adapters/codex-app-server.mjs` 的原版 5 元 Set。
 * **`control/runBuild/requestApproval` 不在其中** —— 它由控制面自己发起，
 * 被沙箱的 Codex 无权要求提权到 build。首版把它并进入站白名单，烛实测可拿到
 * `{"decision":"accept","approvalId":"ATTACKER-SUPPLIED"}`（原版回 -32601）。
 *
 * 改这份快照 = 改安全边界，必须有明确理由。
 */
const INBOUND_GOLDEN = Object.freeze([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
  "item/permissions/requestApproval",
  // v50 新增：Claude CLI 的工具许可。**有意入站** —— 与 command/fileChange 同类，
  // 都是被沙箱的子进程发起、由操作者裁决的真审批请求。
  // 与 control/runBuild 的区别在方向：那个是控制面自己发起的提权授权，
  // 子进程无权要求；这个是子进程"请允许我执行这个工具"，本就该由它发起。
  // 链路：CLI --permission-prompt-tool → 每轮专属 MCP server → 具名管道 → broker。
  "claude/toolPermission/requestApproval",
]);

/**
 * ═══ 线格式黄金快照（独立于被测表，绝不从 APPROVAL_METHODS 派生）═══
 *
 * 这份常量的存在理由是一次现场翻车：INV5 原本写成
 *   `const expected = approvalMethodSpec(method).approved({})`
 * 而 broker 现在**也**从同一张表取值 —— 两边一起变，**拿表验表恒真**。
 * 2026-09-04 烛（Codex 独立评审）把 `item/commandExecution` 的批准值从
 * `accept` 改成 `approve` 做注入测试，38 项测试**全绿放行**。
 * 那是协议外的值，会让上游 Codex 收到它不认识的 decision。
 *
 * 所以期望值必须独立手写，并以 `git show HEAD:src/approval-broker.mjs`
 * 的原实现 + Codex app-server v2 协议（decision ∈ accept|acceptForSession|
 * decline|cancel）为准。**改这份快照 = 改协议**，必须有上游依据，
 * 不能因为"表改了所以快照跟着改"。
 */
const WIRE_GOLDEN = Object.freeze({
  "control/runBuild/requestApproval": {
    // 原实现签名 `responseFor(method, approved, approvalId = null)` —— 缺参默认 null（非 undefined）
    approved: (id = null) => ({ decision: "accept", approvalId: id }),
    denied: (id = null) => ({ decision: "decline", approvalId: id }),
  },
  "item/commandExecution/requestApproval": {
    approved: () => ({ decision: "accept" }),
    denied: () => ({ decision: "decline" }),
  },
  "item/fileChange/requestApproval": {
    approved: () => ({ decision: "accept" }),
    denied: () => ({ decision: "decline" }),
  },
  execCommandApproval: {
    approved: () => ({ decision: "approved" }),   // legacy v1 线格式，与 v2 有意不同
    denied: () => ({ decision: "denied" }),
  },
  applyPatchApproval: {
    approved: () => ({ decision: "approved" }),
    denied: () => ({ decision: "denied" }),
  },
  "item/permissions/requestApproval": {
    approvedThrows: { code: "UNSUPPORTED_APPROVAL", messagePattern: /broad permission/ },
    denied: () => ({ permissions: {}, scope: "turn" }),
  },
  // v50：Claude 工具许可。线格式与 v2 家族对齐（accept/decline）——
  // 依据不是"表里这么写"，而是这条链路的消费方 `claude-cli.mjs` 只判
  // `decision === "accept"`，且真正下发给 CLI 的 PPT 线格式（behavior:allow/deny）
  // 由 permission-prompt-wire.mjs 独立构造，两层格式刻意不混。
  "claude/toolPermission/requestApproval": {
    approved: () => ({ decision: "accept" }),
    denied: () => ({ decision: "decline" }),
  },
});

/** 最小事件汇：只记录，不落盘。broker 的审计路径需要它 emit 成功。 */
function stubEventStore() {
  const events = [];
  return {
    events,
    async emit(type, data, meta) {
      events.push({ type, data, meta });
      return { type, data };
    },
  };
}

/** 走一次完整 broker 往返，返回它实际回灌给 adapter 的对象。 */
async function brokerRoundTrip(method, decision, params = {}) {
  const eventStore = stubEventStore();
  const broker = new ApprovalBroker({ eventStore, ttlMs: 60_000 });
  const pendingResponse = broker.request({ method, params }, { runId: "run-1", sessionId: "sess-1" });
  // request() 落 approval.pending 后才把条目放进 this.pending，等一个微任务周期
  await new Promise((resolve) => setImmediate(resolve));
  const [item] = broker.list();
  assert.ok(item, `broker 未登记 ${method} 的 pending 条目`);
  await broker.resolve(item.id, { decision, actionSha256: item.actionSha256 });
  return { wire: await pendingResponse, approvalId: item.id, eventStore };
}

test("INV1 每个登记方法都有 denied 构造器；可批准的还有 approved", () => {
  const names = approvalMethodNames();
  assert.ok(names.length >= 6, `登记方法偏少：${names.length}`);
  for (const method of names) {
    const spec = approvalMethodSpec(method);
    assert.equal(typeof spec.denied, "function", `${method} 缺 denied 构造器`);
    const denied = spec.denied({});
    assert.equal(typeof denied, "object", `${method}.denied 未返回对象`);
    assert.notEqual(denied, null);
    assert.equal(typeof spec.kind, "string");
    if (spec.approvable === false) {
      // 不可批准的方法必须声明抛错内容，否则 approvalResponseFor 会崩在解构上
      assert.equal(typeof spec.approvedError?.message, "string", `${method} 缺 approvedError.message`);
      assert.equal(typeof spec.approvedError?.code, "string", `${method} 缺 approvedError.code`);
      assert.equal(spec.approved, undefined, `${method} 不可批准却仍有 approved 构造器`);
    } else {
      assert.equal(typeof spec.approved, "function", `${method} 缺 approved 构造器`);
      const approved = spec.approved({});
      assert.equal(typeof approved, "object", `${method}.approved 未返回对象`);
      assert.notEqual(approved, null);
    }
  }
});

test("INV1b 拒绝形态绝不含批准语义", () => {
  for (const method of approvalMethodNames()) {
    const denied = approvalMethodSpec(method).denied({});
    if ("decision" in denied) {
      assert.ok(
        ["decline", "denied"].includes(denied.decision),
        `${method} 的拒绝 decision 是 '${denied.decision}'，不是拒绝语义`,
      );
    }
    if ("permissions" in denied) {
      assert.deepEqual(denied.permissions, {}, `${method} 拒绝时仍带权限`);
    }
  }
});

test("INV2 permissions 方法不可批准：批准抛 UNSUPPORTED_APPROVAL，拒绝给空集", () => {
  const method = "item/permissions/requestApproval";
  const spec = approvalMethodSpec(method);
  assert.equal(spec.approvable, false, "宽权限授予必须标为不可批准");
  assert.equal(isApprovable(method), false);
  // 拒绝路径：空权限集 + scope 限本轮
  assert.deepEqual(spec.denied({}), { permissions: {}, scope: "turn" });
  assert.deepEqual(approvalResponseFor(method, false), { permissions: {}, scope: "turn" });
  // 批准路径：抛错，且消息逐字保留（approval-capacity.test.mjs:320 断言 /broad permission/）
  assert.throws(
    () => approvalResponseFor(method, true),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_APPROVAL");
      assert.match(error.message, /broad permission/);
      return true;
    },
  );
});

test("INV3 isApprovalMethod 对任意输入不抛，原型链键不误判", () => {
  for (const input of [
    null, undefined, 0, 1, NaN, true, false, "", " ", {}, [], () => {},
    "__proto__", "constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf",
  ]) {
    assert.doesNotThrow(() => isApprovalMethod(input));
    assert.equal(isApprovalMethod(input), false, `${String(input)} 被误判为审批方法`);
  }
  assert.equal(isApprovalMethod("item/commandExecution/requestApproval"), true);
  // 敌意 toString 不被触发（只接受 string）
  assert.doesNotThrow(() => isApprovalMethod({ toString() { throw new Error("boom"); } }));
});

test("INV4 fallbackDecline=true 的方法都能给出可回灌的拒绝对象", () => {
  for (const method of approvalMethodNames()) {
    const spec = approvalMethodSpec(method);
    const fallback = fallbackDeclineFor(method);
    if (spec.fallbackDecline === true) {
      assert.ok(fallback && typeof fallback === "object", `${method} 声明可兜底却给不出对象`);
      assert.deepEqual(fallback, spec.denied({}), `${method} 兜底形态与 denied() 不一致`);
    } else {
      assert.equal(fallback, null, `${method} 未声明可兜底却返回了对象`);
    }
  }
  // 未登记方法一律不可兜底
  assert.equal(fallbackDeclineFor("totally/unknown"), null);
  assert.equal(fallbackDeclineFor(null), null);
  assert.equal(fallbackDeclineFor("__proto__"), null);
});

// ═══ INV5：与真实 broker 交叉验证（本文件存在的核心理由）═══

test("INV5 批准线格式与黄金快照逐字段一致（真实 broker 往返）", async () => {
  for (const method of [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "execCommandApproval",
    "applyPatchApproval",
  ]) {
    const { wire } = await brokerRoundTrip(method, "approve");
    assert.deepEqual(wire, WIRE_GOLDEN[method].approved(), `${method} 批准线格式偏离协议`);
  }
});

test("INV5 拒绝线格式与黄金快照逐字段一致（真实 broker 往返）", async () => {
  for (const method of [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "execCommandApproval",
    "applyPatchApproval",
  ]) {
    const { wire } = await brokerRoundTrip(method, "deny");
    assert.deepEqual(wire, WIRE_GOLDEN[method].denied(), `${method} 拒绝线格式偏离协议`);
  }
});

test("INV5 run-build 的 approvalId 回灌符合黄金快照", async () => {
  const { wire, approvalId } = await brokerRoundTrip("control/runBuild/requestApproval", "approve");
  assert.deepEqual(wire, WIRE_GOLDEN["control/runBuild/requestApproval"].approved(approvalId));
  assert.equal(wire.approvalId, approvalId, "broker 应回灌自己的审批 id");
});

test("INV5b 登记表本身与黄金快照一致（不经 broker，直接比对表）", () => {
  // 这条与上面三条互补：上面走 broker 往返（端到端），这条直接比对表（定位更快）。
  // 两者都以 WIRE_GOLDEN 为准 —— 绝不以 APPROVAL_METHODS 自身为准。
  for (const method of approvalMethodNames()) {
    const golden = WIRE_GOLDEN[method];
    assert.ok(golden, `${method} 未登记黄金快照 —— 新增审批方法必须同时写协议依据`);
    const spec = approvalMethodSpec(method);
    assert.deepEqual(spec.denied({}), golden.denied(), `${method} 拒绝形态偏离协议`);
    if (golden.approvedThrows) {
      assert.equal(spec.approvable, false, `${method} 应标为不可批准`);
      assert.equal(spec.approvedError.code, golden.approvedThrows.code);
      assert.match(spec.approvedError.message, golden.approvedThrows.messagePattern);
    } else {
      assert.deepEqual(spec.approved({}), golden.approved(), `${method} 批准形态偏离协议`);
    }
  }
  // 反向：快照里不能有表里没有的方法（防快照留下已下线方法）
  for (const method of Object.keys(WIRE_GOLDEN)) {
    assert.ok(approvalMethodNames().includes(method), `黄金快照残留已下线方法 ${method}`);
  }
});

test("INV5 permissions 的批准在真实 broker 上抛错并按策略拒绝结算", async () => {
  const eventStore = stubEventStore();
  const broker = new ApprovalBroker({ eventStore, ttlMs: 60_000 });
  const pendingResponse = broker.request(
    { method: "item/permissions/requestApproval", params: { permissions: {} } },
    { runId: "run-1", sessionId: "sess-1" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const [item] = broker.list();
  await assert.rejects(
    () => broker.resolve(item.id, { decision: "approve", actionSha256: item.actionSha256 }),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_APPROVAL");
      assert.match(error.message, /broad permission/);
      return true;
    },
  );
  // 立即结算为策略性拒绝，不让 agent 等到 TTL
  assert.equal(broker.pending.size, 0);
  assert.deepEqual(await pendingResponse, approvalMethodSpec("item/permissions/requestApproval").denied({}));
  const resolved = eventStore.events.find((event) => event.type === "approval.resolved");
  assert.equal(resolved?.data?.decision, "deny");
  assert.equal(resolved?.data?.actorSource, "policy");
});

test("INV5 permissions 的拒绝回灌与 broker 一致（空集）", async () => {
  const { wire } = await brokerRoundTrip("item/permissions/requestApproval", "deny", { permissions: { write: true } });
  assert.deepEqual(wire, { permissions: {}, scope: "turn" });
});

test("INV5 契约表覆盖 broker 支持的全部方法（无遗漏、无多余）", async () => {
  // broker.request() 开头会调 responseFor(method, false) 做入口校验：
  // 未支持的方法在那里就抛 UNSUPPORTED_APPROVAL。用它反推 broker 的真实支持集。
  const eventStore = stubEventStore();
  const broker = new ApprovalBroker({ eventStore, ttlMs: 1_000 });
  const supported = [];
  for (const method of approvalMethodNames()) {
    try {
      const promise = broker.request({ method, params: {} }, {});
      promise.catch(() => {});           // TTL 到点会 resolve，避免未处理拒绝
      supported.push(method);
      await new Promise((resolve) => setImmediate(resolve));
      const [item] = broker.list();
      if (item) await broker.resolve(item.id, { decision: "deny", actionSha256: item.actionSha256 });
    } catch (error) {
      assert.fail(`契约表登记了 broker 不支持的方法 ${method}：${error.message}`);
    }
  }
  assert.equal(supported.length, approvalMethodNames().length);

  // 反向：broker 拒绝未登记方法
  await assert.rejects(
    () => broker.request({ method: "not/an/approval", params: {} }, {}),
    (error) => error.code === "UNSUPPORTED_APPROVAL",
  );
});

// ═══ buggy-must-turn-red 元验收 ═══

test("元验收：adapter 旧兜底白名单只覆盖 2/6 方法（证明不对称真实存在）", () => {
  // codex-app-server.mjs:820 的原实现白名单
  const LEGACY_FALLBACK = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
  ];
  const canFallbackNow = approvalMethodNames().filter((m) => fallbackDeclineFor(m) !== null);
  assert.ok(
    canFallbackNow.length > LEGACY_FALLBACK.length,
    `新契约应扩大可兜底集合，实测 ${canFallbackNow.length} vs 旧 ${LEGACY_FALLBACK.length}`,
  );
  // 具体点名旧实现漏掉、且确实能安全兜底的那几个
  for (const method of ["execCommandApproval", "applyPatchApproval", "item/permissions/requestApproval"]) {
    assert.ok(!LEGACY_FALLBACK.includes(method), `前提校验：${method} 本不在旧白名单`);
    assert.ok(fallbackDeclineFor(method) !== null, `${method} 新契约应可兜底拒绝`);
  }
});

test("APPROVAL_METHODS 表被冻结（防运行时被改）", () => {
  assert.equal(Object.isFrozen(APPROVAL_METHODS), true);
});

// ═══ 烛评审致命 1：入站门闸方向性 ═══

test("入站白名单与黄金快照一致，且不含 control/runBuild（方向性约束）", () => {
  assert.deepEqual([...inboundApprovalMethodNames()].sort(), [...INBOUND_GOLDEN].sort());
  assert.equal(
    inboundApprovalMethodNames().includes("control/runBuild/requestApproval"),
    false,
    "runBuild 由控制面自己发起，被沙箱的 CLI 不得伪造 —— 放行即操作者欺骗",
  );
  // 入站集必须是全集的真子集：全集含控制面自发起的方法
  assert.ok(
    inboundApprovalMethodNames().length < approvalMethodNames().length,
    "入站集与全集相等说明方向维度丢失了",
  );
});

test("isInboundApprovalMethod fail-closed：未登记 / inbound 非 true 一律 false", () => {
  for (const method of INBOUND_GOLDEN) {
    assert.equal(isInboundApprovalMethod(method), true, `${method} 应可入站`);
  }
  for (const method of [
    "control/runBuild/requestApproval",   // 已登记但仅出站
    "not/registered", "", null, undefined, 0, {}, [],
    "__proto__", "constructor", "toString",
  ]) {
    assert.equal(isInboundApprovalMethod(method), false, `${String(method)} 不应可入站`);
  }
});

test("每个登记方法都显式声明 inbound（不许靠默认值）", () => {
  for (const method of approvalMethodNames()) {
    const spec = approvalMethodSpec(method);
    assert.equal(
      typeof spec.inbound, "boolean",
      `${method} 未显式声明 inbound —— 新增方法必须先想清楚方向`,
    );
  }
});

test("adapter 用的是入站集而非全集（源码级断言）", () => {
  const source = readFileSync("src/adapters/codex-app-server.mjs", "utf8");
  assert.match(
    source,
    /new Set\(inboundApprovalMethodNames\(\)\)/,
    "adapter 的 APPROVAL_METHODS 必须由 inboundApprovalMethodNames() 构造",
  );
  assert.equal(
    /new Set\(approvalMethodNames\(\)\)/.test(source),
    false,
    "adapter 误用了全集 —— 会放行 CLI 伪造 runBuild 授权",
  );
});

// ═══ 烛评审致命 2：冻结深度 ═══

test("表逐层深冻：运行时无法翻掉 approvable 等安全字段", () => {
  const spec = APPROVAL_METHODS["item/permissions/requestApproval"];
  assert.equal(Object.isFrozen(spec), true, "内层 spec 未冻结");
  assert.equal(Object.isFrozen(spec.approvedError), true, "嵌套对象未冻结");
  assert.equal(Object.isFrozen(spec.denied), true, "构造函数未冻结");

  // 非严格模式下静默失败、严格模式抛错 —— 两种都可接受，关键是值不变
  try { spec.approvable = true; } catch { /* 严格模式抛错，符合预期 */ }
  assert.equal(spec.approvable, false, "approvable 被篡改 —— 宽权限授予的闸门失守");

  try { spec.inbound = false; } catch { /* 同上 */ }
  assert.equal(spec.inbound, true, "inbound 被篡改");

  // 新增字段也要挡住
  try { spec.injected = "x"; } catch { /* 同上 */ }
  assert.equal(Object.hasOwn(spec, "injected"), false, "可注入新字段");

  // 全部方法逐一验
  for (const method of approvalMethodNames()) {
    assert.equal(Object.isFrozen(APPROVAL_METHODS[method]), true, `${method} 的 spec 未冻结`);
  }
});

test("legacy 方法带 legacy 标记，便于将来下线时定位", () => {
  assert.equal(approvalMethodSpec("execCommandApproval").legacy, true);
  assert.equal(approvalMethodSpec("applyPatchApproval").legacy, true);
  assert.equal(approvalMethodSpec("item/commandExecution/requestApproval").legacy, undefined);
});

test("isApprovable 区分可批准与只能拒绝的方法", () => {
  for (const method of approvalMethodNames()) {
    const expected = approvalMethodSpec(method).approvable !== false;
    assert.equal(isApprovable(method), expected, `${method} 的可批准判定不符`);
  }
  // 当前唯一的"只能拒绝"方法
  assert.equal(isApprovable("item/permissions/requestApproval"), false);
  assert.equal(isApprovable("item/commandExecution/requestApproval"), true);
  assert.equal(isApprovable("not/registered"), false);
  assert.equal(isApprovable(null), false);
  assert.equal(isApprovable("__proto__"), false);
});

test("approvalResponseFor 对未登记方法抛 UNSUPPORTED_APPROVAL", () => {
  for (const method of ["not/registered", "", null, undefined, "__proto__", "constructor"]) {
    assert.throws(
      () => approvalResponseFor(method, false),
      (error) => error.code === "UNSUPPORTED_APPROVAL",
      `${String(method)} 未被拒绝`,
    );
  }
});
