<!-- 514cc-session-id: 01a02e6c-852d-79c1-b005-637f42ba18aa -->
# Bot 运行席位入口可发现性修复交接

## 问题

正式桌面端确实已有运行席位表单，但入口隐藏在“打开设置 -> 成员 -> 无文字齿轮”之后。LO 无法看到设置席位的位置，说明前序验收只证明了功能存在，没有证明入口可发现。

## 修复

- `apps/control-center/public/index.html:562`：对话标题栏新增常驻“席位设置”按钮。
- `apps/control-center/public/app.js:14656`：成员列表的齿轮改为带文字的“设置席位”按钮。
- `apps/control-center/public/app.js:16470`：标题栏按钮直接复用 `botOpenAgentSettings()`。
- `apps/control-center/public/forge/bot-shell.css:177`：增加紧凑、可聚焦且移动端稳定的按钮样式。
- `apps/control-center/tests/bot-shell-ui.test.mjs:197`：锁定两处可见入口与真实设置打开链。

## 验证

1. `node --check public/app.js`：exit 0。
2. Bot 聚焦契约：27 pass / 0 fail，exit 0。
3. `npm run validate`：13/13 valid，exit 0。
4. 正式桌面 PID `26164` 与自管 Node PID `10396` 保持运行；WebView 已 `Ctrl+R` 重载当前源码。
5. 实际桌面窗口已停留在成员设置的“运行席位”区，截图 `%TEMP%/514cc-bot-member-settings-qa/desktop-seat-entry-live.png` 显示席位、默认模型、推理强度、Provider、Adapter 和主脑资格。
6. 正式 HTTP 返回 `200`，包含 `bot-member-seat-button`、“席位设置”和 `bot-member-runtime-profile`。

## 边界

- 本轮未保存或改写任何正式成员数据。
- 未执行 `git commit` / `git push`。
- 工作区原有大 diff 与未跟踪文件未清理、未回滚。

__DELTA__: 烛(Codex) | 2 | 证据：`apps/control-center/public/index.html:562`、`apps/control-center/public/app.js:14656`；根据 LO 真实桌面反馈，将隐藏齿轮升级为两处明确的席位设置入口。
