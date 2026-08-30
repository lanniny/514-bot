#!/usr/bin/env node
// 壁纸冷启动复现探针：用 LO 的真实偏好 + 真实 60MB 视频字节，在隔离 fixture 里
// 完整复现「新壳（空 localStorage）→ 水合 → GET 大视频 → 挂载」链路，
// 逐 200ms 记录 team-bg-active / 媒体层状态迁移 + 网络事件，找失效断点。
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const token = "wallpaper-repro-token-0123456789";
const REAL_DATA = resolve(appRoot, "../../.ai-shared/control-center");

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
  const root = await mkdtemp(resolve(appRoot, ".qa-wall-repro-"));
  const repoRoot = resolve(root, "repo");
  const dataRoot = resolve(root, "data");
  const fakeHome = resolve(root, "home");
  await writeConfig(repoRoot);
  await mkdir(fakeHome, { recursive: true });
  // 用 LO 的真实数据：偏好 + 60MB 视频字节
  await mkdir(dataRoot, { recursive: true });
  await copyFile(resolve(REAL_DATA, "preferences.json"), resolve(dataRoot, "preferences.json"));
  await mkdir(resolve(dataRoot, "uploads/avatars"), { recursive: true });
  await copyFile(resolve(REAL_DATA, "uploads/avatars/teambg--__global__.mp4"), resolve(dataRoot, "uploads/avatars/teambg--__global__.mp4"));
  console.log("[repro] real pref + video bytes staged");

  const server = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: token,
      CONTROL_CENTER_REPO_ROOT: repoRoot,
      CONTROL_CENTER_DATA_DIR: dataRoot,
      CONTROL_CENTER_PORT: "0",
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
  });
  let browser;
  try {
    const url = await waitForUrl(server);
    const origin = new URL(url).origin;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const consoleErrors = [];
    page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
    const fetchLogs = [];
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("[fetch#")) fetchLogs.push(text.slice(0, 320));
      else if (message.type() === "error" && !/^Failed to load resource:/.test(text)) consoleErrors.push(`console: ${text.slice(0, 160)}`);
    });
    page.on("response", (response) => {
      if (response.url().includes("/api/wallpapers/global") || response.url().includes("/api/preferences")) {
        console.log(`[net] ${new Date().toISOString().slice(14, 22)} ${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
      }
    });
    page.on("requestfailed", (request) => {
      if (request.url().includes("/api/wallpapers/")) console.log(`[net] FAILED ${request.failure()?.errorText} ${new URL(request.url()).pathname}`);
    });

    await page.addInitScript(() => {
      const original = window.fetch;
      let count = 0;
      window.fetch = function (input, init) {
        const href = typeof input === "string" ? input : input?.url ?? "";
        if (href.includes("/api/wallpapers/global")) {
          count += 1;
          const stack = String(new Error().stack ?? "").split("\n").slice(2, 6).map((l) => l.trim().replace(/^at /, "")).join(" <= ");
          console.log(`[fetch#${count}] ${init?.method ?? "GET"} ${stack.slice(0, 300)}`);
        }
        return original.call(this, input, init);
      };
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });

    // 逐 200ms 记录 25s 的壁纸状态迁移
    const timeline = await page.evaluate(() => new Promise((resolveTimeline) => {
      const events = [];
      const t0 = performance.now();
      let last = "";
      const timer = window.setInterval(() => {
        const body = document.body;
        const media = document.querySelector("#atelier-stage .team-bg-media");
        const video = media?.querySelector("video");
        const img = media?.querySelector("img");
        const state = JSON.stringify({
          bgActive: body.classList.contains("team-bg-active"),
          mediaChildren: media ? [...media.children].map((c) => `${c.tagName}(ready=${c.readyState ?? "-"},w=${c.videoWidth ?? c.naturalWidth ?? 0})`).join(",") : "(empty)",
          videoPaused: video ? video.paused : null,
          prefRaw: window.localStorage.getItem("514cc-global-wallpaper")?.slice(0, 60) ?? "(no-key)",
        });
        if (state !== last) {
          events.push(`${Math.round(performance.now() - t0)}ms ${state}`);
          last = state;
        }
      }, 200);
      window.setTimeout(() => { window.clearInterval(timer); resolveTimeline(events); }, 25_000);
    }));
    console.log("[repro] timeline:");
    for (const event of timeline) console.log(`  ${event}`);

    await page.screenshot({ path: resolve(appRoot, ".qa-output/wall-repro-final.png") });
    const prefFinal = await page.evaluate(() => window.localStorage.getItem("514cc-global-wallpaper"));
    console.log("[repro] final pref:", prefFinal);
    console.log("[repro] fetch call sites:");
    for (const line of fetchLogs) console.log(`  ${line}`);
    console.log("[repro] errors:", consoleErrors.length ? consoleErrors.join(" | ").slice(0, 600) : "(none)");
    console.log("REPRO-DONE");
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopTestServer(server).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error("REPRO-FAIL:", error?.message ?? error);
  process.exitCode = 1;
});
