# 514cc v46 协作台产品与工程总计划

> 状态：项目经理审查建议，尚未批准执行
> 日期：2026-08-31
> 范围：514cc 全项目，重点为 `apps/control-center` 协作台、Bot/Conversation、Harness、运行与交付闭环
> 基线：当前脏工作区，只读审查；未重启正式 Tauri，未调用真实 provider/SSH，未 commit/push
> 证据等级：`source`=当前源码回读；`focused`=聚焦测试；`isolated`=隔离浏览器；`delivery`=Git/manifest；`formal`=正式桌面与真实外部能力

## 0. 项目经理结论

514cc 已经不是缺功能的原型，而是一个能力很强、产品主线被多轮功能波次掩埋的本地 AI 协作控制面。当前最重要的工作不是继续增加页面，而是把已有的 Project、Conversation、Run、native CLI session、TaskGraph、审批、证据、结算与交付能力收束成一条稳定的操作路径。

本轮建议的产品北极星是：

> 用户进入一个工作区，选择或创建 Conversation，明确目标、成员、权限和验收条件；系统把每次执行变成可介入、可恢复、可审阅、可交付的 Run，并在同一协作台内展示过程、证据和下一步。

建议采用以下产品决策：

1. `workbench` 继续作为默认操作主界面，符合 `D-2026-08-26-008`。
2. `bot` 不再长期演化为第二套产品，而作为“项目与对话库”的兼容入口，逐步迁入协作台左栏和统一 Conversation 投影。
3. 不重写现有 Node/REST/SSE 内核，不引入第二套消息、审批、TaskGraph 或 runtime。
4. 先统一协议与投影，再做大规模 UI 合并；先关闭交付红灯，再宣称阶段完成。
5. 借鉴 Codex harness 的重点是协议、生命周期、分页、背压、权限和 schema，不是复制视觉或 Rust 目录结构。
6. “DeepSeek Harness”没有已确认的 DeepSeek 官方唯一开源项目；只能分别引用 DeepSeek 官方 curated agent 集成清单和第三方 DeepSeek-TUI，禁止写成官方同一产品。

## 1. 当前证据基线

| 证据 | 2026-08-31 当前结果 | 判定 |
|---|---|---|
| Git | `main...origin/main [ahead 28]`，工作区 100+ 条修改/未跟踪 | dirty，不能发布 |
| 配置/注册表 | `npm run validate` 为 13 项全部 valid | source 契约通过 |
| UI lint | 6 类门禁通过，`inner-html=388 <= baseline 389` | 无新增 UI lint 债 |
| 聚焦协作测试 | Workbench/Bot/Mission/Permission 79/79 pass | focused 通过 |
| 全量测试 | 1911 total / 1895 pass / 14 fail / 2 skipped，clean-exit fail | regression 红灯 |
| Bot 浏览器 P0 | `npm run qa:bot-p0` 在隐藏 Conversation treeitem 等待处超时 | isolated 红灯 |
| 通用 UI QA | `npm run qa:ui` 因未传 URL 立即报 usage | npm 一键入口失效 |
| 交付清单 | tracked=460 / physical=478，18 个未跟踪 source/test，`formalRelease=no` | delivery 红灯 |
| 正式桌面 | 本轮未重启或回读 | formal 未验证 |
| 外部能力 | 本轮未做真实 provider/SSH/remote computer | formal 未验证 |

这组证据推翻“当前只剩继续加功能或做视觉抛光”的判断。当前顺序必须是：红灯收敛 -> 协议统一 -> 协作台合流 -> Harness 增强 -> 平台扩展 -> 正式发布。

## 2. 已有能力地图

以下能力应复用，不应重新实现：

| 域 | 已有真源/机制 | 当前边界 |
|---|---|---|
| 身份 | `ProjectRegistry -> ConversationStore -> Run -> native CLI session` | 多存储补偿仍可能进入 `TRANSACTION_INCONSISTENT` |
| 拓扑 | direct / workspace_group 服务端校验 | 前端存在 Workbench/Bot 双投影 |
| 编排 | Orchestrator、turn attempts、resume hints、Context Epoch | 文件巨石，真实 provider resume 矩阵未闭环 |
| 协作 | taskGraph、delegations、social opt-in、@成员 | task 128/edge 200 条截断，缺分页真源 |
| 介入 | steer、interrupt、Ask/Answer/ACK、approval、lease | 宿主 SDK 审批不由 514cc Broker 接管 |
| 证据 | EventStore、Bus、Mission Control、replay、handoff/DELTA | 多源读取缺统一 `asOfSequence` |
| 交付 | diff、settlement、releaseTruth、server-observed runner | remote settlement unsupported，formal release 未执行 |
| 配置 | Provider/Seat/Skill/MCP/Hook/Remote config | 功能多，入口密集，正式运行态与仓库源仍需分层 |
| 自动化 | schedules、channels、macros、weekly/monthly budget | 长跑、告警与依赖编排待闭环 |
| 设计 | Forge token、密度、占位组件、Lucide、UI lint | 断点、触控、modal/keyboard、双 surface IA 待收口 |

