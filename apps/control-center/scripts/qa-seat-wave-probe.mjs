// 席位配置面完善波隔离实例探针：
//  ① 新建席位 → Adapter 下拉无 Grok Search MCP（MCP 不混入 CLI 后端）+ 职责空默认 + datalist 建议；
//  ② 系统席位 → 绑定成员区块 chip + 品牌徽标 + 边界注记（CodeBuddy/Cursor 未进体系）；
//  ③ 新建自定义席位保存 → 绑定空态 + 删除钮 title 前置说明；
//  明暗截图 + 控制台错误汇报（隔离实例 501 属 test-mode 已知噪音）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";
import { buildIsolatedServerEnv, createIsolatedQaRepo } from "./qa-team-workspace.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const token = "seat-wave-probe";
const qaRoot = await mkdtemp(join(tmpdir(), "seat-wave-"));
let server;
let browser;
try {
  await createIsolatedQaRepo(qaRoot);
  server = spawnTestServer({ env: buildIsolatedServerEnv({ qaRoot, token }) });
  const url = await waitForUrl(server);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("501")) errs.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errs.push(`PAGEERROR: ${String(e).slice(0, 200)}`));

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 20_000 });
  await page.locator('.topbar-nav [data-view="config"]').click();
  await page.locator("#config-topology-sources").click();
  await page.waitForSelector("#runtime-seat-list .runtime-seat-item", { timeout: 20_000 });
  await page.waitForTimeout(600);

  // 品牌徽标检查
  const listPeek = await page.evaluate(() => [...document.querySelectorAll("#runtime-seat-list .runtime-seat-item")].map((row) => ({
    id: row.dataset.runtimeSeatId,
    brand: row.dataset.brand,
    hasBrandLogo: Boolean(row.querySelector("svg.runtime-seat-logo")),
  })));
  console.log("SEAT-LIST:", JSON.stringify(listPeek));

  // ① 新建席位 → 模板下拉 + 职责默认
  await page.locator("#runtime-seat-new-button").click();
  await page.waitForFunction(() =>
    document.getElementById("runtime-seat-form-title")?.textContent === "新建运行席位", null, { timeout: 10_000 });
  const newPeek = await page.evaluate(() => ({
    adapterOptions: [...document.querySelectorAll("#runtime-seat-adapter-select option")].map((o) => o.value),
    roleValue: document.getElementById("runtime-seat-role-input")?.value,
    rolePlaceholder: document.getElementById("runtime-seat-role-input")?.placeholder,
    roleSuggestions: [...document.querySelectorAll("#runtime-seat-role-options option")].map((o) => o.value),
    bindingsEmpty: document.querySelector("#runtime-seat-bindings-list .runtime-seat-bindings-empty")?.textContent,
    boundaryNote: document.querySelector(".runtime-seat-integration-boundary")?.textContent?.trim().slice(0, 160),
  }));
  console.log("NEW-SEAT-PEEK:", JSON.stringify(newPeek));
  await page.screenshot({ path: ".qa-v4/seat-wave-new-light.png" });

  // ② System seat bindings remain visible; MCP tools never appear as seats.
  await page.locator('.runtime-seat-item[data-runtime-seat-id="codex-technical"]').click();
  await page.waitForFunction(() =>
    document.getElementById("runtime-seat-id-input")?.value === "codex-technical", null, { timeout: 10_000 });
  // bootstrap 是慢聚合——绑定区块由 refreshBindings 自愈；等 chip 出现再读，避免读到未刷新的旧空态
  await page.waitForSelector("#runtime-seat-bindings-list .runtime-seat-binding-chip", { timeout: 15_000 }).catch(() => null);
  const builtinPeek = await page.evaluate(() => ({
    bindings: [...document.querySelectorAll("#runtime-seat-bindings-list .runtime-seat-binding-chip")].map((c) => c.textContent.trim()),
    adapterValue: document.getElementById("runtime-seat-adapter-select")?.value,
  }));
  console.log("BUILTIN-PEEK:", JSON.stringify(builtinPeek));

  if (await page.locator('.runtime-seat-item[data-runtime-seat-id="grok-search"]').count()) throw new Error("retired MCP seat is still visible");

  // ③ 新建自定义席位 → 保存 → 绑定空态 + 删除 title
  await page.locator("#runtime-seat-new-button").click();
  await page.waitForFunction(() =>
    document.getElementById("runtime-seat-form-title")?.textContent === "新建运行席位", null, { timeout: 10_000 });
  await page.locator("#runtime-seat-id-input").fill("probe-seat");
  await page.locator("#runtime-seat-label-input").fill("探针席位");
  await page.locator("#runtime-seat-role-input").fill("probe-executor");
  await page.locator("#runtime-seat-form button[type='submit'], #runtime-seat-save-button").first().click();
  await page.waitForFunction(() =>
    document.getElementById("runtime-seat-form-title")?.textContent?.includes("探针席位"), null, { timeout: 15_000 }).catch(async () => {
    const status = await page.evaluate(() => document.getElementById("runtime-seat-form-status")?.textContent);
    console.log("SAVE-STALLED, status:", status);
    throw new Error("seat save did not complete");
  });
  const savedPeek = await page.evaluate(() => ({
    bindingsEmpty: document.querySelector("#runtime-seat-bindings-list .runtime-seat-bindings-empty")?.textContent,
    deleteTitle: document.getElementById("runtime-seat-delete-button")?.getAttribute("title"),
    status: document.getElementById("runtime-seat-form-status")?.textContent,
  }));
  console.log("SAVED-SEAT-PEEK:", JSON.stringify(savedPeek));
  await page.screenshot({ path: ".qa-v4/seat-wave-saved-light.png" });

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(400);
  await page.screenshot({ path: ".qa-v4/seat-wave-dark.png" });

  console.log("ERRORS:", errs.length);
  errs.slice(0, 6).forEach((e) => console.log(" -", e));
} finally {
  if (browser) await browser.close();
  if (server) await stopTestServer(server, { token }).catch(() => server.kill("SIGKILL"));
  await rm(qaRoot, { recursive: true, force: true });
}
