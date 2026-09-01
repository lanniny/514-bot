#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(appRoot, "..", "..");
const outputDir = resolve(appRoot, ".qa-output", "permission-approval");
const token = "permission-approval-qa-token";
const dataRoot = await mkdtemp(join(tmpdir(), "514cc-permission-qa-"));
const runtimeHome = resolve(dataRoot, "home");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await mkdir(runtimeHome, { recursive: true });

const child = spawnTestServer({
  env: {
    CONTROL_CENTER_TOKEN: token,
    CONTROL_CENTER_TEST_REPO_ROOT: repoRoot,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_RUNTIME_HOME: runtimeHome,
    CONTROL_CENTER_PORT: "0",
    HOME: runtimeHome,
    USERPROFILE: runtimeHome,
  },
});

let browser;
let failure = null;
const report = { repoRoot, viewports: {}, consoleErrors: [], pageErrors: [], responseErrors: [] };

async function openPermissionPage(page) {
  await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok"));
  await page.evaluate(() => document.querySelector('[data-view="security"]')?.click());
  await page.waitForSelector("#view-security:not([hidden])");
  await page.waitForFunction(() => document.querySelectorAll("#permission-overview-grid [data-permission-card]").length === 4);
  await page.waitForFunction(() => document.querySelector("#permission-overview-grid")?.getAttribute("aria-busy") === "false");
  await page.waitForFunction(() => document.querySelectorAll("#permission-seat-list [data-permission-seat]").length > 0);
  await page.waitForFunction(() => !document.querySelector("#permission-instance-context")?.textContent?.includes("实例路径未返回"));
}

async function inspectViewport(page, label) {
  const snapshot = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#permission-overview-grid [data-permission-card]")];
    const rows = [...document.querySelectorAll("#permission-seat-list [data-permission-seat]")];
    const viewportWidth = document.documentElement.clientWidth;
    const inside = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= -1 && rect.right <= viewportWidth + 1 && rect.width > 0 && rect.height > 0;
    };
    return {
      hash: location.hash,
      instance: document.querySelector("#permission-instance-context")?.textContent?.replace(/\s+/g, " ").trim() || "",
      summary: document.querySelector("#permission-overview-summary")?.textContent?.trim() || "",
      blockers: document.querySelector("#permission-overview-blockers")?.textContent?.replace(/\s+/g, " ").trim() || "",
      cards: cards.map((card) => card.textContent.replace(/\s+/g, " ").trim()),
      rowCount: rows.length,
      channels: [...document.querySelectorAll(".permission-seat-facts div:last-child dd")].map((item) => item.textContent.trim()),
      bodyOverflow: Math.max(0, document.documentElement.scrollWidth - viewportWidth),
      mainOverflow: (() => {
        const main = document.querySelector("main") || document.body;
        return Math.max(0, main.scrollWidth - main.clientWidth);
      })(),
      cardsInsideViewport: cards.every(inside),
      rowsInsideViewport: rows.every(inside),
      unresolvedText: document.querySelector("#view-security")?.textContent?.includes("undefined") || false,
    };
  });
  report.viewports[label] = snapshot;
  assert.equal(snapshot.cards.length, 4, `${label}: permission card count`);
  assert.ok(snapshot.instance.includes(repoRoot), `${label}: active repoRoot (${snapshot.instance})`);
  assert.ok(snapshot.rowCount > 0, `${label}: runtime seat details`);
  assert.ok(snapshot.channels.includes("514cc 动作审批"), `${label}: broker channel`);
  assert.ok(snapshot.channels.includes("仅 Build 审批"), `${label}: build-only channel`);
  assert.equal(snapshot.bodyOverflow, 0, `${label}: document overflow`);
  assert.equal(snapshot.mainOverflow, 0, `${label}: main overflow`);
  assert.equal(snapshot.cardsInsideViewport, true, `${label}: cards inside viewport`);
  assert.equal(snapshot.rowsInsideViewport, true, `${label}: rows inside viewport`);
  assert.equal(snapshot.unresolvedText, false, `${label}: unresolved internal values`);
  if (snapshot.summary.includes("阻断")) assert.ok(snapshot.blockers, `${label}: blocker details`);
}

try {
  const entryUrl = await waitForUrl(child);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") report.consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    report.responseErrors.push(`${response.request().method()} ${url.pathname} ${response.status()}`);
  });

  await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#api-connection-badge");
  await openPermissionPage(page);
  await inspectViewport(page, "1440x900");
  await page.screenshot({ path: join(outputDir, "permission-approval-1440x900.png"), fullPage: true, animations: "disabled" });

  const editButton = page.locator("#permission-seat-list [data-runtime-seat-id]").first();
  const targetSeat = await editButton.getAttribute("data-runtime-seat-id");
  await editButton.click();
  await page.waitForSelector("#view-config:not([hidden])");
  await page.waitForFunction((seatId) => location.hash.includes(encodeURIComponent(seatId)), targetSeat);
  assert.equal(await page.locator("#runtime-seat-form").isVisible(), true, "runtime seat deep link");

  await page.setViewportSize({ width: 390, height: 844 });
  await openPermissionPage(page);
  await inspectViewport(page, "390x844");
  await page.screenshot({ path: join(outputDir, "permission-approval-390x844.png"), fullPage: true, animations: "disabled" });

  const blockingConsoleErrors = report.consoleErrors.filter((message) => !/status of 501 \(Not Implemented\)/.test(message));
  const blockingResponseErrors = report.responseErrors.filter((message) => !/ 501$/.test(message));
  assert.deepEqual(report.pageErrors, [], "page errors");
  assert.deepEqual(blockingConsoleErrors, [], "console errors");
  assert.deepEqual(blockingResponseErrors, [], "unexpected HTTP errors");
  await context.close();
} catch (error) {
  failure = error;
  report.failure = error.stack || error.message;
} finally {
  if (browser) await browser.close();
  try {
    report.shutdown = await stopTestServer(child, { token });
  } catch (error) {
    report.shutdown = { error: error.message, code: error.code || null };
    failure ||= error;
  }
  await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await rm(dataRoot, { recursive: true, force: true });
}

if (failure) throw failure;
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
