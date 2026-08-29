<!-- 514cc-session-id: 01a02e6c-852d-79c1-b005-637f42ba18aa -->
# Bot 自定义运行席位交接

## 问题

LO 指出的缺口成立：此前“席位设置”只打开成员表单中的固定席位下拉框，用户能换绑，却不能定义席位本身。成员与运行席位是两个独立实体，不能把“选择固定项”包装成“席位可配置”。

## 实现

- `apps/control-center/public/index.html`：成员设置增加“编辑当前席位 / 新建自定义席位”；Bot 工作区增加“运行席位”页与“绑定到当前成员”。
- `apps/control-center/public/app.js`：新增 Bot 席位工作区打开、DOM 挂载/恢复、可绑定性同步和成员绑定链；选择和绑定继续使用真实 `memberId -> runtimeProfileId -> adapter.id`。
- `apps/control-center/public/modules/runtime-seat-manager.js`：复用既有完整席位编辑器，并公开受确认保护的草稿丢弃能力。
- `apps/control-center/public/forge/bot-shell.css`：Bot 内席位工作区桌面/移动适配；移动端绑定动作收敛为带 title/ARIA 的链接图标。
- `apps/control-center/tests/bot-shell-ui.test.mjs`：锁定 Bot 内部挂载、创建/绑定入口、旧 Forge 不回跳和可访问性结构。
- `apps/control-center/.qa-output/bot-member-settings-qa.mjs`：隔离浏览器真实创建席位、复制可执行席位、绑定未引用成员，并检查双视口。

完整表单继续由 `runtimeSeatManager` 持有，字段包括席位 ID、名称、职责、简介、Adapter、Provider、命令、模型、推理强度、默认权限、启用状态、主脑资格、质量/速度/成本、提示词与绑定成员；保存仍走 `/api/runtime-seats`，没有复制第二套状态或 API。

## 验证

- 语法：`app.js`、`runtime-seat-manager.js`、隔离 QA 脚本均通过 `node --check`。
- 聚焦断言：Bot + manager `28 pass / 0 fail`；Bot `27 pass / 0 fail`；HTTP 合同 `1 pass / 0 fail`。Node TAP 都在汇总后残留句柄，本轮已终止会话，不能写成 clean exit。
- `npm run validate`：13/13 valid，exit 0。
- 隔离 Playwright：
  - 自定义席位创建 `POST 201`。
  - 可执行席位副本创建 `POST 201`。
  - 未引用成员绑定 `PUT 200`。
  - `#view-bot` 保持可见，`#view-team` / `#view-config` 不可见。
  - 390x844 无横向溢出，console/pageerror 为空，服务优雅退出。
- 隔离截图：`%TEMP%/514cc-bot-member-settings-qa/{bot-seat-editor-desktop.png,bot-seat-created-desktop.png,bot-seat-editor-mobile.png}`。
- 正式桌面：旧 WebView 硬刷新后真实白屏，受控重启恢复；当前桌面 PID `37860`，Node/锁 PID `9520`，`51400` HTTP 200。正式窗口已点击“新建自定义席位”进入未保存完整表单，截图为 `%TEMP%/514cc-bot-member-settings-qa/desktop-seat-editor-live.png`。

## 边界

- 正式窗口没有点击“保存并启用”，没有用 QA 标记写正式成员或席位。正式数据文件内容扫描被运行态 ACL 以 `Access denied` 拒绝，故只记录为“没有触发保存”，不声称完成文件内容回读。
- 工作区非常脏；没有 reset、checkout、清理、commit 或 push。

__DELTA__: 烛(Codex) | 2 | 证据：`apps/control-center/public/app.js` 的 Bot 席位工作区与绑定链、`%TEMP%/514cc-bot-member-settings-qa/desktop-seat-editor-live.png`；LO 的澄清推翻固定下拉即席位设置完成的旧判断，补成真正可维护的运行席位实体。
