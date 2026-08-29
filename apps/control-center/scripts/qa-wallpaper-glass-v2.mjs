#!/usr/bin/env node
/**
 * 壁纸调和玻璃 v2 视觉冒烟（2026-08-29 玻璃质感/颜色调和波）：
 *   1. 起隔离实例，浏览器内 canvas 画一张「蓝天 + 黄花」高对比照片式壁纸（模拟 LO 截图
 *      场景：冷蓝底 + 高饱和黄花，正是暖纸玻璃发脏、14px 磨砂挡不住前景形状的用例）；
 *   2. 上传为全局自定义壁纸 → 重载 → 等 body.team-bg-active + 媒体采样完成；
 *   3. 断言环境有效值真的生效：--wall-tint 为蓝族 oklch、壳层 backdrop-filter =
 *      blur(24px) saturate(1.65)、背景 alpha ≈ 0.78；
 *   4. OPAQUE-PROBE 复扫「无磨砂 + 高 alpha」怪块（上轮工具沿用，找漏网实底）；
 *   5. 截图：亮色工作台 / 暗色工作台 / 设置·外观。
 */
import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const out = resolve(appRoot, ".test-glass-v2-out");
await mkdir(out, { recursive: true });
const dataRoot = await mkdtemp(resolve(out, "tmp-"));

const token = "vis-glass-v2";
const child = spawnTestServer({
  env: {
    ...process.env,
    CONTROL_CENTER_TOKEN: token,
    CONTROL_CENTER_PORT: "0",
    CONTROL_CENTER_DATA_DIR: dataRoot,
  },
});
const baseUrl = new URL(await waitForUrl(child)).origin;
console.log("BASE-URL:", baseUrl);

const { chromium } = await import("playwright");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (err) => console.log("[pageerror]", err.message));
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("[console.error]", msg.text().slice(0, 200));
});

await page.goto(`${baseUrl}/#token=${token}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(1500);

// 浏览器内画「蓝天 + 黄花」照片式壁纸并上传（照片级噪声 blob 才能让采样/磨砂真正受力）
const upload = await page.evaluate(async (auth) => {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 600;
  const ctx = canvas.getContext("2d");
  const sky = ctx.createLinearGradient(0, 0, 0, 600);
  sky.addColorStop(0, "#4d9fe8");
  sky.addColorStop(0.55, "#8ec5f2");
  sky.addColorStop(1, "#c9e4f7");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 960, 600);
  // 云
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  for (const [x, y, r] of [[180, 110, 60], [260, 130, 44], [720, 90, 70], [800, 120, 40]]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // 黄花簇（高饱和前景，模拟 LO 壁纸的黄花）
  for (const [cx, cy] of [[120, 470], [300, 520], [520, 460], [760, 540], [880, 430], [420, 560]]) {
    for (let petal = 0; petal < 6; petal += 1) {
      const angle = (petal / 6) * Math.PI * 2;
      ctx.fillStyle = petal % 2 ? "#ffd23f" : "#f5b91e";
      ctx.beginPath();
      ctx.arc(cx + Math.cos(angle) * 26, cy + Math.sin(angle) * 26, 20, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#c98a12";
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.fill();
  }
  const dataUrl = canvas.toDataURL("image/png");
  const pref = JSON.stringify({
    preset: "custom",
    fit: "cover",
    overrideTeam: true,
    rotate: { enabled: false, intervalMin: 5, order: "sequential" },
    hasCustom: true,
  });
  const putPref = await fetch("/api/preferences", {
    method: "PUT",
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({ "514cc-global-wallpaper": pref }),
  });
  const postMedia = await fetch("/api/wallpapers/global", {
    method: "POST",
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({ dataUrl }),
  });
  // 双写本地：API 直写服务端后，页面自身的偏好同步若先触发会把旧 localStorage 推回
  // 服务端覆盖掉壁纸配置（实测间歇性踩中）。本地同值落位后，双向同步都不会翻掉壁纸。
  localStorage.setItem("514cc-global-wallpaper", pref);
  return { putPref: putPref.status, postMedia: postMedia.status };
}, token);
console.log("UPLOAD:", JSON.stringify(upload));
if (upload.putPref !== 200 || upload.postMedia !== 200) throw new Error("wallpaper upload failed; aborting");

// 重载走真实启动管线：偏好水合 → 壁纸挂载 → 媒体采样 → 环境玻璃令牌
await page.reload({ waitUntil: "domcontentloaded" });
// 三段式等待：分别定位卡点（门控类 / 媒体对象 / 采样染色），超时时打印现场
await page.waitForFunction(() => document.body.classList.contains("team-bg-active"), null, { timeout: 20_000 }).then(
  () => console.log("STEP1 team-bg-active: on"),
  async () => console.log("STEP1 team-bg-active: TIMEOUT — bodyClass =", await page.evaluate(() => document.body.className)),
);
await page.waitForFunction(
  () => Boolean(document.querySelector(".team-bg-media img, .team-bg-media video")),
  null,
  { timeout: 20_000 },
).then(
  () => console.log("STEP2 media object: on"),
  () => console.log("STEP2 media object: TIMEOUT"),
);
await page.waitForFunction(
  () => document.documentElement.style.getPropertyValue("--wall-tint").includes("oklch"),
  null,
  { timeout: 20_000 },
).then(
  () => console.log("STEP3 wall-tint sampled: on"),
  () => console.log("STEP3 wall-tint sampled: TIMEOUT"),
);
await page.waitForTimeout(1200);

const probe = async () => page.evaluate(() => {
  const read = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return "(missing)";
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, filter: cs.backdropFilter || cs.webkitBackdropFilter, shadow: cs.boxShadow.slice(0, 90) };
  };
  // OPAQUE-PROBE：无 backdrop-filter 且高 alpha 的大面积怪块（漏网实底清单）
  const opaque = [];
  for (const el of document.body.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (cs.backdropFilter && cs.backdropFilter !== "none") continue;
    const match = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (!match) continue;
    const parts = match[1].split(",").map((piece) => Number(piece.trim()));
    const alpha = parts.length === 4 ? parts[3] : 1;
    if (alpha < 0.6) continue;
    const area = el.getBoundingClientRect();
    if (area.width * area.height < 120_000) continue;
    opaque.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} ${Math.round(area.width)}x${Math.round(area.height)} ${cs.backgroundColor}`);
  }
  return {
    wallGlassMode: document.body.dataset.wallGlass || "(none)",
    wallTint: document.documentElement.style.getPropertyValue("--wall-tint"),
    wallLum: document.documentElement.style.getPropertyValue("--wall-lum"),
    glassAlpha: document.documentElement.style.getPropertyValue("--forge-glass-alpha"),
    glassFilter: document.documentElement.style.getPropertyValue("--forge-glass-filter"),
    topbar: read(".topbar"),
    sidebar: read(".sidebar"),
    statusbar: read(".global-statusbar"),
    conversationPane: read("#view-workbench .conversation-pane"),
    runRail: read("#view-workbench .run-rail"),
    opaqueProbe: opaque.slice(0, 14),
  };
});
const fmt = (value) => JSON.stringify(value, null, 2);

