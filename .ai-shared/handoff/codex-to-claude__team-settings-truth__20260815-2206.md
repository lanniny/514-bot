<!-- 514cc-session-id: 3c8f2c26-e11c-4a4a-8e0c-b0c1d2e3f4a5 -->
# Codex 评审：team-settings-truth

- **评审模式**：standard
- **评审范围**：`apps/control-center` 团队设置面接线真假（`#view-team` / `#team-form` / `#team-surface-settings`、`fillTeamForm` / `saveTeamForm` / `applyTeamProviders` / `loadProviders` / `loadCapabilities`、`member-library.js#setSurface`、`team.css` hidden 覆盖、`/api/teams` + `/api/providers/apply-team`）
- **评审时间**：2026-08-15 22:06
- **Codex 模型**：烛(codex-reviewer) 主驾直审（本轮未另开 MCP 对话桥；route-gate session 按任务卡给定）
- **总 token**：—

---

## 致命问题（必须改）

1. **新团队草稿点「导出」会静默导出另一个已保存团队。**
   `exportEditingTeam` 在 `editingTeamId == null` 时回退 `currentTeam()`（即 `selectedTeamId` 的现场团队），且脏草稿告警条件要求 `team.id === state.editingTeamId`，新草稿两边都不成立。
   - `apps/control-center/public/app.js:7728-7747`：`const team = teamById(state.editingTeamId) ?? currentTeam()`；只有 `teamFormDirty && team.id === state.editingTeamId` 才警告「导出的是已保存版本」。
   - `apps/control-center/public/app.js:17694-17697`、`7683-7707`：`新建` / 预设都先 `fillTeamForm(null)`，此时 `editingTeamId` 被置空（`7384`）。
   - `apps/control-center/public/index.html:1127`：导出按钮就在设置表单脚注，title 还写「把当前团队……导出」。
   - 体感：人在「新建团队」表单里点导出，下载到的是 514cc（或本标签页已启用的那支）的磁盘快照，toast 还报成功。导入是真接线（`7754-7814` → `POST /api/team-members` + `POST /api/teams`）；导出这条在新草稿路径上是假主体。

---

## 建议改进（值得讨论）

1. **下拉「团队」和现场花名册不是同一真相源——这是刻意双轨，拆 tab 后编排面上更像 bug。**
   - 下拉只改编辑草稿：`17712-17718` `change` → `fillTeamForm(...)`，只写 `state.editingTeamId`（`7384`），不碰 `selectedTeamId`。
   - 现场花名册 / 协作流 / 脉搏走启用团队：`currentTeam()` = `selectedTeamId`（`6056`）；`refreshCollabFlow` 默认 `selectedTeamId`（`collab-flow.js:71`）；`renderTeamActivation` 把 `#team-runtime-team-name` 写成 `active?.name`（`7139-7141`），与下拉可以不是同一个队。
   - 启用是独立动作：`7512-7520` `activateEditingTeam` → `selectTeam`；测试还锁死「保存/另存为不得隐式启用」（`tests/team-workspace-ui.test.mjs:198-208`）。
   - 拆 tab 的回归面：表单标题「编辑团队 · X」被藏进第三 tab（`index.html:1060-1065`），编排面只剩顶栏下拉 + 「当前运行态」。状态芯片会写「仅查看」（`7156`），但 `#team-edit-button` title 仍是「打开当前团队的设置」（`index.html:817`），成员库按钮写「加入当前团队」（`index.html:924`），实际改的是编辑草稿复选框（`18537-18553`）。同一句「当前团队」在顶栏/脉搏里指 `selectedTeamId`，在设置/成员库里指 `editingTeamId`。
   - 建议：顶栏下拉改成「查看/配置」，成员库改成「加入正在编辑的团队草稿」；或编排面下拉改绑 `selectedTeamId`、设置面另留编辑器选择。现在这套机械上自洽，观感上不真。

2. **`applyTeamProviders` 默认参数确实盯着配置图谱的 `#provider-team-select`，团队页靠显式传参才没走错。**
   - `9299`：`async function applyTeamProviders(teamId = elements["provider-team-select"].value)`
   - 团队页按钮：`17721-17722` 传 `state.editingTeamId`（对）。
   - 配置图谱「一键应用」：`18016` 无参调用，用 `#provider-team-select`（对，那是另一条 UI）。
   - 脚枪：以后谁在团队面写 `applyTeamProviders()` 就会应用图谱下拉里的队，不是正在看的队。默认值应改为「调用方必须给 teamId」，或按入口拆两个函数。

3. **`loadProviders` / `loadCapabilities` 回填已不再看 `dialog.open`，但 `fillTeamForm` 注释还在撒谎。**
   - 代码：`3605-3611`、`7894-7898` 都是 `if (elements["team-settings-panel"])`。`#team-settings-panel` 仍是整页工作区外壳（`index.html:797`），拆 tab 后也一直在，钩子会打到隐藏表单。
   - 注释：`7394` 仍写「loadProviders 末尾钩子会按 dialog.open 回填」。dialog 已删（测试 `team-workspace-ui.test.mjs:64` 锁死）。注释按旧闸门读会误判「档案晚到不再回填」——事实相反，现在只要面板在就回填，而且脏草稿走 `collectTeamProviderBindings` / `checkedChipValues` 保勾选。

4. **「设置」按钮不保证打开的是现场启用团队。**
   `17724-17726` 只 `openTeamSettingsSurface()`，不 `fillTeamForm(currentTeam())`。下拉已切到 B、花名册仍是 A 时，点「设置」进的是 B 的草稿。若产品语义是「打开当前运行团队的设置」，这里缺一次对齐或一次确认。

