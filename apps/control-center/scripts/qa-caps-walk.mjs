#!/usr/bin/env node
// 配置能力面（Skill / MCP 工作区）UI 走查截图：明暗两态 + 关键交互区。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const outputDir = resolve(appRoot, ".qa-output", "caps-walk");
const token = "caps-walk-token-0123456789";

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
  const root = await mkdtemp(resolve(appRoot, ".qa-caps-walk-"));
  const repoRoot = resolve(root, "repo");
  const fakeHome = resolve(root, "home");
  await writeConfig(repoRoot);
  await mkdir(fakeHome, { recursive: true });
  // 真实数据光照亮布局：module.yaml + skills 目录（仓库真源，无凭据）；MCP 用合成
  // claude.json（纯结构假数据，不触碰真实凭据文件）。
  const realRepo = resolve(appRoot, "../..");
  const { cp } = await import("node:fs/promises");
  await cp(resolve(realRepo, "module.yaml"), resolve(repoRoot, "module.yaml")).catch(() => {});
  await cp(resolve(realRepo, "skills"), resolve(repoRoot, "skills"), { recursive: true }).catch(() => {});
  await cp(resolve(realRepo, ".agents"), resolve(repoRoot, ".agents"), { recursive: true }).catch(() => {});
  await writeFile(resolve(fakeHome, ".claude.json"), JSON.stringify({
    mcpServers: {
      "context7": { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
      "computer-use": { command: "node", args: ["server.js"] },
      "playwright": { command: "npx", args: ["-y", "@playwright/mcp"] },
    },
  }));
  await mkdir(resolve(fakeHome, ".claude"), { recursive: true });
  await writeFile(resolve(fakeHome, ".claude/settings.json"), JSON.stringify({ enabledMcpjsonServers: [] }));
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
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
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });

    // workspace 切换走页签按钮（hash 路由不解析 workspace 参数）；滚动走真正的滚动容器
    for (const workspace of ["skills", "mcp"]) {
      await page.evaluate(() => { location.hash = "#config/capabilities"; });
      await page.waitForTimeout(600);
      if (workspace === "mcp") {
        await page.click("#cap-workspace-mcp-tab");
      }
      await page.waitForTimeout(800);
      await page.screenshot({ path: resolve(outputDir, `caps-${workspace}.png`) });
      const scrollerInfo = await page.evaluate(() => {
        const candidates = [document.querySelector(".main-content"), document.querySelector("main"), document.scrollingElement];
        for (const scroller of candidates) {
          if (scroller && scroller.scrollHeight > scroller.clientHeight + 100) {
            return { using: scroller.className || scroller.tagName, max: scroller.scrollHeight, step: scroller.clientHeight };
          }
        }
        return null;
      });
      console.log(`[caps] ${workspace} scroller:`, JSON.stringify(scrollerInfo));
      if (scrollerInfo) {
        for (let i = 1; i <= 3; i++) {
          await page.evaluate(({ step }) => {
            const scroller = [document.querySelector(".main-content"), document.querySelector("main"), document.scrollingElement]
              .find((el) => el && el.scrollHeight > el.clientHeight + 100);
            if (scroller) scroller.scrollTop = step * 1;
          }, { step: scrollerInfo.step * i });
          await page.waitForTimeout(250);
          await page.screenshot({ path: resolve(outputDir, `caps-${workspace}-scroll${i}.png`) });
        }
      }
      if (workspace === "mcp") {
        console.log("[caps] map grid:", await page.evaluate(() => {
          const grid = document.querySelector(".cap-map-grid");
          if (!grid) return "(missing)";
          const cs = getComputedStyle(grid);
          return JSON.stringify({ display: cs.display, cols: cs.gridTemplateColumns.split(" ").length, width: grid.getBoundingClientRect().width, parentWidth: grid.parentElement.getBoundingClientRect().width, parentTag: `${grid.parentElement.tagName}.${grid.parentElement.className}` });
        }));
      }
      console.log(`[caps] shot ${workspace}`);
    }
    // 技能列聚焦（成员维度矩阵，PM 走查该面的另一形态）
    await page.evaluate(() => { location.hash = "#config/capabilities"; });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: resolve(outputDir, "caps-default.png"), fullPage: true });
    console.log("[caps] done");
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopTestServer(server).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error("CAPS-WALK-FAIL:", error?.message ?? error);
  process.exitCode = 1;
});
