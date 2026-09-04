<!-- 514cc-session-id: cf8dac53-77b0-4ebe-891a-d261f66f8439 -->
# 织·情报：Claude Code `--permission-prompt-tool` MCP 协议

- **资料范围**：官方文档（code.claude.com）+ GitHub issues #24595/#1175 + 第三方逆向仓库 + **本机 `claude.exe` v2.1.260 二进制取证**
- **收集时间**：2026-09-04 18:30
- **方法诚实声明**：本轮 **grok-4.5 API 未调用**。证据全部来自 (a) web MCP (exa) 检索官方文档、(b) 本机安装的 CLI 二进制反混淆切片。不需要模型推理增量——所有关键结论都是一手可验证源码。按 §二.3，如实标注，不伪装 grok 产出。
- **一手证据文件**：`C:\Dprogress\nodejs\node_global\node_modules\@anthropic-ai\claude-code\bin\claude.exe`（217,771,680 字节，v2.1.260，Bun 单文件打包，JS 源码以明文驻留可 grep）

---

## 结论摘要（先给答案）

**LO 的六个问题全部确证，且不是靠文档转述——是从你本机跑的那个 exe 里挖出的实现源码。** 官方文档确实**从未**记录这个协议（issue #24595 提出"零文档"，被 stale 自动关闭）。但二进制里有完整的 zod schema 声明 + 调用点 + 解析器。

一句话协议：CLI 发 `{tool_name, input, tool_use_id}`（**snake_case**），你必须回 **单个 text block**、内含 JSON 字符串、形如 `{behavior:"allow", updatedInput?}` 或 `{behavior:"deny", message}`。

**最容易踩的坑**：请求是 snake_case（`tool_use_id`），响应里的同名回传字段却是 camelCase 大写 ID（`toolUseID`）。

---

## 事实清单

### F1 — 输入 schema：`{tool_name, input, tool_use_id}`（确证 · 一手源码）

**证据 A（调用点，最硬）**——`of()` 工厂函数内实际构造的载荷：

```js
te=e.call({tool_name:d.name,input:X,tool_use_id:D},T,o,E)
```

出处：`claude.exe` 字节偏移 ~202939000 区段（函数 `of`）。取证命令可复现：
`grep -a -b -o -F "isPromptToolServerSwept" claude.exe` → 202939342，再 `dd bs=1 skip=202939000 count=4200`

**证据 B（schema 声明，带官方 describe 文案）**——同 chunk 内 zod 声明，**原样贴出**：

```js
var Ge=m(()=>c({
  tool_name:s().describe("The name of the tool requesting permission"),
  input:me(s(),ie()).describe("The input for the tool"),
  tool_use_id:s().optional().describe("The unique tool use request ID")
}))
```

出处：`claude.exe` 偏移 202454550–202455800 区段。（`c`=z.object, `s`=z.string, `me(s(),ie())`=z.record(string, unknown), `R`=z.literal, `$e`=z.union, `T`=z.array, `X`=z.enum, `D`=z.boolean）

**逐条回答 LO 的追问**：
- 是 `{tool_name, input}` —— **不是** `{toolName, toolInput}`。三个字段全 snake_case。
- **有** `tool_use_id`（形如 `toolu_01JAE3A281mzVnjgfbCFthrC`）。schema 标 `.optional()`，但调用点无条件传。
- **没有**会话标识（无 session_id / cwd）。issue #1175 里有人明确抱怨过这点："MCP can be defined in the `user` scope, so it doesn't even have enough information about what directory `claude` is requesting permission in"。
- **没有** suggestions —— 权限建议（`PermissionUpdate[]`）只在 SDK `canUseTool` 第三参数里给，MCP 线路**不下发**。你只能反向回传 `updatedPermissions`（见 F3）。

第三方独立实测（2025-12-26，v2.0.76）三字段完全一致，含实测日志：
出处 https://github.com/UnknownJoe796/claude-code-mcp-permission

