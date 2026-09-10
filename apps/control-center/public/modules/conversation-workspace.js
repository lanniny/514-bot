import { botWorkspaceRoute, readBotWorkspaceRoute } from "./bot-workspace-route.js";
import { conversationOwnsRun } from "./conversation-run-ownership.js";
import { connectionPresentation } from "./control-connection-state.js";
import { runStatusText } from "../utils.js";

const TABS = ["conversation", "process", "results"];
const DRAFT_KEY = "514cc.conversation-drafts.v1";
const DRAFT_PREFIX = "514cc.conversation-draft.v2:";
const ROUTE_KEY = "514cc.bot-workspace-view.v1";
const LEGACY_ROUTE_KEY = "514cc.experience-view.v1";

export function pageWorkspaceIndex(conversations, projects, { page = 0, matches = () => true, projectMatches = () => true, size = 100 } = {}) {
  const occupied = new Set(conversations.map((item) => item.projectId).filter(Boolean));
  const entries = [
    ...conversations.filter(matches).map((conversation) => ({ conversation })),
    ...projects.filter((project) => !occupied.has(project.projectId) && projectMatches(project)).map((project) => ({ project })),
  ];
  const pages = Math.max(1, Math.ceil(entries.length / size));
  const current = Math.max(0, Math.min(pages - 1, page));
  const visible = entries.slice(current * size, (current + 1) * size);
  const visibleProjects = new Set(visible.map((entry) => entry.project?.projectId || entry.conversation?.projectId).filter(Boolean));
  return { page: current, pages, total: entries.length, conversations: visible.flatMap((entry) => entry.conversation ? [entry.conversation] : []), projects: projects.filter((project) => visibleProjects.has(project.projectId)) };
}

export function workspaceContext({ conversations, projects, resolveRun }, conversationId, selectedRunId = "") {
  const conversation = conversations.find((item) => item.id === conversationId) || null;
  const project = projects.find((item) => item.projectId === conversation?.projectId) || null;
  const owned = (id) => {
    if (!conversation || conversation.deletedAt || !id) return null;
    const run = resolveRun(id);
    return conversationOwnsRun(run, conversation, conversations) ? run : null;
  };
  const currentRun = owned(conversation?.activeRunId);
  const selectedIsLinked = !selectedRunId || selectedRunId === conversation?.activeRunId || conversation?.runIds?.includes(selectedRunId);
  const selectedRun = selectedIsLinked ? owned(selectedRunId || conversation?.activeRunId) : null;
  return { conversation, project, currentRun, selectedRun, historical: Boolean(selectedRunId && selectedRunId !== conversation?.activeRunId), readOnly: Boolean(conversation?.deletedAt || project?.archivedAt) };
}

export function createConversationDrafts({ storage = null, onStorageError = () => {} } = {}) {
  const drafts = new Map();
  try {
    const saved = JSON.parse(storage?.getItem(DRAFT_KEY) || "[]");
    for (const entry of Array.isArray(saved) ? saved : []) {
      if (typeof entry?.[0] === "string" && typeof entry?.[1] === "string" && storage?.getItem(DRAFT_PREFIX + encodeURIComponent(entry[0])) == null) drafts.set(entry[0], entry[1]);
    }
  } catch { /* Browser storage is an optional view preference. */ }
  return {
    read(id) {
      if (drafts.has(id)) return drafts.get(id);
      try { return storage?.getItem(DRAFT_PREFIX + encodeURIComponent(id)) || ""; } catch { return ""; }
    },
    save(id, value) {
      if (!id) return;
      const text = String(value || "");
      drafts.set(id, text);
      try {
        if (!storage) throw new Error("browser storage unavailable");
        // Only the current draft is serialized. Never evict or truncate unsent
        // user text to meet a UI cache budget; quota failure stays in memory.
        storage.setItem(DRAFT_PREFIX + encodeURIComponent(id), text);
      } catch { onStorageError(); }
    },
  };
}

