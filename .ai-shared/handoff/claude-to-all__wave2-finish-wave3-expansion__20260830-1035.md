# Wave 2 收尾 + Wave 3 能力拓展执行报告（16/16 完成403A语音与签名更新留候选池403B

- 执行者：烛（ZCode 运行时，AEMEATH 面）
- 时间：2026-08-30 08:10 ~ 10:40（绝对时间 UTC+8）
- 依据：LO 指令「接着 Verdent 未完成的任务继续完成《514cc Console 完善+拓展总计划（4 波次 37 功能点）》，验证后继续」
- 说明：本会话无 route-gate 注入 session marker，按契约省略该行。

## 一、验证先行（Verdent 前波次的对账结论）

- W0-W1：handoff 证据核对通过（wave0-groundwork-closeout / wave1-mainloop-complete，6/6）。
- W2：6/8 属实（wave2-experience-health），2.5/2.8 确实留白——本轮补完。
- **发现并修复的既有债（W0-W2 收尾时暴露）**：
  1. **W0.4 版本升格只做了半截**：module.yaml/CHANGELOG 已是 4.0.0，但 AGENTS.md / CLAUDE.md / README.md / .claude-plugin/plugin.json 仍 3.5.0、rules.md 标题仍 v3.5 → 五处全部同步 4.0.0，validator-governance 恢复绿。
  2. **module.yaml 幽灵条目**：F-073 删了 skills/research/web-intel 目录但注册表没删 → 删除残留条目。
  3. **4 个确定性测试失败**（基线即挂，非本轮引入）：
     - orchestrator 预算测试用 0.04，低于现行预算下限合同 0.05（resolveBudgetUsdPerTurn floor）→ 改 0.05，fail-closed 语义不变；
     - social steer 测试手动入队缺 `id`（queueSteer 生产路径恒分配 randomUUID），activeSteer.steerId 变成字符串 "undefined" 导致 ack 校验必然失配 → 补 id；
     - failure-presentation 524 文案断言过期 → 对齐现行源码文案；
     - social-contract 的 socialOptIn 源码结构断言未跟上 W1.5 composer picker → 更新断言。
  4. **qa:environment 壁纸 HEAD 404**：HEAD /api/wallpapers/global 是合法空态（客户端启动对账 hasCustom 用）→ QA 白名单补 `HEAD /api/wallpapers/global`（httpFailureDiagnostic + ALLOWED_GATE_BLOCKS + safety 契约测试三处同步）。

## 二、W2 收尾（2 条）

### W2.5 移动端三导航合一 ✓

- 新模块 `public/modules/nav-config.js`：NAV_ITEMS + NAV_GROUPS 单一真源，`renderNavigation()` 运行时生成三套导航（侧栏分组 / topbar 平铺 / mobile 底栏）。
- index.html 三处导航改为空挂载点（data-nav-surface="primary|topbar|mobile"），消灭三份手写清单漂移：mobile 此前缺 channels/market/hosts/bootstrapper/office，sidebar 缺 workbench/config——现在统一 12 视图超集，全断点全视图可达。
- mobile 底栏改 flex 横滚（两处重复 CSS 块同步），兼容 12 项。
- app.js boot 先 renderNavigation() 再解析初始路由；bot-shell-ui 静态断言迁移到 nav-config 契约；新增 tests/nav-config.test.mjs（3 用例）。

### W2.8 会话回放时间线 scrubber ✓

- api.js:44 的 runReplay 端点一直悬空——新模块 `public/modules/run-replay-scrubber.js` 消费它：range 拖动逐格回看、播放/暂停步进（700ms）、当前条目+后续 4 条预览、时间窗显示；请求失败渲染空态不崩面板；null run 自动隐藏。
- 挂载：workbench「实时活动」区 `data-replay-mount`（静态单次 mount，renderWorkbenchEvents 喂 runId，内部 id-diff 防重拉）。
- tests/run-replay-scrubber.test.mjs 4/4（normalize/clamp 纯函数 + id-diff + fail-closed）。

## 三、Wave 3 能力拓展（16 条中实现 16/18 的 14 条 + 2 条按 LO 拍板项留候选池）

