import { escapeHtml } from "../utils.js";
import { sessionAgentIds } from "../team-panel.js";

// ===== 浏览器式 tab 页签 + 成员 agent 独立页（LO 的信息架构） =====
// 项目 → 会话 → 成员页；每个可发送页签都绑定唯一真实成员。
// 会话行默认打开执行所有者；成员条/拓扑点击开对应成员页（只看 ta、直接问 ta）。
// 多页并存于 tab 栏实时切换，非活跃页有新消息落脏标。页签 sessionStorage 持久化（刷新不丢）。

export function createConversationTabs({
  elements,
  state,
  toast,
  agentLabel,
  agentSlug,
  focusProjectByPath,
  closeCliImmersiveIfOpen,
  stashComposerDraftForCurrentContext,
  restoreComposerDraftForCurrentContext,
  transitionComposerContext,
  runProjection,
  syncModelPick,
  renderRuns,
  setView,
  renderSelectedRun,
  fetchRunEvents,
  renderMemberStrip,
  releaseRunHistoryIfUnreferenced,
}) {
  const TABS_KEY = "514cc-conv-tabs";

  function runRecipientIds(run) {
    return [...new Set([
      ...(Array.isArray(run?.teamMembers) ? run.teamMembers : []),
      run?.executionOwnerId,
      run?.startAgentId,
      run?.coordinatorId,
      ...sessionAgentIds(run?.sessions),
    ].map((id) => String(id || "").trim()).filter(Boolean))];
  }

  function defaultRunRecipient(run) {
    const members = runRecipientIds(run);
    return [run?.executionOwnerId, run?.startAgentId, run?.coordinatorId, ...members]
      .map((id) => String(id || "").trim())
      .find((id) => id && members.includes(id)) || null;
  }

  function runRecipient(run, requestedAgentId = null) {
    const members = runRecipientIds(run);
    const requested = String(requestedAgentId || "").trim();
    return requested && members.includes(requested) ? requested : defaultRunRecipient(run);
  }

  function tabKeyOf(runId, agentId) {
    return `${runId}::${agentId}`;
  }

  function activeTab() {
    return state.tabs.find((tab) => tab.key === state.activeTabKey) ?? null;
  }

  function activeAgentId() {
    return activeTab()?.agentId ?? null;
  }

  function persistTabs() {
    try {
      sessionStorage.setItem(TABS_KEY, JSON.stringify({ tabs: state.tabs, active: state.activeTabKey }));
    } catch {
      // 隐私模式等写失败：页签退化为内存态，不阻断使用
    }
  }

  function restoreTabs() {
    const runIds = new Set(state.runs.map((run) => run.id));
    const restoreStoredSelection = !state.selectionClearedByUser && !state.sessionPreview && !state.deepLinkRunId;
    let restoredSelectedRunId = state.selectedRunId;
    try {
      const saved = JSON.parse(sessionStorage.getItem(TABS_KEY) ?? "null");
      if (saved) {
        const restored = new Map();
        for (const tab of saved.tabs ?? []) {
          if (!runIds.has(tab.runId)) continue;
          const run = state.runs.find((item) => item.id === tab.runId);
          const agentId = runRecipient(run, tab.agentId);
          if (!agentId) continue;
          const key = tabKeyOf(tab.runId, agentId);
          const previous = restored.get(key);
          restored.set(key, {
            ...tab,
            key,
            agentId,
            title: run?.title ?? tab.title,
            dirty: Boolean(previous?.dirty || tab.dirty),
          });
        }
        state.tabs = [...restored.values()];
        const savedActive = (saved.tabs ?? []).find((tab) => tab.key === saved.active);
        const activeRun = savedActive && state.runs.find((run) => run.id === savedActive.runId);
        const resolvedAgentId = activeRun ? runRecipient(activeRun, savedActive.agentId) : null;
        const migratedActiveKey = resolvedAgentId ? tabKeyOf(activeRun.id, resolvedAgentId) : null;
        state.activeTabKey = restoreStoredSelection
          ? (state.tabs.some((tab) => tab.key === migratedActiveKey) ? migratedActiveKey : state.tabs.at(-1)?.key ?? null)
          : null;
        const tab = activeTab();
        if (tab) restoredSelectedRunId = tab.runId;
      }
    } catch {
      state.tabs = [];
      state.activeTabKey = null;
    }
    if (restoredSelectedRunId !== state.selectedRunId) {
      transitionComposerContext(() => {
        state.selectedRunId = restoredSelectedRunId;
        state.selectionClearedByUser = false;
      });
    }
    if (state.deepLinkRunId && runIds.has(state.deepLinkRunId)) {
      const runId = state.deepLinkRunId;
      state.deepLinkRunId = null;
      openTab(runId);
    }
  }

  function openTab(runId, agentId = null) {
    const run = state.runs.find((item) => item.id === runId);
    if (!run) return;
    if (run.cwd && !run.remote) focusProjectByPath(run.cwd);
    const recipientId = runRecipient(run, agentId);
    if (!recipientId) {
      toast("当前会话没有可发送的真实成员", "error");
      return;
    }
    const key = tabKeyOf(runId, recipientId);
    if (!state.tabs.some((tab) => tab.key === key)) {
      state.tabs.push({ key, runId, agentId: recipientId, title: run.title, dirty: false });
    }
    activateTab(key);
  }

  function focusRenderedTab(key) {
    requestAnimationFrame(() => {
      elements["conv-tabs"]
        ?.querySelector(`[data-tab-activate="${CSS.escape(key)}"]`)
        ?.focus({ preventScroll: true });
    });
  }

  function activateTab(key, { focusTab = false } = {}) {
    const tab = state.tabs.find((item) => item.key === key);
    if (!tab) return;
    closeCliImmersiveIfOpen(); // 切会话页 = 离开当前 CLI 沉浸接续（罩层只属于它打开时的那条会话）
    stashComposerDraftForCurrentContext();
    tab.dirty = false;
    state.activeTabKey = key;
    state.selectedRunId = tab.runId;
    state.selectionClearedByUser = false;
    state.sessionPreview = null; // 切页即离开历史预览
    state.runDiffView = null; // 切页收起产物面板
    runProjection.clearSettlementSurface("workbench");
    persistTabs();
    renderTabs();
    renderMemberStrip();
    void syncModelPick();
    renderRuns(); // 左栏选中态跟随 tab
    if (state.view !== "workbench") setView("workbench");
    renderSelectedRun?.({ preserveStreamState: true });
    void fetchRunEvents(tab.runId);
    restoreComposerDraftForCurrentContext();
    if (focusTab) focusRenderedTab(key);
  }

  function closeTab(key, { restoreFocus = false } = {}) {
    const index = state.tabs.findIndex((tab) => tab.key === key);
    if (index < 0) return;
    const closedRunId = state.tabs[index].runId;
    state.tabs.splice(index, 1);
    if (state.activeTabKey === key) {
      // 删除后原右邻仍占同一 index；没有右邻时才退到左邻。
      const next = state.tabs[index] ?? state.tabs[index - 1] ?? null;
      if (next) {
        activateTab(next.key, { focusTab: restoreFocus });
        releaseRunHistoryIfUnreferenced(closedRunId);
        return;
      }
      stashComposerDraftForCurrentContext();
      state.activeTabKey = null;
      state.selectedRunId = null;
      state.selectionClearedByUser = true;
      state.sessionPreview = null;
      restoreComposerDraftForCurrentContext();
    }
    persistTabs();
    renderTabs();
    renderMemberStrip();
    renderRuns();
    releaseRunHistoryIfUnreferenced(closedRunId);
    if (restoreFocus) {
      const fallback = state.tabs[Math.min(index, state.tabs.length - 1)] ?? state.tabs[index - 1] ?? null;
      if (fallback) focusRenderedTab(fallback.key);
      else elements["task-input"]?.focus({ preventScroll: true });
    }
  }

  function renderTabs() {
    const bar = elements["conv-tabs"];
    if (!bar) return;
    bar.hidden = state.tabs.length === 0;
    bar.innerHTML = state.tabs
      .map((tab, index) => {
        const active = tab.key === state.activeTabKey;
        const roving = active || (!state.activeTabKey && index === 0);
        const agent = agentLabel(tab.agentId);
        const slug = ` is-agent-${agentSlug(tab.agentId)}`;
        const tabId = `conv-tab-${index}`;
        return `<div class="conv-tab${active ? " is-active" : ""}${slug}" role="presentation">
        <button class="conv-tab-main" id="${tabId}" type="button" role="tab"
          aria-selected="${active}" aria-controls="conversation-stream" tabindex="${roving ? 0 : -1}"
          data-tab-activate="${escapeHtml(tab.key)}" title="${escapeHtml(tab.title)} · 直接发送给 ${escapeHtml(agent)}">
          <span class="conv-tab-agent">${escapeHtml(agent)}</span>
          <span class="conv-tab-title">${escapeHtml(tab.title)}</span>
          ${tab.dirty ? '<span class="conv-tab-dirty" aria-label="有新消息"></span>' : ""}
        </button>
        <button class="conv-tab-close" type="button" data-tab-close="${escapeHtml(tab.key)}" aria-label="关闭「${escapeHtml(tab.title)}」页签">×</button>
      </div>`;
      })
      .join("");
    const panel = elements["conversation-stream"];
    const activeIndex = state.tabs.findIndex((tab) => tab.key === state.activeTabKey);
    panel?.setAttribute("aria-labelledby", activeIndex >= 0 ? `conv-tab-${activeIndex}` : "conversation-title");
  }

  return {
    activeTab,
    activeAgentId,
    persistTabs,
    renderTabs,
    openTab,
    activateTab,
    closeTab,
    restoreTabs,
    tabKeyOf,
    defaultRunRecipient,
  };
}
