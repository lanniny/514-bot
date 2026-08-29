---
topic: continue-loop-compaction-followup
date: 2026-08-19 20:55
author: 主驾（Cursor Agent / AEMEATH）
scope: apps/control-center
status: 源码修复已落盘并聚焦回归；全量测试 1 条 http-e2e 闪断后单测重跑通过；独立复审已派烛
session: 本轮无 route-gate session marker，不编造
---

# 「继续」循环 / context compact 接续修复

## 接手前磁盘真相

烛 16:50 评审 `__VERDICT__: CHANGES_REQUESTED`。核源码后：F1/F3 已被后续工作树修过（`withRunLifecycle` + `interactionContextCompactions` 显式预算）。F2/F4/F5/S2/S3 当时仍开着。

## 本轮落地

1. **F4** `finalizeActive`：有 `error` 发 `assistant.partial_message`，正常终局才发 `assistant.message`。
2. **S3** `nativeTurnError`：`turn.error` 存在即失败，message 缺失用 errorInfo kind 兜底。
3. **F5/S1** 压缩 abort 打断等待 10s（低于中断闸 30s）；超时路径也 `interruptTurn`。
4. **F2** 三个 `run.context_compaction_*` 进 `GOVERNANCE_EVENTS`；压缩中呼吸行「正在压缩上下文，请勿中断」；SSE 侧 `trackContextCompaction`。
5. **S2** `turn/completed` 必须已绑定 `compaction.turnId`。
6. **测试**：二次耗尽必须终止；压缩窗口中断必须作废线程；自动续跑不得重开压缩预算；半截正文负向断言；无 message 的 contextWindowExceeded。

## 验证（我跑过的）

- `node --test tests/orchestrator.test.mjs tests/adapters.test.mjs` → **174/174 pass**（2026-08-19 20:18）
- UI 契约 18/18 pass
- `npm test` → **1526 pass / 1 fail / 2 skipped**；失败项 `http-e2e` 租赁释放时序，与本轮无关。单测重跑该文件 **8/8 pass**
- `npm run validate` → 13 项全部 `valid: true`（进程随后未退出，结果已打印）

## 未做完

- 真实会话 compact 后点「继续」的运行态验收：正式实例 **PID 13880 已死**，`127.0.0.1:51400` fetch failed
- PTY：磁盘 `remote-gates.grants.json` **已有 pty grant**（2026-07-25）；无 revocation。未再写授权、未重启内核——等 LO 确认后拉起再浏览器回验
- Claude Forge：只清了 `#e11d48` / `#b4234d` 玫瑰红 fallback；Lucide-only / 零表情 / 多视口验收未完成本轮

__DELTA__: 主驾 | 1 | governance | 证据：codex-app-server.mjs finalizeActive 异常终态改 partial_message；app.js GOVERNANCE_EVENTS 登记 context_compaction_*；orchestrator 压缩窗口 abort 作废线程测试已绿
