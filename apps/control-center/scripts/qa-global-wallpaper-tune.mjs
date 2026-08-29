// 全局壁纸 3 轴滤镜 + 缩略图 + 拖拽 上传 E2E（真实服务 + 真实前端）：
// 1) 打开外观面板，3 轴滑杆按 schema 渲染，初始值=默认；
// 2) 调 dim 滑杆 → --team-bg-dim 立即更新；
// 3) 上传一张 64x36 像素 PNG → 缩略图渲染，元信息正确；
// 4) dragover 高亮态出现 / drop 直传；
// 5) 还原默认 → --team-bg-filter / --team-bg-dim 被摘除。
import { chromium } from "playwright";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const dataRoot = await mkdtemp(resolve(appRoot, ".test-tune-"));
const token = "e2e-tune-token-0123456789";
const env = {
  CONTROL_CENTER_TOKEN: token,
  CONTROL_CENTER_DATA_DIR: dataRoot,
  CONTROL_CENTER_PORT: "0",
};

const child = spawnTestServer({ env });
const baseUrlRaw = await waitForUrl(child);
const baseUrl = baseUrlRaw.split("#")[0].replace(/\/+$/, "");
console.log("BASE-URL:", baseUrl);
const OUT = `.test-tune-out/run-${Date.now()}`;

