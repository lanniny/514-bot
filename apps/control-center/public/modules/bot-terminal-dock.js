/**
 * bot-terminal-dock.js — Bot 对话面底部终端抽屉。
 * 不切到 #view-terminal，PTY 懒挂载且关闭不销毁。
 */
import { createTerminalPanel } from "../terminal-panel.js";

export const BOT_TERM_KEYS = Object.freeze({
  open: "514cc-bot-term-open",
  height: "514cc-bot-term-height",
});
export const BOT_TERM_DEFAULT_HEIGHT = 240;
export const BOT_TERM_MIN = 140;

export function clampBotTerminalHeight(px, maxPx, { min = BOT_TERM_MIN } = {}) {
  const height = Number.parseFloat(px);
  const max = Number.parseFloat(maxPx);
  const floor = Number.isFinite(min) ? min : BOT_TERM_MIN;
  if (!Number.isFinite(height)) return BOT_TERM_DEFAULT_HEIGHT;
  const ceiling = Number.isFinite(max) ? Math.max(floor, max) : Math.max(floor, BOT_TERM_DEFAULT_HEIGHT);
  return Math.min(ceiling, Math.max(floor, Math.round(height)));
}

export function createBotTerminalDock({
  document: root = globalThis.document,
  window: win = globalThis.window,
  storage = globalThis.localStorage,
  createPanel = createTerminalPanel,
} = {}) {
  const drawer = root.getElementById("bot-terminal-drawer");
  const body = root.getElementById("bot-terminal-container");
  const grip = root.getElementById("bot-terminal-grip");
  const closeButton = root.getElementById("bot-terminal-close");
  const toggle = root.getElementById("global-terminal-toggle");
  if (!drawer || !body || !grip) {
    return { isOpen: () => false, setOpen() {}, syncToggle() {}, focus() {} };
  }

  const pane = drawer.closest(".bot-conversation") || drawer.parentElement;
  const maxHeight = () => {
    const rect = pane?.getBoundingClientRect?.();
    return Math.max(BOT_TERM_MIN, Math.round((rect?.height ?? 640) * 0.55));
  };
  const applyHeight = (px, { persist = false } = {}) => {
    const clamped = clampBotTerminalHeight(px, maxHeight());
    body.style.setProperty("height", `${clamped}px`);
    grip.dataset.height = String(clamped);
    if (persist) {
      try { storage?.setItem?.(BOT_TERM_KEYS.height, String(clamped)); } catch { /* ignore */ }
    }
    return clamped;
  };

  let panel = null;
  let closeTimer = 0;
  let openGeneration = 0;

  const isOpen = () => drawer.classList.contains("is-open") && drawer.hidden !== true;

  function syncToggle() {
    if (!toggle) return;
    const open = isOpen();
    toggle.setAttribute("aria-pressed", String(open));
    toggle.classList.toggle("is-active", open);
    toggle.title = open ? "收起底部终端" : "打开终端";
    toggle.setAttribute("aria-label", open ? "收起底部终端" : "打开终端");
  }

  function setOpen(open, { persist = true } = {}) {
    const generation = ++openGeneration;
    win.clearTimeout?.(closeTimer);
    drawer.closest(".bot-conversation")?.classList.toggle("is-terminal-open", Boolean(open));
    if (open) {
      drawer.hidden = false;
      const reveal = () => {
        if (generation !== openGeneration) return;
        drawer.classList.add("is-open");
        if (!panel) {
          panel = createPanel(body);
          void Promise.resolve(panel.mount?.()).then(() => panel?.focusActive?.());
        } else {
          panel.focusActive?.();
        }
      };
      if (typeof win.requestAnimationFrame === "function") {
        win.requestAnimationFrame(() => win.requestAnimationFrame(reveal));
      } else {
        reveal();
      }
    } else {
      drawer.classList.remove("is-open");
      const hide = () => {
        if (!drawer.classList.contains("is-open")) drawer.hidden = true;
      };
      const reduceMotion = win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      if (reduceMotion || !win.setTimeout) hide();
      else closeTimer = win.setTimeout(hide, 240);
    }
    if (persist) {
      try { storage?.setItem?.(BOT_TERM_KEYS.open, open ? "1" : "0"); } catch { /* ignore */ }
    }
    syncToggle();
    return open;
  }

  const savedHeight = Number.parseFloat(storage?.getItem?.(BOT_TERM_KEYS.height) || "");
  applyHeight(Number.isFinite(savedHeight) ? savedHeight : BOT_TERM_DEFAULT_HEIGHT);
  setOpen(storage?.getItem?.(BOT_TERM_KEYS.open) === "1", { persist: false });

  closeButton?.addEventListener("click", () => setOpen(false));

  grip.addEventListener("pointerdown", (event) => {
    if (!isOpen()) return;
    event.preventDefault();
    grip.setPointerCapture?.(event.pointerId);
    root.documentElement?.classList.add("forge-splitting");
    const startY = event.clientY;
    const startHeight = Number.parseFloat(grip.dataset.height || "") || BOT_TERM_DEFAULT_HEIGHT;
    const onMove = (moveEvent) => applyHeight(startHeight + (startY - moveEvent.clientY));
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      root.documentElement?.classList.remove("forge-splitting");
      applyHeight(grip.dataset.height || startHeight, { persist: true });
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  });

  grip.addEventListener("dblclick", () => {
    try { storage?.removeItem?.(BOT_TERM_KEYS.height); } catch { /* ignore */ }
    applyHeight(BOT_TERM_DEFAULT_HEIGHT, { persist: true });
  });

  grip.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const current = Number.parseFloat(grip.dataset.height || "") || BOT_TERM_DEFAULT_HEIGHT;
    applyHeight(current + (event.key === "ArrowUp" ? 16 : -16), { persist: true });
  });

  root.addEventListener("keydown", (event) => {
    if (!event.ctrlKey || event.shiftKey || event.altKey || event.key !== "`") return;
    if (!drawer.closest(".view")?.classList.contains("is-active")) return;
    event.preventDefault();
    setOpen(!isOpen());
  });

  return {
    isOpen,
    setOpen,
    toggle() { return setOpen(!isOpen()); },
    syncToggle,
    focus() { panel?.focusActive?.(); },
    syncCwd(label) {
      const cwd = root.getElementById("bot-terminal-cwd");
      if (cwd) cwd.textContent = label || "";
    },
  };
}
