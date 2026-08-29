<!-- 514cc-session-id: 归属无法确认（本轮子代理上下文未注入 route-gate session marker，不猜测、不填占位符） -->
# Codex 评审：config-bus-ui-review

- **评审模式**：deep-review（缺陷优先：正确性 / 级联 / 浏览器 / 响应式 / a11y / 性能 / 测试稳健性）
- **评审范围**：仅 `apps/control-center/public/forge/data.css`、`apps/control-center/public/forge/art-direction.css`、`apps/control-center/tests/config-topology-ui.test.mjs` 中最新 Configuration bus / 页头压缩相关未提交改动。对照只读：`index.html` 样式加载序、`experience-polish.css` compact-heading、`tokens.css` z 轴、`app.js` 供应商行动点 markup。
- **评审时间**：2026-08-20 15:18（R1） / 2026-08-20 15:43（R2 复检）
- **评审者**：烛（代码守夜人），只读，未改源码、无 git 写操作
- **Codex 模型**：Cursor Grok 4.6 子代理执行（未走 MCP `codex-agent` 对话桥）
- **自由格式**：false
- **诚实边界**：R1 踩在工作树全文 + 选择器特异性 / 加载顺序推理上，当时未开浏览器。R2 复检盘面规则；运行时数字采信主驾：390px heading 28px、供应商行动点 display:grid、overflow 0、1200=640/240 sticky、1050=493/240 sticky + toolbar column、990 单列 static、focused tests 46/46。我未复跑浏览器。
- **结论文档**：R1 四节保留为审计底稿。最终判决以文末 **R2 复检** 为准。

## 方法

- `index.html:13-37` 加载序：`data.css` → … → `hooks.css` / `runtime-workbench.css` → `experience-polish.css` → `console-form.css` → `art-direction.css`（最后）。同特异性后声明胜；ID / `:not(#id)` 计入特异性。
- 同一文件内后写规则覆盖先写规则；后写的无媒体查询声明会盖掉先写的 `@media` 里同选择器同属性。

---

## 致命问题（必须改）

### F1 · 720px 把供应商行的编辑/复制/检查藏掉，只留删除

**证据**：`data.css:2491-2494`

```css
@media (max-width: 720px) {
  #config-surface-providers .provider-row-actions .icon-button:not(:last-child) {
    display: none;
  }
}
```

`app.js:10376-10382` 行动点顺序是：启用/状态丸（非 icon-button）→ 编辑 → 复制 → 连通性 → 用量 → **删除（最后一个 icon-button）**。窄屏因此可点启用和删除，**不能编辑档案**。排序模式的上/下移同样是 icon-button，也会被藏掉。

这不是装饰收缩：是把主操作藏掉、把破坏性操作留在可见槽。390 宽 QA 若只断言「无横向溢出」，盖不住这条功能回归。

改法：窄屏改溢出菜单 / 保留编辑为带字按钮；禁止 `display:none` 只露出删除。

### F2 · art-direction「压缩页头」整段未赢级联，测试却锁死源码字符串

**证据（新规则）**：`art-direction.css:840-856`（`#view-config .page-heading` `min-height: 84px`；`h1` `clamp(30px, 3.2vw, 46px)`）。注释自称「loads last and intentionally owns the exception」。

**证据（实际赢家）**：`experience-polish.css:88-113`

- `.view:not(#view-workbench) .page-heading` → `(1, 2, 0)`，`min-height: 0`
- `.view:not(#view-workbench) .page-heading.compact-heading h1` → `(1, 3, 1)`，`font-size: 20px`

`index.html:1487` 配置页头是 `page-heading compact-heading`。`#view-config .page-heading h1` 只有 `(1, 1, 1)`。art-direction 后加载也打不赢。`::after` 宽度同理输给 `.view:not(#view-workbench) .page-heading::after` (`art-direction.css:176-186` vs `:847-849`)。

**证据（假绿）**：`config-topology-ui.test.mjs:307-308` 只 `assert.match(artDirectionCss, /min-height:\s*84px/)` 和 `clamp\(30px…46px\)`，不计算特异性、不读计算样式。契约写成了「文件里有这行字」。

