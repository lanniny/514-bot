# 成员选择区分组/搜索/新建成员波（Kimi → all）

> 时间：2026-08-02 · 主驾：Kimi · 范围：apps/control-center 团队编排面成员选择区（app.js / index.html / member-library.js / team.css）
> 触发：LO「在新建团队时选择成员我需要也能有新建成员的选项。并且，现在成员都是直接陈列的我需要各个成员要能分类展开并且可以搜索」

## 一、需求拆解

团队编排面成员选择区此前是 7+ 席位平铺列表：无分组、无搜索、无新建成员入口（要新建成员得先去成员库，回来再手动勾选）。本波三项全部纯前端增量——数据全走既有 state.bootstrap.teamCatalog，零新端点，不碰 teams.mjs/team-members.mjs 冻结内核。

## 二、落地内容

- **品牌分组折叠**：renderTeamMemberOptions 重构为 section.tm-group 分组渲染（Claude/Codex/Grok/Kimi/Gemini/Pi/其他固定序），组头 = 品牌 logo + 「n 席 · 已选 m」实时计数 + chevron；折叠态内存 Set 跨团队保留，组计数随勾选联动（updateTeamRosterSummary）。
- **搜索过滤**：工具条搜索框（多关键词 AND，匹配 id/名称/简称/职责/provider/席位/品牌中文名），Esc 清空。**关键安全设计：过滤只切换行 hidden 绝不移出 DOM**——collectTeamForm 直接读 DOM checkbox，新团队草稿已选成员被过滤隐藏时保存不丢。搜索 input 事件 stopPropagation 防误触 form 脏标记；切团队重置搜索。
- **新建成员入口**：工具条「新建成员」→ member-library 新暴露 createNew()（与成员库按钮同入口：canDiscard 守卫 + 席位目录空时先刷新 + 直达空白草稿）；保存成功 save() 回调 onMemberSaved(memberId)，app.js 自动勾入当前团队草稿并标脏（内置只读不勾），toast 明示"保存团队后生效"。

## 三、验证证据

- `npm test`：656 pass / 0 fail / 1 skipped（无回归，契约测试 team-workspace-ui.test.mjs 原样通过）。
- `npm run validate`：13 valid。
- `scripts/qa-member-groups-probe.mjs`（隔离实例）：6 组品牌分组渲染+计数 → 折叠 codex 组行 hidden 但 checkbox 留 DOM 保持 checked → 搜索 kimi 只剩 kimi 组、已选 hidden 行计数不变（"2 个成员"）→ 无匹配空态 → 新建成员直达空白草稿 → 保存「探针测试员」自动勾入草稿（roster 2→3、标脏、落 claude 组）；明暗截图 `.qa-v4/member-groups-*.png` 亲查；0 控制台错误。

## 四、边界与回退

- 未动服务端与 CRUD 内核；分组/搜索是纯视图层，保存语义零变化（DOM 行只隐不删是硬约束）。
- 桌面端 Ctrl+R 生效；预览实例 :5520 已停（桌面端占用单实例锁）。
- 回退 = 还原 app.js 分组渲染段 + index.html 工具条 + member-library.js createNew/onMemberSaved + team.css 分组段落 + 删 scripts/qa-member-groups-probe.mjs。

__DELTA__: Kimi | 1 | architecture | 证据：app.js renderTeamMemberOptions 分组重构 + applyTeamMemberFilter hidden 过滤（collectTeamForm 读 DOM 安全）+ member-library.js createNew/onMemberSaved 自动勾入，探针实证折叠不丢勾选、搜索不丢计数、新建成员自动入草稿，0 控制台错误
