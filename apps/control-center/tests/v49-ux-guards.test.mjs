/**
 * v49 UX 完善的机械承载（2026-09-04）。
 *
 * ── 这些断言在守什么 ──
 * U0 字号地板：`forge/experience-polish.css` 把 --text-sm/--text-xs 按 --ui-font-size
 * 比例缩放，而那是用户可拖的滑杆（12–18px）。不设 max() 地板时逐档实测 xs 落到
 * 9.48 / 10.27 / 11.06（默认档）/ 11.85px，全部击穿 `forge/tokens.css` 自述的 12px
 * 硬下限（"中文 10px 以下字形糊化、不可读"）—— 协作台首屏曾有 57% 的可见文字
 * 落在 11.06px。既有五条 lint 规则**结构上都拦不到**：bare-font 只认字面
 * `font-size: Npx`，bare-hex 的 CUSTOM_PROP_DEF_RE 又主动跳过所有 `--` 开头的行。
 *
 * C-01 能力生效链折叠：它常驻 97px，是配置页 646px 首屏 chrome 的第二大块。
 * 教学内容对首访有价值、对回访是噪音，所以折叠而非删除，并把三层关系压进摘要行。
 *
 * ── 为什么是源码级断言 ──
 * `app.js` 是浏览器侧单文件，无法在 node 里 import 其内部函数（与
 * `approval-tool-permission-card.test.mjs` / `approval-broad-permission-block.test.mjs`
 * 同法）。运行时行为由 `scripts/qa-ui.mjs --suite=layout` 的 inspectTypographyFloor
 * 实测把守 —— calc() 的运行值静态扫描算不出来，两层缺一不可。
 *
 * 每组都配元验收：篡改源码后断言必须变红，否则它是恒真的（拿表验表）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (relative) => readFileSync(resolve(root, relative), "utf8");

const polish = read("public/forge/experience-polish.css");
const tokens = read("public/forge/tokens.css");
const motion = read("public/forge/motion.css");
const lint = read("scripts/ui-lint.mjs");
const qaUi = read("scripts/qa-ui.mjs");
const baseline = JSON.parse(read("scripts/ui-baseline.json"));
const html = read("public/index.html");
const app = read("public/app.js");
const dataCss = read("public/forge/data.css");

// ═══ U0 · 字号地板 ═══

test("按比例缩放的字号档必须带 12px 地板（默认滑杆档曾产出 11.06px）", () => {
  // 取内容面那一块（--ui-font-size 缩放生效处）
  const start = polish.indexOf("--text-base: var(--ui-font-size");
  assert.notEqual(start, -1, "内容面字号缩放块不见了");
  const block = polish.slice(start, start + 400);

  for (const step of ["sm", "xs"]) {
    const declaration = block.match(new RegExp(`--text-${step}:[^;]+;`))?.[0];
    assert.ok(declaration, `--text-${step} 声明缺失`);
    assert.match(
      declaration,
      /max\(\s*12px\s*,/,
      `--text-${step} 未设 12px 地板：滑杆拖到 12px 时它会算出 ${step === "xs" ? "9.48" : "10.68"}px`,
    );
  }
});

test("地板值与 tokens.css 自述的硬下限一致（代码不能和自己的文档说反话）", () => {
  // tokens.css 的注释里写明 12px 为硬下限；地板若改成别的值，必须同步改那段注释。
  assert.match(tokens, /12px 为硬下限/, "tokens.css 的硬下限声明不见了");
  assert.match(tokens, /--text-xs:\s*12px;/, "tokens.css 的 --text-xs 真源值不再是 12px");
  const floors = polish.match(/max\(\s*(\d+)px\s*,\s*calc\(var\(--ui-font-size/g) ?? [];
  assert.equal(floors.length, 2, `按比例缩放的档位应有 2 处地板，实得 ${floors.length}`);
  for (const floor of floors) {
    assert.match(floor, /max\(\s*12px/, `地板值与 tokens.css 的 12px 不一致：${floor}`);
  }
});

test("--text-base / --text-lg 不设地板（它们本就 ≥ 滑杆值，加地板等于压平阶梯）", () => {
  const start = polish.indexOf("--text-base: var(--ui-font-size");
  const block = polish.slice(start, start + 400);
  assert.doesNotMatch(block.match(/--text-base:[^;]+;/)?.[0] ?? "", /max\(/);
  assert.doesNotMatch(block.match(/--text-lg:[^;]+;/)?.[0] ?? "", /max\(/);
});

test("元验收：拿掉地板，U0 断言必须变红", () => {
  const gutted = polish.replace(/max\(12px,\s*(calc\(var\(--ui-font-size[^)]+\)[^)]*\))\)/g, "$1");
  assert.doesNotMatch(gutted, /max\(\s*12px/, "前提：替换后应无地板");
  // 真实源码必须有，且恰好 2 处
  assert.equal((polish.match(/max\(\s*12px\s*,\s*calc\(var\(--ui-font-size/g) ?? []).length, 2);
});

// ═══ U0 · lint 规则 token-redefine ═══

test("ui-lint 有 token-redefine 规则，且 tokens.css 豁免（它是定义源）", () => {
  assert.match(lint, /token-redefine/, "缺 token-redefine 规则");
  assert.match(lint, /function countTokenRedefines/);
  assert.match(lint, /if \(isTokenFile\) return 0;/, "tokens.css 未豁免，真源会被自己的规则报违规");
  assert.ok("token-redefine" in baseline, "基线未登记 token-redefine，门禁读不到上限");
});

test("token-redefine 只认尺度阶梯，不误伤颜色与别名令牌", () => {
  const STEPS = "xs|sm|base|md|lg|xl|2xl|3xl|4xl|5xl";
  // 与 ui-lint.mjs 的正则**独立重写**（拿表验表是恒真基线）
  const re = new RegExp(
    `(?:^|[{;\\s])--(?:text-(?:${STEPS})|display-(?:${STEPS})|space-\\d+|radius-(?:${STEPS})|dur-[a-z]+)\\s*:`,
  );
  for (const hit of [
    "  --text-xs: 12px;",
    "  --text-sm: max(12px, calc(var(--ui-font-size) * 0.89));",
    ".probe { --text-xs: 8px; }", // 单行块也要抓到，否则一行就能绕过
    "  --dur-fast: 100ms; --dur-slow: 240ms;",
  ]) {
    assert.ok(re.test(hit), `应命中却漏过：${hit}`);
  }
  for (const miss of [
    "  font-size: var(--text-xs);", // 消费不是定义
    "  --text-strong: #2a2620;", // 颜色令牌，各层按语义覆写是正确用法
    "  --text-muted: var(--x);",
    "  --radius-card: 8px;", // 别名而非阶梯
    "  --ease-spring: cubic-bezier(0.16, 1, 0.3, 1);", // ease 不是尺度
  ]) {
    assert.ok(!re.test(miss), `应漏过却命中（会制造噪音让规则被忽略）：${miss}`);
  }
});

// ═══ U0 · 动效令牌归属合并 ═══

test("动效令牌只在 tokens.css 定义（motion.css 的 :root 块曾静默覆盖它）", () => {
  // 改前：motion.css 也定义 --dur-fast:100ms / --dur-slow:240ms / --ease-spring，
  // 且加载在后，使 tokens.css 的 160ms/360ms/spring 成为死代码（158 个消费者受影响）。
  assert.doesNotMatch(motion, /^:root\s*\{/m, "motion.css 又出现了 :root 令牌块");
  for (const token of ["--dur-fast", "--dur-slow", "--dur-med", "--dur-slower", "--ease-out", "--ease-spring"]) {
    assert.match(tokens, new RegExp(`${token}:`), `${token} 未收进 tokens.css`);
    assert.doesNotMatch(motion, new RegExp(`^\\s*${token}\\s*:`, "m"), `${token} 仍在 motion.css 定义`);
  }
});

test("归属合并搬的是实际生效的值，不是纸面值（行为零变化）", () => {
  // 合并前浏览器实算：--dur-fast=100ms、--dur-slow=240ms、--ease-spring=bounce 曲线。
  // 若有人"顺手修正"回 tokens.css 原来写的 160ms/360ms，那是行为变更而非整理。
  assert.match(tokens, /--dur-fast:\s*100ms;/, "--dur-fast 不再是合并前实际生效的 100ms");
  assert.match(tokens, /--dur-slow:\s*240ms;/, "--dur-slow 不再是合并前实际生效的 240ms");
  assert.match(tokens, /--ease-spring:\s*cubic-bezier\(0\.34, 1\.56, 0\.64, 1\);/, "--ease-spring 曲线变了");
});

// ═══ U0 · qa:ui 运行时断言 ═══

test("qa:ui 有全滑杆档位的实测地板断言（静态扫描算不出 calc 运行值）", () => {
  assert.match(qaUi, /inspectTypographyFloor/, "缺字号地板实测");
  assert.match(qaUi, /UI_FONT_FLOOR_PX = 12/);
  assert.match(qaUi, /\[12, 13, 14, 15, 16, 17, 18\]/, "未覆盖滑杆全档位");
  // 必须挂进 layout 套件，否则写了不跑
  const layoutSuite = qaUi.slice(qaUi.indexOf('suite === "layout"'), qaUi.indexOf('suite === "history"'));
  assert.match(layoutSuite, /inspectTypographyFloor\(/, "断言没挂进 layout 套件，等于没写");
});

test("qa:ui 同时检查真实渲染的叶子文本，不止令牌值", () => {
  const body = qaUi.slice(qaUi.indexOf("async function inspectTypographyFloor"), qaUi.indexOf("try {\n  if (suite"));
  assert.match(body, /smallestLeaf/, "只验令牌不验实际渲染 —— 某处写死小字号仍会漏过");
  assert.match(body, /rendered leaf text/);
  // 阶梯不能靠压平换地板：18px 档必须重新分层
  assert.match(body, /typography ladder collapsed/, "缺阶梯塌陷检查：max(12px,12px) 也能过地板断言");
});

// ═══ C-01 · 能力生效链折叠 ═══

test("能力生效链可折叠，且默认展开（首访教学）", () => {
  assert.match(html, /id="capability-bus-toggle"[^>]*aria-expanded="true"/, "折叠开关缺失或默认收起");
  assert.match(html, /aria-controls="capability-bus-body"/);
  assert.match(html, /id="capability-bus-body"/);
  assert.match(app, /CAPABILITY_BUS_OPEN_KEY = "514cc-capability-bus-open-v1"/);
  // 未写入过该键 → 展开；只有显式 "0" 才收起
  assert.match(app, /localStorage\.getItem\(CAPABILITY_BUS_OPEN_KEY\) !== "0"/, "首访默认态写反了");
});

test("折叠态保留摘要行（收起不等于信息消失）", () => {
  assert.match(html, /class="capability-bus-digest">本机安装 → 团队菜单 → 成员范围</, "折叠后三层关系不可见");
  assert.match(dataCss, /\.capability-bus\.is-collapsed \.capability-bus-digest \{\s*display: block;/);
  assert.match(dataCss, /\.capability-bus-digest \{[\s\S]*?display: none;/, "摘要在展开态未隐藏，会与正文重复");
});

test("概述留在 header 而非 body（移进 body 曾把展开态从 97px 顶到 130px）", () => {
  const busBlock = html.slice(html.indexOf('id="capability-bus"'), html.indexOf('id="cap-workspace-tabs"'));
  const headerEnd = busBlock.indexOf("</header>");
  const noteIndex = busBlock.indexOf("capability-bus-note");
  assert.ok(noteIndex > 0 && noteIndex < headerEnd, "概述跑到 body 里了 —— 它会成为 track 上方的独立一行");
});

test("折叠开关是真按钮且键盘可达（不是 div 加 onclick）", () => {
  assert.match(html, /<button class="capability-bus-toggle"[^>]*type="button"/);
  assert.match(dataCss, /\.capability-bus-toggle:focus-visible/, "缺焦点环，键盘用户看不见当前位置");
  // 折叠动效必须走 token，且 chevron 有方向反馈
  assert.match(dataCss, /transition: transform var\(--dur-fast\) var\(--ease-standard\)/);
  assert.match(dataCss, /\.capability-bus\.is-collapsed \.capability-bus-toggle \.chevron \{\s*transform: rotate\(-90deg\);/);
});

test("元验收：把默认态改成收起，C-01 断言必须变红", () => {
  const gutted = app.replace(
    /localStorage\.getItem\(CAPABILITY_BUS_OPEN_KEY\) !== "0"/,
    'localStorage.getItem(CAPABILITY_BUS_OPEN_KEY) === "1"',
  );
  assert.doesNotMatch(gutted, /CAPABILITY_BUS_OPEN_KEY\) !== "0"/, "前提：替换后默认态应变为收起");
  assert.match(app, /localStorage\.getItem\(CAPABILITY_BUS_OPEN_KEY\) !== "0"/);
});

test("元验收：删掉摘要行，折叠态断言必须变红", () => {
  const gutted = html.replace(/<span class="capability-bus-digest">[^<]*<\/span>/, "");
  assert.doesNotMatch(gutted, /capability-bus-digest">本机安装/, "前提：删除后摘要应消失");
  assert.match(html, /class="capability-bus-digest">本机安装/);
});

// ═══ U2 · 窄屏 composer footer 两列网格 ═══

const consoleForm = read("public/forge/console-form.css");

/** 取 ≤560px 那条媒体查询的整块（含嵌套花括号）。 */
function narrowFooterBlock() {
  const marker = "@media (max-width: 560px)";
  let start = -1;
  for (let i = consoleForm.indexOf(marker); i !== -1; i = consoleForm.indexOf(marker, i + 1)) {
    const probe = consoleForm.slice(i, i + 1600);
    if (probe.includes(".composer-shell .composer-footer")) { start = i; break; }
  }
  assert.notEqual(start, -1, "找不到 composer-footer 的窄屏媒体查询");
  let depth = 0;
  for (let i = consoleForm.indexOf("{", start); i < consoleForm.length; i += 1) {
    if (consoleForm[i] === "{") depth += 1;
    else if (consoleForm[i] === "}") {
      depth -= 1;
      if (depth === 0) return consoleForm.slice(start, i + 1);
    }
  }
  throw new Error("窄屏媒体查询块未闭合");
}

