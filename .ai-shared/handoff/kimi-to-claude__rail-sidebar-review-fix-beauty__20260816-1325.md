<!-- 514cc-session-id: f1e02b50-93ce-4e44-be7a-69094a74da6e -->
# Kimi 修复：协作台左侧栏审查收口 + 逻辑修复 11 项 + 视觉打磨

- **类型**：审查 + 修复 + 美化（非评审，故不用四节结构）
- **时间**：2026-08-16 13:25 (+0800)
- **执行体**：Kimi Code CLI（LO 派活：左侧栏审查 bug / 深度优化逻辑 / 美化前端）
- **工作区**：`apps/control-center/public`

---

## 方法

explore 子代理对 run-rail 全量 read-only 审查（app.js 渲染链 / workbench-chrome / state / 相关 CSS），
产出 1 高 3 中 6 低共 10 项发现；**每条发现动手工前均由我按 文件:行号 逐一源码复核确认**，
无一臆测项。另在截图验证阶段新发现 1 项真实视觉缺陷（状态栏滚出视野），并入修复。

## 修复清单（全部验证）

### 逻辑正确性

- **H1 置顶/归档区未归属项目消失**（`app.js:5275-5295`）：置顶/归档分区的团队过滤原用
  `effectiveProjectTeamId === railId`，未归属项目回落默认团队 id——选中非默认团队时一置顶就从侧栏
  彻底消失（树排除 pinned，分区又够不着）。改为与树「未归属」兜底同律：显式归属命中或未归属（null）都收。
  项目/会话/归档会话三处同修。
- **M1 pinned+interrupted 双列**（`app.js:5278`）：interrupted 归「正在工作」区（renderRuns 同律），
  pinned 的 interrupted 原同时进置顶区，双列双计数。pinnedRuns 追加 `status !== "interrupted"`。
- **M2 置顶会话树中不去重**（`app.js visibleTreeSessions` + looseByTeam）：置顶会话原既进置顶区又留树中
  （run/项目均为互斥纪律），且 markSelectedSessionLink 只亮首处。树内过滤（含跨团队 loose 组）排除 pinned。
- **M3 团队分区两套折叠控件失同步**（`workbench-chrome.js:227` + `app.js:18731`）：chrome 注入的 chevron
  （class+localStorage）与 team-tree-toggle（hidden+aria，内存态）读写两套状态，刷新后 aria 失同步。
  RAIL_GROUPS 移除 team 条目；toggle 单管并持久化到同 key `514cc-rail-groups.team`（老偏好无缝继承）。
- **L1 远程台账 seq 超车**（`app.js:11144-11165`）：`loadProjects` 远程段 await 期间可被更新的请求
  超车后仍写旧 `remoteProjects` 并重渲。改为局部变量落地 + await 后 seq 复查。
- **L2 双 change 监听**（`app.js:18674` + 原 18850 循环）：task-model/effort/permission 每次变更双触发
  renderStatusline/renderComposerCliConsole。合并为单监听，行为等价。
- **L3 命令面板高亮切片错位**（`command-palette.js:433`）：在转义后文本里按未转义长度切片
  （query 含 `<` 时 `<mark>` 切断 `&lt;` 实体出乱码）。按转义后实体长度切片。
- **L4 state.js remoteGates 重复键**（169 行 `null` 被 302 行 `[]` 静默覆盖）：删后者，保留未加载语义。
- **L5 overview run-row 无键盘激活**（`app.js:18013`）：div[role=button] 补 Enter/Space keydown 委托，
  与 click 委托同路。
- **L6 button 吞 heading 语义**（`index.html:487/558`）：折叠按钮内 h2 → span[role=heading]，
  6 处 CSS 选择器并联 `.pane-title`，双主题截图验证视觉零回归。

### 视觉打磨（截图驱动）

- **状态栏滚出视野（真实缺陷）**：侧栏内容超长时 rail-statusline 无 sticky，随列表滚出视野，
  只剩账户坞钉底。`index.html` 新增 `.rail-footer` 包裹状态栏+账户坞整体 sticky 钉底
  （`styles.css:7962`）；受影响的两处 `.run-rail > .rail-statusline` 选择器放宽为后代选择器。
- **分区头标题居左统一**：通用 `.pane-heading` 的 space-between 把 chevron/标题/计数甩成"标题居中"，
  与团队头左对齐不一致。侧栏分区头改 flex-start + 计数 pill 推右（`styles.css:7981`）。
- **run 行 meta 降噪**：侧栏四区已按选中团队隔离，meta 里团队名恒等于当前团队纯冗余
  （三行挤压之源）。railRunMarkup 删除该段。

### 审查后未采纳

- **L7 renderRuns→renderProjects 全量重建**：commitMarkup 幂等兜底（同 markup 不写 DOM），
  339 项目级字符串生成代价可接受；按 linkIndex 脏标记解耦的回归风险大于收益，不动。

## 验证

- 侧栏契约测试 20/20（新增 1 个契约测试沉淀 H1/M1/M2/M3/L6 纪律：
  `tests/workbench-rail-and-tools-contract.test.mjs` "pinned and archived rail sections..."）。
- 完整回归两轮：修复后 1296 全绿；美化后 **1307 tests / 1306 pass / 0 fail / 1 skip**。
- mock 高密度数据截图（隔离实例 + playwright route 拦截，`.scratch/rail-beauty-shots.mjs`）：
  before/after 对比 + 深色主题验证 + 归档展开/滚动钉底形态，证据 `.scratch/rail-beauty/*.png`。
  H1（未归属置顶项目「单摆」在置顶区）、M1（pinned interrupted 在正在工作区）截图可见。

## 交付清单

- 本轮交付（tracked 修改 8 件）：`public/app.js`、`public/index.html`、`public/styles.css`、
  `public/state.js`、`public/command-palette.js`、`public/workbench-chrome.js`、
  `public/forge/workbench.css`、`tests/workbench-rail-and-tools-contract.test.mjs`。
- 本轮交付（未跟踪新增 1 件）：本 handoff。
- 本轮 scratch（不交付）：`.scratch/rail-beauty-shots.mjs`、`.scratch/rail-beauty/`。
- 注意：`public/*` 多文件同时携带其他协作者的未提交改动（diff stat 不可按行数归属到本轮）。

__DELTA__: Kimi(514cc-cli) | 1 | governance | 证据：app.js:5278 起置顶/归档区未归属兜底+M1/M2 互斥纪律 + workbench-chrome.js:227 折叠单控 + styles.css:7962 rail-footer 钉底，契约 20/20、完整回归 1306 绿、双主题截图 .scratch/rail-beauty/
