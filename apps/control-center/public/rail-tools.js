/**
 * rail-tools.js — 右栏工具标签栏（LO 2026-08-08 参考图波）。
 *
 * 右栏不再是「环境舱 + 五页常驻」，而是一条可关闭的工具标签：
 *   任务上下文（环境舱 + 任务/产物/证据/活动/连接）· 审阅 · 浏览器 · 文件
 * 终端占右栏标签（与顶栏 Ctrl+` 底部抽屉分开）；侧边对话仍转发为浮层。
 * 标签全部关闭时露出工具选择列表（参考图空态），而不是一片灰白。
 *
 * 契约：零 emoji；lucide sprite 引用；标签顺序与激活态持久化；容器缺失时静默降级。
 */

const OPEN_KEY = "514cc-rail-tools-open";
const ACTIVE_KEY = "514cc-rail-tools-active";

// external=true 的工具不产生标签，只把动作转发出去
export const RAIL_TOOLS = Object.freeze([
  Object.freeze({ id: "mission", menuLabel: "任务上下文", tabLabel: "任务上下文", icon: "layout-dashboard", shortcut: "" }),
  Object.freeze({ id: "review", menuLabel: "审阅", tabLabel: "审阅", icon: "clipboard-list", shortcut: "Ctrl+Shift+G" }),
  Object.freeze({ id: "terminal", menuLabel: "终端", tabLabel: "侧栏终端", icon: "square-terminal", shortcut: "Ctrl+Alt+T" }),
  Object.freeze({ id: "browser", menuLabel: "浏览器", tabLabel: "新标签页", icon: "globe", shortcut: "Ctrl+Alt+B" }),
  Object.freeze({ id: "files", menuLabel: "文件", tabLabel: "打开文件", icon: "folder-open", shortcut: "Ctrl+Alt+F" }),
  // 参考图没有这一项，但侧边对话是 514cc 的直接收件人入口，不能因为"照着图做"而丢掉
  Object.freeze({ id: "side-chat", menuLabel: "侧边对话", tabLabel: "侧边对话", icon: "message-circle", shortcut: "Ctrl+Alt+S", external: true }),
]);

const toolById = new Map(RAIL_TOOLS.map((tool) => [tool.id, tool]));
const PANEL_TOOLS = RAIL_TOOLS.filter((tool) => !tool.external);

function fallbackEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeStorageGet(storage, key) {
  try {
    return storage?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
}

export function safeStorageSet(storage, key, value) {
  try {
    storage?.setItem?.(key, value);
  } catch {
    // Storage 被策略/隐私模式禁用时，工具栏退化为当前页面内存态。
  }
}

export function safeStorageRemove(storage, key) {
  try {
    storage?.removeItem?.(key);
  } catch {
    // 同上：持久化失败不应让右栏初始化或关闭工具失败。
  }
}

export function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // opaque origin / 浏览器策略可能在 getter 本身抛 SecurityError。
    return null;
  }
}

function readOpenTabs(storage = null) {
  try {
    const raw = JSON.parse(safeStorageGet(storage, OPEN_KEY) ?? "null");
    if (!Array.isArray(raw)) return null;
    const ids = raw.map(String).filter((id) => toolById.has(id) && !toolById.get(id).external);
    return [...new Set(ids)];
  } catch {
    return null;
  }
}

