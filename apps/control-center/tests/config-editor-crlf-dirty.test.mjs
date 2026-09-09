/**
 * 配置编辑器的 CRLF 假 dirty 缺陷（2026-09-05 发现，TDD 复现在先）。
 *
 * ── 缺陷 ──
 * `<textarea>` 会按 HTML 规范把值里的 CRLF 规范化成 LF（"API value" 用 LF）。
 * 服务端返回的原文含 `\r\n`，`state.config.baselineContent` 存的是原文，
 * 而 `configIsDirty()` 直接比 `textarea.value !== baselineContent` ——
 * 于是每个 CRLF 文件一打开就恒为 dirty。
 *
 * 数学判据（.agents/skills/514cc-collab/SKILL.md，实测）：
 *   磁盘 2957 字节 → JS 字符串 2951（UTF-8 多字节）→ textarea 规范化后 2901
 *   浏览器实测 editorLen = 2901 ✓
 *
 * ── 用户后果（三条，第 3 条是数据完整性问题）──
 * 1. 打开就显示假的「已修改 / 有未保存变更」
 * 2. 切换真源被 danger 确认框「放弃当前编辑？」拦住 —— 这条让
 *    `npm run qa:config-topology` 的 capability-source 跳转永久超时，
 *    而该故障被更外层的 EPERM 掩盖了 39 天（EPERM 死在脚本第 48 行，跳转在 318 行）
 * 3. `configPayload()` 发的是规范化后的 LF 值 → 点保存会把文件行尾整体改写
 *
 * 影响面：仓库 1074 个真源候选里 179 个是 CRLF（16.7%），
 * 含 `.claude-plugin/plugin.json`、`.claude/hooks/mirror-gate.py`、`AGENTS.md`。
 * 根因是 `core.autocrlf=true` 的 checkout，不是文件本身有问题。
 *
 * ── 为什么必须是真浏览器测试 ──
 * CRLF→LF 是**浏览器对 textarea 的规范化**，node 里给假 elements 塞 `{ value }`
 * 复现不出来（那正是这个缺陷躲过既有 2300+ 测试的原因）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "./server-fixture.mjs";

const CRLF_SOURCE_ID = "control.crlf-probe";
const CRLF_BODY = "line one\r\nline two\r\nline three\r\n";
const LF_BODY = CRLF_BODY.replace(/\r\n/g, "\n");

// 四份 control-center 配置都必须在：readRuntimeConfig 用 Promise.all 一次性读
// models/routing/permissions/sources，缺任何一份就 ENOENT → uncaughtException → exit 1，
// 而 stdout/stderr 什么都不打（只落 .scratch/control-center-fatal.log），表现为"服务静默不起"。
async function writeRepoConfig(repoRoot) {
  await mkdir(join(repoRoot, "config", "control-center"), { recursive: true });
  await writeFile(join(repoRoot, "config", "app.json"), '{"enabled":true}\n');
  // 四份 control-center 配置都必须在：readRuntimeConfig 用 Promise.all 一次性读
  // models/routing/permissions/sources，缺任何一份就 ENOENT → uncaughtException → exit 1，
  // 而 stdout/stderr 什么都不打（只落 .scratch/control-center-fatal.log），表现为"服务静默不起"。
  await writeFile(join(repoRoot, "config", "control-center", "models.json"), `${JSON.stringify({
    version: 1,
    profiles: testModelProfiles().map((profile) => ({ ...profile, capabilities: ["*"] })),
  }, null, 2)}\n`);
  await writeFile(join(repoRoot, "config", "control-center", "routing.json"), `${JSON.stringify({
    version: 1,
    primaryCoordinator: "claude-fable",
    technicalExecutor: "codex-technical",
    maxRounds: 6,
    maxDepth: 2,
    maxParallelAgents: 4,
    requireHealthyProvider: false,
    failOnUnavailableExplicitProvider: false,
    weights: { quality: 0.44, speed: 0.26, health: 0.22, cost: 0.08 },
    rules: [],
    independentPass: { requiredFor: [], mustDifferFromPrimary: true },
  }, null, 2)}\n`);
  await writeFile(join(repoRoot, "config", "control-center", "permissions.json"), `${JSON.stringify({
    version: 1,
    defaultMode: "plan",
    modes: { plan: { write: false, approvalRequired: false }, build: { write: "workspace", approvalRequired: true } },
    limits: { maxRounds: 8, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 30_000, turnIdleTimeoutMs: 10_000 },
    approval: { ttlMs: 60_000 },
  }, null, 2)}\n`);
  await writeFile(join(repoRoot, "config", "control-center", "sources.json"), `${JSON.stringify({
    version: 1,
    // writePolicy: "transactional" 是编辑器可写的前提（config-manager.mjs:215/253：
    // scope 非 repo 或 writePolicy 非 transactional 一律 readOnly，textarea 随之 disabled）。
    explicit: [{ id: CRLF_SOURCE_ID, path: "crlf-probe.md", label: "crlf probe", kind: "markdown", scope: "repo", writePolicy: "transactional" }],
    discover: [],
    runtime: [],
  }, null, 2)}\n`);
}

test("CRLF 真源打开后不得显示假 dirty，且保存不改写行尾", async (t) => {
  const token = "crlf-dirty-guard-token";
  const repoRoot = await mkdtemp(join(tmpdir(), "514cc-crlf-repo-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "514cc-crlf-data-"));
  let browser = null;
  let server = null;
  t.after(async () => {
    if (browser) await browser.close().catch(() => {});
    if (server) await stopTestServer(server, { token }).catch(() => {});
    await rm(repoRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }).catch(() => {});
  });

  // 一个只含 CRLF 探针源的最小 repo：真源清单越小，断言归因越干净。
  const crlfPath = join(repoRoot, "crlf-probe.md");
  await writeFile(crlfPath, CRLF_BODY, "utf8");
  await writeRepoConfig(repoRoot);

  server = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: token,
      CONTROL_CENTER_DATA_DIR: dataRoot,
      CONTROL_CENTER_REPO_ROOT: repoRoot,
      CONTROL_CENTER_PORT: "0",
    },
  });
  const entryUrl = await waitForUrl(server);

  browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(entryUrl, { waitUntil: "domcontentloaded" });

  // fail-fast：应用没真的登录进来时，后面每个数字都会"看起来正常"。
  // v49 那一轮 11 版探针里前 10 版全毁于此（bootstrap 令牌单次有效）。
  await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 30_000 });
  await page.evaluate(() => { location.hash = "#config/sources"; });
  await page.waitForSelector("#view-config:not([hidden])", { timeout: 15_000 });

  const loaded = await page.waitForFunction((id) => {
    const path = document.querySelector("#editor-path")?.textContent ?? "";
    const editor = document.querySelector("#config-editor");
    return path.includes("crlf-probe.md") && editor && editor.value.length > 0
      ? { path, len: editor.value.length, head: editor.value.slice(0, 24) }
      : null;
  }, CRLF_SOURCE_ID, { timeout: 20_000 }).then((handle) => handle.jsonValue());

  // 先证实前提成立：浏览器确实把 CRLF 规范化掉了，否则这条测试是空转。
  assert.equal(loaded.len, LF_BODY.length,
    `前提失效：textarea 未把 CRLF 规范化（期望 ${LF_BODY.length}，实得 ${loaded.len}）—— 若浏览器行为变了，本测试需重新设计`);
  assert.ok(CRLF_BODY.length > LF_BODY.length, "探针源必须真的含 CRLF，否则断言恒真");

  const state = await page.evaluate(() => ({
    editState: document.querySelector("#config-edit-state")?.textContent ?? "",
    globalStatus: document.querySelector("#config-global-status")?.textContent ?? "",
    statusClass: document.querySelector("#config-global-status")?.className ?? "",
    applyDisabled: document.querySelector("#apply-config-button")?.disabled,
    planDisabled: document.querySelector("#plan-config-button")?.disabled,
  }));

  assert.equal(state.editState, "无变更",
    `CRLF 真源刚加载就报「${state.editState}」—— textarea 的 LF 值与含 CRLF 的 baselineContent 直接相比，configIsDirty() 恒为 true`);
  assert.equal(state.globalStatus, "已加载",
    `状态标签报「${state.globalStatus}」而非「已加载」`);
  assert.ok(state.applyDisabled,
    "假 dirty 会让「应用」按钮误开启 —— 用户点下去就把整份文件的行尾改写成 LF");
  assert.ok(state.planDisabled, "假 dirty 会让「预览」按钮误开启");

  assert.deepEqual(pageErrors, [], `页面报错：${pageErrors.join(" | ")}`);
});

test("编辑 CRLF 真源后保存，落盘行尾仍是 CRLF（不得把整份文件改写成 LF）", async (t) => {
  const token = "crlf-save-guard-token";
  const repoRoot = await mkdtemp(join(tmpdir(), "514cc-crlf-save-repo-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "514cc-crlf-save-data-"));
  let browser = null;
  let server = null;
  t.after(async () => {
    if (browser) await browser.close().catch(() => {});
    if (server) await stopTestServer(server, { token }).catch(() => {});
    await rm(repoRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }).catch(() => {});
  });

  const crlfPath = join(repoRoot, "crlf-probe.md");
  await writeFile(crlfPath, CRLF_BODY, "utf8");
  await writeRepoConfig(repoRoot);

  server = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: token,
      CONTROL_CENTER_DATA_DIR: dataRoot,
      CONTROL_CENTER_REPO_ROOT: repoRoot,
      CONTROL_CENTER_PORT: "0",
    },
  });
  const entryUrl = await waitForUrl(server);

  browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 30_000 });
  await page.evaluate(() => { location.hash = "#config/sources"; });
  await page.waitForSelector("#view-config:not([hidden])", { timeout: 15_000 });
  // 编辑器活在「高级真源」工作区里，默认打开的是「运行席位」——
  // 不切过去 textarea 的 rect 是 0×0（offsetParent === null），fill 会一直等到超时。
  await page.locator('[data-runtime-workspace-mode="sources"]').click();
  await page.waitForFunction(() => {
    const editor = document.querySelector("#config-editor");
    if (!editor || editor.disabled || editor.offsetParent === null) return false;
    return (document.querySelector("#editor-path")?.textContent ?? "").includes("crlf-probe.md")
      && editor.value.length > 0;
  }, null, { timeout: 20_000 });

  // 真编辑一次：追加一行。用户改的是内容，没碰行尾。
  await page.locator("#config-editor").focus();
  await page.locator("#config-editor").fill(`${LF_BODY}line four\n`);
  await page.waitForFunction(() => document.querySelector("#config-edit-state")?.textContent === "已修改",
    null, { timeout: 5_000 });

  // 直接检查将要发出的 payload：这比走完整审批链更聚焦，且不受权限档影响。
  const payloadContent = await page.evaluate(async () => {
    let captured = null;
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input?.url ?? "";
      if (/\/api\/config\/.+\/(plan|apply|validate)$/.test(url) && init?.body) {
        try { captured = JSON.parse(init.body).content; } catch { captured = null; }
      }
      return originalFetch(input, init);
    };
    try {
      document.querySelector("#validate-config-button")?.click();
      await new Promise((done) => setTimeout(done, 2500));
    } finally {
      window.fetch = originalFetch;
    }
    return captured;
  });

  assert.ok(typeof payloadContent === "string" && payloadContent.length > 0,
    "没抓到发往服务端的 content —— 断言前提失效，不接受「看起来通过」");
  assert.ok(payloadContent.includes("\r\n"),
    "发往服务端的 content 已被规范化成 LF —— 保存会把整份 CRLF 文件的行尾改写掉（configPayload 未走 restoreEditorNewlines）");
  assert.ok(payloadContent.includes("line four"), "用户的实际编辑必须保留在 payload 里");
  assert.ok(!/(?<!\r)\n/.test(payloadContent),
    `payload 里出现了裸 LF，行尾被混合污染：${JSON.stringify(payloadContent)}`);
});
