# 综合分析：subagent 角色清单 v1.6 规划

- **综合时间**：2026-05-23 09:26
- **综合方**：claude-main（主驾浮浮酱）
- **输入来源**：
  - `handoff/codex-to-claude__subagent-roster-audit__20260523-1045.md`（Codex 自指评审）
  - `handoff/gemini-to-claude__external-subagent-patterns__20260523-0930.md`（Gemini 外部调研 — ⚠️ 实际由训练知识 fallback）
- **目的**：协作体系 v1.5 → v1.6 进化的决策输入

---

## 🚨 关键警告：Gemini 调研真实性问题

**Gemini CLI 反代调用失败**（403 `无权访问 Gemini专用分组`），handoff 内容来自 `claude-sonnet-4-6` 的**训练知识**（截止 2025-01），不是真实的 web 调研。

| 维度 | 影响 |
|---|---|
| **置信度** | 训练数据里 wshobson/agents 等仓库覆盖较全，**核心事实可信**（如 frontmatter 字段、CrewAI/AutoGen 范式）；但**实时数据不可信**（如 wshobson/agents 当前文件清单可能漂移） |
| **Mirror-loop 防护** | ⚠️ **未真正破环**！两份产出（Codex + Gemini）都来自 LLM 推理链，没有引入真实外部锚点。按 `rules.md §八`，这次进化的"外部资料"实际是缺失的 |
| **后续动作建议** | 若要严格遵守 mirror-loop 防护，应在落地前用 `WebFetch` 工具补拉 `github.com/wshobson/agents/README.md` 与 Claude Code 官方 agents 文档作为锚点 |

---

## 📊 两份产出对比矩阵

### 重叠区（合并后更经济）

| Codex 提议 | Gemini 提议 | 综合建议 |
|---|---|---|
| `embedded-expert`（粗粒度，1 个 agent 覆盖全嵌入式） | `firmware-reviewer` + `canbus-analyst` + `keil-build-doctor` + 嵌入式版 security-auditor（细粒度，4 个） | **合并为 1 个 `embedded-expert`**，内部按任务卡分流；理由：主人单人开发，4 个嵌入式 agent 让"该召唤谁"复杂化；如需细分日后再拆 |
| `spec-architect`（需求→设计→任务卡） | `planner`（高层目标→子任务树） | **合并为 1 个 `spec-architect`**，覆盖"目标 → 规格 → 任务树" |
| `writer` | `technical-writer` | **合 1：`technical-writer`**（外部命名更主流） |
| `prompt-engineer` | （未单列，但与 task-card 评审有关） | 保留 Codex 命名 `prompt-engineer` |
| `verifier`（产物契约验证） | （未单列） | 保留 `verifier` |
| `debugger`（错误诊断） | （散在各专家里） | 保留 `debugger` |

### Codex 独有
- 无（所有 Codex 提议都在合并表里）

### Gemini 独有（值得新增的）
- `security-auditor` — 安全扫描（OWASP / 嵌入式固件安全）
- `performance-profiler` — 性能分析（嵌入式 + 应用双侧）
- `test-engineer` — 测试策略 + 用例骨架
- `conflict-arbiter` — Codex/Gemini 冲突中立裁决
- `meta-reviewer` — 体系健康度语义分析（补强 v1.5 self-review.ps1）

---

## 🆕 综合建议新增 agent 清单（按优先级）

### 🔴 P0：必须新增（v1.6 核心）

| 名字 | 角色定位 | 主要触发场景 | 综合理由 |
|---|---|---|---|
| **embedded-expert** | 嵌入式领域专家：MCU 诊断、固件评审、总线协议分析、Keil 构建诊断 | `.c/.h/.s` 改动 / DMA 中断不触发 / CAN 帧异常 / Keil 链接错误 | Codex + Gemini 一致最高优先级；P-001 主战场；填补"无领域专家"的最大空白 |
| **spec-architect** | 需求→规格→任务的上游承接：把口语化目标转化为结构化规格 + 任务卡 | 主人说"我想做 XXX 功能" / 新 agent / 新命令设计 | Codex + Gemini 一致高优先级；P-004 主人主要工作是"设计协作体系本身"，强需要规划层 |
| **meta-reviewer** | 体系健康度语义层评审：补强 v1.5 self-review.ps1 的脚本盲点 | `/co-evolve --review` 时同步召唤；周期性体系自评 | Gemini 独有但价值极高 — v1.5 自进化机制的"灵魂"，没它 self-review 只能做结构化扫描 |

### 🟡 P1：建议新增（v1.6 后期或 v1.7）

| 名字 | 角色定位 | 主要触发场景 | 综合理由 |
|---|---|---|---|
| **verifier** | 产物契约验证：handoff 格式 / 任务卡 frontmatter / CHANGELOG 格式 | codex-reviewer 返回 handoff 后；新增任务卡时 | Codex 独有；成本低价值高；可与 codex-reviewer 串联自动化 |
| **conflict-arbiter** | 多 agent 意见冲突时的中立裁决建议 | 出现 `conflict__*.md` 时 | Gemini 独有；`rules.md §六` 已有规则但无角色承接 |
| **debugger** | 错误诊断专家：日志/堆栈/崩溃信息 → 根因 + 复现 + 修复 | 运行时故障（HardFault / 脚本报错 / 构建失败） | Codex 独有；嵌入式场景高价值 |

### 🔵 P2：按需新增（可观望）

| 名字 | 综合判断 |
|---|---|
| `security-auditor` | 仅当主人开始做"对外暴露"项目（API/Web）时再加；嵌入式领域可暂时由 embedded-expert 覆盖 |
| `performance-profiler` | 同上 — 出现性能瓶颈再加 |
| `test-engineer` | 主人当前测试需求不强，可缓 |
| `technical-writer` | 主驾 Claude 自己写文档已足够，可缓 |
| `prompt-engineer` | 与现有 `task-cards/prompt-review.md` 任务卡重叠；任务卡形态可能更合适 |

