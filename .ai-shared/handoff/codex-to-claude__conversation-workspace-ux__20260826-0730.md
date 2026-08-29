<!-- 514cc-session-id: 01a03b31-4f9c-7071-b8a7-c6b1734dcf96 -->
# Conversation-first 会话工作面与协作检查器

- **时间**：2026-08-26
- **目标**：解决 514 Bot 会话 UI 混乱、导航重复、协作页签替换聊天和面板开关导致布局跳动的问题。
- **结论**：`SOURCE_AND_ISOLATED_RUNTIME_VERIFIED / DELIVERY_BLOCKED / FORMAL_RUNTIME_UNVERIFIED`

## 致命问题

1. **已修复：同一 Conversation 被“需要你处理”和原始树位置重复渲染。** 左栏现在每个 Conversation 只出现一次，attention 只参与同源排序和计数；静态 Claude/Codex/Grok 占位行也已删除。证据：`apps/control-center/public/index.html:548-552`、`public/app.js:15385-15460`。
2. **已修复：任务/成员/证据页签会隐藏消息流和 composer。** 中央 Conversation 始终保留聊天与输入框；协作概览、任务、成员、证据和 Run 历史迁入右侧检查器。证据：`public/index.html:564-600`、`public/app.js:15541-15615`。
3. **已修复：打开右栏会把中央列从两栏重排成三栏。** 检查器改为绝对定位 overlay，四视口实测打开前后中央宽度完全一致。证据：`public/forge/bot-shell.css:73-80`、`:521-526`。
4. **已修复：终态 `activeRunId` 仍显示“当前执行”。** UI 现在依据 `botRunPresentation(run).active` 区分“当前执行”和“最近运行”，不改动服务端 Conversation 关联指针契约。证据：`public/app.js:16903-16935`。

## 建议改进

1. Conversation Store 继续为一次最多 2,000 条的前端全量投影；数据规模增长后应增加服务端 query/cursor/limit。
2. 本轮只调整 UI 信息架构与投影，没有统一团队 Inbox answer 与 pending Ask answer 的产品语义；后续若要求 Inbox 直接恢复 provider，必须改服务端幂等续轮契约，不能只改文案。
3. strict delivery 仍受当前脏工作区与未跟踪 must-ship 文件影响；本轮没有暂存、commit 或 push。

## 可保留

1. `Project -> Conversation -> Run -> native CLI session` 四层身份、Conversation 服务端准入和 Context Epoch 继承边界保持不变。
2. project tree、Conversation 深链、短 ID、隐藏恢复、归档只读、删除墓碑、历史 Run 精确读取继续复用现有真源。
3. 电脑视图补齐 `aria-hidden + inert + Tab/Shift+Tab 循环 + opener 回焦`；小屏空态不再被 CSS 隐藏，tree 补 `aria-level/aria-controls`。
4. 独立复审最终结论为 `ACCEPT`，无阻断性 correctness、Conversation/Run 归属、焦点或响应式问题。

## 总评

- focused：`145 tests / 145 pass / 0 fail`。
- full：`1651 tests / 1649 pass / 0 fail / 2 skipped`；`clean-exit:resource/exit/childexit=ok`。
- validate：`13/13 valid`。
- Playwright：Conversation 行唯一；`stableCollaborationInspector=true`、`computerModalVerified=true`；1440/1024/820/390 的中央列宽开启前后分别为 `1180/764/600/390`，横向溢出均为 `0`；`pageErrors=[] / consoleErrors=[] / failedResponses=[]`。
- 截图：`apps/control-center/.qa-output/bot-p0/collaboration-inspector-1440.png`、`collaboration-inspector-1024.png`、`collaboration-inspector-820.png`、`collaboration-inspector-390.png`。
- 未 reload 正式 Control Center、未替换 Tauri、未做真实 provider/SSH、未 commit/push；正式版本仍为 v3.5.0。

__DELTA__: 烛(Codex) | 1 | 证据：`apps/control-center/public/app.js:15385-15460,15541-15608,16206-16266,16903-16935`；独立扫描与终审补出并修复重复 Conversation、聊天主面替换、终态 Run 误标、电脑 modal 焦点缺口和 QA 活动会话证据漂移
