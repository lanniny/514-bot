// 收敛层·第九轮契约：应用菜单列 + L 形 chrome 统一色 + 对话卡片立体浮起
//（LO 2026-08-17：补回 frameless 丢掉的菜单栏功能；左栏上栏统一色；对话区立体区分）
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

async function source(path) {
  return (await readFile(`${root}/${path}`, "utf8")).replace(/\r\n/g, "\n");
}

function assertIncludes(source, snippet, message) {
  assert.ok(source.includes(snippet), message ?? `缺少：${snippet}`);
}

test("chrome menu cluster sits in the topbar before the breadcrumb", async () => {
  const html = await source("public/index.html");
  const app = await source("public/app.js");
  const menus = html.indexOf('<div class="chrome-menus" id="chrome-menus">');
  const title = html.indexOf('<div class="topbar-title"');
  assert.ok(menus > -1 && title > -1 && menus < title, "chrome-menus 必须在 topbar-title 之前");
  for (const id of ["chrome-rail-toggle", "chrome-nav-back", "chrome-nav-forward", "chrome-menu-file", "chrome-menu-edit", "chrome-menu-view", "chrome-menu-help"]) {
    assertIncludes(html, `id="${id}"`, `缺菜单钮：${id}`);
  }
  for (const icon of ["#lucide-arrow-left", "#lucide-arrow-right"]) {
    assertIncludes(html, icon, `菜单列图标缺失：${icon}`);
  }
  assertIncludes(html, 'class="icon lucide chrome-rail-glyph"', "左栏开关必须使用 Lucide 双态图标");
  assertIncludes(html, '<use href="#lucide-panel-left"></use>', "左栏开关缺 Lucide panel-left 图标");
  assertIncludes(app, 'collapsed ? "#lucide-panel-right" : "#lucide-panel-left"', "左栏开关未随状态切换 Lucide 图标");
  for (const label of [">文件</button>", ">编辑</button>", ">视图</button>", ">帮助</button>"]) {
    assertIncludes(html, label, `缺文字菜单：${label}`);
  }
});

test("chrome ids are registered and menu icons exist in MENU_ICONS", async () => {
  const app = await source("public/app.js");
  const listStart = app.indexOf("function cacheElements()");
  const list = app.slice(listStart, listStart + 14000);
  for (const id of ["chrome-rail-toggle", "chrome-nav-back", "chrome-nav-forward", "chrome-menu-file", "chrome-menu-edit", "chrome-menu-view", "chrome-menu-help"]) {
    assertIncludes(list, `"${id}"`, `cacheElements 未登记 ${id}`);
  }
  const iconsBlock = app.slice(app.indexOf("const MENU_ICONS = {"), app.indexOf("const MENU_ICONS = {") + 4000);
  for (const key of ["undo:", "redo:", "cut:", "paste:", "selectAll:", "refresh:", "moon:", "zoomIn:", "zoomOut:", "terminal:", "panelLeft:", "panelRight:", "info:"]) {
    assertIncludes(iconsBlock, key, `MENU_ICONS 缺 ${key}`);
  }
});

test("initializeChromeMenus wires rail toggle, nav history, and four menus with honest actions", async () => {
  const app = await source("public/app.js");
  const fnStart = app.indexOf("function initializeChromeMenus()");
  assert.ok(fnStart > -1, "缺 initializeChromeMenus 定义");
  // 窗口须覆盖到帮助菜单（函数尾部）；视图导航条目加入后函数变长，定窗同步放大
  const fn = app.slice(fnStart, fnStart + 5600);
  assertIncludes(fn, 'bindMenu("chrome-menu-file"');
  assertIncludes(fn, 'bindMenu("chrome-menu-edit"');
  assertIncludes(fn, 'bindMenu("chrome-menu-view"');
  assertIncludes(fn, 'bindMenu("chrome-menu-help"');
  assertIncludes(fn, 'byId("new-task-row")?.click()', "文件菜单的新建任务必须复用既有入口");
  assertIncludes(fn, 'applyUiFontSize(14)', "视图菜单缺字号重置");
  assertIncludes(fn, "getVersion()", "帮助菜单的关于必须给真实版本");
  assertIncludes(fn, 'disabled: typeof invoke !== "function"', "关闭窗口在浏览器模式必须禁用（诚实降级）");
  assertIncludes(fn, 'chromeNavigate("back")');
  assertIncludes(fn, 'chromeNavigate("forward")');
  // PM 走查修复（2026-08-30）：「视图」菜单必须承载全局视图导航，且由 nav-config 单源驱动——
  // 此前 14 视图在桌面端只有 Ctrl+K 一个入口，名为「视图」的菜单里没有视图。
  assertIncludes(fn, "NAV_GROUPS.flatMap", "视图菜单缺 nav-config 驱动的视图导航");
  assertIncludes(fn, "action: () => setView(view)", "视图菜单项必须走 setView");
  // 启动序列：initializeWindowChrome 之后调用（菜单列浏览器/壳内共用，不锁壳）
  const boot = app.slice(app.indexOf("initializeWindowChrome();"), app.indexOf("initializeWindowChrome();") + 200);
  assertIncludes(boot, "initializeChromeMenus();", "启动序列未调用 initializeChromeMenus");
});

