import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { normalizeRunSessions } from "../public/team-panel.js";
import { unwrapList } from "../public/utils.js";
import { memberRuntimeFactValues, normalizeMemberModelOptions } from "../public/modules/member-library.js";

const publicRoot = resolve(import.meta.dirname, "../public");

test("member model options preserve ids and labels without stringifying catalog objects", () => {
  assert.deepEqual(normalizeMemberModelOptions([
    { id: "", label: "CLI 默认" },
    { id: "kimi-code/k3", label: "K3" },
    "kimi-code/k3-256k",
    { id: "kimi-code/k3", label: "重复项" },
  ], "kimi-code/kimi-for-coding"), [
    { id: "kimi-code/k3", label: "K3" },
    { id: "kimi-code/k3-256k", label: "kimi-code/k3-256k" },
    { id: "kimi-code/kimi-for-coding", label: "kimi-code/kimi-for-coding" },
  ]);
});

test("member runtime facts follow the newly selected runtime profile instead of stale member projection", () => {
  assert.deepEqual(memberRuntimeFactValues({
    id: "codex-technical",
    provider: "openai",
    adapterLabel: "Codex",
    providerBindingMode: "serialized-live-projection",
  }, {
    id: "kimi-frontend",
    provider: "moonshot",
    adapterLabel: "Kimi Code",
    providerBindingMode: "cli-managed",
  }), {
    provider: "moonshot",
    adapter: "Kimi Code",
    connectionScope: "cli-managed",
  });
});

test("team route owns activation, settings and runtime surfaces without a separate dialog", async () => {
  const index = await readFile(resolve(publicRoot, "index.html"), "utf8");
  const teamStart = index.indexOf('id="view-team"');
  const configStart = index.indexOf('id="view-config"');
  assert.ok(teamStart > 0 && configStart > teamStart, "team and config routes must exist in order");

  const teamView = index.slice(teamStart, configStart);
  for (const id of [
    "team-settings-panel",
    "team-switch-select",
    "team-active-status",
    "team-activate-button",
    "team-apply-providers-button",
    "team-form",
    "team-roster-summary",
    "team-starmap-root",
    "team-router-workbench",
    "router-form",
    "team-routing-root",
    "team-hero-root",
    "team-roster-root",
    "team-flow-root",
  ]) {
    assert.match(teamView, new RegExp(`id="${id}"`), `${id} must live inside #view-team`);
  }
  assert.doesNotMatch(index, /<dialog[^>]+id="team-dialog"/, "team settings must not regress to a detached modal");
  assert.doesNotMatch(index, /默认 Claude|claude-fable 席位不可移除/);
  assert.doesNotMatch(index, /src="\.\/collab-flow\.js"|src="\.\/hero-starmap\.js"/, "app.js must own team runtime refresh instead of a second auto-boot script");
  assert.doesNotMatch(index, /id="view-hero"|data-view="hero"/, "协作星图 must live on the team page, not as a separate nav view");
  assert.doesNotMatch(index, /id="view-router"|data-view-panel="router"/, "模型路由 must live on the team page, not as a separate view panel");
  assert.match(teamView, /id="team-starmap-title"/);
  assert.match(teamView, /class="team-command-deck"/);
  assert.match(teamView, /class="team-command-deck"[\s\S]*id="team-surface-tabs"[\s\S]*<\/div>/);
});

