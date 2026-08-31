# Codex 评审：514cc Console 桌面壳 main.rs（对话桥 DL 模式，R1-R4 同会话六轮）

- **评审模式**：architecture / 进程生命周期
- **评审范围**：apps/desktop/src-tauri/src/main.rs（Tauri 2 壳，spawn 内核/抓 URL/开窗/清理）
- **评审时间**：2026-07-17 10:55 ~ 11:25
- **驱动方式**：**MCP 对话桥**（codex-agent，threadId 019f6dda-6349-7c82-8f1c-947f26ff0996）——R1→R4 六轮同会话往返，Codex 全程保留上下文，无一轮冷启动。这是 v3.5 对话桥的首个完整实战 dogfood。
- **Codex 模型**：gpt-5.6-sol（xhigh）

---

## 演进轨迹（对话桥价值实证）

| 轮 | 裁决 | 净发现 |
|----|------|--------|
| R1 | CHANGES_REQUESTED | 4 致命：①Child::kill 不杀进程树（Windows 留孤儿 node）②"读到 URL"误当"窗口已建成"（构建失败时看门狗已缴械）③无运行期监督 + 30s 看门狗检查-执行竞态 ④多 panic 路径泄漏内核（Child Drop 不杀进程） |
| R2 | CHANGES_REQUESTED | supervisor 重构后裁决：R1-2/3/4 闭环，R1-1 部分闭环——taskkill 失败→无界 wait→join 挂死是新致命；另给 strip_prefix/退出码语义/受控 shutdown/heartbeat 四建议 |
| R3 | CHANGES_REQUESTED | 收窄：Command::status() 等 taskkill 本身也无界；exit 意图应在 ExitRequested 提早置位；try_wait Err 不可静默当已回收 |
| R4 | **SECURE** | 三点全通过，无阻塞级剩余。非阻塞降级如实标注（taskkill helper 可能残留 / 全失败时内核可能存活="停止追踪"非"OS 收拾"，已改注释） |

## 最终架构（R4 认可）

单一 supervisor 线程独占 Child + mpsc 事件状态机（UrlFound/StdoutEof/WindowBuilt/Shutdown 单线程判定）；清理全程有界（taskkill fire-and-forget spawn + reap_within 5s→fallback kill→2s→如实放弃）；stdout 读至 EOF 作运行期死亡信号；握手行 strip_prefix + scheme/host/port/token 四重校验；exit_requested 在 ExitRequested 提早置位堵退出码竞态。

## 回归证据

三轮 CloseMainWindow 关窗实测（v1 后 / R2 修后 / R3 修后）：shell/kernel/port 三清 PASS。R2 轮同时验证 v1 确会留孤儿（手动清理过一次）。

## 遗留（非阻塞，Phase 2）

- 受控 shutdown（HTTP/IPC 先行，限时后强杀）——避免截断内核持久化写入
- heartbeat/health check——EOF 只能发现死亡，不能发现"活着但事件循环卡死"
- 非 Windows 分支仍只杀直接子进程（本机 Windows-only，如实标注）

__VERDICT__: SECURE
__DELTA__: 烛(codex-reviewer, 对话桥R1-R4) | 2 | 推翻主驾"v1 壳可用"判断——R1 照出 4 个进程生命周期致命（孤儿 node/看门狗缴械/竞态/panic 泄漏），驱动 supervisor 状态机重写；R2/R3 又两轮收窄有界性缺口（无界 wait/status/退出码竞态）；主驾在进程生命周期上有稳定盲区，异构六轮收敛至 SECURE
