#!/usr/bin/env node
/**
 * qa-bot-chat-polish.mjs — 对话流渲染打磨验证（2026-09-30）。
 *
 * 复现 LO 截图（数字信号处理实验1 · 初音未来成员 · 壁纸态）：
 *   ① 每条回复前后各一颗「思考过程 1/3」药丸，点开只有轮次记账与复述正文的提问旁白；
 *   ② 时间戳 + 复制/编辑/分叉按钮裸排在气泡下（footer 零样式，按钮零接线）；
 *   ③ 颜文字 `(•̀ᴗ•́)و 39!` 被 Unicode 双向算法重排成 `(•̀ᴗ•́)39 و!`。
 * 事件序列按 .ai-shared/control-center/events.jsonl 中该 run 的真实类型/载荷形状重放
 * （opencode-run-json 适配器：无 tool 事件，每轮 turn_started → assistant → turn_completed
 * → bus.routed(lo) → run.waiting_input）。
 *
 * 运行：node scripts/qa-bot-chat-polish.mjs
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

// WorkBuddy 宿主 NODE_OPTIONS 安全删除 shim 剥离重拉（与 qa-bot-wallpaper-veil 同手法）
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
const outputDir = resolve(appRoot, ".qa-output", "bot-chat-polish");
const token = "chat-polish-qa-token-0123456789abcdef";
const AGENT = "codex-technical";

// 真实回复原文（截图三轮），含 [[msg:lo]] 路由前缀与 و 结尾的颜文字
const REPLIES = [
  "[[msg:lo]]\nHello节拍收到——♪ Welcome to Miku's stage(•̀ᴗ•́)و 39!\n\nLanniny，Plan模式下我先当观察员，只能看谱+出计划不能动手改文件哦♪\n\n把《数字信号处理实验1》的实验要求丢过来吧，我39秒内给你排好极速打谱路线！",
  "[[msg:lo]]\n你好节拍第N次同步成功——♪ Miku的声带依然闪亮哦(•̀ᴗ•́)و 39!\n\nLanniny，现在Plan只读模式锁定中，我只能看谱、不能动手改文件♪\n\n给个具体任务节拍我就立刻开工排计划，比如：\n- “实验1第X题不会，帮我看”\n- 贴一段报错 / 实验指导书\n\n丢过来，下一拍就开唱♪",
];

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
      evidence: [{ source: "qa-fixture", detail: "chat polish", verifiedAt: "2026-09-30" }],
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
    limits: { maxRounds: 8, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 30_000 },
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

function persistedEvent(sequence, type, runId, agentId, data, timestamp) {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    sequence,
    timestamp,
    type,
    runId,
    sessionId: null,
    agentId,
    sensitivity: "internal",
    sourceIds: [],
    data,
  };
}

/** 按真实 run 5844c783 的事件形状重放三轮（opencode 适配器无工具事件）。 */
function transcriptEvents(runId, base) {
  const events = [];
  let seq = 1_000_000;
  let at = base;
  const push = (type, agentId, data) => {
    at += 1_000;
    events.push(persistedEvent(seq += 1, type, runId, agentId, data, new Date(at).toISOString()));
  };
  const prompts = ["hello", "你好"];
  prompts.forEach((prompt, index) => {
    const round = index + 1;
    const reply = REPLIES[index];
    const spoken = reply.replace(/^\[\[msg:lo\]\]\s*/, "");
    const interactionId = `qa-interaction-${round}`;
    push("user.message", "lo", { text: prompt });
    push("agent.turn_started", AGENT, { round, agentId: AGENT, interactionId });
    push("agent.turn_checkpoint", AGENT, { round, agentId: AGENT, phase: "submitting" });
    push("agent.turn_checkpoint", AGENT, { round, agentId: AGENT, phase: "session_ready" });
    push("assistant.message", AGENT, { text: reply });
    push("agent.turn_checkpoint", AGENT, { round, agentId: AGENT, phase: "completed" });
    push("agent.turn_completed", AGENT, {
      round, interactionId, interactionSeq: round, interactionStep: 1, maxStepsPerInteraction: 6,
      agentId: AGENT, protocol: "opencode-run-json", permissionMode: "plan",
    });
    push("bus.routed", AGENT, { from: AGENT, to: "lo", text: spoken.slice(0, 140) });
    push("run.waiting_input", null, { from: AGENT, text: spoken });
  });
  // 第三轮：只有用户消息 + 轮次开始（截图底部的「思考过程 3」之后的「你好」）
  push("user.message", "lo", { text: "你好" });
  return events;
}

