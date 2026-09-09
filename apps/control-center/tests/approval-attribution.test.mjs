/**
 * 审批请求归属契约测试（v49 · 2026-09-04）。
 *
 * 被测：`codex-app-server.mjs` 的 `resolveRequestAttribution()` —— 把子进程发来的
 * 审批请求对应到某一轮活跃 run。归属结果进审计事件 / UI 审批卡 / 审批队列，
 * 归错 = 操作者看到的上下文是错的。
 *
 * ── 期望值的依据（不从被测代码派生）──
 * Codex 0.151.0 官方 JSON Schema，本机 `codex app-server generate-json-schema` 导出实测：
 *
 *   CommandExecutionRequestApprovalParams  required: [itemId, startedAtMs, threadId, turnId]
 *   FileChangeRequestApprovalParams        required: [itemId, startedAtMs, threadId, turnId]
 *   PermissionsRequestApprovalParams       required: [cwd, itemId, permissions, startedAtMs, threadId, turnId]
 *   ApplyPatchApprovalParams               required: [callId, conversationId, fileChanges]      ← 无 threadId
 *   ExecCommandApprovalParams              required: [callId, command, conversationId, cwd, parsedCmd]  ← 无 threadId
 *
 * 结论：v2 三方法**协议保证带 threadId**（L1 恒命中）；legacy 两方法**没有 threadId**，
 * 只有 conversationId —— 这才是兜底层真正服务的对象。
 * 五个方法在 0.151 的 ServerRequest 联合类型里全部现役（legacy 未下线）。
 *
 * 这份依据也解释了为什么**不能简单收紧兜底**：L3 是 legacy 的唯一归属路径，
 * 砍掉它等于让 legacy 审批全部变成未归属。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.mjs";

/** 构造一个只用于归属计算的最小 adapter（不 spawn 任何进程）。 */
function adapterWithActive(entries) {
  const adapter = Object.create(CodexAppServerAdapter.prototype);
  adapter.activeByThread = new Map(entries);
  adapter.runtimeProfileId = "codex-profile";
  return adapter;
}

const runA = { threadId: "thread-A", turnId: "turn-1", runId: "run-A", agentId: "codex-a" };
const runB = { threadId: "thread-B", turnId: "turn-2", runId: "run-B", agentId: "codex-b" };

test("v2 方法带 threadId → exact（协议保证的正常路径）", () => {
  const adapter = adapterWithActive([["thread-A", runA], ["thread-B", runB]]);
  const result = adapter.resolveRequestAttribution({
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-B", turnId: "turn-2", itemId: "i1", startedAtMs: 1 },
  });
  assert.equal(result.attribution, "exact");
  assert.equal(result.active.runId, "run-B");
  assert.equal(result.threadId, "thread-B");
});

test("legacy 方法用 conversationId → conversation（此前完全不读该字段）", () => {
  const adapter = adapterWithActive([["thread-A", runA], ["thread-B", runB]]);
  const result = adapter.resolveRequestAttribution({
    method: "execCommandApproval",
    params: { callId: "c1", conversationId: "thread-B", command: "ls", cwd: "/x", parsedCmd: [] },
  });
  assert.equal(result.attribution, "conversation", "legacy 的 conversationId 未被用于归属");
  assert.equal(result.active.runId, "run-B");
});

test("legacy + 多活跃轮 + conversationId 不匹配 → none（不瞎归）", () => {
  const adapter = adapterWithActive([["thread-A", runA], ["thread-B", runB]]);
  const result = adapter.resolveRequestAttribution({
    method: "applyPatchApproval",
    params: { callId: "c1", conversationId: "thread-UNKNOWN", fileChanges: {} },
  });
  assert.equal(result.attribution, "none");
  assert.equal(result.active, null);
});

test("legacy + 单活跃轮 → sole-active（legacy 的实际落点，标记可见）", () => {
  const adapter = adapterWithActive([["thread-A", runA]]);
  const result = adapter.resolveRequestAttribution({
    method: "applyPatchApproval",
    params: { callId: "c1", conversationId: "not-a-thread-key", fileChanges: {} },
  });
  assert.equal(result.attribution, "sole-active");
  assert.equal(result.active.runId, "run-A");
  assert.equal(result.threadId, "thread-A", "应回填活跃轮的 threadId");
});

