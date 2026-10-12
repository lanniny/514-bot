/**
 * pet-engine.js — 514 桌宠引擎（透明悬浮窗与 Web Dock 内运行）。
 * 特化并完善自 vladelaina/BongoCat（C/C++ × SDL3 × OpenGL Live2D 机制）。
 *
 * 核心功能与参数驱动：
 *   1. 右手鼠标光标跟随（ParamMouseX, ParamMouseY）与左右键按压（ParamMouseLeftDown, ParamMouseRightDown）。
 *   2. 左手打字真实敲击节奏（CatParamLeftHandDown）与 APM/Combo 连击统计系统。
 *   3. 连击狂热与闪电特效（Lightning Combo Mode: Param, Param2）。
 *   4. 彩蛋表情体系：
 *      - 酷炫黑帮墨镜（Param4: thuglife）：超高连击（Combo >= 25）或双击/连击触发；
 *      - 天使光环（Param5: 升天）：任务完成欢庆或深度推理触发；
 *      - 挥手致意（Param3: 挥手）：审批等待时持续挥手提醒；
 *      - 害羞腮红（ParamCheek）：戳一戳互动时泛红打气。
 *   5. 可配置音效反馈：开启 sound 时播放灵动清脆的敲击与喵鸣音效。
 *   6. 双流消费：/api/events（bot 状态感知）+ /api/pet/stream（瞬态外设脉冲）。
 */

import { createPetActivity } from "./pet-state.js";
import { consumePetStream } from "./pet-stream.js";
import { createPetChannel, createPetCommandChannel } from "./pet-channel.js";
import { createPetRing } from "./pet-ring.js";
import { PET_MODELS, PET_DEFAULTS } from "./pet-settings.js";

const HANDOFF_KEY = "514cc-pet-handoff";
const PAIR_RETRY_MS = 2000;
const COMBO_TIMEOUT_MS = 2500;
const LEFT_HAND_CODES = new Set([
  "Backquote", "Tab", "CapsLock", "ShiftLeft", "ControlLeft", "AltLeft", "MetaLeft", "Space",
  ...["Q", "W", "E", "R", "T", "A", "S", "D", "F", "G", "Z", "X", "C", "V", "B"].map((key) => `Key${key}`),
  ...["1", "2", "3", "4", "5"].map((key) => `Digit${key}`),
]);
const activity = createPetActivity();
const isDesktop = typeof window.__TAURI_INTERNALS__?.invoke === "function";
const isDock = window.parent !== window;

const body = document.body;
const statusEl = document.getElementById("pet-status");
const modeBackgroundEl = document.getElementById("pet-mode-background");
const inputOverlayEls = {
  left: document.getElementById("pet-left-input"),
  right: document.getElementById("pet-right-input"),
};

const state = {
  petState: "loading",
  token: null,
  modelId: "standard",
  loadedModelId: null,
  maxFps: 60,
  modelMirror: false,
  pointerMirror: false,
  randomExpression: false,
  nextExpressionAt: 0,
  interactive: false,
  opacity: 1,
  scale: 1,
  mouseTracking: true,
  lightningCombo: true,
  sound: false,
  /** 鼠标移入自动隐藏（上游 hide_on_hover，默认开，延迟 1s）。 */
  hideOnHover: true,
  combo: 0,
  targetMouseX: 0,
  targetMouseY: 0,
  currentMouseX: 0,
  currentMouseY: 0,
  mouseLeftDown: false,
  mouseRightDown: false,
  thuglifeUntil: 0,
  pokeUntil: 0,
  pokeCount: 0,
  lastTapAt: 0,
  tapUntil: 0,
  leftTapUntil: 0,
  rightTapUntil: 0,
  model: null,
  baseSize: null,
  rendererStatus: "loading",
  rendererError: "",
  /** 插件台账 revision：环形快捷栏改模型时要带它做 CAS。 */
  pluginRevision: 0,
  /** 环形菜单里刚改过透明度/缩放时，抑制「移入隐藏」—— 那明显是在调参，不是在路过。 */
  tuningUntil: 0,
  /** 已因移入而隐藏（原生侧同步执行 set_opacity）。 */
  hoverHidden: false,
};
let disposed = false;
let pixiApp = null;
let pairingTimer = null;
const streams = [];
const connections = new Map();
let lastEventSequence = 0;
let streamEpoch = null;
let streamGeneration = 0;

/** 当前模型的描述条目（猫或通用模型）。 */
function currentModel(modelId = state.modelId) {
  return PET_MODELS[modelId] || PET_MODELS[PET_DEFAULTS.model];
}

/** 通用模型（非 BongoCat 猫）没有 resources/ 目录约定，也不吃猫的输入贴图。 */
function isGenericModel(modelId = state.modelId) {
  return currentModel(modelId).kind === "generic";
}

function modelAsset(relative, modelId = state.modelId) {
  if (isGenericModel(modelId)) return null;
  return `/vendor/pet-models/bongo-${modelId}/resources/${relative}`;
}

function refreshModelArtwork() {
  if (!modeBackgroundEl) return;
  // 通用模型没有 background.png / 按键贴图；隐藏这两层而不是去 404。
  if (isGenericModel()) {
    modeBackgroundEl.hidden = true;
    modeBackgroundEl.removeAttribute("src");
    for (const node of Object.values(inputOverlayEls)) {
      if (!node) continue;
      node.hidden = true;
      node.removeAttribute("src");
      delete node.dataset.inputName;
    }
    return;
  }
  modeBackgroundEl.src = modelAsset("background.png");
  modeBackgroundEl.hidden = false;
  for (const node of Object.values(inputOverlayEls)) {
    if (!node) continue;
    node.hidden = true;
    node.removeAttribute("src");
    delete node.dataset.inputName;
  }
}

function inputAssetName(code) {
  const safe = String(code || "").replace(/[^A-Za-z0-9]/g, "");
  return /^F\d+$/.test(safe) ? "Fn" : safe;
}

function setInputArtwork(side, code, pressed = true) {
  if (isGenericModel()) return;
  const node = inputOverlayEls[side];
  const name = inputAssetName(code);
  if (!node || !name) return;
  if (!pressed) {
    if (node.dataset.inputName === name) {
      node.hidden = true;
      node.removeAttribute("src");
      delete node.dataset.inputName;
    }
    return;
  }
  if (node.dataset.inputName === name && !node.hidden) return;
  const group = state.modelId === "standard" ? "left-keys" : `${side}-keys`;
  node.src = modelAsset(`${group}/${name}.png`);
  node.dataset.inputName = name;
  node.hidden = false;
}
for (const node of Object.values(inputOverlayEls)) {
  node?.addEventListener("error", () => {
    node.hidden = true;
    node.removeAttribute("src");
    delete node.dataset.inputName;
  });
}

