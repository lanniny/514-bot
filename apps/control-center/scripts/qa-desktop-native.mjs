import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { fingerprintTree } from "./build-portable.mjs";
import { assertPortableQaInputs, isTcpPortClosed } from "./desktop-qa-safety.mjs";
import { scrub } from "../src/redaction.mjs";

const execFileAsync = promisify(execFile);
const bundleArg = process.argv.find((arg) => arg.startsWith("--bundle="))?.slice(9);
const outputArg = process.argv.find((arg) => arg.startsWith("--output-dir="))?.slice(13);
if (process.platform !== "win32" || !bundleArg || !outputArg) throw new Error("Windows, --bundle and --output-dir are required");
const bundle = resolve(bundleArg);
const executable = resolve(bundle, "514 Bot.exe");
const outputDir = resolve(outputArg);
const root = await mkdtemp(resolve(tmpdir(), "514cc-native-proof-"));
const home = resolve(root, "home");
const token = randomBytes(24).toString("hex");
// Whitelist OS inputs; never inherit provider credentials, runtime overrides or a real home.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|windir|ComSpec|OS|PROCESSOR_ARCHITECTURE)$/i.test(key)));
Object.assign(env, {
  PATH: "", HOME: home, USERPROFILE: home, TEMP: root, TMP: root,
  APPDATA: resolve(home, "AppData/Roaming"), LOCALAPPDATA: resolve(home, "AppData/Local"),
  CODEX_HOME: resolve(home, ".codex"), CLAUDE_CONFIG_DIR: resolve(home, ".claude"),
  XDG_CONFIG_HOME: resolve(home, ".config"), XDG_DATA_HOME: resolve(home, ".local/share"),
  CC_DATA_HOME: resolve(root, "state"), CONTROL_CENTER_RUNTIME_HOME: home,
  CC_ROOT: resolve(root, "no-development-fallback"), CONTROL_CENTER_DATA_DIR: resolve(root, "state/data"),
  CONTROL_CENTER_TEST_MODE: "1", CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_OPEN: "0",
  CONTROL_CENTER_SHUTDOWN_BUDGET_MS: "3500", WEBVIEW2_USER_DATA_FOLDER: resolve(root, "webview"),
});
const report = { ok: false, boundary: "isolated compiled application identity, real Windows WebView2 and IPC; no formal instance or real provider", checks: [], pageErrors: [] };
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (child) => child && child.exitCode == null && child.signalCode == null;
async function waitUntil(probe, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await probe();
    if (value) return value;
    await delay(150);
  }
  throw new Error(`timed out: ${label}`);
}
async function listen(server) {
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return server.address().port;
}
const check = (name) => { report.checks.push(name); process.stdout.write(`PASS ${name}\n`); };
let child;
let browser;
let deniedServer;
let origin;
let cdpPort;
let cleanupOk = true;
try {
  await mkdir(outputDir, { recursive: true });
  for (const dir of [home, env.APPDATA, env.LOCALAPPDATA]) await mkdir(dir, { recursive: true });
  await assertPortableQaInputs(bundle);
  const application = JSON.parse((await execFileAsync(executable, ["--application-info"], { cwd: root, env, windowsHide: true, timeout: 15_000 })).stdout);
  assert.match(application.identifier, /^cc\.p514\.console\.qa\.[a-z0-9-]+$/, "refusing to launch a formal desktop identity");
  report.application = application;
  const resources = await fingerprintTree(bundle);
  const layout = JSON.parse((await execFileAsync(executable, ["--runtime-info"], { cwd: root, env, windowsHide: true, timeout: 15_000 })).stdout);
  assert.equal(layout.bundled, true);
  assert.equal(resolve(layout.workspaceRoot), resolve(env.CC_DATA_HOME, "workspace"));
  const modelsPath = resolve(layout.workspaceRoot, "config/control-center/models.json");
  const models = JSON.parse(await readFile(modelsPath, "utf8"));
  for (const profile of models.profiles) if (profile.command) profile.command = resolve(root, "unavailable-cli.exe");
  await writeFile(modelsPath, JSON.stringify(models));
  const portReservation = createNetServer();
  cdpPort = await listen(portReservation);
  await new Promise((done) => portReservation.close(done));
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1`;
  let processError;
  child = spawn(executable, [], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", (error) => { processError = error; });
  child.stdout.resume();
  child.stderr.resume();
  report.desktopPid = child.pid;
  const endpoint = `http://127.0.0.1:${cdpPort}`;
  await waitUntil(async () => {
    if (processError) throw processError;
    if (!alive(child)) throw new Error("isolated desktop exited before WebView readiness");
    return fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok).catch(() => false);
  }, "WebView2 CDP", 60_000);
  browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
  const page = await waitUntil(() => browser.contexts().flatMap((context) => context.pages()).find((p) => /^http:\/\/127\.0\.0\.1:\d+\//.test(p.url())), "native main WebView", 60_000);
  page.on("pageerror", (error) => report.pageErrors.push(scrub(error.message).replaceAll(token, "[REDACTED]")));
  await page.waitForSelector("#view-bot.is-active #bot-composer-input", { timeout: 30_000 });
  await page.waitForSelector("#api-connection-badge.is-ok", { timeout: 30_000 });
  origin = new URL(page.url()).origin;
  report.kernelOrigin = origin;
  const invoke = (command) => page.evaluate(async (name) => {
    const bridge = globalThis.__TAURI_INTERNALS__;
    if (typeof bridge?.invoke !== "function") throw new Error("real native bridge is absent");
    return bridge.invoke(name);
  }, command);
  const capabilities = await invoke("get_native_capabilities");
  assert.equal(capabilities.portableMode, true);
  assert.equal(capabilities.updater.enabled, false);
  assert.equal(await invoke("is_portable_mode"), true);
  assert.equal(await invoke("is_lightweight_mode"), false);
  assert.equal(typeof await invoke("plugin:window|is_maximized"), "boolean");
  report.capabilities = capabilities;
  check("real main WebView bootstraps Bot and executes the three native reads plus the window getter");
  assert.equal(await page.locator("#window-controls").isVisible(), true);
  assert.equal(await page.locator("#bot-window-controls").isVisible(), false);
  const maximized = await invoke("plugin:window|is_maximized");
  await page.locator("#window-maximize").click();
  await waitUntil(async () => (await invoke("plugin:window|is_maximized")) !== maximized, "maximize button");
  await page.locator("#window-maximize").click();
  await waitUntil(async () => (await invoke("plugin:window|is_maximized")) === maximized, "restore button");
  await page.screenshot({ path: resolve(outputDir, "native-bot.png") });
  report.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth }));
  assert.equal(report.viewport.overflow, false);
  assert.deepEqual(report.pageErrors, []);
  check("one global window-control set maximizes and restores Bot without duplicate conversation controls or horizontal overflow");
  await page.evaluate(() => {
    globalThis.__qaDragEvents = [];
    for (const type of ["pointerdown", "mousedown", "dblclick"]) document.addEventListener(type, (event) => {
      globalThis.__qaDragEvents.push({ type, detail: event.detail, prevented: event.defaultPrevented, target: event.target.tagName, role: event.target.getAttribute("role") });
      if (globalThis.__qaDragEvents.length > 20) globalThis.__qaDragEvents.shift();
    });
  });
  const header = page.locator(".topbar-title");
  const headerBounds = await header.boundingBox();
  await header.dblclick({ position: { x: Math.round(headerBounds.width * 0.6), y: Math.round(headerBounds.height / 2) } });
  try {
    await waitUntil(async () => (await invoke("plugin:window|is_maximized")) !== maximized, "native title bar double click");
  } catch (error) {
    report.dragEvents = await page.evaluate(() => globalThis.__qaDragEvents);
    throw error;
  }
  await page.locator("#window-maximize").click();
  await waitUntil(async () => (await invoke("plugin:window|is_maximized")) === maximized, "restore after title bar double click");
  check("real mouse double click on the title bar toggles the native maximized state");
  await Promise.all([page.waitForEvent("load"), page.keyboard.press("Control+r")]);
  await page.waitForSelector("#api-connection-badge.is-ok");
  assert.equal(await invoke("is_portable_mode"), true);
  check("desktop Ctrl+R reloads the authenticated work surface without requiring another bootstrap");
  // Inject only the native failure boundary; keep the real module and app toast handler.
  const modulePattern = /\/modules\/desktop-window-chrome\.js(?:\?.*)?$/;
  await page.route(modulePattern, (route) => {
    if (new URL(route.request().url()).searchParams.has("qa-original")) return route.continue();
    return route.fulfill({ contentType: "text/javascript", body: `
      import { mountDesktopWindowChrome as mount } from './desktop-window-chrome.js?qa-original=1';
      export function mountDesktopWindowChrome(options) {
        return mount({ ...options, invoke(command) {
          if (globalThis.__qaWindowFailure && command === 'plugin:window|minimize') {
            if (globalThis.__qaWindowFailure === 'sync') throw new Error('injected native rejection');
            return Promise.reject(new Error('injected native rejection'));
          }
          return options.invoke(command);
        }});
      }` });
  });
  await page.reload();
  await page.waitForSelector("#api-connection-badge.is-ok");
  for (const mode of ["sync", "async"]) {
    await page.evaluate((value) => { globalThis.__qaWindowFailure = value; document.querySelectorAll(".toast").forEach((item) => item.remove()); }, mode);
    await page.locator("#window-minimize").click();
    await page.locator(".toast.is-error").filter({ hasText: "\u7a97\u53e3\u64cd\u4f5c\u672a\u5b8c\u6210" }).waitFor();
  }
  await page.screenshot({ path: resolve(outputDir, "native-window-error.png") });
  await page.unroute(modulePattern);
  await page.reload();
  await page.waitForSelector("#api-connection-badge.is-ok");
  assert.deepEqual(report.pageErrors, []);
  check("injected synchronous and asynchronous native rejections reach the real app error toast without an unhandled exception");
  deniedServer = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>Untrusted origin probe</title><main>Native ACL probe</main>"); });
  const deniedPort = await listen(deniedServer);
  await page.goto(`http://127.0.0.1:${deniedPort}/`, { waitUntil: "domcontentloaded" });
  for (const command of ["get_native_capabilities", "is_portable_mode", "plugin:window|is_maximized"]) {
    const result = await page.evaluate(async (name) => {
      if (typeof globalThis.__TAURI_INTERNALS__?.invoke !== "function") return { bridge: false };
      return Promise.race([
        globalThis.__TAURI_INTERNALS__.invoke(name).then(() => ({ allowed: true }), (error) => ({ allowed: false, error: String(error) })),
        new Promise((done) => setTimeout(() => done({ timeout: true }), 4000)),
      ]);
    }, command);
    assert.equal(result.allowed, false, `${command}: wrong origin must be rejected by IPC, not merely time out`);
    assert.match(result.error, /not allowed|denied|not found|not accessible/i);
  }
  check("the same real WebView rejects native and window IPC after navigating to an untrusted loopback port");
  await page.goto(`${origin}/#bot`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#view-bot.is-active #bot-composer-input");
  assert.equal(await invoke("is_portable_mode"), true);
  check("returning to the verified kernel origin restores normal access without a second bootstrap token");
  assert.deepEqual(await fingerprintTree(bundle), resources);
  check("desktop execution leaves every packaged resource unchanged");
  report.ok = true;
} catch (error) {
  report.error = scrub(error.message).replaceAll(token, "[REDACTED]");
  process.exitCode = 1;
} finally {
  // Only the child created above is eligible; never discover or kill a formal instance.
  if (alive(child)) {
    try {
      await execFileAsync(resolve(process.env.SystemRoot || "C:/Windows", "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 });
      await waitUntil(() => !alive(child), "owned desktop exit", 10_000);
    } catch (error) { cleanupOk = false; report.cleanupError = scrub(error.message); }
  }
  if (browser) await browser.close().catch(() => {});
  if (deniedServer) { deniedServer.closeAllConnections(); await new Promise((done) => deniedServer.close(done)); }
  for (const url of [origin, cdpPort && `http://127.0.0.1:${cdpPort}/json/version`].filter(Boolean)) {
    const gone = await waitUntil(() => isTcpPortClosed(Number(new URL(url).port)), "owned endpoint exit", 10_000).catch(() => false);
    if (!gone) cleanupOk = false;
  }
  report.cleanup = { ok: cleanupOk, desktopExited: !alive(child), scope: "spawned desktop tree and its kernel/CDP endpoints; not a global process-tree audit" };
  if (cleanupOk) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => { report.fixtureRetained = root; });
  else report.fixtureRetained = root;
  if (!cleanupOk) { report.ok = false; process.exitCode = 1; }
  await writeFile(resolve(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
