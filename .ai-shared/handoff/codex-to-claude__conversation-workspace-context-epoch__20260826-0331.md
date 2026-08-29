<!-- 514cc-session-id: 01a03a0d-a777-7020-81df-868c3c5efa58 -->
# Codex 实现与复核：Conversation Workspace / Context Epoch

- **时间**：2026-08-26 03:31 +08:00
- **接续任务**：`codex://threads/01a03836-0628-7882-9876-eaf08ae5664c`
- **范围**：Conversation 消息准入、跨 Run native session Context Epoch、并发所有权、取消撤销、Bot UI 真实入口与隔离浏览器验收

## 致命问题

1. **已修复：同一 Conversation 并发创建 Run 时可能双重继承同一 native session。** 新 Run 在 `save()` 进入 `runs` 前由 `contextClaimRunIds` 占住所有权，`ownerIsActive` 同时检查 in-flight claim 和已持久化 Run，见 `apps/control-center/src/orchestrator.mjs:383`、`:2647-2657`。回归位于 `tests/orchestrator.test.mjs:351`。
2. **已修复：取消发生在 completed checkpoint 与 Context publication 之间时，旧 Run 可能发布可继承 session。** `ConversationContextStore.publish()` 在同一串行事务中前后复验 lifecycle owner；若 owner 在 fsync/rename 窗口失效，立即按 `(runId, memberId, sessionId)` 回滚后才释放队列。`invalidate()` 另加 `ownerRunId` 条件，禁止旧 Run 删除新 owner binding，见 `src/conversation-contexts.mjs:278-355`、`src/orchestrator.mjs:1407`、`:3675-3685`、`:5930-5965`。store 中途撤销和 orchestrator cancel 竞态回归分别位于 `tests/conversation-contexts.test.mjs:138`、`tests/orchestrator.test.mjs:451`。
3. **已修复：Bot 普通消息仍由前端判断续 Run 或新 Run。** Bot 现在只提交 `POST /api/conversations/:id/messages`，由 `Orchestrator.conversationMessage()` 串行决定续 active Run 或按持久化 Conversation 新建 plan Run/Context Epoch；前端不再直接续显式 Run，见 `public/app.js:22982-22991`、`server.mjs:1965-1976`、`src/orchestrator.mjs:2068-2175`。

## 建议改进

1. **DELIVERY_BLOCKED**：`npm run qa:delivery -- --strict` 仍退出 1；当前 `tracked=379 / physical=404`，25 个未跟踪 must-ship 源码或测试包含 `src/conversation-contexts.mjs`、`tests/conversation-contexts.test.mjs` 和 `scripts/qa-bot-p0.mjs`。本轮未暂存、提交或推送。
2. `ConversationContextStore` 仍只有单进程内串行化；若未来允许两个 Control Center 实例共享同一 data root，需要磁盘 revision CAS/文件锁与启动 reconciliation。
3. Conversation HTTP endpoint 当前允许显式 Ask/Recovery/native-command 字段继续进入 active Run 的既有校验链；普通 Bot UI 只发 `prompt + messageIntent + sources`。后续应补客户端注入 `agentId/answerToAskId/nativeCommand/acknowledgeRecovery` 的 HTTP 契约测试，明确拒绝或服务端推导策略。
4. 一次中间浏览器复跑捕获 `/api/workbench/environment` 的 `503 EVENT_INDEX_BUSY`；其后重复浏览器验收通过且当前脚本会把该错误判失败，不存在 silent allowlist。该间歇故障不属于本轮 Conversation endpoint，但应单独追踪 Event Index contention。

## 可保留

1. `Project -> Conversation -> Run -> native CLI session` 四层身份不变；Conversation 只继承经过 topology/provider/cwd 匹配的 session，不继承 permission、approval、lease、budget 或 remote target。
2. `legacy_pipeline` 和 remote Run 暂不进入 Context Epoch；成员、runtime profile、adapter、provider binding、cwd 或拓扑变化会打开新 epoch。
3. Conversation 与 Context store 继续使用临时文件、`sync()`、rename 和 corrupt-store fail-closed；有效 ledger 重启继承与损坏原文不覆盖均有测试。
4. Bot 仍复用现有 Run/SSE/approval/settlement runtime，没有引入第二套消息或 social 系统。

## 总评

- 语法检查：`conversation-contexts.mjs`、`orchestrator.mjs`、`public/app.js`、`server.mjs`、`qa-bot-p0.mjs` 通过。
- focused：`253 tests / 253 pass / 0 fail`。
- full：`1648 tests / 1646 pass / 0 fail / 2 skipped`；`clean-exit:resource/exit/childexit=ok`，外层退出 0。
- validate：`13/13 valid`，退出 0。
- 隔离 Playwright：真实点击 Bot 发送命中 Conversation endpoint，HTTP `202`；响应 Run 为 `permissionMode=plan`、`remote=null`；迟到跨会话响应未污染当前消息；桌面与 390x844 可见，移动端横向溢出 0；`pageErrors=[]`、`consoleErrors=[]`、`failedResponses=[]`。截图位于 `apps/control-center/.qa-output/bot-p0/conversation-message-admission.png` 与 `conversation-message-admission-mobile.png`。
- 该浏览器 fixture 把 `grok-build` 命令替换为本机 Node，仅验证 HTTP/UI/runtime admission，不调用真实 provider，不构成模型效果或付费链路验收。
- 当前结论：`SOURCE_HARDENED / DELIVERY_BLOCKED / FORMAL_RUNTIME_UNVERIFIED`。未 reload 正式 Control Center、未替换 Tauri、未做真实 provider/SSH、未 commit/push，正式版本仍为 v3.5.0。

__DELTA__: 烛(Codex) | 2 | 证据：apps/control-center/src/conversation-contexts.mjs:278-355、src/orchestrator.mjs:1407、:3675-3685；独立复核推翻“Context Epoch 已可收尾”，发现并修复取消后 stale native session 可跨 Run 发布的阻断竞态
