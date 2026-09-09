<!-- 514cc-session-id: cf8dac53-77b0-4ebe-891a-d261f66f8439 -->
# Codex 评审：v49 审批方法契约收口（安全承载面）

- **评审模式**：security（对抗式，rules §二.7）
- **评审范围**：`apps/control-center/src/approval-methods.mjs`（新）、`src/approval-broker.mjs`、`src/adapters/codex-app-server.mjs`、`tests/approval-methods.test.mjs`（新）
- **评审时间**：2026-09-04 15:00
- **评审方法**：静态读 + `git show HEAD:` 逐行对照 + **变异测试（6 个变异体）** + 运行时构造反例（篡改冻结表 / 伪造 Codex 入站请求）+ 全量套件 2127 测试
- **工作目录**：`I:/514claude/514cc/apps/control-center`

> ⚠️ **评审期间测试文件被并发修改 3 次**（md5 `fe077fda` → `df90475c`，mtime 17:00:43 → 17:03:58）。
> 我对 `tests/approval-methods.test.mjs` 的第一轮结论（下方"致命 3"）基于**任务卡指派时的 v1 版本**；
> 中途该文件被加入 `WIRE_GOLDEN` 黄金快照后问题已自愈。两份结论都保留——因为
> **v1 那个假基线曾真实存在过，且它正是你要我攻击的第 6 点**。

---

## 致命问题（必须改）

### 【致命 1】adapter 入站白名单被静默扩大：Codex 现在可以伪造 `control/runBuild/requestApproval` 挤进操作者审批队列

**这是本次改动唯一真正削弱 fail-closed 的地方，也是你声称 C「扩大方向是安全的」不成立的反例。**

- 位置：`src/adapters/codex-app-server.mjs:104`
  ```js
  const APPROVAL_METHODS = new Set(approvalMethodNames());   // 6 元
  ```
  原版 `git show HEAD:` 第 99-105 行是**手写 5 元 Set**，且**不含** `control/runBuild/requestApproval`。

- 差集实测：
  ```
  orig adapter Set size: 5
  new  adapter Set size: 6
  NEWLY ACCEPTED by adapter: [ 'control/runBuild/requestApproval' ]
  ```

**为什么这是安全问题而不是无害扩容**：这两个白名单方向相反，你把它们合并成了一个。
- `approval-broker.mjs` 的 `responseFor()` 是**出站/内部**语义：控制面自己发起 runBuild 审批（`orchestrator.mjs:1621,1687`），所以它**必须**认识 runBuild。
- `codex-app-server.mjs` 的 `APPROVAL_METHODS` 是**入站**语义：门闸 `handleServerRequest()`，判定"Codex 子进程发来的 server request 允不允许进审批队列"。runBuild 是**控制面→操作者**的内部授权方法，**从来不该由被沙箱的 Codex 进程发起**。

原版对入站 runBuild 回 `-32601 unsupported server request`（第 793 行那条路径）。现在它被当成合法审批请求，一路走到 `approvalResolver` → `approvalBroker.request()` → 落 `approval.pending` → **渲染进操作者审批面板**。

**实测反例**（构造 Codex 伪造请求打 `handleServerRequest`）：
```
reached approvalResolver: ["control/runBuild/requestApproval"]
written back to Codex   : [{"id":1,"result":{"decision":"accept","approvalId":"ATTACKER-SUPPLIED"}}]
```

**具体失败场景**：被 prompt-injection 污染的 Codex 进程（或恶意 MCP/上游）发送
`control/runBuild/requestApproval`，params 里塞入自选的 `workspace` / `permissionMode: "build"` / `promptSha256`。操作者面板会用 `approvalRunBuildMarkup()`（`public/app.js:21353`）把它渲染成一张**与真实构建授权卡视觉完全一致**的"人话摘要"卡片——「工作区 / 隔离 / 协作 / 执行成员」四项俱全，params 全量收在「技术详情」折叠里。操作者无法从 UI 区分它是控制面发起的真授权还是 Codex 伪造的。这是教科书式的 **approval-request spoofing / UI confusion**：审批闸的全部安全价值建立在"操作者看到的请求是真的"之上。

