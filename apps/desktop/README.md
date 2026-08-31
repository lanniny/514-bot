# 514cc Console Desktop（Tauri 2 壳）

> LO 拍板（2026-07-17）：不整体 fork AionUI/codeg，**在自有 control-center 内核上自研桌面应用**，开源件按需抄零件。
> 壳保持极薄：UI 全部由 `apps/control-center` Web 面板提供，壳只管进程生命周期 + 原生窗口。

## 形态

```
514cc Console.exe（Tauri 2，~10MB）
  ├─ 启动：spawn node apps/control-center/server.mjs（端口 51400，CREATE_NO_WINDOW 隐藏控制台）
  ├─ 从内核 stdout 捕获单次 bootstrap URL → 原生窗口导航（无地址栏，任务栏独立图标）
  ├─ 看门狗：30s 拿不到 URL（端口冲突/instance-lock/崩溃）→ 退出不悬挂
  ├─ 托盘：显示 / 隐藏 / 开机自启 / 退出；关闭窗口默认隐藏到托盘
  ├─ `ccswitch://v1/import`：原生接收后投递 `forge:ccswitch-deeplink` 页面事件
  ├─ 轻量模式：隐藏 WebView、保留本地内核与托盘；托盘/深链唤起时退出轻量模式
  └─ 退出：托盘「退出」才杀内核子进程；普通关窗不终止 supervisor
```

## 构建与运行

```powershell
cd apps/desktop/src-tauri
cargo build --release          # 产物 target/release/cc-desktop.exe
.\target\release\cc-desktop.exe
```

- 依赖：Rust toolchain + WebView2（Win11 自带）+ node（内核）。
- 仓库根默认 `I:\514claude\514cc`，迁移时用环境变量 `CC_ROOT` 覆盖。
- 图标源：`icons/`（gen_icon.py 生成，黑底玫瑰红 514，呼应暗夜玫瑰主题）。
- 开机自启只在用户点击托盘勾选项或显式调用 native command 后改变；构建/测试/普通启动不会写自启项。
- `ccswitch` 协议由安装包清单注册。运行时不会调用 `register_all()`，因此开发构建不会静默写注册表。
- Tauri remote capability 只允许 `main` 窗口中的 `http://127.0.0.1:51400/*` 调用显式登记的 native commands；命令清单由 `src/native-command-names.txt` 同时驱动 build-time AppManifest，并由 Rust 回归检查 capability 与 `invoke_handler` 不漂移。

## Native 契约

- 页面事件：`forge:ccswitch-deeplink`，`detail = { url, source: "native-desktop" }`。
- 早到事件队列：`globalThis.__FORGE_CCSWITCH_DEEPLINKS__`。Forge 加载后先订阅事件，再消费并清空队列。
- native commands：`get_native_capabilities`、`get_auto_launch_status`、`set_auto_launch`、`enter_lightweight_mode`、`exit_lightweight_mode`、`is_lightweight_mode`。
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
6. **打包分发**：未落地——bundle 保持 dev 形态直接跑 exe；依赖 W3.16 签名更新链（minisign + 静态端点）先行。

## Phase 3 候选（原 Phase 2+ 未尽项）