## 3. 外部参考与可借鉴边界

### 3.1 OpenAI Codex harness

当前官方资料：

- OpenAI Docs: <https://developers.openai.com/codex/app-server.md>
- 官方源码: <https://github.com/openai/codex/tree/main/codex-rs/app-server>
- 本轮源码主分支读回 commit: `2c8cfbf44f9cbe16f91d7630d21b501d3e2cf817`，2026-08-31 15:19:38Z；该值易漂移，只作为本轮快照。

值得吸收的机制：

| Codex 机制 | 514cc 映射 |
|---|---|
| Thread / Turn / Item | Conversation / Run / Event-Item |
| `initialize` + `clientInfo` | Control Center client handshake 与实例身份 |
| `thread/start/resume/fork` | Conversation 新建/续接/分支 |
| `turn/start/steer/interrupt` | Run admission/steer/interrupt |
| `item/started/delta/completed` | 统一工具、消息、文件变更事件 |
| 版本匹配的 TS/JSON Schema 生成 | REST/SSE/adapter schema 单一生成真源 |
| cursor pagination | 长 Conversation、TaskGraph、Event history 分页 |
| bounded queue + overload error | SSE/PTY/adapter 统一背压与可重试错误 |
| permission/sandbox/environment | 514cc permission profile + environment backend |
| instruction sources receipt | 显示本次 Run 实际加载的 AGENTS/Skill/Memory 来源 |

当前官方 App Server 文档已说明旧 `multiAgentMode` 被忽略，主动多 Agent 由 Ultra reasoning effort 驱动。因此 514cc 不应照搬一个已废弃的 `proactive` 开关；应保留自己的显式社会协作模式、预算、租约与服务端审计。

### 3.2 DeepSeek 相关开源生态

当前一手资料：

- DeepSeek 官方 curated list: <https://github.com/deepseek-ai/awesome-deepseek-agent>
- 官方清单中的第三方 DeepSeek-TUI 指南: <https://github.com/deepseek-ai/awesome-deepseek-agent/blob/main/docs/deepseek-tui.md>
- 第三方实现: <https://github.com/Hmbown/DeepSeek-TUI>

可以借鉴：Plan/Agent 权限分层、MCP client/server、项目/用户级 SKILL、hooks、child-agent lifecycle、超大输入用隔离 RLM/摘要处理、HTTP runtime API。

不能照搬：默认 YOLO/full-access、第三方项目的官方背书、未经固定 commit 的能力声明、把 1M context 当作无限上下文、把可派 agent 等同于可安全并发。

### 3.3 其他可用参考

| 产品 | 可借鉴点 | 不照搬点 |
|---|---|---|
| OpenHands | environment backend、自动化触发、开发者控制面 | 无 sandbox 不是默认安全方案 |
| Aider | repo map、lint/test feedback loop、Git 工作流 | 单 agent 交互不等于多 Agent 控制面 |
| OpenCode | Plan/Build 分层、显式子代理入口 | 活跃 dev 分支不当稳定协议 |
| SWE-agent | 任务/评测包、结果可比较 | benchmark 不替代真实产品运行态 |

## 4. 关键发现

### 4.1 P0 / 阻塞发布

1. 公开仓库历史中的代理 token 尚未完成轮换；先轮换再推送清理，历史重写另行授权。
2. `qa:delivery` 有 18 个未跟踪 source/test，`formalRelease=no`。
3. 全量测试仍有 14 个失败并触发 clean-exit gate，不能用 79/79 focused 覆盖。
4. Bot P0 隔离浏览器当前可复现 Conversation 行存在但被隐藏，测试等待超时。
5. `npm run qa:ui` 不是自足的一键 QA，package script 与脚本参数契约不一致。

### 4.2 P1 / 协作逻辑

1. `state` 与 `botState` 同时维护 runs、selection、events、settlement 和 Conversation 映射，导致同一 Run 需多条同步链。
2. taskGraph 在 Run JSON 内截断 tasks=128、delegations=200，长协作过程无法从 graph 真源完整恢复。
3. terminal Run 收敛会把未完成任务统一改为 skipped/failed/cancelled，缺少 never-started、aborted、lost、superseded 等审计语义。
4. Replay/Mission 并行读取 Run、Bus、Event、Approval、Health、handoff/DELTA，没有统一快照水位线。
5. 历史 API 使用固定 500/5000 尾部和 truncation flag，缺少 cursor continuation。
6. `/api/events` 是全局订阅；单用户本机可接受，但会阻塞未来 observer/team/RBAC 隔离。
7. Remote Run 明确 `remote-unsupported`，本机与远端没有统一结算模型。
8. `app.js` 32188 行、Orchestrator 6479 行、providers 3798 行，增量抽取刚开始，仍是主要回归放大器。

