<!-- 514cc-session-id: 01a00fb1-8675-7990-b545-9b22735b7ddb -->
# Codex 独立复审：v42 PM 交付审核 R2

- **评审模式**：deep-review / 项目交付与产品闭环
- **评审范围**：R0-R3 关键源码、测试、浏览器证据、路线图、context、decisions 与原 PM handoff
- **评审时间**：2026-08-18 20:02
- **基线提交**：`a8cb49d9b9def40ad3f41a5232f9132dc57ea644`
- **当前裁决**：`IMPLEMENTATION PARTIAL / DELIVERY BLOCKED / LIVE UNVERIFIED`

---

## 致命问题

### 1. 原“R0-R3 实现任务已经做完”结论不成立，必须按五层状态拆分

原交付包把“源码已接线”近似成“实现已完成”，但交付所有权、独立命令证据和正式运行态仍未闭环。当前只能分别记录：

1. 源码/契约：多数已接线，R0-01、R0-04、R3-01 仍有明确边界；
2. 聚焦验证：已通过；
3. 全量与隔离浏览器：已通过；
4. Git 交付：`qa:delivery --strict` 因 29 个未声明源码/测试失败；
5. 正式运行态：未 reload、未作 source/runtime/process/evidence readback。

因此 R1/R2 可记为 `source-complete / live-partial`，R0/R3 只能记为 `partial` 或 `blocked`，R4 为 `deferred`。路线图已经用该五层模型覆写旧口径：`proposals/v42-control-center-product-roadmap.md:42`、`proposals/v42-control-center-product-roadmap.md:44`。

### 2. HTTP 命令申报曾可伪装独立证据，工程门存在误绿风险

`PUT /api/release-record/commands` 是客户端/操作者申报，不能证明服务端实际执行了 validate、focused tests、full tests 或 browser QA。复审已将证据分为 `operator-attested` 与 `server-observed`；只有 `passed + matchesSource + server-observed + independent` 才可进入工程 ready：`apps/control-center/src/release-record.mjs:53`、`apps/control-center/src/release-record.mjs:61`。运行态还必须满足 `consistency === "consistent"`：`apps/control-center/src/release-record.mjs:207`。

当前生产态没有生成四类 `server-observed` 证据的受控 runner，因此 R3-01 仍是 `partial`。HTTP 自述即使全为 passed，也不能把工程门涂绿；回归钉位于 `apps/control-center/tests/release-record.test.mjs:114`。

### 3. Git 交付闭包尚未成立

最终 strict gate 实测为 `tracked=348 / physical=377 / undeclared source/test=29 / strict fail / exit 1`。这是交付闸正确阻断，不是测试回归，也不能通过忽略、自动暂存或把本地物理测试当 CI 交付来绕过。

未获 LO 对具体暂存范围的明确授权前，不执行 `git add/commit/push`。因此不能声称“工程门 ready”“已经发布”或“GitHub 已包含 v42 R0-R3”。

### 4. Unicode 与远程关闭只有本地契约证据，没有真实外部闭环

Prompt transport 已能在审计持久化失败或超过 1000ms 时 fail-closed，provider dispatch 不会启动：`apps/control-center/src/prompt-transport.mjs:122`、`apps/control-center/src/prompt-transport.mjs:139`。但尚未对每个已启用 provider 做中文/ASCII 接收回读，也没有真实 SSH UTF-8 echo，因此 R0-01 仍为 `partial`。

远程进程关闭已等待 `pkill` SSH 回执，并对 TERM/KILL 回执设置有界等待：`apps/control-center/src/ssh/remote-run.mjs:153`、`apps/control-center/src/process-runner.mjs:419`。最终对抗复核又发现原命令的 `|| true` 会把信号失败伪装成成功，现改为用 `pgrep` 区分“进程组已不存在”和“进程组仍在但发送失败”：`apps/control-center/src/ssh/remote-run.mjs:169`。这修复了“通道先关闭或 shell exit 0 就当远端进程树已停”的错误语义，但未在授权主机上做真实进程树 readback，R0-04 仍为 `partial`。

## 建议改进

### 已在本轮加固

