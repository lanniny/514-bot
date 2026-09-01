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
    return Array.isArray(message?.tools) && message.tools.length > 0 && !String(message.text || message.content || "").trim();
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
    return `<details class="bot-activity-segment" data-bot-activity-segment-count="${itemCount}">
    <summary><span><strong>${escapeHtml(labels.join("、") || "系统")}</strong><small>${escapeHtml(shown)}</small></span><b>${itemCount} 条</b><time>${escapeHtml(formatTime(last?.created_at || last?.timestamp))}</time><svg class="icon lucide bot-activity-chevron" aria-hidden="true"><use href="#lucide-chevron-down"></use></svg></summary>
    <div class="bot-activity-body">${phases.map(botActivityPhaseMarkup).join("")}</div>
  </details>`;
  }

  function botActivityGroupMarkup(messages, timelineMarkup = "") {
    const items = messages.filter(Boolean);
    if (!items.length) return timelineMarkup;
    const itemCount = items.reduce((sum, item) => sum + botActivityItemCount(item), 0);
    const memberCount = new Set(items.map(botActivityAgentId).filter(Boolean)).size;
    const last = items.at(-1);
    return `<section class="bot-activity-group" data-bot-activity-count="${itemCount}" aria-label="协作过程">
    <header class="bot-activity-summary"><span class="bot-activity-icon">${lucideIcon("workflow", "icon lucide")}</span><span><strong>协作过程</strong><small>成员回复与工具记录按发生顺序排列</small></span><b>${memberCount ? `${memberCount} 位 · ` : ""}${itemCount} 条</b><time>${escapeHtml(formatTime(last?.created_at || last?.timestamp))}</time></header>
    <div class="bot-activity-timeline">${timelineMarkup || botActivitySegmentMarkup(items)}</div>
  </section>`;
  }

  function botConversationMessagesMarkup(messages) {
    const prefix = [];
    const timeline = [];
    const activity = [];
    let segment = [];
    let activityStarted = false;
    let previousMessage = null;
    const flushSegment = () => {
      if (!segment.length) return;
      activity.push(...segment);
      timeline.push(botActivitySegmentMarkup(segment));
      segment = [];
      previousMessage = null;
    };
    for (const message of messages) {
      if (botActivityMessage(message)) {
        activityStarted = true;
        segment.push(message);
        continue;
      }
      flushSegment();
      const markup = botEventMarkup(message, previousMessage);
      if (markup) (activityStarted ? timeline : prefix).push(markup);
      previousMessage = message;
    }
    flushSegment();
    if (activity.length) prefix.push(botActivityGroupMarkup(activity, timeline.join("")));
    return prefix.join("");
  }

  return {
    botActivitySegmentMarkup,
    botConversationMessagesMarkup,
  };
}
