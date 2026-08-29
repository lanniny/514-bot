<!-- 514cc-session-id: 01a025bc-6dfd-7b00-9f68-cbc352f36c6c -->
# Codex -> Claude：514 Bot settlement hardening

## 结果

继续收口 514 Bot 的 Grok-style chat-first 表面。本轮把独立审查指出的三个状态风险落成可测试边界：审批快照跨 runtime reload 按运行时代际单调校验，settlement 读取有界且可取消，`partial` 交付状态不再伪装成 ready。Bot 与 Workbench 继续共用现有 Control Center runtime、run/event 与 settlement 真源；没有引入第二套运行链，也没有执行 commit、push、reset、checkout 或清理其他协作者改动。

## 本轮变更

1. `apps/control-center/public/modules/approval-snapshot.js:9-60`
   - 规范化非负安全整数 `runtimeGeneration`。
   - 已建立运行时锚点后拒绝缺失代际的快照；低于当前代际的迟到响应直接拒绝。
   - broker `epoch` 变化必须伴随严格递增的运行时代际；同一 epoch 仍按 revision latest-wins，新 epoch 重置 revision 比较基线。

2. `apps/control-center/public/modules/settlement-request.js:7-81`
   - Bot 与 Workbench 共用 12 秒超时的 settlement requester。
   - 超时主动 `AbortController.abort()`；按 `surface + runId` 取消；新请求取代旧请求。
   - 显式取消保持 AbortError 语义，不被页面渲染成错误状态；调用方继续用 generation 丢弃迟到响应。

3. `apps/control-center/public/app.js:100-108,1714-1779,15049-15116,16642-16729`
   - 接入两个模块，并在 Bot/Workbench 切换、重试和卸载时取消对应请求。
   - settlement 错误/invalid 卡提供“重新读取结算”入口。
   - `partial` 使用 `data-settlement-state="partial"` 与警告样式，显示“交付尚未确认”；`blocked`、`remote-unsupported`、`unknown` 继续 fail-closed。

4. 回归契约
   - 新增 `apps/control-center/tests/approval-snapshot.test.mjs`（4 项）和 `apps/control-center/tests/settlement-request.test.mjs`（3 项）。
   - 覆盖旧 runtime 回包、epoch/代际关系、缺失代际、超时、取消与 retry latest-wins。

## 验证

- `node --check public/app.js`、`node --check public/modules/approval-snapshot.js`、`node --check public/modules/settlement-request.js`：通过。
- 聚焦测试：`node --test tests/approval-snapshot.test.mjs tests/settlement-request.test.mjs tests/bot-shell-ui.test.mjs`，`30 pass / 0 fail`。
- `npm run validate`：`13/13 valid`。
- 全量测试第一次运行出现一次既有 `channels.test.mjs:77` 限流边界失败（`1580 pass / 1 fail / 2 skipped`）；单独 `node --test tests/channels.test.mjs` 为 `12/0`，随后第二次完整 `npm test` 稳定通过：`1581 pass / 0 fail / 2 skipped`，进程 exit 0。
- 最终源码对应的 Playwright live proof：
  - `node .scratch/bot-shell-live-qa-v3.mjs`：1440x900、1024x768、390x844 全通过；console/pageerror 为空、零横向溢出。截图目录：`apps/control-center/.scratch/bot-shell-live-v3-39700`。
  - `node .scratch/bot-approval-live-qa.mjs`：审批卡真实投影与拒绝链通过；请求体保留 `decision:"deny"`、原始 `actionSha256`、`actor:"control-center"`，没有创建新 run。截图：`apps/control-center/.scratch/bot-approval-card-live.png`。
  - `node .scratch/bot-settlement-live-qa.mjs`：`reviewable` settlement 卡、artifact、风险提示与 diff 面板通过。截图：`apps/control-center/.scratch/bot-settlement-card-before-diff.png`。

## 仍为 partial 的边界

- Tauri 正式桌面壳、真实远程代理电脑、provider/SSH 端到端、connector/cloud-agent、Plugins 安装/OAuth、Update/Reset Computer 仍未闭环。
- 正式后端 Bot run ownership 协议、question/ask 完整 options 生命周期、settlement 长期审计历史投影，以及 approvals 与 leases 的共同版本快照仍未实现。
- 本 handoff 记录的是最终源码与本轮证据；工作树仍包含其他协作者改动和 `.scratch` 产物，未做清理。
- 未执行 `git commit` / `git push`。

__DELTA__: 烛(Codex) | 2 | 证据：approval-snapshot.js 与 settlement-request.js；独立复核推翻了旧代际审批回包可安全依赖 epoch、settlement loading 可无限等待且 partial 可显示 ready 的判断。
