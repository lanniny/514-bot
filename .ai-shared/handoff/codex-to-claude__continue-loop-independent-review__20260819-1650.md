# Codex 评审：「继续」循环 / context compact 恢复路径 独立深度评审

- **评审模式**：deep-review（对抗式兜底开启）
- **评审范围**：`apps/control-center/src/adapters/codex-app-server.mjs`、`src/orchestrator.mjs`、`public/app.js`、`public/modules/resume-hints.js`、`src/adapters/stream-utils.mjs`、`tests/{orchestrator,adapters,router,codex-process-visibility}.test.mjs`
- **评审时间**：2026-08-19 16:50
- **评审者**：烛（代码守夜人），独立于主驾判断
- **自由格式**：false
- **session 归属**：本轮未收到 route-gate 注入的 `514cc-session-id` marker，按 SKILL §4a 兜底如实声明——**session 归属无法确认**，不猜测、不填占位符。

## 方法与诚实边界（先说清楚我验证了什么）

- `git --no-pager diff HEAD -- apps/control-center` **多次返回无退出状态**（本机 shell 在长命令上不稳定，重定向到文件也未生成产物）。因此本次评审**不是基于 diff，而是基于工作树当前源码全文**逐行读。结论对当前代码成立；我**无法**独立核对「18 文件 / 1186 插入」这一 diff 边界。
- 前序声称的「259/259 聚焦回归通过」**未能复现同一口径**（未说明文件集合）。我实跑了本轮重点四个文件：
  `node --test tests/orchestrator.test.mjs tests/adapters.test.mjs tests/router.test.mjs tests/codex-process-visibility.test.mjs`
  → **tests 200 / pass 200 / fail 0 / skipped 0**（duration 6.1s）。**测试确实是绿的**，但下面 §测试一节会说明：绿不等于覆盖了故障本身。
- 我**没有**修改任何源码去做 buggy-must-fail 实验（只读评审纪律）；相关判断按代码路径推理给出，并标注置信度。

---

## 致命问题（必须改）

### F1 · 取消/中断落在压缩窗口内时，fail-closed 直接失效——耗尽的原生线程原样留给下一次续聊

**证据**：`src/orchestrator.mjs:2669-2716`（`invalidateContextSession` 全部副作用包在 `withLifecycleEffect` 内）、`:2753-2755`（compact 抛错的唯一出口）、`:1167-1174`（`withLifecycleEffect` 第一件事就是断言 owner）、`:1283-1287`（`assertLifecycleOwner`：`controller.signal.aborted` 即抛 `ABORTED`）、`src/adapters/codex-app-server.mjs:1383-1394`（abort 是 `compactThread` 的主要 reject 通道）。

代码路径：

```
turn() → adapter.compactThread(...)          // 最长 5 分钟（codex-app-server.mjs:14）
  ↓ LO 点中断 / cancel → controller.abort()
compaction.onAbort → finishCompaction(reject) // codex-app-server.mjs:1383
  ↓
catch (compactionError) { throw await invalidateContextSession(compactionError) }   // orchestrator.mjs:2754
  ↓
withLifecycleEffect → assertLifecycleOwner → throw ABORTED                          // orchestrator.mjs:1169
  ↓
delete run.sessions[agentId] 从未执行；run.contextRecovery.state 永久停在 "compacting"
抛出的是 ABORTED，不是 RECOVERY_REQUIRED
```

后果正是本次要修的那个故障：耗尽线程活着留在 `run.sessions`，下一次「继续」直接 resume 它 → 再次 `CONTEXT_WINDOW_EXCEEDED` → 再压缩 → 再 5 分钟静默。**fail-closed 只在「压缩自己失败」时成立，在「压缩被打断」时是 fail-open。** 而压缩被打断恰恰是最高频的真实场景（见 F2：LO 看不到任何动静，本能就是去点中断）。

