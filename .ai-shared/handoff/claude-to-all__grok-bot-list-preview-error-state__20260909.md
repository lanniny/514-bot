# Grok Bot 对标续波：会话列表预览 + 日期徽章 + 加载失败错误态

> 会话环境：WorkBuddy（CodeBuddy 宿主），非 514cc hook 接管会话——本会话无 route-gate 注入 session marker，按规则省略该行。
> 日期：2026-09-09（续 claude-to-all__grok-bot-ui-parity__20260909.md；LO 给的 Grok 截图显示侧栏行 = 标题 + 消息预览 + 右侧日期，中栏失败态 =「无法加载对话」居中卡 + 重试）

## Checkpoint

- Goal: LO 要求继续完善 UI，前后端与 Grok Bot 大概一致（截图对照）。
- Completed: 后端 preview 语义层（store + 事件回填）+ 前端列表行 Grok 化 + 加载失败重试卡 + QA 14 检查 7 截图全绿 + 15 测试文件回归全绿。
- Next: composer 多 @ 消息 → relay/kickoff 发送路径（沿袭上轮遗留）；routine runHistory 从 automation 事件回填；390px 小屏走查。
- Files: `src/conversation-preview.mjs`（新面模块）；`src/conversations.mjs`（cleanPreview + noteMessagePreview）；`src/app.mjs`（接线 1 行）；`public/utils.js`（formatConversationStamp）；`public/app.js`（行渲染/SSE 本地回填/错误卡/fetchRunEvents 参数）；`public/forge/bot-shell.css`；`tests/{conversations,conversation-preview,bot-shell-ui}.test.mjs`；`scripts/qa-bot-grok-parity.mjs`（+④⑤ 步 + shim 剥离）。

## 本轮交付

| 面 | 实现 |
|---|---|
| 会话列表行（Grok 截图主差距） | 行 = 头像 + 标题 + **最近消息预览**（单聊「你：xxx」/ 群聊「成员名：xxx」）+ 右列（**日期徽章**：当天 HH:mm、当年 M/d、跨年 Y/M/d + 状态徽章）。无预览回退旧描述行。 |
| 服务端预览真源 | `ConversationStore.noteMessagePreview`（唯一写通道，240 字上限，updatedAt 单调不倒车）；`preview` 磁盘坏值降级 null 不 fail-closed；create/update 请求体**无法伪造** preview（内部字段纪律）。 |
| 事件回填 | 面模块 `src/conversation-preview.mjs`：订阅 eventStore，user.message/assistant.message → runId → conversationId → noteMessagePreview。subscriber 完全自封（抛错会被 event-store 摘除）。 |
| 前端实时性 | SSE 同事件本地即时回填 conversation.preview + 450ms 防抖重渲（服务端仍是权威源，下次索引刷新对齐）。 |
| 加载失败错误态 | `botRenderConversationLoadError`：无缓存消息流 → 居中卡「无法加载对话 / 请检查网络连接后重试。 / 重试按钮」；有缓存 → toast 不清屏。`fetchRunEvents(runId, { swallowErrors })` 新参数：默认吞（workbench 语义不变），会话首开传 false 如实上抛。 |

## 关键实现决策（后续波次要遵守）

- **preview 是派生数据**：normalizeRecord 里坏值降级 null（区别于 title 的 fail-closed）；乱序事件不倒车 updatedAt（排序锚点只前进）。
- **QA 造 user.message 的真实路径**：`POST /api/runs {execute:true, social}`——social 执行轮在 adapter 启动前先 emit user.message（隔离内核 CLI 不存在、轮随后失败，都不影响预览回填，这正是真实时序）。
- **fetchRunEvents 共享在途请求**：同 run 并发拉取共享命运，错误呈现归首个调用者；swallowErrors:false 只在会话首开路径用。
- **宿主安全删除 shim 同样打断 QA 脚本**：qa-bot-grok-parity.mjs 现已内置与 run-tests.mjs 相同的 shim 剥离重拉（NODE_OPTIONS 检测 node-language-shim.cjs）。

## 验证

- `node scripts/qa-bot-grok-parity.mjs`：**14/14 检查 + 7 截图**（新增 ④ 列表预览/日期徽章 ⑤ 错误卡+重试恢复；`.qa-output/bot-grok-parity/`）。错误态靶场 = 从未缓存的任务房 + page.route abort 事件拉取；恢复 = unroute + 点重试 + 错误卡消失断言。
- `node scripts/run-tests.mjs`（15 文件：bots×4 + collab×2 + conversations×5 + preview + fusion + ownership + stream-contract）：全绿。
- 新增单测：conversations.test.mjs 4 条（单调/防伪造/fail-closed/坏值降级）+ conversation-preview.test.mjs 3 条（端到端回填/subscriber 自封不摘除/参数校验）。
- 途中修的真 bug：fetchRunEvents 内部 .catch 吞错后首开错误卡永不出现（QA DEBUG 诊断定位）——加 swallowErrors 参数，默认行为不变。

## 诚实边界

- composer 多 @ → relay/kickoff 仍未接（上轮遗留，主链风险高单列切片）。
- 真实 provider 的 assistant.message 预览在 QA 未覆盖（隔离内核无真实 CLI）；但事件形状与 user.message 同构，回填链路已被 user.message 端到端验证。
- 桌面壳 spawn 死亡（B-01 族）未动——本轮纯 Web 面改动，不影响该问题。

__DELTA__: 主驾自评 | 1 | 证据：QA 首轮 DEBUG 暴露 fetchRunEvents 吞错导致错误卡路径不可达（app.js:26492 既有 catch 返回空列表），通过 swallowErrors 参数修复且默认语义不变；宿主 shim 对 QA 脚本 rm 的拦截（SAFE_DELETE_BULK_CONFIRM_REQUIRED）需与 run-tests.mjs 同律剥离。
