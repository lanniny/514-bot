/**
 * placeholders.js — 空状态 / 加载态 单一真源（UI-AUDIT P0-6）
 *
 * 背景：此前全库空状态"双轨"——规范的 `.empty-state` 组件与十余处散写的
 * `<p class="subtle">暂无数据</p>` 并存；加载态绝大多数是文字"正在加载…"，
 * 骨架屏仅 1 处（forge/team.css）。结果是 A 页有插画+引导、B 页只有一行灰字，
 * 品质感撕裂，且文字 loading 在表格场景造成布局跳动（CLS）。
 *
 * 规范：
 *   空状态三分类
 *     first-run  首次无数据 → 插画 + 价值说明 + 主行动按钮（引导，不是报错）
 *     no-result  筛选无结果 → 提示 + 清除筛选动作（不暗示系统故障）
 *     error      加载失败   → 错误说明 + 重试按钮（明确可恢复路径）
 *   加载态一律骨架屏（表格 / 卡片 / 列表三件套），不再用文字占位。
 *
 * 约定：本模块只产出 HTML 字符串，不碰 DOM、不注册事件；动作按钮以
 * `data-empty-action="<id>"` 暴露，由调用方统一委托监听。
 */

import { escapeHtml, escapeAttr } from "../utils.js";

const TONES = {
  "first-run": { icon: "package", role: "status" },
  "no-result": { icon: "search", role: "status" },
  error: { icon: "triangle-alert", role: "status" },
};