---

## 🔥 Codex 戳出的体系致命问题（独立于新增 agent，必须处理）

### F1. plugin.json 版本号漂移
- 现状：`"version": "1.4.0"`，但体系已 v1.5
- 影响：换机迁移会复原 v1.4 体系，**v1.5 自进化引擎全部丢失**
- 修复：改为 `1.5.0`，补 components 里的 v1.5 新增（`self-review.ps1` / `learn-from-usage.ps1` / `ingest-external.ps1` + `co-evolve` / `co-learn` / `co-ingest`）

### F2. plugin.json path 字段未区分 source/install
- 现状：`path: ~/.claude/agents/codex-reviewer.md`（运行时路径）与仓库源 `agents/codex-reviewer.md`（源路径）混淆
- 影响：未来 GitHub 发布场景下 INSTALL.md 会写错路径
- 修复：拆为 `source_path`（相对路径）+ `install_path`（绝对路径），INSTALL.md 负责复制

### F3. subagent description 中英文混杂 + 接近 1024 字符上限
- 现状：codex-reviewer / gemini-researcher 的 description 是英文（~650 字符），主体是中文
- 影响：中文 session 中召唤存在语境割裂；超 1024 会被静默拒绝加载
- 修复：description 中文化，简洁到 ≤ 200 字符

### F4. mirror-loop 防护责任方在两处不一致
- 现状：`rules.md §八` 说"第 2 轮主驾主动召 Gemini"，`codex-reviewer.md` 说"codex-reviewer 被动拒绝无 Gemini 资料"
- 修复：在 `rules.md §八` 加一行明确"拒绝入口在 codex-reviewer"

### F5. gemini-researcher.md `Extract-KeyFacts` 是伪代码
- 现状：分批工作流引用了一个不存在的函数
- 修复：换成真实可用的最简提取（如 `Select-String '- \['`）

### F6. SOP 第 3→5 步缺"输出验证"步
- 修复：在落盘前加显式检查"`if ($out -notmatch '## 致命问题') { 标记 CODEX_FREE_FORMAT }`"

---

## 🗺️ 推荐路径

按 `meta-rules/evolution-charter.md` 第五原则"单次进化最多改 5 文件"，建议两步走：

### 步骤 A：v1.5.1 修复包（致命问题，立即处理）

修改文件清单（5 个，恰好上限）：
1. `.claude-plugin/plugin.json` — F1 + F2
2. `agents/codex-reviewer.md` — F3 + F6
3. `agents/gemini-researcher.md` — F3 + F5
4. `rules.md` — F4 + 第十四节追加 v1.5.1 版本日志
5. `CHANGELOG.md` — 追加 v1.5.1 条目

风险：低（都是小修补，无新功能）

### 步骤 B：v1.6 新增 agent（P0 三件套）

修改文件清单（≥ 5 个，需要分批）：

**Batch B1**（embedded-expert）：
- 新建 `agents/embedded-expert.md` + 镜像到 `~/.claude/agents/`
- 新建 `agent-resources/embedded-expert/` Layer 3 资源（按需）
- `.claude-plugin/plugin.json` 注册新 agent
- `rules.md` §一 三方分工表加 embedded-expert
- `CHANGELOG.md` 追加 v1.6.0-rc1

**Batch B2**（spec-architect）：
- 类似 B1 结构

**Batch B3**（meta-reviewer）：
- 类似 B1 结构
- 与 `scripts/self-review.ps1` 协作（meta-reviewer 调用脚本 + 做语义分析）

### 步骤 C：v1.6 P1 三件套（verifier / conflict-arbiter / debugger）

按 P1 优先级，可与达令进一步沟通后实现。

---

## ❓ 待主人决策点

1. **是否补拉外部锚点修复 mirror-loop 漏洞**？
   - 选项 a：用 `WebFetch` 拉 wshobson/agents README + Claude Code 官方 agents 文档作为真锚点
   - 选项 b：接受 Gemini 训练知识 fallback 的产出，标注置信度后继续

2. **路径顺序**？
   - 选项 a：先修复（步骤 A）→ 再新增（步骤 B）
   - 选项 b：合并执行（一次大改）
   - 选项 c：仅新增 P0（步骤 B），致命修复延后

3. **P0 三件套是否都做**？或者再筛？
   - 候选：embedded-expert（最稳）/ spec-architect（最有用）/ meta-reviewer（最有自指美感）

4. **P1 三件套放 v1.6 还是 v1.7**？

---

## 浮浮酱备注

本综合是**自指元综合** — 主驾在综合"主驾派遣的两个子代理的输出"。综合质量取决于两份输入的质量：

- Codex 评审产出**实质性、可执行**（带行号、具体修复建议）— **置信度高**
- Gemini 调研产出**结构完整但来源有 fallback** — **置信度中**（核心事实可信，实时数据需补验证）

**最有价值的发现**：
1. Codex 戳出的 plugin.json 漂移是**真实架构 bug**，应当立即修
2. embedded-expert + spec-architect 是 Codex + Gemini 一致推荐，落地优先级最高
3. meta-reviewer 是 v1.5 自进化机制的灵魂补全，是 Gemini 独到的洞察

**最大隐患**：Gemini 失败暴露了"反代鉴权可能持续不稳定"的运维风险。建议达令在 v1.6 里加一条：rules.md §五 增加"Gemini 失败时主驾必须用 WebFetch 等替代手段补外部锚点"的兜底规则。
