import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, request as proxyRequest } from "node:http";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { writeConfig } from "./qa-ui-fixture.mjs";
import { spawnTestServer, stopTestServer, waitForUrl, testModelProfiles } from "../tests/server-fixture.mjs";

const serve = process.argv.includes("--serve");
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(appRoot, ".qa-output/collaboration-methods-20260907");
const fixture = await mkdtemp(resolve(tmpdir(), "514cc-methods-"));
const repo = resolve(fixture, "repo");
const runtimeHome = resolve(fixture, "home");
const token = randomBytes(32).toString("hex");
await mkdir(output, { recursive: true });
await mkdir(runtimeHome, { recursive: true });
await writeConfig(repo, { profiles: testModelProfiles().map((profile) => ({ ...profile, command: resolve(runtimeHome, "unavailable-cli.exe"), capabilities: ["*"] })) });
await mkdir(resolve(repo, "schemas/control-center"), { recursive: true });
await copyFile(resolve(appRoot, "../../schemas/control-center/contracts.schema.json"), resolve(repo, "schemas/control-center/contracts.schema.json"));
const env = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
for (const [key, value] of Object.entries(process.env)) if (/^(SystemRoot|windir|ComSpec|OS|PROCESSOR_ARCHITECTURE)$/i.test(key)) env[key] = value;
Object.assign(env, {
  PATH: "", HOME: runtimeHome, USERPROFILE: runtimeHome, APPDATA: resolve(runtimeHome, "AppData/Roaming"), LOCALAPPDATA: resolve(runtimeHome, "AppData/Local"),
  CODEX_HOME: resolve(runtimeHome, ".codex"), CLAUDE_CONFIG_DIR: resolve(runtimeHome, ".claude"), XDG_CONFIG_HOME: resolve(runtimeHome, ".config"),
  TEMP: fixture, TMP: fixture, NODE_OPTIONS: "--experimental-sqlite", CONTROL_CENTER_RUNTIME_HOME: runtimeHome,
  CONTROL_CENTER_TEST_REPO_ROOT: repo, CONTROL_CENTER_DATA_DIR: resolve(fixture, "data"), CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_PORT: "0",
});
const server = spawnTestServer({ env });
const report = { ok: false, boundary: "Isolated persisted identity; synthetic task, result and event responses; unavailable provider executables; no formal desktop activation", checks: [], layouts: [], errors: [] };
let proxy;
let browser;
try {
  const origin = new URL(await waitForUrl(server)).origin;
  const api = async (path, body) => {
    const response = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(response.ok, `fixture ${path}: ${response.status}`);
    return response.json();
  };
  const members = ["claude-fable", "codex-technical", "grok-build"];
  const project = (await api("/api/projects", { cwd: repo, title: "514 Bot 协作流程预览" })).project;
  const conversation = (await api("/api/conversations", { kind: "workspace_group", projectId: project.projectId, roomRole: "task", title: "桌面工作区协作重构", memberIds: members })).conversation;
  const empty = (await api("/api/conversations", { kind: "direct", title: "新的技术讨论", directMemberId: "codex-technical" })).conversation;
  const createRun = (prompt) => api("/api/runs", { prompt, execute: false, permissionMode: "plan", conversationId: conversation.id, conversationKind: "workspace_group", orchestrationMode: "social", startAgentId: members[0], ephemeralTeam: { name: "Preview team", coordinator: members[0], members, skills: [], mcp: [], providers: {} } });
  const history = await createRun("梳理协作边界，核对历史会话与项目归属。");
  const current = await createRun("完善桌面端协作工作区，保留持续对话和历史记录，让分工、交接与复核可以追溯。");
  const stamp = new Date().toISOString();
  const tasks = [
    ["goal", "本轮目标", "claude-fable", "running", "root"],
    ["plan", "确定会话边界与交付范围", "claude-fable", "succeeded"],
    ["execute", "实现协作过程与成果视图", "codex-technical", "succeeded"],
    ["review", "核对交接证据与历史成员归属", "grok-build", "succeeded"],
    ["rework", "补齐复核意见和边界状态", "codex-technical", "running"],
    ["verify", "检查桌面主题与键盘操作", "grok-build", "blocked"],
    ["summary", "整理交付与待确认事项", "claude-fable", "queued"],
  ].map(([id, title, assigneeId, status, kind]) => ({ id, title, assigneeId, status, kind: kind || "attempt", parentTaskId: id === "goal" ? null : "goal", busMessageId: `bus-${id}`, attemptId: `attempt-${id}` }));
  const edges = [
    ["execute", "claude-fable", "codex-technical", "completed"],
    ["review", "codex-technical", "grok-build", "completed"],
    ["rework", "grok-build", "codex-technical", "running"],
    ["verify", "claude-fable", "grok-build", "rejected"],
    ["summary", "codex-technical", "claude-fable", "queued"],
  ].map(([id, fromAgentId, toAgentId, state]) => ({ id: `edge-${id}`, kind: "route", fromAgentId, toAgentId, state, busMessageId: `bus-${id}`, sourceAttemptId: `source-${id}`, targetAttemptId: `attempt-${id}`, depth: 1, timestamp: stamp }));
  const sampleRun = (run) => {
    if (run?.id === current.id) return { ...run, status: "waiting_agent", executionOwnerId: "codex-technical", interactionStep: 4, maxStepsPerInteraction: 8, taskGraph: { rootTaskId: "goal", tasks, delegations: edges, updatedAt: stamp } };
    if (run?.id === history.id) return { ...run, status: "succeeded", orchestrationMode: "pipeline", collaborationMode: "deep", teamMembers: ["claude-fable", "codex-technical"], teamRoster: run.teamRoster?.filter((member) => member.id !== "grok-build"), result: { critique: "### 复核意见\n历史记录必须绑定当时的成员快照。\n\n- 已核对：会话与 Run 归属。\n- 待验证：正式桌面中的完整交互。", verified: "已补齐成员快照读取；正式桌面验收仍待完成。", reworked: true }, taskGraph: { tasks: [], delegations: [] } };
    return run;
  };
  proxy = createServer((request, response) => {
    const url = new URL(request.url, origin);
    if (url.pathname === "/__preview-auth.js") {
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      response.end(`sessionStorage.setItem('514cc-control-token',${JSON.stringify(token)});`);
      return;
    }
    const headers = { ...request.headers, host: new URL(origin).host, "accept-encoding": "identity" };
    if (/^\/api\/runs\/[^/]+\/events$/.test(url.pathname)) headers.accept = "application/json";
    if (headers.origin) headers.origin = origin;
    const upstream = proxyRequest(url, { method: request.method, headers }, (incoming) => {
      const intercept = request.method === "GET" && incoming.statusCode === 200 && (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/api/bootstrap" || /^\/api\/runs(?:\/[^/]+(?:\/events)?)?$/.test(url.pathname));
      if (!intercept) { response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response); return; }
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf8");
        if (url.pathname === "/" || url.pathname === "/index.html") body = body.replace("<head>", '<head><script src="/__preview-auth.js"></script>');
        else {
          const data = JSON.parse(body);
          if (data.runs) data.runs = data.runs.map(sampleRun);
          if (data.run) data.run = sampleRun(data.run);
          if (data.id) Object.assign(data, sampleRun(data));
          if (url.pathname === `/api/runs/${current.id}/events`) data.events = [...(data.events || []), { eventId: "preview-message", sequence: 900, occurred_at: stamp, runId: current.id, agentId: "claude-fable", type: "assistant.message", data: { text: "分工已明确。Codex 正在补齐复核意见，Grok Build 的桌面交互检查尚有阻塞。\n\n交接记录已保留，当前还不能确认整体交付完成。" } }];
          body = JSON.stringify(data);
        }
        const copied = { ...incoming.headers, "cache-control": "no-store" };
        delete copied["content-length"]; delete copied["content-encoding"]; delete copied.etag;
        response.writeHead(incoming.statusCode, copied); response.end(body);
      });
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  await new Promise((done, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", done); });
  const previewOrigin = `http://127.0.0.1:${proxy.address().port}`;
  const url = `${previewOrigin}/#bot?conversation=${conversation.id}&tab=process`;
  if (serve) {
    const meta = { url, origin: previewOrigin, fixture, pid: process.pid, serverPid: server.pid, boundary: report.boundary };
    await writeFile(resolve(output, "preview.json"), JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta));
    await new Promise((done) => { process.once("SIGINT", done); process.once("SIGTERM", done); server.once("exit", done); });
  } else {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.goto(url);
    await page.locator(".collaboration-task").first().waitFor();
    assert.equal(await page.locator("[data-bot-task-id]").count(), 7);
    assert.equal(await page.locator("[data-bot-delegation-id]").count(), 5);
    assert.equal(await page.locator(".collaboration-members li").count(), 3);
    report.checks.push("real Conversation route renders synthetic task and delegation state");
    const actualInput = page.locator("#bot-composer-input");
    await actualInput.fill("保留这条未发送的补充说明");
    await page.locator('[data-bot-task-id="review"] > summary').click();
    await page.evaluate(() => { window.__processTask = document.querySelector('[data-bot-task-id="review"]'); window.__composer = document.querySelector("#bot-composer-input"); });
    await page.locator('[data-workspace-task-filter="all"]').click();
    assert.equal(await page.evaluate(() => window.__processTask === document.querySelector('[data-bot-task-id="review"]') && window.__processTask.open), true);
    const rendering = await page.evaluate(async ({ run, conversation }) => {
      const { collaborationProcessModel, collaborationProcessMarkup } = await import("/modules/collaboration-process.js");
      const { reconcileMessageMarkup } = await import("/modules/bounded-message-view.js");
      const root = document.querySelector("#workspace-insights");
      const task = root.querySelector('[data-bot-task-id="review"]');
      const focused = task.querySelector("summary");
      focused.focus();
      run.taskGraph.tasks.find((item) => item.id === "summary").status = "running";
      const started = performance.now();
      reconcileMessageMarkup(root, collaborationProcessMarkup(collaborationProcessModel({ conversation, run })));
      return { durationMs: performance.now() - started, taskPreserved: task === root.querySelector('[data-bot-task-id="review"]'), open: task.open, focusPreserved: focused === document.activeElement, running: root.querySelector('[data-bot-task-id="summary"] .collaboration-state')?.textContent };
    }, { run: sampleRun(current), conversation });
    assert.ok(rendering.taskPreserved && rendering.open && rendering.focusPreserved);
    assert.match(rendering.running, /执行中/);
    report.rendering = rendering;
    report.checks.push("incremental process state update preserves details identity and keyboard focus");
    await page.locator('[data-workspace-task-filter="attention"]').click();
    assert.equal(await page.locator("[data-bot-task-id]").count(), 1);
    assert.equal(await page.locator("[data-bot-task-id]").getAttribute("data-bot-task-id"), "verify");
    await page.locator('[data-workspace-task-filter="all"]').click();
    assert.equal(await actualInput.inputValue(), "保留这条未发送的补充说明");
    assert.equal(await page.evaluate(() => window.__composer === document.querySelector("#bot-composer-input")), true);
    report.checks.push("failure filter, details and unsent composer ownership");
    for (const theme of ["light", "dark"]) {
      if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) await page.locator("#theme-toggle").click();
      for (const width of [1024, 1280, 1440, 1920]) {
        await page.setViewportSize({ width, height: 960 });
        await page.waitForFunction((width) => innerWidth === width && document.querySelector("#workspace-insights")?.getBoundingClientRect().right <= width + 1, width);
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const geometry = await page.evaluate(() => {
          const panel = document.querySelector("#workspace-insights");
          const main = document.querySelector(".collaboration-main").getBoundingClientRect();
          const aside = document.querySelector(".collaboration-sidebar").getBoundingClientRect();
          return { viewport: innerWidth, width: document.documentElement.scrollWidth, panelWidth: panel.clientWidth, panelScroll: panel.scrollWidth, sideBySide: aside.x >= main.right, stacked: aside.y >= main.bottom };
        });
        assert.ok(geometry.width <= width && geometry.panelScroll <= geometry.panelWidth + 1, JSON.stringify(geometry));
        assert.ok(geometry.sideBySide || geometry.stacked);
        report.layouts.push({ theme, width, ...geometry });
        await page.screenshot({ path: resolve(output, `process-${theme}-${width}.png`) });
      }
    }
    if (await page.evaluate(() => document.documentElement.dataset.theme) !== "light") await page.locator("#theme-toggle").click();
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.locator("#workspace-run-select").selectOption(history.id);
    await page.waitForFunction(() => document.querySelector(".collaboration-members")?.children.length === 2);
    assert.equal(await page.locator(".collaboration-members").innerText().then((text) => text.includes("Grok")), false);
    await page.locator("#workspace-tab-results").click();
    await page.locator('[data-stream-key="review-text"] > summary').click();
    await page.locator('[data-stream-key="rework-text"] > summary').click();
    assert.match(await page.locator(".collaboration-review").innerText(), /正式桌面验收仍待完成/);
    await page.screenshot({ path: resolve(output, "results-review.png") });
    report.checks.push("historical roster and separate original review and rework");
    await page.locator("#workspace-tab-results").focus();
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => document.querySelector("#workspace-tab-process")?.getAttribute("aria-selected") === "true");
    assert.equal(await page.locator("#workspace-tab-process").evaluate((node) => node === document.activeElement), true);
    report.checks.push("tab keyboard navigation");
    await page.goto(`${previewOrigin}/#bot?conversation=${empty.id}&tab=process`);
    await page.locator(".collaboration-objective").waitFor();
    assert.match(await page.locator(".collaboration-main").innerText(), /暂无执行分工/);
    assert.equal(await page.locator("[data-bot-task-id]").count(), 0);
    report.checks.push("empty Conversation has no manufactured work");
    tasks.push(...Array.from({ length: 1000 }, (_, index) => ({ id: `bulk-task-${index}`, title: `执行记录 ${index}`, assigneeId: "codex-technical", status: "queued" })));
    edges.push(...Array.from({ length: 1000 }, (_, index) => ({ id: `bulk-edge-${index}`, fromAgentId: "claude-fable", toAgentId: "codex-technical", kind: "route", state: "queued" })));
    await page.goto(url);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("#workspace-insights [data-bot-task-id]").length === 50);
    assert.equal(await page.locator("[data-bot-delegation-id]").count(), 50);
    await page.locator('[data-workspace-graph-page="tasks"][data-direction="1"]').click();
    assert.equal(await page.locator("[data-bot-task-id]").first().getAttribute("data-bot-task-id"), tasks[50].id);
    await page.locator('[data-workspace-task-filter="attention"]').click();
    assert.equal(await page.locator("[data-bot-task-id]").count(), 1);
    await page.locator('[data-workspace-task-filter="all"]').click();
    assert.equal(await page.locator("[data-bot-task-id]").first().getAttribute("data-bot-task-id"), "goal");
    report.checks.push("1,000 extra tasks and handoffs remain bounded and navigable; filters reset paging");
    assert.deepEqual(report.errors, []);
    report.ok = true;
  }
} catch (error) {
  report.failure = error.stack || String(error);
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  await browser?.close();
  proxy?.closeAllConnections(); proxy?.close();
  if (server.exitCode == null) await stopTestServer(server, { token }).catch((error) => { report.cleanupError = error.message; process.exitCode = 1; report.ok = false; });
  if (!serve) {
    await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, layouts: report.layouts.length, output }));
  }
}
