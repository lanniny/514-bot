/**
 * bot-rail-contract.test.mjs — 右栏 W2/W3/W4 改造的契约门禁。
 *
 * 覆盖三件彼此独立、单靠 QA 与单测都守不住的东西：
 *   W2 · 零信息态压缩（假显示器折叠、连接列表收敛、状态单出口）
 *   W3 · 分组（3 组存在、组标题是 h2、组 3 整组 direct-only）
 *   W4 · 令牌化与可达性（屏幕色值走令牌、role 诚实、live region 不嵌套、收栏归还焦点）
 *
 * 这些是**结构契约**：源码级断言能挡住"下一个人顺手改回去"，而运行时的观感由
 * `.scratch/measure-rail.mjs` 与 `qa-bot-grok-parity` 把守，两者互补。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

async function source(path) {
  return (await readFile(`${appRoot}/${path}`, "utf8")).replace(/\r\n/g, "\n");
}

/** 取 `<div class="bot-inspector-scroll">` 到其闭合之间的右栏 DOM 片段。 */
function railMarkup(html) {
  const start = html.indexOf('class="bot-inspector-scroll"');
  assert.ok(start > 0, "找不到 .bot-inspector-scroll —— 右栏结构被大改时本门禁必须变红");
  return html.slice(start, html.indexOf("</aside>", start));
}

test("W2 · 零信息态压缩的三条承诺", async () => {
  const [html, css, chrome] = await Promise.all([
    source("public/index.html"),
    source("public/forge/bot-shell.css"),
    source("public/modules/bot-workspace-chrome.js"),
  ]);

  // 假显示器在零信息态必须被折叠（不是靠 JS 藏，是 CSS 按 data-computer-state 关）
  assert.match(css, /\.bot-inspector-card\[data-computer-state="unprovisioned"\] \.bot-computer-screen/);
  // 状态必须读真源算出来的 data-computer-state，而不是写死常量
  assert.doesNotMatch(css, /\.bot-computer-screen[^}]*background: #2a2b2b/);
  // 连接列表：全未配置时收敛成一行（不再列 N 行同话）
  assert.match(chrome, /个席位均未配置主机/);
  // 状态单出口：会话卡不再有重复的「运行」行
  assert.doesNotMatch(html, /id="bot-inspector-run"/);
});

test("W3 · 三个人话分组与其结构约束", async () => {
  const html = await source("public/index.html");
  const rail = railMarkup(html);

  for (const [id, title] of [["now", "现在"], ["machine", "这台机器"], ["member", "这个成员"]]) {
    // 2026-09-11 W6：组标题升级为折叠开关（h2 内 button，W3C 手风琴形状），
    // 标题文字随之移进按钮里——断言跟着结构走，"组存在且可折叠"一起守。
    assert.match(
      rail,
      new RegExp(`id="bot-rail-group-${id}"[\\s\\S]{0,400}data-bot-rail-group="${id}"[\\s\\S]{0,200}>${title}<`),
      `缺少分组「${title}」`,
    );
    assert.match(rail, new RegExp(`id="bot-rail-group-${id}-body"`), `组 ${id} 缺少受控的 body 容器`);
  }
  // 组标题用 h2（卡标题是 h3）——层级正确
  assert.equal([...rail.matchAll(/<h2 class="bot-rail-group-title"/g)].length, 3);
  // 组 3 整组 data-bot-direct-only：群会话下整组隐藏，不留一个空标题
  assert.match(rail, /<section class="bot-rail-group" data-bot-direct-only aria-labelledby="bot-rail-group-member">/);
  // **只包不改 id**：这些锚点必须仍在（QA 与运行时都依赖）。
  // 注意 railMarkup 从 scroll 起切——页签条在 scroll 之前，页签 id 的唯一性在工具行测试里守。
  for (const id of ["bot-ops-inbox", "bot-ops-approvals", "bot-ops-files", "bot-ops-terminal", "bot-member-connections", "bot-collab-tabs", "bot-routine-list"]) {
    assert.equal([...rail.matchAll(new RegExp(`id="${id}"`, "g"))].length, 1, `${id} 必须仍唯一存在`);
  }
});

