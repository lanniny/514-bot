# Codex 评审：Console IA 重构（对话优先三区制）· 对话桥 R1-R4

- **评审模式**：architecture / 可访问性
- **评审时间**：2026-07-17
- **驱动方式**：MCP 对话桥（threadId 019f6dda，与壳/Phase2 评审同线程，跨轮记忆）
- **Codex 模型**：gpt-5.6-sol（xhigh）

## 演进轨迹

| 轮 | 裁决 | 净发现 |
|----|------|--------|
| R1 | CHANGES_REQUESTED | 致命：移动端 router/security 彻底不可达（mobile-nav 去掉+侧栏隐藏，手改 hash 不算可达）+ 3 建议（nav 分组语义/refreshCurrentView 漏 observability&sessions/初始标题+h1 焦点） |
| R2 | CHANGES_REQUESTED | 触屏可达闭环（汉堡抽屉 7 视图全可达）；新增 a11y 阻塞——离屏侧栏 transform 隐藏但仍在 Tab 顺序+a11y 树，移动键盘用户聚焦不可见控件 |
| R3 | CHANGES_REQUESTED | inert/焦点/aria-controls/特异性修复正确；新焦点回归——选视图后焦点被抢回汉堡（应保留目标 h1）+ 抽屉关闭时 Esc 仍跳汉堡 |
| R4 | **APPROVED** | 关闭原因区分正确、选视图保留 h1 焦点、Esc/backdrop 恢复汉堡、Esc 仅 nav-open 时响应；无阻塞级新问题 |

## 交付要点（对标 Cursor Agents Window / Claude Code orchestrator seat）

- **落地页 overview→workbench**：打开即对话工作区（任务列表 | 会话流+composer | 上下文栏），首屏 composer 可见
- **7 扁平 tab → 三级层级**：协作台=一等工作面（玫瑰主卡）；观测组/配置组降为带 role=group 标签的次级
- **移动端全可达**：汉堡→离屏抽屉（inert 关闭态移出 a11y 树 + 焦点管理 + aria-controls），7 视图无一丢失
- 修：refreshCurrentView 补 observability/sessions、初始标题、h1 tabindex 焦点迁移、CSS 特异性 bug（.topbar .mobile-menu-button）

## 验证

Playwright 桌面(1440)+移动(390) 双视口实测：7 视图切换、composer 首屏、inert 关闭态/焦点入首项/Esc 归还汉堡/桌面汉堡隐藏+侧栏常显——全 PASS。CSS 括号 411/411，node --check 过。核心低风险=协作台内部早是对话三栏，重新挂载非重写。

__VERDICT__: APPROVED
__DELTA__: 烛(codex-reviewer, 对话桥R1-R4) | 2 | 推翻主驾"IA 反转已完成可交付"——R1 照出移动端 router/security 我亲手造成的可达性致命，R2/R3 连续两轮照出离屏抽屉 a11y 盲区（inert 缺失/焦点回归）——主驾在移动可达性+键盘焦点管理有系统盲区，异构四轮收敛 APPROVED
