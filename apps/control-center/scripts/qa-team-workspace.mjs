#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnTestServer, stopTestServer, waitForUrl } from "../tests/server-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "..", "..");
const QA_ROOT_PREFIX = "514cc-team-qa-";
const RESOURCE_STATUS_ERROR = /^Failed to load resource: the server responded with a status of \d{3}\b/;

export const ALLOWED_GATE_BLOCKS = new Set([
  "GET /api/channels",
  "GET /api/channels/events",
  "GET /api/office/templates",
  "GET /api/office/history",
  "GET /api/market/skills",
  "GET /api/market/installed",
  "GET /api/market/repos",
  "GET /api/market/catalog",
  "GET /api/ssh/hosts",
  "GET /api/ssh/hosts/recoveries",
  "GET /api/pty",
  // 全局壁纸 HEAD 探测的 404 是合法空态（客户端启动对账 hasCustom 用）
  "HEAD /api/wallpapers/global",
]);

function rejectUrl(value) {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(String(value ?? ""))) {
    throw new Error("qa:team does not accept a Control Center URL; it always starts an isolated server");
  }
}

export function parseQaArgs(argv = process.argv.slice(2)) {
  let outputDir = resolve(appRoot, ".qa-output", "team-workspace");
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--isolated") {
      throw new Error("--isolated is obsolete; qa:team is mechanically isolated by default");
    }
    if (argument === "--output-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output-dir requires a path");
      rejectUrl(value);
      outputDir = resolve(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--output-dir=")) {
      const value = argument.slice("--output-dir=".length);
      if (!value) throw new Error("--output-dir requires a path");
      rejectUrl(value);
      outputDir = resolve(value);
      continue;
    }
    rejectUrl(argument);
    throw new Error(`unknown qa:team argument: ${argument}`);
  }
  return { outputDir };
}

function nodeOptionsWithSqlite(value = "") {
  const current = String(value).trim();
  if (/(?:^|\s)--experimental-sqlite(?:\s|$)/.test(current)) return current;
  return `${current} --experimental-sqlite`.trim();
}

export function buildIsolatedServerEnv({ qaRoot, token, testRepoRoot = join(qaRoot || "", "repo"), baseEnv = process.env } = {}) {
  if (!qaRoot || !token) throw new Error("qaRoot and token are required for isolated server env");
  const runtimeHome = join(qaRoot, "home");
  return {
    ...baseEnv,
    NODE_OPTIONS: nodeOptionsWithSqlite(baseEnv.NODE_OPTIONS),
    CONTROL_CENTER_REPO_ROOT: testRepoRoot,
    CONTROL_CENTER_TEST_REPO_ROOT: testRepoRoot,
    CONTROL_CENTER_DATA_DIR: join(qaRoot, "data"),
    CONTROL_CENTER_RUNTIME_HOME: runtimeHome,
    CONTROL_CENTER_PORT: "0",
    CONTROL_CENTER_OPEN: "0",
    CONTROL_CENTER_TEST_MODE: "1",
    CONTROL_CENTER_TOKEN: token,
    HOME: runtimeHome,
    USERPROFILE: runtimeHome,
    APPDATA: join(qaRoot, "appdata"),
    LOCALAPPDATA: join(qaRoot, "localappdata"),
    XDG_CONFIG_HOME: join(qaRoot, "xdg", "config"),
    XDG_DATA_HOME: join(qaRoot, "xdg", "data"),
    XDG_CACHE_HOME: join(qaRoot, "xdg", "cache"),
  };
}

// Windows 隔离 env 会把 APPDATA 重定向进 qaRoot——python 用户站点（jsonschema 等）随之不可见，
// 配置写路径的 schema 校验（validator.mjs python-jsonschema）会整体瘫痪，候选配置永远 invalid。
// 把本机用户站点中校验必需的导入包拷进隔离 APPDATA 的对应相对路径，让校验保持真实可用而非绕开。
const ISOLATED_PY_SITE_PACKAGES = ["jsonschema", "jsonschema_specifications", "referencing", "rpds", "attrs", "attr"];

async function seedIsolatedPythonUserSite(qaRoot) {
  if (process.platform !== "win32" || !process.env.APPDATA) return;
  let realSite = "";
  try {
    realSite = execFileSync("python", ["-X", "utf8", "-c", "import site;print(site.getusersitepackages())"], { encoding: "utf8" }).trim();
  } catch {
    return; // 本机无 python——校验在本机本就不可用，隔离 env 照实继承这一缺口
  }
  const appdata = resolve(process.env.APPDATA);
  if (!realSite || !resolve(realSite).toLowerCase().startsWith(appdata.toLowerCase())) return;
  const relativeSite = resolve(realSite).slice(appdata.length).replace(/^[\\/]+/, "");
  const isolatedSite = join(qaRoot, "appdata", relativeSite);
  await Promise.all(ISOLATED_PY_SITE_PACKAGES.map((name) =>
    cp(join(realSite, name), join(isolatedSite, name), { recursive: true }).catch(() => null),
  ));
}

export async function createIsolatedQaRepo(qaRoot) {
  const isolatedRepoRoot = join(qaRoot, "repo");
  await mkdir(isolatedRepoRoot, { recursive: true });
  await Promise.all([
    cp(join(repoRoot, "config", "control-center"), join(isolatedRepoRoot, "config", "control-center"), { recursive: true }),
    cp(join(repoRoot, "schemas", "control-center"), join(isolatedRepoRoot, "schemas", "control-center"), { recursive: true }),
    cp(join(repoRoot, "skills"), join(isolatedRepoRoot, "skills"), { recursive: true }),
    cp(join(repoRoot, ".agents", "skills"), join(isolatedRepoRoot, ".agents", "skills"), { recursive: true }),
    copyFile(join(repoRoot, "module.yaml"), join(isolatedRepoRoot, "module.yaml")),
    copyFile(join(repoRoot, "rules.md"), join(isolatedRepoRoot, "rules.md")),
    mkdir(join(isolatedRepoRoot, ".ai-shared", "handoff"), { recursive: true }),
  ]);
  await seedIsolatedPythonUserSite(qaRoot);
  await writeFile(join(isolatedRepoRoot, "config", "control-center", "sources.json"), `${JSON.stringify({
    version: 1,
    explicit: [
      { id: "control.models", path: "config/control-center/models.json", label: "Models", kind: "json", scope: "repo", critical: true },
      { id: "control.routing", path: "config/control-center/routing.json", label: "Routing", kind: "json", scope: "repo", critical: true },
      { id: "control.permissions", path: "config/control-center/permissions.json", label: "Permissions", kind: "json", scope: "repo", critical: true },
      { id: "control.claude-coordinator", path: "config/control-center/claude-coordinator.md", label: "Coordinator", kind: "markdown", scope: "repo", critical: true },
      { id: "control.sources", path: "config/control-center/sources.json", label: "Sources", kind: "json", scope: "repo", critical: true },
      { id: "control.contracts", path: "schemas/control-center/contracts.schema.json", label: "Contracts", kind: "json", scope: "repo", critical: true },
      { id: "core.rules", path: "rules.md", label: "Rules", kind: "markdown", scope: "repo", critical: true },
      { id: "core.module", path: "module.yaml", label: "Module", kind: "yaml", scope: "repo", critical: true },
    ],
    discover: [
      { root: "skills", names: ["SKILL.md", "customize.toml"], critical: false },
      { root: ".agents/skills", names: ["SKILL.md", "customize.toml"], critical: false },
    ],
    runtime: [],
  }, null, 2)}\n`, "utf8");
  return isolatedRepoRoot;
}

export function assertDisposableQaRoot(qaRoot, tempRoot = tmpdir()) {
  const resolvedRoot = resolve(qaRoot);
  const resolvedTemp = resolve(tempRoot);
  const rel = relative(resolvedTemp, resolvedRoot);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || !basename(resolvedRoot).startsWith(QA_ROOT_PREFIX)) {
    throw new Error(`refusing to remove non-QA temp root: ${resolvedRoot}`);
  }
  return resolvedRoot;
}

