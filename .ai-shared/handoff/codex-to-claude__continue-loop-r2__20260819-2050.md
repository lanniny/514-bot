# Codex 评审：「继续」循环 / context compact 路径 R2

- **评审模式**：deep-review + 对抗式兜底
- **评审范围**：工作树当前源码（非旧 diff）
  - `apps/control-center/src/orchestrator.mjs`
  - `apps/control-center/src/adapters/codex-app-server.mjs`
  - `apps/control-center/public/app.js`
  - `apps/control-center/tests/orchestrator.test.mjs`
  - `apps/control-center/tests/adapters.test.mjs`
  - `apps/control-center/tests/stream-live-progress-contract.test.mjs`
  - `apps/control-center/tests/composer-target-ui.test.mjs`
- **评审时间**：2026-08-19 20:50
- **评审者**：烛（代码守夜人）
- **对照**：`.ai-shared/handoff/codex-to-claude__continue-loop-independent-review__20260819-1650.md`（F1–F5 CHANGES_REQUESTED）
- **自由格式**：false
- **session 归属**：本轮未收到 route-gate 注入的 `514cc-session-id` marker。按 SKILL §4a：**session 归属无法确认**，不猜测、不填占位符。
- **测试**：本轮未复跑。主驾口径（聚焦 174/174；全量 1526 pass / 1 flake http-e2e 重跑 8/8）未独立核验。结论踩在源码与测试**文本契约**上。

## 方法

逐段对照 16:50 的 F1–F5 / S2 / S3 与当前磁盘。不信主驾口述。对抗式按「假设仍有罪」再扫一遍边界。

---

## 致命问题（必须改）

无。前序 F1–F5 在当前工作树上均有对应修补，且关键路径有行为测试（F1/F3）或终局测试（F4）咬住。对抗式未再找到能把「继续」重新打成 5 分钟静默环、或让 abort 后耗尽线程必活的缺口。

---

## 建议改进（值得讨论）

对抗式兜底（≥10）。均未升格为致命：要么窗口极窄，要么有更外层闸，要么是测试层级/体感残留。

1. **`withLifecycleEffect(started)` 仍不是 abort-safe** — `orchestrator.mjs:2761-2781` — MEDIUM  
   预算自增、`contextRecovery.state="compacting"`、`context_compaction_started` 仍包在带 owner 断言的 effect 里。abort 若落在 `save`/`emit` 之后、`compactThread` 之前：budget 已扣、状态停在 compacting、**session 尚未作废**。窗口是毫秒级，不是 5 分钟。下一次用户「继续」会 `allocateInteraction`（`:4593`）清零预算。仍建议把「扣预算 + compacting 落盘」改成与 `invalidateContextSession` 同款的 `withRunLifecycle`，或 abort 时补一条 failed/invalidate。

2. **`observeCompaction` 仍用任意 `turn/started` 绑定 turnId** — `codex-app-server.mjs:1318-1320` — MEDIUM  
   S2 主修复成立：`turn/completed` 在 `!compaction.turnId` 时直接 return（`:1338-1341`）。但绑定口是「该 thread 上第一条 `turn/started`」。迟到/重放的耗尽轮 `turn/started` 仍可能把错误 turnId 焊上，随后匹配的 `turn/completed` 会假成功。更硬的契约：只接受 `item type=contextCompaction` 或 `thread/compacted`。

3. **`thread/compacted` 仍无 turnId 门** — `codex-app-server.mjs:1333-1336` — LOW  
   该方法被当成权威成功信号，`turnId` 可空。若 provider 把 ack 误做成 `thread/compacted`，编排器会在未压缩线程上重试。这是协议信任，不是 S2 回退。

4. **压缩超时的 `interruptTurn` 是后台补偿** — `codex-app-server.mjs:1418-1436` — MEDIUM  
   timeout 路径立刻 `finishCompaction`，打断不等待。编排器随后可能 `send()` 新轮，撞 provider 侧仍活着的 compaction writer（`TURN_ACTIVE` / active writer）。abort 路径是等 10s 再 finish，两边不对称。建议 timeout 也 `await` 打断（或至少 `compactionsByThread` 延后删除到 interrupt 结束）。

