# Codex 评审：514cc Console 波次2——数据呈现补全批

- **评审模式**：standard
- **评审范围**：apps/control-center/{src/orchestrator.mjs:444-475, src/observability.mjs:169-230, public/app.js（多处）, public/index.html:607-615+799-812, public/styles.css 末段, tests/orchestrator.test.mjs:39+402-413}
- **评审时间**：2026-07-18 21:30
- **Codex 通道**：MCP 对话桥 `codex-agent`（read-only sandbox + approval never，等效 `-p review`），同会话两轮（R1 独立评审 → R2 主驾质询对表）
- **threadId**：`019f756a-7bbf-7231-9d65-66f83dada46d`
- **Codex 模型**：MCP 服务端默认（未 override，~/.codex 配置决定）
- **主驾交叉验证**：P0 与主驾独立预判交叉印证；P1 由主驾读盘核实（sanitizeForPersistence 深拷贝 + Object.assign 回写路径）确证；R2 各新发现均经主驾逐条读盘复核

---

## 致命问题（必须改）

1. **P0（本批新增回归）：漂移检查把脚本的正常"存在漂移"结果当成执行失败。**
   `src/observability.mjs:212-216` 将任意 `exitCode !== 0` 抛为 `DRIFT_SCRIPT_FAILED`，但 `scripts/sync-runtime.ps1:54-58` 的契约是检查模式下 `exit 0 = 全一致`、`exit 1 = 存在漂移或缺失`。触发任意一对 `!= drift` / `source missing` / `runtime missing` 时，`/api/observability/drift` 直接失败，`public/app.js:895-904` 只显示"检查失败"——**波次2 的核心功能（漂移明细呈现、漂移行置顶）在"真的有漂移"这个最需要它的场景下完全不可达**。Playwright 实拍 15 行明细能过，只因当时恰好全一致（exit 0）。修"空输出假自信"却引入了"真漂移变检查失败"。
   **修复方向（Codex 推荐，主驾认同）**：保留脚本契约不动，脚本侧把真正执行异常改为独立退出码（如 `2`），`drift()` 按 `0=全一致 / 1=正常存在漂移（解析 pairs）/ ≥2=脚本失败` 三分处理。不建议单纯在 `drift()` 里把 exit 1 视为成功——PowerShell 未捕获异常也可能以 1 退出。

2. **P1（既有后端缺陷，本批呈现层使其可见——单独派工，不阻塞本批归属）：轮间插话队列的保存竞态可丢失或重复执行用户消息。**
   `src/orchestrator.mjs:107-115` 的 `save()` 无 per-run 写锁，且 `sanitizeForPersistence`（src/redaction.mjs:20-37，数组/对象深拷贝重建）产出的快照在异步写盘后经 `Object.assign(run, safe)` 回写内存。活跃续聊 `:652-659`（push → await save）与注入器 `:582-593`（shift → await save）并发时，两个 save 的 writeFile/rename/回写可交错：排队消息可能被旧快照覆盖丢失，或已出队消息被写回重复执行。本批前端 `public/app.js:2851-2853` 依据 `updated.pendingSteer.length` 显示"续接消息已完成"在同一竞态下也不可靠。
   **归属厘清（R2）**：波次2 的 orchestrator 改动只有 tokens 字段（:444-475）；pendingSteer 机制本体（:582-659）是既有代码。**修复应作为独立缺陷派工**：per-run 串行化 save，或服务端返回明确 `accepted/queued/queueDepthAtAccept` 回执、前端不从可变队列长度反推结果。

## 建议改进（值得讨论）

1. **缺失分支未被解析正则覆盖**：`src/observability.mjs:219` 只匹配 `= consistent` / `!= drift`；`sync-runtime.ps1:45-46` 的 `x source missing` / `! runtime missing` 行永不入 pairs。修 P0 时必须一并补齐，否则全缺失场景落 `app.js:951-964` 的"无对账数据"而非逐项呈现缺失。
2. **steer_dropped 文案违反"先脱敏后截断"原则**：`app.js:2023` 先 `slice(0, 60)` 再由 `:2073` redact，与 `toolCallMarkup:1996-2003` 立的顺序原则相反（截断可把密钥模式切半使 redact 失配）。新请求经 `orchestrator.mjs:633` findSecretCandidates 拦截风险较低，**但队列真实生产点 `:588` 用的是 `steer.prompt`，旧 run 文件初始化加载 pendingSteer 不再过该门**——旧版本/手工持久化队列可绕过。建议改 `redact(text)` 后再 slice，补旧队列回放测试。
3. **loadObservability 失败提示有被覆盖路径**：`app.js:884-892` 写入的失败行会被 `renderObservability():966-976` 无条件按 `state.obsHandoffs` 重绘覆盖（初始空数组时失败行秒变"暂无"）。建议失败态在 render 层显式保留。
4. **turn-meta 空字符串边界**：`app.js:2030-2034` 对 `tokens === ""` 经 `Number("")===0` 渲染成 "0 tokens"、`costUsd === ""` 成 "$0.00"，与"缺哪项省哪项"注释不符。建议先非空校验再数值化。
5. **仅旧收尾事件回放时正文被吞**：`app.js:2058-2060` 只要有一条旧 `agent.turn_completed` 入 items，`:2078` 的 `items.length` 二选一即抑制 `run.turns` fallback——旧持久化日志只有收尾事件、无 assistant.message 时，回放只剩 turn-meta 无正文。建议补该场景测试或改合并策略。
6. **候选排除原因建议统一 redact**：`app.js:2706-2714` 对 `excludedReasons` 只 escapeHtml；原因可源自 `src/health.mjs:42-49` 外部探针 `error.message`，若回显凭据会明文入 DOM（非 XSS，是敏感值防御）。建议 `escapeHtml(redact(verdict))`。
7. **steer 事件不触发跨客户端刷新**：`app.js:2956` 的 scheduleRunsReload 正则不含 `run.steer_queued/dropped`（主驾已验证），其他客户端 run rail 的 pendingSteer 会陈旧（会话注记仍实时可见）。
8. **新增测试断言偏弱**：`tests/orchestrator.test.mjs:402-412` 只断言 `typeof === "number"`，未覆盖旧适配器缺字段、空字符串、drift exit 1 / missing 输出等本次评审暴露的边界。

