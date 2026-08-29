<!-- 514cc-session-id: 01a03e60-2d56-71e0-b8a9-00bf176a0ae8 -->
# Codex 技术执行：协作台 524 报错与恢复卡收口

- **时间**：2026-08-26 23:06 +08:00
- **范围**：`apps/control-center` provider 错误呈现、recovery acknowledgement 状态、响应式布局与浏览器回归
- **状态**：`SOURCE_AND_ISOLATED_RUNTIME_VERIFIED / FULL_REGRESSION_VERIFIED / FORMAL_RUNTIME_UNVERIFIED`

## 根因与取舍

1. Claude Fable 的 `API Error: 524` 同时进入 assistant 正文、`agent.turn_failed` 与 `run.error`。旧前端只按 400 字符截断治理注记，assistant 正文仍渲染整块 JSON。
2. `.recovery-bar` 把失败原因、原生 resume 卡和确认按钮放在同一横向 flex 行；长 token 与不可收缩的命令行互相挤压，形成截图中的逐字窄列与叠字。
3. 524 表示代理等待上游响应超时，不能证明 provider 未接受请求。后端继续保持 `recovery_required` 与人工确认，未按错误字符串启用自动重试，避免重复 durable work。

## 已实施

1. 新增 `public/modules/failure-presentation.js`：仅把行首明确 `API Error: NNN` 信封识别为 provider 错误；524 显示中文摘要，完整原文保留在折叠技术详情。普通 assistant JSON 示例不误分类。
2. assistant 正文、`agent.turn_failed`、终态原因和恢复条共用同一有界呈现；所有原文继续经过 `redact + escapeHtml`。
3. 恢复条改为内容列 + 操作列 grid，补齐 `min-width: 0`、折行、原生命令网格、移动单列与 `role=alert`。
4. 未确认的 1024/390 视口优先展示完整恢复证据与确认按钮；确认后卡片收成紧凑态，恢复消息流，并隐藏重复的目标标签/折叠 CLI 操作台，为历史和 Composer 释放高度。

## 验证

- Focused：`node --test tests/failure-presentation.test.mjs tests/workbench-rail-and-tools-contract.test.mjs tests/resume-hints.test.mjs` -> `31/31 pass`。
- Isolated Playwright：`node scripts/qa-bot-collab-dialog.mjs` -> `ok:true`；1440/1024/390 横向溢出与 `stream -> recovery -> composer` 重叠均为 0，无窄列文本；确认后 1024 `streamHeight=88.75`、输入框完整在视口内。
- Full：`npm test` -> `1664 total / 1662 pass / 0 fail / 2 skipped`，`clean-exit:resource/exit/childexit=ok`。
- Governance：`npm run validate` -> `13/13 valid`。
- 截图：`apps/control-center/.qa-output/bot-collab-dialog/recovery-{desktop,tablet,mobile}.png`、`recovery-details.png`、`recovery-acknowledged-tablet.png`。
- 独立终审先发现“确认后消息流仍隐藏”和“任意 JSON status 会误分类”两项中等级问题；修复后全新定点复核 `ACCEPT`。

## 边界

- 用户给出的 `sess_da662115-acdd-4c4c-bd89-89bef85e92d1.zcode-session` 在仓库、用户 Codex 目录和临时目录均未找到；本轮从截图、当前 diff、最新 handoff/decisions 与持久化契约恢复现场，没有声称读取不存在的文件。
- 正式 `127.0.0.1:51400` / Tauri 进程未 reload，真实 Claude provider 未重放；本轮不构成正式运行态激活。
- 未执行 `git commit` / `git push`，未修改 provider 凭据、权限或正式数据。

__DELTA__: 独立只读探子 | 2 | 证据：`apps/control-center/public/styles.css:5484-5495` 与 `public/modules/failure-presentation.js:25-32`；终审推翻首次“浏览器 QA 已闭环”的判断，补出确认后历史永久隐藏及普通 JSON 误分类，两项均修复并经新探子 ACCEPT。