5. **导入成功后刷新的是启用团队的协作流，不是刚导入的队。**
   `7802-7804`：`fillTeamForm(created)` + `openTeamSettingsSurface` + `refreshCollabFlow()`（无 teamId）。下拉/表单已是新队，编排面花名册仍是旧 `selectedTeamId`。与双轨设计一致，但导入 toast 容易让人以为「现场已经换成刚导入的队」。

---

## 可保留（看似奇怪但合理）

1. **设置面是真接线，不是花架子。**
   - 保存：`7565-7630` `collectTeamForm` → `POST/PUT /api/teams` → `loadTeams({ fresh: true })`；服务端 `teams.mjs:414-438` 校验成员/主脑后原子写。
   - 启用：`selectTeam` 写 `selectedTeamId` + `localStorage`（`7070-7082`），编排面/composer/脉搏都读它。
   - 应用供应商：`9321` `POST /api/providers/apply-team`；服务端 `server.mjs:1288-1290` → `providers.mjs:3467-3481` 按**已保存** `team.providers` 逐 app `switchTo`，部分失败不吞。脏草稿会先拦住（`9300-9302`、`7162-7171`）。
   - 预设：只填草稿，不落盘（`7706-7715`），保存前可改——诚实。
   - 芯片墙 / 席位勾选：`collectTeamForm` 直接读 DOM（`7537-7562`）；过滤只 `hidden` 不卸节点（`7270-7288`）；目录漏渲染的既有成员按磁盘补回（`7543-7546`）。
   - 导入：真 `POST` 成员 + 团队，失败逐条上报（`7770-7791`）。

2. **hidden 表单仍收集得到；`required` 没有在隐藏 tab 上变成死校验。**
   `#team-surface-settings { display: flex }` 被 `#team-surface-settings[hidden] { display: none }` 盖住（`team.css:177-186`），否则 specificity 会压过 `[hidden]`，设置面拆出去后会「藏不住」。表单仍在文档里，`collectTeamForm` / 芯片回填 / 成员库勾选都读得到。保存按钮在设置面内部（`index.html:1135`），隐藏 tab 点不到原生 submit；`#team-name-input[required]` 只在设置面可见时走浏览器校验，JS 自己还拦了空名/空成员/空主脑（`7574-7584`）。

3. **builtin 只读 / 另存为是 fail-closed，不是 UI 装样子。**
   前端：字段 `disabled`（`7406-7408`）、`markTeamFormDirty` 直接 return（`7126`）、删除键隐藏（`7410`）、保存走 `POST` 副本（`7588-7594`）、`deleteEditingTeam` 遇 builtin 直接 return（`7635`）。
   后端：`teams.mjs:2-3, 429, 443` — builtin 不落盘，`update`/`remove` 一律 `FROZEN_BLOCK`。存储 `failClosed` 时写入冻结（`376` 一带）。另存为不会 PUT 到 `team-514cc`。

4. **回填钩子看 `#team-settings-panel` 而不是「设置 tab 是否可见」是对的。**
   档案/能力目录晚到时，隐藏表单也必须把下拉和芯片墙补上，否则切到第三 tab 会看到占位或丢勾选。`3604` / `7893` 的注释已经改成「团队设置已并入团队页」。

5. **双轨本身（浏览 ≠ 启用）值得留。**
   保存新队不抢当前会话、脏草稿不能启用/不能应用供应商，都是防误伤。问题在用词和编排面缺解释层，不在「必须合成一个 id」。

---

## 总评

团队设置面**大部分是真接线**：保存/启用/应用供应商/预设/导入/芯片墙/席位勾选都打到 `/api/teams` 或 `/api/providers/apply-team`，builtin 前后端双闸 fail-closed。拆到 `#team-surface-settings` 之后，hidden 收集、校验、回填钩子、焦点（先 `setSurface` 再 rAF focus，`7486-7494`）、脏草稿（切 tab 不丢，切下拉要确认）没有看到因 `display:none` 导致的收集断裂；`dialog.open` 闸门已从代码里摘掉，只剩一条过期注释。

「是否真实」的裂缝在主体，不在插座：顶栏下拉是编辑草稿，花名册是启用团队；「当前团队」四个字在不同按钮上指两个 id。新草稿导出还会把启用团队的磁盘包当成眼前表单导出去——这是本轮唯一必须改的假动作。

__VERDICT__: CHANGES_REQUESTED

---

## 下游建议

### 建议召唤
- 主驾收口导出主体 + 「当前团队」用词；不必为双轨本身再拉策。
- 不需要织/匠。

### 风险信号
- 导出按钮在新草稿里会交出另一支团队的成员/提示词/供应商绑定包，迁移/分享会传错队。
- 编排面下拉与花名册并排时，LO 会以为已经切了现场团队。

__DELTA__: 烛(Codex) | 1 | governance | 证据：app.js:7728-7747 新草稿导出错主体；app.js:17712-17718 下拉只改 editingTeamId；app.js:7394 注释仍写 dialog.open 但 7894 已改看 team-settings-panel

主驾收口（2026-08-15 22:10）：导出已去掉 `currentTeam()` 回退；无 `editingTeamId` 时提示「先保存团队，再导出」，新建草稿隐藏导出按钮。契约测试 `team export refuses unsaved drafts` 已过。双源用词未改行为，只把「设置」按钮 title 改成「打开正在配置的团队设置」。