export const ILLUSTRATIONS = Object.freeze({
  astrolabe: `<svg class="empty-state-illustration" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="32" cy="32" r="28" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 3" opacity="0.35"/>
    <circle cx="32" cy="32" r="20" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
    <circle cx="32" cy="32" r="10" stroke="var(--primary)" stroke-width="2" opacity="0.8"/>
    <circle cx="32" cy="32" r="3" fill="var(--primary)"/>
    <path d="M32 4V12M32 52V60M4 32H12M52 32H60" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.4"/>
    <path d="M12 12L18 18M46 46L52 52M52 12L46 18M12 52L18 46" stroke="var(--primary)" stroke-width="1" stroke-linecap="round" opacity="0.6"/>
  </svg>`,
  prism: `<svg class="empty-state-illustration" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <polygon points="32 10 54 50 10 50" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
    <polygon points="32 18 48 46 16 46" stroke="var(--primary)" stroke-width="1.5" opacity="0.7"/>
    <line x1="8" y1="32" x2="26" y2="32" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
    <line x1="38" y1="30" x2="56" y2="24" stroke="var(--primary)" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/>
    <line x1="38" y1="34" x2="56" y2="34" stroke="var(--success, #067562)" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/>
    <line x1="38" y1="38" x2="56" y2="44" stroke="var(--info, #365fcf)" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/>
  </svg>`,
  lock: `<svg class="empty-state-illustration" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="16" y="26" width="32" height="26" rx="6" stroke="currentColor" stroke-width="2" opacity="0.6"/>
    <path d="M22 26V18C22 12.477 26.477 8 32 8C37.523 8 42 12.477 42 18V26" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="32" cy="37" r="3.5" fill="var(--primary)"/>
    <path d="M32 40.5V45" stroke="var(--primary)" stroke-width="2" stroke-linecap="round"/>
  </svg>`,
  seal: `<svg class="empty-state-illustration" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="32" cy="32" r="26" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 2" opacity="0.4"/>
    <circle cx="32" cy="32" r="20" stroke="var(--primary)" stroke-width="2" opacity="0.75"/>
    <path d="M24 32L29 37L40 25" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  orbit: `<svg class="empty-state-illustration" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <ellipse cx="32" cy="32" rx="26" ry="12" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 4" transform="rotate(-25 32 32)" opacity="0.4"/>
    <ellipse cx="32" cy="32" rx="12" ry="26" stroke="var(--primary)" stroke-width="1.5" stroke-dasharray="8 4" transform="rotate(30 32 32)" opacity="0.6"/>
    <circle cx="32" cy="32" r="6" fill="var(--danger)" opacity="0.8"/>
    <circle cx="48" cy="18" r="2.5" fill="currentColor" opacity="0.5"/>
    <circle cx="16" cy="46" r="2" fill="currentColor" opacity="0.5"/>
  </svg>`,
});

const DEFAULT_TONE = "no-result";

function toneMeta(tone) {
  return TONES[tone] ?? TONES[DEFAULT_TONE];
}

function iconMarkup(name) {
  return `<svg class="empty-state-icon lucide" aria-hidden="true"><use href="#lucide-${escapeAttr(name)}"></use></svg>`;
}

function actionMarkup(action) {
  if (!action?.label) return "";
  const icon = action.icon ? `<svg class="icon lucide" aria-hidden="true"><use href="#lucide-${escapeAttr(action.icon)}"></use></svg>` : "";
  // 三种动作出口，避免产出"点了没反应"的死按钮：
  //   view     → 挂 data-view，复用 app.js 全局点击委托直接切视图，零接线
  //   attrs    → 挂调用方现成的委托属性（如 data-config-host-probe="<id>"）
  //   actionId → 挂 data-empty-action，由调用方按 id 委托处理（重试 / 清除筛选等）
  let hook = `data-empty-action="${escapeAttr(action.actionId ?? "retry")}"`;
  if (action.view) hook = `data-view="${escapeAttr(action.view)}"`;
  else if (action.attrs) {
    hook = Object.entries(action.attrs)
      .map(([name, value]) => `${name}="${escapeAttr(value)}"`)
      .join(" ");
  }
  return `<button class="button secondary empty-state-action" type="button" ${hook}>${icon}<span>${escapeHtml(action.label)}</span></button>`;
}

/**
 * 区块级空状态。
 * @param {object} options
 * @param {"first-run"|"no-result"|"error"} [options.tone]
 * @param {string} options.title
 * @param {string} [options.desc]
 * @param {string} [options.icon] 覆盖默认分类图标（须为 lucide sprite 中的 id）
 * @param {{label:string, actionId?:string, icon?:string}} [options.action]
 * @param {boolean} [options.compact] 面板内小块空态（最小高度 120px，不铺满）
 * @param {string} [options.id]
 */
export function emptyState({ tone = DEFAULT_TONE, title, desc = "", icon, illustration, action = null, compact = false, id = "" } = {}) {
  const meta = toneMeta(tone);
  const idAttr = id ? ` id="${escapeAttr(id)}"` : "";
  const classes = ["empty-state", `empty-state--${tone}`];
  if (compact) classes.push("empty-state--compact");
  const visual = (illustration && ILLUSTRATIONS[illustration])
    ? ILLUSTRATIONS[illustration]
    : iconMarkup(icon ?? meta.icon);
  return `<div class="${classes.join(" ")}"${idAttr} role="${meta.role}">`
    + visual
    + `<p class="empty-state-title">${escapeHtml(title ?? "")}</p>`
    + (desc ? `<p class="empty-state-desc">${escapeHtml(desc)}</p>` : "")
    + actionMarkup(action)
    + `</div>`;
}

/**
 * 行内极简空提示（表格单元、键值列表等放不下插画的位置）。
 * 这是"散写 <p class='subtle'>"唯一合法的替代出口。
 */
export function inlineEmpty(text, { className = "" } = {}) {
  const classes = ["inline-empty", className].filter(Boolean).join(" ");
  return `<p class="${classes}">${escapeHtml(text)}</p>`;
}

function skeletonRow(variant, columns) {
  if (variant === "table") {
    let cells = "";
    for (let index = 0; index < columns; index += 1) {
      const width = index === 0 ? "42%" : `${Math.max(28, 96 - index * 18)}%`;
      cells += `<span class="skeleton-bar" style="inline-size:${width}"></span>`;
    }
    return `<div class="skeleton-row">${cells}</div>`;
  }
  if (variant === "card") {
    return `<div class="skeleton-row skeleton-row--card">`
      + `<span class="skeleton-block skeleton-block--avatar"></span>`
      + `<span class="skeleton-lines"><span class="skeleton-bar" style="inline-size:60%"></span><span class="skeleton-bar" style="inline-size:38%"></span></span>`
      + `</div>`;
  }
  return `<div class="skeleton-row skeleton-row--list">`
    + `<span class="skeleton-bar" style="inline-size:${Math.max(34, 88 - columns * 6)}%"></span>`
    + `</div>`;
}

/**
 * 骨架屏。用结构性占位替代文字 loading，避免 CLS 与"死屏"观感。
 * @param {"table"|"card"|"list"} [options.variant]
 */
export function skeleton({ variant = "list", rows = 4, columns = 3, label = "正在加载数据" } = {}) {
  let markup = "";
  for (let index = 0; index < rows; index += 1) markup += skeletonRow(variant, columns);
  return `<div class="skeleton skeleton--${escapeAttr(variant)}" role="status" aria-live="polite" aria-busy="true">`
    + `<span class="sr-only">${escapeHtml(label)}</span>`
    + markup
    + `</div>`;
}

/**
 * 加载态快捷出口：默认给列表骨架，调用方按视图形态覆盖 variant。
 */
export function loadingBlock(options = {}) {
  return skeleton(options);
}

/**
 * 把占位内容写进宿主节点（统一 innerHTML 出口，便于后续替换成模板函数）。
 */
export function renderPlaceholder(host, html) {
  if (!host) return false;
  host.innerHTML = html;
  return true;
}

export const EMPTY_TONES = Object.freeze(Object.keys(TONES));
