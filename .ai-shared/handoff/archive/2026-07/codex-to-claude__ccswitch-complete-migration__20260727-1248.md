<!-- 514cc-session-id: 019fa017-874a-7602-9799-c53d29bf9e38 -->
# CC-Switch 3.18.0 完整迁移收口

- 日期：2026-07-27 12:48 +08:00
- 上游审计源：`.scratch/cc-switch/cc-switch-3.18.0/`
- 注册表 SHA-256：`50f6b4ec0c072d70d1cc2d7c3d811f68f15e9fa9b8e7c734fbc8f8c5a7d82c6c`
- 能力账本：288 入口 = 157 equivalent + 128 adapted + 3 blocked_external_trust
- 决策：`D-2026-07-27-001`

## 致命问题

1. 原“全部能力落地”缺少逐命令真源核对。现由 `apps/control-center/src/ccswitch/capability-map.mjs:5` 固定上游哈希与 287 个 namespaced commands，`apps/control-center/scripts/validate-ccswitch-migration.mjs:131` 在上游树存在时核验哈希/数量/覆盖，同时回归无 `.scratch` 场景。账本明确保留 3 个 updater 外部信任阻断，见 `proposals/ccswitch-3.18.0-capability-ledger.md:82`。
2. Kimi 初版 usage script 可在主进程 `node:vm` 中形成 constructor/同步死循环风险。现由 `apps/control-center/src/provider-net.mjs:296` 启动一次性 Worker，使用 `env:{}` 与资源限制；`apps/control-center/src/usage-script-worker.mjs:7` 禁止字符串/WASM 代码生成，父进程超时负责终止。
3. 桌面壳虽注册 11 个 native commands，但 Control Center 来自 remote origin，原 `capabilities.json=[]` 导致实机全部返回 `not allowed. Plugin not found`。现由 `apps/desktop/src-tauri/build.rs:2` 的单一命令清单生成 AppManifest，`apps/desktop/src-tauri/capabilities/ccswitch-native.json:3` 只授权 `main` + 精确回环 URL 且 `local=false`；`apps/desktop/src-tauri/src/native.rs:711` 防止 capability/handler 漂移。
4. Forge 后置 CSS 曾覆盖移动端网格，390px 主区只剩约 192px；面板还引用 20 个未 vendored Lucide 图标。现移动布局在 `apps/control-center/public/forge/shell.css:532` 恢复单列，图标 manifest 契约和 `vendor-lucide.mjs` 使 125 symbols / missing=0。

## 建议改进

1. 建立 514cc 自有签名发布端点、公钥轮换和回滚设计后，再把 `install_update_and_restart / check_app_update_available / check_for_updates` 从 `blocked_external_trust` 转为实现；此前保持禁用。
2. 跟踪或替换 `exceljs@4.4.0`。2026-07-27 官方 registry 审计为 11 high + 1 moderate，直接入口 `exceljs` 无 fix；禁止直接 `npm audit fix --force`。
3. 保留 `validate:ccswitch` 的“有 scratch 强验真、无 scratch 不偶然失效”双路径，以及 Tauri remote capability 精确 URL/命令漂移测试。

## 可保留

1. 组合式架构合理：不 fork 上游，用 514cc Control Center 承载 ProviderStore、代理、领域资源、同步、账户与 workspace；`apps/control-center/src/providers.mjs:14` 的八应用清单贯穿 writer、排序、认亲和团队绑定。
2. 深链采用“原生 FIFO 投递 + 页面自动预览 + 用户确认后导入”，不会因协议唤起直接写配置。实机第二实例携带 A/B 两条无凭据链接，首实例 PID/内核 PID 不变，最终页面显示 B 预览。
3. 轻量模式诚实标记为 `hide_webview_keep_kernel`：实测进入后窗口不可见但进程、WebView 与 HTTP 200 保持；退出后窗口在 2 秒和 6 秒均稳定可见。
4. UI 最终 QA 位于 `apps/control-center/.qa-output/ccswitch/`：10 张明暗/桌面/移动最终截图、深链 FIFO 桌面截图、Rust/npm/审计日志均已读盘。

## 总评

结论：**CC-Switch 3.18.0 在 514cc 自有边界内完成迁移并通过实机收口**。这不是声称上游二进制 1:1 复制，而是 288 入口逐项映射、可验证实现与 3 个外部信任阻断的完整账本。

当轮机械证据：

- `npm test`：555 tests，554 pass，0 fail，1 opt-in skip。
- `npm run validate`：13/13，`registryVerified=true`。
- CC-Switch + ProviderStore/网络/Worker 安全定向：74/74。
- Node syntax：113 checked / 0 failed。
- `cargo test`：21/21；`cargo fmt -- --check`、debug build、release build 通过。
- release：`apps/desktop/src-tauri/target/release/cc-desktop.exe`，10,508,288 bytes，SHA-256 `35D085B9681C943CE2EF5BB9BC0BD862AE6CB5E5EBB41BABB6828D0F56148594`。
- 启动验收态：release PID `29120`，Node PID `51072`，窗口句柄 `922480`，标题 `514 Forge · Control Center`，HTTP 200，CDP `9223` 未监听。工具承载环境结束可见 GUI 命令时会触发 CloseRequested，应用随后按设计驻留托盘；当前 PID 与 HTTP 仍存活，不能把启动时句柄冒充当前句柄。
- npm audit（官方 registry）：12 项 = 11 high + 1 moderate；未强制修复。

独立 sidecar 状态：`ccswitch_app_writers / ccswitch_desktop_native / ccswitch_frontend_complete` 均因 `403 Forbidden: Insufficient account balance`（`https://514claude.xyz/v1/responses`）失败，未伪造其结果；主线程改用本地源码、测试、CDP 与 Win32 证据完成复核。

__DELTA__: 烛(Codex) | 2 | architecture | 证据：原“全部能力落地”被 287-command 盘点、ProviderStore 覆盖风险与 node:vm 逃逸共同推翻
