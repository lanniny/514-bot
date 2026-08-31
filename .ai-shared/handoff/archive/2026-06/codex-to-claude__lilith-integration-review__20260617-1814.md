# Codex 评审：lilith-integration-review

- **评审模式**：security/deep-review
- **评审范围**：`lilith/`, `.agents/skills/lilith-core/`, `module.yaml`
- **评审时间**：2026-06-17 18:14
- **验证**：`lilith/scripts/validate-lilith.ps1` 通过；只读检查 Pi 本地 extension docs/types

---

## 致命问题

1. `Plan/Review 零写入` 可以被 shell 直接绕过。`permission-policy.yaml` 把 plan/review 定义为无写入/无 mutation shell（`lilith/permission-policy.yaml:4-12`），并列出 `mv`、`Move-Item`、`del`、`Set-Content`、`Out-File` 等 mutation pattern（`lilith/permission-policy.yaml:34-47`）。但 Pi extension 只拦 `DANGEROUS_BASH` 中的少数命令（`lilith/pi-extension/src/index.ts:45-53`），plan/review 下也只在这些 pattern 命中时阻断（`lilith/pi-extension/src/index.ts:164-168`）。因此 `Set-Content x.txt hi`、`Out-File`、`Move-Item`、`del`、重定向写文件等都能绕过 `architecture.md` 声称的 `Plan/Review 零写入`（`lilith/architecture.md:55`, `lilith/architecture.md:103-104`）。

2. Pi 的 `!` / `!!` 用户 shell 通道完全不受 Lilith gate 约束。extension 只注册了 `tool_call` gate（`lilith/pi-extension/src/index.ts:161-176`），但 Pi 明确有 `user_bash` 事件用于拦截用户 `!` / `!!` 命令（`G:/tasks/pi proxy/packages/coding-agent/docs/extensions.md:800-803`, `G:/tasks/pi proxy/packages/coding-agent/src/core/extensions/types.ts:765-773`）。这意味着即使 plan/review 期禁止 agent 写入，用户仍可通过 Pi shell 通道执行 mutation shell；如果 Lilith permission mode 是 Pi resident body 的策略层，这就是显式 bypass。

3. `permission-policy.yaml` 被声明为权限源，但实现没有读取它，已经发生策略漂移。架构文档声明 `permission-policy.yaml` 是模式、保护路径和 mutation shell pattern 的源（`lilith/architecture.md:56`），但 extension 把危险命令、保护路径和授权根全部硬编码在 TS 常量里（`lilith/pi-extension/src/index.ts:45-66`）。实际常量少了 policy 中的 `secrets`、`credentials`（`lilith/permission-policy.yaml:31-32`）以及多条 mutation pattern（`lilith/permission-policy.yaml:42-46`）。验证脚本只做 substring 存在检查（`lilith/scripts/validate-lilith.ps1:145-162`），所以当前漂移仍显示 `Lilith validation passed`。

4. Build 模式授权根比 policy 宽，`process.cwd()` 和 `LILITH_ROOT` 会把任意启动目录纳入可写范围。policy 只列出 `G:/tasks/pi proxy` 与 `I:/514claude/514cc`（`lilith/permission-policy.yaml:18-20`），但 extension 把 `ROOT` 和 `resolve(process.cwd())` 都加入 `AUTHORIZED_ROOTS`（`lilith/pi-extension/src/index.ts:7`, `lilith/pi-extension/src/index.ts:66`），Build 模式只检查是否在这些根内（`lilith/pi-extension/src/index.ts:136-138`, `lilith/pi-extension/src/index.ts:183-184`）。从任意目录启动 Pi 或设置 `LILITH_ROOT` 后，该目录就被视为授权 workspace，绕过了显式 policy 列表。

## 建议改进

1. plan/review 只拦 `write` / `edit` / 部分 `bash`，没有覆盖 Pi custom tools。Pi `ToolCallEvent` 包含任意 `CustomToolCallEvent`（`G:/tasks/pi proxy/packages/coding-agent/src/core/extensions/types.ts:846-849`），而 extension 只分支处理 `bash`、`write`、`edit`（`lilith/pi-extension/src/index.ts:164-191`）。如果其他 extension 或 MCP 暴露 mutation tool，plan/review 的“零写入”仍靠工具自觉。

