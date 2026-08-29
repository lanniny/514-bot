<!-- 514cc-session-id: 01a032b4-af78-7ab3-814b-72d379ce88a0 -->
# FastCtx `Transport closed` 运行时修复

## 结论

2026-08-24 已将用户级 FastCtx 从 `0.2.5` 升级到 `0.2.6`。官方 `v0.2.6` release 明确修复共享 control center 失败会终止多个 MCP 会话的问题；本机症状与其描述一致。修复后 Apply 回执、受管二进制、MCP 契约和新 Codex 会话的真实工具调用均通过。

## 根因与动作

- 旧版 `0.2.5` 的一个共享 control center 失败会让该用户的多个会话收到 `Transport closed`，而 Codex 不会重启已丢失的 MCP server。
- npm 官方 registry 与 GitHub release 均读回最新稳定版 `0.2.6`，发布时间为 `2026-08-23T20:48:53Z`。
- 升级前确认无 FastCtx running background job；没有直接清理 `~/.fastctx/jobs/`。
- 先备份旧二进制、`~/.fastctx/config.toml` 与 `~/.codex/config.toml`，再安装 `fastctx@0.2.6`、短暂停止旧 FastCtx 进程并替换受管二进制。
- 执行 `fastctx apply --tier standard --yes` 后只更新 `~/.fastctx/config.toml` Apply 回执；Codex config 与 AGENTS 均显示 `Unchanged`。

## 验证

- 全局 npm 包：`fastctx@0.2.6`。
- 受管二进制：`fastctx 0.2.6`；SHA-256 为 `df94bf7bd76b886196607b486401a26c4a44a824448ca36ffc5505104535caf0`。
- `fastctx status` 退出 `0`：Applied state、Installed binary、MCP server contract、AGENTS guidance、fastshell 均为 `PASS`；`tools/list` 返回 9 个契约匹配工具。
- 独立新 Codex 会话直接调用 `mcp__fastctx.inspect_local_file`，成功读取 `rules.md:1-3`。
- 同一新会话直接调用 `mcp__fastctx.run`，输出 `FASTCTX_026_LIVE_OK`，退出码 `0`；未出现 `Transport closed`。

## 备份与边界

- 备份：`I:/514claude/514cc/.ai-shared/backups/fastctx-transport-repair-20260824-154943/`。
- 旧二进制哈希与新二进制哈希见该目录 `repair-manifest.txt:2-4`。
- `~/.fastctx/config.toml:2,19,30` 已读回版本与新哈希；`~/.codex/config.toml` 的 FastCtx command 仍指向稳定受管路径。
- 已经丢失 `0.2.5` transport 的旧会话不会被热修复；新会话会加载 `0.2.6`。本轮以独立新会话完成模型侧验收。
- 未修改 514cc 产品代码，未 reset/checkout/clean，未 commit/push。

__DELTA__: 烛(Codex) | 1 | 证据：C:/Users/16643/.fastctx/config.toml:19、C:/Users/16643/.fastctx/config.toml:30；将一次性重连现象收敛为 `0.2.5` 已知共享 control center 生命周期缺陷，并以 `0.2.6` 新会话真实工具调用闭环。
