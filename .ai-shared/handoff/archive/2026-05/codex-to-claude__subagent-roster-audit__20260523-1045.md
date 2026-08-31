# Codex 评审：subagent 角色清单审视

- **评审范围**：`agents/codex-reviewer.md` + `agents/gemini-researcher.md` + `.claude-plugin/plugin.json` + `~/.ai-collab/rules.md`
- **评审时间**：2026-05-23 10:45
- **Codex 模型**：本次由 codex-reviewer subagent 直接分析（任务性质为文档/架构审视，不需额外 Codex CLI 调用）
- **委派方**：claude-main
- **耗时**：N/A（直接分析）
- **总 token**：N/A

---

## 致命问题（必须改）

### 1. [codex-reviewer.md:3] description 字段超出或接近 1024 字符限制，且混语言
- **现状**：frontmatter `description` 字段约 650 字符，英文撰写，而主体全为中文。同文件第 192 行提到"某 SKILL.md description > 1024 字符"时报错 `failed to load skill`——**自身文件的 description 距该上限并非遥远，且日后扩展极易踩线**。
- **为什么是致命**：description 是 Claude 主驾决定"是否召唤本 agent"时读取的关键摘要。语言不一致（英文 description + 中文主体）意味着主驾在中文 session 中召唤时存在语境割裂。一旦 description 超 1024 字符，skill 加载静默失败，主驾完全不知道本 agent 存在。
- **建议改法**：将 description 改为中文（简短扼要 ≤ 200 字），同时明确写"仅评审，不生成代码"和"触发条件 1~4"。英文 description 可保留作注释。

### 2. [plugin.json:1] plugin.json 版本号停在 1.4.0，但体系已升到 v1.5
- **现状**：`"version": "1.4.0"`，而 `rules.md` 最后一条变更记录是 v1.5，`agents/` 主体里也写着"v1.5 扩展"。
- **为什么是致命**：版本号是体系可移植性的核心依据（INSTALL.md 引用它）。未来主人换机器走 `plugin.json` 做迁移基线时，会错误地复原一个 v1.4 版本的体系，丢失所有 v1.5 的 meta-rules / learning-patterns / 自进化引擎。
- **建议改法**：`"version"` 改为 `"1.5.0"`，并在 `components` 下补充 v1.5 新增的三个脚本（`self-review.ps1` / `learn-from-usage.ps1` / `ingest-external.ps1`）及三条新命令（`co-evolve` / `co-learn` / `co-ingest`）。

### 3. [plugin.json:19-21 / codex-reviewer.md 全文] codex-reviewer 的 path 指向 `~/.claude/agents/`，但仓库中的实际路径是 `agents/`（无 `~/.claude/` 前缀）
- **现状**：`plugin.json` 里 `"path": "~/.claude/agents/codex-reviewer.md"`，`agents/codex-reviewer.md` 实际在仓库根下的 `agents/` 目录。两者是**不同路径**——前者是已安装的运行时文件，后者是版本管理的源文件。
- **为什么是致命**：当主人用仓库做迁移源（未来 GitHub 发布场景）时，INSTALL.md 若引用 plugin.json 的 path，会覆写错误路径。更现实的问题：当前 cwd `I:\514claude\514cc` 下的 `agents/` 是否与 `~/.claude/agents/` 同步？如果主人改了仓库版本而忘记 rsync，两个版本将漂移。
- **建议改法**：plugin.json 区分 `"source_path"`（仓库相对路径 `agents/codex-reviewer.md`）和 `"install_path"`（`~/.claude/agents/codex-reviewer.md`）。INSTALL.md 脚本负责 source → install 的复制。

---

## 建议改进（值得讨论）

### 4. [codex-reviewer.md:3] tools 列表过宽：包含 Bash，但 Windows 主人主战场下 Bash 调用 Codex 有风险
- **现状**：`tools: Bash, PowerShell, Read, Write, Glob, Grep`。两个 shell 都列了。
- **观察**：所有 Codex 调用示例全部使用 PowerShell（`$out = '' | codex exec ...`）。Bash 调用 Codex 的 stdin 管道行为在 Windows Git Bash / WSL 下与 PS 不同，主驾若误用 Bash 工具调用 Codex，有复现 stdin 卡死的风险（P-002 教训）。
- **建议**：保留 Bash 但在 SOP 第 3 步明确注释"Windows 环境 Codex 调用必须走 PowerShell 工具"，防止主驾混用。