### 4.3 P1 / 产品与 UI

1. 主导航同时给出 Bot、协作台、团队、渠道，用户需要理解内部实现边界才能选入口。
2. Workbench 左栏同时出现团队树、会话、正在工作、归档、置顶；Bot 又有项目与对话树，信息重复。
3. Workbench composer 同屏暴露团队、CLI 控制台、模型、effort、权限、预算、附件、命令、协作者，首次任务决策负荷过高。
4. Bot 有多个独立 `aria-modal=true` 覆盖层，缺少统一 modal stack 与唯一 active owner。
5. Bot tree 有 role/level 声明，但上下左右/Home/End 的完整树键盘模型缺证据。
6. 390px Bot 设置仍是五列、每项最小 92px；composer hint 在所有尺寸都被 CSS 隐藏。
7. Workbench 三栏以 `216px minmax(420px,1fr) 288px` 为默认，平板需要真正的两栏/抽屉模式。
8. 当前 UI 分诊仍有 64 处非标准断点和 86 个明确偏小触控目标。

### 4.4 P2 / 治理与运维

1. v44 蓝图的 Git、版本、SSRF、路径、event hash、上传审计等状态已过期，继续按旧表执行会重复劳动。
2. `decisions.md` 已接近 4800 行，年度分卷和索引尚未完成。
3. 设计 lint 已建立，但 388 处 innerHTML、284 处 bare hex 仍需增量收敛。
4. 正式 provider/SSH/native resume/远端电脑的当前轮矩阵仍为空。
5. 事件哈希链缺进程外锚点，拥有写权限者仍可重算整链。

## 5. 协作台目标产品

### 5.1 唯一主旅程

1. 选择项目或 Conversation。
2. 明确目标、成功标准、目标成员、权限、预算和环境。
3. 预览执行计划与风险。
4. 发起 Run，实时看到消息、任务、工具、文件变更和委派。
5. 在等待、审批、提问、恢复时由单一 Attention Strip 接管。
6. Run 结束后审阅 diff、测试、证据和残余风险。
7. 显式选择继续、分支、重试、结算、提交或推送。

### 5.2 信息架构

建议把 14 个平级视图收敛成 5 个顶层工作域：

| 顶层 | 内容 | 当前视图映射 |
|---|---|---|
| 工作 | 协作台、项目、Conversation、成员 | workbench + bot + team |
| 自动化 | 定时、Webhook、队列、报告 | automations + channels |
| 资源 | Provider、Seat、Skill、MCP、Host、市场 | config + hosts + market |
| 观测 | 运行、会话、成本、DELTA、健康 | overview + observability + sessions |
| 治理 | 权限、审批、安全、发布 | security + release/settlement surfaces |

旧 hash 保留为兼容深链，顶层导航不再把内部 surface 全部平铺。

### 5.3 协作台布局

桌面 >= 1280：

- 左栏 248-288px：项目 / Conversation / 成员三个互斥 tab，支持搜索、置顶、归档、未读。
- 中栏：唯一消息和工作时间线，工具/委派/审批作为 Item 类型，不再另起重复消息流。
- 右栏 320-400px：Context Inspector，默认收起，包含任务、成员、文件、证据、环境、结算。
- 顶部：项目 > Conversation > Run breadcrumb、运行态、一个最高优先级 Attention 入口。
- 底部：渐进式 composer；首屏只展示目标、权限和发送，模型/effort/预算放“运行设置”。

平板 700-1279：

- 左栏 + 中栏两列；右 Inspector 作为 drawer。
- 打开 drawer 时主工作面 inert，宽度 44-52vw。
- Composer 次级设置折叠为一行 chips，不保持完整 CLI 控制台常驻。

移动 <= 699：

- 单 surface；会话列表、Conversation、详情互为全屏层。
- Header 只保留返回、标题/状态、详情。
- Composer 固定安全区，附件横向滚动，发送/停止保持 44px 触控面积。
- 设置使用两行网格或可滚动 tab，active 自动进入视口。

### 5.4 状态模型

统一用户态：`idle / queued / running / waiting_user / waiting_approval / recovery_required / blocked / succeeded / failed / cancelled`。

任务态补充：`not_started / running / waiting / succeeded / failed / cancelled / skipped / superseded / lost`。

所有颜色必须同时有 icon + 文本；技术原值进入折叠详情，用户主标签统一中文。

## 6. 目标工程架构

