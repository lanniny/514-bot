<!-- 514cc-session-id: cf8dac53-77b0-4ebe-891a-d261f66f8439 -->

# v49 信任边界契约规格（入站/出站）

> **产出说明（诚实标注）**：本文档原计划由策（spec-architect）撰写，该 subagent 因
> `429 rate_limit / session_full` **执行失败**，未产出任何内容。本文档由主驾（Claude）
> 基于实测证据自行撰写，**不是策的产物**，未经独立评审。
>
> 触发事由：2026-09-04 烛（Codex）评审在 v49 审批白名单收口中发现致命 1 ——
> 主驾把两个方向相反的白名单合并，造成入站提权面。烛给出的元教训是
> 「白名单需要**方向**这个维度」，本规格是对该教训的系统化。
>
> 所有 `file:line` 均为 2026-09-04 实测，未经推断。

---

## 1. 边界拓扑（实测事实）

```
┌─────────────────────── 可信侧：控制面进程 ────────────────────────┐
│                                                                   │
│  server.mjs ──► orchestrator.mjs ──► adapters/*.mjs               │
│                       │                    │                      │
│                 approval-broker      approval-methods              │
│                 （审批队列/审计）      （方法登记表·单一真相源）        │
│                                            │                      │
└────────────────────────────────────────────┼──────────────────────┘
                                             │ spawn + stdio
              ═══════ 信任边界 ═══════════════╪═══════════════════
                                             │
┌──────────────────── 不可信侧：CLI 子进程 ───┴──────────────────────┐
│  codex app-server / claude / kimi / grok / pi / opencode / gemini │
└───────────────────────────────────────────────────────────────────┘
```

### 1.1 入站通道盘点（`src/adapters/*.mjs`，2026-09-04 实测）

| adapter | server-request 通道 | 输出解析 | 入站可发起审批？ |
|---|---|---|---|
| `codex-app-server` | **有**（`:767 handleServerRequest`） | JSONL | **是**（唯一） |
| `pi-rpc` | 无 | JSONL（`:155`） | 否 |
| `claude-cli` | 无 | 行解析 | 否 |
| `grok-build` | 无 | 行解析 | 否 |
| `opencode-cli` | 无 | 行解析 | 否 |
| `kimi-cli` / `codex-cli` / `gemini-cli` / `grok-mcp` | 无 | — | 否 |

**关键事实**：9 个 adapter 里**只有 `codex-app-server` 一个**接受子进程发起的
审批请求（`grep -c "approvalResolver" src/adapters/*.mjs` → 其余全 0）。

**这不是遗漏，是设计差异**：其余 adapter 走**启动期权限档**——
`claude-cli.mjs:10` 的 `--permission-mode`、`kimi-cli.mjs:7` 的 `--plan` ——
权限在进程启动时锁死，子进程**无法在运行中请求提权**。
攻击面因此比"9 个 adapter 都要接契约"的直觉小得多。

### 1.2 出站通道（控制面 → 子进程）

全部经 adapter 的 `send()`（契约见 `adapters/adapter-sdk.mjs`）。
权限表达分两类：
- **启动期旗标**：claude / kimi / grok / opencode —— 一次锁死
- **运行期协商**：codex app-server —— `codexPermissionPreset()`
  （`codex-app-server.mjs:113`）映射到 `thread/start` 的 sandbox + approvalPolicy

---

## 2. 方向维度：已实现的表达方式

`src/approval-methods.mjs` 的 `inbound: boolean` 字段（v49 新增）：

```js
"control/runBuild/requestApproval": { inbound: false, ... }   // 仅控制面发起
"item/commandExecution/requestApproval": { inbound: true, ... } // 子进程可发起
```

两个导出函数把方向变成可消费的 API：
- `approvalMethodNames()` —— 控制面**认识**的全集（含自发起）
- `inboundApprovalMethodNames()` —— 子进程**被允许发起**的真子集

adapter 必须用后者（`codex-app-server.mjs:107`）。

### 2.1 为什么 boolean 够用，不需要三态

考虑过 `inbound / outbound / bidirectional` 三态，**放弃**，理由基于实测：
控制面认识的 6 个方法里，5 个是纯入站、1 个是纯出站，**没有双向的**。
三态会引入一个当前无实例的分支——按 YAGNI 不做。
若将来出现双向方法，改成三态是加字段而非改语义，迁移成本低。

---

## 3. 机械守卫（已实现 + 建议）

### 3.1 已实现（`tests/approval-methods.test.mjs`）

| 守卫 | 断言什么 | 注入什么会红（**已实测**） |
|---|---|---|
| 入站黄金快照 | `inboundApprovalMethodNames()` 逐项等于独立手写的 `INBOUND_GOLDEN`（依据 `git show HEAD:` 原版 5 元 Set） | 把 runBuild 加进入站集 |
| 源码级断言 | `codex-app-server.mjs` 源码含 `new Set(inboundApprovalMethodNames())` 且**不含** `new Set(approvalMethodNames())` | adapter 改回全集 → 红（已验证） |
| 显式声明 | 每个方法的 `spec.inbound` 必须是 boolean | 新增方法忘填 inbound |
| 深冻结 | 逐层 `Object.isFrozen`，且实际尝试篡改后值不变 | 改回 `Object.freeze` → 红（已验证） |
| fail-closed | `isInboundApprovalMethod` 对未登记 / 原型链键 / 非 string 一律 false | 改成 `!== false` 宽松判定 |

**元验收纪律**：以上"会红"全部**真注入验证过**，不是纸面推断。
这条纪律来自同日教训——首版 INV5 写了 buggy-must-turn-red 的注释却没真跑，
结果它对 `accept→approve` 突变全绿（见 `tautological-test-baselines` 记忆）。