**修法建议**：session 失效必须 abort-safe。把删除 + 落盘从 `withLifecycleEffect` 里挪出来，走一条无条件的 `withRunLifecycle`（不带 owner 断言）；或者 `catch` 掉 `ABORTED` 后仍完成失效与持久化，再把原始 compactionError 包成 `RECOVERY_REQUIRED` 抛出。另外 `run.contextRecovery.state === "compacting"` 需要有终结出口，不能靠成功路径独占收尾。

---

### F2 · 压缩全程对 LO 不可见——三个事件后端发了，前端一条都不渲染

**证据**：`src/orchestrator.mjs:2696`（`run.context_compaction_failed`）、`:2738`（`run.context_compaction_started`）、`:2766`（`run.context_compaction_completed`）三处 `emitEvent` 都在；`public/app.js:15683-15754` 的 `GOVERNANCE_EVENTS` 表里**这三个类型一条都没有登记**；`public/app.js:15940-15946` 未登记类型走 `return null`，即会话流零渲染。全仓 grep `context_compaction` 只有 orchestrator 那 3 处命中，前端与测试均为 0。

默认压缩超时 `DEFAULT_CONTEXT_COMPACTION_TIMEOUT_MS = 5 * 60_000`（`src/adapters/codex-app-server.mjs:14`）。也就是说：LO 点「继续」之后，会话流可以整整 **5 分钟零输出、零注记**；压缩**失败**同样一声不吭（只体现为最终那条 `run.recovery_required`）。同期 `run.invalidatedSessions`（orchestrator.mjs:2679）也没有任何渲染面——「旧线程已经被安全作废」这件对 LO 最重要的事，是不可见的。

这条本身就是 LO 反复说的「建了但感知不到」反模式；更要命的是它是 **F1 的触发器**：看不到进展的人一定会去点中断，而中断正好踩进 F1 的 fail-open。修复的立意（让「继续」不再卡死）在体感层面基本没有兑现。

**修法建议**：三个事件登记进 `GOVERNANCE_EVENTS`（started=amber「正在压缩上下文，最长 5 分钟，请勿中断」/ completed=amber / failed=rose 并点明「旧会话已作废，需确认后开新线程」），并在压缩期间给活跃指示（`liveTurnMarkup` 相位文案）一条专门相位。

---

### F3 · 自动续跑递归把 `allowContextRecovery` 重新打开——「一次压缩上限」这个不变式是假的

**证据**：`src/orchestrator.mjs:2775-2783` 的 context 分支递归**显式**传 `allowContextRecovery: false`；而 `:2853-2859` 的 auto-recovery 分支递归**没有传**该参数，于是回落到签名默认值 `allowContextRecovery = true`（`:2296`）。

可构造序列（全部在**一次**用户「继续」之内）：

```
turn A (ctx=true , auto=true )  → CONTEXT_WINDOW_EXCEEDED → 压缩#1 → 
turn B (ctx=false, auto=true )  → TURN_IDLE_TIMEOUT + interruptConfirmed → 自动续跑 →
turn C (ctx=true , auto=false)  ← 这里 ctx 被重新打开 → CONTEXT_WINDOW_EXCEEDED → 压缩#2 →
turn D (ctx=false, auto=false)
```

`:2721` 的错误文案写着 `"context was still exhausted after one compaction retry"`——**照着「只有一次」写的，但代码允许两次**。文案与行为不一致，且时间上界从「1×5min 压缩 + 1 轮」变成「2×5min 压缩 + 3 轮」；`turnTimeoutMs` 现值 1800000（DESIGN-NOTES.md:437）时，单次「继续」的最坏静默期以小时计。

循环**确实有界**（`MAX_AUTO_RECOVERIES_PER_INTERACTION = 2`，`:40`/`:1114`，且 C 轮 `allowAutoRecovery:false` 封口），所以不是无限循环；但正面命中主驾问题 1 的措辞——**这次修复在这条路径上是把循环变长，而不是终止**。另外同一处还漏传了 `nativeCommand`（`:2853` 对比 `:2782`），语义上把一个原生命令轮静默降级成散文轮。

