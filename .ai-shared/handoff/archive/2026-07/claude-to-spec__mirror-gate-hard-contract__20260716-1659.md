# 任务卡：策抽 mirror-gate 硬契约回归基线（连撞五轮后的系统治理）

- **From**：Claude（主驾）
- **To**：策（spec-architect）
- **时间**：2026-07-16 16:59
- **目标文件**：`I:/514claude/514cc/.claude/hooks/mirror-gate.py`（读现状，**不改**——重设计供主驾实现）

## 背景：单点补丁模式已失败五次

mirror-gate.py 的 SOUL 全局哨兵（`main()` 送达逻辑）dogfood 连撞**五轮**，主驾每轮自测 ALL PASS、烛每轮照出**同一类**（告警送达异常路径）新洞。补丁式单点修复已证明是错的方法——每次修好 N 引入 N+1：

- **R1**：假绿灯——核验失败静默返回"一致"（三态缺失）
- **R2**：liveness——告警送达耦合 cwd 门控，3 触发面静默
- **R3**：送达链——SOUL 告警串在 json.load→find_aishared→build_card 链，任一崩则丢
- **R4**：治本重构自身新引入 E1 fail-closed(:274) + D1b 双写(:309-321)
- **R5**：D1b 修复不完整——`card_written` 标记在 `write` **之后**置位，无法覆盖 **partial write**（write 部分写出后抛异常 / 短返回）→ 半体检卡 + 完整告警双段损坏

## 你的任务：从补丁升级到契约驱动的系统治理

**不要再修单个 bug。** 请把 mirror-gate `main()` 送达逻辑的**所有不变量**抽成硬契约 + 机械回归基线，让未来任何改动都被基线机械守住，终结"主驾凭直觉改→烛照一轮"的五轮循环。

### 1. 提炼不变量清单（硬契约）
从 R1-R5 五类边界 + SessionStart hook 契约提炼，至少含（你补充遗漏的）：
- **INV1 fail-open**：任何异常 exit 0，绝不阻断会话
- **INV2 不假绿灯**：核验失败绝不渲染"一致"（三态 consistent/drift/unverifiable）
- **INV3 送达解耦**：SOUL 非 consistent 告警独立于 cwd/aishared/体检卡链，任一环崩都送达
- **INV4 单 JSON**：stdout 绝不出现两段拼接 JSON
- **INV5 无 partial-write 损坏**：write 一旦可能部分写出，绝不再追加第二段输出
- **INV6 留痕不假阳**：只有确认送达成功才留痕
- **INV7 anchor 精确**：不误注入跨项目

### 2. 送达结构重设计方向（核心）
当前"write→置标记→可能回退"结构本身易生 partial-write 洞。**根因是有两个输出点**（体检卡 write @ :309 + emit_soul_warning write @ :283），双写/partial-write 都源于"一个失败回退到另一个"。

**主驾建议的方向（请你深化或推翻）**：改成**单一输出点**——
- 在任何 write 之前，先**二选一决定**输出什么（完整体检卡串 OR 纯 SOUL 告警串），一次性构造好那**唯一一段** JSON；
- 然后**单点 write**，write 之前就锁定"这是唯一输出、绝不回退"；
- 无第二个 write 调用 = 结构上消除双写 = 消除 partial-write 双段损坏。

请给**设计原则 + 伪代码骨架**（不写最终实现，主驾实现）。若你认为单一输出点方向有更优解或隐患，请直说。

### 3. 回归基线测试套件设计
把每条 INV 映射到可执行故障注入用例（**含 partial-write**：mock write 写一半抛异常 / 短返回；mock flush 崩；build_card 崩；check_soul_drift 崩；畸形 stdin；非字符串 cwd；backup 子串路径）。这是机械守边界的核心资产，未来改 mirror-gate 必跑。

## 产物
- 结构化规格落 `I:/514claude/514cc/.ai-shared/handoff/spec-architect-to-claude__mirror-gate-hard-contract__20260716-*.md`
- 含：**不变量清单** + **送达结构重设计**（原则+伪代码骨架）+ **回归基线用例映射**（INV→故障注入）+ **主驾实现任务列表** + **R6 验收口径**
- **不写最终实现代码**（主驾按规格实现），不评审已有产物（用烛），不调外部（用织）

## 诚实要求
- 返回前核验 handoff 真写盘成功。
- 目标文件只读，勿改。
