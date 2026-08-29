<!-- 514cc-session-id: 2e5d4b63-9955-451a-96d9-ddc4ffedee71 -->
# Codex 评审：v42 R2-03 socialLoop 显式 opt-in

- **评审模式**：standard（正确性 / 默认路径 / caps / composer 接线）
- **评审范围**：`apps/control-center/src/social-contract.mjs`；`apps/control-center/src/orchestrator.mjs`（`resolveOrchestrationMode` / `run.socialContract` / `classifyAgentRoute` / `appendBus` / `socialLoop` / `execute`）；`apps/control-center/public/app.js`（`/social` opt-in）；`apps/control-center/tests/social-contract.test.mjs`；`apps/control-center/tests/social-orchestration.test.mjs`；相邻 `automations.mjs`
- **评审时间**：2026-08-18 13:15
- **Codex 模型**：Cursor 烛 subagent 直审（本工具面无 `codex-agent` MCP，未开对话桥 thread；不伪装连续）
- **总 token**：n/a

---

## 致命问题（必须改）

未发现「默认仍进 socialLoop / 无 recipient 仍入队 / 公开 API 把 caps 关成无限 / 新建任务 `/social` 没把 mode 改成 social」这四条直接破产。

相邻面有一条会让 R2-03 的 opt-in 在自动化上变成哑火，必须补：

1. **[automations.mjs:412-426] 带 `requestedAgentIds` 的自动化触发必炸，且没有 social 入口。** R2-03 把 `requestedAgentIds` 收成 social-only（`orchestrator.mjs:1858-1859`），但 `AutomationStore.trigger` 仍原样传 `requestedAgentIds`、**不传** `orchestrationMode`。缺省现在是 pipeline → `VALIDATION_FAILED`。`automations.test.mjs:234-253` 用 fake orchestrator 断言「会带上 requestedAgentIds」，绿的是假绿。`automations-page.js:481` 保存草稿时仍接受 @ 成员。结果：UI 能存「点名协作」自动化，点火必失败；想真社会模拟也没有字段可 opt-in。这不是「默认还在 social」，是 opt-in 只焊了 composer create，侧门既进不去也炸。

---

## 建议改进（值得讨论）

1. **[app.js:17526-17580 + 17639-17667] 选中会话时 `/social` 不会改 mode，会被当成续聊正文。** 新建任务路径确实写了 `orchestrationMode: socialOptIn ? "social" : "pipeline"`。但胶囊默认「有选中 run → `continueSelectedRun`」，`continue` 不解析 `/social`，也不改 `run.orchestrationMode`。`/new`（`enterNewTaskComposer` `app.js:14449-14457`）会清 `selectedRunId`，之后 `/social` 才生效。斜杠菜单 `LOCAL_SLASH_COMMANDS`（`app.js:6964`）没有 `/social`。测试只扫源码字符串（`social-contract.test.mjs:41-45`），不覆盖「选中会话提交」。LO 体感上这就是「我打了 /social 但没进社会模拟」。

2. **[social-contract.mjs:17-26 vs orchestrator.mjs:1857 / 1973] 服务端注释声称「或 /social」，`create()` 并不读 prompt。** `resolveComposerOrchestration` 存在但 orchestrator 未引用。API 只认 `orchestrationMode` 字段；prompt 里写 `/social …` 仍是 pipeline。对「默认不进 social」是 fail-closed，对「composer /social」则把真相全压在前端双份正则。两处正则已经能漂（`/pipeline` 服务端要 `\s+`，前端同样；单独 `/pipeline` 不会剥前缀）。

3. **[orchestrator.mjs:2925-2927] 预算闸 fail-open。** `budgetExhausted`：`cap = (Number(run.maxBudgetUsdPerTurn) || 0) * maxSteps`，`return cap > 0 && cost >= cap`。`maxBudgetUsdPerTurn` 为 0 / NaN / 缺省时 **永不耗尽**。`create()` 用 `Math.max(0.05, …)`（`2048`）挡住了公开创建口；`projectSocialContract` 也会拒 `budget <= 0`（`social-contract.mjs:44`）。运行时仍信 `run.maxBudgetUsdPerTurn` 而不是 `socialContract.maxBudgetUsdPerTurn`，且注释已承认「只覆盖回传 costUsd 的 adapter」。社会模拟的「必须有预算」在无成本回执的 provider 上不是硬顶，只靠轮次 / guard / ping-pong。

4. **[social-contract.mjs:42-46, 80] `pingPongLimit` 无上限。** `projectSocialContract` 对 hops 只要求 `finite && >= 1`，不夹到 `SOCIAL_PING_PONG_LIMIT`。`create()` 目前不接受该入参，默认 2。`classifyAgentRoute` / `socialLoop:3659` 信任已 persisted 的 `socialContract.pingPongLimit`（`socialContractOf` 在 `optedIn===true` 时原样返回，`57-59`）。被改过的 run JSON 或未来 API 暴露该字段时，回环上限可以被拉到形同关闭。应对 opted-in 合同再夹一次（建议上限 2 或 4）。

