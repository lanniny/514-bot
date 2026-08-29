---
from: 烛
to: claude
topic: skill-mcp-three-entry-r2
mode: architecture+standard (reflection)
reviewed: 2026-08-20 18:17
prior: .ai-shared/handoff/codex-to-claude__skill-mcp-three-entry__20260820-1806.md
codex_channel: subagent-direct (codex-agent MCP 本会话未注册；未伪造 CLI 输出)
---
<!-- 514cc-session-id: 29ebf7 -->

# Codex 评审：Skill/MCP 三入口收口 R2

- **评审模式**：architecture + standard（复检）
- **评审范围**：R1 致命项对照当前工作区 `index.html` / `app.js` / `ccswitch-panel.js` / forge CSS / `capability-flow-ui.test.mjs` / `team-kit.test.mjs`
- **评审时间**：2026-08-20 18:17
- **Codex 模型**：Cursor 烛 subagent 直审
- **总 token**：n/a

---

## 致命问题（必须改）

无。R1 两条致命已关闭：

1. `ccswitch-panel.js:334-371` 恢复 `MCP 投影` / `Skill 安装` 页签，`mcpsMarkup` / `skillsMarkup` 重新接入 `resourcesMarkup`，per-app 投影（`:670-671`）与 CRUD（`:712-715`）再次可达。
2. 能力页创建钮改为 `openLocalRuntimeWorkbench("resources", { resourceTab: "skills"|"mcps" })`（`app.js:22406-22408`），不再调用 `openCapabilityWizard`。总线第 1 卡 `data-runtime-capability-jump="current"`（`index.html:1585`）按 `state.capabilityWorkspace` 映射到 `skills`/`mcps`（`app.js:20832-20836`）。团队第三列改名「生效检查」（`index.html:1453`）。

## 建议改进（值得讨论）

1. **[index.html:2613-2713 + app.js:5354-5441 + 22409-22422 + tests/capability-flow-ui.test.mjs:24-25 + tests/config-topology-ui.test.mjs:231-237]** 弱向导只是断了主按钮，没有拆除。`openCapabilityWizard` 已无调用点，但 dialog / submitSkillWizard / submitMcpWizard / `POST /api/capabilities/skills` 全套仍接线。`capability-flow-ui` 仍断言 `id="cap-skill-wizard"`，`config-topology-ui` 仍把 `openCapabilityWizard` 当活路径。这会把「唯一强实现」重新锁成双轨。应删 DOM 与死函数，并改测试为「创建钮必须 openLocalRuntimeWorkbench、禁止 showModal 向导」。

2. **[app.js:12097-12099]** `openLocalRuntimeWorkbench` 先 `setView(local-runtime)`，面板缺失时 `openTab` 为 `undefined` 且无 toast。默认 `state.tab` 是 `"proxy"`（`ccswitch-panel.js:213`）。用户会进本机运行时却停在代理页，以为「安装 / 投影」失败。创建钮路径应检查返回值并提示。

3. **[ccswitch-panel.js:745 + app.js:9546 + 9562 + 20829]** 「补 reduced-motion」只覆盖团队第三列滚动（`app.js:20845`）。第 1 层真正落地的 `openTab` 仍 `behavior: "smooth"`；打开团队设置、总线 03 滚矩阵同样未判断。

4. **[index.html:1581-1582 + 1606-1612 + 1453 + app.js:9521]** 文案仍有错层：总线标题「一处接入」与「三层各写各的真源」打架；能力页签仍叫「Skill 资源与成员范围」「MCP 资源与接入」，第 1 层已明确在本机运行时。生效列标题改对了，读数仍是「全部可声明 / N 项受限」，未拆 Skill/MCP。

5. **[app.js:22374-22378]** `forge:open-capabilities` 已 `focus: false` 再设 workspace，用户点击路径可用。`setView` 仍不传 `capabilityWorkspace`；`mountCcSwitchPanel`（约 `:22792`）仍早于 `bindEvents`（约 `:22823`）。bind 前若程序化 `dispatchEvent` 仍会丢。应 `setView(..., { capabilityWorkspace, focus: false })` 一次完成，或把监听挂到 mount 之前。

6. **[capability-flow-ui.test.mjs:8-46]** 比 R1 更贴职责与深链字符串，仍是源码正则，测不到 `openTab` 真切到 `mcps`/`skills`，也测不到面板缺失。

## 可保留（看似奇怪但合理）

1. 本机桥卡片同时提供「去能力中心」（`ccswitch-panel.js:342-351`）与反向深链，是跨层导航，不是第三套编辑器。
2. 总线 03 固定进 Skill 矩阵（`index.html:1597`）：成员范围本来就只作用于 Skill 声明。
3. 团队页「只选菜单，不安装、不授权」（`index.html:1445`）与第 1 层职责切开，这句该留。
4. MCP 能力页保留隔离启停（扫描面）与本机投影 CRUD 并存，两套真源不同（claude.json 隔离 vs ccswitch domain live），不要再合成一个表。

## 总评

R1 致命回退已补上：物理安装 / CLI live 投影重新落在本机运行时，能力页创建与总线第 1 卡都深链到该面。当前剩余是收口不彻底——弱向导尸体仍被测试钉住、深链失败静默、reduced-motion 只补了一处、部分标题还在说「资源」。不构成再一次功能消失，但会让「唯一强实现」在下一轮 diff 里被搜字符串的测试拖回去。

---

## 下游建议

### 建议召唤
无。删死向导并改测试断言「禁止 wizard showModal」即可，不必再扩规格。

### 风险信号
- 测试仍要求 `cap-skill-wizard` / `openCapabilityWizard` 存在
- `openLocalRuntimeWorkbench` 失败无用户可见反馈

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 1 | 证据：R1 致命已关（ccswitch-panel.js:334-371）；残留弱向导被 capability-flow-ui.test.mjs:24-25 与 config-topology-ui.test.mjs:231 锁死
