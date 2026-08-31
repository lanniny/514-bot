## 致命问题

1. **`child-registry` 的 PID 复用防护不足，确实可能误杀无辜进程。** 台账只保存 `pid + basename(image)`，重启后仅比较镜像名；旧 `node.exe` 退出、同 PID 被另一个 `node.exe` 占用时，`liveImage === entry.image`，仍会执行整棵 `/T /F` 杀树。镜像名不是进程身份认证；`entry.image` 为空时还会无条件杀活 PID。证据：[child-registry.mjs:28-30](I:/514claude/514cc/apps/control-center/src/child-registry.mjs:28)、[child-registry.mjs:63-74](I:/514claude/514cc/apps/control-center/src/child-registry.mjs:63)、[process-runner.mjs:68-73](I:/514claude/514cc/apps/control-center/src/process-runner.mjs:68)。

2. **台账残留会把上述 PID 复用风险放大到后续每次重启。** `reapPrevious()` 收割后不清空或原子替换 `children.json`；正常关闭时 `unregister()` 只是 fire-and-forget，`createControlCenter().close()` 也没有等待 child registry 写链。旧 PID 会长期留在台账中，直到下一次受管 spawn 恰好覆盖文件。证据：[child-registry.mjs:34-50](I:/514claude/514cc/apps/control-center/src/child-registry.mjs:34)、[child-registry.mjs:53-76](I:/514claude/514cc/apps/control-center/src/child-registry.mjs:53)、[app.mjs:188-197](I:/514claude/514cc/apps/control-center/src/app.mjs:188)。

3. **bus API 存在路径穿越，可读取 `dataRoot` 外任意 `.jsonl`。** `runId` 未校验即拼接进路径，API 又先 `decodeURIComponent` 后直接调用 `bus.read()`；例如 `../events` 会解析到 `dataRoot/events.jsonl`。同时该端点不确认 run 存在，清除后的旧 bus 仍可被读取。证据：[bus.mjs:56-57](I:/514claude/514cc/apps/control-center/src/bus.mjs:56)、[server.mjs:362-365](I:/514claude/514cc/apps/control-center/server.mjs:362)。我用纯路径探针确认：`../events` → `C:\cc\data\events.jsonl`。

4. **“写入即脱敏”只覆盖 bus 的 `text`，其他持久化路径仍可泄漏低熵秘密。** 当前正则对 JSON 形式的 `"token":"shortsecret"` 不匹配，对 `Authorization: Bearer shortsecret` 只遮掉 `Bearer`，真实值保留；`refs` 也完全未脱敏。更严重的是 agent 原文先写入 `run.turns[].text`，`save()` 使用的 `sanitizeForPersistence()` 只做高熵正则和键名处理，不做 assignment scrub；`bus.routed` 事件同样把原文直接交给 EventStore。证据：[bus.mjs:11-18](I:/514claude/514cc/apps/control-center/src/bus.mjs:11)、[bus.mjs:61-70](I:/514claude/514cc/apps/control-center/src/bus.mjs:61)、[orchestrator.mjs:551-566](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:551)、[orchestrator.mjs:779-781](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:779)、[redaction.mjs:20-36](I:/514claude/514cc/apps/control-center/src/redaction.mjs:20)。

5. **`[[msg:lo]]` 可能进入不可恢复的 `waiting_agent`。** socialLoop 在收到 ask 后仍继续消费队列，直到 `run.round` 达到上限才检查 `pendingAsk`。当 `run.round === policy.limits.maxRounds` 时，`continue()` 在 ask 恢复分支之前直接抛 `ROUND_LIMIT`，无法提交回答，run 永久停在等待态。证据：[orchestrator.mjs:779-805](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:779)、[orchestrator.mjs:936-955](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:936)。现有测试只覆盖首轮立即 ask，未覆盖“ask 后继续路由至封顶”： [social-orchestration.test.mjs:194-223](I:/514claude/514cc/apps/control-center/tests/social-orchestration.test.mjs:194)。

6. **ask/answer 恢复存在并发与关闭竞态。** 恢复分支先清空 `pendingAsk`，再经过三次 `await`，最后才 `startExecution()`；这段时间没有登记 `controllers`/`executions`。两个回答请求可一条清空 ask、另一条进入普通续聊；控制面也可能在 `close()` 快照 active executions 后释放 adapter，随后恢复分支才启动新执行。证据：[orchestrator.mjs:945-955](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:945)、[orchestrator.mjs:1063-1080](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:1063)。

