<!-- 514cc-session-id: 01a02e6c-852d-79c1-b005-637f42ba18aa -->
# Bot 成员设置正式桌面激活交接

## 结果

正式桌面端已切换到当前 Bot 成员界面。当前可见桌面进程为 PID `26164`，其自管 Control Center Node、`127.0.0.1:51400` 监听和实例锁 PID 均为 `10396`；锁的 `dataRoot` 是正式目录 `I:\514claude\514cc\.ai-shared\control-center`。

临时预览 PID `2488` 已停止。确认失效的锁全部移动到 `.ai-shared/backups/control-center-stale-lock-*`，未直接删除。

## 关键诊断

1. 非提权进程探针受 Windows 沙箱可见性影响，曾错误显示 PID `2488` 和端口不存在；提权只读回读确认它仍占用 `51400`。后续端口与进程身份均在同一权限层复核。
2. 两次正式启动尝试分别因 `EADDRINUSE` 退出并留下锁；致命日志位于 `apps/control-center/.scratch/control-center-fatal.log`。停止临时预览并归档失败锁后，正式实例可正常启动。
3. 桌面源码 `apps/desktop/src-tauri/src/main.rs:397` 的 `spawn_kernel()` 与 `:954` 的 `supervisor()` 表明桌面壳总会自行启动内核，不存在连接已有 `51400` 的分支。因此最终关闭手工 Node，由 `cc-desktop.exe` 自管正式内核。

## 运行态证据

- 桌面 PID：`26164`
- 桌面窗口句柄：`4394202`，恢复后 `1456x929`，可见。
- 桌面 Node / listener / lock PID：`10396`
- 正式数据根：`I:\514claude\514cc\.ai-shared\control-center`
- HTTP：`200`；存在 `bot-member-runtime-profile`、`bot-settings-member-list`、“成员设置”；不存在可见“代理设置”。
- 真实窗口直出截图：`%TEMP%/514cc-bot-member-settings-qa/desktop-live-printwindow.png`，显示动态 9 人成员目录与新 Bot 对话壳。

## API 与交互证据

在切换桌面自管内核前，使用同一正式数据根和当前源码完成一次性 bootstrap Playwright 验收：

- `GET /api/team-members`：`200`，9 位成员。
- 设置 -> 成员 -> 编辑第一位成员：成员设置面板可见，运行席位选择器有 8 个选项。
- `#view-bot` 可见，旧 `#view-team` 不可见。
- console/pageerror 为空。
- 截图：`%TEMP%/514cc-bot-member-settings-qa/bot-member-settings-formal-desktop.png`。

本轮只读正式成员数据，没有执行 PUT/POST/DELETE；隔离环境中的真实 PUT 验证仍见前序 handoff `codex-to-claude__bot-member-settings__20260824-0132.md`。

## 边界

- 普通屏幕截图被前台全屏应用遮挡，已作废；最终证据使用目标句柄 `PrintWindow`，不包含其他前台内容。
- 尝试用坐标打开桌面设置时窗口被前台应用抢占并最小化，因此该点击不记为通过；窗口已恢复到可见位置。设置交互由正式浏览器会话验证，桌面壳由真实动态目录和窗口截图验证。
- focused Node TAP 汇总后不退出的既有缺口不因本轮运行态激活而关闭。
- 未执行 `git commit` / `git push`。

__DELTA__: 烛(Codex) | 1 | 证据：`apps/desktop/src-tauri/src/main.rs:397`、`apps/desktop/src-tauri/src/main.rs:954` 补足桌面必须自管内核的契约，并据此完成正式桌面切换，避免手工 Node 与桌面重复占用 `51400`。
