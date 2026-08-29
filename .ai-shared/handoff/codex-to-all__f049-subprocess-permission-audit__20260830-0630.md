# F-049 子进程权限边界审计 — 查证闭合

> **状态**：✅ 查证后确认已闭合，非缺口
> **审计者**：烛（Codex 面），2026-08-30
> **蓝图标**：「部分验证」→ 查证为「完全闭合」

## 结论

所有 adapter 子进程权限边界已统一通过 `childProcessEnv` 白名单。蓝图中「Kimi 已 fail-closed，其余待查」的定性**已过时**——所有 provider 均已闭合。

## 证据

### 1. 环境变量白名单（`process-runner.mjs`）

- `RUNTIME_ENV_KEYS`：只允许 OS/user 基础变量（PATH, HOME, TEMP 等 40+ 项）
- `PROVIDER_ENV_KEYS[provider]`：每个 provider 独立凭据白名单（anthropic/openai/grok/kimi/gemini/opencode/pi）
- `PROVIDER_NETWORK_ENV_KEYS`：代理/证书变量仅在显式指定 provider 时注入
- 未知 provider → `UNKNOWN_ENV_PROVIDER` 错误（fail-closed）
- probe 命令（`--version`/`--list-models` 等）→ `inferProcessProvider` 返回 null，不注入凭据

### 2. 全部 adapter 覆盖

| Adapter | 路径 | 机制 |
|---|---|---|
| claude-cli | `runProcess` | `inferProcessProvider` → anthropic |
| codex-app-server | `childProcessEnv` 直接调用 | 显式 `environmentProvider: "openai"` + allowlist |
| codex-cli | `runProcess` | `inferProcessProvider` → openai |
| gemini-cli | `runProcess` | `inferProcessProvider` → gemini |
| grok-build | `runProcess` | `inferProcessProvider` → grok |
| grok-mcp | `CodexAppServerAdapter` | 显式 `environmentProvider: "grok"` + allowlist |
| kimi-cli | `runProcess` | `inferProcessProvider` → kimi |
| opencode-cli | `runProcess` | `inferProcessProvider` → opencode |
| pi-rpc | `childProcessEnv` 直接调用 | `provider: "pi"`, `providerKeys: []`（**零凭据，最严格**） |

### 3. 写权限 fail-closed

- **Kimi**：`workspace-write` → `UNSUPPORTED_PERMISSION` 错误（`kimi-cli.mjs:54`）
- **GroK Build**：写盘轮忽略 `nativeApprovalMode`，强制 `dontAsk` + 显式 allowlist + `--deny MCPTool`
- **Gemini**：`workspace-write` 无 `--auto`，锁定 `plan` 审批档
- **Claude**：写盘轮忽略 `native:*` 覆盖，固定 `acceptEdits`

### 4. 远程 run 环境隔离

`ssh/remote-run.mjs`：`cwd: undefined, env: {}`——本机 env/凭据不经命令行/env 注入远端。

## 残留观察（非 F-049 范围）

CC-Switch 内部工具（`ccswitch/domain.mjs`、`ccswitch/environment.mjs`）和 `child-registry.mjs` 的 `spawn` 调用继承了完整 `process.env`。这些是控制面内部操作（git clone、PowerShell 配置脚本），不在 adapter 执行路径上，不影响 F-049 闭合判定。

`__DELTA__: 烛(Codex) | 1 | 证据：全 adapter 子进程权限边界已统一（process-runner.mjs 白名单 + 9 adapter 全覆盖 + 写权限 fail-closed + 远程 env 隔离）`
