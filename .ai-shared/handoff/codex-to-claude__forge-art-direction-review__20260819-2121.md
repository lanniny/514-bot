<!-- 514cc-session-id: 归属无法确认（本轮子代理上下文未注入 route-gate session marker，不猜测、不填占位符） -->
# Codex 评审：Forge Living Orchestration art direction

- **评审模式**：standard + 级联/无障碍/性能交叉（按主驾指定关注点，非全仓 deep-review）
- **评审范围**：`apps/control-center/public/forge/art-direction.css`、`public/index.html`、`public/atelier-canvas.js`、`tests/art-direction-contract.test.mjs`；对照 `forge/experience-polish.css`、`forge/console-form.css`、`forge/hero.css`；旁证 `atelier.css` reduced-motion `!important`
- **评审时间**：2026-08-19 21:21
- **评审者**：烛（代码守夜人），只读，未改源码、无 git 写操作
- **Codex 模型**：Cursor Grok 4.6 子代理执行（未走 MCP `codex-agent` 对话桥；本环境无可用 `codex-agent` MCP server）
- **自由格式**：false
- **主驾已验（采信、未复测浏览器）**：聚焦 22/22；1440×1000 与 390×844 无横向溢出；隔离实例控制台仅既有未启用模块 API 的 501

## 方法与诚实边界

- 结论踩在工作树当前文件全文 + 选择器特异性/加载顺序推理上。我**没有**打开浏览器复测溢出或聚焦。
- `index.html:10-37` 加载序已核：`experience-polish.css` → `console-form.css` → `art-direction.css`（最后）。同特异性后声明胜；`!important` 与 ID 另算。
- 铜橙 vs `#f4f0e7` 对比度按 sRGB 相对亮度估算（约 3.0:1），未用实验室测光。

---

## 致命问题（必须改）

### F1 · 亮色主题铜橙当 10px 正文字色，对比度达不到 WCAG AA

**证据**：`art-direction.css:10-14`（`--forge-paper: #f4f0e7`，`--forge-copper: #d97757`）、`:182-187`（`.page-heading .eyebrow`：`color: var(--forge-copper)`，`font-size: 10px`）、`:293-298`（`#view-team .team-hero-eyebrow` 同样 10px / `.28em` 字距）、`index.html:383` / `:1022`（这些 eyebrow 是真实可见文案，不是装饰伪元素）。

`#d97757` on `#f4f0e7` 大约 **3:1**，远低于 4.5:1（小字 AA）。铜橙作为能量轨、2px 底线、`box-shadow` 可以；作为 10px uppercase 阅读色不行。暗色 `--forge-paper: #171411`（`:22-27`）会好很多，所以这是亮色主题的定向坑。主驾已验「无横向溢出」盖不住对比度。

建议：eyebrow 改走 `--forge-ink` / `--forge-ink-soft`，铜橙只留 `::after` 发丝与 active rail；或把铜橙加深到能过 AA 再当字色。

### F2 · `prefers-reduced-motion` 没有真正关掉活体场循环

**证据**：

1. `atelier-canvas.js:52-74`：`frame()` 在 `reduced` 时仍 `requestAnimationFrame(frame)`，只是 `:74` `if (reduced) return` 跳过粒子。指针追随径向渐变每帧仍 `clearRect` + `fillRect` 全视口。
2. `atelier-canvas.js:18-20`：`matchMedia` 只读一次，没有 `change` 监听；系统中途切「减少动态效果」不会停。
3. `atelier-canvas.js:16`：`visible` 初值对，`:125-128` 隐藏页会停 RAF——这条是对的。
4. `art-direction.css:508-524`：reduced-motion 只把若干 `:hover` / `:focus-within` 的 `transform` 置 `none`，**不停** `#atelier-canvas`、不覆盖 `.atelier-stage`。
5. `experience-polish.css:1899-1902`：`.atelier-stage { display: none }` 在 reduced-motion 里。特异性 `(0,1,0)`。`art-direction.css:36-38` 无媒体查询的 `.atelier-stage { display: block }` 同特异性且后加载 → **舞台在减少动态时被重新点亮**。
6. `atelier.css:602-607`：`#atelier-canvas { display: none !important }` 仍能藏画布（art-direction `:58-62` 无 `!important`）。结果是：用户要减少动态时，**网格+铜晕舞台仍在，JS 仍对一块 `display:none` 的 canvas 空转 RAF**。

`html[data-motion="reduce"]`（`experience-polish.css:1562-1568`）用 `!important` 砍 CSS animation/transition，**砍不到** canvas RAF。

