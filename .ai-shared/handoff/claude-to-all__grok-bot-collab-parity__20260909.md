# Grok Bot 对标的 514 Bot 协作体系深化（profiles / relay / routines / API 面）

> 会话环境：WorkBuddy（CodeBuddy 宿主），非 514cc hook 接管会话——本会话无 route-gate 注入 session marker，按规则省略该行。
> 日期：2026-09-09

## Checkpoint

- Goal: LO 要求「深度完善本项目的 514 bot 协作体系，模仿 grok bot 系统（x.ai/bot），先做研究并做深度完善」。
- Completed: Grok Bot 官方文档研究（6 页抓取）、现状差距分析、四层语义叠加（profiles/relay/routines/routes）、协议文档、server 接线、34 项契约测试、独立核验 + 两处致命修复。
- Next: Bot Shell UI 消费本层 API（profile 编辑面/交接板/例行管理）；routine enable 后的真实 provider 试跑验收；Grok 式「从成功 run 保存为 skill」通道（本轮只做声明式六要素创建）。
- Files: `apps/control-center/src/bots/{profiles,relay,routines,routes}.mjs`；`apps/control-center/docs/bot-collaboration-protocol.md`；`apps/control-center/server.mjs`（import+register 两行）；`apps/control-center/tests/bots-*.test.mjs` ×4；`module.yaml`。

## 研究结论（x.ai/bot = Grok Bot）

x.ai/bot 正文被 Cloudflare 拦截；改从官方文档站（docs.x.ai/grok-bot，6 页 markdown）+ 官方发布稿取证。核心机制：

1. **Bot = durable AI teammate**：name/title/description（持久规则）/job（运营语言：Owns 什么结果、哪些动作必须审批）；50 Bot/账号；Pin/hide；description 放持久规则、会话放任务指令。
2. **Bot 间直接协作**：@ 点名指派、kickoff 模板（@A 做 X；@B 做 Y；不要发布）、异步 handoff（接收方醒来处理、交接在会话可见）、**每阶段单一 owner**（并行 handoff 过多 = 重复劳动）。
3. **skill + routine**：skill 可复用（何时用/输入/步骤/验收/产出/审批边界），跨 Bot 启用；routine = owning Bot + skill + schedule + 输入源 + 期望产出 + 审批边界 + 缺数据策略；Test run 先行；50/Bot；20 条运行历史；缺数据报告失败而非用旧数据。
4. **审批边界一等公民**：显式边界声明、Auto Review 窄规则（Require Approval 胜 Always Allow）、secure handoff（密码/2FA 人接管、敏感值不进 transcript）、least privilege。

## 差距分析与取舍

514cc 已有：Bot Shell UI（v43）、bus/inbox/attention、approval-broker、automations、team-members 席位、orchestrator 全准入链、09-07 orchestrator 协作方法与过程渲染波。
缺口（本轮补）：Grok 式 **Bot 定义模型**（job/边界/skills/配额结构化）、**交接协议语义**（kickoff/单 owner/ack 回执）、**例行任务语义层**（六要素/桥接调度器）、**协作治理成文**。

取舍原则：不造第二真源——profiles 叠加在 team-members 之上；relay 直接写 BusStore；routines 桥接 AutomationStore（enable→create、pause→disable、DELETE 先删 automation 再删 routine，fail-closed）；审批仍走 approval-broker。

## 实现面

