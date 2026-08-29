---
from: 烛
to: claude
topic: skill-mcp-three-entry-r3
mode: architecture+standard (final reflection)
reviewed: 2026-08-20 18:35
prior: .ai-shared/handoff/codex-to-claude__skill-mcp-three-entry-r2__20260820-1817.md
codex_channel: subagent-direct (codex-agent MCP 本会话未注册；未伪造 CLI 输出)
tests_claimed_by_user: targeted 5 tests green（本轮未复跑）
---
<!-- 514cc-session-id: 29ebf7 -->

# Codex 评审：Skill/MCP 三入口收口 R3（终检）

- **评审模式**：architecture + standard（最终只读复检）
- **评审范围**：旧向导残留、深链、`openLocalRuntimeWorkbench`、文案、相关测试
- **评审时间**：2026-08-20 18:35
- **Codex 模型**：Cursor 烛 subagent 直审
- **总 token**：n/a

---

## 致命问题（必须改）

无。R1 功能回退与 R2 弱向导双轨均已关闭：

- 能力页 wizard DOM / `openCapabilityWizard` / submit 函数 / `cap-wizard` CSS / cache ID 在 `public/` 中搜不到（仅测试 `doesNotMatch`）。
- 创建钮锁定 `openLocalRuntimeWorkbench("resources", { resourceTab: "skills"|"mcps" })`（`app.js:22193-22195`）。
- 本机页签与 CRUD 仍接在 `resourcesMarkup`（`ccswitch-panel.js:334-371`）。
- `openLocalRuntimeWorkbench` 已 async：面板未挂或 `openTab` 失败会 toast 并 `return false`（`app.js:11877-11887`）。

## 建议改进（值得讨论）

1. **[app.js:9674-9677 + tests/provider-dialog-target-app.test.mjs:82-83]** `MCP_TARGET_META` 定义后零引用，是向导投影网格留下的死常量。供应商测试仍用它当分节锚。删常量时必须改切片边界，否则测试会碎。

2. **[index.html:1606-1612 + tests/capability-flow-ui.test.mjs:22-23]** 总线已改「一条路径，分层生效」（`index.html:1581`），本机主页签已改「资源投影」（`ccswitch-panel.js:23`），但能力工作区页签仍叫「Skill 资源与成员范围」「MCP 资源与接入」，测试还把这两句正向锁死。第 1 层「资源」在本机，能力页这两签更像第 3 层矩阵 + 隔离扫描。

3. **[ccswitch-panel.js:745 + app.js:20616]** 团队列已尊重 `prefers-reduced-motion`（`app.js:20632`）。第 1 层 `openTab` 与总线 03 滚矩阵仍写死 `smooth`。

4. **[app.js:22161-22165]** `forge:open-capabilities` 仍分两步 `setView` + `setCapabilityWorkspace`，不传 `capabilityWorkspace`。用户点击路径可用，bind 前程序化派发仍会丢。

5. **[capability-flow-ui.test.mjs / config-topology-ui.test.mjs]** 已改为反向断言旧向导 ID，并锁定深链字符串。仍是源码正则，不是 `openTab` 行为测试。本轮「5 tests 全过」是主驾声明，烛未复跑。

## 可保留（看似奇怪但合理）

1. `POST /api/capabilities/skills` 仍在 `server.mjs:1352` + `capabilities.createSkill`——那是仓库 `.agents/skills` 后端，不是 UI 第二套向导。市场/API 可继续用。
2. 本机桥「管理 Skill/MCP」跳能力中心（`ccswitch-panel.js:349-350`）与能力页「安装/投影」跳本机，是双向导航。
3. MCP 能力页隔离启停 vs 本机 domain 投影分家，两套真源不同。
4. 总线 03 固定进 Skill 矩阵：成员范围本来只作用 Skill。

## 总评

三层职责现在对得上：物理安装与 CLI live 在本机「资源投影」，团队只选菜单，能力页管声明范围与隔离。旧弱向导从可达 UI 和测试正向锁里拿掉了。剩下是死常量 `MCP_TARGET_META`、能力页签「资源」用词、以及 reduced-motion / 事件接线的边角。无致命回退，可以按当前面交付。

---

## 下游建议

### 建议召唤
无。

### 风险信号
- `MCP_TARGET_META` 零引用但仍被测试当分节符
- 能力页签文案被 `capability-flow-ui.test.mjs:22-23` 正向锁死

__VERDICT__: APPROVED
__DELTA__: 烛(Codex) | 1 | governance | 证据：R2 弱向导已从 public/ 清除；残留 MCP_TARGET_META app.js:9674 零引用；页签文案仍锁「资源」index.html:1608-1612
