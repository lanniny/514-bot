import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { writeConfig } from "./retired-workbench-era/qa-ui-fixture.mjs";
import { spawnTestServer, stopTestServer, waitForUrl, testModelProfiles } from "../tests/server-fixture.mjs";

const output = resolve(process.argv.find((value) => value.startsWith("--output-dir="))?.slice(13) || resolve(tmpdir(), `514cc-plugins-qa-${Date.now()}`));
const serve = process.argv.includes("--serve");
const root = await mkdtemp(resolve(tmpdir(), "514cc-plugins-"));
const repo = resolve(root, "repo"), home = resolve(root, "home");
await mkdir(home); await mkdir(output, { recursive: true });
await writeConfig(repo, { profiles: testModelProfiles().map((profile) => ({ ...profile, command: profile.command == null ? null : resolve(home, "disabled-provider.exe"), capabilities: ["*"] })) });
const token = "project-plugins-isolated-fixture-0123456789abcdef";
const server = spawnTestServer({ env: { CONTROL_CENTER_TEST_REPO_ROOT: repo, CONTROL_CENTER_DATA_DIR: resolve(root, "data"), CONTROL_CENTER_RUNTIME_HOME: home, HOME: home, USERPROFILE: home, CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_PORT: "0", GROK_SEARCH_RS_COMPAT_API_URL: "", GROK_SEARCH_RS_COMPAT_API_KEY: "", GROK_SEARCH_RS_COMPAT_MODEL: "" } });
let browser;
let page;
const report = { ok: false, boundary: "isolated local server; providers disabled; no user CLI config modified", checks: [], layouts: [], errors: [] };
// D-2026-09-28-039：Bot 面「运行配置」入口按面分裂，抽成共用助手。
//   默认 grok 面：bot-grok-face.css 把 .bot-roster-footer .bot-icon-button 整组 display:none，
//     可见入口是图标轨道那颗「设置」（.bot-icon-rail）。
//   工作台面（html:not(.is-bot-grok-face)）：整条 .bot-icon-rail display:none，
//     可见入口回到 roster-footer 的 [data-bot-config-open="local-runtime"]。
// bot-grok-face.js:140 handleRail("settings") 再程序化点击被藏起来的 footer 钮，
// 两条路最终都汇到 app.js:29177 的 botOpenWorkspace("local-runtime")；而 botOpenWorkspace
// 对 local-runtime/capabilities/hooks 是 setView("config"), 并不打开 #bot-workspace-panel。
// 谁真的可见就点谁——固定点某一颗，在另一张脸上就是 30s 的 not-visible 超时。
async function openBotRuntimeConfig(targetPage) {
  const entry = await targetPage.evaluate(() => {
    for (const selector of ['[data-bot-rail="settings"]', '.bot-roster-footer [data-bot-config-open="local-runtime"]']) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (node.getBoundingClientRect().width <= 0) continue;
      return selector;
    }
    return null;
  });
  assert.ok(entry, "Bot 面找不到可见的「运行配置」入口（图标轨道与 roster-footer 均不可见）");
  console.log("[project-plugins] config entry:", entry);
  await targetPage.locator(entry).click();
  await targetPage.waitForFunction(() => document.getElementById("config-surface-local-runtime")?.closest("#view-config.is-active") && !document.getElementById("config-surface-local-runtime").hidden, null, { timeout: 15_000 });
}

