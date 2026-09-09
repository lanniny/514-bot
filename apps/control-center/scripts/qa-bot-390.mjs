#!/usr/bin/env node
/**
 * qa-bot-390.mjs — Grok 对标 W6：bot 面四视口走查（390 / 820 / 1280 / 1440）。
 *
 * 断言：页面与关键表面无横向溢出；新建例行 dialog、交接板、成员设置、composer
 * 的主控件在视口内可点。运行：node scripts/qa-bot-390.mjs
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

const HOST_SHIM_MARKER = "node-language-shim.cjs";
if ((process.env.NODE_OPTIONS ?? "").includes(HOST_SHIM_MARKER)) {
  const scrubbed = process.env.NODE_OPTIONS
    .replace(/--require(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/g, (match) =>
      match.includes(HOST_SHIM_MARKER) ? "" : match)
    .replace(/\s{2,}/g, " ")
    .trim();
  const relaunched = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: scrubbed },
  });
  process.exit(relaunched.status ?? 1);
}

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const outputDir = resolve(appRoot, ".qa-output", "bot-390");
const token = "bot-390-qa-token-0123456789";
const VIEWPORTS = [
  { name: "mobile-390", width: 390, height: 844 },
  { name: "tablet-820", width: 820, height: 1180 },
  { name: "laptop-1280", width: 1280, height: 800 },
  { name: "desktop-1440", width: 1440, height: 900 },
];

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
      evidence: [{ source: "qa-fixture", detail: "Bot 390 walkthrough", verifiedAt: "2026-09-09" }],
    })),
  }));
  await writeFile(resolve(repoRoot, "config/control-center/routing.json"), JSON.stringify({
    version: 1,
    primaryCoordinator: "claude-fable",
    technicalExecutor: "codex-technical",
    maxRounds: 6, maxDepth: 2, maxParallelAgents: 4,
    requireHealthyProvider: false, failOnUnavailableExplicitProvider: false,
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
    discover: [], runtime: [],
  }));
}

function measureOverflow() {
  const doc = document.documentElement;
  const innerWidth = window.innerWidth;
  const selectors = [
    "#view-bot",
    "#bot-composer-form",
    "#bot-agent-panel",
    "#bot-agent-settings-panel",
    "#bot-routine-dialog",
    "[data-relay-mount]",
  ];
  const surfaces = selectors.map((selector) => {
    const el = document.querySelector(selector);
    if (!el || el.hidden || el.getAttribute("hidden") !== null) return { selector, skipped: true, overflow: 0 };
    const rect = el.getBoundingClientRect();
    return {
      selector,
      skipped: false,
      clientWidth: Math.round(el.clientWidth),
      scrollWidth: Math.round(el.scrollWidth),
      overflow: Math.max(0, el.scrollWidth - el.clientWidth),
      rightBleed: Math.max(0, Math.ceil(rect.right - innerWidth - 1)),
    };
  });
  return {
    innerWidth,
    documentOverflow: Math.max(0, doc.scrollWidth - innerWidth, document.body.scrollWidth - innerWidth),
    surfaces,
  };
}

function controlSnapshot(selectors) {
  const innerWidth = window.innerWidth;
  const innerHeight = window.innerHeight;
  return selectors.map((selector) => {
    const el = document.querySelector(selector);
    if (!el) return { selector, present: false, usable: false };
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    const inX = rect.left >= -2 && rect.right <= innerWidth + 2;
    const inY = rect.top >= -2 && rect.bottom <= innerHeight + 2;
    return {
      selector,
      present: true,
      usable: visible && inX && rect.height >= 24,
      visible,
      inX,
      inY,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
}

async function closeBotOverlays(page) {
  if (await page.locator("#bot-routine-dialog").evaluate((el) => el?.open === true).catch(() => false)) {
    await page.locator("#bot-routine-dialog [data-routine-dialog-close]").first().click();
    await page.waitForFunction(() => document.querySelector("#bot-routine-dialog")?.open !== true, null, { timeout: 8_000 });
  }
  if (await page.locator("#bot-agent-settings-panel:not([hidden])").count()) {
    await page.locator("#bot-agent-settings-close").click();
    await page.waitForFunction(() => document.querySelector("#bot-agent-settings-panel")?.hidden === true, null, { timeout: 8_000 });
  }
  if (await page.locator("#bot-agent-panel:not([hidden])").count()) {
    await page.locator("#bot-agent-panel-close").click();
    await page.waitForFunction(() => document.querySelector("#bot-agent-panel")?.hidden === true, null, { timeout: 8_000 });
  }
}

async function showRoster(page) {
  await closeBotOverlays(page);
  const tabs = page.locator("#bot-surface-tab-chats");
  if (!(await tabs.isVisible().catch(() => false))) {
    const back = page.locator("#bot-mobile-back");
    if (await back.isVisible().catch(() => false)) await back.click();
  }
  await tabs.waitFor({ state: "visible", timeout: 10_000 });
  await tabs.click();
}

async function openConversation(page, conversationId, projectId) {
  await showRoster(page);
  const row = page.locator(`[data-bot-conversation="${conversationId}"]`);
  if (!(await row.isVisible().catch(() => false))) {
    const toggle = page.locator(`[data-bot-project-toggle="${projectId}"]`);
    if (await toggle.count()) await toggle.click();
  }
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await row.click();
}

async function walkViewport(page, viewport, { directId, groupId, projectId, outputDir: shots }) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await openConversation(page, directId, projectId);

  const composer = await page.evaluate(controlSnapshot, ["#bot-composer-input", ".bot-send-button", "#bot-composer-form"]);
  assert.ok(composer.every((item) => item.usable), `${viewport.name} composer unusable: ${JSON.stringify(composer)}`);

  await page.locator("#bot-agent-info-button").click();
  await page.waitForSelector("#bot-agent-panel:not([hidden])", { timeout: 10_000 });
  await page.locator("#bot-routine-create-button").scrollIntoViewIfNeeded();
  await page.locator("#bot-routine-create-button").click();
  await page.waitForFunction(() => document.querySelector("#bot-routine-dialog")?.open === true, null, { timeout: 10_000 });
  const dialogControls = await page.evaluate(controlSnapshot, [
    "#bot-routine-dialog [data-routine-field='title']",
    "#bot-routine-dialog button[type='submit']",
    "#bot-routine-dialog [data-routine-dialog-close]",
  ]);
  assert.ok(dialogControls.every((item) => item.usable && item.inY), `${viewport.name} routine dialog unusable: ${JSON.stringify(dialogControls)}`);
  await page.locator("#bot-routine-dialog [data-routine-dialog-close]").first().click();
  await page.waitForFunction(() => document.querySelector("#bot-routine-dialog")?.open !== true, null, { timeout: 10_000 });

  await page.locator("#bot-agent-settings-button").click();
  await page.waitForSelector("#bot-agent-settings-panel:not([hidden])", { timeout: 10_000 });
  await page.locator("#bot-member-label").scrollIntoViewIfNeeded();
  await page.locator("#bot-profile-owns").scrollIntoViewIfNeeded();
  await page.locator("#bot-agent-settings-submit").scrollIntoViewIfNeeded();
  const settings = await page.evaluate(controlSnapshot, [
    "#bot-member-label",
    "#bot-profile-owns",
    "#bot-agent-settings-submit",
  ]);
  assert.ok(settings.every((item) => item.present && item.visible), `${viewport.name} member settings hidden: ${JSON.stringify(settings)}`);
  assert.ok(settings.filter((item) => item.selector !== "#bot-agent-settings-submit").every((item) => item.inX), `${viewport.name} member settings clipped: ${JSON.stringify(settings)}`);
  await closeBotOverlays(page);
  await openConversation(page, groupId, projectId);
  await page.locator("#bot-agent-info-button").click();
  await page.waitForSelector("#bot-collab-tabs:not([hidden])", { timeout: 10_000 });
  await page.locator("#bot-collab-tab-tasks").click();
  await page.waitForSelector("[data-relay-mount]", { timeout: 10_000 });
  await page.locator("[data-relay-mount]").scrollIntoViewIfNeeded();
  const relay = await page.evaluate(controlSnapshot, ["[data-relay-mount]", ".bot-relay-row", ".bot-relay-meta"]);
  assert.ok(relay[0].present && relay[0].visible, `${viewport.name} relay mount missing`);
  assert.ok(relay.slice(1).every((item) => !item.present || item.inX), `${viewport.name} relay clipped: ${JSON.stringify(relay)}`);

  const overflow = await page.evaluate(measureOverflow);
  assert.equal(overflow.documentOverflow, 0, `${viewport.name} page overflow: ${JSON.stringify(overflow)}`);
  for (const surface of overflow.surfaces) {
    if (surface.skipped) continue;
    assert.ok(surface.overflow <= 8, `${viewport.name} ${surface.selector} overflow ${surface.overflow}`);
    assert.equal(surface.rightBleed, 0, `${viewport.name} ${surface.selector} bleeds ${surface.rightBleed}px`);
  }

  await page.screenshot({ path: resolve(shots, `${viewport.name}.png`), fullPage: false });
  await page.locator("#bot-agent-panel-close").click().catch(() => {});
  return { viewport: viewport.name, overflow, composer, dialogControls, settings, relay };
}

async function main() {
  const root = await mkdtemp(resolve(appRoot, ".qa-bot-390-"));
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
  const server = { child: spawnTestServer({ env }), url: null };
  server.url = await waitForUrl(server.child);
  let browser;
  const report = { ok: false, viewports: [], screenshots: [] };
  try {
    const origin = new URL(server.url).origin;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const api = async (path, { method = "GET", body } = {}) => {
      const response = await fetch(new URL(path, origin), {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
      return payload;
    };

    const membersPayload = await api("/api/team-members");
    const catalog = Array.isArray(membersPayload?.members) ? membersPayload.members : [];
    const seat = catalog.find((member) => member.id === "claude-fable") ?? catalog[0];
    assert.ok(seat, "team catalog must not be empty");
    const owner = await api("/api/team-members", {
      method: "POST",
      body: { label: "巡检员", shortLabel: "检", role: "账本巡检负责人", runtimeProfileId: seat.runtimeProfileId, capabilities: ["research"] },
    });
    await api(`/api/bots/${encodeURIComponent(owner.id)}`, {
      method: "PUT",
      body: {
        handle: "@inspector",
        job: { owns: "每周配置健康巡检", goals: ["漂移发现率 100%"] },
        standingRules: ["来源必须带出处"],
        approvalBoundary: { requireApproval: ["外发"], neverAllowed: ["force push"] },
        skills: ["grok-researcher"],
        routineQuota: 8,
      },
    });
    await api("/api/bots/routines", {
      method: "POST",
      body: {
        owningMemberId: owner.id, title: "每周配置健康巡检",
        instructions: "汇总三块账本", schedule: "every:1d",
        expectedOutput: "链接化观察清单", approvalBoundary: "不外发", noDataPolicy: "report-failure",
      },
    });
    const project = (await api("/api/projects", { method: "POST", body: { title: "390 walkthrough", cwd: repoRoot } })).project;
    const group = (await api("/api/conversations", {
      method: "POST",
      body: {
        kind: "workspace_group", title: "小屏交接室", projectId: project.projectId,
        roomRole: "task", memberIds: [seat.id, "codex-technical"],
      },
    })).conversation;
    const run = await api("/api/runs", {
      method: "POST",
      body: {
        prompt: "W6_RELAY_MARK", execute: false, permissionMode: "plan",
        conversationId: group.id, conversationKind: "workspace_group",
        orchestrationMode: "social", startAgentId: seat.id, requestedAgentIds: ["codex-technical"],
        ephemeralTeam: {
          name: "390 team", coordinator: seat.id,
          members: [seat.id, "codex-technical"],
          skills: [], mcp: [], providers: {}, systemPrompt: "",
        },
      },
    });
    await api("/api/bots/relay/handoff", {
      method: "POST",
      body: { runId: run.id, from: seat.id, to: "codex-technical", stage: "collect", text: "收集本周三块账本数据，逐条带出处" },
    });
    const direct = (await api("/api/conversations", {
      method: "POST",
      body: { kind: "direct", title: "巡检员单聊", directMemberId: owner.id },
    })).conversation;

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: VIEWPORTS[0] });
    page.on("pageerror", (error) => { throw error; });
    await page.addInitScript((accessToken) => {
      sessionStorage.setItem("514cc-control-token", accessToken);
      localStorage.setItem("514cc-product-tour-dismissed", "1");
    }, token);
    await page.goto(`${origin}/#bot`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });

    for (const viewport of VIEWPORTS) {
      const result = await walkViewport(page, viewport, {
        directId: direct.id,
        groupId: group.id,
        projectId: project.projectId,
        outputDir,
      });
      report.viewports.push(result);
      report.screenshots.push(`${viewport.name}.png`);
    }
    report.ok = report.viewports.length === VIEWPORTS.length;
  } finally {
    await browser?.close().catch(() => {});
    await stopTestServer(server.child).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await writeFile(resolve(outputDir, "report.json"), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
