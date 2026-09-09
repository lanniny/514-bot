#!/usr/bin/env node
/**
 * qa-pet-page.mjs — 桌宠页面端到端 QA（真实内核 + playwright）。
 *
 * 覆盖：
 *   1. /pet 页与其 vendored 运行时/模型资产全部 200（静态白名单契约）。
 *   2. localStorage handoff 凭据桥 → 猫页进入 ready（Live2D 真实加载）。
 *   3. 打字脉冲走真实内核通道：POST /api/pet/input → /api/pet/stream → typing 状态。
 *   4. bot 事件映射：attention（审批举手）/ celebrate（完成庆祝）——经 qa=1 注入通道
 *      （真实 bot 事件需要完整 run 生命周期，引擎映射逻辑由同一函数承载）。
 *
 * 产物：output-dir 下各状态截图 + qa-pet-summary.json。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import assert from "node:assert/strict";

import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "qa-pet-page-token-0123456789abcdef";

function parseArgs(argv = []) {
  let outputDir = resolve(tmpdir(), `514cc-qa-pet-${Date.now()}-${process.pid}`);
  for (const argument of argv) {
    if (argument.startsWith("--output-dir=")) {
      const value = argument.slice("--output-dir=".length).trim();
      if (!value) throw new Error("--output-dir requires a path");
      outputDir = isAbsolute(value) ? resolve(value) : resolve(appRoot, value);
      continue;
    }
    throw new Error(`unknown qa-pet option: ${argument}`);
  }
  return { outputDir };
}

async function waitForPetState(page, states, timeoutMs = 30_000) {
  await page.waitForFunction(
    (expected) => expected.includes(document.body.dataset.petState),
    states,
    { timeout: timeoutMs, polling: 100 },
  );
  return page.evaluate(() => document.body.dataset.petState);
}

async function main() {
  const { outputDir } = parseArgs(process.argv.slice(2));
  await mkdir(outputDir, { recursive: true });
  const problems = [];
  const captured = {};
  const responses = [];

  // 隔离数据根：instance-lock 按数据根互斥，绝不能碰用户真实实例的锁
  const dataDir = await mkdtemp(resolve(tmpdir(), "514cc-qa-pet-data-"));
  const server = spawnTestServer({ env: { CONTROL_CENTER_TOKEN: TOKEN, CONTROL_CENTER_DATA_DIR: dataDir } });
  let browser = null;
  try {
    const bootstrapUrl = await waitForUrl(server);
    // bootstrapUrl 带 #fragment 与尾部斜杠；双斜杠路径会被 URL 解析器当成协议相对引用
    const base = bootstrapUrl.split("#")[0].replace(/\/+$/, "");
    const api = async (path, method = "GET", body) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json();
      assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`);
      return value;
    };
    const pluginProject = (await api("/api/projects", "POST", { cwd: appRoot, title: "桌宠插件验证" })).project;
    const otherProject = (await api("/api/projects", "POST", { cwd: dataDir, title: "未绑定项目" })).project;

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 320, height: 300 } });
    const page = await context.newPage();
    page.on("response", (response) => {
      responses.push({ url: response.url(), status: response.status() });
    });
    // 凭据桥降级路径：主窗口开窗前写入的 handoff 键（读到即删）
    await page.addInitScript(
      ([token]) => {
        localStorage.setItem("514cc-pet-handoff", JSON.stringify({ token, at: Date.now() }));
      },
      [TOKEN],
    );
    await page.goto(`${base}/pet?qa=1`, { waitUntil: "load" });

    const readyState = await waitForPetState(page, ["ready", "error"], 30_000);
    if (readyState === "error") {
      problems.push(`pet page errored: ${await page.evaluate(() => document.getElementById("pet-status")?.textContent)}`);
    } else {
      // ready 只代表凭据+流就绪；Live2D 模型是异步挂载，显式等到挂上再断言
      await page.waitForFunction(() => Boolean(window.__petTest?.stateRef?.model), null, { timeout: 30_000, polling: 200 }).catch(() => {});
      const modelLoaded = await page.evaluate(() => Boolean(window.__petTest?.stateRef?.model));
      if (!modelLoaded) problems.push("pet state is ready but the Live2D model never mounted");
      captured.ready = "ready";
      captured.pixels = await page.evaluate(() => {
        const renderer = window.__petTest.getRenderer();
        renderer.render(window.__petTest.stateRef.model.parent);
        const pixels = renderer.extract.pixels();
        let painted = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 16) painted++;
        return { painted, total: pixels.length / 4 };
      });
      assert.ok(captured.pixels.painted > 1000, "Live2D canvas must paint visible pixels");
      await page.waitForTimeout(250);
      await page.screenshot({ path: resolve(outputDir, "pet-ready.png") });
    }

    // 静态契约：运行时与模型资产全部可达
    const assetPrefixes = ["/vendor/pet/", "/vendor/pet-models/", "/pet/"];
    const failedAssets = responses.filter(
      (item) => assetPrefixes.some((prefix) => item.url.includes(prefix)) && item.status >= 400,
    );
    if (failedAssets.length > 0) {
      problems.push(`pet assets failed: ${JSON.stringify(failedAssets)}`);
    }
    const loadedMoc = responses.some((item) => item.url.includes("demomodel.moc3") && item.status === 200);
    if (!loadedMoc) problems.push("demomodel.moc3 was never loaded");

    // 端到端打字脉冲：真实内核 POST → pet stream → typing。
    // POST 与 SSE 订阅存在注册竞态，脉冲有界重试（丢失的脉冲无害，重发即可）。
    let typingState = "";
    for (let attempt = 0; attempt < 5 && typingState !== "typing"; attempt += 1) {
      const pulse = await fetch(`${base}/api/pet/input`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "typing" }),
      });
      if (pulse.status !== 202) problems.push(`pet/input returned HTTP ${pulse.status}`);
      typingState = await waitForPetState(page, ["typing"], 2_000).catch(() => "");
    }
    captured.typing = typingState;
    if (typingState !== "typing") problems.push(`expected typing state, got ${typingState || "timeout"}`);
    await page.screenshot({ path: resolve(outputDir, "pet-typing.png") });

    // 审批举手（注入通道；与真实事件流共用 ingestBotEvent）
    await page.evaluate(() => window.__petTest.ingestBotEvent({ type: "approval.pending", data: { id: "qa-pending" } }));
    const attentionState = await waitForPetState(page, ["attention"], 5_000);
    if (attentionState !== "attention") problems.push(`expected attention state, got ${attentionState}`);
    await page.screenshot({ path: resolve(outputDir, "pet-attention.png") });
    await page.evaluate(() => {
      window.__petTest.onActivity({ kind: "typing" });
      window.__petTest.ingestBotEvent({ type: "assistant.message" });
    });
    if (await page.locator("body").getAttribute("data-pet-state") !== "attention") problems.push("typing cleared a pending approval");
    await page.evaluate(() => window.__petTest.ingestBotEvent({ type: "approval.resolved", data: { id: "qa-pending" } }));

    // 完成庆祝
    await page.evaluate(() => window.__petTest.ingestBotEvent({ type: "agent.turn_completed" }));
    const celebrateState = await waitForPetState(page, ["celebrate"], 5_000);
    if (celebrateState !== "celebrate") problems.push(`expected celebrate state, got ${celebrateState}`);
    await page.screenshot({ path: resolve(outputDir, "pet-celebrate.png") });

    // The main surface must fail closed until the desktop-pet package is installed.
    const mainPage = await page.context().newPage();
    mainPage.on("response", (response) => responses.push({ url: response.url(), status: response.status() }));
    await mainPage.addInitScript(() => {
      if (!localStorage.getItem("514cc.pet.settings")) localStorage.setItem("514cc.pet.settings", JSON.stringify({ enabled: true, interactive: true, opacity: 0.6, scale: 1 }));
    });
    await mainPage.goto(bootstrapUrl, { waitUntil: "domcontentloaded" });
    await mainPage.waitForTimeout(500);
    assert.equal(await mainPage.locator("#pet-web-dock").count(), 0, "an uninstalled pet plugin must not start from localStorage alone");
    assert.equal(await mainPage.locator("#bot-settings-tab-pet").count(), 0, "pet settings must not remain in Bot settings");

    await mainPage.setViewportSize({ width: 1280, height: 800 });
    await mainPage.locator('#sidebar [data-view="plugins"]').click();
    await mainPage.locator('[data-plugin-tab="catalog"]').click();
    const catalogPet = mainPage.locator('[data-plugin-id="desktop-pet"]');
    await catalogPet.getByRole("button", { name: "查看详情", exact: true }).click();
    const drawer = mainPage.locator("[data-drawer]");
    await drawer.waitFor();
    assert.equal(await drawer.locator("[data-drawer-state]").textContent(), "未安装");
    assert.equal(await drawer.locator('input[name="enabled"]').isDisabled(), true);
    await mainPage.screenshot({ path: resolve(outputDir, "pet-plugin-available.png") });
    await Promise.all([
      mainPage.waitForResponse((response) => response.url().endsWith("/api/plugins/install") && response.request().method() === "POST"),
      drawer.getByRole("button", { name: "安装插件", exact: true }).click(),
    ]);
    await drawer.getByText("已安装", { exact: true }).waitFor();
    await mainPage.waitForFunction(() => document.querySelector("#pet-web-dock")?.dataset.settingsPreview === "true");
    await mainPage.locator("[data-drawer-done]").click();
    await mainPage.waitForFunction(() => !document.querySelector("#pet-web-dock"));
    await mainPage.locator("[data-plugin-project]").selectOption(pluginProject.projectId);
    await mainPage.locator('[data-plugin-tab="installed"]').click();
    const installedPet = mainPage.locator('[data-plugin-id="desktop-pet"]');
    await installedPet.getByRole("button", { name: "查看与配置", exact: true }).click();
    await drawer.locator('input[name="enabled"]').check();
    await drawer.locator('input[name="interactive"]').check();
    for (const [model, asset] of [["keyboard", "bongo-keyboard/demomodel2.moc3"], ["gamepad", "bongo-gamepad/demomodel3.moc3"], ["standard", "bongo-standard/demomodel.moc3"]]) {
      const loaded = mainPage.waitForResponse((response) => response.url().includes(asset) && response.status() === 200);
      await drawer.getByLabel("模型模式").selectOption(model);
      await loaded;
    }
    await drawer.getByRole("button", { name: "活力", exact: true }).click();
    assert.equal(await drawer.locator(".pet-settings-section-head output").textContent(), "活力");
    const frame = mainPage.frameLocator("#pet-web-dock-frame");
    await frame.locator('body[data-pet-state="ready"]').waitFor({ timeout: 30_000 });
    assert.equal((await api(`/api/plugins?projectId=${pluginProject.projectId}`)).bindings.length, 0, "preview must not save or enable the project binding");
    await Promise.all([
      mainPage.waitForResponse((response) => response.url().endsWith("/api/plugins/configure") && response.request().method() === "POST"),
      drawer.getByRole("button", { name: "保存并应用", exact: true }).click(),
    ]);
    await mainPage.waitForFunction(() => JSON.parse(localStorage.getItem("514cc.pet.settings")).scale === 1.2);
    await mainPage.waitForFunction(() => document.activeElement?.textContent?.includes("保存并应用"));
    await frame.locator('body[data-pet-state="ready"]').waitFor({ timeout: 30_000 });
    assert.equal(await frame.locator("body").evaluate((node) => getComputedStyle(node).opacity), "1", "opacity must not be applied twice");
    await drawer.getByRole("button", { name: "戳一戳", exact: true }).click();
    await frame.locator('body[data-pet-state="typing"]').waitFor();
    await drawer.locator(".plugin-drawer-body").evaluate((node) => node.scrollTo(0, 0));
    await mainPage.screenshot({ path: resolve(outputDir, "pet-plugin-settings-desktop.png") });
    await drawer.getByRole("button", { name: "恢复默认", exact: true }).click();
    assert.equal(await drawer.locator(".pet-settings-section-head output").textContent(), "日常");
    await Promise.all([
      mainPage.waitForResponse((response) => response.url().endsWith("/api/plugins/configure") && response.request().method() === "POST"),
      drawer.getByRole("button", { name: "保存并应用", exact: true }).click(),
    ]);
    await mainPage.locator("[data-drawer-done]").click();
    await mainPage.locator("[data-plugin-project]").selectOption(otherProject.projectId);
    await mainPage.waitForFunction(() => !document.querySelector("#pet-web-dock"));
    await mainPage.locator("[data-plugin-project]").selectOption(pluginProject.projectId);
    await mainPage.locator("#pet-web-dock-frame").waitFor();
    await mainPage.setViewportSize({ width: 1280, height: 800 });
    const header = mainPage.locator(".pet-web-dock-header");
    const beforeDrag = await header.boundingBox();
    await mainPage.mouse.move(beforeDrag.x + 60, beforeDrag.y + 15);
    await mainPage.mouse.down();
    await mainPage.mouse.move(480, 320, { steps: 12 });
    await mainPage.mouse.up();
    const afterDrag = await mainPage.locator("#pet-web-dock").boundingBox();
    assert.ok(Math.abs(afterDrag.x - beforeDrag.x) > 40, "mouse drag must move the dock");
    await header.focus();
    await mainPage.keyboard.press("ArrowLeft");
    await mainPage.waitForFunction((x) => document.querySelector("#pet-web-dock")?.getBoundingClientRect().x < x - 1, afterDrag.x);
    const afterKey = await mainPage.locator("#pet-web-dock").boundingBox();
    assert.ok(afterKey.x < afterDrag.x, "keyboard move must move the dock");
    await mainPage.reload({ waitUntil: "domcontentloaded" });
    await mainPage.waitForTimeout(500);
    assert.equal(await mainPage.locator("#pet-web-dock").count(), 0, "unknown project after reload must keep the pet closed");
    await mainPage.locator("[data-plugin-project]").selectOption(pluginProject.projectId);
    await mainPage.locator("#pet-web-dock-frame").waitFor();
    const restored = await mainPage.locator("#pet-web-dock").boundingBox();
    const storedPosition = await mainPage.evaluate(() => JSON.parse(localStorage.getItem("514cc.pet.settings")).dockPosition);
    assert.ok(Math.abs(restored.x - afterKey.x) < 2, `position must survive reload: ${JSON.stringify({ afterKey, restored, storedPosition })}`);
    await frame.locator('body[data-pet-state="ready"]').waitFor({ timeout: 30_000 });
    await mainPage.screenshot({ path: resolve(outputDir, "pet-workbench-desktop.png") });

    await mainPage.locator('#sidebar [data-view="plugins"]').click();
    await mainPage.locator("[data-plugin-project]").selectOption(pluginProject.projectId);
    await mainPage.locator('[data-plugin-id="desktop-pet"]').getByRole("button", { name: "查看与配置", exact: true }).click();
    await drawer.locator('input[name="web-dock"]').uncheck();
    await Promise.all([
      mainPage.waitForResponse((response) => response.url().endsWith("/api/plugins/configure") && response.request().method() === "POST"),
      drawer.getByRole("button", { name: "保存并应用", exact: true }).click(),
    ]);
    assert.equal(await mainPage.locator("#pet-web-dock-frame").count(), 1, "settings preview stays visible while the drawer is open");
    await mainPage.locator("[data-drawer-done]").click();
    await mainPage.waitForFunction(() => !document.querySelector("#pet-web-dock-frame"));
    await mainPage.locator('[data-plugin-id="desktop-pet"]').getByRole("button", { name: "查看与配置", exact: true }).click();
    await drawer.locator('input[name="web-dock"]').check();
    await drawer.locator('input[name="mouse-tracking"]').uncheck();
    await drawer.locator('input[name="scale"]').fill("180");
    await drawer.locator('input[name="interactive"]').check();
    await Promise.all([
      mainPage.waitForResponse((response) => response.url().endsWith("/api/plugins/configure") && response.request().method() === "POST"),
      drawer.getByRole("button", { name: "保存并应用", exact: true }).click(),
    ]);
    await mainPage.locator("#pet-web-dock-frame").waitFor();
    await mainPage.setViewportSize({ width: 390, height: 844 });
    await mainPage.waitForFunction(() => document.querySelector("#pet-web-dock")?.dataset.settingsPreview === "true");
    const settingsGeometry = await drawer.evaluate((node) => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
    assert.ok(settingsGeometry.scrollWidth <= settingsGeometry.clientWidth + 1, "pet plugin settings must not overflow the mobile drawer");
    await drawer.locator(".plugin-drawer-body").evaluate((node) => node.scrollTo(0, 0));
    await mainPage.screenshot({ path: resolve(outputDir, "pet-plugin-settings-mobile.png") });
    await mainPage.locator("[data-drawer-done]").click();
    const mobileBox = await mainPage.locator("#pet-web-dock").boundingBox();
    assert.ok(mobileBox.x >= 0 && mobileBox.x + mobileBox.width <= 390, "large dock must fit mobile viewport");
    await mainPage.screenshot({ path: resolve(outputDir, "pet-workbench-mobile.png") });
    const projectToggle = mainPage.locator('[data-plugin-id="desktop-pet"] .plugin-toggle input');
    await Promise.all([
      mainPage.waitForResponse((response) => response.url().endsWith("/api/plugins/configure") && response.request().method() === "POST"),
      projectToggle.uncheck(),
    ]);
    await mainPage.waitForFunction(() => !document.querySelector("#pet-web-dock"));
    await mainPage.locator('[data-plugin-id="desktop-pet"]').getByRole("button", { name: "查看与配置", exact: true }).click();
    await mainPage.locator("[data-drawer-uninstall]").click();
    await mainPage.locator("#action-dialog[open]").waitFor();
    await Promise.all([
      mainPage.waitForResponse((response) => response.url().endsWith("/api/plugins/remove") && response.request().method() === "POST"),
      mainPage.locator("#dialog-confirm-button").click(),
    ]);
    await mainPage.waitForFunction(() => !document.querySelector('[data-plugin-id="desktop-pet"]'));
    assert.equal((await api("/api/plugins")).installed.some((entry) => entry.id === "desktop-pet"), false);
    await mainPage.reload({ waitUntil: "domcontentloaded" });
    await mainPage.waitForTimeout(500);
    assert.equal(await mainPage.locator("#pet-web-dock-frame").count(), 0, "uninstalled pet must stay closed on reload");
    captured.workflows = ["install-gate", "catalog-details", "project-config", "project-switch-revoke", "disable-uninstall", "parent-frame-pairing", "opacity-once", "pointer-drag", "keyboard-move", "restore-position", "preset-control", "poke-preview", "reset-defaults", "settings-responsive", "web-dock-toggle", "plugin-percent", "mobile-bounds", "close-disposes"];

    // Asset failure stays visible after streams connect, then the retry button recovers.
    const broken = await page.context().newPage();
    await broken.addInitScript(([token]) => localStorage.setItem("514cc-pet-handoff", JSON.stringify({ token, at: Date.now() })), [TOKEN]);
    let failModel = true;
    await broken.route("**/demomodel.moc3", (route) => failModel ? route.fulfill({ status: 503, body: "unavailable" }) : route.continue());
    await broken.goto(`${base}/pet?qa=1`);
    await waitForPetState(broken, ["error"]);
    await broken.waitForTimeout(700);
    assert.equal(await broken.locator("body").getAttribute("data-pet-state"), "error");
    await broken.screenshot({ path: resolve(outputDir, "pet-load-error.png") });
    failModel = false;
    await broken.getByRole("button", { name: "重试", exact: true }).click();
    await waitForPetState(broken, ["ready"]);
    captured.retry = true;
    await broken.close();
    await mainPage.close();

    // Disable BroadcastChannel in both windows: same-origin postMessage must pair,
    // update settings, survive a 401, and release the iframe when closed.
    let fallbackPlugins = await api("/api/plugins");
    await api("/api/plugins/install", "POST", { catalogId: "desktop-pet", expectedRevision: fallbackPlugins.revision });
    fallbackPlugins = await api(`/api/plugins?projectId=${pluginProject.projectId}`);
    await api("/api/plugins/configure", "POST", { projectId: pluginProject.projectId, pluginId: "desktop-pet", enabled: true, config: {}, expectedRevision: fallbackPlugins.revision });
    const fallbackContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await fallbackContext.addInitScript((token) => {
      window.BroadcastChannel = undefined;
      sessionStorage.setItem("514cc-control-token", token);
      localStorage.setItem("514cc.pet.settings", JSON.stringify({ enabled: true, interactive: true }));
    }, TOKEN);
    const fallback = await fallbackContext.newPage();
    let rejectStream = false;
    let rejected = false;
    await fallbackContext.route("**/api/pet/stream", (route) => {
      if (rejectStream) { rejectStream = false; rejected = true; return route.fulfill({ status: 401, body: "expired" }); }
      return route.continue();
    });
    await fallback.goto(base, { waitUntil: "domcontentloaded" });
    await fallback.locator('#sidebar [data-view="plugins"]').click();
    await fallback.locator("[data-plugin-project]").selectOption(pluginProject.projectId);
    const fallbackFrame = fallback.frameLocator("#pet-web-dock-frame");
    await fallbackFrame.locator('body[data-pet-state="ready"]').waitFor({ timeout: 30_000 });
    rejectStream = true;
    const child = fallback.frames().find((item) => new URL(item.url()).pathname === "/pet/index.html");
    await child.goto(`${base}/pet/index.html?qa=1`);
    await fallbackFrame.locator('body[data-pet-state="ready"]').waitFor({ timeout: 30_000 });
    assert.equal(rejected, true);
    await fallback.evaluate(() => window.dispatchEvent(new CustomEvent("514cc:plugin-changed", {
      detail: { action: "configure", payload: { pluginId: "desktop-pet", projectId: document.querySelector("[data-plugin-project]")?.value, enabled: true, config: { "mouse-tracking": false } } },
    })));
    await child.waitForFunction(() => window.__petTest.stateRef.mouseTracking === false);
    await fallback.getByRole("button", { name: "收起挂件" }).click();
    assert.equal(fallback.frames().length, 1);
    captured.fallback = ["pairing", "401-repair", "configuration", "dispose"];
    await fallbackContext.close();

    const summary = {
      ok: problems.length === 0,
      captured,
      problems,
      assetRequestCount: responses.length,
      assetRequests: responses.map((item) => `${item.status} ${item.url.replace(base, "")}`),
      outputDir,
    };
    await writeFile(resolve(outputDir, "qa-pet-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    if (problems.length > 0) process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopTestServer(server, { token: TOKEN });
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