export async function withDisposableQaRoot(operation) {
  if (typeof operation !== "function") throw new TypeError("QA root operation must be a function");
  const qaRoot = await mkdtemp(join(tmpdir(), QA_ROOT_PREFIX));
  let value;
  let operationFailed = false;
  let operationError = null;
  let cleanupError = null;

  try {
    value = await operation(qaRoot);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    await rm(assertDisposableQaRoot(qaRoot), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    cleanupError = error;
  }

  if (operationFailed && cleanupError) {
    throw new AggregateError([operationError, cleanupError], "team workspace QA operation and cleanup failed");
  }
  if (operationFailed) throw operationError;
  if (cleanupError) throw cleanupError;
  return value;
}

function errorCode(payload) {
  return payload?.error?.code ?? payload?.code ?? null;
}

export function httpFailureDiagnostic({ method = "GET", pathname = "/", status = 0, payload = null } = {}) {
  if (status < 400) return null;
  const key = `${String(method).toUpperCase()} ${pathname}`;
  const code = errorCode(payload);
  if (status === 501 && ALLOWED_GATE_BLOCKS.has(key) && code === "REMOTE_GATE_BLOCKED") return null;
  // 全局壁纸 HEAD 探测的 404 是合法空态：客户端启动对账 hasCustom 用，404 = 未配置自定义壁纸。
  if (status === 404 && key === "HEAD /api/wallpapers/global") return null;
  return `${key} -> HTTP ${status}${code ? ` (${code})` : ""}`;
}

function createDeferred() {
  let resolvePromise;
  const promise = new Promise((resolveDeferred) => { resolvePromise = resolveDeferred; });
  return { promise, resolve: resolvePromise };
}

async function within(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function selectMemberRuntimeProfile(page, runtimeProfileId) {
  assert.match(runtimeProfileId, /^[a-zA-Z0-9._-]+$/, "runtime profile id must be safe for the QA selector");
  const panel = page.locator("#member-seat-picker-panel");
  if (!(await panel.isVisible())) await page.locator("#member-seat-picker-trigger").click();
  const option = panel.locator(`.member-seat-picker-option[data-seat-id="${runtimeProfileId}"]`);
  await option.waitFor({ state: "visible", timeout: 10_000 });
  await option.click();
  await page.waitForFunction(
    (expected) => document.querySelector("#member-runtime-profile-select")?.value === expected,
    runtimeProfileId,
  );
}

function cleanTeamUrl(origin) {
  return new URL("/#team", origin).href;
}

async function api(page, path, { method = "GET", body } = {}) {
  return page.evaluate(async ({ path: target, method: verb, body: payload }) => {
    const token = sessionStorage.getItem("514cc-control-token");
    const response = await fetch(target, {
      method: verb,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${verb} ${target} -> ${response.status}: ${result.error || result.message || "request failed"}`);
    return result;
  }, { path, method, body });
}

export function isAllowedRequestAbort({ method = "GET", pathname = "/", errorText = "" } = {}) {
  if (String(method).toUpperCase() !== "GET" || errorText !== "net::ERR_ABORTED") return false;
  return pathname === "/api/workbench/environment"
    || /^\/api\/runs\/[^/]+\/(?:mission|diff)$/.test(pathname);
}

export function diagnosticsWatcher(diagnostics, allowedGateBlocks, allowedRequestAborts = []) {
  const pending = new Set();
  let closing = false;

  const track = (promise) => {
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
  };

  const watchPage = (page, label) => {
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      if (RESOURCE_STATUS_ERROR.test(message.text())) return;
      diagnostics.push(`${label} console: ${message.text()}`);
    });
    page.on("pageerror", (error) => diagnostics.push(`${label} pageerror: ${error.message}`));
    page.on("requestfailed", (request) => {
      if (closing) return;
      const method = request.method();
      const pathname = new URL(request.url()).pathname;
      const errorText = request.failure()?.errorText || "unknown";
      const diagnostic = `${label} requestfailed: ${method} ${pathname} ${errorText}`;
      if (isAllowedRequestAbort({ method, pathname, errorText })) {
        allowedRequestAborts.push(diagnostic);
        return;
      }
      diagnostics.push(diagnostic);
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      track((async () => {
        const request = response.request();
        const pathname = new URL(response.url()).pathname;
        const payload = await response.json().catch(() => null);
        const failure = httpFailureDiagnostic({
          method: request.method(),
          pathname,
          status: response.status(),
          payload,
        });
        if (failure) diagnostics.push(`${label} http: ${failure}`);
        else allowedGateBlocks.push(`${request.method()} ${pathname}`);
      })());
    });
  };

  const settle = async () => {
    do {
      await Promise.allSettled([...pending]);
    } while (pending.size);
  };

  return {
    watchPage,
    settle,
    beginClosing() { closing = true; },
  };
}

function delayedTeamsGet(page) {
  const release = createDeferred();
  const staleReady = createDeferred();
  const handled = createDeferred();
  let getCount = 0;
  let released = false;

  const handler = async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    getCount += 1;
    if (getCount === 1) {
      try {
        const response = await route.fetch();
        const payload = await response.json();
        staleReady.resolve(payload);
        await release.promise;
        await route.fulfill({ response, json: payload });
      } finally {
        handled.resolve();
      }
      return;
    }
    await route.continue();
  };

  return {
    handler,
    staleReady: staleReady.promise,
    handled: handled.promise,
    release() {
      if (released) return;
      released = true;
      release.resolve();
    },
    getCount: () => getCount,
  };
}

async function verifyPreBootstrapCatalog({ browser, origin, token, watcher }) {
  const page = await browser.newPage({ viewport: { width: 980, height: 720 } });
  watcher.watchPage(page, "pre-bootstrap-catalog");
  await page.addInitScript((ownedToken) => {
    sessionStorage.setItem("514cc-control-token", ownedToken);
  }, token);
  const captured = createDeferred();
  const release = createDeferred();
  const handled = createDeferred();
  const handler = async (route) => {
    try {
      const response = await route.fetch();
      captured.resolve();
      await release.promise;
      await route.fulfill({ response });
    } finally {
      handled.resolve();
    }
  };
  await page.route("**/api/bootstrap", handler);
  try {
    await page.goto(cleanTeamUrl(origin), { waitUntil: "domcontentloaded" });
    await within(captured.promise, 15_000, "bootstrap request capture");
    await page.waitForSelector("#view-team:not([hidden])");
    await page.locator("#team-new-button").click();
    const name = `QA 目录前草稿 ${Date.now()}`;
    await page.locator("#team-name-input").fill(name);
    assert.equal(await page.locator("#team-members-list .team-catalog-loading").count(), 1, "pre-bootstrap new team must show a catalog loading state");
    assert.equal(await page.locator("#team-members-list .team-member-option").count(), 0, "pre-bootstrap UI must not invent a Claude-only catalog");
    assert.equal(await page.locator('input[name="team-coordinator"]').count(), 0);

    await page.locator("#team-surface-members-tab").click();
    await page.waitForSelector("#team-surface-members:not([hidden])");
    const memberCatalogResponse = page.waitForResponse((response) => (
      response.request().method() === "GET" && new URL(response.url()).pathname === "/api/team-members"
    ));
    await page.locator("#member-new-button").click();
    const memberCatalog = await within(memberCatalogResponse, 15_000, "pre-bootstrap member catalog supplement");
    assert.equal(memberCatalog.status(), 200, "member creation before bootstrap must supplement the runtime catalog from /api/team-members");
    await page.waitForSelector("#member-editor-body:not([hidden])");
    assert.equal(
      await page.locator('#member-runtime-profile-select option[value="codex-technical"]:not(:disabled)').count(),
      1,
      "the supplemental member catalog must expose a real Codex runtime seat",
    );
    const memberName = `QA 目录前成员 ${Date.now()}`;
    const memberRole = "pre-bootstrap-verifier";
    const memberPrompt = "保留这份目录晚到前已经填写的成员草稿。";
    await page.locator("#member-label-input").fill(memberName);
    await page.locator("#member-role-input").fill(memberRole);
    await selectMemberRuntimeProfile(page, "codex-technical");
    await page.locator("#member-system-prompt-input").fill(memberPrompt);
    assert.equal(await page.locator("#member-form-status").textContent(), "未保存");

    const bootstrapDelivered = page.waitForResponse((response) => (
      response.request().method() === "GET" && new URL(response.url()).pathname === "/api/bootstrap"
    ));
    release.resolve();
    assert.equal((await within(bootstrapDelivered, 15_000, "delayed bootstrap delivery")).status(), 200);
    await page.waitForSelector('#team-members-list input[name="team-coordinator"][value="codex-technical"]', { state: "attached", timeout: 15_000 });
    await page.waitForFunction(({ memberName: expectedName, memberRole: expectedRole, memberPrompt: expectedPrompt }) => (
      document.querySelector("#member-label-input")?.value === expectedName
        && document.querySelector("#member-role-input")?.value === expectedRole
        && document.querySelector("#member-runtime-profile-select")?.value === "codex-technical"
        && document.querySelector("#member-system-prompt-input")?.value === expectedPrompt
        && document.querySelector("#member-form-status")?.textContent?.trim() === "未保存"
    ), { memberName, memberRole, memberPrompt }, { timeout: 15_000 });
    assert.equal(await page.locator("#team-name-input").inputValue(), name, "catalog hydration must preserve the dirty new-team draft");
    assert.equal(await page.locator("#team-form-status").textContent(), "有未保存修改");
    assert.equal(await page.locator('input[name="team-coordinator"]:checked').count(), 0);
    return {
      loadingState: true,
      inventedMembers: 0,
      draftPreserved: true,
      memberCatalogSupplement: {
        endpoint: "/api/team-members",
        runtimeProfileId: "codex-technical",
        draftPreserved: true,
      },
    };
  } finally {
    release.resolve();
    await within(handled.promise, 5_000, "delayed bootstrap handler drain").catch(() => {});
    await page.unroute("**/api/bootstrap", handler).catch(() => {});
    await page.close().catch(() => {});
  }
}

async function verifyInitialTeamDraftRace({ browser, origin, token, watcher }) {
  const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
  watcher.watchPage(page, "initial-draft-race");
  await page.addInitScript((ownedToken) => {
    sessionStorage.setItem("514cc-control-token", ownedToken);
  }, token);
  const race = delayedTeamsGet(page);
  await page.route("**/api/teams", race.handler);

  try {
    const bootstrapReady = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/bootstrap");
    await page.goto(cleanTeamUrl(origin), { waitUntil: "domcontentloaded" });
    await bootstrapReady;
    await page.waitForSelector("#view-team:not([hidden])");
    await within(race.staleReady, 15_000, "initial team GET capture");
    await page.locator("#team-new-button").click();
    const name = `QA 首屏草稿 ${Date.now()}`;
    const lateDescription = "首屏旧快照不得覆盖保存期间的新输入";
    await page.locator("#team-name-input").fill(name);
    assert.equal(await page.locator('#team-members-list input[type="checkbox"]:checked').count(), 0, "a new team must start with an empty roster");
    assert.equal(await page.locator('input[name="team-coordinator"]:checked').count(), 0, "a new team must not inherit Claude as coordinator");
    assert.match(await page.locator("#team-roster-summary").textContent(), /0 个成员 · 未设置主脑/);
    const claudeRole = await page.locator('#team-members-list .team-member-option:has(input[value="claude-fable"]) .tm-meta span').textContent();
    const codexLabel = await page.locator('#team-members-list .team-member-option:has(input[value="codex-technical"]) .tm-meta strong').textContent();
    assert.match(claudeRole, /规划编排席/);
    assert.match(claudeRole, /可任主脑/);
    assert.doesNotMatch(claudeRole, /(?:默认|当前|团队)主脑/);
    assert.equal(codexLabel?.trim(), "Codex 技术执行", "team catalog labels must override static profile metadata");
    await page.locator('input[name="team-coordinator"][value="codex-technical"]').check();
    assert.equal(await page.locator('#team-members-list input[type="checkbox"][value="codex-technical"]').isChecked(), true);

    const createRequest = page.waitForRequest((request) => (
      request.method() === "POST" && new URL(request.url()).pathname === "/api/teams"
    ));
    const createResponse = page.waitForResponse((response) => (
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/teams"
    ));
    await page.locator("#team-save-button").click();
    const [request, response] = await Promise.all([createRequest, createResponse]);
    assert.equal(response.status(), 201);
    assert.deepEqual(request.postDataJSON().members, ["codex-technical"]);
    assert.equal(request.postDataJSON().coordinator, "codex-technical");
    const created = await response.json();
    await page.locator("#team-description-input").fill(lateDescription);
    race.release();

    await page.waitForFunction(({ id, expectedName, expectedDescription }) => (
      document.querySelector("#team-switch-select")?.value === id
        && document.querySelector("#team-name-input")?.value === expectedName
        && document.querySelector("#team-description-input")?.value === expectedDescription
        && document.querySelector("#team-form-status")?.textContent?.trim() === "有未保存修改"
        && document.querySelector("#team-save-button")?.disabled === false
    ), { id: created.id, expectedName: name, expectedDescription: lateDescription }, { timeout: 25_000 });

    return {
      savedTeamId: created.id,
      lateDescription,
      getCount: race.getCount(),
      remainedDirty: true,
      coordinator: "codex-technical",
      members: ["codex-technical"],
      catalogIdentity: { claudeRole: claudeRole?.trim(), codexLabel: codexLabel?.trim() },
    };
  } finally {
    race.release();
    await within(race.handled, 5_000, "initial team handler drain").catch(() => {});
    await page.unroute("**/api/teams", race.handler).catch(() => {});
    await page.close().catch(() => {});
  }
}

async function runBrowserQa({ browser, bootstrapUrl, origin, outputDir, token, diagnostics, allowedGateBlocks, watcher, setRaceRelease }) {
  const desktop = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  watcher.watchPage(desktop, "desktop");
  await desktop.goto(bootstrapUrl, { waitUntil: "domcontentloaded" });
  await desktop.waitForSelector("#api-connection-badge.is-ok", { timeout: 30_000 });
  const accessToken = await desktop.evaluate(() => sessionStorage.getItem("514cc-control-token") || "");
  assert.equal(accessToken, token, "bootstrap must yield the token owned by this QA server");
  const preBootstrapCatalog = await verifyPreBootstrapCatalog({ browser, origin, token, watcher });
  const initialDraftRace = await verifyInitialTeamDraftRace({ browser, origin, token, watcher });

  const providerOne = await api(desktop, "/api/providers", {
    method: "POST",
    body: {
      name: "QA Relay A",
      baseUrl: "https://qa-a.invalid",
      apiKey: "qa-isolated-key-a",
      apps: { codex: true },
    },
  });
  const providerTwo = await api(desktop, "/api/providers", {
    method: "POST",
    body: {
      name: "QA Relay B",
      baseUrl: "https://qa-b.invalid",
      apiKey: "qa-isolated-key-b",
      apps: { codex: true },
    },
  });
  const team = await api(desktop, "/api/teams", {
    method: "POST",
    body: {
      name: `QA 融合团队 ${Date.now()}`,
      description: "团队工作区隔离验收",
      systemPrompt: "先规划，再实现，最后验证。",
      coordinator: "claude-fable",
      members: ["claude-fable", "codex-technical", "kimi-frontend"],
      skills: ["co-review"],
      mcp: ["codex-agent"],
      providers: { codex: providerOne.id },
    },
  });

  const liveProviders = await api(desktop, "/api/providers");
  assert.ok(liveProviders.providers?.some((item) => item.id === providerTwo.id && item.apps?.codex), "created Codex provider must exist in the API source of truth");
  await desktop.goto(new URL("/#config", origin).href, { waitUntil: "domcontentloaded" });
  await desktop.waitForSelector("#api-connection-badge.is-ok", { timeout: 30_000 });
  await desktop.waitForSelector("#view-config:not([hidden])");
  const providerRefresh = desktop.waitForResponse((response) => (
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/providers"
  ));
  await desktop.locator("#refresh-button").click();
  await providerRefresh;
  await desktop.waitForFunction(() => document.querySelector("#refresh-button")?.disabled === false);
  await desktop.evaluate(() => { location.hash = "team"; });
  await desktop.waitForSelector("#view-team:not([hidden])");
  const liveTeams = await api(desktop, "/api/teams");
  assert.ok(liveTeams.teams?.some((item) => item.id === team.id), "custom team must be visible through the live API");
  const initialRefreshTeams = desktop.waitForResponse((response) => (
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/teams"
  ));
  await desktop.locator("#refresh-button").click();
  await initialRefreshTeams;
  await desktop.waitForFunction(() => document.querySelector("#refresh-button")?.disabled === false);
  await desktop.waitForFunction((id) => [...document.querySelectorAll("#team-switch-select option")].some((option) => option.value === id), team.id);

  const selectedBeforeBrowse = await desktop.evaluate(() => localStorage.getItem("514cc-selected-team"));
  await desktop.locator("#team-switch-select").selectOption(team.id);
  const browseState = await desktop.evaluate(() => ({
    selected: localStorage.getItem("514cc-selected-team"),
    status: document.querySelector("#team-active-status")?.textContent?.trim(),
    runtime: document.querySelector("#team-runtime-team-name")?.textContent?.trim(),
    applyEnabled: !document.querySelector("#team-apply-providers-button")?.disabled,
  }));
  assert.equal(browseState.selected, selectedBeforeBrowse, "browsing settings must not activate a team");
  assert.notEqual(browseState.selected, team.id);
  assert.equal(browseState.status, "仅查看");
  assert.equal(browseState.runtime, "514cc");
  assert.equal(browseState.applyEnabled, true, "a saved provider binding must be applicable before the draft is dirty");

  const activationTeams = desktop.waitForResponse((response) => (
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/teams"
  ));
  await desktop.locator("#team-activate-button").click();
  await desktop.waitForFunction((id) => localStorage.getItem("514cc-selected-team") === id, team.id);
  await desktop.waitForFunction((name) => document.querySelector("#team-runtime-team-name")?.textContent?.trim() === name, team.name);
  await desktop.waitForFunction(() => document.querySelectorAll("#team-roster-root .tp-card").length === 3, null, { timeout: 15_000 });
  await activationTeams;
  await desktop.waitForTimeout(200);
  const activeState = await desktop.evaluate(() => ({
    status: document.querySelector("#team-active-status")?.textContent?.trim(),
    composer: document.querySelector("#composer-team")?.value,
    roster: [...document.querySelectorAll("#team-roster-root .tp-card")].map((card) => card.dataset.agent),
  }));
  assert.equal(activeState.status, "本标签页当前");
  assert.equal(activeState.composer, team.id);
  assert.deepEqual(activeState.roster, ["claude-fable", "codex-technical", "kimi-frontend"]);

  const race = delayedTeamsGet(desktop);
  setRaceRelease(race.release);
  await desktop.route("**/api/teams", race.handler);
  await desktop.locator("#refresh-button").click();
  const staleSnapshot = await within(race.staleReady, 15_000, "stale team snapshot capture");
  assert.equal(staleSnapshot.teams.find((item) => item.id === team.id)?.description, "团队工作区隔离验收");

  await desktop.locator("#team-edit-button").click();
  await desktop.locator("#team-surface-settings").waitFor({ state: "visible", timeout: 15_000 });
  await desktop.locator("#team-description-input").fill("团队设置与运行态已合并验收");
  await desktop.locator("#team-prompt-input").fill("主脑规划，Codex 实现，独立验证。 ");
  await desktop.locator('#team-members-list input[type="checkbox"][value="claude-fable"]').uncheck();
  assert.equal(await desktop.locator('input[name="team-coordinator"]:checked').count(), 0, "removing the current coordinator must leave an explicit unassigned state");
  assert.match(await desktop.locator("#team-roster-summary").textContent(), /2 个成员 · 未设置主脑/);
  await desktop.locator('#team-members-list input[type="checkbox"][value="kimi-frontend"]').uncheck();
  await desktop.locator('#team-members-list input[type="checkbox"][value="codex-technical"]').uncheck();
  await desktop.locator('#team-members-list input[type="radio"][value="codex-technical"]').check();
  assert.equal(await desktop.locator('#team-members-list input[type="checkbox"][value="codex-technical"]').isChecked(), true, "choosing a coordinator must visibly include that member");
  await desktop.waitForSelector("#team-skills-chips input");
  const extraSkill = desktop.locator("#team-skills-chips input:not(:checked):not(:disabled)").first();
  if (await extraSkill.count()) await extraSkill.check();
  const extraMcp = desktop.locator("#team-mcp-chips input:not(:checked):not(:disabled)").first();
  if (await extraMcp.count()) await extraMcp.check();
  await desktop.locator("#team-provider-codex").selectOption(providerTwo.id);

  const dirtyState = await desktop.evaluate(() => ({
    status: document.querySelector("#team-form-status")?.textContent?.trim(),
    applyDisabled: document.querySelector("#team-apply-providers-button")?.disabled,
    applyTitle: document.querySelector("#team-apply-providers-button")?.title,
  }));
  assert.equal(dirtyState.status, "有未保存修改");
  assert.equal(dirtyState.applyDisabled, true, "provider application must be disabled while bindings are unsaved");
  assert.match(dirtyState.applyTitle ?? "", /先保存团队修改/);

  const putRequest = desktop.waitForRequest((request) => request.method() === "PUT" && new URL(request.url()).pathname === `/api/teams/${team.id}`);
  const putResponse = desktop.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/teams/${team.id}`);
  await desktop.locator("#team-save-button").click();
  const [savedRequest, savedResponse] = await Promise.all([putRequest, putResponse]);
  assert.equal(savedResponse.status(), 200);
  const savedBody = savedRequest.postDataJSON();
  assert.equal(savedBody.description, "团队设置与运行态已合并验收");
  assert.equal(savedBody.systemPrompt, "主脑规划，Codex 实现，独立验证。");
  assert.equal(savedBody.coordinator, "codex-technical");
  assert.deepEqual(savedBody.members, ["codex-technical"], "Claude must remain removable from a custom team");
  assert.equal(savedBody.providers.codex, providerTwo.id);
  assert.ok(savedBody.skills.length >= 1 && savedBody.mcp.length >= 1);
  assert.equal(Object.hasOwn(savedBody, "enabled"), false, "team payload must not invent a backend enabled field");

  race.release();
  setRaceRelease(null);
  try {
    await desktop.waitForFunction((description) => (
      document.querySelector("#team-description-input")?.value === description
        && document.querySelector("#team-form-status")?.textContent?.trim() === "已保存"
        && document.querySelector("#team-save-button")?.disabled === false
    ), savedBody.description, { timeout: 25_000 });
  } catch (error) {
    const snapshot = await desktop.evaluate(() => ({
      description: document.querySelector("#team-description-input")?.value,
      formStatus: document.querySelector("#team-form-status")?.textContent?.trim(),
      saveDisabled: document.querySelector("#team-save-button")?.disabled,
      activeStatus: document.querySelector("#team-active-status")?.textContent?.trim(),
      selected: localStorage.getItem("514cc-selected-team"),
    }));
    snapshot.teamGetCount = race.getCount();
    throw new Error(`fresh team snapshot did not reach the form: ${JSON.stringify(snapshot)}`, { cause: error });
  }
  await within(race.handled, 5_000, "team refresh handler drain");
  assert.ok(race.getCount() >= 2, "a write after an in-flight GET must force a later GET");
  await desktop.unroute("**/api/teams", race.handler);
  const freshSnapshot = await api(desktop, "/api/teams");
  assert.equal(freshSnapshot.teams.find((item) => item.id === team.id)?.description, "团队设置与运行态已合并验收");

  // 成员库与团队草稿必须共用同一逻辑身份图：内置资料可编辑，自定义成员可创建、入队、任主脑、移出和删除。
  await desktop.locator('[data-edit-team-member="codex-technical"]').click();
  await desktop.waitForSelector("#team-surface-members:not([hidden])");
  await desktop.waitForFunction(() => document.querySelector("#member-id-value")?.textContent?.trim() === "codex-technical");
  assert.equal(await desktop.locator("#member-runtime-profile-select").isDisabled(), false, "builtin members must allow runtime-seat rebinding");
  await desktop.locator("#member-description-input").fill("QA 内置成员资料编辑验收");
  const builtinMemberPut = desktop.waitForResponse((response) => (
    response.request().method() === "PUT"
      && new URL(response.url()).pathname === "/api/team-members/codex-technical"
  ));
  await desktop.locator("#member-save-button").click();
  const builtinMemberResponse = await builtinMemberPut;
  assert.equal(builtinMemberResponse.status(), 200);
  assert.equal((await builtinMemberResponse.json()).description, "QA 内置成员资料编辑验收");

  // 从成员管理区进入结构化席位编辑器，真实创建 Provider 绑定的 Codex 主脑席位。
  const customSeatId = `qa-codex-seat-${Date.now().toString(36)}`;
  await desktop.locator("#member-new-runtime-button").click();
  await desktop.waitForSelector("#view-config:not([hidden])");
  await desktop.waitForSelector("#config-surface-sources:not([hidden])");
  await desktop.waitForSelector("#runtime-seat-workspace:not([hidden])");
  await desktop.waitForFunction(() => document.querySelector("#runtime-seat-form-title")?.textContent?.trim() === "新建运行席位");
  await desktop.locator("#runtime-seat-id-input").fill(customSeatId);
  await desktop.locator("#runtime-seat-label-input").fill("QA Codex 自定义主脑席");
  await desktop.locator("#runtime-seat-role-input").fill("technical-coordinator");
  await desktop.locator("#runtime-seat-description-input").fill("由结构化界面创建并绑定隔离 Provider");
  await desktop.locator("#runtime-seat-adapter-select").selectOption("codex-app-server");
  await desktop.waitForFunction((providerId) => (
    [...document.querySelectorAll("#runtime-seat-provider-select option")].some((option) => option.value === providerId)
  ), providerTwo.id);
  await desktop.locator("#runtime-seat-provider-select").selectOption(providerTwo.id);
  await desktop.locator("#runtime-seat-command-input").fill("codex");
  await desktop.locator("#runtime-seat-model-input").fill("gpt-qa-seat");
  await desktop.locator("#runtime-seat-effort-input").selectOption("high");
  await desktop.locator("#runtime-seat-permission-select").selectOption("read-only");
  await desktop.locator("#runtime-seat-system-prompt-input").fill("规划、编排并验证当前团队任务。");
  assert.equal(await desktop.locator("#runtime-seat-coordinator-input").isDisabled(), false);
  await desktop.locator("#runtime-seat-coordinator-input").check();
  const seatCreateRequest = desktop.waitForRequest((request) => (
    request.method() === "POST" && new URL(request.url()).pathname === "/api/runtime-seats"
  ));
  const seatCreateResponse = desktop.waitForResponse((response) => (
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/runtime-seats"
  ));
  await desktop.locator('#runtime-seat-form button[type="submit"]').click();
  const [createdSeatRequest, createdSeatResponse] = await Promise.all([seatCreateRequest, seatCreateResponse]);
  assert.equal(createdSeatResponse.status(), 201);
  const createdSeatBody = createdSeatRequest.postDataJSON();
  const createdSeatPayload = await createdSeatResponse.json();
  assert.equal(createdSeatBody.id, customSeatId);
  assert.equal(createdSeatBody.adapter, "codex-app-server");
  assert.equal(createdSeatBody.providerId, providerTwo.id);
  assert.equal(createdSeatBody.coordinatorEligible, true);
  assert.equal(createdSeatPayload.seat.id, customSeatId);
  assert.ok(["reloaded", "restart-required"].includes(createdSeatPayload.transaction.activation.status));
  await desktop.waitForFunction((seatId) => (
    document.querySelector("#runtime-seat-id-input")?.value === seatId
      && document.querySelector(`[data-runtime-seat-id="${CSS.escape(seatId)}"]`)?.classList.contains("is-active")
  ), customSeatId, { timeout: 20_000 });

  await desktop.evaluate(() => { location.hash = "team"; });
  await desktop.waitForSelector("#view-team:not([hidden])");
  await desktop.waitForSelector("#team-surface-members:not([hidden])");

  await desktop.locator("#member-new-button").click();
  await desktop.locator("#member-label-input").fill("QA 架构实现席");
  await desktop.locator("#member-short-label-input").fill("架构");
  await desktop.locator("#member-role-input").fill("architecture-implementer");
  await desktop.locator("#member-description-input").fill("负责架构实现与机械验证");
  await selectMemberRuntimeProfile(desktop, customSeatId);
  await desktop.locator("#member-system-prompt-input").fill("先确认边界，再实现并给出验证证据。");
  const memberCreate = desktop.waitForResponse((response) => (
    response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/team-members"
  ));
  await desktop.locator("#member-save-button").click();
  const memberCreateResponse = await memberCreate;
  assert.equal(memberCreateResponse.status(), 201);
  const customMember = await memberCreateResponse.json();
  assert.equal(customMember.runtimeProfileId, customSeatId);
  assert.equal(customMember.coordinatorEligible, true);
  await desktop.waitForSelector(`[data-member-id="${customMember.id}"]`);

  const customMemberCheckboxBeforeAssignment = desktop.locator(`#team-members-list input[type="checkbox"][value="${customMember.id}"]`);
  assert.equal(await customMemberCheckboxBeforeAssignment.isChecked(), true, "a saved member must be staged into the current team draft");
  const persistedBeforeAssignment = await api(desktop, "/api/teams");
  assert.equal(
    persistedBeforeAssignment.teams.find((item) => item.id === team.id)?.members.includes(customMember.id),
    false,
    "configuration deep links must work before the staged member is persisted into the team",
  );

  await desktop.locator("#member-open-capabilities-button").click();
  await desktop.waitForSelector("#view-config:not([hidden])");
  await desktop.waitForSelector("#config-surface-capabilities:not([hidden])");
  const focusedCapabilityColumns = desktop.locator(`[data-member-column="${customMember.id}"].is-member-focus`);
  await focusedCapabilityColumns.first().waitFor({ state: "visible", timeout: 15_000 });
  await desktop.waitForFunction((memberId) => document.activeElement?.dataset?.memberColumn === memberId, customMember.id, { timeout: 5_000 });
  const capabilityDeepLink = await desktop.evaluate((memberId) => ({
    hash: location.hash,
    hashPath: location.hash.split("?", 1)[0],
    memberParam: new URLSearchParams(location.hash.split("?", 2)[1] || "").get("member"),
    runtimeParam: new URLSearchParams(location.hash.split("?", 2)[1] || "").get("runtime"),
    activeSurface: document.querySelector("[data-config-surface].is-active")?.dataset.configSurface,
    focusedColumnCount: document.querySelectorAll(`[data-member-column="${CSS.escape(memberId)}"].is-member-focus`).length,
    activeMemberColumn: document.activeElement?.dataset?.memberColumn || null,
  }), customMember.id);
  assert.equal(capabilityDeepLink.hashPath, "#config/capabilities");
  assert.equal(capabilityDeepLink.memberParam, customMember.id);
  assert.equal(capabilityDeepLink.runtimeParam, customSeatId);
  assert.equal(capabilityDeepLink.activeSurface, "capabilities");
  assert.ok(capabilityDeepLink.focusedColumnCount > 0);
  assert.equal(capabilityDeepLink.activeMemberColumn, customMember.id);
  assert.equal(await customMemberCheckboxBeforeAssignment.isChecked(), true, "capability deep link must preserve the staged team member");
  assert.equal((await desktop.locator("#team-form-status").textContent())?.trim(), "有未保存修改");

  await desktop.evaluate(() => { location.hash = "team"; });
  await desktop.waitForSelector("#view-team:not([hidden])");
  await desktop.waitForSelector("#team-surface-members:not([hidden])");
  await desktop.waitForFunction((memberId) => document.querySelector("#member-id-value")?.textContent?.trim() === memberId, customMember.id);
  assert.equal(await customMemberCheckboxBeforeAssignment.isChecked(), true, "returning from capabilities must preserve the staged team member");

  await desktop.locator("#member-open-config-button").click();
  await desktop.waitForSelector("#view-config:not([hidden])");
  await desktop.waitForSelector("#config-surface-sources:not([hidden])");
  await desktop.waitForFunction((runtimeProfileId) => {
    const item = document.querySelector(`[data-runtime-seat-id="${CSS.escape(runtimeProfileId)}"]`);
    return document.querySelector("#runtime-seat-workspace")?.hidden === false
      && document.querySelector("#runtime-seat-form")?.hidden === false
      && document.querySelector("#runtime-seat-id-input")?.value === runtimeProfileId
      && item?.classList.contains("is-active");
  }, customSeatId, { timeout: 15_000 });
  const runtimeDeepLink = await desktop.evaluate(() => {
    return {
      hash: location.hash,
      hashPath: location.hash.split("?", 1)[0],
      memberParam: new URLSearchParams(location.hash.split("?", 2)[1] || "").get("member"),
      runtimeParam: new URLSearchParams(location.hash.split("?", 2)[1] || "").get("runtime"),
      activeSurface: document.querySelector("[data-config-surface].is-active")?.dataset.configSurface,
      workspaceMode: document.querySelector("[data-runtime-workspace-mode].is-active")?.dataset.runtimeWorkspaceMode,
      selectedSeatId: document.querySelector(".runtime-seat-item.is-active")?.dataset.runtimeSeatId || null,
      seatId: document.querySelector("#runtime-seat-id-input")?.value || null,
      adapter: document.querySelector("#runtime-seat-adapter-select")?.value || null,
      providerId: document.querySelector("#runtime-seat-provider-select")?.value || null,
      coordinatorEligible: document.querySelector("#runtime-seat-coordinator-input")?.checked === true,
      rawSourceHidden: document.querySelector("#runtime-raw-source-workspace")?.hidden === true,
    };
  });
  assert.equal(runtimeDeepLink.hashPath, "#config/sources");
  assert.equal(runtimeDeepLink.memberParam, customMember.id);
  assert.equal(runtimeDeepLink.runtimeParam, customSeatId);
  assert.equal(runtimeDeepLink.activeSurface, "sources");
  assert.equal(runtimeDeepLink.workspaceMode, "seats");
  assert.equal(runtimeDeepLink.selectedSeatId, customSeatId);
  assert.equal(runtimeDeepLink.seatId, customSeatId);
  assert.equal(runtimeDeepLink.adapter, "codex-app-server");
  assert.equal(runtimeDeepLink.providerId, providerTwo.id);
  assert.equal(runtimeDeepLink.coordinatorEligible, true);
  assert.equal(runtimeDeepLink.rawSourceHidden, true);
  assert.equal(await customMemberCheckboxBeforeAssignment.isChecked(), true, "runtime deep link must preserve the staged team member");

  await desktop.evaluate(() => { location.hash = "team"; });
  await desktop.waitForSelector("#view-team:not([hidden])");
  await desktop.waitForSelector("#team-surface-members:not([hidden])");
  await desktop.waitForFunction((memberId) => document.querySelector("#member-id-value")?.textContent?.trim() === memberId, customMember.id);

  assert.equal(await desktop.locator("#member-team-toggle-label").textContent(), "从当前团队移除");
  await desktop.locator("#team-surface-settings-tab").click();
  const customMemberCheckbox = desktop.locator(`#team-members-list input[type="checkbox"][value="${customMember.id}"]`);
  const customCoordinator = desktop.locator(`#team-members-list input[name="team-coordinator"][value="${customMember.id}"]`);
  assert.equal(await customMemberCheckbox.isChecked(), true);
  await customCoordinator.check();

  // 团队草稿已经脏，此时再编辑成员资料；目录刷新不能吞掉成员勾选或主脑选择。
  await desktop.locator(`[data-edit-team-member="${customMember.id}"]`).click();
  await desktop.waitForSelector("#team-surface-members:not([hidden])");
  await desktop.locator("#member-label-input").fill("QA 架构主脑");
  const customMemberPut = desktop.waitForResponse((response) => (
    response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/team-members/${customMember.id}`
  ));
  await desktop.locator("#member-save-button").click();
  const customMemberPutResponse = await customMemberPut;
  assert.equal(customMemberPutResponse.status(), 200);
  assert.equal((await customMemberPutResponse.json()).label, "QA 架构主脑");
  await desktop.locator("#team-surface-settings-tab").click();
  assert.equal(await customMemberCheckbox.isChecked(), true, "member catalog refresh must preserve the dirty team roster");
  assert.equal(await customCoordinator.isChecked(), true, "member catalog refresh must preserve the dirty coordinator");
  assert.equal(
    (await desktop.locator(`.team-member-option:has(input[value="${customMember.id}"]) .tm-meta strong`).textContent())?.trim(),
    "QA 架构主脑",
  );

  const memberAssignmentPut = desktop.waitForRequest((request) => (
    request.method() === "PUT" && new URL(request.url()).pathname === `/api/teams/${team.id}`
  ));
  await desktop.locator("#team-save-button").click();
  const memberAssignmentBody = (await memberAssignmentPut).postDataJSON();
  assert.deepEqual(memberAssignmentBody.members, ["codex-technical", customMember.id]);
  assert.equal(memberAssignmentBody.coordinator, customMember.id);
  await desktop.waitForFunction(() => document.querySelector("#team-form-status")?.textContent?.trim() === "已保存");

  await desktop.locator(`[data-edit-team-member="${customMember.id}"]`).click();
  await desktop.waitForSelector("#team-surface-members:not([hidden])");
  await desktop.locator("#member-team-toggle-button").click();
  await desktop.locator("#team-surface-settings-tab").click();
  assert.equal(await customMemberCheckbox.isChecked(), false);
  assert.equal(await desktop.locator('input[name="team-coordinator"]:checked').count(), 0);
  await desktop.locator('#team-members-list input[name="team-coordinator"][value="codex-technical"]').check();
  const memberRemovalPut = desktop.waitForRequest((request) => (
    request.method() === "PUT" && new URL(request.url()).pathname === `/api/teams/${team.id}`
  ));
  await desktop.locator("#team-save-button").click();
  const memberRemovalBody = (await memberRemovalPut).postDataJSON();
  assert.deepEqual(memberRemovalBody.members, ["codex-technical"]);
  assert.equal(memberRemovalBody.coordinator, "codex-technical");
  await desktop.waitForFunction(() => document.querySelector("#team-form-status")?.textContent?.trim() === "已保存");

  await desktop.locator(`[data-edit-team-member="${customMember.id}"]`).click();
  await desktop.waitForSelector("#team-surface-members:not([hidden])");
  const memberDelete = desktop.waitForResponse((response) => (
    response.request().method() === "DELETE"
      && new URL(response.url()).pathname === `/api/team-members/${customMember.id}`
  ));
  await desktop.locator("#member-delete-button").click();
  await desktop.locator("#dialog-confirm-button").click();
  const memberDeleteResponse = await memberDelete;
  assert.equal(memberDeleteResponse.status(), 200);
  await desktop.waitForFunction((memberId) => !document.querySelector(`[data-member-id="${memberId}"]`), customMember.id);
  const seatDelete = await api(desktop, `/api/runtime-seats/${encodeURIComponent(customSeatId)}`, { method: "DELETE" });
  assert.equal(seatDelete.removed, customSeatId, "custom runtime seat must be removable after its member reference is released");
  await desktop.locator("#team-surface-orchestration-tab").click();

  await desktop.waitForFunction(() => (
    document.querySelectorAll("#team-hero-root .cf-skeleton, #team-roster-root .cf-skeleton").length === 0
      && document.querySelectorAll("#team-roster-root .tp-card").length === 1
  ), null, { timeout: 15_000 });

  await desktop.locator("#team-new-button").click();
  const createdName = `QA 浏览保存 ${Date.now()}`;
  await desktop.locator("#team-name-input").fill(createdName);
  await desktop.locator("#team-description-input").fill("保存后仍不自动选用");
  await desktop.locator('input[name="team-coordinator"][value="kimi-frontend"]').check();
  assert.equal(await desktop.locator('#team-members-list input[type="checkbox"][value="kimi-frontend"]').isChecked(), true);
  await desktop.evaluate(() => { location.hash = "overview"; });
  await desktop.waitForSelector("#view-overview:not([hidden])");
  await desktop.evaluate(() => { location.hash = "team"; });
  await desktop.waitForSelector("#view-team:not([hidden])");
  assert.equal(await desktop.locator("#team-name-input").inputValue(), createdName, "leaving and returning must preserve a new-team draft");
  assert.equal(await desktop.locator("#team-description-input").inputValue(), "保存后仍不自动选用");

  const createRelease = createDeferred();
  const createCaptured = createDeferred();
  const createRoute = async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/teams") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const createdTeam = await response.json();
    createCaptured.resolve({ createdTeam, requestBody: request.postDataJSON(), response });
    await createRelease.promise;
    await route.fulfill({ response, json: createdTeam });
  };
  await desktop.route("**/api/teams", createRoute);
  const createResponse = desktop.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/teams");
  await desktop.locator("#team-save-button").click();
  const capturedCreate = await within(createCaptured.promise, 15_000, "new-team POST capture");
  assert.equal(await desktop.locator("#team-save-button").isDisabled(), true);
  await desktop.locator("#team-description-input").fill("保存期间继续编辑，晚到响应不得覆盖");
  createRelease.resolve();
  const createdResponse = await createResponse;
  await desktop.unroute("**/api/teams", createRoute);
  assert.equal(createdResponse.status(), 201);
  const createdTeam = capturedCreate.createdTeam;
  assert.equal(Object.hasOwn(capturedCreate.requestBody, "enabled"), false);
  assert.deepEqual(capturedCreate.requestBody.members, ["kimi-frontend"]);
  assert.equal(capturedCreate.requestBody.coordinator, "kimi-frontend");
  await desktop.waitForFunction((id) => (
    document.querySelector("#team-switch-select")?.value === id
      && document.querySelector("#team-form-status")?.textContent?.trim() === "有未保存修改"
      && document.querySelector("#team-save-button")?.disabled === false
  ), createdTeam.id, { timeout: 15_000 });
  assert.equal(await desktop.locator("#team-description-input").inputValue(), "保存期间继续编辑，晚到响应不得覆盖");

  const followupPut = desktop.waitForRequest((request) => request.method() === "PUT" && new URL(request.url()).pathname === `/api/teams/${createdTeam.id}`);
  await desktop.locator("#team-save-button").click();
  const followupBody = (await followupPut).postDataJSON();
  assert.equal(followupBody.description, "保存期间继续编辑，晚到响应不得覆盖");
  assert.deepEqual(followupBody.members, ["kimi-frontend"]);
  assert.equal(followupBody.coordinator, "kimi-frontend");
  await desktop.waitForFunction(() => (
    document.querySelector("#team-form-status")?.textContent?.trim() === "已保存"
      && document.querySelector("#team-save-button")?.disabled === false
  ), null, { timeout: 15_000 });
  const postCreateState = await desktop.evaluate(() => ({
    selected: localStorage.getItem("514cc-selected-team"),
    status: document.querySelector("#team-active-status")?.textContent?.trim(),
    runtime: document.querySelector("#team-runtime-team-name")?.textContent?.trim(),
    composer: document.querySelector("#composer-team")?.value,
  }));
  assert.equal(postCreateState.selected, team.id, "saving a new team must not activate it");
  assert.equal(postCreateState.status, "仅查看");
  assert.equal(postCreateState.runtime, team.name);
  assert.equal(postCreateState.composer, team.id);

  const desktopLayout = await desktop.evaluate(() => ({
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    mainOverflow: document.querySelector("main")?.scrollWidth - document.querySelector("main")?.clientWidth,
    h1: document.querySelector("#team-title")?.textContent?.trim(),
    dialogCount: document.querySelectorAll("#team-dialog").length,
  }));
  assert.ok(desktopLayout.documentOverflow <= 1 && desktopLayout.mainOverflow <= 1, `desktop overflow: ${JSON.stringify(desktopLayout)}`);
  assert.equal(desktopLayout.h1, "团队协作");
  assert.equal(desktopLayout.dialogCount, 0);
  await desktop.waitForFunction(() => document.querySelectorAll("#toast-region .toast").length === 0, null, { timeout: 12_000 });
  await desktop.evaluate(() => {
    document.querySelector("#main-content")?.scrollTo(0, 0);
    document.querySelector(".team-form-body")?.scrollTo(0, 0);
  });
  await desktop.waitForTimeout(250);
  await desktop.screenshot({ path: resolve(outputDir, "team-desktop.png") });
  await desktop.locator("#view-team").screenshot({ path: resolve(outputDir, "team-desktop-full.png") });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  watcher.watchPage(mobile, "mobile");
  await mobile.addInitScript(({ ownedToken, teamId }) => {
    sessionStorage.setItem("514cc-control-token", ownedToken);
    localStorage.setItem("514cc-selected-team", teamId);
  }, { ownedToken: token, teamId: team.id });
  await mobile.goto(cleanTeamUrl(origin), { waitUntil: "domcontentloaded" });
  await mobile.waitForSelector("#api-connection-badge.is-ok", { timeout: 30_000 });
  await mobile.waitForSelector("#view-team:not([hidden])");
  await mobile.waitForFunction((name) => document.querySelector("#team-runtime-team-name")?.textContent?.trim() === name, team.name, { timeout: 15_000 });
  await mobile.waitForFunction(() => document.querySelectorAll("#team-roster-root .tp-card").length === 1, null, { timeout: 15_000 });

  const mobileLayout = await mobile.evaluate(() => {
    const rects = [...document.querySelectorAll(".team-control-actions .button")]
      .filter((button) => button.offsetParent !== null)
      .map((button) => ({ id: button.id, ...button.getBoundingClientRect().toJSON() }));
    const pairOverlaps = [];
    for (let left = 0; left < rects.length; left += 1) {
      for (let right = left + 1; right < rects.length; right += 1) {
        const a = rects[left];
        const b = rects[right];
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) pairOverlaps.push([a.id, b.id]);
      }
    }
    const memberList = document.querySelector("#team-members-list");
    const memberGridColumns = [...(memberList?.querySelectorAll(".tm-group-body") ?? [])]
      .filter((group) => group.offsetParent !== null)
      .map((group) => getComputedStyle(group).gridTemplateColumns.split(/\s+/).filter(Boolean).length);
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      mainOverflow: document.querySelector("main")?.scrollWidth - document.querySelector("main")?.clientWidth,
      viewOverflow: document.querySelector("#view-team")?.scrollWidth - document.querySelector("#view-team")?.clientWidth,
      controlsWithinViewport: rects.every((rect) => rect.left >= -1 && rect.right <= innerWidth + 1 && rect.width > 0),
      pairOverlaps,
      memberGridColumns,
      memberSingleColumn: memberGridColumns.every((columns) => columns === 1),
    };
  });
  assert.ok(mobileLayout.documentOverflow <= 1 && mobileLayout.mainOverflow <= 1 && mobileLayout.viewOverflow <= 1, `mobile overflow: ${JSON.stringify(mobileLayout)}`);
  assert.equal(mobileLayout.controlsWithinViewport, true);
  assert.deepEqual(mobileLayout.pairOverlaps, []);
  assert.equal(mobileLayout.memberSingleColumn, true, `mobile member grids are not single-column: ${JSON.stringify(mobileLayout.memberGridColumns)}`);
  await mobile.evaluate(() => document.querySelector("#main-content")?.scrollTo(0, 0));
  await mobile.waitForTimeout(200);
  await mobile.screenshot({ path: resolve(outputDir, "team-mobile.png") });
  await mobile.locator("#view-team").screenshot({ path: resolve(outputDir, "team-mobile-full.png") });
  await mobile.locator("#team-edit-button").click();
  await mobile.waitForFunction(() => {
    const form = document.querySelector("#team-form");
    if (!form) return false;
    const rect = form.getBoundingClientRect();
    return rect.top >= 0 && rect.top < innerHeight * 0.45;
  }, null, { timeout: 5_000 });
  const settingsShortcut = await mobile.evaluate(() => ({
    activeElement: document.activeElement?.id,
    formTop: Math.round(document.querySelector("#team-form")?.getBoundingClientRect().top ?? -1),
  }));
  assert.equal(settingsShortcut.activeElement, "team-name-input");
  await mobile.screenshot({ path: resolve(outputDir, "team-mobile-settings.png") });

  await mobile.locator("#team-surface-members-tab").click();
  await mobile.waitForSelector("#team-surface-members:not([hidden])");
  await mobile.locator("#member-library-list [data-member-id]").first().click();
  await mobile.waitForSelector("#member-editor-body:not([hidden])");
  const mobileMemberLayout = await mobile.evaluate(() => {
    const library = document.querySelector("#team-surface-members");
    const index = library?.querySelector(".member-library-index");
    const editor = library?.querySelector(".member-editor");
    const visibleControls = [...library?.querySelectorAll("input, textarea, select, button") || []]
      .filter((control) => control.offsetParent !== null)
      .map((control) => ({ id: control.id, rect: control.getBoundingClientRect().toJSON() }));
    const libraryRect = library?.getBoundingClientRect();
    const indexRect = index?.getBoundingClientRect();
    const editorRect = editor?.getBoundingClientRect();
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      viewOverflow: document.querySelector("#view-team")?.scrollWidth - document.querySelector("#view-team")?.clientWidth,
      libraryWithinViewport: Boolean(libraryRect && libraryRect.left >= -1 && libraryRect.right <= innerWidth + 1),
      stacked: Boolean(indexRect && editorRect && editorRect.top >= indexRect.bottom - 1),
      controlsWithinWidth: visibleControls.every(({ rect }) => rect.left >= -1 && rect.right <= innerWidth + 1 && rect.width > 0),
    };
  });
  assert.ok(
    mobileMemberLayout.documentOverflow <= 1 && mobileMemberLayout.viewOverflow <= 1,
    `mobile member library overflow: ${JSON.stringify(mobileMemberLayout)}`,
  );
  assert.equal(mobileMemberLayout.libraryWithinViewport, true);
  assert.equal(mobileMemberLayout.stacked, true);
  assert.equal(mobileMemberLayout.controlsWithinWidth, true);
  await mobile.evaluate(() => document.querySelector("#main-content")?.scrollTo(0, 0));
  await mobile.waitForTimeout(200);
  await mobile.screenshot({ path: resolve(outputDir, "team-mobile-members.png") });

  const health = await api(desktop, "/api/health");
  const requiredProfiles = ["codex-technical", "kimi-frontend"];
  const unavailableProfiles = requiredProfiles
    .map((id) => health.items?.find((item) => item.id === id) ?? { id, status: "missing" })
    .filter((item) => item.available !== true)
    .map((item) => ({ id: item.id, status: item.status, reason: item.reason }));
  assert.deepEqual(unavailableProfiles, [], `team dry-run prerequisites unavailable: ${JSON.stringify(unavailableProfiles)}`);

  async function verifyDryRun(teamId, coordinatorId) {
    const run = await api(desktop, "/api/runs", {
      method: "POST",
      body: {
        prompt: `实现 ${coordinatorId} 团队路由契约核验`,
        taskType: "coding",
        risk: "normal",
        execute: false,
        permissionMode: "plan",
        orchestrationMode: "social",
        teamId,
      },
    });
    assert.equal(run.status, "succeeded");
    assert.equal(run.execute, false);
    assert.equal(run.teamId, teamId);
    assert.equal(run.coordinatorId, coordinatorId);
    assert.equal(run.startAgentId, coordinatorId);
    assert.deepEqual(run.teamMembers, [coordinatorId]);
    assert.equal(run.route?.selected?.id, coordinatorId);
    assert.equal(run.result?.type, "route-preview");
    return {
      id: run.id,
      coordinatorId: run.coordinatorId,
      startAgentId: run.startAgentId,
      teamMembers: run.teamMembers,
    };
  }

  const runContracts = {
    codex: await verifyDryRun(team.id, "codex-technical"),
    kimi: await verifyDryRun(createdTeam.id, "kimi-frontend"),
  };

  await watcher.settle();
  return {
    ok: true,
    teamId: team.id,
    browsedSavedTeamId: createdTeam.id,
    desktopLayout,
    mobileLayout,
    diagnostics,
    allowedGateBlocks: [...new Set(allowedGateBlocks)].sort(),
    preBootstrapCatalog,
    initialDraftRace,
    race: {
      staleDescription: staleSnapshot.teams.find((item) => item.id === team.id)?.description,
      freshDescription: freshSnapshot.teams.find((item) => item.id === team.id)?.description,
      getCount: race.getCount(),
    },
    draftProtection: {
      survivedViewRoundTrip: true,
      lateEditPreserved: followupBody.description,
      reboundSaveMethod: "PUT",
      remainedBrowseOnly: postCreateState.selected === team.id,
      removedClaudeFromCustomTeam: savedBody.members.length === 1 && savedBody.members[0] === "codex-technical",
    },
    memberLibrary: {
      builtinEdited: builtinMemberResponse.status() === 200,
      customCreated: Boolean(customMember.id),
      unassignedMemberCapabilityDeepLink: capabilityDeepLink,
      runtimeConfigDeepLink: runtimeDeepLink,
      dirtyTeamDraftPreserved: true,
      assignedAsCoordinator: memberAssignmentBody.coordinator === customMember.id,
      removedAndDeleted: memberDeleteResponse.status() === 200,
    },
    runContracts,
    settingsShortcut,
    mobileMemberLayout,
  };
}

export async function runTeamWorkspaceQa({ outputDir } = parseQaArgs()) {
  await mkdir(outputDir, { recursive: true });
  let result = null;
  await withDisposableQaRoot(async (qaRoot) => {
    const token = randomBytes(32).toString("base64url");
    const isolatedRepoRoot = await createIsolatedQaRepo(qaRoot);
    const isolatedEnv = buildIsolatedServerEnv({ qaRoot, token, testRepoRoot: isolatedRepoRoot });
    await Promise.all([
      mkdir(isolatedEnv.CONTROL_CENTER_DATA_DIR, { recursive: true }),
      mkdir(isolatedEnv.CONTROL_CENTER_RUNTIME_HOME, { recursive: true }),
      mkdir(isolatedEnv.APPDATA, { recursive: true }),
      mkdir(isolatedEnv.LOCALAPPDATA, { recursive: true }),
      mkdir(isolatedEnv.XDG_CONFIG_HOME, { recursive: true }),
      mkdir(isolatedEnv.XDG_DATA_HOME, { recursive: true }),
      mkdir(isolatedEnv.XDG_CACHE_HOME, { recursive: true }),
    ]);

    let browser = null;
    let server = null;
    let failure = null;
    let raceRelease = null;
    const cleanupErrors = [];
    const diagnostics = [];
    const allowedGateBlocks = [];
    const allowedRequestAborts = [];
    const watcher = diagnosticsWatcher(diagnostics, allowedGateBlocks, allowedRequestAborts);
    let shutdown = null;

    try {
      server = spawnTestServer({ env: isolatedEnv, cwd: appRoot });
      const bootstrapUrl = await waitForUrl(server, { timeoutMs: 30_000 });
      const parsed = new URL(bootstrapUrl);
      assert.equal(parsed.hostname, "127.0.0.1");
      assert.ok(Number(parsed.port) > 0, "isolated server must publish an ephemeral loopback port");
      browser = await chromium.launch({ headless: true });
      result = await runBrowserQa({
        browser,
        bootstrapUrl,
        origin: parsed.origin,
        outputDir,
        token,
        diagnostics,
        allowedGateBlocks,
        watcher,
        setRaceRelease(value) { raceRelease = value; },
      });
      result.isolation = {
        selfSpawned: true,
        pid: server.pid,
        origin: parsed.origin,
        randomPort: Number(parsed.port),
        dataRootIsolated: true,
        runtimeHomeIsolated: true,
        gracefulShutdown: false,
        tempRootRemoved: false,
      };
    } catch (error) {
      failure = error;
    } finally {
      watcher.beginClosing();
      raceRelease?.();
      if (browser) {
        try {
          await browser.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        // A response event can be registered after runBrowserQa's first drain but before close settles.
        await watcher.settle();
        assert.deepEqual(diagnostics, [], `browser diagnostics: ${diagnostics.join(" | ")}`);
        if (result) {
          result.diagnostics = [...diagnostics];
          result.allowedGateBlocks = [...new Set(allowedGateBlocks)].sort();
          result.allowedRequestAborts = allowedRequestAborts.length;
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (server) {
        try {
          shutdown = await stopTestServer(server, { token, timeoutMs: 8_000 });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }

    if (failure || cleanupErrors.length) {
      throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "team workspace QA failed");
    }
    result.isolation.gracefulShutdown = shutdown?.graceful === true && shutdown?.fallback === false;
  });

  result.isolation.tempRootRemoved = true;
  assert.equal(result.isolation.gracefulShutdown, true);
  assert.equal(result.isolation.tempRootRemoved, true);
  return result;
}

async function main() {
  const result = await runTeamWorkspaceQa(parseQaArgs());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