function setState(next, statusText) {
  state.petState = next;
  body.dataset.petState = next;
  if (statusEl) {
    const show = ["loading", "pairing", "error", "attention", "reconnecting", "failure"].includes(next);
    statusEl.textContent = show ? (statusText ?? "") : "";
  }
  const retry = document.getElementById("pet-retry");
  if (retry) retry.hidden = !["error", "pairing", "reconnecting"].includes(next);
}

function refreshState() {
  if (disposed) return;
  if (state.rendererStatus === "error") return setState("error", state.rendererError);
  if (state.rendererStatus !== "ready") return setState("loading", "正在唤醒猫…");
  if (!state.token) return setState("pairing", "等待工作台连接…");
  if (connections.size < 2 || [...connections.values()].some((value) => value !== "connected")) {
    return setState("reconnecting", "连接恢复中…");
  }
  const next = activity.snapshot();
  setState(next.name, next.text);
  syncGenericExpression(next.name);
}

// ---------------------------------------------------------------- 音频合成（零依赖低延迟 Web Audio）

let audioCtx = null;

function ensureAudio() {
  if (!state.sound) return null;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") void audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch {
    return null;
  }
}

function playKeyClick() {
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    // 模拟木质键盘/机械键轴触底声
    osc.frequency.setValueAtTime(420 + Math.random() * 80, now);
    osc.frequency.exponentialRampToValueAtTime(75, now + 0.035);
    gain.gain.setValueAtTime(0.07, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.04);
  } catch {}
}

function playChime() {
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, now + i * 0.07);
      gain.gain.setValueAtTime(0.05, now + i * 0.07);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.07 + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.07);
      osc.stop(now + i * 0.07 + 0.2);
    });
  } catch {}
}

// ---------------------------------------------------------------- 凭据配对与广播桥

let channel = null;

function consumeFragmentKey() {
  try {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const key = fragment.get("pet-key");
    if (!key) return null;
    const raw = window.localStorage.getItem(key);
    window.localStorage.removeItem(key);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    return typeof payload?.token === "string" && payload.token ? payload.token : null;
  } catch {
    return null;
  }
}

function adoptToken(token, source) {
  if (!token || state.token === token || disposed) return;
  state.token = token;
  console.info(`[pet] credential paired via ${source}`);
  startStreams();
  refreshState();
}

function startPairing() {
  try {
    const raw = window.localStorage.getItem(HANDOFF_KEY);
    if (raw) {
      window.localStorage.removeItem(HANDOFF_KEY);
      const payload = JSON.parse(raw);
      if (typeof payload?.token === "string" && payload.token && Date.now() - payload.at < 30_000) {
        adoptToken(payload.token, "localStorage-handoff");
        if (payload.config) applyConfig(payload.config);
      }
    }
  } catch {}
  const direct = consumeFragmentKey();
  if (direct) adoptToken(direct, "fragment-key");

  // 反向指令通道：环形快捷栏的模型切换要落到主窗口（再落服务端台账）。
  commandChannel = createPetCommandChannel(() => isDock ? window.parent : null, window, isDesktop);
  commandChannel.onmessage = (event) => {
    if (event?.data?.type === "pet-command-result") onPetCommandResult(event.data);
  };

  {
    channel = createPetChannel(() => isDock ? window.parent : null, window, isDesktop);
    channel.onmessage = (event) => {
      const data = event?.data || {};
      if (data.type === "pet-token" && typeof data.token === "string" && data.token) {
        adoptToken(data.token, "broadcast");
        if (data.config) applyConfig(data.config);
        if (Number.isSafeInteger(data.revision)) state.pluginRevision = data.revision;
      } else if (data.type === "pet-config") {
        applyConfig(data.config || {});
        if (Number.isSafeInteger(data.revision)) state.pluginRevision = data.revision;
      } else if (data.type === "pet-mouse") {
        if (state.mouseTracking !== false) {
          state.targetMouseX = Number(data.x) || 0;
          state.targetMouseY = Number(data.y) || 0;
        }
      } else if (data.type === "pet-mouse-button") {
        if (data.button === 2) state.mouseRightDown = Boolean(data.down);
        else state.mouseLeftDown = Boolean(data.down);
        if (data.down) onActivity({ kind: "mouse" });
      } else if (data.type === "pet-key") {
        state.combo = Number(data.combo) || (state.combo + 1);
        const code = String(data.code || "");
        const side = LEFT_HAND_CODES.has(code) ? "left" : "right";
        const hand = side === "left" ? "leftTapUntil" : "rightTapUntil";
        state[hand] = Date.now() + 150;
        setInputArtwork(side, code, true);
        if (state.combo >= 25 && !state.thuglifeUntil) {
          state.thuglifeUntil = Date.now() + 4000;
        }
        onActivity({ kind: "typing" });
      } else if (data.type === "pet-key-up") {
        const code = String(data.code || "");
        setInputArtwork(LEFT_HAND_CODES.has(code) ? "left" : "right", code, false);
      } else if (data.type === "pet-action" && data.action === "poke") {
        onActivity({ kind: "poke" });
      } else if (data.type === "pet-input-reset") {
        resetPointer();
      }
    };
  }
  const announce = () => {
    channel?.postMessage({ type: "pet-hello" });
  };
  announce();
  pairingTimer = setInterval(() => { if (!state.token) announce(); }, PAIR_RETRY_MS);
}

// ---------------------------------------------------------------- 滚轮：缩放与透明度
//
// 对齐上游 BongoCat（window_wheel.c）：
//   · 滚轮           → 缩放，每格 5%，范围 10%~500%（我们窗口更小，收到 60%~180%）
//   · Ctrl + 滚轮    → 透明度，每格 5%，范围 10%~100%
//
// **不落台账**：上游改的是 session 值（wheel_*_target），重启回默认。这里同理 ——
// 滚轮是临时微调，持久值由插件面板/环形菜单决定。否则连续滚轮会打爆台账 CAS。
const WHEEL_SCALE_STEP = 0.05;
const WHEEL_OPACITY_STEP = 0.05;
const WHEEL_SCALE_RANGE = [0.6, 1.8];
const WHEEL_OPACITY_RANGE = [0.1, 1];

function onWheel(event) {
  if (!state.interactive) return; // 穿透模式下窗口收不到事件，这里是防御性兜底
  event.preventDefault();
  // 环形菜单开着时滚轮用于翻页，不调参。
  if (ring?.isOpen()) return;
  const delta = Math.sign(event.deltaY);
  if (!delta) return;
  // 刚调过就抑制「移入隐藏」：连续滚轮显然是在调参，不是在路过。
  state.tuningUntil = Date.now() + 1500;
  if (event.ctrlKey) {
    state.opacity = Math.min(WHEEL_OPACITY_RANGE[1], Math.max(WHEEL_OPACITY_RANGE[0],
      state.opacity - delta * WHEEL_OPACITY_STEP));
    body.style.opacity = String(isDock ? 1 : state.opacity);
  } else {
    state.scale = Math.min(WHEEL_SCALE_RANGE[1], Math.max(WHEEL_SCALE_RANGE[0],
      state.scale + delta * WHEEL_SCALE_STEP));
    fitModel();
  }
}

