<!-- 514cc-session-id: 019ffb17-605d-7251-a7b6-b2a0789c1eec -->
# Grok Build CLI 1.0.3 响应延迟诊断与修复

日期：2026-08-13
执行者：烛（Codex）
状态：`CHANGES_REQUESTED / partial`。性能瓶颈已修复并完成短请求验证；凭据轮换、备份脱敏/删除与 ACL 收紧等待 LO 明确确认。

## 结论

当前实际 CLI 是 `C:/Users/16643/.grok/bin/grok.exe` 1.0.3，默认走自定义 `grok-4.6`、Responses backend 与 `https://514claude.xyz/v1`。

用户可见延迟由三层组成：

1. 修复前，Claude/Cursor 兼容发现面把 24 个 MCP 和大量规则/Skill 注入新会话，会话创建达到 11.663s 至 17.340s，6 字符请求达到 31,142 prompt tokens。
2. 第一轮收敛后仍有两个 Claude 插件 MCP 处于 active：`supabase` 在 headless 中做 OAuth discovery 后失败，`context7` 继续握手和列工具。Grok 在 `ensure_prefix_ready` 中等待两者完成，导致 prompt 已收到但延迟约 8.6s 才进入队列。这段等待发生在 turn 计时之前，所以摘要里的 `mcp_wait_ms=0` 会掩盖真实用户等待。
3. 模型/供应商侧仍有波动：同类短请求的实际 inference 为 4.911s 至 7.047s；这是禁用本地等待后剩余的主要耗时。

模型目录 5/10/20/40 秒 retry 确实出现过，但独立复核证明它在部分轮次是后台活动，不能作为全部交互延迟的单一已证主因。`remote_fetch=false` 消除了无谓网络重试和噪声，但本轮最直接的性能收益来自兼容内容收敛与插件 MCP 禁用。

## 修复

用户运行时 `C:/Users/16643/.grok/config.toml` 当前采用：

- `[features].remote_fetch = false`：仅使用内置/缓存/显式自定义模型，不再后台获取在线 model catalog。
- 保留现有 `grok-4.6` 的 `base_url`、`api_backend = "responses"`、`context_window` 与当前认证配置；本 handoff 不记录凭据值。
- `[compat.claude]` 与 `[compat.cursor]` 的 `skills/rules/agents/mcps/hooks/sessions` 全部设为 `false`；不删除 Claude/Cursor 真源。
- `[plugins].disabled` 精确加入 `user/6e316a22/context7` 与 `user/204c951f/supabase`，只阻止这两个插件的 MCP 进入 Grok 会话，不卸载插件、不改 `~/.claude`。
- 当前配置 SHA-256：`9AB376F02D2E55C780838BBCE1B3E96E568E3028F4F8262622D727CEB8B37D9D`。

## 关键证据

### 修复前

`C:/Users/16643/.grok/logs/unified.jsonl`：

- line 7072：新会话加载 24 MCP，创建耗时 11,663ms。
- line 7080：model catalog 第 3 次 retry 等待 20,000ms。
- line 7090：6 字符请求注入 31,142 prompt tokens，模型耗时 14,770ms，TTFT 8,065ms。
- line 7091：整轮 49,936ms，其中 pre-turn 20,102ms。
- line 7107、7111：一次 UI responding 卡住 264,907ms，最终手动取消。

### 插件 MCP 根因复现

会话 `019ffb4f-fc47-7562-acf0-db0ac26ba487`，调试日志 `.scratch/grok-debug-20260813-212910.log`：

- line 228-235：`supabase` OAuth discovery 耗时约 4.225s 后因 headless 无 token 失败。
- line 236-247：`context7` 握手、初始化和列工具继续耗时约 4.392s。
- line 248-251：`wait_for_mcp_handshakes_bounded` / `ensure_prefix_ready` 总计约 8.615s，之后 prompt 才 queue。
- unified line 7884、7887：`prompt received` 到 `prompt.queued` 约 8.610s。
- unified line 7894-7895：模型 6.553s，CLI turn 6.584s；外层总耗时 16.122s，精确输出 `OK`。

