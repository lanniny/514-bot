import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("514 Bot starts on the restored 514cc workbench while the Bot conversation route remains available", async () => {
  const [html, app, state, palette, css, artDirection] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/state.js`, "utf8"),
    readFile(`${appRoot}/public/command-palette.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
    readFile(`${appRoot}/public/forge/art-direction.css`, "utf8"),
  ]);
  assert.match(html, /id="view-bot"[^>]+data-view-panel="bot"/);
  assert.match(html, /id="bot-surface-tabs"[^>]+role="tablist"/);
  assert.match(html, /data-bot-surface-tab="chats"/);
  assert.match(html, /data-bot-surface-tab="contacts"/);
  assert.match(html, /id="bot-contact-list"[^>]+role="list"/);
  // W2.5 三套导航由 nav-config.js 单一真源生成；index.html 只保留挂载点
  assert.match(html, /data-nav-surface="primary"/);
  assert.match(html, /data-nav-surface="topbar"/);
  assert.match(html, /data-nav-surface="mobile"/);
  assert.match(app, /renderNavigation\(\)/);
  assert.match(html, /id="view-workbench"[^>]+data-view-panel="workbench"[^>]+aria-labelledby="workbench-title"/);
  assert.doesNotMatch(html, /id="view-workbench"[^>]+hidden/);
  assert.match(html, /id="view-bot"[^>]+hidden/);
  assert.doesNotMatch(html, /<html[^>]+is-bot-surface/);
  const restoredChrome = css.slice(
    css.indexOf("/* Bot 是默认工作面，但重新嵌入 514cc 单界面控制台壳。 */"),
    css.indexOf(".bot-first-response"),
  );
  assert.doesNotMatch(restoredChrome, /html\.is-bot-surface \.topbar(?:\s*[,\{])/);
  assert.doesNotMatch(restoredChrome, /html\.is-bot-surface \.global-statusbar(?:\s*[,\{])/);
  assert.match(css, /html\.is-bot-surface \.main-content[\s\S]*padding: 8px 10px 9px !important[\s\S]*overflow: hidden/);
  assert.match(state, /bot: "514 Bot"/);
  assert.match(app, /const view = routeView \|\| "workbench"/);
  assert.match(app, /setView\(initialView/);
  assert.match(app, /function initBotShell\(/);
  assert.match(app, /if \(view === "bot"\) initBotShell\(\)/);
  // UI-AUDIT P0-5：命令面板图标改由导航单一真源派生（此前双写一份图标表，
  // 导航换图标时面板仍显示旧的）。锁住"派生关系"，而不是锁死某个字面量。
  assert.match(palette, /import \{ NAV_ITEMS \} from "\.\/modules\/nav-config\.js"/);
  assert.match(palette, /\.\.\.Object\.fromEntries\(Object\.entries\(NAV_ITEMS\)/);
  assert.match(await readFile(`${appRoot}/public/modules/nav-config.js`, "utf8"), /bot: \{ icon: "messages-square"/);
  assert.match(css, /\.bot-shell-grid/);
  assert.doesNotMatch(artDirection, /html\.is-bot-surface \.topbar[\s\S]{0,220}display: none !important/);
  assert.match(artDirection, /Bot 重新嵌入 514cc 单界面控制台/);
  assert.match(html, /forge\/art-direction\.css[\s\S]*forge\/bot-shell\.css/);
  assert.match(html, /id="atelier-stage"[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /id="atelier-stage"[^>]*\shidden/);
  assert.match(html, /id="sidebar"[^>]*aria-label="主导航"/);
  assert.doesNotMatch(html, /id="sidebar"[^>]*data-bot-hidden-chrome/);
  assert.match(html, /class="topbar">/);
  assert.doesNotMatch(html, /class="topbar"[^>]*data-bot-hidden-chrome/);
  assert.match(html, /<strong>514 Bot<\/strong>[\s\S]*<span>Control Center<\/span>/);
  assert.match(html, /id="global-status-version">514 Bot runtime/);
  assert.match(html, /id="bot-first-response"/);
  assert.match(css, /html\.is-bot-surface \.sidebar[\s\S]*display: none !important/);
  assert.match(css, /html\.is-bot-surface #atelier-canvas/);
  assert.doesNotMatch(css, /html\.is-bot-surface \.atelier-stage[\s\S]{0,160}display: none !important/);
  assert.match(css, /html\.is-bot-surface \.primary-nav/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*grid-template-areas: "topbar" "main" !important/);
  assert.match(css, /html\.is-bot-surface \.topbar \.mobile-menu-button \{ display: none !important; \}/);
  assert.match(app, /function syncBotSurfaceChrome\(/);
  assert.match(app, /\["\.topbar", "\.global-statusbar"\][\s\S]{0,360}node\.hidden = false/);
  assert.match(app, /document\.title = view === "bot" \? "514 Bot"/);
  assert.match(app, /waiting for you/);
  assert.match(app, /function botSyncFirstResponse\(/);
  assert.match(app, /replace\(\/\^\\\/\+\/, ""\)/);
  assert.match(app, /data-bot-card="connector"/);
  assert.match(app, /data-bot-card="cloud-computer"/);
  assert.match(app, /data-bot-card="routine"/);
  assert.match(app, /data-bot-card="artifact"/);
  assert.match(app, /data-bot-card="attention"/);
});

test("Bot global dialogs keep compact geometry while inheriting the Forge palette", async () => {
  const [app, css] = await Promise.all([
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
  ]);
  const dialogSkinStart = css.indexOf("/* Bot 全局弹层保留紧凑几何，但颜色回归 Forge 暖纸 / 深墨 / 铜橙");
  assert.ok(dialogSkinStart > -1, "缺少 Bot 全局弹层视觉边界");
  const dialogSkin = css.slice(dialogSkinStart);
  assert.match(dialogSkin, /html\.is-bot-surface body > dialog\.action-dialog \{/);
  assert.match(dialogSkin, /html\.is-bot-surface body\.atelier > dialog\.action-dialog[\s\S]*border-radius: 6px !important/);
  assert.match(dialogSkin, /html\.is-bot-surface\[data-theme="dark"\] body > dialog\.action-dialog/);
  assert.match(dialogSkin, /--bot-dialog-bg: var\(--bot-panel, var\(--forge-paper\)\)/);
  assert.match(dialogSkin, /--bot-dialog-accent: var\(--bot-accent, var\(--forge-copper-ink\)\)/);
  assert.match(dialogSkin, /--accent: var\(--bot-dialog-accent\)/);
  assert.doesNotMatch(dialogSkin, /--amber(?:-soft)?\s*:/);
  assert.match(dialogSkin, /#provider-dialog \.provider-hint-bar[\s\S]*border-color: var\(--bot-dialog-muted\)/);
  assert.match(dialogSkin, /dialog\.action-dialog::backdrop[\s\S]*backdrop-filter: none/);
  assert.match(dialogSkin, /#action-dialog\[data-tone="danger"\] \.dialog-warning/);
  assert.match(dialogSkin, /#action-dialog[\s\S]*width: min\(500px, calc\(100vw - 32px\)\)/);
  assert.match(dialogSkin, /#common-config-dialog[\s\S]*width: min\(820px, calc\(100vw - 32px\)\)/);
  assert.match(dialogSkin, /@media \(max-width: 560px\)[\s\S]*#input-dialog/);
  assert.doesNotMatch(dialogSkin, /var\(--amber-soft\)|var\(--rose-fill\)|var\(--radius-4xl\)/);
  assert.match(app, /dialog\.dataset\.tone = danger \? "danger" : "default"/);
  assert.match(app, /\["common-config-dialog", "provider-deeplink-dialog"\][\s\S]{0,300}classList\.toggle\("action-dialog", bot\)/);
  assert.match(app, /querySelector\("\.dialog-header"\)\?\.classList\.toggle\("dialog-heading", bot\)/);
  const dialogRegistry = app.slice(app.indexOf("const BOT_GLOBAL_DIALOG_IDS"), app.indexOf("function syncBotSurfaceChrome"));
  for (const id of [
    "action-dialog",
    "input-dialog",
    "automation-dialog",
    "session-dialog",
    "provider-dialog",
    "common-config-dialog",
    "provider-deeplink-dialog",
    "workbench-git-dialog",
    "workbench-browser-dialog",
  ]) {
    assert.match(dialogRegistry, new RegExp(`"${id}"`), `${id} 未登记到 Bot 全局弹窗清理表`);
  }
  assert.match(dialogRegistry, /new Event\("cancel", \{ cancelable: true \}\)/);
  assert.match(dialogRegistry, /dialog\.dispatchEvent\(cancelEvent\)/);
  assert.match(dialogRegistry, /cancelEvent\.defaultPrevented && !automationWasClean/);
  assert.match(dialogRegistry, /dialog\.close\("cancel"\)/);
  assert.match(app, /if \(!closeBotGlobalDialogs\(\)\)[\s\S]{0,120}history\.replaceState\(null, "", "#bot"\)/);
  assert.match(app, /function guardDirtyBotWorkspaceRoute\(view, options\)/);
  assert.match(app, /botState\.workspaceTab !== "seats"[\s\S]{0,120}runtimeSeatManager\?\.isDirty\(\)/);
  assert.match(app, /requestedHash[\s\S]{0,180}updateHash: requestedHash \? false : true/);
  assert.match(app, /botRequestCloseWorkspace\(\{ restoreFocus: false \}\)[\s\S]{0,360}setView\(target\.view, target\.options\)/);
  assert.match(app, /view === "bot" && botWorkspaceRouteGuardActive[\s\S]{0,80}pendingBotWorkspaceRoute = null/);
  assert.match(app, /if \(guardDirtyBotWorkspaceRoute\(view, \{/);
});

test("Bot roster and composer bridge keep a single runtime source", async () => {
  const [html, app] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
  ]);
  for (const id of ["claude-fable", "codex-technical", "grok-search"]) {
    assert.match(app, new RegExp(`"${id}": \\{ label:`));
  }
  assert.match(app, /const catalog = botVisibleMemberCatalog\(\)/);
  assert.match(app, /botConversationRowMarkup\(conversation\)/);
  assert.match(html, /id="bot-composer-form"/);
  assert.match(html, /id="bot-message-stream"[^>]+role="log"/);
  assert.match(app, /function botBridgeComposer\(text, \{\s*requestedAgentIds = \[\],[\s\S]{0,180}teamId = "",[\s\S]{0,80}ephemeralTeam = null/);
  assert.match(app, /elements\["task-input"\]/);
  assert.match(app, /const form = elements\["task-form"\][\s\S]{0,4600}form\.requestSubmit\(\)/);
  assert.match(app, /function botPrepareIndependentComposer\(agentId, \{ teamId = "", allowedMemberIds = null \} = \{\}\)/);
  assert.match(app, /state\.composerTargetAgentId = normalized/);
  assert.match(app, /pendingSubmission/);
  assert.match(app, /pendingSubmissions/);
  assert.match(app, /pendingSubmissions\.length > 8/);
  assert.match(app, /botBindRun\(run/);
  assert.match(app, /setView\("bot", \{ focus: false \}\)/);
  assert.match(app, /runProjection\.resolveRun\(/);
  assert.doesNotMatch(app, /botState\.runSnapshots/);
  assert.doesNotMatch(app, /botState\.runSnapshotExpiry/);
  assert.doesNotMatch(app, /fetch\([^\n]*bot/);
});

test("Bot composer uses the compact capsule layout without changing send semantics", async () => {
  const [html, css, manifest] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
    readFile(`${appRoot}/public/lucide-icons.json`, "utf8"),
  ]);
  const composerStart = html.indexOf('<form class="bot-composer"');
  const composerEnd = html.indexOf("</form>", composerStart);
  assert.ok(composerStart > -1 && composerEnd > composerStart, "缺少 Bot 发送框");
  const composer = html.slice(composerStart, composerEnd);
  assert.match(composer, /class="bot-composer-row"/);
  assert.match(composer, /data-bot-action="attach"[\s\S]*#lucide-plus/);
  assert.match(composer, /id="bot-composer-input"/);
  assert.match(composer, /id="bot-composer-input"[^>]+role="combobox"[^>]+aria-controls="bot-mention-menu"/);
  assert.match(composer, /id="bot-mention-menu"[^>]+role="listbox"/);
  assert.match(composer, /id="bot-mention-recipients"/);
  assert.match(composer, /type="submit" data-mode="send"[\s\S]*#lucide-arrow-up/);
  assert.match(css, /\.bot-composer \{[\s\S]*border-radius: 24px/);
  assert.match(css, /\.bot-composer-row \{[\s\S]*align-items: center/);
  assert.match(css, /\.bot-attach-button,\r?\n\.bot-send-button \{[^}]*border-radius: 50%/);
  const icons = JSON.parse(manifest).icons;
  assert.ok(icons.includes("arrow-up"), "离线 Lucide 清单缺少发送图标 arrow-up");
});

test("Structured Bot cards are runtime-generated and the stream ships no demo content", async () => {
  const [html, app] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
  ]);
  // 卡片真源在 app.js 的动态 markup；静态 HTML 不再携带演示对话或死卡片。
  for (const kind of ["question", "approval", "settlement"]) {
    assert.match(app, new RegExp(`data-bot-card="${kind}" data-bot-card-source`));
  }
  assert.doesNotMatch(html, /demo-run-1|ask-demo-1/);
  assert.doesNotMatch(html, /data-bot-card=/);
  assert.match(html, /id="bot-message-stream"[^>]*><\/div>/);
  assert.match(app, /bot-message-empty/);
  // 审批门仍由动态审批卡 + 现有 resolve 契约承担（见专项测试）。
  assert.match(app, /setView\("security"/);
  assert.match(html, /not-provisioned/);
  assert.match(html, /id="bot-computer-view"[^>]+role="dialog"/);
  assert.match(html, /id="bot-computer-return"[^>]*>交还给成员</);
  assert.match(app, /function botSetComputerView\(/);
  assert.match(app, /computerReturnPanel/);
  assert.match(app, /botState\.panelOpener = byId\("bot-agent-info-button"\)/);
  assert.match(app, /bot-computer-view-close/);
  assert.match(app, /data-contextmenu|contextmenu/);
  assert.match(app, /api\/team-members.*DELETE|method: "DELETE"/);
});

test("Bot member info panel and five settings tabs expose complete ARIA relationships", async () => {
  const [html, app] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
  ]);
  assert.match(html, /id="bot-agent-panel"[^>]+role="dialog"[^>]+aria-modal="true"[^>]+aria-labelledby="bot-panel-agent-name"[^>]+aria-hidden="true"[^>]+inert/);
  assert.match(html, /aria-controls="bot-agent-panel"/);
  for (const tab of ["general", "plugins", "team", "appearance", "updates"]) {
    assert.match(html, new RegExp(`data-bot-settings-tab="${tab}"`));
    assert.match(html, new RegExp(`id="bot-settings-${tab}"[^>]+role="tabpanel"[^>]+aria-labelledby="bot-settings-tab-${tab}"`));
  }
  assert.match(app, /function botSetPanel\(open/);
  assert.match(app, /data-bot-panel-inert/);
  assert.match(app, /function botAgentPanelFocusables\(/);
  assert.match(app, /function botTrapAgentPanelFocus\(/);
  assert.match(app, /bot-agent-panel"\)\?\.hidden === false && botTrapAgentPanelFocus\(event\)/);
  assert.match(app, /function botSyncRosterRow\(agentId, meta\)/);
  assert.match(app, /botState\.panelOpener\?\.focus/);
  const leaveBotBlock = app.slice(
    app.indexOf('if (view !== "bot") {', app.indexOf("function setView")),
    app.indexOf('if (state.view === "workbench"', app.indexOf("function setView")),
  );
  assert.match(leaveBotBlock, /botCloseSettings\?\.\(\)/);
  assert.match(app, /function botActivateSettingsTab\(/);
  assert.match(app, /Cmd\+Shift\+I|event\.shiftKey && event\.key\.toLowerCase\(\) === "i"/);
  assert.match(app, /event\.key === ","/);
  assert.match(html, /id="bot-settings-panel"[^>]+role="dialog"[^>]+aria-modal="true"[^>]+inert/);
  assert.match(app, /botTrapSettingsFocus/);
});

test("Bot agent switching preserves the chat surface and continuation target", async () => {
  const app = await readFile(`${appRoot}/public/app.js`, "utf8");
  assert.match(app, /botOpenMemberConversation\(row\.dataset\.botAgent, row\)/);
  assert.match(app, /botEnsureDirectConversation\(id\)/);
  assert.match(app, /botOpenConversation\(conversation\.id\)/);
  assert.match(app, /conversationKind: botSubmission\?\.conversationKind/);
  assert.match(app, /const botAgentId = botSubmission\?\.agentId \|\| botPendingAgentForPrompt\(prompt\)/);
  assert.match(app, /botBindRun\(updated, \{ prompt, agentId: composerTarget\.memberId, submission: botSubmission \}\)/);
  assert.match(app, /selectionEpoch/);
  assert.match(app, /function botBeginSelectionIntent\(\)/);
  assert.match(app, /function botSelectionIntentCurrent\(selectionToken\)/);
  assert.match(app, /botOpenConversation\(conversation\.id, \{ selectionToken \}\)/);
  assert.match(app, /botSelectionIntentCurrent\(selectionToken\)[\s\S]{0,180}activeConversationId/);
});

test("Bot fail-closed actions are explicit and do not impersonate backend support", async () => {
  const [html, app] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
  ]);
  for (const action of ["computer-update", "computer-reset", "private-skill-add", "routine-toggle"]) {
    assert.match(html, new RegExp(`data-bot-action="${action}"`));
  }
  assert.match(app, /function botHandleAction\(action, button\)/);
  assert.match(app, /成员电脑 Reset 尚未接入真实快照后端/);
  assert.match(app, /Private skill 草稿已更新；写入真源尚未接入/);
});

test("Bot Appearance and Plugins are real structured controls", async () => {
  const [html, app, css] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
  ]);
  assert.match(html, /data-bot-theme="system"[^>]+aria-checked="true"/);
  assert.match(html, /data-bot-theme="light"/);
  assert.match(html, /data-bot-theme="dark"/);
  assert.match(html, /id="bot-plugin-search"/);
  assert.match(html, /data-bot-plugin-filter="skills"/);
  assert.match(html, /data-bot-plugin-filter="mcp"/);
  assert.match(html, /id="bot-plugin-capabilities"/);
  assert.match(app, /function botFilterPlugins\(/);
  for (const label of ["All", "Skills", "MCP", "Private skills", "Add skill"]) assert.match(html, new RegExp(label));
  assert.match(css, /\.bot-theme-options/);
  assert.match(css, /\.bot-plugin-grid/);
});

test("Bot settings keep account, plugin library, and member sub-settings inside the Bot surface", async () => {
  const [html, app, css] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
  ]);
  for (const marker of ["Your plugins", "Private skills", "bot-plugin-capabilities", "bot-private-skill-editor"]) {
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(html, /id="bot-agent-settings-panel"[^>]+role="dialog"[^>]+aria-modal="true"[^>]+inert/);
  for (const field of ["bot-member-label", "bot-member-short-label", "bot-member-role", "bot-member-description", "bot-member-runtime-profile", "bot-member-default-model", "bot-member-default-effort", "bot-member-system-prompt", "bot-member-main-brain", "bot-agent-settings-notifications"]) {
    assert.match(html, new RegExp(`id="${field}"`));
  }
  assert.match(html, /id="bot-member-short-label" maxlength="48"/);
  assert.match(html, /id="bot-member-seat-button"[^>]+>.*席位设置<\/span>/);
  assert.match(app, /function botOpenAgentSettings\(/);
  assert.match(app, /function botSaveAgentSettings\(/);
  assert.match(app, /bot-agent-settings-button.*botOpenAgentSettings/);
  assert.match(app, /bot-member-seat-button[\s\S]{0,600}botOpenSeatWorkspace/);
  assert.match(html, /id="bot-member-seat-edit-button"[^>]+data-bot-seat-action="edit"/);
  assert.match(html, /id="bot-member-seat-create-button"[^>]+data-bot-seat-action="create"/);
  assert.match(html, /id="bot-seat-bind-label">绑定到当前成员/);
  assert.match(css, /\.bot-agent-settings-panel/);
  assert.match(css, /\.bot-plugin-subsection/);
  assert.match(css, /\.bot-private-skill-row/);
});

test("Bot render ignores late runs from a non-active conversation for the same agent (P0-03)", async () => {
  const [app, header] = await Promise.all([
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/modules/conversation-header.js`, "utf8"),
  ]);
  assert.match(
    app,
    /function botRenderConversationMessages[\s\S]*?const activeConversation = botActiveConversation\(\)[\s\S]*?activeConversation && run && !botRunBelongsToConversation\(run, activeConversation\)[\s\S]*?return;[\s\S]*?botNoteAgentFirstResponse\(run\)/,
    "render must validate Conversation ownership before mutating the stream or first-response state",
  );
  assert.match(
    app,
    /async function botSyncConversation[\s\S]*?const historyKey = botConversationStoreKey\(id\)[\s\S]*?const conversationId = String\(botState\.activeConversationId \|\| ""\)[\s\S]*?await fetchRunEvents[\s\S]*?botConversationStoreKey\(id\) !== historyKey[\s\S]*?String\(botState\.activeConversationId \|\| ""\) !== conversationId[\s\S]*?return;/,
    "async history responses must retain both store-key and conversation ownership",
  );
  assert.match(
    app,
    /function scheduleBotConversationSync[\s\S]*?String\(activeRun\.id\) !== String\(runId\)[\s\S]*?const historyKey = botConversationStoreKey\(agentId\)[\s\S]*?botSyncConversation\(agentId, \{ historyKey, runId: String\(runId\) \}\)/,
    "SSE scheduling must be scoped to the visible run and conversation store",
  );
  assert.match(
    header,
    /function runLocalEnvironmentId\(run\)[\s\S]*?run\?\.id && \(run\.cwd \|\| \(run\.worktreePath && run\.worktreeBase\)\)[\s\S]*?function loadHeadingEnvironment\(run\)[\s\S]*?if \(run && !runLocalEnvironmentId\(run\)\) return;/,
    "direct-conversation runs without a local workspace must not probe the workbench environment endpoint",
  );
  assert.match(
    app,
    /missionControlDock\?\.selectRun\([\s\S]{0,240}runLocalEnvironmentId\(run\)/,
    "Mission Control must pass a separately attested local-environment run identity",
  );
  assert.match(
    app,
    /function botRunBelongsToConversation[\s\S]*?conversationOwnsRun\(run, conversation, botState\.conversations\)/,
    "every Bot projection must use the executable Conversation ownership contract",
  );
  assert.match(
    app,
    /function renderBotRunQueue[\s\S]*?const activeConversation = botActiveConversation\(\)[\s\S]*?const conversationRun = activeConversation \? botConversationRun\(activeConversation\) : null[\s\S]*?new Set\(\(activeConversation\.runIds \|\| \[\]\)\.map\(String\)\.filter\(Boolean\)\)[\s\S]*?const entries = runIds\.map[\s\S]*?selectedRunId/,
    "the visible run queue and current marker must derive from the active Conversation",
  );
  assert.match(
    app,
    /function botRenderAgent[\s\S]*?const visibleConversation = botActiveConversation\(\)[\s\S]*?const visibleRun = visibleConversation \? botConversationRun\(visibleConversation\) : null[\s\S]*?botState\.runId = groupRun\?\.id[\s\S]*?visibleRun\?\.id[\s\S]*?visibleConversation \? null/,
    "the global Bot run pointer must not fall back to another Conversation for the same member",
  );
  assert.match(
    app,
    /function botConversationRun[\s\S]*?botRunBelongsToConversation\(selected, conversation\)[\s\S]*?return botConversationActiveRun\(conversation\)/,
    "an activeRunId must not bypass Conversation ownership validation",
  );
  assert.match(
    app,
    /function botRunIdsForAgent[\s\S]*?new Set\(queue\.map\(String\)\.filter\(Boolean\)\)[\s\S]*?BOT_RUN_QUEUE_LIMIT/,
    "restored run queues must be deduplicated before rendering and selecting a current run",
  );
});

test("Bot agent settings resolve the edited member (not the current-session agent) as target (P0-04)", async () => {
  const app = await readFile(`${appRoot}/public/app.js`, "utf8");
  assert.match(
    app,
    /bot-member-runtime-profile[\s\S]*?addEventListener\("change"[\s\S]*?const targetId = botState\.editingMemberId \|\| botState\.agentId[\s\S]*?botCatalogMember\(targetId\)[\s\S]*?resetDefaults: true/,
    "runtime-profile change handler must resolve target via editingMemberId || agentId",
  );
  assert.match(
    app,
    /bot-member-main-brain[\s\S]*?addEventListener\("change"[\s\S]*?const targetId = botState\.editingMemberId \|\| botState\.agentId[\s\S]*?botCatalogMember\(targetId\)/,
    "main-brain change handler must resolve target via editingMemberId || agentId",
  );
  // 负向：agent-settings 的 change 处理器绝对不能用当前会话的 botState.agentId 当编辑目标。
  const settingsZone = app.slice(app.indexOf("bot-member-runtime-profile"), app.indexOf("bot-settings-tabs"));
  assert.doesNotMatch(
    settingsZone,
    /botCatalogMember\(botState\.agentId\)/,
    "agent-settings change handlers must not resolve to the current-session agent",
  );
});

test("Bot member settings persist the real member and runtime-seat contract without returning to Forge", async () => {
  const [html, app, css] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
  ]);
  const botStart = html.indexOf('<section class="view bot-shell');
  const botEnd = html.indexOf('<section class="view"', botStart + 1);
  const botSurface = html.slice(botStart, botEnd > botStart ? botEnd : html.length);
  for (const visibleLegacyLabel of ["代理通讯录", "搜索代理", "代理列表", "代理信息", "代理设置", "当前代理", "给当前代理", "代理电脑", "返回代理", "交还给代理", "Team Setup", ">Members<"]) {
    assert.doesNotMatch(botSurface, new RegExp(visibleLegacyLabel));
  }
  assert.match(botSurface, /成员通讯录/);
  assert.match(botSurface, /id="bot-settings-member-list"/);
  assert.match(app, /function botRenderSettingsMembers\(/);
  assert.match(app, /profile\.teamMemberEligible === true/);
  assert.match(app, /function botSeatBindingProfile\(/);
  assert.match(app, /state\.runtimeSeatsData\?\.runtimeProfiles/);
  assert.match(app, /normalizeMemberModelOptions\(profile\.modelOptions/);
  assert.match(app, /memberRuntimeFactValues\(member \|\| \{\}, profile\)/);
  assert.match(app, /request\(creating \? API\.teamMembers : `\$\{API\.teamMembers\}\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(app, /method: creating \? "POST" : "PUT"/);
  assert.match(app, /state\.memberCatalog = Array\.isArray\(payload\?\.members\)/);
  assert.match(app, /state\.runtimeCatalog = Array\.isArray\(payload\?\.runtimeProfiles\)/);
  assert.match(app, /case "member-edit"[\s\S]{0,320}botOpenSeatWorkspace\(\{ memberId, opener: button \}\)/);
  assert.match(app, /data-bot-action="member-edit"[\s\S]{0,300}<span>设置席位<\/span>/);
  const openStart = app.indexOf("function botOpenAgentSettings(");
  const saveEnd = app.indexOf("function botSetComputerView(", openStart);
  const memberSettingsCode = app.slice(openStart, saveEnd);
  assert.doesNotMatch(memberSettingsCode, /setView\("(?:team|config)"/);
  assert.doesNotMatch(memberSettingsCode, /override\.(?:name|title|description|avatar)/);
  assert.match(css, /\.bot-member-runtime-facts/);
  assert.match(css, /\.bot-settings-member-row/);
  assert.match(css, /\.bot-member-seat-entry/);
  assert.match(css, /#bot-seat-bind-label/);
  assert.match(app, /function botOpenSeatWorkspace\(/);
  assert.match(app, /function botBindSelectedSeat\(/);
  assert.match(app, /function botRequestCloseWorkspace\(/);
  assert.match(app, /function botOpenMemberFromSeatWorkspace\(/);
  assert.match(app, /botWorkspaceMoveNode\("config-surface-sources", "bot-seats-mount"\)/);
  assert.match(app, /botState\.workspaceTab === "seats"[\s\S]{0,180}botOpenMemberFromSeatWorkspace/);
});

test("Bot communication surface exposes accessible chats, contacts, CRUD, and official member avatars", async () => {
  const [html, app, css, avatars] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
    readFile(`${appRoot}/public/modules/avatars.js`, "utf8"),
  ]);
  for (const tab of ["chats", "contacts"]) {
    assert.match(html, new RegExp(`data-bot-surface-tab="${tab}"`));
    assert.match(html, new RegExp(`id="bot-surface-${tab}"[^>]+role="tabpanel"[^>]+aria-labelledby="bot-surface-tab-${tab}"`));
  }
  assert.match(app, /function botActivateSurfaceTab\(/);
  assert.match(app, /ArrowLeft[\s\S]{0,220}ArrowRight[\s\S]{0,220}Home[\s\S]{0,220}End/);
  assert.match(html, /id="bot-new-member-button"[^>]+aria-label="添加成员"/);
  assert.match(html, /id="bot-member-avatar-file"[^>]+accept="image\/png,image\/jpeg,image\/gif,image\/webp"/);
  assert.match(app, /method: creating \? "POST" : "PUT"/);
  assert.match(app, /API\.memberAvatar\(savedId\)/);
  assert.match(app, /function botRemoveAgent\(/);
  assert.match(app, /async function botSetMemberVisibility\(/);
  assert.match(app, /hiddenMemberIds: \[\.\.\.hidden\]/);
  assert.match(app, /member\.builtin === true \? "移出通讯录" : "删除"/);
  assert.match(app, /data-bot-action="member-restore"/);
  assert.match(avatars, /return officialCliIconMarkup\(brand, iconClass\) \|\| fallback/);
  assert.match(avatars, /cli-brand-\$\{brand\}/);
  assert.match(app, /const brand = brandForMember\(/);
  assert.match(app, /memberAvatarMarkup\(member \|\| \{\}/);
  assert.match(css, /\.bot-contact-row/);
  assert.match(css, /\.bot-avatar-icon/);
  assert.match(css, /\.bot-agent-avatar\.is-claude[\s\S]{0,180}var\(--bot-claude-soft\)/);
  assert.match(css, /\.bot-avatar-icon \{ padding: 6px; fill: currentColor; stroke: none; \}/);
  assert.match(css, /\.bot-settings-member-row\.is-hidden/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.bot-contact-row \{ min-width: 218px; \}[\s\S]*\.bot-contact-actions \{ display: flex; padding-right: 3px; opacity: 1; \}/);
});

test("Bot group chats reuse social runs and continue through the existing run messages contract", async () => {
  const [html, app, server, teams, orchestrator] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/server.mjs`, "utf8"),
    readFile(`${appRoot}/src/teams.mjs`, "utf8"),
    readFile(`${appRoot}/src/orchestrator.mjs`, "utf8"),
  ]);
  assert.match(html, /id="bot-group-dialog"[^>]+role="dialog"[^>]+aria-modal="true"[^>]+inert/);
  assert.match(html, /id="bot-group-member-list"/);
  assert.match(app, /function botGroupRuns\(/);
  assert.match(app, /run\.orchestrationMode === "social"/);
  const groupCandidates = app.match(/function botGroupCandidateMembers\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(groupCandidates, /botVisibleMemberCatalog/);
  assert.doesNotMatch(groupCandidates, /selectedTeamId|defaultTeamId/);
  const groupSubmit = app.match(/async function botSubmitGroup\(event\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(groupSubmit, /request\(API\.teams/);
  assert.match(groupSubmit, /botEphemeralTeamForMembers\(selected, title\)/);
  assert.match(groupSubmit, /request\(API\.projects, \{ method: "POST", body: \{ title, cwd \} \}\)/);
  assert.match(groupSubmit, /projectId: project\.projectId/);
  assert.match(groupSubmit, /roomRole/);
  assert.doesNotMatch(groupSubmit, /cwd: conversation\.cwd/);
  assert.match(app, /botSubmissionCandidate\?\.teamId \|\| botSubmissionCandidate\?\.ephemeralTeam/);
  assert.match(app, /ephemeralTeam: botSubmission\?\.ephemeralTeam \|\| undefined/);
  assert.match(teams, /materializeEphemeral\(input = \{\}\)/);
  assert.match(orchestrator, /this\.teams\.materializeEphemeral\(input\.ephemeralTeam\)/);
  assert.match(orchestrator, /teamEphemeral: team\?\.ephemeral === true/);
  assert.doesNotMatch(app, /function botSubmitConversationMessage\(/);
  assert.match(app, /const conversationEndpoint = botSubmission\?\.conversationId[\s\S]*?\/api\/conversations\/\$\{encodeURIComponent\(botSubmission\.conversationId\)\}\/messages/);
  assert.match(app, /request\(conversationEndpoint \|\| API\.runs/);
  assert.match(app, /conversationEndpoint \? \{[\s\S]{0,160}messageIntent: "steer"/);
  assert.match(app, /request\(`\$\{API\.runs\}\/\$\{encodeURIComponent\(run\.id\)\}\/meta`/);
  assert.match(server, /pathname\.match\(\/\^\\\/api\\\/runs\\\/\(\[\^\/\]\+\)\\\/meta\$\//);
});

test("Bot project tree keeps global direct chats separate and mobile switches between list and conversation", async () => {
  const [html, app, css] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
  ]);
  assert.match(html, /id="bot-project-tree"[^>]+role="tree"[^>]+aria-label="项目与对话"/);
  assert.doesNotMatch(html, /id="bot-project-tree"[\s\S]{0,1600}role="option"/);
  assert.doesNotMatch(html, /id="bot-project-tree"[^>]*>[\s\S]{0,500}data-bot-agent=/, "the static shell must not duplicate server-backed Conversation rows");
  assert.match(app, /function botConversationRowMarkup[\s\S]{0,3000}role="treeitem" aria-level="\$\{level\}"/);
  assert.match(html, /name="bot-conversation-mode" value="project" checked/);
  assert.match(html, /name="bot-conversation-mode" value="task"/);
  assert.match(html, /id="bot-group-project-field" hidden/);
  assert.match(html, /选择成员（可选）/);
  assert.match(html, /启动消息（可选）/);
  assert.doesNotMatch(html, /id="bot-group-message"[^>]+required/);
  assert.doesNotMatch(html, /至少选择 2 位，最多 5 位/);
  assert.match(app, /request\(`\$\{API\.projects\}\?includeArchived=1`\)/);
  assert.match(app, /item\.kind === "direct" && botConversationMatches\(item, query\)/);
  assert.match(app, /item\.projectId === project\.projectId/);
  assert.match(app, /defaultRoom \? botConversationRowMarkup\(defaultRoom, \{ label: "项目协作室", level: 2 \}\)/);
  assert.match(app, /function botSetProjectCollapsed\(/);
  assert.match(app, /BOT_PROJECT_TREE_STORAGE_KEY/);
  assert.match(app, /\["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"/);
  assert.match(app, /conversationRef/);
  assert.match(app, /botConversationRef\(conversationOrId\)/);
  assert.match(app, /项目会话 \$\{composerLabel\}/);
  assert.match(app, /项目将进入只读封存/);
  assert.match(app, /function botRestoreProject\(/);
  const groupSubmit = app.match(/async function botSubmitGroup\(event\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(groupSubmit, /const startsRun = Boolean\(message\)/);
  assert.doesNotMatch(groupSubmit, /selected\.length < 2/);
  assert.doesNotMatch(app, /群聊最多选择 \$\{MAX_REQUESTED_AGENTS \+ 1\} 位成员/);
  assert.match(groupSubmit, /selected\.slice\(0, MAX_REQUESTED_AGENTS \+ 1\)/);
  assert.match(app, /if \(startsRun\) botRenderAgent\(primary\);\s*else botOpenConversation/);
  assert.match(app, /\.slice\(0, MAX_REQUESTED_AGENTS\)/);
  assert.match(css, /\.bot-project-rooms::before/);
  assert.match(css, /\.bot-conversation-status\.is-attention/);
  assert.match(css, /\.bot-directory-field \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.bot-agent-list \{ display: flex; flex-direction: column;[\s\S]*overflow-y: auto; \}/);
  assert.doesNotMatch(css, /\.bot-roster \{[^}]*height: 150px/);
  assert.match(html, /id="bot-mobile-back"[^>]+aria-label="返回会话列表"/);
  assert.match(app, /classList\.toggle\("is-mobile-conversation", Boolean\(visibleConversation\) && !botState\.mobileRosterVisible\)/);
  assert.match(css, /\.bot-shell-grid\.is-mobile-conversation \.bot-roster \{ display: none; \}/);
  assert.match(css, /\.bot-shell-grid\.is-mobile-conversation \.bot-conversation \{ display: flex; \}/);
});

test("Bot keeps Conversation chat stable while collaboration context moves to a non-reflowing inspector", async () => {
  const [html, app, css] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
  ]);
  const conversationStart = html.indexOf('<section class="bot-conversation"');
  const conversationEnd = html.indexOf('</section>', conversationStart);
  const inspectorStart = html.indexOf('<aside class="bot-agent-panel"');
  assert.ok(conversationStart >= 0 && conversationEnd > conversationStart && inspectorStart > conversationEnd);
  assert.doesNotMatch(html.slice(conversationStart, conversationEnd), /bot-collab-tabs|bot-run-queue|bot-collab-panel/);
  assert.match(html.slice(inspectorStart), /id="bot-collab-tabs"[\s\S]*id="bot-collab-panel"[\s\S]*id="bot-run-queue"/);
  const collaborationStart = app.indexOf("function botRenderCollaborationWorkspace()");
  const collaborationEnd = app.indexOf("function botActivateCollaborationTab", collaborationStart);
  const collaborationCode = app.slice(collaborationStart, collaborationEnd);
  assert.doesNotMatch(collaborationCode, /stream\.hidden|composer\.hidden/);
  assert.match(collaborationCode, /panel\.hidden = false/);
  assert.match(collaborationCode, /当前没有执行中的 Run/);
  assert.match(css, /\.bot-shell-grid \{[\s\S]{0,220}grid-template-columns: 260px minmax\(0, 1fr\);/);
  assert.doesNotMatch(css, /\.bot-shell\.is-panel-open \.bot-shell-grid/);
  assert.match(css, /\.bot-agent-panel \{ position: absolute;[\s\S]{0,220}right: 0;[\s\S]{0,220}width: min\(340px/);
});

test("Bot terminal runs are recent history, and the computer view is a real focus-contained modal", async () => {
  const [html, app, css] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
  ]);
  assert.match(app, /const relationLabel = runId === activeRunId \? \(presentation\.active \? "当前执行" : "最近运行"\) : ""/);
  assert.match(html, /id="bot-computer-view"[^>]+aria-hidden="true"[^>]+inert hidden/);
  assert.match(app, /function botComputerFocusables\(/);
  assert.match(app, /function botTrapComputerFocus\(event\)/);
  assert.match(app, /baseSurfaces\.forEach[\s\S]{0,180}setAttribute\("inert"/);
  assert.match(app, /view\.setAttribute\("aria-hidden", "false"\)/);
  assert.match(app, /botTrapComputerFocus\(event\)/);
  assert.match(css, /\.bot-roster-empty:not\(\[hidden\]\)/);
  assert.match(css, /\.bot-shell \*,[\s\S]{0,180}transition-duration: \.001ms !important/);
});

test("Bot personal settings persist nickname and reuse the audited operator avatar API", async () => {
  const [html, app, server] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/server.mjs`, "utf8"),
  ]);
  assert.match(html, /id="bot-profile-form"/);
  assert.match(html, /id="bot-profile-label"[^>]+maxlength="48"/);
  assert.match(html, /id="bot-profile-avatar-file"[^>]+accept="image\/png,image\/jpeg,image\/gif,image\/webp"/);
  assert.match(app, /request\(API\.operatorProfile, \{ method: "PUT", body: \{ label \} \}\)/);
  assert.match(app, /uploadOperatorAvatar\(file\)/);
  assert.match(app, /resetOperatorAvatar\(\)/);
  assert.match(server, /request\.method === "PUT" && pathname === "\/api\/operator-profile"/);
  assert.match(server, /state\.avatars\.setOperatorProfile/);
});

test("Bot workspaces keep channels and automations on the Bot surface", async () => {
  const [html, app, channelPanel, automations] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/channels-panel.js`, "utf8"),
    readFile(`${appRoot}/public/modules/automations-page.js`, "utf8"),
  ]);
  assert.match(html, /id="bot-workspace-panel"[^>]+role="dialog"[^>]+inert/);
  assert.match(html, /data-bot-workspace-tab="automations"/);
  assert.match(html, /data-bot-workspace-tab="channels"/);
  assert.match(html, /data-bot-workspace-tab="seats"/);
  assert.match(html, /id="bot-seats-mount"/);
  assert.match(app, /function botOpenWorkspace\(tab = "automations"/);
  assert.match(app, /botWorkspaceMoveNode\("automations-workbench", "bot-automations-mount"\)/);
  assert.match(app, /botWorkspaceMoveNode\("channels-container", "bot-channels-mount"\)/);
  assert.match(app, /const paneInBotWorkspace = pane\?\.closest\("#bot-workspace-panel"\)/);
  assert.match(app, /if \(pane && !paneInBotWorkspace\)/);
  assert.match(app, /case "routines"[\s\S]{0,120}botOpenWorkspace\("automations"/);
  assert.match(app, /case "channels"[\s\S]{0,120}botOpenWorkspace\("channels"/);
  assert.doesNotMatch(app, /case "routines"[\s\S]{0,180}setView\("automations"/);
  assert.doesNotMatch(app, /case "channels"[\s\S]{0,180}setView\("channels"/);
  assert.match(channelPanel, /export function refreshChannelsPanel\(rootOverride = null\)/);
  assert.match(automations, /parts\[0\] === "bot" && parts\[1\] === "automations"/);
  assert.match(automations, /routePrefix = ""/);
});

test("Bot parallel runs use a bounded queue and the existing event-history source", async () => {
  const [html, app, css] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
  ]);
  assert.match(app, /const BOT_RUN_QUEUE_LIMIT = 6/);
  assert.match(app, /const BOT_PENDING_TIMEOUT_MS = 15_000/);
  assert.match(app, /function botScheduleSubmissionTimeout\(submission\)/);
  assert.match(app, /function fetchRunEvents\(runId\)/);
  assert.match(app, /function historyMessagesForRun\(run, agentId, events\)/);
  assert.match(app, /function scheduleBotConversationSync\(runId\)/);
  assert.match(app, /conversationAdmissionToken/);
  assert.match(app, /const botUsesConversationAdmission = Boolean\([\s\S]{0,120}botSubmissionCandidate/);
  assert.match(app, /botState\.runQueues\[id\] = queue\.slice\(0, BOT_RUN_QUEUE_LIMIT\)/);
  assert.match(app, /function botBridgeComposer\(text, \{\s*requestedAgentIds = \[\],[\s\S]{0,180}teamId = "",[\s\S]{0,80}ephemeralTeam = null/);
  assert.match(app, /requestedAgentIds: collaborators/);
  assert.match(app, /orchestrationMode: orchestrationMode === "social" \? "social" : "pipeline"/);
  assert.match(app, /agentIds: submission\.requestedAgentIds/);
  assert.match(app, /botRememberRun\(run, participant, \{ primary: false \}\)/);
  assert.match(html, /id="bot-run-queue"[^>]+aria-live="polite"/);
  assert.match(app, /data-bot-run-id/);
  assert.match(css, /\.bot-run-queue/);
});

test("Bot run ownership survives a page refresh without creating a second runtime", async () => {
  const app = await readFile(`${appRoot}/public/app.js`, "utf8");
  assert.match(app, /const BOT_RUN_INDEX_STORAGE_KEY = "514cc-bot-run-index-v1"/);
  assert.match(app, /function botPersistRunIndex\(\)/);
  assert.match(app, /function botRestoreRunIndex\(\)/);
  assert.match(app, /localStorage\.setItem\(BOT_RUN_INDEX_STORAGE_KEY/);
  assert.match(app, /botRestoreRunIndex\(\);/);
  assert.match(app, /botPersistRunIndex\(\);/);
  assert.match(app, /function botHydrateRunQueuesFromRuns\(\)/);
  assert.match(app, /run\?\.startAgentId/);
  assert.match(app, /botHydrateRunQueuesFromRuns\(\);/);
  assert.match(app, /botReconcileRunQueues\(\);/);
  assert.match(app, /fetchRunEvents\(run\.id\)/);
});

test("Late Bot POST responses cannot resurrect timed-out submissions", async () => {
  const app = await readFile(`${appRoot}/public/app.js`, "utf8");
  assert.match(app, /pending\.state === "failed"/);
  assert.match(app, /!botState\.pendingSubmissions\.includes\(pending\)/);
  assert.match(app, /pending\.state = "failed"/);
  assert.match(app, /pending\.failedAt = Date\.now\(\)/);
  assert.match(app, /const botBound = botSubmission/);
  assert.match(app, /run\.botBinding = "late-detached"/);
});

test("Bot project tree projects one highest-priority status per conversation", async () => {
  const [html, app, css] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
  ]);
  assert.match(app, /function botConversationStatus\(conversation, \{ hidden = false, archived = false, deleted = false \} = \{\}\)/);
  assert.match(app, /if \(hidden\) return \{ label: "已隐藏"/);
  assert.match(app, /botConversationRef\(conversation\)/);
  assert.match(app, /botConversationActivity\(conversation\)/);
  assert.match(app, /data-bot-conversation-ref/);
  assert.match(app, /botConversationRef\(conversation\)[\s\S]*conversation\.title/);
  assert.match(app, /const attention = botConversationAttention\(conversation\)/);
  assert.match(app, /data-bot-conversation-status/);
  assert.match(app, /botSyncRosterRow\(participant, botMeta\(participant\)\)/);
  assert.match(css, /\.bot-conversation-status/);
  assert.doesNotMatch(app, /data-bot-agent-load/);
  assert.doesNotMatch(css, /\.bot-agent-load/);
  assert.match(html, /id="bot-agent-list"/);
});

test("Bot messages keep coherent Markdown, visible identities, compact activity and send-stop controls", async () => {
  const [html, app, css] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
  ]);
  assert.doesNotMatch(app, /function botSplitBubbleText\(/);
  assert.match(app, /renderMarkdown\(text, redact\)/);
  assert.match(app, /function botConversationMessagesMarkup\(messages\)/);
  assert.match(app, /function botActivityGroupMarkup\(messages, timelineMarkup = ""\)/);
  assert.match(app, /function botActivitySegmentMarkup\(messages\)/);
  assert.match(app, /let activityStarted = false/);
  assert.match(app, /timeline\.push\(botActivitySegmentMarkup\(segment\)\)/);
  assert.match(app, /botActivityGroupMarkup\(activity, timeline\.join\(""\)\)/);
  assert.match(app, /function botActivityPhases\(messages\)/);
  assert.match(app, /<strong>协作过程<\/strong>/);
  assert.match(app, /processCardMarkup\(message, key\)/);
  assert.match(app, /operatorAvatarMarkup\(\{/);
  assert.match(css, /\.bot-activity-group/);
  assert.match(css, /\.bot-activity-timeline/);
  assert.match(css, /\.bot-activity-segment/);
  assert.match(css, /\.bot-activity-phase/);
  assert.match(css, /\.bot-message-user \.bot-message-author/);
  assert.match(html, /class="bot-send-button" type="submit" data-mode="send"/);
  assert.match(html, /#lucide-arrow-up/);
  assert.doesNotMatch(html, /class="bot-send-button"[^>]*[\s\S]{0,180}#lucide-mic/);
  assert.match(app, /function syncBotComposerMode\(\)/);
  assert.match(app, /function botInterruptCurrentRun\(\)/);
  assert.match(app, /body: \{ source: "bot-composer-stop" \}/);
  assert.match(css, /\.bot-send-button\.is-stop/);
  // 打字指示只在 queued/running 且最后一条是用户消息时出现；等待类状态不冒充输入中。
  assert.match(app, /data-bot-typing="1"/);
  assert.match(app, /botRunPresentation\(run\)\?\.className === "is-running"/);
  assert.match(css, /\.bot-typing i/);
  assert.match(css, /prefers-reduced-motion/);
  // 深色主题的 accent 不再配白字：主按钮/用户气泡都有成对 ink 变量。
  assert.match(css, /--bot-accent-ink: #ffffff/);
  assert.match(css, /--bot-accent-ink: #171411/);
  assert.match(css, /--bot-user-bubble-bg: var\(--forge-ink, #211d18\)/);
  assert.doesNotMatch(css, /background: var\(--bot-accent\); color: #fff/);
});

test("Bot mentions keep structured member identity and Conversation-scoped routing", async () => {
  const [html, app, css] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
  ]);
  assert.match(html, /id="bot-mention-menu"[^>]+role="listbox"/);
  assert.match(html, /id="bot-mention-recipients"[^>]+aria-live="polite"/);
  assert.match(app, /function botMentionScope\(conversation = botActiveConversation\(\)\)/);
  assert.match(app, /function botMentionSelectedIds\(conversation = botActiveConversation\(\)\)/);
  assert.match(app, /function botMentionShortId\(memberId\)/);
  assert.match(app, /id\.length > 8 \? id\.slice\(-8\) : id/);
  assert.match(app, /function botMentionTokenLabel\(memberId, conversation = botActiveConversation\(\)\)/);
  assert.match(app, /duplicates > 1 \? `\$\{label\}#\$\{botMentionShortId\(id\)\}` : label/);
  assert.match(app, /data-bot-mention-id/);
  assert.match(app, /data-bot-mention-remove/);
  assert.match(app, /recipientMemberIds: botSubmission\?\.recipientMemberIds/);
  assert.match(app, /recipientMemberIds: botMentionSelectedIds\(conversation\)/);
  assert.match(app, /botState\.mentionSelections\[botMentionContextKey\(\)\] = \[id\]/);
  assert.match(app, /removeRequestedAgentMention\(nextValue, botMentionTokenLabel\(previousId\)\)/);
  assert.match(app, /event\.key === "Escape"[\s\S]{0,180}botHideMentionMenu\(\)/);
  assert.match(css, /\.bot-mention-menu/);
  assert.match(css, /\.bot-mention-recipient/);
});

test("Bot other section clears only deleted tombstones through store CAS", async () => {
  const [api, app, css] = await Promise.all([
    readFile(`${appRoot}/public/api.js`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
  ]);
  assert.match(api, /purgeDeletedConversations: "\/api\/conversations\/deleted"/);
  assert.match(app, /function botPurgeDeletedConversations\(\)/);
  assert.match(app, /expectedStoreRevision: botState\.conversationsRevision/);
  assert.match(app, /data-bot-action="clear-deleted"/);
  assert.match(app, /仅清除 Conversation 删除墓碑/);
  assert.match(app, /隐藏会话和归档项目不受影响/);
  assert.match(app, /仍关联运行记录而保留/);
  assert.match(css, /\.bot-tree-clear-button/);
});

test("Bot collaboration inspector renders persisted delegation edges instead of inferring them", async () => {
  const [app, orchestrator] = await Promise.all([
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/src/orchestrator.mjs`, "utf8"),
  ]);
  assert.match(app, /function botCollaborationDelegationMarkup\(edge\)/);
  assert.match(app, /data-bot-delegation-id/);
  assert.match(app, /delegations\.map\(botCollaborationDelegationMarkup\)/);
  assert.match(orchestrator, /"pipeline-dispatch"/);
  assert.match(orchestrator, /"pipeline-review"/);
  assert.match(orchestrator, /"pipeline-synthesis"/);
  assert.match(orchestrator, /sourceBusMessageId: specialistMessageId/);
});

test("Bot pending asks render a live card with stable run and ask identity", async () => {
  const [app, css] = await Promise.all([
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
  ]);
  assert.match(app, /function botPendingAskCardMarkup\(run, pendingAsk = run\?\.pendingAsk\)/);
  assert.match(app, /data-bot-card="question" data-bot-card-source="run"/);
  assert.match(app, /data-run-id="\$\{escapeHtml\(runId\)\}" data-ask-id="\$\{escapeHtml\(askId\)\}"/);
  assert.match(app, /raw\.slice\(0, 6\)/);
  assert.match(app, /data-bot-answer-option/);
  assert.match(app, /data-bot-answer-focus/);
  assert.match(app, /TERMINAL_RUN_STATES\.has\(run\.status\)/);
  assert.match(app, /botMessageMatchesPendingAsk\(message, run\)/);
  assert.match(app, /botSyncPendingAskCard\(botRunForAgent\(next\), next\)/);
  assert.match(css, /\.bot-question-card\.is-dynamic/);
  assert.match(css, /\.bot-question-answer/);
});

test("Bot pending ask answers reuse the owned continuation contract instead of creating a run", async () => {
  const app = await readFile(`${appRoot}/public/app.js`, "utf8");
  assert.match(app, /function botPendingAskContext\(cardOrTarget\)/);
  assert.match(app, /function botSubmitPendingAskAnswer\(context, answer, \{/);
  assert.match(app, /answerToAskId: current\.askId/);
  assert.match(app, /answerRunId: current\.runId/);
  assert.match(app, /transitionComposerContext\(\(\) => \{/);
  assert.match(app, /const answerTarget = botState\.answerTarget && String\(botState\.answerTarget\.runId\) === String\(run\.id\)/);
  assert.match(app, /if \(answerTarget && String\(run\.pendingAsk\?\.id \|\| \"\"\) !== String\(answerTarget\.askId\)\)/);
  assert.match(app, /messageIntent: "answer"/);
  assert.match(app, /answerToAskId/);
  assert.match(app, /data-bot-answer-confirm/);
  assert.match(app, /data-bot-answer-focus/);
  assert.match(app, /botSubmitPendingAskAnswer\(context, choice\)/);
  assert.match(app, /if \(botSubmitPendingAskAnswer\(answerContext, prompt, options\)\) botClearVisibleComposer\(\)/);
  assert.match(app, /botState\.answerTarget = null/);
  assert.match(app, /botPrepareAnswerTarget\(botPendingAskContext\(card\), \{ switchAgent: false \}\)/);
  assert.match(app, /botPrepareAnswerTarget\(current, \{ switchAgent: false \}\)/);
});

test("Bot conversations expose the complete context menu and contacts resolve to direct conversations", async () => {
  const [app, css] = await Promise.all([
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
  ]);
  for (const label of ["加入项目 ›", "重命名会话", "创建副本", "复制对话 ID", "复制会话链接"]) {
    assert.match(app, new RegExp(`label: \\"${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\"`));
  }
  assert.match(app, /label: conversation\.pinned \? "取消置顶" : "置顶"/);
  assert.match(app, /label: conversation\.unread \? "标为已读" : "标为未读"/);
  assert.match(app, /isDefaultRoom \? "默认协作室不可单独隐藏" : "从侧边栏隐藏"/);
  assert.match(app, /isDefaultRoom \? "默认协作室不可单独删除" : "删除"/);
  assert.match(app, /function botProjectContextItems\(project, opener\)/);
  assert.match(app, /label: "新建项目任务"/);
  assert.match(app, /label: "归档项目"/);
  assert.match(app, /全局单聊会保留；项目协作室只增加该成员/);
  assert.match(app, /function botConversationContextItems\(conversation, opener\)/);
  assert.match(app, /function botRestoreConversation\(conversation, \{ open = true, selectionToken = open \? botBeginSelectionIntent\(\) : null \} = \{\}\)/);
  assert.match(app, /conversation\.hiddenAt[\s\S]{0,220}label: "恢复对话"[\s\S]{0,160}botRestoreConversation\(conversation\)/);
  assert.match(app, /conversation\?\.hiddenAt\) await botRestoreConversation\(conversation\)/);
  assert.match(app, /botPatchConversation\(conversation, \{ hidden: false \}, "对话已恢复"\)/);
  assert.match(app, /bot-contact-list.*addEventListener\("contextmenu"/s);
  assert.match(app, /await botOpenMemberConversation\(memberId, opener\)/);
  assert.match(app, /botConversationsForMember\(memberId, \{ includeHidden: true \}\)/);
  assert.match(app, /showContextMenu\(botConversationContextItems\(conversation, opener\)/);
  assert.match(app, /data-bot-conversation/);
  assert.match(app, /data-bot-group-run/);
  assert.match(css, /\.bot-conversation-section/);
});

test("Bot conversation bootstrap waits for the access token before querying the index", async () => {
  const app = await readFile(`${appRoot}/public/app.js`, "utf8");
  const shellStart = app.indexOf("function initBotShell()");
  const shellEnd = app.indexOf("function bindEvents", shellStart + 1);
  assert.ok(shellStart >= 0 && shellEnd > shellStart);
  assert.doesNotMatch(app.slice(shellStart, shellEnd), /botLoadConversations\(\)/);
  const tokenReady = app.indexOf("await initializeAccessToken();");
  const conversationLoad = app.indexOf("await botLoadConversations();", tokenReady);
  assert.ok(tokenReady >= 0 && conversationLoad > tokenReady, "对话索引不能早于认证态加载");
  assert.match(app, /const initialConversationRoute = Boolean\(state\.deepLinkConversationId\)/);
  assert.match(app, /const initialView = initialConversationRoute[\s\S]{0,160}\? "bot"[\s\S]{0,180}setView\(initialView/);
});

test("Bot conversation navigation exposes stable IDs, deep links, and server-backed historical runs", async () => {
  const [app, api, server] = await Promise.all([
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/api.js`, "utf8"),
    readFile(`${appRoot}/server.mjs`, "utf8"),
  ]);
  assert.match(app, /const conversationId = fragment\.get\("conversation"\)\?\.trim\(\) \|\| null/);
  assert.match(app, /conversationDeepLink\?\.conversationId/);
  assert.match(app, /function botConversationRef\(conversationOrId\)/);
  assert.match(app, /id\.slice\(0, 8\)/);
  assert.match(app, /function botOpenMemberConversation\(memberId, opener = null\)/);
  assert.match(app, /botConversationsForMember\(id, \{ includeHidden: true \}\)/);
  assert.match(app, /复制会话链接/);
  assert.match(app, /request\(API\.run\(id\)\)/);
  assert.match(app, /仅保留 Conversation 审计引用/);
  assert.match(app, /async function queueBotImages\(files\)[\s\S]{0,180}botConversationReadOnlyReason\(\)/);
  assert.match(app, /if \(conversation\?\.deletedAt\) \{[\s\S]{0,260}复制会话链接/);
  assert.match(api, /run: \(id\) => `\/api\/runs\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(server, /request\.method === "GET" && runMatch/);
});

test("Bot direct and workspace group submissions preserve distinct topology and ownership", async () => {
  const app = await readFile(`${appRoot}/public/app.js`, "utf8");
  assert.match(app, /conversationKind: conversation\?\.kind \|\| \(orchestrationMode === "social" \? "workspace_group" : "direct"\)/);
  assert.doesNotMatch(app, /function botSubmitConversationMessage\(/);
  assert.match(app, /const conversationEndpoint = botSubmission\?\.conversationId[\s\S]*?\/api\/conversations\/\$\{encodeURIComponent\(botSubmission\.conversationId\)\}\/messages/);
  assert.match(app, /conversationEndpoint \? \{[\s\S]{0,160}messageIntent: "steer"/);
  assert.match(app, /const prompt = visibleText \|\| "请查看并处理这条消息附带的图片。"/);
  assert.match(app, /cwd: conversation\?\.id \? null : \(String\(cwd \|\| ""\)\.trim\(\) \|\| null\)/);
  assert.match(app, /cwd: botSubmission\?\.conversationId \? undefined : \(botSubmission\?\.cwd \|\| submission\.cwd\)/);
});

test("Bot answer lock fails closed when continuation loses its early context", async () => {
  const app = await readFile(`${appRoot}/public/app.js`, "utf8");
  assert.match(app, /const taskInput = elements\["task-input"\]/);
  assert.match(app, /const answerSubmission = botState\.answerTarget\?\.runId \|\| botState\.pendingSubmission\?\.answerToAskId/);
  assert.match(app, /botState\.answerInFlight = false/);
  assert.match(app, /回答上下文尚未就绪/);
});

test("Bot approval cards project the real pending approval and reuse the audited resolve contract", async () => {
  const [app, css] = await Promise.all([
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
  ]);
  assert.match(app, /function botApprovalCardMarkup\(item\)/);
  assert.match(app, /data-bot-card="approval" data-bot-card-source="approval"/);
  assert.match(app, /data-inline-approval-id/);
  assert.match(app, /approvalParamsMarkup\(item\)/);
  assert.match(app, /actionSha256/);
  assert.match(app, /item\/permissions\/requestApproval/);
  assert.match(app, /function botApprovalCardsMarkup\(run\)/);
  assert.match(app, /const approvalHtml = botApprovalCardsMarkup\(run\)/);
  assert.match(app, /function rememberApprovalEventOutcome\(event\)/);
  assert.match(app, /approval\\\.\(resolved\|expired\)/);
  assert.match(app, /botState\.approvalInFlight/);
  assert.match(app, /body: \{ decision, actionSha256: item\.actionSha256, actor: "control-center" \}/);
  assert.match(css, /\.bot-approval-card/);
  assert.match(css, /\.bot-approval-outcome\.is-expired/);
});

test("Approval refreshes are latest-wins and refresh the visible Bot conversation", async () => {
  const app = await readFile(`${appRoot}/public/app.js`, "utf8");
  assert.match(app, /let approvalsLoadGeneration = 0/);
  assert.match(app, /let approvalSnapshotEpoch = null/);
  assert.match(app, /let approvalSnapshotRevision = 0/);
  assert.match(app, /const generation = \+\+approvalsLoadGeneration/);
  assert.match(app, /if \(generation !== approvalsLoadGeneration\) return payload/);
  assert.match(app, /await Promise\.allSettled/);
  assert.match(app, /compareApprovalSnapshotVersions/);
  assert.match(app, /normalizeApprovalRuntimeGeneration/);
  assert.match(app, /version\.resetRevision/);
  assert.match(app, /approvalSnapshotRuntimeGeneration/);
  assert.match(app, /state\.approvals = \[\]/);
  assert.match(app, /state\.leases = \[\]/);
  assert.match(app, /if \(state\.view === "bot" && botState\.agentId\) void botSyncConversation\(botState\.agentId\)/);
});

test("Bot settlement cards consume the real settlement contract and fail closed on unknown payloads", async () => {
  const [app, css] = await Promise.all([
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-shell.css`, "utf8"),
  ]);
  assert.match(app, /const BOT_SETTLEMENT_SCHEMA = "514cc\.run-settlement\/v1"/);
  assert.match(app, /function botSettlementMarkup\(run\)/);
  assert.match(app, /data-bot-card="settlement" data-bot-card-source="settlement"/);
  assert.match(app, /schema !== BOT_SETTLEMENT_SCHEMA/);
  assert.match(app, /function botSettlementArtifactMarkup\(artifact\)/);
  assert.match(app, /artifacts\.slice\(0, 16\)/);
  assert.match(app, /requestSettlement\("bot", rid\)/);
  assert.match(app, /data-bot-settlement-diff/);
  assert.match(app, /不会自动 merge、commit 或 push/);
  assert.match(css, /\.bot-settlement-card/);
  assert.match(css, /\.bot-artifact-row/);
});

test("Bot settlement validation requires complete ownership, diff, artifact, and no-auto-land fields", async () => {
  const app = await readFile(`${appRoot}/public/app.js`, "utf8");
  assert.match(app, /function validateBotSettlementEnvelope\(value, expectedRunId = null\)/);
  assert.match(app, /结算响应的 run 归属不一致/);
  assert.match(app, /BOT_SETTLEMENT_REQUIRED_ACTIONS/);
  assert.match(app, /value\.autoLanding\[action\] !== false/);
  assert.match(app, /typeof value\.diff\.available !== "boolean"/);
  assert.match(app, /artifact\.published !== false/);
  assert.match(app, /view\.status === "invalid"/);
});

test("Bot settlement views refresh after run changes or the bounded TTL expires", async () => {
  const [app, module] = await Promise.all([
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/modules/conversation-run-projection.js`, "utf8"),
  ]);
  assert.match(app, /const BOT_SETTLEMENT_TTL_MS = 15_000/);
  assert.match(app, /import \{[^}]*settlementRunSignature[^}]*\} from "\.\/modules\/conversation-run-projection\.js"/);
  assert.match(app, /import \{[^}]*settlementViewNeedsRefresh[^}]*\} from "\.\/modules\/conversation-run-projection\.js"/);
  assert.match(module, /export function settlementRunSignature\(run\)/);
  assert.match(module, /export function settlementViewNeedsRefresh\(view, run, ttlMs\)/);
  assert.match(module, /signature && view\.runSignature && signature !== view\.runSignature/);
  assert.match(module, /Date\.now\(\) - loadedAt >= ttlMs/);
  assert.match(app, /loadBotSettlement\(runId, \{ force = false, runSignature = "", skipLoadingGuard = false \}/);
  assert.match(app, /loadRunSettlement\(runId, \{ force = false, runSignature = "", skipLoadingGuard = false \}/);
});

test("Approval outcomes retain run ownership when terminal events omit runId and stay bounded", async () => {
  const app = await readFile(`${appRoot}/public/app.js`, "utf8");
  assert.match(app, /const INLINE_APPROVAL_OUTCOME_LIMIT = 64/);
  assert.match(app, /function rememberApprovalPending\(item\)/);
  assert.match(app, /function approvalRunIdFor\(id\)/);
  assert.match(app, /approvalRunIdFor\(id\)/);
  assert.match(app, /while \(inlineApprovalOutcomes\.size > INLINE_APPROVAL_OUTCOME_LIMIT\)/);
  assert.match(app, /normalizeApprovalDecision\(value, \{ expired = false \}/);
});

test("Bootstrap approvals cannot downgrade the versioned approval snapshot", async () => {
  const [app, server] = await Promise.all([
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/server.mjs`, "utf8"),
  ]);
  assert.match(server, /function approvalSnapshotForPublic\(\)/);
  assert.match(server, /approvals: approvalSnapshot\.approvals/);
  assert.match(server, /approvalSnapshot,/);
  assert.match(server, /pathname === "\/api\/approvals"/);
  assert.match(server, /return json\(response, 200, approvalSnapshotForPublic\(\)\)/);
  assert.match(app, /function approvalSnapshotFromPayload\(payload\)/);
  assert.match(app, /function applyApprovalSnapshot\(payload, \{ source = "审批快照" \} = \{\}\)/);
  assert.match(app, /applyApprovalSnapshot\(payload, \{ source: "bootstrap 审批快照" \}\)/);
  assert.match(app, /typeof snapshot\.revision !== "number"/);
  assert.match(app, /approvalSnapshotRuntimeGeneration/);
  assert.doesNotMatch(app, /state\.approvals = unwrapList\(payload, \["approvals"\]\)/);
});

test("Workbench settlement distinguishes unavailable and blocked states", async () => {
  const [app, css] = await Promise.all([
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/styles.css`, "utf8"),
  ]);
  assert.match(app, /if \(!view \|\| view\.status === "loading"\)/);
  assert.match(app, /交付记录暂时不可用/);
  assert.match(app, /data-settlement-state="\$\{stateLabel\}"/);
  assert.match(app, /\["blocked", "remote-unsupported", "unknown", "partial"\]/);
  assert.match(app, /SETTLEMENT_REQUEST_TIMEOUT_MS = 12_000/);
  assert.match(app, /data-settlement-retry/);
  assert.match(app, /data-bot-settlement-retry/);
  assert.match(app, /交付尚未确认/);
  assert.match(css, /\.settlement-card\.is-error/);
  assert.match(css, /\.settlement-card\.is-loading/);
});