- `profiles.mjs`：BotProfileStore（job.owns/goals、standingRules、approvalBoundary{requireApproval,neverAllowed}、skills、@handle 唯一、routineQuota 默认 50、pin/hide）；resolveHandle 回落校验 roster 存在性（@ghost 不可指派）。
- `relay.mjs`：parseKickoff（共享目标 + @handle 指派段 + 广播哨兵 @team/@everyone/@all）、singleOwnerConflicts（同 handle 双指派 fail-fast RELAY_DUPLICATE_OWNER）、stageOwnerWarning（跨消息 stage 重复认领告警，strict 可升级 fail）、handoff（task+handoffId）/ack（仅接收方，幂等）/readBoard（openHandoffs/acknowledgedHandoffs 投影）。
- `routines.mjs`：六要素必填（指令源互斥 skillRef XOR instructions、schedule 复用 automations 语法、expectedOutput/approvalBoundary 必填、noDataPolicy 禁 stale-data 默认）、testRun plan-only、per-Bot 配额、runHistory 20 条截断、toAutomationSpec 桥接翻译（renderRoutinePrompt 装配持久规则与边界）。
- `routes.mjs`：registerBotsRoutes（/api/bots 精确花名册、/protocol 摘要、/relay/{kickoff,handoff,ack,<runId>}、/routines CRUD+test/enable/pause、/<memberId> profile）；精确子路径注册在前、memberId 处理器放最后，startsWith 派发无吞没。
- `docs/bot-collaboration-protocol.md`：协议文档（层模型、字段映射、Grok↔514cc 对照表、不采用清单、API 速查、事实来源）。

## 独立核验与修复（DELTA 见尾）

同模型泛型只读探子（Explore agent，任务卡限定五文件 + 直接依赖面）复核结论：1 致命 + 1 高危，均已修复并补安全回归：

1. **致命·automationRef 注入**（已修）：PUT 体可写 automationRef/testRun/runHistory → 跨资源删除/启用任意 automation。修复：normalizeRoutineInput 不读取内部字段（ROUTINE_USER_FIELDS/ROUTINE_INTERNAL_FIELDS 分离），automationRef 唯一写入通道 = setAutomationRef；测试断言伪造注入静默丢弃。
2. **高危·routine id 未校验**（已修）：create 接受任意 id 写盘，下次 init 的 validatePersistedStore 以 ID_PATTERN 拒绝 → store 整体读砖。修复：cleanRoutineId 入口即拒；测试断言 `../escape` / `has space` 被拒。
3. **建议·from 伪造署名**（已修）：kickoff/handoff 的 from 校验 roster 存在性（"lo" 放行）；测试覆盖。
4. **建议·readTail 128 窗口**：acknowledge/board 依赖尾部窗口，超窗历史 handoff 报 RELAY_HANDOFF_NOT_FOUND——协议文档已注明（窗口语义，非缺陷）。

探子确认无误面：统一 Bearer 门（server.mjs 全局 authorized）、runId/memberId/handle 白名单防穿越、serializeMutation 串行链、tmp+renameWithRetry+fsync 原子写、findSecretCandidates 拒密钥入库、AutomationStore/teamMembers 契约吻合。

## 验证

- `node scripts/run-tests.mjs tests/bots-{profiles,relay,routines,routes}.test.mjs`：**34/34**（含 HTTP 面契约：profile CRUD+成员投影、relay kickoff/handoff/ack/board、routine 全生命周期含 automation 桥接幂等/PUT 同步/DELETE 联动、子路径不吞没）。
- 存量回归 `tests/{bus-concurrency,bus-tail,automations,automations-at-schedule}.test.mjs`：**34/34**，无回归。
- `node --check`：server.mjs + 四个新模块语法通过。
- clean-exit 门通过（swept=0，无测试残留）。

## 诚实边界

- **未做真实运行验证**：未启动控制面正式实例做 HTTP 实测（本轮为隔离测试 + 契约层；UI 消费与真实 provider 试跑属下一步）。
- **未实现项**（协议文档 §6 不采用清单）：云计算机三态以外的 Grok 能力（Bot 创建 Bot、公开分享链接、Teach a task 录屏学习）按 v43/v44 边界不做；「从成功 run 保存为 skill」通道待后续提案。
- 本环境与 09-07 bot-collaboration-methods 波互补：那波是 orchestrator 内协作方法与过程渲染，本轮是 Grok Bot 式语义层 + API 面；两层共享 Grok Bot 参考不重复。
- 烛（Codex 对话桥）通道在本会话不可用（WorkBuddy 宿主无 codex-agent 工具）；独立核验以同模型泛型探子替代，不称异构 provider 实测。

__DELTA__: 泛型探子（Explore） | 1 | 证据：src/bots/routines.mjs normalizeRoutineInput 内部字段注入（致命，已修+回归）与 routine id 未校验致 store 读砖（高危，已修+回归）；relay.mjs from 署名未校验（建议，已修）。
