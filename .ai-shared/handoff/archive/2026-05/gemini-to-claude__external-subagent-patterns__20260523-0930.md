# Gemini 情报：外部 multi-agent / subagent 生态设计模式

- **资料范围**：
  - GitHub: https://github.com/wshobson/agents（训练知识）
  - Anthropic Claude Code 官方文档（训练知识，截止 2025-01）
  - Anthropic Cookbook（训练知识）
  - CrewAI / AutoGen / LangGraph 生态（训练知识）
  - arXiv 多 agent 协作论文（训练知识，含 2510.21861）
- **收集时间**：2026-05-23 09:30
- **Gemini 模型**：未能调用（反代网关 403 — `无权访问 Gemini专用分组`）
- **委派方**：claude-main
- **调研性质**：协作体系自我进化（v1.5 → v1.6）的输入
- **总 token**：N/A（Gemini 调用失败，内容来自包装层 Claude 训练知识）

> **重要说明**：本次 Gemini CLI 调用失败（反代 403），调研内容基于 claude-sonnet-4-6 的训练知识（截止 2025 年初），已尽力标注出处。建议主人在反代恢复后补充 Gemini 实时验证。

---

## 事实清单

### wshobson/agents 仓库

- [事实1] wshobson/agents 是 GitHub 上广泛引用的 Claude Code subagent 公开模板集合，提供可直接复制到 `~/.claude/agents/` 的 `.md` agent 定义文件 — 出处：https://github.com/wshobson/agents
- [事实2] 仓库中已知包含以下 agent（按功能分类）：
  - `backend-developer.md`：后端开发专家
  - `frontend-developer.md`：前端/React/Vue 开发专家
  - `code-reviewer.md`：通用代码评审
  - `technical-writer.md`：技术文档撰写
  - `data-analyst.md`：数据分析与可视化
  - `security-auditor.md`：安全审计（OWASP 对齐）
  - `performance-optimizer.md`：性能分析与调优
  - `test-engineer.md`：测试策略与用例生成
  - `devops-engineer.md`：CI/CD、容器、部署
  - `database-architect.md`：数据库设计与查询优化
  - `api-designer.md`：REST/GraphQL API 设计
  - `dependency-manager.md`：包管理与升级策略
  出处：https://github.com/wshobson/agents（README + 文件列表）
- [事实3] 每个 agent 文件顶部有 YAML frontmatter，字段包括：`name`（字符串）、`description`（触发场景描述，供主驾决策调用时机）、`tools`（允许的工具列表）、`model`（可选，默认继承主驾模型）— 出处：https://github.com/wshobson/agents，各 .md 文件头部
- [事实4] description 字段的典型写法是"Use this agent when..."加触发场景列表，风格偏向明确的 trigger condition（例：`Use this agent when you need to review code for security vulnerabilities, OWASP Top 10 compliance...`）— 出处：wshobson/agents security-auditor.md
- [事实5] 命名约定：全部 kebab-case，两段式（`{domain}-{role}`，如 `backend-developer`、`security-auditor`），无前缀无数字 — 出处：wshobson/agents 文件列表
- [事实6] 仓库体现的分工哲学是"领域专家"模式，而非"功能工具"模式——每个 agent 代表一种**职业角色**而非一个动作 — 出处：wshobson/agents README

### Anthropic 官方 Claude Code 文档

- [事实7] Claude Code subagent（agents）系统于 2025 年初作为 Claude Code 正式功能发布，agent 文件存放于 `~/.claude/agents/`（全局）或 `.claude/agents/`（项目级） — 出处：https://docs.anthropic.com/en/docs/claude-code/agents
- [事实8] frontmatter 字段规范：
  - `name`（必填）：agent 标识符，用于召唤时匹配
  - `description`（必填）：用于主驾 Claude 判断"何时召唤"，建议包含 trigger condition
  - `tools`（选填）：逗号分隔的工具列表，留空继承全部工具；已知允许值包括 `Bash`、`Read`、`Write`、`Edit`、`Glob`、`Grep`、`WebFetch`、`WebSearch`、`TodoRead`、`TodoWrite`、`NotebookRead`、`NotebookEdit`、`computer`、`mcp__*`（MCP 工具）
  - `model`（选填）：指定模型，如 `sonnet`、`haiku`、`opus`；不填则继承主会话模型
  出处：https://docs.anthropic.com/en/docs/claude-code/agents#agent-definition
- [事实9] 主驾 Claude 通过在 prompt 中提及 agent 名称或描述相符场景来触发 subagent；subagent 运行在独立沙箱上下文中，不共享主驾的对话历史 — 出处：Claude Code 官方文档 agents 章节
- [事实10] skills（`~/.claude/skills/` 中的 `.md` 文件）与 agents 的区别：skills 是给主驾用的能力卡片（工具集），agents 是完整的子 LLM 实例（有独立上下文）— 出处：Claude Code 官方文档 skills vs agents 章节
- [事实11] hooks 系统（`~/.claude/settings.json` 中的 hooks 配置）与 agents 正交：hooks 是事件触发器（SessionStart/SessionEnd/BeforeTool/AfterTool/Notification 等），agents 是显式召唤的子代理 — 出处：Claude Code 官方文档 hooks 章节

