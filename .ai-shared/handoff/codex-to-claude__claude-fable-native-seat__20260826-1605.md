<!-- 514cc-session-id: 01a03cf9-7c07-7243-b96a-b9ae174886a7 -->
# Claude Fable 原生席位传输修复

- **范围**：Windows `claude.ps1` shim 与原生 `claude.exe` PATH 解析；不放宽 `PROMPT_TRANSPORT_UNSAFE`。
- **根因**：`resolveCommand()` 按目录逐个追加 `.exe/.com/.ps1`。npm 全局目录的 `claude.ps1` 在 PATH 前部时，会先于后续 `claude.exe` 命中；Claude stdin 因此实际经 `powershell.exe -File`，中文提示词被传输闸拒绝。
- **修复**：裸 `claude` 命令启用专用 native-preferred 顺序：先扫描所有 PATH 目录的 `claude.exe/.com`，只有找不到原生 peer 才回落 `claude.ps1`。其他命令继续保留首目录所有权顺序。
- **安全边界**：显式路径和显式 `.ps1` 不自动改写；仅有 shim 时，非 ASCII prompt 仍由 `prompt-transport.mjs` fail-closed 为 `PROMPT_TRANSPORT_UNSAFE`。

## 验证

- `node --test tests/redaction-jsonl.test.mjs tests/prompt-transport.test.mjs tests/runtime-executable-dirs.test.mjs`：32 pass / 0 fail / 1 既有 PowerShell 回显 skip。
- `node --test tests/adapters.test.mjs tests/orchestrator.test.mjs`：189 pass / 0 fail。
- `npm test`：1659 total / 1657 pass / 0 fail / 2 skip；`clean-exit` 的 launch/resource/exit/childexit 全部 `ok`。
- `npm run validate`：13 项配置/注册表校验全部 `valid: true`。
- 当前机器解析回读：`resolveCommand("claude")` → `C:\\Users\\16643\\.local\\bin\\claude.exe`，`prefixArgs=[]`。
- 原生探针：`runProcess("claude", ["--version"])` → `2.1.226 (Claude Code)`，exit code `0`。
- 中文 stdin 封装回读：`sealPromptTransport({ prompt: "中文任务 🎯", transport: "stdin", command: "claude" })` 成功生成 `514cc.promptTransport/v1` 记录。

## 运行态边界

当前本地 Control Center 仍有 PID `9384` 的 `node --experimental-sqlite server.mjs --dev` 进程；本轮未终止或 reload 它，避免未经确认的运行态中断。源码修复会在该实例下一次受控 reload/重启后生效；本轮未执行真实 Claude 付费中文 provider turn。

__DELTA__: 烛(Codex) | 1 | 证据：`apps/control-center/src/process-runner.mjs:271-307` 为 `claude` 增加跨 PATH 原生 `.exe` 优先；`apps/control-center/tests/redaction-jsonl.test.mjs:165-181` 锁定早期 `.ps1` + 后续 `.exe` 场景，且保留其他命令首目录所有权回归。
