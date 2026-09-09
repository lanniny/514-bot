// 收敛层·第七轮契约：窗口框与 topbar 合一（LO 2026-08-17 供图 Codex 桌面红圈双横条处）
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

async function source(path) {
  // Windows 工作区源码行尾混杂：统一归一化为 LF（同第六轮契约）
  return (await readFile(`${root}/${path}`, "utf8")).replace(/\r\n/g, "\n");
}

function assertIncludes(source, snippet, message) {
  assert.ok(source.includes(snippet), message ?? `缺少：${snippet}`);
}

test("window controls sit at the end of topbar-actions, hidden by default (browser fallback)", async () => {
  const html = await source("public/index.html");
  const actions = html.slice(html.indexOf('<div class="topbar-actions">'), html.indexOf("</header>"));
  const mcToggle = actions.indexOf('id="global-mc-toggle"');
  const controls = actions.indexOf('<span class="window-controls" id="window-controls" hidden>');
  assert.ok(mcToggle > -1, "topbar-actions 缺少 global-mc-toggle");
  assert.ok(controls > mcToggle, "window-controls 必须位于 topbar-actions 末尾（MC 开关之后）且默认 hidden");
  for (const id of ["window-minimize", "window-maximize", "window-close"]) {
    assertIncludes(actions, `class="window-control-button${id === "window-close" ? " is-close" : ""}" id="${id}"`, `缺窗口钮：${id}`);
  }
  for (const icon of ["#lucide-minus", "#lucide-square", "#lucide-x"]) {
    assertIncludes(actions, icon, `窗口钮图标缺失：${icon}`);
  }
});

test("Bot default surface has its own hidden-by-default desktop window controls", async () => {
  const html = await source("public/index.html");
  const headerStart = html.indexOf('<header class="bot-conversation-header">');
  const headerEnd = html.indexOf("</header>", headerStart);
  assert.ok(headerStart > -1 && headerEnd > headerStart, "缺少 Bot 对话标题栏");
  const header = html.slice(headerStart, headerEnd);
  assertIncludes(header, '<span class="window-controls bot-window-controls" id="bot-window-controls" hidden', "Bot 标题栏缺少桌面窗口控件宿主");
  for (const [id, icon] of [["bot-window-minimize", "#lucide-minus"], ["bot-window-maximize", "#lucide-square"], ["bot-window-close", "#lucide-x"]]) {
    assertIncludes(header, `id="${id}"`, `Bot 窗口钮缺失：${id}`);
    assertIncludes(header, icon, `Bot 窗口钮图标缺失：${icon}`);
  }
});

test("new window-control ids are registered in the cacheElements list", async () => {
  const app = await source("public/app.js");
  const listStart = app.indexOf("function cacheElements()");
  const listEnd = app.indexOf("].forEach", listStart);
  const list = listEnd > -1 ? app.slice(listStart, listEnd) : app.slice(listStart, listStart + 12000);
  for (const id of ["window-controls", "window-minimize", "window-maximize", "window-close", "bot-window-controls", "bot-window-minimize", "bot-window-maximize", "bot-window-close"]) {
    assertIncludes(list, `"${id}"`, `cacheElements 未登记 ${id}（规则：新 id 必须登记）`);
  }
});

