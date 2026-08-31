# handoff：ask/answer 收尾竞态修复（接续 Cursor 未竟项）

- 时间：2026-07-20
- 范围：`apps/control-center`（src/orchestrator.mjs、tests/social-orchestration.test.mjs）
- 触发：LO「接续 cursor 未完成的目标继续完善」——Cursor 第五轮（体检脉搏）留下的已知债：`ask->answer` 熔断测试全量并发下偶发抖动，标注"待时序加固"

## 实况

接手时 `node --test` 全量 1 红：`ask->answer loop is throttled after two asks from the same agent`（熔断事件未发），全量并发下 6/6 复现，单文件 22/22 绿。Cursor 标注为"测试 flaky 待时序加固"——**实证推翻：不是测试时序敏感，是真生产竞态**。

## 根因（探针 CC_DEBUG_ASK 轨迹实锤，探针已移除）

1. `turn()` 每轮开始把 `run.status` 写成 `waiting_agent`（orchestrator.mjs 轮起始，瞬态=轮进行中）。
2. 于是「waiting_agent + pendingAsk」状态对在 socialLoop 设 `pendingAsk` 的瞬间即可被外部观测——**早于 execute 收尾把 run 泊进挂起态**（中间隔着 save 的 await 窗口，CPU 竞争下窗口被拉宽）。
3. 此刻 LO/UI/测试回答 → `resumePendingAsk` 同步清 `pendingAsk`+`pausedForInput` 并占位 controller。
4. 垂死 execute 收尾醒来读 `pausedForInput=false` → 误判「自然收敛」→ 写 `succeeded` + `run.completed`。
5. resume 的 `startExecution` 撞 `execute()` 入口 TERMINAL 早退 → 第 3 轮永不执行——**回答被吞、run 假成功**。

失败运行轨迹实证：`execute entry ... status= succeeded round= 2`（第三次 execute 看到 succeeded 直接返回）；事件流里第二次 ask 后是 `run.completed` 而非 `run.waiting_input`。前端快速回答真实 ask 踩同一条路径。

## 修复

- **协程所有权闸**：execute 收尾三处状态写入（挂起分支/终态分支/catch 分支）前置校验 `controllers.get(id) === controller`——键已易主（resume 占位/continue 接管）则垂死协程不写挂起/终态，run 状态交由接管协程呈现。
- catch 分支被接管时不写 failed/cancelled 终态，错误改落 `run.auditErrors`（`execute.superseded`）如实留痕。
- 新增回归测试「窗口期作答」：紧轮询在 pendingAsk 置位第一时间 continue（确定性压进竞态窗口），断言回答必被消费（第 2 轮真实发生 + bus 恰好 1 条 answer）。熔断测试断言补全相位诊断 dump（再抖动时一次定位）。

## 验证

- 修复前：全量 6/6 红，两种失败相位（熔断事件未发 / 第二次挂起未现）。
- 修复后：**8 轮全量 150/150 × 8 全绿**（149 原有用例 + 1 新回归）；qa:ui --suite=all ok:true、3 套件 0 JS 错误。
- dev server 已重启生效（127.0.0.1:5140）。

## 教训

「waiting_agent」一态两用（轮中瞬态 + 挂起恒态）是观测面陷阱：状态机写入方与观测方必须以所有权/权威字段为准，不能靠状态对的配对时序。Cursor 的"flaky 待时序加固"判断被测试 dump + 探针轨迹推翻——**全量并发才红的测试优先怀疑真竞态，不要先归因测试**。

__DELTA__: 主驾(Kimi) | 2 | correctness | 证据：orchestrator.mjs execute 收尾 pausedForInput 被 resumePendingAsk 清掉后误判收敛写 succeeded（探针轨迹 ec1d145b：run.completed 替代 run.waiting_input、execute entry status=succeeded 早退），推翻"测试 flaky 待时序加固"的定性
