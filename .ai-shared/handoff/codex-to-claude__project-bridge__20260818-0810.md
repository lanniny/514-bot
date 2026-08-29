---
from: 烛(codex-reviewer)
to: claude
topic: project-bridge
mode: standard+security
date: 2026-08-18
time: 08:10
scope: R1-01 稳定项目锚点 + Bridge Doctor
codex_channel: cursor-subagent-readonly
threadId: null
note: 无 codex-agent MCP；本轮为烛 subagent 只读评审，不伪装对话桥连续。
---
<!-- 514cc-session-id: 2e5d4b63-9955-451a-96d9-ddc4ffedee71 -->
# Codex 评审：R1-01 项目锚点 + Bridge Doctor

- **评审模式**：standard + security
- **评审范围**：`apps/control-center/src/project-bridge.mjs`；`apps/control-center/tests/project-bridge.test.mjs`；`apps/control-center/src/workbench-environment.mjs`（projectBridge 可选字段）；`apps/control-center/src/app.mjs`（projectAnchors）；`apps/control-center/server.mjs`（environment 附带 / GET /api/project-bridge）；`apps/control-center/public/environment-panel.js`；`apps/control-center/public/api.js`；`apps/control-center/tests/workbench-environment-ui-contract.test.mjs`；`apps/control-center/tests/workbench-environment-http.test.mjs`
- **评审时间**：2026-08-18 08:10
- **Codex 模型**：Cursor Grok 4.6（烛 subagent，只读）
- **总 token**：n/a（未走 Codex CLI）
- **批准边界**：只评 R1-01 锚点 / 四面快照 / 环境舱复用 / 客户端路径面。不升格正式版本，不评 R0 传输或 shutdown。

---

## 致命问题（必须改）

本轮已接线路径上，没有发现会让 R1-01 合同失效、或让客户端用 query 指定任意路径的必须改缺陷。

主驾三条判断全部成立，未被推翻。下面的条目是补强，不是改判。

---

## 建议改进（值得讨论）

1. **「路径移动保持 anchorId」只锁了 store，没有锁 `collectProjectBridge`。** `repositoryFingerprint` 把 `pathKey(gitCommonDir)` 编进指纹（`apps/control-center/src/project-bridge.mjs:46-50`），而 `inspectSource` 会把 `--git-common-dir` 相对结果 `resolve` 成新目录下的绝对路径（`148:148:apps/control-center/src/project-bridge.mjs`）。普通 `git init` 仓库整棵搬走后，common-dir 路径变了，指纹和 `anchorId` 都会变，`relocated` 也不会亮。`51:73:apps/control-center/tests/project-bridge.test.mjs` 是把同一个手工 fingerprint 喂给 `resolveProjectAnchor`，所以测试是绿的，验收句「路径移动」容易被读成「用户挪了文件夹还能认出来」。真能跨目录保住身份的，只有 common-dir 本身不动的情况（worktree / 分离 gitdir）。补强：补一条真实 `rename` + 再 `collect` 的回归，并在诊断里写清「整库搬走 = 新身份」。

2. **主驾判断 1 没有对应测试。** 「无 git 时 fingerprint 跟路径走，移动即新身份」在代码里成立（`50:50:apps/control-center/src/project-bridge.mjs`），但 `project-bridge.test.mjs` 没有非 Git 目录搬家用例。以后若有人把 path fingerprint 改成「尽量粘住」，这条诚实合同会 silently 丢。

3. **活路径「不能绿」也没有 HTTP 锁。** `1001:1006:apps/control-center/server.mjs` 与 `1038:1047:apps/control-center/server.mjs` 都不传 `evidence`。`classifyBridgeConsistency` 要四面都是 `ok` 才 `consistent`（`100:100:apps/control-center/src/project-bridge.mjs`），缺 evidence 只能落到 `unknown`（源缺失时也被强制 `unknown`，`97:97`）。`workbench-environment-http.test.mjs` 只断言 schema / `anchorId` 形态（`194:195`），没断言日常 `consistency !== "consistent"`，也没打 `GET /api/project-bridge?cwd=`。

4. **进程面几乎恒绿。** `processStatus` 只要 `processes` 是数组就是 `ok`（`195:195:apps/control-center/src/project-bridge.mjs`），空数组也算。活 API 永远传入 `childRegistry.snapshot()`，所以这一面不会把一致性拉成 stale/unknown。语义上它更像「有快照」而不是「项目进程健康」。

5. **`headDigest` 名不副实。** `208:208:apps/control-center/src/project-bridge.mjs` 把完整 HEAD SHA 放进 `headDigest`，环境舱原样展示（`174:174:apps/control-center/public/environment-panel.js`）。这不是密钥泄露——环境舱本就在分支行展示 `git.head`——但和「敏感内容只 digest/状态」的字面合同、以及字段名都不齐。快照里的 `canonicalCwd` / `previousCwd` 同样是绝对路径；面板没画它们，HTTP 仍会带出。

