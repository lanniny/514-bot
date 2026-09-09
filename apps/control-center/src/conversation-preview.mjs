// Grok 对标：会话列表最近消息预览（Wave G 面纪律——独立面模块，app.mjs 一行接线）。
// 事件流是唯一汇聚点（orchestrator 与各 adapter 都经 eventStore.emit），订阅后按
// runId → conversationId 回填 ConversationStore.noteMessagePreview。
//
// 预览是派生数据：任何失败都不得影响事件主链——event-store 对抛出的 subscriber 直接
// 摘除，因此本回调必须完全自封（全 try/catch + fire-and-forget，绝不外抛）。
const PREVIEW_EVENT_TYPES = new Set(["user.message", "assistant.message"]);
const MAX_PREVIEW_TEXT = 240; // 与 conversations.mjs 的存储上限对齐

export function attachConversationPreview({ eventStore, orchestrator, conversations, isClosed = () => false }) {
  if (!eventStore || !orchestrator || !conversations) {
    throw Object.assign(new Error("conversation preview requires eventStore, orchestrator and conversations"), { code: "VALIDATION_FAILED" });
  }
  return eventStore.subscribe((event) => {
    try {
      if (isClosed()) return;
      if (!PREVIEW_EVENT_TYPES.has(event?.type)) return;
      const text = String(event.data?.text ?? "").trim();
      if (!text || !event.runId) return;
      const run = orchestrator.get(String(event.runId)); // 已清理/未知 run 抛 RUN_NOT_FOUND
      const conversationId = run?.conversationId;
      if (!conversationId) return;
      void conversations.noteMessagePreview(conversationId, {
        text: text.slice(0, MAX_PREVIEW_TEXT),
        from: event.type === "user.message" ? "LO" : event.agentId || null,
        at: event.timestamp,
      }).catch(() => {});
    } catch {
      // RUN_NOT_FOUND（迟到事件）/store 关闭竞态等一律吞掉，绝不外抛
    }
  });
}
