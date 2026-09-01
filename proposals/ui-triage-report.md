# UI 分诊报告（只读 · 人工判断清单）

生成时间：2026-08-30T04:40:11.628Z

## 1. 非标准断点（P0-4）

标准档：560 / 820 / 1100 / 1440。共 **64 处**落在标准档之外，涉及 **22 个不同数值**。

> 注意：821 / 1121 这类「±1px」通常是与相邻 `max-width` 成对出现的互斥区间写法，**不是笔误**，不要简单对齐。

| 断点 | 处数 | 代表位置 | 建议动作 |
|---|---|---|---|
| 720px | 13 | `public\forge\art-direction.css:902` | 人工确认后并入 820 |
| 900px | 9 | `public\forge\bootstrapper.css:62` | 人工确认后并入 820 |
| 821px | 6 | `public\forge\console-form.css:1378` | 与相邻档成对，保留（互斥区间） |
| 1280px | 5 | `public\forge\data.css:2919` | 人工确认后并入 1440 |
| 1120px | 5 | `public\forge\data.css:2925` | 与相邻档成对，保留（互斥区间） |
| 640px | 4 | `public\forge\team.css:174` | 人工确认后并入 560 |
| 1000px | 3 | `public\forge\data.css:2085` | 人工确认后并入 1100 |
| 520px | 2 | `public\forge\art-direction.css:816` | 人工确认后并入 560 |
| 700px | 2 | `public\forge\bot-shell.css:932` | 与相邻档成对，保留（互斥区间） |
| 680px | 2 | `public\forge\bot-shell.css:1065` | 与相邻档成对，保留（互斥区间） |
| 860px | 2 | `public\forge\waveg.css:733` | 人工确认后并入 820 |
| 699px | 1 | `public\forge\bot-shell.css:908` | 与相邻档成对，保留（互斥区间） |
| 980px | 1 | `public\forge\bot-shell.css:919` | 人工确认后并入 1100 |
| 1024px | 1 | `public\forge\codex-desktop.css:1188` | 人工确认后并入 1100 |
| 681px | 1 | `public\forge\team.css:3228` | 与相邻档成对，保留（互斥区间） |
| 1121px | 1 | `public\forge\team.css:3234` | 与相邻档成对，保留（互斥区间） |
| 420px | 1 | `public\styles.css:2260` | 人工确认后并入 560 |
| 1080px | 1 | `public\styles.css:4792` | 人工确认后并入 1100 |
| 800px | 1 | `public\styles.css:11507` | 人工确认后并入 820 |
| 760px | 1 | `public\styles.css:12552` | 人工确认后并入 820 |
| 1500px | 1 | `public\styles.css:12716` | 人工确认后并入 1440 |
| 1050px | 1 | `public\styles.css:13467` | 人工确认后并入 1100 |

### 明细（按出现次数降序，每条附规则上下文）

**720px（13 处）**
- `public\forge\art-direction.css:902` — `@media (max-width: 720px) {` → `.app-shell.is-settings #view-config.view .page-heading.compact-heading`
- `public\forge\bootstrapper.css:1019` — `@media (max-width: 720px) {` → `.boot-flavors`
- `public\forge\bot-shell.css:1608` — `@media (max-width: 720px) { .bot-artifact-body { grid-template-columns: minmax(0, 1fr); } .bot-artifact-list { border-right: 0; border-bottom: 1px solid var(--bot-line); } }`
- `public\forge\data.css:2151` — `@media (max-width: 720px) {` → `#config-surface-capabilities .capability-bus-track`
- `public\forge\data.css:2947` — `@media (max-width: 720px) {` → `#view-config`
- `public\forge\hero.css:156` — `@media (max-width: 720px) {` → `.hero-stage`
- `public\forge\overview.css:670` — `@media (max-width: 720px) {` → `.overview-usage`
- `public\forge\runtime-workbench.css:88` — `@media (max-width: 720px) {` → `.ccswitch-workbench .ccs-capability-bridge`
- `public\forge\runtime-workbench.css:479` — `@media (max-width: 720px) {` → `.ccswitch-workbench`
- `public\forge\shell.css:815` — `@media (max-width: 720px) {` → `.team-capability-heading .text-button`
- `public\styles.css:10505` — `@media (max-width: 720px) {` → `.welcome-tip`
- `public\styles.css:13475` — `@media (max-width: 720px) {` → `.ccswitch-workbench`
- …另有 1 处