6. **锚点 store 不回收旧 cwd 键。** `remember` 只 `set` 新 cwd（`70:70:apps/control-center/src/project-bridge.mjs`），搬家后 `byCwd` 仍留着旧路径。当前 `anchorId` 是指纹纯函数，不会因此错发身份，但 store 会膨胀，读代码的人容易以为 cwd 索引是唯一真源。进程重启后 store 清空也不影响 `anchorId` 重算，只丢 `relocated` / `previousCwd` 记忆。

7. **浅克隆 / 多 root 会改 fingerprint。** `firstCommit` 取 `rev-list --max-parents=0` 的第一个 token（`149:149:apps/control-center/src/project-bridge.mjs`）。浅仓拿不到 root 时走 `"no-commit"`；unshallow 或出现第二个 root 后指纹会跳。少见，但和「不可变 anchorId」在时间轴上不完全同义。

---

## 可保留（看似奇怪但合理）

1. **无 git 时 fingerprint 跟路径走。** `50:50:apps/control-center/src/project-bridge.mjs`。没有对象库身份可粘，搬家就是新项目。主驾判断 1 成立，这是诚实，不是漏做。

2. **活 API 不传 evidence，日常不能绿。** `1001:1006` / `1038:1047:apps/control-center/server.mjs`。`evidence` 面停在 `unknown`（`197:203:apps/control-center/src/project-bridge.mjs`），`classifyBridgeConsistency` 因此回 `unknown`。源缺失时诊断写「不能称为项目已接通」（`240:241`）。主驾判断 2 成立；单元测试里的 `consistent` 只在注入当轮 evidence 时出现（`151:165:apps/control-center/tests/project-bridge.test.mjs`），那是合同上限，不是舱里的日常色。

3. **`GET /api/project-bridge` 忽略 cwd query。** `1032:1039:apps/control-center/server.mjs` 只吃 `runId`，cwd 来自 `attestRunWorkspace` / `repoRoot`。相对路径在 `normalizeProjectCwd` 直接拒绝（`36:38:apps/control-center/src/project-bridge.mjs`，`32:35:apps/control-center/tests/project-bridge.test.mjs`）。主驾判断 3 成立。`run.cwd` 仍可能指向任务目录，但那是已登记 run 的工作区，不是本端点的客户端路径注入。

4. **复用环境舱，不新建仪表盘。** `projectBridge` 是 `collectWorkbenchEnvironment` 的可选字段（`318:319:apps/control-center/src/workbench-environment.mjs`）。面板在既有 expandRow 里画项目桥（`160:177:apps/control-center/public/environment-panel.js`），`validateWorkbenchEnvironment` 不强制该字段（`34:41`）。`API.projectBridge` 只是同构只读入口（`66:66:apps/control-center/public/api.js`），`app.js` 的舱仍走 `API.workbenchEnvironment`。

5. **`projectId` 跟路径、`anchorId` 跟指纹。** 搬家（在指纹不变时）会换 `projectId`、留 `anchorId`（`69:69:apps/control-center/tests/project-bridge.test.mjs`）。这是两层身份，不是互相打脸。

6. **内存 store + 确定性 ID。** `402:402:apps/control-center/src/app.mjs` 的 `createAnchorStore()` 不落盘。重启丢的是 `relocated` 记忆，不是锚点本身——`anchorId` 可从指纹重算。

7. **`git -C` 走 `runProcess` + `shell: false`。** 参数是 argv，不是拼进 shell。`provider: null` 避免给探测进程挂供应商密钥。和既有环境舱 Git 探针同一纪律。

---

## 总评

R1-01 的安全面是收住的：绝对路径由服务端从 run / 控制面根解析，query `cwd` 被丢掉，相对路径 fail-closed，舱里只多了一行项目桥而不是新仪表盘。主驾三条判断我独立核对后都成立——无 git 搬家即新身份、活 API 因缺 evidence 不能绿、独立 GET 不吃客户端路径。

真正的缺口在验收锁，不在活路径被绕开。「路径移动」目前只证明 store 在指纹不变时会标 `relocated`；普通仓库整棵 `mv` 会换指纹。建议补真实 rename / 非 Git 搬家 / 活路径 `consistency !== consistent` / `?cwd=` 被忽略四条回归，避免下一轮把「有 git 就能跟着走」读进合同。

---

## 下游建议

### 建议召唤
- 不需要织。没有外部 CVE / 实时情报依赖。
- 若主驾要把「整库搬走仍认同一锚点」写成硬合同，再叫策抽一版身份规格（common-dir vs first-commit vs 路径）。

### 风险信号
- 测试绿 ≠ 用户挪文件夹还能认出来。
- 环境舱日常会停在 unknown，不要把「不能绿」当成回归失败。

__VERDICT__: APPROVED
__DELTA__: 烛(Codex) | 1 | correctness | 证据：apps/control-center/src/project-bridge.mjs:46 普通仓库 mv 会换 fingerprint，路径移动测试只锁了 store
