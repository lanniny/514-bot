// 团队配置便利层（预设 + 导入导出）隔离实例探针：
//  ① 预设下拉套用 → 表单成员/主脑/提示词就位；
//  ② 保存创建团队；
//  ③ 导出团队包（playwright download 事件捕获）；
//  ④ 导入同一包 → 重名避让「（导入）」、成员复用零新建；
//  明暗截图 + 控制台错误汇报（隔离实例 501 属 test-mode 已知噪音）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";
import { buildIsolatedServerEnv, createIsolatedQaRepo } from "./qa-team-workspace.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const token = "team-kit-probe";
const qaRoot = await mkdtemp(join(tmpdir(), "team-kit-"));
let server;
let browser;
try {
  await createIsolatedQaRepo(qaRoot);
  server = spawnTestServer({ env: buildIsolatedServerEnv({ qaRoot, token }) });
  const url = await waitForUrl(server);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  await page.addInitScript(() => { try { localStorage.setItem("514cc-product-tour-dismissed", "1"); } catch {} }); // 首跑导览对话框会挡视口点击（D-2026-09-28-018）
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("501")) errs.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errs.push(`PAGEERROR: ${String(e).slice(0, 200)}`));

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 20_000 });
  // bot 面顶栏导航被 !important 隐藏（bot 表面无 chrome 设计）——走 hash 导航，
// 不依赖被藏按钮的可见性（与 qa-bot-journey 同款）。
await page.evaluate(() => { location.hash = "#team"; });
await page.waitForFunction(() => document.querySelector("#view-team")?.classList?.contains("is-active") === true, null, { timeout: 15_000 });

  // 等席位目录真实到达再套预设：内置团队只读，checkbox 永远 disabled，
  // 只能以 state.bootstrap.teamCatalog 就位为准（bootstrap 启动期可能迟到数秒）
  await page.waitForFunction(async () => {
    const { state } = await import("./state.js");
    return Array.isArray(state.bootstrap?.teamCatalog) && state.bootstrap.teamCatalog.length > 0;
  }, { timeout: 25_000 });
  await page.waitForTimeout(1000); // reconcile 补渲染落停（extract → reconcile 同帧竞态窗口）

  const presetOptions = await page.locator("#team-preset-select option").allTextContents();
  console.log("PRESET-OPTIONS:", JSON.stringify(presetOptions));

  // ① 套用预设（目录加载竞态下允许重试，模拟真实用户重选）
  let applied = null;
  for (let attempt = 1; attempt <= 3 && !applied; attempt++) {
    await page.locator("#team-preset-select").selectOption("review-guild");
    applied = await page.waitForFunction(() =>
      document.getElementById("team-name-input")?.value === "评审团" ? true : false,
      { timeout: 15_000 }).then(() => true).catch(() => null);
    if (!applied) console.log("PRESET-RETRY:", attempt);
  }
  await page.waitForTimeout(400);
  applied = await page.evaluate(() => ({
    title: document.getElementById("team-form-title")?.textContent,
    name: document.getElementById("team-name-input")?.value,
    promptHead: document.getElementById("team-prompt-input")?.value?.slice(0, 20),
    checked: [...document.querySelectorAll("#team-members-list input[type=checkbox]:checked")].map((i) => i.value),
    coordinator: document.querySelector("#team-members-list input[name=team-coordinator]:checked")?.value,
    status: document.getElementById("team-form-status")?.textContent,
  }));
  console.log("PRESET-APPLIED:", JSON.stringify(applied));
  await page.screenshot({ path: ".qa-v4/team-kit-preset-light.png" });

  // ② 保存创建
  await page.locator("#team-save-button").click();
  await page.waitForFunction(() =>
    document.getElementById("team-form-title")?.textContent?.includes("评审团"), { timeout: 10_000 });
  const afterSave = await page.evaluate(() => ({
    title: document.getElementById("team-form-title")?.textContent,
    switcher: [...document.querySelectorAll("#team-switch-select option")].map((o) => o.textContent),
  }));
  console.log("AFTER-SAVE:", JSON.stringify(afterSave));

  // ③ 导出
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 10_000 }),
    page.locator("#team-export-button").click(),
  ]);
  const packPath = join(qaRoot, "pack.json");
  await download.saveAs(packPath);
  const pack = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(packPath, "utf8")));
  console.log("EXPORTED:", JSON.stringify({ name: pack.team?.name, members: pack.team?.members, custom: pack.members?.custom?.length, builtinRefs: pack.members?.builtinRefs?.length }));

  // ④ 导入同一包 → 重名避让 + 全部复用
  const apiPeek = await page.evaluate(async () => {
    const { request } = await import("./api.js");
    const payload = await request("/api/team-members").catch((e) => ({ __error: e.message }));
    return payload?.__error ?? { keys: Object.keys(payload || {}), members: payload?.members?.length ?? "ABSENT", builtin0: payload?.members?.[0]?.builtin };
  });
  console.log("API-PEEK:", JSON.stringify(apiPeek));
  await page.locator("#team-import-file").setInputFiles(packPath);
  await page.waitForFunction(() =>
    document.getElementById("team-form-title")?.textContent?.includes("导入"), { timeout: 15_000 }).catch(async () => {
    const toasts = await page.evaluate(() => [...document.querySelectorAll("#toast-region .toast")].map((el) => el.textContent).slice(0, 3));
    console.log("IMPORT-STALLED, toasts:", JSON.stringify(toasts));
    throw new Error("import did not complete");
  });
  const afterImport = await page.evaluate(() => ({
    title: document.getElementById("team-form-title")?.textContent,
    checked: [...document.querySelectorAll("#team-members-list input[type=checkbox]:checked")].map((i) => i.value),
    coordinator: document.querySelector("#team-members-list input[name=team-coordinator]:checked")?.value,
    switcher: [...document.querySelectorAll("#team-switch-select option")].map((o) => o.textContent),
  }));
  console.log("AFTER-IMPORT:", JSON.stringify(afterImport));
  await page.screenshot({ path: ".qa-v4/team-kit-imported-light.png" });

  // 坏包诚实报错
  const badPath = join(qaRoot, "bad.json");
  await import("node:fs/promises").then((fs) => fs.writeFile(badPath, "{\"hello\":1}"));
  await page.locator("#team-import-file").setInputFiles(badPath);
  await page.waitForTimeout(800);
  const badToast = await page.locator(".toast, [class*='toast']").last().textContent().catch(() => "(none)");
  console.log("BAD-PACK-TOAST:", badToast?.trim()?.slice(0, 80));

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(400);
  await page.screenshot({ path: ".qa-v4/team-kit-dark.png" });

  console.log("ERRORS:", errs.length);
  errs.slice(0, 6).forEach((e) => console.log(" -", e));
} finally {
  if (browser) await browser.close();
  if (server) await stopTestServer(server, { token }).catch(() => server.kill("SIGKILL"));
  await rm(qaRoot, { recursive: true, force: true });
}
