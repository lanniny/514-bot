# handoff：能力图谱升级可配置面 + tab 宽度修复

- 时间：2026-07-20
- 范围：`apps/control-center`（src/capabilities.mjs、src/orchestrator.mjs、src/app.mjs、server.mjs、public/app.js、public/index.html、public/styles.css、tests/capabilities.test.mjs）
- 触发：LO「1.tab标签页会变得异常宽 2.需要能够配置全部 agent skill、mcp 等等的入口」

## 交付

1. **tab 异常宽修复**：inline span 不吃 text-overflow，长标题撑破页签——title 改 block + 三级 min-width:0 收束。
2. **agent skill 启停矩阵**（真接线）：负名单存 `dataRoot/agent-capabilities.json`；能力图谱页 21×6 checkbox 矩阵；**orchestrator 成员轮提示词按负名单过滤 skill 声明注入**（run.teamSkills 快照固化）；写失败前端回滚勾选。
3. **MCP 隔离式启停**（claude.json 全局 server）：禁用=条目含 env 原样移隔离区（逐字节可恢复）+ `.514cc-backup` 写前备份 + **mtime 乐观锁**（外部改写即 STALE_BASE 拒，不覆写 Claude Code 并发写）+ 确认弹窗明示风险；codex TOML 如实只读（编辑器未就绪不做假写入）；隔离条目回表可见可恢复。

## 验证

- 新增 4 测试：负名单回环 / 隔离-恢复逐字节一致+备份 / STALE_BASE+READ_ONLY_SOURCE 双拒 / **编排接线实证（禁用 skill 不进提示词）**。
- 160/160 + qa:ui ok:true；矩阵截图复核。

__DELTA__: 主驾(Kimi) | 1 | 证据：能力图谱初版只做只读（我自己定的"启停涉及供应链信任不做"），被 LO「需要配置入口」推翻——补强「只读先行后必须评估可写面的真实归属：skill 启停是控制面自有数据，本可以早做」
