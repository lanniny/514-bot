---
agent: 烛
mode: security+correctness
topic: native-cli-path-config
scope: runtime-executable-dirs, pty, native-commands, orchestrator, composer slash, config topology
reviewed_at: 2026-08-20 03:15
codex_channel: cursor-subagent
---
<!-- 514cc-session-id: 56cad97f-126c-4219-8c6e-fde0dd3cc56e -->

# Codex 评审：协作台原生命令 / PTY PATH / 配置图谱

- **评审模式**：security + correctness
- **评审范围**：`apps/control-center/src/runtime-executable-dirs.mjs`、`pty.mjs`、`adapters/native-commands.mjs`、`orchestrator.mjs`、`public/app.js`、配置图谱 HTML/CSS
- **评审时间**：2026-08-20 03:15
- **Codex 模型**：Cursor `codex-reviewer` subagent（MCP `codex-agent` 本会话未注册）
- **总 token**：n/a

---

## 致命问题（必须改）

无。未知 slash 服务端 fail-closed；Codex `/compact` 在 `nativeCommand` 下走 `compactThread`；operator/自动 compact 与 `send` 前都有 `assertRemoteDispatchable`；配置搜索/选中不写 live。

---

## 建议改进（值得讨论）

1. **PATH 按存在的目录前置**（`runtime-executable-dirs.mjs`）：只确认目录存在，不校验目标二进制。`~/.grok/bin` 里若放了同名 `git.exe`/`codex.exe` 会阴影系统 PATH。这是 Explorer 陈旧 PATH 的刻意折中；更窄的做法是只给 grok/kimi 解析回退，不改整段 spawn PATH。
2. **（已焊）** 未知 `adapter-hook` 不得掉进 `adapter.send`；`/compact leftover` 拒绝额外参数；catalog 原生命令必须 `context.memberId === agentId`。

---

## 可保留（看似奇怪但合理）

- `defaultShell` 不走合成 PATH，避免测试与默认壳被 grok 目录劫持。
- `native-commands` 列入 `NON_ADAPTER_MODULES`：它不是工厂适配器。
- PTY 给交互壳合成 PATH：这正是终端里 `grok` 找不到的根因修复。

---

## 总评

主驾合同成立。烛第一轮 CHANGES_REQUESTED 的契约缺口（未知 hook fail-open、extra-args、catalog 成员错绑）已在同会话焊回 fail-closed。PATH 阴影面保留为显式权衡，等 LO 觉得值得再收窄。

`__VERDICT__: APPROVED`（焊回后；PATH 阴影面不升格为阻断）

__DELTA__: 烛(Codex) | 1 | 证据：runtime-executable-dirs.mjs PATH 目录级前置可阴影裸名；native-commands.mjs 未知 adapter-hook 与 /compact 额外参数改为 fail-closed；app.js catalogNative 要求 memberId 对齐
