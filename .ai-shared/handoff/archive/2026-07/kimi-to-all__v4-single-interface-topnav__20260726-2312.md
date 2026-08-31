# 单界面波：撤左侧栏、全部入口集中顶栏（Kimi → all）

> 时间：2026-07-26 · 主驾：Kimi · 范围：apps/control-center 全局壳
> 触发：LO「我不要左侧栏将所有按键集中到一个界面上」

## 一、关键取证

`topbar-nav` **本就已全量镜像侧栏 15 个视图**（icon+短标签+is-active 样式齐备），只是 styles.css:7073 一行 `display:none` 雪藏至今。单界面化 = 扶它为正主，不需要造新导航。唯二缺口：协作星图（hero）只在侧栏有入口；面包屑与 nav 激活态重复。

## 二、处置

| # | 项 | 处置 | 落点 |
|---|----|------|------|
| ① | 侧栏整列 | `.sidebar{display:none}` + app-shell 收单列 grid（display:none 规避 grid-area 失效产生隐式列的陷阱） | forge/shell.css 单界面波段 |
| ② | 星图补位 | topnav 补 `data-view="hero"`（lucide orbit） | index.html |
| ③ | 面包屑 | `.topbar-title{display:none}`（nav 激活态即位置） | forge/shell.css |
| ④ | 防溢出 | 8 个长标签收两字（title/aria 留全称）+ nav 项 padding 11→9 / 字号 12.5→12 → 16 项 1512px 全显无截断 | index.html + shell.css |
| ⑤ | JS | 零改动：setView 同步所有 `[data-view]`，委托在顶层；QA 两脚本 goView 改走 `.topbar-nav` | scripts/qa-v4-*.mjs |

## 三、验证

- `npm test` 480 pass / 0 fail / 1 skipped；`npm run validate` valid。
- 21 站全量明暗截图亲查：顶栏 16 项全显、协作台单列全宽、暗态协调；星图经顶栏直达（`25-hero-topnav-light.png`，全宽星图气势完整）；控制台 0 错误。
- 侧栏 DOM 保留（display:none），sidebar-footer 状态点等 JS 引用不受影响；回退 = 删掉 shell.css 单界面波段。

__DELTA__: Kimi | 1 | 证据：qa-v4/01-workbench-light.png 顶栏 16 项全显无截断 + 25-hero-topnav-light.png 星图顶栏直达（CHANGELOG v4.0 未发布节）