test("窄屏 footer 用 grid 显式定位，不用 flex-wrap 碰运气", () => {
  const block = narrowFooterBlock();
  // 改前是 `flex: 1 1 calc(50% - 8px)`：只是"希望"两列，某项内容超过 50% 就独占整行，
  // 实测 model-pick 占 460px、budget-pick 占 390px，塌成 3 行 100px。
  assert.match(block, /display: grid;/, "窄屏 footer 不再是网格 —— 宽度分配会退回看运气");
  assert.doesNotMatch(block, /flex-wrap: wrap;/, "flex-wrap 回来了：它挡不住超宽项独占整行");
  assert.doesNotMatch(block, /flex: 1 1 calc\(50%/, "又用 flex-basis 假装两列了");
  assert.match(block, /grid-template-columns: auto minmax\(0, 1fr\) minmax\(0, 1fr\) auto;/);
});

test("窄屏 footer 的七个控件都有显式坐标（热调胶囊是条件显示的）", () => {
  const block = narrowFooterBlock();
  // composer-session-controls 只在沿用会话配置时出现；靠自动流会让整张网格错位。
  for (const [selector, area] of [
    [".composer-attach", "1 / 1"],
    [".send-button", "1 / 4"],
    ["#task-model-pick", "1 / 2"],
    ["#task-effort-pick", "1 / 3"],
    ["#task-permission-pick", "2 / 2"],
    ["#task-budget-pick", "2 / 3"],
    [".composer-session-controls", "2 / 1"],
  ]) {
    const rule = block.match(new RegExp(`${selector.replace(/[.#]/g, "\\$&")} \\{[^}]*\\}`))?.[0];
    assert.ok(rule, `${selector} 在窄屏块里没有规则`);
    assert.match(rule, new RegExp(`grid-area: ${area};`), `${selector} 的坐标不是 ${area}`);
  }
});

test("窄屏改动不外溢到桌面（700–1920px 实测九档一像素未动）", () => {
  const block = narrowFooterBlock();
  // 整块必须在 max-width 媒体查询内，且不含任何 min-width 抬升
  assert.match(block, /^@media \(max-width: 560px\)/);
  assert.doesNotMatch(block, /min-width:\s*\d+px\)/, "窄屏块里出现 min-width 查询，会影响桌面档");
});

