/**
 * 审批方法契约（v49 · 2026-09-04）——审批方法白名单与线格式的**单一真相源**。
 *
 * ── 为什么必须抽出来 ──
 * 2026-09-04 审计发现同一份"哪些方法是审批请求"的知识在三处各自手写：
 *
 *   | 位置                                    | 方法数 | 内容 |
 *   |-----------------------------------------|-------|------|
 *   | adapters/codex-app-server.mjs:99        |   5   | 全部 |
 *   | adapters/codex-app-server.mjs:820 兜底  | **2** | 只 commandExecution + fileChange |
 *   | approval-broker.mjs:32 responseFor()    |   5   | 全部（分 3 组线格式） |
 *
 * 第 820 行那个 2 元白名单造成的真实不对称：resolver 缺失时（无人值守 /
 * broker 未注入），`execCommandApproval` 与 `applyPatchApproval` 收到的是
 * **JSON-RPC error -32001**，而不是 `responseFor()` 明明知道该给的
 * `{ decision: "denied" }`。两者对上游行为不同：
 *   · decline 回灌 = Codex 收到一次明确的"操作者拒绝"，按拒绝路径继续（可能改道重试）
 *   · error 回灌   = Codex 收到协议层故障，可能整轮失败或重试同一请求
 * 安全方向上两者都是 fail-closed（都没放行），但**可观测性与上游行为不同**，
 * 且这种"取决于方法名的隐式差异"没有任何测试保护。
 *
 * ── 治法 ──
 * 白名单与线格式合并成一张表：一个方法在这里登记一次，就同时获得
 *   ① 是否是审批请求（`isApprovalMethod`）
 *   ② 批准/拒绝各自的线格式（`APPROVAL_WIRE_SHAPES`）
 *   ③ resolver 缺失时能否安全兜底拒绝（`fallbackDecline`）
 * 加新方法忘了填线格式 → 契约测试直接变红，而不是运行时才发现。
 *
 * ── 方向维度（v49 烛评审致命 1 · 2026-09-04）──
 * **光有方法名清单不够，必须带方向。** 首版把两个方向相反的白名单合并成一张表：
 *   · broker `responseFor()` 是**出站/内部**语义 —— 控制面自己发起 runBuild，必须认识它
 *   · adapter `APPROVAL_METHODS` 是**入站门闸** —— 判定被沙箱的 Codex 子进程能否发起
 * 合并后 `control/runBuild/requestApproval` 被放进入站白名单（原版 5 元 → 6 元），
 * 烛实测伪造入站请求可拿到 `{"decision":"accept","approvalId":"ATTACKER-SUPPLIED"}`
 * （原版回 -32601），并被 `public/app.js:21353` 渲染成与真授权卡视觉一致的卡片。
 * 爆炸半径经核实**不是直接提权**（`orchestrator.mjs:1672` 仍校验
 * `run.buildApproval.actionSha256`，租约铸造安全），但构成操作者欺骗 + 队列污染 + 账本污染。
 *
 * 所以每个方法必须声明 `inbound`：
 *   inbound: true   CLI 子进程可以发起（真正的审批请求）
 *   inbound: false  仅控制面内部发起，入站一律 -32601 拒绝
 *
 * ── 冻结深度（v49 烛评审致命 2）──
 * `Object.freeze` 是浅冻结：外层冻了、内层 spec 没冻。烛实测运行时
 * `spec.approvable = true` 即可让宽权限授予回灌 `{write:true, network:true}`，
 * 而 `approval.resolved` 仍记 `decision:"deny"` —— **账本说拒绝、线上放行**。
 * 这正是"我差点静默删掉的那条安全约束"，无需改一行源码即可达成。
 * 因此本表逐层深冻。
 *
 * ── 不变量 ──
 *   INV1 每个登记方法都有 denied 构造器；可批准的还有 approved 构造器
 *   INV2 `item/permissions/requestApproval` **不可批准**：批准路径抛
 *        UNSUPPORTED_APPROVAL（消息逐字保留，approval-capacity.test.mjs:292 锁死），
 *        拒绝路径回空权限集 `{ permissions: {}, scope: "turn" }`
 *   INV3 `isApprovalMethod` 对任意输入不抛，原型链键不误判为已登记
 *   INV4 fallbackDecline=true 的方法，其 denied() 必须返回可直接回灌的对象
 *        （不能是 null/undefined —— 那等于没兜底）
 *   INV5 本表与 broker `responseFor()` 对每个方法的线格式**逐字节一致** ——
 *        契约测试用真实 broker 交叉验证，防两处各自演化
 *
 * 纯 ESM，零 Node/DOM 依赖，前后端与测试共用。
 */

