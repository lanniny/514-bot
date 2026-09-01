// mention-menu.js — @ 成员提及菜单 + 协作者 chip（Wave B 切片 7）
//
// 从 app.js 抽取的主 Composer @-mention 集群：菜单渲染/选中/隐藏 + 协作者 chip 增删。
// 纯展示层——所有数据通过依赖注入获取，不直接访问 app.js 全局。
// state.js 工具函数（addRequestedAgentId / MAX_REQUESTED_AGENTS / removeRequestedAgentMention）静态导入。
import { escapeHtml } from "../utils.js";
import { addRequestedAgentId, MAX_REQUESTED_AGENTS, removeRequestedAgentMention } from "../state.js";

export function createMentionMenu({
  elements,
  state,
  byId,
  lucideIcon,
  toast,
  currentTeamMembers,
  agentLabel,
  AGENT_ROLE_BLURB,
  agentSlug,
  agentFaceMarkup,
  getSelectedRun,
  TERMINAL_RUN_STATES,
}) {
  function hideMentionMenu() {
    const menu = byId("mention-menu");
    if (menu) {
      menu.hidden = true;
      menu.innerHTML = "";
    }
    state.mentionActive = false;
    state.mentionIndex = -1;
    state.mentionCandidates = [];
    state.mentionRange = null;
    elements["task-input"]?.setAttribute("aria-expanded", "false");
    elements["task-input"]?.removeAttribute("aria-activedescendant");
  }

  function mentionQueryAtCursor(textarea) {
    if (!textarea) return null;
    const value = textarea.value;
    const caret = textarea.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const match = before.match(/(^|[\s\n])@([\w\u4e00-\u9fff-]*(?:[ \t]+[\w\u4e00-\u9fff-]+)*)$/);
    if (!match) return null;
    return { start: caret - match[2].length - 1, end: caret, query: match[2].toLowerCase().replace(/[ \t]+/g, " ").trimEnd() };
  }

  function syncMentionActiveOption() {
    const menu = byId("mention-menu");
    const textarea = elements["task-input"];
    if (!menu || !textarea) return;
    menu.querySelectorAll(".mention-item").forEach((element, index) => {
      const active = index === state.mentionIndex;
      element.classList.toggle("is-active", active);
      element.setAttribute("aria-selected", String(active));
      if (active) {
        textarea.setAttribute("aria-activedescendant", element.id);
        element.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function renderMentionMenu() {
    const menu = byId("mention-menu");
    const textarea = elements["task-input"];
    if (!menu || !textarea) return;
    const hit = mentionQueryAtCursor(textarea);
    if (!hit) {
      hideMentionMenu();
      return;
    }
    const { members, coordinator } = currentTeamMembers();
    const candidates = members
      .map((id) => ({
        id,
        label: agentLabel(id),
        role: AGENT_ROLE_BLURB[id] || "",
        isLeader: id === coordinator,
      }))
      .filter((item) => {
        if (!hit.query) return true;
        const normalized = `${item.label} ${item.id} ${item.role}`.toLowerCase().replace(/[ \t]+/g, " ");
        return hit.query.includes(" ")
          ? normalized.startsWith(hit.query)
          : normalized.includes(hit.query);
      });
    if (!candidates.length) {
      hideMentionMenu();
      return;
    }
    state.mentionActive = true;
    state.mentionCandidates = candidates;
    state.mentionIndex = 0;
    state.mentionRange = hit;
    menu.hidden = false;
    menu.innerHTML = candidates.map((item, index) => {
      return `<button class="mention-item${index === 0 ? " is-active" : ""} is-agent-${agentSlug(item.id)}" id="mention-option-${index}" type="button" role="option" aria-selected="${index === 0}" data-mention-id="${escapeHtml(item.id)}">
      <span class="mention-logo" aria-hidden="true">${agentFaceMarkup(item.id, { initialsClass: "mention-fallback" })}</span>
      <span class="mention-copy">
        <strong>${escapeHtml(item.label)}${item.isLeader ? " · leader" : ""}</strong>
        <span>${escapeHtml(item.role)}</span>
      </span>
    </button>`;
    }).join("");
    textarea.setAttribute("aria-expanded", "true");
    textarea.setAttribute("aria-activedescendant", "mention-option-0");
  }

  function applyMention(agentId) {
    const textarea = elements["task-input"];
    const range = state.mentionRange;
    if (!textarea || !range || !agentId) return;
    const continuing = Boolean(getSelectedRun() && !TERMINAL_RUN_STATES.has(getSelectedRun().status));
    if (!continuing
      && !state.requestedAgentIds.includes(agentId)
      && state.requestedAgentIds.length >= MAX_REQUESTED_AGENTS) {
      hideMentionMenu();
      toast(`一次最多点名 ${MAX_REQUESTED_AGENTS} 个 Agent`, "warning", 2400);
      textarea.focus({ preventScroll: true });
      return;
    }
    const label = agentLabel(agentId);
    const before = textarea.value.slice(0, range.start);
    const after = textarea.value.slice(range.end);
    const insert = `@${label} `;
    textarea.value = `${before}${insert}${after}`;
    const caret = before.length + insert.length;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    if (!continuing) {
      state.requestedAgentIds = addRequestedAgentId(state.requestedAgentIds, agentId);
      renderRequestedAgentChips();
    }
    hideMentionMenu();
    textarea.focus({ preventScroll: true });
    toast(`已点名 ${label}`, "success", 1800);
  }

  function renderRequestedAgentChips() {
    const container = byId("composer-collaborators");
    if (!container) return;
    const ids = [...state.requestedAgentIds];
    container.hidden = ids.length === 0;
    container.innerHTML = ids.length
      ? `<span class="composer-collaborator-label">${lucideIcon("users", "icon lucide")} 额外协作者</span>${ids.map((id) => {
        return `<span class="composer-collaborator-chip is-agent-${agentSlug(id)}">
          <span aria-hidden="true">${agentFaceMarkup(id, { initialsClass: "composer-collaborator-fallback" })}</span>
          <span>${escapeHtml(agentLabel(id))}</span>
          <button type="button" data-requested-agent-remove="${escapeHtml(id)}" title="移除额外协作者" aria-label="移除额外协作者 ${escapeHtml(agentLabel(id))}">${lucideIcon("x", "icon lucide")}</button>
        </span>`;
      }).join("")}`
      : "";
  }

  function removeRequestedAgent(agentId, { focusInput = true } = {}) {
    const id = String(agentId || "");
    if (!id || !state.requestedAgentIds.includes(id)) return;
    state.requestedAgentIds = state.requestedAgentIds.filter((candidate) => candidate !== id);
    const input = elements["task-input"];
    if (input) {
      input.value = removeRequestedAgentMention(input.value, agentLabel(id));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      renderRequestedAgentChips();
    }
    if (focusInput) input?.focus({ preventScroll: true });
  }

  return {
    hideMentionMenu,
    renderMentionMenu,
    applyMention,
    syncMentionActiveOption,
    renderRequestedAgentChips,
    removeRequestedAgent,
  };
}
