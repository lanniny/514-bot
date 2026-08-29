import { LEGACY_ICON_MAP } from "./lucide.js";

const ACTIVE_TAB_KEY = "514cc-mission-control-tab";
const RELOAD_DELAY_MS = 320;
export const MISSION_SNAPSHOT_SCHEMA = "514cc.mission-control.snapshot/v3";
export const MISSION_SNAPSHOT_MAX_AGE_MS = 15_000;

function invalidSnapshot(message) {
  return Object.assign(new Error(message), { code: "MISSION_SNAPSHOT_INVALID" });
}

export function validateMissionSnapshot(value, expectedRunId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidSnapshot("Mission Control 返回的快照不是对象");
  }
  if (value.schema !== MISSION_SNAPSHOT_SCHEMA || value.schemaVersion !== 3) {
    throw invalidSnapshot("Mission Control 快照协议不受支持");
  }
  if (typeof value.runId !== "string" || value.runId !== String(expectedRunId ?? "")) {
    throw invalidSnapshot("Mission Control 快照不属于当前任务");
  }
  if (!/^mc-snapshot-[0-9a-f]{64}$/.test(String(value.snapshotId ?? ""))) {
    throw invalidSnapshot("Mission Control 快照缺少有效身份");
  }
  if (!value.task || typeof value.task !== "object" || Array.isArray(value.task)) {
    throw invalidSnapshot("Mission Control 快照缺少任务投影");
  }
  for (const key of ["attempts", "messageRoutes", "agents", "connections", "approvals", "artifacts"]) {
    if (!Array.isArray(value[key])) throw invalidSnapshot(`Mission Control 快照字段 ${key} 无效`);
  }
  if (!value.evidence || typeof value.evidence !== "object" || Array.isArray(value.evidence)) {
    throw invalidSnapshot("Mission Control 快照缺少证据投影");
  }
  return value;
}

export const MISSION_PANEL_REGISTRY = Object.freeze([
  Object.freeze({ id: "tasks", label: "任务", ownsSnapshot: true }),
  Object.freeze({ id: "artifacts", label: "产物", ownsSnapshot: true }),
  Object.freeze({ id: "evidence", label: "证据", ownsSnapshot: true }),
  Object.freeze({ id: "activity", label: "活动", ownsSnapshot: false }),
  Object.freeze({ id: "connections", label: "连接", ownsSnapshot: true }),
  // 工具标签：不订阅 run 快照，tab 条上的可见性由 ➕ 菜单与 × 控制（workbench-chrome.js）
  Object.freeze({ id: "terminal", label: "终端", ownsSnapshot: false }),
]);

function text(value, fallback = "--") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function statusLabel(value) {
  const labels = {
    active: "进行中",
    attention: "需关注",
    available: "可用",
    cancelled: "已取消",
    completed: "已完成",
    degraded: "证据不完整",
    empty: "暂无",
    failed: "失败",
    offline: "离线",
    online: "在线",
    queued: "排队中",
    recorded: "已记录",
    running: "运行中",
    succeeded: "已完成",
    unavailable: "不可用",
    unknown: "未知",
    waiting_agent: "等待 Agent",
    waiting_approval: "等待审批",
  };
  return labels[String(value ?? "").toLowerCase()] ?? text(value, "未知");
}

function clear(element) {
  element?.replaceChildren();
}

function node(tag, className, content = null) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content != null) element.textContent = String(content);
  return element;
}

function emptyState(message) {
  const element = node("div", "registry-empty", message);
  element.setAttribute("role", "status");
  return element;
}

function appendMeta(target, parts) {
  const meta = node("span", "registry-item-meta", parts.filter(Boolean).join(" · "));
  target.append(meta);
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KiB`;
  return `${(bytes / (1_024 ** 2)).toFixed(1)} MiB`;
}

function icon(name) {
  const lucideName = {
    chevron: "chevron-right",
    close: "x",
    file: "file-text",
    folder: "folder",
    "rotate-ccw": "rotate-ccw",
    save: "save",
  }[name] ?? name;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon lucide");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#lucide-${lucideName}`);
  svg.append(use);
  return svg;
}

