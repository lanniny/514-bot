# 当前任务上下文（活跃状态）

> 协作体系的"短期记忆"。每个 Agent 接入时**先读这里**。
> 由 Claude 主驾维护。最后更新：**2026-08-30**（Git 证据链已接回 `origin/main`；2026-08-19~29 波次已入版本库；仓库为 GitHub **公开**仓库且存在已泄露凭证，见「当前风险」）。
> 本文件只存稳定事实和当前风险；逐轮实现史、测试计数与运行时快照分别进入 `decisions.md`、handoff 和当轮验证输出。
>
> **⚠️ 2026-08-30 更正**：此前若有人认为"远程证据链断裂"或"快照 `2b1892c` 不存在"，该判断**已证伪**。
> 远程 `origin/main` 历史完好（20 个提交，`2b1892c` 确在其中）。真实故障是**本地 `.git` 被重新 init 过**：
> 历史被压成单提交 `603056d`、未配置 remote、且把 1491 个运行时产物误纳入追踪。
> 现已通过 `reset --mixed 6bb3691` + 两笔提交接回，本地领先远程 2 笔、落后 0 笔。

## 主人信息

- **协作偏好**：内置 `team-514cc` 默认由 Claude 做规划和总协作、Codex 做技术执行与独立评审；Control Center 自定义团队不固定主脑
- **响应语言**：简体中文
- **操作系统**：Windows 11 + PowerShell 7

## 当前项目

- **项目名**：514cc
- **工作目录**：`I:\514claude\514cc`
- **远程仓库**：`origin` → `git@github.com:lanniny/514-bot.git`（GitHub，**公开仓库**，默认分支 `main`）
- **推送前置检查**：任何 push 前必须确认「无含凭证文件进入暂存区」且「工作树干净」；公开仓库一旦推送即视为永久公开
- **项目类型**：Skill 驱动的 AI 能力放大系统
- **技术栈**：Markdown SKILL.md + TOML customize + YAML module.yaml + Node.js Console + Python 配置校验
- **正式版本真源**：`rules.md` §八 + `CHANGELOG.md` 最新条目；其他入口必须由 `npm run validate` 做一致性检查

## 体系架构

```
Layer 1: 团队主脑与总协作（内置默认 Claude Fable；自定义由 coordinator 决定）
Layer 2: Skill 体系（14 Claude skill + 7 Codex skill）+ harness hooks
Layer 3: 异构执行与独立验证（Codex + Grok + Kimi + Pi）
Layer 4: 最小治理（rules.md + module schema + guardrails）
```

### 命名 Agent

| 名 | 职 | 驱动边界 |
|---|---|---|
| 烛 | 代码守夜人 / 技术执行官 | Codex |
| 织 | 情报编织者 | Grok + Web MCP |
| 匠 | 嵌入式领域诊断 | Claude |
| 策 | 规格与架构拆解 | Claude |
| 鉴 | 体系审计（只读） | Claude |

Console 另有 Grok Build、Kimi 前端和 Pi resident 等执行 profile；它们是运行面能力，不改写 5 个命名 Agent 的治理角色。Gemini profile 保留但当前禁用。

## 稳定能力

- route-gate / stop-gate / mirror-gate 三个 harness hook 的仓库源位于 `.claude/hooks/`。
- Claude↔Codex 对话桥支持 `codex` / `codex-reply` 多轮线程，降级通道为 `codex exec resume`。
- `apps/control-center` 提供本地配置、路由、观测、会话、自动化和协作控制面。
- `module.yaml` 登记所有仓库 skill 与 Console adapter；`schemas/module.schema.json` 和仓库集合差检查负责阻止注册表漂移。
- 仓库已是 Git 工作树；并行 agent 可能同时修改文件，禁止用 reset/checkout 覆盖未知改动。

### 2026-07-24 活跃波次

- Codeg/LiveAgent 深度融合：**Wave H→K** 已落地（前端跃迁、Lease/taskGraph/SSE epoch、模块化、remote-gates 门闩、resume 命令可见、Evidence 可导航）。方案：`proposals/v39-wave-h-frontend-multicli.md`、`v39-wave-ijg-kernel-modules-gates.md`、`v39-wave-k-ui-evidence.md`。不得宣称上游 1:1 或远程能力已上线。

### 2026-07-25 活跃波次

- **v4.0 Forge 深度收口**（Kimi 主驾）：Forge 设计系统（`public/forge/`）、团队旗舰视图 `#/team`、统一搜索/记忆/脚手架后端、DELTA 契约修复、CSP 零违规、零 emoji + Lucide 85 图标统一。测试 446/0 fail，validate 12/12。KaTeX/Mermaid 实时渲染与进程监管 UI 为已知增强债。
- **Wave G 五面门闩开放**（Kimi 主驾，LO 2026-07-25 授权全做）：PTY 终端/Office 文档/渠道（Telegram+Webhook）/SSH·SFTP/市场五面后端 + 前端五视图全落地，remote-gates 授权账本 7 门（gateway/remote_web 仍封锁）；IA 重组 5 组 16 项；codeg UI 移植（磨砂族/折叠/kbd/highlight.js vendored 23 语言/可拖分栏）；G4 协作星图 `#/hero`（物理布局 + 实验排版 + roster/runs 真实数据驱动，reduced-motion 降级）。测试 480/0 fail，validate 12/12，截图 21 站明暗 0 控制台错误。增强债：Lark/微信、Office 预览、SSH 隧道、自托管字体、KaTeX/Mermaid vendored。

### 2026-07-27 活跃波次

