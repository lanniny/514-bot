/**
 * pet-ring.js — 桌宠环形快捷栏（右键弹出）。
 *
 * 设计取舍：
 *   1. **扇区定位走 data-* 属性 + CSS 选择器，不逐元素写内联样式**。
 *      CSP 是 `style-src 'self'`（禁内联 style 属性），而 CSSOM（`el.style.setProperty`）
 *      虽然不受 CSP 管辖，但逐元素算三角函数既啰嗦又难测。改用
 *      `data-count` + `data-ring-index` 两个属性，角度表写在 CSS 里，可被静态断言。
 *   2. **两级架构**。一级是分类（模型 / 表情 / 动作 / 穿透 / 收起），二级是具体条目。
 *      桌宠窗口只有 300×280，一级固定 5 个扇区，契约稳固。
 *   3. **环不吃指针事件**，只有扇区按钮与中控吃。环外仍可拖拽、戳一戳，点击空白平滑收起。
 *   4. 模型切换要落服务端（真源），表情/动作是一次性演出，本地处理。
 *
 * 依赖注入：`onSelect(type, value)` 由引擎提供，ring 本身不知道 Live2D 的存在。
 */

const RING_ITEMS = Object.freeze([
  { id: "model", label: "模型", hint: "切换桌宠模型", icon: "model" },
  { id: "expression", label: "表情", hint: "播放即时表情", icon: "expression" },
  { id: "motion", label: "动作", hint: "播放即时动作", icon: "motion" },
  // 顶栏移除后，「退出互动（改回穿透）」与「收起」只能从环里走，所以这两项必须在。
  { id: "pass-through", label: "穿透", hint: "退出互动，允许点击穿透", icon: "pass-through" },
  { id: "close", label: "收起", hint: "收起桌宠到后台", icon: "close" },
]);

/** 鲸鱼娘表情语义名映射表：将内部英文标识转为直观中文显示，data-ring-key 仍保留原标识。 */
const WHALE_EXPRESSION_LABELS = Object.freeze({
  question: "疑问", exclamation: "感叹", dizzy: "眩晕", sweat: "流汗", angry: "生气",
  cry: "哭泣", sad: "难过", excited: "兴奋", starry: "星星眼", "heart-eyes": "花痴",
  blush: "脸红", playful: "调皮", tongue: "吐舌", blank: "发呆", drool: "流口水",
  "soul-out": "升天", gloomy: "阴暗", heartbeat: "心动",
  sunglasses: "墨镜", "glasses-round": "圆眼镜", "glasses-square": "方眼镜", "glasses-oval": "椭圆镜",
  "sticker-cat": "猫咪贴", "sticker-rabbit": "兔兔贴", "sticker-bow": "蝴蝶结",
  flower: "小红花", "double-peace": "双倍耶", "paw-anim": "肉垫",
  "side-ponytail": "侧马尾", headband: "发带", "table-dark": "小黑桌", "phone-color": "彩手机",
  claw: "猫爪", "claw-color": "彩猫爪", whale: "鲸鱼", "whale-on-table": "桌上鲸",
  "menu-press": "菜单", omurice: "蛋包饭", pen: "钢笔", eraser: "橡皮擦", undo: "撤销",
  squeeze: "捏脸", parfait: "芭菲", love: "比心",
});

/** 鲸鱼娘动作语义名映射表。 */
const WHALE_MOTION_LABELS = Object.freeze({
  bubblegum: "泡泡糖",
  ketchup: "番茄酱",
  "open-phone": "拿手机",
  selfie: "自拍",
  "selfie-quick": "抓拍",
  spray: "喷水",
});

/** 二级页每页最多几项（300px 宽放得下 6 个）。 */
const PAGE_SIZE = 6;

const SVG_NS = "http://www.w3.org/2000/svg";

