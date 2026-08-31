<!-- 514cc-session-id: 019fa2de-d0f7-7982-a759-b12b41a955cd -->
# 团队成员库与团队编排融合终审

- 日期：2026-07-28
- 范围：`apps/control-center` 成员库、团队编排、三域执行身份、配置深链、存储引用完整性与浏览器 QA
- 结论：仓库源与隔离运行时通过；独立终审 `APPROVED`

## 致命问题

当前最终磁盘未发现仍未解决的致命问题。

独立复审先后推翻并推动修复了以下完成假设：

1. “拒载团队留在 `rejectedOnLoad` 即可保护成员引用”不成立。旧提交只序列化可运行团队，一次无关 CRUD 会删除拒载原记录，重启后引用保护失明。现在拒载原始记录只拒绝进入运行图，仍随 `teams.json` 回写，并由跨写入、重启探针验证。
2. “可解析的 `teams.json` 就能安全加载”不成立。重复 team id 会被 `Map.set()` 静默覆盖，较早记录及其成员引用永久丢失。现在重复非内置 id 直接把整个 Store 置为 `TEAM_STORE_INVALID`，所有写入冻结且原文件字节不变。
3. 损坏 Store 下 `update/remove` 曾在写闸前执行 `get()` 并误报 404。现在 create/update/remove 都先通过统一 `#assertWritable()`，HTTP 映射稳定为 503 语义。
4. 成员 CRUD 后能力缓存、刷新可恢复深链、逻辑成员列焦点和无匹配焦点曾未闭环。当前能力矩阵按 `memberId` 精确定位，不使用 `runtimeProfileId` 猜治理 Agent；目录变更触发 fresh 排空，目标进入 hash 并采用 latest-wins。

## 建议改进

1. 低优先级可再增加 HTTP 级损坏 Store 专项回归，直接断言 POST/PUT/DELETE `/api/teams` 均为 503；当前 Store 层与统一错误映射已分别覆盖，不阻塞本轮。
2. 自定义成员的“完全自定义”必须继续受真实 adapter 绑定约束。新增 CLI 先登记 manifest 与 factory，再由成员库引用；不要开放不可执行的幽灵席位。
3. 当前未重启既有桌面壳。若要让已打开窗口载入本轮源码，需要单独执行受控重启和运行时读回，不能把隔离 QA 等同于已部署。

## 可保留

- `#/team` 是唯一团队入口；“团队编排 / 成员库”两个工作面在同一信息架构中互切，团队设置、运行态和成员管理不再分散。
- 成员支持完整元数据、提示词、模型/effort、能力与运行席位编辑，以及创建、复制、删除、加入/移出团队和任主脑。
- `memberId -> runtimeProfileId -> adapter.id` 三域契约贯穿路由、模型发现、adapter 调用、session 与历史 run；同一 runtime 可承载多个逻辑成员而不共享人格或 session。
- 新团队不预选 Claude；主脑只由已选成员资格决定。浏览、保存与“设为当前团队”继续解耦。
- 运行席位与 Skill/MCP 分别深链到唯一“配置图谱”的真源面和能力面；刷新、复制 URL 与连续跳转均有机械回归。
- 引用检查、团队写入和成员删除/换绑共享 TeamStore 队列；拒载记录、损坏真源、重复 ID 均 fail-closed。

## 总评

`APPROVED_FOR_REPOSITORY_SOURCE`；独立终审结论为 `APPROVED`。

最终磁盘证据：

- `node --check public/app.js`：通过。
- 团队存储回归：16 pass / 0 fail；配置与团队 UI 状态：19 pass / 0 fail；成员/能力/编排/路由：93 pass / 0 fail；真实 HTTP E2E：7 pass / 0 fail。
- 独立终审定向：85 pass / 0 fail，并完成拒载跨重启、重复 ID、损坏真源与原字节保留黑盒探针。
- `npm test`：634 项，633 pass / 0 fail / 1 explicit skip。
- `npm run validate`：13/13 valid。
- `npm run qa:team`：`ok=true`；未入队自定义成员的 Skill 深链精确聚焦逻辑成员列，运行席位深链精确选中 `control.models` 中 `"id": "codex-technical"`；自定义成员完成创建、编辑、入队、任主脑、移出、删除；桌面与 390px 无横滚/重叠，`diagnostics=[]`，隔离进程优雅退出且临时根删除。
- `npm run qa:config-topology`：桌面/390px、明暗主题、三个工作面及双故障域均 `ok=true`。
- `git diff --check`：通过，仅既有 LF/CRLF 提示。
- 截图已读盘复核：`apps/control-center/.qa-output/team-workspace/team-desktop.png`、`team-mobile-members.png`、`team-mobile-settings.png`。

边界：未执行 runtime sync、未重启既有桌面进程、未 commit/push；因此不声称当前已打开的桌面窗口已经加载本轮源码。

__DELTA__: 烛(Codex) | 2 | 证据：独立终审推翻“拒载摘要足够保护引用”与“可解析团队文件可安全加载”，补出拒载记录丢失、重复 team id 覆盖和损坏 Store 错误语义不一致；最终由 apps/control-center/src/teams.mjs:203、apps/control-center/src/teams.mjs:261 与 apps/control-center/tests/teams.test.mjs:181 闭环
