#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const url = process.argv[2];
const outputDir = resolve(process.argv.find((value, index) => index >= 3 && !value.startsWith("--")) || ".qa-output");
// --suite=layout | workbench | history | delta | mission | all（默认 all）——子套件可聚焦单类回归
const suite = process.argv.find((value) => value.startsWith("--suite="))?.slice(8) || "all";
if (!url) throw new Error("usage: node scripts/qa-ui.mjs <control-center-url> [output-dir] [--suite=layout|workbench|history|delta|mission|all]");
const validSuites = new Set(["layout", "workbench", "history", "delta", "mission", "all"]);
if (!validSuites.has(suite)) throw new Error(`unknown QA suite: ${suite}; expected ${[...validSuites].join("|")}`);
const { chromium } = require("playwright");
await mkdir(outputDir, { recursive: true });

const cleanEntryUrl = new URL(url);
const cleanEntryFragment = new URLSearchParams(cleanEntryUrl.hash.slice(1));
cleanEntryFragment.delete("bootstrap");
cleanEntryFragment.delete("token");
cleanEntryUrl.hash = cleanEntryFragment.toString();
let sharedAccessToken = "";
const QA_APPROVAL_EPOCH = "00000000-0000-4000-8000-000000000515";

const browser = await chromium.launch({ headless: true });
const findings = [];

async function openControlCenter(page) {
  if (sharedAccessToken) {
    await page.addInitScript((token) => {
      sessionStorage.setItem("514cc-control-token", token);
    }, sharedAccessToken);
  }
  await page.goto(sharedAccessToken ? cleanEntryUrl.href : url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 20_000 });
  const captured = await page.evaluate(() => sessionStorage.getItem("514cc-control-token") ?? "");
  if (captured) sharedAccessToken = captured; // 首页消费一次性 bootstrap；后续隔离 page 复用测试会话态
}

// 协作台只留头像进设置；其余视图走设置侧栏。隐藏抽屉不能再当可点入口。
// .first()：v4 设置侧栏同一视图有多个跳转入口（连接/技能/MCP/钩子/本机运行时/运行席位
// 都是 data-view="config"），严格模式单元素假设已过时——任一入口语义等价。
async function clickView(page, view) {
  if (view === "workbench") {
    const back = page.locator('#settings-rail [data-view="workbench"]').first();
    if (await back.isVisible()) await back.click();
    return;
  }
  const railTarget = page.locator(`.settings-rail [data-view="${view}"]`).first();
  if (!(await railTarget.isVisible())) {
    const dock = page.locator("#account-dock, #account-heading-chip").locator("visible=true").first();
    if (!(await dock.count())) throw new Error(`no account dock to open settings for view ${view}`);
    await dock.click();
    await railTarget.waitFor({ state: "visible", timeout: 10_000 });
  }
  await railTarget.click();
}

function checkCleanDeepLink(errors, label, value, key) {
  if (!value) {
    errors.push(`${label} deep link was not copied`);
    return;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${label} deep link is not a valid URL: ${value}`);
    return;
  }
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  if (!fragment.get(key)) errors.push(`${label} deep link is missing #${key}`);
  const credentialName = /^(?:bootstrap|token|access[_-]?token|authorization)$/i;
  if ([...fragment.keys(), ...parsed.searchParams.keys()].some((name) => credentialName.test(name))) {
    errors.push(`${label} deep link leaked a credential or bootstrap nonce`);
  }
  if (/bearer\s+/i.test(value)) errors.push(`${label} deep link leaked a Bearer credential`);
}

async function waitForNodeCondition(page, predicate, label, errors, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await page.waitForTimeout(25);
  if (!predicate()) errors.push(`timed out waiting for ${label}`);
}

async function waitForSignal(promise, label, timeout = 10_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function inspect(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  const failedResponses = new Set();
  const responseDiagnostics = [];
  page.on("response", (response) => {
    if (response.status() < 500) return;
    const request = response.request();
    const target = new URL(response.url());
    const identity = `${request.method()} ${target.pathname}${target.search} -> ${response.status()}`;
    if (!failedResponses.has(identity)) {
      failedResponses.add(identity);
      responseDiagnostics.push((async () => {
        let detail = "";
        let payload = null;
        try {
          const body = (await response.text()).replace(/\s+/g, " ").trim();
          if (body) detail = ` ${body.slice(0, 500)}`;
          try { payload = JSON.parse(body); } catch { /* non-JSON failures stay diagnostic */ }
        } catch (error) {
          detail = ` [response body unavailable: ${error?.message ?? "unknown"}]`;
        }
        if (response.status() === 501 && payload?.code === "REMOTE_GATE_BLOCKED") return;
        errors.push(`http: ${identity}${detail}`);
      })());
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error" && !/^Failed to load resource:/.test(message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await openControlCenter(page);
  if (viewport.width > 820) {
    const workbenchChrome = await page.evaluate(() => {
      const dock = document.getElementById("account-dock");
      const hamburger = document.getElementById("mobile-menu-button");
      const rail = document.getElementById("settings-rail");
      return {
        dockVisible: dock ? getComputedStyle(dock).display !== "none" : false,
        hamburgerDisplay: hamburger ? getComputedStyle(hamburger).display : "missing",
        railHidden: Boolean(rail?.hidden),
      };
    });
    if (!workbenchChrome.dockVisible) errors.push("account dock was not visible on the workbench");
    if (workbenchChrome.hamburgerDisplay !== "none") {
      errors.push(`workbench still showed a left-nav entry: ${workbenchChrome.hamburgerDisplay}`);
    }
    if (!workbenchChrome.railHidden) errors.push("settings rail was visible on the workbench");
  }
  await page.screenshot({ path: resolve(outputDir, `control-center-${name}-workbench.png`), fullPage: true });
  await page.locator("#theme-toggle").click();
  await page.waitForTimeout(180);
  await page.screenshot({ path: resolve(outputDir, `control-center-${name}-workbench-dark.png`), fullPage: true });
  await page.locator("#theme-toggle").click();
  await page.waitForTimeout(180);
  await clickView(page, "config");
  // CSP script-src 'self' 禁 eval——waitForFunction 闭包会被拒（偶发），改轮询 textContent
  let configTitle = "";
  {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      configTitle = (await page.locator("#editor-title").textContent()) ?? "";
      if (!["正在加载", "未选择配置"].includes(configTitle)) break;
      await page.waitForTimeout(250);
    }
  }
  await page.screenshot({ path: resolve(outputDir, `control-center-${name}-config.png`), fullPage: true });
  await clickView(page, "security");
  await page.waitForSelector("#approval-list");
  const layout = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    visibleViews: [...document.querySelectorAll("[data-view-panel]")].filter((element) => !element.hidden).map((element) => element.id),
    approvalVisible: !document.querySelector("#approval-list")?.closest("[hidden]"),
  }));
  await page.screenshot({ path: resolve(outputDir, `control-center-${name}.png`), fullPage: true });
  if (viewport.width > 820) {
    const settingsChrome = await page.evaluate(() => {
      const back = document.querySelector('#settings-rail [data-view="workbench"]');
      const rail = document.getElementById("settings-rail");
      return {
        railHidden: Boolean(rail?.hidden),
        backVisible: back ? getComputedStyle(back).display !== "none" : false,
      };
    });
    if (settingsChrome.railHidden || !settingsChrome.backVisible) {
      errors.push(`settings rail did not keep a return-to-workbench entry: ${JSON.stringify(settingsChrome)}`);
    }
  }
  if (layout.documentWidth > layout.viewport.width + 1 || layout.bodyWidth > layout.viewport.width + 1) {
    errors.push(`horizontal overflow: viewport=${layout.viewport.width}, document=${layout.documentWidth}, body=${layout.bodyWidth}`);
  }
  if (layout.visibleViews.length !== 1) errors.push(`expected one visible view, got ${layout.visibleViews.join(",")}`);
  if (!configTitle || configTitle === "未选择配置") errors.push("configuration editor did not load a source");
  await Promise.allSettled(responseDiagnostics);
  findings.push({ name, viewport, configTitle, layout, errors });
  await page.close();
}

// Mission Control 必须同时守住三类契约：ARIA tab 的真实交互、切换 run 时的请求所有权、
// 以及四档目标视口中的覆盖抽屉可达性。这里让旧请求收到 abort 后仍故意返回，确保
// generation 所有权检查本身有效，而不是仅靠 fetch 取消碰巧挡住陈旧响应。
async function inspectMissionControl(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const staleRunId = "qa-mission-stale-run";
  const currentRunId = "qa-mission-current-run";
  const now = Date.now();
  const runs = [
    {
      id: staleRunId,
      title: "QA Mission stale run",
      status: "running",
      risk: "low",
      taskType: "coding",
      orchestrationMode: "social",
      coordinatorId: "claude-fable",
      teamMembers: ["claude-fable", "codex-technical"],
      createdAt: new Date(now - 5_000).toISOString(),
      updatedAt: new Date(now - 2_000).toISOString(),
      round: 1,
      maxRounds: 4,
      turns: [],
    },
    {
      id: currentRunId,
      title: "QA Mission current run",
      status: "succeeded",
      risk: "low",
      taskType: "coding",
      orchestrationMode: "social",
      coordinatorId: "claude-fable",
      teamMembers: ["claude-fable", "codex-technical"],
      createdAt: new Date(now - 4_000).toISOString(),
      updatedAt: new Date(now - 1_000).toISOString(),
      round: 2,
      maxRounds: 4,
      turns: [],
    },
  ];
  const snapshotIdentity = (runId) => [...String(runId)]
    .map((character) => character.codePointAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);
  const snapshot = (runId, title, status) => ({
    schema: "514cc.mission-control.snapshot/v3",
    schemaVersion: 3,
    snapshotId: `mc-snapshot-${snapshotIdentity(runId)}`,
    runId,
    task: {
      id: `mc-task-${runId}`,
      title,
      status,
      taskType: "coding",
      auditDegraded: false,
      progress: { round: status === "running" ? 1 : 2, maxRounds: 4 },
    },
    attempts: [{
      id: `mc-attempt-${runId}`,
      round: 1,
      agentId: "codex-technical",
      phase: status === "running" ? "running" : "completed",
      state: status === "running" ? "active" : "recorded",
      protocol: "codex-app-server",
      updatedAt: new Date(now).toISOString(),
    }],
    messageRoutes: [{
      id: `mc-message-route-${runId}`,
      from: "claude-fable",
      to: "codex-technical",
      kind: "say",
      state: "routed",
      timestamp: new Date(now).toISOString(),
    }],
    artifacts: [
      {
        id: `mc-artifact-diff-${runId}`,
        kind: "diff",
        label: `${title} Diff`,
        availability: "available",
        count: 1,
      },
      {
        id: `mc-artifact-workspace-${runId}`,
        kind: "workspace",
        label: "项目文件",
        availability: "available",
        count: null,
      },
    ],
    agents: [{ id: "codex-technical", status: "online" }],
    connections: [{ id: `mc-connection-${runId}`, available: true }],
    approvals: [],
    evidence: {
      eventCount: 3,
      completedAttempts: status === "running" ? 0 : 1,
      pendingApprovals: 0,
      types: [{ type: "agent.turn_completed", count: 1 }, { type: "run.completed", count: 1 }],
      graph: {
        schema: "514cc.evidence-graph/v1",
        rootId: `mc-task-${runId}`,
        nodes: [
          { id: `mc-task-${runId}`, kind: "task", label: title, state: status },
          { id: `mc-attempt-${runId}`, kind: "attempt", label: "codex-technical · 第 1 轮", state: status === "running" ? "active" : "completed", agentId: "codex-technical", timestamp: new Date(now).toISOString() },
          { id: `mc-artifact-diff-${runId}`, kind: "artifact", label: `${title} Diff`, state: "available" },
        ],
        edges: [
          { id: `mc-edge-attempt-${runId}`, from: `mc-task-${runId}`, to: `mc-attempt-${runId}`, kind: "contains", state: "recorded" },
          { id: `mc-edge-artifact-${runId}`, from: `mc-task-${runId}`, to: `mc-artifact-diff-${runId}`, kind: "references", state: "available" },
        ],
        truncated: { nodes: false, edges: false },
      },
    },
  });
  const snapshots = {
    [staleRunId]: snapshot(staleRunId, "QA STALE OWNER", "running"),
    [currentRunId]: snapshot(currentRunId, "QA CURRENT OWNER", "succeeded"),
  };

  await page.addInitScript(({ staleRunId: staleId, snapshots: values }) => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.__qaMissionRequests = [];
    globalThis.fetch = async (input, init = {}) => {
      const rawUrl = typeof input === "string" ? input : input?.url ?? String(input);
      const parsed = new URL(rawUrl, location.href);
      const match = /^\/api\/runs\/([^/]+)\/mission$/.exec(parsed.pathname);
      if (!match) return nativeFetch(input, init);

      const runId = decodeURIComponent(match[1]);
      const record = { runId, aborted: Boolean(init.signal?.aborted), settled: false };
      globalThis.__qaMissionRequests.push(record);
      init.signal?.addEventListener("abort", () => { record.aborted = true; }, { once: true });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, runId === staleId ? 650 : 45));
      record.settled = true;
      return new Response(JSON.stringify(values[runId]), {
        status: values[runId] ? 200 : 404,
        headers: { "Content-Type": "application/json" },
      });
    };
  }, { staleRunId, snapshots });

  await page.route((candidate) => candidate.pathname.endsWith("/api/runs"), async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs }) });
  });
  await page.route((candidate) => candidate.pathname.endsWith("/api/approvals"), (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ approvals: [], epoch: QA_APPROVAL_EPOCH, revision: 0, runtimeGeneration: 1 }),
    });
  });
  await page.route((candidate) => candidate.pathname.endsWith("/api/events"), (route) => route.abort("failed"));
  await page.route((candidate) => new RegExp(`/api/runs/(?:${staleRunId}|${currentRunId})/events$`).test(candidate.pathname), (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [] }) }),
  );
  await page.route((candidate) => new RegExp(`/api/runs/(?:${staleRunId}|${currentRunId})/bus$`).test(candidate.pathname), (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: [] }) }),
  );
  await page.route((candidate) => new RegExp(`/api/runs/(?:${staleRunId}|${currentRunId})/workspace$`).test(candidate.pathname), (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") ?? "";
    const body = path === "README.md"
      ? {
          schema: "514cc.workspace.snapshot/v1",
          schemaVersion: 1,
          runId: currentRunId,
          rootKind: "workspace",
          type: "file",
          path,
          parent: "",
          file: { name: "README.md", size: 28, language: "markdown", binary: false, truncated: false, redacted: false, content: "# QA Mission workspace\n" },
          bounds: { entries: 240, previewBytes: 262144 },
        }
      : {
          schema: "514cc.workspace.snapshot/v1",
          schemaVersion: 1,
          runId: currentRunId,
          rootKind: "workspace",
          type: "directory",
          path: "",
          parent: null,
          entries: [
            { name: "src", path: "src", type: "directory", openable: true },
            { name: "README.md", path: "README.md", type: "file", openable: true },
          ],
          truncated: false,
          bounds: { entries: 240, previewBytes: 262144 },
        };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  const waitForPage = async (predicate, label, timeout = 10_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await page.waitForTimeout(25);
    }
    errors.push(`timed out waiting for ${label}`);
    return false;
  };

  await openControlCenter(page);
  if (await page.locator(".workbench-shell").evaluate((shell) => shell.classList.contains("mc-collapsed"))) {
    await page.locator("#global-mc-toggle").click();
    await page.waitForSelector('#mission-control-dock[aria-hidden="false"]');
  }
  // 窄屏：左右抽屉可以并存，但 Escape 只 dismiss 最上层导航，不能顺带折叠底层 Mission Control。
  // 桌面侧栏已钉成常驻列，汉堡隐藏，这组抽屉分层只在汉堡可见时跑。
  if (await page.locator("#mobile-menu-button").isVisible()) {
    await page.locator("#mobile-menu-button").click();
    await page.waitForFunction(() => document.querySelector(".app-shell")?.classList.contains("nav-open"));
    await page.keyboard.press("Escape");
    const escapeLayerState = await page.evaluate(() => ({
      navOpen: document.querySelector(".app-shell")?.classList.contains("nav-open") === true,
      missionHidden: document.querySelector("#mission-control-dock")?.getAttribute("aria-hidden"),
      missionInert: Boolean(document.querySelector("#mission-control-dock")?.inert),
    }));
    if (escapeLayerState.navOpen) errors.push("Escape did not close the top navigation drawer");
    if (escapeLayerState.missionHidden !== "false" || escapeLayerState.missionInert) {
      errors.push("Escape closed Mission Control together with the top navigation drawer");
    }
    await page.locator("#mobile-menu-button").click();
    await page.keyboard.press("Control+K");
    await page.waitForSelector(".cmd-palette-overlay.is-open");
    await page.keyboard.press("Escape");
    const paletteEscapeState = await page.evaluate(() => ({
      paletteOpen: document.querySelector(".cmd-palette-overlay")?.classList.contains("is-open") === true,
      navOpen: document.querySelector(".app-shell")?.classList.contains("nav-open") === true,
      missionHidden: document.querySelector("#mission-control-dock")?.getAttribute("aria-hidden"),
    }));
    if (paletteEscapeState.paletteOpen) errors.push("Escape did not close the top command palette");
    if (!paletteEscapeState.navOpen || paletteEscapeState.missionHidden !== "false") {
      errors.push("command palette Escape leaked into a lower drawer layer");
    }
    await page.keyboard.press("Escape");
    const postPaletteNavState = await page.evaluate(() => ({
      navOpen: document.querySelector(".app-shell")?.classList.contains("nav-open") === true,
      missionHidden: document.querySelector("#mission-control-dock")?.getAttribute("aria-hidden"),
    }));
    if (postPaletteNavState.navOpen || postPaletteNavState.missionHidden !== "false") {
      errors.push("second Escape did not close only the navigation drawer");
    }
  }
  const currentRun = page.locator(`.run-rail-list [data-run-select=${JSON.stringify(currentRunId)}]`).first();
  await currentRun.waitFor({ state: "visible", timeout: 20_000 });
  await waitForPage(
    () => page.evaluate((runId) => globalThis.__qaMissionRequests.some((item) => item.runId === runId), staleRunId),
    "initial stale Mission Control request",
  );
  await page.locator("#mission-control-dock .mc-collapse-button").click();
  await page.waitForSelector('#mission-control-dock[aria-hidden="true"]');
  await currentRun.click();
  await page.locator("#global-mc-toggle").click();
  await page.waitForSelector('#mission-control-dock[aria-hidden="false"]');
  await waitForPage(
    () => page.locator("#mission-dock-title").textContent().then((value) => value === "QA CURRENT OWNER"),
    "current Mission Control snapshot",
  );
  await waitForPage(
    () => page.evaluate((runId) => {
      const records = globalThis.__qaMissionRequests.filter((item) => item.runId === runId);
      return records.length > 0 && records.every((item) => item.settled);
    }, staleRunId),
    "late stale Mission Control response",
  );

  const ownership = await page.evaluate(({ staleId, currentId }) => {
    const requests = globalThis.__qaMissionRequests.map((item) => ({ ...item }));
    return {
      requests,
      staleLatestAborted: requests.filter((item) => item.runId === staleId).at(-1)?.aborted ?? false,
      currentSettled: requests.some((item) => item.runId === currentId && item.settled),
      dockTitle: document.querySelector("#mission-dock-title")?.textContent ?? "",
      taskText: document.querySelector("#mission-task-list")?.textContent ?? "",
    };
  }, { staleId: staleRunId, currentId: currentRunId });
  if (!ownership.staleLatestAborted) errors.push("Mission Control did not abort the superseded snapshot request");
  if (!ownership.currentSettled) errors.push("Mission Control current snapshot request did not settle");
  if (ownership.dockTitle !== "QA CURRENT OWNER" || !ownership.taskText.includes("QA CURRENT OWNER") || ownership.taskText.includes("QA STALE OWNER")) {
    errors.push(`late Mission Control response took ownership: ${JSON.stringify(ownership)}`);
  }

  const auditTabs = async (expected, { focus = false } = {}) => {
    const audit = await page.locator("#mission-control-dock").evaluate((root) => {
      const tabs = [...root.querySelectorAll('[role="tab"][data-registry-tab]')];
      const panels = [...root.querySelectorAll('[role="tabpanel"][data-registry-panel]')];
      return {
        selected: tabs.filter((tab) => tab.getAttribute("aria-selected") === "true").map((tab) => tab.dataset.registryTab),
        roving: tabs.filter((tab) => tab.tabIndex === 0).map((tab) => tab.dataset.registryTab),
        visiblePanels: panels.filter((panel) => !panel.hidden).map((panel) => panel.dataset.registryPanel),
        focused: document.activeElement?.dataset?.registryTab ?? null,
        linked: tabs.every((tab) => {
          const panel = root.querySelector(`#${CSS.escape(tab.getAttribute("aria-controls") ?? "")}`);
          return panel?.getAttribute("aria-labelledby") === tab.id;
        }),
      };
    });
    if (audit.selected.length !== 1 || audit.selected[0] !== expected) errors.push(`${expected} tab selection invalid: ${JSON.stringify(audit)}`);
    if (audit.roving.length !== 1 || audit.roving[0] !== expected) errors.push(`${expected} roving tabindex invalid: ${JSON.stringify(audit)}`);
    if (audit.visiblePanels.length !== 1 || audit.visiblePanels[0] !== expected) errors.push(`${expected} panel visibility invalid: ${JSON.stringify(audit)}`);
    if (!audit.linked) errors.push(`${expected} tab/panel ARIA linkage is broken`);
    if (focus && audit.focused !== expected) errors.push(`${expected} keyboard activation did not move focus: ${JSON.stringify(audit)}`);
    return audit;
  };

  for (const tabName of ["tasks", "artifacts", "evidence", "activity", "connections"]) {
    await page.locator(`[data-registry-tab="${tabName}"]`).click();
    await auditTabs(tabName);
  }
  await page.locator('[data-registry-tab="evidence"]').click();
  if (await page.locator("#mission-evidence-graph .evidence-node").count() < 2) errors.push("Evidence Graph did not render bounded provenance nodes");
  await page.locator('[data-registry-tab="artifacts"]').click();
  const workspaceOpen = page.locator("[data-mission-workspace-open]");
  try {
    await workspaceOpen.waitFor({ state: "visible", timeout: 8_000 });
  } catch {
    const artifactMarkup = await page.locator("#mission-artifact-list").innerHTML();
    const taskMarkup = await page.locator("#mission-task-list").innerHTML();
    const requestAudit = await page.evaluate(() => globalThis.__qaMissionRequests);
    throw new Error(`Mission workspace opener did not render: artifacts=${artifactMarkup.slice(0, 800)} tasks=${taskMarkup.slice(0, 800)} requests=${JSON.stringify(requestAudit)}`);
  }
  await workspaceOpen.click();
  await page.locator('#mission-workspace-browser [data-workspace-path="README.md"]').waitFor({ state: "visible" });
  await page.locator('#mission-workspace-browser [data-workspace-path="README.md"]').click();
  await page.locator("#mission-workspace-browser .workspace-file-preview").waitFor({ state: "visible" });
  const workspaceText = await page.locator("#mission-workspace-browser").textContent();
  if (!workspaceText?.includes("QA Mission workspace")) errors.push("run-scoped workspace preview did not render");
  await page.locator("#mission-workspace-browser [data-workspace-close]").click();
  const workspaceFocusRestored = await page.evaluate(() => document.activeElement?.matches?.("[data-mission-workspace-open]") === true);
  if (!workspaceFocusRestored) errors.push("closing the workspace browser did not restore focus to its opener");
  const taskTab = page.locator('[data-registry-tab="tasks"]');
  await taskTab.click();
  await taskTab.focus();
  await auditTabs("tasks", { focus: true });
  for (const step of [
    { key: "ArrowRight", expected: "artifacts" },
    { key: "ArrowLeft", expected: "tasks" },
    { key: "End", expected: "connections" },
    { key: "Home", expected: "tasks" },
  ]) {
    await page.locator('[data-registry-tab][aria-selected="true"]').press(step.key);
    await auditTabs(step.expected, { focus: true });
  }

  const dock = page.locator("#mission-control-dock");
  await dock.scrollIntoViewIfNeeded();
  await page.waitForTimeout(60);
  const layout = await dock.evaluate((root) => {
    const rect = (element) => {
      const value = element?.getBoundingClientRect();
      return value ? { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height } : null;
    };
    const overlaps = (left, right) => Boolean(left && right && Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1 && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1);
    const dockRect = rect(root);
    const tabBarRect = rect(root.querySelector(".registry-tabs"));
    const tabRects = [...root.querySelectorAll(".registry-tab")].map(rect);
    const activePanel = root.querySelector('.registry-panel:not([hidden])');
    const activePanelRect = rect(activePanel);
    const bookmarkIssues = [...document.querySelectorAll(".composer-bookmarks .model-pick:not(.bookmark-action)")].flatMap((picker) => {
      const label = picker.querySelector(":scope > span");
      const select = picker.querySelector("select");
      const pickerRect = rect(picker);
      const labelRect = rect(label);
      const selectRect = rect(select);
      const labelStyle = label ? getComputedStyle(label) : null;
      const lineHeight = labelStyle ? Number.parseFloat(labelStyle.lineHeight) : 0;
      const reasons = [];
      if (!label || !select || !pickerRect || !labelRect || !selectRect) reasons.push("missing geometry");
      if (innerWidth <= 560 && labelStyle?.whiteSpace !== "nowrap") reasons.push("mobile label may wrap");
      if (lineHeight > 0 && labelRect && labelRect.height > lineHeight * 1.5) reasons.push("label wrapped vertically");
      if (label && (label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1)) reasons.push("label clipped");
      if (pickerRect && selectRect && (selectRect.left < pickerRect.left - 1 || selectRect.right > pickerRect.right + 1)) reasons.push("select escaped picker");
      if (picker.scrollWidth > picker.clientWidth + 1 || picker.scrollHeight > picker.clientHeight + 1) reasons.push("picker content overflowed");
      return reasons.length ? [{ label: label?.textContent?.trim() ?? "unknown", reasons, picker: pickerRect, labelRect, select: selectRect }] : [];
    });
    const siblings = [document.querySelector(".run-rail"), document.querySelector(".conversation-pane"), root]
      .filter((element) => element && getComputedStyle(element).display !== "none")
      .map((element) => ({ name: element.id || element.className, rect: rect(element) }));
    const siblingOverlaps = [];
    for (let left = 0; left < siblings.length; left += 1) {
      for (let right = left + 1; right < siblings.length; right += 1) {
        const pair = [siblings[left].name, siblings[right].name];
        const expectedDrawerOverlay = pair.includes("mission-control-dock");
        if (!expectedDrawerOverlay && overlaps(siblings[left].rect, siblings[right].rect)) siblingOverlaps.push(`${siblings[left].name} <> ${siblings[right].name}`);
      }
    }
    const tabOverlaps = [];
    for (let left = 0; left < tabRects.length; left += 1) {
      for (let right = left + 1; right < tabRects.length; right += 1) {
        if (overlaps(tabRects[left], tabRects[right])) tabOverlaps.push(`${left}:${right}`);
      }
    }
    const centerX = dockRect ? Math.min(innerWidth - 1, Math.max(0, dockRect.left + dockRect.width / 2)) : 0;
    const centerY = dockRect ? Math.min(innerHeight - 1, Math.max(0, dockRect.top + dockRect.height / 2)) : 0;
    const hit = document.elementFromPoint(centerX, centerY);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      dock: dockRect,
      tabBar: tabBarRect,
      activePanel: activePanelRect,
      displayed: getComputedStyle(root).display !== "none" && Boolean(dockRect?.width && dockRect?.height),
      inViewport: Boolean(dockRect && dockRect.right > 0 && dockRect.left < innerWidth && dockRect.bottom > 0 && dockRect.top < innerHeight),
      centerOwned: Boolean(hit && root.contains(hit)),
      dockHorizontalOverflow: root.scrollWidth - root.clientWidth,
      panelHorizontalOverflow: activePanel ? activePanel.scrollWidth - activePanel.clientWidth : null,
      bookmarkIssues,
      tabOverlaps,
      siblingOverlaps,
      siblings,
    };
  });
  if (!layout.displayed || !layout.inViewport || !layout.centerOwned) errors.push(`Mission Control is not visibly reachable: ${JSON.stringify(layout)}`);
  if (layout.documentWidth > layout.viewport.width + 1 || layout.bodyWidth > layout.viewport.width + 1) errors.push(`Mission Control viewport overflow: ${JSON.stringify(layout)}`);
  if (layout.dockHorizontalOverflow > 1 || (layout.panelHorizontalOverflow ?? 0) > 1) errors.push(`Mission Control horizontal overflow: ${JSON.stringify(layout)}`);
  if (layout.bookmarkIssues.length) errors.push(`composer bookmark text overflow: ${JSON.stringify(layout.bookmarkIssues)}`);
  if (layout.tabOverlaps.length || layout.siblingOverlaps.length) errors.push(`Mission Control overlap detected: ${JSON.stringify(layout)}`);

  const screenshot = resolve(outputDir, `control-center-mission-${name}.png`);
  await page.screenshot({ path: screenshot });
  findings.push({ name: `mission-${name}`, viewport, ownership, layout, screenshot, errors });
  await page.close();
}