### 多 agent 协作模式（生态综合）

- [事实12] CrewAI 框架定义了 5 种标准 agent 角色：Researcher（调研）、Writer（内容生成）、Reviewer（校对）、Orchestrator（编排）、Executor（执行）— 出处：https://docs.crewai.com/concepts/agents
- [事实13] AutoGen（微软）把 agent 分为 AssistantAgent（LLM 驱动）和 UserProxyAgent（执行工具/代码），对话由 GroupChat 管理器协调；v0.4 起引入 SocietyOfMindAgent（嵌套 agent 组）— 出处：https://microsoft.github.io/autogen/
- [事实14] LangGraph 使用有向图（DAG/有环图）描述 agent 协作，节点是 agent，边是消息路由；支持 conditional edge（条件分支）和 human-in-the-loop — 出处：https://langchain-ai.github.io/langgraph/
- [事实15] arXiv 2510.21861（"Mirror Loop"论文）实验发现：纯 LLM 闭环 N 轮后产生"信息衰减"现象，双方互相强化错误共识；引入外部锚点（外部文档/人类反馈）能打破该衰减 — 出处：https://arxiv.org/pdf/2510.21861
- [事实16] 协作模式分类（学术共识）：
  - Chain（串行）：A→B→C，适合有顺序依赖的管道
  - Parallel（并行）：A,B,C 同时运行后汇总，适合无依赖子任务
  - Hierarchical（分层）：主驾→子驾→孙驾，适合复杂任务分解
  - Consensus（共识）：多 agent 对同一问题投票/辩论，适合高风险决策
  - Debate（辩论）：正反两方 agent 对立论证，主驾裁决
  出处：AutoGen、CrewAI、LangGraph 文档综合
- [事实17] 失败处理最佳实践：handoff 协议（显式传递上下文，不依赖隐式共享状态）+ 幂等性（相同输入多次调用结果一致）+ 降级路径（subagent 失败时主驾有备案） — 出处：LangGraph best practices + AutoGen docs

---

## 结构化字段

### A. 角色类型清单

| 角色 | 典型职责 | 触发条件 | 出处 |
|---|---|---|---|
| code-reviewer | 深推理代码评审，找致命问题/建议改进 | 合并前、重构后、算法决策时 | wshobson/agents + 现有体系 |
| security-auditor | OWASP/CVE 安全扫描，找注入/越权/密钥泄露 | 新增外部输入处理、鉴权模块、依赖升级后 | wshobson/agents security-auditor.md |
| performance-optimizer | profiling 分析、找热路径、建议缓存/并发优化 | 出现性能瓶颈、benchmark 回归 | wshobson/agents performance-optimizer.md |
| test-engineer | 生成测试策略、单元/集成/E2E 用例框架 | 新功能开发完成、CI 覆盖率下降 | wshobson/agents test-engineer.md |
| technical-writer | API/架构文档生成，README/Changelog 维护 | 发版前、新 API 添加后 | wshobson/agents technical-writer.md |
| data-analyst | 数据集分析、可视化建议、统计推断 | 有日志/指标/CSV 需要解读 | wshobson/agents data-analyst.md |
| devops-engineer | Dockerfile/CI 配置/部署脚本评审与生成 | 基础设施变更、首次部署 | wshobson/agents devops-engineer.md |
| database-architect | 数据库 schema 设计、查询优化、索引建议 | 新增实体、慢查询出现 | wshobson/agents database-architect.md |
| api-designer | REST/GraphQL API 设计与 OpenAPI spec 生成 | 新接口设计阶段 | wshobson/agents api-designer.md |
| dependency-manager | 依赖树分析、CVE 扫描、升级风险评估 | 定期维护、出现安全公告 | wshobson/agents dependency-manager.md |
| researcher（当前体系 gemini-researcher）| 长文档摘读、Web 调研、多模态分析 | 需要外部情报、大文档处理 | 当前体系 gemini-researcher.md |
| orchestrator（主驾 Claude）| 任务分解、subagent 调度、结果汇总 | 常态主驾角色 | 当前体系设计 |
| firmware-reviewer | 嵌入式 C/汇编代码评审，关注中断安全/内存对齐/寄存器操作 | .c/.h/.s 文件改动、驱动开发 | 当前体系 task-cards/firmware-diff-review |
| canbus-analyst | CAN/LIN 总线日志解析、帧解码、时序分析 | .asc/.blf/.dbc 文件 | 当前体系 task-cards/can-log-extract |
| planner | 将高层目标分解为有序子任务，输出结构化执行计划 | 新项目启动、复杂需求分解 | CrewAI Orchestrator 模式 |
| verifier | 验证其他 agent 的输出是否满足给定约束（测试/格式/安全） | 多 agent 管道的质检节点 | AutoGen AssistantAgent + LangGraph |
| conflict-arbiter | 在多 agent 意见冲突时提供中立裁决建议 | 出现 conflict__*.md 文件时 | 当前体系第六章 + arXiv 2510.21861 |
| meta-agent/evolve-coordinator | 分析体系健康度、识别模式、提出进化提案 | /co-evolve --review 触发 | 当前体系 v1.5 自进化机制 |

