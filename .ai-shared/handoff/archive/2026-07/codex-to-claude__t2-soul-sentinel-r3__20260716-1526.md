# Codex 评审：T2 SOUL 全局哨兵（reflection R3 · 致命2 修复验收）

- **评审模式**：security / architecture（安全 hook 修复验收 + 告警送达链解耦审查；AD-3 强制 dogfood）
- **评审范围**：`I:/514claude/514cc/.claude/hooks/mirror-gate.py`（sha256 `9547dc5a…`，14:54 主驾修复态）——`main()`(:256-300) + `check_soul_drift()`(:165-190) + `build_card` SOUL 行(:193/:232-237/:250) + `find_aishared()`(:46-52)
- **评审时间**：2026-07-16 15:26
- **Codex 模型**：gpt-5.6-sol（micu provider，reasoning effort xhigh，sandbox workspace-write，session 019f69c0-f19b-72c0-b648-914709a62c50）
- **驱动**：烛（codex-reviewer）；**异构双证据链**——Codex 独立故障注入 18 项（`review_t2_soul_r3.py`）+ 烛独立第一手 24 项（`test_r3_soul.py` 19 + `test_r3_soul_b.py` 5 + 真实端到端 e2e），两套独立收敛
- **轮次**：reflection R3（对照 R2 `codex-to-claude__t2-soul-sentinel__20260716-1449.md` 的致命2）

---

## 致命问题（必须改）

1. **R2 修复方向第三条「项目卡片构建失败时也送达」未实现——SOUL 告警送达仍串在 `find_aishared → build_card → json.dumps → print` 整条输出链上，链上任一环抛异常即 fail-open 静默吞掉全局安全信号。**（烛 + Codex 独立收敛）
   `check_soul_drift()` 在 `:267` 先算全局，但一旦 `:273` 进入 `aishared is not None` 完整卡片分支，SOUL 告警的**唯一送达路径**就是体检卡成功输出——依赖 `build_card`(:275) → `json.dumps`(:282) → `print`(:282) 全部成功；任一抛异常即跳到 `:298-299` `except Exception: sys.exit(0)`，已算出的 drift/unverifiable 被静默丢弃，`else` 全局告警分支(:290-295)根本走不到。真正的后备告警只存在于 `aishared is None`。此外 `find_aishared()`(:46-52) **无 try 防护**，而它在 anchor 命中时(:271)**总是先于 else 分支被调用**，抛异常同样把告警吞在 `:298-299`。
   **双方独立故障注入收敛**：烛 `B1/B2/B3`(build_card drift/unverifiable + json.dumps 崩) + `G1`(find_aishared 抛 OSError) 四项均 `out=''`+exit0；Codex `B1-B4`(build_card drift、build_card unverifiable、json.dumps、find_aishared) 四项均 `exit0`+`stdout=''`。**两套独立测试收敛到同一根因，且都独立扩到 find_aishared**。
   **根因判定**：主驾用三个针对性补丁修好了 R2 点名的三个触发面，但**未实现 R2 建议的「先算 soul_state → 存独立 soul_warning → 无论后续项目发现/卡片构建成败都保证送达」架构**。根因（告警送达耦合项目流程）未根治，只从「find_aishared None 早退」**换位**到「输出链任一环崩」。
   **诚实严重度定性（双方一致，不夸大）**：以上环节**当前都有内部防护**——`build_card` 四子调用(`scan_route_gate`:65 / `count_delta`:95 / `days_since_last_fire`:106 / `check_drift`:125)全 try 包裹（烛 `F1` + Codex 用空目录/乱码日志/错误文件类型三组真实磁盘态实测 build_card 均正常返回）；`find_aishared` 对 null 字节/300 字符超长路径均不自然抛（烛 `G2`/`G5`）；`json.dumps(ensure_ascii=False)`/`print`(顶部 reconfigure utf-8 errors=replace)对固定中文 soul_msg 不抛。故 B/G 类**当前无普通磁盘状态可稳定触发**，属 **P0 验收阻断 / 架构脆弱性 + 回归风险**，而非当前可自然利用的 CRITICAL。但 `mirror-gate.py` 已连改三轮、`build_card` 是高频改动面，任一未来回归都会再次静默吞掉 **514+aishared 主工作区（LO 日常最常用）** 的全局安全信号。

