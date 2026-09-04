<!-- 514cc-session-id: cf8dac53-77b0-4ebe-891a-d261f66f8439 -->
# Codex 评审：stream-json 许可通道可行性核实（推翻我上一轮的推荐方案）

- **评审模式**：deep-review（协议级二进制取证）
- **评审范围**：`apps/control-center/src/permission-prompt-wire.mjs`、`scripts/probe-stream-json-frames.mjs`、`scripts/probe-permission-frames.mjs`、`.evidence/stream-json-frames/*`、`claude.exe` v2.1.260
- **评审时间**：2026-09-04 20:00
- **Codex 模型**：gpt-5.6-sol (xhigh)
- **前置结论状态**：**我上一轮的推荐方案（改走 `--input-format stream-json` 双向控制帧）不可行。以下为反证。**

---

## 致命问题（必须改）

### F-1 【推翻我自己】裸 CLI 在 stream-json 下永远不会发 `can_use_tool` —— 这是二进制里一行代码的硬事实

许可宿主的判定函数只有一行，`claude.exe` 偏移 **187945707**：

```js
var YGn=["host","none"], Fft="none";
function xY(e){ return e==="none" }
function Uft({permissionPromptTool:e, sdkUrl:n}){ return n ? "stdio" : e }
```

调用点在偏移 **202771895**（print 路径主流程）：

```js
let tt = Uft({ permissionPromptTool: w.permissionPromptToolName, sdkUrl: w.sdkUrl });
let Kt = xY(w.permissionPrompts);
if (Kt) { ue.hostAnswersElicitations = false;
  if (tt !== undefined) t(`--permission-prompts none: ... the ${tt==="stdio"?"SDK host":"--permission-prompt-tool"} is not consulted`) }
```

**`tt` 的取值只有三种**：
| 条件 | `tt` | 含义 |
|---|---|---|
| `sdkUrl` 非空 | `"stdio"` | SDK 宿主（日志原文自称 "SDK host"）|
| `sdkUrl` 空 + `permissionPromptToolName` 非空 | 该工具名 | PPT 宿主 |
| **两者皆空** | **`undefined`** | **无宿主** |

裸 stream-json 子进程两者皆空 → `tt === undefined`。**`--input-format stream-json` 完全不参与这个判定**——它只决定入站消息编码格式，与"谁能应答许可"无关。这就是 LO 三轮实测 `controlRequests: 0` 的机械原因，不是探针 bug。

CLI 自己在事件 schema 的 describe 里把这件事写成了文档（偏移 **182473170**，`permission_denied` 事件说明原文）：

> "With a permission prompt surface (stdio/SDK canUseTool), the 'ask' path surfaces via a can_use_tool control_request and this event covers the 'deny' short-circuit. **Without one (bare -p / SDK query() with no canUseTool), 'ask' decisions are terminal**, so this event also covers those implicit denials."

**"bare -p ... 'ask' decisions are terminal"** —— 官方自己的措辞。ask 决策在无宿主时是**终态**（直接终结为拒绝），不会转成控制帧外发。

**结论：LO 的推断成立。我上一轮的推荐方案不可行，请废弃。** 我不为前后一致找补——那份 review 的理由 2/3（每 turn spawn、runId 归属、无需改 process-runner）依然成立且有价值，但它推出的**替代方案本身是错的**：我把"stream-json 是双向的"错当成了"stream-json 能承载许可宿主"。这两件事在二进制里由完全不同的变量决定。

---

### F-2 `--permission-prompts host` 是 no-op，LO 第三轮的"显式声明宿主"从未生效

`probe-stream-json-frames.mjs:82` 传 `--permission-prompts host`，注释写"显式声明宿主存在"。但看 `xY` 的实现：

```js
function xY(e){ return e==="none" }   // 只判 "none"
```

枚举 `YGn=["host","none"]`，默认值 `Fft="none"`。**`host` 分支不存在任何"声明"语义**——它唯一的作用是让 `Kt=false`，即"不要强制本地 deny"。`host` 是**默认放行态**，不是注册动作。

