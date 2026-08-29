# 团队协作逻辑完善波：health 独立轨道根因修复 + 派工建议席位感知与一键采用（Kimi → all）

> 时间：2026-08-02 · 主驾：Kimi · 范围：apps/control-center 团队视图协作链路（collab-flow.js / team-panel 测试 / forge/team.css）
> 触发：LO「请你继续查看团队协作逻辑继续完善整个体系」

## 一、根因修复：席位状态永远「未核验」

实测 `/api/health` 逐 CLI 探测需 ~5.3s，而 `refreshCollabFlow` 给它与本地快源同等的 3.5s 预算——**永远超时**，花名册/建议卡的席位状态因此永远停在「未核验」。这是深读协作逻辑时发现的真实系统性降级，不是观感问题。

修法（`apps/control-center/public/collab-flow.js` refreshCollabFlow）：

- 快源 teams/runs/delta/handoffs/routegate 保持 3.5s 预算，先渲染首屏；
- health 拆 12s 独立轨道，到达后按 `refreshVersion` 守卫补载 renderHero/renderRoster/renderFlow/renderRouting，过期刷新不串台；
- health 失败保持「未核验」，诚实不伪装。

配套：`buildCollabLoadResult` 新增 `details.sourceNames` 显式归因表（settled 从全集 6 源变快源 5 元素后，按索引归因会把 delta 误标成 health），缺省回退全集顺序，旧 6 元素调用与测试不动。

实测效果：hero 首屏 632–721ms 就绪（旧路径必卡满 3.5s 超时）；席位状态 未核验→可用 补载升级。

## 二、派工建议三增强

- **席位状态感知**：`suggestMarkup(text, members, coordinatorId, seats)` 跳过 offline 席位，给 busy/degraded/unknown 加状态 chip；全离线如实 hint。`SUGGEST_RULES` 移除 `gemini-research`（该 profile 已禁用，`.ai-shared/context.md` 明说，建议它等于指路去死席位）。
- **一键采用**：建议卡 `data-suggest-agent` + role=button，点击/Enter 写进协作台 composer `#start-agent` + 派 change 事件（联动 /model·/effort）+ `cf-adopted-flash` 闪烁反馈；选择器缺席/disabled/无该 option 时如实写 hint。预览实例上如实命中「会话进行中，起始成员已锁定」——续聊模式 composer 冻结是 app.js:6867 既有设计，探针实证非本波引入。
- **补载保输入**：renderRouting 重渲染前记住 `.cf-suggest-input` 已输入描述，渲染后回填并重算建议——health 补载不打断正在打字的人。

## 三、验证证据

- `npm test`：650 pass / 0 fail / 1 skipped（基线 645→650，含 team-panel 19 项：新增 offline 跳过 / busy 标注 / unknown 标注 / 全离线 hint / gemini 不出现 / 建议采用结构断言更新）。
- `npm run validate`：valid。
- `scripts/qa-collab-wave-probe.mjs`（预览实例 http://127.0.0.1:5520/#token=probe123）：hero 632–721ms、SEATS-BEFORE 全「未核验」→ 6.5s 后全「可用」、建议输入补载后保留、锁定期如实 hint、明暗截图、0 控制台错误。
- `scripts/qa-collab-adopt-probe.mjs`（tests/server-fixture 隔离实例，零 run → composer 新任务态）：点击建议卡 `#start-agent` claude-fable→codex-technical + flash + hint「已填为起始成员：Codex」；7 个 501 为隔离实例 test-mode 未实现端点，与本波无关（预览实例 0 错误）。
- 截图：`apps/control-center/.qa-v4/collab-wave-suggest-light.png` / `collab-wave-team-dark.png` / `collab-wave-adopted-light.png`，已亲查。

## 四、边界与回退

- 团队协作后端（teams.mjs / orchestrator）经三轮 Codex 终审 APPROVED，不在本波范围；teamId 治理归属是 Codex 点名的前置债，本波不碰。
- 预览实例 :5520 保留（LO 正在用其实例预览，锁在 `.ai-shared/control-center/control-center.lock`）。
- 桌面端 Ctrl+R 即可生效前端改动；未做 runtime sync / 桌面重启。
- 回退 = 删 collab-flow.js 本波改动（health 拆轨 / sourceNames / seats 感知 / adopt 接线 / preservedQuery）+ `forge/team.css`「协作逻辑完善波（2026-08-02）」段 + tests/team-panel.test.mjs 新增 6 项。

__DELTA__: Kimi | 1 | correctness | 证据：collab-flow.js:82 health 拆 12s 独立轨道修复席位永远「未核验」的系统性降级，探针实测 hero 632ms 就绪、席位 未核验→可用 补载升级
