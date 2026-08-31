<!-- 514cc-session-id: 019fa2de-d0f7-7982-a759-b12b41a955cd -->
# Codex 终审：团队工作区融合

- **评审模式**：deep-review / 独立竞态与 QA 安全复核
- **评审范围**：`apps/control-center/public/{index.html,app.js,collab-flow.js,team-panel.js,forge/team.css}`、`scripts/qa-team-workspace.mjs` 与相关测试
- **评审时间**：2026-07-27 21:50（Asia/Shanghai）
- **结论**：团队启用、团队设置与运行态已融合到唯一 `#/team` 工作区

---

## 致命问题

当前最终磁盘无未解决阻断项。

独立审查曾推翻原完成判断并推动修复：团队写后复用旧 GET、fresh worker 未执行、QA 可指向真实实例、保存晚到覆盖新草稿、Provider 旧快照回滚、目录未就绪时清空声明、首屏 stale GET 额外回填、初始化异常残留临时根，以及浏览器关闭阶段漏检晚到 HTTP 失败。最终关键门见 `public/app.js:75`、`public/app.js:992`、`public/app.js:3354`、`public/app.js:3948`、`scripts/qa-team-workspace.mjs:103`、`scripts/qa-team-workspace.mjs:274`、`scripts/qa-team-workspace.mjs:709`。

## 建议改进

无阻塞建议。后续若扩展团队级治理指标，必须先为 handoff / DELTA / route-gate 增加可信 `teamId` 归属；当前不得把全局治理数据伪装为团队数据。

## 可保留

- `#/team` 是唯一团队入口；浏览设置不改变 session/composer/runtime，只有显式激活调用 `selectTeam()`（`public/app.js:3476`、`public/app.js:3742`）。
- 桌面采用运行态主区 + 设置侧栏，移动端按运行态后设置排列并提供“编辑设置”快捷入口（`public/index.html:651`、`public/index.html:698`）。
- dirty / busy / revision、写后 fresh 队列、新建后重绑 PUT、Skill/MCP 与幽灵成员保留均有机械回归。
- run 统计按团队隔离；无 `teamId` 的旧 run 只归内置团队（`public/team-panel.js:84`）。handoff、DELTA、route-gate 明确显示为全局治理数据（`public/collab-flow.js:155`）。
- QA 只使用自建临时根、随机 loopback 端口、自有子进程和隔离用户目录；异常路径与最终 HTTP drain 都有故障注入测试。

## 总评

`APPROVED`

最终磁盘证据：

- 定向回归：`29 pass / 0 fail`。
- `npm test`：`591` 项，`590 pass / 0 fail / 1 explicit skip`。
- `npm run validate`：13 个入口全部 valid。
- `npm run qa:team`：`ok=true`；桌面与 390px 横向溢出均为 0；控件重叠为空；浏览器 diagnostics 为空。
- Playwright 首屏竞态：`initialDraftRace.getCount=3`、`remainedDirty=true`，保存期间晚到输入保留。
- 常规写后竞态：团队 GET 数为 4，stale/fresh 快照顺序正确；后续保存使用 PUT，保存后不隐式选用。
- 隔离清理：随机端口 `56827`，QA 子进程优雅退出，临时根已删除，`%TEMP%\514cc-team-qa-*` 无残留。
- 最终截图：`apps/control-center/.qa-output/team-workspace/team-desktop.png`、`team-mobile.png`，已逐张读盘复核。
- 运行读回：`127.0.0.1:51400` 仍由原 PID `29864` 监听，`http://127.0.0.1:51400/#team` 返回 HTTP 200；未声称桌面窗口当前可见。
- SHA-256：`app.js=951353AB85F3D89F436030698865054149524107F9705C1B55EBD7A5DE6C06C6`；`qa-team-workspace.mjs=E06BEFBB6FB00DC1F22F8744613F65CADAB9F717D454F34F628037526ECC0413`。

边界：未执行 runtime sync、桌面重启、git commit 或 push；未覆盖或回退工作树中的既有修改。

__VERDICT__: APPROVED
__DELTA__: 烛(Codex) | 2 | 证据：app.js 团队写后复用旧 GET、fresh worker 未执行及 QA 假隔离推翻了原完成判断
