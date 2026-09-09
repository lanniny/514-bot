# 514cc Console Desktop（Tauri 2 壳）

> LO 拍板（2026-07-17）：不整体 fork AionUI/codeg，**在自有 control-center 内核上自研桌面应用**，开源件按需抄零件。
> 壳保持极薄：UI 全部由 `apps/control-center` Web 面板提供，壳只管进程生命周期 + 原生窗口。

## 形态

```
514cc Console.exe（Tauri 2，~10MB）
  ├─ 启动：spawn node apps/control-center/server.mjs（本次空闲回环端口，CREATE_NO_WINDOW 隐藏控制台）
  ├─ 从内核 stdout 捕获单次 bootstrap URL → 原生窗口导航（无地址栏，任务栏独立图标）
  ├─ 启动看门狗：60s 握手期限；握手前失败最多重试 2 次；窗口就绪另有 25s 期限
  ├─ 托盘：显示 / 隐藏 / 开机自启 / 退出；关闭窗口默认隐藏到托盘
  ├─ `ccswitch://v1/import`：原生接收后投递 `forge:ccswitch-deeplink` 页面事件
  ├─ 轻量模式：隐藏 WebView、保留本地内核与托盘；托盘/深链唤起时退出轻量模式
  └─ 退出：托盘「退出」才杀内核子进程；普通关窗不终止 supervisor
```

## 构建与运行

```powershell
cd apps/desktop/src-tauri
cargo build --release --locked --target-dir target/portable
# 独立候选目录，不替换正式 target/release/cc-desktop.exe
cd ../../control-center
node scripts/build-portable.mjs --desktop-exe=../desktop/src-tauri/target/portable/release/cc-desktop.exe --output=C:/Temp/514Bot-candidate
```

- 源码构建依赖 Rust toolchain 和 Node；便携运行使用随包 Node 22.23.2，仍需系统 WebView2 Runtime。AI CLI 与其登录态由用户自行配置，未附带开发机凭据。
- 启动页真源：`apps/desktop/ui/index.html`，由 Tauri `frontendDist` 嵌入；旧 `dist` 保留为历史本地产物，不再作为构建必需输入。
- 源码模式默认使用编译时仓库位置，`CC_ROOT` / `CC_NODE` 保留为开发覆盖；不再硬编码固定盘符。便携模式以 EXE 旁的 `514cc-bundle.json` 为标识，使用 `runtime/node.exe` 与 `resources/control-center`，不回退到开发机 Node。
- 便携模式数据默认位于 `%LOCALAPPDATA%/514Bot`：`workspace` 放配置与项目工作数据，`data` 放内核持久化，`logs` 放桌面日志。可用绝对路径 `CC_DATA_HOME` 指定包外目录；数据子目录的 junction/symlink 被拒绝。便携指程序可搬移，不表示数据默认保存在程序目录。
- 首次启动只原子补齐缺失种子文件，不覆盖已有配置。产品 Schema 位于包内 `resources/control-center/schemas/control-center`，始终跟随当前内核；旧用户目录中的 Schema 副本保留但不再参与便携校验。契约文件损坏/缺失或已识别便携布局丢失清单时拒绝配置提交，不回退到旧 Schema。数据目录需支持硬链接，标准 NTFS 已验证；exFAT、UNC 与超长路径仍需单独验收。核心 JSON 配置校验使用有界 Node 子进程，不要求系统 Python；高级 YAML/TOML/框架工具仍可能需要 Python。
- 图标源：`icons/`（gen_icon.py 生成，黑底玫瑰红 514，呼应暗夜玫瑰主题）。
- 开机自启只在用户点击托盘勾选项或显式调用 native command 后改变；构建/测试/普通启动不会写自启项。
- `ccswitch` 协议由安装包清单注册。运行时不会调用 `register_all()`，因此开发构建不会静默写注册表。
- Tauri 启动时显式使用无权限 capability。握手校验后，仅本次 `http://127.0.0.1:<port>/*` 的 `main` 窗口获得 11 项 native 和 5 项窗口权限；EOF/取消时追加同源 deny 撤权，禁止旧来源重新获权。能力文件是权限模板，不直接授予固定端口。

2026-09-06：便携候选及独立 QA 身份的真实 Windows WebView2 已验收。原生命令只读调用、窗口最大化/还原、错误回环来源 IPC 拒绝、资源不变和两代内核契约切换均有证据。它不是签名安装包或正式发布；干净机器安装、完整用户配置格式迁移及外部 CLI 全旅程仍待验收。共享实例锁由内核 `instance-lock` 核验存活/过期，桌面不根据锁内 PID 杀进程或删锁。

验证候选内核而不启动 GUI：`node scripts/qa-portable-runtime.mjs --bundle=<候选目录> --output=<报告.json>`，从 `apps/control-center` 运行。该流程使用隔离用户根、空 PATH 和受控测试模式，验证配置事务、重启持久化及资源哈希不变。

