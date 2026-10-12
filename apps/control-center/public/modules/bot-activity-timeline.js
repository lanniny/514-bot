// modules/bot-activity-timeline.js — Wave B slice 15
// Bot 活动时间线渲染：活动消息识别、分阶段分组、折叠段/协作过程组/会话消息编排。
// 工厂 + DI：所有外部依赖通过 createBotActivityTimeline(options) 注入。

import { escapeHtml, formatTime } from "../utils.js";
import { lucideIcon } from "../lucide.js";

export function createBotActivityTimeline({
  botMeta,
  botMessageAvatar,
  processCardMarkup,
  messageMarkup,
  botEventMarkup,
}) {
  function botActivityMessage(message) {
    const kind = String(message?.kind || "assistant");
    if (["process", "tool-result", "governance", "divider", "turn-meta"].includes(kind)) return true;
    if (Array.isArray(message?.tools) && message.tools.length > 0 && !String(message.text || message.content || "").trim()) {
      const isInteractive = message.tools.some((tool) => {
        const name = String(tool?.name || "").toLowerCase();
        return name.includes("askuser") || name.includes("ask_question") || name.includes("askfollowup");
      });
      if (isInteractive) return false;
      return true;
    }
    return false;
  }

  function botActivityItemMarkup(message) {
    const key = message?.key ? ` data-bot-event-key="${escapeHtml(String(message.key))}"` : "";
    if (message?.kind === "process") return processCardMarkup(message, key);
    if (Array.isArray(message?.tools) && message.tools.length) {
      return message.tools.map((tool, index) => processCardMarkup({
        ...message,
        progress: {
          kind: "tool",
          name: tool?.name || "tool",
          input: tool?.input || "",
          inputTruncated: tool?.inputTruncated === true,
          output: tool?.output || "",
          outputTruncated: tool?.outputTruncated === true,
          status: tool?.status || "completed",
          degraded: !tool?.output,
        },
      }, ` data-bot-event-key="${escapeHtml(`${String(message.key || "tool")}#${index}`)}"`)).join("");
    }
    return messageMarkup(message);
  }

  function botActivityItemCount(message) {
    if (Array.isArray(message?.tools) && message.tools.length) return message.tools.length;
    return 1;
  }

  function botActivityAgentId(message) {
    return String(message?.author || message?.sourceDataAgentId || message?.sourceAgentId || message?.sourceFrom || "").trim();
  }

  function botActivityPhaseKey(message) {
    return [
      botActivityAgentId(message) || "system",
      message?.attemptId || "",
    ].join(":");
  }

  function botActivityPhases(messages) {
    const phases = [];
    for (const message of messages.filter(Boolean)) {
      const key = botActivityPhaseKey(message);
      const current = phases.at(-1);
      if (current?.key === key) current.items.push(message);
      else phases.push({ key, agentId: botActivityAgentId(message), items: [message] });
    }
    return phases;
  }

  function botActivityPhaseMarkup(phase) {
    const first = phase.items[0] || {};
    const scoped = phase.items.find((item) => item?.round || item?.attemptId) || first;
    const agentId = phase.agentId;
    const meta = agentId ? botMeta(agentId) : null;
    const label = meta?.label || "系统";
    const count = phase.items.reduce((sum, item) => sum + botActivityItemCount(item), 0);
    const scope = [
      scoped.round ? `第 ${scoped.round} 轮` : null,
      scoped.attemptId ? `attempt ${String(scoped.attemptId).slice(0, 8)}` : null,
      `${count} 条记录`,
    ].filter(Boolean).join(" · ");
    const avatar = agentId
      ? botMessageAvatar(agentId)
      : `<span class="bot-message-avatar is-system">${lucideIcon("workflow", "icon lucide")}</span>`;
    return `<section class="bot-activity-phase" data-bot-activity-agent="${escapeHtml(agentId || "system")}">
    <header>${avatar}<span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(scope)}</small></span></header>
    <div class="bot-activity-phase-items">${phase.items.map(botActivityItemMarkup).join("")}</div>
  </section>`;
  }

  function botActivitySegmentMarkup(messages) {
    const items = messages.filter(Boolean);
    if (!items.length) return "";
    const phases = botActivityPhases(items);
    const itemCount = items.reduce((sum, item) => sum + botActivityItemCount(item), 0);
    const last = items.at(-1);
    const lastProgress = [...items].reverse().find((item) => item?.progress)?.progress || {};
    const summary = lastProgress.command || lastProgress.name || lastProgress.text || last?.text || "运行过程与工具调用";
    const shown = String(summary).replace(/\s+/g, " ").slice(0, 120);
    const labels = [...new Set(items.map(botActivityAgentId).filter(Boolean).map((id) => botMeta(id).label))];
    const firstKey = items[0]?.key || items[0]?.id || "";
    const streamKeyAttr = firstKey ? ` data-stream-key="activity-segment:${escapeHtml(String(firstKey))}"` : "";
    const summaryKeyAttr = firstKey ? ` data-stream-key="activity-segment-summary:${escapeHtml(String(firstKey))}"` : "";
    const bodyKeyAttr = firstKey ? ` data-stream-key="activity-segment-body:${escapeHtml(String(firstKey))}"` : "";
    return `<details class="bot-activity-segment"${streamKeyAttr} open data-bot-activity-segment-count="${itemCount}"><summary${summaryKeyAttr}><span><strong>${escapeHtml(labels.join("、") || "系统")}</strong><small>${escapeHtml(shown)}</small></span><b>${itemCount} 条</b><time>${escapeHtml(formatTime(last?.created_at || last?.timestamp))}</time><svg class="icon lucide bot-activity-chevron" aria-hidden="true"><use href="#lucide-chevron-down"></use></svg></summary><div class="bot-activity-body"${bodyKeyAttr}>${phases.map(botActivityPhaseMarkup).join("")}</div></details>`;
  }

  function botActivityGroupMarkup(messages, timelineMarkup = "") {
    const items = messages.filter(Boolean);
    if (!items.length) return timelineMarkup;
    const itemCount = items.reduce((sum, item) => sum + botActivityItemCount(item), 0);
    const firstKey = items[0]?.key || items[0]?.id || "";
    const streamKeyAttr = firstKey ? ` data-stream-key="activity-group:${escapeHtml(String(firstKey))}"` : "";
    const summaryKeyAttr = firstKey ? ` data-stream-key="activity-group-summary:${escapeHtml(String(firstKey))}"` : "";
    const timelineKeyAttr = firstKey ? ` data-stream-key="activity-group-timeline:${escapeHtml(String(firstKey))}"` : "";
    // 对话默认（2026-09-10）：思考/工具/文件改动等引擎过程收成一行安静控件，
    // 消息流只呈现人话回合；点开「思考过程」才展开时间线（details 原生语义，
    // reconcileMessageMarkup 对 DETAILS 保留 open 态，流式更新不打断用户展开）。
    return `<details class="bot-activity-group"${streamKeyAttr} data-bot-activity-count="${itemCount}" aria-label="思考过程"><summary class="bot-activity-summary"${summaryKeyAttr}><span class="bot-activity-icon">${lucideIcon("ellipsis", "icon lucide")}</span><span><strong>思考过程</strong></span><b>${itemCount}</b><svg class="icon lucide bot-activity-group-chevron" aria-hidden="true"><use href="#lucide-chevron-down"></use></svg></summary><div class="bot-activity-timeline"${timelineKeyAttr}>${timelineMarkup || botActivitySegmentMarkup(items)}</div></details>`;
  }

  // 纯记账：轮次分隔 / 轮次完成尾注。对话面里它们只是「第 N 轮 · 某某」，
  // 单独成组时就是截图里那种点开空无一物的「思考过程 1」药丸——不计数、不成组。
  const BOOKKEEPING_KINDS = new Set(["divider", "turn-meta"]);
  // 提问旁白：成员用 [[msg:lo]] 回话时编排器会同时落 bus.routed(to=lo) + run.waiting_input，
  // 两条都把刚渲染的回复正文再截断复述一遍。正文已在气泡里，复述不再进入过程组。
  const ECHO_EVENT_TYPES = new Set(["bus.routed", "run.waiting_input"]);

  function spokenText(value) {
    return String(value || "")
      .replace(/^\s*\[\[(?:msg:[A-Za-z0-9._-]{1,64}|memo)\]\]\s*/gm, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // 编排器 bus.routed 载荷截断长度（src/orchestrator.mjs：directive.text.slice(0, 140)）
  const ROUTED_TEXT_LIMIT = 140;

  // 只认「同一发言者 + 全文一致」，或 bus.routed 恰被截断在 140 字时的前缀。
  // 单纯前缀比对会把「请确认选择」这类真实提问当复述吞掉（烛 2026-09-30 复现）——
  // 判不准时宁可多显示一条旁白，也不能静默丢掉提问。
  function isEchoOfReply(message, lastReply) {
    if (!lastReply.text || message?.kind !== "governance" || !ECHO_EVENT_TYPES.has(message.eventType)) return false;
    if (message.eventType === "bus.routed" && message.sourceTo !== "lo") return false;
    if (!message.sourceFrom || message.sourceFrom !== lastReply.author) return false;
    const raw = String(message.sourceText || "");
    const echoed = spokenText(raw);
    if (!echoed) return false;
    if (echoed === lastReply.text) return true;
    return message.eventType === "bus.routed" && raw.length === ROUTED_TEXT_LIMIT && lastReply.text.startsWith(echoed);
  }

  function botConversationMessagesMarkup(messages) {
    const out = [];
    let segment = [];
    let previousMessage = null;
    let lastReply = { text: "", author: "" };
    const flushSegment = () => {
      segment = segment.filter((message) => (
        !BOOKKEEPING_KINDS.has(message.kind) && !isEchoOfReply(message, lastReply)
      ));
      if (segment.length) out.push(botActivityGroupMarkup(segment));
      segment = [];
    };
    for (const message of messages) {
      if (!message) continue;
      const text = String(message.text || message.content || "").trim();
      const hasTools = Array.isArray(message.tools) && message.tools.length > 0;
      // 忽略无文本、无工具且非活动类型的空消息，避免破坏思考折叠组连续性
      if (!text && !hasTools && !["process", "tool-result", "governance", "divider", "turn-meta"].includes(message.kind)) {
        continue;
      }
      if (botActivityMessage(message)) {
        segment.push(message);
        continue;
      }
      flushSegment();
      const markup = botEventMarkup(message, previousMessage);
      if (markup) out.push(markup);
      previousMessage = message;
      if (message.kind === "user") lastReply = { text: "", author: "" };
      else if (text) lastReply = { text: spokenText(text), author: String(message.author || "") };
    }
    flushSegment();
    return out.join("");
  }

  return {
    botActivitySegmentMarkup,
    botConversationMessagesMarkup,
  };
}
