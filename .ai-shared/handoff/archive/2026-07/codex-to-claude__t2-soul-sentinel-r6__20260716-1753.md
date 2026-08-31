# 烛 R6 验收：mirror-gate 契约驱动重构（是否终结五轮循环）

- **评审模式**：deep-review（对抗式 + 异构故障注入双证据链）
- **评审范围**：`I:/514claude/514cc/.claude/hooks/mirror-gate.py` 全文（契约驱动重构版）+ 回归基线 `tests/test_mirror_gate_contract.py` / `test_meta_baseline.py`
- **评审时间**：2026-07-16 17:53
- **Codex 模型**：gpt-5.6-sol / xhigh（provider micu）
- **目标文件 sha256**：评审前后一致 `D89C504E…64D5C53D`（只读未改，诚实要求3 满足）
- **证据链**：①主审自证探针（`probe_sixth_boundary.py`）②Codex 异构探针（`.ai-shared/tmp/codex_r6_fault_injection.py`，**主审亲自执行**得确定 JSON，非转述 Codex 记忆）③Codex session `019f6a47`（xhigh 跑满 10min 被 SIGTERM，结论文字从 session 提取）

---

## 致命问题（必须改）

**无当前可达的致命问题。** 按对抗式铁律7（0 致命=可疑），给出"为什么核心结构不可能再有双段损坏（R1-R5 的病）"的**正面论证**，而非"我没找到"：

1. **AST 静态实证（`ast_structure`）**：main 中承载 payload 的 `stdout.write` 调用点 = **恰 [363] 一处**；`build_payload` 的 stdout 引用 = **[] 零处**。构造相物理上无法写 stdout，输出相只有一个 write 点——**代码里不存在能表达"第二次 stdout 写入"的语句**。INV5/INV9 从"靠 review 守"变成"靠结构不可能违反"。
2. **partial-write 动态实证（`partial_write`）**：write 写一半即抛 → `write_calls=1`、`log_exists=false`、无第二 write。即使 write 中途崩，**没有任何回退再写**——R5 的"半个体检卡 + 完整 SOUL 告警"双段损坏结构性根除。
3. **全 fail-open 实证**：stdin.read 崩 / MemoryError / build_payload 漏网异常 / flush 崩 / log open 崩 / 8MB stdin / 4M 字符 payload → 全部 `raised=null`（exit 0）。SystemExit/KeyboardInterrupt/GeneratorExit 正确传播（符合 INV1 谓词"except Exception 不含 BaseException"）。
4. **INV2 不假绿实证（`hash_failures`）**：sha256 抛 OSError → `check_soul_drift→unverifiable`、`check_drift→([],[],[rules.md,output-style])`，无一冒充 consistent。
5. **INV7 anchor 精确（`anchor_extremes`）**：`514claude-backup→False`、`x514claude→False`、空字节路径/10万字符路径→False 不崩。

> **结论**：五轮循环的核心病灶（两输出点 + 回退再写 ⇒ 双段损坏）**确实被结构性终结**——这是五轮来第一次有 AST 静态 + 动态 partial-write 双重可验证的保证，不是又一个分支补丁。这一点值得肯定。

---

## 建议改进（值得讨论）

对抗式核心发现——**第六类边界确实存在，但不在核心结构，而在「基线覆盖精度」与「契约边界防御深度」**。任务卡问"有没有哪条 INV 异常路径没被 15 用例覆盖"，答案是**有 4 类**（当前正确实现+真实 IO 下不可达，但正是"实现被改错时基线守不住"的隐患——即策 §5 所称五轮循环的社会工程学根源）：

### 建议1【基线精度 · INV4 未真正被守】
`partial_write`/`short_write` 实测 `json_valid=FALSE`（stdout=42 字符半个 JSON，payload_len=84），但基线 T1/T2 断言只用 `count_json_segments(out) <= 1`——半段里 `"hookSpecificOutput"` 出现 1 次，count=1 通过。**基线声称守 INV4（"可解析 JSON 或空"），实际只守了 INV5 近似（无双段）**。半个不可解析 JSON 既非空也不可 `json.loads`，**严格违反 INV4 字面谓词**（策 §1 INV4）。后果=漏一次（与策 §2.4 trade-off 一致，无双段），但基线的 count≤1 掩盖了这个事实。
→ **修**：T1/T2 补横切断言 `assert out=="" or json_valid(out)`。即使结论是"接受 trade-off",也应显式断言而非用 count≤1 掩盖。

### 建议2【基线机械化 · 失败不反映 exit code】
`baseline_forced_failure` 实测：往基线注入一条强制失败 → 打印 "SOME FAILED" 且 `forced_failure_visible=true`，但 **`returned_normally=true`**（脚本正常 exit 0）。`test_mirror_gate_contract.py`:169 末尾只 `print`，无 `sys.exit(1 if failed)`。**未来接 CI/机械化，失败无法靠退出码自动判红，只能人肉看字样**——与"把纪律焊到机械扳机"（rules.md §三精神）相悖，这套"回归基线"目前不是机械可判定资产。
→ **修**：两个 test 末尾加 `sys.exit(0 if all(r[1] for r in R) else 1)`。

