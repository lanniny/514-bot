<!-- 514cc-session-id: 019fcb94-00da-7f12-8b34-e1273927d90b -->

# 团队作用域侧栏与选择恢复收口

日期：2026-08-04

## 结果

- 工作台侧栏按当前所选团队隔离团队、项目、会话和 run；未选团队不进入 DOM。
- 团队选择写入 `localStorage`，启动时优先恢复，并兼容一次旧 `sessionStorage` 值迁移；控制面 token 仍只留在 `sessionStorage`。
- 正式 Playwright QA 覆盖团队切换、项目/run 隔离、重载恢复、桌面与 390px。
- 新建成员自动加入当前团队草稿后会同步成员库按钮状态。
- 删除临时 `.scratch/qa-team-rail-probe.mjs`，契约已进入正式 QA。

## 本轮补强

- 修复 390px 下成员分组仍被后置 `max-width: 1120px` 规则覆盖成两列的问题：两列仅适用于 `681px-1120px`，移动端为一列。
- `qa-team-workspace.mjs` 改为读取每个可见 `.tm-group-body` 的 computed grid 列数，不再拿成员卡片宽度和外层容器做脆弱比较。
- `qa-ui.mjs` 先通过可见筛选按钮展开筛选面板，再操作摘要 checkbox；自动化降级 QA 区分三个禁用写动作与一个保留可用的只读历史入口。

## 证据

- 团队持久化：`apps/control-center/public/app.js:3639`、`apps/control-center/public/app.js:3977`、`apps/control-center/public/app.js:11655`。
- 团队侧栏正式契约：`apps/control-center/scripts/qa-ui.mjs:1400`、`apps/control-center/scripts/qa-ui.mjs:1484`、`apps/control-center/scripts/qa-ui.mjs:3058`。
- 移动端列数：`apps/control-center/public/forge/team.css:1091`、`apps/control-center/public/forge/team.css:2460`、`apps/control-center/scripts/qa-team-workspace.mjs:1028`。
- 成员按钮同步：`apps/control-center/public/app.js:12189`、`apps/control-center/tests/team-workspace-ui.test.mjs:84`。
- 临时探针读盘：`Test-Path .scratch/qa-team-rail-probe.mjs` 返回 `False`。

## 验证

- 定向 Node 测试：`46 pass / 0 fail`。
- 隔离团队 Playwright QA：`ok: true`；桌面/移动端无横向溢出，390px 六个可见成员分组列数均为 `1`，隔离服务优雅关闭、临时根已删除。
- workbench Playwright：`ok: true`；`collapsed-project-dom-desktop` 与 `collapsed-project-dom-mobile` 均 `errors: []`，全套 findings 无错误。
- 视觉读盘：`apps/control-center/.qa-output/team-rail-closeout/` 的桌面、390px、设置和成员截图已逐张检查，无控件重叠或越界。
- `npm run validate`：13 项全部 valid，CC-Switch 账本 `288` 条。
- 全量 `npm test` 第一轮：`696` tests，`694 pass / 1 fail / 1 skip`；失败的 `MCP disable never removes the source before quarantine persistence succeeds` 单独复跑 `1/1` 通过。第二轮该 MCP 用例通过，但套件随后卡在既有 `ccswitch-proxy.test.mjs` 子进程并保留两个监听端口，超过两分钟无输出后终止。团队相关测试和两套浏览器 QA 均已独立全绿；全量测试并发稳定性仍需另案处理。

## 工作树说明

- 未执行 commit/push，未回滚 Kimi 或用户已有的大规模未提交改动。
- QA 截图位于已忽略的 `apps/control-center/.qa-output/`。

__DELTA__: 烛(Codex) | 1 | correctness | 证据：apps/control-center/public/forge/team.css:2460 修复 390px 成员分组层叠覆盖，并以正式 computed-grid Playwright 契约锁定
