<!-- 514cc-session-id: f1e02b50-93ce-4e44-be7a-69094a74da6e -->
# handoff：历史消息「编辑并续聊」（LO 2026-08-16）

## 需求与语义定稿

LO：「可以编辑历史对话直接返回上一个对话继续编辑」（ChatGPT 式）。落地语义为**编辑并续聊**：
点历史用户消息的铅笔钮 → 原文回填 composer → 编辑后发送走既有 `POST /api/runs/:id/messages` 续聊**追加**，不改写历史。
依据：EventStore 与 run.turns 均 append-only，CLI 原生会话（--resume）不可回滚；真回溯需新 run 编排，成本不值。要分叉可用既有「新任务」入口（retryRun 同路）。

## 实现（全部已验证）

- 入口复用 workbench-chrome 行操作钮机制（复制钮同款注入），不改 messageMarkup：
  - `apps/control-center/public/workbench-chrome.js:386-416` — `processRowActions` 给 `.message-row.is-user` 注入 `.msg-row-copy.msg-row-edit` 铅笔钮；点击读行 `data-stream-key`，经 `document.dispatchEvent(new CustomEvent("514cc:edit-message", { detail: { streamKey } }))` 桥接（chrome 模块无 state 通道）。
  - `apps/control-center/public/forge/workbench.css:1696-1699` — `.msg-row-edit { right: 28px; }` 与复制钮并排。
  - 图标 `#lucide-pencil` 在 `lucide-sprite.svg:90` 已存在。
- app.js 接收与反查：
  - `public/app.js:18911-18912` — cancel 绑定 + `document.addEventListener("514cc:edit-message", …startEditMessage)`。
  - `public/app.js:12969-13017` — `findEditableUserMessage`（限协作 run 流：`!run || sessionPreview || !streamKey` 拒绝；`textLength > text.length` 残文拒绝；`historyMessagesForRun(run, null, events)` 必须显式传 events，否则 cache key=undefined 会抛）、`startEditMessage`（priorDraft 暂存 + 回填 + dispatchEvent("input") 触发 autosize + 光标末尾）、`exitEditMessage({restore})`、`syncComposerEditingBar`。
  - `public/state.js:301` — `editingMessage: null`（{ key, runId, priorDraft }）。
  - `public/index.html:688` — composer 顶条 `#composer-editing-bar`（amber 细条，「发送将作为续聊追加，不改写原记录」+ 取消钮）。
  - `public/styles.css` — `.composer-editing-bar` 系列样式（旧 `.message-edit` 块已删）。
- 生命周期护栏：
  - 发送成功即终结：`continueSelectedRun` 内 `exitEditMessage({ restore: false })`（app.js:16023 区）。
  - 切 run/历史预览收敛：`setComposerMode` 开头静默退出（app.js:13268 区）。
  - Esc 取消恢复草稿（@/ 菜单 Esc 消费优先，app.js:19745 区）；× 钮同效。
  - 草稿柜语义：priorDraft 只在取消时恢复；发送成功的草稿清理由提交流程既有逻辑接管。

## 验证证据

- 契约：`tests/workbench-rail-and-tools-contract.test.mjs`「a user message can be edited back…」改写为 chrome 注入/CustomEvent/桥接/残文护栏/收敛/样式断言 —— **21/21 通过**（含负向断言：app.js 无 `data-edit-message` 残留）。
- e2e：`.scratch/edit-message-verify.mjs`（隔离实例 + route 拦截 mock），**8/8 通过**：回填原文 / 编辑条出现 / Esc 恢复草稿 / Esc 后条隐藏 / × 恢复草稿 / POST 携带编辑后全文 / 发送后条消失 / 输入框清空。截图 `.scratch/rail-beauty/edit-2-editing-bar.png`（铅笔+复制钮并排、编辑条、toast 均就位）。
- e2e 排障记录（后人勿踩）：① 首屏 `loadRuns` 只置 `selectedRunId`，**不开 tab 不拉历史**——`fetchRunEvents` 由 `openTab→activateTab`（app.js:17967）触发，脚本必须先点 `.rail-run-button[data-run-select]`；② `openTab` 需要 `runRecipient` 命中，mock run 必须带 `teamMembers`/`executionOwnerId`（`teamRoster` 不参与，`runRecipientIds` app.js:17849）。
- 完整回归：第三次 `npm test` **1313 tests / 1312 pass / 0 fail / 1 skipped，exit=0**（日志 `.scratch/full-test-edit-message-3.log`）。前两次各挂一个不同服务端测试（`ccswitch-proxy:358` 2!==1、`runtime-seats-http:284` 422!==200，耗时 20s 级），两文件单独跑均全绿——负载型间歇，与纯前端改动无因果（node 测试不执行 public/*；仅 team-kit/契约测试 readFile 做源码断言）。间歇根因仍是此前评审记录的关闭链/套件负载族问题，未在本轮扩大。

## 遗留（不属本任务，供后续决策）

- 套件负载型间歇失败仍在（每次挂不同测试），与 2026-08-16 上午评审第 1/2 条同族，未收口。
- 真实 provider e2e 曾见中文 prompt 到 CLI 变 `?` 乱码（Windows adapter prompt 管线 CJK 编码疑似缺陷，证据 `.scratch/e2e-real-provider-20260816041443.json`），LO 未指示是否追查。
- 源码尚未重启进运行态 Control Center。

__DELTA__: Kimi(514cc-cli) | 1 | security | 证据：workbench-chrome.js:397-415 铅笔注入+CustomEvent 桥、app.js:12969-13017 编辑态生命周期、e2e 8/8 + 回归 1312/1313 绿
