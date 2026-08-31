# Control Center 前端体检与综合优化（2026-07-18）

方向：LO 要求"优化完善前端界面"，选定全面体检 + 视觉打磨 + 交互完善 + 响应式。
方法：Playwright 7 视图 × 桌面/移动/平板实拍走查 + app.js/styles.css 代码审计，逐项修复后回归。

## 修复清单（file:line 以改动后为准）

| # | 问题 | 修复 | 位置 |
|---|------|------|------|
| 1 | 切页后 h1 带紫色焦点框（:focus-visible 命中程序化聚焦） | `.view h1:focus { outline: none }` | styles.css:184 |
| 2 | 配置源徽标截断（MARK/PYTH 残词） | FORMAT_BADGES 缩写表 + 徽标自适应宽度 | app.js:1042 / styles.css:2541 |
| 3 | rail-statusline nerd-font PUA 图标豆腐块 | 通用字形 ◆/📁/∑/◈ | app.js:1646-1649 |
| 4 | 会话聚合首次进入白屏、失败后卡"正在扫描" | fetch 前先画加载态；sessionsError 失败态 | app.js:923-952 |
| 5 | 体系观测三表初始空表头 | "正在读取…"占位行 + 加载失败行内文案 | index.html:766,781,797 / app.js:878-887 |
| 6 | 摘要列全空、会话 ID 截断无提示 | "—"占位 + title 全文 | app.js:944-950 |
| 7 | 无暗色模式 | 双主题令牌架构 + 顶栏开关 | styles.css:63-115 / theme.js / app.js:474-519 |

## 暗色「暖墨」主题要点

- `[data-theme="dark"]` 只翻 :root 令牌（约 40 var），零组件规则改动。
- 关键解耦：新增 `--rose-fill/--rose-fill-bright/--red-fill` 固定白字填充令牌；暗色里 `--rose` 提亮为文字色 #d97a52，`.button.primary/.send-button/.brand-mark/.button.danger` 改走 fill 令牌（styles.css:30-33）。
- 防首帧闪烁：theme.js 为 head 同步引导（CSP script-src 'self' 禁内联故独立文件）；server.mjs:99 静态白名单已加 theme.js。
- localStorage `514cc-control-theme`；未显式选择时跟随 prefers-color-scheme。

## QA harness 修复

qa-ui.mjs `[data-view]:visible` 命中屏外抽屉按钮（三套导航并存）导致桌面用例恒超时 → clickView() 按 DOM 可见性过滤（scripts/qa-ui.mjs:20-34）。

## 验证

- `npm test`：90/90 通过（注：dev server 运行时跑全量测试会因 instance-lock 误伤 orchestrator 用例，停服后全绿）。
- `qa:ui --suite=all`：desktop/mobile 布局 + workbench 状态机，0 错误。
- 实拍复核：亮色 7 视图无焦点框、徽标正常；暗色桌面/移动/平板无横向溢出、对比度目测达标。
- 截图存根：apps/control-center/.qa-output/{walk,verify,final}/（scratch，不入档）。

## 未做（留 roadmap）

- 暗色对比度未做机械验证（亮色曾有烛 R8 的 ≥4.5 机械核验流程，值得对暗色复跑一次）。
- 移动端底部 tab 仍无 路由/安全 入口（走抽屉可达，沿用现状）。
- DESIGN-NOTES roadmap 原有项（命令面板、审批内联等）未动。

__DELTA__: Kimi(主驾) | 1补强 | 前端 7 项体检问题全修复+暗色双主题令牌架构；证据 styles.css:63-115, app.js:474-519, qa:ui 全绿, node --test 90/90
