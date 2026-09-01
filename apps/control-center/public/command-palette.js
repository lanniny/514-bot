/**
 * command-palette.js — 全局命令面板（v4.0 Forge · cmdk 级）
 *
 * 打开方式（顶栏 chip 可直接复用）：
 *   1. initCommandPalette() 注册的 document 级 Ctrl+K / Cmd+K 快捷键（toggle）
 *   2. 导出的 openCommandPalette() / toggleCommandPalette()，任意按钮 click 调用即可
 *   3. 关闭：ESC、点击遮罩、执行条目后自动关闭
 *
 * 支持：
 *   - 模糊搜索视图导航（与 state.js 的 VIEW_TITLES 自动同步）
 *   - 快速操作（刷新、切换主题、新建任务…）
 *   - Agent 点名（select-agent:<id> 回调）
 *   - extraItems 扩展项（app.js 注入的协作/权限/模板动作，item.run 直接执行）
 *   - 全局搜索：输入防抖 250ms 命中 GET /api/search?q=，
 *     接口缺失/网络失败时自动降级为纯本地结果，不报错
 */

import { lucideIcon } from "./lucide.js";
import { escapeHtml } from "./utils.js";
import { request as apiRequest } from "./api.js";
import { VIEW_TITLES } from "./state.js";
import { NAV_ITEMS } from "./modules/nav-config.js";

// 不在主导航里的深链视图（hero 星图 / router 路由 / terminal 终端 / capabilities 能力…）
// 由命令面板兜底；其余一律以导航单一真源 NAV_ITEMS 为准，避免"导航换了图标、
// 命令面板还显示旧的"这类双写漂移（UI-AUDIT P0-5）。
const PALETTE_ONLY_ICONS = {
  router: "route",
  terminal: "terminal",
  capabilities: "puzzle",
  memory: "brain",
  hero: "orbit",
  appearance: "palette",
  browser: "globe",
};

const NAV_ICON_BY_VIEW = {
  ...PALETTE_ONLY_ICONS,
  ...Object.fromEntries(Object.entries(NAV_ITEMS).map(([view, item]) => [view, item.icon])),
};

const NAV_KEYWORDS_BY_VIEW = {
  bot: "514 bot agent chat master 代理 对话 工作台",
  workbench: "collaboration workbench 协作 任务",
  overview: "overview 总览 dashboard 健康",
  config: "config 配置 settings 设置 源 capabilities 能力 skills 技能 MCP 图谱 provider 供应商",
  router: "router 路由 model 模型 设置 派工 团队",
  security: "security 安全 shield 诊断 设置",
  observability: "observability 观测 pulse delta handoff 交接 记忆 memory",
  sessions: "sessions 会话 conversation 历史",
  team: "team 团队 协作 roster agent 成员 星图 constellation 路由 派工",
  hero: "hero constellation 星图 协作星图 orbit 团队",
  bootstrapper: "bootstrapper 项目 创建 new project scaffold 脚手架",
  office: "office 文档 工坊 docx ppt",
  automations: "automation 自动化 定时 闲时 cron schedule 计划",
  appearance: "appearance theme 外观 主题 字号 深色 亮色",
  browser: "browser 浏览器 内置浏览",
  market: "market plugin 市场 插件 skill mcp",
  hosts: "hosts ssh 远程主机",
  channels: "channels 渠道",
};

const QUICK_ACTIONS = [
  { id: "refresh", label: "刷新数据", icon: "refresh-cw", group: "操作", keywords: "refresh 刷新 reload", action: "refresh" },
  { id: "theme-toggle", label: "切换主题", icon: "sun", group: "操作", keywords: "theme 主题 dark light 暗色 亮色", action: "toggle-theme" },
  { id: "new-task", label: "新建任务", icon: "plus", group: "操作", keywords: "new task 新建 任务 create", action: "new-task" },
  { id: "run-diagnostics", label: "运行诊断", icon: "shield-check", group: "操作", keywords: "diagnostics 诊断 check", action: "run-diagnostics" },
  { id: "reload-runtime", label: "重载运行时", icon: "zap", group: "操作", keywords: "reload runtime 重载", action: "reload-runtime" },
];

const AGENTS = [
  { id: "claude", label: "Claude Fable", icon: "sparkles", group: "Agent", keywords: "claude 规划 编排 aemeath 洛琪希" },
  { id: "codex", label: "Codex 烛", icon: "flame", group: "Agent", keywords: "codex 烛 reviewer 评审" },
  { id: "grok", label: "Grok 织", icon: "radar", group: "Agent", keywords: "grok 织 researcher 搜索" },
  { id: "kimi", label: "Kimi 前端", icon: "bot", group: "Agent", keywords: "kimi 前端 frontend" },
  { id: "pi", label: "Pi 扩展", icon: "cpu", group: "Agent", keywords: "pi 扩展 rpc" },
];

