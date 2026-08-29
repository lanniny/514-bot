#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "..", "..");
const qaRunId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomBytes(4).toString("hex")}`;
const outputRoot = resolve(appRoot, ".qa-output", "remote-config", qaRunId);
const dataRoot = resolve(outputRoot, "runtime");
const runtimeHome = resolve(outputRoot, "runtime-home");
const qaToken = randomBytes(32).toString("base64url");

await Promise.all([
  mkdir(outputRoot, { recursive: true }),
  mkdir(dataRoot, { recursive: true }),
  mkdir(runtimeHome, { recursive: true }),
]);

const host = {
  id: "host-a",
  name: "QA Remote Host",
  host: "192.0.2.10",
  port: 22,
  user: "qa",
  enabled: true,
  trusted: true,
};
const offlineHost = {
  id: "host-offline",
  name: "QA Offline Host",
  host: "192.0.2.20",
  port: 22,
  user: "qa-offline",
  enabled: true,
  trusted: true,
};
const project = {
  id: "project-b",
  name: "QA Remote Project With A Deliberately Long Name For Responsive Target Testing",
  hostId: host.id,
  path: "/srv/qa-project/worktrees/a-very-long-project-directory/feature/remote-configuration-resilience-and-recovery",
  host: { ...host },
};
const secondaryProject = {
  id: "project-c",
  name: "QA Secondary Project",
  hostId: host.id,
  path: "/srv/secondary-project",
  host: { ...host },
};
const offlineProject = {
  id: "project-offline",
  name: "QA Offline Project",
  hostId: offlineHost.id,
  path: "/srv/offline-project",
  host: { ...offlineHost },
};
const remoteProjects = [project, secondaryProject, offlineProject];
const provider = {
  id: "provider-qa",
  name: "QA Provider",
  category: "custom",
  baseUrl: "https://central.qa.example/v1",
  websiteUrl: "https://central.qa.example",
  hasApiKey: true,
  apiKeyMasked: "sk-***qa",
  apps: { claude: true, codex: true },
  models: { claude: "claude-qa", codex: "gpt-qa" },
};
const team = {
  id: "team-qa",
  name: "QA Team",
  providers: { claude: provider.id, codex: provider.id },
};
const historySource = {
  id: "qa.history",
  name: "QA History Config",
  path: "config/qa-history.json",
  scope: "repo",
  format: "json",
  readOnly: false,
  critical: false,
  sha256: "d".repeat(64),
};
const historyVersion = {
  versionId: "qa-history-v1",
  fromSha256: "e".repeat(64),
  createdAt: "2026-08-11T12:00:00.000Z",
  reason: "QA previous snapshot",
};
const syncFile = {
  id: "codex-config",
  label: "Codex config",
  local: ".codex/config.toml",
  remote: ".codex/config.toml",
  exists: true,
  size: 120,
  containsSecrets: false,
  digest: "c".repeat(64),
};

function graphFor(target, revision = "initial") {
  const isProject = target === "project";
  const base = isProject ? project.path : "/home/qa";
  return {
    home: "/home/qa",
    projectPath: isProject ? base : null,
    providers: [{
      cli: "claude",
      label: "Claude",
      file: isProject ? ".claude/settings.json" : ".claude/settings.json",
      sourceId: isProject ? "project-claude" : "claude-settings",
      scope: isProject ? "project" : "host",
      exists: true,
      model: `claude-${revision}`,
      baseUrl: "https://remote.qa.example/v1",
      wireApi: "anthropic",
    }],
    capabilities: [
      { kind: "agent", name: "reviewer", cli: "codex", scope: isProject ? "project" : "host" },
      { kind: "skill", name: "co-review", cli: "codex", scope: isProject ? "project" : "host" },
      { kind: "command", name: "deploy-check", cli: "claude", scope: isProject ? "project" : "host" },
      { kind: "prompt", name: "system", cli: "claude", scope: isProject ? "project" : "host" },
    ],
    mcp: [{ name: "context7", cli: "claude", source: `${base}/.claude.json`, scope: isProject ? "project" : "host" }],
    sources: [
      {
        id: isProject ? "project-agents" : "codex-agents",
        label: isProject ? "Project AGENTS" : "Codex AGENTS",
        remote: `${base}/${isProject ? "AGENTS.md" : ".codex/AGENTS.md"}`,
        projectRelative: isProject ? "AGENTS.md" : null,
        scope: isProject ? "project" : "host",
        cli: "codex",
        exists: true,
        editable: true,
        sensitive: false,
        truncated: false,
        size: 64,
        mtime: "2026-08-12T00:00:00.000Z",
      },
      {
        id: isProject ? "project-claude" : "claude-settings",
        label: "Claude Settings",
        remote: `${base}/.claude/settings.json`,
        projectRelative: isProject ? ".claude/settings.json" : null,
        scope: isProject ? "project" : "host",
        cli: "claude",
        exists: true,
        editable: false,
        sensitive: true,
        truncated: false,
        size: 128,
        mtime: "2026-08-12T00:00:00.000Z",
      },
    ],
    // 形状对齐 remote-graph 的 inventory 投影：sourceId 决定挂到哪个真源，name 是远端备份文件名
    backups: [
      {
        sourceId: isProject ? "project-agents" : "codex-agents",
        name: "AGENTS.md.514forge-backup-2f8c1d90",
        scope: isProject ? "project" : "host",
        remote: `${base}/${isProject ? "AGENTS.md" : ".codex/AGENTS.md"}.514forge-backup-2f8c1d90`,
        size: 96,
        mtime: "2026-08-11T23:56:00.000Z",
      },
      {
        sourceId: isProject ? "project-claude" : "claude-settings",
        name: "settings.json.514forge-backup-7a1e4b02",
        scope: isProject ? "project" : "host",
        remote: `${base}/.claude/settings.json.514forge-backup-7a1e4b02`,
        size: 128,
        mtime: "2026-08-12T00:10:00.000Z",
      },
    ],
  };
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`${label} timed out`);
}

let serverError = "";
let origin = "";
let sharedToken = qaToken;
let browser = null;
const server = spawn(process.execPath, ["--experimental-sqlite", "server.mjs", "--port=0"], {
  cwd: appRoot,
  env: {
    ...process.env,
    CONTROL_CENTER_REPO_ROOT: repoRoot,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_RUNTIME_HOME: runtimeHome,
    CONTROL_CENTER_OPEN: "0",
    CONTROL_CENTER_TEST_MODE: "1",
    CONTROL_CENTER_TOKEN: qaToken,
    USERPROFILE: runtimeHome,
    HOME: runtimeHome,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => { serverError += chunk; });

function waitForBootstrapUrl() {
  return new Promise((resolveReady, rejectReady) => {
    let stdout = "";
    const cleanup = () => {
      clearTimeout(timer);
      server.stdout?.off("data", onStdout);
      server.off("exit", onExit);
      server.off("error", onError);
    };
    const finish = (callback, value) => { cleanup(); callback(value); };
    const onStdout = (chunk) => {
      stdout += chunk;
      const match = stdout.match(/514cc Control Center: (http:\/\/[^\s]+)/);
      if (match) finish(resolveReady, match[1]);
    };
    const onExit = (code) => finish(rejectReady, new Error(`server exited before ready (${code}): ${serverError}`));
    const onError = (error) => finish(rejectReady, new Error(`server failed to start: ${error.message}; ${serverError}`));
    const timer = setTimeout(() => finish(rejectReady, new Error(`server start timed out: ${serverError}`)), 30_000);
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", onStdout);
    server.once("exit", onExit);
    server.once("error", onError);
  });
}

function serverExited() {
  return server.exitCode !== null || server.signalCode !== null;
}

function waitForServerExit(timeoutMs) {
  if (serverExited()) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const cleanup = () => { clearTimeout(timer); server.off("exit", onExit); };
    const onExit = () => { cleanup(); resolveExit(true); };
    const timer = setTimeout(() => { cleanup(); resolveExit(false); }, timeoutMs);
    server.once("exit", onExit);
  });
}

async function stopQaServer() {
  if (serverExited()) return;
  if (origin && sharedToken) {
    try {
      const response = await fetch(new URL("/api/test/shutdown", origin), {
        method: "POST",
        headers: { authorization: `Bearer ${sharedToken}` },
        signal: AbortSignal.timeout(2_000),
      });
      await response.arrayBuffer().catch(() => {});
      if (response.status === 202 && await waitForServerExit(5_000)) return;
    } catch {
      // The owned process fallback below handles incomplete startup.
    }
  }
  if (!server.kill() && !serverExited()) throw new Error(`QA server pid ${server.pid} refused termination`);
  if (!await waitForServerExit(5_000)) throw new Error(`QA server pid ${server.pid} did not exit`);
}

const json = (route, body, status = 200) => route.fulfill({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const evidence = {
  providerPlans: [],
  providerApplies: [],
  sourceWrites: [],
  backupReads: [],
  backupRestores: [],
  graphRequests: [],
  syncRequests: [],
  expectedHttpFailures: [],
};
let sourceReadRevision = 0;
let graphRace = false;
let graphRaceIndex = 0;
let forceProviderRecovery = false;

async function installMockRoutes(context) {
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (method === "GET" && path === "/api/workbench/environment") {
      return json(route, {
        schema: "514cc.workbench.environment/v1",
        capturedAt: "2026-08-12T00:00:00.000Z",
        runId: null,
        workspace: { name: "514cc", source: "control-center", isRepository: true },
        git: {
          available: true,
          root: repoRoot,
          name: "514cc",
          branch: "qa",
          detached: false,
          head: "000000000000",
          upstream: null,
          ahead: 0,
          behind: 0,
          changes: { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, additions: 0, deletions: 0 },
          actions: { commit: { enabled: false, reason: "QA fixture" }, push: { enabled: false, reason: "QA fixture" } },
        },
        pullRequest: { available: false, provider: null, status: "unsupported" },
        agents: { running: 0, completed: 0, attention: 0, delegated: 0, delegatedRunning: 0, items: [] },
        processes: { running: 0, items: [] },
        sources: { total: 0, items: [] },
      });
    }
    if (method === "GET" && path === "/api/ssh/hosts") return json(route, { ok: true, hosts: [host, offlineHost] });
    if (method === "GET" && path === "/api/remote-projects") return json(route, { ok: true, projects: remoteProjects });
    if (method === "GET" && path === "/api/providers") return json(route, { ok: true, providers: [provider], writeStatus: { state: "ready" } });
    if (method === "GET" && path === "/api/teams") return json(route, { ok: true, teams: [team] });
    if (method === "GET" && path === "/api/config/sources") return json(route, { sources: [historySource] });
    if (method === "GET" && path === `/api/config/${historySource.id}`) {
      return json(route, { ...historySource, content: '{"mode":"current"}\n' });
    }
    if (method === "GET" && path === `/api/config/${historySource.id}/versions`) {
      return json(route, { versions: [historyVersion] });
    }
    if (method === "GET" && path === `/api/config/${historySource.id}/versions/${historyVersion.versionId}/content`) {
      return json(route, {
        ...historySource,
        versionId: historyVersion.versionId,
        sha256: historyVersion.fromSha256,
        content: '{"mode":"previous"}\n',
      });
    }
    if (method === "POST" && path === `/api/ssh/hosts/${host.id}/probe`) {
      return json(route, { ok: true, probe: {
        os: "Linux 6.8", hostname: "qa-remote", shell: "/bin/bash", home: "/home/qa", disk: "100G total 40G free", memory: "3.2Gi / 8Gi",
        metrics: {
          cpu: { cores: 8, usagePercent: 23.4 },
          memory: { totalBytes: 8589934592, usedBytes: 3435973837, usagePercent: 40 },
          disk: { totalBytes: 107374182400, usedBytes: 64424509440, usagePercent: 60 },
          load: { one: 0.42, five: 0.31, fifteen: 0.24 },
          uptimeSeconds: 183845,
          processes: 218,
          network: { rxBytes: 134217728, txBytes: 67108864 },
        },
        clis: [
          { id: "claude", label: "Claude", command: "claude", installed: true, version: "2.1.0" },
          { id: "codex", label: "Codex", command: "codex", installed: true, version: "0.144.0" },
        ],
      } });
    }
    if (method === "POST" && path === `/api/ssh/hosts/${offlineHost.id}/probe`) {
      evidence.expectedHttpFailures.push({ method, path, status: 503 });
      return json(route, { error: { code: "QA_HOST_OFFLINE", message: "mock offline host" } }, 503);
    }
    if (method === "POST" && path === `/api/ssh/hosts/${host.id}/proxy-diagnose`) {
      return json(route, { ok: true, diagnosis: {
        environment: [{ name: "HTTPS_PROXY", configured: true, value: "http://***@127.0.0.1:7890" }],
        listeners: ["LISTEN 127.0.0.1:7890"],
        curlAvailable: true,
        outbound: [{ url: "https://api.openai.com", status: "401", exitCode: 0, ok: true, timeMs: 18 }],
      } });
    }
    if (method === "GET" && path === `/api/ssh/hosts/${host.id}/env-sync/plan`) {
      evidence.syncRequests.push({ method, path });
      return json(route, { ok: true, files: [syncFile] });
    }
    if (method === "POST" && path === `/api/ssh/hosts/${host.id}/env-sync`) {
      const payload = request.postDataJSON();
      evidence.syncRequests.push({ method, path, payload });
      return json(route, {
        ok: true,
        complete: true,
        status: "committed",
        home: "/home/qa",
        results: [{ ok: true, id: syncFile.id, label: syncFile.label, remote: `/home/qa/${syncFile.remote}`, bytes: syncFile.size }],
      });
    }

    // 恢复账本：前端在账本不可读时对所有远端写 fail-closed（configRemoteWriteBlocked），
    // 因此这条 mock 是发布/保存/恢复能被测到的前提；本地 remember 的证据不带 serverPersisted，
    // 空账本不会把它清掉，后面的 recoveryBanner 检查照旧成立。
    if (method === "GET" && path === "/api/ssh/hosts/recoveries") {
      return json(route, { ok: true, recoveries: [] });
    }

    const hostGraph = [host, offlineHost].some((item) => path === `/api/ssh/hosts/${item.id}/graph`);
    const projectGraph = remoteProjects.some((item) => path === `/api/remote-projects/${item.id}/graph`);
    if (method === "GET" && (hostGraph || projectGraph)) {
      const target = projectGraph ? "project" : "host";
      evidence.graphRequests.push(target);
      if (graphRace && target === "host") {
        graphRaceIndex += 1;
        const current = graphRaceIndex;
        await sleep(current === 1 ? 300 : 20);
        return json(route, { ok: true, ...graphFor(target, current === 1 ? "stale" : "latest") });
      }
      return json(route, { ok: true, ...graphFor(target) });
    }

    const hostSource = path === `/api/ssh/hosts/${host.id}/graph/source`;
    const projectSource = remoteProjects.some((item) => path === `/api/remote-projects/${item.id}/graph/source`);
    if (method === "GET" && (hostSource || projectSource)) {
      sourceReadRevision += 1;
      const file = url.searchParams.get("file");
      return json(route, {
        ok: true,
        id: file,
        label: file === "project-agents" ? "Project AGENTS" : "Codex AGENTS",
        remote: file === "project-agents" ? "/srv/qa-project/AGENTS.md" : "/home/qa/.codex/AGENTS.md",
        exists: true,
        editable: true,
        sensitive: false,
        truncated: false,
        digest: `digest-${sourceReadRevision}`,
        content: `# QA source ${sourceReadRevision}\n`,
      });
    }
    if (method === "POST" && (hostSource || projectSource)) {
      evidence.sourceWrites.push(request.postDataJSON());
      evidence.expectedHttpFailures.push({ method, path, status: 409 });
      return json(route, { ok: false, error: { code: "SOURCE_CONFLICT", message: "mock digest conflict" } }, 409);
    }

    // 备份读取与恢复：恢复请求只带 file/name/digest——原文由服务端从备份直接进 writeSource
    const hostBackup = path === `/api/ssh/hosts/${host.id}/graph/backup`;
    const projectBackup = remoteProjects.some((item) => path === `/api/remote-projects/${item.id}/graph/backup`);
    if (method === "GET" && (hostBackup || projectBackup)) {
      const file = url.searchParams.get("file");
      const name = url.searchParams.get("name");
      evidence.backupReads.push({ path, file, name });
      return json(route, {
        ok: true,
        id: file,
        name,
        remote: `/home/qa/.codex/${name}`,
        content: "# 备份原文\n",
        digest: "backup-digest",
        truncated: false,
        redacted: false,
        sensitive: false,
        restorable: true,
      });
    }
    const hostRestore = path === `/api/ssh/hosts/${host.id}/graph/backup/restore`;
    const projectRestore = remoteProjects.some((item) => path === `/api/remote-projects/${item.id}/graph/backup/restore`);
    if (method === "POST" && (hostRestore || projectRestore)) {
      const payload = request.postDataJSON();
      evidence.backupRestores.push({ path, ...payload });
      return json(route, {
        ok: true,
        id: payload.file,
        remote: "/home/qa/.codex/AGENTS.md",
        bytes: 21,
        digest: "restored-digest",
        backup: "AGENTS.md.514forge-backup-restorepoint",
        restoredFrom: payload.name,
      });
    }

    const providerPlan = path === `/api/ssh/hosts/${host.id}/provider-plan`
      || remoteProjects.some((item) => path === `/api/remote-projects/${item.id}/provider-plan`);
    if (method === "GET" && providerPlan) {
      const app = url.searchParams.get("app");
      const providerId = url.searchParams.get("providerId");
      const planRevision = `${app === "codex" ? "b" : "a"}`.repeat(64);
      evidence.providerPlans.push({ path, app, providerId, planRevision });
      return json(route, { ok: true, app, providerId, planRevision, files: [{ remote: `/home/qa/.${app}/config`, changed: true, containsCredentialMaterial: true }] });
    }
    const providerApply = path === `/api/ssh/hosts/${host.id}/provider-apply`
      || remoteProjects.some((item) => path === `/api/remote-projects/${item.id}/provider-apply`);
    if (method === "POST" && providerApply) {
      const payload = request.postDataJSON();
      evidence.providerApplies.push({ path, ...payload });
      if (forceProviderRecovery) {
        evidence.expectedHttpFailures.push({ method, path, status: 500 });
        return json(route, {
          ok: false,
          error: {
            code: "REMOTE_CONFIG_RECOVERY_REQUIRED",
            message: "mock uncertain remote transaction",
            recoveryRequired: true,
            recovery: {
              transactionId: "qa-recovery-1",
              applied: [{ remote: "/home/qa/.claude/settings.json" }],
              uncertain: [{ remote: "/home/qa/.codex/config.toml" }],
              backups: [],
            },
          },
        }, 500);
      }
      if (payload.app === "codex") {
        evidence.expectedHttpFailures.push({ method, path, status: 500 });
        return json(route, { ok: false, error: { code: "QA_PARTIAL", message: "mock codex failure" } }, 500);
      }
      return json(route, { ok: true, applied: [{ remote: `/home/qa/.${payload.app}/config`, bytes: 96, backup: "mock-backup" }], unchanged: [] });
    }
    return route.fallback();
  });
}