// 协作台状态机回归（烛 R5/R6 致命项的确定性用例）：
// A. 摘要开关乱序响应不得倒灌——慢的 summaries=1 响应必须被请求序号丢弃；
// B. 历史预览态新建任务必须退出预览并切到新 run（POST /api/runs 用 route mock，不触真编排器）。
async function inspectWorkbenchStateMachine(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await page.addInitScript(() => {
    // 稳定捕获应用复制内容，不依赖测试宿主的系统剪贴板权限。
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => sessionStorage.setItem("__qa_clipboard", String(text)),
      },
    });
  });
  await openControlCenter(page);
  const railFiltersToggle = page.locator("#rail-filters-toggle");
  if (await railFiltersToggle.getAttribute("aria-expanded") !== "true") await railFiltersToggle.click();
  await page.waitForSelector("#team-rail-filters:not([hidden])");
  // 环境自洽：聚合项目可能被全部隐藏（2026-07-20 LO 视图清零）——树为空先开「已隐藏」开关让项目回树
  await page.waitForTimeout(1000);
  if (!(await page.locator("#workbench-project-tree [data-project-toggle]").count())) {
    await page.locator("#show-hidden-toggle").check().catch(() => {});
  }
  await page.waitForSelector("#workbench-project-tree [data-project-toggle]", { timeout: 45_000 }); // 团队树依赖项目扫描（含 codex 归并），给足余量
  // 首屏布局 settle：自动化/正在工作等区块异步显现会引起左栏重排（v3.7 实测：点击瞬间
  // 树行位移、命中点被兄弟区块拦截）——等一拍让异步区块全部就位再开始交互
  await page.waitForTimeout(1500);

  const isSummariesRequest = (candidate) =>
    candidate.pathname.endsWith("/api/sessions/projects") && candidate.searchParams.get("summaries") === "1";
  await page.route(isSummariesRequest, async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500)); // 人为让 opt-in 响应最慢
    await route.continue();
  });
  // scrollIntoView + 强制点击命中中心前先确保行完全进入团队区滚动窗（半行滑出裁剪边界时
  // Playwright 的中心命中点会落到下方兄弟区块上）
  const firstToggle = page.locator("#workbench-project-tree [data-project-toggle]").first();
  await firstToggle.scrollIntoViewIfNeeded();
  await firstToggle.click();
  const summariesToggle = page.locator("#project-summaries-toggle");
  await summariesToggle.check(); // 慢请求在途
  await summariesToggle.uncheck(); // 立即关闭 + 触发无摘要的快请求
  await page.waitForTimeout(2500); // 慢响应此时已返回，必须被序号判定为过期
  // 隐私不变量精确化（2026-07-19）：关闭摘要后 DOM 不得渲染任何 summary 内容——
  // 看 data-has-summary 属性而非文本形状（codex 会话的日期 label/别名是合法非摘要标题）
  const summaryRows = await page.locator('#workbench-project-tree .session-link[data-has-summary="1"]').count();
  if (await summariesToggle.isChecked()) errors.push("summaries toggle re-checked itself");
  if (summaryRows) errors.push("stale summaries response backwashed a summary into the tree");
  await page.unroute(isSummariesRequest);

  await page.locator("#workbench-project-tree .session-link").first().click();
  await page.waitForSelector(".preview-banner", { timeout: 10_000 });
  // 路由预览会触发真实健康探测（可能 10s+）——createRun 对 preview 失败本就容忍，直接 503 短路
  await page.route("**/api/router/preview", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "QA_MOCK" } }) }),
  );
  let busRequests = 0;
  let degradedBusRequests = 0;
  await page.route("**/api/runs/qa-mock-run/bus", async (route) => {
    busRequests += 1;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 180)); // 多次 render 命中同一个 in-flight 请求
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [{ from: "claude-fable", to: "codex-technical", text: "qa" }],
        diagnostics: { status: "ok", truncated: { bytes: true, messages: true } },
      }),
    });
  });
  await page.route("**/api/runs/qa-mock-degraded/bus", async (route) => {
    degradedBusRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [],
        diagnostics: {
          status: "degraded",
          issues: [{ code: "BUS_AUDIT_MISSING", message: "executed social run is missing its bus audit file" }],
          truncated: { bytes: false, messages: false },
        },
      }),
    });
  });
  let createdRunCount = 0;
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    createdRunCount += 1;
    const degraded = createdRunCount > 1;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        id: degraded ? "qa-mock-degraded" : "qa-mock-run",
        title: degraded ? "QA bus 审计降级任务" : "QA 状态机验证任务",
        status: "planning",
        createdAt: new Date().toISOString(),
        prompt: "qa",
        orchestrationMode: "social",
        coordinatorId: "claude-fable",
        teamMembers: ["claude-fable", "codex-technical"],
      }),
    });
  });
  await page.fill("#task-input", "QA 状态机验证任务");
  await page.click("#submit-task-button");
  // CSP script-src 'self' 禁 eval——用 selector 状态等待而非 waitForFunction
  await page.waitForSelector(".preview-banner", { state: "detached", timeout: 10_000 });
  const conversationTitle = await page.locator("#conversation-title").textContent();
  const runStatus = await page.locator("#workbench-run-status").textContent();
  if (runStatus === "历史预览") errors.push("workbench is still in preview mode after creating a run");
  if (!conversationTitle?.includes("QA")) errors.push(`conversation did not switch to the new run: ${conversationTitle}`);
  const connectionsTab = page.locator('[data-registry-tab="connections"]');
  if (await connectionsTab.count()) {
    await connectionsTab.click();
    const connectionsPanel = page.locator('[data-registry-panel="connections"]');
    if (await connectionsTab.getAttribute("aria-selected") !== "true" || await connectionsPanel.isHidden()) {
      errors.push("Mission Control connections tab did not expose the legacy social topology");
    }
  }
  await page.waitForSelector("#session-topology button[data-topology-agent]", { state: "visible", timeout: 10_000 });
  if (busRequests !== 1) errors.push(`social topology request was not deduplicated: ${busRequests}`);
  if (!(await page.locator("#session-topology").textContent())?.includes("近期发言")) {
    errors.push("bounded social topology did not label windowed speech counts");
  }

  await page.click("#composer-new-task");
  await page.fill("#task-input", "QA bus 审计降级任务");
  await page.click("#submit-task-button");
  await page.waitForSelector('#session-topology [role="alert"]', { state: "visible", timeout: 10_000 });
  if (degradedBusRequests !== 1) errors.push(`degraded social topology request count was ${degradedBusRequests}`);
  if (!(await page.locator("#session-topology").textContent())?.includes("bus 审计降级")) {
    errors.push("missing materialized bus was rendered as a normal empty topology");
  }

  // 行级省略号菜单：至少 24px、复制链接不含凭据、关闭后焦点回到触发器。
  const runSelect = page.locator('[data-run-select="qa-mock-run"]').first();
  await runSelect.click(); // 会话行点击后建立“全员” tab
  const runMenu = page.locator('[data-run-menu="qa-mock-run"]').first();
  const runMenuBox = await runMenu.boundingBox();
  if (!runMenuBox || runMenuBox.width < 24 || runMenuBox.height < 24) errors.push("run menu target is smaller than 24px");
  await runMenu.click();
  await page.getByRole("menuitem", { name: "复制深度链接" }).click();
  checkCleanDeepLink(errors, "run", await page.evaluate(() => sessionStorage.getItem("__qa_clipboard")), "run");
  if (!(await runMenu.evaluate((node) => document.activeElement === node))) errors.push("run menu did not restore focus after action");
  await runMenu.click();
  await page.keyboard.press("Escape");
  if (!(await runMenu.evaluate((node) => document.activeElement === node))) errors.push("run menu did not restore focus after Escape");

  const projectMenu = page.locator("[data-project-menu]:visible").first();
  const projectMenuBox = await projectMenu.boundingBox();
  if (!projectMenuBox || projectMenuBox.width < 24 || projectMenuBox.height < 24) errors.push("project menu target is smaller than 24px");
  await projectMenu.click();
  await page.getByRole("menuitem", { name: "复制深度链接" }).click();
  checkCleanDeepLink(errors, "project", await page.evaluate(() => sessionStorage.getItem("__qa_clipboard")), "project");
  if (!(await projectMenu.evaluate((node) => document.activeElement === node))) errors.push("project menu did not restore focus after action");

  const nativeSession = page.locator("#workbench-project-tree .session-link").first();
  await nativeSession.scrollIntoViewIfNeeded();
  await nativeSession.focus();
  await nativeSession.click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制深度链接" }).click();
  checkCleanDeepLink(errors, "session", await page.evaluate(() => sessionStorage.getItem("__qa_clipboard")), "session");
  if (!(await nativeSession.evaluate((node) => document.activeElement === node))) errors.push("session context menu did not restore focus after action");

  // 社会拓扑：并发 render 只打一条 bus 请求；原生 button 的 Enter/Space 都能开成员页。
  const topologyButtons = page.locator("#session-topology button[data-topology-agent]");
  await topologyButtons.nth(0).press("Enter");
  await page.waitForTimeout(50);
  await page.locator("#session-topology button[data-topology-agent]").nth(1).press("Space");
  await page.waitForTimeout(50);

  const tabAudit = await page.locator("#conv-tabs").evaluate((bar) => {
    const tabs = [...bar.querySelectorAll('[role="tab"]')];
    const selected = tabs.filter((tab) => tab.getAttribute("aria-selected") === "true");
    const roving = tabs.filter((tab) => tab.tabIndex === 0);
    const panel = document.querySelector("#conversation-stream");
    return {
      count: tabs.length,
      allButtons: tabs.every((tab) => tab.tagName === "BUTTON"),
      selected: selected.length,
      roving: roving.length,
      controls: tabs.every((tab) => tab.getAttribute("aria-controls") === "conversation-stream"),
      panelRole: panel?.getAttribute("role"),
      panelLabelledBy: panel?.getAttribute("aria-labelledby"),
      activeId: selected[0]?.id ?? "",
    };
  });
  if (tabAudit.count < 3) errors.push(`topology keyboard activation did not open member tabs: ${tabAudit.count}`);
  if (!tabAudit.allButtons || !tabAudit.controls || tabAudit.selected !== 1 || tabAudit.roving !== 1) errors.push(`invalid tab semantics: ${JSON.stringify(tabAudit)}`);
  if (tabAudit.panelRole !== "tabpanel" || tabAudit.panelLabelledBy !== tabAudit.activeId) errors.push(`tabpanel is not labelled by active tab: ${JSON.stringify(tabAudit)}`);
  const activeTab = page.locator('#conv-tabs [role="tab"][aria-selected="true"]');
  const activeKey = await activeTab.getAttribute("data-tab-activate");
  await activeTab.press("ArrowLeft");
  await page.waitForTimeout(50);
  const movedTab = page.locator('#conv-tabs [role="tab"][aria-selected="true"]');
  if ((await movedTab.getAttribute("data-tab-activate")) === activeKey) errors.push("ArrowLeft did not move to the adjacent tab");
  if (!(await movedTab.evaluate((node) => document.activeElement === node))) errors.push("roving tab focus did not follow ArrowLeft");

  // 可关闭 tab：中间项优先右邻、末项退左邻、首项优先右邻；关闭后焦点跟随，
  // 最后一个 tab 关闭后回 composer。这里直接覆盖最容易被 splice 下标写错的三条路径。
  const tabKeys = () => page.locator('#conv-tabs [role="tab"]').evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tabActivate));
  const closeActiveTab = async (key, expectedKey, label) => {
    const tab = page.locator(`#conv-tabs [role="tab"][data-tab-activate=${JSON.stringify(key)}]`);
    await tab.click();
    await tab.locator("..").locator("[data-tab-close]").click();
    await page.waitForTimeout(50);
    const selected = page.locator('#conv-tabs [role="tab"][aria-selected="true"]');
    const actualKey = await selected.getAttribute("data-tab-activate");
    if (actualKey !== expectedKey) errors.push(`${label} close selected ${actualKey ?? "none"}, expected ${expectedKey}`);
    if (!(await selected.evaluate((node) => document.activeElement === node))) errors.push(`${label} close did not move focus to the adjacent tab`);
  };
  let closeOrder = await tabKeys();
  if (closeOrder.length >= 3) {
    const middleKey = closeOrder[1];
    await closeActiveTab(middleKey, closeOrder[2], "middle tab");
    const separator = middleKey.indexOf("::");
    const reopenAgentId = separator >= 0 ? middleKey.slice(separator + 2) : "";
    await page.locator(`#member-strip [data-open-agent=${JSON.stringify(reopenAgentId)}]`).click();
    closeOrder = await tabKeys();
    await closeActiveTab(closeOrder.at(-1), closeOrder.at(-2), "last tab");
    closeOrder = await tabKeys();
    await closeActiveTab(closeOrder[0], closeOrder[1], "first tab");
    closeOrder = await tabKeys();
    const onlyTab = page.locator(`#conv-tabs [role="tab"][data-tab-activate=${JSON.stringify(closeOrder[0])}]`);
    await onlyTab.click();
    await onlyTab.locator("..").locator("[data-tab-close]").click();
    await page.waitForTimeout(50);
    if (!(await page.locator("#task-input").evaluate((node) => document.activeElement === node))) {
      errors.push("closing the final tab did not return focus to the composer");
    }
  }
  findings.push({ name, viewport, errors });
  await page.close();
}