建议：`reduced || document.hidden` 时 `cancelAnimationFrame` 且不再调度；art-direction 的 reduce 块里显式 `display: none`（或等价）盖住 stage/canvas，不要让无媒体查询的 `display: block` 回手一掌。

### F3 · 契约测试是字符串存在性，给级联与动效一张假绿牌

**证据**：`tests/art-direction-contract.test.mjs:25-43` 只断言 `indexOf("./forge/console-form.css") < art-direction`，以及 CSS **原文包含** `--forge-copper:`、`.atelier-stage {`、`@media (prefers-reduced-motion: reduce)`。不断言：

- 加载序是否也晚于 `experience-polish.css`（真正藏 canvas / 藏 sidebar / 压标题的那一层，`index.html:33-37`）。
- `#atelier-canvas { display: block }`（`art-direction.css:58-62`）能否打过 polish `:18-23` 的 `#atelier-canvas { display: none }`。今天碰巧能，因为同特异性后文件胜；谁把 polish 挪到后面或加 `!important`，测试仍绿、画布已死。
- reduced-motion 是否停 RAF。` :68-73` 只查 `rgba(217, 119, 87` 子串和 `'document.addEventListener("visibilitychange", onVisibilityChange)'` 以及 `if (!visible)`。F2 的「reduce 仍 RAF」**完全能绿**。
- Lucide：`:61-66` 只扫 `index.html` 的 `<use href="#...">`。`index.html:317-321` 的 `#chrome-rail-toggle` 是内联 path，不进该正则；JS 运行时插的图标也不进。`emoji` 扫描（`:46-58`）只扫 `public/**/*.html|js|css` 静态文件，且 `stripComments` 会吃掉注释里的符号。

这不是「测试不够多」，是合同测了「文件里写过这些字」，没测「用户看见的级联赢家」。主驾 22/22 聚焦绿与这份合同正交。

---

## 建议改进（值得讨论）

### S1 · ID 选择器把 console-form 九轮 L 形实色 chrome 打成半透明纸 + blur

**证据**：`console-form.css:1312-1323` 用 `.atelier .workbench-shell { background: var(--sidebar) }` 把轨/顶栏/壳铺成同一 chrome。`art-direction.css:338-363` 用 `#view-workbench .workbench-shell` / `.run-rail` / `.conversation-pane`（特异性带 ID，`(1,1,0)` > `(0,2,0)`）改成 `color-mix(..., paper 82%)` + `backdrop-filter: blur(22px)`。

顶栏则相反：`console-form.css:1312-1316` `body.atelier .topbar`（`(0,2,1)`）压过 `art-direction.css:149-153` `.atelier .topbar`（`(0,2,0)`）的半透明+blur。结果是 **顶栏实色、工作台壳磨砂**，L 形一体被撕开。

`experience-polish.css:25-35` 明确把 rail/pane/topbar 的 `backdrop-filter: none` 当作「安静工作面」。艺术层只在部分节点赢，造成「意图是最终视觉所有者，实际是花斑级联」。

### S2 · 会动的全视口 canvas × 多层 `backdrop-filter` × `mix-blend-mode`

**证据**：`atelier-canvas.js:61-72, 95-110` 每帧清屏+径向填充+最多 22 粒子的 O(n²) 线段（距离 < 140 才 stroke）。`art-direction.css:58-66` `mix-blend-mode: multiply|screen`，`:80 :153 :226 :349` 又给 sidebar/topbar/卡片/workbench-shell 18–28px blur。模糊层的背后只要 canvas 在动，合成器就要重算 backdrop。侧栏本身被 polish `:427-437` `display: none !important` 藏掉，`:76-81` 的 blur 是死代码，但 workbench-shell / 卡片 / 度量卡仍在。

未做帧时实测；低端核显上这是第一嫌疑。reduce 路径应直接不启动（见 F2），而不是画完再 return。

### S3 · 团队页移动端垂直税：艺术层把星图舞台抬到 340px

**证据**：`hero.css:37-43` `height: min(42vh, 380px); min-height: 280px`；`:156-159` ≤720px 收到 `260/240`。`art-direction.css:332-335` 无媒体查询改成 `min(58vh, 580px)/360px`；`:469-472` ≤820px 再写成 `340/300`。同特异性后文件胜，`hero.css` 的 720px 收口作废。

控件顺序还好：`index.html:1021-1075` 命令甲板在星图之前，390×844 上激活/新建多半仍在首屏。吃高度的是「团队编排」里的星图，内部滚动会变长。若目标是手机上也能操作星图，至少让 ≤820 回到 hero.css 的 260px 档。

### S4 · 铜橙语义与外观强调色分裂

