<!-- 514cc-session-id: 01a03836-0628-7882-9876-eaf08ae5664c -->
# Codex 评审：514 Bot P0 hardening

- **评审模式**：deep-review + isolated browser QA
- **评审时间**：2026-08-25 20:01
- **范围**：Conversation/Run 所有权、隐藏会话恢复、CAS 错误映射、Mission Control 环境身份、测试 runner、Web/Desktop delivery manifest

## 致命问题

1. **已修复：同一成员的多个 Conversation 共用成员级 Run 队列，B 会话会显示 A 的运行卡。** `public/app.js:16581-16624` 现在先取得 active Conversation，再用统一所有权契约过滤候选 Run；当前高亮只从该 Conversation 的 `activeRunId` 和过滤结果推导。隔离 QA 在 `scripts/qa-bot-p0.mjs:218-237` 同时断言消息流、Run ID、卡片数量、当前高亮以及 A marker 不可见。
2. **已修复：独立复核发现错误 `activeRunId` 仍可绕过队列过滤污染消息同步。** `public/app.js:14826-14838` 在读取 Conversation Run 时先验证所有权；`public/app.js:16462-16479` 在任何消息或首响应状态写入前再次 fail-closed。纯函数 `public/modules/conversation-run-ownership.js:8-20` 对现代 Run 以 `conversationId` 为权威，对 legacy Run 只接受唯一 Conversation 的显式 `activeRunId/runIds` 声明；双重归属对双方都拒绝。
3. **已修复：旧本地 Run 索引可含重复 ID，挤占有界队列并产生重复卡片。** `public/app.js:14468-14503` 在恢复和读取时先去重再截断；刷新/对账路径保持同一规则。
4. **已修复：隐藏 Conversation 行可见但点击无效。** `public/app.js:14945-14952` 使用带 revision 的 `hidden:false` PATCH 恢复后再打开；HTTP 回读覆盖隐藏、includeHidden 和恢复后普通列表可见，见 `tests/conversations-http.test.mjs:170-188`。
5. **已修复：非法 `expectedRevision` 曾落到 500。** Project/Conversation store 统一返回 `VALIDATION_FAILED`，见 `src/projects.mjs:96-105`、`src/conversations.mjs:86-95`；DELETE 的非法 JSON、非法 revision、stale revision 和空 body 分别锁定为 422/422/409/200，见 `tests/conversations-http.test.mjs:192-228`。
6. **已修复：测试 runner 只转发退出码，无法证明残留进程句柄已释放。** `scripts/run-tests.mjs:66-123` 现在区分 launch/resource/reap/signal/exit/childexit，超时回收进程树且不会被后续 close 覆盖为成功；`tests/run-tests-gate.test.mjs:11-42` 锁定成功与超时两条机器 verdict。
7. **已修复：Desktop manifest 曾可能把未跟踪非代码资产误判为 strict pass。** `scripts/qa-delivery-manifest.mjs:274-289` 把显式 Desktop focus 全部视为 must-ship；`tests/qa-delivery-manifest.test.mjs:64-99` 证明 `target/` 永不入闭包，而未跟踪 `icons/icon.svg` 必须阻断。

## 建议改进

1. **DELIVERY_BLOCKED**：`npm run qa:delivery -- --strict` 退出 1，Web 闭包为 tracked=379 / physical=402，存在 23 个未跟踪 must-ship 源码或测试：
   `public/forge/art-direction.css`、`public/forge/bot-shell.css`、`public/modules/approval-snapshot.js`、`public/modules/conversation-run-ownership.js`、`public/modules/settlement-request.js`、`scripts/qa-bot-p0.mjs`、`src/adapters/native-commands.mjs`、`src/conversations.mjs`、`src/projects.mjs`、`src/runtime-executable-dirs.mjs`、`tests/approval-snapshot.test.mjs`、`tests/art-direction-contract.test.mjs`、`tests/bot-shell-ui.test.mjs`、`tests/capability-flow-ui.test.mjs`、`tests/conversation-run-ownership.test.mjs`、`tests/conversations-http.test.mjs`、`tests/conversations.test.mjs`、`tests/native-commands.test.mjs`、`tests/no-route-ledger-http.test.mjs`、`tests/projects.test.mjs`、`tests/run-tests-gate.test.mjs`、`tests/runtime-executable-dirs.test.mjs`、`tests/settlement-request.test.mjs`。必须由 LO 确认交付范围后使用显式 pathspec，禁止 `git add -A`。
2. **DELIVERY_BLOCKED**：`npm run qa:delivery:desktop -- --strict` 退出 1，tracked=29 / physical=30，唯一漂移为 `apps/desktop/src-tauri/icons/icon.svg`；`apps/desktop/src-tauri/target` 已排除，不是阻断原因。
3. **LIVE_UNVERIFIED**：本轮没有 reload 正式 Control Center，没有执行真实 provider/SSH、正式 Tauri EXE 或原生任务栏验收。源码与隔离浏览器通过不等于正式实例已激活。
4. 未执行 `git add`、`git commit`、`git push`、版本升格或 GitHub Release。正式版本真源仍为 v3.5.0。

## 可保留

1. Bot 继续复用现有 Conversation/Run/SSE/approval/settlement 真源，没有创建第二套消息 runtime。
2. 无本地 cwd 或完整 worktree 身份的 direct Run 仍可进入 Mission Control，但不会请求环境 API：`public/app.js:24924-24930` 与 `public/mission-control.js:881-885` 分离任务身份和环境身份。
3. 浏览器 QA 中 11 个 `501 REMOTE_GATE_BLOCKED` 被单独记录为预期未授权能力；非预期 HTTP、page error 与 console error 仍全部要求为空，不把门禁当产品故障，也不吞掉真实失败。
4. 交付 manifest 只读，不会自动暂存或发布；Desktop 构建目录和 Cargo 日志继续留在交付闭包之外。

## 总评

- `node --check public/app.js public/modules/conversation-run-ownership.js scripts/qa-bot-p0.mjs`：通过。
- focused：Conversation 所有权/Bot/Workbench `65 pass / 0 fail`；扩大 P0 focused `226 pass / 0 fail`（新增纯函数回归随后由 full suite 覆盖）。
- `npm run qa:bot-p0`：退出 0；隐藏会话恢复、同成员 A/B 迟到响应隔离、Run 队列只显示 B 均通过；`pageErrors=[]`、`consoleErrors=[]`、`failedResponses=[]`。截图：`apps/control-center/.qa-output/bot-p0/conversation-ownership.png`。
- `npm test`：`1636 tests / 1634 pass / 0 fail / 2 skipped`；`clean-exit:resource=ok`、`exit=ok`、`childexit=ok`；进程退出 0。
- `npm run validate`：13 个配置/注册表/治理检查全部 valid，退出 0。
- 当前结论：`SOURCE_HARDENED / DELIVERY_BLOCKED / LIVE_UNVERIFIED`。

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 1 | correctness | 证据：apps/control-center/public/app.js:14826、:16462、:16581 与 public/modules/conversation-run-ownership.js:8 补强跨 Conversation 迟到响应、Run 队列和 legacy 所有权边界
