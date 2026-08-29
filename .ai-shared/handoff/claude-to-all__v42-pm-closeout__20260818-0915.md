<!-- 514cc-session-id: 2e5d4b63-9955-451a-96d9-ddc4ffedee71 -->
# v42 首批 DAG 收口

- **时间**：2026-08-18 09:15 +08:00
- **范围**：项目经理方案 §13 首批 DAG（R0-01…R0-04 → R1-01 → R1-03 → R1-04 → R1-05 → R2-01），外加薄做 R1-02
- **正式版本**：仍为 v3.5.0，未升格
- **独立评审**：
  - R1 `.ai-shared/handoff/codex-to-claude__v42-pm-closeout__20260818-0850.md`（烛 DELTA=1，两条致命当场收口）
  - R2 `.ai-shared/handoff/codex-to-claude__v42-pm-closeout-r2__20260818-0905.md`（烛 DELTA=0，APPROVED）

## LO 能看见什么

1. **环境舱**「首次就绪」四步：项目锚点、默认团队、可执行席位、一次非付费验证。缺一步不会变绿；远程门闩是 gated 不是故障。
2. **派工预演**会写权限档、成本未知、回退额外调用/审批。点预演不会建 run、不会打 provider。
3. **任务回放**能拼出事件、bus、attempts、审批、中断、恢复备注。`submitting/submitted/ambiguous` 禁止自动重放；继续只走现有 acknowledgeRecovery。
4. **Mission 证据卡**会标 missing / truncated / digest-changed / stale-run / available，**绝不写已发布**。
5. **Inbox** 能答复、能确认收到。确认收到 ≠ 任务成功。批准/构建/切供应商等高影响动作继续拒绝。
6. **关控制面**：二次关闭幂等。proxy 或调度器停不下来时会复活调度器，下次再停，不会假装关干净。

## 实现（本波新接线）

| 项 | 模块 / 路由 | 硬约束 |
|---|---|---|
| R0-04 | `providers.mjs` remove 后 deletion-recheck；`app.mjs close()` 结构化结果 | leftover 只观测不 undelete；失败删 `automations.stop` 缓存 |
| R1-02 | `first-run-readiness.mjs`，`GET /api/readiness` | `attention` 不算 ready；环境舱不 probeHealth |
| R1-03 | `router.mjs` `enrichDispatchPreview` | `createdRun: false`；`cost.usd=null` 当 unknown |
| R1-04 | `run-replay.mjs`，`GET /api/runs/:id/replay` | `replayable` 恒 false |
| R1-05 | `run-artifacts.mjs`；Mission 可选附加证据卡 | `published` 硬 false |
| R2-01 | `inbox-lifecycle.mjs`；`POST .../inbox/{answer,acknowledge,fail,expire}` | 先 bus.append 再 apply；ACK ≠ provider 成功 |

## 烛推翻（已收）

1. Inbox 先记账再写 bus → 待办被涂绿、run 仍停在 pendingAsk。现改为先 append 再 apply；`stored=answered` 单独不再摘待办。
2. close proxy 失败会复活 automations，但 stop 已标 fulfilled，重试跳过停调度器。现失败删 stop 缓存并 `reportPhase`。

## 验证（我跑过的）

- 聚焦第一批：37 pass / 0 fail
- 致命收口 + 回归钉后再跑 inbox / first-run：7 pass / 0 fail（含「账本 answered、bus 无 answer 必须留下 pendingAsks」）
- 未跑全量 `npm test`，未 reload 正式 Control Center，**不能称为已激活**
- 未 git add / commit / push。`qa:delivery --strict` 对未跟踪 must_ship 继续红——闸门在工作

## 明确没做 / 暂缓

- R2-02 队列与注意力中心、R2-03 受控社会协作
- R3 Delivery Gate 2.0 / worktree 结算 / 运营指标
- R4 远程真实验收、签名市场、Channels/Office 成熟化、Memory 第二真源、插件 SDK、富 IDE
- 全量 IDE、万能编排器、无限互聊、无签名 updater、CCB daemon/tmux/mobile
- 正式版本升格、git add、重启正式 Control Center

## 残差（不挡首批 DAG，但要看见）

- Inbox UI 点击路径仍不传 `expectedRevision`
- close 超时不 abort 底层 Promise（重试会再 stop，可能重叠一拍）
- 环境舱 / Mission 证据读取失败仍可能被 `.catch(() => null)` 吞掉
- deletion-recheck 只观测不回滚

下一扇门：LO 授权 git add 才能让交付闸变绿；授权 reload 才能说正式实例吃到这波源码。

__DELTA__: 烛(Codex) | 1 | governance | 证据：Inbox persist-then-append 与 close 跳过 automations.stop 被推翻并当场改；R2 复扫 DELTA=0。见 codex-to-claude__v42-pm-closeout__20260818-0850.md 与 ...-r2__20260818-0905.md