- **CC-Switch 3.18.0 完整迁移**：以 `.scratch/cc-switch/cc-switch-3.18.0/` 为上游审计源，固定注册表 SHA-256 `50f6b4ec0c072d70d1cc2d7c3d811f68f15e9fa9b8e7c734fbc8f8c5a7d82c6c`；288 个入口由机械账本覆盖，其中 157 equivalent、128 adapted、3 blocked_external_trust。迁移面包括八应用 ProviderStore、代理/故障转移/用量、Prompt/MCP/Skill/Profile/备份、WebDAV/S3、OAuth、OpenClaw/Hermes workspace、深链和桌面原生桥。
- 桌面壳已补 Tauri remote-origin ACL：只有 `main` 窗口的 `http://127.0.0.1:51400/*` 可调用 11 个显式 native commands，`local=false`；命令清单同时驱动 build-time AppManifest，并由 Rust 回归检查 capability 与 `invoke_handler` 漂移。最终 release 产物位于 `apps/desktop/src-tauri/target/release/cc-desktop.exe`。
- **配置图谱融合**：原独立能力图谱与配置界面合并为唯一 `配置图谱`，内部以 `供应商与应用 / Agent·Skill·MCP / 真源与运行时` 三个互斥工作面承载；旧 `#capabilities` 仅作兼容别名。Skill/MCP 到真源使用后端精确 `sourceId`；MCP/Skill 降级相互隔离；Provider/CC-Switch 刷新、深链 FIFO、真源 latest-wins 与脏草稿保护均有机械回归。证据见 `codex-to-claude__config-topology-fusion__20260727-1640.md`。
- **团队工作区融合**：团队启用、团队设置、成员/主脑/Skill/MCP/供应商绑定与运行席位、协作流、热力图统一进入唯一 `#/team`；浏览和显式选用解耦，写后 fresh、脏草稿与目录降级均有机械竞态回归。证据见 `codex-to-claude__team-workspace-fusion__20260727-2110.md`。

### 2026-07-28 活跃波次

- **成员库与三域身份**：逻辑成员来自 `TeamMemberStore`；内置成员由 runtime catalog 投影，自定义成员持久化到 `team-members.json`。团队与会话使用 `memberId`，路由和 adapter 查找使用 `runtimeProfileId`，协议实现由 `adapter.id` 标识；绑定链固定为 `memberId -> runtimeProfileId -> adapter.id`。
- **自定义团队与主脑**：新建团队草稿可从空成员、空主脑开始，但保存时必须至少包含一名可执行逻辑成员，且主脑必须是其中任一 `coordinatorEligible` 成员。Claude 可完全移除；成员 CRUD、团队 CRUD、成员加入/移出团队和任意合格主脑均已接线。缺命令、disabled、fallback、未接线 profile 或不可验证的团队引用状态均 fail-closed。
- **成员级运行配置与深链**：成员独立保存名称、职责、简介、提示词、能力、`defaultModel/defaultEffort` 与 runtime binding；run 固化 `teamRosterVersion: 1` 和成员快照。同一 runtime profile 可承载多个逻辑成员及各自独立 session；`#/team` 成员库可深链到唯一配置图谱的 `control.models` 或按 `memberId` 聚焦 Skill 矩阵列。证据见 `codex-to-claude__team-member-library__20260728-0657.md`。

### 2026-08-02 ~ 08-03 活跃波次

- **v4.0 团队协作逻辑完善**：health 独立轨道（快源 3.5s 首屏 + health 12s 补载）、派工建议感知席位状态（跳过 offline、busy/degraded chip）、建议卡一键采用、健康补载保输入。测试 650/0 fail。
- **团队配置便利层**：预设模板（研发攻坚/评审/研究写作/全栈混编四套）、团队包导出/导入（自定义成员随包 + 孪生复用 + 重名避让）、目录竞态守卫（轮询 12s 等待）。测试 656/0 fail。
- **成员配置页面完善**：使用情况区块（引用团队 chip + 删除前置说明）、品牌头像 + 徽章（主脑可任/团队 n）、简介/提示词字数实时计数。测试 656/0 fail。
- **v4.0 团队协作逻辑完善波**：成员分组/成员库/席位配置/串流 chrome 四波，测试 646/0 fail → 656/0 fail。
- **Grok Build CLI 升级修复**：`~/.grok/bin` 0.2.118 读回 + 本机契约验证。
- **CLI 环境面板**：v4.0 CLI 环境面板（env 面板、kimi stale env fallback）。

### 2026-08-04 ~ 08-05 活跃波次

- **Composer 目标 CLI 对齐**：`apps/control-center` 的 composer 视图对齐 Codex 目标 CLI 参考图（入口/标签/骨架）。
- **团队范围侧栏收口**：团队过滤下的侧栏项目树正确显示，已修复未归属项目被过滤的缺陷。
- **协作 Console 加固**：观察性/会话/路由面板的稳定性修复。

### 2026-08-07 ~ 08-08 活跃波次

- **Codex 桌面环境舱对齐**：环境舱按参考图重排（变更/本地/分支/提交或推送/PR），可展开行、内联刷新、头像堆叠、来源 ➕、分组默认展开。测试 804/0 fail。
- **侧栏团队过滤缺陷修复**：根因=effectiveProjectTeamId() 使未归属项目全被过滤，改为 `null`(未归属)无条件可见。
- **右栏工具标签栏**：新模块 `rail-tools.js` + `rail-panels.js` + `rail-tools.css`。任务工具迁入右栏标签条（审阅/浏览器/文件/终端/侧边对话），标签条 + ➕ 菜单 + 空态选择器同源驱动。终端改为底部抽屉。测试 809/0 fail。
- **终端输入双重序列化修复**：根因=request() 内部 JSON.stringify 与 16 处调用方手动 stringify 叠加，body 被双重序列化。修复=request() 对字符串 body 原样透传。同轮修掉 8 个真实缺陷（视图无条件自举、SSE 断线不重连、xterm 隐藏容器 open、孤儿面板、mount 不幂等、输入失败静默、默认 shell 走 pwsh、401 竞态）。测试 819/818 pass/0 fail。
- **决策记录回溯**：2026-08-08 context.md 更新 + decisions.md 批量补录（见 `decisions.md` 08-08 条目）。

### 2026-08-12 ~ 08-13 活跃波次

