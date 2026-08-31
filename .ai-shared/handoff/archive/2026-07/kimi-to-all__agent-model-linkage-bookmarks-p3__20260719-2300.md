# handoff：agent 联动模型目录 + composer 书签 + v3.6 P3（kimi → all）

- 时间：2026-07-19 23:00
- 范围：`apps/control-center`（src/orchestrator.mjs、src/bus.mjs、src/app.mjs、public/app.js、public/index.html、public/styles.css、tests/social-orchestration.test.mjs）、`config/control-center/models.json`、`schemas/control-center/contracts.schema.json`、DESIGN-NOTES.md
- 触发：LO 三连——/model·/effort 随 agent 变更、团队/agent 名做书签、继续 P3

## 做了什么

1. **modelOptions 目录**：models.json 每 profile 声明可选模型（schema 同步扩 modelProfile）。/model 覆盖按起始 agent 目录校验（错配即 INVALID_MODEL），只作用于起始 agent 轮。前端起始变更即重建 /model 目录，/effort 非 claude 自动收起。
2. **composer 书签条**：团队/起始 picker 迁到输入框左上角书签位（tab 样式）。
3. **P3-1 共享黑板**：`[[memo]]` 写全员黑板，后续所有成员快照自动可见（parseDirectives 双形态解析）。
4. **P3-2 build worktree 隔离**：build run 自动建 git worktree，写盘轮 cwd 指向隔离副本；非 git 目录 fail-closed；codex 常驻进程为如实限制。
5. **P3-3**：Team MCP Mailbox 维持 bus.jsonl 即邮箱，MCP 暴露列后续候选。

## 验证

- 新增 3 条 e2e（目录校验/覆盖到轮、memo 黑板、git worktree 写盘隔离实建实写）。
- UI 断言：claude 起始 4 档+effort 可见；codex 起始 gpt-5 三档+effort 收起；书签就位。
- `node --test` 127/127；`qa:ui --suite=all` ok:true 0 错误。

__DELTA__: 烛面(kimi) | 1补强 | agent 联动模型目录+composer 书签+v3.6 P3 黑板/worktree 隔离（models.json modelOptions/orchestrator 按起始 agent 校验/syncModelPick/parseDirectives 双形态/ensureRunWorktree；127/127 + qa:ui ok:true）

## 追加（同日）：动态模型/档位发现

- LO 指出 /model 是静态死目录、effort 不止 claude 独有。实证：codex debug models（7 模型含 GPT-5.6-Sol + max/ultra 档）、grok models + --reasoning-effort、claude models（OAuth 过期暂回退）。
- 落地 ModelDiscovery（5min 缓存 + 静态回退 + source 标注）、各家 effortLevels、grok 适配器 effort 支持、前端动态升级。
- 验证：parse 单测 + 动态档位 e2e + 三端点实测；130/130 + qa:ui ok:true。

__DELTA__: 烛面(kimi) | 1补强 | 动态模型/档位发现（model-discovery.mjs/effortLevels/grok --reasoning-effort/syncModelPick 动态升级；codex 实证 GPT-5.6-Sol+max/ultra；130/130 + qa:ui ok:true）