### F2 — 返回格式：单 text block 内嵌 JSON，再 zod 校验（确证 · 一手源码）

**解析器原样贴出**（`of()` 函数体，紧接调用点之后）：

```js
let H=le,ue=e.mapToolResultToToolResultBlockParam(H.data,"1");
if(!ue.content||!Array.isArray(ue.content)||!ue.content[0]||ue.content[0].type!=="text"||typeof ue.content[0].text!=="string")
  throw Error('Permission prompt tool returned an invalid result. Expected a single text block param with type="text" and a string text value.');
let xe=Uhe().safeParse(Ht(ue.content[0].text));
if(!xe.success)return t(`Permission prompt tool returned a schema-invalid result for ${d.name}: ${xe.error.message.slice(0,2000)}`,{level:"error"}),
  {behavior:"deny",message:`The permission prompt tool returned an invalid permission result. ${pHt}`,decisionReason:yZe};
```

**逐条回答**：
- **必须**包在 `content:[{type:"text", text:"<JSON 字符串>"}]` 里，然后 CLI 自己 JSON.parse（`Ht`）+ zod 校验。**不是**结构化直返。
- **必须恰好是单个 text block**：代码只读 `content[0]`，且硬校验 `type==="text"` 且 `text` 是 string，否则直接 **throw**（不是 deny，是抛错）。
- 字段名是 **`behavior`**，值 `"allow"` / `"deny"` —— 不是 `decision`。
- **schema 不合法 → 静默 deny**（不是抛错），并写 error 级日志。这是最难排查的失败模式：你的 server 明明返回了，但拼错一个字段就变成拒绝。

**官方给 LO 的错误提示原文**（二进制内字符串常量 `pHt`）：

```js
pHt="Expected {behavior: 'allow', updatedInput?: object} or {behavior: 'deny', message: string}."
```

### F3 — 两个响应 schema 的完整定义（确证 · 一手源码，原样贴出）

```js
var te=m(()=>X(["user_temporary","user_permanent","user_reject"]).optional().catch(void 0)),

fe=m(()=>c({
  behavior:R("allow"),
  updatedInput:me(s(),ie()).optional(),
  updatedPermissions:T(pL()).optional().catch((n)=>{
    t(`Malformed updatedPermissions from SDK host ignored: ${n.error.issues[0]?.message??"unknown"}`,{level:"warn"});
    return}),
  toolUseID:s().optional(),
  decisionClassification:te()
})),

ge=m(()=>c({
  behavior:R("deny"),
  message:s(),
  interrupt:D().optional(),
  toolUseID:s().optional(),
  decisionClassification:te()
})),

Uhe=m(()=>$e([fe(),ge()]))
```

出处：`claude.exe` 偏移 202454550–202456230 区段。

**读出来的硬事实**：

| 字段 | 归属 | 类型 | 说明 |
|---|---|---|---|
| `behavior` | 两者 | `"allow"` \| `"deny"` | 必填，判别式 |
| `message` | deny | string | **deny 时必填**，缺了就 schema 失败→静默 deny |
| `updatedInput` | allow | record | 可选，改写工具入参 |
| `updatedPermissions` | allow | array | 可选，持久化"总是允许"规则（**文档未记录此线路支持**） |
| `interrupt` | deny | boolean | 可选，**deny 同时中断整个会话**（文档未记录） |
| `toolUseID` | 两者 | string | 可选。**注意大小写：请求是 `tool_use_id`，响应是 `toolUseID`** |
| `decisionClassification` | 两者 | enum | 可选，`user_temporary`/`user_permanent`/`user_reject`（文档未记录） |

**`updatedInput` 省略是安全的**（v2.1.260）——后处理器 `mHt` 原样：

```js
let g=n.updatedInput&&Object.keys(n.updatedInput).length>0?n.updatedInput:qG(l.name,r);
return{...n,updatedInput:g,decisionReason:p}
```