- **远程配置工作台同构**（烛）：远程主机与远程项目补齐本机三面（供应商与应用 / Agent·Skill·MCP / 运行席位与真源）+ 真实主机健康仪表盘；写入链的 CAS、staged digest 校验、planRevision 绑定与凭据脱敏在两轮独立复核中被推翻并加固。证据见 `codex-to-claude__remote-config-workbench-parity__20260812-0446.md`。
- **远端真源安全网**（主驾续波）：补齐远端相对本机缺失的两道安全网——保存前差异预览 + 发布备份时间线（对比/恢复）。恢复复用 `writeSource` 事务（CAS/锁/原子发布/恢复台账全继承，且为恢复前内容再留备份 ⟹ 恢复可回滚），备份原文只在服务端流转、不经浏览器。同轮修掉一处**数据损坏缺口**：`findSecretCandidates` 有 12 字符门槛而 `scrub` 没有，导致含短值示例的文档既被脱敏又被判可编辑，保存即把 `[REDACTED]` 写回远端——现按契约收紧为「返回内容 ≠ 远端原文 ⟹ 一律只读」。另修 7 处空白图标并新增 sprite 引用契约测试。证据见 `claude-to-all__remote-source-safety-net__20260813-0113.md`、`decisions.md` D-2026-08-13-001。

- **配置系统 bug 搜寻 + 矩阵可用性改造**（主驾续波）：三路并进（静态审查 / 真实 HTTP 边界探针 / UI 走查截图）。结论诚实分层——`/api/config` 边界层健康（路径穿越 404 不回内容、critical 源 403 fail-closed、无 5xx），**该层无可报缺陷**；真问题在 UI：①门闸未授权（501）被当成故障渲染成常驻红字技术文案（390px 占三行），改为 `gated`/`error` 分类 + 「去授权」直达门闩；②`team-workspace-ui` 三条断言盯字面文本而守卫已收口，先核实三道闸都在、确认是断言腐烂才升级为语义断言；③Skill 矩阵 126 格无筛选无批量无定位，补筛选/覆盖率/整行整列全量批量（复用原子接口、只提交真实变更、fail-closed 成员豁免、影响面二次确认、部分失败逐条回报）+ 斑马纹/行 hover/勾选饱和度/表头 sticky。走查工具正式化为 `npm run qa:walkthrough`。证据见 `claude-to-all__config-system-bugs-and-matrix-ux__20260813-0150.md`、`decisions.md` D-2026-08-13-002。

### 2026-08-17 ~ 08-18 活跃波次

- **Control Center 全面审查与交付闸门**：runtime reload 提交点、shutdown/instance lock、终端 RAF、自动化 fail-closed、市场 latest-wins、右栏 ARIA 已补强；新增 `qa:delivery` 只读清单。
- **CCB 启发的消息收发局**：团队编排页新增 `514cc.collaboration-inbox/v1` 有界只读投影；Ask 身份固定为 `runId + askId`。证据见 `codex-to-claude__ccb-message-bureau__20260818-0058.md`。
- **R0 可信发布基线**（项目经理锁定 R0-01→R0-03）：`promptTransport/v1` 封住 Windows `.ps1` 非 ASCII；`delivery-ownership.json` cut `v42-r0`；`releaseTruth/v1` 无当轮证据不得声称已激活。20260815 ultracode 审查波已 superseded。证据见 `claude-to-all__r0-trusted-baseline__20260818-0735.md`、`D-2026-08-18-002`。
- **R1-01 项目桥**：环境舱只读四面（源码/运行时/进程/证据）。`projectId` 跟路径，`anchorId` 跟 Git 首提交。客户端不能提交 cwd。证据见 `claude-to-all__project-bridge__20260818-0815.md`、`D-2026-08-18-003`。
- **v42 首批 DAG 收口**（R0-04 → R1-03 → R1-04 → R1-05 → R2-01，外加薄做 R1-02）：关闭链/provider 引用竞态、派工预演不建 run、回放只读且 submitting/ambiguous 禁自动重放、证据卡永不宣称已发布、Inbox 可写 Ask/Answer/ACK（ACK ≠ provider 成功；高影响动作拒绝）、环境舱首次就绪四步。烛 R1 抓到 Inbox persist-then-append 与 close 跳过 automations.stop，已当场改；R2 复扫 DELTA=0。证据见 `claude-to-all__v42-pm-closeout__20260818-0915.md`、`D-2026-08-18-004`。**Inbox 不再只读。**
- **R2-02 注意力中心**：`GET /api/teams/:id/attention` 把队列深度、执行中席位、待答、需关注收进同一投影（Inbox 嵌在信封里，不新持久化）。`queued` 不算执行中。英雄区吃这组数字；offline/busy/degraded/unknown 不涂绿。Inbox 点击带 CAS（首答 revision=0）；空答复进不了 bus。health 走 `peek()` 不打探针。烛先推翻 queued 双计，复扫 DELTA=0。证据见 `claude-to-all__v42-r202-attention__20260818-0940.md`、`D-2026-08-18-005`。
- **R2-03 受控社会协作**：默认 `pipeline`，不再自动进 socialLoop。只有 `orchestrationMode:"social"` 或 composer `/social` 才社会模拟。agent-to-agent 必须有收件人，且带轮次/预算/深度/乒乓上限。自动化有点名才显式 social。烛先抓住自动化侧门，已收。证据见 `claude-to-all__v42-r203-social-optin__20260818-1335.md`、`D-2026-08-18-006`。
- **R3-01 Delivery Gate 2.0**：`GET /api/release-record` 合成可审计发布记录；不自动 git；formal-release 只挡 publishable。`operator-attested` 不能开启工程绿灯，`server-observed` 还必须匹配当前提交和干净工作树摘要。环境舱可见「交付门」；Git must-ship 闭包已完成，但正式实例尚未从确定提交执行 runner，live 仍不能涂绿。证据见 `claude-to-all__v42-r301-delivery-gate__20260818-1550.md`、`codex-to-claude__v42-r301-runner-r2__20260818-2147.md`、`D-2026-08-18-007/011/013`。
- **R3-02 准备交付 / 结算中心**：`GET /api/runs/:id/settlement` 把 worktree、diff 摘要、artifact、恢复收成一条记录。不自动 merge；远程是 `remote-unsupported`。终态卡与环境舱可见「准备交付」。烛通道仍不可用。证据见 `claude-to-all__v42-r302-settlement__20260818-1740.md`、`D-2026-08-18-008`。
- **R3-03 指标与运营观测**：`GET /api/observability/ops` 合成当前进程低敏摘要。缺失成本/空样本显示「未知」，不当 0。体系观测页可见运营指标卡。证据见 `claude-to-all__v42-r303-ops-metrics__20260818-1755.md`、`D-2026-08-18-009`。R4 仍按进入条件暂缓。项目经理审核包：`claude-to-all__v42-pm-delivery-review__20260818-1805.md`。
- **v42 PM 独立复审与加固**（烛）：推翻“R0-R3 已完成”的笼统口径，改为源码/契约、聚焦证据、全量证据、Git 交付、正式运行态五层。已补 prompt 审计超时、release command evidence 信任分级与 consistency 硬门、Diff 失败闭锁/路径脱敏、首次就绪旧 evidence/旧 health 拒绝、指标乱序与 path-only evidence 拒绝、远端 adapter 失败缓存、replay 原生稳定 ID、远端 TERM/KILL 回执等待且不再用 `|| true` 抹平失败；Inbox 行内 CAS 与环境舱四档浏览器均通过。证据见 `codex-to-claude__v42-pm-delivery-review-r2__20260818-2002.md`、`D-2026-08-18-010`。
- **R3-01 server-observed QA runner 加固**：`src/release-command-runner.mjs` 与 `GET/POST /api/release-record/runner(/run)` 保持固定命令目录、无 shell。两轮独立复审先推翻客户端 `sourceCommit` 替代服务端 HEAD、脏工作树可产 passed、选择放大和 runner 脱离关闭图，又推翻“四条 evidence 已能驱动 live releaseTruth”的错误可达性判断。现在每条证据同时绑定当前 `pid + startedAt + generation + HEAD + diffDigest`；live truth 只聚合同一当前实例、同提交/工作树且四类全通过的证据，旧实例/旧 generation 自动失效。空/重复/未知命令、工作树/HEAD/实例变化均 fail-closed；runner 纳入 app close，活动时阻止 reload。源码、聚焦、HTTP 装配、全量、validate 与四视口环境舱已有本地证据，但**未在正式实例对不可变提交真实执行**，R3-01 仍为 `partial`。证据见 `claude-to-all__v42-r301-server-observed-runner__20260818-2115.md`、`codex-to-claude__v42-r301-runner-r2__20260818-2147.md`、`D-2026-08-18-011`。
- **v42 Git 产品快照闭包**：LO 明确授权后，以显式 pathspec 暂存 Control Center 产品、严格交付 CI、治理真源与 2026-08-18 handoff 链；`.scratch`、运行 token、真实 provider 回包、锁/事件日志、QA 输出、缓存与历史原始材料均未进入提交。产品快照 `2b1892c73a7d38da9ab735cf20bae763a5e4c359` 已推送 `origin/main` 并经 `ls-remote` 回读；`qa:delivery --strict` 为 tracked=379 / physical=379 / pass。此处只完成 Git 层，不构成正式版本发布或运行态激活。证据见 `codex-to-claude__v42-git-delivery-closure__20260818-2351.md`、`D-2026-08-18-013`。

