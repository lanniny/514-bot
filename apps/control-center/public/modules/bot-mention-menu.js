// bot-mention-menu.js — Bot 侧 @ 成员点名菜单（Wave B 切片 11）
//
// 从 app.js 抽取的 Bot Composer @-mention 集群：作用域计算/菜单渲染/选中/应用/移除。
// 与主 Composer 的 mention-menu.js 平行，但服务于 Bot 对话表面。
// 纯展示层——所有数据通过依赖注入获取，不直接访问 app.js 全局。
// state.js 工具函数（removeRequestedAgentMention）静态导入。

import { escapeHtml } from "../utils.js";
import { lucideIcon } from "../lucide.js";
import { MAX_REQUESTED_AGENTS, removeRequestedAgentMention } from "../state.js";

export function createBotMentionMenu({
  botState,
  byId,
  botActiveConversation,
  botCatalogMember,
  botMemberIsVisible,
  botMeta,
  botMessageAvatar,
  botAvatarClass,
  botMemberAvatarContent,
}) {
  function botMentionContextKey(conversation = botActiveConversation()) {
    return conversation?.id ? `conversation:${conversation.id}` : `member:${String(botState.agentId || "")}`;
  }

  function botMentionScope(conversation = botActiveConversation()) {
    const ids = conversation?.kind === "direct"
      ? [conversation.directMemberId]
      : conversation?.kind === "workspace_group"
        ? conversation.memberIds || []
        : [botState.agentId];
    return [...new Set(ids.map((id) => String(id || "").trim()).filter((id) => (
      id && botCatalogMember(id) && botMemberIsVisible(id)
    )))];
  }

  function botMentionSelectedIds(conversation = botActiveConversation()) {
    const key = botMentionContextKey(conversation);
    const allowed = new Set(botMentionScope(conversation));
    const max = conversation?.kind === "workspace_group" ? MAX_REQUESTED_AGENTS + 1 : 1;
    const selected = [...new Set((botState.mentionSelections[key] || []).map(String).filter((id) => allowed.has(id)))].slice(0, max);
    botState.mentionSelections[key] = selected;
    return selected;
  }

  function botMentionShortId(memberId) {
    const id = String(memberId || "");
    return id.length > 8 ? id.slice(-8) : id;
  }

  function botMentionTokenLabel(memberId, conversation = botActiveConversation()) {
    const id = String(memberId || "");
    const label = botMeta(id).label;
    const duplicates = botMentionScope(conversation).filter((candidate) => botMeta(candidate).label === label).length;
    return duplicates > 1 ? `${label}#${botMentionShortId(id)}` : label;
  }

  function botHideMentionMenu() {
    const menu = byId("bot-mention-menu");
    if (menu) {
      menu.hidden = true;
      menu.innerHTML = "";
    }
    botState.mentionActive = false;
    botState.mentionIndex = -1;
    botState.mentionCandidates = [];
    botState.mentionRange = null;
    const input = byId("bot-composer-input");
    input?.setAttribute("aria-expanded", "false");
    input?.removeAttribute("aria-activedescendant");
  }

  function botMentionQueryAtCursor(textarea) {
    if (!textarea) return null;
    const value = String(textarea.value || "");
    const caret = textarea.selectionStart ?? value.length;
    const match = value.slice(0, caret).match(/(^|[\s\n])@([^@\n]{0,80})$/u);
    if (!match) return null;
    const selectedLabels = botMentionSelectedIds().map((id) => botMentionTokenLabel(id));
    if (selectedLabels.some((label) => match[2].startsWith(`${label} `))) return null;
    return {
      start: caret - match[2].length - 1,
      end: caret,
      query: match[2].normalize("NFKC").toLocaleLowerCase().replace(/[ \t]+/g, " ").trim(),
    };
  }

  function botSyncMentionActiveOption() {
    const menu = byId("bot-mention-menu");
    const input = byId("bot-composer-input");
    if (!menu || !input) return;
    menu.querySelectorAll("[data-bot-mention-id]").forEach((option, index) => {
      const active = index === botState.mentionIndex;
      option.classList.toggle("is-active", active);
      option.setAttribute("aria-selected", String(active));
      if (active) {
        input.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function botRenderMentionRecipients() {
    const root = byId("bot-mention-recipients");
    if (!root) return;
    const ids = botMentionSelectedIds();
    root.hidden = ids.length === 0;
    root.innerHTML = ids.map((id) => {
      const meta = botMeta(id);
      return `<span class="bot-mention-recipient" data-bot-mention-recipient="${escapeHtml(id)}">
        ${botMessageAvatar(id)}
        <span><small>本条点名</small><strong>${escapeHtml(meta.label)}</strong><em>${escapeHtml(meta.role)} · #${escapeHtml(botMentionShortId(id))}</em></span>
        <button type="button" data-bot-mention-remove="${escapeHtml(id)}" title="取消点名" aria-label="取消点名 ${escapeHtml(meta.label)}">${lucideIcon("x", "icon lucide")}</button>
      </span>`;
    }).join("");
  }

  function botRenderMentionMenu() {
    const menu = byId("bot-mention-menu");
    const input = byId("bot-composer-input");
    if (!menu || !input) return;
    const hit = botMentionQueryAtCursor(input);
    if (!hit) {
      botHideMentionMenu();
      return;
    }
    const scope = botMentionScope();
    const labels = new Map();
    scope.forEach((id) => {
      const label = botMeta(id).label;
      labels.set(label, (labels.get(label) || 0) + 1);
    });
    const candidates = scope.map((id) => {
      const meta = botMeta(id);
      return { id, meta, member: botCatalogMember(id) };
    }).filter(({ id, meta }) => {
      if (!hit.query) return true;
      return `${meta.label} ${meta.role} ${id}`.normalize("NFKC").toLocaleLowerCase().includes(hit.query);
    });
    botState.mentionActive = true;
    botState.mentionCandidates = candidates;
    botState.mentionIndex = candidates.length ? Math.min(Math.max(botState.mentionIndex, 0), candidates.length - 1) : -1;
    botState.mentionRange = hit;
    menu.hidden = false;
    menu.innerHTML = candidates.length ? candidates.map(({ id, meta, member }, index) => {
      const duplicate = labels.get(meta.label) > 1;
      return `<button class="bot-mention-option${index === botState.mentionIndex ? " is-active" : ""}" id="bot-mention-option-${index}" type="button" role="option" aria-selected="${index === botState.mentionIndex}" data-bot-mention-id="${escapeHtml(id)}">
        <span class="bot-agent-avatar ${botAvatarClass(meta.tone)}">${botMemberAvatarContent(member, meta)}</span>
        <span><strong>${escapeHtml(meta.label)}</strong><small>${escapeHtml(meta.role)}${duplicate ? ` · #${escapeHtml(botMentionShortId(id))}` : ""}</small></span>
      </button>`;
    }).join("") : '<div class="bot-mention-empty" role="option" aria-disabled="true">当前会话没有匹配成员</div>';
    input.setAttribute("aria-expanded", "true");
    if (botState.mentionIndex >= 0) input.setAttribute("aria-activedescendant", `bot-mention-option-${botState.mentionIndex}`);
    else input.removeAttribute("aria-activedescendant");
  }

  function botApplyMention(memberId) {
    const id = String(memberId || "");
    const input = byId("bot-composer-input");
    const range = botState.mentionRange;
    if (!input || !range || !botMentionScope().includes(id)) return;
    const conversation = botActiveConversation();
    const selected = botMentionSelectedIds(conversation);
    const tokenLabel = botMentionTokenLabel(id, conversation);
    const before = input.value.slice(0, range.start);
    const after = input.value.slice(range.end);
    let nextValue = `${before}@${tokenLabel} ${after}`;
    const replaceSingle = conversation?.kind !== "workspace_group";
    const previousId = selected[0] || "";
    if (replaceSingle && previousId && previousId !== id) {
      nextValue = removeRequestedAgentMention(nextValue, botMentionTokenLabel(previousId, conversation));
    }
    input.value = nextValue;
    const nextIds = replaceSingle
      ? [id]
      : [...new Set([...selected, id])].slice(0, MAX_REQUESTED_AGENTS + 1);
    botState.mentionSelections[botMentionContextKey(conversation)] = nextIds;
    const caret = Math.min(input.value.length, before.length + tokenLabel.length + 2);
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    botHideMentionMenu();
    botRenderMentionRecipients();
    input.focus({ preventScroll: true });
  }

  function botRemoveMentionRecipient(memberId, { updateText = true } = {}) {
    const id = String(memberId || "");
    const key = botMentionContextKey();
    botState.mentionSelections[key] = botMentionSelectedIds().filter((candidate) => candidate !== id);
    const input = byId("bot-composer-input");
    if (updateText && input && id) input.value = removeRequestedAgentMention(input.value, botMentionTokenLabel(id));
    botRenderMentionRecipients();
    input?.dispatchEvent(new Event("input", { bubbles: true }));
    input?.focus({ preventScroll: true });
  }

  function botClearMentionRecipients() {
    botState.mentionSelections[botMentionContextKey()] = [];
    botHideMentionMenu();
    botRenderMentionRecipients();
  }

  return {
    botMentionContextKey,
    botMentionScope,
    botMentionSelectedIds,
    botMentionShortId,
    botMentionTokenLabel,
    botHideMentionMenu,
    botMentionQueryAtCursor,
    botSyncMentionActiveOption,
    botRenderMentionRecipients,
    botRenderMentionMenu,
    botApplyMention,
    botRemoveMentionRecipient,
    botClearMentionRecipients,
  };
}
