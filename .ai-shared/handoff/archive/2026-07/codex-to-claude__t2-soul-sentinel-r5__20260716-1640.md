# Codex 评审：T2 SOUL 哨兵治本加固 R5（E1/D1b）

- **评审模式**：deep-review（reflection R5 · 异构故障注入双证据链）
- **评审范围**：`I:/514claude/514cc/.claude/hooks/mirror-gate.py`（`main()` :269-341，聚焦 E1/D1b）
- **评审时间**：2026-07-16 16:40
- **Codex 模型**：gpt-5.6-sol（reasoning xhigh）
- **目标文件 sha256**：评审前 `233C053344C9B1576114191CE0857048F3F56BCF73ECACB3B374C7BF3B94A782`（只读，评审后复核未变）
- **Gemini 二意见**：❌ 未做——`GEMINI_API_KEY` MISSING（如实标注，绝不伪造异构结果）。异构性由 Codex(gpt-5.6-sol) + 烛第一手 monkeypatch 故障注入**双独立证据链**保证。

## 证据链方法（双独立复现）
- **链1（烛第一手）**：`scratchpad/fault_inject_r5.py`（19 断言 / 场景 A–K）+ `fault_inject_r5b.py`（partial vs total write 精确对比）。importlib 加载模块 + monkeypatch `sys.stdout`/`check_soul_drift`/`build_card`/`find_aishared`，可执行实测，非静态读。
- **链2（Codex 独立收敛）**：Codex 自写无落盘 monkeypatch 脚本，独立复现，未被烛预先喂结论。
- **两链结论完全一致**，且 Codex 额外照出烛故障注入未覆盖的伴生缺口（write 短返回）。

---

## 致命问题（必须改）

**1. D1b「绝不拼双 JSON」承诺不成立——`card_written` 标记点无法覆盖 partial write（第五类新边界，双链坐实）**

控制流：`card_written = False`（:304）→ `sys.stdout.write(json.dumps(...))`（:313）→ **只有 write 正常返回后**才 `card_written = True`（:314）。当 write **部分写出 JSON 前缀后抛异常**（带缓冲 TextIO 在 write 触发隐式 flush 时可能只写出部分字节再抛 IOError/EPIPE）：
`card_written` 仍为 `False` → :329 except → :330 `if card_written` 为假 → :332 pass 允许回退 → :334 `emit_soul_warning()` → :285 **写第二份完整 JSON**。

- 烛实测（场景 E）：`partial_on=1` → `write_calls=2`，`json完整段=0`，`total_len=323`，stdout = **半段体检卡 JSON + 完整 SOUL 告警 JSON**，整体无法解析（`半体检卡存在=True 且 完整告警存在=True`）。
- 烛精确对比（r5b）坐实缺陷**特定于「部分成功」**：`write 完全失败(0字节)` → 回退**正确**（单段：体检卡 0 字节 + 完整告警，json=1）；`write 部分失败` → 回退**错误**（双段损坏，json=0）。`card_written` 无法区分「完全没写」与「写了一半」。
- Codex 独立复现：2 次 write、缓冲区含 2 个 `{"hookSpecificOutput"` 起点，形态「半段体检卡 + 完整 SOUL」。

**伴生缺口（Codex 独立照出，烛故障注入未覆盖）**：代码不检查 `write()` 返回值。若流**短写并返回 `< len(payload)` 而不抛异常**，:314 仍标记成功，随后 flush、:321 留痕 `card-injected`、return —— 截断 JSON 被认定送达，**R3 已修的留痕假阳在此路径重新出现**。

后果与定级：fail-open 底座**仍在**（exit 0 不阻断会话），但 stdout 交给 Claude Code 的是**损坏/截断 JSON** → `additionalContext` 解析失败 → 体检卡与 SOUL 告警**双双丢失**。这正是连撞四轮的**同一类**（告警送达异常路径），是主驾在 D1b 里想不到的第五条路。承诺是绝对的（「绝不拼双」），一个确定性反例即证伪。

治本原则（烛+Codex 收敛，仅评审不改）：**在首次接触 stdout 前选定唯一 payload**（体检卡 XOR 最小告警），一旦开始 stdout 写入，无论 write 返回还是抛错，都不得再写第二个顶层 JSON。
- 最小止血：把 `card_written = True` **前移到 `sys.stdout.write()` 之前**（乐观占用 stdout）——partial-write 后 `if card_written: return` 不再追加 emit（代价：write 0 字节失败时也不回退 emit，但 stdout 干净单段优于双段损坏，且 0 字节失败通常意味 stdout 整体已坏 emit 亦送不出）。
- 补短返回：`write()` 后校验返回值 == `len(payload)`，短写则续写同一 payload 剩余后缀（`while written < len: written += write(s[written:])`），不满足才留痕。对「抛异常但已写多少未知」只能停止 stdout 重试、另行留失败证据，不能同时保回退送达与单 JSON 原子性。

---

## 建议改进（值得讨论）

