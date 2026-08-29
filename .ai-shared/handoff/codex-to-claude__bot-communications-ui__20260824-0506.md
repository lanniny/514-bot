<!-- 514cc-session-id: 01a02e6c-852d-79c1-b005-637f42ba18aa -->

# Bot 通讯录、群聊与个人身份前端交接

## 目标与结论

LO 要求参考微信桌面端，把 Bot 完善为以聊天为主的通讯界面。当前实现已在同一 `#view-bot` 内提供“对话 / 通讯录”、成员新增/编辑/删除、新建与续发群聊、官方模型/CLI 默认图标、自定义成员头像、个人昵称与头像，以及此前已落地的完整自定义运行席位编辑器。

实现没有复制成员、头像、席位或运行协议：成员继续使用 `TeamMemberStore`，头像继续使用同源 avatar API，席位继续使用 `runtimeSeatManager`，群聊继续使用 `social run + runId + bus.jsonl`，续发继续走 `/api/runs/:id/messages`。

## 主要接线

- `apps/control-center/public/index.html:531`：通讯录壳、对话/通讯录 tab、新成员与新群聊入口。
- `apps/control-center/public/index.html:641`：新建群聊 dialog；`index.html:687`：个人昵称与头像设置。
- `apps/control-center/public/app.js:14664`：同源渲染对话列表、群聊和通讯录；`app.js:14840`：成员删除。
- `apps/control-center/public/app.js:15965`：ARIA tab 与键盘切换；`app.js:16074`：social 群聊创建；`app.js:16799`：复用当前 social run 续发。
- `apps/control-center/public/app.js:17031`：通讯录编辑/删除/进入对话事件；`app.js:17198`：个人资料与头像事件。
- `apps/control-center/public/forge/bot-shell.css:823`：微信式高密度通讯层；`bot-shell.css:901`：移动端横向通讯录与常显操作按钮。
- `apps/control-center/server.mjs:1545`：成员、个人资料与头像 HTTP 路由；`apps/control-center/src/avatars.mjs:87`：个人资料和头像存储。

## 验证证据

- 语法检查：`public/app.js`、`src/avatars.mjs`、`server.mjs`、`.qa-output/bot-communications-qa.mjs` 通过。
- 聚焦测试：Bot/头像/席位 36/0，头像 HTTP 1/0，social contract/team kit 6/0，成员 HTTP 串行 1/0，social orchestration 串行 78/0。
- `npm run validate`：13/13 valid，exit 0。
- 隔离 Playwright：1440x900、1024x768、390x844 均通过；真实验证成员 POST/PUT/DELETE、成员与个人头像、群聊首发和同一 run 续发、旧 Forge 视图不可见、移动端操作按钮可达、无横向溢出、`diagnostics=[]`、服务优雅退出。
- 截图：`%TEMP%/514cc-bot-communications-qa/{bot-contacts-desktop.png,bot-group-desktop.png,bot-contacts-tablet.png,bot-contacts-mobile.png}`。

## 仍为 partial

- 全量 `npm test` 因 Windows 并发 `mkdtemp EPERM` 大面积失败；相关目标套件串行通过，但不能把 full suite 记为绿色。
- 若干 Node TAP 命令在通过汇总后残留既有句柄，没有记录为 clean exit。
- 本轮未受控重启正式桌面实例，也未修改正式成员数据。
- 独立审查另记两项后端债：`server.mjs:76-86` 的全局 `unhandledRejection` 只记录不退出；`src/avatars.mjs:192-214` 与 `server.mjs:1559-1562` 的头像清理/成员删除不是原子操作。它们不阻断本轮通讯 UI，但后续应单独修复和做故障注入。
- 未执行 `git commit` / `git push`，工作区其他协作者改动全部保留。

__DELTA__: 烛(Codex) | 1 | 证据：`apps/control-center/public/forge/bot-shell.css:901` 与 `%TEMP%/514cc-bot-communications-qa/bot-contacts-mobile.png`；真实浏览器复核发现并修复移动端通讯录编辑/删除操作不可达。