**缓解与残余风险（如实说明，不夸大）**：能力租约（capability lease）仍是安全的——`issueCapabilityLease()`（`orchestrator.mjs:1672`）要求 `run.buildApproval.actionSha256`，而那只由 `orchestrator.mjs:2891` 的控制面自身路径写入；`server.mjs:2861` 的 lease 分支还要求 `resolution.runId` 且 `lease.approvalId === resolution.id`。所以伪造的 runBuild **不能直接铸出 workspace-write 租约**。
残余风险是真实的：① 伪造审批卡的操作者欺骗（社工放行面）② 审批队列污染 / 容量耗尽（`DEFAULT_MAX_PENDING=128`，Codex 侧可无限发起，把真实审批挤出队列——`#capacityRejection` 会开始拒绝**合法**请求）③ 账本被灌入伪造的 `approval.pending` / `approval.requested` 事件，污染那条不可篡改哈希链的事后可读性。

**修法**：入站与出站白名单必须分开。表里给每个方法加一个来源字段，例如 `inbound: true/false`（runBuild = `inbound: false`），adapter 侧用
```js
const APPROVAL_METHODS = new Set(approvalMethodNames().filter(inboundAllowed));
```
配一条测试断言 `APPROVAL_METHODS.has("control/runBuild/requestApproval") === false`。
**注意**：全量 2127 测试**没有一条**抓到这个扩大——`tests/approval-lock.test.mjs:34`「unsupported server methods never enter the approval queue」看着像守这条，实际只测 broker 层用一个根本没登记的 `item/tool/requestUserInput`，完全没覆盖 adapter 的入站门闸。

---

### 【致命 2】`Object.freeze` 只有一层，内层 spec 与其函数可在运行时被改写成"批准" —— 冻结是安全剧场

- 位置：`src/approval-methods.mjs:52`（`Object.freeze({...})` 外层）、测试 `tests/approval-methods.test.mjs` 的
  `assert.equal(Object.isFrozen(APPROVAL_METHODS), true)` 只验证了外层，**这条测试给了虚假的安全保证**。

**实测反例**（当前 pristine 源码）：
```
outer frozen: true | inner frozen: false
tampered fallbackDeclineFor = {"decision":"accept"}
```
完整攻击链：
```js
APPROVAL_METHODS["item/commandExecution/requestApproval"].denied = () => ({ decision: "accept" });
approvalResponseFor("item/commandExecution/requestApproval", false)  // → {"decision":"accept"}
fallbackDeclineFor("item/commandExecution/requestApproval")          // → {"decision":"accept"}

const p = APPROVAL_METHODS["item/permissions/requestApproval"];
p.approvable = true;
p.approved = () => ({ permissions: { write: true, network: true }, scope: "session" });
approvalResponseFor("item/permissions/requestApproval", true)
// → {"permissions":{"write":true,"network":true},"scope":"session"}
```
**最后这一条正是你在任务卡里说"差点让一条安全约束静默消失"的那个错误——它现在仍然可以在运行时达成，且不改一行源码。** 拒绝语义被翻成批准后，`fallbackDeclineFor()`（无人值守兜底）会开始**主动放行**，这条路径原本是 fail-closed 的最后一道。

**具体失败场景**：同进程内任何代码——一个被投毒的 npm 传递依赖、一个 automations 脚本、一处原型链污染 gadget——都能翻转审批语义，而**不留任何审计痕迹**：`approval.resolved` 事件会照常记 `decision: "deny"`（broker 用的是操作者传入的 `decision` 字面量，`approval-broker.mjs:250`），但回灌给 Codex 的线上对象是 `accept`。**账本说拒绝，线上放行——这是最坏的一类分歧，事后审计完全看不出来。**

**修法**：深冻结 + 让测试断言深度：
```js
for (const spec of Object.values(APPROVAL_METHODS)) {
  if (spec.approvedError) Object.freeze(spec.approvedError);
  Object.freeze(spec);
}
Object.freeze(APPROVAL_METHODS);
```
测试改成遍历每个 spec 断言 `Object.isFrozen(spec)`，并**实际尝试篡改后断言语义不变**（仅断 `isFrozen` 仍不够——非严格模式下静默失败，严格模式下抛错，两者都该被测到）。

---

### 【致命 3 · 已在评审期间被并发修复，但结论保留】INV5「交叉验证」是同义反复假基线

**这正是你要我攻击的第 6 点，答案是：v1 版本一条都不红。**

任务卡指派时的 v1 用的是
```js
const expected = approvalMethodSpec(method).approved({});
assert.deepEqual(wire, expected);
```
两侧同源——左边 broker 经 `responseFor()`→`approvalResponseFor()`→表，右边直接读表。**任何线格式漂移都会让两边同步漂移，永远相等。**

