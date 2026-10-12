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

test("ops rail collapse persists and pins the right sidebar class", async () => {
  const store = new Map();
  const classes = new Set();
  const panel = {
    hidden: false,
    inert: false,
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
  };
  const trigger = {
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
  };
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
  };
  globalThis.document = {
    querySelector(selector) {
      if (selector === "#view-bot .bot-shell-grid") {
        return {
          classList: {
            toggle(name, on) {
              if (on) classes.add(name);
              else classes.delete(name);
            },
          },
        };
      }
      return null;
    },
    getElementById(id) {
      if (id === "bot-agent-panel") return panel;
      if (id === "bot-agent-info-button") return trigger;
      return null;
    },
  };
  const {
    BOT_OPS_KEY,
    readOpsCollapsed,
    writeOpsCollapsed,
    applyOpsCollapsed,
  } = await import("../public/modules/bot-grok-face.js");
  assert.equal(readOpsCollapsed(), false);
  writeOpsCollapsed(true);
  assert.equal(store.get(BOT_OPS_KEY), "1");
  assert.equal(applyOpsCollapsed(true), true);
  assert.equal(classes.has("is-ops-collapsed"), true);
  assert.equal(panel.hidden, true);
  assert.equal(panel.attrs["aria-hidden"], "true");
  assert.equal(trigger.attrs["aria-expanded"], "false");
  assert.equal(applyOpsCollapsed(false), false);
  assert.equal(classes.has("is-ops-collapsed"), false);
  assert.equal(panel.hidden, false);
  assert.equal(panel.attrs["aria-hidden"], "false");
  assert.equal(trigger.attrs["aria-expanded"], "true");
});