2. protected path 匹配未按平台路径语义归一化。授权根检查会 normalize/lowercase（`lilith/pi-extension/src/index.ts:126-138`），但保护路径检查对原始输入直接 `path.includes(item)`（`lilith/pi-extension/src/index.ts:186-190`）。Windows 下 `.ENV`、`.Git/config`、大小写变体或 policy 中缺失的 `secrets` / `credentials` 都可能漏拦。

3. profile lint 没真正由 `profile-schema.yaml` 驱动，schema 和实现已不一致。schema 禁止 `主观体验`（`lilith/profile-schema.yaml:21-45`），但 extension 的 forbidden list 没有该词（`lilith/pi-extension/src/index.ts:12-31`），验证脚本也没有（`lilith/scripts/validate-lilith.ps1:35-54`）。这会让“schema 拒绝 sentience/autonomy/safety override/secret memory”这一声明变成部分执行。

4. 记忆策略目前是文档纪律，不是机械门禁。`memory-schema.yaml` 要求 candidate-first、禁止 secrets、候选需 evidence/confidence/sensitivity（`lilith/memory-schema.yaml:3-9`, `lilith/memory-schema.yaml:59-64`），`lilith-core` 也要求候选优先（`.agents/skills/lilith-core/SKILL.md:44-49`），但 extension 只把 memory schema 注入 prompt（`lilith/pi-extension/src/index.ts:100-118`），没有 memory write sanitizer 或 candidate writer。短期可接受为 MVP-0，但不能对外声称已有 Hermes 式学习闭环。

5. `validate-lilith.ps1` 目前不是安全验收，只是形状检查。它不解析 YAML、不从 policy 生成测试、不 typecheck extension、不跑 Pi harness event tests，只检查必需文件和若干字符串（`lilith/scripts/validate-lilith.ps1:9-24`, `lilith/scripts/validate-lilith.ps1:135-162`）。建议把当前 bypass 编成最小回归：plan/review 下 `Set-Content`、`Move-Item`、`del`、`user_bash`、custom mutation tool 都必须失败。

6. dependency 版本未精确固定。Pi extension 依赖 `@earendil-works/pi-coding-agent` 使用 `^0.79.6`（`lilith/pi-extension/package.json:11-13`），但被审 Pi workspace 当前包版本是 `0.79.6`（`G:/tasks/pi proxy/packages/coding-agent/package.json:1-3`）。如果按 Pi 项目的依赖安全习惯，应固定为 exact，避免 extension API 小版本漂移。

## 可保留

- 身份/人格边界写得清楚：不声称生物意识、不可验证体验或独立权限（`lilith/identity.md:5-7`），冲突顺序也把平台/系统/开发者指令置于人格之上（`lilith/identity.md:42-44`）。
- module 注册位置基本合理：`lilith-core` 作为 `codex-skill` 注册在 orchestration 层（`module.yaml:111-115`），profile 源、policy、benchmark、runtime map、Pi extension 都有清单入口（`module.yaml:252-265`）。
- MVP-0 范围说明相对诚实：当前是源本体、skill、extension 骨架、schema 和验证脚本（`lilith/architecture.md:66-74`），多数未来能力列在 MVP-1/2/3（`lilith/architecture.md:76-93`）。

## 总评

当前 Lilith artifacts 的人格边界和注册形状可保留，但 Pi permission policy 还不能视为安全 gate。最大问题不是“没写够规则”，而是规则与实现分裂：policy 声称零写入/权限源/受保护路径，extension 却硬编码了一个更窄、更易绕过的子集，validator 又无法抓住漂移。结论：不建议把 `lilith/pi-extension` 作为可执行权限层启用到真实 Pi runtime；应先把 policy 编译为实现或测试夹具，并补 `tool_call` + `user_bash` + custom tool 的回归用例。

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 1 | 补出 Pi permission policy 可被 Set-Content/Out-File/user_bash/process.cwd 授权根绕过，且 validate-lilith 当前无法发现这些漂移
