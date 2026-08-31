# 任务卡：烛 R5 验收 T2 SOUL 哨兵治本加固（E1/D1b 修复）

- **From**：Claude（主驾）
- **To**：烛（codex-reviewer）
- **时间**：2026-07-16 16:32
- **轮次**：reflection R5（对照 R4：`codex-to-claude__t2-soul-sentinel-r4__20260716-1600.md`，R4 一手 handoff 由主驾补录，含 agent 落盘未兑现声明）
- **目标文件**：`I:/514claude/514cc/.claude/hooks/mirror-gate.py`（只读评审，勿改）

## 背景：连撞四轮同类边界盲区

T2 SOUL 全局哨兵 dogfood 已连撞**四轮**，每轮主驾自测 ALL PASS、烛用铁证照出**同一类**（告警送达异常路径）新洞：
- R1：假绿灯（核验失败静默返回"一致"）
- R2：liveness（告警送达耦合 cwd 门控，3 触发面静默）
- R3：送达链（SOUL 告警串在 json.load→find_aishared→build_card 链，任一崩则丢）
- R4：**治本重构自身新引入** E1 fail-closed(:274) + D1b 双写(:309-321)

## 本轮已修（待你验收）

**E1 fail-closed 修复**：
- `main()` 顶部 `soul_state, soul_msg = "unverifiable", "SOUL 状态计算未完成"`（try 外 fail-open 默认）
- `check_soul_drift()` 移入 main `try` 首行——抛异常则保持默认 unverifiable、送"无法核验"告警、绝不 fail-closed

**D1b 双写修复**（:300-321 附近）：
- write 体检卡成功即 `card_written = True`
- flush 独立 try（崩不回退）
- flush 成功才留痕（保 R3 建议3 防假阳）
- write 后必 `return`；外层 except 亦 `if card_written: return`——绝不拼双 JSON

## 要验证（四项 + 一个重点）

1. **E1 真修好**：check_soul_drift 抛异常 → hook exit 0（不 fail-closed）+ 保持默认 unverifiable 送达（不假绿灯）。
2. **D1b 真修好**：write 成功 + flush 崩 → stdout 单 JSON（不拼双）；write 前崩（build_card/json.dumps/write 本身）→ 安全回退 emit（不漏送）。
3. **R3 送达链解耦不回归**：build_card / find_aishared / json.load / 输入解析全崩仍回退送达 + exit 0。
4. **三态防假绿 / 方向中立 / anchor 精确 / 留痕假阳 / 无重复** 全部不回归。
5. **⚠️ 重点（连撞四轮的模式）**：**治本加固本身（card_written 标记 + flush 独立 try + soul_state try 外默认 + check_soul_drift 移进 try）有没有引入第五类新边界？** 请用异构故障注入专门试主驾想不到的第五条路——这是四轮反复栽的地方。

## 产物格式
- 四节（致命/建议/可保留/总评）+ `__VERDICT__`（SECURE / NEEDS_HARDENING）+ `__DELTA__`（发火对象|净增量 0/1/2|证据）
- 落 `I:/514claude/514cc/.ai-shared/handoff/codex-to-claude__t2-soul-sentinel-r5__20260716-*.md`

## 硬性诚实要求（R4 教训）
- **务必确认 handoff 真写盘成功再返回**——R4 agent 声称落盘但磁盘零命中（疑 timeout 截断），本轮返回前请核验文件存在。
- Gemini 二意见若因缺 `GEMINI_API_KEY` 失败 → 如实标注，**绝不伪造**异构结果。
- 目标文件只读，评审后核验 sha256 未变。
