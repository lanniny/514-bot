<!-- 514cc-session-id: cf8dac53-77b0-4ebe-891a-d261f66f8439 -->

# v50 许可通道 · 接线完成（后端全链路打通）

**日期**：2026-09-04
**范围**：`apps/control-center`（内核端点 + adapter 接线 + broker 注册）
**前序**：`synthesis__v50-permission-channel-convergence__20260904-2010.md`

---

## 一句话

后端全链路打通：**CLI → 每轮专属 MCP server → 具名管道 → 内核端点 → ApprovalBroker**，
35 项新测试全绿（含 7 项真进程端到端）。**UI 审批卡尚未接**，这是唯一剩下的一段。

---

## 链路

```
Claude CLI                                    ← --permission-prompt-tool + --mcp-config
  └─stdio─> 每轮生成的 MCP server 脚本          ← runId 内联为常量，不经 argv
              └─具名管道─> permission-endpoint  ← 路径含随机段，连接即凭证
                            └─> ApprovalBroker  ← claude/toolPermission/requestApproval
                                  └─> 审批卡（未接）
```

## 新增

| 文件 | 职责 | 测试 |
|---|---|---|
| `src/permission-endpoint.mjs` | 每轮专属具名管道 + fail-closed 决策网关 | 18 |
| `tests/permission-link-e2e.test.mjs` | 脚本↔端点真进程端到端 | 7 |
| `tests/claude-permission-channel.test.mjs` | adapter 接线与降级边界 | 10 |

## 改动

| 文件 | 改动 |
|---|---|
| `src/adapters/claude-cli.mjs` | `#openPermissionChannel` 生命周期 + `buildClaudeArgs` 注入两个旗标 + `send` 拆出 `#sendTurn` 由 finally 保清理 |
| `src/adapters/index.mjs` | 工厂传 `approvalResolver`（remote 传 null） |
| `src/approval-methods.mjs` | 登记 `claude/toolPermission/requestApproval`（`inbound: true`） |
| `tests/approval-methods.test.mjs` | 两处黄金快照**显式**更新并写明依据 |
| `public/modules/event-severity.js` | 三个新事件登记为 `attention` |

---

## 三条边界（各自有测试）

**1. 没有 resolver 就不开通道。**
不是"能力缺失时降级"，是**主动不骗 CLI**：声明了宿主却无人应答，请求会挂到超时 ——
比现在的"无宿主即拒"更糟。remote run 同理（本机管道对端不可达）。

**2. 通道失败退回无通道，不拖垮整轮。**
端口占用、临时目录不可写、runId 形态超出安全字符集 —— 任何一步失败都退回
v50 之前的行为，并 emit `approval.channel_unavailable`。**静默降级不可接受**，有测试锁。

**3. 任何退出路径都清理。**
`send` 有多条抛错出口（预算耗尽 / 未登录 / 上游 5xx / 进程超时）。
用 `finally` 而非在每条 return 前手动清 —— 漏一条就会在盘上留下内联着 runId 的脚本、
让管道悬着不关。两项测试分别覆盖"子进程抛错"与"CLI 报错结果"路径。

---

## 归属：不可伪造（烛 S-2 落地）

端点在建立时就记住 `{runId, sessionId, agentId}`，**请求里带的同名字段只用于交叉校验**：

- `runId` 不符 → 直接拒绝 + 留痕 `run_mismatch`（有人拿别轮脚本来连）
- `sessionId` / `agentId` 一律用内核记住的那份，请求里的被忽略

有测试专门验证："沙箱谎报 `sessionId: "SANDBOX-LIES"` → decide 收到的仍是 `sess-e2e`"。

runId 内联为脚本常量而非 argv 参数 —— Windows `Win32_Process` 读不到。

---

## fail-closed 的六条路径（全部有测试）

| 情形 | 结果 |
|---|---|
| decide 抛错 | 拒绝 |
| decide 返回垃圾（`{}` / `"approve"` / `{approved:"yes"}` / `{decision:"approve"}`） | 拒绝 —— 只认 `approved === true` |
| decide 超时 | 有界拒绝（挂起会让整轮撞 CLI 进程超时，回到那个红色错误） |
| 内核不可达 / 端点已关 | 拒绝 |
| 帧损坏 / 超 256KB | 拒绝 |
| 本轮请求超 64 条 | 拒绝（防洪水淹没审批队列） |

超时值刻意收在整轮超时之内（`timeoutMs - 30s`）：两个倒计时赛跑的话，
CLI 的进程超时会先杀掉整轮，操作者的决定就白做了。

---

## 一处黄金快照的正确拦截

加完 broker 方法后，`approval-methods.test.mjs` 的两项黄金快照测试**立刻变红**：

```
✖ INV5b 登记表本身与黄金快照一致（不经 broker，直接比对表）
✖ 入站白名单与黄金快照一致，且不含 control/runBuild（方向性约束）
```

这正是它该做的 —— 那份快照的注释写着"改这份快照 = 改安全边界，必须有明确理由"。
本次是有意新增且理由明确（子进程发起的真审批请求，与 command/fileChange 同类），
所以**显式更新并在快照里写明依据**，而不是让它悄悄漂移。

同样，我自己在本程建的事件覆盖率扳机也抓住了我：新加的三个 `approval.*` 事件
未登记，测试变红。三条都定为 `attention` 而非 `info` —— 它们各自意味着一次
"本该问操作者、结果没问成"，当作 info 就等于把拒绝藏起来。

---

## 最终状态

```
2265 项测试 / 2262 通过 / 1 失败（先前债 conversations-http.test.mjs:200）/ 2 跳过
ui:lint 7 条规则零新增违规
npm run api:audit ✓ 契约对账通过
```

本轮新增 35 项，其中 **17 项跑真进程或真管道**（不是静态断言）。

---

## 仍未做

| 项 | 说明 |
|---|---|
| **UI 审批卡** | broker 已收到请求并进 `/api/approvals` 快照，但前端未针对 `tool-permission` 类型做专门渲染。**这是最后一段，也是 LO 最初要的那个"能选"** |
| 回程进哈希链 | `actionHash` 只覆盖入站；v1 禁掉提权字段后回程只剩 `{behavior, message}`，风险大幅收窄但覆盖仍应做 |
| 真实 CLI 联调 | 全链路已用真进程测过，但**尚未在一次真实的 Claude run 里跑通**（需要额度） |
| "总是允许" | 需 Console 侧规则存储，不碰 CLI 权限存储 |
| `conversations-http.test.mjs:200` | 先前债 |

---

__DELTA__: 主驾自评(Claude) | 1 | 证据：后端全链路接线完成（src/permission-endpoint.mjs 新增 + claude-cli.mjs 的 #openPermissionChannel/#sendTurn 拆分 + approval-methods.mjs 登记 inbound:true 方法），35 项新测试含 17 项真进程/真管道验证；两处既有守卫（approval-methods 黄金快照、event-severity 覆盖率扳机）在本轮正确拦截了我的改动并被显式更新而非悄悄漂移
