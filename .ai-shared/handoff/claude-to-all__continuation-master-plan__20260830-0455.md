# 514cc v44 蓝图 · 接续总纲

> **本文用途**：任何人（或任何 agent）只读这一篇，应能在 10 分钟内说清
> 「现在在哪、什么做完了、剩下什么、从哪下手、哪些雷不能踩」。
> **基线蓝图**：`proposals/v44-completion-blueprint.md`（372 行，122 个功能点 + 4 个待拍板决策）
> **本文状态**：2026-08-30 04:55 写就，基于实际读盘核验（非转述）
> **上一棒**：烛（Claude 面），止于 F-047 实现落地、测试未写

---

## 零、30 秒速览

| 波次 | 规模 | 状态 |
|---|---|---|
| **W0 地基波** | 12 项 | ✅ **已收口**（`claude-to-all__w0-foundation-closeout__20260830-0052.md`） |
| **W1 解耦波** | 7 项 | 🔴 **0% 未动**（体积证据见 §2） |
| **W2 Bot Shell** | 8 面 | 🟡 部分（另有 agent 在做 composer / budget） |
| **W3 治理收口** | 8 项 | 🔴 未动 |
| **W4 安全加固** | 10 项 | 🟡 **5 项闭合 / 1 项半成品 / 4 项未动** |
| **W5 拓展** | X-001~X-035 | 🔴 未动，**需 LO 勾选才开工** |
| 其余完善点 | F-005~F-042、F-057~F-092 | 🔴 绝大多数未动 |

**一句话**：安全 P0 已经打完，地基已经打完，**主体工程量（解耦 + 产品 + 治理 + 观测）基本还没开始**。

---

## 一、当前进度快照（已闭合，均有证据）

| 项 | 内容 | 证据 |
|---|---|---|
| **W0** | 地基波 12 项全收口 | W0 完工 handoff |
| **F-003b / F-004** | 提交前密钥闸门 | `.githooks/pre-commit`（只扫新增行、排除占位符、支持 `# gitleaks:allow`） |
| **F-044** | SSRF 出站白名单 | 新增 `src/security/egress-guard.mjs`，覆盖 webhook/remote-projects/ssh |
| **F-046** | 路径穿越审计 | ✅ **查证后确认已闭合，非缺口**——蓝图「待查证」偏保守 |
| **F-047** | 审批面收敛 | 🟡 **实现已落盘、测试未写**（详见 §3） |
| **F-048** | event-store 哈希链防篡改 | `ff014db`，`tests/event-store-chain.test.mjs` 15/15 |
| **F-051** | lockfile 完整性 | 🟡 `scripts/dep-integrity.mjs` 已存在但**未入库、无 handoff 认领** |
| **F-052** | 凭据清单审计 | `scripts/secret-audit.mjs`（`5dc6d00`） |
| **F-053** | 脱敏契约健壮性 | `sanitizeForPersistence` 覆盖面修复 |

### 远端与提交

- 远程：`git@github.com:lanniny/514-bot.git`，**GitHub 公开仓库（`private=false`）**
- 实际推送通道：`https` + `http.proxy=http://127.0.0.1:7897`（**SSH 被假 IP 代理阻断，别再试**）
- `origin/main` 停在 `97be339`
- **本地未推送**：`ff014db`（F-048）、`1284dc0`（runbook 坑 3）
- 工作区另有 **11 个文件属另一个 agent 的未提交改动**，见 §5

---

## 二、W1 解耦波：零进展（硬证据）

蓝图基线 vs 当前实测：

| 文件 | 蓝图基线 | 2026-08-30 实测 | 结论 |
|---|---|---|---|
| `src/orchestrator.mjs` | 323 KB | **320 K** | 未拆 |
| `src/providers.mjs` | 191 KB | **188 K** | 未拆 |
| `public/app.js` | 1.58 MB | **1.6 M** | 未拆，**还涨了** |
| `public/index.html` | 295 KB | **292 K** | 未模板化 |

**W1 是最高风险波次**（蓝图 §7 明示）：323KB orchestrator 拆分可能引入回归。
护栏：**先补契约测试再动刀，每切一刀跑全量测试。**

**W1 开工前置**：必须先回答「是否引入极薄 esbuild」（蓝图倾向：引入，仅 bundle + minify，不做转译）。
这个决策不定，W1-3 / W1-4 就无法启动。→ **需 LO 拍板**

---

## 三、F-047 审批面收敛：半成品，接手请先补测试

**已完成**（`src/approval-broker.mjs` 167→316 行 + `server.mjs` 3 处）：