// ---------------------------------------------------------------- 鼠标移入自动隐藏
//
// 对齐上游 BongoCat 的 hide_on_hover。**关键前提**：上游把它门控在
// `hide_on_hover && pass_through && always_on_top`（mouse.c:18-20）——
// 只在**穿透模式**下才隐藏。互动模式下隐藏等于自杀：鼠标一进来桌宠就没了，
// 既没法拖也没法点，用户会以为崩了。
//
// **为什么必须借原生**：窗口在透明区域上是穿透的，鼠标划过模型旁边的空白，
// 页面收不到 pointerenter/leave —— 前端判断不出"光标进来了没有"。
// 所以页面负责上报窗口几何，原生侧拿**全局光标位置**做矩形判定。
//
// 隐藏用整窗透明度（Win32 SetLayeredWindowAttributes），不是 body 的 CSS opacity ——
// 后者只影响绘制内容，未绘制区域照样挡鼠标。
const HOVER_HIDE_DELAY_MS = 1000;
const HOVER_POLL_MS = 250;
let hoverTimer = null;
let hoverInsideSince = 0;

async function syncNativeHoverLoop() {
  if (!isDesktop || hoverTimer) return;
  const rect = await tauriInvoke("plugin:window|inner_position")?.catch?.(() => null);
  const size = await tauriInvoke("plugin:window|inner_size")?.catch?.(() => null);
  if (rect && size) {
    await tauriInvoke("set_pet_overlay_rect", {
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(size.width), height: Math.round(size.height),
    })?.catch?.(() => {});
  }
  hoverTimer = setInterval(async () => {
    // 上游门控：只在穿透（=非互动）时隐藏。互动模式下这条整体关掉。
    if (!isDesktop || !state.hideOnHover || state.interactive) {
      if (state.hoverHidden) {
        state.hoverHidden = false;
        void tauriInvoke("set_pet_overlay_hover", { hidden: false })?.catch?.(() => {});
      }
      return;
    }
    const inside = await tauriInvoke("pet_pointer_inside")?.catch?.(() => false);
    if (inside) {
      if (!hoverInsideSince) hoverInsideSince = Date.now();
      // 调参期间（刚滚过轮/开着环）不隐藏 —— 那是在用，不是在路过。
      const tuning = ring?.isOpen() || Date.now() < state.tuningUntil;
      if (!tuning && Date.now() - hoverInsideSince >= HOVER_HIDE_DELAY_MS && !state.hoverHidden) {
        state.hoverHidden = true;
        void tauriInvoke("set_pet_overlay_hover", { hidden: true })?.catch?.(() => {});
      }
    } else {
      hoverInsideSince = 0;
      if (state.hoverHidden) {
        state.hoverHidden = false;
        void tauriInvoke("set_pet_overlay_hover", { hidden: false })?.catch?.(() => {});
      }
    }
  }, HOVER_POLL_MS);
}

// ---------------------------------------------------------------- 配置同步

function applyConfig(config) {
  if (Object.hasOwn(PET_MODELS, config.model) && state.modelId !== config.model) {
    state.modelId = config.model;
    refreshModelArtwork();
    if (rendererBooting) pendingModelReload = true;
    else if (state.model) void bootRenderer();
    // 换了模型，环形菜单的表情/动作池也得跟着换（每个模型的素材不同）。
    refreshRing();
  }
  if ([30, 60, 120].includes(Number(config.maxFps))) {
    state.maxFps = Number(config.maxFps);
    if (pixiApp) pixiApp.ticker.maxFPS = state.maxFps;
  }
  if (typeof config.modelMirror === "boolean" && state.modelMirror !== config.modelMirror) {
    state.modelMirror = config.modelMirror;
    fitModel();
  }
  if (typeof config.pointerMirror === "boolean") state.pointerMirror = config.pointerMirror;
  if (typeof config.randomExpression === "boolean") {
    state.randomExpression = config.randomExpression;
    state.nextExpressionAt = config.randomExpression ? Date.now() + 5000 : 0;
  }
  if (typeof config.interactive === "boolean") setInteractive(config.interactive);
  // 上游 BongoCat：滚轮缩放 / Ctrl+滚轮透明度写的是 session 值，不是持久配置
  // （window_wheel.c 只动 wheel_*_target，重启回默认）。这里同理 —— 只有**环形菜单**
  // 里的「尺寸 / 透明度」才落台账。鼠标移入隐藏只在前端（写的是窗口原生 alpha）。
  if (Number.isFinite(config.opacity)) {
    state.opacity = Math.min(1, Math.max(0.15, Number(config.opacity)));
    body.style.opacity = String(isDock ? 1 : state.opacity);
  }
  if (Number.isFinite(config.scale)) {
    state.scale = isDock ? 1 : Math.min(1.8, Math.max(0.6, Number(config.scale)));
    fitModel();
  }
  // 未暴露成设置项的上游行为：移入隐藏（默认开，延迟 1s）+ 圆角（默认开）。
  // 不放进插件清单，是为了不让设置面板继续膨胀 —— 它们是窗口观感，不是配置。
  if (typeof config.hideOnHover === "boolean") state.hideOnHover = config.hideOnHover;
  // 原生侧不知道窗口在哪、也收不到透明区域的鼠标事件，所以由页面主动上报几何与悬停。
  if (isDesktop) {
    void syncNativeHoverLoop();
  }
  const tracking = config["mouse-tracking"] ?? config.mouseTracking;
  if (typeof tracking === "boolean") {
    state.mouseTracking = tracking;
    if (!tracking) resetPointer();
  }
  const lightning = config["lightning-combo"] ?? config.lightningCombo;
  if (typeof lightning === "boolean") state.lightningCombo = lightning;
  if (typeof config.sound === "boolean") state.sound = config.sound;
}

function tauriInvoke(command, args) {
  return window.__TAURI_INTERNALS__?.invoke?.(command, args);
}

function setInteractive(next) {
  state.interactive = Boolean(next);
  body.dataset.interactive = String(state.interactive);
  const canvas = document.getElementById("pet-canvas");
  if (canvas) {
    canvas.tabIndex = state.interactive ? 0 : -1;
    canvas.setAttribute("role", state.interactive ? "button" : "img");
    canvas.setAttribute("aria-label", state.interactive ? "戳一戳桌宠" : "514 桌宠");
  }
  fitModel();
  if (!isDesktop) return;
  const result = tauriInvoke("plugin:window|set_ignore_cursor_events", { value: !state.interactive });
  result?.catch?.(() => channel?.postMessage({ type: "pet-error", message: "互动模式切换失败，请重试。" }));
}

