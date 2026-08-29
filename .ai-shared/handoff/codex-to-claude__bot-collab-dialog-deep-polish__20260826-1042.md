<!-- 514cc-session-id: 01a03b86-946b-7c50-9d4f-0862431378ea -->
# Codex Ultracode：514 Bot 协作对话深度完善

- **时间**：2026-08-26 10:42 +08:00
- **接续**：`codex://threads/01a03a0d-a777-7020-81df-868c3c5efa58`
- **结论**：`SOURCE_AND_ISOLATED_RUNTIME_VERIFIED / DELIVERY_BLOCKED / FORMAL_RUNTIME_UNVERIFIED`

## 致命问题

1. **已修复：Bot assistant 长消息按句子拆成多个气泡且不走 Markdown。** 删除 `botSplitBubbleText` 路径，助手正文使用 `renderMarkdown`，表格/列表/代码块保持一个消息组。
2. **已修复：过程事件逐条刷屏，工具细节不可见。** 相邻 process/tool/governance 消息合并为可展开 `bot-activity-group`；过程卡显示有界 command/input/output。Codex `item/started` 保留脱敏、截断后的 input，completed 仍负责 output。
3. **已修复：头像/作者缺失。** Bot assistant 与 LO 消息均显示真实作者标签和头像组件；连续消息只隐藏重复身份。
4. **已修复：Bot composer 固定话筒样式、运行中不能停止。** 发送按钮改为 arrow-up；空输入且 Run 可中断时切换方块 stop，调用 `/api/runs/:id/interrupt`，终态回到同一 Conversation 继续。
5. **已修复：团队委派不可见。** pipeline coordinator→specialist、specialist→verifier、verifier/rework→coordinator 等真实 provider turn 现在写 `taskGraph.delegations`，带稳定 busMessageId 和 source/target attempt，Bot 任务检查器渲染真实边，不靠 UI 推断。
6. **已修复：其他区无清理入口且批量动作易误删。** 新增 `DELETE /api/conversations/deleted`，携带 `expectedStoreRevision`；仅清除无 activeRunId 且无 runIds 的删除墓碑，隐藏/归档/活动或有历史 Run 的记录保留并返回 skip 原因。

## 建议改进

1. 外层 Codex/FastCtx 主代理调用不经过 Control Center adapter，当前仍无法自动进入 Bot 事件流；需要另建受控 runtime event bridge，不能伪装成 provider tool telemetry。
2. Bot Shell 静态契约测试不能替代真实浏览器；本轮新增 `scripts/qa-bot-collab-dialog.mjs` 作为交互证据，但正式 Tauri/provider 仍未验收。
3. strict delivery 仍被脏工作区的 26 个未跟踪 must-ship 源码/测试阻断；本轮未暂存、commit、push。

## 可保留

1. `Project -> Conversation -> Run -> native CLI session` 仍是唯一身份链；没有新增第二套消息运行时。
2. EventStore 继续追加保存原始事件；活动聚合只发生在 Bot 显示投影层，输入/输出沿用现有 redaction、预算和 `view=ui` 限制。
3. direct Run 保持 pipeline/direct-owner 语义，不虚构 social delegation；workspace group 继续读取服务端 taskGraph/bus。
4. 删除墓碑仍保留运行审计；“清空”不是删除 Run、项目文件、事件或原生 session。

## 总评

- 语法与 `git diff --check` 通过。
- Focused：`189/189 pass`。
- Full：`1655 total / 1653 pass / 0 fail / 2 skipped`；`resource=ok / exit=ok / childexit=ok`。
- Validate：`13/13 valid`。
- 隔离 Playwright：Markdown table=true；assistantMessageCount=1；activityGroups=1；toolDetail=true；stopControl=true；deletedPurged=2；hiddenPreserved=true；delegationEdges=2；desktop/mobile/collaboration-mobile overflow=0；page/console/非预期 HTTP 错误=0。预期 501 远程门闸和 fixture runtime-seat 404 单独列账。
- 截图：`apps/control-center/.qa-output/bot-collab-dialog/dialog-desktop.png`、`dialog-mobile.png`、`collaboration-mobile.png`。
- 独立复核先发现 run-linked tombstone purge P1，已加保护与回归；另修复不存在 Run 的 diff 404 和离线 sprite 图标缺失。
- 未 reload 正式 Control Center、未替换 Tauri、未调用真实 provider/SSH、未 commit/push；正式版本仍为 v3.5.0。

__DELTA__: 烛(Codex) | 2 | correctness | 证据：`apps/control-center/src/conversations.mjs:564` 防止仍有关联 Run 的删除墓碑被物理移除；`apps/control-center/src/orchestrator.mjs:3955` 持久化 pipeline delegation；`apps/control-center/public/app.js:15593,16754,17030` 将真实委派边、活动详情和发送/停止状态接入 Bot。独立复核推翻“清空墓碑可直接物理删除”的收尾判断并补齐 CAS/审计边界