test("Grok face lets custom wallpaper show through when team-bg-active", async () => {
  const css = await readFile(`${appRoot}/public/forge/bot-grok-face.css`, "utf8");
  assert.match(css, /:not\(:has\(body\.team-bg-active\)\) \.atelier-stage/);
  assert.match(css, /html\.is-bot-grok-face body\.team-bg-active #view-bot \.bot-agent-panel/);
  assert.match(css, /html\.is-bot-grok-face body\.team-bg-active #view-bot \.bot-inspector-card/);
  assert.match(css, /html\.is-bot-grok-face #view-bot \.bot-shell-grid \{[\s\S]{0,80}--bot-ops: 320px/);
  assert.match(css, /html\.is-bot-grok-face #view-bot \.bot-shell-grid\.is-ops-collapsed/);
  assert.match(css, /html\.is-bot-grok-face #view-bot \.bot-active-run\.is-current \{[\s\S]*inset 2px 0 0 var\(--bot-ink\)/);
  assert.match(css, /--forge-glass-filter/);
  assert.doesNotMatch(css, /html\.is-bot-grok-face body\.team-bg-active #view-bot \.bot-composer \{\s*background: var\(--bot-bg\);/);
});

test("Grok face CSS keeps 390px composer and chips tappable", async () => {
  const css = await readFile(`${appRoot}/public/forge/bot-grok-face.css`, "utf8");
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /min-height: 44px/);
  assert.doesNotMatch(css, /@media \(max-width: (?!560px|820px|1100px)\d+px\)/);
  assert.match(css, /@media \(max-width: 1100px\) and \(min-width: 821px\)/);
  assert.match(css, /--bot-transcript-width: 720px/);
  assert.match(css, /\.bot-message-stream > :is\([\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*var\(--bot-transcript-width\)/);
  assert.match(css, /\.bot-composer-ops-chips/);
  assert.match(css, /is-roster-collapsed\.is-mobile-conversation \.bot-roster \{[\s\S]*display: none/);
  assert.doesNotMatch(css, /html\.is-bot-grok-face #view-bot \.workspace-navigation,\s*html\.is-bot-grok-face #view-bot \.workspace-secondary-navigation \{\s*display: flex/);
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

test("Grok face centers approval and attention cards aligned with the transcript column", async () => {
  const [faceCss, workspaceCss] = await Promise.all([
    readFile(`${appRoot}/public/forge/bot-grok-face.css`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-workspace.css`, "utf8"),
  ]);
  assert.match(faceCss, /html\.is-bot-grok-face #view-bot \.workspace-attention[\s\S]*?width:\s*100%/);
  assert.match(faceCss, /html\.is-bot-grok-face #view-bot \.workspace-attention \.bot-card[\s\S]*?max-width:\s*var\(--bot-transcript-width,\s*720px\)/);
  assert.match(faceCss, /html\.is-bot-grok-face #view-bot \.workspace-attention \.bot-card[\s\S]*?margin-inline:\s*auto/);
  assert.match(faceCss, /html\.is-bot-grok-face #view-bot \.bot-approval-card/);
  assert.match(workspaceCss, /\.workspace-attention \.bot-card[\s\S]*?max-width:\s*var\(--workspace-reading-width\)/);
  assert.match(workspaceCss, /\.workspace-attention \.bot-card[\s\S]*?margin:\s*0 auto 8px/);
});

test("activity timeline preserves stream keys and excludes interactive tool calls from folding", async () => {
  const { createBotActivityTimeline } = await import("../public/modules/bot-activity-timeline.js");
  const { botConversationMessagesMarkup } = createBotActivityTimeline({
    botMeta: () => ({ label: "烛" }),
    botMessageAvatar: () => "",
    processCardMarkup: () => `<details class="process-card"><summary>tool</summary></details>`,
    messageMarkup: (message) => `<article class="bot-message">${message.text || ""}</article>`,
    botEventMarkup: (message) => `<article class="bot-message bot-message-${message.kind}">${message.text || ""}</article>`,
  });

  const html = botConversationMessagesMarkup([
    { key: "evt-1", kind: "process", progress: { kind: "tool", name: "read" } },
    { key: "evt-2", kind: "assistant", text: "" }, // 串流中的空块不切碎折叠组
    { key: "evt-3", kind: "process", progress: { kind: "tool", name: "write" } },
    { key: "evt-4", kind: "assistant", tools: [{ name: "AskUserQuestion", input: "是否继续？" }] },
  ]);

  // 1. 思考过程有稳定 stream key，且未被空文本块切碎成多个折叠组
  assert.match(html, /<details class="bot-activity-group" data-stream-key="activity-group:evt-1"/);
  const groupCount = (html.match(/class="bot-activity-group"/g) || []).length;
  assert.equal(groupCount, 1, "空消息块不应将同一段思考过程切成多个药丸");

  // 2. 内层 segment 也具备稳定 stream key
  assert.match(html, /<details class="bot-activity-segment" data-stream-key="activity-segment:evt-1"/);

  // 3. AskUserQuestion 交互式工具调用未被吸入折叠组，而是作为独立消息呈现
  assert.match(html, /bot-message-assistant/);
});

test("Grok face CSS contains capsule centering and card expansion rules", async () => {
  const css = await readFile(`${appRoot}/public/forge/bot-grok-face.css`, "utf8");
  assert.match(css, /details\.bot-activity-group:not\(\[open\]\)[\s\S]*?justify-content:\s*center/);
  assert.match(css, /details\.bot-activity-group:not\(\[open\]\) > \.bot-activity-summary[\s\S]*?width:\s*fit-content/);
  assert.match(css, /details\.bot-activity-group:not\(\[open\]\) > \.bot-activity-summary[\s\S]*?height:\s*32px/);
  assert.match(css, /details\.bot-activity-group\[open\] > \.bot-activity-timeline[\s\S]*?overflow:\s*visible/);
});

test("bookkeeping-only turns never render a process pill; echo asks are dropped", async () => {
  const { createBotActivityTimeline } = await import("../public/modules/bot-activity-timeline.js");
  const { botConversationMessagesMarkup } = createBotActivityTimeline({
    botMeta: () => ({ label: "Miku" }),
    botMessageAvatar: () => "",
    processCardMarkup: () => `<details class="process-card"><summary>tool</summary></details>`,
    messageMarkup: (message) => `<article class="bot-message">${message.text || ""}</article>`,
    botEventMarkup: (message) => `<article class="bot-message bot-message-${message.kind}">${message.text || ""}</article>`,
  });
  const reply = "[[msg:lo]]\nHello节拍收到——♪ Welcome to Miku's stage!\n\n把实验要求丢过来吧";
  const spoken = reply.replace(/^\[\[msg:lo\]\]\s*/, "");
  // 真实 run 5844c783 的一轮：turn_started → assistant → turn_completed → bus.routed(lo) → waiting_input
  const html = botConversationMessagesMarkup([
    { key: "u1", kind: "user", text: "hello", author: "LO" },
    { key: "d1", kind: "divider", text: "第 1 轮 · Miku" },
    { key: "a1", kind: "assistant", text: reply, author: "miku" },
    { key: "m1", kind: "turn-meta", text: "第 1 轮完成 · Miku · 本次 1/6" },
    { key: "r1", kind: "governance", eventType: "bus.routed", sourceTo: "lo", sourceFrom: "miku", sourceText: spoken.slice(0, 140), text: `Miku 向你提问：${spoken.slice(0, 60)}…` },
    { key: "w1", kind: "governance", eventType: "run.waiting_input", sourceFrom: "miku", sourceText: spoken, text: `团队向你提问（来自 Miku）：${spoken.slice(0, 60)}…` },
    { key: "u2", kind: "user", text: "你好", author: "LO" },
  ]);
  assert.doesNotMatch(html, /bot-activity-group/, "只有记账/复述的轮次不应渲染药丸");
  assert.match(html, /bot-message-user">hello/);
  assert.match(html, /bot-message-user">你好/);
  assert.match(html, /Welcome to Miku/);

  // 真工具调用仍折叠；记账项不计入药丸数字
  const withTool = botConversationMessagesMarkup([
    { key: "d2", kind: "divider", text: "第 2 轮" },
    { key: "p2", kind: "process", progress: { kind: "tool", name: "read" } },
    { key: "m2", kind: "turn-meta", text: "第 2 轮完成" },
    { key: "a2", kind: "assistant", text: "读完了", author: "miku" },
  ]);
  assert.match(withTool, /<details class="bot-activity-group"[^>]*data-bot-activity-count="1"/);
  assert.match(withTool, /<b>1<\/b>/);

  // 非复述的治理事件（广播 / 失败）保持可见
  const broadcast = botConversationMessagesMarkup([
    { key: "a3", kind: "assistant", text: "收到", author: "miku" },
    { key: "r3", kind: "governance", eventType: "bus.routed", sourceTo: "team", sourceText: "大家看一下第三题", text: "Miku 向全员广播：大家看一下第三题" },
  ]);
  assert.match(broadcast, /bot-activity-group/);
});

test("message footer actions are wired and styled", async () => {
  const [app, refresh, face] = await Promise.all([
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/shell-refresh.css`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-grok-face.css`, "utf8"),
  ]);
  assert.match(app, /closest\("\[data-bot-message-action\]"\)/);
  assert.match(app, /botForkConversation\(conversation, \{ upToRunId/);
  assert.match(refresh, /#view-bot \.bot-message-footer \{[\s\S]*?display: flex/);
  assert.match(refresh, /#view-bot \.bot-message:focus-within \.bot-message-actions/);
  assert.match(refresh, /@media \(hover: none\)[\s\S]*?\.bot-message-actions/);
  assert.match(face, /body\.team-bg-active #view-bot \.bot-message time \{[\s\S]*?backdrop-filter/);
});

test("a real question that merely prefixes the reply is never swallowed as an echo", async () => {
  const { createBotActivityTimeline } = await import("../public/modules/bot-activity-timeline.js");
  const { botConversationMessagesMarkup } = createBotActivityTimeline({
    botMeta: () => ({ label: "Miku" }),
    botMessageAvatar: () => "",
    processCardMarkup: () => "",
    messageMarkup: (message) => `<article class="bot-message">${message.text || ""}</article>`,
    botEventMarkup: (message) => `<article class="bot-message bot-message-${message.kind}">${message.text || ""}</article>`,
  });
  // 烛 2026-09-30 复现：回复「请确认选择 A 或 B。」后，正文「请确认选择」的提问被前缀比对吞掉
  const html = botConversationMessagesMarkup([
    { key: "a1", kind: "assistant", text: "请确认选择 A 或 B。", author: "miku" },
    { key: "w1", kind: "governance", eventType: "run.waiting_input", sourceFrom: "miku", sourceText: "请确认选择", text: "团队向你提问（来自 Miku）：请确认选择" },
  ]);
  assert.match(html, /bot-activity-group/, "非完整复述的提问必须保留");
  // 他人发出的同文提问也不算本条回复的复述
  const other = botConversationMessagesMarkup([
    { key: "a2", kind: "assistant", text: "收到", author: "miku" },
    { key: "w2", kind: "governance", eventType: "run.waiting_input", sourceFrom: "codex", sourceText: "收到", text: "团队向你提问（来自 Codex）：收到" },
  ]);
  assert.match(other, /bot-activity-group/);
  // bus.routed 恰好截断在 140 字时，前缀复述仍然识别为复述
  const long = "长".repeat(200);
  const truncated = botConversationMessagesMarkup([
    { key: "a3", kind: "assistant", text: `[[msg:lo]]\n${long}`, author: "miku" },
    { key: "r3", kind: "governance", eventType: "bus.routed", sourceTo: "lo", sourceFrom: "miku", sourceText: long.slice(0, 140), text: "Miku 向你提问：…" },
  ]);
  assert.doesNotMatch(truncated, /bot-activity-group/);
});

test("new-conversation dialog is styled as a stacked form card, not a bare UA dialog", async () => {
  const css = await readFile(`${appRoot}/public/forge/bot-workspace.css`, "utf8");
  // 对话框本体：圆角卡 + 遮罩
  assert.match(css, /\.assistant-start-dialog\s*\{[^}]*border-radius:/);
  assert.match(css, /\.assistant-start-dialog::backdrop\s*\{/);
  // 表单纵向排布：标签在控件上方，控件占满宽度
  assert.match(css, /\.assistant-start-dialog form\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.assistant-start-dialog :is\(select, input\)\s*\{[^}]*width:\s*100%/);
  // 主/次按钮与次级入口都有样式（此前这些类在全仓 CSS 中零命中）
  assert.match(css, /\.assistant-start-dialog \.primary-button\s*\{/);
  assert.match(css, /\.assistant-start-dialog \.secondary-button\s*\{/);
  assert.match(css, /\.assistant-start-alternatives\s*\{/);
  // 状态行为空时不占位
  assert.match(css, /\[data-assistant-status\]:empty\s*\{[^}]*display:\s*none/);
});
