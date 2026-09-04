/**
 * 工具许可审批卡渲染测试（v50 · 2026-09-04）。
 *
 * ── 为什么这层要单独测 ──
 * 后端链路（脚本 / 管道 / 端点 / broker）已各自有测试，但操作者最终做决定的依据是
 * **卡片上那几行字**。渲染错了，前面每一层的正确性都白费：
 *   · 参数被压成一坨 JSON → `rm -rf /` 和 `ls` 长得一样，人无从判断
 *   · 显示裸方法名 → 要在三秒内做安全决定的人得先解析协议名
 *   · 参数没过 redact → 密钥进 DOM
 *
 * 这里用源码级断言（与 `approval-broad-permission-block.test.mjs` 同法）：
 * `app.js` 是浏览器侧单文件，无法在 node 里直接 import 其内部函数。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const app = readFileSync("public/app.js", "utf8");
const METHOD = "claude/toolPermission/requestApproval";

/** 取某个函数从声明处到下一个顶层 function/const 之间的源码。 */
function functionBody(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `未找到 ${declaration}`);
  const from = start + declaration.length;
  const ends = ["\nfunction ", "\nasync function ", "\nconst "]
    .map((marker) => source.indexOf(marker, from))
    .filter((index) => index > 0);
  return source.slice(start, ends.length ? Math.min(...ends) : from + 6000);
}

// ═══ 分派 ═══

test("approvalParamsMarkup 为工具许可分派到专用渲染", () => {
  const body = functionBody(app, "function approvalParamsMarkup(");
  assert.match(body, new RegExp(`method === "${METHOD.replace(/\//g, "\\/")}"`), "未按 method 分派");
  assert.match(body, /approvalToolPermissionMarkup\(params\)/);
  // 分派必须在通用键值表兜底之前，否则永远走不到
  const dispatchIndex = body.indexOf("approvalToolPermissionMarkup");
  const fallbackIndex = body.indexOf("approval-kv-list");
  assert.ok(dispatchIndex > 0 && dispatchIndex < fallbackIndex, "专用分支排在兜底之后，等于没写");
});

// ═══ 决定性字段 ═══

test("命令类工具把命令本身作为主体呈现（不是塞进键值表）", () => {
  const body = functionBody(app, "function approvalToolPermissionMarkup(");
  assert.match(body, /input\.command \?\? input\.cmd/, "未识别命令字段");
  assert.match(body, /<pre class="approval-command">/, "命令应用 pre 呈现，与既有命令审批卡一致");
  // 数组形态的 argv 要拼起来，不能渲染成 "0,1,2"
  assert.match(body, /Array\.isArray\(command\)\s*\?\s*command\.join\(" "\)/);
});

test("写盘类工具亮出目标路径与内容预览", () => {
  const body = functionBody(app, "function approvalToolPermissionMarkup(");
  assert.match(body, /input\.file_path \?\? input\.filePath \?\? input\.path/, "未识别路径字段");
  assert.match(body, /notebook_path/, "NotebookEdit 的路径字段名不同，应一并识别");
  assert.match(body, /内容规模/, "应给出体量，让人判断这是改一行还是重写整个文件");
});

test("内容预览有长度上限（一张要快速判断的卡片不该塞进整个文件）", () => {
  const body = functionBody(app, "function approvalToolPermissionMarkup(");
  assert.match(body, /preview\.slice\(0,\s*\d+\)/, "内容未截断");
  assert.match(body, /preview\.length > \d+ \? "\\n…" : ""/, "截断后应有省略提示，否则看起来像内容就这么多");
});

test("认不出的工具退回完整键值表，不隐藏参数", () => {
  const body = functionBody(app, "function approvalToolPermissionMarkup(");
  assert.match(body, /Object\.entries\(input\)/, "缺兜底：看不懂总比看不见强");
  assert.match(body, /approval-kv-list/);
});

// ═══ 安全 ═══

