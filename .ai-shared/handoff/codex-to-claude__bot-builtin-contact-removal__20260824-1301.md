<!-- 514cc-session-id: 01a02e6c-852d-79c1-b005-637f42ba18aa -->
# Bot 内置成员通讯录移出修复

## 结论

LO 删除 Grok 时效搜索时出现 `builtin members cannot be deleted`，根因是 Bot 通讯录对所有成员都暴露了 DELETE，但服务端按既有契约冻结内置运行成员删除。现已把联系人可见性与运行席位生命周期拆开：内置成员可从通讯录移出并恢复，自定义成员仍永久删除。

## 实现

- `apps/control-center/src/avatars.mjs`：operator profile 新增受限、去重的 `hiddenMemberIds`，昵称和头像变更均保留该字段。
- `apps/control-center/public/app.js`：Bot 对话、通讯录、成员概览与群聊候选统一使用可见成员投影；内置成员走 operator profile PUT，自定义成员继续走 TeamMemberStore DELETE。
- `apps/control-center/public/app.js`：设置成员页显示“已移出”状态和恢复按钮；右键菜单、联系人按钮、成员设置的动作名称与确认文案按成员类型区分。
- `apps/control-center/public/forge/bot-shell.css`：补充已移出成员与恢复操作的静态布局。

## 验证

- 语法：`public/app.js`、`src/avatars.mjs`、`.qa-output/bot-communications-qa.mjs` 通过 `node --check`。
- 聚焦测试：34 pass / 0 fail；头像 HTTP 跨重启 1 pass / 0 fail。TAP 汇总后有既有残留句柄，已主动终止测试进程。
- Playwright：Grok 移出 -> 设置成员页显示已移出 -> 恢复 -> 自定义成员 DELETE 全链通过；三视口无横向溢出，`diagnostics=[]`，隔离服务优雅退出。
- 截图：`C:/Users/16643/AppData/Local/Temp/514cc-bot-communications-qa/bot-builtin-member-removed.png`。

## 边界

- 不删除或停用底层 runtime profile，不改团队，不清理历史 run。
- 最终检查时 `51400` 无监听，`cc-desktop` PID 49360 无可见窗口句柄；未强制终止残留进程。下次正常启动会加载 `src/avatars.mjs` 的新持久化逻辑。
- 工作区存在大量其他协作者改动；本轮未回滚、提交或推送。

__DELTA__: 烛(Codex) | 2 | correctness | 证据：apps/control-center/public/app.js:14870、apps/control-center/src/avatars.mjs:56；将原本必失败的内置成员 DELETE 拆为可恢复的个人通讯录可见性，并保留运行安全边界。
