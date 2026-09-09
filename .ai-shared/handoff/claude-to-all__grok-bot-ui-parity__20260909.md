# Grok Bot 对标 UI 落地：Routines 真实化 / Profile 表单 / 交接板

> 会话环境：WorkBuddy（CodeBuddy 宿主），非 514cc hook 接管会话——本会话无 route-gate 注入 session marker，按规则省略该行。
> 日期：2026-09-09（续 claude-to-all__grok-bot-collab-parity__20260909.md 的语义层，本轮是 UI 消费层）

## Checkpoint

- Goal: LO 给 Grok Bot 实际 UI 截图，要求「继续完善 UI，前端和后端和 Grok Bot 大概一致」。
- Completed: 三个前端模块 + index.html 三处 + app.js 五处挂接 + 新 CSS + QA 脚本（4 截图 8 断言全绿）+ 契约测试演进（假数据契约 → 真实化契约）+ 96/96 回归。
- Next: composer 的 kickoff 发送路径（多 @ 消息 → /api/bots/relay/kickoff）；routine runHistory 从 automation 回调回填；Grok 式「从成功 run 保存为 skill」通道。
- Files: `public/modules/{bot-collab-api,bot-routines-panel,bot-profile-editor,bot-relay-board}.js`；`public/forge/bot-grok-parity.css`；`public/index.html`；`public/app.js`；`scripts/qa-bot-grok-parity.mjs`；`tests/bot-shell-ui.test.mjs`。

## 截图对照结论（Grok Bot 实际 UI vs 514 Bot）

Grok 截图结构 = 左栏（新建/搜索/分组会话列表/底部插件+账号+设置）+ 顶栏（会话名 + 电脑图标 + 窗口控制）+ 中栏消息流 + 底部输入区（附件/输入/发送）。514 Bot Shell（v43）骨架已同构，差距在**右栏数据是假的**：

| 面 | 改前 | 改后 |
|---|---|---|
| 右栏 Routines | 硬编码假数据（"每周工作台巡检"/"收件箱摘要"，toggle 是死按钮） | 接 /api/bots/routines 真数据：行 = 标题 + 人话节奏（周一/周三/周五 08:00）+ 期望产出 + 桥接态（已接/未接调度）；toggle = enable/pause（automation 桥接，失败如实报错）；test = plan-only 预览；delete = 联动删 automation |
| 新建例行 | 无 | 六要素 dialog（Grok "Confirm:" 清单表单化）：归属成员/名称/指令/节奏（预设人话选项）/输入源/期望产出/审批边界/缺数据策略 |
| 成员设置 | 只有 Identity/席位/提示词 | 新增「协作职责（Grok 式 Bot 定义）」区：@别名/Owns/目标/持久规则/需审批/禁止/技能/例行配额——随成员保存一并 PUT /api/bots/<id>；全空保存 = 移除定义（草稿态） |
| 交接可见性 | 无（bus handoff 只在后端） | 群会话「任务」tab 新增「成员间交接」区：待确认/已确认两段，from → to + 阶段徽章 + 文本 + 时间；接收方 = 当前成员时出现「确认接手」按钮（POST ack） |

## 实现要点

- `bot-collab-api.js`：/api/bots 客户端封装（404 折叠为 null——未建 profile 是常态草稿态）。
- `bot-routines-panel.js`：`describeSchedule`（every:1d → 每天；at:08:00@1,3,5 → 周一/周三/周五 08:00）；toggle 失败回滚 + toast；dialog 用 `data-routine-field` 收集。
- `bot-profile-editor.js`：load（成员设置打开时）/ save（成员保存成功后，失败不阻断成员主保存——成员是主真源 profile 是叠加层）；`markBotProfileDirty` 挂既有 form input 监听。
- `bot-relay-board.js`：openHandoffs/acknowledgedHandoffs 两段渲染；ack 按钮条件 `item.to === currentMemberId`。
- 旧 `case "routine-toggle"`（死代码，对应假按钮）已删；`data-bot-action="routines"`（查看全部）保留。
- CSS 全走既有令牌（--bot-*/--text-*），零裸 hex 零裸时长。

## 验证

- `node scripts/qa-bot-grok-parity.mjs`：隔离内核 + fixture + Chromium。**8/8 断言 + 4 截图**（`.qa-output/bot-grok-parity/`）：①Routines 真数据（假数据文案不存在）②profile 表单水合 + UI 回写 API 读回 ③交接板两条待确认 ④ack 后已确认区 + 「确认接手」按钮按接收方条件出现。
- `node scripts/run-tests.mjs tests/{bot-shell-ui,collaboration-process,collab-turn-visibility,bots-*}.test.mjs`：**96/96**。
- 契约演进：`bot-shell-ui.test.mjs` 原「routine-toggle 假数据 fail-closed」契约 → 三个新契约（Routines 真接线 / profile 区存在且挂接 / relay mount 存在且挂接）。
- ui-lint：新文件零 bare-hex 零 bare-duration；inner-html 新增与项目 389 处基线同手法（动态列表渲染，全 escapeHtml）；bare-hex 3/bare-duration 3 的新增经 git diff 定位为工作区既有在途改动（非本轮引入）。
- 修过的 QA 途中真发现：长 memberId（自动 UUID 风格）推导默认 handle 超 32 字符上限 → upsert 必须显式给 handle（fail-closed 正常，QA 已按此操作并在协议语义内）。

## 诚实边界

- **未做** composer kickoff 发送路径（多 @ 消息自动转 /api/bots/relay/kickoff）——发送主链风险高，本轮交接板 + API 已可手动用，composer 集成列为下一步独立切片。
- routine 的 runHistory 回填（automation 触发回调 → appendRunHistory）未接线——数据结构就绪，接线点待 automation 事件挂钩。
- QA 为隔离内核 fixture（非正式实例）；真实 provider 执行 routine 未验证（enable 桥接的 automation 创建/update/delete 已验证，触发执行未触发）。
- 截图验收为 1440×900 单视口；移动视口（390px）未走查——bot 面既有响应式由 v43 覆盖，新增 dialog/交接板用了流式布局但未实测小屏。

__DELTA__: 主驾自评 | 1 | 证据：QA 首轮暴露长 memberId 默认 handle 推导失败（profiles.mjs fail-closed 按设计工作，QA 脚本修正显式传 handle）；保存成员后界面自动切 contacts tab 导致群会话不可见（既有 botSaveAgentSettings 行为，QA 路径先切回 chats tab）。
