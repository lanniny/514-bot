# Codex 交接：MCP / Skill 完整修复

- **日期**：2026-07-11
- **范围**：514cc 源、Codex、Claude、Cursor、用户级 Skills
- **结论**：修复完成，独立审查 `APPROVED`
- **密钥纪律**：本文不包含任何 token/API key

## 最终结果

Grok 的真实协议已经从错误的 Responses 路径收口为 `/v1/chat/completions`。Claude 与 Codex 均使用 `I:/514claude/514cc/scripts/grok_search_chat_compat.mjs`：它只监听 loopback，以随机本地令牌隔离子进程，删除网关拒绝的搜索 tool 字段，并把正文 URL 转成 `grok-search-rs 0.1.15` 可识别的 citations。

真调用结果：`fallback_used=false`、`sources_count=1`，来源为 `https://github.com/openai/codex`。输出里的内部 provider 标签仍叫 `grok_responses`，但抓取到的实际 HTTP path 是 `/v1/chat/completions`；该标签不是协议回退。

Claude 最新全量健康检查为 19 项 `Connected`。唯一其他状态是 `plugin:supabase:supabase` 的 `Needs authentication`，它是按需 OAuth，需用户本人授权，不是配置错误。

## 根因与修复

1. `GROK_SEARCH_API_KEY` 会让 crate 优先选择 Responses；改用 `OPENAI_COMPATIBLE_*` 后进入 Chat Completions。
2. crate 在 web 开关为 true 时向 Chat Completions 注入 `tools:[{"type":"web_search"}]`，网关返回 422；兼容层删除该字段并强制 web 开关为 false。
3. crate 不会从普通正文自动提取来源；兼容层补全 https URL、Markdown URL、裸域名和数组文本的 citation 归一化，并要求上游返回完整绝对 URL。
4. Claude 曾仍使用原始 Grok 命令与浮动 Scrapling；已改为同一兼容启动器，并固定 `scrapling[ai]==0.4.10`。
5. Serena 的 `uvx git+HEAD` 会因 Git 刷新/构建超时；已按当前 README 安装 `serena-agent`，Claude/Codex 均改为直接 `serena start-mcp-server`。
6. `ace-tool` 的既有 token 曾位于命令行参数；已迁移到用户环境变量，Claude/Codex 只保留 `%ACE_TOOL_TOKEN%` 占位符。
7. Codex managed TOML 原实现会整体替换 marker 区，独立审查发现未知根键、允许命名空间下点号键可能被静默删除；现在严格校验 root、`projects` 子键与 `mcp_servers` 子键。
8. Codex Apply 原实现可能在缺源/合并失败时先写部分文件；现在所有源、AGENTS 候选、TOML 候选和写权限都在首次写入前验证，文件原子替换，目录经临时副本哈希校验后换名。

## 关键源文件

- `scripts/sync-codex-runtime.ps1`
- `scripts/merge_codex_config.py`
- `scripts/test_merge_codex_config.py`
- `scripts/test_sync_codex_runtime.ps1`
- `scripts/grok_search_chat_compat.mjs`
- `scripts/grok_search_chat_compat_core.mjs`
- `scripts/test_grok_search_chat_compat.mjs`
- `scripts/audit_skills.py`
- `.codex/config.toml`

## 机械验证

| 验证项 | 结果 |
|---|---|
| Grok MCP 真搜索 | `fallback_used=false`，1 个来源 |
| Claude MCP 健康 | 19 Connected；Supabase 仅待 OAuth |
| Serena stdio | Connected，server 1.27.0 |
| ace-tool stdio | Connected，server 0.1.16，命令无明文 token |
| Scrapling 动态 fetch | HTTP 200，正文正确 |
| Playwright Chromium | 149.0.7827.55 可启动 |
| TOML 合并测试 | 11/11 通过 |
| Grok 兼容测试 | 通过 |
| 同步器集成测试 | PS7 + PS5.1 均通过 |
| Codex runtime sync | agents/skills/AGENTS/config 全一致 |
| Claude runtime sync | 15/15 映射一致 |
| Skill 全量审计 | 68 唯一；未解决 0 |

## Skill 审计口径

- 48：严格 validator 直接通过。
- 18：仅含宿主支持的 `argument-hint`，不是加载错误。
- 2：OpenAI primary runtime 插件自有命名 schema，归插件宿主管理。
- 0：未解决错误。

SSH 三份宿主副本已统一；research 与 Vivado frontmatter 已修；陈旧 vibe 副本移入 `skills-disabled`；Claude docx 标准 junction 已恢复。审计器已固化为 `scripts/audit_skills.py`，在 Windows 默认 GBK 下会自动以 UTF-8 模式重启，避免中文 Skill 假失败。

## 运行时与备份

主备份时间戳：`20260710-184902`。

- `I:/514claude/514cc/.ai-shared/backups/repair-20260710-184902`
- `C:/Users/16643/.codex/backups/repair-20260710-184902`
- `C:/Users/16643/.claude/backups/repair-20260710-184902`
- `C:/Users/16643/.agents/backups/repair-20260710-184902`

另有 Codex 同步器自动备份：`C:/Users/16643/.codex/backups/514cc-runtime-20260711-054401`。

## 剩余边界

1. Supabase OAuth 只能由用户在实际需要时登录授权；保留两个有效 Supabase Skill。
2. Cursor 当前未运行，配置 JSON 与 Skill 链接有效；下次启动后加载。
3. 已打开的旧 Codex 任务仍可能保留启动时缓存的旧 MCP 子进程。它们属于 Codex 主进程托管的其他任务，未强杀；重启 Codex 或新建任务即可加载当前命令。
4. 提升权限 PowerShell 在本机常出现“动作完成但包装器不退出”；本轮所有写入均以哈希、JSON/TOML 解析、CLI 回读或真实 MCP 握手确认，未把 exit 124 直接当失败。

## 独立审查

烛先后发现三个主线自审遗漏：marker 根键静默删除、Apply 部分同步、允许命名空间下点号键绕过。主线修复并补回归后，独立定向复核结论为 `APPROVED`，无剩余致命问题或建议。

__DELTA__: 烛(Codex) | 2 | correctness | 发现并推动修复 managed-block 根键/点号键静默删除与 Apply 部分同步；最终定向复核 APPROVED（merge_codex_config.py:347/354，test_merge_codex_config.py:126/134）。
