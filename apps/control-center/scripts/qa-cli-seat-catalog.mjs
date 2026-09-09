#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildIsolatedServerEnv,
  createIsolatedQaRepo,
  diagnosticsWatcher,
  withDisposableQaRoot,
} from "./qa-team-workspace.mjs";
import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const appRoot = resolve(import.meta.dirname, "..");
const KIMI_MODELS = Object.freeze([
  "kimi-code/kimi-for-coding",
  "kimi-code/kimi-for-coding-highspeed",
  "kimi-code/k3",
  "kimi-code/k3-256k",
]);

function parseArgs(argv = process.argv.slice(2)) {
  let outputDir = resolve(appRoot, ".qa-output", "cli-seat-catalog");
  let composerOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--composer-only") {
      composerOnly = true;
      continue;
    }
    if (argument === "--output-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output-dir requires a path");
      outputDir = resolve(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--output-dir=")) {
      const value = argument.slice("--output-dir=".length);
      if (!value) throw new Error("--output-dir requires a path");
      outputDir = resolve(value);
      continue;
    }
    throw new Error(`unknown qa:cli-seats argument: ${argument}`);
  }
  return { outputDir, composerOnly };
}

async function api(page, pathname, { method = "GET", body } = {}) {
  return page.evaluate(async ({ pathname: target, method: verb, body: payload }) => {
    const token = sessionStorage.getItem("514cc-control-token");
    const response = await fetch(target, {
      method: verb,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = result?.error?.message || result?.message || `HTTP ${response.status}`;
      throw new Error(`${verb} ${target}: ${message}`);
    }
    return result;
  }, { pathname, method, body });
}

async function pinIsolatedDiscoveryFallback(isolatedRepoRoot) {
  const modelsPath = resolve(isolatedRepoRoot, "config", "control-center", "models.json");
  const registry = JSON.parse(await readFile(modelsPath, "utf8"));
  for (const profile of registry.profiles || []) {
    if (profile.command) profile.command = `qa-missing-${profile.id}`;
  }
  const codex = (registry.profiles || []).find((profile) => profile.id === "codex-technical");
  if (codex) codex.command = process.execPath;
  await writeFile(modelsPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

async function selectAgent(page, memberId) {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === "/api/agents/models"
      && url.searchParams.get("agent") === memberId;
  }, { timeout: 40_000 });
  const tab = page.locator(`[data-composer-target="${memberId}"]`);
  await tab.click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  const catalog = await response.json();
  await page.waitForFunction((expected) => (
    document.querySelector("#start-agent")?.value === expected
      && document.querySelector(`[data-composer-target="${CSS.escape(expected)}"]`)?.getAttribute("aria-checked") === "true"
      && document.querySelector("#composer-target-name")?.textContent?.trim() === document.querySelector(`[data-composer-target="${CSS.escape(expected)}"]`)?.textContent?.trim()
      && document.querySelector("#task-model-pick")?.dataset.catalogAgent === expected
      && document.querySelector("#task-model")?.disabled === false
  ), memberId, { timeout: 40_000 });
  return catalog;
}

async function slashLabels(page, query) {
  const input = page.locator("#task-input");
  await input.fill(query);
  await page.waitForSelector("#slash-menu:not([hidden]) .slash-item", { timeout: 10_000 });
  await page.waitForSelector("#slash-menu:not([hidden]) .slash-item[aria-selected='true']", { timeout: 10_000 });
  return page.locator("#slash-menu .slash-item strong").allTextContents();
}

async function selectComposerCliTab(page, tab) {
  const toggle = page.locator("#composer-cli-console-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const button = page.locator(`[data-composer-cli-tab="${tab}"]`);
  await button.click();
  await page.waitForSelector(`#composer-cli-panel-${tab}:not([hidden])`);
  assert.equal(await button.getAttribute("aria-selected"), "true");
}

async function selectHiddenComposerSelect(page, selector, value) {
  await page.evaluate(([sel, val]) => {
    const select = document.querySelector(sel);
    if (!select) throw new Error(`missing select ${sel}`);
    select.value = val;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, [selector, value]);
}

function composerConsoleSnapshot(page) {
  return page.evaluate(() => ({
    title: document.querySelector("#composer-cli-console-title")?.textContent?.trim(),
    adapter: document.querySelector("#composer-cli-console")?.dataset.adapter,
    target: document.querySelector("#composer-shell")?.dataset.targetAgent,
    permissionOptions: [...document.querySelectorAll("#task-permission option")].map((option) => option.value),
    effortOptions: [...document.querySelectorAll("#task-effort option")].map((option) => option.value),
    effortHidden: document.querySelector("#task-effort-pick")?.hidden,
    actionIds: [...document.querySelectorAll("[data-composer-cli-action]")].map((button) => button.dataset.composerCliAction),
  }));
}

async function assertNoHorizontalOverflow(page, label) {
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    body: document.body.scrollWidth,
    root: document.documentElement.scrollWidth,
  }));
  assert.ok(Math.max(geometry.body, geometry.root) <= geometry.viewport + 1, `${label} horizontal overflow: ${JSON.stringify(geometry)}`);
  return geometry;
}

