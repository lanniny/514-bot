import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventStore } from "../src/event-store.mjs";
import { ConversationStore } from "../src/conversations.mjs";
import { attachConversationPreview } from "../src/conversation-preview.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "514cc-conversation-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const conversations = await new ConversationStore({ dataRoot: root }).init();
  const eventStore = await new EventStore(join(root, "events.jsonl")).init();
  t.after(() => eventStore.close().catch(() => {}));
  const runs = new Map();
  const orchestrator = {
    get(id) {
      const run = runs.get(String(id));
      if (!run) throw Object.assign(new Error("run not found"), { code: "RUN_NOT_FOUND" });
      return run;
    },
  };
  return { root, conversations, eventStore, runs, orchestrator };
}

async function waitForPreview(conversations, id, { attempts = 40 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const preview = conversations.get(id).preview;
    if (preview) return preview;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

test("user.message and assistant.message events backfill conversation preview end to end", async (t) => {
  const { conversations, eventStore, runs, orchestrator } = await fixture(t);
  attachConversationPreview({ eventStore, orchestrator, conversations });
  const conversation = await conversations.create({ kind: "direct", title: "Miku", directMemberId: "miku-fast" });
  runs.set("run-1", { id: "run-1", conversationId: conversation.id });

  await eventStore.emit("user.message", { text: "两件事一起做：把剩余卡片接到真实数据" }, { runId: "run-1", agentId: "LO" });
  const first = await waitForPreview(conversations, conversation.id);
  assert.ok(first, "user.message 必须回填预览");
  assert.match(first.text, /两件事一起做/);
  assert.equal(first.from, "LO");

  await eventStore.emit("assistant.message", { text: "收到，先接 Routines 卡片" }, { runId: "run-1", agentId: "miku-fast" });
  let second = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    second = conversations.get(conversation.id).preview;
    if (second?.from === "miku-fast") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(second?.text, "收到，先接 Routines 卡片");
  assert.equal(second?.from, "miku-fast");
});

test("preview subscriber never leaks failures into the event chain", async (t) => {
  const { conversations, eventStore, runs, orchestrator } = await fixture(t);
  const unsubscribe = attachConversationPreview({ eventStore, orchestrator, conversations });
  const conversation = await conversations.create({ kind: "direct", title: "Miku", directMemberId: "miku-fast" });
  runs.set("run-gone", null); // get 抛 RUN_NOT_FOUND
  runs.set("run-orphan", { id: "run-orphan", conversationId: null }); // 无会话归属

  // 未知 run / 无归属 run / 空文本 / 无关事件：全部静默，且后续正常事件照常回填
  await eventStore.emit("user.message", { text: "迟到事件" }, { runId: "run-missing", agentId: "LO" });
  await eventStore.emit("user.message", { text: "孤儿 run" }, { runId: "run-orphan", agentId: "LO" });
  await eventStore.emit("user.message", { text: "   " }, { runId: "run-orphan", agentId: "LO" });
  await eventStore.emit("tool.event", { text: "无关事件类型" }, { runId: "run-orphan" });
  await eventStore.emit("user.message", { text: "正常消息" }, { runId: "run-live", agentId: "LO" });
  runs.set("run-live", { id: "run-live", conversationId: conversation.id });
  // run-live 在 emit 后才登记：此时事件已跳过，重新 emit 一条验证链路仍健康
  await eventStore.emit("user.message", { text: "链路仍健康" }, { runId: "run-live", agentId: "LO" });
  const preview = await waitForPreview(conversations, conversation.id);
  assert.equal(preview?.text, "链路仍健康", "前面各类失败不得摘除 subscriber 或中断事件链");
  assert.equal(conversations.get(conversation.id).preview.text, "链路仍健康");
  unsubscribe();
});

test("attachConversationPreview requires all three collaborators", async () => {
  assert.throws(() => attachConversationPreview({}), (error) => error.code === "VALIDATION_FAILED");
});
