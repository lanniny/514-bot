#!/usr/bin/env node
// 一次性探针：验证「发送给谁」picker 的三项完善（真实职责副行 / 团队上下文 / 数字键直达）。
// 隔离跑法与 tests/server-fixture 相同（临时 repo/data 根），不触碰正式实例。
// 注意：fixture 冷启时 /api/bootstrap 可能慢于 SSE（健康探测 ENOENT 退化 30s 轮询），
// 职责副行要等目录落地 + refreshAvatarSurfaces 重渲，因此断言前先 waitForFunction。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "./tests/server-fixture.mjs";

const appRoot = resolve(import.meta.dirname, ".");
const token = "probe-picker-token-0123456789";
const cwd = process.platform === "win32" ? "C:\\probe-picker-scratch" : "/tmp/probe-picker-scratch";

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

async function main() {
  const root = await mkdtemp(resolve(appRoot, ".qa-probe-picker-"));
  const repoRoot = resolve(root, "repo");
  const fakeHome = resolve(root, "home");
  await writeConfig(repoRoot);
  await mkdir(fakeHome, { recursive: true });
  const server = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: token,
      CONTROL_CENTER_REPO_ROOT: repoRoot,
      CONTROL_CENTER_DATA_DIR: resolve(root, "data"),
      CONTROL_CENTER_PORT: "0",
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
  });
  let browser;
  try {
    const url = await waitForUrl(server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/^Failed to load resource:/.test(message.text())) consoleErrors.push(message.text());
    });
    await page.goto(url, { waitUntil: "domcontentloaded" }); // 带 #bootstrap=nonce 走完整启动流
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });

    // 打开新建任务向导 → 填地址 → 提交 → picker 出现
    await page.locator("#new-task-row").click();
    await page.locator("#session-next-button").click();
    await page.locator("#session-cwd-input").fill(cwd);
    await page.locator("#session-submit-button").click();
    await page.waitForSelector('[data-stream-key="empty:agent-picker"]', { timeout: 15_000 });

    const meta = (await page.locator(".picker-team-meta").textContent()).trim();
    assert.match(meta, /团队 .+ · \d+ 席/, `团队上下文行异常: ${meta}`);
    const cards = page.locator(".agent-pick-card");
    const cardCount = await cards.count();
    assert.ok(cardCount >= 2, `成员卡数量异常: ${cardCount}`);
    const keyBadges = await page.locator(".agent-pick-key").count();
    assert.equal(keyBadges, Math.min(cardCount, 9), `数字角标数量异常: ${keyBadges}/${cardCount}`);
    console.log(`[picker] meta=${meta} cards=${cardCount}`);
    await page.screenshot({ path: resolve(appRoot, ".qa-output/probe-picker-open.png"), fullPage: false });

    // 输入框聚焦时按 2 不抢输入：picker 仍在，字符进输入框
    await page.locator("#task-input").fill("");
    await page.locator("#task-input").pressSequentially("2");
    assert.equal(await page.locator('[data-stream-key="empty:agent-picker"]').count(), 1, "输入框聚焦时数字键不该触发选人");
    assert.equal(await page.locator("#task-input").inputValue(), "2", "数字键未进入输入框");
    await page.locator("#task-input").fill("");

    // 焦点移出编辑控件后按 2：直达第二个成员并关闭 picker
    const secondLabel = (await cards.nth(1).locator("strong").textContent()).trim();
    await page.locator("body").click({ position: { x: 10, y: 400 } });
    await page.keyboard.press("2");
    await page.waitForFunction(() => !document.querySelector('[data-stream-key="empty:agent-picker"]'), null, { timeout: 5_000 });
    const activeChip = (await page.locator('#member-strip [data-composer-target][aria-checked="true"]').textContent()).trim();
    assert.ok(activeChip.includes(secondLabel) || secondLabel.includes(activeChip), `激活 chip 与第 2 张卡不一致: ${activeChip} vs ${secondLabel}`);
    console.log(`[picker] key-2 picked: ${activeChip}`);

    // 回到 picker：等成员目录落地（职责副行出现 ·），再断言角色文案
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });
    await page.locator("#new-task-row").click();
    await page.locator("#session-next-button").click();
    await page.locator("#session-cwd-input").fill(cwd);
    await page.locator("#session-submit-button").click();
    await page.waitForSelector('[data-stream-key="empty:agent-picker"]', { timeout: 15_000 });
    await page.waitForFunction(() => {
      const line = document.querySelector('.agent-pick-card:nth-child(2) > span:last-child');
      return line && line.textContent.includes("·");
    }, null, { timeout: 40_000 });
    const allRoles = await cards.evaluateAll((nodes) => nodes.map((node) => `${node.querySelector("strong")?.textContent} => ${(node.lastElementChild?.textContent ?? "").trim()}`));
    console.log(`[picker] card roles: ${allRoles.join(" | ")}`);
    const firstRole = (await cards.nth(0).locator("span:last-child").textContent()).trim();
    assert.match(firstRole, /主脑/, `主脑卡副行异常: ${firstRole}`);
    const codexRole = (await cards.nth(1).locator("span:last-child").textContent()).trim();
    assert.match(codexRole, /技术执行/, `Codex 职责副行异常: ${codexRole}`);
    await page.screenshot({ path: resolve(appRoot, ".qa-output/probe-picker-roles.png"), fullPage: false });

    assert.deepEqual(pageErrors, [], `页面错误: ${pageErrors.join(" | ")}`);
    assert.deepEqual(consoleErrors, [], `控制台错误: ${consoleErrors.join(" | ")}`);
    console.log("PROBE-PASS");
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopTestServer(server).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error("PROBE-FAIL:", error?.message ?? error);
  process.exitCode = 1;
});
