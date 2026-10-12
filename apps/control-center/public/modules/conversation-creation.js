// Creating a Conversation never starts a Run. Keep its receipt independent of
// view selection, so a late response cannot steal a different conversation.
export function createConversationCreation({ request, onCreated = () => {}, onPresentationError = () => {}, timeoutMs = 15000 }) {
  let pending = null;
  return {
    isPending: () => pending !== null,
    async createDirect({ memberId, title }) {
      if (pending) throw new Error("正在创建对话，请等待本次结果");
      const command = Object.freeze({ memberId: String(memberId || "").trim(), title: String(title || "").trim() });
      if (!command.memberId || !command.title || command.title.length > 120) throw new Error("请选择助手并填写 1–120 字的对话名称");
      pending = command;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const receipt = await request("/api/conversations", {
          method: "POST", signal: controller.signal,
          body: { kind: "direct", title: command.title, directMemberId: command.memberId },
        });
        const conversation = receipt?.conversation;
        if (!conversation?.id || conversation.kind !== "direct" || conversation.directMemberId !== command.memberId
          || conversation.projectId || conversation.hiddenAt || conversation.deletedAt) {
          throw new Error("创建回执归属不匹配，请刷新对话列表核对；未自动重试");
        }
        // A rendering/index callback is not a failed POST. Never offer a retry
        // as if the server had rejected this already accepted Conversation.
        try { await onCreated(conversation, receipt); }
        catch (error) { try { onPresentationError(error, conversation); } catch { /* Receipt remains valid. */ } }
        return conversation;
      } catch (error) {
        if (controller.signal.aborted || !error?.status || error.status >= 500) {
          throw Object.assign(new Error("创建状态未确认，请先刷新对话列表核对；未自动重试"), { cause: error, outcomeUnknown: true });
        }
        throw error;
      } finally {
        clearTimeout(timer);
        if (pending === command) pending = null;
      }
    },
  };
}
