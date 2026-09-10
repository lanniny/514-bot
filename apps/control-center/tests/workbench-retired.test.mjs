import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NAV_ITEMS, navViews } from "../public/modules/nav-config.js";
import { retireWorkbenchView, isRetiredWorkbenchHash } from "../public/modules/bot-workspace-chrome.js";
import { readBotWorkspaceRoute, botWorkspaceRoute } from "../public/modules/bot-workspace-route.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("workbench is retired as a navigable primary surface and remaps onto Bot", async () => {
  const [html, app, css] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/bot-grok-face.css`, "utf8"),
  ]);

  assert.equal(retireWorkbenchView("workbench"), "bot");
  assert.equal(retireWorkbenchView("experience"), "bot");
  assert.equal(retireWorkbenchView("config"), "config");
  assert.equal(isRetiredWorkbenchHash("#workbench"), true);
  assert.equal(isRetiredWorkbenchHash("#/workbench?conversation=c"), true);
  assert.equal(isRetiredWorkbenchHash("#bot"), false);
  assert.deepEqual(
    readBotWorkspaceRoute("#workbench?conversation=c-1&run=r-1&tab=process"),
    { conversationId: "c-1", runId: "r-1", tab: "process" },
  );
  assert.equal(
    botWorkspaceRoute(readBotWorkspaceRoute("#workbench?conversation=c-1&run=r-1")),
    "#bot?conversation=c-1&run=r-1",
  );

  assert.ok(!navViews().includes("workbench"));
  assert.ok(!Object.hasOwn(NAV_ITEMS, "workbench"));
  assert.match(html, /id="view-workbench"[^>]+hidden/);
  assert.doesNotMatch(html, /data-view-jump="workbench"/);
  assert.doesNotMatch(html, /data-workspace-view="workbench"/);
  assert.match(html, /data-view-jump="bot"/);
  assert.match(html, /id="bot-active-runs"/);
  assert.match(html, /bot-roster-scroll/);
  assert.match(app, /function handleBotHomeTerminalToggle\(/);
  assert.match(app, /expanded: botActiveRunsExpanded/);
  assert.match(html, /id="bot-composer-recipient"/);
  assert.match(html, /id="bot-composer-team"/);
  assert.match(html, /id="bot-next-model"/);
  assert.match(html, /id="bot-next-effort"/);
  assert.match(html, /id="bot-settings-workspace"/);
  assert.match(html, /id="bot-pet-settings-host"/);
  assert.match(html, /option value="review"/);
  assert.match(app, /if \(view === "experience" \|\| view === "workbench"\) view = "bot"/);
  assert.match(app, /function syncBotComposerControls\(/);
  assert.match(app, /function renderBotActiveRuns\(/);
  assert.match(app, /function ensureViewTerminal\(/);
  assert.match(app, /function openBotForRun\(/);
  assert.match(app, /mountBotPetSettings/);
  assert.doesNotMatch(app, /setView\("workbench"/);
  assert.doesNotMatch(css, /@media \(max-width: (?!560px|820px)\d+px\)/);
});