7. **worktree 隔离对真实 Codex app-server 不成立，却仍授予 `workspace-write`。** `ensureRunWorktree()` 把 worktree 路径传入 `turn()`，但 Codex adapter 的 `send()` 不接收 `cwd`，新线程始终使用 adapter 初始化时的 `this.cwd`；`createAdapters()` 又把控制面 `repoRoot` 固化给它。因此写盘轮会在控制面仓库写入，而不是隔离 worktree。现有测试使用 mock，只验证收到的 `cwd`，没有跑真实 adapter。证据：[orchestrator.mjs:702-718](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:702)、[orchestrator.mjs:766-767](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:766)、[codex-app-server.mjs:184-217](I:/514claude/514cc/apps/control-center/src/adapters/codex-app-server.mjs:184)、[adapters/index.mjs:26-31](I:/514claude/514cc/apps/control-center/src/adapters/index.mjs:26)、[social-orchestration.test.mjs:271-295](I:/514claude/514cc/apps/control-center/tests/social-orchestration.test.mjs:271)。

8. **worktree 可被完全绕过。** 服务端允许 build run 不提供 `cwd`，此时 `ensureRunWorktree()` 直接返回 `null`，写盘轮回退到 adapter 默认目录；显式 `orchestrationMode:"pipeline"` 也不调用 worktree。证据：[orchestrator.mjs:248-266](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:248)、[orchestrator.mjs:704-707](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:704)、[orchestrator.mjs:732-767](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:732)。

9. **预算上限不是全 agent 生效的硬闸。** Orchestrator 只把 `maxBudgetUsd` 作为参数传下去；目前只有 Claude adapter 将其转成 `--max-budget-usd`，Codex、Grok、Kimi、Pi 的 `send()` 都不接收或不执行该限制。socialLoop 可把轮次派给这些 agent，单轮成本没有服务端回执校验，也没有 run 级累计预算。证据：[orchestrator.mjs:490-500](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:490)、[claude-cli.mjs:16-42](I:/514claude/514cc/apps/control-center/src/adapters/claude-cli.mjs:16)、[codex-app-server.mjs:206-217](I:/514claude/514cc/apps/control-center/src/adapters/codex-app-server.mjs:206)、[grok-build.mjs:31-38](I:/514claude/514cc/apps/control-center/src/adapters/grok-build.mjs:31)。

10. **清除完成任务没有清理 bus、worktree 或 roster。** `clearFinished()` 只删除 `runs/<id>.json`；bus API 不检查 run 是否仍存在，所以“已清除”的会话消息继续可读；worktree 也没有任何 `git worktree remove/prune` 路径。证据：[orchestrator.mjs:195-204](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:195)、[server.mjs:362-365](I:/514claude/514cc/apps/control-center/server.mjs:362)、[orchestrator.mjs:815-817](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:815)。

## 建议改进

1. **重做子进程身份模型。** Windows 优先使用 Job Object 或进程句柄/创建时间校验；至少记录完整可执行路径、命令行摘要、创建时间和实例 nonce，收割前 fail-closed，不能以 basename 相等作为授权。收割成功后原子写入空台账，并等待写链；`taskkill` 必须检查退出码。另有多处直接 `spawn()` 未进入台账，当前“全系统唯一出口”声明不成立：`server.mjs:255`、`server.mjs:271`、`server.mjs:570`、`src/observability.mjs:180`、`src/validator.mjs:25`。

2. **让锁与台账绑定同一命名空间。** 当前实例锁按 `repoRoot`，子进程台账按 `dataRoot`；自定义 `repoRoot/dataRoot` 组合时可出现不同锁共享一份台账。锁文件应携带并校验 data-root nonce，或统一以 dataRoot 作为实例域。现有锁测试只覆盖单路径串行场景：[approval-lock.test.mjs:62-70](I:/514claude/514cc/apps/control-center/tests/approval-lock.test.mjs:62)。

3. **bus 使用结构化安全入口。** `runId` 只接受服务端生成 UUID，并在 API 先 `orchestrator.get()`；`refs`、from/to/kind 全部做 schema 校验；所有事件、run 快照、bus、roster 共用同一个递归 scrub，避免各自维护正则。对 directive 数量、队列长度和总路由字符数加上限。

