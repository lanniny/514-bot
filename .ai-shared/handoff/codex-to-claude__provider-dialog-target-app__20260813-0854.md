<!-- 514cc-session-id: 019ff87a-5528-7192-8ed0-ee23821eb8b5 -->
# 新建供应商由顶部应用标签确定目标配置

## 结果

- 删除供应商弹窗中的「启用应用」复选区及对应死样式，不再在弹窗内重复选择 CLI。
- 新建供应商时，顶部供应商应用标签成为唯一目标：例如在 `Codex` 标签下点击「新增供应商」，提交体仅含 `apps.codex=true`，其他应用均为 `false`。
- 预设目录、模型区、端点提示、配置预览与模型测试统一跟随该目标应用。
- 编辑旧档案时保留原有多应用关联；若当前顶部标签不属于该档案，预览回落到档案实际关联的第一个应用，避免无控件场景下静默抹除旧数据。

## 代码证据

- `apps/control-center/public/index.html:2273`：红框复选区已移除，请求地址提示后直接进入目标应用模型区。
- `apps/control-center/public/app.js:8457`：`providerDialogSelection()` 收口新建/编辑的目标应用与关联集合。
- `apps/control-center/public/app.js:8671`：保存体从 `state.providerDialogApps` 构造，不再读取已删除复选框。
- `apps/control-center/public/app.js:9207`：预设目录只读取目标应用。
- `apps/control-center/public/app.js:16893`：页头「新增供应商」显式传入 `providerActiveApp()`。
- `apps/control-center/public/state.js:178`：新增弹窗目标应用与关联快照状态。
- `apps/control-center/tests/provider-dialog-target-app.test.mjs:22`：覆盖新建单应用、编辑旧关联兼容、旧控件/旧引用清除。

## 验证

- `node --check public/app.js`、`node --check public/state.js`：通过。
- 聚焦前端回归：`36/36 pass`，包含配置图谱 state/UI 与新增供应商目标应用测试。
- `npm run validate`：`13/13 valid`。
- ProviderStore：非沙箱运行 `tests/providers.test.mjs` 两次均完整输出 `45/45 pass, 0 fail`；但 runner 存在既有 Windows 活动句柄，断言完成后不自然退出，最终被外部 120 秒门限终止。未把该命令包装成成功退出。
- 隔离 Playwright：桌面 Codex、桌面 Gemini、390px Codex 共 3 场景，`errors=[]`；标题分别对应顶部标签，旧选择器数量为 0，唯一启用应用分别为 `codex/gemini/codex`，弹窗与页面横向溢出均为 0。
- 浏览器证据：`apps/control-center/.qa-output/provider-dialog-target-app/report.json` 与同目录 3 张截图。

## 交付边界

- 工作区已有大量其他协作者改动，本轮未清理、重置或格式化它们。
- `public/state.js` 与新增测试当前均为未跟踪文件；交付时必须用 `git status --short --untracked-files=all` 纳入，不能只取 tracked diff。
- 隔离 QA 服务已关闭；仓库既有 Control Center 实例 PID `51620` 正在 `127.0.0.1:51400` 监听。实时回读根页与 `app.js` 均 HTTP 200，且所服务源码包含 `providerDialogSelection`、不含旧 `provider-app-claude` 引用。浏览器测试没有保存真实供应商配置。

__DELTA__: 烛(Codex) | 1 | observability | 证据：apps/control-center/public/app.js:8457 将新建供应商目标收口为顶部应用标签，并以浏览器提交体证明单应用关联
