# 514cc Console — 视觉设计方向（暗夜玫瑰 · 仪表指挥台）

> 2026-07-17 重设计。目标：从"浅色通用后台模板"→"暗夜玫瑰仪表指挥台"，达到 LO 要求的"非常精美"。

## 主题（thesis）
Console 是 LO 的多 agent 体系的指挥甲板——洛琪希（水王魔术师）工坊的控制台。
参考主流设计语言：**Linear**（暗色精密 + 微妙渐变纵深 + 一流排版）、**Raycast**（命令面 + 玻璃质感）、
**Vercel/Geist**（发丝级分隔线 + mono 数据美学），但铸成独一无二的 **暗夜玫瑰** 身份——
不可与任何一个混淆。

## Token 系统
- **底**：深墨底带紫玫瑰暗调（非纯黑——纯黑是 AI 默认陷阱）。void→bg→surface 三级纵深。
- **玫瑰（签名色）**：#E0184D（呼应 statusline 红瞳红）+ 亮玫瑰 glow + 深玫瑰填充。
- **水（洛琪希元素，克制）**：#3FE0C4 只用于 online/生命信号——冷水对暖玫瑰，题材自洽非装饰。
- **琥珀**：#F0B429 只用于 warning，罕见。
- **字**：Segoe UI Variable（显示/正文）+ **Cascadia Code**（数据/mono 签名脸——终端母语=体系世界的原生话语）。

### Token 单一真源（2026-08-30 W2.1 归并后）
- **唯一真源 = `forge/tokens.css`**：Forge OKLCH 主段 + Legacy bridge 段（styles.css 旧变量族的唯一颜色定义处，亮/暗两套齐备）。
- **`styles.css` 头部 :root 只允许布局尺寸与字体栈**（--activity-width/--sidebar-width/--mono/--sans 等），**禁止再定义任何颜色/阴影/圆角/语义别名令牌**——旧"styles 定义→forge 后加载覆盖"的双源模式已拆除，写进 styles.css 的颜色从此真的会生效，没有安全网。
- 新增颜色语义一律进 tokens.css（亮/暗两段都要给值），组件侧只消费 var()。
- 工程预算（W2.2）：**新代码只进 `public/modules/`**；`app.js` 只减不增（v4.0 波次已按此执行：closeout/artifact/notifications 均为独立模块）。

## 签名元素
- 指标卡→**仪表读数**：mono 巨号数值 + 顶部玫瑰光线 + 玫瑰 mono 标签。
- 组件健康→**舰队花名册**：agent 带状态光晕（aqua glow=online / 玫瑰脉冲=active / 暗=offline）。
- 玫瑰左光条 = 当前导航；玻璃暗顶栏；发丝玫瑰分隔线；实时事件脉冲。

## 落地
token 驱动（277 处 var）→ 重写 :root 自动流转全站 + 末尾精修层（refinement layer）提升关键组件质感 + 修事件表列碰撞 bug。

## 已交付（2026-07-17）
- **:root 翻转**：浅色通用模板 → 暗夜玫瑰三级纵深（void/bg/surface）+ 玫瑰签名 + 水色生命信号 + mono 数据脸 + body 双辐光氛围。
- **签名组件**：指标卡=仪表读数（mono 巨号 + 顶部玫瑰光线 + hover 玫瑰辉光上浮）；品牌标玫瑰渐变发光；导航玫瑰左光条 + 玫瑰图标；玻璃暗顶栏（backdrop-blur）。
- **状态语义**：online=水色辉光点（洛琪希元素）/ warning=琥珀 / error=玫瑰；DELTA 账本徽章 2(推翻)=玫瑰、1(补强)=琥珀——最高影响发签名色。
- **真 bug 修复**：①事件表 类型/主体 列碰撞（全列 overflow 裁剪，类型玫瑰/主体水色 mono）②配置中心代码编辑器刺眼纯白 → 深墨终端面 ③全部表单控件（textarea/select/search）深色 + 玫瑰聚焦环 ④浅色徽章边框（amber/red/violet 粉彩）→ 暗色语义 rgba。
- **验证**：跨 4 页实拍（总览/配置/体系观测/协作台）一致；CSS 大括号平衡 401/401；token 驱动保证路由/安全页同步。
- **参考语言**：Linear 精密暗色 + Raycast 命令面玻璃 + Vercel 发丝数据美学，铸成独一无二暗夜玫瑰身份（不与三种 AI 默认审美混淆）。

## IA 重构（2026-07-17 · 对话优先三区制）
> LO 反馈"界面不合理、对用户不友好"→ 调研 Cursor/Claude Desktop/Codex 真实前端（三路一致：**无一用仪表盘做落地页**，全是对话优先三区制）。这一轮改的是信息架构，不是配色。

**核心错配（旧）**：7 个扁平顶层 tab 平权竞争，落地页是"系统总览"仪表盘（4 指标卡+健康+事件表，首屏无 composer）。用户打开第一个动作是"读数"而非"发起工作"——反成熟范式。

**IA 反转（新，对标 Cursor Agents Window / Claude Code 桌面版 orchestrator seat）**：
- **落地页 overview→workbench**：打开即对话工作区（任务列表 | 会话流+composer | 上下文栏），首屏可见 composer（"描述要规划/实现/审查/调研的目标"）。
- **7 扁平 tab → 三级层级**：协作台=一等工作面（玫瑰发光主卡，视觉高于其余）；**观测**组（系统总览/体系观测/会话聚合）+ **配置**组（配置中心/模型路由/安全诊断）降为带分组标签的次级导航。
- **保留不删**（Cursor 3 激进转 agent-first 曾激怒老用户的教训）：配置/观测降级但仍可达，非删除。
- **移动端**：mobile-nav 协作置首 + 补回观测/会话（旧版移动端丢失这两项）。

**为什么是重新挂载而非重写**：协作台内部早已是成熟对话三栏（run-rail/conversation-pane/context-rail），render 函数解耦——改的是默认视图 + 导航分组，零渲染逻辑重写。改动点：index.html 导航重组+3 处 is-active 翻转、app.js state.view+start() 默认 workbench、styles.css nav-group-label/nav-primary。7 视图 Playwright 实测全可切、composer 首屏可见、无 JS 错误。

**后续可深做（未做，留 roadmap）**：命令面板（Cmd+K 万能入口）、审批内联进会话流（对标 Keep/Undo）、DELTA/handoff 走 Artifact 式"对话出卡→右侧展开"、sessions 并入 run-rail 统一脊柱、composer 内路由档 picker（对标 Shift+Tab 模式切换）。依据：调研 takeaways（Cursor/Claude Desktop）。

## 双主题与体检修复（2026-07-18）
> 全面体检（Playwright 7 视图 × 桌面/移动/平板实拍 + 代码审计）后的综合优化轮。

- **暗色「暖墨」主题回归**：v1 暗夜玫瑰 → v2 暖纸单色之后，改为**双主题令牌架构**——`[data-theme="dark"]` 只翻 :root 令牌（约 40 个 var），零组件规则改动。关键手法：白字填充与文字色解耦，新增 `--rose-fill/--rose-fill-bright/--red-fill` 固定浅色填充令牌（暗色里 `--rose` 提亮为文字色 #d97a52，填充不跟动）；主题切换不闪屏——`theme.js` 为 `<head>` 同步引导脚本（CSP script-src 'self' 禁内联，故独立文件），app.js `initializeTheme()` 管持久化（localStorage `514cc-control-theme`）与系统偏好跟随。
- **焦点框修复**：切页焦点迁移到 h1（屏幕阅读器宣读锚点，tabindex=-1 不进 Tab 序）曾被全局 `:focus-visible` 画出紫色矩形框——`.view h1:focus { outline: none }` 压制，真实交互元素的焦点环不受影响。
- **配置源徽标**：`format.slice(0,4)` 截出 MARK/PYTH 残词 → 可读缩写表（MD/PY/JSON/JSONL/YAML/TOML…）+ 徽标自适应宽度。
- **状态栏豆腐块**：rail-statusline 的 nerd-font 私用区图标（U+F024B 等）在无该字体环境渲染为 □ → 换通用字形（◆/📁/∑/◈）。
- **加载/失败态**：会话聚合首次进入白屏数秒（fetch 完成前不渲染）→ 先画加载态；失败后曾永远停在"正在扫描" → 显式失败文案 + 指向「重新扫描」；体系观测三表初始空表头 → "正在读取…" 占位行，加载失败 → 行内失败文案。
- **QA harness 修复**：qa-ui.mjs 的 `[data-view]:visible` 选择器命中屏外抽屉按钮（三套导航并存后）导致桌面用例恒超时 → 改 DOM 可见性过滤的 clickView()。
- **验证**：qa:ui 全套（layout + workbench 状态机）0 错误；node --test 90/90；暗色桌面/移动/平板实拍无横向溢出、无 JS 错误。

## 协作台人文美化波次（2026-07-19）
> LO 指令："总体对协作台页面进行前端完善，尽量美观"。纯追加式 CSS（styles.css 末尾新区块，同优先级后声明覆盖）+ app.js 两处结构类名，零重写。

- **消息流分层**：头像去框改 9px 圆角柔底（LO=rose-soft 暖底玫瑰字）；LO 消息加暖纸便签气泡（surface-muted+border+12px 圆角，`is-user` 类由 messageMarkup 新增）；正文 12.5px/1.7；时间戳改等宽 10.5px；轮次分隔线粗虚线→细实线。
- **空态仪式化**：会话空态主标题衬线 19px + 赤陶 ◆ 装饰点（sprite `#icon-workbench` 在该处渲不出，隐藏 svg 换纯 CSS 装饰，零依赖）。
- **会话头**：标题衬线 15px，run 元信息等宽 10.5px 柔灰。
- **右栏**：分组标签统一 11px/620/0.08em 字距小灰字；路由模型名前加 ◆ 点缀；拓扑节点卡片化（10px 圆角+shadow-low）；时间线事件名/时间等宽化；失败/拒绝/丢弃类事件圆点标红（`is-alert` 类由 renderWorkbenchEvents 按事件名正则判定）。
- **左栏**：选中态统一 2px 赤陶 inset 竖条（Claude 侧栏式，作用于 rail-run-button/team-option/session-link）。
- **已归档灰盒修复**：`.archived-toggle` 是 `<button>` 但全局无 button 背景/边框重置，UA 默认灰盒外露（亮色黑框、暗色灰块）——补无框重置 + hover 文字加深 + chevron 展开旋转 90°。
- **全局**：焦点环冷蓝→赤陶；协作台滚动容器细暖滚动条（8px、padding-box 裁切）；暗色 `--text-soft/--border` 提亮半档；暗色 composer 悬浮阴影改纯黑（原暖灰在暗底不可见）。
- **验证**：qa:ui --suite=all 0 错误；node --test 113/113；亮/暗 × 桌面/移动 + 空态实拍复核。

## Codex 式左栏 + 原生会话全量右键菜单（2026-07-19）
> LO 指令：置顶区独立上移、右键会话补全 Codex 式 11 项、左栏布局对标 Codex。

- **左栏新顺序（Codex 式）**：团队 → **新建任务**（新增全宽入口行，与 + 同走 openSessionDialog）→ **置顶** → 会话 → 正在工作 → 项目 → 已归档 → 状态栏。
- **置顶区三实体混排**：置顶 run（原有）+ 置顶项目（从项目树迁出，不再树内置顶排序）+ 置顶原生历史会话（新增）。置顶项目行复用 project-toggle 样式、点击内联展开会话（展开态独立存 state.expandedPinnedProjects），右键走项目菜单。区高上限 34% 自滚。
- **会话级偏好**：原生历史会话的置顶/归档/未读/别名持久化进 project-prefs.json 新增 sessions 映射（键 `projectId::sessionId`）；服务端 PUT /api/projects/prefs 扩展白名单清洗（pinned/archived/unread/alias，旧文件无 sessions 键向后兼容）。
- **原生会话右键 11 项**（对齐 run 菜单）：置顶/重命名/归档/标记未读 + 资源管理器/复制工作目录/复制会话ID/复制恢复命令/复制深度链接 + 新任务继续/新工作树继续/新窗口打开（保留原有「查看会话」「复制恢复命令」）。归档会话从项目树消失、落入左栏「已归档」区（与归档 run 混排，可取消归档）；打开预览自动销未读；别名覆盖显示标题（tooltip 与预览标题联动）。
- **会话深度链接**：`#token=…&session=<projectId>::<sessionId>`，initializeAccessToken 解析、loadProjects 完成后一次性消费打开预览；「在新窗口中打开」「复制深度链接」均走此格式（run 深链 #run= 原有不变）。
- **附带验证**：时间线失败/拒绝/丢弃事件红点（is-alert）实拍确认；QA 交互脚本（右键菜单 13 项断言、置顶会话/项目/内联展开/归档落区）全过，0 JS 错误。
- **验证**：qa:ui --suite=all 0 错误；node --test 114/114（新增 tests/project-prefs.test.mjs 端点清洗+回读用例）；亮/暗实拍复核。

### 项目行悬停「写」图标（2026-07-19 追加）
- 项目树与置顶区项目行尾新增悬停浮现的铅笔按钮（`.row-action`，图标复用 MENU_ICONS.rename）：点击即在该项目目录下进入新任务模式（pendingCwd=project.path，跳过选址对话框），无路径项目禁用。
- 结构：project-toggle 外套 `.project-row` flex 容器（按钮不能嵌套按钮）；opacity 0→1 由 hover/focus-within 触发，触屏 `@media (hover:none)` 常显。
- 验证：Playwright 断言 opacity 0→1、点击后 composer cwd 芯片指向项目、会话头回「新任务」、0 JS 错误；qa:ui --suite=all 0 错误。

## 多 CLI 项目树：Claude/Codex 会话统一入口（2026-07-19）
> LO 需求：项目树下能看到团队所有 CLI 的会话入口，一个项目下分 Claude 会话 / Codex 会话。

- **后端归并**（sessions.mjs `projects()`）：claude 扫描之外新增 `#mergeCodexProjects`——`~/.codex/sessions` 递归 rollout（cap 400 最近文件），逐文件流式提取 `session_meta.payload.cwd`（`cwdFromLine` 兼容 payload 形态），按 `normalizeCwdKey`（与前端 normalizePathKey 同口径）归并：命中 claude 项目 path 的挂入（`cli:"codex"` + scope + 短 label `MM-DD HH:mm`），未命中合成 `codex-<slug>` 项目。逃逸 symlink 不读不列（与 claude 同一限根不变量）。
- **Codex 预览**：`previewCodex()` 只取 `type:"response_item"` 的 message（event_msg 是镜像，双取会重复）；user 文本剥注入样板（`# AGENTS.md instructions` / `<environment_context>` / `<user_instructions>`——`meaningfulUserText` 统一拒绝，摘要链路同受益）；与 claude preview 同纪律（双层 scrub、600 字截断、60 条上限、尾读窗口）。路由走 query 形 `GET /api/sessions/preview?source=&scope=&id=`（scope 含日期斜杠不进路径段）；reveal 同参通用化（`resolveFilePath({source,project,scope,id})`）。
- **前端**：项目树/置顶区会话按 CLI 分组（`sessionGroupsMarkup`，多 CLI 才显示 `Claude · N` 组头）；会话行带 `data-session-cli/scope`；预览/右键 13 项菜单/置顶/归档/未读/别名全部 cli 感知（偏好键升 `cli::projectId::sessionId`，深链 `session=cli::projectId::sessionId`，旧两段式兼容为 claude）；恢复命令按 CLI 分发（`claude -r <id>` / `codex resume <uuid>`，uuid 从 rollout 文件名提取）。
- **QA 不变量精确化**：摘要开关回归从"标题文本形状"改为 `data-has-summary` 属性断言（codex 日期 label 是合法非摘要标题，旧断言误伤）——隐私不变量（关闭摘要→DOM 无 summary 内容）反而更直接。
- **验证**：新增 tests/multicli-sessions.test.mjs（临时 USERPROFILE 假 home：同 cwd 合并、label/scope、样板剥离、event_msg 去重、scope 遍历 422）；真实数据实拍 2025 G题=Claude·9+Codex·10 分组、codex 会话预览 10 条消息、右键 13 项；qa:ui --suite=all 0 错误；node --test 115/115。
- **未覆盖（roadmap）**：grok（~/.grok 结构未实证，仅聚合视图列出）、gemini（~/.gemini tmp 目录名是路径哈希，逆映射不可靠）暂不进树。

### 主对话 vs 子代理会话区分（2026-07-19 追加）
> LO 反馈：列表太乱，分不清哪些是真正交流过的对话。

- **根因**：codex 编排会为每个任务派生多个子代理 rollout（本机实测 26/302），与主对话混排，标题又都是「会话 xxxx」。
- **后端**：`codexMetaFromLine` 从 session_meta 提取 `thread_source`/`source.subagent`/`agent_nickname` → 会话带 `subagent` 布尔与 `nickname`（scrub 后）。
- **前端**：左栏项目头新增「子代理」开关（sessionStorage `514cc-show-subagents`，**默认关=隐藏派生会话**，只留主对话）；显示时子代理行带「子」徽标+整行降对比，标题用昵称（`Singer · 07-18 19:19`）；15 分钟内有更新的会话带绿点（活跃信号）。置顶/已归档区不受开关影响（显式用户动作优先）。
- **验证**：默认 0 派生行 → 勾选后 26 行全出、徽标/昵称正确；qa:ui 0 错误；node --test 115/115。

### CLI 官方徽标与按源作者名（2026-07-19 追加）
> LO 反馈：codex 会话也显示 Claude 的图标和名字。

- **根因**：renderSessionPreview 作者硬编码 "Claude"，头像是首字母缩写，无源区分。
- **官方徽标入 sprite**（index.html 新增 fill 型 symbol）：`#icon-cli-claude`=Claude 星芒（simple-icons/claude，CC0）；`#icon-cli-codex`=OpenAI knot（Wikimedia Commons 官方 knot 路径，viewBox 320）。
- **按源渲染**：messageMarkup 支持 `message.cli`——有徽标的 CLI 头像显徽标不显首字母（Claude 上 --rose-fill 品牌橙+rose-soft 底，Codex 用 currentColor 亮暗自适应）；renderSessionPreview 作者/meta 按 cliLabel 区分（"Codex 历史会话只读预览"）；CLI 组头加同款小徽标。
- **验证**：组头图标断言 18/18；codex 预览 author=Codex+avatar=#icon-cli-codex、claude 预览 author=Claude+星芒，实拍复核；qa:ui 0 错误。

## 团队从属层级：团队 → 项目 → 会话（2026-07-19）
> LO 需求：团队下面直接挂从属会话；创建会话时直接选团队；未选团队的项目归默认团队；项目/会话两级都能从属。

- **左栏重构**：团队区从扁平选择器改为层级树（团队 → 从属项目 → 会话），原「项目」区并入（摘要/子代理开关上移到团队头，头部两行布局 + grid 行高放开）。团队节点行=展开/收起；创建会话的团队选择在 composer footer（新增「团队」picker，与 createRun 既有 teamId 流直通）。
- **两级从属**：项目级 `teamId`（project-prefs.json projects 映射）+ 会话级 `teamId`（sessions 映射，跟随项目缺省）。未从属=默认团队（内置 514cc，显示「默认」徽标）。跨团队从属的单个会话从原项目摘出、挂目标团队下（`.team-loose-session` 再缩半级）。服务端 prefs 白名单加 teamId（≤80 字符）。
- **右键**：项目菜单/会话菜单新增「从属团队：当前名」→ 原位二级菜单（showContextMenu 记录 lastMenuPos 重开），当前项打勾。
- **兼容**：会话偏好读取回退旧两段键（projectId::sessionId，多 CLI 波次前格式），写入永远三段（cli::…）。
- **性能修复（本轮揪出的真问题）**：codex 归并 meta 提取曾是 400 文件串行 await——慢盘实测单请求 47s（QA 第三页恒超时）。改 16 路有界并发后 ~3s。qa-ui 两处硬化：waitForFunction 闭包在 CSP 下偶发 EvalError → textContent 轮询；树等待超时 20s→45s。
- **验证**：交互断言（默认归组 72 项目/从属菜单/项目迁移/会话跨团队 loose/composer 双团队选项）全过；prefs 端点测试加 teamId 断言；qa:ui ok:true 0 错误；node --test 115/115。验证产生的团队/偏好改动已清理还原。

### 移除项目可同步删除磁盘会话文件（2026-07-19 追加）
> LO 需求：点移除后可选择同步删除系统文件夹中的对应会话。

- **删除是隔离不是硬删**：`sessions.deleteProjectSessions` 把文件移入 `dataRoot/trash/<时间戳>/`——Claude 整个项目目录（safePathName+realpath 限根）+ Codex 按归一化 cwd 精确匹配的 rollout（16 路并发提取 meta），系统目录即清空，隔离区留后悔药。路由 `POST /api/projects/delete-sessions`。
- **前端**：confirmAction 新增可选复选框（带框时回 `{confirmed, checked}` 结构化结果，旧布尔调用方不受影响）；项目「移除」弹窗加「同时删除磁盘上的会话文件（移入隔离区，可恢复）」，默认不勾=原隐藏语义。勾选确认后调端点、toast 报清理数量与隔离区路径、隐藏项目并重扫。
- **验证**：tests/delete-sessions.test.mjs（临时假 home：命中移出/旁观不动/隔离区可恢复）；移除弹窗实拍（复选框就位）；qa:ui ok:true；node --test 116/116。

### 「近期」过滤：30 天无对话默认隐藏（2026-07-19 追加）
> LO 需求：默认隐藏一个月以上没对话过的会话或项目，并设开关。

- **三级 declutter 齐了**：「近期」（团队头第一个开关，sessionStorage `514cc-recent-only`，**默认开**）+ 子代理（默认关）+ 摘要（默认关）。
- **规则**：会话级 `sessionRecent`=modifiedAt 在 30 天窗口内；项目级=任一会话近期即保留（30 天全静默的整项目不进树）。作用于团队树、置顶项目展开、跨团队 loose 会话；置顶区/已归档区不受限（显式用户动作优先）。
- **实测**：开=25 项目/107 会话（真正活跃的），关=72/255 全量。
- **验证**：开关两态 Playwright 断言（计数/持久化）；qa:ui ok:true；node --test 116/116。

### codex 合成项目 id 碰撞修复（2026-07-19 追加）
> LO 实测：很多项目移除弹窗的路径都显示 G:\learn\数据结构。

- **根因**：codex-only 合成项目 id 曾用 slug 化（`codex-<slug>`），中文路径非 [a-z0-9] 字符全部塌缩——`G:\learn\<任意中文>` 都叫 `codex-g-learn`。树查找按 id `find()` 恒中第一个（数据结构），菜单/弹窗/展开/选中全串台。
- **修复**：id 改 FNV-1a 散列 `codex-<8hex>`——稳定（同 cwd 跨扫描不变）且唯一。label 仍显中文目录名，path 仍是真实 cwd，仅内部标识变。
- **回归断言**：multicli 端测加两个中文 cwd 合成项目，断言 id 形如 codex-<8hex> 且互不相同；真实数据 77 项目零重复 id；UI 右键三个 codex 项目各自路径正确。
- **验证**：qa:ui ok:true 0 错误；node --test 116/116。

## v3.6 社会模拟编排 P1：bus.jsonl + 消息驱动主循环（2026-07-19）
> LO 指令：不再强制主脑入口；每个 agent 是独立大脑，主脑是 leader；agent 间真正沟通但非强制；本质社会模拟。设计：proposals/v36-social-simulation-design.md。

- **bus.jsonl 消息总线**（src/bus.mjs）：每 run 一条追加式消息流（dataRoot/bus/<runId>.jsonl），写入即双层 scrub；BusStore 追加串行链、read、snapshot（收件人视角：发给它的+它发过的+广播+治理类，按消息粒度裁进预算）。
- **`[[msg:目标]]` 输出约定**：parseDirectives 拆分正文（发 team）与路由指令；零适配器改动（全纯文本契约）。
- **socialLoop**（orchestrator.mjs）：任务落 bus → 队列取下一个收件人 → bus 快照编织 prompt → turn → 输出落 bus → 指令路由；startAgentId 可选起始成员（主脑不再强制入口，白名单=团队成员）；同对往返>2 跳丢弃+系统注记（防互问死循环，不补队防自我续队）；guard=2×maxRounds 第二道闸；收敛后 leader 补最终答复轮。pipeline 拓扑原样共存（run.orchestrationMode 切换，默认不变）。
- **运行时 roster**：turn 完成即登记 roster.json（agentId→sessionId/cwd/心跳），写失败不打断编排。
- **入口**：composer 输入 `/social <目标>` 即社会模拟模式；`bus.routed` 治理注记让「X → Y」路由在会话流可见。
- **顺手修复**：ASSIGNMENT_SECRET 值域曾吞全角逗号连下个键名（password=x，api_key: y 中 y 漏脱敏）——值域排除空白与逗号（bus.mjs 与 sessions.mjs 同款缺陷同修）。
- **验证**：tests/social-orchestration.test.mjs（parse/scrub/snapshot 单测 + 三条 e2e：路由与收敛、startAgentId 非主脑入口、乒乓熔断）；node --test 122/122；qa:ui ok:true 0 错误。
- **P2/P3 待做**：composer「从谁开始」直选、ask/answer 挂起语义、bus 拓扑图、GET /api/roster；worktree 隔离、共享记忆、Team MCP Mailbox。

## v3.6 P2：social 扶正为默认 + 挂起问答 + bus 拓扑（2026-07-19）
> LO：社会模拟是默认内置模式，不需要主动开启；接着做 P2。

- **默认翻转**：`orchestrationMode` 缺省=social，`"pipeline"` 为显式旧拓扑；composer 不再需要前缀，`/pipeline` 留为后门。老 orchestrator 测试统一显式 pipeline（拓扑仍测）。
- **ask/answer 挂起**：`[[msg:lo]]` 落 pendingAsk；队列空且有 pendingAsk → socialLoop 跳过收敛、execute 转 `waiting_agent` + `run.waiting_input` 事件（不判终不排干）；continue 检测 pendingAsk → 回答落 bus（kind:"answer"）、resumeQueue 路由回发问者、startExecution 复跑（含 +2 轮预算）。挂起恢复全链 e2e 覆盖。
- **composer 起始成员直选**：「起始」picker（团队成员，leader 标注并默认选中）→ startAgentId 直传，主脑非强制入口在 UI 层兑现。
- **bus 拓扑**：`GET /api/runs/:id/bus` 读消息流；社会模拟 run 的会话拓扑从 bus 构图（参与者按首现、角色/发言数），取代 turnAttempts 的管线视图。
- **roster API**：`GET /api/roster` 直接读运行时 roster.json（无文件回空表）。
- **验证**：新增 2 条 e2e（默认即 social、挂起→恢复→收敛全链）；UI 断言起始 picker 六成员+leader 默认、demo run bus 拓扑三节点正确；node --test 124/124；qa:ui ok:true 0 错误。

## /model·/effort 随 agent 联动 + composer 书签 + v3.6 P3（2026-07-19）
> LO 三连：/model·/effort 随 agent 变更而变更；团队/agent 名放输入框左上角书签位；继续 P3。