async function verifyComposer(page, outputDir, isolatedRepoRoot) {
  await page.waitForSelector('#member-strip [data-composer-target="claude-fable"][aria-checked="true"]', { timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector("#composer-cli-console-title")?.textContent?.trim() === "Claude Code 操作台");
  const initialTarget = await page.evaluate(() => ({
    targetIds: [...document.querySelectorAll("#member-strip [data-composer-target]")].map((item) => item.dataset.composerTarget),
    activeTarget: document.querySelector("#member-strip [aria-checked='true']")?.dataset.composerTarget,
    activeTargetLabel: document.querySelector("#member-strip [aria-checked='true']")?.textContent?.trim(),
    targetName: document.querySelector("#composer-target-name")?.textContent?.trim(),
    targetRoute: document.querySelector("#composer-target-route")?.textContent?.trim(),
    bridgeHidden: document.querySelector("#start-agent")?.hidden,
    legacyTargetVisible: Boolean(document.querySelector("#start-agent-pick, #followup-agent-pick")),
  }));
  assert.deepEqual(initialTarget.targetIds, ["claude-fable", "codex-technical", "grok-build", "kimi-frontend", "pi-resident"]);
  assert.equal(initialTarget.activeTarget, "claude-fable");
  assert.equal(initialTarget.targetName, initialTarget.activeTargetLabel);
  assert.equal(initialTarget.targetRoute, "直接收件人");
  assert.equal(initialTarget.bridgeHidden, true);
  assert.equal(initialTarget.legacyTargetVisible, false);
  const teamConsole = await composerConsoleSnapshot(page);
  assert.equal(teamConsole.title, "Claude Code 操作台");
  assert.equal(teamConsole.adapter, "claude-stream-json");
  assert.equal(teamConsole.target, "claude-fable");
  // 2026-08-27 native 泛化：claude 追加原生 acceptEdits/bypassPermissions 档（只读轮透传）
  assert.deepEqual(teamConsole.permissionOptions, ["plan", "review", "build", "native:acceptEdits", "native:bypassPermissions", "native-note"]);

  const claudeCatalog = await selectAgent(page, "claude-fable");
  assert.equal(claudeCatalog.context.adapterId, "claude-stream-json");
  const claudeConsole = await composerConsoleSnapshot(page);
  assert.equal(claudeConsole.title, "Claude Code 操作台");
  assert.equal(claudeConsole.target, "claude-fable");
  // 2026-08-27 native 泛化：claude 追加原生 acceptEdits/bypassPermissions 档（只读轮透传）
  assert.deepEqual(teamConsole.permissionOptions, ["plan", "review", "build", "native:acceptEdits", "native:bypassPermissions", "native-note"]);

  const kimiCatalog = await selectAgent(page, "kimi-frontend");
  assert.equal(kimiCatalog.context.memberId, "kimi-frontend");
  assert.equal(kimiCatalog.context.runtimeProfileId, "kimi-frontend");
  assert.equal(kimiCatalog.context.adapterId, "kimi-headless-resume");
  assert.deepEqual(kimiCatalog.models.map((model) => model.id), KIMI_MODELS);
  // kimi effort 已生效（env 注入通道，LO 2026-08-09 决策）：静态目录即声明 low/high/max
  assert.equal(kimiCatalog.controls.effort.supported, true);
  assert.deepEqual(kimiCatalog.effortLevels, ["low", "high", "max"]);

  const kimiControls = await page.evaluate(() => ({
    models: [...document.querySelector("#task-model").options].map((option) => option.value),
    effortHidden: document.querySelector("#task-effort-pick").hidden,
    effortDisabled: document.querySelector("#task-effort").disabled,
    targetName: document.querySelector("#composer-target-name")?.textContent?.trim(),
    targetRoute: document.querySelector("#composer-target-route")?.textContent?.trim(),
  }));
  assert.deepEqual(kimiControls.models, ["", ...KIMI_MODELS]);
  assert.equal(kimiControls.effortHidden, false);
  assert.equal(kimiControls.effortDisabled, false);
  assert.match(kimiControls.targetName || "", /^Kimi 前端/);
  assert.equal(kimiControls.targetRoute, "直接收件人");
  const kimiConsole = await composerConsoleSnapshot(page);
  assert.equal(kimiConsole.title, "Kimi Code 操作台");
  assert.equal(kimiConsole.adapter, "kimi-headless-resume");
  // kimi 原生档（yolo/auto）进下拉；说明项只读轮边界也入 option 值清单
  assert.deepEqual(kimiConsole.permissionOptions, ["plan", "review", "native:auto", "native:yolo", "native-note"]);
  assert.equal(kimiConsole.effortHidden, false);

  const kimiSlash = await slashLabels(page, "/");
  assert.deepEqual(kimiSlash.filter((label) => label.startsWith("/model ")), [
    "/model default",
    ...KIMI_MODELS.map((model) => `/model ${model}`),
  ]);
  assert.ok(kimiSlash.includes("/plan"));
  assert.ok(kimiSlash.includes("/review"));
  assert.deepEqual(
    kimiSlash.filter((label) => label.startsWith("/effort")).sort(),
    ["/effort high", "/effort low", "/effort max"],
  );
  assert.equal(kimiSlash.includes("/build"), false);
  assert.equal(await page.locator("#task-input").getAttribute("aria-expanded"), "true");
  const slashBeforeKey = await page.evaluate(() => ({
    activeId: document.querySelector("#slash-menu [aria-selected='true']")?.id || null,
    hidden: document.querySelector("#slash-menu")?.hidden,
    expanded: document.querySelector("#task-input")?.getAttribute("aria-expanded"),
    focusedId: document.activeElement?.id || null,
  }));
  assert.equal(slashBeforeKey.activeId, "slash-option-0", `slash menu lost its active option: ${JSON.stringify(slashBeforeKey)}`);
  await page.locator("#task-input").press("ArrowDown");
  const slashAfterKey = await page.evaluate(() => ({
    activeId: document.querySelector("#slash-menu [aria-selected='true']")?.id || null,
    hidden: document.querySelector("#slash-menu")?.hidden,
    expanded: document.querySelector("#task-input")?.getAttribute("aria-expanded"),
    focusedId: document.activeElement?.id || null,
  }));
  assert.equal(slashAfterKey.activeId, "slash-option-1", `one ArrowDown must advance exactly one option: before=${JSON.stringify(slashBeforeKey)} after=${JSON.stringify(slashAfterKey)}`);
  await page.screenshot({ path: resolve(outputDir, "composer-kimi-slash-desktop.png") });
  await page.locator("#task-input").press("Escape");
  assert.equal(await page.locator("#slash-menu").isHidden(), true);

  await slashLabels(page, "/model kimi-code/k3");
  await page.locator("#task-input").press("Enter");
  assert.equal(await page.locator("#task-model").inputValue(), "kimi-code/k3");
  assert.equal(await page.locator("#task-input").inputValue(), "");
  await page.screenshot({ path: resolve(outputDir, "composer-kimi-desktop.png") });

  const codexCatalog = await selectAgent(page, "codex-technical");
  assert.equal(codexCatalog.context.adapterId, "codex-app-server");
  assert.equal(codexCatalog.controls.effort.supported, true);
  assert.ok(codexCatalog.effortLevels.includes("ultra"));
  assert.equal(codexCatalog.effortLevels.includes("ultracode"), false);
  const codexEfforts = await page.locator("#task-effort option").evaluateAll((options) => options.map((option) => option.value));
  assert.ok(codexEfforts.includes("ultra"));
  assert.equal(codexEfforts.includes("ultracode"), false);
  const codexSlash = await slashLabels(page, "/effort ult");
  assert.deepEqual(codexSlash, ["/effort ultra"]);
  await page.locator("#task-input").press("Escape");
  const codexConsole = await composerConsoleSnapshot(page);
  assert.equal(codexConsole.title, "Codex 操作台");
  assert.equal(codexConsole.adapter, "codex-app-server");
  // Codex 官方四档（LO 2026-08-09 决策）：danger-full-access 声明即替换 514cc 三档组
  assert.deepEqual(codexConsole.permissionOptions, ["ask", "auto", "full-access", "config"]);
  assert.ok(codexConsole.actionIds.includes("version"));
  assert.ok(codexConsole.actionIds.includes("doctor"));
  assert.ok(codexConsole.actionIds.includes("features"));

  await selectComposerCliTab(page, "defaults");
  await page.locator("#composer-cli-default-model").selectOption("gpt-5.6-sol");
  await page.locator("#composer-cli-default-effort").selectOption("ultra");
  await page.locator("#composer-cli-default-permission").selectOption("workspace-write");
  const defaultsRequest = page.waitForRequest((request) => request.method() === "PUT"
    && new URL(request.url()).pathname === "/api/runtime-seats/codex-technical");
  const defaultsResponse = page.waitForResponse((response) => response.request().method() === "PUT"
    && new URL(response.url()).pathname === "/api/runtime-seats/codex-technical");
  await page.locator("#composer-cli-default-save").click();
  const savedDefaultsBody = (await defaultsRequest).postDataJSON();
  const savedDefaultsResponse = await defaultsResponse;
  assert.ok(savedDefaultsResponse.ok(), `Codex defaults PUT failed: ${savedDefaultsResponse.status()}`);
  assert.deepEqual(savedDefaultsBody, {
    model: "gpt-5.6-sol",
    defaultEffort: "ultra",
    defaultPermissionMode: "workspace-write",
  });
  await page.waitForFunction(() => document.querySelector("#composer-cli-console")?.dataset.busy === "false");
  const modelsOnDisk = JSON.parse(await readFile(resolve(isolatedRepoRoot, "config", "control-center", "models.json"), "utf8"));
  const codexOnDisk = modelsOnDisk.profiles.find((profile) => profile.id === "codex-technical");
  assert.equal(codexOnDisk.model, "gpt-5.6-sol");
  assert.equal(codexOnDisk.defaultEffort, "ultra");
  assert.equal(codexOnDisk.defaultPermissionMode, "workspace-write");
  await page.screenshot({ path: resolve(outputDir, "composer-codex-defaults-desktop.png") });

  await selectComposerCliTab(page, "connection");
  const actionRequest = page.waitForRequest((request) => request.method() === "POST"
    && new URL(request.url()).pathname === "/api/agents/actions");
  const actionResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/agents/actions");
  await page.locator('[data-composer-cli-action="version"]').click();
  const actionRequestBody = (await actionRequest).postDataJSON();
  const versionResponse = await actionResponse;
  const versionPayload = await versionResponse.json();
  assert.deepEqual(actionRequestBody, { agent: "codex-technical", action: "version" });
  assert.equal(versionPayload.status, "ok");
  assert.match(versionPayload.output || "", /^v?\d+\.\d+\.\d+/);
  await page.waitForSelector('#composer-cli-diagnostic-output[data-status="ok"]:not([hidden])');
  const versionOutput = await page.locator("#composer-cli-diagnostic-output").textContent();
  assert.match(versionOutput, /^读取 CLI 版本\s*\n/);
  assert.match(versionOutput, /(?:^|\n)v?\d+\.\d+\.\d+/);
  await page.screenshot({ path: resolve(outputDir, "composer-codex-connection-desktop.png") });

  await page.locator("#composer-cli-open-connection").click();
  await page.waitForSelector("#provider-dialog[open]");
  // 上轮 UI 重构：app 选择从 checkbox 迁移到对话框上下文（targetApp 状态 + 标题文案）
  // 目标 app 的唯一 DOM 投影是对话框标题（新增供应商 · <app>）；编辑已绑定档案时是档案名
  const dialogTitle = await page.locator("#provider-dialog-title").textContent();
  assert.match((dialogTitle || "").trim(), /Codex/, "composer 连接对话框必须面向 codex 应用");
  await page.locator("#provider-close-button").click();

  await page.locator("#composer-cli-open-capabilities").click();
  await page.waitForSelector('#config-surface-capabilities:not([hidden]) [data-member-column="codex-technical"].is-member-focus', { timeout: 20_000 });
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-member-column") === "codex-technical");
  const capabilityTarget = await page.evaluate(() => ({
    hash: location.hash,
    focusedMember: document.activeElement?.getAttribute("data-member-column"),
  }));
  assert.match(capabilityTarget.hash, /^#config\/capabilities\?member=codex-technical&runtime=codex-technical$/);
  assert.equal(capabilityTarget.focusedMember, "codex-technical");
  await page.screenshot({ path: resolve(outputDir, "composer-codex-capabilities-desktop.png"), fullPage: true });
  await page.evaluate(() => { location.hash = "workbench"; });
  await page.waitForSelector("#view-workbench:not([hidden])");

  const piCatalog = await selectAgent(page, "pi-resident");
  assert.equal(piCatalog.context.adapterId, "pi-rpc");
  assert.deepEqual(piCatalog.effortLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const piConsole = await composerConsoleSnapshot(page);
  assert.equal(piConsole.title, "Pi 操作台");
  assert.equal(piConsole.adapter, "pi-rpc");
  assert.deepEqual(piConsole.permissionOptions, ["review"]);
  assert.deepEqual(piConsole.effortOptions, ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(piConsole.effortHidden, false);

  await selectAgent(page, "kimi-frontend");
  await selectHiddenComposerSelect(page, "#task-model", "kimi-code/k3");
  await page.locator("#task-input").fill("@Co");
  await page.waitForSelector('#mention-menu:not([hidden]) [data-mention-id="codex-technical"]');
  await page.locator("#task-input").press("Enter");
  await page.locator("#task-input").press("End");
  await page.locator("#task-input").type("隔离 QA：点名协作但仍直达 Kimi");
  await page.waitForSelector('[data-requested-agent-remove="codex-technical"]');
  assert.match(await page.locator("#composer-collaborators").textContent(), /额外协作者.*Codex 技术执行/s);
  await page.screenshot({ path: resolve(outputDir, "composer-kimi-collaborator-desktop.png") });
  await page.locator('[data-requested-agent-remove="codex-technical"]').click();
  assert.equal(await page.locator("#composer-collaborators").isHidden(), true);
  assert.doesNotMatch(await page.locator("#task-input").inputValue(), /@Codex 技术执行/);
  await page.locator("#task-input").fill("@Co");
  await page.waitForSelector('#mention-menu:not([hidden]) [data-mention-id="codex-technical"]');
  await page.locator("#task-input").press("Enter");
  await page.locator("#task-input").press("End");
  await page.locator("#task-input").type("隔离 QA：点名协作但仍直达 Kimi");
  assert.match(await page.locator("#composer-target-name").textContent(), /^Kimi 前端/);
  assert.equal(await page.locator("#start-agent").inputValue(), "kimi-frontend");
  let submittedBody = null;
  const fakeRunId = "11111111-1111-4111-8111-111111111111";
  let releaseRoutePreview;
  let markRoutePreviewSeen;
  const routePreviewGate = new Promise((resolveGate) => { releaseRoutePreview = resolveGate; });
  const routePreviewSeen = new Promise((resolveSeen) => { markRoutePreviewSeen = resolveSeen; });
  await page.route("**/api/router/preview", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    markRoutePreviewSeen(route.request().postDataJSON());
    await routePreviewGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        selected: { id: "kimi-frontend", label: "Kimi Frontend", adapter: "kimi-headless-resume" },
        candidates: [],
        reasons: ["isolated browser payload QA"],
      }),
    });
  });
  await page.route(`**/api/runs/${fakeRunId}/mission`, async (route) => {
    const capturedAt = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schema: "514cc.mission-control.snapshot/v3",
        schemaVersion: 3,
        runId: fakeRunId,
        snapshotId: `mc-snapshot-${"0".repeat(64)}`,
        capturedAt,
        task: {
          title: "隔离 QA：验证 Kimi 请求体",
          status: "succeeded",
          progress: { round: 0, maxRounds: 0 },
          permissionMode: "plan",
          taskType: "qa",
          coordinatorId: "kimi-frontend",
          startAgentId: "kimi-frontend",
          executionOwnerId: "kimi-frontend",
        },
        tasks: [],
        attempts: [],
        messageRoutes: [],
        delegations: [],
        agents: [],
        connections: [],
        approvals: [],
        artifacts: [],
        evidence: {
          status: "complete",
          eventCount: 0,
          completedAttempts: 0,
          types: [],
          graph: { rootId: null, nodes: [], edges: [] },
        },
      }),
    });
  });
  await page.route(`**/api/runs/${fakeRunId}/events?*`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: "" });
  });
  const submitted = new Promise((resolveSubmitted) => {
    page.route("**/api/runs", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== "POST" || url.pathname !== "/api/runs") return route.continue();
      submittedBody = request.postDataJSON();
      const now = new Date().toISOString();
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          run: {
            id: fakeRunId,
            prompt: submittedBody.prompt,
            status: "succeeded",
            execute: false,
            teamId: submittedBody.teamId,
            coordinatorId: "claude-fable",
            teamMembers: ["claude-fable", "codex-technical", "grok-build", "kimi-frontend", "pi-resident"],
            startAgentId: submittedBody.startAgentId,
            executionOwnerId: submittedBody.startAgentId,
            createdAt: now,
            updatedAt: now,
          },
        }),
      });
      resolveSubmitted();
    }).catch(resolveSubmitted);
  });
  await page.locator("#submit-task-button").click();
  const previewBody = await routePreviewSeen;
  assert.equal(previewBody.startAgentId, "kimi-frontend");
  assert.deepEqual(previewBody.requestedAgentIds, ["codex-technical"]);
  await selectAgent(page, "codex-technical");
  await selectHiddenComposerSelect(page, "#task-effort", "ultra");
  assert.equal(await page.locator("#composer-collaborators").isHidden(), true, "switching the direct target removes its redundant collaborator chip");
  releaseRoutePreview();
  await submitted;
  assert.equal(submittedBody.startAgentId, "kimi-frontend");
  assert.deepEqual(submittedBody.requestedAgentIds, ["codex-technical"], "@ mention must not replace the active direct target");
  assert.equal(submittedBody.model, "kimi-code/k3");
  assert.equal(Object.hasOwn(submittedBody, "effort"), false, "unsupported Kimi effort must be omitted from POST body");
  assert.match(submittedBody.prompt, /@Codex 技术执行/, "the prompt and recipient set must come from the same pre-preview snapshot");

  const continuedBodies = [];
  await page.route(`**/api/runs/${fakeRunId}/messages`, async (route) => {
    const body = route.request().postDataJSON();
    continuedBodies.push(body);
    const now = new Date().toISOString();
    const waitingForClaude = continuedBodies.length === 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        run: {
          id: fakeRunId,
          title: "隔离 QA：目标标签续聊",
          prompt: submittedBody.prompt,
          status: waitingForClaude ? "waiting_agent" : "succeeded",
          teamId: submittedBody.teamId,
          coordinatorId: "claude-fable",
          teamMembers: ["claude-fable", "codex-technical", "grok-build", "kimi-frontend", "pi-resident"],
          startAgentId: submittedBody.startAgentId,
          executionOwnerId: submittedBody.startAgentId,
          pendingAsk: waitingForClaude ? {
            id: "ask-claude-qa-1",
            from: "claude-fable",
            text: "请确认最终方向",
            at: now,
          } : null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    });
  });

  await page.waitForSelector('#member-strip [data-composer-target="kimi-frontend"][aria-checked="true"]');
  const continuingControls = await page.evaluate(() => ({
    sessionLabel: document.querySelector("#composer-session-controls")?.textContent?.replace(/\s+/g, " ").trim(),
    sessionHidden: document.querySelector("#composer-session-controls")?.hidden,
    modelHidden: document.querySelector("#task-model-pick")?.hidden,
    effortHidden: document.querySelector("#task-effort-pick")?.hidden,
    permissionHidden: document.querySelector("#task-permission-pick")?.hidden,
  }));
  assert.equal(continuingControls.sessionHidden, false);
  assert.match(continuingControls.sessionLabel || "", /沿用 Kimi 前端.*会话配置/);
  assert.equal(continuingControls.modelHidden, true);
  assert.equal(continuingControls.effortHidden, true);
  assert.equal(continuingControls.permissionHidden, true);

  let messageRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === `/api/runs/${fakeRunId}/messages`);
  await page.locator("#task-input").fill("继续只问 Kimi");
  await page.locator("#submit-task-button").click();
  await messageRequest;
  assert.equal(continuedBodies[0].agentId, "kimi-frontend");
  assert.equal(continuedBodies[0].messageIntent, "steer");

  await page.waitForSelector('[data-focus-answer="claude-fable"]');
  assert.equal(await page.locator('#member-strip [data-composer-target="kimi-frontend"]').getAttribute("aria-checked"), "true");
  await page.locator('[data-focus-answer="claude-fable"]').click();
  await page.waitForSelector('#member-strip [data-composer-target="claude-fable"][aria-checked="true"]');
  const claudeTargetLabel = (await page.locator('#member-strip [data-composer-target="claude-fable"]').textContent())?.trim();
  assert.equal((await page.locator("#composer-target-name").textContent())?.trim(), claudeTargetLabel);
  assert.ok((await page.locator("#task-input").getAttribute("placeholder"))?.includes(`回答 ${claudeTargetLabel}`));
  messageRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === `/api/runs/${fakeRunId}/messages`);
  await page.locator("#task-input").fill("方向 A");
  await page.locator("#submit-task-button").click();
  await messageRequest;
  assert.equal(continuedBodies[1].agentId, "claude-fable", "answer card must switch to the asker tab");
  assert.equal(continuedBodies[1].messageIntent, "answer");
  assert.equal(continuedBodies[1].answerToAskId, "ask-claude-qa-1");
  await selectAgent(page, "kimi-frontend");
  await page.unroute("**/api/runs");
  await page.unroute("**/api/router/preview");

  return {
    kimiModels: kimiControls.models,
    kimiSlash,
    initialTarget,
    kimiPayload: { startAgentId: submittedBody.startAgentId, requestedAgentIds: submittedBody.requestedAgentIds, model: submittedBody.model, hasEffort: Object.hasOwn(submittedBody, "effort") },
    continuingControls,
    continuedTargets: continuedBodies.map((body) => body.agentId),
    codexEfforts,
    codexSlash,
    cliConsole: {
      team: teamConsole,
      claude: claudeConsole,
      kimi: kimiConsole,
      codex: codexConsole,
      pi: piConsole,
      defaultsPut: savedDefaultsBody,
      versionAction: { request: actionRequestBody, status: versionPayload.status, output: versionPayload.output },
      capabilityTarget,
    },
  };
}

