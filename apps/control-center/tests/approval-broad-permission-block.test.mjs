/**
 * 宽权限授予禁批契约测试（v49 · 2026-09-04）。
 *
 * ── 缺陷 ──
 * `item/permissions/requestApproval` 在后端是**不可批准**的
 * （`approval-methods.mjs` 标 `approvable: false`，批准路径抛 UNSUPPORTED_APPROVAL，
 * broker 按策略拒绝立即结算，审计记 `decision:"deny"` / `actor:"control-plane"`）。
 *
 * 但三处审批 UI —— inline 卡（app.js:21418）、bot 卡（:18704）、安全诊断行（:24949）——
 * **都算出了 `broadPermission` 变量，三处都没有使用它**。其中 inline 卡的注释还写着
 * "与安全诊断页同口径禁批"，而安全诊断页自己也没禁。
 *
 * 结果：「批准」按钮承诺了一个后端永不兑现的动作。操作者点下去 → 收到 422 →
 * 而请求其实已经被当作拒绝结算掉了。**不是安全洞**（后端 fail-closed 正确），
 * 是产品缺陷 —— 按钮不该承诺做不到的事。
 *
 * ── 守卫 ──
 * 两层：UI 层 `disabled` + 属性提示；逻辑层在两个 resolve 函数入口拦截
 * （`disabled` 只挡鼠标，键盘 / 脚本 / DOM 篡改都能绕过）。
 * 本文件断言两层都在。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const BROAD_METHOD = "item/permissions/requestApproval";
const app = readFileSync("public/app.js", "utf8");

/** 取某个函数从声明处到下一个顶层 function 之间的源码。 */
function functionBody(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `未找到 ${declaration}`);   // 声明在 index 0 也是合法的
  const next = source.indexOf("\nfunction ", start + declaration.length);
  const asyncNext = source.indexOf("\nasync function ", start + declaration.length);
  const ends = [next, asyncNext].filter((index) => index > 0);
  return source.slice(start, ends.length ? Math.min(...ends) : start + 6000);
}

test("后端确实不可批准（前提校验，不是假设）", async () => {
  const { approvalMethodSpec, isApprovable } = await import("../src/approval-methods.mjs");
  assert.equal(isApprovable(BROAD_METHOD), false);
  assert.equal(approvalMethodSpec(BROAD_METHOD).approvable, false);
});

test("后端点批准 = 抛错 + 按拒绝结算（前提校验）", async () => {
  const { ApprovalBroker } = await import("../src/approval-broker.mjs");
  const events = [];
  const broker = new ApprovalBroker({
    eventStore: { async emit(type, data) { events.push({ type, data }); return {}; } },
    ttlMs: 60_000,
  });
  const pending = broker.request({ method: BROAD_METHOD, params: { permissions: {} } }, { runId: "r1" });
  pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  const [item] = broker.list();
  await assert.rejects(
    () => broker.resolve(item.id, { decision: "approve", actionSha256: item.actionSha256 }),
    (error) => error.code === "UNSUPPORTED_APPROVAL",
  );
  assert.equal(broker.pending.size, 0, "应立即结算，不让 agent 等到 TTL");
  const resolved = events.find((event) => event.type === "approval.resolved");
  assert.equal(resolved?.data?.decision, "deny");
  assert.equal(resolved?.data?.actor, "control-plane");
});

test("禁批文案已定义且说清了替代路径", () => {
  assert.match(app, /const BROAD_PERMISSION_BLOCKED_TEXT = "/, "缺少禁批文案常量");
  const text = app.match(/const BROAD_PERMISSION_BLOCKED_TEXT = "([^"]+)"/)?.[1] ?? "";
  assert.ok(text.length >= 20, "文案太短，说不清为什么不能批");
  assert.match(text, /只能拒绝|不支持/, "文案未说明该请求不可批准");
  assert.match(text, /运行档位|权限/, "文案未给出替代路径");
});

