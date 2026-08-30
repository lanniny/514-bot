# PM 全产品走查 + 玻璃质感统一补齐（v9）+ 可用性缺陷修复波

- 执行者：烛（ZCode 运行时，AEMEATH 面）
- 时间：2026-08-30 15:00 ~ 19:25（UTC+8）
- 依据：LO 指令「以产品经理+使用者双视角深查产品缺陷：功能是否完善/有用/顺手，逐项优化使用逻辑，查漏补缺；很多模块玻璃质感缺失需统一补充」
- 说明：本会话无 route-gate 注入 session marker，按契约省略该行。

## 一、方法论：不念功能清单，用证据走查

- **逐视图实拍走查**：`scripts/qa-pm-walk.mjs`（新增）——隔离 fixture + 程序生成的高饱和渐变壁纸激活壁纸态，14 个视图逐张 1440×960 实拍 + 关键交互态（抽屉/对话框/命令面板），逐张人眼审。
- **玻璃审计**：`scripts/qa-glass-audit.mjs`（新增）——壁纸态下逐视图扫描「大面积且几乎不透明」的表面（元素自身/::before/::after，含渐变底，覆盖 oklch/color/rgba 格式），按面积输出权威清单。修复前 40+ 处违规面，修复后**全部视图清零**（唯一保留：security 的终端语义暗色日志窗）。
- 两个探针均入库 scripts/，后续任何 UI 波可复跑作对照。

## 二、玻璃质感：根因分层，不是「哪里漏补哪里」

审计 + CDP 取证把「玻璃缺失」拆成三层真因：

1. **系统性静默失效（最深一层）**：外观面板玻璃底色选「auto」时 `--glass-tint` 为 guaranteed-invalid（空）——这在 CSS 里 var() 回退链本应正常，但组合 color-mix 后部分元素出现「匹配的高优先级规则算出全不透明」的反直觉结果（composer-shell 悬案：规则命中、公式在同级作用域实测有效、无内联、无 !important、无 @layer，computed 仍旧实底；CDP 证据链存档，最终以状态覆盖层 `!important` 收口）。**教训**：v7/v8 的玻璃配方是静态源码契约测试（源串匹配）验的，从不在运行时验 computed 值——契约绿 ≠ 生效。
2. **特异性战争**：experience-polish 的 `:is(#view-overview,…)` (1,1,0)、overview.css 双 ID (2,1,0)、data.css `#config-surface-sources *` (1,1,0)、automations.css `#automations-workbench .auto-card`——设置族大面全被这些 ID 级实底规则压住，类级玻璃规则（含 v8 已有的）永远输。v9b 按对手口径镜像镜像选择器（`html body.team-bg-active :is(#view-*) .content-section` 等）。
3. **真漏补**：settings-rail、channel-deck、memory-browser、guardrails-tester、sshconn-list、runtime-seat-layout/index、security-posture、auto-card、delta-timeline、team-panel、metric-card::before、bot-conversation-header、page-heading 铜线（不透明铜条浮壁纸像碎屑→退薄纱）——v9 统一吃 `--forge-card-alpha` 令牌配方（大面 72% / 子卡 42% / 输入 84%），落在 team.css（壁纸态覆盖层的家）。

**落点**：`forge/team.css` v9 + v9b 两节（含根因注释与对手口径）；验证 = qa-glass-audit 全视图 0 违规 + 逐视图实拍复检。

## 三、使用逻辑缺陷（按走查优先级全数落地）

| # | 缺陷（走查实证） | 修复 |
|---|---|---|
| 1 | **桌面端 14 视图无全局导航**：`experience-polish.css` 一块无条件 `!important` 把汉堡/抽屉/背板全域休眠，topbar-nav 窄屏与 bot 表面隐藏，「视图」菜单里没有视图——全局入口只剩 Ctrl+K。抽屉机制（fixed+translateX）在 codex-desktop 是现成的，只是被休眠 | 汉堡全尺寸常显；休眠块改为「仅抽屉关闭态隐藏」（nav-open 滑出、背板交还 [hidden] 语义）；「视图」菜单加 14 视图导航（NAV_GROUPS 单源驱动）；bot 表面维持无 chrome。Playwright 端到端验收：汉堡→抽屉→点选→切视图 ✓（`drawer-open.png`） |
| 2 | **门闩拦截不可操作**：渠道页红字「读取失败：…（v4.0 Wave G 已落地）」——既说落地又说 blocked，且无放行入口（判定只看 message 文本漏掉 payload code） | 判定补 `error.code === "REMOTE_GATE_BLOCKED" \|\| status===501`；空态改为「这是还没开不是坏了」+ 直达按钮「到安全诊断放行」（data-view 委托）+ 授权后重试 |
| 3 | **安全页渲染 `undefined`**：权限策略行「禁止写入 · shell undefined · 网络 undefined」 | `describePermissionFlag` 对 undefined/null/空返回 null，行级 filter(Boolean)，全缺省时「未标注」 |
| 4 | **观测页大字溢出**：指标值统一 display 大字，「未知 / 未知 / 未知」三行挤爆卡片 | `setMetricValue` 统一入口：数值短值保留大字，词值自动降级 `metric-word`；art-direction 收口 `.metric-value.metric-word` 尺寸例外（该文件最后加载，Own 例外） |
| 5 | **面包屑分组漂移**：team 面包屑「Agent 能力」、导航在「协作」；手写 FORGE_VIEW_GROUPS 与 NAV_GROUPS 两张皮 | FORGE_VIEW_GROUPS 改由 NAV_GROUPS 反推（toolkit 视图保留手工条目）；observability 特例删除，面包屑跟导航组走 |
| 6 | **空态文案误导**：bot 会话列表零会话时显示「没有匹配的对话」 | 文案跟随语义：有搜索词「没有匹配的对话」，否则「还没有对话——点左上角 + 开始」；通讯录同理 |
| 7 | **命名错位**：导航/设置轨叫「使用统计」，页面 h1 叫「系统总览」 | 统一为「系统总览」（nav-config 已是，改设置轨静态条目 + tooltip 补语义） |

