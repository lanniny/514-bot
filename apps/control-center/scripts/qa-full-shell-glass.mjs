#!/usr/bin/env node
/**
 * 全壳玻璃透出视觉冒烟：起隔离实例，挂一张 PNG 做壁纸，进工作台 / 设置(外观) /
 * 总览三个关键视图，截图 + computedStyle 证明 topbar / global-statusbar / sidebar
 * 与会话/左/右轨走同一族玻璃公式（backdrop-filter 非 none、背景带透明度）。
 *
 * 踩坑记录：waitForUrl 返回的 URL 带尾斜杠，直接 `${baseUrl}/api/...` 拼接会得到
 * `//api/...` 双斜杠 pathname，server 严格按 pathname === "/api/preferences" 匹配
 * → 404。必须先 new URL(...).origin 归一化。
 */
import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const out = resolve(appRoot, ".test-glass-out");
await mkdir(out, { recursive: true });
// dataRoot 必须每次全新：server 有 instance-lock（dataRoot/control-center.lock），
// 脚本异常退出（硬杀）会残留 stale lock，下一个实例 trash 清锁失败 → exit 1。
const dataRoot = await mkdtemp(resolve(out, "tmp-"));

const token = "vis-glass";
const env = {
  ...process.env,
  CONTROL_CENTER_TOKEN: token,
  CONTROL_CENTER_PORT: "0",
  CONTROL_CENTER_DATA_DIR: dataRoot,
};
const child = spawnTestServer({ env });
const baseUrl = new URL(await waitForUrl(child)).origin;
console.log("BASE-URL:", baseUrl);

// 设偏好：通过 server 自身 API（隔离实例；body 是 { key: "<JSON 字符串>" }，
// 服务端 sanitizePreferenceInput 只收 string 值）。
const wallpaperPref = JSON.stringify({
  preset: "custom",
  fit: "cover",
  overrideTeam: true,
  rotate: { enabled: false, intervalMin: 5, order: "sequential" },
  hasCustom: true,
});
const putResp = await fetch(`${baseUrl}/api/preferences`, {
  method: "PUT",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ "514cc-global-wallpaper": wallpaperPref }),
});
console.log("PREFERENCES-PUT-STATUS:", putResp.status);
if (putResp.status !== 200) {
  console.log("PUT-BODY:", await putResp.text());
  throw new Error("preferences PUT failed; aborting visual smoke");
}

// 256×256 大块彩色 PNG：上半蓝 / 中金 / 下白，肉眼一目了然 wallpaper 透过能力
async function makeTestPng() {
  const { createCanvas } = await import("canvas").catch(() => ({ createCanvas: null }));
  if (createCanvas) {
    const canvas = createCanvas(256, 256);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#7ec0ff"; ctx.fillRect(0, 0, 256, 96);
    ctx.fillStyle = "#ffd76a"; ctx.fillRect(0, 96, 256, 64);
    ctx.fillStyle = "#fefefe"; ctx.fillRect(0, 160, 256, 96);
    return canvas.toBuffer("image/png");
  }
  // 备：纯橙（任意最鲜实的颜色，证明「色能传过来」即可）
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
    0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54,
    0x08, 0xd7, 0x63, 0xf8, 0x4f, 0xa0, 0x00, 0x00,
    0x00, 0x03, 0x00, 0x01, 0x5b, 0xb4, 0x5a, 0x7d,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ]);
}
const tinyPng = await makeTestPng();
const uploadResp = await fetch(`${baseUrl}/api/wallpapers/global`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ dataUrl: `data:image/png;base64,${tinyPng.toString("base64")}` }),
});
console.log("WALLPAPER-POST-STATUS:", uploadResp.status);
if (uploadResp.status !== 200) {
  console.log("UPLOAD-BODY:", await uploadResp.text());
  throw new Error("wallpaper upload failed; aborting visual smoke");
}

// 起 Playwright 跑视觉
const { chromium } = await import("playwright");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (err) => console.log("[pageerror]", err.message));

await page.goto(`${baseUrl}/#token=${token}`, { waitUntil: "domcontentloaded", timeout: 60000 });
// 等 app.js 完成：hydratePreferencesFromServer 回填 localStorage → 壁纸管线挂
// body.team-bg-active（HTTP 往返 + 图片解码，放宽到 20s）。
await page.waitForFunction(() => document.body.classList.contains("team-bg-active"), null, {
  timeout: 20_000,
}).then(
  () => console.log("TEAM-BG-ACTIVE: on"),
  (err) => console.log("TEAM-BG-ACTIVE: TIMEOUT —", err.message),
);
await page.waitForTimeout(1200);

