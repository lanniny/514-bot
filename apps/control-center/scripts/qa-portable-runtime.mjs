import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fingerprintTree } from "./build-portable.mjs";
import { scrub } from "../src/redaction.mjs";

const execFileAsync = promisify(execFile);
const bundle = resolve(process.argv.find((arg) => arg.startsWith("--bundle="))?.slice(9) || "");
const output = process.argv.find((arg) => arg.startsWith("--output="))?.slice(9);
if (!output || !process.argv.some((arg) => arg.startsWith("--bundle="))) throw new Error("--bundle and --output are required");
const root = await mkdtemp(resolve(tmpdir(), "514cc-portable-proof-"));
const home = resolve(root, "home");
await mkdir(home);
const token = randomBytes(24).toString("hex");
const env = {
  ...process.env, PATH: "", Path: "", CC_DATA_HOME: resolve(root, "state"),
  HOME: home, USERPROFILE: home, APPDATA: resolve(home, "AppData/Roaming"), LOCALAPPDATA: resolve(home, "AppData/Local"),
  CODEX_HOME: resolve(home, ".codex"), CLAUDE_CONFIG_DIR: resolve(home, ".claude"),
  XDG_CONFIG_HOME: resolve(home, ".config"), XDG_DATA_HOME: resolve(home, ".local/share"),
  CONTROL_CENTER_RUNTIME_HOME: home, CONTROL_CENTER_TEST_MODE: "1", CONTROL_CENTER_PORT: "0", CONTROL_CENTER_TOKEN: token,
  CONTROL_CENTER_SHUTDOWN_BUDGET_MS: "3500",
  GROK_SEARCH_RS_COMPAT_API_URL: "", GROK_SEARCH_RS_COMPAT_API_KEY: "", GROK_SEARCH_RS_COMPAT_MODEL: "",
};
delete env.CONTROL_CENTER_TEST_REPO_ROOT;
const report = { ok: false, boundary: "relocated portable runtime, isolated data/home, empty PATH, no GUI or real provider", checks: [] };
let child;
let origin;
const waitExit = (process, ms) => process.exitCode != null || process.signalCode != null ? Promise.resolve(true) : new Promise((done) => {
  const ended = () => { clearTimeout(timer); done(true); };
  const timer = setTimeout(() => { process.off("exit", ended); done(false); }, ms);
  process.once("exit", ended);
});
const api = async (path, method = "GET", body) => {
  const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${data.error?.code || ""}`);
  return data;
};
async function stop() {
  if (!child) return;
  await api("/api/test/shutdown", "POST", {});
  assert.equal(await waitExit(child, 10_000), true, "portable kernel must exit after authorized shutdown");
  assert.equal(child.exitCode, 0);
  child = null;
}
try {
  const before = await fingerprintTree(bundle);
  const info = async () => JSON.parse((await execFileAsync(resolve(bundle, "514 Bot.exe"), ["--runtime-info"], {
    cwd: root, env, windowsHide: true, timeout: 15_000,
  })).stdout);
  const layout = await info();
  assert.equal(layout.bundled, true);
  const bundlePath = await realpath(bundle);
  const nodeRelative = relative(bundlePath, await realpath(layout.node));
  const workspaceRelative = relative(bundlePath, await realpath(layout.workspaceRoot));
  assert.ok(!nodeRelative.startsWith("..") && !isAbsolute(nodeRelative));
  assert.ok(workspaceRelative.startsWith("..") || isAbsolute(workspaceRelative));
  report.checks.push("bundled executable resolves its own Node and independent writable workspace without PATH");
  const staleSchemaPath = resolve(layout.workspaceRoot, "schemas/control-center/contracts.schema.json");
  await mkdir(resolve(layout.workspaceRoot, "schemas/control-center"), { recursive: true });
  const staleSchema = JSON.stringify({ $defs: { routingPolicy: { not: {} } } });
  await writeFile(staleSchemaPath, staleSchema);
  async function start() {
    let stderr = "";
    child = spawn(layout.node, ["--experimental-sqlite", resolve(layout.kernelDir, "server.mjs")], {
      cwd: root, env: { ...env, CONTROL_CENTER_REPO_ROOT: layout.workspaceRoot, CONTROL_CENTER_DATA_DIR: layout.dataRoot, CC_ROOT: layout.workspaceRoot },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-8000); });
    origin = await new Promise((done, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error("portable kernel startup timed out")), 25_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); reject(new Error(`portable kernel exited before readiness (${code}): ${scrub(stderr).replaceAll(token, "[REDACTED]")}`)); });
      child.stdout.on("data", (chunk) => {
        text = (text + chunk.toString("utf8")).slice(-16000);
        const match = text.match(/514cc Control Center: (http:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); done(new URL(match[1]).origin); }
      });
    });
  }
  await start();
  await api("/api/bootstrap");
  const html = await fetch(origin + "/");
  assert.equal(html.status, 200);
  assert.ok((await html.text()).includes('id="view-bot"'));
  report.checks.push("bundled kernel serves the real Bot and bootstrap API from an unrelated cwd");
  const source = await api("/api/config/control.routing");
  const content = JSON.stringify({ ...JSON.parse(source.content), requireHealthyProvider: false }, null, 2);
  const validation = await api("/api/config/control.routing/validate", "POST", { content });
  assert.equal(validation.valid, true, validation.errors?.join("; ") || "portable routing validation failed");
  assert.equal(validation.parser, "node-jsonschema");
  const rejected = await api("/api/config/control.routing/validate", "POST", { content: JSON.stringify({ ...JSON.parse(content), maxRounds: "invalid" }) });
  assert.equal(rejected.valid, false);
  assert.equal(await readFile(staleSchemaPath, "utf8"), staleSchema);
  report.checks.push("current packaged contract accepts valid edits and rejects invalid edits despite a stale user schema, without rewriting it");
  const plan = await api("/api/config/control.routing/plan", "POST", { content, baseSha256: source.sha256 });
  await api("/api/config/control.routing/apply", "POST", { content, baseSha256: source.sha256, planId: plan.planId, confirmation: "control.routing" });
  assert.equal(JSON.parse((await api("/api/config/control.routing")).content).requireHealthyProvider, false);
  const projectRoot = resolve(root, "project");
  await mkdir(projectRoot);
  const project = (await api("/api/projects", "POST", { cwd: projectRoot, title: "Portable persistence verification" })).project;
  report.checks.push("core configuration validates and commits without Python; project state persists outside resources");
  await stop();
  await info();
  await start();
  assert.equal(JSON.parse((await api("/api/config/control.routing")).content).requireHealthyProvider, false);
  assert.ok((await api("/api/projects")).projects.some((item) => item.projectId === project.projectId));
  report.checks.push("restart preserves committed configuration and projects instead of overwriting them with seed defaults");
  await stop();
  assert.deepEqual(await fingerprintTree(bundle), before);
  report.checks.push("every packaged resource hash is unchanged after both runtime generations");
  report.ok = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (child) { child.kill(); if (!await waitExit(child, 1500)) { child.kill("SIGKILL"); await waitExit(child, 1500); } }
  await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