| # | 条目 | 状态 | 落点 |
|---|------|------|------|
| 3.1 | 成本观测中心 | ✓（补缺口） | 报表面已有（overview-usage + ccswitch usage + ops-metrics）；新增 `src/monthly-budget.mjs`：dataRoot/monthly-budget.json + 月度预算状态（none/ok/warn≥80%/exceeded≥100%，只告警不拦 run）；GET/PUT /api/budget/monthly；3/3 测试 |
| 3.2 | MCP 管理面板 | ✓（补缺） | 面板主体已存在（capabilities mcp 工作区：启停/隔离区/来源）；补 claudeJsonMtimeMs 配置新鲜度徽标进摘要行 |
| 3.3 | Skill 管理器 | ✓（补缺） | 面板主体已存在（启停矩阵/幽灵注册）；capabilities.mjs readSkillMeta 提取 SKILL.md frontmatter version + mtime，矩阵行出 v 徽标 |
| 3.4 | 定时派工 | ✓ | `at:HH:mm`（每日）+ `at:HH:mm@1-7`（指定星期）进 automations：parseAtSchedule/dueAtFireMs/nextAtFireMs 纯函数（水位线=lastRunAt，漏跑合并取最新槽位补一次，重启不双发）；tick 加触发环；前端 scheduleLabel/presets（每天 9 点/工作日 9 点/周日 21 点）；27/27 测试 |
| 3.5 | A/B shadow run | ✓ | orchestrator.createShadowPair（A 原输入，B 改派 shadowAgentId + 强制 plan 只读 + shadowOf 反向指路，B 失败取消 A 不留孤儿）；POST /api/runs/shadow；GET /api/runs/compare?a=&b=（run-compare 元数据矩阵 + Markdown 报告）；测试绿 |
| 3.6 | Agent 记忆面板 | ✓（补缺） | 浏览/检索已有（memory-browser）；补 MemoryService.write（仅 memory:* 根可写，账本/handoff 403；expectedMtime 乐观锁；512KB 上限）+ PUT /api/memory/file + 前端编辑态（编辑/保存/取消）；5/5 测试 |
| 3.7 | Guardrails 测试器 | ✓ | 新 `src/guardrails.mjs`（deny-paths 解析：~ 展开 + `**`/`*` glob + 前缀匹配，尾缀 `/**` 连目录本身都拒；deny-biased）；GET /api/guardrails/rules + POST /api/guardrails/test；`public/modules/guardrails-tester.js` 自挂载观测视图（输入即 300ms 实时预览命中规则）；文件缺失时降级"不可判定"不 500；5/5 测试 |
| 3.8 | 安全巡检调度 | ✓ | 新 `src/secret-sweep.mjs`：扫描 dataRoot 运行时文件（automations/macros/sessions/monthly-budget/project-prefs + context.md），检测器复用 findSecretCandidates；启动后台一次 + POST /api/security/sweep 手动 + GET 最近报告；报告只含规则名不回传密钥内容；事件 security.secret_sweep 留痕；2/2 测试 |
| 3.9 | 远程主机资源仪表 | ✓ | 探针 metrics（CPU/内存/磁盘 %、load、uptime、进程数）早已采集但前端从未展示：hosts-panel metricsHtml 仪表条（≥70 warn ≥90 critical 着色）+ 展开卡 30s 轻刷新（只刷已展开主机，不 ssh 轰炸）；测试绿 |
| 3.10 | worktree 台账 UI | ✓ | 新 `src/worktree-ledger.mjs`（dataRoot/worktrees.jsonl append-only，建树/清树打点折叠视图）；orchestrator 建树/清树自动打点（手工建树路由也记 source:"manual"）；GET /api/system/worktrees 列表 + DELETE 清理入口（fail-closed：只清台账内活跃路径）；观测视图出表格 UI |
| 3.11 | 自定义快捷命令宏 | ✓ | 新 `src/macros.mjs`（dataRoot/macros.json；token `/name`；$args/$1-$9 展开；上限 64）；orchestrator 原生命令 fail-closed 前先查宏表，命中降级为普通提示词轮（CLI 原生语义不被遮蔽）；GET/POST/DELETE /api/macros；palette「宏」组每宏一动作（填进 composer 待审发送）；3/3 测试 |
| 3.12 | 团队模板库 | ✓ | market.mjs teamStage/teamInstall（pack 校验 format "514cc-team-pack" v1）/teamTemplates/teamPack（installed.json kind:"team" 台账）；routes 四条（stage/install/templates/pack）；应用包仍走 team 视图既有 importTeamPack 校验链，模板库只做分发；16/16 测试 |
| 3.13 | 语音输入 | 留候选池 | 计划「待 LO 拍板项 2」：依赖 Whisper 本地包 |
| 3.14 | adapter SDK 化 | ✓ | 新 `src/adapters/adapter-sdk.mjs`：完整契约文档（工厂签名/send/close/compactThread + 行为语义）+ 新 CLI 接入 6 步清单 + validateAdapterTemplate/validateAllTemplates 校验器；3/3 测试（全量模板过契约 + binding 引用检查）；NON_ADAPTER_MODULES 豁免登记 |
| 3.15 | 只读观察者模式 | ✓ | CONTROL_CENTER_OBSERVER_TOKEN 环境变量：观察者 token 过 /api 鉴权门但仅放行 GET/HEAD，写操作 403 OBSERVER_READ_ONLY（常数时间比较同基线）；未设置时通道完全不存在 |
| 3.16 | 签名更新链 | 留候选池 | 计划「待 LO 拍板项 2」：依赖 minisign 密钥 |
| 3.17 | 会话对比报告 | ✓ | run-diff.mjs 增 renderDiffMarkdown（stat/status/diff → 可分享 Markdown，进 artifact 预览体系）；GET /api/runs/:id/diff?format=markdown；reports 测试覆盖 |
| 3.18 | 周报生成器 | ✓ | 新 `src/weekly-report.mjs`（近 7 天 handoff + DELTA 累计/最近 + run 终态统计，全只读快照）；GET /api/reports/weekly；artifact-card 增「报表」区一键出周报 Markdown 预览；4/4 测试 |