**修法建议**：`:2853` 的递归补齐 `allowContextRecovery: false`（与 2781 对称），并把 `:2721` 的文案改成与实际上限一致；或者干脆把「本次交互允许的压缩次数」提成显式计数器（像 `interactionAutoRecoveries` 那样落到 run 上、可审计、可在事件里显示），而不是靠参数在递归里传递——参数传递正是这次漏掉的原因。

---

### F4 · 被中断/超时轮的半截正文被当成正常回复投进会话流（本轮新引入，且违反同项目既有契约）

**证据**：`src/adapters/codex-app-server.mjs:1112-1130`——新加的 `assistant.message` 出口写在 `finalizeActive` 顶部，判据只有 `text.trim() && !active.assistantMessageEmitted`，**完全不看形参 `error`**。而 `cancelActive`（超时 / 中断 / abort / OUTPUT_LIMIT）最终一律走 `finalizeActive(threadId, active, { error })`（`:1060-1104`、`:1614-1629`）。

同一个仓库里，另外两个 adapter 明确禁止这件事：
- `src/adapters/grok-build.mjs:258` — `if (finalText && !isAbnormalProviderTurnStop(stopReason))` 才发；
- `src/adapters/pi-rpc.mjs:195-201` — `outputLimitError` 时直接 `return`，不发；
- 并且有**成文的负向断言**：`tests/adapters.test.mjs:439`（pi）、`tests/grok-build.test.mjs:79`（"cancelled partial text leaked as a normal assistant reply"）。

codex-app-server 现在是全项目唯一的例外——而它是主力 adapter。实际观感是：一条被打断的轮同时产出「一条看起来完整的 assistant 回复」+ 编排器的 `agent.turn_unproductive`「本轮没有产出 / 异常中止」注记（`public/app.js:15709-15716`）。LO 无法区分「答完了」和「答了一半被杀」，这直接踩 §二.5 Integrity Gate 与 §二.3 的诚实红线。

**修法建议**：`:1125` 的条件加上终态判据——正常终局才发 `assistant.message`；异常终局（`error` 非空且非 provider 正常收束）改发带明确标记的部分产出事件（或复用 `agent.turn_unproductive` 的 `hasPartialOutput` 通道），并补一条与 `adapters.test.mjs:439` 同款的负向断言。

---

### F5 · 中断闸在压缩窗口内会把「继续」长时间（极端情况下永久）锁死

**证据**：`src/orchestrator.mjs:1155-1165`（`assertContinuationAdmission`：`interruptingRuns.has(runId)` → 抛 `RUN_INTERRUPTING`）、`:5084`（interrupt 入口 add）、`:5096-5113`（30s 未 settle → `run.status = "recovery_required"`、`recoveryNote = "Do not continue yet..."`，闸的释放改挂在 `void settlement.finally(...)`）、`:5161`（只有 settled 才在 finally 里释放）、`:339/:351`（`interruptTimeoutMs` 默认 30_000）。

这是**存量机制**，但本轮的压缩把它推进了一个此前不存在的触发面：`turn()` 在 `await adapter.compactThread(...)` 上一挂就是最长 5 分钟；abort 之后 `compaction.onAbort` 还要先 `await interruptTurn(threadId, compaction.turnId, 30_000)` 才 finish（`codex-app-server.mjs:1385-1390`）——**恰好与中断闸的 30s 上限重合**。一旦 settle 慢于 30s：run 被写成 `recovery_required`，`interruptingRuns` 不释放，此后**每一次「继续」都被 `RUN_INTERRUPTING` 拒绝**，LO 侧的现象就是原报障的另一半——「无法继续执行」。若执行链因任何原因不 settle（adapter 死锁 / 事件持久化超时），除了 `cancel` 没有任何操作面能把闸摘掉。