```text
Identity Domain
  ProjectRegistry + ConversationStore + Team/Member
        |
Run Control Domain
  admission + state machine + attempt/session ownership + approval/recovery
        |
Append-only Work Domain
  Event Item + TaskGraph transitions + Evidence references
        |
Projection Domain
  ConversationRunProjection + Attention + Mission + Settlement
        |
Transport Domain
  versioned REST/SSE now, optional JSON-RPC facade later
        |
UI Surfaces
  Workbench default + compatibility deep links
```

关键工程决策：

1. 新增 `ConversationRunProjection`，成为 Workbench/Bot 的共享只读模型。
2. taskGraph 从 Run 内有界数组迁移为 append-only transition log + indexed current view。
3. `EvidenceIndex` 强制绑定 `projectId + conversationId + runId + attemptId + eventSequence + worktreeDigest`。
4. Replay/Mission/Settlement 返回 `asOfSequence`，所有辅助源声明观测水位。
5. 历史接口统一 cursor pagination，truncated 只作为异常/保留策略提示。
6. SSE 事件 envelope 版本化：`epoch + sequence + schemaVersion + scope`。
7. 先生成 JSON Schema/TypeScript types，再考虑 JSON-RPC facade，禁止一轮重写 REST。
8. environment backend 统一 local workspace、git worktree、SSH、容器/VM 的能力与证据。
9. 前端视图模块只消费 projection，不拥有服务端生命周期判断。
10. app.js 按“projection selector -> view controller -> DOM primitive”渐进拆分，保持原生 ESM。

## 7. 功能与设计 Backlog

状态说明：`闭环`=已有能力补齐正式证据；`补强`=扩展已有机制；`新增`=新能力。优先级不代表立即全做，必须按第 8 节波次进入。

### 7.1 协作核心 CW-01 ~ CW-20

| ID | 类型 | P | 功能点 | 验收摘要 |
|---|---|---|---|---|
| CW-01 | 补强 | P0 | Workbench/Bot 统一 ConversationRunProjection | 同一 run 在两表面字段一致 |
| CW-02 | 补强 | P1 | Bot 项目/对话库迁入 Workbench 左栏 | `#bot` 保留兼容且无双状态 |
| CW-03 | 新增 | P1 | Conversation fork/branch | 可从指定 Run/Item 分支，不复制目录 |
| CW-04 | 新增 | P1 | Conversation goal + success criteria | Run/结算均显示验收目标 |
| CW-05 | 新增 | P1 | 用户消息队列的增删改排 | idle 后 FIFO，稳定 submissionId |
| CW-06 | 补强 | P0 | TaskGraph append-only transition store | 1000+ task/edge 可分页回读 |
| CW-07 | 补强 | P1 | 精细任务终态 | 区分 skipped/cancelled/lost/superseded |
| CW-08 | 补强 | P1 | 委派 lease 与 parent/child ownership | child 超时/取消不会漂移归属 |
| CW-09 | 新增 | P1 | 冲突仲裁器 | 多 Agent 冲突可比较、投票、升级 LO |
| CW-10 | 补强 | P1 | 结构化 handoff package | 结论、证据、风险、下一步可复用 |
| CW-11 | 新增 | P2 | Run bookmark/checkpoint | 可标记关键事件并生成链接 |
| CW-12 | 新增 | P1 | Run compare / shadow run UI | 同任务不同模型对比结果/成本/证据 |
| CW-13 | 补强 | P1 | Attention 单队列 | Ask/Approval/Recovery/Settlement 不互盖 |
| CW-14 | 新增 | P2 | 跨项目任务总览 | 只读展示队列、阻塞、预算和 SLA |
| CW-15 | 补强 | P1 | Conversation history cursor pagination | 10 万 Item 不全量注入浏览器 |
| CW-16 | 补强 | P1 | Conversation archive/retention | 归档、恢复、墓碑、物理清理分层 |
| CW-17 | 新增 | P2 | Conversation template/recipe | 评审->修复->验证->交付一键装载 |
| CW-18 | 补强 | P1 | 明确 recipient 与 orchestration policy | 发送前可见 direct/pipeline/social |
| CW-19 | 新增 | P2 | 运行中动态 replan | 保留原计划版本和变更原因 |
| CW-20 | 补强 | P1 | 跨 CLI context package | 摘要+引用迁移，不伪称 session 无损 |

### 7.2 Harness 与运行时 HX-01 ~ HX-15

