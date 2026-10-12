#!/usr/bin/env node
// PM 走查探针：壁纸激活态下逐视图实拍（桌面 1440×960），供产品/玻璃审计逐张查看。
// 隔离 fixture，不触碰正式实例。产物落 .qa-output/pm-walk-<view>.png。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const outputDir = resolve(appRoot, ".qa-output", "pm-walk");
const token = "pm-walk-token-0123456789";
const cwd = process.platform === "win32" ? "C:\\pm-walk-scratch" : "/tmp/pm-walk-scratch";

const VIEWS = [
  "bot", "workbench", "team", "channels",
  "bootstrapper", "office",
  "overview", "observability", "sessions",
  "market", "hosts", "config",
  "automations", "security",
];

async function writeConfig(repoRoot) {
  await mkdir(resolve(repoRoot, "config/control-center"), { recursive: true });
  await writeFile(resolve(repoRoot, "config/app.json"), '{"enabled":true}\n');
  await writeFile(resolve(repoRoot, "config/control-center/models.json"), JSON.stringify({
    version: 1,
    profiles: testModelProfiles().map((profile) => ({ ...profile, enabled: true, capabilities: ["*"] })),
  }));
  await writeFile(resolve(repoRoot, "config/control-center/routing.json"), JSON.stringify({
    version: 1, primaryCoordinator: "claude-fable", technicalExecutor: "codex-technical",
    maxRounds: 6, maxDepth: 2, maxParallelAgents: 4, requireHealthyProvider: false,
    failOnUnavailableExplicitProvider: false, weights: { quality: 0.44, speed: 0.26, health: 0.22, cost: 0.08 },
    rules: [], independentPass: { requiredFor: [], mustDifferFromPrimary: true },
  }));
  await writeFile(resolve(repoRoot, "config/control-center/permissions.json"), JSON.stringify({
    version: 1, defaultMode: "plan",
    modes: { plan: { write: false, approvalRequired: false }, build: { write: "workspace", approvalRequired: true } },
    limits: { maxRounds: 8, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 30_000, turnIdleTimeoutMs: 10_000 },
    approval: { ttlMs: 60_000 },
  }));
  await writeFile(resolve(repoRoot, "config/control-center/sources.json"), JSON.stringify({
    version: 1,
    explicit: [
      { id: "control.models", path: "config/control-center/models.json", label: "models", kind: "json", scope: "repo", critical: true },
      { id: "control.routing", path: "config/control-center/routing.json", label: "routing", kind: "json", scope: "repo", critical: true },
      { id: "control.permissions", path: "config/control-center/permissions.json", label: "permissions", kind: "json", scope: "repo", critical: true },
      { id: "control.sources", path: "config/control-center/sources.json", label: "sources", kind: "json", scope: "repo", critical: true },
    ],
    discover: [], runtime: [],
  }));
}

