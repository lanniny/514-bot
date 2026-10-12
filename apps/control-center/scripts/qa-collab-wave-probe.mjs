// 团队协作逻辑完善波（2026-08-02）探针：
//  ① #/team 首屏 hero 用快源渲染，远快于旧版 3.5s 预算超时；
//  ② roster 席位先「未核验」，health 独立轨道（实测 ~5s）到达后补载升级；
//  ③ 派工建议输入 → 建议卡出现 → 点击采用 → composer #start-agent 值变化 + flash；
//  明暗截图 + 控制台零错误。
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

const t0 = Date.now();
await page.locator('.topbar-nav [data-view="team"]').click();
// ① hero 出现实质内容（非骨架）的耗时（从切视图起算）
await page.waitForFunction(() => {
  const hero = document.getElementById("team-hero-root");
  return hero && !hero.querySelector(".cf-skeleton") && hero.textContent.trim().length > 20;
}, { timeout: 15_000 });
console.log("HERO-READY-MS:", Date.now() - t0);

// ② 席位状态（.tp-dot title）：先记录，再等 health 补载后对比
const seatStatesBefore = await page.evaluate(() =>
  [...document.querySelectorAll("#team-roster-root .tp-dot")].map((el) => el.title));
console.log("SEATS-BEFORE:", JSON.stringify(seatStatesBefore));

await page.waitForTimeout(6500); // health 实测 ~5.3s，留余量
const seatStatesAfter = await page.evaluate(() =>
  [...document.querySelectorAll("#team-roster-root .tp-dot")].map((el) => el.title));
console.log("SEATS-AFTER:", JSON.stringify(seatStatesAfter));

// ③ 派工建议：输入 → 建议卡 → 点击采用
await page.locator(".cf-suggest-input").fill("优化前端页面布局");
await page.waitForTimeout(300);
const picks = await page.locator(".cf-suggest-pick").count();
console.log("SUGGEST-PICKS:", picks);
await page.screenshot({ path: ".qa-v4/collab-wave-suggest-light.png" });

const before = await page.locator("#start-agent").inputValue().catch(() => "(absent)");
if (picks > 0) {
  await page.locator(".cf-suggest-pick").first().click();
}
const flashed = await page.evaluate(() =>
  document.getElementById("start-agent")?.classList.contains("cf-adopted-flash") ?? false);
const note = await page.locator(".cf-suggest-pick .cf-suggest-hint").first().textContent().catch(() => "(none)");
await page.waitForTimeout(100);
const after = await page.locator("#start-agent").inputValue().catch(() => "(absent)");
console.log("START-AGENT:", JSON.stringify({ before, after, flashed, note: note?.trim() }));

// 建议输入在重渲染后应保留
console.log("SUGGEST-VALUE-KEPT:", await page.locator(".cf-suggest-input").inputValue());

// ④ 退出续聊模式后再验证采用 happy path（换一个命中非主脑席位的描述）
await page.evaluate(() => document.getElementById("composer-new-task")?.click());
await page.waitForTimeout(4000); // composer 重渲染走 state 轮询，等一拍
console.log("COMPOSER-MODE:", JSON.stringify({
  hint: await page.locator("#composer-mode-hint").textContent().catch(() => "(none)"),
  disabled: await page.evaluate(() => document.getElementById("start-agent")?.disabled),
}));
await page.locator(".cf-suggest-input").fill("评审这段代码的安全漏洞");
await page.waitForTimeout(300);
const picks2 = await page.locator(".cf-suggest-pick").count();
const before2 = await page.locator("#start-agent").inputValue().catch(() => "(absent)");
if (picks2 > 0) {
  await page.locator(".cf-suggest-pick").first().click();
}
const flashed2 = await page.evaluate(() =>
  document.getElementById("start-agent")?.classList.contains("cf-adopted-flash") ?? false);
const note2 = await page.locator(".cf-suggest-pick .cf-suggest-hint").first().textContent().catch(() => "(none)");
const after2 = await page.locator("#start-agent").inputValue().catch(() => "(absent)");
console.log("ADOPT-FRESH:", JSON.stringify({ picks: picks2, before: before2, after: after2, flashed: flashed2, note: note2?.trim() }));
await page.screenshot({ path: ".qa-v4/collab-wave-adopted-light.png" });

// 暗色截图
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await page.waitForTimeout(400);
await page.screenshot({ path: ".qa-v4/collab-wave-team-dark.png" });

console.log("ERRORS:", errs.length);
errs.slice(0, 6).forEach((e) => console.log(" -", e));
await browser.close();
