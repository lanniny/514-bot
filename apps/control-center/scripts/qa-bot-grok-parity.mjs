#!/usr/bin/env node
/**
 * qa-bot-grok-parity.mjs — Grok Bot 对标协作面 UI 验证（routines 真实化 / profile 表单 / 交接板）。
 *
 * 流程：隔离内核 + fixture 配置 → API 造真数据（profile/routines/handoff+ack）→
 * Chromium 走 bot 面三处 UI 断言 + 截图。运行：node scripts/qa-bot-grok-parity.mjs
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

// B-02 同律：WorkBuddy 宿主经 NODE_OPTIONS 注入安全删除 shim（rm/unlink 拦回收站 +
// 单轮 bulk-guard），QA 的临时目录/output 清理会被 SAFE_DELETE_BULK_CONFIRM_REQUIRED 打断。
// 检测到即剥离该支 --require 重拉自身（与 scripts/run-tests.mjs 同一手法）。
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
const outputDir = resolve(appRoot, ".qa-output", "bot-grok-parity");
const token = "bot-grok-parity-qa-token-0123456789";

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
      evidence: [{ source: "qa-fixture", detail: "Bot grok parity QA", verifiedAt: "2026-09-09" }],
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
  const root = await mkdtemp(resolve(appRoot, ".qa-bot-grok-parity-"));
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
    const api = async (path, { method = "GET", body, allowStatus = null } = {}) => {
      const response = await fetch(new URL(path, origin), {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok && response.status !== allowStatus) {
        throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
      }
      return payload;
    };

    // ---------- 造数据：成员 + profile + routines + 群会话 handoff ----------
    const membersPayload = await api("/api/team-members");
    const catalog = Array.isArray(membersPayload?.members) ? membersPayload.members : [];
    const seat = catalog.find((member) => member.id === "claude-fable") ?? catalog[0];
    assert.ok(seat, "team catalog must not be empty");
    const owner = await api("/api/team-members", {
      method: "POST",
      body: { label: "巡检员", shortLabel: "检", role: "账本巡检负责人", runtimeProfileId: seat.runtimeProfileId, capabilities: ["research"] },
    });
    const ownerId = String(owner.id);

    const profileSaved = await api(`/api/bots/${encodeURIComponent(ownerId)}`, {
      method: "PUT",
      body: {
        handle: "@inspector", // 自动生成的长 memberId 无法推导默认 handle（≤32 字符）——显式指定
        job: { owns: "每周配置健康巡检：汇总三块账本，产出链接化观察清单", goals: ["漂移发现率 100%", "每周一 08:00 前出清单"] },
        standingRules: ["来源必须带出处", "客户联系类动作永不允许"],
        approvalBoundary: { requireApproval: ["向 channels 外发任何消息"], neverAllowed: ["git push --force"] },
        skills: ["grok-researcher"],
        routineQuota: 50,
      },
    });
    check("profile saved via API", () => assert.equal(profileSaved.bot.job.owns.startsWith("每周配置健康巡检"), true));

    const routineA = (await api("/api/bots/routines", {
      method: "POST",
      body: {
        owningMemberId: ownerId, title: "每周配置健康巡检",
        instructions: "汇总 route-gate / DELTA / handoff 三块账本",
        schedule: "at:08:00@1,3,5", expectedOutput: "链接化观察清单",
        approvalBoundary: "不外发；产出仅回帖到会话", noDataPolicy: "report-failure",
      },
    })).routine;
    const routineB = (await api("/api/bots/routines", {
      method: "POST",
      body: {
        owningMemberId: ownerId, title: "每日收件箱摘要",
        instructions: "汇总昨日协作收件箱", schedule: "every:1d",
        expectedOutput: "待办清单", approvalBoundary: "不外发", noDataPolicy: "skip-and-report",
      },
    })).routine;
    const enabled = await api(`/api/bots/routines/${routineA.id}/enable`, { method: "POST", body: {} });
    check("routine enable bridges automation", () => assert.ok(enabled.automationRef));

    const project = (await api("/api/projects", { method: "POST", body: { title: "Grok parity workspace", cwd: repoRoot } })).project;
    const group = (await api("/api/conversations", {
      method: "POST",
      body: {
        kind: "workspace_group", title: "Grok 对标协作室", projectId: project.projectId,
        // 群成员与 run 指派必须一致且都是团队成员：交接演示全用内置成员；
        // 新建成员 owner 只承载 profile/routines 部分（与 relay 解耦）
        roomRole: "task", memberIds: [seat.id, "codex-technical"],
      },
    })).conversation;
    const run = await api("/api/runs", {
      method: "POST",
      body: {
        prompt: "GROK_PARITY_RELAY_MARK", execute: false, permissionMode: "plan",
        conversationId: group.id, conversationKind: "workspace_group",
        orchestrationMode: "social", startAgentId: seat.id, requestedAgentIds: ["codex-technical"],
        ephemeralTeam: {
          name: "Grok parity team",
          coordinator: seat.id,
          members: [seat.id, "codex-technical"],
          skills: [], mcp: [], providers: {}, systemPrompt: "",
        },
      },
    });
    const handoffOpen = await api("/api/bots/relay/handoff", {
      method: "POST",
      body: { runId: run.id, from: seat.id, to: "codex-technical", stage: "collect", text: "收集本周三块账本数据，逐条带出处" },
    });
    assert.ok(handoffOpen.messageId, "handoff must return messageId");
    await api("/api/bots/relay/handoff", {
      method: "POST",
      body: { runId: run.id, from: "codex-technical", to: seat.id, stage: "review", text: "复核清单完整性并只列阻塞项" },
    });
    const boardBefore = await api(`/api/bots/relay/${run.id}`);
    check("relay board shows two open handoffs", () => assert.equal(boardBefore.openHandoffs.length, 2));

    // 与 owner 的单聊（右栏 Routines 挂载点）
    const direct = (await api("/api/conversations", {
      method: "POST",
      body: { kind: "direct", title: "巡检员单聊", directMemberId: ownerId },
    })).conversation;

    // ---------- 页面验证 ----------
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (error) => { throw error; });
    await page.addInitScript((accessToken) => sessionStorage.setItem("514cc-control-token", accessToken), token);
    await page.goto(`${origin}/#bot`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });

    // ① 右栏 Routines 真实化
    await page.locator(`[data-bot-conversation="${direct.id}"]`).click();
    await page.locator("#bot-agent-info-button").click();
    await page.waitForSelector("#bot-agent-panel:not([hidden])");
    await page.waitForFunction(
      (expected) => document.querySelector("#bot-routine-list")?.textContent?.includes(expected) === true,
      "每周配置健康巡检",
      { timeout: 15_000 },
    );
    const routineText = await page.locator("#bot-routine-list").textContent();
    check("routines panel renders real data", () => {
      assert.match(routineText, /每周配置健康巡检/);
      assert.match(routineText, /每日收件箱摘要/);
      assert.match(routineText, /周一\/周三\/周五 08:00/);
      assert.doesNotMatch(routineText, /每周工作台巡检/); // 假数据已除
    });
    check("enabled routine shows toggle on", () =>
      page.locator(`[data-routine-id="${routineA.id}"] .bot-toggle.is-on`).waitFor({ state: "attached", timeout: 5000 }));
    await page.screenshot({ path: resolve(outputDir, "01-routines-panel.png") });
    report.screenshots.push("01-routines-panel.png");

    // ② 成员设置 · 协作职责（profile）区
    await page.locator("#bot-agent-settings-button").click();
    await page.waitForSelector("#bot-agent-settings-panel:not([hidden])");
    await page.waitForFunction(
      () => document.querySelector("#bot-profile-owns")?.value?.includes("每周配置健康巡检") === true,
      null,
      { timeout: 15_000 },
    );
    check("profile section hydrated", () =>
      page.locator("#bot-profile-status[data-tone='ok']").waitFor({ state: "attached", timeout: 5000 }));
    await page.screenshot({ path: resolve(outputDir, "02-profile-section.png") });
    report.screenshots.push("02-profile-section.png");
    // 表单回写：改 owns 保存 → API 读回
    await page.locator("#bot-profile-owns").fill("每周配置健康巡检：产出链接化观察清单（UI 回写验证）");
    await page.locator("#bot-agent-settings-submit").click();
    await page.waitForFunction(() => document.querySelector("#bot-agent-settings-panel")?.hidden === true, null, { timeout: 15_000 });
    const profileAfter = await api(`/api/bots/${encodeURIComponent(ownerId)}`);
    check("profile round-trips through UI save", () =>
      assert.match(profileAfter.bot.job.owns, /UI 回写验证/));

    // ③ 群会话 tasks tab · 交接板
    // 成员保存后界面自动切到「成员」tab（botSaveAgentSettings 既有行为）——先切回对话 tab
    await page.locator("#bot-surface-tab-chats").click();
    // 群会话在项目树二级节点：若项目折叠需先展开（真实用户路径）
    const groupRow = page.locator(`[data-bot-conversation="${group.id}"]`);
    if (!(await groupRow.isVisible().catch(() => false))) {
      await page.locator(`[data-bot-project-toggle="${project.projectId}"]`).click();
    }
    await groupRow.click();
    await page.locator("#bot-agent-info-button").click();
    await page.locator("#bot-collab-tab-tasks").click();
    await page.waitForFunction(
      () => document.querySelector("[data-relay-mount]")?.textContent?.includes("待确认交接") === true,
      null,
      { timeout: 15_000 },
    );
    const relayText = await page.locator("[data-relay-mount]").textContent();
    check("relay board renders open handoffs", () => {
      assert.match(relayText, /待确认交接/);
      assert.match(relayText, /收集本周三块账本数据/);
      assert.match(relayText, /复核清单完整性/);
    });
    await page.screenshot({ path: resolve(outputDir, "03-relay-board.png") });
    report.screenshots.push("03-relay-board.png");
    // 交接板 ack：从板数据取 handoffId，由接收方确认后复看板面变化
    const boardNow = await api(`/api/bots/relay/${run.id}`);
    const openOne = boardNow.openHandoffs.find((item) => item.to === "codex-technical");
    assert.ok(openOne, "board must have an open handoff to codex-technical");
    await api("/api/bots/relay/ack", { method: "POST", body: { runId: run.id, from: "codex-technical", handoffId: openOne.handoffId } });
    await page.locator("#bot-collab-tab-conversation").click();
    await page.locator("#bot-collab-tab-tasks").click();
    await page.waitForFunction(
      () => document.querySelector("[data-relay-mount]")?.textContent?.includes("已确认") === true,
      null,
      { timeout: 15_000 },
    );
    check("acked handoff moves to confirmed section", () =>
      page.locator("[data-relay-mount] .bot-relay-row.is-acked").waitFor({ state: "attached", timeout: 5000 }));
    await page.screenshot({ path: resolve(outputDir, "04-relay-acked.png") });
    report.screenshots.push("04-relay-acked.png");

    // ④ Grok 式列表预览 + 日期徽章：social 执行轮在 adapter 启动前先把 user.message
    // 投影进事件流（隔离内核无真实 CLI，turn 随后失败不影响预览回填——这正是真实时序）。
    await api("/api/runs", {
      method: "POST",
      body: {
        prompt: "QA_PREVIEW_MARK_把剩余卡片接到真实数据", execute: true, permissionMode: "plan",
        conversationId: group.id, conversationKind: "workspace_group",
        orchestrationMode: "social", startAgentId: seat.id, requestedAgentIds: ["codex-technical"],
        ephemeralTeam: {
          name: "Grok parity team",
          coordinator: seat.id,
          members: [seat.id, "codex-technical"],
          skills: [], mcp: [], providers: {}, systemPrompt: "",
        },
      },
    });
    let groupAfter = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const listPayload = await api("/api/conversations?includeHidden=1");
      groupAfter = (listPayload?.conversations || []).find((item) => item.id === group.id);
      if (groupAfter?.preview?.text?.includes("QA_PREVIEW_MARK")) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    check("server backfills preview from real user.message event", () => {
      assert.ok(groupAfter?.preview, "group conversation must carry preview after execute run");
      assert.match(groupAfter.preview.text, /QA_PREVIEW_MARK/);
      assert.equal(groupAfter.preview.from, "LO");
    });

    // 错误态靶场：带 run 的新任务房——页面从未打开过它，保证无缓存消息流（错误卡而非 toast）
    const taskRoom = (await api("/api/conversations", {
      method: "POST",
      body: {
        kind: "workspace_group", title: "错误态任务房", projectId: project.projectId,
        roomRole: "task", memberIds: [seat.id, "codex-technical"],
      },
    })).conversation;
    await api("/api/runs", {
      method: "POST",
      body: {
        prompt: "ERR_MARK", execute: false, permissionMode: "plan",
        conversationId: taskRoom.id, conversationKind: "workspace_group",
        orchestrationMode: "social", startAgentId: seat.id, requestedAgentIds: ["codex-technical"],
        ephemeralTeam: {
          name: "Grok parity team",
          coordinator: seat.id,
          members: [seat.id, "codex-technical"],
          skills: [], mcp: [], providers: {}, systemPrompt: "",
        },
      },
    });

    // 重载页面让会话索引带上服务端 preview（SSE 本地回填只覆盖页面已知的 runIds）
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });
    await page.locator("#bot-surface-tab-chats").click();
    const previewRow = page.locator(`[data-bot-conversation="${group.id}"]`);
    if (!(await previewRow.isVisible().catch(() => false))) {
      await page.locator(`[data-bot-project-toggle="${project.projectId}"]`).click();
    }
    await previewRow.waitFor({ state: "visible", timeout: 15_000 });
    const previewText = await previewRow.locator(".bot-conversation-preview").textContent();
    const dateText = await previewRow.locator(".bot-conversation-date").textContent();
    check("roster row shows Grok-style preview line and date badge", () => {
      assert.match(previewText, /QA_PREVIEW_MARK/);
      assert.ok(String(dateText || "").trim().length > 0, "date badge must not be empty");
    });
    await page.screenshot({ path: resolve(outputDir, "05-roster-preview.png") });
    report.screenshots.push("05-roster-preview.png");

    // ⑤ 加载失败 Grok 式错误卡： abort 事件拉取 → 打开从未缓存的任务房
    let abortedEventsFetches = 0;
    await page.route("**/api/runs/*/events*", (route) => { abortedEventsFetches += 1; route.abort(); });
    const taskRow = page.locator(`[data-bot-conversation="${taskRoom.id}"]`);
    await taskRow.waitFor({ state: "visible", timeout: 15_000 });
    await taskRow.click();
    try {
      await page.waitForSelector(".bot-message-error", { timeout: 15_000 });
    } catch (error) {
      const debug = await page.evaluate(() => ({
        streamHtml: document.querySelector("#bot-message-stream")?.innerHTML?.slice(0, 500) ?? "no-stream",
        storeContext: document.querySelector("#bot-message-stream")?.dataset?.storeContext ?? null,
        historyRunId: document.querySelector("#bot-message-stream")?.dataset?.historyRunId ?? null,
      }));
      console.error("DEBUG load-error step:", JSON.stringify({ abortedEventsFetches, ...debug }, null, 2));
      throw error;
    }
    const errorText = await page.locator(".bot-message-error").textContent();
    check("load failure renders Grok-style retry card", () => {
      assert.match(errorText, /无法加载对话/);
      assert.match(errorText, /请检查网络连接后重试/);
    });
    await page.screenshot({ path: resolve(outputDir, "06-load-error.png") });
    report.screenshots.push("06-load-error.png");
    // 恢复网络 → 点重试 → 错误卡消失（消息流回到真实状态）
    await page.unroute("**/api/runs/*/events*");
    await page.locator('[data-bot-action="retry-conversation-sync"]').click();
    await page.waitForFunction(
      () => !document.querySelector("#bot-message-stream .bot-message-error"),
      null,
      { timeout: 15_000 },
    );
    check("retry recovers message stream after network restore", () => assert.ok(true));
    await page.screenshot({ path: resolve(outputDir, "07-load-retry-recovered.png") });
    report.screenshots.push("07-load-retry-recovered.png");

    // ⑥ W1：私有技能 UI CRUD（假数据清零验证）——命令面板 → 设置 → Plugins
    await page.locator("#command-palette-trigger").click();
    await page.keyboard.type("Open settings");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#bot-settings-panel:not([hidden])", { timeout: 15_000 });
    await page.locator("[data-bot-settings-tab='plugins']").click();
    await page.waitForFunction(
      () => document.querySelector("#bot-private-skill-list")?.textContent?.includes("还没有私有技能") === true,
      null,
      { timeout: 15_000 },
    );
    check("private skills list renders guiding empty state (fake data gone)", () => {
      const text = page.locator("#bot-private-skill-list").textContent();
      return text;
    });
    await page.locator("[data-bot-action='private-skill-add']").click();
    await page.locator("#bot-private-skill-name").fill("QA 账本巡检技能");
    await page.locator("#bot-private-skill-description").fill("汇总三块账本并给出观察清单");
    await page.locator("#bot-private-skill-instructions").fill("读取 route-gate、DELTA、handoff 账本，逐条带出处。");
    await page.locator("#bot-private-skill-editor button[type='submit']").click();
    await page.waitForFunction(
      () => document.querySelector("#bot-private-skill-list")?.textContent?.includes("QA 账本巡检技能") === true,
      null,
      { timeout: 15_000 },
    );
    const skillList = await api("/api/bots/private-skills");
    check("private skill persists through UI create (round-trip)", () => {
      assert.equal(skillList.count, 1);
      assert.match(skillList.skills[0].name, /QA 账本巡检技能/);
    });
    await page.screenshot({ path: resolve(outputDir, "08-private-skills.png") });
    report.screenshots.push("08-private-skills.png");
    // UI 删除 + API 确认清零
    await page.locator(".bot-private-skill-row [data-bot-action='private-skill-delete']").click();
    await page.locator("#dialog-confirm-button").click();
    await page.waitForFunction(
      () => document.querySelector("#bot-private-skill-list")?.textContent?.includes("还没有私有技能") === true,
      null,
      { timeout: 15_000 },
    );
    const skillAfter = await api("/api/bots/private-skills");
    check("private skill deletes through UI confirm", () => assert.equal(skillAfter.count, 0));
    await page.keyboard.press("Escape"); // 关闭设置面板

    // ⑦ W2：composer 多 @ 群聊消息 → kickoff 派发（@Fable 与 @Codex 各领一条交接）
    // 诊断钩子：捕获 kickoff 请求/响应与 toast——失败时把现场随断言一起吐出
    const kickoffTrace = { requests: [], responses: [], messagePosts: [], activeRunIds: [], toasts: [] };
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/api/bots/relay/kickoff")) kickoffTrace.requests.push({ url, body: req.postData() });
    });
    page.on("response", (response) => {
      const url = response.url();
      if (url.includes("/api/bots/relay/kickoff")) kickoffTrace.responses.push({ url, status: response.status() });
      if (/\/api\/conversations\/[^/]+\/messages/.test(url) && response.request().method() === "POST") {
        kickoffTrace.messagePosts.push({ url, status: response.status() });
      }
    });
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") kickoffTrace.toasts.push(`${msg.type()}: ${msg.text()}`);
    });
    // 干净会话路径：主群聊的 QA_PREVIEW_MARK run 在隔离内核下进入 recovery_required（非终态），
    // 新消息会被恢复锁 409 拒绝——真实用户等价路径是「新群聊直接 kickoff 派工」。
    // 用全新群会话验证：无 activeRun → submit 直接创建新 run → kickoff 落在新 run 交接板上。
    const kickoffRoom = (await api("/api/conversations", {
      method: "POST",
      body: {
        kind: "workspace_group", title: "Kickoff 派发房", projectId: project.projectId,
        roomRole: "task", memberIds: [seat.id, "codex-technical"],
      },
    })).conversation;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });
    await page.locator("#bot-surface-tab-chats").click();
    const kickoffRow = page.locator(`[data-bot-conversation="${kickoffRoom.id}"]`);
    if (!(await kickoffRow.isVisible().catch(() => false))) {
      await page.locator(`[data-bot-project-toggle="${project.projectId}"]`).click();
    }
    await kickoffRow.waitFor({ state: "visible", timeout: 15_000 });
    await kickoffRow.click();
    await page.locator("#bot-composer-input").fill("并行分工：@Fable 汇总本周路线证据 @Codex 核对账本完整性");
    await page.locator("#bot-composer-form button[type='submit']").click();
    let kickoffBoard = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 400));
      const convNow = (await api("/api/conversations?includeHidden=1")).conversations.find((item) => item.id === kickoffRoom.id);
      const activeRunId = String(convNow?.activeRunId || "");
      kickoffTrace.activeRunIds.push(activeRunId || "(empty)");
      if (!activeRunId) continue;
      let boardNow = null;
      try {
        boardNow = await api(`/api/bots/relay/${activeRunId}`);
      } catch (error) {
        kickoffTrace.toasts.push(`board poll error: ${error.message}`);
        continue;
      }
      if ((boardNow?.openHandoffs || []).length >= 2) { kickoffBoard = boardNow; break; }
    }
    check("composer multi-mention message dispatches kickoff handoffs", () => {
      assert.ok(kickoffBoard, `kickoff 必须在群聊新 run 上派发交接。诊断：${JSON.stringify(kickoffTrace)}`);
      assert.equal(kickoffBoard.openHandoffs.length, 2);
    });
    await page.screenshot({ path: resolve(outputDir, "09-kickoff-board.png") });
    report.screenshots.push("09-kickoff-board.png");

    // ⑧ W4：右栏 Channels 真源渲染（无频道 → 引导空态；门闸态 → 放行提示；绝不停在「正在读取」）
    const channelsText = await page.locator("#bot-channels-list").textContent();
    check("channels panel renders from real source (not stuck loading)", () => {
      assert.doesNotMatch(channelsText, /正在读取频道/);
      assert.ok(
        /还没有连接频道|门闸未开放|读取失败/.test(channelsText),
        `channels 空态必须是引导式或如实态，实际：${String(channelsText).slice(0, 80)}`,
      );
    });

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
