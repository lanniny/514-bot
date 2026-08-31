# handoff：信息架构重构——会话=团队房间 + 成员独立页 + 浏览器式 tab

- 时间：2026-07-20
- 范围：`apps/control-center`（public/app.js、public/index.html、public/styles.css）
- 触发：LO「多会话浏览器式 tab 页签需要 + 我的逻辑：项目→会话统一含全团队→点会话选 agent 独立页，结合 tab 实时看每个 agent、单独问某个 agent」

## 架构判断

LO 定的 IA：**项目 → 会话（团队房间，统一含全成员）→ agent 独立页（每成员一个）**。后端能力（bus.jsonl 全员消息、continue(agentId) 直达轮）早已就绪——本轮是纯前端架构层改造，零服务端改动。

## 交付

1. **浏览器式 tab 页签**：会话行点击开「全员」页；成员条/拓扑参与者点击开成员独立页；上圆角页签+活跃页连通内容面；sessionStorage 持久化（刷新恢复，死 run 页签如实丢弃）；非活跃页新消息落脏标。
2. **成员独立页**：事件级过滤（该成员轮次/发言/路由 + LO 的话 + 无归属 run 级治理）——独立页不冒充全员视角；标题/meta/空态三处语义对齐。
3. **单独问 agent**：独立页 composer 锁定发送目标（直达轮不经团队路由），placeholder 明示。
4. **成员条**：◈全员 + 各成员 chip（agent 配色槽一致）；拓扑参与者卡同步可点。
5. **清除清账**（LO 拍板「只清 runs」）：9 条存量 run 归零（5 终态 + 4 重启遗留 waiting_agent 先 cancel 再清）；357 条 CLI 磁盘历史未动。

## 验证

- Playwright 交互实锤：2 会话→2 tab→成员 chip→第 3 tab 独立页（标题/独立页 meta/发送目标锁定/placeholder 全断言）→刷新恢复 3 tab→0 JS 错误。
- 156/156 测试绿；qa:ui --suite=all ok:true。

__DELTA__: 主驾(Kimi) | 1 | 证据：「会话清除」范围有多种解读（runs/隔离 trash/隐藏），357 条 CLI 真实磁盘历史若按字面全清会伤 LO 原生 CLI resume——先问后动，LO 拍板只清 runs：补强「破坏性操作先确认范围再执行」
