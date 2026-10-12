# 退役的协作台时代 QA 脚本（2026-09-28，D-2026-09-28-016）

以下脚本驱动「导航级已退役」的 workbench 面 DOM（#view-workbench 恒 hidden /
#new-task-row / #workspace-tab-process / #view-workbench.is-active），其验证意图
属于协作台 chrome 时代，当前产品面（514 Bot + ops rail）已由 qa-bot-* 系列覆盖：

| 脚本 | 原意图 | 当前面对应 |
|---|---|---|
| qa-agent-picker.mjs | 「发送给谁」picker 三项完善（自述一次性探针） | qa-bot-composer-switch（recipient/模型/广播默认） |
| qa-collaboration-fusion.mjs | 协作台融合面走查（罐头消息执行） | qa-team-workspace / Bot 协作面 |
| qa-experience-workbench.mjs | fusion 的 B1 命令兼容 wrapper | 同上（随 fusion 退役） |
| qa-history-navigation.mjs | 协作台运行历史 select 导航 | Bot 会话树 / agent 面板历史 |

移出 scripts/ 主目录即退出 qa-run-all 的 glob（门禁）。若需复盘，git 史有完整原文。

| qa-ui.mjs + qa-ui-fixture.mjs | 五子套件（layout/workbench/history/delta/mission）全量 UI 走查 | 套件入口硬跳 #view-workbench；inspect 助手散布退役 chrome 点击（#theme-toggle / #global-mc-toggle / .workbench-shell）。入口硬跳已修（D-016），其余 chrome 点击属 L2 重写队列—— Bot 面由 qa-bot-* 系列覆盖 |

| qa-workbench-environment.mjs | 协作台环境舱（附件/暂存/委派/隔离工作树 diff）+ 右栏审阅页 diff 着色 | 靠点击 `[data-run-select]` 选定 run——该行属 `#workbench-run-list`（在 #view-workbench 退役壳内）。Bot 面无"选定任意历史 run"的入口（命令面板不列 run，`/resume` 只取最近一个），故右栏审阅/文件/环境三工具对历史 run 不可达——**这是产品缺口，见 D-2026-09-28-021**，不是脚本过期。API 层 `/api/workbench/environment` 仍有单测覆盖 |
