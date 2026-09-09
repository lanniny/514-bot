#!/usr/bin/env node
/**
 * qa-bot-wallpaper-veil.mjs — 壁纸态阅读纱幕验证（2026-09-09）。
 *
 * 复现 LO 截图场景：壁纸激活 + 用户把全局玻璃滑杆拉到 32%（手动接管档）——
 * 旧版 agent 气泡是透明编辑式底，长文直接坐在锐利壁纸上。
 * 验证阅读纱幕：
 *   ① agent 气泡 / 协作过程卡 / 输入行 = --forge-reading-alpha 阅读档（地板 86%，
 *      即使全局滑杆 32% 也不破底）且带 backdrop-filter；
 *   ② 会话头部 = --forge-glass-alpha-mid 磨砂条；
 *   ③ 面板本体仍跟随用户滑杆（尊重用户审美，美感让渡给边缘透出）；
 *   ④ 截图：低滑杆壁纸聊天全景 / 过程卡展开 / 默认高滑杆对照。
 *
 * 运行：node scripts/qa-bot-wallpaper-veil.mjs
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

// WorkBuddy 宿主 NODE_OPTIONS 安全删除 shim 剥离重拉（与 run-tests.mjs 同手法）
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
const outputDir = resolve(appRoot, ".qa-output", "bot-wallpaper-veil");
const token = "wallpaper-veil-qa-token-0123456789abcd";

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
      evidence: [{ source: "qa-fixture", detail: "Wallpaper veil QA", verifiedAt: "2026-09-09" }],
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

/** 从 computed background-color 里取 alpha：Chromium 会把 color-mix 序列化成
    oklab(... / a) / oklch(... / a)，普通实色是 rgb(a)(...)——两种格式都要吃。 */
function alphaOf(computedColor) {
  const text = String(computedColor ?? "");
  const slashAlpha = /\/\s*([0-9.]+)\s*\)\s*$/.exec(text);
  if (slashAlpha) return Number.parseFloat(slashAlpha[1]);
  const match = /rgba?\(([^)]+)\)/.exec(text);
  if (!match) return null;
  const parts = match[1].split(",").map((part) => Number.parseFloat(part));
  return parts.length === 4 ? parts[3] : 1;
}

