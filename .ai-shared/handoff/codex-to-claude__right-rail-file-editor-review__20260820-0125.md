---
agent: 烛
mode: security+correctness
topic: right-rail-file-editor
scope: public/mission-control.js, public/app.js, public/styles.css, public/modules/rail-panels.js, src/workspace-explorer.mjs, server.mjs, related tests
reviewed_at: 2026-08-20 01:25
r2_reviewed_at: 2026-08-20 01:36
r2_verdict: APPROVED
codex_channel: unavailable-mcp
---
<!-- 514cc-session-id: 51e0d6b6-7f4e-4e0d-b4f0-c0c9b89c5f5a -->

# Codex 评审：右侧栏双入口文件直接编辑保存

- **评审模式**：security + correctness（deep-review 交叉）
- **评审范围**：`apps/control-center/public/mission-control.js`、`public/app.js`、`public/styles.css`、`public/modules/rail-panels.js`、`src/workspace-explorer.mjs`、`server.mjs`、`tests/workspace-explorer.test.mjs`、`tests/mission-control-http.test.mjs`、`tests/workbench-rail-and-tools-contract.test.mjs`
- **评审时间**：2026-08-20 01:25
- **Codex 模型**：本会话 `codex-agent` MCP 未注册；降级为烛只读源码+测试交叉审，未跑 `codex exec`
- **总 token**：n/a

---

## 致命问题（必须改）

1. **[rail-panels.js:336-378][rail-panels.js:487-523][app.js:18975-18977]** 文件页保存的迟到响应会污染当前预览；切 run / 关工具页都拦不住。  
   `saveCurrentFile()` 成功后只判断 `aborted` 与 `fileSaveGeneration`，**不**核对 `getRunId() === snapshot.runId`，也**不**核对当前预览 path 是否仍是这次保存的文件。  
   切 run 时 `syncRailToActiveRun()` → `activate()` 会 `filesGeneration++` 并 `abort` **目录**请求，但 **不** `fileSaveGeneration++`，也 **不** `fileSaveController.abort()`。`reset()` 同样漏掉保存世代（且全仓没有调用方）。  
   利用场景：对 run A 的 `notes.md` 点保存 → 立即切到 run B（或点开另一文件）→ 先前 PUT 200 返回 → `renderFilePreview(value)` 把 A 的内容画进当前预览，并 `notify("已保存 …")`。这直接打穿「切 run / 迟到响应不污染当前 UI」。

2. **[mission-control.js:579-617][mission-control.js:638-654]** 任务上下文入口对「切 run / 关面板」做对了，对「同 run 换文件」的迟到保存没做。  
   `hideWorkspace()` / `selectRun()` 会 `workspaceSaveController.abort()` 且 `workspaceSaveGeneration++`（`mission-control.js:422-428`、`863-870`），切 run 与关面板安全。  
   但 `fetchWorkspace()` 只推进 `workspaceGeneration`、abort **读取**控制器，保存世代不动。成功回调仍是：

   `generation !== workspaceSaveGeneration || selectedRunId !== snapshot.runId` 通过后无条件 `renderWorkspace(value)`。

   利用场景：保存 `src/a.js` 进行中 → 点开 `src/b.js` 或返回目录 → 保存返回 → 浏览器被重绘成 `a.js` 的新内容，覆盖用户正在看的节点。与文件页同一类归属漏洞，双入口并不对称。

3. **[workbench-rail-and-tools-contract.test.mjs:311-341]** 回归网是源码正则，测不出上述竞态。  
   合同只断言两入口都有 `editable` / `PUT` / `expectedRevision` / `#lucide-`，**没有**「保存世代在切 run/换 path 时递增」「成功回调比对当前 view identity」的行为测试。这会让致命 1/2 在 CI 里持续绿灯。

## 建议改进（值得讨论）

