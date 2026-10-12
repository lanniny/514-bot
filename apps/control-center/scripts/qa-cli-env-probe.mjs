// 本地 CLI 环境面板波隔离实例探针：
//  ① 「环境」tab → 9 张 CLI 卡片渲染（品牌徽标/通用 terminal、平台徽章、当前/最新版本、状态 chip）；
//  ② 状态语义抽查：claude 装在即 up-to-date/upgrade-available，未装的如实 not-installed；
//  ③ 手动安装命令块 9 行 + 复制钮；安装按钮 → confirmAction 弹窗列出命令 → 取消零外泄（无 install POST）；
//  明暗截图 + 控制台错误汇报（隔离实例 501 属 test-mode 已知噪音；registry 不可达时 latestError 如实呈现）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";
import { buildIsolatedServerEnv, createIsolatedQaRepo } from "./qa-team-workspace.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const token = "cli-env-probe";
const qaRoot = await mkdtemp(join(tmpdir(), "cli-env-"));
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
  const installPosts = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("501")) errs.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errs.push(`PAGEERROR: ${String(e).slice(0, 200)}`));
  page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/api/cli-environment/install")) installPosts.push(request.url()); });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 20_000 });
  // bot 面顶栏导航被 !important 隐藏（bot 表面无 chrome 设计）——走 hash 导航，
// 不依赖被藏按钮的可见性（与 qa-bot-journey 同款）。
await page.evaluate(() => { location.hash = "#config"; });
await page.waitForFunction(() => document.querySelector("#view-config")?.classList?.contains("is-active") === true, null, { timeout: 15_000 });
  await page.locator('[data-config-surface="local-runtime"]').click();
  const root = page.locator("#ccswitch-workbench");
  await root.waitFor({ state: "visible" });
  await root.locator('[data-ccs-tab="env"]').click();
  await root.locator(".ccs-cli-card").first().waitFor({ timeout: 40_000 }); // 9 路探测+registry 查询可能耗时
  await page.waitForTimeout(400);

  const peek = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".ccs-cli-card")].map((card) => ({
      id: card.dataset.ccsCliCard,
      label: card.querySelector(".ccs-cli-title strong")?.textContent,
      status: card.querySelector(".status-label")?.textContent?.trim(),
      tone: card.querySelector(".status-label")?.className.replace("status-label", "").trim(),
      brandSvg: card.querySelector(".ccs-cli-logo svg use")?.getAttribute("href"),
      platform: card.querySelector(".ccs-cli-platform")?.textContent,
      current: card.querySelectorAll(".ccs-cli-versions dd")?.[0]?.textContent,
      latest: card.querySelectorAll(".ccs-cli-versions dd")?.[1]?.textContent,
      action: card.querySelector("[data-ccs-cli-install]")?.textContent?.trim() ?? null,
      note: card.querySelector(".ccs-cli-note")?.textContent?.trim() ?? null,
    }));
    return {
      tabActive: document.querySelector('[data-ccs-tab="env"]')?.classList.contains("is-active"),
      cardCount: cards.length,
      cards,
      upgradeAllText: document.querySelector('[data-ccs-action="clienv-upgrade-all"]')?.textContent?.trim(),
      upgradeAllDisabled: document.querySelector('[data-ccs-action="clienv-upgrade-all"]')?.disabled,
      manualRows: [...document.querySelectorAll(".ccs-cli-cmd code")].map((row) => row.textContent),
      manualCopyButtons: document.querySelectorAll("[data-ccs-cli-copy]").length,
    };
  });
  console.log("CLI-ENV-PEEK:", JSON.stringify(peek, null, 1));
  // 扩编波硬断言：11 卡；cursor win32 无假按钮+说明文字；codebuddy npm 命令；复制钮 = 可安装工具数
  const cursorCard = peek.cards.find((card) => card.id === "cursor");
  const codebuddyCard = peek.cards.find((card) => card.id === "codebuddy");
  const checks = {
    cardCount11: peek.cardCount === 11,
    cursorNoFakeButton: cursorCard && cursorCard.action === null && /Windows 无官方/.test(cursorCard.note ?? ""),
    cursorLatestParsed: Boolean(cursorCard?.latest && cursorCard.latest !== "—"),
    codebuddyInstallable: codebuddyCard?.action === "安装",
    codebuddyManualNpm: peek.manualRows.some((row) => row === "npm i -g @tencent-ai/codebuddy-code@latest"),
    copyButtonsMatchInstallable: peek.manualCopyButtons === peek.cards.filter((card) => card.action !== null || !card.note).length,
  };
  console.log("EXPANSION-CHECKS:", JSON.stringify(checks));
  if (Object.values(checks).some((ok) => !ok)) throw new Error("cli-env expansion assertions failed");
  await root.evaluate((element) => element.scrollIntoView({ block: "start", inline: "nearest" }));
  await page.screenshot({ path: ".qa-v4/cli-env-light.png" });

  // 安装确认弹窗：点第一个可操作按钮 → 弹窗列命令 → 取消，全程不得发出 install POST
  const actionable = page.locator("[data-ccs-cli-install]").first();
  if (await actionable.count()) {
    await actionable.click();
    await page.waitForSelector("#action-dialog[open]", { timeout: 5_000 });
    const dialogPeek = await page.evaluate(() => ({
      eyebrow: document.getElementById("dialog-eyebrow")?.textContent,
      title: document.getElementById("dialog-title")?.textContent,
      rows: [...document.querySelectorAll("#dialog-body dt")].map((dt) => `${dt.textContent}=${dt.nextElementSibling?.textContent}`),
      confirmLabel: document.getElementById("dialog-confirm-button")?.textContent,
    }));
    console.log("DIALOG-PEEK:", JSON.stringify(dialogPeek));
    await page.screenshot({ path: ".qa-v4/cli-env-dialog-light.png" });
    await page.locator('#action-dialog button[value="cancel"]').first().click();
    await page.waitForTimeout(300);
    console.log("INSTALL-POSTS-AFTER-CANCEL:", installPosts.length);
  } else {
    console.log("DIALOG-PEEK: no actionable card (all up-to-date)");
  }

  // 手动命令块展开 + 暗色截图
  await page.locator(".ccs-cli-manual summary").click();
  await page.waitForTimeout(200);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(400);
  await page.screenshot({ path: ".qa-v4/cli-env-dark.png" });

  console.log("ERRORS:", errs.length);
  errs.slice(0, 6).forEach((e) => console.log(" -", e));
} finally {
  if (browser) await browser.close();
  if (server) await stopTestServer(server, { token }).catch(() => server.kill("SIGKILL"));
  await rm(qaRoot, { recursive: true, force: true });
}