**900px（9 处）**
- `public\forge\bootstrapper.css:62` — `@media (max-width: 900px) {` → `.bootstrapper-body`
- `public\forge\bot-shell.css:901` — `@media (min-width: 900px) {` → `.bot-shell .bot-run-queue-item`
- `public\forge\console-form.css:599` — `@media (max-width: 900px) {` → `#view-workbench #conversation-meta`
- `public\forge\console-form.css:1125` — `@media (max-width: 900px) {` → `#view-workbench .conversation-heading .conversation-heading-main`
- `public\forge\team.css:939` — `@media (max-width: 900px) {` → `.team-router-fields`
- `public\forge\team.css:1713` — `@media (max-width: 900px) {` → `.member-library`
- `public\forge\team.css:2713` — `@media (max-width: 900px) {` → `.cf-routing`
- `public\styles.css:9756` — `@media (max-width: 900px) {` → `.command-trigger kbd`
- `public\styles.css:10171` — `@media (max-width: 900px) {` → `.workbench-heading-meta`

**821px（6 处）**
- `public\forge\console-form.css:1378` — `@media (min-width: 821px) {` → `.atelier .run-rail`
- `public\forge\experience-polish.css:541` — `@media (min-width: 821px) {` → `.app-shell.is-settings`
- `public\forge\rail-tools.css:948` — `@media (min-width: 821px) {` → `.workbench-shell:not(.mc-collapsed) .terminal-drawer.is-open`
- `public\forge\shell.css:243` — `@media (min-width: 821px) {` → `.atelier .topbar-brand`
- `public\forge\team.css:3397` — `@media (min-width: 821px) {` → `body.team-bg-active #view-workbench .workbench-shell`
- `public\styles.css:466` — `@media (min-width: 821px) and (max-width: 1280px) {` → `.topnav-item span`

**1280px（5 处）**
- `public\forge\data.css:2919` — `@media (max-width: 1280px) {` → `.provider-bus .provider-workspace`
- `public\forge\overview.css:653` — `@media (max-width: 1280px) {` → `.overview-kpi-grid`
- `public\styles.css:466` — `@media (min-width: 821px) and (max-width: 1280px) {` → `.topnav-item span`
- `public\styles.css:4773` — `@media (max-width: 1280px) {` → `:root`
- `public\styles.css:8908` — `@media (max-width: 1280px) {` → `.topbar-brand strong`

**1120px（5 处）**
- `public\forge\data.css:2925` — `@media (max-width: 1120px) {` → `#view-config .config-toolbar`
- `public\forge\team.css:1683` — `@media (max-width: 1120px) {` → `.team-unified-grid`
- `public\forge\team.css:3228` — `@media (min-width: 681px) and (max-width: 1120px) {` → `.tm-group-body`
- `public\styles.css:2219` — `@media (max-width: 1120px) {` → `.workbench-shell`
- `public\styles.css:8926` — `@media (max-width: 1120px) {` → `.workbench-shell`

**640px（4 处）**
- `public\forge\team.css:174` — `@media (max-width: 640px) {` → `.team-inbox-heading`
- `public\styles.css:5689` — `@media (max-width: 640px) {` → `.recovery-bar`
- `public\styles.css:6481` — `@media (max-width: 640px) {` → `.template-card`
- `public\styles.css:7530` — `@media (max-width: 640px) {` → `.welcome-hero`

**1000px（3 处）**
- `public\forge\data.css:2085` — `@media (max-width: 1000px) {` → `#config-surface-sources .runtime-seat-layout`
- `public\forge\data.css:2937` — `@media (max-width: 1000px) {` → `.provider-bus .provider-workspace`
- `public\styles.css:16186` — `@media (max-width: 1000px) {` → `.config-remote-seat-layout`

**520px（2 处）**
- `public\forge\art-direction.css:816` — `@media (max-width: 520px) {` → `#view-team .team-hero-title`
- `public\styles.css:10594` — `@media (max-width: 520px) {` → `.resume-hint-row`

