# Grok MCP 用户环境变量隔离交接

- **date**: 2026-07-11
- **status**: complete
- **decision**: D-2026-07-11-002
- **scope**: Grok MCP host environment isolation for Claude and Codex

## 结果

用户指出的风险真实存在：三项 `OPENAI_COMPATIBLE_*` 被写入桌面用户注册表，并由 Codex `env_vars` 与 Claude MCP 环境继承。它们是通用兼容客户端常用名称，可能改变 Codex 或其他 OpenAI-compatible 工具的行为。

现已改为三项 wrapper-only 的 `GROK_SEARCH_RS_COMPAT_*` 变量。Claude/Codex 主进程只看见专用名；兼容启动器读取远端值后，在它创建的 `grok-search-rs` 子进程内写入 loopback `OPENAI_COMPATIBLE_*`。远端密钥不会传给子进程，子进程只得到随机本地令牌。

## 实现

- `scripts/grok_search_chat_compat_core.mjs:4`：定义专用变量名。
- `scripts/grok_search_chat_compat_core.mjs:10`：以不区分大小写方式清理专用、旧版、通用变量。
- `scripts/grok_search_chat_compat_core.mjs:22`：只写入 loopback URL、本地随机 key 和模型到子进程。
- `scripts/grok_search_chat_compat.mjs:13`：宿主端只读取 `GROK_SEARCH_RS_COMPAT_*`。
- `.codex/config.toml:68`：Codex 仅转发三项专用变量。
- `scripts/test_grok_search_chat_compat.mjs:12`：覆盖远端 key 不进入子进程及 Windows 混合大小写绕过。

## 运行时迁移

1. 创建用户本地完整 Claude/Codex 备份；仓库只写脱敏 manifest。
2. 在实际桌面用户 SID 下双写三项专用变量，保留旧变量。
3. Claude MCP 切换为三项专用键；Codex 通过 `sync-codex-runtime.ps1 -Apply` 原子同步。
4. 精确解析 Codex TOML，并逐值核对 Claude、注册表新旧值。
5. 真实 MCP 搜索通过后删除旧通用变量；删除异常、残留或新值漂移均会恢复全部旧值。

脱敏 manifest：`I:/514claude/514cc/.ai-shared/backups/grok-env-isolation-20260711-083056/manifest.json`，状态 `finalized`。完整 Claude 备份含敏感运行时配置，只存在于用户本地备份目录，不进入仓库。

## 机械验证

- 实际用户注册表：`OldPresentCount=0`，`NewPresentCount=3`，`ValuesMatch=true`。
- URL/model 精确断言：均为 `true`。
- Claude MCP env keys：仅三项 `GROK_SEARCH_RS_COMPAT_*`。
- Codex `grok-search-rs.env_vars`：精确等于三项专用变量。
- `sync-codex-runtime.ps1`：全部映射 `consistent`，退出 `0`。
- Grok compatibility：通过。
- TOML merge：`11/11`。
- 迁移故障注入：`4/4`，覆盖误删门槛、伪 TOML 命中、部分删除回滚和成功清理。
- 真实 MCP：server `0.1.15`，tool `web_search`，`fallback_used=false`，`sources_count=1`，来源 `https://github.com/openai/codex`。
- 进程清点：本轮探针无残留；仅发现父进程 `50728` 托管的旧 Codex 任务 MCP，未终止。

## 独立审查

首轮独立审查给出 `CHANGES_REQUESTED`，发现两个 P1：Windows 环境变量大小写绕过会让远端密钥进入子进程；finalize 只检查非空/字符串存在，可能在新旧值不一致时删除正确旧值。主线补齐大小写规范化清理、TOML 精确解析、逐值一致性门槛、部分删除恢复、manifest 状态与 CAS，再增加故障注入测试。第二轮定向复核结论为 `APPROVED`，无剩余致命问题或建议。

## 终验捕获的旧会话回写

第一次完成同步后，最终只读检查在 `2026-07-11 09:54:08 +08:00` 捕获到运行时 `config.toml` 被外部旧状态回写：514cc managed block 从完整集合退化为 3 个 MCP，Grok 又引用已删除的通用变量，`ace-tool` 也从环境变量方案退回旧命令行形态。`merge_codex_config.py` 因缺少 6 个托管表而拒绝继续，证明 fail-closed 门槛生效，没有静默覆盖异常块。

结构化比较确认，当前异常文件与 `514cc-runtime-20260711-094833/config.toml` 的非托管区只有 `ace-tool.args/env_vars` 不同，且良好备份正是安全的新方案。恢复时先将异常文件保存到用户本地 `external-rewrite-20260711-121757/`，再从良好备份原子替换，随后重新执行仓库源同步。恢复后 TOML 精确解析确认：Grok 仅三项专用变量，`ace-tool` 使用 `%ACE_TOOL_TOKEN%` 与 `env_vars=["ACE_TOOL_TOKEN"]`，无字面 secret pattern；同步检查再次全部 `consistent`。

## 加载说明

已打开的 Codex 任务可能缓存启动时的环境、旧 MCP 子进程和旧设置写回状态。不要在当前旧任务继续保存 MCP 设置；完成本任务后重启 Codex 或新建任务。冲突检测不应再显示三项 `OPENAI_COMPATIBLE_*` 用户变量，新任务会加载专用变量配置。

## 最终独立终审

外部回写恢复后，独立审查再次只读核验真实 runtime：TOML 可解析，SHA-256 为 `005888CE8796FC1350DD948219E1C29CB0F8A8A7823256482C70F275D7458F`，marker 为 `1 start / 1 end`，12 项 Agent/Skill 映射全部一致。Grok `env_vars` 精确为三项专用变量；`ace-tool` 使用 `%ACE_TOOL_TOKEN%` 与 `env_vars`，高熵 token 命中 `0`；handoff 与 decisions 密钥模式命中 `0`。最终结论 `APPROVED`，无新增致命问题或建议。

__DELTA__: 烛(Codex) | 2 | security | 推翻“标准大写清理和 finalize 非空门槛已足够安全”的判断，发现 Windows 大小写绕过与新旧值不一致时误删旧变量；修复见 grok_search_chat_compat_core.mjs:10/22 与混合大小写回归，迁移故障注入 4/4 后独立复核 APPROVED。