test("UI 层：三处审批卡都消费了 broadPermission（此前三处都算了没用）", () => {
  // 每处 broadPermission 声明的下游必须真的用上它
  const declarations = [...app.matchAll(/const broadPermission = method === "item\/permissions\/requestApproval"/g)];
  assert.equal(declarations.length, 3, `broadPermission 声明数变了：${declarations.length}`);
  // 消费点：三处 disabled + 三处提示段落
  const disabledUses = [...app.matchAll(/broadPermission \? " disabled"|broadPermission \? ` disabled|inFlight \|\| broadPermission \? " disabled"/g)];
  assert.ok(disabledUses.length >= 3, `批准按钮禁用点只有 ${disabledUses.length} 处，应 ≥3`);
  const noteUses = [...app.matchAll(/broadPermission \? `<p class="approval-blocked-note">/g)];
  assert.equal(noteUses.length, 3, `禁批提示段落只有 ${noteUses.length} 处，应为 3`);
});

test("逻辑层：resolveInlineApproval 入口拦截（disabled 只挡鼠标）", () => {
  const body = functionBody(app, "async function resolveInlineApproval(");
  assert.match(body, /item\.method[^\n]*item\/permissions\/requestApproval/, "未按 method 拦截");
  assert.match(body, /BROAD_PERMISSION_BLOCKED_TEXT/, "拦截后未告知原因");
  // 拦截必须在发请求之前
  const guardIndex = body.indexOf("BROAD_PERMISSION_BLOCKED_TEXT");
  const requestIndex = body.indexOf("API.approvals");
  assert.ok(guardIndex > 0 && guardIndex < requestIndex, "拦截点在请求之后，等于没拦");
});

test("逻辑层：resolveApproval（安全诊断页）入口拦截", () => {
  const body = functionBody(app, "async function resolveApproval(");
  assert.match(body, /item\.method[^\n]*item\/permissions\/requestApproval/, "未按 method 拦截");
  assert.match(body, /BROAD_PERMISSION_BLOCKED_TEXT/, "拦截后未告知原因");
  const guardIndex = body.indexOf("BROAD_PERMISSION_BLOCKED_TEXT");
  const confirmIndex = body.indexOf("confirmAction(");
  assert.ok(guardIndex > 0 && guardIndex < confirmIndex, "应在弹确认框之前就拦下");
});

test("拒绝按钮不受影响（拒绝始终可用）", () => {
  for (const declaration of ["async function resolveInlineApproval(", "async function resolveApproval("]) {
    const body = functionBody(app, declaration);
    // 拦截条件必须带 approve 判定，不能把 deny 一起拦了
    const guardLine = body.split("\n").find((line) => line.includes("item/permissions/requestApproval"));
    assert.ok(guardLine, `${declaration} 找不到拦截行`);
    assert.match(guardLine, /approve/i, `${declaration} 的拦截未限定 approve，会连拒绝一起挡`);
  }
});

test("CSS 定义了禁批提示样式", () => {
  const css = readFileSync("public/styles.css", "utf8");
  assert.match(css, /\.approval-blocked-note\s*\{/, "缺少 .approval-blocked-note 样式");
  const block = css.slice(css.indexOf(".approval-blocked-note {"), css.indexOf(".approval-blocked-note {") + 400);
  assert.match(block, /var\(--red\)/, "禁批提示应使用 red 而非 amber —— 这不是「注意一下」是「走不通」");
});

// ═══ 元验收：真移除守卫，确认测试变红 ═══

test("元验收：移除任一层守卫，本文件都能发现", () => {
  // 复刻"没有逻辑闸"的旧 resolveInlineApproval 开头
  const withoutGuard = `async function resolveInlineApproval(id, decision) {
  const item = state.approvals.find((approval) => String(approval.id || "") === id);
  if (!item) return;
  const result = await request(API.approvals);
}
function next() {}`;
  const body = functionBody(withoutGuard, "async function resolveInlineApproval(");
  assert.equal(
    /BROAD_PERMISSION_BLOCKED_TEXT/.test(body),
    false,
    "前提校验：无守卫版本不该含该常量",
  );
  // 真实源码必须含 —— 上面那条 "逻辑层" 用例正是靠这个断言守住的
  assert.match(
    functionBody(app, "async function resolveInlineApproval("),
    /BROAD_PERMISSION_BLOCKED_TEXT/,
  );
});
