# 514 Bot v43 产品重塑基线

> 状态：discovery baseline，尚未宣称实现或发布
> 日期：2026-08-22
> 触发：LO 要求以 Grok Bot 的通讯式代理体验重塑 514 Bot，并参考 Codex harness / DeepSeek harness / Codeg / LiveAgent
> 证据边界：本文件把 LO 提供的截图与体验描述视为设计输入；外部产品事实只在有当前来源或仓库快照支持时采用

<!-- 514cc-session-id: 01a025bc-6dfd-7b00-9f68-cbc352f36c6c -->

## 1. 结论

514 Bot 不应该继续沿着“控制面板增加更多页”的方向增长。它应当成为：

> **常驻 AI 代理工作台：通讯录是入口，对话是主界面，每名代理拥有可观察、可交还控制权的电脑。**

这不是把 514cc 的治理内核删掉，而是改变用户首先看到的表面：

```text
现有：导航 -> 控制面/团队/项目 -> run -> 事件/证据
目标：代理通讯录 -> 持续对话 -> 内嵌动作卡 -> 代理电脑 -> 证据/交付
```

后端仍保留 514cc 的差异化：异构 CLI 原生会话、路由、审批租约、bus/inbox、worktree、replay、evidence、delivery gate 和 fail-closed 守卫。

## 2. 三条互斥路线与收敛

### A. 渐进式薄壳（采用）

- Tauri 2 继续作为原生桌面壳。
- Node HTTP/SSE control-center 继续作为唯一运行内核。
- 新建 `bot` 产品表面，默认入口先进入代理对话；旧控制台以“账户/命令面板/高级工作区”方式保留。
- 复用现有 `runId`、`teamMember`、`bus`、`artifact`、`replay` 和 provider adapter，不引入第二套任务真源。
- 优点：最小数据迁移、保留当前安全和恢复语义、可在浏览器与 Tauri 同时验收。

### B. Electron + React 全量重写（拒绝）

- 会复制桌面生命周期、进程监管、SSE、权限边界和设置投影。
- 视觉重写速度可能更快，但会把成熟的 Node/SSE 治理面与新的 React 状态面分裂。
- 不适合作为当前项目的主线；只有当 Tauri/WebView2 出现不可解决的平台限制时才重新评估。

### C. Tauri/Rust 连内核重写（拒绝）

- 会同时重写 orchestrator、provider adapter、bus、config manager 和 delivery gate。
- 对“聊天主界面”没有直接产品收益，却把验证成本和恢复风险扩大到全仓。

## 3. 目标信息架构

### 3.1 左栏：代理通讯录

- 顶部：`514 Bot` / 当前工作区。
- 中部：长期存在的代理列表。每行显示头像、名称、title、最近一句话、未读点、运行态。
- 右键代理行：删除代理及其记录，必须二次确认；不放进设置。
- 底部：账号按钮，作为账户与设置入口；不以齿轮作为全局设置入口。
- Cmd/Ctrl+, 和命令面板的 `Open settings` 仍可打开设置。

第一批内置代理不再按“页面”命名，而按持续职责命名：

| 代理 | 默认职责 | 运行边界 |
|---|---|---|
| Master | 接收任务、拆解、路由、收敛 | 不替代专业代理执行全部工具操作 |
| 烛 | 代码评审、风险、性能、交付门 | Codex review / read-only 优先 |
| 织 | 当前资料、竞品、长文档 | Grok + Web MCP，来源必须可追溯 |
| 匠 | 嵌入式、总线、寄存器、硬件 | 领域诊断，真实设备证据另行分层 |
| 策 | 规格、架构、任务拆解 | 输出 packet、验收和依赖 |

### 3.2 中栏：持续聊天

- 顶栏：代理名、在线/忙碌/等待用户/降级/未知状态；代理名可打开右侧信息面板。
- 消息像即时通讯：短消息、自然断句、连续多条；长进度不刷命令日志。
- 主对话保留结论；嘈杂的长进度、回放和审计细节进入 thread / 右侧工具面板。
- 发送对象默认为当前代理；Master 可把同一任务拆成并行子任务，但用户只看到整洁的主线结果与必要状态。

### 3.3 消息类型必须结构化

以下内容禁止伪装成普通文本：

