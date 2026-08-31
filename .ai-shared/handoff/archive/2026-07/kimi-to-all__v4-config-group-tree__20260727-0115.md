# 配置中心分组树波：99 源平铺 → 语义分组折叠（Kimi → all）

> 时间：2026-07-27 · 主驾：Kimi · 范围：apps/control-center 配置中心源列表
> 触发：LO「配置中心界面各种配置混在一起很乱」

## 一、诊断

`/api/config/sources` 实测 99 个源一锅平铺：SKILL.md、hooks、toml、mdc、宪法、Lilith、运行时镜像全混在一条流里，只能靠文本筛选硬捞——没有任何结构分层，正是 LO 说的「混在一起很乱」。

## 二、处置

| # | 项 | 处置 | 落点 |
|---|----|------|------|
| ① | 分类法 | `sourceGroupFor` 按路径拓扑归 13 组（顺序即展示序）：治理核心 5 / Claude·Codex·Cursor 三平台 9·13·10 / 平台技能 7 / 领域技能 19 / 控制台 6 / 人格与定制 4 / 守卫层 3 / Lilith 14 / 状态栏 2 / 运行时镜像·只读 7（沉底）/ 其他兜底 | app.js |
| ② | 组头 | Lucide 图标 + 组名 + 计数胶囊 + chevron 旋转，小字人文风（全用 sprite 现货，零新增） | app.js + styles.css |
| ③ | 折叠 | 默认全折叠（一屏 12 行代替 99 行乱流）；**含选中源的组强制自动展开**；手动折叠态 `state.sourceGroupsExpanded`（会话级）；**搜索态退化平铺**（0 组头） | app.js + state.js |
| ④ | 零侵入 | renderSources 拆 `sourceItemMarkup` 复用，数据面/选中/脏检查/确认弹窗全不碰；无服务器改动，Ctrl+R 即生效 | — |

## 三、验证

- `npm test` 480 pass / 0 fail / 1 skipped；`npm run validate` 12 面 valid。
- 探针 `probe-config-groups.mjs`：12 组渲染（other 空组自动隐藏）、计数对账 5+9+13+10+7+19+6+4+3+14+2+7=99、选中组自动展开且 selection 可见、手动展开/折叠正常、搜索 "customize" → 0 组头 6 平铺项、页面 0 错误。
- 截图证据：`.scratch/desktop-launch/35-config-groups-collapsed.png`（亮色全折叠）/ `36-config-groups-expanded.png`（手动展开）/ `37-config-search-flat.png`（搜索平铺）/ `38-config-groups-dark.png`（暗色双组展开）。

__DELTA__: Kimi | 1 | 证据：35-config-groups-collapsed.png 一屏 12 组头代替 99 行乱流 + 计数对账 99 无丢失（CHANGELOG v4.0 未发布节）
