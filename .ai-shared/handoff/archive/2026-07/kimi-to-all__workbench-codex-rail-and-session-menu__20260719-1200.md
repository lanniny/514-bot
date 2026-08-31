# handoff：Codex 式左栏 + 原生会话全量右键菜单（kimi → all）

- 时间：2026-07-19 12:00
- 范围：`apps/control-center`（server.mjs / public/app.js / public/index.html / public/styles.css / tests/project-prefs.test.mjs 新增 / DESIGN-NOTES.md 追加）
- 触发：LO 三条指令——置顶区独立上移到项目上方；右键会话补全 Codex 式 11 项；左栏布局对标 Codex

## 做了什么

1. **左栏 Codex 式重排**：团队 → 新建任务（新增全宽入口）→ 置顶 → 会话 → 正在工作 → 项目 → 已归档。
2. **置顶区三实体混排**：run + 项目（从树中迁出，可内联展开）+ 原生历史会话（新能力）。项目置顶不再只是树内排序。
3. **会话级偏好持久化**：`project-prefs.json` 新增 `sessions` 映射（`projectId::sessionId` → pinned/archived/unread/alias）；server.mjs PUT 端点白名单清洗扩展，旧文件向后兼容。
4. **原生会话右键菜单**：4 项 → 13 项（LO 点名的 11 项 + 保留查看会话/复制恢复命令）。归档会话落左栏已归档区可恢复；未读打开即销；别名覆盖显示。
5. **会话深度链接**：`#token=…&session=<projectId>::<sessionId>` 可打开指定历史会话预览，支撑「复制深度链接」「在新窗口中打开」。

## 验证

- 交互脚本断言：菜单 13 项全出、置顶会话/项目进区、置顶项目内联展开、归档落已归档区、0 JS 错误。
- `qa:ui --suite=all` 0 错误；`node --test` 114/114（新增 project-prefs 端点用例）。
- 亮/暗 × 桌面/移动实拍复核；验证脚本对 project-prefs.json 的改动已手工还原。

## 注意

- 原生会话与 Console run 是两类实体：run 的 pinned/archived/unread 走后端 run meta（原有 PATCH /api/runs/:id/meta），原生会话走 project-prefs.json——两套存储有意为之。
- 「在新工作树中继续」复用既有 /api/system/worktree（git worktree add --detach）。

__DELTA__: 烛面(kimi) | 1补强 | Codex 式左栏+原生会话 11 项右键菜单（server.mjs prefs sessions 清洗；app.js sessionContextItems/renderRailMetaSections/pinnedProjectMarkup；index.html 新建任务行+置顶区上移；tests/project-prefs.test.mjs；qa:ui 0 错误 + 114/114 + 交互断言全过）

## 追加（同日）：项目行悬停「写」图标

- 项目树 + 置顶区项目行尾加悬停浮现铅笔钮（`.row-action`），点击=在此项目下新建会话（pendingCwd=该项目路径，焦点进 composer）。无路径项目按钮禁用。
- 验证：hover opacity 0→1、点击后 cwd 芯片/会话头正确、qa:ui 0 错误。

__DELTA__: 烛面(kimi) | 1补强 | 项目行悬停新建会话入口（app.js project-row 结构 + data-project-newsession 委托；styles.css .row-action；hover/点击 Playwright 断言通过）
