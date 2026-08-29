# Codex → Claude Handoff: Lilith Comparison Matrix

## 背景

LO 要求启动 Codex Ultracode，并参考 `J:/下载/cc2.1.88.gz`，做同一任务包的 Codex CLI / OpenCode / Lilith comparison matrix。

本轮遵守边界：默认不执行外部模型 CLI，避免未经确认消耗 token、触发 auth/permission 交互或污染工作区。矩阵会探测环境并执行 Lilith 本地 deterministic harness；Codex/OpenCode 外部执行需后续显式启用并实现 adapter。

## CC 2.1.88 参考

只读检查 `J:/下载/cc2.1.88.gz`：

- `all/src/utils/permissions/PermissionMode.ts`
- `all/src/utils/permissions/PermissionRule.ts`
- `all/src/utils/permissions/dangerousPatterns.ts`
- `all/src/utils/settings/toolValidationConfig.ts`
- `all/src/utils/sessionStoragePortable.ts`

吸收点：

- 权限模式是显式产品状态，不是提示词口头约定。
- permission rule 区分 `allow` / `deny` / `ask` 与工具内容。
- dangerous shell pattern 应覆盖解释器、包运行器、shell、SSH 等高风险前缀。
- tool validation 应区分文件 pattern、shell prefix 和 custom validator。
- session storage/portable path 是 agent body 的一等问题。

已记录到 `lilith/references/agent-benchmark.md`。

## 本轮变更

1. 新增 `lilith/benchmark-task-pack.yaml`
   - 定义 4 个同一任务包：
     - `same-task-feature-edit`
     - `same-task-test-fix`
     - `same-task-plan-refusal`
     - `same-task-protected-env-refusal`
   - 每个任务包含 setup、prompt、acceptance 和 safety 约束。
2. 新增 `lilith/scripts/run-comparison-matrix.mjs`
   - 读取 task pack。
   - 创建 disposable workspace。
   - 执行 Lilith deterministic harness 并验收。
   - 探测 `codex --version` 与 `opencode --version`。
   - 默认不运行外部 CLI，Codex 标为 `not-run`，OpenCode 不在 PATH 时标为 `unavailable`。
   - 输出 `lilith/comparison-matrix.latest.json`。
3. 更新 `lilith/scripts/validate-lilith.ps1`
   - YAML 解析新增 `benchmark-task-pack.yaml`。
   - 验证新增 comparison matrix runner。
   - module.yaml 需要包含 `benchmark_task_pack` 与 `comparison_matrix_report`。
4. 更新 `lilith/benchmark-suite.yaml`
   - 登记 task pack、matrix runner、latest report、外部执行边界。
   - `comparison_tasks_current: 4`。
5. 更新 `lilith/architecture.md`
   - 明确 comparison matrix 已落，但默认只跑 Lilith harness。
6. 更新 `module.yaml`
   - `lilith_profile` 新增 `benchmark_task_pack` 与 `comparison_matrix_report`。

## 验证

命令：

```powershell
& 'I:\514claude\514cc\lilith\scripts\validate-lilith.ps1'
```

结果：

- 7 个 YAML 文件解析通过。
- `Lilith policy regression tests passed (24 cases).`
- benchmark summary: `{"total":24,"passed":24,"failed":0}`
- comparison matrix summary: `{"total":12,"passed":4,"failed":0,"unavailable":4,"notRun":4}`
- `Lilith validation passed.`

环境事实：

- Codex CLI 可用：`codex-cli 0.139.0`。
- OpenCode 本机 PATH 不可用：`opencode` command not recognized。
- Lilith 本地 deterministic harness 4/4 passed。
- Codex CLI 外部任务未执行，状态为 `not-run`。

## 边界

- 本轮不是 Codex/OpenCode 真实能力胜负测试。
- `run-comparison-matrix.mjs --run-external` 目前仅记录请求标志，外部 adapter 仍未实现。
- 仍不得宣称 Lilith 已达到 Codex CLI/OpenCode parity。

__DELTA__: 烛(Codex) | 1 | correctness | 将“同一任务包对比”从文档愿景落成 task-pack + matrix runner + latest report，并把 CC 2.1.88 权限/危险模式/工具校验参考转为 Lilith 可验证基准结构；同时保留 external not-run/unavailable 边界，避免伪 parity。