test("view navigation history records inside setView with mute suppression", async () => {
  const app = await source("public/app.js");
  const start = app.indexOf("function setView(view, {");
  const end = app.indexOf("\nfunction renderConfigTopology");
  assert.ok(start > -1 && end > start, "setView 找不到");
  const setViewFn = app.slice(start, end);
  assertIncludes(setViewFn, "const previousRoute = captureViewRoute();", "setView 必须在改 state 前拍快照");
  assertIncludes(setViewFn, "rememberRouteChange(previousRoute)", "setView 必须把上一站写入 ‹ › 栈");
  assertIncludes(app, 'from "./modules/view-history.js"', "历史栈逻辑必须抽到可测模块");
  const nav = app.slice(app.indexOf("function chromeNavigate"), app.indexOf("function chromeNavigate") + 900);
  assertIncludes(nav, "viewHistoryMute = true;", "前进/后退必须抑制历史回写（否则死循环）");
  assertIncludes(nav, "stepHistory(direction", "chromeNavigate 必须走纯函数双栈");
});

test("unified chrome color + floating conversation card styles", async () => {
  const css = await source("public/forge/console-form.css");
  const wave = css.slice(css.indexOf("控制台形态 · 第九轮"));
  // 上栏/工作台壳与 rail 统一实色（L 形 chrome）——experience-polish 已把 rail 压平为
  // 实色 var(--sidebar)，统一只能向实色对齐；磨砂透光会让三面永远比色不一致。
  assertIncludes(wave, "body.atelier .topbar {\n  background: var(--sidebar);");
  assertIncludes(wave, ".atelier .workbench-shell {\n  background: var(--sidebar);");
  // 卡片浮起：顶部缝 + 投影；右/下贴齐窗缘不留空；圆角只留左上签名角
  assertIncludes(wave, ".atelier .conversation-pane {\n  margin: 8px 0 0;\n  border-radius: 12px 0 0 0;");
  assertIncludes(wave, "box-shadow: 0 1px 2px rgba(59, 48, 38, 0.06), 0 10px 28px rgba(59, 48, 38, 0.10);");
  assertIncludes(wave, '[data-theme="dark"] .atelier .conversation-pane {');
  assertIncludes(wave, "#chrome-nav-back.is-fired .icon {");
  assertIncludes(wave, "#chrome-rail-toggle.is-fired .chrome-rail-glyph {");
  assertIncludes(wave, "@keyframes chrome-rail-pulse {");
  assertIncludes(wave, "@keyframes chrome-nav-nudge-left {");
  assertIncludes(wave, "@media (prefers-reduced-motion: reduce) {");
  // rail 收起：抽屉式收轨，会话框顶到窗缘不留缝
  // UI-AUDIT P1-5：时长已收敛到 --dur-base（原 280ms），自定义缓动曲线作为品牌手感保留
  assertIncludes(wave, "transition: grid-template-columns var(--dur-base) cubic-bezier(0.32, 0.72, 0, 1);");
  assertIncludes(wave, ".workbench-shell.rail-collapsed {\n  grid-template-columns: 0px minmax(0, 1fr) !important;\n}");
  assertIncludes(wave, ".workbench-shell.rail-collapsed .conversation-pane {\n  margin-left: 0;\n  border-top-left-radius: 0;\n}");
  assertIncludes(wave, "@media (min-width: 821px) {");
  assertIncludes(wave, "justify-self: end;");
  assertIncludes(css, "@media (max-width: 560px) {");
  assertIncludes(css, ".topbar-brand,\n  .chrome-menus,");
  assertIncludes(css, ".topbar-actions #global-mc-toggle {");
  assertIncludes(css, ".topbar-actions {\n    flex: 0 0 auto;\n    overflow: hidden;");
});

test("wave-9 icons exist in the lucide manifest", async () => {
  const manifest = JSON.parse(await source("public/lucide-icons.json"));
  const names = new Set((manifest.icons ?? []).map((icon) => icon.name ?? icon));
  for (const icon of ["panel-left", "arrow-left", "arrow-right"]) {
    assert.ok(names.has(icon), `lucide manifest 缺少 ${icon}`);
  }
});