**变异测试实测（v1 测试文件）**：
| 变异体 | 契约测试 | approval-capacity + approval-lock + adapters（95 测试） |
|---|---|---|
| M1 `commandExecution.approved` `accept`→`approve` | **16/16 全绿** | **95/95 全绿** |
| M2 `fileChange.approved` `accept`→`approve` | **16/16 全绿** | 3 fail（间接兜住） |
| M3 `execCommandApproval.approved` `approved`→`accept` | **16/16 全绿** | **0 fail** |
| M4 `applyPatchApproval.denied` `denied`→`decline` | **16/16 全绿** | **0 fail** |

你问"如果我把某个方法的 accept 改成 approve，哪几条测试会红？"——**M1 一条都不红，连全量 95 条相关测试也全绿**。legacy 两套线格式（M3/M4）**完全无保护**：`execCommandApproval` / `applyPatchApproval` 是 Codex v1 协议线格式，写错了只会在真实 Codex 对接时表现为协议不兼容，测试永远发现不了。声明 A（语义零漂移）当时**没有任何机械保证**——它只被"我逐字节抄对了"这件事保证。

**评审期间该文件被并发改写为 `WIRE_GOLDEN` 黄金快照（`tests/approval-methods.test.mjs:42-67`），问题已解。**重跑同一批变异体：
| 变异体 | v2（黄金快照）|
|---|---|
| M1 `accept`→`approve` | **2 fail** ✅ |
| M2 | 4 fail ✅ |
| M3 legacy | 4 fail ✅ |
| M4 legacy | 4 fail ✅ |
| M5 `permissions.approvable`→`true` | 10 fail ✅ |
| M6 `permissions.denied` 泄漏权限 | 8 fail ✅ |
基线已由 buggy-must-turn-red 验证为真。

**遗留待办（v2 仍未覆盖）**：`WIRE_GOLDEN` 里 runBuild 的 `denied: (id) => ({...})` 在 INV5b 被以 `golden.denied()`（无参）调用，产出 `approvalId: undefined`，而表给 `null` —— 我抓到过一次真实 fail（`'build' !== 'plan'` 之外的那条 `approvalId: null !== undefined`），随后被再次改写。请确认最终版本对 runBuild 的 `denied` 走的是显式 `null` 口径，别留一个凭调用方式而变的快照。

---

## 建议改进（值得讨论）

1. **`approvalResponseFor` 的 `spec.approvedError` 解构无守卫**（`approval-methods.mjs:156`，你问的第 4 点）
   实测：spec 若 `approvable: false` 而漏填 `approvedError`，抛的是
   `TypeError: Cannot destructure property 'message' of 'fake.approvedError' as it is undefined.`，**且 `error.code === undefined`**。
   后果不是放行（仍 fail-closed，因为在 `!approved` 分支之后），但 `adapter` 的 `Number(error.code) || -32001` 会把它降级成通用 `-32001`，broker 的策略性拒绝分支（`approval-broker.mjs:222`）也会把一个 `TypeError` 的英文消息当成 `reason` 写进账本。当前 INV1 测试已断言每个 `approvable: false` 的 spec 必须有 `approvedError.message/code`，所以现状安全；但那是**测试**在守，不是**代码**在守。建议加一行显式守卫，抛出带 `UNSUPPORTED_APPROVAL` code 的错误，让"表填错"变成清晰的配置错误而非 TypeError。

2. **`fallbackDecline` 语义与字段名不符 —— 它现在是全 `true` 的死字段**
   表里 6 个方法全部 `fallbackDecline: true`，注释里精心解释的 `false` 分支（"必须由交互式操作者决定，兜底只能回 error，保守，不猜"）**没有任何一个方法使用**。`fallbackDeclineFor()` 的 `spec.fallbackDecline !== true` 判断和 INV4 测试的 `else` 分支都是死代码。这不是 bug，但一个恒真的安全开关会让下一个人误以为这里有粒度控制。要么删掉字段直接以"已登记即可兜底"为契约，要么给 `item/permissions/requestApproval` 真的设成 `false`（见下条）。

