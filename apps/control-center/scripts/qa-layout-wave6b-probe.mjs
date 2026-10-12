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
await page.waitForTimeout(1200);

// ── ① 消息行 hover 复制钮 ──
await page.evaluate(() => {
  const stream = document.getElementById("conversation-stream");
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const isUser = i % 2 === 0;
    rows.push(`<article class="message-row${isUser ? " is-user" : ""}"><div class="message-avatar"></div><div class="message-content"><div class="message-head"><strong>${isUser ? "LO" : "Claude"}</strong><time>12:0${i}</time></div>${isUser ? `<p class="message-body">用户消息 ${i}</p>` : `<div class="message-body md-body"><p>助手回复 ${i}</p>`}</div></article>`);
  }
  stream.innerHTML = rows.join("");
});
await page.waitForTimeout(500);

const copy1 = await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".message-row")];
  const withBtn = rows.filter((r) => r.querySelector(":scope > .msg-row-copy")).length;
  const btn = rows[0]?.querySelector(".msg-row-copy");
  const hiddenOpacity = btn ? getComputedStyle(btn).opacity : null;
  return { rows: rows.length, withBtn, hiddenOpacity };
});
console.log("COPY_INJECT:", JSON.stringify(copy1));

// hover 行 → 钮显现
await page.locator(".message-row").first().hover();
await page.waitForTimeout(300);
const copy2 = await page.evaluate(() => {
  const btn = document.querySelector(".message-row .msg-row-copy");
  return { hoverOpacity: getComputedStyle(btn).opacity };
});
console.log("COPY_HOVER:", JSON.stringify(copy2));

// 点击复制 → is-copied 反馈（headless 剪贴板可能拒绝，走 execCommand 降级；两路都不应抛错）
await page.locator(".message-row .msg-row-copy").first().click();
await page.waitForTimeout(400);
const copy3 = await page.evaluate(() => ({
  copied: !!document.querySelector(".msg-row-copy.is-copied"),
  iconSwapped: document.querySelector(".msg-row-copy use")?.getAttribute("href"),
}));
console.log("COPY_CLICK:", JSON.stringify(copy3));
await page.screenshot({ path: ".qa-v4/probe-row-copy.png" });

// ── ② MC dock tab 徽标：选中 rail 里第一个会话，等快照 ready ──
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 20_000 });
await page.waitForTimeout(1200);
await page.locator(".run-rail .session-item, .rail-block-runs .project-node, #rail-runs .project-node").first().click().catch(() => {});
await page.waitForTimeout(3500);
const badges = await page.evaluate(() => {
  const root = document.getElementById("mission-control-dock");
  const read = (id) => {
    const tab = document.querySelector(`[data-registry-tab="${id}"]`);
    const dot = tab?.querySelector(".registry-tab-dot");
    const count = tab?.querySelector(".registry-tab-count");
    return { dot: dot ? [...dot.classList].filter((c) => c.startsWith("is-")).join("/") : null, count: count?.textContent ?? null, title: (dot ?? count)?.title ?? null };
  };
  return { state: root?.dataset.state, tasks: read("tasks"), artifacts: read("artifacts"), evidence: read("evidence"), activity: read("activity"), connections: read("connections") };
});
console.log("MC_BADGES:", JSON.stringify(badges));
await page.screenshot({ path: ".qa-v4/probe-mc-badges.png" });

// ── ③ 暗态徽标 + 复制钮 ──
await page.evaluate(() => { localStorage.setItem("514cc-control-theme", "dark"); });
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 20_000 });
await page.waitForTimeout(1500);
await page.locator(".run-rail .session-item, .rail-block-runs .project-node, #rail-runs .project-node").first().click().catch(() => {});
await page.waitForTimeout(3500);
await page.screenshot({ path: ".qa-v4/probe-mc-badges-dark.png" });

console.log("ERRORS:", errs.length);
errs.slice(0, 6).forEach((e) => console.log(" -", e));
await browser.close();