### 2026-08-19 ~ 08-29 活跃波次（本段为补齐，共 45 份 handoff）

> 归纳依据：`.ai-shared/handoff/` 下该区间的 45 份文件名 + `proposals/v43-514-bot-product-reframe.md`。
> **未逐份精读**，故此处只记主题与产物坐标，不声称实现细节与通过率；细节以各 handoff 原文为准。

- **514 bot 产品重定义（v43）**：`proposals/v43-514-bot-product-reframe.md` 确立 bot 作为产品入口的重构方向。证据 `codex-to-claude__514-bot-product-reframe__20260822-0001.md`。
- **bot shell 与视觉语言**：Forge shell 恢复、窗口 chrome 跟进、拖拽表面修复、对话框表面统一、桌面图标对话框核心。证据 `...__514-bot-forge-shell-restoration__20260826-1647`、`...__bot-window-chrome-followup__20260823-2255`、`...__drag-surface-fix__20260823-2135`、`...__bot-dialog-surface-unification__20260824-1455`、`...__desktop-icon-dialog-core__20260824-1602`。
- **bot 通信与协作对话**：通信 UI、审批卡、提问卡、collab 对话深度打磨、collab 恢复错误 UI、composer 胶囊。证据 `...__bot-communications-ui__20260824-0506`、`...__514-bot-approval-card__20260822-1915`、`...__514-bot-question-card__20260822-1823`、`...__bot-collab-dialog-deep-polish__20260826-1042`、`...__collab-recovery-error-ui__20260826-2306`、`...__bot-composer-capsule__20260823-2317`。
- **bot 成员、席位与联系人**：成员设置与实时生效、品牌色、自定义运行席位、席位入口可发现性、内置联系人移除、群聊完整联系人、Claude Fable 原生席位。证据 `...__bot-member-settings__20260824-0132`、`...__bot-member-settings-live-activation__20260824-0201`、`...__bot-member-brand-colors__20260824-1229`、`...__bot-custom-runtime-seats__20260824-0329`、`...__bot-seat-entry-discoverability__20260824-0216`、`...__bot-builtin-contact-removal__20260824-1301`、`...__bot-group-full-contacts__20260824-1112`、`...__claude-fable-native-seat__20260826-1605`。
- **对话与工作区**：项目会话隔离、任意入口进入对话、工作区 UX、workspace context epoch、直聊/群聊附件、surface 工作区路由。证据 `...__bot-project-conversation-isolation__20260825-1400`、`...__conversation-any-entry__20260826-0600`、`...__conversation-workspace-ux__20260826-0730`、`...__conversation-workspace-context-epoch__20260826-0331`、`...__conversation-direct-group-attachments__20260824-1900`、`...__bot-surface-workspace-routing__20260824-0015`。
- **结算与 P0 加固**：`...__514-bot-settlement-hardening__20260822-2225`、`...__bot-p0-hardening__20260825-2001`、`...__514-bot-shell-followup__20260822-1641`。
- **运行时与工具链**：fastctx 传输修复、原生 CLI 路径配置、live MCP 采纳评审、无路由可观测性、配置总线 UI 评审、Forge 艺术指导评审。证据 `...__fastctx-transport-repair__20260824-1552`、`...__native-cli-path-config__20260820-0315`、`...__live-mcp-adopt-review__20260821-0252`、`...__no-route-observability__20260819-1513`、`...__config-bus-ui-review__20260820-1518`、`...__forge-art-direction-review__20260819-2121`。
- **continue-loop 三轮**：`...__continue-loop-independent-review__20260819-1650`、`...__continue-loop-r2__20260819-2050`、`claude-to-all__continue-loop-followup__20260819-2055`。
- **项目经理全项目审查**：`codex-to-claude__project-manager-review__20260829-2240.md`（DELTA=1），点出 Git 断链、记忆过期、账本膨胀、版本悬置四条，本轮已复核并落地 Git 部分。

