import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ALLOWED_GATE_BLOCKS,
  buildIsolatedServerEnv,
  createIsolatedQaRepo,
  diagnosticsWatcher,
  withDisposableQaRoot,
} from "../qa-team-workspace.mjs";
import { spawnTestServer, stopTestServer, waitForUrl } from "../../tests/server-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const appRoot = resolve(import.meta.dirname, "..");
const defaultOutputDir = resolve(appRoot, ".qa-output", "workbench-environment");
const viewports = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "desktop-1280", width: 1280, height: 800 },
  { name: "tablet-820", width: 820, height: 1180 },
  { name: "mobile-390", width: 390, height: 844 },
];

function parseArgs(argv = process.argv.slice(2)) {
  const output = argv.find((item) => item.startsWith("--output-dir="));
  return { outputDir: output ? resolve(output.slice("--output-dir=".length)) : defaultOutputDir };
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

async function prepareFixture(qaRoot, token) {
  const repoRoot = await createIsolatedQaRepo(qaRoot);
  const remoteRoot = join(qaRoot, "origin.git");
  git(repoRoot, ["init", "-b", "main"]);
  git(repoRoot, ["config", "core.autocrlf", "false"]);
  git(repoRoot, ["config", "user.name", "514cc QA"]);
  git(repoRoot, ["config", "user.email", "qa@514cc.local"]);
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "qa baseline"]);
  git(qaRoot, ["init", "--bare", remoteRoot]);
  git(repoRoot, ["remote", "add", "origin", remoteRoot]);
  git(repoRoot, ["push", "-u", "origin", "main"]);
  await writeFile(join(repoRoot, "ahead.txt"), "ahead\n", "utf8");
  git(repoRoot, ["add", "ahead.txt"]);
  git(repoRoot, ["commit", "-m", "qa ahead"]);
  await writeFile(join(repoRoot, "staged.txt"), "staged\n", "utf8");
  git(repoRoot, ["add", "staged.txt"]);
  const sourcePath = join(repoRoot, "codex-reference.png");
  await writeFile(sourcePath, "reference fixture\n", "utf8");
  const worktreePath = join(qaRoot, `${basename(repoRoot)}-wt-20260807101500-deadbeef`);
  git(repoRoot, ["worktree", "add", "--detach", worktreePath]);
  await writeFile(join(worktreePath, "worktree-only.txt"), "isolated browser fixture\n", "utf8");
  git(worktreePath, ["add", "worktree-only.txt"]);

  const env = buildIsolatedServerEnv({ qaRoot, token, testRepoRoot: repoRoot });
  await Promise.all([
    mkdir(join(env.CONTROL_CENTER_DATA_DIR, "runs"), { recursive: true }),
    mkdir(env.CONTROL_CENTER_RUNTIME_HOME, { recursive: true }),
    mkdir(env.APPDATA, { recursive: true }),
    mkdir(env.LOCALAPPDATA, { recursive: true }),
    mkdir(env.XDG_CONFIG_HOME, { recursive: true }),
    mkdir(env.XDG_DATA_HOME, { recursive: true }),
    mkdir(env.XDG_CACHE_HOME, { recursive: true }),
  ]);

  const runId = "88888888-8888-4888-8888-888888888888";
  const buildRunId = "88888888-8888-4888-8888-888888888889";
  const run = {
    id: runId,
    prompt: "核对协作台环境舱与直接收件人",
    status: "succeeded",
    taskType: "coding",
    orchestrationMode: "social",
    permissionMode: "plan",
    coordinatorId: "claude-fable",
    startAgentId: "codex-technical",
    executionOwnerId: "codex-technical",
    teamId: "team-514cc",
    teamMembers: ["claude-fable", "codex-technical"],
    requestedAgentIds: [],
    cwd: repoRoot,
    sources: [{ kind: "file", path: sourcePath, name: "codex-reference.png" }],
    turns: [],
    turnAttempts: [
      {
        attemptId: "attempt-claude",
        agentId: "claude-fable",
        phase: "completed",
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:01:00.000Z",
      },
      {
        attemptId: "attempt-codex",
        agentId: "codex-technical",
        phase: "completed",
        sourceWorkItemId: "delegated-codex-work",
        createdAt: "2026-08-07T00:01:00.000Z",
        updatedAt: "2026-08-07T00:02:00.000Z",
      },
    ],
    inflightTurns: {},
    round: 2,
    maxRounds: 6,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:02:00.000Z",
    result: "环境舱基线任务",
    error: null,
  };
  await writeFile(join(env.CONTROL_CENTER_DATA_DIR, "runs", `${runId}.json`), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  const buildRun = {
    ...run,
    id: buildRunId,
    prompt: "核对协作台隔离工作树",
    permissionMode: "build",
    worktreePath,
    worktreeBase: repoRoot,
  };
  await writeFile(join(env.CONTROL_CENTER_DATA_DIR, "runs", `${buildRunId}.json`), `${JSON.stringify(buildRun, null, 2)}\n`, "utf8");
  return { env, repoRoot, run, runId, buildRunId };
}