3. **`item/permissions/requestApproval` 的 `fallbackDecline: true` 值得重新权衡（你问的第 2 点）**
   我的判断：让 `execCommandApproval` / `applyPatchApproval` 在无人值守时收到明确 `{decision:"denied"}` 而非 `-32001`，**安全方向上是对的且我支持**——两者都不放行，而明确拒绝让上游能走正常拒绝路径、日志更可读。你担心的"Codex 把 decline 当成换个方式重试、把 error 当成停止"确有其事（decline 通常触发模型重规划，protocol error 更可能中止整轮），但这个差异**不构成安全降级**：重试的每一次仍要过同一道审批闸，不存在绕过；而 `-32001` 反而可能让 Codex 反复重发同一请求。
   真正值得犹豫的是 `permissions`：兜底回 `{permissions:{}, scope:"turn"}` 是一个**语法合法的成功响应**，语义是"授予空权限集"。这依赖 Codex 正确地把空权限集理解为"什么都没给"。若上游哪天把"收到 permissions 响应"当作"权限协商成功"的信号，空集可能被误读。这里回协议错误反而更不容易被误解。建议把它设为 `fallbackDecline: false`（正好让第 2 条那个死字段活起来），并加测试锁死。

4. **`approval-methods.mjs:33` 的注释行号引用已失准**
   注释写 `approval-capacity.test.mjs:292`，测试文件里那条 `/broad permission/` 断言实际在 `tests/approval-methods.test.mjs:141` 与 `approval-capacity.test.mjs` 的 `broad permission approve is immediately denied and settled`；另一处注释写 `:320`。两处自相矛盾且都不准。行号引用会随任何编辑腐坏——建议引用**测试名**而非行号。

5. **`git show HEAD:` 对照发现 adapter 另有一处非本次契约收口的行为改动**
   `codex-app-server.mjs:781` 新增 `const resolvedThreadId = threadId || active?.threadId || null;`，并把 `eventContext.sessionId` 与 `approvalResolver` 的 `sessionId` 都从原来的裸 `threadId` 换成了它。这不在任务卡声明的 4 项改动内。影响面：审批事件的 `sessionId` 归属、以及 broker 的 `context.sessionId`。看起来是合理修复（threadId 缺失时回退到 active 会话），但它**混在一次安全承载面改动里且未声明、无测试**。请单独确认或拆出。

---

## 可保留（看上去奇怪但合理）

1. **`approval-broker.mjs:156` 那个"丢弃返回值"的 `responseFor(message.method, false)`**
   看着像死代码，实为**入口校验闸**：让未登记方法在 `request()` 最前面就抛 `UNSUPPORTED_APPROVAL`，绝不入队。第 218-219 行的注释已明确警告"不要当死代码删掉"，`tests/approval-methods.test.mjs` 的 INV5 覆盖集测试还反过来利用它反推 broker 的真实支持集。保留，注释也保留。

2. **`responseFor()` 签名与调用点 100% 与原版一致（声明 D 成立）**
   逐点核对 8 处调用点，新旧完全同构，无参数悬空：
   ```
   新 44,152,156,221,229,266,288,308  ←→  原 32,153,157,222,230,267,289,309
   ```
   `approvalId = null` 默认值也保留，`approvalResponseFor(method, approved, { approvalId })` 的 ctx 包装是干净的适配层。

3. **两套线格式（v2 `accept/decline` 与 legacy `approved/denied`）并存**
   这不是枚举漂移，是 Codex v1/v2 两套上游协议的真实要求，表里 `legacy: true` 标记 + 注释交代得很清楚。声明 A 在**内容**上我逐字节核对为真（与 `git show HEAD:` 第 32-46 行完全一致）——只是当时缺机械保证（致命 3）。

4. **`approvalResponseFor` 不泄漏多余 ctx 字段**
   实测传入 `{approvalId:"X", permissions:{write:true}}` 给 commandExecution，输出仍是干净的 `{"decision":"accept"}`；runBuild 只取 `approvalId`。构造器按需取字段而非展开 ctx，这个设计对了。

5. **无共享可变状态（你问的第 5 点，并发安全）**
   构造器都是纯函数、每次返回新对象字面量：`a !== b` 为 true，篡改返回对象不影响后续调用。表本身只读（模数致命 2 的浅冻结问题）。多个审批并发 resolve 不存在跨请求串扰。

6. **`isApprovalMethod` 的 `hasOwnProperty.call` + `typeof === "string"` 双守卫**
   原型链污染防护到位：`__proto__` / `constructor` / `toString` / `valueOf` / `hasOwnProperty` / `isPrototypeOf` 全部实测返回 false；敌意 `toString()` 不被触发（非 string 直接短路）。`isApprovable` / `fallbackDeclineFor` / `approvalMethodSpec` 都经由它，继承同一防护。这一层是干净的。

---

## 总评

**verdict：CHANGES_REQUESTED。**

