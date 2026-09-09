/**
 * 回程摘要入哈希链（v50 · 2026-09-04）。
 *
 * ── 修的是什么 ──
 * `actionSha256` 只摘**入站** `{method, params}`。终态事件记的 `decision: "approve"|"deny"`
 * 是操作者**意图的抽象**；子进程真正收到的是 `responseFor()` 造出的线上对象
 * （v2 家族 `{decision:"accept",approvalId}` / legacy `{decision:"approved"}` /
 * 宽权限拒绝 `{permissions:{},scope:"turn"}`）。二者从 `decision` 各自独立派生，
 * 从不交叉核对 —— **账本记意图、线上走实体**。
 *
 * 这不是假想缺陷。`approval-methods.mjs` 头部记录的烛实测就是这条缝的一次命中：
 * 浅冻结下 `spec.approvable = true` 即可让宽权限授予回灌 `{write:true,network:true}`
 * 而账本仍记 `decision:"deny"`。deepFreeze 补掉了那一个入口，但"账本与线上可以
 * 不一致且无人发现"这个**形状**还在。
 *
 * ── 为什么不测"校验一致" ──
 * 事后校验没有意义：校验代码与被校验代码同源，一起被改就一起失效。
 * v50 的治法是结构性的 —— 让实体**只构造一次**，摘它入账、放行同一个引用。
 * 所以本文件的断言重心是：
 *   ① 摘要确实是**线上那个对象**的摘要（拿 broker 实际回灌的 wire 独立重算比对）
 *   ② 五条终态路径**全部**有摘要（resolve / 策略性拒绝 / expire / denyAll / denyRun）
 *   ③ 摘要与放行同源（元验收：篡改任一侧，断言必须变红）
 *
 * 期望值全部来自**独立重算**（`crypto` 直接摘 broker 回灌的对象），
 * 不读 broker 内部的 responseHash —— 拿表验表是恒真基线。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalBroker } from "../src/approval-broker.mjs";
import { EventStore } from "../src/event-store.mjs";
import { approvalMethodNames, approvalMethodSpec } from "../src/approval-methods.mjs";

const brokerSource = readFileSync("src/approval-broker.mjs", "utf8");

/**
 * 独立实现的键序无关摘要 —— 与 broker 内部实现**刻意分开写**。
 * 若两边算法漂移，本文件的比对断言会变红，这正是我们想要的信号。
 */