export function createRailTools({
  root,
  icon = () => "",
  escapeHtml = fallbackEscape,
  onActivate = null,
  onOpen = null,
  onExternal = null,
} = {}) {
  const tabStrip = root?.querySelector("#rail-tabs");
  const menu = root?.querySelector("#rail-tool-menu");
  const addButton = root?.querySelector("#rail-tab-add");
  const picker = root?.querySelector("#rail-tool-picker");
  const emptyState = root?.querySelector("#rail-empty-state");
  if (!root || !tabStrip || !menu || !addButton || !picker || !emptyState) {
    return { open() {}, close() {}, activate() {}, isOpen: () => false, activeId: () => null, destroy() {} };
  }

  const panels = new Map(
    PANEL_TOOLS.map((tool) => [tool.id, root.querySelector(`[data-tool-panel="${tool.id}"]`)]).filter(([, node]) => node),
  );
  // 首访默认只开任务上下文：右栏一进来就有内容，又不预占三个工具页的加载成本
  const storage = safeLocalStorage();
  let openTabs = readOpenTabs(storage) ?? ["mission"];
  let activeId = safeStorageGet(storage, ACTIVE_KEY);
  if (!openTabs.includes(activeId)) activeId = openTabs[0] ?? null;

  function persist() {
    safeStorageSet(storage, OPEN_KEY, JSON.stringify(openTabs));
    if (activeId) safeStorageSet(storage, ACTIVE_KEY, activeId);
    else safeStorageRemove(storage, ACTIVE_KEY);
  }

  function toolItemMarkup(tool, role) {
    return `<button class="rail-tool-item" type="button" role="${role}" data-rail-open="${escapeHtml(tool.id)}">
      ${icon(tool.icon)}<span>${escapeHtml(tool.menuLabel)}</span>${tool.shortcut ? `<kbd>${escapeHtml(tool.shortcut)}</kbd>` : ""}
    </button>`;
  }

  function render() {
    tabStrip.innerHTML = openTabs.map((id) => {
      const tool = toolById.get(id);
      const active = id === activeId;
      const tabId = `rail-tab-${id}`;
      const panelId = `rail-panel-${id}`;
      return `<span class="rail-tab${active ? " is-active" : ""}">
        <button class="rail-tab-main" id="${tabId}" type="button" role="tab" aria-selected="${active}" aria-controls="${panelId}" tabindex="${active ? 0 : -1}" data-rail-activate="${escapeHtml(id)}" title="${escapeHtml(tool.tabLabel)}">
          ${icon(tool.icon)}<span>${escapeHtml(tool.tabLabel)}</span>
        </button>
        <button class="rail-tab-close" type="button" data-rail-close="${escapeHtml(id)}" title="关闭${escapeHtml(tool.tabLabel)}" aria-label="关闭${escapeHtml(tool.tabLabel)}">${icon("x")}</button>
      </span>`;
    }).join("");

    for (const [id, panel] of panels) {
      panel.id = `rail-panel-${id}`;
      panel.setAttribute("aria-labelledby", `rail-tab-${id}`);
      panel.hidden = id !== activeId;
    }
    emptyState.hidden = openTabs.length > 0;
    // 菜单与空态选择器共用同一份工具定义，不会出现"菜单有、空态没有"的漂移
    menu.innerHTML = RAIL_TOOLS.map((tool) => toolItemMarkup(tool, "menuitem")).join("");
    picker.innerHTML = RAIL_TOOLS.filter((tool) => tool.id !== "mission" || !openTabs.includes("mission"))
      .map((tool) => toolItemMarkup(tool, "menuitem")).join("");
  }

  function setMenuOpen(open) {
    menu.hidden = !open;
    addButton.setAttribute("aria-expanded", String(open));
  }

  function activate(id) {
    if (!openTabs.includes(id)) return;
    activeId = id;
    persist();
    render();
    onActivate?.(id);
  }

  function open(id) {
    const tool = toolById.get(id);
    if (!tool) return;
    if (tool.external) {
      onExternal?.(id);
      return;
    }
    const fresh = !openTabs.includes(id);
    if (fresh) openTabs = [...openTabs, id];
    activeId = id;
    persist();
    render();
    if (fresh) onOpen?.(id);
    onActivate?.(id);
  }

  function close(id) {
    const index = openTabs.indexOf(id);
    if (index < 0) return;
    openTabs = openTabs.filter((item) => item !== id);
    if (activeId === id) activeId = openTabs[Math.min(index, openTabs.length - 1)] ?? null;
    persist();
    render();
    // Closing the last tab still deactivates the previous panel; consumers use
    // the null activation to abort in-flight work owned by the hidden tool.
    onActivate?.(activeId);
  }

  const handleClick = (event) => {
    const closeTarget = event.target.closest("[data-rail-close]");
    if (closeTarget) {
      event.preventDefault();
      close(closeTarget.dataset.railClose);
      return;
    }
    const activateTarget = event.target.closest("[data-rail-activate]");
    if (activateTarget) {
      event.preventDefault();
      activate(activateTarget.dataset.railActivate);
      return;
    }
    const openTarget = event.target.closest("[data-rail-open]");
    if (openTarget) {
      event.preventDefault();
      setMenuOpen(false);
      open(openTarget.dataset.railOpen);
      return;
    }
    if (event.target.closest("#rail-tab-add")) {
      event.preventDefault();
      setMenuOpen(menu.hidden);
    }
  };

  const handleDocumentClick = (event) => {
    if (menu.hidden) return;
    if (!event.target.closest("#rail-tool-menu") && !event.target.closest("#rail-tab-add")) setMenuOpen(false);
  };

  // capture 阶段消费 Escape 并 preventDefault：右栏折叠器也监听 Escape，
  // 不抢在它前面的话，用户关个菜单会连带把整条右栏折叠掉。
  const handleKeydown = (event) => {
    if (event.key === "Escape") {
      if (menu.hidden) return;
      event.preventDefault();
      setMenuOpen(false);
      return;
    }
    const current = event.target?.closest?.("[role=\"tab\"][data-rail-activate]");
    if (!current || !tabStrip.contains(current)) return;
    const tabs = [...tabStrip.querySelectorAll("[role=\"tab\"][data-rail-activate]")];
    if (!tabs.length) return;
    let index = tabs.indexOf(current);
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = tabs.length - 1;
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") index = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") index = (index - 1 + tabs.length) % tabs.length;
    else return;
    event.preventDefault();
    const next = tabs[index];
    activate(next.dataset.railActivate);
    requestAnimationFrame(() => [...tabStrip.querySelectorAll("[data-rail-activate]")]
      .find((tab) => tab.dataset.railActivate === next.dataset.railActivate)?.focus());
  };

  root.addEventListener("click", handleClick);
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleKeydown, true);
  render();
  if (activeId) onActivate?.(activeId);

  return {
    open,
    close,
    activate,
    isOpen: (id) => openTabs.includes(id),
    activeId: () => activeId,
    destroy() {
      root.removeEventListener("click", handleClick);
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("keydown", handleKeydown, true);
    },
  };
}
