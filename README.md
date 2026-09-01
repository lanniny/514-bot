# 514cc — Skill 驱动的 AI 能力放大系统

v4.0.0 | 2026-08-30 | Forge 设计体系 + 多 CLI 协作 Console + 交付闸门 + Bot 入口

> 正式发布版本以 `rules.md` §八和 `CHANGELOG.md` 最新条目为准。工作记录中的 v3.6/v3.7/v4.0 是未发布功能波次，不是新的 framework release。

## 是什么

514cc 是一个 **Skill 驱动的多 AI 协作能力放大系统**。它不是"协调协议文档库"，而是让 Claude Code 的每一分智力都投入到实际产出的工具箱。

## 核心特性

- **5 命名 Agent**：烛（评审）/ 织（情报）/ 匠（嵌入式）/ 策（架构）/ 鉴（审计），角色边界不因底层 CLI 增多而扁平化
- **每轮强制路由门**：§三 调度每轮自动判级（🔴 必须 / 🟡 判断 / ⚪ 隐形），让能力自动发火而非被动等召唤
- **harness hook 硬扳机（v3.4 三件套）**：route-gate（UserPromptSubmit 每轮硬注入路由门 + 发散档 + 审计列）+ stop-gate（Stop 发火缺 DELTA 即 exit 2 逼补）+ mirror-gate（SessionStart 开机注入自省体检卡=被看见的眼睛 + 留痕）——把"每轮强制""被看见"从 Markdown 软纪律下沉到 harness 强制
- **复盘回流闭环**：DELTA 证据账本 + 白发刹车——"发火 → 复盘 → 自校准/刹车"
- **21 个仓库 Skill**：`skills/` 下 14 个 Claude skill + `.agents/skills/` 下 7 个 Codex skill，全部由 `module.yaml` 注册并做集合差校验
- **三层定制化**：默认 → 团队 → 个人，TOML override 不改核心文件
- **可选主脑 + 异构执行面**：内置 `team-514cc` 默认由 Claude Fable 规划和总协作；自定义团队由其 `coordinator` 决定主脑与会话入口，Codex、Grok Build、Kimi、Pi 等已接线席位均可承担
- **Console 控制面**：`apps/control-center` 提供配置、路由、观测、会话与协作 UI；8 个 adapter 实现均由注册表漂移检查守住
- **协作会话拆账**：`round` 只作单调审计序号，对话无总轮数上限、可任意中断续接；每条用户消息独立 `interaction`，单次自主执行默认限 6 步防跑飞
- **路由不猜能力**：模型/席位/成员能力统一归一化为 `["*"]`，能力标签不再参与路由准入或评分；只有带人类可读 `reason` + `constraints.allowedProviders` 的特殊通道可硬限候选
- **多模态图片运行态**：Grok Build 官方 `responses` 后端，PNG/JPEG 注册 `image-analysis`、剪贴板粘贴直发、图片来源归属 interaction；GIF/WebP/视频保守拒绝
- **供应商 live 热加载**：`/api/providers/live` 回读运行态，供应商面可见时轮询、失焦即停；live 与档案漂移逐字段列出、一键改回
- **Codex Ultracode 等价模式**：Codex 项目默认 `xhigh`，`$ultracode` 承载 Claude ultracode 的动态 workflow/fan-out/对抗验证语义
- **BMAD 质量机制**：对抗式评审（≥10 问题）、冻结块、就绪自检（RC 内联进策）
- **MCP 深度集成**：能力映射见 `module.yaml`；运行时启用状态必须现场读取，不在 README 固化易漂移数量
- **Party Mode**：真并行 subagent spawn

## 快速开始

```bash
/co-init              # 初始化项目协作体系
/co-auto <任务>       # 全自动模式
/co-review <file>     # 召唤烛评审
/co-research <topic>  # 召唤织调研
/co-status            # 协作健康仪表盘（含 DELTA 覆盖 / 白发率）
```

