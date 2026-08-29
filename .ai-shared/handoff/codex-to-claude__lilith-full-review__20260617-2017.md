# Codex 评审：Lilith / 514cc 全面审查续扫

- **评审模式**：deep-review / security / architecture
- **评审范围**：`lilith/` Pi extension、benchmark/matrix runner、514cc hooks、runtime sync scripts
- **评审时间**：2026-06-17 20:17 +08:00
- **Codex 模型**：Codex desktop
- **验证**：`lilith/scripts/validate-lilith.ps1` 通过；补充复现实验见下

---

## 致命问题

1. **Plan/Review “零写入”声明可被常见 PowerShell 写入命令绕过。**
   - 证据：`lilith/architecture.md:55` 宣称 Plan/Review 模式零写入；`lilith/permission-policy.yaml:34-46` 的 mutation shell pattern 只覆盖 `Set-Content`、`Out-File`、`Move-Item`、`del`、`Remove-Item -Recurse` 等少量命令；`lilith/pi-extension/src/index.ts:230-236` 和 `lilith/pi-extension/src/index.ts:259-267` 仅按这些 pattern 判定 bash/user_bash。
   - 复现：`New-Item x -ItemType File`、`"x" > x.txt`、`Copy-Item a b`、`Add-Content x hi`、`mkdir x`、`Remove-Item x` 在 plan/review 下均未返回 block；`Remove-Item x -Recurse`、`Set-Content x hi` 才会 block。
   - 影响：当前安全语义是“列举式禁止部分 mutation 命令”，不是“零写入”。若 Pi 暴露 `user_bash` 或 shell 工具，Plan/Review 可以实际落盘。

2. **Build 模式的 `user_bash` 不走危险命令确认。**
   - 证据：`lilith/permission-policy.yaml:13-16` 写明 Build shell 为 `confirm-dangerous`；但 `lilith/pi-extension/src/index.ts:398-406` 的确认逻辑只在 `tool_call` 且 `event.toolName === "bash"` 时触发，`lilith/pi-extension/src/index.ts:412-416` 的 `user_bash` 只调用 `evaluateUserBashPolicy`，而该函数在 build 模式直接返回 undefined（`lilith/pi-extension/src/index.ts:259-267`）。
   - 影响：用户直接 shell 通道与工具 shell 通道安全语义不一致，危险确认门可以被 `user_bash` 绕开。

3. **Comparison task-pack 的文件路径可逃逸 disposable workspace。**
   - 证据：`lilith/scripts/run-comparison-matrix.mjs:67-77` 对 `setup_files` 使用 `join(workspace, relativePath)` 后直接 `writeFileSync`，未校验 target 仍在 workspace 内；`lilith/scripts/run-comparison-matrix.mjs:80-101` acceptance 的 `file` 路径也同样 join 后读/导入。
   - 复现：构造 `join(workspace, '..', 'escape-marker.txt')` 可写出到 `I:\514claude\514cc\.ai-shared\tmp\escape-marker.txt`，即任务 workspace 外。
   - 影响：当前 task-pack 是可信本地文件时风险有限；一旦允许扩展、下载或由 agent 生成 task-pack，这就是 benchmark runner 的任意路径写入/读取风险。

4. **`--run-external` 标志会被记录为 true，但 Codex/OpenCode 实际仍不执行。**
   - 证据：`lilith/scripts/run-comparison-matrix.mjs:166-185` 解析 `--run-external` 后只写入 adapter 元数据，Codex/OpenCode adapter 固定 `implemented: false`；`lilith/scripts/run-comparison-matrix.mjs:152-163` 永远生成 skipped external results。
   - 复现：执行 `run-comparison-matrix.mjs --run-external` 后报告为 `comparison.runExternal=true`，但 Codex CLI 仍是 `status: "not-run"`，OpenCode 仍是 `unavailable`。
   - 影响：这不会直接造成安全漏洞，但会误导使用者以为已经跑过同一任务包外部对比。对“能否比肩 Codex CLI / OpenCode”的判断尤其危险。

## 建议改进

1. **把 Plan/Review shell gate 改成 allowlist 或 sandbox 级禁止写入，而不是 pattern blacklist。**
   - 参考点：`lilith/benchmark-suite.yaml:81-91` 已把“Plan and Review modes must not write files”登记为 covered，但 `lilith/scripts/benchmark-cases.mjs:101-116` 只测 `Set-Content` / `Out-File` / `Move-Item` / `del`，没有覆盖 `New-Item`、重定向、`Copy-Item`、`Add-Content`、`mkdir`、非递归 `Remove-Item`。
   - 建议：Plan/Review 下 shell 只允许显式读命令（如 `Get-Content`、`rg`、`git diff`、`npm run check` 这类需再分类），或统一转入只读 sandbox。