| ID | 类型 | P | 功能点 | 验收摘要 |
|---|---|---|---|---|
| HX-01 | 新增 | P1 | client initialize/clientInfo handshake | UI/CLI/automation 客户端身份可审计 |
| HX-02 | 补强 | P1 | 版本化协议 envelope | 未知版本 fail-closed |
| HX-03 | 新增 | P1 | TS/JSON Schema 自动生成 | 服务端、前端、adapter 同一真源 |
| HX-04 | 补强 | P1 | Item lifecycle 统一 | message/tool/file/approval 都有 started/completed |
| HX-05 | 补强 | P1 | 统一背压错误与 retry-after | SSE/PTY/provider 不静默丢事件 |
| HX-06 | 补强 | P1 | permission reason taxonomy | shell/network/MCP/skill/file/remote 可区分 |
| HX-07 | 补强 | P1 | environmentId + runtime roots | 每个 Run 固化环境能力边界 |
| HX-08 | 补强 | P1 | Plan/Review/Build 服务端 profile | UI 切换不能自行扩权 |
| HX-09 | 新增 | P2 | approval reviewer 独立层 | auto-review 只建议，人类可兜底 |
| HX-10 | 补强 | P1 | instruction source receipt | Run 可见实际 AGENTS/Skill/Memory/hash |
| HX-11 | 补强 | P1 | context budget ledger | 每类上下文 cap、摘要、引用可见 |
| HX-12 | 新增 | P2 | oversized input worker/RLM | 大文档隔离处理，不污染主线程 |
| HX-13 | 补强 | P1 | Adapter conformance suite | enabled adapter 全部过 start/resume/interrupt |
| HX-14 | 补强 | P1 | terminal/background process registry | list/terminate/cleanup 有归属和回执 |
| HX-15 | 新增 | P2 | 稳定 SDK/CLI automation facade | CI 可无 UI 驱动受治理的 Run |

### 7.3 协作台 UI/UX UX-01 ~ UX-20

| ID | 类型 | P | 功能点 | 验收摘要 |
|---|---|---|---|---|
| UX-01 | 补强 | P1 | 5 顶层工作域 IA | 旧 14 view 仍可深链 |
| UX-02 | 补强 | P1 | 左栏项目/对话/成员 tab | 不重复渲染同一 Conversation |
| UX-03 | 补强 | P1 | 单一消息+工作时间线 | 工具/委派不另建重复流 |
| UX-04 | 补强 | P1 | Context Inspector 右抽屉 | 开关不改变中栏宽度/滚动 |
| UX-05 | 补强 | P1 | Attention Strip | 一次只显示最高优先动作 |
| UX-06 | 补强 | P1 | 渐进式 Composer | 默认只暴露目标/权限/发送 |
| UX-07 | 新增 | P2 | 发送前 Run preview | 成员、环境、预算、写权限可核对 |
| UX-08 | 补强 | P1 | stage/status stepper | 计划/执行/验证/结算状态可扫描 |
| UX-09 | 补强 | P1 | Tool/File/Approval Item cards | 输入输出有界、脱敏、可折叠 |
| UX-10 | 补强 | P1 | Run diff + evidence split view | 文件、测试、证据一键联动 |
| UX-11 | 补强 | P1 | Tablet 两栏 + drawer | 820/1024 中栏可读宽度达标 |
| UX-12 | 补强 | P1 | Mobile 单 surface | 390px 无重叠/横向溢出 |
| UX-13 | 补强 | P1 | 统一 modal/drawer stack | 唯一 active、inert、Esc、回焦 |
| UX-14 | 补强 | P1 | Tree 完整键盘模型 | Up/Down/Left/Right/Home/End |
| UX-15 | 补强 | P1 | Combobox/listbox primitive | activedescendant/selected/escape 完整 |
| UX-16 | 补强 | P1 | Live region 降噪 | 一次状态变化只播一次 |
| UX-17 | 补强 | P2 | 中文主标签+技术副标签 | ready 等内部值不直出主 UI |
| UX-18 | 补强 | P2 | 触控目标 44px 关键路径 | 86 个明确小目标清零 |
| UX-19 | 补强 | P2 | 断点收敛和容器约束 | 标准档+有意互斥档有清单 |
| UX-20 | 补强 | P2 | Screenshot + a11y visual regression | 1440/1024/820/390 明暗主题 |

### 7.4 平台与扩展 PL-01 ~ PL-15