// SSE burst / DOM 稳定性：把首个事件流请求挂起，待用户展开工具结果并聚焦 summary 后，
// 在同一个 response chunk 内放出一组事件。应用应在一个 animation frame 内只提交一次会话流，
// 且模板回写不得折叠 details、丢焦点或改变当前可见锚点。
async function inspectSseDomStability(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const runId = "qa-sse-dom-run";
  const now = Date.now();
  const eventEnvelope = (id, sequence, text, lineCount = 18) => ({
    eventId: id,
    type: "tool.result",
    occurred_at: new Date(now + sequence).toISOString(),
    sequence,
    runId,
    agentId: "codex-technical",
    data: {
      results: [{ isError: false, text: Array.from({ length: lineCount }, (_, index) => `${text} line ${index + 1}`).join("\n") }],
    },
  });
  const seedEvents = Array.from({ length: 18 }, (_, index) => eventEnvelope(`qa-seed-tool-${index}`, index + 1, `seed ${index}`));
  const burstEvents = Array.from({ length: 16 }, (_, index) => eventEnvelope(`qa-burst-tool-${index}`, 100 + index, `burst ${index}`, 3));
  const mockRun = {
    id: runId,
    title: "QA SSE DOM 稳定性",
    status: "running",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    prompt: "验证 SSE burst 不破坏流内交互状态",
    orchestrationMode: "pipeline",
    coordinatorId: "claude-fable",
    teamMembers: ["claude-fable", "codex-technical"],
    turns: [],
  };

  await page.route((candidate) => candidate.pathname.endsWith("/api/runs"), async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [mockRun] }) });
  });
  await page.route((candidate) => candidate.pathname.endsWith(`/api/runs/${runId}/events`), (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: seedEvents }) }),
  );

  let releaseBurst;
  const burstGate = new Promise((resolveGate) => { releaseBurst = resolveGate; });
  let eventRequests = 0;
  await page.route((candidate) => candidate.pathname.endsWith("/api/events"), async (route) => {
    eventRequests += 1;
    if (eventRequests !== 1) return route.abort("failed"); // 首包结束后的重连不引入真实环境噪声
    await burstGate;
    const body = burstEvents
      .map((event) => `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body,
    });
  });

  await openControlCenter(page);
  await page.locator(`.run-rail [data-run-select=${JSON.stringify(runId)}]`).first().click();
  const seedEntry = page.locator(`[data-stream-key="qa-seed-tool-8"]`);
  await seedEntry.waitFor({ state: "visible", timeout: 10_000 });
  await seedEntry.locator("summary").click();
  await page.evaluate((key) => {
    const stream = document.querySelector("#conversation-stream");
    const entries = [...stream.children].filter((node) => node.dataset?.streamKey);
    const entry = entries.find((node) => node.dataset.streamKey === key);
    entry.scrollIntoView({ block: "start" });
    stream.scrollTop = Math.max(0, stream.scrollTop - 12);
    entry.querySelector("summary").focus({ preventScroll: true });
    const streamTop = stream.getBoundingClientRect().top;
    const anchor = entries.find((node) => node.getBoundingClientRect().bottom > streamTop + 1);
    window.__qaSseDomBefore = {
      scrollTop: stream.scrollTop,
      anchorKey: anchor?.dataset.streamKey ?? "",
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - streamTop : 0,
    };
    window.__qaSseStreamCommits = 0;
    window.__qaSseObserver = new MutationObserver((records) => {
      if (records.some((record) => record.type === "childList" && record.target === stream)) {
        window.__qaSseStreamCommits += 1;
      }
    });
    window.__qaSseObserver.observe(stream, { childList: true });
  }, "qa-seed-tool-8");

  releaseBurst();
  await page.waitForSelector('[data-stream-key="qa-burst-tool-15"]', { timeout: 10_000 });
  await page.waitForTimeout(80);
  const audit = await page.evaluate((key) => {
    window.__qaSseObserver?.disconnect();
    const stream = document.querySelector("#conversation-stream");
    const entry = [...stream.children].find((node) => node.dataset?.streamKey === key);
    const summary = entry?.querySelector("summary");
    const before = window.__qaSseDomBefore;
    const anchor = [...stream.children].find((node) => node.dataset?.streamKey === before.anchorKey);
    return {
      commits: window.__qaSseStreamCommits,
      detailsOpen: Boolean(entry?.querySelector("details")?.open),
      focusKept: document.activeElement === summary,
      focusOnBody: document.activeElement === document.body,
      scrollDelta: Math.abs(stream.scrollTop - before.scrollTop),
      anchorDelta: anchor ? Math.abs((anchor.getBoundingClientRect().top - stream.getBoundingClientRect().top) - before.anchorOffset) : Infinity,
      streamAriaLive: stream.getAttribute("aria-live"),
      liveStatus: document.querySelector("#conversation-live-status")?.textContent ?? "",
    };
  }, "qa-seed-tool-8");
  if (audit.commits < 1 || audit.commits > 1) errors.push(`SSE burst committed the conversation stream ${audit.commits} times; expected exactly 1`);
  if (!audit.detailsOpen) errors.push("SSE burst collapsed an expanded tool result");
  if (!audit.focusKept || audit.focusOnBody) errors.push("SSE burst did not restore focus to the keyed tool-result summary");
  if (audit.scrollDelta > 2 || audit.anchorDelta > 2) errors.push(`SSE burst moved the scroll anchor: ${JSON.stringify(audit)}`);
  if (audit.streamAriaLive !== null || !audit.liveStatus.includes("16 条更新")) errors.push(`conversation live-region isolation failed: ${JSON.stringify(audit)}`);

  findings.push({ name, viewport, audit, errors });
  await page.close();
}

// 连续 delta 必须跨多个 animation frame 流入，而不是被 route.fulfill 缓冲成单包。
// delta 只更新内存中的增量尾巴，final message 到达前不得改写会话 DOM，也不得制造 >50ms long task。
async function inspectContinuousDeltaIsolation(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const runId = "qa-continuous-delta-run";
  const total = 30;
  const expectedSummary = Array.from({ length: total }, (_, index) => `piece-${index + 1}`).join("").slice(-500);
  const now = Date.now();
  const mockRun = {
    id: runId,
    title: "QA continuous delta",
    status: "running",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    prompt: "验证连续 delta 隔离",
    orchestrationMode: "pipeline",
    coordinatorId: "claude-fable",
    teamMembers: ["claude-fable", "codex-technical"],
    turns: [],
  };
  const seed = {
    eventId: "qa-delta-seed",
    type: "assistant.message",
    occurred_at: new Date(now).toISOString(),
    sequence: 1,
    runId,
    agentId: "codex-technical",
    data: { text: "seed message before deltas" },
  };

  await page.addInitScript(({ streamRunId, streamTotal }) => {
    const originalFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    let streamController = null;
    let timer = 0;
    let sent = 0;
    window.__qaDeltaSent = 0;
    window.__qaDeltaComplete = false;
    window.__qaDeltaStartAt = Infinity;
    window.__qaDeltaLongTasks = [];
    if (window.PerformanceObserver?.supportedEntryTypes?.includes("longtask")) {
      const observer = new PerformanceObserver((list) => {
        window.__qaDeltaLongTasks.push(...list.getEntries().map((entry) => ({ startTime: entry.startTime, duration: entry.duration })));
      });
      observer.observe({ type: "longtask", buffered: true });
      window.__qaDeltaPerformanceObserver = observer;
    }
    window.__qaStartDeltaStream = () => {
      window.__qaDeltaStartAt = performance.now();
      const pump = () => {
        if (!streamController || sent >= streamTotal) {
          if (sent < streamTotal) timer = window.setTimeout(pump, 5);
          return;
        }
        sent += 1;
        const sequence = 100 + sent;
        const envelope = {
          eventId: `qa-delta-${sent}`,
          type: "codex.item/agentMessage/delta",
          occurred_at: new Date(Date.now()).toISOString(),
          sequence,
          runId: streamRunId,
          agentId: "codex-technical",
          data: { delta: `piece-${sent}` },
        };
        streamController.enqueue(encoder.encode(`id: ${sequence}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`));
        window.__qaDeltaSent = sent;
        if (sent < streamTotal) timer = window.setTimeout(pump, 40);
        else {
          const duplicateIndex = Math.ceil(streamTotal / 2);
          const duplicate = {
            ...envelope,
            eventId: `qa-delta-${duplicateIndex}`,
            sequence: 100 + duplicateIndex,
            data: { delta: `piece-${duplicateIndex}` },
          };
          const heartbeat = {
            eventId: "qa-delta-render-gate",
            type: "runtime.heartbeat",
            occurred_at: new Date(Date.now()).toISOString(),
            sequence: 1_000,
            runId: streamRunId,
            data: { status: "delta audit ready" },
          };
          timer = window.setTimeout(() => {
            streamController.enqueue(encoder.encode(`id: ${duplicate.sequence}\nevent: ${duplicate.type}\ndata: ${JSON.stringify(duplicate)}\n\n`));
            streamController.enqueue(encoder.encode(`id: ${heartbeat.sequence}\nevent: ${heartbeat.type}\ndata: ${JSON.stringify(heartbeat)}\n\n`));
            window.__qaDeltaComplete = true;
          }, 40);
        }
      };
      pump();
    };
    window.fetch = (input, init) => {
      const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const target = new URL(raw, location.href);
      if (target.pathname === "/api/events") {
        const body = new ReadableStream({ start(controller) { streamController = controller; } });
        return Promise.resolve(new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        }));
      }
      return originalFetch(input, init);
    };
    window.addEventListener("pagehide", () => window.clearTimeout(timer), { once: true });
  }, { streamRunId: runId, streamTotal: total });

  await page.route((candidate) => candidate.pathname.endsWith("/api/runs"), async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [mockRun] }) });
  });
  await page.route((candidate) => candidate.pathname.endsWith(`/api/runs/${runId}/events`), (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [seed] }) }),
  );

  await openControlCenter(page);
  await page.locator(`.run-rail [data-run-select=${JSON.stringify(runId)}]`).first().click();
  await page.waitForSelector('[data-stream-key="qa-delta-seed"]', { timeout: 10_000 });
  await page.waitForTimeout(100);
  await page.requestGC();
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    const stream = document.querySelector("#conversation-stream");
    window.__qaDeltaCommits = 0;
    window.__qaDeltaMutationObserver = new MutationObserver((records) => {
      if (records.some((record) => record.type === "childList" && record.target === stream)) window.__qaDeltaCommits += 1;
    });
    window.__qaDeltaMutationObserver.observe(stream, { childList: true });
    window.__qaStartDeltaStream();
  });
  {
    const deadline = Date.now() + 8_000;
    while (!(await page.evaluate(() => window.__qaDeltaComplete)) && Date.now() < deadline) await page.waitForTimeout(25);
  }
  await page.waitForTimeout(120);
  const audit = await page.evaluate(() => {
    window.__qaDeltaMutationObserver?.disconnect();
    const start = window.__qaDeltaStartAt;
    const deltaItems = [...document.querySelectorAll("#workbench-event-list .timeline-item")]
      .filter((item) => item.querySelector("strong")?.textContent === "codex.item/agentMessage/delta");
    return {
      sent: window.__qaDeltaSent,
      commits: window.__qaDeltaCommits,
      longTasks: window.__qaDeltaLongTasks.filter((entry) => entry.startTime >= start && entry.duration > 50),
      deltaCount: deltaItems.length,
      deltaSummaries: deltaItems.map((item) => item.querySelector("span")?.textContent ?? ""),
    };
  });
  if (audit.sent !== total) errors.push(`continuous delta stream sent ${audit.sent}/${total}`);
  if (audit.commits !== 0) errors.push(`continuous delta mutated conversation stream ${audit.commits} times`);
  if (audit.longTasks.length) errors.push(`continuous delta produced long tasks: ${JSON.stringify(audit.longTasks)}`);
  if (audit.deltaCount !== 1 || audit.deltaSummaries[0] !== expectedSummary) {
    errors.push(`duplicate delta was not idempotent: ${JSON.stringify({ expectedSummary, ...audit })}`);
  }
  findings.push({ name, viewport, audit, errors });
  await page.close();
}

// 缺 sequence 的 delta 只能靠有界 ID 集去重：第 257 条必须开启新聚合项，重放第 1 条
// 仍应命中旧聚合项；相同 sequence 但不同 session/correlation 的流不得互相吞掉；
// 同流 10,12,11 必须保留三片，不能把 range 中间的迟到补洞误判成重复。
async function inspectDeltaTrackingBoundary(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const runId = "qa-delta-boundary-run";
  const now = Date.now();
  const mockRun = {
    id: runId,
    title: "QA delta tracking boundary",
    status: "running",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    prompt: "验证 delta 跟踪边界",
    orchestrationMode: "pipeline",
    coordinatorId: "claude-fable",
    teamMembers: ["claude-fable", "codex-technical"],
    turns: [],
  };
  const seed = {
    eventId: "qa-delta-boundary-seed",
    type: "assistant.message",
    occurred_at: new Date(now).toISOString(),
    sequence: 1,
    runId,
    agentId: "codex-technical",
    data: { text: "delta boundary seed" },
  };
  await page.addInitScript((streamRunId) => {
    const nativeFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    let streamController = null;
    window.__qaDeltaBoundaryReady = false;
    window.__qaEmitDeltaBoundary = () => {
      const missing = Array.from({ length: 300 }, (_, index) => ({
        eventId: `qa-boundary-missing-${index + 1}`,
        type: "codex.item/agentMessage/delta",
        occurred_at: new Date(Date.now() + index).toISOString(),
        runId: streamRunId,
        sessionId: "qa-boundary-missing-session",
        correlationId: "qa-boundary-missing-correlation",
        agentId: "codex-technical",
        data: { delta: `m${index + 1}|` },
      }));
      const replayFirst = { ...missing[0] };
      const streamA = {
        eventId: "qa-boundary-stream-a",
        type: "codex.item/agentMessage/delta",
        occurred_at: new Date().toISOString(),
        sequence: 777,
        runId: streamRunId,
        sessionId: "qa-boundary-session-a",
        correlationId: "qa-boundary-correlation-a",
        agentId: "codex-technical",
        data: { delta: "stream-a" },
      };
      const streamB = {
        ...streamA,
        eventId: "qa-boundary-stream-b",
        sessionId: "qa-boundary-session-b",
        correlationId: "qa-boundary-correlation-b",
        data: { delta: "stream-b" },
      };
      const outOfOrder = [10, 12, 11].map((sequence) => ({
        eventId: `qa-boundary-gap-${sequence}`,
        type: "codex.item/agentMessage/delta",
        occurred_at: new Date(Date.now() + sequence).toISOString(),
        sequence,
        runId: streamRunId,
        sessionId: "qa-boundary-gap-session",
        correlationId: "qa-boundary-gap-correlation",
        agentId: "codex-technical",
        data: { delta: `gap-${sequence}` },
      }));
      const gate = {
        eventId: "qa-boundary-gate",
        type: "runtime.heartbeat",
        occurred_at: new Date().toISOString(),
        sequence: 900,
        runId: streamRunId,
        data: { status: "delta boundary ready" },
      };
      for (const event of [...missing, replayFirst, streamA, streamB, ...outOfOrder, gate]) {
        const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        streamController.enqueue(encoder.encode(frame));
      }
    };
    window.fetch = (input, init) => {
      const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const target = new URL(raw, location.href);
      if (target.pathname === "/api/events") {
        const body = new ReadableStream({ start(controller) {
          streamController = controller;
          window.__qaDeltaBoundaryReady = true;
        } });
        return Promise.resolve(new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        }));
      }
      return nativeFetch(input, init);
    };
  }, runId);
  await page.route((candidate) => candidate.pathname.endsWith("/api/runs"), (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [mockRun] }) });
  });
  await page.route((candidate) => candidate.pathname.endsWith(`/api/runs/${runId}/events`), (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [seed] }) }),
  );

  await openControlCenter(page);
  await page.waitForFunction(() => window.__qaDeltaBoundaryReady === true);
  await page.locator(`.run-rail [data-run-select=${JSON.stringify(runId)}]`).first().click();
  await page.waitForSelector('[data-stream-key="qa-delta-boundary-seed"]', { timeout: 10_000 });
  await page.evaluate(() => window.__qaEmitDeltaBoundary());
  await page.waitForFunction(() => [...document.querySelectorAll("#workbench-event-list .timeline-item span")]
    .some((node) => node.textContent?.includes("delta boundary ready")));
  const summaries = await page.locator("#workbench-event-list .timeline-item").evaluateAll((items) => items
    .filter((item) => item.querySelector("strong")?.textContent === "codex.item/agentMessage/delta")
    .map((item) => item.querySelector("span")?.textContent ?? ""));
  const missingGroups = summaries.filter((summary) => summary.includes("m256|") || summary.includes("m300|"));
  const gapGroups = summaries.filter((summary) => summary.startsWith("gap-"));
  if (summaries.length !== 7) errors.push(`delta boundary rendered ${summaries.length} aggregates instead of 7: ${JSON.stringify(summaries)}`);
  if (missingGroups.length !== 2 || missingGroups.some((summary) => summary.endsWith("m1|"))) {
    errors.push(`missing-sequence ID boundary failed: ${JSON.stringify(missingGroups)}`);
  }
  if (!summaries.includes("stream-a") || !summaries.includes("stream-b")) {
    errors.push(`same-sequence independent streams collapsed: ${JSON.stringify(summaries)}`);
  }
  if (gapGroups.length !== 3 || !["gap-10", "gap-11", "gap-12"].every((summary) => gapGroups.includes(summary))) {
    errors.push(`out-of-order delta gap was swallowed: ${JSON.stringify(gapGroups)}`);
  }
  findings.push({ name, viewport, deltaAggregates: summaries.length, summaries, errors });
  await page.close();
}

// 同一个 run 的全员页/成员页共用一个 inflight/cache；关闭最后一个引用后立即释放，重开才重新拉取。
async function inspectRunHistoryCache(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const runId = "qa-history-cache-run";
  const now = Date.now();
  const mockRun = {
    id: runId,
    title: "QA history cache",
    status: "running",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    prompt: "验证历史缓存",
    orchestrationMode: "pipeline",
    coordinatorId: "claude-fable",
    teamMembers: ["claude-fable", "codex-technical", "grok-build"],
    turns: [],
  };
  const historyEvent = {
    eventId: "qa-history-cache-message",
    type: "assistant.message",
    occurred_at: new Date(now).toISOString(),
    sequence: 1,
    runId,
    agentId: "codex-technical",
    data: { text: "history cache payload" },
  };
  let historyRequests = 0;
  await page.route((candidate) => candidate.pathname.endsWith("/api/runs"), async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [mockRun] }) });
  });
  await page.route((candidate) => candidate.pathname.endsWith(`/api/runs/${runId}/events`), async (route) => {
    historyRequests += 1;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 220));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [historyEvent] }) });
  });
  await page.route((candidate) => candidate.pathname.endsWith("/api/events"), (route) => route.abort("failed"));

  await openControlCenter(page);
  await page.locator(`.run-rail [data-run-select=${JSON.stringify(runId)}]`).first().click();
  await page.waitForSelector('#member-strip [data-open-agent="codex-technical"]', { timeout: 10_000 });
  await page.locator('#member-strip [data-open-agent="codex-technical"]').click();
  await page.locator('#member-strip [data-open-agent="grok-build"]').click();
  await page.locator('#member-strip [data-open-agent=""]').click();
  await page.waitForSelector('[data-stream-key="qa-history-cache-message"]', { timeout: 10_000 });
  for (let index = 0; index < 4; index += 1) {
    await page.locator('#member-strip [data-open-agent="codex-technical"]').click();
    await page.locator('#member-strip [data-open-agent=""]').click();
  }
  if (historyRequests !== 1) errors.push(`history cache fetched ${historyRequests} times while one run remained referenced`);

  while (await page.locator("#conv-tabs [data-tab-close]").count()) {
    await page.locator("#conv-tabs [data-tab-close]").last().click();
    await page.waitForTimeout(20);
  }
  if (await page.locator("#conv-tabs [role=tab]").count()) errors.push("history cache QA could not close the last tab");
  await page.locator(`.run-rail [data-run-select=${JSON.stringify(runId)}]`).first().click();
  await waitForNodeCondition(page, () => historyRequests >= 2, "history refetch after release", errors);
  if (historyRequests !== 2) errors.push(`history cache fetched ${historyRequests} times after one release/reopen cycle`);
  findings.push({ name, viewport, historyRequests, errors });
  await page.close();
}

// 旧请求被关闭页签 abort 后，同 run 立即重开会创建新请求。旧 Promise 的 catch/finally
// 不得删除新 inflight，也不得用迟到结果覆盖新缓存。
async function inspectRunHistoryAbortReopen(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const runId = "qa-history-abort-reopen";
  const now = Date.now();
  const mockRun = {
    id: runId,
    title: "QA history abort reopen",
    status: "running",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    prompt: "验证 abort 后立即重开",
    orchestrationMode: "pipeline",
    coordinatorId: "claude-fable",
    teamMembers: ["claude-fable", "codex-technical"],
    turns: [],
  };
  const staleEvent = {
    eventId: "qa-history-stale",
    type: "assistant.message",
    occurred_at: new Date(now).toISOString(),
    sequence: 1,
    runId,
    agentId: "codex-technical",
    data: { text: "stale aborted history" },
  };
  const freshEvent = {
    ...staleEvent,
    eventId: "qa-history-fresh",
    sequence: 2,
    data: { text: "fresh reopened history" },
  };
  let historyRequests = 0;
  let signalFirstStarted;
  let signalSecondStarted;
  const firstStarted = new Promise((resolveStarted) => { signalFirstStarted = resolveStarted; });
  const secondStarted = new Promise((resolveStarted) => { signalSecondStarted = resolveStarted; });

  await page.exposeFunction("__qaHistoryRequestStarted", (index) => {
    historyRequests = Math.max(historyRequests, Number(index) || 0);
    if (index === 1) signalFirstStarted();
    if (index === 2) signalSecondStarted();
  });
  await page.addInitScript(({ targetRunId, stale, fresh }) => {
    const nativeFetch = window.fetch.bind(window);
    const control = { requests: 0, firstAborted: false, releaseFirst: null, releaseSecond: null };
    window.__qaHistoryControl = control;
    window.fetch = (input, options = {}) => {
      const target = input instanceof Request ? input.url : String(input);
      const pathname = new URL(target, location.href).pathname;
      if (pathname.endsWith(`/api/runs/${encodeURIComponent(targetRunId)}/events`)) {
        const requestIndex = ++control.requests;
        void window.__qaHistoryRequestStarted(requestIndex);
        const event = requestIndex === 1 ? stale : fresh;
        const complete = (resolve) => resolve(new Response(JSON.stringify({ events: [event] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
        return new Promise((resolve, reject) => {
          if (requestIndex === 1) {
            const signal = options.signal ?? (input instanceof Request ? input.signal : null);
            let aborted = Boolean(signal?.aborted);
            signal?.addEventListener("abort", () => {
              aborted = true;
              control.firstAborted = true;
            }, { once: true });
            control.releaseFirst = () => {
              if (aborted) reject(new DOMException("Aborted", "AbortError"));
              else complete(resolve);
            };
            return;
          }
          if (requestIndex === 2) {
            control.releaseSecond = () => complete(resolve);
            return;
          }
          complete(resolve);
        });
      }
      return nativeFetch(input, options);
    };
  }, { targetRunId: runId, stale: staleEvent, fresh: freshEvent });

  await page.route((candidate) => candidate.pathname.endsWith("/api/runs"), async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [mockRun] }) });
  });
  await page.route((candidate) => candidate.pathname.endsWith("/api/events"), (route) => route.abort("failed"));

  await openControlCenter(page);
  const selectRun = page.locator(`.run-rail [data-run-select=${JSON.stringify(runId)}]`).first();
  await selectRun.click();
  await waitForSignal(firstStarted, "first delayed history request");
  await page.locator("#conv-tabs [data-tab-close]").last().click();
  await selectRun.click();
  await waitForSignal(secondStarted, "replacement history request");

  await page.evaluate(() => window.__qaHistoryControl.releaseFirst?.());
  await page.waitForTimeout(120);
  await page.locator('#member-strip [data-open-agent="codex-technical"]').click();
  await page.locator('#member-strip [data-open-agent=""]').click();
  await page.waitForTimeout(80);
  if (historyRequests !== 2) errors.push(`stale history promise deleted the replacement inflight; requests=${historyRequests}`);

  await page.evaluate(() => window.__qaHistoryControl.releaseSecond?.());
  await page.waitForSelector('[data-stream-key="qa-history-fresh"]', { timeout: 10_000 });
  await page.waitForTimeout(80);
  const firstAborted = await page.evaluate(() => Boolean(window.__qaHistoryControl.firstAborted));
  const staleCount = await page.locator('[data-stream-key="qa-history-stale"]').count();
  const freshCount = await page.locator('[data-stream-key="qa-history-fresh"]').count();
  if (!firstAborted) errors.push("first history request was not aborted before its delayed rejection");
  if (staleCount) errors.push("aborted history response overwrote the reopened run cache");
  if (freshCount !== 1) errors.push(`fresh reopened history rendered ${freshCount} times`);
  if (historyRequests !== 2) errors.push(`abort/reopen issued ${historyRequests} history requests instead of 2`);
  findings.push({ name, viewport, historyRequests, firstAborted, staleCount, freshCount, errors });
  await page.close();
}

// 折叠节点不保留 display:none 的大子树：团队/项目都按展开态惰性挂载，并保持按钮焦点与 ARIA 关系。
async function inspectCollapsedProjectDom(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const now = new Date().toISOString();
  const projects = ["a", "b", "c"].map((suffix, projectIndex) => ({
    id: `qa-fold-${suffix}`,
    path: `I:\\qa\\fold-${suffix}`,
    label: `QA Fold ${suffix.toUpperCase()}`,
    sessionCount: 4,
    sessions: Array.from({ length: 4 }, (_, sessionIndex) => ({
      id: `qa-fold-${suffix}-${sessionIndex}`,
      cli: sessionIndex % 2 ? "codex" : "claude",
      label: `Session ${suffix}-${sessionIndex}`,
      modifiedAt: now,
    })),
  }));
  const teams = [
    { id: "team-514cc", name: "Default QA", description: "default", builtin: true, coordinator: "claude-fable", members: ["claude-fable", "codex-technical"] },
    { id: "team-fold", name: "Fold QA", description: "secondary", builtin: false, coordinator: "claude-fable", members: ["claude-fable"] },
  ];
  const runs = [
    { id: "qa-run-default", title: "Default Team Run", status: "succeeded", teamId: "team-514cc", teamName: "Default QA", createdAt: now, updatedAt: now },
    { id: "qa-run-fold", title: "Fold Team Run", status: "succeeded", teamId: "team-fold", teamName: "Fold QA", createdAt: now, updatedAt: now },
  ];
  const prefs = {
    revision: 0,
    projects: {
      "i:\\qa\\fold-b": { teamId: "team-fold" },
      "i:\\qa\\fold-c": { teamId: "team-fold" },
    },
    sessions: {},
  };
  const projectQueries = [];
  await page.route((candidate) => candidate.pathname.endsWith("/api/sessions/projects"), (route) => {
    projectQueries.push(new URL(route.request().url()).search);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: true, projects }) });
  });
  await page.route((candidate) => candidate.pathname.endsWith("/api/projects/prefs"), (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(prefs) }),
  );
  await page.route((candidate) => candidate.pathname.endsWith("/api/teams"), (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ teams }) }),
  );
  await page.route((candidate) => candidate.pathname.endsWith("/api/runs"), (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs }) }),
  );
  await page.route((candidate) => candidate.pathname.endsWith("/api/events"), (route) => route.abort("failed"));

  await openControlCenter(page);
  await page.waitForSelector('#workbench-project-tree [data-team-toggle="team-514cc"]', { timeout: 10_000 });
  await page.waitForSelector('#workbench-run-list [data-run-select="qa-run-default"]', { timeout: 10_000 });
  if (await page.locator('#workbench-run-list [data-run-select="qa-run-fold"]').count()) {
    errors.push("another team's run rendered in the selected team's rail");
  }
  const defaultTeam = page.locator('#workbench-project-tree [data-team-toggle="team-514cc"]');
  if ((await defaultTeam.getAttribute("aria-expanded")) !== "true") await defaultTeam.click();
  if (await page.locator("#workbench-project-tree .session-link").count()) errors.push("collapsed projects mounted session rows");

  const projectToggle = page.locator('#workbench-project-tree [data-project-toggle="qa-fold-a"]');
  await projectToggle.focus();
  await projectToggle.click();
  const projectControls = await projectToggle.getAttribute("aria-controls");
  const expandedSessions = await page.locator(`#${projectControls} .session-link`).count();
  if ((await projectToggle.getAttribute("aria-expanded")) !== "true" || expandedSessions !== 4) {
    errors.push(`project expansion mounted ${expandedSessions}/4 sessions`);
  }
  if (!(await projectToggle.evaluate((node) => document.activeElement === node))) errors.push("project expansion lost toggle focus");
  await projectToggle.click();
  if ((await projectToggle.getAttribute("aria-expanded")) !== "false" || await page.locator(`#${projectControls} .session-link`).count()) {
    errors.push("project collapse retained hidden session DOM");
  }
  if (!(await projectToggle.evaluate((node) => document.activeElement === node))) errors.push("project collapse lost toggle focus");

  await defaultTeam.focus();
  await defaultTeam.click();
  const teamControls = await defaultTeam.getAttribute("aria-controls");
  if ((await defaultTeam.getAttribute("aria-expanded")) !== "false" || await page.locator(`#${teamControls} [data-project-toggle]`).count()) {
    errors.push("team collapse retained hidden project DOM");
  }
  if (!(await defaultTeam.evaluate((node) => document.activeElement === node))) errors.push("team collapse lost toggle focus");

  // LO 2026-08-04 团队工作区契约：侧栏只渲染选中团队，未选中的团队节点不进树
  if (await page.locator('#workbench-project-tree [data-team-toggle="team-fold"]').count()) {
    errors.push("unselected team rendered in the team-scoped rail");
  }

  // 选择团队 → 侧栏整树切到该团队并直接展开其全部项目（原团队节点同时退出）
  // evaluate 路径绕开 composer 在移动视口的可见性差异，直测状态机契约
  await page.evaluate(() => {
    const select = document.querySelector("#composer-team");
    select.value = "team-fold";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const scopedTeam = page.locator('#workbench-project-tree [data-team-toggle="team-fold"]');
  await scopedTeam.waitFor({ state: "visible", timeout: 5_000 });
  const scopedControls = await scopedTeam.getAttribute("aria-controls");
  if ((await scopedTeam.getAttribute("aria-expanded")) !== "true" || await page.locator(`#${scopedControls} [data-project-toggle]`).count() !== 2) {
    errors.push("selecting a team did not mount that team's full project subtree");
  }
  if (await page.locator('#workbench-project-tree [data-team-toggle="team-514cc"]').count()) {
    errors.push("previous team stayed in the rail after team switch");
  }
  await page.waitForSelector('#workbench-run-list [data-run-select="qa-run-fold"]', { timeout: 5_000 });
  if (await page.locator('#workbench-run-list [data-run-select="qa-run-default"]').count()) {
    errors.push("previous team's run stayed in the rail after team switch");
  }
  if ((await page.evaluate(() => localStorage.getItem("514cc-selected-team"))) !== "team-fold") {
    errors.push("team selection was not persisted to localStorage");
  }

  // 退出重进（重载等价）后默认恢复上次选择的团队
  await openControlCenter(page);
  await page.waitForSelector('#workbench-project-tree [data-team-toggle="team-fold"]', { timeout: 10_000 });
  if (await page.locator('#workbench-project-tree [data-team-toggle="team-514cc"]').count()) {
    errors.push("reload did not restore the last selected team");
  }
  await page.waitForSelector('#workbench-run-list [data-run-select="qa-run-fold"]', { timeout: 10_000 });
  if (await page.locator('#workbench-run-list [data-run-select="qa-run-default"]').count()) {
    errors.push("reload restored the selected team but leaked another team's run");
  }

  await page.locator("#refresh-button").click();
  await waitForNodeCondition(page, () => projectQueries.some((query) => new URLSearchParams(query).get("refresh") === "1"), "explicit refresh=1", errors);
  if (projectQueries[0] && new URLSearchParams(projectQueries[0]).has("refresh")) errors.push("initial project load incorrectly bypassed the TTL cache");
  findings.push({ name, viewport, projectQueries, errors });
  await page.close();
}

// 5000 条审计事件仍完整缓存，但 DOM 固定为 160 条分页窗口；更早/更新/最新均可达且不得产生长任务。
async function inspectLongHistoryWindow(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const runId = "qa-long-history-run";
  const now = Date.now();
  const events = Array.from({ length: 5_000 }, (_, index) => {
    const visible = index % 4 === 0;
    const tool = visible && index % 8 === 4;
    return {
      eventId: `qa-long-${index}`,
      type: visible ? (tool ? "tool.result" : "assistant.message") : "runtime.heartbeat",
      occurred_at: new Date(now + index).toISOString(),
      sequence: index + 1,
      runId,
      agentId: "codex-technical",
      data: visible
        ? tool
          ? { results: [{ isError: false, text: `tool result ${index}` }] }
          : { text: `assistant message ${index}` }
        : { status: "ok" },
    };
  });
  const mockRun = {
    id: runId,
    title: "QA 5000 event history",
    status: "succeeded",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now + events.length).toISOString(),
    prompt: "验证 5000 事件长历史",
    orchestrationMode: "pipeline",
    coordinatorId: "claude-fable",
    teamMembers: ["claude-fable", "codex-technical"],
    turns: [],
  };
  let historyRequests = 0;
  let historyAccept = "";
  await page.addInitScript(() => {
    window.__qaHistoryLongTasks = [];
    window.__qaHistoryStartAt = Infinity;
    if (window.PerformanceObserver?.supportedEntryTypes?.includes("longtask")) {
      const observer = new PerformanceObserver((list) => {
        window.__qaHistoryLongTasks.push(...list.getEntries().map((entry) => ({ startTime: entry.startTime, duration: entry.duration })));
      });
      observer.observe({ type: "longtask", buffered: true });
      window.__qaHistoryPerformanceObserver = observer;
    }
  });
  await page.addInitScript(() => {
    if (typeof window.scheduler?.yield !== "function") return;
    const nativeYield = window.scheduler.yield.bind(window.scheduler);
    const control = { holdNext: false, held: false, release: null };
    window.__qaHistoryYieldControl = control;
    window.scheduler.yield = (...args) => {
      if (!control.holdNext) return nativeYield(...args);
      control.holdNext = false;
      control.held = true;
      return new Promise((resolveYield, rejectYield) => {
        control.release = () => {
          control.release = null;
          control.held = false;
          nativeYield(...args).then(resolveYield, rejectYield);
        };
      });
    };
  });
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    let streamController = null;
    window.__qaLongHistoryStreamReady = false;
    window.__qaLongHistoryEmit = (event) => {
      streamController.enqueue(encoder.encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
    };
    window.fetch = (input, init) => {
      const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const target = new URL(raw, location.href);
      if (target.pathname === "/api/events") {
        const body = new ReadableStream({ start(controller) {
          streamController = controller;
          window.__qaLongHistoryStreamReady = true;
        } });
        return Promise.resolve(new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        }));
      }
      return nativeFetch(input, init);
    };
  });
  await page.route((candidate) => candidate.pathname.endsWith("/api/runs"), async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [mockRun] }) });
  });
  await page.route((candidate) => candidate.pathname.endsWith(`/api/runs/${runId}/events`), (route) => {
    historyRequests += 1;
    historyAccept = route.request().headers().accept ?? "";
    const streaming = historyAccept.includes("application/x-ndjson");
    return route.fulfill({
      status: 200,
      contentType: streaming ? "application/x-ndjson" : "application/json",
      body: streaming ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : JSON.stringify({ events }),
    });
  });
  await page.route((candidate) => candidate.pathname.endsWith("/api/events"), (route) => route.abort("failed"));

  await openControlCenter(page);
  const waitForHistoryMount = async (label) => {
    const stream = page.locator("#conversation-stream");
    const deadline = Date.now() + 20_000;
    while ((await stream.getAttribute("aria-busy")) === "true" && Date.now() < deadline) {
      await page.waitForTimeout(25);
    }
    if ((await stream.getAttribute("aria-busy")) === "true") errors.push(`timed out waiting for ${label}`);
  };
  await page.waitForTimeout(100);
  await page.evaluate(() => { window.__qaHistoryStartAt = performance.now(); });
  await page.locator(`.run-rail [data-run-select=${JSON.stringify(runId)}]`).first().click();
  await page.waitForSelector("#conversation-stream .conversation-history-gate", { timeout: 15_000 });
  await waitForHistoryMount("initial long-history mount");
  await page.waitForTimeout(100);
  const before = await page.evaluate(() => {
    const stream = document.querySelector("#conversation-stream");
    const start = window.__qaHistoryStartAt;
    return {
      children: stream.children.length,
      keyed: stream.querySelectorAll(":scope > [data-stream-key]").length,
      gateText: stream.querySelector(".conversation-history-gate")?.textContent ?? "",
      longTasks: window.__qaHistoryLongTasks.filter((entry) => entry.startTime >= start && entry.duration > 50),
    };
  });
  if (historyRequests !== 1) errors.push(`long history fetched ${historyRequests} times`);
  if (!historyAccept.includes("application/x-ndjson")) errors.push(`long history did not negotiate NDJSON: ${historyAccept}`);
  if (before.keyed > 165) errors.push(`long history mounted ${before.keyed} keyed nodes instead of a bounded window`);
  if (!before.gateText.includes("加载更早") || !before.gateText.includes("160")) errors.push(`long history gate is unclear: ${before.gateText}`);
  if (before.longTasks.length) errors.push(`long history first open produced >50ms tasks: ${JSON.stringify(before.longTasks)}`);
  const capturePage = async (start) => page.evaluate((startedAt) => {
    const stream = document.querySelector("#conversation-stream");
    const messageKeys = [...stream.querySelectorAll(':scope > [data-stream-key^="qa-long-"]')]
      .map((node) => node.dataset.streamKey);
    return {
      keyed: stream.querySelectorAll(":scope > [data-stream-key]").length,
      messageKeys,
      busy: stream.getAttribute("aria-busy"),
      focusInside: stream === document.activeElement || stream.contains(document.activeElement),
      longTasks: window.__qaHistoryLongTasks.filter((entry) => entry.startTime >= startedAt && entry.duration > 50),
    };
  }, start);
  const pages = [];
  let previousFirst = null;
  let mountSseObservedWhileBusy = false;
  for (let step = 0; step < 10 && await page.locator("[data-load-earlier]").count(); step += 1) {
    const startedAt = await page.evaluate(() => performance.now());
    if (step === 0) {
      await page.evaluate(() => {
        const control = window.__qaHistoryYieldControl;
        if (!control) return;
        control.holdNext = true;
        control.held = false;
        control.release = null;
      });
    }
    await page.locator("[data-load-earlier]").click();
    if (step === 0) {
      const deadline = Date.now() + 10_000;
      let yieldHeld = false;
      while (!yieldHeld && Date.now() < deadline) {
        yieldHeld = await page.evaluate(() => Boolean(
          window.__qaHistoryYieldControl?.held
          && document.querySelector("#conversation-stream")?.getAttribute("aria-busy") === "true",
        ));
        if (!yieldHeld) await page.waitForTimeout(25);
      }
      if (!yieldHeld) errors.push("timed out waiting for a controlled history-mount yield");
      await page.evaluate((event) => window.__qaLongHistoryEmit(event), {
        eventId: "qa-long-history-mount-sse",
        type: "assistant.message",
        occurred_at: new Date(now + 6_000).toISOString(),
        sequence: 6_000,
        runId,
        agentId: "codex-technical",
        data: { text: "SSE during paginated history mount" },
      });
      const eventDeadline = Date.now() + 10_000;
      while (!mountSseObservedWhileBusy && Date.now() < eventDeadline) {
        mountSseObservedWhileBusy = await page.evaluate(() => (
          document.querySelector("#conversation-stream")?.getAttribute("aria-busy") === "true"
          && document.querySelector("#conversation-live-status")?.textContent?.includes("assistant.message")
        ));
        if (!mountSseObservedWhileBusy) await page.waitForTimeout(25);
      }
      if (!mountSseObservedWhileBusy) errors.push("SSE was not observed by the app while the history mount was busy");
      await page.evaluate(() => window.__qaHistoryYieldControl?.release?.());
    }
    await waitForHistoryMount(`history expansion ${step + 1}`);
    await page.waitForTimeout(80);
    const pageState = await capturePage(startedAt);
    const first = pageState.messageKeys[0] ?? null;
    if (pageState.keyed > 163) errors.push(`history page ${step + 1} mounted ${pageState.keyed} keyed nodes`);
    if (first && first === previousFirst) errors.push(`history page ${step + 1} did not move to older content: ${first}`);
    if (pageState.busy === "true") errors.push(`history page ${step + 1} left aria-busy stuck`);
    if (!pageState.focusInside) errors.push(`history page ${step + 1} lost focus outside the conversation stream`);
    if (pageState.longTasks.length) errors.push(`history page ${step + 1} produced >50ms tasks: ${JSON.stringify(pageState.longTasks)}`);
    previousFirst = first;
    pages.push(pageState);
  }
  if (await page.locator("[data-load-earlier]").count()) errors.push("long history still has hidden messages after 10 expansions");
  if (!(await page.locator("[data-load-newer]").count()) || !(await page.locator("[data-return-latest]").count())) {
    errors.push("oldest history page is missing newer/latest navigation");
  }

  const newerStartedAt = await page.evaluate(() => performance.now());
  await page.locator("[data-load-newer]").click();
  await waitForHistoryMount("newer history page");
  await page.waitForTimeout(80);
  const newerPage = await capturePage(newerStartedAt);
  if (newerPage.keyed > 163 || newerPage.messageKeys[0] === previousFirst) errors.push(`newer history page did not advance within the DOM bound: ${JSON.stringify(newerPage)}`);
  const expectedNewerFirst = pages.at(-2)?.messageKeys?.[0] ?? null;
  if (expectedNewerFirst && newerPage.messageKeys[0] !== expectedNewerFirst) {
    errors.push(`older/newer history navigation was not reversible: ${newerPage.messageKeys[0]} !== ${expectedNewerFirst}`);
  }
  if (newerPage.longTasks.length) errors.push(`newer history page produced >50ms tasks: ${JSON.stringify(newerPage.longTasks)}`);

  const latestStartedAt = await page.evaluate(() => performance.now());
  await page.locator("[data-return-latest]").click();
  await waitForHistoryMount("latest history page");
  await page.waitForTimeout(80);
  const latestPage = await capturePage(latestStartedAt);
  if (
    latestPage.keyed > 163
    || !latestPage.messageKeys.includes("qa-long-4996")
    || latestPage.messageKeys.at(-1) !== "qa-long-history-mount-sse"
  ) {
    errors.push(`return-to-latest landed on the wrong bounded page: ${JSON.stringify(latestPage)}`);
  }
  if (await page.locator("[data-load-newer]").count()) errors.push("latest history page still exposes newer navigation");
  if (latestPage.longTasks.length) errors.push(`return-to-latest produced >50ms tasks: ${JSON.stringify(latestPage.longTasks)}`);

  const readingState = await page.evaluate(() => {
    const stream = document.querySelector("#conversation-stream");
    const entries = [...stream.querySelectorAll(':scope > [data-stream-key^="qa-long-"]')];
    const target = entries[Math.min(20, Math.max(0, entries.length - 1))];
    if (target) {
      stream.scrollTop += target.getBoundingClientRect().top - stream.getBoundingClientRect().top - 12;
    }
    const streamTop = stream.getBoundingClientRect().top;
    const anchor = entries.find((node) => node.getBoundingClientRect().bottom > streamTop + 1);
    const focusTarget = stream.querySelector("summary");
    focusTarget?.focus({ preventScroll: true });
    return {
      firstKey: entries[0]?.dataset.streamKey ?? "",
      anchorKey: anchor?.dataset.streamKey ?? "",
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - streamTop : 0,
      focusKey: focusTarget?.closest("[data-stream-key]")?.dataset.streamKey ?? "",
    };
  });
  await page.evaluate((event) => window.__qaLongHistoryEmit(event), {
    eventId: "qa-long-history-reading-sse",
    type: "assistant.message",
    occurred_at: new Date(now + 6_001).toISOString(),
    sequence: 6_001,
    runId,
    agentId: "codex-technical",
    data: { text: "SSE while user reads the latest window" },
  });
  await page.waitForSelector("[data-load-newer]", { timeout: 15_000 });
  await waitForHistoryMount("latest reading window freeze");
  await page.waitForTimeout(80);
  const frozenReadingPage = await page.evaluate((before) => {
    const stream = document.querySelector("#conversation-stream");
    const entries = [...stream.querySelectorAll(':scope > [data-stream-key^="qa-long-"]')];
    const anchor = [...stream.children].find((node) => node.dataset?.streamKey === before.anchorKey);
    return {
      firstKey: entries[0]?.dataset.streamKey ?? "",
      hasIncoming: Boolean(stream.querySelector('[data-stream-key="qa-long-history-reading-sse"]')),
      newerText: stream.querySelector("[data-load-newer]")?.textContent ?? "",
      anchorDelta: anchor
        ? Math.abs((anchor.getBoundingClientRect().top - stream.getBoundingClientRect().top) - before.anchorOffset)
        : Infinity,
      focusKey: document.activeElement?.closest?.("[data-stream-key]")?.dataset.streamKey ?? "",
    };
  }, readingState);
  if (
    frozenReadingPage.firstKey !== readingState.firstKey
    || frozenReadingPage.hasIncoming
    || !frozenReadingPage.newerText.includes("1")
    || frozenReadingPage.anchorDelta > 2
    || frozenReadingPage.focusKey !== readingState.focusKey
  ) {
    errors.push(`latest-window reading ownership was lost: ${JSON.stringify({ readingState, frozenReadingPage })}`);
  }
  await page.locator("[data-return-latest]").click();
  await waitForHistoryMount("return to latest after reading freeze");
  await page.waitForSelector('[data-stream-key="qa-long-history-reading-sse"]', { timeout: 15_000 });
  await page.screenshot({ path: resolve(outputDir, "control-center-long-history-window.png"), fullPage: true });
  findings.push({ name, viewport, totalEvents: events.length, visibleConversationEvents: 1_250, maxDomMessages: 160, historyRequests, historyAccept, mountSseObservedWhileBusy, before, pages, newerPage, latestPage, readingState, frozenReadingPage, errors });
  await page.close();
}

