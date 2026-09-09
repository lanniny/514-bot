# Grok Bot P0 收尾四刀完成（W1-W4）+ QA ⑦ 修复

- 日期：2026-09-09
- 作者：烛（Claude，主驾）
- 状态：完成，QA 9/9 全绿 + 回归 154/154 全绿
- source_proposal: `proposals/v49-grok-bot-parity-gap-analysis.md`
- source_decision: v49 差距分析（五维评估：对话理解 80% / 回复风格 95% / 功能丰富度 75% / 交互体验 85% / 响应质量 90%）

## 交付内容（P0 四刀）

### W1 私有技能真实化（Grok: Private skills）

- 后端：`src/bots/private-skills.mjs` 新建 `BotPrivateSkillStore`——完全对齐 profiles.mjs 治理模式（fail-closed、serializeMutation 串行链、tmp+renameWithRetry 原子写盘、fsync、`findSecretCandidates` 拒密钥）。限额：50 条技能、512KB store、name 80 / description 200 / instructions 4000 字符。
- 路由：`src/bots/routes.mjs` 注册 `GET/POST /api/bots/private-skills`、`PUT/DELETE /api/bots/private-skills/<id>`。**注意：必须注册在 profileSingleHandler 之前**（router 按注册序前缀匹配，否则 `/api/bots/private-skills/<id>` 会被 `/api/bots/<memberId>` 泛型吞掉）。NOT_FOUND_CODES 增 `PRIVATE_SKILL_NOT_FOUND`。
- 前端：`public/app.js` 假数据清零，`botLoadPrivateSkills` / `botRenderPrivateSkills` / `botSavePrivateSkill`（POST/PUT 真源）+ 按 `data-private-skill-id` 精确定位编辑/删除（删除走 confirmAction + API DELETE）。index.html 私有技能区改动态容器 `#bot-private-skill-list`。

### W2 composer 多 @ 群聊消息 → kickoff 派发（Grok 群聊语义）

- `botKickoffMentionTargets(conversation, text)`：识别 workspace_group 文本里 ≥2 个不同成员的 @ 提及（@memberId 与 @显示名双键 tokenMap，`botMeta(id).label` 来自目录真源），去重。
- `botMaybeKickoffRelay(conversation, prompt, run)`：归一 @显示名 → @memberId（relay `resolveHandle` 支持 memberId 直达）后 `postRelayKickoff({ runId: run.id, from: "lo", text })`；失败 toast 警告不回滚已发消息。挂接点：`botSubmitComposer` 的 `conversationCommands.submit` 成功后。
- 语义：`@A 做 X；@B 做 Y` → 每个被点名成员一条 bus task 交接（handoffId + 单 owner 守卫在后端 relay.mjs kickoff）。

### W3 routine runHistory 事件回填

- `src/bots/routes.mjs` initServices 订阅 eventStore 的 `automation.triggered` 事件：匹配 `routine.automationRef === event.data.id` 则 `appendRunHistory(routine.id, {...})`。订阅回调全 try/catch + fire-and-forget（事件订阅自封原则——抛错 subscriber 会被 event-store 摘除）。
- 前端 `public/modules/bot-routines-panel.js`：`routineHistoryMarkup(routine)` 渲染最近 3 条运行历史（状态徽章 + 时间）。

### W4 Channels 真源渲染

- `botLoadPanelChannels()` 读 `/api/channels` 渲染 `.bot-channel-mini` 行；REMOTE_GATE_BLOCKED → 放行引导；空 → 引导式空态（「连接」入口）；失败 → 如实失败态。绝不停在「正在读取」。

### 附带：空状态个性化（成熟产品实践）

- 单聊空态：`{label} · {role}——直接说需求，或粘贴上下文让它接着做`；群聊：`{n} 位成员在此协作——点名 @成员 或直接下达任务`。参考 Grok/ChatGPT 的引导式空态（告诉用户能干什么、从哪开始）而非死文本。

## QA ⑦ 修复（kickoff 断言失败的根因与修法）

**根因**：QA ④ 的 execute:true run 在隔离内核（无真实 CLI）下 turn 失败进入 `recovery_required`（**非终态**）。⑦ 在同一群聊提交新消息时，`orchestrator.conversationMessage` 走 `continue(activeRunId)` 分支（orchestrator.mjs:2251——非终态即 continue），被恢复锁 409 拒绝 → `acceptedRun` 拿不到 → kickoff 从未触发。诊断证据：POST messages 409 + activeRunId 全程停在旧 run + kickoff requests 为空。

**修法**：QA ⑦ 改在全新群会话（Kickoff 派发房）上做多 @ 提交——干净会话无 activeRun，submit 直接创建新 run，kickoff 落在新 run 交接板上。这等价于真实用户路径「新群聊直接派工」。QA 保留请求级诊断钩子（kickoff requests/responses、messagePosts 状态、activeRunId 轨迹、console 错误），失败时随断言吐出。

**既有产品行为确认**（非 bug）：群聊有 recovery_required run 时新消息 409 是设计行为——UI 有恢复条（`state.recoveryAckRunId` → acknowledgeRecovery 一次性确认）路径，用户确认后 continue 成功。QA 不覆盖该路径（留给后续 B-01 族收尾）。

## 验证

- QA：`node scripts/qa-bot-grok-parity.mjs` 9/9 全绿，9 张截图（`.qa-output/bot-grok-parity/`）：① routines 面板真实数据 ② profile 表单 ③④ 交接板+ack ⑤ 列表预览+日期徽章 ⑥⑦ 加载错误卡+重试恢复 ⑧ 私有技能 CRUD ⑨ kickoff 交接板。
- 回归：`node scripts/run-tests.mjs`（16 文件 bot/conversation 全集）154/154 通过，clean-exit ok。
- 新测试：`tests/bots-routes.test.mjs` +4（私有技能 CRUD 落盘回读 / fail-closed / 与 profile 路由不互吞 / automation.triggered 事件回填 runHistory）；`tests/bot-shell-ui.test.mjs` 契约演进（旧占位文案契约改 doesNotMatch + 新真源契约）。

## 注意事项与坑

- **private-skills 路由注册顺序**：精确子路径在前、泛型 `/api/bots/<memberId>` 在最后——新面路由必须遵守（Wave G 面模式纪律）。
- **freshSurface 解构**：`tests/bots-routes.test.mjs` 的 freshSurface 返回 `{ call, automations, ctx }`，dataRoot 从 `ctx.state.dataRoot` 取。
- **QA/测试里的 recovery_required run**：隔离内核下 execute:true 的 run 会进恢复锁；想在同一会话继续发消息，要么新会话，要么走 acknowledgeRecovery 路径。
- playwright chromium 启动会探测 reg.exe（被沙箱 blacklist 拦）——无害，不影响测试结果。

## 后续（v49 P1，未开始）

- W5：真实 provider 端到端三连测（真实 CLI 下的完整协作链）。
- W6：390px 小屏走查。
- W7：群聊成员级打字指示。
- 用户四维度中未覆盖：产品个性语气/人格设定层（提示词层改动）；流式响应已有但本轮未强化。
- recovery_required 恢复条 UI 路径的 QA 覆盖（归入 B-01 族收尾）。
