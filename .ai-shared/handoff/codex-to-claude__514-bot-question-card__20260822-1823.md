<!-- 514cc-session-id: 01a025bc-6dfd-7b00-9f68-cbc352f36c6c -->
# Codex -> Claude：514 Bot question card continuation

## 结果

继续收口 514 Bot 的动态问答卡和回答续接。默认表面仍是“代理通讯录 + 持续聊天 + 代理电脑”，回答继续复用 Control Center 现有 run/SSE runtime，没有引入第二套执行链，也没有执行 commit、push、reset、checkout 或清理其他协作者改动。

## 本轮变更

1. `apps/control-center/public/app.js`
   - 动态 question card 读取 `run.pendingAsk`，以 `runId + askId` 作为稳定身份；选项最多 6 个，缺少预设选项时提供“在下方输入回答”入口。
   - 回答提交复用 `/api/runs/:id/messages` 的 `messageIntent: "answer"`、`answerToAskId` 和 pending ask 所有权校验，不创建第二个 run。
   - 对回答桥的极早上下文失步增加 fail-closed 收束：清理 `answerInFlight`，并将未完成回答标记为失败，避免输入永久锁死。
   - 修正跨代理选项回答竞态：问题来自协作者时，选项选择和提交保持当前聊天表面，不因 `botRenderAgent()` 重绘而丢失 `aria-checked`/确认值。

2. `apps/control-center/public/forge/bot-shell.css`
   - 保持动态 question card 的黑白灰工具产品样式、短动效、小圆角和移动端约束。

3. `apps/control-center/tests/bot-shell-ui.test.mjs`
   - 覆盖动态卡的 `runId + askId`、选项上限、无选项入口、终态移除、answer continuation 和早退解锁契约。

## 验证

- `node --check public/app.js`：通过。
- `node --test tests/bot-shell-ui.test.mjs`：15 pass / 0 fail。
- `npm run validate`：13/13 配置与治理检查通过。
- `npm test`：1560 pass / 0 fail / 2 skipped，进程 exit 0。
- `node .scratch/bot-shell-live-qa-v3.mjs`：1440x900、1024x768、390x844 全部通过；console/pageerror 为空，body/root 横向溢出均为 0；覆盖代理切换、并行队列、刷新后历史、代理设置、电脑视图、五个设置页、插件库、主题和危险删除确认。证据目录：`apps/control-center/.scratch/bot-shell-live-v3-14580`。
- `node .scratch/bot-question-live-qa.mjs`：Master 当前表面上展示 Codex 提问的带选项 ask 卡；选项保持选中、确认按钮启用，回答请求体含 `prompt: "采用方案 A"`、`messageIntent: "answer"`、`agentId: "codex-technical"`、`answerToAskId: "ask-live-1"`；请求路径仅包含 `POST /api/runs/bot-ask-live-1/messages`，未创建 `POST /api/runs`。

## 仍为 partial 的边界

- 真实远程代理电脑、`remote-attested`、Tauri 正式桌面壳和 provider/SSH 端到端尚未验收。
- Plugins 安装/认证、Update/Reset、connector/cloud-agent 事件契约、artifact 对话卡和正式后端 Bot run 归属协议仍未闭环。
- 动态 ask 选项已在 mock 浏览器探针闭环；后端当前 `pendingAsk` 持久化/事件合同仍未提供生产级 `options` 字段，因此真实生产事件的选项来源仍是 partial，当前 UI 对缺失字段保持文本回答入口。
- 工作区仍包含其他协作者改动与 `.scratch` 产物，未回滚、清理或提交。

__DELTA__: 烛(Codex) | 2 | 证据：`apps/control-center/public/app.js:15385-15665` 修正跨代理选项选择触发 `botRenderAgent()` 后丢失确认值的竞态，并同时收束 `continueSelectedRun()` 早退锁；`apps/control-center/.scratch/bot-question-live-qa.mjs` 以 Master 表面 + Codex ask 真实复现并验证只复用原 run 的 `/messages` 合同。