**证据**：`tokens.css:19-20` 默认 `--primary` 已是铜橙。`experience-polish.css:1613-1665` 把 `html[data-accent="rose"|"teal"|"indigo"]` 的 `--primary`/`--rose` 整组换掉。`art-direction.css` 全程 `--forge-copper`，不读 `--primary`。外观页换强调色后：按钮/焦点环/diff 走新色，eyebrow/active 发丝/composer 铜边仍是 `#d97757`。

若「铜橙是编排能量、不是可换品牌色」——应在外观 UI 写死铜橙不可替换，或 art-direction 改 `color-mix(var(--primary))`。现在两套故事同时为真。

### S5 · 实验排版可能挤关键操作行（横向已验，纵向/焦点未作为合同）

**证据**：`art-direction.css:161-168` 非 workbench 标题 `min-height: clamp(150px, 24vh, 270px)`；`:190-198` `h1` `clamp(46px, 7vw, 104px)`、`max-width: 12ch`、`line-height: .88`。`experience-polish.css:109-113` `.compact-heading h1 { font-size: 20px }` 特异性更高（多一个 class），带 `compact-heading` 的页（工作台头、多数设置）不会炸字号。`index.html:381-396` **总览标题没有** `compact-heading`，会吃 46–104px 档；同文件 `:387-396` 的「配置检查 / 新建任务」靠 `align-items: flex-end`（art `:164`）贴在超大标题右侧。1440 无横向溢出可采信；键盘 `:focus-visible` 仍来自 polish `:217-220`，但 art 给 `.button:hover` `translateY(-2px)`（`:403-407`），`workbench-shell { overflow: hidden }`（art `:344`）+ composer `focus-within` `translateY(-3px)`（`:386-387`）可能裁切焦点环下缘。合同测试未锁这些。

### S6 · 画布生命周期不完整

**证据**：`atelier-canvas.js:136-139` `beforeunload` 只摘 `visibilitychange`。`resize` / `pointermove`（`:131-132`）常驻。SPA 内这不是泄漏源，但和 F2 同一类：没有「停机」API。`themeInk()`（`:44-49`）每帧读 `dataset.theme`，便宜；亮色粒子却是 `rgba(184, 92, 62)` 而测试只锁 `217, 119, 87` 的 glow。

---

## 可保留（看似奇怪但合理）

### K1 · 艺术层最后加载

`index.html:34-37` 注释仍写 console-form「最后加载」，随即又挂上 art-direction。以「视觉所有者」为目标，后挂是对的。测试至少锁了相对 console-form 的顺序（`art-direction-contract.test.mjs:27-29`）。不要再把 polish 挪到它后面，除非同时加 `!important` 或提高特异性——否则 F3 会立刻变成线上回归。

### K2 · Lucide + `icon-cli-*` 双轨

`index.html:49-52` 写明 CLI 官方徽标没有 Lucide 等价物。测试 `:61-66` 允许 `#icon-cli-` 前缀。合理。内联 rail glyph（`:317-321`）也不是 emoji。

### K3 · 侧栏 `display: none !important` 艺术层盖不住

`experience-polish.css:427-437` 藏 `#sidebar` / 汉堡 / 底栏。art-direction 给 `.atelier .sidebar` 写的铜轨和 blur（`:76-147`）全部空转。这是既有信息架构（头像进设置才见全导航），不是这次艺术层引入的导航丢失。不要为了「侧栏好看」去掉 `!important`，除非产品改回常驻轨。

### K4 · 粒子数 22 / DPR cap 2

`atelier-canvas.js:10, 24`。在 F2 停机之前，这已经是克制过的装饰预算。不要先加粒子。

### K5 · Team 标题从 sr-only 拉回来

polish `:140-156` 把 `.team-hero-title` clip 成 1px。art `:301-308` 用同等特异性后声明拉回可见，符合「恢复被藏的 thesis」。标题 `id="team-title"`（`index.html:1020-1023`）对 `aria-labelledby` 仍然成立。

### K6 · 主驾已验的横向溢出与聚焦套件

本次未复测。未发现必然导致横向滚动的 `100vw`/`translateX` 新债（nav hover 只 `translateX(3px)`，`:126-128`）。不据此改 verdict。

---

## 总评

艺术方向本身清楚：暖纸、深墨、铜橙只出现在意图/焦点/执行上，Lucide-only，UI 静态源无 emoji。加载序也选对了「最后一枪」。

级联没有真正成为「单一所有者」。ID 打穿了 console-form 的实色 L chrome；无媒体查询的 `display: block` 打穿了 polish 的 reduce 藏舞台；铜橙当 10px 字色在亮色主题过不了 AA；canvas 把 reduce 理解成「少画两点」而不是「停机」。合同测试把这些全部标成绿。