// scheduler.yield 不可用时必须走 MessageChannel，而不是退回可能被后台节流到 1s 的 timer。
async function inspectMessageChannelYieldFallback(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const runId = "qa-message-channel-yield-run";
  const now = Date.now();
  const events = Array.from({ length: 96 }, (_, index) => ({
    eventId: `qa-message-channel-${index + 1}`,
    type: "assistant.message",
    occurred_at: new Date(now + index).toISOString(),
    sequence: index + 1,
    runId,
    agentId: "codex-technical",
    data: { text: `MessageChannel fallback message ${index + 1}` },
  }));
  const mockRun = {
    id: runId,
    title: "QA MessageChannel yield fallback",
    status: "succeeded",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now + events.length).toISOString(),
    prompt: "验证 MessageChannel 主线程让步",
    orchestrationMode: "pipeline",
    coordinatorId: "claude-fable",
    teamMembers: ["claude-fable", "codex-technical"],
    turns: [],
  };
  await page.addInitScript(() => {
    if (window.scheduler) {
      Object.defineProperty(window.scheduler, "yield", { value: undefined, writable: true, configurable: true });
    }
    const NativeMessageChannel = window.MessageChannel;
    window.__qaMessageChannelPosts = 0;
    window.__qaMessageChannelBusyPosts = 0;
    window.MessageChannel = function QaMessageChannel(...args) {
      const channel = new NativeMessageChannel(...args);
      const nativePostMessage = channel.port2.postMessage.bind(channel.port2);
      channel.port2.postMessage = (...postArgs) => {
        window.__qaMessageChannelPosts += 1;
        if (document.querySelector("#conversation-stream")?.getAttribute("aria-busy") === "true") {
          window.__qaMessageChannelBusyPosts += 1;
        }
        return nativePostMessage(...postArgs);
      };
      return channel;
    };
    window.MessageChannel.prototype = NativeMessageChannel.prototype;
  });
  await page.route((candidate) => candidate.pathname.endsWith("/api/runs"), (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [mockRun] }) });
  });
  await page.route((candidate) => candidate.pathname.endsWith(`/api/runs/${runId}/events`), (route) => {
    const streaming = (route.request().headers().accept ?? "").includes("application/x-ndjson");
    return route.fulfill({
      status: 200,
      contentType: streaming ? "application/x-ndjson" : "application/json",
      body: streaming ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : JSON.stringify({ events }),
    });
  });
  await page.route((candidate) => candidate.pathname.endsWith("/api/events"), (route) => route.abort("failed"));

  await openControlCenter(page);
  await page.locator(`.run-rail [data-run-select=${JSON.stringify(runId)}]`).first().click();
  await page.waitForSelector('[data-stream-key="qa-message-channel-96"]', { timeout: 10_000 });
  const deadline = Date.now() + 10_000;
  while ((await page.locator("#conversation-stream").getAttribute("aria-busy")) === "true" && Date.now() < deadline) {
    await page.waitForTimeout(25);
  }
  const audit = await page.evaluate(() => ({
    schedulerYield: typeof window.scheduler?.yield,
    messageChannelPosts: Number(window.__qaMessageChannelPosts) || 0,
    messageChannelBusyPosts: Number(window.__qaMessageChannelBusyPosts) || 0,
    messageCount: document.querySelectorAll('#conversation-stream > [data-stream-key^="qa-message-channel-"]').length,
    busy: document.querySelector("#conversation-stream")?.getAttribute("aria-busy"),
  }));
  if (audit.schedulerYield !== "undefined") errors.push(`scheduler.yield fallback fixture was not active: ${audit.schedulerYield}`);
  if (audit.messageChannelPosts < 10) errors.push(`MessageChannel fallback yielded only ${audit.messageChannelPosts} times`);
  if (audit.messageChannelBusyPosts < 11) errors.push(`MessageChannel fallback yielded only ${audit.messageChannelBusyPosts} times while mounting`);
  if (audit.messageCount !== events.length) errors.push(`MessageChannel fallback mounted ${audit.messageCount}/${events.length} messages`);
  if (audit.busy === "true") errors.push("MessageChannel fallback left the conversation stream busy");
  findings.push({ name, viewport, audit, errors });
  await page.close();
}