省略或传空对象 `{}` → 回落到原始入参 `r`（经 `qG` 归一化）。对照官方文档：v2.1.207 之前省略 `updatedInput` 会被判定失败并拒绝。**你的 2.1.260 已过该门槛，可以省。**

**deny + interrupt 的实际后果**（`mHt` 内）：

```js
else if(n.behavior==="deny"&&n.interrupt)
  t(`SDK permission prompt deny+interrupt: tool=${e.name} message=${n.message}`),
  e7(o.abortController).abort();
```

- **拒绝原因怎么给模型看**：就是 `message` 字段。官方文档明确："When denying, provide a message explaining why. Claude sees this message and may adjust its approach."
  出处 https://code.claude.com/docs/en/agent-sdk/user-input

### F4 — `canUseTool` 与 `--permission-prompt-tool`：同语义，不同线路（确证）

**是同一套决策语义，但不是同一条 wire。** 二进制内的错误文案把三者并列，是最直接的证据：

```
The permission handler returned updatedInput for <tool> that failed schema validation:
This is a configuration issue in your canUseTool callback, PermissionRequest hook, or permission-prompt tool
```
出处：`claude.exe` 偏移 ~100962300 区段。

三者共用同一个 `PermissionResult` union（`Uhe`）、同一个后处理器 `mHt`、同一个 `decisionReason.type:"permissionPromptTool"` 记账。**差异只在参数命名风格**：

| | SDK `canUseTool` | MCP `--permission-prompt-tool` |
|---|---|---|
| 入参 | `(toolName, input, {signal, suggestions})` 位置参数 | `{tool_name, input, tool_use_id}` 单对象 |
| 出参 | 直接 return 对象 | JSON 字符串塞进 text block |
| suggestions | **有** | **无** |
| 取消信号 | `AbortSignal` 显式传入 | 隐式（CLI 侧 race abort） |

**SDK `canUseTool` 完整类型签名**（官方文档，TypeScript）：

```typescript
canUseTool: async (toolName, input, { suggestions = [] }) => {
  // 返回二者之一：
  // { behavior: "allow", updatedInput, updatedPermissions? }
  // { behavior: "deny", message }
}
```

Python 侧：
```python
async def can_use_tool(
    tool_name: str, input_data: dict, context: ToolPermissionContext
) -> PermissionResultAllow | PermissionResultDeny:
    ...
    return PermissionResultAllow(updated_input=input_data)
    # 或 return PermissionResultDeny(message="User denied this action")
```

出处 https://code.claude.com/docs/en/agent-sdk/user-input
官方 Python 示例 https://github.com/anthropics/claude-agent-sdk-python/blob/main/examples/tool_permission_callback.py

> **注意**：官方 TS 文档页 `agent-sdk/typescript` 的 `CanUseTool` 类型条目在我抓取时被页面截断，未取到 `type CanUseTool = ...` 的**逐字**声明。上面的签名来自 user-input 文档页的表格 + 代码示例（官方），**不是**逐字类型定义。若 LO 需要逐字签名，可 `npm i @anthropic-ai/claude-agent-sdk` 后读 `sdk.d.ts`——第三方文章报告该文件含 `CanUseTool`/`PermissionResult`/`PermissionMode` 的判别联合定义（v0.3.150 实测）：https://nerdleveltech.com/human-in-the-loop-claude-agent-sdk-typescript-tutorial

### F5 — 公开参考实现（确证）