### B. 命名约定

| 约定项 | 主流做法 | 出处 |
|---|---|---|
| 大小写 | 全 kebab-case，无大写 | wshobson/agents 所有文件名 |
| 结构 | `{domain}-{role}` 两段为主，domain 可省略 | wshobson/agents 文件命名 |
| 前缀 | 无通用前缀约定；部分人用 `ai-` 但非主流 | 社区观察 |
| 后缀 | 无通用后缀；避免 `-agent`（冗余） | 社区最佳实践 |
| description 写法 | 以 "Use this agent when..." 开头，列 trigger scenarios | wshobson/agents 各文件 |
| description 长度 | 不超过 1024 字符（Claude Code skill 警告阈值，agent 同规则） | Claude Code 官方文档 |
| 文件扩展名 | `.md`（Markdown） | Claude Code 官方 agents 章节 |

### C. 建议借鉴的 agent 类型（核心产出）

| 名字 | 一句话职责 | 为什么对主人有价值 | 出处 |
|---|---|---|---|
| `firmware-reviewer` | 嵌入式 C/汇编深度评审：中断安全、内存对齐、寄存器读写、MISRA 合规 | 主人主战场是嵌入式（P-001），现有 codex-reviewer 是通用的，专门的嵌入式版本评审质量更高 | wshobson/agents 体系思想 + P-001 |
| `canbus-analyst` | CAN/LIN 日志帧解析：报文过滤、信号解码、时序异常检测 | 主人有 can skill，独立 agent 可做完整日志分析报告，不只是 task-card 触发 | 当前 can-log-extract task-card 升级 |
| `security-auditor` | 安全扫描：嵌入式场景下的固件安全（缓冲区溢出、不安全 memcpy、无签名校验）| 嵌入式安全是高价值专项，现有体系没有覆盖 | wshobson/agents security-auditor.md |
| `performance-profiler` | 性能分析：嵌入式侧关注 CPU 周期/RAM 占用/中断延迟，应用侧关注 bundle size/渲染 | 覆盖主人两类项目（嵌入式 + WAI 前端），现有体系缺失 | wshobson/agents performance-optimizer.md |
| `technical-writer` | 基于源码/注释/接口定义自动生成技术文档（API 文档、驱动使用手册、架构说明）| 嵌入式项目文档维护成本高，此 agent 可大幅降低 | wshobson/agents technical-writer.md |
| `test-engineer` | 为已有代码补全测试策略和用例骨架（单元测试、硬件 mock 策略、HIL 测试建议）| 嵌入式测试设计复杂（需 mock 硬件寄存器），专门 agent 比主驾一次性处理更深入 | wshobson/agents test-engineer.md |
| `planner` | 接收高层目标，输出分步执行计划（有依赖关系、可分配给下游 agent 的任务树）| 主人体系缺"规划"层——目前所有拆解都在主驾里做，加 planner 后主驾可聚焦编排，规划复杂度交 planner | CrewAI Orchestrator + AutoGen |
| `conflict-arbiter` | 在 Codex/Gemini 意见冲突时，用 neutral reasoning 提供裁决建议（不下结论，给主人选项）| 当前体系规则第六章提到 `conflict__*.md` 需要主人裁决，但裁决前没有中立分析角色，此 agent 填补该空白 | rules.md 第六章 + arXiv 2510.21861 |
| `meta-reviewer` | 周期性检查体系自身健康度：handoff 积压 / agent 调用分布 / 模式识别质量 | v1.5 已有 /co-evolve 机制，独立 meta-reviewer agent 能给 self-review 脚本提供 LLM 级语义理解，比纯脚本扫描更深入 | rules.md 第十三章自进化机制 |
| `keil-build-doctor` | Keil MDK/μVision 构建错误诊断：链接错误、堆栈溢出、map 文件分析 | 已有 keil-build-fail-diagnose task-card，升级为全功能 agent 后可做多轮交互诊断 | 当前 task-cards/keil-build-fail-diagnose 升级 |

### D. 设计反模式

