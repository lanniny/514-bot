import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { writeConfig } from "./qa-ui-fixture.mjs";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";
import { scrub } from "../src/redaction.mjs";

const outputDir = resolve(process.argv.find((arg) => arg.startsWith("--output-dir="))?.slice(13) || resolve(tmpdir(), `514cc-history-proof-${Date.now()}`));
const root = await mkdtemp(resolve(tmpdir(), "514cc-history-qa-"));
const repo = resolve(root, "repo");
const home = resolve(root, "home");
const data = resolve(root, "data");
const token = randomBytes(24).toString("hex");
await mkdir(home);
await mkdir(outputDir, { recursive: true });
await writeConfig(repo, { profiles: testModelProfiles().map((profile) => ({ ...profile, capabilities: ["*"], command: profile.command ? resolve(home, "unavailable-cli.exe") : null })) });
const env = Object.fromEntries(Object.keys(process.env).map((key) => [key, ""]));
Object.assign(env, Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|windir|ComSpec|OS|PROCESSOR_ARCHITECTURE)$/i.test(key))), {
  HOME: home, USERPROFILE: home, APPDATA: resolve(home, "AppData/Roaming"), LOCALAPPDATA: resolve(home, "AppData/Local"), TEMP: root, TMP: root,
  CONTROL_CENTER_REPO_ROOT: repo, CONTROL_CENTER_TEST_REPO_ROOT: repo, CONTROL_CENTER_DATA_DIR: data,
  CONTROL_CENTER_RUNTIME_HOME: home, CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_PORT: "0",
  NODE_OPTIONS: "--experimental-sqlite",
});
const server = spawnTestServer({ env });
let browser;
let page;
const report = { ok: false, boundary: "owned HTTP server and Chrome with isolated data/home and unavailable CLIs; no formal runtime", checks: [], pageErrors: [] };
const check = (value) => { report.checks.push(value); process.stdout.write(`PASS ${value}\n`); };
try {
  const origin = new URL(await waitForUrl(server)).origin;
  const api = async (path, method = "GET", body) => {
    const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    assert.equal(response.ok, true, `${method} ${path}: ${response.status}`);
    return response.json();
  };
  const conversation = (await api("/api/conversations", "POST", { kind: "direct", directMemberId: "codex-technical", title: "History navigation fixture" })).conversation;
  const route = `#bot?conversation=${conversation.id}&tab=process`;
  const modelsPath = resolve(repo, "config/control-center/models.json");
  const modelsBefore = await readFile(modelsPath, "utf8");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => report.pageErrors.push(scrub(error.message).replaceAll(token, "[REDACTED]")));
  await page.addInitScript((value) => sessionStorage.setItem("514cc-control-token", value), token);
  await page.goto(`${origin}/${route}`);
  await page.waitForSelector("#api-connection-badge.is-ok");
  await page.waitForSelector('#workspace-tab-process[aria-selected="true"]');
  await page.evaluate(() => { location.hash = "#config/hooks"; });
  await page.waitForSelector("#view-config.is-active");
  await page.evaluate((value) => { location.hash = value; }, route);
  await page.waitForSelector('#workspace-tab-process[aria-selected="true"]');
  const backLabel = await page.locator("#chrome-nav-back").getAttribute("aria-label");
  assert.equal(await page.locator("#chrome-nav-back").isEnabled(), true);
  await page.locator("#bot-member-seat-button").click();
  await page.waitForSelector("#bot-workspace-panel:not([hidden])");
  const surfaceAlpha = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    context.fillStyle = getComputedStyle(document.getElementById("bot-workspace-panel")).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3];
  });
  assert.equal(surfaceAlpha, 255, "workspace panel must not reveal the underlying Conversation text");
  await page.locator("#runtime-seat-new-button").click();
  await page.locator("#runtime-seat-label-input").fill("Unsaved history fixture");
  await page.locator("#chrome-nav-back").click();
  await page.waitForSelector("#action-dialog[open]");
  await page.screenshot({ path: resolve(outputDir, "history-confirmation.png") });
  await page.locator('#action-dialog .dialog-actions [value="cancel"]').click();
  await page.waitForSelector("#action-dialog", { state: "hidden" });
  await page.waitForFunction(() => !document.getElementById("chrome-nav-back").disabled);
  assert.equal(await page.locator("#bot-workspace-panel").isVisible(), true);
  assert.equal(await page.locator("#runtime-seat-label-input").inputValue(), "Unsaved history fixture");
  assert.equal(await page.locator("#chrome-nav-back").getAttribute("aria-label"), backLabel);
  assert.equal(await page.locator("#chrome-nav-forward").isEnabled(), false);
  check("cancelling Back preserves the seat draft and both navigation stacks");
  await page.locator("#chrome-nav-back").click();
  await page.waitForSelector("#action-dialog[open]");
  await page.locator("#dialog-confirm-button").click();
  await page.waitForSelector("#view-config.is-active");
  await page.waitForFunction(() => !document.getElementById("chrome-nav-forward").disabled);
  assert.equal(new URL(page.url()).hash, "#config/hooks");
  await page.locator("#chrome-nav-forward").click();
  await page.waitForSelector('#workspace-tab-process[aria-selected="true"]');
  await page.waitForFunction(() => document.getElementById("chrome-nav-forward").disabled && !document.getElementById("chrome-nav-back").disabled);
  assert.equal(new URL(page.url()).hash, route);
  assert.equal(await readFile(modelsPath, "utf8"), modelsBefore);
  check("confirmed Back and Forward retain the exact Bot route without saving the abandoned draft");
  await page.locator("#workspace-tab-results").click();
  assert.equal(await page.locator("#chrome-nav-forward").isEnabled(), false);
  for (const mode of ["", "plaintext-only"]) {
    const keyResult = await page.evaluate((value) => {
      const node = document.createElement("div"); node.setAttribute("contenteditable", value); node.textContent = "editable"; document.body.append(node);
      const child = document.createElement("span"); child.textContent = "inner"; node.append(child);
      const event = new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true });
      child.dispatchEvent(event); node.remove(); return event.defaultPrevented;
    }, mode);
    assert.equal(keyResult, false);
    assert.ok(new URL(page.url()).hash.endsWith("tab=results"));
  }
  check("empty and plaintext-only contenteditable regions are not intercepted by app navigation");
  const skill = (body, apps) => ({ name: "http-publication", files: { "SKILL.md": `# ${body}\n` }, apps });
  await api("/api/ccswitch/domain/skills", "POST", skill("old", { claude: true, codex: true }));
  await api("/api/ccswitch/domain/skills", "POST", skill("new", { codex: false }));
  assert.equal(await readFile(resolve(home, ".claude/skills/http-publication/SKILL.md"), "utf8"), "# new\n");
  await assert.rejects(readFile(resolve(home, ".codex/skills/http-publication/SKILL.md")), { code: "ENOENT" });
  check("real HTTP Skill updates publish to the isolated live home and remove only the explicitly disabled binding");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const dimensions = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth }));
    assert.equal(dimensions.width, width); assert.equal(dimensions.overflow, false);
    await page.screenshot({ path: resolve(outputDir, `history-${width}.png`) });
  }
  assert.deepEqual(report.pageErrors, []);
  report.ok = true;
} catch (error) {
  report.error = scrub(error.message).replaceAll(token, "[REDACTED]");
  await page?.screenshot({ path: resolve(outputDir, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  try { await stopTestServer(server, { token }); report.cleanExit = true; } catch (error) { report.cleanupError = scrub(error.message).replaceAll(token, "[REDACTED]"); report.ok = false; process.exitCode = 1; }
  if (report.cleanExit) await rm(root, { recursive: true, force: true });
  else report.fixtureRetained = root;
  await writeFile(resolve(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
