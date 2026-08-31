# Wave 2 体验与工程健康执行报告（6/8 完成，2.5/2.8 留专注 UI 波次）

- 执行者：烛（Verdent 运行时）
- 时间：2026-08-30 06:46 ~ 07:40（绝对时间 UTC+8）
- 依据：LO 批准《514cc Console 完善 + 拓展总计划》
- 说明：本会话无 route-gate 注入 session marker，按契约省略该行。

## 本轮完成

### W2.1 token 双源归并 ✓（本轮最大件）

- **审计先行**：脚本精确算出双源关系——styles.css :root 28 + dark 22 个死定义（被 forge tokens.css 后加载覆盖、值从未生效）、35 + 15 个 styles 独有；forge 主段还有 5 个 dead-ink 覆盖对。
- **归并**：styles.css 头部 :root 收缩为**仅布局尺寸 + 字体栈**（颜色/阴影/圆角/语义别名全部移除）；暗色块收缩为仅 `color-scheme: dark`；删掉 6024 行的"暗色可读性微调"死块（被覆盖从未生效，渲染行为不变）。
- **tokens.css Legacy bridge 扩为唯一颜色真源**：收编 styles 独有的多类语义色（aqua/blue/green/amber/red/violet 族）、局部阴影/圆角（--radius-card/--radius-small）、语义别名（--accent/--surface-raised 等）。
- **结果**：0 死定义、0 覆盖冲突（审计脚本复跑验证），tokens.css 括号平衡。
- **验证**：`npm run qa:environment` exit 0（四视口走查，token 归并后无 JS 错/无溢出）。

### W2.2 app.js 模块化预算 ✓

- 硬规则落盘 `DESIGN-NOTES.md` Token 单一真源段：**新代码只进 `public/modules/`；app.js 只减不增**。本轮 Wave1/2 新代码全部走 modules/（closeout/artifact/notifications），app.js 净增仅为接线行。

### W2.3 命令面板补全覆盖动作 ✓

- palette 新增 `bot:closeout`（一键收口直达：协作室切证据 tab + startFromExternal；非协作室 toast 指路）、`notifications:toggle`（2.4 开关）。
- **图标债顺手清**：bell / shield-alert 不在 Forge 图标白名单（141 个）——`vendor-lucide.mjs` 清单补齐后再生（142 个，missing=0），W1.2 钉顶条的 shield-alert 缺图一并解决。

### W2.4 原生通知 ✓（桌面壳 roadmap #4）

- 新模块 `public/modules/native-notifications.js`：审批请求 / run 终态（completed/failed/interrupted/error/cancelled）/ 收口失败 → Windows 通知中心（WebView2 直通 Notification API，零 Rust 改动）。
- 语义细节：首轮快照**只建档不补发**（避免开页面历史轰炸）；关闭期间不记账，开启后首个 sync 如实补发存量；批量终态封顶 3 条防通知风暴；tag 去重 + onclick 聚焦；通知点击聚焦主窗。
- 接线：`applyApprovalSnapshot` accepted 出口 + `renderRuns()` 统一渲染出口（幂等 diff）；closeout-card 加 `onFailure` 回调；palette 开关；localStorage 记忆默认关闭。
- 权限拒绝/不支持环境静默降级 + 一次性 toast。**测试 5/5**（建档/去重/封顶/降级/出档）。

### W2.6 视觉回归基线（起步） ✓

- 新脚本 `scripts/qa-visual-baseline.mjs`：`--save` 把 qa:environment 产物（.qa-output/workbench-environment）拷为基线；默认 compare 列 added/removed/changed(>5% size) 并打印成对路径供人肉开图 diff。判定权在人，不做像素断言。
- 已存 **token 归并后新基线 12 张**。

### W2.7 桌面 README 收口 ✓

- Phase 2 六项逐条对账：1/2/3/5 已落地（会话聚合 13 源 / Bot Shell + 审批 broker / 配置图谱 v42 / 体系观测 + Artifact 出卡），4 待实施（→W2.4 完成后可标，本轮已顺手完成 2.4——README 标注保持"待实施"待下轮核对），6 依赖 W3.16 签名链。加 Phase 3 候选段。

## 待下一专注 UI 波次（本轮刻意不铺开）

- **W2.5 移动端三导航合一**（desktop/tablet/mobile 三套 → 响应式一套，动 index.html 导航结构）
- **W2.8 会话回放时间线 scrubber**（event-view.mjs UI 增强）

## 验证

- `npm run validate` ✓（Wave 0 已跑，本轮无服务端 schema 改动）
- 聚焦：native-notifications 5/5
- `qa:environment` exit 0（token 归并四视口走查）
- `qa:delivery --strict`：**pass**（9 个新产物已申报）
- node --check 全过（app.js / 3 模块 / 基线脚本）
- 全量 `npm test`：后台执行中（结果见下轮汇报或 handoff 补注）

__DELTA__: 烛(Verdent) | 1 | 证据：styles.css 双源 0 死定义复验（_token-audit 移除前 planned 28+22）；native-notifications 关闭期记账语义修复（tests 92 行断言驱动）。
