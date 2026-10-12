// 桌面端启动凭据通路验收：`#bootstrap=<nonce>`（片段）与 `?bootstrap=<nonce>`（查询串）两种形态
// 是否都能让页面拿到 token 并成功调用需要鉴权的 API。
//
// 为什么需要它：桌面端外壳用 `WebviewUrl::External(url)` 导航，凭据放在 URL 片段里，
// 而 main.rs 自己写着「WebView2 may drop fragments」。片段一旦被丢，页面就没有可兑换的凭据，
// 端口每次重启都变又导致 sessionStorage（按 origin 隔离）里没有旧 token，
// 结果就是整页 401 UNAUTHORIZED —— 用户看到「运行与配置工作台加载失败：会话凭据已失效」等提示。
//
// 本脚本用真内核 + 真浏览器把这条通路跑通跑死，不依赖人肉观察。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const output = await mkdtemp(resolve(appRoot, ".qa-output/desktop-bootstrap-"));
const root = await mkdtemp(resolve(tmpdir(), "514cc-bootstrap-"));
const repoRoot = resolve(root, "repo");
const runtimeRoot = resolve(root, "runtime");
await mkdir(resolve(repoRoot, "config/control-center"), { recursive: true });
await mkdir(runtimeRoot, { recursive: true });
const saveConfig = (name, value) => writeFile(resolve(repoRoot, `config/control-center/${name}.json`), JSON.stringify(value));
await saveConfig("models", { version: 1, profiles: testModelProfiles().map((profile, index) => ({ ...profile, command: `missing-bootstrap-qa-${index}` })) });
await saveConfig("routing", { version: 1, primaryCoordinator: "claude-fable", technicalExecutor: "codex-technical", maxRounds: 6, maxDepth: 2, maxParallelAgents: 4, requireHealthyProvider: false, failOnUnavailableExplicitProvider: false, weights: { quality: .44, speed: .26, health: .22, cost: .08 }, rules: [], independentPass: { requiredFor: [], mustDifferFromPrimary: true } });
await saveConfig("permissions", { version: 1, defaultMode: "plan", modes: { plan: { write: false, approvalRequired: false }, build: { write: "workspace", approvalRequired: true } }, limits: { maxRounds: 6, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 10000 }, approval: { ttlMs: 60000 } });
await saveConfig("sources", { version: 1, explicit: ["models", "routing", "permissions", "sources"].map((name) => ({ id: `control.${name}`, path: `config/control-center/${name}.json`, label: name, kind: "json", scope: "repo", critical: true })), discover: [], runtime: [] });

const started = [];
async function startKernel(label) {
  const dataRoot = resolve(root, `data-${label}`);
  await mkdir(dataRoot, { recursive: true });
  const child = spawnTestServer({ env: {
    CONTROL_CENTER_TOKEN: `bootstrap-qa-token-${label}`,
    CONTROL_CENTER_PORT: "0",
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_REPO_ROOT: repoRoot,
    CONTROL_CENTER_TEST_REPO_ROOT: repoRoot,
    CONTROL_CENTER_RUNTIME_HOME: runtimeRoot,
  } });
  started.push(child);
  const url = await waitForUrl(child);
  return { child, url };
}

/** 打开一个页面并如实回报它到底拿到了什么。 */
async function inspect(browser, target, { preStoreToken = "" } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  if (preStoreToken) {
    await page.addInitScript((value) => sessionStorage.setItem("514cc-control-token", value), preStoreToken);
  }
  await page.goto(target, { waitUntil: "domcontentloaded" });
  // 等到页面自己给出"连接可用"的信号，或超时——两者都是有效结果
  let badgeOk = true;
  try {
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok"), null, { timeout: 12000 });
  } catch {
    badgeOk = false;
  }
  const observed = await page.evaluate(async () => {
    const stored = sessionStorage.getItem("514cc-control-token") || "";
    let teamsStatus = 0;
    try {
      const response = await fetch("/api/teams", { headers: stored ? { Authorization: `Bearer ${stored}` } : {} });
      teamsStatus = response.status;
    } catch {
      teamsStatus = -1;
    }
    return { href: location.href, hasToken: Boolean(stored), teamsStatus };
  });
  await context.close();
  return { ...observed, badgeOk, pageErrors };
}