**700px（2 处）**
- `public\forge\bot-shell.css:932` — `@media (max-width: 700px) {` → `.is-bot-surface .topbar-actions #global-mc-toggle`
- `public\forge\bot-shell.css:1175` — `@media (max-width: 700px) {` → `.bot-roster`

**680px（2 处）**
- `public\forge\bot-shell.css:1065` — `@media (max-width: 680px) {` → `.bot-workspace-header`
- `public\forge\team.css:1729` — `@media (max-width: 680px) {` → `#view-team .team-hero`

**860px（2 处）**
- `public\forge\waveg.css:733` — `@media (max-width: 860px) {` → `.channel-section-head`
- `public\forge\waveg.css:998` — `@media (max-width: 860px) {` → `.office-section-head`

**699px（1 处）**
- `public\forge\bot-shell.css:908` — `@media (max-width: 699px) {` → `.bot-shell .bot-run-queue-item`

**980px（1 处）**
- `public\forge\bot-shell.css:919` — `@media (max-width: 980px) {` → `.bot-shell-grid`

**1024px（1 处）**
- `public\forge\codex-desktop.css:1188` — `@media (max-width: 1024px) {` → `:root`

**681px（1 处）**
- `public\forge\team.css:3228` — `@media (min-width: 681px) and (max-width: 1120px) {` → `.tm-group-body`

**1121px（1 处）**
- `public\forge\team.css:3234` — `@media (min-width: 1121px) {` → `#team-surface-settings .tm-group-body`

**420px（1 处）**
- `public\styles.css:2260` — `@media (max-width: 420px) {` → `.registry-dock-header`

**1080px（1 处）**
- `public\styles.css:4792` — `@media (max-width: 1080px) {` → `.metric-grid`

**800px（1 处）**
- `public\styles.css:11507` — `@media (max-width: 800px) {` → `.bootstrapper-body`

**760px（1 处）**
- `public\styles.css:12552` — `@media (max-width: 760px) {` → `.provider-dialog.is-codex`

**1500px（1 处）**
- `public\styles.css:12716` — `@media (max-width: 1500px) {` → `.provider-columns`

**1050px（1 处）**
- `public\styles.css:13467` — `@media (max-width: 1050px) {` → `.ccs-account-grid`

## 2. 触控目标疑似过小（P2-4）

以 **32px** 为下限：**A 类（确定过小，可直接改）86 条**，B 类（无线索，需实测）188 条。

> 已过滤 :hover 等伪类态，以及 `.nav-item span` 这类「量的是文本、不是控件」的选择器。仍属启发式，用途是缩小人工核对范围。

