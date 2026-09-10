# 514 Bot 模块审计（2026-09-10）

Bot 是唯一主界面。本轮先修 P0 聊天渲染，再按模块记账：已修 / 安全可修 / 下一波。

## P0 — 聊天渲染（本 PR 已修）

截图症状：中间空态「514 / 还没有消息」，用户气泡「你好」漂在壁纸右侧；底栏挤满工作台控件。

根因（已实证，不是猜）：

1. `botAppendUserMessage` 只 `appendChild`，不卸 `.bot-message-empty`。空态 `min-height: 62vh/100%` 仍占满对话列，气泡成为第二个 flex 子项。
2. `.bot-message-user { align-self: flex-end }` 把整条消息甩到 **stream 右缘**。侧栏/右栏折叠后 stream 接近全宽，气泡就浮在壁纸右边。
3. `width: min(720px, 100%)` 在 flex 百分比基线未定时塌成内容宽；用户行 `justify-content: flex-end` 再把短行贴到 stream 右边。
4. `botSaveMessageStore` 把「空态 + 气泡」一起写入 `innerHTML`；切回会话会原样还原。
5. `#view-bot .bot-composer-footer { display: flex !important }` 压过 `<details>` 的 UA 隐藏，工作台条（直接发送/团队/模型/Effort/过程/成果/提交/预算/CLI）即使 overflow 关闭也摊在输入框下。

本 PR 修复：

- `modules/bot-transcript-dom.js`：有真实消息就卸空态；append / save / restore / full render 都走 normalize。
- 对话列：`width: 100%; max-width: var(--bot-transcript-width); margin-inline: auto; align-self: center`。不用 `min(720px, 100%)`——flex 子项百分比基线未定时会塌成内容宽，再被 `justify-content: flex-end` 甩到 stream 右缘。
- CSS `:has(.bot-message)` 兜底隐藏空态。
- Grok 面 composer：默认只留胶囊输入；overflow 只开发送字段（收件人/团队/模型/Effort/权限/预算）。过程/Git/CLI/导览芯片与 footer 藏起，入口仍在右栏 inspector / 底部终端 / 设置。

## 模块账本

### 1. Chat transcript / empty / streaming / process-fold

| 状态 | 项 |
|---|---|
| 已修 | 空态与消息共存；气泡脱离对话列；壁纸上用户气泡对比不足 |
| 可保留 | 过程折进 `bot-activity-group`（默认闭合）；live-delta / typing 与空态互斥已有逻辑 |
| 下一波 | `reconcileMessageMarkup` 用 `TAG:class:index` 做 key，空态与卡片偶发错位；`historyHtml` / `html` 双写；streaming 占位与 typing 双显的边角 |

### 2. Composer / send / kickoff / recipient

| 状态 | 项 |
|---|---|
| 已修 | Grok 面不再摊工作台控件条；footer `!important` 泄漏；权限/预算改到 overflow 字段 |
| 可保留 | `@` kickoff、附件、席位芯片、定向 recipient |
| 下一波 | workbench 面仍会打开 overflow（有意）；`workspace-advanced-mode` 仍在 DOM（Grok 已 `display:none`）；编排模式只在 workbench footer，Grok 面需从 inspector 补入口 |

### 3. Left roster（正在工作 / sessions / members）

| 状态 | 项 |
|---|---|
| 未动 | `bot-active-runs` 有 max-height；icon rail 与 roster 双导航 |
| 下一波 | `workspace-navigation` 在 Grok 面隐藏，icon rail 才是真入口——工作台面两套导航并存；联系人/对话 tab 与 rail 的 pressed 态偶发不同步 |

### 4. Right inspector（PR #17 统一栏）

| 状态 | 项 |
|---|---|
| 可保留 | 会话摘要、审批/文件/浏览器/Git/终端芯片、成员电脑诚实「未配置」、Routines/Channels |
| 下一波 | 默认 `hidden` + ops collapsed，用户找不到运维；编排/预算没有 inspector 镜像（Grok 面只在 `...` overflow）；Channels 空态与门闸文案可再压一遍 |

### 5. Terminal bottom drawer

| 状态 | 项 |
|---|---|
| 可保留 | `#bot-terminal-drawer` 懒挂载 PTY；Ctrl+`；高度持久化 |
| 下一波 | composer 里「终端」芯片仅 workbench 可见，Grok 面依赖 inspector/全局开关——确认全局 statusbar 按钮始终在 |

### 6. Theme / wallpaper / chrome

| 状态 | 项 |
|---|---|
| 已修 | 壁纸态用户气泡加不透明衬底；对话列不再贴右 |
| 可保留 | `is-bot-grok-face` + `team-bg-active` 玻璃；浅/深令牌 |
| 下一波 | 对话列本身仍全透明，长助手回复在浅色壁纸上偏虚；顶栏/状态栏在壁纸上仍偏密 |

### 7. Dead workbench UI still mounted into Bot

| 状态 | 项 |
|---|---|
| 已隔离 | `#view-workbench` `hidden`；route 退役到 bot；Grok 面藏 project/view bar |
| 下一波 | `#view-workbench` 整页仍在 DOM（体积大）；`workspace-view-bar` / `workspace-project-bar` / `workspace-navigation` 仍挂在 Bot 树里；`conversation-stream` 工作台样式文件继续加载。下一波应 quarantine 整页 workbench，而不是继续双维护。 |

### 8. APIs wired in UI but unreachable / UI missing for live APIs

| 状态 | 项 |
|---|---|
| 诚实保留 | 成员电脑 `not-provisioned`；computer-update/reset toast「尚未接入」 |
| 下一波 | 导览/能力地图只在设置；Grok 面 overflow 不再放这两颗芯片（设置仍在）。审计未做全量 `/api`↔UI 对表——需要单独脚本扫 `request("` vs 面板挂载。 |

## 刻意没做

- 不删 `#view-workbench`（回归面太大）。
- 不把 inspector 重做成第二套 composer。
- 不改 bootstrap 鉴权、560/820 断点数值。
- 不做云电脑 / Bot-build-Bot / 分享 / 录屏 / 语音。
