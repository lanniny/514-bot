import { redact } from "../utils.js";

// Wave B slice 22：会话消息重建域——从事件流构造不可变消息列表（排序、去重、缓存、agent 页过滤）。
// 4 个共享 WeakMap/Let 状态 + 16 个函数，全部收入工厂闭包。
export function createConversationMessages({
  agentLabel,
  eventAffectsConversation,
  declaredPayloadLength,
  turnMetaText,
  toolProgressFromFallback,
  GOVERNANCE_EVENTS,
  state,
}) {
  const eventRenderTokens = new WeakMap();
  const objectRenderTokens = new WeakMap();
  const runHistoryMessageCaches = new WeakMap();
  let nextRenderToken = 0;

  function renderTokenFor(object, prefix = "object") {
    if (!object || typeof object !== "object") return `${prefix}:${String(object ?? "")}`;
    const tokens = prefix === "event" ? eventRenderTokens : objectRenderTokens;
    let token = tokens.get(object);
    if (!token) {
      token = `${prefix}:${++nextRenderToken}`;
      tokens.set(object, token);
    }
    return token;
  }

  function freezeConversationMessage(message) {
    const snapshot = { ...message };
    if (Array.isArray(snapshot.tools)) {
      snapshot.tools = Object.freeze(snapshot.tools.map((tool) => Object.freeze({ ...tool })));
    }
    if (Array.isArray(snapshot.results)) {
      snapshot.results = Object.freeze(snapshot.results.map((result) => Object.freeze({ ...result })));
    }
    snapshot.renderToken ??= renderTokenFor(snapshot, "message");
    return Object.freeze(snapshot);
  }

  function eventMatchesAgentPage(event, agentId) {
    if (!agentId) return true;
    if (event.type === "user.message") return true;
    const data = event.data || {};
    if (event.agentId === agentId || data.agentId === agentId || data.from === agentId || data.to === agentId) return true;
    return Boolean(!event.agentId && GOVERNANCE_EVENTS[event.type] && !data.from && !data.to);
  }

  function messageMatchesAgentPage(message, agentId) {
    if (!agentId) return true;
    if (message.eventType === "user.message" || message.kind === "user") return true;
    if (
      message.sourceAgentId === agentId
      || message.sourceDataAgentId === agentId
      || message.sourceFrom === agentId
      || message.sourceTo === agentId
    ) return true;
    return Boolean(message.runLevelGovernance);
  }

  function messageTime(value) {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function compareConversationMessages(left, right) {
    return (left.sortTime ?? 0) - (right.sortTime ?? 0) || (left.seq ?? 0) - (right.seq ?? 0);
  }

  function insertConversationMessageSorted(messages, message) {
    const last = messages.at(-1);
    if (!last || compareConversationMessages(last, message) <= 0) {
      messages.push(message);
      return messages.length - 1;
    }
    let low = 0;
    let high = messages.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareConversationMessages(messages[middle], message) <= 0) low = middle + 1;
      else high = middle;
    }
    messages.splice(low, 0, message);
    return low;
  }

  function conversationMessageFromEvent(event) {
    if (!event || !eventAffectsConversation(event)) return null;
    const data = event.data || {};
    const seq = Number.isFinite(Number(event.seq)) ? Number(event.seq) : 0;
    const common = {
      runId: event.runId || null,
      created_at: event.timestamp,
      sortTime: messageTime(event.timestamp),
      seq,
      key: event.id,
      renderToken: renderTokenFor(event, "event"),
      eventType: event.type,
      sourceAgentId: event.agentId,
      sourceDataAgentId: data.agentId,
      sourceFrom: data.from,
      sourceTo: data.to,
      attemptId: data.attemptId ?? event.attemptId ?? null,
      interactionId: data.interactionId ?? null,
      interactionSeq: data.interactionSeq ?? null,
      interactionStep: data.interactionStep ?? null,
      round: data.round ?? null,
      runLevelGovernance: Boolean(!event.agentId && GOVERNANCE_EVENTS[event.type] && !data.from && !data.to),
    };
    if (event.type === "assistant.message" && (data.text || data.textLength || data.tools?.length || data.toolsTotal)) {
      return freezeConversationMessage({
        ...common,
        kind: "assistant",
        author: event.agentId || "Agent",
        text: data.text || "",
        textLength: declaredPayloadLength(data.text, data.textLength),
        tools: Array.isArray(data.tools) ? data.tools : [],
        toolsTotal: Math.max(Array.isArray(data.tools) ? data.tools.length : 0, Number(data.toolsTotal) || 0),
      });
    }
    if (event.type === "tool.result" && (data.results?.length || data.resultsTotal)) {
      return freezeConversationMessage({
        ...common,
        kind: "tool-result",
        results: Array.isArray(data.results) ? data.results : [],
        resultsTotal: Math.max(Array.isArray(data.results) ? data.results.length : 0, Number(data.resultsTotal) || 0),
      });
    }
    if (event.type === "agent.turn_started") {
      return freezeConversationMessage({ ...common, kind: "divider", text: `第 ${data.round ?? "?"} 轮 · ${agentLabel(data.agentId ?? event.agentId ?? "")}` });
    }
    if (event.type === "agent.turn_completed") {
      return freezeConversationMessage({ ...common, kind: "turn-meta", text: turnMetaText(data, event) });
    }
    if (event.type === "tool.event") {
      const label = data.command || (data.tool ? `${data.tool}${data.status ? ` · ${data.status}` : ""}` : data.status || "工具");
      return freezeConversationMessage({
        ...common,
        kind: "assistant",
        author: event.agentId || "Agent",
        text: "",
        textLength: 0,
        tools: [{ name: data.tool || "tool", input: label, inputLength: declaredPayloadLength(label, data.commandLength) }],
        toolsTotal: 1,
      });
    }
    if (event.type === "grok.completed" && (data.text || data.textLength)) {
      return freezeConversationMessage({
        ...common,
        kind: "assistant",
        author: event.agentId || "grok-build",
        text: data.text || "",
        textLength: declaredPayloadLength(data.text, data.textLength),
        tools: [],
        toolsTotal: 0,
      });
    }
    // 异常终局的半截正文：走错误块而不是 assistant 气泡——正文要看得见（排查需要），但绝不能
    // 长得像一条答完的回复（适配器侧契约见 codex-app-server.mjs finalizeActive）。
    if (event.type === "assistant.partial_message" && (data.text || data.textLength)) {
      const header = `本轮异常中止（${data.code || "未知原因"}），以下为未形成交付的部分输出：`;
      return freezeConversationMessage({
        ...common,
        kind: "tool-result",
        results: [{ isError: true, text: `${header}\n\n${data.text || ""}` }],
        resultsTotal: 1,
      });
    }
    if (["agent.error", "adapter.parse_error", "adapter.stderr"].includes(event.type)) {
      const text = data.message || event.content || event.type;
      return freezeConversationMessage({ ...common, kind: "tool-result", results: [{ isError: true, text }], resultsTotal: 1 });
    }
    if (event.type === "user.message" && (data.text || data.textLength)) {
      return freezeConversationMessage({
        ...common,
        kind: "user",
        author: "LO",
        text: data.text || "",
        textLength: declaredPayloadLength(data.text, data.textLength),
      });
    }
    // 无摘要 reasoning 完成态只用于清活跃记账（见 eventAffectsConversation），重建历史同样不落空卡
    if (event.type === "codex.item/completed") {
      const progress = data.progress;
      if (progress && !(progress.kind === "reasoning" && !progress.text)) {
        return freezeConversationMessage({ ...common, kind: "process", author: event.agentId || "Agent", progress });
      }
      // progress 为空的工具 item：凭 hint / itemType 画降级工具卡（历史丢件兜底）
      const fallback = toolProgressFromFallback(data.hint, data.itemType);
      if (fallback) {
        return freezeConversationMessage({ ...common, kind: "process", author: event.agentId || "Agent", progress: fallback });
      }
    }
    if (GOVERNANCE_EVENTS[event.type]) {
      const governance = GOVERNANCE_EVENTS[event.type];
      const text = governance.text(data, event);
      if (text == null) return null;
      const errorDetail = typeof governance.detail === "function" ? governance.detail(data) : null;
      return freezeConversationMessage({
        ...common,
        kind: "governance",
        tone: governance.toneOf?.(data) ?? governance.tone,
        text: redact(String(text)),
        ...(errorDetail ? { errorDetail: redact(String(errorDetail)) } : {}),
      });
    }
    return null;
  }

  function fallbackRunMessages(run, agentId) {
    if (!Array.isArray(run.messages)) return [];
    return run.messages
      .filter((message) => !agentId || message.role === "user" || String(message.agentId ?? message.agent_id ?? message.author ?? "") === agentId)
      .map((message, index) => freezeConversationMessage({
        kind: message.role === "user" ? "user" : "assistant",
        author: message.author ?? message.agentId ?? message.agent_id ?? "Agent",
        text: message.content ?? message.text ?? "",
        textLength: declaredPayloadLength(message.content ?? message.text, message.textLength),
        created_at: message.createdAt ?? message.created_at ?? message.timestamp ?? run.createdAt,
        sortTime: messageTime(message.createdAt ?? message.created_at ?? message.timestamp ?? run.createdAt),
        seq: index,
        key: String(message.id ?? `base-${index}`),
        eventType: message.role === "user" ? "user.message" : "assistant.message",
      }));
  }

  function ensureInitialPrompt(messages, run) {
    if (!run.prompt || messages.some((item) => item.kind === "user" && item.text === run.prompt)) return;
    insertConversationMessageSorted(messages, freezeConversationMessage({
      kind: "user",
      author: "LO",
      text: run.prompt,
      textLength: run.prompt.length,
      created_at: run.createdAt,
      sortTime: messageTime(run.createdAt),
      seq: -1,
      key: "initial-prompt",
      eventType: "user.message",
    }));
  }

  /** Codex app-server 曾把正文只写进 run.turns，不发 assistant.message——事件流有旁白/轮次行
   * 就不会走 fallbackRunMessages，结论在 CLI 里完整、会话框里蒸发。缺正文时从 turns 补回。 */
  function ensureTurnTexts(messages, run, agentId) {
    for (const turn of Array.isArray(run?.turns) ? run.turns : []) {
      const text = String(turn?.text ?? "");
      if (!text.trim()) continue;
      if (agentId && turn.agentId && turn.agentId !== agentId) continue;
      const key = `turn:${turn.id || turn.createdAt || text.slice(0, 24)}`;
      const already = messages.some((item) => item.kind === "assistant" && (
        item.text === text || item.key === key
      ));
      if (already) continue;
      insertConversationMessageSorted(messages, freezeConversationMessage({
        kind: "assistant",
        author: turn.agentId || "Agent",
        text,
        textLength: text.length,
        created_at: turn.createdAt,
        sortTime: messageTime(turn.createdAt),
        seq: 0,
        key,
        eventType: "assistant.message",
      }));
    }
  }

  function historyMessagesForRun(run, agentId, events) {
    let caches = runHistoryMessageCaches.get(events);
    if (!caches) {
      caches = new Map();
      runHistoryMessageCaches.set(events, caches);
    }
    const key = agentId ?? "all";
    const cached = caches.get(key);
    if (cached) return cached;
    const base = events.conversationMessages ?? [];
    const messages = base.length
      ? (agentId ? base.filter((message) => messageMatchesAgentPage(message, agentId)) : [...base])
      : fallbackRunMessages(run, agentId);
    ensureInitialPrompt(messages, run);
    ensureTurnTexts(messages, run, agentId);
    caches.set(key, messages);
    return messages;
  }

  function invalidateRunHistoryMessageCaches(events) {
    runHistoryMessageCaches.delete(events);
  }

  function appendRunHistoryMessageIndexes(events, event) {
    const message = conversationMessageFromEvent(event);
    if (!message) return;
    insertConversationMessageSorted(events.conversationMessages, message);
    const caches = runHistoryMessageCaches.get(events);
    if (!caches) return;
    for (const [agentId, messages] of caches) {
      if (!messageMatchesAgentPage(message, agentId === "all" ? null : agentId)) continue;
      if (message.kind === "user") {
        const synthetic = messages.findIndex((item) => item.key === "initial-prompt" && item.text === message.text);
        if (synthetic >= 0) messages.splice(synthetic, 1);
      }
      insertConversationMessageSorted(messages, message);
    }
  }

  function removeRunHistoryMessageIndexes(events, event) {
    const removeByKey = (messages) => {
      const index = messages.findIndex((message) => message.key === event.id);
      if (index >= 0) messages.splice(index, 1);
    };
    removeByKey(events.conversationMessages);
    // 缓存里可能含 synthetic initial prompt。真实 prompt 被滑动窗口淘汰后必须重建，
    // 不能只删同 key 后把首条用户意图一并永久丢掉。
    invalidateRunHistoryMessageCaches(events);
  }

  function normalizeRunMessages(run, { agentId = null } = {}) {
    const historical = state.runEvents[run.id];
    if (historical) return historyMessagesForRun(run, agentId, historical);

    // 首次历史请求完成前只需合并全局有界实时尾部（最多 160 条 / 40 MiB）。完整历史一旦
    // 到达，上面的增量索引接管，避免每个 SSE frame 重扫、去重和排序 5000 条事件。
    const items = [];
    for (const event of state.events) {
      if (event.runId !== run.id || !eventMatchesAgentPage(event, agentId)) continue;
      const message = conversationMessageFromEvent(event);
      if (message) insertConversationMessageSorted(items, message);
    }
    const messages = items.length ? items : fallbackRunMessages(run, agentId);
    ensureInitialPrompt(messages, run);
    ensureTurnTexts(messages, run, agentId);
    return messages;
  }

  return {
    renderTokenFor,
    eventMatchesAgentPage,
    messageMatchesAgentPage,
    messageTime,
    conversationMessageFromEvent,
    fallbackRunMessages,
    insertConversationMessageSorted,
    historyMessagesForRun,
    invalidateRunHistoryMessageCaches,
    appendRunHistoryMessageIndexes,
    removeRunHistoryMessageIndexes,
    normalizeRunMessages,
  };
}