运行时配置页头仍是 polish 的 20px 紧凑条，不是 84px / 30–46px 坐标条。要么把选择器升到至少 `#view-config.view .page-heading.compact-heading h1`，要么删掉无效例外、改测试去锁真正生效的 compact-heading。

### F3 · Configuration bus 后写无媒体查询，把 1280/1000 脊柱网格判死；测试仍认死断点

**证据**：

| 先写（已死或半死） | 后写（真生效） |
|---|---|
| `data.css:2475-2488` `@media (max-width: 1280px)` 第二列 240px；`1000px` 单列 + `position: static` | `data.css:2684-2687` **无媒体查询** `minmax(0,1fr) minmax(280px,320px)` |
| | `data.css:2833-2850` `@media (max-width: 1120px)` 单列 + spine `static` |

同选择器、同属性：后写的无查询声明在 1200px 视口盖掉 1280 媒体块。1280 的 240px 列**永不生效**。1000px 的 static 被 1120px 块替代（1050px 已 static），1000 块只剩与 1120 重复的单列。

**证据（假绿）**：`config-topology-ui.test.mjs:298-302` 用 `[\s\S]+` 证明源码里「存在」1280/1000/720/560 字符串。存在 ≠ 级联获胜。

`--config-gutter`（`data.css:2512`、`:2855`）全文件无消费，是同一类死契约。

---

## 建议改进（值得讨论）

### S1 · 560px 能力概览 1 列被后写 720px 2 列盖掉

`data.css:2197-2218`（`max-width: 560px`）把 `.cap-overview` 收成 `minmax(0,1fr)`。`data.css:2878-2888` 同文件更后的 720px 块改成 `repeat(2, …)` 并给第 2 卡去右边框。390px 仍是 2×2，长 `cap-stat-sub`（`data.css:1002-1006` nowrap）再叠加 `:2755-2760` `overflow: hidden`，窄屏更容易裁字。应把 1 列规则放到 720 块之后，或 560 再覆盖一次。

### S2 · sticky 磨砂条缺 `-webkit-backdrop-filter`，且 `flex-wrap: nowrap` + 父级 `overflow: hidden`

`data.css:2517-2534`：`backdrop-filter` 无 webkit 前缀（同仓 `shell.css` / `primitives.css` 都成对写了）。`.config-topology { overflow: hidden }` 依赖子级 `overflow-x: auto`（`:209-219` 仍在）做横滑；父级裁切让焦点环/下拉更容易被吃。

`data.css:2557-2567` 给 `.config-host-bar` 加 `max-width: min(46%, 560px)`、`overflow-x: auto`、`scrollbar-width: none`。配置目标芯片可滑但**看不见滚动条**，键盘/触控发现性差。1120 以下已 `max-width: none`（`:2839-2841`），桌面宽才中招。

### S3 · 搜索框 `outline: none` 无 `:focus-visible` / `:focus-within`

`data.css:2389-2397`。外层 `.provider-search` 只有静态边框（`:2371-2380`、`:2676-2681`），键盘焦点没有新环。与配置页签已有的 `:focus-visible`（`:249-252`）不一致。

### S4 · 工作台标题统一语法被后加载 CSS 打回 18px

`data.css:2618-2624` 想把 `.ccs-heading h2` 拉到 `clamp(19px, 1.8vw, 24px)`，特异性 `(1, 1, 1)`。`runtime-workbench.css:26-30`（`index.html:30`，晚于 `data.css:18`）`#view-config .ccswitch-workbench .ccs-heading h2` 是 `(1, 2, 1)`，`font-size: 18px`。五面「一种标题」在本机运行时面不成立。

### S5 · 选中行轮廓被后写规则清掉；列表 `overflow: hidden` 吃焦点环

`data.css:2463-2465` 给 `.provider-row.is-selected` 铜描边；`:2726-2728` 改成 `outline: 0` + inset 条。`:2693-2698` `.provider-row-list:has(.provider-row) { overflow: hidden }` 会裁 `outline`。选中态只靠 3px inset，和键盘焦点抢同一条视觉通道。

### S6 · 测试是源码考古，不是布局/a11y 合同

`config-topology-ui.test.mjs:269-308` 把 app.js 字符串、HTML 文案、死媒体查询、art-direction 字面量塞进同一个 300 行用例。`[\s\S]+` 会跨多个 `@media` 块配对。`doesNotMatch(html, /模型设置/)` 过脆。应拆：级联生效（计算样式或「后写块必须包含/覆盖先写断点」）、窄屏行动点可见性、art-direction 选择器特异性。

