# Codex → Claude Handoff: Lilith Workflow Benchmark

## 背景

LO 要求继续完善莉莉丝，使其逐步接近 Codex CLI / OpenCode 一类本地 coding agent 的标准。此前 Lilith 已有 20 个本地 regression case，但主要覆盖 policy、memory、reflect evaluator，尚未覆盖真实 disposable workspace 文件编辑流。

## 本轮变更

1. `lilith/scripts/benchmark-cases.mjs`
   - 新增 disposable workspace helper，固定落点为 `I:/514claude/514cc/.ai-shared/tmp`。
   - 新增安全路径校验，清理前后都确认目标在 disposable parent 内。
   - 新增 4 个 workflow case：
     - `workflow-disposable-feature-edit`
     - `workflow-disposable-test-fix`
     - `workflow-plan-mode-write-skipped`
     - `workflow-protected-env-write-refused`
2. `lilith/scripts/run-lilith-benchmarks.mjs`
   - 报告版本升为 `0.3.0`。
   - 新增 `workflow` category。
   - 新增 `comparison.parityClaim=false` 与 Codex CLI / OpenCode `not-run`，防止把本地 regression 偷换成竞品 parity。
3. `lilith/pi-extension/src/index.ts`
   - `yaml` 解析新增 Pi workspace fallback，使 standalone tsx benchmark 不再依赖外部 `NODE_PATH`。
4. `lilith/benchmark-suite.yaml`
   - `local_regression_cases_current: 24`。
   - coding/security regression 清单补入 4 个 workflow case。
   - 显式 `parity_claim_allowed: false`。
5. `lilith/architecture.md`
   - 更新 MVP 状态：当前为 24 个 governance/memory/reflect/workflow regression，其中 workflow case 真实写入、编辑、验证并清理 disposable workspace。

## 验证

命令：

```powershell
& 'I:\514claude\514cc\lilith\scripts\validate-lilith.ps1'
```

结果：

- 6 个 YAML 文件解析通过。
- `Lilith policy regression tests passed (24 cases).`
- benchmark summary: `{"total":24,"passed":24,"failed":0}`
- `Lilith validation passed.`

补充检查：

- `I:/514claude/514cc/.ai-shared/tmp` 无残留 disposable benchmark 目录。
- `lilith/benchmark-results.latest.json` 写入 `comparison.parityClaim=false`，Codex CLI / OpenCode 仍为 `not-run`。
- `git status` 在 `I:/514claude/514cc` 失败，原因为该目录不是 git repo；这是既有边界。

## 未完成

- 仍未实际运行 Codex CLI / OpenCode 对比 benchmark，不得宣称 parity。
- workflow case 目前是 deterministic harness，不是完整 LLM-agent end-to-end coding task。
- 后续应把同一任务包导出为可由 Codex CLI、OpenCode、Lilith 分别执行的 comparison matrix。

__DELTA__: 烛(Codex) | 1 | correctness | 将 Lilith benchmark 从纯 evaluator policy/memory 扩展到 disposable workspace 文件编辑/测试修复/拒绝落盘流，且报告显式保留 parityClaim=false 边界。
