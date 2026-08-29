<!-- 514cc-session-id: a15f882e-8bb5-45d0-8ca7-e7944aae991b -->
# 协作台对话逻辑五条根因修复（run d63b839d 现场取证）

日期：2026-08-14
执行者：主驾（Claude / 洛琪希皮肤）· 未召唤外部 subagent（会话级 harness 指令禁止未经 LO 请求的 AgentTool）
状态：`IMPLEMENTED / 待 LO 验收`。未 commit、未 push。

## LO 报的现象

新建会话点一个成员（金色暗影 = `member-051ef0d3…`）对话：只说了「你好」，系统自己跑了第 2 轮官腔收敛；同一句「现在协作台不能直接复制粘贴图片请你完善」被回答两遍且两遍结论互相矛盾；说「请你继续执行」它反复要授权、永不动手；第 5 轮一片空白。4 句话用光 6 轮预算。

## 取证（不是推断）

磁盘真相：`.ai-shared/control-center/runs/d63b839d-….json` + `bus/d63b839d-….jsonl` + `events.jsonl`。

| 轮 | 来源 | 实际权限 | 结果 |
|---|---|---|---|
| 1 | task「你好」 | **workspace-write** | 正常 |
| 2 | **系统自动 finalize** | plan | 「线程已收敛，无后续输入」 |
| 3 | 直发 steer（`directContinuation`） | plan | 说「已支持图片粘贴」 |
| 4 | 排队 steer（`queuedSteerId`，**同一条 19 字文本**） | plan | 说「确实不支持」 |
| 5 | 直发 steer | plan | `stopReason=cancelled`，443 output tokens 全丢，text="" |
| 6 | 直发 steer | plan | 复读第 4 轮 |

`sessions` 全程同一个（`019ffdc8-…`），会话续接本身没问题。

## 五条根因

1. **续轮被降权成只读（最致命）**——`src/orchestrator.mjs` 两条续轮路径都不传 `allowWorkspaceWrite`，`turn()` 的 `requestsWorkspaceWrite` 因此恒 false，build 档位下 coordinator 落 `plan`。审批（`976d6fac`）、租约、工作树（`514cc-wt-…d48e0c95`）全部就绪却没人申请。成员在 plan 模式下**真的不能落盘**，还被系统提示要求「禁止声称已写入」，于是只能反复回「请确认是否要我立即执行」——指令与权限两端一起锁死。
   - 连带根因：`buildApprovalMessage` 把 `maxRounds` 放进审批哈希，而 `injectNextSteer` 每条插话都把 `maxRounds` +1 → **插话轮自己把审批作废了**（第 4 轮就这样掉进只读）。
2. **同一句话派两轮**——`public/app.js` 的 `setComposerMode` 无条件覆写发送键 `disabled`，把 `continueSelectedRun` 的在途锁冲掉；该函数由 SSE 驱动、一轮跑十几次。侧边聊天（`mission-side-chat-form`）复用主按钮 `click()`、草稿不清空、自己的 disabled 只看「有没有收件人」——成了绕过锁的第二个入口。服务端也无重复提交幂等门。
3. **自动 finalize 冗余轮**——`socialLoop` 自然收敛后无条件追加一轮 leader 收敛。单成员会话里是同一个 agent 综合自己刚说的话，零信息增量 + 吃掉 1/maxRounds 预算。
4. **provider 报 cancelled 被当正常完成**——grok adapter 把 `stopReason` 只落事件、不进 `send()` 返回值；编排器照记 `phase=completed` / `agent.turn_completed` / `round++`，还往 bus 塞一条空 `say`。UI 显示「第 5 轮完成」的空白气泡。踩安全底座「严禁 silent fallback」。
5. **预算被 ③④ 吃掉 1/3**——`round 6/6` 封顶，其中两轮纯浪费。

## 改动

### `src/orchestrator.mjs`
- 新增 `continuationWriteGrant(run, agentId)`：续轮写权限**预检**（build 档位 + 执行所有者 + 审批有效 + 租约 active）。不绕过 `turn()` 内部任何一道闸；授权链缺失返回 `reason`，调用方降级只读而不是抛 `POLICY_VIOLATION`——续聊里「这轮只能读」是可继续状态，报错不是。
- 新增 `emitWriteDegraded()` + `run.write_degraded` 事件。
- `injectNextSteer` / `continue` 直发：按同一规则申请 `allowWorkspaceWrite` + worktree cwd（与 `socialLoop` 一致）。
- `buildApprovalMessage` 的 `maxRounds` 改读 `run.buildApproval.approvedMaxRounds ?? run.maxRounds`；`awaitBuildApproval` 在算哈希前固化 `approvedMaxRounds`。
- 新增 `socialFinalizationWorthwhile(run)`（发言者 ≥ 2 才跑 finalize）；跳过时 `truncated` 不再谎报。
- `turn()` 收尾：`stopReason` 异常或零文本 → `agent.turn_unproductive` 事件（**轮次不退还**，见下）。
- 新增 `ABNORMAL_TURN_STOPS`；`inflightContinuations` 内存台账 + `continue` 的 `DUPLICATE_MESSAGE` 幂等门（只拦「尚未被消费」的重复，已回答过的重发放行）。
- 空文本不再 append 空 `say`（插话回复 / 直发回复两处）。

### `src/adapters/grok-build.mjs`
- `send()` 回传 `stopReason`。

