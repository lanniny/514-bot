/**
 * bot-rail-a11y-contract.test.mjs — 右栏「看得见 ≠ 到得了」的机械门禁。
 *
 * 来源：2026-10-09 四路独立审计的 interaction-a11y 透镜，逐条在盘上复核过。
 * 这一族缺陷的共同形态是**视觉承诺与键盘/AT 现实不一致**：
 *   · CSS 在页签聚焦时把关闭钮显示出来（`.bot-rail-tab:focus-within .bot-rail-tab-close`），
 *     但关闭钮写死 tabindex="-1" 且从不提升 → 看得见、Tab 到不了。
 *   · 分隔条是 tabindex="0" 的 role=separator（ARIA window splitter），
 *     却从不写 aria-valuenow/min/max → 焦点落上去，方向键静默改宽度，AT 一声不响。
 *   · 关掉当前页签后焦点留在 display:none 的元素上 → 浏览器丢给 <body>，Tab 从文档头重来。
 *   · role=tab 的 aria-controls 指向的不是 role=tabpanel → ARIA tabs 关系悬空。
 *
 * 这些都不会让任何东西报错——它们只是安静地不好用。所以必须由静态断言钉住。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const source = async (path) => (await readFile(`${appRoot}/${path}`, "utf8")).replace(/\r\n/g, "\n");

/** 取一个顶层函数体（约定：函数以列 0 的 `}` 收尾）。 */
function functionBody(text, name) {
  const match = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(text);
  assert.ok(match, `app.js 中找不到函数 ${name} —— 改名/删除时本门禁必须变红，不得静默跳过`);
  return match[0];
}

test("页签关闭钮的 tabindex 随选中态提升——CSS 显示它，Tab 就必须能到", async () => {
  const app = await source("public/app.js");
  const refresh = functionBody(app, "botRefreshRailTabStates");
  // 只提升**选中**页签的关闭钮：全部提升会把 Tab 序撑成 8 站
  assert.match(
    refresh,
    /closeBtn\.tabIndex = selected \? 0 : -1/,
    "关闭钮必须跟随选中态进入/退出 Tab 序；写死 -1 会让 CSS 的 focus-within 显示成为假承诺",
  );
  assert.match(refresh, /querySelector\("\[data-bot-rail-tab-close\]"\)/, "必须真的查到那个钮");

  // 反向：index.html 里的初值仍是 -1（由 JS 提升，不是靠模板写 0）
  const html = await source("public/index.html");
  const closeButtons = [...html.matchAll(/<button[^>]+data-bot-rail-tab-close[^>]*>/g)].map((m) => m[0]);
  assert.ok(closeButtons.length >= 3, `可关闭页签的关闭钮应有 3 个，实测 ${closeButtons.length}`);
  for (const button of closeButtons) {
    assert.match(button, /tabindex="-1"/, `初值应为 -1（由 JS 按选中态提升）：${button.slice(0, 120)}`);
  }
});

test("关掉当前页签必须交接焦点——否则焦点落到 <body>，Tab 从文档头重来", async () => {
  const app = await source("public/app.js");
  const close = functionBody(app, "botCloseRailTab");
  assert.match(
    close,
    /botActivateRailTab\("overview", \{ focus \}\)/,
    "落回会话页时必须带 focus；被关的页签是 display:none，留焦在其上会被浏览器丢给 body",
  );
  // 默认值必须是 true：调用方（点击/Delete）不传参时也要交接
  assert.match(close, /function botCloseRailTab\(tab, \{ focus = true \} = \{\}\)/);
});

