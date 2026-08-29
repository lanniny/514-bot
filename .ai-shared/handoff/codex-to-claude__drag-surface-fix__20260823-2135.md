<!-- 514cc-session-id: 01a02e6c-852d-79c1-b005-637f42ba18aa -->
# 拖拽失效修复交接

## 结果

- Bot 默认表面隐藏 `.topbar` 后，窗口没有可用拖拽面；`initializeWindowChrome()` 现在把 Bot 各标题栏作为 Pointer Events 拖拽面，按钮、链接、表单和 contenteditable 命中时放行。
- 高级协作台桌面 CSS 原先隐藏 `.forge-splitter-handle`，并用 `!important` 锁住两列布局；现在保留两列 fallback，移除隐藏规则，`splitter.js` 以两列模式调整左栏，右栏继续由 overlay splitter 调宽。
- 拖柄加入 `touch-action: none`，避免触控 Pointer Events 被浏览器默认手势取消。

## 证据

- 聚焦契约：`node --test tests/window-chrome-contract.test.mjs tests/workbench-rail-and-tools-contract.test.mjs`，31/31 通过。
- `npm run validate` 通过，13 项配置/注册表检查均 valid。
- 已有正式实例 `http://127.0.0.1:51400` 浏览器验证：Bot 标题栏空白区实际调用 `plugin:window|start_dragging`，按钮点击不误触发；Workbench 左拖柄从约 240px 拖到 304px 后 computed grid 为 `304px 1114px`；Mission Control 展开后 overlay 拖柄将 `--codex-context-width` 从 260px 调到 320px 并持久化。
- 全量测试：1581 pass / 2 fail / 2 skipped。失败为当前脏工作区已有的 `art-direction-contract.test.mjs` ambient canvas mock 缺失和 `lucide-sprite-contract.test.mjs` 的 `lucide-monitor` sprite 漂移，未涉及本次拖拽路径。

## 文件

- `apps/control-center/public/app.js`
- `apps/control-center/public/splitter.js`
- `apps/control-center/public/forge/workbench.css`
- `apps/control-center/public/forge/codex-desktop.css`
- `apps/control-center/tests/window-chrome-contract.test.mjs`
- `apps/control-center/tests/workbench-rail-and-tools-contract.test.mjs`

## 边界

- 本轮没有终止或重启已有正式实例；独立启动因已有实例锁被拒绝。
- Tauri 真壳窗口移动由源码契约 + 浏览器注入桥验证；未做物理桌面窗口坐标回读。

__DELTA__: 烛(Codex) | 1 | correctness | 证据：apps/control-center/public/forge/codex-desktop.css:249-260 与 public/splitter.js:51-63 修复了拖柄隐藏、布局优先级和两列 overlay 结构不一致；独立探查确认了原始不可达链路。
