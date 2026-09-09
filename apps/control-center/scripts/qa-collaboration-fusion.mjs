#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { writeConfig } from "./qa-ui-fixture.mjs";
import { spawnTestServer, stopTestServer, waitForUrl, testModelProfiles } from "../tests/server-fixture.mjs";

const outputDir = resolve(process.argv.find((arg) => arg.startsWith("--output-dir="))?.slice(13) || resolve(tmpdir(), `514cc-fusion-qa-${Date.now()}`));
const serve = process.argv.includes("--serve");
const root = await mkdtemp(resolve(tmpdir(), "514cc-fusion-"));
const repo = resolve(root, "repo");
const home = resolve(root, "home");
const token = "fusion-isolated-fixture-0123456789abcdef";
await writeConfig(repo, serve ? { profiles: testModelProfiles().map((profile) => ({ ...profile, command: profile.command == null ? null : resolve(home, "providers-disabled", "cli.exe"), capabilities: ["*"] })) } : {});
await mkdir(home, { recursive: true });
await mkdir(outputDir, { recursive: true });
const report = { ok: false, boundary: "isolated server and real browser; message execution response replaced with persisted execute:false Run; no real provider", checks: [], layouts: [], errors: [] };
const server = spawnTestServer({ env: { CONTROL_CENTER_TEST_REPO_ROOT: repo, CONTROL_CENTER_DATA_DIR: resolve(root, "data"), CONTROL_CENTER_RUNTIME_HOME: home, HOME: home, USERPROFILE: home, CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_PORT: "0", ...(serve ? { GROK_SEARCH_RS_COMPAT_API_URL: "", GROK_SEARCH_RS_COMPAT_API_KEY: "", GROK_SEARCH_RS_COMPAT_MODEL: "" } : {}) } });
let browser;
let page;
const deferredResolvers = [];
try {
  const origin = new URL(await waitForUrl(server)).origin;
  const api = async (path, method = "GET", body) => {
    const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  };
  const createConversation = async (title, member = "codex-technical") => (await api("/api/conversations", "POST", { kind: "direct", title, directMemberId: member })).conversation;
  const a = await createConversation("接口与会话隔离重构");
  const b = await createConversation("独立评审与验证");
  const hidden = await createConversation("隐藏的协作记录");
  const tombstone = await createConversation("已删除的审计引用");
  await api(`/api/conversations/${hidden.id}`, "PATCH", { expectedRevision: hidden.revision, hidden: true });
  await api(`/api/conversations/${tombstone.id}`, "DELETE", { expectedRevision: tombstone.revision });
  const project = (await api("/api/projects", "POST", { cwd: repo, title: "协作体系融合" })).project;
  const group = (await api("/api/conversations", "POST", { kind: "workspace_group", title: "共享协作流程", projectId: project.projectId, roomRole: "task", memberIds: ["claude-fable", "codex-technical"] })).conversation;
  const createRun = (conversation, prompt) => api("/api/runs", "POST", {
    prompt, execute: false, permissionMode: "plan", conversationId: conversation.id,
    conversationKind: conversation.kind, orchestrationMode: conversation.kind === "direct" ? "pipeline" : "social",
    startAgentId: conversation.directMemberId || "claude-fable",
    ...(conversation.kind === "workspace_group" ? { ephemeralTeam: { name: "QA collaboration", coordinator: "claude-fable", members: ["claude-fable", "codex-technical"], skills: [], mcp: [], providers: {} } } : {}),
  });
  const history = await createRun(a, "HISTORICAL_A_MARKER");
  await createRun(a, "CURRENT_A_MARKER");
  await createRun(b, "CURRENT_B_MARKER");
  const groupRun = await createRun(group, "先核对共享身份，再完成独立评审；执行责任与协调角色分别记录。");
  if (serve) {
    process.stdout.write(`Bot preview: ${origin}/#bot?conversation=${group.id}&tab=process\nFixture root: ${root}\n`);
    await new Promise((done) => { process.once("SIGINT", done); process.once("SIGTERM", done); server.once("exit", done); });
  } else {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.addInitScript((value) => sessionStorage.setItem("514cc-control-token", value), token);
  const hash = (id, tab = "conversation", run = "") => `#bot?conversation=${id}&tab=${tab}${run ? `&run=${run}` : ""}`;
  const ready = async () => { await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 30000 }); await page.waitForSelector("#view-bot.is-active #bot-composer-input"); };
  const check = (label) => { report.checks.push(label); process.stdout.write(`PASS ${label}\n`); };
  await page.goto(origin + "/");
  await ready();
  assert.ok(new URL(page.url()).hash.startsWith("#bot"));
  assert.equal(await page.locator('[data-view="experience"], [data-workspace-view="experience"]').count(), 0);
  assert.equal(await page.evaluate(async () => "experience" in (await import("/state.js")).VIEW_TITLES), false);
  await page.goto(`${origin}/?qa=group-cold#bot?conversation=${group.id}&run=${groupRun.id}&tab=process`);
  await ready();
  await page.waitForSelector('#workspace-tab-process[aria-selected="true"]');
  await page.waitForFunction((id) => document.querySelector("#workspace-run-select")?.value === id, groupRun.id);
  check("cold group routes wait for the member catalog and retain their Run and tab");
  await page.goto(`${origin}/#experience?conversation=${a.id}&run=${history.id}&tab=results`);
  await page.reload();
  await ready();
  await page.waitForSelector('#workspace-tab-results[aria-selected="true"]');
  assert.ok(new URL(page.url()).hash.startsWith("#bot?"));
  assert.equal(await page.locator("#workspace-run-select").inputValue(), history.id);
  await page.goto(`${origin}/#config/providers`);
  await page.reload();
  await page.waitForSelector("#api-connection-badge.is-ok");
  await page.waitForSelector("#view-config.is-active");
  assert.equal(new URL(page.url()).hash.split("?")[0], "#config/sources");
  await page.goto(`${origin}/#config/hooks`);
  await page.reload();
  await page.waitForSelector("#view-config.is-active");
  await page.waitForSelector("#api-connection-badge.is-ok");
  assert.equal(new URL(page.url()).hash, "#config/hooks");
  await page.goto(`${origin}/#conversation=${a.id}&run=${history.id}`);
  await page.reload();
  await ready();
  await page.waitForFunction((id) => document.querySelector("#workspace-run-select")?.value === id, history.id);
  assert.ok(new URL(page.url()).hash.startsWith("#bot?"));
  await page.evaluate((id) => { location.hash = `#conversation=${id}`; }, b.id);
  await page.waitForFunction(() => document.querySelector("#bot-conversation-title")?.textContent === "独立评审与验证");
  await page.evaluate(({ conversation, run }) => { location.hash = `#conversation=${conversation}&run=${run}`; }, { conversation: a.id, run: history.id });
  await page.waitForFunction((id) => document.querySelector("#workspace-run-select")?.value === id, history.id);
  check("legacy Conversation plus historical Run survives cold start and hash navigation");
  await page.locator("#workspace-tab-results").click();
  const returnRoute = new URL(page.url()).hash;
  await page.locator(".workspace-advanced-mode").click();
  await page.waitForSelector("#view-workbench.is-active");
  await page.locator("#chrome-nav-back").click();
  await page.waitForSelector('#workspace-tab-results[aria-selected="true"]');
  assert.equal(new URL(page.url()).hash, returnRoute);
  await page.locator("#chrome-nav-forward").click();
  await page.waitForSelector("#view-workbench.is-active");
  check("advanced Workbench and shell back/forward retain the complete Bot reading context");

  const slowPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await slowPage.addInitScript((value) => sessionStorage.setItem("514cc-control-token", value), token);
  let releaseHealth;
  await slowPage.route("**/api/health", async (route) => {
    await new Promise((resolve) => { releaseHealth = resolve; deferredResolvers.push(resolve); });
    await route.continue();
  });
  await slowPage.goto(`${origin}/#conversation=${a.id}&run=${history.id}`);
  await slowPage.waitForFunction((id) => document.querySelector("#workspace-run-select")?.value === id, history.id);
  await slowPage.locator("#workspace-run-select").selectOption("");
  await slowPage.locator("#workspace-tab-process").click();
  const userRoute = new URL(slowPage.url()).hash;
  const healthFinished = slowPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/health");
  releaseHealth();
  await healthFinished;
  await slowPage.waitForSelector("#api-connection-badge.is-ok");
  await slowPage.waitForTimeout(500);
  assert.equal(new URL(slowPage.url()).hash, userRoute);
  assert.equal(await slowPage.locator("#workspace-run-select").inputValue(), "");
  await slowPage.close();
  check("slow bootstrap never replays the initial Run or tab over a newer user selection");
  check("Bot is the only work entry; cold legacy experience and config routes survive bootstrap");
  await page.goto(origin + "/" + hash(a.id));
  await ready();
  await page.waitForFunction(() => document.querySelector("#bot-conversation-title")?.textContent === "接口与会话隔离重构");
  const input = page.locator("#bot-composer-input");
  await input.fill("A 的中文草稿");
  await page.evaluate(() => { window.__composerIdentity = document.querySelector("#bot-composer-form"); document.querySelector("#bot-composer-input").setSelectionRange(2, 6); });
  await page.locator("#workspace-tab-process").click();
  await page.locator("#workspace-tab-results").click();
  await page.locator("#workspace-tab-conversation").click();
  assert.equal(await input.inputValue(), "A 的中文草稿");
  assert.deepEqual(await input.evaluate((element) => [element.selectionStart, element.selectionEnd]), [2, 6]);
  assert.equal(await page.evaluate(() => window.__composerIdentity === document.querySelector("#bot-composer-form")), true);
  await page.locator(`[data-bot-conversation="${b.id}"]`).first().click();
  await input.fill("B 的独立草稿");
  await page.locator(`[data-bot-conversation="${a.id}"]`).first().click();
  assert.equal(await input.inputValue(), "A 的中文草稿");
  await page.reload();
  await ready();
  assert.equal(await input.inputValue(), "A 的中文草稿");
  check("one host, stable composer, Conversation-isolated drafts and refresh recovery");

  const submissions = [];
  let release = null;
  let defer = false;
  let fail = false;
  await page.route("**/api/conversations/*/messages", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const conversationId = new URL(request.url()).pathname.split("/")[3];
    const body = request.postDataJSON();
    submissions.push({ conversationId, body });
    if (fail) return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"message":"QA admission failure"}}' });
    if (defer) await new Promise((resolve) => { release = resolve; deferredResolvers.push(resolve); });
    const conversation = (await api(`/api/conversations/${conversationId}`)).conversation;
    const run = await createRun(conversation, body.prompt);
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(run) });
  });
  const priorAdvancedSelection = await page.evaluate(async () => (await import("/state.js")).state.selectedRunId);
  await input.evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
  await page.waitForTimeout(100);
  assert.equal(submissions.length, 0);
  check("IME confirmation Enter does not submit a message");
  defer = true;
  await input.fill("已受理后应从 A 草稿消费");
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelector("#workspace-admission")?.textContent === "提交中");
  await page.locator(`[data-bot-conversation="${b.id}"]`).first().click();
  assert.equal(await input.inputValue(), "B 的独立草稿");
  release();
  defer = false;
  await page.waitForFunction((id) => sessionStorage.getItem(`514cc.conversation-draft.v2:${encodeURIComponent(id)}`) === "", a.id);
  assert.equal(await input.inputValue(), "B 的独立草稿");
  await page.locator(`[data-bot-conversation="${a.id}"]`).first().click();
  assert.equal(await input.inputValue(), "");
  assert.equal(await page.evaluate(async () => (await import("/state.js")).state.selectedRunId), priorAdvancedSelection);
  assert.equal(submissions[0].conversationId, a.id);
  assert.equal(submissions[0].body.runId, undefined);
  check("direct Conversation admission does not hijack Workbench selection or another draft");

  fail = true;
  await input.fill("失败后保留这份草稿");
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelector("#workspace-admission")?.textContent.includes("QA admission failure"));
  assert.equal(await input.inputValue(), "失败后保留这份草稿");
  const attempts = submissions.length;
  await page.waitForTimeout(250);
  assert.equal(submissions.length, attempts);
  fail = false;
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelector("#bot-composer-input")?.value === "");
  check("failure retains draft and only explicit resubmission retries");

  let releaseHistory;
  // Keep one real persisted Run out of the list projection so its detail must
  // take the asynchronous lookup path, not a previously warmed snapshot.
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, runs: data.runs.filter((run) => run.prompt !== "UNCACHED_HISTORY_LOOKUP") } });
  });
  const delayedHistory = await createRun(a, "UNCACHED_HISTORY_LOOKUP");
  await createRun(a, "CURRENT_AFTER_LOOKUP");
  await page.locator("[data-workspace-refresh]").click();
  await page.waitForFunction((id) => [...document.querySelector("#workspace-run-select").options].some((option) => option.value === id), delayedHistory.id);
  await page.route(`**/api/runs/${delayedHistory.id}`, async (route) => {
    await new Promise((resolve) => { releaseHistory = resolve; deferredResolvers.push(resolve); });
    await route.continue();
  });
  const historyRequest = page.waitForRequest((request) => new URL(request.url()).pathname === `/api/runs/${delayedHistory.id}`);
  await page.locator("#workspace-run-select").selectOption(delayedHistory.id);
  await historyRequest;
  await page.locator("#workspace-run-select").selectOption("");
  releaseHistory();
  await page.waitForTimeout(400);
  assert.equal(await page.locator("#workspace-run-select").inputValue(), "");
  assert.equal(await page.locator("#workspace-history-notice").isVisible(), false);
  await page.unroute(`**/api/runs/${delayedHistory.id}`);
  await page.unroute("**/api/runs");
  check("late historical lookup cannot undo a newer current-run selection");

  await page.locator("#workspace-run-select").selectOption(history.id);
  await page.waitForFunction(() => document.querySelector("#workspace-history-notice")?.hidden === false);
  await input.fill("从历史视图继续当前工作对话");
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelector("#bot-composer-input")?.value === "");
  assert.equal(submissions.at(-1).conversationId, a.id);
  assert.equal(submissions.at(-1).body.runId, undefined);
  assert.ok(new URL(page.url()).hash.startsWith("#bot"));
  check("historical Run is a read scope, not a message target");

  await page.addInitScript(() => {
    if (new URL(location.href).searchParams.get("qa") === "first-contact") {
      sessionStorage.removeItem("514cc.experience-view.v1");
      sessionStorage.removeItem("514cc.bot-workspace-view.v1");
    }
  });
  await page.goto(`${origin}/?qa=first-contact#bot`);
  await ready();
  await input.fill("FIRST_CONTACT_TEXT");
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelector("#bot-composer-input")?.value === "");
  assert.equal(submissions.at(-1).body.prompt, "FIRST_CONTACT_TEXT");
  assert.equal((await api(`/api/conversations/${submissions.at(-1).conversationId}`)).conversation.directMemberId, "claude-fable");
  check("first contact keeps text across creation and admission");

  const performance = await page.evaluate(async () => {
    const { reconcileMessageMarkup, createMessageWindow } = await import("/modules/bounded-message-view.js");
    const host = document.createElement("div");
    document.body.append(host);
    const window = createMessageWindow();
    const messages = Array.from({ length: 5000 }, (_, index) => ({ key: `message-${index}` }));
    const render = (tail) => `<section class="bot-activity-group">${window.page(messages).visible.map((message) => `<article data-bot-event-key="${message.key}"><p>stable ${message.key}</p></article>`).join("")}<p data-stream-key="tail">${tail}</p></section>`;
    reconcileMessageMarkup(host, render("start"));
    const node = host.querySelector("article");
    let mutationCount = 0;
    const observer = new MutationObserver((records) => { mutationCount += records.length; });
    observer.observe(host, { childList: true, subtree: true });
    const start = performance.now();
    const samples = [];
    for (let index = 0; index < 30; index++) {
      const tick = performance.now();
      reconcileMessageMarkup(host, render(`delta-${index}`));
      samples.push(performance.now() - tick);
      await new Promise(requestAnimationFrame);
    }
    const result = { staticNodePreserved: node === host.querySelector("article"), childListMutations: mutationCount + observer.takeRecords().length, messages: host.querySelectorAll("article").length, durationMs: performance.now() - start, maxUpdateMs: Math.max(...samples), meanUpdateMs: samples.reduce((sum, value) => sum + value, 0) / samples.length };
    host.append(document.createElement("aside"));
    await new Promise(requestAnimationFrame);
    result.mutationDetectorActive = mutationCount > result.childListMutations;
    observer.disconnect();
    host.remove();
    return result;
  });
  assert.equal(performance.staticNodePreserved, true);
  assert.equal(performance.childListMutations, 0);
  assert.equal(performance.messages, 160);
  assert.equal(performance.mutationDetectorActive, true);
  report.performance = performance;
  check("5,000-message source stays at 160 DOM rows; 30 deltas preserve nested static nodes");

  const streamingConversation = (await api(`/api/conversations/${group.id}`)).conversation;
  const streamingRun = await api(`/api/runs/${streamingConversation.activeRunId}`);
  const liveRun = { ...streamingRun, status: "running", updatedAt: new Date().toISOString(), turnAttempts: [{ agentId: "claude-fable", phase: "submitted", updatedAt: new Date().toISOString() }] };
  liveRun.taskGraph = {
    tasks: Array.from({ length: 1000 }, (_, index) => ({ id: `fixture-task-${index}`, title: `Task ${index}`, status: "queued", assigneeId: "claude-fable" })),
    delegations: Array.from({ length: 1000 }, (_, index) => ({ id: `fixture-edge-${index}`, fromAgentId: "claude-fable", toAgentId: "codex-technical", state: "queued" })),
  };
  const streamPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  streamPage.on("pageerror", (error) => report.errors.push(`stream: ${error.message}`));
  await streamPage.addInitScript(({ token, runId }) => {
    sessionStorage.setItem("514cc-control-token", token);
    const fetchOriginal = window.fetch.bind(window);
    let controller;
    const encoder = new TextEncoder();
    window.__fusionSent = 0;
    window.__fusionLongTasks = [];
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      new PerformanceObserver((list) => window.__fusionLongTasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })))).observe({ type: "longtask", buffered: true });
    }
    window.fetch = (input, init) => {
      const path = new URL(typeof input === "string" ? input : input.url, location.href).pathname;
      if (path === "/api/events") return Promise.resolve(new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "content-type": "text/event-stream" } }));
      return fetchOriginal(input, init);
    };
    window.__fusionStart = () => {
      window.__fusionStartAt = performance.now();
      const pump = () => {
        const index = ++window.__fusionSent;
        const envelope = { eventId: `fusion-delta-${index}`, type: "codex.item/agentMessage/delta", occurred_at: new Date().toISOString(), sequence: 100 + index, runId, agentId: "claude-fable", data: { delta: `piece-${index} ` } };
        controller.enqueue(encoder.encode(`id: ${envelope.sequence}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`));
        if (index < 30) setTimeout(pump, 40);
      };
      pump();
    };
  }, { token, runId: liveRun.id });
  await streamPage.route("**/api/runs", (route) => route.fulfill({ json: { runs: [liveRun] } }));
  await streamPage.route("**/api/conversations?*", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, conversations: [...data.conversations, ...Array.from({ length: 1000 }, (_, index) => ({ id: `fixture-conversation-${index}`, kind: "direct", title: `Indexed conversation ${index}`, directMemberId: "codex-technical", memberIds: ["codex-technical"], runIds: [], activeRunId: null }))] } });
  });
  await streamPage.route(`**/api/runs/${liveRun.id}/events**`, (route) => route.fulfill({ json: { events: [{ eventId: "fusion-seed", type: "assistant.message", occurred_at: new Date().toISOString(), sequence: 1, runId: liveRun.id, agentId: "claude-fable", data: { text: "稳定历史消息" } }] } }));
  await streamPage.goto(origin + "/" + hash(group.id));
  await streamPage.waitForSelector("#api-connection-badge.is-ok");
  await streamPage.waitForSelector('#bot-message-stream [data-bot-event-key="fusion-seed"]');
  await streamPage.locator("#bot-composer-input").fill("流式更新期间保留的草稿");
  await streamPage.evaluate(() => {
    window.__fusionSeed = document.querySelector('[data-bot-event-key="fusion-seed"]');
    window.__fusionComposer = document.querySelector("#bot-composer-form");
    window.__fusionCommits = 0;
    new MutationObserver((records) => { window.__fusionCommits += records.length; }).observe(document.querySelector("#bot-message-stream"), { childList: true });
    window.__fusionStart();
  });
  await streamPage.waitForFunction(() => window.__fusionSent >= 6 && window.__fusionSent < 30 && document.querySelector("#bot-message-stream .live-delta-bubble")?.textContent.includes("piece-1"));
  await streamPage.waitForFunction(() => window.__fusionSent === 30 && document.querySelector("#bot-message-stream .live-delta-bubble")?.textContent.includes("piece-30"));
  const streamEvidence = await streamPage.evaluate(() => ({
    sent: window.__fusionSent, commits: window.__fusionCommits,
    seedPreserved: window.__fusionSeed === document.querySelector('[data-bot-event-key="fusion-seed"]'),
    composerPreserved: window.__fusionComposer === document.querySelector("#bot-composer-form"),
    draft: document.querySelector("#bot-composer-input").value,
    longTasks: window.__fusionLongTasks.filter((entry) => entry.startTime >= window.__fusionStartAt && entry.duration >= 50),
  }));
  assert.equal(streamEvidence.commits, 0);
  assert.equal(streamEvidence.seedPreserved && streamEvidence.composerPreserved, true);
  assert.equal(streamEvidence.draft, "流式更新期间保留的草稿");
  report.streaming = streamEvidence;
  await streamPage.screenshot({ path: resolve(outputDir, "streaming.png") });
  assert.ok(await streamPage.locator("#bot-project-tree [data-bot-conversation]").count() <= 100);
  await streamPage.locator('[data-workspace-conversations-page="1"]').click();
  assert.ok(await streamPage.locator("#bot-project-tree [data-bot-conversation]").count() <= 100);
  await streamPage.locator("#workspace-tab-process").click();
  assert.equal(await streamPage.locator("#workspace-insights [data-bot-task-id]").count(), 50);
  assert.equal(await streamPage.locator("#workspace-insights [data-bot-delegation-id]").count(), 50);
  await streamPage.locator('[data-workspace-graph-page="tasks"][data-direction="1"]').click();
  assert.equal(await streamPage.locator("#workspace-insights [data-bot-task-id]").first().getAttribute("data-bot-task-id"), "fixture-task-50");
  await streamPage.close();
  check("real browser SSE pump paints before stream ends without replacing history or composer");
  check("large Conversation index and 1,000-task/1,000-delegation graph stay paginated and navigable");

  await page.goto(origin + "/" + hash(group.id));
  await ready();
  await page.locator(".workspace-filter-menu summary").click();
  await page.locator("#workspace-project-filter").selectOption(project.projectId);
  assert.equal(await page.locator("#bot-project-tree [data-bot-conversation]").count(), 1);
  await page.locator("#workspace-project-filter").selectOption("");
  await page.locator("#workspace-show-inactive").uncheck();
  assert.equal(await page.locator(`[data-bot-conversation="${hidden.id}"]`).count(), 0);
  await page.locator("#workspace-show-inactive").check();
  await page.locator(".workspace-filter-menu summary").press("Escape");
  assert.equal(await page.locator(".workspace-filter-menu").evaluate((node) => node.open), false);
  assert.equal(await page.locator(`[data-bot-conversation="${tombstone.id}"]`).isDisabled(), true);
  await page.locator(`[data-bot-conversation="${hidden.id}"]`).click();
  await page.waitForFunction(() => document.querySelector("#bot-conversation-title")?.textContent === "隐藏的协作记录");
  assert.equal((await api(`/api/conversations/${hidden.id}`)).conversation.hiddenAt, null);
  check("exact project filters, inactive toggle, real hidden restore and tombstone protection remain available");

  await page.locator(`[data-bot-conversation="${group.id}"]`).click();
  await page.locator("#workspace-members-edit").click();
  const editor = page.locator("#workspace-members-dialog");
  await editor.locator('input[value="codex-technical"]').uncheck();
  await editor.locator("[data-workspace-members-save]").click();
  await page.waitForFunction(() => !document.querySelector("#workspace-members-dialog").open);
  let memberState = (await api(`/api/conversations/${group.id}`)).conversation;
  assert.deepEqual(memberState.memberIds, ["claude-fable"]);
  assert.equal(memberState.activeRunId, null);
  assert.ok(memberState.runIds.includes(groupRun.id));
  await page.locator("#workspace-members-edit").click();
  await editor.locator('input[value="codex-technical"]').check();
  await editor.locator("[data-workspace-members-save]").click();
  await page.waitForFunction(() => !document.querySelector("#workspace-members-dialog").open);
  memberState = (await api(`/api/conversations/${group.id}`)).conversation;
  await page.locator("#workspace-members-edit").click();
  await api(`/api/conversations/${group.id}`, "PATCH", { expectedRevision: memberState.revision, title: "并发更新的标题" });
  await editor.locator('input[value="codex-technical"]').uncheck();
  await editor.locator("[data-workspace-members-save]").click();
  await page.waitForFunction(() => document.querySelector("[data-workspace-members-status]")?.textContent.startsWith("成员未保存"));
  memberState = (await api(`/api/conversations/${group.id}`)).conversation;
  assert.deepEqual(memberState.memberIds, ["claude-fable", "codex-technical"]);
  await editor.locator("[data-workspace-members-close]").first().click();
  await api(`/api/conversations/${group.id}`, "PATCH", { expectedRevision: memberState.revision, title: "共享协作流程" });
  await createRun(group, "新的协作上下文；既有成员和历史执行独立保留。");
  await page.locator("[data-workspace-refresh]").click();
  check("member edits persist through revision CAS, retain historical Runs, and reject concurrent overwrite");

  await page.goto(origin + "/" + hash(group.id));
  await ready();
  await page.waitForFunction(() => document.querySelector("#bot-conversation-title")?.textContent === "共享协作流程");
  await input.fill("工作对话共享同一草稿");
  await page.waitForFunction(() => !document.querySelector("#toast-region")?.children.length);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [1440, 1024, 820, 768, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const tab of ["conversation", "process", "results"]) {
        await page.locator(`#workspace-tab-${tab}`).click();
        const layout = await page.evaluate(() => {
          const input = document.querySelector("#bot-composer-input");
          const rect = input.getBoundingClientRect();
          return { width: innerWidth, bodyWidth: document.body.scrollWidth, bottom: rect.bottom, height: innerHeight, inputVisible: rect.width > 0 && rect.height > 0, value: input.value, duplicateComposer: document.querySelectorAll("#bot-composer-form").length };
        });
        assert.ok(layout.bodyWidth <= width + 1, JSON.stringify(layout));
        assert.ok(layout.inputVisible && layout.bottom <= layout.height, JSON.stringify(layout));
        assert.equal(layout.value, "工作对话共享同一草稿");
        assert.equal(layout.duplicateComposer, 1);
        report.layouts.push({ theme, tab, ...layout });
        await page.screenshot({ path: resolve(outputDir, `${theme}-${width}-${tab}.png`) });
      }
      if (width <= 820) {
        await page.locator("#bot-mobile-back").click();
        assert.equal(await input.isVisible(), false);
        assert.equal(await page.locator("#bot-agent-search").isVisible(), true);
        assert.equal(await page.locator('.workspace-secondary-navigation [data-workspace-view="workbench"]').isVisible(), true);
        const collision = await page.evaluate(() => {
          const header = document.querySelector(".bot-roster-header").getBoundingClientRect();
          const footer = document.querySelector(".bot-roster-footer").getBoundingClientRect();
          return header.bottom > footer.top || footer.bottom > innerHeight;
        });
        assert.equal(collision, false);
        await page.screenshot({ path: resolve(outputDir, `${theme}-${width}-list.png`) });
        await page.locator("#mobile-menu-button").click();
        await page.waitForSelector(".app-shell.nav-open");
        assert.equal(await page.locator('#sidebar [data-view="team"]').isVisible(), true);
        await page.keyboard.press("Escape");
        await page.locator(`[data-bot-conversation="${group.id}"]`).click();
        assert.equal(await input.isVisible(), true);
      }
    }
  }
  check("30 responsive/theme/tab layouts keep composer visible and unchanged");
  check("mobile list, footer, full navigation and return-to-chat remain visible and keyboard accessible");
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const view of ["overview", "bot", "workbench", "team", "channels", "config", "router", "security", "observability", "sessions", "bootstrapper", "office", "automations", "market", "hosts", "hero", "appearance", "browser"]) {
    await page.goto(`${origin}/#${view}`);
    const target = ["router", "hero"].includes(view) ? "team" : view === "automations" ? "workbench" : view;
    await page.waitForSelector(`#view-${target}.is-active`);
  }
  check("18 legacy full-page destinations still resolve after the canonical-host fusion");
  assert.deepEqual(report.errors, []);
  report.ok = true;
  }
} catch (error) {
  report.failure = error.stack || String(error);
  process.stderr.write(`${report.failure}\n`);
  if (page) await page.screenshot({ path: resolve(outputDir, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  deferredResolvers.forEach((release) => release());
  await page?.unrouteAll({ behavior: "wait" }).catch(() => {});
  await browser?.close();
  await stopTestServer(server, { token }).catch((error) => { report.cleanupError = error.message; report.ok = false; process.exitCode = 1; });
  await writeFile(resolve(outputDir, "report.json"), JSON.stringify(report, null, 2));
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  process.stdout.write(`Fusion QA: ${JSON.stringify({ ok: report.ok, checks: report.checks.length, layouts: report.layouts.length, outputDir })}\n`);
}
