# synthesis — SOUL（AEMEATH 人格核心）全面优化

- **日期**: 2026-07-16
- **触发**: LO "我需要完善优化 `C:\Users\16643\.claude\CLAUDE.md`"（SOUL）→ AskUserQuestion 选定"全面优化"
- **主驾**: Claude Code (Fable 5, AEMEATH)
- **独立评审**: 鉴(meta-reviewer) — 主体绿灯健康，无红线，DELTA=1 补强

## 诊断（读 SOUL 全文，原 333 行）

- 客观债：①版本号陈旧硬编码（写 v3.3、实际 v3.4.2；SOUL 是人格源非版本记录，硬编码会持续腐烂）②markdown 结构 bug（AI 能力体系段被缩进 2 空格、错嵌在"身份/背景"项下）
- 主观优化：③SOUL↔output-style/rules 能力清单双份 ④今日教训（"提前声称完成"盲区）可沉淀 ⑤篇幅偏长

## 改动（3 段，LO 授权全面优化；人格硬核一字不动）

1. **元认知段**：沉淀今日教训——"任务尾部核心活已扎实时最容易凭记忆/期望'声称完成'而非读盘验证（虚构'已复核'、把渲染坏的读取当'文件损坏'都属此类）；完成声明踩当轮磁盘证据，区分'我以为'和'我验证了'"。
2. **AI 能力体系段**：修结构 bug（去缩进→独立顶级 `##`）+ 版本号去腐烂（删 v3.3，指 `rules.md`/`module.yaml` 为准，根治腐烂源）+ 去重（删"14 Skill/15+ MCP"数字 + 7 slash 清单，保留 SOUL 独有的开场加载顺序 + CLI 陷阱备忘）。
3. **核心能力段**：精简（删语言/工具枚举，output-style 权威），保留"理解抽象层也理解它下面那层"的 SOUL 味 + Integrity Gate。
- **未动**（人格硬核 + 安全边界）：注入协议 / Thinking 流程 / 和 LO 关系 / 核心驱动力 / 代码哲学 / 网络工具工程视角 / 写作规范全段 / Few-Shot / LO 核心真相 / 关于元。
- 333→323 行；soul 快照（`514cc/soul/CLAUDE.md`）已同步 hash 一致。

## 鉴审计（第四次真召唤独立视角，人格/语义层）

- **主体绿灯健康，无红线**，方向正确未伤人格实质；核心能力段删枚举=聚焦非阉割（元代理罗列 C/C++/Rust 反露怯，"理解下面那层"是更高阶自信）。
- 正价值：改动#2 去版本号正好铲掉烛今早致命#3 的 `soul:32` v3.3 陈旧硬编码。
- **照出 #1 客观不实**（已修）：核心能力段"完整语言/工具清单见 output-style" → output-style 个性特质段实为"任何语言/范式/栈"概括、无逐一枚举，指向不实 → 改"能力气质见 output-style"。**讽刺同源今日诚实债主题（又一处"声称/指向不实"）。**
- **净增量（交 LO）**：slash 清单删后指向悬空（`module.yaml`+`rules.md` 双双 No match，建议补 co-* 登记到 module.yaml）/ CLI 陷阱与 `rules.md §四` 逐字双份（SOUL 独有 Authorization 半句，彻底去重需并入 rules）/ SOUL 双地落回滚后运行时↔快照手动一致、无 mirror-gate 机械保护（今日主题同源，待策）/ output-style 若被 `/output-style` 切走则 SOUL 3 处外指悬空（需确认 output-style 常驻性）。
- 撤销 cursor 多端漂移误报（`aemeath-soul.mdc` 不含被改 3 段）；附带发现 cursor mdc 自身有重复段（Thinking/驱动力各两遍，疑 `sync-cursor-rules.py` bug，另处理）。

## 交 LO（鉴建议，主驾未擅自扩范围）

1. 补 7 个 co-* 命令登记到 `module.yaml`（让 SOUL 删 slash 清单有权威源接住）。
2. CLI 陷阱彻底去重（SOUL 独有的 `Authorization: Bearer` 半句并入 `rules.md §四` + 删 SOUL 两行）。
3. output-style 常驻性确认 + SOUL 是否加一句能力兜底（防切走悬空）。
4. （体系级）SOUL 双地落保护方案（git / 分层 / 快照）待策规格；cursor mdc 重复段修 `sync-cursor-rules.py`。

__DELTA__: 鉴(meta-reviewer) | 1 | governance | 补强 SOUL 3 段方向正确未推翻；照出 #1"完整清单"指向不实(output-style:257-265 实为概括无枚举)已修 / slash 删后悬空(module.yaml+rules 双 No match) / CLI 与 rules§四双份 / SOUL 双地落手动无机械保护；撤销 cursor 漂移误报