5. **[social-contract.test.mjs:22-38] 合同测试没断言「social 缺 rounds/budget 必扔」。** 现有用例只测了齐备合同 + pipeline 不 opt-in。缺 cap 的 throw 路径、`socialContractOf` 在 `optedIn:false` 但 `orchestrationMode:"social"` 时会重建合同（`61-68`），都没有回归。

6. **[orchestrator.mjs:3470] ping-pong 计数是 `socialLoop` 局部 Map。** 每次 `execute` / `continue` 再进 loop 都从 0 计。单次循环有 hops/guard/step 顶，不会无限互聊；跨次用户消息或重启后同一对可以再走满 2 跳。若验收要把「回环上限」理解成整场 run 而不是单次 loop，需要把 hops 落到 bus/run。

---

## 可保留（看似奇怪但合理）

1. **缺省 `orchestrationMode` → pipeline，且 `execute()` 用严格 `=== "social"` 才进 `socialLoop`（`1857`、`2039-2046`、`3105-3115`）。** 不传字段、传 `pipeline`、旧 run 无该字段，都不会派社会模拟。`social-orchestration.test.mjs:2333-2350` 已把默认断言翻过来。这是 R2-03 的主不变量，成立。

2. **`appendBus` 无 recipient 直接扔（`3056-3060`，`SOCIAL_RECIPIENT_REQUIRED`）。** `classifyAgentRoute` 空 `to` 同样扔（`social-contract.mjs:74-75`）。`parseDirectives` 的 `[[msg:]]` 要求 1–64 合法字符（`bus.mjs:23`），做不出空收件人。`[[msg:team]]` 写 bus 但不入队（`socialLoop:3641`），不是无 recipient 路由。

3. **团队图不从最终文本反推。** `recordTaskGraphDelegation`（`orchestrator.mjs:1459`）只在显式 mention/route 时写边。Mission Control 的图来自 `run.taskGraph` + bus 直达消息（`mission-control.mjs:749-790`），`buildEvidenceGraph` 吃的是 attempts/messageRoutes，不解析 `result.final`。

4. **`hops == pingPongLimit` 仍 queued、`hops > limit` 才丢（测试 `social-contract.test.mjs:35-36`）。** 上限 2 表示允许两跳、第三跳丢。`socialLoop` 另有 `guardLimit = max(4, maxSteps*2)` 和 `interactionLimitReached`。不是无限互聊。

5. **`create()` 不解析 prompt 里的 `/social`。** 对 API 是 fail-closed：只认显式字段。composer 新建任务自己设字段。不要改成「看见斜杠就 social」，否则任意客户端都能用 prompt 走私 opt-in。

6. **正式版本仍是 v3.5.0。** `module.yaml:3`、`rules.md` §八、`delivery-ownership.json:7` 未随 R2-03 升格。

---

## 总评

R2-03 的核芯焊住了：默认 pipeline，社会模拟必须 `orchestrationMode:"social"`（composer 新建任务的 `/social` 会写入该字段），agent-to-agent 入队要 recipient + 合同 + hops/depth，bus 无收件人 fail-closed，团队图走权威边而不是终态文本，版本没被顺手抬走。

没焊完的是 **opt-in 只覆盖了 orchestrator.create + composer 新任务**。自动化仍按旧契约塞 `requestedAgentIds`、自己却不能声明 social，真实 trigger 必失败、测试因 fake orchestrator 看不见。选中会话时 `/social` 也进不了社会模拟。预算/回环在运行时仍有 fail-open 或「信任已落盘合同」的缝。

先补自动化的 mode 字段（有 requestedAgentIds 必须显式 social，否则保存期拒），再决定 `/social` 是只活在 `/new` 还是续聊也要拦截提示。不要为了「方便」让 prompt 斜杠在服务端偷偷 opt-in。

---

## 下游建议

### 建议召唤

- 主驾修 `automations.mjs` trigger / schema，并加一条 **真 orchestrator** 回归（不要再只打 fake）。
- 不必为这轮再召织；无外部 CVE 面。

### 风险信号

- `automations.test.mjs` 绿 ≠ 生产 trigger 绿。
- composer `/social` 的回归是源码 `assert.match`，选中会话路径是盲区。

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 1 | architecture | 证据：apps/control-center/src/automations.mjs:412-426 触发仍传 requestedAgentIds 且不传 orchestrationMode，撞上 orchestrator.mjs:1858-1859 的 social-only 门；主驾 opt-in 主干成立，侧门未焊