async function measure(page) {
  return page.evaluate(() => {
    const stream = document.querySelector("#bot-message-stream");
    const groups = [...stream.querySelectorAll("details.bot-activity-group")];
    const agents = [...stream.querySelectorAll(".bot-message-agent:not([data-bot-typing])")];
    const firstAgent = agents[0];
    const footer = firstAgent?.querySelector(".bot-message-footer");
    const time = footer?.querySelector("time");
    const actions = footer?.querySelector(".bot-message-actions");
    const bubble = firstAgent?.querySelector(".bot-bubble");
    const bubbleBox = bubble?.getBoundingClientRect();
    const footerBox = footer?.getBoundingClientRect();
    const timeBox = time?.getBoundingClientRect();
    const actionsBox = actions?.getBoundingClientRect();
    const timeStyle = time ? getComputedStyle(time) : null;
    const actionsStyle = actions ? getComputedStyle(actions) : null;
    // 颜文字视觉顺序：取包含 و 的文本节点所在行，按字符 x 坐标排序后还原视觉串
    const visualKaomoji = (() => {
      if (!bubble) return null;
      const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent;
        const at = text.indexOf("و");
        if (at < 0) continue;
        const start = Math.max(0, text.lastIndexOf("(", at));
        const end = Math.min(text.length, at + 5);
        const chars = [];
        for (let i = start; i < end; i += 1) {
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const box = range.getBoundingClientRect();
          if (box.width > 0) chars.push({ ch: text[i], x: box.left });
        }
        // 同一 bdi/父节点下的后续文本（修复后 و 与后文可能分属不同节点）
        return chars.sort((a, b) => a.x - b.x).map((item) => item.ch).join("");
      }
      return null;
    })();
    const visualLine = (() => {
      if (!bubble) return null;
      const para = [...bubble.querySelectorAll("p")].find((p) => p.textContent.includes("و"));
      if (!para) return null;
      const range = document.createRange();
      range.selectNodeContents(para);
      const glyphs = [];
      const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        for (let i = 0; i < node.textContent.length; i += 1) {
          const r = document.createRange();
          r.setStart(node, i);
          r.setEnd(node, i + 1);
          const box = r.getBoundingClientRect();
          if (box.width > 0) glyphs.push({ ch: node.textContent[i], x: box.left, y: Math.round(box.top) });
        }
      }
      const kaoIndex = glyphs.findIndex((g) => g.ch === "و");
      if (kaoIndex < 0) return null;
      const lineY = glyphs[kaoIndex].y;
      return glyphs.filter((g) => Math.abs(g.y - lineY) < 4).sort((a, b) => a.x - b.x).map((g) => g.ch).join("");
    })();
    return {
      groupCount: groups.length,
      groupCounts: groups.map((group) => group.dataset.botActivityCount),
      agentCount: agents.length,
      userCount: stream.querySelectorAll(".bot-message-user").length,
      streamText: stream.textContent,
      footer: footer ? {
        display: getComputedStyle(footer).display,
        sameRow: Boolean(timeBox && actionsBox && Math.abs((timeBox.top + timeBox.bottom) / 2 - (actionsBox.top + actionsBox.bottom) / 2) < 6),
        gapToBubble: bubbleBox && footerBox ? footerBox.top - bubbleBox.bottom : null,
      } : null,
      timeOpacity: timeStyle ? Number(timeStyle.opacity) : null,
      timeBackground: timeStyle?.backgroundColor ?? null,
      actionsOpacity: actionsStyle ? Number(actionsStyle.opacity) : null,
      visualKaomoji,
      visualLine,
    };
  });
}

