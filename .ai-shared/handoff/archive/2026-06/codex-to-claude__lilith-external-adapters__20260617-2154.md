# Codex 修复：Lilith comparison external adapters

- **任务**：继续完善 Lilith / Codex CLI / OpenCode comparison matrix
- **时间**：2026-06-17 21:54 +08:00
- **范围**：`lilith/scripts/run-comparison-matrix.mjs`, matrix safety tests, benchmark docs
- **结果**：外部 adapter 执行框架已实现；默认仍安全关闭；完整验证通过

---

## 改动摘要

1. `lilith/scripts/run-comparison-matrix.mjs`
   - 实现 Codex CLI adapter：`codex exec --skip-git-repo-check --sandbox workspace-write --cd <workspace> <prompt>`。
   - 实现 OpenCode adapter：`opencode run <prompt>`。
   - 外部执行采用双钥匙门：必须同时传 `--run-external` 和环境变量 `LILITH_ALLOW_EXTERNAL_RUNS=1`。
   - 每个外部 agent / task 使用独立 disposable workspace，并复用同一 acceptance evaluator。
   - 支持 `LILITH_CODEX_COMMAND` / `LILITH_OPENCODE_COMMAND` 覆盖命令。
   - 支持 `LILITH_CODEX_BASE_ARGS` / `LILITH_OPENCODE_BASE_ARGS` JSON string array，用于测试或 wrapper。
   - 默认 report 仍只执行 Lilith deterministic harness，外部 Codex/OpenCode 标记为 not-run/unavailable。

2. `lilith/scripts/test-comparison-matrix.mjs`
   - 更新 `--run-external` 未授权场景：应安全跳过，而不是失败。
   - 保留 task-pack path escape regression。
   - 新增 mock external CLI 测试：不调用真实 Codex/OpenCode provider，验证 adapter 能跑完 4-task matrix，并得到 `passed=12, failed=0`。

3. `lilith/benchmark-suite.yaml` / `lilith/architecture.md`
   - 文档从 “adapter 未实现” 更新为 “adapter 已实现但默认双钥匙关闭”。
   - 明确 validation 只使用 mock CLI 验证 adapter，不调用真实外部 provider。
   - 继续保留 `parity_claim_allowed: false`。

## 验证

完整验证：

```text
& I:\514claude\514cc\lilith\scripts\validate-lilith.ps1
```

结果：

```text
Lilith policy regression tests passed (26 cases).
{"total":26,"passed":26,"failed":0}
{"total":12,"passed":4,"failed":0,"unavailable":4,"notRun":4}
Lilith comparison matrix safety tests passed.
Lilith validation passed.
```

Targeted mock external run：

```text
{"total":12,"passed":12,"failed":0,"unavailable":0,"notRun":0}
{"executedExternal":true,"passed":12,"failed":0,"unavailable":0,"notRun":0}
```

随后已重新运行默认 matrix，`lilith/comparison-matrix.latest.json` 恢复默认安全状态：

```text
{"total":12,"passed":4,"failed":0,"unavailable":4,"notRun":4}
```

## 使用边界

- 真实外部运行会调用本机 Codex/OpenCode，可能消耗 provider tokens、触发权限交互或受账号状态影响。
- 真实运行命令必须显式：
  - `--run-external`
  - `LILITH_ALLOW_EXTERNAL_RUNS=1`
- 即使真实跑出结果，仍需人工审阅报告后才可讨论 parity；当前 `parityClaim=false` 不变。

__VERDICT__: APPROVED_WITH_REMAINING_BOUNDARIES
__DELTA__: 烛(Codex) | 1 | 将 comparison matrix 从 not-run scaffold 推进到双钥匙外部 adapter 执行框架，并用 mock CLI 证明同一 4-task pack 可跑出 12/12；默认验证仍不调用真实 provider，继续禁止 parity claim。