4. **ask 必须成为硬状态转换。** 收到第一个 `[[msg:lo]]` 立即停止取队列；把 ask 持久化并注册 per-run mutex；回答分支先原子占用 continuation，再开始任何 await；取消时清除 pendingAsk/resumeQueue 并拒绝后续恢复。若已到策略轮上限，应预留回答轮，不能靠 `continue()` 越过上限。

5. **worktree 需 fail-closed。** build 必须要求绝对 `cwd` 且先验证 git；Codex app-server 若不能动态设置 cwd，就禁止其获得 workspace-write，改用支持 cwd 的 spawn adapter 或直接拒绝；路径使用随机后缀而非秒级时间戳；创建成功但 save 失败时要回滚 worktree；清除/显式结束时提供安全回收动作。`INVALID_CWD`、`INVALID_MODEL`、`INVALID_EFFORT`、`NOT_TEAM_MEMBER` 也应加入 server 的 422 映射（[server.mjs:84-92](I:/514claude/514cc/apps/control-center/server.mjs:84)）。

6. **补充真实边界测试。** 至少覆盖：同镜像 PID 复用、空镜像、收割后重复重启、`.ps1` 实际镜像、bus `../events`、JSON/Authorization 脱敏、ask 后队列封顶、双提交 answer、关闭期间 answer、真实 Codex worktree、clearFinished 后 bus/worktree/roster 清理。

7. **修正生命周期辅助资产。** 清除 run 时同步处理 bus 和 worktree；roster 在终态写回 offline/finished 或删除；`BusStore.chains` 在链完成且 run 清除后移除；`#mergeCodexProjects()` 在删除 `_ms` 后再读取，当前 `latestMs` 会退化为 0（[sessions.mjs:423-439](I:/514claude/514cc/apps/control-center/src/sessions.mjs:423)）。

## 可保留

1. **run 写盘链与墓碑设计方向正确。** 同 tick 快照、per-run 串行写盘、清除前等待链、墓碑阻止迟到写盘复活，能够覆盖既有 save/clearFinished 竞态。证据：[orchestrator.mjs:129-153](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:129)、[orchestrator.mjs:176-203](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:176)。

2. **Bus 快照的收件人过滤和字符预算是合理基础。** “发给我/我发出/广播/治理消息”按消息粒度裁剪，避免把整条总线无界注入单个 agent。证据：[bus.mjs:101-119](I:/514claude/514cc/apps/control-center/src/bus.mjs:101)。

3. **socialLoop 确实有两层轮次闸门。** `run.maxRounds` 加 `guardLimit` 能阻断纯队列型无限循环；乒乓丢弃也会落 system 证据。问题在于 ask、budget 和 fan-out 没有与这两层闸门形成完整状态机。证据：[orchestrator.mjs:747-752](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:747)、[orchestrator.mjs:789-797](I:/514claude/514cc/apps/control-center/src/orchestrator.mjs:789)。

4. **动态模型发现的缓存、失败回退和热重载清缓存思路可保留。** 发现、静态回退、5 分钟缓存的分层清楚；需要补充失败原因和并发去重。证据：[model-discovery.mjs:63-106](I:/514claude/514cc/apps/control-center/src/model-discovery.mjs:63)。

5. **命令启动保持 `shell:false`，并且 taskkill 使用 `/T`，降低了 shell 注入和孙进程残留风险。** 但这不能替代可靠的进程身份校验。证据：[process-runner.mjs:68-73](I:/514claude/514cc/apps/control-center/src/process-runner.mjs:68)、[child-registry.mjs:102-112](I:/514claude/514cc/apps/control-center/src/child-registry.mjs:102)。

## 总评

结论：**CHANGES_REQUESTED，当前不应批准 v3.6 进入可用/生产状态。**

这批改动的核心拓扑和测试 happy-path 是成形的，但独立复查发现的不是边角问题，而是三条安全承诺失效：子进程收割可能误杀同镜像无辜 PID；bus 的路径与脱敏边界可泄漏控制面数据；build worktree 对真实 Codex 写盘轮并未隔离。socialLoop 的 maxRounds 能阻止普通 ping-pong，却没有覆盖 ask 到轮顶、并发回答和非 Claude 预算，因此“不会永久卡死/不会烧穿预算”的声明不能成立。

