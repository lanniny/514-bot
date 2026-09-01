import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  ALLOWED_GATE_BLOCKS,
  assertDisposableQaRoot,
  buildIsolatedServerEnv,
  createIsolatedQaRepo,
  diagnosticsWatcher,
  httpFailureDiagnostic,
  isAllowedRequestAbort,
  parseQaArgs,
  withDisposableQaRoot,
} from "../scripts/qa-team-workspace.mjs";

test("team QA rejects external URLs, positional targets and the old isolated flag", () => {
  assert.throws(() => parseQaArgs(["http://127.0.0.1:51400", "--isolated"]), /does not accept a Control Center URL/);
  assert.throws(() => parseQaArgs(["--isolated"]), /obsolete/);
  assert.throws(() => parseQaArgs([".qa-output/team-workspace"]), /unknown qa:team argument/);
  assert.throws(() => parseQaArgs(["--output-dir=https://example.invalid/qa"]), /does not accept a Control Center URL/);
  assert.equal(parseQaArgs(["--output-dir", ".qa-output/team-safe"]).outputDir, resolve(".qa-output/team-safe"));
});

test("team QA environment overrides every persistent user and runtime root", () => {
  const qaRoot = join(tmpdir(), "514cc-team-qa-unit-root");
  const env = buildIsolatedServerEnv({
    qaRoot,
    token: "owned-token",
    baseEnv: {
      CONTROL_CENTER_DATA_DIR: "real-data",
      CONTROL_CENTER_RUNTIME_HOME: "real-runtime",
      HOME: "real-home",
      USERPROFILE: "real-profile",
      APPDATA: "real-appdata",
      LOCALAPPDATA: "real-localappdata",
      XDG_CONFIG_HOME: "real-xdg-config",
      XDG_DATA_HOME: "real-xdg-data",
      XDG_CACHE_HOME: "real-xdg-cache",
      CONTROL_CENTER_PORT: "51400",
      CONTROL_CENTER_OPEN: "1",
      CONTROL_CENTER_TEST_MODE: "0",
      NODE_OPTIONS: "--trace-warnings",
    },
  });

  assert.equal(env.CONTROL_CENTER_DATA_DIR, join(qaRoot, "data"));
  assert.equal(env.CONTROL_CENTER_REPO_ROOT, join(qaRoot, "repo"));
  assert.equal(env.CONTROL_CENTER_TEST_REPO_ROOT, join(qaRoot, "repo"));
  assert.equal(env.CONTROL_CENTER_RUNTIME_HOME, join(qaRoot, "home"));
  assert.equal(env.HOME, join(qaRoot, "home"));
  assert.equal(env.USERPROFILE, join(qaRoot, "home"));
  assert.equal(env.APPDATA, join(qaRoot, "appdata"));
  assert.equal(env.LOCALAPPDATA, join(qaRoot, "localappdata"));
  assert.equal(env.XDG_CONFIG_HOME, join(qaRoot, "xdg", "config"));
  assert.equal(env.XDG_DATA_HOME, join(qaRoot, "xdg", "data"));
  assert.equal(env.XDG_CACHE_HOME, join(qaRoot, "xdg", "cache"));
  assert.equal(env.CONTROL_CENTER_PORT, "0");
  assert.equal(env.CONTROL_CENTER_OPEN, "0");
  assert.equal(env.CONTROL_CENTER_TEST_MODE, "1");
  assert.equal(env.CONTROL_CENTER_TOKEN, "owned-token");
  assert.match(env.NODE_OPTIONS, /--experimental-sqlite/);
});

test("team QA copies mutable runtime config into its disposable repository", async () => {
  const qaRoot = join(tmpdir(), `514cc-team-qa-unit-repo-${Date.now()}`);
  await mkdir(qaRoot, { recursive: true });
  try {
    const isolatedRepoRoot = await createIsolatedQaRepo(qaRoot);
    assert.equal(isolatedRepoRoot, join(qaRoot, "repo"));
    await access(join(isolatedRepoRoot, "config", "control-center", "models.json"));
    await access(join(isolatedRepoRoot, "schemas", "control-center", "contracts.schema.json"));
    await access(join(isolatedRepoRoot, "module.yaml"));
  } finally {
    await rm(assertDisposableQaRoot(qaRoot), { recursive: true, force: true });
  }
});

