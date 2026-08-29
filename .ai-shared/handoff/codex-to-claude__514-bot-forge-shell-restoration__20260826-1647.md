<!-- 514cc-session-id: 01a03d26-f18c-7df1-afc6-818e44e1fec6 -->
# Codex 技术执行：514 Bot 恢复 514cc 控制台视觉壳

- **时间**：2026-08-26 16:47 +08:00
- **范围**：`apps/control-center` Bot surface 视觉壳、移动断点、详情抽屉可访问性与浏览器 QA
- **状态**：`SOURCE_AND_ISOLATED_RUNTIME_VERIFIED / FULL_REGRESSION_VERIFIED / FORMAL_RUNTIME_UNVERIFIED`

## 已实施

1. 保留 `514 Bot` 品牌与 `#bot` 默认入口，恢复 514cc 单界面控制台的顶部控制栏、桌面运行状态栏、暖纸/深墨/铜橙 Forge token；Bot 项目树仍是工作面内部左栏，不叠加全局侧栏。
2. Bot 视图下继续隐藏全局 sidebar、mobile-nav、动态 atelier canvas；保留静态 Forge stage 背景，避免纯装饰动画占用聊天工作面预算。
3. 820px 以下将 Bot 壳收敛为 `topbar + main` 两行，隐藏无效汉堡入口，避免打开被 Bot 隐藏的 sidebar 后把工作面置为 `inert`，并移除不可见 mobile-nav 行造成的空带。
4. 会话详情抽屉改为 `role=dialog` + `aria-modal`，打开时锁定 roster/conversation/topbar/statusbar，补 Tab 循环和 Escape 回焦；非激活 tab 不计入 focusable 集合。
5. 修复 `public/app.js` 中不存在的 `#lucide-plug` 引用，改用离线 sprite 已登记的 `#lucide-plug-zap`。
6. 更新 `tests/bot-shell-ui.test.mjs` 与 `scripts/qa-bot-collab-dialog.mjs`，将旧的“Bot 隐藏 Forge chrome”契约替换为本轮恢复契约，并增加 820/390 computed layout、主题、焦点与截图断言。
7. 根据 LO 启动截图继续修正默认入口：`parseForgeRoute("")` 与初始化 fallback 统一进入 `workbench`，HTML 首帧直接显示原协作台；显式 `#bot` 仍进入 Bot 项目与对话面，Conversation deep link 语义不变。

## 证据

- Focused：`node --test tests/lucide-sprite-contract.test.mjs tests/bot-shell-ui.test.mjs tests/art-direction-contract.test.mjs` -> `48/48 pass`；更完整壳层 focused（含 window/sidebar）-> `58/58 pass`。
- Isolated Bot collaboration QA：`node scripts/qa-bot-collab-dialog.mjs` -> `ok: true`，Markdown/activity/stop/mention/delegation 保持通过；`restoredForgeChrome=true`、`restoredForgePalette=true`、`panelFocusContained=true`；820/390 overflow=0。
- Isolated Bot P0 QA：`npm run qa:bot-p0` -> conversation ownership、late response、history、202 admission、computer modal、四视口 inspector 均通过；1440/1024/820/390 overflow=0。
- 截图：`apps/control-center/.qa-output/bot-collab-dialog/dialog-desktop.png`、`dialog-forge-dark.png`、`dialog-820.png`、`dialog-mobile.png`、`collaboration-mobile.png` 等。
- 规则 supersession：`.ai-shared/decisions.md` `D-2026-08-26-007` 已记录本轮“恢复 514cc 控制台壳、保留 514 Bot 名称与能力”的决策。
- 启动入口 supersession：`.ai-shared/decisions.md` `D-2026-08-26-008` 已记录“514 Bot 品牌保留、无 hash 默认进入 514cc workbench、#bot 作为显式对话管理面”。

## 未闭环边界

- 正式全量 `npm test` 第二轮已回读：`1659 total / 1657 pass / 0 fail / 2 skipped`，`resource=ok / exit=ok / childexit=ok`；`npm run validate` `13/13 valid`。第一轮全量唯一失败是已修复的 `lucide-plug` sprite 漂移。
- 未 reload 正式 `127.0.0.1:51400`、未替换 Tauri EXE、未执行真实 provider/SSH；本轮证据是源码、focused 和 isolated browser，不是正式 runtime activation。
- strict delivery 仍受当前脏工作区未跟踪 must-ship 文件影响；未 commit/push。

## 总评

本轮将视觉回归控制在壳层和主题所有权，未回滚 Conversation/Run/mention/activity/delegation 等近期功能；独立复审发现并修复了移动汉堡死锁和不可见导航行问题。

__DELTA__: 烛(Codex) | 2 | 证据：`public/forge/bot-shell.css` 的 `@media (max-width: 820px)` 与 `public/app.js:15951-16029,19609-19641`；独立复审推翻“隐藏导航仅是视觉选择”的判断，补上 Bot 移动壳布局收敛、无效汉堡入口封锁与详情抽屉 focus trap。
