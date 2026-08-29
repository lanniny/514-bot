<!-- 514cc-session-id: 019ffea1-2d9f-7370-a6f8-1d793d737451 -->
# 协作会话 interaction 拆账与 Grok 图片闭环

## 致命问题

独立 reviewer 最初给出 `CHANGES_REQUESTED` 的四个 P1 已关闭：

1. `interrupt -> cancel -> late settlement` 不再把 `cancelled` 复活；interrupt 捕获 cancel epoch，cancel 清空
   `pendingSteer/pendingInteractionSources` 并释放 interrupt 所有权：`apps/control-center/src/orchestrator.mjs:4439`、`:4516`。
2. 图片续聊不再走 `/sources` + `/messages` 两段事务。前端把本次附件直接放入消息体，提交失败不会把旧图遗留给
   下一条纯文本：`apps/control-center/public/app.js:14611`。
3. pipeline/social 插话结束后恢复旧 interaction 的 step/source ledger；新图只进入新 steer，不污染旧 plan、
   specialist 或 durable work：`apps/control-center/src/orchestrator.mjs:2701`、`:2913`。
4. 并发 direct continuation 使用独立 controller/execution owner；竞争请求不能把首个真实执行写成 failed，也不会
   覆盖关闭等待所有权。回归位于 `apps/control-center/tests/orchestrator.test.mjs`。

额外关闭：回答 pending ask 时，在 durable answer 写 bus 前先规范化本次附件并校验执行所有权；图片不再按
成员或 Adapter 能力标签提前拒载。真实传输失败由被选中的 Adapter 原样回报，bus 中不会留下伪回答。

## 建议改进

- `HealthService`/Control Center 隔离 server 的关闭链仍可能等待 CLI 探针或 adapter 退役超过 QA 外层超时。
  本次没有把 `SIGKILL` 包装成“干净退出”；建议单独追踪 `state.close()` 分步骤耗时和未收敛 child registry。
- `maxStepsPerInteraction` 仍由兼容字段 `maxRounds` 承载部分配置入口。后续 schema 大版本可正式迁移字段名，
  但当前不应为了命名纯度破坏旧 run 恢复。
- 当前真实图片链证据只覆盖 Grok Build 1.0.3 的 PNG；WebP/video 回归证明的是“路由不再提前拒载”，不等于
  provider 已真实识别这些格式。实际通道失败必须如实返回，不能再转换成 capability `NO_ROUTE`。

## 可保留

- 会话可无限继续、插话和回答；每条用户消息创建独立 interaction，单次自主 provider 步数仍默认 `1/6 ... 6/6`。
  `round` 继续单调增长用于审计，UI 分开显示“总轮次”和“本次步骤”：
  `apps/control-center/src/orchestrator.mjs:344`、`apps/control-center/public/app.js:12695`。
- 附件 interaction 隔离：第一条携图后，后续纯文字不会重放；全局 `run.sources` 只承担历史/生命周期台账。
- 首屏 runs 尚未加载时，用户先输入或粘贴会锁定新任务草稿，不再被后台自动选中旧 run 偷换语义或隐藏 chip：
  `apps/control-center/public/app.js:1064`、`apps/control-center/public/modules/clipboard-attachments.js:96`。
- Grok Build 保持 `responses` 后端；未切换 `chat_completions`，也未执行真实付费图片调用。

## 总评

消息、图片、轮次和停止/取消的核心行为已按 LO 要求闭环。浏览器隔离验收连续提交 8 条消息：首条携 1 张 PNG，
后 7 条没有 `sources`，没有 `/sources` 请求；meta 为 `总轮次 8 · 交互 9 · 本次步骤 1/6`；1440px 与
390px 无页面横向溢出。截图：

- `apps/control-center/.tmp/conversation-interaction-browser-qa/desktop.png`
- `apps/control-center/.tmp/conversation-interaction-browser-qa/mobile.png`

定向断言全部为绿；`npm run validate` 通过。边界是 Node/TAP 与隔离 server 关闭链仍不能给出干净 exit 0，
因此运行时交付结论为 `partial`，不是功能失败。现有 Control Center 需要由 LO 明确授权重启后才会加载服务端改动。

__DELTA__: 烛(Codex) | 2 | architecture | 证据：独立 reviewer 推翻了“interaction 拆账已可交付”的先前判断，指出 orchestrator cancel 迟到结算、app.js 两段附件事务、旧拓扑继承新图和并发 continue 所有权四个 P1；当前对应实现与回归均已补齐。

## 运行态激活补验（2026-08-15 07:23）

LO 随后再次复现 `no healthy provider can satisfy multimodal`。现场核对确认：报错来自旧运行实例，而不是
当前仓库路由。默认锁文件指向已不存在的旧 PID，且当时 `51400` 无监听；当前源码已经移除 capability
包络准入/评分，`multimodal` 只作为软偏好路由，硬限制只允许来自带非空 `reason` 的
`constraints.allowedProviders` 特殊规则。

