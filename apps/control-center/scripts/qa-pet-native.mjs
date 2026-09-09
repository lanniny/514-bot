import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { createDefaultControlConfig } from "../src/default-config.mjs";
import { isTcpPortClosed } from "./desktop-qa-safety.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const exec = promisify(execFile);
const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
if (process.platform !== "win32" || !arg("desktop-exe") || !arg("output-dir")) throw new Error("Windows, --desktop-exe and --output-dir required");
const executable = resolve(arg("desktop-exe"));
const outputDir = resolve(arg("output-dir"));
const root = await mkdtemp(resolve(tmpdir(), "514cc-pet-native-"));
const fixtureRoot = resolve(root, "workspace");
const fixtureApp = resolve(fixtureRoot, "apps/control-center");
const fixtureHome = resolve(root, "home");
const token = randomBytes(24).toString("hex");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|windir|ComSpec|OS|PROCESSOR_ARCHITECTURE)$/i.test(key)));
Object.assign(env, {
  PATH: "", HOME: fixtureHome, USERPROFILE: fixtureHome, APPDATA: resolve(fixtureHome, "AppData/Roaming"), LOCALAPPDATA: resolve(fixtureHome, "AppData/Local"),
  TEMP: root, TMP: root, CC_ROOT: fixtureRoot, CC_NODE: process.execPath,
  CONTROL_CENTER_DATA_DIR: resolve(root, "data"), CONTROL_CENTER_RUNTIME_HOME: fixtureHome,
  CONTROL_CENTER_TEST_MODE: "1", CONTROL_CENTER_OPEN: "0", CONTROL_CENTER_TOKEN: token,
  WEBVIEW2_USER_DATA_FOLDER: resolve(root, "webview"),
});
const report = { ok: false, boundary: "isolated QA application identity, real Windows WebView2, copied source and temporary data", checks: [], errors: [] };
const check = (text) => { report.checks.push(text); console.log(`PASS ${text}`); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(probe, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await delay(150); }
  throw new Error(`timed out: ${label}`);
}
let child, browser, origin, cdpPort;
const alive = () => child && child.exitCode == null && child.signalCode == null;
const powershell = resolve(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
async function windowState(action = "inspect") {
  return JSON.parse((await exec(powershell, ["-NoProfile", "-File", resolve(appRoot, "scripts/qa-pet-window.ps1"), "-OwnerPid", String(child.pid), "-Action", action], { windowsHide: true, timeout: 15000 })).stdout);
}
try {
  await mkdir(outputDir, { recursive: true });
  await mkdir(fixtureApp, { recursive: true });
  for (const dir of [fixtureHome, env.APPDATA, env.LOCALAPPDATA]) await mkdir(dir, { recursive: true });
  const application = JSON.parse((await exec(executable, ["--application-info"], { env, windowsHide: true, timeout: 15000 })).stdout);
  assert.match(application.identifier, /^cc\.p514\.console\.qa\./, "refuse a formal desktop identity");
  report.application = application;
  for (const name of ["src", "public", "scripts", "server.mjs", "package.json"]) await cp(resolve(appRoot, name), resolve(fixtureApp, name), { recursive: true });
  await symlink(resolve(appRoot, "node_modules"), resolve(fixtureApp, "node_modules"), "junction");
  await cp(resolve(appRoot, "../../schemas"), resolve(fixtureRoot, "schemas"), { recursive: true });
  for (const [name, text] of Object.entries(createDefaultControlConfig())) {
    const path = resolve(fixtureRoot, name);
    await mkdir(resolve(path, ".."), { recursive: true });
    if (name.endsWith("models.json")) {
      const config = JSON.parse(text);
      for (const profile of config.profiles) if (profile.command) profile.command = resolve(root, "unavailable-cli.exe");
      await writeFile(path, JSON.stringify(config));
    } else await writeFile(path, text);
  }
  const reservation = createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  cdpPort = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1`;
  child = spawn(executable, [], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume(); child.stderr.resume();
  await until(() => fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok).catch(() => false), "CDP", 60000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const main = await until(() => browser.contexts().flatMap((ctx) => ctx.pages()).find((page) => /^http:\/\/127\.0\.0\.1:/.test(page.url())), "main WebView");
  origin = new URL(main.url()).origin;
  await main.locator("#api-connection-badge.is-ok").waitFor({ timeout: 30000 });
  const api = async (path, method = "GET", body) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  const project = (await api("/api/projects", "POST", { cwd: fixtureRoot, title: "原生桌宠验证" })).project;
  let plugins = await api("/api/plugins");
  await api("/api/plugins/install", "POST", { catalogId: "desktop-pet", expectedRevision: plugins.revision });
  plugins = await api(`/api/plugins?projectId=${encodeURIComponent(project.projectId)}`);
  await api("/api/plugins/configure", "POST", { projectId: project.projectId, pluginId: "desktop-pet", enabled: true, config: {}, expectedRevision: plugins.revision });
  await main.reload({ waitUntil: "domcontentloaded" });
  await main.locator("#api-connection-badge.is-ok").waitFor({ timeout: 30000 });
  const petPage = () => browser.contexts().flatMap((ctx) => ctx.pages()).find((page) => new URL(page.url()).pathname === "/pet");
  let pet = await until(petPage, "pet WebView", 20000);
  await pet.locator('body[data-pet-state="ready"]').waitFor({ timeout: 30000 });
  report.initial = await windowState();
  assert.equal(report.initial.clickThrough, true);
  assert.equal(report.initial.topmost, true);
  check("settings create a real paired transparent topmost WebView without blocking IPC");
  const denied = await pet.evaluate(() => window.__TAURI_INTERNALS__.invoke("set_pet_overlay", { visible: false }).then(() => false, () => true));
  assert.equal(denied, true);
  check("pet WebView cannot call the main-only native overlay command");
  await main.evaluate(() => { location.hash = "#plugins"; });
  await main.locator("[data-plugin-project]").selectOption(project.projectId);
  await main.locator('[data-plugin-id="desktop-pet"]').getByRole("button", { name: "查看与配置", exact: true }).click();
  const drawer = main.locator("[data-drawer]");
  await drawer.locator('input[name="interactive"]').check();
  await Promise.all([
    main.waitForResponse((response) => response.url().endsWith("/api/plugins/configure") && response.request().method() === "POST"),
    drawer.getByRole("button", { name: "保存并应用", exact: true }).click(),
  ]);
  await pet.locator("#pet-toolbar").waitFor();
  const interactive = await until(async () => { const value = await windowState(); return !value.clickThrough && value; }, "interactive click-through disabled");
  const moved = await windowState("drag");
  assert.ok(Math.abs(moved.x - interactive.x) > 30 || Math.abs(moved.y - interactive.y) > 30, "physical drag must move native window");
  report.drag = { before: interactive, after: moved };
  await pet.waitForTimeout(250);
  await pet.screenshot({ path: resolve(outputDir, "native-pet.png"), omitBackground: true });
  check("interactive mode disables click-through and a real Windows mouse drag moves the window");
  await pet.getByRole("button", { name: "退出互动模式" }).click();
  await until(async () => (await windowState()).clickThrough, "restore click-through");
  await drawer.locator('input[name="enabled"]').uncheck();
  await drawer.locator('input[name="scale"]').fill("150");
  await drawer.locator('input[name="interactive"]').uncheck();
  await Promise.all([
    main.waitForResponse((response) => response.url().endsWith("/api/plugins/configure") && response.request().method() === "POST"),
    drawer.getByRole("button", { name: "保存并应用", exact: true }).click(),
  ]);
  await until(async () => !(await windowState()).exists, "window disposal");
  await drawer.locator('input[name="enabled"]').check();
  await Promise.all([
    main.waitForResponse((response) => response.url().endsWith("/api/plugins/configure") && response.request().method() === "POST"),
    drawer.getByRole("button", { name: "保存并应用", exact: true }).click(),
  ]);
  pet = await until(petPage, "reopened pet WebView");
  await pet.locator('body[data-pet-state="ready"]').waitFor({ timeout: 30000 });
  report.reopened = await until(async () => { const value = await windowState(); return value.width > report.initial.width * 1.4 && value; }, "current scale after native show");
  check("plugin configuration restores saved position and applies the current 150 percent setting");
  await windowState("close");
  await until(async () => !(await windowState()).exists, "system close");
  check("system close disposes the pet without changing the installed plugin package");
  report.ok = true;
} catch (error) {
  report.errors.push(String(error.message).replaceAll(token, "[REDACTED]"));
  process.exitCode = 1;
} finally {
  if (alive()) {
    await exec(resolve(process.env.SystemRoot, "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 15000 }).catch((error) => report.errors.push(`cleanup: ${error.code}`));
    await until(() => !alive(), "owned process exit", 10000).catch(() => {});
  }
  await browser?.close().catch(() => {});
  const closed = await Promise.all([origin && Number(new URL(origin).port), cdpPort].filter(Boolean).map((port) => until(() => isTcpPortClosed(port), "owned endpoint exit", 10000).catch(() => false)));
  report.cleanup = { exited: !alive(), endpointsClosed: closed.every(Boolean) };
  if (!report.cleanup.exited || !report.cleanup.endpointsClosed) { report.ok = false; process.exitCode = 1; }
  if (report.cleanup.exited && report.cleanup.endpointsClosed) await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  await writeFile(resolve(outputDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
