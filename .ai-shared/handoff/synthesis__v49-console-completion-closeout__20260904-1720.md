<!-- 514cc-session-id: cf8dac53-77b0-4ebe-891a-d261f66f8439 -->

# v49 协作台深度完善 · 收尾

**日期**：2026-09-04
**范围**：`apps/control-center`（Console 前后端）
**参照**：openai/codex harness（织调研 + 本机 0.151 官方 JSON Schema）、DeepSeek Harness `dsh`（织调研）

---

## 一句话

修了 5 处缺陷，其中**两处是我自己在本程制造的**，都由独立评审照出。
新增 98 项契约测试，全部带 buggy-must-turn-red 真注入验收。

---

## 交付

| # | 缺陷 | 修法 | 测试 |
|---|---|---|---|
| 1 | 事件严重度靠词表猜，漏 9 类词根共 14 个事件（`run.directive_rejected` 与 `run.sources_added` 同色同形） | `public/modules/event-severity.js`：87 种事件逐条显式声明档位 + 未登记标 `inferred` | 14 |
| 2 | **覆盖率扳机自身盲区**：只扫 `emitEvent(` 一种写法，漏 46/87 种（`#emit` / `eventStore.emit` 全域漏），测试"绿是因为看不见" | `tests/helpers/backend-event-types.mjs` 单一扫描口径 + `types.length >= 80` 下界断言 | 10 |
| 3 | 审批白名单三处手写（5/2/5 元不一致），resolver 缺失时 legacy 方法收 -32001 而非明确拒绝 | `src/approval-methods.mjs` 单一真相源 | 22 |
| 4 | A/B 影子对照后端完整、**前端零入口**（44K 行零调用、无测试） | `public/modules/shadow-compare-panel.js` + 观测页面板 | 13 |
| 5 | 审批请求归属三层兜底不可见；legacy 的 `conversationId` **完全没被读过** | `resolveRequestAttribution()` 五层显式 + `attribution` 一路带到审批卡 | 16 |
| 6 | `broadPermission` 在**三处**审批 UI 都被算出却都没使用（含一条注释说"与安全诊断页同口径禁批"，而该页自己也没禁） | UI 禁用 + 红框说明 + 两个 resolve 函数入口逻辑闸 | 9 |
| 7 | `server.mjs` 123 条路由与 `api.js` 92 条常量**零机械关联** | `src/api-contract.mjs` + `npm run api:audit` 门禁 | 14 |

**最终状态**：2172 项测试 / 2169 通过 / 1 失败 / 2 跳过；`ui:lint` 7 条规则零新增违规。

唯一失败 `conversations-http.test.mjs:200`（`'build' !== 'plan'`）经**干净 worktree 在 HEAD 上单跑通过**，
根因是本会话开始前就存在的工作区改动（`orchestrator.mjs` 默认权限档 `plan` → `build`），
与本程无关，未动。

---

## 两处我自己制造的缺陷（烛照出）

### A. 入站提权面（DELTA=2，推翻主驾判断）

收口审批白名单时，我把**两个方向相反**的白名单合并了：

| 白名单 | 语义 | 该含 `control/runBuild/requestApproval` |
|---|---|---|
| broker `responseFor()` | 出站：控制面自己发起 | 必须含 |
| adapter `APPROVAL_METHODS` | **入站门闸**：子进程能否发起 | 绝不能含 |

原版手写 5 元不含它，我改成 6 元。烛实测伪造入站请求拿到
`{"decision":"accept","approvalId":"ATTACKER-SUPPLIED"}`（原版回 -32601），
且会被 `app.js:21353` 渲染成与真授权卡视觉一致的卡片。

**爆炸半径经双方核实、不夸大**：`orchestrator.mjs:1672` 仍校验 `actionSha256`，
租约铸造安全 → 操作者欺骗 + 队列污染 + 账本污染，**不是直接提权**。

修：加 `inbound: boolean` 维度 + `inboundApprovalMethodNames()` + 源码级断言。

### B. 假基线（烛用注入证明）

