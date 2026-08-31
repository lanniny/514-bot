# v4.0 Forge 深度收口：设计系统 + 团队旗舰视图 + 搜索/记忆/脚手架后端（Kimi → all）

> 时间：2026-07-25 · 主驾：Kimi（10-agent 蜂群 + 主驾集成收口）· 范围：apps/control-center 全栈
> 触发：LO 四点要求（集成 codeg+LiveAgent 全部功能并加强 / 多 CLI 团队协作特色深度集成 / 创新 / UI 对齐大厂与 Awwwards 水准、Lucide 统一、零 emoji）

## 一、落地清单

### 1. Forge 设计系统（对标 codeg 0.21.8 设计拆解，vanilla 实现）

- `public/forge/` 十层 CSS：tokens（OKLCH 明暗双主题、rose 主色、agent 品牌变量、radius/elevation/字号/z 阶）→ motion（动效预算、forge-enter/shimmer/conic-spin、reduced-motion 全降级）→ primitives（按钮/卡片/对话框/输入/滚动条/glass）→ shell/workbench/data/markdown/team/palette/bootstrapper 各视图层。加载顺序固定，全部带旧变量回退。
- **图标统一**：Lucide 85 图标离线 sprite；`scripts/vendor-lucide.mjs` 已同步全量清单、修掉 `stop-circle→circle-stop` 上游更名、根元素去除被 CSP 拦截的 style 属性。旧手绘 sprite 仅剩 `icon-cli-*` 官方徽标（LO 铁律保留）；mission-control.js 动态图标经 `LEGACY_ICON_MAP` 全部改写。
- **零 emoji**：bootstrapper 15 处、附件 chip、DELTA 文字符号全部换 Lucide；扫描脚本验证通过。

### 2. 多 CLI 团队旗舰视图 `#/team`（创新面）

- 英雄统计（协作席位/活跃席位/今日交接/平均 DELTA，tabular-nums 大数字）、花名册卡片（品牌色环、负载条、状态点、当前任务）、SVG 协作流图（delegation + handoff 边、权重徽标、悬停高亮）、7 日活跃热力、路由决策表 + 本地启发式派工建议（明示"建议"）。
- 数据全部真实端点（teams/runs/health/delta/handoffs/routegate），`Promise.allSettled` 分区降级 + 3.5s 超时（health 探针慢源不再拖住整屏）+ 骨架/空态/错误态齐备。
- 总览页团队面板 v2 与 DELTA 时间线 v2 同构升级。

### 3. 后端新能力（12 个新测试）

- `src/search.mjs` + `GET /api/search`：handoff/context/decisions/MEMORY/会话/skills 五源统一搜索（命令面板全局搜索落地）。
- `src/memory.mjs` + `GET /api/memory` `/api/memory/search`：记忆库只读视图 + 检索（观测视图记忆库卡片落地）。
- observability delta 响应新增规范化 `deltas[]`（id/ts/agent/score/topic/evidence）——修复 DELTA 时间线"契约断裂永久空态"。
- `src/bootstrap.mjs` + `POST /api/bootstrap/scaffold`：诚实静态脚手架（3 风味模板、零网络、dryRun 默认、路径围栏拒绝逃逸）——项目启动器从"配置倒入输入框"升级为真实落盘流程（计划→确认→创建）。

### 4. 命令面板统一

- 旧 app.js 内嵌 `<dialog>` 面板整体退役；cmdk 级新面板承接：视图导航（VIEW_TITLES 自动同步）+ 快速操作 + Agent 点名 + **extraItems 注入**（协作/权限/模板动作迁移自旧面板）+ 全局搜索（250ms 防抖、AbortController 去竞态、404 静默降级）。Ctrl+K 双绑修复。

## 二、集成收口修掉的断裂（蜂群并行的接缝，均已验证）

1. **静态服务白名单不含 `/forge/*` 与新模块** → 全部设计层 404（MIME application/json）。server.mjs 增 `resolvePublicAsset`：`/forge/`、`/modules/` 前缀 + 段校验（拒绝 `..`/反斜杠/NUL/未知扩展）+ publicRoot 围栏。
2. **自举模块 token 竞态 401**：collab-flow/memory-browser 在 app.js 完成 token 初始化前发请求。新增 `apiReady` 信号——api.js `setAccessToken()` 即放行（app.js 本地 `initializeAccessToken` 与 api.js 版是两条引导路径，此点务必知晓）。
3. **CSP `style-src 'self'` 违规 1313 → 0**：team-panel/delta-timeline/collab-flow/app.js/lucide.js/rich-render 的内联 style 全部改走 `data-brand` 属性映射（team.css 品牌色表）、`nth-child` 错峰、CSSOM `setProperty`（负载条/骨架高/星图轨道角）。
4. **源文件 NUL 字节**：collab-flow.js ×1、team-panel.js ×2（`\x00` Map key 分隔符写成原始字节）→ 全部转为 `\u0000` 转义文本。
5. **契约测试更新**：`mission-control-ui-contract.test.mjs` 命令面板断言从静态 dialog 更新为模块化现实（trigger chip + extraItems + 模块导出）。

## 三、验证

- `npm test`：**447 总 / 446 pass / 0 fail / 1 skipped**（历史 skip）
- `npm run validate`：**12/12**（园丁工位已把版本真源回正 v3.5.0 + CHANGELOG 未发布波次约定）
- Playwright 真实 Chromium：11 张视图截图（明/暗）走查 + **控制台 0 错误**；`/forge/*` MIME、`..` 逃逸、未知扩展均正确处置
- `scripts/qa-v4-shots.mjs` 保留为可视化回归工具（用法：`node scripts/qa-v4-shots.mjs <带bootstrap的URL>`）

## 四、已知增强债（下波候选，不假装完成）

- KaTeX/Mermaid **实时渲染**需 vendored 库（CSP-safe），当前为类型徽标 + 源码美化。
- `/api/health` 首载串行探针慢（数秒）——建议缓存值先回 + 后台刷新（stale-while-revalidate）。
- 进程监管 UI（process-runner/child-registry 已有后端）本波未做前端。
- styles.css 旧 `.bootstrapper/.boot-*` 块（~10088-10371 行）与旧 `.command-palette` 规则已被 forge 层全覆盖，可清理（styles.css 本波刻意冻结未动）。
- 跨 run Evidence Graph、Heterogeneous Replay、Counterfactual Dispatch 仍是 R3 目标态。
- 安全门闩面（Channels/SSH/Office/PTY/市场安装）维持 LO 拍板边界，未动。

## 五、接手提示

- 新视图/面板开发：先读 `public/forge/README.md`（token/动效/图标用法）与 `DESIGN-NOTES.md` v4.0 节。
- 自举模块（script type=module 直挂）：发请求前必须 `await apiReady`（见 collab-flow.js bootWhenReady）。
- 写 markup 禁用内联 style（CSP）：品牌色走 `data-brand` + team.css 映射，几何量走 CSSOM `el.style.setProperty`。
- 新增 Lucide 图标：`scripts/vendor-lucide.mjs` 的 names 清单加名后 `node scripts/vendor-lucide.mjs` 重新生成（勿手改 sprite）。

__DELTA__: Kimi(主驾) | 1 | security | 证据：v4.0 蜂群 9/10 工位交付后，主驾集成收口修掉 5 处断裂（静态白名单/token 竞态/CSP 1313→0/NUL 字节/契约测试），447 测试 0 fail、validate 12/12、11 视图截图 0 控制台错误，CHANGELOG/context 已同步