### S7 · 性能与运动

`data.css:2584-2587` 每次去掉 `[hidden]` 都跑 `config-plane-arrive`（opacity + transform）。`:2895-2898` 只关这一条，toolbar 的 blur(18px)（`:2528`）和既有 node `transition`（`:241`）仍在。磨砂 sticky 在长列表上滚动会持续合成层；可接受，但应给 `prefers-reduced-motion` 关掉 backdrop blur 或降到 solid fill（对 vestibular 敏感用户，大面积 blur 有时也算动效）。

### S8 · `:has()` 无回退时脊柱隐藏仍留空列

`data.css:2689-2691` 靠 `:has(.provider-spine:not([hidden]))` 收列。不支持 `:has` 时 `:2684-2687` 的 280–320px 轨道仍在，而 `[hidden]` 的 aside 不占 grid item，右侧会空一截。本应用多半是 Chromium webview，风险低于 F1–F3，但不要让测试把 `:has` 当成全浏览器合同。

---

## 可保留（看似奇怪但合理）

### K1 · 配置页不用 46–104px 社论页头

`index.html:1487` 已用 `compact-heading`。相对 `art-direction.css:196-205` 的 `clamp(46px, 7vw, 104px)` 英雄标题，控制面就该矮。问题是新 84px/30–46px 例外没生效（见 F2），不是「不该压缩」。

### K2 · sticky 工具条 `z-index: 200`

`data.css:189-191` 原 `z-index: 6`；bus 改 `var(--z-sticky, 200)`（`tokens.css:76`）。`.context-menu` 是 `z-index: 320`（`styles.css:5555-5557`），模态 `--z-modal: 1000`。磨砂条不会盖住菜单/对话框。`position: sticky` 仍由先写块提供，后写块没丢掉。

### K3 · 面板切入动画有 reduced-motion 门

`data.css:2600-2604` + `:2895-2898`。Forge README 要求新动画进 reduce 门，这条齐。不要把它当成「所有新视觉动效都关了」（见 S7）。

### K4 · 铜轨 `::before` 在 720 关掉

`data.css:2589-2597` `left: -14px; z-index: -1`，`:2864-2866` 窄屏 `display: none`。避免和 `:2498-2499` 的 `overflow-x: hidden` 打架。装饰轨用伪元素而不是 DOM 节点，合理。

### K5 · `:has()` 收起空脊柱列（在 Chromium 下）

`data.css:2689-2691` 意图正确：`[hidden]` 的 aside 不是 grid item，必须显式把模板收成一列。不要删这个选择器去「简化」；要修的是 F3 的断点叠罗汉和 S8 的回退。

---

## 总评

Configuration bus 把铜洗、磨砂 sticky 轨、统一 heading token、脊柱 sticky 和能力概览拼条往五面上堆，方向对：配置图谱该是操作条，不是社论落地页。但这一轮把**后写覆盖**和**源码正则测试**当成验收，三处合同是假的：

1. 720px 行动点收缩会藏编辑、留删除（F1）。
2. art-direction 压缩页头选择器打不赢 `compact-heading`（F2）。
3. 1280/1000 脊柱网格被 bus 无查询声明 + 1120 块判死，测试仍绿（F3）。

未做浏览器复测。修 F1–F3 之前不要把「统一视觉语法已落地」写进决策。建议先升 art-direction 特异性或删死规则、合并成一套媒体查询（只留 1120/720/560）、窄屏行动点改为菜单而不是 `display:none`，测试改锁计算级联而不是「文件里有注释」。

> R1 `__VERDICT__` / `__DELTA__` 已撤到文末，避免双账本。R1 当时判决是 CHANGES_REQUESTED / DELTA 2。

---

## R2 复检（2026-08-20 15:43）

对照 R1 每条发现读当前盘面。主驾运行时证据采信，未复开浏览器。

### 核验表

