# 启动壁纸丢失修复 + 桌面启动反馈 + 协作 picker 完善（三件套）

- 执行者：烛（ZCode 运行时，AEMEATH 面）
- 时间：2026-08-30 13:00 ~ 14:40（UTC+8）
- 依据：LO 指令「1.修复应用启动时自定义壁纸可能丢失 2.完善启动加载长的感官 3.按当前截图继续完善协作界面」
- 说明：本会话无 route-gate 注入 session marker，按契约省略该行。

## 一、壁纸启动丢失（根因修复，v8.5）

**现象**：换壳/换端口冷启后，自定义全局壁纸"可能"消失（偶现）。

**根因**（竞态，非数据丢失——盘上 `teambg--__global__.mp4` 与 `preferences.json` 的 `preset:"custom"` 全程完好）：新壳 origin 的 localStorage 为空时，`reconcileGlobalWallpaperMedia()` 的 HEAD 对账与 `hydratePreferencesFromServer()` 并发赛跑。HEAD 先回来就会把默认快照 `{preset:"none",hasCustom:true}` 写进 localStorage：

1. 水合按「本地已有值优先」跳过壁纸键 → 服务端 `preset:"custom"` 永不回填 → 本次启动无壁纸；
2. 该降级快照又被偏好双写 PUT 回服务端 → **丢失跨重启粘滞**，直到用户手动重选。

**修复**（`public/app.js` 三处）：
- `reconcileGlobalWallpaperMedia()`：先查本地键，无键（水合未发生/服务端无偏好）或已 `hasCustom` 一律 return——只对「有本地偏好但 hasCustom=false」做存在性修复（保留旧内核自愈误伤的取回能力）。
- `replayAppearanceFromStorage()`：摘除对账调用（replay 会被 initializeTheme + 水合各跑一次，必然抢跑）。
- 启动链：`hydratePreferencesFromServer().finally(() => reconcileGlobalWallpaperMedia())`——对账串在水合结算之后。

**证据**：`apps/control-center/public/app.js:2220-2249`（reconcile + replay）、`app.js:31836-31842`（启动链）；契约测试 `tests/ambient-ui-contract.test.mjs` 契约 16b（4 条断言，12/12 绿）。

## 二、启动加载感官（壳侧 splash）

**现状**：壳在内核握手前不建任何窗口，冷启 + 杀软扫描期间（boot log 实测多次启动无 URL 就绪）用户面前是"点了没反应"；内核 warm boot 实测 ~2s（`desktop-boot.log` 1788068101→103），瓶颈在反馈不在速度。

**落地**：
- `apps/desktop/dist/index.html`：从一行占位升级为自包含 splash（暗夜玫瑰主题、脉冲点动画、reduced-motion 降级）。
- `apps/desktop/src-tauri/src/main.rs`：`show_splash_window()`（frameless 380×220、置顶、skip_taskbar、center，frontendDist 内置资源不依赖内核）；supervisor 在主窗口 Live 时 `close_splash_window()`，失败路径统一在 supervisor 收尾关闭；splash 建立严格先于 supervisor 线程（保证关闭时不悬空）。

**验证**：`cargo fmt --check` 过（已 fmt）、`cargo check` 过、`cargo test` 22/22 绿。
**遗留**：release exe 重编被运行中的 `cc-desktop.exe`（PID 16332）锁住（os error 5），代码已编译通过——**LO 退出应用后跑一次 `cargo build --release` 即出产物**（依赖全编译好，秒级完成）。

## 三、协作界面「发送给谁」picker 完善

截图盘点后落地三项（`public/app.js` + `public/styles.css`）：
1. **卡片副行接真实职责**：新增 `agentPickRoleLine()`——`BOT_MEMBER_ROLE_LABELS` 归一化角色键（primary-coordinator→团队主脑、technical-executor→技术执行…），自由文本 role 原样透出；主脑卡保留「直接发送」语义，成员卡「· 直达 CLI」。此前四张卡三张写死「直达成员 CLI」，数据在、渲染不用。
2. **团队上下文行**：`.picker-team-meta` 显示「团队 {name} · {n} 席 · 按数字键直达」，多团队切换时选人不再盲选。
3. **数字键直达**：picker 打开时按 1-9 直选第 n 个成员（卡片右上角 kbd 角标同门槛渲染，>9 席不显示）；输入框/编辑控件聚焦时不抢输入，带修饰键不拦。点击与键盘统一走新出口 `pickComposerAgent()`（消除原 click handler 内联四处逻辑的漂移面）。

