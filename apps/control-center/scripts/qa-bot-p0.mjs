#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const outputDir = resolve(tmpdir(), `514cc-qa-bot-p0-artifacts-${Date.now()}-${process.pid}`);
const token = "bot-p0-qa-token-0123456789abcdef";

function removeTree(path) {
  return rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}

const profileScores = new Map([
  ["claude-fable", { quality: 0.96, speed: 0.68, costTier: 4 }],
  ["codex-technical", { quality: 0.97, speed: 0.74, costTier: 4 }],
  ["grok-search", { quality: 0.84, speed: 0.93, costTier: 3 }],
  ["grok-build", { quality: 0.82, speed: 0.94, costTier: 3 }],
  ["kimi-frontend", { quality: 0.82, speed: 0.88, costTier: 2 }],
  ["pi-resident", { quality: 0.8, speed: 0.86, costTier: 2 }],
]);

function qaModelProfiles() {
  return testModelProfiles().map((profile) => ({
    ...profile,
    ...(profile.id === "grok-build" ? { command: process.execPath } : {}),
    capabilities: ["*"],
    ...profileScores.get(profile.id),
    evidence: [{ source: "qa-fixture", detail: "isolated Bot P0 browser acceptance", verifiedAt: "2026-08-25" }],
  }));
}

async function writeConfig(repoRoot) {
  await mkdir(resolve(repoRoot, "config/control-center"), { recursive: true });
  await writeFile(resolve(repoRoot, "config/app.json"), '{"enabled":true}\n');
  await writeFile(resolve(repoRoot, "config/control-center/models.json"), JSON.stringify({
    version: 1,
    profiles: qaModelProfiles(),
  }));
  await writeFile(resolve(repoRoot, "config/control-center/routing.json"), JSON.stringify({
    version: 1,
    primaryCoordinator: "claude-fable",
    technicalExecutor: "codex-technical",
    maxRounds: 6,
    maxDepth: 2,
    maxParallelAgents: 4,
    requireHealthyProvider: false,
    failOnUnavailableExplicitProvider: false,
    weights: { quality: 0.44, speed: 0.26, health: 0.22, cost: 0.08 },
    rules: [],
    independentPass: { requiredFor: [], mustDifferFromPrimary: true },
  }));
  await writeFile(resolve(repoRoot, "config/control-center/permissions.json"), JSON.stringify({
    version: 1,
    defaultMode: "plan",
    modes: {
      plan: { write: false, approvalRequired: false },
      build: { write: "workspace", approvalRequired: true },
    },
    limits: { maxRounds: 6, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 10_000 },
    approval: { ttlMs: 60_000 },
  }));
  await writeFile(resolve(repoRoot, "config/control-center/sources.json"), JSON.stringify({
    version: 1,
    explicit: [
      { id: "control.models", path: "config/control-center/models.json", label: "models", kind: "json", scope: "repo", critical: true },
      { id: "control.routing", path: "config/control-center/routing.json", label: "routing", kind: "json", scope: "repo", critical: true },
      { id: "control.permissions", path: "config/control-center/permissions.json", label: "permissions", kind: "json", scope: "repo", critical: true },
      { id: "control.sources", path: "config/control-center/sources.json", label: "sources", kind: "json", scope: "repo", critical: true },
    ],
    discover: [],
    runtime: [],
  }));
}

