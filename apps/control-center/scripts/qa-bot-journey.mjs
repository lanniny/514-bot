#!/usr/bin/env node
/**
 * qa-bot-journey.mjs — 市场化收口：首访→创建项目→发消息→过程/成果 的端到端走查。
 *
 * 两视口（desktop-1280 / tablet-1024）各自使用全新 fixture（真首访语义）。
 * 断言边界：本 QA 是隔离内核浏览器走查，不含真实 provider——fixture profiles 的
 * command 覆盖为不存在的二进制，run 因 adapter 不可用进入 recovery_required，
 * 断言 UI 如实呈现恢复态（而不是伪装成功）。真实 provider 端到端属于 W2-1 独立授权门。
 *
 * 运行：node scripts/qa-bot-journey.mjs
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

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
const outputDir = resolve(appRoot, ".qa-output", "bot-journey");
const token = "bot-journey-qa-token-0123456789";
const JOURNEY_PROMPT = "JOURNEY_PROBE 请汇总首访旅程项目的目录结构";
const VIEWPORTS = [
  { name: "desktop-1280", width: 1280, height: 800 },
  // 中等桌面：右栏是覆盖层，首访旅程必须在该布局下同样走得通。
  { name: "tablet-1024", width: 1024, height: 900 },
];

async function writeConfig(repoRoot) {
  await mkdir(resolve(repoRoot, "config/control-center"), { recursive: true });
  await writeFile(resolve(repoRoot, "config/app.json"), '{"enabled":true}\n');
  // command 指向不存在的二进制：保证 run 绝不触达真实 CLI/provider（隔离红线）。
  await writeFile(resolve(repoRoot, "config/control-center/models.json"), JSON.stringify({
    version: 1,
    profiles: testModelProfiles().map((profile, index) => ({
      ...profile,
      enabled: true,
      command: `missing-cli-${index}`,
      capabilities: ["*"],
      quality: 0.95 - index * 0.01,
      speed: 0.8,
      costTier: 2,
      evidence: [{ source: "qa-journey-fixture", detail: "首访旅程走查", verifiedAt: "2026-09-13" }],
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

function measureOverflow() {
  const doc = document.documentElement;
  const innerWidth = window.innerWidth;
  const selectors = ["#view-bot", "#bot-composer-form", "#bot-message-stream", "#workspace-insights"];
  const surfaces = selectors.map((selector) => {
    const el = document.querySelector(selector);
    if (!el || el.hidden || el.getAttribute("hidden") !== null) return { selector, skipped: true, overflow: 0 };
    return {
      selector,
      skipped: false,
      overflow: Math.max(0, el.scrollWidth - el.clientWidth),
      rightBleed: Math.max(0, Math.ceil(el.getBoundingClientRect().right - innerWidth - 1)),
    };
  });
  return {
    innerWidth,
    documentOverflow: Math.max(0, doc.scrollWidth - innerWidth, document.body.scrollWidth - innerWidth),
    surfaces,
  };
}

async function walkProductTour(page) {
  // 真首访：导览应自动弹出；按真实用户方式走完（下一步…完成）。
  const dialog = page.locator("#bot-product-tour-dialog");
  try {
    await dialog.waitFor({ state: "visible", timeout: 8_000 });
  } catch {
    return { autoOpened: false, steps: 0 };
  }
  let clicks = 0;
  while (clicks < 12) {
    const state = await dialog.evaluate((el) => ({ open: el.open ?? el.hidden !== true, next: el.querySelector("[data-product-tour-next]")?.textContent?.trim() ?? "" }));
    if (!state.open) break;
    await dialog.locator("[data-product-tour-next]").click();
    clicks += 1;
    if (state.next === "完成") break;
    await page.waitForTimeout(150);
  }
  await dialog.waitFor({ state: "hidden", timeout: 8_000 }).catch(() => {});
  const stillOpen = await dialog.evaluate((el) => el.open === true).catch(() => false);
  assert.ok(!stillOpen, "product tour should be dismissed after completing it");
  return { autoOpened: true, steps: clicks };
}

async function walkJourney(page, viewport, { repoRoot, outputDir: shots }) {
  const result = { viewport: viewport.name, screenshots: [] };
  const shot = async (name) => {
    const file = `${name}.png`;
    await page.screenshot({ path: resolve(shots, file), fullPage: false });
    result.screenshots.push(file);
  };

  // ── 第 1 步：首访（Bot 面）。导览走完；首页空态带就绪卡，空态 CTA 给出可执行下一步。──
  result.tour = await walkProductTour(page);
  // 通讯录两条合法首访形态：内置成员投影存在 → 成员行可见；成员目录为空 →
  // 空态必须给出「添加成员」CTA。不允许既无成员行又无 CTA 的死空态。
  const contactsState = await page.evaluate(() => {
    const empty = document.querySelector("#bot-contact-empty");
    const rows = document.querySelectorAll("#bot-contact-list [data-bot-contact-row]").length;
    const emptyVisible = Boolean(empty) && empty.hidden !== true;
    return {
      rows,
      emptyVisible,
      emptyAction: emptyVisible ? Boolean(empty.querySelector('[data-bot-empty-action="new-member"]')) : false,
    };
  });
  assert.ok(
    contactsState.rows > 0 || (contactsState.emptyVisible && contactsState.emptyAction),
    `contacts surface has neither member rows nor an actionable empty state: ${JSON.stringify(contactsState)}`,
  );
  // 顶部两个入口不再共用同一个加号：项目/成员各有图标与短标签（市场化空态收口）。
  const toolbar = await page.evaluate(() => ({
    project: document.querySelector("#bot-new-group-button .bot-action-label")?.textContent?.trim() ?? "",
    member: document.querySelector("#bot-new-member-button .bot-action-label")?.textContent?.trim() ?? "",
  }));
  assert.equal(toolbar.project, "新项目", `unexpected project entry label: ${toolbar.project}`);
  assert.equal(toolbar.member, "成员", `unexpected member entry label: ${toolbar.member}`);
  const rosterEmpty = page.locator('#bot-roster-empty [data-bot-empty-action="new-project"]');
  await rosterEmpty.waitFor({ state: "visible", timeout: 10_000 });
  await shot("1-first-visit");

  // ── 第 1.5 步：首访就绪卡（Bot 面首页态——就绪卡的家在 Bot 空态 hero，
  // 不是已退休的协作台欢迎页）。真实步骤 + 未完成项的真实入口，
  // 且入口必须真的导航（readiness.next-action 链路端到端）。──
  await page.waitForFunction(() => {
    const card = document.querySelector("#bot-message-stream .bot-empty-hero .readiness-card");
    return Boolean(card) && card.classList.contains("is-loading") === false;
  }, null, { timeout: 20_000 });
  const readiness = await page.evaluate(() => {
    const card = document.querySelector("#bot-message-stream .bot-empty-hero .readiness-card");
    return {
      state: card?.dataset.readinessState ?? "",
      steps: [...(card?.querySelectorAll("[data-readiness-step]") ?? [])].map((el) => el.dataset.readinessStep),
      actions: [...(card?.querySelectorAll("[data-readiness-action]") ?? [])].map((el) => el.dataset.readinessAction),
    };
  });
  assert.ok(readiness.steps.length >= 1, `readiness card has no steps: ${JSON.stringify(readiness)}`);
  assert.ok(["ready", "pending"].includes(readiness.state), `readiness state unexpected: ${readiness.state}`);
  assert.ok(readiness.actions.length >= 1, "readiness card offers no next-action entry");
  // 中等视口下右栏是可覆盖面板：先按真实用户方式用面板内关闭钮收起，再点就绪卡动作。
  await page.evaluate(() => {
    const close = document.querySelector("#bot-agent-panel-close");
    const panel = document.querySelector("#bot-agent-panel");
    if (close && panel && panel.hidden !== true) close.click();
  });
  await page.waitForTimeout(350);
  await page.locator(".assistant-readiness > summary").click();
  await shot("1-first-visit-readiness");
  await page.locator("#bot-message-stream .bot-empty-hero .readiness-card [data-readiness-action]").first().click();
  await page.waitForFunction(() => document.querySelector("#view-bot")?.classList?.contains("is-active") !== true, null, { timeout: 15_000 });
  const readinessLanding = await page.evaluate(() => ({
    activeView: [...document.querySelectorAll(".view.is-active")].map((el) => el.id),
  }));
  assert.ok(readinessLanding.activeView.length >= 1 && !readinessLanding.activeView.includes("view-bot"),
    `readiness action did not navigate: ${JSON.stringify(readinessLanding)}`);
  await shot("1-readiness-action-navigated");
  result.readiness = readiness;
  // 回到 Bot 面继续旅程主体（hash 导航，不依赖当前视图下侧栏按钮的可见性）。
  await page.evaluate(() => { location.hash = "#bot"; });
  await page.waitForFunction(() => document.querySelector("#view-bot")?.classList?.contains("is-active") === true, null, { timeout: 15_000 });

  // ── 第 2 步：新建项目（空态 CTA → 群对话框）。──
  await rosterEmpty.click();
  await page.waitForSelector("#bot-group-dialog:not([hidden])", { timeout: 10_000 });
  await page.fill("#bot-group-name", "首访旅程项目");
  // 目录选择器是本机原生 UI（Windows FolderBrowserDialog），浏览器走查只覆盖表单链路：
  // 与提交处理器同语义地写入 readonly 输入框值。
  await page.evaluate((path) => {
    const input = document.querySelector("#bot-group-cwd");
    input.value = path;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, repoRoot);
  await page.locator('#bot-group-member-list input[type="checkbox"][value="claude-fable"]').check();
  const submitLabel = (await page.locator("#bot-group-submit").textContent()).trim();
  assert.equal(submitLabel, "创建项目", `unexpected submit label: ${submitLabel}`);
  await shot("2-project-dialog");
  await page.locator("#bot-group-submit").click();
  await page.locator("#bot-group-dialog").waitFor({ state: "hidden", timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector("#workspace-project")?.textContent?.includes("首访旅程项目") === true, null, { timeout: 20_000 });
  const projectAnchor = await page.evaluate(() => ({
    title: document.querySelector("#workspace-project")?.textContent?.trim() ?? "",
    path: document.querySelector("#workspace-path")?.textContent?.trim() ?? "",
    rosterHasProject: [...document.querySelectorAll("#bot-project-tree [data-bot-project-node], #bot-project-tree [data-bot-project-toggle]")]
      .some((el) => el.textContent.includes("首访旅程项目")),
  }));
  assert.ok(projectAnchor.rosterHasProject, `project node missing from roster: ${JSON.stringify(projectAnchor)}`);
  assert.ok(projectAnchor.path.length > 0, "project anchor path empty");
  const projectConversationId = await page.evaluate(() => document.querySelector("#bot-project-tree [data-bot-conversation].is-active")?.dataset.botConversation || "");
  assert.ok(projectConversationId, "created project conversation did not become active");
  await shot("2-project-created");

  // ── 第 3 步：发消息。composer 提交 → 准入受理 → 用户消息入流。──
  await page.fill("#bot-composer-input", JOURNEY_PROMPT);
  await page.locator("#bot-composer-form .bot-send-button, #bot-composer-form button[type='submit']").first().click();
  await page.waitForFunction(() => /已受理/.test(document.querySelector("#workspace-admission")?.textContent ?? ""), null, { timeout: 20_000 });
  await page.waitForFunction((prompt) => document.querySelector("#bot-message-stream")?.textContent?.includes(prompt), JOURNEY_PROMPT, { timeout: 20_000 });
  await shot("3-message-sent");

  // ── 第 4 步：失败如实呈现。fixture 无 provider，run 进 recovery_required，
  // UI 只在顶部恢复条提供唯一决策入口（确认恢复并继续），不得伪装成进行中或成功。
  // isVisible() 校验完整可见链；输入区旧锚点必须继续隐藏，避免上下两套状态冲突。──
  const recoveryVisible = await (async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await page.locator('#recovery-bar:not([hidden]) [data-recovery-ack]').isVisible().catch(() => false)) return true;
      await page.waitForTimeout(1_000);
    }
    return false;
  })();
  assert.ok(recoveryVisible, `recovery ack entry not visible for recovery_required run: ${JSON.stringify({
    recoveryBar: await page.evaluate(() => {
      const bar = document.querySelector("#recovery-bar");
      const button = bar?.querySelector("[data-recovery-ack]");
      return { hidden: bar?.hidden ?? null, buttonVisible: Boolean(button) && getComputedStyle(button).display !== "none" };
    }).catch(() => null),
    legacyButton: await page.evaluate(() => {
      const button = document.querySelector("#bot-recovery-ack");
      const chain = [];
      let node = button;
      while (node && node !== document.body) {
        chain.push(`${node.id || node.tagName}${node.hidden ? "[hidden]" : ""}${getComputedStyle(node).display === "none" ? "{display:none}" : ""}`);
        node = node.parentElement;
      }
      return { hidden: button?.hidden ?? null, chain: chain.slice(0, 8) };
    }).catch(() => null),
    runState: await page.evaluate(() => document.querySelector("#bot-run-state")?.textContent ?? "").catch(() => ""),
  })}`);
  await shot("4-recovery-honest");
  await page.waitForFunction(() => {
    const label = document.querySelector("#bot-project-tree [data-bot-conversation].is-active [data-bot-conversation-status]")?.textContent;
    return label === "需恢复" || label === "待确认";
  }, null, { timeout: 10000 });
  assert.ok(await page.locator("#bot-roster-label").textContent().then((text) => text.includes("待处理")));

  // 恢复条归属回归：切到另一个会话时顶部条必须立即消失，切回原会话后再出现；
  // 输入区旧锚点始终隐藏，页面只保留一个可见的确认动作。
  await page.locator("#bot-surface-tab-contacts").click();
  const contactChat = page.locator("#bot-contact-list [data-bot-contact-chat]").first();
  await contactChat.waitFor({ state: "visible", timeout: 10_000 });
  await contactChat.click();
  await page.waitForFunction((previousId) => {
    const active = document.querySelector("#bot-project-tree [data-bot-conversation].is-active");
    return Boolean(active?.dataset.botConversation) && active.dataset.botConversation !== previousId;
  }, projectConversationId, { timeout: 15_000 });
  const switchedRecovery = await page.evaluate(() => ({
    barHidden: document.querySelector("#recovery-bar")?.hidden !== false,
    legacyHidden: document.querySelector("#bot-recovery-ack")?.hidden === true,
    visibleActions: document.querySelectorAll('#recovery-bar:not([hidden]) [data-recovery-ack]').length,
  }));
  assert.equal(switchedRecovery.barHidden, true, `recovery bar leaked into another conversation: ${JSON.stringify(switchedRecovery)}`);
  assert.equal(switchedRecovery.legacyHidden, true, "legacy composer recovery anchor must stay hidden");
  assert.equal(switchedRecovery.visibleActions, 0, "another conversation must not expose a stale recovery action");

  await page.locator("#bot-surface-tab-chats").click();
  await page.locator(`[data-bot-conversation="${projectConversationId}"]`).click();
  await page.waitForSelector('#recovery-bar:not([hidden]) [data-recovery-ack]', { timeout: 15_000 });
  const returnedRecovery = await page.evaluate(() => ({
    barVisible: document.querySelector("#recovery-bar")?.hidden === false,
    visibleActions: document.querySelectorAll('#recovery-bar:not([hidden]) [data-recovery-ack]').length,
    legacyHidden: document.querySelector("#bot-recovery-ack")?.hidden === true,
  }));
  assert.equal(returnedRecovery.barVisible, true, `recovery bar did not return with its conversation: ${JSON.stringify(returnedRecovery)}`);
  assert.equal(returnedRecovery.visibleActions, 1, "the active recovery conversation must expose one confirmation action");
  assert.equal(returnedRecovery.legacyHidden, true, "legacy composer recovery anchor must stay hidden after return");

  // ── 第 5 步：过程/成果页签 + 运行历史。──
  // D-2026-09-28-021 起默认面（grok）不再藏 .workspace-view-bar——页签是导航、
  // 运行历史是唯一回溯入口，藏掉等于锁死协作面板（详见 bot-grok-face.css 该处注释）。
  // 本步保留切协作台 face 的走法：断言在"非默认面也仍然有效"这层意义上继续保值，
  // 同时下方补一条默认面断言，把"默认面可达"钉死不退化成新的隐藏面。
  await page.evaluate(() => localStorage.setItem("514cc-bot-face", "workbench"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector("#view-bot")?.classList?.contains("is-active") === true, null, { timeout: 15_000 });
  await page.locator("#workspace-tab-process").click();
  await page.waitForFunction(() => document.querySelector("#workspace-tab-process")?.getAttribute("aria-selected") === "true", null, { timeout: 10_000 });
  await page.waitForSelector("#workspace-insights:not([hidden])", { timeout: 10_000 });
  await shot("5-process-tab");
  await page.locator('#bot-composer-overflow [data-workspace-tab="results"]').click();
  await page.waitForFunction(() => document.querySelector("#workspace-tab-results")?.getAttribute("aria-selected") === "true", null, { timeout: 10_000 });
  await page.waitForSelector("#workspace-insights:not([hidden])", { timeout: 10_000 });
  const outcomes = await page.evaluate(() => ({
    runOptions: [...document.querySelectorAll("#workspace-run-select option")].map((option) => option.value),
    currentState: document.querySelector("#workspace-current-state")?.textContent?.trim() ?? "",
  }));
  assert.ok(outcomes.runOptions.length >= 2, `run history select missing the journey run: ${JSON.stringify(outcomes)}`);
  assert.ok(outcomes.currentState.length > 0, "workspace current-state text empty");
  // 默认面（grok）可达性回归：切回默认 face 后页签 + 运行历史必须仍然在 DOM 里可见。
  // 这条是 D-2026-09-28-021 产品修复的钉子——曾整条 display:none，默认面锁死协作面板。
  await page.evaluate(() => localStorage.setItem("514cc-bot-face", "grok"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#view-bot")?.classList?.contains("is-active") === true, null, { timeout: 15_000 });
  // D-2026-09-28-023：这里原写 #workspace-view-bar——**该 id 从未存在过**。
  // index.html:506 原文是 `<div class="workspace-view-bar">`（只有 class 无 id）；全项目零处
  // JS 引用它，CSS（bot-workspace.css:251 / bot-grok-face.css:349）与迁移后仍可见的子元素
  // （#workspace-tab-process / #workspace-run-select）都用类或子 id。实测 docIdCount 1489、
  // 子 id 均正常——并非 id 被剥，是选择器从一开始就指着一个不存在的 id。改用类选择器，
  // 与产品实际的样式钩子一致。
  await page.waitForSelector(".workspace-view-bar:visible", { timeout: 10_000 });
  await page.waitForSelector("#workspace-tab-process:visible", { timeout: 10_000 });
  await page.waitForSelector("#workspace-run-select:visible", { timeout: 10_000 });
  await page.locator("#workspace-tab-process").click();
  await page.waitForFunction(() => document.querySelector("#workspace-insights")?.hidden === false, null, { timeout: 10_000 });
  await shot("5-process-tab-default-face");
  // D-2026-09-28-023：这里原写 report.defaultFaceReachesProcessTab——`report` 在 walkJourney
  // 作用域里不存在（本函数的出口是 return result，由 runViewport 的 Object.assign(report, journey)
  // 合并）。此前脚本每轮都在上一行的 waitForSelector 超时中止，从没走到这一行，所以这颗
  // ReferenceError 一直被掩盖着。改成写进 result。
  result.defaultFaceReachesProcessTab = true;
  await shot("5-results-tab");

  const overflow = await page.evaluate(measureOverflow);
  assert.equal(overflow.documentOverflow, 0, `${viewport.name} page overflow: ${JSON.stringify(overflow)}`);
  for (const surface of overflow.surfaces) {
    if (surface.skipped) continue;
    assert.ok(surface.overflow <= 8, `${viewport.name} ${surface.selector} overflow ${surface.overflow}`);
  }
  result.overflow = overflow;
  return result;
}

async function runViewport(viewport) {
  const root = await mkdtemp(resolve(appRoot, ".qa-bot-journey-"));
  const repoRoot = resolve(root, "repo");
  const dataRoot = resolve(root, "data");
  const fakeHome = resolve(root, "home");
  await writeConfig(repoRoot);
  await mkdir(fakeHome, { recursive: true });
  const shots = resolve(outputDir, viewport.name);
  await rm(shots, { recursive: true, force: true });
  await mkdir(shots, { recursive: true });
  const server = {
    child: spawnTestServer({
      env: {
        CONTROL_CENTER_TOKEN: token,
        CONTROL_CENTER_REPO_ROOT: repoRoot,
        CONTROL_CENTER_DATA_DIR: dataRoot,
        CONTROL_CENTER_PORT: "0",
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      },
    }),
    url: null,
  };
  server.url = await waitForUrl(server.child);
  let browser;
  const report = { viewport: viewport.name, ok: false };
  try {
    const origin = new URL(server.url).origin;
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    page.on("pageerror", (error) => { throw error; });
    await page.addInitScript((accessToken) => {
      sessionStorage.setItem("514cc-control-token", accessToken);
    }, token);
    await page.goto(`${origin}/#bot`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });
    const journey = await walkJourney(page, viewport, { repoRoot, outputDir: shots });
    Object.assign(report, journey, { ok: true });
  } finally {
    await browser?.close().catch(() => {});
    await stopTestServer(server.child, { token }).catch((error) => {
      console.error(`[qa-bot-journey] ${viewport.name} shutdown:`, error.message);
    });
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  return report;
}

async function main() {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const report = { ok: false, viewports: [] };
  for (const viewport of VIEWPORTS) {
    const result = await runViewport(viewport);
    report.viewports.push(result);
    console.log(`[${result.viewport}] ok=${result.ok} tour=${JSON.stringify(result.tour)} screenshots=${result.screenshots?.length ?? 0}`);
  }
  report.ok = report.viewports.length === VIEWPORTS.length && report.viewports.every((item) => item.ok);
  await writeFile(resolve(outputDir, "report.json"), JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
