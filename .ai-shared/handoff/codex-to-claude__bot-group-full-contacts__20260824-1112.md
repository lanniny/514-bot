<!-- 514cc-session-id: 01a02e6c-852d-79c1-b005-637f42ba18aa -->
# Bot 群聊完整通讯录与临时团队快照交接

## 目标与根因

LO 反馈新建群聊只出现少数成员。根因是 `botGroupCandidateMembers()` 按当前团队过滤通讯录；直接移除过滤又会触发后端 `NOT_TEAM_MEMBER`，因为 social run 要求所有目标属于同一团队。

## 已实现

- `apps/control-center/public/app.js:16029`：群聊选择器读取完整 `state.memberCatalog`；无可执行席位的联系人显示但禁用。
- `apps/control-center/public/app.js:16084`：群聊不再 `POST /api/teams`，而是把所选成员、主脑和群名作为 `ephemeralTeam` 随 run 请求提交。
- `apps/control-center/src/teams.mjs:427`：`materializeEphemeral()` 复用 TeamStore 的完整 `#validate()`，但不进入 `custom` Map、不写 `teams.json`。
- `apps/control-center/src/orchestrator.mjs:1864`：Orchestrator 拒绝 `teamId + ephemeralTeam` 冲突，生成一次性团队身份并把完整 roster 固化进 run。
- `apps/control-center/src/orchestrator.mjs:2131`：run 保存 `teamEphemeral` 与团队成员/roster/brief/skills/MCP 快照；续聊继续走 `/api/runs/:id/messages`。

## 独立审查净增量

第一轮独立审查发现：旧实现存在 `POST /api/teams` 成功后页面崩溃或 composer 失败导致孤儿团队的窗口；团队删除后团队级 Inbox/Attention 也不可回读。主线程据此取消“持久化后清理”，改成从不进入 TeamStore 的运行快照。

第二轮独立审查未发现认证、席位、主脑、敏感内容、权限或 run 恢复绕过；补充指出负向 HTTP 与成员删除后恢复证据不足。主线程随后加入未认证、冲突来源、未知成员、secret-like 输入，以及删除成员后跨重启 run roster 回读测试。

## 验证证据

- `node --test --test-concurrency=1 --test-force-exit --test-isolation=none tests/teams.test.mjs tests/team-members-http.test.mjs tests/bot-shell-ui.test.mjs`：48 pass / 0 fail，exit 0。
- `npm run validate`：13/13 valid，exit 0。
- `.qa-output/bot-communications-qa.mjs`：Playwright exit 0；8 位完整通讯录、跨团队成员可选、1 次 run 创建、1 次同 run 续发、成员删除成功；1440x900、1024x768、390x844 无横向溢出；`diagnostics=[]`；graceful shutdown。
- 截图：`C:/Users/16643/AppData/Local/Temp/514cc-bot-communications-qa/bot-group-picker-desktop.png`。
- 正式 `http://127.0.0.1:51400/app.js` 回读包含完整通讯录候选与 ephemeralTeam 提交代码；正式数据未被测试修改。

## 剩余边界

- ephemeral team 没有团队工作区记录，团队级 Inbox/Attention 对它返回不存在是预期；Bot 的问题卡、审批和 settlement 均走 run 级合同。
- Playwright 的 run 请求使用 route mock 来验证前端 payload 和续聊；真实 TeamStore/Orchestrator 行为由 `team-members-http.test.mjs` 的隔离服务覆盖。
- 当前 `cc-desktop` 进程没有可见窗口句柄，未执行桌面窗口刷新；重新打开窗口会加载正式 `51400` 当前资源。
- 未执行 commit/push。

__DELTA__: 烛(Codex) | 2 | 证据：apps/control-center/public/app.js:16029、apps/control-center/src/teams.mjs:427、apps/control-center/src/orchestrator.mjs:1870；独立审查推翻持久化临时团队再回收的旧判断，改为从不写 TeamStore 的服务端校验 run 快照。
