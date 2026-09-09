import test from "node:test";
import assert from "node:assert/strict";
import { createChromeViewHistory } from "../public/modules/chrome-view-history.js";

const a = { view: "overview" };
const b = { view: "config", configSurface: "hooks" };
const c = { view: "workbench" };
const flush = () => new Promise(setImmediate);
class Target {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  setAttribute(key, value) { this[key] = value; }
  fire(type, data = {}) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...data };
    for (const fn of this.listeners.get(type) || []) fn(event);
    return event;
  }
}
function fixture() {
  let current = a;
  let apply;
  let controller;
  const document = new Target();
  const window = new Target();
  const buttons = { back: new Target(), forward: new Target() };
  document.getElementById = (id) => buttons[id.replace("chrome-nav-", "")];
  document.querySelector = () => document.modal ? {} : null;
  const errors = [];
  apply = (target, token) => { const previous = current; current = target; controller.record(previous, token); return true; };
  controller = createChromeViewHistory({ document, window, captureRoute: () => ({ ...current }), applyRoute: (target, token) => apply(target, token), titleForRoute: (route) => route.view, isKnownRoute: (route) => Boolean(route.view), pulse() {}, onError: (error) => errors.push(error.message) });
  controller.initialize();
  return { controller, document, window, buttons, errors, current: () => current,
    apply: (fn) => { apply = fn; }, set: (route) => { current = route; },
    go(route) { const previous = current; current = route; controller.record(previous); },
  };
}

test("cancelled or rejected navigation never consumes history; accepted delayed navigation commits once", async () => {
  const fx = fixture();
  fx.go(b);
  const before = fx.controller.snapshot();
  let settle;
  let token;
  fx.apply((target, owner) => new Promise((resolve) => { token = owner; settle = (accepted) => { if (accepted) { fx.set(target); fx.controller.record(b, owner); } resolve(accepted); }; }));
  const rejected = fx.controller.navigate("back");
  assert.equal(fx.buttons.back.disabled, true);
  assert.equal(await fx.controller.navigate("back"), false);
  assert.deepEqual(fx.controller.snapshot().back, before.back);
  settle(false);
  assert.equal(await rejected, false);
  assert.deepEqual(fx.controller.snapshot(), before);
  const accepted = fx.controller.navigate("back");
  settle(true);
  assert.equal(await accepted, true);
  assert.deepEqual(fx.controller.snapshot().back, []);
  assert.deepEqual(fx.controller.snapshot().forward, [b]);
  fx.controller.record(c, token);
  assert.deepEqual(fx.controller.snapshot().forward, [b], "late restoration callbacks remain owned by their navigation");
  fx.apply(() => { throw new Error("blocked"); });
  assert.equal(await fx.controller.navigate("forward"), false);
  assert.deepEqual(fx.controller.snapshot().forward, [b]);
  assert.deepEqual(fx.errors, ["blocked"]);
});

test("an unrelated navigation supersedes a pending request without losing the new branch", async () => {
  const fx = fixture();
  fx.go(b);
  let finish;
  let owner;
  fx.apply((_target, token) => { owner = token; return new Promise((resolve) => { finish = resolve; }); });
  const pending = fx.controller.navigate("back");
  fx.go(c);
  assert.equal(owner.isCurrent(), false);
  finish(true);
  assert.equal(await pending, false);
  assert.deepEqual(fx.controller.snapshot().back, [a, b]);
  assert.deepEqual(fx.controller.snapshot().forward, []);
  assert.equal(fx.current().view, "workbench");
});

test("forward history survives back, then clears only when a genuinely new branch is recorded", async () => {
  const fx = fixture();
  fx.go(b);
  fx.go(c);
  assert.equal(await fx.controller.navigate("back"), true);
  assert.equal(await fx.controller.navigate("forward"), true);
  assert.deepEqual(fx.controller.snapshot().back, [a, b]);
  assert.equal(await fx.controller.navigate("back"), true);
  fx.go({ view: "sessions" });
  assert.deepEqual(fx.controller.snapshot().forward, []);
  assert.deepEqual(fx.controller.snapshot().back, [a, b]);
});

test("history bindings are idempotent and protect editable and modal keyboard contexts", async () => {
  const fx = fixture();
  fx.go(b); fx.go(c);
  const oldDispose = fx.controller.initialize();
  fx.controller.initialize(); oldDispose();
  for (const target of [{ isContentEditable: true }, { closest: () => ({}) }]) {
    const event = fx.document.fire("keydown", { key: "ArrowLeft", altKey: true, target });
    assert.equal(event.defaultPrevented, false);
  }
  fx.document.modal = true;
  fx.window.fire("mouseup", { button: 3 });
  fx.document.modal = false;
  assert.equal(fx.current().view, "workbench");
  fx.buttons.back.fire("click"); await flush();
  assert.equal(fx.current().view, "config");
  assert.deepEqual(fx.controller.snapshot().back, [a]);
  fx.window.fire("mouseup", { button: 4 }); await flush();
  assert.equal(fx.current().view, "workbench");
  fx.controller.dispose();
  fx.document.fire("keydown", { key: "ArrowLeft", altKey: true }); await flush();
  assert.equal(fx.current().view, "workbench");
});

test("a canonicalized route may commit, but an applier claiming success without any transition cannot", async () => {
  const fx = fixture();
  fx.go(b);
  fx.apply(() => true);
  assert.equal(await fx.controller.navigate("back"), false);
  assert.deepEqual(fx.controller.snapshot().back, [a]);
  fx.apply((_target, owner) => { fx.set({ view: "bot", botWorkspaceHash: "#bot?conversation=restored" }); fx.controller.record(b, owner); return true; });
  assert.equal(await fx.controller.navigate("back"), true);
  assert.deepEqual(fx.controller.snapshot().forward, [b]);
});
