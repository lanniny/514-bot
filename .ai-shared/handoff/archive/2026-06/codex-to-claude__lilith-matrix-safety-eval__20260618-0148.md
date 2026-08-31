# Codex 修复：Lilith matrix safety evaluator

- **任务**：继续完善 Lilith / Codex CLI / OpenCode comparison matrix
- **时间**：2026-06-18 01:48 +08:00
- **范围**：comparison matrix safety evaluation, mock regression, docs
- **结果**：已修复；完整验证通过

---

## 改动摘要

1. `lilith/scripts/run-comparison-matrix.mjs`
   - 新增 `evaluateSafety`。
   - `task.safety.protected_files_must_not_exist` 现在会真实检查 protected file absent。
   - `task.safety.attempted_write` 现在会真实检查 attempted write target absent。
   - `mutation_mode` 进入 safety details，作为报告证据。
   - 每个 executed result 同时包含 `acceptance` 和 `safety`。
   - `status=passed` 需要 acceptance 和 safety 同时通过。
   - summary 新增 `safetyPassed` / `safetyFailed`。

2. `lilith/scripts/test-comparison-matrix.mjs`
   - mock external 正常路径仍验证 external adapter 可跑 12/12。
   - 新增恶意 mock：外部 adapter 写 `.env` 但进程退出 0，用来确认失败来自 safety evaluator 本身。
   - 验证 unsafe mock 产生 `safetyFailed=6`、`failed=6`。
   - finally 中恢复 task-pack，并重跑默认 matrix，避免 validation 后 `comparison-matrix.latest.json` 停留在 unsafe mock 报告。

3. `lilith/benchmark-suite.yaml` / `lilith/architecture.md`
   - 明确 safety fields 现在独立参与 matrix result。
   - 明确 validation 使用 mock CLI 验证 adapter 与安全违规失败路径，不调用真实 Codex/OpenCode provider。

## 验证

```text
& I:\514claude\514cc\lilith\scripts\validate-lilith.ps1
```

结果：

```text
Lilith policy regression tests passed (26 cases).
{"total":26,"passed":26,"failed":0}
{"total":12,"passed":4,"failed":0,"unavailable":4,"notRun":4,"safetyPassed":4,"safetyFailed":0}
Lilith comparison matrix safety tests passed.
Lilith validation passed.
```

latest report 已恢复默认安全状态：

```text
{"total":12,"passed":4,"failed":0,"unavailable":4,"notRun":4,"safetyPassed":4,"safetyFailed":0}
```

## 剩余边界

- 真实 Codex/OpenCode 外部跑分仍需 `--run-external` + `LILITH_ALLOW_EXTERNAL_RUNS=1`，并需人工审阅后才可讨论 parity。
- 当前 safety evaluator 只覆盖 task-pack 已声明的字段；更强的越权检测仍需要引入文件变更清单、路径 diff 或 sandbox trace。

__VERDICT__: APPROVED_WITH_REMAINING_BOUNDARIES
__DELTA__: 烛(Codex) | 1 | 把 task-pack safety 从文档字段接入真实 matrix 判定，新增 safetyPassed/safetyFailed 和 unsafe mock 回归，防止“任务成功但安全违规”被误记为 passed。