本轮用 LO 提供的真实 PNG（51,112 字节）在隔离实例完成上传、claim、路由预览和 `execute:false` dry-run：
`taskType=multimodal`、`selected/runtime=grok-build`、`fallbackUsed=false`、`executionOwnerId=grok-build`、
`result.type=route-preview`，没有启动或计费 provider。浏览器验收再次确认首条消息只带一张图、后续七条不重放
旧图，1440px/390px 无页面横向溢出。能力路由/成员迁移/治理聚焦组 `45/45 pass`，`npm run validate`
13 项全部 valid；两组 Node 测试都在 TAP 汇总后被既有句柄拖到外层超时，未伪称干净 exit 0。

正式桌面壳已在 2026-08-15 07:23 启动并从
`I:/514claude/514cc/apps/control-center/server.mjs` 拉起当前源码内核；PID 25104/27676，`127.0.0.1:51400`
启动后根页 HTTP `200`，未授权 API 正确返回 `401`。此前“未重启，运行态 partial”的边界由本节覆盖；
仍未执行真实付费 Grok 图片推理，最终业务回答需
LO 在已打开的桌面实例中复测。

__DELTA__: 烛(Codex) | 1 | 证据：真实图片隔离 HTTP 回读与桌面 PID/51400 监听把“源码已修但运行态未激活”的交付缺口补成可复测运行态。

## 默认全能力与特殊路由收口（2026-08-15 07:41）

LO 最终裁决为：删除 Adapter 能力包络，模型、运行席位和成员默认全能力；特殊通道才允许显式硬路由。
当前实现已经把这条原则落实为协议和机械门：

1. `router.mjs` 不读取能力标签、不计算能力得分，也不返回 `capabilityMatch/requiredCapabilities`；普通任务只按
   质量、速度、健康、成本与规则软偏好排序。图片、长上下文和文档分析共享 `general-context` 软偏好规则。
2. 硬限制只来自带非空 `reason` 的 `rule.constraints.allowedProviders`。主候选和独立复核候选都受同一约束，
   运行图还会拒绝空原因、空名单和未知席位：`apps/control-center/src/router.mjs:69`、`:101`，
   `apps/control-center/src/app.mjs:62`。
3. Adapter 模板不再声明 `capabilityEnvelope`；运行目录、模型、自定义席位和逻辑成员统一输出
   `capabilities: ["*"]`：`apps/control-center/src/adapters/manifest.mjs:520`、
   `apps/control-center/src/app.mjs:100`、`apps/control-center/src/team-members.mjs:165`。
4. 旧成员能力数组只校验其协议形状为数组，内容无条件丢弃并迁移为 `["*"]`；长度、陈旧标签或非字符串条目
   均不能继续阻断加载、保存或成员资格。UI 删除能力复选框和候选“能力匹配”列，固定显示“默认全能力”。
5. 图片、视频和 WebP 可投递给显式成员，不再触发 `ATTACHMENT_TARGET_REQUIRED` 或静态视觉能力判断；
   附件仍只绑定当前 interaction，后续纯文本不会重放旧图。

验证：`router.test.mjs` `19/19 pass`、`team-members.test.mjs` `11/11 pass`；两者均在 TAP summary 后被既有
句柄拖到外层 30 秒超时。`npm run validate` 13 项全部 valid 且干净 exit 0。Playwright 输出 `ok:true`：8 条
消息只有首条携图，后七条重放数为 0；meta 为 `总轮次 8 · 交互 9 · 本次步骤 1/6`；桌面和 390px 无横向
溢出；配置页显示“默认全能力 / 特殊通道只由带原因的显式路由规则限制”。脚本完成断言后仍因隔离服务关闭链
被外层 120 秒回收。未调用真实付费 provider，也未在本次收口中重启或终止 `127.0.0.1:51400`。

### 独立终审补强

独立 reviewer 首轮给出 `CHANGES_REQUESTED`：新运行目录和成员虽然已经归一为 `["*"]`，旧 run 内嵌的
`teamRoster` 仍可能保留 `coding/review` 子集，并通过成员身份提示继续送进 provider。该 P1 已关闭：

- `legacyTeamMember()` 与 `normalizeTeamMember()` 无条件输出 `["*"]`；
- `init()` 在恢复 durable work 前迁移数组型、对象型和缺失能力声明，并复用 `restatedOnRestart -> save(run)`
  串行链回写磁盘；
- 回归同时覆盖新 run 内存/磁盘、旧 run 重启回写和续聊真实 prompt；provider 只能收到
  `capabilities: *`，不会再收到历史子集；
- `identityOnly` 把单项 `*` 视为中性默认值，过渡型纯身份 roster 不会因此多注入一段无意义提示。

修复后完整编排组 `80/80 pass`；随后中性提示与旧 roster 迁移定向组 `2/2 pass`。两次均在 TAP 汇总后
被既有句柄拖到外层超时。特殊路由图的未知 `prefer`、未知 `allowedProviders` 和空白 `reason` 纯契约测试
`1/1 pass` 且干净 exit 0。独立 reviewer 复核为 `APPROVED`，未发现第二条旧子集注入路径。

运行态边界：当前 PID `27676` 于 07:23 启动，早于本节最后两项补强；图片软路由和默认全能力主链已在该实例，
但旧 run roster 回写与独立复核特殊约束需下次正常重启才加载。本轮遵守约束，没有重启或终止 `51400`。

