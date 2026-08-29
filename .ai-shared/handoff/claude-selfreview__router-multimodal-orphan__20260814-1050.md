<!-- 514cc-session-id: a15f882e-8bb5-45d0-8ca7-e7944aae991b -->
# `no healthy provider can satisfy multimodal` 两层根因修复

日期：2026-08-14
执行者：主驾（Claude / 洛琪希皮肤）· 未召唤外部 subagent（会话级 harness 指令禁止未经 LO 请求的 AgentTool）
状态：`IMPLEMENTED / 待 LO 验收`。未 commit、未 push。**需重启 Console 才生效**（server 侧配置在启动时加载）。

## LO 报的现象

协作台报 `no healthy provider can satisfy multimodal`，消息发不出去。触发语句是「现在协作台不能直接复制粘贴图片请你完善」。

## 两层根因

1. **分类误判**（`src/router.mjs:22` 原关键词表）：`/图片|视频|音频|截图|image|video|multimodal/i` 命中「图片」二字即判 multimodal，且该条排在 coding（第 6 位）之前，`find` 先匹配先赢。那句话描述的是**要实现的功能**，不是要分析的对象。
2. **孤儿能力**（更硬）：`multimodal` 需要 `multimodal`/`document-analysis`，而这两项当时只声明在 **`gemini-research`（enabled: false）** 上——v3.4.3 织的驱动从 gemini 换成 grok-4.5 时，`rules.md` 的职责描述更新了，`config/control-center/models.json` 的能力声明没跟着迁移。
   - 连带同样全废的还有 `long-context` 与 `document-analysis` 两个任务类型（required 能力同样只在禁用席位上）。也就是说提到「长文档」「全文」会撞同一堵墙。
   - 即使分类正确（真要分析一张图），也照样 NO_ROUTE。

## 改动

- `src/run-sources.mjs`：新增 `hasVisualSource(sources)` + `VISUAL_SOURCE_EXTENSIONS`（不含 `.pdf`——PDF 归 document-analysis 语义）。
- `src/router.mjs`：`classifyTask(prompt, { hasVisualAttachment })`——**有视觉附件才判 multimodal，删掉关键词那条**；`preview()` 接受 `hasVisualAttachment`；导出 `taskCapabilities` 供覆盖闸使用。
- `src/orchestrator.mjs`：`create` 的 `router.preview` 传 `hasVisualAttachment: hasVisualSource(normalizeRunSources(input.sources))`。
- `server.mjs`：`/api/router/preview` 从 `input.sources` 服务端推导判据后 `delete input.sources`，不信客户端直提（与 `allowedProviders` 同一条口径）。
- `public/app.js`：`previewRoute` 把 `state.attachments` 一起送上去。
- `config/control-center/models.json`：`claude-fable` 承接 `multimodal` / `document-analysis` / `long-context`，附两条 `evidence`（依据 + 迁移理由 + 为什么不给 grok）。
- `src/adapters/manifest.mjs`：`claude-stream-json` 的 `capabilityEnvelope` 扩这三项，注明是**路径式**通道（run.sources 注入绝对路径 + Read 工具打开），与 `gemini-stream-json` 同口径，不是 API 内联图像。

### 能力归属的取舍

给 **claude-fable** 而不是 grok-search：
- 有依据的部分：Claude Code 的 Read 工具原生渲染图片、分页读 PDF；上下文 1M，长文档无需分片；run.sources 已经把绝对路径喂到会话里。
- 明确不给 grok 的理由：`514claude.xyz` 反代单次约 10KB 上限（实测记忆），且**没有任何经反代的视觉往返实测证据**。`rules.md` 里织"图/PDF 分析"的定位是换驱动时写下的，不构成实测。
- 诚实边界：`evidence` 里写明「Not yet exercised end-to-end through a control-center turn」——CLI 能力事实成立，但协作台内派一轮真图分析我没跑过。

## 我在过程中撞的一道闸（值得记）

第一版只改了 `models.json` 的能力声明，结果**全量 HTTP 测试集体红**：`src/adapters/manifest.mjs:520` 有一道 fail-closed 闸——席位 capabilities 不得超出其 adapter 模板的 `capabilityEnvelope`，超出则**服务器启动即拒绝**（`ADAPTER_MANIFEST_INVALID`）。

这道闸设计得对：它防的正是「给席位声明它的执行通道根本做不到的能力」。我先误以为全量红是 LO 的 Console 占用实例锁（时间上恰好吻合），查了具体错误才确认是自己的改动。**教训：全量突然大面积红先读错误正文，别用时间相关性归因。**

## 验证

- 覆盖闸红检：把三个能力从 `models.json` 摘回去 → 孤儿闸 + preview 闸变红（11 → pass 9 / fail 2），恢复后复绿。
- 分类闸红检：把关键词那条加回去并停用附件判据 → 分类闸 + preview 闸变红（同上），恢复后复绿。`REDCHECK` 残留计数 0。
- 新增 5 个测试（`tests/router.test.mjs`）：孤儿能力覆盖闸（**治本闸**：任何任务类型没有在役席位持有其 required 能力就红）、分类判据、preview 端到端、`hasVisualSource` 扩展名、预览端点服务端推导且先于 router 调用。
- 回归：全量 `npm test` **1119 tests / 1118 pass / 0 fail / 1 skip，真实 EXIT=0**；`npm run validate` **13/13 valid, EXIT=0**；`node --check` 全过。

## 留给 LO

1. **必须重启 Console**：`models.json` / `manifest.mjs` / `router.mjs` 都在 server 启动时加载；你当前实例（pid 39484，02:41 启动）跑的还是旧配置。前端改动刷新页面即可。
2. 未做端到端真图验收（需要真派一轮 claude CLI）。要我做请说。
3. 未 commit / 未 push。

__DELTA__: 主驾自评(无外部发火) | 1 | correctness | 证据：config/control-center/models.json + src/adapters/manifest.mjs:61 把 multimodal/document-analysis/long-context 从已禁用的 gemini 席位迁到在役主脑，修掉三个任务类型永久 NO_ROUTE；新增孤儿能力覆盖闸并红检确认 buggy 必红