// 顶栏已移除（会盖住 300×280 窗口里的模型，且与「拖模型」的直觉冲突）。
// 「退出互动 / 收起桌宠」改由右键环形菜单承担，见 handleRingSelect。
document.getElementById("pet-retry")?.addEventListener("click", () => {
  if (state.rendererStatus === "error") void bootRenderer();
  channel?.postMessage({ type: "pet-hello" });
  if (state.token) startStreams();
});

// ---------------------------------------------------------------- 环形快捷栏
//
// 右键桌宠弹出环形菜单（一级：模型/表情/动作/互动/收起；二级：具体条目）。
// 只在互动模式可用 —— 穿透模式下窗口根本收不到鼠标事件（native.rs:498
// set_ignore_cursor_events(true)），环弹不出来，这不是缺陷是前提。
//
// 模型走服务端（持久配置的真源是插件台账）；表情与动作是一次性演出，本地处理。

let ring = null;
let commandChannel = null;
let ringPendingExpression = null;
let ringExpressionUntil = 0;
let ringPendingMotion = null;
let ringMotionUntil = 0;

function ringOptions() {
  const model = currentModel();
  // 键名与 pet-ring.js 的 RING_ITEMS id 一致（单数）。名字对不上 = 二级页永远空白。
  return {
    model: Object.keys(PET_MODELS).map((id) => PET_MODELS[id].label || id),
    expression: [...(model.expressions || [])],
    motion: [...(model.motions || [])],
  };
}

/** 二级页选中的是「标签」，要映射回内部 id / 语义名。 */
function modelIdForLabel(label) {
  return Object.keys(PET_MODELS).find((id) => (PET_MODELS[id].label || id) === label) || null;
}

function onPetCommandResult(data) {
  if (data?.action !== "set-model") return;
  if (data.ok) return; // 乐观更新已生效，回执只用于失败回滚。
  // 服务端拒了（revision 过期 / 未知模型）：把界面拉回台账真值，别停在假状态。
  ringPendingExpression = null;
  ringExpressionUntil = 0;
  ringPendingMotion = null;
  ringMotionUntil = 0;
  channel?.postMessage({ type: "pet-hello" });
}

const BONGO_EXPRESSION_MAP = Object.freeze({
  "恢复": "live2d_expression0.exp3.json",
  "墨镜": "live2d_expression1.exp3.json",
  "升天": "live2d_expression2.exp3.json",
});

function refreshRing() {
  if (!ring) return;
  ring.refresh({
    ...ringOptions(),
    activeModel: currentModel().label || state.modelId,
    activeExpression: ringPendingExpression,
    activeMotion: ringPendingMotion,
  });
}

function handleRingSelect(type, value) {
  if (type === "close") { channel?.postMessage({ type: "pet-request", request: "close" }); return; }
  if (type === "pass-through") { channel?.postMessage({ type: "pet-request", request: "interactive-off" }); return; }
  if (type === "model") {
    const model = modelIdForLabel(value);
    if (model) commandChannel?.postMessage({ type: "set-model", model, revision: state.pluginRevision });
    return;
  }
  if (type === "expression") { void playRingExpression(value); return; }
  if (type === "motion") {
    const model = currentModel();
    const group = model.emoteGroup || (isGenericModel() ? "Emote" : "CAT_motion");
    const motions = model.motions || [];
    let index = motions.indexOf(value);
    if (isGenericModel()) {
      const whaleMap = { bubblegum: 0, ketchup: 1, "open-phone": 2, selfie: 3, "selfie-quick": 4, spray: 5 };
      if (Object.hasOwn(whaleMap, value)) index = whaleMap[value];
    }
    if (index >= 0) {
      ringPendingMotion = value;
      ringMotionUntil = Date.now() + 4500;
      if (!isGenericModel()) {
        if (value === "拍桌") {
          state.tapUntil = Date.now() + 2000;
          playKeyClick();
        }
      }
      playChime();
      void state.model?.motion?.(group, index, 3)?.catch?.(() => {});
      refreshRing();
      window.setTimeout(() => {
        if (ringPendingMotion !== value) return;
        ringPendingMotion = null;
        ringMotionUntil = 0;
        refreshRing();
      }, 4500);
    }
  }
}

/**
 * 环形菜单选的表情是「一次性演出」：播完自动回到当前 AI 状态该有的脸，
 * 而不是永久覆盖 —— 否则用户随手点一张，状态驱动就再也接管不回来了。
 */
async function playRingExpression(name) {
  if (!name) return;
  const model = currentModel();
  if (!(model.expressions || []).includes(name)) return;
  try {
    const target = isGenericModel() ? name : (BONGO_EXPRESSION_MAP[name] || name);
    if (!isGenericModel() && name === "恢复") {
      ringPendingExpression = null;
      ringExpressionUntil = 0;
      ringPendingMotion = null;
      ringMotionUntil = 0;
      state.thuglifeUntil = 0;
      state.pokeUntil = 0;
      state.tapUntil = 0;
      void state.model?.expression?.("live2d_expression0.exp3.json")?.catch?.(() => {});
      playChime();
      refreshRing();
      return;
    }
    ringPendingExpression = name;
    ringExpressionUntil = Date.now() + 6000;
    if (!isGenericModel()) {
      if (name === "墨镜") state.thuglifeUntil = ringExpressionUntil;
    }
    await state.model?.expression?.(target);
    playChime();
    refreshRing();
    window.setTimeout(() => {
      if (ringPendingExpression !== name) return;
      ringPendingExpression = null;
      ringExpressionUntil = 0;
      refreshRing();
      if (isGenericModel()) {
        // 强制下一次 syncGenericExpression 重新应用当前状态的表情。
        lastGenericExpression = null;
        lastGenericPoolState = null;
        syncGenericExpression(state.petState);
      } else {
        void state.model?.expression?.("live2d_expression0.exp3.json")?.catch?.(() => {});
      }
    }, 6000);
  } catch {}
}

// 桌面壳与 Web Dock 都建环：环只在互动模式可弹，而互动模式在两种宿主下都可达
// （Web Dock 里 setInteractive 早退于 tauriInvoke，但 state.interactive 照样置位）。
// 早先只在 isDesktop 下建环，导致 Web Dock 里右键毫无反应 —— 同一个功能两种宿主两种行为。
{
  ring = createPetRing({
    root: document.getElementById("pet-ring"),
    onSelect: handleRingSelect,
    onClose: () => {},
  });
  refreshRing();
  // 右键在环与画布上都生效（互动模式下窗口已可接收鼠标事件）。
  for (const node of [document.body, document.getElementById("pet-canvas")].filter(Boolean)) {
    node.addEventListener("contextmenu", (event) => {
      if (!state.interactive) return;
      event.preventDefault();
      ring.toggle();
    });
  }
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ring.isOpen()) ring.close();
  });
  // 滚轮调参 + 移入隐藏：挂在 body 上（模型画布只是窗口的一部分，
  // 用户会把光标移到模型旁边的空白处 —— 那里也该算"在桌宠上"）。
  document.body.addEventListener("wheel", onWheel, { passive: false });
  // 原生每 250ms 拿全局光标位置判进出；页面不再自己做 pointerenter/leave
  // （透明区域上页面收不到事件，判不出来）。
  if (isDesktop) void syncNativeHoverLoop();
}