所以第三轮与前两轮**在许可通道上完全等价**，三轮实际只验证了同一件事。这不影响 F-1 的结论（结论方向一致），但要记入探针局限：**LO 以为自己试了两种配置，其实只试了一种。**

### F-3 `--sdk-url` 存在，但被主机名白名单锁死——Console 无法冒充 SDK 宿主

既然 `sdkUrl` 非空即得 `"stdio"` 宿主，自然的下一问是"能不能自己传 `--sdk-url`"。`--sdk-url` 确实是真实 CLI 旗标（偏移 181768410 的旗标清单里有）。但偏移 **181780400** 有守卫：

```js
Re = new Set(["api.anthropic.com","api-staging.anthropic.com", ...uie.map(e=>new URL(e).hostname)]);
function w(e){ let r=new URL(e);
  if (Re.has(r.hostname)) { if (r.protocol!=="wss:" && r.protocol!=="https:")
      return {code:"bad_scheme", ...} } ... }
function Bnr(e){ /* 与 eager argv scan 交叉校验，不一致 → code:"view_mismatch" */ }
```

三重锁：**主机名白名单**（Anthropic 官方域）＋ **scheme 限 wss/https**（本地 IPC 无法满足）＋ `Bnr` 的 **argv 双视图交叉校验**（防绕过）。且它配套要求 `remoteSessionId`（偏移 202499034 的 `dHt`/`fHt`：`if(!e.sdkUrl||!e.remoteSessionId...) return {admitted:false, reason:"not_managed_cloud_worker"}`）——这条线是**云端托管 worker** 通道，不是给本地宿主用的。

**`--sdk-url` 不是可用出路。别去试，会浪费一轮。**

### F-4 【回答 LO 问题1】SDK 宿主靠什么被识别：靠 `--sdk-url`，且 SDK 包自己也不用它走本地许可

LO 问"`canUseTool` 回调那条线到底靠什么被 CLI 识别"。答案在偏移 **200684400**（SDK 侧 argv 构造器）：

```js
let { ..., permissionPromptToolName:re, permissionPrompts:ne, ..., canUseTool:N, ... } = this.options;
let w = ["--output-format","stream-json","--verbose","--input-format","stream-json"];
...
if (N) { if (re) throw Error("canUseTool callback cannot be used with permissionPromptToolName. Please use one or the other."); ... }
```

关键点：**SDK 传 `canUseTool` 时会与 `permissionPromptToolName` 互斥报错** —— 证明这两者在 SDK 眼里是**同一个槽位的两种填法**，正对应 `Uft` 的两个分支。SDK 本地场景（无 `sdkUrl`）走的是**同一条控制协议**，但它是 SDK 运行时**自己在进程内**持有 transport 并注册宿主身份，不是靠往 argv 塞旗标。

**给 LO 的直接回答**：
1. **不是握手帧**——`Uft` 在会话启动早期（sandbox 初始化之前）就求值完毕，那时还没有任何入站帧。事后发帧无法追认宿主。
2. **不是环境变量**——遍历 `Uft` 的两个入参，都来自 argv 绑定（`w.permissionPromptToolName` / `w.sdkUrl`），无 env 兜底路径。
3. **是 `--sdk-url`（被白名单锁死）或 `--permission-prompt-tool`（只接受 MCP 工具名）**。对本地 Console 而言，**只有后者可用**。

**所以第二问「有没有办法让裸 CLI 子进程在 stream-json 下发出 `can_use_tool`」的答案是：没有。**（除 F-3 那条被三重锁死的云端通道外，无第三条路。）

---

## 建议改进（值得讨论）

### S-1 【回答 LO 问题2】nonce 方案能解决归属，但它解决的问题比 LO 以为的小

LO 提议往 MCP server argv 塞每轮随机 nonce。**技术上有效**，但先要把威胁模型摆正：

我上一轮说归属"只能靠沙箱自称"，这话在**没有 nonce**时对。加了 nonce 之后：
- Console spawn CLI 时生成 `nonce_A`，写进该轮 MCP server 的 argv
- MCP server 进程携 `nonce_A` 回连内核，内核查表得 `runId`
- **这确实是密码学意义上的能力凭证**，归属可判定