| 仓库 | 说明 |
|---|---|
| **UnknownJoe796/claude-code-mcp-permission** | **最完整**。专门逆向文档化此 flag，含三字段输入表、响应格式、可跑 server.mjs、实测日志、4 种模式（日志/白名单/路径限制/外部轮询）。v2.0.76 实测。https://github.com/UnknownJoe796/claude-code-mcp-permission |
| mmarcen/test_permission-prompt-tool | issue #1175 里被引为"首个能跑的例子"。https://github.com/mmarcen/test_permission-prompt-tool |
| adstastic/claude-code-whatsapp-approval | WhatsApp/Twilio 远程审批。含关键实测警告："Non-interactive mode (without `-p`) does not use the `--permission-prompt-tool`"。https://github.com/adstastic/claude-code-whatsapp-approval |
| semenovsd/mcp-claude-code | 用 `--permission-prompt-tool mcp__perm__approve` + MCP Elicitation 转 IDE 原生弹窗。https://github.com/semenovsd/mcp-claude-code |
| vaddisrinivas/mcp-extras | FastMCP 审批中间件 + Claude Code channel SDK（含 permission relay）。https://github.com/vaddisrinivas/mcp-approval-proxy |
| CLIAI/mcp_permission_server_claude_code | issue #1175 提到的**失败/半成品**尝试，勿作范本。 |

**最小可跑 server（来自 UnknownJoe796，原样）**：

```javascript
server.tool(
  "permission_prompt",
  "Handle permission requests from Claude CLI",
  { tool_use_id: z.string(), tool_name: z.string(), input: z.any() },
  async ({ tool_use_id, tool_name, input }) => {
    const approved = true;
    if (approved) {
      return { content: [{ type: "text",
        text: JSON.stringify({ behavior: "allow", updatedInput: input }) }] };
    } else {
      return { content: [{ type: "text",
        text: JSON.stringify({ behavior: "deny", message: "Not approved" }) }] };
    }
  }
);
```

调用方式：
```bash
claude -p "task" \
  --mcp-config '{"mcpServers":{"permtest":{"command":"node","args":["server.mjs"]}}}' \
  --permission-prompt-tool mcp__permtest__permission_prompt \
  --output-format stream-json --verbose
```

### F6 — `--permission-prompts` 的 `host` / `none`（确证 · 本机 help 原文）

本机 `claude --help` 逐字输出：

```
--permission-prompts <target>   Who answers permission prompts with
                                --print: "host" (the SDK host or
                                --permission-prompt-tool) or "none"
                                (nobody: anything that would prompt is
                                denied automatically; the permission
                                mode still decides everything else)
                                (choices: "host", "none", default: "host")
```

**"host" 指什么**：明确指 **SDK 宿主进程 或 `--permission-prompt-tool` 指定的 MCP 工具**——二者是同一个"应答方"槽位的两种实现。所以 `--permission-prompts host` + `--permission-prompt-tool X` 是**正确组合**（且 host 是默认值，无需显式写）。

官方文档同义表述："With the default `host`, Claude Code sends them to the Agent SDK host or the `--permission-prompt-tool` tool. Pass `none` when nobody can answer, and Claude Code denies them instead."
出处 https://code.claude.com/docs/en/cli-reference（需 v2.1.259+，LO 的 2.1.260 满足）

**`none` 会让 PPT 完全失效**——任何本该弹窗的都自动 deny，不会走到你的 MCP 工具。

### F7 — `--permission-mode manual`：`default` 的别名，与 PPT **配合**而非互斥（确证）

本机 help 逐字：
```
--permission-mode <mode>   Permission mode to use for the session
                           (choices: "acceptEdits", "auto",
                           "bypassPermissions", "manual",
                           "dontAsk", "plan")
```

注意：本机 2.1.260 的 choices 里**没有 `default`，被 `manual` 顶替显示**，但两者都能用。

官方定义："`default` | Prompts for permission on first use of each tool. **Labeled Manual** in the CLI, the VS Code and JetBrains extensions, and the desktop app, and Claude Code **accepts `manual` as an alias**. The label and alias require Claude Code v2.1.200 or later."
出处 https://code.claude.com/docs/en/permissions

**与 PPT 的关系：配合，且 manual/default 是最该配的档。** 机械证据在 `of()` 开头：

```js
let w=k??await ud(d,y,T,E,D);
if(w.behavior==="allow"||w.behavior==="deny")return w;
```

先跑本地权限流水线 `ud(...)`；**只有结果既非 allow 也非 deny（即 "ask"）时，才会调用你的 MCP 工具**。因此：