async function verifyProviderDeck(page, outputDir) {
  await page.evaluate(() => { location.hash = "config/providers"; });
  await page.waitForSelector('#provider-app-bar [data-provider-app-tab="claude"]');
  await page.locator('#provider-app-bar [data-provider-app-tab="claude"]').click();
  await page.waitForSelector("#view-config:not([hidden]) #provider-columns .provider-global-empty, #view-config:not([hidden]) #provider-columns .provider-row-list", { timeout: 20_000 });
  await page.waitForSelector("#view-config:not([hidden]) #provider-columns .provider-global-empty", { timeout: 20_000 });
  const empty = await page.evaluate(() => ({
    globalEmptyCount: document.querySelectorAll("#provider-columns .provider-global-empty").length,
    headerCtaVisible: !document.querySelector("#provider-add-button")?.hidden,
    emptyCtaCount: document.querySelectorAll("#provider-columns [data-provider-add-app]").length,
    appColumns: document.querySelectorAll("#provider-columns .provider-app-col").length,
  }));
  assert.deepEqual(empty, { globalEmptyCount: 1, headerCtaVisible: false, emptyCtaCount: 1, appColumns: 0 });
  await page.screenshot({ path: resolve(outputDir, "providers-empty-desktop.png") });

  const provider = await api(page, "/api/providers", {
    method: "POST",
    body: {
      name: "QA Codex Connection",
      baseUrl: "https://qa.invalid/v1",
      apps: { codex: true },
    },
  });
  const providerRefresh = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/providers");
  await page.locator("#refresh-button").click();
  await providerRefresh;
  await page.locator('#provider-app-bar [data-provider-app-tab="codex"]').click();
  await page.waitForSelector("#provider-columns [data-provider-row], #provider-columns .provider-official-row", { timeout: 20_000 });
  const partial = await page.evaluate(() => ({
    appColumns: document.querySelectorAll("#provider-columns .provider-app-strip").length,
    emptyApps: document.querySelectorAll("#provider-columns .provider-empty-apps").length,
    headerCtaVisible: !document.querySelector("#provider-add-button")?.hidden,
  }));
  assert.equal(partial.appColumns, 1);
  assert.equal(partial.emptyApps, 1, "independent connections can switch between applications");
  assert.equal(partial.headerCtaVisible, true);
  await page.locator("#provider-add-button").click();
  await page.waitForSelector("#provider-dialog[open]");
  assert.match(await page.locator("#provider-dialog-title").textContent(), /Codex/);
  await page.locator("#provider-close-button").click();
  await page.screenshot({ path: resolve(outputDir, "providers-partial-desktop.png") });
  return { providerId: provider.id, empty, partial };
}

