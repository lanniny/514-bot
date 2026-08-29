---
from: 烛
to: claude
topic: skill-mcp-three-entry
mode: architecture+standard
reviewed: 2026-08-20 18:06
codex_channel: subagent-direct (codex-agent MCP 本会话未注册；未伪造 CLI 输出)
---
<!-- 514cc-session-id: 29ebf7 -->

# Codex 评审：Skill/MCP 三入口收口

- **评审模式**：architecture + standard
- **评审范围**：`apps/control-center/public/index.html`、`public/app.js`、`public/modules/ccswitch-panel.js`、`public/forge/{data,shell,runtime-workbench}.css`、`tests/team-kit.test.mjs`、`tests/capability-flow-ui.test.mjs`（只读，对照未提交 diff）
- **评审时间**：2026-08-20 18:06
- **Codex 模型**：Cursor 烛 subagent 直审
- **总 token**：n/a

---

## 致命问题（必须改）

1. **[ccswitch-panel.js:340-353 + 362-371 + app.js:5133-5145 + app.js:5394-5406]** 隐藏本机 Skill/MCP 页签后，独有的 **ccswitch domain 库存面**从可达 UI 消失，能力中心并未接走。旧页签独有能力包括：按 CLI 切换 live 投影（`PUT /api/ccswitch/domain/{skills|mcps}/:id/apps/:app`，见 `ccswitch-panel.js:670-671`）、粘贴完整 `SKILL.md` 写入 domain（`:644`）、编辑已有 MCP JSON（`mcpsMarkup` + `fillMcp` `:492`）、卸载 Skill / 删除 MCP（`:713-716`）。能力中心 Skill 向导走的是另一条 API：`POST /api/capabilities/skills`（`app.js:5402`），只写仓库 `.agents/skills`（`src/capabilities.mjs:851-874`），不投影各 CLI live。MCP 卡片只有隔离启停和真源按钮（`app.js:5133-5145`），**没有**既有 server 的 per-app 投影开关。桥文案却写「能力中心统一负责安装、CLI 投影」（`ccswitch-panel.js:347`）——分层叙事与真实可达操作不一致。用户目标第 1 层「资源存在/CLI 投影」目前对 **已存在的 ccswitch Skill/MCP** 没有替代入口。

2. **[ccswitch-panel.js:362-371 + 492 + 670-716]** 上述 markup / `fillMcp` / 提交与点击处理仍留在模块里，只是 `resourcesMarkup` 不再调用。这不是“收口”，是 **死代码伪装收口**：Profile 快照仍声称拍摄 Prompt/MCP/Skill 投影（`:376`），深链仍能导入 Skill（`:651`），但日常管理面已被抽空。任何依赖旧页签的深链 `openTab(..., { resourceTab: "skills"|"mcps" })`（`:743-747`）只会跳到能力中心，**打不开**原来的 domain 编辑器。

## 建议改进（值得讨论）

1. **[app.js:9511-9521]** 「成员范围」读数不表示有效声明数。`effective` 在存在 `status !== "ok"` 时显示「N 项受限」，否则「全部可声明」。它把 Skill 的 ghost/gated/partial 与 MCP 的 ghost/off **混成一个数**，也不展示「对多少成员实际可见」。列标题是「成员范围」，指标却是「选中项里有多少不健康」。应拆 Skill/MCP，或改成「可选中 X / 对成员有效 Y」。

2. **[app.js:22367-22371]** `forge:open-capabilities` 先 `setCapabilityWorkspace` 再 `setView("config", { configSurface: "capabilities" })`，且 **不传** `capabilityWorkspace`。`setView` 默认 `focus: true` 会先把焦点打到配置页 `h1`（`app.js:2267-2272`），再 `rAF` 聚焦页签。窗口事件本身可靠（`window.dispatchEvent` + `window.addEventListener`），但应 `setView(..., { capabilityWorkspace, focus: false })` 一次完成，避免焦点抖动，也避免未来 `setView` 重绘把 workspace 打回默认。监听器挂在 `bindEvents`（`:22823`），`mountCcSwitchPanel` 更早（`:22792`）；当前 load 不派发事件，用户点击安全，**程序化在 bind 前 `openTab` 会丢事件**。

3. **[ccswitch-panel.js:337 + 341]** `resourceTabs` 的 `role="tablist"` 无 `aria-controls`、无 tabpanel、无方向键。`resourcesMarkup` 在渲染中改 `state.resourceTab`（副作用）。桥按钮无 `aria-describedby` 指向说明文字。

