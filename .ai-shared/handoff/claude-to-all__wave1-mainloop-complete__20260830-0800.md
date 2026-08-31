# Wave 1 主环路合拢执行报告：6/6 全部完成

- 执行者：烛（Verdent 运行时）
- 时间：2026-08-30 05:40 ~ 08:00（绝对时间 UTC+8）
- 依据：LO 批准《514cc Console 完善 + 拓展总计划》
- 说明：本会话无 route-gate 注入 session marker，按契约省略该行。

## 本轮完成（W1.3 / W1.4 / W1.6，承前 W1.1 / W1.2 / W1.5）

### W1.3 Artifact 出卡 ✓

- 新模块 `public/modules/artifact-card.js`（单例工厂）：DELTA 账本 / handoff / 发布门禁三源以可展开卡片进 bot 会话流，左侧列表 + 右侧内容面板（对标 Claude Artifact）。
- 三源只读 `/api/observability/delta`、`/api/observability/handoffs(+/:name)`、`/api/release-record`；单源失败独立显示错误不拖垮整卡（fail-closed）。
- 会话流每次 innerHTML 全量重建 → 单例缓存展开状态与数据，`mount()` 恢复不闪不重拉。
- DELTA 分数徽章 0/1/2 三色 + invalid；handoff 点选加载内容（剥离 Markdown + 1200 字截断预览，防路径穿越靠服务端既有白名单）；门禁 verdict 徽章 + unfinished 前 2 条 + nextAction。
- 头部常显三计数 chip（DELTA n · handoff n · 门禁 verdict），720px 以下单列堆叠，reduced-motion 遵守。
- 接线：app.js 流尾 `<div data-artifact-mount>` + `artifactCard.mount(...)`。

### W1.4 sessions 并轨 ✓（确认为已实现，未重造）

- 核查证据：`sessionGroupsMarkup`（app.js:16280）经 `runSessionLinkIndex` 把原生 CLI 会话按 runId 硬关联进项目树 run 块（协作会话优先、未关联按 CLI 分组）；置顶/归档区（app.js:7221 renderRailMetaSections）已是 run+project+session 混合渲染（Codex 式单一分区）。
- 结论：计划基线"两套并存"在前波次树重构中已收敛为同一脊柱，本轮验证确认，不铺新摊子。

### W1.6 gemini 会话进树 ✓（grok 已由前波次 best-effort 实现）

- 本机实证 `~/.gemini/tmp/`：`<project>/chats/session-*.json`；`<project>` 为明文 cwd 名或 64-hex sha256；明文/短哈希目录带 `.project_root`（首行=cwd）；session json 头部 `{sessionId, projectHash, startTime, lastUpdated, messages[{id,timestamp,type,content}]}`。
- `src/sessions.mjs` 新增 `#geminiSessions()`：限根（realpath 双查，逃逸 symlink 不列不读）、>2MB 只用文件名时间戳不解析、sessionId 优先于文件名、opt-in summary 取首条 user 消息过 scrub、哈希目录 scope 如实标 `hash:<dir>` 不伪造 cwd。
- 聚合管线 12 源 → **13 源**（list() destructure + sources 数组）。前端源渲染通用无白名单，自动接入。
- 冒烟实测：available=true、45 会话、44 有 summary、明文目录 cwd 还原成功（`i:\514claude\514cc`）。
- 测试：`session-source-consistency.test.mjs` 源清单期望 +gemini，新增独立用例（明文/hash 双目录、sessionId 优先、scope 还原/如实标注、summary 脱敏），3/3 过。

## Wave 1 总账

| 条目 | 状态 | 落点 |
|------|------|------|
| 1.1 一键收口卡 | ✓（上轮） | release-command-runner stopOnFailure + closeout-card.js + 2 测试 |
| 1.2 审批钉顶 + Y/N | ✓（上轮） | botPinnedApprovalMarkup + document 级快捷键 |
| 1.3 Artifact 出卡 | ✓ | artifact-card.js（新）+ app.js 接线 |
| 1.4 sessions 并轨 | ✓（确认已实现） | runSessionLinkIndex + renderRailMetaSections |
| 1.5 composer 模式 picker | ✓（上轮） | bot-orchestration-pick radiogroup |
| 1.6 grok/gemini 进树 | ✓ | #geminiSessions（grok 前波次已实现） |

## 验证

- `node --check`：app.js / artifact-card.js / sessions.mjs 全过
- 聚焦测试：session-source-consistency 3/3；release-command-runner + release-record 26/26
- `npm test`（全量）：见收尾输出（本轮执行中）
- `qa:delivery --strict`：**pass**（artifact-card.js / sessions.mjs 等已申报）
- bot-shell.css 大括号 925/925 平衡

## 遗留与下一步

- Wave 2（2.1 token 归并 / 2.2 app.js 预算 / 2.3 palette 全覆盖 / 2.4 原生通知 / 2.5 三导航合一 / 2.6 视觉基线 / 2.7 桌面 README / 2.8 回放 scrubber）待开。
- push 授权与 P0 token 轮换仍待 LO。

__DELTA__: 烛(Verdent) | 1 | 证据：src/sessions.mjs #geminiSessions 13 源接入（实测 45 会话/44 摘要/cwd 还原）；artifact-card.js 三源出卡补齐 bot 流证据面最后一环。