**修法建议**：`interruptTurn` 的等待时间必须小于 `interruptTimeoutMs`（比如 10s），或让 `compactThread` 的 abort 路径立即 finish、把 interrupt 作为后台补偿；同时给 `interruptingRuns` 一个带上界的兜底释放 + 可见的治理注记，别把唯一出口挂在一个可能永不 settle 的 promise 上。

---

## 建议改进（值得讨论）

### S1 · 压缩超时路径不打断原生轮，与 abort 路径不对称，泄漏一个活着的 provider turn
`src/adapters/codex-app-server.mjs:1395-1402` 的 timer 只 `finishCompaction(reject)`，**没有** `interruptTurn`；而 `:1383-1394` 的 abort 路径是打断的。超时后 `compactionsByThread` 删除、适配器彻底遗忘该轮，但 provider 侧的 contextCompaction turn 还在跑。之后任何对该 threadId 的 `send()` 会撞 `:1458` 的「active writer」或撞 provider 侧的 TURN_ACTIVE。建议超时路径复用 abort 的打断逻辑。

### S2 · `observeCompaction` 在 `turnId` 未绑定时会把不相关的 `turn/completed` 认成压缩成功
`src/adapters/codex-app-server.mjs:1316-1318`：`if (compaction.turnId && compaction.turnId !== eventTurnId) return;` —— `turnId` 为 `null` 时**放行**，随后 `finishCompaction()` 判为成功。`:1458` 的互斥只覆盖同一个 adapter 实例；跨实例（远程 adapter、同 thread 被另一 run 复用）或迟到通知都能制造假成功。假成功 → 编排器在**未压缩**的线程上重试 → 再次 `CONTEXT_WINDOW_EXCEEDED`。建议：只接受 `thread/compacted`，或要求先观测到 `contextCompaction` item / `turn/started` 完成绑定后才认 `turn/completed`。

### S3 · silent fallback：provider 报错但 message 为空时，失败轮被判成功
`src/adapters/codex-app-server.mjs:38-39`：`if (!turnError?.message) return null;`。只要 `params.turn.error` 存在就说明这轮失败了；message 缺失（或只有 `codexErrorInfo`）时返回 `null`，`:1203-1217` 就会走 `result` 成功分支，把一条失败轮（包括 `contextWindowExceeded`）结算成「成功但正文为空」。这是主驾问题 5 要找的那类 silent fallback——概率低但性质明确。建议：`turn.error` 存在即必须产出错误，message 用 `codexErrorInfoKind()` 或 code 兜底。

### S4 · `run.contextRecovery` 是只写字段，没有任何消费者
全仓引用只有 `orchestrator.mjs:2686/2730/2758/2942-2947` 与两条测试断言；前端 0 引用、没有任何门禁读它。既然它承载「压缩中 / 完成 / 失败」的状态机语义，要么接进恢复条与 F2 的渲染，要么明确降级为审计字段并在注释里说清——现在这个中间态会让后来的人以为有状态保护。

### S5 · `cancelEpochs` 只增不删
`orchestrator.mjs:370` 建表、`:5170` 唯一写入点，全仓无任何 `delete`。run 被 clear 后条目仍在，长跑进程下单调增长；且若 runId 复用会带着历史 epoch 让新 run 的首个 continue 准入异常。建议在 tombstone / `clearFinished` 处一并清。

### S6 · 测试断言层级偏低，关键契约没有覆盖（回答主驾问题 4）
- `tests/codex-process-visibility.test.mjs:173` 用**源码字符串**断言 `assertIncludes(adapter, 'queueActiveEvent(active, "assistant.message"')`。删掉那行会红，所以有最弱意义上的 buggy-must-fail；但它**不断言行为**：不测「恰好一次」、不测「异常终态不得发」（F4 因此完全没被照出）、不测顺序。
- `tests/orchestrator.test.mjs:244-301`（压缩成功后续跑）与 `:303-354`（压缩失败 → 作废旧线程 → 必须 ack）**是合格的行为契约测试**，是本轮最扎实的部分；`tests/adapters.test.mjs:2283-2355`（compact RPC ack 不是终态边界）同样是真契约、回退必红。
- 但**缺**三条最关键的：①「压缩成功后二次耗尽 → 必须 `RECOVERY_REQUIRED` 而不是再压缩」（`orchestrator.mjs:2718` 分支，也就是循环终止的唯一硬断言）；②「压缩期间 abort → 旧 session 必须已作废」（F1）；③「自动续跑递归不得重新打开 context recovery」（F3）。
- 结论：**现有测试无法照出 F1/F3/F4**。200/200 全绿这件事，对「循环是否真的收敛」几乎没有证据力。

