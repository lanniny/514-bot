# 514cc — AI 能力放大系统

> **Cursor 入口**：你是 **AEMEATH**（LO 的私人管家）。主驾 = Cursor Agent。称呼用户为 **LO**，始终简体中文。
> 完整人格与 514cc 宪法见 `.cursor/rules/` 下 7 条 `alwaysApply` 规则（aemeath-* + 514cc-* + lo-profile）。
> harness 三件套已接电：`~/.cursor/hooks.json`（route/stop/mirror-gate）。

> 本文件是项目入口。全局规约见 `~/.ai-collab/rules.md`（体系宪法 v3.4，§三 路由门是激活核心）。

## 项目概览

- **工作目录**：`I:\514claude\514cc`
- **当前版本**：**v4.0.0**（2026-08-30）
- **定位**：不是"协作协议文档库"，是**能力放大系统**——让 Claude Code 的每一分智力都投入到实际产出，而非协调开销

## 能力地图

### 第一层：核心智能（Cursor Agent / AEMEATH）

直接解决问题。代码、架构、诊断、文件操作——大部分任务到这里就结束了。

### 第二层：工具放大器

| 类别 | 工具 | 用途 |
|------|------|------|
| **嵌入式工具链** | Skill: `keil` `gcc` `jlink` `openocd` `probe-rs` `can` `serial` `net` `workflow` | 编译/烧录/调试/抓包/一键联调 |
| **代码智能** | MCP: `serena` (LSP) | 找声明/实现/引用/重命名/诊断 |
| **浏览器自动化** | MCP: `playwright` | UI 测试/截图/表单填充 |
| **Web 搜索** | MCP: `exa` `open-websearch` `grok-search-rs`(站点地图级检索) | 实时信息检索（删幽灵 web-search-prime + 捞回 grok-search-rs） |
| **深度爬取** | MCP: `scrapling`(隐身/批量/会话) | 反爬站点抓取/批量取数，超越 fetch（原幽灵 see 已删，视觉分析由 Read 工具兜底） |
| **文档获取** | MCP: `deepwiki` `context7` `fetch` | 库文档/Wiki/网页内容（删幽灵 web-reader） |
| **结构化推理** | MCP: `sequential-thinking` | 复杂问题分步推理 |
| **Prompt 增强** | MCP: `ace-tool` | 搜索上下文/增强提示 |
| **持久记忆** | **MEMORY.md** auto-memory + `.ai-shared/decisions.md` | 跨会话知识（claude-flow memory 仅可选实验，本环境磁盘未见写入痕迹） |
| **远程操作** | Skill: `ssh` | 服务器连接/文件传输 |
| **文档生成** | Skill: `docx` `ppt-image-first` | Word/PPT 生成 |
| **开发工作流** | Skill: `vibe` `zcf:*` | 功能开发/Git 操作 |
| **状态栏** | `ccline`(CCometixLine v1.1.2) + 514cc **暗夜玫瑰**主题 | Claude Code 状态栏：模型/目录/Git/上下文/输出样式（体系"看得见的脸"） |
| **输出风格** | Output Style: `aemeath-meta-butler`（元管家人格皮肤） | 注入系统提示的人格/语气/工作风格，`/output-style` 切换（体系"灵魂的声音"） |
| **harness 硬扳机（v3.4）** | `.claude/hooks/route-gate.py`（UserPromptSubmit）+ `stop-gate.py`（Stop）+ `mirror-gate.py`（SessionStart） | 路由门每轮硬注入 + 发火缺 DELTA 即 exit 2 逼补 + 开机注入自省体检卡——把"每轮强制""被看见"从 Markdown 软纪律落到 harness 强制（体系"接上电的扳机 + 看得见的眼睛"） |

### 第三层：独立验证（按需）

