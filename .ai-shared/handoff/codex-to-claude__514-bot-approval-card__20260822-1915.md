<!-- 514cc-session-id: 01a025bc-6dfd-7b00-9f68-cbc352f36c6c -->
# Codex -> Claude：514 Bot approval card

## 结果

继续完善 514 Bot 的 Grok-style chat-first 表面。待审批动作现在会以真实审批数据投影到当前代理的主对话流，决议仍复用 Control Center 既有 ApprovalBroker endpoint、`actionSha256` 校验和审计链；没有引入第二套 runtime，也没有执行 commit、push、reset、checkout 或清理其他协作者改动。

## 本轮变更

1. `apps/control-center/public/app.js`
   - `botApprovalCardMarkup()` / `botApprovalCardsMarkup()` 将当前 run 的 `state.approvals` pending 项渲染为 `data-bot-card="approval"`，展示方法、脱敏参数、作用域、动作哈希和明确的拒绝/批准动作。
   - 广域权限 `item/permissions/requestApproval` 继续禁用批准；按钮动作使用既有 `/api/approvals/:id/resolve`，请求体保留 `decision`、`actionSha256`、`actor`。
   - `approvalInFlight` 防止重复提交；`approval.resolved/expired` SSE 事件写入有界的本地结果投影，过期状态不会被误报为批准。
   - `loadApprovals()` 增加 generation latest-wins，迟到 GET 不得覆盖较新的 pending 快照；Bot 表面在审批刷新后重新同步当前对话。

2. `apps/control-center/public/forge/bot-shell.css`
   - 增加审批卡、参数块、哈希提示和 approved/denied/expired 结果行的克制黑白灰样式，沿用 Bot 小圆角与短信息密度。

3. `apps/control-center/tests/bot-shell-ui.test.mjs`
   - 增加审批卡真实字段、审批 endpoint/body、SSE 终态投影、in-flight 锁和 latest-wins 刷新契约。

4. `apps/control-center/.scratch/bot-approval-live-qa.mjs`
   - 新增有界 Playwright 探针：mock 一个 `commandExecution` pending approval，真实打开 Bot，校验卡片身份和命令参数，点击拒绝后确认请求体携带原始 `actionSha256`，卡片消失且没有 `POST /api/runs`。

## 验证

- `node --check public/app.js`：通过。
- `node --test tests/bot-shell-ui.test.mjs`：17 pass / 0 fail。
- `node --test tests/workbench-rail-and-tools-contract.test.mjs`：23 pass / 0 fail。
- `npm run validate`：13/13 通过。
- `npm test`：1562 pass / 0 fail / 2 skipped，进程 exit 0。
- `node .scratch/bot-shell-live-qa-v3.mjs`：1440x900、1024x768、390x844 全部通过；console/pageerror 为空，零横向溢出；截图目录 `apps/control-center/.scratch/bot-shell-live-v3-30320`。
- `node .scratch/bot-approval-live-qa.mjs`：通过；截图 `apps/control-center/.scratch/bot-approval-card-live.png`。请求体为 `decision:"deny"`、`actionSha256:"sha256:approval-live-action"`、`actor:"control-center"`，请求路径没有 `POST /api/runs`。

## 仍为 partial 的边界

- 后端 ApprovalBroker 的 resolved/expired 历史仍不由 `GET /api/approvals` 提供；Bot 结果行只保留本页已观察到的 SSE/本地决议，不是审计历史真源。
- 真实远程代理电脑、`remote-attested`、Tauri 正式桌面壳、provider/SSH、connector/cloud-agent、插件安装/认证、Update/Reset 和正式后端 Bot run 归属协议仍未闭环。
- 生产 `pendingAsk` 仍未提供 options 字段；question card 的预设选项只在已有字段或 mock 事件中可用，缺失时保持文本回答入口。
- 工作树含其他协作者修改和 `.scratch` 产物，未做清理或回滚。

__DELTA__: 烛(Codex) | 1 | correctness | 证据：`apps/control-center/public/app.js` 的 `botApprovalCardMarkup`、`rememberApprovalEventOutcome` 与 `approvalsLoadGeneration` 把现有审批真源接入聊天并封住迟到刷新；`apps/control-center/.scratch/bot-approval-live-qa.mjs` 和全量测试提供真实交互回读。