test("W6 · 组折叠：aria 状态、CSS 收起规则与持久化接线", async () => {
  const [html, css, app] = await Promise.all([
    source("public/index.html"),
    source("public/forge/bot-shell.css"),
    source("public/app.js"),
  ]);
  const rail = railMarkup(html);

  // 每个开关必须声明初始 aria 状态并指向受控的 body（aria-controls 与 body id 一一对应）
  for (const id of ["now", "machine", "member"]) {
    assert.match(
      rail,
      new RegExp(`data-bot-rail-group="${id}"[^>]*aria-expanded="true"[^>]*aria-controls="bot-rail-group-${id}-body"`),
      `组 ${id} 的折叠开关缺少 aria 状态/受控区域`,
    );
  }
  // CSS：折叠只收 body，标题保留——用户得能看到"下面还有什么"并展开回来
  assert.match(css, /\.bot-rail-group\[data-collapsed\] \.bot-rail-group-body \{ display: none; \}/);
  assert.match(css, /\.bot-rail-group\[data-collapsed\] \.bot-rail-group-chevron/);

  // JS 持久化：键 + 切换 + 读写都不得因 localStorage 被禁而抛
  assert.match(app, /BOT_RAIL_GROUPS_STORAGE_KEY = "514cc\.bot-rail-groups\.v1"/);
  assert.match(app, /function botToggleRailGroup/);
  assert.match(app, /group\.toggleAttribute\("data-collapsed"\)/);
  assert.match(app, /localStorage\.setItem\(BOT_RAIL_GROUPS_STORAGE_KEY/);
  const init = /function initBotShell\(\)[\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.ok(init, "找不到 initBotShell —— 改名时本门禁必须变红");
  assert.match(
    init,
    /applyBotRailGroupsStorage\(\);[\s\S]*renderBotOpsRail\(\);/,
    "折叠态必须在首次 rail 渲染前应用，否则首帧闪跳",
  );
});

test("W4 · 屏幕色值走令牌、role 诚实、live region 不嵌套", async () => {
  const [html, css, chrome, app] = await Promise.all([
    source("public/index.html"),
    source("public/forge/bot-shell.css"),
    source("public/modules/bot-workspace-chrome.js"),
    source("public/app.js"),
  ]);

  // 令牌化：屏幕一族不再有裸 hex，改为消费 --bot-screen-* 令牌。
  // 注意别用 indexOf(".bot-computer-screen {") 切片——多行选择器列表的**最后一行**
  // 也以它结尾，会切错位置（本文件初版就栽在这里）。用规则体的特征前缀精确匹配。
  for (const token of ["bg", "line", "ink", "muted", "dim"]) {
    assert.match(css, new RegExp(`--bot-screen-${token}: #[0-9a-fA-F]{6};`), `缺少令牌 --bot-screen-${token}`);
  }
  assert.match(css, /\.bot-computer-screen \{ display: block;[^}]*background: var\(--bot-screen-bg\)/);
  assert.match(css, /\.bot-computer-bar \{ display: flex;[^}]*color: var\(--bot-screen-ink\)/);
  assert.match(css, /\.bot-computer-bar i \{[^}]*background: var\(--bot-screen-line\)/);
  assert.match(css, /\.bot-computer-empty \{[^}]*color: var\(--bot-screen-ink\)/);
  assert.match(css, /\.bot-computer-empty \.icon \{[^}]*color: var\(--bot-screen-muted\)/);
  assert.match(css, /\.bot-computer-empty small \{[^}]*color: var\(--bot-screen-dim\)/);

  // role 诚实：这一条现在是**可关闭的页签条**（2026-09-12 W9）——挂了 tablist 就必须有键盘模型，
  // 页签本体是 div[role=tab]（关闭钮必须是真实 button，button 不能嵌 button）。
  assert.match(html, /class="bot-rail-tabs" id="bot-rail-page-tabs" role="tablist" aria-label="右栏页面"/);
  assert.doesNotMatch(html, /class="bot-rail-tabs"[^>]*role="toolbar"/);

  // live region 不嵌套：容器已是 aria-live，失败节点不再自带 role="status"
  assert.doesNotMatch(html, /id="bot-member-connections"[^>]*aria-live/);
  assert.doesNotMatch(chrome, /data-tone="error" role="status"/);

  // 收栏归还焦点：只在焦点确实在栏内时才归还（否则会从用户正在输入处抢走焦点）
  assert.match(app, /panel\.contains\(document\.activeElement\)/);
  assert.match(app, /if \(focusWasInside\) byId\("bot-agent-info-button"\)\?\.focus/);
});

test("S2 · 失败探测不永久固化（TTL 复探）", async () => {
  const app = await source("public/app.js");
  // error 探测必须带时间戳；没有它，TTL 判定没有锚点，`has()` 守卫照样把席位钉死在「失败」
  assert.match(app, /\{ status: "error", error: error\.message, at: Date\.now\(\) \}/);
  assert.match(app, /function shouldProbeConfigHost/);
  assert.match(app, /CONFIG_HOST_PROBE_RETRY_MS = 60_000/);
  // 三个调用点（bot rail 席位探测 + 配置页两处）都必须走 helper，不许退回裸 has()
  assert.doesNotMatch(app, /!state\.configHostProbes\.has\((?:state\.configHostId|project\.hostId|row\.hostId)\)/);
});

test("标签面板的显隐不得被渲染循环夺权", async () => {
  const [app, css] = await Promise.all([source("public/app.js"), source("public/forge/bot-shell.css")]);

  // renderBotOpsRail 每次渲染都跑（按键 / 30s 心跳 / 每轮对话），
  // 若它按 pending 数量写隐藏，就会出现：点开「审批」标签 → 敲一个字 → 面板凭空变空。
  // 这是 2026-09-11 改标签形态时真实引入过的 bug，钉死防回归。
  const rail = /function renderBotOpsRail\(\)[\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.ok(rail, "找不到 renderBotOpsRail —— 改名时本门禁必须变红");
  assert.doesNotMatch(rail, /bot-ops-approvals-list"[\s\S]*?\n\s*if \(fold\) fold\.hidden/, "渲染循环不得夺走面板显隐权");

  // 显隐由标签规则承担，三条都要在：
  assert.match(css, /#bot-ops-rail\[data-rail-tab="overview"\] \.bot-inspector-scroll > #bot-ops-approvals/, "「会话」标签下必须隐藏审批面板（否则与标签语义冲突）");
  assert.match(css, /#bot-ops-rail\[data-rail-tab="overview"\] \.bot-inspector-scroll > #bot-ops-files/, "同上：文件面板不得在「会话」里重复出现");
  assert.match(css, /#bot-ops-rail\[data-rail-tab="approvals"\] \.bot-inspector-scroll > :not\(#bot-ops-approvals\)/);

  // 标签切换必须真的展开面板本体：`<details>` 不 open 的话内容仍是隐藏的
  assert.match(app, /panel\.hidden = false;\n\s+panel\.open = true;/, "切到面板标签时必须展开 <details>");
});

test("工具行：可关闭页签条 + Codex 动作行，键位与绑定表**逐条不漂移**", async () => {
  const [html, css, app] = await Promise.all([
    source("public/index.html"),
    source("public/forge/bot-shell.css"),
    source("public/app.js"),
  ]);
  // 工具区在 `.bot-inspector-scroll` **之前**（同属 `#bot-ops-rail`），
  // 用 railMarkup（从 scroll 起切）会把它整个切掉——本测试初版就栽在这。
  const opsStart = html.indexOf('id="bot-ops-rail"');
  assert.ok(opsStart > 0, "找不到 #bot-ops-rail");
  const opsRail = html.slice(opsStart, html.indexOf("</aside>", opsStart));

  // 一、页签 = 功能页（W9/W11）：四个页签、可选；会话常驻不可关，审批/文件/终端可关
  const tabs = [...opsRail.matchAll(/data-bot-rail-tab="([\w-]+)"/g)].map(([, tab]) => tab);
  assert.deepEqual(tabs, ["overview", "approvals", "files", "terminal"], "页签集变了——面板显隐规则要同步");
  // 页签 id 唯一（railMarkup 切不到页签条，这里顺带守）
  for (const tab of tabs) {
    assert.equal([...opsRail.matchAll(new RegExp(`id="bot-rail-tab-${tab}"`, "g"))].length, 1, `bot-rail-tab-${tab} 必须唯一`);
  }
  assert.match(opsRail, /id="bot-rail-tab-overview" aria-controls="bot-ops-scroll" aria-selected="true"[^>]*data-bot-rail-tab="overview"/);
  for (const tab of ["approvals", "files", "terminal"]) {
    assert.match(opsRail, new RegExp(`data-bot-rail-tab="${tab}"[\\s\\S]{0,300}?class="bot-rail-tab-close" data-bot-rail-tab-close="${tab}"`), `${tab} 页签必须带关闭钮`);
  }
  assert.doesNotMatch(opsRail, /data-bot-rail-tab="overview"[\s\S]{0,300}?bot-rail-tab-close/, "会话页常驻，不得带关闭钮");
  // 关闭 ≠ 消失：条尾「＋」菜单列出全部功能页，关掉的页从这里一条可见路径回来（浏览器式页签）
  assert.match(opsRail, /id="bot-rail-tab-add" aria-haspopup="true" aria-expanded="false" aria-label="打开页面"/);
  for (const tab of ["approvals", "files"]) {
    assert.match(opsRail, new RegExp(`data-bot-rail-menu="${tab}"`), `${tab} 必须在「＋」菜单里可达`);
  }
  // × 是浏览器式显隐：静息页签不显示，活动/悬停/键盘聚焦才现身（防静息页签行脏）
  assert.match(css, /\.bot-rail-tab-close \{[\s\S]{0,220}opacity: 0;/);
  assert.match(css, /\.bot-rail-tab\[aria-selected="true"\] \.bot-rail-tab-close \{ opacity/);
  const acts = [...opsRail.matchAll(/data-bot-workspace-action="([\w-]+)"/g)].map(([, action]) => action);
  assert.deepEqual(acts, ["browser", "git-commit", "git-push", "terminal"]);

  // 二、role=tablist 就**必须**有键盘模型（APG）：方向键漫游 + Enter/Space 激活（div 页签没有原生激活）+ Delete 关闭
  assert.match(app, /byId\("bot-rail-page-tabs"\)\?\.addEventListener\("keydown"/);
  assert.match(app, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.match(app, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(app, /event\.key === "Delete" \|\| event\.key === "Backspace"/);
  assert.match(app, /button\.tabIndex = active \? 0 : -1/, "roving tabindex 必须落实");

  // 三、面板按页签显隐（面板是 scroll 的直接子级，兄弟选择器才成立）——三个都要有
  assert.match(css, /#bot-ops-rail\[data-rail-tab="approvals"\] \.bot-inspector-scroll > :not\(#bot-ops-approvals\)/);
  assert.match(css, /#bot-ops-rail\[data-rail-tab="files"\] \.bot-inspector-scroll > :not\(#bot-ops-files\)/);
  assert.match(css, /#bot-ops-rail\[data-rail-tab="terminal"\] \.bot-inspector-scroll > :not\(#bot-ops-terminal\)/);

  // 四、**漂移守卫**：绑定表里每一条都必须在 DOM 里可达。
  // 动作行（b/k/u/`）的键位以 <kbd> 可见；页签（a/f）键位在 title 里（页签条窄，摆不下键帽——
  // 但 title 必须写，否则按键就是隐形的）。说谎的键位比没有更糟。
  const table = /const BOT_OPS_SHORTCUTS = Object\.freeze\(\{([\s\S]*?)\}\)/.exec(app);
  assert.ok(table, "找不到 BOT_OPS_SHORTCUTS —— 绑定表被删/改名时本门禁必须变红");
  const bindings = [...table[1].matchAll(/(?:"([^"]+)"|(\w+)):\s*"([\w-]+)"/g)]
    .map(([, quoted, bare, action]) => [quoted ?? bare, action]);
  assert.equal(bindings.length, 6);
  for (const [key, action] of bindings) {
    assert.match(opsRail, new RegExp(`data-bot-(?:workspace-action|rail-tab)="${action}"`), `键位 ${key} 绑定的动作「${action}」在 DOM 里不可达`);
    if (["browser", "git-commit", "git-push", "terminal"].includes(action)) {
      const shown = key === "`" ? "`" : key.toUpperCase();
      assert.match(
        opsRail,
        new RegExp(`data-bot-workspace-action="${action}"[\\s\\S]{0,400}?<kbd[^>]*>[^<]*Ctrl\\+Shift\\+${shown}`),
        `动作「${action}」行内未展示 Ctrl+Shift+${shown}`,
      );
    } else {
      assert.match(
        opsRail,
        new RegExp(`data-bot-rail-tab="${action}"[^>]*title="[^"]*Ctrl\\+Shift\\+`),
        `页签「${action}」的 title 必须写明键位`,
      );
    }
  }
  // 每条动作行必须有可见文字标签（图标不单独承载语义）
  for (const action of acts) {
    assert.match(
      opsRail,
      new RegExp(`data-bot-workspace-action="${action}"[\\s\\S]{0,200}?<span>[^<]+</span>`),
      `${action} 行缺少可见文字标签`,
    );
  }
});

test("W9 · 页签关闭状态机：持久化、＋菜单重开、新审批自动重开", async () => {
  const [html, app] = await Promise.all([source("public/index.html"), source("public/app.js")]);

  // 状态机三件套 + 存储键
  assert.match(app, /BOT_RAIL_TABS_STORAGE_KEY = "514cc\.bot-rail-tabs\.v1"/);
  assert.match(app, /function botCloseRailTab/);
  assert.match(app, /function botReopenRailTab/);
  // 关闭的是当前页 → 落回会话页（不得停在已关闭页签上），且**焦点必须交接**：
  // 被关的页签是 display:none，把焦点留在它上面会被浏览器丢给 <body>，
  // 之后按 Tab 从文档头重来（2026-10-09 审计照出的焦点丢失路径）。
  const close = /function botCloseRailTab\([\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.match(close, /wasActive[\s\S]*botActivateRailTab\("overview", \{ focus \}\)/);
  // 快捷键/动作入口指向已关闭页签 = 重开（否则按键像坏掉）
  const activate = /function botActivateRailTab\([\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.match(activate, /botRailClosedTabs\.has\(next\)/);
  // 新审批到达自动重开审批页（SSE 分支内，非渲染循环——渲染循环夺权是四·补8 的教训）
  assert.match(app, /if \(botRailClosedTabs\.has\("approvals"\)\) botReopenRailTab\("approvals"\);/);
  // 终端页关闭 = 抽屉同步关闭（开合单向同步于页签；PTY 不销毁）
  assert.match(close, /tab === "terminal"[\s\S]{0,120}setOpen\?\.\(false/);
  // 「＋」菜单：外点/Escape 关闭，菜单项直达重开
  assert.match(app, /function setBotRailTabMenuOpen/);
  assert.match(app, /byId\("bot-rail-tab-menu"\)\?\.addEventListener\("click"/);
  assert.match(app, /document\.addEventListener\("click"/);
  assert.match(app, /event\.key !== "Escape"/);
  // 初始化必须在首次渲染前应用关闭态（重入的 initBotShell 也要应用）
  const init = /function initBotShell\(\)[\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.match(init, /applyBotRailClosedTabsStorage\(\);[\s\S]*renderBotOpsRail\(\);/);
});

test("W11 · 终端并入页签：抽屉重挂、开合同步、Ctrl+` 语义上交", async () => {
  const [html, css, app, dockModule] = await Promise.all([
    source("public/index.html"),
    source("public/forge/bot-shell.css"),
    source("public/app.js"),
    source("public/modules/bot-terminal-dock.js"),
  ]);

  // 页面容器存在，抽屉由 JS 搬进挂载点（必须在 dock 初始化之前、关闭态应用之后）
  assert.match(html, /id="bot-ops-terminal"[\s\S]*?id="bot-ops-terminal-mount"/);
  const init = /function initBotShell\(\)[\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.match(init, /applyBotRailClosedTabsStorage\(\);[\s\S]*?termMount\.appendChild\(termDrawer\)[\s\S]*?ensureBotTerminalDock\(\)/);
  // 抽屉开合单向同步于页签（关闭态唯一真源），且 **0 尺寸守卫**：
  // 加载时终端页隐藏（默认 overview），构造/初始化都不得创建面板——
  // xterm open() 在 0 尺寸容器里初始化后永远画不出字（LO 实测「终端不显示」）。
  // 面板必须延迟到首次激活终端页（botActivateRailTab 里页面已可见）才创建。
  assert.match(app, /BOT_TERM_KEYS\.open/);
  assert.match(app, /storage: dockStorage/);
  assert.match(app, /if \(key === BOT_TERM_KEYS\.open\) return "0";/);
  assert.match(init, /if \(botRailClosedTabs\.has\("terminal"\)\) botTerminalDock\?\.setOpen\?\.\(false, \{ persist: false \}\);/);
  assert.doesNotMatch(init, /setOpen\?\.\(!botRailClosedTabs/);
  // 激活终端页必须确保 dock 开启
  const activate = /function botActivateRailTab\([\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.match(activate, /next === "terminal"[\s\S]{0,120}setOpen\?\.\(true/);
  // Ctrl+` 语义上交页签层（dock 的内置 toggle 会让抽屉在可见页里凭空消失）
  assert.match(dockModule, /onToggleRequest/);
  assert.match(app, /onToggleRequest: \(\) => botRailTerminalToggle\(\)/);
  assert.match(app, /function botRailTerminalToggle/);
  // 页内样式：容器转 flex 列并吃满（压过 dock 内联高度）、头部/关闭钮/高度 grip 由页签接管
  assert.match(css, /\.bot-ops-terminal-mount #bot-terminal-container \{ display: flex; flex-direction: column; height: auto !important;/);
  assert.match(css, /\.bot-ops-terminal-mount \.terminal-drawer-head,\s*\.bot-ops-terminal-mount #bot-terminal-grip \{ display: none; \}/);
});

test("W10 · 文件类型着色：标记与令牌齐备", async () => {
  const [panels, css] = await Promise.all([
    source("public/modules/rail-panels.js"),
    source("public/forge/bot-shell.css"),
  ]);
  assert.match(panels, /function fileKindOf/, "类型判定函数缺失");
  assert.match(panels, /data-file-kind=/, "树条目必须带类型标记");
  // 颜色全部走既有令牌（git 橙 / 图片媒体陶 / 文档绿）——不许裸值
  assert.match(css, /\.rail-files-entry\[data-file-kind="git"\] \.icon \{ color: var\(--bot-yellow\); \}/);
  assert.match(css, /\[data-file-kind="image"\] \.icon,\s*\.bot-ops-files \.rail-files-entry\[data-file-kind="media"\] \.icon \{ color: var\(--bot-claude\); \}/);
  assert.match(css, /\[data-file-kind="doc"\] \.icon \{ color: var\(--bot-green\); \}/);
});

test("W12 · 工具页全铺满：滚动容器去壳、页吃满剩余高、动作区让位", async () => {
  const css = await source("public/forge/bot-shell.css");
  // 工具页签激活时：滚动容器去内距/锁滚动，动作区让位（Codex 参照：页签条下就是内容）
  for (const tab of ["approvals", "files", "terminal"]) {
    assert.match(
      css,
      new RegExp(`#bot-ops-rail\\[data-rail-tab="${tab}"\\] \\.bot-inspector-scroll\\s*[,{][\\s\\S]{0,220}padding: 0;`),
      `${tab} 滚动容器必须去壳`,
    );
  // 工具页签下动作区让位：三个页签在同一条组规则里，terminal 收尾且带 display:none
  assert.match(
    css,
    /#bot-ops-rail\[data-rail-tab="approvals"\] \.bot-inspector-toolbar,[\s\S]{0,200}#bot-ops-rail\[data-rail-tab="files"\] \.bot-inspector-toolbar,[\s\S]{0,200}#bot-ops-rail\[data-rail-tab="terminal"\] \.bot-inspector-toolbar \{ display: none; \}/,
    "工具页签下动作区必须让位",
  );
  }
  // 页本体去卡片壳并吃满（三个面板都在同一条规则里）。**display: contents**——
  // <details> 上的 flex 不参与子元素布局（Chromium 内部槽位），contents 摘掉本体盒；
  // 子元素的真布局盒是 ::details-content（下方单独 flex 化），两条缺一高度链就断。
  assert.match(css, /#bot-ops-rail\[data-rail-tab="approvals"\] \.bot-inspector-scroll > #bot-ops-approvals,[\s\S]{0,700}display: contents;/);
  assert.match(css, /#bot-ops-rail\[data-rail-tab="approvals"\] #bot-ops-approvals::details-content,[\s\S]{0,220}display: flex;[\s\S]{0,80}flex-direction: column;/);
  // 文件页内部分配：树吃剩余高（解除 160px 上限）、预览锚底
  assert.match(css, /#bot-ops-rail\[data-rail-tab="files"\] #bot-ops-files-list \{[\s\S]{0,80}max-height: none;/);
});

test("W9 · 左右栏可拖拽伸缩：分隔条契约", async () => {
  const [html, css, app] = await Promise.all([
    source("public/index.html"),
    source("public/forge/bot-shell.css"),
    source("public/app.js"),
  ]);
  // 两条分隔条寄生在各自面板内缘（皮肤 4 列栅格对栅格子项不友好），role=separator
  assert.match(html, /class="bot-roster"[^>]*>\s*<div class="bot-shell-grip" id="bot-roster-grip" role="separator"/);
  assert.match(html, /id="bot-agent-panel"[^>]*>\s*<div class="bot-shell-grip" id="bot-ops-grip" role="separator"/);
  // 宽度以 JS 状态为真源、同时写两套变量（基础栅格 + grok 皮肤栅格）
  assert.match(app, /BOT_SHELL_SIZES_STORAGE_KEY = "514cc\.bot-shell-sizes\.v1"/);
  assert.match(app, /function bindBotShellSplitter/);
  assert.match(app, /grid\.style\.setProperty\(`--bot-\$\{key\}`/);
  assert.match(app, /grid\.style\.setProperty\("--bot-grok-roster"/, "皮肤栅格的 roster 列走 --bot-grok-roster，必须一起写");
  assert.match(app, /grid\.style\.setProperty\("--bot-grok-roster", `\$\{width\}px`\)/);
  // 从面板矩形起算（皮肤 4 列含 56px 图标轨，按栅格左缘算会差 56px）
  assert.match(app, /grip\.closest\("\.bot-roster, \.bot-agent-panel"\)/);
  // 初始化先于首帧渲染
  const init = /function initBotShell\(\)[\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.match(init, /applyBotShellSizesStorage\(\);[\s\S]*renderBotOpsRail\(\);/);
  // CSS：窄屏/抽屉形态隐藏分隔条（拖拽语义不成立）
  assert.match(css, /@media \(max-width: 980px\) \{[\s\S]*?#bot-roster-grip \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*?\.bot-shell-grip \{ display: none; \}/);
});
