<!-- 514cc-session-id: 01a03c14-b4a6-7032-836c-c8b18ede005d -->
# 514 Bot 会话切换、协作过程与 @成员完善

- **时间**：2026-08-26 14:54 +08:00
- **接续**：`codex://threads/01a03b86-946b-7c50-9d4f-0862431378ea`
- **结论**：`SOURCE_AND_ISOLATED_RUNTIME_VERIFIED / DELIVERY_BLOCKED / FORMAL_RUNTIME_UNVERIFIED`

## 致命问题

1. **已修复：异步打开成员/历史 Run 会覆盖用户最新选择。** `selectionEpoch` 统一约束可见 Conversation 提交；迟到响应只更新缓存，不再改 header、消息、composer 或 inspector。
2. **已修复：同一 Run 在成员回复前后显示两个泛化“工作活动”。** 改为一个“协作过程”时间线，内部 `activity -> member reply -> activity` 严格保持事件顺序，工具 input/output 继续可展开。
3. **已修复：Bot 无结构化 @成员入口。** composer 提供 Conversation roster 范围的 combobox/listbox 与 recipient chip；请求只发送稳定 `memberId`，服务端拒绝越界、重复、多收件人和 direct mismatch。

## 建议改进

1. 多成员同时点名仍由现有首轮 fan-out/社会编排承担；本轮刻意只开放“一条消息定向一位成员”，避免把 roster 容量与单轮成本闸混在一起。
2. Provider 事件若缺 attempt ID，只能按成员阶段展示；EventStore 顺序和详情未丢失，但更精细的 attempt 归属需要 adapter 统一补字段。
3. 外层 Codex/FastCtx 调用仍不自动进入 Control Center 事件流；不能把宿主工具调用伪装成 provider telemetry。

## 可保留

1. `Project -> Conversation -> Run -> native CLI session` 仍是唯一身份链。
2. 无 `@` 的群聊消息保持原团队/主脑协作；direct 仍只能发给绑定成员。
3. EventStore、ConversationStore、ProjectRegistry、Orchestrator 与 Run snapshot 继续作为服务端真源。
4. 附件、审批、提问、停止、续聊、结算和删除墓碑合同未另起运行时。

## 总评

- Focused：`164/164 pass`。
- Full：`1658 total / 1656 pass / 0 fail / 2 skipped`；`launch/resource/exit/childexit=ok`。
- Validate：`13/13 valid`。
- Playwright：延迟切换保持最新会话；单一协作过程内顺序为 `activity/message/activity`；`@Codex` 实际 POST 为 `recipientMemberIds:["codex-technical"]`；同名成员切换不残留旧 token；桌面/移动 overflow `0`；无非预期 page/console/HTTP 错误。
- 截图：`apps/control-center/.qa-output/bot-collab-dialog/dialog-desktop.png`、`switching-desktop.png`、`mentions-desktop.png`、`mentions-mobile.png`、`dialog-mobile.png`、`collaboration-mobile.png`。
- 首轮独立复核发现 P1 时序提升与 P2 重名 token；修复后新探子复审 `ACCEPT`，无 P0-P3 阻断问题。
- Strict delivery：`tracked=379 / physical=405 / undeclared=26 / strict fail`；26 项均为未跟踪 source/test，未删除 tracked 产品文件。
- 隔离预览：`127.0.0.1:51404`，root 与鉴权 bootstrap 均 HTTP 200，projectRoot 回读 `I:\514claude\514cc`；使用独立 data/home，不触碰正式 `51400`。
- 未 reload 正式实例、未替换 Tauri、未调用真实 provider/SSH、未 commit/push；正式版本仍为 v3.5.0。

__DELTA__: 烛(Codex) | 2 | 证据：`apps/control-center/public/app.js:16860` 独立复核推翻“全量活动提前聚合”并改为有序协作时间线；`apps/control-center/public/app.js:18595` 补齐同名成员可区分 token；`apps/control-center/src/orchestrator.mjs:264` 将 @ 收件人下沉为服务端 Conversation 成员校验