test("team QA only allows explicit read-only remote gate 501 responses", () => {
  assert.deepEqual([...ALLOWED_GATE_BLOCKS].sort(), [
    "GET /api/channels",
    "GET /api/channels/events",
    "GET /api/market/catalog",
    "GET /api/market/installed",
    "GET /api/market/repos",
    "GET /api/market/skills",
    "GET /api/office/history",
    "GET /api/office/templates",
    "GET /api/pty",
    "GET /api/ssh/hosts",
    "GET /api/ssh/hosts/recoveries",
    "HEAD /api/wallpapers/global",
  ]);
  assert.equal(httpFailureDiagnostic({
    method: "GET",
    pathname: "/api/pty",
    status: 501,
    payload: { code: "REMOTE_GATE_BLOCKED" },
  }), null);
  assert.match(httpFailureDiagnostic({
    method: "GET",
    pathname: "/api/pty",
    status: 501,
    payload: { code: "REMOTE_GATE_NOT_IMPLEMENTED" },
  }), /REMOTE_GATE_NOT_IMPLEMENTED/);
  assert.match(httpFailureDiagnostic({
    method: "POST",
    pathname: "/api/pty",
    status: 501,
    payload: { code: "REMOTE_GATE_BLOCKED" },
  }), /HTTP 501/);
  assert.match(httpFailureDiagnostic({ method: "GET", pathname: "/api/teams", status: 404 }), /HTTP 404/);
  assert.match(httpFailureDiagnostic({ method: "GET", pathname: "/api/teams", status: 422 }), /HTTP 422/);
  assert.match(httpFailureDiagnostic({ method: "GET", pathname: "/api/teams", status: 500 }), /HTTP 500/);
  assert.equal(httpFailureDiagnostic({ method: "GET", pathname: "/api/teams", status: 200 }), null);
});

test("team QA classifies only owned latest-wins GET aborts as expected browser diagnostics", () => {
  assert.equal(isAllowedRequestAbort({
    method: "GET",
    pathname: "/api/workbench/environment",
    errorText: "net::ERR_ABORTED",
  }), true);
  assert.equal(isAllowedRequestAbort({
    method: "GET",
    pathname: "/api/runs/run-1/mission",
    errorText: "net::ERR_ABORTED",
  }), true);
  assert.equal(isAllowedRequestAbort({
    method: "GET",
    pathname: "/api/runs/run-1/diff",
    errorText: "net::ERR_ABORTED",
  }), true);
  assert.equal(isAllowedRequestAbort({
    method: "POST",
    pathname: "/api/workbench/environment",
    errorText: "net::ERR_ABORTED",
  }), false);
  assert.equal(isAllowedRequestAbort({
    method: "POST",
    pathname: "/api/runs/run-1/diff",
    errorText: "net::ERR_ABORTED",
  }), false);
  assert.equal(isAllowedRequestAbort({
    method: "GET",
    pathname: "/api/workbench/environment",
    errorText: "net::ERR_FAILED",
  }), false);
});

test("team QA recursive cleanup guard only accepts its own temp prefix", () => {
  const safe = join(tmpdir(), "514cc-team-qa-unit-root");
  assert.equal(assertDisposableQaRoot(safe), resolve(safe));
  assert.throws(() => assertDisposableQaRoot(tmpdir()), /refusing to remove/);
  assert.throws(() => assertDisposableQaRoot(join(tmpdir(), "other-suite")), /refusing to remove/);
  assert.throws(() => assertDisposableQaRoot(resolve(tmpdir(), "..", "514cc-team-qa-escape")), /refusing to remove/);
});

test("team QA removes its temp root when initialization fails after creation", async () => {
  let qaRoot = null;
  await assert.rejects(
    withDisposableQaRoot(async (createdRoot) => {
      qaRoot = createdRoot;
      await mkdir(join(createdRoot, "partial-init"), { recursive: true });
      throw new Error("injected initialization failure");
    }),
    /injected initialization failure/,
  );
  assert.ok(qaRoot);
  await assert.rejects(access(qaRoot), (error) => error?.code === "ENOENT");
});

test("team QA preserves falsy rejection reasons while still removing its temp root", async () => {
  let qaRoot = null;
  let rejected = false;
  try {
    await withDisposableQaRoot(async (createdRoot) => {
      qaRoot = createdRoot;
      throw null;
    });
  } catch (error) {
    rejected = true;
    assert.equal(error, null);
  }
  assert.equal(rejected, true);
  assert.ok(qaRoot);
  await assert.rejects(access(qaRoot), (error) => error?.code === "ENOENT");
});

test("team QA final drain captures HTTP failures that arrive after an earlier settle", async () => {
  const listeners = new Map();
  const diagnostics = [];
  const allowedGateBlocks = [];
  const watcher = diagnosticsWatcher(diagnostics, allowedGateBlocks);
  watcher.watchPage({ on(event, listener) { listeners.set(event, listener); } }, "late");
  await watcher.settle();

  let releasePayload;
  const payload = new Promise((resolvePayload) => { releasePayload = resolvePayload; });
  listeners.get("response")({
    status: () => 500,
    request: () => ({ method: () => "GET" }),
    url: () => "http://127.0.0.1:54321/api/late",
    json: () => payload,
  });
  const finalDrain = watcher.settle();
  releasePayload({ code: "LATE_FAILURE" });
  await finalDrain;

  assert.deepEqual(diagnostics, ["late http: GET /api/late -> HTTP 500 (LATE_FAILURE)"]);
  assert.deepEqual(allowedGateBlocks, []);
});
