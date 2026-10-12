// 成员编辑器·运行席位自定义选择器探针：
//  ① 新建成员 → 触发器显示当前席位（品牌图标 + 席位名 + 副行）；
//  ② 点开面板 → 按 Adapter 品牌分组 + 组头计数 + 资格徽章；
//  ③ 搜索过滤（不触 dirty）→ 键盘 ArrowDown/Enter 选中 → 真源 select 换值且换绑链触发；
//  ④ 再开面板点选另一席位 → select.value 跟随；
//  ⑤ 明暗截图 + 控制台错误汇报。
// 注意：隔离仓内对 models.json 做一次性消毒（剥掉 swift-responder 的 providerId）——
// 仓内该引用指向 LO 本机数据目录里的 ProviderStore，仓外解析不到，真实仓暂不动。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";
import { buildIsolatedServerEnv, createIsolatedQaRepo } from "./qa-team-workspace.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const token = "seat-picker-probe";
const qaRoot = await mkdtemp(join(tmpdir(), "seat-picker-"));
let server;
let browser;
try {
  const repo = await createIsolatedQaRepo(qaRoot);
  const modelsPath = join(repo, "config", "control-center", "models.json");
  const models = JSON.parse(await readFile(modelsPath, "utf8"));
  for (const profile of models.profiles || []) delete profile.providerId;
  await writeFile(modelsPath, `${JSON.stringify(models, null, 2)}\n`, "utf8");

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
  await page.waitForTimeout(800);

  // ① 新建成员 → 选择器触发器就位
  await page.locator("#team-surface-members-tab").click();
  await page.locator("#member-new-button").click();
  await page.waitForSelector("#member-seat-picker-trigger .member-seat-picker-copy strong", { timeout: 10_000 });
  const triggerPeek = await page.evaluate(() => ({
    label: document.querySelector("#member-seat-picker-trigger .member-seat-picker-copy strong")?.textContent,
    sub: document.querySelector("#member-seat-picker-trigger .member-seat-picker-copy span")?.textContent,
    hasLogo: Boolean(document.querySelector("#member-seat-picker-trigger svg")),
    selectValue: document.getElementById("member-runtime-profile-select")?.value,
    selectHidden: document.getElementById("member-runtime-profile-select")?.hidden,
    panelHidden: document.getElementById("member-seat-picker-panel")?.hidden,
  }));
  console.log("TRIGGER-PEEK:", JSON.stringify(triggerPeek));

  // ② 打开面板 → 分组/徽章
  await page.locator("#member-seat-picker-trigger").click();
  await page.waitForSelector("#member-seat-picker-panel:not([hidden])", { timeout: 5_000 });
  const panelPeek = await page.evaluate(() => ({
    groups: [...document.querySelectorAll(".member-seat-picker-group")].map((g) => ({
      brand: g.dataset.groupBrand,
      header: g.querySelector(".member-seat-picker-group-header")?.textContent.trim().replace(/\s+/g, " "),
      options: g.querySelectorAll(".member-seat-picker-option").length,
    })),
    totalOptions: document.querySelectorAll(".member-seat-picker-option").length,
    selected: document.querySelector(".member-seat-picker-option.is-selected")?.dataset.seatId,
    badges: [...document.querySelectorAll(".member-seat-picker-badge")].map((b) => b.textContent.trim()),
    searchFocused: document.activeElement?.id,
  }));
  console.log("PANEL-PEEK:", JSON.stringify(panelPeek));
  await page.screenshot({ path: ".qa-output/seat-picker/panel-light.png" });

  // ③ 搜索过滤（不触 dirty）→ 键盘选中
  const statusBefore = await page.evaluate(() => document.getElementById("member-form-status")?.textContent);
  await page.locator("#member-seat-picker-search-input").fill("codex");
  await page.waitForTimeout(250);
  const filterPeek = await page.evaluate(() => ({
    visible: [...document.querySelectorAll(".member-seat-picker-option")].filter((r) => !r.hidden).map((r) => r.dataset.seatId),
    status: document.getElementById("member-form-status")?.textContent,
  }));
  console.log("FILTER-PEEK:", JSON.stringify(filterPeek), "STATUS-BEFORE:", statusBefore);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const keyboardPeek = await page.evaluate(() => ({
    selectValue: document.getElementById("member-runtime-profile-select")?.value,
    panelHidden: document.getElementById("member-seat-picker-panel")?.hidden,
    triggerLabel: document.querySelector("#member-seat-picker-trigger .member-seat-picker-copy strong")?.textContent,
    status: document.getElementById("member-form-status")?.textContent,
  }));
  console.log("KEYBOARD-PICK:", JSON.stringify(keyboardPeek));

  // ④ 再开面板 → 点选另一个席位
  await page.locator("#member-seat-picker-trigger").click();
  await page.waitForSelector("#member-seat-picker-panel:not([hidden])", { timeout: 5_000 });
  const altId = await page.evaluate((current) => {
    const row = [...document.querySelectorAll(".member-seat-picker-option:not(.is-disabled)")]
      .find((r) => r.dataset.seatId !== current);
    return row?.dataset.seatId || null;
  }, keyboardPeek.selectValue);
  if (altId) {
    await page.locator(`.member-seat-picker-option[data-seat-id="${altId}"]`).click();
    await page.waitForTimeout(400);
  }
  const clickPeek = await page.evaluate(() => ({
    picked: document.getElementById("member-runtime-profile-select")?.value,
    panelHidden: document.getElementById("member-seat-picker-panel")?.hidden,
    triggerLabel: document.querySelector("#member-seat-picker-trigger .member-seat-picker-copy strong")?.textContent,
    factsAdapter: [...document.querySelectorAll("#member-runtime-facts .member-runtime-fact")]
      .map((f) => `${f.querySelector("dt")?.textContent}=${f.querySelector("dd")?.textContent}`),
  }));
  console.log("CLICK-PICK:", JSON.stringify(clickPeek), "ALT-TARGET:", altId);

  // ⑤ 暗色截图（重开面板）
  await page.locator("#member-seat-picker-trigger").click();
  await page.waitForSelector("#member-seat-picker-panel:not([hidden])", { timeout: 5_000 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(400);
  await page.screenshot({ path: ".qa-output/seat-picker/panel-dark.png" });

  console.log("ERRORS:", errs.length);
  errs.slice(0, 6).forEach((e) => console.log(" -", e));
} finally {
  if (browser) await browser.close();
  if (server) await stopTestServer(server, { token }).catch(() => server.kill("SIGKILL"));
  await rm(qaRoot, { recursive: true, force: true });
}
