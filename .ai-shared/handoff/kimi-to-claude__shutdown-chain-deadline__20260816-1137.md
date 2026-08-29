<!-- 514cc-session-id: f1e02b50-93ce-4e44-be7a-69094a74da6e -->
# Kimi 修复：协作台关闭链统一 deadline 与可观测性（codex 复审清单收口）

- **类型**：修复 + 审查收口（非评审，故不用四节结构）
- **时间**：2026-08-16 11:37 (+0800)
- **执行体**：Kimi Code CLI（接手烛 2026-08-16 复审清单的未决项）
- **工作区**：`apps/control-center`

---

## 背景

烛的复审结论：整体 `partial`，主问题是**关闭链间歇性不收敛**——完整回归中
`mission-control-http.test.mjs:377` 的 teardown 超过 fixture 5s 优雅关闭窗口
（`TEST_SERVER_GRACEFUL_SHUTDOWN_FAILED`），但单独运行/串行重复均通过，且无失败轮阶段级耗时证据。

本轮基线复跑（修复前）：1284 tests / 0 fail（`.scratch/full-test-rerun-baseline.log`）——证实间歇性。

## 本轮改动（全部已验证）

### 1. 统一 shutdown deadline（对应烛清单 #3/#4/#5）

关闭链从"分段独立预算叠加"改为"单一预算逐阶段扣减"：

- `src/app.mjs`：`state.close({ budgetMs, onPhase })`，新增 `DEFAULT_CLOSE_BUDGET_MS = 8_000`；
  `deadline = Date.now() + budgetMs`，逐阶段 `reportPhase` 上报耗时/成败/错误码。
- `src/orchestrator.mjs:4994`：`close({ deadlineMs })`——执行排水 `min(2s, 剩余)`；
  主/远程 adapter 一律 `closeWithin(adapter, remainingMs(10_000))`（原远程 adapter 无超时）；
  fixed-point 链排水循环超 deadline 即降级留证（`adapter.close_degraded` 事件）并退出循环。
- `src/event-store.mjs:477`：`close({ deadlineMs })`——readTasks/writeChain/scan 链等待
  全部以剩余预算为界（`withinDeadline`），超期由 `lifecycleAbort` 语义收尾，不再无界等待。
- `server.mjs`：`CONTROL_CENTER_SHUTDOWN_BUDGET_MS`（默认 8000，clamp 500–30000）经
  `closeState` 注入；测试 fixture 默认收紧为 3500（`tests/server-fixture.mjs` 的
  `testServerEnv`），保证留在 5s 退出窗口内。

### 2. 关闭协议可观测边界（对应 #2/#6）

- `src/shutdown.mjs`：`[shutdown]` 阶段行（transport/state 分段计时、失败含错误码、完成行）。
- `src/app.mjs` `onPhase`：`[shutdown] <step> ok|FAILED in <ms>ms [code]` 逐阶段落 stdout。
- `tests/server-fixture.mjs`：`spawnTestServer` 全程保留子进程输出尾巴（16KB ring），
  优雅关闭超时时尾巴写入测试 stderr 并挂上 `error.outputTail`——失败轮现场不再丢。
- 冒烟实证（隔离 server，202=已开始→46ms 退出）：全阶段计时行完整可见，
  `[shutdown] complete in 3ms; exiting`，exit 0。

### 3. Mission→HealthService 共享 batch 真实集成测试（对应 #7）

- `server.mjs` 新增测试钩子 `CONTROL_CENTER_TEST_HEALTH_PROBE_DELAY_MS`（仅 TEST_MODE，
  clamp ≤30s）：拉长 `probeProfile` 让并发 waiter 汇合；新增 `GET /api/test/health-stats`
  返回 `{ probeCalls, inflight, waiters, retiring }`。
- `tests/mission-control-http.test.mjs` 新增
  `mission waiters share one health batch and disconnects retire it end-to-end`：
  3 waiter 汇合同一 batch（probeCalls 不涨第二轮）→ 断 1 个其余无恙 → 断光后 batch abort、
  inflight/retiring 归零 → 下一请求重建 batch。旧用例只覆盖 delay 阶段取消，此用例覆盖
  healthService 阶段取消。

### 4. 失效日志标注（对应 #12）

`.scratch/full-test-20260816.log` 首部已标注"错误 cwd 的无效尝试（exit 127），
不构成回归证据"，并指向有效基线与修复后日志。

## 验证证据

| 轮次 | 命令 | 结果 |
|---|---|---|
| 基线（修复前） | `npm test`（apps/control-center） | 1284 pass / 0 fail / exit 0（间歇未命中） |
| 定向：mission-http | run-tests `tests/mission-control-http.test.mjs` | 5/5 pass（含新集成用例 1.87s） |
| 定向：关闭链 | app-close/shutdown/shutdown-server/runtime-reload | 8/8 pass |
| 修复后 R1 | `npm test` | 1286 tests / 1285 pass / **0 fail** / exit 0 |
| 修复后 R2 | `npm test` | exit 1，唯一失败 `overview-ui.test.mjs` —— 协作者 11:31–11:36 正在改
`public/index.html` 与该测试（非 tracked 文件），属编辑中间态撕裂，与关闭链无关；其 11:36 修好后单跑 2/2 pass |
| 修复后 R3 | `npm test` | 1288 tests / 1287 pass / **0 fail** / exit 0 |

