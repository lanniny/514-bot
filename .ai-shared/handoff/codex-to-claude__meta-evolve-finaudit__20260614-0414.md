# 烛 评审：514cc 体系进化方案（9 杠杆点 A-I）独立终审

- **评审模式**：deep-review（对抗式终审）
- **评审范围**：route-gate/stop-gate/mirror-gate.py + rules.md + output-style + CLAUDE.md(SOUL) + 9 提案 A-I
- **评审时间**：2026-06-14 04:14
- **Codex 模型**：gpt-5.5（micu provider）
- **总 token**：68,807
- **方法**：烛独立磁盘核验 + stop-gate 活体沙盒验证 + Codex CLI 深推理交叉

---

## 致命问题（必须改）

### 致命1 · 主驾对 route-gate 第11行假阳的归因是错的（我实测推翻）
主驾任务卡写"第11行 `<task-notification>` = 任务通知元数据触发"。**我把那条原文喂进真 RED_SIGNALS 正则，结果是【不命中】**——`<task-notification><task-id>wq5...` 单独不触发任何 pattern。日志里那条记成 RED，是因为当时 prompt 80 字符外还含别的触发词（被日志截断没看到）。
→ **直接后果**：G 提案若按"修 task-notification 假阳"去改，是在修一个不存在的根因。真正的两类假阳是：
  - `route-gate.log:8` `web-search-prime` → `\bsearch\b` 命中（MCP 工具名里的独立词 search）
  - 父级 log `research notes` → `\bresearch\b` 命中（这条可能是 LO 真写研究笔记，半假阳）
Codex 独立补强了一个我没强调的坑：**G 若直接收紧 review/search/审查/调研，会误伤 `route-gate.log:10` 那条"全面审查体系给出优化方案"——那是真 RED**。删业务词治不了 MCP 状态文本污染，反而砍真信号。

### 致命2 · H 把 output-style 定为"唯一权威人格层"会挖空安全框架（我已验证两套框架不等价）
我读完两份全文确认：**output-style 与 SOUL 不是 80% 重复**。output-style 有 SOUL 没有的（五模式优先级/KISS-YAGNI-SOLID/工具调用纪律），但 **SOUL 有 output-style 完全没有的【注入检测与反驳协议层】**（运行时白名单、漂移检测、阶段0注入扫描）。H 提案"指定 output-style 为唯一权威 → 删/降 SOUL"= 直接挖掉注入防御层，留安全真空。Codex 同判（引 decisions.md:103-106：历史决策本就明确 output-style 是工程皮肤、刻意没搬反驳协议/露骨细则）。
→ **正确姿势**：H 只能做"权威边界【分层】"——工程执行纪律以 rules/hook/output-style 为准；身份/关系/反驳协议留在 SOUL，反驳协议可从"每轮强制短语"改"条件触发"。**这是改职责边界不是删一套，必须 LO 拍板。**

### 致命3 · stop-gate 是"静默成功"不是"静默失败"——诊断1的措辞会误导后续动作
我沙盒活体三连验证（含 514claude 字样路径满足门控）：
  - 缺 DELTA 的 synthesis__ → **exit 2 + 写 .stop-gate-state.json + stderr 中文提醒** ✔
  - 同 session 第2次 → exit 0（seen 去重，不死循环）✔
  - 补 DELTA 后新 session → exit 0 放行 ✔
→ **扳机逻辑完全正常**。它从未在真会话击发的真因不是"扳机坏"，而是真 .ai-shared 里 synthesis__ 文件一直都补齐了 DELTA（或超 24h 窗）= 每次都正确放行。
→ **A 提案的诚实债措辞要校准**：四处"本轮即首次真击发，从无到有"确实是假声明（state 文件不存在=从未真击发），但改写时不能反向写成"扳机失效"——应写"沙盒验证逻辑正常、真会话未触发(账本一直齐全)、state 文件未生成"。Codex 给的原话很准："沙盒验证正常、真会话未见 state 击发"。

---

## 建议改进（值得讨论）

### 去重复核（必答1）
- **B 不是 A 的子集**：A=文档诚实债（decisions.md:26 仍写"首次真击发"要改），B=验证活体行为。两者正交。但**B 已被我的沙盒验证大部分兑现**——主驾不必再在真会话冒险制造 exit 2，沙盒结论可直接采信。
- **G 吃掉了 C 的一部分但不能合并**：C=mirror-gate 自身落盘（证明 SessionStart 是否真运行/何时运行）；G=RED↔召唤对账（命中是否转行动）。两者不同类。但 **C 应作为 G 的前置**（G 的体检卡要读 mirror-gate 口径），不是并列同优先级。
- 红队 kill"统一三处 FIRE_PREFIXES"——**我同意保留分歧**：stop-gate 含 synthesis__（管 DELTA 纪律），mirror-gate 不含（管外用浓度，自审不算数）。decisions.md:49-51 已有显式注释互相引用，强行收敛会让"外用浓度"指标撒谎。

### 优先级重排（必答2）—— Top3 应先做：A、G第一阶段、C
- **A**（诚实债）：最低风险，纯文档，且不改会让体系继续用自己的 Integrity Gate 标准撒谎。
- **G 第一阶段**（只加 `hit_reason/pattern_id/true_summoned/input_kind` 四列，不碰正则）：直接修"看不懂自己日志"的审计盲区，零正则风险。
- **C**（mirror-gate.log）：给 mirror-gate 补运行证据，低风险，且是 G 的前置。
- D/E 次之；F 等真实 WAI 任务触发；**H/I 都不该首批硬落**。