async function confirmDialog(page) {
  await page.locator("#action-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator("#dialog-confirm-button").click();
}

async function assertNoHorizontalOverflow(page, label) {
  const snapshot = await page.evaluate(() => {
    const main = document.querySelector(".main-content");
    const visibleControls = [...document.querySelectorAll("#config-surface-remote button, #config-surface-remote select, #config-surface-remote textarea")]
      .filter((node) => node instanceof HTMLElement && node.offsetParent !== null)
      .filter((node) => !node.closest(".config-remote-resource-tabs, .config-remote-workbench > .ccs-tabs, .table-scroll"))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { name: node.getAttribute("aria-label") || node.textContent?.trim() || node.tagName, left: rect.left, right: rect.right };
      })
      .filter((item) => item.left < -2 || item.right > innerWidth + 2);
    return {
      viewport: innerWidth,
      body: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      main: main ? main.scrollWidth - main.clientWidth : null,
      visibleControls,
    };
  });
  if (snapshot.body > 2 || snapshot.main == null || snapshot.main > 2 || snapshot.visibleControls.length) {
    throw new Error(`${label} horizontal overflow: ${JSON.stringify(snapshot)}`);
  }
  return snapshot;
}

function expectedMockFailure({ method, path, status, code }) {
  if (status === 501 && code === "REMOTE_GATE_BLOCKED") return true;
  if (method === "POST" && /\/graph\/source$/.test(path)) return status === 409 && code === "SOURCE_CONFLICT";
  if (method === "POST" && /\/provider-apply$/.test(path)) {
    return status === 500 && ["QA_PARTIAL", "REMOTE_CONFIG_RECOVERY_REQUIRED"].includes(code);
  }
  if (method === "POST" && path === `/api/ssh/hosts/${offlineHost.id}/probe`) {
    return status === 503 && code === "QA_HOST_OFFLINE";
  }
  return false;
}

