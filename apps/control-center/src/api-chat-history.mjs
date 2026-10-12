import { apiChatError } from "./api-chat-config.mjs";

export const API_CHAT_CONTEXT_BYTES = 128 * 1024;
export const API_CHAT_CONTEXT_MESSAGES = 80;

export function apiChatRequestMessages(messages, systemPrompt = "", memoryPrompt = "") {
  if (!Array.isArray(messages) || !messages.length || messages.length > API_CHAT_CONTEXT_MESSAGES
    || typeof systemPrompt !== "string"
    || typeof memoryPrompt !== "string"
    || messages.some((item) => !["user", "assistant"].includes(item?.role) || typeof item.content !== "string")) {
    throw apiChatError("API_CONTEXT_INVALID", "文本上下文缺失或格式无效");
  }
  const requestMessages = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    ...(memoryPrompt ? [{ role: "system", content: memoryPrompt }] : []),
    { role: "system", content: "你是文本聊天助手。当前连接没有浏览器、文件、终端或外部工具。不要声称已搜索、读取附件或执行本地操作。" },
    ...messages.map(({ role, content }) => ({ role, content })),
  ];
  if (Buffer.byteLength(JSON.stringify(requestMessages)) > API_CHAT_CONTEXT_BYTES) {
    throw apiChatError("API_CONTEXT_LIMIT", "文本上下文与助手指令合计超过上限，请新建对话或缩短助手指令");
  }
  return requestMessages;
}

export function compactHistoryMessages(messages, maxBytes = API_CHAT_CONTEXT_BYTES - 16 * 1024, maxCount = API_CHAT_CONTEXT_MESSAGES) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const currentPrompt = messages[messages.length - 1];
  if (Buffer.byteLength(JSON.stringify([currentPrompt])) > maxBytes) {
    throw apiChatError("API_CONTEXT_LIMIT", "单次提示词过长，超过文本上下文上限，请精简输入");
  }
  while (messages.length > maxCount || Buffer.byteLength(JSON.stringify(messages)) > maxBytes) {
    if (messages.length <= 1) {
      throw apiChatError("API_CONTEXT_LIMIT", "单次提示词与上下文合计超过上限，请精简输入");
    }
    if (messages.length >= 3 && messages[0]?.role === "user" && messages[1]?.role === "assistant") {
      messages.splice(0, 2);
    } else {
      messages.shift();
    }
  }
  return messages;
}

// ConversationStore owns the run chain; turns own the submitted text and answer.
// No browser transcript, native CLI session, or unrelated member enters API context.
export function apiChatHistory({ conversation, run, runs, agentId, prompt }) {
  if (conversation?.kind !== "direct" || conversation.id !== run.conversationId
    || conversation.directMemberId !== agentId || run.conversationKind !== "direct") {
    throw apiChatError("API_CHAT_DIRECT_ONLY", "此连接目前只支持与单个助手进行文本对话");
  }
  const messages = [];
  for (const id of conversation.runIds || []) {
    const previous = runs.get(id);
    if (!previous) {
      if (id === run.id) throw apiChatError("API_HISTORY_UNAVAILABLE", "当前任务尚未绑定到会话");
      continue;
    }
    const validConversation = previous.conversationId === conversation.id
      || (Boolean(conversation.sourceConversationId) && previous.conversationId === conversation.sourceConversationId);
    if (!validConversation || previous.conversationKind !== "direct") {
      throw apiChatError("API_HISTORY_UNAVAILABLE", "部分会话历史不可用，请新建对话后继续");
    }
    for (const turn of previous.turns || []) {
      if (turn.agentId !== agentId || turn.outcome !== "completed" || turn.protocol !== "openai-chat-completions") continue;
      if (typeof turn.chatUserText !== "string" || typeof turn.text !== "string") {
        throw apiChatError("API_HISTORY_UNAVAILABLE", "会话上下文不完整，请新建对话后继续");
      }
      messages.push({ role: "user", content: turn.chatUserText }, { role: "assistant", content: turn.text });
    }
    if (id === run.id) break;
  }
  if (!(conversation.runIds || []).includes(run.id)) throw apiChatError("API_HISTORY_UNAVAILABLE", "当前任务尚未绑定到会话");
  messages.push({ role: "user", content: String(prompt) });
  return compactHistoryMessages(messages);
}