| 模式 | PPT 是否被调用 |
|---|---|
| `manual` / `default` | **是**（最常触发——每个未预批工具都落到 ask） |
| `plan` | 是（文件编辑永不自动批，走 ask） |
| `acceptEdits` | 部分（文件编辑被提前批掉，不到 PPT） |
| `bypassPermissions` | **基本不会**（提前全批） |
| `dontAsk` | **不会**（ask 直接转 deny） |
| `auto` | 分类器先裁决 |

同时，`--allowedTools` / `--disallowedTools` 命中的也在 `ud` 阶段被解决，**不会**到 PPT。第三方逆向称之为"三层模型，静态规则优先"，与源码一致。

---

## 结构化字段：踩坑清单（按危险度排序）

| # | 坑 | 后果 | 出处 |
|---|---|---|---|
| 1 | 用 `toolName`/`toolInput` 命名入参 | zod 校验不过 → 工具收不到值 | F1 源码 |
| 2 | 响应回传写 `tool_use_id` 而非 `toolUseID` | 该字段被丢（optional，不报错） | F3 源码 |
| 3 | deny 忘了 `message` | schema 失败 → **静默 deny**，只在 error 日志有痕 | F2 源码 |
| 4 | 返回结构化对象而非 text block 里的 JSON 字符串 | **throw**，非 deny | F2 源码 |
| 5 | 返回多个 content block | 只读 `content[0]`，其余静默丢弃 | F2 源码 |
| 6 | 目标工具不是真 MCP 工具（无 `inputJSONSchema`） | 启动即报 `must be an MCP tool` 并 exit 1 | F8 源码 |
| 7 | 审批流程做得太慢 | MCP server 未连上会等 `MCP_TIMEOUT`（默认 30s）；工具调用本身同步阻塞 | 官方 cli-reference |
| 8 | 指望批准 `requiresUserInteraction` 类 MCP 工具 | **allow 被强制转 deny** | F8 源码 |

### F8 — 三个会直接打脸的守卫（确证 · 一手源码）

```js
// 守卫1：工具必须存在，否则 exit 1（LO 已实测命中此条）
let ue=le.map((Ue)=>Ue.name).join(", "),
xe=`Error: MCP tool ${e} (passed via --permission-prompt-tool) not found. Available MCP tools: ${ue||"none"}`;
throw process.stderr.write(`${xe}\n`),Hr(1),ft(Error(xe),ue?z_:Q_)

// 守卫2：必须是 MCP 工具（判据 = 有 inputJSONSchema）
if(!H.inputJSONSchema){
  let ue=`Error: tool ${e} (passed via --permission-prompt-tool) must be an MCP tool`;
  throw process.stderr.write(`${ue}\n`),Hr(1),ft(Error(ue),Y_)}

// 守卫3：需要用户交互的 MCP 工具，allow 强制转 deny
if(Ue.behavior==="allow"&&kh(d)&&d.requiresUserInteraction?.())
  return{behavior:"deny",message:"MCP tool requires user interaction; not supported via --permission-prompt-tool",decisionReason:mRn};

// 守卫4：server 断连后的兜底
if(e===null||n())return{behavior:"deny",message:"The permission prompt tool is no longer available \u2014 its MCP server is not connected in this session.",decisionReason:hRn};

// 守卫5：仅本地显示类决策无法走 PPT
if(w.localDisplayOnly)return _ct(d.name,"the configured --permission-prompt-tool (a tool_name+input wire)");
```

守卫3 与官方 cli-reference 记载一致："The prompt tool can't approve an MCP tool marked as requiring user interaction: Claude Code converts an `allow` result for one to a deny. This restriction requires Claude Code v2.1.199 or later."

---

## 缺口（明确未找到，勿用训练知识补）

