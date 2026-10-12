// 成员选择区分组/搜索/新建成员波隔离实例探针：
//  ① 新建团队 → 成员按品牌分组渲染（组头计数）；
//  ② 勾选后折叠组 → 行 hidden 但 checkbox 留在 DOM 且保持 checked（保存不丢）；
//  ③ 搜索过滤 → 只显匹配行，已选 hidden 行计数仍在 roster summary；
//  ④ 「新建成员」→ 成员库空白草稿 → 保存 → 自动勾入团队草稿；
//  明暗截图 + 控制台错误汇报（隔离实例 501 属 test-mode 已知噪音）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";
import { buildIsolatedServerEnv, createIsolatedQaRepo } from "./qa-team-workspace.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const token = "member-groups-probe";
const qaRoot = await mkdtemp(join(tmpdir(), "member-groups-"));
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

  await page.waitForFunction(async () => {
    const { state } = await import("./state.js");
    return Array.isArray(state.bootstrap?.teamCatalog) && state.bootstrap.teamCatalog.length > 0;
  }, { timeout: 25_000 });
  await page.waitForTimeout(1000);

  // ① 新建团队 → 分组渲染
  await page.locator("#team-new-button").click();
  await page.waitForFunction(() =>
    document.getElementById("team-form-title")?.textContent === "新建团队", { timeout: 10_000 });
  await page.waitForSelector(".tm-group", { timeout: 10_000 });
  const groupPeek = await page.evaluate(() => [...document.querySelectorAll(".tm-group")].map((g) => ({
    brand: g.dataset.groupBrand,
    header: g.querySelector(".tm-group-header strong")?.textContent,
    count: g.querySelector(".tm-group-count")?.textContent,
    rows: g.querySelectorAll(".team-member-option").length,
    expanded: g.querySelector(".tm-group-header")?.getAttribute("aria-expanded"),
  })));
  console.log("GROUPS:", JSON.stringify(groupPeek));

  // ② 勾选 codex-technical + kimi-frontend → 折叠 codex 组
  await page.locator('.team-member-option input[type="checkbox"][value="codex-technical"]').check();
  await page.locator('.team-member-option input[type="checkbox"][value="kimi-frontend"]').check();
  await page.locator('.tm-group[data-group-brand="codex"] .tm-group-header').click();
  await page.waitForTimeout(300);
  const collapsePeek = await page.evaluate(() => {
    const codexRow = document.querySelector('.team-member-option:has(input[value="codex-technical"])');
    const codexInput = document.querySelector('input[type="checkbox"][value="codex-technical"]');
    return {
      codexRowHidden: codexRow?.hidden,
      codexBodyHidden: document.querySelector('.tm-group[data-group-brand="codex"] .tm-group-body')?.hidden,
      codexStillChecked: codexInput?.checked, // hidden 但留在 DOM 且保持勾选
      codexExpanded: document.querySelector('.tm-group[data-group-brand="codex"] .tm-group-header')?.getAttribute("aria-expanded"),
      rosterSummary: document.getElementById("team-roster-summary")?.textContent,
      codexGroupCount: document.querySelector('.tm-group[data-group-brand="codex"] .tm-group-count')?.textContent,
    };
  });
  console.log("COLLAPSE-PEEK:", JSON.stringify(collapsePeek));
  await page.screenshot({ path: ".qa-v4/member-groups-collapsed-light.png" });

  // ③ 搜索 kimi → 只有 kimi 行可见；codex 已选 hidden 行仍计入 summary
  await page.locator("#team-members-search").fill("kimi");
  await page.waitForTimeout(300);
  const searchPeek = await page.evaluate(() => ({
    visibleRows: [...document.querySelectorAll(".team-member-option")].filter((r) => !r.hidden)
      .map((r) => r.querySelector('input[type="checkbox"]')?.value),
    visibleGroups: [...document.querySelectorAll(".tm-group")].filter((g) => !g.hidden).map((g) => g.dataset.groupBrand),
    codexCheckedWhileHidden: document.querySelector('input[type="checkbox"][value="codex-technical"]')?.checked,
    rosterSummary: document.getElementById("team-roster-summary")?.textContent,
    formDirty: document.getElementById("team-form-status")?.textContent,
  }));
  console.log("SEARCH-PEEK:", JSON.stringify(searchPeek));
  await page.screenshot({ path: ".qa-v4/member-groups-search-light.png" });
  // 无匹配空态
  await page.locator("#team-members-search").fill("zzz-no-match");
  await page.waitForTimeout(200);
  const emptyVisible = await page.evaluate(() => !document.querySelector(".tm-filter-empty")?.hidden);
  console.log("EMPTY-STATE-VISIBLE:", emptyVisible);
  await page.locator("#team-members-search").fill("");
  await page.waitForTimeout(200);

  // ④ 新建成员 → 成员库草稿 → 保存 → 自动勾入
  await page.locator("#team-member-create-button").click();
  await page.waitForFunction(() =>
    document.getElementById("member-form-title")?.textContent === "新建自定义成员", { timeout: 10_000 });
  const surfacePeek = await page.evaluate(() => ({
    membersVisible: document.getElementById("team-surface-members")?.hidden === false,
    title: document.getElementById("member-form-title")?.textContent,
  }));
  console.log("CREATE-SURFACE:", JSON.stringify(surfacePeek));
  await page.locator("#member-label-input").fill("探针测试员");
  await page.locator("#member-role-input").fill("qa-probe-seat");
  await page.locator("#member-save-button").click();
  await page.waitForFunction(() =>
    document.getElementById("member-form-title")?.textContent?.includes("探针测试员"), { timeout: 15_000 });
  console.log("MEMBER-SAVED: 探针测试员");

  // 回编排面验证自动勾选
  await page.locator("#team-surface-orchestration-tab").click();
  await page.waitForTimeout(500);
  const autoCheckPeek = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".team-member-option")];
    const newRow = rows.find((r) => r.querySelector(".tm-meta strong")?.textContent === "探针测试员");
    const input = newRow?.querySelector('input[type="checkbox"]');
    return {
      rowExists: Boolean(newRow),
      autoChecked: input?.checked,
      rosterSummary: document.getElementById("team-roster-summary")?.textContent,
      formStatus: document.getElementById("team-form-status")?.textContent,
      groupOf: newRow?.closest(".tm-group")?.dataset.groupBrand,
    };
  });
  console.log("AUTO-CHECK-PEEK:", JSON.stringify(autoCheckPeek));
  await page.screenshot({ path: ".qa-v4/member-groups-autocheck-light.png" });

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(400);
  await page.screenshot({ path: ".qa-v4/member-groups-dark.png" });

  console.log("ERRORS:", errs.length);
  errs.slice(0, 6).forEach((e) => console.log(" -", e));
} finally {
  if (browser) await browser.close();
  if (server) await stopTestServer(server, { token }).catch(() => server.kill("SIGKILL"));
  await rm(qaRoot, { recursive: true, force: true });
}
