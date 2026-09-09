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
  // UI-AUDIT P0-5：自动化与安全诊断提级入主导航，不再做"隐形视图"
  for (const mustHave of ["bot", "workbench", "team", "channels", "bootstrapper", "office", "overview", "observability", "sessions", "market", "hosts", "config", "automations", "security"]) {
    assert.ok(views.includes(mustHave), `unified nav must include ${mustHave}`);
  }
});

test("renderNavigation fills all four surfaces with the same unified view order", () => {
  const mounts = {
    '[data-nav-surface="primary"]': { innerHTML: "" },
    '[data-nav-surface="topbar"]': { innerHTML: "" },
    '[data-nav-surface="mobile"]': { innerHTML: "" },
    '[data-nav-surface="settings"]': { innerHTML: "" },
  };
  const doc = { querySelector: (sel) => mounts[sel] ?? null };
  const rendered = renderNavigation({ doc });
  assert.ok(rendered.primary.includes("nav-group-label"), "primary nav renders groups");
  assert.ok(rendered.topbar.includes("topnav-divider"), "topbar nav separates groups");
  assert.ok(rendered.settings.includes("settings-rail-item"), "settings rail renders migrated nav items");
  for (const mount of Object.values(mounts)) {
    assert.match(mount.innerHTML, /data-view="workbench"/);
    assert.match(mount.innerHTML, /data-view="config"/);
    assert.match(mount.innerHTML, /#lucide-messages-square/);
  }
  const dataViews = (html) => [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(dataViews(mounts['[data-nav-surface="topbar"]'].innerHTML), navViews());
  assert.deepEqual(dataViews(mounts['[data-nav-surface="mobile"]'].innerHTML), navViews());
  assert.deepEqual(dataViews(mounts['[data-nav-surface="settings"]'].innerHTML), navViews());
});

test("index.html keeps exactly the four empty nav mounts and app.js renders before first setView", async () => {
  const [html, app] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
  ]);
  // 2026-09-09 侧栏迁移：第四个挂载面 = 设置轨内的迁移导航（data-nav-surface="settings"）
  assert.equal(html.match(/data-nav-surface="/g)?.length, 4, "exactly four nav mounts");
  assert.doesNotMatch(html, /class="topnav-item"/, "topbar buttons must come from nav-config, not static markup");
  assert.doesNotMatch(html, /class="mobile-nav-item"/, "mobile buttons must come from nav-config, not static markup");
  assert.match(app, /renderNavigation\(\)/);
  assert.ok(
    app.indexOf("renderNavigation()") < app.indexOf("const initialRoute = parseForgeRoute(startupHash)"),
    "nav must render before initial route resolution applies is-active",
  );
});
