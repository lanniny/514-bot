import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("Grok face preference defaults to grok and can switch to workbench", async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
  };
  const classes = new Set(["is-bot-surface"]);
  const overflow = { open: false };
  const more = { attrs: {}, setAttribute(name, value) { this.attrs[name] = String(value); } };
  globalThis.document = {
    documentElement: {
      classList: {
        toggle(name, on) {
          if (on) classes.add(name);
          else classes.delete(name);
        },
      },
    },
    getElementById(id) {
      if (id === "bot-composer-overflow") return overflow;
      if (id === "bot-composer-more") return more;
      return null;
    },
    querySelectorAll() { return []; },
  };

  const {
    readBotFacePreference,
    writeBotFacePreference,
    applyBotFacePreference,
  } = await import("../public/modules/bot-grok-face.js");

  assert.equal(readBotFacePreference(), "grok");
  assert.equal(writeBotFacePreference("workbench"), "workbench");
  assert.equal(readBotFacePreference(), "workbench");
  applyBotFacePreference("workbench");
  assert.equal(classes.has("is-bot-grok-face"), false);
  assert.equal(overflow.open, true);
  applyBotFacePreference("grok");
  assert.equal(classes.has("is-bot-grok-face"), true);
  assert.equal(overflow.open, false);
  assert.equal(more.attrs["aria-expanded"], "false");
});

test("Grok face CSS keeps 390px composer and chips tappable", async () => {
  const css = await readFile(`${appRoot}/public/forge/bot-grok-face.css`, "utf8");
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /min-height: 44px/);
  assert.doesNotMatch(css, /@media \(max-width: (?!560px|820px)\d+px\)/);
});