抽单一真相源这个方向是对的，`responseFor()` 的委托改造干净、签名零漂移（声明 D 成立），线格式内容逐字节核对为真（声明 A 内容为真）。但**三条声明中有两条被证伪，且这次改动净引入了一处真实的安全面扩大**：

- 声明 **A**（语义零漂移）：内容为真，但**当时无机械保证**——变异体 M1 改 `accept`→`approve`，16 条契约测试 + 95 条相关测试**全绿**。评审期间该文件被并发改为 `WIRE_GOLDEN` 后已修复（M1-M6 全部转红，基线已真）。
- 声明 **B**（permissions 仍不可批准）：**成立**。批准抛 `UNSUPPORTED_APPROVAL`，消息逐字保留，broker 走策略性拒绝立即结算。但注意这条约束仅由**约定**保护——致命 2 证明它可在运行时被翻转（正是你说"差点静默消失"的那个错误，现在仍可无源码修改达成）。
- 声明 **C**（兜底扩大且方向安全）：**部分证伪**。兜底扩大本身我支持（安全方向正确，见建议 3）；但同一次改动把 adapter 的**入站**白名单从 5 元扩到 6 元，让 Codex 可以伪造 `control/runBuild/requestApproval` 挤进操作者审批面板并渲染成与真授权卡视觉一致的卡片（致命 1）。这个方向**不安全**，且全量 2127 测试无一条抓到。

**核心元教训**：你把两个**方向相反**的白名单（出站/内部 vs 入站/门闸）合并成了一张表。"单一真相源"的前提是这些副本真的是同一份知识——runBuild 在 broker 里必须存在、在 adapter 入站门闸里必须不存在，它们从来不是同一份知识。收口时如果不先问"这三处白名单是同一个语义吗"，合并本身就会制造漏洞。这与你任务卡里承认的那次错误（把 permissions 从不可批准改成回灌任意权限）**是同一个模式**：都是在"统一化"的动作里让一条方向性约束消失。

**关于 0 发现的可信度**：本次**不是** 0 发现，共 3 条致命 + 5 条建议。可信度依据（可复核）：
① `git show HEAD:` 逐行对照两个被改文件，8 处 `responseFor` 调用点全核；
② **变异测试 6 个变异体 × 2 个测试版本**，实测每个变异体的 fail 数（不靠读代码猜覆盖）；
③ **运行时构造反例 3 组**：篡改浅冻结表翻转拒绝语义、伪造 Codex 入站 `handleServerRequest` 拿到 `{"decision":"accept"}` 回写、缺 `approvedError` 触发 TypeError；
④ 全量 `npm test` 2127 测试（2124 pass / 1 fail / 2 skip）——唯一失败 `conversations-http.test.mjs:200`（`'build' !== 'plan'`）经 stash 到 pristine HEAD 复现，**确认为先前存在，与本次改动无关**；
⑤ 追踪 F1 的爆炸半径到 `orchestrator.mjs:1672` / `server.mjs:2861`，确认租约铸造仍安全，故 F1 定级为"操作者欺骗 + 队列污染 + 账本污染"而非"直接提权"——**不夸大**。

**评审卫生声明**：所有变异体测试后均 `cp` 还原并 `diff` 校验；结束时 `src/approval-methods.mjs` 与评审前 md5/字节数完全一致（7526 字节，`diff` 无输出）。中途为验证 F3 先前性做过一次 `git stash push/pop`（仅 2 个 tracked 文件），已 pop 并确认两文件仍带你的改动（各含 `approval-methods.mjs` 引用 2/3 处）。**未修改任何源码、测试或治理文件。**

**建议下游**：致命 1 的修法涉及入站/出站语义分离，建议召唤策（spec-architect）出一份"审批方法方向性契约"规格——这次的教训是白名单需要**方向**这个维度，光有"方法名清单"不够。

---

__VERDICT__: CHANGES_REQUESTED
__DELTA__: 烛(Codex) | 2 | 证据：src/adapters/codex-app-server.mjs:104 推翻主驾声明C「兜底扩大方向是安全的」——入站白名单从5元扩到6元，Codex 可伪造 control/runBuild/requestApproval 进操作者审批面板（实测拿到 {"decision":"accept"} 回写），全量2127测试零覆盖；另 src/approval-methods.mjs:52 浅冻结可运行时翻转拒绝为批准（实测 permissions 批准回灌 {write:true,network:true}），证伪声明A的机械保证（变异体 accept→approve 时16+95条测试全绿）
