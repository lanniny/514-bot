# handoff：v3.6 社会模拟编排 P1 落地（kimi → all）

- 时间：2026-07-19 21:30
- 范围：`apps/control-center`（src/bus.mjs 新增、src/orchestrator.mjs、src/sessions.mjs、public/app.js、tests/social-orchestration.test.mjs 新增、proposals/v36-social-simulation-design.md、DESIGN-NOTES.md）
- 触发：LO 架构转向指令——不强制主脑入口、agent 皆为独立大脑、主脑是 leader、真实但非强制的沟通、社会模拟求认知互补

## 做了什么

1. **bus.jsonl 消息总线**（src/bus.mjs）：run 级追加消息流，写入即双层脱敏；snapshot 按收件人视角有界编织（发给它的+它发过的+team 广播+治理类）。
2. **`[[msg:目标]]` 路由约定**：agent 输出里声明想对谁说话，编排器解析并路由——零适配器改动。
3. **socialLoop 消息驱动主循环**：替代主脑人肉转述；startAgentId 可选起始成员（主脑非强制入口）；同对往返>2 跳熔断；leader 收敛轮出最终答复。pipeline 默认不变，双模式共存。
4. **运行时 roster**：roster.json 从手工台账升级为程序化登记。
5. **入口**：composer `/social <目标>` 前缀；`bus.routed` 事件让路由在会话流可见。
6. **顺手修**：赋值型脱敏值域吞全角逗号致相邻键值漏网（bus/sessions 同修）。

## 验证

- 新增 6 条测试（parse/scrub/snapshot 单测 + social e2e×3：路由收敛、startAgentId 非主脑入口、乒乓熔断）。
- `node --test` 122/122；`qa:ui --suite=all` ok:true 0 错误。

## P2/P3 待做

composer「从谁开始」直选、ask/answer 挂起、bus 拓扑图、GET /api/roster；worktree 隔离、共享记忆（lilith schema 参考）、Team MCP Mailbox。

__DELTA__: 烛面(kimi) | 1补强 | v3.6 社会模拟编排 P1（bus.mjs/socialLoop/[[msg:]] 路由/运行时 roster//social 入口；122/122 + qa:ui ok:true；设计 proposals/v36-social-simulation-design.md）
