// UI-AUDIT Wave B 契约：会话消息重建域抽取到 modules/conversation-messages.js
// 行为锁定：二分插入保序、消息快照冻结、renderToken 跨调用稳定；app.js 旧模块级缓存状态必须删除
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createConversationMessages } from "../public/modules/conversation-messages.js";

const root = fileURLToPath(new URL("..", import.meta.url));

function buildModule(overrides = {}) {
  return createConversationMessages({
    agentLabel: (id) => id || "Agent",
    eventAffectsConversation: () => true,
    declaredPayloadLength: (value, declared) => declared ?? (value ? value.length : 0),
    turnMetaText: () => "",
    toolProgressFromFallback: () => null,
    GOVERNANCE_EVENTS: {},
    state: { runEvents: {}, events: [] },
    ...overrides,
  });
}

test("insertConversationMessageSorted 二分插入保持 sortTime/seq 全序", () => {
  const mod = buildModule();
  const messages = [];
  const specs = [
    { sortTime: 300, seq: 1, key: "c" },
    { sortTime: 100, seq: 5, key: "a" },
    { sortTime: 100, seq: 9, key: "a2" },
    { sortTime: 200, seq: 0, key: "b" },
    { sortTime: 999, seq: 0, key: "d" },
  ];
  for (const spec of specs) mod.insertConversationMessageSorted(messages, spec);
  assert.deepEqual(messages.map((m) => m.key), ["a", "a2", "b", "c", "d"], "乱序插入后必须按 sortTime 再按 seq 有序");
  assert.equal(mod.insertConversationMessageSorted(messages, { sortTime: 150, seq: 0, key: "ab" }), 2, "返回插入下标");
});

test("conversationMessageFromEvent 产出冻结快照且 renderToken 稳定", () => {
  const mod = buildModule();
  const event = { id: "e1", type: "user.message", timestamp: "2026-09-01T00:00:00Z", data: { text: "hi" } };
  const message = mod.conversationMessageFromEvent(event);
  assert.equal(message.kind, "user");
  assert.equal(message.text, "hi");
  assert.ok(Object.isFrozen(message), "消息快照必须冻结，防止渲染层改写缓存");
  assert.equal(mod.conversationMessageFromEvent(event).renderToken, message.renderToken, "同一事件对象两次重建必须复用 token");
  const skipped = mod.conversationMessageFromEvent({ id: "e2", type: "user.message", timestamp: "2026-09-01T00:00:01Z", data: {} });
  assert.equal(skipped, null, "无 text/textLength 的 user.message 不落消息");
});

test("agent 页过滤：无主事件只有治理事件可进 agent 页", () => {
  const mod = buildModule({ GOVERNANCE_EVENTS: { "run.completed": { tone: "info" } } });
  assert.equal(mod.eventMatchesAgentPage({ type: "user.message" }, "agent-a"), true, "用户消息对全部 agent 页可见");
  assert.equal(mod.eventMatchesAgentPage({ type: "run.completed" }, "agent-a"), true, "无主治理事件可进 agent 页");
  assert.equal(mod.eventMatchesAgentPage({ type: "assistant.message", agentId: "agent-b" }, "agent-a"), false, "他人事件不进本 agent 页");
});

test("app.js 接线契约：工厂调用齐全且旧模块级缓存状态已删除", async () => {
  const app = await readFile(`${root}/public/app.js`, "utf8");
  assert.ok(app.includes('from "./modules/conversation-messages.js"'), "app.js 必须引入会话消息模块");
  const destructure = app.match(/const \{\s*renderTokenFor[\s\S]*?\} = createConversationMessages\(/);
  assert.ok(destructure, "必须从工厂解构会话消息 API");
  for (const fn of [
    "insertConversationMessageSorted", "historyMessagesForRun", "appendRunHistoryMessageIndexes",
    "removeRunHistoryMessageIndexes", "normalizeRunMessages", "conversationMessageFromEvent",
  ]) {
    assert.ok(destructure[0].includes(fn), `解构缺 API：${fn}`);
  }
  for (const stale of ["eventRenderTokens", "objectRenderTokens", "runHistoryMessageCaches", "nextRenderToken"]) {
    assert.ok(!app.includes(stale), `旧模块级状态必须删除：${stale}`);
  }
  assert.ok(!app.includes("function conversationMessageFromEvent("), "重建函数本体不得残留在 app.js");
});
