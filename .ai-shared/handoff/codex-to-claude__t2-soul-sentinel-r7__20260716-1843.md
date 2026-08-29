# 烛 R7 快速复核：mirror-gate 4 环加固（R6 后收尾）

- **评审模式**：快速复核（仅验 R6 4 项加固 + 回归 + 无新洞，非全量重评）
- **评审范围**：`mirror-gate.py` + `tests/test_mirror_gate_contract.py` + `tests/test_meta_baseline.py`
- **评审时间**：2026-07-16 18:43
- **证据形式**：**主审确定性脚本验证**（AST 静态结构 + subprocess 真跑两 test + 内存 exec 注入失败实验 + mock 对抗），**本轮未调 Codex CLI**——理由：①前 R7 实例正卡死在 Codex 单次调用（任务卡明确警告 timeout 风险）；②4 项加固均为**可机械验证点**，确定性脚本是比 Codex 记忆更强、可复现的证据；③R6 已完成 Codex 异构深度对抗（session 019f6a47 跑满 10min）。此为诚实的方法论选择（明确说明用什么、为什么），非 silent fallback。
- **目标文件 sha256（评审前后一致，只读未改，诚实要求3 满足）**：
  - `mirror-gate.py` = `16446647bda9a20f3191fd202c473f8faf9304710b6184b81d95c7a258fa9c33`
  - `test_mirror_gate_contract.py` = `06264c4347d8b7e59c3a6291a529326164b2af62da4c3bea57524c316e232e64`
  - `test_meta_baseline.py` = `b9830b0ec9c53451ada28248882ce254a2310e1674fc98ceb72658662564ee60`
- **外部情报**：本轮为纯结构/基线复核，无 Web/文档/领域缺口，**未召唤织/Gemini**（非缺 key 受阻，是无需求——与 R6「无需召唤织」一致）。

---

## 致命问题（必须改）

**无。** 按对抗式铁律7（0 致命=可疑）给正面论证，非"我没找到"——每条都有主审亲自执行的确定性证据：

**建议2 验回（R6 `baseline_forced_failure` 原始发现）** — 这是 R6 唯一被机械证实的"失败不反映 exit code"缺口，务必验回，已验：
- 内存 exec 注入一条强制失败 `R.append(("__FORCED_FAIL_R7__", False, ...))` 到**真实 test**（不改盘）：
  - contract → **exit=1**（尾 `SOME FAILED (21/22)`）
  - meta → **exit=1**（尾 `❌ 有假基线用例，必须重写 (4/5)`）
- 未注入对称健全：contract `exit=0` / meta `exit=0`。
- → R6 的 `returned_normally=true`（`print` 无 `sys.exit`）已修死。**这套基线现在是机械可判定资产，可接 CI**。

**建议3 验回（:359 解包裸露 → INV1 唯一裸露点）**：
- **AST 硬证据**：全模块 `sys.stdout.write` 调用点 = **恰 [373] 一处**；`main()` 内 = [373]；`build_payload()` 内 stdout 引用 = **[] 零处**。解包纳入输出相 try（`mirror-gate.py:371-380`）**未引入第二 write**，INV5 单点保持。
- **6 种畸形返回实测全 fail-open 不冒泡**（mock build_payload）：`()`/`2元组`/`4元组`/`int-7`/`None` → `raised=None seg=0`；`"abc"` → `raised=None seg=0 out='b'`。R6 的 `unpack_1..5` ValueError/TypeError **冒泡已根除**，main fail-open 自足、不再耦合 build_payload 返回契约。

**建议4 验回（`_wrap_soul` 裸露抛点吞 SOUL 告警）**：
- `_wrap_soul` 抛 → `raised=None seg=0`（最后一层包装崩无法产告警，但 **fail-open 不冒泡**）。
- `_wrap_card` 抛 → `raised=None seg=1 含哨兵=True`（card 构造失败**降级 SOUL 告警不丢**，INV3 送达解耦保持）。
- → `_safe_wrap_dumps`（`mirror-gate.py:287-292`）双层 try 生效，SOUL 告警不被最后一层包装异常吞成 fail-closed。

**建议1 验回（json_valid 字面守卫）**：
- 读 diff：新增 `json_valid` 谓词（contract:28-37）+ `INV4a` 正路/`INV4b` 降级/`INV4c` 静默三条**对"应可解析"路径做字面守卫**（半段会被 json.loads 捕获，count≤1 捕获不了）；`INV4d` partial-write 显式记 `json_valid=False` 是策 §2.4 trade-off（extra 明写，**不用 count≤1 掩盖**）。
- subprocess 真跑：**contract 21/21 ALL PASS exit=0**（含 INV4a-d）、**meta 4/4 元验收通过 exit=0**（R5→双写/R3→耦合/R2→门控/R1→假绿 buggy 全变红）。

> **结论**：R6 提的 4 环加固**全部真落地**——建议2/3/4 是机械可验的结构改动（exit code / AST 单点 / fail-open），已用确定性证据逐一验回；建议1 以更合理的方式响应了 R6 精神（在"应可解析"路径用 json_valid 字面守，partial-write 显式暴露 trade-off 而非掩盖）。核心结构（R6 已证的 AST 单 write + partial-write 无双段）在本轮 AST 复验中保持不变。

---

## 建议改进（值得讨论）

**残留（改进级，均不影响 SECURE）**：