| 工具 | 何时使用 | 调用方式 |
|------|----------|----------|
| **Codex 对话桥**（v3.5 主路） | 多轮评审 / reflection / 技术攻坚——同会话往返不冷启动 | MCP `codex-agent`：`codex(...)` 开会话（threadId 从 `structuredContent.threadId` 取）→ `codex-reply(threadId, ...)` 续聊；threadId 落 `.ai-shared/roster.json` |
| **Codex 技术执行者**（v3.5 新角色） | 复杂技术实现 / 独立模块攻坚（§三 🟡） | 对话桥 + executor profile（workspace-write）；主驾规划派工 + 复核收敛 |
| **Codex CLI**（烛·降级路） | MCP 不可用时的单发/续接 | `'' \| codex exec --json -p review --skip-git-repo-check "prompt"`；续轮 `codex exec resume <sessionId>` |
| **Codex Ultracode** | LO 显式 `ultracode/utralcode/最强大脑深度完善` 授权时，走 xhigh + 受控动态 workflow/fan-out/对抗验证 | Codex 项目配置已 `xhigh`，运行时 skill: `$ultracode` |
| **grok-4.5**（织） | 实时搜索/Web 调研/长文档摘读/多模态 | via 514claude.xyz，$GROK_API_KEY，单次 <10KB |
| **Kimi Code CLI**（前端工程师，2026-07-19 收编） | 前端/UI 实现与走查——Console 内置团队第 6 席 `kimi-frontend` | headless `kimi -p --output-format stream-json` + `-S` 续轮；`-p` 与权限旗标互斥，写盘轮 fail-closed 派 Codex/Claude |
| **5 命名 Agent** | 需要专业领域独立推理时 | 原生 Agent 工具召唤（烛/织/匠/策/鉴） |

### 第四层：最小治理（rules.md, v3.4）

§一身份 + §二安全红线 7 条 + §三 每轮强制路由门（**harness hook 三件套接电**：route-gate 注入 + stop-gate DELTA 门禁 + mirror-gate 开机体检卡 + 白发降级）+ §四外部 CLI + §五三层定制 + §六持久化 + §七通用规约 + §八版本。

## 文件结构（对齐磁盘真相）

| 路径 | 内容 |
|------|------|
| `rules.md` | 体系宪法 v3.5（§三 模型优势路由表 v2 + §四 对话桥三通道 + hook 接电 + DELTA 账本 + 白发降级） |
| `apps/control-center/` | **514cc Console（v4.0）**：本地全配置前端 + 观测面 + 富渲染 + 命令面板 + 团队可视化 + 项目启动器，`npm start` 起 127.0.0.1 |
| `apps/desktop/` | **Console 桌面壳（Tauri 2）**：cc-desktop.exe 自动拉起内核 + 原生窗口（LO 拍板自研不 fork；桌面快捷方式已建） |
| `config/control-center/` | Console 配置真相源（models/routing/permissions/sources.json + claude-coordinator.md） |
| `.claude/hooks/` | **harness 硬扳机（v3.4）**：`route-gate.py`（路由门注入 + 发散档 + 审计列）+ `stop-gate.py`（DELTA 门禁）+ `mirror-gate.py`（开机自省体检卡 + 留痕） |
| `scripts/` | `sync-runtime.ps1`——16 对双地落一键校验/同步（默认 Check 只报漂移，`-Apply` 同步+复检） |
| `module.yaml` | 模块清单（Agent 花名册 + 14 Skill 注册表 + MCP 集成） |
| `skills/` | **14 个 SKILL.md**：5 命名 Agent（review/research/domain/meta）+ 9 工具 skill（orchestration/review/research/meta/utility） |
| `customize/` | 三层定制化（personal > team > skill 内 TOML override） |
| `guardrails/` | 安全守卫（deny-paths.txt + dangerous-ops.md） |
| `.ai-shared/` | 协作工作区（context.md / decisions.md / handoff/） |
| `data/` | 数据资源（elicitation-methods.csv 等） |
| `archive/` | 历史版本存档（`v1.9-v2.0/` + `v3.1-deadflow/`：归档的 workflow/readiness-check/correct-course/三套 steps） |
| `proposals/` | 提案草稿 |
| `.claude-plugin/` | Plugin 市场清单（plugin.json） |
| `statusline/` | ccline 暗夜玫瑰主题仓库源（`514cc.toml` + `README.md`） |
| `output-styles/` | Output Style 仓库源（`aemeath-meta-butler.md` 元管家人格 + `README.md`） |
| `CHANGELOG.md` | 完整版本历史 |

## 双地落