我未运行 `npm test`：当前工作区权限是只读，且该测试套件会创建/删除临时目录；已完成 `node --check` 全部改动源文件、`git diff --check`，并用纯函数/路径探针实证了脱敏绕过和 `../events` 逃逸。评审过程做了额外反向复查；工作区未被修改，也未写 handoff 文件。

__VERDICT__: CHANGES_REQUESTED  
__DELTA__: 烛(Codex) | 2 | observability | 证据：child-registry 同镜像 PID 复用、真实 Codex cwd 未接收、bus API 路径穿越（见上述 file:line）




---

# 主驾修复回执（2026-07-20 13:55，Cursor 主驾）

烛 10 条致命全部处置，139/139 测试绿 + qa:ui all ok:true 0 错误：

1. 致命1 pid 复用 → 双判据 fail-closed（镜像名一致 + 创建时间早于登记时间，PowerShell Get-Process 取 StartTime；空镜像/探针超时=不可认证即跳过）。
2. 致命2 台账残留 → reapPrevious 收割后原子清账；close() 补 childReg.flush() 等写链。
3. 致命3 路径穿越 → bus runId 白名单只收 UUID（file() 单点 fail-closed，read 的校验在 catch 外显式拒绝）；API 先 orchestrator.get() 确认 run 存在（清除后 404）。
4. 致命4 脱敏盲区 → 双层 scrub 收敛 redaction.mjs 单一信源（补 JSON 引号键、Bearer/Basic 短值整段吞）；sanitizeForPersistence 字符串走全量 scrub（run.turns/事件持久化同步收口）；bus refs 过 sanitizeForPersistence。
5. 致命5 ask 轮顶死锁 → ask=硬状态转换（askRaised 立即 break 停派）；连回答轮都腾不出时不挂起改截断收敛；continue 的 answer 分支移到 ROUND_LIMIT 之前。
6. 致命6 恢复竞态 → resumePendingAsk 同 tick 原子占位（清 pendingAsk+占位 controller 在首个 await 前）；执行尾窗滞留的 steer 即回答（execute 内循环消费，实测根因：turn 进行中提交的 answer 曾进 pendingSteer 永久滞留）。
7. 致命7 worktree 假隔离 → adapter 声明 supportsPerTurnCwd；有 worktree 的写盘轮派给常驻型（codex app-server）即抛 UNSUPPORTED_PERMISSION，绝不静默写错目录。
8. 致命8 worktree 绕过 → ensureRunWorktree 上收 execute() 入口（social/pipeline 同闸）；无 cwd 的 build 落 run.worktree_skipped 审计事件（静默变可见；是否强制 cwd 留 LO 拍板产品语义）。
9. 致命9 预算 → run 级累计成本闸（budgetExhausted：单轮预算×轮上限；socialLoop 停派+system 证据+run.budget_exhausted 事件）；无成本回执的 CLI 如实注明测不到，轮次闸兜底。
10. 致命10 资产泄漏 → clearFinished 一并回收 bus 文件（BusStore.remove 含写链收敛）/git worktree（存 worktreeBase，remove --force 失败退 prune）/roster 条目；worktree 建后 save 失败即回滚。

另主驾自查修复（烛未涉及）：deleteProjectSessions 跨盘 rename 必 EXDEV（C:\Users 会话→I:\ trash，本机探针实证）→ cp+rm 回退；.ps1 台账镜像名登记错（登记脚本名而实际活进程是 powershell.exe，reap 永不匹配）→ 改登记实际 spawn 镜像；validator/observability 的裸 spawn 收进 spawnCommand 台账出口。

新增 9 条边界测试：路径穿越×5 形态 / JSON+Bearer 脱敏 / 轮顶 ask 可恢复 / 双 answer 不并发 / 预算停派 / bus+roster+worktree 随 clear 回收 / 常驻适配器写盘 fail-closed / pid 复用四场景（异镜像/时间倒挂/空镜像/正常收割）。

__DELTA__: 烛(Codex) | 2 | observability | 证据：child-registry.mjs 同镜像 PID 复用误杀、orchestrator.mjs ensureRunWorktree 对 codex app-server 假隔离、server.mjs bus API ../events 路径穿越实证——主驾此前按 kimi 自测 132/132 视为可收，被烛推翻