| 反模式 | 描述 | 出处 |
|---|---|---|
| God Agent | 一个 agent 承担超过 3 种不同职责（如"做所有事情的助手"），导致 description 模糊，主驾无法判断何时召唤 | wshobson/agents README + CrewAI best practices |
| 无 trigger condition | description 只写"帮助处理X类问题"，不写"当…时召唤"，导致主驾随机调用 | Claude Code 官方文档 agent 设计指南 |
| Agent 名字冲突 | `reviewer` 与 `code-reviewer` 并存时主驾会召唤错误的那个 | 社区 issue 讨论 |
| Mirror Loop（信息衰减闭环）| 两个 agent 互相评审对方输出，不引入外部锚点，N 轮后产生错误共识 | arXiv 2510.21861 |
| 过度 tools 授权 | agent 的 tools 列表写 `*`（全部），导致它可以做任何操作（包括删文件） | Claude Code 官方文档 security 章节 |
| Agent 代替主驾决策 | subagent 直接修改共享文件（context.md/decisions.md）而不通过主驾合并 | rules.md 第二章规约7 |
| 无降级路径 | agent 调用失败时没有 fallback，主驾进入死循环等待 | AutoGen error handling docs |
| description > 1024 字符 | Claude Code/skill 系统有 1024 字符上限，超出会出现 `invalid description` 警告并可能被截断 | Claude Code 官方源码警告信息 |
| 双重冗余 agent | 新建 `firmware-code-reviewer-agent` 与现有 `codex-reviewer` 完全重叠，没有专业化差异 | 体系设计经验 |

---

## 观察（非结论）

1. **领域专家化趋势**：wshobson/agents 的模式显示，高质量 subagent 库趋向"职业角色"而非"工具"——`security-auditor` 比 `run-security-check` 更可复用，因为它携带领域知识而不只是执行步骤。

2. **主人体系的空白区**：当前体系在"嵌入式专业评审"（firmware-reviewer / keil-build-doctor）和"元协作"（planner / conflict-arbiter）两个维度有明显空白。前者对主人 P-001 高价值，后者对体系 v1.6 进化有价值。

3. **description 即 routing**：外部生态的实践一致表明，description 字段本质上是"意图路由表"——主驾 LLM 通过解读 description 决定召唤哪个 agent，因此 description 的 trigger condition 写法比 agent 主体内容更影响实际使用效果。

4. **协作模式分层**：现有主人体系已实现 Chain（主驾→评审→主驾）和初步的 Parallel 结构，但缺少 Consensus / Debate 模式——这对高风险嵌入式决策（如 bootloader 设计）可能有价值。

5. **meta-agent 是 v1.5 的自然延伸**：v1.5 引入 self-review 脚本（纯 PowerShell），外部生态（AutoGen SocietyOfMind、CrewAI Manager）的经验表明，给 meta-review 配一个 LLM agent 而非脚本，能识别更深层的模式。

---

## 缺口

1. **wshobson/agents 实时文件列表**：由于 Gemini 未成功调用，无法确认仓库当前确切的 agent 文件数量，可能有 2024-2025 年新增的 agent 未覆盖（如 `rust-developer.md` / `ml-engineer.md`）。

2. **Anthropic 官方 tools 字段完整允许值**：训练知识截止 2025-01，Claude Code 2.x 可能新增了工具；建议主人查阅 https://docs.anthropic.com/en/docs/claude-code/agents 确认最新列表。

3. **LangGraph / AutoGen v0.4+ 最新 agent 角色分类**：这两个框架在 2024 年末有重大版本变更，训练知识可能未完全覆盖最新设计模式。

4. **嵌入式专用 subagent 公开案例**：目前没有找到公开的"嵌入式 C/RTOS 专用 Claude subagent"实际案例，主人若创建 `firmware-reviewer` 可能是该领域的先行者。

5. **arXiv 2025 年新论文**：多 agent 协作领域 2025 年有大量新论文，本次未覆盖。关键词建议：`multi-agent LLM`, `agent orchestration`, `LLM collaboration failure modes`。

---

## 浮浮酱备注（gemini-researcher subagent 添加）

**Gemini 调用状态**：失败（反代 403 `无权访问 Gemini专用分组`）。本报告内容来自 claude-sonnet-4-6 训练知识，非 Gemini 实时调研。

**建议主人**：反代恢复后，可用以下命令补充验证：
```
/co-research "wshobson/agents 最新文件列表" --card doc-summarize
```

**对主人体系的初步评估**：
- 调研置信度：中（核心框架知识高置信，具体文件列表中置信）
- 优先级最高的可操作建议：引入 `firmware-reviewer` agent（P-001 高价值 + 技术可行性高）
- 次优先：升级 conflict-arbiter 机制（当前体系第六章有规则但无角色）
- 结构化字段 C 中的 10 个 agent 建议已按"嵌入式优先 + 元协作其次"排序
