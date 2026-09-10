import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  botClearEmptyConversation,
  botNormalizeTranscript,
  botStreamHasMessages,
} from "../public/modules/bot-transcript-dom.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

function node(className, extras = {}) {
  const item = {
    className,
    removed: false,
    ...extras,
    remove() {
      this.removed = true;
      const parent = this.parent;
      if (parent) parent.children = parent.children.filter((child) => child !== this);
    },
  };
  return item;
}

function streamWith(children) {
  const stream = { children: [] };
  for (const child of children) {
    child.parent = stream;
    stream.children.push(child);
  }
  stream.querySelector = (selector) => stream.querySelectorAll(selector)[0] || null;
  stream.querySelectorAll = (selector) => {
    const tokens = selector.split(",").map((part) => part.trim());
    return stream.children.filter((child) => tokens.some((token) => {
      if (token.startsWith(".")) return String(child.className || "").split(/\s+/).includes(token.slice(1));
      if (token.startsWith("[")) return Boolean(child[token.slice(1, -1)]);
      return false;
    }));
  };
  return stream;
}

test("empty hero is stripped as soon as a real transcript item exists", () => {
  const empty = node("bot-message-empty bot-empty-hero");
  const message = node("bot-message bot-message-user");
  const stream = streamWith([empty, message]);
  assert.equal(botStreamHasMessages(stream), true);
  assert.equal(botNormalizeTranscript(stream), true);
  assert.equal(empty.removed, true);
  assert.equal(stream.children.length, 1);
  assert.equal(stream.children[0], message);
});

test("clearing empty is a no-op when the conversation is truly empty", () => {
  const empty = node("bot-message-empty bot-empty-hero");
  const stream = streamWith([empty]);
  assert.equal(botStreamHasMessages(stream), false);
  assert.equal(botNormalizeTranscript(stream), false);
  assert.equal(empty.removed, false);
  assert.equal(botClearEmptyConversation(stream), true);
  assert.equal(empty.removed, true);
});

test("Bot append and restore paths normalize empty-plus-message HTML", async () => {
  const app = await readFile(`${appRoot}/public/app.js`, "utf8");
  assert.match(app, /from "\.\/modules\/bot-transcript-dom\.js"/);
  assert.match(app, /function botAppendUserMessage\(text\) \{[\s\S]*botClearEmptyConversation\(stream\)/);
  assert.match(app, /function botSaveMessageStore[\s\S]*botNormalizeTranscript\(stream\)/);
  assert.match(app, /reconcileMessageMarkup\(stream, stored\.html\);\s*botNormalizeTranscript\(stream\)/);
  assert.match(app, /reconcileMessageMarkup\(stream, renderedHtml\);\s*botNormalizeTranscript\(stream\)/);
});

test("Grok face keeps a centered transcript column and hides workbench composer chips", async () => {
  const [face, workspace, shell, html] = await Promise.all([
    readFile(`${appRoot}/public/forge/bot-grok-face.css`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-workspace.css`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
    readFile(`${appRoot}/public/index.html`, "utf8"),
  ]);
  assert.match(face, /--bot-transcript-width: 720px/);
  assert.match(face, /#view-bot \.bot-message-user \{[\s\S]*align-self: auto/);
  assert.match(face, /#view-bot \.bot-message-stream:has\(\.bot-message\) \.bot-message-empty/);
  assert.match(face, /#view-bot \.bot-composer-ops-chips,[\s\S]*#view-bot \.bot-composer-footer \{[\s\S]*display: none !important/);
  assert.match(workspace, /#view-bot \.bot-message-stream:has\(\.bot-message\) \.bot-message-empty/);
  assert.match(workspace, /#view-bot \.bot-composer-overflow:not\(\[open\]\) \.bot-composer-footer/);
  assert.doesNotMatch(workspace, /#view-bot \.bot-composer-footer \{ display: flex !important/);
  assert.match(shell, /\.bot-message-user \{ align-self: auto/);
  assert.match(html, /class="bot-composer-send-fields"/);
  assert.match(html, /class="bot-composer-ops-chips"/);
  assert.match(html, /id="bot-composer-overflow"/);
});
