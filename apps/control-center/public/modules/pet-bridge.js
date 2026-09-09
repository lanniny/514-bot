/**
 * pet-bridge.js — 主窗口侧桌宠桥。
 *
 * 职责：
 *   1. 设置持久化（localStorage "514cc.pet.settings"）与插件系统双向联动（514cc:plugin-* 事件）。
 *   2. 开关猫窗：桌面壳内经原生命令 set_pet_overlay(visible)；纯 Web 模式优雅降级为右下角内嵌挂件（Web Dock）。
 *   3. 凭据桥：BroadcastChannel("514cc-pet") 应答猫页的 pet-hello（token + 配置）；
 *      开窗前另写一次性 localStorage handoff 键作为降级路径（猫页读到即删）。
 *      token 不经 Rust、不进 URL/日志——与内核既有鉴权契约一致。
 *   4. 外设与脉冲桥（特化自 vladelaina/BongoCat 机制）：
 *      - 鼠标光标跟随（mousemove 节流 ~40ms）与左右键按压（mousedown/up）广播；
 *      - 键盘击键节奏、Combo 连击统计与打字脉冲（节流 120ms 后 POST /api/pet/input）。
 *      桌宠是装饰面：一切失败静默，绝不打扰主流程。
 */

import { apiReady, getAccessToken, request } from "../api.js";
import { PET_DEFAULTS, PET_MODELS, petRatio, clampDockPosition } from "../pet/pet-settings.js";
import { createPetChannel } from "../pet/pet-channel.js";

const SETTINGS_KEY = "514cc.pet.settings";
const HANDOFF_KEY = "514cc-pet-handoff";
const PULSE_THROTTLE_MS = 120;
const MOUSE_THROTTLE_MS = 40;
const COMBO_RESET_MS = 2500;

const tauriInvoke = window.__TAURI_INTERNALS__?.invoke?.bind(window.__TAURI_INTERNALS__);
const isDesktopShell = typeof tauriInvoke === "function";

function readSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      enabled: parsed.enabled === true,
      model: Object.hasOwn(PET_MODELS, parsed.model) ? parsed.model : PET_DEFAULTS.model,
      maxFps: ["30", "60", "120"].includes(String(parsed.maxFps || parsed["max-fps"])) ? String(parsed.maxFps || parsed["max-fps"]) : PET_DEFAULTS.maxFps,
      modelMirror: parsed.modelMirror === true || parsed["model-mirror"] === true,
      pointerMirror: parsed.pointerMirror === true || parsed["pointer-mirror"] === true,
      randomExpression: parsed.randomExpression === true || parsed["random-expression"] === true,
      interactive: parsed.interactive === true,
      opacity: petRatio(parsed.opacity, 0.3, 1),
      scale: petRatio(parsed.scale, 0.6, 1.8),
      dockPosition: Number.isFinite(parsed.dockPosition?.x) && Number.isFinite(parsed.dockPosition?.y) ? parsed.dockPosition : null,
      webDock: parsed.webDock !== false && parsed["web-dock"] !== false,
      mouseTracking: parsed.mouseTracking !== false && parsed["mouse-tracking"] !== false,
      lightningCombo: parsed.lightningCombo !== false && parsed["lightning-combo"] !== false,
      sound: parsed.sound === true,
    };
  } catch {
    return { enabled: false, ...PET_DEFAULTS, dockPosition: null };
  }
}

function writeSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

let settings = readSettings();
let channel = null;
let webDockElement = null;
let overlayQueue = Promise.resolve();
let overlayMutating = false;
let ready = false;
let petPluginInstalled = false;
let petPluginBound = false;
let petPluginGateReady = false;
let activePluginProjectId = "";
let pluginGateGeneration = 0;
let previewSettings = null;
const effectiveSettings = () => previewSettings || settings;
window.addEventListener("514cc:pet-visibility", (event) => {
  if (!isDesktopShell || overlayMutating || typeof event.detail?.visible !== "boolean") return;
  if (event.detail.visible && (!petPluginInstalled || !petPluginBound)) return;
  const newlyVisible = event.detail.visible && !settings.enabled;
  settings.enabled = event.detail.visible;
  writeSettings();
  broadcastConfig();
  if (newlyVisible) syncPetState();
});