1. **[workspace-explorer.mjs:593-602]** 写路径仍留 Windows 强制 `closeTarget()` 之后、`rename` 之前的 TOCTOU 窗口（CWE-367）。  
   读路径有 `sameFileVersion` / `sameHandleIdentity` / 拒绝 symlink·junction·hardlink（`nlink !== 1`），且 `tests/workspace-explorer.test.mjs:323-346` 覆盖了 **inspect** 的替换竞态。写路径在关掉只读句柄后不再二次核对 path identity。本地 Console + Bearer 下利用面窄，但与「TOCTOU 守卫未被绕过」的字面验收不完全相等。更稳的是 rename 后立刻 `lstat`+identity 断言失败则 fail-closed，或换 Windows 允许「持句柄替换」的 API。

2. **[server.mjs:2200-2214]** workspace GET/PUT 在 `orchestrator.get(runId)` 为空时把 `undefined` 丢进 explorer，得到 `VALIDATION_FAILED`「run is required」（422），而同文件其他 run API 用 `RUN_NOT_FOUND`（404，见 `server.mjs:2340`）。不是越权，但是探测面与错误码不一致。应在调用 `inspect`/`update` 前显式 404。

3. **[rail-panels.js:121-122][rail-panels.js:271-288]** 文件页用 `fileDrafts` 按 `runId:path` 恢复未保存稿；任务上下文入口没有草稿层。协议都是同一 PUT + `expectedRevision`，但交互语义（关预览是否丢稿、换文件是否带回草稿）不一致。若验收要求「两条入口语义一致」，应要么两边都持久化草稿，要么文件页也做成关闭即丢。

4. **[rail-panels.js:343-345] vs [mission-control.js:586-589]** 并发保存两边都会 abort 上一次 fetch，这点对齐。服务端仍可能把已发出的 PUT 做完；UI 必须以 view identity 丢弃结果（回到致命 1/2），不能只靠 AbortController。

5. **[workspace-explorer.mjs:570-578]** `expectedRevision` 正则允许大小写，比较却是大小写敏感；摘要来自 `digest("hex")` 小写。客户端若误传大写会 409 而非覆盖——fail-closed，可在服务端 `toLowerCase()` 减少误伤。

## 可保留（看似奇怪但合理）

1. **路径 / 敏感名 / 内容守卫（服务端）是实打实的。** `cleanRelativePath` 拒绝绝对路径、盘符、`..`、设备名与敏感段（`workspace-explorer.mjs:134-146`）；listing 跳过敏感目录/文件（`461`）；内容 `scrub` 不一致或高熵则不可编辑（`197-201`、`530-532`）；硬链/符号链接/junction 在 inspect 与 update 共用 `resolveTarget`/`verifyTarget`。HTTP 层：过期 revision → 409 `WORKSPACE_VERSION_CONFLICT`（`mission-control-http.test.mjs:336-342`），遍历 → 422 `PATH_BOUNDARY`（`344-348`）。**expectedRevision 冲突不会覆盖磁盘**，这一条我验证了。

2. **原子替换形态合理。** `O_CREAT|O_EXCL|O_NOFOLLOW` 写临时文件 + `sync` + `rename`（`581-602`），失败 unlink；测试断言临时文件不残留（`workspace-explorer.test.mjs:128`）。Windows 必须先关目标句柄才能 rename，注释（`598-601`）不是偷懒。

3. **动态 SVG 目前都是 Lucide。** 任务上下文用 `createElementNS` + `#lucide-${lucideName}`（`mission-control.js:117-132`）；文件页 `icon` 注入 `lucideIcon()`（`app.js:22285`）。保存/还原按钮引用 `save` / `rotate-ccw`，sprite 合同有对应 id（`workbench-rail-and-tools-contract.test.mjs:336-338`）。未见 emoji 或内联 path 手绘图标。

4. **XSS 面在编辑器里是收住的。** 文件页 textarea 走 `escapeHtml(content)`（`rail-panels.js:311`）；任务上下文用 DOM `textarea.value`（`mission-control.js:550-552`），不走 innerHTML。PUT 带 Bearer（`api.js:148`，路由在 `authorized` 之后）。