关闭链间歇故障特征复核：三轮修复后回归均**无** `TEST_SERVER_GRACEFUL_SHUTDOWN_FAILED`；
即使再复发，fixture 现在会把 `[shutdown]` 阶段尾巴带进失败输出，可直接归因到具体阶段。

## Provider binding 独立复核（对应 #11，已闭环）

第二视角（只读 explore 代理）终审结论：**原命题（models 提交 + 延期热重载期间的
Provider 删除保护）确认无漏洞**，beforeCommit 双代际、release 回滚、swap 同步段、busy 延期
fail-closed 逐窗口核过，最关键窗口有真实集成测试（`runtime-reload.test.mjs:171-205`）。

另记录两个**残余窗口**（不在原修复范围，后果被设计内 `providerDegraded` 降级兜底，
不崩不泄凭据）：

1. Provider `remove/update/import` 的"引用检查→`#commitState` 落盘"跨 tick，与
   ConfigManager/reloadRuntime 无跨 Store 互斥；严格不变量"已删 Provider 不被在役代际引用"可被击穿。
2. `catalogGuarded=false` 的手工 reload 路径（手工改 models.json 后由其他 source 提交触发）
   无 candidate 代际保护。

根治建议（新决策，不阻塞本轮）：`#commitState` 完成后按 `providerReferenceCatalogs` 复检，
或 Provider 写操作挂进 ConfigManager commit 锁。建议补两个回归基线用例（断言降级行为）。

## 待决项执行进展（2026-08-16 11:52 起，LO 授权后继续）

- **#8 新内核已进入运行态（无需我重启）**：当前实例 PID 22996 于 11:39:19 启动，
  晚于全部修复文件 mtime（最新 server.mjs 11:20:45），加载的即修复后内核；
  `http://127.0.0.1:51400/` GET 200、API 无 token 正确 401。**无需杀进程即可确认收口。**
   caveat：该实例的优雅关闭路径尚未在真实环境演示过（Windows 无信号语义，只有
  测试端点/托盘退出两条路）。
- **#9 真实 Provider 闭环（已闭环）**：`.scratch/e2e-real-provider.mjs`——隔离 dataRoot 起
  **真实模式**（非 TEST_MODE）server，走 HTTP API 三段全绿（证据 `.scratch/e2e-real-provider-20260816041443.json`）：
  - A 发送+返回：`succeeded`，claude-fable 真实作答，\$0.236（runId 1a9464ab）；
  - B 中断→继续→停止：interrupt 200→`interrupted`，messages 200→`running`，cancel 200→`cancelled`（runId 92314e54 同链路于 0412 轮复证）；
  - C 图片消息：clipboard-image 上传 → sources 附加 → run `succeeded`，agent 真实读图并描述（runId 53196333）。
  - 排障记录：首轮 `INSUFFICIENT_ROUNDS`（拓扑要求 maxRounds≥4）；第二轮 `$0.5/turn` 预算被熔断进
    `recovery_required`（产品行为正确）；第四轮 C 段 422 系 harness 手写 PNG 不过结构校验。均为 harness 参数问题。
  - **新发现（另立任务，不在本轮范围）**：两阶段回包均报告中文提示词到达 CLI 时已成 `?` 乱码
    （ASCII 部分正常）——疑似 Windows 下 adapter prompt 管线的 CJK 编码缺陷，协作台日常中文发运会失真，
    证据见上述 JSON 的 turnTexts。建议下一步专查 prompt 落盘/stdin 的编码路径。
- **#10 交付清单核对**：
  - 本轮交付（tracked 修改 7 件）：`src/app.mjs`、`src/orchestrator.mjs`、`src/event-store.mjs`、
    `src/shutdown.mjs`、`server.mjs`、`tests/server-fixture.mjs`、`tests/mission-control-http.test.mjs`。
  - 本轮交付（未跟踪新增 1 件）：本 handoff。
  - 本轮 scratch（不交付）：`.scratch/e2e-real-provider.mjs`、`.scratch/e2e-real-provider-*.json`、
    `.scratch/full-test-rerun-baseline.log`、`.scratch/full-test-post-fix-{1,2,3}.log`、
    `.scratch/full-test-20260816.log`（已标注失效）。
  - 其他协作者（勿混入）：`apps/control-center` 下 24 个未跟踪文件（avatars/overview-usage/
    team-kit/request-ownership 等前端波次及其测试）与大量 tracked 修改（`public/*` 等）。
- `.workflow/ultracode/collab-console-review-20260815/state.json` 仍有他人 in_progress
  packet，本修复不代标完成。

__DELTA__: Kimi(514cc-cli) | 1 | correctness | 证据：src/app.mjs:439 起统一 close 预算 + src/orchestrator.mjs:4994、src/event-store.mjs:477 deadline 化 + shutdown.mjs 阶段计时 + tests/mission-control-http.test.mjs 新增共享 batch 集成用例，修复后回归 R1/R3 全绿