function showError(message = "") {
  const node = byId("pet-setting-error");
  if (node) { node.textContent = message; node.hidden = !message; }
  const retry = byId("pet-setting-retry");
  if (retry) retry.hidden = !message;
  window.dispatchEvent(new CustomEvent("514cc:pet-runtime-status", { detail: { error: message } }));
}

function positionDock() {
  if (!webDockElement || webDockElement.dataset.settingsPreview === "true") return;
  const rect = webDockElement.getBoundingClientRect();
  const position = settings.dockPosition || { x: innerWidth - rect.width - 16, y: innerHeight - rect.height - 16 };
  const bounded = clampDockPosition(position.x, position.y, rect.width, rect.height, innerWidth, innerHeight);
  webDockElement.style.left = `${bounded.x}px`;
  webDockElement.style.top = `${bounded.y}px`;
}
window.addEventListener("resize", positionDock);
window.addEventListener("resize", positionSettingsPreview);
document.addEventListener("scroll", positionSettingsPreview, { capture: true, passive: true });

function positionSettingsPreview() {
  if (!webDockElement || webDockElement.dataset.settingsPreview !== "true") return;
  const slot = document.querySelector("[data-pet-preview-slot]");
  if (!slot) return;
  const rect = slot.getBoundingClientRect();
  webDockElement.style.setProperty("--pet-preview-left", `${rect.left}px`);
  webDockElement.style.setProperty("--pet-preview-top", `${rect.top}px`);
  webDockElement.style.setProperty("--pet-preview-width", `${rect.width}px`);
  webDockElement.style.setProperty("--pet-preview-height", `${rect.height}px`);
}

function syncWebDockPresentation() {
  if (isDesktopShell) return;
  const current = effectiveSettings();
  const preview = byId("plugin-pet-preview");
  const drawer = preview?.closest("[data-drawer]");
  const active = Boolean(webDockElement && current.enabled && current.webDock && preview && drawer && !drawer.hidden);
  if (preview) preview.hidden = !active;
  if (!webDockElement) return;
  if (active) {
    webDockElement.dataset.settingsPreview = "true";
    requestAnimationFrame(positionSettingsPreview);
    return;
  }
  delete webDockElement.dataset.settingsPreview;
  for (const name of ["--pet-preview-left", "--pet-preview-top", "--pet-preview-width", "--pet-preview-height"]) {
    webDockElement.style.removeProperty(name);
  }
  if (!webDockElement.hidden) positionDock();
}

function broadcastConfig() {
  const current = effectiveSettings();
  channel?.postMessage({ type: "pet-config", config: { ...current } });
  if (webDockElement && !webDockElement.hidden) {
    webDockElement.style.setProperty("--pet-dock-scale", String(current.scale));
    webDockElement.style.setProperty("--pet-dock-opacity", String(current.opacity));
    webDockElement.dataset.interactive = String(current.interactive);
    positionDock();
  }
}

function ensureChannel() {
  if (channel) return;
  channel = createPetChannel(() => webDockElement?.querySelector("iframe")?.contentWindow, window, isDesktopShell);
  channel.onmessage = (event) => {
    const data = event?.data || {};
    if (data.type === "pet-hello") {
      channel.postMessage({ type: "pet-token", token: getAccessToken() || "", config: { ...effectiveSettings() } });
    } else if (data.type === "pet-error") {
      showError("互动模式切换失败，请重试。");
    } else if (data.type === "pet-request" && data.request === "close") {
      settings.enabled = false;
      writeSettings();
      syncPetState();
    } else if (data.type === "pet-request" && data.request === "interactive-off") {
      settings.interactive = false;
      writeSettings();
      broadcastConfig();
    }
  };
}