const RING_ICONS = {
  model: [
    { tag: "rect", attrs: { x: "4", y: "7", width: "16", height: "12", rx: "3" } },
    { tag: "path", attrs: { d: "M9 13h.01M15 13h.01M12 3v4M8 3h8" } },
  ],
  expression: [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "9" } },
    { tag: "path", attrs: { d: "M8 14s1.5 2 4 2 4-2 4-2" } },
    { tag: "line", attrs: { x1: "9", y1: "9.5", x2: "9.01", y2: "9.5" } },
    { tag: "line", attrs: { x1: "15", y1: "9.5", x2: "15.01", y2: "9.5" } },
  ],
  motion: [
    { tag: "polygon", attrs: { points: "13 2 3 14 12 14 11 22 21 10 12 10 13 2" } },
  ],
  "pass-through": [
    { tag: "path", attrs: { d: "M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20" } },
  ],
  close: [
    { tag: "path", attrs: { d: "M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10" } },
  ],
  more: [
    { tag: "path", attrs: { d: "M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" } },
  ],
  back: [
    { tag: "path", attrs: { d: "M19 12H5M12 19l-7-7 7-7" } },
  ],
  check: [
    { tag: "path", attrs: { d: "M20 6L9 17l-5-5" } },
  ],
};

function createRingIcon(name) {
  const def = RING_ICONS[name];
  if (!def) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "pet-ring-icon");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  for (const item of def) {
    const elNode = document.createElementNS(SVG_NS, item.tag);
    for (const [attr, val] of Object.entries(item.attrs)) {
      elNode.setAttribute(attr, val);
    }
    svg.appendChild(elNode);
  }
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatLabel(level, key) {
  if (level === "expression") return WHALE_EXPRESSION_LABELS[key] || String(key);
  if (level === "motion") return WHALE_MOTION_LABELS[key] || String(key);
  return String(key);
}