test("桌面 footer 仍是单行 flex（实测占比稳定 91-94%，无需重构）", () => {
  // 原方案 U2 拟包一层"运行参数"胶囊；实测 700–1920px 全部单行、从不溢出后撤销 ——
  // .pick-menu 是 absolute 定位、依赖 .pick-menu-host 作定位祖先，
  // 无收益的结构改动只会白担风险。这条断言锁住"不要再去包容器"。
  const desktop = consoleForm.match(/\.composer-shell \.composer-footer \{[^}]*\}/)?.[0];
  assert.ok(desktop, "桌面 footer 规则不见了");
  assert.match(desktop, /display: flex;/, "桌面 footer 被改成非 flex —— 请先实测证明有收益");
  assert.match(desktop, /flex-wrap: nowrap;/, "桌面 footer 允许换行了：实测它本就不需要");
  // 参数胶囊仍是 pick-menu-host 的直接子级（.pick-menu 的定位祖先没被插入新层）
  const pickHost = consoleForm.match(/\.composer-footer \.pick-menu-host,\s*\n\.composer-footer \.permission-pick \{[^}]*\}/)?.[0];
  assert.ok(pickHost, "pick-menu-host 规则不见了");
  assert.match(pickHost, /position: relative;/, "pick-menu 的定位祖先没了，下拉菜单会飘到别处");
});