async function openOverlay() {
  if (!isDesktopShell) return;
  const current = effectiveSettings();
  try {
    localStorage.setItem(HANDOFF_KEY, JSON.stringify({ token: getAccessToken() || "", at: Date.now(), config: { ...current } }));
  } catch {}
  try {
    await tauriInvoke("set_pet_overlay", { visible: true, scale: current.scale });
    showError();
  } catch (error) {
    console.warn("[pet] overlay open failed", error);
    showError("桌宠打开失败，请重试。");
    try { localStorage.removeItem(HANDOFF_KEY); } catch {}
    return;
  }
  ensureChannel();
  broadcastConfig();
}

async function closeOverlay() {
  if (!isDesktopShell) return;
  try {
    await tauriInvoke("set_pet_overlay", { visible: false });
    showError();
  } catch (error) {
    console.warn("[pet] overlay close failed", error);
    showError("桌宠关闭失败，请重试。");
  }
}

function openWebDock() {
  if (isDesktopShell) return;
  const current = effectiveSettings();
  if (!petPluginInstalled || !current.enabled || !current.webDock) {
    closeWebDock();
    return;
  }
  if (!webDockElement) {
    webDockElement = document.createElement("aside");
    webDockElement.id = "pet-web-dock";
    webDockElement.className = "pet-web-dock";
    webDockElement.setAttribute("aria-label", "514 桌宠网页挂件");

    const header = document.createElement("div");
    header.className = "pet-web-dock-header";
    header.tabIndex = 0;
    header.setAttribute("aria-label", "移动桌宠");
    header.title = "移动桌宠";
    let drag = null;
    header.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button") || webDockElement.dataset.settingsPreview === "true") return;
      const rect = webDockElement.getBoundingClientRect();
      drag = { x: event.clientX - rect.x, y: event.clientY - rect.y };
      header.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    header.addEventListener("pointermove", (event) => {
      if (!drag) return;
      settings.dockPosition = { x: event.clientX - drag.x, y: event.clientY - drag.y };
      positionDock();
    });
    const stopDrag = () => { if (drag) writeSettings(); drag = null; };
    header.addEventListener("pointerup", stopDrag);
    header.addEventListener("pointercancel", stopDrag);
    header.addEventListener("lostpointercapture", stopDrag);
    header.addEventListener("keydown", (event) => {
      if (event.target !== header || webDockElement.dataset.settingsPreview === "true" || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const rect = webDockElement.getBoundingClientRect();
      settings.dockPosition = { x: rect.x + (event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0), y: rect.y + (event.key === "ArrowDown" ? 16 : event.key === "ArrowUp" ? -16 : 0) };
      positionDock();
      writeSettings();
    });

    const label = document.createElement("span");
    label.className = "pet-web-dock-title";
    label.textContent = "514 猫";

    const actions = document.createElement("div");
    actions.className = "pet-web-dock-actions";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "pet-web-dock-btn";
    closeBtn.setAttribute("aria-label", "收起挂件");
    closeBtn.title = "收起挂件";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#lucide-x");
    svg.append(use);
    closeBtn.append(svg);
    closeBtn.addEventListener("click", () => {
      settings.enabled = false;
      writeSettings();
      syncPetState();
    });

    actions.appendChild(closeBtn);
    header.appendChild(label);
    header.appendChild(actions);

    const frame = document.createElement("iframe");
    frame.id = "pet-web-dock-frame";
    frame.className = "pet-web-dock-frame";
    frame.src = "/pet/index.html";
    frame.title = "514 桌宠画面";

    webDockElement.appendChild(header);
    webDockElement.appendChild(frame);
    document.body.appendChild(webDockElement);
  }
  webDockElement.hidden = false;
  syncWebDockPresentation();
  webDockElement.style.setProperty("--pet-dock-scale", String(current.scale));
  webDockElement.style.setProperty("--pet-dock-opacity", String(current.opacity));
  ensureChannel();
  broadcastConfig();
}

function closeWebDock() {
  if (webDockElement) {
    webDockElement.remove();
    webDockElement = null;
  }
  const preview = byId("plugin-pet-preview");
  if (preview) preview.hidden = true;
}

function syncPetState() {
  if (!ready) return;
  const current = effectiveSettings();
  const normalAllowed = petPluginGateReady && petPluginInstalled && petPluginBound && settings.enabled;
  const previewAllowed = !isDesktopShell && petPluginInstalled && Boolean(previewSettings);
  const allowed = normalAllowed || previewAllowed;
  if (isDesktopShell) {
    overlayQueue = overlayQueue.then(async () => {
      overlayMutating = true;
      try { await (allowed ? openOverlay() : closeOverlay()); }
      finally { overlayMutating = false; }
    });
  } else if (allowed && current.webDock) {
    openWebDock();
  } else {
    closeWebDock();
  }
  broadcastConfig();
}

// ---- 外设捕获：鼠标移动与按键（BongoCat 右爪映射） ----

let lastMouseAt = 0;
document.addEventListener(
  "mousemove",
  (event) => {
    if (!petPluginInstalled || !petPluginBound || !settings.enabled || !settings.mouseTracking || !ready) return;
    const now = Date.now();
    if (now - lastMouseAt < MOUSE_THROTTLE_MS) return;
    lastMouseAt = now;
    // 归一化到 [-1.0, 1.0]，中心为 0
    const normX = Math.min(1, Math.max(-1, (event.clientX / window.innerWidth) * 2 - 1));
    const normY = Math.min(1, Math.max(-1, (event.clientY / window.innerHeight) * 2 - 1));
    channel?.postMessage({
      type: "pet-mouse",
      x: normX,
      y: normY,
    });
  },
  { passive: true },
);

document.addEventListener(
  "mousedown",
  (event) => {
    if (!petPluginInstalled || !petPluginBound || !settings.enabled || !settings.mouseTracking || ![0, 2].includes(event.button)) return;
    channel?.postMessage({
      type: "pet-mouse-button",
      down: true,
      button: event.button, // 0 = left, 2 = right
    });
  },
  { passive: true },
);

document.addEventListener(
  "mouseup",
  (event) => {
    if (!petPluginInstalled || !petPluginBound || !settings.enabled || !settings.mouseTracking || ![0, 2].includes(event.button)) return;
    channel?.postMessage({
      type: "pet-mouse-button",
      down: false,
      button: event.button,
    });
  },
  { passive: true },
);

// ---- 打字脉冲与连击（BongoCat 左爪键盘节奏与 Combo 系统） ----

let lastPulseAt = 0;
let comboCount = 0;
let lastKeyAt = 0;
const resetInput = () => channel?.postMessage({ type: "pet-input-reset" });
window.addEventListener("blur", resetInput);
document.addEventListener("visibilitychange", () => { if (document.hidden) resetInput(); });

document.addEventListener(
  "keydown",
  (event) => {
    if (!petPluginInstalled || !petPluginBound || !settings.enabled || !ready || (!isDesktopShell && !webDockElement)) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const now = Date.now();
    if (now - lastKeyAt > COMBO_RESET_MS) {
      comboCount = 0;
    }
    comboCount += 1;
    lastKeyAt = now;

    // 内存直发：敲击即刻动作与当前连击数
    channel?.postMessage({
      type: "pet-key",
      code: String(event.code || ""),
      combo: comboCount,
      at: now,
    });

    if (channel || now - lastPulseAt < PULSE_THROTTLE_MS) return;
    lastPulseAt = now;
    request("/api/pet/input", { method: "POST", body: { kind: "typing" } }).catch(() => {});
  },
  { capture: true, passive: true },
);
document.addEventListener(
  "keyup",
  (event) => {
    if (!petPluginInstalled || !petPluginBound || !settings.enabled || !ready) return;
    channel?.postMessage({ type: "pet-key-up", code: String(event.code || "") });
  },
  { capture: true, passive: true },
);

// ---- 插件中心配置与运行时同步 ----

function byId(id) {
  return document.getElementById(id);
}

function previewBindingConfig(config) {
  if (!config || typeof config !== "object" || !petPluginInstalled) return;
  const preview = { ...settings };
  preview.enabled = true;
  preview.webDock = true;
  if (Object.hasOwn(PET_MODELS, config.model)) preview.model = config.model;
  if (["30", "60", "120"].includes(String(config["max-fps"]))) preview.maxFps = String(config["max-fps"]);
  if (typeof config["model-mirror"] === "boolean") preview.modelMirror = config["model-mirror"];
  if (typeof config["pointer-mirror"] === "boolean") preview.pointerMirror = config["pointer-mirror"];
  if (typeof config["random-expression"] === "boolean") preview.randomExpression = config["random-expression"];
  if (typeof config.interactive === "boolean") preview.interactive = config.interactive;
  if (Number.isFinite(config.opacity)) preview.opacity = petRatio(config.opacity, 0.3, 1, preview.opacity, true);
  if (Number.isFinite(config.scale)) preview.scale = petRatio(config.scale, 0.6, 1.8, preview.scale, true);
  const tracking = config["mouse-tracking"] ?? config.mouseTracking;
  const lightning = config["lightning-combo"] ?? config.lightningCombo;
  // The preview remains visible even when the saved Web Dock option is off.
  if (typeof tracking === "boolean") preview.mouseTracking = tracking;
  if (typeof lightning === "boolean") preview.lightningCombo = lightning;
  if (typeof config.sound === "boolean") preview.sound = config.sound;
  previewSettings = preview;
  if (byId("plugin-pet-preview")?.isConnected) syncPetState();
}

function applyBindingConfig(config, enabled) {
  let changed = false;
  if (typeof enabled === "boolean" && settings.enabled !== enabled) {
    settings.enabled = enabled;
    changed = true;
  }
  if (config && typeof config === "object") {
    if (Object.hasOwn(PET_MODELS, config.model) && settings.model !== config.model) {
      settings.model = config.model;
      changed = true;
    }
    if (["30", "60", "120"].includes(String(config["max-fps"])) && settings.maxFps !== String(config["max-fps"])) {
      settings.maxFps = String(config["max-fps"]);
      changed = true;
    }
    for (const [id, key] of [["model-mirror", "modelMirror"], ["pointer-mirror", "pointerMirror"], ["random-expression", "randomExpression"]]) {
      if (typeof config[id] === "boolean" && settings[key] !== config[id]) {
        settings[key] = config[id];
        changed = true;
      }
    }
    if (typeof config.interactive === "boolean" && settings.interactive !== config.interactive) {
      settings.interactive = config.interactive;
      changed = true;
    }
    if (Number.isFinite(config.opacity)) {
      settings.opacity = petRatio(config.opacity, 0.3, 1, settings.opacity, true);
      changed = true;
    }
    if (Number.isFinite(config.scale)) {
      settings.scale = petRatio(config.scale, 0.6, 1.8, settings.scale, true);
      changed = true;
    }
    const dock = config["web-dock"] ?? config.webDock;
    if (typeof dock === "boolean" && settings.webDock !== dock) {
      settings.webDock = dock;
      changed = true;
    }
    const tracking = config["mouse-tracking"] ?? config.mouseTracking;
    if (typeof tracking === "boolean" && settings.mouseTracking !== tracking) {
      settings.mouseTracking = tracking;
      changed = true;
    }
    const lightning = config["lightning-combo"] ?? config.lightningCombo;
    if (typeof lightning === "boolean" && settings.lightningCombo !== lightning) {
      settings.lightningCombo = lightning;
      changed = true;
    }
    if (typeof config.sound === "boolean" && settings.sound !== config.sound) {
      settings.sound = config.sound;
      changed = true;
    }
  }
  if (changed) {
    writeSettings();
    syncPetState();
  } else {
    broadcastConfig();
  }
}

function adoptPluginSnapshot(snapshot, projectId) {
  const normalizedProjectId = String(projectId || "");
  activePluginProjectId = normalizedProjectId;
  petPluginInstalled = snapshot?.installed?.some((entry) => entry.id === "desktop-pet") === true;
  const binding = normalizedProjectId
    ? snapshot?.bindings?.find((entry) => entry.pluginId === "desktop-pet" && entry.projectId === normalizedProjectId)
    : null;
  petPluginBound = petPluginInstalled && binding?.enabled === true;
  petPluginGateReady = true;
  if (petPluginBound) applyBindingConfig(binding.config, true);
  else {
    syncPetState();
    syncWebDockPresentation();
  }
}

async function refreshPluginGate(projectId = activePluginProjectId) {
  const normalizedProjectId = String(projectId || "");
  activePluginProjectId = normalizedProjectId;
  const generation = ++pluginGateGeneration;
  try {
    const snapshot = await request(`/api/plugins${normalizedProjectId ? `?projectId=${encodeURIComponent(normalizedProjectId)}` : ""}`);
    if (generation !== pluginGateGeneration || normalizedProjectId !== activePluginProjectId) return;
    adoptPluginSnapshot(snapshot, normalizedProjectId);
  } catch (error) {
    if (generation !== pluginGateGeneration || normalizedProjectId !== activePluginProjectId) return;
    console.warn("[pet] plugin gate unavailable", error);
    adoptPluginSnapshot(null, normalizedProjectId);
    showError("无法确认桌宠插件安装状态，桌宠已保持关闭。");
  }
}

// 监听插件配置更新事件（来自插件中心卡片或配置抽屉）
window.addEventListener("514cc:plugin-changed", (event) => {
  const { action, payload } = event.detail || {};
  const pluginId = payload?.pluginId || payload?.catalogId || payload?.manifest?.id;
  if (pluginId !== "desktop-pet") return;
  if (action === "install") {
    petPluginInstalled = true;
    petPluginBound = false;
    petPluginGateReady = true;
    syncPetState();
  } else if (action === "remove") {
    petPluginInstalled = false;
    petPluginBound = false;
    petPluginGateReady = true;
    syncPetState();
  } else if (action === "enable") {
    if (String(payload.projectId || "") === activePluginProjectId) {
      petPluginBound = true;
      applyBindingConfig(null, true);
    }
  } else if (action === "disable") {
    if (String(payload.projectId || "") === activePluginProjectId) {
      petPluginBound = false;
      applyBindingConfig(null, false);
    }
  } else if (action === "configure") {
    if (String(payload.projectId || "") === activePluginProjectId) {
      petPluginInstalled = true;
      petPluginBound = payload.enabled === true;
      petPluginGateReady = true;
      applyBindingConfig(payload.config, payload.enabled === true);
    }
  }
});

// 监听插件快照全量加载事件
window.addEventListener("514cc:plugin-snapshot", (event) => {
  pluginGateGeneration += 1;
  adoptPluginSnapshot(event.detail?.snapshot, event.detail?.projectId);
});
window.addEventListener("514cc:active-project-changed", (event) => {
  const projectId = String(event.detail?.projectId || "");
  if (projectId === activePluginProjectId && petPluginGateReady) return;
  void refreshPluginGate(projectId);
});

window.addEventListener("514cc:pet-settings-mounted", syncPetState);
window.addEventListener("514cc:pet-preview", (event) => {
  const detail = event.detail || {};
  if (detail.reset) {
    previewSettings = null;
    syncPetState();
  } else if (detail.action === "poke") {
    if (petPluginInstalled && (petPluginBound || previewSettings)) channel?.postMessage({ type: "pet-action", action: "poke" });
  } else if (detail.config) {
    previewBindingConfig(detail.config);
  }
});

ensureChannel();
window.addEventListener("pagehide", () => {
  channel?.close();
});

void apiReady.then(async () => {
  ready = true;
  await refreshPluginGate(document.documentElement.dataset.activeProjectId || "");
});
