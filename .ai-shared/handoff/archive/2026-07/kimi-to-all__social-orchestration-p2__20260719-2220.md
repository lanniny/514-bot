# handoff：v3.6 P2——social 默认化 + 挂起问答 + bus 拓扑（kimi → all）

- 时间：2026-07-19 22:20
- 范围：`apps/control-center`（src/orchestrator.mjs、server.mjs、public/app.js、public/index.html、tests/orchestrator.test.mjs、tests/social-orchestration.test.mjs、DESIGN-NOTES.md）
- 触发：LO「社会模拟是默认内置模式，不需要主动开启；接着做 P2」

## 做了什么

1. **social 扶正为默认**：`orchestrationMode` 缺省 = social，composer 无需任何前缀；`/pipeline` 留为旧拓扑后门。老编排测试统一显式 pipeline（拓扑断言不失效）。
2. **ask/answer 挂起**：agent 写 `[[msg:lo]]` → run 挂起为 `waiting_agent`（`run.waiting_input` 事件，不收敛不判终）；LO 在 composer 回答 → 答案落 bus 并路由回发问者，主循环复跑至收敛。全链 e2e 覆盖。
3. **composer「起始」picker**：团队成员直选（leader 标注默认），startAgentId 直传——主脑非强制入口在 UI 层兑现。
4. **bus 拓扑**：`GET /api/runs/:id/bus`；social run 的会话拓扑从 bus 消息流构图（参与者/角色/发言数）。
5. **roster API**：`GET /api/roster`。

## 验证

- 新增 2 条 e2e（默认即 social；挂起→回答→收敛全链，断言 answer 进快照、decide 收尾）。
- UI 断言：起始 picker 6 成员 + leader 默认；demo run bus 拓扑 3 节点正确；0 JS 错误。
- `node --test` 124/124；`qa:ui --suite=all` ok:true 0 错误。

## P3 待做

per-agent worktree 隔离、共享记忆（lilith schema 参考）、Team MCP Mailbox（v35 P2 预留）。

__DELTA__: 烛面(kimi) | 1补强 | v3.6 P2（social 默认化/ask-answer 挂起恢复/起始成员直选/bus 拓扑/roster API；124/124 + qa:ui ok:true）
