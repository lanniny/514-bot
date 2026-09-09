#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const runnerPath = fileURLToPath(new URL("./qa-ui.mjs", import.meta.url));
const VALID_SUITES = new Set(["layout", "workbench", "history", "delta", "mission", "all"]);
const TOKEN = "qa-ui-fixture-token-0123456789abcdef";

export function parseQaUiFixtureArgs(argv = []) {
  let suite = "all";
  let outputDir = resolve(tmpdir(), `514cc-qa-ui-artifacts-${Date.now()}-${process.pid}`);
  for (const argument of argv) {
    if (argument.startsWith("--suite=")) {
      suite = argument.slice("--suite=".length);
      continue;
    }
    if (argument.startsWith("--output-dir=")) {
      const value = argument.slice("--output-dir=".length).trim();
      if (!value) throw new Error("--output-dir requires a path");
      outputDir = isAbsolute(value) ? resolve(value) : resolve(appRoot, value);
      continue;
    }
    throw new Error(`unknown QA fixture option: ${argument}`);
  }
  if (!VALID_SUITES.has(suite)) {
    throw new Error(`unknown QA suite: ${suite}; expected ${[...VALID_SUITES].join("|")}`);
  }
  return { suite, outputDir };
}

export async function writeConfig(repoRoot, { profiles = testModelProfiles().map((profile) => ({ ...profile, capabilities: ["*"] })) } = {}) {
  await mkdir(resolve(repoRoot, "config", "control-center"), { recursive: true });
  await writeFile(resolve(repoRoot, "config", "app.json"), '{"enabled":true}\n');
  await writeFile(resolve(repoRoot, "config", "control-center", "models.json"), `${JSON.stringify({
    version: 1,
    profiles,
  }, null, 2)}\n`);
  await writeFile(resolve(repoRoot, "config", "control-center", "routing.json"), `${JSON.stringify({
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
  await writeFile(resolve(repoRoot, "config", "control-center", "permissions.json"), `${JSON.stringify({
    version: 1,
    defaultMode: "plan",
    modes: {
      plan: { write: false, approvalRequired: false },
      build: { write: "workspace", approvalRequired: true },
    },
    limits: { maxRounds: 8, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 30_000, turnIdleTimeoutMs: 10_000 },
    approval: { ttlMs: 60_000 },
  }, null, 2)}\n`);
  await writeFile(resolve(repoRoot, "config", "control-center", "sources.json"), `${JSON.stringify({
    version: 1,
    explicit: [
      { id: "control.models", path: "config/control-center/models.json", label: "models", kind: "json", scope: "repo", critical: true },
      { id: "control.routing", path: "config/control-center/routing.json", label: "routing", kind: "json", scope: "repo", critical: true },
      { id: "control.permissions", path: "config/control-center/permissions.json", label: "permissions", kind: "json", scope: "repo", critical: true },
      { id: "control.sources", path: "config/control-center/sources.json", label: "sources", kind: "json", scope: "repo", critical: true },
    ],
    discover: [],
    runtime: [],
  }, null, 2)}\n`);
}

function runQaUi(url, { suite, outputDir }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [runnerPath, url, outputDir, `--suite=${suite}`], {
      cwd: appRoot,
      env: { ...process.env, CONTROL_CENTER_TEST_MODE: "1" },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (signal) rejectRun(new Error(`qa-ui runner terminated by ${signal}`));
      else resolveRun(code ?? 1);
    });
  });
}

export async function runQaUiFixture(options) {
  const root = await mkdtemp(join(tmpdir(), "514cc-qa-ui-"));
  const repoRoot = resolve(root, "repo");
  const dataRoot = resolve(root, "data");
  const runtimeHome = resolve(root, "home");
  await writeConfig(repoRoot);
  await mkdir(runtimeHome, { recursive: true });
  await mkdir(options.outputDir, { recursive: true });
  process.stdout.write(`qa-ui fixture output: ${options.outputDir}\n`);
  const server = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: TOKEN,
      CONTROL_CENTER_TEST_REPO_ROOT: repoRoot,
      CONTROL_CENTER_DATA_DIR: dataRoot,
      CONTROL_CENTER_RUNTIME_HOME: runtimeHome,
      CONTROL_CENTER_PORT: "0",
      HOME: runtimeHome,
      USERPROFILE: runtimeHome,
    },
  });
  let failure = null;
  let exitCode = 1;
  try {
    const url = await waitForUrl(server);
    exitCode = await runQaUi(url, options);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await stopTestServer(server, { token: TOKEN });
    } catch (error) {
      failure ||= error;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }).catch((error) => {
      failure ||= error;
    });
  }
  if (failure) throw failure;
  return exitCode;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseQaUiFixtureArgs(argv);
  return runQaUiFixture(options);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`qa-ui fixture failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