## 可保留（看似奇怪但合理）

1. **XSS 主链查证无漏网**：steer 治理注记 `:2073` redact → `:2115-2117` escapeHtml；turn-meta `:2109-2111`、候选表 `:2710-2714`、漂移表 `:959-962`、失败文本 `:903` 均 escapeHtml；状态 class 全部来自固定三元分支，无属性注入路径。Codex 独立复核 + 主驾复核双确认，未发现可构造突破。
2. **PSModulePath 剥离正确且无副作用**：`childProcessEnv`（process-runner.mjs:72-84）spread 拷贝，`delete env[key]` 不污染 process.env；大小写不敏感遍历删除正确。Codex 在只读沙箱实调 `drift()` 成功返回 15 对 consistent、并发第二请求得 RUNTIME_BUSY——正常路径 driftBusy 契约成立。
3. **超时路径 exitCode 不会误判**：`observability.mjs:206-209` timedOut 分支优先 reject timeout，不落 exitCode 判断；5 秒兜底 reject 后进程可能残存导致理论上的二次 spawn 重叠，属已注释承认的低概率既有取舍。
4. **turn-meta 旧事件兼容**：无 tokens/costUsd/effectiveModel 字段时省略对应段不抛异常；字符串数字正常格式化。
5. **runDriftCheck 失败行不会被覆盖**（主驾 R2 疑点，Codex 核实修正）：失败时 `state.obsDrift = null`，后续 `renderObservability` 的 `if (drift)` 跳过 obs-drift-body，失败行保留。
6. **fixture 加 tokens/costUsd 不影响既有断言**：既有测试无对 turns/response 形状的 exact deepEqual；新断言含 `turnEvents.length >= 1` 门槛，不会空转通过。

## 总评

波次2 的前端转义链与正常态呈现扎实（XSS 零漏网、旧事件兼容、诚实空态），但两条致命：P0 是本批亲手引入的退出码语义回归——修"假自信"的那只手把"真漂移"改成了"检查失败"，核心功能在最需要它的场景下不可达；P1 是本批呈现层照出的既有队列竞态，用户指令可能静默丢失或重复执行。P0 修复归本批返工，P1 单独派工。Codex 在只读沙箱做了 `node --check`（三文件通过）与 drift 零态冒烟实证；`npm test` 因沙箱禁 mkdtemp 有 62 例 EPERM，不构成回归证据（以主驾侧 97/97 为准）。

---

## 下游建议

### 建议召唤
- **Codex 技术执行者**（executor profile）：P0 修复（sync-runtime.ps1 退出码三分 + drift() 适配 + missing 行解析）与 P1 修复（save per-run 串行化）均为边界清晰的独立模块攻坚，适合派工后主驾复核。
- **修复后回炉**：threadId `019f756a-7bbf-7231-9d65-66f83dada46d` 仍在，reflection 复检可 codex-reply 同会话续聊，Codex 保留本轮全部上下文。

### 风险信号
- P1 属并发/持久化正确性问题，修复需补并发测试（门闩式，参考 tests:361-400 现有模式），不宜只靠人工推演验收。
- 漂移面板在修复前对"有漂移"环境不可用——若近期跑 sync-runtime 校验请直接用 CLI，勿信 Console 面板的"检查失败"。

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛 | 1 | architecture | 致命#1 P0（observability.mjs:213 exit-code 语义与 sync-runtime.ps1:58 契约相撞，主驾预判+Codex 独立双确认）+ 致命#2 P1（orchestrator.mjs:107-115 save 竞态，Codex 独有发现、主驾读盘确证）
