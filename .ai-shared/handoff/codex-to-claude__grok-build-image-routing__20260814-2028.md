<!-- 514cc-session-id: 019ffea1-2d9f-7370-a6f8-1d793d737451 -->

# Grok Build 图片路由与协作台粘贴闭环

## 致命问题

无剩余致命问题。用户现场的 `no healthy provider can satisfy multimodal` 已定位为控制面的能力注册与路由/执行席位分裂，不是 Grok 本身不支持识图。

已关闭的关键绕过：

- `apps/control-center/src/router.mjs:54`：真实视觉附件优先于客户端 `taskType`，`taskType:"coding"` 不能再让视频或未实证图片绕过能力闸。
- `apps/control-center/src/orchestrator.mjs:1461`、`:1485`：显式 `startAgentId`、`requestedProvider`、router 返回值和实际 execution owner 必须落到同一 runtime；不一致分别以 `VALIDATION_FAILED` 或 `TRANSACTION_INCONSISTENT` 原子拒绝。
- `apps/control-center/src/orchestrator.mjs:3707`：续聊附件在写盘前校验执行 owner 的媒体能力；Grok PNG/JPEG 允许，WebP/GIF/video 拒绝且不改变 `run.sources`。
- `apps/control-center/src/run-sources.mjs:49`：来源先校验、按 Windows 大小写折叠去重，再按 16 个唯一来源计上限；旧视觉重复路径不会误阻断新增非视觉附件，第 17 个唯一来源仍 fail-closed。

## 建议改进

- 后续可将 `video-analysis` 从 `document-analysis` 中拆出，避免其他席位凭粗粒度文档能力接收视频。
- 当前路由尚不能表达“时效资料处理 AND 图片分析”两个能力同时必需，混合任务仍按视觉附件优先的安全口径处理。
- Windows 来源去重当前只折叠大小写，尚未统一 `/`、`\\`、`..` 与符号链接别名。
- 仓库级 `git diff --check` 被并行修改的 `apps/control-center/public/styles.css` 尾随空格挡住；本任务相关已跟踪文件的定向 `git diff --check` 通过，未改动该并行 CSS。

## 可保留

- `apps/control-center/src/adapters/manifest.mjs:157` 与 `config/control-center/models.json:251` 为 Grok Build 注册精确的 `image-analysis`，模型对齐 `grok-4.6`；能力证据记录于 `config/control-center/models.json:275`。
- `apps/control-center/src/run-sources.mjs:27` 只将本机已实证的 PNG/JPEG 归为 `image`；其他图片归为 `image-unverified`，视频归为 `video`，混合附件采用更强约束。
- `apps/control-center/public/app.js:14436`、`:14522` 让预览和正式提交都把当前直接收件人作为 `requestedProvider`，不再出现 UI 选 Grok、路由验证其他席位、实际又交给 Grok 的分裂。
- `apps/control-center/tests/grok-image-routing-http.test.mjs:86` 覆盖隔离 HTTP dry-run，不调用付费 provider；`apps/control-center/tests/orchestrator.test.mjs:702` 覆盖 15/16/17 唯一来源边界。
- 最新聚焦：`103/103 pass`。
- 最新全量：`1150 tests / 1149 pass / 0 fail / 1 skip`，进程正常退出。
- 最新 `npm run validate`：13 项全部 valid。
- 独立 reviewer 最终 verdict：`APPROVED`。reviewer 单独边界断言 `1/1 pass`，其测试进程被既有句柄拖到外层 120 秒超时；干净退出证据以上述主线程全量为准。
- 最新运行态实例：`http://127.0.0.1:4519/#token=grok-multimodal-route-qa-token`，PID `18984`。使用用户两张真实 PNG 复验：preview HTTP 200、`taskType=multimodal`、selected/runtime=`grok-build`、`fallbackUsed=false`；dry-run HTTP 202、execution owner/route 均为 `grok-build`；续聊 PNG HTTP 200；WebP/video HTTP 422 `RUNTIME_CAPABILITY_CONFLICT`，回读 sources 保持两张 PNG。
- 最新浏览器 `ClipboardEvent` 复验：`defaultPrevented=true`、当前目标 `grok-build`、上传完成后 `aria-busy=false`，附件 chip 可见；截图为 Playwright 产物 `grok-clipboard-final.png`。
- 未执行真实付费 Grok 推理；本轮只使用已有本机 ACP 能力证据、dry-run 与浏览器/API 链路验证。

## 总评

**APPROVED。** 协作台现在能直接粘贴图片，并能把 PNG/JPEG 发送给已实证支持识图的 Grok Build；原报错链路已从 UI、服务端事实推导、能力路由、执行 owner、续聊附件和持久化原子性六层闭环。WebP/GIF/video 保持保守拒绝，避免把未实证能力包装成已支持。

__DELTA__: 烛(Codex) | 2 | architecture | 证据：apps/control-center/src/router.mjs:54、src/orchestrator.mjs:1461/1485/3707 与 src/run-sources.mjs:49 关闭了 taskType 绕过、route/owner 分裂、续聊附件绕过和去重前计数误拒四条原判断未覆盖的路径