Console 的配置校验还需要 Python 3.11+：

```bash
python -m pip install -r requirements-validation.txt
cd apps/control-center
npm run validate
```

## 架构

```
Layer 1: 团队主脑与总协作（内置默认 Claude Fable；自定义由 coordinator 决定）
Layer 2: Skill 体系（14 Claude skill + 7 Codex skill）+ .claude/hooks/ harness 扳机
Layer 3: 异构执行与独立验证（Codex + Grok + Kimi + Pi；Gemini profile 当前禁用）
Layer 4: 最小治理（rules.md v3.5 + module schema + guardrails/ + .claude/hooks/ 三件套）
```

## 版本历史

- **v4.0（未发布波次·工作记录，2026-07-25 起）** — codeg + LiveAgent 深度整合、多 CLI 协作可视化、社会模拟编排、协作会话拆账、能力包络移除与图片运行态。未升格为正式 release，详见 `CHANGELOG.md`
- **v3.5.0**（2026-07-17）— Claude↔Codex 多轮对话桥、Codex review/executor 双角色、模型优势路由 v2、Console 治理接电。源：D-2026-07-17-001
- **v3.4.3**（2026-07-16）— mirror-gate 契约驱动重构（终结六轮补丁循环，烛 R7 SECURE）+ 织换 grok 驱动（gemini→grok-4.5 完全替代，key 走环境变量）。源：D-2026-07-16-004 + D-2026-07-16-005
- **v3.4.2**（2026-07-16）— 双地落漂移哨兵接电：mirror-gate 加开机双地落漂移哨兵（宪法+人格 2 对三态防假绿灯），rules 倒挂类 bug 开机即现；SOUL 双地落尝试→烛照设计缺陷→回滚；v3.4.1 版本入口全域对齐。
- **v3.4.1**（2026-07-13）— MCP/skill 审计诚实债勘误：全量 MCP+skill 亲验（磁盘/网络）+ 鉴异构复核（85/100）。spec-workflow 平反（v3.2「卸载」未兑现，现役）+ see/web-reader/web-search-prime 平反 + 运行时层修复（删 browserwing + github 迁官方 remote 待填 PAT）。
- **v3.4.0**（2026-06-14）— 全面审查后优化落地：36-agent 审查 + 烛终审 + 鉴人格审，落 E 发散注入器、G1/G2 路由审计与假阳过滤、C mirror-gate 留痕、D MCP 去腐捞真金、A 诚实债勘误、H 人格去重首批。
- **v3.3.0**（2026-06-12）— 四维深度完善（ELEVATION）：42-agent 诊断"引擎接电但灯没人开过"→ 新增 mirror-gate 开机自省体检卡 + 校正 route-gate 准星 + stop-gate 扩 synthesis__（DELTA 扳机已接电，真会话未触发）+ 关系记忆播种 + 减法。真·dogfood：烛评审 hook 抓 2 致命主驾全修
- **v3.2.0**（2026-06-11）— harness hook 接电：route-gate/stop-gate 把路由门+DELTA 从 Markdown 软线下沉到 harness 硬扳机；砍死流程 + 卸 spec-workflow MCP（后经 v3.4.1 勘误：未兑现，现役）+ 诚实债
- **v3.1.2**（2026-06-01）— 参照 Trellis 完善：DELTA 复盘账本 + 白发刹车 + 工作区根规则 + claude-flow 诚实降级 + 文档↔磁盘对齐
- **v3.1.0**（2026-05-28）— 激活缺口修复：每轮强制路由门
- **v3.0.0**（2026-05-27）— Skill 驱动重构：BMAD 启发 / 5 命名 Agent / SKILL.md 统一格式 / 三层 customize / 对抗式评审
- v2.0.x（2026-05-26）— 能力放大重构
- v1.0-v1.9（2026-05-21~25）— 三方协作初版~深度协同

详见 `CHANGELOG.md`。