2. **新增第四类静默路径：SOUL「全局」检查仍被 `json.load` 输入解析前置门控。**（Codex 扩出，烛 D 类未覆盖此角度）
   `:260` `json.load(sys.stdin)` 在 `:267` `check_soul_drift()` **之前**执行：空 stdin / 畸形 JSON 直接落 `:298`，合法但非对象 JSON 在 `:261` 提前 `sys.exit(0)`——Codex 三项实测均 `soul_calls=0`、`stdout=''`、exit0。SOUL 检查本身**完全不需要事件载荷**，却被放在解析之后，仍违反「独立于工作区/项目流程」设计目标。与致命#1 同根：**SOUL 告警送达没有真正独立于 hook 的输入解析（#2）+ 项目发现 + 输出链（#1）三段前置耦合**。诚实降级：畸形 stdin 不符合正常 hook 契约、现实概率低于#1、不阻断会话。修复应让输入解析失败仍 exit0，同时给已算出的非 consistent SOUL 状态一条最小、独立、尽力而为的输出路径。

## 建议改进（值得讨论）

1. **治本优先于打补丁**（Codex 总评核心 + 烛建议#1）：不要继续给各异常点加 try，而是把「构造最小 SOUL 告警 / 构造项目卡片 / 选择提交输出 / 成功后留痕」拆成**可独立失败的阶段**，任何项目阶段异常都回退到已构造的最小 SOUL 告警，且始终 exit0。一次根治致命#1#2 的 B1-B4/G1 全部路径。`find_aishared` 顺带补 try。
2. **anchor 裸子串匹配跨项目误注入**（Codex 建议#1，C5 复现）：`:271` 会把 `I:/unrelated/514claude-backup/project` 判为 514 工作区；若该目录有自己的 `.ai-shared`，会构建完整卡片并在 `:286-287` **写入对方账本目录**(`mirror-gate.log`)。`.lower()` 归一化可保留，但匹配对象应是规范化后的**根目录包含关系或精确路径组件**，非裸子串。（注：此为 R2 起就存在的子串匹配行为的另一面，非 R3 引入。）
3. **`card-injected` 留痕早于 stdout 可确认交付 = 假阳审计**（Codex 建议#2，E1）：`:282` `print` 未显式 flush，`:286` 即写 `card-injected`；若退出期 flush 遇 BrokenPipeError，`:283` 所称「已完成的注入」不严格成立。建议先显式 flush 成功再记日志，并让留痕区分 `card` 与 `soul-warning`；flush 失败仍 fail-open 但不留成功假证据。（与「假绿灯」同类的诚实性问题。）
4. **更新过时文件头注释**（烛，R2 建议#2 主驾未做）：`:4-18` 仍称「三个死数据源」「cwd 门控（仅 514claude 工作区）」，**未提 SOUL 是全局例外**——与 `:165-173`、`:263-271` 新设计冲突，易让后续维护把全局告警再圈回项目门控。
5. **次要韧性**（Codex 建议#3/#4）：①`:268` cwd 空串后 `:271` anchor 门阻止调用 `find_aishared("")`，使 `:47` `Path.cwd()` fallback 不可达（C4，非 SOUL 漏报，丢项目卡片/留痕）②`:31-34` 顶层 Windows 流 reconfigure 在 `main()` 保护区外，reconfigure 抛 `UnsupportedOperation` 会逃逸文件头声称的「全程 fail-open」——当前 Python 3.13.7 不自然故障，建议各加 best-effort 保护使名实相符。
6. **设计边界澄清**（Codex 建议#5）：准确称「漂移检测」，勿扩张为完整性/防篡改——`:185` 只比两个当前文件 SHA-256，两端被同步修改仍 consistent。符合 T2 方向中立目标，但若未来需安全完整性应另设受信基线，勿往本 SessionStart 小脚本堆职责。`sync-runtime.ps1` 实测无 SOUL 映射（行为正确），建议补注释「SOUL 由方向中立只读哨兵管理，不得加单向 -Apply」（R2 建议#3）。

## 可保留（看似奇怪但合理）