- **modelOptions 目录**（config/control-center/models.json + schema modelProfile 扩展）：每 profile 声明可选模型（claude 四档/gpt-5 三档/grok 一档/其余仅默认）。orchestrator 注入 models 注册表（app.mjs 接线），/model 覆盖按**起始 agent** 的目录校验（claude 模型串给 codex 起始 → INVALID_MODEL），覆盖只作用于起始 agent 轮（run.startAgentId 目标化，不再锁主脑）。
- **前端联动**：syncModelPick 在起始 agent 变更/bootstrap 到达/renderTeams 时重建 /model 目录；/effort 是 claude CLI 专属档位，非 claude 起始成员自动收起。
- **书签条**：团队/起始两个 picker 从 footer 迁到 composer 左上角的 `.composer-bookmarks`（绝对定位贴在 shell 顶缘，tab 样式去底边框），footer 更轻。
- **P3-1 共享黑板**：`[[memo]]` 指令（parseDirectives 认 [[msg:x]] 与 [[memo]] 双形态）→ bus kind:"memo"，快照治理类恒入选——任何成员写下的事实/坑对所有后续成员可见（认知互补的载体）。
- **P3-2 build worktree 隔离**：social+build+cwd 的 run 执行前自动 `git worktree add --detach`，写盘轮 cwd 指向隔离副本（真实目录零污染；非 git 目录如实拒绝；codex app-server 常驻进程 cwd 固定为如实限制）。result.worktree + run.worktree_created 事件。
- **P3-3 Team MCP Mailbox**：维持 bus.jsonl 即邮箱；它当前只承载 direct/broadcast/ask/memo 消息与审计，不等价于持久化、版本化的 Task/Delegation lifecycle。MCP 暴露列为后续候选，不建半成品。
- **验证**：新增 3 条 e2e（目录校验与覆盖到轮、memo 黑板可见性、git worktree 写盘隔离）；UI 断言 claude/codex 起始的目录联动与 effort 收放；node --test 127/127；qa:ui ok:true 0 错误。

### 动态模型/档位发现（2026-07-19 追加）
> LO：/model 不能是静态死目录要最新模型；effort 类值不止 claude 独有，codex 等有自己独立的。

