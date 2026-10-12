import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

async function source(path) {
  return (await readFile(`${appRoot}/${path}`, "utf8")).replace(/\r\n/g, "\n");
}

test("Bot roster has a real scroll container so 项目协作室 is not clipped", async () => {
  const [html, css, grok] = await Promise.all([
    source("public/index.html"),
    source("public/forge/bot-shell.css"),
    source("public/forge/bot-grok-face.css"),
  ]);
  assert.match(html, /<section class="bot-surface-panel bot-roster-scroll is-active" id="bot-surface-chats"/);
  assert.match(html, /<section class="bot-surface-panel bot-roster-scroll" id="bot-surface-contacts"/);
  assert.match(html, /id="bot-roster-label">项目与会话</);
  assert.match(css, /\.bot-roster \{[\s\S]*display: flex;[\s\S]*flex-direction: column;[\s\S]*overflow: hidden;/);
  assert.match(css, /\.bot-roster-scroll \{\n  overflow-x: hidden;\n  overflow-y: auto;/);
  assert.match(css, /\.bot-active-runs \{[\s\S]*max-height: min\(42vh, 360px\);/);
  assert.match(css, /#bot-active-runs-list \{[\s\S]*overflow-y: auto;/);
  assert.match(css, /\.bot-inspector-ops \{/);
  assert.match(css, /\.bot-inspector-toolbar \{/);
  assert.match(css, /\.bot-inspector-scroll \{/);
  assert.match(css, /\.bot-inspector-card \{/);
  assert.match(css, /\.bot-shell-grid\.is-ops-collapsed \{/);
  assert.match(grok, /html\.is-bot-grok-face #view-bot \.bot-roster-scroll/);
  assert.match(grok, /html\.is-bot-grok-face #view-bot \.bot-active-runs \{[\s\S]*max-height: min\(42vh, 360px\);/);
  assert.doesNotMatch(grok, /@media \(max-width: (?!560px|820px|1100px)\d+px\)/);
  assert.match(grok, /@media \(max-width: 1100px\) and \(min-width: 821px\)/);
});

test("Bot home top icons have destinations after workbench retirement", async () => {
  const [html, app, chrome] = await Promise.all([
    source("public/index.html"),
    source("public/app.js"),
    source("public/workbench-chrome.js"),
  ]);
  assert.match(html, /id="theme-toggle"/);
  assert.match(html, /id="refresh-button"/);
  assert.match(html, /id="chrome-rail-toggle"[^>]+aria-label="收起或展开对话列表"/);
  assert.match(html, /id="chrome-ops-toggle"[^>]+aria-label="收起或展开右侧栏"/);
  assert.match(html, /id="global-terminal-toggle"[^>]+aria-label="打开终端"/);
  assert.match(html, /id="global-mc-toggle"[^>]+aria-label="展开右侧栏"/);
  assert.match(app, /function handleBotHomeTerminalToggle\(/);
  assert.match(app, /function handleBotHomePanelToggle\(/);
  // 2026-09-12 W11：终端并入右栏页签——入口统一为 botRailTerminalToggle（重开/激活/回会话页）
  assert.match(app, /function botRailTerminalToggle\(/);
  assert.match(app, /botRailTerminalToggle\(\)/);
  assert.doesNotMatch(app, /setView\(state\.view === "terminal" \? "bot" : "terminal"\)/);
  assert.match(html, /id="bot-terminal-drawer"/);
  assert.match(html, /id="bot-ops-rail"/);
  assert.match(html, /class="bot-inspector-ops"/);
  assert.match(html, /id="bot-agent-panel"[^>]+role="complementary"/);
  assert.doesNotMatch(html, /<aside class="bot-ops-rail"/);
  // 审批 / 文件自 2026-09-11 起是**右栏标签**（Codex 对标），不再是动作按钮——
  // 「看」类做标签、「开/做」类做图标动作。面板 id 未变，仍是同一批锚点。
  assert.match(html, /data-bot-rail-tab="approvals"/);
  assert.match(html, /data-bot-rail-tab="files"/);
  assert.match(html, /id="bot-ops-files"/);
  assert.match(html, /成员电脑连接/);
  const roster = html.slice(html.indexOf('class="bot-roster"'), html.indexOf('class="bot-conversation"'));
  assert.doesNotMatch(roster, /id="bot-ops-rail"/);
  const inspector = html.slice(html.indexOf('id="bot-agent-panel"'));
  assert.match(inspector, /id="bot-ops-rail"/);
  assert.match(inspector, /class="bot-inspector-toolbar"/);
  assert.match(inspector, /class="bot-inspector-scroll"/);
  assert.match(inspector, /id="bot-panel-avatar"/);
  assert.match(inspector, /id="bot-inspector-status"/);
  assert.match(inspector, /id="bot-ops-files"/);
  assert.match(inspector, /成员电脑连接/);
  assert.match(inspector, /id="bot-routine-list"/);
  assert.match(inspector, /id="bot-channels-list"/);
  assert.match(inspector, /class="bot-inspector-toolbar"[\s\S]*class="bot-inspector-scroll"[\s\S]*bot-inspector-card[\s\S]*id="bot-computer-preview"/);
  assert.match(html, /class="bot-conversation"[\s\S]*id="bot-agent-panel"[\s\S]*id="bot-ops-rail"/);
  assert.match(app, /botMemberComputerRows\(/);
  assert.match(app, /ensureBotOpsFiles\(/);
  assert.match(app, /path: "bot-ops-files-path"/);
  const connectionStart = app.indexOf("function renderBotMemberConnections()");
  const connectionEnd = app.indexOf("\nasync function openBotForRun", connectionStart);
  assert.ok(connectionStart >= 0 && connectionEnd > connectionStart);
  const connectionFn = app.slice(connectionStart, connectionEnd);
  assert.match(connectionFn, /probes: state\.configHostProbes/);
  assert.doesNotMatch(connectionFn, /teamPulseMembers\(/);
  assert.doesNotMatch(connectionFn, /botHostConnectionsMarkup\(/);
  assert.doesNotMatch(app, /const members = teamPulseMembers\(\);\s*\n\s*const hosts = Array\.isArray\(state\.configHosts\)/);
  assert.match(app, /applyOpsRailCollapsed\(!readOpsCollapsed\(\)\)/);
  assert.match(app, /writeRosterCollapsed\(collapsed\)/);
  assert.match(app, /applyRosterCollapsed\(collapsed\)/);
  assert.match(app, /bot-header-avatar", "bot-panel-avatar", "bot-panel-agent-name"/);
  assert.match(app, /bot-inspector-status/);
  assert.match(app, /querySelectorAll\("\.bot-computer-bar strong"\)/);
  assert.match(app, /function applyOpsRailCollapsed\(/);
  assert.match(app, /applyOpsCollapsed\(next\)/);
  assert.match(app, /conversationListsRun\(conversation, id\)/);
  assert.match(app, /botConversationForRun\(botState\.conversations, id, run\)/);
  assert.match(app, /state\.selectedRunId = id;/);
  assert.doesNotMatch(app, /if \(!conversation\?\.id \|\| !\(conversation\.runIds \|\| \[\]\)\.some/);
  assert.match(app, /if \(state\.view === "bot"\) jobs\.push\(loadBootstrap\(\), loadRuns\(\), botLoadConversations\(\)\)/);
  assert.match(chrome, /if \(!drawer\.closest\("\.view"\)\?\.classList\.contains\("is-active"\)\) return;/);
  assert.match(chrome, /if \(!shell\.closest\("\.view"\)\?\.classList\.contains\("is-active"\)\) return;/);
  assert.doesNotMatch(chrome, /topbar-nav \[data-view="bot"\]/);
});

test("W15 · 会话切换必须有 run 解析兜底（不许停在空占位）", async () => {
  const app = await readFile(`${appRoot}/public/app.js`, "utf8");
  // botSelectMember：run 解析失败时走 botOpenConversationRun 单拉回填
  const selectFn = /function botSelectMember\([^)]*\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.ok(selectFn, "botSelectMember 缺失");
  assert.match(selectFn, /if \(conversation && !botConversationRun\(conversation\)\) \{[\s\S]{0,300}?botOpenConversationRun\(conversation, runId/);
  // botOpenConversation direct 分支：同样的兜底
  const openFn = /function botOpenConversation\([^)]*\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.ok(openFn, "botOpenConversation 缺失");
  assert.match(openFn, /if \(!botConversationRun\(conversation\)\) \{[\s\S]{0,300}?botOpenConversationRun\(conversation, runId, conversation\.directMemberId\)/);
  // group 分支：run 未解析导致参与者为空时按会话登记的 run 兜底拉取，不是拒绝切换
  assert.match(openFn, /run 未解析导致参与者为空[\s\S]{0,400}?botOpenConversationRun\(conversation, runId\)/);
  // 兜底取 run 的顺序：activeRunId 优先、runIds 尾部次之（最新 run）
  assert.match(openFn, /conversation\.activeRunId \|\| \(Array\.isArray\(conversation\.runIds\) \? conversation\.runIds\[conversation\.runIds\.length - 1\] : ""\)/);
});

test("W16 · 未知 runId 的消息必须触发会话索引刷新（不许静默丢弃）", async () => {
  const app = await readFile(`${appRoot}/public/app.js`, "utf8");
  // pushEvent：user/assistant.message 的未知 runId（发送受理 → 服务端新建 run → SSE 先到）
  // 必须触发 botReloadConversationsForUnknownRun——静默返回 = 「发了消息但不渲染会话」
  assert.match(app, /if \(event\.runId && !botState\.runAgents\[String\(event\.runId\)\]\) \{[\s\S]{0,300}?botReloadConversationsForUnknownRun\(event\.runId\);/);
  // 当前 run 命中时不触发（正常流零额外请求）
  assert.match(app, /const currentRun = botRunForAgent\(botState\.agentId\);[\s\S]{0,120}String\(currentRun\.id\) !== String\(event\.runId\)/);
  // 去重 + 失败重试：成功后记账，失败回吐（不让去重集合挡住恢复路径）
  const helper = /function botReloadConversationsForUnknownRun\([\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.ok(helper, "botReloadConversationsForUnknownRun 缺失");
  assert.match(helper, /botUnknownRunReloads\.has\(id\)[\s\S]{0,80}botUnknownRunReloads\.add\(id\)/);
  assert.match(helper, /botUnknownRunReloads\.delete\(id\); \/\/ 刷新失败允许后续事件重试/);
  assert.match(helper, /void botLoadConversations\(\)/);
});