| ID | 类型 | P | 功能点 | 验收摘要 |
|---|---|---|---|---|
| PL-01 | 补强 | P1 | 自动化依赖图与并发策略 | DAG、重试、超时、幂等可视 |
| PL-02 | 新增 | P2 | Workflow recipe 市场 | 签名、版本、权限清单、回滚 |
| PL-03 | 补强 | P1 | GitHub/GitLab issue/PR 工作流 | 最小 scope token + 审批门 |
| PL-04 | 补强 | P2 | IDE/Cursor/VS Code 深链 | Conversation/Run/file 精确跳转 |
| PL-05 | 补强 | P1 | Environment backend registry | local/worktree/SSH/container/VM |
| PL-06 | 新增 | P2 | Docker sandbox backend | 资源限制、网络策略、清理回执 |
| PL-07 | 补强 | P1 | Remote settlement | 远端 diff/evidence/commit plan 可审计 |
| PL-08 | 新增 | P2 | Desktop notifications/tray attention | waiting/approval/failure 可配置 |
| PL-09 | 补强 | P2 | Outbound webhook event subscriptions | HMAC、重放保护、目标白名单 |
| PL-10 | 补强 | P1 | Plugin/Skill/MCP 签名信任根 | 未签名/越权 manifest 被拒 |
| PL-11 | 补强 | P2 | 本地模型与 OpenAI-compatible backend | capability probe + 限权 |
| PL-12 | 新增 | P2 | 全量数据可携带性 | 配置/会话/记忆/证据导出导入 |
| PL-13 | 新增 | P3 | 安全远程访问 | 强认证、TLS/隧道、设备撤销 |
| PL-14 | 补强 | P2 | Office/报告产物流水线 | 文档实际渲染证据入 settlement |
| PL-15 | 新增 | P2 | Multi-workspace switcher | 独立 dataRoot/lock/token/最近项目 |

### 7.5 观测、证据与成本 OB-01 ~ OB-12

| ID | 类型 | P | 功能点 | 验收摘要 |
|---|---|---|---|---|
| OB-01 | 补强 | P1 | 全链路 trace id | Run->attempt->provider->tool->PTY |
| OB-02 | 补强 | P1 | event cursor + asOfSequence | Replay/Mission/Settlement 同水位 |
| OB-03 | 补强 | P1 | EvidenceIndex | 证据强绑定 run/attempt/digest |
| OB-04 | 补强 | P1 | 预算与成本 UI | project/member/provider/run 归集 |
| OB-05 | 新增 | P2 | SLA 与队列等待趋势 | 首响/完成/等待用户分开统计 |
| OB-06 | 补强 | P1 | recovery/retry audit | 每次重试原因、费用、session 可见 |
| OB-07 | 补强 | P1 | event/artifact retention quota | 预警、归档、清理可回滚 |
| OB-08 | 补强 | P2 | event chain 外部锚点 | 周期签名摘要写到独立位置 |
| OB-09 | 补强 | P2 | Adapter health history | 当前、趋势、最近故障与证据 |
| OB-10 | 新增 | P2 | Crash support bundle | 脱敏状态+日志尾+最近事件 |
| OB-11 | 补强 | P1 | Release evidence dashboard | source/focused/full/delivery/formal 五层 |
| OB-12 | 新增 | P2 | 可配置告警规则 | route/DELTA/cost/disk/provider 异常 |

### 7.6 安全与治理 SG-01 ~ SG-10

| ID | 类型 | P | 功能点 | 验收摘要 |
|---|---|---|---|---|
| SG-01 | 闭环 | P0 | 公开 token 轮换与远端清理 | 旧 token 失效，远端路径不可读 |
| SG-02 | 补强 | P1 | SSE/API scope authorization | observer/team/project 事件不越界 |
| SG-03 | 补强 | P1 | approval TTL/revoke/CAS | 过期、代际、action hash 一致 |
| SG-04 | 补强 | P1 | DNS pinning/TOCTOU 收口 | 请求连接到已验证 IP |
| SG-05 | 补强 | P1 | environment capability manifest | 文件/网络/命令/remote 最小权限 |
| SG-06 | 补强 | P1 | effective instruction audit | prompt 注入来源和覆盖顺序可见 |
| SG-07 | 新增 | P2 | 数据分级与保留策略 | secret/private/audit/public 明确 |
| SG-08 | 新增 | P2 | 多用户/RBAC 预留 | 在启用远程访问前完成隔离 |
| SG-09 | 补强 | P2 | 自动红队任务包 | 注入/越权/SSRF/路径/泄密定期跑 |
| SG-10 | 补强 | P1 | 危险操作统一 confirmation plan | 动作、范围、风险、回滚、hash 齐全 |

### 7.7 工程质量 EQ-01 ~ EQ-13

