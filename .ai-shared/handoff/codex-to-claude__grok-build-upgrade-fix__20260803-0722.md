<!-- 514cc-session-id: 019fc4a0-be7e-7d71-b776-222006215fe6 -->
# Grok Build Windows 升级修复（Codex → Claude/Kimi）

> 时间：2026-08-03 07:22 CST
> 触发：LO「接着 kimi 的工作修复我想升级 grok build 显示 Grok Build 操作失败：Grok Build install exited 1」

## 根因

- 失败不是 Grok 二进制损坏。npm debug log `C:/Dprogress/nodejs/node_cache/_logs/2026-08-02T21_24_45_338Z-debug-0.log` 明确记录 `EBADPLATFORM`：`@xai-official/grok@0.1.4` 只允许 `darwin/arm64`，本机为 `win32/x64`。
- 现有 Grok 由 xAI 官方安装器放在 `C:/Users/16643/.grok/bin/grok.exe`，Kimi 新增的环境面板却用 `npm install -g @xai-official/grok@latest` 升级，安装归属与升级通道不一致。
- 原 API 已返回 `outputTail`，但面板只显示 `error.message`，因此用户只能看到 `install exited 1`，根因被吞掉。

## 修复

- `apps/control-center/src/cli-env.mjs:29`：Grok 未安装时按平台使用 xAI 官方安装器；已安装时固定使用 `grok update --stable`。
- `apps/control-center/src/cli-env.mjs:119`：新增安装状态驱动的 `operationSpec`，执行前重新探测，避免陈旧快照选错命令。
- `apps/control-center/src/cli-env.mjs:240`：安装/更新进程显式 `provider: null`，更新器不继承 Grok Provider 密钥。
- `apps/control-center/public/modules/ccswitch-panel.js:35`：提取并显示 `outputTail` 中的 `EBADPLATFORM/EPERM/EACCES` 等可行动诊断；确认弹窗展示真实命令和来源。

## 验证

- 定向：`tests/cli-env.test.mjs` 15/15 pass；`tests/ccswitch-panel.test.mjs` 7/7 pass（外层因既有句柄未退出而超时，TAP 断言为 7/7）。
- 全量：放行测试临时目录后 TAP `673 pass / 0 fail / 1 skipped`；runner 在 TAP 完成后因继承句柄 600 秒超时，断言无失败。
- 配置：`npm run validate` 13 项全部 valid。
- 真实升级：官方 updater 输出 `0.2.112 → 0.2.118` 且安装成功；当轮重新执行 `grok --version` 得 `grok 0.2.118 (1e1687c1cf)`。
- 磁盘：`C:/Users/16643/.grok/bin/grok.exe`，140687688 bytes，SHA-256 `8B365D13BA0956BD8015069A7230370DD11496CD18D03B5EB148A329A8D96F7C`。
- 服务读回：CLI 环境服务返回 `status=up-to-date`、`currentVersion=latestVersion=0.2.118`、命令 `grok update --stable`、来源 `Grok 内置更新器`。

__DELTA__: 烛(Codex) | 1 | correctness | 证据：apps/control-center/src/cli-env.mjs:230 将 Windows Grok 升级从必失败的 npm EBADPLATFORM 路径切换到官方内置 updater，并补齐真实失败诊断