// ---------------------------------------------------------------- SSE 消费

function startStreams() {
  const generation = ++streamGeneration;
  for (const stream of streams.splice(0)) stream.stop();
  connections.clear();
  const consume = (options) => {
    const stream = consumePetStream({
      ...options,
      getToken: () => state.token,
      onStatus: (value) => {
        if (generation !== streamGeneration || disposed) return;
        connections.set(options.label, value);
        refreshState();
      },
      onUnauthorized: (rejectedToken) => {
        if (generation !== streamGeneration || disposed) return;
        if (state.token === rejectedToken) state.token = null;
        channel?.postMessage({ type: "pet-hello" });
      },
    });
    streams.push(stream);
  };
  // 瞬态脉冲流（无游标）
  consume({
    label: "pet-stream",
    buildUrl: () => "/api/pet/stream",
    onFrame: (frame) => {
      const eventName = frame.event;
      if (eventName === "typing" || eventName === "poke" || eventName === "mouse") onActivity({ kind: eventName });
    },
  });
  // bot 事件流（带游标续订）
  consume({
    label: "events",
    buildUrl: () => `/api/events?after=${lastEventSequence}&view=ui`,
    onResponse: (response) => {
      const epoch = response.headers.get("x-514cc-stream-epoch");
      if (streamEpoch && epoch && epoch !== streamEpoch) {
        streamEpoch = epoch;
        lastEventSequence = 0;
        activity.reset();
        return false;
      }
      streamEpoch = epoch;
      return true;
    },
    onFrame: (frame) => {
      const sequence = Number(frame.id);
      if (Number.isSafeInteger(sequence) && sequence > 0) {
        if (sequence <= lastEventSequence) return;
        lastEventSequence = sequence;
      }
      const dataField = frame.data;
      if (!dataField) return;
      let envelope;
      try {
        envelope = JSON.parse(dataField);
      } catch {
        return;
      }
      ingestBotEvent(envelope);
    },
  });
}

// ---------------------------------------------------------------- 状态机与外设反应

function onActivity({ kind }) {
  const t = Date.now();
  activity.activity();
  state.tapUntil = t + (kind === "poke" ? 240 : 140);
  if (kind === "poke") {
    state.pokeUntil = t + 1200;
    state.pokeCount += 1;
    if (state.pokeCount % 4 === 0) {
      state.thuglifeUntil = t + 3500;
    }
    playChime();
  } else if (kind === "typing") {
    state.lastTapAt = t;
    playKeyClick();
  }
  refreshState();
}

function ingestBotEvent(envelope) {
  const effect = activity.ingest(envelope);
  if (effect === "typing") {
    const t = Date.now();
    state.lastTapAt = t;
    state.tapUntil = t + 140;
    state.combo = Math.min(state.combo + 2, 40);
    playKeyClick();
  }
  if (effect === "celebrate" && activity.snapshot().name === "celebrate") {
    triggerCelebrate();
  }
  refreshState();
}

/**
 * 通用模型的语义表情切换。
 *
 * 与猫分支的差别：猫的表情是 0..2 索引；通用模型按条目声明的语义名寻址。
 * exp3 是「参数=固定值 + Add」的常驻开关，不清会叠加污染 —— 所以状态一变
 * 必须先把上一个换掉（pixi-live2d 的 resetExpression 会把当前表情换成空定义）。
 *
 * 两层解析（顺序不可换）：
 *   1. stateExpression —— 瞬时状态（审批/失败/欢庆/静默/重连）要**稳定可辨识**的脸，
 *      一旦命中就固定用它，不进轮换。
 *   2. expressionPools —— 长驻状态（ready/typing）才是桌宠的常态，给池子轮换，
 *      否则九成时间是一张没有表情的默认脸（这是修好之前最伤观感的缺口）。
 *
 * 池子每 N 秒换一张，但**状态变化时立即重抽** —— 让「AI 开始干活」这件事
 * 在画面上立刻有反应，而不是等下一次轮换。
 */
let lastGenericExpression = null;
let lastGenericPoolState = null;
let nextPoolSwapAt = 0;
const POOL_SWAP_MS = 12_000;

/** 从池子里抽一张，尽量不重复上一张（池长 1 时退化为原地不动）。 */
function pickFromPool(pool) {
  if (!pool?.length) return null;
  if (pool.length === 1) return pool[0];
  let pick = pool[Math.floor(Math.random() * pool.length)];
  if (pick === lastGenericExpression) {
    pick = pool[(pool.indexOf(pick) + 1) % pool.length];
  }
  return pick;
}

function syncGenericExpression(petState) {
  if (!isGenericModel() || !state.model) return;
  if (ringPendingExpression && Date.now() < ringExpressionUntil) return;
  const model = currentModel();
  const semantic = model.stateExpression?.[petState] || null;
  const pool = model.expressionPools?.[petState] || null;
  const stateChanged = petState !== lastGenericPoolState;
  lastGenericPoolState = petState;

  let wanted = semantic;
  if (!wanted && pool?.length) {
    if (stateChanged || Date.now() >= nextPoolSwapAt) {
      wanted = pickFromPool(pool);
      nextPoolSwapAt = Date.now() + POOL_SWAP_MS;
    } else {
      return; // 池内轮换还没到点，保持当前这张，别每帧重设。
    }
  }
  if (wanted === lastGenericExpression) return;
  lastGenericExpression = wanted;
  try {
    if (wanted) void state.model.expression(wanted)?.catch?.(() => {});
    else state.model.internalModel?.motionManager?.expressionManager?.resetExpression?.();
  } catch {}
}

function tickState() {
  const t = Date.now();
  if (t - state.lastTapAt > COMBO_TIMEOUT_MS && state.combo > 0) {
    state.combo = Math.max(0, state.combo - 1);
  }
  if (state.randomExpression && state.model && t >= state.nextExpressionAt) {
    state.nextExpressionAt = t + 5000;
    if (ringPendingExpression && t < ringExpressionUntil) return;
    // 通用模型的表情表来自模型条目；没有声明就整体跳过（猫走原有的 0..2 索引）。
    const generic = isGenericModel();
    const pool = generic ? (currentModel().expressions || []) : null;
    if (!generic || pool.length) {
      try {
        const pick = generic
          ? pool[Math.floor(Math.random() * pool.length)]
          : Math.floor(Math.random() * 3);
        void state.model.expression(pick)?.catch?.(() => {});
      } catch {}
    }
  }
  refreshState();
}

