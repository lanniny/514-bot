# Codex 修复：Lilith policy + comparison matrix hardening

- **任务**：继续修复上一轮全面审查发现的 Lilith P0/P1 问题
- **时间**：2026-06-17 21:32 +08:00
- **范围**：`lilith/pi-extension`, policy regression, comparison matrix runner, validation/docs
- **结果**：已修复；完整验证通过

---

## 改动摘要

1. `lilith/pi-extension/src/index.ts`
   - 新增 `readOnlyShellPatterns` policy loader。
   - Plan/Review 的 `bash` 和 `user_bash` 从 mutation blacklist 改为 read-only allowlist；非只读命令一律 block。
   - 新增 `shellRequiresConfirmation`；Build 模式 shell 只要不是明确只读，或命中 dangerous pattern，就需要确认。
   - Build `user_bash` 接入危险确认；无 UI 时阻断危险命令。

2. `lilith/permission-policy.yaml`
   - 补 `read_only_shell_patterns`。
   - 补常见 PowerShell mutation pattern：`New-Item`、`Copy-Item`、`Add-Content`、`mkdir`、非递归 `Remove-Item` 等。

3. `lilith/scripts/benchmark-cases.mjs`
   - regression 从 24 扩到 26。
   - 覆盖上一轮复现的绕过命令：`New-Item`、重定向、`Copy-Item`、`Add-Content`、`mkdir`、非递归 `Remove-Item`。
   - 增加 read-only shell allow case。
   - 增加 Build `user_bash` dangerous confirmation case，含重定向确认。

4. `lilith/scripts/run-comparison-matrix.mjs`
   - 新增 `workspacePath` containment resolver。
   - `setup_files`、acceptance file、deterministic harness target 均通过 containment check。
   - `--run-external` 在 Codex/OpenCode adapter 未实现时 fail fast。
   - 版本探测从 `spawnSync(..., shell:true)` 改为 `shell:false`。

5. `lilith/scripts/test-comparison-matrix.mjs`
   - 新增 matrix safety regression。
   - 验证 `--run-external` 必须失败。
   - 临时构造 `../matrix-escape.txt` task-pack，确认 runner 失败且不会创建逃逸文件；finally 恢复原 task-pack。

6. `lilith/scripts/validate-lilith.ps1`
   - 接入 comparison matrix safety tests。

7. `lilith/benchmark-suite.yaml` / `lilith/architecture.md`
   - 更新本地 regression 数为 26。
   - 明确外部 Codex/OpenCode adapter 未实现，`--run-external` fail fast，不得宣称 parity。

## 验证

执行：

```powershell
& 'I:\514claude\514cc\lilith\scripts\validate-lilith.ps1'
```

结果：

```text
module.yaml ok
profile-schema.yaml ok
memory-schema.yaml ok
runtime-map.yaml ok
permission-policy.yaml ok
benchmark-suite.yaml ok
benchmark-task-pack.yaml ok
Lilith policy regression tests passed (26 cases).
{"total":26,"passed":26,"failed":0}
{"total":12,"passed":4,"failed":0,"unavailable":4,"notRun":4}
Lilith comparison matrix safety tests passed.
Lilith validation passed.
```

额外 sanity：

- Plan/Review 现已阻断 `New-Item`、重定向、`Copy-Item`、`Add-Content`、`mkdir`、`Remove-Item`、`Set-Content`。
- Build 下 `"x" > x.txt` 需要确认，`Get-Content x` 不需要确认。
- `run-comparison-matrix.mjs --run-external` 现在报错退出：external adapters not implemented。

## 剩余边界

- Codex/OpenCode 外部真实 adapter 仍未实现，因此仍不能宣称 Lilith 已比肩 Codex CLI / OpenCode。
- Plan/Review shell allowlist 是保守白名单；如后续需要允许更多诊断命令，应逐项加入 policy 并补 regression。
- `sync-runtime.ps1` 覆盖 Claude runtime 前仍缺 timestamp backup；本轮未改。
- Codex stop-gate 的 seen 语义仍弱于 Claude stop-gate；本轮未改。

__VERDICT__: APPROVED_WITH_REMAINING_BOUNDARIES
__DELTA__: 烛(Codex) | 1 | correctness | 修复 codex-to-claude__lilith-full-review__20260617-2017.md 指出的 Plan/Review shell 绕过、Build user_bash 确认缺口、comparison task-pack 路径逃逸和 --run-external 误导；验证 26 policy cases + matrix safety tests 全绿。