test("所有参数都过 redact（参数里可能带密钥）", () => {
  const body = functionBody(app, "function approvalToolPermissionMarkup(");
  // 三条主路径各自都要 redact
  const redactCount = (body.match(/redact\(/g) ?? []).length;
  assert.ok(redactCount >= 4, `redact 调用只有 ${redactCount} 处，某条路径可能漏了`);
  // 不得有裸插值：所有动态内容必须先 escapeHtml
  const rawInterpolation = body.match(/\$\{(?!escapeHtml|lines|preview\.length|head|description \?|preview\s*\?|entries)/g) ?? [];
  assert.equal(rawInterpolation.length, 0, `存在未转义插值：${rawInterpolation.join(", ")}`);
});

test("工具名缺失时显式标注，不静默留空", () => {
  const body = functionBody(app, "function approvalToolPermissionMarkup(");
  assert.match(body, /未公开/, "工具名缺失应显式说明——空白会让人以为没有工具名这回事");
});

// ═══ 方法标签 ═══

test("方法标签表覆盖全部已登记方法", async () => {
  const { APPROVAL_METHODS } = await import("../src/approval-methods.mjs");
  const table = app.match(/const APPROVAL_METHOD_LABELS = Object\.freeze\(\{[\s\S]*?\}\);/);
  assert.ok(table, "缺少 APPROVAL_METHOD_LABELS");
  for (const method of Object.keys(APPROVAL_METHODS)) {
    // 表里的键可能带引号也可能是裸标识符（execCommandApproval）
    const quoted = `"${method}"`;
    assert.ok(
      table[0].includes(quoted) || new RegExp(`\\b${method}:`).test(table[0]),
      `方法 ${method} 无可读标签，会以裸协议名显示给操作者`,
    );
  }
});

test("标签函数对未登记方法原样返回方法名（不显示成别的东西）", () => {
  const body = functionBody(app, "function approvalMethodLabel(");
  assert.match(body, /APPROVAL_METHOD_LABELS\[value\] \|\| value/, "未登记方法应回落到方法名本身");
});

test("两处审批 UI 都用标签函数（避免只改一处造成不一致）", () => {
  // bot 卡片 + 安全诊断页的 inline 卡
  const uses = app.match(/approvalMethodLabel\(method\)/g) ?? [];
  assert.ok(uses.length >= 2, `标签函数只被用了 ${uses.length} 处，另一处仍显示裸方法名`);
  // 安全页保留原方法名作 title，便于排障时对上协议
  assert.match(app, /title="\$\{escapeHtml\(method\)\}">\$\{escapeHtml\(approvalMethodLabel\(method\)\)\}/);
});

test("标签只做展示，不参与任何决策逻辑", () => {
  const body = functionBody(app, "function approvalMethodLabel(");
  for (const forbidden of ["approve", "deny", "disabled", "request("]) {
    assert.ok(!body.includes(forbidden), `标签函数里出现了决策相关的 ${forbidden}`);
  }
});

// ═══ 元验收 ═══

test("元验收：删掉分派分支，测试必须发现", () => {
  const gutted = app.replace(
    new RegExp(`if \\(method === "${METHOD.replace(/\//g, "\\/")}"\\) \\{[\\s\\S]*?\\n  \\}`),
    "",
  );
  const body = functionBody(gutted, "function approvalParamsMarkup(");
  assert.ok(!body.includes("approvalToolPermissionMarkup"), "前提：删掉后分派应消失");
  // 真实源码必须有
  assert.match(functionBody(app, "function approvalParamsMarkup("), /approvalToolPermissionMarkup/);
});

test("元验收：拿掉 redact，安全断言必须变红", () => {
  const body = functionBody(app, "function approvalToolPermissionMarkup(");
  const stripped = body.replace(/redact\(/g, "String(");
  assert.equal((stripped.match(/redact\(/g) ?? []).length, 0, "前提：替换后应无 redact");
  assert.ok((body.match(/redact\(/g) ?? []).length >= 4, "真实源码应有多处 redact");
});