**验证**（`apps/control-center/.qa-probe-picker.mjs`，隔离 fixture + Playwright 真浏览器）：
- 职责副行实渲染：`Fable => 团队主脑 · 直接发送 | Codex => 技术执行 · 直达 CLI | Grok Search => 时效研究 · 直达 CLI | …`
- 数字键：输入框聚焦打 "2" 只进输入框；焦点移出按 "2" 直选 Codex 并关 picker；
- 截图 `.qa-output/probe-picker-open.png` / `probe-picker-roles.png`；页面/控制台零错误。
- 契约测试 `tests/composer-target-ui.test.mjs` 新增 1 条（13/13 绿）。

**探针时序备注（防后人误判）**：fixture 冷启时 `/api/bootstrap` 可能慢于 SSE 就绪（健康探测 ENOENT 退化 30s 轮询），picker 先渲染兜底文案、目录落地后由 `loadBootstrap → refreshAvatarSurfaces → renderSelectedRun` 兜底重渲——这是探针要先 `waitForFunction` 的原因，不是产品缺陷。

## 四、验证清单

- `node --test tests/ambient-ui-contract.test.mjs` 12/12；`tests/composer-target-ui.test.mjs` 13/13（含新增）。
- `cargo fmt` + `cargo check` + `cargo test`（壳）22/22。
- `npm test` 全量 1902 用例首轮 1890/10 fail → 逐项归因（隔离复跑）：
  - **本轮引入并已修**：`ui-lint gate` bare-font +1（picker 键帽 `font-size:10px` 裸值）→ 改 `var(--text-xs)`，`npm run ui:lint` 全绿回到基线。
  - **满载波动族（隔离全绿）**：live MCP 导入 / observability pulse / SSE replay backpressure / mission snapshot / bus lease / social multi-hop / rawConfig 原文覆盖 / core routing 原子提交 / runtime seat 编辑（http-e2e、mission-control、orchestrator、providers、runtime-reload、runtime-seats、ccswitch-domain、social 各文件隔离 225+103 全过）。
  - **提交后自愈**：delivery manifest / run-diff clean worktree——本轮产物以显式 pathspec 提交（`3b244c9`）后隔离复跑通过。
  - **既有债务（与本轮无关）**：`conversation-heading-slim`「title glyph」确定性失败——工作树里上一轮未提交的 index.html（473 行 WIP）把 svg 属性顺序改了，测试断言没跟上；待该轮收口时一并处理。
- `npm run validate` 未动治理真源，无需跑版本一致性（本轮未触碰 module.yaml/rules/版本号）。
- 提交纪律：显式 pathspec 只提交本轮 7 文件，不携带暂存区里上一轮的归档/治理改动。

## 五、遗留与下一步

1. **release exe 重编**：等 LO 退出应用后 `cd apps/desktop/src-tauri && cargo build --release`（秒级）；splash 页在 `apps/desktop/dist/index.html`（该目录在 .gitignore 内，随盘构建，原占位页同惯例未入库）。
2. 全量套件满载波动族（real-git fixture / SSE backpressure / bus lease 类）建议下一轮加串行标记（承前轮建议，未动）。
3. **上一轮 index.html WIP 收口**：工作树 126 条未提交条目（含 ui-lint.mjs/static-assets.mjs 等未跟踪新产物 + index.html 473 行改动）是 wave0-3 的在途工作；`conversation-heading-slim` 的 title-glyph 失败待其收口修复。**更重要的发现**：`public/*.js` 前端层（api.js/state.js/utils.js/36 个 modules）**从未进版本库**——HEAD 任意提交都无法新 checkout 跑起来（PM 审查「Git 断链」的实体）；本轮提交让 app.js/styles.css 首次入库，但整个前端层的收口（把 126 条工作树产物按 wave 归并提交）仍待专门一轮。
4. picker 后续候选（未做，避免本轮面铺太宽）：主脑卡「主脑」pill 徽标、@ 点名面板同款职责副行、picker 打开时 bootstrap 晚到且 refreshAvatarSurfaces 未触发的极端窗口补一次显式重渲。

__DELTA__: 烛(Claude) | 1 | 证据：public/app.js reconcileGlobalWallpaperMedia 在空 localStorage 上写默认快照抢在水合前，既挡服务端 preset:"custom" 回填又被偏好双写 PUT 降级真源——「换壳后自定义壁纸丢失」的真实根因，v8.3 的水合重挂修复防不住这条
__DELTA__: 烛(Claude) | 1 | 证据：public/app.js agentPickerMarkup 此前对非主脑成员一律渲染写死「直达成员 CLI」，memberCatalog 的 role 字段（含 BOT_MEMBER_ROLE_LABELS 归一化链）数据在而渲染不用
