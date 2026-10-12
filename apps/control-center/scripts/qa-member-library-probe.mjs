// 成员配置页面完善波隔离实例探针：
//  ① 预设建团「评审团」（codex-technical 主脑 + claude-fable + kimi-frontend）；
//  ② 成员库列表：品牌 logo / 主脑可任徽章 / 团队 n 徽章；
//  ③ 编辑器使用情况区块：chip 文案 + 删除钮 title 引用说明；
//  ④ chip 点击跳回团队编排面；
//  ⑤ 简介字数统计实时更新；
//  明暗截图 + 控制台错误汇报（隔离实例 501 属 test-mode 已知噪音）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";
import { buildIsolatedServerEnv, createIsolatedQaRepo } from "./qa-team-workspace.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const token = "member-lib-probe";
const qaRoot = await mkdtemp(join(tmpdir(), "member-lib-"));
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

  // bootstrap 启动期可能迟到数秒，以席位目录真实到达为准
  await page.waitForFunction(async () => {
    const { state } = await import("./state.js");
    return Array.isArray(state.bootstrap?.teamCatalog) && state.bootstrap.teamCatalog.length > 0;
  }, { timeout: 25_000 });
  await page.waitForTimeout(1000); // reconcile 落停

  // ① 预设建团
  let applied = null;
  for (let attempt = 1; attempt <= 3 && !applied; attempt++) {
    await page.locator("#team-preset-select").selectOption("review-guild");
    applied = await page.waitForFunction(() =>
      document.getElementById("team-name-input")?.value === "评审团" ? true : false,
      { timeout: 15_000 }).then(() => true).catch(() => null);
    if (!applied) console.log("PRESET-RETRY:", attempt);
  }
  await page.waitForTimeout(400);
  await page.locator("#team-save-button").click();
  await page.waitForFunction(() =>
    document.getElementById("team-form-title")?.textContent?.includes("评审团"), { timeout: 10_000 });
  console.log("TEAM-SAVED: 评审团");

  // ② 成员库列表验证
  await page.locator("#team-surface-members-tab").click();
  await page.waitForSelector(".member-library-item", { timeout: 10_000 });
  await page.waitForTimeout(600); // refreshUsage 落停
  const listPeek = await page.evaluate(() => ({
    rows: [...document.querySelectorAll(".member-library-item")].map((row) => ({
      id: row.dataset.memberId,
      brand: row.dataset.brand,
      hasLogo: Boolean(row.querySelector("svg.member-library-logo")),
      badges: [...row.querySelectorAll(".member-badge")].map((b) => b.textContent.trim()),
    })),
  }));
  console.log("LIST-ROWS:", JSON.stringify(listPeek.rows));
  await page.screenshot({ path: ".qa-v4/member-lib-list-light.png" });

  // ③ 打开 codex-technical → 使用情况区块
  await page.locator('.member-library-item[data-member-id="codex-technical"]').click();
  await page.waitForSelector("#member-usage-list .member-usage-chip", { timeout: 10_000 });
  const usagePeek = await page.evaluate(() => ({
    chips: [...document.querySelectorAll("#member-usage-list .member-usage-chip")].map((c) => ({
      text: c.textContent.trim().replace(/\s+/g, " "),
      team: c.dataset.usageTeam,
      coordinator: c.classList.contains("is-coordinator"),
    })),
    deleteTitle: document.getElementById("member-delete-button")?.getAttribute("title"),
    descCount: document.getElementById("member-description-count")?.textContent,
    promptCount: document.getElementById("member-system-prompt-count")?.textContent,
  }));
  console.log("USAGE-PEEK:", JSON.stringify(usagePeek));
  await page.screenshot({ path: ".qa-v4/member-lib-usage-light.png" });

  // ⑤ 字数统计（先验证再跳走，避免脏状态拦截确认框）
  await page.locator("#member-description-input").fill("探针校验字数");
  await page.waitForTimeout(200);
  const counterAfter = await page.evaluate(() => document.getElementById("member-description-count")?.textContent);
  console.log("COUNTER-AFTER-TYPE:", counterAfter);
  await page.locator("#member-description-input").fill(""); // 还原，避免脏状态

  // ④ chip 点击跳回编排面
  await page.locator("#member-usage-list .member-usage-chip").first().click();
  await page.waitForFunction(() =>
    document.getElementById("team-surface-orchestration")?.hidden === false, { timeout: 10_000 });
  const jumpPeek = await page.evaluate(() => ({
    orchestrationVisible: document.getElementById("team-surface-orchestration")?.hidden === false,
    membersHidden: document.getElementById("team-surface-members")?.hidden === true,
    teamTitle: document.getElementById("team-form-title")?.textContent,
  }));
  console.log("JUMP-PEEK:", JSON.stringify(jumpPeek));

  // 暗色截图（回成员库）
  await page.locator("#team-surface-members-tab").click();
  await page.waitForTimeout(500);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(400);
  await page.screenshot({ path: ".qa-v4/member-lib-dark.png" });

  console.log("ERRORS:", errs.length);
  errs.slice(0, 6).forEach((e) => console.log(" -", e));
} finally {
  if (browser) await browser.close();
  if (server) await stopTestServer(server, { token }).catch(() => server.kill("SIGKILL"));
  await rm(qaRoot, { recursive: true, force: true });
}