async function verifyRuntimeSeatEditor(page, providerId, outputDir) {
  await page.evaluate(() => { location.hash = "config/sources"; });
  await page.waitForSelector("#view-config:not([hidden]) #runtime-seat-list [data-runtime-seat-id]", { timeout: 30_000 });
  await page.locator("#runtime-seat-new-button").click();
  await page.waitForSelector("#runtime-seat-form:not([hidden])");

  const adapters = await page.locator("#runtime-seat-adapter-select option").evaluateAll((options) => options.map((option) => ({ value: option.value, label: option.textContent.trim() })));
  assert.equal(adapters.some((entry) => /openclaw|hermes/i.test(`${entry.value} ${entry.label}`)), false, "configuration-only sources must not appear as executable adapters");
  assert.equal(adapters.some((entry) => entry.value === "opencode-run-json"), true, "opencode-run-json must be selectable as an execution adapter");

  await page.locator("#runtime-seat-adapter-select").selectOption("codex-app-server");
  await page.locator("#runtime-seat-provider-select").selectOption(providerId);
  await page.locator("#runtime-seat-model-input").fill("gpt-5.6-sol");
  await page.locator("#runtime-seat-effort-input").selectOption("ultra");
  await page.locator("#runtime-seat-permission-select").selectOption("workspace-write");
  await page.locator("#runtime-seat-adapter-select").selectOption("kimi-headless-resume");

  const kimiEditor = await page.evaluate(() => ({
    command: document.querySelector("#runtime-seat-command-input")?.value,
    commandHelp: document.querySelector("#runtime-seat-command-help")?.textContent?.trim(),
    provider: document.querySelector("#runtime-seat-provider-select")?.value,
    providerDisabled: document.querySelector("#runtime-seat-provider-select")?.disabled,
    providerScope: document.querySelector("#runtime-seat-provider-scope")?.textContent?.trim(),
    model: document.querySelector("#runtime-seat-model-input")?.value,
    modelOptions: [...document.querySelectorAll("#runtime-seat-model-options option")].map((option) => option.value),
    modelScope: document.querySelector("#runtime-seat-model-scope")?.textContent?.trim(),
    effort: document.querySelector("#runtime-seat-effort-input")?.value,
    effortDisabled: document.querySelector("#runtime-seat-effort-input")?.disabled,
    effortOptions: [...document.querySelectorAll("#runtime-seat-effort-options option")].map((option) => option.value),
    effortScope: document.querySelector("#runtime-seat-effort-scope")?.textContent?.trim(),
    permission: document.querySelector("#runtime-seat-permission-select")?.value,
    permissionOptions: [...document.querySelector("#runtime-seat-permission-select").options].map((option) => option.value),
    details: document.querySelector("#runtime-seat-adapter-details")?.textContent?.replace(/\s+/g, " ").trim(),
  }));
  assert.equal(kimiEditor.command, "kimi");
  assert.match(kimiEditor.commandHelp || "", /不要在此附加参数/);
  assert.equal(kimiEditor.provider, "");
  assert.equal(kimiEditor.providerDisabled, true);
  assert.match(kimiEditor.providerScope || "", /CLI 自身配置管理/);
  assert.equal(kimiEditor.model, "");
  assert.deepEqual(kimiEditor.modelOptions, KIMI_MODELS);
  assert.match(kimiEditor.modelScope || "", /4 个已知模型/);
  assert.equal(kimiEditor.effort, "");
  assert.equal(kimiEditor.effortDisabled, false);
  assert.deepEqual(
    kimiEditor.effortOptions.filter(Boolean),
    ["low", "high", "max"],
    "kimi effort 编辑器必须暴露 env 注入的三档",
  );
  assert.equal(kimiEditor.permissionOptions.includes("workspace-write"), false);
  assert.deepEqual(
    kimiEditor.permissionOptions,
    ["plan", "read-only", "native:yolo", "native:auto"],
    "kimi 席位编辑器权限选项=治理两档+原生 yolo/auto",
  );
  assert.ok(["plan", "read-only"].includes(kimiEditor.permission));
  assert.match(kimiEditor.details || "", /写权限保持 fail-closed/);
  await page.screenshot({ path: resolve(outputDir, "runtime-seat-kimi-desktop.png"), fullPage: true });
  return { adapters, kimiEditor };
}

