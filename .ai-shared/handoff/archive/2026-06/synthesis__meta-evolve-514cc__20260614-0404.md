# synthesis · 514cc 体系全面审查与进化方案

- 日期：2026-06-14
- 触发：LO「全面审查体系给出优化方案」(ultracode)
- 规模：36 agent / 278万 token / 318 tool_uses / 11.3min；7 维现场测绘(强制 file:line 证据) → 5 lens 设计 24 提案 → 逐案红队(过审 21 / 淘汰 3)
- 主驾去重：21 过审 → 9 大独立杠杆点 (A-I)
- 独立终审：烛(codex) background 进行中 (agentId a8dc1604...)
- 原始数据：`_meta-evolve-raw.json`(本目录，1215 行 pretty)

## 一、方法（反幻觉机制）

每条 finding 强制 file:line 证据 + 标 verified/inferred；每提案强制过 anti_pile_check(反堆文件/堆纪律)；逐案红队对抗裁决。这是对 LO「减少我觉得行就行 + 必须现场调研」的直接回应——结论建立在磁盘取证而非印象。

## 二、核心诊断（均 verified · 磁盘实证）

**D1 stop-gate = 真会话从未击发（经烛沙盒验证：逻辑正常，非失效）。** 全盘无 `.stop-gate-state.json` = 真会话零触发。但烛 sandbox 三连验证扳机逻辑完全正常(exit2 + 写 state + 去重 + 放行全对)——从未击发的真相是「受控 handoff 落盘时账本一直齐全 → 扳机没机会咬」，**问题不在扳机失效，而在 rules.md:99 / decisions.md D-2026-06-12-001 / CHANGELOG / synthesis handoff 四处写「本轮即首次真击发，从无到有」——声称击发过，但磁盘上 state 文件不存在。这一句是体系违反自己 §二.5 Integrity Gate 的诚实债（夸大），需就地改成磁盘真相，而非反向写成"扳机失效"。** 旁证：现已 48h 超出 24h FRESH_WINDOW。

**D2 外用浓度 0%。** DELTA 账本 6 条全部 DELTA=2，但 100% 是「体系审体系/dogfood/对标」元任务，真实业务(WAI) 0 条(父级 handoff `__DELTA__` 行数 = 0)。织(gemini) 一生发火 1 次(2026-05-23，距今 22 天)；匠/策/鉴 handoff 零产物。「5将齐发」是叙事，磁盘真相只有烛偶尔出场。

**D3 MCP 真金被埋 + 幽灵配置。** 真配置源在 `~/.claude.json`(17 server) 非 settings.json。scrapling(隐身/批量爬,远超 fetch)、grok-search-rs(站点地图级检索)、serena LSP 重构能力(find_referencing_symbols/rename_symbol/get_diagnostics) 配置健康但 decisions.md 零使用、CLAUDE.md 能力地图未收录。反向：CLAUDE.md/module.yaml 宣称的 see / web-search-prime / web-reader 在磁盘根本不存在(幽灵)。claude-flow ~300 工具零落盘(无任何 .db) = 最大命名空间噪音。13 官方插件 usageCount=0。

**D4 人格双注入互斥。** SOUL.md(CLAUDE.md, 24KB user-memory) 与 output-style(18KB system-prompt) 约 80% 逐条重复(身份/元原则/口癖/响应矩阵/七条准则)，但安全框架互斥：SOUL 用「反驳协议 + 核心驱动力黑洞」，output-style 用「糖衣≠失控」，二者都自称最高优先级 = 运行时仲裁不确定 + 双倍 token。反驳协议每回复强制(thinking 开头短语 + 终结门)却零机械消费者 = 体系自己定义的反模式(纯软纪律)。心路历程头尾被仪式夹住。

**D5 闭环大爆炸式。** 只在 LO 喊「完善」时手动转一圈，两次 elevation(06-12 → 06-14) 间 handoff 无新文件、decisions 无新 DELTA = 引擎接电但灯没人开。

**D6 mirror-gate = 薛定谔的眼睛。** 只 print 不落盘，无法从磁盘证明它真注入过体检卡。负责「被看见」的眼睛自己看不见。

**D7 第二套 harness + skill 发现断层。** trellis-dispatch.py 占据 UserPromptSubmit/SessionStart/PreToolUse，与 514cc 三件套职责未划界。help 路由助手只读 module.yaml 14 条，看不见 9 嵌入式 skill + 13 插件 + zcf + vibe + deep-research = 36+ 真实能力。route-gate 只识 5 类 RED 信号且只指向烛/织。

## 三、24 提案 → 去重 9 大杠杆点

| 梯队 | 代号 | 杠杆点 | 机制 | effort | 直击目标 | 合并自 |
|---|---|---|---|---|---|---|
| 1 诚实与验证 | A | 诚实债清算（四处"首次真击发"假声明改成磁盘真相） | file | S | 4,6 | #3,8,16 |
| 1 | B | stop-gate 活体击发验证（故意落缺 DELTA handoff，看是否 exit2+生成 state） | hook | S | 3,4 | #3,8,16 |
| 1 | C | mirror-gate 落盘（mirror-gate.log 记每次注入时间戳） | hook | S | 4,6,10 | #4,9,19 |
| 2 能力放大 | D | MCP 去腐+捞真金（杀幽灵 see/web-reader，捞 scrapling/grok/serena，claude-flow 减法） | file | S-M | 2,6,7 | #2,6,7 |
| 2 | E | 创造力发散注入器（route-gate 复杂档强制先吐 2-3 互斥角度含 1 逆向假设再收敛） | hook | S-M | 1,9,11 | #1,20 |
| 3 协作/进化 | F | 业务燃料破冰（下次 WAI 真实改动强制走烛+落 business DELTA） | workflow | M | 2,5,8 | #10,13 |
| 3 | G | RED↔召唤对账+修假阳（log 加"真召唤了吗"列+体检卡显示 X/Y） | hook | M | 6,7,8 | #5,12 |
| 3 | H | 人格层收敛（反驳协议每轮全量→条件触发；SOUL↔output-style 去重；工具纪律反同步） | file | S-M | 9,10,2 | #17,18,21 |
| 4 长效 | I | 闭环自动沉淀（SessionEnd hook 半自动提炼"被推翻的判断"成 DELTA 草稿） | hook | L | 3,5,11 | #11 |

