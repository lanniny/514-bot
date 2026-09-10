import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { folderNameFromPath, resolveWorkbenchPtySpawn, setWorkbenchCwdResolver } from "../public/modules/workbench-cwd.js";

const publicRoot = resolve(import.meta.dirname, "../public");

test("settings no longer owns a terminal view; workbench keeps two distinct terminals", async () => {
  const [html, app, railTools, chrome] = await Promise.all([
    readFile(resolve(publicRoot, "index.html"), "utf8"),
    readFile(resolve(publicRoot, "app.js"), "utf8"),
    readFile(resolve(publicRoot, "rail-tools.js"), "utf8"),
    readFile(resolve(publicRoot, "workbench-chrome.js"), "utf8"),
  ]);
  const settingsRail = html.slice(html.indexOf('id="settings-rail"'), html.indexOf("</aside>", html.indexOf('id="settings-rail"')));
  assert.doesNotMatch(settingsRail, /data-view="terminal"/);
  assert.doesNotMatch(html, /class="topnav-item"[^>]+data-view="terminal"/);
  assert.match(html, /id="terminal-drawer"/);
  assert.match(html, />底部终端</);
  assert.match(html, /data-tool-panel="terminal"/);
  assert.match(html, />侧栏终端</);
  assert.match(html, /打开\/收起底部终端（Ctrl\+`）/);
  assert.match(railTools, /shortcut: "Ctrl\+Alt\+T"/);
  assert.match(app, /function openBottomTerminal\(/);
  assert.match(app, /function openRailTerminal\(/);
  assert.match(app, /function activeWorkbenchCwd\(/);
  assert.match(app, /if \(!run && state\.pendingCwd\) return state\.pendingCwd;/);
  assert.match(app, /function focusWorkbenchProject\(/);
  assert.match(app, /if \(view === "terminal"\) \{\s*ensureViewTerminal\(\);/s);
  assert.match(chrome, /drawer\.classList\.add\("is-open"\)/);
  assert.match(chrome, /forge:open-bottom-terminal/);
  assert.match(chrome, /requestAnimationFrame\(\(\) => requestAnimationFrame\(reveal\)\)/);
});

test("workbench cwd resolver prefers an explicit project path", () => {
  assert.equal(folderNameFromPath("I:\\514claude\\wai\\client"), "client");
  setWorkbenchCwdResolver(() => ({ cwd: "I:/514claude/wai", title: "wai" }));
  assert.deepEqual(resolveWorkbenchPtySpawn(), { cwd: "I:/514claude/wai", title: "wai" });
  setWorkbenchCwdResolver(() => ({}));
  assert.deepEqual(resolveWorkbenchPtySpawn(), {});
});
