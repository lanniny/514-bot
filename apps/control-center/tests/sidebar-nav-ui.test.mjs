/**
 * Global navigation owns product pages; settings owns configuration destinations.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

const SETTINGS_NAV_VIEWS = [
  "appearance",
  "browser",
  "security",
];

test("settings navigation has unique configuration destinations without duplicating product navigation", async () => {
  const html = await readFile(`${appRoot}/public/index.html`, "utf8");
  const rail = html.match(/<aside class="settings-rail" id="settings-rail"[\s\S]*?<\/aside>/);
  assert.ok(rail, "找不到 #settings-rail");
  assert.match(rail[0], /id="settings-rail-query"/);
  assert.match(rail[0], /搜索设置/);
  for (const view of SETTINGS_NAV_VIEWS) {
    assert.match(rail[0], new RegExp(`data-view="${view}"`), `设置侧栏缺 ${view}`);
  }
  assert.doesNotMatch(rail[0], /data-view="hero"/, "协作星图已并入团队页，设置侧栏不再单列");
  assert.doesNotMatch(rail[0], /data-view="router"|模型路由/, "模型路由已并入团队页，设置侧栏不再单列");
  assert.deepEqual([...rail[0].matchAll(/data-view="([^"]+)"/g)].map(match => match[1]).sort(), [...SETTINGS_NAV_VIEWS].sort());
  for (const surface of ["sources", "providers", "capabilities", "hooks", "local-runtime"]) {
    assert.equal((html.match(new RegExp(`data-config-surface="${surface}"`, "g")) || []).length, 1);
    assert.match(rail[0], new RegExp(`data-config-surface="${surface}"`));
  }
  // 2026-09-09 侧栏迁移 IA：设置轨允许「配置中心」分组 label（设置目的地与迁移应用导航
  // 分区）；迁移来的产品导航全部走动态挂载（data-nav-surface="settings"，静态 HTML 为空），
  // 因此上面的 data-view 全集断言依然只命中静态设置目的地。
  assert.match(rail[0], /settings-rail-label">配置中心/, "设置轨缺少配置中心分组 label");
  assert.match(rail[0], /data-nav-surface="settings"/, "设置轨缺少迁移导航动态挂载点");
  assert.doesNotMatch(rail[0], /settings-rail-back|data-config-surface-jump/);
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

test("workbench keeps its own rail; global navigation is persistent on desktop and a drawer on mobile", async () => {
  // The shared shell supersedes the old all-size drawer. Preserve legacy styles
  // while the product shell owns desktop columns and mobile accessibility.
  const [html, app, css, settingsRailChrome] = await Promise.all([
    readFile(`${appRoot}/public/index.html`, "utf8"),
    readFile(`${appRoot}/public/app.js`, "utf8"),
    readFile(`${appRoot}/public/forge/experience-polish.css`, "utf8"),
    readFile(`${appRoot}/public/modules/settings-rail-chrome.js`, "utf8"),
  ]);

  // 头像快捷设置入口已移除（Bot 左下角 / 运行控制台 rail 底部 / 会话头 chip）：
  // 设置唯一入口收敛到左侧栏配置（nav-config 的 config 项），此处断言三处不再存在。
  assert.match(html, /id="run-rail"/);
  assert.match(html, /id="rail-statusline"/);
  assert.doesNotMatch(html, /id="account-dock"/);
  assert.doesNotMatch(html, /id="account-dock-label"/);
  assert.doesNotMatch(html, /id="account-heading-chip"/);
  assert.doesNotMatch(html, /id="bot-account-button"/);
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
  const { createSettingsRailChrome } = await import("../public/modules/settings-rail-chrome.js");
  const chrome = createSettingsRailChrome({ state: {} });
  for (const view of ["config", "appearance", "browser", "security"]) assert.equal(chrome.isSettingsChrome(view), true);
  for (const view of ["bot", "workbench", "automations", "plugins", "office", "sessions"]) assert.equal(chrome.isSettingsChrome(view), false);
  assert.match(settingsRailChrome, /function openSettings\(/);
  assert.match(settingsRailChrome, /function syncSettingsRailActive\(/);
  assert.match(app, /function applyThemePreference\(/);
  // 头像快捷入口删除后，app.js 不再直调 settings 开关（入口收敛到侧栏配置轨）
  assert.doesNotMatch(app, /openSettings\("appearance"\)/);
  assert.doesNotMatch(app, /openAccountSettings/);
  assert.match(css, /\.account-dock-copy/);
});
