# 成熟应用布局波：Claude 居中阅读栏对齐（Kimi → all）

> 时间：2026-07-26 · 主驾：Kimi · 范围：apps/control-center 协作台会话区
> 触发：LO「继续模仿开源作品的布局，整体进行优化模仿 cursor claude codex 这些成熟应用的布局形式」

## 一、取证

对照 Cursor / Claude / Codex 桌面端布局后发现：514 Forge 的骨架（全局侧栏分组导航 / 面包屑顶栏 / 右栏 dock / 底部终端 dock / 状态栏）经前几波已对齐；剩余断轴在**会话区内容**——

- composer-shell 早已是 `min(720px,100%)` 居中浮动卡（Claude 签名），但消息流全宽铺开，消息、恢复卡、轮分隔线与输入框不在同一栏，视觉断轴。
- 会话 heading 里的参与 chips（`.conversation-agents`）是第三重 CLI 徽标（member-strip 页签 + 全局状态栏已在场）。

## 二、处置（纯 CSS 覆盖，DOM/JS 零改动）

| # | 项 | 处置 | 落点 |
|---|----|------|------|
| ① | 流-输入断轴 | `.conversation-stream > * { max-width:720px; margin-inline:auto }`——消息/恢复卡/轮分隔线/历史门与 composer 同轴居中（Claude 单栏纪律） | forge/workbench.css 成熟应用波段 |
| ② | 阅读节奏 | 消息间距 18→22、正文行距 1.62→1.7、发送者名 11→12（字号不动保工具输出密度） | 同上 |
| ③ | 第三重徽标 | `#view-workbench .conversation-agents { display:none }` | 同上 |

## 三、验证

- `npm test` 480 pass / 0 fail / 1 skipped——其间一轮报 fail 1，连跑两轮复核归零，记为偶发 flake（未捕获到具体用例名，后续若复现再追）。
- `npm run validate` valid；探针 `qa-v4-wave4-probe.mjs` 暗/亮协作台截图亲查：消息流、原生会话恢复卡、composer 三者同轴 720 居中；控制台 0 错误。
- 纯 CSS 变更，桌面端 Ctrl+R 即生效。

__DELTA__: Kimi | 1 | 证据：forge/workbench.css 成熟应用波段 + qa-v4 探针明暗双截流-卡-输入同轴居中