const stateTimer = setInterval(tickState, 250);

function resetPointer() {
  state.mouseLeftDown = false;
  state.mouseRightDown = false;
  state.targetMouseX = state.targetMouseY = 0;
  state.currentMouseX = state.currentMouseY = 0;
  for (const node of Object.values(inputOverlayEls)) {
    if (!node) continue;
    node.hidden = true;
    node.removeAttribute("src");
    delete node.dataset.inputName;
  }
}
window.addEventListener("blur", resetPointer);
window.addEventListener("pointerup", resetPointer);
window.addEventListener("pointercancel", resetPointer);

// ---------------------------------------------------------------- Live2D 渲染与参数驱动

const WAVE_PARAM = "Param3"; // 挥手
const KEY_PARAM = "CatParamLeftHandDown"; // 键盘按下
const RIGHT_KEY_PARAM = "CatParamRightHandDown";
const ASCEND_PARAM = "Param5"; // 表情:升天
const THUGLIFE_PARAM = "Param4"; // 表情:thuglife 墨镜
const LIGHTNING_TOGGLE_PARAM = "Param"; // 开启闪电
const LIGHTNING_SWEEP_PARAM = "Param2"; // 闪电划过
const CHEEK_PARAM = "ParamCheek"; // 腮红

/**
 * 通用模型（非 BongoCat 猫）的状态驱动。
 *
 * 与猫分支的根本差别：
 *   1. 绝不写 CatParam* / ParamMouseX 等猫专属参数 —— 它们在这个模型上不存在，
 *      写入会被 setParameterValueById 静默吞掉；更危险的是 Param3/Param4/Param5
 *      在这里是「高光大小/挤压/左右」且属于物理输出，写进去会持续破坏眼睛高光。
 *   2. 只驱动一份显式白名单，每帧先归零再按状态写，避免跨帧残留。
 *   3. 表情走条目声明的语义名（ASCII），不走猫的 0..2 索引。
 */
function applyGenericStateParams(core, set, t, petState) {
  const model = currentModel();
  const drivable = model.drivable || {};
  const isMotionPlaying = Boolean(
    (ringPendingMotion && Date.now() < ringMotionUntil) ||
    (state.model?.internalModel?.motionManager && !state.model.internalModel.motionManager.isFinished())
  );
  const isCustomExpression = Boolean(ringPendingExpression && Date.now() < ringExpressionUntil);

  // 动作播放期间，让动作动画的头部/身体/道具/表情完整呈现，不被每帧状态逻辑抹平
  if (isMotionPlaying) return;

  // 每帧归零白名单：只碰我们确定要驱动的参数，物理输出一律不碰。
  for (const [key, id] of Object.entries(drivable)) {
    // 自定义表情展示期间，不要把表情定义的开眼/口型清掉
    if (isCustomExpression && (key === "eyeLOpen" || key === "eyeROpen" || key === "mouthOpenY" || key === "mouthForm")) {
      continue;
    }
    set(id, 0);
  }

  // 光标跟随 —— 驱动眼球而非“手”，这是这个模型真正有的自由度。
  if (state.mouseTracking !== false) {
    const pointerX = state.pointerMirror ? -state.targetMouseX : state.targetMouseX;
    state.currentMouseX += (pointerX - state.currentMouseX) * 0.22;
    state.currentMouseY += (state.targetMouseY - state.currentMouseY) * 0.22;
    set(drivable.eyeBallX, state.currentMouseX * 0.6);
    set(drivable.eyeBallY, -state.currentMouseY * 0.6);
    set(drivable.headX, state.currentMouseX * 12);
    set(drivable.headY, -state.currentMouseY * 8);
  }

  // 表情展示期间跳过常驻状态机对头动和嘴型的写值
  if (isCustomExpression) return;

  switch (petState) {
    case "typing":
      // 没有手臂骨骼，用轻微点头表达「在忙」。
      set(drivable.headZ, Math.sin(t * 6) * 2.2);
      set(drivable.mouthOpenY, 0.12 + Math.sin(t * 9) * 0.1);
      break;
    case "attention":
      set(drivable.headX, Math.sin(t * 3) * 6);
      break;
    case "celebrate":
      set(drivable.headZ, Math.sin(t * 10) * 4);
      set(drivable.mouthOpenY, 0.5 + Math.sin(t * 12) * 0.35);
      break;
    case "failure":
      set(drivable.headY, -6);
      set(drivable.mouthForm, -1.2);
      break;
    case "sleep":
      set(drivable.eyeLOpen, 0);
      set(drivable.eyeROpen, 0);
      set(drivable.headZ, Math.sin(t * 1.2) * 1.5);
      break;
    case "reconnecting":
      set(drivable.headZ, Math.sin(t * 4) * 3);
      break;
    default:
      // ready：交给模型自带的眨眼 / 呼吸 / 物理。
      set(drivable.headZ, Math.sin(t * 1.1) * 0.8);
      break;
  }
}

function triggerCelebrate() {
  try {
    const model = currentModel();
    if (model.kind === "generic") {
      // 通用模型：只播动作，表情交给 syncGenericExpression（它按 celebrate 的语义签名切）。
      // 不传索引 → 运行时走 startRandomMotion，在 model3.json 的实际条目里随机挑；
      // 写死索引（曾经的 motion("Emote", 0)）会让 6 个动作里 5 个永远播不到。
      void state.model?.motion?.(model.emoteGroup)?.catch?.(() => {});
    } else {
      state.model?.motion("CAT_motion", 1, 3)?.catch?.(() => {});
    }
    playChime();
  } catch (error) {
    console.warn("[pet] celebrate motion failed", error);
  }
}

function gamepadSnapshot() {
  if (state.modelId !== "gamepad" || typeof navigator.getGamepads !== "function") return null;
  const pad = [...(navigator.getGamepads() || [])].find(Boolean);
  if (!pad) return null;
  const pressed = (indexes) => indexes.some((index) => pad.buttons[index]?.pressed);
  const firstPressed = (entries) => entries.find(([index]) => pad.buttons[index]?.pressed)?.[1] || "";
  return {
    leftHand: pressed([4, 6, 12, 13, 14, 15]),
    rightHand: pressed([0, 1, 2, 3, 5, 7]),
    leftStickDown: Boolean(pad.buttons[10]?.pressed),
    rightStickDown: Boolean(pad.buttons[11]?.pressed),
    lx: Number(pad.axes[0]) || 0,
    ly: Number(pad.axes[1]) || 0,
    rx: Number(pad.axes[2]) || 0,
    ry: Number(pad.axes[3]) || 0,
    leftName: firstPressed([[4, "LeftTrigger"], [6, "LeftTrigger2"], [12, "DPadUp"], [13, "DPadDown"], [14, "DPadLeft"], [15, "DPadRight"]]),
    rightName: firstPressed([[0, "South"], [1, "East"], [2, "West"], [3, "North"], [5, "RightTrigger"], [7, "RightTrigger2"]]),
  };
}