4. **[index.html:1448-1453 + shell.css:754-815]** 团队生效链有 `max-width:720px` 折行，chevron `aria-hidden` 合理。`team-capability-flow` 的 `scrollIntoView({ behavior: "smooth" })`（`app.js:20839`）未尊重 `prefers-reduced-motion`（能力矩阵列聚焦已经做了，`:5162`）。

5. **[index.html:1585-1601 + data.css:1040-1046]** 总线 01 固定 `data-cap-jump="skills"`，MCP 资源接入要再点一次工作区页签；03 只滚 Skill 矩阵，MCP 没有「成员范围」。与文案「三层作用不同」部分错位。

6. **[capability-flow-ui.test.mjs:8-43 + team-kit.test.mjs:30-40]** 测试几乎全是源码正则：有没有某段 HTML/函数名/CSS 选择器。`resourceTabs` 切片断言页签数组不再含 MCP/Skill（`capability-flow-ui.test.mjs:31-35`），但 **测不到** `skillsMarkup`/`mcpsMarkup` 仍在、事件是否切面、团队三项数字是否算对。`assert.match(app, /data-team-capability-jump/)` 只证明字符串存在于 `app.js` 监听器，不证明团队页按钮绑的是它（团队页实际用 `data-config-surface-jump="capabilities"`，`index.html:1446`）。

7. **[ccswitch-panel.js:343-353 + runtime-workbench.css:56-97]** 桥卡片在「资源」每个子页都置顶，Prompt/Workspace 编辑时持续占位。可只在资源首页或空态出现一次。

## 可保留（看似奇怪但合理）

1. **[app.js:2183-2186]** `setView("capabilities")` 别名切到 `config/capabilities`，左栏技能行（`app.js:21594-21596`）和事件监听可以共用一条路，不是第三套表面。

2. **[index.html:1578-1603 + 1443-1463]** 能力总线 01/02/03 与团队页「资源库 → 团队菜单 → 成员范围」拓扑对齐，方向正确。团队页明确「只选菜单，不安装、不授权」是对的。

3. **[app.js:5413-5438 + 9894-9897]** MCP **新建**向导仍走 `/api/ccswitch/domain/mcps` 且强制至少一个投影目标。丢失的是 **存量**编辑，不是创建路径整体被删。

4. **[ccswitch-panel.js:396-399 + 651]** 深链导入仍留在本机资源页，Skill 远程安装没有被这次收口误删。

5. **[ccswitch-panel.js:677-680 + 743-747]** 用 `window` CustomEvent 做跨模块跳转，比再塞一套 `app.js` 回调进 ccswitch 模块更干净；机制本身可留，缺的是 workspace 参数要跟 `setView` 一次传完。

6. **[shell.css:803-815 + runtime-workbench.css:88-97 + data.css:2121-2168]** 三处都有 720px 折列，不是只做了桌面网格。

7. **[team-kit.js:14-32 + team-kit.test.mjs:7-28]** 分类函数本身有单元测试（ghost/gated/partial/off），比 UI 文本测试扎实。问题在 `renderTeamChips` 如何把分类压成一句「受限」。

## 总评

收口叙事（资源 / 团队菜单 / 成员范围）在 HTML 和总线文案上已经立住，跨页事件通道也选对了。但 **实现只拆掉了本机页签，没有把 ccswitch domain 的 CLI 投影与存量 CRUD 迁到能力中心**。Skill 向导写的是仓库技能目录，MCP 卡片只管隔离。结果是：入口变少了，第 1 层承诺的「CLI 投影」对存量资源不可达。团队第三列数字会误导。配套测试只锁文案，锁不住这次真正该锁的行为。

---

## 下游建议

### 建议召唤
无。先把存量 CLI 投影/编辑迁到能力中心（或在本机保留一个显式「domain 库存」而不是伪装已迁移），再补一条带 DOM/事件的测试。

### 风险信号
- 文案宣称「CLI 投影在能力中心」但 Skill 创建不投影 live
- 死代码 `skillsMarkup`/`mcpsMarkup` 让源码搜索以为功能还在
- `openTab(resourceTab: skills|mcps)` 静默改道，旧书签/自动化失效且无提示

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 1 | governance | 证据：ccswitch-panel.js:340-371 隐藏页签后 domain Skill/MCP 独有投影与 CRUD 无替代面；app.js:5402 向导走 capabilities.createSkill 而非 ccswitch domain