test("initializeWindowChrome guards on the Tauri bridge and wires desktop drag surfaces + window commands", async () => {
  const app = await source("public/app.js");
  const fn = await source("public/modules/desktop-window-chrome.js");
  const fnStart = app.indexOf("function initializeWindowChrome()");
  assert.ok(fnStart > -1, "缺少 initializeWindowChrome 定义");
  const wiring = app.slice(fnStart, app.indexOf("function replayAppearanceFromStorage", fnStart));
  assertIncludes(wiring, "mountDesktopWindowChrome");
  assertIncludes(wiring, "invoke: window.__TAURI_INTERNALS__?.invoke");
  assertIncludes(wiring, "enabled: desktopWindowChrome.active", "不将单字审批意外扩展至普通浏览器");
  assertIncludes(wiring, "getActiveRun: () => botConversationActiveRun(botActiveConversation())");
  assertIncludes(wiring, "resolveApproval: resolveInlineApproval");
  assertIncludes(fn, 'const enabled = typeof invoke === "function";');
  assertIncludes(fn, "if (!active) return controller;");
  assertIncludes(fn, 'document.documentElement.classList.add("is-desktop-shell");');
  assertIncludes(fn, "controls.hidden = false;");
  for (const cmd of ["plugin:window|minimize", "plugin:window|toggle_maximize", "plugin:window|close", "plugin:window|start_dragging"]) {
    assertIncludes(fn, `"${cmd}"`, `缺窗口命令：${cmd}`);
  }
  for (const id of ["bot-window-controls", "bot-window-minimize", "bot-window-maximize", "bot-window-close"]) {
    assertIncludes(fn, `"${id}"`, `Bot 窗口控件未接入初始化：${id}`);
  }
  assertIncludes(fn, 'event.detail === 2 ? "plugin:window|toggle_maximize" : "plugin:window|start_dragging"', "双击应 toggle_maximize，单击 start_dragging");
  assertIncludes(fn, "button, a, input, select, textarea, .topbar-nav, .topbar-actions", "拖拽命中必须放行交互元素");
  assertIncludes(fn, "document.querySelectorAll(dragSurfaces)", "拖拽面必须绑定到当前可见视图标题栏");
  assertIncludes(fn, 'listen(surface, "pointerdown"', "触屏/触笔拖拽保留 Pointer Events");
  assertIncludes(fn, 'listen(surface, "mousedown"', "鼠标双击必须读取真实 MouseEvent 点击次数");
  for (const selector of [".bot-roster-header", ".bot-conversation-header", ".bot-panel-header"]) {
    assertIncludes(fn, selector, `Bot 拖拽面缺失：${selector}`);
  }
  // 启动序列：紧跟 initializeTheme 之后调用
  const boot = app.slice(app.indexOf("initializeTheme();"), app.indexOf("initializeTheme();") + 240);
  assertIncludes(boot, "initializeWindowChrome();", "启动序列未调用 initializeWindowChrome");
  // 不依赖 data-tauri-drag-region（壳内注入脚本的子元素命中判定随版本漂移，本轮改手动语义）
  const codeOnly = fn.replace(/\/\/[^\n]*/g, "");
  assert.ok(!codeOnly.includes("data-tauri-drag-region"), "代码层不得回退到 data-tauri-drag-region（注释提及不计）");
  const html = await source("public/index.html");
  assert.ok(!html.includes("data-tauri-drag-region"), "标记层不得使用 data-tauri-drag-region 属性");
  // 壳内无地址栏/刷新键：Ctrl+R 整页重载（登录态在 sessionStorage，reload 安全；探针实证）
  assertIncludes(fn, 'listen(window, "keydown", (event) => {', "缺壳内 Ctrl+R 热重载监听");
  assertIncludes(fn, 'String(event.key).toLowerCase() !== "r"', "Ctrl+R 键位判定缺失");
  assertIncludes(wiring, "reload: () => location.reload()", "Ctrl+R 必须落到 location.reload()");
});

test("desktop shell styles: slim topbar + visible controls only under is-desktop-shell", async () => {
  const css = await source("public/forge/console-form.css");
  const wave = css.slice(css.indexOf("控制台形态 · 第七轮"));
  assertIncludes(wave, ".is-desktop-shell {\n  --topbar-height: 44px;\n}");
  assertIncludes(wave, ".window-controls[hidden] {\n  display: none;\n}", "hidden 必须压过 flex 显示（作者样式覆盖 UA）");
  assertIncludes(wave, ".window-control-button.is-close:hover {");
  assertIncludes(wave, "var(--rose-bright)", "关闭钮 hover 应为既有 --rose 族 token，不新造颜色");
  assertIncludes(wave, ".is-desktop-shell .topbar {\n  user-select: none;\n}");
});

test("window plugin permissions are granted to the loopback main window", async () => {
  // 窗口权限独立成 window-chrome.json：ccswitch-native 的权限集与 invoke handler
  // 由 Rust 回归锁死精确相等（native.rs remote_native_capability_is_exact…），
  // core:window 平台权限进去会炸精确匹配——分离后两边都不动。
  const caps = JSON.parse(await readFile(fileURLToPath(new URL("../../desktop/src-tauri/capabilities/window-chrome.json", import.meta.url)), "utf8"));
  const perms = new Set(caps.permissions);
  for (const perm of [
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-start-dragging",
    "core:window:allow-is-maximized",
  ]) {
    assert.ok(perms.has(perm), `capabilities 缺权限：${perm}`);
  }
  assert.deepEqual(caps.windows, ["main"]);
});

test("tauri window is built without native decorations", async () => {
  const main = await source("../desktop/src-tauri/src/main.rs");
  const builder = main.slice(main.indexOf("WebviewWindowBuilder::new("), main.indexOf(".build();", main.indexOf("WebviewWindowBuilder::new(")));
  assertIncludes(builder, ".decorations(false)", "窗口构建缺少 .decorations(false)（标题栏合一的前提）");
  const order = builder.indexOf(".decorations(false)") > builder.indexOf('.title("514 Forge · Control Center")');
  assert.ok(order, ".decorations(false) 应位于 builder 链内");
});

test("wave-7 window-control icons exist in the lucide manifest", async () => {
  const manifest = JSON.parse(await source("public/lucide-icons.json"));
  const names = new Set((manifest.icons ?? []).map((icon) => icon.name ?? icon));
  for (const icon of ["minus", "square", "x"]) {
    assert.ok(names.has(icon), `lucide manifest 缺少 ${icon}`);
  }
});
