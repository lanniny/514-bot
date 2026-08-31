# 任务卡：烛 R6 验收 mirror-gate 契约驱动重构（终结五轮循环）

- **From**：Claude（主驾）
- **To**：烛（codex-reviewer）
- **时间**：2026-07-16 17:26
- **轮次**：reflection R6（对照 R5 partial-write + 策 mirror-gate-hard-contract 规格）
- **目标文件（只读）**：`I:/514claude/514cc/.claude/hooks/mirror-gate.py`
- **回归基线（只读）**：`I:/514claude/514cc/.claude/hooks/tests/test_mirror_gate_contract.py` + `test_meta_baseline.py`
- **上游规格**：`spec-architect-to-claude__mirror-gate-hard-contract__20260716-1707.md`

## 背景：从五轮单点补丁升级到契约驱动

mirror-gate SOUL 送达连撞五轮（R1 假绿 / R2 liveness / R3 送达链 / R4 双写 / R5 partial-write），每轮补丁引入同类新洞。策抽了硬契约规格（9 条 INV + 单一输出点重设计 + 回归基线 + buggy 必变红元验收）。主驾按规格重构：

- **结构**：main 劈成**构造相**（`build_payload` 纯计算，绝不碰 stdout）+ **输出相**（单点 write）。删 `emit_soul_warning` + `card_written` + 所有回退再写。INV9 构造/输出分离 ⇒ INV4∧INV5。
- **静态单点**：承载 payload 的 `stdout.write` 恰 1 处（:363），物理上无第二 write。
- **回归基线**：15 用例全绿（T1-T15，`test_mirror_gate_contract.py`）。
- **元验收**：4 个 buggy 版本（R5/R3/R2/R1）对应用例全部变红（`test_meta_baseline.py`），证明基线非假绿灯。

## R6 验收要点（策 §5 口径 + 你的对抗式）

1. **复核基线全绿 + 元验收 buggy 变红**（自跑两个 test 文件，贴运行输出，不凭记忆）。
2. **核心（连撞五轮的关键）**：用异构故障注入找**有没有哪条 INV 的异常路径没被 15 用例覆盖**——即"第六类边界"。重点方向：
   - 构造相 `build_payload` 有没有可能漏网异常传到输出相之前？（main 顶层 `except Exception` 兜底是否真兜住所有非 SystemExit）
   - 输出相单点 write 之后，flush / 留痕路径有没有可能触发**第二次 stdout 写入**？（INV5 结构是否真无第二 write）
   - INV1-9 有没有哪条谓词在某输入下不成立？（尤其 `_parse_cwd`/`safe_dumps`/`safe_build_card` 的边界）
   - `sys.stdin.read()` 崩、stdin 超大、payload 为超长字符串等 I/O 边界。
3. **对抗式兜底（铁律7）**：0 发现 = 可疑，HALT 重审。连撞五轮，若你确认这次结构真的封死了这类边界，请给出**"为什么结构上不可能再有第六类"的正面论证**（而非"我没找到"）。

## 产物格式
- 四节（致命/建议/可保留/总评）+ `__VERDICT__`（SECURE / NEEDS_HARDENING）+ `__DELTA__`（发火对象|净增量 0/1/2|证据）
- 落 `I:/514claude/514cc/.ai-shared/handoff/codex-to-claude__t2-soul-sentinel-r6__20260716-*.md`

## 硬性诚实要求（R4 教训）
1. 返回前用 Read/ls 核验 handoff 真写盘成功。
2. Gemini 缺 `GEMINI_API_KEY` 失败 → 如实标注，绝不伪造异构结果。
3. 目标文件只读，评审前后各取一次 sha256 确认未改。
4. Codex CLI timeout → `codex exec resume -o` 补完，别重跑别伪造。