- **ModelDiscovery**（src/model-discovery.mjs，`GET /api/agents/models?agent=`，5min 缓存）：
  - codex → `codex debug models`（实证可用）：7 个模型（GPT-5.6-Sol/Terra/Luna…）+ 推理档 low/medium/high/xhigh/**max/ultra**——静态目录里的 gpt-5/gpt-5-codex 确实已过时；
  - grok → `grok models`：grok45-514（默认）/grok43-long；grok 适配器补 `--reasoning-effort`（--help 实证存在）；
  - claude → `claude models`：子命令存在但当前 OAuth 过期，如实回退静态目录（source:"fallback"，重认证后自动升级动态）。
- **effortLevels 各家独立**（models.json + schema）：claude 五档/codex 四档（静态回退，动态含 max/ultra）/grok 两档。orchestrator 校验链：动态目录 → 静态 effortLevels → claude 五档正则，max/ultra 这类新档即日出可过。
- **前端**：syncModelPick 静态先渲、动态到达升级（过期响应按当前起始 agent 丢弃）；/model 显示「GPT-5.6-Sol（默认）」式最新目录；无档位 agent 自动收起 /effort。
- **验证**：parse 单测（codex JSON/grok 文本）、动态档位校验 e2e（max 通过/ultracode 对 codex 拒）；实测三 agent 端点 source 标注正确；node --test 130/130；qa:ui ok:true。

### 子进程台账与重启孤儿收割（2026-07-19 追加）
> LO 报障：每次重启残留大量内存（nohup/codex/serena 孤儿进程堆叠）。

- **根因**：Windows 下 taskkill /F 强杀 server 时无 shutdown 钩子运行，子进程（codex app-server + 其 MCP 孙子 serena/playwright/grok-search 等）成孤儿；多次重启叠加。实测本机残留 codex models 挂起探针整树（含 serena/grok-search/ace-tool）。
- **child-registry**（src/child-registry.mjs）：spawnCommand 全系统唯一进程出口登记 {pid, image} → dataRoot/children.json（close 自动注销）；新实例拿到实例锁后 `reapPrevious()`——锁已保证旧主必死，台账 pid 全部连树 taskkill /T 清理。
- **pid 复用防护**：清理前 tasklist 比对活进程镜像名，不符即跳过（Windows pid 回收快，宁漏杀不错杀；单测覆盖镜像不符场景）。
- **清存量**：手工清掉历史孤儿树（codex models 挂起树 + open-websearch 孤儿），当前 codex/serena 归零；新 server 启动即带台账（children.json 实况验证）。
- **附带发现**：node spawn 的子进程在父死时多数会自行退出（job object 语义），真正的孤儿主要来自 shell 探针与非托管 spawn——台账覆盖的正是服务端托管子进程这条主泄漏链。
- **验证**：tests/child-registry.test.mjs（收割+复用防护+持久化回环）；node --test 132/132。

### v3.6 积压独立评审修复（2026-07-20，Cursor 主驾）
> 烛(Codex) 首次独立评审 v3.6 全部积压改动：CHANGES_REQUESTED 十致命——kimi 自测 132/132 全绿掩盖全部十条（mock 只验证"参数递到"不验证"参数生效"）。评审原文 + 修复回执：`.ai-shared/handoff/codex-to-claude__v36-backlog-review__20260720-1200.md`。

- **child-registry pid 双判据**：镜像名 + 进程创建时间（PowerShell Get-Process StartTime，批量单次探针）fail-closed；空镜像/探针超时=不可认证跳过；收割即原子清账；close() 等台账写链；v1 旧格式台账回退文件级 updatedAt 判据（过渡期不失效——同日 LO 爆内存报障根因之一）。
- **bus 安全收口**：runId 白名单只收 UUID（`../events` 路径穿越实证修复）；API 先确认 run 存在；refs 过 sanitizeForPersistence；脱敏正则收敛 redaction.mjs 单一信源（补 JSON 引号键 / Bearer 短值形态；run.turns 持久化同步收口）。
- **ask/answer 硬状态机**：ask 即停派（askRaised break）；策略硬顶下腾不出回答轮→不挂起改截断收敛；answer 分支先于 ROUND_LIMIT + resumePendingAsk 同 tick 占位（防双提交并发）；执行尾窗滞留 steer 即回答（真实根因：turn 进行中提交的回答曾进 pendingSteer 永久滞留）。
- **worktree 真隔离**：adapter 声明 `supportsPerTurnCwd`；有 worktree 的写盘轮派给常驻型（codex app-server）→ UNSUPPORTED_PERMISSION fail-closed；ensureRunWorktree 上收 execute() 入口（social/pipeline 同闸）；无 cwd 的 build 落 run.worktree_skipped 审计事件；随机后缀防同秒撞路径；save 失败回滚。
- **run 级预算闸**：costUsdTotal 累计（有回执的轮）+ budgetExhausted（单轮预算×轮上限）socialLoop 停派 + run.budget_exhausted 事件；无成本回执的 CLI 如实测不到，轮次闸兜底。
- **资产随 run 回收**：clearFinished 一并清 bus 文件（含写链收敛）/ git worktree（remove --force 失败退 prune）/ roster 条目。
- **健康检查内存治理（同日 LO 爆内存报障）**：grok-search health() 惰性化——host 未启动报 `dormant` 不再 createThread 拉起满 MCP codex 树（GB 级）；HealthService 限并发 2 + inflight 去重（探针风暴消除）。实机验证：bootstrap 后 codex.exe 零进程、server 54-100MB。
- **验证**：node --test 139/139（+9 边界：路径穿越×5 / JSON+Bearer 脱敏 / 轮顶 ask 可恢复 / 双 answer 不并发 / 预算停派 / bus+roster+worktree 随 clear 回收 / 常驻适配器 fail-closed / pid 复用四场景）；qa:ui --suite=all ok:true。

### 前端消费 v3.6 治理增量（2026-07-20 追加，Cursor 主驾）
> LO「继续完善前端界面」——后端新事件/新状态的 UI 侧兑现（此前静默丢失）。

- **会话流治理注记 +3**：`run.worktree_created`（琥珀：隔离工作树已建）/ `run.worktree_skipped`（玫瑰：无 cwd 写盘无隔离）/ `run.budget_exhausted`（玫瑰：成本硬顶停派）——GOVERNANCE_EVENTS 注册即进会话流与 runs 重载正则。
- **grok-build 正文对齐**：适配器补发 `assistant.message`（旧 grok.completed 携文本前端不识别，grok 轮在对话里只剩分隔线与统计行）；grok.completed 只留 usage/stopReason 元数据不双份入库。
- **ask 挂起可辨**：waiting_agent + pendingAsk → 状态徽标「等你回答」（语义反转说清）；左栏会话行琥珀脉动点（.ask-dot，prefers-reduced-motion 静止）；composer placeholder 直接递问题。
- **健康状态语义修复**：dormant 归 ok + 专属文案「待命」；missing「未安装」/ unconfigured「未配置」/ disabled「已禁用」（normalizeComponent 保留 rawStatus，detail 兜底链补 reason）；候选评分表健康列同口径。
- **statusline 成本权威化**：优先 run.costUsdTotal（后端累计闸同源）。
- **会话 meta 增强**：pipeline 拓扑标注 + 🌿 worktree 名（title 全路径）。
- **social 拓扑请求缓存**：2.5s TTL + LRU 上限 30——SSE 每帧重渲不再打一次 bus API（请求风暴消除）。
- **验证**：node --check 全绿；node --test 139/139；qa:ui --suite=all ok:true 0 JS 错误；健康面板实机验证（dormant「待命」/ ENOENT「未安装」+ reason 透出）。如实边界：ask-dot/「等你回答」的真实挂起场景未实机走一轮（渲染逻辑直白 + qa 0 错误，留下一个真 ask 自然验证）。

### 协作台逻辑与美观双优化（2026-07-20 追加，Cursor 主驾）
> LO「从逻辑和美观上优化完善协作台的前端界面」——巡查发现的核心逻辑缺口：活跃 run 的会话流是"死"的（没有任何进行中指示），轮次检查点噪音刷屏，agent 头像无辨识度。

- **活跃轮呼吸行**（liveTurnMarkup + .live-turn）：run 进行中时会话流尾部实时显示「谁在干什么」——agent 彩色头像 + 相位人话（正在准备会话/正在提交任务/正在执行/提交状态待确认）+ 三点呼吸动画；轮间空隙显示「编排器正在路由下一轮」。**假活防护**：重启遗留的 waiting_agent（recoveryNote 在）与相位 30 分钟未动的陈旧 attempt 不显示——绝不对已死协程假装活着。实机验证：grok-build 轮全程「GB Grok Build 正在提交任务 ⋯」（截图实锤）。
- **agent 配色槽**（AGENT_SHORT + .is-agent-\*）：头像按 agent 上色（Claude 赤陶橙/Codex 石墨蓝/Grok 双青/Kimi 紫/Pi·Gemini 琥珀，沿用既有语义色板 text-on-soft ≥4.5），双字码（CL/CX/GS/GB/KM/PI）替代生硬的首字母截取。
- **轮次检查点降噪**：prepared/session_ready/submitting/submitted/completed 的 gov-note 全部静音（呼吸行已实时呈现相位），只留 ambiguous 一条玫瑰警示（"提交状态不明确需人工确认"）；GOVERNANCE_EVENTS text() 支持返回 null 跳过渲染。
- **run id 短码**：meta 行 `run 08f54925` 8 位短码（全量 UUID 进 title 悬停，审计场景才需要）。
- **实时事件面板修复**：合并 per-run 磁盘回放历史（旧 run 事件早已滚出 SSE 窗口，此前空报"等待事件"）；历史反转为新→旧对齐时间线语义；空态文案区分「该任务暂无事件记录」/「SSE 建立后自动刷新」。
- **验证**：真实 grok-build run 端到端（UI 发任务→呼吸行→彩色头像→run 短码→实时事件面板全链实锤）；qa:ui --suite=all ok:true 0 JS 错误；编排回归 53/53。如实边界：grok 正文渲染（assistant.message 补发）在旧服务端进程上未验证到——重启后新代码生效，下一个 grok run 自然验证；浏览器 MCP 执行后端中断，最终态完整视觉走查由 qa:ui 无头回归替代。

### 协作台交互闭环（2026-07-20 第三轮，Cursor 主驾）
> LO「继续完善协作台」——把社交编排的关键交互补成闭环：提问有卡、完成有收口、失败能重发。

- **ask 回答卡**（pendingAskMarkup + .ask-card）：`[[msg:lo]]` 挂起时会话流尾部琥珀卡片——谁在等拍板 + 问题原文 + 「回答（发送即恢复协作）」聚焦按钮。gov-note 会被后续消息推走，卡片恒在尾部。**真实全链实锤**：grok-build 发 [[msg:lo]] 二选一 → 卡片/「等你回答」徽标/左栏琥珀点/placeholder 四处同步 → 输入框作答 → resumePendingAsk 复跑 → 第 2 轮 grok 确认收到答案。
- **完成收尾卡**（runCompletionMarkup .is-succeeded）：succeeded run 尾部绿卡——轮次/参与成员/token/成本合计（costUsdTotal 权威值优先）。最终结论就是流里最后一条消息，卡片只收口不重复正文。
- **失败重发**：failed 卡加「以同一任务重新发起」——prompt 回填 composer 新任务模式（不自动提交，LO 可先改）。
- **bus.routed 人话 + memo 黑板样式**：to=memo「记入全员黑板」（violet 记号，toneOf 按载荷分级）/ to=lo「向你提问」/ to=team「向全员广播」——不再显示内部代号直译；.gov-note.is-violet 新 tone。
- **[[msg:]] 标记剥离**：assistant 正文里的 `[[msg:lo]]`/`[[memo]]` 行首标记渲染前剥掉（路由语义 bus.routed 注记已呈现，内部协议原文不示人）。
- **grok.completed 旧格式兼容**：2026-07-20 前的历史 grok 轮正文在 grok.completed 事件里——data.text 有值即渲染，历史数据不丢（实机验证 15:42 的 run 正文找回）。
- **续聊书签冻结**：团队/起始 picker 在续聊模式 disabled + title 指路「发送给」（run 已固化，可改的假象误导）。
- **后端 cancel 清挂起**（orchestrator.cancel）：取消时一并清 pendingAsk/pausedForInput/resumeQueue——实测发现取消后回答卡残留（真 bug）；前端同步加终态防御（TERMINAL 状态不渲染 ask 卡/琥珀点/「等你回答」，兜住后端修复前的历史数据）。**后端改动需服务重启生效**（当前进程仍旧代码，前端防御已兜住 UI 面）。
- **验证**：ask 全链真实跑通（提问→四处联动→作答→恢复→确认）+ 取消防残留实机验证；qa:ui --suite=all ok:true；编排回归 53/53。如实备忘：grok 把"确认收到"也写成 [[msg:lo]] 导致二次挂起（agent 未守"仅拍板时用"约定）——编排 prompt 已有约束、多轮预算硬顶兜底，属 agent 行为面非 UI bug，观察后再决定是否加 ask 频次熔断。

### v3.7 codeg 对标 P1（2026-07-20 第四轮，Cursor 主驾）
> LO「参考 github.com/xintaofei/codeg 全面优化完善体系」。当时的 17 项粗粒度盘点见 `proposals/v37-codeg-parity-design.md`；它已被 2026-07-23 的 85 行 capability ledger 取代，不作为 parity 或优越性证据。

- **Automations（核心缺口落地）**：src/automations.mjs——composer 全配置快照（prompt/团队/起始/权限/模型/effort/cwd）存为命名自动化；`manual` / `idle` / `every:<n>m|h|d` 简化间隔制（不为 v1 自研 cron 的月末/DST 边界）；闲时接电（v4.x）：`idle` 项在控制面空闲（无活跃 run 且最近活动超静默窗 idleQuietMs=10min）时排水，每 tick 至多一条、最久未跑先跑、单条冷却 idleCooldownMs=4h，orchestrator 无 list() 无法证实空闲时 fail-closed 不跑；60s tick 调度器（并发防护：上一 run 未终态不叠跑；失败落 lastError+事件不崩调度；**定时基线=创建时刻**——实测踩到"every:1d 刚保存就立即执行"的最小惊讶反例后修正）；产生的 run 走 orchestrator 全治理链（审批/预算/轮次/事件全继承，**定时 build 照挂审批门不静默升权**）；prompt 过 findSecretCandidates（自动化是定时执行的持久载体，密钥字面量=定时泄漏器）；原子写盘 + close() 先停调度。API：GET/POST/PATCH/DELETE `/api/automations` + `/:id/run`。UI：composer 书签「存为自动化」（promptDialog 两问：名称+计划）+ 左栏「自动化」分区（计划/上次运行/失败红点/立即跑/启停/删除/点击跳上次 run）+ SSE automation.* 事件驱动刷新。
- **会话聚合扩源 Kimi/Pi**（基础要求补缺）：Kimi＝session_index.jsonl 索引制（state.json 元数据 + 自定义标题透出 + wire.jsonl turn.prompt 摘要；**sessionDir 来自文件内容→realpath 限根到 sessions 根，索引被篡改指向根外时 fail-closed 跳过**，测试含篡改样本）；Pi＝jsonl 首行 `{type:"session",cwd}` meta（与 codex rollout 同构，复用 cwd 归并管线）。两家格式均 2026-07-20 本机实测（kimi 0.27.0 / pi v3），非猜测；`#foldSessionGroups` 抽共用折叠（codex/kimi/pi 三源同一管线）。codeg 支持的 OpenCode/Cline/Hermes/CodeBuddy/OpenClaw 本机未装无数据可测——**不做假接口**（Integrity Gate）；Gemini 本机无会话存储如实跳过。
- **锁域修复（顺带清烛 v3.6 建议2 债）**：实例锁从 `repoRoot/.ai-shared/control-center` 固定路径改为 **dataRoot 域**——锁与 children.json 台账同命名空间（默认路径不变生产零影响；测试/多实例显式分 dataRoot 自然分域）。实测收益：http-e2e 不再与 live server 撞锁（146/146 从此可与开发服务共存跑）。
- **验证**：新增 7 测试（automations×6：CRUD 回环/密钥拒绝/触发快照/AUTOMATION_BUSY 防叠/调度 tick 到期与停用跳过/失败留痕不崩；kimi-pi×1：三源合并+索引篡改限根+pi 合成项目+摘要提取）；全量 146/146；qa:ui ok:true；Playwright 实测（创建自动化→左栏行渲染「每日巡检 · 每 1 天」+ 调度器真实触发过一轮 plan run=调度链端到端实锤）。

### v3.7 拓展：体检脉搏（Automation×社会编排，2026-07-20 第五轮，Cursor 主驾）
> LO「根据你的推荐继续完善」——把体系健康从手动巡检变成常驻脉搏：Automation 定时体检 + pulse 数据注入 + agent 判断 + 异常经 [[msg:lo]]→ask 卡向 LO 报告。刚落地的三套机制（自动化/ask 卡/观测数据面）串成一条真实用例。

- **pulse 聚合**（observability.pulse + server.collectPulse + `GET /api/observability/pulse`）：治理数据面（route-gate 命中/**redUnsummoned**=铁律1违反信号/DELTA 账本/handoff 新鲜度）+ 运行时实况（活跃 run/failedLast24h/recoveryRequired/waitingAnswer/unhealthyComponents/自动化 lastError）合一——agent 直接判断，不用工具轮抓取。
- **{{PULSE}} 注入**：AutomationStore.trigger 时占位符替换为 pulse JSON；数据源失败注入「不可用——如实说明，不要臆造健康状态」（严禁静默伪造成正常）。pulseProvider 惰性引用（装配顺序安全，state 未就位时 fail-closed 走不可用文案）。
- **内置「体系体检」自动化**：seedBuiltinAutomations 幂等播种（builtin:"pulse-check" 判据持久化）；**默认 manual 不擅自定时**（定时=费用，是 LO 的决策，改 every:1d 即每日体检）；prompt 教 agent 判读五类信号 + 「异常才用 [[msg:lo]]，正常直接收敛」。
- **端到端活体实锤**：手动触发（grok-build 起始）→ pulse 注入 → grok 正确判断（redUnsummoned=0 铁律1未破/dormant 不算异常/发现 kimi missing+failedLast24h=2+DELTA invalid 24/140 三项真实异常）→ **[[msg:lo]] 报告 → run 挂起「等你回答」→ ask 卡呈现体检报告**。该 run 留在页面上等 LO 拍板——本身就是交付演示。
- **实测修正 ×2**：①claude OAuth 过期导致首跑失败（体检起始已改 grok-build 持久化；claude 需 LO `/login` 重认证）②「上次运行」显示判据 lastRunAt→lastRunId（定时基线语义下 lastRunAt 创建即有值，未跑过的项曾误显「上次」）。
- **qa 立功（真实布局 bug）**：workbench 用例连续拦截失败——根因是左栏 `rail-block-team`（flex:1 1 0 可收缩到 0）被「正在工作」（无上限膨胀）+ 新自动化区块挤压**塌到 1px**，树 toggle 命中点全被兄弟区块盖住（真实用户在活跃 run 多时树会消失）。修：team 树 min-height:180px 保底 + working/pinned/automations 三区 flex 0 1 auto + max-height 有界收缩；qa 脚本补首屏 settle 等待 + scrollIntoView。
- **验证**：148/148（+pulse 注入双分支/播种幂等）；qa:ui --suite=all ok:true；pulse 端点实测（77 项目环境 251ms）；体检闭环活体运行中。如实边界：双 answer 竞态用例在全量并发下偶发抖动（单跑/复跑稳定绿，时序敏感+负载依赖）——已知 flaky 待时序加固，非本轮回归。

### ask/answer 收尾竞态修复（2026-07-20 第六轮，Kimi 主驾）
> 接续 Cursor 未竟项：第五轮留下的「双 answer 竞态用例全量并发偶发抖动」——实为 ask 熔断测试在全量并发下 6/6 红（单文件绿）。探针轨迹实证不是测试时序敏感，是**真生产竞态**。

- **根因（探针实锤）**：`turn()` 每轮开始把 `run.status` 写成 `waiting_agent`（瞬态语义=轮进行中），于是「waiting_agent + pendingAsk」对在 socialLoop 设 `pendingAsk` 的瞬间即可被观测——**早于 execute 收尾泊进挂起态**。此刻 LO/UI 回答 → `resumePendingAsk` 同步清 `pendingAsk`+`pausedForInput` 并接管 controller → 垂死 execute 收尾从 save 的 await 醒来读 `pausedForInput=false` → **误判自然收敛写 succeeded + run.completed** → resume 的 startExecution 撞 execute() 入口 TERMINAL 早退 → 第 3 轮永不执行，**回答被吞、run 假成功**。前端快速回答真实 ask 同踩。
- **修复=协程所有权闸**：execute 收尾（挂起分支/终态分支/catch 分支三处）写状态前校验 `controllers.get(id) === controller`——键已易主（resume 占位/continue 接管）则垂死协程不写挂起/终态，状态交由接管协程呈现；catch 分支被接管时错误改落 `auditErrors`（execute.superseded）如实留痕不吞错。
- **回归测试**：新增「窗口期作答」用例——紧轮询在 pendingAsk 置位第一时间 continue（确定性压进竞态窗口），断言回答必被消费（第 2 轮真实发生 + bus 恰好 1 条 answer）；熔断测试断言补全相位诊断 dump。探针（CC_DEBUG_ASK）定位后已全数移除。
- **验证**：修复前全量 6/6 红（两种失败相位：熔断事件未发 / 第二次挂起未现），修复后 **8 轮全量 150/150 × 8 全绿**；qa:ui --suite=all ok:true 0 错误。教训固化：**「waiting_agent」一态两用（轮中瞬态+挂起恒态）是观测面陷阱——状态机写入方与观测方必须以所有权/权威字段为准，不能靠状态对配对时序**。

### v3.7 codeg 对标 P2（2026-07-20 第七轮，Kimi 主驾）：会话聚合扩源 Cursor
> codeg 对标 P2 项：Cursor 编辑器历史会话接入项目树。格式 2026-07-20 本机实测（globalStorage state.vscdb，91 条 composer），非猜测。

- **存储**：`%APPDATA%/Cursor/User/globalStorage/state.vscdb`（WAL SQLite，`node:sqlite` 懒加载 `{readOnly:true}` 打开，失败回退 `immutable=1` URI；库文件 realpath 限根到 globalStorage 目录——与 ~/.claude/projects 同一条"已知 CLI 会话存储根"不变量）。权威列表=ItemTable `composer.composerHeaders`（allComposers[]）；摘要/预览=cursorDiskKV `composerData:<id>` 拿 `fullConversationHeadersOnly` 消息头，再按 `bubbleId:<id>:<bubbleId>` **参数化点查**（绝无 LIKE 全表扫；`agentKv:blob:*` 字节数组编码不读）。key 缺失/JSON 损坏/库打不开一律 fail-closed 不合并，不猜旧格式伪造。
- **归并**：archived/draft 过滤后按 `workspaceIdentifier.uri.fsPath`（回退 trackedGitRepos[0].repoPath）进 #foldSessionGroups 同一折叠管线（kimi/pi/cursor 三源共用），cli 名 `cursor`；会话名/摘要过双层 scrub；预览 `previewCursor` 取最近 50 条有文本消息（尾窗，与其他源"最近消息"语义一致；点查上限 150 bubble；assistant 纯工具调用空 text 跳过），归档/草稿会话预览同样 fail-closed 404。
- **前端**：CLI_LABELS 加 `cursor: "Cursor"`（一行最小 diff；徽标与 kimi/pi 同处理——index.html sprite 仅 claude/codex 有官方 logo，其余源文字标签）。
- **验证**：新增 2 测试（fake vscdb e2e：双源合并+小写盘符归一化命中+archived/draft 过滤+摘要跳过 assistant 空 text+预览角色映射/脱敏/404/422；缺 key 与 JSON 损坏 fail-closed 直调）；全量 152/152；实机验证（.qa-output/cursor-source-verify.mjs）：真库 80 live / 40 有 cwd → 39 条进树（1 条差额=单项目 11 条超 perProjectLimit 10 封顶，预期行为），标题/时间/cwd 与权威列表全对账 0 mismatch，redaction 扫描器 + env 秘密值比对零泄漏，无内部 _ 字段出网。

### v3.7 codeg 对标 P1 顺手项 + P2 注册表面/产物面（2026-07-20 第八轮，Kimi 主驾）
> LO「继续对标 codeg 完善整个协作台」——清 v37 设计文档剩余项：P1 两个顺手项 + P2 只读面三项（Office/Chat Channels/Project Boot/Docker 按文档判定需 LO 单独拍板或低优先，本轮不做）。

- **诊断日志级别过滤**（P1 顺手①）：安全诊断页日志区加级别 select（全部/信息/警告/错误），按 `[LEVEL]` 前缀解析过滤，空级别如实提示；复制按钮语义不变（复制当前可见内容）。
- **欢迎空态快捷任务模板**（P1 顺手②，codeg Quick Actions 对标）：新任务空态三张模板卡（深度评审=四节证据纪律/调研问路=必附来源/隔离构建=先计划后写码），点击填进 composer **不自动提交**（LO 改完再发）；模板措辞焊体系纪律；emoji 选单码点稳定字形（双码点 ZWJ 在主题字体下塌成 ◆，实测修正）。
- **能力图谱新页**（P2：Skills 管理+MCP 管理只读先行，`src/capabilities.mjs` + `GET /api/capabilities`）：①Agent 花名册（module.yaml 定向块解析，无 YAML 依赖）②Skill 矩阵=文件系统扫描（存在性权威）×注册表交叉（type/phase）×团队声明面（skill→团队名单），**幽灵注册**（注册表有磁盘无）如实单列 ③MCP 本机扫描=~/.claude.json（顶层+项目段）/~/.claude/settings.json/~/.codex/config.toml 三源 + module.yaml 能力映射策展层——**白名单字段出网**（名称/传输/命令基名/URL host/来源/范围），env/args/headers 属密钥面一律不出 API。
- **run 产物 diff**（P2：worktree×run 关联产物视图，`src/run-diff.mjs` + `GET /api/runs/:id/diff`）：worktree 路径只信 ensureRunWorktree 命名形态（`-wt-<14位>-<8hex>` 纵深校验，run 记录被篡改指路直接 422）；status/stat/diff 三件套过 scrub 脱敏，>200KB 截断如实标注；无 worktree（plan/无 cwd）422 人话原因。前端：完成/失败卡挂「产物 diff」按钮 + 会话流内面板（加载/错误/空改动三态如实；换 run 自动收起；迟到响应丢弃防串 run）。
- **验证**：新增 run-diff 4 测试（真 git worktree 脏/净双态 + 无 worktree + 篡改路径 fail-closed）；能力图谱 API 实机（21 skill/5 agent/39 MCP 声明/泄密扫描 clean）；产物 diff 422 实机；欢迎卡/能力图谱页截图复核；qa:ui --suite=all ok:true。Cursor 源（第七轮子代理实施）经主驾独立复验：156/156 + 项目树 39 条 cursor 会话正确归并 + preview 实机读出真实对话。

### 协作台群聊式 UI 2.0（2026-07-20 第九轮，Kimi 主驾）
> LO「优先优化协作台的 ui 美观和完整度，对标市场成熟产品并更创新」。设计基准：Slack/Discord 的发言者身份与分组 + Claude 人文暖纸的呼吸感——多 agent 团队对话本质是群聊，按群聊做。

- **群聊分组（Discord 式）**：同一发言者 3 分钟内连续发言合并（头像/名字不重复，带工具调用的轮不合以免吞可见性），分组行悬停露等宽小时间戳；多 agent 对话视觉噪音减半。两个调用点（实时流/历史预览）都传 prev，预览按 cli 归一 author 后同样生效。
- **发言者身份强化**：名字用 agent 配色槽同色（既有 .is-agent-\* 色板延伸到 .message-head strong）；头像加大到 34px 圆角 10px；LO 名字 rose-deep。
- **LO 便签气泡**：用户消息 rose-soft 底气泡 + rose-line 描边（4/14/14/14 非对称圆角=便签角），与 agent 输出视觉分层。
- **行反馈**：消息行 34px 网格 + 6px 内距 + 悬停 surface-muted 底色（Discord 式），圆角 12px。
- **轮次分隔胶囊**：turn-divider 从粗线改成细线+居中胶囊（第 N 轮 · Agent），对话阶段一眼定位。
- **代码块一键复制**：markdown.js 渲染层包 code-wrap（escape-first 安全模型不变，复制取同容器 pre 的已脱敏文本），悬停浮现「复制」钮。
- **会话拓扑参与者卡**：status-dot 换成与会话流同套双字码/配色 chip；最近发言者 is-speaking 呼吸高亮（prefers-reduced-motion 静止）。
- **composer 成熟键位**：Enter 发送 / Shift+Enter 换行（**isComposing 守卫——中文输入法候选窗 Enter 是选字不是发送**）+ textarea 随内容自动增高 220px 封顶 + 「Enter 发送 · Shift+Enter 换行」提示（移动端隐藏）。聚焦环既有 .composer-shell:focus-within 承担（自查重复块已删）。
- **验证**：node --check 全绿；156/156；qa:ui --suite=all ok:true 0 错误；亮/暗双主题 + 移动端 430px + 悬停态截图复核（移动端会话横滑条为既有设计未动）。

### 协作台精致化波次（2026-07-20 深夜，Kimi 主驾）
> LO「UI 太单调前端还是不够精致」——方向：平面→空间。不再零散补丁，做一次有体系的光泽度提升。

- **画布氛围**：app 底叠两层极轻氛围光（赤陶/水色 radial-glow，background-attachment:fixed 不随滚动漂移）；::selection 用 rose-glow；顶栏玻璃拟态（blur 12px + saturate + 发丝线下框）。
- **阅读宽度收敛**：conversation-stream 内容栏 max-780px 居中（长文不拉满全宽）；消息行节奏化（非分组行 margin-top 14px，分组行紧凑）。
- **头像软环**：agent 配色槽从 fill 延伸 3px 同族 box-shadow 软环，头像不再贴边生硬。
- **编辑器风代码块**（精致感最大单点）：深墨底 #2b2620 + 暖纸字 #e9e3d3 + 内阴影，双主题同形；data-lang 大写语言标签；复制钮随块变深色玻璃风。blockquote 赤陶细条+软底；markdown 标题衬线化；turn-meta 等宽小字居中退注记位。
- **状态从文字变信号**：①会话行 rail-status-dot（live 水色脉动/amber 等你或审批/red 失败/green 成功/neutral 取消，grid 两行居中对齐）②事件流彩色分类点（run.=赤陶 bus.=水色 agent.=蓝 automation.=琥珀 user=紫 告警词=红）——左栏和右栏一眼扫出活态。
- **微交互**：发送钮悬停微抬升+按压回弹（scale .96）；左栏行悬停 translateX(2px)+选中左侧 3px 赤陶签名条；右栏面板卡片化（raised surface+shadow-low）；状态徽标胶囊化。
- **验证**：156/156 + qa:ui ok:true；亮/暗双主题截图复核（氛围光、彩色信号、分组流全呈现）。

### codeg 真实界面截图对标吸收（2026-07-20 第十一轮，Kimi 主驾）
> LO「继续对标 codeg 的 ui 界面质感来查看是否可以借鉴并完善本项目」——拉取 codeg docs/images 真实截图（main/collaboration/office × 双主题）逐张研读后选择性吸收，不照抄。

- **对照结论（诚实账）**：codeg 是 LobeHub 式冷调极简白卡风；514cc 采用暖纸人文体系，视觉取向不同。当前没有可用性对照实验，因此不作“领先”结论。可借鉴的三处是：**欢迎 hero 点睛**、**相对时间扫读**、**委派状态卡**；冷灰配色与无 agent 身份色的单 agent 流不符合本项目定位。
- **欢迎 hero**：「LO，今天想做点什么？」34px 衬线 + 「做」字赤陶斜体点睛（codeg 的 "What would you like to **do** today?" 同款处理，换暖纸衬线人文版），模板卡在其下。
- **相对时间**：左栏会话行绝对时间戳（07/20 23:54）→ 相对（刚刚/N 分钟前/N 小时前/N 天前，>7 天回落绝对），绝对时间进 title 悬停保审计精度；时钟漂移未来时间如实落绝对。
- **当轮未做的**：委派状态卡。群聊参与者 chip、发言数与最近发言只是社交投影，不等价于 CodeG 的 typed delegation card；对应 lifecycle 仍随 `AG-12B`、`AG-13`、`AG-14` 保持 blocked。浏览器式多会话 tab 页签在后续波次另行实现。
- **验证**：156/156 + qa:ui ok:true；欢迎页截图复核（hero 衬线斜体点睛、相对时间行呈现）。

### 信息架构重构：会话=团队房间 + 成员独立页 + 浏览器式 tab（2026-07-20 第十二轮，Kimi 主驾）
> LO 拍板的信息架构：「项目→会话（统一含全团队）→点会话选 agent 独立页，结合 tab 实时看每个 agent、单独问某个 agent」。纯前端架构层改造（后端 bus/continue(agentId) 能力早已就绪，零服务端改动）。

- **页签系统**：`state.tabs=[{key,runId,agentId,title,dirty}]`（key=`runId` 或 `runId::agentId`）——会话行点击开「全员」页（群聊流）；成员条/拓扑参与者卡点击开成员独立页；浏览器式上圆角页签（活跃页下缘连通内容面），sessionStorage 持久化（刷新恢复，已清除 run 的页签如实丢弃/关闭）；非活跃页有新事件落脏标（pushEvent 统一标记，切回即清）。
- **成员独立页**：`normalizeRunMessages(run,{agentId})` 事件级过滤（该成员的轮次/发言/路由 + LO 的话（所有页上下文）+ 无归属 run 级治理事件；turns 兜底同滤）——独立页绝不冒充全员视角；标题「会话 · Agent名」+ meta「独立页·只看 X」+ 空态「还没发言，直接问 ta」。
- **单独问 agent**：composer 在独立页锁定发送目标（followup-agent 禁用+placeholder「单独问 X——发送直达 ta，不经团队路由」）——走后端既有 continue(agentId) 直达轮，零新 API。
- **成员条**：会话房间内的选页条（◈全员 + 各成员 chip，agent 配色槽一致，激活态高亮）；拓扑参与者卡同步可点（悬停浮起）。
- **清除清账**（LO 拍板「只清 runs 最安全」）：9 条存量 run（5 终态直接清 + 4 重启遗留 waiting_agent 先 cancel 再清）——控制面归零；357 条 CLI 磁盘历史一根手指没碰。
- **验证**：Playwright 交互实锤（两会话→2 tab→成员 chip→第 3 tab 独立页标题/meta/锁定/placeholder 全断言+刷新恢复 3 tab+0 JS 错误）；156/156；qa:ui --suite=all ok:true。

### 全部隐藏聚合项目 + 恢复入口（2026-07-20 第十三轮，Kimi 主驾）
> LO「全部隐藏（不动文件，视图清零，随时可恢复）」——79 个项目 prefs hidden:true（磁盘零触碰）+ 补齐恢复路径（此前隐藏是 UI 单行道，只能手改 project-prefs.json 恢复=隐性坑）。

- **恢复入口**：团队区头部新增「已隐藏」开关（近期/摘要/子代理同排，sessionStorage 记忆）——开启后被隐藏项目压暗回树 + 「已隐藏」徽标（nowrap 防折行）；右键菜单对 hidden 项目出「取消隐藏（恢复到侧栏）」项。
- **qa 环境自洽修复**：qa-ui workbench 用例原硬依赖树非空（等 `#workbench-project-tree [data-project-toggle]`）——视图清零后必超时；改为树空时先开「已隐藏」开关再交互，用例从此与 LO 的侧栏偏好状态解耦。
- **负载敏感测试实锤**：「ask raised near the round cap」在我并行 curl/playwright 高压期 15s 超时一次，安静期 3× 全绿——与 Cursor 记录的「双 answer」同类环境抖动（非本轮回归，本轮为纯前端改动）；断言已埋相位 dump（status/round/maxRounds/pendingAsk/turnAttempts），下次抖动一次定位。
- **验证**：156/156 × 3 + qa:ui ok:true；清零视图/恢复视图双截图复核（0 项目干净态 / 32 项目压暗「已隐藏」标注——32<79 因「近期」30 天过滤仍生效，行为正确）。

### 选目录即上树（乐观 pending 项目，2026-07-20 第十四轮，Kimi 主驾）
> LO「点击新建任务选择目录后项目列表中必须立刻出现这个目录项目，而不是等开始一段对话后再出现」。

- **乐观项目叠加**：confirmSessionDialog 确认新目录（扫描列表无此项目）→ `state.pendingProjects` 立即注入团队树（0 会话 + 「新」水色徽标 + title 说明"首段对话落盘后转为正式项目"）；扫描列表一旦出现同路径真项目（会话/CLI 落盘）自动让位；刷新不保留（内存态，诚实不虚报持久）。
- **团队从属预设**：上树同时预写 pref（teamId=当前 composer 选中团队、hidden:false）——真项目出现时从属已就位；曾被移除的同路径项目重新选用顺手取消隐藏（否则树里看不见=静默失败）。
- **过滤豁免**：「近期」30 天过滤对 0 会话乐观项目误杀——pending 标记豁免。
- **对话框文案同步**：hint 从"新地址将在首轮后自动创建为新项目"改"新地址会立即作为新项目出现在左侧项目列表"（行为变了文案必须跟）。
- **验证**：Playwright 实机（新建任务→输新路径→确认→树立即出现 pending 徽标项目 + composer 地址徽标，0 JS 错误）；156/156 + qa:ui ok:true；测试产生的 prefs 残留已清。

### pending 项目两 bug 修复（2026-07-20 第十四轮补，Kimi 主驾）
> LO 实机报障：「刷新网页后（pending 项目）就消失了，并且右键不会跳出正确的快捷选项」——两真 bug，都是我十四轮的设计疏漏。

- **刷新消失**：pending 项目初版只存活内存（我选"不虚报持久"判据时判错了用户预期）——改 localStorage 持久化（`514cc-pending-projects`），刷新/重启浏览器不丢；扫描出同路径真项目让位时同步清持久层；「移除」乐观项目=退出 pending（hidden 语义留给真实项目）。
- **右键无菜单**：右键委托的项目查找只搜扫描列表（`state.projectsData.projects`），pending 项目找不到→菜单静默不出现——抽 `findProjectById`（pending+扫描统一入口），三处委托（会话/项目/置顶项目）全换；置顶/归档分区数据源同步并入 pending。
- **验证**：Playwright 实机（选目录→上树→刷新仍在→右键六项菜单全出：置顶/从属团队/资源管理器/重命名/归档/移除，0 JS 错误）；156/156 全量受负载敏感用例环境影响（详见第十三轮记录，与本修复无关——本轮纯前端）。
- **教训固化**：**「乐观叠加实体」必须回答三个问题——持久化语义（刷新活不活）/查找链覆盖（所有 by-id 查找都要含叠加层）/移除语义（hidden 还是真删）**，缺一就是 LO 这种实机报障。

### agent 官方徽标选择器 + 系统图标官方化（2026-07-20 第十五轮，Kimi 主驾）
> LO「点击项目右边的新建会话后右边会话界面跳出各个 agent 的悬浮图标供清晰选择；此系统中的类似图标默认都要是模型对应厂商的官方标志，不要主观臆造」。

- **官方徽标 sprite 扩充**（出处可考，绝不臆造）：xAI Grok=Wikimedia File:XAI Logo.svg（xAI 公司徽标）；KIMI=simple-icons KIMI（源 kimi.com）；Inflection Pi=simple-icons Pi（与 pi.dev/favicon.svg **同形实证**——下载比对一致才采用）；Google Gemini=simple-icons（源 gemini.google.com）；Anthropic/OpenAI 用既有官方徽标。全部 fill=currentColor 走主题。
- **agent 徽标选择器**：项目行尾「新建会话」/选址对话框确认后，会话区弹出「从谁开始？」悬浮卡阵（官方徽标 44px 瓷砖 + 名字 + leader 标注 + agent 品牌 soft 底）；点卡=写回 start-agent 并联动 /model·/effort（syncModelPick 既有链），「先不选」回落直接输入；团队非成员不出阵（gemini 不在 514cc 花名册故无卡，如实）。
- **系统图标官方化**：AGENT_CLI 映射（claude-fable→Anthropic、codex-technical→OpenAI、grok-*→xAI、kimi-frontend→Moonshot、pi-resident→Inflection、gemini-research→Google）——会话流头像、活跃轮呼吸行、拓扑参与者 chip、成员条 chip 全部换官方徽标（无官方映射者才回落双字码）。
- **顺手修同类查找漏**：项目行尾「新建会话」的查找也曾只搜扫描列表漏 pending（与右键菜单同类），换 findProjectById。
- **验证**：Playwright 实机（行尾新建会话→6 卡 6 官方徽标全出→点 Grok Build→start-agent=grok-build+选择器关闭，0 JS 错误）；156/156 + qa:ui ok:true。

### 能力图谱升级可配置面 + tab 宽度修复（2026-07-20 第十六轮，Kimi 主驾）
> LO「1.tab标签页会变得异常宽 2.需要能够配置全部 agent skill、mcp 等等的入口」。

- **tab 异常宽修复**：根因=inline span 不吃 text-overflow，长标题把页签撑破——title 改 display:block + 链路每层 min-width:0（.conv-tab/.conv-tab-main/.conv-tab-title 三级收束 220/186/150px）。
- **agent skill 启停矩阵**（真接线非摆设）：`dataRoot/agent-capabilities.json` 负名单（默认全启用）；能力图谱页 21 skill × 6 成员 checkbox 矩阵；**orchestrator socialLoop 成员轮提示词按负名单过滤团队 skill 声明注入**（run.teamSkills 快照与 teamMembers 同纪律固化）；写失败前端回滚勾选态。
- **MCP 隔离式启停**：claude.json 全局 server「禁用」= 条目（含 env 凭据）原样移入 `dataRoot/mcp-quarantine.json`（一键恢复逐字节一致）+ 写前 `.514cc-backup` 备份 + **mtime 乐观锁**（扫描后被 Claude Code 外部改写即拒 STALE_BASE，不覆写并发写）+ 禁用前确认弹窗（明示 Claude Code 运行中可能回写）；codex TOML/settings.json 如实「只读」（TOML 注释保真编辑器未就绪，不做半吊子写入）；隔离条目并回 MCP 表（禁用态可见可恢复，启停非单向删除）。
- **验证**：新增 4 测试（skill 负名单回环 / 隔离-恢复逐字节一致+备份 / STALE_BASE+READ_ONLY_SOURCE 拒绝 / **编排接线实证**：被禁用 skill 不进成员提示词）；160/160 + qa:ui ok:true；矩阵截图复核（21×6 全勾选渲染）。

### tab「异常宽」真根因修复（2026-07-20 第十六轮补，Kimi 主驾）
> LO 报「还是没有解决」并贴 conversation-heading DOM——上一轮的 ellipsis 修复治的是长标题撑破（真实但非他那个）。实测取证：conversation-pane grid 行模板三行（heading/stream/composer），tab 波次给 DOM 头插了两个子节点（conv-tabs/member-strip）却没改模板——member-strip 落进 minmax(240px,1fr) 行被拉成巨带，heading/stream 全被挤歪。**grid 容器插子节点必须同步行模板**。

- **修复**：grid-template-rows 改 `auto auto minmax(54px,auto) minmax(240px,1fr) auto`（tab栏/成员条/会话头/会话流/composer 与 DOM 同序）。
- **实测取证**：修复前 member-strip 高约 240px+ 巨带（截图 wb 对比）；修复后四段紧凑连续（tab 41px/成员条 44px/会话头 54px/流 336px，坐标实测非目测）。
- **教训**：**修 UI 先实测再开方**——上一轮凭经验判"长标题 ellipsis"（真 bug 但不是 LO 那个），贴 DOM 后先量各元素 clientWidth 找真凶再改；grid 插子节点同步行模板进自检清单。

### v4.0 Forge design system（2026-07-25，forge-foundation 主驾）
> v4.0 Forge 深整合波次奠基层：OKLCH token 体系 + 纪律化动效 + Lucide-only 图标，目标 Awwwards 级观感，全程零 emoji、零 CDN、零新依赖、零构建步。

- **三层架构**（`public/forge/`，在 styles.css 之后加载，同等特异度靠层叠取胜，禁 `!important` 除非 utility）：`tokens.css`（设计变量）→ `motion.css`（动效变量/关键帧/工具类）→ `primitives.css`（既有通用控件的 forge 层覆写 + 新原语）。
- **OKLCH tokens**：亮色 `:root` / 暗色 `[data-theme="dark"]`；核心面 `--background/--foreground/--card/--muted(--foreground)/--border/--ring`；主色 `--primary` 由 514 玫瑰 `#b4234d` 忠实换算为 `oklch(0.509 0.18 10.3)`（暗色抬亮至 `#ff7898` ≈ `oklch(0.739 0.166 7.1)`，hover 加深不提亮以保白字对比——承袭烛 R8 纪律）；语义色 `--success/--warning/--danger/--info` 各带 color-mix 生成的 `-soft` 变体；agent 品牌 `--agent-claude/codex/grok/kimi/pi/cursor` 全部 hex→OKLCH 精确换算；半径 `--radius` 10px 基 + sm–4xl（6–26px）；阴影 `--shadow-sm–2xl`（暗色加深）；字阶 `--text-xs–3xl`（11–30px），标题 `600 + -0.02em`；z 轴 `--z-*` 对齐既有 toast=1100/skip-link=1000；`.num` 全站 tabular-nums。
- **动效纪律**：`--dur-fast/med/slow/slower`=100/150/240/300ms + `--ease-out/spring`；`.forge-enter`（fade+zoom-95 100ms 入场）、`.forge-shimmer`（bg-clip:text 渐变扫光，仅限文本）、`.forge-press`（active 下沉 1px）、`.forge-pulse-dot`、`.forge-conic-spin`（`@property --forge-angle` 驱动锥形渐变，无 @property 时静态兜底）、`.forge-spin`（transform 旋转兜底）；**所有动效在 `prefers-reduced-motion: reduce` 下全灭**，新增动画必须同纪律。
- **primitives 覆写**（选择器与 styles.css 原样同特异度）：`.button` 36px 高 4xl 药丸 + 按压微交互 + 3px ring/50 焦点环；`.metric-card` rounded-2xl + shadow-sm + hover 抬升；`.action-dialog/.command-palette` rounded-4xl + shadow-2xl + 黑 80% backdrop-blur 遮罩；输入件 rounded-lg + 焦点环；滚动条 6px→hover 8px 圆头 var 驱动（通用规则兜底新视图）；`kbd` 芯片；新原语 `.forge-card(-interactive)`、`.forge-glass`、`.forge-badge/.forge-pill`（5 语义变体）。
- **图标纪律**：UI 字符串零 emoji，图标只走 `lucideIcon(name[, className[, size]])`（`public/lucide.js`，新增可选 size 参数，API 向后兼容，`remapLegacyIconUses` 不动）；sprite 扩至 **85 枚**（保留全部旧 symbol + 24 枚白名单新增），`lucide-icons.json` 升格为准确清单（`icons` 数组 + `count` + `missing:[]`），上游改名 `stop-circle→circle-stop` 记录于 `renamed` 字段、清掉旧 ENOENT 错误态；`scripts/vendor-lucide.mjs` 的名单需后续同步（本轮脚本不在分工内，用同逻辑临时生成器重出）。
- **使用文档**：`public/forge/README.md` —— token 清单、动效工具、图标 API、硬规则（零 emoji / 零 CDN / 简体中文 / reduced-motion / 挂载点 null-guard）。

## 团队成员库与三域执行身份（2026-07-28）

- **三域契约**：`memberId` 是团队、主脑、run、turn、bus 与 session 使用的逻辑成员身份；`runtimeProfileId` 是 models、router 与 adapter registry 使用的运行席位键；`adapter.id` 是具体协议实现。唯一绑定链为 `memberId -> runtimeProfileId -> adapter.id`，三者禁止混用。
- **成员库**：内置成员由 runtime catalog 投影，保持 `memberId === runtimeProfileId` 且绑定与删除冻结；`team-members.json` 只持久化内置元数据覆盖和服务端生成 `member-*` ID 的自定义成员。自定义成员支持创建、编辑、复制、删除，也允许多个逻辑成员共享同一运行席位。
- **引用完整性**：仍被正常团队、拒载团队或不可验证的 `teams.json` 引用状态覆盖时，自定义成员禁止删除或更换 runtime binding；模型、运行席位和成员统一默认全能力，不再做能力子集资格检查。成员引用检查与团队 create/update 共用 TeamStore 串行队列，避免跨 Store TOCTOU。
- **团队与主脑**：团队的 `members[]` 和 `coordinator` 均存逻辑 `memberId`；新建草稿可以为空，但持久化时至少需要一名可执行成员和一名 `coordinatorEligible` 主脑。内置 `team-514cc` 继续冻结；自定义团队可自由加入、移除成员并指定任意合格主脑。
- **运行快照**：run 创建时固化 `teamMembers + teamRosterVersion: 1 + teamRoster`；同一 runtime profile 下的多个逻辑成员保持独立人格、默认档位和 native session，后续成员编辑不漂移既有 run。
- **成员档位**：`defaultModel/defaultEffort` 属于逻辑成员；会话级 model/effort override 只覆盖起始成员，其余轮次使用各自成员默认值。模型目录按 `runtimeProfileId` 查询，最终值传给支持对应参数的 adapter。
- **融合入口**：`#/team` 内的“成员库”工作面提供搜索、内置/自定义筛选、成员详情与提示词编辑、运行席位绑定、默认模型/推理强度、默认全能力状态，以及加入或移出当前团队。“配置运行席位”深链到唯一配置图谱的 `control.models`；成员 Skill 入口以逻辑 `memberId` 聚焦能力矩阵列，目标进入 hash 并采用 latest-wins/fresh 语义。

## Codex 桌面式环境舱与任务工具（2026-08-07）

- **唯一直接收件人**：活动成员标签决定 `startAgentId` 或续聊 `agentId`；侧边对话只是主 Composer 的同步镜像，不维护第二份收件人状态。`@` 仍只表示额外协作者并进入 `requestedAgentIds`。
- **CLI 专属 Composer**：目标成员沿 `memberId -> runtimeProfileId -> adapter.id` 加载自己的 model、effort、permission、Composer 命令、CLI 工具和配置深链；成员标签切换时整套控制面同步切换。
- **环境舱真源**：`GET /api/workbench/environment` 聚合任务 cwd、Git branch/HEAD/upstream/ahead/behind、分层变更与 numstat、GitHub PR、智能体活动、514cc 托管进程及持久任务来源。面板字段不得从 DOM 或文案推断。
- **Git 双阶段写门**：Commit 只提交已暂存内容且不执行 `git add`；Push 只允许当前分支已有 upstream 且存在 ahead commit。plan 固化 HEAD/index/upstream 签名并设 5 分钟 TTL；execute 需要逐字输入 `COMMIT`/`PUSH`，状态变化返回 `PLAN_STALE`，禁止 force 和任意参数透传。
- **五个任务工具**：审阅复用 Mission 产物与真实 run diff；终端复用 PTY dock；文件复用受控 workspace explorer；侧边对话复用唯一 Composer；浏览器只允许 HTTP(S) 并打开系统新标签，明确不向 CLI 授予浏览器权限。
- **静态依赖门**：根级 ESM 新模块必须同时进入 `server.mjs` 静态白名单。`environment-panel.js` 初次遗漏导致浏览器 404、token 未自举而 Node 全量测试仍绿；现由静态契约 + 隔离 Playwright 启动链共同阻止复发。
- **验证入口**：`npm run qa:environment` 自建临时 Git 仓库、bare upstream、持久 run/source、随机端口和隔离 data/runtime home，覆盖真实 HTTP 鉴权、Git 预览、成员 payload、五工具、四视口截图、390px 可滚动 Git 动作、诊断白名单、优雅退出与临时根删除。
- **Git 写集签名**：Commit 的确认预览与执行同时绑定 HEAD、index raw diff 和工作树身份；暂存计数直接从已签名的 `--raw -z` 结果解析。Push 只接受单一 push URL，原始 URL 与 Git 有效 URL 因 `insteadOf/pushInsteadOf` 不一致时拒绝，执行固定完整 OID/refspec，并禁 hooks、follow-tags 与 submodule push。plan 在首个异步重认证前原子消费，不能并发重放。
- **来源保密边界**：绝对附件路径只保存在私有 `run.sources` / event `sourceRefs`，公开 run、automation、HTTP history 与 SSE 均投影为名称。旧自动化 prompt 附件块加载时迁移为结构化 sources；run 已清除时事件回放仍可用，但启用保守的本地绝对路径兜底脱敏。
- **复核修复**：完整 TAP 首轮抓到 `orchestrator.mjs` 漏导入 `isAbsolute`，并暴露 orphan 事件回放在投影前误做 run 存在性检查；两项均已修复。Mission HTTP 的只读 workspace 夹具从无 worktree 的非法 build 状态改为 review，生产代码继续拒绝 `WORKTREE_NOT_READY`。
- **残余边界**：同权限本机进程仍可能在最后一次 workspace 认证与 Git 子进程打开目录之间竞争，这是 Windows/Node 无目录句柄绑定条件下的 TOCTOU；未来新增 EventStore 对外读取必须复用 `eventForPublic()`，不得直接公开私有 `sourceRefs`。orphan POSIX 路径兜底宁可误遮部分 `/api/...` 诊断文本，也不放宽历史路径泄露面。

## ProviderStore / CC-Switch Proxy 事务与可重试关闭（2026-08-08）

- **候选状态提交**：Provider CRUD、排序、故障转移、common config、导入和 `markProxyCurrent()` 只修改深拷贝候选图；`providers.json` 原子持久化成功后才交换实例状态，写盘失败不会泄漏或复活候选值。
- **统一发布边界**：`switchTo()` 把目标 CLI live 文件、`providers.json` 与 `current` 指针放进同一 publish plan；Proxy takeover 再把 `ccswitch-proxy.json` 和同步 `commitRuntime` 纳入同一提交边界。准备阶段不允许 runtime 提前可见。
- **Windows rename CAS**：`atomic-rename.mjs` 对 `EPERM/EACCES/EBUSY` 做有界重试，并在每次 rename attempt 前重新核对 live 快照。只有 rename 正常返回或错误明确携带 `renameCommitted=true` 时，目标才进入 `published`；首次瞬时失败后的外部 CLI 编辑会触发 `LIVE_CONFIG_CHANGED`，不会被下一次 retry 覆盖。
- **补偿保护**：rollback 的首次检查和每次 rename retry 都验证目标仍等于本事务发布值；事务提交后的外部编辑只进入 `rollbackErrors` 诊断，不被旧快照覆盖。rename/remove 成功但越过 deadline 时按“已提交”进入独立短时补偿窗口，避免内存、sidecar 与 live 文件分叉。
- **关闭提交点**：Proxy restore 成功前 listener、takeover、automation、EventStore、Orchestrator 与实例锁保持可用；restore incomplete 时 Control Center 在原端口、原 bearer token 上重开 HTTP，故障解除后可再次关闭。restore 成功后才进入终态清理。
- **终态失败不可漂白**：提交点后的 `denyAll -> orchestrator -> eventStore -> childRegistry -> instanceLock` 按顺序 best-effort 清理；任一步失败固化为 `CONTROL_CENTER_CLOSE_FAILED`，后续 `close()` 继续返回同一失败，不能误报成功。HTTP transport 回开失败保留 `transportReopenError` 并要求非零退出。
- **验证**：Provider `42/42`；App/Shutdown/真实 server `6/6`；CC-Switch 整域 `142/142`；Proxy 生命周期连续 10 轮均 `31/31`；最终 `npm test` 为 803 tests / 802 pass / 0 fail / 1 explicit skip；`npm run validate` 为 13/13 valid；核心 12 文件语法与冻结 SHA 均 `12/12`，两轮独立终审最终 `APPROVED`。
- **清理证据**：`.test-app-close-*` 与 `.test-shutdown-server-*` 为 0；`.514forge*.tmp`、`.ccswitch-proxy*.tmp`、`.providers.*.tmp` 为 0。历史 `.test-*` 目录按安全边界保留，未批量删除。


## 超时双闸与分级恢复（2026-08-09）

> 起因：run 6eed4c43 第 1 轮 Codex 在 11:53:58 仍正常输出，11:56:13 被 15 分钟墙钟杀死——
> 纯墙钟看门狗无法区分"挂死"与"慢但健康"，误杀健康轮反而制造了 ambiguous 人工闸。
> 同时 `interruptConfirmed` 证据（cancelActive 拿 turn/interrupt 与终态边界赛跑所得）无消费者，
> 所有 TURN_TIMEOUT 不论风险一刀切进人工闸。

- **双闸看门狗**：新增静默闸 `idleTimeoutMs`（默认 5 分钟，policy `limits.turnIdleTimeoutMs` 可调，<=0/非法值如实关闭）——任何抵达该线程的原生流量（delta/item/turn 通知、审批请求、reasoning）都重置计时，连续静默才以 `TURN_IDLE_TIMEOUT` 杀轮；总时长闸 `turnTimeoutMs` 保留为防跑飞兜底（900000→1800000）。静默闸只在轮被接受后上弦，提交/就绪阶段仍由 request/lifecycle 超时看护，避免两闸与合法等待互伤。
- **已确认打断的只读轮自动续跑**：`autoRecoveryDecision` 四条件缺一不可——超时家族错误、provider 确认打断（`interruptConfirmed === true`）、只读/plan 轮（无写盘残留可检查）、有原生会话且未超 run 级硬顶（`MAX_AUTO_RECOVERIES_PER_RUN = 2`，防脚本化白烧）。满足则在 `turn()` 内向同一原生会话发续接指令（非原 prompt 盲重放），产出 `run.auto_recovery` 琥珀注记（次数/硬顶/轮次可见，自动 ≠ 免审计）；续跑失败或条件不满足如实回落 ambiguous + `adapter.replay_blocked` + 人工闸。
- **分级恢复文案**：`adapter.replay_blocked` 事件携带 `interruptConfirmed`；已确认打断时 recoveryNote 降级为"确认无活跃占用、可能有部分产出"，前端注记如实标注——未确认时保持"may still own a native turn"严格措辞。写盘轮（workspace-write）一律不自动续跑，半成品必须人工检查。
- **单出口台账**：ambiguous 封存 + 阻断事件收敛为 `markAmbiguous` 唯一闭包，首轮失败与自动续跑失败共用，避免两套台账漂移；`turn()` 的 replay/fallback 判决从布尔改为谓词 `replayBlocked(candidate)`，语义不变。
- **schema**：`contracts.schema.json` `permissionPolicy.limits` 新增可选 `turnIdleTimeoutMs`（1000–3600000），旧配置无需迁移。
- **恢复条随真实状态翻页**（LO 同日 UX 报障）：直接续聊的 HTTP 要等整轮跑完才返回（`continue()` 返回 `tracked`），期间 `state.runs` 停在 recovery_required 旧快照，SSE 每次重渲染都把已确认的恢复条画回去。修复只动前端重载闸（`pushEvent`）：`run.recovery_required`/`run.round_refunded`/`agent.turn_started`/`user.message` 纳入 450ms 防抖的 runs 重载——恢复条显隐永远跟随 live 状态， ack 标记在状态翻页时由 `renderRecoveryBar` 隐藏分支一次性消费。
- **验证**：适配器 57/57（新增静默杀死/流量续命两例）；编排 59/59（新增自动续跑成功、未确认严格闸、续跑失败回落、判决单测四例）；全量 `npm test` 847 tests / 846 pass / 0 fail / 1 skip；`npm run validate` 13/13 valid。


## Composer 权限 pill（Codex 桌面式选择器，2026-08-09）

> 需求：协作台发送框要像 Codex 桌面端一样有权限模式 pill——点击上弹菜单，
> 每行图标 + 标题 + 描述 + 对勾。此前权限选择是裸 `<select>`，三档含义不可见。

- **单一状态源不动**：`<select id="task-permission">` 隐藏保留，提交、自动化快照、statusline、change 链路全部照旧；pill/menu 只做镜像，点选回写 `select.value` 并 `dispatchEvent("change")`，复用既有草稿记忆与 CLI console 渲染。
- **文案如实**：`PERMISSION_MODE_META` 只覆盖 permissions.json 的三档（plan 只读规划 / review 只读深审 / build 写盘审批），未知 mode id 回落为 option 原文 + shield 图标——不虚构后端没有的能力档。
- **同步点**：`syncModelPick()` 的静态与动态 discovery 两条渲染路径、命令面板 `mode:review` 直改 select 的路径，都在渲染后调 `syncPermissionPill()`；select 的 change 监听同样回同步，保证任意来源改值 pill 不失步。
- **交互**：pill click 切换、菜单内 Escape 关闭并回焦 pill、点击容器外关闭；`role=menu`/`menuitemradio` + `aria-checked`/`aria-expanded`。
- **验证**：`workbench-rail-and-tools-contract.test.mjs` 新增静态契约（结构/状态源/同步点/样式），13/13；全量见本轮 npm test 输出。


## Codex 官方权限档（2026-08-09）

> 起因：composer 权限 pill 初版用的是 514cc 自造的 plan/review/build 档，LO 要求与 Codex 桌面
> 批准菜单（请求批准 / 帮我批准 / 完全访问权限 / 自定义 config.toml）对齐——"按照官方的走"。

- **原生组合编码**：Codex 官方档 = sandbox+approvalPolicy 组合，编码为原生模式 id——`workspace-write`（请求批准 on-request）、`workspace-write:on-failure`（帮我批准）、`danger-full-access`（完全访问 never）、`config-default`（自定义，不下发任何覆盖，跟 config.toml 走）。`codex-app-server.mjs` 的 `codexPermissionPreset()` 单点解析，thread/start 与 turn/start 同步下发；未知/只读档 fail-closed 到 read-only + on-request。
- **composer 档 ↔ 原生档**：`CODEX_PRESET_NATIVE_MODES`（orchestrator 模块级冻结表）：`ask/auto/full-access/config` → 上述原生 id。创建期双闸：预设档要求执行拥有者的 adapter 模板声明预设族标记位 `danger-full-access`（ask 原生映射与 build 同为 workspace-write，不能仅凭原生 id 放行，否则 claude 模板会被 ask 绕过 build 审批门）；policy.modes 必须有对应契约（permissions.json 已补四条，approvalRequired=false 如实表达官方语义）。
- **不加 514cc 审批门**：官方档不经过 build 的动作绑定审批 + capability lease——审批发生在 Codex 层（on-request/on-failure 升级到 approvalBroker 内联审批卡）或按官方含义不询问（full-access/never、config）。turn 路径执行拥有者拿原生组合，其余成员保持 plan/read-only，写面不扩散。
- **边界如实**：官方档 run 不建 worktree（worktree 仍是 build 专属）；写盘落在席位配置的 cwd，与 Codex 桌面行为一致。codex app-server 常驻进程 cwd 固定，preset 档与 worktree 隔离不叠加。
- **前端**：`runPermissionOptions` 检测到 `danger-full-access` 标记位即用官方四档替换自造档；`PERMISSION_MODE_META` 文案与桌面菜单逐字对齐；`nativePermissionToComposer` 补三个原生→composer 映射；席位编辑器权限选项给原生 id 配人类可读标签；斜杠命令 `/ask /auto /full-access /config` 同样按预设族分流。自动化编辑对话框仍是 plan/review/build 静态档（未知档回落 plan，fail-closed）。
- **验证**：adapter 59/59（新增官方预设映射 7 例：四档 + plan/read-only fail-closed + config-default 无覆盖）；orchestrator 61/61（新增预设映射四档、非拥有者只读、审批门未触发、族外 adapter 拒绝、未知档拒绝）；workbench 契约 14/14；全量见本轮 npm test 输出。


## 会话控制热改（2026-08-10）

> 起因：续聊会话的模型/Effort/权限被"会话配置已固化"一刀切隐藏，想调只能新建任务、丢上下文。
> 深查后分层：Effort 在 codex turn/start 与 spawn argv 都是每轮参数（误封）；Codex 模型与
> sandbox 轴绑 thread/start（真固化）；ask↔auto 只差 turn 级 approvalPolicy（误封）；
> 权限降档写面收缩（安全但被一并封死）。

- **后端 `updateRunControls`**：`PATCH /api/runs/:id/controls`。闸与 `continue()` 准入对齐——`waiting_approval`（改动会污染动作绑定审批语义）拒绝；`recovery_required`（提交状态不明）未确认拒绝，确认可随热改一次性携带（见"恢复确认随热改一次性携带"节）；succeeded/failed/cancelled 的闲置会话可改，下一轮派工生效（`effectiveModelFor`/`effectiveEffortFor`/权限映射本就每轮重读 run 字段，此前只是没有写入口）。Effort 校验与创建路径同源（动态发现优先、静态兜底、空串清除 override）。每次实改落 `run.control_changed` 审计事件（field/from/to/actor），同档幂等不产事件。
- **权限迁移白名单 `PERMISSION_HOT_TRANSITIONS`**：只放行机制上每轮可改、治理上安全的迁移——降档（build→review/plan、review→plan，不触发审批门）与 Codex ask↔auto（同 workspace-write sandbox，只动 turn 级 approvalPolicy）。升 build 仍必须走创建时动作绑定审批门；Codex sandbox 轴（read-only/workspace-write/full-access/config 互转）绑原生 thread，拒绝并如实提示新建任务；跨族迁移（如 plan→ask）同样拒绝（`CONTROL_TRANSITION_FORBIDDEN`，409）。
- **前端**：续聊时只隐藏模型 picker（真固化），Effort/权限 picker 放开；权限选项收窄为"当前档 + 可热迁移档"（`continuingPermissionOptions`，与后端白名单严格同表），pill 菜单同步收窄；change 直接 PATCH，失败 toast 原因并回滚 select；CLI 操作台 chips 续聊时只放行可热迁移项（模型与沙箱轴档禁用）；不再写成员草稿（草稿是下一个新任务的默认值，不能被现有会话污染）；SSE 重载闸补 `run.control_changed`。
- **文案如实**："会话配置已固化"改为"会话配置·部分可热调"；说明改为"模型与 Codex 沙箱轴随原生会话固化；Effort、权限降档与 ask↔auto 可热调，下一轮生效"。
- **验证**：orchestrator 64/64（热改下一轮生效、白名单全迁移矩阵、降档不触发审批、approval-pending/recovery 闸、闲置 succeeded 可改）；workbench 契约 15/15；全量见本轮 npm test 输出。


## 模型热改：turn/start per-turn model（2026-08-10）

> 起因：LO 指出 CLI 里 `/model` 可会话中自由切换，质疑"模型随原生会话固化"。
> 深查认错：此前"模型绑 thread/start 真固化"判断错误——那是我们 adapter 实现只在
> createThread 传 model 造成的自造约束，不是协议约束。

- **实证**（`.scratch/probe-codex-turn-model.mjs`，本机 codex 0.146.0）：thread/start 绑 `gpt-5.6-sol`、turn/start 要 `gpt-5.5`——被接受，触发 `thread/settings/updated`，轮正常完成。与 CLI `/model` 同一机制。社区 issue 亦印证 turn/start 有 per-turn `model`（openai/codex#31552 的复现参数即含 model 字段）。
- **adapter**：`turn/start` 在有 override 时下发 `model`，无 override 不下发（跟 thread 默认）。续接轮因此每轮都可切换。
- **orchestrator**：`updateRunControls` 支持 `model` patch（空串清除 override）；模型/Effort 校验抽为 `validateModelOverride`/`validateEffortOverride` 共享方法，create 与热改同源，不再有两套口径可漂移。
- **前端**：续聊时模型 picker 与 chips 同步放开（选项 = 席位目录/动态目录，与创建同面）；沙箱轴（权限跨档）仍是唯一真固化项，文案改为"Codex 沙箱轴随原生会话固化；模型、Effort、权限降档与 ask↔auto 可热调，下一轮生效"。
- **边界**：turn/start 的 model 是 per-turn 覆盖，thread 初始模型不变；模型目录外的 id 仍被白名单/正则 fail-closed（INVALID_MODEL）。spawn 型 adapter（claude/kimi/grok）argv 本就每轮带模型，无需改动。
- **验证**：adapters 60/60（turn/start model 下发/省略两例）；orchestrator 64/64（热改 model 下一轮生效、INVALID_MODEL、changes 顺序）；workbench+composer 20/20；全量见本轮 npm test 输出。

## 恢复确认随热改一次性携带（2026-08-10）

> 起因：LO 在恢复条挂着的时候热改，被 `RECOVERY_REQUIRED` 英文黑话拒绝——"确认恢复"唯一
> 通道是发消息（立即用旧配置跑一轮），想"先确认、换好模型/Effort 再续聊"做不到。

- **后端**：`updateRunControls` 增加 `acknowledgeRecovery` 选项。`recovery_required` 未确认仍硬拒（闸与 `continue()` 准入对齐不变）；确认随热改携带时，与 `continue()` 同一 `acknowledgeAbandonedWork` 语义（作废 resumeClaim/activeSteer/inflight 记账、可退轮次退还、落 `recoveryAcknowledgedAt`），但不跑轮——状态停在 `failed` 闲置终态（可续聊、可再热改），`recoveryNote` 如实记录"已确认放弃"。**原子性**：确认+改档+落盘在同一 try 里，任何校验/落盘失败整体回滚（status/override/abandonment 快照），事件只在落盘成功后播报；新增审计事件 `run.recovery_acknowledged`（热改路径不静默）。
- **HTTP**：`PATCH /api/runs/:id/controls` 的 body 拆出 `acknowledgeRecovery`（`=== true` 才认），不混进 patch 字段。
- **前端**：`applyRunControlChange` 在 `recovery_required` 且恢复条未确认时本地拦下（中文提示先点"确认恢复并继续"，不再把英文服务端消息糊脸）；已确认未发送时把一次性确认标记随 PATCH 消费（与发送链路同语义），成功后恢复条随状态翻页消失。SSE 重载闸补 `run.recovery_acknowledged`，治理注记落琥珀条。
- **验证**：orchestrator 闸门测试扩展（未确认拒绝 / 确认+校验失败整体回滚 / 确认+改档原子成功落两事件 / 翻页后热改回归免确认）；workbench 契约补签名、路由、前端接线断言；全量见本轮 npm test 输出。

## 团队树严格归属制 + 「未归属」虚拟组（2026-08-10）

> 起因：LO 发现"会话有任务、团队树下却没有对应项目文件夹"。深查两层：该文件夹实际被
> 人工 hidden（prefs 可恢复，非缺陷）；但树模型"未归属项目在所有团队可见"本身也不对——
> 任何团队的树都被几十个历史项目灌满，归属语义形同虚设。LO 拍板：团队下面只应该显示其对应项目。

- **树模型 `projectTreeModel`**：严格归属——团队节点只挂 `explicitTeamId === selected.id` 的项目。未归属（null）与归属已失效团队（旧数据）的进 **`UNASSIGNED_TEAM_NODE_ID` 虚拟组**（渲染在团队节点下方，整组压暗，默认展开）：08-08"项目不能整片消失"的底线保留，但不再混显。组为空不渲染。从组里右键「从属团队」归属后项目即迁走。行级 `unassigned-badge` 随混显语义退役（所在组已表达该信息）。
- **创建任务自动归属 `assignCwdProjectToTeam`**：`createRun` 成功且选了目录时，项目未归属才自动归属创建团队——归属是创建动作的如实记录；已显式归属其他团队的不抢（不在 A 团队建任务就把 B 团队的项目静默迁走）。新目录流（`addPendingProject`）本就在选定目录时预写 teamId，此处补齐"既有未归属项目"与"选目录后又换了团队"两个缺口。
- **边界**：会话级跨团队从属（loose session）语义不变；置顶区仍按 `effectiveProjectTeamId`（未归属回落默认团队）过滤，未归属置顶项目只在默认团队 rail 出现——存量行为，未动。
- **验证**：workbench 契约改写（严格过滤、虚拟组渲染/空组不渲染、自动归属接线、死徽标清除）；全量见本轮 npm test 输出。

## 项目树按协作会话聚合跨 CLI 对话（2026-08-10）

> 起因：严格归属制落地后 LO 发现项目树下按 CLI 分组（Claude·N / Codex·N…）太乱——
> 一次协作的 kimi/codex/deepseek 对话被拆散在各 CLI 桶里，看不到"它们是同一个任务"。

- **硬关联唯一来源**：Console run 的 `sessions` 映射（成员 → 原生会话 id）。匹配规则：精确（kimi `ses_*`、pi 等）+ 后缀（codex 扫描 id 是 rollout 文件名，尾巴是 thread uuid；≥8 字符防误配）。`runSessionsMap` 归一数组/对象两形态。
- **分组**：`sessionGroupsMarkup` 先按 run 聚合（组头=run 标题+时间；成员行=成员标签 chip + 原生会话链接，点击开原生预览），未关联会话仍按 CLI 分组（原逻辑抽为 `cliSessionGroupsMarkup`，行为不变）。run 组按最近活跃排序挂前面。
- **折叠**：组头 chevron 折叠/展开（默认展开，收起态存 `collapsedRunGroups` 内存 Set，刷新归展开）；行尾「打开」按钮进 run（`data-run-select`）。折叠委托只做 hidden 切换 + aria 同步，不全量重渲染（保焦点纪律）。
- **不猜不并**：裸 CLI 打开的会话没有 run 记录，不做时间邻近聚类——那是另一个功能，需 LO 另行拍板。
- **新鲜度**：`renderRuns` 尾补 `renderProjects()`（`commitMarkup` 幂等，markup 不变不写 DOM，不抢焦点），run.sessions 翻页即反映到树。
- **验证**：workbench 契约新增聚合测试（索引/匹配/排序/组头接线/成员标签/翻页联动/样式）；全量见本轮 npm test 输出。

## run 组点击与会话列表一致化（2026-08-10）

> 起因：LO 发现项目树里点 run 聚合组（组头/成员行）落的是"原生会话只读预览"，
> 而从会话列表点同一个 run 是完整时间线（轮次/工具卡/失败卡/恢复条）——
> 同一对象两个入口两种画面。LO：点击画面应该一致。

- **组头与成员行点击 = `selectRun`**：协作会话组整体（除折叠 chevron 外）与会话列表点 run 完全一致——直接打开 run 完整视图。行尾「打开」按钮随冗余退役；成员行不再带 `data-session-*`（不再落原生只读预览，预览委托按属性匹配，无串扰）。
- **chevron 拆独立按钮 `.run-group-toggle`**：折叠/展开是唯一独立动作（button 不能嵌套 button），`aria-expanded`/`aria-controls` 随迁；折叠委托不变（hidden 切换 + aria 同步，保焦点）。
- **选中态**：组头 `is-selected`（`--sidebar-active` + rose 内阴影，与 session-link 选中同风格）；链路 `selectRun → openTab → renderRuns → renderProjects` 已有，树随选中翻页。
- **取舍**：run 关联会话的右键管理（重命名/隐藏）随成员行 `data-session-*` 一起退场——run 组语义下成员是 run 的一部分；裸 CLI 组的会话仍保留原生预览与右键（那不是 run，没有 run 视图可看）。
- **验证**：workbench 契约断言改写（独立 toggle、组头/成员行 `data-run-select`、选中态样式）；全量 869 测试 0 fail。

## 活跃呼吸行接入「正在思考」（2026-08-10）

> 起因：LO 要 Codex 官方桌面端那种运行状态（截图「正在思考」）。盘查发现呼吸行机制
> （liveTurnMarkup：agent 头像 + 相位文案 + 三点动画 + 已运行时长）早已存在——缺的是
> 「思考」这个细腻相位：模型长考时没有 command/file 活跃 item，呼吸行只剩相位文案，
> 与 Codex 官方可见度差一档。

- **adapter（codex-app-server）**：reasoning 的 `item/started` 不再丢弃——无摘要也发 `{ kind: "reasoning", id, started: true }`（item/started 只喂活跃行、不进历史卡，不添噪声）。完成态无摘要时保留 `{ kind: "reasoning", id }`：started 侧已记活跃，completed 没 id 前端清不掉，「正在思考」会残留成假活——这是本次最容易踩的坑。
- **前端活跃行**：`trackCodexActivity` 白名单加 reasoning；`codexActivityText` 返回「正在思考」。与 command/file 交替自然正确（取最新活跃）：思考→执行命令→再思考，呼吸行文案跟着翻。
- **历史卡防空**：无摘要 reasoning 完成态在 `eventAffectsConversation` 与磁盘重建路径（9334）双重排除，不落空的「推理摘要」卡；有摘要时历史卡行为不变。run 收尾清残留逻辑通用，覆盖 reasoning。
- **边界**：kimi/gemini 等席位的事件流没有 item 级思考信号——不猜不假活，它们的呼吸行继续显示相位文案；哪家 CLI 以后暴露等价事件，按同一机制接即可。
- **验证**：codex-process-visibility 契约改写（started 信号/无摘要保留 id/白名单/文案/历史防空）；全量 869 测试 0 fail。

## 审批后流卡死修复 + 发送/停止双态键（2026-08-10）

> 起因一：LO 报「审批批准之后前端长期不输出，刷新就正常」。根因：审批等待期间会话流
> 较大走 batched 挂载（replaceConversationStreamBatched），其中任何一步抛异常都让
> `aria-busy` 永久停 true——此后 SSE 的 selectedRun 更新在 flushEventRenderBatch 的
> busy 闸无限 rAF 空转，界面假死；刷新（全量重挂）才恢复。异常被 `void` 吞掉无诊断。
> 起因二：LO 要发送键随工作状态改变（对齐官方），可以停止工作。

- **根治（挂载异常兜底）**：batched 挂载主体包 try/catch——异常时 release ownership、**清 aria-busy**、`appendDiagnostic` + console.error。渲染异常不再永久卡死流，后续 SSE 事件照常触发重渲。自殁路径（新挂载已接手）不清闸是有意的，保持不变。
- **防御（busy 闸超时复位）**：`flushEventRenderBatch` 的 busy 等待加帧数上限 `STREAM_BUSY_WAIT_MAX_FRAMES = 600`（≈10 秒前台帧；正常分批挂载 160 条上限、8 条/批几秒即完）。超时视为僵死：作废旧挂载代际（`conversationRenderGeneration += 1`，旧挂载 stillOwned 检查令其自殁）、删 pending、清闸、完整重渲，并落诊断。即使根治层失效也不再假死。
- **发送/停止双态键**：`syncSubmitButtonMode()`——续聊 + run 活跃（ACTIVE_RUN_STATES）+ 非预览 + **输入为空** → 停止键（circle-stop 图标、加深填充、`.send-button.is-stop`），点击在 submit 入口拦截走 `cancelSelectedRun`（沿用级联取消确认弹窗，不新增危险路径）；**有输入** → 发送键（轮间插话能力不被停止键吃掉）。审批挂起时输入仍禁用，但停止键例外可用——它是此时唯一有意义的动作。联动点：`setComposerMode` 每次重算 + task-input 的 input 事件。
- **验证**：composer-target-ui 契约新增双态测试（计算/拦截/审批例外/联动/样式）；workbench 契约新增防卡死测试（try/catch/清闸/超时上限/代际作废）；全量 872 测试 0 fail。

## 已决议审批卡聚合（2026-08-10）

> 起因：LO 报「审批批准堆叠在最后」——`inlineApprovalOutcomes` 只增不聚合，Codex 席位
> 每改一次文件触发一次审批，流尾就堆一列相同的「动作审批已批准」行。

- **按结果聚合**：已决议行按 approve/deny 各出一条——「动作审批已批准 ×5 · 最近 14:55:17」；审计语义保留（次数 + 最近时间），`resolvedAt` 时间戳随决议落账。拒绝单独成行：fail-closed 信号不折叠进批准里。
- **data-stream-key 改稳定键**（`approval-result:{decision}:{runId}`）：聚合行重渲染幂等，不再按 approval id 逐条新增 DOM。
- 待审批卡行为不变（逐张逐张操作）；租约卡不变。
- **验证**：workbench 契约新增聚合断言；全量 874 测试 0 fail。

### 停止键被原生表单校验拦下（2026-08-10 补丁）

> LO 点停止键弹「请填写此字段」：`task-input` 带原生 `required`，停止键是
> `type="submit"`——点击时浏览器原生校验先拦（空输入正是停止场景），JS 拦截到不了。
> 修复：停止模式挂 `formnovalidate`（send 模式移除、保留空输入校验原行为）。


## 供应商管理接入 Kimi Code（2026-08-10）

> 起因：LO 要在供应商管理里把 Kimi Code 当第九个 app 管起来（统一档案一处录入、
> 按 app 投影 live 配置）。此前 kimi 席位是 `cli-managed` 孤岛——auth 全扔给 CLI 自己，
> 绑不了统一供应商档案。全程以官方文档为准（kimi.com/code/docs：providers.html /
> config-files.html / env-vars.html / mcp.html / skills.html），不臆造字段。

- **投影（#applyKimi）**：`~/.kimi-code/config.toml` 顶层 `default_model`（spliceToml 顶层键摘换语义）+ 514 标记块内 `[providers."514cc:<key>"]` / `[models."514cc:<key>/<model>"]` 双表。provider type 封闭六值（kimi/anthropic/openai/openai_responses/google-genai/vertexai），缺省按 `meta.apiFormat` 映射、兜底 openai；`meta.appConfig.kimi` 支持 providerType/maxContextSize/capabilities/supportEfforts/defaultEffort（capabilities 缺省 thinking+image_in+tool_use——第三方模型名前缀自动识别常落空，tool_use 是 agentic 硬需求）。块外用户自有 managed 登录态/services/hooks 一律不动；模型缺失拒写（default_model 必须指向已声明别名）。
- **spliceToml 扩多 section**：新增 `sections` 数组形态（块内多表，表间空行），旧 `sectionName/sectionBody` 单 section 入参等价转换，codex 路径零变化。
- **回读（liveStatus.kimi）**：marker 认亲优先；base_url 只在 514 管理块内回读——块外用户 providers/services 也写 base_url，全局匹配必认错人。
- **envConflicts**：kimi 监视的是 `KIMI_MODEL_NAME/API_KEY/BASE_URL/PROVIDER_TYPE`（内存合成临时 provider、压过 default_model 投影）；凭据类 KIMI_API_KEY 官方明说 CLI 不读 shell，不监视。
- **adapter（manifest）**：kimi 模板 `providerApp: "kimi"` + `serialized-live-projection`——席位可绑统一档案，派发前 `withProviderProjection` 串行切换投影；未绑定时行为不变（CLI 自管登录态）。连接编辑入口（open-connection）自动出现。
- **domain（ccswitch）**：`#configDir` 加 kimi=`~/.kimi-code`——MCP 物化走默认 `mcpServers` 分支写 `mcp.json`（文档实证）、Skill 物化 `~/.kimi-code/skills/<name>/`（官方用户级技能目录，#skillTarget 天然吻合）。Prompt 面明确不收录：官方文档没有用户级全局 Prompt 文件（只有项目级 AGENTS.md），domain 与面板双侧排除，不臆造路径。
- **UI**：PROVIDER_APP_META/对话框勾选与模型块/通用配置 tab/团队绑定下拉/预设网格全链路；预设手写三条（Kimi 开放平台、Kimi For Coding、DeepSeek——sourceFiles 如实标注无 sha，非 cc-switch 转换品）。
- **易踩坑**：①providerKeyOf 对 CJK 名折叠成短 key（"LO 验证专线"→"lo"），断言别猜全称；②validator-governance 的「结构性矛盾」探针原本用 kimi 模板（彼时 providerApp=null），改用 pi-rpc 保持 fail-closed 语义；③domain 的 PROMPT_APPS/SKILL_APPS 由 PROVIDER_APPS 派生，新增 app 必过一遍物化路径清单（MCP/Skill/Prompt/configPaths）——本次 2 红全在这。
- **验证**：providers 契约新增 kimi writer 两例（双表投影/切换摘换/apiFormat 映射/拒写/preview 干跑/env 监视）+ spliceToml 多表纯函数例；domain 契约并入 kimi MCP/Skill 物化断言；真机干跑——投影进 LO 真实 config.toml 副本（16 hooks/services/managed 登录态全保留），`kimi doctor config` 官方校验「All checked config files are valid」，`kimi provider list --json` 认到 `514cc:lo` provider 与其模型目录（模型发现链路同步验证）。全量 876 测试 0 fail。


## Kimi 官方登录态回读（2026-08-10 补丁）

> 起因：LO 官方 OAuth 登录（`managed:kimi-code`，凭据 CLI 自管），供应商管理 live 卡落进
> 「未检测到自定义端点」空态——liveStatus.kimi 只认 514 管理块，官方登录态完全不认。
> LO 要求：官方登录的 kimi code 也应显示为「正在使用的供应商」。

- **liveStatus.kimi 扩 official 分支**：514 块内无 base_url 时切片回读 `[providers."managed:kimi-code"]` 表体（表头→下一表头或文件尾，手切不赌正则边界）；`type = "kimi"` +（`oauth` 子表存在 或 base_url 命中 `api.kimi.com / api.moonshot.cn / api.moonshot.ai` 官方域名）→ `official: true`，baseUrl 回填 managed 端点供认亲与显示。第三方网关冒充 managed 块（非官方域名、无 oauth）不报 official、不回填、不认亲——域名白名单是防误报的硬闸。514 块在场时 official 退让，live 真源仍是切换态。
- **UI（live 卡）**：official 分支文案「live：官方登录（managed:kimi-code）· 端点 · 模型 X · 端点已认亲/未关联档案」；行列表空态时占位文案换「正在使用官方登录（凭据由 CLI 托管），尚未关联供应商档案。」，`新增/关联` 按钮保留（官方态只是显示层认亲，OAuth 凭据绝不落档案——仓库铁律）。
- **验证**：providers 契约新增一例串四场景（OAuth 态识别/同端点档案认亲/文件尾 managed 表识别/第三方冒充拒认/514 切换态退让）；全量 877 测试 0 fail。


### 官方登录态虚拟行（2026-08-10 补丁二）

> LO 反馈：official 态只显示一行 live 文案不够——要对齐 Claude Official 档案行的卡片形态
> （图标 + 官方徽章 + 端点 + 模型行 + 主按钮），一眼看到「正在使用的供应商」。

- **officialLiveRowMarkup**：live 检出官方登录且档案库无同端点档案（`matchedProviderId` 未认亲）时，行列表置顶合成虚拟行——`is-current` 高亮 + `live`/`官方` 徽章 + 端点链接 + 「模型：X · 凭据 CLI 托管」元行，形态对齐 `providerRowMarkup`；操作面只有「存为档案」，不给启用/编辑/删除/测速（无档案 id 可指）。同端点档案已存在时真实行自带 live 认亲标记，不重复合成。
- **存为档案链路**：`data-provider-archive-official` 点击委托 → `openProviderDialog(null, { app, prefill })`；`fillProviderDialog` 新增 `prefill`（name/baseUrl/websiteUrl/notes/category），预填「Kimi Code 官方」+ live 端点 + `official` 分类 + 托管说明。保存后即真实档案行并自动端点认亲——OAuth 凭据全程不落档案。
- 占位文案的 official 分支随之成为死代码（official 必有虚拟行），一并摘除。
- **验证**：`node --check` 通过；全量 877 测试 0 fail（UI 渲染层无契约覆盖，逻辑改动最小化在渲染与委托两点）。

## 聚合会话右键菜单（2026-08-10 补丁三）

- **病灶**：`contextmenu` 委托的 run 分支限定 `.run-rail-list [data-run-select]`，项目树协作聚合组（组头 `run-group-head` / 成员行 `run-member-link`）虽带 `data-run-select` 却不在 run 轨道内——右键落不到任何分支，弹浏览器默认菜单；与点击链路（`[data-run-select]` 通用匹配）不一致。
- **修法**：run 分支选择器放宽为通用 `[data-run-select]`，聚合组头/成员行右键与 run 轨道共用 `runContextItems`（置顶/重命名/归档/复制会话ID/新窗口打开等）；折叠 chevron（`data-run-group-toggle`）不带 run-select，单列一小分支归属同一 run 菜单。
- **验证**：`node --check` 通过；全量 877 测试 0 fail。真机确认项：聚合组头/成员行/chevron 三处右键弹体系菜单，菜单项动作落在正确的 run 上。

## CLI 分组折叠（2026-08-11）

- **诉求**：项目树下未关联会话的 CLI 分组头（Claude · N / Codex · N…）此前是纯文本标签（`aria-hidden`），不可折叠——多 CLI 项目历史会话一屏铺到底。
- **形态**：`cliSessionGroupsMarkup` 分组头改为 `<button class="cli-group-toggle">`（chevron + 图标 + 标签 · 计数），成员行收进嵌套 `<ul class="cli-group-members">`；与协作组同一纪律——`hidden` 切换 + aria 同步的 DOM 手术，不做全量重渲染保焦点。单 CLI 项目仍不出分组头（项目行自身即可折叠），行为不变。
- **状态**：`state.collapsedCliGroups`（键 `${projectId}:${cli}`）存内存不持久化，与 `collapsedRunGroups` 同策略。
- **样式**：`.cli-group-toggle` 继承 `.cli-group` 排版（10px/字距/soft 色），chevron 12px 旋转 90° 与 `run-group-toggle` 一致；`.cli-group-members` 左缩进 10px。styles.css 为 CRLF 混合行尾，Edit 锚点匹配失败，本轮用 Python 定点插入（保持 CRLF 不翻行尾）。
- **验证**：`node --check` app.js/state.js 通过；全量 877 测试 0 fail。真机确认项：多 CLI 项目下分组头点击折叠/展开、chevron 旋转、成员会话点击仍正常。

## 归档 run 退出项目树聚合（2026-08-11 补丁）

- **病灶**：轨道列表渲染有 `!run.archived` 过滤（app.js:2338/2384），但树聚合 `sessionGroupsMarkup` 合成 runGroups 时漏了同一过滤——已归档协作会话仍以分组形态挂在项目树下（LO 截图两个「协作」组即此）。
- **修法**：`linked` 合成 runGroups 前加 `.filter(({ run }) => !run.archived)`。成员会话留在 linked 消费链里不散回未关联区（归档是隐藏不是拆伙）；取消归档经 `patchRunMeta → renderRuns → renderProjects` 整组原样回来。归档入口仍是轨道「已归档」抽屉。
- **验证**：`node --check` 通过；全量 877 测试 0 fail。真机确认项：归档协作会话后项目树立即消失，已归档抽屉可见，取消归档后树内复现。

## 左栏 Codex 化（2026-08-11 第二波）

- **分区顺序对齐 Codex**（index.html 纯移动，id 不变 JS 不动）：操作行（新建任务 + 搜索）置顶 → 置顶区 → 团队项目树 → 会话/正在工作/自动化/已归档。搜索行（`rail-search-row`，ghost 样式）调 `openForgePalette()` 命令面板。
- **「项目 ▾」分区头**：团队头改 `team-tree-toggle` 按钮（chevron 旋转 + hidden 切换整棵树，`state.teamTreeCollapsed` 内存态）；头内新增「+」按钮（`team-newsession-button`，与 new-session-button 同走 openSessionDialog）。全分区头的 `.rail-action` 改为悬停/聚焦浮现（Codex 的「…」「+」形态；aria-expanded=true 的筛选钮常显）。
- **项目行文件夹图标**：`project-toggle` 内 chevron 后加 `lucide-folder`（13px muted）。
- **「展开显示」截断**：`sessionGroupsMarkup` 块化合成（协作组块 + `cliSessionGroupBlocks`），超 `TREE_SESSIONS_CAP=6` 的尾部块折叠为「展开显示（还有 N 条）」行——块级收编不拆组内成员；点击进 `state.showAllSessions`（内存态）并重渲染该列表，焦点让位首个可交互行。`cliSessionGroupsMarkup` 保留为块接口的拼接包装。
- **契约更新**：workbench-rail-and-tools-contract 的旧组装行断言（`return runGroups + cliSessionGroupsMarkup(...)`）替换为块化/截断五断言。
- **验证**：`node --check` 通过；全量 877 测试 0 fail（首轮 ccswitch-domain rename EPERM 为既有沙箱抖动，复跑即绿）；index.html 无重复 id。真机确认项：操作行/置顶位置、搜索行开命令面板、团队头折叠与「+」、分区头按钮悬停浮现、长会话列表截断与展开。

## 团队树拍平（2026-08-11 第三波）

- **病灶**：分区头「⌄ 团队 + 计数 + 折叠」与树内团队节点行（同名同计数同折叠）是两个叠着的相同控件（LO：功能重复的图案都是用来折叠）。Codex 无此层：「项目 ▾」下直接是项目。
- **修法**：当前团队项目平铺进树（`.team-projects-flat` 零缩进），分区头标签同步为当前团队名（`team-rail-title` 入 cacheElements）；`teamNodeMarkup` 成死代码已删；`expandedTeams` 初始化不再为选中团队记账。
- **顺手修 live bug**：未归属虚拟组折叠后再展开走 `model.teams.findIndex("__unassigned__")` = -1，误报「团队已不存在」——委托里为 `UNASSIGNED_TEAM_NODE_ID` 单列分支，从 `model.unassignedProjects` 重建。拍平后它是 `data-team-toggle` 唯一消费者。
- **验证**：`node --check` 通过；全量 877 测试 0 fail。真机确认项：分区头显示当前团队名、树内无重复团队行、未归属组折叠/展开正常、筛选 chips 面板开合如旧。

## 项目树行美容（2026-08-11 第四波）

- **病灶**（LO 截图「感觉不太美观」）：①行尾「写」「…」按钮 opacity 0 仍各占 28px——项目行计数被迫左移、未归属行贴右，数字列参差不齐；②未归属行缺文件夹图标，与项目行轮廓不一；③团队头 pane-heading 是 space-between 五子均摊，长团队名与图标/计数互相挤压。
- **修法**（CSS 为主）：行尾动作静止时 `width:0` 坍缩（含 margin/overflow/opacity，140ms 过渡），徽标计数全行统一贴右，悬停/聚焦展开 28px——不动 DOM、键盘 focus-within 同样展开；未归属行补 `lucide-folder`；团队头改 flex-start + toggle flex 1 + h2 省略号截断，动作与计数右簇。
- **验证**：全量 877 测试 0 fail。真机确认项：计数列对齐、悬停动作推出动画、长团队名省略号、未归属行图标。

## 新任务模式选择守卫 + 「…」菜单常显修正（2026-08-11 第五波）

- **病灶 2（笔按钮点了画面不换）**：`loadRuns` 轮询的自动选择（`!selectedRunId → 选活跃/首个 run`）不区分「从未选过」与「用户显式清空」——笔按钮/新任务把 selectedRunId 置 null 进入新任务模式，下一次轮询（秒级）就把旧 run 刷回会话区，toast 说切了画面却没切。
- **修法**：`state.selectionClearedByUser` 记账——9 处显式清除点（命令面板/继续任务×3//new/会话对话框/retryRun/笔按钮/composer 新任务/关最后页签）置 true；`activateTab`（一切用户选中的漏斗：rail 点击/openTab/页签）与深度链接、选中失效三处复位 false；loadRuns 自动选择只在 `!selectionClearedByUser` 时补位。
- **病灶 1（图标消失）**：行美容波把「…」菜单（`row-action row-menu-action` 双类名）也卷进了宽度坍缩——它原本是常显 0.68 的，LO 视为消失。修正：文件尾追加恢复规则，「…」常显（悬停 1.0），仅「写」按钮保持悬停坍缩；未归属行右垫 38px 对齐徽标线。
- **验证**：`node --check` 通过；全量 877 测试 0 fail。真机确认项：笔按钮点后会话区切到 agent 选择器且轮询不回跳；「…」常显、悬停「写」推出；选中失效（run 被清除）仍能自动接力选中。

## 「…」图标填充化（2026-08-11 补丁）

- **病灶**：`MENU_ICONS.more` 是三个 stroke 零长段（`h.01`），12px 展示尺寸下每点不足 1px 视觉隐形——菜单能开（按钮在）但图标空白，LO 两次报「图标没有显示」。
- **修法**：glyph 改填充圆点（`a2 2 0 1 0` 弧三段，x=6/12/18），path 级 `fill="currentColor" stroke="none"` 压过 `.icon` 继承值；仅 menuTriggerMarkup 单处消费，右键菜单内其他 MENU_ICONS 不受影响。
- **验证**：`node --check` + 全量 877 测试 0 fail。

## 项目启动器 Codex 式两步向导（2026-08-11）

- **形态对齐 Codex「创建项目」**：第一步「项目类型」大卡片（图标左上、单选圈右上、名称+一行说明、选中态玫瑰描边+填充圈）——本地（terminal 图标，sprite 无 laptop 用近义）可用，远程（globe）占位禁用挂「暂未接入」徽标，不假装可用；「下一步」右下主按钮。第二步「项目信息」：名称输入带文件夹前缀图标（`boot-input-affix`）、目标目录改大虚线选择区（点击走 `/api/system/pick-directory` 原生目录框，与会话对话框同接口），选中后实线显示路径 + 独立清除钮（按钮不套按钮）；下方保留框架/样式/主题/图标库/字体与实时预览（既有功能不裁）。
- **脚手架管线不动**：startPlan/confirmCreate/各阶段面板原样；「上一步」（chevron 翻转）钉页脚左，重置回到向导起点。
- **验证**：`node --check` 通过；全量 877 测试 0 fail（bootstrapper 无契约钉死）。真机确认项：类型卡片选中态/禁用态、目录选择区全流程、上一步/下一步往返、创建计划管线如旧。

## 新会话对话框 = Codex 式创建项目两步向导（2026-08-11 第二波）

- **LO 指正**：「创建项目页面」指的是新会话对话框（新建任务/笔按钮入口），不是启动器视图——启动器向导化是前一波的误判落点，本波把同一形态搬到正确表面。
- **第一步「项目类型」**：本地/远程大卡片复用 bootstrapper 向导类（全局样式表）；远程禁用挂「暂未接入」；「下一步」进第二步。已定地址（pendingCwd，如笔按钮入口）直进第二步。
- **第二步「项目信息」**：项目名称（boot-input-affix 文件夹前缀，默认取目录名，touched 后不覆盖；仅新目录在 confirm 时写 `updateProjectPref(pending, { name })`，已有项目沿用现名）+ 源文件夹大虚线选择区（`session-dirpick`，has-dir 实线显路径，点击重选，同走 pick-directory）+ 手动输入/datalist 回退（必填校验仍在原 input 上，契约不破）+ 归属 hint 原逻辑。
- **结构性注意**：`addPendingProject` 改为返回 pending（命名要写 pref）；旧 `session-browse-button` 全量退役（HTML/注册表/绑定 0 残留）；提交按钮只在第二步可见，第一步无文本输入故无 Enter 误提交。
- **验证**：`node --check` 通过；全量 877 测试 0 fail。真机确认项：两步往返、类型卡禁用态、目录选择区全流程、名称 pref 落盘、已有项目归属如旧。

## 远程主机视图 = Codex「连接」页 + ~/.ssh/config 自动发现（2026-08-11 第三波）

- **形态对齐**：「来自此电脑的 SSH 连接」标题 + 右上「探测状态 / 添加」；行列表取代卡片网格——玫瑰 toggle（=启用开关，持久化 `host.enabled`，停用即拒连 `SSH_HOST_DISABLED` 并丢池化连接，不假装实时连接）、globe 图标、名称 + 状态行 + 地址行、右侧 exec/SFTP 图标按钮 + ⋯ 菜单（确认指纹/移除）。状态点**如实**：未探测/探测中/已连接/待确认指纹/不可达/已停用，来自 `POST /api/ssh/hosts/:id/test` 真实结果（`SSH_HOSTKEY_UNCONFIRMED`→待确认指纹），行级就地刷新不整树重渲；载入/启用/信任后自动探测，「探测状态」全量重探，状态行可点重探。
- **自动发现**：新模块 `src/ssh/discover.mjs` 只读解析 `~/.ssh/config`（OpenSSH 语义：关键字大小写不敏感、`=`/空格分隔皆可、同块同名先出现者生效、Host 通配块与 Match 块跳过、HostName 缺省回退 alias、引号值去引号；**Include 不递归、IdentityFile 不搬运**——凭据纪律不动）。`GET /api/ssh/discover`（ssh 门闸）返回 `{hosts, source, defaultUser}`；config 不存在是正常空态。添加对话框列出发现条目（默认勾选未登记项，已登记置灰「已登记」），批量登记（User 缺省回落本机用户名，与 ssh 默认行为一致；两者皆无则该项如实报失败）；「手动添加」切换原表单（密码仍只进 secrets 台账）。对话框由 hosts-panel.js 动态建 `<dialog class="action-dialog">`，不动 index.html。
- **服务端**：`create` 支持 `enabled`（默认 true，旧台账无字段视为启用）；`setEnabled` 持久化 + 审计；`connect` 先于指纹判定拒停用主机（409）。SFTP 浏览区原样保留。
- **契约测试**（ssh.test.mjs +3，面内 8/8）：解析器语义（通配/Match/等号/引号/先值生效/回退）、config 缺失空态与真文件解析、enabled 全生命周期（默认启用/停用拒连含 testConnection/新实例持久化/重新启用恢复/create 登记即停用）。
- **验证**：三服务端文件 `node --check`、hosts-panel.js（.mjs 副本）`node --check` 通过；ssh 面 8/8；全量回归见当波记录。真机确认项：toggle 玫瑰态与停用拒连、状态点三态转换、发现列表与 ~/.ssh/config 实际条目吻合、批量登记后指纹确认流程、⋯ 菜单外点关闭。

## 远程主机 ⋯ 菜单遮挡修正（2026-08-11 补丁）

- **病灶**：⋯ 菜单是行内绝对定位子元素，`.sshconn-list` 的 `overflow:hidden` 把它裁掉半截（LO 截图「出现遮挡」）。
- **修法**：列表容器放开裁切（行无独立背景，圆角不漏）；菜单加方向自适应——视口下方空间 <160px 时 `is-up` 向上展开（`bottom: calc(100% + 4px)`），贴底行不再出视口。
- **验证**：`node --check` 通过；全量回归见当波记录。真机确认项：单行/贴底行 ⋯ 菜单完整可见、向上展开方向正确、外点关闭如旧。

## SSH 指纹体验波：一键 TOFU + known_hosts 信任继承 + 真机 verifier 接线（2026-08-11 第四波）

- **LO 之问**：「为什么还需要确认指纹」——514cc 台账有自己的 known-hosts 库（Wave G 指纹三态契约），与 Codex app/系统 ssh 的信任库互不相通；且旧流程要 LO 手动敲指纹（window.prompt），不可用。
- **一键 TOFU**：新 `captureFingerprint(id)`（真连一次只取指纹、即断不入池、不做信任判定）+ `POST /api/ssh/hosts/:id/fingerprint`；前端「确认指纹」改为：抓取 → 弹窗展示 `SHA256:…` 请 LO 核对 → 确定即 trust → 自动重探变绿。捕获≠信任（测试钉住捕获后 exec 仍 UNCONFIRMED）。
- **known_hosts 继承**：新 `src/ssh/known-hosts.mjs` 只读解析系统 known_hosts（逗号模式列表、! 否定、* ? glob、|1| HMAC-SHA1 哈希模式、非标端口只匹配 [host]:port、@ 标记行取 key、多 key 按 ed25519>ecdsa>rsa 取一）；指纹格式统一 `SHA256:base64` 去 `=` 填充。discover 每条附 `knownFingerprint`（缺失/不可读静默降级 null）；发现行挂「known_hosts 已信任」绿徽标，批量登记时自动 trust 继承，摘要如实报「N 台登记 / M 台继承」。
- **真机 verifier 窟窿堵上**：旧码把 hostVerifier 挂在 `client.config`（ssh2 根本不读），真实模式下指纹三态从未生效（只 fake 测试里演）；现 connect 配置直入 `hostHash:"sha256"` + `hostVerifier`（台账一致 true、未信任/变更 false 交 ssh2 收尾），预检三态仍在。
- **契约测试**（ssh 面 13/13，+5 改 1）：解析器全语义、指纹格式去填充、keyType 偏好、discover 继承/降级、TOFU 捕获不授权、停用拒捕获、verifier 接线与放行/拒绝；旧 discover 用例同步 `knownFingerprint:null` 新形状。
- **验证**：`node --check` ×6 通过；ssh 面 13/13；全量回归见当波记录。真机确认项：lanniny-45 一键确认指纹后转绿、批量导入 known_hosts 已信任条目直接绿、指纹核对弹窗内容可核对。

## SSH 认证链 + 预认证指纹捕获（2026-08-11 第五波，LO 截图「获取指纹失败」）

- **病灶 1**：captureFingerprint 等 SSH ready（认证成功）才返回指纹——但主机键在握手阶段先于认证交换，密钥未配的宿主认证必败（"All configured authentication methods failed"），指纹永远拿不到。修法：error 时已捕获指纹即视为成功（TOFU 语义：认证失败≠指纹不可信）。
- **病灶 2（更深的墙）**：无 secret 主机的连接配置没有认证链——不读 IdentityFile、不试默认密钥、不走 agent；就算指纹确认了，test/exec 照样撞同一堵墙。修法（对齐系统 ssh「已配置正常」语义）：
  - discover 解析 IdentityFile（只记路径不取内容），`create` 落 `identityFile` 字段（非密文）；`expandIdentityPath` 按 OpenSSH 子集展开 `~` 与 `%d/%h/%p/%r/%%`；
  - `buildConnectConfig`（替代同步 connectConfig）无 secret 时：`identityProvider`（可注入，默认 identityFile → ~/.ssh/id_ed25519/id_rsa/id_ecdsa 首个存在且未加密 PEM 者）+ agent（SSH_AUTH_SOCK；Windows 缺省 `\.\pipe\openssh-ssh-agent`，ssh2 对不可用 agent 静默跳过）；有 secret 主机绝不触碰密钥链（测试钉住）。
- **前端**：批量导入带 identityFile；手动表单加「私钥路径（可选）」字段。
- **契约测试**（ssh 面 17/17，+4）：认证失败仍捕获指纹、注入 provider 接线 + agent 缺省 + 路径落账、密码主机隔离密钥链、IdentityFile 解析与 token 展开；fixture 注入空 provider 密封真实 ~/.ssh。
- **验证**：`node --check` ×5 通过；ssh 面 17/17；全量回归见当波记录。真机确认项：lanniny-45 确认指纹弹窗正常出现、信任后探测转绿（走默认密钥/agent）、exec 可跑。

## 指纹/命令对话框页内化（2026-08-11 补丁，LO「点击确认指纹其自动闪退」）

- **病灶**：`window.confirm`/`window.prompt` 原生弹窗在桌面壳（Electron 类 webview）里是哑弹——调用被吞、立即返回假值，指纹抓到后流程静默退出，看上去就是「点完闪退」；exec 的 prompt 同雷。
- **修法**：指纹信任确认与 exec 命令输入全部改走页内 `<dialog>`（ensureModal 惰性创建，复用 action-dialog 骨架）。信任对话框展示主机身份 + 等宽指纹块（`.sshconn-fp`，user-select:all 便核对）+ 信任后语义说明；exec 对话框带默认命令、Enter 直发、超时/脱敏提示。Promise 解析纪律：按钮先 resolve 者为胜，Esc/外力关闭兜底 resolve 取消值。hosts-panel 不再存在任何 window.confirm/prompt/alert 活调用。
- **验证**：`node --check` 通过；全量回归见当波记录（前端渲染层无契约覆盖，桌面审查背书）。真机确认项：确认指纹对话框稳定停留、信任后转绿、exec 对话框输入/Enter/取消、Esc 关闭。

## SSH「闪退」根因修复：ssh2 多次 emit('error') 杀进程（2026-08-11 第六波）

- **真相**（真实 lanniny-45 复现脚本拿到 uncaughtException 后坐实）：ssh2 在认证回退链上会**多次** `emit('error')`（agent 初始化失败→继续尝试→最终失败），Node EventEmitter 对无监听器的 'error' 事件**直接 throw 杀进程**。旧码 `client.once('error')` 只接住第一发，第二发到来时监听已消耗→uncaughtException→node 内核死→桌面壳 supervisor 读 stdout EOF 判内核死亡→**整个 app 退出**——这才是 LO 两次「点击后直接闪退」的根因（前一波 window.confirm 哑弹理论只对了半壁：页内 dialog 化仍是对的，但不是闪退主因）。桌面壳 spawn 时 stderr 被丢弃，崩溃栈无痕，增加了定位成本。
- **修法（进程级铁律）**：ssh2 client 的 'error' 监听器**终生在籍**——`once` 全改持久 `on` + settled 闸（首错落定 promise，后续错误静默）；connect 运行期错误审计 `ssh.pool_error` + 丢池（不杀进程），新增 `close` 事件丢池（不池化尸体）。capture 路径语义不变：主机键先于认证交换，已捕获即成功。
- **复现验证**：`.scratch/repro-capture.mjs` 用真实 service 直连 lanniny-45——修复前 uncaughtException(exit 42)，修复后 `CAPTURED OK SHA256:5ef97e4a…` 进程存活。
- **契约测试**（ssh 面 18/18，+1）：fake 升级为双发 error 模拟回退链；capture 首错带指纹即成功、connect 如实拒绝 SSH_CONNECT_FAILED、第二发错误不逃逸（测试跑完即证明进程存活）。
- **验证**：`node --check` 通过；ssh 面 18/18；全量回归见当波记录。真机确认项（重启 app 后）：确认指纹对话框出现、信任转绿、exec 可用、全流程不再闪退。

## SSH sync-config 回同步（2026-08-11 第七波，LO「显示不可达」）

- **病灶**：lanniny-45 在 ~/.ssh/config 里用自定义 `IdentityFile C:/Users/16643/.ssh/ssh`，而台账记录建于 identityFile 波之前（null）——默认密钥/agent 链对这台机无效，认证失败如实显示「不可达」。
- **修法**：新增 `update(id, fields)` 白名单更新（name/host/port/user/identityFile；host/port 变更→删指纹强制重 TOFU，其余变更仅丢池）+ `POST /api/ssh/hosts/:id/sync-config`（discoverSshHosts + `matchConfigEntry`：名称==alias 优先、host+port 端点回退、无匹配如实 404）+ ⋯ 菜单「同步 ssh config」（结果框如实展示同步后参数/私钥路径，自动重探）。
- **真机全链路验证**（`.scratch/verify-lanniny.mjs`，与产品同代码路径）：identityFile 建账 → 捕获指纹 `SHA256:5ef97e4a…` → trust → `testConnection ok` → `exec uname -a` 返回真实 Linux 内核串，ALL-GREEN。
- **契约测试**（ssh 面 20/20，+2）：update 白名单/持久化/端点变更重 TOFU/空白不覆盖；matchConfigEntry 优先序与 null。
- **验证**：`node --check` ×5 通过；ssh 面 20/20；全量回归见当波记录。真机确认项：lanniny-45 ⋯→同步 ssh config → 探测转绿（老记录免重建）；批量导入的新记录本就带 identityFile 不受影响。

## 新会话「远程」卡激活 = SSH 远程终端（2026-08-11 第八波，LO「连接上了但是还是显示暂未接入」）

- **落点选择**：完整「远程项目 = agent 在远端跑」是 v41 级大活（run cwd 语义、orchestrator git/worktree、文件视图全是本地假设），本波不碰。远程卡落地为**真实可用的 SSH 远程终端**：选主机+远程目录 → `POST /api/pty {ssh:{hostId,path}}` → 服务端 spawn 本机 OpenSSH 客户端 → 跳终端视图自动入页签。对话框标题/提交文案按模式切换（远程=「打开远程终端/打开终端」）——诚实文案，不假装远程 agent。
- **认证/指纹归 OpenSSH**：本机 ssh 客户端吃系统 known_hosts 自己管（`-tt -p port [-i identityFile] user@host`，identityFile 走 `expandIdentityPath` 展开 `~`/`%token`），未知主机在终端里就地询问 yes/no——前几波 web ssh2 指纹流程的「为什么还要确认」在这条路线上天然消失（系统 ssh 信任库与 LO 日常一致）。
- **服务端**：`pty.create` 新增 `args`（数组 String 化、拒 NUL、32 项/4KB 帽，超帽如实 400 `PTY_BAD_ARGS`）与 `title`（去 NUL/trim、120 截断，create/list/GET 三处透传）；`POST /api/pty` 加 `payload.ssh` 分支（pty+ssh 双门闸；`getSshService()` 新导出解析台账；主机不存在 404、停用 409、路径含 NUL/超 500 字符 400 `PTY_BAD_SSH_PATH`）；`buildSshPtyArgs`/`sshShellCommand` 纯函数导出（Windows 用 `ssh.exe`——node-pty/CreateProcess 认带扩展名的可执行名）。
- **前端**：远程卡去硬禁用改动态台账驱动——门闸未开「门闸未开放」、零主机「无可用连接/已全部停用」保持禁用，N 台可用则放开并隐藏徽标、填充主机下拉；第二步加 `session-remote-fields`（主机 select + 远程目录 input，本地三件包进 `session-local-fields` 互斥显隐，`session-cwd-input` 的 required 按模式切换否则 form 提交被拦）；类型点击集中进 `selectSessionDialogType`（卡片视觉+状态+模式同步一处）。终端页签标签优先 `session.title`（escapeHtml）回落 shell basename。
- **迟到会话接入**（预判坑坐实）：终端面板只挂载一次，已挂载时新会话不会自己出现——新增 `forge:pty-session-created` window 事件，已挂载面板（终端视图与协作台 dock 两个工厂实例）收到即 `attachSession`（幂等），未挂载忽略（mount 本就会全量列出）。
- **契约测试**（pty 面 10/10，+3）：create args/title 透传与清洗（String 化/NUL/双帽）、buildSshPtyArgs 组装（端口/-i/token/单引号转义/空 path）、ssh 分支路由（ssh 门闸未授权 501、未知主机 404、停用 409、坏路径 400、正常 201 的 argv 与 title、空 path 不带远程命令）。
- **验证**：`node --check` ×6 通过（前端 .js 拷 .mjs）；pty 面 10/10；全量 895 测试 894 pass / 0 fail / 1 skipped（首遍 ccswitch-domain 的 EPERM rename 系 Windows 文件锁抖动，单文件复跑 12/12 通过，与本波无关）。真机确认项：对话框远程卡显示 lanniny-45 可选、第二步标题/文案变「打开远程终端」、提交后跳终端视图出现「lanniny-45 · 路径」页签并进入远端登录 shell（系统 known_hosts 已信任则不询问）、本地流程回归（两步/归属/命名如旧）。

## 新会话打不开热修：elements 固定 id 清单漏登新块（2026-08-11 补丁，LO「点击新建会话没有反应」）

- **病灶**：`elements` 容器是**固定 id 清单** `byId` 收集（app.js 引导段），第八波给对话框新加的五个 id（`session-local-fields`/`session-remote-fields`/`session-remote-badge`/`session-remote-host`/`session-remote-path`）只进了 HTML 没进清单——`openSessionDialog` 首行 `selectSessionDialogType("local")` → `syncSessionDialogMode()` 写 `undefined.hidden` 抛 TypeError，`showModal` 永远到不了；点击处理器里是未处理 Promise 拒绝，界面零反馈，看上去就是「点了没反应」。
- **修法**：五个 id 补登清单；静态交叉核对脚本（grep `elements["session-*"]` 用量 ↔ 清单注册）确认无第二处漏登。
- **教训**：这个 app 的 `elements` 不是自动收集，**给 index.html 加 id 必须同步登记清单**——此类故障 node --check 查不出、无契约测试覆盖，只能靠交叉核对。
- **验证**：`node --check` 通过；交叉核对 20 个 session-* 用量全注册；全量回归见当波记录。真机确认项：新建会话对话框恢复弹出、本地/远程两模式字段与标题文案切换正确。

## 视图切换拼接热修：codex-desktop.css 的 `display:flex !important` 钉死协作台（2026-08-11 补丁，LO「选择界面之后其拼接到主页面下面」）

- **病灶**：`forge/codex-desktop.css` 的 `#view-workbench { display: flex !important; }` 以 id 选择器 (1,0,0) + `!important` 永久压过 styles.css 的 `[hidden] { display: none !important; }`（0,1,0）与 `.view[hidden]`（0,2,0）——`setView` 给 workbench 挂上 `hidden` 也藏不住，切到任何视图协作台都钉在页面上、新视图拼接到下方（实机 Playwright 复现：hiddenAttr=true 而 computed display=flex，view-hosts 被挤到 y=860）。
- **修法**：选择器改 `#view-workbench:not([hidden])`，保留 `display:flex !important` 与全部几何意图，hidden 时规则不匹配、隐藏语义回归。全库扫描确认无第二处对 view 面板钉 display 的 `!important`（其余 4 处均为 topbar/sidebar/workbench-shell/context 抽屉内部组件，随父级隐藏，无害）。
- **教训**：给「会被 `hidden` 切换显隐的元素」写 display 时，`!important` + 高优先级选择器会静默击穿隐藏兜底规则；此类故障 `node --check` 与契约测试都查不出，只有计算样式对比能抓到（复现脚本 `.scratch/repro-hosts-view.mjs` dump 全部面板的 hiddenAttr/display/rect）。
- **验证**：Playwright 实机对照——切 hosts 后可见面板仅剩 view-hosts（y=68 正常位），切回 workbench display:flex 几何与初始完全一致；截图 `.scratch/repro-hosts-view.png` 确认远程主机页独占。qa:ui layout 套件因无头会话拿不到 desktop 壳注入的一次性 bootstrap token（/api/bootstrap 亦 401）未能跑，属环境限制非回归。真机确认项：点任意导航视图，旧视图应彻底消失、不再上下拼接。

## 新建远程项目（2026-08-11 第九波，LO「添加远程项目正确应该是这样的」+ Codex 三张参考图）

- **形态定稿**（参考图锚定）：新会话对话框远程卡 → 第二步「新建远程项目」（项目名称 + 远程主机下拉 + 源文件夹路径行 + SFTP 目录浏览列表）→ 「添加项目」登记 → 项目树出现远程节点（globe + 「主机名 · 已连接」徽标）。第八波的「远程卡=打开 SSH 终端」占位形态被本波替换；打开终端的入口下沉到项目树行尾「写」按钮。
- **第一个 projects 持久层**：本地项目是 CLI 会话目录扫描投影，远程项目无投影源——新增 `src/remote-projects.mjs` 台账（`dataRoot/remote-projects.json`，schema `514cc.remote-projects/v1`，tmp+rename 原子写），记录 `{id, name, hostId, path}`：hostId 只引用 SSH 台账（凭据永不落此文件），path 是 POSIX 绝对路径（`sanitizeRemotePath`：`/` 开头、拒 NUL/反斜杠/`..` 段、≤500）。登记不连网、不探测远端存在性（目录浏览已证明，手输场景如实登记，连不上在消费端如实报错）。错误码：INVALID_REMOTE_PROJECT 400 / REMOTE_HOST_NOT_FOUND 404 / REMOTE_HOST_DISABLED 409 / INVALID_REMOTE_PATH 400 / REMOTE_PROJECT_EXISTS 409；list join 主机公开信息（无凭据），主机被删如实 `hostMissing` 不静默删记录。路由 `src/remote-projects/routes.mjs`（GET/POST/DELETE，元数据面无门闸），server.mjs 挂于 registerSshRoutes 之后（依赖 getSshService()）。
- **前端对话框**：远程卡 desc 改「选择已连接计算机上的文件夹」；第二步标题「新建远程项目」、提交「添加项目」；路径默认 `/home/<user>`（与 ssh.mjs 围栏默认 home 同源）；目录浏览复用 `/api/ssh/hosts/:id/sftp/list`（只列目录、字母序、点击下钻、↑ 回上级、状态机 loading/error/empty；REMOTE_GATE/403 围栏如实降级「可手动输入路径直接登记」）；项目名默认取目录 basename（touched 不覆盖，同本地流纪律）。提交成功清浏览缓存，下开按新台账重来。
- **项目树**：`loadProjects` 独立 try 拉 `/api/remote-projects`（台账故障不拖垮本地扫描，记 `state.remoteProjectsError`）；`remoteProjectTreeNode` 映射——**path 必须 null**（防污染本地 cwd 语义：datalist/归属匹配/reveal），远程信息全挂 `remote` 子对象，节点 id 加 `remote-` 前缀防撞投影；`visibleTreeProjects`/`renderRailMetaSections`/`findProjectById` 三处集合统一并入，`projectRecent` 对远程豁免（无本地会话时间线，按会话过滤是误杀）。行内：globe + `remote-badge`（状态点：trusted=已连接绿/停用或主机缺失压暗/否则待确认指纹，title 全信息含路径）；置顶区共用 `remoteProjectNodeMarkup(pinned)`；展开空态统一 `REMOTE_PROJECT_EMPTY_HINT`（toggleProject/pinned 展开两处点击路径也改）。「写」按钮对远程=打开落在该远程目录的 SSH 终端（`openRemoteTerminalForProject` 复用 pty ssh 面，title=`项目名 · 路径`）；右键菜单 remote 精简分支（置顶/从属团队/打开终端/重命名/移除远程项目 DELETE——本地动作天然无意义，path=null 本已自然禁用）。
- **契约测试**（remote-projects 面 3/3）：sanitizeRemotePath 全分支；service 校验链/持久化回放/同 hostId+path 去重/hostMissing 不静默删/remove 真假；路由状态码（GET 空→[]、400/404/409、201 join 无凭据、DELETE 200→404）。
- **验证**：`node --check` ×4 通过；elements 交叉核对（session-remote-name/up/browser/hint 用量↔清单↔HTML 全 1:1，顺手补登了原漏的 session-remote-hint）；全量 898 测试 897 pass / 0 fail / 1 skipped；Playwright mock-API 实机（`.scratch/verify-remote-project.mjs`）：远程卡可选→第二步表单（默认 /home/lanniny、目录列表过滤非目录）→点 new-api 下钻（路径/名称联动）→登记 POST payload 正确→项目树远程节点（`new-api` + 绿点「lanniny-45 · 已连接」+ title 全信息）——截图 rp-dialog/rp-tree.png。真机确认项：lanniny-45 台账 rootAllowlist 若不含 /home/lanniny，目录浏览会如实显示 403 围栏提示（此时手动输入路径仍可登记，或给主机配 SFTP 根白名单）。

## 远程主机配置图谱：探测 / CLI 安装 / 一键同步本机配置（2026-08-11 v41 波一，LO「参考配置图谱完善远程主机界面」）

- **定位**：v41「远程 agent 工作区」第一波（设计文档 `proposals/v41-remote-agent-design.md`），只做主机面三件套，远程 run 属波二。纯增量：新建 `src/ssh/remote-ops.mjs`（只消费 ssh service 公开方法 exec/update/sftpWrite，不摸内部态），ssh.mjs 仅两处小改。
- **探测**：`POST :id/probe` 一条 shell 脚本聚合回传（health.mjs 探针风暴教训：禁 N 并发 channel）——OS/SHELL/HOME/DISK/MEM + 11 项 CLI 的 `command -v`+`--version` 矩阵，行协议 `OS|…`/`CLI|id|yes|ver` 由 `parseProbeOutput` 纯函数解析。实测 `$HOME` 经 `update` 回写台账（update 白名单加 `home` 字段），后续 SFTP/同步的 home 围栏用实测值（`assertSftpPath` 改 `homeResolver?.(entry) ?? entry.home ?? 默认`，root=/root 形态不再被默认 /home/<user> 围栏误拒）。
- **安装**：`POST :id/install-cli` 复用 cli-env.mjs `CLI_TOOLS`+`installSpec(tool, platform)`（与本地环境面同源，清单不两处漂移）；未知 toolId 404 `REMOTE_TOOL_UNKNOWN`；非零退出如实 `ok:false` 带回 code/stderr，不伪造成功。
- **同步**：`GET :id/env-sync/plan` 出候选清单（.codex/config.toml、.codex/AGENTS.md、.kimi-code/config.toml、.claude/settings.json 四项；auth.json/.env 等凭据文件**永不进清单**），每项带 exists/size/containsSecrets（redaction.mjs `findSecretCandidates` 检出）；`POST :id/env-sync` 实测远端 $HOME → `mkdir -p` → sftpWrite 逐文件回报，叠加 sftp 门闸。错误码 SYNC_FILES_REQUIRED/SYNC_FILE_UNKNOWN/SYNC_HOME_UNKNOWN。
- **命名冲突教训**：端点最初叫 `:id/sync-config`——**已被第七波「从 ~/.ssh/config 回同步主机参数」占用**，同名分支永远路由到旧处理器（调试实锤返回旧分支 404 SSH_NOT_FOUND）。一律改用 `/env-sync` 命名。**加路由前先 grep 既有 prefix 占用**。
- **前端**：hosts-panel ⋯ 菜单加「远程探测」「同步本机配置」；detailHtml 行内探测卡（env-grid + CLI 矩阵，未安装项带「安装」按钮）；安装走通用确认框（明示命令全文）；同步对话框渲染 plan 清单，containsSecrets 红字默认不勾、勾选需二次确认。样式走 python io 追加（styles.css CRLF 纪律）。
- **收尾自检出真 bug**：`planConfigSync` 里 `findSecretCandidates(content).size > 0`——该函数返回**数组**（`[...blockers]`），数组无 `.size`，`undefined > 0` 恒 false，containsSecrets 永远检不出。契约测试的 api_key fixture 当场抓获；改 `.length > 0` 后 6/6。**教训：返回值形态（Set vs Array）以被调方源码为准，别凭名字猜。**
- **契约测试**（remote-ops 面 6/6）：parseProbeOutput 行协议/版本提取/未知 id 忽略；probe 结构化回传+home 回写+非零如实 REMOTE_PROBE_FAILED；installCli 404/npm 命令拼装/非零 ok:false；planConfigSync exists/size/containsSecrets 三态；syncConfig 校验链+mkdir/sftpWrite 流程+本机缺失如实失败；路由门闸（ssh 未授权 501→授权 200、env-sync 叠加 sftp 闸）。
- **验证**：`node --check` ×5 通过（前端拷 .mjs）；全量 904 测试 903 pass / 0 fail / 1 skipped（基线 898+新 6）。未真机点过：LO 实例占着 instance lock（127.0.0.1:51400, pid 47800）起不了第二个，且 API 要 token 无头 401——前端三件套（探测卡/安装确认框/同步对话框）仅经 `node --check` 与契约层背书，真机确认项：⋯→远程探测出配置图谱卡、未装 CLI 点安装（确认框命令正确）、同步本机配置清单与本机实况文件一致、含秘密文件红字拦截。

## 远程 run：agent 会话真正在远端主机执行（2026-08-11 v41 波二，LO「不止是进入终端……类似 codex 只是远程连接了其目录和系统」）

- **形态定稿**：远程项目「写」按钮从「打开 SSH 终端」升级为「在此远端目录建 agent 会话」——composer 提交 `remote:{hostId,path}`（与 cwd 互斥），团队选择器照旧（LO：协作台按团队类型操作配置）；终端入口保留在项目右键菜单。
- **传输层（§3.1）**：ssh.mjs 新增 `openRunChannel`（全双工 streaming exec channel——无 cap/scrub/硬超时，协议字节原样过；看门狗归 adapter 既有 idle/turn 闸）。新模块 `src/ssh/remote-run.mjs`：远端命令套 `cd <path> && setsid sh -c 'printf PGID; exec "$@"' 514cc-remote <cmd> <args>`——setsid 新会话 pgid==pid，首行 `514CC_PGID=<pid>` 由封装在 stdout 首行剥离（跨 chunk 安全、无标记原样放行），绝不进 adapter 协议解析流。
- **fake child 契约**：同步返回异步挂通道（spawnImpl 契约）；stdin=PassThrough 先写先缓冲、挂通道后 pipe 泄入；exit/close/error 与 Node 子进程同序。**绝不暴露 pid 属性**——terminateChildProcessInternal 在 win32 有 taskkill /PID 分支，远端 pid 泄漏=误杀本机进程（进程级铁律，测试钉住）。
- **取消语义（§3.2）**：协议内 interrupt 天然工作（忠实管道）；kill=另开短 exec `pkill -TERM -g <pgid>`（首杀不拆通道保 stdout 尾），二调/KILL 升级 `pkill -KILL` + 拆通道；pgid 未到=通道关闭兜底。只杀自己 setsid 的树，不宽泛模式串。
- **adapter 注入（零侵入本机席位）**：adapters/index.mjs 工厂表抽 `buildFactoryEntries` 共享构建器，`createRemoteAdapter` 同表换实现——spawn 型注入 runProcessImpl（claude/codex-cli/gemini/grok-build 本波补齐 kimi 同款注入点）、常驻型注入 spawnImpl（codex app-server/pi-rpc 既有）；claude 远程 settingsFile/systemPromptFile 置 null（本机路径绝不进远端命令行）；grok-mcp 远程拒绝（MCP 脚本是本机路径）；**fallback 同样远程**（远端 run 绝不回本机执行）；不挂 bindProvider（provider 投影是本机 env 语义）。orchestrator 每 run 每席位缓存 Promise 防并发双建；终态/取消/close 三处漏斗 dispose（close→通道收+pgid kill，不留远端孤儿）。
- **orchestrator 远程分支**：create 校验（互斥/形状/ssh 门闸/主机存在启用/远端 `test -d` 探针仅此一次，422/404/409/501/503 如实）；turn() adapter 解析 remotePair；worktree 链对远程禁用并如实 `workspaceIsolation:"remote-unsupported"`（build 审批哈希 workspace=ssh://hostId path 规范化串，不进本机 resolve）；run.remote 持久化，重启沿用既有 recovery_required 语义。
- **env/凭据（§3.4）**：本地 env/密钥不经命令行/env 出机（runProcessImpl 显式 env:{} + fake child 忽略），远端 CLI 用各自登录态/波一同步的运行时文件。
- **契约测试**（remote-run 面 9/9）：命令行组装转义；validate/assertRunnable 全态（含门闸 501/探针一次）；fake child PGID 剥离/缓冲泄入/事件序/无 pid；kill 三态；无标记放行；runProcessImpl 全链路+abort→pkill；createRemoteAdapter 注入/claude 清零/grok-mcp 拒绝/fallback 远程；orchestrator create 分支/缓存/dispose/审批口径。
- **验证**：`node --check` ×9 通过（前端拷 .mjs）；全量回归见当波记录（基线 904+新 9=913）。未真机点过（同波一环境限制）：真机确认项——远程项目「写」→选 agent→发送，lanniny-45 上起 kimi/codex 会话（`ps` 可见 setsid 树），事件流正常回，停止按钮=远端 pkill 整树，审批（codex app-server 原生）经 SSH 管道原样工作。

## 远程项目聚合 run 台账 + SFTP 快显（2026-08-11 v41 波三，LO「按会话聚合/参考 Codex 界面」）

- **形态定稿**（§3.5）：远程项目节点展开 = 514cc run 台账聚合——协作组头（run 标题+时间）+ 成员行（席位 chip+会话条），复用本地 `runConversationGroupMarkup` 同一渲染器；行尾徽标 = run 数（`project-badge` 与本地同式）。原生 CLI 会话文件在远端主机，本地扫描投影天然看不到，**只聚 run 台账不猜不并**；Codex 式截断同律（TREE_SESSIONS_CAP=6 +「展开显示（还有 N 条）」）。
- **聚合口径**：`remoteProjectRuns`（state.runs 过滤 `run.remote.hostId+path` 匹配 && `!run.archived`，updatedAt desc——归档 run 不进树与本地同纪律）；`remoteRunEntries` 合成条目（sessionId 来自 run 台账持久化、cli=teamRoster runtimeProfileId 前缀、时间取 run）。resume **零改动**：turn() 的 remotePair 由持久化 run.remote 重建远程 adapter，已核查 `orchestrator.continue()`（3299 起）全程无 cwd stat/再校验，波二链路天然支持。
- **四处展开路径同修（本波真正的坑）**：远程展开原全部走 `sessionGroupsMarkup(project, visibleTreeSessions(project))` 本地逻辑——远程项目本地会话恒空，点击展开永远落空态、点「展开显示」整列被刷成「无历史对话」。抽 `remoteProjectSessionItems` 共用函数，修齐四条路径：`remoteProjectNodeMarkup` 渲染态、`toggleProject` 点击展开（7968）、置顶区内联展开（13315）、`data-sessions-showmore` 整列重渲（13250）。**教训：新增一类 project 节点时，grep 全部 sessionGroupsMarkup/visibleTreeSessions 调用点逐一过堂，渲染态对了不等于交互路径对。**
- **SFTP 快显**：项目右键「浏览文件（SFTP）」（hostMissing/停用禁用）→ `setView("hosts")` + `window.dispatchEvent("forge:hosts-open-sftp", {hostId,path})`；hosts-panel 监听（`typeof window` 守卫，node import 不炸）——预填 `state.sftp` → render 回填 `#sftp-path` → `sftpList` 列目录，直达即所见。
- **fileChange 核查（不改码结论）**：mission-control.mjs:601 `workspaceAvailable=Boolean(run.worktreePath||run.cwd)`，远程 run 两者皆无 → workspace/diff endpoint 为 null 自然降级，前端按钮自然隐藏，无需远程特判。
- **验证**：`node --check` ×2（前端拷 .mjs）；Playwright mock-API 实机 13/13（`.scratch/verify-v41w3.mjs`：徽标=8 且三条负面控制（本地 run/异路径 run/已归档 run）排除、截断 6+「还有 2 条」、组头=最新 run、成员行 2、展开显示 8 组、点击成员行开页签+事件流拉取、右键 SFTP 项→切 hosts 视图+路径预填+列目录触发；截图 v41w3-tree/sftp.png）；全量回归 913 测试 912 pass / 0 fail / 1 skipped（纯前端波，基线持平无新契约）。真机确认项（同前波环境限制未点）：lanniny-45 下 new-api 节点徽标数与实际 run 台账一致、展开出真实协作组、点成员行进协作台 run 视图、右键「浏览文件（SFTP）」直达并列出 /home/lanniny/new-api。

## 配置图谱「配置目标」主机切换：图谱内直接配置远程主机（2026-08-11 v41 波四，LO「配置图谱加更改主机界面，不用跑远程主机视图」）

- **形态定稿**：配置图谱页头下加「配置目标」切换条——本机 chip + SSH 台账主机 chip（remote-dot 状态点：trusted=绿/停用=红/否则灰）+「管理主机…」跳远程主机视图。默认本机：三面图谱（供应商/能力/席位真源）照旧；选中远程主机：三面图谱与拓扑导航（本机概念）整体让位，换远程配置面板——主机头（globe+名称+地址）+ 三动作（重新探测/同步本机配置/打开 SSH 终端）+ 远程环境卡（OS/Shell/Home/磁盘/内存 + CLI 安装矩阵，与远程主机视图的探测弹窗同形态同数据源）。
- **零后端改动**：全走波一 remote-ops 端点（probe/install-cli/env-sync/plan/env-sync）+ 波八 pty ssh 终端。state.js 加 `configHostId/configHosts/configHostsError/configHostProbes(Map)`；台账每进视图 force 刷新（远程主机视图里增删过能跟上），主机被删自动回落本机并清探测缓存。
- **显隐纪律**：`syncConfigHostView` 单点收口——远程态 hidden 掉 `[data-config-surface-panel]` 与 `#config-topology-nav`、显 `#config-surface-remote`；回本机调 `setConfigSurface(state.configSurface,{updateHash:false})` 恢复。`setConfigSurface` 尾部加钩：远程态下程序化 surface 切换不得把本机面重新放出（防深链接/键盘导航击穿）。远程面板**不带** `data-config-surface-panel` 属性，不进 surface 切换集合。
- **远程面板自包含于 app.js**（不复用 hosts-panel 内部函数——其 render/root 耦合重，复用风险大于收益）：探测缓存 Map + 自动首探；安装走既有 `confirmAction` 确认框（明示主机/CLI/命令通道），结果内联 `configRemoteResult`（waveg-review 块，不哑弹）；同步对话框动态 `<dialog class="action-dialog sshconn-dialog">`（关即销毁，不占 elements 清单），plan 清单含秘密红字默认不勾、勾选推送走 confirmAction 二次确认（danger）。
- **安装回报被重渲吞掉（自检出真 bug）**：install 成功后 `probeConfigHost` 重渲整个面板 innerHTML，先落的结果区被清——改「先重探测、后落回报」顺序。教训：**内联结果区与面板重渲同源时，所有写结果的时机必须在最后一次重渲之后。**
- **confirmAction 返回值形态（顺手修了一个存量 bug）**：无 `checkbox` 时 resolve **布尔**，带 checkbox 才 resolve `{confirmed,checked}`——本波两处误用 `verdict.confirmed`（恒 undefined 永不执行）；grep 全库发现波九「移除远程项目」（app.js:3994）同病同修（`if (!verdict) return;`），该动作此前实际无法执行。教训：调用方形态以被调方源码为准，别凭名字猜（与波一 `.size/.length` 同类）。
- **view 边界坑（实机抓获）**：插入远程面板时误锚到 view-router 的收尾（model-section 属 router 视图而非 config），面板进了隐藏视图、DOM 在但几何全 0——Playwright「element is not visible」+ 祖先链 dump 定位。**多 view 单文件里插 section，先确认目标 view 的真实闭合点（向上找下一个 data-view-panel 起点），别拿文件后部的 section 收尾想当然。**
- **验证**：`node --check` ×2；elements 交叉核对（config-host-bar/config-topology-nav/config-surface-remote 三 id 注册↔用量↔HTML 1:1）；Playwright mock 实机 13/13（`.scratch/verify-v41w4.mjs`，隔离实例 CONTROL_CENTER_PORT=51477+独立数据目录：切换条渲染/默认本机/切远程三面让位+自动探测+OS 回显/CLI 矩阵/安装确认框→install-cli payload→回显+重探测/同步清单含秘密默认不勾→推送仅选中项→回显/切回本机恢复/管理主机跳 hosts 视图；截图 v41w4-remote-panel/sync.png）；全量 913 测试 912 pass / 0 fail / 1 skipped（纯前端波，基线持平）。pageerror「reading 'agents'」系 mock 的 capabilities 端点返回 {ok:true} 触发 renderCapabilities 存量不容错（真实端点恒返全形，生产不触发），非本波回归。真机确认项：配置图谱切到 lanniny-45 → 探测卡出真实 OS/CLI 矩阵 → 装一个未装 CLI（确认框命令正确、失败如实非零）、同步本机配置清单与本机实况一致、打开 SSH 终端进该主机 home、「管理主机…」跳回远程主机视图。

## 远程三面图谱：远程目标也按 surface 出实况（2026-08-11 v41 波五，LO「我需要远程项目也是三面图谱」）

- **形态定稿**：波四选中远程主机是把三面图谱整隐、只给一张环境卡；波五改为「配置目标=远程主机」时**拓扑导航保留可切**，远程面板按当前 surface 出三个视图——供应商与应用 / Agent·Skill·MCP / 运行席位与真源，内容全部来自远端实况。读为主（浅提取/浅扫描）+ 既有写通道（装 CLI/同步本机配置）；**远端供应商档案投影/编辑是后续波次**，面板底部 hint 如实声明，不假装能做。
- **后端 `ssh/remote-graph.mjs`（新建）**：三张表驱动——`GRAPH_CONFIG_FILES`（5 个 per-CLI live 配置：claude settings.json/.claude.json、codex/kimi config.toml、gemini settings.json）、`GRAPH_SOURCE_FILES`（前 5 + codex AGENTS.md + claude CLAUDE.md，真源查看只认表内 id，不接任意路径）、`CAP_DIRS`（claude agents|skills|commands、codex prompts、kimi .agents/skills）。流程：`resolveHome`（exec `printf %s "$HOME"` + `ssh.update` 回写台账，SFTP 围栏认这个家）→ 一条清单脚本出 `CAP|kind|cli|name` / `SRC|id|yes|size|mtime` 行协议（禁 N 并发 channel——health.mjs 探针风暴教训）→ 逐 live 配置 `sftpRead`（围栏/1MB cap/scrub 全在 ssh.mjs 层）。供应商字段是**浅提取**：toml 只认顶层 model/base_url/wire_api/model_provider + `[mcp_servers.x]` 段名；json 只认 .model/.env 里 `*_BASE_URL|*_API_URL|*_ENDPOINT` + mcpServers 键名——key/token/secret 类键名永不进提取清单，返回值再过 `safeField`（findSecretCandidates 命中即 redactString）兜底。`readSource` 未知 id 400 `GRAPH_SOURCE_UNKNOWN`，`SFTP_FAILED` 如实 `exists:false`。
- **路由**：`GET /api/ssh/hosts/:id/graph` 与 `/graph/source?file=`，GET 面默认 ssh 闸 + 内联叠加 `remoteGates.assert("sftp")`（读远端文件=env-sync 同款先例）；`setRemoteGraphForTest` 供契约测试注入。
- **前端**：`syncConfigHostView` 改写——nav 永可见（远程也三面图谱），远程态隐本机 `[data-config-surface-panel]` + 显 `#config-surface-remote` + `renderConfigRemotePanel()`（surface 切换经 setConfigSurface 尾钩走到这里，内容跟随重渲）；回本机照旧 `setConfigSurface` 恢复。`configRemoteResult` 改存 `state.configHostResult={hostId,html}`，render 时回填——波四「内联结果区被面板整渲吞掉」教训的正解（结果与重渲同源时进 state，不靠调用时机）。三个 body：providers=`data-table` 六列（应用/live 配置/状态/模型/Base URL/协议，行=graph.providers，cli 标签查 PROVIDER_APP_META）+ 诚实 hint；capabilities=Agent/Skill/Command/Prompt 四组 chips + MCP chips（title 带 cli·source），空组「无（按已知目录浅扫描）」；sources=①CLI 矩阵（波四 env 卡抽成 `configRemoteEnvBody` 复用，含安装钮）②真源列表（行级点击展开，cache 三态，ok→`pre.waveg-log` 脱敏内容 + truncated 提示，不存在禁点压暗）。`loadConfigHostGraph`（Map 缓存+force）/`toggleConfigGraphFile`（再点收起，`${hostId}:${fileId}` 缓存）；`selectConfigHost` 换主机清 configHostResult 与真源展开态。委托新增 `[data-config-host-graph]`/`[data-config-graph-file]`。
- **浅提取诚实边界**：`.claude.json` 常超 1MB 被 cap 截断 → JSON.parse 失败 → 该行字段如实全空（exists:true 但模型/Base URL 全 —），不猜不编；坏文件同理。
- **验证**：契约测试 `tests/remote-graph.test.mjs` 6/6（parseInventory 未知忽略/toml 顶层+section 隔离+mcp 段名/json 提取+坏 json 全空/**api_key 永不进 provider 字段**/graph 组装+home 回写+清单非零如实失败/readSource 三态/路由双闸 501→501→200）；Playwright mock 实机 16/16（`.scratch/verify-v41w5.mjs`：导航保留+eyebrow 带 surface 标签+自动 probe/graph 双触发+供应商表 5 行 3 live+能力 5 组 chips+CLI 矩阵+真源 7 行 3 禁点+展开脱敏内容+收起缓存不重拉+刷新图谱强拉+回本机三面恢复+本地页签正常；截图 v41w5-remote-providers/caps/source-open.png）；全量 **919 测试 918 pass / 0 fail / 1 skipped**（基线 913+6）。pageerror「reading 'agents'/'length'」系 mock 的 capabilities 端点缺字段触发 renderCapabilities 存量不容错（真实端点恒返全形），补全 mock 后清零，非本波回归（波四同款记录）。真机确认项：配置图谱切 lanniny-45 → 三页签出真实远端数据（kimi/codex live 配置行、能力 chips、真源列表）→ 真源展开看脱敏内容与截断提示 → 「刷新图谱」强拉。