5. **`interruptingRuns` 在普通轮死锁时仍可能长期挡住「继续」** — `orchestrator.mjs:1168-1169`、`:5152-5158`、`:5207` — MEDIUM  
   F5 的压缩特化已拆开：`CONTEXT_COMPACTION_INTERRUPT_MS = 10_000`（`codex-app-server.mjs:15-19,1406-1413`）显著小于默认 30s 闸。压缩窗口内中断不再与闸上限重合。但超时后闸仍只挂 `settlement.finally`；**普通 turn 永不 settle 时，「继续」仍要靠取消**。`run.interrupt_timeout` 现已带 `timeoutMs` 并进 `GOVERNANCE_EVENTS`（`app.js:15771-15776`），体感不再静默。这是存量机制，不是本轮 compact 回退。

6. **`compactingRuns` 不认 `recovery_required` / `interrupt_timeout`** — `app.js:16362-16368` — LOW  
   只在 completed/failed/cancelled/interrupted 时 delete。若 started 已入 Map、failed 事件丢失，呼吸行会假活。`run.contextRecovery?.state === "compacting"` 会叠加。建议把 recovery_required / interrupt_timeout 也清 Map。

7. **压缩治理事件带 `agentId`，非该席位成员页会被筛掉** — `orchestrator.mjs:2712-2719` 的 `{ agentId }` + `event-store.mjs:440` + `app.js:15830-15836` — LOW  
   总会话流（`!agentId`）和对应席位页会渲染；协调者页看不到注记。呼吸行不走该筛。F2 主路径成立，分席位时有盲区。

8. **前端/压缩契约测试仍偏源码字符串** — `stream-live-progress-contract.test.mjs:91-99`、`composer-target-ui.test.mjs:196` — MEDIUM  
   登记 `GOVERNANCE_EVENTS` 键名 + 「正在压缩上下文」即可绿。**没有**断言 `eventAffectsConversation` 对三事件为 true，也没有 DOM/会话流重建。`eventAffectsConversation` 我按源码核过：`:18186` `return Boolean(GOVERNANCE_EVENTS[event.type])`，三事件已入表（`:15700-15716`），主路径成立。测试仍照不出「表在、渲染函数提前 return」类回归。

9. **适配器侧 S2/F5 没有行为测试** — `tests/adapters.test.mjs` 现有终局/半截/silent-error，**无**「未绑定 turnId 的 `turn/completed` 不得 finishCompaction」、**无** compact interrupt 10s vs 30s。这两条回退目前只靠注释和常量。

10. **压缩仍无静默看门狗** — `codex-app-server.mjs:14` vs `:1054-1067` — LOW  
    轮有 idle+墙钟双闸；压缩只有 5 分钟硬超时。10 秒内死透仍要等满窗口。F2 呼吸行减轻了体感，时间上界没变。

11. **`nativeTurnError` 对非对象错误仍返回 null** — `codex-app-server.mjs:38-45` — LOW  
    S3 主修复成立：`turnError == null` 才放行；缺 message 用 kind / 固定句兜底。`error: true` 这类非对象仍 `typeof raw !== "object"` → null。协议里几乎不会出现。

12. **`cancelEpochs` 只增不删** — `orchestrator.mjs:5215-5216`（前序 S5，本轮未动） — LOW  
    与 compact 循环无直接因果；长跑进程单调增长。`clearFinished` 仍不摘 epoch。

---

## 可保留（看似奇怪但合理）

