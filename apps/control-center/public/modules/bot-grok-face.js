/**
 * bot-grok-face.js — 默认 Bot 聊天面（对话皮肤）。
 * 只改壳层偏好与交互：浅/深令牌、窄轨、会话列开合、胶囊输入溢出、空态建议片。
 * 壁纸/玻璃工作台面仍可选，不作为默认聊天面。
 */

export const BOT_FACE_KEY = "514cc-bot-face";
export const BOT_ROSTER_KEY = "514cc-bot-roster-collapsed";

export function readBotFacePreference() {
  try {
    return localStorage.getItem(BOT_FACE_KEY) === "workbench" ? "workbench" : "grok";
  } catch {
    return "grok";
  }
}

export function writeBotFacePreference(face) {
  const next = face === "workbench" ? "workbench" : "grok";
  try {
    localStorage.setItem(BOT_FACE_KEY, next);
  } catch {
    /* 隐私模式：只改本帧 class */
  }
  return next;
}

export function applyBotFacePreference(face = readBotFacePreference()) {
  const next = face === "workbench" ? "workbench" : "grok";
  document.documentElement.classList.toggle("is-bot-grok-face", next === "grok");
  const overflow = document.getElementById("bot-composer-overflow");
  if (overflow) overflow.open = next === "workbench";
  document.getElementById("bot-composer-more")?.setAttribute("aria-expanded", String(next === "workbench"));
  syncBotFaceControls(next);
  return next;
}

export function readRosterCollapsed() {
  try {
    return localStorage.getItem(BOT_ROSTER_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeRosterCollapsed(collapsed) {
  try {
    localStorage.setItem(BOT_ROSTER_KEY, collapsed ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function applyRosterCollapsed(collapsed = readRosterCollapsed()) {
  const grid = document.querySelector("#view-bot .bot-shell-grid");
  const chats = document.querySelector("[data-bot-rail='chats']");
  grid?.classList.toggle("is-roster-collapsed", Boolean(collapsed));
  if (chats) {
    chats.classList.toggle("is-active", !collapsed);
    chats.setAttribute("aria-pressed", String(!collapsed));
  }
  return Boolean(collapsed);
}

export function syncBotFaceControls(face = readBotFacePreference()) {
  document.querySelectorAll("[data-bot-face]").forEach((button) => {
    const active = button.dataset.botFace === face;
    button.setAttribute("aria-checked", String(active));
    button.classList.toggle("is-active", active);
  });
}

function fillComposer(text) {
  const input = document.getElementById("bot-composer-input");
  if (!input || input.disabled) return;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus({ preventScroll: true });
}

function toggleComposerOverflow(force) {
  const details = document.getElementById("bot-composer-overflow");
  const more = document.getElementById("bot-composer-more");
  if (!details) return;
  const open = typeof force === "boolean" ? force : !details.open;
  details.open = open;
  more?.setAttribute("aria-expanded", String(open));
}

function handleRail(action, button) {
  if (action === "new") {
    document.getElementById("bot-new-group-button")?.click();
    return;
  }
  if (action === "chats") {
    const grid = document.querySelector("#view-bot .bot-shell-grid");
    const next = !grid?.classList.contains("is-roster-collapsed");
    writeRosterCollapsed(next);
    applyRosterCollapsed(next);
    document.getElementById("bot-surface-tab-chats")?.click();
    return;
  }
  if (action === "contacts") {
    writeRosterCollapsed(false);
    applyRosterCollapsed(false);
    document.getElementById("bot-surface-tab-contacts")?.click();
    return;
  }
  if (action === "automations" || action === "sessions") {
    document.querySelector(`[data-workspace-view="${action}"]`)?.click();
    return;
  }
  if (action === "settings") {
    document.querySelector('[data-bot-config-open="local-runtime"]')?.click();
    return;
  }
  button?.blur?.();
}

export function bindBotGrokFace(root = document.getElementById("view-bot")) {
  if (!root || root.dataset.botGrokFaceReady === "1") {
    applyBotFacePreference();
    applyRosterCollapsed();
    return;
  }
  root.dataset.botGrokFaceReady = "1";
  applyBotFacePreference();
  applyRosterCollapsed();

  root.addEventListener("click", (event) => {
    const rail = event.target.closest("[data-bot-rail]");
    if (rail) {
      event.preventDefault();
      handleRail(rail.dataset.botRail, rail);
      return;
    }
    const chip = event.target.closest("[data-bot-suggest]");
    if (chip) {
      event.preventDefault();
      fillComposer(chip.dataset.botSuggest || "");
      return;
    }
    if (event.target.closest("#bot-composer-more")) {
      event.preventDefault();
      toggleComposerOverflow();
    }
  });

  document.getElementById("bot-composer-overflow")?.addEventListener("toggle", (event) => {
    document.getElementById("bot-composer-more")?.setAttribute("aria-expanded", String(event.currentTarget.open));
  });

  document.querySelectorAll("[data-bot-face]").forEach((button) => {
    button.addEventListener("click", () => {
      applyBotFacePreference(writeBotFacePreference(button.dataset.botFace));
    });
  });

  document.getElementById("bot-composer-seat-chip")?.addEventListener("click", (event) => {
    event.preventDefault();
    document.getElementById("bot-member-seat-button")?.click();
  });
}
