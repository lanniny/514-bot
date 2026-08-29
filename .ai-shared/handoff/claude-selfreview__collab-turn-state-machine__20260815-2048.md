# 协作台状态机审查与收口（2026-08-15）

执行者：主驾（Cursor / AEMEATH）
独立眼睛：烛 [协作台状态机评审](913e5213-c952-4e57-b390-17f5d115ad56)
状态：`IMPLEMENTED / 待 LO 重启后验收`。未 commit、未重启 51400。

## LO 能直接感到的断点（不是文件数）

审查对象是会话状态机，不是布局。下列是点发送/停止时会撞上的真实缝：

1. **空闲续聊把整轮 HTTP 堵死** — 输入锁死、停不了、返回后把等待期间新打的字清掉。
2. **审批挂起时「停止」是空操作** — UI 显示停止，点了任务照跑。
3. **停止后下一句复活被中断的 social claim** — 先答新消息，再把旧 work 重派一遍。
4. **新任务草稿点进旧会话变成续聊** — 文本留在输入框，附件换绑。
5. **粘性 recoveryNote 藏呼吸行** — 已经在跑，界面还当它没活。
6. **等你回答时点停止假成功**；停止键 title 被冲成「发送给 Xxx」。
7. **toast 说「续接消息已完成」** — HTTP 其实只是准入成功。
8. **interrupted 进不了「正在工作」、流里没有停机卡**。

## 收口

### 编排器 `apps/control-center/src/orchestrator.mjs`

- `continue({ waitForTurn })`：进程内默认等整轮；HTTP 强制 `false`，准入落盘后立刻返回，turn 挂 `executions["continue:"+id]`。
- `interrupt()` 对 `waiting_approval` 走 `withdrawPendingApproval()`：先翻 `interrupted` + `buildApproval.status=withdrawn`，再 `denyRun`。
- 烛补强后：`awaitBuildApproval` 的 accept/deny 与 withdraw 抢同一把 `withRunTransition`（CAS：仍是 waiting + pending 才落批准）；`execute()` 拒绝 `interrupted` / `withdrawn`。迟到的批准不能把已撤回的 run 拉回 running。
- interrupt 结算丢弃当前 `resumeClaim`，并从 `resumeQueue` 滤掉该 itemId；`pendingSteer` / `pendingAsk` 不动。
- `recoveryNote`：确认放弃（`acknowledgeAbandonedWork`）的 audit 注记留下，即使步数不可退；中断粘性注记在新一轮准入清掉。判断用 `status === "recovery_required"`，不用 `directRefund`（completed 相位退账为空）。
- `socialLoop` / 直发续聊写盘走 `continuationWriteGrant`。
- 无 `interactionId` 的 legacy 排队回答在 promote 时补分配，不再在 save 前抛 `INTERACTION_INVALID`（这会让 social 套件卡死，也会让真实排队回答升不上去）。

### HTTP / UI

- `POST /api/runs/:id/messages` 删除客户端 `waitForTurn` 后强制 `false`。
- 停止键：`runHasInterruptibleTurn` — 审批中/running 可停；`waiting_agent` 仅当没有 `pendingAsk` 且没有 `recoveryNote`（等模型 ≠ 等你拍板）。
- 草稿分柜：`composerNewTaskDraft` / `composerRunDrafts`。
- 续聊 toast：「已发送，正在回复」/「对方在等你回答」/「插话已排队」，不再说已完成。
- 停止 toast 只在真正 `interrupted`（或 `approvalWithdrawn`）时报成功；状态被批准抢走时改报「当前没有正在执行的回复可以停止」。
- `interrupted` 进侧栏「正在工作」+ 流尾「已中断，可继续」。

## 验证（我跑过，不是我认为）

- 编排器组：HTTP 早返回、撤回审批、迟到批准不能复活、interrupt 丢 claim — 均通过。输出未见失败项。
- social 定向探针（现已删除）：promotion 并发 save 失败保 steer、cancel vs continue、确认放弃留下 abandoned 注记 — `3/3 pass`。
- UI 契约：`composer-target-ui` + `collab-turn-visibility` — `12/12 pass`。
- 烛：`CHANGES_REQUESTED` → 主驾已按致命项收口；`__DELTA__=1`。

## 边界

- 服务端改动需重启现有 Control Center 后才能被 LO 感到。本轮未擅自重启。
- 未 commit / 未 push。
- pipeline 首轮 `allowWorkspaceWrite: true` 未改（仍进 `turn()` 内部审批+租约闸）。
- 进程内测试默认仍 `waitForTurn: true`，没有改成全员轮询。

__DELTA__: 烛(Codex) | 1 | governance | 证据：.ai-shared/handoff/codex-to-claude__collab-turn-state-machine__20260815-2015.md 照出 awaitBuildApproval accept 无锁；已用 withRunTransition CAS + execute() 拒绝 interrupted/withdrawn 收口