## 配置图谱 v42：回退闭环 · 本机/远程一致 · 去重 · 大厂式紧凑布局（2026-08-12，LO 五点要求）

> LO：①功能与 UI 都要用户友好、布局合理 ②本机与远程主机配置前端保持一致 ③查明并删除重复臃肿
> ④结合大厂风格完善整个界面 ⑤供应商管理界面不全面，使用中出问题「比如回退无法更改」。

- **「回退无法更改」的两条真因（磁盘证据，非猜测）**：①`switchTo` 的确认框明写「可回滚：备份在
  数据目录 backups/providers/」，但 `ProviderStore.#backup()` 只写盘，**没有任何 list/read/restore
  端点或 UI 入口**——远程侧早有 `graph/backup` + `restoreBackup` 完整闭环，本机侧一直是断的。
  ②`ccswitch-panel` 的 13 处破坏性操作（含「完整备份恢复」）走原生 `window.confirm`，桌面壳 webview
  里可能不弹窗直接返回 false，表现就是「点了没反应」——与第七波「点确认指纹自动闪退」同类。
- **本机备份台账（providers.mjs）**：新增 `liveConfigTargets()` 登记表（9 应用 13 个 live 文件，
  credential=true 的 `.codex/auth.json`/`.gemini/.env` 内容不出服务端），`#backup` 落 sidecar 清单
  （app/档案/原因/目标绝对路径），`listBackups`/`readBackup`/`restoreBackup`/`removeBackup` 四方法。
  恢复**只认登记表内路径**（手改清单指向表外＝等同无清单）；无清单历史备份按 basename 归属，
  `config.toml` 这类同名多目标如实 `restorable:false` 不猜；`expectedDigest` 不匹配 409 拒绝；
  恢复前先为当前内容再留一份备份（reason=restore）——**回退本身可以再回退**。
