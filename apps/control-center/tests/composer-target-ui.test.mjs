import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const publicRoot = resolve(import.meta.dirname, "../public");

test("composer target tabs are the only visible direct-recipient control", async () => {
  const [html, app, state, css] = await Promise.all([
    readFile(resolve(publicRoot, "index.html"), "utf8"),
    readFile(resolve(publicRoot, "app.js"), "utf8"),
    readFile(resolve(publicRoot, "state.js"), "utf8"),
    readFile(resolve(publicRoot, "forge/workbench.css"), "utf8"),
  ]);

  const form = html.slice(html.indexOf('id="task-form"'), html.indexOf("</form>", html.indexOf('id="task-form"')));
  assert.match(form, /id="member-strip"[^>]+role="radiogroup"[^>]+aria-label="直接发送目标"/);
  assert.match(form, /id="composer-collaborators"[^>]+aria-label="额外协作者"[^>]+hidden/);
  assert.match(form, /id="composer-target-summary"[^>]+aria-live="polite"/);
  assert.match(form, /id="start-agent" hidden aria-hidden="true" tabindex="-1"/);
  assert.match(form, /id="followup-agent" hidden aria-hidden="true" tabindex="-1"/);
  assert.doesNotMatch(html, /id="start-agent-pick"|id="followup-agent-pick"/);
  assert.match(state, /composerTargetAgentId:\s*null/);
  assert.match(app, /function activeComposerTarget\(\)/);
  assert.match(app, /function defaultRunRecipient\(run\)/);
  assert.match(app, /function runRecipient\(run, requestedAgentId = null\)/);
  assert.match(app, /data-composer-target=/);
  assert.match(app, /role="radio"/);
  assert.match(app, /aria-checked=/);
  assert.match(app, /function renderRequestedAgentChips/);
  assert.match(app, /function keepActiveComposerTargetVisible/);
  assert.match(app, /strip\.scrollLeft \+=/);
  assert.match(app, /startAgentId:\s*composerTarget\.memberId/);
  const previewRoute = app.slice(app.indexOf("async function previewRoute"), app.indexOf("async function handleRouterSubmit"));
  const createRun = app.slice(app.indexOf("async function createRun"), app.indexOf("function buildContinueMessage"));
  assert.match(previewRoute, /requestedProvider:\s*composerTarget\.memberId \|\| undefined/);
  assert.match(createRun, /requestedProvider:\s*composerTarget\.memberId/);
  assert.match(app, /agentId:\s*composerTarget\.memberId/);
  assert.match(app, /function captureComposerConfig/);
  assert.match(app, /requestedAgentIds:\s*submission\.requestedAgentIds\.length/);
  assert.doesNotMatch(app, /startAgentId:\s*elements\["start-agent"\]/);
  assert.doesNotMatch(app, /agentId:\s*elements\["followup-agent"\]/);
  assert.doesNotMatch(app, /data-composer-target=""/);
  assert.doesNotMatch(app, /data-pick-dismiss|团队协作 · 由/);
  assert.doesNotMatch(app, /openTab\([^\n]*,\s*null\)/);
  assert.match(app, /if \(focusAnswer\) selectComposerTarget\(focusAnswer\.dataset\.focusAnswer/);
  assert.match(css, /\.composer-target-tabs\s*\{/);
  assert.match(css, /data-target-agent="kimi-frontend"/);
});

test("mentions stay structured without changing the direct target", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  const start = app.indexOf("function applyMention(agentId)");
  const end = app.indexOf("\nconst FORMAT_BADGES", start);
  const body = app.slice(start, end);
  assert.match(body, /state\.requestedAgentIds = addRequestedAgentId/);
  assert.doesNotMatch(body, /selectComposerTarget|start-agent|followup-agent/);
});

test("unsupported controls hide and continuing sessions expose an honest locked-state label", async () => {
  const [html, app] = await Promise.all([
    readFile(resolve(publicRoot, "index.html"), "utf8"),
    readFile(resolve(publicRoot, "app.js"), "utf8"),
  ]);
  const visibility = app.slice(app.indexOf("function syncComposerControlVisibility"), app.indexOf("function staticControlContext"));
  assert.match(html, /id="composer-session-controls" hidden/);
  assert.match(html, /id="attach-menu"[^>]*role="menu"/);
  assert.match(html, /data-attach-action="file"/);
  assert.match(html, /data-attach-action="paste"/);
  assert.match(html, /#lucide-clipboard-list/);
  assert.match(visibility, /effortUnsupported/);
  assert.match(visibility, /task-effort-pick/);
  assert.match(visibility, /composer-session-controls/);
  assert.match(visibility, /hidden = !continuing/);
  assert.match(app, /沿用 \$\{memberName\} 会话配置/);
  assert.match(app, /sessionControls\.querySelector\("span"\)\.textContent = "热调"/);
  assert.match(app, /const defaultLabel = discovered\.defaultModel[\s\S]*?: "CLI 默认";/);
  assert.doesNotMatch(app, /\$\{agentLabel\(agentId\)\} CLI/);
  assert.match(app, /async function pickComposerFiles\(\)/);
  assert.match(app, /async function pasteComposerClipboardImages\(\)/);
  assert.match(app, /void pickComposerFiles\(\)/);
  assert.doesNotMatch(app, /elements\["attach-button"\]\?\.click\(\)/);
});

test("composer footer attach menu and compact session chip are wired in the last-loaded form CSS", async () => {
  const css = await readFile(resolve(publicRoot, "forge/console-form.css"), "utf8");
  assert.match(css, /\.composer-attach \{/);
  assert.match(css, /\.attach-menu \{[^}]*bottom: calc\(100% \+ 6px\);/s);
  assert.match(css, /\.composer-footer \.pick-menu-host[\s\S]*?max-width: 240px;/);
  assert.match(css, /\.composer-footer \.composer-session-controls \{/);
  assert.match(css, /\.composer-shell \.composer-footer \{[^}]*flex-wrap: nowrap;/s);
  assert.match(css, /\.composer-footer \.permission-pick[\s\S]*?border:\s*0;/);
  assert.match(css, /\.composer-footer \.permission-pick:hover[\s\S]*?background:\s*transparent;/);
  assert.match(css, /\.pick-menu \{[^}]*bottom: calc\(100% \+ 6px\);/s);
  assert.match(css, /\.pick-menu-row:hover/);
});

test("composer model and effort use custom menus while the hidden select stays the source of truth", async () => {
  const [html, app] = await Promise.all([
    readFile(resolve(publicRoot, "index.html"), "utf8"),
    readFile(resolve(publicRoot, "app.js"), "utf8"),
  ]);
  const form = html.slice(html.indexOf('id="task-form"'), html.indexOf("</form>", html.indexOf('id="task-form"')));
  assert.match(form, /id="task-model"[^>]*hidden/);
  assert.match(form, /id="model-pill"[^>]*aria-controls="model-menu"/);
  assert.match(form, /id="model-menu"[^>]*role="menu"/);
  assert.match(form, /id="task-effort"[^>]*hidden/);
  assert.match(form, /id="effort-pill"[^>]*aria-controls="effort-menu"/);
  assert.match(app, /function syncSelectPickMenu\(/);
  assert.match(app, /function syncModelPickMenu\(\)/);
  assert.match(app, /function syncEffortPickMenu\(\)/);
  assert.match(app, /optionAttr:\s*"model-option"/);
  assert.match(app, /optionAttr:\s*"effort-option"/);
  assert.match(app, /applyRuntimeSlashControl/);
});

test("selected CLI exposes a real command, defaults and diagnostics console", async () => {
  const [html, app, api, css] = await Promise.all([
    readFile(resolve(publicRoot, "index.html"), "utf8"),
    readFile(resolve(publicRoot, "app.js"), "utf8"),
    readFile(resolve(publicRoot, "api.js"), "utf8"),
    readFile(resolve(publicRoot, "forge/workbench.css"), "utf8"),
  ]);
  const form = html.slice(html.indexOf('id="task-form"'), html.indexOf("</form>", html.indexOf('id="task-form"')));

  assert.match(form, /id="composer-cli-console"/);
  assert.match(form, /data-composer-cli-tab="commands"/);
  assert.match(form, /data-composer-cli-tab="defaults"/);
  assert.match(form, /data-composer-cli-tab="connection"/);
  assert.match(form, /id="composer-cli-default-model"/);
  assert.match(form, /id="composer-cli-default-effort"/);
  assert.match(form, /id="composer-cli-default-permission"/);
  assert.match(form, /id="composer-cli-open-capabilities"/);
  assert.match(form, /id="composer-cli-diagnostic-actions"/);
  assert.doesNotMatch(form, /composer-cli-(?:shell|argv|command)-input/);

  assert.match(api, /agentActions:\s*"\/api\/agents\/actions"/);
  assert.match(app, /request\(API\.agentActions,\s*\{\s*method:\s*"POST"/s);
  assert.match(app, /composer-cli-default-permission[\s\S]*?\{ includeEmpty: false \}/);
  assert.match(app, /request\(`\$\{API\.runtimeSeats\}\/\$\{encodeURIComponent\(runtimeProfileId\)\}`/);
  const saveDefaults = app.slice(app.indexOf("async function saveComposerCliDefaults"), app.indexOf("async function openComposerCliSeat"));
  assert.ok(saveDefaults.indexOf("const patch =") < saveDefaults.indexOf("beginComposerCliOperation(context)"));
  assert.ok(saveDefaults.indexOf("beginComposerCliOperation(context)") < saveDefaults.indexOf("body: patch"));
  assert.match(app, /const disabled = cliBusy \|\| \(continuing && !hotReachable\);/);
  assert.match(app, /function composerControlKey\(memberId, runtimeProfileId = null\)/);
  assert.match(app, /composerControlDrafts\.set\(key/);
  assert.match(app, /composerCliActionStates\.set\(key/);
  assert.match(app, /nativePermissionToComposer/);
  assert.doesNotMatch(app, /state\.composerCliBusy/);
  assert.match(app, /Codex 沙箱轴随原生会话固化；模型、Effort、权限降档与 ask↔auto 可热调，下一轮生效。/);
  assert.match(app, /surface:\s*"capabilities"/);
  assert.match(app, /output\.dataset\.context = cliContextState\.key/);
  assert.match(css, /composer-cli-diagnostic-output\[data-status="failed"\]/);
});

test("a stale composer blur timer cannot close a newly reopened command menu", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  const start = app.indexOf('taskInput.addEventListener("blur"');
  const end = app.indexOf("byId(\"slash-menu\")", start);
  const blurHandler = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(blurHandler, /document\.activeElement === taskInput/);
  assert.match(blurHandler, /document\.activeElement\?\.closest\?\.\("#mention-menu, #slash-menu"\)/);
  assert.match(blurHandler, /hideMentionMenu\(\);\s*hideSlashMenu\(\);/s);
});

// LO 2026-08-10：发送键随工作状态双态——活跃 run + 空输入 = 停止当前回复；
// 有输入 = 发送键（轮间插话不被吃掉）；审批挂起时停止键保持可用。
test("the send button becomes a stop key while the run is active and the input is empty", async () => {
  const [app, css, html] = await Promise.all([
    readFile(resolve(publicRoot, "app.js"), "utf8"),
    readFile(resolve(publicRoot, "styles.css"), "utf8"),
    readFile(resolve(publicRoot, "index.html"), "utf8"),
  ]);
  // 双态计算：续聊 + 真正可中断的 turn + 非预览 + 空输入 = stop
  // waiting_agent / recovery_required 没有 provider turn，不得再显示假停止键。
  assert.match(app, /function syncSubmitButtonMode\(\)/);
  assert.match(app, /function runHasInterruptibleTurn\(run\)/);
  assert.match(app, /const interruptible = Boolean\(run\) && !state\.sessionPreview && runHasInterruptibleTurn\(run\);/);
  assert.match(app, /const stopMode = interruptible && !hasInput;/);
  assert.match(app, /run\.status === "waiting_approval"/);
  assert.match(app.slice(app.indexOf("function runHasInterruptibleTurn"), app.indexOf("function syncSubmitButtonMode")), /waiting_agent/);
  assert.match(app.slice(app.indexOf("function runHasInterruptibleTurn"), app.indexOf("function syncSubmitButtonMode")), /!run\.pendingAsk && !run\.recoveryNote/);
  assert.doesNotMatch(app.slice(app.indexOf("function runHasInterruptibleTurn"), app.indexOf("function syncSubmitButtonMode")), /recovery_required/);
  // 停止态实心方块（官方同款语义）；发送态还原 lucide 箭头
  assert.match(app, /<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" \/>/);
  assert.match(app, /: '<svg class="icon lucide"><use href="#lucide-arrow-up"><\/use><\/svg>';/);
  // 状态翻页链路：loadRuns 是 run.completed/failed 等纯状态事件的唯一通道，必须连会话视图一起刷
  assert.match(app, /renderOverview\(\);\s*\n\s*\/\/ 状态翻页必须连会话视图一起刷[\s\S]*?renderSelectedRun\(\);/);
  // 停止路径：只中断当前 provider turn，不撤销整场会话的 session/租约/工作树。
  assert.match(app, /if \(elements\["submit-task-button"\]\?\.dataset\.mode === "stop"\) \{\s*\n\s*void interruptSelectedRun\(\);/);
  assert.match(app, /request\(`\/api\/runs\/\$\{encodeURIComponent\(run\.id\)\}\/interrupt`/);
  assert.match(app, /停止当前回复（保留会话、授权与工作树）/);
  assert.doesNotMatch(app, /停止当前任务（级联中止本 run 全部 CLI 子进程）/);
  assert.match(app, /run\\\.\(created\|updated\|completed\|failed\|cancelled\|interrupted\|interrupt_timeout\|context_compaction_started\|context_compaction_completed\|context_compaction_failed\|/);
  // 审批挂起 / 提交在途：输入禁用，但停止键必须可用——它是此时唯一有意义的动作。
  // 在途锁（composerSubmitInFlight）必须参与裁决：本行由 SSE 驱动的 setComposerMode 反复执行，
  // 少了它就会把提交锁冲掉，同一句话被送出两遍（LO 2026-08-14 报障）。
  assert.match(app, /elements\["submit-task-button"\]\.disabled = elements\["submit-task-button"\]\.dataset\.mode !== "stop" && \(composerSubmitInFlight \|\| attachmentUploadInFlight\(\) \|\| waitingApproval\);/);
  assert.match(app, /function setComposerSubmitInFlight\(active\)/);
  assert.match(app, /submit\.disabled = composerSubmitInFlight \|\| attachmentUploadInFlight\(\) \|\| !target\.memberId;/); // 侧边聊天不得成为绕过锁的第二入口
  // 联动：composer 重算（setComposerMode）与输入事件都刷新双态
  assert.match(app, /syncSubmitButtonMode\(\); \/\/ 发送\/停止双态/);
  assert.match(app, /syncSubmitButtonMode\(\); \/\/ 输入有无决定发送\/停止双态/);
  // 停止模式跳过原生 required 校验（空输入正是停止场景），否则浏览器先弹「请填写此字段」
  assert.match(app, /button\.toggleAttribute\("formnovalidate", stopMode\);/);
  // 图标引用方式与既有取消按钮同款 + 停止态样式
  assert.match(html, /#lucide-circle-stop/);
  assert.ok(css.includes(".send-button.is-stop {"), "缺少停止态样式");
  assert.match(app, /dataset\.mode !== "stop"/);
  assert.match(app, /function stashComposerDraftForCurrentContext\(\)/);
  assert.match(app, /function restoreComposerDraftForCurrentContext\(\)/);
  assert.match(app, /stashComposerDraftForCurrentContext\(\);\s*\n\s*tab\.dirty = false;/);
  assert.match(app, /restoreComposerDraftForCurrentContext\(\);\s*\n\s*if \(focusTab\)/);
  assert.match(app, /function clearSubmittedComposerDraft\(\{ runId = null, submittedDraft \}\)/);
  assert.match(app, /composerDraftMatches\(currentDraft, submittedDraft\)/);
  assert.match(app, /state\.composerRunDrafts\[runId\] = currentDraft/);
  assert.match(app, /state\.composerNewTaskDraft = emptyComposerDraft\(\)/);
  assert.match(app, /已发送，正在回复/);
  assert.match(app, /对方在等你回答/);
  assert.doesNotMatch(app, /续接消息已完成/);
});

test("composer context transitions stash the old owner before restoring the new owner", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  const bodyOf = (startLabel, endLabel) => {
    const start = app.indexOf(startLabel);
    const end = app.indexOf(endLabel, start + startLabel.length);
    assert.ok(start >= 0 && end > start, `missing source range: ${startLabel}`);
    return app.slice(start, end);
  };
  const ordered = (source, ...needles) => {
    let cursor = -1;
    for (const needle of needles) {
      const next = source.indexOf(needle, cursor + 1);
      assert.ok(next > cursor, `expected ordered token: ${needle}`);
      cursor = next;
    }
  };

  const previewOpen = bodyOf("async function openSessionPreview", "function closeSessionPreview");
  ordered(previewOpen, "stashComposerDraftForCurrentContext();", "state.sessionPreview = {", "restoreComposerDraftForCurrentContext();", "renderSelectedRun();");

  const previewClose = bodyOf("function closeSessionPreview", "function renderSessionPreview");
  ordered(previewClose, "stashComposerDraftForCurrentContext();", "state.sessionPreview = null;", "restoreComposerDraftForCurrentContext();", "renderSelectedRun();");

  const closeTab = bodyOf("function closeTab", "function renderTabs");
  ordered(closeTab, "stashComposerDraftForCurrentContext();", "state.selectedRunId = null;", "state.sessionPreview = null;", "restoreComposerDraftForCurrentContext();");

  const loadRuns = bodyOf("async function loadRuns", "async function loadApprovals");
  ordered(loadRuns, "stashComposerDraftForCurrentContext();", "state.runs =", "state.selectedRunId = nextSelectedRunId;", "restoreComposerDraftForCurrentContext();", "renderRuns();");
  assert.match(loadRuns, /composerWasNewTask && composerDraftHasActivity/);

  const renderRuns = bodyOf("function renderRuns", "function renderRailMetaSections");
  ordered(
    renderRuns,
    "stashComposerDraftForCurrentContext();",
    "const survivingSelectedRunId = existingRunIds.has(state.selectedRunId) ? state.selectedRunId : null;",
    "state.selectedRunId = activeTab()?.runId ?? survivingSelectedRunId;",
    "restoreComposerDraftForCurrentContext();",
  );

  const transition = bodyOf("function transitionComposerContext", "function enterNewTaskComposer");
  ordered(transition, "stashComposerDraftForCurrentContext();", "update();", "restoreComposerDraftForCurrentContext();");
  const enterNewTask = bodyOf("function enterNewTaskComposer", "function activateAttachmentContext");
  assert.match(enterNewTask, /transitionComposerContext\(\(\) => \{/);
  ordered(enterNewTask, "state.selectedRunId = null;", "state.sessionPreview = null;", "state.activeTabKey = null;");
  ordered(enterNewTask, "transitionComposerContext", "persistTabs();", "renderTabs();", "renderRuns();");

  const paletteNew = bodyOf('id: "task:new"', 'id: "team:manage"');
  assert.match(paletteNew, /enterNewTaskComposer\(\);/);
  const runContinuation = bodyOf("function continueRunInNewTask", "async function renameRun");
  assert.equal((runContinuation.match(/enterNewTaskComposer\(/g) || []).length, 2);
  const sessionContinuation = bodyOf("function sessionContextItems", "async function loadAutomations");
  assert.match(sessionContinuation, /label: "在新任务中继续"[\s\S]*?enterNewTaskComposer\(\{ pendingCwd: project\.path, pendingRemote: null \}\)/);
  const localSlash = bodyOf("const LOCAL_SLASH_COMMANDS", "function applyRuntimeSlashControl");
  assert.match(localSlash, /id: "new"[\s\S]*?enterNewTaskComposer\(\);/);
  const sessionDialog = bodyOf("function confirmSessionDialog", "async function confirmRemoteSessionDialog");
  assert.match(sessionDialog, /enterNewTaskComposer\(\{ agentPickerOpen: true \}\);/);
  const retry = bodyOf("function retryRun", "function newComposerDraftId");
  assert.match(retry, /enterNewTaskComposer\(\{ text: run\.prompt \}\);/);
  const restoreTabs = bodyOf("function restoreTabs", "function openTab");
  assert.match(restoreTabs, /!state\.selectionClearedByUser && !state\.sessionPreview && !state\.deepLinkRunId/);
  assert.match(restoreTabs, /transitionComposerContext\(\(\) => \{/);
  const clearFinished = bodyOf("async function clearFinishedRuns", "function exposeProjectForLocation");
  ordered(clearFinished, "selectedFinishedRunId", "enterNewTaskComposer({ focus: false });", "await loadRuns();");
  const projectNewSessionStart = app.indexOf('event.target.closest("[data-project-newsession]")');
  const projectNewSession = app.slice(projectNewSessionStart, app.indexOf("// agent 徽标选择器", projectNewSessionStart));
  assert.equal((projectNewSession.match(/enterNewTaskComposer\(/g) || []).length, 2);
  const composerNewTask = app.slice(app.indexOf('elements["composer-new-task"].addEventListener'), app.indexOf('elements["new-session-button"]'));
  assert.match(composerNewTask, /enterNewTaskComposer\(\);/);
});

test("same-page conversation deep links are parsed and consumed before Forge routes", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  const parserStart = app.indexOf("function conversationDeepLinkFromHash");
  const parserEnd = app.indexOf("async function consumeConversationDeepLink", parserStart);
  assert.ok(parserStart >= 0 && parserEnd > parserStart);
  const parse = new Function(`${app.slice(parserStart, parserEnd)}\nreturn conversationDeepLinkFromHash;`)();

  assert.deepEqual(parse("#run=run-123"), { runId: "run-123", projectId: null, session: null });
  assert.deepEqual(parse("#session=project-1%3A%3Asession-2"), {
    runId: null,
    projectId: null,
    session: { cli: "claude", projectId: "project-1", sessionId: "session-2" },
  });
  assert.deepEqual(parse("#session=codex%3A%3Aproject-1%3A%3Asession-2"), {
    runId: null,
    projectId: null,
    session: { cli: "codex", projectId: "project-1", sessionId: "session-2" },
  });
  assert.deepEqual(parse("#project=project-1"), { runId: null, projectId: "project-1", session: null });
  assert.equal(parse("#config/providers"), null);

  const hashHandlerStart = app.indexOf('window.addEventListener("hashchange"');
  const hashHandlerEnd = app.indexOf('elements["refresh-button"]', hashHandlerStart);
  const hashHandler = app.slice(hashHandlerStart, hashHandlerEnd);
  assert.ok(hashHandler.indexOf("conversationDeepLinkFromHash()") < hashHandler.indexOf("parseForgeRoute()"));
  assert.match(hashHandler, /void consumeConversationDeepLink\(conversationDeepLink\);\s*return;/);
});

test("new-task picker uses catalog faces instead of ?? placeholders", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  assert.match(app, /function agentFaceMarkup\(/);
  assert.match(app, /function catalogMember\(/);
  assert.match(app, /memberFaceMarkup\(/);
  const picker = app.slice(app.indexOf("function agentPickerMarkup"), app.indexOf("const QUICK_TASK_TEMPLATES"));
  assert.match(picker, /agentFaceMarkup\(id\)/);
  assert.doesNotMatch(picker, /"\?\?"/);
  const constellation = app.slice(app.indexOf("function teamConstellationMarkup"), app.indexOf("function welcomeTemplatesMarkup"));
  assert.match(constellation, /agentFaceMarkup\(id\)/);
  assert.doesNotMatch(constellation, /"\?\?"/);
  assert.match(app, /function refreshAvatarSurfaces\(\)[\s\S]{0,400}renderSelectedRun\(/);
});

// LO 2026-08-20：@ 带自定义头像的协作者时，chip 里的 img 没有尺寸约束，
// 浏览器按原始像素渲染，把 overflow-x 的额外协作者行撑成整屏巨图。
test("custom collaborator avatars stay chip-sized and never render at intrinsic pixel size", async () => {
  const [baseCss, workbenchCss] = await Promise.all([
    readFile(resolve(publicRoot, "styles.css"), "utf8"),
    readFile(resolve(publicRoot, "forge/workbench.css"), "utf8"),
  ]);

  // 全局兜底：任何宿主漏写尺寸都退化成字号量级的小图，而不是原始像素
  assert.match(baseCss, /^\.avatar-photo \{[^}]*\n\}/ms);
  const fallbackRule = baseCss.slice(baseCss.search(/^\.avatar-photo \{/m));
  assert.match(fallbackRule.slice(0, fallbackRule.indexOf("}")), /width:[^;]+;[\s\S]*?height:[^;]+;/);

  // 报障宿主：额外协作者 chip 必须与官方 CLI 字形同尺寸收口
  const chipRule = workbenchCss.slice(workbenchCss.indexOf(".composer-collaborator-chip .avatar-photo"));
  assert.ok(chipRule.startsWith(".composer-collaborator-chip .avatar-photo"), "缺少额外协作者 chip 的头像尺寸约束");
  const chipBody = chipRule.slice(chipRule.indexOf("{"), chipRule.indexOf("}"));
  assert.match(chipBody, /width:\s*13px/);
  assert.match(chipBody, /height:\s*13px/);
  assert.match(chipBody, /object-fit:\s*cover/);
  assert.match(chipBody, /flex:\s*0 0 auto/);
});
