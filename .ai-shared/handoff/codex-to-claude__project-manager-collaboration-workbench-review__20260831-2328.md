<!-- 514cc-session-id: 01a05853-7def-7cf0-aed0-40aeab88bdd2 -->
# Codex 项目经理审查：514cc 协作台与 Harness 总计划

- **评审模式**：deep-review + product/architecture/UI/current-source
- **评审范围**：514cc 全仓，重点 `apps/control-center`
- **评审时间**：2026-08-31 23:28 +08:00
- **主计划**：`proposals/v46-collaboration-workbench-master-plan.md`
- **运行边界**：只读审查与文档落盘；未重启正式 Tauri，未调用真实 provider/SSH，未 commit/push

## 致命问题

1. `.ai-shared/context.md:168-175`：公开仓库历史中的代理 token 尚未完成轮换，推送清理和历史重写仍待授权。先轮换，后推送；强推不得与普通清理混为一次授权。
2. `apps/control-center/package.json:12-35` 与 `scripts/qa-ui.mjs:9-15`：全量测试当前 1911/1895/14 fail/2 skipped 且 clean-exit fail；`npm run qa:ui` 不传必需 URL，所谓一键入口立即失败；`npm run qa:bot-p0` 又在隐藏 Conversation treeitem 上超时。
3. 当前 `qa:delivery` 为 tracked=460 / physical=478，18 个 source/test 未跟踪且 `formalRelease=no`。源码、focused、isolated、delivery、formal 五层不能继续合并成“已完成”。

## 建议改进

1. `public/state.js:114-180` 与 `public/app.js:17271-17338`：建立共享 `ConversationRunProjection`，终止 Workbench/Bot 对 Run、Conversation、settlement 的双状态维护。
2. `src/orchestrator.mjs:1773-1858`：把 taskGraph 从 Run 内 128 task/200 edge 有界数组升级为 append-only transition + cursor index，保留旧 store 兼容迁移。
3. `server.mjs:2563-2648`：Replay/Mission/Settlement 增加统一 `asOfSequence` 与 EvidenceIndex，避免并行读取多个真源形成混合快照。
4. `server.mjs:2940-3100`：保留现有 SSE 背压优点，同时增加 scope、版本、retry reason 和 cursor pagination；未来远程/RBAC 前必须完成事件隔离。
5. `public/modules/nav-config.js:17-40` 与 `public/index.html:453-639,680-1069`：把 Bot、协作台、团队从三个并列产品入口收束为一个“工作”域，Workbench 默认，`#bot` 保留兼容深链。
6. `public/forge/bot-shell.css:919-982`：补真正的 tablet/mobile 模式、统一 modal stack、tree/combobox 键盘模型、44px 触控与 live region 降噪。
7. 按主计划 Wave 0-5 执行；优先级是红灯清零、协议/投影、协作台合流、Harness、工程解耦、可选扩展。

## 可保留

1. `Project -> Conversation -> Run -> native CLI session` 的服务端所有权模型是正确地基，不应引入第二套聊天或 runtime。
2. direct/workspace_group、Context Epoch、approval/lease、Ask/Answer/ACK、Mission/replay/settlement 的 fail-closed 方向可保留。
3. Forge token、原生 ESM、Lucide、UI lint、隔离 browser QA 与 releaseTruth 五层证据方向正确；问题是交付状态未闭环，不是机制本身错误。
4. Codex harness 借鉴应集中在 Thread/Turn/Item、schema、背压、分页、权限和 environment；DeepSeek-TUI 只作为第三方能力参考，不冒充 DeepSeek 官方 Harness。

## 总评

514cc 已有强协作内核，但产品层现在是“多个控制面围绕同一运行真源竞争用户注意力”。下一阶段不应继续横向增加页面，而应把所有权、事件、任务、证据和 UI 收成一个可解释的协作台。主计划给出 105 项 backlog，但只推荐按依赖执行 Top 20；Wave 0 未清零前不启动新扩展。

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 2 | 证据：apps/control-center/src/orchestrator.mjs:1835-1858 与 server.mjs:2563-2648 推翻“协作台只需继续做 UI 收口”的判断，暴露 TaskGraph 硬截断和跨真源混合快照；当前 full/Browser/Delivery 三层又同时为红灯。