- **F1 改走 `withRunLifecycle`**：`orchestrator.mjs:2680-2720`。删除仍受 `sessions[agentId] === exhaustedSessionId` 守卫；abort 后仍删线程，再按 `controller.signal.aborted` 返回 `ABORTED` 而不是把取消改写成 `recovery_required`（`:2721-2734`）。行为测试咬死：`orchestrator.test.mjs:397-447`（压缩窗口内 interrupt → `sessions[agentId] === undefined` + `context_compaction_failed.sessionInvalidated`）。
- **双闸（预算计数器 + 递归参数）**：`MAX_CONTEXT_COMPACTIONS_PER_INTERACTION = 1`（`:44`）在发起前自增（`:2762-2763`）；压缩后递归 `allowContextRecovery: false`（`:2812-2819`）；auto-recovery 同样显式 false 且透传 `nativeCommand`（`:2890-2901`）。二次耗尽测试：`orchestrator.test.mjs:356-395`（`compactCalls.length === 1`）。auto-recovery 嵌套测试：`:451-495`（超时后续跑再撞上下文 → **0 次 compact**）。这不是漏修，是故意 fail-closed：先超时再耗尽的交互直接作废会话，不用再开 5 分钟窗口。
- **F4 异常终局改 `assistant.partial_message`**：`codex-app-server.mjs:1134-1151`。前端不当成回复气泡：`app.js:15941-15950`（`kind: "tool-result"` + 「未形成交付」）。负向测试：`adapters.test.mjs:2437-2476`；正常终局恰好一次 `assistant.message`：`:2401-2434`；silent `turn.error`：`:2478-2514`。
- **F2 渲染链是通的**：三事件在 `GOVERNANCE_EVENTS`（`app.js:15700-15716`）→ `conversationMessageFromEvent` `:15977-15981` → `eventAffectsConversation` `:18186`。呼吸行：`trackContextCompaction` `:16353-16368` + `liveTurnMarkup` compacting 相位 `:16376-16391`。SSE 刷新：`:18351`。
- **F5 压缩 interrupt 10s**：常量注释写明与 30s 闸错开（`codex-app-server.mjs:15-19`）。abort 与 timeout **都**调 `interruptTurn`（`:1406-1436`）。`run.interrupt_timeout` 带 `timeoutMs`（`orchestrator.mjs:5152-5157`）。
- **`continue()` 在首个 await 前占住 controller / executions**：前序已核，本轮无回归信号。

---

## 总评

**前序五项致命问题，我按磁盘核对后认为都已修上，可以合入这条 compact/continue 路径；不要再把 16:50 的 F1–F5 当未修债。**

对照主驾声称：

| 声称 | 磁盘结论 |
|---|---|
| F1 invalidate 改 `withRunLifecycle`，abort 仍作废线程 | **成立**（`:2687-2720` + 测试 `:397-447`） |
| F3 显式预算 + auto-recovery 传 `allowContextRecovery:false` / `nativeCommand` | **成立**（双闸；测试 `:356-395`、`:451-495`） |
| F4 error 非空发 `partial_message` 不发 `assistant.message` | **成立**（`:1143-1151` + 测试 `:2437-2476`） |
| F2 三事件进 `GOVERNANCE_EVENTS` + 压缩呼吸行 | **成立**（表 + `eventAffectsConversation` 兜底 + live 相位） |
| F5 压缩 interrupt 10s；超时也 interrupt；事件带 timeoutMs | **成立**（10s 常量；timeout 路径有 interrupt；闸本身 30s 仍是存量） |
| S2 `turn/completed` 必须已绑定 turnId | **主路径成立**；绑定口仍偏宽（见建议 2） |
| S3 `turn.error` 存在即失败 | **主路径成立** |

对抗式没有推翻「循环有界」：单次交互最多一次 compact，第二次耗尽走 `invalidateContextSession`。压缩窗口 abort 后 `sessions[agentId]` 在测试覆盖的形状下必删。异常终态半截正文不再假扮交付。前端总会话流会渲染压缩事件。压缩中断不再与 30s `interruptingRuns` 闸对齐到永久锁死。

残留全是建议级：started 窗口的 abort-safety、假成功绑定口、timeout 后台 interrupt 竞态、前端测试偏字符串、普通轮死锁仍靠取消。这些不阻止本轮合入，但不要把 174/174 绿读成「压缩协议层已有 buggy-must-fail」。

__VERDICT__: APPROVED
__DELTA__: 烛(Codex) | 1 | 证据：orchestrator.mjs:2687-2901 与 app.js:15700-18186 核过 F1–F5 已修；补强残留见建议 1–4（started 非 abort-safe、turn/started 任意绑定、thread/compacted 无 turnId、timeout interrupt 不等待）