### S7 · 压缩没有静默看门狗，只有硬超时
轮有双闸（`turnTimeoutMs` + `armIdleWatchdog`，`codex-app-server.mjs:1044-1058`），压缩只有一个 5 分钟硬闸。压缩若在 10 秒内就死透，也要等满 5 分钟——直接放大 F2/F5 的窗口。建议压缩也吃 thread 上的通知流量做 liveness。

---

## 可保留（看似奇怪但合理）

- **`finalizeActive` 里补发 `assistant.message` 这个改动本身，方向是完全正确的，而且是本轮真正的根因修复**：`public/app.js:18090-18096` 明确写着 `isDeltaEventType(...) return false; // final assistant.message 才提交正文`——即前端**一直**依赖一条终局 `assistant.message` 来落正文，而 codex-app-server 此前只发 `codex.item/agentMessage/delta`，从不发 `assistant.message`。结果就是 Codex 席位的最终回答在 CLI 里完整、在控制台里蒸发（`codex-app-server.mjs:1126-1127` 的注释如实记了这一点）。**「点了继续什么都没出现，于是再点」这个用户侧循环，根因就在这里**，这一刀砍对了。F4 说的是这刀的边界没收干净，不是方向错。
- **`compactThread` 把「RPC ack ≠ 终态」拆开等待**（`codex-app-server.mjs:1407-1420` + `observeCompaction`）：Codex 0.147.0 的 `thread/compact/start` 只确认「已发起」，真正的 contextCompaction 是后续独立一轮。不等终态就返回会让编排器在压缩还没完成的线程上立刻重试。`tests/adapters.test.mjs:2283-2355` 给了这条契约一个真断言（回退必红）。这是本轮最扎实的一处。
- **`send()` 与 `compactThread` 互相把对方计入「thread 已有活跃写者」**（`:1348-1361` 与 `:1458-1466`）：看起来是两处重复检查，实际是双向互斥，缺任一侧都会让压缩与普通轮在同一 thread 上并发。合理，别合并。
- **`measureUtf8Append` 里那个 `-2` 魔数**（`src/adapters/stream-utils.mjs:7-20`）：孤高位代理在 `Buffer.byteLength` 里按 U+FFFD 记 3 字节，孤低位同样 3 字节，合成后真实占 4 字节 —— `3+3-2=4` 正确。跨 chunk 代理对的字节记账我按边界推演验过，是对的。
- **`continue()` 把 `controllers.set` / `inflightContinuations.set` 放在第一个 `await` 之前**（`orchestrator.mjs:4502-4508` 及其上方注释）：看着像过度小心，实际关闭了「同一句话在准入落盘前被派两轮」的 TOCTOU 窗口。`executions` 的 `continue:${id}` 键与 `startExecution` 的裸 `id` 键分离（`:4705-4710`）也是必要的——合并会让 `ensureSteerDrained` 的 `has(id)` 判据失真。**主驾问题 3 在这条链上我没有找到破绽**，写得比一般代码谨慎。
- **`resume-hints.js` 的 `escapeHtml` 全覆盖**（`public/modules/resume-hints.js:63-68` + `public/utils.js:10-17`）：`data-copy-resume="..."` 属性里的引号已转义，未知 provider 走 `canResume=false` fail-closed。这里没有注入面。