test("分隔条是 window splitter，必须播报范围与当前值", async () => {
  const app = await source("public/app.js");
  // 三条 aria 值都要写
  const sync = functionBody(app, "syncBotShellGripValues");
  assert.match(sync, /aria-valuemin/);
  assert.match(sync, /aria-valuemax/);
  assert.match(sync, /aria-valuenow/);
  // 范围取自真实限制常量，不是另写一份字面量
  assert.match(sync, /BOT_SHELL_SIZE_LIMITS\[key\]/);
  // 绑定即宣告一次（不等第一次交互），且每次 commit 后同步
  const splitter = functionBody(app, "bindBotShellSplitter");
  // commit 体内必须有同步调用（放在 persist 之后、return 之前，按区块边界判，不做邻近猜测）
  const commit = /const commit = \(width[\s\S]*?\n    \};/.exec(splitter)?.[0] ?? "";
  assert.ok(commit, "找不到 commit 定义");
  assert.match(commit, /syncBotShellGripValues\(gripId, key\)/, "commit 后必须同步播报值");
  // 绑定阶段的无条件调用（不在任何事件回调里）
  assert.match(splitter, /\n    syncBotShellGripValues\(gripId, key\);\n/, "绑定即宣告范围，不等交互");

  // HTML 侧：两个分隔条确实是可聚焦的 role=separator（这条是前提，缺了整族都没意义）
  const html = await source("public/index.html");
  for (const id of ["bot-roster-grip", "bot-ops-grip"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="separator"`), `${id} 必须是 role=separator`);
    assert.match(html, new RegExp(`id="${id}"[^>]*tabindex="0"`), `${id} 必须键盘可达`);
  }
});

test("页签的 aria-controls 目标必须被补上 role=tabpanel 与 aria-labelledby", async () => {
  const app = await source("public/app.js");
  const refresh = functionBody(app, "botRefreshRailTabStates");
  assert.match(refresh, /panel\.setAttribute\("role", "tabpanel"\)/, "aria-controls 指向非 tabpanel = 悬空关系");
  assert.match(refresh, /panel\.setAttribute\("aria-labelledby", `bot-rail-tab-\$\{tab\}`\)/);

  // 三个「不许做」的边界——它们各自会引入一个更糟的缺陷，必须钉住不被后人加回来：
  assert.doesNotMatch(
    refresh,
    /panel\.setAttribute\("aria-hidden"/,
    "#bot-ops-scroll 是 overview 面板，另三个面板是它的后代；给祖先标 aria-hidden 会连带藏掉选中的子面板",
  );
  assert.doesNotMatch(
    refresh,
    /panel\.tabIndex = /,
    "APG 只在面板内无可聚焦内容时才给 tabindex=0；这四个面板里都有控件，再加一站只是撑长 Tab 序",
  );

  // 面板仍是 .bot-inspector-scroll 的直接子级（CSS 的兄弟选择器依赖这一点）
  const html = await source("public/index.html");
  for (const id of ["bot-ops-approvals", "bot-ops-files", "bot-ops-terminal"]) {
    assert.match(html, new RegExp(`<details[^>]+id="${id}"`), `${id} 应仍是 scroll 的直接子级 details`);
  }
  assert.match(html, /<div class="bot-inspector-scroll" id="bot-ops-scroll">/);
});

test("收件箱待办行的作答消费者必须真的挂在列表上（不是只有函数定义）", async () => {
  const app = await source("public/app.js");
  // 生产端（渲染器）发了 data-bot-ask-open；消费端必须绑在**列表容器**上
  assert.match(
    app,
    /byId\("bot-ops-inbox-list"\)\?\.addEventListener\("click"/,
    "渲染器发了 data-bot-ask-open 却没人监听 = 死行（2026-10-09 审计的原始缺陷形态）",
  );
  assert.match(
    app,
    /byId\("bot-ops-inbox-list"\)\?\.addEventListener\("keydown"/,
    "role=button 的 article 没有原生激活行为，必须自己补 Enter/Space",
  );
  // 键盘分支必须真的在监听器内（不是在别处写了一句相同的 if）
  const keydown = /byId\("bot-ops-inbox-list"\)\?\.addEventListener\("keydown"[\s\S]*?\n  \}\);/.exec(app)?.[0] ?? "";
  assert.ok(keydown, "找不到 keydown 监听器区块");
  assert.match(keydown, /event\.key !== "Enter" && event\.key !== " "/);
  assert.match(keydown, /closest\("\[data-bot-ask-open\]"\)/);
  assert.match(keydown, /openBotOpsAskRow\(row\)/);
});
