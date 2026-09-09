import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("configuration topology fuses providers, capabilities and sources into one route", async () => {
  const [html, appSource, stateSource, paletteSource, seatManagerSource, css, qaSource, remoteQaSource, baseCss, artDirectionCss] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/state.js`, "utf8"),
    readFile(`${appRoot}/public/command-palette.js`, "utf8"),
    readFile(`${appRoot}/public/modules/runtime-seat-manager.js`, "utf8"),
    readFile(`${appRoot}/public/forge/data.css`, "utf8"),
    readFile(`${appRoot}/scripts/qa-config-topology.mjs`, "utf8"),
    readFile(`${appRoot}/scripts/qa-remote-config.mjs`, "utf8"),
    readFile(`${appRoot}/public/styles.css`, "utf8"),
    readFile(`${appRoot}/public/forge/art-direction.css`, "utf8"),
  ]);

  assert.equal((html.match(/data-view-panel="config"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /data-view-panel="capabilities"|data-view="capabilities"/);
  assert.doesNotMatch(stateSource, /^\s*capabilities:\s*"能力图谱"/m);
  assert.match(stateSource, /config:\s*"配置图谱"/);

  for (const surface of ["providers", "local-runtime", "capabilities", "hooks", "sources"]) {
    assert.match(html, new RegExp(`role="tab"[^>]+aria-controls="config-surface-${surface}"[^>]+data-config-surface="${surface}"`));
    assert.match(html, new RegExp(`id="config-surface-${surface}"[^>]+data-config-surface-panel="${surface}"[^>]+role="tabpanel"`));
  }
  assert.match(html, /id="settings-destinations"[^>]+role="tablist"/);
  assert.match(html, /id="config-surface-capabilities"[\s\S]+id="cap-skills-body"[\s\S]+id="cap-mcp-body"/);
  for (const id of [
    "cap-overview",
    "cap-workspace-tabs",
    "cap-workspace-skills",
    "cap-workspace-mcp",
    "cap-mcp-search",
    "cap-mcp-filters",
    "cap-stat-skills",
    "cap-stat-mcp",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must remain in the capabilities workspace`);
  }
  assert.match(html, /data-cap-active-workspace="skills"/);
  assert.match(html, /data-cap-workspace="skills"/);
  assert.match(html, /data-cap-workspace="mcp"/);
  assert.match(html, /data-cap-jump="skills"/);
  assert.match(html, /data-cap-jump="mcp"/);
  assert.match(html, /data-mcp-filter="writable"/);
  assert.match(html, /data-mcp-filter="disabled"/);
  assert.match(appSource, /function setCapabilityWorkspace\(/);
  assert.match(appSource, /#cap-workspace-tabs \[data-cap-workspace\]/);
  assert.match(appSource, /class="cap-mcp-card/);
  assert.match(appSource, /data-mcp-toggle=/);
  assert.match(appSource, /data-mcp-edit=/);
  assert.match(appSource, /adoptIfMissing: true/);
  assert.match(stateSource, /capabilityWorkspace:\s*"skills"/);
  assert.doesNotMatch(html, /<tbody id="cap-mcp-body"/, "MCP 已改为卡片网格，不再是表格 tbody");
  assert.match(html, /id="runtime-connection-deck"[\s\S]+id="provider-columns"/);
  assert.match(html, /id="config-surface-local-runtime"[\s\S]+id="ccswitch-workbench"/);
  assert.match(
    html.slice(html.indexOf('id="config-surface-providers"'), html.indexOf('id="config-surface-local-runtime"')),
    /id="provider-columns"/,
    "connections own the providers surface",
  );
  assert.doesNotMatch(html.slice(html.indexOf('id="runtime-seat-component"'), html.indexOf('id="runtime-raw-source-workspace"')), /provider-columns|runtime-connection-deck/);
  assert.match(html, /href="\.\/forge\/runtime-workbench\.css"/);
  assert.match(html, /id="config-surface-sources"[\s\S]+class="config-shell"/);
  assert.doesNotMatch(html, /id="config-surface-runtime"/, "runtime seats belong inside the existing sources surface");

  for (const id of [
    "runtime-workspace-tabs",
    "runtime-workspace-seats-tab",
    "runtime-workspace-sources-tab",
    "runtime-seat-workspace",
    "runtime-raw-source-workspace",
    "runtime-seat-form",
    "runtime-seat-adapter-select",
    "runtime-seat-provider-select",
    "runtime-seat-command-input",
    "runtime-seat-model-input",
    "runtime-seat-permission-select",
    "runtime-seat-enabled-input",
    "runtime-seat-coordinator-input",
    "runtime-seat-capabilities-wall",
    "runtime-seat-system-prompt-input",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must remain in the fused configuration topology`);
  }
  assert.match(html, /默认能力与路由权重/);
  assert.doesNotMatch(html, /能力包络|Routing Envelope/);
  assert.match(seatManagerSource, /capabilities:\s*\["\*"\]/);
  assert.doesNotMatch(seatManagerSource, /capabilityEnvelope|runtime-seat-capabilities-wall"\)\.querySelectorAll/);
  assert.doesNotMatch(html, /id="config-topology-providers"[^>]+hidden/);
  // UI-AUDIT P0-6：散写灰字已换成规范空态（单一真源 modules/placeholders.js），id 保留以稳住 e2e 选择器
  assert.doesNotMatch(appSource, /id: "provider-unlocked-empty"/, "connection management does not require an open seat editor");
  assert.match(seatManagerSource, /function connectionApp\(/);
  assert.match(html, /id="runtime-connection-deck"/);
  assert.match(stateSource, /configSurface:\s*"sources"/);
  assert.match(html, /data-runtime-workspace-mode="seats"/);
  assert.match(html, /data-runtime-workspace-mode="sources"/);

  assert.match(appSource, /if \(path === "capabilities"\)/);
  assert.match(appSource, /configRouteHash\(state\.configSurface/);
  assert.match(appSource, /panel\.hidden = !active/);
  assert.match(appSource, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.match(appSource, /window\.__forgeCcSwitchPanel\?\.refresh/);
  assert.match(html, /id="config-host-bar"[^>]+aria-label="配置图谱目标"/);
  assert.match(html, /id="config-surface-remote"[^>]+aria-label="远程主机或项目配置图谱"/);
  assert.match(appSource, /data-config-project=/);
  assert.match(appSource, /function selectConfigProject\(/);
  assert.match(appSource, /`project:\$\{state\.configProjectId\}`/);
  assert.match(appSource, /\/api\/remote-projects\/\$\{encodeURIComponent\(target\.projectId\)\}\/graph/);
  assert.match(appSource, /\/api\/ssh\/hosts\/\$\{encodeURIComponent\(target\.hostId\)\}\/graph/);
  assert.match(stateSource, /configRemoteProviderApps:\s*new Map\(\)/);
  assert.match(appSource, /function configRemoteProviderAppBar\(/);
  assert.match(appSource, /data-config-remote-provider-app=/);
  assert.match(appSource, /data-config-remote-provider-apply=/);
  assert.match(appSource, /provider-plan\?app=/);
  assert.match(appSource, /\/provider-apply/);
  assert.match(appSource, /data-config-remote-team-apply/);
  assert.match(appSource, /跨应用不做全局回滚，部分失败会逐项回报/);
  assert.match(appSource, /data-config-remote-provider-source=/);
  assert.match(appSource, /class="provider-deck config-remote-provider-deck"/);
  assert.match(appSource, /class="ccswitch-workbench config-remote-workbench"/);
  assert.match(appSource, /if \(state\.configSurface === "local-runtime"\) \{\s*return configRemoteGraphBody/);
  assert.match(appSource, /function openLocalRuntimeWorkbench\(/);
  assert.match(appSource, /mountHooksPanel\(/);
  assert.match(html, /href="\.\/forge\/hooks\.css"/);
  assert.match(appSource, /远端钩子尚未接入/);
  const remoteProvidersBody = appSource.slice(
    appSource.indexOf("function configRemoteProvidersBody"),
    appSource.indexOf("function configRemoteCapabilityName"),
  );
  assert.doesNotMatch(remoteProvidersBody, /configRemoteRuntimeWorkbench/, "remote workbench belongs on the local-runtime surface");
  for (const tab of ["env", "proxy", "resources", "sync", "accounts"]) {
    assert.match(appSource, new RegExp(`\\{ id: "${tab}", label:`));
  }
  for (const tab of ["prompts", "mcps", "skills", "profiles", "workspace", "backups"]) {
    assert.match(appSource, new RegExp(`\\{ id: "${tab}", label:`));
  }
  assert.match(appSource, /data-config-remote-proxy-diagnose/);
  assert.match(appSource, /\/proxy-diagnose/);
  assert.match(appSource, /class="remote-health-dashboard"/);
  assert.match(appSource, /服务器状态/);
  assert.match(appSource, /Agent 花名册/);
  assert.match(appSource, /Skill 检测矩阵/);
  assert.match(appSource, /class="data-table config-remote-mcp-table"/);
  assert.match(appSource, /data-config-remote-runtime-mode="seats"/);
  assert.match(appSource, /data-config-remote-runtime-mode="sources"/);
  assert.match(appSource, /class="runtime-seat-layout config-remote-seat-layout"/);
  assert.match(appSource, /data-config-remote-cli=/);
  assert.match(appSource, /configRemoteSelectedClis\.set\(configRemoteTargetKey\(\), cliId\)/);
  assert.match(stateSource, /configRemoteMetricHistory:\s*new Map\(\)/);
  assert.match(stateSource, /configRemoteRuntimeModes:\s*new Map\(\)/);
  assert.match(stateSource, /configRemoteSelectedClis:\s*new Map\(\)/);
  assert.match(appSource, /data-config-target-terminal=/);
  assert.match(appSource, /data-config-remote-source-editor=/);
  assert.match(appSource, /data-config-remote-source-reload=/);
  assert.match(appSource, /data-config-remote-source-save=/);
  assert.match(appSource, /body: \{ file: fileId, content: submittedDraft\.content, digest: submittedDraft\.digest \}/);
  assert.match(appSource, /configHostSourceDrafts\.set\(key, \{ content: editor\.value, digest: data\.digest, dirty \}\)/);
  assert.match(appSource, /该文件是凭据载体，内容不会进入浏览器/);
  assert.match(appSource, /result\?\.status === "rolled_back"/);
  assert.match(appSource, /function configRemoteRecoveryEvidence\(/);
  assert.match(appSource, /pick\("status"\) === "recovery_required"/);
  assert.match(appSource, /const recovery = rememberConfigRemoteRecovery\(openedTarget, result/);
  assert.match(appSource, /function refreshConfigRemoteTarget\([\s\S]{0,240}Promise\.allSettled/);
  assert.match(appSource, /label: "打开配置图谱"/);
  assert.match(appSource, /Remote Project/);
  assert.match(appSource, /config-scope-badge/);
  assert.doesNotMatch(appSource, /不深入项目级目录/);
  assert.match(appSource, /createRuntimeSeatManager\(\{/);
  const providerPreview = appSource.slice(
    appSource.indexOf("async function loadProviderConfigPreview"),
    appSource.indexOf("async function maybeRevealProviderPreview"),
  );
  assert.match(providerPreview, /if \(!String\(provider\.name \|\| ""\)\.trim\(\)\)/);
  assert.ok(providerPreview.indexOf("provider.name") < providerPreview.indexOf("request(API.providerPreview"));

  assert.match(appSource, /data-capability-source-id/);
  assert.doesNotMatch(appSource, /endsWith\(`\/\$\{candidate\}`\)|candidate\.endsWith/);
  assert.match(appSource, /async function openCapabilitySource\(/);
  assert.match(appSource, /await selectSource\(source\.id\)/);
  assert.match(appSource, /setView\("config", \{ configSurface: "sources", focus: false \}\)/);
  assert.match(paletteSource, /item\.kind === "skill"[\s\S]+#config-surface-capabilities/);

  assert.match(seatManagerSource, /Promise\.all\(\[[\s\S]{0,220}request\(api\.adapterTemplates\)[\s\S]{0,120}request\(api\.runtimeSeats\)[\s\S]{0,120}ensureProviders\?\.\(\)/);
  assert.match(seatManagerSource, /method: updating \? "PUT" : "POST"/);
  assert.match(seatManagerSource, /async function canDiscard\(\)/);
  assert.match(seatManagerSource, /provider\.apps\?\.\[template\.providerApp\] === true/);
  assert.match(seatManagerSource, /template\?\.coordinatorCapable !== true/);
  assert.match(seatManagerSource, /let loadPromise = null/);
  assert.match(seatManagerSource, /const result = await loadPromise/);

  assert.match(css, /#view-config \.config-topology-track/);
  assert.match(baseCss, /\.config-remote-provider-columns[\s\S]{0,140}grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(baseCss, /\.config-remote-workbench[\s\S]{0,80}margin-top:\s*20px/);
  assert.match(baseCss, /@media \(max-width: 720px\)[\s\S]+\.config-remote-provider-row[\s\S]{0,100}display:\s*grid/);
  assert.match(baseCss, /\.config-remote-workbench \.ccs-tabs[\s\S]{0,80}overflow-x:\s*auto/);
  assert.match(baseCss, /\.config-remote-resource-tabs[\s\S]{0,100}overflow-x:\s*auto/);
  assert.match(baseCss, /\.remote-health-dashboard[\s\S]{0,200}border-radius:\s*8px/);
  assert.match(baseCss, /\.remote-health-primary[\s\S]{0,140}grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(baseCss, /\.config-remote-seat-layout[\s\S]{0,80}min-height:\s*560px/);
  assert.match(baseCss, /@media \(max-width: 720px\)[\s\S]+\.remote-health-primary[\s\S]{0,100}grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(baseCss, /@media \(max-width: 720px\)[\s\S]+\.config-remote-source-editor-actions[\s\S]{0,100}flex-direction:\s*column/);
  assert.match(baseCss, /@media \(max-width: 720px\)[\s\S]+\.config-source-open[\s\S]{0,180}grid-template-columns:\s*16px minmax\(0, 1fr\) auto/);
  assert.match(baseCss, /@media \(max-width: 720px\)[\s\S]+\.config-source-open \.config-source-label,[\s\S]{0,80}\.config-source-open > \.subtle[\s\S]{0,100}grid-column:\s*2 \/ -1/);
  assert.match(css, /#config-surface-capabilities \.cap-matrix th:first-child/);
  assert.match(css, /#config-surface-capabilities \.cap-matrix \{\s*border-collapse:\s*separate/);
  assert.match(css, /#config-surface-capabilities \.cap-matrix td\[colspan\]/);
  assert.match(css, /#config-surface-capabilities table\.cap-matrix/);
  assert.match(css, /#config-surface-capabilities \.cap-overview/);
  assert.match(css, /#config-surface-capabilities \.cap-mcp-grid/);
  assert.match(css, /#config-surface-capabilities \.cap-workspace\[hidden\]/);
  assert.match(html, /id="cap-skill-create-button"/);
  assert.match(html, /id="cap-mcp-create-button"/);
  assert.doesNotMatch(html, /id="cap-skill-wizard"|id="cap-mcp-wizard"/);
  assert.match(html, /id="cap-skill-market-button"/);
  assert.match(html, /id="cap-skills-model-chips"/);
  assert.match(appSource, /openLocalRuntimeWorkbench\("resources", \{ resourceTab: "skills" \}\)/);
  assert.match(appSource, /openLocalRuntimeWorkbench\("resources", \{ resourceTab: "mcps" \}\)/);
  assert.match(css, /\.cap-skill-model-chips/);
  assert.match(css, /#config-surface-capabilities \.cap-skill-scope/);
  assert.match(css, /#cap-workspace-skills\[hidden\]/);
  assert.match(css, /#view-config \.config-surface-panel\[hidden\]/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]+#view-config \.config-topology-track/);
  assert.match(css, /@media \(max-width: 1000px\)[\s\S]+\.runtime-seat-layout[\s\S]+grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]+\.runtime-seat-field-grid[\s\S]+grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]+\.runtime-seat-form-actions[\s\S]+grid-template-columns: minmax\(0, 1fr\)/);
  // The page header owns target controls; settings navigation stays outside it.
  const toolbarBlock = html.match(/<header class="config-page-header">([\s\S]*?)<\/header>/);
  assert.ok(toolbarBlock, "配置图谱页头应有 config-toolbar 容器");
  assert.match(toolbarBlock[1], /class="config-toolbar"/);
  assert.match(toolbarBlock[1], /id="config-host-bar"/);
  assert.doesNotMatch(toolbarBlock[1], /config-topology-nav/, "settings navigation must not repeat inside the page");
  assert.doesNotMatch(html, /config-topology-link/, "流程箭头会暗示不存在的向导顺序，已随 segmented control 撤掉");
  assert.match(css, /#view-config \.config-toolbar\s*\{[\s\S]{0,220}position:\s*sticky/);
  assert.match(css, /#view-config \.config-topology-track\s*\{[\s\S]{0,320}overflow-x:\s*auto/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]+#view-config \.config-toolbar\s*\{[\s\S]{0,140}flex-direction:\s*column/);
  assert.match(css, /@media \(max-width: 560px\)\s*\{[\s\S]{0,220}#view-config \.config-topology-copy span\s*\{\s*display:\s*none/);
  assert.match(qaSource, /#cap-workspace-mcp-tab/);
  assert.match(qaSource, /#cap-workspace-mcp:not\(\[hidden\]\)/);
  assert.match(qaSource, /mainContent\.scrollWidth - mainContent\.clientWidth/);
  assert.match(qaSource, /main content horizontal overflow/);
  assert.match(qaSource, /CONTROL_CENTER_TOKEN:\s*qaToken/);
  assert.match(qaSource, /async function stopQaServer\(\)/);
  // 收尾顺序：browser → server → fixture 清理。第三段原为 resetFaultDomainFixtures()
  // （把 fixture 写回干净态给下一次运行复用），2026-09-05 改为 rm(fixtureRoot)：
  // 运行时 fixture 已移到 mkdtemp 临时目录，本次运行独占，整体删掉即可。
  // 断言守的是"顺序"这个意图，不是某个函数名的快照。
  assert.match(qaSource, /if \(browser\) await browser\.close\(\);[\s\S]+await stopQaServer\(\);[\s\S]+await rm\(fixtureRoot,/);
  // 运行时 fixture 必须在 mkdtemp 下，不能回到 .qa-output 的固定路径 ——
  // 那条路径已被 Codex 沙箱账户的 DACL 占住（icacls/Get-Acl/takeown 全被拒、
  // 连删都删不掉），固定路径一用就 EPERM，整套 QA 死在启动阶段。
  assert.match(qaSource, /const fixtureRoot = await mkdtemp\(join\(tmpdir\(\)/);
  assert.match(qaSource, /const dataRoot = resolve\(fixtureRoot,/);
  assert.match(qaSource, /const runtimeHome = resolve\(fixtureRoot,/);
  // 产物（png + report.json）反过来必须留在仓库内：它们是给人看的证据。
  assert.match(qaSource, /const outputRoot = resolve\(appRoot, "\.qa-output", "config-topology"\)/);
  assert.match(remoteQaSource, /data-config-surface="providers"[\s\S]{0,400}config-remote-provider-deck/);
  assert.match(remoteQaSource, /providerPlans/);
  assert.match(remoteQaSource, /teamPartialFailure/);
  assert.match(remoteQaSource, /sourceConflictPreservesDraft/);
  assert.match(remoteQaSource, /graphLatestWins/);
  assert.match(remoteQaSource, /width:\s*390,\s*height:\s*844/);
  assert.match(remoteQaSource, /await stopQaServer\(\)/);
  assert.doesNotMatch(css, /#view-capabilities/);

  assert.match(html, /data-config-surface="providers"[\s\S]{0,220}<span>连接档案<\/span>/);
  assert.doesNotMatch(html, /模型设置/);
  assert.match(html, /id="provider-query"/);
  assert.match(html, /id="provider-spine"[^>]+aria-label="关系脊柱"/);
  assert.match(html, /id="provider-save-enable-button"/);
  assert.match(html, /id="provider-save-button"[^>]*>仅保存/);
  assert.match(html, /id="provider-kimi-type"/);
  assert.match(html, /id="provider-openclaw-key"/);
  assert.match(html, /id="provider-hermes-api-mode"/);
  assert.match(html, /id="provider-gemini-extra-env"/);
  assert.match(appSource, /item\.models\?\.\[app\]\?\.model/);
  assert.match(appSource, /selected\.models\?\.\[app\]\?\.model/);
  assert.match(appSource, /liveStateLabel = "live 正在跑"/);
  assert.match(appSource, /ids\.has\(member\.runtimeProfileId\)/);
  assert.doesNotMatch(appSource, /runtimeProfileId \|\| member\.id/);
  assert.match(appSource, /data-runtime-seat-id=/);
  assert.match(appSource, /saveProviderForm\(event, \{ enable: true \}\)/);
  assert.match(appSource, /function collectProviderEnvLines\(/);
  assert.match(appSource, /providerDialogTargetApp === "kimi"/);
  assert.match(appSource, /openMemberConfigTarget\(\{ surface: "sources", runtimeProfileId: seatId \}\)/);
  assert.match(appSource, /!query && app === "codex" && !codexPresetAllowed/);
  assert.match(appSource, /远端钩子尚未接入/);
  assert.match(appSource, /hooksNode\.disabled = remoteTarget/);
  assert.match(stateSource, /selectedProviderId:\s*null/);
  assert.match(stateSource, /providerQuery:\s*""/);
  assert.match(appSource, /state\.selectedProviderId = rowSelect\.dataset\.providerRow/);
  assert.match(appSource, /state\.providerQuery = event\.target\.value/);
  assert.match(appSource, /class="provider-spine-chain"/);
  assert.match(css, /\.provider-bus \.provider-workspace \{\s*display:\s*grid/);
  assert.match(css, /@media \(max-width: 1280px\)[\s\S]+\.provider-bus \.provider-workspace/);
  assert.match(css, /@media \(max-width: 1000px\)[\s\S]+\.provider-bus \.provider-spine \{\s*position:\s*static/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]+\.provider-bus \.provider-row-actions/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]+\.provider-bus \.provider-row-list/);
  assert.doesNotMatch(css, /\.provider-row-actions \.icon-button:not\(:last-child\)\s*\{\s*display:\s*none/);
  assert.match(css, /Configuration bus[\s\S]+?#view-config \.config-toolbar\s*\{[\s\S]{0,700}backdrop-filter:\s*blur/);
  assert.match(css, /#view-config \.config-host-bar\s*\{[\s\S]{0,260}flex-wrap:\s*nowrap[\s\S]{0,260}overflow-x:\s*auto/);
  assert.match(css, /\.provider-workspace:not\(:has\(\.provider-spine:not\(\[hidden\]\)\)\)/);
  assert.match(css, /\.provider-row-list:has\(\.provider-row\)[\s\S]{0,260}gap:\s*0/);
  assert.match(css, /Configuration bus[\s\S]+?#config-surface-capabilities \.cap-overview\s*\{[\s\S]{0,240}overflow:\s*hidden/);
  assert.match(css, /@keyframes config-plane-arrive/);
  // 配置页 hero 必须是坐标条而不是编辑式着陆页（art-direction 的 is-settings 例外）。
  // 断言守的是**意图**不是快照值：原先写死 min-height:84px / clamp(30px,3.2vw,46px)，
  // v49 U1-a 把 heading 从实测 121.67px 压到 48px（min-height 归 0、h1 收敛回全局
  // clamp(22px,1.8vw,26px)、副标题全宽度收起——它逐字就是下方五个 tab 的枚举），
  // 那条快照式断言随即变红。压得更狠与它守的方向一致，所以改成：
  //   ① 例外块仍在（配置页不吃全局 clamp(150px,24vh,270px) 的 hero 高度）
  //   ② h1 不得超过全局 UI 档上限 26px（46px 的编辑大字在操作面换不来信息）
  assert.match(artDirectionCss, /\.app-shell\.is-settings #view-config\.view \.page-heading\.compact-heading\s*\{[\s\S]{0,200}min-height:\s*0;/);
  const configH1 = artDirectionCss.match(
    /\.app-shell\.is-settings #view-config\.view \.page-heading\.compact-heading h1\s*\{[\s\S]{0,200}?\}/,
  )?.[0];
  assert.ok(configH1, "配置页 h1 的例外规则不见了");
  const h1Max = configH1.match(/font-size:\s*clamp\([^,]+,[^,]+,\s*(\d+)px\)/)?.[1];
  assert.ok(h1Max && Number(h1Max) <= 26, `配置页 h1 上限 ${h1Max}px 超过全局 UI 档 26px —— 操作面不该有编辑式大字`);
});