function fitModel() {
  const model = state.model;
  if (!model) return;
  if (!state.baseSize) {
    state.baseSize = { width: model.width || 300, height: model.height || 300 };
  }
  // 顶栏已移除，不再为它预留 36px。
  const availableHeight = window.innerHeight;
  const scale = Math.min(availableHeight * 0.88 / state.baseSize.height,
    window.innerWidth * 0.96 / state.baseSize.width);
  model.scale.set(state.modelMirror ? -scale : scale, scale);
  model.anchor?.set?.(0.5, 1);
  model.x = window.innerWidth / 2;
  model.y = window.innerHeight;
}

let rendererBooting = false;
let pendingModelReload = false;
async function bootRenderer() {
  if (rendererBooting || disposed) return;
  rendererBooting = true;
  pixiApp?.destroy(false, { children: true });
  pixiApp = null;
  state.model = null;
  state.loadedModelId = null;
  state.baseSize = null;
  ringPendingExpression = null;
  ringExpressionUntil = 0;
  ringPendingMotion = null;
  ringMotionUntil = 0;
  state.rendererStatus = "loading";
  state.rendererError = "";
  setState("loading", "正在唤醒猫…");
  if (!window.PIXI?.live2d) {
    state.rendererStatus = "error";
    state.rendererError = "Live2D 运行时未加载，请重新打开桌宠";
    rendererBooting = false;
    refreshState();
    return;
  }
  try {
    try {
      window.PIXI.live2d.SoundManager.volume = 0;
    } catch {}
    const modelId = state.modelId;
    const model = await window.PIXI.live2d.Live2DModel.from(PET_MODELS[modelId].url, {
      autoInteract: false,
      autoUpdate: true,
      motionPreload: "IDLE",
    });
    if (disposed) { model.destroy(); return; }
    state.model = model;
    state.loadedModelId = modelId;
    const app = new window.PIXI.Application({
      backgroundAlpha: 0,
      antialias: true,
      resizeTo: window,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    pixiApp = app;
    app.ticker.maxFPS = state.maxFps;
    const canvas = app.view;
    canvas.id = "pet-canvas";
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      state.rendererStatus = "error";
      state.rendererError = "画面连接已中断，请重新打开桌宠";
      refreshState();
    });
    canvas.tabIndex = state.interactive ? 0 : -1;
    canvas.setAttribute("aria-label", state.interactive ? "戳一戳桌宠" : "514 桌宠");
    canvas.setAttribute("role", state.interactive ? "button" : "img");
    canvas.addEventListener("keydown", (event) => {
      if (state.interactive && ["Enter", " "].includes(event.key)) {
        event.preventDefault();
        onActivity({ kind: "poke" });
      }
    });
    document.getElementById("pet-canvas")?.replaceWith(canvas);
    app.stage.addChild(model);
    fitModel();
    window.addEventListener("resize", fitModel);

    // 桌面壳的原生拖拽：tauriInvoke 的 start_dragging 必须由**真实用户手势**触发，
    // 所以只能挂在原生监听上（合成事件会被 Tauri 拒），且只有互动模式才允许 ——
    // 穿透模式下窗口收不到鼠标事件，这个监听根本不响，不是缺陷是前提。
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !state.interactive || !isDesktop) return;
      if (event.target.closest?.(".pet-ring-item, .pet-ring-back")) return;
      event.preventDefault();
      tauriInvoke("plugin:window|start_dragging")?.catch?.(() => {});
    });

    // 参数覆盖时机：动作/眨眼/呼吸之后、coreModel.update 之前（覆盖即生效）
    model.internalModel.on("beforeModelUpdate", () => applyStateParams(model.internalModel.coreModel));

    // 画布原生指针监听：在交互模式与 Web Dock 模式下提供即时反应
    canvas.addEventListener("mousemove", (e) => {
      if (!state.mouseTracking || !state.interactive) return;
      const rect = canvas.getBoundingClientRect();
      state.targetMouseX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      state.targetMouseY = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    });
    canvas.addEventListener("mousedown", (e) => {
      if (!state.interactive || !state.mouseTracking || ![0, 2].includes(e.button)) return;
      if (e.button === 2) state.mouseRightDown = true;
      else state.mouseLeftDown = true;
    });
    canvas.addEventListener("mouseup", (e) => {
      if (e.button === 2) state.mouseRightDown = false;
      else state.mouseLeftDown = false;
    });
    canvas.addEventListener("dblclick", () => {
      if (!state.interactive) return;
      state.thuglifeUntil = Date.now() + 4500;
      playChime();
    });

    model.interactive = true;
    model.on("pointerdown", (event) => {
      if (!state.interactive || (event.data?.button !== undefined && event.data.button !== 0)) return;
      onActivity({ kind: "poke" });
    });
    state.rendererStatus = "ready";
    refreshState();
  } catch (error) {
    console.error("[pet] model load failed", error);
    state.model?.destroy();
    state.model = null;
    state.loadedModelId = null;
    state.baseSize = null;
    state.rendererStatus = "error";
    state.rendererError = "模型加载失败，请重试";
    refreshState();
  } finally {
    rendererBooting = false;
    if (pendingModelReload && !disposed) {
      pendingModelReload = false;
      void bootRenderer();
    }
  }
}

