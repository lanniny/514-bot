/**
 * 配置系统 UI 走查（npm run qa:walkthrough）
 *
 * 起独立测试实例（临时 dataRoot + 随机端口，绝不碰正在运行的桌面实例），逐面截图并收集
 * console/pageerror 与横向溢出。定位是「看得见的体检」：布局回归和空白控件不会让单测变红，
 * 只有人眼或这类走查能发现。有诊断即 exit 1，可直接挂进检查链。
 */
import { chromium } from "playwright";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";

const token = "walkthrough-514cc";
const dataRoot = await mkdtemp(join(tmpdir(), "514cc-walk-"));
const runId = process.env.WALKTHROUGH_RUN_ID || String(process.pid);
const shots = resolve(import.meta.dirname, "..", ".qa-output", "config-walkthrough", runId);
await mkdir(shots, { recursive: true });

const child = spawnTestServer({
  env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
});
const entryUrl = await waitForUrl(child);
const origin = new URL(entryUrl).origin;
console.log(`服务 ${origin}`);

const diagnostics = [];
let failed = false;
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => diagnostics.push({ kind: "pageerror", text: error.message }));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // D-2026-09-28-033：壁纸对账的 HEAD 探测在无自定义壁纸时 404，是设计内预期响应
    // （D-019 已定性，qa-bot-p0 / qa-bot-collab-dialog 均已豁免，本条漏了）。
    // location.url 指向 /api/wallpapers/global 即为此类，不计入诊断。
    if (message.location()?.url?.includes("/api/wallpapers/global")) return;
    // D-2026-09-28-033：原采集只留 message.text()——"Failed to load resource: 404" 这种
    // 文案不带 URL，等于抓到了症状却查不出病因。补上 location.url（发起该日志的脚本/资源）。
    const location = message.location();
    const path = location?.url ? new URL(location.url).pathname : "";
    diagnostics.push({ kind: "console", text: message.text().slice(0, 200), source: path });
  });
  // D-2026-09-28-033：404 的 URL 属于**响应**，console 事件的 location 指向控制台上的脚本
  // 而非失败资源本身。再挂一个 response 收集器，把 ≥400 的响应 URL 一并带走。
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const path = new URL(response.url()).pathname;
    if (path === "/api/wallpapers/global") return; // 壁纸对账 HEAD 探测，无自定义壁纸时 404 是设计内
    // D-2026-09-28-033：text 用「<status> <statusText>」格式，与 console 侧同构，让 :120 的
    // 既存过滤器 `/501 \(Not Implemented\)/` 能照常豁免远程门闸的 501；path/method 另存字段，
    // 供 404/5xx 这类**非预期**状态定位病因（此前只留 console 文案，查不出是哪个 URL）。
    diagnostics.push({
      kind: "response",
      text: `${response.status()} (${response.statusText()})`,
      method: response.request().method(),
      path,
      status: response.status(),
    });
  });

  await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const overflow = async (label) => {
    const value = await page.evaluate(() => ({
      body: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
      main: (() => {
        const main = document.querySelector("main") ?? document.body;
        return Math.max(0, main.scrollWidth - main.clientWidth);
      })(),
    }));
    if (value.body > 0 || value.main > 0) diagnostics.push({ kind: "overflow", text: `${label}: ${JSON.stringify(value)}` });
    return value;
  };

  const shoot = async (name, label) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false, animations: "disabled" });
    const value = await overflow(label);
    console.log(`  ${name.padEnd(30)} overflow=${JSON.stringify(value)}`);
  };

  console.log("\n=== 桌面 1440×1000 ===");
  await shoot("01-overview", "概览");

  await page.evaluate(() => { location.hash = "#config/providers"; });
  await page.waitForTimeout(1800);
  await shoot("02-config-providers", "连接档案");

  await page.evaluate(() => { location.hash = "#config/capabilities"; });
  await page.waitForTimeout(1500);
  await shoot("03-config-capabilities", "配置图谱·能力");

  await page.evaluate(() => { location.hash = "#config/sources"; });
  await page.waitForTimeout(1500);
  await shoot("04-config-seats", "配置图谱·运行席位");

  await page.locator('[data-runtime-workspace-mode="sources"]').click().catch(() => {});
  await page.waitForTimeout(1200);
  await shoot("05-config-raw-sources", "配置图谱·高级真源");

  await page.evaluate(() => { location.hash = "#team"; });
  await page.waitForTimeout(1800);
  await shoot("06-team", "团队协作");

  await page.evaluate(() => { location.hash = "#router"; });
  await page.waitForTimeout(1200);
  await page.locator("#team-router-workbench").scrollIntoViewIfNeeded().catch(() => {});
  await shoot("07-router", "模型路由");

  await page.evaluate(() => { location.hash = "#hosts"; });
  await page.waitForTimeout(1200);
  await shoot("08-hosts", "主机");

  console.log("\n=== 移动 390×844 ===");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { location.hash = "#config/providers"; });
  await page.waitForTimeout(1500);
  await shoot("09-config-providers-390", "移动·连接档案");
  await page.evaluate(() => { location.hash = "#config/sources"; });
  await page.waitForTimeout(1500);
  await shoot("10-config-sources-390", "移动·真源");

  console.log("\n=== 诊断 ===");
  // 门闸未授权造成的 501 是本走查的预期状态（测试实例不预授权远程能力），不算问题
  const blocking = diagnostics.filter((item) => !/501 \(Not Implemented\)/.test(item.text));
  console.log(blocking.length ? JSON.stringify(blocking, null, 2) : "（无 pageerror / 布局溢出；501 为未授权远程能力的预期响应）");
  failed = blocking.length > 0;
  await context.close();
} finally {
  await browser.close();
  await stopTestServer(child, { token });
  await rm(dataRoot, { recursive: true, force: true });
  console.log(`\n截图目录 ${shots}`);
  if (failed) process.exitCode = 1;
}
