# 514 Bot 协作协议 v1（Grok Bot 对标）

> 状态：已实现（src/bots/ 四面 + server.mjs 接线），2026-09-09
> 对标：xAI Grok Bot（x.ai/bot 产品体系，docs.x.ai/grok-bot 文档，2026-08 beta）
> 边界：本协议只定义「协作语义层」——Bot 定义、交接、例行、审批边界。
> 云计算机/远程桌面三态（not-provisioned/local-runtime/remote-attested）沿用 v43 产品重塑基线，不在本协议重复造。

## 0. 为什么对标 Grok Bot

Grok Bot 是 xAI 的「持久命名 AI 队友」系统。它的协作体系核心不是 UI，而是四条语义：

1. **Bot 是 durable teammate**——有名字、职位、持久规则（description）、一份持续的 job；job 用运营语言写：Owns 什么结果、哪些动作必须审批。
2. **Bot 之间直接协作**——@ 点名指派、kickoff 模板（"@A 做 X；@B 做 Y；不要发布"）、异步 handoff（接收方醒来处理、交接在会话可见）、**每阶段单一 owner**。
3. **skill + routine 复用成功路径**——skill 是可复用流程（何时用/输入/步骤/验收/产出/审批边界）；routine = owning Bot + skill + schedule + 缺数据策略，Test run 先行，50/Bot 配额，20 条运行历史。
4. **审批边界是一等公民**——显式声明「哪可改到哪必须停」，Auto Review 窄规则，secure handoff（密码/2FA 人接管，敏感值不进 transcript）。

514cc 的差异化内核（bus/inbox/attention、approval-broker、automations、9 adapter 席位、orchestrator 全准入链）全部保留——本协议是**对齐 Grok 协作语义的叠加层**，不是第二套真源。

## 1. 层模型

```
┌─────────────────────────────────────────────────────────────┐
│ Bot 花名册（profiles.mjs）                                   │
│   memberId / handle / job.owns / job.goals / standingRules  │
│   approvalBoundary{requireApproval,neverAllowed} / skills   │
│   routineQuota(50) / pinned / hidden                        │
│   —— 叠加在 team-members 之上；席位真源不复制                │
├─────────────────────────────────────────────────────────────┤
│ 交接协议（relay.mjs）                                        │
│   kickoff 解析 / handoff(task+handoffId) / ack(ackOf 回执)  │
│   单 owner 守卫（kickoff 内 fail-fast；跨消息 stage 告警）   │
│   —— 直接写 BusStore；交接在 run 会话里可见                  │
├─────────────────────────────────────────────────────────────┤
│ 例行任务（routines.mjs）                                     │
│   六要素必填（指令源/输入源/期望产出/审批边界/缺数据策略/    │
│   schedule）/ Test run(plan-only) / 配额 / 20 条历史         │
│   —— 桥接 AutomationStore（enable→create, pause→disable）   │
├─────────────────────────────────────────────────────────────┤
│ 审批边界（approval-broker 既有 + profiles.approvalBoundary） │
│   持久边界随 routine/kickoff 装配进提示词；危险动作仍走      │
│   approval-broker 租约（不变）                               │
└─────────────────────────────────────────────────────────────┘
```

## 2. Bot 定义模型（profiles）

对齐 Grok「Create and manage Bots」。**职责归属用运营语言写**——好的 profile 看起来像这样：

```json
PUT /api/bots/weaver
{
  "job": {
    "owns": "每周配置健康巡检：汇总 route-gate/DELTA/handoff 三块账本，产出链接化观察清单",
    "goals": ["漂移发现率 100%", "每周一 08:00 前出清单"]
  },
  "standingRules": [
    "来源必须带出处（file:line 或 URL）",
    "客户联系类动作永不允许"
  ],
  "approvalBoundary": {
    "requireApproval": ["向 channels 外发任何消息", "删除数据"],
    "neverAllowed": ["git push --force", "修改 ~/.codex/config.toml"]
  },
  "skills": ["grok-researcher"],
  "routineQuota": 50
}
```

与 Grok 的对应：

| Grok Bot 概念 | 514cc 落点 |
|---|---|
| name / title / avatar | team-members（label/shortLabel/avatar，真源不动） |
| description（持久规则） | `standingRules` + `job.owns` |
| job（Owns ...） | `job.owns` + `job.goals` |
| skills enabled per Bot | `skills[]`（skill code 列表） |
| 50 routines per Bot | `routineQuota`（默认 50，0-50） |
| Pin / hide | `pinned` / `hidden` |
| @ 提及 | `handle`（唯一 @ 别名；未建 profile 回落 @memberId） |

**守卫**：密钥字面量拒绝入库（findSecretCandidates）；handle 全局唯一；memberId 必须存在于 team roster（fail-closed）。

## 3. 交接协议（relay）

### 3.1 kickoff（群聊派发）

Grok 模板机械化：

```
@weaver 收集 route-gate.log 与 decisions.md 近 7 天数据，每条判断带出处。
@candle 核对账完整性：缺 DELTA 的 handoff 逐条列出。
不要修改任何治理文件。
```

- 第一个 @handle 前的文本 = **共享目标**（注入每条 task 消息的【共享目标】前缀）
- @team / @everyone / @all = 广播哨兵，不开启指派段
- **同一 @handle 出现两次 = RELAY_DUPLICATE_OWNER fail-fast**（Grok: "Too many parallel handoffs can create duplicate work and noisy updates"）

### 3.2 handoff（单点异步交接）

```
POST /api/bots/relay/handoff
{ "runId": "...", "from": "weaver", "to": "@candle", "stage": "review", "text": "清单已出，请复核完整性" }
```