`514 Bot.exe --runtime-info` 会初始化数据目录并输出真实布局，然后退出，不启动窗口；它不是完全只读命令。自动化验证应先设置隔离的 `CC_DATA_HOME`。构建清单可核对完整性，但没有替代数字签名或来源信任。

`514 Bot.exe --application-info` 仅回报编译时 `identifier/productName/version`，不初始化数据目录或 GUI。真实原生验证先以 `TAURI_CONFIG` 构建独立 `cc.p514.console.qa.<suffix>` 身份，再将其 EXE 打入新的测试候选目录。不要将 QA EXE 替换到正式实例：

```powershell
# 在 src-tauri 中执行；当前 shell 的 TAURI_CONFIG 在结束后恢复。
$savedConfig = $env:TAURI_CONFIG
try {
  $env:TAURI_CONFIG = '{"identifier":"cc.p514.console.qa.native20260906","productName":"514 Bot Native QA"}'
  cargo build --release --locked --target-dir target/native-qa
} finally { $env:TAURI_CONFIG = $savedConfig }
# 打包上述 EXE 后，从 apps/control-center 验证：
node scripts/qa-desktop-native.mjs --bundle=C:/Temp/514Bot-native-qa --output-dir=C:/Temp/514Bot-native-proof
```

原生 QA 会显示隔离测试窗口，使用独立 HOME/用户数据/WebView 目录、无凭据环境白名单和不存在的 CLI 路径。其 CDP 仅在本次子进程启用。结束时只终止自己创建的测试进程树并验证内核/CDP 端口拒绝连接；这不证明正常退出链或所有系统后代进程均已审计。全局顶栏是窗口按钮唯一正常入口，旧无顶栏嵌入面仍保留后备按钮。

前端窗口行为由 `public/modules/desktop-window-chrome.js` 持有：可重复挂载/销毁、鼠标双击与触屏 Pointer Events 分流、Ctrl+R 和统一错误回调。Bot 审批快捷键独立在 `bot-approval-shortcuts.js`，仍只在原生宿主启用，并调用现有权威审批 resolver；不把原生窗口模块与审批权限混为一层。2026-09-06 已完成真实 WebView 标题栏鼠标双击、认证刷新和注入失败后的实际提示验证；物理拖动距离与真实触屏仍待专门验收。

## Native 契约

- 页面事件：`forge:ccswitch-deeplink`，`detail = { url, source: "native-desktop" }`。
- 早到事件队列：`globalThis.__FORGE_CCSWITCH_DEEPLINKS__`。Forge 加载后先订阅事件，再消费并清空队列。
- native commands 真源：`src/native-command-names.txt`，与 build-time AppManifest、动态 ACL 及 invoke_handler 的 11 项命令保持一致。
- lightweight strategy：`hide_webview_keep_kernel`。514cc 的一次性 bootstrap token 不允许安全销毁后无凭据重建 WebView，因此明确保留内核与 WebView 进程，不伪称与上游 destroy/recreate 策略等同。
- updater：`disabled_no_signed_514cc_release_endpoint`。当前没有 514cc 自有签名公钥和安全发布端点，未加载 updater 插件、未借用 cc-switch 的公钥或 GitHub endpoint，也不生成更新产物。

Rust 契约测试不会启动桌面应用，也不会修改注册表/开机自启：

```powershell
cd apps/desktop/src-tauri
cargo fmt -- --check
cargo test
cargo check
```

## Phase 2 落地状态（2026-08-30 核对）

1. ~~**会话聚合面板**~~ → **已落地**：Console 已聚合 13 源会话（Claude/Codex/Cursor/Kimi/Pi/bridge/Grok/OpenCode/Cline/OpenClaw/Hermes/CodeBuddy/Gemini），项目树统一呈现。
2. ~~**派工台**~~ → **已落地**：Bot Shell 默认入口 + 9 CLI adapter + approval-broker（fail-closed）+ 审批钉顶/Y·N 快捷裁决。
3. ~~**Settings 分域全配置**~~ → **已落地**：配置图谱 v42（validate→plan→apply→rollback 闭环）+ 远端配置编辑/同步面。
4. **原生通知**：审批请求 / 长任务完成走系统通知——**待实施**（完善总计划 W2.4）。
5. ~~**仪表盘接 .ai-shared 数据源**~~ → **已落地**：体系观测页（handoff 浏览/DELTA 时间线/route-gate 日志）+ bot 流 Artifact 出卡。
6. **打包分发**：2026-09-06 已有便携候选与隔离内核验收；签名安装包、安全更新链及正式发布尚未完成。

## Phase 3 候选（原 Phase 2+ 未尽项）