const inspectShellGlass = async () => {
  return await page.evaluate(() => {
    const read = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return "(missing)";
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, filter: cs.backdropFilter || cs.webkitBackdropFilter, opacity: cs.opacity };
    };
    const body = document.body;
    return {
      bodyClass: body.className || "(none)",
      dataTeamBg: body.getAttribute("data-team-bg") || "(none)",
      hasTeamBgActive: body.classList.contains("team-bg-active"),
      topbar: read(".topbar"),
      statusbar: read(".global-statusbar"),
      sidebar: read(".sidebar"),
      accountDock: read(".account-dock"),
      // 工作台三块大卡片（会话面/左轨/右轨）：只在 workbench 视图存在
      conversationPane: read("#view-workbench .conversation-pane"),
      runRail: read("#view-workbench .run-rail"),
      contextRail: read("#view-workbench .context-rail"),
      // atelier 整壳底层幕布
      stage: read(".atelier-stage"),
      appShell: read(".app-shell"),
      // 设置视图中央 panel（app-shell.is-settings .main-content / .settings-card）
      settingsMain: read(".app-shell.is-settings .main-content"),
      settingsCard: read(".app-shell.is-settings .settings-card"),
      // 总览视图中央 panel
      overviewView: read("#view-overview.view"),
    };
  });
};
const fmt = (state) => JSON.stringify(state, null, 2);

// 1) 默认视图（协作台）
const workbenchShot = `${out}/workbench-glass.png`;
await page.screenshot({ path: workbenchShot });
console.log("WORKBENCH:", fmt(await inspectShellGlass()));

// 2) 设置 · 外观（account-dock 打开设置，settings-rail 切 appearance）
await page.locator("#account-dock").click({ timeout: 10_000 });
await page.waitForTimeout(600);
await page.locator('.settings-rail-item[data-view="appearance"]').click({ timeout: 10_000 });
await page.waitForTimeout(900);
const appearanceShot = `${out}/appearance-glass.png`;
await page.screenshot({ path: appearanceShot });
console.log("APPEARANCE:", fmt(await inspectShellGlass()));

// 3) 总览（走 hash 路由：设置视图下侧栏 nav 元素不可见，点 [data-view] 必然超时）
await page.evaluate(() => { window.location.hash = "#overview"; });
await page.waitForSelector("#view-overview.is-active", { timeout: 10_000 });
await page.waitForTimeout(900);
const overviewShot = `${out}/overview-glass.png`;
await page.screenshot({ path: overviewShot });
console.log("OVERVIEW:", fmt(await inspectShellGlass()));

// 4) 暗访：把全屏里**没磨砂或 backdrop-filter=none 的元素**列出来，找出
//    「看上去不透明、挡住壁纸」的怪地方。
const opaqueProbes = async (label) => {
  const report = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("body *"));
    const findings = [];
    for (const el of all) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      // 跳过不可见
      if (r.width < 4 || r.height < 4) continue;
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      // 不是团队态或痕量元素也跳过
      const tag = el.tagName.toLowerCase();
      if (["script", "style", "svg", "path"].includes(tag)) continue;
      const hasBackdrop =
        (cs.backdropFilter && cs.backdropFilter !== "none") ||
        (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== "none");
      // 取出 rgb()/rgba()/oklab() 形式的实色 alpha
      const bg = cs.backgroundColor;
      // 透明或非 rgb/oklab 直接跳过
      let alpha = 1;
      const m = bg.match(/^rgba?\(([^)]+)\)$/);
      if (m) {
        alpha = parseFloat(m[1].split(",")[3] ?? "1");
      } else if (bg.startsWith("oklab(") || bg.startsWith("oklch(")) {
        // color-mix(...alpha 0)/... 走 oklab；粗略检「是否含 transparent」
        if (bg.includes("0%") || bg.includes("/ 0")) alpha = 0;
        else alpha = 0.5; // 假设半透
      }
      if (alpha < 0.05) continue;
      if (hasBackdrop && alpha < 0.85) continue; // 半透 + 有磨砂 → 玻璃 OK
      // 只看"高 alpha 且无磨砂"的实底怪块
      if (alpha < 0.6) continue;
      const id = (el.id ? `#${el.id}` : "");
      const cls = el.className && typeof el.className === "string"
        ? "." + el.className.trim().split(/\s+/).slice(0, 4).join(".")
        : "";
      findings.push({
        sel: `${tag}${id}${cls}`,
        bg,
        filter: cs.backdropFilter || cs.webkitBackdropFilter || "(none)",
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    // 同选择器聚合、按尺寸排，取前 20 个最大怪块
    const map = new Map();
    for (const f of findings) {
      const k = f.sel;
      const v = map.get(k);
      if (!v || f.w * f.h > v.w * v.h) map.set(k, f);
    }
    return [...map.values()]
      .sort((a, b) => b.w * b.h - a.w * a.h)
      .slice(0, 18);
  });
  console.log(`OPAQUE-${label}:`, JSON.stringify(report, null, 2));
};

await opaqueProbes("OVERVIEW");

await context.close();
await browser.close();
await stopTestServer(child, { token }).catch((err) => {
  console.log("STOP-SERVER-WARN:", err.message);
});
// 清理临时 dataRoot：沙箱里 fs.rm 走的安全删除 shim 偶发失败，失败不掩盖结论。
await rm(dataRoot, { recursive: true, force: true }).catch((err) => {
  console.log("CLEANUP-WARN:", err.message, "\n  残留目录可手工删除:", dataRoot);
});
console.log("DONE; screenshots in", out);
