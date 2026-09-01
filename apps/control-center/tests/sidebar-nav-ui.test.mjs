/**
 * 侧栏契约：协作台不放左侧入口；所有入口在设置侧栏，并有返回协作台。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

const SETTINGS_NAV_VIEWS = [
  "workbench",
  "appearance",
  "browser",
  "team",
  "channels",
  "bootstrapper",
  "office",
  "overview",
  "observability",
  "sessions",
  "market",
  "hosts",
  "config",
  "security",
];

test("settings rail owns every entry and a return to workbench", async () => {
  const html = await readFile(`${appRoot}/public/index.html`, "utf8");
  const rail = html.match(/<aside class="settings-rail" id="settings-rail"[\s\S]*?<\/aside>/);
  assert.ok(rail, "找不到 #settings-rail");
  assert.match(rail[0], /settings-rail-back[^>]+data-view="workbench"/);
  assert.match(rail[0], />返回协作台</);
  assert.match(rail[0], /id="settings-rail-query"/);
  assert.match(rail[0], /搜索设置/);
  for (const view of SETTINGS_NAV_VIEWS) {
    assert.match(rail[0], new RegExp(`data-view="${view}"`), `设置侧栏缺 ${view}`);
  }
  assert.doesNotMatch(rail[0], /data-view="hero"/, "协作星图已并入团队页，设置侧栏不再单列");
  assert.doesNotMatch(rail[0], /data-view="router"|模型路由/, "模型路由已并入团队页，设置侧栏不再单列");
  // 2026-08-30 IA 对齐：设置轨分组与主导航 NAV_GROUPS 同 taxonomy（观测/资源/治理），
  // 自动化升为设置轨「治理」条目；「插件/市场」同目的地只留一个名字。
  assert.match(rail[0], /data-view="automations"/, "治理组应有自动化入口");
  assert.match(rail[0], />基础设置</);
  assert.match(rail[0], />协作</);
  assert.match(rail[0], />创建</);
  assert.match(rail[0], />观测</);
  assert.match(rail[0], />资源</);
  assert.match(rail[0], />治理</);
  assert.match(rail[0], />Agent 能力</);
  assert.doesNotMatch(rail[0], />数据与统计</);
  assert.doesNotMatch(rail[0], />进阶</);
  assert.doesNotMatch(rail[0], />插件</, "插件与市场同目的地，只保留「市场」一个名字");
  assert.match(rail[0], /data-config-surface-jump="sources"/);
  assert.match(rail[0], /data-config-surface-jump="capabilities"[^>]+data-cap-workspace="skills"/);
  assert.match(rail[0], /data-config-surface-jump="capabilities"[^>]+data-cap-workspace="mcp"/);
  assert.match(rail[0], /data-config-surface-jump="hooks"/);
  assert.match(rail[0], /data-settings-focus="memory"/);
  assert.match(rail[0], />团队协作</);
  assert.doesNotMatch(rail[0], /命令文件|\.md 命令|索引库|Browser Use|开启内置浏览器控制/);
});

test("appearance and browser settings pages stay honest", async () => {
  const [html, app, css] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/experience-polish.css`, "utf8"),
  ]);
  assert.match(html, /id="view-appearance"[^>]+data-view-panel="appearance"/);
  assert.match(html, /id="appearance-theme-grid"[^>]+role="radiogroup"/);
  assert.match(html, /data-appearance-theme="system"/);
  assert.match(html, /id="appearance-font-size"/);
  assert.match(html, /id="appearance-accent-grid"/);
  const accentGrid = html.slice(html.indexOf('id="appearance-accent-grid"'), html.indexOf("</div>", html.indexOf('id="appearance-accent-grid"')));
  assert.doesNotMatch(accentGrid, /style=/);
  assert.match(css, /data-appearance-accent="copper"/);
  assert.match(html, /id="appearance-ui-face"[^>]+role="radiogroup"/);
  assert.match(html, /id="appearance-density"/);
  assert.match(html, /id="appearance-code-face"[^>]+role="radiogroup"/);
  // 字体 WYSIWYG：CSP style-src 'self' 禁内联 style，预览字体由 experience-polish.css 的
  // data-appearance-*-face 属性规则承担（两个栅格都禁 style 属性）
  const uiFaceGrid = html.slice(html.indexOf('id="appearance-ui-face"'), html.indexOf("</div>", html.indexOf('id="appearance-ui-face"')));
  const codeFaceGrid = html.slice(html.indexOf('id="appearance-code-face"'), html.indexOf("</div>", html.indexOf('id="appearance-code-face"')));
  assert.doesNotMatch(uiFaceGrid, /style=/, "字体预览栅格不得内联 style（CSP 拦截）");
  assert.doesNotMatch(codeFaceGrid, /style=/, "字体预览栅格不得内联 style（CSP 拦截）");
  assert.match(css, /\[data-appearance-ui-face="yahei"\][\s\S]*?font-family:/, "yahei 预览字体必须有 CSS 属性规则");
  assert.match(css, /\[data-appearance-code-face="jetbrains"\][\s\S]*?font-family:/, "jetbrains 预览字体必须有 CSS 属性规则");
  assert.doesNotMatch(html, /<select[^>]*appearance-(ui|code)-face/);
  assert.match(html, /id="appearance-code-wrap"/);
  assert.match(html, /id="appearance-code-lines"/);
  assert.match(html, /id="appearance-preview-light"/);
  assert.match(html, /着色跟随界面主题，没有独立的 GitHub 主题包/);
  assert.doesNotMatch(html, /亮色代码主题|深色代码主题|GitHub Light/);
  assert.match(app, /function applyCodeWrap\(/);
  assert.match(app, /function syncCodeGutters\(/);
  assert.match(app, /function clearLegacyTextTokens\(/);
  assert.match(app, /setProperty\("--ui-font-size"/);
  assert.doesNotMatch(app, /setProperty\("--text-sm"/);
  assert.match(html, /id="view-browser"[^>]+data-view-panel="browser"/);
  assert.match(html, /id="settings-open-browser"/);
  assert.match(html, /不是独立插件，也没有单独的缓存清理接口/);
  assert.doesNotMatch(html, /清除内置浏览器缓存|清除全部浏览器数据/);
});

test("workbench keeps its own rail; global nav rides the burger drawer at every size", async () => {
  // 2026-08-30 PM 走查决策：旧契约「协作台不放左侧入口」把汉堡/抽屉全域休眠，
  // 14 视图在桌面端只剩 Ctrl+K 一个全局入口（settings 视图才有设置轨）——最大
  // 可用性缺陷。新契约：协作台保留自身 run-rail；全局导航走汉堡抽屉（全尺寸可见，
  // nav-open 时滑出）+ 视图菜单；bot 表面维持无 chrome（bot-shell.css 单独全隐）。
  const [html, app, css, settingsRailChrome] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/experience-polish.css`, "utf8"),
    readFile(`${appRoot}/public/modules/settings-rail-chrome.js`, "utf8"),
  ]);

  assert.match(html, /id="run-rail"[\s\S]*id="account-dock"[\s\S]*id="account-dock-label"/);
  assert.match(html, /id="account-heading-chip"/);
  assert.match(html, /id="api-connection-badge"/);
  // 抽屉默认收起（仅 nav-open 滑出），而不是无条件 display:none——否则汉堡按了也没反应
  assert.match(css, /body\.atelier \.app-shell:not\(\.nav-open\) #sidebar/);
  assert.match(css, /body\.atelier \.app-shell:not\(\.nav-open\) \.sidebar/);
  // 汉堡不得再进隐藏名单（它是全局导航抽屉的唯一触发钮）
  assert.doesNotMatch(css, /\.topbar \.mobile-menu-button,[\s\S]{0,80}display: none !important/);
  assert.doesNotMatch(css, /\.topbar \.mobile-menu-button \{[\s\S]{0,40}display: none/);
  // 底栏 tab 维持隐藏（桌面形态不引入移动底栏）
  assert.match(css, /\.mobile-nav,/);
  assert.match(css, /\.settings-rail-back \{/);
  assert.match(css, /\.settings-rail-item > span \{/);
  assert.match(css, /white-space: nowrap/);
  assert.match(css, /\.page-heading\.compact-heading h1 \{/);
  assert.match(css, /#view-appearance,\s*#view-browser,\s*#view-market \{/);
  assert.match(css, /align-items: center;/);
  assert.match(css, /margin-left: auto;\s*margin-right: auto;/);
  assert.match(css, /\.app-shell\.is-settings \.main-content/);
  assert.match(css, /border-radius: 12px 0 0 0/);
  assert.match(css, /"topbar topbar"/);
  assert.match(settingsRailChrome, /function filterSettingsRail\(/);
  assert.match(settingsRailChrome, /function settingsRailHaystack\(/);
  assert.doesNotMatch(css, /\.page-heading > div:first-child \{[\s\S]{0,80}clip: rect/);
  assert.match(css, /html\[data-accent="rose"\]/);
  assert.match(css, /html\[data-density="compact"\]/);
  assert.match(css, /-webkit-appearance: none;/);
  assert.match(settingsRailChrome, /function isSettingsChrome\(/);
  assert.match(settingsRailChrome, /view !== "workbench" && view !== "automations"/);
  assert.match(settingsRailChrome, /function openSettings\(/);
  assert.match(settingsRailChrome, /function syncSettingsRailActive\(/);
  assert.match(app, /function applyThemePreference\(/);
  assert.match(app, /openSettings\("appearance"\)/);
  assert.match(app, /byId\("account-dock"\)\?\.addEventListener\("click", openAccountSettings\)/);
  assert.match(app, /byId\("account-heading-chip"\)\?\.addEventListener\("click", openAccountSettings\)/);
  assert.match(css, /\.account-dock-copy/);
});
