<!-- 514cc-session-id: 01a02e6c-852d-79c1-b005-637f42ba18aa -->
# Bot 成员身份与真实设置交接

## 结果

Bot 已不再把聊天联系人称为“代理”。成员列表、成员资料、运行席位设置、真实保存和保存后刷新都留在当前 `#view-bot`，没有通过旧 `#/team` 或 `#/config` 绕回 Forge。

旧 `botState.agentOverrides` 不再覆盖姓名、简称、职责和简介，只保留通知偏好。成员真值继续来自 `TeamMemberStore`，绑定链保持 `memberId -> runtimeProfileId -> adapter.id`。

## 变更

- `apps/control-center/public/index.html:531`：聊天表面改为成员通讯录、对话、成员资料与成员电脑文案。
- `apps/control-center/public/index.html:589`：成员设置扩展为身份、职责、简介、运行席位、模型、推理强度、主脑许可、提示词和通知。
- `apps/control-center/public/index.html:650`：Bot 全局设置的 Team Setup 替换为真实成员列表。
- `apps/control-center/public/app.js:14229`：已知机器职责码只在 Bot 展示层映射为人话职责，不改服务端字段。
- `apps/control-center/public/app.js:14635`：成员设置页由 `state.memberCatalog` 动态渲染，可回到对话或直接编辑成员。
- `apps/control-center/public/app.js:14797`：运行席位、模型、effort、Provider、Adapter、连接作用域与有效主脑资格联动。
- `apps/control-center/public/app.js:14929`：保存后重新读取 `/api/team-members` 并同步 member/runtime/bootstrap 目录。
- `apps/control-center/public/app.js:14947`：保存调用 `PUT /api/team-members/:id`；payload 包含真实成员字段，不再只写 localStorage。
- `apps/control-center/public/forge/bot-shell.css:409`：成员设置改为可滚动的宽表单，分区而不嵌套卡片。
- `apps/control-center/public/forge/bot-shell.css:444`：席位事实区桌面五列、移动两列；390px 无横向溢出。
- `apps/control-center/tests/bot-shell-ui.test.mjs:208`：新增成员术语、真实 PUT、席位字段与不返回旧 UI 的静态契约。

## 验证

1. `node --check public/app.js`：通过。
2. `node --test --test-force-exit --test-isolation=none tests/bot-shell-ui.test.mjs`：`27 pass / 0 fail`；TAP 汇总后进程仍未退出，本轮已终止自有 session，因此不是 clean exit 证据。
3. `npm run validate`：`13/13 valid`，exit 0。
4. `git diff --check -- <4 个目标文件>`：exit 0，仅报告既有 LF/CRLF 提示。
5. 隔离 Playwright：
   - 1440x900 打开成员资料 -> 成员设置；运行席位与事实区可见。
   - 真实隔离 `PUT /api/team-members/claude-fable` 返回 200；body 含 `runtimeProfileId/defaultModel/defaultEffort/systemPrompt/mainBrainAllowed`。
   - 保存后对话职责同步；成员列表仍在 `#view-bot`，`#view-team` 不可见。
   - 390x844 无文档、面板、表单和席位选择器横向溢出。
   - console/pageerror 为空；隔离服务优雅关闭，无 fallback kill。
   - 截图位于 `%TEMP%/514cc-bot-member-settings-qa/`。

## 运行态边界

正式数据根存在 `.ai-shared/control-center/control-center.lock`，记录 PID `24904`；当前已确认该 PID 不存在，`51400` 原先未监听。未取得删除授权，因此没有删除锁。

为便于预览，已启动 PID `2488` 的临时数据根实例并监听 `http://127.0.0.1:51400`。HTTP 回读确认：`HasMemberSettings=True`、`HasLegacyAgentLabel=False`、`HasMemberList=True`。该实例不代表正式成员数据激活。

## 后续

- LO 明确确认后，才能归档或删除陈旧正式锁并启动正式桌面数据实例。
- focused Node TAP 的汇总后不退出仍应单独定位，不能用本轮 27 条断言通过掩盖 teardown 缺口。
- 未执行 commit/push，未改正式 `team-members.json`。

__DELTA__: 烛(Codex) | 1 | 证据：`apps/control-center/public/app.js:14797`、`apps/control-center/public/app.js:14947` 接通真实席位与成员保存；浏览器回读发现并修复 `shortLabel` 从 48 被无意截成 8 的数据损失风险。
