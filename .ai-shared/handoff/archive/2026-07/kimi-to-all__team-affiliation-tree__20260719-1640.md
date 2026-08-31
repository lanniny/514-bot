# handoff：团队从属层级——团队 → 项目 → 会话（kimi → all）

- 时间：2026-07-19 16:40
- 范围：`apps/control-center`（server.mjs、src/sessions.mjs、public/app.js、public/index.html、public/styles.css、scripts/qa-ui.mjs、tests/project-prefs.test.mjs、DESIGN-NOTES.md）
- 触发：LO「团队下面直接加入从属会话；创建会话时直接选团队；未选团队的项目归默认团队；项目/会话都可从属」

## 做了什么

1. **团队区改层级树**：团队 → 从属项目 → 会话（CLI 分组保留）；原「项目」区并入，摘要/子代理开关上移到团队头。
2. **两级从属**：项目 `teamId` + 会话 `teamId`（prefs 持久化，服务端白名单扩展）；未从属归默认团队（内置 514cc 标「默认」）；单个会话可跨团队从属（从原项目摘出挂目标团队）。右键「从属团队」二级菜单原位选取。
3. **创建时选团队**：composer footer 新增团队 picker，直通 createRun 既有 teamId。
4. **兼容**：会话偏好读取回退旧两段键。
5. **性能修复**：codex 归并 meta 提取 400 文件串行→16 路并发（47s→3s，QA 第三页超时根因）。

## 验证

- 交互断言全过（默认归组/二级菜单/项目迁移/会话 loose/composer 选项）；qa:ui ok:true 0 错误；node --test 115/115（prefs 端点加 teamId 断言）。
- 验证用团队已删、prefs 已还原（验证期间发现 LO 并行使用旧标签页——旧格式会话偏好已做读取兼容，但**旧标签页请刷新**，避免旧格式 PUT 覆盖新键）。

## 注意

- 团队选择已从左栏迁到 composer：左栏团队行只负责展开浏览，is-selected 仅标识当前团队。
- 团队树为空团队显示「无从属项目——右键项目可改从属团队」引导。

__DELTA__: 烛面(kimi) | 1补强 | 团队从属层级+创建时选团队+两级 teamId 从属（app.js teamNodeMarkup/effectiveProjectTeamId/effectiveSessionTeamId/teamPickContextItems；server.mjs prefs teamId 白名单；sessions.mjs 16 路并发修 47s 慢查询；qa:ui ok:true + 115/115）

## 追加（同日）：移除项目可同步删除磁盘会话文件

- 移除弹窗新增「同时删除磁盘上的会话文件」选项（默认不勾=仅隐藏原语义）。勾选后服务端把 Claude 项目目录 + cwd 匹配的 Codex rollout 移入 dataRoot/trash/<时间戳>/ 隔离区——系统目录清空、仍可恢复。
- 端测覆盖命中/旁观/可恢复三断言；弹窗实拍；qa:ui ok:true；116/116。

__DELTA__: 烛面(kimi) | 1补强 | 移除项目同步删除选项（sessions.mjs deleteProjectSessions 隔离删除；server.mjs /api/projects/delete-sessions；app.js confirmAction 复选框+移除接入；tests/delete-sessions.test.mjs；qa:ui ok:true + 116/116）

## 追加（同日）：「近期」过滤默认隐藏 30 天静默会话/项目

- 团队头新增「近期」开关（默认开）：30 天无对话的会话不进树，30 天全静默的项目整项目隐藏；关掉即全量。
- 实测开=25 项目/107 会话 vs 关=72/255；置顶/已归档区不受限。
- 验证：两态断言 + qa:ui ok:true + 116/116。

__DELTA__: 烛面(kimi) | 1补强 | 近期过滤默认隐藏 30 天静默会话/项目（app.js sessionRecent/projectRecent/visibleTreeSessions/renderProjects；index.html recent-only-toggle；两态实拍 25 vs 72 项目 + qa:ui ok:true + 116/116）

## 追加（同日）：codex 合成项目 id 碰撞修复（LO 报障）

- LO 发现很多项目移除弹窗路径都显示 G:\learn\数据结构——根因：合成 id slug 化使中文路径全部塌缩为 codex-g-learn，find() 恒中第一个。
- 修复：FNV-1a 散列 id（codex-<8hex>）。端测加中文 cwd 唯一性断言；真实 77 项目零重复；UI 三项目右键各自路径正确；qa:ui ok:true + 116/116。

__DELTA__: 烛面(kimi) | 2推翻主驾判断 | codex 合成项目 id slug 化是我多 CLI 波次的设计失误（中文路径塌缩碰撞）——改 FNV-1a 散列（sessions.mjs fnv1aHex；multicli 端测中文唯一性断言；77 项目零重复 id 实测）