我的 INV5 写成 `expected = 被测表.取值()`，而 broker 现在也从同一张表取值
—— **拿表验表，恒真**。烛把 `accept` 改成 `approve`（协议外的值），**38 项测试全绿放行**。

修：`WIRE_GOLDEN` / `INBOUND_GOLDEN` 独立手写，依据 `git show HEAD:` 原版 + 官方协议。
并**真注入三次突变**逐一确认变红，不再只写注释。

---

## 一次假设被官方 Schema 推翻

我原以为要查"Codex 什么情况下省略 threadId"。本机 `codex app-server generate-json-schema`
（0.151.0）导出实测：

| 方法 | threadId |
|---|---|
| Command / FileChange / Permissions RequestApproval（v2） | **required** |
| ExecCommandApproval / ApplyPatchApproval（legacy v1） | **没有此字段**，只有 `conversationId` |

问题本身是错的：v2 三方法**协议保证必填**（兜底层对它们是死路径）；
legacy 两方法**根本没这个字段**，而 adapter 从不读 `conversationId`（grep 计数 0）
→ legacy 必然掉到最后一层兜底。

**所以兜底不能收紧** —— 它是 legacy 的唯一归属路径。改为补 `conversation` 层 + 标记可见。

---

## 外部 CLI 失败如实记录

- **策（spec-architect）**：`429 rate_limit / session_full`，**执行失败、零产出**。
  信任边界规格由主驾自撰，`synthesis__v49-trust-boundary-contract` 文首已标明不是策的产物、未经独立评审。
- **织（grok-researcher）×2**：均成功（365s / 710s）。今日早些时候的
  "任务卡写明不读治理上下文"止血措施**实测有效**，两次均未超时。

---

## 元教训（本程最值钱的部分）

### 1. 「统一化」会消除互为证人的冗余（烛点破）

三处分散的白名单彼此制约；合并后若不显式保留**区别维度**，那个维度就静默蒸发。
同日两次错误（permissions 可批准性、runBuild 入站方向）**是同一个模式**。

动手合并前三问：
1. 这几处看起来相同的清单，各自服务于什么**方向 / 信任级别**？
2. 合并后，原来"A 有而 B 没有"的差异去哪了？是有意统一还是**被抹平**？
3. 新真相源里有没有字段承载那些差异？没有 = 约束丢了。

### 2. 拿被测对象自己当期望值 = 恒真

已记入记忆 `tautological-test-baselines`。识别信号：
**一个测试在被测文件被任意修改后仍全绿，它就不是测试。**

### 3. 改过的文件不能当原文读

排查时我读了自己已改坏的 `approval-broker.mjs` 当"原实现"，越查越确信自己对，
差点让一条安全约束静默消失。**要用 `git show HEAD:<file>`。**

### 4. 一个反复出现的缺陷形态

本程 7 处缺陷里有 4 处是同一形态：**代码里写着某个意图，但那个意图没有任何机械承载**。
注释说"同口径禁批"、变量名叫 `broadPermission`、词表想抓"失败类事件"、
`__DELTA__` 想记账 —— 意图都在，兑现都没有。

判据：**看到一个表达意图的名字（变量 / 注释 / 常量），先查它有没有消费者。**

---

## 遗留（显式登记，不掩盖）

| 项 | 状态 | 说明 |
|---|---|---|
| `conversations-http.test.mjs:200` | 先前债 | 断言应对齐 `build`（v46 拍板项 8），本程未动 |
| 信任边界 lint（规格 §3.2） | 未做 | 当前只有 1 个入站 adapter；**加第二个之前必须先做** |
| 6 条无 UI 入口端点 | 已登记 | `KNOWN_UI_LESS` 带上界断言，名单只应变短 |
| `decisions.md` 分卷 | 待 LO 拍板 | 脚本就绪、五项校验通过、备份已存，等一句"确认" |

---

__DELTA__: 主驾自评(Claude) | 1 | 证据：本程 7 处缺陷中 4 处同形态（app.js:18704/21418/24949 三处 broadPermission 算而未用、workbench-topology.js:216 词表意图与事件名各自演化），归纳出"看到表达意图的名字先查有无消费者"这条可复用判据