- **前端**：供应商面收起态一行入口条，展开＝复用远程同一套 `config-remote-backup-*` 时间线
  （对比出「- 会失去 / + 会回来」的脱敏差异，凭据载体只回退不预览）。切换/团队应用后自动刷新台账。
- **对话框可回退**：加「重置」（重放 `fillProviderDialog(打开时的档案, options)` 单一填充点，
  不必关窗重开丢输入）；预设卡片**再点即取消** + 「不使用预设」按钮——原先选错预设无任何退出路径，
  取消只解绑预设附加 meta，用户已填内容全部保留。
- **去重（保功能完整）**：①环境变量冲突检查两份实现（页头只发 toast vs 工作台可勾选删除+备份）
  → 删弱化副本，页头动作跳工作台唯一实现（新增 `openTab(tab,{resourceTab,run})` 公开 API）
  ②13 处 `window.confirm` 统一走注入的页内 `confirmDialog`（无 checkbox 时返回布尔，波四教训）
  ③UI 暴露的外部产品名与版本号（`CC-SWITCH 3.18` 等 5 处）换 514cc 自有命名，来源信息留在代码注释
  ④`renderProviderAppBar`↔`configRemoteProviderAppBar` 合并为 `providerAppTabsMarkup`；两侧行的
  **身份块**合并为 `providerRowIdentityMarkup`（操作列语义不同，刻意不强行合并——KISS 优先于 DRY 教条）。
