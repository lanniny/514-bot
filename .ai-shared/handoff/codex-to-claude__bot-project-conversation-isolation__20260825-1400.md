<!-- 514cc-session-id: 01a036d4-0d73-71f0-935f-9a6090dbeac4 -->

# 514 Bot 项目与会话隔离收口

## 交付结论

已将参考图的“项目 + 会话树”融合为 514 Bot 的服务端真源模型，而不是只做侧栏分组：

```text
全局范围
└─ 全局成员单聊

项目范围
├─ 唯一默认协作室
├─ 多个项目任务会话
└─ Conversation -> Run -> 原生 CLI session
```

同一规范化 cwd 只能属于一个 Project；每个 Project 最多一个默认协作室。Conversation 是长期语义边界，Run 是一次执行，原生 CLI session 只是 provider 续轮句柄。

## 实现证据

- ProjectRegistry 持久化 cwd 唯一性、默认协作室和 Conversation 归属；归档 Project 禁止新增挂接：`apps/control-center/src/projects.mjs:302`。
- ConversationStore 校验 Project 状态并在跨 store 补偿失败时进入 `TRANSACTION_INCONSISTENT` fail-closed：`apps/control-center/src/conversations.mjs:183-192`、`:339-433`、`:513`。
- Orchestrator 在创建、继续和恢复链验证 Conversation/Project/成员快照；归档拒绝新 Run 与续轮，成员变化要求新 Run：`apps/control-center/src/orchestrator.mjs:1956`、`:4702-4721`。
- 幂等键按 `(conversationId, idempotencyKey)` 隔离；`createClaims` 对同一 Conversation 的并发创建单飞，修复 TOCTOU：`apps/control-center/src/orchestrator.mjs:371`、`:1893-1900`。
- 项目归档以 `projectId` 为真源，cwd 仅作 realpath 兼容：`apps/control-center/src/orchestrator.mjs:5375-5401`、`apps/control-center/server.mjs:2211`。
- Bot 左栏提供全局单聊、项目、未归类、已归档分区；项目节点折叠、默认协作室/任务会话、归档恢复菜单和键盘树语义已接线：`apps/control-center/public/index.html:550`、`apps/control-center/public/app.js:15067`、`:15265-15326`。
- 归档文案明确为只读封存，不删除目录、Run 或原生 session：`apps/control-center/public/app.js:15112`。

## 封存与恢复语义

归档是可逆的只读封存，不是删除：

1. 保留 Project、Conversation、Run、目录和原生 CLI session 记录。
2. 归档期间拒绝新 Conversation、新 Run 和已有 Run 续轮。
3. 已存在链接允许幂等读取，避免服务重启时把合法归档数据误判为损坏。
4. 恢复 Project 后重新允许创建任务和续轮。

## 一致性与故障边界

- Project Conversation 缺 ConversationStore/ProjectRegistry 时 fail-closed，不允许构造无持久化的 `workspace_group` Run。
- Conversation 成员变化后，旧 Run 的成员快照失效，返回 `CONVERSATION_MEMBERS_CHANGED`，要求新建 Run。
- Conversation create/remove 和 Run attach 的补偿失败不再吞错；store 标记恢复必需并返回 HTTP 503 `TRANSACTION_INCONSISTENT`。
- `archive-finished` 优先接受 projectId，避免相似路径或平台大小写造成误归档。

## 项目草稿与 Run 解耦

LO 复核创建表单后指出，旧版“必须填写第一条消息、至少 2 位且最多 5 位成员”把项目容器与单次社会协作运行错误绑定。现已改为：

1. 新项目和项目任务允许零成员、零启动消息创建；按钮分别显示“创建项目”或“创建任务”。
2. 填写启动消息后按钮切换为“创建并发送”，此时才要求至少 1 位可协调成员。
3. Project/Conversation 保存全部已选成员；`ConversationStore` 的技术防滥用上限为 40 个成员 ID。
4. 单次 social Run 的首轮 fan-out 仍为 1 位主成员 + 最多 4 位显式协作者。超过 5 位的其余成员继续保留在项目 roster，不再被创建表单拒绝。
5. 空成员项目可以正常打开并显示空态，但发送消息前必须先配置可协调成员；Orchestrator 继续校验 Run team 与 Conversation roster 完全一致。

实现证据：`apps/control-center/public/index.html:651-654`、`apps/control-center/public/app.js:16806-16986`、`:18164-18188`、`apps/control-center/src/conversations.mjs:35-40`、`:313-418`、`apps/control-center/src/orchestrator.mjs:2130-2134`。

## 独立复核 DELTA

独立复核发现同一 Conversation 的并发幂等请求存在先查后建 TOCTOU；现由 `createClaims` 单飞，并用并发 `Promise.all` 测试锁定。

复核还建议“store 文件 ENOENT 一律 fail-closed”，本轮未采纳。首次安装本来就没有 store 文件，若一律拒绝会破坏合法首启。未来若要识别“历史文件被删除”，应引入持久化存在标记或关联证据，再只对可证明的数据丢失闭锁。

## 验证证据

- 语法检查：`public/app.js`、`server.mjs`、`src/projects.mjs`、`src/conversations.mjs`、`src/orchestrator.mjs` 均通过。
- 聚焦测试：159 pass / 0 fail。
- `npm run validate`：13/13 valid。
- 全量测试：1622 tests / 1620 pass / 0 fail / 2 skipped。
- 隔离 Playwright：真实 Project、默认协作室、任务会话、归档、右键恢复、恢复后入树通过；390px 横向溢出 0；`pageErrors=[]`、`consoleErrors=[]`。
- 截图目录：`C:/Users/16643/AppData/Local/Temp/514cc-bot-isolation-qa-dKU3m5/shots`。
- 空项目补充验收：真实创建零成员、零启动消息的“空白项目容器”，Project 与默认协作室均持久化，Run 数为 0，`conversations.json` 回读 `memberIds=[]`；桌面/390px 截图位于 `C:/Users/16643/AppData/Local/Temp/514cc-bot-draft-project-qa-vAxDU9/shots`。

## 未闭环边界

- 未替换、重启或激活正式 Tauri 桌面实例。
- 未执行真实 provider、SSH 或远端项目端到端验证。
- 未执行 `git commit` / `git push`；正式版本仍为 v3.5.0。

__DELTA__: 烛(Codex) | 1 | 证据：apps/control-center/src/orchestrator.mjs 的 createClaims 修复同一 Conversation 并发 idempotency TOCTOU；Conversation/Project 归档与补偿失败边界补强。
__DELTA__: 烛(Codex) | 1 | 证据：apps/control-center/public/app.js 将项目成员范围与单次 Run 参与者解耦；src/conversations.mjs 允许空成员项目房间；src/orchestrator.mjs 阻止空房间绕过成员快照启动 Run。