// 历史快照装入后再连续到达超过全局 160 条窗口的 SSE；跨两个有界分页窗口取并集时
// 必须保持 snapshot→live 连续、重复 id 只出现一次，delta 不产生消息节点。
async function inspectRunHistorySseContinuity(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const runId = "qa-history-continuity-run";
  const now = Date.now();
  const messageEvent = (sequence) => ({
    eventId: `qa-continuity-${sequence}`,
    type: "assistant.message",
    occurred_at: new Date(now + sequence).toISOString(),
    sequence,
    runId,
    agentId: "codex-technical",
    correlationId: "qa-continuity",
    data: { text: `continuity message ${sequence}` },
  });
  const historical = [messageEvent(1)];
  const live = Array.from({ length: 220 }, (_, index) => messageEvent(index + 2));
  live.push(messageEvent(100)); // SSE replay duplicate inside the live tail.
  live.push(...Array.from({ length: 8 }, (_, index) => ({
    eventId: `qa-continuity-delta-${index}`,
    type: "codex.item.delta",
    occurred_at: new Date(now + 500 + index).toISOString(),
    sequence: 500 + index,
    runId,
    sessionId: "qa-delta-session",
    correlationId: "qa-delta-correlation",
    data: { delta: `d${index}` },
  })));
  const mockRun = {
    id: runId,
    title: "QA history SSE continuity",
    status: "running",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    prompt: "验证历史与实时事件连续",
    orchestrationMode: "pipeline",
    coordinatorId: "claude-fable",
    teamMembers: ["claude-fable", "codex-technical"],
    turns: [],
  };
  let releaseLive;
  const liveGate = new Promise((resolveGate) => { releaseLive = resolveGate; });
  let eventRequests = 0;
  await page.route((candidate) => candidate.pathname.endsWith("/api/runs"), (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [mockRun] }) });
  });
  await page.route((candidate) => candidate.pathname.endsWith(`/api/runs/${runId}/events`), (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: historical }) }),
  );
  await page.route((candidate) => candidate.pathname.endsWith("/api/events"), async (route) => {
    eventRequests += 1;
    if (eventRequests !== 1) return route.abort("failed");
    await liveGate;
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: live.map((event) => `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    });
  });

  await openControlCenter(page);
  await page.locator(`.run-rail [data-run-select=${JSON.stringify(runId)}]`).first().click();
  await page.waitForSelector('[data-stream-key="qa-continuity-1"]', { timeout: 10_000 });
  releaseLive();
  await page.waitForSelector('[data-stream-key="qa-continuity-221"]', { timeout: 15_000 });
  await page.waitForSelector("[data-load-earlier]", { timeout: 10_000 });
  const collectMessageKeys = () => page.evaluate(() => [...document.querySelectorAll('#conversation-stream > [data-stream-key^="qa-continuity-"]')]
    .map((node) => node.dataset.streamKey)
    .filter((key) => !key.includes("delta")));
  const latestKeys = await collectMessageKeys();
  await page.locator("[data-load-earlier]").click();
  {
    const deadline = Date.now() + 10_000;
    while ((await page.locator("#conversation-stream").getAttribute("aria-busy")) === "true" && Date.now() < deadline) {
      await page.waitForTimeout(25);
    }
  }
  const olderKeys = await collectMessageKeys();
  const keys = [...new Set([...olderKeys, ...latestKeys])].sort((left, right) => Number(left.split("-").at(-1)) - Number(right.split("-").at(-1)));
  const audit = {
    count: keys.length,
    unique: new Set(keys).size,
    first: keys[0] ?? null,
    last: keys.at(-1) ?? null,
    latestPageCount: latestKeys.length,
    olderPageCount: olderKeys.length,
    hasOlder: Boolean(await page.locator("[data-load-earlier]").count()),
    hasNewer: Boolean(await page.locator("[data-load-newer]").count()),
  };
  if (audit.count !== 221 || audit.unique !== 221) errors.push(`history/SSE continuity produced ${audit.count}/${audit.unique} messages`);
  if (audit.first !== "qa-continuity-1" || audit.last !== "qa-continuity-221") {
    errors.push(`history/SSE continuity endpoints are ${audit.first} -> ${audit.last}`);
  }
  if (audit.hasOlder || !audit.hasNewer) errors.push(`history/SSE pagination boundary is wrong: ${JSON.stringify(audit)}`);
  findings.push({ name, viewport, eventRequests, audit, errors });
  await page.close();
}

// HTTP 历史快照只含 d1，但响应在途期间 SSE 已把 d1+d2 聚合进全局窗口。缓存对账必须
// 使用请求期间保留的原始 tail：d1 去重、d2 补入；不能因聚合项“部分命中”而整项跳过。
async function inspectRunHistorySnapshotDeltaOverlap(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const runId = "qa-history-delta-overlap";
  const fillerRunId = "qa-history-delta-filler";
  const now = Date.now();
  const seed = {
    eventId: "qa-overlap-seed",
    type: "assistant.message",
    occurred_at: new Date(now).toISOString(),
    sequence: 1,
    runId,
    agentId: "codex-technical",
    data: { text: "overlap snapshot seed" },
  };
  const delta = (index) => ({
    eventId: `qa-overlap-d${index}`,
    type: "codex.item/agentMessage/delta",
    occurred_at: new Date(now + index).toISOString(),
    sequence: index + 1,
    runId,
    sessionId: "qa-overlap-session",
    correlationId: "qa-overlap-correlation",
    agentId: "codex-technical",
    data: { delta: `overlap-piece-${index}` },
  });
  const d1 = delta(1);
  const d2 = delta(2);
  const mergeGate = {
    eventId: "qa-overlap-merge-gate",
    type: "runtime.heartbeat",
    occurred_at: new Date(now + 4).toISOString(),
    sequence: 4,
    runId,
    data: { status: "overlap merge ready" },
  };
  const mockRun = {
    id: runId,
    title: "QA history delta overlap",
    status: "running",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    prompt: "验证快照与 SSE delta 部分重叠",
    orchestrationMode: "pipeline",
    coordinatorId: "claude-fable",
    teamMembers: ["claude-fable", "codex-technical"],
    turns: [],
  };

  let signalHistoryStarted;
  let releaseHistory;
  const historyStarted = new Promise((resolveStarted) => { signalHistoryStarted = resolveStarted; });
  const historyGate = new Promise((resolveHistory) => { releaseHistory = resolveHistory; });
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    let streamController = null;
    window.__qaOverlapStreamReady = false;
    window.__qaOverlapEmit = (events) => {
      for (const event of events) {
        streamController.enqueue(encoder.encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      }
    };
    window.fetch = (input, init) => {
      const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const target = new URL(raw, location.href);
      if (target.pathname === "/api/events") {
        const body = new ReadableStream({ start(controller) {
          streamController = controller;
          window.__qaOverlapStreamReady = true;
        } });
        return Promise.resolve(new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        }));
      }
      return nativeFetch(input, init);
    };
  });
  await page.route((candidate) => candidate.pathname.endsWith("/api/runs"), (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [mockRun] }) });
  });
  await page.route((candidate) => candidate.pathname.endsWith(`/api/runs/${runId}/events`), async (route) => {
    signalHistoryStarted();
    await historyGate;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [seed, d1] }) });
  });

  await openControlCenter(page);
  await page.waitForFunction(() => window.__qaOverlapStreamReady === true);
  await page.locator(`.run-rail [data-run-select=${JSON.stringify(runId)}]`).first().click();
  await waitForSignal(historyStarted, "overlap history request");
  await page.evaluate((events) => window.__qaOverlapEmit(events), [d1, d2, mergeGate]);
  await page.waitForFunction(() => {
    const summaries = [...document.querySelectorAll("#workbench-event-list .timeline-item span")].map((node) => node.textContent ?? "");
    return summaries.some((text) => text.includes("overlap merge ready"))
      && summaries.some((text) => text.includes("overlap-piece-1overlap-piece-2"));
  });
  releaseHistory();
  await page.waitForSelector('[data-stream-key="qa-overlap-seed"]', { timeout: 10_000 });

  const fillers = Array.from({ length: 161 }, (_, index) => ({
    eventId: `qa-overlap-filler-${index}`,
    type: "runtime.heartbeat",
    occurred_at: new Date(now + 100 + index).toISOString(),
    sequence: 100 + index,
    runId: fillerRunId,
    data: { status: `filler-${index}` },
  }));
  const auditGate = {
    eventId: "qa-overlap-audit-gate",
    type: "runtime.heartbeat",
    occurred_at: new Date(now + 400).toISOString(),
    sequence: 400,
    runId,
    data: { status: "overlap audit ready" },
  };
  await page.evaluate((events) => window.__qaOverlapEmit(events), [...fillers, auditGate]);
  await page.waitForFunction(() => [...document.querySelectorAll("#workbench-event-list .timeline-item span")]
    .some((node) => node.textContent?.includes("overlap audit ready")));
  const deltaSummaries = await page.locator("#workbench-event-list .timeline-item").evaluateAll((items) => items
    .filter((item) => item.querySelector("strong")?.textContent === "codex.item/agentMessage/delta")
    .map((item) => item.querySelector("span")?.textContent ?? ""));
  const expected = new Set(["overlap-piece-1", "overlap-piece-2"]);
  if (deltaSummaries.length !== 2 || deltaSummaries.some((summary) => !expected.has(summary))) {
    errors.push(`snapshot/SSE partial overlap lost or duplicated delta fragments: ${JSON.stringify(deltaSummaries)}`);
  }
  findings.push({ name, viewport, deltaSummaries, errors });
  await page.close();
}

// normalizeEvent 会同时保留 data.status 并派生 content；三个约 4 MiB wire run 在驻留态
// 放大到约 24 MiB，必须按 normalized bytes 淘汰最老项，而不是只按传输行大小放行。
async function inspectRunHistoryByteBudget(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const now = Date.now();
  const runIds = [1, 2, 3].map((index) => `qa-history-bytes-${index}`);
  const runs = runIds.map((id, index) => ({
    id,
    title: `QA history bytes ${index + 1}`,
    status: "succeeded",
    createdAt: new Date(now + index).toISOString(),
    updatedAt: new Date(now + index).toISOString(),
    prompt: "验证历史字节预算",
    orchestrationMode: "pipeline",
    coordinatorId: "claude-fable",
    teamMembers: ["claude-fable", "codex-technical"],
    turns: [],
  }));
  const largeStatus = "x".repeat(7 * 1024 * 1024);
  const requests = Object.fromEntries(runIds.map((id) => [id, 0]));
  await page.route((candidate) => candidate.pathname.endsWith("/api/runs"), (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs }) });
  });
  for (const [index, runId] of runIds.entries()) {
    await page.route((candidate) => candidate.pathname.endsWith(`/api/runs/${runId}/events`), (route) => {
      requests[runId] += 1;
      const events = [{
        eventId: `qa-history-byte-payload-${index + 1}`,
        type: "runtime.heartbeat",
        occurred_at: new Date(now + index).toISOString(),
        sequence: index * 2 + 1,
        runId,
        agentId: "codex-technical",
        data: { status: largeStatus },
      }, {
        eventId: `qa-history-byte-message-${index + 1}`,
        type: "assistant.message",
        occurred_at: new Date(now + index + 1).toISOString(),
        sequence: index * 2 + 2,
        runId,
        agentId: "codex-technical",
        data: { text: `byte budget message ${index + 1}` },
      }];
      return route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      });
    });
  }
  await page.route((candidate) => candidate.pathname.endsWith("/api/events"), (route) => route.abort("failed"));

  await openControlCenter(page);
  for (const [index, runId] of runIds.entries()) {
    await page.locator(`.run-rail [data-run-select=${JSON.stringify(runId)}]`).first().click();
    await page.waitForSelector(`[data-stream-key="qa-history-byte-message-${index + 1}"]`, { timeout: 20_000 });
  }
  await page.locator(`.run-rail [data-run-select=${JSON.stringify(runIds[0])}]`).first().click();
  await waitForNodeCondition(page, () => requests[runIds[0]] >= 2, "byte-budget history refetch", errors, 20_000);
  if (requests[runIds[0]] !== 2) errors.push(`byte-budget oldest run fetched ${requests[runIds[0]]} times instead of 2`);
  if (requests[runIds[1]] !== 1 || requests[runIds[2]] !== 1) errors.push(`byte-budget fetch counts drifted: ${JSON.stringify(requests)}`);
  findings.push({ name, viewport, requests, errors });
  await page.close();
}

// MiB 级 assistant/tool 正文必须由 view=ui 在传输前投影为元数据；首次解析/挂载和缓存
// 切回都不得产生长任务，也不能让原始 secret 进入会话 DOM。
async function inspectLargeConversationPayload(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const now = Date.now();
  const largeRunId = "qa-large-conversation-run";
  const smallRunId = "qa-large-conversation-control";
  const runs = [largeRunId, smallRunId].map((id, index) => ({
    id,
    title: index ? "QA payload control" : "QA large conversation payload",
    status: "succeeded",
    createdAt: new Date(now + index).toISOString(),
    updatedAt: new Date(now + index).toISOString(),
    prompt: index ? "small control prompt" : "large payload prompt",
    orchestrationMode: "pipeline",
    coordinatorId: "claude-fable",
    teamMembers: ["claude-fable", "codex-technical"],
    turns: [],
  }));
  const secret = "token=qa-large-payload-secret-123456789";
  const assistantText = `${secret}\nassistant sentinel\n${"A".repeat(2 * 1024 * 1024)}`;
  const toolText = `${secret}\ntool sentinel\n${"T".repeat(2 * 1024 * 1024)}`;
  const largeEvents = [{
    eventId: "qa-large-assistant",
    type: "assistant.message",
    occurred_at: new Date(now + 1).toISOString(),
    sequence: 1,
    runId: largeRunId,
    agentId: "codex-technical",
    data: { text: "", textLength: assistantText.length, textOmitted: true },
  }, {
    eventId: "qa-large-tool-result",
    type: "tool.result",
    occurred_at: new Date(now + 2).toISOString(),
    sequence: 2,
    runId: largeRunId,
    agentId: "codex-technical",
    data: { results: [{ text: "", textLength: toolText.length, textOmitted: true, isError: false }] },
  }];
  const smallEvent = {
    eventId: "qa-large-control-message",
    type: "assistant.message",
    occurred_at: new Date(now + 3).toISOString(),
    sequence: 1,
    runId: smallRunId,
    agentId: "codex-technical",
    data: { text: "small control message" },
  };
  const requests = { [largeRunId]: 0, [smallRunId]: 0 };
  let historyView = "";
  await page.addInitScript((streamRunId) => {
    const nativeFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    let streamController = null;
    window.__qaLargeEventView = "";
    window.__qaLargeStreamReady = false;
    window.__qaEmitLargeProjectedEvent = (event) => {
      streamController.enqueue(encoder.encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
    };
    window.fetch = (input, init) => {
      const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const target = new URL(raw, location.href);
      if (target.pathname === "/api/events") {
        window.__qaLargeEventView = target.searchParams.get("view") ?? "";
        const body = new ReadableStream({ start(controller) {
          streamController = controller;
          window.__qaLargeStreamReady = true;
        } });
        return Promise.resolve(new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        }));
      }
      return nativeFetch(input, init);
    };
  }, largeRunId);
  await page.addInitScript(() => {
    window.__qaLargePayloadLongTasks = [];
    window.__qaLargePayloadStart = Infinity;
    if (window.PerformanceObserver?.supportedEntryTypes?.includes("longtask")) {
      const observer = new PerformanceObserver((list) => {
        window.__qaLargePayloadLongTasks.push(...list.getEntries().map((entry) => ({ startTime: entry.startTime, duration: entry.duration })));
      });
      observer.observe({ type: "longtask", buffered: true });
      window.__qaLargePayloadObserver = observer;
    }
  });
  await page.route((candidate) => candidate.pathname.endsWith("/api/runs"), (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs }) });
  });
  await page.route((candidate) => candidate.pathname.endsWith(`/api/runs/${largeRunId}/events`), (route) => {
    requests[largeRunId] += 1;
    historyView = new URL(route.request().url()).searchParams.get("view") ?? "";
    return route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: `${largeEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    });
  });
  await page.route((candidate) => candidate.pathname.endsWith(`/api/runs/${smallRunId}/events`), (route) => {
    requests[smallRunId] += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [smallEvent] }) });
  });
  await page.route((candidate) => candidate.pathname.endsWith("/api/events"), (route) => route.abort("failed"));

  await openControlCenter(page);
  await page.evaluate(() => { window.__qaLargePayloadStart = performance.now(); });
  await page.locator(`.run-rail [data-run-select=${JSON.stringify(largeRunId)}]`).first().click();
  await page.waitForSelector('[data-stream-key="qa-large-tool-result"]', { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector("#conversation-stream")?.getAttribute("aria-busy") !== "true");
  await page.waitForTimeout(150);
  const initialAudit = await page.evaluate((rawSecret) => {
    const stream = document.querySelector("#conversation-stream");
    return {
      guards: stream.querySelectorAll(".payload-render-guard").length,
      streamTextLength: stream.textContent?.length ?? 0,
      secretVisible: stream.textContent?.includes(rawSecret) ?? false,
      longTasks: window.__qaLargePayloadLongTasks.filter((entry) => entry.startTime >= window.__qaLargePayloadStart && entry.duration > 50),
    };
  }, secret);
  await page.waitForFunction(() => window.__qaLargeStreamReady === true);
  await page.evaluate((event) => window.__qaEmitLargeProjectedEvent(event), {
    eventId: "qa-large-live-projected",
    type: "assistant.message",
    occurred_at: new Date(now + 4).toISOString(),
    sequence: 4,
    runId: largeRunId,
    agentId: "codex-technical",
    data: { text: "", textLength: 2 * 1024 * 1024, textOmitted: true },
  });
  await page.waitForSelector('[data-stream-key="qa-large-live-projected"]', { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector("#conversation-stream")?.getAttribute("aria-busy") !== "true");
  await page.locator(`.run-rail [data-run-select=${JSON.stringify(smallRunId)}]`).first().click();
  await page.waitForSelector('[data-stream-key="qa-large-control-message"]', { timeout: 15_000 });
  await page.evaluate(() => { window.__qaLargePayloadStart = performance.now(); });
  await page.locator(`.run-rail [data-run-select=${JSON.stringify(largeRunId)}]`).first().click();
  await page.waitForSelector('[data-stream-key="qa-large-tool-result"]', { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector("#conversation-stream")?.getAttribute("aria-busy") !== "true");
  await page.waitForTimeout(150);
  const cachedAudit = await page.evaluate((rawSecret) => {
    const stream = document.querySelector("#conversation-stream");
    return {
      guards: stream.querySelectorAll(".payload-render-guard").length,
      streamTextLength: stream.textContent?.length ?? 0,
      secretVisible: stream.textContent?.includes(rawSecret) ?? false,
      longTasks: window.__qaLargePayloadLongTasks.filter((entry) => entry.startTime >= window.__qaLargePayloadStart && entry.duration > 50),
    };
  }, secret);
  if (requests[largeRunId] !== 1) errors.push(`large payload cache refetched ${requests[largeRunId]} times`);
  if (historyView !== "ui") errors.push(`large payload history omitted view=ui: ${historyView}`);
  const eventView = await page.evaluate(() => window.__qaLargeEventView);
  if (eventView !== "ui") errors.push(`large payload SSE omitted view=ui: ${eventView}`);
  for (const [phase, audit, expectedGuards] of [["initial", initialAudit, 2], ["cached", cachedAudit, 3]]) {
    if (audit.guards !== expectedGuards) errors.push(`${phase} large payload rendered ${audit.guards} guards instead of ${expectedGuards}`);
    if (audit.streamTextLength > 20_000) errors.push(`${phase} large payload expanded to ${audit.streamTextLength} DOM text characters`);
    if (audit.secretVisible) errors.push(`${phase} large payload guard exposed the raw secret-bearing content`);
    if (audit.longTasks.length) errors.push(`${phase} large payload render produced >50ms tasks: ${JSON.stringify(audit.longTasks)}`);
  }
  await page.screenshot({ path: resolve(outputDir, "control-center-large-payload-guard.png"), fullPage: true });
  findings.push({ name, viewport, payloadChars: assistantText.length + toolText.length, historyView, eventView, requests, initialAudit, cachedAudit, errors });
  await page.close();
}

// 活跃 run 超过 16 MiB 时保留滑动尾部，不释放整份 cache；被裁掉的会话事件数必须
// 同步平移分页 start，否则下一次正文事件重渲会把用户从原锚点跳到更晚 100 条。
async function inspectActiveHistorySlidingTail(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const now = Date.now();
  const runId = "qa-active-history-slide";
  const run = {
    id: runId,
    title: "QA active history sliding tail",
    status: "running",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    prompt: "验证活跃历史滑动尾部",
    orchestrationMode: "pipeline",
    coordinatorId: "claude-fable",
    teamMembers: ["claude-fable", "codex-technical"],
    turns: [],
  };
  const messages = Array.from({ length: 640 }, (_, index) => ({
    eventId: `qa-slide-message-${index + 1}`,
    type: "assistant.message",
    occurred_at: new Date(now + index + 1).toISOString(),
    sequence: index < 100 ? index + 1 : index + 2,
    runId,
    agentId: "codex-technical",
    data: { text: `slide message ${index + 1}` },
  }));
  const basePayload = {
    eventId: "qa-slide-base-payload",
    type: "runtime.heartbeat",
    occurred_at: new Date(now + 101).toISOString(),
    sequence: 101,
    runId,
    data: { status: "B".repeat(6 * 1024 * 1024) },
  };
  const history = [...messages.slice(0, 100), basePayload, ...messages.slice(100)];
  let historyRequests = 0;
  await page.addInitScript((streamRunId) => {
    const nativeFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    let streamController = null;
    window.__qaSlideStreamReady = false;
    window.__qaEmitSlideTail = () => {
      const large = {
        eventId: "qa-slide-live-payload",
        type: "runtime.heartbeat",
        occurred_at: new Date().toISOString(),
        sequence: 2_000,
        runId: streamRunId,
        data: { status: "L".repeat(11 * 1024 * 1024) },
      };
      const final = {
        eventId: "qa-slide-final",
        type: "assistant.message",
        occurred_at: new Date(Date.now() + 1).toISOString(),
        sequence: 2_001,
        runId: streamRunId,
        agentId: "codex-technical",
        data: { text: "slide final ready" },
      };
      for (const event of [large, final]) {
        streamController.enqueue(encoder.encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      }
    };
    window.fetch = (input, init) => {
      const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const target = new URL(raw, location.href);
      if (target.pathname === "/api/events") {
        const body = new ReadableStream({ start(controller) {
          streamController = controller;
          window.__qaSlideStreamReady = true;
        } });
        return Promise.resolve(new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        }));
      }
      return nativeFetch(input, init);
    };
  }, runId);
  await page.route((candidate) => candidate.pathname.endsWith("/api/runs"), (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [run] }) });
  });
  await page.route((candidate) => candidate.pathname.endsWith(`/api/runs/${runId}/events`), (route) => {
    historyRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: `${history.map((event) => JSON.stringify(event)).join("\n")}\n`,
    });
  });

  await openControlCenter(page);
  await page.waitForFunction(() => window.__qaSlideStreamReady === true);
  await page.locator(`.run-rail [data-run-select=${JSON.stringify(runId)}]`).first().click();
  await page.waitForSelector('[data-stream-key="qa-slide-message-640"]', { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector("#conversation-stream")?.getAttribute("aria-busy") !== "true");
  await page.locator("[data-load-earlier]").click();
  await page.waitForFunction(() => document.querySelector("#conversation-stream")?.getAttribute("aria-busy") !== "true");
  const beforeFirst = await page.locator('#conversation-stream [data-stream-key^="qa-slide-message-"]').first().getAttribute("data-stream-key");
  await page.evaluate(() => window.__qaEmitSlideTail());
  await page.waitForFunction(() => [...document.querySelectorAll("#workbench-event-list .timeline-item span")]
    .some((node) => node.textContent?.includes("slide final ready")), null, { timeout: 45_000 });
  await page.waitForFunction(() => document.querySelector("#conversation-stream")?.getAttribute("aria-busy") !== "true");
  const afterFirst = await page.locator('#conversation-stream [data-stream-key^="qa-slide-message-"]').first().getAttribute("data-stream-key");
  if (beforeFirst !== afterFirst) errors.push(`sliding tail moved pagination anchor ${beforeFirst} -> ${afterFirst}`);
  if (historyRequests !== 1) errors.push(`sliding tail released cache and refetched history ${historyRequests} times`);
  await page.locator("[data-return-latest]").click();
  await page.waitForSelector('[data-stream-key="qa-slide-final"]', { timeout: 15_000 });
  findings.push({ name, viewport, historyRequests, beforeFirst, afterFirst, errors });
  await page.close();
}

