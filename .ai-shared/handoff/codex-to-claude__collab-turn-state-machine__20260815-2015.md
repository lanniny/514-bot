# Codex 评审：collab-turn-state-machine

- **评审模式**：security + correctness（deep-review 口径，四节）
- **评审范围**：`orchestrator.mjs` continue/withdraw/interrupt/acknowledge/socialLoop/close；`server.mjs` `/messages`；`public/app.js` 停止键/呼吸行/草稿/toast；相关测试
- **评审时间**：2026-08-15 20:15
- **Codex 模型**：烛本人只读（`codex-agent` MCP 本环境未注册；未冷启动 CLI，避免把评审拖成另一次长跑）
- **总 token**：n/a
- **session marker**：本轮以 Cursor subagent 接入，无 route-gate 注入的 `514cc-session-id`，不猜测、不写占位符

---

## 致命问题（必须改）

1. **[apps/control-center/src/orchestrator.mjs:2048-2071 + 2708 + 4478-4494] 撤回审批只挡住了 deny→cancelled，没挡住 accept→startExecution。**  
   主驾把 `withdrawPendingApproval` 做成「先翻 `interrupted`/`withdrawn`，再 `denyRun`」——这条对 **deny 回唤醒** 是对的：`denyRun` 走 `resolve(decline)`（`approval-broker.mjs:142-154`），`awaitBuildApproval` 在 `2048` 看到状态已不是 `waiting_approval` 就返回，不会再写成 `cancelled`。  
   没挡住的是 **Approve 与 Stop 并发**：`awaitBuildApproval` 的 accept 路径不进 `withRunTransition`，只做一次无锁的 `if (run.status !== "waiting_approval") return`，然后直接 `buildApproval.status = "approved"` + `issueCapabilityLease` + `startExecution`。窗口是：

   1. broker 已经 `accept`（LO 点了批准）
   2. `2048` 读到仍是 `waiting_approval`
   3. `withdrawPendingApproval` 的 transition 把状态写成 `interrupted` / `withdrawn` 并落盘
   4. `2057-2071` 用内存覆盖成 `approved` 并 `startExecution`

   `execute()` 入口只拦 `TERMINAL` 与 `recovery_required`（`2708`）。`interrupted` **不在** `TERMINAL`（`19`）里，所以即便撤回已经赢了磁盘，后到的 `startExecution` 仍会把 run 拉回 `running` 并开写盘拓扑。  
   这是本轮新引入的缝：以前 interrupt 对审批挂起是空操作，不存在这条竞态。build 会话上等于「点了停止，写面仍可能开跑」。  
   收口必须同时满足：accept 路径与 withdraw 抢同一把 `withRunTransition`（或 CAS `buildApproval.status === "pending"`）；`execute()`/`startExecution` 拒绝 `interrupted` 以及 `buildApproval.status === "withdrawn"`。

---

## 建议改进（值得讨论）

1. **[public/app.js:14795-14800] 停止 toast 把「状态变了」当成「中断成功」。**  
   `updated.status === run.status && updated.status !== "interrupted"` 才报空操作。批准抢赢撤回时，状态从 `waiting_approval` 变成 `running`/`waiting_agent`，前端会报「当前回复已中断」——典型伪报。应看 `approvalWithdrawn` / 返回是否真是 `interrupted`，而不是「和旧 status 不一样」。

2. **[orchestrator.mjs:2072-2077] `awaitBuildApproval` 的 catch 只豁免 `cancelled`。**  
   撤回后若 `request()` 走 reject（`denyRun` 里 `resolve` 抛错会 `reject`），catch 会把已经 `interrupted` 的 run 改写成 `failed`。deny 主路当前是 resolve，这条是次级；catch 应同时放过 `interrupted` / `withdrawn`。

3. **[orchestrator.mjs:2048] `waiting_for_approval` 只在 withdraw/interrupt 对称，accept 路径不认。**  
   现役 `create()` 只写 `waiting_approval`，所以今天打不中。一旦有兼容别名写入，deny 回唤醒仍会走 `2049-2054` 写成 `cancelled`。两处判据应收成同一集合。

4. **[public/app.js:14784-14786] `interruptSelectedRun` 的准入比停止键宽。**  
   停止键用 `runHasInterruptibleTurn`；实际 POST 只要求 `ACTIVE_RUN_STATES`。`recovery_required` 在 `state.js:12` 里是活跃态，停止键不会亮，但直打 `/interrupt` 仍会进去。后端对无 controller/execution/inflight 会 no-op，不致命，前后端口径应对齐。

5. **social-orchestration 全量在 two-item resume queue 之后卡住——本轮不能定性为新引入。**  
   `tests/social-orchestration.test.mjs:772-813` 自己 `abort` + `release` + `assert.rejects`，不经 `continue()`，也不注册 `continue:${id}`。更像后续测试的未放行 `save`/`send` 闸撞上 `close()` 定点排空（`4742-4748`，无超时）。`2624` 附近已有「断言失败必须放行，否则 after 的 close 永等」的旧注释。  
   **不要**把进程内测试的 `waitForTurn` 默认改成轮询。要防挂，给测试 `close()` 加超时或在 `t.after` 里强制 `release`/`abort`。