- **布局（实测数据，非感觉）**：原 page-heading + 配置目标条 + 72px 流程 band 三层横条，正文 top≈300px；
  合成一条 56px sticky `.config-toolbar`（左 segmented control + 右配置目标）后 **top=233px**，
  长面板滚动时页签仍在手边。流程箭头（`config-topology-link`）撤掉——它暗示了并不存在的向导顺序。
  页头 6 个无标签图标（排序/导入/导出/深链接/环境检查/通用配置）→ 一个带文字标签的溢出菜单，
  复用全站既有 `showContextMenuFromTrigger`，不另造第二套；排序模式补显式「完成排序」出口。
- **顺手修掉的真布局 bug**：`.provider-columns` 还是早期「每 app 一列」的 4 栏栅格，其余子块都靠
  `grid-column:1/-1` 兜着，唯独 app 条没声明 → 内容被挤进 1/4 宽。改纵向 flex 并清掉三处死声明。
- **验证**：新增契约 `tests/provider-backups.test.mjs` 8/8（清单归属/回退可再回退/凭据不出服务端/
  CAS 409/同名多目标不猜/路径穿越围栏/单份删除/按 app 过滤）；`config-topology-ui` 断言随形态升级
  （sticky 工具条 + 无流程箭头 + 窄屏堆叠）；`config-topology-state` 注入真实身份块实现而非替身。
  实机三套：`.scratch/verify-provider-backups.mjs` 14/14（切换→对比→回退→磁盘回到原文）、
  `verify-provider-dialog-undo.mjs` 19/19、`verify-provider-tools-menu.mjs` 20/20（含 56px/233px 几何断言）；
  远程面 `npm run qa:remote-config` ok:true；`qa:walkthrough` 10 面零溢出零 pageerror；
  全量 **1041 测试 1040 pass / 0 fail / 1 skipped**。`lucide-sprite-contract` 当场抓到我引用了
  sprite 里不存在的 `chevron-up`（会渲染空白）——机械扳机比自测有效的又一实证。