1. **容量闸**（此前 pending 无上限）
   - `maxPending=128` / `maxPendingPerRun=32`，超限抛 `APPROVAL_CAPACITY`（`statusFor` → 429）
   - **拒绝受理**而非淘汰最老的或自动批准——后两者都会凭空造出一条从没人做过的「操作者决策」
   - 被拒请求另发 `approval.capacity_rejected` 留痕（审计 best-effort，不阻断拒绝本身）
2. **审计挂起兜底**（真 bug）
   - 原代码在写审计前已 `clearTimeout` 且置 `status="resolving"`。一旦 `emit` 不 settle，
     该审批就**永久卡死**——超时器已清、`resolve` 又不可重入，调用方拿不到答复，UI 也看不见
   - 新增 `#audit()`：`Promise.race` 套 5s 上限（timer 必须 `unref`），超时走与
     `APPROVAL_AUDIT_FAILED` 相同的 fail-closed 分支（恢复 pending + 重排 TTL）
3. **actor 不再自证**（与 F-048 的连带风险）
   - 原本 `actor` 直接取自请求体，写进 F-048 的**不可篡改**哈希链
   - 一个「不可篡改却写着自证身份」的字段比没有这个字段更危险——事后调查会把它当事实读
   - 改为三件套：`actor`（服务端盖章 `"local-operator"`）+ `actorSource`
     （`local-bearer`/`policy`/`internal`/`self-asserted`）+ `clientActor`（自称身份留档、不得当证据）
   - 控制面只有一份共享 bearer 凭证，所有持有者等价，所以 `actor` 标识的是**凭证**不是**人**——
     账本不假装记录它鉴别不了的东西
4. 附带：`responseFor` 在 `resolve` 里是**校验闸门不是取值**（宽权限授予 approve 会抛错），
   已加注释防止后人当死代码删；抛错时改为**立即按策略拒绝结算**，不再让 agent 干等到 TTL
   `denyAll`/`denyRun`/`expire` 的终态事件补 `actionSha256`，三类终态事件形状对齐

**未做（接手的第一件事）**：
- [ ] **补测试**：容量闸（全局/单 run 两种超限）、审计超时（emit 挂起 → fail-closed 恢复）、
      actor 三件套、宽权限授予 approve 立即拒绝
- [ ] 热重载同步：`app.mjs:539` 目前只同步 `ttlMs`，未同步 `maxPending`
- [ ] 上限进配置：需先改 `schemas/control-center/contracts.schema.json` 的 `approval`
      ——它是 `additionalProperties: false`，直接加键会破坏校验

**回归基线**：既有 `approval-lock` / `approval-snapshot` / `approval-runbuild-card` **14/14 通过**。

---

## 四、剩余全部计划（按建议顺序）

### 4.1 立刻可做（无需等 LO）

#### A. F-047 补测试 ← **接手先做这个**
见 §3。预计 1 小时。

#### B. W4 安全加固波剩余 4 项

| 项 | 内容 | 优先级 | 备注 |
|---|---|---|---|
| **F-049** | 非 Codex provider 子进程权限边界（Kimi 已 fail-closed，其余待查） | P1 | 蓝图标「部分验证」 |
| **F-045** | CSP：Tauri WebView + 浏览器双形态 | P1 | ⚠️ 碰 `public/index.html`，与并行 agent 冲突 |
| **F-050** | CC-Switch updater `blocked_external_trust` → 自建签名公钥 + 更新端点 | P2 | 蓝图标「已验证」，解封 X-013 的前置 |
| **F-043** | `exceljs@4.4.0` 11 high + 1 moderate → 评估替换/隔离 | P1 | **禁 `npm audit fix --force`** |
| **F-054** | token 轮转与失效审计（127.0.0.1 + ephemeral token 已有） | 低 | |
| **F-055** | 附件/头像（`avatars.mjs`）类型与大小校验审计 | 中 | |
| **F-056** | Tauri 壳崩溃快照与自动上报（30s 看门狗已有） | 中 | |
| **W4-10** | 安全测试层：注入 / 穿越 / SSRF 自动化用例 | P1 | 应随上面各项同步累积 |

#### C. F-051 收尾
`scripts/dep-integrity.mjs` 已在盘上但**未入库、无任何 handoff 认领**（疑为上下文压缩前的手笔）。
接手请先核验内容 → 跑一遍 → 补一个 handoff 说明归属，再入库。