async function verifyMemberRebinding(page, outputDir) {
  await page.evaluate(() => { location.hash = "team"; });
  await page.waitForSelector("#view-team:not([hidden]) #team-surface-members-tab", { timeout: 30_000 });
  await page.locator("#team-surface-members-tab").click();
  await page.waitForSelector('#team-surface-members:not([hidden]) #member-library-list [data-member-id="codex-technical"]', { timeout: 30_000 });
  await page.locator('#member-library-list [data-member-id="codex-technical"]').click();
  await page.waitForFunction(() => (
    document.querySelector("#member-editor-body")?.hidden === false
      && document.querySelector("#member-id-value")?.textContent?.trim() === "codex-technical"
  ), undefined, { timeout: 30_000 });
  await page.locator("#member-default-model-input").fill("gpt-5.6-sol");
  await page.locator("#member-default-effort-select").selectOption("ultra");
  await page.locator("#member-seat-picker-trigger").click();
  await page.waitForSelector('#member-seat-picker-panel:not([hidden]) .member-seat-picker-option[data-seat-id="kimi-frontend"]', { timeout: 10_000 });
  await page.locator('.member-seat-picker-option[data-seat-id="kimi-frontend"]').click();
  await page.waitForFunction(() => (
    document.querySelector("#member-runtime-profile-select")?.value === "kimi-frontend"
      && document.querySelector("#member-seat-picker-panel")?.hidden === true
  ));

  const rebound = await page.evaluate(() => ({
    runtimeProfileId: document.querySelector("#member-runtime-profile-select")?.value,
    defaultModel: document.querySelector("#member-default-model-input")?.value,
    defaultEffort: document.querySelector("#member-default-effort-select")?.value,
    effortOptions: [...document.querySelectorAll("#member-default-effort-select option")].map((option) => option.value),
    modelOptions: [...document.querySelectorAll("#member-model-options option")].map((option) => option.value).filter(Boolean),
    runtimeFacts: Object.fromEntries([...document.querySelectorAll("#member-runtime-facts .member-runtime-fact")].map((fact) => [
      fact.querySelector("dt")?.textContent?.trim(),
      fact.querySelector("dd")?.textContent?.trim(),
    ])),
    runtimeStatus: document.querySelector("#member-runtime-status")?.textContent?.trim(),
  }));
  assert.equal(rebound.runtimeProfileId, "kimi-frontend");
  assert.equal(rebound.defaultModel, "");
  assert.equal(rebound.defaultEffort, "");
  assert.deepEqual(rebound.effortOptions, [""]);
  assert.deepEqual(rebound.modelOptions, KIMI_MODELS);
  assert.equal(rebound.runtimeFacts.Provider, "moonshot");
  assert.equal(rebound.runtimeFacts.Adapter, "Kimi Code");
  assert.equal(rebound.runtimeFacts["连接作用域"], "cli-managed");
  assert.equal(rebound.runtimeStatus, "执行席位可用");
  await page.screenshot({ path: resolve(outputDir, "member-rebind-kimi-desktop.png"), fullPage: true });
  return rebound;
}