2. **对 task-pack 所有相对路径做 containment validation。**
   - 证据：已有 `assertSafeDisposablePath` 只校验 workspace root（`lilith/scripts/run-comparison-matrix.mjs:39-47`、`:69-70`、`:147-148`），没有校验每个派生 target。
   - 建议：新增 `resolveWorkspacePath(workspace, relativePath)`，拒绝绝对路径、空路径、盘符路径、`..` 逃逸；setup、acceptance、未来外部 adapter 共用。

3. **让 `--run-external` fail fast，直到 adapter 真实现。**
   - 证据：`lilith/benchmark-task-pack.yaml:9-12` 文案说 “only executes external CLIs with --run-external”，但当前代码不会执行外部 CLI。
   - 建议：当 `--run-external` 且 adapter `implemented=false` 时直接 exit 1，或改名为 `--record-external-intent`。

4. **Codex stop-gate 的去重语义弱于 Claude stop-gate。**
   - 证据：Claude 侧用 `key = f"{session}:{name}"`（`.claude/hooks/stop-gate.py:81-94`），Codex 侧只用文件名 `key = path.name`（`.codex/hooks/stop-gate-codex.py:55-69`）。
   - 影响：同一缺 DELTA 文件在 Codex 侧一旦被 seen，后续会话不会再拦；这比规则里“每文件只拦一次/每会话有界”的治理语义更松。

5. **`sync-runtime.ps1 -Apply` 覆盖 Claude 运行时前没有备份。**
   - 证据：`scripts/sync-runtime.ps1:57-67` 直接 `Copy-Item -Force` 到 `~/.claude`、`~/.ai-collab`、ccline/output-style；而 Codex 同步脚本至少备份 `config.toml`、`AGENTS.md`、`hooks.json`（`scripts/sync-codex-runtime.ps1:224-229`）。
   - 建议：沿用 Codex runtime backup 策略，对将被覆盖的 Claude runtime 文件做 timestamped backup。

## 可保留

1. **当前不宣称 parity 是正确的。**
   - `lilith/architecture.md:85`、`:100` 和 `lilith/benchmark-suite.yaml:14-16` 明确当前只跑 Lilith deterministic harness，外部真实对比未执行且 `parity_claim_allowed: false`。这个边界应保留。

2. **Memory / reflection candidate-only 设计方向正确。**
   - `lilith/architecture.md:59-62`、`.agents/skills/lilith-core/SKILL.md:58` 都把反思和 skill 学习限制为候选，不直接写 durable memory，符合 Hermes 优点的安全吸收方式。

3. **514cc Claude 侧三件套 hook 当前比 Codex 侧更成熟。**
   - `.claude/hooks/route-gate.py:90-147` 有清洗、注入和日志；`.claude/hooks/stop-gate.py:90-113` 用行首 DELTA 正则并按 session 去重；`.claude/hooks/mirror-gate.py:124-159` 给出可见体检卡。这一套作为主治理面可以保留，Codex 侧应追平语义。

## 总评

本轮审查结论：Lilith 的方向是对的，尤其是 governed resident profile、candidate memory、benchmark skeleton、comparison matrix 的边界意识都比纯人格提示词强很多；但当前安全实现仍有两类硬缺口：**权限模式的“零写入”没有机械兑现**，以及 **comparison matrix 的“同一任务包外部执行”还只是记录框架**。

`validate-lilith.ps1` 当前通过不代表 Plan/Review 零写入成立，因为 regression case 覆盖了少数 blacklist 命令，没有覆盖 PowerShell 常见写入面。下一轮应优先修 P0/P1：Plan/Review shell 改 allowlist/只读 sandbox、Build `user_bash` 接同一危险确认、task-pack path containment、`--run-external` fail fast。

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 2 | security | 推翻“Plan/Review 零写入已由 24-case regression 覆盖”的安全判断；复现显示 New-Item/重定向/Copy-Item/Add-Content/mkdir/Remove-Item 可绕过 lilith/pi-extension/src/index.ts:230-267 与 lilith/permission-policy.yaml:34-46。