| 分类 | 位置 | 选择器 | 声明高度 | 声明 padding |
|---|---|---|---|---|
| A 明确过小 | `public\forge\art-direction.css:477` | `.atelier .registry-dock .rail-tab-main` | 未声明 | 6 |
| A 明确过小 | `public\forge\automations.css:217` | `#automations-workbench .auto-card-actions .icon-button` | 30 | 未声明 |
| A 明确过小 | `public\forge\automations.css:373` | `#automations-workbench .auto-tabs button` | 未声明 | 5 |
| A 明确过小 | `public\forge\automations.css:426` | `#automations-workbench .auto-field > input, #automations-workbench .auto-field >` | 未声明 | 10 |
| A 明确过小 | `public\forge\bot-shell.css:564` | `.bot-mention-recipient button` | 24 | 未声明 |
| A 明确过小 | `public\forge\bot-shell.css:603` | `.bot-composer textarea` | 30 | 6 |
| A 明确过小 | `public\forge\bot-shell.css:711` | `.bot-settings-field input, .bot-settings-field textarea, .bot-settings-field sel` | 未声明 | 8 |
| A 明确过小 | `public\forge\bot-shell.css:777` | `.bot-plugin-chips button, .bot-update-track button` | 28 | 未声明 |
| A 明确过小 | `public\forge\bot-shell.css:1329` | `html.is-bot-surface body > dialog.action-dialog .dialog-heading .icon-button` | 30 | 未声明 |
| A 明确过小 | `public\forge\codex-desktop.css:295` | `.rail-newtask` | 未声明 | 5 |
| A 明确过小 | `public\forge\console-form.css:38` | `.rail-kbd` | 未声明 | 1 |
| A 明确过小 | `public\forge\console-form.css:512` | `.budget-menu-editor input` | 26 | 未声明 |
| A 明确过小 | `public\forge\data.css:560` | `#team-router-workbench .router-form textarea` | 未声明 | 12 |
| A 明确过小 | `public\forge\data.css:1047` | `#config-surface-capabilities .capability-bus-track > button` | 未声明 | 9 |
| A 明确过小 | `public\forge\data.css:1253` | `#config-surface-capabilities .cap-cell-toggle input[type="checkbox"]` | 16 | 未声明 |
| A 明确过小 | `public\forge\data.css:1300` | `#config-surface-capabilities .cap-mcp-filters button` | 30 | 未声明 |
| A 明确过小 | `public\forge\data.css:1649` | `#config-surface-sources .runtime-seat-filters button` | 30 | 未声明 |
| A 明确过小 | `public\forge\data.css:2024` | `#config-surface-sources .runtime-seat-toggle input` | 16 | 未声明 |
| A 明确过小 | `public\forge\density.css:36` | `:root[data-density="compact"] .settings-rail-item, :root[data-density="compact"]` | 28 | 未声明 |
| A 明确过小 | `public\forge\experience-polish.css:332` | `body.atelier .sidebar .nav-item, body.atelier .sidebar .nav-item.nav-primary` | 30 | 未声明 |
| A 明确过小 | `public\forge\experience-polish.css:934` | `.market-add-menu button` | 未声明 | 8 |
| A 明确过小 | `public\forge\experience-polish.css:1263` | `.settings-unit input` | 未声明 | 6 |
| A 明确过小 | `public\forge\experience-polish.css:1381` | `.settings-font-control input[type="range"]` | 4 | 未声明 |
| A 明确过小 | `public\forge\experience-polish.css:1395` | `.settings-font-control input[type="range"]::-webkit-slider-runnable-track` | 4 | 未声明 |
| A 明确过小 | `public\forge\experience-polish.css:1401` | `.settings-font-control input[type="range"]::-webkit-slider-thumb` | 14 | 未声明 |
| A 明确过小 | `public\forge\experience-polish.css:1414` | `.settings-font-control input[type="range"]::-moz-range-track` | 4 | 未声明 |
| A 明确过小 | `public\forge\experience-polish.css:1421` | `.settings-font-control input[type="range"]::-moz-range-thumb` | 14 | 未声明 |
| A 明确过小 | `public\forge\experience-polish.css:1530` | `.appearance-seg button` | 未声明 | 5 |
| A 明确过小 | `public\forge\hooks.css:316` | `#config-surface-hooks .hooks-form .field.checkbox input` | 16 | 未声明 |
| A 明确过小 | `public\forge\overview.css:69` | `.overview-seg button` | 28 | 未声明 |
| A 明确过小 | `public\forge\overview.css:89` | `.overview-seg.is-compact button` | 24 | 未声明 |
| A 明确过小 | `public\forge\overview.css:514` | `.overview-ledger-filter select` | 30 | 未声明 |
| A 明确过小 | `public\forge\rail-tools.css:54` | `.rail-tab-main` | 未声明 | 5 |
| A 明确过小 | `public\forge\rail-tools.css:86` | `.rail-tab-close` | 18 | 未声明 |
| A 明确过小 | `public\forge\rail-tools.css:126` | `.rail-tab-add` | 26 | 未声明 |
| A 明确过小 | `public\forge\rail-tools.css:151` | `.rail-tool-menu` | 未声明 | 5 |
| A 明确过小 | `public\forge\rail-tools.css:340` | `.rail-chip` | 未声明 | 4 |
| A 明确过小 | `public\forge\rail-tools.css:396` | `.rail-review-body` | 未声明 | 8 |
| A 明确过小 | `public\forge\rail-tools.css:404` | `.rail-review-status` | 未声明 | 10 |
| A 明确过小 | `public\forge\rail-tools.css:533` | `.rail-browser-bar .icon-button` | 26 | 5 |

（另有 234 条，用 `--md=<file>` 输出完整清单）
