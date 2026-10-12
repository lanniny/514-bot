// 建议卡一键采用 happy-path 探针：隔离实例（零 run，composer 处于新任务态，
// #start-agent 可选），验证点击建议卡 → 起始成员切换 + flash + change 联动。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";
import { buildIsolatedServerEnv, createIsolatedQaRepo } from "./qa-team-workspace.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const token = "adopt-probe-token";
const qaRoot = await mkdtemp(join(tmpdir(), "collab-adopt-"));
let server;
let browser;
try {
  await createIsolatedQaRepo(qaRoot);
  server = spawnTestServer({ env: buildIsolatedServerEnv({ qaRoot, token }) });
  const url = await waitForUrl(server); // 隔离实例经 #bootstrap=  fragment 自举鉴权

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  await page.addInitScript(() => { try { localStorage.setItem("514cc-product-tour-dismissed", "1"); } catch {} }); // 首跑导览对话框会挡视口点击（D-2026-09-28-018）
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errs.push(`PAGEERROR: ${String(e).slice(0, 200)}`));

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 20_000 });
  // bot 面顶栏导航被 !important 隐藏（bot 表面无 chrome 设计）——走 hash 导航，
// 不依赖被藏按钮的可见性（与 qa-bot-journey 同款）。
await page.evaluate(() => { location.hash = "#team"; });
await page.waitForFunction(() => document.querySelector("#view-team")?.classList?.contains("is-active") === true, null, { timeout: 15_000 });
  await page.waitForSelector(".cf-suggest-input", { timeout: 10_000 });

  console.log("COMPOSER-MODE:", JSON.stringify({
    hint: (await page.locator("#composer-mode-hint").textContent())?.trim(),
    disabled: await page.evaluate(() => document.getElementById("start-agent")?.disabled),
  }));

  await page.locator(".cf-suggest-input").fill("评审这段代码的安全漏洞");
  await page.waitForTimeout(300);
  const picks = await page.locator(".cf-suggest-pick").count();
  const before = await page.locator("#start-agent").inputValue();
  if (picks > 0) await page.locator(".cf-suggest-pick").first().click();
  const flashed = await page.evaluate(() =>
    document.getElementById("start-agent")?.classList.contains("cf-adopted-flash") ?? false);
  const note = await page.locator(".cf-suggest-pick .cf-suggest-hint").first().textContent().catch(() => "(none)");
  const after = await page.locator("#start-agent").inputValue();
  console.log("ADOPT-FRESH:", JSON.stringify({ picks, before, after, flashed, note: note?.trim() }));
  await page.screenshot({ path: ".qa-v4/collab-wave-adopted-light.png" });

  console.log("ERRORS:", errs.length);
  errs.slice(0, 6).forEach((e) => console.log(" -", e));
} finally {
  if (browser) await browser.close();
  if (server) await stopTestServer(server, { token }).catch(() => server.kill("SIGKILL"));
  await rm(qaRoot, { recursive: true, force: true });
}