test("team workspace contains a first-class editable member registry wired back into team composition", async () => {
  const [index, app, api, memberLibrary, runtimeSeatManager, teamCss, teamPanel] = await Promise.all([
    readFile(resolve(publicRoot, "index.html"), "utf8"),
    readFile(resolve(publicRoot, "app.js"), "utf8"),
    readFile(resolve(publicRoot, "api.js"), "utf8"),
    readFile(resolve(publicRoot, "modules/member-library.js"), "utf8"),
    readFile(resolve(publicRoot, "modules/runtime-seat-manager.js"), "utf8"),
    readFile(resolve(publicRoot, "forge/team.css"), "utf8"),
    readFile(resolve(publicRoot, "team-panel.js"), "utf8"),
  ]);
  const teamStart = index.indexOf('id="view-team"');
  const configStart = index.indexOf('id="view-config"');
  const teamView = index.slice(teamStart, configStart);

  for (const id of [
    "team-surface-tabs",
    "team-surface-orchestration",
    "team-surface-members",
    "team-surface-settings",
    "member-library-list",
    "member-new-button",
    "member-form",
    "member-avatar-field",
    "member-avatar-preview",
    "member-avatar-upload",
    "member-avatar-reset",
    "member-avatar-file",
    "member-runtime-profile-select",
    "member-seat-picker",
    "member-seat-picker-trigger",
    "member-seat-picker-panel",
    "member-seat-picker-search-input",
    "member-seat-picker-options",
    "member-default-model-input",
    "member-default-effort-select",
    "member-description-input",
    "member-capabilities-wall",
    "member-system-prompt-input",
    "member-main-brain-input",
    "member-main-brain-reason",
    "member-team-toggle-button",
    "member-open-config-button",
    "member-new-runtime-button",
    "member-open-capabilities-button",
  ]) {
    assert.match(teamView, new RegExp(`id="${id}"`), `${id} must remain inside the unified team workspace`);
  }
  assert.match(teamView, /默认能力与身份提示/);
  assert.match(teamView, /id="team-surface-settings"[\s\S]*id="team-form"/);
  assert.doesNotMatch(
    teamView.slice(teamView.indexOf('id="team-surface-orchestration"'), teamView.indexOf('id="team-surface-members"')),
    /id="team-form"/,
    "live orchestration must not keep the settings form in the first screen",
  );
  assert.match(memberLibrary, /const TEAM_SURFACES = \["orchestration", "members", "settings"\]/);
  assert.match(app, /function openTeamSettingsSurface\(/);
  assert.match(app, /setSurface\("settings"/);
  assert.match(memberLibrary, /capabilities:\s*\["\*"\]/);
  assert.doesNotMatch(memberLibrary, /member-capabilities-wall"\)\.querySelectorAll|runtime-capability-conflict/);

  assert.match(api, /teamMembers:\s*"\/api\/team-members"/);
  assert.match(api, /adapterTemplates:\s*"\/api\/adapter-templates"/);
  assert.match(api, /runtimeSeats:\s*"\/api\/runtime-seats"/);
  assert.match(app, /createMemberLibrary\(\{/);
  assert.match(app, /account-dock/);
  assert.match(app, /requestBlob/);
  assert.match(memberLibrary, /memberAvatarMarkup/);
  assert.match(index, /id="account-dock"/);
  assert.match(index, /id="account-dock-label"/);
  assert.match(index, /id="settings-avatar-button"/);
  assert.match(teamPanel, /memberAvatarMarkup/);
  assert.doesNotMatch(teamPanel, /tp-avatar[\s\S]{0,80}lucide-bot/, "team cards default to official CLI icons, not a generic bot glyph");
  assert.match(app, /createRuntimeSeatManager\(\{/);
  assert.match(app, /data-edit-team-member/);
  assert.match(app, /onMemberSaved:[\s\S]{0,520}memberLibrary\?\.updateTeamToggle\(\)/);
  assert.match(app, /memberLibrary\?\.open\(edit\.dataset\.editTeamMember\)/);
  // 脏状态判断已从单行组合表达式收口为 hasUnsavedConfigChanges()（并多覆盖远程真源草稿与运行席位）。
  // 断语义而非断字面：收口必须覆盖各脏源，且离开页面的守护必须实际调用它。
  assert.match(app, /function hasUnsavedConfigChanges\(\)[\s\S]{0,400}configIsDirty\(\)[\s\S]{0,240}teamFormDirty[\s\S]{0,240}memberLibrary\?\.isDirty\(\)/);
  assert.match(app, /beforeunload[\s\S]{0,280}hasUnsavedConfigChanges\(\)/);
  assert.match(memberLibrary, /method: source\?\.id \? "PUT" : "POST"/);
  assert.match(memberLibrary, /method: "DELETE"/);
  assert.match(memberLibrary, /onToggleTeamMember\?\.\(source\.id/);
  assert.match(memberLibrary, /surface: "runtime"[\s\S]{0,160}runtimeProfileId: draft\?\.runtimeProfileId/);
  assert.match(memberLibrary, /surface: "capabilities"[\s\S]{0,120}memberId: source\?\.id/);
  assert.match(memberLibrary, /if \(!runtimeCatalog\(\)\.some[\s\S]{0,180}await refreshCatalog\(\)/);
  assert.match(memberLibrary, /renderEditor\(blankMember\(\), \{ isNew: true \}\)/);
  assert.match(memberLibrary, /byId\("member-description-input"\)\.value = member\.description \|\| ""/);
  assert.match(memberLibrary, /byId\("member-system-prompt-input"\)\.value = member\.systemPrompt \|\| ""/);
  assert.match(memberLibrary, /mainBrainAllowed && profile\.coordinatorEligible === true/);
  assert.match(memberLibrary, /member\.coordinatorEligibilityReason/);
  assert.match(memberLibrary, /"label", "shortLabel", "role", "description", "systemPrompt", "capabilities"/);
  assert.match(memberLibrary, /member-new-runtime-button[\s\S]{0,220}create: true/);
  assert.match(app, /async function openMemberConfigTarget/);
  assert.match(app, /runtimeSeatManager\.setMode\("seats", \{ focus: false \}\)/);
  assert.match(app, /if \(create\) await runtimeSeatManager\.create\(\)/);
  assert.match(app, /await runtimeSeatManager\.load\(\)[\s\S]{0,100}runtimeSeatManager\.focus\(runtimeProfileId\)/);
  assert.match(app, /invalidateCapabilitiesCatalog\(\)[\s\S]{0,180}reconcileTeamFormCatalog/);
  assert.match(app, /loadCapabilities\(\{ fresh: true \}\)/);
  assert.match(app, /configRouteHash\(state\.configSurface/);
  assert.match(app, /scope="col" tabindex="-1"[\s\S]{0,180}data-member-column/);
  assert.doesNotMatch(app, /selectSource\("control\.models"\)/, "member runtime deep links must use the structured seat editor");
  // 同上：运行席位的脏状态也归入 hasUnsavedConfigChanges() 收口，不再是独立的取反表达式
  assert.match(app, /function hasUnsavedConfigChanges\(\)[\s\S]{0,480}runtimeSeatManager\?\.isDirty\(\)/);
  assert.match(app, /data-member-column="\$\{escapeHtml\(id\)\}"/);
  assert.match(runtimeSeatManager, /let loadPromise = null/);
  assert.match(runtimeSeatManager, /const result = await loadPromise/);
  assert.match(runtimeSeatManager, /draft\.providerId = null/);
  // 运行席位自定义选择器：原生 select 仍是真源，选择回写后派发 change 走既有换绑链
  assert.match(memberLibrary, /select\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/);
  assert.match(memberLibrary, /function renderSeatPickerOptions\(\)/);
  assert.match(memberLibrary, /function applySeatPickerFilter\(\)/);
  assert.match(memberLibrary, /event\.stopPropagation\(\); \/\/ 搜索输入不算表单修改/);
  assert.match(teamCss, /\.member-seat-picker-trigger\s*\{/);
  assert.match(teamCss, /\.member-seat-picker-panel\s*\{/);
  assert.match(teamCss, /\.member-seat-picker-option\s*\{/);
  assert.match(teamCss, /\.member-library\s*\{/);
  assert.match(teamCss, /@media \(max-width: 680px\)/);
  assert.match(teamCss, /@media \(max-width: 680px\)[\s\S]*?\.team-surface-switcher\s*\{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(teamCss, /\.team-settings-form \.team-members-list,\s*\.tm-group-body,\s*\.team-runtime-overview \.cf-hero,[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(teamCss, /@media \(min-width: 681px\) and \(max-width: 1120px\)\s*\{\s*\.tm-group-body\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
});

test("team entry points and refresh path converge on the unified workspace", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  assert.match(app, /activateButton\.classList\.add\("is-current"\)/);
  assert.match(app, /function openTeamWorkspace\(/);
  assert.match(app, /manage-teams-button[^\n]+openTeamWorkspace/);
  assert.match(app, /state\.view === "team"[\s\S]{0,260}jobs\.push\(loadTeams\(\)\.then\(async \(teamsResult\)[\s\S]{0,180}const flowResult = await refreshCollabFlow\(\)[\s\S]{0,140}loadResultFailed\(teamsResult\) \? teamsResult : flowResult/);
  assert.match(app, /function applyTeamProviders\(teamId =/);
  assert.doesNotMatch(app, /openTeamDialog|closeTeamDialog|team-dialog/);
});

test("team export refuses unsaved drafts instead of silently packing the active team", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  const exportStart = app.indexOf("async function exportEditingTeam");
  const importStart = app.indexOf("async function importTeamPack");
  assert.ok(exportStart >= 0 && importStart > exportStart, "exportEditingTeam block is missing");
  const exportBody = app.slice(exportStart, importStart);
  assert.match(exportBody, /if \(!state\.editingTeamId\)/);
  assert.match(exportBody, /先保存团队，再导出/);
  assert.doesNotMatch(exportBody, /currentTeam\(\)/, "new drafts must not fall back to the activated team");
  assert.match(app, /team-export-button"\]\) elements\["team-export-button"\]\.hidden = !team/);
});

test("team writes force a fresh read without implicitly activating newly saved teams", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  const saveStart = app.indexOf("async function saveTeamForm");
  const deleteStart = app.indexOf("async function deleteEditingTeam");
  const providerStart = app.indexOf("// ── 供应商方案", deleteStart);
  const saveBody = app.slice(saveStart, deleteStart);
  const deleteBody = app.slice(deleteStart, providerStart);

  assert.match(saveBody, /loadTeams\(\{ fresh: true \}\)/);
  assert.match(deleteBody, /loadTeams\(\{ fresh: true \}\)/);
  assert.doesNotMatch(saveBody, /selectTeam\(created\.id\)/, "save/copy must remain browse-only until explicit activation");
  assert.match(app, /epoch !== teamsLoadEpoch[\s\S]{0,100}stale: true/);
  assert.match(app, /while \(teamsFreshRequested\)[\s\S]{0,120}startTeamsLoad\(\)/);
  assert.match(app, /loadTeams\(\)\.then\(\(result\) => \{[\s\S]{0,220}shouldHydrateTeamFormAfterLoad\(result/);
});

test("team draft state guards switching, activation and provider application", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  assert.match(app, /function markTeamFormDirty\(\)/);
  assert.match(app, /async function confirmDiscardTeamDraft\(\)/);
  assert.match(app, /team-switch-select[^\n]+addEventListener\("change", async[\s\S]{0,180}confirmDiscardTeamDraft\(\)/);
  assert.match(app, /applyButton\.disabled = !editing \|\| bindingCount === 0 \|\| teamFormDirty/);
  assert.match(app, /const bindings = teamFormDirty \? collectTeamProviderBindings\(\) : \(editing\?\.providers \?\? \{\}\)/);
  assert.match(app, /aria-label="将 \$\{escapeHtml\(name\)\} 设为团队主脑"/);
  assert.match(app, /state\.bootstrap\?\.teamCatalog/);
  assert.match(app, /coordinatorEligible: profile\.coordinatorEligible === true/);
  assert.match(app, /teamMemberEligible: profile\.teamMemberEligible === true/);
  assert.doesNotMatch(app, /const COORDINATOR_ELIGIBLE|Boolean\(String\(profile\.command/);
  assert.doesNotMatch(app, /mandatory = id === "claude-fable"|members\.unshift\("claude-fable"\)/);
  assert.match(app, /toast\("至少选择一名团队成员"/);
  assert.match(app, /toast\("请从已选成员中指定团队主脑"/);
  assert.match(app, /if \(coordinator && !members\.includes\(coordinator\)\) members\.push\(coordinator\)/);
  assert.match(app, /reconcileTeamFormCatalog\(previousTeamCatalog\)/);
  assert.match(app, /团队成员目录已更新；当前未保存草稿已保留/);
  assert.match(app, /await loadBootstrap\(\);[\s\S]{0,80}await loadTeams\(\{ fresh: true \}\)/);
  // 切换 / 激活 / 应用供应商三处各自的脏状态守护（重构后不再是一行组合判断，
  // 但三道闸必须都在——这条断言盯的是守护点存在，不是某行文本长什么样）。
  assert.match(app, /team-switch-select"\]\?\.addEventListener\("change"[\s\S]{0,240}await confirmDiscardTeamDraft\(\)/);
  assert.match(app, /function activateEditingTeam\(\)[\s\S]{0,200}teamFormDirty[\s\S]{0,160}先保存团队修改，再设为当前团队/);
  assert.match(app, /async function applyTeamProviders\([\s\S]{0,220}teamFormDirty[\s\S]{0,200}先保存团队修改，再应用供应商方案/);
});

test("team UI derives coordinator identity instead of branding Claude as the permanent brain", async () => {
  const [app, panel, roles, palette, state] = await Promise.all([
    readFile(resolve(publicRoot, "app.js"), "utf8"),
    readFile(resolve(publicRoot, "team-panel.js"), "utf8"),
    readFile(resolve(publicRoot, "modules/agent-roles.js"), "utf8"),
    readFile(resolve(publicRoot, "command-palette.js"), "utf8"),
    readFile(resolve(publicRoot, "state.js"), "utf8"),
  ]);
  for (const source of [app, panel, roles, palette, state]) assert.doesNotMatch(source, /Claude 主脑/);
  assert.match(panel, /"claude-fable": \{ name: "Claude Fable", title: "规划编排席"/);
  assert.match(panel, /agentId === coordinatorId[\s\S]{0,80}"orchestrator"/);
  assert.match(app, /const coordinatorName = coordinatorId \? agentLabel\(coordinatorId\) : "团队主脑"/);
  assert.doesNotMatch(app, /run\.coordinatorId \|\| "claude-fable"|members\[0\] \?\? "claude-fable"/);
  assert.doesNotMatch(app, /builtin\?\.members \?\? \["claude-fable"\]/);
  // UI-AUDIT P0-6：文字 loading 已换成骨架屏（单一真源 modules/placeholders.js）
  assert.match(app, /renderPlaceholder\(list, skeleton\(\{ variant: "list"/);
  assert.match(app, /catalog\.find\(\(profile\) => profile\.id === id\)\?\.label/);
  assert.match(app, /const brand = resolveCatalogBrand\(provider,/);
  assert.doesNotMatch(app, /const cli = agentCli\(id\) \|\| meta\.provider/);
});

test("legacy snake-case run identity normalizes both coordinator and start agent", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  const blockStart = app.indexOf("function normalizeRun(item, index)");
  const blockEnd = app.indexOf("\nfunction normalizeComponent", blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart, "normalizeRun block is missing");

  const context = { normalizeRunSessions, unwrapList };
  runInNewContext(`${app.slice(blockStart, blockEnd)}\nglobalThis.__normalizeRun = normalizeRun;`, context);
  const run = context.__normalizeRun({
    run_id: "legacy-run",
    coordinator_id: "codex-technical",
    start_agent_id: "kimi-frontend",
    sessions: {},
  }, 0);
  assert.equal(run.coordinatorId, "codex-technical");
  assert.equal(run.startAgentId, "kimi-frontend");
});

test("ambience engine: stage media layer, motion tiers, suspension and tune persistence are wired", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  const css = await readFile(resolve(publicRoot, "forge/team.css"), "utf8");
  // dsh-wallpaper-engine 工作台化的四要素，缺一即视为退化回静态背景
  assert.match(app, /function ensureTeamBgStageLayers/, "stage 媒体承载层");
  assert.match(app, /installTeamBgSuspensionOnce/, "遮挡暂停安装点");
  assert.match(css, /body\.team-bg-suspended \.atelier-stage \*,/s, "suspended 冻结规则");
  assert.match(app, /video\/mp4|blob\.type\.startsWith\("video\/"\)/, "视频媒体分支");
  assert.match(app, /prefersReducedMotion/, "系统减弱动态尊重");
  assert.match(app, /scheduleTeamTunePersist/, "融合滑杆防抖落盘");
  assert.match(css, /team-bg-flow-drift/, "subtle/rich 流场关键帧");
  assert.match(css, /team-bg-spark-rise/, "rich 光尘关键帧");
  // 表单控件存在且注册（融合滑杆由 TEAM_BG_FILTER_RANGES schema 动态渲染，html 只留挂载点）
  const html = await readFile(resolve(publicRoot, "index.html"), "utf8");
  for (const id of ["team-bg-motion-select", "team-bg-sliders", "team-bg-tune-reset", "team-bg-thumb-video"]) {
    assert.ok(html.includes(`id="${id}"`), `missing form control ${id}`);
  }
  // 滤镜 schema 单一事实源：五轴（含对比度）全部由 TEAM_BG_FILTER_RANGES 驱动
  assert.match(app, /TEAM_BG_FILTER_RANGES = Object\.freeze/, "滤镜 schema 单一事实源");
  assert.match(app, /contrast: \{ label: "对比度"/, "对比度轴入 schema");
  assert.match(app, /contrast\(\$\{f\.contrast\}\)|contrast\(\$\{v\}\)/, "contrast 进 CSS 滤镜链");
  // upload accept 含视频
  assert.match(html, /accept="image\/png,image\/jpeg,image\/gif,image\/webp,video\/mp4,video\/webm"/);
});

test("team ambience renders through the atelier-stage layer and stays wired to save flows", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  const css = await readFile(resolve(publicRoot, "forge/team.css"), "utf8");
  // 根因回归锁：body 级背景被 body.atelier 实底 + .atelier-stage fixed 纸面遮死，
  // 氛围必须落在 .atelier-stage::after（2026-08-27 LO 实测无效的修复点）
  assert.match(css, /body\[data-team-bg="aurora"\] \.atelier-stage::after/);
  assert.match(css, /body\.team-bg-custom \.atelier-stage::after/);
  assert.match(css, /--team-bg-image/);
  // 预设/上传/清除/表单保存四条路径都必须重挂氛围层
  assert.ok((app.match(/applyActiveTeamBackground\(\)/g) || []).length >= 6,
    "preset/upload/clear/save/startups paths must re-apply the ambience layer");
});

test("team-bg-active gate: main surfaces drop opaque fills only when a wallpaper is active", async () => {
  const app = await readFile(resolve(publicRoot, "app.js"), "utf8");
  const css = await readFile(resolve(publicRoot, "forge/team.css"), "utf8");
  // 遮挡层回归锁（2026-08-28）：氛围挂在 fixed stage（z-index:0），工作台壳/会话面/左轨的
  // 不透明实底会把壁纸完全遮死。壁纸生效态必须由 body.team-bg-active 单一门控：
  // 1) applyActiveTeamBackground 入口无条件清除（任何提前返回都落回无壁纸态）；
  // 2) preset 分支与自定义媒体分支各自重新挂上。
  const applyStart = app.indexOf("function applyActiveTeamBackground()");
  assert.ok(applyStart >= 0, "缺少 applyActiveTeamBackground");
  const applyBody = app.slice(applyStart, app.indexOf("\nasync function persistTeamAppearance", applyStart));
  const removeIndex = applyBody.indexOf('body.classList.remove("team-bg-active")');
  assert.ok(removeIndex >= 0, "入口必须无条件清除 team-bg-active，否则提前返回路径残留旧门控");
  // 顺序断言（不依赖字符偏移）：清除必须先于任何挂类，落在函数头部的统一复位段。
  assert.ok(removeIndex < applyBody.indexOf('classList.add("team-bg-active")'),
    "清除必须先于任何挂类（函数头部统一复位），不能只挂在某个分支里");
  assert.equal((applyBody.match(/classList\.add\("team-bg-active"\)/g) || []).length, 2,
    "preset 分支与自定义媒体分支必须各自挂上 team-bg-active");
  // reduced-motion 门控：experience-polish 在 reduce 下隐藏 stage，JS 不得再挂门控让玻璃蒙平底。
  assert.equal((applyBody.match(/if \(!prefersReducedMotion\(\)\) body\.classList\.add\("team-bg-active"\)/g) || []).length, 2,
    "挂类必须并入 prefers-reduced-motion 判断（两个分支同闸，单一事实源在 JS）");
  // 异步失败守卫：自定义媒体字节 404/网络失败时，镜像选中团队守卫后摘掉门控。
  assert.match(applyBody, /if \(state\.selectedTeamId === mediaId\) document\.body\.classList\.remove\("team-bg-active"\)/,
    "媒体字节失败的 catch 必须镜像守卫后摘掉 team-bg-active，玻璃态不得悬空");
  // CSS：透出规则全部被 body.team-bg-active 门控；操作台壳变透明，会话面/左轨走玻璃令牌族。
  assert.match(css, /body\.team-bg-active #view-workbench \.workbench-shell \{\s*background: transparent;/,
    "壁纸生效时操作台壳必须透出 stage");
  assert.match(css, /body\.team-bg-active #view-workbench \.conversation-pane,[\s\S]*?body\.team-bg-active #view-workbench \.run-rail \{[\s\S]*?--forge-glass-alpha/,
    "会话面/左轨必须改走玻璃令牌族（透明度/模糊随外观面板联动）");
  // 透出覆盖面：会话面内层与侧轨实底同段门控，否则 experience-polish 的实底把玻璃盖死。
  for (const surface of [".conversation-stream", ".conversation-heading", ".task-composer", ".context-rail", ".registry-dock", ".rail-statusline"]) {
    assert.match(css, new RegExp(`body\\.team-bg-active #view-workbench [^{]*${surface.replace(/\./g, "\\.")}`),
      `透出覆盖面遗漏：${surface} 必须由 body.team-bg-active 门控`);
  }
  // 消息流保较高 alpha 玻璃护可读性，不做全透明。（v8.1：+6% 封顶 96% 由 JS 预计算
  // 成 --forge-glass-alpha-mid 令牌——color-mix 百分位嵌 calc 有引擎兼容性地雷。）
  assert.match(css, /body\.team-bg-active #view-workbench \.conversation-stream \{\s*background: color-mix\(in oklab, var\(--glass-tint, var\(--wall-tint, var\(--bg\)\)\) var\(--forge-glass-alpha-mid, 92%\), transparent\);/,
    "消息流必须在玻璃 alpha 基础上加高并封顶，不得全透明");
  // 移动端层叠回归锁：玻璃规则（含 backdrop-filter）必须限定桌面宽幅，
  // 否则 ≤820px 新建层叠上下文会囚禁 pane 子元素终端抽屉（z-86）。
  const mediaGate = css.match(/@media \(min-width: 821px\) \{[\s\S]*?body\.team-bg-active #view-workbench \.conversation-pane/);
  assert.ok(mediaGate, "透出玻璃规则必须包裹在 @media (min-width: 821px) 内（移动端抽屉层叠保护）");
  // 无壁纸零回归：不得存在未门控的透明化规则（否则默认米色观感被破坏）。
  assert.doesNotMatch(css, /^(?:(?!body\.team-bg-active).*\n)*#view-workbench \.workbench-shell \{[^}]*background: transparent;/m,
    "操作台壳透明化必须由 team-bg-active 门控");
  // 特异性契约：门控规则带 ID（1,2,1）必须稳压 art-direction 的（1,1,0）与 experience-polish 的（0,2,0），不依赖加载顺序。
  assert.match(css, /body\.team-bg-active #view-workbench/);
});