### 建议3【INV1 唯一裸露点 · :359 解包】
`main()` 的 `tag, payload, aishared = result`（**:359**）裸露在两个 try（:352-355 与 :362-371）之间。实测（`unpack_1..5`）：build_payload 返回 `()`/2-元组/4-元组/`'bad-result'` → **ValueError 冒泡**；返回 `7` → **TypeError 冒泡**——**违反 INV1**。另 `unpack_three_char_string`（返回 "abc"）→ 不冒泡但解包成 tag/payload/aishared 各 1 字符 → `stdout="b"`、`json_valid=false`（垃圾输出，违反 INV4）。当前 build_payload 只返回 3-元组或 None 故不可达，但 **main 的 fail-open 不再自足，耦合到 build_payload 返回契约**——这正是 R1-R5"改一处 build_payload 引入新洞"模式的同构复现，且 15 用例全走真实 build_payload、无一注入畸形 result。
→ **修**：把 :359 解包纳入 :362 的 try（3 行改动，廉价根除 main 里 INV1 的唯一裸露点，让 fail-open 自足）+ 补一条基线用例 `mock build_payload 返回 2-元组 → main fail-open`。

### 建议4【纵深防御 · build_payload 裸露抛点】
`build_payload` 内 `_parse_cwd`(:324) / `_anchor_match`(:325) / `_wrap_card`(:330) / `_wrap_soul`(:335) **无独立 try**。实测（`parse_cwd_exception`/`wrap_card_exception`/`wrap_soul_exception`）：强制抛时 `raised=null`（main 顶层 except 兜住 fail-open）但 **`soul_delivered=FALSE`**——SOUL drift 告警静默丢失。尤其 `_wrap_soul`(:335) 是 SOUL 告警的最后包装，它抛则 SOUL 必然送不出。策 INV3 谓词列表未含这几个函数，且它们正确实现下不抛（`_anchor_match` 自带 try、`_parse_cwd` 对任何 json.loads 产物不抛、`_wrap_*` 只构造字面量），故当前不可达。但 INV3"SOUL 送达解耦"的完整性依赖这些点不抛。
→ **修（低优先）**：`_wrap_soul` 调用点(:335)纳入 safe 包装，保证 SOUL 告警送达不被最后一层包装异常吞掉。

---

## 可保留（看似奇怪但合理）

1. **short_write 留痕假阳**（`short_write`：`log_exists=true` + `json_valid=false`）：write 短返回（不抛）→ flush 成功 → 留 `card-injected` 但只写半个 JSON。**真实 `sys.stdout`（TextIOWrapper，经 :34 reconfigure）write 契约是写全部或抛，不短返回**——生产不可达。Codex 的洞察（main 不校验 write 返回值）有价值但非缺陷；若追求极致可在留痕前加送达完整性校验，非必要。
2. **import 期 reconfigure 崩**（`import_reconfigure_exception`：raised=OSError）：:31-34 无 try，reconfigure 抛则 import 失败。但 :33 已 `hasattr` 守门，真实终端不抛；且这是 import 期（非 main 运行期），SessionStart hook import 失败由 harness fail-open。极罕见，可保留。
3. **大小写不敏感 anchor**（`514CLAUDE→True`）：:264 `p.lower()==WORKSPACE_ANCHOR` 有意为之，Windows 路径大小写不敏感，正确。
4. **并发 log 31/32 行**（`concurrent_log_32_processes`：line_count=31、`malformed_lines=0`）：32 进程并发 append 丢 1 行但**零交错损坏**。留痕是尽力而为的非关键路径，可接受。

---

## 总评

**契约驱动重构在结构上真正终结了五轮循环的病**——不是第六个分支补丁。AST 静态（main 单 write@363 / build_payload 零 stdout）+ partial-write 动态（无第二 write、无双段）双重实证，双段损坏从"靠 review 守"变成"靠结构不可能违反"。15 用例全绿 + 元验收 4 buggy 全红（R5→seg=2 / R3→冒泡 / R2→seg=0 / R1→假绿），基线相对前五轮是真实进步。

**但"循环彻底终结、R6 完全通过"的声称尚需 4 项加固支撑**：第六类边界以「基线覆盖精度」形态真实存在——基线用 `count≤1` 近似 INV4 放过了 partial/short write 的半个 JSON（INV4 字面违反）、基线失败不反映 exit code（非机械可判定）、:359 是 main 里 INV1 的唯一裸露点（契约破坏即冒泡）、build_payload 有裸露抛点会吞 SOUL 告警。这些当前不可达，但**恰恰是"实现被改错时基线守不住"的同一类隐患**——五轮都栽在这。核心结构可以肯定，基线与契约边界的机械防御需补上这最后 4 环，循环才算真正焊死。

优先级：建议2（exit code，1 行×2）+ 建议3（:359 纳入 try，3 行）应做——极廉价且直接堵 INV1/机械化两个缺口；建议1（json_valid 断言）次之；建议4 低优先。

---

## 下游建议

### 建议召唤
- 主驾按建议 1-3 改基线 + :359 后，可再走一轮烛 R7 快速复核（仅验 4 项加固，非全量重评）。
- 无需召唤织/匠/策——本轮是纯结构+基线问题，无外部情报/领域/规格缺口。

### 风险信号
- **基线"15/15 绿"≠ 契约全绿**：Codex 首轮即推翻此隐含判断（partial-write 被 count≤1 放过）。主驾勿凭"基线全绿 + AST 单点"直接声称 R6 通过——那正是任务尾部凭记忆标完成的社会工程学陷阱（策 §5 警告）。

__VERDICT__: NEEDS_HARDENING
__DELTA__: 烛(调 Codex gpt-5.6-sol) | 2 | 推翻"15/15+元验收4/4=基线真守边界"隐含判断——证据：partial/short write `json_valid=false` 被基线 T1/T2 `count≤1` 放过（INV4 字面违反未被捕获，test_mirror_gate_contract.py:104/109）+ baseline_forced_failure `returned_normally=true`（失败不反映 exit code，test_mirror_gate_contract.py:169）；另主审 :359 解包裸露经 Codex 独立复核证实（unpack_1..5 冒泡 ValueError/TypeError）