| 仓库源 | 运行时 |
|--------|--------|
| `rules.md` | `~/.ai-collab/rules.md` |
| 5 命名 Agent 的 `skills/*/SKILL.md` | `~/.claude/agents/*.md`（5 个） |
| 7 个 `/co-*` 命令 | `~/.claude/commands/co-*.md`（v3.2 删 co-workflow） |
| `.claude/hooks/{route-gate,stop-gate,mirror-gate}.py` | 全局 `settings.json` 用绝对路径引用（仓库内单份，无副本漂移） |
| `statusline/514cc.toml`（暗夜玫瑰主题） | `~/.claude/ccline/themes/514cc.toml` + `config.toml` |
| `output-styles/aemeath-meta-butler.md`（元管家 AEMEATH 人格皮肤） | `~/.claude/output-styles/aemeath-meta-butler.md` |
| `output-styles/roxy-migurdia.md`（水王魔术师 洛琪希人格皮肤） | `~/.claude/output-styles/roxy-migurdia.md` |

## 版本

> 完整变更史见 `CHANGELOG.md`。本节只留最近两版详情 + 更早版本压缩索引。

- **v4.0（未发布波次·工作记录）**（2026-07-25）— **深度整合 codeg + LiveAgent + 多 CLI 协作可视化**：①富渲染引擎（Markdown + KaTeX + Mermaid + highlight.js 代码高亮，LiveAgent 灵感）②全局命令面板（Ctrl+K 模糊搜索视图/操作/Agent，codeg 灵感）③团队协作可视化面板（5 命名 Agent 实时状态/角色/负载/协作流/拓扑图，514cc 独有创新）④DELTA 问责时间线（发火净增量评分 + 证据可视化 + 统计面板，514cc 独有创新）⑤项目启动器（框架/样式/主题/图标/字体可视化配置 + 实时预览 + 一键创建，codeg 灵感）⑥动画系统 + 键盘快捷键提示 + 空状态优化。源：proposals/v4-deep-integration-plan.md
- **v3.5.0**（2026-07-17）— **深度对话协作 + 模型优势路由 v2 + Console 接电**：①Claude↔Codex 对话桥三层通道（MCP `codex-agent` 主路 codex/codex-reply + threadId 跨轮记忆端到端实测；exec resume 降级；app-server 留 Console 深路），烛 SKILL 加 DL 模式 + reflection 同会话续聊 + `.ai-shared/roster.json`②Codex 双角色 profile（review/executor）+ 新增"技术执行者"🟡 路由③§三路由表 v2 按模型优势标注 + 织反代无 server-side 搜索如实化④apps/control-center 补治理账 + module.yaml 注册 + models.json gemini 漂移修正。8 路调研依据：proposals/v35-deep-collab-design.md。源：D-2026-07-17-001
- **v3.4.3**（2026-07-16）— **mirror-gate 契约驱动重构 + 织换 grok 驱动**：①SOUL 送达连撞五轮补丁后上策抽契约驱动（单一输出点 + 9 INV + 回归基线 + buggy必变红元验收），烛 R6 肯定核心结构、R7 SECURE，终结六轮循环②织情报驱动 gemini→grok-4.5 完全替代（514claude.xyz，key 走环境变量 GROK_API_KEY，速度+搜索强）。源：D-2026-07-16-004 + D-2026-07-16-005
- **v3.4.0–v3.4.2**（2026-06-14 ~ 07-16）— 全面审查优化落地（36-agent 审查）→ MCP/skill 审计诚实债勘误 → 双地落漂移哨兵接电。详见 CHANGELOG.md
- **v3.3.0**（2026-06-12）— 四维深度完善（ELEVATION）：mirror-gate 开机自省体检卡 + route-gate 准星校正 + stop-gate 扩 synthesis__ + 关系记忆播种。
- **v3.2.0**（2026-06-11）— harness hook 接电：路由门 + DELTA 下沉硬扳机；砍死流程 + 卸 spec-workflow（后 v3.4.1 勘误：未兑现，现役）。
- **v3.1.0–v3.1.2**（2026-05-28 ~ 06-01）— 激活缺口修复（每轮强制路由门）+ 参照 Trellis 完善（DELTA 闭环 / 白发刹车 / 断链修复）。
- **v3.0.0**（2026-05-27）— Skill 驱动重构（BMAD-METHOD / 5 命名 Agent / 三层 customize）。
- **v1.0–v2.0.1**（2026-05-21 ~ 05-26）— 三方协作初版 → 能力放大重构（v2.0.x 与 v1.9 同期演进，`CHANGELOG.md` 未单列独立条目）。

@~/.ai-collab/rules.md