1. **官方对 PPT wire 协议的文档：不存在。** issue #24595 明确诉求"零文档"，2026-03-11 被 stale 机器人关闭、03-19 锁定，**未被修复**。官方在 #1175 的回应是引导改用 Hooks。→ 本报告的 F1/F2/F3 是 LO 唯一可依赖的规格来源，且因为它来自你本机那个二进制，比任何文档都准。
2. **`type CanUseTool = ...` 的逐字 TS 类型定义：未取到**（官方 typescript 参考页抓取时截断）。需要则本地读 SDK 的 `sdk.d.ts`。
3. **`decisionClassification` 三个枚举值的语义：未找到任何文档。** 只知取值 `user_temporary`/`user_permanent`/`user_reject` 且 optional + `.catch(void 0)`（非法值静默忽略）。
4. **`updatedPermissions` 在 PPT 线路的实际可用性：未见任何实测报告。** schema 接受它，`mHt` 里确有 `setSessionToolPermissionContext` + 持久化 `dM(f, o.storageV5)` 分支；但告警文案写的是 "Malformed updatedPermissions **from SDK host**"，暗示主要为 SDK 宿主设计。issue #1175 有长篇讨论指出 PPT 缺目录上下文、做 always-allow 有 scope 歧义（`npm run:*` vs `npm:*`），Anthropic **未答复**。→ **建议 LO 本机实测**。
5. **`--permission-mode delegate`：本机 2.1.260 的 choices 里没有。** 第三方（v2.0.76 时代）称其存在且未文档化，Elixir SDK 也暴露 `permission_mode: :delegate`。**疑似已移除或改名**，勿依赖。
6. **PPT 工具调用的超时上限：未找到明确数值。** 只确证"MCP server 连接等待"受 `MCP_TIMEOUT`（默认 30s）约束。工具调用本身是 `Promise.race([te, re])`——只与 abort 信号赛跑，**代码层面无独立超时**（官方文档对 SDK `canUseTool` 说"can stay pending indefinitely"）。→ 需实测。
7. **非 `-p` 模式下 PPT 是否生效**：第三方仓库警告"不生效"，官方 flag 描述限定 "in non-interactive mode"。未见官方正面说明。

---

## 下游建议

### 建议召唤
- **无需再调研。** F1/F2/F3 已是源码级确证，够直接写实现。
- **建议烛（codex-reviewer）评审 approval MCP server 实现**——这是安全边界代码（决定什么工具能跑），属 §三 🔴 必须发火。重点让烛看：守卫3/4/5 的绕过面、schema 校验失败静默 deny 的可观测性、审批阻塞导致的 DoS。

### 风险信号
1. **静默 deny 是本协议最大的运维陷阱**——拼错字段不报错、只写 error 日志。实现时**必须**在自己 server 侧做出参 zod 自校验 + 落日志，别指望 CLI 告诉你。
2. **`interrupt: true` 能中断整个会话**（`abortController.abort()`）。是能力也是脚，别误传。
3. **PPT 拿不到 cwd / session**。若审批策略依赖"在哪个目录"，此线路**结构性做不到**（issue #1175 已确认）。需要目录感知就得走 PreToolUse hook 或 SDK。
4. **`--permission-prompts none` 会静默废掉整个 PPT**。若 LO 的 Console 同时下发这两个旗标，PPT 永不触发且不报错。
5. 协议**全程未文档化且 issue 被 stale 关闭** → Anthropic 无兼容性承诺。建议在 Console 侧把 `{behavior,...}` 构造收敛到单一模块，便于版本漂移时一处改。

---

__DELTA__: 织(grok) | 2 | 证据：推翻主驾"输入 schema 可能是 {toolName,toolInput}"的候选假设——claude.exe v2.1.260 偏移 202454550 处 zod 声明与 202939342 处调用点均为 snake_case {tool_name,input,tool_use_id}；并挖出官方文档完全缺失的 4 个字段（interrupt / decisionClassification / updatedPermissions / toolUseID 大小写反转）+ 5 条硬守卫，官方 issue #24595 记录此协议"零文档"且已 stale 关闭
