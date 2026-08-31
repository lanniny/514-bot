# 布局模仿 codeg/LiveAgent：终端 dock + 右栏折叠 + 分组折叠（Kimi → all）

> 时间：2026-07-26 · 主驾：Kimi · 范围：apps/control-center 协作台工作区
> 触发：LO「模仿开源作品的布局」

## 一、源码取证（DNA 对齐依据）

- **codeg**（`src/app/workspace/layout.tsx`）：横向 ResizablePanelGroup 侧栏 18% / 主 64% / aux 18%，主栏纵向再分 工作区 72% / **底部终端 dock 28%**（可拖可折叠）；侧栏=动作行+会话分组列表；aux=右栏 tabs dock。
- **LiveAgent**（`crates/agent-gui/src/pages/ChatPage.tsx`）：flex 三栏——可折叠侧栏（projects/recent 折叠分组）+ 聊天 + **RightDockPanel**（PanelRightClose/Open 切换）。

两家共同 DNA：**左栏分组会话列表（可折叠）｜中栏消息流｜右栏工具 dock（可折叠）｜底部终端 dock（codeg）**。

## 二、移植三件套

| # | 特征 | 实现 |
|---|------|------|
| ① | 底部终端 dock（codeg 签名） | 协作台中栏尾部 `#terminal-dock`：grip 拖高（140–55%，双击复位，↑↓ 步进）+ 折叠条 + 默认折叠懒挂载 + Ctrl+`。terminal-panel.js 工厂化 `createTerminalPanel(root)`（实例独立 tabs 台账；修 closeTab getElementById 硬编码）；与终端视图共享 PTY 台账（stream 订阅制双挂安全，实测同 session `6d7c6785` 两处同显） |
| ② | Mission Control 右栏折叠 | header 注入折叠钮 → 34px 细条（panel-right 钮展开），`514cc-mc-width` 记忆拖前宽度；折叠期右 splitter pointer-events none（codeg 同款） |
| ③ | run-rail 分组折叠 | chevron 注入五个 rail-block 头（团队/置顶/会话/正在工作/自动化），`514cc-rail-groups` 记忆；已归档块原生 toggle 不动 |

新文件 `public/workbench-chrome.js`（三件套行为 + 自举），已登记 server.mjs 静态路径表。

## 三、截图走查抓出的两个真问题（全修）

1. **dock 被 grid auto-placement 抢到行 1**：conversation-pane 的孩子全带显式 grid-row（styles.css:7374-7462），新 dock 无显式行 → 修：`grid-row:7` + 行模板补第七轨（forge/workbench.css 覆盖层）。
2. **dock 展开溢出裁切**：固定行高总和超 pane 高 → 修：`:has(.terminal-dock:not(.is-collapsed))` 下消息流 minmax 240→96（codeg 式 reflow）。

## 四、验证

- `npm test` 480 pass / 0 fail / 1 skipped；`npm run validate` valid。
- Playwright 21 站全量 + 定向交互截图（dock 展开/折叠、MC 折叠/展开、分组折叠、暗态 dock、终端视图回归）亲查；控制台 0 错误。
- 桌面端静态资产免重启，Ctrl+R 生效。冒烟实例 :5520 已回收。

__DELTA__: Kimi（前） | 1 | 证据：terminal-panel.js 工厂化 + workbench-chrome.js 三件套 + grid-row:7/:has 两修，明暗交互截图亲查 0 控制台错误
