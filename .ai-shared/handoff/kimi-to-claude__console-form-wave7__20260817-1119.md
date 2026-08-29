<!-- 514cc-session-id: 122f11cb-a2b3-4792-b0e4-ec0a1abb256a -->
# Kimi → Claude：控制台形态收敛层·第七轮（窗口框与 topbar 合一）

2026-08-17 · 执行：Kimi(514cc-cli) · 触发：LO 供图（Codex 桌面合一横带 vs 本机双横条红圈）

## 改了什么

- `apps/desktop/src-tauri/src/main.rs`：`WebviewWindowBuilder` 链加 `.decorations(false)`，去掉原生标题栏。
- `apps/desktop/src-tauri/capabilities/window-chrome.json`（新文件）：五条 `core:window` 权限独立落此——ccswitch-native 的权限集被 native.rs 回归锁死与 invoke handler 精确相等，平台权限混入会炸精确匹配。
- `apps/control-center/public/index.html`：topbar-actions 末尾新增 `.window-controls`（默认 hidden），三钮 id `window-minimize/window-maximize/window-close`，图标 minus/square/x。
- `apps/control-center/public/app.js`：新增 `initializeWindowChrome()`（定义在 initializeTheme 前、调用紧随其启动调用后）；cacheElements 登记四个新 id。
- `apps/control-center/public/forge/console-form.css`：第七轮区块——`is-desktop-shell` 下 `--topbar-height: 44px`、窗口钮样式（关闭 hover 用既有 --rose-bright）、拖拽区 user-select 控制。
- `apps/control-center/scripts/vendor-lucide.mjs`：清单补 `minus`，重生成 sprite（135→136）与 manifest。

## 关键决策

- **拖拽不用 `data-tauri-drag-region`**：壳内注入脚本对子元素的命中判定随 Tauri 版本漂移；改在应用层 mousedown 手动判定（排除 button/a/input/select/textarea/.topbar-nav/.topbar-actions），detail===2 双击 toggle_maximize。语义可测可演。
- **浏览器模式优雅回退**：无 `__TAURI_INTERNALS__` 直接早退，三钮保持 hidden；旧壳（未重建）下三钮与原生栏并存只是冗余，不致命。
- **浏览器基线 52px 不动**：`--topbar-height` 现状归 `forge/codex-desktop.css:9` 所有；44px 收敛只作用于 `is-desktop-shell`。

## 验证

- 新契约 `apps/control-center/tests/window-chrome-contract.test.mjs` 7/7。
- 实机探针 `apps/control-center/.scratch/verify-wave7-chrome.mjs`：双实例（bootstrap nonce 一次性，51484/51485 各一实例）；浏览器回退 + 桥桩模拟壳共 12 项断言全过；截图 `apps/control-center/.qa-ui-wave7/chrome-{light,dark}.png`。
- `cargo check` + `cargo test`（21/21，含 ccswitch-native 精确匹配回归）通过。
- 全量 `npm test`：1363 测试 / 1362 pass / 0 fail / 1 skipped（基线 1356 + 本轮 7）。
- 编年：`apps/control-center/DESIGN-NOTES.md` 末尾第七轮条目。

## LO 须知

- **窗口装饰变化要重新构建桌面端**（`apps/desktop`）才生效；网页资产改完重启 Control Center 即可看到三钮。
- 范围限定：本轮只合并顶部双横条；topbar 主导航与左栏重复的 IA 问题未动。

## 追加（同日）：壳内 Ctrl+R 热重载

LO 反馈"桌面端没看到改动"——静态资源 no-store + 每请求读盘，服务端无缓存；唯一滞后层是 WebView 里已加载的旧页面，而壳没有刷新键。查实登录态兑换后存 sessionStorage，reload 安全。`initializeWindowChrome` 新增壳内 Ctrl+R → `location.reload()`（浏览器模式不受影响），探针 `.scratch/verify-wave7-reload.mjs` 实证重载后 badge 回 is-ok、壳形态与窗口钮恢复。**此后网页资产迭代，壳内 Ctrl+R 即生效**；本轮 LO 需从托盘退出重开一次（内核会被杀，进行中的会话走恢复流程接续）。

__DELTA__: Kimi(514cc-cli) | 1 | correctness | 证据：apps/control-center/public/app.js:1140 initializeWindowChrome 手动拖拽语义补齐窗口框合一，探针 12 断言全绿
