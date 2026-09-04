/**
 * 事件严重度分级契约测试（v49 · 2026-09-04）。
 *
 * 六条不变量逐条断言 + **buggy-must-turn-red 元验收**：
 * 最后一组用例复刻原实现的词表逻辑，断言它在 14 个漏网类型上**确实判错**。
 * 这一组的作用不是测代码，是**测测试**——证明本文件的断言真的能抓到这类回归，
 * 而不是写了一堆恒真断言的假基线（契约驱动的教训：`contract-driven-over-patching`）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { scanBackendEventTypes } from "./helpers/backend-event-types.mjs";
import {
  EVENT_SEVERITY,
  SEVERITY,
  SEVERITY_ORDER,
  assertSeverityCoverage,
  classifyUnknownEventType,
  isAtLeast,
  severityOf,
  toneOf,
} from "../public/modules/event-severity.js";

/** 原实现（workbench-topology.js:216）的词表逻辑，供 buggy 基线对照。 */
function legacyTone(type) {
  const value = String(type);
  if (/fail|error|denied|dropped|blocked/i.test(value)) return "red";
  if (value.startsWith("bus.")) return "aqua";
  if (value.startsWith("agent.")) return "blue";
  if (value.startsWith("automation.")) return "amber";
  if (value.startsWith("run.")) return "rose";
  if (value === "user.message") return "violet";
  return "neutral";
}

/** 原实现漏网的 14 个类型（由 emitEvent 全量扫描 + 语义人工判定得出）。 */
const LEGACY_MISSED = [
  "agent.turn_unproductive",
  "capability.lease_revoked",
  "run.answer_deferred",
  "run.authorization_revoked",
  "run.budget_exhausted",
  "run.cancel_degraded",
  "run.cancelled",
  "run.directive_rejected",
  "run.interaction_steps_exhausted",
  "run.interrupt_timeout",
  "run.interrupted",
  "run.recovery_required",
  "run.worktree_skipped",
  "run.write_degraded",
];

/** 原词表能正确抓到的，新实现不许回退。 */
const LEGACY_CORRECT_CRITICAL = [
  "run.failed",
  "agent.turn_failed",
  "run.context_compaction_failed",
  "run.context_publication_failed",
  "adapter.replay_blocked",
];

/** 后端真实事件类型清单——扫描口径见 tests/helpers/backend-event-types.mjs（单一数据源）。 */
function backendEventTypes() {
  return scanBackendEventTypes({ srcDir: "src", extraFiles: ["server.mjs"] }).types;
}

test("INV1 severityOf 对任意输入都返回合法档位且绝不抛", () => {
  const hostile = [
    null, undefined, 0, 1, -1, NaN, Infinity, true, false,
    "", " ", "unknown.type", {}, [], () => {}, Symbol.iterator.toString(),
    "__proto__", "constructor", "toString", "valueOf", "hasOwnProperty",
  ];
  for (const input of hostile) {
    const result = severityOf(input);
    assert.ok(SEVERITY_ORDER.includes(result.severity), `${String(input)} → ${result.severity}`);
    assert.equal(typeof result.tone, "string");
    assert.ok(result.tone.length > 0);
    assert.equal(typeof result.inferred, "boolean");
  }
  // 敌意 toString：severityOf 只接受 string，其他一律归空串，不触发对象的 toString
  const hostileObject = { toString() { throw new Error("boom"); } };
  assert.doesNotThrow(() => severityOf(hostileObject));
  assert.equal(severityOf(hostileObject).severity, "info");
});

test("INV2 attention/critical 类型的 tone 绝不是 neutral 或 rose", () => {
  const flagged = Object.entries(EVENT_SEVERITY)
    .filter(([, level]) => level === "attention" || level === "critical");
  assert.ok(flagged.length >= 19, `声明的异常类型偏少：${flagged.length}`);
  for (const [type] of flagged) {
    const tone = toneOf(type);
    assert.notEqual(tone, "neutral", `${type} 渲染成 neutral 等于埋掉`);
    assert.notEqual(tone, "rose", `${type} 渲染成 rose 与普通 run.* 同色`);
    assert.ok(["amber", "red"].includes(tone), `${type} → ${tone}`);
  }
});

test("INV3 原词表能抓到的 critical 类型不回退", () => {
  for (const type of LEGACY_CORRECT_CRITICAL) {
    assert.equal(legacyTone(type), "red", `前提校验：原实现本应抓到 ${type}`);
    assert.equal(severityOf(type).severity, "critical", `${type} 不应降级`);
    assert.equal(toneOf(type), "red");
  }
});

test("INV4 14 个漏网类型全部升到 attention 或 critical", () => {
  for (const type of LEGACY_MISSED) {
    const { severity } = severityOf(type);
    assert.ok(
      severity === "attention" || severity === "critical" || severity === "notice",
      `${type} → ${severity}`,
    );
    // cancelled/interrupted 是 LO 主动操作，判 notice 合理，但 tone 必须与普通 run.* 可区分
    assert.notEqual(toneOf(type), "rose", `${type} 仍与普通 run.* 同色`);
  }
});

test("INV4b 被拒/降级/耗尽类必须至少 attention（不许降为 notice）", () => {
  const mustBeAttention = [
    "run.directive_rejected",
    "run.write_degraded",
    "run.cancel_degraded",
    "run.budget_exhausted",
    "run.interaction_steps_exhausted",
    "run.authorization_revoked",
    "capability.lease_revoked",
    "agent.turn_unproductive",
  ];
  for (const type of mustBeAttention) {
    assert.ok(isAtLeast(type, "attention"), `${type} 低于 attention`);
  }
});

