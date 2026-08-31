# handoff：协作台群聊式 UI 2.0（UI 美观+完整度波次）

- 时间：2026-07-20
- 范围：`apps/control-center`（public/app.js、public/styles.css、public/markdown.js、public/index.html）
- 触发：LO「优先优化协作台的 ui 美观和完整度，完善逻辑对标市场上成熟产品，并且要更为创新和优秀」

## 设计判断

多 agent 团队对话的本质是**群聊**——成熟参照是 Slack/Discord（发言者身份+连续分组）而非单 agent 的 Claude/ChatGPT 平铺流。以群聊为骨架，保留 Claude 人文暖纸主题。

## 交付

1. **群聊分组**（Discord 式）：同一发言者 3 分钟内连续发言合并头像/名字，分组行悬停露时间戳；实时流与历史预览两路都生效。
2. **发言者身份**：名字着色（agent 配色槽延伸到 message-head）；头像 34px；LO 用 rose-deep + 暖底便签气泡（非对称圆角）。
3. **轮次胶囊分隔线** + 行悬停反馈（Discord 式）。
4. **代码块一键复制**（markdown 渲染层 code-wrap，复制已脱敏文本，悬停浮现）。
5. **会话拓扑参与者卡**：双字码/配色 chip 与会话流一致，最近发言者呼吸高亮（reduced-motion 静止）。
6. **composer 成熟键位**：Enter 发送 / Shift+Enter 换行（isComposing 守卫防中文输入法误发）+ 自动增高 220px 封顶 + 键位提示（移动端隐藏）。

## 验证

- 156/156 测试绿；qa:ui --suite=all ok:true 0 JS 错误。
- 截图复核：亮/暗双主题、悬停态、移动端 430px（会话横滑条为既有设计未动）。
- 如实边界：分组效果需多轮连续对话场景自然呈现（现有真实 run 多为独白/短对话，合成逻辑核验+渲染无错已过）；WCAG 对比度复用既有色板（此前已机械验证的 text-on-soft 组合），未新增颜色。

__DELTA__: 主驾(Kimi) | 1 | 证据：composer 聚焦环首版重复造轮（.composer:focus-within），自查发现既有 .composer-shell:focus-within 已承担后删冗余——补强「先查既有样式契约再新增」纪律
