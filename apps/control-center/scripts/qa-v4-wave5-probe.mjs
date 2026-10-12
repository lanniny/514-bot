import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const url = process.argv[2];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1512, height: 945 } });
await page.addInitScript(() => { try { localStorage.setItem("514cc-product-tour-dismissed", "1"); } catch {} }); // 首跑导览对话框会挡视口点击（D-2026-09-28-018）
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => errs.push(`PAGEERROR: ${String(e).slice(0, 200)}`));

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 20_000 });
await page.waitForTimeout(1500);

// ① 顶栏无终端标签 + 角位双开关就位
await page.screenshot({ path: ".qa-v4/26-topnav-corner-light.png" });

// ② 右上角终端开关 → dock 展开（懒挂载 PTY）
await page.locator("#global-terminal-toggle").click();
await page.waitForTimeout(1800);
await page.screenshot({ path: ".qa-v4/27-dock-via-corner-light.png" });

// ③ 右上角 MC 开关 → 右栏收成细条
await page.locator("#global-mc-toggle").click();
await page.waitForTimeout(700);
await page.screenshot({ path: ".qa-v4/28-mc-via-corner-light.png" });

// ④ 从其他视图点 MC 开关：自动切回协作台并展开
await page.locator('.topbar-nav [data-view="team"]').click();
await page.waitForTimeout(900);
await page.locator("#global-mc-toggle").click();
await page.waitForTimeout(900);
const view = await page.evaluate(() => document.querySelector(".view.is-active")?.id);
console.log("BACK-TO:", view);

console.log("ERRORS:", errs.length);
errs.slice(0, 6).forEach((e) => console.log(" -", e));
await browser.close();
