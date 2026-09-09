# 壳层刷新：侧栏隐藏 + 设置坞 + 协作台聊天化

- 日期：2026-09-09
- 作者：烛（Claude，主驾）
- 状态：完成，QA 9/9 全绿 + 回归 175/175 全绿
- source_request：LO 双图需求（侧栏重构 + 协作台聊天体验优化）

## 交付内容

### 一、侧边栏重构

1. **桌面隐藏左侧栏**：`public/forge/shell-refresh.css`（新文件，index.html 最后加载）。
   - 关键优先级战场：product-shell.css 用 `html body.atelier .app-shell:not(.nav-open) #sidebar { display: flex !important }`（ID+3类，(1,3,2)）强制显示。压制必须用**同级或更高选择器 + 更晚加载**：`html body.atelier .app-shell:not(.nav-open) #sidebar, html body.atelier .app-shell.nav-open #sidebar { display: none !important }`。低优先级选择器（如 `html body.atelier .sidebar`）写多少 !important 都无效。
   - 栅格同步改单栏（`"topbar" "main" "statusbar"`）；设置表面设置轨升左栏（232px）。sidebar 的 `grid-area: sidebar` 残留会因 display:none 自动退出布局（否则会产生隐式轨道幽灵列——排查时见过 `1264px 0px 176px` 三轨怪象）。
   - 移动端 ≤820px 抽屉行为不变（媒体查询只盖 ≥821px）。
2. **导航迁移设置配置面板**：nav-config.js `renderNavigation` 新增第四个挂载面 `data-nav-surface="settings"`（index.html 设置轨 `#settings-destinations` 顶部），NAV_GROUPS 单一真源渲染为 `.settings-rail-item` + 组标签——全局 `[data-view]` 点击委托直接可用，搜索过滤/激活态同步自动生效。功能零遗漏（QA 逐项断言 15 个视图 + 8 个原设置项）。
3. **左下角设置坞**：`#settings-dock` 固定 bottom-left（statusbar 上方），药丸按钮 + 齿轮悬停旋转。app.js 接线：点击开 `config` 视图、设置表面内再点返回进入前视图（`state.dockReturnView`）。两个让位规则：设置面板展开时坞隐藏（设置轨即导航）；bot 视图坞隐藏（roster 底部已有同源设置入口，避免重叠）。
4. **设置面板内部回归纵向轨**：config-workspace.css 现行设计是「顶栏下横向目的地条」（flex row + overflow-x），15 个迁移项放进去被横向裁剪不可达（QA 点击被 rail 拦截实证）。shell-refresh.css 覆盖回纵向：rail column 布局、搜索常驻、nav 垂直滚动、topology tabs 垂直堆叠、列表项 hover/active 态、账户区沉底。

### 二、协作台聊天化

1. **过程默认收纳**：`modules/bot-activity-timeline.js` 的 `botActivityGroupMarkup` 从 `<section>` 改 `<details>`（默认收合），摘要行「协作过程 · 思考、工具调用与文件改动已收纳——点开核对 · N 位 · M 条」。消息流直接呈现最终结果气泡；点开摘要才展开时间线（内部 segment 仍是 details，二级收纳）。`reconcileMessageMarkup` 对 DETAILS 保留 open 态，流式更新不打断用户展开。
2. **气泡深度美化**（shell-refresh.css，全走既有 Forge/Bot 令牌，暗色自动跟随）：16px 大圆角 + 方向性尾巴角（agent 左上/user 右上 5px）、细腻双层投影、悬停阴影加深、头像悬停放大、时间戳默认低调悬停全显、分组连发间距收紧、消息入场 fade+slide 动效（prefers-reduced-motion 降级）、输入区聚焦浮起。

## 排查方法沉淀（CSS 层叠战争）

- 精确级联探针：page.evaluate 里遍历 `document.styleSheets` 的 cssRules，用 `el.matches(rule.selectorText)` 过滤命中某元素的规则，输出 sheet/媒体/选择器/声明/优先级——一次跑清所有竞争者。**坑**：CSS Nesting 时代 CSSStyleRule 也有 `.cssRules` 属性（嵌套子规则），walker 必须用 `!rule.style && rule.cssRules` 判断分组规则，否则全部规则被当组递归、叶规则永远漏检。
- `getComputedStyle().gridTemplateColumns/Areas` 的对照能立刻区分「哪个声明赢了」：areas 是我的、columns 是三轨 → 对手用 grid-area 制造了隐式轨道。

## 验证

- QA：`node scripts/qa-shell-refresh.mjs` 9/9 全绿，5 截图（`.qa-output/shell-refresh/`）：①bot 无侧栏 ②非 bot 视图坞可见 ③设置面板纵向轨+迁移导航 ④聊天气泡+过程收纳 ⑤过程展开。
- 契约：`tests/bot-shell-ui.test.mjs` 新增 shell-refresh 测试（侧栏隐藏规则/栅格/迁移面/坞接线/details 收纳/气泡美化/降级动效），nav-config 四面挂载断言。
- 回归：17 文件 175/175 全绿，clean-exit ok。

## 注意事项

- sidebar DOM 保留（aria 契约：`id="sidebar" aria-label="主导航"` 必须在 HTML），仅 CSS 隐藏——既有测试契约不动。
- bot 视图左下角入口 = roster footer 的「设置」按钮（既有，data-workspace-view="config"）；全局坞覆盖其余视图。
- 用户气泡浅色是改前既有行为（bot-workspace 等层覆盖 --bot-user-bubble-bg），非本轮回归。