### 2026-08-30 治理收口（本轮）

- **Git 证据链重建**：本地 `.git` 曾重新 init（单提交 `603056d`、无 remote、1491 个运行时产物误入库）。以 `reset --mixed 6bb3691` 接回远程历史，分两笔提交：
  - `bcf4347 chore(repo)`：移出 1491 个误入库路径（`.scratch`、`.qa-output`、`.repro-*`、`debug-provider-*`、含凭证的 `providers.json` / `ccswitch-proxy.json` 副本），并收紧 `.gitignore`。
  - `254a973 feat(control-center)`：2026-08-19~29 波次的 256 个文件变更。
  - 结果：tracked 961，工作树干净，本地领先远程 2 笔 / 落后 0 笔。**尚未推送，待 LO 授权。**
- **密钥扫描（F-003）**：`.ai-shared/audit/secret-scan-20260829.md`（值已脱敏）。结论：工作树内 10+ 个真实 `sk-` 云 API key 均**未入库**（`.gitignore` 挡住）；但远程公开仓库历史中存在 1 个真实凭证（详见「当前风险」）。
- **完善蓝图**：`proposals/v44-completion-blueprint.md`，92 条完善点 + 35 条拓展点，六波次执行计划。
- **操作前备份**：`I:/514claude/_git-backup/514cc-git-20260829-2339`（65MB，操作前 `.git` 完整副本）。

### 2026-08-30 午后产品波（LO 三指令：壁纸丢失 / 启动加载 / 协作界面）

- **壁纸启动丢失根因修复（v8.5）**：非数据丢失——`reconcileGlobalWallpaperMedia` 的 HEAD 对账与偏好水合竞态，在空 localStorage 写 `{preset:none,hasCustom:true}` 默认快照，挡服务端 `preset:custom` 回填且被双写 PUT 降级真源（丢失跨重启粘滞）。修复：对账只对已有本地偏好做存在性修复 + 串到 `hydratePreferencesFromServer().finally` 之后；契约 16b 四断言锁死。证据 `claude-to-all__startup-wallpaper-picker-wave__20260830-1434.md`、提交 `d713d97`。
- **桌面启动反馈**：Tauri 壳握手前展示内置 splash 窗（`dist/index.html` 暗夜玫瑰主题，gitignore 内随盘构建），主窗口 Live 自动关闭、失败路径统一收尾；cargo test 22/22。release exe 重编待 LO 退出应用（旧 exe 进程持锁）。
- **协作 picker 完善**：「发送给谁」卡片副行接成员真实职责（BOT_MEMBER_ROLE_LABELS 归一化）、团队上下文行、1-9 数字键直达（与点击共用 `pickComposerAgent` 出口、编辑控件聚焦不抢输入）；`scripts/qa-agent-picker.mjs` Playwright 探针全绿 + composer-target-ui 契约 13/13。
- **Git 状态要点**：本轮以显式 pathspec 提交 `d713d97`（7 文件）；工作树另有 ~126 条 wave0-3 在途产物未提交，其中 **`public/*.js` 前端层（api/state/utils/36 modules）从未入库**——任意 HEAD 均无法新 checkout 运行（PM 审查「Git 断链」实体），前端层收口是下一轮独立事项。全量套件 1902 用例除 1 个既有失败（title-glyph，随上轮 index.html WIP）外全绿或满载波动（隔离复跑绿）。

### 2026-08-30 傍晚 PM 走查波（LO 指令：产品缺陷深查 + 玻璃统一 + 顺手度）

- **方法论升级**：新增 `scripts/qa-pm-walk.mjs`（壁纸激活态 14 视图逐张实拍走查）与 `scripts/qa-glass-audit.mjs`（运行时玻璃审计：扫描大面积不透明表面，覆盖 oklch/渐变/伪元素）——UI 质量从「源码契约绿」升级到「运行时 computed 可验」。证据 `claude-to-all__pm-walk-glass-v9-usability__20260830-1919.md`，提交 `32a07bb`。
- **玻璃质感 v9/v9b（LO 点名项）**：修复前 40+ 处大面实底；三层根因——①v7/v8 玻璃配方运行时静默失效（composer-shell 悬案：规则命中但 computed 实底，CDP 证据在案）；②设置族被 `:is(#view-*)` 等 ID 级实底规则压住（特异性战争）；③真漏补（settings-rail/channel-deck/memory-browser/席位工作区等）。统一吃 `--forge-card-alpha` 令牌，审计现全视图清零。
- **全局导航修复（最大可用性缺陷）**：experience-polish 无条件 `!important` 休眠块把汉堡/抽屉全域杀掉，14 视图桌面唯一入口是 Ctrl+K。现汉堡全尺寸常显、抽屉 nav-open 滑出、「视图」菜单承载 14 视图导航（NAV_GROUPS 单源）；端到端验收通过。bot 表面维持无 chrome。
- **七项使用逻辑缺陷**：安全页 `shell undefined` 泄漏、渠道门闩拦截无放行入口、bot 空态文案误导、观测页「未知」大字三行溢出、面包屑分组与导航两张皮（FORGE_VIEW_GROUPS 改 NAV_GROUPS 单源反推）、命名统一「系统总览」、门闩空态可操作化。
- **待 LO 拍板**：协作星图黑板是否玻璃化（疑为有意星空视觉）；设置轨 IA 与 NAV_GROUPS 两套分类学的收口。
- **续篇（同日，LO「继续」授权）**：styles.css **44 处声明行丢分号**（CSS 错误恢复连吞下一条声明，赤陶点睛色/强调边框从未生效）机械修复；◆ 兜底装饰收窄到裸空态；星图黑板→壁纸态深色玻璃（夜空身份保留）；设置轨 IA 与 NAV_GROUPS 同构（观测/资源/治理分组、自动化入轨、插件/市场去重）。提交 `04ac1ae`；全量 1891/1902（9 失败均既有/波动族）。
- **晚间：壁纸「启动失效」真因二层修复 + 能力面 UI**（LO 报障 + MCP/Skill 布局指令）：LO 换了 60MB 视频壁纸后启动又丢——真因不是水合（v8.5 那层仍对），是**预览缩略图旁路**：外观面板 meta 行每次渲染全量 requestBlob 拉字节，冷启动重放 14 个 apply = 14 个并发 60MB GET ≈ 900MB 瞬时流量打爆磁盘。`fetchGlobalWallpaperMediaRef` 模块级单飞 + 预览/挂载共享 + 签名幂等：15 次 GET→1、挂载 5.3s→0.9s（真实偏好+真实字节复现探针 `qa-wallpaper-repro` 验证）。能力面（MCP/Skill）：矩阵描述单行化+行距收紧、映射 chip 流→三列条目卡（修 flex 内 grid 收缩 bug）、sticky 首列表头玻璃化。提交 `fec7929`；全量 1890/1902（既有/波动族）。
- **验证**：qa-glass-audit 12 视图 0 违规；qa-pm-walk 端到端 + 零页面错误；契约 82/82；ui-lint 无新增；npm test 1889/1902（11 失败均既有/波动族）。

