# handoff：agent 官方徽标选择器 + 系统图标官方化

- 时间：2026-07-20
- 范围：`apps/control-center`（public/index.html、public/app.js、public/styles.css）
- 触发：LO「点击项目右边的新建会话后右边会话界面跳出各个 agent 的悬浮图标供清晰选择；此系统中的类似图标默认都要是模型对应厂商的官方标志，不要主观臆造」

## 交付

1. **官方徽标 sprite 扩充**（出处可考）：
   - xAI Grok = Wikimedia `File:XAI Logo.svg`（xAI 公司徽标）
   - KIMI = simple-icons KIMI（源 kimi.com）
   - Inflection Pi = simple-icons Pi（与 pi.dev/favicon.svg 下载比对**同形实证**后采用）
   - Google Gemini = simple-icons（源 gemini.google.com）
   - Anthropic/OpenAI 沿用既有官方徽标
2. **agent 徽标选择器**：项目行尾「新建会话」/选址对话框确认后，会话区弹「从谁开始？」悬浮卡阵（官方徽标+品牌 soft 底+leader 标注）；点卡写回 start-agent 并联动 /model·/effort；「先不选」回落直接输入；非团队成员不出阵。
3. **系统图标官方化**：AGENT_CLI 映射——会话流头像、活跃轮呼吸行、拓扑参与者 chip、成员条 chip 全部官方徽标；无官方映射者才回落双字码，不臆造。
4. **顺手修**：项目行尾「新建会话」查找漏 pending（与右键菜单同类），换 findProjectById。

## 验证

- Playwright 实机：行尾新建会话 → 6 卡 6 官方徽标全出 → 点 Grok Build → start-agent=grok-build + 选择器关闭；0 JS 错误。
- 156/156 + qa:ui --suite=all ok:true。

__DELTA__: 主驾(Kimi) | 1 | observability | 证据：Pi 徽标未轻信 simple-icons 归属，下载 pi.dev/favicon.svg 比对同形后才采用——补强「官方标志必须实证出处」纪律（LO 明令不要主观臆造）
