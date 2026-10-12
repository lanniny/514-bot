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

// 注入合成消息流（走与渲染器相同的 innerHTML 替换路径，触发 chrome 的 MutationObserver）
await page.evaluate(() => {
  const stream = document.getElementById("conversation-stream");
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const isUser = i % 3 === 0;
    const body = isUser
      ? `<p class="message-body">${i === 0 ? "这是一段特别长的用户消息，模拟粘贴大段日志文本。".repeat(30) : `短消息 ${i}`}</p>`
      : `<div class="message-body md-body"><p>助手回复 ${i}：已处理。</p></div>`;
    rows.push(`<article class="message-row${isUser ? " is-user" : ""}"><div class="message-avatar"></div><div class="message-content"><div class="message-head"><strong>${isUser ? "LO" : "Claude"}</strong><time>10:${String(i).padStart(2, "0")}</time></div>${body}</div></article>`);
  }
  stream.innerHTML = rows.join("");
});
await page.waitForTimeout(600);

const state1 = await page.evaluate(() => {
  const stream = document.getElementById("conversation-stream");
  const sentinel = document.querySelector(".jump-to-latest");
  const toggles = document.querySelectorAll(".msg-expand-toggle");
  const clamped = document.querySelectorAll(".message-body.is-clamped");
  return {
    scrollable: stream.scrollHeight > stream.clientHeight,
    distanceFromBottom: stream.scrollHeight - stream.scrollTop - stream.clientHeight,
    sentinelMounted: !!sentinel && sentinel.parentNode === stream,
    sentinelHidden: sentinel?.hidden,
    toggleCount: toggles.length,
    toggleLabel: toggles[0]?.textContent,
    clampedCount: clamped.length,
    clampedHeight: clamped[0]?.clientHeight,
    kbdHintDisplay: getComputedStyle(document.getElementById("kbd-hint")).display,
  };
});
console.log("STATE_AFTER_INJECT:", JSON.stringify(state1));
await page.screenshot({ path: ".qa-v4/probe-jump-visible.png" });

// 点浮钮回底 → 浮钮应收起
await page.locator(".jump-to-latest-button").click();
await page.waitForTimeout(900);
const state2 = await page.evaluate(() => {
  const stream = document.getElementById("conversation-stream");
  return {
    distanceFromBottom: stream.scrollHeight - stream.scrollTop - stream.clientHeight,
    sentinelHidden: document.querySelector(".jump-to-latest")?.hidden,
  };
});
console.log("STATE_AFTER_JUMP:", JSON.stringify(state2));

// 再翻上去 → 浮钮重现
await page.evaluate(() => { document.getElementById("conversation-stream").scrollTop = 0; });
await page.waitForTimeout(400);
const state3 = await page.evaluate(() => ({ sentinelHidden: document.querySelector(".jump-to-latest")?.hidden }));
console.log("STATE_AFTER_SCROLL_UP:", JSON.stringify(state3));

// 展开折叠的长消息
await page.locator(".msg-expand-toggle").first().click();
await page.waitForTimeout(400);
const state4 = await page.evaluate(() => {
  const body = document.querySelectorAll(".message-row.is-user .message-body")[0];
  const toggle = document.querySelector(".msg-expand-toggle");
  return { stillClamped: body.classList.contains("is-clamped"), bodyHeight: body.clientHeight, toggleLabel: toggle?.textContent, ariaExpanded: toggle?.getAttribute("aria-expanded") };
});
console.log("STATE_AFTER_EXPAND:", JSON.stringify(state4));
await page.screenshot({ path: ".qa-v4/probe-expanded.png" });

// 暗态渐隐遮罩走查
await page.evaluate(() => { localStorage.setItem("514cc-control-theme", "dark"); });
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 20_000 });
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const stream = document.getElementById("conversation-stream");
  const rows = [];
  for (let i = 0; i < 8; i++) {
    const isUser = i % 3 === 0;
    rows.push(`<article class="message-row${isUser ? " is-user" : ""}"><div class="message-avatar"></div><div class="message-content"><div class="message-head"><strong>${isUser ? "LO" : "Claude"}</strong><time>11:0${i}</time></div>${isUser ? `<p class="message-body">${"暗态长消息渐隐遮罩检查。".repeat(30)}</p>` : `<div class="message-body md-body"><p>助手回复。</p>`}</div></article>`);
  }
  stream.innerHTML = rows.join("");
});
await page.waitForTimeout(600);
await page.screenshot({ path: ".qa-v4/probe-dark-clamp.png" });

console.log("ERRORS:", errs.length);
errs.slice(0, 6).forEach((e) => console.log(" -", e));
await browser.close();