- 落 bus：`kind: "task", refs: { stage, handoff: true, handoffId }`
- 接收 Bot 的下个 turn 通过 bus snapshot 感知（读取按收件人裁剪——bus 既有语义）
- 跨消息阶段守卫：同 run 同 stage 已有别的 owner 时返回 warning（`strictStages: true` 升级为 fail）

### 3.3 ack（确认回执）

- 仅交接的**接收方**（to）可 ack：`refs: { ackOf: handoffId, ack: true }`
- 重复 ack 幂等返回 `state: "already-acknowledged"`
- `GET /api/bots/relay/<runId>` 交接板：`openHandoffs`（未确认）/ `acknowledgedHandoffs`——**交接在会话里可见**（Grok: "You can see the handoff in the conversation"）

## 4. 例行任务（routines）

对齐 Grok「Skills and routines」六要素确认清单——**全部必填，否则 VALIDATION_FAILED**：

| 要素 | 字段 | 示例 |
|---|---|---|
| owning Bot | `owningMemberId` | `weaver` |
| 指令源（二选一，互斥） | `skillRef` XOR `instructions` | `grok-researcher` 或内联步骤 |
| schedule | `schedule` | `at:08:00@1,3,5`（复用 automations 语法） |
| 输入源 | `inputSource` | `{kind:"prompt", value:"近 7 天账本"}` |
| 期望产出 | `expectedOutput` | `链接化观察清单` |
| 审批边界 | `approvalBoundary` | `不外发；产出仅回帖到会话` |
| 缺数据策略 | `noDataPolicy` | `report-failure` / `skip-and-report`（**不允许** stale-data 默认） |

- **Test run（plan-only）**：`POST .../test` 只装配计划快照（promptPreview/schedule/boundary），如实标注 `mode: "plan-only"`——真实试跑走 enable 后的 automation.trigger（orchestrator 全准入链）
- **桥接**：enable → `toAutomationSpec()` 翻译成 AutomationStore.create（幂等：automationRef 回写，pause/enable 循环不产生重复 automation）；PUT 同步 automation；DELETE 先删 automation 再删 routine（fail-closed）
- **配额**：每 Bot 50 条（对齐 Grok），`routineQuota` 可按 profile 收窄
- **运行历史**：保留最近 20 条（对齐 Grok）

## 5. 组织原则（对齐 Grok「Organize a team of Bots」）

1. **最小花名册**：一个 Bot 端到端拥有一个结果；只有工作出现稳定的专家角色才加 Bot。
2. **每阶段单 owner**：kickoff 单 owner 守卫是机械强制的，不是建议。
3. **交接可见**：handoff/ack 全部进 bus，交接板可查询——LO 不必在工具之间当路由器。
4. **外部动作审批后**：`approvalBoundary.requireApproval` 是持久边界，随 routine/kickoff 装配进提示词；高影响动作仍走 approval-broker 租约。
5. **先草稿后执行**：routine 先 test（plan-only）再 enable；缺数据报告失败，绝不用旧数据冒充。

## 6. 不采用清单（诚实边界）

| Grok Bot 能力 | 514cc 决策 | 原因 |
|---|---|---|
| 持久云计算机（共享 VM/浏览器/终端） | 不复制 | v43 已定三态模型（not-provisioned/local-runtime/remote-attested）；本协议只在 local-runtime 落地协作语义 |
| Bot 创建 Bot（组建团队） | 不自动 | 花名册变更属治理动作，必须 LO 确认（rules.md §二.1 危险操作二次确认） |
| Bot 公开分享链接 | 不开放 | 无签名信任根（v44 蓝图 W4）；模板导出可作后续提案 |
| 录制演示学习（Teach a task，10 分钟录像） | 不实现 | 无云浏览器录像面；routine 从六要素声明式创建，不靠录屏推断 |
| 50 Bot + 群聊账号上限 | 不设全局 | 席位上限由 team-members MEMBER_MAX(512) 承担；profile 上限对齐 |
| 接管（user-control）交还电脑 | 沿用 v43 | 见 v43-514-bot-product-reframe.md §4，本协议不重复 |

## 7. API 速查

```
GET    /api/bots                         花名册（profiles + 成员元数据）
GET    /api/bots/protocol                本协议的机器可读摘要
GET/PUT/DELETE /api/bots/<memberId>      Bot profile
POST   /api/bots/relay/kickoff           群聊 kickoff 派发
POST   /api/bots/relay/handoff           单点交接
POST   /api/bots/relay/ack               交接确认
GET    /api/bots/relay/<runId>           交接板
GET/POST   /api/bots/routines            例行列表 / 创建
GET/PUT/DELETE /api/bots/routines/<id>   例行单条（删除联动 automation）
POST   /api/bots/routines/<id>/test      Test run（plan-only）
POST   /api/bots/routines/<id>/enable    启用（桥接 AutomationStore）
POST   /api/bots/routines/<id>/pause     暂停
```

## 8. 事实来源

- xAI 官方文档（2026-09-09 抓取）：`docs.x.ai/grok-bot/{overview,bots,chat-and-collaboration,skills-routines-and-automations,approvals-security-and-privacy,use-cases}.md`
- x.ai/bot 产品页（被 Cloudflare 拦截，正文以 docs 站 + 官方发布稿为准）
- 本仓：`proposals/v43-514-bot-product-reframe.md`（v43 重塑基线）、`src/bus.mjs`（消息总线）、`src/team-members.mjs`（席位真源）、`src/automations.mjs`（调度真源）