async function runBrowserQa({ bootstrapUrl, origin, token, outputDir, run, runId, buildRunId, repoRoot }) {
  const diagnostics = [];
  const allowedGateBlocks = [];
  const allowedRequestAborts = [];
  const watcher = diagnosticsWatcher(diagnostics, allowedGateBlocks, allowedRequestAborts);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: viewports[0] });
    await context.route("https://example.com/514cc-environment-qa", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>514cc browser QA</title>",
    }));
    const page = await context.newPage();
    await page.addInitScript(() => { try { localStorage.setItem("514cc-product-tour-dismissed", "1"); } catch {} }); // 首跑导览对话框会挡视口点击（D-2026-09-28-018）
    watcher.watchPage(page, "environment");
    await page.addInitScript(() => {
      localStorage.setItem("514cc-mc-collapsed-v2", "0");
      localStorage.setItem("514cc-terminal-collapsed", "1");
    });

    await page.goto(bootstrapUrl, { waitUntil: "domcontentloaded" });
    // D-2026-09-28-021：[data-run-select] 是协作台左栏分区的退役选择器
    // （#workbench-run-list 在 #view-workbench 壳内，该壳已 nav-retired 永久 hidden）。
    // Bot 面的活轨是 #bot-active-runs-list / data-bot-active-run——改用活选择器，
    // 诊断快照同步换成活容器名，否则报错信息永远指向死 DOM。
    try {
      await page.locator(`[data-bot-active-run="${runId}"]`).waitFor({ state: "visible", timeout: 30_000 });
    } catch (cause) {
      const snapshot = await page.evaluate(() => ({
        url: location.href,
        tokenPresent: Boolean(sessionStorage.getItem("514cc-control-token")),
        runCount: document.querySelectorAll("[data-bot-active-run]").length,
        runList: document.getElementById("bot-active-runs-list")?.innerText || "",
        status: document.getElementById("rail-statusline")?.innerText || "",
        toast: document.getElementById("toast-stack")?.innerText || "",
      }));
      throw new Error(`run rail did not render: ${JSON.stringify(snapshot)}; diagnostics=${JSON.stringify(diagnostics)}`, { cause });
    }
    assert.equal(await page.evaluate(() => sessionStorage.getItem("514cc-control-token")), token);
    await page.locator(`[data-bot-active-run="${runId}"]`).click();
    await page.locator("#mission-environment-panel .environment-primary").waitFor({ state: "visible", timeout: 30_000 });

    const environmentResponse = await fetch(`${origin}/api/workbench/environment?runId=${runId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(environmentResponse.status, 200);
    const environment = await environmentResponse.json();
    assert.equal(environment.git.available, true);
    assert.equal(environment.git.ahead, 1);
    assert.equal(environment.git.changes.staged, 1);
    assert.equal(environment.git.changes.untracked, 1);
    assert.equal(environment.sources.items[0].name, "codex-reference.png");

    const buildEnvironmentResponse = await fetch(`${origin}/api/workbench/environment?runId=${buildRunId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(buildEnvironmentResponse.status, 200);
    const buildEnvironment = await buildEnvironmentResponse.json();
    assert.equal(buildEnvironment.workspace.source, "worktree");
    assert.equal(buildEnvironment.git.detached, true);
    assert.equal(buildEnvironment.git.changes.staged, 1);
    for (const action of ["commit", "push"]) {
      const blocked = await fetch(`${origin}/api/workbench/git/plan`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ runId: buildRunId, action, message: action === "commit" ? "blocked" : "" }),
      });
      assert.equal(blocked.status, 422);
      assert.equal((await blocked.json()).error.code, "DETACHED_HEAD");
    }

    await page.locator(`[data-bot-active-run="${buildRunId}"]`).click();
    await page.waitForFunction(() => document.getElementById("mission-environment-panel")?.innerText.includes("detached"));
    assert.match(await page.locator("#mission-environment-panel").innerText(), /当前任务隔离工作树/);
    assert.equal(await page.locator('#mission-environment-panel [data-environment-action="commit"]').isDisabled(), true);
    assert.equal(await page.locator('#mission-environment-panel [data-environment-action="push"]').isDisabled(), true);
    await page.locator(`[data-bot-active-run="${runId}"]`).click();
    await page.waitForFunction(() => document.getElementById("mission-environment-panel")?.innerText.includes("main"));

    const environmentText = await page.locator("#mission-environment-panel").innerText();
    assert.match(environmentText, /main/);
    assert.match(environmentText, /1 暂存/);
    assert.match(environmentText, /1 个委派/);
    assert.match(environmentText, /运行态 stale/);
    assert.match(environmentText, /交付门 blocked/);
    assert.match(environmentText, /准备交付 partial/);
    assert.match(environmentText, /首次就绪未齐/);
    assert.equal(
      await page.locator('[data-environment-expand="first-run"]').getAttribute("aria-expanded"),
      "true",
      "首次就绪必须默认展开，不能藏在首次进入的折叠行里",
    );
    const sourcesGroup = page.locator("#mission-environment-panel .environment-group").filter({ hasText: "来源" });
    // 默认展开态由面板决定，断言必须对折叠默认不敏感：只在收起时才点开，否则会把已展开的组关掉。
    if (!(await sourcesGroup.evaluate((node) => node.open))) await sourcesGroup.locator("summary").click();
    assert.match(await sourcesGroup.innerText(), /codex-reference\.png/);
    assert.equal(await page.locator('#mission-environment-panel [data-environment-action="commit"]').isDisabled(), false);
    assert.equal(await page.locator('#mission-environment-panel [data-environment-action="push"]').isDisabled(), false);

    // 任务工具由右栏标签条的 ➕ 菜单驱动：每次调用都要先展开菜单再点条目
    const invokeTool = async (action) => {
      await page.locator("#rail-tab-add").click();
      await page.locator(`#rail-tool-menu [data-rail-open="${action}"]`).click();
    };


    await page.locator('[data-composer-target="codex-technical"]').click();
    await invokeTool("side-chat");
    await page.locator("#mission-side-chat").waitFor({ state: "visible" });
    assert.match(await page.locator("#mission-side-chat-title").innerText(), /Codex/i);
    await page.locator("#task-input").fill("主输入框同步检查");
    assert.equal(await page.locator("#mission-side-chat-input").inputValue(), "主输入框同步检查");
    await page.locator("#mission-side-chat-input").fill("侧边输入框同步检查");
    assert.equal(await page.locator("#task-input").inputValue(), "侧边输入框同步检查");

    const cliControls = await page.evaluate(() => ({
      target: document.getElementById("composer-target-name")?.textContent?.trim(),
      cli: document.getElementById("composer-target-cli")?.textContent?.trim(),
      modelOptions: document.getElementById("task-model")?.options?.length || 0,
      effortOptions: document.getElementById("task-effort")?.options?.length || 0,
      permissionOptions: document.getElementById("task-permission")?.options?.length || 0,
    }));
    assert.match(cliControls.target, /Codex/i);
    assert.ok(cliControls.modelOptions > 0);
    assert.ok(cliControls.effortOptions > 0);
    assert.ok(cliControls.permissionOptions > 0);

    await page.locator('[data-composer-target="claude-fable"]').click();
    assert.doesNotMatch(await page.locator("#composer-target-name").innerText(), /Codex/i);
    assert.doesNotMatch(await page.locator("#mission-side-chat-title").innerText(), /Codex/i);
    await page.locator('[data-composer-target="codex-technical"]').click();
    assert.match(await page.locator("#mission-side-chat-title").innerText(), /Codex/i);

    let capturedMessage = null;
    await page.route(`**/api/runs/${runId}/messages`, async (route) => {
      capturedMessage = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ run: { ...run, updatedAt: new Date().toISOString() } }),
      });
    });
    await page.locator("#mission-side-chat-form button[type=submit]").click();
    await page.waitForFunction(() => document.getElementById("task-input")?.value === "");
    assert.equal(capturedMessage?.agentId, "codex-technical");
    assert.equal(capturedMessage?.messageIntent, "steer");
    assert.deepEqual(capturedMessage?.requestedAgentIds, undefined);
    await page.unroute(`**/api/runs/${runId}/messages`);

    await page.locator("#mission-side-chat-close").click();
    // 底部抽屉由顶栏角位开关负责；右栏「终端」是另一份独立 PTY 视图。
    await page.locator("#global-terminal-toggle").click();
    await page.locator("#terminal-drawer").waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await page.locator("#terminal-dock").count(), 0); // 旧的常驻折叠条不得回归
    await page.waitForTimeout(400); // 抽屉展开会推挤会话流网格，等布局收敛再交互
    // LO 2026-08-08：终端必须在操作台下方。conversation-pane 的子元素都钉了显式 grid-row，
    // 抽屉一旦丢掉行号就会被 auto-placement 塞进 recovery-bar 隐藏后留下的空位、跑到输入框上方。
    const drawerOrder = await page.evaluate(() => {
      const drawer = document.getElementById("terminal-drawer")?.getBoundingClientRect();
      const composer = document.querySelector(".task-composer")?.getBoundingClientRect();
      return { drawerTop: Math.round(drawer?.top ?? -1), composerBottom: Math.round(composer?.bottom ?? -1) };
    });
    assert.ok(
      drawerOrder.drawerTop >= drawerOrder.composerBottom - 2,
      `终端抽屉必须在输入框下方，实测 drawer.top=${drawerOrder.drawerTop} composer.bottom=${drawerOrder.composerBottom}`,
    );
    await page.screenshot({ path: resolve(outputDir, "terminal-drawer-below-composer.png") });
    const terminalCloseGeometry = await page.evaluate(() => {
      const rectOf = (selector) => {
        const node = document.querySelector(selector);
        const rect = node?.getBoundingClientRect();
        if (!rect) return null;
        const style = getComputedStyle(node);
        return {
          selector,
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          position: style.position,
          zIndex: style.zIndex,
          pointerEvents: style.pointerEvents,
        };
      };
      const close = document.querySelector("#terminal-drawer-close");
      const closeRect = close?.getBoundingClientRect();
      const x = closeRect ? closeRect.left + closeRect.width / 2 : -1;
      const y = closeRect ? closeRect.top + closeRect.height / 2 : -1;
      const hit = x >= 0 ? document.elementFromPoint(x, y) : null;
      return {
        drawer: rectOf("#terminal-drawer"),
        close: rectOf("#terminal-drawer-close"),
        conversation: rectOf(".conversation-pane"),
        missionDock: rectOf("#mission-control-dock"),
        hit: hit ? { id: hit.id, tag: hit.tagName, className: hit.className } : null,
        closeOwnsHit: Boolean(hit?.closest?.("#terminal-drawer-close")),
        point: { x: Math.round(x), y: Math.round(y) },
      };
    });
    assert.equal(
      terminalCloseGeometry.closeOwnsHit,
      true,
      `终端关闭按钮命中层级错误：${JSON.stringify(terminalCloseGeometry)}`,
    );
    await page.locator("#terminal-drawer-close").click();
    await page.locator("#terminal-drawer").waitFor({ state: "hidden", timeout: 2_000 });
    assert.equal(await page.locator("#terminal-drawer").isVisible(), false);

    await invokeTool("terminal");
    await page.locator('[data-tool-panel="terminal"]').waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await page.locator("#terminal-drawer").isVisible(), false, "侧栏终端不得重新打开底部抽屉");
    await page.locator('[data-rail-activate="mission"]').click();

    // 右栏标签条：任务上下文默认在位，➕ 菜单与空态选择器的视觉证据
    await page.locator("#mission-control-dock").screenshot({ path: resolve(outputDir, "rail-tab-mission.png") });
    await page.locator("#rail-tab-add").click();
    await page.locator("#rail-tool-menu").waitFor({ state: "visible" });
    await page.locator("#mission-control-dock").screenshot({ path: resolve(outputDir, "rail-tool-menu.png") });
    await page.keyboard.press("Escape");

    // 审阅页：无隔离工作树的任务只报边界，不发注定 422 的 diff 请求
    await invokeTool("review");
    await page.locator('[data-tool-panel="review"]').waitFor({ state: "visible", timeout: 20_000 });
    assert.match(await page.locator("#rail-review-body").innerText(), /没有隔离工作树/);

    // 切到隔离工作树任务，验证真实 diff 被解析成带新旧行号的着色块
    await page.locator(`[data-bot-active-run="${buildRunId}"]`).click();
    await page.waitForFunction(
      () => !document.getElementById("rail-review-body")?.textContent?.includes("正在读取工作树差异"),
      null,
      { timeout: 25_000 },
    );
    await page.locator("#rail-review-body .rail-diff-file").first().waitFor({ state: "visible", timeout: 25_000 });
    assert.match(await page.locator("#rail-review-body").innerText(), /worktree-only\.txt/);
    assert.ok(await page.locator("#rail-review-body .rail-diff-line.is-add").count() > 0, "diff 新增行未着色");
    assert.match(await page.locator("#rail-review-stat").innerText(), /\+\d/);
    await page.locator("#mission-control-dock").screenshot({ path: resolve(outputDir, "rail-tab-review.png") });
    await page.locator(`[data-bot-active-run="${runId}"]`).click();

    // 文件页：受控 workspace 目录树 + 筛选
    await invokeTool("files");
    await page.locator('[data-tool-panel="files"]').waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForFunction(
      () => !document.getElementById("rail-files-list")?.textContent?.includes("正在读取目录"),
      null,
      { timeout: 25_000 },
    );
    assert.match(await page.locator("#rail-files-list").innerText(), /ahead\.txt|staged\.txt|config/);
    await page.locator("#mission-control-dock").screenshot({ path: resolve(outputDir, "rail-tab-files.png") });

    // 浏览器页：地址栏提交仍走系统浏览器新标签（不内嵌网页视图）
    const popupPromise = context.waitForEvent("page");
    await invokeTool("browser");
    await page.locator('[data-tool-panel="browser"]').waitFor({ state: "visible", timeout: 20_000 });
    await page.locator("#mission-control-dock").screenshot({ path: resolve(outputDir, "rail-tab-browser.png") });
    await page.locator("#rail-browser-url").fill("https://example.com/514cc-environment-qa");
    await page.locator('#rail-browser-form button[type="submit"]').click();
    const popup = await popupPromise;
    await popup.waitForURL("https://example.com/514cc-environment-qa", { timeout: 20_000 });
    assert.equal(await popup.evaluate(() => window.opener === null), true);
    await popup.close();

    // 环境舱住在「任务上下文」工具页里：Git 动作前必须先切回该页，否则按钮在隐藏页上不可点
    await invokeTool("mission");
    await page.locator('[data-tool-panel="mission"]').waitFor({ state: "visible", timeout: 20_000 });

    const headBefore = git(repoRoot, ["rev-parse", "HEAD"]);
    await page.locator('#mission-environment-panel [data-environment-action="commit"]').click();
    await page.locator("#workbench-git-dialog").waitFor({ state: "visible" });
    await page.locator("#workbench-git-message").fill("UI 仅预览，不执行");
    await page.locator("#workbench-git-plan-button").click();
    await page.locator("#action-dialog").waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await page.locator("#dialog-confirm-button").isDisabled(), true);
    await page.locator("#dialog-confirmation-input").fill("COMMIT-WRONG");
    assert.equal(await page.locator("#dialog-confirm-button").isDisabled(), true);
    await page.locator("#dialog-confirmation-input").fill("COMMIT");
    assert.equal(await page.locator("#dialog-confirm-button").isDisabled(), false);
    await page.locator('#action-dialog .dialog-actions button[value="cancel"]').click();
    assert.equal(git(repoRoot, ["rev-parse", "HEAD"]), headBefore);

    const workspaceClose = page.locator("#mission-workspace-browser [data-workspace-close]");
    if (await workspaceClose.isVisible()) await workspaceClose.click();
    await page.locator('[data-registry-tab="tasks"]').click();
    // `[open]` 是动态选择器：预先 all() 出的 nth(i) 会在前一次折叠后失配，必须每轮重新取 first。
    for (let guard = 0; guard < 8; guard += 1) {
      const openSummary = page.locator("#mission-environment-panel .environment-group[open] > summary").first();
      if (!(await openSummary.count())) break;
      await openSummary.click();
    }
    await page.waitForFunction(() => document.getElementById("toast-region")?.childElementCount === 0, null, { timeout: 10_000 });
    await page.locator("#mission-environment-panel").evaluate((node) => { node.scrollTop = 0; });

    const layouts = [];
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(120);
      if (await page.locator(".workbench-shell").evaluate((node) => node.classList.contains("mc-collapsed"))) {
        await page.locator("#global-mc-toggle").click();
      }
      const commitAction = page.locator('#mission-environment-panel [data-environment-action="commit"]');
      await commitAction.scrollIntoViewIfNeeded();
      const gitActionReachable = await commitAction.evaluate((button) => {
        const actionRect = button.getBoundingClientRect();
        const panelRect = button.closest("#mission-environment-panel")?.getBoundingClientRect();
        return Boolean(panelRect
          && actionRect.width > 0
          && actionRect.height > 0
          && actionRect.top < panelRect.bottom
          && actionRect.bottom > panelRect.top);
      });
      assert.equal(gitActionReachable, true, `${viewport.name} Git actions must be reachable by scrolling the environment panel`);
      await page.locator("#mission-environment-panel").evaluate((node) => { node.scrollTop = 0; });
      const metrics = await page.evaluate(() => {
        const dock = document.getElementById("mission-control-dock")?.getBoundingClientRect();
        const composer = document.getElementById("composer-shell")?.getBoundingClientRect();
        return {
          innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          dockVisible: Boolean(dock && dock.width > 0 && dock.right > 0 && dock.left < innerWidth),
          composerWithinViewport: Boolean(composer && composer.left >= -1 && composer.right <= innerWidth + 1),
        };
      });
      assert.ok(metrics.scrollWidth <= metrics.innerWidth + 1, `${viewport.name} horizontal overflow: ${JSON.stringify(metrics)}`);
      assert.equal(metrics.dockVisible, true, `${viewport.name} Mission Control must remain reachable`);
      assert.equal(metrics.composerWithinViewport, true, `${viewport.name} composer must remain in viewport`);
      const screenshot = resolve(outputDir, `${viewport.name}.png`);
      await page.screenshot({ path: screenshot });
      layouts.push({ ...viewport, ...metrics, gitActionReachable, screenshot });
    }

    await watcher.settle();
    assert.deepEqual(diagnostics, []);
    assert.ok(allowedGateBlocks.every((item) => ALLOWED_GATE_BLOCKS.has(item)));
    return {
      ok: true,
      origin,
      runId,
      payload: capturedMessage,
      environment: {
        branch: environment.git.branch,
        ahead: environment.git.ahead,
        staged: environment.git.changes.staged,
        untracked: environment.git.changes.untracked,
        sources: environment.sources.items.map((item) => item.name),
        buildWorkspace: buildEnvironment.workspace.source,
        buildDetached: buildEnvironment.git.detached,
      },
      cliControls,
      layouts,
      diagnostics,
      allowedRequestAborts: allowedRequestAborts.length,
      allowedGateBlocks: [...new Set(allowedGateBlocks)].sort(),
    };
  } finally {
    watcher.beginClosing();
    await watcher.settle();
    await browser.close();
  }
}

export async function runWorkbenchEnvironmentQa({ outputDir } = parseArgs()) {
  await mkdir(outputDir, { recursive: true });
  let result;
  await withDisposableQaRoot(async (qaRoot) => {
    const token = randomBytes(32).toString("base64url");
    const fixture = await prepareFixture(qaRoot, token);
    const server = spawnTestServer({ env: fixture.env });
    let shutdown;
    try {
      const bootstrapUrl = await waitForUrl(server, { timeoutMs: 30_000 });
      const origin = new URL(bootstrapUrl).origin;
      assert.equal(new URL(bootstrapUrl).hostname, "127.0.0.1");
      result = await runBrowserQa({ bootstrapUrl, origin, token, outputDir, ...fixture });
    } finally {
      shutdown = await stopTestServer(server, { token, timeoutMs: 8_000 });
    }
    assert.equal(shutdown.graceful, true);
    assert.equal(shutdown.fallback, false);
    result.isolation = { selfSpawned: true, randomPort: true, gracefulShutdown: true };
  });
  result.isolation.tempRootRemoved = true;
  await writeFile(resolve(outputDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runWorkbenchEnvironmentQa(parseArgs());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
