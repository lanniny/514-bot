# 团队配置友好性波：富成员卡 + 对话框内切换（Kimi → all）

> 时间：2026-07-26 · 主驾：Kimi · 范围：apps/control-center 团队配置对话框
> 触发：LO「团队配置界面太简单或者说不够用户友好性」

## 一、诊断

原对话框三大不友好：①成员区是裸 checklist（checkbox + 文字 label，无 logo/职责，与团队运行面的富卡完全两个世界）②换团队配置要「关闭对话框 → rail 换当前团队 → 重开」三件套 ③表单一平到底无分区。

## 二、处置

| # | 项 | 处置 | 落点 |
|---|----|------|------|
| ① | 成员富选项卡 | `fillTeamForm` 成员行重写：品牌头像（`cliIconMarkup` logo / AGENT_SHORT 双字兜底）+ 名称 + 头衔·职责；元数据复用 team-panel.js `PROFILE_META`（改 export，app.js import——单一真源） | app.js + team-panel.js |
| ② | 品牌色 | 零新映射：team.css 现成 `[data-brand] → --agent-accent` 表直接消费（卡框/hover/checkbox accent/头像 tint） | forge/shell.css |
| ③ | 主脑标识 | radio 收进卡片右侧胶囊，选中铜底加粗 | 同上 |
| ④ | 团队切换器 | 对话框头部 `#team-switch-select`（内置标注、新建态前置「＋ 新团队」），change 直接 `fillTeamForm(target)` | index.html + app.js |
| ⑤ | 分区 | Skill/MCP 前加 `.form-section-label`（声明性一句话定位） | index.html + shell.css |

## 三、验证

- `npm test` 480 pass / 0 fail / 1 skipped；`npm run validate` valid。
- 探针三截亲查：`29-team-dialog-light.png`（六席富卡、主脑胶囊、内置只读横幅、切换器）、`31-team-dialog-dark.png`（暗色品牌色全协调）；切换器在 QA 数据下 1 选项（仅内置团队），多团队切换路径代码已通；控制台 0 错误。
- 职责行单行省略防主脑胶囊截字（细节补丁）。

__DELTA__: Kimi | 1 | 证据：qa-v4/29-team-dialog-light.png 六席富卡 + 对话框内团队切换器（CHANGELOG v4.0 未发布节）