function independentHash(value) {
  const canonical = (input) => {
    if (input === null || typeof input !== "object") return JSON.stringify(input) ?? "null";
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    return `{${Object.keys(input).sort().map((k) => `${JSON.stringify(k)}:${canonical(input[k])}`).join(",")}}`;
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

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

/**
 * 起过的 broker 全部登记在这里，测试收尾统一 denyAll。
 *
 * 为什么必需：TTL 定时器**刻意不 unref**（见 broker.scheduleExpiry 的说明——
 * unref 会让"等审批结果"的 promise 永不超时，削弱 fail-closed）。所以任何
 * 未结算的 pending 都会 ref 着事件循环，把整个测试文件挂满 ttlMs。
 * 首版没清，19 项测试实际只跑 40ms，进程却挂了 60 秒。
 */
const openedBrokers = new Set();

test.afterEach(async () => {
  for (const broker of openedBrokers) await broker.denyAll("test teardown").catch(() => {});
  openedBrokers.clear();
});

/** 起一条 pending，返回 broker / 条目 / 未结算的回灌承诺。 */
async function openPending(method, params = {}, brokerOptions = {}) {
  const eventStore = stubEventStore();
  const broker = new ApprovalBroker({ eventStore, ttlMs: 60_000, ...brokerOptions });
  openedBrokers.add(broker);
  const wirePromise = broker.request({ method, params }, { runId: "run-1", sessionId: "sess-1" });
  await new Promise((resolve) => setImmediate(resolve));
  const [item] = broker.list();
  assert.ok(item, `broker 未登记 ${method} 的 pending 条目`);
  return { broker, eventStore, item, wirePromise };
}

/** 直接 new broker 的测试用这个，确保也进 teardown。 */
function newBroker(options = {}) {
  const eventStore = stubEventStore();
  const broker = new ApprovalBroker({ eventStore, ttlMs: 60_000, ...options });
  openedBrokers.add(broker);
  return { broker, eventStore };
}

function terminalEvent(eventStore) {
  const found = eventStore.events.filter((e) => e.type === "approval.resolved" || e.type === "approval.expired");
  assert.equal(found.length, 1, `终态事件应恰好一条，实得 ${found.length}`);
  return found[0];
}

// ═══ ① 摘要必须是线上那个对象的摘要 ═══

test("批准：账本里的 responseSha256 == 子进程实收对象的独立重算摘要", async () => {
  const { broker, eventStore, item, wirePromise } = await openPending("item/commandExecution/requestApproval", { command: "ls" });
  await broker.resolve(item.id, { decision: "approve", actionSha256: item.actionSha256 });
  const wire = await wirePromise;

  // 前提：这确实是 accept 形态，不是拒绝路径混进来的
  assert.deepEqual(wire, { decision: "accept" });
  const event = terminalEvent(eventStore);
  assert.equal(
    event.data.responseSha256,
    independentHash(wire),
    "账本摘要与子进程实收对象不符 —— 账本记的不是线上发生的事",
  );
});

test("拒绝：摘要同样覆盖 decline 形态（拒绝也是一次需要留证的回灌）", async () => {
  const { broker, eventStore, item, wirePromise } = await openPending("item/fileChange/requestApproval", { path: "/tmp/x" });
  await broker.resolve(item.id, { decision: "deny", actionSha256: item.actionSha256 });
  const wire = await wirePromise;

  assert.deepEqual(wire, { decision: "decline" });
  assert.equal(terminalEvent(eventStore).data.responseSha256, independentHash(wire));
});

test("legacy 线格式（approved/denied）的摘要与 v2 家族不同 —— 摘的是实体不是意图", async () => {
  const v2 = await openPending("item/commandExecution/requestApproval", { command: "ls" });
  await v2.broker.resolve(v2.item.id, { decision: "approve", actionSha256: v2.item.actionSha256 });
  const v2Wire = await v2.wirePromise;

  const legacy = await openPending("execCommandApproval", { command: "ls" });
  await legacy.broker.resolve(legacy.item.id, { decision: "approve", actionSha256: legacy.item.actionSha256 });
  const legacyWire = await legacy.wirePromise;

  // 两者 decision 字段值不同（accept vs approved），摘要必须因此不同。
  // 若摘要只反映"批准/拒绝"这个意图，两条会摘出同一个值 —— 那就等于没摘实体。
  assert.notDeepEqual(v2Wire, legacyWire);
  assert.notEqual(
    terminalEvent(v2.eventStore).data.responseSha256,
    terminalEvent(legacy.eventStore).data.responseSha256,
    "两种线格式摘出同一个值：摘要摘的是意图而非实体",
  );
});

test("run-build 的 approvalId 进摘要（同一决定、不同 id 应摘出不同值）", async () => {
  const first = await openPending("control/runBuild/requestApproval", {});
  await first.broker.resolve(first.item.id, { decision: "approve", actionSha256: first.item.actionSha256 });
  const firstWire = await first.wirePromise;

  const second = await openPending("control/runBuild/requestApproval", {});
  await second.broker.resolve(second.item.id, { decision: "approve", actionSha256: second.item.actionSha256 });
  const secondWire = await second.wirePromise;

  assert.equal(firstWire.decision, "accept");
  assert.equal(firstWire.approvalId, first.item.id);
  assert.notEqual(firstWire.approvalId, secondWire.approvalId, "前提：两轮 approvalId 应不同");
  assert.notEqual(
    terminalEvent(first.eventStore).data.responseSha256,
    terminalEvent(second.eventStore).data.responseSha256,
    "approvalId 不进摘要 —— 租约凭证的差异在账本上不可见",
  );
});

test("resolve() 返回值也带 responseSha256（HTTP 层可直接回给操作者对账）", async () => {
  const { broker, item, wirePromise } = await openPending("item/commandExecution/requestApproval", { command: "ls" });
  const result = await broker.resolve(item.id, { decision: "approve", actionSha256: item.actionSha256 });
  const wire = await wirePromise;
  assert.equal(result.responseSha256, independentHash(wire));
});

// ═══ ② 五条终态路径全覆盖 ═══

test("策略性拒绝（宽权限授予批准）也留回程摘要 —— 最需要账本的一条", async () => {
  const { broker, eventStore, item, wirePromise } = await openPending("item/permissions/requestApproval", {
    permissions: { write: true, network: true },
  });
  await assert.rejects(
    () => broker.resolve(item.id, { decision: "approve", actionSha256: item.actionSha256 }),
    /broad permission/,
  );
  const wire = await wirePromise;

  // 实际回灌的是空权限集，不是请求里那个 {write,network}
  assert.deepEqual(wire, { permissions: {}, scope: "turn" });
  const event = terminalEvent(eventStore);
  assert.equal(event.data.decision, "deny");
  assert.equal(
    event.data.responseSha256,
    independentHash(wire),
    "策略性拒绝分支无回程摘要：这条路径恰好是宽权限授予实际走的，最需要留证",
  );
});

test("TTL 过期：approval.expired 带回程摘要", async () => {
  const { eventStore, item, wirePromise, broker } = await openPending(
    "item/commandExecution/requestApproval",
    { command: "ls" },
    { ttlMs: 10 },
  );
  const wire = await wirePromise; // 等 TTL 自然触发 expire
  assert.deepEqual(wire, { decision: "decline" });
  const event = terminalEvent(eventStore);
  assert.equal(event.type, "approval.expired");
  assert.equal(event.data.responseSha256, independentHash(wire));
  assert.equal(broker.list().length, 0);
});

test("denyAll（控制面关停）：每条 pending 都留回程摘要", async () => {
  const { broker, eventStore } = newBroker();
  const first = broker.request({ method: "item/commandExecution/requestApproval", params: { command: "a" } }, { runId: "r1" });
  const second = broker.request({ method: "execCommandApproval", params: { command: "b" } }, { runId: "r2" });
  await new Promise((resolve) => setImmediate(resolve));

  await broker.denyAll("shutdown");
  const wires = [await first, await second];
  const events = eventStore.events.filter((e) => e.type === "approval.resolved");
  assert.equal(events.length, 2);
  // 逐条比对，且两条摘要因线格式不同而不同
  const byId = new Map(events.map((e) => [e.data.id, e.data]));
  assert.equal(byId.size, 2);
  const hashes = [...byId.values()].map((d) => d.responseSha256);
  assert.equal(new Set(hashes).size, 2, "两条不同线格式却摘出同一个值");
  for (const hash of hashes) {
    assert.ok(wires.some((wire) => independentHash(wire) === hash), `摘要 ${hash} 对不上任何实际回灌对象`);
  }
});

test("denyRun（撤销单轮）：只结算该轮，且带回程摘要", async () => {
  const { broker, eventStore } = newBroker();
  const target = broker.request({ method: "item/fileChange/requestApproval", params: { path: "/a" } }, { runId: "doomed" });
  broker.request({ method: "item/fileChange/requestApproval", params: { path: "/b" } }, { runId: "survivor" });
  await new Promise((resolve) => setImmediate(resolve));

  await broker.denyRun("doomed", "run cancelled");
  const wire = await target;
  const events = eventStore.events.filter((e) => e.type === "approval.resolved");
  assert.equal(events.length, 1, "只应结算 doomed 那一条");
  assert.equal(events[0].data.responseSha256, independentHash(wire));
  assert.equal(broker.list().length, 1, "survivor 应仍在队列");
});

test("全部终态路径都写 responseSha256（源码级：不许有漏网的 emit）", () => {
  // 终态事件类型只有这两种；每一处 emit 它们的地方都必须带回程摘要。
  const emitSites = [...brokerSource.matchAll(/"(approval\.resolved|approval\.expired)"[\s\S]{0,700}?\)\s*[;.]/g)];
  assert.ok(emitSites.length >= 5, `终态 emit 点只找到 ${emitSites.length} 处，正则可能失效`);
  for (const [site, type] of emitSites) {
    assert.match(site, /responseSha256/, `${type} 的某处 emit 缺 responseSha256`);
  }
});

// ═══ ③ 摘要与放行同源（结构性保证） ═══

test("放行的是被摘要的那个对象引用，不是重新构造的（源码级）", () => {
  // 主路径：摘要用 wireResponse，放行也必须用 wireResponse。
  // 若这里改回 item.resolve(responseFor(...))，账本与线上就又成了两个可以各自演化的东西。
  assert.match(brokerSource, /item\.resolve\(wireResponse\)/, "主路径未放行被摘要的对象");
  assert.match(brokerSource, /responseSha256: responseHash\(wireResponse\)/, "主路径未摘要放行对象");
  // 策略性拒绝分支同构
  assert.match(brokerSource, /const declineResponse = responseFor\(item\.method, false, id\)/);
  assert.match(brokerSource, /item\.resolve\(declineResponse\)/);
  assert.match(brokerSource, /responseSha256: responseHash\(declineResponse\)/);
});

test("resolve() 主路径只构造一次回灌对象（算两次就能不一致）", () => {
  const start = brokerSource.indexOf("async resolve(id, {");
  assert.notEqual(start, -1);
  const body = brokerSource.slice(start, brokerSource.indexOf("async denyAll", start));
  // 先剥注释：注释里提到 responseFor(...) 是说明文字，不是调用点。
  // 不剥的话本断言会把文档当代码数，红得莫名其妙（首版就踩了这一脚）。
  const code = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const calls = code.match(/responseFor\(/g) ?? [];
  assert.equal(calls.length, 2, `resolve() 里 responseFor 被调了 ${calls.length} 次，多余的那次就是不一致的入口`);
  // 且这两次分别是唯一取值点与策略性拒绝分支，不是同一路径上的两次
  assert.match(code, /wireResponse = responseFor\(item\.method, approved, id\)/);
  assert.match(code, /declineResponse = responseFor\(item\.method, false, id\)/);
});

test("构造失败时摘要记 null，不记一个从未上线的值", () => {
  // denyAll/denyRun 的 responseFor 可能抛（宽权限之类），此时账本必须如实记 null。
  const matches = brokerSource.match(/responseSha256: constructError \? null : responseHash\(wireResponse\)/g) ?? [];
  assert.equal(matches.length, 2, "denyAll / denyRun 应各有一处构造失败的如实处理");
  assert.match(brokerSource, /if \(constructError\) item\.reject\(constructError\);/);
});

// ═══ 键序稳定性 ═══

test("摘要与键序无关（构造器写法调整不该让历史摘要失配）", async () => {
  const { broker, eventStore, item, wirePromise } = await openPending("control/runBuild/requestApproval", {});
  await broker.resolve(item.id, { decision: "approve", actionSha256: item.actionSha256 });
  const wire = await wirePromise;

  // 同内容、不同插入序
  const reordered = { approvalId: wire.approvalId, decision: wire.decision };
  assert.notEqual(
    JSON.stringify(reordered),
    JSON.stringify(wire),
    "前提：两者的 JSON.stringify 应因键序而不同",
  );
  assert.equal(
    independentHash(reordered),
    terminalEvent(eventStore).data.responseSha256,
    "摘要受键序影响 —— 换个构造器写法就会让账本对不上",
  );
});

// ═══ 元验收：篡改任一侧，断言必须变红 ═══

test("元验收：把放行对象换成重新构造，同源断言必须变红", () => {
  // 四条终态路径各有一处同源放行（resolve / expire / denyAll / denyRun），
  // 全部换成重新构造，才算模拟了"回退到 v50 之前"。
  const gutted = brokerSource.replace(
    /item\.resolve\(wireResponse\)/g,
    "item.resolve(responseFor(item.method, approved, id))",
  );
  assert.ok(!/item\.resolve\(wireResponse\)/.test(gutted), "前提：替换后应无同源放行");
  // 真实源码里四处都在
  const sites = brokerSource.match(/item\.resolve\(wireResponse\)/g) ?? [];
  assert.equal(sites.length, 4, `同源放行点应有 4 处（resolve/expire/denyAll/denyRun），实得 ${sites.length}`);
});

test("元验收：摘要算法真的在摘内容 —— 改一个字节摘要必变", () => {
  const base = independentHash({ decision: "accept" });
  assert.notEqual(base, independentHash({ decision: "accepted" }), "值变了摘要没变");
  assert.notEqual(base, independentHash({ decision: "accept", approvalId: null }), "多一个键摘要没变");
  assert.equal(base, independentHash({ decision: "accept" }), "同内容摘出不同值");
});

test("元验收：删掉某处 responseSha256，源码级全覆盖断言必须变红", () => {
  const gutted = brokerSource.replace(/\s*responseSha256: responseHash\(wireResponse\),/, "");
  const emitSites = [...gutted.matchAll(/"(approval\.resolved|approval\.expired)"[\s\S]{0,700}?\)\s*[;.]/g)];
  const missing = emitSites.filter(([site]) => !/responseSha256/.test(site));
  assert.ok(missing.length >= 1, "删掉一处后全覆盖断言仍全绿 —— 那条断言是恒真的");
});

// ═══ 与既有字段并存 ═══

test("actionSha256 仍在且语义不变（入站摘要没被回程摘要替换掉）", async () => {
  const { broker, eventStore, item } = await openPending("item/commandExecution/requestApproval", { command: "ls" });
  const inbound = item.actionSha256;
  await broker.resolve(item.id, { decision: "approve", actionSha256: inbound });
  const event = terminalEvent(eventStore);
  assert.equal(event.data.actionSha256, inbound, "入站摘要被改了");
  assert.notEqual(event.data.responseSha256, inbound, "两个摘要相同 —— 其中一个摘错了对象");
  // 入站摘要仍是 {method, params} 的摘要（hex sha256，64 位）
  assert.match(event.data.actionSha256, /^[0-9a-f]{64}$/);
  assert.match(event.data.responseSha256, /^[0-9a-f]{64}$/);
});

test("每个登记方法都能走完带摘要的往返（新增方法忘了会在这里红）", async () => {
  for (const method of approvalMethodNames()) {
    const spec = approvalMethodSpec(method);
    const { broker, eventStore, item, wirePromise } = await openPending(method, {});
    const decision = spec.approvable === false ? "approve" : "deny";
    try {
      await broker.resolve(item.id, { decision, actionSha256: item.actionSha256 });
    } catch (error) {
      // 不可批准方法批准即抛，走策略性拒绝分支 —— 这是预期路径
      assert.equal(spec.approvable, false, `${method} 意外抛错：${error.message}`);
    }
    const wire = await wirePromise;
    const event = terminalEvent(eventStore);
    assert.equal(
      event.data.responseSha256,
      independentHash(wire),
      `${method} 的账本摘要与实际回灌对象不符`,
    );
  }
});

// ═══ 真落盘 + 真篡改：证明"入链"不是一厢情愿 ═══

/**
 * 上面的断言全部基于 stub 事件汇 —— 它们证明"broker 写了这个字段"，
 * **不证明这个字段真的受哈希链保护**。
 *
 * 「进哈希链」这句话很容易只是自我安慰：字段写进 data 就宣布"它进链了"，
 * 却从没验过篡改它是否真会被 verifyChain 发现。这两项用真 EventStore 落盘、
 * 真改盘上的字节、真跑 verifyChain —— 篡改必须被抓到，才算这条缺口真闭合。
 */
async function withRealStore(fn) {
  const root = await mkdtemp(join(tmpdir(), "cc-approval-chain-"));
  const path = join(root, "events.jsonl");
  const store = await new EventStore(path).init();
  try {
    return await fn({ store, path });
  } finally {
    await store.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

/** 真事件汇落盘是异步的，轮询等 pending 条目真正进队列（stub 只需一个微任务）。 */
async function waitForPending(broker) {
  for (let i = 0; i < 300 && broker.list().length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const [item] = broker.list();
  assert.ok(item, "pending 未进队列");
  return item;
}

test("真落盘：回程摘要写进事件行，且链自校验通过", async () => {
  await withRealStore(async ({ store, path }) => {
    const broker = new ApprovalBroker({ eventStore: store, ttlMs: 60_000 });
    const wirePromise = broker.request(
      { method: "item/commandExecution/requestApproval", params: { command: "ls" } },
      { runId: "r1", sessionId: "s1" },
    );
    const item = await waitForPending(broker);
    await broker.resolve(item.id, { decision: "approve", actionSha256: item.actionSha256 });
    const wire = await wirePromise;

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const line = lines.find((l) => l.includes("approval.resolved"));
    assert.ok(line, "approval.resolved 未落盘");
    const match = line.match(/"responseSha256":"([0-9a-f]{64})"/);
    assert.ok(match, "回程摘要未落盘 —— 只在内存里的摘要不受链保护");
    assert.equal(match[1], independentHash(wire), "落盘的摘要与实际回灌对象不符");

    const verdict = await store.verifyChain();
    assert.equal(verdict.ok, true, `原样落盘的链应完好：${JSON.stringify(verdict.breaks)}`);
  });
});

test("真篡改：改动回程摘要一个字符，verifyChain 必须报断链", async () => {
  await withRealStore(async ({ store, path }) => {
    const broker = new ApprovalBroker({ eventStore: store, ttlMs: 60_000 });
    const wirePromise = broker.request(
      { method: "item/commandExecution/requestApproval", params: { command: "ls" } },
      { runId: "r1", sessionId: "s1" },
    );
    const item = await waitForPending(broker);
    await broker.resolve(item.id, { decision: "approve", actionSha256: item.actionSha256 });
    await wirePromise;
    await store.close();

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const index = lines.findIndex((l) => l.includes("approval.resolved"));
    assert.notEqual(index, -1);
    // 只改摘要里的第一个十六进制字符 —— 最小可能的篡改
    const tampered = lines.slice();
    tampered[index] = tampered[index].replace(
      /("responseSha256":")([0-9a-f])/,
      (_, prefix, char) => `${prefix}${char === "0" ? "1" : "0"}`,
    );
    assert.notEqual(tampered[index], lines[index], "前提：篡改应真的改动了这一行");
    await writeFile(path, `${tampered.join("\n")}\n`);

    const reloaded = await new EventStore(path).init();
    try {
      const verdict = await reloaded.verifyChain();
      assert.equal(verdict.ok, false, "篡改回程摘要后链仍自称完好 —— 该字段其实不受链保护");
      assert.ok(verdict.breaks.length >= 1, "应报出至少一处断裂");
      // 断裂应精确定位到被改的那一行（1-based）
      assert.equal(verdict.breaks[0].line, index + 1, "断裂行号没指向被篡改的那一行");
      assert.equal(verdict.breaks[0].reason, "hash-mismatch");
    } finally {
      await reloaded.close().catch(() => {});
    }
  });
});