// 全局搜索结果的 kind 元数据：图标 + 落点视图（无深链时的降级导航目标）
const SEARCH_KIND_META = {
  session: { label: "会话", icon: "messages-square", view: "sessions" },
  handoff: { label: "交接", icon: "file-text", view: "observability" },
  memory: { label: "记忆", icon: "brain", view: "observability" },
  doc: { label: "文档", icon: "archive", view: "observability" },
  skill: { label: "技能", icon: "puzzle", view: "capabilities" },
};

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 8;

let _paletteEl = null;
let _inputEl = null;
let _resultsEl = null;
let _isOpen = false;
let _selectedIndex = 0;
let _filteredItems = [];
let _onNavigate = null;
let _onAction = null;
let _extraItems = () => [];

// 全局搜索状态
let _searchTimer = 0;
let _searchSeq = 0;
let _searchAbort = null;
let _searchResults = [];
let _searchState = "idle"; // idle | loading | done | error

/**
 * 初始化命令面板
 * @param {Object} opts
 * @param {Function} opts.onNavigate - (viewId) => void，视图切换回调
 * @param {Function} opts.onAction - (actionId) => void，快速操作回调
 * @param {Function} opts.extraItems - () => Item[]，注入额外面板项
 *   （{ id, label, detail?, icon?, group?, keywords?, run? }；带 run 的项执行时直接调用）
 */
export function initCommandPalette(opts = {}) {
  if (_paletteEl) return; // 幂等：重复 init 不重建 DOM / 重复绑定快捷键
  _onNavigate = opts.onNavigate || (() => {});
  _onAction = opts.onAction || (() => {});
  _extraItems = typeof opts.extraItems === "function" ? opts.extraItems : () => [];

  // 创建 DOM
  _paletteEl = document.createElement("div");
  _paletteEl.className = "cmd-palette-overlay";
  _paletteEl.setAttribute("role", "dialog");
  _paletteEl.setAttribute("aria-label", "命令面板");
  _paletteEl.innerHTML = `
    <div class="cmd-palette">
      <div class="cmd-palette-header">
        ${lucideIcon("search", "icon lucide cmd-palette-icon")}
        <input class="cmd-palette-input" type="text" placeholder="搜索命令、视图、Agent、记忆与文档…"
          autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true"
          aria-controls="cmd-palette-listbox" aria-activedescendant="" />
        <kbd class="cmd-palette-kbd">esc</kbd>
      </div>
      <div class="cmd-palette-results" role="listbox" id="cmd-palette-listbox"></div>
      <div class="cmd-palette-footer">
        <span class="cmd-palette-hint"><kbd>↑↓</kbd> 选择</span>
        <span class="cmd-palette-hint"><kbd>↵</kbd> 执行</span>
        <span class="cmd-palette-hint"><kbd>esc</kbd> 关闭</span>
      </div>
    </div>
  `;
  document.body.appendChild(_paletteEl);
  _inputEl = _paletteEl.querySelector(".cmd-palette-input");
  _resultsEl = _paletteEl.querySelector(".cmd-palette-results");

  // 事件绑定
  _paletteEl.addEventListener("mousedown", (e) => {
    if (e.target === _paletteEl) closeCommandPalette();
  });
  _inputEl.addEventListener("input", onInput);
  _inputEl.addEventListener("keydown", onKeydown);

  // 全局快捷键：Ctrl+K / Cmd+K
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      toggleCommandPalette();
    }
    if (e.key === "Escape" && _isOpen && !document.querySelector("dialog[open]")) {
      e.preventDefault();
      closeCommandPalette();
    }
  });
}

export function toggleCommandPalette() {
  if (_isOpen) closeCommandPalette();
  else openCommandPalette();
}

export function openCommandPalette() {
  if (!_paletteEl) return;
  _isOpen = true;
  _paletteEl.classList.add("is-open");
  _inputEl.value = "";
  _selectedIndex = 0;
  resetSearch();
  filterItems("");
  requestAnimationFrame(() => _inputEl.focus());
}

export function closeCommandPalette() {
  if (!_paletteEl) return;
  _isOpen = false;
  _paletteEl.classList.remove("is-open");
  window.clearTimeout(_searchTimer);
  _searchSeq++; // 让在途请求结果失效
  _searchAbort?.abort();
  resetSearch();
}

function resetSearch() {
  _searchResults = [];
  _searchState = "idle";
}

