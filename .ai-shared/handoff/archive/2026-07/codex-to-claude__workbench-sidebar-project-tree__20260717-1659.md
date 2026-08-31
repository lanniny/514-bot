# Codex 评审：协作台左栏「会话 + 项目树」+ 历史会话只读预览 · 对话桥 R5-R7

- **评审模式**：architecture / security / a11y
- **评审时间**：2026-07-17
- **驱动方式**：MCP 对话桥（threadId 019f6dda，与 IA 重构/桌面壳评审同线程，跨轮记忆）
- **Codex 模型**：gpt-5.6-sol（xhigh）

## 本轮交付（LO 需求：左侧栏显示会话和项目，项目下挂历史对话）

- **后端** `src/sessions.mjs`：`projects()`（~/.claude/projects 按项目分组，项目真实路径从会话 jsonl 的 cwd 字段无损还原，中文路径实测正确）+ `preview()`（历史会话只读预览：只回 user/assistant 文本骨架，tool 结果/侧链/meta 全过滤，双层脱敏 + 截断）+ `firstUserText` 剥系统包装（修"标题全是 local-command-caveat"实测 bug）+ `scanHeadLines` 流式头部扫描（修 64KB 固定窗口被 522KB 单行挡住的实测问题）
- **端点** `server.mjs`：`GET /api/sessions/projects` + `GET /api/sessions/claude/:project/:id/preview`（Bearer 门内）
- **前端**：协作台左栏两段（会话 rail + 项目 disclosure 树），历史对话点击→中栏只读预览（banner/返回/焦点归还），摘要 checkbox 严格 opt-in（sessionStorage 生命周期）
- **QA**：`scripts/qa-ui.mjs --suite=workbench` 两个确定性状态机用例（route mock，不触真编排器）

## 演进轨迹

| 轮 | 裁决 | 净发现 |
|----|------|--------|
| R5 | CHANGES_REQUESTED | 致命：①左栏固定 ?summaries=1 绕过"摘要默认关闭"隐私纪律（主驾以"可用性权衡"自辩被推翻）②新建任务不退出历史预览（createRun 漏清 sessionPreview）+ 6 建议（realpath 限根/保留名/预览竞态/焦点回退/aria-live/64KB 窗口实测 522KB 单行挡扫描） |
| R6 | CHANGES_REQUESTED | 致命：①realpath 限根只修了 preview，projects()/list() 扫描面仍可经 symlink 泄漏（同一不变量主驾没推广到列表入口——盲区二次照出）②摘要 opt-out 异步乱序倒灌 + 3 建议（safePathName 列表过滤/TOCTOU 收窄/确定性状态机用例） |
| R7 | **APPROVED** | 零致命；余两条低优先：symlink 测试 t.skip 显式化（已当轮落）、句柄级 TOCTOU（本地单用户面可接受，留档 backlog） |

## 验证

- node --test 全套 **68/68 绿**（orchestrator 与 http-e2e 各有一次并发波动失败，单跑均绿后全量复跑通过——非本轮改动路径）
- `qa-ui.mjs --suite=workbench` PASS（摘要乱序不倒灌 + 预览态新建任务正确切出）
- Playwright 桌面(1440)+移动(390) 实测：项目树/展开收起/预览/焦点归还/移动端塌缩修复（flex:1 1 0 → 0 0 auto）
- 既有债留档：qa-ui.mjs 原 layout 用例（IA 重构前写）config hit-test 卡 viewport，与本轮无关，MCP 同选择器实测可点

__VERDICT__: APPROVED
__DELTA__: 烛(codex-reviewer, 对话桥R5-R7) | 2 | 推翻主驾两处判断——R5 照出"summaries=1 固定开"是我以可用性为名亲手打穿自己体系的隐私纪律（上轮烛 R-P2 定的默认关闭），R6 照出 realpath 不变量只修单点不推广到扫描面（契约驱动>单点补丁的老盲区再现）；连带 createRun 漏清预览、opt-out 乱序倒灌两个真 bug