## 四、红队挡下的坑（保护性价值）

- **K1 DIV 自审扳机 — kill**：route-gate 根本无 DIV flag，提案触发前提是幻觉，事实地基塌。
- **K2 party-mode 异构 spawn — kill**：堆纪律 + 依赖不存在的兄弟提案；party-mode 本就有唱反调机制。
- **K3 统一三处 FIRE_PREFIXES 常量 — kill**：stop-gate(3 元含 synthesis__) 与 mirror-gate(2 元) 口径差异是**刻意设计 + 双向注释**，强行收敛破坏 mirror-gate 外用浓度语义。**红队挡下一个会破坏现有正确设计的改动。**

## 五、落地建议（待烛终审 + LO 拍板）

- **可立即安全落（零风险勘误）**：A（诚实债）。注：改宪法文件需 LO 点头。
- **低风险高 felt**：C（mirror-gate.log）、D（MCP 去腐）、E（发散注入器）。
- **需谨慎/分步**：H（人格大改，hallu=high，红队标的）、B（活体击发会让某次收尾被 exit2 拦，需 LO 知情）。
- **机会性**：F（等真实 WAI 任务）、I（eff L）。
- **不要做**：K3（保留两个 FIRE_PREFIXES 的刻意差异）。

## 七、烛(codex) 独立终审 — CHANGES_REQUESTED（本节为终审后最终清单，覆盖第五节初判）

烛(Codex gpt-5.5, 68.8K token) + 活体沙盒交叉验证，落盘 `codex-to-claude__meta-evolve-finaudit__20260614-0414.md`。**去重正确**(9 杠杆点无误并/漏并)。**推翻主驾 2 处判断 + 补出 36-agent 全漏的 2 个坑**：

**致命修正（落地前必焊）**
1. **G 归因错 + 别动正则**：主驾任务卡说「task-notification 第 11 行假阳」，烛实测喂进正则=不命中，归因错。真假阳是 `\bsearch\b` 命中 MCP 工具名 `web-search-prime`。收紧正则会误伤 route-gate.log:10「全面审查体系」真 RED。→ G 拆两步：**G1 先加审计列(hit_reason/true_summoned)，不动正则**；G2 正则收紧待 LO 拍板。
2. **H 别删 SOUL**：烛读两份全文确认**非 80% 重复**（推翻 survey D4）——output-style 没有 SOUL 的注入检测/反驳协议层，删 SOUL = 挖空安全框架。→ H 只能「分层」，不能「定 output-style 为唯一权威」。
3. **A 别夸大**：见 D1 修正——扳机逻辑正常，诚实债改写写「沙盒验证正常、真会话未触发」，不写「扳机失效」。

**独立补出（36-agent 全漏）**
4. **D 卸载 claude-flow 会误伤**：`vibetasking/.swarm/memory.db` 真在用，卸载是全局操作。→ D 对 claude-flow 只「标实验沙盒」，不卸载。
5. **B 已兑现**：烛沙盒三连验证 stop-gate 逻辑，主驾**不必**在真会话冒险制造 exit2 污染 state。B 关闭。

**烛三分类（最终）**
- 立即落(低风险)：A、C、D(仅删 see/web-reader 幽灵)、F、G1
- LO 拍板：D(claude-flow 标实验)、E、G2(正则)、H(分层)、I
- B：沙盒已兑现，关闭 ｜ 不做：K3
- **Top3 先做：A → G1 → C**

`__VERDICT__: CHANGES_REQUESTED`

## 八、Top3 落地状态（2026-06-14 已执行 + 验证）

- **A 诚实债** ✅ 6 处活文档假声明改成磁盘真相（rules 双地落 MATCH / decisions 勘误 / CHANGELOG / context:52+58 / CLAUDE / README）；grep 复核活文档零残留；历史 handoff 保留原貌。
- **G1 审计列** ✅ route-gate.log 升 5 列（hit_reason + summoned 占位），正则未动；编译 + RED/gray stdin 实测绿。
- **C mirror-gate 落盘** ✅ mirror-gate.log 首写 card-injected，体检卡照常生成。
- 落 decisions：D-2026-06-14-001。
- 余 6 项：D 安全部分（删幽灵 + 捞真金）推进中；claude-flow 标实验 / E / G2 / H / I / F 待 LO 拍板。

__DELTA__: workflow(36-agent审查) | 2 | governance | 推翻体系 v3.3 自述：stop-gate"首次真击发"被 .stop-gate-state.json 不存在证伪(rules.md:99 等四处)、外用浓度 0%(父级 handoff __DELTA__=0)、幽灵 MCP(see/web-reader 磁盘不存在)
__DELTA__: 烛(codex终审) | 2 | 推翻主驾 2 处判断(G 假阳归因错·H 非80%重复删SOUL会挖空安全框架)+独立补出 vibetasking 误伤(claude-flow 卸载)+沙盒兑现 B；VERDICT=CHANGES_REQUESTED
