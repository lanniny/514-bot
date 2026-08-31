# 协作台工程逻辑收口：hero 撤排 + 控件收编 + 栅格重分配（Kimi → all）

> 时间：2026-07-26 · 主驾：Kimi · 范围：apps/control-center 协作台 + forge 主题
> 触发：LO「没有达到我的预期效果布局还是太乱了没有工程逻辑」

## 一、诊断（截图亲查 + codeg 源码取证）

Playwright 截 01-workbench-light 亲见五处乱源，对照 codeg `src/app/workspace/layout.tsx` 的工程纪律（**一面板一职责一标题；重复信息只在一个 chrome 层出现；主内容 ≥64% 宽**）：

1. 视图内 hero 行（eyebrow + h1「协作台」+ 营销文案）与全局面包屑「协作 / 协作台」重复；其右侧 CLI 脉搏条与全局状态栏 `global-team-pulse` 完全重复——同一屏「协作台」出现两次、CLI 芯片出现两次。
2. 团队 pane-heading 一行挤 7 控件（4 筛选 toggle + 设置钮 + 计数 + 标题）。
3. composer 四行 chrome 堆叠（bookmarks / hint / textarea / footer）。
4. 栅格 rail 232 / MC 312，会话区被两侧挤（codeg aux 仅 18%）。
5. 暗色 `--rose-fill` 族泄漏：styles.css 暗色块未定义（继承亮主题 `#b4234d` 玫瑰红），tokens.css 亮 bridge 有、暗 bridge 漏。

## 二、处置（全部覆盖式，styles.css 存量零改动）

| # | 乱源 | 处置 | 落点 |
|---|------|------|------|
| ① | hero 行 + 脉搏重复 | CSS 隐藏 `.workbench-heading` 文字块与 `#workbench-team-pulse`（DOM 保留，aria-labelledby 不受影响），只留 run 状态徽标 | forge/workbench.css 工程逻辑波段 |
| ② | 团队标题 7 控件 | 4 toggle 移入 `.rail-filters` 折叠行（默认收起，`514cc-rail-filters-open` 记忆）；筛选非默认态时按钮常驻高亮；新图标 lucide `list-filter`（vendor 清单 +1 重生成 97 symbols，0.511 的 filter 已更名 funnel） | index.html + workbench-chrome.js `bootRailFilters` |
| ③ | 栅格比例 | 216 / minmax(420,1fr) / 288（原 232/312） | forge/workbench.css |
| ④ | composer 四行 | hint 行 DOM 搬入 bookmarks 行右端（byId 引用全保）；会话标题行 54→44 | index.html + workbench.css |
| ⑤ | 暗色玫瑰泄漏 | tokens.css 暗 bridge 补 `--rose-fill: #d97757` / `--rose-fill-bright: #e8916f` | forge/tokens.css |
| ⑥ | statusline 挤行 | rail statusline padding/字号收紧 | forge/workbench.css |

## 三、走查陷阱（后人勿踩）

qa-v4-shots.mjs 暗色首截 `13-workbench-dark` 在 reload 后**视图持久化恢复**到启动器页（名不符实）；目录里旧档 `08-workbench-dark.png` 是历史脚本版本残留（粉色暗态=换血前旧图）。本轮初判「暗 bridge 整段不生效」即被旧图误导，复核新截图后确认暗色铜橙早已生效，`--rose-fill` 补坑为真实缺口但非整段失效。**截图走查必须以当轮新文件为准，旧档即删**。

## 四、验证

- `npm test` 480 pass / 0 fail / 1 skipped；`npm run validate` valid。
- 探针 `scripts/qa-v4-wave4-probe.mjs` 三截亲查：暗色真协作台（铜橙全净）、筛选行开合（暗/亮各一）、composer 合并行；21 站全量明暗 0 控制台错误。
- 筛选行开合为持久化 toggle——探针暗/亮两次点击互抵恰证实记忆生效（非失效）。
- 纯静态资产变更（server.mjs 未动），桌面端 Ctrl+R 即生效，无需内核重启。

__DELTA__: Kimi | 1 | observability | 证据：qa-v4/22-workbench-dark-true.png 暗色铜橙全净 + 协作台五处乱源收口（CHANGELOG v4.0 未发布节）
