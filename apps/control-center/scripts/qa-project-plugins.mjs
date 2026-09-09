import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { writeConfig } from "./qa-ui-fixture.mjs";
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
    await page.goto(`${origin}/${route}`);
    await page.waitForFunction(() => document.getElementById("bot-conversation-title")?.textContent === "统一体验与交付");
    await page.locator('#sidebar [data-view="plugins"]').click();
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
    await page.locator('#sidebar [data-view="bot"]').click();
    await page.locator("#bot-composer-input").fill("保留这段草稿");
    await page.locator("#bot-composer-input").dispatchEvent("input");
    await page.locator("[data-project-plugins]").click();
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
    await page.locator('.bot-roster-footer [data-bot-config-open="local-runtime"]').click();
    for (const surface of ["local-runtime", "capabilities", "hooks", "sources"]) {
      await page.evaluate((surface) => { location.hash = `#config/${surface}`; }, surface);
      await page.waitForFunction((id) => { const node = document.getElementById(`config-surface-${id}`); return node?.closest("#view-config.is-active") && !node.hidden && node.getBoundingClientRect().height > 0; }, surface);
      assert.equal(await page.locator("#bot-workspace-panel").isVisible(), false);
      await page.screenshot({ path: resolve(output, `bot-config-${surface}.png`) });
    }
    await page.locator('#sidebar [data-view="automations"]').click();
    await page.waitForSelector('#view-automations.is-active #automations-workbench');
    assert.equal(await page.locator('#view-workbench').isVisible(), false);
    assert.equal(await page.locator('#automations-workbench').evaluate((node) => node.parentElement.id), 'view-automations');
    await page.locator('#sidebar [data-view="bot"]').click();
    assert.equal(await page.locator("#bot-composer-input").inputValue(), draft);
    check("domain pages retain their own roots and Bot navigation preserves the conversation draft");
    await call("/api/ccswitch/domain/skills", "POST", { name: "recovery-qa", files: { "SKILL.md": "# Recovery fixture\n" }, apps: {} });
    const journalRoot = resolve(root, "data/ccswitch/skill-transactions");
    const journalName = (await readdir(journalRoot)).find((name) => name.endsWith(".json"));
    const journalPath = resolve(journalRoot, journalName);
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    await writeFile(journalPath, JSON.stringify({ ...journal, phase: "pending" }));
    await page.locator('.bot-roster-footer [data-bot-config-open="local-runtime"]').click();
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
    await page.locator('#sidebar [data-view="bot"]').click();
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
      assert.equal(layout.sidebarInert, width <= 820);
      report.layouts.push({ theme, ...layout });
      await page.screenshot({ path: resolve(output, `bot-${theme}-${width}.png`) });
      if (width <= 820) { await page.locator("#mobile-menu-button").click(); await page.locator('#sidebar [data-view="plugins"]').click(); }
      else await page.locator('#sidebar [data-view="plugins"]').click();
      await page.locator("[data-plugin-list] .plugin-card").first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: resolve(output, `plugins-${theme}-${width}.png`) });
    }
    check("eight theme and viewport layouts retain navigation, legacy URL migration and usable content");
    await page.setViewportSize({ width: 820, height: 900 });
    await page.locator("#mobile-menu-button").click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#sidebar [data-view="security"]').focus(); await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.matches('#sidebar [data-view="bot"]')), false);
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
