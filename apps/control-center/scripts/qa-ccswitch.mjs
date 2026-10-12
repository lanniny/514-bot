import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const url = process.argv[2];
if (!url) throw new Error("usage: node scripts/qa-ccswitch.mjs <bootstrap-url>");

const outputRoot = resolve(".qa-output", "ccswitch");
await mkdir(outputRoot, { recursive: true });
const browser = await chromium.launch({ headless: true });
const browserErrors = [];
const responseChecks = [];
const expectedGateResponses = [];
const checks = [];
const expectedGatePaths = new Set([
  "/api/channels",
  "/api/channels/events",
  "/api/market/installed",
  "/api/market/skills",
  "/api/office/templates",
  "/api/pty",
  "/api/ssh/hosts",
]);

function responseKey(viewport, theme, path) {
  return `${viewport.width}x${viewport.height}:${theme}:${path}`;
}

async function openPage(viewport, theme) {
  const page = await browser.newPage({ viewport });
  await page.addInitScript(() => { try { localStorage.setItem("514cc-product-tour-dismissed", "1"); } catch {} }); // 首跑导览对话框会挡视口点击（D-2026-09-28-018）
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location().url;
    const path = location ? new URL(location).pathname : "";
    browserErrors.push({ type: "console", viewport, theme, path, message: message.text().slice(0, 500) });
  });
  page.on("pageerror", (error) => browserErrors.push({ type: "pageerror", viewport, theme, message: String(error).slice(0, 500) }));
  page.on("response", (response) => {
    if (response.status() !== 501) return;
    const path = new URL(response.url()).pathname;
    if (!expectedGatePaths.has(path)) return;
    responseChecks.push((async () => {
      const payload = await response.json().catch(() => null);
      if (payload?.code === "REMOTE_GATE_BLOCKED") {
        expectedGateResponses.push({ viewport, theme, path, status: 501, code: payload.code });
      } else {
        browserErrors.push({ type: "http", viewport, theme, path, status: 501, code: payload?.code ?? null });
      }
    })());
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 30_000 });
  if (theme === "dark") {
    await page.evaluate(() => localStorage.setItem("514cc-control-theme", "dark"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 30_000 });
  }
  const configNav = viewport.width <= 820
    ? page.locator('.mobile-nav [data-view="config"]')
    : page.locator('.topbar-nav [data-view="config"]');
  await configNav.waitFor({ state: "visible" });
  await configNav.click();
  await page.locator('[data-config-surface="local-runtime"]').click();
  const root = page.locator("#ccswitch-workbench");
  await root.waitFor({ state: "visible" });
  await root.locator(".ccs-tabs").waitFor();
  await root.evaluate((element) => element.scrollIntoView({ block: "start", inline: "nearest" }));
  await page.waitForTimeout(600);
  return { page, root };
}

async function selectTab(root, tab) {
  await root.locator(`[data-ccs-tab="${tab}"]`).click();
  await root.locator(`[data-ccs-tab="${tab}"]`).evaluate((element) => {
    if (element.getAttribute("aria-selected") !== "true") throw new Error(`tab ${element.dataset.ccsTab} did not activate`);
  });
  await root.page().waitForTimeout(250);
}

async function inspectLayout(page, root, label) {
  const result = await root.evaluate((element) => {
    const viewportOverflow = document.documentElement.scrollWidth - window.innerWidth;
    const clipped = [...element.querySelectorAll("button, input, select, .ccs-tab, .ccs-tool-heading > h3, .status-label")]
      .filter((node) => node instanceof HTMLElement && node.offsetParent !== null)
      .filter((node) => node.scrollWidth > node.clientWidth + 2 || node.scrollHeight > node.clientHeight + 2)
      .map((node) => ({ tag: node.tagName, text: (node.textContent || node.getAttribute("placeholder") || "").trim().slice(0, 100), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));
    const tabs = [...element.querySelectorAll(".ccs-tab")].filter((node) => node instanceof HTMLElement && node.offsetParent !== null).map((node) => node.getBoundingClientRect());
    const overlaps = [];
    for (let left = 0; left < tabs.length; left += 1) {
      for (let right = left + 1; right < tabs.length; right += 1) {
        if (tabs[left].left < tabs[right].right && tabs[left].right > tabs[right].left && tabs[left].top < tabs[right].bottom && tabs[left].bottom > tabs[right].top) overlaps.push([left, right]);
      }
    }
    return { viewportOverflow, clipped, overlaps, rootWidth: element.getBoundingClientRect().width };
  });
  checks.push({ label, ...result });
  if (result.viewportOverflow > 2 || result.clipped.length || result.overlaps.length) {
    throw new Error(`layout check failed for ${label}: ${JSON.stringify(result)}`);
  }
  await page.waitForTimeout(100);
}

async function screenshot(root, name) {
  await root.screenshot({ path: resolve(outputRoot, `${name}.png`), animations: "disabled" });
}

try {
  for (const theme of ["light", "dark"]) {
    const { page, root } = await openPage({ width: 1440, height: 1000 }, theme);
    await selectTab(root, "proxy");
    await inspectLayout(page, root, `desktop-${theme}-proxy`);
    await screenshot(root, `desktop-${theme}-proxy`);
    await selectTab(root, "resources");
    await root.locator('[data-ccs-resource-tab="workspace"]').click();
    await root.locator('[data-ccs-form="workspace-file"]').waitFor();
    await inspectLayout(page, root, `desktop-${theme}-workspace`);
    await screenshot(root, `desktop-${theme}-workspace`);
    for (const tab of ["sync", "accounts"]) {
      await selectTab(root, tab);
      await inspectLayout(page, root, `desktop-${theme}-${tab}`);
      await screenshot(root, `desktop-${theme}-${tab}`);
    }
    await page.close();
  }

  const { page, root } = await openPage({ width: 390, height: 844 }, "light");
  await selectTab(root, "proxy");
  await inspectLayout(page, root, "mobile-light-proxy");
  await page.screenshot({ path: resolve(outputRoot, "mobile-light-proxy.png"), animations: "disabled" });
  await selectTab(root, "resources");
  await root.locator('[data-ccs-resource-tab="workspace"]').click();
  await root.locator('[data-ccs-form="workspace-file"]').waitFor();
  await inspectLayout(page, root, "mobile-light-workspace");
  await page.screenshot({ path: resolve(outputRoot, "mobile-light-workspace.png"), animations: "disabled" });
  await page.close();
} finally {
  await browser.close();
}

await Promise.all(responseChecks);
const verifiedGateKeys = new Set(expectedGateResponses.map((entry) => responseKey(entry.viewport, entry.theme, entry.path)));
const unexpectedBrowserErrors = browserErrors.filter((entry) => {
  if (entry.type !== "console") return true;
  if (entry.message !== "Failed to load resource: the server responded with a status of 501 (Not Implemented)") return true;
  return !verifiedGateKeys.has(responseKey(entry.viewport, entry.theme, entry.path));
});
const report = {
  url: new URL(url).origin,
  screenshots: 10,
  browserErrors: unexpectedBrowserErrors,
  expectedGateResponses,
  checks,
};
await writeFile(resolve(outputRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (unexpectedBrowserErrors.length) throw new Error(`CC-Switch browser QA captured errors: ${JSON.stringify(unexpectedBrowserErrors)}`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
