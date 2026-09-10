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

test("conversation stream keeps human turns visible and folds process closed", async () => {
  const { createBotActivityTimeline } = await import("../public/modules/bot-activity-timeline.js");
  const { botConversationMessagesMarkup } = createBotActivityTimeline({
    botMeta: () => ({ label: "烛" }),
    botMessageAvatar: () => "",
    processCardMarkup: () => `<details class="process-card"><summary>tool</summary></details>`,
    messageMarkup: (message) => `<article class="bot-message">${message.text || ""}</article>`,
    botEventMarkup: (message) => `<article class="bot-message bot-message-${message.kind}">${message.text || ""}</article>`,
  });
  const html = botConversationMessagesMarkup([
    { kind: "user", text: "你好", author: "LO" },
    { kind: "process", progress: { kind: "tool", name: "read" } },
    { kind: "assistant", text: "写好了", author: "烛" },
  ]);
  assert.match(html, /bot-message-user">你好/);
  assert.match(html, /bot-message-assistant">写好了/);
  assert.match(html, /<details class="bot-activity-group"/);
  assert.match(html, /<strong>思考过程<\/strong>/);
  assert.doesNotMatch(html, /<details class="bot-activity-group"[^>]*\sopen\b/);
  assert.doesNotMatch(html, /思考、工具调用与文件改动已收纳/);
  const processAt = html.indexOf("bot-activity-group");
  const replyAt = html.indexOf("写好了");
  assert.ok(processAt > -1 && replyAt > processAt, "助手回复应出现在折叠过程之后，而不是被收进 details");
});

test("Grok face light and dark tokens both paint a polished chat canvas", async () => {
  const css = await readFile(`${appRoot}/public/forge/bot-grok-face.css`, "utf8");
  assert.match(css, /html\.is-bot-grok-face\[data-theme="light"\]/);
  assert.match(css, /--bot-grok-canvas:\s*#f7f7f8/);
  assert.match(css, /--bot-grok-canvas:\s*#050505/);
  assert.match(css, /color-scheme: light/);
  assert.match(css, /color-scheme: dark/);
  assert.match(css, /\.bot-process-toggle/);
  assert.match(css, /\.bot-proof-summary/);
  assert.match(css, /\.bot-run-state\.is-idle/);
  assert.match(css, /\.bot-message-tool-note/);
});
