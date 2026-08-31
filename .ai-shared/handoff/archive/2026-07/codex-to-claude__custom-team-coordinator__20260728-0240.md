<!-- 514cc-session-id: 019fa2de-d0f7-7982-a759-b12b41a955cd -->
# 自定义团队成员与主脑解耦收口

- 日期：2026-07-28
- 范围：`apps/control-center` 团队目录、主脑身份、adapter 工具契约、热重载与浏览器 QA
- 结论：仓库源与隔离运行时通过；未重启既有桌面进程

## 致命问题

当前未发现仍未闭合的致命问题。独立审计先给出 `CHANGES_REQUIRED`，修复后复审为 `APPROVED`；审计推翻并闭合了以下假设：

1. `command` 存在不等于 adapter 已真实接线；反向地，缺失 `command` 也不能由构造器默认值重新生成可执行 adapter。`src/adapters/manifest.mjs` 作为资格真源，`src/adapters/index.mjs:97-115` 在运行图注册处再次执行 required-command 闸，Codex fallback 继承 primary profile 的命令要求。
2. CRUD 中保存非 Claude coordinator 不等于真实主脑闭环。Codex developer instructions 与 Fable 系统提示均已改为运行席位中性语义；当前轮角色只由 orchestrator 任务包决定，不再写死 Claude-led。
3. 中性角色提示仍不能与真实工具契约冲突。`src/adapters/claude-cli.mjs:5-40` 统一构造参数，`plan` 与 `workspace-write` 分别映射为 `plan` / `acceptEdits`，不注入 `--tools ""`；Fable 提示改为按 adapter、permissionMode 与真实工具回执判断能力，`models.json` 同步删除旧声明。
4. 候选目录中出现 Claude 不代表 Claude 已加入团队。`public/index.html:720` 明确为“可选席位与主脑”，新团队在目录到达前只显示加载态，目录到达后保持 `0` 成员、`0` 主脑，选择主脑才自动加入对应成员。
5. pipeline/session 旧形状不能覆盖当前 coordinator。`public/team-panel.js` 统一数组/对象 session，根节点优先精确匹配 `coordinatorId`；`public/app.js:642-657` 同时规范化 `coordinator_id` 与 `start_agent_id`，取消与会话徽标不再产生 `0/1` 假成员。
6. catalog provider 必须压过静态 profile。`public/team-panel.js:20-66` 先做显式 provider alias，再做品牌推导，避免 `anthropic` 因含 `pi` 子串被误判；团队设置卡与运行席位共用该真源。

## 建议改进

1. “高度自定义”仍受真实执行边界约束：新增 profile 必须先登记 adapter manifest 和 factory wiring；仅在 `models.json` 填一个 command 不会被当成可执行成员或主脑。这是 fail-closed，不应放宽。
2. 内置 `team-514cc` 继续冻结为 Claude Fable 默认主脑；自定义团队由各自 `coordinator` 决定。不要把治理主驾默认再次外溢成所有团队的硬编码。
3. 本轮没有调用外部 CLI 完成付费真实轮次；adapter 参数、thread/start、orchestrator、HTTP dry-run 和隔离浏览器契约已机械验证。外部 CLI 登录态与实际工具清单仍是部署时边界。
4. 修复前创建的旧 Codex 原生 thread 可能保留历史 developer instructions；新 thread 已正确。跨版本续聊迁移需单独设计，不能伪称本轮已重写远端持久会话。

## 可保留

- adapter manifest 是团队资格唯一真源；disabled、缺命令、fallback 和未接线 profile 均 fail-closed。
- 自定义团队至少一名成员、主脑必须属于成员且具备 coordinator adapter；Claude 可完全移除。
- models 提交、pending catalog、团队 CRUD 与 runtime activation 共享事务门，防止旧目录校验后写入新目录。
- 浏览与激活继续解耦；保存/另存不会隐式切换当前团队。
- `teamCatalog` 的 `label / role / provider` 优先于前端静态 fallback，Claude 固有身份显示为“规划编排席”，leader 仅来自当前团队 coordinator。
- `coordinatorId` 决定主脑，`startAgentId` 只是会话入口；新团队默认入口跟随主脑，旧 snake_case run 也会规范化到同一契约。

## 总评

`APPROVED_FOR_REPOSITORY_SOURCE`；最终独立复审结论为 `APPROVED`。

验证证据：

- 相关定向测试：69 pass，0 fail；独立 provider 品牌探针全部符合预期。
- `npm test`：610 tests，609 pass，0 fail，1 explicit skip。
- `npm run validate`：13/13 valid。
- `npm run qa:team`：`ok=true`；pre-bootstrap `inventedMembers=0` 且草稿保留；Codex/Kimi 单席均满足 `coordinatorId=startAgentId`；Claude 可完全移除；桌面与 390px 无溢出/重叠，diagnostics 为空；隔离子进程优雅退出且临时根删除。
- `git diff --check`：通过，仅既有 LF/CRLF 提示。
- 截图已读盘复核：桌面运行态为 Codex leader；团队设置中 Claude 未选中，Codex 可选为主脑；390px 控件无覆盖。
- 截图：`apps/control-center/.qa-output/team-workspace/team-{desktop,mobile,mobile-settings}.png`。

边界：未执行 runtime sync、未重启既有桌面壳、未 commit/push；因此不得声称当前已打开的桌面窗口已经加载本轮源码。

__DELTA__: 烛(Codex) | 2 | 证据：独立审计推翻“command 即可执行”“CRUD 可选 coordinator 即闭环”及“角色中性提示已足够”，补齐真实 adapter 注册闸、Claude 工具契约、动态 pipeline 根、provider 真源与 pre-bootstrap 竞态
