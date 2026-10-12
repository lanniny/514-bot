// Real browser + isolated persistent stores. No model calls: every execution
// profile points to a missing binary. Creation is verified before a separate
// recovery probe submits one message to that missing runtime (no real provider).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const token = "assistant-start-isolated-qa-token";
const root = await mkdtemp(resolve(tmpdir(), "514cc-assistant-start-"));
const repoRoot = resolve(root, "repo");
const runtimeRoot = resolve(root, "runtime");
const dataRoot = resolve(root, "data");
await mkdir(resolve(repoRoot, "config/control-center"), { recursive: true });
await mkdir(runtimeRoot, { recursive: true });
await mkdir(resolve(appRoot, ".qa-output"), { recursive: true });
const output = await mkdtemp(resolve(appRoot, ".qa-output/assistant-start-"));
const saveConfig = (name, value) => writeFile(resolve(repoRoot, `config/control-center/${name}.json`), JSON.stringify(value));
await saveConfig("models", { version: 1, profiles: testModelProfiles().map((profile, index) => ({ ...profile, command: `missing-assistant-qa-${index}` })) });
await saveConfig("routing", { version: 1, primaryCoordinator: "claude-fable", technicalExecutor: "codex-technical", maxRounds: 6, maxDepth: 2, maxParallelAgents: 4, requireHealthyProvider: false, failOnUnavailableExplicitProvider: false, weights: { quality: .44, speed: .26, health: .22, cost: .08 }, rules: [], independentPass: { requiredFor: [], mustDifferFromPrimary: true } });
await saveConfig("permissions", { version: 1, defaultMode: "plan", modes: { plan: { write: false, approvalRequired: false }, build: { write: "workspace", approvalRequired: true } }, limits: { maxRounds: 6, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 10000 }, approval: { ttlMs: 60000 } });
await saveConfig("sources", { version: 1, explicit: ["models", "routing", "permissions", "sources"].map((name) => ({ id: `control.${name}`, path: `config/control-center/${name}.json`, label: name, kind: "json", scope: "repo", critical: true })), discover: [], runtime: [] });
const child = spawnTestServer({ env: {
  CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_PORT: "0", CONTROL_CENTER_DATA_DIR: dataRoot,
  CONTROL_CENTER_REPO_ROOT: repoRoot, CONTROL_CENTER_TEST_REPO_ROOT: repoRoot,
  CONTROL_CENTER_RUNTIME_HOME: runtimeRoot,
} });
let browser;
let page;
const report = { ok: false, productionExecution: false, checks: [], screenshots: [], errors: [] };
try {
  const origin = new URL(await waitForUrl(child)).origin;
  const api = async (path) => {
    const response = await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.ok, true);
    return response.json();
  };
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.addInitScript((value) => {
    sessionStorage.setItem("514cc-control-token", value);
    localStorage.setItem("514cc-product-tour-dismissed", "1");
    localStorage.setItem("514cc-bot-ops-collapsed", "1");
  }, token);
  await page.goto(`${origin}/#bot`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok"), null, { timeout: 30000 });
  await page.locator(".assistant-home [data-assistant-start]").waitFor({ state: "visible", timeout: 20000 });
  await page.locator(".assistant-home .readiness-card:not(.is-loading)").waitFor({ state: "attached", timeout: 20000 });
  const shot = async (name) => { await page.screenshot({ path: resolve(output, `${name}.png`) }); report.screenshots.push(`${name}.png`); };
  await shot("home-desktop");
  await page.locator(".assistant-readiness > summary").click();
  await page.locator(".assistant-readiness [data-readiness-step]").first().waitFor({ state: "visible" });
  await shot("home-readiness-expanded");
  await page.locator(".assistant-readiness > summary").click();
  report.checks.push("readiness-details-expand-with-real-actions");
  const dialog = page.locator("#assistant-start-dialog");
  const open = async () => {
    if (!await page.locator("#bot-new-conversation-button").isVisible()) await page.locator("#bot-mobile-back").click();
    await page.locator("#bot-new-conversation-button").click();
    await dialog.waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("[data-assistant-create]").disabled);
  };
  const create = async (name) => {
    await open();
    await dialog.locator("[data-assistant-title]").fill(name);
    await dialog.locator("[data-assistant-create]").click();
    await dialog.waitFor({ state: "hidden" });
    const item = (await api("/api/conversations")).conversations.find((conversation) => conversation.title === name);
    assert.ok(item);
    assert.equal(item.scope, "global");
    assert.equal(item.projectId, null);
    await page.waitForFunction((id) => document.querySelector(`[data-bot-conversation="${id}"]`)?.classList.contains("is-active"), item.id);
    return item;
  };
  const a = await create("第一段独立对话");
  const input = page.locator("#bot-composer-input");
  await input.fill("A 的未发送草稿 <不要丢>");
  const b = await create("第二段独立对话");
  assert.notEqual(a.id, b.id);
  assert.equal(await input.inputValue(), "");
  await input.fill("B 的草稿");
  await page.locator(`[data-bot-conversation="${a.id}"]`).click();
  assert.equal(await input.inputValue(), "A 的未发送草稿 <不要丢>");
  report.checks.push("new-global-conversation-without-project", "separate-history-and-drafts");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction((id) => document.querySelector(`[data-bot-conversation="${id}"]`)?.classList.contains("is-active"), a.id, { timeout: 30000 });
  assert.equal(await input.inputValue(), "A 的未发送草稿 <不要丢>");
  report.checks.push("reload-restores-draft-and-selection");

  const endpoint = "**/api/conversations";
  await page.route(endpoint, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "QA_DENIED", message: "测试：此助手暂不可用" } }) });
  });
  await open();
  await dialog.locator("[data-assistant-create]").click();
  await dialog.locator("[data-assistant-status]").filter({ hasText: "暂不可用" }).waitFor();
  assert.equal(await input.inputValue(), "A 的未发送草稿 <不要丢>");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#bot-new-conversation-button").evaluate((node) => node === document.activeElement), true);
  await page.unroute(endpoint);
  report.checks.push("rejection-retains-draft-and-escape-restores-focus");

  let release;
  let received;
  const intercepted = new Promise((done) => { received = done; });
  const gate = new Promise((done) => { release = done; });
  let createRequests = 0;
  await page.route(endpoint, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    createRequests++;
    const response = await route.fetch();
    received();
    await gate;
    await route.fulfill({ response });
  });
  await open();
  await dialog.locator("[data-assistant-title]").fill("迟到的创建结果");
  await dialog.locator("[data-assistant-create]").click();
  await intercepted;
  assert.equal(await dialog.locator("[data-assistant-create]").isDisabled(), true);
  await page.keyboard.press("Escape");
  await page.locator(`[data-bot-conversation="${b.id}"]`).click();
  release();
  await page.waitForFunction(() => [...document.querySelectorAll("[data-bot-conversation]")].some((node) => node.textContent.includes("迟到的创建结果")));
  assert.equal(await input.inputValue(), "B 的草稿");
  assert.equal(await page.locator(`[data-bot-conversation="${b.id}"]`).evaluate((node) => node.classList.contains("is-active")), true);
  assert.equal(createRequests, 1);
  await page.unroute(endpoint);
  report.checks.push("late-created-receipt-does-not-steal-selection", "duplicate-submit-disabled");

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await open();
    await shot(`new-conversation-${width}`);
    const geometry = await dialog.evaluate((node) => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: innerWidth, overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth, background: getComputedStyle(node).backgroundColor }));
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.width && geometry.overflow <= 1, JSON.stringify(geometry));
    assert.notEqual(geometry.background, "rgba(0, 0, 0, 0)");
    await page.keyboard.press("Escape");
  }
  report.checks.push("desktop-tablet-mobile-dialog-layout");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#theme-toggle").click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await open();
  await shot("new-conversation-dark");
  const keyboardTargets = new Set();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    const focus = await dialog.evaluate((node) => ({
      id: document.activeElement.id,
      inside: node.contains(document.activeElement),
      // Native Chromium dialogs allow Tab into browser chrome, represented by
      // BODY as activeElement, but must never focus application controls behind.
      browser: document.activeElement === document.body,
    }));
    assert.ok(focus.inside || focus.browser, JSON.stringify(focus));
    keyboardTargets.add(focus.id);
  }
  assert.ok(keyboardTargets.has("assistant-start-member") && keyboardTargets.has("assistant-start-name"));
  await page.locator("#bot-new-conversation-button").evaluate((node) => node.focus());
  assert.equal(await page.locator("#bot-new-conversation-button").evaluate((node) => node === document.activeElement), false);
  await page.keyboard.press("Escape");
  await page.locator("#theme-toggle").click();
  report.checks.push("dark-theme-and-keyboard-focus-trap");
  await open();
  await dialog.locator("[data-assistant-project]").click();
  await page.locator("#bot-group-dialog").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  report.checks.push("existing-project-dialog-remains-reachable");

  await page.route(endpoint, async (route) => route.request().method() === "POST" ? route.abort("failed") : route.continue());
  await open();
  await dialog.locator("[data-assistant-create]").click();
  await dialog.locator("[data-assistant-status]").filter({ hasText: "状态未确认" }).waitFor();
  assert.equal(await dialog.locator("[data-assistant-create]").isDisabled(), true);
  assert.equal(await dialog.locator("[data-assistant-inspect]").isVisible(), true);
  await shot("unknown-result");
  report.checks.push("unknown-outcome-offers-reconciliation-not-retry");
  await page.keyboard.press("Escape");
  await page.locator("#bot-new-conversation-button").click();
  assert.equal(await dialog.locator("[data-assistant-create]").isDisabled(), true);
  await page.keyboard.press("Escape");
  await page.unroute(endpoint);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok"));

  // The server commits, but the response is lost after the dialog is dismissed.
  // Outcome ownership must survive the old dialog generation.
  let releaseLost;
  let committed;
  const serverCommitted = new Promise((done) => { committed = done; });
  const lostGate = new Promise((done) => { releaseLost = done; });
  let lostPosts = 0;
  await page.route(endpoint, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    lostPosts++;
    await route.fetch();
    committed();
    await lostGate;
    await route.abort("failed");
  });
  await open();
  await dialog.locator("[data-assistant-title]").fill("回执丢失的对话");
  await dialog.locator("[data-assistant-create]").click();
  await serverCommitted;
  await page.keyboard.press("Escape");
  const requestFailed = page.waitForEvent("requestfailed", (request) => request.method() === "POST" && request.url().endsWith("/api/conversations"));
  releaseLost();
  await requestFailed;
  await page.getByText("创建状态未确认，请先刷新对话列表核对；未自动重试", { exact: true }).waitFor();
  await page.locator("#bot-new-conversation-button").click();
  await dialog.waitFor({ state: "visible" });
  assert.equal(await dialog.locator("[data-assistant-create]").isDisabled(), true);
  assert.equal(await dialog.locator("[data-assistant-inspect]").isVisible(), true);
  await dialog.locator("[data-assistant-inspect]").click();
  await page.locator("[data-bot-conversation]").filter({ hasText: "回执丢失的对话" }).waitFor();
  assert.equal(lostPosts, 1);
  assert.equal((await api("/api/conversations")).conversations.filter((item) => item.title === "回执丢失的对话").length, 1);
  report.checks.push("late-unknown-outcome-survives-dismissal-and-reconciles-list");
  const runs = await api("/api/runs");
  assert.equal((Array.isArray(runs) ? runs : runs.runs || runs.items || []).length, 0);
  report.checks.push("creation-never-starts-run");
  await page.unroute(endpoint);

  // Hold the authoritative failed-run snapshot until another conversation is
  // selected. A pure status refresh must update even the inactive tree row,
  // without rebuilding the currently focused composer or dropping its draft.
  let releaseRecovery;
  let recoveryReady;
  const recoveryGate = new Promise((done) => { releaseRecovery = done; });
  const recoveryReceived = new Promise((done) => { recoveryReady = done; });
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const payload = await response.json();
    const items = Array.isArray(payload) ? payload : payload.runs || payload.items || [];
    if (items.some((run) => run.conversationId === a.id && run.status === "recovery_required")) {
      recoveryReady(true);
      await recoveryGate;
    }
    await route.fulfill({ response });
  });
  await page.locator(`[data-bot-conversation="${a.id}"]`).click();
  await input.fill("QA：仅验证未安装运行时的恢复状态");
  await page.locator("#bot-composer-form button[type='submit']").click();
  const recoveryTimeout = setTimeout(() => recoveryReady(false), 20000);
  try { assert.equal(await recoveryReceived, true, "missing runtime must produce recovery_required"); }
  finally { clearTimeout(recoveryTimeout); }
  await page.locator(`[data-bot-conversation="${b.id}"]`).click();
  await input.fill("后台更新时保留这份草稿");
  await input.focus();
  releaseRecovery();
  await page.waitForFunction((id) => {
    const label = document.querySelector(`[data-bot-conversation="${id}"] [data-bot-conversation-status]`)?.textContent;
    return label === "需恢复" || label === "待确认";
  }, a.id, { timeout: 20000 });
  assert.ok((await page.locator("#bot-roster-label").textContent()).includes("待处理"));
  assert.equal(await input.inputValue(), "后台更新时保留这份草稿");
  assert.equal(await input.evaluate((node) => node === document.activeElement), true);
  assert.equal(await page.locator(`[data-bot-conversation="${b.id}"]`).evaluate((node) => node.classList.contains("is-active")), true);
  await shot("inactive-conversation-recovery");
  report.checks.push("inactive-conversation-status-refresh-preserves-draft-and-focus");

  // 左栏「直接对话」按助手成组：a/b 同一助手 → 一个组节点，可折叠且重绘不自行弹开。
  const directGroup = page.locator('[data-bot-tree-section="direct"] [data-bot-project-node^="direct:"]');
  assert.equal(await directGroup.count(), 1);
  assert.equal(await directGroup.locator("[data-bot-conversation]").count() >= 2, true);
  const groupToggle = directGroup.locator("[data-bot-project-toggle]");
  await groupToggle.click();
  assert.equal(await groupToggle.getAttribute("aria-expanded"), "false");
  assert.equal(await directGroup.locator(".bot-project-rooms").isHidden(), true);
  await shot("direct-group-collapsed");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok"), null, { timeout: 30000 });
  await directGroup.waitFor({ state: "attached" });
  assert.equal(await directGroup.locator("[data-bot-project-toggle]").getAttribute("aria-expanded"), "false");
  await directGroup.locator("[data-bot-project-toggle]").click();
  assert.equal(await directGroup.locator(".bot-project-rooms").isVisible(), true);
  report.checks.push("direct-conversations-group-by-assistant-and-collapse-persists");

  // 指定文件夹：归入该文件夹的项目（不是全局直接对话），且不启动 run。
  const folder = resolve(root, "folder-project");
  await mkdir(folder, { recursive: true });
  await open();
  await dialog.locator("[data-assistant-title]").fill("带文件夹的对话");
  await dialog.locator("[data-assistant-cwd]").fill(folder);
  await shot("new-conversation-with-folder");
  await dialog.locator("[data-assistant-create]").click();
  await dialog.waitFor({ state: "hidden" });
  const inFolder = (await api("/api/conversations")).conversations.find((item) => item.title === "带文件夹的对话");
  assert.ok(inFolder);
  assert.equal(inFolder.kind, "workspace_group");
  assert.equal(inFolder.scope, "project");
  assert.equal(inFolder.memberIds.length, 1);
  const folderProject = (await api("/api/projects")).projects.find((item) => item.projectId === inFolder.projectId);
  assert.ok(folderProject);
  assert.equal(folderProject.canonicalCwd.toLowerCase(), folder.toLowerCase());
  await page.waitForFunction((id) => document.querySelector(`[data-bot-project-node] [data-bot-conversation="${id}"]`)?.classList.contains("is-active"), inFolder.id);
  // 同一文件夹再建一次：复用同一个项目，不重复建项目。
  await open();
  await dialog.locator("[data-assistant-title]").fill("同文件夹第二段");
  await dialog.locator("[data-assistant-cwd]").fill(folder);
  await dialog.locator("[data-assistant-create]").click();
  await dialog.waitFor({ state: "hidden" });
  const second = (await api("/api/conversations")).conversations.find((item) => item.title === "同文件夹第二段");
  assert.equal(second.projectId, inFolder.projectId);
  // 不存在的文件夹：服务端如实拒绝，对话框留着、状态行给原因、可改后再提交。
  await open();
  await dialog.locator("[data-assistant-cwd]").fill(resolve(root, "no-such-folder"));
  await dialog.locator("[data-assistant-create]").click();
  await page.waitForFunction(() => document.querySelector("[data-assistant-status]")?.textContent.trim() && !document.querySelector("[data-assistant-create]").disabled);
  assert.equal(await dialog.isVisible(), true);
  report.checks.push(`missing-folder-rejected:${(await dialog.locator("[data-assistant-status]").textContent()).slice(0, 60)}`);
  await page.keyboard.press("Escape");
  report.checks.push("folder-conversation-lands-in-project-and-reuses-it");
  assert.deepEqual(report.errors, []);
  report.ok = true;
} catch (error) {
  report.error = error.message;
  if (page) await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  try { report.shutdown = await stopTestServer(child, { token }); }
  finally {
    await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks, output, error: report.error, shutdown: report.shutdown }));
    const rel = relative(tmpdir(), root);
    if (!rel.startsWith("..") && rel.startsWith("514cc-assistant-start-")) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}