**但 LO 问的"泄露后果"更关键，我的答案是：后果比想象的小。**

`Win32_Process` 读 argv 需要与目标进程同用户或管理员。而攻击者拿到 `nonce_A` 之后要做什么？他得**连上内核的 IPC 才能用它**。而这里有个关键事实——**MCP server 是 CLI 拉起的 stdio 子进程，它与内核之间根本没有网络 IPC**：CLI 通过 stdin/stdout 管道与 MCP server 通信，MCP server 若要回报内核，需要 Console 额外提供一条通道。

**这就是真正该收的口**：如果那条回报通道是 **loopback HTTP/WS**，nonce 泄露 + 同机进程 = 可伪造审批应答，风险实在；如果是 **Console 在 spawn MCP server 时通过继承的 fd / 命名管道（Windows: `\\.\pipe\` 带随机名 + ACL 限当前用户）**，则连接本身就是能力，nonce 变成冗余的第二道锁。

**建议：不要把 nonce 当主凭证，把"连接通道本身"当主凭证，nonce 作纵深防御。** 同用户前提下 argv 可读是既定事实（`guardrails` 管不住同用户进程），所以别让任何**单一 argv 可读物**成为唯一凭证。

### S-2 【回答 LO 问题2 第三问】"每轮独立脚本文件 + 路径即凭证"比 nonce 更干净，但要守文件 ACL

LO 自己提的这个方案我认为**优于 nonce**：

- 每轮在该轮临时目录写一份 MCP server 脚本，**路径含随机段**
- 脚本内**硬编码**该轮 `runId`（不从 argv 读，从自身常量读）
- CLI 的 `--mcp-config` 指向它

优点：
1. **runId 不出现在任何进程的 argv 里**（`Win32_Process` 读不到）
2. 脚本文件可设 ACL 限当前用户（Windows `icacls`），比 argv 严格
3. `probe-permission-frames.mjs:63-131` **已经是这个形状**——它把 server 写成 `runDir/ppt-server.mjs` 并把 `framesPath`/`decision` 以 `JSON.stringify` 内联成常量。这不是新设计，是把已验证的探针形状产品化。

需要补的：
- 临时目录**必须**是当前用户专属（不要用 `%TEMP%` 共享位；已有 `.evidence/<stamp>/` 形状可复用）
- 轮次结束**删除脚本**（现探针不删，取证期无妨，产品化必须删）
- 脚本内联的不只是 `runId`，还应内联该轮**允许应答的 IPC 端点/管道名**，否则又回到 S-1 的问题

**这条路我推荐。它把"能力"从可读的 argv 移到可 ACL 的文件系统对象上。**

### S-3 探针 F-2 缺陷要修，否则将来复跑会得出错误的"已验证两档"结论

`probe-stream-json-frames.mjs:78-82` 的注释断言 `host` 是"显式声明宿主存在"，这是**误读**（见 F-2）。建议：
- 删掉 `--permission-prompts host`（它是默认值，传了等于没传）
- 注释改为记录 F-1 的机械事实（`Uft` 一行代码 + 偏移），而非推测
- `verdict` 增加一档：`NO_PERMISSION_HOST`（当 argv 里既无 `--permission-prompt-tool` 又无 `--sdk-url` 时，**在启动前就该判定为结构性不可能**，不必真跑 240s 超时）

现在三轮都是 `cliExitCode: null`（超时被 kill），**每轮白等 150-200 秒**去验证一件二进制里已注定的事。

### S-4 v1 安全闸的白名单**是真被消费的**，但有一个绕过口

LO 明确要求核实"声明了没人用"。**核实结果：这次没栽。**

消费链完整：
- `toolResultFor` (L207-209) → `assertV1Response` → `assertWireResponse` + `V1_FORBIDDEN_RESPONSE_FIELDS` 遍历 + `V1_ALLOWED_RESPONSE_FIELDS` 白名单遍历
- `allowResponse` (L118) / `denyResponse` (L135) 各自 `return assertV1Response(payload)`
- **两层白名单都真的被 `for...of Object.keys()` 遍历比对**（L154-162），不是装饰

手搓 payload 也过不去：`toolResultFor(手搓对象)` → L208 内部仍调 `assertV1Response`。**注释 L206-207 声称的"唯一出口"名副其实。**

**但有一个绕过口**：`toolResultFor` 是**唯一的封装出口**，却不是**唯一的物理出口**。调用方完全可以不用它，自己 `send({content:[{type:"text",text:JSON.stringify({behavior:"allow",updatedPermissions:[...]})}]})`——正如 `probe-permission-frames.mjs:121-125` 现在做的那样（探针直接手搓 `{behavior:"allow"}` 并自行 `JSON.stringify`，**完全绕过了 `permission-prompt-wire.mjs`**）。

探针如此无妨（取证代码），但产品化时若 MCP server 脚本也这样内联，**v1 闸就形同虚设**。建议：
- 产品化的 MCP server 脚本**必须** `import { toolResultFor } from ".../permission-prompt-wire.mjs"`，或将该模块内容内联进脚本
- 加一条测试：断言 MCP server 脚本源码中**不出现**裸 `behavior:` 字面量（机械承载"必须走闸"这个意图）

### S-5 v1 禁三字段外，还应禁 `decisionClassification` 的 `user_permanent`

LO 问"还有没有遗漏"。三个禁得对（`updatedInput`/`updatedPermissions`/`interrupt`，理由 L42-56 我确认成立）。但 `V1_ALLOWED_RESPONSE_FIELDS` 放行了 `decisionClassification`，而它的取值含 `user_permanent`。

L110-112 注释说它是"纯遥测归类，不改变 CLI 行为"——**这一半对**。偏移 188476400 处 `tjo()` 确认它被读取用于归类：

```js
case"permissionPromptTool":{ let o=e.toolResult?.decisionClassification;
  if(o==="user_temporary"||o==="user_permanent"||o==="user_reject") return o; ... }
