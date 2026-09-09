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
import { createPetChannel } from "./pet-channel.js";
import { PET_MODELS } from "./pet-settings.js";

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
const toolbarEl = document.getElementById("pet-toolbar");
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
};
let disposed = false;
let pixiApp = null;
let pairingTimer = null;
const streams = [];
const connections = new Map();
let lastEventSequence = 0;
let streamEpoch = null;
let streamGeneration = 0;

function modelAsset(relative, modelId = state.modelId) {
  return `/vendor/pet-models/bongo-${modelId}/resources/${relative}`;
}

function refreshModelArtwork() {
  if (!modeBackgroundEl) return;
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

  {
    channel = createPetChannel(() => isDock ? window.parent : null, window, isDesktop);
    channel.onmessage = (event) => {
      const data = event?.data || {};
      if (data.type === "pet-token" && typeof data.token === "string" && data.token) {
        adoptToken(data.token, "broadcast");
        if (data.config) applyConfig(data.config);
      } else if (data.type === "pet-config") {
        applyConfig(data.config || {});
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

// ---------------------------------------------------------------- 配置同步

function applyConfig(config) {
  if (Object.hasOwn(PET_MODELS, config.model) && state.modelId !== config.model) {
    state.modelId = config.model;
    refreshModelArtwork();
    if (rendererBooting) pendingModelReload = true;
    else if (state.model) void bootRenderer();
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
  if (Number.isFinite(config.opacity)) {
    state.opacity = Math.min(1, Math.max(0.15, Number(config.opacity)));
    body.style.opacity = String(isDock ? 1 : state.opacity);
  }
  if (Number.isFinite(config.scale)) {
    state.scale = isDock ? 1 : Math.min(1.8, Math.max(0.6, Number(config.scale)));
    fitModel();
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
  toolbarEl.hidden = !state.interactive || !isDesktop;
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

toolbarEl?.querySelector("#pet-toggle-interactive")?.addEventListener("click", () => {
  channel?.postMessage({ type: "pet-request", request: "interactive-off" });
});
toolbarEl?.querySelector("#pet-close")?.addEventListener("click", () => {
  channel?.postMessage({ type: "pet-request", request: "close" });
});
toolbarEl?.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest("button") || !state.interactive || !isDesktop) return;
  event.preventDefault();
  tauriInvoke("plugin:window|start_dragging")?.catch?.(() => {});
});
document.getElementById("pet-retry")?.addEventListener("click", () => {
  if (state.rendererStatus === "error") void bootRenderer();
  channel?.postMessage({ type: "pet-hello" });
  if (state.token) startStreams();
});

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

function tickState() {
  const t = Date.now();
  if (t - state.lastTapAt > COMBO_TIMEOUT_MS && state.combo > 0) {
    state.combo = Math.max(0, state.combo - 1);
  }
  if (state.randomExpression && state.model && t >= state.nextExpressionAt) {
    state.nextExpressionAt = t + 5000;
    try { void state.model.expression(Math.floor(Math.random() * 3))?.catch?.(() => {}); } catch {}
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

function triggerCelebrate() {
  try {
    state.model?.motion("CAT_motion", 1, 3)?.catch?.(() => {});
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
  const availableHeight = window.innerHeight - (state.interactive && isDesktop ? 36 : 0);
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

  // 2. 连击狂热与闪电特效（BongoCat Lightning Fever Combo）
  const isLightningActive = state.lightningCombo !== false && (state.combo >= 8 || (petState === "typing" && state.combo >= 4));
  if (isLightningActive) {
    set(LIGHTNING_TOGGLE_PARAM, 1);
    set(LIGHTNING_SWEEP_PARAM, (Math.sin(t * 26) + 1) / 2);
  } else {
    set(LIGHTNING_TOGGLE_PARAM, 0);
    set(LIGHTNING_SWEEP_PARAM, 0);
  }

  // 3. 酷炫彩蛋表情（Thug Life 墨镜）
  if (state.thuglifeUntil > Date.now() || state.combo >= 25) {
    set(THUGLIFE_PARAM, 1);
  } else {
    set(THUGLIFE_PARAM, 0);
  }

  // 4. 左爪打字与各情态动画
  if (petState !== "attention" && Date.now() < (state.pokeUntil || 0)) {
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
  } else if (petState === "attention") {
    // 挥手提醒
    set(WAVE_PARAM, 1);
    set(CHEEK_PARAM, 1);
    set("ParamEyeLSmile", 0.7);
    set("ParamEyeRSmile", 0.7);
    set("ParamBodyAngleZ", Math.sin(t * 6) * 2);
  } else if (petState === "celebrate") {
    // 天使光环升天欢庆
    set(ASCEND_PARAM, 1);
    set("ParamMouthOpenY", 0.6 + Math.sin(t * 12) * 0.4);
    set("ParamBodyAngleZ", Math.sin(t * 10) * 4);
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
