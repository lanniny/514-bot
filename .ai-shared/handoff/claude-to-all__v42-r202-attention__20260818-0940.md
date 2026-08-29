<!-- 514cc-session-id: 2e5d4b63-9955-451a-96d9-ddc4ffedee71 -->
# R2-02 队列 / 在岗 / 注意力中心

- **时间**：2026-08-18 09:40 +08:00
- **范围**：项目经理方案 R2-02 + 上轮残差（CAS、空答复、health 旧包、就绪读取失败）
- **正式版本**：仍为 v3.5.0
- **独立评审**：
  - R1 `.ai-shared/handoff/codex-to-claude__v42-r202-attention__20260818-0925.md`（烛 DELTA=2，queued 双计当场改）
  - R2 `.ai-shared/handoff/codex-to-claude__v42-r202-attention-r2__20260818-0935.md`（烛 DELTA=0，APPROVED）

## LO 能看见什么

1. 团队页英雄区「执行中席位」下面会写队列深度和待答数，三个数字来自同一张信封。
2. 排队中的任务只出现在队列，不会同时算成「正在执行」。
3. 降级 / 离线 / 未知席位不会被涂成绿灯。
4. Inbox 答复带版本号；连点两次不会写两条。空框取消或空字符串进不了总线。
5. 环境舱首次就绪如果读失败，会写「读取失败」，不会假装没这回事。

## 实现

- `514cc.team-attention/v1`：`apps/control-center/src/team-attention.mjs`
- `GET /api/teams/:id/attention` 嵌完整 Inbox，health 只 `peek()`，不打探针
- `EXECUTING_RUN_STATES` = `ACTIVE_RUN_STATES` 去掉 `queued`
- Inbox 按钮 `expectedRevision`；ask 无账本行时 revision=0
- `loadHealth` 加 latest-request gate
- team-panel：`available:true` 不能盖过 `degraded`

## 烛推翻（已收）

`queued` 原先进 `activeJobs`，自写测试红了 `2 !== 1`。现执行中与队列分桶。

## 验证

- 聚焦 42 pass / 0 fail
- 未 reload 正式 Control Center，未 git add，**不能称为已激活**

## 没做

R2-03 社会协作、R3 交付门 2.0、R4、花名册卡片改吃 `attention.seats`、正式版本升格。

__DELTA__: 烛(Codex) | 2 | governance | 证据：queued 被算进 activeJobs，推翻「队列与执行中已分桶」；收口后 R2 DELTA=0。见 codex-to-claude__v42-r202-attention__20260818-0925.md