// 1) 亮色工作台
console.log("PROBE-LIGHT:", fmt(await probe()));
await page.screenshot({ path: `${out}/v2-workbench-light.png` });

// 2) 暗色工作台（主题切换 → --wall-tint 明度应随主题收敛）
await page.evaluate(() => {
  localStorage.setItem("514cc-control-theme", "dark");
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.classList.contains("team-bg-active"), null, { timeout: 30_000 });
// --wall-lum 只在真实采样（非过渡桥）时写入：等采样完成再探暗色调和值
await page.waitForFunction(
  () => document.documentElement.style.getPropertyValue("--wall-lum") !== "",
  null,
  { timeout: 20_000 },
).then(() => console.log("DARK-SAMPLE: on"), () => console.log("DARK-SAMPLE: TIMEOUT (bridge still active)"));
await page.waitForTimeout(600);
console.log("PROBE-DARK tint:", await page.evaluate(() => document.documentElement.style.getPropertyValue("--wall-tint")));
await page.screenshot({ path: `${out}/v2-workbench-dark.png` });

// 3) 设置 · 外观（暗色保持，看玻璃设置卡）
await page.evaluate(() => {
  localStorage.setItem("514cc-control-theme", "light");
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.classList.contains("team-bg-active"), null, { timeout: 30_000 });
await page.waitForTimeout(800);
await page.locator("#account-dock").click({ timeout: 10_000 });
await page.waitForTimeout(500);
await page.locator('.settings-rail-item[data-view="appearance"]').click({ timeout: 10_000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/v2-appearance.png` });

// 4) 窄桌面/高缩放（≤820 逻辑宽，复刻 2000 物理 ÷ 250%）：工作台玻璃必须仍生效
//    （磨砂下沉到内层），且采样兜底让档位在无采样时也按 bold 放行
await page.setViewportSize({ width: 800, height: 900 });
await page.goto(`${baseUrl}/#token=${token}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.classList.contains("team-bg-active"), null, { timeout: 30_000 });
await page.waitForFunction(
  () => Boolean(document.body.dataset.wallGlass),
  null,
  { timeout: 20_000 },
).then(() => console.log("NARROW wallGlass: on"), () => console.log("NARROW wallGlass: TIMEOUT"));
await page.waitForTimeout(1000);
const narrow = await page.evaluate(() => {
  const read = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return "(missing)";
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, filter: cs.backdropFilter };
  };
  return {
    innerWidth: window.innerWidth,
    wallGlass: document.body.dataset.wallGlass || "(none)",
    glassAlpha: document.documentElement.style.getPropertyValue("--forge-glass-alpha") || "(absent)",
    stream: read("#view-workbench .conversation-stream"),
    pane: read("#view-workbench .conversation-pane"),
  };
});
console.log("NARROW-800:", JSON.stringify(narrow));
await page.screenshot({ path: `${out}/v2-narrow800.png` });

// 5) 手动接管（514cc-wallpaper-glass-alpha）：手动 20 → alpha 必须直接 20%（不套档位）；
//    切回 auto → 回到档位计算值（bold 30%）。自动是起点，不是终点（LO 自定义程度诉求）。
await page.setViewportSize({ width: 1440, height: 900 });
await page.evaluate(() => localStorage.setItem("514cc-wallpaper-glass-alpha", "20"));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.classList.contains("team-bg-active"), null, { timeout: 30_000 });
await page.waitForTimeout(1500);
const manualProbe = await page.evaluate(() => ({
  pref: localStorage.getItem("514cc-wallpaper-glass-alpha"),
  glassAlpha: document.documentElement.style.getPropertyValue("--forge-glass-alpha"),
}));
console.log("MANUAL-20:", JSON.stringify(manualProbe));
if (manualProbe.glassAlpha !== "20%") throw new Error(`手动接管失效：期望 20%，实际 ${manualProbe.glassAlpha}`);
await page.screenshot({ path: `${out}/v2-manual20.png` });
await page.evaluate(() => localStorage.setItem("514cc-wallpaper-glass-alpha", "auto"));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.classList.contains("team-bg-active"), null, { timeout: 30_000 });
await page.waitForTimeout(1500);
const autoProbe = await page.evaluate(() => document.documentElement.style.getPropertyValue("--forge-glass-alpha"));
console.log("BACK-TO-AUTO:", autoProbe);

