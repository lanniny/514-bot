import test from "node:test";
import assert from "node:assert/strict";
import { clampBotTerminalHeight, createBotTerminalDock } from "../public/modules/bot-terminal-dock.js";

test("Bot terminal dock clamps height and toggles without leaving Bot", () => {
  assert.equal(clampBotTerminalHeight(80, 400), 140);
  assert.equal(clampBotTerminalHeight(900, 300), 300);
  assert.equal(clampBotTerminalHeight(200, 400), 200);

  const classes = new Set();
  const conversationClasses = new Set();
  const toggleAttrs = {};
  const bodyStyle = new Map();
  const storage = new Map();
  let mounted = false;
  const drawer = {
    hidden: true,
    classList: {
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
    closest(selector) {
      if (selector === ".bot-conversation") {
        return {
          classList: {
            toggle(name, on) {
              if (on) conversationClasses.add(name);
              else conversationClasses.delete(name);
            },
          },
        };
      }
      if (selector === ".view") return { classList: { contains: () => true } };
      return null;
    },
  };
  const body = { style: { setProperty(name, value) { bodyStyle.set(name, value); } } };
  const grip = { dataset: {}, addEventListener() {} };
  const closeButton = { addEventListener() {} };
  const toggle = {
    classList: { toggle() {} },
    setAttribute(name, value) { toggleAttrs[name] = String(value); },
  };
  const root = {
    documentElement: { classList: { add() {}, remove() {} } },
    getElementById(id) {
      return {
        "bot-terminal-drawer": drawer,
        "bot-terminal-container": body,
        "bot-terminal-grip": grip,
        "bot-terminal-close": closeButton,
        "global-terminal-toggle": toggle,
        "bot-terminal-cwd": { textContent: "" },
      }[id] || null;
    },
    addEventListener() {},
  };

  const dock = createBotTerminalDock({
    document: root,
    window: { clearTimeout() {}, requestAnimationFrame: (fn) => fn() },
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    createPanel: () => ({
      mount: async () => { mounted = true; },
      focusActive() {},
    }),
  });

  assert.equal(dock.isOpen(), false);
  dock.setOpen(true);
  assert.equal(drawer.hidden, false);
  assert.equal(classes.has("is-open"), true);
  assert.equal(conversationClasses.has("is-terminal-open"), true);
  assert.equal(toggleAttrs["aria-pressed"], "true");
  assert.equal(mounted, true);
  assert.equal(storage.get("514cc-bot-term-open"), "1");
  dock.setOpen(false);
  assert.equal(classes.has("is-open"), false);
  assert.equal(conversationClasses.has("is-terminal-open"), false);
});