#### D. 观测与可运维 F-057 ~ F-068（12 项，全未动）
价值密度高、风险低，适合在解耦波之前做（解耦时正好需要观测兜底）：
F-059 全链路 trace id（高价值）、F-060 `/healthz`+`/readyz`（低成本）、
F-063 崩溃快照（与 F-056 协同）、F-066 容量配额与归档（防磁盘膨胀）、F-067 备份恢复演练。

#### E. 治理收口 W3 / F-069 ~ F-080（8 项，全未动）
软纪律下沉为机械检查。F-074 `context.md` 自动摘要（从 decisions/handoff 抽取）价值最高——
它直接解决「context.md 手工维护会过期」这个根因。

#### F. UX 与设计系统 F-081 ~ F-092（12 项，全未动）
F-084 首屏（1.58MB app.js 拆包，**高价值**，但与 W1-3 是同一件事，建议合并做）、
F-089 i18n（高成本高价值，取决于是否团队化）。

#### G. 架构与测试 F-005 ~ F-042
除 F-003/F-004 外未在 `context.md` 见到闭合标记，**接手时需逐项查证后再下结论**
（教训：F-046 查证后发现是「已闭合非缺口」，蓝图标记不可全信）。

### 4.2 需 LO 拍板才能动

| # | 决策 | 阻塞什么 |
|---|---|---|
| 1 | 🔴 **轮换 `tEP1_` 令牌** | 见 §6，**我无法代做** |
| 2 | **是否引入极薄 esbuild** | 阻塞 W1-3 / W1-4 / F-084 |
| 3 | **bot 是否作为默认桌面入口**（保留 `#/workbench` 兼容） | 阻塞 W2 全部 |
| 4 | **W5 拓展勾选**（X-001~X-035，35 项） | 阻塞 W5 |
| 5 | **版本升格 v4.0.0** | 纯决策，成本最低 |
| 6 | 是否 `git filter-repo` 重写历史清令牌 | 选修，须先轮换 |
| 7 | `.ai-shared/backups/` 的 1746 处凭据命中是否清理 | 见 §6 |

### 4.3 W5 拓展清单（X-001~X-035，**待 LO 勾选**）

- **高贴合（本体强化，X-001~X-010）**：指令化 CLI、IDE 集成、会话模板/剧本、
  回放与时光机、反馈学习环、基准测试套件、知识库/RAG、结果仲裁器、
  跨 CLI 上下文迁移、能力矩阵自动回归
- **中贴合（产品化协作，X-011~X-025）**：RBAC、自定义代理、插件市场门闩（解 W4-8）、
  云端电脑、定时任务编排、出向 Webhook、批量任务队列、多工作区、移动/远程安全访问、
  通知系统、产物管理、终端共享、PR 评审工作流、审计导出、数据可携带性
- **探索性（X-026~X-035）**：成本中心配额、自进化引擎、跨设备同步、语音/多模态、
  代理市场、本地模型支持、沙箱快照回滚、语义化版本推导、对抗性红队、可视化编排画布

---

## 五、工作区现状与协作红线

### 另一个 agent 的未提交改动（**不要碰**）
`src/orchestrator.mjs`、`src/app.mjs`、`src/adapters/claude-cli.mjs`、`src/social-contract.mjs`、
`public/app.js`、`public/index.html`、`public/styles.css`、`public/forge/*.css`、
`tests/orchestrator.test.mjs`、`tests/social-contract.test.mjs`、`schemas/.../contracts.schema.json`

内容是**预算「无限」功能**：`UNLIMITED_BUDGET="unlimited"` 哨兵、`isUnlimitedBudgetValue()`、
`budgetHardMaxFromLimits()`。另有其 handoff
`claude-to-all__budget-unlimited-and-composer-ui__20260830-0406.md`（未入库）。

→ **纪律：一律显式 `git add <具体文件>`，绝不 `git add -A`。** 否则会把别人的半成品带进提交。

### 已知失败项（需重新定性）
`orchestrator` 121/122、`conversations-http` 0/1。
我此前判为「存量失败」，但 `conversations-http` 的断言正是
`assert.ok(continuedRun.maxBudgetUsdPerTurn < 2)`，与并行 agent 的预算改动**高度吻合**——
**很可能是它的改动导致，不是真正的存量问题**。待其提交后重验，不要直接沿用我的旧结论。

### 环境
- control-center **服务进程正在运行**：`.ai-shared/control-center/` 下 `children.json`、
  `events.jsonl`、`runs/*.json` 持续写入。改源码后它不会自动重载，手动验证时注意
- Node 用受管版本：`C:/Users/16643/.workbuddy/binaries/node/versions/22.22.2-2/node.exe`
- 测试：`node --test tests/<file>.mjs`（`node scripts/run-tests.mjs` 跑全量）