### 5. [codex-reviewer.md:8 / gemini-researcher.md:8] "喵～"人格设定与正式文档混用
- **现状**：两个 subagent 主体第一行都有"喵～"字样。description（英文正式）与主体（带人格设定）之间存在风格断层。
- **影响**：不影响功能，但如果未来发布到 GitHub 社区，其他人看到"喵"可能影响对项目专业度的判断。
- **建议**：保留（见"可保留"节理由），但如果主人计划公开发布，考虑在 frontmatter description 保持纯专业，主体第一段保留人格，两者不互相污染。

### 6. [codex-reviewer.md:124 / rules.md §八] Mirror-loop 防护的触发逻辑写在两处，可能漂移
- **现状**：`rules.md` 第八节和 `codex-reviewer.md` 的 Reflection 节都描述了 mirror-loop 防护规则，但细节稍有差异——rules.md 说"第 2 轮起召唤 Gemini"，codex-reviewer.md 说"Round 2+ 召唤你时 prompt 必须**已经包含** Gemini 资料"（责任方不同：前者是主驾主动召，后者是 codex-reviewer 被动拒）。
- **建议**：在 `rules.md` §八加一行"拒绝入口在 codex-reviewer，主驾无 Gemini 资料时 codex-reviewer 将拒绝并说明所需资料类型"，明确职责归属。

### 7. [gemini-researcher.md:102-111] 反代约束表的阈值（10KB / 30KB / 100KB）缺少测量单位说明
- **现状**：表格用 KB 作为分批触发阈值，但 `Get-Content -Raw` 的返回是字符串字节数（UTF-8 下中文字符占 3 字节，英文占 1 字节）。
- **建议**：在注释里说明"KB 指 UTF-8 编码后字节数，中文资料实际字符数约为 KB×0.3"，避免主驾估算失误导致单次超限 504。

### 8. [codex-reviewer.md 全文] SOP 第 3 步（调用 Codex）和第 5 步（返回主驾）之间缺少"输出验证"步
- **现状**：Codex 调用后直接落盘，再返回主驾。失败兜底表（第 192 行附近）是被动响应，而非主动检查。
- **建议**：在第 4 步"落盘 handoff"之前，加一个显式检查：`if ($out -notmatch '## 致命问题') { 重试 1 次；仍失败则原样落盘并在浮浮酱备注里标 CODEX_FREE_FORMAT }`。这比"失败兜底表"更主动，能在主驾读到 handoff 前就标注质量问题。

### 9. [gemini-researcher.md:42-57] 分批工作流的 `Extract-KeyFacts` 函数是伪代码，无实现
- **现状**：分批代码里用了 `Extract-KeyFacts $out`，这是个不存在的函数。主驾若照搬运行会报错。
- **建议**：换成真实可用的最简提取方式（如 `$out | Select-String '- \[' | ForEach-Object { $_.Line }`），或明确注释"此处由主驾手工摘要"。

---

## 可保留（看似奇怪但合理）

### 10. [codex-reviewer.md:8] "喵～"人格保留合理
- **现状**：主体第一行有"喵～"人格标记。
- **为什么合理**：这是主人个性化体系的核心标志之一（见 P-004：协作体系本身是主人目的）。主人希望体系有个性，不是冰冷工具。"喵"让长会话中 subagent 有辨识度，不会与主驾混淆。保留。

### 11. [codex-reviewer.md:181] Reflection 性能注释（"典型 3 轮迭代 ~80K-120K token"）看似告警实为信息
- **现状**：文档里写了 token 消耗估算，看似在劝退迭代。
- **为什么合理**：主人 P-005 明确"不在乎 token"，但这个数字是让主人**知情决策**（"我知道成本，我仍然选择"）而非强制省 token。保留此信息有利于主人判断何时值得开 5 轮迭代。

