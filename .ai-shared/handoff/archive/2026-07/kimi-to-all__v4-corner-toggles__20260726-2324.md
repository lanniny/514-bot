# 角位开关波：终端撤下顶栏、开合键统一右上角（Kimi → all）

> 时间：2026-07-26 · 主驾：Kimi · 范围：apps/control-center 顶栏 + 协作台
> 触发：LO「不需要终端单独一个页面标签，保留可以在下侧栏打开终端界面的按键就行，并且和打开右侧栏的按键统一一起放在右上角」

## 一、处置（codeg RightEdgeChrome DNA）

| # | 项 | 处置 | 落点 |
|---|----|------|------|
| ① | 终端顶栏标签 | `.topbar-nav [data-view="terminal"]{display:none}`；视图本体保留（Ctrl+K 可达），入口=底部 dock 条 / 右上角开关 / Ctrl+\` | forge/shell.css 角位开关波段 |
| ② | 角位双开关 | topbar-actions 尾部 `#global-terminal-toggle`（square-terminal）+ `#global-mc-toggle`（panel-right），aria-pressed + is-active 铜底反映开合态 | index.html + shell.css |
| ③ | 跨视图行为 | 非协作台点击先 `click()` 顶栏协作台项再开合（探针实测 BACK-TO: view-workbench） | workbench-chrome.js |
| ④ | 状态同步 | 两个 setCollapsed 出口统一调 hoisted 同步函数，dock 条/Ctrl+\`/MC 头钮/细条/角位钮全路径角标一致 | workbench-chrome.js |

**陷阱记录**：初版试图对 `const` 箭头函数做包裹赋值（`setCollapsed = ...`）——运行即 TypeError，改函数声明提升（hoisted `function syncGlobalToggle`）在 setCollapsed 定义内直接调用修正。

## 二、验证

- `npm test` 480 pass / 0 fail / 1 skipped——**偶发 flake 第二次出现**（fail 1 后复跑归零，两轮均未捕获用例名，已记账：复现即追）。
- `npm run validate` valid；探针 `qa-v4-wave5-probe.mjs` 四截亲查：顶栏无终端标签、角钮开 dock（懒挂载 PTY）、角钮收 MC 成 34px 细条、团队视图点 MC 钮自动回协作台；控制台 0 错误。
- QA 主脚本 terminal 站改 `dispatchEvent("click")`（顶栏项隐藏后真实点击不可行）。
- 纯静态资产变更，桌面端 Ctrl+R 生效。

__DELTA__: Kimi | 1 | 证据：qa-v4/27-dock-via-corner-light.png 角钮开 dock + 28-mc-via-corner-light.png 角钮收 MC（CHANGELOG v4.0 未发布节）