function applyStateParams(core) {
  const petState = state.petState;
  if (petState === "loading" || petState === "pairing" || petState === "error") return;
  const t = Date.now() / 1000;
  const set = (id, value) => {
    try {
      core.setParameterValueById(id, value);
    } catch {}
  };
  if (isGenericModel()) return applyGenericStateParams(core, set, t, petState);
  // Overrides must be reset each frame or previous expressions remain latched.
  for (const id of [WAVE_PARAM, KEY_PARAM, RIGHT_KEY_PARAM, ASCEND_PARAM, CHEEK_PARAM, "ParamEyeLSmile", "ParamEyeRSmile", "ParamMouthOpenY"]) set(id, 0);
  for (const id of ["ParamMouseX", "ParamMouseY", "ParamMouseLeftDown", "ParamMouseRightDown", "ParamEyeBallX", "ParamEyeBallY"]) set(id, 0);
  for (const id of ["CatParamStickLeftDown", "CatParamStickRightDown", "CatParamStickShowLeftHand", "CatParamStickShowRightHand", "CatParamStickLX", "CatParamStickLY", "CatParamStickRX", "CatParamStickRY"]) set(id, 0);

  // 1. 右手鼠标光标平滑插值（BongoCat 右爪跟随）
  if (state.mouseTracking !== false) {
    const pointerX = state.pointerMirror ? -state.targetMouseX : state.targetMouseX;
    state.currentMouseX += (pointerX - state.currentMouseX) * 0.22;
    state.currentMouseY += (state.targetMouseY - state.currentMouseY) * 0.22;
    set("ParamMouseX", state.currentMouseX);
    set("ParamMouseY", state.currentMouseY);
    set("ParamMouseLeftDown", state.mouseLeftDown ? 1 : 0);
    set("ParamMouseRightDown", state.mouseRightDown ? 1 : 0);
    set("ParamEyeBallX", state.currentMouseX * 0.35);
    set("ParamEyeBallY", -state.currentMouseY * 0.35);
  }

  const gamepad = gamepadSnapshot();
  if (gamepad) {
    set(KEY_PARAM, gamepad.leftHand ? 1 : 0);
    set(RIGHT_KEY_PARAM, gamepad.rightHand ? 1 : 0);
    set("CatParamStickLeftDown", gamepad.leftStickDown ? 1 : 0);
    set("CatParamStickRightDown", gamepad.rightStickDown ? 1 : 0);
    set("CatParamStickShowLeftHand", Math.hypot(gamepad.lx, gamepad.ly) > 0.08 ? 1 : 0);
    set("CatParamStickShowRightHand", Math.hypot(gamepad.rx, gamepad.ry) > 0.08 ? 1 : 0);
    set("CatParamStickLX", gamepad.lx);
    set("CatParamStickLY", -gamepad.ly);
    set("CatParamStickRX", gamepad.rx);
    set("CatParamStickRY", -gamepad.ry);
    setInputArtwork("left", gamepad.leftName, Boolean(gamepad.leftName));
    setInputArtwork("right", gamepad.rightName, Boolean(gamepad.rightName));
  } else if (state.modelId === "gamepad") {
    setInputArtwork("left", inputOverlayEls.left?.dataset.inputName, false);
    setInputArtwork("right", inputOverlayEls.right?.dataset.inputName, false);
  }

  // 2. 连击狂热与闪电特效（BongoCat Lightning Fever Combo / 拍桌）
  const isDeskSlap = ringPendingMotion === "拍桌" && Date.now() < ringMotionUntil;
  const isLightningActive = isDeskSlap || (state.lightningCombo !== false && (state.combo >= 8 || (petState === "typing" && state.combo >= 4)));
  if (isLightningActive) {
    set(LIGHTNING_TOGGLE_PARAM, 1);
    set(LIGHTNING_SWEEP_PARAM, (Math.sin(t * 26) + 1) / 2);
  } else {
    set(LIGHTNING_TOGGLE_PARAM, 0);
    set(LIGHTNING_SWEEP_PARAM, 0);
  }

  // 3. 酷炫彩蛋表情（Thug Life 墨镜）
  const isThugLife = state.thuglifeUntil > Date.now() || state.combo >= 25 || (ringPendingExpression === "墨镜" && Date.now() < ringExpressionUntil);
  if (isThugLife) {
    set(THUGLIFE_PARAM, 1);
  } else {
    set(THUGLIFE_PARAM, 0);
  }

  // 4. 左爪打字与各情态动画
  const isAscend = petState === "celebrate" || (ringPendingExpression === "升天" && Date.now() < ringExpressionUntil);
  const isWave = petState === "attention" || (ringPendingMotion === "挥手" && Date.now() < ringMotionUntil);

  if (isDeskSlap) {
    set(KEY_PARAM, 1);
    set("ParamBodyAngleZ", Math.sin(t * 34) * 3.2);
    set("ParamBodyAngleX", Math.sin(t * 9) * 1.5);
  } else if (isWave) {
    // 挥手
    set(WAVE_PARAM, 1);
    set(CHEEK_PARAM, 1);
    set("ParamEyeLSmile", 0.7);
    set("ParamEyeRSmile", 0.7);
    set("ParamBodyAngleZ", Math.sin(t * 6) * 2);
  } else if (isAscend) {
    // 天使光环升天
    set(ASCEND_PARAM, 1);
    set("ParamMouthOpenY", 0.6 + Math.sin(t * 12) * 0.4);
    set("ParamBodyAngleZ", Math.sin(t * 10) * 4);
  } else if (petState !== "attention" && Date.now() < (state.pokeUntil || 0)) {
    // 戳一戳互动：脸颊腮红、开心眯眼与摇摆
    set(CHEEK_PARAM, 1);
    set("ParamEyeLSmile", 0.9);
    set("ParamEyeRSmile", 0.9);
    set("ParamBodyAngleZ", Math.sin(t * 12) * 2.8);
    set("ParamBodyAngleX", Math.sin(t * 8) * 1.5);
  } else if (petState === "typing" || (petState === "ready" && Date.now() < state.tapUntil)) {
    // 敲键盘：敲击脉冲内左爪拍下（配合频率自激回弹）
    const isDown = Date.now() < state.tapUntil || Math.sin(t * 32) > 0;
    if (state.modelId === "keyboard") {
      set(KEY_PARAM, Date.now() < state.leftTapUntil ? 1 : 0);
      set(RIGHT_KEY_PARAM, Date.now() < state.rightTapUntil ? 1 : 0);
    } else if (state.modelId !== "gamepad") {
      set(KEY_PARAM, isDown ? 1 : 0);
    }
    set("ParamBodyAngleZ", Math.sin(t * 34) * (isLightningActive ? 3.2 : 2.2));
    set("ParamBodyAngleX", Math.sin(t * 9) * 1.5);
  } else if (petState === "sleep") {
    set("ParamEyeLOpen", 0);
    set("ParamEyeROpen", 0);
    set("ParamBodyAngleZ", Math.sin(t * 1.2) * 1.5);
  } else {
    // ready：轻微呼吸与自然摇摆
    set("ParamBodyAngleX", Math.sin(t * 1.6) * 1.6);
    set("ParamBodyAngleZ", Math.sin(t * 1.1) * 0.8);
  }
}

// ---------------------------------------------------------------- 启动与 QA 钩子

refreshModelArtwork();
startPairing();
void bootRenderer();
window.addEventListener("pagehide", () => {
  disposed = true;
  clearInterval(pairingTimer);
  clearInterval(stateTimer);
  for (const stream of streams.splice(0)) stream.stop();
  channel?.close();
  window.removeEventListener("resize", fitModel);
  pixiApp?.destroy(false, { children: true });
  void audioCtx?.close().catch(() => {});
});
window.addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });

// QA 专用注入通道：仅在 qa=1 时暴露，生产路径不经过
if (new URLSearchParams(window.location.search).get("qa") === "1") {
  window.__petTest = { ingestBotEvent, onActivity, setState, applyConfig, stateRef: state, getRenderer: () => pixiApp?.renderer };
}