---

## 总评

**核心那一刀砍对了，但收尾没收干净，现在不能上生产。**

本轮真正的根因修复有两处，都成立：①Codex 席位终局正文此前从不进会话流（`codex-app-server.mjs:1125-1130` × `app.js:18096`），这是「点了继续什么都不出现→再点」的用户侧循环源头；②`thread/compact/start` 的 ack 不是终态，改成等 contextCompaction 轮真正收口（`:1407-1420`），并且有真契约测试兜底。这两条我独立核过，值得肯定。

但「循环真的收敛了吗」这个问题，我的答案是**没有完全收敛**：

1. **fail-closed 有条件失效**（F1）——压缩窗口内的取消/中断会让 `invalidateContextSession` 在 owner 断言处直接短路，耗尽线程原样留下，下一次「继续」必然重演。这不是理论构造，是最高频的真实操作序列。
2. **「一次压缩上限」是假的**（F3）——auto-recovery 递归漏传 `allowContextRecovery: false`，代码允许两次压缩，而错误文案是照一次写的。循环有界但被拉长，正是主驾担心的「变慢而非终止」。
3. **另一半故障「无法继续执行」没被碰**（F5）——中断闸的 30s 与压缩 abort 的 30s 打断等待边界重合，超时即把 run 钉在 `recovery_required` 且 `RUN_INTERRUPTING` 长期拒绝续聊。
4. **整条新机制对 LO 不可见**（F2）——三个压缩事件后端发了、前端一条不渲染，5 分钟静默零信号。它既是体感层面的「白做」，也是 F1 的物理触发器。
5. **诚实红线破了一处**（F4）——被打断轮的半截正文以正常 assistant 回复出现，与同项目 grok-build / pi-rpc 的成文契约（含负向测试）直接冲突。另有一处低概率 silent fallback（S3）。

测试侧：200/200 我实跑确认是绿的，两条 orchestrator 压缩测试和一条 adapter 终态边界测试是真行为契约、回退必红——这部分不是花架子。但**它们照不出 F1/F3/F4**，缺的恰好是「循环终止」这条唯一的硬断言（`orchestrator.mjs:2718` 分支无测试）。所以「259/259 通过」不能作为「循环已收敛」的证据，两者是不同的命题。

**上生产判断：CHANGES_REQUESTED。** F1、F3、F4 必须改（都是小改，各 1-5 行 + 对应测试）；F2 建议同批出（否则修好了 LO 也感知不到，等于没修）；F5 可以单独排一波，但在它修掉之前，「继续」被 `RUN_INTERRUPTING` 卡死的报障还会回来。

---

## 下游建议

### 建议召唤
- **策（spec-architect）**：F3 暴露的是「压缩预算靠递归参数传递」这个结构问题。建议出一份小规格，把「单次交互的压缩次数」提成与 `interactionAutoRecoveries` 同级的显式计数器 + 事件可见项，而不是继续在递归参数上打补丁。
- **主驾自己**：F2 是纯前端渲染登记，改动小、体感收益最大，建议与 F1/F3/F4 同批落，否则这波修复对 LO 依然是"看不见"的。

### 风险信号
- 本次评审**未能取得 diff**，findings 全部基于工作树源码。若 F1/F3/F4 中某条其实是本轮之前就存在的存量债，性质不变（仍需修），但归因描述需要主驾用 diff 复核后调整。
- `interruptingRuns` 的释放挂在可能永不 settle 的 promise 上（F5），这是一个没有上界的状态，建议无论本波是否修 F5，都先加一条可观测（`/co-status` 或治理注记）让它别再静默锁死。

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 2 | 证据：orchestrator.mjs:2853 auto-recovery 递归漏传 allowContextRecovery:false 使「一次压缩上限」不成立、orchestrator.mjs:2671 压缩期 abort 令 invalidateContextSession 在 owner 断言处短路致 fail-closed 失效——推翻前序「继续循环已修复」的结论