let browser;
const report = { ok: false, checks: [], errors: [] };
try {
  browser = await chromium.launch({ headless: true });

  // === A. 内核实际打印的形态（修复后是查询串）===
  const kernelA = await startKernel("query");
  assert.match(kernelA.url, /\?bootstrap=/, `内核应打印查询串形态的凭据，实际 ${kernelA.url}`);
  const resultA = await inspect(browser, kernelA.url);
  report.queryForm = resultA;
  report.checks.push(`A 查询串（内核实际形态）：token=${resultA.hasToken} /api/teams=${resultA.teamsStatus} badge-ok=${resultA.badgeOk}`);
  assert.equal(resultA.hasToken, true, "查询串形态必须能换到 token");
  assert.equal(resultA.teamsStatus, 200, "查询串形态必须能通过鉴权调用 /api/teams");
  assert.equal(resultA.badgeOk, true, "查询串形态页面必须自报连接可用");
  assert.doesNotMatch(resultA.href, /bootstrap=/, "兑换后凭据必须从 URL 上摘掉（留着会让刷新拿已消费的 nonce 再换一次）");

  // === B. 旧片段形态：hash 路由会把它顶掉，靠模块加载期快照兜住 ===
  const kernelB = await startKernel("fragment");
  const nonceB = new URL(kernelB.url).searchParams.get("bootstrap");
  const fragmentUrl = `${new URL(kernelB.url).origin}/#bootstrap=${nonceB}`;
  const resultB = await inspect(browser, fragmentUrl);
  report.fragmentForm = resultB;
  report.checks.push(`B 片段形态（旧外壳/其它启动器）：token=${resultB.hasToken} /api/teams=${resultB.teamsStatus} badge-ok=${resultB.badgeOk}`);
  assert.equal(resultB.hasToken, true, "片段形态必须靠早期快照拿到 token——这是 2026-09-18 那次整页 401 的正解");
  assert.equal(resultB.teamsStatus, 200, "片段形态必须能通过鉴权调用 /api/teams");
  assert.doesNotMatch(resultB.href, /bootstrap=/, "片段被路由顶掉后也不得把凭据留在 URL 上");

  // === C. 兑换后刷新：token 在 sessionStorage 里，必须仍然可用 ===
  // 注意必须用**新内核的新 nonce**：B 用的那个已经被消费，拿它测刷新测的是"兑换失败"而不是刷新。
  const kernelC = await startKernel("reload");
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(kernelC.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => sessionStorage.getItem("514cc-control-token"), null, { timeout: 12000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  const afterReload = await page.evaluate(async () => {
    const stored = sessionStorage.getItem("514cc-control-token") || "";
    const response = await fetch("/api/teams", { headers: stored ? { Authorization: `Bearer ${stored}` } : {} });
    return { hasToken: Boolean(stored), teamsStatus: response.status, href: location.href };
  });
  await context.close();
  report.afterReload = afterReload;
  report.checks.push(`C 兑换后刷新：token=${afterReload.hasToken} /api/teams=${afterReload.teamsStatus}`);
  assert.equal(afterReload.teamsStatus, 200, "同 origin 刷新必须仍然可用（sessionStorage 路径）");

  // === D. 已消费的 nonce 再被兑换一次：不得毁掉本来可用的会话 ===
  const staleRetry = await inspect(browser, fragmentUrl, { preStoreToken: "definitely-not-the-kernel-token" });
  report.staleNonceWithStoredToken = staleRetry;
  report.checks.push(`D 已消费 nonce + 有存量 token：pageerror=${staleRetry.pageErrors.length}（不得抛「兑换失败」）`);
  assert.equal(staleRetry.pageErrors.length, 0, "已消费的 nonce 不该把页面炸掉——有存量 token 就继续用");

  // === E. 驻留心跳：Bot 面渲染后必须留下 lastHeartbeat ===
  // 这是 A5「上次没正常退出」恢复提示的**前提**：SessionResidenceStore.init 只在
  // lastHeartbeat 存在时才会去探测异常中断。心跳写不出来，整条恢复提示就静默失效。
  const kernelE = await startKernel("heartbeat");
  const contextE = await browser.newContext();
  const pageE = await contextE.newPage();
  await pageE.goto(kernelE.url, { waitUntil: "domcontentloaded" });
  const residencePath = resolve(root, "data-heartbeat", "session-residence.json");
  let heartbeat = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await new Promise((resume) => setTimeout(resume, 1000));
    try {
      const parsed = JSON.parse(await readFile(residencePath, "utf8"));
      if (parsed?.lastHeartbeat) {
        heartbeat = parsed.lastHeartbeat;
        break;
      }
    } catch {
      // 文件还没落盘
    }
  }
  await contextE.close();
  report.heartbeat = heartbeat;
  report.checks.push(`E 驻留心跳：lastHeartbeat=${heartbeat ?? "（未出现）"}`);
  assert.ok(heartbeat, "Bot 面渲染后必须留下 lastHeartbeat —— 否则恢复提示永远不触发");

  report.ok = true;
} catch (error) {
  report.errors.push(`fatal: ${error?.message || String(error)}`);
} finally {
  await browser?.close().catch(() => {});
  for (const child of started) await stopTestServer(child).catch(() => {});
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2), "utf8");
console.log(`报告：${resolve(output, "report.json")}`);
for (const line of report.checks) console.log("  · " + line);
console.log("A 查询串实测:", JSON.stringify(report.queryForm));
console.log("B 片段实测:", JSON.stringify(report.fragmentForm));
console.log("C 刷新后实测:", JSON.stringify(report.afterReload));
if (report.errors.length) {
  for (const line of report.errors) console.error("  ✖ " + line);
  process.exit(1);
}
console.log("凭据通路全部通过");