export function createPetRing({ root, onSelect, onClose }) {
  if (!root) return { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false, refresh: () => {}, destroy: () => {} };

  let open = false;
  let level = null; // null | "model" | "expression" | "motion"
  let page = 0;
  let activeModel = null;
  let activeExpression = null;
  let activeMotion = null;
  // 键名必须与 RING_ITEMS 的 id **完全一致**（单数）：二级页查的是 options[level]，
  // 早先用复数 models/expressions 导致二级永远空白 —— 名字对不上，静默返回空数组。
  let options = { model: [], expression: [], motion: [] };

  const trackEl = el("div", "pet-ring-track");
  const listEl = el("div", "pet-ring-list");
  const titleEl = el("div", "pet-ring-title");
  const hintEl = el("div", "pet-ring-hint");
  const backBtn = el("button", "pet-ring-back", "返回");
  backBtn.type = "button";
  const headEl = el("div", "pet-ring-head");
  headEl.append(backBtn, titleEl, hintEl);
  const stageEl = el("div", "pet-ring-stage");
  stageEl.append(trackEl, headEl, listEl);
  root.append(stageEl);

  function pageCount() {
    const items = level ? options[level] || [] : RING_ITEMS;
    return Math.max(1, Math.ceil(items.length / (level ? PAGE_SIZE : RING_ITEMS.length)));
  }

  function currentItems() {
    const source = level ? options[level] || [] : RING_ITEMS;
    if (!level) return source;
    return source.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  }

  function getCategoryLabel() {
    return RING_ITEMS.find((item) => item.id === level)?.label || level || "514 桌宠";
  }

  function updateHeadDefault() {
    const pages = pageCount();
    if (level) {
      titleEl.textContent = `${getCategoryLabel()}${pages > 1 ? ` ${page + 1}/${pages}` : ""}`;
      hintEl.textContent = pages > 1 ? "滚轮或点更多翻页" : "点击执行";
    } else {
      titleEl.textContent = "514 桌宠";
      hintEl.textContent = "快捷控制";
    }
  }

  function render() {
    const items = currentItems();
    const total = level ? (options[level] || []).length : RING_ITEMS.length;
    backBtn.hidden = !level;
    updateHeadDefault();

    // 扇区角度与配色全靠 data-* 驱动（CSP 禁内联样式）。
    listEl.dataset.count = String(items.length);
    listEl.replaceChildren(...items.map((item, index) => {
      const button = el("button", "pet-ring-item");
      button.type = "button";
      button.dataset.ringIndex = String(index);
      button.dataset.ringKey = level ? String(item) : item.id;

      const itemKey = level ? String(item) : item.id;
      const displayLabel = level ? formatLabel(level, item) : item.label;
      const itemHint = level ? (formatLabel(level, item) !== String(item) ? `${displayLabel} (${item})` : displayLabel) : item.hint;
      button.title = itemHint;

      const iconType = level ? level : (item.icon || item.id);
      const icon = createRingIcon(iconType);
      if (icon) button.append(icon);

      button.append(el("span", "pet-ring-item-label", displayLabel));

      const isModelActive = level === "model" && activeModel && (item === activeModel || itemKey === activeModel);
      const isExprActive = level === "expression" && activeExpression && (item === activeExpression || itemKey === activeExpression);
      const isMotionActive = level === "motion" && activeMotion && (item === activeMotion || itemKey === activeMotion);

      if (isModelActive || isExprActive || isMotionActive) {
        button.classList.add("is-active");
      }

      button.addEventListener("mouseenter", () => {
        titleEl.textContent = displayLabel;
        if (level === "model") {
          hintEl.textContent = isModelActive ? "当前生效" : "点击切换";
        } else if (level === "expression") {
          hintEl.textContent = isExprActive ? "正在展示 · 点击重播" : "点击切换表情";
        } else if (level === "motion") {
          hintEl.textContent = isMotionActive ? "正在播放 · 点击重播" : "点击播放动作";
        } else {
          hintEl.textContent = itemHint;
        }
      });
      button.addEventListener("mouseleave", () => {
        updateHeadDefault();
      });

      return button;
    }));

    // 二级条目多于 PAGE_SIZE 时，末位给一个"更多"翻页。
    if (level && total > PAGE_SIZE) {
      const more = el("button", "pet-ring-item pet-ring-more");
      more.type = "button";
      more.dataset.ringIndex = String(items.length);
      more.dataset.ringMore = "1";
      const pages = pageCount();
      const nextPageIndex = (page + 1) % pages + 1;
      more.title = `翻页 (当前 ${page + 1}/${pages}，点击前往第 ${nextPageIndex} 页)`;
      const moreIcon = createRingIcon("more");
      if (moreIcon) more.append(moreIcon);
      more.append(el("span", "pet-ring-item-label", "更多"));

      more.addEventListener("mouseenter", () => {
        titleEl.textContent = "翻页";
        hintEl.textContent = `${page + 1}/${pages} 页`;
      });
      more.addEventListener("mouseleave", () => {
        updateHeadDefault();
      });

      listEl.append(more);
      listEl.dataset.count = String(items.length + 1);
    }
  }

  function show(nextLevel, nextPage = 0) {
    level = nextLevel;
    page = nextPage;
    open = true;
    root.hidden = false;
    render();
  }

  function close() {
    if (!open) return;
    open = false;
    level = null;
    page = 0;
    root.hidden = true;
    onClose?.();
  }

  listEl.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    event.stopPropagation();
    if (button.dataset.ringMore === "1") {
      page = (page + 1) % pageCount();
      render();
      return;
    }
    const key = button.dataset.ringKey || "";
    if (!level) {
      // 这两项不是「展开二级」，是直接动作 —— 早返回，别走 show(key)。
      if (key === "close") { close(); onSelect?.("close", ""); return; }
      if (key === "pass-through") { close(); onSelect?.("pass-through", ""); return; }
      show(key);
      return;
    }
    const value = key;
    close();
    onSelect?.(level, value);
  });

  backBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (level) show(null);
  });

  // 点击空白背景（非按钮/中心头）时收起快捷栏，提升交互便利性
  stageEl.addEventListener("click", (event) => {
    if (!event.target.closest("button") && !event.target.closest(".pet-ring-head")) {
      close();
    }
  });

  // 环内空白处点击不穿透到 canvas，避免误触发戳一戳。
  stageEl.addEventListener("pointerdown", (event) => event.stopPropagation());

  // 二级子菜单开启状态下，支持滚轮平滑翻页
  stageEl.addEventListener("wheel", (event) => {
    if (!open || !level) return;
    event.preventDefault();
    event.stopPropagation();
    const pages = pageCount();
    if (pages <= 1) return;
    if (event.deltaY > 0) {
      page = (page + 1) % pages;
    } else if (event.deltaY < 0) {
      page = (page - 1 + pages) % pages;
    }
    render();
  }, { passive: false });

  function refresh(next = {}) {
    for (const key of ["model", "expression", "motion"]) {
      if (Array.isArray(next[key])) options[key] = next[key];
    }
    if (next.activeModel !== undefined) activeModel = next.activeModel;
    if (next.activeExpression !== undefined) activeExpression = next.activeExpression;
    if (next.activeMotion !== undefined) activeMotion = next.activeMotion;
    if (open) render();
  }

  function destroy() {
    stageEl.remove();
    open = false;
  }

  return {
    open: () => show(null),
    close,
    toggle: () => (open ? close() : show(null)),
    isOpen: () => open,
    refresh,
    destroy,
  };
}