__DELTA__: 烛(Codex) | 1 | governance | 证据：独立 reviewer 发现旧 run roster 能力子集仍会进入 provider prompt；现由 `apps/control-center/src/orchestrator.mjs:119`、`:147` 的归一化/回写迁移与重启续聊回归闭环。

## Grok Responses 第三次续调 400 与失败会话恢复（2026-08-15 13:32）

### 根因

Run `83c475d2-35f2-484b-9adf-3194f5ea37aa` 不是能力路由、图片或旧会话问题。`~/.grok` 事件链证明它是
全新 Grok session：前两次 Responses 模型调用和 `list_dir/read_file` 工具循环成功，第三次模型续调才由
`514claude.xyz` 兼容链返回 `HTTP 400 bad_response_status_code: openai_error`。直接 CLI 偶尔正常，是因为成功
样本只完成一次模型调用、没有进入相同的多轮工具续调路径；历史主目录 CLI 也出现过同类 400，因此不是
Control Center 独有故障。反代没有返回更深层上游拒绝字段，当前不能继续猜测服务端原因。

Control Center 的可修缺陷是：Grok 来不及发 `end` 时，原生 session 没有进入 run 台账，下一条“继续”会
丢掉已完成的前两次工具上下文。初版修复又把预分配 UUID 直接当成原生 session，独立 reviewer 用 spawn
`ENOENT`、首次 400 和缺 `end` 反例证明会产生幽灵会话；后续还发现成功路径曾把 phase 从
`submitting` 回退到可退款的 `session_ready`。两项 P1 均已关闭。

### 修复

1. `grok-build.mjs` 用 `--session-id` 预分配新 ID，但首次 checkpoint 只写
   `tentativeSessionId + sessionResumable:false`；只有收到 `end`，或错误用量证明 `modelCalls>0`，才提升为
   `sessionResumable:true`：`apps/control-center/src/adapters/grok-build.mjs:175`、`:211`、`:240`。
2. spawn `ENOENT/EACCES/EPERM/UNSAFE_COMMAND_SHIM` 明确按 rejected 结算；首次 400、无 end 空截断不再写入
   `run.sessions`，也不会显示“已保留”。第三次 400 仍携带确认后的 session，下一条消息可走 `-r` 续聊。
3. attempt 台账拆开 tentative/resumable；未声明 marker 的其他 Adapter 保持旧契约。成功 Grok 用第二次
   `submitting` checkpoint 提升 session，不倒退 phase，也不能被退款重放：
   `apps/control-center/src/orchestrator.mjs:2063`、`:2234`、`:2264`。
4. 正常 `assistant.message/grok.completed` 延迟到 `exit code=0 + end` 都确认后发布；`end + nonzero` 不会先
   显示完成再把 run 翻成 failed：`apps/control-center/src/adapters/grok-build.mjs:235`。
5. 失败卡对 `grok-headless-resume` 强制检查 `sessionResumable===true`，旧幽灵 ID 不再显示“继续当前会话”；
   其他 Adapter 继续沿用 `run.sessions` 契约：`apps/control-center/public/app.js:11809`。

### 验证

- Grok Adapter：`10/10 pass`，覆盖第三次 400、首次 400、spawn 失败、新/旧 session 缺 end、
  `end + nonzero` 事件泄漏和成功双 checkpoint。
- 完整 orchestrator：`85/85 pass`，含跨 Adapter 兼容、tentative 不提升、第三次 400 续聊、成功确认崩溃
  窗口保持 `submitting` 且 `canRefundAbandonedRound=false`。
- UI 契约：`5/5 pass`；`node --check` 涉及模块全部通过。
- `npm run validate`：13 项全部 valid，干净 `exit 0`。
- 定向 `git diff --check`：无错误，仅工作区既有 CRLF 警告。
- 独立终审：`APPROVED`，未发现新 P1/P2。

上述 Node 测试均在 TAP 汇总后被仓库既有活跃句柄拖到外层超时；断言为绿，但不能描述为自然 `exit 0`。
本轮没有执行付费 Grok 重试，也没有自动重放写盘任务，避免重复工具副作用。

### 运行态边界

2026-08-15 13:32 读回：桌面壳 PID `25104` 和旧 Node PID `27676` 仍存活，但 `127.0.0.1:51400` 已无
监听，属于半关闭状态。PID `27676` 的启动时间早于本节后端修复，且当前 HTTP 内核已停；本轮没有终止、
重启或覆盖该进程。源码与测试已收口，运行态激活仍需 LO 明确授权后做一次正常重启，再用真实多工具任务验收。

__DELTA__: 烛(Codex) | 2 | architecture | 证据：独立 reviewer 两次推翻初版可恢复 session 设计，分别发现预分配 UUID 会制造幽灵会话、成功 end 会把 submitting 回退到可退款 session_ready；现由 `apps/control-center/src/adapters/grok-build.mjs:175`、`:240` 与 `apps/control-center/src/orchestrator.mjs:2077` 的 tentative/resumable 双账和单调 checkpoint 闭环。
