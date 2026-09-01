/**
 * Context menu presentation layer (UI-AUDIT Wave B extraction, 2026-08-31).
 * Extracted from app.js's "context menu" section: show/hide, viewport edge clamping,
 * keyboard navigation, focus restoration, and trigger button markup.
 * Menu content (which items each view provides) is unrelated to presentation and remains in app.js;
 * icon set is injected via dependency injection (MENU_ICONS stays in app.js, shared with pin marks and other renderings).
 */

import { escapeHtml } from "../utils.js";

export function createContextMenu({ getMenuRoot, icons }) {
  let cleanup = null;
  let lastPos = { x: 0, y: 0 }; // 二级菜单（如「从属团队」）在原位重开

  function hide(options) {
    cleanup?.(options);
  }

  function show(items, x, y, { restoreFocus = document.activeElement } = {}) {
    hide({ restoreFocus: false });
    lastPos = { x, y };
    const menu = getMenuRoot();
    const returnFocus = restoreFocus instanceof HTMLElement ? restoreFocus : null;
    const trigger = returnFocus?.matches("[data-context-menu-trigger]") ? returnFocus : null;
    menu.innerHTML = items
      .map((item, index) =>
        item === "---"
          ? `<div class="menu-separator" role="separator"></div>`
          : `<button type="button" role="menuitem" data-menu-index="${index}"${item.danger ? ' class="is-danger"' : ""}${item.disabled ? " disabled" : ""}>
            <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[item.icon] ?? icons.plus}" /></svg>
            <span>${escapeHtml(item.label)}</span>
          </button>`,
      )
      .join("");
    menu.hidden = false;
    trigger?.setAttribute("aria-expanded", "true");
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    const focusables = () => [...menu.querySelectorAll("[data-menu-index]:not(:disabled)")];
    focusables()[0]?.focus();
    const onPick = (event) => {
      const button = event.target.closest("[data-menu-index]");
      if (!button || button.disabled) return;
      const item = items[Number(button.dataset.menuIndex)];
      hide();
      item?.action?.();
    };
    const onDismiss = (event) => {
      if (!menu.contains(event.target)) hide();
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        hide();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const list = focusables();
      if (!list.length) return;
      event.preventDefault();
      const current = list.indexOf(document.activeElement);
      const next = event.key === "ArrowDown" ? (current + 1) % list.length : (current - 1 + list.length) % list.length;
      list[next].focus();
    };
    const onWindowBlur = () => hide({ restoreFocus: false });
    menu.addEventListener("click", onPick);
    document.addEventListener("pointerdown", onDismiss, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onWindowBlur, { once: true });
    cleanup = ({ restoreFocus: shouldRestore = true } = {}) => {
      menu.hidden = true;
      trigger?.setAttribute("aria-expanded", "false");
      menu.removeEventListener("click", onPick);
      document.removeEventListener("pointerdown", onDismiss, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onWindowBlur);
      cleanup = null;
      if (shouldRestore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }

  function showFromTrigger(trigger, items) {
    const rect = trigger.getBoundingClientRect();
    show(items, rect.left, rect.bottom + 4, { restoreFocus: trigger });
  }

  function triggerMarkup(kind, id, label) {
    const attribute = kind === "run" ? "data-run-menu" : "data-project-menu";
    // 「…」用填充圆点：stroke 零长段在 12px 下不足 1px 视觉隐形（LO 2026-08-11「图标还是没有显示」）；
    // path 级 fill/stroke 属性压过 .icon 的继承值（fill:none / stroke:currentColor）
    return `<button class="row-action row-menu-action" type="button" ${attribute}="${escapeHtml(id)}"
    data-context-menu-trigger aria-haspopup="menu" aria-expanded="false" aria-controls="context-menu"
    title="更多操作" aria-label="${escapeHtml(label)}">
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${icons.more}" fill="currentColor" stroke="none" /></svg>
  </button>`;
  }

  return {
    show,
    hide,
    showFromTrigger,
    triggerMarkup,
    lastPosition: () => lastPos,
  };
}
