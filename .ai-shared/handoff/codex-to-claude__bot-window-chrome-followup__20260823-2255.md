<!-- 514cc-session-id: 01a02e6c-852d-79c1-b005-637f42ba18aa -->
# Bot 默认桌面窗口控件续修

## 结论

默认 `514 Bot` 路由会隐藏旧 Forge `.topbar`，因此原有 `− / □ / ×` 随父节点一起不可见。已在 Bot 对话标题栏增加独立窗口控件宿主，并复用现有 Tauri 窗口命令。

## 改动

- `apps/control-center/public/index.html:562`：增加 `bot-window-controls` 及最小化、最大化/还原、关闭三个按钮，默认 `hidden`。
- `apps/control-center/public/app.js:329,1397-1408`：登记 Bot 控件，桌面桥接存在时显示并绑定 `plugin:window|minimize`、`plugin:window|toggle_maximize`、`plugin:window|close`。
- `apps/control-center/public/forge/bot-shell.css:177-181`：对 Bot 标题栏控件使用 Bot 主题色与关闭态 hover；按钮区仍被拖动交互选择器排除。
- `apps/control-center/tests/window-chrome-contract.test.mjs:33-78`：覆盖 Bot 控件宿主、图标、缓存登记、桌面初始化与浏览器早退契约。

## 证据

- 聚焦契约：`33 pass / 0 fail`（window chrome、Lucide sprite、Workbench rail/tools）。
- `npm run validate`：`13/13 valid`。
- 隔离 Control Center + Playwright：Bot 三钮均 `display:flex`、宽 `32px`；点击分别发出三个窗口命令；标题栏单击发出 `plugin:window|start_dragging`，双击发出 `plugin:window|toggle_maximize`。
- 同实例切换 `#/workbench`：旧三钮仍可见，宽 `34px`。
- 视觉回读：`C:/Users/16643/AppData/Local/Temp/514cc-bot-window-controls.png`。

全量 `npm test` 未作为本轮交付门禁；历史运行曾在长生命周期句柄处不退出，当前只报告上述聚焦结果。

__DELTA__: 烛(Codex) | 1 | 证据：apps/control-center/public/index.html:562、apps/control-center/public/app.js:1397-1408 将默认 Bot 页面从隐藏旧 topbar 的窗口控件契约补齐为独立桌面宿主，并以隔离浏览器回读确认真实可见与可调用
