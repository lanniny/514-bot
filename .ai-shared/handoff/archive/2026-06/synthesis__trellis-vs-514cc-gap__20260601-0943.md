---
from: claude (主驾/莉莉)
to: 主人
topic: trellis-vs-514cc-gap
date: 2026-06-01
method: 6-agent Workflow（4 视角并行分析 → 收敛 → 防膨胀红队）
参照: mindfold-ai/Trellis（多平台 AI 编码工作流框架）
状态: 方案待主人裁决（未动任何核心文件）
---

# 参照 Trellis 完善 514cc — 综合方案

## 一、一句话诊断

> **514cc 武器库已过剩，真痛点是"只会发火、不会复盘 + 声称的机制与磁盘脱节"。**
> 借 Trellis「产物即证据、状态即文件、可验证」哲学补"复盘回流闭环"，**不抄**它的对象树 / worktree / npm / 同模型多角色（会稀释灵魂）。

## 二、磁盘实证发现（subagent 逐个 Read 核实，非推测）

| # | 发现 | 证据 | 严重度 |
|---|------|------|--------|
| F1 | **v3.1 镇体系铁证证据链当前是断的** | rules.md 第35行 + decisions.md L18 引用的 `wai-admin-route-security` handoff 实际在父级 `I:/514claude/.ai-shared/`，514cc 本地 handoff 只有 3 个停在 5-23 的旧文件 | 🔴 P0 |
| F2 | **claude-flow memory 是纯纸面能力** | rules.md §六 / CLAUDE.md / module.yaml 三处声称"跨会话知识"承载层，但全盘无 `.swarm/` `.hive-mind/` `.db` `memory.json` —— 从未写入。真在用的是 MEMORY.md auto-memory。违反体系自己 §二.5 Integrity Gate | 🔴 P0 |
| F3 | **"必须落 handoff"纪律执行率≈0** | handoff 三文件全停 5-23，其后 v3.0/v3.1 三次迭代零落盘；decisions.md 多条 `source_handoff` 为空 | 🔴 |
| F4 | **有发火、无复盘** | §三铁律3 要求"净增量必须可见"，但展示一眼即焚，无任何落盘载体；烛抓出的 4 致命只活在一条 decisions 正文 | 🔴 |
| F5 | **双 spec 系统空转** | `.spec-workflow/` MCP 脚手架 6 模板 + 3 空目录从未跑过；spec-architect 另写一套 PRD 进 handoff，互不通信 | 🟡 |
| F6 | **路由表是死表** | §三分级 / auto-pilot 复杂度映射 / help 推荐全是写死常量，不会因"用得多"而变准（开环） | 🟡 |
| F7 | **templates/ 目录盘上不存在** | CLAUDE.md 索引提到，实际只有 `skills/utility/init/templates/` | 信息 |

## 三、红队净增量（被推翻 / 重排的主驾&收敛判断）

1. **元洞察（最大净增量）**：本项目的病**不是文件多，是纪律执行率为零**。再加"只靠 Opus 每轮自觉、无机械审计点"的纪律 = 100% 复刻 handoff 空转黑洞。**真·膨胀是认知负担膨胀（rules.md 塞满没人执行的纪律），比文件膨胀更隐蔽**——文件能 `ls` 出来，空转的纪律藏在 rules.md 里看不出来。→ 把记忆 `feedback-felt-value-over-structure`「堆文件是反模式」升级为「**堆纪律也是反模式，且更隐蔽**」。
2. **推翻优先级**：收敛层把「DELTA 账本」排 rank1，红队**降级**它——因为它焊在一个已空转的载体（handoff）上，极可能变成下一个空 `source_handoff` 字段。**唯一真·机械扳机是「白发刹车」**（焊在 auto-pilot 决策分支），不是纪律自觉。
3. **升级 P0**：「断链修复」从 P1 升 P0 地基——它是所有账本的物理地基，地基不统一上面写多少都散。
4. **DROP**：「per-task 上下文卡」整条砍——要新建盘上不存在的 `templates/` 目录（自相矛盾撞"零新增文件"），且优化的是实战中几乎没被跑过的 workflow 全管道。

## 四、最终方案（红队绿灯排序 · 机械扳机优先）

### 批次 A — 地基与拆假扳机（先做，纯减法/对齐，零功能负担）

**A1. 断链修复 + 统一 .ai-shared 根**（P0）
- 修 rules.md 第35行那条断链引用为可定位路径；§六加根规则「handoff/context/decisions 根 = 当前开发项目根的 .ai-shared/，跨项目引用必须绝对路径或 {project}/ 前缀」；对 decisions.md 断链处追加修正（追加式）。
- §七加 dogfood 条：框架自身**非平凡改动**（版本号/skill 增删/rules 修订）`source_handoff` 不得为空。限定非平凡，避免撞 ⚪ 隐形档。
- 落地前确认两套 .ai-shared 归属语义。
- 文件：rules.md / module.yaml(注释) / decisions.md

