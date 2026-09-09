export const PET_DEFAULTS = Object.freeze({
  model: "standard",
  maxFps: "60",
  modelMirror: false,
  pointerMirror: false,
  randomExpression: false,
  interactive: false,
  opacity: 1,
  scale: 1,
  webDock: true,
  mouseTracking: true,
  lightningCombo: true,
  sound: false,
});

export const PET_MODELS = Object.freeze({
  standard: Object.freeze({ label: "标准", url: "/vendor/pet-models/bongo-standard/cat.model3.json" }),
  keyboard: Object.freeze({ label: "键盘", url: "/vendor/pet-models/bongo-keyboard/cat.model3.json" }),
  gamepad: Object.freeze({ label: "手柄", url: "/vendor/pet-models/bongo-gamepad/cat.model3.json" }),
});

export const PET_PRESETS = Object.freeze({
  quiet: Object.freeze({ opacity: 0.7, scale: 0.8, mouseTracking: false, lightningCombo: false, sound: false }),
  companion: Object.freeze({ opacity: 1, scale: 1, mouseTracking: true, lightningCombo: true, sound: false }),
  lively: Object.freeze({ opacity: 1, scale: 1.2, mouseTracking: true, lightningCombo: true, sound: true }),
});

export function petRatio(value, min, max, fallback = 1, percent = false) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, percent ? value / 100 : value));
}

export function matchPetPreset(settings) {
  return Object.entries(PET_PRESETS).find(([, preset]) => (
    Object.entries(preset).every(([key, value]) => settings?.[key] === value)
  ))?.[0] || "custom";
}

export function clampDockPosition(x, y, width, height, viewportWidth, viewportHeight) {
  return {
    x: Math.min(Math.max(8, x), Math.max(8, viewportWidth - width - 8)),
    y: Math.min(Math.max(8, y), Math.max(8, viewportHeight - height - 8)),
  };
}