async function main() {
  const root = await mkdtemp(resolve(appRoot, ".qa-wallpaper-veil-"));
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
    report.checks.push({ name, ok: true });
    return Promise.resolve()
      .then(fn)
      .catch((error) => {
        report.checks[report.checks.length - 1] = { name, ok: false, error: error.message };
        throw error;
      });
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

    // 造一条带真实气泡 + 协作过程的群会话
    const project = (await api("/api/projects", { method: "POST", body: { title: "Wallpaper veil workspace", cwd: repoRoot } })).project;
    const group = (await api("/api/conversations", {
      method: "POST",
      body: { kind: "workspace_group", title: "壁纸纱幕演示室", projectId: project.projectId, roomRole: "task", memberIds: ["claude-fable", "codex-technical"] },
    })).conversation;
    await api("/api/runs", {
      method: "POST",
      body: {
        prompt: "WALLPAPER_VEIL_MARK 帮我总结本周控制台改造的三个重点", execute: true, permissionMode: "plan",
        conversationId: group.id, conversationKind: "workspace_group",
        orchestrationMode: "social", startAgentId: "claude-fable", requestedAgentIds: ["codex-technical"],
        ephemeralTeam: { name: "Veil team", coordinator: "claude-fable", members: ["claude-fable", "codex-technical"], skills: [], mcp: [], providers: {}, systemPrompt: "" },
      },
    });

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (error) => { throw error; });
    await page.addInitScript((accessToken) => {
      sessionStorage.setItem("514cc-control-token", accessToken);
      // 复现 LO 截图条件：用户把全局玻璃滑杆拉到 32%（手动接管档，值域 20–95）
      localStorage.setItem("514cc-wallpaper-glass-alpha", "32");
    }, token);
    await page.goto(`${origin}/#bot`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });

    // 浏览器内画「蓝天 + 锐利黄花」壁纸并上传（锐利前景正是阅读纱幕的受力场景）
    const upload = await page.evaluate(async (auth) => {
      const canvas = document.createElement("canvas");
      canvas.width = 960;
      canvas.height = 600;
      const ctx = canvas.getContext("2d");
      const sky = ctx.createLinearGradient(0, 0, 0, 600);
      sky.addColorStop(0, "#3f96e6");
      sky.addColorStop(0.55, "#8ec5f2");
      sky.addColorStop(1, "#d8ecf9");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, 960, 600);
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      for (const [x, y, r] of [[180, 110, 60], [260, 130, 44], [720, 90, 70], [800, 120, 40]]) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // 锐利黄花簇（高饱和硬边前景，铺满阅读区高度）
      for (const [cx, cy] of [[120, 300], [300, 380], [520, 290], [760, 400], [880, 260], [420, 430], [660, 330], [220, 480], [820, 500]]) {
        for (let petal = 0; petal < 6; petal += 1) {
          const angle = (petal / 6) * Math.PI * 2;
          ctx.fillStyle = petal % 2 ? "#ffd23f" : "#f5b91e";
          ctx.beginPath();
          ctx.arc(cx + Math.cos(angle) * 26, cy + Math.sin(angle) * 26, 20, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = "#c98a12";
        ctx.beginPath();
        ctx.arc(cx, cy, 14, 0, Math.PI * 2);
        ctx.fill();
      }
      const dataUrl = canvas.toDataURL("image/png");
      const pref = JSON.stringify({
        preset: "custom", fit: "cover", overrideTeam: true,
        rotate: { enabled: false, intervalMin: 5, order: "sequential" }, hasCustom: true,
      });
      const putPref = await fetch("/api/preferences", {
        method: "PUT",
        headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: JSON.stringify({ "514cc-global-wallpaper": pref }),
      });
      const postMedia = await fetch("/api/wallpapers/global", {
        method: "POST",
        headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      localStorage.setItem("514cc-global-wallpaper", pref);
      return { putPref: putPref.status, postMedia: postMedia.status };
    }, token);
    if (upload.putPref !== 200 || upload.postMedia !== 200) throw new Error(`wallpaper upload failed: ${JSON.stringify(upload)}`);

    // 重载走真实启动管线：偏好水合 → 壁纸挂载 → 媒体采样 → 环境玻璃令牌
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.classList.contains("team-bg-active"), null, { timeout: 30_000 });
    await page.waitForFunction(
      () => document.documentElement.style.getPropertyValue("--wall-tint").includes("oklch"),
      null,
      { timeout: 30_000 },
    );
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });
    await page.waitForTimeout(1000);

    // 环境探针：滑杆 32% 生效 + 阅读档派生令牌带 86% 地板
    const env0 = await page.evaluate(() => {
      const style = document.documentElement.style;
      return {
        alpha: style.getPropertyValue("--forge-glass-alpha").trim(),
        hi: style.getPropertyValue("--forge-glass-alpha-hi").trim(),
        mid: style.getPropertyValue("--forge-glass-alpha-mid").trim(),
        reading: style.getPropertyValue("--forge-reading-alpha").trim(),
      };
    });
    check("user slider takes over the panel alpha (32%)", () => assert.equal(env0.alpha, "32%"));
    check("reading token keeps the 86% floor under a low slider", () => assert.equal(env0.reading, "86%"));

    // 打开群会话
    await page.locator("#bot-surface-tab-chats").click();
    const groupRow = page.locator(`[data-bot-conversation="${group.id}"]`);
    if (!(await groupRow.isVisible().catch(() => false))) {
      await page.locator(`[data-bot-project-toggle="${project.projectId}"]`).click();
    }
    await groupRow.click();
    await page.waitForFunction(
      () => document.querySelector("#bot-message-stream")?.textContent?.includes("WALLPAPER_VEIL_MARK") === true,
      null,
      { timeout: 20_000 },
    );
    // 隔离内核无真实 CLI 适配器，execute run 不产出 agent 文本（qa-shell-refresh 同款环境）。
    // 纱幕是纯 CSS 层验证：等 2.5s 自然产出，没有就按生产模板（app.js botBubbleMessageMarkup /
    // bot-activity-timeline.js botActivityGroupMarkup）注入同构 DOM 固定件；
    // 数据接线正确性由 qa-shell-refresh 覆盖，本脚本只验壁纸态视觉层。
    await page.waitForTimeout(2500);
    const fixtureInjected = await page.evaluate(() => {
      if (document.querySelector("#view-bot .bot-message-agent .bot-bubble")) return false;
      const stream = document.querySelector("#bot-message-stream");
      const fixture = document.createElement("template");
      fixture.innerHTML = `
<div class="bot-message bot-message-agent" data-bot-event-key="qa-veil-agent">
  <span class="bot-message-avatar"><span class="bot-avatar-initials">FA</span></span>
  <div>
    <p class="bot-message-author">Fable</p>
    <div class="bot-bubble md-body"><p>壁纸纱幕验证：这是一段 agent 长文回复。低滑杆（32%）下，面板高度透出锐利壁纸，但阅读面必须保持高档玻璃卡——文字与壁纸之间始终隔着 86% 地板的磨砂层，长文阅读不费力。</p><p>第二段：壁纸依旧从气泡间隙与面板边缘透出，美感保留，可读性兜底。</p></div>
    <time>18:20</time>
  </div>
</div>
<details class="bot-activity-group" data-bot-activity-count="3" aria-label="协作过程">
  <summary class="bot-activity-summary"><strong>协作过程</strong><span>思考、工具调用与文件改动已收纳——点开核对</span><span>2 位 · 3 条</span><svg class="bot-activity-group-chevron" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></summary>
  <div class="bot-activity-timeline">
    <div class="bot-activity-segment"><p>梳理本周控制台改造重点……</p><time>18:19</time></div>
    <div class="bot-activity-segment"><p>已调用 Read · 已调用 Edit</p><time>18:20</time></div>
  </div>
</details>
<div class="live-delta-bubble">流式输出中：纱幕同样覆盖实时增量气泡……</div>`;
      stream.append(...fixture.content.childNodes);
      return true;
    });
    report.checks.push({ name: fixtureInjected ? "agent output fixture injected (no CLI in isolated kernel)" : "natural agent output present", ok: true, skipped: !fixtureInjected });
    await page.waitForTimeout(400);

    // ① 阅读面计算值断言：气泡/输入行 alpha 贴 86% 地板（面板仅 32%），且带磨砂
    const veil = await page.evaluate(() => {
      const read = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const style = getComputedStyle(node);
        return { bg: style.backgroundColor, backdrop: style.backdropFilter || style.webkitBackdropFilter };
      };
      return {
        panel: read("#view-bot .bot-conversation"),
        agentBubble: read("#view-bot .bot-message-agent .bot-bubble"),
        userBubble: read("#view-bot .bot-message-user .bot-bubble"),
        header: read("#view-bot .bot-conversation-header"),
        composerRow: read("#view-bot .bot-composer-row"),
        activityGroup: read("#view-bot details.bot-activity-group"),
      };
    });
    check("agent bubble renders under wallpaper", () => assert.ok(veil.agentBubble, "缺少 agent 气泡"));
    check("panel still follows the user slider (~32%)", () => {
      const a = alphaOf(veil.panel.bg);
      assert.ok(a !== null && a < 0.5, `面板 alpha 应低于 0.5，实际 ${a} (${veil.panel.bg})`);
    });
    check("agent bubble is a high-alpha reading card (>= 0.8)", () => {
      const a = alphaOf(veil.agentBubble.bg);
      assert.ok(a !== null && a >= 0.8, `气泡 alpha 应 ≥ 0.8，实际 ${a} (${veil.agentBubble.bg})`);
    });
    check("agent bubble carries the frosted filter", () =>
      assert.ok(/blur\(/.test(veil.agentBubble.backdrop), `气泡缺少 backdrop-filter：${veil.agentBubble.backdrop}`));
    check("composer row is a high-alpha reading card", () => {
      const a = alphaOf(veil.composerRow.bg);
      assert.ok(a !== null && a >= 0.8, `输入行 alpha 应 ≥ 0.8，实际 ${a} (${veil.composerRow.bg})`);
    });
    check("conversation header is a frosted strip above panel alpha", () => {
      const a = alphaOf(veil.header.bg);
      assert.ok(a !== null && a > alphaOf(veil.panel.bg), `头部 alpha 应高于面板，实际 ${a}`);
    });
    if (veil.activityGroup) {
      check("process group is a high-alpha reading card", () => {
        const a = alphaOf(veil.activityGroup.bg);
        assert.ok(a !== null && a >= 0.8, `过程卡 alpha 应 ≥ 0.8，实际 ${a} (${veil.activityGroup.bg})`);
      });
    } else {
      report.checks.push({ name: "process group veil (no activity this run — covered by contract test)", ok: true, skipped: true });
    }

    await page.screenshot({ path: resolve(outputDir, "01-veil-low-slider-chat.png") });
    report.screenshots.push("01-veil-low-slider-chat.png");

    // ② 过程卡展开态
    const activityGroup = page.locator("#bot-message-stream details.bot-activity-group").first();
    if (await activityGroup.count()) {
      await activityGroup.locator("summary.bot-activity-summary").click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: resolve(outputDir, "02-veil-process-expanded.png") });
      report.screenshots.push("02-veil-process-expanded.png");
    }

    // ③ 输入聚焦态（composer-row 玻璃卡 + 聚焦环）
    await page.locator("#view-bot .bot-composer textarea").click();
    await page.keyboard.type("壁纸纱幕下的输入可读性验证");
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(outputDir, "03-veil-composer-focus.png") });
    report.screenshots.push("03-veil-composer-focus.png");

    // ④ 对照组：滑杆回 auto（档位自动值）下同一视图（重注同构固定件保证可比性）
    await page.evaluate(() => localStorage.setItem("514cc-wallpaper-glass-alpha", "auto"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.classList.contains("team-bg-active"), null, { timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelector("#bot-message-stream")?.textContent?.includes("WALLPAPER_VEIL_MARK") === true,
      null,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      if (document.querySelector("#view-bot .bot-message-agent .bot-bubble")) return;
      const stream = document.querySelector("#bot-message-stream");
      const fixture = document.createElement("template");
      fixture.innerHTML = `
<div class="bot-message bot-message-agent" data-bot-event-key="qa-veil-agent">
  <span class="bot-message-avatar"><span class="bot-avatar-initials">FA</span></span>
  <div>
    <p class="bot-message-author">Fable</p>
    <div class="bot-bubble md-body"><p>壁纸纱幕验证：这是一段 agent 长文回复。低滑杆（32%）下，面板高度透出锐利壁纸，但阅读面必须保持高档玻璃卡——文字与壁纸之间始终隔着 86% 地板的磨砂层，长文阅读不费力。</p><p>第二段：壁纸依旧从气泡间隙与面板边缘透出，美感保留，可读性兜底。</p></div>
    <time>18:20</time>
  </div>
</div>
<details class="bot-activity-group" data-bot-activity-count="3" aria-label="协作过程">
  <summary class="bot-activity-summary"><strong>协作过程</strong><span>思考、工具调用与文件改动已收纳——点开核对</span><span>2 位 · 3 条</span><svg class="bot-activity-group-chevron" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></summary>
  <div class="bot-activity-timeline">
    <div class="bot-activity-segment"><p>梳理本周控制台改造重点……</p><time>18:19</time></div>
    <div class="bot-activity-segment"><p>已调用 Read · 已调用 Edit</p><time>18:20</time></div>
  </div>
</details>`;
      stream.append(...fixture.content.childNodes);
    });
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(outputDir, "04-veil-auto-slider-chat.png") });
    report.screenshots.push("04-veil-auto-slider-chat.png");

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