/**
 * 审批方法登记表。`wire` 描述该方法在 JSON-RPC 线上的应答形态：
 *   approved / denied 各给一个**构造函数**（而非静态对象），因为部分形态需要
 *   携带 approvalId 或从请求参数回填 permissions。
 *
 * fallbackDecline：resolver 缺失时能否直接回灌拒绝形态。
 *   true  = 该方法的拒绝语义在协议上明确，可安全兜底
 *   false = 必须由交互式操作者决定，兜底只能回 error（保守，不猜）
 *
 * inbound：CLI 子进程能否**发起**该请求（入站门闸，见上文方向维度）。
 *   true  = 真正的审批请求，Codex 发起、操作者裁决
 *   false = 仅控制面内部发起；入站一律 -32601 拒绝
 */
const METHOD_TABLE = {
  // 控制面自己发起的构建授权。**入站禁止** —— 被沙箱的 Codex 无权要求提权到 build。
  "control/runBuild/requestApproval": {
    kind: "run-build",
    inbound: false,
    fallbackDecline: true,
    approved: ({ approvalId = null } = {}) => ({ decision: "accept", approvalId }),
    denied: ({ approvalId = null } = {}) => ({ decision: "decline", approvalId }),
  },
  "item/commandExecution/requestApproval": {
    kind: "command",
    inbound: true,
    fallbackDecline: true,
    approved: () => ({ decision: "accept" }),
    denied: () => ({ decision: "decline" }),
  },
  "item/fileChange/requestApproval": {
    kind: "file-change",
    inbound: true,
    fallbackDecline: true,
    approved: () => ({ decision: "accept" }),
    denied: () => ({ decision: "decline" }),
  },
  // legacy 协议（Codex v1）：线格式是 approved/denied 而非 accept/decline。
  // 这不是内部枚举漂移 —— 是上游要求的两套线格式，改动会破协议兼容。
  execCommandApproval: {
    kind: "command",
    legacy: true,
    inbound: true,
    fallbackDecline: true,
    approved: () => ({ decision: "approved" }),
    denied: () => ({ decision: "denied" }),
  },
  applyPatchApproval: {
    kind: "file-change",
    legacy: true,
    inbound: true,
    fallbackDecline: true,
    approved: () => ({ decision: "approved" }),
    denied: () => ({ decision: "denied" }),
  },
  // Claude CLI 的工具许可（v50）。链路与 Codex 不同：CLI 通过 `--permission-prompt-tool`
  // 调该轮专属的 MCP server，server 经具名管道回到内核。**inbound: true** —— 这确实是
  // 子进程发起的真审批请求，与 command/fileChange 同类。
  //
  // 线格式刻意用 accept/decline 与 v2 家族对齐：endpoint 只读 `decision === "approve"`
  // 之外的布尔判定，真正的 PPT 线格式（behavior: allow/deny）由
  // `permission-prompt-wire.mjs` 在 MCP server 侧构造并过 v1 闸 —— 两层格式不混。
  "claude/toolPermission/requestApproval": {
    kind: "tool-permission",
    inbound: true,
    fallbackDecline: true,
    approved: () => ({ decision: "accept" }),
    denied: () => ({ decision: "decline" }),
  },
  // 宽权限授予：**不可批准**。Control Center v1 的策略是不通过审批扩大权限面——
  // 批准路径抛 UNSUPPORTED_APPROVAL，broker 接住后走策略性拒绝分支立即结算
  // （发 approval.resolved / actor=control-plane / actorSource=policy，并把原因抛回操作者），
  // 而不是让 agent 干等到 TTL。测试 approval-capacity.test.mjs:292 锁死这条行为，
  // 错误消息逐字保留（该测试断言 reason 匹配 /broad permission/）。
  "item/permissions/requestApproval": {
    kind: "permissions",
    inbound: true,
    fallbackDecline: true,
    approvable: false,
    approvedError: {
      message: "broad permission grants are not supported by Control Center v1",
      code: "UNSUPPORTED_APPROVAL",
    },
    denied: () => ({ permissions: {}, scope: "turn" }),
  },
};