test("伪造他人 turnId → turn-scan（标记出来，不冒充 exact）", () => {
  const adapter = adapterWithActive([["thread-A", runA], ["thread-B", runB]]);
  const result = adapter.resolveRequestAttribution({
    method: "item/commandExecution/requestApproval",
    params: { threadId: "GARBAGE", turnId: "turn-2", itemId: "i1", startedAtMs: 1 },
  });
  assert.equal(result.attribution, "turn-scan", "被误导的归属必须留下痕迹");
  assert.equal(result.active.runId, "run-B");
  // 这条是设计取舍不是缺陷：影响面止于进程内（adapter 实例与 this.child 一对一），
  // 不跨信任边界。标记让它在审计里可见，而不是静默当成精确匹配。
});

test("原型链键作 threadId 不误命中（Map.get 不受原型链影响）", () => {
  const adapter = adapterWithActive([["thread-A", runA], ["thread-B", runB]]);
  for (const key of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]) {
    const result = adapter.resolveRequestAttribution({
      method: "item/fileChange/requestApproval",
      params: { threadId: key, itemId: "i1", startedAtMs: 1 },
    });
    assert.notEqual(result.attribution, "exact", `${key} 被当成有效 threadId`);
    assert.equal(result.attribution, "none", `${key} 在多活跃轮下应判未归属`);
  }
});

test("conversationId 非字符串时忽略，不抛", () => {
  const adapter = adapterWithActive([["thread-A", runA], ["thread-B", runB]]);
  for (const value of [null, undefined, 0, 42, {}, [], true]) {
    const result = adapter.resolveRequestAttribution({
      method: "execCommandApproval",
      params: { conversationId: value },
    });
    assert.equal(result.attribution, "none");
  }
});

test("无活跃轮时一律 none，不抛", () => {
  const adapter = adapterWithActive([]);
  for (const params of [{}, { threadId: "x" }, { turnId: "y" }, { conversationId: "z" }]) {
    const result = adapter.resolveRequestAttribution({ method: "execCommandApproval", params });
    assert.equal(result.attribution, "none");
    assert.equal(result.active, null);
  }
});

test("params 缺失/敌意类型不抛", () => {
  const adapter = adapterWithActive([["thread-A", runA]]);
  for (const message of [{}, { params: null }, { params: undefined }, { params: "str" }, { params: 0 }]) {
    assert.doesNotThrow(() => adapter.resolveRequestAttribution(message));
    const result = adapter.resolveRequestAttribution(message);
    // 单活跃轮时兜底到 sole-active；关键是不抛、且标记如实
    assert.ok(["sole-active", "none"].includes(result.attribution));
  }
});

test("thread.id / thread_id 两种旧形态仍被识别", () => {
  const adapter = adapterWithActive([["thread-A", runA], ["thread-B", runB]]);
  assert.equal(
    adapter.resolveRequestAttribution({ params: { thread: { id: "thread-A" } } }).attribution,
    "exact",
  );
  assert.equal(
    adapter.resolveRequestAttribution({ params: { thread_id: "thread-B" } }).attribution,
    "exact",
  );
});

test("归属层级取值封闭（防新增层忘了登记）", () => {
  const ALLOWED = ["exact", "conversation", "turn-scan", "sole-active", "none"];
  const adapter = adapterWithActive([["thread-A", runA], ["thread-B", runB]]);
  const probes = [
    { params: { threadId: "thread-A" } },
    { params: { conversationId: "thread-B" } },
    { params: { turnId: "turn-1" } },
    { params: {} },
    { params: { threadId: "nope" } },
  ];
  for (const message of probes) {
    assert.ok(ALLOWED.includes(adapter.resolveRequestAttribution(message).attribution));
  }
});

// ═══ 端到端接线：标记必须真的走到操作者面前 ═══

test("接线：adapter → broker → 审批快照，非精确归属一路带到 UI", async () => {
  const { ApprovalBroker } = await import("../src/approval-broker.mjs");
  const events = [];
  const broker = new ApprovalBroker({
    eventStore: { async emit(type, data) { events.push({ type, data }); return {}; } },
    ttlMs: 60_000,
  });
  // 复刻 app.mjs:189 / orchestrator.mjs:1395 的 resolver：context 原样透传
  const resolver = (message, context) => broker.request(message, context);

  const pending = resolver(
    { method: "execCommandApproval", params: { callId: "c1", conversationId: "thread-A", command: "ls" } },
    { runId: "run-A", sessionId: "thread-A", agentId: "codex-a", attribution: "conversation" },
  );
  pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  const [item] = broker.list();
  assert.equal(item.attribution, "conversation", "broker 未把 attribution 存进 pending item");
  // /api/approvals 快照就是 broker.list()，UI 从这里读
  assert.equal(broker.snapshot().approvals[0].attribution, "conversation", "快照丢了 attribution");
  await broker.resolve(item.id, { decision: "deny", actionSha256: item.actionSha256 });
});

