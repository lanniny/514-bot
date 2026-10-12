// cc-switch 完全迁移二波 UI 探针：供应商面板全场景截图
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const base = "http://127.0.0.1:4821";
const outDir = "../../.scratch/qa-w2";
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1512, height: 945 } });
await page.addInitScript(() => { try { localStorage.setItem("514cc-product-tour-dismissed", "1"); } catch {} }); // 首跑导览对话框会挡视口点击（D-2026-09-28-018）
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300)); });
page.on("pageerror", (err) => consoleErrors.push(`PAGEERROR: ${String(err).slice(0, 300)}`));
page.on("dialog", (dialog) => void dialog.dismiss());

await page.goto(`${base}/#token=qatoken-w2`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 20_000 });
await page.waitForTimeout(1500);

async function shot(name) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log("shot:", name);
}

// 进配置视图
await page.locator('.topbar-nav [data-view="config"]').first().click();
await page.waitForTimeout(1500);
await shot("01-provider-deck");

// 健康检查：第一张卡（PackyCode，队列 P1，不可达时应触发自动故障转移提示）
const firstCheck = page.locator("[data-provider-check]").first();
await firstCheck.click();
await page.waitForTimeout(12_000); // 8s 超时 + 1 重试上限的余量
await shot("02-after-check");

// 测速：第二张卡（DeepSeek）
const speedButtons = page.locator("[data-provider-speed]");
if (await speedButtons.count() > 1) {
  await speedButtons.nth(1).click();
  await page.waitForTimeout(10_000);
  await shot("03-after-speedtest");
}

// 编辑对话框：六个 tab 全巡
await page.locator("[data-provider-edit]").first().click();
await page.waitForTimeout(800);
await shot("10-dialog-basic");
for (const tab of ["endpoints", "usage", "proxy", "test", "advanced"]) {
  await page.locator(`[data-provider-tab="${tab}"]`).click();
  await page.waitForTimeout(400);
  await shot(`10-dialog-${tab}`);
}
// 端点 tab：测速全部
await page.locator('[data-provider-tab="endpoints"]').click();
await page.waitForTimeout(300);
await page.locator("#provider-endpoint-test-button").click();
await page.waitForTimeout(10_000);
await shot("11-endpoints-speedtested");
// 用量 tab：测试脚本（真实打 packycode /user/balance，预期失败如实显示）
await page.locator('[data-provider-tab="usage"]').click();
await page.waitForTimeout(300);
await page.locator("#provider-usage-test-button").click();
await page.waitForTimeout(12_000);
await shot("12-usage-tested");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

// 排序模式（v42：工具从 6 个图标按钮收进「更多供应商工具」溢出菜单）
const pickTool = async (label) => {
  await page.locator("#provider-tools-button").click();
  await page.waitForTimeout(250);
  await page.locator(`#context-menu [role="menuitem"]:has-text("${label}")`).first().click();
};
await pickTool("调整档案顺序");
await page.waitForTimeout(500);
await shot("20-sort-mode");
await page.locator("#provider-sort-exit").click();

// 环境检查（跳到工作台「同步」面的唯一实现）
await pickTool("环境变量冲突检查");
await page.waitForTimeout(1600);
await shot("21-envcheck");

console.log("consoleErrors:", consoleErrors.length);
for (const line of consoleErrors.slice(0, 10)) console.log("  ERR:", line);
await browser.close();
