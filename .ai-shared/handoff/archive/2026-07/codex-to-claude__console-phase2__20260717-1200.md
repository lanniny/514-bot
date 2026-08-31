# Codex 评审：Console Phase 2（观测面板 + 会话聚合）· 对话桥 R-P2 三轮

- **评审模式**：architecture / 安全（隐私泄漏面 + fail-closed）
- **评审时间**：2026-07-17
- **驱动方式**：MCP 对话桥（threadId 019f6dda，同会话第 7-9 轮，与桌面壳 R1-R4 共用一条线程——Codex 全程记得壳评审的上下文）
- **Codex 模型**：gpt-5.6-sol（xhigh）

## 演进轨迹

| 轮 | 裁决 | 净发现 |
|----|------|--------|
| R-P2 R7 | CHANGES_REQUESTED | 2 致命：①会话摘要 140 字截断≠脱敏，token/密码泄漏前端 ②models.json 谎称 Claude 能搜索（adapter 实为 --tools "" --strict-mcp-config 不能搜索）+ 4 建议（realpath/尾读残行/drift 重叠/payload 解析/缺单测） |
| R-P2 R8 | CHANGES_REQUESTED | 致命2 闭环；致命1 未闭环——redactString 只认高熵格式，password=MyCompanySecret1234 赋值型仍漏；建议全落实但 symlink/大文件分支无测试覆盖 |
| R-P3 R9 | **SECURE** | 致命1 闭环：默认关闭摘要（三源零提取）+ opt-in 双层脱敏（高熵+赋值型）。无阻塞级剩余 |

## 修复要点

- **隐私纵深防御**：SessionAggregator.list includeSummaries 默认 false——claude/codex/grok 三源默认零摘要（真实数据实证 25/25/5→0）；opt-in 才提取且过 redactString + ASSIGNMENT_SECRET 双层 scrub；bridge lastTopic 亦过 scrub（R9 建议）
- **fail-closed**：撤销 Claude web-search capability（governance evidence 明说 adapter 不能搜索）；current-research 在 grok 不可用时 NO_ROUTE（不 silent 给无能力 provider）
- **建议**：handoffContent realpath 限根 / tailText start>0 丢截断首行 / drift timedOut 标记+close 后 reject / firstUserText 补 payload 直挂形态

## 验证

- 单元/集成 54 pass 0 fail（唯一 http-e2e 60s 超时 = v3.5 起既有环境类失败，非本次回归）
- 新增 tests/observability-sessions.test.mjs 9 用例（TSV 解析/DELTA 双扫/穿越防护/默认关摘要/双层脱敏/symlink 逃逸/大文件尾读/payload 解析）
- config validate 4/4；真实数据双向冒烟（default 三源零摘要 / opt-in 52 摘要零泄漏）

__VERDICT__: SECURE
__DELTA__: 烛(codex-reviewer, 对话桥R-P2×3) | 2 | 推翻主驾两处判断——①"140字截断=够安全"（实为泄漏面，驱动默认关摘要+双层脱敏）②主驾把"我的会话有web MCP"错映射给 control-center claude adapter（实为 --tools "" 不能搜索，谎称能力违反 silent fallback 红线）；主驾在隐私面+运行时边界有盲区，异构三轮收敛 SECURE
