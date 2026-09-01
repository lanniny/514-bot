<!-- 514cc-session-id: 01a0576f-ef08-7072-b6c7-cb58d92cd8a5 -->
# 权限与审批工作台修复与主工作区闭环

- **date**: 2026-08-31
- **executor**: 烛（Codex）
- **source_summary**: `I:/514claude/514cc-wt-20260831095018-973ebbe1/.ai-shared/handoff/claude-to-all__permission-approval-workbench-dialog-summary__20260831-1842.md`
- **implementation_root**: `I:/514claude/514cc`
- **status**: implemented-and-isolated-browser-verified / formal-runtime-not-restarted

## 结论

原 handoff 的 Slice 1/2 不能视为可运行实现：新增的 `permission-overview-*` 元素未登记进 `app.js` 元素映射，`renderPermissionOverview()` 会直接返回；detached worktree 基线 `fec7929` 还物理缺失 8 个入口 JS 模块与 2 个 CSS 资源，浏览器启动返回 500。修复已谨慎移植到具有物理资源闭包的主工作区，不覆盖并行 UI 改动。

## 已修复

1. 新增 `public/modules/permission-overview.js`，以纯模型区分配置声明、当前激活、服务端确认可执行、项目内审批、临时租约/门闩、适配器审批通道、实例 repoRoot/runtime generation 和具体阻断原因。
2. 运行席位计数改为严格要求 `enabled === true`、`activation === "live"`、`live.enabled === true`、`live.teamMemberEligible === true`；未知字段不再 fail-open。
3. fresh 加载开始即撤下旧权限计数；失败后清空旧快照，普通非 fresh 加载会真实重试，并通过 `onLoadStateChanged` 立即重绘权限面。
4. 审批、租约、远程门闩读取错误分别持久到 UI 状态；门闩刷新会失效旧快照并复用单一在途请求，失败不再继续展示旧开放状态。
5. Adapter manifest 显式声明审批所有权：`codex-app-server` 与其 Grok MCP host 为 `broker-action`；具备 workspace-write 的 headless CLI 为 `governed-build`；`codex-exec-json`/Pi 等无回调通道为 `unavailable`。
6. 权限页补齐运行席位编辑深链、具体阻断列表和实例路径；宿主 SDK 审批明确不伪装为 `/api/approvals` 项目内审批。
7. 动态 UI 全部使用 `createElement + textContent + replaceChildren`，没有新增 `innerHTML` 面；UI lint 的 inner-html 实测从 392 修回 388（基线 389）。
8. 新增 `qa:permission-approval`，覆盖 1440x900/390x844、首进加载、4 张状态卡、9 席位明细、审批通道、实例来源、席位编辑深链、横向溢出和浏览器错误。

## 证据

- `npm run validate`: 13 个注册表/契约检查全部 valid。
- 聚焦审批/Adapter/席位 HTTP：100 pass / 0 fail。
- 最终权限工作台契约：5 pass / 0 fail。
- `node scripts/ui-lint.mjs`: 全部门禁通过，`inner-html=388 <= baseline 389`。
- `npm run qa:permission-approval`: 1440x900 与 390x844 均 4 卡、9 席、body/main overflow=0、pageerror=0，编辑深链可达，隔离服务优雅退出。截图与报告位于 `apps/control-center/.qa-output/permission-approval/`。
- 两次完整套件均完成资源清理但仍有 12 条并发/存量失败；第二轮 `ui-lint` 与本轮新增测试已通过。按 LO 指令停止扩大测试面，不把全套件写成全绿。

## 边界

- 514cc ApprovalBroker 只能接管已有 action-bound 方法与 Codex app-server resolver；Claude/宿主 SDK 没有仓库内 callback，不能由本页面批准本次 Codex/Claude App 工具命令。
- 未实现无 TTL 的全局 full-access，也未新增第二套 approval store、lease 或 session-resume 权限继承。
- 正式 514 Bot 进程尚未重启，因此源码完成与隔离浏览器验证不等于正式实例已激活；重启正式实例仍需 LO 对具体进程操作授权。
- 主工作区已有大量并行改动；本轮没有 commit、push、reset、删除或清理未知改动。

__DELTA__: 烛(Codex) | 2 | 证据：apps/control-center/public/app.js:27663 发现并修复原总览未登记元素导致完全不渲染；apps/control-center/public/modules/permission-overview.js:29 将权限声明、激活态与审批所有权改为可执行 fail-closed 模型。
