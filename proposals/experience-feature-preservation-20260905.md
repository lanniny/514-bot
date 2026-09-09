<!-- 514cc-session-id: 01a070b1-5819-75e2-8b3d-76c89802e09d -->

# 体验重构功能保留契约

日期：2026-09-05。适用于 `product-experience-reframe-20260905.md` 的 B-E 阶段。

LO 的当前要求：现有功能不得删除。允许重构、重新布局、调整重点，不允许用简化界面作为取消已有能力的理由。原方案中的“暂缓”只约束新增投入，不授权下线已实现功能。

2026-09-05 B2 融合增补：`#experience` 与 Bot 现在共用同一操作宿主；普通 Conversation 发送已从隐藏 Workbench 表单中抽出。下表保留 B1 的历史映射，当前迁移与边界以 `collaboration-fusion-20260905.md` 和本轮 fusion handoff 为准。原 19 个视图 ID 与 14 个导航仍可达，但不再要求为每个 URL 维护独立业务状态。

2026-09-06 入口收口：依据 LO 新授权及 D-2026-09-05-005，Bot 已成为默认主页与唯一可见工作入口，`experience` 仅兼容旧链接，不再是导航项。此条取代 B1/E 对默认入口延后切换的限制，不豁免全旅程和真实执行验证。当前证据见 `codex-to-claude__bot-unification-ui__20260905.md`。

## 保留原则

1. 默认工作面为 `#bot`；旧 `#experience` 自动规范化为 Bot，并保留 Conversation、历史 Run 和页签。Workbench 作为高级运行控制台保留，避免第二个同职能工作面。
2. 重构可以迁移操作位置，但必须提供等价入口和可验证的原业务结果。只有菜单或截图存在，不算全功能验收。
3. 继续复用 ProjectRegistry、ConversationStore、Orchestrator、ConversationRunProjection 和现有 API；原生 CLI session 不冒充持久化 Conversation。
4. 权限闸、准入、审批、预算、恢复与交付状态不被新布局绕过。已有 blocked/只读能力保留原状态，不制造可用性承诺。
5. source、隔离运行、正式桌面和发布证据分开。未做正式 provider/SSH/发布验证，不能从界面可达推断其运行成功。

## 功能地图

| 既有能力 | B1 保留落点 | 本轮证据边界 |
|---|---|---|
| 协作台、CLI 原生历史、成员页签、草稿、附件与发送 | 原 Workbench；新面提供“在协作台打开” | 浏览器验证准确 Run 页签、草稿往返；发送参数与附件沿原实现，未调用真实 provider |
| 项目草稿、长期对话、私聊/项目群聊、隐藏恢复与审计墓碑 | 原 Bot；新面使用其持久化索引并提供“打开对话” | 浏览器验证项目筛选、搜索、历史 Run、隐藏恢复、墓碑与异属 Run 拦截 |
| 团队、成员、路由与协作星图 | `team`；保留 `router`、`hero` 别名 | 原菜单和新“全部功能”均保留，浏览器验证落点 |
| 供应商、Agent/Skill/MCP、真源编辑、运行席位、本机运行时、Hooks | 原 `config` 子路由与设置轨 | 契约测试保留配置子路由、远程恢复/并发/草稿保护；没有搬走编辑器 |
| 审批、租约、安全诊断、恢复、预算 | 原安全页、Bot 待处理与协作台控制 | 导航可达与 focused 回归；不在新面复制授权逻辑 |
| Mission、diff、文件、成果证据、环境、浏览器 | 原协作台工具和证据入口 | 工具契约保留；新成果页是快照摘要与原操作入口，不算类型化成果闭环完成 |
| 双终端 | 原底部终端与协作台 CLI 终端 | DOM/接线契约；不因新面无内嵌终端而移除旧终端 |
| 自动化、渠道、Office 文档工坊、项目启动器 | 原视图与 `automations` 的 Workbench 面板 | 原页面和新菜单可达；不执行自动化/渠道外发 |
| 市场、SSH/SFTP、远程主机 | 原 market/hosts 及相关工具 | 页面入口保留；真实远程调用仍需具体授权 |
| 总览、观测、产品健康/反馈、会话聚合、搜索/命令面板 | 原 overview/observability/sessions 与 Ctrl+K | 既有模块不移除；动态导航会包含新入口 |
| 外观、账户、窗口操作、导航后退/前进 | 原设置与顶栏 | 新增对话/Run/tab 路由历史，不改变旧路由 key |

## 固定基线

- 19 个旧视图 ID：`overview bot workbench team channels config router security observability sessions bootstrapper office automations terminal market hosts hero appearance browser`。
- 14 个原导航 ID 与顺序：`bot workbench team channels bootstrapper office overview observability sessions market hosts config automations security`。`nav-config.js` 本轮未修改。
- 深链保留：`#conversation=`、`#run=`、`#project=`、`#session=cli::project::session`、`#session=project::session`、`#memory`、`#capabilities`、config 子面及 member/runtime 查询参数。
- 主路由：`#bot?conversation=<id>&run=<id>&tab=process|results`，默认对话页签省略。视图偏好写 `514cc.bot-workspace-view.v1`，兼容读取 `514cc.experience-view.v1`，不清空旧键或用户草稿。

机械基线见 `apps/control-center/tests/experience-workbench.test.mjs`。真实浏览器见 `apps/control-center/scripts/qa-experience-workbench.mjs`，旧功能专项测试继续保留。

## 后续退出门

阶段 B2 把输入区接入统一工作面时，必须保留现有附件、接收对象、模型/推理强度、有效权限、预算、Slash/Mention、草稿保护、等待提问、取消/恢复和准入回执；不能用一个只有文本发送的输入器替换它们。

阶段 C/D 迁移成果、设置与长尾功能时，逐项登记新旧落点和业务验证。阶段 E 仍须补旧功能全旅程回归与可回退候选构建；默认入口已按 LO 后续授权先行切换，不能以入口检查替代业务验收。

## Bot 当前落点

- 对话、过程、成果共用一个输入节点、Conversation 草稿和 Run 历史选择。筛选进入搜索旁的菜单，协作成员编辑进入会话头。
- 运行控制台、设置位于列表底部；输入区“高级编排”也进入 Workbench。固定身份的私聊/项目群聊继续由服务端决定 topology，不能用前端切换器改变身份；无持久化 Conversation 的旧任务创建仍保留流水线/社会模拟选择器。
- 窄屏统一在 820px 切换列表/会话单面，账户区保留在列表底部；主导航抽屉在 Bot 中可打开，因此团队、渠道、Office、市场、主机、安全等长尾入口继续可达。
- 双终端、模型/effort、预算、原生命令和安全审批仍在原专用工具中，没有声称本轮已全部迁入普通文本发送命令。