// 5b) UI 拖动验证（v5.1 交互死锁回归锁）：外观面板滑杆必须永远可拖——auto 档拖到 35
//     立即接管（localStorage 35 + glassAlpha 35%），滑杆不得被回填拉回档位值。
await page.locator("#account-dock").click({ timeout: 10_000 });
await page.waitForTimeout(500);
await page.locator('.settings-rail-item[data-view="appearance"]').click({ timeout: 10_000 });
await page.waitForTimeout(800);
const slider = page.locator("#appearance-wallpaper-glass-alpha");
const sliderState = await slider.evaluate((el) => ({ disabled: el.disabled, value: el.value }));
console.log("SLIDER-STATE:", JSON.stringify(sliderState));
if (sliderState.disabled) throw new Error("滑杆被禁用：交互死锁回归（v5.1）");
await slider.fill("35");
await slider.dispatchEvent("input");
await page.waitForTimeout(400);
const dragProbe = await page.evaluate(() => ({
  pref: localStorage.getItem("514cc-wallpaper-glass-alpha"),
  glassAlpha: document.documentElement.style.getPropertyValue("--forge-glass-alpha"),
  sliderValue: document.querySelector("#appearance-wallpaper-glass-alpha").value,
}));
console.log("UI-DRAG-35:", JSON.stringify(dragProbe));
if (dragProbe.pref !== "35" || dragProbe.glassAlpha !== "35%" || dragProbe.sliderValue !== "35") {
  throw new Error(`滑杆拖动接管失效：${JSON.stringify(dragProbe)}`);
}

