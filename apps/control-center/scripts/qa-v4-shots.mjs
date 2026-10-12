import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

// D-2026-09-28-033：原脚本从 process.argv[2] 取 URL 且不自启服务器——runner 裸 spawn 时
// argv[2] 为 undefined，page.goto(undefined) 直接抛 TypeError（硬崩，连 usage error 都没有），
// 于是永远红。改为与其余 ~50 个 QA 脚本同构：自起隔离测试实例（临时 dataRoot + 随机端口），
// 从"环境阻塞"变成真门禁成员。
const token = "v4-shots-514cc-token";
const dataRoot = await mkdtemp(join(tmpdir(), "514cc-v4shots-"));
const outDir = ".qa-v4";
await mkdir(outDir, { recursive: true });

const server = spawnTestServer({
  env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
});
const entryUrl = await waitForUrl(server);
const url = new URL(entryUrl).origin;
console.log(`服务 ${url}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1512, height: 945 } });
await page.addInitScript((value) => { try { sessionStorage.setItem("514cc-control-token", value); } catch {} }, token);
await page.addInitScript(() => { try { localStorage.setItem("514cc-product-tour-dismissed", "1"); } catch {} }); // 首跑导览对话框会挡视口点击（D-2026-09-28-018）

const consoleErrors = [];
// D-2026-09-28-033：隔离实例里 ssh/sftp/market/office/channels 等远程能力一律 501
// REMOTE_GATE_BLOCKED（未授权远程能力的预期响应，qa-config-walkthrough / qa-bot-p0 同语义），
// 浏览器会为每个 501 打一条 "Failed to load resource: 501 (Not Implemented)" console error。
// 原收集器把它们全算进 consoleErrors，于是 21 张截图全拍到了却仍 exit 1。
const EXPECTED_GATE_CONSOLE = "Failed to load resource: the server responded with a status of 501 (Not Implemented)";
page.on("console", (msg) => {
  if (msg.type() !== "error") return;
  const text = msg.text().slice(0, 300);
  if (text === EXPECTED_GATE_CONSOLE) return;
  // D-2026-09-28-019/033：壁纸对账的 HEAD 探测在无自定义壁纸时 404，设计内预期响应
  if (/Failed to load resource:.*404/.test(text) && msg.location()?.url?.includes("/api/wallpapers/global")) return;
  consoleErrors.push(text);
});
page.on("pageerror", (err) => consoleErrors.push(`PAGEERROR: ${String(err).slice(0, 300)}`));

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 20_000 });
await page.waitForTimeout(1800);

async function shot(name) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log("shot:", name);
}

async function goView(view) {
  // D-2026-09-28-033：原先点 .topbar-nav [data-view]，但 bot-shell.css:1295 在
  // html.is-bot-surface（默认工作面）下把 .topbar-nav 整条 display:none !important 了——
  // 点它必超时（T3 hash-nav 集群同根因）。改走 hash 路由：VIEW_TITLES 白名单内的视图
  // 都可直接由 hash 激活，且不依赖任何可能被隐藏的 chrome。
  await page.evaluate((target) => { location.hash = `#${target}`; }, view);
  await page.waitForFunction((target) => {
    const node = document.getElementById(`view-${target}`);
    return Boolean(node?.classList.contains("is-active")) || !node?.hidden;
  }, view, { timeout: 20_000 });
  await page.waitForTimeout(900);
}

// light theme tour
await shot("01-workbench-light");
await goView("team"); await shot("02-team-light");
await goView("channels"); await shot("03-channels-light");
await goView("office"); await shot("04-office-light");
await goView("terminal"); await shot("05-terminal-light");
await goView("market"); await shot("06-market-light");
await goView("hosts"); await shot("07-hosts-light");
await goView("overview"); await shot("08-overview-light");
await goView("observability"); await shot("09-observability-light");
await goView("config"); await shot("10-config-light");
await goView("bootstrapper"); await shot("11-bootstrapper-light");

// command palette
await page.keyboard.press("Control+k");
await page.waitForTimeout(600);
await page.keyboard.type("团队", { delay: 20 });
await page.waitForTimeout(700);
await shot("12-palette-light");
await page.keyboard.press("Escape");

// dark theme
await page.evaluate(() => { localStorage.setItem("514cc-control-theme", "dark"); });
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 20_000 });
await page.waitForTimeout(1500);
await shot("13-workbench-dark");
await goView("team"); await shot("14-team-dark");
await goView("channels"); await shot("15-channels-dark");
await goView("office"); await shot("16-office-dark");
await goView("terminal"); await shot("17-terminal-dark");
await goView("market"); await shot("18-market-dark");
await goView("hosts"); await shot("19-hosts-dark");
await goView("observability"); await shot("20-observability-dark");
await goView("overview"); await shot("21-overview-dark");

console.log("CONSOLE_ERRORS:", consoleErrors.length);
consoleErrors.slice(0, 12).forEach((e) => console.log(" -", e));
await browser.close();
// D-2026-09-28-033：自起的隔离实例要自己收尸，否则每次都漏一个 node 进程与端口占用
await stopTestServer(server).catch((error) => console.error("[qa-v4-shots] shutdown:", error.message));
if (consoleErrors.length) { console.error(`v4-shots: ${consoleErrors.length} 个 console/pageerror`); process.exit(1); }