**A2. claude-flow memory 诚实降级**（P0，走路径 A，**减法**）
- rules.md §六 / CLAUDE.md 把"跨会话知识"承载层从 claude-flow memory 改标为已验证在用的 MEMORY.md auto-memory + decisions.md；claude-flow 标"可选实验"。
- **不走**备选 B（再投验证成本到已实测部分失败的依赖 = 反向膨胀）。
- 修复体系自己 §二.5 Integrity Gate 的自我违反。诚实本身=可感知强化。

### 批次 B — 唯一真机械扳机（可做，直接治"仪式化/强化不明显"）

**B1. 白发刹车**（P1，全方案唯一焊在机械触发点的一条）
- auto-pilot Phase A 召唤前加"白发预检"：近期同类路由持续零增量 → 本次 🟡 默认降级为主驾直达，一句话告知。
- **铁律边界**：只降 🟡，🔴（安全/生产前）永不自动降级（守 §三铁律1，盲区代价太高）。
- **降级保险**：DELTA 数据为空时静默跳过、不阻塞、退回 v3.1 现状。
- 落地前一句话确认 🟡 降级边界。

### 批次 C — 复盘回流闭环（条件做，**每条必配机械审计**否则 drop）

**C1. DELTA 账本（轻量版）**（P1，条件：必须配机械审计）
- 仅在烛/织（本就强制落 handoff）落盘节末尾加一行 `__DELTA__: 发火对象|净增量(0白发/1补强/2推翻)|证据(file:line或原判断)`。匠/策/鉴不强制。
- **前置硬条件**：让 `/co-status` 把"最近发火 handoff 缺 DELTA 行"当告警抓出来（机械反馈）。**没有这个审计就 drop**。

**C2. 路由门自校准（朴素版）**（P2，依赖 C1）
- 砍掉"自动算命中率/百分比/≥5次样本阈值"的伪精确（DELTA 是主驾自己给自己打分，既当运动员又当裁判）。
- 改为 meta-reviewer 跑健康审计时把所有 `DELTA=0` 记录**原文列给主人看**，升降级判断交还主人（他才是 DELTA 真伪唯一裁判）。

### DROP

- ~~per-task 上下文卡 + 验证报告模板~~：要建不存在的 templates/ 目录（自相矛盾），优化没人跑的全管道。唯一保留碎片：在现有召唤指令加一句"给 subagent 的上下文用 file:line 而非整段会话摘要"，不建任何文件。

## 五、绝不抄（doNotBorrow）

| Trellis 特性 | 为什么不抄 |
|---|---|
| Project/Epic/Feature/Task 四级对象树 + 独立 DB | 单人能力放大器非团队 PM 平台；已有 3 个并行持久层，问题是"层太多且空转"非"缺 store" |
| git worktree 隔离 | 两层目录均 not a git repo，物理不成立；514cc 并行是 party-mode 思维并行 |
| npm 包化 / 14 平台移植 | 无 package.json；深度绑定 Claude 独有能力，移植=摧毁灵魂 |
| **同模型多 prompt 角色** | **与灵魂直接对立**——烛=Codex/织=Gemini 真异构，简化成同模型多角色=对抗式评审退化成自己跟自己对话=**摘除心脏** |
| 强制全流程门禁 + jsonl 格式 | 撞 ⚪ 隐形档，重蹈 v1.x「475 行协议」覆辙；jsonl 破坏 markdown+grep 一致性 |
| claude-flow neural 自动改宪法 | neural 类已实测不可用；自动改宪法撞 §二.7 冻结块=自我失控 |

## 六、必须保护的灵魂（soulToProtect）

1. **真异构多模型**（烛=Codex / 织=Gemini 独立二进制）
2. **每轮强制路由门 §三**（本次所有改造都是给它接线，绝不退回可选）
3. **⚪ 隐形档 / 对小任务保持隐形**（对象化/账本/闭环只用在 🔴🟡 和高复杂度）
4. **5 命名 Agent 人格**（匠/策/鉴用 Opus 是有意为之，靠人格+只读隔离，≠ 烛/织 模型异构）
5. **可感知强化 > 结构完整度**（零新增常驻文件、接已有空转件、每条答出"用户如何立刻感知变强"）
6. **对抗式兜底 + Integrity Gate**（A2 正是修复体系自己对此的违反）

## 七、给主人的决策点

1. **两套 .ai-shared 归属语义**：框架产物归 514cc / 业务产物归父项目？（A1 前置）
2. **B1 白发刹车的 🟡 降级边界**：认可"只降🟡不降🔴"吗？
3. **.spec-workflow MCP**：实验性安装还是既定方向？（决定 F5 是打通还是删空目录）
4. **批次顺序**：建议 A（地基/减法）→ B（机械扳机）→ C（闭环，配审计）。先做哪批？

---

__DELTA__: 参照 Trellis 完善（6-agent 编排·首条账本记录） | 2=推翻主驾判断 | 主驾独自判断"缺 Finish 闭环"方向对但未核实磁盘；红队推翻优先级（断链修复 P1→P0）、照出主驾遗漏的 F1 证据链断裂/F2 claude-flow 纯纸面/F3 handoff 纪律执行率≈0，并 DROP 主驾综合层保留的 per-task 上下文卡（要建不存在的 templates/）