// One host, one selected Conversation. The controller stores only view/draft
// preferences; both legacy and new routes read the existing shared domain state.
export function createConversationWorkspace({ root, input, getSnapshot, openConversation, openRun, beforeRunSelection = () => {}, onRouteChange, onRouteError, onNavigate, onRefresh, renderInsights }) {
  const doc = root.ownerDocument;
  let view = { conversationId: "", runId: "", tab: "conversation" };
  let storage;
  try { storage = sessionStorage; view = readBotWorkspaceRoute(storage.getItem(ROUTE_KEY) || storage.getItem(LEGACY_ROUTE_KEY) || "") || view; } catch { /* Optional persistence. */ }
  const drafts = createConversationDrafts({ storage, onStorageError: () => {
    const state = doc.getElementById("workspace-draft-state");
    if (state) state.textContent = "草稿仅暂存在本页，浏览器存储不可用";
  } });
  const permissions = new Map();
  const budgets = new Map();
  const BUDGET_OPTIONS = ["2", "3", "5", "10", "20", "50"];
  const DEFAULT_BUDGET = "5";
  let inputOwner = "";
  let applying = 0;
  let selectingFromRoute = false;
  let routeGeneration = 0;
  let pendingRoute = null;
  let signature = "";
  let projectsReference = null;
  const draftsByContext = () => getSnapshot().activeConversationId || `member:${getSnapshot().agentId || ""}`;
  const text = (id, value) => { const node = doc.getElementById(id); if (node && node.textContent !== value) node.textContent = value; };
  const route = () => botWorkspaceRoute(view);
  function remember(previous = "", navigationToken) {
    const snapshot = getSnapshot();
    if (snapshot.active && snapshot.ownsLocation !== false) history.replaceState(history.state, "", route());
    try { storage?.setItem(ROUTE_KEY, route()); } catch { /* Optional persistence. */ }
    if (previous && previous !== route()) onRouteChange?.(previous, navigationToken);
  }
  function saveDraft() { if (inputOwner) drafts.save(inputOwner, input.value); }
  function cancelRoute() {
    routeGeneration += 1;
    pendingRoute?.finish?.(false);
    pendingRoute = null;
    applying = 0;
  }
  function beforeSelection() {
    saveDraft();
    if (!selectingFromRoute) cancelRoute();
  }
  function syncDraft() {
    const next = draftsByContext();
    if (next === inputOwner) return;
    saveDraft();
    inputOwner = next;
    input.value = drafts.read(next);
    text("workspace-admission", "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function setTab(tab, { rememberChange = true } = {}) {
    if (!TABS.includes(tab)) return;
    if (rememberChange && pendingRoute?.navigationToken) {
      view = pendingRoute.previousView;
      cancelRoute();
    }
    const previous = route();
    view.tab = tab;
    for (const button of root.querySelectorAll("[data-workspace-tab]")) {
      const selected = button.dataset.workspaceTab === tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    const stream = doc.getElementById("bot-message-stream");
    const insights = doc.getElementById("workspace-insights");
    stream.hidden = tab !== "conversation";
    insights.hidden = tab === "conversation";
    insights.setAttribute("aria-labelledby", `workspace-tab-${tab}`);
    if (tab !== "conversation") renderInsights(tab, context());
    if (rememberChange) remember(previous);
  }
  function context() {
    const snapshot = getSnapshot();
    return workspaceContext(snapshot, snapshot.activeConversationId, snapshot.selectedRunId);
  }
  function sync({ navigationToken } = {}) {
    const data = getSnapshot();
    if (!data.active || applying) return;
    if (pendingRoute?.navigationToken && !pendingRoute.navigationToken.isCurrent()) {
      view = pendingRoute.previousView;
      cancelRoute();
    }
    if (projectsReference !== data.projects) {
      projectsReference = data.projects;
      const projectSelect = doc.getElementById("workspace-project-filter");
      const previous = projectSelect.value;
      const option = (value, label) => { const node = doc.createElement("option"); node.value = value; node.textContent = label; return node; };
      projectSelect.replaceChildren(option("", "全部项目与私聊"), ...data.projects.map((project) => option(project.projectId, `${project.title}${project.archivedAt ? " (已归档)" : ""}`)));
      if (data.projects.some((project) => project.projectId === previous)) projectSelect.value = previous;
    }
    if (pendingRoute?.conversationId && data.selectionReady !== false && data.conversations.some((item) => item.id === pendingRoute.conversationId)) {
      const target = pendingRoute;
      pendingRoute = null;
      void activate(botWorkspaceRoute(target), { navigationToken: target.navigationToken }).then((accepted) => target.finish?.(accepted), (error) => { target.finish?.(false); onRouteError?.(error); });
      return;
    }
    syncDraft();
    const previous = route();
    view.conversationId = data.activeConversationId || "";
    view.runId = data.selectedRunId || "";
    const current = context();
    doc.getElementById("workspace-members-edit").hidden = current.conversation?.kind !== "workspace_group";
    root.classList.toggle("workspace-historical", current.historical);
    text("workspace-project", current.project?.title || (current.conversation?.kind === "direct" ? "成员私聊" : "工作台"));
    text("workspace-path", current.project?.canonicalCwd || "");
    doc.getElementById("workspace-path").title = current.project?.canonicalCwd || "";
    const currentStatus = current.currentRun?.status === "succeeded" ? "运行已结束" : current.currentRun ? runStatusText(current.currentRun.status, current.currentRun) : "尚未运行";
    text("workspace-current-state", currentStatus);
    text("workspace-history-notice", current.historical ? "正在查看历史运行；新消息仍发送到当前工作对话" : "");
    doc.getElementById("workspace-history-notice").hidden = !current.historical;
    const owner = current.currentRun?.executionOwnerId || current.conversation?.directMemberId || current.currentRun?.coordinatorId;
    text("workspace-responsibility", owner ? `执行责任：${data.memberLabel(owner)}` : current.conversation?.kind === "workspace_group" ? `团队协作 · ${current.conversation.memberIds.length} 位成员` : "");
    doc.getElementById("workspace-responsibility").hidden = !current.currentRun;
    const select = doc.getElementById("workspace-run-select");
    const ids = [...new Set([current.conversation?.activeRunId, ...(current.conversation?.runIds || [])].filter(Boolean))];
    const runSignature = JSON.stringify([current.conversation?.id, ids, view.runId]);
    if (select.dataset.signature !== runSignature) {
      select.dataset.signature = runSignature;
      const option = (value, label) => { const item = doc.createElement("option"); item.value = value; item.textContent = label; return item; };
      select.replaceChildren(option("", "当前运行"), ...ids.map((id) => option(id, `${data.resolveRun(id)?.title || "历史运行"} · ${id.slice(0, 8)}`)));
      select.value = view.runId;
    }
    select.disabled = !ids.length;
    const runtime = current.currentRun;
    const running = runtime && !["succeeded", "failed", "cancelled"].includes(runtime.status);
    const permissionSelect = doc.getElementById("workspace-next-permission");
    permissionSelect.disabled = Boolean(running || current.readOnly);
    permissionSelect.value = running
      ? (["plan", "review", "build"].includes(runtime.permissionMode) ? runtime.permissionMode : "build")
      : permissions.get(view.conversationId) || "plan";
    text("workspace-permission", runtime && !["succeeded", "failed", "cancelled"].includes(runtime.status)
      ? `本轮权限：${runtime.permissionMode === "plan" ? "只读规划" : runtime.permissionMode === "review" ? "只读深审" : "受控写入"}` : "新运行权限");
    const budgetSelect = doc.getElementById("workspace-next-budget");
    if (budgetSelect) {
      budgetSelect.disabled = Boolean(running || current.readOnly);
      const stored = budgets.get(view.conversationId) || DEFAULT_BUDGET;
      budgetSelect.value = BUDGET_OPTIONS.includes(stored) ? stored : DEFAULT_BUDGET;
      budgetSelect.title = `新运行单轮预算：$${budgetSelect.value}.00（social 协作必须有限，全局默认无限时用此值兜底）`;
    }
    const connection = connectionPresentation(data.connection);
    const connectionDetail = Object.values(connection).map((item) => item.label).join(" / ");
    text("workspace-connection", data.connection.apiState === "ok" ? "已连接" : data.connection.auth === "error" ? "未授权" : data.connection.service === "error" ? "已离线" : data.connection.data === "error" ? "加载失败" : "连接中");
    const badge = doc.getElementById("workspace-connection");
    badge.title = connectionDetail;
    badge.setAttribute("aria-label", connectionDetail);
    badge.dataset.tone = data.connection.apiState;
    const nextSignature = [view.tab, view.conversationId, view.runId, runtime?.updatedAt, current.selectedRun?.updatedAt, current.selectedRun?.status, current.selectedRun?.taskGraph?.revision].join("|");
    if (signature !== nextSignature && view.tab !== "conversation") renderInsights(view.tab, current);
    signature = nextSignature;
    if (!pendingRoute) remember(previous, navigationToken);
  }
  async function activate(hash = "#bot", { navigationToken } = {}) {
    if (navigationToken && !navigationToken.isCurrent()) return false;
    pendingRoute?.finish?.(false);
    pendingRoute = null;
    const generation = ++routeGeneration;
    const previousView = { ...view };
    const target = readBotWorkspaceRoute(hash);
    if (target && hash.includes("?")) view = target;
    const data = getSnapshot();
    if (!hash.includes("?")) view = { ...view, conversationId: data.activeConversationId || "", runId: data.selectedRunId || "" };
    if (navigationToken && data.indexReady === true && view.conversationId && !data.conversations.some((item) => item.id === view.conversationId)) { view = previousView; return false; }
    remember();
    pendingRoute = null;
    if (view.conversationId && (data.selectionReady === false || !data.conversations.some((item) => item.id === view.conversationId))) pendingRoute = { ...view, navigationToken, previousView };
    if (pendingRoute?.navigationToken) {
      applying = 0;
      return new Promise((finish) => { pendingRoute.finish = finish; });
    }
    applying = generation;
    try {
      if (view.conversationId && !pendingRoute) {
        saveDraft();
        let opened;
        // Only the synchronous selection belongs to this route. A later user
        // selection must invalidate it even while its Run is still loading.
        selectingFromRoute = true;
        try { opened = openConversation(view.conversationId); }
        finally { selectingFromRoute = false; }
        const accepted = await opened;
        if (generation !== routeGeneration || (navigationToken && !navigationToken.isCurrent())) return false;
        if (accepted === false) { view = previousView; remember(); return false; }
        beforeRunSelection();
        await openRun(view.conversationId, view.runId || "");
      }
    } catch (error) {
      if (generation === routeGeneration) { view = previousView; pendingRoute = null; remember(); }
      throw error;
    } finally { if (applying === generation) applying = 0; }
    if (generation !== routeGeneration || (navigationToken && !navigationToken.isCurrent())) return false;
    setTab(view.tab, { rememberChange: false });
    sync({ navigationToken });
    return true;
  }
  input.addEventListener("input", saveDraft);
  const filters = root.querySelector(".workspace-filter-menu");
  const closeFilters = (restoreFocus = false) => {
    if (!filters?.open) return;
    filters.open = false;
    if (restoreFocus) filters.querySelector("summary").focus();
  };
  filters?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeFilters(true); }
  });
  filters?.addEventListener("change", () => filters.classList.toggle("is-filtered", Boolean(doc.getElementById("workspace-project-filter").value) || !doc.getElementById("workspace-show-inactive").checked));
  doc.addEventListener("pointerdown", (event) => { if (filters && !filters.contains(event.target)) closeFilters(); });
  doc.getElementById("workspace-next-permission").addEventListener("change", (event) => {
    permissions.set(getSnapshot().activeConversationId, event.target.value === "build" || event.target.value === "review" ? event.target.value : "plan");
    if (permissions.size > 50) permissions.delete(permissions.keys().next().value);
  });
  doc.getElementById("workspace-next-budget")?.addEventListener("change", (event) => {
    const value = String(event.target.value || "").trim();
    budgets.set(getSnapshot().activeConversationId, BUDGET_OPTIONS.includes(value) ? value : DEFAULT_BUDGET);
    if (budgets.size > 50) budgets.delete(budgets.keys().next().value);
  });
  root.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-workspace-tab]");
    if (tab) setTab(tab.dataset.workspaceTab);
    const destination = event.target.closest("[data-workspace-view]");
    if (destination) onNavigate(destination.dataset.workspaceView);
    if (event.target.closest("[data-workspace-refresh]")) void onRefresh();
  });
  root.addEventListener("keydown", (event) => {
    const button = event.target.closest("[data-workspace-tab]");
    if (!button || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = TABS.indexOf(view.tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
    setTab(TABS[next]);
    doc.getElementById(`workspace-tab-${TABS[next]}`).focus();
  });
  doc.getElementById("workspace-run-select").addEventListener("change", async (event) => {
    cancelRoute();
    const generation = routeGeneration;
    beforeRunSelection();
    const previous = route();
    const conversationId = getSnapshot().activeConversationId;
    const runId = event.target.value;
    await openRun(conversationId, runId);
    if (generation !== routeGeneration || getSnapshot().activeConversationId !== conversationId) return;
    view.runId = runId;
    sync();
    remember(previous);
  });
  return {
    sync, render: sync, activate, deactivate: () => { saveDraft(); cancelRoute(); beforeRunSelection(); closeFilters(); }, getRoute: route, getContext: context, setTab, saveDraft,
    beforeSelection, afterSelection: syncDraft,
    adoptDraft(conversationId) {
      const value = input.value;
      drafts.save(inputOwner, "");
      inputOwner = conversationId;
      drafts.save(inputOwner, value);
    },
    consumeDraft(conversationId, submittedText) {
      if (drafts.read(conversationId) === submittedText) drafts.save(conversationId, "");
    },
  };
}
