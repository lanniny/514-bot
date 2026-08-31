<!-- 514cc-session-id: 019f8514-65ba-7082-a21f-e60d6eccf620 -->

# 致命问题

- 已闭合桌面启动取消竞态。`apps/desktop/src-tauri/src/main.rs:143` 使用偶数/奇数 visibility epoch，只接受同一稳定偶数代内完成的 hide 凭证；`apps/desktop/src-tauri/src/main.rs:228` 在 show 前后推进 epoch，防止早到 hide 被迟到 show 覆盖。
- 已闭合 watchdog/EOF 活性问题。取消路径先原子发布意图并使用 `try_lock`，不再等待可能卡住的 PageLoad 可见性临界区；监督线程可以继续发送终止事件并清理内核树。
- 已闭合多 canceller 完成结果丢失。ActivationOwner release 与 rollback credential 形成 SeqCst 双向握手；一方 hide 失败、另一方成功时不再永久停留于 `Cancelling`。
- 第五轮独立只读复核结论为 `__VERDICT__: APPROVED`，当前 `main.rs` SHA-256 为 `A475FD7601B52F5FFD52BAF2F159E8BC1164CC20E928D6D9A94E7B21C6890C9C`。

# 建议改进

- P3 非阻断：后续可补真实 Tauri/Windows 事件循环集成测试，覆盖 `PageLoadEvent::Finished` 执行期间由后台线程取消。当前单元测试验证状态机与无等待边界，Wry 的非 UI `hide()` 成功语义仍是“事件已派发”，不是该瞬间 HWND 已完成隐藏。
- 严格 delta 性能门在测量前调用 `page.requestGC()` 并等待 50ms；阈值仍保持 `>50ms` 失败，未通过放宽标准消除抖动。

# 可保留

- 514 Forge 品牌化 IDE 工作台、活动栏、协作台、检查器、状态栏、明暗主题和四档响应式布局均通过完整 Playwright 套件。
- 卡顿治理保持全局事件窗口 160 条/40 MiB、会话 DOM 160 条、NDJSON 流式历史、有界缓存、`scheduler.yield()` 与 MessageChannel 回退。
- 完整 UI QA 通过：连续 delta 桌面/移动各 30/30、0 次会话 DOM 提交、0 long task；5000 事件历史最多 160 个消息 DOM；4,194,417 字符载荷无 long task、无密钥泄露。
- Control Center `npm test`：269 tests，268 passed，0 failed，1 skipped；`npm run validate`：12/12 配置与治理检查有效；Rust：13/13；`cargo fmt --check`、`node --check`、目标文件 `git diff --check` 均通过。

# 总评

- release 构建成功，二进制 SHA-256 为 `B7D7D991CD756CD477EA2BA3D725034A5936E1D2793424A77FF943F90789CB87`。
- 新桌面壳 PID `53144`、Node 内核 PID `65600`，创建时间均为 `2026-07-23 08:38:04`；`127.0.0.1:51400` 返回 HTTP 200，延迟复查仍存活且 `Responding=True`。
- stderr 日志记录 `console window activated: hwnd=HWND(0x3570e72) visible=true`；在桌面交互会话中直接调用 Win32 得到 `IsWindow=True`、`IsVisible=True`、owner PID `53144`，不是仅依据日志声明显窗。
- 当前桌面端已启动，可继续使用；未执行 commit、push 或 runtime sync。

__DELTA__: 烛(Codex) | 2 | 证据：apps/desktop/src-tauri/src/main.rs:143,228,555,614,648,683 的独立复核连续推翻提前收口判断，并补齐无等待取消、epoch hide 凭证和多 canceller 交接协议