- `question`：一条人话问题 + 1-6 个选项 + 单选确认。
- `approval`：权限、危险操作、外部账号或交付动作的确认卡。
- `connector`：登录、授权、连接状态和失败原因。
- `cloud-computer`：代理电脑任务、阶段、耗时、截图/产物入口。
- `routine`：例行任务的启用、下次运行、暂停和确认。
- `artifact`：文件、图片、diff、测试、证据、交付状态。
- `attention`：需要 LO 决定的 Ask/Answer/ACK，身份固定为 `runId + askId`。

### 3.4 右栏：代理信息面板

- 顶部实时预览缩略图，点击进入电脑视图。
- 下方 Routines、Channels、Members（按代理能力出现）。
- 标题栏 X 旁的齿轮只进入“该代理子设置”，不进入全局设置。

### 3.5 全局设置：严格五个 tab

1. General：账号、登录 Cursor、登出。
2. Plugins：市场、已安装、Private skills、认证状态。
3. Team Setup：安装到团队电脑的脚本与团队级能力。
4. Appearance：System / Light / Dark 三档。
5. Updates：更新代理电脑与更新应用分开；Update 优先于 Reset；Stable / Nightly。

现有“配置图谱、供应商、MCP、Skill、治理、远程主机、观测”等能力不删除，改为从账户菜单、命令面板、代理子设置或对话内卡片进入，避免继续扩张一级导航。

## 4. 桌面与远程电脑模型

“每名代理一台电脑”是产品隐喻，但不能在没有运行态证据时伪装成云端远程桌面。分三档：

| 状态 | 用户看到的内容 | 可执行动作 |
|---|---|---|
| `not-provisioned` | 安静占位 + 创建/连接按钮 | 只创建计划，不宣称电脑已存在 |
| `local-runtime` | 本机运行时预览、终端/浏览器/文件证据 | 复用现有 PTY、browser、environment panel |
| `remote-attested` | 主机、会话、更新时间、健康和权限来源 | 只有真实 SSH/远端回读后才允许交还控制权 |

当需要用户登录、2FA、验证码、支付或高影响网站操作时：

1. 代理发送短说明和原因。
2. 电脑视图进入 `user-control`。
3. 明确“交还给代理”按钮与当前 session/run。
4. 回收后写入事件和 evidence；不得只靠一张截图宣称完成。

## 5. 对参考项目的取舍

### Grok Bot（设计输入，不把体验叙述当作官方事实）

采用：通讯式短消息、Master 作为单一入口、并行任务可同时推进、把复杂动作隐藏在结果卡片后、电脑作为可交还的执行面。

保留反例：状态过于隐蔽会让用户误以为卡死；514 Bot 必须有明确的 `queued / running / waiting for you / blocked / complete` 轻状态行、首个响应时间和可展开回放。

关于“Grok Bot 官方独立桌面端、Team/电脑和 weekly usage”这类说法，当前外部 MCP 检索未拿到可稳定回读的官方页面，不能写入产品事实或承诺。

### Codeg（本地快照 `.scratch/codeg`）

采用：会话聚合、项目/会话列表、自动化、市场、文档与多 Agent 入口的能力类别。

不采用：把文件树、终端、Git 交付铺成默认主界面；这会把 514 Bot 拉回 IDE/控制面板。

### LiveAgent（本地快照 `.scratch/LiveAgent`）

采用：local-first、MCP/Skills、持久化记忆、托管进程、sub-agent/worktree 和 Gateway/远程能力的分层思想。

不采用：引入第二个 Gateway/持久化真源；514cc 已有 Node control plane、bus 和 Tauri 壳。

### Codex / DeepSeek harness

当前可验证的本地参考更适合作为“harness 机制”而非品牌 UI：

- thread/turn/item 或 session/message/tool 的事件模型；
- approval、sandbox、worktree、resume、streaming 和 artifact；
- provider-agnostic adapter 与可测试的任务包。

“DeepSeek harness”不是仓库内已锁定的单一产品名；不能把 AutoGen、CrewAI、Open Interpreter 或模型仓库混写成一个官方项目。它们可作为后续 provider/harness 研究对象，不作为当前架构依赖。

## 6. 现有模块迁移映射

