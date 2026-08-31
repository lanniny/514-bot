# handoff：tab「异常宽」真根因修复（grid 行模板错配）

- 时间：2026-07-20
- 范围：`apps/control-center`（public/styles.css、tests/social-orchestration.test.mjs）
- 触发：LO「tab 异常宽…还是没有解决」并贴 conversation-heading DOM

## 根因（实测取证，非猜测）

上一轮修的"长标题 ellipsis"是真 bug 但不是 LO 这个。实测：`.conversation-pane` 的 grid 行模板只有三行（会话头/会话流/composer），tab 波次在 DOM 头部插入了 conv-tabs 和 member-strip 两个子节点却**没同步行模板**——member-strip 落进 `minmax(240px, 1fr)` 弹性行被拉成巨带，会话头与会话流全被挤歪。修复：行模板改 `auto auto minmax(54px,auto) minmax(240px,1fr) auto` 与 DOM 同序。

## 验证

- 修复前截图巨带 vs 修复后四段紧凑连续（tab 41/成员条 44/会话头 54/流 336px，坐标实测）；qa:ui ok:true。
- 负载敏感测试（ask round cap）：今日 2/20 次全量下抖一次"run did not finish"（回答后未终态），waitTerminal 已埋全相位 dump（status/round/pendingAsk/pausedForInput/pendingSteer/resumeQueue/controllers/executions/attempts）——下次抖动一次定位；安静期 6/6 全绿（160/160）。

## 教训

- **grid 容器插子节点必须同步行模板**（进自检清单）。
- **修 UI 先实测再开方**：凭经验判根因（ellipsis）治了别的病；贴 DOM 后先量元素宽度找真凶。

__DELTA__: 主驾(Kimi) | 2 | 证据：我上一轮"tab 宽=长标题 ellipsis"的根因判断被 LO「还是没有解决」推翻——实测坐实真根因是 conversation-pane grid 行模板错配（styles.css grid-template-rows）