### 建议A【元验收缺口 · json_valid 新守卫未被"测试测试本身"】
`INV4a/b/c` 三条新增 json_valid 守卫**没有对应的元验收**——`test_meta_baseline.py` 无一个 buggy 让 `INV4a` 变红。即：json_valid"能捕获半段坏实现"这一能力，目前靠 `json.loads` 的确定行为**逻辑保证**，而非被 meta baseline **机械证明**。按 meta baseline"防假基线、测试测试本身"的最高立意（§3.4），新增守卫理应配一条元验收（如：mock 正路产半段 JSON → `INV4a` 应红）。
→ **修（低优先）**：meta 补一条 buggy——正路强制产 42 字符半段 → 断言 `INV4a(json_valid)` 变红。当前 json.loads 行为确定，不补也不致命，但补上循环才真正"焊死"。

### 建议B【`str-abc` 边界性质未变 · 仅提示非缺陷】
建议3 深验中 build_payload 返回 `"abc"`（3 字符串）→ 解包成功 `tag='a'/payload='b'/aishared='c'` → write `'b'` → `seg=0 raised=None`（fail-open 但产单字符垃圾 `'b'`，json_valid=false）。与 R6 `unpack_three_char_string` 判定**完全一致**：build_payload 真实只返 3-元组或 None，**当前不可达**；即使可达也仅 fail-open 输出单字符（无双段、不冒泡、exit 0），**非建议3 引入的新洞**。仅提示：这是解包纳入 try 后唯一"非 None 畸形能穿过"的路径，性质无变化。

---

## 可保留（看似奇怪但合理）

1. **`main()` 预初始化 `tag = aishared = None`（:370）**：解包在 try 内崩时 tag/aishared 保持 None，但那种情况 except 已 return、到不了副作用相，预初始化是无害防御性冗余。合理。
2. **`_safe_wrap_dumps` 双层 try（外层 + safe_dumps 内层）**：safe_dumps 自己已 try（返 None 不抛），外层再包一层覆盖 `wrap_fn(arg)` 调用抛点。冗余但正确，纯构造相无性能顾虑。合理。
3. **`INV4d` 断言仍用 `count≤1`（与 T1 同条件）**：INV4d 作为独立断言项不比 T1 多守（都是 count≤1），其价值在 extra 字段**文档化 partial-write trade-off**。非强断言，但显式暴露 §2.4 取舍，合理。

---

## 总评

**R6 提的最后 4 环加固全部真落地，五轮循环的焊死收尾完成**。建议2（exit code 机械化）、建议3（:359 纳入 try、INV1 自足）、建议4（`_safe_wrap_dumps` 纵深）是可机械验证的结构改动，已用**主审确定性证据**逐一验回：注入失败真 exit=1（R6 原始发现修死）、AST 全模块 `stdout.write` 恰 1 处 @373（建议3 改 main 未破坏 INV5 单点）、6 种畸形返回全 fail-open 不冒泡、wrap 抛降级 SOUL 不丢。建议1 以更合理的方式响应 R6 精神（json_valid 字面守"应可解析"路径 + partial-write 显式暴露 trade-off）。回归全绿：contract 21/21 exit=0、meta 4/4 buggy 全红 exit=0。

**逐一对抗审查 main/build_payload 的每处改动均无引入新问题**（预初始化冗余无害、双层 try 正确、str-abc 边界性质与 R6 判定一致、不可达）。唯一残留（建议A：json_valid 新守卫缺元验收）为改进级、不致命——json.loads 行为确定，逻辑自洽。

**这是有确定性证据支撑的 SECURE**（AST 静态 + subprocess 真跑 + 内存注入实验 + mock 对抗，均主审亲自执行、可复现），非空转 0 发现。R6 的 `NEEDS_HARDENING` 关切已全部消解。

---

## 下游建议

### 建议召唤
- **无需再走烛 R8**——4 环加固已机械验回，结构在 R6+R7 双轮 AST/动态证据下稳定。若主驾采纳建议A（补 json_valid 元验收），那是 1 条 test 追加，自验即可，无需再召唤。
- 无外部情报/领域/规格缺口，无需织/匠/策。

### 风险信号
- **"确定性脚本全绿"不等于"永久免疫"**：本轮 SECURE 基于当前 sha256（`16446647…`）的 mirror-gate.py。**任何后续改动 mirror-gate.py 必须先跑绿 contract 21/21 + meta 4/4**（且过 exit code 门），这正是本轮验回的 exit=1 机械扳机的用途——别再凭"我改的是小地方"跳过基线。
- 建议A 的元验收缺口若长期不补，未来若有人误删/改坏 json_valid 逻辑，meta baseline 不会报警（只有 contract 的正向用例会红）——记一笔，非急件。

__VERDICT__: SECURE
__DELTA__: 烛R7(主审确定性脚本验证,未调Codex) | 1 | security | 补强主驾——把 4 环加固从"主驾自评 21/21+4/4+单点"提升到机械证明：注入失败真 exit=1（R6 `baseline_forced_failure` 原始发现验回，test_mirror_gate_contract.py:201 / test_meta_baseline.py:188）+ AST 全模块 stdout.write 恰[373]单点（建议3 改 main 未引第二 write，mirror-gate.py:373）+ 6 畸形返回全 fail-open 不冒泡 + wrap 抛降级 SOUL 不丢；另提建议A（INV4a/b/c 新守卫缺元验收，改进级）
