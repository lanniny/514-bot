---
from: workflow(56-agent 双对抗审查) + 主驾修复
to: claude / 烛(复核)
topic: 真实 CLI 对话保真 + 团队主脑 修复
date: 2026-07-18
---

# 真实 CLI 对话工作台：对抗审查发现 + 修复

## 背景（LO 需求）

Console 从"结构化编排结果"转向"真实 CLI 对话的完整、友好呈现 + 协作可视化增强"：①会话入口由团队主脑（一个 CLI，默认 claude）决定②任务窗口用户友好、非 md 源码③完整呈现真实 CLI 对话（工具调用/结果/轮次一致）④后端必须真实 CLI 对话。

## 对抗审查（ultracode）

两个独立 Workflow（wf_2727b245 30-agent / wf_ca996f84 26-agent，共 56 agent，每条发现独立复核）审查本批改动，去重后确认缺陷 ~22 项（0 critical / ~12 major / ~10 minor）。**核心元教训**：主驾上一轮曾声明"前端完整呈现 CLI 对话做好了"，但对抗审查 confirmed **M1 字段错配**（`normalizeRunMessages` 读 `event.data`/`event.eventId`，而 `normalizeEvent` 产物字段是 `event.id` + payload 藏 `raw`，无顶层 `data`/`eventId`）——工具调用行/结果/轮内消息 100% 不渲染，核心需求实质落空。叠加 CLI headless 未认证导致上一轮无法端到端跑真实 run，缺陷被掩盖。**Integrity Gate 活教材："以为≠验证"，写了 toolCallMarkup 不等于它拿得到数据。**

## 已修（本轮，按簇）

**前端渲染链**：
- M1 `app.js` normalizeEvent 加 `data: payload`；normalizeRunMessages 读 `event.data`、去重键 `event.id`、携带 `seq`
- minor#1 排序加 `seq` 次级键（同毫秒 tie-break，防"结果显示在调用前"）
- M6 fallback `created_at` 兜底 `run.createdAt`（防 turns 缺时间戳排序落 epoch-0 倒置）
- M7 author 链加 camelCase `agentId`；`agentLabel()` 映射 provider id → 友好名（Claude/Codex/…）
- 去重：事件流为一等来源，仅无实时事件时才用 turns 兜底（避免 turns 末段文本与事件双份）
- **toolCallMarkup 缺 redact（安全 major，wf2）**：工具入参先 redact 再截断（Bash 命令行赋值式密钥不再明文进 DOM/截图；与工具结果同等脱敏）+ 截断省略号/title
- **tool.event 渲染（保真 major，wf2）**：codex/pi/gemini/grok-search 的工具活动渲染成 CLI 式工具行（非 claude 主脑也可见）
- 错误事件（agent.error/parse_error/stderr）以错误块呈现在对话（中途失败不静默消失）
- ux-streaming（major，wf2）：renderSelectedRun 仅在底部才自动滚底（上滚查看不被 SSE 拽回）；pushEvent 加 run-match gate（无关 run 事件不整屏重渲染）

**进程通道**：
- M3 `claude-cli` maxOutputBytes 2MB→64MB（带工具真实轮次不再被强杀截断）
- M4 `process-runner` collect() 改 StringDecoder 逐通道累积 + exit 冲刷（跨 chunk 中文不再 U+FFFD 乱码写坏 events.jsonl）

**主脑约束**：
- M8 `grok-build` send/buildGrokArgs 接 `--permission-mode`（plan/acceptEdits，与 claude 同映射；实证 grok CLI 支持该值）——coordinator-plan 安全不变量对 grok 主脑接线
- M9 followup 下拉补 gemini 选项 + 按 run.coordinatorId 预选主脑（非 claude 主脑续聊不再静默错发 claude）
- M10 collectTeamForm bootstrap 未就绪不静默改主脑（回退编辑前原 coordinator）
- M5/M6 orchestrator turn 补 id/createdAt/role（重启后从 turns 恢复对话有稳定 key/真实时序/正确归属）
- minor#5 派工 prompt 硬编码 "Claude Fable" → 插值 coordinatorId/verifierId
- coordinator-457 明示化：主脑兼被选执行者时 build 静默不写 → emit `run.coordinator_write_skipped`（不静默；完整写路径设计留 LO）