// 160 条首屏按帧挂载期间，可信用户操作取得焦点/滚动所有权；随后切换 run 时，旧
// generation 的后续批次也不得插入新会话 DOM。
async function inspectHistoryMountOwnership(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const now = Date.now();
  const runA = "qa-history-mount-a";
  const runB = "qa-history-mount-b";
  const runs = [runA, runB].map((id, index) => ({
    id,
    title: `QA mount ${index ? "B" : "A"}`,
    status: "succeeded",
    createdAt: new Date(now + index).toISOString(),
    updatedAt: new Date(now + index).toISOString(),
    prompt: "验证分批挂载 ownership",
    orchestrationMode: "pipeline",
    coordinatorId: "claude-fable",
    teamMembers: ["claude-fable", "codex-technical"],
    turns: [],
  }));
  const event = (runId, id, sequence, { tool = false } = {}) => ({
    eventId: id,
    type: tool ? "tool.result" : "assistant.message",
    occurred_at: new Date(now + sequence).toISOString(),
    sequence,
    runId,
    agentId: "codex-technical",
    data: tool ? { results: [{ text: id, isError: false }] } : { text: id },
  });
  const historyA = Array.from({ length: 720 }, (_, index) => event(runA, `qa-mount-a-${index + 1}`, index + 1, { tool: true }));
  const historyB = [event(runB, "qa-mount-b-only", 1)];
  await page.addInitScript(() => {
    window.__qaWatchStaleMount = false;
    window.__qaStaleMounts = 0;
    if (typeof window.scheduler?.yield === "function") {
      const nativeYield = window.scheduler.yield.bind(window.scheduler);
      const control = { holdNext: false, held: false, release: null };
      window.__qaMountYieldControl = control;
      window.scheduler.yield = (...args) => {
        if (!control.holdNext) return nativeYield(...args);
        control.holdNext = false;
        control.held = true;
        return new Promise((resolveYield, rejectYield) => {
          control.release = () => {
            control.release = null;
            control.held = false;
            nativeYield(...args).then(resolveYield, rejectYield);
          };
        });
      };
    }
    document.addEventListener("DOMContentLoaded", () => {
      const stream = document.querySelector("#conversation-stream");
      new MutationObserver(() => {
        if (
          window.__qaWatchStaleMount
          && stream.querySelector('[data-stream-key="qa-mount-b-only"]')
          && stream.querySelector('[data-stream-key^="qa-mount-a-"]')
        ) {
          window.__qaStaleMounts += 1;
        }
      }).observe(stream, { childList: true, subtree: false });
    }, { once: true });
  });
  await page.route((candidate) => candidate.pathname.endsWith("/api/runs"), (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs }) });
  });
  await page.route((candidate) => candidate.pathname.endsWith(`/api/runs/${runA}/events`), (route) =>
    route.fulfill({ status: 200, contentType: "application/x-ndjson", body: `${historyA.map(JSON.stringify).join("\n")}\n` }),
  );
  await page.route((candidate) => candidate.pathname.endsWith(`/api/runs/${runB}/events`), (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: historyB }) }),
  );
  await page.route((candidate) => candidate.pathname.endsWith("/api/events"), (route) => route.abort("failed"));

  await openControlCenter(page);
  await page.locator(`.run-rail [data-run-select=${JSON.stringify(runA)}]`).first().click();
  await page.waitForSelector('[data-stream-key^="qa-mount-a-"]', { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector("#conversation-stream")?.getAttribute("aria-busy") !== "true");

  const armMountYield = async () => page.evaluate(() => {
    const control = window.__qaMountYieldControl;
    if (!control) return false;
    control.holdNext = true;
    control.held = false;
    control.release = null;
    return true;
  });
  const waitForHeldMount = async (label) => {
    const deadline = Date.now() + 10_000;
    let held = false;
    while (!held && Date.now() < deadline) {
      held = await page.evaluate(() => Boolean(
        window.__qaMountYieldControl?.held
        && document.querySelector("#conversation-stream")?.getAttribute("aria-busy") === "true",
      ));
      if (!held) await page.waitForTimeout(25);
    }
    if (!held) errors.push(`timed out waiting for controlled ${label} mount`);
    return held;
  };

  if (!(await armMountYield())) errors.push("scheduler.yield ownership fixture was not installed");
  await page.locator("[data-load-earlier]").click();
  await waitForHeldMount("user-interaction");
  const interactedSummary = page.locator('#conversation-stream [data-stream-key^="qa-mount-a-"] summary').first();
  await interactedSummary.click();
  const streamBox = await page.locator("#conversation-stream").boundingBox();
  if (streamBox) {
    await page.mouse.move(streamBox.x + streamBox.width / 2, streamBox.y + Math.min(120, streamBox.height / 2));
    await page.mouse.wheel(0, 180);
  }
  const interactedKey = await interactedSummary.evaluate((summary) => summary.closest("[data-stream-key]")?.dataset.streamKey ?? "");
  await page.evaluate(() => window.__qaMountYieldControl?.release?.());
  await page.waitForFunction(() => document.querySelector("#conversation-stream")?.getAttribute("aria-busy") !== "true");
  const interactionAudit = await page.evaluate(() => ({
    activeKey: document.activeElement?.closest?.("[data-stream-key]")?.dataset.streamKey ?? "",
    activeTag: document.activeElement?.tagName ?? "",
  }));
  if (interactionAudit.activeKey !== interactedKey || interactionAudit.activeTag !== "SUMMARY") {
    errors.push(`history mount restored a stale focus snapshot over user input: ${JSON.stringify({ interactedKey, ...interactionAudit })}`);
  }

  await page.evaluate(() => { window.__qaWatchStaleMount = true; });
  await armMountYield();
  await page.locator("[data-return-latest]").click();
  await waitForHeldMount("stale-generation");
  await page.locator(`.run-rail [data-run-select=${JSON.stringify(runB)}]`).first().click();
  await page.waitForSelector('[data-stream-key="qa-mount-b-only"]', { timeout: 15_000 });
  await page.evaluate(() => window.__qaMountYieldControl?.release?.());
  await page.waitForTimeout(350);
  const audit = await page.evaluate(() => ({
    staleAdds: window.__qaStaleMounts,
    oldNodes: document.querySelectorAll('#conversation-stream [data-stream-key^="qa-mount-a-"]').length,
    newNodes: document.querySelectorAll('#conversation-stream [data-stream-key="qa-mount-b-only"]').length,
    oldYieldHeld: Boolean(window.__qaMountYieldControl?.held),
  }));
  if (audit.staleAdds || audit.oldNodes || audit.newNodes !== 1 || audit.oldYieldHeld) errors.push(`history mount ownership failed: ${JSON.stringify(audit)}`);
  findings.push({ name, viewport, interactionAudit, audit, errors });
  await page.close();
}

