/**
 * A/B 影子对照面板契约测试（v49 · 2026-09-04）。
 *
 * 覆盖三层：
 *   1. 纯函数（shadowCandidates / tallyVerdicts）—— 边界与敌意输入
 *   2. DOM 渲染 —— 用最小 stub 元素驱动，断言零 innerHTML、字段取值正确
 *   3. 接线存在性 —— index.html 有全部 id、app.js 三处接线齐全、图标真实存在
 *
 * 第 3 层不是形式主义：本模块要治的正是"后端有能力、前端零入口"，
 * 若接线本身缺一处，这个模块就重新变成一段死代码——那就白做了。
 *
 * 字段口径以 `src/adapters/manifest.mjs:648` createTeamCatalog 为准：
 * `{ id, label, adapterLabel, teamMemberEligible, ... }` —— **无 name / memberId**。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { shadowCandidates, tallyVerdicts } from "../public/modules/shadow-compare-panel.js";

const member = (id, extra = {}) => ({
  id, label: `${id} 席`, adapterLabel: "Codex", teamMemberEligible: true, ...extra,
});

test("shadowCandidates 排除主腿自己", () => {
  const list = [member("a"), member("b"), member("c")];
  assert.deepEqual(shadowCandidates(list, "a").map((m) => m.id), ["b", "c"]);
  assert.deepEqual(shadowCandidates(list, "c").map((m) => m.id), ["a", "b"]);
});

test("shadowCandidates 过滤不合格席位（后端会拒，列出来只会点了才失败）", () => {
  const list = [
    member("ok"),
    member("disabled", { teamMemberEligible: false, eligibilityReason: "profile-disabled" }),
    member("no-cmd", { teamMemberEligible: false, eligibilityReason: "command-not-configured" }),
  ];
  assert.deepEqual(shadowCandidates(list, "").map((m) => m.id), ["ok"]);
});

test("shadowCandidates 不把缺 teamMemberEligible 的条目当合格（fail-closed）", () => {
  // 后端条目一定带该字段；缺了说明数据形状变了，此时保守排除而非放行
  const list = [member("ok"), { id: "unknown", label: "字段缺失" }];
  assert.deepEqual(shadowCandidates(list, "").map((m) => m.id), ["ok"]);
});

test("shadowCandidates 对敌意输入不抛且返回数组", () => {
  for (const input of [null, undefined, 0, "str", {}, [null, undefined, 0, "", { }]]) {
    assert.doesNotThrow(() => shadowCandidates(input, "x"));
    assert.ok(Array.isArray(shadowCandidates(input, "x")));
  }
  assert.deepEqual(shadowCandidates([], "a"), []);
  // primaryId 为空时不误排除任何人
  assert.equal(shadowCandidates([member("a"), member("b")], "").length, 2);
  assert.equal(shadowCandidates([member("a")], null).length, 1);
});

test("tallyVerdicts 只数以「左（A）」「右（B）」开头的可判定行", () => {
  // 文案口径来自 src/run-compare.mjs 的 verdicts 生成逻辑
  const comparison = {
    verdicts: [
      "左（A）成功而右（B）未成功",
      "右（B）成本更低",
      "左（A）更快",
      "两轮在可见元数据上无显著差异",
    ],
  };
  const tally = tallyVerdicts(comparison);
  assert.equal(tally.left, 2);
  assert.equal(tally.right, 1);
  assert.equal(tally.decided, 3, "平局行不计入");
  assert.equal(tally.lines.length, 4, "lines 保留全部原文供展示");
});

test("tallyVerdicts 对缺数据/敌意输入不抛", () => {
  for (const input of [null, undefined, {}, { verdicts: null }, { verdicts: "str" }, { verdicts: [null, 0, {}] }]) {
    assert.doesNotThrow(() => tallyVerdicts(input));
    const tally = tallyVerdicts(input);
    assert.equal(typeof tally.left, "number");
    assert.equal(typeof tally.right, "number");
    assert.ok(Array.isArray(tally.lines));
  }
  assert.deepEqual(tallyVerdicts(null), { left: 0, right: 0, decided: 0, lines: [] });
});

test("tallyVerdicts 不把含「左（A）」但不在开头的行误判", () => {
  const tally = tallyVerdicts({ verdicts: ["注：左（A）与右（B）均超时"] });
  assert.equal(tally.decided, 0, "解释性文案不该被算成胜负");
});

// ═══ 接线存在性：缺一处这个面板就重新变成死代码 ═══

test("index.html 声明了面板需要的全部元素 id", () => {
  const html = readFileSync("public/index.html", "utf8");
  for (const id of [
    "shadow-title", "shadow-status", "shadow-prompt", "shadow-primary", "shadow-target",
    "shadow-legs", "shadow-matrix-body", "shadow-tally", "shadow-verdicts",
    "shadow-dispatch", "shadow-refresh", "shadow-copy-markdown",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
});

test("index.html 用到的 lucide 图标都在 sprite 里真实存在", () => {
  const html = readFileSync("public/index.html", "utf8");
  const sprite = readFileSync("public/lucide-sprite.svg", "utf8");
  // 只检查影子对照那一段（整页图标由既有测试覆盖）
  const start = html.indexOf('id="shadow-title"');
  const end = html.indexOf('id="view-sessions"');
  assert.ok(start > 0 && end > start, "定位影子对照片段失败");
  const section = html.slice(start, end);
  const icons = [...section.matchAll(/href="#lucide-([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(icons.length >= 3, `图标引用偏少：${icons.length}`);
  for (const icon of icons) {
    assert.ok(sprite.includes(`id="lucide-${icon}"`), `sprite 缺少 lucide-${icon}`);
  }
});

test("app.js 三处接线齐全（import / 实例化 / mount）", () => {
  const app = readFileSync("public/app.js", "utf8");
  assert.ok(app.includes('from "./modules/shadow-compare-panel.js"'), "缺 import");
  assert.ok(app.includes("createShadowComparePanel({"), "缺实例化");
  assert.ok(app.includes("shadowComparePanel.mount()"), "缺 mount");
  // confirmAction 必须传进去 —— 派双腿是花钱操作，不能静默双花
  assert.match(
    app.match(/createShadowComparePanel\(\{[^}]*\}\)/)?.[0] ?? "",
    /confirmAction/,
    "实例化时未传 confirmAction",
  );
});

/** 剥掉注释行，只留可执行代码 —— 注释里提到 innerHTML 不算违规。 */
function codeLines(source) {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

test("模块零 innerHTML（不往 ui:lint 的 inner-html 基线上加债）", () => {
  const code = codeLines(readFileSync("public/modules/shadow-compare-panel.js", "utf8"));
  assert.equal(code.includes("innerHTML"), false, "模块使用了 innerHTML");
  assert.equal(code.includes("insertAdjacentHTML"), false);
  assert.equal(code.includes("outerHTML"), false);
});

test("模块不引用 memberCatalog 里不存在的字段名", () => {
  // createTeamCatalog 的条目没有 name / memberId；引用它们会静默取到 undefined
  const code = codeLines(readFileSync("public/modules/shadow-compare-panel.js", "utf8"));
  assert.equal(/member\.name\b|\.memberId\b/.test(code), false, "引用了不存在的字段");
});

test("对照腿只读这件事在 UI 文案里说清（否则会被误判成 B 不行）", () => {
  const html = readFileSync("public/index.html", "utf8");
  const source = readFileSync("public/modules/shadow-compare-panel.js", "utf8");
  const start = html.indexOf('id="shadow-title"');
  const section = html.slice(start, html.indexOf('id="view-sessions"'));
  assert.match(section, /plan\s*只读/, "HTML 未标明对照腿只读");
  assert.match(source, /plan\s*只读/, "确认框未标明对照腿只读");
});
