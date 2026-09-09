// modules/conversation-window.js — Wave B slice 14
// 会话分页窗口：管理可见消息范围、历史/更新加载门控、窗口冻结与释放。
// 工厂 + DI：所有外部依赖通过 createConversationWindow(options) 注入。

const CONVERSATION_WINDOW_SIZE = 160;

export function createConversationWindow({
  state,
  elements,
  selectedRun,
  conversationTabs,
  normalizeRunMessages,
  conversationMessageFromEvent,
  messageMatchesAgentPage,
  eventAffectsConversation,
  renderSelectedRun,
}) {
  const conversationWindowStarts = new Map();

  function conversationWindowKey(runId, agentId = null) {
    return `${runId}\u0000${agentId ?? "all"}`;
  }

  function conversationWindow(run, agentId, messages) {
    const key = conversationWindowKey(run.id, agentId);
    const total = messages.length;
    const latestStart = Math.max(0, total - CONVERSATION_WINDOW_SIZE);
    const storedStart = conversationWindowStarts.get(key);
    const start = storedStart == null
      ? latestStart
      : Math.min(latestStart, Math.max(0, Number(storedStart) || 0));
    const end = Math.min(total, start + CONVERSATION_WINDOW_SIZE);
    return {
      start,
      end,
      total,
      hidden: start,
      hiddenAfter: Math.max(0, total - end),
      visible: messages.slice(start, end),
    };
  }

  function freezeLatestConversationWindowForIncoming(event) {
    if (
      !eventAffectsConversation(event)
      || state.view !== "workbench"
      || state.sessionPreview
      || event.runId !== state.selectedRunId
    ) return;
    const run = selectedRun();
    if (!run) return;
    const agentId = conversationTabs.activeAgentId();
    const incomingMessage = conversationMessageFromEvent(event);
    if (!incomingMessage || !messageMatchesAgentPage(incomingMessage, agentId)) return;
    const key = conversationWindowKey(run.id, agentId);
    if (conversationWindowStarts.has(key)) return;

    const stream = elements["conversation-stream"];
    if (
      stream.dataset.renderContext !== `run:${run.id}:${agentId ?? "team"}`
      || stream.getAttribute("aria-busy") === "true"
      || stream.scrollHeight - stream.scrollTop - stream.clientHeight < 48
    ) return;

    const messages = normalizeRunMessages(run, { agentId });
    if (messages.length < CONVERSATION_WINDOW_SIZE) return;
    const latestStart = Math.max(0, messages.length - CONVERSATION_WINDOW_SIZE);
    const indexByKey = new Map(messages.map((message, index) => [String(message.key ?? ""), index]));
    let renderedStart = latestStart;
    for (const child of stream.children) {
      const renderedIndex = indexByKey.get(child.dataset?.streamKey ?? "");
      if (renderedIndex != null) {
        renderedStart = renderedIndex;
        break;
      }
    }
    conversationWindowStarts.set(key, Math.min(latestStart, Math.max(0, renderedStart)));
  }

  function conversationHistoryGateMarkup(messageWindow) {
    return messageWindow.hidden
      ? `<div class="conversation-history-gate" data-stream-key="history:gate">
        <button class="text-button" type="button" data-load-earlier>加载更早（${messageWindow.hidden}）</button>
        <span>当前窗口 ${messageWindow.visible.length} 条 · 第 ${messageWindow.start + 1}-${messageWindow.end} 条，共 ${messageWindow.total} 条</span>
      </div>`
      : "";
  }

  function conversationNewerGateMarkup(messageWindow) {
    return messageWindow.hiddenAfter
      ? `<div class="conversation-history-gate is-newer" data-stream-key="history:newer">
        <button class="text-button" type="button" data-load-newer>加载更新（${messageWindow.hiddenAfter}）</button>
        <button class="text-button" type="button" data-return-latest>回到最新</button>
        <span>第 ${messageWindow.start + 1}-${messageWindow.end} 条，共 ${messageWindow.total} 条</span>
      </div>`
        : "";
  }

  function moveConversationWindow(direction) {
    const run = selectedRun();
    if (!run || elements["conversation-stream"].getAttribute("aria-busy") === "true") return;
    const agentId = conversationTabs.activeAgentId();
    const messages = normalizeRunMessages(run, { agentId });
    const current = conversationWindow(run, agentId, messages);
    const key = conversationWindowKey(run.id, agentId);
    const latestStart = Math.max(0, messages.length - CONVERSATION_WINDOW_SIZE);
    const pageStarts = [];
    for (let start = latestStart; ; start = Math.max(0, start - CONVERSATION_WINDOW_SIZE)) {
      pageStarts.unshift(start);
      if (start === 0) break;
    }
    const nextStart = direction === "older"
      ? [...pageStarts].reverse().find((start) => start < current.start) ?? current.start
      : pageStarts.find((start) => start > current.start) ?? current.start;
    if (nextStart === latestStart) conversationWindowStarts.delete(key);
    else conversationWindowStarts.set(key, nextStart);
    renderSelectedRun({ preserveStreamState: true });
  }

  function loadEarlierConversation() {
    moveConversationWindow("older");
  }

  function loadNewerConversation() {
    moveConversationWindow("newer");
  }

  function returnToLatestConversation() {
    const run = selectedRun();
    if (!run || elements["conversation-stream"].getAttribute("aria-busy") === "true") return;
    conversationWindowStarts.delete(conversationWindowKey(run.id, conversationTabs.activeAgentId()));
    renderSelectedRun({ preserveStreamState: true });
  }

  function releaseConversationWindows(runId) {
    const prefix = `${runId}\u0000`;
    for (const key of conversationWindowStarts.keys()) {
      if (key.startsWith(prefix)) conversationWindowStarts.delete(key);
    }
  }

  function adjustConversationWindowsAfterDrop(runId, droppedMessages) {
    if (!droppedMessages.length) return;
    const prefix = `${runId}\u0000`;
    for (const [key, start] of conversationWindowStarts.entries()) {
      if (!key.startsWith(prefix)) continue;
      const rawAgentId = key.slice(prefix.length);
      const agentId = rawAgentId === "all" ? null : rawAgentId;
      const shift = droppedMessages.filter((message) => messageMatchesAgentPage(message, agentId)).length;
      if (shift) conversationWindowStarts.set(key, Math.max(0, (Number(start) || 0) - shift));
    }
  }

  return {
    conversationWindow,
    freezeLatestConversationWindowForIncoming,
    conversationHistoryGateMarkup,
    conversationNewerGateMarkup,
    loadEarlierConversation,
    loadNewerConversation,
    returnToLatestConversation,
    releaseConversationWindows,
    adjustConversationWindowsAfterDrop,
  };
}
