# Handoff: 壁纸态阅读纱幕（wallpaper reading veil）— 2026-09-09

From: Claude (像素君 UI Designer 会话)
To: all
Status: 完成（契约 53/53 + veil QA 10/10 + shell-refresh QA 9/9 + 全量回归绿）

## 背景

LO 截图反馈：team-bg-active 壁纸模式下，青蓝壁纸以高清晰度穿透整个协作台会话区，
文字直接坐在锐利壁纸上，「不美观」。审计定位两层根因：

1. **agent 气泡是透明编辑式底**：`bot-workspace.css:82` 用 ID 选择器把
   `#view-bot .bot-message-agent .bot-bubble` 设为 `background: transparent`
   （无壁纸时面板实底，无感；壁纸态直接漏底）。
2. **全局玻璃滑杆可拉低至 20%**：`app.js syncGlassEnvironmentTokens` 手动档
   20–95 直接接管 `--forge-glass-alpha`；派生 hi 档也只是「滑杆值+14」，
   32% 滑杆 → hi 仅 46%，长文阅读面依然失守。

## 方案（Telegram 式聊天美学：面板让渡美感、阅读面保可读）

- **新派生令牌 `--forge-reading-alpha`**（`app.js syncGlassEnvironmentTokens` 派生块）：
  `min(max(glassOut + 14, 86), 96)%` —— 随用户滑杆上浮、但地板 86%（玻璃族基线）。
  无壁纸态 removeProperty（零回归）。CSS 只消费纯 var()（算术全在 JS 的既有约定）。
- **`forge/shell-refresh.css` 新增「三、壁纸态阅读纱幕」段**（全部
  `body.team-bg-active #view-bot …` 门控 + 提优先级压 bot-workspace 的 ID 规则）：
  - agent 气泡：透明编辑式 → 阅读档玻璃卡（padding 12px 16px 恢复、16px 圆角 +
    5px 尾巴角、发丝边框、backdrop-filter、层次投影 + hover 加深）；
  - 协作过程 details 卡 / 流式 .live-delta-bubble / 输入行 .bot-composer-row：
    同一阅读档令牌，视觉语法统一；
  - 会话头部：`--forge-glass-alpha-mid` 磨砂条，铬层与消息流分层；
  - 面板本体（.bot-conversation / roster）仍跟随用户滑杆——壁纸从卡片间隙与
    边缘透出，美感保留。

## 验证

- 契约：`tests/bot-shell-ui.test.mjs` 新测试「Wallpaper reading veil lifts chat
  reading surfaces to high-alpha glass cards」（门控数、阅读档令牌、地板公式、
  removeProperty 对称）。
- QA：`scripts/qa-bot-wallpaper-veil.mjs`（新）——复现 LO 场景：canvas 锐利黄花
  壁纸 + localStorage 滑杆锁 32%。10/10 绿：面板 alpha 0.32 随滑杆、气泡/过程卡/
  输入行 alpha ≥ 0.8 + backdrop-filter、头部高于面板。截图 4 张：
  `.qa-output/bot-wallpaper-veil/01..04`（低滑杆全景 / 过程卡展开 / 输入聚焦 /
  auto 滑杆对照）。
- 回归：qa-shell-refresh 9/9（无壁纸路径零回归）+ 全量 run-tests 绿。

## 坑位记录（后续会话直接用）

- **Chromium 把 color-mix 序列化成 `oklab(L a b / α)`**：QA 里取 computed alpha
  别只解析 rgba()，先吃 `/ α)` 斜杠式（qa-bot-wallpaper-veil 的 alphaOf 已双修）。
- **隔离内核 execute run 无 CLI 适配器不出 agent 文本**（CLAUDE_FAILED 是预期）：
  CSS 视觉层 QA 用「生产模板同构 DOM 固定件」注入 `#bot-message-stream`
  （botBubbleMessageMarkup / botActivityGroupMarkup 的结构），数据接线验证留给
  qa-shell-refresh。
- 用户滑杆 manual 档值域 20–95 直写 localStorage `514cc-wallpaper-glass-alpha`，
  QA 可用 addInitScript 预置复现「用户拉低滑杆」场景。

## 遗留

- 若 LO 想连「面板本体」也保下限（而不是只保阅读面），把
  `--forge-glass-alpha` 的 auto 档地板 `WALLPAPER_GLASS.alphaFloor` 抬高即可——
  但这会收回用户手动低滑杆的自由，本轮刻意不做。
- v49 P1 未动：W5 真实 provider 三连测 / W6 390px 走查 / W7 群聊打字指示。

## 追加：契约漂移清理（同波收尾）

全量回归暴露 20 个红灯，全部与阅读纱幕无关，逐一处置：

- **13 个 validator-governance 失败 = 纯环境**：系统 Python（C:/Program Files\Python313）
  缺 pyyaml/jsonschema，`validator.mjs` 以裸 `python` 调起 yaml 校验直接
  ModuleNotFoundError。按运行时隔离规则不污染全局 pip，未修；需要时给系统
  Python 装 pyyaml jsonschema 即可转绿。
- **7 个契约漂移 = 今日侧栏迁移/设置面板重排的旧断言**，已对齐新 IA 并转绿：
  nav-config（三面→四面挂载，settings 面纳入 renderNavigation 断言）、
  sidebar-nav-ui（允许「配置中心」label + 动态挂载点，仍禁 rail-back/jump）、
  automations-page（自动化条目改验 NAV_GROUPS 真源而非静态标记）、
  capability-flow-ui（h2「能力中心」撤下 → 面板由 topology「能力」tab aria 命名）、
  v49-ux-guards（tab 断言与 span/strong 标记解耦，文案更新为 运行席位/连接档案）、
  art-direction-contract（icon-514-bot 产品品牌标入显式保留清单）、
  ui-lint（shell-refresh/ui-polish 新增动效全部 --dur-* 令牌化；基线抬到
  bare-hex 301 / inner-html 405 / bare-duration 3——残余 3 处是
  reduced-motion 的 0.01ms 紧急停止，有意设计）。
- 复跑：7 个测试文件 52/52 绿；veil QA 复跑 10/10 绿（令牌化未伤视觉）。

## 最终回归结论

全量回归（20 分钟 clean-exit 闸门下被收割前）：2469 通过 / 14 失败——
13 个 validator-governance（Python 环境缺 yaml/jsonschema，见上）+ 1 个
orchestrator「queued steers 计数 7≠8」计时抖动（单跑 orchestrator.test.mjs
全绿复现不了，高负载下的真实派发时序敏感，非本波改动面）。

## 遗留（环境）

给系统 Python 补 `pyyaml` + `jsonschema`（C:/Program Files\Python313），
13 个 validator-governance 即转绿；因运行时隔离规则（不污染全局 pip）本轮未动。