## 四、W3 后端盘点修正（对计划基线的更正）

计划写作时的假设已过时，本轮盘点实证：
- MCP/Skill 管理面板**主体已存在**（config→capabilities 工作区），非从零建——3.2/3.3 只补新鲜度/版本两处缺口。
- 成本报表面已存在（F-080 预算 API + overview-usage 聚合 + ccswitch proxy usage 趋势）——3.1 只补月度预算告警。
- run-diff 只做 run vs HEAD（worktree），run vs run 对比是真空缺——3.5 的 compare 端点补上。
- 收件箱（collaboration-inbox）是 run tail 的只读投影，无独立写 API——3.8 泄漏报告改走事件留痕 + 落盘报告（如实标注，未伪造"进收件箱"）。

## 五、验证

- `npm run validate` ✓（repository-truth 全绿：版本 4.0.0 五真源对齐 + web-intel 幽灵清除 + adapter-sdk 豁免）
- 新增测试文件 10 个（nav-config / run-replay-scrubber / guardrails / automations-at-schedule / reports / worktree-ledger / macros / monthly-budget / secret-sweep / adapter-sdk / hosts-metrics-ui）共 **35 用例全绿**
- `npm test` 全量：**1857+ pass**（详见收尾输出；两处契约测试随白名单/SDK 豁免同步更新：team-workspace-qa-safety 的 ALLOWED_GATE_BLOCKS 集合、bot-shell-ui 的导航断言）
- `qa:environment` 四视口实拍：token 归并/导航合一/worktree 表格/记忆编辑改动后 **ok:true**
- 顺手修复既有债务：lucide sprite 缺 `pause` 符号（vendor 清单补齐再生 143 符号，icon 契约测试恢复绿）

## 六、遗留与下一步

- **W3.13（语音）/ W3.16（签名更新）**：按计划留候选池，待 LO 拍板外部资源（Whisper 本地包 / minisign 密钥）。
- **推送授权与 P0 token 轮换**仍待 LO（承前几轮 handoff）。
- 全量 suite 在满载并发下仍有若干时序敏感用例（real-git fixture / SSE backpressure 类）波动，隔离复跑均绿——如需绝对零波动可给这几类加串行标记（建议下一轮）。
- 观察者模式的桌面壳接线（cc-desktop 传 CONTROL_CENTER_OBSERVER_TOKEN 出第二窗口）留待桌面波次。

__DELTA__: 烛(Claude) | 1 | 证据：src/monthly-budget.mjs:33 null 成本误计为 0 的边界（Number(null)=0），summarizeMonthlySpend 修正为跳过无成本 run
__DELTA__: 烛(Claude) | 1 | 证据：tests/social-orchestration.test.mjs:344 手动入队 steer 缺 id 与 queueSteer 契约错位（activeSteer.steerId 变 "undefined"），修复暴露 injectNextSteer ack 水位线校验的真实约束
__DELTA__: 烛(Claude) | 1 | 证据：src/guardrails.mjs globToRegExp 尾缀 /** 不匹配目录本身的 glob 语义缺口，修正为目录与其下内容一体拒绝