### 3.2 建议：把源码级断言泛化成 lint（未实现）

现在"adapter 必须用入站集"是一条**针对单文件的字符串断言**。
若将来第二个 adapter 加入站通道，这条断言不会覆盖它。

建议实现 `scripts/trust-boundary-lint.mjs`：
- 扫 `src/adapters/*.mjs`，找 `approvalResolver` 出现处
- 该文件若同时出现 `approvalMethodNames()` 而非 `inboundApprovalMethodNames()` → 报错
- 数据源：源码字面量（与 `api-contract.mjs` 同款静态抽取思路）

**未实现的原因如实说**：当前只有一个 adapter 有入站通道，
写一条 lint 去防一个不存在的第二实例，收益低于它的维护成本。
**加第二个入站 adapter 时必须先做这条 lint** —— 这是本规格留给未来的硬约束。

---

## 4. 审批请求归属：已修（依据官方 Schema）

### 4.1 决定性证据

本机 `codex app-server generate-json-schema`（Codex **0.151.0**）导出实测：

| 方法 | required 字段 | 有 threadId？ |
|---|---|---|
| `CommandExecutionRequestApprovalParams` | itemId, startedAtMs, **threadId**, turnId | ✅ 必填 |
| `FileChangeRequestApprovalParams` | itemId, startedAtMs, **threadId**, turnId | ✅ 必填 |
| `PermissionsRequestApprovalParams` | cwd, itemId, permissions, startedAtMs, **threadId**, turnId | ✅ 必填 |
| `ApplyPatchApprovalParams`（legacy v1） | callId, **conversationId**, fileChanges | ❌ 无 |
| `ExecCommandApprovalParams`（legacy v1） | callId, command, **conversationId**, cwd, parsedCmd | ❌ 无 |

五个方法在 0.151 的 `ServerRequest.json` 联合类型里**全部现役**，legacy 未下线。

**这推翻了我原先的假设**。我本以为要去查"Codex 什么情况下省略 threadId"，
真相是：v2 三方法**协议保证必填**（L1 恒命中，L2/L3 对它们是死路径）；
legacy 两方法**根本没有这个字段**，只有 `conversationId` ——
而 adapter 此前**完全不读 conversationId**（实测 grep 计数为 0），
所以 legacy 请求必然掉到 L3。

**兜底不能简单收紧**：L3 是 legacy 的唯一归属路径，砍掉等于让 legacy 审批全部未归属。

### 4.2 修法（`codex-app-server.mjs:767 resolveRequestAttribution`）

归属逻辑抽成独立方法，五层显式命名，**结果随事件落盘**：

| 层 | 触发 | attribution |
|---|---|---|
| L1 | threadId 精确命中 | `exact`（不落标记，正常路径） |
| L1b | **新增** conversationId 命中 | `conversation` ← legacy 的正确归属 |
| L2 | turnId 扫描 | `turn-scan` ← 可被子进程误导，必须留痕 |
| L3 | 唯一活跃轮 | `sole-active` |
| — | 归不上 | `none` |

`exact` 之外的归属都写进 `approval.requested` / `adapter.server_request_unsupported`
的 data —— **不可见的降级等于没有降级**。

L2 可被伪造 turnId 误导这件事**保留但标记**，不消除：影响面止于进程内
（adapter 实例与 `this.child` 一对一，`codex-app-server.mjs:613`），不跨信任边界。
消除它需要额外校验 turnId 所属 thread，收益低于把它标出来让审计可见。

12 项契约测试（`tests/approval-attribution.test.mjs`），期望值依据上表官方 schema，
含一条元验收：复刻"没有 L1b"的旧行为，证明该层确实在起作用（旧 `none` → 新 `conversation`）。

---

## 5. 迁移路径

| 步骤 | 动作 | 验证 |
|---|---|---|
| ✅ 1 | `approval-methods.mjs` 加 `inbound` 字段 + 两个导出 | 22 项契约测试 |
| ✅ 2 | `codex-app-server` 改用 `inboundApprovalMethodNames()` | 源码级断言 + 注入验证 |
| ✅ 3 | 表深冻结 | 篡改后值不变 |
| ✅ 4 | 归属五层显式化 + `attribution` 落盘 + legacy conversationId | 12 项测试（§4.2） |
| ⬜ 5 | 第二个 adapter 接入站通道**之前**：实现 §3.2 的 lint | 新 adapter 误用全集 → 红 |

其余 8 个 adapter **不需要迁移** —— 它们没有入站审批通道（§1.1）。

---

## 6. 元教训（可复用）

烛点破的模式，值得写成判据：

> **"统一化"会消除互为证人的冗余。**
> 三处分散的白名单彼此制约；合并成一处后，如果不显式保留它们的**区别维度**，
> 那个维度就静默蒸发了。

动手合并前的三问：
1. 这几处**看起来相同**的清单，各自服务于什么方向 / 什么信任级别？
2. 合并后，原来"A 有而 B 没有"的那些差异去哪了？是**有意统一**还是**被抹平**？
3. 新的单一真相源里，有没有字段承载那些差异？没有 = 约束丢了。

同日两次错误（permissions 可批准性、runBuild 入站）**都是同一个模式**。

---

__DELTA__: 主驾自评(Claude) | 1 | 证据：Codex 0.151 官方 JSON Schema 实测推翻主驾原假设——v2 三方法 threadId 为 required（L2/L3 对它们是死路径），legacy 两方法无 threadId 只有 conversationId 而 adapter 完全不读它（grep 计数 0），故兜底真正服务的是 legacy 且不可收紧；据此在 codex-app-server.mjs:767 补 conversation 归属层 + attribution 落盘