- **诚实边界**：远程侧仍多出「真源编辑器/发布备份/健康仪表盘」这些本机没有的能力（本机 live 文件在
  `sources.json` 里是 `deploy-only + exposeContent:false`，属既有安全设计，本波未改）；本波把**回退**
  这一条对齐了，其余不一致处未动，也不假装已对齐。observability-sessions 有一条扫描合流计时断言在
  全量并行下偶发红（隔离重跑 3/3 绿），非本波引入。

## 控制台形态收敛层（2026-08-16 · 模仿桌面 agent 台形态）
> LO 供图（深色桌面 agent 台：左栏导航行+kbd、扁平时间线「已编辑 file +1 −1」、pill 底栏 composer），
> 指令"模仿此界面形式完善优化协作台 UI"。落地为新终层 `forge/console-form.css`（最后加载）+ app.js 三处 markup + 一处快捷键。

- **时间线扁平单行**：`processCardMarkup` 过程卡去卡片壳——summary 行改为「图标 + 动词（已编辑/已新增/已删除/已重命名/已改动/已执行）+ mono 目标 + 右侧彩色 diff 统计 + 时间」；`+添/−删` 统计从 change.diff 文本数行（跳过 +++/--- 头）现算，无 diff 不显示。展开体改左缘细线串父子，去卡片顶分隔。旁白/推理摘要 label 与首段同行（`p:first-of-type` inline）。治理注记/内联审批去 40px 头像槽缩进，贴齐时间线左缘。
- **左栏**：操作行（新建任务/搜索/自动化/技能）加 kbd 提示（`.rail-kbd`，Ctrl N / Ctrl K）并真补 Ctrl+N 绑定（workbench 内 → openSessionDialog；浏览器保留该键时自然落空，桌面壳生效）。会话行单行化：状态点 + 标题 + 右侧 mono 相对时间徽章（状态词由状态点色调表达，`.rail-run-state` 视觉隐藏，`railRunMarkup` 拆出 `.rail-run-sub/.rail-run-time`）。
- **会话头**：拍成 slim 标题栏（13px/600），`#conversation-meta` 改右置状态 pill（mono 10.5px 胶囊，对标参考「后端：…」）。
- **Composer**：壳圆角 12px、模型/Effort/权限选择器统一 pill 化（发丝边 + hover 浮底）、发送/附加钮 28px 正圆、藏底栏键位文字（tooltip 仍在）。颜色全走 tokens 令牌，亮暗双主题自动跟随；窄屏（≤900px）状态 pill 让位标题。
- **顺手修真 bug**：离线 sprite 漏了 `file-pen-line`（过程卡文件行图标一直是空白）与静态引用的 `arrow-left`/`wand-sparkles`——`vendor-lucide.mjs` 清单补齐 3 个并重生成（134 symbols ↔ manifest ↔ 静态引用三方对齐）。`lucide-sprite-contract` 测试从假绿变真红再变绿，再次证明机械扳机的价值。
- **验证**：全量 **1331 测试 1330 pass / 0 fail / 1 skipped**；vm 沙箱抽真 `processCardMarkup` + 全量真实 CSS 静态预览页实拍（亮/暗、展开/收起/错误态）；Playwright 实拍工作台 + 会话树页（亮/暗）无 pageerror。

## 控制台形态收敛层·第二轮（2026-08-16 · 参考图标红处细节）
> LO 二轮供图（同一桌面 agent 台），标红四处：①顶栏 标题+项目/分支 chip+「…」②顶栏右「更改 +N −N」pill
> ③时间线左缘折叠沟槽 ④欢迎态（时段问候/composer chip 行/可关提示条/模板卡）。全部落在 console-form.css 终层 + app.js 渲染层。

- **会话头 chips**：标题下随「📁 项目 ▾」「🌿 分支」「…」溢出菜单。数据源统一走 `GET /api/workbench/environment`
  （run→任务工作树，无 run→控制面仓库根），按 runId/"idle" 分键 30s TTL 缓存，回填只写 chip 局部 DOM 不触发整树重绘。
  溢出菜单复用既有 `showContextMenuFromTrigger`，只放复制类安全动作 + 产物 diff 入口（破坏性动作留在顶栏停止键）。
  「…」放在 `#conversation-chips` 容器内、`innerHTML` 重建后 appendChild 挂回——heading-main 是纵向 flex（styles.css:9605），
  chips 行与标题行分层，不与 meta pill 抢一行。
- **更改 pill**：终态 + worktree run 在顶栏右显示「更改 +A −D」。数字优先级：已展开的 runDiffView stat（权威，
  解析 `git diff --stat` 末行，缺子句按 0）> 环境 numstat（changes.additions/deletions，顺手就有）；都没有就纯「更改」。
  点击与「产物 diff」按钮同路 toggleRunDiff。环境端点对不合规 worktree 返 422（attestRunWorkspace 围栏），前端静默降级为无数字。
- **折叠沟槽**：VSCode folding gutter 式——消息行/过程卡左 -15px 小横杠，悬停显实（opacity 0→.55）。消息行折叠按
  streamKey 记进会话级 Set（`collapsedStreamRows`，重渲不失、刷新还原）；过程卡翻 `details.open`（开态本就有
  capture/restoreConversationStreamState 跨重渲保留）。折叠态 = 内容压一行 + 右渐隐 mask + 头像缩小，行还在可再点开。
  `.row-gutter` 用 absolute 定位脱离 grid 流——`.message-row` 是 34px+1fr 的栅格，普通子元素会挤歪布局。
- **欢迎区**：hero 改时段问候（早上/中午/下午/晚上/夜深五档，AEMEATH 口吻）；tip 条补 × 关闭（localStorage
  `514cc-welcome-tip-dismissed` 持久化）；**tip 抽签种子会话内固定**——原先每次 renderSelectedRun 都重抽 tip 文本，
  欢迎区签名随之抖动、DOM 反复被替换（× 在 SSE 活跃时几乎点不中，Playwright 实录超时确诊）。
- **composer chip 行**：项目地址 chip 取消"无 pendingCwd 即隐藏"——新任务模式如实回读 idle 环境的默认仓名/根
  （服务端默认 cwd 就是 repoRoot，不是猜的占位），可点击时补 ▾ caret；旁边新增只读「🌿 分支」chip
  （pendingCwd 指往别处时如实隐藏——环境端点反映的是默认仓，不假装知道别人的分支）。新任务占位文案改
  「向 X 提问或下达目标——@ 点名成员，/ 选择命令或模式」（`syncComposerTargetUi` 才是占位文案的终写点，
  `setComposerMode` 里那处在它之前跑、会被盖掉——两处同步改）。
- **补回被隐藏波次吃掉的欢迎区**：`codex-desktop.css:416-441` 曾把 welcome-tip/星图/模板卡整体
  `display:none !important`（极简 compact 决策）。本轮以更后加载 + 更高优先级 !important 恢复 tip/分类页签/模板卡
  （参考形态即"问候+提示条+快捷卡"）；星图保持隐藏——composer 成员条已承担团队呈现，欢迎区高度向参考收敛。
- **sprite**：补 `ellipsis`（会话头溢出菜单图标），135 symbols 三方对齐。
- **验证**：隔离实例（CONTROL_CENTER_DATA_DIR=.scratch/qa-ui-data）+ 种一个终态 worktree QA run
  （id 必须纯 hex——`/api/runs/:id/diff` 路由只认 `[0-9a-fA-F-]`，否则 404；worktreePath 必须过
  attestRunWorkspace 命名边界，否则环境端点 422）。Playwright 实拍：欢迎态（问候/双 chip/新占位/tip × 点击消失
  且 localStorage 落 1）、run 会话头（双 chip + …菜单 5 项 + 更改 pill +0 −0）、沟槽折叠、diff 面板开合，亮/暗双主题无 pageerror。

## 控制台形态收敛层·第三轮（2026-08-16 · LO 真实实例实拍修复）
> LO 用真实实例跑新 UI 拍回两张图：「动作审批 · 待处理」卡把 control/runBuild/requestApproval 的
> params（runId/promptSha256/三组 member-uuid/coordinatorId/policySha256…）平铺成 20+ 行裸字段墙；
> meta pill 横贯顶栏且与会话头 chips 重复。两处定点修复。

- **runBuild 审批卡摘要化**：`approvalParamsMarkup` 新增 runBuild 分支（排在 commandExecution/fallback 之前）→
  `approvalRunBuildMarkup`：正面一行 4 项人话事实（工作区 basename+全路径 title / 隔离 / 协作模式·最多 N 轮 /
  执行成员短码），全量字段原样收进 `<details class="approval-tech">「技术详情 · N 字段」`——审计可见性不丢，
  首屏不再被哈希淹没。成员运行实例 id 由 `approvalMemberShort` 截到 18 字符（全量留 title 与技术详情）。
  commandExecution/fileChange 两条既有分支不动（命令块/路径列表本来就是人话）。
- **meta pill 砍重复段**：`renderSelectedRun` 不再推入「独立页 · 只看 X」（成员身份 tab 条+会话标题已表达）与
  「wt …」（会话头分支 chip 已显示；chip 数据缺失时 `#conversation-meta` 的 title 悬停仍给出 worktree 全路径）。
  「总轮次 / 交互 · 本次步骤」保留——codex-process-visibility 有源码断言，是步骤预算的唯一可见面。
- **composer 底栏高度不动**：实拍里操作台展开占屏是用户自己的展开态——`composerCliOpen` 默认 false
  且 localStorage 持久化，不替 LO 改他的面板状态。
- **验证**：新源码契约测试 `tests/approval-runbuild-card.test.mjs`（3 项：runBuild 分支位序+四要素+details、
  console-form.css 样式、meta 段裁剪）3/3 过；全量 **1337 测试 1336 pass / 0 fail / 1 skipped**
  （ccswitch-proxy failover 熔断用例在全量并行下偶发一次 2!==1，单跑 37/37 复跑全绿，确认 flaky 与本改动无关）。
  隔离实例实拍：state.approvals 是服务端内存 broker 无持久化，pending 审批造不出来——DOM 注入同结构卡片
  验证呈现（折叠/展开 × 亮/暗 四态），markup 生成逻辑由源码契约测试兜底。

## 控制台形态收敛层·第四轮（2026-08-16 · 居中回归修复）
> LO 真实实例实拍：审批卡 / 「已创建隔离工作树」系统卡 / 「第 N 轮」轮次分隔全部贴左而非居中。
> Playwright 探针实测（ml/mr/maxW/x）定位两个破口，均修复于 console-form.css。

