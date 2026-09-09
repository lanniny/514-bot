import test from "node:test";
import assert from "node:assert/strict";
import { mountDesktopWindowChrome } from "../public/modules/desktop-window-chrome.js";
import { mountBotApprovalShortcuts } from "../public/modules/bot-approval-shortcuts.js";

class Target {
  listeners = new Map();
  hidden = true;
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  fire(type, data = {}) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...data };
    for (const handler of this.listeners.get(type) || []) handler(event);
    return event;
  }
  closest() { return this.interactive ? this : null; }
}
function host({ global = true, bot = true } = {}) {
  const document = new Target();
  const window = new Target();
  const elements = new Map();
  for (const prefix of [global && "window", bot && "bot-window"].filter(Boolean)) {
    for (const suffix of ["controls", "minimize", "maximize", "close"]) elements.set(`${prefix}-${suffix}`, new Target());
  }
  const classes = new Set();
  document.documentElement = { classList: { contains: (name) => classes.has(name), add: (name) => classes.add(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) } };
  document.getElementById = (id) => elements.get(id);
  const surfaces = Array.from({ length: 6 }, () => new Target());
  document.querySelectorAll = () => surfaces;
  document.querySelector = () => document.modal ? {} : null;
  return { document, window, elements, surfaces, classes };
}
const flush = () => new Promise(setImmediate);

test("desktop mounting preserves browser fallback and exactly one window-control owner", () => {
  const h = host();
  let commands = 0;
  const options = { ...h, invoke: async () => { commands++; }, reload() {}, onError() {} };
  const browser = mountDesktopWindowChrome({ ...options, invoke: undefined });
  assert.equal(browser.active, false);
  assert.equal(h.elements.get("window-controls").hidden, true);
  const first = mountDesktopWindowChrome(options);
  assert.equal(first.active, true);
  assert.equal(h.elements.get("window-controls").hidden, false);
  assert.equal(h.elements.get("bot-window-controls").hidden, true);
  const second = mountDesktopWindowChrome(options);
  assert.equal(first.active, false);
  first.dispose();
  h.elements.get("window-maximize").fire("click");
  assert.equal(commands, 1);
  second.dispose();
  h.elements.get("window-maximize").fire("click");
  assert.equal(commands, 1);
  assert.equal(h.elements.get("window-controls").hidden, true);
  assert.equal(h.classes.has("is-desktop-shell"), false);
  const fallback = host({ global: false });
  mountDesktopWindowChrome({ ...options, ...fallback });
  assert.equal(fallback.elements.get("bot-window-controls").hidden, false);
});

test("desktop buttons, mouse click counts, touch drag and reload keep their guarded command mappings", async () => {
  const h = host();
  const calls = [];
  let reloads = 0;
  const controller = mountDesktopWindowChrome({ ...h, invoke: (command) => { calls.push(command); }, reload: () => { reloads++; }, onError: assert.fail });
  for (const prefix of ["window", "bot-window"]) for (const suffix of ["minimize", "maximize", "close"]) h.elements.get(`${prefix}-${suffix}`).fire("click");
  assert.deepEqual(calls, ["minimize", "toggle_maximize", "close", "minimize", "toggle_maximize", "close"].map((name) => `plugin:window|${name}`));
  for (const surface of h.surfaces) {
    calls.length = 0;
    assert.equal(surface.fire("pointerdown", { button: 0, pointerType: "mouse", detail: 0 }).defaultPrevented, false);
    surface.fire("mousedown", { button: 0, detail: 1 });
    surface.fire("mousedown", { button: 0, detail: 2 });
    surface.fire("pointerdown", { button: 0, pointerType: "touch", isPrimary: true });
    const interactive = new Target(); interactive.interactive = true;
    surface.fire("mousedown", { button: 2, detail: 1 });
    surface.fire("mousedown", { button: 0, target: interactive });
    surface.fire("mousedown", { button: 0, defaultPrevented: true });
    surface.fire("pointerdown", { button: 0, pointerType: "touch", isPrimary: false });
    assert.deepEqual(calls, ["plugin:window|start_dragging", "plugin:window|toggle_maximize", "plugin:window|start_dragging"]);
  }
  for (const guard of [{ repeat: true }, { isComposing: true }, { defaultPrevented: true }, { ctrlKey: false }]) h.window.fire("keydown", { key: "r", ctrlKey: true, ...guard });
  assert.equal(reloads, 0);
  h.window.fire("keydown", { key: "R", ctrlKey: true });
  assert.equal(reloads, 1);
  controller.dispose();
  h.window.fire("keydown", { key: "r", ctrlKey: true });
  assert.equal(reloads, 1);
  await flush();
});