5. **样式层无新攻击面。** `styles.css` 的 `.workspace-file-editor*` 与 `forge/rail-tools.css` 的 `.rail-files-editor*` 只是布局/dirty 色，不拼接用户 HTML。

6. **app.js 接线本身干净。** 两入口都打 `PUT /api/runs/:id/workspace?path=` 且 body 为 `{ content, expectedRevision }`（`app.js:22314-22321`，`rail-panels.js:354-360`）。问题在回调归属，不在 API 形状。

## 总评

服务端工作区编辑器（路径边界、敏感名、脱敏/高熵、revision 乐观锁、原子 rename）与 HTTP 409/422 契约是扎实的，**不能**因为 UI 竞态把整段写盘判成可绕过。  
前端双入口在「能不能保存」上对齐了，在「保存结果属于谁」上没有对齐：文件页切 run/迟到 PUT 会画错预览；任务上下文关面板/切 run 安全，换文件不安全。合同测试目前证明不了用户点名的那四条时序。  

**判决（R1）：CHANGES_REQUESTED。** 先把保存成功/失败回调焊死在 `(runId, path, saveGeneration)` 三元组上，并在切 run、关面板、换 path、发起新保存时同时 abort+递增世代；补一条可执行的迟到响应测试，不要再加正则。服务端 TOCTOU 残窗与缺失 `RUN_NOT_FOUND` 可同批收，但不阻塞「先修 UI 归属」。

**判决（R2 覆核）：APPROVED。** 见文末复审：三致命项代码侧已关闭；AbortSignal 被底层忽略时仍靠 generation + view identity 丢弃迟到成功/失败。

---

## 下游建议

### 建议召唤
无。缺陷是确定的控制面时序，不需要织查 CVE，也不需要策出新规格。

### 风险信号
- 本地 Bearer Console，路径穿越/敏感覆盖**未被**这次 diff 打穿。
- 真实体感风险：LO 会看见「保存了错误任务/错误文件」的 toast 和编辑器内容——这是验收里「感知变强」的反面。

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 2 | 证据：public/modules/rail-panels.js:362 迟到 PUT 在切 run 后仍 renderFilePreview；推翻「切 run/迟到响应不污染 UI」与「双入口语义一致」

---

# R2 复审：保存归属竞态修复（2026-08-20 01:36）

- **评审模式**：security + correctness（reflection / 只读覆核）
- **评审范围**：`public/modules/rail-panels.js`（`invalidateFileSave` / `ownsFileSave`）、`public/mission-control.js`（`invalidateWorkspaceSave` / `ownsWorkspaceSave`）、`tests/rail-panels-behavior.test.mjs`、`server.mjs` workspace GET/PUT
- **Codex 模型**：本会话 `codex-agent` MCP 仍未注册；烛只读交叉审，未跑 `codex exec`

## 致命问题（必须改）

无。R1 三条致命项在代码路径上已关闭，见下表。未发现新的可重绘/可 toast 归属漏洞（在「AbortSignal 被底层忽略」前提下）。

| R1 致命 | 状态 | 关闭证据 |
|---|---|---|
| 1 文件页迟到 PUT 切 run/关面板污染预览 | **关闭** | `invalidateFileSave` 同时 `generation++` + `abort()`（`rail-panels.js:124-128`）；`activate`/`reset`/`destroy` 均调用（`512`/`533`/`548`）；成功/失败回调先过 `ownsFileSave`（`375`/`381`）：`!aborted && generation 匹配 && getRunId()===snapshot.runId && fileView.draftKey===snapshot.draftKey` |
| 2 任务上下文同 run 换文件被迟到保存重绘 | **关闭** | `fetchWorkspace` 在 `workspaceFileView.path !== requestedPath` 时 `invalidateWorkspaceSave` 并清空 view（`654-657`）；`ownsWorkspaceSave` 额外要求 **对象身份** `workspaceFileView === snapshot` 且 `workspacePath === snapshot.path`（`189-195`）；`hideWorkspace`/`destroy` 亦 invalidate（`438`/`1010`） |
| 3 仅有源码正则、无行为测试 | **关闭（主路径）** | `tests/rail-panels-behavior.test.mjs:180-223` 明确 `PUT` promise **忽略 AbortSignal**，保存 A.txt 后点开 B.txt，迟到 resolve 不得把预览画回 A.txt |