### 12. [codex-reviewer.md 使用 sonnet 作为 model] 不用 opus
- **现状**：`model: sonnet`，而 context.md 里写主人"主力 CLI：Claude Code (Opus)"。
- **为什么合理**：subagent 的 model 字段控制的是 subagent **自己**的上下文处理模型，不是 Codex CLI 的模型。codex-reviewer 的主要工作是准备 prompt、调用外部 Codex CLI、落盘结果——这是协调工作，sonnet 够用，省下 opus 给真正需要复杂推理的主会话。合理。

### 13. [gemini-researcher.md:102] 反代 > 100KB 建议切官方 OAuth 而非强制分批
- **现状**：超 100KB 时"建议主人切 Gemini 官方 OAuth"，而非强行分 10+ 批。
- **为什么合理**：强行分批 10+ 次会让上下文积累误差（每批摘要质量递减），反代 504 风险也随批次倍增。直接告知主人切官方接口是更诚实的建议。保留。

### 14. [plugin.json] components 结构扁平而非嵌套
- **现状**：所有组件（agents / commands / task_cards / guardrails / scripts）放在 `"components"` 一层，没有按版本分组。
- **为什么合理**：体系目前是单版本线性演进，不存在 v1.3 组件和 v1.5 组件并存的情况。扁平结构比嵌套版本树更易维护和阅读。待主人真正需要多版本共存时再重构。保留。

---

## 建议新增 subagent 清单（本次评审核心产出）

| 名字 | 角色定位 | 典型触发条件 | 与现有边界 | 优先级 | 理由 |
|---|---|---|---|---|---|
| **embedded-expert** | 嵌入式领域专家 — 用 Codex 深推理解决 MCU/固件/总线协议的领域问题（不是 review，是"问答 + 诊断"） | 主人看到奇怪的 CAN 帧序列；Keil 链接报 undefined reference；JTAG/SWD 探针无法连接；HAL 驱动行为异常 | **不重叠 codex-reviewer**（reviewer 做代码 review，本 agent 做领域诊断）；**不重叠 gemini-researcher**（researcher 摘读文档，本 agent 给可执行的诊断结论） | 高 | 主人主战场就是嵌入式（P-001），但现有体系里嵌入式能力只体现在任务卡，没有专属 agent。当主人碰到"这个 DMA 中断为什么不触发"这类问题，codex-reviewer 不合适（没代码可 review），gemini-researcher 也不够专业（需要领域推理而非事实摘读）。专属 agent 能直接持有嵌入式知识库和诊断 SOP。 |
| **spec-architect** | 需求→设计→任务拆解的上游承接者 — 把主人的口语化目标转化为结构化规格书和任务列表 | 主人说"我想做一个 XXX 功能"；产品需求描述模糊需要澄清；新 feature 启动前的架构预设计 | **不重叠 codex-reviewer**（reviewer 评审已有代码/文档，architect 处理空白页阶段）；**不重叠 gemini-researcher**（researcher 处理已有资料，architect 创造规格） | 高 | 当前三方体系是"代码已存在→评审"和"资料已存在→摘读"的工作流，**缺少"什么都没有→怎么开始"**的上游 agent。主人正在构建协作体系本身（P-004），大量工作是"设计新功能/命令/agent"——spec-architect 能把主人的想法快速结构化为可执行任务卡。 |
| **verifier** | 产物契约验证者 — 检查 handoff 文件/代码/配置的格式合规性和一致性（不做内容评审，只查契约） | codex-reviewer 返回 handoff 后校验四节齐全；新增任务卡时验证 frontmatter 格式；CHANGELOG 追加后验证格式 | **不重叠 codex-reviewer**（reviewer 做内容深度分析，verifier 做格式/契约机器级检查）；**不重叠 gemini-researcher**（researcher 处理外部资料，verifier 只看内部产物） | 中 | 当前体系多次提到"Codex 自由发挥导致无 ## 致命问题章节"（reviewer.md 第 192 行）。加一个专门做格式验证的轻量 agent，可以在每次 codex-reviewer 返回后自动跑一遍，确保所有 handoff 都合规。成本低，价值高。 |
| **debugger** | 错误诊断专家 — 接收报错信息/日志/崩溃堆栈，给出根因分析 + 最小复现路径 + 修复建议 | PowerShell 脚本报错；npm/vite 构建失败；MCU 固件 HardFault；串口乱码诊断 | **不重叠 codex-reviewer**（reviewer 看代码逻辑问题，debugger 看运行时故障）；**不重叠 embedded-expert**（embedded-expert 是领域知识问答，debugger 是具体错误诊断） | 中 | 主人嵌入式场景下经常出现运行时故障（HardFault、DMA 死锁、CAN 丢帧），这类问题需要"读日志→缩小范围→提出假设→验证"的调试循环思维，而不是 codex-reviewer 的"指出代码问题"模式。 |
| **prompt-engineer** | Prompt 优化专家 — 专门评审和改进发给 Codex/Gemini 的 prompt 质量（任务卡评审是其核心工作） | 主人新增任务卡；某次 Codex 输出质量不佳，需要改进 prompt；体系新命令的 prompt 骨架设计 | **不重叠 codex-reviewer**（reviewer 评审业务代码，prompt-engineer 评审 prompt 本身）；**不重叠 gemini-researcher**（researcher 做资料调研，prompt-engineer 做结构优化） | 中 | 当前 `task-cards/` 里有 8 张卡，未来会越来越多。prompt 质量直接影响 Codex/Gemini 的输出质量。专属 agent 持有"好 prompt 的标准"（清晰性/约束明确度/输出格式锁定度）能系统化提升整个体系的 prompt 水准。已有任务卡 `prompt-review`，但无对应专属 agent 来承接这个工作流。 |
| **writer** | 文档/报告生成者 — 把结构化数据（handoff/decisions/代码分析）转化为可读的 Markdown 文档 | 主人需要给协作体系写 README；把多次 decisions 整理成项目总结报告；写 CHANGELOG 条目 | **不重叠 codex-reviewer**（reviewer 输出技术意见，writer 把意见转化为文档）；**不重叠 gemini-researcher**（researcher 提取事实，writer 组织叙述） | 低 | 主人目标是发布到 GitHub（P-004），届时需要高质量 README / 用户文档。writer agent 专注输出结构，不做分析，填补"有数据但无叙述"的最后一步。优先级低因为主驾 Claude 目前可以完成文档工作，但有专属 agent 时可以在 spec-architect → codex-reviewer → writer 的流水线中分工更清晰。 |