/** 视图导航项与 VIEW_TITLES 同步：state.js 新增视图（如 team）后自动出现 */
function getNavItems() {
  return Object.keys(VIEW_TITLES).map((id) => ({
    id,
    label: VIEW_TITLES[id],
    icon: NAV_ICON_BY_VIEW[id] || "layout-dashboard",
    group: "视图",
    keywords: NAV_KEYWORDS_BY_VIEW[id] || "",
  }));
}

function getAllItems() {
  let extra = [];
  try {
    extra = _extraItems() || [];
  } catch {
    extra = [];
  }
  return [...getNavItems(), ...QUICK_ACTIONS, ...AGENTS, ...extra];
}

function filterItems(query) {
  const q = query.toLowerCase().trim();
  const all = getAllItems();
  let local = all;
  if (q) {
    local = all.filter((item) => {
      const haystack = `${item.label} ${item.keywords || ""} ${item.detail || ""} ${item.id}`.toLowerCase();
      // 简单模糊匹配：所有 query 词都出现
      return q.split(/\s+/).every((word) => haystack.includes(word));
    });
  }
  _filteredItems = q ? [...local, ..._searchResults] : local;
  _selectedIndex = 0;
  renderResults();
}

function renderResults() {
  const query = _inputEl.value.trim();
  let html = "";
  let flatIndex = 0;

  if (_filteredItems.length) {
    // 按 group 分组（插入序：视图 → 操作 → Agent → 扩展项分组 → 搜索结果）
    const groups = new Map();
    for (const item of _filteredItems) {
      const g = item.group || "其他";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(item);
    }
    for (const [group, items] of groups) {
      html += `<div class="cmd-palette-group">${escapeHtml(group)}</div>`;
      for (const item of items) {
        const selected = flatIndex === _selectedIndex ? "is-selected" : "";
        const iconName = item.kind
          ? (SEARCH_KIND_META[item.kind]?.icon || "search")
          : item.icon;
        const hint = item.kind
          ? (SEARCH_KIND_META[item.kind]?.label || "结果")
          : (item.hint || item.detail || "");
        const snippet = item.snippet
          ? `<span class="cmd-palette-item-snippet">${highlightMatch(item.snippet, query)}</span>`
          : "";
        html += `<div class="cmd-palette-item ${selected}${item.kind ? " is-search-result" : ""}"
            role="option" id="cmd-palette-opt-${flatIndex}" aria-selected="${selected ? "true" : "false"}"
            data-index="${flatIndex}">
          <span class="cmd-palette-item-tile">${lucideIcon(iconName || "search", "icon lucide")}</span>
          <span class="cmd-palette-item-main">
            <span class="cmd-palette-item-label">${highlightMatch(item.label, query)}</span>
            ${snippet}
          </span>
          ${hint ? `<span class="cmd-palette-item-hint">${escapeHtml(hint)}</span>` : ""}
          <kbd class="cmd-palette-item-enter">↵</kbd>
        </div>`;
        flatIndex++;
      }
    }
  }

  // 全局搜索状态行（加载中 / 不可用提示）
  if (query && _searchState === "loading") {
    html += `<div class="cmd-palette-status">
      ${lucideIcon("loader-circle", "icon lucide cmd-palette-spin")}
      <span>正在全局搜索…</span>
    </div>`;
  } else if (query && _searchState === "error") {
    html += `<div class="cmd-palette-status is-muted">
      ${lucideIcon("info", "icon lucide")}
      <span>全局搜索暂不可用，仅显示本地结果</span>
    </div>`;
  }

  if (!flatIndex && _searchState !== "loading") {
    html = `<div class="cmd-palette-empty">
      ${lucideIcon("search", "icon lucide")}
      <span class="cmd-palette-empty-title">无匹配结果</span>
      <span class="cmd-palette-empty-sub">换个关键词试试，或按 esc 关闭</span>
    </div>`;
  }

  _resultsEl.innerHTML = html;
  syncActiveDescendant();
  // 滚动到选中项
  const selectedEl = _resultsEl.querySelector(".is-selected");
  if (selectedEl) selectedEl.scrollIntoView({ block: "nearest" });
  // 点击 / 悬停事件
  _resultsEl.querySelectorAll(".cmd-palette-item").forEach((el) => {
    el.addEventListener("click", () => executeItem(_filteredItems[Number(el.dataset.index)]));
    el.addEventListener("mouseenter", () => {
      _selectedIndex = Number(el.dataset.index);
      updateSelection();
    });
  });
}