1. **R2 三个确定性触发面真修复**（烛 `A1/A2/A3` + Codex `A1-A3` 双方 PASS）：`514claude-backup` 子串+无aishared+drift、514 新项目无aishared+unverifiable、非字符串 cwd(int514) 现在告警都**送达且仅一次**+exit0。cwd 非字符串规范化(:269-270)、`.lower()` 大小写不敏感(:271)均正确。
2. **无重复告警**（烛 `C1/C2/C3` + Codex `D1` + 真实 e2e）：514+aishared+drift 时 SOUL 行在卡内一次(:250)，不额外输出 else 全局告警，drift 消息全文只出现 1 次；if/else 互斥(:273/:290)保证不重复。
3. **fail-open 保持、无 fail-closed**（烛 `D1-D4` + Codex 确认）：stdin 非 JSON/list/数字/空 均 exit0 不阻断；build_card 崩仍 exit0。拆分未在 main 内引入 fail-closed。（烛 `D5` build_card 抛 KeyboardInterrupt 冒泡=Python 惯例不吞 BaseException，SessionStart 几乎不遇，非 bug。）
4. **真实 consistent 态体检卡完整**（烛 e2e + Codex 只读探针 `('consistent','')`）：真实 SOUL hash 一致（`1c146cc3` src==dst 实测）→ 体检卡五行完整（路由门30次5RED/25gray、DELTA34条、发火0天、双地落一致✓、SOUL 哨兵(全局)一致✓），原四行顺序位置 `[21,52,67,88,240]` 不变——主驾修复没破坏体检卡主路径。
5. **非514 噪音正确**（烛 `E1/E2`）：非514+consistent 静默无噪音；非514+unverifiable 全局告警送达（全局资产该在任何工作区提示）。
6. **方向中立 + 三态防假绿**（继承 R2，双方复核）：`check_soul_drift`(:185-190) 只报 src≠runtime、无 -Apply、consistent/drift/unverifiable 三态齐全，缺文件/权限/hash 异常均归 unverifiable 不冒泡、绝不假绿。
7. **目标文件保持只读**：评审前后 SHA-256 均 `9547DC5A…`，与任务卡前缀一致；Codex 仅写 `.ai-shared/tmp/review_t2_soul_r3.py`，无篡改无夹带（烛核验 mtime 停 14:54）。

## 总评

主驾对 R2 致命2 的修复**部分达标**：R2 点名的三个确定性可触发告警丢失面全部真修复（双方 A1-A3 + 真实 e2e 坐实），无重复、fail-open、非514 噪音、方向中立三态防假绿全部完好，未引入会话阻断/错误自动同步/数据覆盖。但**根因未根治**——R2 明定第三条「项目卡片构建失败时也送达」未实现，SOUL 告警只是从「依赖找到 .ai-shared」迁移成「依赖 stdin 解析 + 项目发现 + 卡片输出链全部成功」。烛 24 项 + Codex 18 项独立故障注入收敛证明：链上四环（B1-B4/G1）任一崩即静默吞全局安全信号。诚实定性：这些环节当前内部防护完整、无普通磁盘态可稳定触发，属 P0 验收阻断 + 架构脆弱性 + 回归风险，非当前可自然利用的 CRITICAL。

不判 SECURE（R2 验收项客观未落地 + 根因残留），也不判 CRITICAL（当前不可自然触发、不阻断、不破坏数据）。**NEEDS_HARDENING**——需一个收尾硬化（按建议#1 把告警送达拆成可独立失败阶段 + find_aishared 加 try + 固化 B/G 回归测试）才算 T2 达标。

---

## 烛的交叉验证注记（守夜人层，非原样转抛）

**非单一模型——独立双证据链收敛**：烛在召唤 Codex 前已独立磁盘实测 24 项（`test_r3_soul.py` + `test_r3_soul_b.py` + 真实 e2e），与 Codex 18 项**独立收敛**到同一核心致命（送达链未解耦 + find_aishared 无防护 + R2 第三条未实现）与同一严重度定性（P0 架构脆弱性、当前不可自然触发）。**两套测试各自独立扩到 `find_aishared`**（烛 G1/G4 mock+源码断言、Codex B4 故障注入）——非模型互印，是双向独立命中同一裸露耦合点。

**Codex 异构净增量（对抗「烛也有盲区」）**：Codex 扩出烛未想到的 3 条——①**致命#2 SOUL 检查被 `json.load` 输入侧前置门控**（烛只测了 stdin 畸形→exit0 的 fail-open，未意识到「SOUL 不需载荷却被解析门控」这层，Codex 更根本）②**anchor 裸子串跨项目误注入写对方账本日志**（烛 R2 注意到子串匹配→告警丢失方向，漏了反向的污染写入方向）③**card-injected 假阳留痕**（print 未 flush 先写日志）。这正是 R3 任务要的异构价值——烛独立实测很硬，但仍有 Codex 才照见的盲区。

