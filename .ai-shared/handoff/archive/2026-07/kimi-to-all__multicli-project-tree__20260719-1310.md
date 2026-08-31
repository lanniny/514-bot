# handoff：多 CLI 项目树——Claude/Codex 会话统一入口（kimi → all）

- 时间：2026-07-19 13:10
- 范围：`apps/control-center`（src/sessions.mjs、server.mjs、public/app.js、public/styles.css、scripts/qa-ui.mjs、tests/multicli-sessions.test.mjs 新增、DESIGN-NOTES.md 追加）
- 触发：LO「现在只能看到 claude 的会话入口，需要一个项目下分 claude 会话、codex 会话等等」

## 做了什么

1. **后端归并**：`projects()` 新增 codex rollout 归并——`~/.codex/sessions` 按 `session_meta.payload.cwd` 分组，命中 claude 项目 cwd 的挂入（`cli:"codex"`），未命中合成 `codex-<slug>` 项目。真实数据：2025 G题=Claude·9+Codex·10、514cc=10+10、cch=1+8。
2. **Codex 预览**：`previewCodex()` 解析 response_item（event_msg 镜像去重），剥 AGENTS.md/环境上下文注入样板，同 claude 的脱敏/截断纪律；通用 query 路由 `/api/sessions/preview?source=&scope=&id=`；reveal 通用化。
3. **前端**：项目树/置顶区按 CLI 分组显示（`Claude · N` 组头，多 CLI 才显示）；会话行带 cli/scope；预览、13 项右键菜单、置顶/归档/未读/别名、偏好键、深度链接全部 cli 感知；恢复命令 `claude -r` / `codex resume <uuid>` 按源分发。
4. **QA 不变量升级**：摘要回归改 `data-has-summary` 属性断言（更直接测隐私不变量，消除对 codex 日期 label 的误伤）。

## 验证

- 新增 tests/multicli-sessions.test.mjs：临时假 home（USERPROFILE 重定向）端到端——同 cwd 合并、label/scope、样板剥离、去重、scope 遍历 422。
- 真实环境交互脚本：分组头/codex 预览 10 条消息/右键 13 项，0 JS 错误。
- `qa:ui --suite=all` 0 错误；`node --test` 115/115。

## 注意

- 偏好键升级为 `cli::projectId::sessionId`（旧两段键自然作废——上线时 sessions 映射为空，无迁移负担）。
- grok（存储结构未实证）/gemini（目录名为路径哈希，逆映射不可靠）暂不进树，仅在会话聚合视图可见。

__DELTA__: 烛面(kimi) | 1补强 | 项目树多 CLI 统一入口（sessions.mjs #mergeCodexProjects/previewCodex/resolveFilePath 通用化；app.js CLI 分组渲染+cli 感知菜单/深链/偏好键；multicli 端测 + 115/115 + qa:ui 0 错误 + 真实数据实拍）

## 追加（同日）：主对话 vs 子代理会话区分

- LO 反馈列表太乱。根因：codex 编排派生子代理 rollout（实测 26/302）与主对话混排。
- 后端 session_meta 提取 subagent/nickname；前端新增「子代理」开关默认隐藏派生会话，显示时带「子」徽标+昵称标题；15 分钟内更新带活跃绿点。
- 验证：开关两态 Playwright 断言通过；qa:ui 0 错误；115/115。

__DELTA__: 烛面(kimi) | 1补强 | 子代理会话识别与默认隐藏（sessions.mjs codexMetaFromLine；app.js visibleTreeSessions/subagents-toggle/is-subagent/live-dot；开关两态实拍 + qa:ui 0 错误 + 115/115）

## 追加（同日）：CLI 官方徽标与按源作者名

- 修掉 codex 会话显示 Claude 图标/名字的问题（预览作者曾硬编码 "Claude"）。
- 官方徽标：Claude 星芒（simple-icons CC0）+ OpenAI knot（Wikimedia 官方路径）入 index.html sprite；预览头像/作者/meta、CLI 组头全部按源区分。
- 验证：组头/头像/作者 Playwright 断言全过 + 实拍复核；qa:ui 0 错误。

__DELTA__: 烛面(kimi) | 1补强 | CLI 官方徽标与按源作者名（index.html icon-cli-claude/icon-cli-codex；app.js cliIconMarkup/messageMarkup cli 头像/renderSessionPreview 按源作者；组头图标断言 18/18 + qa:ui 0 错误）