### AbortSignal 被忽略时的模拟（不依赖 fetch 是否听话）

`controller.abort()` 仍会把**同一个** `ownedController.signal.aborted` 置位，与底层是否 unsubscribe 无关。即便假设连这个标志也被改掉，`fileSaveGeneration` / `workspaceSaveGeneration` 与 view identity 仍会让 `owns*` 为假，从而跳过 `renderFilePreview` / `renderWorkspace` / `notify`。

- **同 run 换文件（文件页）**：`loadFiles` 发现 `fileView.draftKey !== requestedDraftKey` → invalidate（`398-401`）。迟到成功走 `375` 早退；迟到失败走 `381` 早退，不会改当前 status，也不会 toast。
- **切 run**：`activate` 在 `runId !== lastRunId` 时 invalidate + `fileView = null`（`509-523`）。`getRunId() === snapshot.runId` 与 `fileView?.draftKey` 双失败。
- **reset / destroy**：均 `invalidateFileSave`（`533`/`548`）。destroy 未把 `fileView` 置空，但 generation/abort 已足够；迟到回调不能重绘或 toast。
- **任务上下文换文件**：`fetchWorkspace` invalidate + 清空 view；迟到成功/失败均 `ownsWorkspaceSave` 失败。切 run 仍走 `hideWorkspace`。关面板同。

## 建议改进（值得讨论）

1. **行为测试矩阵未铺满。** 现测覆盖「忽略 abort 的迟到成功 vs 换文件」和「迟到目录 GET」。未测：切 run、`reset`/`destroy`、迟到 **失败** toast、任务上下文 `createMissionControlDock` 换文件。代码已关，CI 还不能替你证明后几条。
2. **文件页对「同一 `draftKey` 强制重载」不 invalidate。** `loadFiles` 只在 draftKey 变化时作废保存（`398-401`）。同文件 `force: true` 刷新时，迟到 PUT 仍可能 `ownsFileSave` 为真并重绘——这是同一文件的保存结果，不是串文件污染；若产品要求「重载即丢弃在途保存 UI」，应对齐任务上下文的对象身份。
3. **`server.mjs:2204/2210` 的 `if (!run)` 是文档化重复。** `orchestrator.get` 本就会抛 `RUN_NOT_FOUND`（`orchestrator.mjs:1838-1841`）。R1 建议的 422 路径在当前 get 语义下本来走不到；补上的守卫无害，但不改变 HTTP 行为。workspace 缺 run 的专项 HTTP 断言仍没有。

## 可保留（看似奇怪但合理）

1. `ownsFileSave` 用 `draftKey` 字符串、`ownsWorkspaceSave` 用 view 对象身份——两边都能挡住换文件；任务上下文因此对「同路径重载」更严，不算回归。
2. `owns*` 仍检查 `!signal.aborted`：底层忽略 abort 时该位仍为 true，与 generation 是叠层，不是单点。
3. 写路径 Windows `closeTarget` TOCTOU（R1 建议1）与 revision 大小写（R1 建议5）本轮未改，仍不阻塞归属修复验收。

## 总评

归属焊到了 generation + abort + runId + view identity；成功和失败回调同一道门。R1 指出的污染场景在源码上复现不了。测试证明了文件页「忽略 AbortSignal 的迟到成功不得盖新预览」，这正是当时的主枪眼。

剩余是测试覆盖宽度，不是新的可利用重绘。

__VERDICT__: APPROVED
__DELTA__: 烛(Codex) | 1 | 证据：tests/rail-panels-behavior.test.mjs:180 忽略 AbortSignal 的迟到 PUT 不得重绘；补强指出切 run/reset/失败 toast/任务上下文仍无对等行为测试