// 6) 壁纸磨砂强度（v6）：手动 0 → 滤镜串必须 blur(0px)（壁纸完全清晰）；
//    拖 alpha 不丢 blur 手动档；切回 auto → 档位偏移值（16px）。
await page.locator("#appearance-wallpaper-glass-blur").fill("0");
await page.locator("#appearance-wallpaper-glass-blur").dispatchEvent("input");
await page.waitForTimeout(400);
const blurZero = await page.evaluate(() => ({
  pref: localStorage.getItem("514cc-wallpaper-glass-blur"),
  filter: document.documentElement.style.getPropertyValue("--forge-glass-filter"),
}));
console.log("BLUR-0:", JSON.stringify(blurZero));
if (!/blur\(0px\)/.test(blurZero.filter)) throw new Error(`磨砂 0 接管失效：${blurZero.filter}`);
await page.evaluate(() => localStorage.setItem("514cc-wallpaper-glass-alpha", "60"));
await page.waitForTimeout(400);
const alphaKeepBlur = await page.evaluate(() => document.documentElement.style.getPropertyValue("--forge-glass-filter"));
console.log("ALPHA-DRAG-KEEPS-BLUR0:", alphaKeepBlur);
if (!/blur\(0px\)/.test(alphaKeepBlur)) throw new Error(`拖 alpha 丢了 blur 手动档：${alphaKeepBlur}`);
await page.screenshot({ path: `${out}/v2-blur0.png` });
await page.evaluate(() => {
  localStorage.setItem("514cc-wallpaper-glass-blur", "auto");
  localStorage.setItem("514cc-wallpaper-glass-alpha", "auto");
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.classList.contains("team-bg-active"), null, { timeout: 30_000 });
await page.waitForTimeout(1500);
console.log("BOTH-AUTO-FILTER:", await page.evaluate(() => document.documentElement.style.getPropertyValue("--forge-glass-filter")));

// 7) 滚动渐隐（缺陷波）：切回协作台 → 等壁纸媒体就绪 → 注入完整结构的消息行 →
//    滚到中部 → 顶部文字应从标题栏下缘淡入而非被视口边线切成半截。
await page.evaluate(() => {
  const back = [...document.querySelectorAll("button, a")]
    .find((el) => el.textContent?.includes("返回协作台"));
  if (back) back.click();
});
await page.waitForFunction(() => Boolean(document.querySelector(".team-bg-media img, .team-bg-media video")), null, { timeout: 20_000 })
  .then(() => console.log("FADE media: ready"), () => console.log("FADE media: TIMEOUT"));
await page.waitForTimeout(600);
await page.evaluate(() => {
  const stream = document.querySelector("#conversation-stream");
  if (!stream) return;
  for (let i = 0; i < 8; i += 1) {
    const row = document.createElement("div");
    row.className = "message-row";
    // 完整 grid 结构（avatar 列 + content 列），缺列会被 30px 首列压成竖排
    row.innerHTML = `<span class="message-avatar"></span><div class="message-content"><div class="message-head"><strong>QA</strong></div><div class="message-body"><p>滚动渐隐验证段落 ${i + 1}——这是一段足够长的正文，用来把会话流撑出滚动余量，验证顶部渐隐 mask 是否在滚动到中部时把越界文字淡入标题栏下缘。</p></div></div>`;
    stream.appendChild(row);
  }
  stream.scrollTop = 260;
});
await page.waitForTimeout(400);
console.log("SCROLL-FADE probe:", await page.evaluate(() => {
  const stream = document.querySelector("#conversation-stream");
  const cs = getComputedStyle(stream);
  return { scrollTop: stream.scrollTop, mask: (cs.maskImage || cs.webkitMaskImage || "").slice(0, 80) };
}));
await page.screenshot({ path: `${out}/v2-scroll-fade.png` });

// 8) 内容卡玻璃度（v7）：拖 card 滑杆 50 → --forge-card-alpha 必须直接 50%，
//    恢复条 computed 背景跟着变半透；切回 auto → bold 档位值 62%。
await page.locator("#account-dock").click({ timeout: 10_000 });
await page.waitForTimeout(500);
await page.locator('.settings-rail-item[data-view="appearance"]').click({ timeout: 10_000 });
await page.waitForTimeout(800);
const cardSlider = page.locator("#appearance-card-glass-alpha");
await cardSlider.fill("50");
await cardSlider.dispatchEvent("input");
await page.waitForTimeout(400);
const cardProbe = await page.evaluate(() => ({
  pref: localStorage.getItem("514cc-card-glass-alpha"),
  token: document.documentElement.style.getPropertyValue("--forge-card-alpha"),
  recoveryBg: getComputedStyle(document.querySelector(".recovery-bar") || document.body).backgroundColor,
}));
console.log("CARD-50:", JSON.stringify(cardProbe));
if (cardProbe.token !== "50%") throw new Error(`内容卡玻璃度接管失效：${JSON.stringify(cardProbe)}`);
await page.locator("#appearance-card-glass-auto").click();
await page.waitForTimeout(400);
console.log("CARD-AUTO:", await page.evaluate(() => ({
  pref: localStorage.getItem("514cc-card-glass-alpha"),
  token: document.documentElement.style.getPropertyValue("--forge-card-alpha"),
})));
await page.screenshot({ path: `${out}/v2-card-glass.png` });

await browser.close();
await stopTestServer(child).catch(() => {});
await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
console.log("DONE →", out);