```

确实只回流到决策原因归类（供上层展示/日志），**当前版本不驱动持久化**。但报 `user_permanent` 意味着告诉 CLI"操作者选了永久允许"，而 v1 **禁了 `updatedPermissions` 所以根本不会持久化**——这是一次**如实性失配**：账本会显示"永久允许"，实际下一轮还会再问。

**建议**：v1 只允许 `user_temporary` / `user_reject`，禁 `user_permanent`。理由与 L112 的自述一致（"不承诺任何持久化效果"），但当前代码没有把这个承诺机械化。加断言即可，一行。

---

## 可保留（看似奇怪但合理）

1. **`WIRE_RESPONSE_FIELDS` 与 `V1_ALLOWED_RESPONSE_FIELDS` 两张表刻意分开**（L26-35 注释）—— 一张记协议事实、一张记本控制面许可范围。这是正确的分层，放宽 v1 时不会污染协议记录。保留。

2. **`toolUseID` 与请求侧 `tool_use_id` 大小写反转**（L25、L116）—— 看着像 bug，是协议真相。注释已标明取证偏移。保留。

3. **`parsePermissionRequest` 显式排除数组**（L89-91）—— `typeof [] === "object"` 会让审批卡渲染 `[0]/[1]` 当参数名。这是真实防御，不是过度设计。保留。

4. **`denyResponse` 对空 message 兜默认值而非抛错**（L131）—— 空 message 会让 CLI 静默 deny，模型看不到原因盲目重试。兜底比抛错更符合"拒绝要能传达"。保留。

5. **`probe-permission-frames.mjs` 的 `INCONCLUSIVE` / `TOOL_RAN_WITHOUT_PROMPT` 分级判读**（L207-226）—— 严格区分"通道不工作"与"这次没跑到那一步"。这正是让 LO 这次没把自己的 bug 当协议事实的原因。**这套判读纪律是本轮最有价值的既有资产，务必保留并推广到新探针。**

---

## 总评

### **stream-json 方案：不可行。我上一轮的推荐是错的。**

不是"未实证"、不是"格式待摸索"——是**二进制里一行代码判定的结构性不可能**：

```js
function Uft({permissionPromptTool:e, sdkUrl:n}){ return n ? "stdio" : e }   // 偏移 187945707
```

`--input-format stream-json` 不在这个判定的任何入参里。裸 CLI 子进程两者皆空 → 无许可宿主 → CLI 官方 schema 自述 "**bare -p ... 'ask' decisions are terminal**"（偏移 182473170）。LO 的三轮实测 `controlRequests: 0` 与二进制事实一致。

**LO 的探针没写错。** 唯一缺陷是 F-2（`--permission-prompts host` 是 no-op，导致三轮实际只试了一种配置），但该缺陷**不改变结论方向**——三轮都朝同一个正确结论。LO 要求"别让我拿自己的 bug 当协议事实"，我核实后的回答是：**这次不是 bug，是真事实。**

**LO 的推断也精确对**：`--permission-prompt-tool` 起的正是"向 CLI 声明存在一个能应答许可的宿主"的作用；没有它 CLI 判定无人能应答。唯一需要修正的细节是"于是把需要审批的工具整个摘掉"——ExitPlanMode 从 `init.tools` 消失（27 个工具无它，plan 档）是**同一根因的下游表现**，而非独立机制：plan 档下 ExitPlanMode 的语义就是"请求人类批准计划"，无宿主时该工具无意义故不注册。

### 请回到 stdio MCP + PPT，按 S-2 解归属

归属问题**有解**，且比我上一轮说的乐观：
- **推荐 S-2**（每轮独立脚本文件，runId 内联为脚本常量，路径含随机段 + ACL）——不是新设计，`probe-permission-frames.mjs:63-131` 已是这个形状，产品化即可
- **不推荐把 nonce 当唯一主凭证**（S-1）——同用户 argv 可读是既定事实，凭证应落在可 ACL 的文件系统对象上，而非可读的 argv 上
- 补三件事：脚本轮末删除、临时目录用户专属、内联 IPC 端点标识

### v1 安全闸：**守住了**，两处补强

LO 特别问"是不是又栽在声明了没人用"——**这次没栽**。`V1_ALLOWED_RESPONSE_FIELDS` / `V1_FORBIDDEN_RESPONSE_FIELDS` 都真被 `for...of` 遍历消费（L146-162），`toolResultFor` 内部强制过闸（L208），手搓 payload 绕不过构造函数。三个禁字段的理由（改写执行内容 / 持久化提权 / 掐会话）我逐条核实成立。

两处补强：
- **S-4**：`toolResultFor` 是唯一封装出口但非唯一物理出口——产品化 MCP server 脚本若像探针那样自行 `JSON.stringify` 手搓帧，闸门被完整绕过。需机械承载"必须走闸"。
- **S-5**：`decisionClassification` 应禁 `user_permanent`——v1 禁了 `updatedPermissions` 所以不会真持久化，上报"永久允许"是如实性失配。

### 元教训

我上一轮把"stream-json 是双向通道"推成了"stream-json 能承载许可宿主"。这两件事在二进制里由**完全不同的变量**决定，而我在**明确标注"帧格式未实证"的同时**，仍然把基于它的方案作为推荐给了出去。**标注了不确定性 ≠ 免除了推荐责任**——一个未实证的机制不该进推荐位。LO 这次坚持先取证再改代码，挡住了一次会白烧一整轮实现工的错误方向。

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 2 | 证据：claude.exe@187945707 `function Uft({permissionPromptTool:e,sdkUrl:n}){return n?"stdio":e}` 推翻我上一轮 handoff 推荐的 stream-json 方案（该函数不含 input-format，裸子进程无许可宿主，官方 schema@182473170 自述 "bare -p ... 'ask' decisions are terminal"）；同时推翻主驾对 `--permission-prompts host` 的理解（`xY(e){return e==="none"}` host 分支为 no-op，三轮实测实际只试了一种配置）
