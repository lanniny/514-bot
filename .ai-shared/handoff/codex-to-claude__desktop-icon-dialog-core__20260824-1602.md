<!-- 514cc-session-id: 01a02e6c-852d-79c1-b005-637f42ba18aa -->
# 桌面端图标切换：514 对话核

## 结果

- LO 选定候选 01「对话核」：深墨圆角底、白色对话框、三位成员品牌色圆点和绿色在线状态点。
- 新增可维护矢量真源 `apps/desktop/src-tauri/icons/icon.svg`。
- 已替换 `icon.png`、`128x128.png`、`32x32.png`、`icon.ico`；未改 `tauri.conf.json`，现有 bundle 配置继续消费 `icon.ico` 与 `icon.png`。

## 验证

- Chromium 透明光栅化：512 / 256 / 128 / 64 / 48 / 32 / 24 / 16px 均生成并视觉回读。
- `ffprobe` 回读正式 ICO：7 个 RGBA PNG 条目，尺寸为 16 / 24 / 32 / 48 / 64 / 128 / 256px。
- 独立视觉复核发现首版 16px 四角残留 alpha 1/12；已将 alpha < 16 的近透明像素归零后重新生成 ICO，四角 alpha 均为 0。
- 隔离 release 构建：`cargo build --release` 成功，产物位于 `%TEMP%/514cc-desktop-icon-build/release/cc-desktop.exe`。
- Windows `System.Drawing.Icon.ExtractAssociatedIcon()` 从隔离 EXE 提取到 32x32 新图标，四角 alpha 为 0；最终 EXE SHA-256 为 `AA5BDC6368A52201AB8BCD15BF2DFBCC23F67860554C3968A2248BDE1B464D11`。
- `git diff --check -- apps/desktop/src-tauri/icons` 通过。

## 正式激活

- LO 明确确认后，结束旧桌面 PID `25736` 及其子进程树；结束前旧实例无窗口且 `51400/9223` 均无监听。
- 旧正式 EXE 已备份到 `%TEMP%/514cc-desktop-icon-build/cc-desktop.before-dialog-core.20260824-1607.exe`。
- 已用隔离验证过的 release 产物替换 `apps/desktop/src-tauri/target/release/cc-desktop.exe`；正式文件 SHA-256 与隔离产物一致，均为 `AA5BDC6368A52201AB8BCD15BF2DFBCC23F67860554C3968A2248BDE1B464D11`。
- 新正式实例 PID `23180`，内核 PID `41992` 监听 `127.0.0.1:51400`；根页 HTTP `200`，标题为 `514 Bot`。
- 窗口曾进入托盘隐藏态；再次启动同路径 EXE 后，第二实例干净退出 `0`，single-instance 回调恢复主窗口。随后 20 秒、250ms 间隔采样中，句柄 `48958432` 全程可见且非最小化。
- 可见 Tauri 窗口未暴露 `WM_GETICON` / class icon handle；显式回退到 `SHGetFileInfo` 查询正在运行的正式 EXE，返回 32x32 新「对话核」图标，四角 alpha 为 0。
- 最终收尾回读时窗口再次处于托盘隐藏态（`MainWindowHandle=0`），但 PID `23180`、正式 hash、内核监听与 HTTP `200` 均保持正常；这与仓库既有“关闭窗口默认隐藏到托盘”契约一致，不记为崩溃或启动失败。

## 边界

- 未取得物理任务栏截图；实时图标证据为正式 EXE 资源提取、运行路径 hash、Windows Shell `SHGetFileInfo` 回读和可见窗口四层，不把 `WM_GETICON` 失败包装成成功。
- Windows 已固定到任务栏的旧快捷方式若保留独立图标缓存，仍可能需要取消固定后重新固定；当前 Shell 查询已返回新图标。
- 未执行 `git commit` / `git push`，未清理工作区其他协作者改动。

__DELTA__: 烛(Codex) | 1 | observability | 证据：`apps/desktop/src-tauri/icons/icon.svg:1`、`apps/desktop/src-tauri/icons/icon.ico`；独立复核发现并修正 16px 四角近透明抗锯齿残留，避免浅色任务栏出现极淡方角。