## 四、验证

- `qa-glass-audit`：12 视图 × 大面不透明清单 = **0**（仅存 security 暗色日志窗，终端语义有意保留）。
- `qa-pm-walk`：14 视图实拍 + 抽屉端到端断言 + 零页面错误（`.qa-output/pm-walk/`）。
- 契约测试：sidebar-nav-ui（旧「不放左侧入口」契约按新决策改写并加负断言）、chrome-menus-contract（视图菜单单源驱动断言 + 定窗放大）、automations-page（FORGE_VIEW_GROUPS 单源断言）——82/82 绿。
- `npm run ui:lint`：无新增违规。
- `npm test` 全量 1902：1889 过 / 11 fail——**10 个为已知波动与既有家族**（title-glyph 属上轮 index.html WIP；其余 real-git fixture / SSE backpressure / bus lease 轮换族，隔离复跑绿）；本轮无新增确定性失败（automations-page 一过性失败已随契约同步修复）。

## 五、遗留与下一步（走查发现、本轮未做，按优先级）

1. **协作星图黑板**：亮色主题+壁纸态下是整块黑板，与玻璃语言冲突——疑为有意的「星空」视觉系统，**待 LO 拍板**（改玻璃/改深灰/保留）。
2. **设置轨信息架构**：rail 分组（基础设置/Agent 能力/协作/创建/数据与统计/进阶）与 NAV_GROUPS（协作/创建/观测/资源/治理）两套分类学并存，产品页（观测/会话/渠道）混在「设置」轨——建议下一轮 IA 收口。
3. **模板卡 ◆ 菱形装饰**语义不明（像未完成占位符），建议换成成员脸或删除。
4. **观测页「无日志/未知」密度**：8 卡全空的空态仍占一屏，可折叠或聚合为一行摘要。
5. composer-shell 的 color-mix 反直觉失效悬案（CDP 证据在案）值得让 Chromium 侧或 CSS 工作组视角复核一次；当前以状态层 !important 收口是工程正解但非根因解释。

__DELTA__: 烛(Claude) | 1 | 证据：forge/experience-polish.css:427 无条件 !important 隐藏块把汉堡/抽屉/背板全域休眠，14 视图桌面端唯一全局入口只剩 Ctrl+K——「视图」菜单里甚至没有视图；W2.5 建好的全尺寸抽屉机制是死的
__DELTA__: 烛(Claude) | 2 | 证据：team.css v7/v8 玻璃配方（body.team-bg-active .task-composer .composer-shell 等）运行时静默失效——规则命中、公式同级实测有效、computed 却是全不透明实底（CDP 取色 + 变量作用域探针在案），静态源码契约测试全部绿但用户看到的是实底；「契约绿」与「运行时生效」之间缺一层 computed 验证，qa-glass-audit.mjs 补上这一环
## 六、续篇（同日傍晚，LO「继续」授权按判断落地遗留项）

1. **44 处丢分号静默吞声明**：styles.css 内 `color: var(--accent-ink)` / `border-color: var(--accent)` 等声明行缺分号——CSS 解析错误恢复会把**下一条声明一起吞掉**（88 条规则半残），赤陶点睛色/强调边框从未生效。机械修复 44 处（扫描器：声明行以 `)` 结尾且下一行是属性声明）。欢迎语「晚上好」点睛色、卡片强调边框自此真实生效。`.route-model::before` 同款一并修。
2. **◆ 菱形占位符**：`.empty-state strong::before` 的 ◆ 本是 sprite 渲不出的兜底装饰，但 welcome-state（picker/模板卡）自带图标宿主，再叠 ◆ 像未完成占位符——收窄为 `:not(.welcome-state)` 只对裸空态生效。
3. **协作星图黑板 → 深色玻璃（v9c）**：art-direction 96% 墨色实底在亮色页面+壁纸态是死黑板；壁纸态改墨色 78% 透明 + 磨砂（夜空身份保留，壁纸从星空后透出），非壁纸态维持原基线。
4. **设置轨 IA 对齐**：分组从「基础设置/Agent 能力/协作/创建/数据与统计/进阶」两套分类学，重构为与主导航 NAV_GROUPS 同构（基础设置/协作/创建/观测/资源/治理/Agent 能力）；自动化升入设置轨治理组；「插件/市场」同目的地只留「市场」一个名字。rail 搜索过滤动态适配分组，契约断言同步改写。
5. **observability 面包屑特例**：forgeViewGroup 的 observability 分支在 NAV_GROUPS 单源化后仍返回「数据与统计」，删除特例跟导航组走（观测）。

验证：qa-pm-walk 端到端 + 零页面错误；契约 85/85；ui-lint 无新增；全量套件 1891/1902（9 失败均为既有/波动族，与上轮同分布轮换）。

__DELTA__: 烛(Claude) | 1 | 证据：设置族大面被 :is(#view-*)/#config-surface-sources 类 ID 级实底规则压住，v8 类级玻璃规则无论怎么写都输——玻璃缺失不是「漏写规则」而是「特异性战争」，补齐必须按对手口径镜像选择器
__DELTA__: 烛(Claude) | 2 | 证据：styles.css 44 处声明行丢分号——CSS 解析错误恢复吞掉下一条声明，赤陶点睛色/强调边框从未生效过（欢迎语 hero-accent、route-model 同款）；此前所有视觉走查都在「半残样式」上进行，这类解析级静默缺陷应进 qa 探针（声明级解析校验）