function responseFailureKey({ method, path, status }) {
  return `${method} ${path} ${status}`;
}

const report = { ok: false, runId: qaRunId, outputRoot, screenshots: [], evidence, checks: {} };
try {
  const bootstrapUrl = await waitForBootstrapUrl();
  origin = new URL(bootstrapUrl).origin;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await installMockRoutes(context);
  const page = await context.newPage();
  const errors = [];
  const responseDiagnostics = [];
  const expectedResponseFailures = new Set();
  const expectedResourcePaths = new Set();
  const failedResourceMessages = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/^Failed to load resource:/.test(message.text())) {
      failedResourceMessages.push({ text: message.text(), url: message.location()?.url ?? "" });
      return;
    }
    errors.push(`console: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    responseDiagnostics.push((async () => {
      const request = response.request();
      const path = new URL(response.url()).pathname;
      let payload = null;
      try { payload = await response.json(); } catch { /* non-JSON remains unexpected */ }
      const failure = {
        method: request.method(),
        path,
        status: response.status(),
        code: payload?.error?.code ?? payload?.code ?? null,
      };
      if (expectedMockFailure(failure)) {
        expectedResponseFailures.add(responseFailureKey(failure));
        expectedResourcePaths.add(path);
        return;
      }
      errors.push(`unexpected http failure: ${JSON.stringify(failure)}`);
    })());
  });
  await page.addInitScript((token) => {
    sessionStorage.setItem("514cc-control-token", token);
    localStorage.setItem("514cc-control-theme", "light");
  }, sharedToken);
  await page.goto(`${origin}/#config/providers`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 30_000 });
  await page.waitForSelector(`[data-config-host="${host.id}"]`, { timeout: 30_000 });

  const targetInventory = await page.locator("#config-host-bar").evaluate((bar) => ({
    hosts: [...bar.querySelectorAll("[data-config-host]")].map((node) => node.getAttribute("data-config-host")),
    projects: [...bar.querySelectorAll("[data-config-project]")].map((node) => ({
      id: node.getAttribute("data-config-project"),
      label: node.querySelector(".config-host-chip-label")?.textContent ?? "",
      title: node.getAttribute("title") ?? "",
    })),
  }));
  if (targetInventory.hosts.length !== 3 || targetInventory.projects.length !== remoteProjects.length) {
    throw new Error(`remote target inventory incomplete: ${JSON.stringify(targetInventory)}`);
  }
  const longProjectChip = targetInventory.projects.find((item) => item.id === project.id);
  if (longProjectChip?.label !== project.name || !longProjectChip.title.includes(project.path)) {
    throw new Error(`long project target lost its accessible label/path: ${JSON.stringify(longProjectChip)}`);
  }
  report.checks.multiTargetInventory = targetInventory;

  await page.locator(`[data-config-project="${offlineProject.id}"]`).click();
  await page.waitForFunction((projectId) => {
    const chip = document.querySelector(`[data-config-project="${projectId}"]`);
    return chip?.querySelector(".config-host-chip-status")?.textContent === "离线";
  }, offlineProject.id);
  const offlineChip = await page.locator(`[data-config-project="${offlineProject.id}"]`).evaluate((node) => ({
    status: node.querySelector(".config-host-chip-status")?.textContent ?? "",
    errorDot: node.querySelector(".remote-dot")?.classList.contains("is-error") ?? false,
  }));
  if (offlineChip.status !== "离线" || !offlineChip.errorDot) throw new Error(`offline target chip was not explicit: ${JSON.stringify(offlineChip)}`);

  await page.locator(`[data-config-host="${host.id}"]`).click();
  await page.waitForFunction(() => {
    const tab = document.querySelector('[data-config-surface="providers"]');
    return Boolean(tab && !tab.hidden);
  });
  await page.locator('[data-config-surface="providers"]').click();
  const providersTabLabel = await page.locator('[data-config-surface="providers"] strong').textContent();
  if (providersTabLabel?.trim() !== "连接") throw new Error(`remote providers tab label drifted: ${providersTabLabel}`);
  await page.waitForSelector(".config-remote-provider-deck", { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector("#config-surface-remote")?.textContent?.includes("claude-initial"));
  await page.waitForFunction((projectId) => document.querySelector(`[data-config-project="${projectId}"] .config-host-chip-status`)?.textContent === "在线", project.id);
  const onlineChip = await page.locator(`[data-config-project="${project.id}"]`).evaluate((node) => ({
    status: node.querySelector(".config-host-chip-status")?.textContent ?? "",
    okDot: node.querySelector(".remote-dot")?.classList.contains("is-ok") ?? false,
  }));
  if (onlineChip.status !== "在线" || !onlineChip.okDot) throw new Error(`online target chip was not explicit: ${JSON.stringify(onlineChip)}`);
  report.checks.targetStatusChips = { online: project.id, offline: offlineProject.id };

  const applyResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/provider-apply"));
  await page.locator(`[data-config-remote-provider-apply="claude::${provider.id}"]`).click();
  await confirmDialog(page);
  if (!(await applyResponse).ok()) throw new Error("single provider apply mock did not succeed");
  await page.waitForFunction(() => document.querySelector(".config-remote-result")?.textContent?.includes("已应用"));
  report.checks.singleProviderApply = true;

  await page.locator("[data-config-remote-team-apply]").click();
  await confirmDialog(page);
  await page.waitForFunction(() => {
    const text = document.querySelector(".config-remote-result")?.textContent ?? "";
    return text.includes("QA Team") && text.includes("mock codex failure");
  });
  const teamResult = await page.locator(".config-remote-result").innerText();
  if (!teamResult.includes("✓ Claude") || !teamResult.includes("✗ Codex")) throw new Error(`team partial failure missing: ${teamResult}`);
  report.checks.teamPartialFailure = true;

  for (const tab of ["env", "proxy", "resources", "sync", "accounts"]) {
    await page.locator(`[data-config-remote-workbench-tab="${tab}"]`).click();
    const selected = await page.locator(`[data-config-remote-workbench-tab="${tab}"]`).getAttribute("aria-selected");
    if (selected !== "true") throw new Error(`remote workbench tab did not select: ${tab}`);
  }
  await page.locator('[data-config-remote-workbench-tab="proxy"]').click();
  await page.locator("[data-config-remote-proxy-diagnose]").click();
  await page.waitForFunction(() => document.querySelector("#config-surface-remote")?.textContent?.includes("api.openai.com"));
  if ((await page.locator("#config-surface-remote").innerText()).includes("user:password")) throw new Error("proxy credential leaked into UI");
  report.checks.proxyDiagnosis = true;

  await page.locator('[data-config-remote-workbench-tab="resources"]').click();
  for (const tab of ["prompts", "mcps", "skills", "profiles", "workspace", "backups"]) {
    await page.locator(`[data-config-remote-resource-tab="${tab}"]`).click();
    if (!(await page.locator(`[data-config-remote-resource-tab="${tab}"]`).evaluate((node) => node.classList.contains("is-active")))) {
      throw new Error(`remote resource tab did not select: ${tab}`);
    }
  }
  report.checks.workbenchTabs = "5/5";
  report.checks.resourceTabs = "6/6";

  await page.locator('[data-config-surface="capabilities"]').click();
  await page.waitForSelector(".config-remote-agent-chip");
  await page.waitForSelector(".config-remote-skill-matrix tbody tr");
  await page.waitForSelector(".config-remote-mcp-table tbody tr");
  const capabilityText = await page.locator("#config-surface-remote").innerText();
  for (const label of ["Agent 花名册", "Skill 检测矩阵", "MCP 服务器"]) {
    if (!capabilityText.includes(label)) throw new Error(`capability surface missing ${label}`);
  }
  report.checks.capabilityParity = true;

  await page.locator('[data-config-surface="sources"]').click();
  await page.waitForSelector('.config-remote-seat-layout');
  await page.locator('[data-config-remote-cli="codex"]').click();
  await page.waitForFunction(() => document.querySelector(".config-remote-seat-editor")?.textContent?.includes("Codex 远端席位"));
  await page.locator('[data-config-remote-runtime-mode="sources"]').click();
  await page.locator('[data-config-graph-file="codex-agents"]').click();
  await page.waitForSelector('[data-config-remote-source-editor="codex-agents"]');
  const editor = page.locator('[data-config-remote-source-editor="codex-agents"]');
  await editor.fill("# dirty draft\n");
  await page.locator('[data-config-remote-source-reload="codex-agents"]').click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  if (await editor.inputValue() !== "# dirty draft\n") throw new Error("reload cancellation discarded the draft");
  await page.locator('[data-config-remote-source-save="codex-agents"]').click();
  await confirmDialog(page);
  await page.waitForFunction(() => document.querySelector(".config-remote-result")?.textContent?.includes("mock digest conflict"));
  if (await editor.inputValue() !== "# dirty draft\n") throw new Error("409 conflict discarded the draft");
  if (!(await page.locator('[data-config-remote-source-save="codex-agents"]').isEnabled())) throw new Error("409 conflict disabled retry");
  report.checks.sourceConflictPreservesDraft = true;

  // 保存前差异：基线＝打开时读到的远端原文，两侧逐行可见
  await page.locator('[data-config-remote-source-diff="codex-agents"]').click();
  await page.waitForSelector(".config-remote-source-diff-shell .config-remote-diff");
  const draftDiff = await page.locator(".config-remote-source-diff-shell .config-remote-diff").innerText();
  if (!draftDiff.includes("- # QA source") || !draftDiff.includes("+ # dirty draft")) {
    throw new Error(`save-time diff did not show both sides: ${draftDiff}`);
  }
  report.checks.sourceDiffPreview = true;

  // 备份时间线：只挂本真源的备份（sourceId 过滤），对比按「恢复方向」呈现
  const backupRows = page.locator("#config-surface-remote .config-remote-backup-row");
  await backupRows.first().waitFor({ state: "visible" });
  if (await backupRows.count() !== 1) throw new Error(`backup timeline was not scoped by sourceId: ${await backupRows.count()}`);
  await page.locator('[data-config-remote-backup-compare="AGENTS.md.514forge-backup-2f8c1d90"]').click();
  await page.waitForSelector(".config-remote-backup-body .config-remote-diff");
  const restoreDiff = await page.locator(".config-remote-backup-body .config-remote-diff").innerText();
  if (!restoreDiff.includes("+ # 备份原文")) throw new Error(`backup compare lost the restore direction: ${restoreDiff}`);
  report.checks.backupCompare = evidence.backupReads.at(-1);

  // 可编辑真源的恢复入口可用（真正的恢复放到项目目标上做——它会丢弃草稿，
  // 而后面的目标级草稿徽标检查依赖此处草稿仍脏）
  const hostRestoreButton = page.locator('[data-config-remote-backup-restore="AGENTS.md.514forge-backup-2f8c1d90"]');
  if (!(await hostRestoreButton.isEnabled())) throw new Error("editable source restore entry was disabled");
  report.checks.backupRestoreEnabled = true;

  await page.locator('[data-config-remote-runtime-mode="seats"]').click();
  await page.waitForSelector('[data-config-remote-cli="codex"].is-active');
  report.checks.runtimeSeatParity = true;

  await page.locator(`[data-config-project="${project.id}"]`).click();
  await page.waitForFunction(() => document.querySelector("#config-surface-remote")?.textContent?.includes("QA Remote Project"));
  const hostDraftBadge = page.locator(`[data-config-host="${host.id}"] .config-host-chip-draft`);
  await hostDraftBadge.waitFor({ state: "visible" });
  if (await hostDraftBadge.getAttribute("aria-label") !== "1 个未保存草稿") {
    throw new Error(`host draft badge was not target-scoped: ${await hostDraftBadge.getAttribute("aria-label")}`);
  }
  report.checks.targetDraftCount = await hostDraftBadge.innerText();
  await page.waitForSelector('[data-config-remote-runtime-mode="seats"].is-active');
  await page.locator('[data-config-remote-runtime-mode="sources"]').click();
  await page.waitForSelector('[data-config-graph-file="project-agents"]');
  await page.locator('[data-config-surface="providers"]').click();
  await page.locator('[data-config-remote-provider-app="claude"]').waitFor({ state: "visible" });
  await page.locator(`[data-config-host="${host.id}"]`).click();
  await page.locator('[data-config-remote-provider-app="codex"]').click();
  await page.locator('[data-config-remote-workbench-tab="resources"]').click();
  await page.locator('[data-config-remote-resource-tab="skills"]').click();
  await page.locator(`[data-config-project="${project.id}"]`).click();
  await page.waitForSelector('[data-config-remote-provider-app="claude"].is-active');
  await page.locator(`[data-config-host="${host.id}"]`).click();
  await page.waitForSelector('[data-config-remote-provider-app="codex"].is-active');
  await page.waitForSelector('[data-config-remote-workbench-tab="resources"].is-active');
  await page.waitForSelector('[data-config-remote-resource-tab="skills"].is-active');
  report.checks.targetStateIsolation = true;

  await page.locator(`[data-config-project="${project.id}"]`).click();
  await page.waitForFunction((projectName) => document.querySelector("#config-surface-remote")?.textContent?.includes(projectName), project.name);
  await page.locator('[data-config-remote-provider-app="claude"]').click();
  const syncPlanStart = evidence.syncRequests.length;
  await page.locator(`[data-config-host-sync="${host.id}"]`).first().click();
  const syncDialog = page.locator("dialog.sshconn-dialog");
  await syncDialog.waitFor({ state: "visible" });
  await syncDialog.getByRole("heading").waitFor();
  const syncDialogText = await syncDialog.innerText();
  if (!/同步到主机 home/i.test(syncDialogText) || !syncDialogText.includes(project.name) || !syncDialogText.includes(project.path)
      || !/当前项目目录[\s\S]*不会被写入/.test(syncDialogText)) {
    throw new Error(`project sync dialog did not disclose host-Home boundary: ${syncDialogText}`);
  }
  await syncDialog.locator('[data-act="push"]').click();
  await page.waitForFunction(() => document.querySelector(".config-remote-result")?.textContent?.includes("同步完成（远端 HOME=/home/qa）"));
  const syncCalls = evidence.syncRequests.slice(syncPlanStart);
  if (syncCalls.some((item) => item.path.startsWith("/api/remote-projects/"))
      || !syncCalls.some((item) => item.method === "POST" && item.path === `/api/ssh/hosts/${host.id}/env-sync`)) {
    throw new Error(`project sync escaped the host Home endpoint: ${JSON.stringify(syncCalls)}`);
  }
  report.checks.projectSyncTargetsHostHome = syncCalls;

  // 项目目标上做真正的恢复：请求打到 remote-projects 端点（host/path 由服务端台账解析），
  // 请求体只有 file/name/digest——备份原文不经浏览器往返；成功后草稿被明确丢弃。
  await page.locator('[data-config-surface="sources"]').click();
  await page.locator('[data-config-remote-runtime-mode="sources"]').click();
  await page.locator('[data-config-graph-file="project-agents"]').click();
  await page.waitForSelector('[data-config-remote-source-editor="project-agents"]');
  const projectEditor = page.locator('[data-config-remote-source-editor="project-agents"]');
  await projectEditor.fill("# project draft\n");
  await page.locator('[data-config-remote-backup-restore="AGENTS.md.514forge-backup-2f8c1d90"]').click();
  const restoreWarning = await page.locator("#action-dialog").innerText();
  if (!restoreWarning.includes("未保存草稿")) throw new Error(`restore dialog hid the draft loss: ${restoreWarning}`);
  await confirmDialog(page);
  await page.waitForFunction(() => document.querySelector(".config-remote-result")?.textContent?.includes("已从备份恢复"));
  const restoreCall = evidence.backupRestores.at(-1);
  if (!restoreCall) throw new Error("restore request never reached the server");
  if ("content" in restoreCall) throw new Error("restore request must not carry file content");
  if (!restoreCall.path.startsWith("/api/remote-projects/")) throw new Error(`project restore left the project endpoint: ${restoreCall.path}`);
  if (restoreCall.name !== "AGENTS.md.514forge-backup-2f8c1d90") throw new Error(`restore sent the wrong backup: ${restoreCall.name}`);
  if (!restoreCall.digest) throw new Error("restore must send the current source digest for CAS");
  await page.waitForFunction(() => !(document.querySelector("#config-surface-remote")?.textContent ?? "").includes("未保存"));
  report.checks.backupRestore = { path: restoreCall.path, name: restoreCall.name, carriedContent: "content" in restoreCall };
  // 回到供应商面，把上下文还给后续的恢复横幅检查
  await page.locator('[data-config-surface="providers"]').click();
  await page.locator(`[data-config-remote-provider-apply="claude::${provider.id}"]`).waitFor({ state: "visible" });

  forceProviderRecovery = true;
  const recoveryResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/remote-projects/${project.id}/provider-apply`);
  await page.locator(`[data-config-remote-provider-apply="claude::${provider.id}"]`).click();
  await confirmDialog(page);
  if ((await recoveryResponse).status() !== 500) throw new Error("recovery mock did not return the expected 500");
  forceProviderRecovery = false;
  await page.waitForSelector(".config-recovery-banner");
  const recoveryText = await page.locator(".config-recovery-banner").innerText();
  if (!recoveryText.includes("远端提交状态不确定") || !recoveryText.includes("qa-recovery-1")) {
    throw new Error(`recovery banner incomplete: ${recoveryText}`);
  }
  const recoveryFacts = await page.locator(".config-recovery-banner").evaluate((banner) => Object.fromEntries(
    [...banner.querySelectorAll("dl > div")].map((row) => [
      row.querySelector("dt")?.textContent?.trim() ?? "",
      row.querySelector("dd")?.textContent?.trim() ?? "",
    ]),
  ));
  if (recoveryFacts["事务"] !== "qa-recovery-1" || recoveryFacts["已提交"] !== "1" || recoveryFacts["待核对"] !== "1") {
    throw new Error(`recovery counts incomplete: ${JSON.stringify(recoveryFacts)}`);
  }
  const blockedProviderAction = page.locator(`[data-config-remote-provider-apply="claude::${provider.id}"]`);
  if (await blockedProviderAction.isEnabled()) throw new Error("provider apply remained enabled during recovery block");
  const blockedSyncAction = page.locator(`[data-config-host-sync="${host.id}"]`).first();
  if (await blockedSyncAction.isEnabled()) {
    throw new Error("host Home sync remained enabled during recovery block");
  }
  const appliesBeforeBlockedClick = evidence.providerApplies.length;
  const syncsBeforeBlockedClick = evidence.syncRequests.length;
  await blockedProviderAction.click({ force: true });
  await blockedSyncAction.click({ force: true });
  await sleep(100);
  if (evidence.providerApplies.length !== appliesBeforeBlockedClick) throw new Error("recovery-blocked provider action still reached the API");
  if (evidence.syncRequests.length !== syncsBeforeBlockedClick) throw new Error("recovery-blocked host Home sync still reached the API");
  report.checks.recoveryBanner = recoveryFacts;
  report.checks.recoveryWriteBlocked = true;

  const projectDesktopShot = resolve(outputRoot, "remote-project-desktop.png");
  await page.screenshot({ path: projectDesktopShot, fullPage: true, animations: "disabled" });
  report.screenshots.push(projectDesktopShot);
  report.checks.desktopProjectOverflow = await assertNoHorizontalOverflow(page, "desktop remote project");

  await page.locator(`[data-config-host="${host.id}"]`).click();
  await page.waitForFunction(() => document.querySelector("#config-surface-remote")?.textContent?.includes("QA Remote Host"));
  await page.locator('[data-config-remote-provider-app="claude"]').click();
  graphRace = true;
  graphRaceIndex = 0;
  const refresh = page.locator("[data-config-target-refresh]").first();
  await refresh.click();
  await refresh.click();
  await waitFor(() => graphRaceIndex >= 2, "overlapping graph requests");
  await page.waitForFunction(() => document.querySelector("#config-surface-remote")?.textContent?.includes("claude-latest"));
  await sleep(350);
  const raceText = await page.locator("#config-surface-remote").innerText();
  if (raceText.includes("claude-stale") || !raceText.includes("claude-latest")) throw new Error(`stale graph won: ${raceText}`);
  report.checks.graphLatestWins = true;

  await page.locator('[data-config-surface="providers"]').click();
  await page.waitForSelector(".remote-health-dashboard");
  const healthText = await page.locator(".remote-health-dashboard").innerText();
  for (const label of ["服务器状态", "CPU", "内存", "根磁盘", "系统负载", "在线时长", "网络吞吐"]) {
    if (!healthText.includes(label)) throw new Error(`host health dashboard missing ${label}`);
  }
  await page.locator("#toast-region").evaluate((node) => node.replaceChildren());
  const desktopShot = resolve(outputRoot, "remote-host-desktop.png");
  await page.screenshot({ path: desktopShot, fullPage: true, animations: "disabled" });
  report.screenshots.push(desktopShot);
  report.checks.desktopOverflow = await assertNoHorizontalOverflow(page, "desktop");

  await page.locator('[data-config-surface="capabilities"]').click();
  await page.waitForSelector(".config-remote-skill-matrix");
  const capabilityDesktopShot = resolve(outputRoot, "remote-capabilities-desktop.png");
  await page.screenshot({ path: capabilityDesktopShot, fullPage: true, animations: "disabled" });
  report.screenshots.push(capabilityDesktopShot);
  report.checks.desktopCapabilitiesOverflow = await assertNoHorizontalOverflow(page, "desktop capabilities");

  await page.locator('[data-config-surface="sources"]').click();
  await page.locator('[data-config-remote-runtime-mode="seats"]').click();
  await page.waitForSelector(".config-remote-seat-layout");
  const seatsDesktopShot = resolve(outputRoot, "remote-runtime-seats-desktop.png");
  await page.screenshot({ path: seatsDesktopShot, fullPage: true, animations: "disabled" });
  report.screenshots.push(seatsDesktopShot);
  report.checks.desktopSeatsOverflow = await assertNoHorizontalOverflow(page, "desktop seats");

  await page.locator('[data-config-surface="providers"]').click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const mobileShot = resolve(outputRoot, "remote-host-390.png");
  await page.screenshot({ path: mobileShot, fullPage: true, animations: "disabled" });
  report.screenshots.push(mobileShot);
  report.checks.mobileOverflow = await assertNoHorizontalOverflow(page, "390px");

  await page.locator(`[data-config-project="${project.id}"]`).click();
  await page.waitForFunction((projectName) => document.querySelector("#config-surface-remote")?.textContent?.includes(projectName), project.name);
  const projectMobileShot = resolve(outputRoot, "remote-project-390.png");
  await page.screenshot({ path: projectMobileShot, fullPage: true, animations: "disabled" });
  report.screenshots.push(projectMobileShot);
  report.checks.mobileProjectOverflow = await assertNoHorizontalOverflow(page, "390px remote project");

  await page.locator(`[data-config-host="${host.id}"]`).click();
  await page.waitForFunction(() => document.querySelector("#config-surface-remote")?.textContent?.includes("QA Remote Host"));

  await page.locator('[data-config-surface="capabilities"]').click();
  await page.locator(".config-remote-agent-chip").first().scrollIntoViewIfNeeded();
  const capabilityShot = resolve(outputRoot, "remote-capabilities-390.png");
  await page.screenshot({ path: capabilityShot, fullPage: true, animations: "disabled" });
  report.screenshots.push(capabilityShot);
  report.checks.mobileCapabilitiesOverflow = await assertNoHorizontalOverflow(page, "390px capabilities");

  await page.locator('[data-config-surface="sources"]').click();
  await page.locator('[data-config-remote-runtime-mode="sources"]').click();
  await page.locator('[data-config-graph-file="codex-agents"]').click();
  await page.waitForSelector('[data-config-remote-source-editor="codex-agents"]');
  await page.locator('[data-config-remote-source-editor="codex-agents"]').scrollIntoViewIfNeeded();
  const sourceShot = resolve(outputRoot, "remote-source-editor-390.png");
  await page.screenshot({ path: sourceShot, fullPage: true, animations: "disabled" });
  report.screenshots.push(sourceShot);
  report.checks.mobileSourceOverflow = await assertNoHorizontalOverflow(page, "390px source editor");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(150);
  await page.locator('[data-config-host=""]').click();
  await page.locator('[data-runtime-workspace-mode="sources"]').click();
  await page.waitForSelector('#runtime-raw-source-workspace:not([hidden])');
  await page.waitForSelector(`[data-version-preview="${historyVersion.versionId}"]`);
  await page.locator(`[data-version-preview="${historyVersion.versionId}"]`).click();
  await page.waitForFunction(() => !document.querySelector("#version-preview")?.hidden
    && document.querySelector("#version-preview-meta")?.textContent?.includes("历史版本 → 当前编辑器"));
  const historyPreview = await page.locator("#version-preview").evaluate((panel) => ({
    hidden: panel.hidden,
    status: panel.querySelector("#version-preview-status")?.textContent ?? "",
    meta: panel.querySelector("#version-preview-meta")?.textContent ?? "",
    diff: panel.querySelector("#version-preview-diff")?.textContent ?? "",
    rollbackDisabled: panel.querySelector("#version-preview-rollback")?.disabled,
  }));
  if (historyPreview.hidden || !historyPreview.meta.includes("历史版本 → 当前编辑器")
      || !historyPreview.diff.includes("previous") || !historyPreview.diff.includes("current")
      || historyPreview.rollbackDisabled) {
    throw new Error(`history version preview incomplete: ${JSON.stringify(historyPreview)}`);
  }
  report.checks.historyVersionPreview = historyPreview;

  await Promise.allSettled(responseDiagnostics);
  const expectedFailureKeys = new Set(evidence.expectedHttpFailures.map(responseFailureKey));
  for (const key of expectedFailureKeys) {
    if (!expectedResponseFailures.has(key)) errors.push(`expected mock HTTP failure was not observed: ${key}`);
  }
  for (const message of failedResourceMessages) {
    let path = "";
    try { path = new URL(message.url).pathname; } catch { /* blank/invalid location is not attributable */ }
    if (!path || !expectedResourcePaths.has(path)) {
      errors.push(`unmatched failed resource message: ${JSON.stringify(message)}`);
    }
  }
  report.checks.expectedHttpFailures = [...expectedResponseFailures];
  report.checks.failedResourceMessages = failedResourceMessages;
  if (errors.length) throw new Error(`browser diagnostics: ${JSON.stringify(errors)}`);
  if (evidence.sourceWrites.length !== 1 || evidence.sourceWrites[0].digest !== "digest-1") throw new Error(`source digest was not submitted: ${JSON.stringify(evidence.sourceWrites)}`);
  if (!evidence.providerApplies.some((item) => item.app === "claude") || !evidence.providerApplies.some((item) => item.app === "codex")) {
    throw new Error(`provider apply coverage incomplete: ${JSON.stringify(evidence.providerApplies)}`);
  }
  if (evidence.providerApplies.some((item) => !/^[a-f0-9]{64}$/.test(item.planRevision ?? ""))) {
    throw new Error(`provider apply was not bound to a plan revision: ${JSON.stringify(evidence.providerApplies)}`);
  }
  report.checks.providerPlanRevisionBound = true;
  report.ok = true;
  await context.close();
} finally {
  if (browser) await browser.close();
  await stopQaServer();
  await writeFile(resolve(outputRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