### 最终验证

禁用两个插件后，`grok inspect --json` 回读 active MCP 为 0。最终会话 `019ffb52-564b-7433-94bb-f5f0a3b76e86`：

- unified line 7941-7942：session create 337ms，CLI startup 675ms。
- line 7943-7946：`prompt received` 到 `prompt.queued` 约 1ms，8.6s intake gate 消失。
- line 7950：24 个内置/非 MCP 工具，`mcp_wait_ms=0`。
- line 7953-7954：模型 7.047s，TTFT 652ms，CLI turn 7.075s，正常完成。
- 外层 PowerShell：`ExitCode=0`、`ElapsedMs=7964`、输出精确为 `OK`。
- 退出后无残留 `grok.exe` / `agent.exe`。

## Hook 判定纠错

`grok inspect --json` 仍列出 23 条来自 `C:/Users/16643/.claude` 的 hook，同时 compat cell 显示 `hooks=false`。这与 1.0.3 文档“关闭 vendor hook scanning”的表述冲突，属于 inspect 发现态/展示态问题或版本缺陷。

但不能据此认定 hook 在运行：带 `GROK_HOOK_DEBUG=1` 的真实 session 日志明确显示 `total_hooks=0`、`user_prompt_submit=0`，且插件 MCP 禁用后 intake 从 8.609s 降至约 1ms。因此先前“8.6s 高度疑似三条 UserPromptSubmit hook”的判断已被直接证据推翻。

## 安全评审：CHANGES_REQUESTED

独立只读复核发现：

- 当前 `C:/Users/16643/.grok/config.toml` 仍含明文 API key。
- 三个回滚快照也含该 key：
  - `.ai-shared/backups/grok-cli-20260813-210103/config.toml`
  - `.ai-shared/backups/grok-cli-20260813-210706/config.toml`
  - `.ai-shared/backups/grok-cli-20260813-210904/config.toml`
- 三个快照被 `.gitignore` 排除，未进入 Git；但继承 ACL 含 `Authenticated Users: Modify`，已扩大本机泄露/篡改面。
- 本轮 Grok `--debug-file` 还把 model 配置的 key 原样写入 `.scratch/grok-debug-20260813-212910.log` 与 `.scratch/grok-final-20260813-213144.log`；精确秘密值扫描为 2/4 目标命中。两份文件未进入 `git status`，但仍是必须处理的本机凭据载体。

密钥轮换、改用 `env_key` 或外部认证提供器、删除/脱敏备份与调试日志、收紧 ACL 都属于敏感或高影响操作，必须由 LO 对具体动作明确确认后执行。不得在聊天、handoff 或日志中回显密钥值；后续性能探针不得再用未脱敏的 `--debug-file`。

## 剩余边界

- 当前 `remote_fetch=false` 会停用动态 catalog / fleet policy 获取；显式 `grok-4.6` 推理已验证不受影响。
- `context7` 与 `supabase` 插件 MCP 已对 Grok 禁用；以后需要在 Grok 中使用它们时，需重新启用并接受 OAuth/握手延迟，或为其补齐可复用认证。
- `inspect` 仍发现 10 个 Claude 插件和 23 条 Claude hook，但真实短会话 hook 执行数为 0，active MCP 为 0。发现态不再当作执行态。
- 已验证新会话短请求与退出链；尚未验证长任务、多轮 resume 或 Control Center adapter 端到端。
- 两组 `grok_search_chat_compat.mjs -> grok-search-rs.exe` 是 Codex app/MCP 运行面子进程，不属于 Grok Build 会话，未终止。

__DELTA__: 烛(Codex) | 2 | correctness | 证据：.scratch/grok-debug-20260813-212910.log:228-251 推翻“8.6s 来自 hook/catalog”的判断，锁定两个插件 MCP 的 prefix-ready 等待，并由 unified.jsonl:7943-7954 验证 intake 降至约 1ms