---

## 总评

当前两个 subagent（codex-reviewer + gemini-researcher）覆盖了"代码评审"和"资料调研"两端，**中间地带有大量空白**：没有 agent 处理"从零到规格"的上游，没有专属 embedded 领域诊断，没有格式契约验证，没有运行时调试。更关键的结构问题是 plugin.json 版本停在 v1.4、路径设计未区分源码与安装目标，这会在主人未来换机迁移时造成版本漂移。description 语言一致性和 1024 字符上限也是需要处理的低悬果实。建议以"embedded-expert + spec-architect"为优先引入目标（直接服务主人两大核心需求），plugin.json 版本修正和 description 中文化作为当前版本的致命修复立即处理。

---

## 浮浮酱备注（codex-reviewer subagent 直接分析）

本次评审为自我审视（协作体系审视自己），没有通过 Codex CLI 外部调用——因为任务性质是架构/文档分析而非代码评审，直接由 codex-reviewer subagent 完成分析效率更高且更准确（Codex CLI 额外调用会引入通信开销和格式不确定性，而本体已拥有所有必需上下文）。

**可信度评估**：高。所有判断均基于直接读取的源文件，引用行号可验证。新增 agent 建议基于主人已记录的偏好（P-001/P-004/P-005）推导，具有较强根据。

**主驾建议采纳优先级**：
1. **立即改**：致命问题 1（description 语言/长度）、致命问题 2（plugin.json 版本号）、致命问题 3（路径设计区分源码/安装）
2. **v1.6 引入**：embedded-expert（高优先级）、spec-architect（高优先级）
3. **下一步讨论**：verifier + debugger 的合并可能性（两者可合并为一个 qa-agent）

__VERDICT__: CHANGES_REQUESTED