横向溢出与 22 条聚焦绿，说明「能用」的底盘还在；它们不证明「看见的就是 art-direction.css 里写的那个世界」。

先改 F1–F3（字色、reduce 停 RAF+锁 stage、测试改为断言赢家样式/行为），S1/S2 作为同一场性能/一致性修补。然后再谈更大的标题和星图高度。

---

## 复检（2026-08-19 21:41 · IR / diff-only）

主驾已修 F1–F3 及 S1/S2/S3/S6 与 Lucide 轨钮。本轮只对照修复后源码 + 实跑合同，未改源码、无 git 写操作。未复开浏览器；采信主驾 390×844：`heroStage=260`、`overflowX=false`、eyebrow `rgb(152, 65, 38)`。

我验证了：`node --test tests/art-direction-contract.test.mjs tests/chrome-menus-contract.test.mjs` → **tests 10 / pass 10 / fail 0**（duration 257ms）。

### F1 关闭

`art-direction.css:16` `--forge-copper-ink: #984126`；暗色 `:28` `#f0a17d`。10px eyebrow 走该 token（`:188-189`、`:299-300`），能量色 `--forge-copper` 仍只用于轨/线/glow。`#984126` = `rgb(152, 65, 38)`，与主驾实测一致。合同 `art-direction-contract.test.mjs:66-68` 用同一套相对亮度公式断言亮色 ≥4.5，本轮测试绿。

### F2 关闭

`atelier-canvas.js:54-56`：`frame` 入口若 `!visible || reduced` 则 `raf=0` 并 return，不再预约下一帧。`:123-150` `stop`/`start`/`onMotionChange`；`reduced` 初始 `start()` 被挡住；`motionQuery` `change` 会停/启。`:152-158` 同时摘掉 resize/pointermove/visibility/motion。`art-direction.css:514-518` 在文件后部 reduce 块把 `.atelier-stage, #atelier-canvas { display: none }` 放在无媒体查询的 `display: block`（`:38-41`、`:60-61`）之后，特异性相同、后声明胜，polish 被后加载 `block` 点亮舞台的级联坑已堵上。

### F3 关闭

合同现锁 `polishIndex < consoleIndex < artIndex`（`:39-45`）、reduce 的 stage+canvas `display: none` 正则（`:60-64`）、亮色对比度、以及 `vm` 动态：reduce 初值 `rafCalls===0`，切回运动 `rafCalls===1`，`hidden` 后 `cancelled===1`（`:95-149`）。Lucide 轨钮锁 `#lucide-panel-left` 且禁止自绘 `chrome-rail-glyph-(frame|bar|hint)`（`:86-92`）。这不再是「文件里出现过这些字」。

### 建议项与修复回归

| 项 | 复检 |
|---|---|
| S1/S2 | 工作台/顶栏/卡片 `backdrop-filter: none`；topbar/workbench 纸面 96–97%（`:151-159`、`:349-356`）。**残留**：隐藏侧栏仍写 `blur(24px)`（`:78-83`），用户不可见（polish `!important` 藏轨），不重开致命。 |
| S3 | ≤820px `.hero-stage { height: 260px; min-height: 240px }`（`:475-478`），与 hero.css 收口对齐。采信 390 实测 260。关闭。 |
| S6 | beforeunload 现成对停机。关闭。 |
| Lucide 轨钮 | `index.html:317-318` `use href="#lucide-panel-left"`；`app.js:1293` 按 collapsed 切 `panel-right`/`panel-left`；sprite 含 `lucide-panel-left`。chrome 合同仍绿。 |
| S4 / S5 | 未改，仍是建议，不挡 APPROVED。 |

**未发现新回归**足以打回 CHANGES_REQUESTED。对比度合同仍硬编码 hex、不解析 CSS 变量——token 与测试字面今日一致；漂移时会再假绿，记为卫生债，不重开 F3。

---

## 下游建议

### 建议召唤

- 无。F1–F3 已关。S4 强调色叙事若要收口，等外观产品决定后再改。

### 风险信号

- 侧栏仍有一套看不见的 blur/铜轨，下次若重新显示侧栏会突然多一层玻璃。
- 对比度断言请与 `--forge-copper-ink` 同一次修改，避免字面量分叉。

__VERDICT__: APPROVED
__DELTA__: 烛(Codex) | 1 | 证据：apps/control-center/public/forge/art-direction.css:182 亮色 10px 铜橙对比度不足；atelier-canvas.js:52 reduced 仍 RAF；tests/art-direction-contract.test.mjs:25 字符串合同不测级联赢家
