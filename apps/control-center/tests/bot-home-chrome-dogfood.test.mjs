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
  assert.doesNotMatch(grok, /@media \(max-width: (?!560px|820px)\d+px\)/);
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
  assert.match(app, /botTerminalDock\?\.toggle\?\.\(\)/);
  assert.doesNotMatch(app, /setView\(state\.view === "terminal" \? "bot" : "terminal"\)/);
  assert.match(html, /id="bot-terminal-drawer"/);
  assert.match(html, /id="bot-ops-rail"/);
  assert.match(html, /class="bot-inspector-ops"/);
  assert.match(html, /id="bot-agent-panel"[^>]+role="complementary"/);
  assert.doesNotMatch(html, /<aside class="bot-ops-rail"/);
  assert.match(html, /data-bot-workspace-action="approvals"/);
  assert.match(html, /data-bot-workspace-action="files"/);
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
