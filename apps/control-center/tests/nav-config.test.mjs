import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NAV_GROUPS, NAV_ITEMS, navViews, renderNavigation } from "../public/modules/nav-config.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("nav-config covers every setView-able chrome view exactly once across groups", () => {
  const views = navViews();
  assert.equal(new Set(views).size, views.length, "views must not repeat across groups");
  for (const view of views) {
    const item = NAV_ITEMS[view];
    assert.ok(item, `${view} missing from NAV_ITEMS`);
    assert.ok(item.icon.startsWith("lucide-") === false, "icon id must be bare lucide symbol name");
    assert.ok(item.label && item.short && item.tooltip, `${view} missing label/short/tooltip`);
  }
  // 历史漂移修复：协作台/配置此前只在部分导航出现
  for (const mustHave of ["bot", "workbench", "team", "channels", "bootstrapper", "office", "overview", "observability", "sessions", "market", "hosts", "config"]) {
    assert.ok(views.includes(mustHave), `unified nav must include ${mustHave}`);
  }
});

test("renderNavigation fills all three surfaces with the same unified view order", () => {
  const mounts = {
    '[data-nav-surface="primary"]': { innerHTML: "" },
    '[data-nav-surface="topbar"]': { innerHTML: "" },
    '[data-nav-surface="mobile"]': { innerHTML: "" },
  };
  const doc = { querySelector: (sel) => mounts[sel] ?? null };
  const rendered = renderNavigation({ doc });
  assert.ok(rendered.primary.includes("nav-group-label"), "primary nav renders groups");
  assert.ok(rendered.topbar.includes("topnav-divider"), "topbar nav separates groups");
  for (const mount of Object.values(mounts)) {
    assert.match(mount.innerHTML, /data-view="workbench"/);
    assert.match(mount.innerHTML, /data-view="config"/);
    assert.match(mount.innerHTML, /#lucide-messages-square/);
  }
  const dataViews = (html) => [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(dataViews(mounts['[data-nav-surface="topbar"]'].innerHTML), navViews());
  assert.deepEqual(dataViews(mounts['[data-nav-surface="mobile"]'].innerHTML), navViews());
});

test("index.html keeps exactly the three empty nav mounts and app.js renders before first setView", async () => {
  const [html, app] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
  ]);
  assert.equal(html.match(/data-nav-surface="/g)?.length, 3, "exactly three nav mounts");
  assert.doesNotMatch(html, /class="topnav-item"/, "topbar buttons must come from nav-config, not static markup");
  assert.doesNotMatch(html, /class="mobile-nav-item"/, "mobile buttons must come from nav-config, not static markup");
  assert.match(app, /renderNavigation\(\)/);
  assert.ok(
    app.indexOf("renderNavigation()") < app.indexOf("const initialRoute = parseForgeRoute()"),
    "nav must render before initial route resolution applies is-active",
  );
});
