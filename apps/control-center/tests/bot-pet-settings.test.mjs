import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPetPresetToConfig,
  defaultPetConfig,
  petConfigFromBinding,
  petFormMarkup,
  readPetForm,
} from "../public/modules/bot-pet-settings.js";

test("pet settings stay draftable without a workbench surface", () => {
  const defaults = defaultPetConfig();
  assert.equal(defaults.enabled, false);
  assert.ok(defaults.opacity >= 30);
  const fromBinding = petConfigFromBinding({
    enabled: true,
    config: { opacity: 80, scale: 120, model: "unknown-model" },
  });
  assert.equal(fromBinding.enabled, true);
  assert.equal(fromBinding.opacity, 80);
  assert.equal(fromBinding.model, defaults.model);

  const lively = applyPetPresetToConfig(defaults, "lively");
  assert.notEqual(lively.scale, defaults.scale);
  const markup = petFormMarkup(lively, {
    canEdit: true,
    projectOptions: [{ id: "p1", label: "演示项目" }],
    selectedProjectId: "p1",
    installed: true,
  });
  assert.match(markup, /name="opacity"/);
  assert.match(markup, /data-pet-preset="lively"/);
  assert.match(markup, /演示项目/);

  const form = {
    elements: {
      namedItem(name) {
        const values = {
          enabled: { checked: true },
          model: { value: lively.model },
          "max-fps": { value: "60" },
          opacity: { value: String(lively.opacity) },
          scale: { value: String(lively.scale) },
          "mouse-tracking": { checked: lively["mouse-tracking"] },
          "lightning-combo": { checked: lively["lightning-combo"] },
          sound: { checked: lively.sound },
          interactive: { checked: lively.interactive },
          "web-dock": { checked: lively["web-dock"] },
          "model-mirror": { checked: lively["model-mirror"] },
          "pointer-mirror": { checked: lively["pointer-mirror"] },
          "random-expression": { checked: lively["random-expression"] },
        };
        return values[name];
      },
    },
  };
  const read = readPetForm(form);
  assert.equal(read.enabled, true);
  assert.equal(read.opacity, lively.opacity);
});
