import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NAV_ITEMS } from "../public/modules/nav-config.js";
import { VIEW_TITLES } from "../public/state.js";
import {
  BOT_SETTINGS_TABS,
  CONFIG_SURFACE_ITEMS,
  PALETTE_COVERAGE_MINIMUM,
  REQUIRED_BOT_PALETTE_ACTIONS,
  listPaletteViewItems,
  listStaticPaletteCatalog,
} from "../public/modules/palette-catalog.js";
import { listBuiltInPaletteItems } from "../public/command-palette.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("static palette catalog covers nav views, settings tabs, config surfaces, and bot actions", () => {
  const catalog = listStaticPaletteCatalog();
  const ids = new Set(catalog.map((item) => item.id));
  const views = listPaletteViewItems();
  const viewIds = new Set(views.map((item) => item.id));

  for (const view of Object.keys(NAV_ITEMS)) {
    assert.ok(viewIds.has(view), `missing nav view ${view}`);
  }
  for (const view of Object.keys(VIEW_TITLES)) {
    assert.ok(viewIds.has(view), `missing titled view ${view}`);
  }
  for (const tab of BOT_SETTINGS_TABS) {
    assert.ok(ids.has(`bot-settings:${tab.id}`), `missing settings tab ${tab.id}`);
  }
  for (const surface of CONFIG_SURFACE_ITEMS) {
    assert.ok(ids.has(`config-surface:${surface.id}`), `missing config surface ${surface.id}`);
  }
  for (const action of REQUIRED_BOT_PALETTE_ACTIONS) {
    assert.ok(ids.has(action), `missing bot action ${action}`);
  }
  assert.ok(catalog.length >= PALETTE_COVERAGE_MINIMUM, `catalog size ${catalog.length} < ${PALETTE_COVERAGE_MINIMUM}`);
});

test("built-in palette items stay above the coverage bar and keep Ctrl/Cmd+K wiring", async () => {
  const items = listBuiltInPaletteItems();
  const ids = new Set(items.map((item) => item.id));
  assert.ok(items.length >= PALETTE_COVERAGE_MINIMUM + 8, `built-in palette only indexed ${items.length} items`);
  assert.ok(ids.has("bot"));
  assert.ok(ids.has("workbench"));
  assert.ok(ids.has("channels"));
  assert.ok(ids.has("bot:create-routine"));
  assert.ok(ids.has("bot:private-skills"));
  assert.ok(ids.has("bot:kickoff-help"));
  assert.ok(ids.has("bot:product-tour"));
  assert.ok(ids.has("bot:capability-map"));
  assert.ok(ids.has("refresh"));

  const [palette, app, html] = await Promise.all([
    readFile(`${appRoot}/public/command-palette.js`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/index.html`, "utf8"),
  ]);
  assert.match(palette, /ctrlKey \|\| e\.metaKey/);
  assert.match(palette, /listPaletteViewItems\(\)/);
  assert.match(app, /handleCatalogPaletteAction\(actionId\)/);
  assert.match(app, /case "bot:create-routine"/);
  assert.match(app, /case "bot:kickoff-help"/);
  assert.match(app, /case "bot:product-tour"/);
  assert.match(app, /case "bot:capability-map"/);
  assert.match(html, /id="command-palette-trigger"/);
});

test("settings and config palette ids stay aligned with live registries", async () => {
  const [html, app] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
  ]);
  for (const tab of BOT_SETTINGS_TABS) {
    assert.match(html, new RegExp(`data-bot-settings-tab="${tab.id}"`));
  }
  const surfaceMatch = app.match(/const CONFIG_SURFACES = Object\.freeze\(\[([^\]]+)\]\)/);
  assert.ok(surfaceMatch, "CONFIG_SURFACES registry missing from app.js");
  const liveSurfaces = [...surfaceMatch[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
  assert.deepEqual(CONFIG_SURFACE_ITEMS.map((item) => item.id), liveSurfaces);
});
