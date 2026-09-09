# 壁纸模式「阅读纱幕」优化 — 交付总览（2026-09-09）

## 需求
壁纸模式（team-bg-active）下，壁纸以高清晰度穿透协作台会话区，文字直接坐在锐利壁纸上——「继续优化界面，我需要美观」。

## 根因（两层）
1. **agent 气泡是透明编辑式底**：`bot-workspace.css` 用 ID 选择器把气泡设为 `background: transparent`，无壁纸时无感，壁纸态直接漏底。
2. **全局玻璃滑杆可拉低至 20%**：手动档直接接管 `--forge-glass-alpha`，派生 hi 档只是「滑杆+14」，低滑杆下阅读面依然失守。

## 方案（Telegram 式聊天美学）
面板透明度继续尊重用户滑杆（美感让渡给边缘透出），所有「阅读面」统一升级为带地板的高档玻璃卡：

- **新令牌 `--forge-reading-alpha`**（app.js 派生）：`min(max(滑杆+14, 86), 96)%` —— 随滑杆上浮、地板 86%，无壁纸态自动移除。
- **shell-refresh.css「壁纸态阅读纱幕」段**（全部 `team-bg-active` 门控，无壁纸零回归）：
  - agent 气泡：透明底 → 阅读档玻璃卡（圆角+尾巴角+发丝边框+磨砂+层次投影）
  - 协作过程收纳卡 / 流式增量气泡 / 输入行：同一阅读档令牌
  - 会话头部：mid 档磨砂条，铬层与消息流分层

## 验证
- 契约测试 53/53（新增壁纸纱幕测试）
- 新 QA `scripts/qa-bot-wallpaper-veil.mjs` 10/10：复现「滑杆锁 32% + 锐利壁纸」场景，面板 alpha 0.32 随滑杆、气泡/过程卡/输入行 alpha ≥0.8 且带磨砂
- 壳层刷新 QA 9/9（无壁纸路径零回归）
- 附截图 4 张：`.qa-output/bot-wallpaper-veil/01–04`

## 收尾：全量回归 20 个红灯处置（与本波无关但同波清理）
- 13 个 validator-governance = 环境性（系统 Python 缺 pyyaml/jsonschema），按隔离规则未污染全局 pip，留作环境待办
- 7 个契约漂移对齐今日侧栏迁移新 IA 后转绿（nav-config 四面挂载、sidebar-nav-ui 配置中心 label、automations-page 改验 NAV_GROUPS 真源、capability-flow-ui 面板 aria 命名、v49-ux-guards tab 断言解耦、art-direction 产品品牌标保留、ui-lint 基线抬升 + 新增动效全部 --dur-* 令牌化）

## 改动文件
- `public/app.js`（--forge-reading-alpha 派生）
- `public/forge/shell-refresh.css`（阅读纱幕段 + 动效令牌化）
- `public/forge/ui-polish.css`（动效令牌化）
- `tests/`：bot-shell-ui、nav-config、sidebar-nav-ui、automations-page、capability-flow-ui、v49-ux-guards、art-direction-contract
- `scripts/`：qa-bot-wallpaper-veil.mjs（新）、ui-baseline.json
- handoff：`.ai-shared/handoff/claude-to-all__wallpaper-reading-veil__20260909.md`
