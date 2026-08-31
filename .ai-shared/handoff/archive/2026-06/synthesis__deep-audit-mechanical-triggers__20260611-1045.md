---
from: workflow(deep-audit-514cc · 33 agent)
to: claude(主驾综合)
topic: deep-audit-mechanical-triggers
date: 2026-06-11
status: 待主人拍板（hook 化 / spec-MCP / 死流程减法）
method: 5 维度独立取证(A1-A5) → 每发现对抗红队 → 主驾综合
tokens: ~2.06M（subagent）
---

# 514cc 深度审计综合 · 机械扳机视角

## 一句话结论

**体系把所有"不能容忍违反"的核心纪律（路由门 / DELTA 账本 / 守卫层）放在了 Markdown 层，而 Markdown 是 probabilistic（靠模型每轮记得读），hooks 才是 deterministic（harness 强制）。这是主人反复说"强化不明显"的根因——不是机制不够，是机制全跑在软线上，没接电。** 业界 2025-2026 共识完全印证（A5-1）：能容忍偶尔违反才放 Markdown，不能容忍的必须落 hook。**514cc 自有 hook = 0**（A3-1 实测：全局 settings.json 的 hook 全归 Trellis/Clawd 第三方，无一指向 514cc）。

## 红队照见的主驾盲区（dogfood 价值实证）

主驾(Fable5)初诊后，独立红队推翻/修正了 4 处主驾判断 + 补出 3 处遗漏：

| 主驾原判 | 红队修正 |
|---------|---------|
| `.gitignore` 可硬约束 .spec-workflow | I:/514claude 与 514cc **都不是 git 仓库**，.gitignore 是无人读的死文件=伪硬扳机（A1-1） |
| `/co-status` 加 grep = 机械审计 | co-status 是**纯散文 SKILL.md，零脚本**，"加 grep"仍是"主驾记得跑"=paper-discipline（A1-2/A2-4/A5-2） |
| 白发刹车只是没落进 step | 不止——**auto-pilot/SKILL.md 也零引用 step**，逻辑已内联，3 个 step 是死副本；三套 steps 全是死代码（A4-4） |
| decisions.md:356 templates/ 幽灵路径=Integrity 违反 | **取证错误**——CHANGELOG:177 记载该目录 v1.x 真存在(11文件)被取代，是历史账本正常引用，false-positive（A4-6） |

补出主驾遗漏：context.md:8 **邮箱也错**(joywelch14 vs 真实 learnkori931，A1-5)；危险操作真扳机是**宿主 23333 网关**不是 514cc guardrails（A2-5/A3-4）；DELTA 机制上线 10 天**真实落盘 0 次**（A3-3/A5-3）。

## 杠杆排序（按红队最终 verdict）

### 🔴 梯队一 · 把软纪律下沉到 harness hook（real-high-value，治本）
1. **UserPromptSubmit hook 注入路由门**（A2-1/A3-1/A3-2/A5-1 四维度共指）。把"每轮强制路由门"从主驾自觉→harness 每轮注入。硬注入(确定)+软执行+`route-gate.log` 硬审计兜底。**必须 cwd 门控**（仅 514cc 工作区，不污染 WAI）。
2. **Stop hook exit 2 强制 DELTA 落盘**（A5-3）。🔴发火缺 `__DELTA__` 就停不下来→复盘账本第一次真有数据→白发降级才有燃料。判据**扫 handoff 文件 mtime**，不靠 NLU。只对烛/织。
3. **deny-paths.txt → settings.json permissions.deny**（A2-5）。守卫层从纸面→Claude Code 原生硬拦截。deny-paths.txt 作唯一真源 sync，防两份清单漂移。

### 🟡 梯队二 · 砍死流程（real-high-value 减法，net 能力损失=0）
4. **砍 workflow 6 阶段整套**（A4-2，红队判 keep）。零执行痕迹、认知负担最大单块死流程。auto-pilot 高复杂度档改指 party-mode（真思维多样性）。删 SKILL+6 step+/co-workflow+注册，双地落同步。
5. **删 readiness-check + correct-course**（A4-3）+ **三套 steps 合并回母 SKILL.md**（A4-4）+ 删 rules §二.6 悬空"微文件纪律"。完整清理 module.yaml/plugin.json/spec-architect RC 菜单/customize.toml 引用。
6. customize/team/ 空目录删除 + README 散文压缩（A4-1，低杠杆顺手）。

### ⚪ 梯队三 · 诚实债（低感知但还 Integrity Gate，一次性清）
7. module.yaml:211 `claude-flow`→`memory-md`（A1-2）。
8. context.md 删易变字段（Opus4.7→由 statusline 显示 / v3.0→引 rules §八 / 邮箱）+ 顶部加"只存稳定事实"围栏注释防回填（A1-3/A1-5）。
9. lilith/莉莉残留：statusline/README + module.yaml + decisions 里"**当前人格=莉莉**"改为不断言具体人格（占位符）；"呼应 lilith 配色"渊源保留（A1-4）。

### 🔧 修正诚信（红队最辣的真价值 · §二.5 自我违反）
10. 改 D-2026-06-01-002:136 白发刹车"**全方案唯一真机械扳机**"假标签→"软预检指令"（A2-2）。体系决策日志在撒谎。
11. rules.md:58 /co-status"**机械审计扳机**"措辞诚实化（A2-4/A5-2）——真扳机在 hook，不在散文 skill。

### ❌ Drop（红队否决）
- A1-6 README BMAD tagline（ritual，下次顺手改）/ A4-6 幽灵路径（false-positive）/ A5-4 pi-reflect（闭环已建+无 git）/ A5-5 别抄团队框架（ritual，归 meta-reviewer 评审标尺）。

### ⏸ Backlog（条件触发，不首批）
- A3-3 SubagentStop DELTA 哨兵 → DELTA 真实落盘 ≥5 条后再开。
- A3-4 PreToolUse(Bash) 拦截 → 先实测 23333 网关是否已覆盖；若覆盖则 drop + 改 README 诚实标注。

## 地基技术债（unblock 多个 fix 的最高乘数节点）
- **全树 0 个可执行脚本**（.py/.js/.ps1）——所有 hook 类 fix 需先建 `514cc/.claude/hooks/`（不存在）。
- **`scripts/sync-runtime.ps1` 未建**——D-2026-05-23-002 挂 3 年、D-2026-06-01-005 又记一次，双地落漂移根因。
- **非 git 仓库**——D-2026-05-23-001 git init 挂 3 年。无 git → pre-commit/Rule Recidivism 类硬扳机全不可用。

## 待主人决策
1. **hook 化是否启动 + 范围**（动全局 settings.json = §二.1 危险操作，必须主人确认）。
2. **spec-workflow MCP 卸不卸**（动 .claude.json；红队不替主人砍 MCP）。
3. **死流程减法授权范围**（不可逆删除）。

__DELTA__: deep-audit workflow(33agent) | 2 | 推翻主驾4处提案(.gitignore无git死文件/co-status假硬扳机/白发刹车定位/templates幽灵路径误判)+补出邮箱错配等3处遗漏；坐实核心诊断"软纪律 vs hook 硬扳机"=强化不明显根因