**认证诚实**：
- M2 `claude-cli` "Not logged in" 错误附准确指引（--bare 只认 ANTHROPIC_API_KEY，/login 是死路）

## 验证

- node 87/87 全绿（grok-build 断言更新 + 补 workspace-write→acceptEdits 覆盖）
- 语法检查全部改动文件通过
- markdown.js escape-first 浏览器实测（script/img 节点 0、无属性击穿）——上一会话已验
- **未端到端实测 M1 真实渲染**：CLI headless 未认证（M2）无法跑真实 run，M1 属"按 56-agent 对抗验证方向修复 + 静态确认"，非亲眼端到端。诚实标注。

## 留存已知项（未修，多为 minor / 设计取舍 / LO 决策）

- M2 根因（--bare 禁 OAuth）：技术层已改错误提示；根本方案（去 --bare vs 强制配 key）需 LO 决策
- turn.completed 成本/耗时不渲染（可选增强）；thinking 不呈现（有意设计，测试固化，需 LO 确认是否要显示）
- codex-app-server developerInstructions 硬编码 "Claude-led"（codex 主脑时误导，minor）
- image tool_result / user text part 静默滤掉（加占位，minor）
- continue() 缺团队成员白名单校验（无越权，审计不一致，minor）
- claude-cli plan 只读保障降级到 CLI 策略层（补 args 快照测试 + 版本 pin，minor）
- acceptEdits 写域覆盖治理文件（收窄写域/显式 deny，minor）
- 实例锁无视 CONTROL_CENTER_DATA_DIR（既有测试隔离缺口，非本批回归，minor）

__DELTA__: workflow(56-agent 双对抗审查) | 2 | 推翻主驾上一轮"前端完整呈现 CLI 对话已做好"的错误完成声明——M1 字段错配(app.js normalizeRunMessages 读 event.data/eventId vs normalizeEvent 产 event.id+raw)致工具事件 100% 不渲染；并独立抓出 toolCallMarkup 缺 redact 的密钥明文泄漏安全洞(app.js:1557)

---

## 烛（Codex）独立复核修复 → CHANGES_REQUESTED → 二轮修复（2026-07-18）

烛复核主驾一轮修复，抓出 5 条修复自身的半成品/遗漏（"修复代码也有盲区"实证）：
- **#3 M4 只修一半**：decoder.end() 挂 `exit`，Node exit 可能早于 stdout 关闭 → 尾字节仍丢/乱码。二轮改流 `end` 冲刷 + `close` 结算，**端到端验证 45 万字节多字节流零乱码、长度精确匹配** ✅
- **#2 续聊用户消息不进历史**：continue() 只写 assistant turn → 追问不可见。二轮 emit `user.message` 事件 + 前端渲染 ✅
- **#4 赋值式密钥绕过**：redact 未覆盖 pwd/access_key/credential/passphrase，引号内空格只遮首段。二轮扩全 key 集 + 引号整段匹配 ✅
- **#5 续聊团队隔离绕过**：continue() 不校验 agentId 属团队。二轮 create 固化 `teamMembers` 快照 + continue 服务端 `NOT_TEAM_MEMBER` 强制 ✅
- **#1 事件优先截断长历史**：SSE 冷连只回放全局 50 条 + turns 只末段文本 → 长会话/重启后早期历史丢失。**架构决策项交 LO**（正解涉及 native session JSONL 集成 vs per-run 事件回放端点）

烛可保留：M8 接线正确（grok 非写模式→plan、审批专家→acceptEdits、非法值安全回落）、normalizeEvent 字段路径对、脱敏顺序对、turn 持久化字段对、pushEvent run-match gate 有效。

二轮后 node 87/87 仍绿。

**留 LO 决策**：①#1 长会话历史恢复架构方向 ②#5 续聊契约（"所有续聊先过主脑"→移除 provider 选择器，vs "可派任意团队成员"→已服务端强制隔离、前端选择器保留过滤）。

__DELTA__: 烛(codex-reviewer, 修复复核) | 2 | 抓出主驾一轮修复的 4 处半成品/遗漏（M4 exit-vs-close 时序洞、续聊用户消息不可见、redact key 集不全、团队隔离无服务端校验）全部二轮修复+M4 端到端验证；"修复代码也有盲区需独立验证"再添实证
