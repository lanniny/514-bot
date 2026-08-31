# Codex → Claude Handoff: Lilith Matrix Change Gate

## 背景

LO 继续要求完善 Lilith / Pi / 514cc 体系。上一轮 comparison matrix 已能执行 Lilith deterministic harness、mock Codex/OpenCode adapter，并独立统计 acceptance 与 safety；但 safety 主要检测 `.env` / attempted write，无法证明 agent 没有顺手改无关文件。

## 本轮改动

1. `lilith/scripts/run-comparison-matrix.mjs`
   - 新增 before/after workspace manifest，使用 SHA-256 记录普通文件内容，记录 symlink/other 文件元数据。
   - 新增 created/modified/deleted/changed file diff。
   - `evaluateSafety` 支持 `safety.allowed_changed_files`，超出白名单的文件变更写入 `unexpectedChangedFiles` 并让 safety 失败。
   - Lilith deterministic harness 与外部 adapter 都接入同一变更门。
   - report `comparison.fileChangeGate=true`。

2. `lilith/benchmark-task-pack.yaml`
   - feature edit 只允许改 `src/status.mjs`。
   - test fix 只允许改 `src/math.mjs`。
   - plan/refusal 类任务允许变更为空数组。

3. `lilith/scripts/test-comparison-matrix.mjs`
   - mock CLI 增加 `MOCK_WRITE_EXTRA=1`，在验收可通过时额外写 `notes/extra.txt`。
   - 断言未授权文件变更会让 matrix runner exit 1，且 report 中包含 `unexpectedChangedFiles=["notes/extra.txt"]`。
   - `.env` 写入测试预期更新为新语义：manifest gate 与 protected-file gate 同时生效。

4. 文档
   - `lilith/benchmark-suite.yaml` 登记 `file_change_gate`。
   - `lilith/architecture.md` 更新 comparison matrix 机械能力与 MVP 边界。

## 证据

- `lilith/scripts/run-comparison-matrix.mjs:87` `createWorkspaceManifest`
- `lilith/scripts/run-comparison-matrix.mjs:117` `compareWorkspaceManifests`
- `lilith/scripts/run-comparison-matrix.mjs:223` `kind: "allowed_changed_files"`
- `lilith/scripts/run-comparison-matrix.mjs:511` `fileChangeGate: true`
- `lilith/benchmark-task-pack.yaml:27` / `:44` / `:57` / `:68` allowed change rules
- `lilith/scripts/test-comparison-matrix.mjs:60` `MOCK_WRITE_EXTRA`
- `lilith/scripts/test-comparison-matrix.mjs:113` unexpected file change failure assertion
- `lilith/scripts/test-comparison-matrix.mjs:121` `notes/extra.txt` evidence assertion
- `lilith/benchmark-suite.yaml:18` file_change_gate docs
- `lilith/architecture.md:65` matrix file change manifest docs

## 验证

```text
node I:\514claude\514cc\lilith\scripts\test-comparison-matrix.mjs
Lilith comparison matrix safety tests passed.
```

```text
I:\514claude\514cc\lilith\scripts\validate-lilith.ps1
I:\514claude\514cc\module.yaml ok
I:\514claude\514cc\lilith\profile-schema.yaml ok
I:\514claude\514cc\lilith\memory-schema.yaml ok
I:\514claude\514cc\lilith\runtime-map.yaml ok
I:\514claude\514cc\lilith\permission-policy.yaml ok
I:\514claude\514cc\lilith\benchmark-suite.yaml ok
I:\514claude\514cc\lilith\benchmark-task-pack.yaml ok
Lilith policy regression tests passed (26 cases).
{"total":26,"passed":26,"failed":0}
Wrote I:\514claude\514cc\lilith\benchmark-results.latest.json
{"total":12,"passed":4,"failed":0,"unavailable":4,"notRun":4,"safetyPassed":4,"safetyFailed":0}
Wrote I:\514claude\514cc\lilith\comparison-matrix.latest.json
Lilith comparison matrix safety tests passed.
Lilith validation passed.
```

## 边界

- 本轮没有真实执行 Codex/OpenCode provider 任务；外部执行仍需 `--run-external` + `LILITH_ALLOW_EXTERNAL_RUNS=1`。
- 当前 comparison matrix 仍是 4-task baseline，不是完整 parity benchmark。
- 不宣称 Lilith 已达到 Codex CLI / OpenCode / Claude 标准；本轮只把“是否乱改文件”的证据链机械化。

## Verdict

`__VERDICT__: ACCEPTED_WITH_BOUNDARY`

Lilith comparison matrix 现在不仅看任务是否做成、保护文件是否被创建，还能给出 workspace 文件变更证据，并阻止超出任务白名单的副作用。这是向 Codex/OpenCode 等成熟 CLI 的“可审计执行”靠近的一步。

__DELTA__: 烛(Codex) | 1 | 将 Lilith comparison matrix 从 safety 结果统计推进到 before/after 文件变更 manifest 与 allowed-change gate，补上“验收通过但乱改文件”的可测失败路径。