async function verifyMobile({ page, outputDir, composerOnly = false }) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelectorAll("#toast-region .toast").length <= 2);
  const toastState = await page.locator("#toast-region .toast").evaluateAll((items) => items.map((item) => item.textContent.trim()));
  assert.ok(toastState.length <= 2, `mobile toast stack must stay compact: ${JSON.stringify(toastState)}`);
  assert.equal(new Set(toastState).size, toastState.length, `mobile toast stack must deduplicate repeated notices: ${JSON.stringify(toastState)}`);
  await page.evaluate(() => { location.hash = "workbench"; });
  await page.waitForSelector("#view-workbench:not([hidden])", { timeout: 20_000 });
  if (await page.locator("#composer-new-task").isVisible()) await page.locator("#composer-new-task").click();
  assert.equal(await page.locator("#start-agent").inputValue(), "kimi-frontend");
  await slashLabels(page, "/");
  const menuGeometry = await page.evaluate(() => {
    const menuElement = document.querySelector("#slash-menu");
    const menu = menuElement.getBoundingClientRect();
    const composer = document.querySelector(".composer-shell").getBoundingClientRect();
    const targetStrip = document.querySelector("#member-strip");
    const activeTarget = targetStrip?.querySelector("[data-composer-target][aria-checked='true']");
    const strip = targetStrip?.getBoundingClientRect();
    const target = activeTarget?.getBoundingClientRect();
    const hit = document.elementFromPoint(menu.left + (menu.width / 2), menu.top + Math.min(24, menu.height / 2));
    return {
      menu: { left: menu.left, top: menu.top, right: menu.right, bottom: menu.bottom, width: menu.width, height: menu.height },
      composer: { top: composer.top, bottom: composer.bottom },
      targetStrip: strip ? { left: strip.left, right: strip.right, scrollLeft: targetStrip.scrollLeft } : null,
      activeTarget: target ? { id: activeTarget.dataset.composerTarget, left: target.left, right: target.right } : null,
      viewport: { width: innerWidth, height: innerHeight },
      activeVisible: Boolean(document.querySelector("#slash-menu [aria-selected='true']")),
      topLayerVisible: Boolean(hit?.closest("#slash-menu") === menuElement),
    };
  });
  assert.ok(menuGeometry.menu.left >= -1 && menuGeometry.menu.right <= menuGeometry.viewport.width + 1, `mobile slash menu horizontal bounds: ${JSON.stringify(menuGeometry)}`);
  assert.ok(menuGeometry.menu.top >= -1 && menuGeometry.menu.bottom <= menuGeometry.viewport.height + 1, `mobile slash menu vertical bounds: ${JSON.stringify(menuGeometry)}`);
  assert.ok(menuGeometry.menu.bottom <= menuGeometry.composer.top, `mobile slash menu overlaps composer: ${JSON.stringify(menuGeometry)}`);
  assert.equal(menuGeometry.activeVisible, true);
  assert.equal(menuGeometry.topLayerVisible, true, `mobile slash menu is occluded: ${JSON.stringify(menuGeometry)}`);
  assert.equal(menuGeometry.activeTarget?.id, "kimi-frontend");
  assert.ok(
    menuGeometry.activeTarget.left >= menuGeometry.targetStrip.left - 1
      && menuGeometry.activeTarget.right <= menuGeometry.targetStrip.right + 1,
    `active direct target is outside the mobile target strip: ${JSON.stringify(menuGeometry)}`,
  );
  await page.locator("#task-input").press("Escape");
  const windowScrollY = await page.evaluate(() => window.scrollY);
  await page.locator('#member-strip [data-composer-target="kimi-frontend"]').focus();
  await page.locator('#member-strip [data-composer-target="kimi-frontend"]').press("End");
  await page.waitForSelector('#member-strip [data-composer-target="pi-resident"][aria-checked="true"]');
  const endTargetGeometry = await page.evaluate(() => {
    const strip = document.querySelector("#member-strip");
    const active = strip?.querySelector('[data-composer-target][aria-checked="true"]');
    const stripRect = strip?.getBoundingClientRect();
    const activeRect = active?.getBoundingClientRect();
    return {
      id: active?.dataset.composerTarget,
      strip: stripRect ? { left: stripRect.left, right: stripRect.right } : null,
      active: activeRect ? { left: activeRect.left, right: activeRect.right } : null,
      scrollY: window.scrollY,
    };
  });
  assert.equal(endTargetGeometry.id, "pi-resident");
  assert.ok(
    endTargetGeometry.active.left >= endTargetGeometry.strip.left - 1
      && endTargetGeometry.active.right <= endTargetGeometry.strip.right + 1,
    `End-selected target is outside the mobile strip: ${JSON.stringify(endTargetGeometry)}`,
  );
  assert.equal(endTargetGeometry.scrollY, windowScrollY, "horizontal target navigation must not move the page vertically");
  await page.locator('#member-strip [data-composer-target="pi-resident"]').press("Home");
  await page.waitForSelector('#member-strip [data-composer-target="claude-fable"][aria-checked="true"]');
  const homeTargetVisible = await page.locator('#member-strip [data-composer-target="claude-fable"]').evaluate((active) => {
    const strip = active.closest("#member-strip").getBoundingClientRect();
    const target = active.getBoundingClientRect();
    return target.left >= strip.left - 1 && target.right <= strip.right + 1;
  });
  assert.equal(homeTargetVisible, true, "Home-selected target must scroll back into view");
  await selectAgent(page, "kimi-frontend");
  const workbenchGeometry = await assertNoHorizontalOverflow(page, "mobile composer");
  await page.screenshot({ path: resolve(outputDir, "composer-kimi-mobile.png") });

  await selectAgent(page, "codex-technical");
  await selectComposerCliTab(page, "connection");
  const connectionGeometry = await page.evaluate(() => {
    const viewport = { width: innerWidth, height: innerHeight };
    const panel = document.querySelector("#composer-cli-console-panel")?.getBoundingClientRect();
    const connection = document.querySelector("#composer-cli-panel-connection")?.getBoundingClientRect();
    const actions = [...document.querySelectorAll("#composer-cli-panel-connection button")].map((button) => {
      const rect = button.getBoundingClientRect();
      return { text: button.textContent.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    return {
      viewport,
      panel: panel ? { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom } : null,
      connection: connection ? { left: connection.left, right: connection.right, top: connection.top, bottom: connection.bottom } : null,
      actions,
    };
  });
  assert.ok(connectionGeometry.panel?.left >= -1 && connectionGeometry.panel?.right <= 391, `mobile CLI panel bounds: ${JSON.stringify(connectionGeometry)}`);
  assert.ok(connectionGeometry.connection?.left >= -1 && connectionGeometry.connection?.right <= 391, `mobile connection page bounds: ${JSON.stringify(connectionGeometry)}`);
  assert.ok(connectionGeometry.actions.every((action) => action.left >= -1 && action.right <= 391), `mobile connection actions overflow: ${JSON.stringify(connectionGeometry)}`);
  const connectionWorkbenchGeometry = await assertNoHorizontalOverflow(page, "mobile CLI connection page");
  await page.screenshot({ path: resolve(outputDir, "composer-codex-connection-mobile.png") });

  if (composerOnly) return { toastState, menuGeometry, endTargetGeometry, homeTargetVisible, workbenchGeometry, connectionGeometry, connectionWorkbenchGeometry, seatGeometry: null, formBounds: null };

  await page.evaluate(() => { location.hash = "config/sources"; });
  await page.waitForSelector("#runtime-seat-list [data-runtime-seat-id]", { timeout: 30_000 });
  if (await page.locator("#runtime-seat-form").isHidden()) await page.locator("#runtime-seat-new-button").click();
  await page.waitForSelector("#runtime-seat-form:not([hidden])");
  if (await page.locator("#runtime-seat-adapter-select").inputValue() !== "kimi-headless-resume") {
    await page.locator("#runtime-seat-adapter-select").selectOption("kimi-headless-resume");
  }
  const seatGeometry = await assertNoHorizontalOverflow(page, "mobile runtime seat");
  const formBounds = await page.locator("#runtime-seat-form").boundingBox();
  assert.ok(formBounds && formBounds.x >= -1 && formBounds.x + formBounds.width <= 391, `mobile runtime seat form bounds: ${JSON.stringify(formBounds)}`);
  await page.screenshot({ path: resolve(outputDir, "runtime-seat-kimi-mobile.png"), fullPage: true });
  return { toastState, menuGeometry, workbenchGeometry, connectionGeometry, connectionWorkbenchGeometry, seatGeometry, formBounds };
}

export async function runCliSeatQa({ outputDir, composerOnly = false } = parseArgs()) {
  await mkdir(outputDir, { recursive: true });
  let result = null;
  await withDisposableQaRoot(async (qaRoot) => {
    const token = randomBytes(32).toString("base64url");
    const isolatedRepoRoot = await createIsolatedQaRepo(qaRoot);
    await pinIsolatedDiscoveryFallback(isolatedRepoRoot);
    const env = buildIsolatedServerEnv({ qaRoot, token, testRepoRoot: isolatedRepoRoot });
    await Promise.all([
      mkdir(env.CONTROL_CENTER_DATA_DIR, { recursive: true }),
      mkdir(env.CONTROL_CENTER_RUNTIME_HOME, { recursive: true }),
      mkdir(env.APPDATA, { recursive: true }),
      mkdir(env.LOCALAPPDATA, { recursive: true }),
      mkdir(env.XDG_CONFIG_HOME, { recursive: true }),
      mkdir(env.XDG_DATA_HOME, { recursive: true }),
      mkdir(env.XDG_CACHE_HOME, { recursive: true }),
    ]);
    const diagnostics = [];
    const allowedGateBlocks = [];
    const watcher = diagnosticsWatcher(diagnostics, allowedGateBlocks);
    let browser = null;
    let server = null;
    let failure = null;
    const cleanupErrors = [];
    let shutdown = null;
    try {
      server = spawnTestServer({ env, cwd: appRoot });
      const bootstrapUrl = await waitForUrl(server, { timeoutMs: 30_000 });
      const parsed = new URL(bootstrapUrl);
      assert.equal(parsed.hostname, "127.0.0.1");
      assert.ok(Number(parsed.port) > 0);
      browser = await chromium.launch({ headless: true });
      const desktop = await browser.newPage({ viewport: { width: 1512, height: 945 } });
      watcher.watchPage(desktop, "desktop");
      await desktop.goto(bootstrapUrl, { waitUntil: "domcontentloaded" });
      await desktop.waitForSelector("#api-connection-badge.is-ok", { timeout: 30_000 });
      assert.equal(await desktop.evaluate(() => sessionStorage.getItem("514cc-control-token")), token);
      const composer = await verifyComposer(desktop, outputDir, isolatedRepoRoot);
      let providers = null;
      let runtimeSeat = null;
      let memberRebinding = null;
      if (!composerOnly) {
        await desktop.evaluate(() => {
          sessionStorage.removeItem("514cc-selected-run");
          location.hash = "workbench";
        });
        providers = await verifyProviderDeck(desktop, outputDir);
        runtimeSeat = await verifyRuntimeSeatEditor(desktop, providers.providerId, outputDir);
        memberRebinding = await verifyMemberRebinding(desktop, outputDir);
      }
      const mobile = await verifyMobile({ page: desktop, outputDir, composerOnly });
      await desktop.close();
      result = {
        ok: true,
        isolation: {
          selfSpawned: true,
          pid: server.pid,
          origin: parsed.origin,
          randomPort: Number(parsed.port),
          randomToken: true,
          dataRootIsolated: true,
          runtimeHomeIsolated: true,
          modelDiscoveryFallbackPinned: true,
          gracefulShutdown: false,
          tempRootRemoved: false,
        },
        composer,
        providers: providers ? { empty: providers.empty, partial: providers.partial } : null,
        runtimeSeat,
        memberRebinding,
        mobile,
        diagnostics: [],
        allowedGateBlocks: [],
        screenshots: [
          "composer-kimi-slash-desktop.png",
          "composer-kimi-desktop.png",
          "composer-kimi-collaborator-desktop.png",
          "composer-codex-defaults-desktop.png",
          "composer-codex-connection-desktop.png",
          "composer-codex-capabilities-desktop.png",
          "composer-kimi-mobile.png",
          "composer-codex-connection-mobile.png",
          ...(composerOnly ? [] : [
            "providers-empty-desktop.png",
            "providers-partial-desktop.png",
            "runtime-seat-kimi-desktop.png",
            "member-rebind-kimi-desktop.png",
            "runtime-seat-kimi-mobile.png",
          ]),
        ],
      };
    } catch (error) {
      failure = error;
    } finally {
      watcher.beginClosing();
      if (browser) {
        try { await browser.close(); } catch (error) { cleanupErrors.push(error); }
      }
      try {
        await watcher.settle();
        assert.deepEqual(diagnostics, [], `browser diagnostics: ${diagnostics.join(" | ")}`);
        if (result) {
          result.diagnostics = [...diagnostics];
          result.allowedGateBlocks = [...new Set(allowedGateBlocks)].sort();
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (server) {
        try { shutdown = await stopTestServer(server, { token, timeoutMs: 8_000 }); }
        catch (error) { cleanupErrors.push(error); }
      }
    }
    if (failure || cleanupErrors.length) {
      throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "CLI seat browser QA failed");
    }
    result.isolation.gracefulShutdown = shutdown?.graceful === true && shutdown?.fallback === false;
  });
  result.isolation.tempRootRemoved = true;
  assert.equal(result.isolation.gracefulShutdown, true);
  assert.equal(result.isolation.tempRootRemoved, true);
  return result;
}

async function main() {
  const options = parseArgs();
  const result = await runCliSeatQa(options);
  const reportPath = resolve(options.outputDir, "result.json");
  writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const summary = JSON.stringify({
    ok: result.ok,
    diagnostics: result.diagnostics.length,
    gracefulShutdown: result.isolation.gracefulShutdown,
    tempRootRemoved: result.isolation.tempRootRemoved,
    reportPath,
  });
  writeFileSync(process.stdout.fd, `${summary}\n`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  // Windows 工具宿主可能持续持有 stdout/stderr pipe；此处所有浏览器、服务与临时根
  // 已完成机械清理断言；短暂排空 close 事件后，显式退出让调用方可靠读回成功状态。
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