function updateSelection() {
  _resultsEl.querySelectorAll(".cmd-palette-item").forEach((el) => {
    const selected = Number(el.dataset.index) === _selectedIndex;
    el.classList.toggle("is-selected", selected);
    el.setAttribute("aria-selected", selected ? "true" : "false");
  });
  syncActiveDescendant();
  const selectedEl = _resultsEl.querySelector(".is-selected");
  if (selectedEl) selectedEl.scrollIntoView({ block: "nearest" });
}

function syncActiveDescendant() {
  if (!_inputEl) return;
  _inputEl.setAttribute(
    "aria-activedescendant",
    _filteredItems.length ? `cmd-palette-opt-${_selectedIndex}` : "",
  );
}

function executeItem(item) {
  if (!item) return;
  closeCommandPalette();
  if (item.kind) {
    // 全局搜索结果：按 kind 导航到落点视图，并闪烁提示落点
    const meta = SEARCH_KIND_META[item.kind] || { view: "observability" };
    _onNavigate(meta.view);
    const target = item.kind === "memory"
      ? "#memory-browser-root"
      : item.kind === "skill"
        ? "#config-surface-capabilities"
        : `#view-${meta.view}`;
    flashTarget(target);
    return;
  }
  if (typeof item.run === "function") {
    // extraItems 注入的扩展动作：直接执行（协作/权限/模板）
    try {
      item.run();
    } catch (error) {
      console.warn("[command-palette] extra item run failed:", error);
    }
    return;
  }
  if (item.action) {
    _onAction(item.action);
  } else if (item.group === "Agent") {
    _onAction(`select-agent:${item.id}`);
  } else {
    _onNavigate(item.id);
  }
}

/** 深链降级：导航后给目标容器一圈呼吸高亮，帮助定位 */
function flashTarget(selector) {
  requestAnimationFrame(() => {
    const el = document.querySelector(selector);
    if (!el) return;
    el.classList.add("forge-flash");
    window.setTimeout(() => el.classList.remove("forge-flash"), 1800);
  });
}

function onInput() {
  const query = _inputEl.value;
  filterItems(query);
  window.clearTimeout(_searchTimer);
  const q = query.trim();
  if (!q) {
    _searchSeq++;
    _searchAbort?.abort();
    resetSearch();
    return;
  }
  _searchTimer = window.setTimeout(() => void runGlobalSearch(q), SEARCH_DEBOUNCE_MS);
}

async function runGlobalSearch(query) {
  const seq = ++_searchSeq;
  _searchState = "loading";
  renderResults();
  _searchAbort?.abort();
  const controller = new AbortController();
  _searchAbort = controller;
  try {
    const data = await apiRequest(
      `/api/search?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}`,
      { signal: controller.signal },
    );
    if (seq !== _searchSeq) return;
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    _searchResults = groups.flatMap((group) => {
      const kind = String(group?.kind || "");
      const items = Array.isArray(group?.items) ? group.items : [];
      return items.map((item, i) => ({
        id: `search:${kind}:${item?.id ?? item?.ref ?? i}`,
        label: String(item?.title ?? item?.ref ?? "未命名结果"),
        snippet: item?.snippet ? String(item.snippet) : "",
        ref: item?.ref ? String(item.ref) : "",
        kind,
        group: "搜索结果",
      }));
    });
    _searchState = "done";
  } catch (error) {
    if (error?.name === "AbortError" || seq !== _searchSeq) return;
    // 404 / 网络失败 / 未授权：静默降级为本地结果
    _searchResults = [];
    _searchState = "error";
  }
  if (seq === _searchSeq && _isOpen) filterItems(_inputEl.value);
}

function onKeydown(e) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (!_filteredItems.length) return; // 空列表时保持 0，避免索引变 -1 破坏 aria 与 Enter 行为
    _selectedIndex = Math.min(_selectedIndex + 1, _filteredItems.length - 1);
    updateSelection();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    _selectedIndex = Math.max(_selectedIndex - 1, 0);
    updateSelection();
  } else if (e.key === "Enter") {
    e.preventDefault();
    executeItem(_filteredItems[_selectedIndex]);
  }
}

/** 高亮命中片段：先转义再包 <mark>，query 逐词取第一个命中 */
function highlightMatch(text, query) {
  const safe = escapeHtml(text);
  const words = String(query || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return safe;
  const lower = safe.toLowerCase();
  for (const word of words) {
    const needle = escapeHtml(word); // 在转义后文本里切片，长度必须按转义后实体算（`<`→`&lt;`，否则 <mark> 切断实体出乱码）
    const idx = lower.indexOf(needle);
    if (idx >= 0) {
      return `${safe.slice(0, idx)}<mark>${safe.slice(idx, idx + needle.length)}</mark>${safe.slice(idx + needle.length)}`;
    }
  }
  return safe;
}