## 当前风险

- **🔴 P0-2026-08-30 凭证泄露（公开仓库，当前仍在线）**：`lanniny/514-bot` 是 **GitHub 公开仓库**（`private=false`）。`.ai-shared/control-center-preview/data/ccswitch-proxy.json` 内的 CC-Switch 本地代理 token（`tEP1_` 前缀 43 字符，监听 `127.0.0.1:15721`）。**2026-08-30 02:00 复核（证据链）**：
  - 引入提交 `6077930`（2026-08-13 10:16），**已在 `origin/main` 上** → 至复核时**已公开暴露约 16 天**。
  - 清理提交 `1876bf9`（2026-08-30 01:38）已把它移出追踪树，但 `git branch -r --contains 1876bf9` 为空 → **清理尚未推送，远端此刻仍可 `git show origin/main:<该路径>` 取出明文 token**。
  - 远端历史中 `providers.json` 的 `sk-` 类云 API key：抽查远端前 40 个提交**无命中**，与既有记录一致（未进入远程历史，属运气而非机制）。
  - **结论**：不是"曾经泄露"，是**正在泄露**。**必须先轮换 token**（本地代理配置重新生成），轮换后再推送 `1876bf9` 停止后续扩散；历史对象仍需 `git filter-repo` + 强推才能清除，且强推不替代轮换。另需复核的 16 个同文件副本散落在 `.qa-output/` 与 `.scratch/`。
  - **教训**：判断"有没有泄露"必须查**历史**（`git log --all -- <path>` / `git cat-file -e <ref>:<path>`），不能只查当前索引（`git ls-files` / `git check-ignore`）。本轮审计中途曾据索引误判为"未泄露"，靠历史复核纠正——索引干净 ≠ 历史干净。
- ~~**P0-F-004 缺 pre-commit 密钥拦截**~~ **→ 2026-08-30 已关闭**：新增 `.githooks/pre-commit`，只扫本次新增行、排除官方占位符、命中时脱敏输出、支持 `# gitleaks:allow` 行内豁免；已验证真实形态密钥被拦截且占位符不误报。
  - **启用方式（每台机器一次）**：`git config core.hooksPath .githooks`。在没执行这条命令的机器上，闸门等于不存在——**新环境首次 clone 后必须执行**。
  - 仍需警惕：本机工作树有 10+ 个真实 `sk-` API key（集中在 `.ai-shared/control-center/providers.json` 与 `.ai-shared/backups/`），目前靠 `.gitignore` 第 2/20 行挡住。钩子是第二道防线，不是免死金牌。
- ~~**P0-F-044 出站目标无白名单（SSRF）**~~ **→ 2026-08-30 已关闭**：新增 `apps/control-center/src/security/egress-guard.mjs`，覆盖 channels webhook、provider-net 自建端点/用量脚本、ccswitch 上游代理探测三个「此前只验协议」的出站口。同步层（IP 字面量 + 保留域名）在保存配置时拒绝，异步层解析 DNS 校验每一个结果以阻断 rebinding。两级策略：`strict`（默认，第三方指定目标）拒绝一切保留段；`lan`（自建端点）放行环回与私网，因为 Ollama/LM Studio/内网网关是正当用法；`deny` 层（云元数据 / 链路本地 / RFC2544 / 组播 / 未指定）任何策略下都不可放行。**残留风险**：请求时未做 DNS pinning，域名目标仍有 TOCTOU 窗口，彻底修法需 undici 自定义 dispatcher。
- ~~**P0-F-046 路径穿越审计**~~ **→ 2026-08-30 查证结论：已闭合，非缺口**。蓝图标「待查证」偏保守：`workspace-explorer.mjs` 已有绝对路径/`..` 段/符号链接/逃逸 junction/逃逸硬链接拒绝，外加 dev+ino+birthtimeNs 的 TOCTOU 替换检测（12 例测试）；`clipboard-attachment.mjs` 的 `pathInside()` 用 `relative()` 判定，写入文件名由 `safeId`（非 `[a-z0-9-]` 全剥离）+ ISO 时间戳构成，无用户输入路径。**预算应挪给 W4 其他项。**
- ~~**P0-F-055 上传面审计**~~ **→ 2026-08-30 查证结论：已闭合，非缺口**。`avatars.mjs` 的 `safeFileStem()` 显式拒绝 `.` / `..`；文件枚举只信 `readdir` 输出、扩展名走 `EXT_MIME` 白名单（`Object.hasOwn`）；有 magic-byte 校验（PNG/JPEG/WebP/GIF + mp4 的 `ftyp` / webm 的 `1a45dfa3`）；体积分档限额（头像 1MB / 团队背景图 8MB / 背景视频 64MB）；`writeAtomicBytes()` 走 `0o700` 临时文件 + rename。**预算应挪给 W4 其他项。**
- ~~**P0-F-052 凭据清单**~~ **→ 2026-08-30 已关闭**：新增 `scripts/secret-audit.mjs`（全仓历史盘点，与 `.githooks/pre-commit` 分工为「历史盘点 vs 提交闸门」）。设计要点：① **不自建模式库**——从 `.githooks/pre-commit` 解析 `PATTERN`/`PLACEHOLDER` 复用，改钩子即改审计，杜绝两套标准漂移；解析失败直接退出 2，宁可不扫也不用弱规则报"干净"。② 补一层钩子没有的**无前缀高熵检测**（≥32 字符 + ≥3 字符集 + 强制混合大小写 + 熵 ≥4.5 bits/char），专门兜 `tEP1_` 这类脱离键名上下文就无人认领的随机串；阈值经实测校准：UUID/runId ≈3.6、SHA-256 ≤4.0，均被 4.5 挡下。③ 复用钩子的 `# gitleaks:allow` 行内豁免，保证两个工具对同一行结论一致。④ 显式排除包管理锁文件（`integrity` 字段的 sha512-base64 熵高达 5.2+，不排除会产生数百条噪音）与 `.scratch`/`.workflow`/`.npm-cache` 等暂存区。
  - **基线结论**：`--scope=tracked` 扫 950 个文件，**命中 0**（7 处命中全在 `tests/` 测试夹具，已逐条加 `gitleaks:allow` 注明理由）。`--scope=worktree` 仍有约 1746 处，集中在 `.ai-shared/backups/` 等**已被 gitignore 的本地备份**——不进远端，但说明本机工作树仍是高风险区，别在没启钩子的机器上 `git add -A`。
