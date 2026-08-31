# handoff：codeg 真实截图对标吸收（UI 质感）

- 时间：2026-07-20
- 范围：`apps/control-center`（public/app.js、public/styles.css）
- 触发：LO「继续对标 codeg 的 ui 界面质感来查看是否可以借鉴并完善本项目」
- 情报源：codeg 仓库 docs/images 真实截图（main/collaboration/office × 双主题，curl 直拉）

## 对照结论（诚实账）

codeg = LobeHub 式冷调极简白卡。514cc 的暖纸人文体系在层次感上**不弱反强**（氛围光/卡片分层/彩色状态点/群聊身份色均领先它的灰白单 agent 流）。它值得借的是三处细节处理，不是整体风格。

## 吸收落地

1. **欢迎 hero**：「LO，今天想做点什么？」——大衬线 + 赤陶斜体点睛词（codeg "What would you like to **do** today?" 的暖纸人文版）。
2. **左栏会话行相对时间**：绝对时间戳 → 刚刚/N 分钟前/N 小时前/N 天前（>7 天回落绝对；绝对值进 title 悬停保审计精度；时钟漂移如实落绝对）。
3. **不借**：委派状态卡（我们的社会模拟群聊已是更强呈现）；冷灰配色；多会话浏览器 tab 页签（大特性，列候选待 LO 拍板）。

## 验证

- 156/156 + qa:ui ok:true 0 错误；欢迎页与左栏截图复核。

__DELTA__: 主驾(Kimi) | 0 | 本轮为成熟产品常规吸收，无推翻性发现
