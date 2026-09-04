<!-- 514cc-session-id: cf8dac53-77b0-4ebe-891a-d261f66f8439 -->

# v50 许可通道 · 收敛（三方证据汇合 + 烛评审落实）

**日期**：2026-09-04
**范围**：`apps/control-center`（协议层 + 脚本生成器 + 取证工具，**仍未接线到 UI**）
**前序**：`synthesis__v50-permission-channel-evidence__20260904-1930.md`

---

## 一句话

通道选型收敛完毕：**stdio MCP + PPT 是唯一可行路径**，二进制一行代码判定，三方独立印证。
烛的 5 条改进全部落实并配机械承载，新增 14 项测试。

---

## 通道选型：三方证据指向同一结论

### 烛推翻了自己（DELTA=2）

烛上一轮推荐 stream-json 双向流，这一轮找到决定性证据并**主动推翻**：

```js
// claude.exe v2.1.260 偏移 187945707
function Uft({permissionPromptTool:e, sdkUrl:n}){ return n ? "stdio" : e }
```

主驾逐字核实为真。许可宿主只认两个来源，`--input-format stream-json` **不在任何入参里**。
CLI 官方 schema 自述（偏移 182473170）：

> "Without one (bare -p / SDK query() with no canUseTool), **'ask' decisions are terminal**"

`--sdk-url` 那条路也被烛堵死：主机名白名单只认 Anthropic 官方域 + scheme 限 wss/https +
argv 双视图交叉校验，且配套要求 `remoteSessionId` —— 是云端托管 worker 通道，非本地宿主。

### 主驾的单变量对照实验（独立印证）

同为 `-p --input-format stream-json --permission-mode plan`，唯一差异是有无 PPT：

| 配置 | init.tools 含 ExitPlanMode | 收到许可请求 |
|---|---|---|
| 不带 `--permission-prompt-tool` | 否 | 无（三轮） |
| 带 `--permission-prompt-tool` | **是** | 有 |

证据：`.evidence/xcheck/result.json`（已随临时目录清理，方法记录在此）。

### clawd-on-desk 的旁证（LO 提供的参照项目）

LO 指出可参考 `rullerzhou-afk/clawd-on-desk`。**该项目就装在本机**
（`F:/Clawd on Desk/`，Electron，asar 29.6MB），GitHub 因额度 429 未能访问，改为本地取证：

| 检查项 | 结果 |
|---|---|
| `permission-prompt-tool` | **0 处** |
| `can_use_tool` | **0 处** |
| `PreToolUse` | 32 处 |
| `permissionDecision` | **0 处** |
| pty / conpty | **0 处** |
| `dangerously-skip-permissions` | 7 处 |

UI 字符串揭示其架构（asar 偏移 25281557 附近）：

```
launchFailed: "Failed to launch Claude Code. No supported terminal was found."
directSendPermissionPending: "That session appears to be waiting for a permission decision..."
directSendAckPastedManual: "Pasted text into session {session}; press Enter locally to send it."
approvalSummaryUnavailable: "...check the Clawd bubble on your desktop before deciding."
```

**结论：clawd 不接管审批通道，它接管终端窗口。** CLI 跑在真实终端用原生审批 UI，
clawd 通过 hook（纯观测，零 `permissionDecision`）感知"此会话在等许可"，做
桌面通知 + 窗口聚焦 + 剪贴板粘贴 —— **决定仍由人在终端里按 Enter 做出**。

对 Console 不适用（Console 的价值就是在自己界面里编排多 CLI），但它是一条有力旁证：
**连专门做桌面壳的项目都没能接管审批通道**，印证 PPT 是唯一入口。

---

## 烛 5 条改进：逐条落实

| 编号 | 内容 | 落实 |
|---|---|---|
| **S-5** | v1 应禁 `user_permanent`（无持久化能力却上报"永久允许"= 如实性失配） | `V1_ALLOWED_CLASSIFICATIONS` + `assertV1Response` 分类闸；旧测试被正确推翻并改写 |
| **S-4** | `toolResultFor` 是唯一**封装**出口而非唯一**物理**出口，产品脚本手搓即绕过 | 分界标记 `SCRIPT_LOGIC_MARKER` + 断言逻辑区零 `behavior:` 字面量 |
| **S-2** | 每轮独立脚本、runId 内联为常量（优于 argv nonce） | `src/permission-server-script.mjs` |
| **S-3** | 探针误把 `--permission-prompts host` 当"声明宿主"（实为 no-op） | 删除该旗标 + 注释改为记录机械事实 + 新增 `NO_PERMISSION_HOST` 判读档 |
| **S-1** | 别把 nonce 当唯一主凭证，能力应落在可 ACL 的文件系统对象上 | 采纳：连接端点内联进脚本，脚本本身是凭证载体 |