- ~~**P0-F-053 脱敏契约审计**~~ **→ 2026-08-30 已修复**：`sanitizeForPersistence` 的覆盖面（键名敏感 + 已知前缀 + 赋值型 + PEM + URL userinfo）是够的，但**结构化健壮性有三个实测复现的故障**，不是理论风险——它位于写盘关键路径（`event-store.emit` / `bus` / `orchestrator#persistRun` / `approval-broker.request`），一崩丢的是整条事件流：
  - ① **循环引用 / 深嵌套 → `RangeError: Maximum call stack size exceeded`**。修复：路径作用域 `WeakSet` 破环（同对象在不同分支重复出现不算环，判为 DAG 放行）+ 深度上限 96，分别落到 `[CIRCULAR]` / `[TRUNCATED:depth]`。
  - ② **Buffer/TypedArray 被 `Object.entries` 拆成 `{"0":115,...}` 字节索引字典**——既毁数据，又让二进制内容绕过全部字符串脱敏。修复：latin1 解码 → 脱敏 → 回写（字节↔码位 1:1，未命中时**完全无损**）；>1 MiB 走 `[BINARY_TRUNCATED nB]` 防 DoS；**只跑 `redactString` 不跑完整 `scrub`**，因为 `scrubAssignments` 的 YAML 逐行分块会让 1 MiB 全换行符的 blob 膨胀成百万级行数组，把脱敏器本身变成 DoS 面。
  - ③ **Map/Set/Date/URL/Error 被静默压成 `{}`（数据丢失），BigInt 直接抛 `TypeError`**。修复：Map→对象、Set→数组、Date/RegExp 原样透传、URL 过 `scrub`（可携带 userinfo）、Error→`{name, message}`，BigInt 降级为字符串。原则：**脱敏器的职责是去秘密，不是重新定义数据结构**；认不出的类型应保守放行或显式标记，绝不悄悄改成空对象。
  - **放大效应**：`orchestrator.mjs` 的 `Object.assign(run, safe)` 会把脱敏克隆**回写进活的 run 对象**——所以上面每一个"落盘数据被改坏"的缺陷，同时也是"运行时状态被改坏"。修好 `sanitizeForPersistence` 后该调用点无需改动。
  - 回归：`redaction-jsonl.test.mjs` 26/26（新增 4 条针对性测试）；`bus`/`sessions`/`providers`/`structured-redaction`/`workspace-explorer`/`cli-config-panel`/`observability-sessions` 130/130；F-044 三件套 73/73。
- ~~**F-048 event-store 防篡改**~~ **→ 2026-08-30 已实现**：蓝图标「待查证」属实——`#hashes()` 是布隆过滤器的双哈希、480 行的 "chain" 是 Promise 链，均非审计链，此前的事件日志**改一条、删一条都无从发现**。已实现追加式哈希链：每条事件携带 `prev`（前一条链哈希，首条为 `genesis`）与 `hash`（`sha256(prev + "\n" + 本行 JSON)`），新增 `verifyChain()` 与 init 后可读的 `chainStatus`。
  - **关键取舍：对原始行文本做哈希，不经过 JSON 往返**。验证时把 `hash` 值清空后对原文重算，因此文件若被外部工具重排版（缩进/键序），不会像「parse→重新 stringify→哈希」那样误报篡改。写入侧用「先留空占位 → 算完 `lastIndexOf` 回填」，比二次序列化整对象便宜一个数量级（16 MB 上限的大事件尤其明显）；`prev`/`hash` 恒为最后两个键，保证 `lastIndexOf` 不被 `data` 内的同形文本误导（有针对性测试）。
  - **并发正确性**：链尖 `chainTip` 必须在**第一个 await 之前**同步推进，否则并发 `emit` 会读到同一个 `prev` 而断链——40 条并发写入的测试专门锁住这一点。写入失败时记 `chainFault` 且**不回滚**链尖：未落盘却推进了链尖，会让后续事件的 `prev` 指向文件中不存在的哈希，`verifyChain` 必然报 `prev-mismatch`，故障不会悄悄消失。
  - **遗留数据平滑升级**：38551 条 F-048 之前的历史行识别为 `legacy` 段（不参与校验、不算断裂），之后的新事件从 `genesis` 起新链。真实 24 MB 文件实测 init 由 286 ms → 293~347 ms（约 +10~20%）；其中纯哈希成本 101 ms / 38550 行，而关闭校验只省掉约 10 ms 的 `lastIndexOf` 开销——**`verifyChain: false` 这个逃生舱省不下什么，代价是与历史段脱节**，这一点已被测试固化为「必须暴露断裂」而非静默通过。
  - **🔴 能力边界（务必知悉）**：哈希链能可靠检测改内容、删条目、删头部、插入条目；但**无法**检测「拿到写权限后重算整条链并全量重写文件」。要防后者需要外部锚点——定期把 `chainTip` 写到进程外（独立签名、只追加的异地日志、或定时外发摘要）。当前未做，属已知缺口，一旦有合规需求应优先补上。剥掉 `hash` 字段同样会让该行退化为「遗留行」而校验通过，因此**保护依赖文件写权限本身**。
  - 回归：新增 `tests/event-store-chain.test.mjs` 15/15；`event-store` + `event-store-run` + `chain` + `bus-tail` + `bus` 46 项中 39 通过、7 项 `hookFailed`（safe-delete 回收站 shim 报 `Some operations were aborted`，已用 HEAD 版本复跑确认为环境问题）；`sessions`/`providers`/`structured-redaction`/`redaction-jsonl`/`approval-broker`/`adapters`/`agent-actions` 190/190。`orchestrator.test.mjs` 121/122、`conversations-http.test.mjs` 0/1，两条失败均已用 HEAD 版本复跑确认为存量问题，与本次改动无关。