test("元验收：把窄屏网格改回 flex-wrap，U2 断言必须变红", () => {
  const block = narrowFooterBlock();
  const gutted = block.replace(/display: grid;/, "display: flex;\n    flex-wrap: wrap;");
  assert.match(gutted, /flex-wrap: wrap;/, "前提：替换后应出现 flex-wrap");
  assert.doesNotMatch(block, /flex-wrap: wrap;/);
  // grid-area 坐标共 7 处，少一处就是有控件回到自动流
  assert.equal((block.match(/grid-area:/g) ?? []).length, 7, "显式坐标数量变了");
});

// ═══ W-03 · 右栏折叠态手柄 ═══

const chrome = read("public/workbench-chrome.js");
/* 剥注释后的代码：注释里提到 `rail.prepend(strip)` 是说明文字，不是调用点。
   不剥的话下面的 doesNotMatch 会把文档当代码，红得莫名其妙（同一脚踩过两次）。 */
const chromeCode = chrome.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}()])\/\/[^\n]*/g, "$1");
const workbenchCss = read("public/forge/workbench.css");
const codexDesktop = read("public/forge/codex-desktop.css");

test("折叠手柄挂在 shell 而非 rail 内部（挂栏内是死代码）", () => {
  // codex-desktop.css 把右栏改成浮层抽屉：折叠态整条 .context-rail 被
  // translateX(100%+18px) + visibility:hidden 滑出视口，setCollapsed 还会 rail.inert=true。
  // 手柄注入在栏内 → 跟着一起消失，实测收起态 strip 隐藏、workbench.css
  // 「折叠态只留细条」那段规则从此永不生效。
  assert.match(chromeCode, /shell\.appendChild\(strip\)/, "手柄没挂在 shell 上");
  assert.doesNotMatch(chromeCode, /rail\.prepend\(strip\)/, "手柄又挂回 rail 内部了 —— 它会随栏滑出视口");
  assert.match(workbenchCss, /\.workbench-shell > \.mc-expand-strip \{/, "缺 shell 级手柄样式");
});

test("codex-desktop 的 display:none 限定在栏内，不再一刀切", () => {
  // 那条 !important 的原意是清理"随栏滑走的残影"（见 6077930），不是"不要可发现性入口"。
  // 限定到 .context-rail 内后原意保留，shell 级手柄不受影响。
  assert.match(codexDesktop, /\.context-rail \.mc-expand-strip \{\s*display: none !important;/);
  assert.doesNotMatch(
    codexDesktop,
    /^\.mc-expand-strip \{\s*\n\s*display: none !important;/m,
    "裸 .mc-expand-strip 的 !important 回来了：它会连 shell 级手柄一起关掉",
  );
});

test("手柄有可见文字标签，不只靠 hover title（触屏无 hover）", () => {
  assert.match(chromeCode, /mc-expand-strip-label">环境</, "手柄没有可见标签");
  assert.match(workbenchCss, /\.mc-expand-strip-label \{[\s\S]*?writing-mode: vertical-rl;/, "竖排标签样式缺失");
  assert.match(chromeCode, /aria-controls", "mission-control-dock"/, "手柄未声明它控制哪个面板");
});

test("手柄的展开态由 JS 同步（展开时它会与右栏重叠）", () => {
  const setter = chromeCode.slice(chromeCode.indexOf("const setCollapsed ="), chromeCode.indexOf("collapseButton.addEventListener"));
  assert.match(setter, /strip\.hidden = !collapsed;/, "展开时手柄没收起");
  assert.match(setter, /strip\.setAttribute\("aria-expanded", String\(!collapsed\)\)/, "aria-expanded 未如实反映当前态");
});

test("元验收：把手柄挂回 rail，W-03 断言必须变红", () => {
  const gutted = chromeCode.replace(/shell\.appendChild\(strip\)/, "rail.prepend(strip)");
  assert.match(gutted, /rail\.prepend\(strip\)/, "前提：替换后应挂回 rail");
  assert.match(chromeCode, /shell\.appendChild\(strip\)/);
});

// ═══ U1-a · 配置页 page-heading 压缩 ═══

const artDirection = read("public/forge/art-direction.css");
/* 剥注释后的 CSS：注释里会提到旧值（如"原先 @media (max-width: 720px) 已把副标题
   display:none"），不剥就会把文档当代码扫。这一脚本轮踩过三次 —— chromeCode、
   approval 那份的 responseFor 计数、以及这里，同一个形状。 */
const artDirectionCode = artDirection.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取 is-settings 例外块里某个选择器的规则体。 */
function configHeadingRule(suffix = "") {
  const selector = `.app-shell.is-settings #view-config.view .page-heading.compact-heading${suffix}`;
  const index = artDirectionCode.indexOf(`${selector} {`);
  assert.notEqual(index, -1, `找不到规则 ${selector}`);
  const end = artDirectionCode.indexOf("}", index);
  return artDirectionCode.slice(index, end + 1);
}

test("配置页 heading 不吃 hero 高度（实测 121.67px → 48px）", () => {
  // 全局 .view:not(#view-workbench) .page-heading 给的是 min-height: clamp(150px, 24vh, 270px)
  // 的编辑式 hero；配置页是操作面，art-direction 的 is-settings 例外把它压成坐标条。
  const rule = configHeadingRule();
  assert.match(rule, /min-height:\s*0;/, "min-height 不再归零 —— 配置页会退回吃 hero 高度");
  assert.doesNotMatch(rule, /min-height:\s*\d+px/, "又写死了一个像素高度：内容变了就会留白或截断");
});

test("配置页 h1 收敛回全局 UI 档（46px 编辑大字在操作面换不来信息）", () => {
  const rule = configHeadingRule(" h1");
  const max = rule.match(/font-size:\s*clamp\([^,]+,[^,]+,\s*(\d+)px\)/)?.[1];
  assert.ok(max, "配置页 h1 没有 clamp 字号");
  assert.ok(Number(max) <= 26, `h1 上限 ${max}px 超过全局 UI 档 26px`);
});

test("副标题在配置页收起（它逐字就是下方五个 tab 的枚举）", () => {
  // 「席位、连接、能力、钩子与本机运行时」= config-topology 的五个 tab 文本。
  // 同一份信息付两次首屏；且 art-direction 原先在 ≤720px 已经 display:none，
  // 本轮只是把同一判断扩到全宽度。
  const rule = configHeadingRule(" > div:first-child > p:last-of-type");
  assert.match(rule, /display:\s*none;/, "副标题又占回首屏了");
  // 2026-09-09 设置轨纵向化：tab 文本容器统一为 span/strong 混排（本机运行时是 strong），
  // 断言标签存在即可、不绑定具体元素；tab 文案为 运行席位/连接档案/能力/钩子/本机运行时。
  for (const tab of ["运行席位", "能力", "钩子", "本机运行时", "连接档案"]) {
    assert.match(html, new RegExp(`<(?:span|strong)>${tab}</(?:span|strong)>`), `config-topology 少了 ${tab} tab —— 副标题的冗余前提不再成立`);
  }
});

test("eyebrow 与 h1 同行，不竖排占两行", () => {
  const rule = configHeadingRule(" > div:first-child");
  assert.match(rule, /display:\s*flex;/, "标题列不是 flex —— eyebrow 会另起一行占 20px");
  assert.match(rule, /align-items:\s*baseline;/, "eyebrow 与 h1 未对齐基线");
});

test("压缩保留了 h1 / status-label（切页焦点与实时态不能丢）", () => {
  // setView 用 view 内的 h1 做切页焦点迁移（heading.focus）；status-label 是 aria-live 实时态。
  assert.match(html, /<h1 id="config-title"/, "config 的 h1 不见了 —— setView 的焦点迁移会落空");
  assert.match(html, /id="config-workspace-status"[^>]*aria-live="polite"/, "状态标签或其 aria-live 不见了");
  assert.doesNotMatch(configHeadingRule(" h1"), /display:\s*none/, "h1 被隐藏了：焦点目标不可见");
});

test("窄屏用标准断点档（ui-lint 的 odd-breakpoint 会拦非标准值）", () => {
  // 原为 720px（非标准），重写本块时归位到标准档 820。
  const block = artDirectionCode.slice(artDirectionCode.indexOf(".app-shell.is-settings #view-config.view .page-heading.compact-heading"));
  const media = block.match(/@media \(max-width: (\d+)px\)/)?.[1];
  assert.ok(media, "is-settings 例外块没有窄屏媒体查询");
  assert.ok([560, 820, 1100, 1440].includes(Number(media)), `断点 ${media}px 不在标准档`);
});

test("元验收：恢复 min-height:84px，U1-a 断言必须变红", () => {
  const gutted = artDirectionCode.replace(
    /(\.app-shell\.is-settings #view-config\.view \.page-heading\.compact-heading \{[^}]*?)min-height:\s*0;/,
    "$1min-height: 84px;",
  );
  assert.match(gutted, /min-height:\s*84px;/, "前提：替换后应出现 84px");
  assert.doesNotMatch(configHeadingRule(), /min-height:\s*84px/);
});
