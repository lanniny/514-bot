// Conversation admission is independent of the visible Run and Workbench form.
export function createConversationCommands({ request, onPending = () => {}, onAccepted = () => {}, onSettled = () => {}, onPresentationError = (error) => console.error("Accepted message presentation failed", error), timeoutMs = 15000 }) {
  const pending = new Map();
  return {
    isPending: (conversationId) => pending.has(String(conversationId || "")),
    async submit({ conversation, prompt, recipientMemberIds = [], sources = [], permissionMode = "plan", model = undefined, effort = undefined, maxBudgetUsdPerTurn = undefined, acknowledgeRecovery = undefined }) {
      const conversationId = String(conversation?.id || "");
      if (!conversationId || conversation.deletedAt) throw new Error("工作对话不可用");
      if (pending.has(conversationId)) throw new Error("上一条消息仍在等待准入回执");
      const members = new Set(conversation.memberIds || []);
      if (!members.size) throw new Error("工作对话还没有执行成员");
      if (recipientMemberIds.length > 1 || recipientMemberIds.some((id) => !members.has(id))) throw new Error("直接收件人必须是当前工作对话的一位成员");
      const command = Object.freeze({
        conversationId, prompt: String(prompt || "").trim(),
        recipientMemberIds: Object.freeze([...recipientMemberIds]),
        sources: Object.freeze(sources.map((source) => Object.freeze({ ...source }))),
        permissionMode: permissionMode === "build" || permissionMode === "review" ? permissionMode : "plan",
        // 工作区群聊恒为 social 协作：预算缺省时由调用方按 social 有限兜底传入；
        // undefined = 走席位默认（pipeline 可无限，social 由后端隐式回退兜底）。
        // acknowledgeRecovery 仅在调用方已获用户显式恢复确认时携带 true（一次性语义）。
        ...(String(model || "").trim() ? { model: String(model).trim() } : {}),
        ...(String(effort || "").trim() ? { effort: String(effort).trim() } : {}),
        ...(maxBudgetUsdPerTurn === undefined ? {} : { maxBudgetUsdPerTurn }),
        ...(acknowledgeRecovery === undefined ? {} : { acknowledgeRecovery }),
      });
      if (!command.prompt) throw new Error("消息不能为空");
      pending.set(conversationId, command);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        onPending(command);
        const payload = await request(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
          method: "POST",
          signal: controller.signal,
          body: {
            prompt: command.prompt, messageIntent: "steer",
            ...(command.recipientMemberIds.length ? { recipientMemberIds: command.recipientMemberIds } : {}),
            ...(command.sources.length ? { sources: command.sources } : {}),
            // Permission applies to a new Run. An active Run retains its own grant.
            permissionMode: command.permissionMode,
            ...(command.model ? { model: command.model } : {}),
            ...(command.effort ? { effort: command.effort } : {}),
            ...(command.maxBudgetUsdPerTurn === undefined ? {} : { maxBudgetUsdPerTurn: command.maxBudgetUsdPerTurn }),
            ...(command.acknowledgeRecovery === undefined ? {} : { acknowledgeRecovery: command.acknowledgeRecovery }),
          },
        });
        clearTimeout(timer);
        const run = payload?.run || payload;
        if (!run?.id || run.conversationId !== conversationId) throw new Error("准入回执的工作对话归属不匹配，请刷新核对；未自动重发");
        try { await onAccepted(run, command); } catch (error) { onPresentationError(error, run, command); }
        return run;
      } catch (error) {
        if (controller.signal.aborted) throw new Error("消息准入超时，请刷新核对后再发送；未自动重试");
        throw error;
      } finally {
        clearTimeout(timer);
        if (pending.get(conversationId) === command) pending.delete(conversationId);
        onSettled(command);
      }
    },
  };
}