try {
  const origin = new URL(await waitForUrl(server)).origin;
  const call = async (path, method = "GET", payload) => {
    const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const value = await response.json(); assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`); return value;
  };
  const project = (await call("/api/projects", "POST", { cwd: repo, title: "产品协作工作台" })).project;
  const secondDir = resolve(root, "second-project"); await mkdir(secondDir);
  const other = (await call("/api/projects", "POST", { cwd: secondDir, title: "独立验证项目" })).project;
  const conversation = (await call("/api/conversations", "POST", { kind: "workspace_group", title: "统一体验与交付", projectId: project.projectId, roomRole: "task", memberIds: ["claude-fable", "codex-technical"] })).conversation;
  const route = `#bot?conversation=${conversation.id}&tab=conversation`;
  report.origin = origin; report.projectId = project.projectId; report.conversationId = conversation.id;
  if (serve) {
    for (const catalogId of ["project-context", "delivery-review", "project-overview"]) {
      const before = await call("/api/plugins");
      await call("/api/plugins/install", "POST", { catalogId, expectedRevision: before.revision });
      await call("/api/plugins/configure", "POST", { projectId: project.projectId, pluginId: catalogId, enabled: true, expectedRevision: before.revision + 1 });
    }
    process.stdout.write(`Preview: ${origin}/${route}\nFixture: ${root}\n`);
    await new Promise((done) => { process.once("SIGINT", done); process.once("SIGTERM", done); server.once("exit", done); });
  } else {
    const check = (label) => { report.checks.push(label); process.stdout.write(`PASS ${label}\n`); };
    assert.equal((await fetch(`${origin}/api/plugins`)).status, 401);
    assert.equal((await fetch(`${origin}/api/plugins/install`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    check("anonymous plugin access rejected");
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.addInitScript((value) => sessionStorage.setItem("514cc-control-token", value), token);
    // D-2026-09-28-029：首跑导览对话框会全屏拦截 pointer 事件——Playwright 报
    //「<html> intercepts pointer events」，元素本身可见、有高度、无隐藏祖先也不动不了。
    // D-018 那次批量补了约 30 个脚本，漏了这一条。
    await page.addInitScript(() => { try { localStorage.setItem("514cc-product-tour-dismissed", "1"); } catch {} });
    await page.goto(`${origin}/${route}`);
    await page.waitForFunction(() => document.getElementById("bot-conversation-title")?.textContent === "统一体验与交付");
    await page.evaluate(() => { location.hash = '#plugins'; });
await page.waitForFunction(() => document.querySelector('#view-plugins')?.classList?.contains('is-active') === true, null, { timeout: 15_000 });
    await page.locator('[data-plugin-tab="catalog"]').click();
    for (const id of ["project-context", "delivery-review", "project-overview"]) {
      const row = page.locator(`[data-plugin-id="${id}"]`);
      await row.getByRole("button", { name: "安装插件", exact: true }).click();
      await row.getByText("已安装", { exact: true }).waitFor();
    }
    await page.locator('[data-plugin-tab="installed"]').click();
    await page.locator("[data-plugin-project]").selectOption(project.projectId);
    for (const id of ["project-context", "delivery-review", "project-overview"]) {
      await Promise.all([page.waitForResponse((response) => response.url().endsWith("/api/plugins/configure") && response.request().method() === "POST"), page.locator(`[data-plugin-id="${id}"] .plugin-toggle input`).check()]);
      await page.waitForFunction(() => !document.querySelector("[data-plugin-project]").disabled);
    }
    let config = page.locator('[data-plugin-id="delivery-review"]');
    await config.getByRole("button", { name: "查看与配置", exact: true }).click();
    const drawer = page.locator("[data-drawer]");
    await drawer.getByLabel("审查重点").selectOption("用户体验");
    await drawer.getByLabel("验收要求").fill("保留草稿并验证真实页面");
    await page.locator("[data-drawer-done]").click();
    await page.locator("[data-plugin-project]").selectOption(other.projectId);
    await page.locator("[data-plugin-project]").selectOption(project.projectId);
    config = page.locator('[data-plugin-id="delivery-review"]');
    await config.getByRole("button", { name: "查看与配置", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-drawer] input[name="acceptance"]')?.value === "保留草稿并验证真实页面");
    assert.equal(await drawer.getByLabel("审查重点").inputValue(), "用户体验");
    await Promise.all([page.waitForResponse((response) => response.url().endsWith("/api/plugins/configure") && response.request().method() === "POST"), drawer.getByRole("button", { name: "保存并应用", exact: true }).click()]);
    await page.waitForFunction(() => !document.querySelector("[data-plugin-project]").disabled);
    await page.locator("[data-drawer-done]").click();
    let data = await call(`/api/plugins?projectId=${project.projectId}`);
    assert.equal(data.bindings.filter((entry) => entry.enabled).length, 3);
    assert.equal(data.bindings.find((entry) => entry.pluginId === "delivery-review").config.focus, "用户体验");
    assert.deepEqual((await call(`/api/plugins?projectId=${other.projectId}`)).bindings, []);
    await page.reload();
    await page.locator("[data-plugin-list] .plugin-card").first().waitFor();
    await page.locator("[data-plugin-project]").selectOption(project.projectId);
    await page.waitForFunction(() => document.querySelectorAll(".plugin-toggle input:checked").length === 3);
    check("UI installs all contribution types and persists project configuration");
    await page.screenshot({ path: resolve(output, "plugins-desktop.png") });
    // D-2026-09-28-039：回 Bot 面必须走**会话深链**，不能写裸 #bot。
    // 裸 hash 绕过 setView 的 workspaceRoute 保留逻辑（app.js:3737 会读
    // readBotWorkspaceRoute(location.hash) 把深链带给 botWorkspace.activate），
    // 全局 hashchange 改按"无参路由"重放 → 落回默认成员的私聊。实测那一刻
    // title:"Fable"、activeRow:null——群会话被换掉，projectId 随之消失，
    // project-plugins-panel.js:793 第一道门静默降级成 #plugins。QA 干等 15s 超时，
    // 把"自己导航丢了会话"伪装成产品缺陷。附带把会话标题钉进等待条件：
    // 再丢就不会以超时形式出现，而是当场报出标题不符。
    await page.evaluate((target) => { location.hash = target; }, route);
await page.waitForFunction(() => document.querySelector('#view-bot')?.classList?.contains('is-active') === true && document.getElementById('bot-conversation-title')?.textContent === "统一体验与交付", null, { timeout: 15_000 });
    await page.locator("#bot-composer-input").fill("保留这段草稿");
    await page.locator("#bot-composer-input").dispatchEvent("input");
    // D-2026-09-28-029：产品有**两个** [data-project-plugins] 入口（index.html:504 会话头 /
    // :698 agent 面板头），project-plugins-panel.js:963 用 closest 统一处理，两者都是有意设置。
    // 裸选择器触发 Playwright strict mode violation；限定到 .bot-conversation-header 内的那个
    // ——本步验的是"会话内能打开插件面板"。（注意：不是 .bot-conversation-actions，那个 div
    // 在 :502 行就闭合了，两个按钮是它的兄弟。）
    // D-2026-09-28-039 取证：open() 有两个静默降级点（:792 无 projectId 转身走人 /
    // :812 installed 里找不到 binding 对应插件时 continue）。两者都不弹提示，最终都表现为
    // "面板空的"。点下去之前先把当时的工作面状态打出来——对话框没打开时，靠它分辨
    // 是哪一道门：会话还在（title 正确 + 行高亮）却走了 #plugins，就是第一道门。
    const pluginGate = await page.evaluate(() => ({
      route: location.hash,
      botActive: Boolean(document.getElementById("view-bot")?.classList.contains("is-active")),
      title: document.getElementById("bot-conversation-title")?.textContent ?? null,
      headerEntry: Boolean(document.querySelector(".bot-conversation-header [data-project-plugins]")),
      activeRow: document.querySelector("[data-bot-conversation].is-active")?.getAttribute("data-bot-conversation") ?? null,
      composerValue: document.getElementById("bot-composer-input")?.value ?? null,
    }));
    console.log("[project-plugins] gate before open:", JSON.stringify(pluginGate));
    await page.locator(".bot-conversation-header [data-project-plugins]").click();
    // D-2026-09-28-035：open() 有两处静默降级（project-plugins-panel.js:792-793 无 projectId 时
    // navigate 走人；:812-813 installed 里找不到 binding 对应插件时 continue 跳过）。两处都不弹提示，
    // 用户与 QA 看到的都是"面板空的"。所以在点具体 contribution 之前，先咬住降级点本身：
    // 对话框必须真的打开，且至少要渲染出一个 contribution 按钮。否则失败信息会指明
    // 降级发生在哪一层，而不是干等某个按钮名 30s。
    // D-2026-09-28-039：选择器从 [data-plugin-dialog] 改回 #project-plugin-dialog——
    // index.html 里这个 dialog 只有 id（含 data-plugin-dialog-status / data-plugin-workspace
    // 两个子属性），**没有** data-plugin-dialog 属性。裸属性选择器恒返回 null，
    // `dialog?.open` 恒为 undefined → 这条"降级点断言"永远不可能通过，
    // 把真实失败换成了 15s 超时。写断言前先证明选择器在 DOM 里存在。
    await page.waitForFunction(() => {
      const dialog = document.getElementById("project-plugin-dialog");
      return Boolean(dialog?.open) && [...dialog.querySelectorAll("button")].some((b) => (b.textContent || "").trim().length > 0);
    }, null, { timeout: 15_000 });
    const dialogButtons = await page.evaluate(() => {
      const dialog = document.getElementById("project-plugin-dialog");
      return dialog ? [...dialog.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean) : [];
    });
    console.log("[project-plugins] dialog contribution buttons:", JSON.stringify(dialogButtons));
    await page.getByRole("button", { name: "读取项目概要", exact: true }).click();
    await page.locator(".plugin-data-panel").first().waitFor();
    assert.match(await page.locator(".plugin-data-panel").first().textContent(), /产品协作工作台/);
    await page.getByRole("button", { name: "项目概览", exact: true }).click();
    await page.getByRole("button", { name: "最近运行", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".plugin-data-panel").length === 3);
    await page.screenshot({ path: resolve(output, "plugin-panels-desktop.png") });
    await page.getByRole("button", { name: "准备交付审查", exact: true }).click();
    await page.waitForFunction(() => !document.getElementById("project-plugin-dialog").open);
    const draft = await page.locator("#bot-composer-input").inputValue();
    assert.match(draft, /^保留这段草稿/); assert.match(draft, /用户体验/); assert.match(draft, /保留草稿并验证真实页面/);
    check("tools and panels execute against real project data; workflow preserves the owned draft");
    // D-2026-09-28-039：Bot 面打开"运行配置"的入口**按面分裂**，不是一处：
    //   默认 grok 面 —— bot-grok-face.css 把 .bot-roster-footer .bot-icon-button 整组
    //     display:none，可见入口是图标轨道那颗「设置」（.bot-icon-rail）；
    //   工作台面（html:not(.is-bot-grok-face)）—— 整条 .bot-icon-rail display:none，
    //     可见入口回到 roster-footer 那颗 [data-bot-config-open="local-runtime"]。
    // bot-grok-face.js:140 handleRail("settings") 再程序化点击被藏起来的 footer 钮，
    // 两条路最终都汇到 app.js:29177 的 botOpenWorkspace("local-runtime")。
    // 原先裸点 footer 钮，在默认面（本脚本跑的就是默认面）下它 display:none，
    // Playwright 报「element is not visible」重试 30s 超时。
    await openBotRuntimeConfig(page);
    // D-2026-09-28-039：local-runtime / capabilities / hooks 这三个"配置面"**不经过**
    // #bot-workspace-panel——app.js:20725-20728 的 botOpenWorkspace 对它们直接
    // setView("config", { configSurface })，只有 tab === "seats" 才打开 bot 工作台面板。
    // 原脚本等 `#bot-workspace-panel.hidden === false`，对这些面永远不成立（15s 超时），
    // 而页面其实早就跳到了 #config/local-runtime。真正该等的是下面的配置面本身。
    for (const surface of ["local-runtime", "capabilities", "hooks", "sources"]) {
      await page.evaluate((surface) => { location.hash = `#config/${surface}`; }, surface);
      // D-2026-09-28-039：判定条件 = 「该配置面真的活过来了」：节点在 #view-config.is-active
      // 之下、hidden 已摘、有高度。三缺一就是「路由到了但面没渲染」。
      await page.waitForFunction((id) => {
        const node = document.getElementById(`config-surface-${id}`);
        return Boolean(node?.closest("#view-config.is-active")) && !node.hidden && node.getBoundingClientRect().height > 0;
      }, surface, { timeout: 15_000 });
      assert.equal(await page.locator("#bot-workspace-panel").isVisible(), false);
      await page.screenshot({ path: resolve(output, `bot-config-${surface}.png`) });
    }
    await page.evaluate(() => { location.hash = '#automations'; });
await page.waitForFunction(() => document.querySelector('#view-automations')?.classList?.contains('is-active') === true, null, { timeout: 15_000 });
    await page.waitForSelector('#view-automations.is-active #automations-workbench');
    assert.equal(await page.locator('#view-workbench').isVisible(), false);
    assert.equal(await page.locator('#automations-workbench').evaluate((node) => node.parentElement.id), 'view-automations');
    // D-2026-09-28-039：同上——返回 Bot 面走会话深链，"草稿保住了"这句话只有落在
    // 同一个群会话上才是真的（裸 #bot 会把会话换成默认成员私聊，草稿在同一个
    // textarea 里照样读得到，断言会假绿）。
    await page.evaluate((target) => { location.hash = target; }, route);
await page.waitForFunction(() => document.querySelector('#view-bot')?.classList?.contains('is-active') === true && document.getElementById('bot-conversation-title')?.textContent === "统一体验与交付", null, { timeout: 15_000 });
    assert.equal(await page.locator("#bot-composer-input").inputValue(), draft);
    check("domain pages retain their own roots and Bot navigation preserves the conversation draft");
    await call("/api/ccswitch/domain/skills", "POST", { name: "recovery-qa", files: { "SKILL.md": "# Recovery fixture\n" }, apps: {} });
    const journalRoot = resolve(root, "data/ccswitch/skill-transactions");
    const journalName = (await readdir(journalRoot)).find((name) => name.endsWith(".json"));
    const journalPath = resolve(journalRoot, journalName);
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    await writeFile(journalPath, JSON.stringify({ ...journal, phase: "pending" }));
    await openBotRuntimeConfig(page);
    await page.locator('[data-ccs-action="refresh"]').first().click();
    await page.locator('[data-ccs-tab="resources"]').click();
    await page.locator('[data-ccs-resource-tab="skills"]').click();
    await page.locator(`[data-ccs-recovery-check="${journal.id}"]`).click();
    await page.locator(`[data-ccs-recovery-confirm="${journal.id}"]`).click();
    await page.locator("#action-dialog[open]").waitFor();
    await page.screenshot({ path: resolve(output, "skill-recovery-confirmation.png") });
    await page.locator("#dialog-confirm-button").click();
    await page.waitForFunction(() => !document.querySelector("[data-ccs-recovery-check]"));
    assert.equal(JSON.parse(await readFile(journalPath, "utf8")).recovery.mode, "record-only");
    assert.equal(await readFile(resolve(root, "data/ccswitch/skills/recovery-qa/SKILL.md"), "utf8"), "# Recovery fixture\n");
    assert.equal((await call("/api/ccswitch/domain")).recovery.items.length, 0);
    await page.evaluate(() => { location.hash = '#bot'; });
await page.waitForFunction(() => document.querySelector('#view-bot')?.classList?.contains('is-active') === true, null, { timeout: 15_000 });
    check("Skill recovery checks and confirms an injected pending journal through the UI without rewriting live files");
    const run = await call("/api/runs", "POST", { prompt: "插件快照验证", execute: false, permissionMode: "plan", conversationId: conversation.id, conversationKind: conversation.kind, orchestrationMode: "social", startAgentId: "claude-fable", ephemeralTeam: { name: "QA", coordinator: "claude-fable", members: ["claude-fable", "codex-technical"], skills: [], mcp: [], providers: {} } });
    assert.equal(run.projectPlugins.length, 3);
    assert.equal(run.projectId, project.projectId);
    data = await call(`/api/plugins?projectId=${project.projectId}`);
    await call("/api/plugins/configure", "POST", { pluginId: "project-context", projectId: project.projectId, enabled: false, expectedRevision: data.revision });
    const revoked = await fetch(`${origin}/api/plugins/execute`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ pluginId: "project-context", projectId: project.projectId, contributionId: "project", type: "tools" }) });
    assert.equal(revoked.status, 409);
    assert.equal(run.projectPlugins.length, 3);
    check("Run snapshots retain installed versions while disabling blocks subsequent tools");
    for (const theme of ["light", "dark"]) for (const width of [1440, 1024, 820, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.evaluate((value) => { localStorage.setItem("514cc-control-theme", value); localStorage.setItem("514cc-motion", "reduce"); document.documentElement.dataset.theme = value; document.documentElement.dataset.motion = "reduce"; }, theme);
      await page.goto(`${origin}/#experience?conversation=${conversation.id}&tab=conversation`);
      await page.waitForFunction(() => location.hash.startsWith("#bot?") && document.getElementById("view-bot")?.classList.contains("is-active") && document.getElementById("bot-conversation-title")?.textContent === "统一体验与交付");
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      const layout = await page.evaluate(() => {
        const input = document.getElementById("bot-composer-input").getBoundingClientRect();
        return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, input: { x: input.x, right: input.right, bottom: input.bottom, height: input.height }, sidebarInert: document.getElementById("sidebar").inert };
      });
      assert.equal(layout.overflow, false); assert.ok(layout.input.height > 0); assert.ok(layout.input.right <= width + 1); assert.ok(layout.input.bottom <= (width === 390 ? 844 : 900));
      // D-2026-09-28-039：侧栏在 2026-09-28-032 改成「全尺寸按需抽屉」后，inert 跟随的是
      // **抽屉开合**（.app-shell.nav-open），不再是视口断点——桌面默认收起，于是
      // #sidebar.inert 在 1440/1024 也是 true。原断言 width<=820 是按「桌面常驻侧栏」
      // 时代的模型写的，现在恒假。改成语义正确的等价式：inert 必须与抽屉状态严格一致。
      // （抽屉能不能打开由 qa-pm-walk 的汉堡断言负责，那是另一个契约。）
      // 不断言「默认收起」：≤820 的轮次里上一段刚点开抽屉导航去 #plugins，
      // 此时 nav-open 为真是预期状态；默认收起与 resize 自动收拢由别处契约负责。
      const navOpen = await page.evaluate(() => Boolean(document.querySelector(".app-shell")?.classList.contains("nav-open")));
      assert.equal(layout.sidebarInert, !navOpen, `#sidebar.inert（${layout.sidebarInert}）必须与抽屉开合（nav-open=${navOpen}）相反`);
      report.layouts.push({ theme, ...layout });
      await page.screenshot({ path: resolve(output, `bot-${theme}-${width}.png`) });
      if (width <= 820) {
        // D-2026-09-28-039：抽屉可能被上一轮（更小断点）点开后就那么开着。开着时
        // syncNavAccessibility（app.js:29126）会把整条 topbar 置 inert——模态焦阱设计，
        // 那颗汉堡在抽屉展开期间故意不可点（关闭走背板/Escape，焦点由 setNavDrawer 还回）。
        // 所以只在关着的时候点；开着就沿用现状，本步要的只是「导航可达」。
        const drawerOpen = await page.evaluate(() => Boolean(document.querySelector(".app-shell")?.classList.contains("nav-open")));
        if (!drawerOpen) await page.locator("#mobile-menu-button").click();
        await page.evaluate(() => { location.hash = '#plugins'; });
        await page.waitForFunction(() => document.querySelector('#view-plugins')?.classList?.contains('is-active') === true, null, { timeout: 15_000 }); }
      else await page.evaluate(() => { location.hash = '#plugins'; });
await page.waitForFunction(() => document.querySelector('#view-plugins')?.classList?.contains('is-active') === true, null, { timeout: 15_000 });
      await page.locator("[data-plugin-list] .plugin-card").first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: resolve(output, `plugins-${theme}-${width}.png`) });
    }
    check("eight theme and viewport layouts retain navigation, legacy URL migration and usable content");
    await page.setViewportSize({ width: 820, height: 900 });
    // D-2026-09-28-039：同上——抽屉已开着就别点（topbar 处于 inert，点必超时）。
    const drawerOpenAt820 = await page.evaluate(() => Boolean(document.querySelector(".app-shell")?.classList.contains("nav-open")));
    if (!drawerOpenAt820) await page.locator("#mobile-menu-button").click();
    await page.setViewportSize({ width: 1440, height: 900 });
    // 侧栏已改移动抽屉（桌面无常驻侧栏）：桌面 resize 后抽屉必须自动收起——
    // 原「focus 侧栏项再 Tab」断言针对已退役的桌面常驻侧栏，改为只验收起语义。
    assert.equal(await page.evaluate(() => document.querySelector(".app-shell").classList.contains("nav-open")), false);
    await page.locator("[data-plugin-project]").selectOption(project.projectId);
    await page.waitForFunction(() => document.querySelectorAll(".plugin-card").length === 3);
    const toggle = page.locator('[data-plugin-id="project-context"] .plugin-toggle input');
    await toggle.focus(); await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector("[data-plugin-output]").textContent === "已保存");
    await page.waitForFunction(() => document.activeElement?.matches('[data-plugin-id="project-context"] .plugin-toggle input'));
    await page.route("**/api/plugins?*", (route) => route.abort("failed"));
    await toggle.click();
    await page.getByText("配置已保存，但列表刷新失败。请刷新后查看。", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-plugin-project]").isDisabled(), false);
    await page.unroute("**/api/plugins?*");
    await page.locator("[data-plugin-refresh]").click();
    await page.waitForFunction(() => document.querySelectorAll(".plugin-card").length === 3);
    check("keyboard focus survives mutations and viewport changes; post-save refresh failure stays actionable");
    const importPath = resolve(root, "local-plugin.json");
    await writeFile(importPath, JSON.stringify({ schema: "514cc.plugin/v1", id: "custom-review", name: "自定义检查", version: "1.0.0", description: "项目验收检查", workflows: [{ id: "check", name: "准备检查", prompt: "核对当前项目的验收证据。" }] }));
    await page.locator("[data-plugin-file]").setInputFiles(importPath);
    await page.locator("#action-dialog[open]").waitFor();
    assert.match(await page.locator("#dialog-body").textContent(), /安装后需要按项目启用/);
    await page.locator("#dialog-confirm-button").click();
    await page.locator('[data-plugin-id="custom-review"]').waitFor();
    await page.locator('[data-plugin-id="custom-review"]').getByRole("button", { name: "查看与配置", exact: true }).click();
    await page.locator("[data-drawer-uninstall]").click();
    await page.locator("#action-dialog[open]").waitFor();
    await page.locator("#dialog-confirm-button").click();
    await page.waitForFunction(() => !document.querySelector('[data-plugin-id="custom-review"]'));
    check("local JSON import and confirmed uninstall use the real plugin lifecycle");
    assert.deepEqual(report.errors, []); report.ok = true;
  }
} catch (error) { report.failure = error.stack; if (page) { await page.screenshot({ path: resolve(output, "failure.png") }); report.page = await page.evaluate(() => ({ text: document.body.innerText.slice(-7000), route: location.hash })); } process.stderr.write(`${error.stack}\n`); process.exitCode = 1; }
finally {
  await browser?.close();
  await stopTestServer(server, { token });
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
