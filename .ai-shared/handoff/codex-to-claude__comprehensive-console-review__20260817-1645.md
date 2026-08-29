<!-- 514cc-session-id: 01a00fb1-8675-7990-b545-9b22735b7ddb -->
# Codex 评审：Control Center 全面审查与逻辑完善

- **评审模式**：deep-review + architecture + adversarial
- **评审范围**：`apps/control-center` 编排、热重载、shutdown、自动化、市场、右栏工具与交付验证
- **评审时间**：2026-08-17
- **独立视角**：backend / frontend / governance 三路只读探针

---

## 致命问题

1. **交付完整性仍是 P1**：`git status --short --untracked-files=all` 当前仍有大量 modified/untracked；`apps/control-center/public/modules/automations-page.js`、`tests/automations-page.test.mjs`、`tests/market-panel.test.mjs` 等仍未纳入 Git。物理测试目录会执行它们，但提交/CI 可能缺失，当前 1400-case 绿灯不能直接转化为可复现交付证据。
2. **shutdown 仍有结构风险**：`src/app.mjs:484-521` 的 cleanup 阶段虽然共享 deadline 参数并记录 phase，但 `approvalBroker.denyAll`、`childRegistry.flush`、`closeChannelService`、`instanceLock.release` 仍可能无界等待，且失败后 `closed/closeFailure` 语义仍不支持完整重试。历史 full-suite 关闭链问题应继续作为独立工程债。
3. **运行态未闭环**：本轮未重启用户已有 Control Center，未执行真实 provider / Grok 付费请求 / 远端执行；源码和测试绿灯不等于当前桌面进程已激活。

## 建议改进

### 已落地的正确性补强

- `src/app.mjs:443-448`：热重载只有成功发布或已完成 swap 才提交候选 catalog；swap 前失败会恢复旧 pending，避免团队目录卡在未激活代。
- `public/workbench-chrome.js:56-88`：终端抽屉增加 `openGeneration`，关闭赢得竞态时迟到的 RAF reveal 不再重新显示/挂载 PTY。
- `public/modules/automations-page.js:101-151,468-515`：统一 `writable/failClosed/degraded/unavailable` 判定，并用 `inFlight` key 防止创建、运行、启停重复请求。
- `public/market-panel.js:45-46,138-168,610-626`：市场全量刷新与 MCP 搜索采用 generation latest-wins，旧响应不再覆盖新查询。
- `public/rail-tools.js:120-139,218-239`：右栏 tab/panel 补 `aria-controls`、`aria-labelledby`，增加 Home/End/方向键导航和焦点回收。

### 产品头脑风暴（按杠杆排序）

1. **交付证据闸门**：`validate` 或独立 `qa:delivery --strict` 检查新增源码/测试是否 tracked、测试物理清单与 handoff 声称是否一致；解决“本地完成、提交缺文件”的根问题。
2. **源代码—运行时—进程—证据四面板**：把 Git 状态、runtime generation、Control Center PID/健康、handoff/route/mirror/stop 日志汇成同一时间线，并显式显示“需重启/只读证明/真实调用”边界。
3. **协作运行回放中心**：围绕 `interactionId`、approval、interrupt、resumeClaim、recoveryNote 展示可筛选事件链，支持从失败节点恢复或定位证据。
4. **Provider 派工预演器**：显示健康、质量/速度/成本证据、候选与回退解释；`costUsd` 缺失时显示未知，不能承诺美元硬上限。
5. **受治理的 Skill/MCP 制品账本**：manifest、来源、哈希、权限、投影目标、回滚记录与安装前差异预览统一起来，补齐市场供应链边界。

## 可保留

- 当前 `teams.beginCatalogTransition` 的串行门和成功/失败恢复语义仍是正确的状态机基础；本轮只修正 app 层错误提交条件，没有扩大写面。
- 右栏工具定义与菜单/空态同源、终端输入错误可见、配置验证使用真实 Python schema parser 等既有设计应继续保留。
- 独立探针提供了新增 P1：终端 RAF 竞态、自动化状态协议分裂、市场 latest-wins 缺失、自动化重复提交和 tab ARIA 不完整；本轮已分别补强，净增量为补强而非白发。

## 总评

源码层本轮完成了五项窄而完整的逻辑补强，定向组 `28/28`、runtime-reload `3/3`、完整 Control Center 套件 `1399 pass / 1 skipped / 0 fail` 且退出码 `0`，`npm run validate` 13 项全绿。评审结论仍为 **CHANGES_REQUESTED**：未跟踪文件交付门禁、shutdown 全阶段可重试性和真实运行态验收尚未闭环。不得据此 handoff 宣称已发布或已激活。

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 1 | correctness | 证据：`public/workbench-chrome.js:56-88`、`public/market-panel.js:138-168`、`public/modules/automations-page.js:101-151` 补上了独立探针发现的竞态、状态协议和重复提交边界；`git status --short --untracked-files=all` 仍证明交付完整性未闭环。
