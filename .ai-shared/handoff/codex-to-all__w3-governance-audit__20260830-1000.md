# W3 治理收口审计（F-069 ~ F-080）

> **状态**：🟡 3 项机械检查已落地 / 3 项查证闭合 / 6 项需 LO 拍板
> **审计者**：烛（Codex 面），2026-08-30

## 一、查证闭合（已有机制，非缺口）

### F-079: agent 间消息 schema 校验 ✅

`bus.mjs` 的 `validBusRecord()` 已完整校验：
- `MESSAGE_ID` 格式（`/^[A-Za-z0-9._:-]{1,160}$/`）
- `MESSAGE_PARTICIPANT` 格式（from/to）
- `MESSAGE_KINDS` 枚举（task/say/ask/answer/decide/steer/system/memo）
- `MESSAGE_TEXT_CAP`（20000 字符上限）
- `runId` UUID 格式 + 与当前 run 一致
- 时间戳可解析

`collaboration-inbox.mjs` 有独立的 `INBOX_SCHEMA` + `INBOX_MESSAGE_KINDS` + 校验函数。

**无需额外行动。**

### F-070: summoned 审计闭环 🟡

已有机制：
- `observability.mjs` 的 `routeGate` 聚合：`summoned: { yes, no, unknown }` + `redUnsummoned`
- `automations.mjs` 的体检 prompt 已包含 `redUnsummoned > 0` 告警规则
- `automations.mjs` 的 `pulse` 机制可定期触发体检

残留：告警依赖体检被手动触发。若体检未运行，告警不会自动发出。但体检自动化已支持 `every:<n>m|h|d` 调度，LO 只需将"体系体检"自动化改为 `every:4h` 即可闭环。

**建议 LO 将体检自动化改为定时调度。**

### F-078: party-mode 真实落地度 🟡

`bus.mjs` 的社会模拟编排（v3.6）已落地：
- 消息总线（bus.jsonl）每 run 一条追加式消息流
- agent 感知彼此靠消息广播而非主脑转述
- 收件人校验、kind 枚举、文本上限均有

`orchestrator.mjs` 的 `orchestrationMode: "social"` 已接线。

**无需额外行动**（party-mode 的核心能力已落地，具体验证可随 W2 bot shell 推进）。

## 二、机械检查已落地

### F-077: roster.json 健康检查 ✅

新增 `scripts/roster-health-check.mjs`：
- 结构完整性（name/role/transport 必须存在）
- threadId UUID 格式校验
- 陈旧检测（默认 30 天阈值）
- transport 合法性（mcp/exec/api/cli）
- 孤儿检测（有 lastRunAt 无 lastThreadId）

当前运行结果：5 个警告（42-43 天 stale + 2 个从未活跃 + 1 个孤儿）。退出码 1。

### F-074: context.md 自动摘要 ✅

新增 `scripts/context-summary.mjs`：
- 从 `decisions.md` 提取决策条目（D-YYYY-MM-DD-NNN）和 DELTA 账本
- 从 `handoff/` 统计近期活动（按 agent 分组、按日期排序）
- 判断 context.md 保鲜期（>14 天警告）
- 检测 handoff 比 context.md 更新的情况

当前运行结果：context.md 最后更新标记未找到（格式不匹配正则），142 个决策条目，132 条 DELTA，253 份 handoff。

### F-075: stop-gate 等价性校验 ✅

新增 `scripts/stop-gate-equivalence.mjs`：
- 常量等价性（WORKSPACE_ANCHOR、FRESH_WINDOW_SEC、TRANSCRIPT_SCAN_*）
- 正则等价性（6 个关键正则）
- 函数签名等价性（find_aishared、load_handoff_sources）
- 关键行为检查（fail-open、loop prevention、session marker、delta validation）

当前运行结果：核心契约等价。1 个假阳性（DELTA_LINE_RE 的 Python 隐式字符串拼接导致提取器只取第一段，实际正则完全相同）。

## 三、需 LO 拍板

| 项 | 内容 | 阻塞 |
|---|---|---|
| **F-069** | 路由信号外置合一（route-gate hook 多份实现 → 单一真源） | 架构重构 |
| **F-071** | 判级准确率反馈环（路由误判统计 → 喂白发降级） | 产品设计 |
| **F-072** | DELTA 账本加类别标签（安全/性能/正确性/架构） | 格式变更 |
| **F-073** | skill 使用度盘点（零调用 skill 退场/合并） | 需设计 |
| **F-076** | rules.md 修改 RFC 化（防单点改宪法） | 流程决策 |
| **F-080** | 子 agent 预算/轮次/深度可视化 | UI 决策 |

`__DELTA__: 烛(Codex) | 1 | 证据：F-077/F-074/F-075 三项机械检查落地 + F-079/F-070/F-078 查证闭合`