| ID | 类型 | P | 功能点 | 验收摘要 |
|---|---|---|---|---|
| EQ-01 | 闭环 | P0 | 全量测试 0 fail + clean exit | 连续 5 次通过，记录 flaky |
| EQ-02 | 闭环 | P0 | 修复 Bot P0 浏览器隐藏行回归 | 四视口、深链、tree visibility 通过 |
| EQ-03 | 闭环 | P1 | 修复 `npm run qa:ui` 一键入口 | 自动起隔离 server 或提供明确 script |
| EQ-04 | 补强 | P1 | fast/contract/browser/full/release 分层 | 每层命令、时限、责任明确 |
| EQ-05 | 补强 | P1 | deterministic fixture/temp cleanup | ENOENT/EPERM/端口/句柄波动可定位 |
| EQ-06 | 补强 | P1 | app.js 视图级 ESM 抽取 | 每刀小 diff，调用方契约不变 |
| EQ-07 | 补强 | P1 | Orchestrator 领域拆分 | control/session/task/evidence/recovery |
| EQ-08 | 补强 | P1 | providers registry/stream/probe 拆分 | adapter contract 全绿 |
| EQ-09 | 补强 | P2 | typed DTO/schema boundary | 禁止 UI 猜字段和状态 |
| EQ-10 | 补强 | P2 | 性能预算 | 首屏、长时间线、SSE、内存有阈值 |
| EQ-11 | 补强 | P1 | fresh-clone smoke | HEAD 新 checkout 可启动/validate/test |
| EQ-12 | 补强 | P1 | migration/version manager | store schema 升级/回滚/损坏 fail-closed |
| EQ-13 | 闭环 | P0 | delivery/formal release gate | 18 drift 清零，正式实例同提交四证 |

## 8. 执行波次

### Wave 0：红灯清零，1-2 天

目标：重新取得可信基线，不做新功能。

1. SG-01：轮换公开 token；推送清理需 LO 授权，历史重写单独决策。
2. EQ-01/EQ-02/EQ-03：收敛全量 14 fail、Bot P0 超时和 qa:ui 一键入口。
3. EQ-13：18 个 delivery drift 逐项归属，禁止 `git add -A`。
4. 复跑 validate、ui:lint、focused、full、Bot browser、delivery。

退出门：测试 0 fail、clean-exit ok、Bot 四视口通过、delivery drift=0；formal 仍可保持 false，但必须诚实。

### Wave 1：协议与投影地基，4-6 天

目标：让 Workbench/Bot 消费一个状态模型。

1. CW-01、HX-02、HX-03：定义 ConversationRunProjection 与版本化 schema。
2. OB-01/OB-02/OB-03：trace、asOf、EvidenceIndex。
3. CW-06/CW-07/CW-15：TaskGraph transition + cursor history。
4. 先写兼容 adapter，旧 REST/SSE 行为保持；不同时改 UI。

退出门：旧/新 projection 对同一 fixture 深比较一致；1000 task/10000 event 分页不丢序；未知 schema fail-closed。

### Wave 2：协作台合流，5-8 天

目标：把默认 Workbench 变成唯一操作主线。

1. UX-01~UX-10：IA、左栏、时间线、Inspector、Attention、渐进 Composer。
2. CW-02：迁入 Bot 的项目/Conversation 能力，`#bot` 做兼容入口。
3. EQ-06：只抽取本波触及的视图 controller，不做大爆炸重构。

退出门：新建项目->Conversation->Run->审批/提问->diff/结算全程不离开 Workbench；同一 Run 无双投影差异。

### Wave 3：多形态与 Harness，5-8 天

目标：补齐 Codex-style 生命周期与可靠交互。

1. HX-01、HX-04~HX-14。
2. UX-11~UX-20。
3. CW-03/CW-05/CW-08/CW-13。

退出门：resume/fork/steer/interrupt、背压、审批、环境、键盘、读屏、四视口均有机械测试。

### Wave 4：工程解耦与正式运行，5-10 天

目标：降低巨石风险并完成正式证据。

1. EQ-07/EQ-08/EQ-09/EQ-10/EQ-11/EQ-12。
2. 真实 Claude/Codex/Grok/Kimi/Pi adapter start/resume/interrupt 矩阵。
3. 真实 SSH UTF-8、TERM/KILL、远端 diff/settlement。
4. 从不可变提交启动正式 Tauri，执行 server-observed runner。

退出门：source/focused/full/browser/delivery/formal 五层均可回读，不能用 operator-attested 替代 server-observed。

### Wave 5：可选拓展，按价值逐项批准

优先推荐 PL-03、PL-05、PL-07、PL-08、PL-10、PL-12；其余在核心旅程和正式发布稳定后进入。

## 9. Top 20 执行顺序

1. SG-01 公开 token 轮换。
2. EQ-01 全量测试 14 fail 归因并清零。
3. EQ-02 Bot P0 隐藏 Conversation 回归。
4. EQ-03 qa:ui 一键入口。
5. EQ-13 delivery drift 与正式发布门。
6. CW-01 统一 ConversationRunProjection。
7. HX-02/HX-03 版本化 schema 与生成物。
8. OB-01/OB-02 trace + asOfSequence。
9. OB-03 EvidenceIndex。
10. CW-06 TaskGraph transition store。
11. CW-15 历史 cursor pagination。
12. UX-01 顶层 IA 收口。
13. UX-02 左栏合流。
14. UX-03 单一时间线。
15. UX-05 Attention Strip。
16. UX-06 渐进式 Composer。
17. UX-11/UX-12 平板与移动布局。
18. UX-13~UX-16 a11y primitive 与 modal stack。
19. EQ-06~EQ-08 巨石渐进拆分。
20. PL-07 + Wave 4 正式 provider/SSH/remote settlement。