/**
 * 逐层深冻（烛评审致命 2）：`Object.freeze` 只冻一层。浅冻结下运行时
 * `spec.approvable = true` 即可翻掉"宽权限不可批准"这条安全约束，
 * 而账本仍记 deny —— 账本说拒绝、线上放行。
 */
function deepFreeze(value) {
  if (value && (typeof value === "object" || typeof value === "function") && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      // 只递归数据属性；读 getter 可能有副作用
      if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
    }
  }
  return value;
}

export const APPROVAL_METHODS = deepFreeze(METHOD_TABLE);

/** INV3：任意输入不抛；只认自有属性，原型链键不算已登记。 */
export function isApprovalMethod(method) {
  return typeof method === "string"
    && Object.prototype.hasOwnProperty.call(APPROVAL_METHODS, method);
}

export function approvalMethodNames() {
  return Object.keys(APPROVAL_METHODS);
}

/**
 * **入站门闸**：CLI 子进程能否发起该方法（烛评审致命 1）。
 *
 * 与 `approvalMethodNames()` 有意不同——后者是控制面**认识**的全集（含自己发起的
 * `control/runBuild/requestApproval`），前者是被沙箱进程**被允许发起**的子集。
 * adapter 的 `APPROVAL_METHODS` Set 必须用这个，不是全集：
 * 用全集会让 Codex 能伪造 runBuild 授权请求，拿到 `{decision:"accept"}` 并被
 * UI 渲染成与真授权卡视觉一致的卡片（操作者欺骗 + 队列污染 + 账本污染）。
 */
export function inboundApprovalMethodNames() {
  return Object.keys(APPROVAL_METHODS).filter((name) => APPROVAL_METHODS[name].inbound === true);
}

/** 该方法是否允许由 CLI 子进程发起。未登记 / inbound!==true 一律 false（fail-closed）。 */
export function isInboundApprovalMethod(method) {
  const spec = approvalMethodSpec(method);
  return Boolean(spec) && spec.inbound === true;
}

export function approvalMethodSpec(method) {
  return isApprovalMethod(method) ? APPROVAL_METHODS[method] : null;
}

/**
 * resolver 缺失时的兜底应答。返回 null 表示**不能安全兜底**，调用方应回 JSON-RPC error。
 * 这让"哪些方法能兜底拒绝"成为表里的一个字段，而不是散落在 adapter 里的一条 if。
 */
export function fallbackDeclineFor(method) {
  const spec = approvalMethodSpec(method);
  if (!spec || spec.fallbackDecline !== true) return null;
  return spec.denied({});
}

/**
 * 是否允许该方法被"批准"。`item/permissions/requestApproval` 为 false ——
 * Control Center v1 不通过审批扩大权限面（宽权限授予批准即抛）。
 */
export function isApprovable(method) {
  const spec = approvalMethodSpec(method);
  return Boolean(spec) && spec.approvable !== false;
}

/**
 * 按登记表派发应答形态。这是 broker `responseFor()` 的唯一取值来源，
 * 三处手写白名单合并后的单一出口。
 *
 * @param {string} method    审批方法名
 * @param {boolean} approved 操作者决定
 * @param {object} ctx       { approvalId, permissions } —— 部分形态需要
 * @throws 未登记方法 → UNSUPPORTED_APPROVAL；不可批准方法被批准 → 该方法声明的 approvedError
 *
 * 抛错也走表（`approvedError`）而不是散在 broker 里的 if：加一个"只能拒绝"的
 * 新方法时，只需在表里填 approvable:false + approvedError，无需改任何调用方。
 */
export function approvalResponseFor(method, approved, ctx = {}) {
  const spec = approvalMethodSpec(method);
  if (!spec) {
    throw Object.assign(new Error(`unsupported approval method: ${method}`), { code: "UNSUPPORTED_APPROVAL" });
  }
  if (!approved) return spec.denied(ctx);
  if (spec.approvable === false) {
    const { message, code } = spec.approvedError;
    throw Object.assign(new Error(message), { code });
  }
  return spec.approved(ctx);
}
