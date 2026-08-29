---
reviewer: "烛（Codex）"
mode: "standard"
topic: "seat-first-providers-migration"
reviewed_at: "2026-08-20 17:15 +08:00"
workspace: "I:/514claude/514cc"
verdict: "CHANGES_REQUESTED"
---
<!-- 514cc-session-id: 9afbab2d-bed9-4249-992d-40aad9ee96ff -->
# Codex 评审：独立供应商页签迁入席位工作面

## 致命问题（必须改）

1. **不使用 ProviderStore 的 Adapter 会继承上一个席位的应用过滤，连接甲板展示错误应用。**  
   `connectionApp()` 对 Kimi 等 `providerApp` 为空的 Adapter 返回空字符串，通知仍会发出（`apps/control-center/public/modules/runtime-seat-manager.js:742-748`）；但宿主回调只在 `app` 非空时更新 `state.providerActiveApp`，随后无条件重画旧应用（`apps/control-center/public/app.js:22876-22879`）。`renderProviders()` 遇到空 `lockedApp` 也保留旧值（`apps/control-center/public/app.js:10458-10464`）。因此从 Codex 席位切到 Kimi/CLI-managed 席位后，甲板仍显示 Codex 连接，直接违反“席位 Adapter 锁定连接上下文”。应为无 ProviderStore 的 Adapter 渲染明确空态/禁用态，或定义可审计的映射；不能沿用上一个应用。

2. **远端 QA 的入口顺序已被本机 alias 破坏，会在真正点击远端 providers 页签前超时。**  
   脚本先打开 `#config/providers`（`apps/control-center/scripts/qa-remote-config.mjs:604`），而本机 `setConfigSurface()` 会立刻把它归一成 `sources`（`apps/control-center/public/app.js:2094-2100`）。随后脚本选中远端主机便直接等待 `.config-remote-provider-deck`（`apps/control-center/scripts/qa-remote-config.mjs:636-638`），但 `selectConfigHost()` 只切目标、不把 surface 改回 providers（`apps/control-center/public/app.js:2608-2618`）；真正点击 `[data-config-surface="providers"]` 要到脚本第 754 行。该 QA 会卡死在第 637 行，无法证明“远端仍保留 providers surface”。应在选中远端目标后先点击 providers 页签，再等待远端连接甲板，并断言标签为“连接”。

## 建议改进（值得讨论）

1. **live 轮询在“高级真源”子工作面仍持续空转。**  
   连接甲板位于 `#runtime-seat-workspace`，切到高级真源时该工作面被隐藏（`apps/control-center/public/modules/runtime-seat-manager.js:783-795`）；但 `providerLiveViewVisible()` 只检查顶层 `config/sources`，没有检查 `state.runtimeWorkspaceMode === "seats"` 或甲板实际可见性（`apps/control-center/public/app.js:10034-10038`）。于是高级真源面仍每 8 秒请求 live 并可能重画隐藏甲板（`apps/control-center/public/app.js:10059-10074`）。这不会丢数据，但违背注释中的“供应商面可见才轮询 / 不在后台空转”。建议把席位子工作面纳入条件，并在 `onModeChanged` 后调用轮询归属重算。

2. **现有测试多为源码正则，没覆盖迁移最危险的行为组合。**  
   `provider-live-hot-reload` 只断言条件源码包含 `configSurface === "sources"`（`apps/control-center/tests/provider-live-hot-reload.test.mjs:177-193`）；`config-topology-ui` 只证明 hidden 属性和 DOM 搬迁（`apps/control-center/tests/config-topology-ui.test.mjs:58-64,92-101`）。建议增加浏览器/可执行状态测试：本机 `#config/providers` 只归一一次且不产生 hash 循环；远端选中后 providers 页签可见可点；键盘序列永不命中 hidden providers；Codex→Kimi Adapter 切换后不显示 Codex 列表；高级真源面停止 live 轮询。

## 可保留（看似奇怪但合理）

1. `CONFIG_SURFACES` 继续包含 `providers` 是正确的：远端仍需该 surface，不能从枚举删除（`apps/control-center/public/app.js:144-151`）。
2. 本机 alias 使用 `history.replaceState`，不会触发 `hashchange`，当前实现没有形成 alias 死循环（`apps/control-center/public/app.js:2117-2122`）。
3. 键盘导航已经显式过滤 `hidden` 与 `disabled` 页签，隐藏 providers 不会进入本机箭头循环（`apps/control-center/public/app.js:21851-21863`）。
4. 连接甲板虽没有 `.runtime-connection-deck` class，但具备 `.provider-bus`，现有布局选择器仍能命中并跨两列占满（`apps/control-center/public/index.html:1856`；`apps/control-center/public/forge/data.css:1565-1590`）。新增第二行 `minmax(280px, 42vh)` 与甲板滚动边界也相互匹配。
5. `state.configSurface` 默认改为 `sources` 与 seat-first 本机拓扑一致（`apps/control-center/public/state.js:123-130`）；远端 providers 由目标选中后显示的页签承载，不需要恢复本机独立页。
6. 定向 Node 测试本轮实际执行结果为 45 pass / 0 fail；这证明静态契约未破，但上述两项致命问题正好落在当前测试未覆盖的交互组合里。

## 总评

迁移主结构成立：本机供应商页签已隐藏，provider deck 已进入席位布局，CSS `.provider-bus` 覆盖有效，键盘隐藏过滤和本机 hash alias 也没有形成循环；远端 providers surface 仍保留。当前不能批准：无 ProviderStore Adapter 会展示上一应用的连接列表，远端 QA 又会因 alias 后的等待顺序而超时，分别造成真实 UI 误导和远端保留契约无法验收。

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 1 | 证据：apps/control-center/public/app.js:22876-22879 在 Adapter 无 providerApp 时保留旧 providerActiveApp，且 scripts/qa-remote-config.mjs:604,636-638 会在本机 providers→sources alias 后提前等待远端连接甲板。
