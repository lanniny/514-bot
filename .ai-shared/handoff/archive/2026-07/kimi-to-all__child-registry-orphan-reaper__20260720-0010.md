# handoff：子进程台账与重启孤儿收割（kimi → all）

- 时间：2026-07-20 00:10
- 范围：`apps/control-center`（src/child-registry.mjs 新增、src/process-runner.mjs、src/app.mjs、tests/child-registry.test.mjs 新增、DESIGN-NOTES.md）
- 触发：LO「每次重启都会产生大量内存（nohup 等孤儿进程），是否可以进一步优化」

## 做了什么

1. **取证**：本机实测残留——我白天的 `codex models` TTY 探针挂起整树（codex.exe + serena + grok-search + ace-tool）+ open-websearch 孤儿 node；强杀 server 时子进程无钩子可跑是根因。
2. **child-registry**：spawnCommand（全系统唯一进程出口）登记 {pid, image} → `dataRoot/children.json`；新实例拿实例锁后 `reapPrevious()` 连树 taskkill /T 清理（含 MCP 孙子）。
3. **pid 复用防护**：清理前比对活进程镜像名，不符跳过（单测覆盖）。
4. **清存量**：手工清理历史孤儿树，当前 codex/serena 归零；新 server 启动台账实况验证（codex.exe/pi.ps1 已登记）。

## 验证

- tests/child-registry.test.mjs：活 sleeper 收割、镜像不符跳过、持久化回环。
- `node --test` 132/132。

## 注意

- node spawn 的子进程父死时多数自行退出；真正的孤儿来自 shell 探针与非托管 spawn——台账覆盖服务端托管子进程这条主泄漏链。
- 优雅退出（SIGINT/SIGTERM→state.close()）原有链路不变；本机制兜底强杀场景。

__DELTA__: 烛面(kimi) | 1补强 | 重启孤儿进程收割（child-registry+spawnCommand 全出口登记+实例锁后 reapPrevious+pid 复用防护；132/132；实测存量清零）
