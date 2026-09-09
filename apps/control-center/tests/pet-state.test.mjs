import test from "node:test";
import assert from "node:assert/strict";
import { createPetActivity } from "../public/pet/pet-state.js";
import { PET_DEFAULTS, PET_PRESETS, matchPetPreset, petRatio, clampDockPosition } from "../public/pet/pet-settings.js";

test("pending approvals survive typing, unrelated completion and partial resolution", () => {
  let now = Date.now();
  const pet = createPetActivity({ now: () => now });
  const pending = (id) => pet.ingest({ type: "approval.pending", data: { id, expiresAt: new Date(now + 120_000).toISOString() } });
  pending("a"); pending("b");
  pet.activity();
  pet.ingest({ type: "assistant.message" });
  pet.ingest({ type: "user.message" });
  pet.ingest({ type: "agent.turn_completed" });
  assert.equal(pet.snapshot().name, "attention");
  pet.ingest({ type: "approval.resolved", data: { id: "a" } });
  assert.equal(pet.snapshot().text, "1 项审批待处理");
  now += 100_000;
  assert.equal(pet.snapshot().name, "attention", "do not clear a live approval after 90 seconds");
  pet.ingest({ type: "approval.expired", data: { id: "b" } });
  assert.equal(pet.snapshot().name, "ready");
});

test("expired approvals and replayed activity cannot animate a historical task", () => {
  const now = Date.now();
  const pet = createPetActivity({ now: () => now });
  pet.ingest({ type: "approval.pending", data: { id: "old", expiresAt: new Date(now - 1).toISOString() } });
  for (const type of ["assistant.message", "agent.turn_completed", "run.finished_cleared"]) {
    pet.ingest({ type, timestamp: new Date(now - 60_000).toISOString() });
  }
  assert.equal(pet.snapshot().name, "ready");
});

test("typing decays, sleep wakes, failure never celebrates", () => {
  let now = Date.now();
  const pet = createPetActivity({ now: () => now });
  pet.activity();
  assert.equal(pet.snapshot().name, "typing");
  now += 2501;
  assert.equal(pet.snapshot().name, "ready");
  now += 300_000;
  assert.equal(pet.snapshot().name, "sleep");
  pet.activity();
  assert.equal(pet.snapshot().name, "typing");
  pet.ingest({ type: "agent.turn_completed", data: { status: "failed" } });
  assert.equal(pet.snapshot().name, "failure");
});

test("plugin percentage units differ from local ratios and invalid values preserve defaults", () => {
  assert.equal(petRatio(100, 0.6, 1.8, 1, true), 1);
  assert.equal(petRatio(60, 0.3, 1, 1, true), 0.6);
  assert.equal(petRatio(1.5, 0.6, 1.8), 1.5);
  assert.equal(petRatio(NaN, 0.6, 1.8, 0.8, true), 0.8);
  assert.equal(petRatio(Infinity, 0.6, 1.8), 1);
  assert.deepEqual(clampDockPosition(1000, -200, 280, 240, 390, 844), { x: 102, y: 8 });
});

test("pet presets are complete, distinct, and fall back to a custom state", () => {
  assert.deepEqual(Object.keys(PET_PRESETS), ["quiet", "companion", "lively"]);
  for (const [name, preset] of Object.entries(PET_PRESETS)) {
    assert.equal(matchPetPreset({ ...PET_DEFAULTS, ...preset }), name);
    assert.ok(preset.opacity >= 0.3 && preset.opacity <= 1);
    assert.ok(preset.scale >= 0.6 && preset.scale <= 1.8);
  }
  assert.equal(matchPetPreset({ ...PET_DEFAULTS, opacity: 0.73 }), "custom");
});