test("native synchronous failures and rejected promises are presented once, not swallowed", async () => {
  const h = host();
  const errors = [];
  let reject;
  const controller = mountDesktopWindowChrome({ ...h, invoke: (command) => {
    if (command.endsWith("close")) throw new Error("sync denied");
    if (command.endsWith("minimize")) return Promise.reject(new Error("async denied"));
    return new Promise((_resolve, rejectRun) => { reject = rejectRun; });
  }, reload() {}, onError: (error, command) => errors.push([error.message, command]) });
  assert.equal(await controller.run("plugin:window|close"), false);
  assert.equal(await controller.run("plugin:window|minimize"), false);
  assert.equal(errors.length, 2);
  const late = controller.run("plugin:window|toggle_maximize");
  controller.dispose();
  reject(new Error("disposed operation"));
  assert.equal(await late, false);
  assert.equal(errors.length, 2);
});

test("approval shortcuts use live conversation getters and retain every admission guard", async () => {
  const h = host();
  let view = "bot";
  let run = { id: "run-a" };
  let approvals = [{ id: "old", runId: "run-a", status: "pending" }, { id: "other", runId: "run-b", status: "pending" }, { id: "latest", runId: "run-a" }];
  const inFlight = new Set();
  const calls = [];
  const options = { document: h.document, enabled: true, getView: () => view, getActiveRun: () => run, getApprovals: () => approvals, isInFlight: (id) => inFlight.has(id), resolveApproval: (...args) => calls.push(args), onError: assert.fail };
  mountBotApprovalShortcuts({ ...options, enabled: false });
  h.document.fire("keydown", { key: "y" });
  assert.equal(calls.length, 0);
  const first = mountBotApprovalShortcuts(options);
  const dispose = mountBotApprovalShortcuts(options);
  first();
  for (const guard of ["ctrlKey", "metaKey", "altKey", "repeat", "isComposing", "defaultPrevented"]) h.document.fire("keydown", { key: "y", [guard]: true });
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) { h.document.activeElement = { tagName }; h.document.fire("keydown", { key: "n" }); }
  h.document.activeElement = { isContentEditable: true }; h.document.fire("keydown", { key: "n" });
  h.document.activeElement = null;
  h.document.modal = true; h.document.fire("keydown", { key: "n" }); h.document.modal = false;
  view = "workbench"; h.document.fire("keydown", { key: "y" }); view = "bot";
  inFlight.add("latest"); h.document.fire("keydown", { key: "y" }); inFlight.clear();
  assert.equal(calls.length, 0);
  h.document.fire("keydown", { key: "Y", shiftKey: true });
  run = { id: "run-b" };
  h.document.fire("keydown", { key: "n" });
  assert.deepEqual(calls, [["latest", "approve"], ["other", "deny"]]);
  approvals = [{ id: "broad", runId: "run-b", method: "item/permissions/requestApproval", status: "pending" }];
  h.document.fire("keydown", { key: "y" });
  assert.deepEqual(calls.at(-1), ["broad", "approve"], "the existing business resolver, not the keyboard module, owns broad-permission rejection");
  dispose();
  h.document.fire("keydown", { key: "n" });
  assert.equal(calls.length, 3);
  await flush();
});