### S-4 的机械承载（本轮最值得说的一处）

烛指出的绕过口是真的：生成的 MCP server 脚本完全可以自己
`JSON.stringify({behavior:"allow", updatedPermissions:[...]})`，把 v1 闸整个绕过去
—— 取证探针 `probe-permission-frames.mjs:121-125` 现在就是这么写的。

解法不是写句"请务必使用 toolResultFor"的注释（那正是本程反复栽的形态），而是：

1. 把**真 wire 模块源码内联**进生成的脚本（剥 `export`），闸随脚本走
2. 插一个分界标记，把脚本切成「内联模块」与「脚本自身逻辑」两段
3. 测试断言：**逻辑区不得出现任何 `behavior:` 字面量**，且每个 `result:` 都经 `toolResultFor`

实测生成物的逻辑区确实零手搓，14 处 `behavior` 全在内联的构造函数与校验器里。

---

## 交付

| 文件 | 内容 | 测试 |
|---|---|---|
| `src/permission-server-script.mjs` | 每轮 MCP server 脚本生成器（runId 内联 + 闸内联 + fail-closed） | 14 |
| `src/permission-prompt-wire.mjs` | 新增 `V1_ALLOWED_CLASSIFICATIONS` + 分类闸 | 35（+1 改写） |
| `scripts/probe-stream-json-frames.mjs` | 修正 host 误读 + `NO_PERMISSION_HOST` 瞬时判定 | — |

**14 项里含一项真端到端**：spawn 生成的脚本 → initialize → tools/list → tools/call
→ 内核不可达 → 确认返回 `behavior:"deny"` 且带原因、无 v1 禁用字段。

**元验收**：往逻辑区注入手搓 `behavior` → 守卫捕获；掏空 v1 闸 → 内联检查发现。

**最终状态**：2230 项测试 / 2227 通过 / 1 失败（先前债 `conversations-http.test.mjs:200`）/ 2 跳过。
`ui:lint` 7 条规则零新增违规。

---

## 仍未做（显式登记）

| 项 | 状态 | 说明 |
|---|---|---|
| **接线到 adapter / UI** | 未做 | 生成器与协议层就绪，但 `claude-cli.mjs` 尚未调用，审批卡尚未出现。仍是零消费者状态 |
| 内核侧 IPC 端点 | 未做 | 脚本已按"连接具名管道"写好，内核侧的监听端、ACL、轮末删脚本尚未实现 |
| 回程进哈希链 | 未做 | 烛第一轮的硬约束之一。v1 禁掉提权字段后回程只剩 `{behavior, message}`，风险大幅收窄，但覆盖仍应做 |
| "总是允许" | 未做 | 需 Console 侧规则存储（不碰 CLI 权限存储），见 `V1_ALLOWED_CLASSIFICATIONS` 注释 |
| `conversations-http.test.mjs:200` | 先前债 | 会话开始前即存在 |

---

## 元教训

**1. 烛的元教训值得原样记下**：

> 标注了不确定性 ≠ 免除了推荐责任。一个未实证的机制不该进推荐位。

它在明确写了"帧格式未实证"的同时仍把该方案放在推荐位；主驾读到那句标注，却仍把它当"正路"。
双方各有一半责任。

**2. 同一个事实可以被读成能力或危险面。** 主驾挖到 `updatedPermissions` 真会写盘时
读成"能力发现"而兴奋，烛读出的是"持久化提权"。差别不在信息，在提问方式。

**3. 旁证项目要看它没做什么。** clawd 的 `permission-prompt-tool` 计数为 0 —— 这个"零"
比它做了什么更有信息量：它绕开了整个问题，而不是解决了它。

**4. 先取证再动刀，第二次生效。** 若直接按烛的 stream-json 方案改 `claude-cli.mjs`，
会在加完自持 spawn 后才发现 CLI 压根不发那个帧。

---

__DELTA__: 主驾自评(Claude) | 1 | 证据：本地取证 clawd-on-desk（F:/Clawd on Desk/resources/app.asar：permission-prompt-tool 0 处、can_use_tool 0 处、permissionDecision 0 处、pty 0 处，UI 串 "press Enter locally to send it" 与 "No supported terminal was found"）确认其走终端接管而非通道接管，为"PPT 是唯一入口"提供第三方旁证；并落实烛 S-1~S-5 全部 5 条，其中 S-4 以分界标记 + 逻辑区零 behavior 字面量断言实现机械承载
