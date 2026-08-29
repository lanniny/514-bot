# Codex 修复：514cc governance polish

- **任务**：补齐上一轮 Lilith/514cc 审查中剩余的治理面建议
- **时间**：2026-06-17 21:38 +08:00
- **范围**：Codex stop-gate、Claude runtime sync script
- **结果**：已修复；未执行 runtime Apply

---

## 改动摘要

1. `.codex/hooks/stop-gate-codex.py`
   - seen key 从 `path.name` 改为 `session_id:path.name`。
   - 与 Claude stop-gate 的 “每个 (session, 文件) 只 block 一次” 语义对齐。
   - 保持 fail-open。

2. `scripts/sync-runtime.ps1`
   - `-Apply` 前创建 `.ai-shared/backups/claude-runtime-{YYYYMMDD-HHmmss}/`。
   - 仅备份本次 drift 中已经存在的目标文件。
   - 保持默认 check 模式不写盘。

## 验证

```text
python -m py_compile .codex/hooks/stop-gate-codex.py
```

通过。

```text
& I:\514claude\514cc\scripts\sync-runtime.ps1
```

输出 15 对双地落一致，未执行 `-Apply`。

stop-gate isolated simulation：

```text
s1=2
s1=0
s2=2
{"seen":["s1:codex-to-claude__probe__20990101-0000.md","s2:codex-to-claude__probe__20990101-0000.md"]}
```

说明同一 session 只拦一次，不同 session 会再次拦截同一个缺 DELTA handoff。

## 剩余边界

- `sync-runtime.ps1 -Apply` 的备份逻辑已加，但本轮没有实际执行 Apply，因此没有创建真实 runtime backup。
- Codex/OpenCode external comparison adapters 仍未实现；Lilith 仍不得宣称 parity。

__VERDICT__: APPROVED
__DELTA__: 烛(Codex) | 1 | observability | 补齐 Codex stop-gate session-scoped seen 语义和 Claude runtime sync 备份缺口；py_compile、sync check、isolated stop-gate simulation 均通过。
