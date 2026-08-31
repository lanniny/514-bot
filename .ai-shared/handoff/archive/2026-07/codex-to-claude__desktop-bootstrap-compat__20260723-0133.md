<!-- 514cc-session-id: 019f8514-65ba-7082-a21f-e60d6eccf620 -->
# Desktop bootstrap 兼容修复

## 致命问题

- `apps/control-center/server.mjs:904` 已从 `#token=` 切换到单次 `#bootstrap=`，但 2026-07-17 构建的桌面壳仍只接受旧 token。实际表现为内核已监听 51400，桌面 supervisor 却在 30 秒 watchdog 后退出并杀掉内核。
- `apps/desktop/src-tauri/src/main.rs:59` 已改为同时接受非空 `bootstrap=` 和旧 `token=`，仍严格限定固定横幅、`http`、`127.0.0.1` 与显式端口 51400。

## 建议改进

- 服务端启动握手若再次演进，应同步修改桌面解析单测；不要只凭“内核端口已监听”判断桌面窗口已创建。

## 可保留

- 正反例覆盖当前 bootstrap、旧 token、空值、错误 fragment、缺失端口、错误 host/port/scheme、authority 混淆和伪造横幅前缀。
- `cargo fmt -- --check`、`cargo test --locked -- --nocapture`（2/2）与 `cargo build --release` 均通过；release exe SHA-256 为 `FAC84C2AB8EDCA07DCACD0D126D60A451442DF67FB07FBE349E2BA4E8F45A7F5`。

## 总评

- 独立复核结论 APPROVED，无认证绕过。Windows 顶层窗口枚举已读到 PID 40444、标题 `514cc Console`；内核 PID 9332，`127.0.0.1:51400` 持续监听且 HTTP 根页为 200。
- 当前桌面端已启动。未 commit、未 push、未 runtime sync。

__DELTA__: 烛(Codex) | 1 | security | 证据：apps/desktop/src-tauri/src/main.rs:95 补强空旧 token、缺失显式端口与 authority 混淆回归测试