async function main() {
  const root = await mkdtemp(resolve(tmpdir(), "514cc-qa-bot-p0-"));
  const repoRoot = resolve(root, "repo");
  const dataRoot = resolve(root, "data");
  const fakeHome = resolve(root, "home");
  await writeConfig(repoRoot);
  await mkdir(fakeHome, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const child = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: token,
      CONTROL_CENTER_REPO_ROOT: repoRoot,
      CONTROL_CENTER_DATA_DIR: dataRoot,
      CONTROL_CENTER_PORT: "0",
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
  });
  let browser;
  try {
    const bootstrapUrl = await waitForUrl(child);
    const origin = new URL(bootstrapUrl).origin;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const api = async (path, { method = "GET", body } = {}) => {
      const response = await fetch(new URL(path, origin), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json();
      assert.ok(response.ok, `${method} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
      return payload;
    };
    const createConversation = async (title, directMemberId) => (await api("/api/conversations", {
      method: "POST",
      body: { kind: "direct", title, directMemberId },
    })).conversation;
    const createRun = async (conversation, prompt) => api("/api/runs", {
      method: "POST",
      body: {
        prompt,
        taskType: "planning",
        execute: false,
        permissionMode: "plan",
        orchestrationMode: "pipeline",
        conversationId: conversation.id,
        conversationKind: "direct",
        startAgentId: conversation.directMemberId,
      },
    });

    const conversationA = await createConversation("A conversation", "codex-technical");
    const runA = await createRun(conversationA, "P0_A_LATE_MARKER");
    let runAHistory = null;
    const conversationB = await createConversation("B conversation", "codex-technical");
    const runB = await createRun(conversationB, "P0_B_ACTIVE_MARKER");
    const messageConversation = await createConversation("Conversation message admission", "grok-build");
    const hiddenConversation = await createConversation("Hidden conversation", "claude-fable");
    const hidden = (await api(`/api/conversations/${hiddenConversation.id}`, {
      method: "PATCH",
      body: { expectedRevision: hiddenConversation.revision, hidden: true },
    })).conversation;
    const workspaceProject = (await api("/api/projects", {
      method: "POST",
      body: { title: "Conversation UX workspace", cwd: repoRoot },
    })).project;
    const workspaceConversation = (await api("/api/conversations", {
      method: "POST",
      body: {
        kind: "workspace_group",
        title: "Stable collaboration workspace",
        projectId: workspaceProject.projectId,
        roomRole: "task",
        memberIds: ["codex-technical", "grok-build"],
      },
    })).conversation;

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const consoleErrors = [];
    const pageErrors = [];
    const failedResponses = [];
    const expectedGateBlocks = [];
    const responseChecks = [];
    page.on("console", (message) => {
      if (message.type() === "error" && !/^Failed to load resource:/.test(message.text())) {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() < 400) return;
      responseChecks.push((async () => {
        const url = new URL(response.url());
        const failure = {
          method: response.request().method(),
          path: `${url.pathname}${url.search}`,
          status: response.status(),
        };
        const payload = await response.json().catch(() => null);
        const code = payload?.code ?? payload?.error?.code ?? null;
        if (failure.status === 501 && code === "REMOTE_GATE_BLOCKED") {
          expectedGateBlocks.push({ ...failure, code });
          return;
        }
        failedResponses.push({ ...failure, code });
      })());
    });
    // 本套验收聚焦 Conversation/Run 导航；环境舱另有专门 QA。隔离其探针请求，避免
    // reload 时无关的 EVENT_INDEX_BUSY 竞争污染会话入口结论。
    await page.route("**/api/workbench/environment**", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ schema: "514cc.workbench.environment/v1", available: false, source: "conversation-nav-qa" }),
    }));
    await page.addInitScript((accessToken) => sessionStorage.setItem("514cc-control-token", accessToken), token);
    await page.goto(`${origin}/#bot`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true,
      null,
      { timeout: 30_000 },
    );
    await page.waitForSelector(`[data-bot-tree-section="inactive"] [data-bot-conversation="${hidden.id}"]`, { timeout: 20_000 });

    const restoreRequest = page.waitForRequest((request) => (
      request.method() === "PATCH"
      && new URL(request.url()).pathname === `/api/conversations/${hidden.id}`
    ));
    await page.locator(`[data-bot-tree-section="inactive"] [data-bot-conversation="${hidden.id}"]`).click();
    const restoredRequest = await restoreRequest;
    assert.deepEqual(JSON.parse(restoredRequest.postData() || "{}"), {
      expectedRevision: hidden.revision,
      hidden: false,
    });
    await page.waitForSelector(`[data-bot-tree-section="inactive"] [data-bot-conversation="${hidden.id}"]`, { state: "detached" });
    await page.waitForSelector(`[data-bot-conversation="${hidden.id}"].is-active`);

    const rowA = page.locator(`[data-bot-conversation="${conversationA.id}"]`);
    const rowB = page.locator(`[data-bot-conversation="${conversationB.id}"]`);
    assert.equal(await rowA.count(), 1);
    assert.equal(await rowB.count(), 1);
    assert.match(await rowA.textContent() || "", /A conversation/);
    assert.match(await rowB.textContent() || "", /B conversation/);
    await page.locator("#bot-agent-search").fill(conversationA.id.slice(0, 8));
    await page.waitForFunction(({ a, b }) => {
      const visible = (id) => {
        const node = document.querySelector(`[data-bot-conversation="${id}"]`);
        return Boolean(node && !node.hidden && node.offsetParent !== null);
      };
      return visible(a) && !visible(b);
    }, { a: conversationA.id, b: conversationB.id });
    await page.locator("#bot-agent-search").fill("");
    await page.waitForFunction(({ a, b }) => {
      return Boolean(document.querySelector(`[data-bot-conversation="${a}"]`))
        && Boolean(document.querySelector(`[data-bot-conversation="${b}"]`));
    }, { a: conversationA.id, b: conversationB.id });
    await page.locator("#bot-surface-tab-contacts").click();
    await page.locator('[data-bot-contact-chat="codex-technical"]').click();
    await page.waitForSelector("#context-menu:not([hidden])");
    assert.match(await page.locator("#context-menu").textContent() || "", /A conversation/);
    assert.match(await page.locator("#context-menu").textContent() || "", /B conversation/);
    await page.locator("#context-menu [role='menuitem']", { hasText: "A conversation" }).click();
    await page.waitForSelector(`[data-bot-conversation="${conversationA.id}"].is-active`);
    assert.equal(await page.locator("#bot-surface-chats").isHidden(), false);
    const directRows = page.locator('[data-bot-tree-section="direct"] [data-bot-tree-row]');
    assert.ok(await directRows.count() >= 2);
    await directRows.nth(0).focus();
    const firstFocusedConversationId = await directRows.nth(0).getAttribute("data-bot-conversation");
    await page.keyboard.press("ArrowDown");
    const secondFocusedConversationId = await page.evaluate(() => document.activeElement?.getAttribute("data-bot-conversation"));
    const secondFocusedRole = await page.evaluate(() => document.activeElement?.getAttribute("role"));
    assert.notEqual(secondFocusedConversationId, firstFocusedConversationId);
    assert.equal(secondFocusedRole, "treeitem");
    await directRows.nth(1).focus();
    const enteredConversationId = await directRows.nth(1).getAttribute("data-bot-conversation");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const enteredRowState = await page.locator(`[data-bot-conversation="${enteredConversationId}"]`).evaluate((node) => ({
      active: node.classList.contains("is-active"),
      ariaSelected: node.getAttribute("aria-selected"),
    }));
    assert.equal(enteredRowState.active, true, JSON.stringify(enteredRowState));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true,
      null,
      { timeout: 30_000 },
    );
    await page.waitForFunction((conversationId) => {
      const view = document.querySelector("#view-bot");
      const chats = document.querySelector("#bot-surface-chats");
      const row = document.querySelector(`[data-bot-conversation="${conversationId}"]`);
      return Boolean(view && !view.hidden && chats && !chats.hidden && row && !row.hidden && row.offsetParent !== null);
    }, conversationB.id, { timeout: 20_000 });
    await rowB.click({ timeout: 3_000 });
    await page.waitForFunction((marker) => document.querySelector("#bot-message-stream")?.textContent?.includes(marker), "P0_B_ACTIVE_MARKER");

    let releaseLateResponse;
    let signalLateRequest;
    const lateResponseGate = new Promise((resolveGate) => { releaseLateResponse = resolveGate; });
    const lateRequestSeen = new Promise((resolveSeen) => { signalLateRequest = resolveSeen; });
    const lateEventsPath = `/api/runs/${runA.id}/events`;
    await page.route(`**${lateEventsPath}*`, async (route) => {
      signalLateRequest();
      await lateResponseGate;
      await route.continue();
    });
    await rowA.click();
    await lateRequestSeen;
    await rowB.click();
    await page.waitForFunction((marker) => document.querySelector("#bot-message-stream")?.textContent?.includes(marker), "P0_B_ACTIVE_MARKER");
    releaseLateResponse();
    await page.waitForTimeout(500);
    await Promise.all(responseChecks);

    const streamText = await page.locator("#bot-message-stream").textContent();
    assert.match(streamText || "", /P0_B_ACTIVE_MARKER/);
    assert.doesNotMatch(streamText || "", /P0_A_LATE_MARKER/);
    assert.equal(await rowB.getAttribute("class").then((value) => value?.includes("is-active")), true);
    const conversationWidthBeforeInspector = await page.locator(".bot-conversation").evaluate((node) => node.getBoundingClientRect().width);
    await page.locator("#bot-agent-info-button").click();
    await page.waitForSelector("#bot-agent-panel:not([hidden])");
    const conversationWidthWithInspector = await page.locator(".bot-conversation").evaluate((node) => node.getBoundingClientRect().width);
    assert.equal(conversationWidthWithInspector, conversationWidthBeforeInspector, "opening the inspector must not reflow the Conversation column");
    const runQueue = page.locator("#bot-run-queue");
    const queueItems = runQueue.locator(".bot-run-queue-item");
    await page.waitForFunction(({ activeRunId, delayedRunId }) => {
      const ids = [...document.querySelectorAll("#bot-run-queue .bot-run-queue-item")]
        .map((node) => node.getAttribute("data-bot-run-id"));
      return ids.includes(activeRunId) && !ids.includes(delayedRunId);
    }, { activeRunId: runB.id, delayedRunId: runA.id });
    assert.equal(await queueItems.count(), 1);
    assert.equal(await queueItems.first().getAttribute("data-bot-run-id"), runB.id);
    assert.match(await runQueue.textContent() || "", /P0_B_ACTIVE_MARKER/);
    assert.doesNotMatch(await runQueue.textContent() || "", /P0_A_LATE_MARKER/);
    assert.equal((await queueItems.first().getAttribute("class"))?.includes("is-current"), true);

    runAHistory = await createRun(conversationA, "P0_A_HISTORY_MARKER");
    await page.route("**/api/runs", async (route) => {
      if (route.request().method() !== "GET" || new URL(route.request().url()).pathname !== "/api/runs") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const payload = await response.json();
      payload.runs = (payload.runs || []).filter((run) => String(run.id) !== String(runA.id));
      await route.fulfill({ response, json: payload });
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true,
      null,
      { timeout: 30_000 },
    );
    await page.waitForSelector(`[data-bot-conversation="${conversationA.id}"]`, { timeout: 20_000 });
    await page.locator(`[data-bot-conversation="${conversationA.id}"]`).click();
    await page.locator("#bot-agent-info-button").click();
    await page.waitForSelector("#bot-agent-panel:not([hidden])");
    const historyItem = page.locator(`[data-bot-run-id="${runA.id}"]`);
    const historyRead = page.waitForResponse((response) => (
      response.request().method() === "GET"
      && new URL(response.url()).pathname === `/api/runs/${runA.id}`
    ));
    await historyItem.click();
    assert.equal((await historyRead).status(), 200);
    await page.waitForFunction((runId) => document.querySelector(`[data-bot-run-id="${runId}"]`)?.classList.contains("is-current") === true, runA.id);
    await page.waitForFunction(
      (marker) => document.querySelector("#bot-message-stream")?.textContent?.includes(marker) === true,
      "P0_A_LATE_MARKER",
      { timeout: 10_000 },
    );
    assert.match(await page.locator("#bot-message-stream").textContent() || "", /P0_A_LATE_MARKER/);
    assert.doesNotMatch(await page.locator("#bot-message-stream").textContent() || "", /P0_B_ACTIVE_MARKER/);
    await page.screenshot({ path: resolve(outputDir, "conversation-ownership.png"), fullPage: true });
    await page.locator("#bot-agent-panel-close").click();

    const messageRow = page.locator(`[data-bot-conversation="${messageConversation.id}"]`);
    await messageRow.click();
    await page.locator("#bot-composer-input").fill('"P0_CONVERSATION_ENDPOINT"');
    const messageRequestPromise = page.waitForRequest((request) => (
      request.method() === "POST"
      && new URL(request.url()).pathname === `/api/conversations/${messageConversation.id}/messages`
    ));
    const messageResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/conversations/${messageConversation.id}/messages`
    ));
    await page.locator("#bot-composer-form button[type='submit']").click();
    const messageRequest = await messageRequestPromise;
    const messageResponse = await messageResponsePromise;
    assert.deepEqual(JSON.parse(messageRequest.postData() || "{}"), {
      prompt: '"P0_CONVERSATION_ENDPOINT"',
      messageIntent: "steer",
    });
    assert.equal(messageResponse.status(), 202);
    const admittedRun = await messageResponse.json();
    assert.equal(admittedRun.conversationId, messageConversation.id);
    assert.equal(admittedRun.permissionMode, "plan");
    assert.equal(admittedRun.remote, null);
    assert.match(await page.locator("#bot-message-stream").textContent() || "", /P0_CONVERSATION_ENDPOINT/);
    await page.waitForTimeout(4_500);
    await page.screenshot({ path: resolve(outputDir, "conversation-message-admission.png"), fullPage: true });

    await page.locator("#bot-agent-info-button").click();
    await page.waitForSelector("#bot-agent-panel:not([hidden])");
    const computerPreview = page.locator("#bot-computer-preview");
    await computerPreview.click();
    await page.waitForSelector("#bot-computer-view:not([hidden])");
    assert.equal(await page.locator("#bot-computer-view").getAttribute("aria-hidden"), "false");
    assert.equal(await page.locator(".bot-roster").getAttribute("inert"), "");
    assert.equal(await page.locator(".bot-conversation").getAttribute("inert"), "");
    await page.locator("#bot-computer-view-close").focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "bot-computer-return");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "bot-computer-view-close");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#bot-computer-view").getAttribute("aria-hidden"), "true");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "bot-computer-preview");
    await page.locator("#bot-agent-panel-close").click();

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileHorizontalOverflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
    assert.equal(mobileHorizontalOverflow, 0);
    assert.match(await page.locator("#bot-message-stream").textContent() || "", /P0_CONVERSATION_ENDPOINT/);
    await page.screenshot({ path: resolve(outputDir, "conversation-message-admission-mobile.png"), fullPage: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    const workspaceRow = page.locator(`[data-bot-conversation="${workspaceConversation.id}"]`);
    assert.equal(await workspaceRow.count(), 1, "a Conversation must render exactly once in the navigation tree");
    await workspaceRow.click();
    assert.match(await page.locator("#bot-conversation-title").textContent() || "", /Stable collaboration workspace/);
    const inspectorViewports = [];
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1024, height: 900 },
      { width: 820, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      if (await page.locator("#bot-agent-panel").isVisible()) await page.locator("#bot-agent-panel-close").click();
      const widthBefore = Math.round(await page.locator(".bot-conversation").evaluate((node) => node.getBoundingClientRect().width));
      await page.locator("#bot-agent-info-button").click();
      await page.waitForSelector("#bot-agent-panel:not([hidden])");
      const widthAfter = Math.round(await page.locator(".bot-conversation").evaluate((node) => node.getBoundingClientRect().width));
      assert.equal(widthAfter, widthBefore, `${viewport.width}px inspector must not reflow the Conversation column`);
      await page.locator("#bot-collab-tab-tasks").click();
      const stableChat = await page.evaluate(() => ({
        streamHidden: document.querySelector("#bot-message-stream")?.hidden,
        composerHidden: document.querySelector("#bot-composer-form")?.hidden,
        panelHidden: document.querySelector("#bot-collab-panel")?.hidden,
      }));
      assert.deepEqual(stableChat, { streamHidden: false, composerHidden: false, panelHidden: false });
      const horizontalOverflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
      assert.equal(horizontalOverflow, 0, `${viewport.width}px must not overflow horizontally`);
      await page.screenshot({ path: resolve(outputDir, `collaboration-inspector-${viewport.width}.png`), fullPage: true });
      inspectorViewports.push({ ...viewport, widthBefore, widthAfter, horizontalOverflow });
      await page.locator("#bot-agent-panel-close").click();
    }

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(failedResponses, []);
    const finalActiveConversationId = await page.locator("[data-bot-conversation].is-active").getAttribute("data-bot-conversation");
    assert.equal(finalActiveConversationId, workspaceConversation.id);

    const result = {
      schema: "514cc.qa-bot-p0/v1",
      restoredConversationId: hidden.id,
      activeConversationId: finalActiveConversationId,
      lateResponseScenarioActiveConversationId: conversationB.id,
      delayedRunId: runA.id,
      activeRunId: runB.id,
      historyRunId: runAHistory.id,
      shortIdSearchMatched: true,
      contactConversationPickerVerified: true,
      keyboardConversationEntryVerified: true,
      historyRunLoaded: true,
      messageConversationId: messageConversation.id,
      messageRunId: admittedRun.id,
      messageEndpointStatus: messageResponse.status(),
      mobileHorizontalOverflow,
      workspaceConversationId: workspaceConversation.id,
      conversationRowsAreUnique: true,
      stableCollaborationInspector: true,
      computerModalVerified: true,
      inspectorViewports,
      lateResponseIgnored: true,
      pageErrors,
      consoleErrors,
      failedResponses,
      expectedGateBlocks,
      screenshot: resolve(outputDir, "conversation-ownership.png"),
      messageScreenshot: resolve(outputDir, "conversation-message-admission.png"),
      mobileMessageScreenshot: resolve(outputDir, "conversation-message-admission-mobile.png"),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await browser?.close().catch(() => {});
    await stopTestServer(child, { token }).catch((error) => {
      process.stderr.write(`bot P0 QA server shutdown failed: ${error.message}\n`);
      process.exitCode = 1;
    });
    await removeTree(root);
  }
}

await main();
