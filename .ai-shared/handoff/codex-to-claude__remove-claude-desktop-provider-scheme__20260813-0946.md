<!-- 514cc-session-id: 019ff87a-5528-7192-8ed0-ee23821eb8b5 -->
# 从供应商方案移除 Claude Desktop

## 结果

- `Claude Desktop` 已从本机/远端供应商方案应用标签、新建供应商目标、供应商模型区和团队供应商绑定控件中移除。
- 可见供应商方案现在固定为 8 个应用：Claude Code、Codex、Gemini、Grok Build、Kimi Code、OpenCode、OpenClaw、Hermes。
- 团队“一键应用供应商方案”只提交这 8 个可见应用，历史 `claude-desktop` 绑定不再被隐藏执行，也不再计入团队方案绑定数。
- 后端 `ProviderStore` 仍识别 `claude-desktop`，历史档案、旧团队绑定和 writer/live 回读保持兼容；编辑其他字段不会静默清掉旧关联。
- 下方独立的“运行与配置工作台 / 应用接管”仍保留 Claude Desktop 兼容入口。这不属于供应商方案区，且是后端 writer 兼容面的可见控制，不在本轮删除范围内。

## 代码证据

- `apps/control-center/public/app.js:7734`：`PROVIDER_APP_META` 只列 8 个可见供应商应用；`PROVIDER_STORAGE_APPS` 单独保留历史键。
- `apps/control-center/public/app.js:7898`：团队表单没有对应 DOM 控件时，从编辑前团队快照保留隐藏绑定。
- `apps/control-center/public/app.js:8464`、`:8678`：新建只启用顶部目标应用，编辑按存储集合保留旧关联。
- `apps/control-center/public/app.js:8875`、`:8890`：团队方案先过滤可见应用，并把允许的 app 列表提交给服务端。
- `apps/control-center/src/providers.mjs:30`、`:2962`：服务端默认按 `PROVIDER_SCHEME_APPS` 应用团队绑定，排除 `claude-desktop`。
- `apps/control-center/public/index.html:912`、`:2287`：团队绑定和模型区均已直接从 HTML 删除 Claude Desktop 控件。
- `apps/control-center/tests/provider-dialog-target-app.test.mjs:22`：6 条聚焦回归覆盖新建目标、旧档案关联、旧团队绑定与服务端过滤。

## 验证

- `node --check`：`public/app.js`、`public/state.js`、`server.mjs`、`src/providers.mjs`、聚焦测试文件全部通过。
- 轻量后端行为探针正常退出：方案应用集合为 8 项；同时含 `claude/claude-desktop/codex` 的团队默认只应用 `claude/codex`。
- 聚焦测试：`6/6 pass`；配置图谱相邻回归合计 `37/37 pass`。两个 Node test runner 均在断言完成后因仓库既有活动句柄未自然退出，被外部 30s/120s 门限终止，未把命令包装成成功退出。
- `npm run validate`：`13/13 valid`。
- 隔离 Playwright：1440x1000 与 390x844 均通过。两个视口的供应商方案标签均为 8 项；供应商方案、Codex 新建弹窗和团队设置都不含 Claude Desktop；被删控件 DOM 计数为 0；页面/弹窗横向溢出为 0；浏览器错误为 0。
- 结构化报告：`C:/Users/16643/.codex/visualizations/2026/08/13/019ff87a-5528-7192-8ed0-ee23821eb8b5/report-without-claude-desktop.json`；同目录含供应商弹窗与团队页的 desktop/mobile 截图。
- 现有实例 `http://127.0.0.1:51400/` HTTP 200，实时 HTML 不含 `Claude Desktop` 和 `team-provider-claude-desktop`；未停止或重启该实例。

## 交付边界

- 工作区已有大量其他协作者改动和未跟踪依赖，本轮未 reset、清理或格式化无关文件。
- `src/providers.mjs`、`public/state.js` 与聚焦测试在当前工作区仍是未跟踪文件；交付时必须使用 `git status --short --untracked-files=all` 纳入，不能只取 tracked diff。
- 浏览器 QA 使用独立临时 data/runtime 目录，没有读写真实供应商档案；隔离实例已通过授权测试接口正常关闭。

__DELTA__: 烛(Codex) | 1 | architecture | 证据：apps/control-center/src/providers.mjs:2962 将团队方案默认执行集合与后端兼容集合拆开，避免隐藏 Claude Desktop 绑定继续被一键应用