- **🔴 P0-2026-08-30 .git 对象库损毁（已恢复，根因待证）**：本轮工作中 `.git/refs/` 整目录被清空、`objects/pack/*.pack` 两个 pack 被删、松散对象由约 3200 降至 9，`git` 一度报 `fatal: not a git repository`。**最可能成因**：`git fetch`/`git commit` 触发的 `gc --auto`/`maintenance run --auto` 被 SIGTERM 打断——repack 是「写新 pack → 删旧 pack 与已入 pack 的松散对象 → 整理 refs」，中途被杀就两头落空（强嫌疑，未经复现验证）。**已恢复**：从 23:39 全量备份合并回 3157 个松散对象 + 经 HTTPS 代理重新 fetch 取回远端 22 个提交 + 重建 refs/索引（并二次清掉被 `read-tree` 灌回的 1491 个运行时产物，2342 → 851）。**损失边界**：原 9 个提交（bcf4347..82a2bac）的提交对象不可恢复，**文件内容零丢失**（来自工作区），重建为 `1876bf9`/`85860c3`/`ae748e8`/`bcb2c84`；reflog 存档在 `_git-backup/514cc-git-20260830-lost-reflog.txt`。**已设防护**：`gc.auto=0` + `maintenance.auto=false`（长会话禁用自动 repack）。
  - **两个 git 行为坑**：① `git update-ref` 对 `refs/remotes/*` **静默失败**（exit 0、不报错、不落盘），需改用 shell 重定向直写文件；② 本地 ref 指向无效对象时 `git fetch` 报 `did not send all necessary objects`，须先把 ref 落到有效 SHA 再 fetch。
  - **硬约束**：不要给可能触发 auto-gc 的 git 命令套短超时；破坏性操作前先做 `.git` 全量备份。
- **版本库体积与历史净化**：远程历史中残留 1491 个运行时产物（本轮已在新提交中移出追踪，但历史对象仍在，仓库 59MB）。若要彻底清除含 token 的历史对象，需 `git filter-repo` 重写 + 强制推送，**这会改写公开历史**，须 LO 明确授权后再做。
- 正式 framework release 仍以真源记录为准；工作记录里的 v3.6/v3.7/v4.0 仅是**未发布功能波次**，不得作为已发布版本传播。`rules.md` 仍为 v3.5.0，但 v4.0 功能（Forge 设计系统、CC-Switch 迁移、团队工作区融合、配置图谱、工具标签栏、终端修复等）已深度落地到 Console。版本升格/正式发布待 LO 决策。
- 仓库源、用户运行时和正在运行的进程是三个状态面；未做当轮 readback/端到端调用时，不得声称已部署或已激活。
- v42 R0-R3 的 31 项 must-ship 漂移已在产品快照 `2b1892c73a7d38da9ab735cf20bae763a5e4c359` 中闭包并推送；`qa:delivery --strict` 当时为 `tracked=379 / physical=379 / undeclared=0 / pass`。
（2026-08-30 注：tracked 口径已变化——`6bb3691` 为 2342，本轮清理后 `254a973` 为 **961**；379 属 v42 快照当时的显式 pathspec 范围，不代表当前全库。）Git 层已交付，但 `formalRelease=false`，不等于版本升格、GitHub Release 或正式实例激活。
- `PUT /api/release-record/commands` 是 `operator-attested` 审计申报，不是独立命令执行证据。剩余发布顺序是“从已交付提交 reload 正式实例并读回 PID/cwd/generation/sourceCommit -> 执行 runner -> 回读 release record”；正式实例操作、真实 provider/SSH 验收仍需独立授权，R3-01 保持 `partial`。
- R0-01 只完成已知不安全路径封堵与本地子进程 fixture；真实启用 provider 中文/ASCII 接收回读、真实 SSH UTF-8 echo 均未执行，不得称 Unicode 主路径端到端完成。
- Console 与治理面持续演进，固定测试总数会迅速腐烂；只记录验证命令和当轮输出，不在本文件固化“全绿 N/N”。
- Python 校验依赖由 `requirements-validation.txt` 声明；缺少 PyYAML/jsonschema 时必须显式失败，禁止静默退化成仅语法检查。
- CC-Switch 的 3 个 updater 命令必须保持 `blocked_external_trust`，直到 514cc 拥有自己的签名公钥与更新端点；禁止借用上游信任材料或伪称 updater 已上线。
- `exceljs@4.4.0` 的既有传递依赖链仍被 npm audit 报告为 11 high + 1 moderate，当前无直接可用修复；禁止无评估执行 `npm audit fix --force`。

## 验证入口

```powershell
python -m pip install -r requirements-validation.txt
cd apps/control-center
npm run validate
npm test
```

历史决策与纠错映射见 `.ai-shared/decisions.md`；跨 agent 证据见 `.ai-shared/handoff/`。
