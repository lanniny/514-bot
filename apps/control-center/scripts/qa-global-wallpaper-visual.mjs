// 全局壁纸视觉 QA（对标 dsh-wallpaper-engine 全局设置面）：真实服务 + 真实前端四连拍。
// 用法：先起隔离实例（见 tests/global-wallpaper-http.test.mjs 的 env 约定），再
//   QA_WALLPAPER_BASE=http://127.0.0.1:18752 QA_WALLPAPER_TOKEN=<token> node scripts/qa-global-wallpaper-visual.mjs
// 产物：.test-visual-out/run-<ts>-{1-appearance,2-aurora,3-workbench,4-overview}.png
import { chromium } from "playwright";

const BASE = process.env.QA_WALLPAPER_BASE || "http://127.0.0.1:18752";
const TOKEN = process.env.QA_WALLPAPER_TOKEN || "e2e-visual-token-0123456789";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 300)));

const OUT = `.test-visual-out/run-${Date.now()}`;

try {
  await page.goto(`${BASE}/#token=${TOKEN}`, { waitUntil: "commit", timeout: 60000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500); // 等首屏数据/自举

  // ── 1. 打开外观面板：先点账户坞进入设置模式，再点外观项 ──
  await page.locator("#account-dock").first().click();
  await page.waitForTimeout(700);
  const appearanceNav = page.locator('.settings-rail-item[data-view="appearance"]').first();
  if (await appearanceNav.count()) {
    await appearanceNav.click();
  } else {
    // 兜底：设置轨未展开时先找任意可见入口
    await page.locator('[data-view="appearance"]').first().click();
  }
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}-1-appearance.png`, fullPage: false });

  // ── 2. 全局壁纸卡片交互：点「极光」预设 ──
  const card = page.locator("#appearance-wallpaper-presets");
  console.log("global-card-count:", await card.count());
  const swatches = page.locator("[data-global-wallpaper-preset]");
  console.log("swatch-count:", await swatches.count());
  const activeBefore = await page.locator("[data-global-wallpaper-preset].is-active").textContent().catch(() => "none");
  console.log("active-before:", activeBefore?.trim());
  await page.locator('[data-global-wallpaper-preset="aurora"]').click();
  await page.waitForTimeout(800);
  const activeAfter = await page.locator("[data-global-wallpaper-preset].is-active").textContent().catch(() => "none");
  console.log("active-after:", activeAfter?.trim());
  console.log("body-team-bg:", await page.evaluate(() => document.body.dataset.teamBg ?? "(none)"));
  console.log("team-bg-active:", await page.evaluate(() => document.body.classList.contains("team-bg-active")));
  await page.screenshot({ path: `${OUT}-2-aurora.png`, fullPage: false });

  // ── 3. 回协作台：壁纸应透过玻璃内容层可见（设置模式下顶栏隐藏，走设置轨返回键）──
  await page.locator('.settings-rail-item.settings-rail-back[data-view="workbench"]').first().click();
  await page.waitForTimeout(1200);
  console.log("workbench-team-bg:", await page.evaluate(() => document.body.dataset.teamBg ?? "(none)"));
  console.log("workbench-gating:", await page.evaluate(() => document.body.classList.contains("team-bg-active")));
  await page.screenshot({ path: `${OUT}-3-workbench.png`, fullPage: false });

  // ── 4. 切到系统总览：其他页面同一张壁纸（核心诉求验证）；折叠轨下直接 JS 触发导航 ──
  await page.evaluate(() => document.querySelector('.topnav-item[data-view="overview"], .nav-item[data-view="overview"]')?.click());
  await page.waitForTimeout(1000);
  console.log("overview-team-bg:", await page.evaluate(() => document.body.dataset.teamBg ?? "(none)"));
  await page.screenshot({ path: `${OUT}-4-overview.png`, fullPage: false });

  console.log("VISUAL-SMOKE-OK");
} finally {
  await browser.close();
}