## 10. 验收指标

| 指标 | 目标 |
|---|---|
| 首次创建可执行 Run | 新用户 90 秒内，不超过 5 个显式决策 |
| Conversation 可达性 | 任意已有 Conversation <= 2 次操作，支持稳定深链 |
| 注意力处理 | Ask/Approval/Recovery/Settlement 从任意工作面 1 次操作可达 |
| 状态一致性 | Workbench/Bot/Replay/Mission 对同一 Run 关键字段 0 漂移 |
| 历史规模 | 10 万 Item/1000 task 可分页，无全量加载与序列缺口 |
| 断线恢复 | 10 万事件、慢消费者、重启 epoch 场景 0 静默丢失 |
| 回归 | full 0 fail，clean exit；关键套件连续 5 次无 flaky |
| 响应式 | 1440/1024/820/390 明暗主题无重叠、横向溢出、文字裁切 |
| a11y | tree/tab/menu/combobox/modal 全键盘闭环，live region 无重复播报 |
| 性能 | 首屏压缩资产、长会话滚动、SSE heap、后台空闲均有预算 |
| 交付 | source/focused/full/browser/delivery/formal 五层可独立回读 |
| 安全 | secret audit 0 critical，审批/环境/远程动作均有 action hash 与回滚说明 |

## 11. 已过期或不应重复执行的旧建议

1. v44 中“无 remote、单提交、版本仍 v3.5”的状态已被后续修复。
2. v44 中从零实现 SSRF、路径穿越、event hash、上传 magic-byte、密钥审计、脱敏契约的建议已过期；只做残余增强。
3. “Bot 必须默认启动”已被正式决策 supersede；当前默认是 Workbench。
4. “引入 esbuild”已被原生 ESM 渐进拆分方向取代；不重新争论打包器，除非性能数据证明必要。
5. Inbox 已不再只读，不从零实现 Ask/Answer/ACK。
6. party-mode、bus/inbox schema、budget backend、route signal externalization 已有实现或部分实现，不重复造轮子。
7. 不把 focused green、静态截图、HTTP 200 或进程启动单独写成正式完成。

## 12. 需要 LO 拍板的决策

1. 是否按推荐路线把 Bot 逐步合入 Workbench，并保留 `#bot` 兼容深链？推荐：是，分三波迁移。
2. 是否批准 token 轮换和普通 push？历史重写/force push 必须另行单独确认。
3. 是否批准 Wave 0 清零后从不可变提交重启正式 Tauri 并跑 formal runner？
4. Remote settlement、IDE/PR integration、plugin trust root 三项中，Wave 5 首选哪两项？推荐前两项先做。
5. 是否接受“DeepSeek-TUI 仅作第三方参考，不称 DeepSeek 官方 Harness”的公开口径？推荐：接受。

## 13. 风险控制

1. 当前工作区并行改动极多，任何实现波必须显式 pathspec/manifest，禁止 reset/checkout/clean 覆盖未知改动。
2. Wave 1 协议兼容层与 Wave 2 UI 合流不能同时大改同一文件；先 schema/projection，后 view。
3. TaskGraph/Event migration 必须支持旧 store；损坏和不明版本 fail-closed，不能自动覆盖。
4. 真实 provider、凭据、SSH、正式桌面重启、commit/push 均按各自确认门执行。
5. 竞品事实易漂移；OpenAI Docs、DeepSeek 官方 curated list 与第三方源码必须分别标注访问日期和来源层级。

## 14. 本轮证据坐标

- `rules.md:20-28,44-63,97-104`
- `.ai-shared/context.md:140-166,168-209`
- `.ai-shared/decisions.md:4397-4644,4692-4737,4741-4773`
- `apps/control-center/public/state.js:114-180`
- `apps/control-center/public/app.js:17271-17338,18554-18624`
- `apps/control-center/public/index.html:453-639,680-1069`
- `apps/control-center/public/modules/nav-config.js:17-40`
- `apps/control-center/public/forge/bot-shell.css:67,606,919-982`
- `apps/control-center/public/forge/workbench.css:567-581,597-599,723-726`
- `apps/control-center/src/orchestrator.mjs:1773-1939`
- `apps/control-center/server.mjs:2545-2648,2940-3100`
- `apps/control-center/src/run-settlement.mjs:70-200`
- `apps/control-center/package.json:9-36`
- `proposals/ui-ux-audit-plan.md:178-276`
- `proposals/ui-triage-report.md:1-195`