1. **审计 fail-closed 不再无限悬挂**：默认 1000ms 超时，统一抛 `PROMPT_TRANSPORT_AUDIT_FAILED`，cause 为 `PROMPT_TRANSPORT_AUDIT_TIMEOUT`；回归见 `apps/control-center/tests/prompt-transport.test.mjs:128`。
2. **Release Record 信任边界**：HTTP 写入固定为 `operator-attested`，服务端入口单独标 `server-observed`；非一致运行态、旧提交证据和自述证据均不能 ready：`apps/control-center/src/release-record.mjs:158`、`apps/control-center/src/release-record.mjs:374`。
3. **Diff fail-closed 与脱敏**：Git 非零退出抛 `DIFF_UNAVAILABLE`；输出和 API 只暴露工作树 leaf，并替换绝对路径：`apps/control-center/src/run-diff.mjs:11`、`apps/control-center/src/run-diff.mjs:29`、`apps/control-center/tests/run-diff.test.mjs:75`。
4. **旧证据不再通过首次就绪**：必须 `passed + matchesSource + consistent`：`apps/control-center/src/first-run-readiness.mjs:33`。
5. **运营指标不依赖 turns 数组顺序**：首个有效响应取最早合法时间戳：`apps/control-center/src/ops-metrics.mjs:54`。
6. **远程 adapter 可恢复**：构造 Promise reject 后删除同一主人的 stale cache，下一轮可重建：`apps/control-center/src/orchestrator.mjs:1178`、`apps/control-center/src/orchestrator.mjs:1205`。
7. **Replay 身份稳定**：优先采用 `eventId/sequence/messageId/attemptId/approvalId`，仅旧数据才回退到位置字段：`apps/control-center/src/run-replay.mjs:63`。
8. **Inbox 与注意力 UI 收口**：答复改为行内表单，不再使用同步对话框；POST 携带 `expectedRevision`；attention 失败显示“注意力数据未知”：`apps/control-center/public/collab-flow.js:203`、`apps/control-center/public/collab-flow.js:592`。
9. **远程终止失败不再被 `|| true` 抹平**：`pkill` 非零后以 `pgrep` 确认进程组是否仍存在；仍存在或探针异常时返回 `REMOTE_TERMINATION_FAILED`：`apps/control-center/src/ssh/remote-run.mjs:169`、`apps/control-center/tests/remote-run.test.mjs:224`。
10. **首次就绪拒绝旧健康快照**：健康项只有同时携带 `available + !stale + capturedAt` 才能作为一次非付费验证；server 从 HealthService 传递 freshness 元数据：`apps/control-center/src/first-run-readiness.mjs:33`、`apps/control-center/server.mjs:232`。
11. **证据完整率不认路径字符串**：终态 run 仅有 `worktreePath` 不再算完整证据，必须有完成的 assistant turn 或非 route-preview 结果：`apps/control-center/src/ops-metrics.mjs:106`、`apps/control-center/tests/ops-metrics.test.mjs:115`。

### 下一步必须按顺序推进

1. LO 明确授权 29 个交付成员的暂存闭包；先审 manifest，再暂存，不使用宽泛 `git add .`。
2. 在确定提交或干净 checkout 上串行运行 validate、聚焦测试、全量测试、浏览器 QA。
3. 新增受控的 server-observed QA runner；记录 sourceCommit、exitCode、duration、checkedAt，不接受客户端覆写 provenance。
4. 经 LO 授权 reload 正式实例，再读回 PID/cwd/generation/sourceCommit/validationEvidence 一致性。
5. 分别经授权执行真实 provider 中文/ASCII 回读和真实 SSH UTF-8/TERM/KILL readback。
6. 四门闭环后再单独讨论正式版本升格；当前继续以 v3.5.0 为真源。

## 可保留

1. `qa:delivery --strict` 对 29 个未声明成员退出 1 是正确的 fail-closed 行为，应保留红灯而不是弱化门禁。
2. `autoGit`、`autoLanding` 保持关闭；结算中心只给 plan、diff 和风险，不自动 merge/commit/push。
3. Replay 保持只读，`submitting/submitted/ambiguous` 不自动重放，避免重复 provider 请求。
4. 社会协作保持显式 opt-in；默认 pipeline，避免无限互聊、成本失控和审计断链。
5. R4 按进入条件暂缓；在核心闭环未稳定前，不引入第二状态库、无签名市场、全量 IDE 或 CCB daemon/tmux/mobile 生命周期。
6. 隔离浏览器证据可保留为 UI 行为证据，但不能替代正式实例 readback。定向 Inbox 证据见 `apps/control-center/.qa-v42/targeted/result.json:2`；四档环境舱证据见 `apps/control-center/.qa-v42/environment-final/result.json:28`。

## 总评

本轮不是“发现几个小残差”，而是纠正了交付定义：代码与契约已明显增强，本地验证也已形成较强证据，但 Git、独立命令执行、正式运行态和真实外部系统仍是发布链上的硬缺口。

已验证：

- 聚焦复审：67 tests / 66 pass / 0 fail / 1 skipped / exit 0；
- 远程关闭专项：12 tests / 12 pass / 0 fail / exit 0；
- 最终增量聚焦：22 tests / 22 pass / 0 fail / exit 0；
- 最终全量：1493 tests / 1491 pass / 0 fail / 2 skipped / exit 0；
- validate：13 项全部 valid，CC-Switch commandCount=288，exit 0；
- 定向 Inbox 与四档环境舱浏览器 QA：`ok:true`，无横向溢出，`diagnostics:[]`，隔离实例 graceful shutdown 和临时目录回收成功；
- strict delivery：29 个未声明源码/测试，exit 1，交付保持 blocked。

最终裁决：`CHANGES_REQUESTED`。这里的 changes 不是继续扩功能，而是完成 manifest/Git 闭包、server-observed runner、正式实例 readback 和经授权的真实 provider/SSH 验收。在此之前，对外状态必须保持：

`IMPLEMENTATION PARTIAL / DELIVERY BLOCKED / LIVE UNVERIFIED`

---

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 2 | correctness | 证据：推翻原“R0-R3 实现任务已经做完/工程门 ready 材料已齐”的判断；`apps/control-center/src/release-record.mjs:61` 证明 operator-attested 不能打开工程门，strict gate 仍有 29 个未声明源码/测试且正式实例未 reload/readback。
__DELTA__: Codex独立探子 | 1 | 证据：`apps/control-center/src/ssh/remote-run.mjs:169` 发现 `|| true` 会伪造远程终止成功；同时补出旧 health 解锁 readiness 与路径字符串抬高 evidence rate，两者已分别在 `first-run-readiness.mjs:33`、`ops-metrics.mjs:106` 收口。