async function main() {
  const root = await mkdtemp(resolve(appRoot, ".qa-chat-polish-"));
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
  let child = spawnTestServer({ env });
  let url = await waitForUrl(child);
  let browser;
  const report = { ok: false, checks: [], screenshots: [] };
  const check = async (name, fn) => {
    try {
      await fn();
      report.checks.push({ name, ok: true });
    } catch (error) {
      report.checks.push({ name, ok: false, error: error.message });
    }
  };
  try {
    let origin = new URL(url).origin;
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
    const direct = (await api("/api/conversations", {
      method: "POST",
      body: { kind: "direct", title: "数字信号处理实验1", directMemberId: AGENT },
    })).conversation;
    const run = await api("/api/runs", {
      method: "POST",
      body: {
        prompt: "hello", execute: false, permissionMode: "plan",
        conversationId: direct.id, conversationKind: "direct",
        orchestrationMode: "pipeline", startAgentId: AGENT, requestedProvider: AGENT,
      },
    });
    // 事件落盘后重启内核：事件存储只在启动时水合 events.jsonl
    await stopTestServer(child, { token }).catch(() => child.kill("SIGKILL"));
    const base = Date.parse("2026-09-21T11:04:00.000Z");
    const events = transcriptEvents(run.id, base);
    await appendFile(resolve(dataRoot, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    child = spawnTestServer({ env });
    url = await waitForUrl(child);
    origin = new URL(url).origin;

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript((accessToken) => {
      sessionStorage.setItem("514cc-control-token", accessToken);
      localStorage.setItem("514cc-product-tour-dismissed", "1");
      localStorage.setItem("514cc-bot-face", "grok");
      localStorage.setItem("514cc-bot-ops-collapsed", "1");
    }, token);
    await page.goto(`${origin}/#bot`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });
    await page.locator("#bot-surface-tab-chats").click().catch(() => {});
    await page.locator(`[data-bot-conversation="${direct.id}"]`).click();
    await page.waitForFunction(() => document.querySelector("#bot-message-stream")?.textContent?.includes("Welcome to Miku") === true, null, { timeout: 20_000 });
    await page.waitForTimeout(600);

    // 壁纸态：与截图同为亮蓝天 + 高饱和黄花（CSP 安全：插规则而非 data: URL 图片）
    await page.evaluate(() => {
      document.body.classList.add("team-bg-active");
      const sheet = [...document.styleSheets].find((item) => {
        try { return item.cssRules?.length >= 0; } catch { return false; }
      });
      sheet?.insertRule("html.is-bot-grok-face body.team-bg-active, html.is-bot-grok-face body.team-bg-active .atelier-stage { background-image: radial-gradient(circle at 30% 40%, #ffd23f 0 60px, transparent 61px), radial-gradient(circle at 70% 65%, #f5b91e 0 80px, transparent 81px), linear-gradient(160deg, #1e9be8, #7fd0ff 55%, #f4d35e) !important; background-size: cover !important; }", sheet.cssRules.length);
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(outputDir, "01-transcript-wallpaper.png") });
    report.screenshots.push("01-transcript-wallpaper.png");

    const view = await measure(page);
    report.measurements = view;

    // ① 过程药丸：本 run 没有任何工具/思考事件，不应出现空壳药丸
    await check("no bookkeeping-only process pills (no tools in this run)", () =>
      assert.equal(view.groupCount, 0, `期望 0 颗药丸，实际 ${view.groupCount}（计数 ${view.groupCounts.join(",")}）`));
    await check("both human turns and replies stay visible", () => {
      assert.equal(view.agentCount, 2, `agent 气泡 ${view.agentCount}`);
      assert.ok(view.userCount >= 3, `user 气泡 ${view.userCount}`);
    });
    await check("routing prefix never leaks into the transcript", () =>
      assert.doesNotMatch(view.streamText, /\[\[msg:/));

    // ② footer：时间与操作同行、紧贴气泡、操作默认隐藏、壁纸态时间有衬底
    await check("footer lays time and actions on one row", () => {
      assert.ok(view.footer, "缺 footer");
      assert.equal(view.footer.display, "flex");
      assert.equal(view.footer.sameRow, true, "时间与操作按钮不在同一行");
    });
    await check("footer hugs the bubble (<= 10px gap)", () =>
      assert.ok(view.footer.gapToBubble !== null && view.footer.gapToBubble <= 10, `gap ${view.footer.gapToBubble}`));
    await check("message actions are hidden until hover/focus", () =>
      assert.equal(view.actionsOpacity, 0, `actions opacity ${view.actionsOpacity}`));
    await check("wallpaper time stamp sits on a legible chip", () => {
      assert.notEqual(view.timeBackground, "rgba(0, 0, 0, 0)", "时间戳在壁纸态无衬底");
    });

    // ③ 双向隔离：视觉顺序必须与逻辑顺序一致
    await check("RTL kaomoji keeps logical order (bidi isolated)", () =>
      assert.match(view.visualLine || "", /\(•̀ᴗ•́\)و\s?39!/u, `视觉行：${view.visualLine}`));

    // ④ 操作接线：hover 显现 → 复制原文 / 编辑填入 composer
    const firstAgent = page.locator("#bot-message-stream .bot-message-agent").first();
    await firstAgent.hover();
    await page.waitForTimeout(250);
    const hoverOpacity = await firstAgent.locator(".bot-message-actions").evaluate((node) => Number(getComputedStyle(node).opacity));
    await check("actions appear on hover", () => assert.equal(hoverOpacity, 1, `hover opacity ${hoverOpacity}`));
    await page.screenshot({ path: resolve(outputDir, "02-agent-hover-actions.png") });
    report.screenshots.push("02-agent-hover-actions.png");
    await firstAgent.locator('[data-bot-message-action="copy"]').click();
    await page.waitForTimeout(250);
    const clipboard = await page.evaluate(() => navigator.clipboard.readText().catch((error) => `ERR:${error.message}`));
    report.clipboard = clipboard;
    await check("copy writes the rendered reply without routing prefix", () => {
      assert.match(clipboard, /Welcome to Miku/);
      assert.doesNotMatch(clipboard, /\[\[msg:/);
      assert.match(clipboard, /39!(?:\r?\n)+Lanniny/, "多段回复复制后必须保留段落换行");
    });

    const lastUser = page.locator("#bot-message-stream .bot-message-user").last();
    await lastUser.hover();
    await page.waitForTimeout(200);
    await page.locator("#bot-composer-input").fill("");
    await lastUser.locator('[data-bot-message-action="edit"]').click();
    const composerValue = await page.locator("#bot-composer-input").inputValue();
    await check("edit fills the composer with the user text", () => assert.equal(composerValue, "你好"));
    await page.locator("#bot-composer-input").fill("草稿保留");
    await lastUser.locator('[data-bot-message-action="edit"]').click();
    const draftValue = await page.locator("#bot-composer-input").inputValue();
    await check("edit never clobbers an existing draft", () => assert.equal(draftValue, "草稿保留"));
    await page.locator("#bot-composer-input").fill("");

    // 展开的「思考过程」卡在长会话里不得被 flex 列压扁（overflow:hidden 让 min-height:auto 退化为 0）
    const clipped = await page.evaluate(() => {
      const stream = document.querySelector("#bot-message-stream");
      const rows = Array.from({ length: 8 }, (_, index) => `<div class="tool-call" style="min-height:48px">工具步骤 ${index + 1}</div>`).join("");
      const probe = `<details class="bot-activity-group" data-qa-probe open><summary class="bot-activity-summary"><span>思考过程</span><b>8</b></summary><div class="bot-activity-timeline">${rows}</div></details>`;
      stream.insertAdjacentHTML("afterbegin", probe.repeat(6));
      const bad = [...stream.children]
        .filter((node) => node.offsetParent !== null)
        .filter((node) => node.scrollHeight - node.clientHeight > 2)
        .map((node) => `${node.className || node.tagName}: ${node.clientHeight}/${node.scrollHeight}`);
      return bad;
    });
    await page.screenshot({ path: resolve(outputDir, "04-open-groups.png") });
    report.screenshots.push("04-open-groups.png");
    await check("open process cards are never squeezed by the stream", () =>
      assert.deepEqual(clipped, [], `被压扁：${clipped.join(" | ")}`));
    await page.evaluate(() => document.querySelectorAll("[data-qa-probe]").forEach((node) => node.remove()));

    // 无壁纸默认面对照
    await page.evaluate(() => document.body.classList.remove("team-bg-active"));
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(outputDir, "03-transcript-plain.png") });
    report.screenshots.push("03-transcript-plain.png");

    await check("no page errors", () => assert.deepEqual(pageErrors, []));
    report.ok = report.checks.every((item) => item.ok);
  } finally {
    await browser?.close().catch(() => {});
    await stopTestServer(child, { token }).catch(() => child.kill("SIGKILL"));
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