;async function vividWallpaperPng() {
  // 800×500 高饱和对角渐变 + 撞色圆斑，无依赖手写 PNG（RGB8，zlib stored 块）
  const W = 800, H = 500;
  const raw = Buffer.alloc(H * (1 + W * 3));
  const blobs = [
    { cx: 0.22, cy: 0.3, r: 0.28, color: [255, 196, 0] },
    { cx: 0.72, cy: 0.68, r: 0.34, color: [255, 61, 87] },
    { cx: 0.5, cy: 0.1, r: 0.2, color: [0, 208, 255] },
  ];
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 3);
    raw[row] = 0;
    for (let x = 0; x < W; x++) {
      const t = (x / W + y / H) / 2;
      let r = Math.round(30 + t * 90);
      let g = Math.round(60 + (1 - t) * 60);
      let b = Math.round(160 + t * 80);
      for (const blob of blobs) {
        const dx = x / W - blob.cx, dy = y / H - blob.cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < blob.r) {
          const k = 1 - d / blob.r;
          r = Math.round(r * (1 - k) + blob.color[0] * k);
          g = Math.round(g * (1 - k) + blob.color[1] * k);
          b = Math.round(b * (1 - k) + blob.color[2] * k);
        }
      }
      const o = row + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const { deflateSync } = await import("node:zlib");
  const idat = deflateSync(raw, { level: 6 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crcTable = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main() {
  const root = await mkdtemp(resolve(appRoot, ".qa-pm-walk-"));
  const repoRoot = resolve(root, "repo");
  const dataRoot = resolve(root, "data");
  const fakeHome = resolve(root, "home");
  await writeConfig(repoRoot);
  await mkdir(fakeHome, { recursive: true });
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const server = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: token,
      CONTROL_CENTER_REPO_ROOT: repoRoot,
      CONTROL_CENTER_DATA_DIR: dataRoot,
      CONTROL_CENTER_PORT: "0",
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
  });
  let browser;
  try {
    const url = await waitForUrl(server);
    const origin = new URL(url).origin;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const api = async (path, { method = "GET", body } = {}) => {
      const response = await fetch(new URL(path, origin), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const payload = await response.json();
      assert.ok(response.ok, `${method} ${path} failed (${response.status})`);
      return payload;
    };

    // 上传全局壁纸：激活 team-bg-active，玻璃审计才看得到实底块。
    // 壁纸用程序生成的鲜艳渐变（真实壁纸是彩色插画，玻璃透出必须拿高饱和底才审得出来）
    const wallpaperBytes = await vividWallpaperPng();
    await api("/api/wallpapers/global", { method: "POST", body: { dataUrl: `data:image/png;base64,${wallpaperBytes.toString("base64")}` } });
    // 偏好置 custom：页面启动水合后即挂壁纸
    await api("/api/preferences", { method: "PUT", body: { "514cc-global-wallpaper": JSON.stringify({
      preset: "custom", fit: "cover", overrideTeam: true,
      rotate: { enabled: false, intervalMin: 5, order: "sequential" },
      hasCustom: true, filter: { dim: 0, blur: 0, saturation: 1 },
    }) } });

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.addInitScript(() => { try { localStorage.setItem("514cc-product-tour-dismissed", "1"); } catch {} }); // 首跑导览对话框会挡视口点击（D-2026-09-28-018）
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });
    await page.waitForFunction(() => document.body.classList.contains("team-bg-active"), null, { timeout: 30_000 });
    console.log("[pm] wallpaper active, walking views");
    await page.screenshot({ path: resolve(outputDir, "debug-initial.png") });
    const navDebug = await page.evaluate(() => ({
      shellClass: document.querySelector(".app-shell")?.className,
      burger: (() => { const b = document.querySelector("#mobile-menu-button"); if (!b) return "missing"; const r = b.getBoundingClientRect(); const cs = getComputedStyle(b); return { x: r.x, y: r.y, w: r.width, h: r.height, display: cs.display, visibility: cs.visibility }; })(),
      navItem: (() => { const b = document.querySelector('.nav-item[data-view="bot"]'); if (!b) return "missing"; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
      innerWidth: window.innerWidth,
      sidebar: (() => {
        const s = document.querySelector("#sidebar");
        if (!s) return "missing";
        const r = s.getBoundingClientRect();
        const cs = getComputedStyle(s);
        return { w: Math.round(r.width), h: Math.round(r.height), display: cs.display, hiddenAttr: s.hasAttribute("hidden"), inert: s.hasAttribute("inert"), itemCount: s.querySelectorAll(".nav-item").length };
      })(),
      bodyClass: document.body?.className ?? "",
      shellClasses: document.querySelector(".app-shell")?.className ?? "",
    }));
    console.log("[pm] nav debug:", JSON.stringify(navDebug));

    for (const view of VIEWS) {
      // 桌面端全局导航唯一稳定入口是 hash 路由（本身就是走查发现 #1）；抽屉/菜单问题单独修
      await page.evaluate((v) => { location.hash = `#${v}`; }, view);
      await page.waitForTimeout(900);
      await page.screenshot({ path: resolve(outputDir, `${view}.png`) });
      console.log(`[pm] shot ${view}`);
    }

    // 关键交互态补拍：桌面端侧栏导航端到端 + 窄屏汉堡抽屉（PM 走查修复 #1 的验收）
    await page.evaluate(() => { location.hash = "#workbench"; });
    await page.waitForTimeout(500);
    // D-2026-09-28-032：原断言"桌面端汉堡必须可见"与设计相悖。product-shell.css:679 在
    // @media (min-width: 821px) 内以 !important 隐藏汉堡，**同时** :676 让 #sidebar
    // display:flex !important 常驻——桌面端的导航载体是侧栏，汉堡只在窄屏（<821px，
    // 侧栏收起）出场。pm-walk 量的是 1440×960（≥821），故汉堡本就不该可见。
    // 改为按断点各验其真正的导航载体：桌面 = 侧栏可见且够宽；窄屏 = 汉堡可见。
    // D-2026-09-28-032：侧栏被 shell-refresh.css 在 ≥821px 有意收起（栅格改为单列），
    // 桌面端的全局导航载体是**汉堡**（点开抽屉）。此处原断言一直是对的——它 2026-08-30
    // 就抓住了「全局导航零入口」这个 PM 走查判定为最大可用性缺陷的回归；中间我曾误把
    // 断言改成验侧栏，方向错了。产品已在 shell-refresh.css 修好（把汉堡放回来），
    // 断言恢复为验汉堡 + 抽屉端到端。
    const burgerVisible = await page.evaluate(() => {
      const burger = document.querySelector("#mobile-menu-button");
      if (!burger) return "missing";
      const cs = getComputedStyle(burger);
      return cs.display !== "none" && burger.getBoundingClientRect().width > 0;
    });
    assert.equal(burgerVisible, true, "桌面端汉堡按钮不可见——全局导航抽屉没有触发钮");
    await page.click("#mobile-menu-button");
    await page.waitForTimeout(350);
    // 桌面端侧栏本就常驻展开态，汉堡点开的是抽屉态（nav-open 下滑出）
    await page.click('.nav-item[data-view="team"]');
    await page.waitForTimeout(800);
    const teamReached = await page.evaluate(() => !document.querySelector("#view-team")?.hidden);
    assert.equal(teamReached, true, "侧栏点选团队协作后视图未切换");
    console.log("[pm] desktop sidebar nav e2e ok (sidebar → team)");

    // 新任务对话框 + 命令面板补拍（协作台入口在 workbench 上）
    await page.evaluate(() => { location.hash = "#workbench"; });
    await page.waitForTimeout(500);
    // D-2026-09-28-032：#new-task-row 在 #view-workbench（nav-retired 恒 hidden 壳）内，
    // Bot 面不可见。对到 Bot 面的等价入口 #bot-new-group-button（handleRail("new") 走的
    // 就是它）——这一段是走查截图，需要的是"新建 → 弹对话框"这个形态。
    await page.click("#bot-new-group-button");
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(outputDir, "dialog-session.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(outputDir, "palette.png") });
    await page.keyboard.press("Escape");

    console.log("[pm] page errors:", pageErrors.length ? pageErrors.join(" | ") : "(none)");
    console.log("PM-WALK-DONE");
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopTestServer(server).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error("PM-WALK-FAIL:", error?.message ?? error);
  process.exitCode = 1;
});