test("接线：精确归属不下发 attribution（正常路径不制造噪音）", async () => {
  const { ApprovalBroker } = await import("../src/approval-broker.mjs");
  const broker = new ApprovalBroker({
    eventStore: { async emit() { return {}; } },
    ttlMs: 60_000,
  });
  // exact 时 adapter 的 attributionFields 是空对象 → context 里没有该键
  const pending = broker.request(
    { method: "item/fileChange/requestApproval", params: { path: "a.mjs" } },
    { runId: "run-A", sessionId: "thread-A", agentId: "codex-a" },
  );
  pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  const [item] = broker.list();
  assert.equal(Object.hasOwn(item, "attribution"), false, "精确归属不该带标记");
  await broker.resolve(item.id, { decision: "deny", actionSha256: item.actionSha256 });
});

test("接线：非字符串 attribution 被忽略（不把敌意值写进审批卡）", async () => {
  const { ApprovalBroker } = await import("../src/approval-broker.mjs");
  const broker = new ApprovalBroker({ eventStore: { async emit() { return {}; } }, ttlMs: 60_000 });
  for (const bad of [42, {}, [], true, null]) {
    const pending = broker.request(
      { method: "item/fileChange/requestApproval", params: {} },
      { runId: "r", sessionId: "s", attribution: bad },
    );
    pending.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    const item = broker.list().at(-1);
    assert.equal(Object.hasOwn(item, "attribution"), false, `${String(bad)} 被写进了审批卡`);
    await broker.resolve(item.id, { decision: "deny", actionSha256: item.actionSha256 });
  }
});

test("接线：UI 文案表覆盖全部非精确归属层，且不含 exact", () => {
  const app = readFileSync("public/app.js", "utf8");
  const block = app.slice(app.indexOf("const APPROVAL_ATTRIBUTION_NOTES"), app.indexOf("function approvalCardMarkup"));
  assert.ok(block.length > 0, "未找到 APPROVAL_ATTRIBUTION_NOTES 定义");
  for (const layer of ["conversation", "turn-scan", "sole-active", "none"]) {
    assert.ok(block.includes(layer), `文案表缺少 ${layer} —— 该层会静默无提示`);
  }
  assert.equal(/^\s*exact:/m.test(block), false, "exact 不该有文案（精确路径不显示提示）");
  // 卡片确实读了这张表
  assert.match(app, /APPROVAL_ATTRIBUTION_NOTES\[item\.attribution\]/, "审批卡未消费文案表");
});

test("元验收：若 conversation 层被移除，legacy 归属会退化（本测试文件能发现）", () => {
  // 复刻"没有 L1b conversation 层"的旧行为，证明本文件第 2 条用例确实在守它。
  const withoutConversationLayer = (activeByThread, params) => {
    const threadId = params?.threadId || params?.thread?.id || params?.thread_id || null;
    if (threadId && activeByThread.get(threadId)) return "exact";
    if (params?.turnId) {
      for (const entry of activeByThread.values()) if (entry.turnId === params.turnId) return "turn-scan";
    }
    return activeByThread.size === 1 ? "sole-active" : "none";
  };
  const map = new Map([["thread-A", runA], ["thread-B", runB]]);
  const legacyParams = { callId: "c1", conversationId: "thread-B", command: "ls", cwd: "/x", parsedCmd: [] };
  // 旧行为：多活跃轮 + 无 threadId → none（归不上）
  assert.equal(withoutConversationLayer(map, legacyParams), "none");
  // 新行为：conversationId 命中 → conversation
  const adapter = adapterWithActive([...map]);
  assert.equal(
    adapter.resolveRequestAttribution({ method: "execCommandApproval", params: legacyParams }).attribution,
    "conversation",
    "新旧行为相同说明 conversation 层没生效",
  );
});