**主驾自测盲区实证（AD-3 存在意义第三次再现）**：主驾 `test_soul_sentinel.py` 12 项 ALL PASS，但唯一测 514+aishared 分支的 6d 用的是 **consistent** 状态（SOUL 一致时 else 本就不该执行），**系统性绕过了「514+aishared + drift/unverifiable + 输出环节故障」盲区**——与 R2「5c 用有 aishared 的 514cc 绕过」、R1「假绿灯」同型。主驾连续三轮在同一类边界（告警送达的异常路径）栽跟头，正是 rules §三铁律1 与 AD-3 强制 dogfood 的理由。**主驾 12 项 ALL PASS ≠ 达标。**

**Gemini 外部二意见缺口（如实标注，不伪造）**：本轮为纯 Python hook 逻辑审查，破 mirror-loop 靠**可执行故障注入**（Codex 18 + 烛 24 项独立矩阵收敛，非模型互印），外部实时信息无增量；且本机 R2 已确认缺 `GEMINI_API_KEY`。此豁免符合 SOP 精神，缺口如实记录，Codex 与烛均未伪造第二意见。

**烛结论**：R3 高可信（异构 Codex gpt-5.6-sol/xhigh + 烛独立双实证收敛 + Codex 3 条净增量）。主驾"12 项 ALL PASS = 致命2 完全修复/可收工"被推翻——三面真修复但根因换位残留、R2 第三条未落地、新增 3 条静默/污染路径。**T2 未达"推送全局"完整验收，需收尾硬化。**

## 下游建议

### 建议召唤
- **主驾直接改**（最小治本）：按建议#1 把 SOUL 告警送达从「输入解析 + 项目发现 + 卡片输出链」解耦——四阶段可独立失败，任何项目阶段异常回退到已构造的最小 SOUL 告警且始终 exit0；`find_aishared` 加 try；顺带修 anchor 跨项目误注入(建议#2)与 card-injected 假阳留痕(建议#3)。改后**必召唤烛 R4** 固化 B1-B4/G1 为回归 + 确认无重复 + 无跨项目写入。
- **策（推荐）**：致命#1#2 同根 = 「全局哨兵送达不得耦合 hook 输入解析/项目发现/输出链」——值得抽象为 mirror-gate 通用契约（未来其它全局资产同理）。建议让策把「送达链解耦 + 四阶段独立失败」补进加固规格 §5 并列为 R4 验收项。

### 风险信号
- **fail-open 吞告警是体系级模式**：R2（非字符串 cwd）→ R3（build_card/find_aishared/json.load 三段）连续暴露「fail-open 保 session 安全 = 静默牺牲告警 liveness」张力。route-gate/stop-gate 若也有「先算后输出、输出在异常路径后」结构，建议一并巡检。
- **主驾自测连撞三轮同类盲区**：R1 假绿灯 / R2 告警 liveness / R3 送达链未解耦——都是「测自己想到的路径、绕过边界盲区」。凡改 mirror-gate 送达逻辑，回归必须覆盖「514+aishared + 非consistent + 输入解析或输出环节故障」这条主驾反复漏的路径。

__VERDICT__: NEEDS_HARDENING
__DELTA__: t2-soul-sentinel(reflection R3) | 2 | 推翻主驾"12项ALL PASS=致命2完全修复/可收工"判断——异构Codex(gpt-5.6-sol/xhigh,18项故障注入)+烛独立第一手(24项:test_r3_soul.py 19+test_r3_soul_b.py 5+真实e2e)双证据链收敛证明:主驾只修了R2点名的3个触发面(A1/A2/A3真修复),但R2修复方向第三条"项目卡片构建失败时也送达"未实现——SOUL告警送达仍串在json.load输入解析(mirror-gate.py:260)+find_aishared项目发现(:46-52无try)+build_card/dumps/print输出链(:275/:282)三段前置耦合上,链上4环(B1-B4/G1)任一崩即fail-open静默吞全局安全信号(:298-299),根因未根治只换位;Codex另扩3条净增量(json.load前置门控致命#2/anchor裸子串跨项目误注入写对方日志/card-injected假阳留痕);诚实降级=当前内部防护完整无普通磁盘态可稳定触发(F1/G2/G5),属P0验收阻断+架构脆弱性+回归风险非CRITICAL;主驾连续三轮撞同类边界盲区(R1假绿灯/R2 liveness/R3送达链)