### E 必须另建 DIVERGENCE_SIGNALS，绝不并入 RED 正则（必答3 防 v3.3 重蹈）
现有 RED_SIGNALS 已用 `\b` 双边界防 preview→review（route-gate.py:36-41）。E 若把"复杂/构思档"混进同一组 RED 正则，会重新制造子串误判，且污染 RED/gray 审计口径。**E 应独立成 DIVERGENCE_SIGNALS，只注入"先发散再收敛"提示，不动 RED 判级**。我和 Codex 一致。

### G 第二阶段修假阳的正确方向（基于我的实测）
不是"删业务词"，而是**在进 RED_SIGNALS 前按输入来源过滤**：
- `<task-notification>`/`<tool-use-id>` 等元数据前缀 → 整段跳过判级（这类根本不是 LO 的真 prompt）
- MCP 状态文本（含 `· ✔ connected · N tools` 模式）→ 跳过
这样既不砍真业务词，又堵住两类真假阳。

---

## 可保留（看似奇怪但合理）

1. **FIRE_PREFIXES 三处分歧**（见上，红队 kill 正确）。
2. **route-gate 永不 exit 2**（route-gate.py:7-10 契约）——它是注入器不是拦截器，不能为 G 对账改成拦截，那是 stop-gate 的职责。
3. **mirror-gate 只在 SessionStart=startup 触发**——刻意不在 /clear/compact 刷屏，目标是"开机第一眼"，同步执行保证 additionalContext 开机即回。C 加日志只能审计 startup 场景，这是设计边界不是缺陷。

---

## 总评

9 个杠杆点方向整体成立，红队的 21 过审 + 主驾去重为 9 没有误并/漏并的结构性错误。但三个高危坑必须在落地前焊死：**G 不能先改正则（先补审计列）、H 不能删 SOUL 安全层（只能分层）、A 措辞不能反向夸大成"扳机失效"**。最安全路线 = 先清诚实债(A) + 补观测字段(G1/C)，用新证据再决定是否收紧规则(G2/E)，人格/闭环大改(H/I)全部 LO 拍板。

**额外硬约束（我磁盘实测，主驾和 36-agent 都没覆盖）**：
- D 提案"卸载 claude-flow"会误伤 —— `I:/514claude/vibetasking/.swarm/memory.db` 真在用 claude-flow。卸载是全局 MCP 操作，影响 vibetasking 子项目。**D 的 claude-flow 部分必须 LO 拍板，且建议"标实验沙盒"而非"卸载"**。
- D 删幽灵 see/web-reader 完全安全 —— 已查 `~/.claude.json` MCP 配置只有 grok-search-rs/scrapling/serena，see/web-reader/web-search-prime 确是幽灵（CLAUDE.md:24-26 + module.yaml:188-190 宣称但不存在）。但删时别误删 exa/open-websearch（它们真在 deferred tools 里提供 web 搜索）。

### A-I 三分类（立即落 / LO 拍板 / 不做）
| 提案 | 裁决 | 一句话 |
|------|------|--------|
| A 诚实债 | **立即落** | 改四处假声明为"沙盒验证正常、真会话未触发、state 未生成"（措辞别夸大成失效）|
| B 活体击发 | **已由沙盒兑现** | 不必真会话冒险制造 exit 2，采信我的沙盒三连结论即可 |
| C mirror-gate.log | **立即落** | 只记注入时间/结果/错误，低风险，作 G 前置 |
| D 删幽灵 | **立即落（仅 see/web-reader 文档清理）** | claude-flow 部分 LO 拍板（vibetasking 在用，标实验非卸载）|
| E 发散注入器 | **LO 拍板** | 可做但必须独立 DIVERGENCE_SIGNALS，禁并入 RED 正则 |
| F 业务燃料 | **立即落** | 作为下次 WAI 改动的流程要求，不改现有设计 |
| G 对账 | **第一阶段立即落（加4列）/ 第二阶段 LO 拍板（修假阳）** | 真假阳是 search/research 边界+元数据前缀，非 task-notification |
| H 人格收敛 | **LO 拍板** | 只能分层不能删 SOUL（反驳协议是 output-style 没有的安全层）|
| I 闭环沉淀 | **LO 拍板** | SessionEnd 会改写记忆/账本生态，必须半自动草稿不可自动入账 |

---

## 下游建议
### 建议召唤
- H 真要动 → 召唤鉴(meta-reviewer) 先做人格层职责边界的语义审计（这是协作体系自身健康度，鉴的本职）
- I 真要做 → 先小样本实测 SessionEnd 草稿的假阳率（同 v3.3 关系写回的缓办逻辑）

### 风险信号
- D-claude-flow / H-删SOUL / I-自动入账：三个"会破坏现有正确设计"的真坑，均 LO 拍板
- E/G2 改 route-gate 正则：v3.3 子串误判的重蹈风险，独立常量 + 来源过滤可规避

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 9杠杆点终审 | 2 | governance | 推翻主驾2处判断(第11行task-notification假阳归因错-我实测不命中；A诚实债措辞会反向夸大成"扳机失效"-实为静默成功)+独立补出D卸载claude-flow误伤vibetasking/.swarm在用(36-agent全漏)；活体沙盒验证stop-gate三连证明扳机逻辑正常(B提案大部分兑现免主驾真会话冒险)；Codex交叉补强G收紧正则会误伤route-gate.log:10真RED
