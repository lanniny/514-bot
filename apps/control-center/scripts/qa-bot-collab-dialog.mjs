#!/usr/bin/env node

import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const outputDir = resolve(appRoot, ".qa-output", "bot-collab-dialog");
const token = "bot-collab-dialog-qa-token-0123456789";
const cloudflare524 = `API Error: 524 {"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/","title":"Error 524: A timeout occurred","status":524,"detail":"The origin web server did not return a complete response within the 120-second Proxy Read Timeout window.","error_code":524,"error_name":"origin_response_timeout","retry_after":120,"now_action_required":true} (514claude.xyz)`;

async function writeConfig(repoRoot) {
  await mkdir(resolve(repoRoot, "config/control-center"), { recursive: true });
  await writeFile(resolve(repoRoot, "config/app.json"), '{"enabled":true}\n');
  await writeFile(resolve(repoRoot, "config/control-center/models.json"), JSON.stringify({
    version: 1,
    profiles: testModelProfiles().map((profile, index) => ({
      ...profile,
      enabled: true,
      capabilities: ["*"],
      quality: 0.95 - index * 0.01,
      speed: 0.8,
      costTier: 2,
      evidence: [{ source: "qa-fixture", detail: "Bot collaboration dialog QA", verifiedAt: "2026-08-26" }],
    })),
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
    modes: { plan: { write: false, approvalRequired: false }, build: { write: "workspace", approvalRequired: true } },
    limits: { maxRounds: 8, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 30_000, turnIdleTimeoutMs: 10_000 },
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

function persistedEvent(sequence, type, runId, agentId, data, timestamp) {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    sequence,
    timestamp,
    type,
    runId,
    sessionId: null,
    agentId,
    sensitivity: "internal",
    sourceIds: [],
    data,
  };
}

async function startServer(env) {
  const child = spawnTestServer({ env });
  return { child, url: await waitForUrl(child) };
}

async function main() {
  const root = await mkdtemp(resolve(appRoot, ".qa-bot-collab-dialog-"));
  const repoRoot = resolve(root, "repo");
  const dataRoot = resolve(root, "data");
  const fakeHome = resolve(root, "home");
  await writeConfig(repoRoot);
  await mkdir(fakeHome, { recursive: true });
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const env = {
    CONTROL_CENTER_TOKEN: token,
    CONTROL_CENTER_REPO_ROOT: repoRoot,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_PORT: "0",
    HOME: fakeHome,
    USERPROFILE: fakeHome,
  };
  let server = await startServer(env);
  let browser;
  try {
    const origin = new URL(server.url).origin;
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
    const direct = (await api("/api/conversations", {
      method: "POST",
      body: { kind: "direct", title: "Rendered collaboration", directMemberId: "codex-technical" },
    })).conversation;
    const recoveryConversation = (await api("/api/conversations", {
      method: "POST",
      body: { kind: "direct", title: "Provider timeout recovery", directMemberId: "claude-fable" },
    })).conversation;
    const run = await api("/api/runs", {
      method: "POST",
      body: {
        prompt: "RENDER_DIALOG_MARKER",
        execute: false,
        permissionMode: "plan",
        conversationId: direct.id,
        conversationKind: "direct",
        orchestrationMode: "pipeline",
        startAgentId: "codex-technical",
        requestedProvider: "codex-technical",
      },
    });
    const recoveryRun = await api("/api/runs", {
      method: "POST",
      body: {
        prompt: "RECOVERY_524_MARKER",
        execute: false,
        permissionMode: "plan",
        conversationId: recoveryConversation.id,
        conversationKind: "direct",
        orchestrationMode: "pipeline",
        startAgentId: "claude-fable",
        requestedProvider: "claude-fable",
      },
    });
    const deletedA = (await api("/api/conversations", { method: "POST", body: { kind: "direct", title: "Deleted A", directMemberId: "grok-build" } })).conversation;
    const deletedB = (await api("/api/conversations", { method: "POST", body: { kind: "direct", title: "Deleted B", directMemberId: "kimi-frontend" } })).conversation;
    const hiddenSeed = (await api("/api/conversations", { method: "POST", body: { kind: "direct", title: "Hidden stays", directMemberId: "claude-fable" } })).conversation;
    await api(`/api/conversations/${deletedA.id}`, { method: "DELETE", body: { expectedRevision: deletedA.revision } });
    await api(`/api/conversations/${deletedB.id}`, { method: "DELETE", body: { expectedRevision: deletedB.revision } });
    const hidden = (await api(`/api/conversations/${hiddenSeed.id}`, { method: "PATCH", body: { expectedRevision: hiddenSeed.revision, hidden: true } })).conversation;
    const project = (await api("/api/projects", { method: "POST", body: { title: "Delegation workspace", cwd: repoRoot } })).project;
    const group = (await api("/api/conversations", {
      method: "POST",
      body: {
        kind: "workspace_group",
        title: "Visible team routing",
        projectId: project.projectId,
        roomRole: "task",
        memberIds: ["claude-fable", "codex-technical", "grok-build"],
      },
    })).conversation;
    const duplicateLabelA = await api("/api/team-members", {
      method: "POST",
      body: { label: "重名成员", shortLabel: "同", role: "duplicate-a", runtimeProfileId: "codex-technical", capabilities: ["coding"] },
    });
    const duplicateLabelB = await api("/api/team-members", {
      method: "POST",
      body: { label: "重名成员", shortLabel: "同", role: "duplicate-b", runtimeProfileId: "codex-technical", capabilities: ["coding"] },
    });
    const duplicateProject = (await api("/api/projects", { method: "POST", body: { title: "Duplicate mention workspace", cwd: fakeHome } })).project;
    const duplicateGroup = (await api("/api/conversations", {
      method: "POST",
      body: {
        kind: "workspace_group",
        title: "Duplicate mention room",
        projectId: duplicateProject.projectId,
        roomRole: "task",
        memberIds: ["claude-fable", duplicateLabelA.id, duplicateLabelB.id],
      },
    })).conversation;
    const groupRun = await api("/api/runs", {
      method: "POST",
      body: {
        prompt: "VISIBLE_DELEGATION_MARKER",
        execute: false,
        permissionMode: "plan",
        conversationId: group.id,
        conversationKind: "workspace_group",
        orchestrationMode: "social",
        startAgentId: "claude-fable",
        requestedAgentIds: ["codex-technical", "grok-build"],
        ephemeralTeam: {
          name: "QA team",
          coordinator: "claude-fable",
          members: ["claude-fable", "codex-technical", "grok-build"],
          skills: [], mcp: [], providers: {}, systemPrompt: "",
        },
      },
    });

    await stopTestServer(server.child, { token });
    const directRunPath = resolve(dataRoot, "runs", `${run.id}.json`);
    const persistedDirectRun = JSON.parse(await readFile(directRunPath, "utf8"));
    persistedDirectRun.status = "queued";
    persistedDirectRun.result = null;
    persistedDirectRun.error = null;
    persistedDirectRun.updatedAt = new Date().toISOString();
    await writeFile(directRunPath, `${JSON.stringify(persistedDirectRun, null, 2)}\n`, "utf8");
    const recoveryRunPath = resolve(dataRoot, "runs", `${recoveryRun.id}.json`);
    const persistedRecoveryRun = JSON.parse(await readFile(recoveryRunPath, "utf8"));
    const recoveryTimestamp = new Date(Date.now() + 1_000).toISOString();
    persistedRecoveryRun.status = "recovery_required";
    persistedRecoveryRun.error = cloudflare524;
    persistedRecoveryRun.recoveryNote = "Recovery acknowledgement could not drain durable work (CLAUDE_FAILED). Inspect the claimed work before acknowledging another continuation.";
    persistedRecoveryRun.sessions = { "claude-fable": "57587e0c-161f-46c8-a796-5d45d3e2d98b" };
    persistedRecoveryRun.resumeHints = [{
      agentId: "claude-fable",
      sessionId: "57587e0c-161f-46c8-a796-5d45d3e2d98b",
      protocol: "claude-stream-json",
      canResume: true,
      command: "claude -r 57587e0c-161f-46c8-a796-5d45d3e2d98b",
    }];
    persistedRecoveryRun.turnAttempts = [{
      attemptId: "qa-524-attempt",
      agentId: "claude-fable",
      round: 1,
      phase: "submitting",
      protocol: "stream-json-resume",
      sessionId: "57587e0c-161f-46c8-a796-5d45d3e2d98b",
      updatedAt: recoveryTimestamp,
    }];
    persistedRecoveryRun.inflightTurns = { "claude-fable": "qa-524-attempt" };
    persistedRecoveryRun.updatedAt = recoveryTimestamp;
    await writeFile(recoveryRunPath, `${JSON.stringify(persistedRecoveryRun, null, 2)}\n`, "utf8");
    const groupRunPath = resolve(dataRoot, "runs", `${groupRun.id}.json`);
    const persistedGroupRun = JSON.parse(await readFile(groupRunPath, "utf8"));
    const delegationStamp = new Date().toISOString();
    persistedGroupRun.taskGraph.delegations = ["codex-technical", "grok-build"].map((toAgentId, index) => ({
      id: `qa-delegation-${index + 1}`,
      fromAgentId: "lo",
      toAgentId,
      kind: "mention",
      state: "queued",
      busMessageId: `qa-bus-${index + 1}`,
      parentTaskId: persistedGroupRun.taskGraph.rootTaskId,
      sourceAttemptId: null,
      targetAttemptId: null,
      depth: 1,
      limit: 4,
      depthLimitReached: false,
      timestamp: delegationStamp,
    }));
    persistedGroupRun.taskGraph.updatedAt = delegationStamp;
    await writeFile(groupRunPath, `${JSON.stringify(persistedGroupRun, null, 2)}\n`, "utf8");
    groupRun.taskGraph = persistedGroupRun.taskGraph;
    const base = Date.now() - 60_000;
    const markdown = "## 修复结果\n\n| 项目 | 状态 |\n|---|---|\n| 消息渲染 | 完成 |\n| 工具详情 | 完成 |\n\n- 头像已显示\n- 活动已折叠\n\n```sh\nnpm test\n```";
    const events = [
      persistedEvent(1, "user.message", run.id, "lo", { text: "RENDER_DIALOG_MARKER" }, new Date(base).toISOString()),
      persistedEvent(2, "codex.item/completed", run.id, "codex-technical", {
        itemType: "mcpToolCall",
        progress: {
          kind: "tool", id: "tool-qa-1", name: "fastctx.run", status: "completed", verb: "已调用",
          input: '{"command":"npm test","cwd":"apps/control-center"}', inputTruncated: false,
          output: "187 tests passed\nexit code 0", outputTruncated: false,
        },
      }, new Date(base + 10_000).toISOString()),
      persistedEvent(3, "codex.item/completed", run.id, "codex-technical", {
        itemType: "mcpToolCall",
        progress: {
          kind: "tool", id: "tool-qa-2", name: "fastctx.inspect_local_file", status: "completed", verb: "已调用",
          input: '{"file_path":"apps/control-center/public/app.js"}', inputTruncated: false,
          output: "render source inspected", outputTruncated: false,
        },
      }, new Date(base + 20_000).toISOString()),
      persistedEvent(4, "assistant.message", run.id, "codex-technical", { text: markdown }, new Date(base + 30_000).toISOString()),
      persistedEvent(5, "agent.turn_completed", run.id, "codex-technical", {
        agentId: "codex-technical", round: 1, interactionId: "qa-interaction-1", interactionSeq: 1, interactionStep: 3,
        status: "completed", tokens: 187, costUsd: 0,
      }, new Date(base + 40_000).toISOString()),
      persistedEvent(6, "assistant.message", recoveryRun.id, "claude-fable", {
        text: cloudflare524,
      }, new Date(base + 50_000).toISOString()),
      persistedEvent(7, "agent.turn_failed", recoveryRun.id, "claude-fable", {
        attemptId: "qa-524-attempt",
        agentId: "claude-fable",
        round: 1,
        phase: "submitting",
        adapterId: "claude-stream-json",
        code: "CLAUDE_FAILED",
        message: cloudflare524,
        interruptConfirmed: false,
      }, new Date(base + 55_000).toISOString()),
    ];
    await appendFile(resolve(dataRoot, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    server = await startServer(env);
    const liveOrigin = new URL(server.url).origin;

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const consoleErrors = [];
    const pageErrors = [];
    const failedResponses = [];
    const expectedBlockedResponses = [];
    const responseChecks = [];
    page.on("console", (message) => {
      if (message.type() === "error" && !/^Failed to load resource:/.test(message.text())) consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() < 400) return;
      responseChecks.push((async () => {
        const url = new URL(response.url());
        const payload = await response.json().catch(() => null);
        const code = payload?.code ?? payload?.error?.code ?? null;
        const exactRuntimeSeatFallback = response.status() === 404 && url.pathname === "/api/runtime-seats";
        if ((response.status() === 501 && code === "REMOTE_GATE_BLOCKED") || exactRuntimeSeatFallback) {
          expectedBlockedResponses.push({ status: response.status(), path: url.pathname, code });
          return;
        }
        failedResponses.push(`${response.status()} ${response.url()} ${code || ""}`.trim());
      })());
    });
    await page.route("**/api/workbench/environment**", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ schema: "514cc.workbench.environment/v1", available: false, source: "bot-collab-dialog-qa" }),
    }));
    await page.route("**/api/sessions/projects**", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ available: true, projects: [] }),
    }));
    await page.addInitScript((accessToken) => {
      sessionStorage.setItem("514cc-control-token", accessToken);
      localStorage.setItem("514cc-product-tour-dismissed", "1");
    }, token);
    await page.goto(liveOrigin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });
    assert.equal(await page.locator("#view-workbench").isVisible(), true);
    assert.equal(await page.locator("#view-bot").isHidden(), true);
    assert.match(await page.title(), /^协作台 · 514 Bot$/);
    await page.locator(`[data-run-select="${recoveryRun.id}"]`).click();
    await page.waitForSelector("#recovery-bar:not([hidden])");
    await page.waitForSelector(".provider-failure-card");
    const providerFailureSummary = await page.locator(".provider-failure-card .failure-reason > span").first().textContent();
    assert.match(providerFailureSummary || "", /提交状态仍不明确/);
    assert.doesNotMatch(providerFailureSummary || "", /developers\.cloudflare\.com/);
    assert.match(await page.locator("#recovery-bar .recovery-bar-heading").textContent() || "", /需要恢复确认/);
    assert.match(await page.locator("#recovery-bar .resume-hint-cmd").textContent() || "", /^claude -r /);
    const inspectRecoveryLayout = async (name, viewport) => {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(120);
      const metrics = await page.locator("#recovery-bar").evaluate((bar) => {
        const rect = bar.getBoundingClientRect();
        const pane = document.querySelector(".conversation-pane");
        const stream = document.querySelector("#conversation-stream");
        const composer = document.querySelector("#task-form");
        const streamRect = stream?.getBoundingClientRect();
        const composerRect = composer?.getBoundingClientRect();
        const longNarrowText = [...bar.querySelectorAll("span, code, summary, strong")]
          .filter((node) => (node.textContent || "").trim().length > 8)
          .map((node) => ({ text: (node.textContent || "").trim().slice(0, 24), width: node.getBoundingClientRect().width }))
          .filter((item) => item.width < 72);
        return {
          display: getComputedStyle(bar).display,
          columns: getComputedStyle(bar).gridTemplateColumns,
          width: rect.width,
          clientWidth: bar.clientWidth,
          scrollWidth: bar.scrollWidth,
          pageOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
          paneRows: pane ? getComputedStyle(pane).gridTemplateRows : null,
          paneBottom: pane?.getBoundingClientRect().bottom ?? null,
          streamGridRow: stream ? getComputedStyle(stream).gridRow : null,
          recoveryGridRow: getComputedStyle(bar).gridRow,
          composerGridRow: composer ? getComputedStyle(composer).gridRow : null,
          streamTop: streamRect?.top ?? null,
          streamBottom: streamRect?.bottom ?? null,
          recoveryTop: rect.top,
          recoveryBottom: rect.bottom,
          composerTop: composerRect?.top ?? null,
          composerBottom: composerRect?.bottom ?? null,
          streamRecoveryOverlap: streamRect ? Math.max(0, streamRect.bottom - rect.top) : null,
          recoveryComposerOverlap: composerRect ? Math.max(0, rect.bottom - composerRect.top) : null,
          longNarrowText,
        };
      });
      assert.equal(metrics.display, "grid", JSON.stringify({ name, metrics }));
      assert.ok(metrics.width >= Math.min(320, viewport.width - 16), JSON.stringify({ name, metrics }));
      assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, JSON.stringify({ name, metrics }));
      assert.equal(metrics.pageOverflow, 0, JSON.stringify({ name, metrics }));
      assert.equal(metrics.streamRecoveryOverlap, 0, JSON.stringify({ name, metrics }));
      assert.equal(metrics.recoveryComposerOverlap, 0, JSON.stringify({ name, metrics }));
      assert.deepEqual(metrics.longNarrowText, [], JSON.stringify({ name, metrics }));
      await page.screenshot({ path: resolve(outputDir, `recovery-${name}.png`), fullPage: true });
      return metrics;
    };
    const recoveryDesktop = await inspectRecoveryLayout("desktop", { width: 1440, height: 960 });
    const recoveryTablet = await inspectRecoveryLayout("tablet", { width: 1024, height: 768 });
    const recoveryMobile = await inspectRecoveryLayout("mobile", { width: 390, height: 844 });
    await page.setViewportSize({ width: 1440, height: 960 });
    const recoveryDetails = page.locator("#recovery-bar .gov-detail");
    assert.ok(await recoveryDetails.count() >= 2);
    assert.equal(await recoveryDetails.first().getAttribute("open"), null);
    await recoveryDetails.last().locator("summary").click();
    assert.match(await recoveryDetails.last().locator("pre").textContent() || "", /origin_response_timeout/);
    await page.screenshot({ path: resolve(outputDir, "recovery-details.png"), fullPage: true });
    await page.locator("[data-recovery-ack]").click();
    assert.match(await page.locator("#recovery-bar .recovery-acked").textContent() || "", /下次发送将自动继续/);
    assert.equal(await page.locator("#recovery-bar").getAttribute("class"), "recovery-bar is-acked");
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForTimeout(120);
    const acknowledgedLayout = await page.evaluate(() => {
      const pane = document.querySelector(".conversation-pane")?.getBoundingClientRect();
      const streamNode = document.querySelector("#conversation-stream");
      const stream = streamNode?.getBoundingClientRect();
      const recovery = document.querySelector("#recovery-bar")?.getBoundingClientRect();
      const composer = document.querySelector("#task-form")?.getBoundingClientRect();
      const input = document.querySelector("#task-input")?.getBoundingClientRect();
      return {
        paneBottom: pane?.bottom,
        streamTop: stream?.top,
        streamBottom: stream?.bottom,
        streamHeight: stream?.height,
        streamVisibility: streamNode ? getComputedStyle(streamNode).visibility : null,
        recoveryBottom: recovery?.bottom,
        composerTop: composer?.top,
        composerBottom: composer?.bottom,
        inputTop: input?.top,
        inputBottom: input?.bottom,
      };
    });
    assert.equal(acknowledgedLayout.streamVisibility, "visible", JSON.stringify(acknowledgedLayout));
    assert.ok(acknowledgedLayout.streamHeight >= 80, JSON.stringify(acknowledgedLayout));
    assert.ok(acknowledgedLayout.streamBottom <= acknowledgedLayout.recoveryBottom, JSON.stringify(acknowledgedLayout));
    assert.ok(acknowledgedLayout.recoveryBottom <= acknowledgedLayout.composerTop, JSON.stringify(acknowledgedLayout));
    assert.ok(acknowledgedLayout.composerBottom <= acknowledgedLayout.paneBottom + 1, JSON.stringify(acknowledgedLayout));
    assert.ok(acknowledgedLayout.inputTop >= 0 && acknowledgedLayout.inputBottom <= 768, JSON.stringify(acknowledgedLayout));
    await page.screenshot({ path: resolve(outputDir, "recovery-acknowledged-tablet.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.screenshot({ path: resolve(outputDir, "startup-workbench.png"), fullPage: true });
    await page.goto(`${liveOrigin}/#bot`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#view-bot")?.classList.contains("is-active") === true, null, { timeout: 30_000 });
    const forgeShell = await page.evaluate(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const value = node.getBoundingClientRect();
        return { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height };
      };
      const style = (selector) => getComputedStyle(document.querySelector(selector));
      return {
        title: document.title,
        crumb: document.querySelector("#current-view-title")?.textContent?.trim(),
        statusVersion: document.querySelector("#global-status-version")?.textContent?.trim(),
        forgePaper: getComputedStyle(document.documentElement).getPropertyValue("--forge-paper").trim(),
        botBackground: style(".bot-shell").backgroundColor,
        topbarDisplay: style(".topbar").display,
        statusbarDisplay: style(".global-statusbar").display,
        sidebarDisplay: style(".sidebar").display,
        mobileNavDisplay: style(".mobile-nav").display,
        stageDisplay: style(".atelier-stage").display,
        topbar: rect(".topbar"),
        main: rect(".main-content"),
        statusbar: rect(".global-statusbar"),
        bot: rect("#view-bot"),
      };
    });
    assert.equal(forgeShell.title, "514 Bot");
    assert.equal(forgeShell.crumb, "514 Bot");
    assert.match(forgeShell.statusVersion, /^514 Bot · /);
    assert.equal(forgeShell.forgePaper.toLowerCase(), "#f4f0e7");
    assert.notEqual(forgeShell.botBackground, "rgb(251, 251, 250)");
    assert.notEqual(forgeShell.topbarDisplay, "none");
    assert.notEqual(forgeShell.statusbarDisplay, "none");
    assert.equal(forgeShell.sidebarDisplay, "none");
    assert.equal(forgeShell.mobileNavDisplay, "none");
    assert.notEqual(forgeShell.stageDisplay, "none");
    assert.ok(forgeShell.topbar.bottom <= forgeShell.main.top + 1);
    assert.ok(forgeShell.main.bottom <= forgeShell.statusbar.top + 1);
    assert.ok(forgeShell.bot.left >= forgeShell.main.left && forgeShell.bot.right <= forgeShell.main.right + 1);
    await page.locator(`[data-bot-conversation="${direct.id}"]`).click();
    await page.waitForSelector("#bot-message-stream .md-table");
    assert.equal(await page.locator("#bot-message-stream .bot-message-agent").count(), 1);
    assert.equal(await page.locator("#bot-message-stream .bot-message-avatar").count() >= 2, true);
    assert.equal(await page.locator("#bot-message-stream .bot-activity-group").count() >= 1, true);
    assert.match(await page.locator("#bot-message-stream .bot-activity-summary").first().textContent() || "", /思考过程|过程/);
    assert.equal(await page.locator("#bot-message-stream .bot-activity-group[open]").count(), 0);
    assert.equal(await page.locator("#bot-message-stream > .bot-message-agent").count(), 1);
    assert.equal(await page.locator("#bot-message-stream .bot-inline-event").count(), 0);
    await page.locator("#bot-message-stream .bot-activity-summary").first().click();
    await page.locator("#bot-message-stream .bot-activity-segment > summary").first().click();
    const firstActivityBody = page.locator("#bot-message-stream .bot-activity-body").first();
    assert.match(await firstActivityBody.textContent() || "", /npm test/);
    assert.match(await firstActivityBody.textContent() || "", /187 tests passed/);
    assert.match(await firstActivityBody.textContent() || "", /inspect_local_file/);
    const sendButton = page.locator("#bot-composer-form button[type='submit']");
    assert.equal(await sendButton.getAttribute("data-mode"), "stop");
    await page.route(`**/api/runs/${run.id}/interrupt`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...persistedDirectRun, status: "interrupted", updatedAt: new Date().toISOString() }),
    }));
    const interruptResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/runs/${run.id}/interrupt`);
    await sendButton.click();
    assert.equal((await interruptResponse).status(), 200);
    await page.waitForFunction(() => document.querySelector("#bot-composer-form button[type='submit']")?.dataset.mode === "send");
    assert.equal(await page.locator("#bot-composer-form button[type='submit'] use").getAttribute("href"), "#lucide-arrow-up");
    await page.waitForTimeout(5_500);
    if (!await page.locator("#bot-message-stream .bot-activity-segment").first().evaluate((node) => node.open === true)) {
      await page.locator("#bot-message-stream .bot-activity-segment > summary").first().click();
    }
    await page.locator("#bot-message-stream .process-card.is-tool").first().locator("summary").click();
    await page.screenshot({ path: resolve(outputDir, "dialog-desktop.png"), fullPage: true });
    await page.locator("#theme-toggle").click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    assert.notEqual(await page.locator(".bot-shell").evaluate((node) => getComputedStyle(node).backgroundColor), forgeShell.botBackground);
    await page.screenshot({ path: resolve(outputDir, "dialog-forge-dark.png"), fullPage: true });
    await page.locator("#theme-toggle").click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");

    let releaseDelayedConversation;
    const delayedConversationStarted = new Promise((resolveStarted) => {
      releaseDelayedConversation = resolveStarted;
    });
    await page.route("**/api/conversations", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const payload = route.request().postDataJSON();
      if (payload?.kind !== "direct" || payload?.directMemberId !== "pi-resident") return route.continue();
      releaseDelayedConversation();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
      return route.continue();
    });
    await page.locator('[data-bot-surface-tab="contacts"]').click();
    const piChat = page.locator('[data-bot-contact-chat="pi-resident"]');
    assert.equal(await piChat.count(), 1);
    await piChat.click();
    await delayedConversationStarted;
    await page.locator('[data-bot-surface-tab="chats"]').click();
    await page.locator(`[data-bot-conversation="${direct.id}"]`).click();
    await page.waitForTimeout(900);
    assert.equal(await page.locator(`[data-bot-conversation="${direct.id}"]`).getAttribute("aria-selected"), "true");
    assert.equal((await page.locator("#bot-conversation-title").textContent() || "").trim(), direct.title);
    assert.equal((await page.locator("#bot-composer-target").textContent() || "").trim(), direct.title);
    assert.equal((await page.locator("#bot-inspector-ref").textContent() || "").trim(), `#${direct.id.slice(0, 8)}`);
    await page.screenshot({ path: resolve(outputDir, "switching-desktop.png"), fullPage: true });

    const clearButton = page.locator('[data-bot-action="clear-deleted"]');
    assert.equal(await clearButton.count(), 1);
    const purgeResponse = page.waitForResponse((response) => response.request().method() === "DELETE" && new URL(response.url()).pathname === "/api/conversations/deleted");
    await clearButton.click();
    await page.getByRole("button", { name: "清空已删除", exact: true }).last().click();
    assert.equal((await purgeResponse).status(), 200);
    await page.waitForSelector(`[data-bot-conversation="${deletedA.id}"]`, { state: "detached" });
    assert.equal(await page.locator(`[data-bot-conversation="${deletedB.id}"]`).count(), 0);
    assert.equal(await page.locator(`[data-bot-conversation="${hidden.id}"]`).count(), 1);

    await page.setViewportSize({ width: 820, height: 900 });
    assert.equal(await page.locator("#mobile-menu-button").isHidden(), true);
    assert.equal(await page.locator(".topbar").isVisible(), true);
    assert.equal(await page.locator(".global-statusbar").isHidden(), true);
    assert.equal(await page.locator(".mobile-nav").isHidden(), true);
    const shell820 = await page.evaluate(() => {
      const main = document.querySelector(".main-content")?.getBoundingClientRect();
      const bot = document.querySelector("#view-bot")?.getBoundingClientRect();
      return {
        mainBottom: main?.bottom,
        botBottom: bot?.bottom,
        viewportBottom: innerHeight,
        overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      };
    });
    assert.ok(Math.abs(shell820.mainBottom - shell820.viewportBottom) <= 1, JSON.stringify(shell820));
    assert.ok(shell820.botBottom <= shell820.mainBottom && shell820.mainBottom - shell820.botBottom <= 10, JSON.stringify(shell820));
    assert.equal(shell820.overflow, 0);
    await page.screenshot({ path: resolve(outputDir, "dialog-820.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator(".bot-roster").isHidden(), true);
    assert.equal(await page.locator(".bot-conversation").isVisible(), true);
    assert.equal(await page.locator("#bot-mobile-back").isVisible(), true);
    assert.equal(await page.locator(".topbar").isVisible(), true);
    assert.equal(await page.locator("#mobile-menu-button").isHidden(), true);
    assert.equal(await page.locator(".global-statusbar").isHidden(), true);
    assert.equal(await page.locator(".mobile-nav").isHidden(), true);
    const mobileShell = await page.evaluate(() => {
      const main = document.querySelector(".main-content")?.getBoundingClientRect();
      const bot = document.querySelector("#view-bot")?.getBoundingClientRect();
      return {
        mainBottom: main?.bottom,
        botBottom: bot?.bottom,
        viewportBottom: innerHeight,
        overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      };
    });
    assert.ok(Math.abs(mobileShell.mainBottom - mobileShell.viewportBottom) <= 1, JSON.stringify(mobileShell));
    assert.ok(Math.abs(mobileShell.botBottom - mobileShell.viewportBottom) <= 1, JSON.stringify(mobileShell));
    const mobileOverflow = mobileShell.overflow;
    assert.equal(mobileOverflow, 0);
    await page.screenshot({ path: resolve(outputDir, "dialog-mobile.png"), fullPage: true });

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.locator(`[data-bot-conversation="${group.id}"]`).click();
    let mentionRequest = null;
    await page.route(`**/api/conversations/${group.id}/messages`, async (route) => {
      mentionRequest = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...persistedGroupRun,
          status: "queued",
          startAgentId: "codex-technical",
          requestedAgentIds: [],
          updatedAt: new Date().toISOString(),
        }),
      });
    });
    const botComposer = page.locator("#bot-composer-input");
    await botComposer.fill("@Cod");
    await page.waitForSelector('#bot-mention-menu [data-bot-mention-id="codex-technical"]');
    await botComposer.press("Enter");
    assert.equal(await page.locator('[data-bot-mention-recipient="codex-technical"]').count(), 1);
    await botComposer.type("请只由你回答这条消息");
    await page.screenshot({ path: resolve(outputDir, "mentions-desktop.png"), fullPage: true });
    const mentionResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/conversations/${group.id}/messages`);
    await page.locator("#bot-composer-form button[type='submit']").click();
    assert.equal((await mentionResponse).status(), 200);
    assert.deepEqual(mentionRequest?.recipientMemberIds, ["codex-technical"]);
    assert.equal(mentionRequest?.messageIntent, "steer");
    await page.locator(`[data-bot-conversation="${duplicateGroup.id}"]`).click();
    await botComposer.fill("@重名");
    await page.waitForSelector("#bot-mention-menu:not([hidden])");
    const duplicateOptions = page.locator("#bot-mention-menu [data-bot-mention-id]");
    assert.equal(await duplicateOptions.count(), 2);
    await duplicateOptions.nth(0).click();
    await botComposer.fill(`${await botComposer.inputValue()} @重名`);
    await page.waitForSelector("#bot-mention-menu:not([hidden])");
    await page.locator("#bot-mention-menu [data-bot-mention-id]").nth(1).click();
    const duplicateText = await botComposer.inputValue();
    assert.equal((duplicateText.match(/@重名成员#/g) || []).length, 1);
    assert.match(duplicateText, new RegExp(`${duplicateLabelB.id.slice(-8)}\\s`));
    assert.equal(await page.locator(`[data-bot-mention-recipient="${duplicateLabelB.id}"]`).count(), 1);
    assert.equal(await page.locator(`[data-bot-mention-recipient="${duplicateLabelA.id}"]`).count(), 0);
    await botComposer.fill("");
    await page.locator(`[data-bot-conversation="${group.id}"]`).click();
    await page.locator("#bot-agent-info-button").click();
    for (const selector of [".bot-roster", ".bot-conversation", ".topbar", ".global-statusbar"]) {
      assert.equal(await page.locator(selector).getAttribute("inert"), "");
    }
    const panelFocusCount = await page.locator("#bot-agent-panel").evaluate((panel) => {
      const focusables = [...panel.querySelectorAll("button, input, textarea, select, [href], [tabindex]:not([tabindex='-1'])")]
        .filter((node) => node.tabIndex >= 0 && !node.hidden && !node.disabled && node.getAttribute("aria-hidden") !== "true" && node.getClientRects().length > 0);
      focusables.forEach((node, index) => { node.dataset.qaPanelFocus = String(index); });
      return focusables.length;
    });
    assert.ok(panelFocusCount >= 2);
    await page.locator(`[data-qa-panel-focus="${panelFocusCount - 1}"]`).focus();
    await page.keyboard.press("Tab");
    const wrappedForward = await page.evaluate(() => ({
      inside: document.querySelector("#bot-agent-panel")?.contains(document.activeElement) === true,
      marker: document.activeElement?.dataset?.qaPanelFocus,
    }));
    assert.equal(wrappedForward.inside, true);
    assert.notEqual(wrappedForward.marker, String(panelFocusCount - 1));
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.qaPanelFocus), String(panelFocusCount - 1));
    await page.locator("#bot-collab-tab-tasks").click();
    await page.waitForSelector("[data-bot-delegation-id]");
    assert.equal(await page.locator("[data-bot-delegation-id]").count(), groupRun.taskGraph.delegations.length);
    const delegationText = await page.locator("#bot-collab-panel").textContent();
    assert.match(delegationText || "", /LO →/);
    assert.match(delegationText || "", /Codex|烛/);

    const desktopOverflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
    assert.equal(desktopOverflow, 0);
    await page.setViewportSize({ width: 390, height: 844 });
    const collaborationMobileOverflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
    assert.equal(collaborationMobileOverflow, 0);
    await page.screenshot({ path: resolve(outputDir, "collaboration-mobile.png"), fullPage: true });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#bot-agent-panel").isHidden(), true);
    assert.equal(await page.locator(".bot-conversation").getAttribute("inert"), null);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "bot-agent-info-button");
    await botComposer.fill("@Grok");
    await page.waitForSelector("#bot-mention-menu:not([hidden])");
    const mentionMobileOverflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
    assert.equal(mentionMobileOverflow, 0);
    await page.screenshot({ path: resolve(outputDir, "mentions-mobile.png"), fullPage: true });
    await botComposer.press("Escape");
    assert.equal(await page.locator("#bot-mention-menu").isHidden(), true);
    await page.locator("#bot-mobile-back").click();
    assert.equal(await page.locator(".bot-roster").isVisible(), true);
    assert.equal(await page.locator(".bot-conversation").isHidden(), true);

    await Promise.all(responseChecks);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(failedResponses, []);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      markdownTable: true,
      assistantMessageCount: 1,
      activityGroups: 1,
      activityAfterReplyMerged: true,
      restoredForgeChrome: true,
      restoredForgePalette: true,
      defaultStartupWorkbench: true,
      recoveryErrorPresented: true,
      recoveryDesktop,
      recoveryTablet,
      recoveryMobile,
      acknowledgedLayout,
      panelFocusContained: true,
      shell820,
      toolDetail: true,
      stopControl: true,
      delayedConversationSelectionPreserved: true,
      mentionedRecipient: mentionRequest?.recipientMemberIds?.[0] || null,
      deletedPurged: 2,
      hiddenPreserved: true,
      delegationEdges: groupRun.taskGraph.delegations.length,
      desktopOverflow,
      mobileOverflow,
      collaborationMobileOverflow,
      mentionMobileOverflow,
      expectedBlockedResponses,
      screenshots: [
        resolve(outputDir, "startup-workbench.png"),
        resolve(outputDir, "recovery-desktop.png"),
        resolve(outputDir, "recovery-tablet.png"),
        resolve(outputDir, "recovery-mobile.png"),
        resolve(outputDir, "recovery-details.png"),
        resolve(outputDir, "recovery-acknowledged-tablet.png"),
        resolve(outputDir, "dialog-desktop.png"),
        resolve(outputDir, "dialog-forge-dark.png"),
        resolve(outputDir, "dialog-820.png"),
        resolve(outputDir, "dialog-mobile.png"),
        resolve(outputDir, "switching-desktop.png"),
        resolve(outputDir, "mentions-desktop.png"),
        resolve(outputDir, "mentions-mobile.png"),
        resolve(outputDir, "collaboration-mobile.png"),
      ],
    }, null, 2)}\n`);
  } finally {
    await browser?.close().catch(() => {});
    await stopTestServer(server.child, { token }).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }).catch(() => {});
  }
}

await main();