1. **E1 对普通 `Exception` 已 fail-open，但不覆盖 `BaseException`**（触发概率极低，诚实标注）：`check_soul_drift()` 若抛 `SystemExit`，:335 `except SystemExit: raise` 会重抛，Codex 实测逃逸为 `SystemExit(7)`、无输出；`KeyboardInterrupt` 等亦不在兜底。现实中 check_soul_drift 纯 hashlib+文件读、内部 `except Exception` 已兜底，几乎不可能抛 BaseException——属**理论完备性**缺口。若「绝不阻断」要含这些路径，需扩兜底范围。
2. **最小告警丢失显式三态标签**：`emit_soul_warning()`（:284）只拼 `soul_msg`，E1 异常时文本是默认「SOUL 状态计算未完成」而非任务卡所述显式「无法核验」。语义上确属告警、**不是**假绿灯，但建议最小路径也带状态标签更清晰。
3. **anchor 已修裸子串但未规范化路径**：:263 组件比较正确拒绝 `514claude-backup`/`x514claude`（实测均 False），但 `I:/514claude/../unrelated` 仍返回 True。注意 anchor **只决定「要不要出项目级体检卡」、不是安全边界**（SOUL 告警不走 anchor），故 `../` 绕过无安全后果；若注释暗示更强隔离则应规范化，否则可保留。
4. **把本轮故障注入固化为回归测试**：至少覆盖 partial-write 后抛错、write 短返回、flush 零/部分/全部写出后抛错、fallback 自身 partial-write、`SystemExit`。普通「全写/全失败」测试不足以证明输出事务边界——这是连撞四轮仍漏的根因（测试模型太粗）。

---

## 可保留（看似奇怪但合理）

1. **E1 默认状态与赋值位置合理**（:276 先设 `unverifiable` → :292 尝试计算）：普通异常下保留默认并 exit 0，不假绿、不 fail-closed。烛场景 A + Codex 均确认。
2. **flush 独立捕获**（:315-328）：完整 write 后 flush 抛错不回退、不留痕、直接 return——正确避免「完整 write 后 flush 崩再拼第二 JSON」。烛场景 C 确认单 JSON。⚠️ 但注意其保证仅「应用层不主动追加」，stdout 外部可见状态仍可能零/部分/全部，不等同「已送达」。
3. **write 前崩三类回退符合预期**：build_card / 首次 json.dumps 在写 stdout 前抛错 → `card_written=False` 回退最小告警；json.load 抛错（:293-296）降级 `None`、非 consistent 仍送告警。烛场景 D/F/G/H/K + Codex 三注入均 exit 0 单 JSON。
4. **三态防假绿 / 方向中立无回归**（:183-193）：仅 hash 明确相等才 `consistent`，缺失/路径/权限/读取异常均 `unverifiable`；漂移文案列两个人工方向、无 `-Apply`。烛场景 J 确认体检卡 SOUL 行正确显示「一致」。
5. **正常路径留痕顺序正确**（:321）：仅 flush 正常返回后才写 `card-injected`，flush 崩不留成功记录。除上述 write 短返回缺口外，R3 留痕假阳已修复。

---

## 总评

R5 确实修好了两处 R4 遗留：普通异常下的 E1 fail-open（不假绿不 fail-closed）、以及「完整 write 后 flush 失败再回退」的双写路径；三态、方向中立、anchor 组件精确匹配、正常留痕顺序均未回归。**但治本加固自身引入了第五类新边界**：D1b 把「`write()` 正常返回」误当成「stdout 从未处于部分提交状态」。partial-write 后抛异常会**确定性**进入第二 JSON 回退，双独立故障注入均复现双段损坏；write 短返回还会产生截断 JSON + 留痕假阳。「绝不拼双 JSON」核心验收未完成，**不能判 SECURE**。

这是连撞四轮同类盲区的**第五轮延续**——主驾自测 ALL PASS、烛用铁证照出同一类（告警送达异常路径）新洞。元教训再次坐实：**普通「全写/全失败」测试模型无法证明输出事务的原子性边界**，必须以「异常时已写多少字节未知」为核心状态变量做故障注入。本轮只读评审，未修改任何文件。

---

## 下游建议
### 建议召唤
- 主驾据治本原则改 D1b（card_written 前移 + write 返回值校验）后，**必须再来 R6 验收**（连撞四轮=该模式高危，不可自测放行）。
- 建议同时落建议4 的回归测试套件（可直接固化 `fault_inject_r5.py`），把「输出事务边界」变成机械扳机而非每轮人肉照。

### 风险信号
- 承诺型注释（「绝不…」）是高危信号：绝对承诺 + 粗测试模型 = 反复栽跟头。建议后续凡「绝不 X」类保证，配套一条证伪型故障注入。

__VERDICT__: NEEDS_HARDENING
__DELTA__: T2 SOUL 哨兵 R5 治本加固 | 2 | 推翻主驾「D1b 绝不拼双 JSON」判断——partial-write 确定性双段损坏（mirror-gate.py:304/313/314/329-334）+ write 短返回留痕假阳，双独立故障注入复现