6. **[orchestrator.mjs:4574-4578] interrupt 丢 claim 比「复活被中断的 social hop」更宽。**  
   直发续聊的第一轮也会丢掉当时挂着的 `resumeClaim`（新测试 `3000-3049` 就是这么种的）。`pendingSteer` / `pendingAsk` 没动，其余 queue 项保留。语义可接受，但要写清楚：停的是「当前 claim」，不是「当前这一跳」。

---

## 可保留（看似奇怪但合理）

1. **HTTP `waitForTurn: false` + 测试默认 true。**  
   `server.mjs:1828-1831` 删客户端字段再强制 false。`continue()` 在首个 await 前登记 `controllers` / `inflightContinuations` / `executions.set("continue:"+id)`（`3955-4159`），`isBusy()` 看 `executions`（`4754-4756`），`close()` 定点排空含该键。HTTP 早返回不漏等。进程内默认等整轮，不要改。

2. **`recoveryNote` 清/留。**  
   三条确认路径都收口到 `acknowledgeAbandonedWork`（`3430-3442`）：`continue` 直发（`3991-4006`）、`queueSteer`（`3543-3544`）、`updateRunControls`（`4376`）。直发用 `status === "recovery_required"` 而不是 `if (!directRefund)` 决定是否清注记——无退账的 abandoned 注记会留下，中断粘性注记在新一轮准入清掉。第三条路径没有另写一套文案。

3. **`revokeBuildGrants` 把 `withdrawn` 当已结算**（`4696`）。不再二次吊销。对。

4. **停止键 vs「等你回答」。**  
   `runHasInterruptibleTurn`（`12224-12230`）：`waiting_agent` 仅在 `!pendingAsk && !recoveryNote` 可停。`pendingAsk` 经 `runForPublic` 原样下发。`turn()` 开头写 `waiting_agent`（`2237`）是等模型，不是泊车。重启粘性注记（`742`）会把停止键藏住。`syncComposerTargetUi` 在 `dataset.mode === "stop"` 时不再写「发送给 Xxx」（`6407-6410`），`setComposerMode` 最后跑 `syncSubmitButtonMode`（`12217`）。

5. **呼吸行。**  
   `liveTurnMarkup`（`13480-13484`）：有 `recoveryNote`、无 inflight、且 `status !== "running"` 才藏。`interrupted` 不在 `ACTIVE_RUN_STATES`，流尾走停机卡（`11826-11830`），侧栏「正在工作」显式纳入 `interrupted`（`4553`）。

6. **草稿分柜。**  
   `composerNewTaskDraft` / `composerRunDrafts`（`11991-12006`），切 tab / 点「新任务」先 stash 再 restore（`16444-16458`、`17378-17387`）。新任务草稿不会被带进旧会话。

7. **续聊 toast 不再伪报完成**（`14739-14747`）：排队 / 等回答 / `running`→「已发送，正在回复」/ 其余「已发送」。HTTP 早返回后不会说「已完成」。

8. **pipeline 首轮 `allowWorkspaceWrite: true`（`2788`/`2805`）未改。**  
   仍进 `turn()` 的审批+租约+cwd fail-closed。只把 socialLoop / 直发续聊收口到 `continuationWriteGrant`（`2540-2546`、`3174`、`4043`）是对的；首轮获批执行不要降成只读。

9. **`RUN_TERMINAL` 进入 cancel-vs-continue 断言**（`social-orchestration.test.mjs:1324-1327`）。  
   `continue()` 在 `status === "cancelled"` 时同步抛 `RUN_TERMINAL`（`3834-3835`）。取消先落盘时这是诚实错误码，不是把失败收成成功。后面的「零派工 / 零投影 / 磁盘仍 cancelled」才是门闩。

---

## 总评

本轮 P0/P1 主路径（HTTP 不堵死、停止能撤回审批、中断不复活 claim、草稿分柜、recoveryNote 清/留、停止键不误伤「等你回答」、toast 不报完成）对照源码成立，不是表面补丁。  
没挡住的是 **build 审批上 Approve∥Stop**：deny 顺序修对了，accept 仍是无锁后写，且 `execute()` 不认 `interrupted`。这是本轮新缝，不是旧债。  
social 全量卡住更像既有测试闸 + `close()` 无超时排空，不能扣给 `waitForTurn:false`，也不要改测试默认。

---

## 下游建议

### 建议召唤
- 主驾收口 accept/withdraw 同一把 transition，并给 `execute()` 加 `interrupted`/`withdrawn` 拒绝。不必再为这条派织。

### 风险信号
- build 会话上「停止」与「批准」对打仍可能开写盘。
- 前端停止成功 toast 在批准抢赢时会撒谎。

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 1 | architecture | 证据：orchestrator.mjs:2048-2071 accept 无锁 + execute():2708 不认 interrupted，补强「只调 deny 顺序就安全」——Approve∥Stop 仍能在撤回后开跑
