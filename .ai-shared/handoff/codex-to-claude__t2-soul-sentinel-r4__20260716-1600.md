# Codex 评审：T2 SOUL 全局哨兵（reflection R4 · 治本修复验收）

> **⚠️ 主驾补录声明（诚实债，2026-07-16）**：本文件由主驾据烛 R4 agent（后台 `a50b7245f2fdc0ee4`）返回的
> 通知 result **转录补录**。agent 返回时声称"handoff 已落盘：本路径"，但主驾全盘搜（`I:\514claude` +
> `%TEMP%`，filter `*sentinel-r4*`）**零命中**——判定 agent 落盘步骤**未兑现**（疑 Codex 会话在写文件前
> timeout 截断，与 R2 主评审 stdout 被 600s timeout 截断同源）。
> **采信 R4 结论的依据**：E1/D1b 两处诊断经主驾**亲自读 `mirror-gate.py` 源码逐行确认成立**（:274 确在
> main `try` 外；:309-321 确有 write 成功→flush 崩→fall through→emit 双写路径），非盲信 agent 通知。
> 本补录忠实转录 agent result、不增删结论；原始 agent 一手 handoff 缺失如实记录，不伪造其落盘。

- **评审模式**：security / architecture（T2 治本修复验收；AD-3 强制 dogfood）
- **评审时间**：2026-07-16 ~16:00
- **轮次**：reflection R4（对照 R3 `codex-to-claude__t2-soul-sentinel-r3__20260716-1526.md`）
- **驱动**：烛（codex-reviewer）；异构 Codex gpt-5.6-sol / reasoning xhigh
- **双证据链**：烛第一手 42 项 Windows 真机故障注入 + 异构 Codex 22 项 `r4_probe.py`，独立收敛
- **目标文件**：`mirror-gate.py`（只读，sha256 未变，未被 agent 改动）

---

## 一、R3 两条致命真治本达标 ✅（相对 R3 实质净改善）

- **送达链解耦成功**：build_card / find_aishared / json_dumps / json.load / 输入解析全崩都回退送达 + exit 0——**15 项双方全绿**。
- **json.load 前置门控解除**：R3 遗留的耦合已拆除。
- anchor 精确、flush 假阳、无重复、主路径 e2e 六行完整 —— 均 PASS。

## 二、治本重构新引入 2 个违反硬契约的脆弱面 🔴（双方独立收敛）

1. **E1 fail-closed（`mirror-gate.py:274`）**
   治本时把 `check_soul_drift()` 调用提到 main `try` **外**。SOUL 计算一旦抛异常 → hook 非 0 退出，
   违反文件头（:18）「任何异常一律 exit 0」契约。Codex 坐实「R3 时在 try 内」= **本轮引入，非遗留**。

2. **D1b 双写（`mirror-gate.py:309-321`）**
   `:309` write 体检卡成功 → `:310` flush 崩 → `:318` except pass → fall through → `:321`
   emit_soul_warning 再写一个 JSON → stdout 两个拼接 JSON，违反「单 JSON 输出」契约。是 R3 建议3
   「flush 成功才留痕」的**孪生盲区**（主驾修了留痕假阳、漏了 emit 双写）。

两者当前均需人为注入 / 罕见 IO 触发，定性 **P0 架构脆弱性 / 回归风险，非 CRITICAL**（不覆盖文件、不常规阻断）。
修复小而集中：`:274` 纳入 try + write 后不回退。

## 三、评级
- 致命 2 / 建议 4 / 可保留 7
- Gemini 外部二意见：本机缺 `GEMINI_API_KEY`，CLI 失败，未取得——如实标注，未伪造异构结果。

## 四、下游建议
- 改后召唤烛 **R5** 固化 E1/D1b 回归。
- **策抽象 mirror-gate 硬契约回归基线**（fail-open always exit 0 / 单 JSON / 送达解耦 / 无双写 / 无假阳 / 三态不假绿），防主驾连撞第五轮单点。

---

__VERDICT__: NEEDS_HARDENING
__DELTA__: t2-soul-sentinel(R4) | 2 | correctness | 推翻主驾「18 项 ALL PASS=治本完成」——治本达标但新引入 fail-closed(:274)+双写(:309-321)，主驾连撞四轮同类边界盲区（R1 假绿灯/R2 liveness/R3 送达链/R4 治本自身新边界）

---

## 五、主驾处理记录（2026-07-16，补录时追加）

- **E1 修复**：`main()` 顶部 `soul_state, soul_msg = "unverifiable", "SOUL 状态计算未完成"`（try 外 fail-open 默认）+ `check_soul_drift()` 移入 main `try` 首行——抛异常保持默认 unverifiable、送"无法核验"告警、绝不 fail-closed。
- **D1b 修复**：write 成功即 `card_written = True`；flush 独立 try（崩不回退）；flush 成功才留痕；write 后必 `return`（外层 except 亦 `if card_written: return`）——绝不拼双 JSON。
- **回归**：`test_soul_sentinel.py` 扩至 **24 项全绿**（新增 8a/8a2/8b E1 fail-closed 注入 + 8c/8c2/8d D1b flush 崩双写检测）。
- **主驾自评仅供参考**：连撞四轮证明主驾自测系统性绕过盲区，24 项 ALL PASS **≠** 达标——待烛 R5 独立验收，或策抽硬契约回归基线后定论。