| R1 | 状态 | 盘面证据 |
|---|---|---|
| F1 720px 藏 icon-button 只留删除 | **已关** | 全仓无 `.icon-button:not(:last-child){display:none}`。`data.css:2886-2899` 改为换行 + `width:100%` + `justify-content:flex-end`，不隐藏。测试 `:303` `doesNotMatch` 该选择器。主驾：390px 全部行动点 `display:grid`。 |
| F2 页头打不赢 polish | **已关** | `art-direction.css:851-856` 现为 `.app-shell.is-settings #view-config.view .page-heading.compact-heading h1` = `(1, 5, 1)`，与 `experience-polish.css:752-755` 同特异性且后加载。720 块 `:876-878` 锁 `28px`。主驾：390px computed heading **28px**。测试 `:310-311` 已锁新选择器。 |
| F3 1280/1000 被无查询声明判死 | **已关** | 无查询模板仍在 `data.css:2668-2670`；**1280/1000 媒体块改到其后** `:2817-2842`。1120 块 `:2823-2833` **只堆工具条，不再塌脊柱**。1200/1050 → 后写 1280 的 `… 240px` + sticky（`:2406-2408` + `:2725-2726` `top:64px`）；990 → 后写 1000 单列 + `static`。与主驾 640/240、493/240、990 单列一致。先写的 1280/1000 脊柱块已不存在。 |
| S1 560 cap-overview | **已关** | `data.css:2902-2915` 写在 720 的 2 列块之后，390 应得 1 列。 |
| S2 webkit backdrop | **部分关** | `-webkit-backdrop-filter` 已与 `backdrop-filter` 成对（`:2506-2507`）。`.config-topology { overflow: hidden }`（`:2510-2513`）与 host-bar 藏滚动条（`:2536-2546`）仍在。 |
| S3 搜索焦点环 | **已关** | `data.css:2663-2666` `:focus-within` 2px 铜环。input 仍 `outline: none`（`:2396`），环在容器上，可接受。 |
| S4 运行时标题级联 | **已关** | `runtime-workbench.css:26-32` 现与 bus 同为 `clamp(19px, 1.8vw, 24px)` / weight 580。后加载文件不再打回 18px。 |
| S5 选中 outline / overflow hidden | **仍开** | `data.css:2710-2713` 仍 `outline: 0`；`:2677-2683` 列表 `overflow: hidden`。 |
| S6 测试稳健性 | **部分关** | 补了破坏选择器负向断言 + 更高特异性页头选择器，仍是源码正则，未锁计算样式。主驾 focused 46/46 另账。 |
| S7 磨砂进 reduce | **仍开** | reduce 只关 `config-plane-arrive`（`:2918-2921`）。 |
| S8 `:has()` 回退 | **仍开** | `:2673-2675` 仍无非 `:has` 回退。Chromium Console 可留。 |
| `--config-gutter` | **仍死** | 只定义于 `:2490`、`:2847`，无消费。 |

### 致命问题（必须改）

无。R1 三条致命均已在盘面和主驾运行时对上。

### 建议改进（值得讨论）

- S5 选中行 `outline: 0` + 列表裁切仍在；若键盘选中要可见，用 inset 条以外再补 `:focus-visible`。
- S6 源码考古测试仍可能把未来死规则锁绿；级联合同更适合放计算样式或「1280 块必须出现在无查询 `grid-template-columns` 之后」。
- S7 / 藏滚动条 / `--config-gutter` 未消费：非阻塞。

### 可保留

R1 K2–K5 仍成立。F2 修好后 K1 的「例外未生效」不再适用：settings 壳内配置页头现在就是 84px 条 / 窄屏 28px。

### 总评（R2）

主驾四条验收在盘面上成立：破坏性窄屏选择器已删且 720 改为整行行动点；页头选择器已压过 `.app-shell.is-settings` compact-heading；脊柱两列在 1200/1050 由后置 1280 媒体块保活，只在 1000 以下塌成单列 static；560 概览、webkit 磨砂、搜索 `:focus-within`、工作台标题已对齐。残余是 S5/S6/S7/S8 级建议，不挡这一轮视觉语法。

__VERDICT__: APPROVED
__DELTA__: 烛(Codex) | 1 | 证据：R1 推翻已闭环（data.css:2886-2899 不再藏删除；art-direction.css:851 胜 polish:752；data.css:2817-2842 后置 1280/1000）；R2 补强残余 data.css:2710 outline:0
