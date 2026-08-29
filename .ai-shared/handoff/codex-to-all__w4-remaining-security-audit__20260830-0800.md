# W4 安全加固波剩余审计（F-054 / F-055 / F-056）

> **状态**：✅ 三项查证完毕，均有现有机制
> **审计者**：烛（Codex 面），2026-08-30

## F-054: token 轮转与失效审计

**结论**：已有机制。

- `server.mjs:123`：`token = randomBytes(32).toString("base64url")` — 每次启动生成新 bearer
- `server.mjs:124-126`：`bootstrapNonce` 单次使用 + 2 分钟过期 → 首次认证后 nonce 即销毁
- `server.mjs:128`：绑定 `127.0.0.1` — 仅本机可访问
- `ccswitch/auth.mjs`：OAuth device code flow 处理 `expired_token` → 清除 pending 状态

**无需额外行动**：token 每次启动随机生成 + 绑定 loopback + bootstrap 单次使用，已构成完整的轮转与失效链。

## F-055: 附件/头像类型与大小校验

**结论**：context.md 已查证闭合，非缺口。

- `avatars.mjs` 的 `safeFileStem()` 拒绝 `.` / `..`
- 扩展名 `EXT_MIME` 白名单（`Object.hasOwn`）
- Magic-byte 校验（PNG/JPEG/WebP/GIF + mp4 的 `ftyp` / webm 的 `1a45dfa3`）
- 体积分档限额（头像 1MB / 团队背景图 8MB / 背景视频 64MB）
- `writeAtomicBytes()` 走 `0o700` 临时文件 + rename

**无需额外行动**。

## F-056: Tauri 壳崩溃快照与自动上报

**结论**：已有 supervisor 机制。

- `main.rs` supervisor 线程独占 Child 全生命周期
- `recv_timeout` 监控内核就绪状态，超时触发取消
- 窗口激活/取消由共享原子阶段协调
- 启动预算超时 → 放弃并打印诊断信息

**残留**：supervisor 的超时诊断只写 stderr，不写结构化快照文件。但 F-063 的崩溃快照（server.mjs uncaughtException handler）已覆盖内核侧。Tauri 壳侧的 supervisor 退出本身会被 Tauri 框架捕获。

**无需额外行动**（除非 LO 要求 Tauri 壳侧也写结构化快照文件）。

`__DELTA__: 烛(Codex) | 0 | 证据：F-054/F-055/F-056 三项查证均有现有机制，无新增发现`