---

## 六、🔴 未解风险：令牌仍在公开历史

**`lanniny/514-bot` 是公开仓库。**

`origin/main` 的 `6077930`（2026-08-13）中仍有明文 CC-Switch 代理 token（`tEP1_` 前缀，
监听 `127.0.0.1:15721`）。新 clone 的工作树里已取不到该文件，但 `git log --all` 能翻出来。
**截至本文，暴露约 17 天。**

- 处置顺序：**先轮换**（只有 LO 能做），**再谈** `git filter-repo` + force push（选修）
- 教训已记录：**索引干净 ≠ 历史干净**。判断凭据是否泄漏必须扫历史，不能只看 `git status`

另一个待决项：`.ai-shared/backups/` 有 **1746 处凭据命中**（已 gitignore）。
目前安全，但**一次 `git add -A` 就会全部暴露**。是否清理需 LO 决定。

---

## 七、工具与操作陷阱（本轮血的教训）

1. **🔴 `Read` 可能返回幻觉内容**
   本轮 `Read` 把 `approval-broker.mjs` 渲染成「两套实现拼接」的幻影
   （同时含 `APPROVAL_LIMITS`/`positiveLimit`/`withAuditTimeout` 与 `DEFAULT_MAX_PENDING`/`#audit`），
   磁盘真相（md5/行数/grep）只有其中一套。
   → **对任何文件做 Edit 前，若 Read 结果可疑，先用 `grep -n` / `md5sum` / `sed -n` 取证。**

2. **🔴 `Edit` 报 "String to replace not found" 可能是假阴性**
   本轮连续 5 次报 not found，**其中至少 3 次改动其实已经写进去了**。
   → **报 not found 后先 `grep` 确认改动是否已落盘，再决定要不要改写 old_string。**
   否则会重复写入，严重的会覆盖别人的工作。

3. **🔴 绝不用 `git show HEAD:<path> > <path>` 做 A/B 对照**
   它会直接覆盖工作树。曾因此丢失一整份 F-048 实现（后重新实现并 amend 补救）。
   → 用 `git worktree add`；必须备份时备份到项目外，**提交前不要删**。
   详见 `.ai-shared/git-recovery-runbook.md` 坑 3。

4. **`git` 写 `refs/remotes/*` 会删掉整个目录**（实测复现，`git fetch` 也会触发）
   → 查远端状态用 `git ls-remote`，不要用 `git update-ref` 碰 `refs/remotes/*`。

5. **校验「检查器」时必须用构造的恶意 fixture 实证**
   一个跑得通但抓不到问题的检查器只是装饰品。F-051 的审计器是用
   含未登记 registry / 缺 integrity / 声明漂移 / 版本漂移的假 lockfile 验证过的。

6. **推送经验**：单次 push 可能超过 120s 前台超时被 SIGTERM。
   → 用后台任务跑，事后用 `git ls-remote` 确认是否真的生效。

---

## 八、建议接续顺序

```
1. F-047 补测试（1h，收尾自己开的头）
2. F-051 核验 + 归属说明 + 入库（30min）
3. 请 LO 轮换 tEP1_ 令牌（🔴 阻塞项，只等不干等 —— 发完提醒就往下走）
4. F-049 子进程权限边界（安全 P1，不碰前端，无冲突）
5. F-043 exceljs 漏洞评估（供应链，独立）
6. F-059/F-060/F-063 观测三项（低风险、为 W1 铺路）
7. —— 等 LO 回答 esbuild / W5 勾选后 ——
8. W1 解耦波（按契约测试先行、每刀全量跑的护栏推进）
```

**不要**在 W1 完成前开始 W2/W5 的新功能（蓝图 §7 明示：证据链不可信时新功能无法被验证）。

---

## 九、事实来源（本文核验依据）

- `proposals/v44-completion-blueprint.md`（372 行，蓝图原文）
- `.ai-shared/context.md`（进度记录，注意 Bash 下 grep 输出为 GBK 乱码，**用 Read/Grep 工具读**）
- `.ai-shared/handoff/claude-to-all__w0-foundation-closeout__20260830-0052.md`
- `.ai-shared/handoff/claude-to-all__f048-event-store-hash-chain__20260830-0345.md`
- `.ai-shared/git-recovery-runbook.md`（坑 1/坑 3）
- `.workbuddy/memory/2026-08-30.md`（当日工作日志，含并行 agent 检测记录）
- 本轮实际读盘：`git status`、`git log`、`du -h`、`node --test`、`--check`

---

`__DELTA__: 烛(Claude) | 3`