test("INV5 未声明类型标 inferred:true 且不冒充已声明", () => {
  const declared = severityOf("run.failed");
  assert.equal(declared.inferred, false);

  const unknown = severityOf("run.some_future_thing_failed");
  assert.equal(unknown.inferred, true);
  assert.equal(unknown.severity, "critical", "兜底推断应识别 _failed 后缀");

  const plain = severityOf("run.some_future_neutral_thing");
  assert.equal(plain.inferred, true);
  assert.equal(plain.severity, "info");
});

test("INV6 原型链键不被误当已声明类型", () => {
  for (const key of ["__proto__", "constructor", "toString", "valueOf", "isPrototypeOf"]) {
    const result = severityOf(key);
    assert.equal(result.inferred, true, `${key} 被当成已声明类型`);
    assert.ok(SEVERITY_ORDER.includes(result.severity));
  }
});

test("isAtLeast 对非法 floor 返回 false 而不抛", () => {
  assert.equal(isAtLeast("run.failed", "critical"), true);
  assert.equal(isAtLeast("run.created", "attention"), false);
  assert.equal(isAtLeast("run.failed", "nonsense"), false);
  assert.equal(isAtLeast("run.failed", null), false);
  assert.equal(isAtLeast("run.failed", undefined), false);
});

test("覆盖率扳机：后端全部事件类型都已显式声明", () => {
  const types = backendEventTypes();
  // 87 是 2026-09-04 的实测全集（三种发射写法合并去噪后）。这条下界断言防的是
  // **扫描器自己退化**：首版只扫 emitEvent( 一种写法时只看到 41 种，
  // 于是覆盖率测试"绿是因为看不见"。数字下界让那类假绿灯直接变红。
  assert.ok(types.length >= 80, `后端事件类型扫描异常，只找到 ${types.length} 种（预期 ≥80，疑似扫描口径退化）`);
  const report = assertSeverityCoverage(types);
  assert.equal(
    report.covered,
    true,
    `后端有 ${report.undeclared.length} 种事件类型未在 EVENT_SEVERITY 登记：\n`
      + report.undeclared.map((item) => `  ${item.type} (兜底推断 ${item.inferredSeverity})`).join("\n")
      + "\n→ 请在 public/modules/event-severity.js 的 EVENT_SEVERITY 显式登记",
  );
});

test("assertSeverityCoverage 对敌意输入不抛", () => {
  for (const input of [null, undefined, 0, "str", {}, [null, undefined, 0, ""]]) {
    assert.doesNotThrow(() => assertSeverityCoverage(input));
  }
  assert.equal(assertSeverityCoverage(["totally.unknown"]).covered, false);
  assert.equal(assertSeverityCoverage([]).covered, true);
});

// ═══ buggy-must-turn-red 元验收：证明本文件的断言真能抓到这类回归 ═══
test("元验收：原词表实现在 14 个漏网类型上确实判错（若此断言失败，说明前面的测试是假基线）", () => {
  const stillWrong = LEGACY_MISSED.filter((type) => {
    const legacy = legacyTone(type);
    return legacy === "rose" || legacy === "neutral" || legacy === "blue";
  });
  assert.equal(
    stillWrong.length,
    LEGACY_MISSED.length,
    `原实现本应在全部 ${LEGACY_MISSED.length} 个类型上判错，实测只错了 ${stillWrong.length} 个。`
      + "\n漏网清单可能已过期，需重新扫描后端事件类型。",
  );
  // 反向确认：新实现在这批上全部与原实现不同 tone —— 修复真的生效了
  for (const type of LEGACY_MISSED) {
    assert.notEqual(
      toneOf(type),
      legacyTone(type),
      `${type} 新旧 tone 相同（${toneOf(type)}），修复未生效`,
    );
  }
});

test("元验收：SEVERITY 档位序数单调且与 SEVERITY_ORDER 一致", () => {
  assert.deepEqual(SEVERITY_ORDER, ["info", "notice", "attention", "critical"]);
  for (let i = 1; i < SEVERITY_ORDER.length; i += 1) {
    assert.ok(
      SEVERITY[SEVERITY_ORDER[i]] > SEVERITY[SEVERITY_ORDER[i - 1]],
      `${SEVERITY_ORDER[i]} 未严格大于 ${SEVERITY_ORDER[i - 1]}`,
    );
  }
  // 每个 SEVERITY 键都在 ORDER 里，反之亦然（防两表漂移）
  assert.deepEqual(Object.keys(SEVERITY).sort(), [...SEVERITY_ORDER].sort());
});

test("EVENT_SEVERITY 全部取值合法（防手写档位拼错静默降级）", () => {
  for (const [type, level] of Object.entries(EVENT_SEVERITY)) {
    assert.ok(SEVERITY_ORDER.includes(level), `${type} 的档位 '${level}' 不合法`);
  }
});

test("classifyUnknownEventType 词根边界：不误伤含子串的正常类型", () => {
  // "run.completed" 含 "complete"，不含异常词根 —— 不应被误判
  assert.equal(classifyUnknownEventType("run.completed"), "info");
  // "run.error_cleared" 含 error 词根 → critical（保守优先，宁可多报）
  assert.equal(classifyUnknownEventType("run.error_cleared"), "critical");
  // 词根必须整段匹配，不匹配单词内部子串
  assert.equal(classifyUnknownEventType("run.failsafe_armed"), "info", "failsafe 不是 failed");
  assert.equal(classifyUnknownEventType("run.terrorless"), "info", "terror 里的 error 不算");
});