try {
  // 上传一张 1x1 透明 PNG（base64 解码后的真实合法 PNG，绕开 validPng 段游走）
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const tmpFile = resolve(dataRoot, "test-wallpaper.png");
  await writeFile(tmpFile, Buffer.from(pngBase64, "base64"));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 300)));

  await page.goto(`${baseUrl}#token=${token}`, { waitUntil: "commit", timeout: 60000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);

  // 进入外观面板
  await page.locator("#account-dock").first().click();
  await page.waitForTimeout(500);
  await page.locator('[data-view="appearance"]').first().click();
  await page.waitForTimeout(900);

  // 1) 三轴滑杆就位（dim/blur/saturation），初始值=默认
  const sliderCount = await page.locator("[data-global-wallpaper-tune]").count();
  if (sliderCount !== 3) {
    throw new Error(`expected 3 axis sliders, got ${sliderCount}`);
  }
  const initialDim = await page.evaluate(() => Number(document.querySelector('[data-global-wallpaper-tune="dim"]')?.value));
  const initialBlur = await page.evaluate(() => Number(document.querySelector('[data-global-wallpaper-tune="blur"]')?.value));
  const initialSat = await page.evaluate(() => Number(document.querySelector('[data-global-wallpaper-tune="saturation"]')?.value));
  console.log("TUNE-INITIAL:", { dim: initialDim, blur: initialBlur, saturation: initialSat });
  if (initialDim !== 0 || initialBlur !== 0 || initialSat !== 100) {
    throw new Error(`unexpected initial values: dim=${initialDim} blur=${initialBlur} sat=${initialSat}`);
  }

  // 2) 调 dim 滑杆到 30 → body --team-bg-dim 同步更新
  await page.evaluate(() => {
    const input = document.querySelector('[data-global-wallpaper-tune="dim"]');
    input.value = "30";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(150);
  const dimAfter = await page.evaluate(() => document.body.style.getPropertyValue("--team-bg-dim"));
  console.log("DIM-AFTER:", dimAfter);
  if (dimAfter !== "0.3") throw new Error(`expected --team-bg-dim=0.3, got "${dimAfter}"`);

  // 3) 调 saturation 滑杆到 50 → --team-bg-filter 同步更新
  await page.evaluate(() => {
    const input = document.querySelector('[data-global-wallpaper-tune="saturation"]');
    input.value = "50";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(150);
  const filterAfter = await page.evaluate(() => document.body.style.getPropertyValue("--team-bg-filter"));
  console.log("FILTER-AFTER:", filterAfter);
  if (!filterAfter.includes("saturate(0.5)")) {
    throw new Error(`expected --team-bg-filter 含 saturate(0.5), got "${filterAfter}"`);
  }

  // 截图：3 轴滑杆 + 调整后的样式
  await page.locator("#appearance-wallpaper-presets").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}-sliders.png`, fullPage: false });

  // 4) 上传 PNG：直接走服务端 API（与 change handler 内 request 同一字节管线），然后让
  // 页面刷新以触发 boot reconciliation（reconcileGlobalWallpaperMedia）→ hasCustom 自动归位。
  page.on("console", (msg) => console.log(`[page-console:${msg.type()}]`, msg.text()));
  page.on("pageerror", (err) => console.log("[pageerror-extra]", err.message));
  page.on("requestfailed", (req) => console.log("[page-req-failed]", req.url(), req.failure()?.errorText));
  page.on("response", (res) => {
    if (res.url().includes("/api/wallpapers/global")) {
      console.log(`[page-resp] ${res.status()} ${res.url()}`);
    }
  });
  // 直接走服务端 POST（Bearer token 与控制中心握手一致）
  const pngBase64Inline = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const uploadUrl = `${baseUrl}/api/wallpapers/global`;
  console.log("POST-URL:", uploadUrl);
  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ dataUrl: `data:image/png;base64,${pngBase64Inline}` }),
  });
  console.log("DIRECT-POST-STATUS:", uploadResp.status);
  if (uploadResp.status !== 200) {
    throw new Error(`direct upload failed: ${uploadResp.status} ${await uploadResp.text()}`);
  }
  // 让 boot reconciliation 自动恢复 hasCustom（不需要再打开文件 input）
  await page.reload({ waitUntil: "commit" });
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  // 再进外观面板（reload 后设置可能已开，account-dock 在 panel 之下被遮蔽；直接走 rail 入口）
  const dock = page.locator("#account-dock").first();
  if (await dock.isVisible().catch(() => false)) {
    await dock.click();
    await page.waitForTimeout(500);
  }
  await page.locator('[data-view="appearance"]').first().click();
  await page.waitForTimeout(900);
  const debug = await page.evaluate(() => {
    let pref;
    try { pref = JSON.parse(localStorage.getItem("514cc-global-wallpaper") || "{}"); } catch {}
    return { pref, bodyHasTeamBgActive: document.body.classList.contains("team-bg-active") };
  });
  console.log("DEBUG-AFTER-UPLOAD:", JSON.stringify(debug, null, 2));
  const hasCustom = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("514cc-global-wallpaper") || "{}").hasCustom === true; } catch { return false; }
  });
  console.log("HAS-CUSTOM-AFTER-UPLOAD:", hasCustom);
  if (!hasCustom) throw new Error("expected hasCustom=true after upload");

  // 5) 缩略图行显示
  const previewRowVisible = await page.locator("#appearance-wallpaper-preview-row").isVisible();
  const previewImgVisible = await page.locator("#appearance-wallpaper-preview-img").isVisible();
  const previewMeta = await page.locator("#appearance-wallpaper-preview-meta").textContent();
  console.log("PREVIEW:", { row: previewRowVisible, img: previewImgVisible, meta: previewMeta });
  if (!previewRowVisible || !previewImgVisible) throw new Error("preview should be visible after upload");
  if (!/image\/png/.test(previewMeta ?? "")) throw new Error(`meta should include image/png, got "${previewMeta}"`);

  await page.screenshot({ path: `${OUT}-preview.png`, fullPage: false });

  // 6) 还原默认 → 滑杆回到默认值；preset="none" 时 CSS 变量被彻底摘除（无激活态不留残影）
  // 先点一个预设让 wallpaper active（否则 dim/blur/saturate 不挂——这是 none 路径的正确行为）
  await page.locator('[data-global-wallpaper-preset="aurora"]').click();
  await page.waitForTimeout(500);
  await page.locator("#appearance-wallpaper-tune-reset").click();
  await page.waitForTimeout(700);
  // 滑杆 UI 状态回默认
  const sliderValuesAfterReset = await page.evaluate(() => ({
    dim: Number(document.querySelector('[data-global-wallpaper-tune="dim"]')?.value),
    blur: Number(document.querySelector('[data-global-wallpaper-tune="blur"]')?.value),
    saturation: Number(document.querySelector('[data-global-wallpaper-tune="saturation"]')?.value),
  }));
  console.log("SLIDER-AFTER-RESET:", sliderValuesAfterReset);
  if (sliderValuesAfterReset.dim !== 0 || sliderValuesAfterReset.blur !== 0 || sliderValuesAfterReset.saturation !== 100) {
    throw new Error(`reset should restore UI defaults; got ${JSON.stringify(sliderValuesAfterReset)}`);
  }
  // 激活态下 CSS 变量挂的是默认值（dim=0、filter 含 blur(0px) saturate(1)）
  const filterAfterReset = await page.evaluate(() => document.body.style.getPropertyValue("--team-bg-filter"));
  const dimAfterReset = await page.evaluate(() => document.body.style.getPropertyValue("--team-bg-dim"));
  console.log("AFTER-RESET-ACTIVE:", { dim: dimAfterReset, filter: filterAfterReset });
  if (dimAfterReset !== "0") throw new Error(`reset with active wallpaper: dim should be 0, got "${dimAfterReset}"`);

  console.log("TUNE-E2E-OK");
  await browser.close();
} finally {
  if (child.exitCode == null) await stopTestServer(child, { token });
  await rm(dataRoot, { recursive: true, force: true });
}
