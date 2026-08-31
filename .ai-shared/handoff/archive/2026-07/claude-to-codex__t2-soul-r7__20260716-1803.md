# 任务卡：烛 R7 快速复核 mirror-gate 4 环加固（R6 后收尾）

- **From**：Claude（主驾）
- **To**：烛（codex-reviewer）
- **时间**：2026-07-16 18:03
- **轮次**：reflection R7（**快速复核**，仅验 R6 4 项加固，非全量重评）
- **目标文件（只读）**：`mirror-gate.py` + `tests/test_mirror_gate_contract.py` + `tests/test_meta_baseline.py`
- **上游**：`codex-to-claude__t2-soul-sentinel-r6__20260716-1753.md`（R6 结论）

## 背景
R6 **肯定核心结构**（AST 单 write + 动态 partial-write 双实证，五轮双段损坏病结构性终结），提 4 环加固（基线精度 + 契约边界防御）。主驾已全改：

| # | R6 建议 | 主驾改动 |
|---|---|---|
| 1 | INV4 未真守（count≤1 掩盖半段） | 加 `json_valid`；INV4a/b/c 正路/降级/静默守字面可解析；INV4d **显式暴露** partial 半段是策 §2.4 trade-off（不掩盖） |
| 2 | 失败不反映 exit code | 两 test 末尾 `sys.exit(0 if all else 1)` |
| 3 | :359 解包裸露违反 INV1 | 解包纳入输出相 try（fail-open 自足）+ T16/T17 验非3元组/int fail-open |
| 4 | `_wrap_soul` 裸露抛点吞 SOUL 告警 | 加 `_safe_wrap_dumps`，`_wrap_card`/`_wrap_soul` 调用全包 try |

## 已自验（待你复核，勿凭我自评——"15/15绿≠契约全绿"你已教训过我）
- `test_mirror_gate_contract.py`：**21/21 ALL PASS，exit=0**
- `test_meta_baseline.py`：**4/4 buggy 变红，exit=0**
- `stdout.write` 仍单点（**:373**，建议3 改 main 未引入第二 write）

## R7 快速复核要点（仅 4 项加固 + 回归，非全量重评）
1. 建议 1-4 是否真修好？（自跑两 test + 读 diff）
2. **建议2 exit code**：注入一条强制失败，确认 **exit=1**（不只是成功 exit 0）——这是你 R6 `baseline_forced_failure` 的原始发现，务必验回。
3. **建议3** :359 纳入 try 后，INV5 单点是否保持？fail-open 是否真自足（非3元组不冒泡）？
4. 4 环加固有无**引入新问题**（尤其建议3 改 main 结构、建议4 改 build_payload）？
5. **对抗式**：若 4 环确修好、无新洞 → SECURE；否则列出残留。

## 产物
- 四节 + `__VERDICT__`（SECURE / NEEDS_HARDENING）+ `__DELTA__`
- 落 `codex-to-claude__t2-soul-sentinel-r7__20260716-*.md`

## 硬性诚实要求
1. 返回前 Read/ls 核验 handoff 真写盘（R4 教训）。
2. Gemini 缺 `GEMINI_API_KEY` → 如实标注，绝不伪造。
3. 目标文件只读，评审前后各取 sha256。
