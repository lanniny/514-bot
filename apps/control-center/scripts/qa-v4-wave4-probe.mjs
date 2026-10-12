import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const url = process.argv[2];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1512, height: 945 } });
await page.addInitScript(() => { try { localStorage.setItem("514cc-product-tour-dismissed", "1"); } catch {} }); // 首跑导览对话框会挡视口点击（D-2026-09-28-018）
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300)); });
page.on("pageerror", (err) => consoleErrors.push(`PAGEERROR: ${String(err).slice(0, 300)}`));

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.evaluate(() => { localStorage.setItem("514cc-control-theme", "dark"); });
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 20_000 });
// 回到协作台（reload 会恢复上次浏览视图）
await page.locator(`.topbar-nav [data-view="workbench"]`).first().click();
await page.waitForTimeout(1600);
await page.screenshot({ path: ".qa-v4/22-workbench-dark-true.png" });

// 展开团队筛选行验证
await page.locator("#rail-filters-toggle").click();
await page.waitForTimeout(400);
await page.screenshot({ path: ".qa-v4/23-rail-filters-dark.png" });

// 亮色下筛选行 + composer 近景
await page.evaluate(() => { localStorage.setItem("514cc-control-theme", "light"); });
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 20_000 });
await page.locator(`.topbar-nav [data-view="workbench"]`).first().click();
await page.waitForTimeout(1600);
await page.locator("#rail-filters-toggle").click();
await page.waitForTimeout(400);
await page.screenshot({ path: ".qa-v4/24-rail-filters-light.png" });

console.log("CONSOLE_ERRORS:", consoleErrors.length);
consoleErrors.slice(0, 8).forEach((e) => console.log(" -", e));
await browser.close();