- **破口①（本轮新引入）**：第一轮写的 `.gov-note, .approval-inline { margin-left: 0 }`——与
  codex-desktop.css `.conversation-stream > * { margin-inline: auto }` 同特异性但更晚加载，
  盖掉 auto 的左半（右 auto 残留），元素被挤到内容区左缘。改回 `margin-inline: auto`；
  头像槽 40px 缩进在居中阅读列里本就无意义，不恢复。
- **破口②（存量 bug）**：styles.css `.conversation-stream .turn-divider { margin: 14px 0 10px }`
  特异性 (0,2,0) 高于居中层的 (0,1,0)，shorthand 一直把左右 margin 钉 0。console-form.css 以
  同特异性 + 最后加载补 `.conversation-stream .turn-divider { margin-inline: auto }`。
- **居中机制本身保持三层**：流 padding 固定 20px（console-form 第一轮）+ 子元素
  `width:100%; max-width:768px; margin-inline:auto`（codex-desktop 提供 width/auto，console-form 收 768）。
  实测修复后 gov-note/turn-divider/approval-inline 与 message-row 完全同列（x=731, ml=mr=471px auto）。
- **验证**：新契约测试 `tests/stream-centering.test.mjs`（3 项：两类 margin-inline:auto 在场、
  margin-left:0 不再出现、上游居中机制完好）3/3 过；全量回归 0 fail（automations/ccswitch-domain
  在 Windows 并行下偶发 EPERM rename flaky，单跑 32/32 复跑全绿）；隔离实例注入三元素实拍
  亮/暗双主题居中确认（SSE tick 会重建 innerHTML 冲掉注入——interval 守卫重注后截图）。

## 控制台形态收敛层·第五轮（2026-08-17 · 活跃过程与步进可见性）

> LO 供图（Codex 桌面 App 实拍：流内「运行了命令」转圈行 +「第 1 / 4 步 · 2 个文件已更改
> +150 −24」进度条），指令"参考此图继续完善桌面端协作台"。纯前端波：数据面（codex
> item/started 的结构化 command/file progress）早在 SSE 流里，此前只折算成呼吸行一句文案
> （trackCodexActivity → codexActivityText），时间线本体没有实体——本轮补上。

- **进行态过程行 `liveProcessRowsMarkup`**（app.js，渲染层零后端改动）：codexActivity 里
  started 未核销的 command/file 项逐条成行——转圈（loader-circle + forge-spin，reduced-motion
  由 motion.css 既有层全灭）+「正在执行/正在编辑」+ mono 目标 + 已运行时长。时长复用
  `data-live-since` + `tickLiveElapsed` 秒级走时，不靠重渲。completed 到达即核销消失、
  完成态扁平单行（第一轮 processCardMarkup 形态）自然落位——一行两态，不另造完成形态。
  reasoning 不进这里；waiting_approval/recovery_required/pendingAsk 时不挂转圈（等的是人，
  在途 item 已暂停，转圈=假活）。
- **呼吸行去重**：command/file 活跃项独立成行后，`liveTurnMarkup` 只为 reasoning 保留
  「正在思考」，其余退回相位文案——此前同一活跃项会在呼吸行与过程行各说一遍。
  `codexActivityText` 契约锚点（codex-process-visibility 断言行）原样保留。
- **流尾步进进度条 `turnProgressMarkup`**：「◌ 第 X / Y 步 · N 个文件已更改 +A −D」。
  步进口径与顶栏 meta 同源（interactionStep/maxStepsPerInteraction）；文件统计走新累加器
  `turnFileStats`（只收 completed 的 file progress——started 的 diff 为空；数行复用
  `diffLineStats` 不造第二份；user.message 开新交互即重置；run 收尾清账）。有文件段时整条
  是 details，展开 per-file 明细（修改/新增 chip + mono 路径 + per-file +x −y），开态靠
  `data-stream-key="tail:progress"` 走既有 capture/restoreConversationStreamState 跨重渲保留。
- **居中纪律落进契约**：两个新类都是会话流直接子级，margin 只写 `margin-block`——
  inline 方向留给上游 `margin-inline:auto`（第四轮 .gov-note 破口同款教训的预防性固化，
  契约测试带负向断言）。
- **诚实边界**：kimi/gemini/claude 等席位无 item 级信号，没有进行态过程行与文件段
  （只显示步进或全隐），不猜不编；刷新页面后累加器从空起步（只收 live SSE，不回放历史
  补齐），新交互随 user.message 重置自然对齐。截图里「已查看 N 张图像」是 agent 侧图像
  查看信号，codex app-server 无此 item 类型，不伪造。
- **验证**：新契约 `tests/stream-live-progress-contract.test.mjs` 6/6（渲染路径/呼吸行去重/
  累加器重置与复用数行/tail 与 pushEvent 接线/样式在场+居中负向断言/sprite 四方对齐）；
  vm 沙箱抽真 `liveProcessRowsMarkup`/`turnProgressMarkup`/`trackTurnFileStats` 生成静态预览页
  （`.scratch/gen-preview-5.mjs` + `shot-wave5.mjs`），亮/暗 × 收起/展开四态实拍
  （`.qa-ui-wave5/`）：进行态两行转圈 + 进度条「第 1 / 4 步 · 2 个文件已更改 +246 −24」
  （150+96 两文件聚合正确）+ 展开 per-file 明细，无 pageerror；`node --check` 过；全量
  **1351 测试 1350 pass / 0 fail / 1 skipped**（基线 1337 + 本轮契约 6 + 工作树在途改动 8）。

## 控制台形态收敛层·第六轮（2026-08-17 · 会话头单行 slim 标题栏）

> LO 供图（Codex 桌面顶栏红圈：图标+标题单行 + 下发丝分隔线）+ 本机实拍（标题两行、
> meta pill 横贯），指令"关注红色标记的视觉处理"。落点：index.html 一处 glyph +
> console-form.css 第六轮区块 + app.js meta 构造压缩。

- **单行标题栏**：heading-main 从纵向 flex 改行向（wrap 仅留给极少显示的参与 CLI 行）；
  标题压单行 nowrap+ellipsis（覆盖 styles.css 存量两行 line-clamp）；标题前加
  `conversation-title-glyph`（messages-square，class-only 无 id——不进 elements 清单，
  第七波漏登坑的主动规避）；chips/溢出菜单随行；右侧只剩「本次步骤 X/Y」pill + 图标钮。
- **meta pill 压缩**：可见文本从「run e8afa36d · 08/14 20:33:09 · 总轮次 4 · 交互 1 ·
  本次步骤 4/6」收成「本次步骤 4/6」（maxSteps 缺失回落「总轮次 N」）；run id 全码/创建
  时间/总轮次/交互序号/worktree 全路径收进同一元素 tooltip——审计可见性不丢。
  codex-process-visibility / approval-runbuild-card 两处契约同步改写（口径不变：
  总轮次与本次步骤都必须说清，只是一处在可见面一处在悬停面）。
- **实机抓获存量暗伤**：`--line` token 从未定义——console-form 前四轮 9 处 + styles.css
  2 处 `border: 1px solid var(--line)` 全部静默失效（var() 未定义使整条 border shorthand
  无效，borderBottomWidth 实测 0px），会话头发丝线、过程卡展开体左缘线等其实一直没渲染。
  全量改 `var(--border)`（tokens.css 亮暗双主题都有定义），契约测试加全局负向断言。
- **窄屏 wrap 坑**：flex-wrap 的换行判定用 flex base size（标题未收缩的全文宽），长标题
  会把 chips 挤到第二行（heading 42→72px）。窄屏（≤900px）禁 wrap + 隐藏参与 CLI 行
  （团队呈现由 composer 成员条承担），标题照常省略、chips 裁剪到只剩 …。
- **验证**：新契约 `tests/conversation-heading-slim.test.mjs` 4/4（glyph 无 id/单行省略/
  tooltip 审计段/--line 负向）；实机探针 `.scratch/verify-wave6-heading.mjs`（隔离实例
  51483 + 种 run）：flexDir=row、glyph 可见、标题 17px 单行、chips 同行（中心线判定——
  盒高差不是换行）、meta=「本次步骤 4/6」+ tooltip 四段全、发丝线 1px、窄屏 600px
  标题省略且 heading 回 42px；截图 `.qa-ui-wave6/heading-{light,dark,narrow}.png`；
  全量 **1356 测试 1355 pass / 0 fail / 1 skipped**（基线 1351 + 本轮契约 4，余 1 为工作树在途改动）。

## 控制台形态收敛层·第七轮（2026-08-17 · 窗口框与 topbar 合一）

> LO 供图（Codex 桌面：窗口标题栏与顶栏合一的一条 slim 横带）+ 本机实拍红圈（Tauri 原生
> 标题栏「514 Forge · Control Center」与应用 topbar 两层横条），指令"关注红色标记的视觉处理"。
> 落点：main.rs 一处 builder 链 + 新 capability（window-chrome.json）五条窗口权限 + index.html
> 三钮 + app.js initializeWindowChrome + console-form.css 第七轮区块。

- **去原生装饰**：`WebviewWindowBuilder` 加 `.decorations(false)`——窗口框交给 topbar 兼任。
  网页资产先行可用（旧壳仍带原生栏时三钮只是冗余，不致命）；装饰移除需重新构建桌面端生效。
- **窗口控制条**：topbar-actions 末尾 `.window-controls`（minus/square/x，默认 hidden）；
  仅 Tauri 壳内由 `initializeWindowChrome()` 摘除 hidden 并加 `is-desktop-shell`，浏览器模式零渲染。
  命令走 `__TAURI_INTERNALS__.invoke("plugin:window|…")`（minimize/toggle_maximize/close），
  关窗仍触发 native.rs CloseRequested → 关窗进托盘语义不变；五条 core:window 权限独立落
  `capabilities/window-chrome.json`——ccswitch-native 的权限集被 native.rs 回归锁死与 invoke
  handler 精确相等，平台权限混进去会炸精确匹配，分离后两边都不动。
- **手动拖拽区**：弃用 `data-tauri-drag-region`（壳内注入脚本对子元素的命中判定随版本漂移），
  改在 topbar mousedown 手动判定——命中 button/a/input/nav/actions 放行，否则 detail===2 双击
  toggle_maximize、单击 start_dragging。语义落在应用层，契约可测、探针可演。
- **slim 收敛**：`is-desktop-shell` 下 `--topbar-height: 44px`（浏览器基线 52px 归
  codex-desktop.css:9 所有，不动）；topbar 空白区 user-select:none 防拖动误选；
  关闭钮 hover 用既有 --rose-bright（Windows 惯例），不新造颜色 token。
- **图标**：vendor-lucide.mjs 清单补 `minus` 重生成（135→136 symbols，manifest 同步）。
- **验证**：新契约 `tests/window-chrome-contract.test.mjs` 7/7（标记位置+hidden 默认/id 登记/
  Tauri 守卫与四条窗口命令/拖拽排除选择器/capabilities/decorations(false)/图标 manifest，
  含 data-tauri-drag-region 负向断言）；实机探针 `.scratch/verify-wave7-chrome.mjs` 双实例
  （bootstrap nonce 一次性，51484/51485 各起一实例）：浏览器模式无 shell class、钮 hidden、
  52px 基线不变；注入桥桩模拟壳后 44px 收敛、三钮三命令、面包屑单击 start_dragging、
  双击 toggle_maximize、theme-toggle 豁免拖拽、双主题零 pageerror；截图
  `.qa-ui-wave7/chrome-{light,dark}.png`；`cargo check` + `cargo test`（21/21，含
  ccswitch-native 精确匹配回归）通过；
  全量 **1363 测试 1362 pass / 0 fail / 1 skipped**（基线 1356 + 本轮契约 7）。

## 控制台形态收敛层·第八轮（2026-08-17 · rail/会话栏交界圆角卡片）

> LO 小图圈点 rail 与会话栏交界的生硬直角（发丝线 + 直角相交），指令"这里做圆角处理"。
> 纯 CSS 一轮：console-form.css 第八轮区块，无 JS/标记改动。

- **圆角卡片**：`.atelier .conversation-pane` 左上 `border-top-left-radius: 10px`，凹口透出
  rail 磨砂底色（pane 本就 `overflow:hidden`，子元素随曲线裁切，实测无直角漏出）；
  `.atelier .conv-tabs` 补同款圆角当保险丝（防未来 bg 改动越界）。
- **去发丝线**：rail 右缘 `border-right` 与 `1px inset 高光` 一并移除，分隔交给色差——
  Codex 桌面交界无线，靠侧栏/内容底色差。候选 A（只圆角留线）与 B（圆角+去线）探针
  双截图对比后取 B。
- **CSP 预览技法**：`page.addStyleTag` 被 `style-src 'self'` 拦——候选样式预览改走
  Playwright route 拦截 `console-form.css` 追加响应体，同源样式表合规、工作区零污染。
- **验证**：新契约 `tests/junction-radius-contract.test.mjs` 3/3（圆角+保险丝/去线/
  console-form 晚于 codex-desktop 加载的源序断言）；实机探针 `.scratch/verify-wave8-junction.mjs`
  4 断言（pane 10px / rail borderRight 0px / shadow none / tabs 10px）+ 双主题交界与全景截图
  `.qa-ui-wave8/junction-final-{light,dark}.png`，零 pageerror；
  全量 **1366 测试 1365 pass / 0 fail / 1 skipped**（基线 1363 + 本轮契约 3）。

### 第八轮追加（同日）：壳内热重载

LO 反馈"桌面端没看到改动"：静态资源 `no-store` + 每请求读盘，服务端无缓存——唯一滞后层是
WebView 里已加载的旧页面；壳无地址栏/刷新键，而 bootstrap nonce 一次性曾让人以为不能 reload。
查实令牌兑换后存 sessionStorage（app.js initializeAccessToken），**reload 安全**。
`initializeWindowChrome` 补壳内 Ctrl+R → `location.reload()`（浏览器模式不受影响）。
探针 `.scratch/verify-wave7-reload.mjs` 实证：Ctrl+R 后页面重载、badge 回 is-ok、
壳形态与窗口钮恢复。此后网页资产迭代，壳内 Ctrl+R 即生效，不必重启应用。
全量 **1366 测试 1365 pass / 0 fail / 1 skipped**。

### 第八轮二轮修正（同日）：圆角看不见 + 页签带割裂

LO 重启后反馈"还是不对"，分无标签页/有标签页两态供图。逐像素取证：

- **圆角一直在，只是看不见**：pane 是 78% 半透明玻璃，圆角裁出的缺口直接透出 atelier
  舞台（近白），与 rail/卡片色差不超 3 级灰度——无标签页态（conv-tabs display:none，
  顶行换成 conversation-heading）弧外点采样 (242,54)=(250,249,245) 与卡内同色，弧线隐形。
- **修**：`.workbench-shell::before` 在 (var(--codex-task-rail), 0) 垫 12×12
  rail 同配方玻璃色（color-mix sidebar 62%），z-index:-1 沉到 grid 子项下，只从缺口露出；
  移动端 rail 100% 时自然出屏。修后缺口 (246,244,238) ≈ rail (244,241,234)，双主题成立。
- **页签带并入卡片**：conv-tabs 的 muted 横带（codex-desktop 时代"自成一带"的决定）把卡片
  割裂成两段，与 Codex"标签行与内容同一张卡面"不符——背景改透明透出 pane 玻璃底，
  圆角保险丝保留。
- **取证技法**：elementFromPoint 角点回溯 DOM 链（heading bg 卡进角）+ PIL 沿弧心
  对角线采样定弧存在性 + route 拦截预览候选。结论先行于改动。
- **验证**：契约 `tests/junction-radius-contract.test.mjs` 4/4（新增垫底三断言：跟随
  --codex-task-rail / z-index:-1 / 62% 同配方）；探针 verify-wave8-junction.mjs 6 断言
  （含垫底挂载、conv-tabs 透明）+ 无标签页态截图；全量 **1367 测试 1366 pass / 0 fail /
  1 skipped**（基线 1366 + 契约 +1）。

## 控制台形态收敛层·第九轮（2026-08-17 · 应用菜单列 + L 形 chrome 统一色 + 卡片浮起）

> LO 供 Codex 桌面左上角截图（≡ ‹ › 文件/编辑/视图/帮助），指令三连：补回这些菜单功能；
> 左边栏与上边栏统一颜色；协作台对话区用立体效果与 chrome 区别。第七轮 `.decorations(false)`
> 把原生菜单栏一并带走，本轮在 web 层补回（浏览器/壳内共用，不锁壳）。

- **菜单列**：topbar 的 `.topbar-title` 前插入 `.chrome-menus` 簇（index.html，7 控件：
  rail 开合 / ‹ / › 图标钮 + 文件/编辑/视图/帮助 文字菜单）。逻辑在 app.js
  `initializeChromeMenus`：复用既有 `showContextMenuFromTrigger` 弹层；文件=新建任务/
  重载界面/关窗进托盘（浏览器模式关窗禁用）；编辑=撤销/重做/剪切/复制/粘贴/全选
  （`execCommand`，粘贴被 Chromium 拦时诚实 toast 提示 Ctrl+V）；视图=左栏开合/主题/
  字号±/重置/底部终端/环境信息；帮助=体系观测/关于（confirmAction 弹 getVersion()）。
- **焦点归还**：HTML 菜单会抢走输入框焦点（原生菜单不会）——`focusin` 捕获
  `lastEditableField`，编辑命令先 `focus()` 归还再 `execCommand`，探针实证全选落回
  `#task-input`。
- **视图历史**：setView 全程 `history.replaceState`（浏览器栈不涨），自养双栈
  `viewHistoryBack/Forward` 供 ‹ ›；`recordViewHistory` 挂在 `FORGE_VIEW_TITLES` 守卫之后
  只记真实切换，`chromeNavigate` 用 `viewHistoryMute` 抑制回写防死循环，上限 50。
- **rail 收起**：`applyRailCollapsed` 切 `.workbench-shell.rail-collapsed`（grid 列宽归零 +
  rail visibility:hidden + 卡片左缝补齐 8px），localStorage `514cc:workbench-rail-collapsed`
  持久化，入口双份（≡ 钮与视图菜单，aria-pressed 同步）。
- **统一色比色卡点（本轮根因教训）**：初版给 topbar/shell 写 62% color-mix 磨砂，探针比色
  永远 FAIL——`experience-polish.css:38` 早已把 rail 压成实色 `var(--sidebar)`（特异性
  (0,2,0) 后于 codex-desktop 的磨砂配方），同一 token 一边带 alpha 一边不带，任何归一化
  都比不齐。统一只能向实色对齐：topbar/shell 改实色 `var(--sidebar)`（backdrop-filter
  不再声明，自然回落 polish 的 none），磨砂纵深改由卡片浮起承担。亮 rgb(244,241,234) /
  暗 rgb(23,20,15) 三面一致。
- **卡片浮起**：`.atelier .conversation-pane` `margin: 8px 8px 8px 0`（左缘贴 rail 保留
  Codex 式交界）+ `border-radius: 12px` 全圆角 + 双层柔和投影（暗色加深变体）；壳铺同色
  底色后第八轮 `::before` 凹口补丁成死代码，退役（junction-radius 契约改负向断言）。
- **图标**：vendor-lucide.mjs 清单补 `panel-left` 重生成（136→137 symbols，manifest 同步）；
  MENU_ICONS 补 13 个菜单图标键。
- **验证**：新契约 `tests/chrome-menus-contract.test.mjs` 6/6 + junction-radius 4/4 +
  window-chrome 7/7 = 17/17；实机探针 `.scratch/verify-wave9-chrome.mjs`（51496，真实文件
  无拦截）25 断言全绿：7 控件挂载/sprite/初始禁用/三面比色×2/几何×4/文件菜单项数与关窗禁用/
  新建任务触发/编辑 6 项/全选焦点归还/收起三态/左缝补齐/toggle 恢复/帮助切视图/‹ › 三断言/
  暗色三面一致/暗色投影，零 pageerror；截图 `.qa-ui-wave9/wave9-{light,dark}.png` +
  `wave9-junction-{light,dark}.png`。探针一处误判自修：首载 hash 空串是 boot 态，‹ 断言改比
  激活面板。另修复既有陈旧断言 1 条：sidebar-nav-ui.test.mjs 没跟上 `#view-market` 加进
  `#view-appearance,#view-browser` 选择器列表（两个文件均 untracked，LO 既有工作树漂移）。
  全量 **1376 测试 1375 pass / 0 fail / 1 skipped**（基线 1367 + 本轮契约 6 + 树内既有 +3）。
  备注：ccswitch-proxy.test.mjs 两个计时敏感用例（309 熔断/1146 close restore）全量并发下
  各抖一次，单跑 37/37 绿、第三次全量 0 fail，与本轮 UI 变更无关。

### 第九轮追加（同日）：细节打磨（LO 全屏截图后 "继续优化细节"）

2 倍放大审计探针 `.scratch/audit-wave9-details.mjs`（deviceScaleFactor 2，13 张区域截图 +
边框计算样式取证），只动有证据的粗糙点：

- **topbar 底发丝线切断 L**：计算样式实锤 `border-bottom: 1px solid oklch(0.912 0.007 85)`
  （codex-desktop.css 时代遗留），统一色 L 形 chrome 下这条线把上栏与左栏/壳切成两层，
  Codex 参照此处无线——`body.atelier .topbar` 补 `border-bottom: 0`。
- **rail 快捷键提示减重**：`.rail-kbd` 去边框盒（1px border + padding 5px → 0），对齐参照图
  纯 muted 文本；hover 行只提 opacity，不再描边。
- ** phantom 排除**：≡ 钮疑似"静止态带底盒"，计算样式取证 bg/border/shadow 全空——是
  panel-left 字形本身的圆角矩形，非缺陷，未动。先取证后动手的典型一例。
- **验证**：探针 verify-wave9-chrome.mjs 25/25 保持全绿；契约 17/17；
  全量 **1381 测试 1380 pass / 0 fail / 1 skipped**。备注：mission-control-http.test.mjs:392
  （服务器夹具关停生命周期）首轮全量抖一次，单跑 5/5 绿、二轮全量 0 fail——与 CSS 无关。

### 第九轮追加二（同日）：卡片右/下不留空

LO 圈图指出对话卡片右边与下边"不用留空"。`.atelier .conversation-pane` 由
`margin: 8px 8px 8px 0` + 全圆角改为 `margin: 8px 0 0`（只留顶部缝）+
`border-radius: 12px 0 0 0`（只留左上签名角）——右缘贴齐窗缘、下缘贴齐状态栏顶，
右/下圆角会在窗缘与状态栏上切出底色缺口，故一并取方。rail 收起态 `margin-left: 8px`
维持不变（切换态的左缝是功能反馈，非装饰留空）。契约与探针同步：chrome-menus 契约
改断言 margin/radius 新值；verify-wave9-chrome.mjs 新增"右缘贴窗缘（pane.right ==
viewport宽）""下缘贴状态栏（pane.bottom == .global-statusbar.top）"两条几何断言，
圆角断言改 12/0/0/0。探针 27/27 全绿；契约 17/17；全量 **1381 测试 1380 pass /
0 fail / 1 skipped**（本轮一次通过）。

---

## HX-02: 版本化事件协议 envelope（v46 Wave 1, 2026-09-01）

事件 envelope 的 `schemaVersion: 1` 从装饰性常量升级为真实运转的版本门控。

### 单一真源

`public/modules/event-protocol.js`——server（event-store.mjs / server.mjs）与 client（app.js）
共用同一常量。纯 ESM，无 DOM/Node 依赖，仿 `stream-epoch.js` 风格。

### Fail-closed 语义

- **Server 出口**（`eventForPublic()`）：遇到 present-but-unknown `schemaVersion` → 返回
  tombstone（`protocol.unsupported_envelope`），保留 sequence/runId/timestamp，不泄露原始 data。
- **Client 入口**（`normalizeEvent()`）：遇到 present-but-unknown → 返回 null，丢弃事件 +
  节流告警（每 distinct version 只报一次，防止降级场景刷屏）。
- **Absent schemaVersion 容忍**：server 合成帧（`replay_error`/`ready`）无此字段，不触发 gate。

### Ready payload 协商

SSE ready 帧增加 `eventSchema` + `eventSchemaVersions` 声明。client 收到后检查是否有
交集，无交集时输出诊断警告「服务端事件协议版本不受支持，部分事件可能丢失」。

### Schema 漂移修复

`contracts.schema.json` eventEnvelope 补回 `sourceRefs`/`prev`/`hash` 三个已有代码写入
但 schema 遗漏的 optional 字段。新增漂移哨兵测试：emit 真实事件 → 断言 schema properties
覆盖所有实际 envelope keys。

### 测试覆盖（tests/event-protocol.test.mjs, 16 tests）

1. 共享模块单元：version 判定、三路分类、tombstone 形状、negotiation
2. Producer 一致性：EventStore.emit schemaVersion === EVENT_ENVELOPE_SCHEMA_VERSION
3. Schema 漂移哨兵：contracts.schema.json 覆盖实际 envelope keys
4. Fail-closed 行为：unknown version → tombstone，原始 data 不泄露
5. Client/Server 契约：源码 assertIncludes 验证 gate 存在

## HX-03: 事件 envelope 形状单源定义 + JSON Schema 生成（2026-09-01）

HX-02 让版本机制真实运转，但 envelope 的字段定义仍三处手写：event-store.mjs emit()、
contracts.schema.json eventEnvelope、app.js normalizeEvent()。新增/重命名字段时需同步
三处，漏改即漂移。

### 单源模块（public/modules/event-shape.js）

`EVENT_ENVELOPE_FIELDS` 定义所有 16 个字段的类型、约束、required 标记。纯 ESM，无
DOM/Node 依赖，server/client 共享。导出：
- `EVENT_ENVELOPE_FIELDS` — 字段定义（frozen）
- `getRequiredEventFields()` — required 字段列表
- `buildEventEnvelopeSchema()` — 生成完整 eventEnvelope JSON Schema

### 生成脚本（scripts/generate-event-schema.mjs）

读取 event-shape.js，替换 contracts.schema.json 的 `$defs.eventEnvelope`。运行：
`npm run schema:generate`。生成后 `npm run validate` 验证 schema 仍有效。

### Dev-only 校验（src/event-store.mjs）

emit() 在 prev/hash 附加后、哈希链计算前，检查所有 required 字段存在。仅
`NODE_ENV !== "production"` 时运行，不影响生产性能。新增 required 字段时如果 emit()
漏掉，测试立刻失败。

### 测试覆盖（tests/event-shape.test.mjs, 14 tests）

1. 形状完整性：EVENT_ENVELOPE_FIELDS 覆盖 emit() 所有字段
2. Required 字段：getRequiredEventFields() 与 schema.required 一致
3. 类型约束：sensitivity enum、sequence minimum、schemaVersion const、eventId uuid
4. sourceRefs 结构：array maxItems 16，items 嵌套 required/properties
5. Schema 生成：buildEventEnvelopeSchema() 结构正确，properties 匹配字段定义
6. 生成一致性：contracts.schema.json eventEnvelope 与 buildEventEnvelopeSchema() 深比较一致
7. Producer 一致性：EventStore.emit() 产生的事件符合 shape
