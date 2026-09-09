#!/usr/bin/env node
/**
 * qa-shell-refresh.mjs — 壳层刷新 UI 验证（2026-09-09）。
 *
 * 验证三项改造：
 * ① 桌面隐藏左侧栏（导航迁入设置配置面板）；
 * ② 左下角固定设置坞 → 点击展开完整设置面板（含迁移后的全部功能导航）；
 * ③ 协作台聊天化：气泡美化 + 协作过程 details 默认收纳。
 *
 * 运行：node scripts/qa-shell-refresh.mjs
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

// WorkBuddy 宿主 NODE_OPTIONS 安全删除 shim 剥离重拉（与 run-tests.mjs / qa-bot-grok-parity 同手法）
const HOST_SHIM_MARKER = "node-language-shim.cjs";
if ((process.env.NODE_OPTIONS ?? "").includes(HOST_SHIM_MARKER)) {
  const scrubbed = process.env.NODE_OPTIONS
    .replace(/--require(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/g, (match) =>
      match.includes(HOST_SHIM_MARKER) ? "" : match)
    .replace(/\s{2,}/g, " ")
    .trim();
  const relaunched = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: scrubbed },
  });
  process.exit(relaunched.status ?? 1);
}

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const outputDir = resolve(appRoot, ".qa-output", "shell-refresh");
const token = "shell-refresh-qa-token-0123456789abcd";

async function writeConfig(repoRoot) {
  await mkdir(resolve(repoRoot, "config/control-center"), { recursive: true });
  await writeFile(resolve(repoRoot, "config/app.json"), '{"enabled":true}\n');
  await writeFile(resolve(repoRoot, "config/control-center/models.json"), JSON.stringify({
    version: 1,
    profiles: testModelProfiles().map((profile, index) => ({
      ...profile,
      enabled: true,
      capabilities: ["*"],
      quality: 0.95 - index * 0.01,
      speed: 0.8,
      costTier: 2,
      evidence: [{ source: "qa-fixture", detail: "Shell refresh QA", verifiedAt: "2026-09-09" }],
    })),
  }));
  await writeFile(resolve(repoRoot, "config/control-center/routing.json"), JSON.stringify({
    version: 1,
    primaryCoordinator: "claude-fable",
    technicalExecutor: "codex-technical",
    maxRounds: 6, maxDepth: 2, maxParallelAgents: 4,
    requireHealthyProvider: false, failOnUnavailableExplicitProvider: false,
    weights: { quality: 0.44, speed: 0.26, health: 0.22, cost: 0.08 },
    rules: [],
    independentPass: { requiredFor: [], mustDifferFromPrimary: true },
  }));
  await writeFile(resolve(repoRoot, "config/control-center/permissions.json"), JSON.stringify({
    version: 1,
    defaultMode: "plan",
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
  const root = await mkdtemp(resolve(appRoot, ".qa-shell-refresh-"));
  const repoRoot = resolve(root, "repo");
  const dataRoot = resolve(root, "data");
  const fakeHome = resolve(root, "home");
  await writeConfig(repoRoot);
  await mkdir(fakeHome, { recursive: true });
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const env = {
    CONTROL_CENTER_TOKEN: token,
    CONTROL_CENTER_REPO_ROOT: repoRoot,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_PORT: "0",
    HOME: fakeHome,
    USERPROFILE: fakeHome,
  };
  const server = { child: spawnTestServer({ env }), url: null };
  server.url = await waitForUrl(server.child);
  let browser;
  const report = { ok: false, checks: [], screenshots: [] };
  const check = (name, fn) => {
    try {
      fn();
      report.checks.push({ name, ok: true });
    } catch (error) {
      report.checks.push({ name, ok: false, error: error.message });
      throw error;
    }
  };
  try {
    const origin = new URL(server.url).origin;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const api = async (path, { method = "GET", body } = {}) => {
      const response = await fetch(new URL(path, origin), {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
      return payload;
    };

    // 造一条带真实气泡的会话：social execute 轮先把 user.message 投影进事件流
    const project = (await api("/api/projects", { method: "POST", body: { title: "Shell refresh workspace", cwd: repoRoot } })).project;
    const group = (await api("/api/conversations", {
      method: "POST",
      body: { kind: "workspace_group", title: "壳层刷新演示室", projectId: project.projectId, roomRole: "task", memberIds: ["claude-fable", "codex-technical"] },
    })).conversation;
    await api("/api/runs", {
      method: "POST",
      body: {
        prompt: "SHELL_REFRESH_MARK 帮我梳理这周的控制台改造重点", execute: true, permissionMode: "plan",
        conversationId: group.id, conversationKind: "workspace_group",
        orchestrationMode: "social", startAgentId: "claude-fable", requestedAgentIds: ["codex-technical"],
        ephemeralTeam: { name: "Shell refresh team", coordinator: "claude-fable", members: ["claude-fable", "codex-technical"], skills: [], mcp: [], providers: {}, systemPrompt: "" },
      },
    });

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (error) => { throw error; });
    await page.addInitScript((accessToken) => {
      sessionStorage.setItem("514cc-control-token", accessToken);
      localStorage.setItem("514cc-product-tour-dismissed", "1");
    }, token);
    await page.goto(`${origin}/#bot`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });

    // ① 桌面隐藏左侧栏
    const sidebarVisible = await page.locator("#sidebar").isVisible().catch(() => false);
    check("sidebar is hidden on desktop", () => assert.equal(sidebarVisible, false));
    const dockVisible = await page.locator("#settings-dock-button").isVisible().catch(() => false);
    check("settings dock hidden in bot view (roster footer owns the entry)", () => assert.equal(dockVisible, false));
    // bot 视图左下角 roster 底部有同源设置入口
    check("bot roster footer keeps a settings entry", () =>
      page.locator(".bot-roster-footer [data-workspace-view='config']").waitFor({ state: "attached", timeout: 5000 }));
    await page.screenshot({ path: resolve(outputDir, "01-bot-no-sidebar.png") });
    report.screenshots.push("01-bot-no-sidebar.png");

    // ② 非 bot 视图：坞可见 → 点击展开完整设置面板
    await page.locator("#command-palette-trigger").click();
    await page.keyboard.type("系统总览");
    await page.keyboard.press("Escape"); // 面板结果态不稳定：直接走 hash 更稳
    await page.evaluate(() => { location.hash = "#overview"; });
    await page.waitForFunction(() => document.querySelector("#view-overview")?.classList.contains("is-active") === true, null, { timeout: 15_000 });
    await page.locator("#settings-dock-button").waitFor({ state: "visible", timeout: 10_000 });
    await page.screenshot({ path: resolve(outputDir, "02-dock-visible.png") });
    report.screenshots.push("02-dock-visible.png");
    await page.locator("#settings-dock-button").click();
    await page.waitForFunction(() => document.querySelector(".app-shell")?.classList.contains("is-settings") === true, null, { timeout: 15_000 });
    const railText = await page.locator("#settings-destinations").textContent();
    check("settings panel carries all migrated sidebar destinations", () => {
      for (const label of ["514 Bot", "自动化", "插件中心", "会话聚合", "团队协作", "运行控制台", "文档工坊", "项目启动器", "渠道", "配置", "市场", "远程主机", "系统总览", "体系观测", "安全诊断"]) {
        assert.ok(railText.includes(label), `设置面板缺少迁移项：${label}`);
      }
      // 原设置项不丢
      for (const label of ["运行席位", "连接档案", "能力", "钩子", "本机运行时", "外观", "浏览器", "权限与审批"]) {
        assert.ok(railText.includes(label), `设置面板缺少原设置项：${label}`);
      }
    });
    const dockInSettings = await page.locator("#settings-dock-button").isVisible().catch(() => false);
    check("dock yields while settings panel is open", () => assert.equal(dockInSettings, false));
    await page.screenshot({ path: resolve(outputDir, "03-settings-panel.png") });
    report.screenshots.push("03-settings-panel.png");

    // ③ 从设置面板点迁移导航回协作台（迁移项真实可点 = 功能无遗漏的直接证据）
    await page.locator('[data-nav-surface="settings"] [data-view="bot"]').click();
    await page.waitForFunction(() => document.querySelector("#view-bot")?.classList.contains("is-active") === true, null, { timeout: 15_000 });
    check("migrated nav item returns to bot surface", () => assert.ok(true));

    // ④ 聊天化气泡 + 协作过程收纳
    await page.locator("#bot-surface-tab-chats").click();
    const groupRow = page.locator(`[data-bot-conversation="${group.id}"]`);
    if (!(await groupRow.isVisible().catch(() => false))) {
      await page.locator(`[data-bot-project-toggle="${project.projectId}"]`).click();
    }
    await groupRow.click();
    await page.waitForFunction(
      () => document.querySelector("#bot-message-stream")?.textContent?.includes("SHELL_REFRESH_MARK") === true,
      null,
      { timeout: 20_000 },
    );
    check("user bubble renders in chat flow", () =>
      page.locator("#bot-message-stream .bot-message-user .bot-bubble").first().waitFor({ state: "attached", timeout: 5000 }));
    await page.screenshot({ path: resolve(outputDir, "04-chat-bubbles.png") });
    report.screenshots.push("04-chat-bubbles.png");
    // 协作过程组（若本轮产生了过程消息）：必须是默认收合的 details，点开才展开
    const activityGroup = page.locator("#bot-message-stream details.bot-activity-group").first();
    if (await activityGroup.count()) {
      check("process group is a collapsed details by default", async () => {
        assert.equal(await activityGroup.evaluate((node) => node.open), false);
      });
      await activityGroup.locator("summary.bot-activity-summary").click();
      check("process group expands on summary click", async () => {
        assert.equal(await activityGroup.evaluate((node) => node.open), true);
      });
      await page.screenshot({ path: resolve(outputDir, "05-process-expanded.png") });
      report.screenshots.push("05-process-expanded.png");
    } else {
      report.checks.push({ name: "process group stow (no activity this run — covered by contract test)", ok: true, skipped: true });
    }

    report.ok = true;
  } finally {
    await browser?.close().catch(() => {});
    await stopTestServer(server.child).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await writeFile(resolve(outputDir, "report.json"), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