// 项目偏好写队列 + CAS 三方重放：同页中间状态合并成 latest；跨标签页冲突后，
// 本地字段意图重放到最新权威文档，不同 key/field 保留，同字段以本地最终意图为准。
async function inspectProjectPrefsQueue(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const projectId = "qa-project-prefs";
  const projectPath = "I:\\qa\\project-prefs";
  const projectKey = "i:\\qa\\project-prefs";
  const remoteProjectId = "qa-project-remote";
  const remoteProjectPath = "I:\\qa\\project-remote";
  const remoteProjectKey = "i:\\qa\\project-remote";
  const projectData = {
    available: true,
    projects: [
      {
        id: projectId,
        path: projectPath,
        label: "QA Project Prefs",
        sessionCount: 1,
        sessions: [{ id: "qa-project-session", cli: "claude", label: "QA session", modifiedAt: new Date().toISOString() }],
      },
      {
        id: remoteProjectId,
        path: remoteProjectPath,
        label: "QA Remote Project",
        sessionCount: 0,
        sessions: [],
      },
    ],
  };
  let authoritative = { revision: 0, projects: {}, sessions: {} };
  const putBodies = [];
  let getRequests = 0;
  let releaseFirstPut;
  const firstPutGate = new Promise((resolveGate) => { releaseFirstPut = resolveGate; });
  let signalConflictPut;
  const conflictPutReached = new Promise((resolveReached) => { signalConflictPut = resolveReached; });
  let releaseConflictPut;
  const conflictPutGate = new Promise((resolveGate) => { releaseConflictPut = resolveGate; });

  await page.route((candidate) => candidate.pathname.endsWith("/api/sessions/projects"), (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(projectData) }),
  );
  await page.route((candidate) => candidate.pathname.endsWith("/api/projects/prefs"), async (route) => {
    if (route.request().method() === "GET") {
      getRequests += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authoritative) });
    }
    const body = route.request().postDataJSON();
    putBodies.push(body);
    const requestIndex = putBodies.length;
    if (requestIndex === 1) await firstPutGate;
    if (requestIndex === 3) {
      signalConflictPut();
      await conflictPutGate;
      // 模拟另一标签页：同项目改 teamId/name，另一个项目置顶。客户端只能覆盖本地真正改过的 name。
      authoritative = {
        revision: authoritative.revision + 1,
        projects: {
          ...authoritative.projects,
          [projectKey]: { ...authoritative.projects[projectKey], name: "Remote Same Field", teamId: "team-remote" },
          [remoteProjectKey]: { pinned: true, name: "Remote Different Key" },
        },
        sessions: authoritative.sessions,
      };
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "PREFS_REVISION_MISMATCH", message: "qa concurrent update" } }),
      });
    }
    if (body.baseRevision !== authoritative.revision) {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "PREFS_REVISION_MISMATCH", message: "unexpected QA revision" } }),
      });
    }
    authoritative = {
      revision: authoritative.revision + 1,
      projects: body.projects ?? {},
      sessions: body.sessions ?? {},
    };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authoritative) });
  });
  await page.route((candidate) => candidate.pathname.endsWith("/api/events"), (route) => route.abort("failed"));

  await openControlCenter(page);
  const projectMenuSelector = `[data-project-menu=${JSON.stringify(projectId)}]`;
  await page.waitForSelector(projectMenuSelector, { timeout: 10_000 });
  await page.locator(projectMenuSelector).first().click();
  await page.getByRole("menuitem", { name: "置顶项目", exact: true }).click();
  await waitForNodeCondition(page, () => putBodies.length === 1, "first project-prefs PUT", errors);
  await page.waitForSelector(`[data-pinned-project=${JSON.stringify(projectId)}]`, { timeout: 5_000 });

  const renameProject = async (name) => {
    await page.locator(projectMenuSelector).first().click();
    await page.getByRole("menuitem", { name: "重命名项目", exact: true }).click();
    await page.locator("#input-dialog-value").fill(name);
    await page.locator("#input-dialog-confirm").click();
    await page.waitForTimeout(40);
  };
  await renameProject("QA Queued Intermediate");
  await renameProject("QA Queued Final");
  await page.waitForTimeout(100);
  if (putBodies.length !== 1) errors.push(`project prefs queue issued ${putBodies.length} PUTs before the first completed`);

  releaseFirstPut();
  await waitForNodeCondition(page, () => putBodies.length === 2, "second queued project-prefs PUT", errors);
  const firstPref = putBodies[0]?.projects?.[projectKey] ?? {};
  const secondPref = putBodies[1]?.projects?.[projectKey] ?? {};
  if (firstPref.pinned !== true || firstPref.name) errors.push(`first project-prefs snapshot was not isolated: ${JSON.stringify(firstPref)}`);
  if (secondPref.pinned !== true || secondPref.name !== "QA Queued Final") errors.push(`second project-prefs snapshot was stale: ${JSON.stringify(secondPref)}`);
  if (putBodies[0]?.baseRevision !== 0 || putBodies[1]?.baseRevision !== 1) errors.push(`queued CAS revisions were ${putBodies.map((body) => body.baseRevision).join(",")}`);

  await page.waitForTimeout(120);
  await renameProject("QA Conflict Interim");
  await waitForSignal(conflictPutReached, "project prefs conflict PUT");
  await renameProject("QA Local Final Wins");
  if (putBodies.length !== 3) errors.push(`pending conflict edit escaped the one-inflight/one-latest queue: ${putBodies.length}`);
  releaseConflictPut();
  await waitForNodeCondition(page, () => putBodies.length === 5 && getRequests >= 2, "409 three-way rebase and latest replay", errors, 10_000);

  const retryPref = putBodies[3]?.projects?.[projectKey] ?? {};
  const finalPref = putBodies[4]?.projects?.[projectKey] ?? {};
  const finalRemotePref = putBodies[4]?.projects?.[remoteProjectKey] ?? {};
  if (putBodies[2]?.baseRevision !== 2 || putBodies[3]?.baseRevision !== 3 || putBodies[4]?.baseRevision !== 4) {
    errors.push(`409 retry revisions were ${putBodies.slice(2).map((body) => body.baseRevision).join(",")}`);
  }
  if (retryPref.name !== "QA Conflict Interim" || retryPref.teamId !== "team-remote") {
    errors.push(`409 retry did not merge same-key different-field remote state: ${JSON.stringify(retryPref)}`);
  }
  if (finalPref.name !== "QA Local Final Wins" || finalPref.teamId !== "team-remote") {
    errors.push(`latest local intent was not replayed after conflict: ${JSON.stringify(finalPref)}`);
  }
  if (finalRemotePref.pinned !== true || finalRemotePref.name !== "Remote Different Key") {
    errors.push(`409 rebase overwrote a different remote key: ${JSON.stringify(finalRemotePref)}`);
  }
  const restoredProject = page.locator(`[data-pinned-project=${JSON.stringify(projectId)}]`);
  const restoredText = await restoredProject.textContent().catch(() => "");
  if (!restoredText?.includes("QA Local Final Wins")) errors.push("rebased project name was not rendered from the final authoritative response");
  const toastText = await page.locator("#toast-region").textContent();
  if (!toastText?.includes("正在合并本地修改")) errors.push("409 merge was not announced to the user");

  findings.push({ name, viewport, putCount: putBodies.length, getRequests, revisions: putBodies.map((body) => body.baseRevision), errors });
  await page.close();
}

