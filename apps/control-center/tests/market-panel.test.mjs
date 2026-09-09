/**
 * 插件设置面契约：居中管理台、真实计数、不假装有插件目录或开关即启用。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("plugin settings page is a centered manager, not a left-aligned empty note", async () => {
  const [html, panel, css, state] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/market-panel.js`, "utf8"),
    readFile(`${appRoot}/public/forge/experience-polish.css`, "utf8"),
    readFile(`${appRoot}/public/state.js`, "utf8"),
  ]);
  assert.match(html, /id="view-market"[^>]+data-view-panel="market"/);
  assert.match(html, /id="market-title">插件</);
  assert.match(state, /market: "插件"/);
  assert.match(panel, /class="settings-card market-shell"/);
  assert.match(panel, /tabButton\(id, label, tally\[id\]\)/);
  assert.match(panel, /class="market-row/);
  assert.match(panel, /data-mcp-remove/);
  assert.match(panel, /data-mcp-apps/);
  assert.match(panel, /data-skill-apps/);
  assert.match(panel, /data-kind-filter/);
  assert.match(panel, /data-row-toggle/);
  assert.match(panel, /repos-scan-all/);
  assert.match(panel, /data-market-composer="repo"/);
  assert.match(panel, /let refreshGeneration = 0;/);
  assert.match(panel, /if \(generation !== refreshGeneration\) return;/);
  assert.match(panel, /let mcpSearchGeneration = 0;/);
  assert.match(panel, /if \(generation !== mcpSearchGeneration\) return;/);
  assert.doesNotMatch(panel, /浏览目录|开启内置浏览器控制|skills\.sh 商店/);
  assert.match(css, /#view-market \{/);
  assert.match(css, /#view-market \.page-heading/);
  assert.match(css, /\.market-row \{/);
  assert.match(css, /\.market-row-detail \{/);
  assert.match(css, /\.market-kind-filters \{/);

  // M1-M4: MCP & Skill settings overhaul assertions
  assert.match(html, /data-config-surface-jump="capabilities"/, "HTML header bridges to capabilities matrix");
  assert.match(panel, /data-config-surface-jump="capabilities"/, "Market panel provides reciprocal bridge");
  assert.match(panel, /class="[^"]*market-app-pill/, "CLI targets use rich brand pills");
  assert.match(panel, /class="[^"]*market-review-card/, "Pre-install review renders structured audit card");
  assert.match(css, /\.market-app-pill/, "CSS provides styling for CLI brand pills");
  assert.match(css, /\.waveg-review\.market-review-card/, "CSS elevates pre-install review card");
  assert.match(css, /1320px/, "Market container expanded from cramped 800px");
});
