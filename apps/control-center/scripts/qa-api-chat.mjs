// Real UI, server, persistent stores and HTTP streaming. Only a local synthetic
// model is used. No runtime credentials or real provider calls are imported.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const root = await mkdtemp(resolve(tmpdir(), "514cc-api-chat-"));
const repoRoot = resolve(root, "repo");
const runtimeRoot = resolve(root, "runtime");
const dataRoot = resolve(root, "data");
await mkdir(resolve(repoRoot, "config/control-center"), { recursive: true });
await mkdir(resolve(repoRoot, "schemas/control-center"), { recursive: true });
await mkdir(runtimeRoot, { recursive: true });
await mkdir(resolve(appRoot, ".qa-output"), { recursive: true });
const output = await mkdtemp(resolve(appRoot, ".qa-output/api-chat-"));
const saveConfig = (name, value) => writeFile(resolve(repoRoot, `config/control-center/${name}.json`), JSON.stringify(value));
await copyFile(resolve(appRoot, "../../schemas/control-center/contracts.schema.json"), resolve(repoRoot, "schemas/control-center/contracts.schema.json"));
await saveConfig("models", { version: 1, profiles: testModelProfiles().map((profile, index) => ({ ...profile, command: `missing-api-qa-${index}`, quality: .5, speed: .5, costTier: 3, capabilities: ["*"], evidence: [{ source: "isolated-qa", detail: "No executable CLI", verifiedAt: "2026-09-17" }] })) });
await saveConfig("routing", { version: 1, primaryCoordinator: "claude-fable", technicalExecutor: "codex-technical", maxRounds: 6, maxDepth: 2, maxParallelAgents: 4, requireHealthyProvider: true, failOnUnavailableExplicitProvider: true, weights: { quality: .44, speed: .26, health: .22, cost: .08 }, rules: [], independentPass: { requiredFor: [], mustDifferFromPrimary: true } });
await saveConfig("permissions", { version: 1, defaultMode: "plan", modes: { plan: { write: false, approvalRequired: false }, build: { write: "workspace", approvalRequired: true } }, limits: { maxRounds: 6, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 15000 }, approval: { ttlMs: 60000 } });
await saveConfig("sources", { version: 1, explicit: ["models", "routing", "permissions", "sources"].map((name) => ({ id: `control.${name}`, path: `config/control-center/${name}.json`, label: name, kind: "json", scope: "repo", critical: true })), discover: [], runtime: [] });
const requests = [];
const piece = (text, finish = null) => `data: ${JSON.stringify({ model: "qa-text", choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] })}\n\n`;
const upstream = createServer(async (req, res) => {
  let raw = ""; for await (const bytes of req) raw += bytes;
  let body; try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
  requests.push(body);
  const prompt = body.messages.at(-1).content;
  if (prompt.includes("测试失败")) { res.writeHead(429); res.end("private-upstream-error"); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (prompt.includes("测试停止")) { res.write(piece("这是一段尚未完成的回答，请点击停止。")); return; }
  res.write(piece("正在整理这段对话。"));
  await new Promise((r) => setTimeout(r, 900));
  res.end(piece(prompt.includes("什么颜色") ? "你之前告诉我的颜色是蓝色。" : "我记住了：蓝色。", "stop")
    + 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":9,"total_tokens":19}}\n\n'
    + "data: [DONE]\n\n");
});
upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
const token = "api-chat-isolated-qa-token";
const env = { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_PORT: "0", CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_REPO_ROOT: repoRoot, CONTROL_CENTER_TEST_REPO_ROOT: repoRoot, CONTROL_CENTER_RUNTIME_HOME: runtimeRoot };
let child; let browser; let page; let origin;
const report = { ok: false, realProvider: false, formalRuntime: false, checks: [], screenshots: [], errors: [] };
const api = async (path, body, method = body ? "POST" : "GET") => {
  const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`); return value;
};
const until = async (operation, label) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const result = await operation(); if (result) return result; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error(`timeout: ${label}`);
};
try {
  child = spawnTestServer({ env }); origin = new URL(await waitForUrl(child)).origin;
  const provider = await api("/api/providers", { name: "隔离文本连接", providerType: "openai-compatible", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: "qa-local-key-only", apps: { codex: true } });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.addInitScript((value) => { sessionStorage.setItem("514cc-control-token", value); localStorage.setItem("514cc-product-tour-dismissed", "1"); localStorage.setItem("514cc-bot-ops-collapsed", "1"); }, token);
  await page.goto(`${origin}/#team`, { waitUntil: "domcontentloaded" });
  await page.locator("#team-surface-members-tab").click();
  await page.locator("#member-new-button").click();
  await page.locator("#member-new-runtime-button").click();
  await page.locator("#runtime-seat-id-input").fill("qa-text-seat");
  await page.locator("#runtime-seat-label-input").fill("文本助手连接");
  await page.locator("#runtime-seat-role-input").fill("文本聊天");
  await page.locator("#runtime-seat-adapter-select").selectOption("api-chat");
  await page.locator("#runtime-seat-provider-select").selectOption(provider.id);
  await page.locator("#runtime-seat-model-input").fill("qa-text");
  assert.equal(await page.locator("#runtime-seat-command-input").isDisabled(), true);
  assert.equal(await page.locator("#runtime-seat-effort-input").isDisabled(), true);
  await page.screenshot({ path: resolve(output, "api-seat-configuration.png") }); report.screenshots.push("api-seat-configuration.png");
  const saved = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/runtime-seats" && res.request().method() === "POST");
  await page.locator('#runtime-seat-form button[type="submit"]').click();
  const receipt = await saved; assert.equal(receipt.status(), 201, JSON.stringify(await receipt.json()));
  const member = await api("/api/team-members", { label: "隔离文本助手", runtimeProfileId: "qa-text-seat" });
  report.checks.push("create-api-seat-through-real-form-with-no-command");
  await page.goto(`${origin}/#bot`, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#bot-new-conversation-button").click();
  const dialog = page.locator("#assistant-start-dialog");
  await dialog.locator("[data-assistant-members]").selectOption(member.id);
  await dialog.locator("[data-assistant-title]").fill("直连文本验收");
  await dialog.locator("[data-assistant-create]").click();
  await dialog.waitFor({ state: "hidden" });
  const conversation = (await api("/api/conversations")).conversations.find((item) => item.title === "直连文本验收");
  assert.ok(conversation);
  const send = async (prompt) => { await page.locator("#bot-composer-input").fill(prompt); await page.locator("#bot-composer-input").press("Enter"); };
  const latest = async () => {
    const c = (await api("/api/conversations")).conversations.find((item) => item.id === conversation.id);
    if (!c?.activeRunId) return null;
    const value = await api(`/api/runs/${c.activeRunId}`); return value.run || value;
  };
  await send("请记住我的颜色是蓝色");
  await page.locator("#bot-message-stream .live-delta-bubble").filter({ hasText: "正在整理" }).waitFor({ state: "visible", timeout: 20000 });
  await page.screenshot({ path: resolve(output, "api-streaming.png") }); report.screenshots.push("api-streaming.png");
  const first = await until(async () => { const run = await latest(); return run?.status === "succeeded" && run; }, "first answer");
  assert.equal(first.turns.length, 1); assert.equal(first.turns[0].tokens, 19); assert.equal(first.turns[0].costUsd, null);
  assert.equal(first.turns[0].sessionId, null);
  assert.deepEqual(first.teamRoster.map((item) => item.id), [member.id]);
  report.checks.push("live-stream-to-success-with-usage-and-no-native-session");
  await stopTestServer(child, { base: origin, token }); child = null;
  child = spawnTestServer({ env }); origin = new URL(await waitForUrl(child)).origin;
  await page.goto(`${origin}/#bot`, { waitUntil: "domcontentloaded" });
  await page.locator(`[data-bot-conversation="${conversation.id}"]`).click();
  await send("我之前说的是什么颜色");
  const second = await until(async () => { const run = await latest(); return run?.id !== first.id && run?.status === "succeeded" && run; }, "persisted followup");
  assert.notEqual(second.id, first.id);
  assert.deepEqual(requests[1].messages.filter((m) => m.role !== "system").map((m) => m.content), ["请记住我的颜色是蓝色", "正在整理这段对话。我记住了：蓝色。", "我之前说的是什么颜色"]);
  await page.getByText("你之前告诉我的颜色是蓝色。", { exact: false }).first().waitFor({ state: "visible" });
  // 完成尾注文案以 app.js runCompletionMarkup 为准（提交版恒为「任务完成」）。
  // 原期望「回答完成」与实机文案从未匹配（本脚本未入 git，从出生起此断言即红），
  // D-2026-09-28-012 对齐；真意图是下方「文本完成不挂结算/save-skill 卡」。
  await page.locator("#bot-message-stream .run-end-note").filter({ hasText: "任务完成" }).waitFor({ state: "visible" });
  assert.equal(await page.locator("#bot-message-stream .live-delta-bubble:not([hidden])").count(), 0);
  assert.equal(await page.locator("#bot-message-stream .settlement-card, #bot-message-stream [data-bot-card=save-skill]").count(), 0);
  report.checks.push("text-completion-has-no-worktree-settlement-or-save-skill-card");
  await page.screenshot({ path: resolve(output, "api-followup-after-restart.png") }); report.screenshots.push("api-followup-after-restart.png");
  report.checks.push("restart-restores-server-history-and-followup-creates-next-run");
  await send("测试停止");
  await page.locator("#bot-message-stream .live-delta-bubble").filter({ hasText: "尚未完成" }).waitFor({ state: "visible" });
  await page.locator(".bot-send-button[data-mode=stop]").click();
  await until(async () => (await latest())?.status === "interrupted", "interrupted run");
  report.checks.push("stop-interrupts-active-http-request-and-allows-continuation");
  await send("测试失败");
  const failed = await until(async () => { const run = await latest(); return run?.status === "failed" && run; }, "HTTP failure");
  assert.ok(!failed.turns.some((turn) => turn.outcome === "completed"));
  assert.equal(requests.length, 4);
  assert.ok(!requests[3].messages.some((item) => item.content.includes("测试停止") || item.content.includes("尚未完成")));
  assert.doesNotMatch(JSON.stringify(failed), /private-upstream-error|qa-local-key-only/);
  await page.locator(".bot-send-button[data-mode=send]").waitFor({ state: "visible" });
  await page.screenshot({ path: resolve(output, "api-error.png") }); report.screenshots.push("api-error.png");
  report.checks.push("upstream-rejection-is-failed-with-no-auto-retry");
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 1, `overflow ${width}: ${overflow}`);
    await page.screenshot({ path: resolve(output, `api-chat-${width}.png`) }); report.screenshots.push(`api-chat-${width}.png`);
  }
  assert.deepEqual(report.errors, []);
  report.ok = true;
} catch (error) {
  report.failure = error.stack;
  if (page) await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  report.requests = requests.length;
  await browser?.close();
  if (child) await stopTestServer(child, { base: origin, token }).catch((e) => { report.shutdownError = e.message; report.ok = false; process.exitCode = 1; });
  upstream.closeAllConnections(); await new Promise((r) => upstream.close(r));
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((error) => console.error(`isolated cleanup: ${error.code}; retained ${root}`));
}