// 首次 GET 失败时禁止覆盖式 PUT；后续用户动作必须真实重试，只有读到权威 revision 后才解锁写入。
async function inspectProjectPrefsLoadFailure(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const projectId = "qa-prefs-load-failure";
  const projectPath = "I:\\qa\\prefs-load-failure";
  const projectKey = "i:\\qa\\prefs-load-failure";
  let getRequests = 0;
  const putBodies = [];
  let authoritative = { revision: 0, projects: {}, sessions: {} };
  await page.route((candidate) => candidate.pathname.endsWith("/api/sessions/projects"), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        projects: [{
          id: projectId,
          path: projectPath,
          label: "QA Prefs Load Failure",
          sessionCount: 1,
          sessions: [{ id: "qa-prefs-load-session", cli: "claude", label: "QA prefs load session", modifiedAt: new Date().toISOString() }],
        }],
      }),
    }),
  );
  await page.route((candidate) => candidate.pathname.endsWith("/api/projects/prefs"), (route) => {
    if (route.request().method() === "GET") {
      getRequests += 1;
      if (getRequests <= 2) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "qa forced initial prefs failure" } }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authoritative) });
    }
    const body = route.request().postDataJSON();
    putBodies.push(body);
    authoritative = { revision: authoritative.revision + 1, projects: body.projects ?? {}, sessions: body.sessions ?? {} };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authoritative) });
  });
  await page.route((candidate) => candidate.pathname.endsWith("/api/events"), (route) => route.abort("failed"));

  await openControlCenter(page);
  const menu = page.locator(`[data-project-menu=${JSON.stringify(projectId)}]`).first();
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  await menu.click();
  await page.getByRole("menuitem", { name: "置顶项目", exact: true }).click();
  await waitForNodeCondition(page, () => getRequests >= 2, "failed user-triggered prefs retry", errors);
  await page.waitForTimeout(100);
  if (putBodies.length) errors.push("prefs PUT escaped while authoritative GET was still failing");

  await menu.click();
  await page.getByRole("menuitem", { name: "置顶项目", exact: true }).click();
  await waitForNodeCondition(page, () => putBodies.length === 1, "prefs PUT after successful retry", errors);
  if (getRequests !== 3) errors.push(`prefs retry GET count was ${getRequests}, expected 3`);
  if (putBodies[0]?.baseRevision !== 0 || putBodies[0]?.projects?.[projectKey]?.pinned !== true) {
    errors.push(`prefs write after retry had the wrong authoritative base: ${JSON.stringify(putBodies[0])}`);
  }
  findings.push({ name, viewport, getRequests, putCount: putBodies.length, errors });
  await page.close();
}

// 409 后的权威 GET 也可能失败。此时 active 操作与 one-latest 必须合并保留，
// 写锁解除后再基于新 revision 重放，不能退回空快照或清掉本地意图。
async function inspectProjectPrefsConflictReadFailure(name, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const projectId = "qa-prefs-conflict-read-failure";
  const projectPath = "I:\\qa\\prefs-conflict-read-failure";
  const projectKey = "i:\\qa\\prefs-conflict-read-failure";
  const remoteKey = "i:\\qa\\remote-survivor";
  let authoritative = { revision: 0, projects: {}, sessions: {} };
  let getRequests = 0;
  const putBodies = [];
  let signalConflictPut;
  let releaseConflictPut;
  const conflictPutReached = new Promise((resolveReached) => { signalConflictPut = resolveReached; });
  const conflictPutGate = new Promise((resolveGate) => { releaseConflictPut = resolveGate; });

  await page.route((candidate) => candidate.pathname.endsWith("/api/sessions/projects"), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        projects: [{
          id: projectId,
          path: projectPath,
          label: "QA Conflict Read Failure",
          sessionCount: 1,
          sessions: [{ id: "qa-prefs-conflict-session", cli: "claude", label: "QA prefs conflict session", modifiedAt: new Date().toISOString() }],
        }],
      }),
    }),
  );
  await page.route((candidate) => candidate.pathname.endsWith("/api/projects/prefs"), async (route) => {
    if (route.request().method() === "GET") {
      getRequests += 1;
      if (getRequests === 2) {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "qa forced post-conflict GET failure" } }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authoritative) });
    }
    const body = route.request().postDataJSON();
    putBodies.push(body);
    if (putBodies.length === 1) {
      signalConflictPut();
      await conflictPutGate;
      authoritative = {
        revision: 1,
        projects: {
          [projectKey]: { teamId: "team-remote" },
          [remoteKey]: { pinned: true, name: "Remote Survivor" },
        },
        sessions: {},
      };
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "PREFS_REVISION_MISMATCH", message: "qa conflict before failed GET" } }),
      });
    }
    if (body.baseRevision !== authoritative.revision) {
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "PREFS_REVISION_MISMATCH", message: "qa unexpected revision" } }) });
    }
    authoritative = { revision: authoritative.revision + 1, projects: body.projects ?? {}, sessions: body.sessions ?? {} };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authoritative) });
  });
  await page.route((candidate) => candidate.pathname.endsWith("/api/events"), (route) => route.abort("failed"));

  await openControlCenter(page);
  const menuSelector = `[data-project-menu=${JSON.stringify(projectId)}]`;
  const renameProject = async (name) => {
    await page.locator(menuSelector).first().click();
    await page.getByRole("menuitem", { name: "重命名项目", exact: true }).click();
    await page.locator("#input-dialog-value").fill(name);
    await page.locator("#input-dialog-confirm").click();
  };

  await page.locator(menuSelector).first().click();
  await page.getByRole("menuitem", { name: "置顶项目", exact: true }).click();
  await waitForSignal(conflictPutReached, "project prefs conflict PUT before failed GET");
  await renameProject("QA Pending Latest Preserved");
  releaseConflictPut();
  await waitForNodeCondition(page, () => getRequests >= 2, "failed post-conflict authoritative GET", errors);
  await page.waitForTimeout(120);
  if (putBodies.length !== 1) errors.push(`prefs write escaped after failed conflict GET: ${putBodies.length}`);

  await renameProject("QA Retry Final");
  await waitForNodeCondition(page, () => putBodies.length >= 3 && getRequests >= 3, "preserved prefs replay after GET recovery", errors, 10_000);
  const preserved = putBodies[1]?.projects ?? {};
  const final = putBodies.at(-1)?.projects ?? {};
  if (putBodies[1]?.baseRevision !== 1) errors.push(`preserved operation replayed from revision ${putBodies[1]?.baseRevision}`);
  if (preserved[projectKey]?.pinned !== true || preserved[projectKey]?.name !== "QA Pending Latest Preserved" || preserved[projectKey]?.teamId !== "team-remote") {
    errors.push(`active/latest local intent was not preserved after failed GET: ${JSON.stringify(preserved[projectKey])}`);
  }
  if (preserved[remoteKey]?.name !== "Remote Survivor") errors.push("remote different-key state was lost during failed-GET recovery");
  if (final[projectKey]?.name !== "QA Retry Final" || final[projectKey]?.pinned !== true || final[projectKey]?.teamId !== "team-remote") {
    errors.push(`post-recovery latest intent was not saved: ${JSON.stringify(final[projectKey])}`);
  }
  findings.push({ name, viewport, getRequests, putCount: putBodies.length, revisions: putBodies.map((body) => body.baseRevision), errors });
  await page.close();
}

// AutomationStore 的 fail-closed 状态必须在工作台显式可见。200 degraded 覆盖后端
// 诊断契约，503 覆盖连接/端点失败；两者都不能伪装成“空列表”或留下可写入口。
async function inspectAutomationDegradedState(name, viewport) {
  const errors = [];
  const scenarios = [
    {
      id: "degraded",
      status: 200,
      body: {
        automations: [{
          id: "qa-degraded-automation",
          name: "QA degraded automation",
          prompt: "read-only snapshot",
          schedule: "manual",
          enabled: true,
          lastRunId: null,
        }],
        status: {
          state: "degraded",
          writable: false,
          failClosed: true,
          code: "AUTOMATION_STORE_CORRUPT",
          message: "qa corrupt store",
        },
      },
      expectedWriteActions: 2,
      expectedInspectActions: 2,
      expectedText: "原文件已保留",
    },
    {
      id: "unavailable",
      status: 503,
      body: { error: { code: "AUTOMATION_STORE_UNREADABLE", message: "qa unavailable store" } },
      expectedWriteActions: 1,
      expectedInspectActions: 0,
      expectedText: "状态不可用",
    },
  ];

  for (const scenario of scenarios) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (error) => errors.push(`${scenario.id} pageerror: ${error.message}`));
    await page.route((candidate) => candidate.pathname.endsWith("/api/automations"), (route) =>
      route.fulfill({ status: scenario.status, contentType: "application/json", body: JSON.stringify(scenario.body) }),
    );
    await openControlCenter(page);
    await page.locator("#rail-automations-row").click();
    const snapshot = await page.evaluate(() => {
      const pane = document.querySelector("#automations-workbench");
      const writeActions = [...document.querySelectorAll("#automations-workbench [data-auto-run], #automations-workbench [data-auto-toggle], #automations-workbench [data-auto-action='create']")];
      const inspectActions = [...document.querySelectorAll("#automations-workbench [data-auto-edit], #automations-workbench [data-auto-open]")];
      return {
        hidden: pane?.hidden,
        alertText: document.querySelector("#automations-workbench [role=alert]")?.textContent ?? "",
        saveDisabled: document.querySelector("#save-automation-button")?.disabled,
        writeActionCount: writeActions.length,
        disabledWriteActions: writeActions.filter((button) => button.disabled).length,
        inspectActionCount: inspectActions.length,
        disabledInspectActions: inspectActions.filter((button) => button.disabled).length,
      };
    });
    if (snapshot.hidden) errors.push(`${scenario.id} automation pane was hidden`);
    if (!snapshot.alertText.includes(scenario.expectedText)) errors.push(`${scenario.id} alert was not actionable: ${snapshot.alertText}`);
    if (!snapshot.saveDisabled) errors.push(`${scenario.id} save automation remained writable`);
    if (snapshot.writeActionCount !== scenario.expectedWriteActions || snapshot.disabledWriteActions !== snapshot.writeActionCount) {
      errors.push(`${scenario.id} write actions were not all disabled: ${snapshot.disabledWriteActions}/${snapshot.writeActionCount}`);
    }
    if (snapshot.inspectActionCount !== scenario.expectedInspectActions || snapshot.disabledInspectActions !== 0) {
      errors.push(`${scenario.id} read-only inspection actions were not available: ${snapshot.disabledInspectActions}/${snapshot.inspectActionCount}`);
    }
    await page.close();
  }
  findings.push({ name, viewport, scenarios: scenarios.map((item) => item.id), errors });
}

try {
  if (suite === "mission" || suite === "all") {
    await inspectMissionControl("desktop", { width: 1440, height: 900 });
    await inspectMissionControl("compact-desktop", { width: 1280, height: 800 });
    await inspectMissionControl("tablet", { width: 820, height: 1180 });
    await inspectMissionControl("mobile", { width: 390, height: 844 });
  }
  if (suite === "workbench" || suite === "all") {
    // Long Tasks API uses wall-clock duration and therefore includes browser GC/scheduling.
    // Run the strict delta gate before screenshot/layout churn in the shared Chromium process,
    // so a >50ms finding belongs to this stream rather than an earlier closed page.
    await inspectContinuousDeltaIsolation("continuous-delta-desktop", { width: 1440, height: 900 });
    await inspectContinuousDeltaIsolation("continuous-delta-mobile", { width: 390, height: 844 });
    await inspectWorkbenchStateMachine("workbench-state-machine", { width: 1440, height: 900 });
    await inspectSseDomStability("sse-dom-stability-desktop", { width: 1440, height: 900 });
    await inspectSseDomStability("sse-dom-stability-mobile", { width: 390, height: 844 });
    await inspectDeltaTrackingBoundary("delta-tracking-boundary", { width: 1440, height: 900 });
    await inspectRunHistoryCache("run-history-cache", { width: 1440, height: 900 });
    await inspectRunHistoryAbortReopen("run-history-abort-reopen", { width: 1440, height: 900 });
    await inspectRunHistorySseContinuity("run-history-sse-continuity", { width: 1440, height: 900 });
    await inspectRunHistorySnapshotDeltaOverlap("run-history-delta-overlap", { width: 1440, height: 900 });
    await inspectRunHistoryByteBudget("run-history-byte-budget", { width: 1440, height: 900 });
    await inspectLargeConversationPayload("large-conversation-payload", { width: 1440, height: 900 });
    await inspectActiveHistorySlidingTail("active-history-sliding-tail", { width: 1440, height: 900 });
    await inspectHistoryMountOwnership("history-mount-ownership", { width: 1440, height: 900 });
    await inspectMessageChannelYieldFallback("message-channel-yield-fallback", { width: 1440, height: 900 });
    await inspectCollapsedProjectDom("collapsed-project-dom-desktop", { width: 1440, height: 900 });
    await inspectCollapsedProjectDom("collapsed-project-dom-mobile", { width: 390, height: 844 });
    await inspectLongHistoryWindow("long-history-window", { width: 1440, height: 900 });
    await inspectProjectPrefsQueue("project-prefs-queue", { width: 1440, height: 900 });
    await inspectProjectPrefsLoadFailure("project-prefs-load-failure", { width: 1440, height: 900 });
    await inspectProjectPrefsConflictReadFailure("project-prefs-conflict-read-failure", { width: 1440, height: 900 });
    await inspectAutomationDegradedState("automation-degraded-state", { width: 1440, height: 900 });
  }
  if (suite === "layout" || suite === "all") {
    await inspect("desktop", { width: 1440, height: 900 });
    await inspect("compact-desktop", { width: 1280, height: 800 });
    await inspect("tablet", { width: 820, height: 1180 });
    await inspect("mobile", { width: 390, height: 844 });
  }
  if (suite === "history") {
    await inspectRunHistorySseContinuity("run-history-sse-continuity", { width: 1440, height: 900 });
    await inspectRunHistorySnapshotDeltaOverlap("run-history-delta-overlap", { width: 1440, height: 900 });
    await inspectRunHistoryByteBudget("run-history-byte-budget", { width: 1440, height: 900 });
    await inspectLargeConversationPayload("large-conversation-payload", { width: 1440, height: 900 });
    await inspectActiveHistorySlidingTail("active-history-sliding-tail", { width: 1440, height: 900 });
    await inspectHistoryMountOwnership("history-mount-ownership", { width: 1440, height: 900 });
    await inspectMessageChannelYieldFallback("message-channel-yield-fallback", { width: 1440, height: 900 });
    await inspectLongHistoryWindow("long-history-window", { width: 1440, height: 900 });
  }
  if (suite === "delta") {
    await inspectContinuousDeltaIsolation("continuous-delta-desktop", { width: 1440, height: 900 });
    await inspectContinuousDeltaIsolation("continuous-delta-mobile", { width: 390, height: 844 });
    await inspectDeltaTrackingBoundary("delta-tracking-boundary", { width: 1440, height: 900 });
    await inspectRunHistorySnapshotDeltaOverlap("run-history-delta-overlap", { width: 1440, height: 900 });
  }
} finally {
  await browser.close();
}

process.stdout.write(`${JSON.stringify({ ok: findings.every((item) => item.errors.length === 0), findings }, null, 2)}\n`);
if (findings.some((item) => item.errors.length)) process.exitCode = 1;