### `server.mjs`
- `DUPLICATE_MESSAGE` → 409。

### `public/app.js`
- 模块级 `composerSubmitInFlight` + `setComposerSubmitInFlight()`（唯一写入口）；`setComposerMode` 的 disabled 裁决带上它；**停止态永不被锁**（发送在途时想中止，停止键正是唯一有意义的动作）。
- `syncSideChatTarget` 的 submit disabled 带上同一把锁；侧边聊天提交在途时明确 toast 并清空草稿。
- `run.write_degraded` / `agent.turn_unproductive` 两条事件注记；`turnMetaText` 标出「可写盘」；`DUPLICATE_MESSAGE` 人话文案。

## ⚠️ 两条安全语义变更（LO 请重点看这一节）

1. **续聊沿用 build 授权**。原先有一条测试明确保护相反语义（`an approved build grant is not reused by a later manual continuation`，终止后续聊恒只读）。也就是说：`continue` 不传写权限**对它而言是有意设计**，我最初把五条都归为「漏传参数」是不完整的判断。LO 2026-08-14 选定「沿用建 run 时的授权」后我改了这条语义，并把该用例改成更强的两面断言（租约有效能写 / 吊销后立刻回落只读 + 播报）。
   - 保留的边界：每轮仍过 `activeCapabilityLease`（TTL + 动作哈希 + 可吊销）、审批对象（工作区/执行者/权限档/prompt/policy）全部照旧入哈希、worktree fail-closed、`policy.limits.maxRounds` 硬顶。
   - 回退方式：`continuationWriteGrant` 首行 `return { allow: false, reason: null }` 即回到旧语义。
2. **审批哈希锚定「批准时的轮次上限」**。把「次数」从 action 身份里摘出来了：LO 批准时看到 `maxRounds=6`，后续插话可把实际上限推到 policy 硬顶（8）而无需重新审批。每一轮追加都由 LO 本人的消息触发，且硬顶不变。旧 run 无该字段时回落实时值，行为与改动前一致。

另有一条我**主动没做**的：无产出轮**不退还轮次**。那一轮已被 provider 接受并计费（LO 那次 443 output tokens），退还会放开超过 `maxRounds` 次真实派发（与 `refundableAbandonedAttempt` 同一条理由）。我给 LO 的选项里写的是「不计轮、退轮」，这里更正为「如实标记 + 明确告知预算已消耗」。

## 验证

- **红检 6 组，全部确认能变红**（buggy 必红，不是假基线）：写权限预检（3 闸红）、幂等门（1 闸红）、无产出轮（1 闸红）、审批哈希锚定（1 闸红）、adapter `stopReason`（1 闸红）、前端可见性（2 闸红）。每组红检后均恢复并复跑绿，`REDCHECK` 残留计数 0。
- 顺手修掉自己新测试的一个死锁：`gate.release()` 原在断言之后，断言失败时 `close()` 会等一个永不结束的 turn（红检时表现为挂死而非变红）。已挪进 `finally`。
- 既有 5 个 social 测试因 ③ 变更而更新断言，逐个核对过意图：4 个是顺带断言轮数；`prepared leader finalization resumes…` 测的是 durable work 恢复机制，改用真实存在的多成员场景（首轮路由给第二个成员）构造 finalize 边界，意图完整保留。
- 确认前端**不消费** `decide` 消息（跳过 finalize 不缺 UI）。
- 新增测试：`tests/social-orchestration.test.mjs` +6、`tests/grok-build.test.mjs` +1、`tests/collab-turn-visibility.test.mjs`（新文件）+4、`tests/composer-target-ui.test.mjs` +3 断言。
- 回归：全量 `npm test` **1114 tests / 1113 pass / 0 fail / 1 skip，真实 EXIT=0**；`npm run validate` **EXIT=0**；`node --check` 全过。
- **浏览器运行时实测**（隔离实例 + 隔离 HOME/data，Playwright）：`let composerSubmitInFlight` 声明位置晚于 `syncSideChatTarget`，存在 TDZ 风险 → 实测页面正常加载、**无 ReferenceError**；`submit-task-button.dataset.waitingApproval="0"` 证明新增接线真的执行了；两个提交入口初始状态正确。7 个 console 错误全是 `CONTROL_CENTER_TEST_MODE` 关掉的 channels/office/market/ssh 501，与本改动无关。实例已 202 优雅退出，`.tmp/` 清空。

## 留给 LO 的判断

1. **建议召唤烛复审**：本轮改的是编排核心 + **权限判定** + 审批哈希口径。按 §三 属 🔴 面，但本会话 harness 指令禁止未经 LO 请求就起 subagent，所以只做了自评 + 红检。要发火请说一声。
2. 上面「两条安全语义变更」需要 LO 明确认可或驳回（各附回退方式）。
3. 未处理、留作独立决策：`continue` 的 HTTP 同步等整轮（LO 那次挂 76 秒，是重复提交的诱因之一）——改成立即返回 + 走 SSE 需要动前端等待语义，不在本轮 scope。
4. 未 commit / 未 push。

__DELTA__: 主驾自评(无外部发火) | 1 | correctness | 证据：src/orchestrator.mjs continuationWriteGrant + buildApprovalMessage 锚定 approvedMaxRounds，修掉「审批/租约齐备但续轮恒 plan」与「插话 +1 自我作废审批」两层死锁；6 组红检确认反例闸 buggy 必变红
