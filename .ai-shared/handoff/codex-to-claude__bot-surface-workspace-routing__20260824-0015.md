<!-- 514cc-session-id: 01a02e6c-852d-79c1-b005-637f542ba18aa -->
# Bot Surface Workspace Routing

## 结果

Bot 的普通入口不再调用旧 Forge 视图：

- `查看全部自动化` 打开 Bot 内部 `#bot-workspace-panel` 的自动化页。
- `连接频道` 打开同一工作区的频道页。
- 插件认证、插件安装/卸载、Cursor 登录/退出、Team Setup 入口保留在 Bot Settings 内部 tab。
- 原有 `automations-page.js` 与 `channels-panel.js` 节点运行时移动到 Bot 工作区，继续使用原 API、状态和写入逻辑；关闭工作区后恢复原 DOM 位置。

## 证据

- `apps/control-center/public/app.js:2360` 附近：离开 Bot 时关闭工作区且不把焦点还给隐藏 Bot 节点。
- `apps/control-center/public/app.js:15600` 附近：Bot 工作区打开、tab 切换、节点挂载/恢复、焦点陷阱。
- `apps/control-center/public/app.js:15970` 附近：`routines`/`channels`/插件/Team actions 均不再调用旧 `setView`。
- `apps/control-center/public/index.html:580` 附近：Bot 工作区 dialog、自动化/频道两个内部 tab 与挂载点。
- `apps/control-center/public/channels-panel.js:412`：`refreshChannelsPanel(rootOverride)` 支持 Bot 挂载点刷新。
- `apps/control-center/public/modules/automations-page.js:33`、`:130`：支持 `#bot/automations/...` 兼容深链及可选 route prefix。

## 验证

- `node --check public/app.js` 通过。
- `node --check public/channels-panel.js` 通过。
- `node --check public/modules/automations-page.js` 通过。
- `node --test tests/bot-shell-ui.test.mjs`：`26 pass / 0 fail`。
- Playwright 真实浏览器（1440x900）：点击代理信息 -> 查看全部，`#view-bot` 可见、旧 `#view-workbench` 不可见；切换连接频道后工作区仍可见、旧 `#view-channels` 不可见；关闭后工作区隐藏并回到 Bot。
- 自动化编辑器在 Bot 工作区内写入 `#bot/automations/new`，关闭后节点恢复到旧 workbench 容器。

## 边界

- 旧 `#/workbench`、`#/channels`、`#/automations` 兼容入口保留，便于历史深链；本轮只收紧 Bot 新入口。
- 全量测试未作为本轮交付证据：筛选运行中三个自动化运行时测试因 Windows `mkdtemp` `EPERM` 失败，和本轮 UI 修改无关；Bot 聚焦契约及浏览器回读通过。

__DELTA__: 烛(Codex) | 1 | 证据：`apps/control-center/public/app.js:15600-15890`、`index.html:580-610` 将 Bot 普通入口从旧 Forge 路由收口为内部工作区，并用 Playwright 证明 Bot、自动化、频道三者不再发生旧界面跳转