export function createMissionControlDock({
  root,
  loadSnapshot,
  loadWorkspace,
  saveWorkspace,
  onArtifactAction,
  environmentPanel = null,
  loadIdleRoster = null, // 无选中 run 时注入异构 CLI 团队健康（514 特色空态）
  panelRegistry = MISSION_PANEL_REGISTRY,
  notify = () => {},
} = {}) {
  if (!root || typeof loadSnapshot !== "function") {
    return { selectRun() {}, refresh() {}, observeEvent() {}, destroy() {} };
  }

  const registeredPanels = panelRegistry
    .filter((item) => item && /^[a-z][a-z0-9-]{0,31}$/.test(String(item.id ?? "")))
    .filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index)
    .filter((item) => root.querySelector(`[data-registry-tab="${item.id}"]`) && root.querySelector(`[data-registry-panel="${item.id}"]`));
  const tabOrder = registeredPanels.map((item) => item.id);
  const tabs = registeredPanels.map((item) => root.querySelector(`[data-registry-tab="${item.id}"]`));
  const tabById = new Map(registeredPanels.map((item, index) => [item.id, tabs[index]]));
  const title = root.querySelector("#mission-dock-title");
  const status = root.querySelector("#mission-dock-status");
  const taskList = root.querySelector("#mission-task-list");
  const artifactList = root.querySelector("#mission-artifact-list");
  const evidenceGraph = root.querySelector("#mission-evidence-graph");
  const workspaceBrowser = root.querySelector("#mission-workspace-browser");
  const workspaceStatus = root.querySelector("#mission-workspace-status");
  const connectionSummary = root.querySelector("#mission-connection-summary");
  let activeTab = sessionStorage.getItem(ACTIVE_TAB_KEY);
  if (!tabOrder.includes(activeTab)) activeTab = tabOrder[0] ?? "tasks";
  let selectedRunId = null;
  let selectedVersion = null;
  let snapshot = null;
  let generation = 0;
  let controller = null;
  let workspaceController = null;
  let workspaceGeneration = 0;
  let workspaceSaveController = null;
  let workspaceSaveGeneration = 0;
  let workspacePath = null;
  let workspaceFileView = null;
  let workspaceInvokerArtifactId = null;
  let reloadTimer = 0;
  let snapshotRefreshTimer = 0;
  let snapshotFetchedAt = 0;

  function invalidateWorkspaceSave() {
    workspaceSaveGeneration += 1;
    workspaceSaveController?.abort();
    workspaceSaveController = null;
  }

  function ownsWorkspaceSave(snapshot, generation, controller) {
    return !controller.signal.aborted
      && generation === workspaceSaveGeneration
      && selectedRunId === snapshot.runId
      && workspaceFileView === snapshot
      && workspacePath === snapshot.path;
  }

  function clearSnapshotRefresh() {
    window.clearTimeout(snapshotRefreshTimer);
    snapshotRefreshTimer = 0;
  }

  function scheduleSnapshotRefresh() {
    clearSnapshotRefresh();
    if (!selectedRunId) return;
    snapshotRefreshTimer = window.setTimeout(() => {
      snapshotRefreshTimer = 0;
      if (selectedRunId) void fetchSelected({ force: true });
    }, MISSION_SNAPSHOT_MAX_AGE_MS);
  }

  function activateTab(name, { focus = false } = {}) {
    if (!tabOrder.includes(name)) return;
    activeTab = name;
    sessionStorage.setItem(ACTIVE_TAB_KEY, name);
    for (const tab of tabs) {
      const selected = tab.dataset.registryTab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.classList.toggle("is-active", selected);
      if (selected && focus) tab.focus();
    }
    for (const panel of root.querySelectorAll("[data-registry-panel]")) {
      panel.hidden = panel.dataset.registryPanel !== name;
    }
  }

  function renderTasks(value) {
    clear(taskList);
    if (!value?.task) {
      taskList?.append(emptyState("选择任务后显示执行树"));
      return;
    }
    const rootTask = node("article", "registry-task is-root");
    rootTask.append(node("span", "registry-item-kicker", "根任务"));
    rootTask.append(node("strong", "registry-item-title", value.task.title));
    appendMeta(rootTask, [
      statusLabel(value.task.status),
      `${value.task.progress?.round ?? 0}/${value.task.progress?.maxRounds ?? 0} 轮`,
      value.task.permissionMode,
      value.task.taskType,
    ]);
    if (value.task.coordinatorId || value.task.executionOwnerId || value.task.startAgentId) {
      appendMeta(rootTask, [
        value.task.coordinatorId ? `主脑 ${value.task.coordinatorId}` : null,
        value.task.executionOwnerId || value.task.startAgentId
          ? `直接收件人 / 写入所有者 ${value.task.executionOwnerId || value.task.startAgentId}`
          : null,
      ]);
    }
    taskList.append(rootTask);

    // 优先 tasks[] 子任务投影（attempt 派生）；回落 attempts
    const childTasks = Array.isArray(value.tasks)
      ? value.tasks.filter((item) => item?.parentTaskId || item?.kind === "attempt")
      : [];
    if (childTasks.length) {
      const heading = node("div", "registry-group-heading");
      heading.append(node("span", "registry-item-kicker", "子任务"), node("span", "registry-count", String(childTasks.length)));
      taskList.append(heading);
      for (const child of childTasks.slice(-12).reverse()) {
        const item = node("article", `registry-task is-${text(child.status, "recorded")}`);
        item.append(node("strong", "registry-item-title", text(child.title, "子任务")));
        appendMeta(item, [
          statusLabel(child.status),
          child.assigneeId,
          child.updatedAt ? formatTime(child.updatedAt) : null,
        ]);
        taskList.append(item);
      }
    } else {
      const recentAttempts = Array.isArray(value.attempts) ? value.attempts.slice(-10).reverse() : [];
      if (recentAttempts.length) {
        const heading = node("div", "registry-group-heading");
        heading.append(node("span", "registry-item-kicker", "轮次尝试"), node("span", "registry-count", String(value.attempts.length)));
        taskList.append(heading);
        for (const attempt of recentAttempts) {
          const item = node("article", `registry-task is-${text(attempt.state, "recorded")}`);
          item.append(node("strong", "registry-item-title", `${text(attempt.agentId, "Agent")} · 第 ${attempt.round ?? 0} 轮`));
          appendMeta(item, [statusLabel(attempt.phase), attempt.protocol, attempt.updatedAt ? formatTime(attempt.updatedAt) : null]);
          taskList.append(item);
        }
      }
    }

    // 优先 typed delegations；回落 messageRoutes
    const delegations = Array.isArray(value.delegations) && value.delegations.length
      ? value.delegations
      : Array.isArray(value.messageRoutes) ? value.messageRoutes : [];
    const recentRoutes = delegations.slice(-10).reverse();
    if (recentRoutes.length) {
      const heading = node("div", "registry-group-heading");
      heading.append(node("span", "registry-item-kicker", "有向委派"), node("span", "registry-count", String(delegations.length)));
      taskList.append(heading);
      for (const route of recentRoutes) {
        const from = route.fromAgentId || route.from;
        const to = route.toAgentId || route.to;
        const item = node("article", "registry-delegation");
        item.dataset.routeState = text(route.state, "routed");
        item.append(node("span", "registry-flow", `${text(from)} → ${text(to)}`));
        appendMeta(item, [route.kind, route.source || "message-route", route.timestamp ? formatTime(route.timestamp) : null]);
        taskList.append(item);
      }
    }
  }

  function renderArtifacts(value) {
    clear(artifactList);
    const artifacts = Array.isArray(value?.artifacts) ? value.artifacts : [];
    if (!artifacts.length) {
      artifactList?.append(emptyState("当前任务尚无可登记产物"));
      return;
    }
    for (const artifact of artifacts) {
      const item = node("article", `registry-artifact is-${text(artifact.availability, "unavailable")}`);
      const heading = node("div", "registry-artifact-heading");
      heading.append(node("strong", "registry-item-title", artifact.label));
      heading.append(node("span", "registry-availability", statusLabel(artifact.availability)));
      item.append(heading);
      const detail = [
        artifact.count == null ? artifact.kind : `${artifact.count} 条已登记`,
        artifact.digest ? `digest ${artifact.digest}` : "",
        artifact.verifyCommand || "",
        artifact.published === false && (artifact.kind === "handoff" || artifact.kind === "delta") ? "未宣称已发布" : "",
      ].filter(Boolean).join(" · ");
      appendMeta(item, [detail]);
      if (artifact.kind === "diff" && artifact.availability === "available") {
        const action = node("button", "registry-action", "查看 Diff");
        action.type = "button";
        action.dataset.missionArtifactAction = artifact.kind;
        action.dataset.artifactId = artifact.id;
        item.append(action);
      }
      if (artifact.kind === "workspace" && artifact.availability === "available") {
        const action = node("button", "registry-action", "浏览文件");
        action.type = "button";
        action.dataset.missionWorkspaceOpen = "";
        action.dataset.artifactId = artifact.id;
        item.append(action);
      }
      artifactList.append(item);
    }
  }

  function renderEvidence(value) {
    clear(evidenceGraph);
    const evidence = value?.evidence;
    const graph = evidence?.graph;
    if (!graph?.nodes?.length) {
      evidenceGraph?.append(emptyState("当前任务尚无可追溯证据"));
      return;
    }

    if (evidence.status === "degraded") {
      const warning = node("p", "registry-bound-note is-attention", "审计证据不完整：部分记录无法读取或解析，请先检查活动记录与诊断日志。");
      warning.setAttribute("role", "alert");
      evidenceGraph.append(warning);
    }

    const scoreboard = node("div", "evidence-scoreboard");
    for (const [label, count] of [
      ["事件", evidence.eventCount],
      ["轮次", evidence.completedAttempts],
      ["关系", graph.edges?.length],
    ]) {
      const metric = node("div", "evidence-metric");
      metric.append(node("strong", "", Number(count) || 0), node("span", "", label));
      scoreboard.append(metric);
    }
    evidenceGraph.append(scoreboard);

    const types = Array.isArray(evidence.types) ? evidence.types : [];
    if (types.length) {
      const typeGroup = node("section", "evidence-type-group");
      typeGroup.append(node("span", "registry-item-kicker", "证据类型"));
      const cloud = node("div", "evidence-type-cloud");
      for (const item of types.slice(0, 8)) cloud.append(node("span", "evidence-type", `${item.type} · ${item.count}`));
      typeGroup.append(cloud);
      evidenceGraph.append(typeGroup);
    }

    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    const degrees = new Map();
    for (const edge of edges) {
      const currentFrom = degrees.get(edge.from) ?? { incoming: 0, outgoing: 0 };
      currentFrom.outgoing += 1;
      degrees.set(edge.from, currentFrom);
      const currentTo = degrees.get(edge.to) ?? { incoming: 0, outgoing: 0 };
      currentTo.incoming += 1;
      degrees.set(edge.to, currentTo);
    }
    const rootNode = graph.nodes.find((item) => item.id === graph.rootId);
    const recentNodes = graph.nodes.filter((item) => item.id !== graph.rootId).slice(-18).reverse();
    const chain = node("div", "evidence-chain");
    for (const item of [rootNode, ...recentNodes].filter(Boolean)) {
      const degree = degrees.get(item.id) ?? { incoming: 0, outgoing: 0 };
      const card = node("article", `evidence-node is-${text(item.state, "recorded")}`);
      card.dataset.evidenceKind = text(item.kind, "evidence");
      if (item.agentId) card.dataset.agentId = String(item.agentId);
      if (item.attemptId || item.id) card.dataset.attemptId = String(item.attemptId || item.id);
      if (item.timestamp) card.dataset.timestamp = String(item.timestamp);
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.title = "点击定位到会话流相关轮次";
      card.append(node("span", "evidence-node-kind", text(item.kind, "evidence")));
      card.append(node("strong", "registry-item-title", item.label));
      appendMeta(card, [
        statusLabel(item.state),
        item.agentId,
        `${degree.incoming} 入 / ${degree.outgoing} 出`,
        item.timestamp ? formatTime(item.timestamp) : null,
      ]);
      card.addEventListener("click", () => {
        const stream = document.getElementById("conversation-stream");
        if (!stream) return;
        let target = null;
        if (item.agentId) {
          target = stream.querySelector(`.message-row.is-agent-${CSS.escape(String(item.agentId).toLowerCase().replace(/[^a-z0-9-]/g, ""))}`);
        }
        if (!target) target = stream.querySelector(".message-row:last-of-type");
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
        target?.classList.add("is-evidence-focus");
        window.setTimeout(() => target?.classList.remove("is-evidence-focus"), 1600);
      });
      chain.append(card);
    }
    evidenceGraph.append(chain);
    if (graph.truncated?.nodes || graph.truncated?.edges) {
      evidenceGraph.append(node("p", "registry-bound-note", "证据图已按安全预算截断，原始事件仍保留在活动记录中。"));
    }
  }

  function announceWorkspace(message) {
    if (workspaceStatus) workspaceStatus.textContent = String(message ?? "");
  }

  function hideWorkspace({ restoreFocus = false } = {}) {
    workspaceController?.abort();
    invalidateWorkspaceSave();
    workspaceGeneration += 1;
    workspacePath = null;
    workspaceFileView = null;
    clear(workspaceBrowser);
    if (workspaceBrowser) workspaceBrowser.hidden = true;
    announceWorkspace("文件浏览已关闭");
    if (restoreFocus) {
      const openers = [...root.querySelectorAll("[data-mission-workspace-open]")];
      const invoker = openers.find((item) => item.dataset.artifactId === workspaceInvokerArtifactId) ?? openers[0];
      invoker?.focus();
    }
    workspaceInvokerArtifactId = null;
  }

  function renderWorkspaceLoading(path) {
    clear(workspaceBrowser);
    if (!workspaceBrowser) return;
    workspaceBrowser.hidden = false;
    workspaceBrowser.setAttribute("aria-busy", "true");
    announceWorkspace(`正在读取${path ? ` ${path}` : "项目根目录"}`);
    const heading = node("div", "workspace-browser-toolbar");
    heading.append(node("strong", "", path || "项目根目录"));
    workspaceBrowser.append(heading, emptyState("正在读取受控项目目录…"));
  }

  function workspaceToolbar(value) {
    const toolbar = node("div", "workspace-browser-toolbar");
    const location = node("div", "workspace-browser-location");
    location.append(icon(value.type === "directory" ? "folder" : "file"));
    location.append(node("strong", "", value.path || (value.rootKind === "worktree" ? "隔离工作树" : "项目根目录")));
    toolbar.append(location);
    const actions = node("div", "workspace-browser-actions");
    if (value.parent != null) {
      const up = node("button", "icon-button workspace-browser-up");
      up.type = "button";
      up.title = "返回上一级";
      up.setAttribute("aria-label", "返回上一级");
      up.dataset.workspaceParent = value.parent;
      const chevron = icon("chevron");
      chevron.classList.add("is-back");
      up.append(chevron);
      actions.append(up);
    }
    const close = node("button", "icon-button");
    close.type = "button";
    close.title = "关闭文件浏览";
    close.setAttribute("aria-label", "关闭文件浏览");
    close.dataset.workspaceClose = "true";
    close.append(icon("close"));
    actions.append(close);
    toolbar.append(actions);
    return toolbar;
  }

  function renderWorkspace(value) {
    clear(workspaceBrowser);
    if (!workspaceBrowser) return;
    workspaceFileView = null;
    workspaceBrowser.hidden = false;
    workspaceBrowser.setAttribute("aria-busy", "false");
    announceWorkspace(value.type === "directory"
      ? `${value.path || "项目根目录"}已加载，共 ${value.entries?.length ?? 0} 项`
      : `${value.path || "文件"}预览已加载`);
    workspaceBrowser.append(workspaceToolbar(value));
    if (value.type === "directory") {
      const list = node("div", "workspace-entry-list");
      for (const entry of value.entries ?? []) {
        const button = node("button", "workspace-entry");
        button.type = "button";
        button.disabled = entry.openable !== true;
        button.dataset.workspacePath = entry.path;
        button.dataset.entryType = entry.type;
        button.title = entry.openable ? entry.path : `${entry.name} 不可在受控预览中打开`;
        button.append(icon(entry.type === "directory" ? "folder" : "file"));
        button.append(node("span", "workspace-entry-name", entry.name));
        if (!entry.openable) button.append(node("span", "workspace-entry-kind", entry.type));
        list.append(button);
      }
      if (!list.childElementCount) list.append(emptyState("目录为空"));
      workspaceBrowser.append(list);
      if (value.truncated) workspaceBrowser.append(node("p", "registry-bound-note", `仅显示前 ${value.bounds?.entries ?? "有限"} 项。`));
      return;
    }

    const file = value.file ?? {};
    const meta = node("div", "workspace-file-meta");
    meta.append(node("span", "", formatBytes(file.size)), node("span", "", file.language || "text"));
    if (file.redacted) meta.append(node("span", "is-attention", "敏感内容已脱敏"));
    if (file.truncated) meta.append(node("span", "is-attention", "预览已截断"));
    workspaceBrowser.append(meta);
    if (file.binary) {
      workspaceBrowser.append(emptyState("二进制文件仅显示元数据，不在控制面内解码。"));
      return;
    }
    const editable = file.editable === true
      && !file.redacted
      && !file.truncated
      && Boolean(file.revision)
      && typeof saveWorkspace === "function";
    if (editable) {
      workspaceFileView = {
        runId: selectedRunId,
        path: String(value.path ?? ""),
        baseline: String(file.content ?? ""),
        revision: file.revision,
      };
      const editorHead = node("div", "workspace-file-editor-head");
      const status = node("span", "workspace-file-editor-status", "已同步");
      status.id = "mission-workspace-editor-status";
      const actions = node("div", "workspace-browser-actions");
      const revert = node("button", "icon-button");
      revert.id = "mission-workspace-revert";
      revert.type = "button";
      revert.disabled = true;
      revert.title = "还原未保存修改";
      revert.setAttribute("aria-label", "还原未保存修改");
      revert.append(icon("rotate-ccw"));
      const save = node("button", "workspace-file-save");
      save.id = "mission-workspace-save";
      save.type = "button";
      save.disabled = true;
      save.append(icon("save"), node("span", "", "保存"));
      actions.append(revert, save);
      editorHead.append(status, actions);
      const editor = node("textarea", "workspace-file-editor");
      editor.id = "mission-workspace-editor";
      editor.value = workspaceFileView.baseline;
      editor.spellcheck = false;
      editor.setAttribute("aria-label", `编辑 ${value.path || "文件"}`);
      workspaceBrowser.append(editorHead, editor);
      return;
    }
    const preview = node("pre", "workspace-file-preview");
    preview.tabIndex = 0;
    preview.append(node("code", `language-${text(file.language, "text")}`, file.content ?? ""));
    workspaceBrowser.append(preview);
  }

  function updateWorkspaceEditorState() {
    const editor = root.querySelector("#mission-workspace-editor");
    if (!workspaceFileView || !editor) return;
    const dirty = editor.value !== workspaceFileView.baseline;
    const status = root.querySelector("#mission-workspace-editor-status");
    const save = root.querySelector("#mission-workspace-save");
    const revert = root.querySelector("#mission-workspace-revert");
    if (status) {
      status.textContent = dirty ? "未保存" : "已同步";
      status.classList.toggle("is-dirty", dirty);
    }
    if (save) save.disabled = !dirty;
    if (revert) revert.disabled = !dirty;
  }

  async function saveWorkspaceFile() {
    const editor = root.querySelector("#mission-workspace-editor");
    const snapshot = workspaceFileView;
    if (!snapshot || !editor || snapshot.runId !== selectedRunId || typeof saveWorkspace !== "function") return;
    const content = editor.value;
    if (content === snapshot.baseline) return;

    const generation = ++workspaceSaveGeneration;
    workspaceSaveController?.abort();
    const ownedController = new AbortController();
    workspaceSaveController = ownedController;
    const status = root.querySelector("#mission-workspace-editor-status");
    const save = root.querySelector("#mission-workspace-save");
    const revert = root.querySelector("#mission-workspace-revert");
    if (status) status.textContent = "正在保存";
    if (save) save.disabled = true;
    if (revert) revert.disabled = true;
    try {
      const value = await saveWorkspace(
        snapshot.runId,
        snapshot.path,
        { content, expectedRevision: snapshot.revision },
        ownedController.signal,
      );
      if (!ownsWorkspaceSave(snapshot, generation, ownedController)) return;
      renderWorkspace(value);
      notify(`已保存 ${snapshot.path}`, "success");
    } catch (error) {
      if (!ownsWorkspaceSave(snapshot, generation, ownedController)) return;
      if (status) {
        status.textContent = error?.code === "WORKSPACE_VERSION_CONFLICT" ? "磁盘已变化 · 请重新载入" : "保存失败";
        status.classList.add("is-dirty");
      }
      if (save) save.disabled = false;
      if (revert) revert.disabled = false;
      notify(error?.message || "文件保存失败", "error");
    } finally {
      if (workspaceSaveController === ownedController) workspaceSaveController = null;
    }
  }

  function renderWorkspaceError(error) {
    clear(workspaceBrowser);
    if (!workspaceBrowser) return;
    workspaceBrowser.hidden = false;
    workspaceBrowser.setAttribute("aria-busy", "false");
    announceWorkspace(`文件预览不可用：${text(error?.message, "未知错误")}`);
    const toolbar = node("div", "workspace-browser-toolbar");
    toolbar.append(node("strong", "", "项目文件"));
    const close = node("button", "icon-button");
    close.type = "button";
    close.title = "关闭文件浏览";
    close.setAttribute("aria-label", "关闭文件浏览");
    close.dataset.workspaceClose = "true";
    close.append(icon("close"));
    toolbar.append(close);
    workspaceBrowser.append(toolbar, emptyState(`文件预览不可用：${text(error?.message, "未知错误")}`));
  }

  async function fetchWorkspace(path = "") {
    if (!selectedRunId || typeof loadWorkspace !== "function") return;
    const requestedPath = String(path ?? "");
    if (workspaceFileView?.path !== requestedPath) {
      invalidateWorkspaceSave();
      workspaceFileView = null;
    }
    workspaceController?.abort();
    const ownedGeneration = ++workspaceGeneration;
    const ownedRunId = selectedRunId;
    workspacePath = requestedPath;
    workspaceController = new AbortController();
    renderWorkspaceLoading(workspacePath);
    try {
      const value = await loadWorkspace(ownedRunId, workspacePath, workspaceController.signal);
      if (workspaceController.signal.aborted || ownedGeneration !== workspaceGeneration || selectedRunId !== ownedRunId) return;
      workspacePath = value.path ?? "";
      renderWorkspace(value);
    } catch (error) {
      if (workspaceController.signal.aborted || ownedGeneration !== workspaceGeneration || selectedRunId !== ownedRunId) return;
      renderWorkspaceError(error);
    }
  }

  function renderConnections(value) {
    clear(connectionSummary);
    const connections = Array.isArray(value?.connections) ? value.connections : [];
    const agents = Array.isArray(value?.agents) ? value.agents : [];
    if (!value) {
      connectionSummary?.append(emptyState("选择任务后显示异构 CLI 连接与成员健康"));
      return;
    }
    const online = connections.filter((item) => item.available).length;
    const strip = node("div", "registry-connection-strip");
    strip.append(node("strong", "", `${online}/${connections.length || agents.length} 在线`));
    strip.append(node("span", "", `${agents.length} 位成员`));
    if (value.approvals?.length) strip.append(node("span", "", `${value.evidence?.pendingApprovals ?? 0} 项待审批`));
    if (value.task?.orchestrationMode) strip.append(node("span", "", value.task.orchestrationMode));
    connectionSummary.append(strip);

    // 每成员一行：角色 + 会话 + 健康——多 CLI 团队特色入口
    const byAgent = new Map(connections.map((item) => [item.agentId, item]));
    const roster = agents.length
      ? agents
      : connections.map((item) => ({
          agentId: item.agentId,
          role: "member",
          status: item.status,
          available: item.available,
          hasSession: false,
        }));
    if (!roster.length) {
      connectionSummary.append(emptyState("当前任务尚未登记团队成员"));
      return;
    }
    const list = node("div", "registry-connection-list");
    for (const agent of roster) {
      const conn = byAgent.get(agent.agentId);
      const row = node("article", `registry-connection-row is-${text(conn?.status || agent.status, "unknown")}`);
      row.append(node("strong", "registry-item-title", text(agent.agentId, "agent")));
      appendMeta(row, [
        agent.role,
        statusLabel(conn?.status || agent.status),
        agent.hasSession ? "原生会话" : "无会话",
        conn?.latencyMs != null ? `${conn.latencyMs}ms` : null,
      ]);
      list.append(row);
    }
    connectionSummary.append(list);
  }

  /* tab 状态徽标（LiveAgent RightDockTabStrip 同款：label + 状态点/计数）——
     tasks 根任务运行/关注态点；artifacts 登记计数；evidence 降级/待审批关注点；
     connections 在线计数。无快照（loading/empty/error）时如实清空。 */
  function setTabBadge(id, kind, tone = null, textValue = "", title = "") {
    const tab = tabById.get(id);
    if (!tab) return;
    tab.querySelectorAll(".registry-tab-dot, .registry-tab-count").forEach((el) => el.remove());
    if (!kind) return;
    const badge = node("span", kind === "dot" ? `registry-tab-dot is-${tone}` : "registry-tab-count", kind === "count" ? textValue : null);
    if (title) badge.title = title;
    tab.append(badge);
  }

  function renderTabBadges(value) {
    const taskStatus = String(value?.task?.status ?? "").toLowerCase();
    const taskTone = value?.task?.auditDegraded || ["failed", "attention", "waiting_approval", "recovery_required", "cancelled"].includes(taskStatus)
      ? "attention"
      : ["running", "active", "queued", "waiting_agent"].includes(taskStatus)
        ? "running"
        : null;
    setTabBadge("tasks", taskTone ? "dot" : null, taskTone, "", taskTone === "attention" ? `任务需关注（${statusLabel(taskStatus)}）` : "任务进行中");
    const artifactCount = Array.isArray(value?.artifacts) ? value.artifacts.length : 0;
    setTabBadge("artifacts", artifactCount ? "count" : null, null, String(artifactCount), `${artifactCount} 条已登记产物`);
    const pendingApprovals = Number(value?.evidence?.pendingApprovals) || 0;
    const evidenceDegraded = value?.evidence?.status === "degraded" || pendingApprovals > 0;
    setTabBadge("evidence", evidenceDegraded ? "dot" : null, "attention", "", pendingApprovals ? `${pendingApprovals} 项待审批` : "证据不完整");
    const connections = Array.isArray(value?.connections) ? value.connections : [];
    const online = connections.filter((item) => item.available).length;
    setTabBadge("connections", connections.length ? "count" : null, null, `${online}/${connections.length}`, `${online}/${connections.length} 在线`);
  }

  function render(value) {
    snapshot = value;
    root.setAttribute("aria-busy", "false");
    root.dataset.state = "ready";
    title.textContent = value?.task?.title ?? "任务投影";
    status.textContent = statusLabel(value?.task?.status);
    status.dataset.tone = value?.task?.auditDegraded ? "attention" : value?.task?.status ?? "neutral";
    renderTasks(value);
    renderArtifacts(value);
    renderEvidence(value);
    renderConnections(value);
    renderTabBadges(value);
  }

  function renderLoading() {
    root.setAttribute("aria-busy", "true");
    root.dataset.state = "loading";
    title.textContent = "正在建立任务投影";
    status.textContent = "同步中";
    clear(taskList);
    clear(artifactList);
    clear(evidenceGraph);
    clear(connectionSummary);
    taskList?.append(emptyState("读取任务、消息路由与证据…"));
    artifactList?.append(emptyState("核对产物可用性…"));
    evidenceGraph?.append(emptyState("构建证据关系…"));
    connectionSummary?.append(emptyState("核对连接状态…"));
    renderTabBadges(null);
  }

  function renderIdleRoster() {
    clear(connectionSummary);
    let roster = null;
    try {
      roster = typeof loadIdleRoster === "function" ? loadIdleRoster() : null;
    } catch {
      roster = null;
    }
    const members = Array.isArray(roster?.members) ? roster.members : [];
    if (!members.length) {
      const tip = emptyState("异构 CLI 团队待命：Claude · Codex · Grok · Kimi · Pi — 发起任务后这里显示连接健康");
      tip.classList.add("is-team-tip");
      connectionSummary?.append(tip);
      return;
    }
    const strip = node("div", "registry-connection-strip");
    strip.append(node("strong", "", roster?.teamName || "当前团队"));
    strip.append(node("span", "", `${members.length} 席待命`));
    if (roster?.coordinatorId) strip.append(node("span", "", `leader ${roster.coordinatorId}`));
    connectionSummary?.append(strip);
    const list = node("div", "registry-connection-list");
    for (const member of members) {
      const row = node("article", `registry-connection-row is-${text(member.status, "unknown")}`);
      row.append(node("strong", "registry-item-title", text(member.label || member.id, "agent")));
      appendMeta(row, [
        member.role,
        statusLabel(member.status),
        member.cli || null,
        member.detail || null,
      ]);
      list.append(row);
    }
    connectionSummary?.append(list);
  }

  function renderEmpty() {
    snapshot = null;
    snapshotFetchedAt = 0;
    clearSnapshotRefresh();
    root.setAttribute("aria-busy", "false");
    root.dataset.state = "empty";
    title.textContent = "任务投影";
    status.textContent = "未选择";
    clear(taskList);
    clear(artifactList);
    clear(evidenceGraph);
    clear(connectionSummary);
    hideWorkspace();
    taskList?.append(emptyState("选择会话后显示根任务、子任务与有向委派"));
    artifactList?.append(emptyState("选择会话后核对工作树 / Diff / 总线产物"));
    evidenceGraph?.append(emptyState("选择会话后显示 Evidence Graph"));
    renderTabBadges(null);
    renderIdleRoster();
  }

  function renderError(error) {
    snapshot = null;
    snapshotFetchedAt = 0;
    root.setAttribute("aria-busy", "false");
    root.dataset.state = "error";
    status.textContent = "读取失败";
    clear(taskList);
    clear(artifactList);
    clear(evidenceGraph);
    clear(connectionSummary);
    taskList?.append(emptyState(`任务投影不可用：${text(error?.message, "未知错误")}`));
    artifactList?.append(emptyState("产物投影暂不可用"));
    evidenceGraph?.append(emptyState("证据图谱暂不可用"));
    connectionSummary?.append(emptyState("连接投影暂不可用"));
    renderTabBadges(null);
  }

  async function fetchSelected({ force = false } = {}) {
    if (!selectedRunId) return renderEmpty();
    if (!force
      && snapshot?.runId === selectedRunId
      && Date.now() - snapshotFetchedAt < MISSION_SNAPSHOT_MAX_AGE_MS) return;
    controller?.abort();
    const ownedGeneration = ++generation;
    const ownedRunId = selectedRunId;
    controller = new AbortController();
    renderLoading();
    try {
      const value = validateMissionSnapshot(
        await loadSnapshot(ownedRunId, controller.signal),
        ownedRunId,
      );
      if (controller.signal.aborted || ownedGeneration !== generation || selectedRunId !== ownedRunId) return;
      snapshotFetchedAt = Date.now();
      render(value);
      scheduleSnapshotRefresh();
    } catch (error) {
      if (controller.signal.aborted || ownedGeneration !== generation || selectedRunId !== ownedRunId) return;
      renderError(error);
      scheduleSnapshotRefresh();
    }
  }

  function selectRun(runId, version = null, environmentRunId = runId) {
    const nextRunId = runId ? String(runId) : null;
    const nextVersion = version == null ? null : String(version);
    const runChanged = selectedRunId !== nextRunId;
    const changed = selectedRunId !== nextRunId || selectedVersion !== nextVersion;
    if (runChanged) {
      hideWorkspace();
      clearSnapshotRefresh();
      snapshotFetchedAt = 0;
    }
    selectedRunId = nextRunId;
    selectedVersion = nextVersion;
    environmentPanel?.selectRun?.(environmentRunId ? String(environmentRunId) : null);
    if (!selectedRunId) {
      controller?.abort();
      generation += 1;
      renderEmpty();
      return;
    }
    if (changed) void fetchSelected({ force: true });
  }

  function refresh() {
    environmentPanel?.refresh?.();
    if (selectedRunId) void fetchSelected({ force: true });
    else renderIdleRoster();
  }

  function observeEvent(event) {
    environmentPanel?.observeEvent?.(event);
    if (!selectedRunId || event?.runId !== selectedRunId) return;
    if (!/^(?:agent\.|approval\.|bus\.|run\.|task\.)/.test(String(event.type ?? ""))) return;
    window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(refresh, RELOAD_DELAY_MS);
  }

  root.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-registry-tab]");
    if (tab) activateTab(tab.dataset.registryTab, { focus: false });
    if (event.target.closest("#mission-workspace-save")) {
      event.preventDefault();
      void saveWorkspaceFile();
      return;
    }
    if (event.target.closest("#mission-workspace-revert")) {
      event.preventDefault();
      const editor = root.querySelector("#mission-workspace-editor");
      if (workspaceFileView && editor) {
        editor.value = workspaceFileView.baseline;
        updateWorkspaceEditorState();
        editor.focus();
      }
      return;
    }
    const workspaceEntry = event.target.closest("[data-workspace-path]");
    if (workspaceEntry && !workspaceEntry.disabled) {
      void fetchWorkspace(workspaceEntry.dataset.workspacePath ?? "");
      return;
    }
    const workspaceParent = event.target.closest("[data-workspace-parent]");
    if (workspaceParent) {
      void fetchWorkspace(workspaceParent.dataset.workspaceParent ?? "");
      return;
    }
    if (event.target.closest("[data-workspace-close]")) {
      hideWorkspace({ restoreFocus: true });
      return;
    }
    const workspaceOpen = event.target.closest("[data-mission-workspace-open]");
    if (workspaceOpen) {
      workspaceInvokerArtifactId = workspaceOpen.dataset.artifactId || null;
      void fetchWorkspace("");
      return;
    }
    const action = event.target.closest("[data-mission-artifact-action]");
    if (!action || !snapshot) return;
    const artifact = snapshot.artifacts?.find((item) => item.id === action.dataset.artifactId);
    if (artifact) onArtifactAction?.(artifact, snapshot);
  });
  root.addEventListener("input", (event) => {
    if (event.target.closest("#mission-workspace-editor")) updateWorkspaceEditorState();
  });
  root.addEventListener("keydown", (event) => {
    if (
      event.target.closest("#mission-workspace-editor")
      && (event.ctrlKey || event.metaKey)
      && !event.altKey
      && !event.shiftKey
      && event.key.toLowerCase() === "s"
    ) {
      event.preventDefault();
      void saveWorkspaceFile();
      return;
    }
    const tab = event.target.closest("[data-registry-tab]");
    if (!tab) return;
    const current = tabOrder.indexOf(tab.dataset.registryTab);
    let next = null;
    if (current < 0) return;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = tabOrder[(current + 1) % tabOrder.length];
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = tabOrder[(current - 1 + tabOrder.length) % tabOrder.length];
    if (event.key === "Home") next = tabOrder[0];
    if (event.key === "End") next = tabOrder.at(-1);
    if (!next) return;
    event.preventDefault();
    activateTab(next, { focus: true });
  });

  activateTab(activeTab);
  renderEmpty();

  return {
    selectRun,
    refresh,
    refreshIdle: () => {
      if (!selectedRunId) renderIdleRoster();
    },
    activateTab: (name) => activateTab(name, { focus: false }),
    openWorkspace: () => {
      if (!selectedRunId) return false;
      activateTab("artifacts", { focus: false });
      workspaceInvokerArtifactId = snapshot?.artifacts?.find((item) => item.kind === "workspace")?.id ?? null;
      void fetchWorkspace("");
      return true;
    },
    observeEvent,
    destroy() {
      controller?.abort();
      workspaceController?.abort();
      invalidateWorkspaceSave();
      window.clearTimeout(reloadTimer);
      clearSnapshotRefresh();
      environmentPanel?.destroy?.();
    },
  };
}
