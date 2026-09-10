#!/usr/bin/env node
/**
 * qa-bot-chat-render.mjs — P0: empty hero must leave after send; bubbles stay in column.
 * Run: node scripts/qa-bot-chat-render.mjs
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const token = "bot-chat-render-qa-token-0123456789";
const outputDir = resolve("/opt/cursor/artifacts/screenshots");

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
      evidence: [{ source: "qa-fixture", detail: "chat render", verifiedAt: "2026-09-10" }],
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
    limits: { maxRounds: 8, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 30_000 },
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

async function measure(page) {
  return page.evaluate(() => {
    const stream = document.getElementById("bot-message-stream");
    const empty = stream?.querySelector(".bot-message-empty");
    const message = stream?.querySelector(".bot-message-user");
    const tools = document.querySelector(".bot-composer-ops-chips");
    const footer = document.querySelector(".bot-composer-footer");
    const overflow = document.getElementById("bot-composer-overflow");
    const streamBox = stream?.getBoundingClientRect();
    const messageBox = message?.getBoundingClientRect();
    const bubbleBox = message?.querySelector(".bot-bubble")?.getBoundingClientRect();
    return {
      emptyVisible: Boolean(empty) && getComputedStyle(empty).display !== "none",
      messageCount: stream?.querySelectorAll(".bot-message").length || 0,
      messageText: message?.textContent || "",
      overflowOpen: Boolean(overflow?.open),
      toolsVisible: Boolean(tools) && getComputedStyle(tools).display !== "none",
      footerVisible: Boolean(footer) && getComputedStyle(footer).display !== "none",
      streamWidth: streamBox?.width || 0,
      messageLeft: messageBox?.left || 0,
      messageWidth: messageBox?.width || 0,
      streamLeft: streamBox?.left || 0,
      bubbleRight: bubbleBox?.right || 0,
      streamRight: streamBox?.right || 0,
    };
  });
}

async function main() {
  const root = await mkdtemp("/tmp/514cc-qa-chat-render-");
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
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/local/bin/google-chrome",
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
  try {
    const bootstrapUrl = await waitForUrl(child);
    const origin = new URL(bootstrapUrl).origin;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript((accessToken) => {
      sessionStorage.setItem("514cc-control-token", accessToken);
      localStorage.setItem("514cc-product-tour-dismissed", "1");
      localStorage.setItem("514cc-bot-face", "grok");
      localStorage.setItem("514cc-bot-roster-collapsed", "1");
      localStorage.setItem("514cc-bot-ops-collapsed", "1");
    }, token);
    await page.goto(`${origin}/#bot`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true,
      null,
      { timeout: 30_000 },
    );
    await page.waitForSelector("#bot-composer-input:not([disabled])", { timeout: 20_000 });
    await page.waitForSelector("#bot-message-stream", { timeout: 20_000 });
    await page.screenshot({ path: resolve(outputDir, "bot-chat-empty.png"), fullPage: false });

    const before = await measure(page);
    assert.equal(before.messageCount, 0, "empty conversation should have no bubbles");
    assert.equal(before.toolsVisible, false, "ops chips must stay out of the Grok composer");
    assert.equal(before.footerVisible, false, "workbench footer must stay closed");
    assert.equal(before.overflowOpen, false);

    await page.locator("#bot-composer-input").fill("你好");
    await page.locator("#bot-composer-form button[type='submit']").click();
    await page.waitForFunction(() => document.querySelector("#bot-message-stream .bot-message-user"), null, { timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(outputDir, "bot-chat-after-send.png"), fullPage: false });

    const after = await measure(page);
    assert.equal(after.emptyVisible, false, "empty hero must leave after a user bubble");
    assert.match(after.messageText, /你好/);
    assert.equal(after.toolsVisible, false);
    assert.equal(after.footerVisible, false);
    const messageRightSlack = after.streamRight - (after.messageLeft + after.messageWidth);
    const messageLeftSlack = after.messageLeft - after.streamLeft;
    assert.ok(after.messageWidth <= 760, `message column too wide: ${after.messageWidth}`);
    assert.ok(Math.abs(messageLeftSlack - messageRightSlack) < 80, `message column not centered: left ${messageLeftSlack} right ${messageRightSlack}`);
    assert.ok(after.bubbleRight <= after.messageLeft + after.messageWidth + 2, "bubble escaped the conversation column");

    await page.setViewportSize({ width: 560, height: 844 });
    await page.waitForTimeout(300);
    const mobileConversation = await page.evaluate(() => {
      const grid = document.querySelector("#view-bot .bot-shell-grid");
      const conversation = document.querySelector("#view-bot .bot-conversation");
      const roster = document.querySelector("#view-bot .bot-roster");
      return {
        mobileClass: Boolean(grid?.classList.contains("is-mobile-conversation")),
        conversationDisplay: conversation ? getComputedStyle(conversation).display : "missing",
        rosterDisplay: roster ? getComputedStyle(roster).display : "missing",
      };
    });
    assert.equal(mobileConversation.mobileClass, true, "sending should keep the mobile conversation pane open");
    assert.equal(mobileConversation.conversationDisplay, "flex");
    assert.equal(mobileConversation.rosterDisplay, "none");
    await page.screenshot({ path: resolve(outputDir, "bot-chat-after-send-560.png"), fullPage: false });
    const mobile = await measure(page);
    assert.equal(mobile.emptyVisible, false);
    assert.match(mobile.messageText, /你好/);
    assert.equal(mobile.toolsVisible, false);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addStyleTag({
      content: `body.team-bg-active, html.is-bot-grok-face body.team-bg-active .atelier-stage { background-image: linear-gradient(160deg, #7eb8e8, #f6f1c8 55%, #f4d35e) !important; background-size: cover !important; }`,
    });
    await page.evaluate(() => document.body.classList.add("team-bg-active"));
    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(outputDir, "bot-chat-after-send-wallpaper.png"), fullPage: false });
    const wallpaper = await measure(page);
    assert.equal(wallpaper.emptyVisible, false);
    assert.ok(wallpaper.messageWidth <= 760, `wallpaper column too wide: ${wallpaper.messageWidth}`);

    console.log(JSON.stringify({ before, after, mobile, mobileConversation, wallpaper, outputDir }, null, 2));
  } finally {
    await browser.close();
    await stopTestServer(child, { token }).catch(() => child.kill("SIGKILL"));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