| 现有模块 | v43 归宿 | 处理 |
|---|---|---|
| `orchestrator.mjs` / adapters | 代理电脑与任务内核 | 保留，补 Bot read model |
| `bus` / Inbox / attention | 对话内 attention 卡与代理状态 | 保留真源，改默认呈现 |
| `conversation-stream` / composer | Bot 聊天主面 | 重构 DOM/CSS，不重写事件协议 |
| `run-rail` / project tree | 代理通讯录 + 任务线程二级层 | 降级为当前代理内的历史线程 |
| Mission Control 右栏 | 代理信息/电脑/证据工具栏 | 复用 registry，改标题与入口 |
| `market-panel` | Plugins tab 与对话内插件卡 | 复用 API 和安装门闩 |
| `appearance` | 五 tab 的 Appearance | 保留三主题真实状态 |
| `hosts-panel` / environment | 电脑视图的数据源 | 只显示有证据的 local/remote 状态 |
| Tauri supervisor | 常驻桌面生命周期 | 保留，不增加第二运行时 |

## 7. 第一条实现切片（Bot Shell v0）

### 目标

打开应用 3 秒内能读出“这是代理聊天桌面”，并可完成：

1. 切换 Master / 烛 / 织三个示例代理；
2. 发送一条消息，走现有 composer/run 入口；
3. 在消息流看到普通消息 + question 卡 + running 状态；
4. 打开/关闭代理信息面板；
5. 看到电脑预览占位，并明确 `not-provisioned`；
6. 从账号按钮、Cmd/Ctrl+,、命令面板进入五 tab 设置；
7. 切换 System / Light / Dark；
8. 在 Plugins 看到搜索框、分类 chip、Add/Uninstall/Authenticate 结构。

### 约束

- 不删除现有 Workbench；通过 `bot` 入口和兼容路由渐进迁移。
- 不新增第二套 run、message、agent、provider 或 settings 持久化 schema。
- 不实现假远程桌面；预览占位必须标三态。
- 不在这一切片里做全量插件安装、远程认证、云端电脑迁移或 updater。

### 验收证据

- 源码/契约：DOM roles、键盘路径、状态枚举、卡片 payload。
- focused tests：代理切换、消息发送桥、问答卡确认、面板开关、五 tab、主题。
- 浏览器：1440x900、1024x768、390x844；无横向溢出；消息底部锚定；状态不重叠。
- Tauri：桌面壳启动、隐藏到托盘、再次唤起；仍只拉起一个 Node 内核。
- 诚实边界：未执行真实 provider/SSH/登录时，交付状态标为 `partial`。

## 8. 非目标与风险

- 不把 Grok 的品牌、文案、logo 或未核实的云端能力复制进 514 Bot。
- 不把“隐藏技术细节”理解为隐藏审批、失败、成本未知或用户接管状态。
- 不把桌面窗口做成 IDE；代码编辑、终端、文件树只能作为代理电脑/工具卡的二级面。
- 不在没有签名信任根时开放任意插件、Skill、MCP 或 updater 一键安装。
- 不用静态截图、测试全绿或 HTTP 自述替代真实运行态回读。

## 9. 事实来源

- 本仓 `apps/control-center/`、`apps/desktop/` 当前源码与 README（2026-08-22 读取）。
- 本仓 `.scratch/codeg/README.md` 与 `.scratch/LiveAgent/README.zh-CN.md`（固定本地快照，版本/提交以各自文件为准）。
- 本仓 `proposals/v35-deep-collab-design.md`、`proposals/v42-control-center-product-roadmap.md`、近期 handoff（项目历史决策与验证边界）。
- LO 提供的两张截图和 Grok Bot 体验文字（设计输入；不是独立事实来源）。
- MCP Grok Search 2026-08-22 discovery：未能稳定读取官方 Grok Bot 桌面/Team/电脑页面；因此相关事实保持未证实。

## 10. 决策请求

本文件不需要改变后端内核方向。进入实现前只需要 LO 确认一个产品决策：

> **是否把 `bot` 作为默认桌面入口，同时保留 `#/workbench` 作为高级控制台兼容入口？**

推荐答案：是。这样可以先改变“用户第一眼看到什么”，而不牺牲已验证的治理和恢复面。

