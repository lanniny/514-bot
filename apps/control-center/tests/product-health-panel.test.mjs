/**
 * P-23 产品健康看板测试（v48 S0-4）。
 *
 * 锁两件事：
 *   1. 死能力识别（P-20 判据）——"从未打开"必须准确，它将决定砍哪个功能
 *   2. 读取失败必须显示失败，绝不用零值冒充"一切正常"
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createProductHealthPanel, computeViewCoverage, countFriction, viewCoverageFromSummary } from "../public/modules/product-health-panel.js";
import { NAV_ITEMS } from "../public/modules/nav-config.js";
import { PRODUCT_ACTION_IDS, REGISTERED_CAPABILITIES } from "../public/modules/product-telemetry-catalog.js";

// ── 纯函数 ─────────────────────────────────────────────────────────────────

test("computeViewCoverage 正确区分在用与从未打开", () => {
  const known = ["bot", "workbench", "team", "market"];
  const result = computeViewCoverage(["bot", "team"], known);
  assert.deepEqual(result.used, ["bot", "team"]);
  assert.deepEqual(result.unused, ["workbench", "market"]);
  assert.equal(result.total, 4);
  assert.equal(result.ratio, 0.5);
});

test("零埋点时全部视图判为从未打开，而非全部在用", () => {
  const result = computeViewCoverage([], ["bot", "team"]);
  assert.deepEqual(result.used, []);
  assert.deepEqual(result.unused, ["bot", "team"]);
  assert.equal(result.ratio, 0);
});

test("默认已知集来自 nav-config，与导航单一真源同步", () => {
  const result = computeViewCoverage([]);
  assert.equal(result.total, Object.keys(NAV_ITEMS).length);
  assert.ok(result.total >= 14, "当前导航至少 14 个视图");
});

test("埋点里出现的未知视图不会污染覆盖率分母", () => {
  const result = computeViewCoverage(["bot", "ghost-view"], ["bot", "team"]);
  assert.deepEqual(result.used, ["bot"]);
  assert.equal(result.total, 2, "分母只认已知视图集");
});

test("countFriction 合计三类摩擦信号", () => {
  assert.equal(countFriction({ "friction.error": 2, "friction.abandon": 1, "friction.repeat": 3 }), 6);
  assert.equal(countFriction({ "usage.view": 99 }), 0, "非摩擦类型不计入");
  assert.equal(countFriction({}), 0);
});

// ── 渲染与降级 ─────────────────────────────────────────────────────────────

function tableBody(store) {
  return {
    replaceChildren() { store.length = 0; },
    insertRow() {
      const row = { cells: [], insertCell() { const c = {}; this.cells.push(c); return c; } };
      store.push(row);
      return row;
    },
  };
}

function domHarness() {
  const nodes = new Map();
  const rows = [];
  const actionRows = [];
  const byId = (id) => {
    if (id === "ph-views-body") return tableBody(rows);
    if (id === "ph-actions-body") return tableBody(actionRows);
    if (!nodes.has(id)) nodes.set(id, { textContent: "" });
    return nodes.get(id);
  };
  return { byId, nodes, rows, actionRows, textOf: (id) => nodes.get(id)?.textContent };
}

test("有托付数据时渲染百分比与明细", async () => {
  const dom = domHarness();
  const panel = createProductHealthPanel({
    request: async () => ({
      enabled: true, total: 10, dropped: 0, byType: {}, byView: { bot: 5 },
      observedViews: ["bot"], trustedDelegationRate: 0.75, delegations: 4, interventions: 1,
    }),
    byId: dom.byId,
  });
  await panel.loadProductHealth();
  assert.equal(dom.textOf("ph-trust-rate"), "75%");
  assert.equal(dom.textOf("ph-trust-detail"), "4 次托付 · 1 次干预");
  assert.equal(dom.textOf("ph-total"), "10");
});

test("无托付数据显示「暂无」而不是 100%", async () => {
  const dom = domHarness();
  const panel = createProductHealthPanel({
    request: async () => ({
      enabled: true, total: 3, dropped: 0, byType: {}, byView: { bot: 3 },
      observedViews: ["bot"], trustedDelegationRate: null, delegations: 0, interventions: 0,
    }),
    byId: dom.byId,
  });
  await panel.loadProductHealth();
  assert.equal(dom.textOf("ph-trust-rate"), "暂无", "空数据不得被读成完美表现");
  assert.equal(dom.textOf("ph-trust-detail"), "尚未记录托付");
});

test("读取失败显示失败原因，绝不用零值冒充正常", async () => {
  const dom = domHarness();
  const panel = createProductHealthPanel({
    request: async () => { throw new Error("网络不可达"); },
    byId: dom.byId,
  });
  await panel.loadProductHealth();
  assert.equal(dom.textOf("ph-trust-rate"), "--");
  assert.equal(dom.textOf("ph-total"), "--", "失败时必须是 -- 而不是 0");
  assert.match(dom.textOf("ph-meta"), /读取失败/);
});

test("viewCoverageFromSummary 优先用服务端 unusedViews", () => {
  const result = viewCoverageFromSummary({
    knownViews: ["bot", "workbench", "team"],
    usedViews: ["bot"],
    unusedViews: ["workbench", "team"],
    observedViews: ["bot", "ghost"],
  });
  assert.deepEqual(result.used, ["bot"]);
  assert.deepEqual(result.unused, ["workbench", "team"]);
  assert.equal(result.total, 3);
});

test("视图表把从未打开的视图也列出来并标注", async () => {
  const dom = domHarness();
  const panel = createProductHealthPanel({
    request: async () => ({
      enabled: true, total: 5, dropped: 0, byType: {}, byView: { bot: 5 },
      observedViews: ["bot"], trustedDelegationRate: null, delegations: 0, interventions: 0,
    }),
    byId: dom.byId,
  });
  await panel.loadProductHealth();
  assert.equal(dom.rows.length, Object.keys(NAV_ITEMS).length, "在用 + 从未打开 = 全集");
  const statuses = dom.rows.map((row) => row.cells[2].textContent);
  assert.equal(statuses.filter((s) => s === "在用").length, 1);
  assert.ok(statuses.filter((s) => s === "从未打开").length >= 13);
});

test("动作表把从未使用的注册动作列出来", async () => {
  const dom = domHarness();
  const panel = createProductHealthPanel({
    request: async () => ({
      enabled: true, total: 1, dropped: 0, byType: {}, byView: {},
      byCapability: { [PRODUCT_ACTION_IDS.paletteInvoke]: 1 },
      observedViews: [],
      knownCapabilities: [...REGISTERED_CAPABILITIES],
      usedCapabilities: [PRODUCT_ACTION_IDS.paletteInvoke],
      unusedCapabilities: REGISTERED_CAPABILITIES.filter((id) => id !== PRODUCT_ACTION_IDS.paletteInvoke),
      trustedDelegationRate: null, delegations: 0, interventions: 0,
    }),
    byId: dom.byId,
  });
  await panel.loadProductHealth();
  assert.equal(dom.actionRows.length, REGISTERED_CAPABILITIES.length);
  const statuses = dom.actionRows.map((row) => row.cells[2].textContent);
  assert.equal(statuses.filter((s) => s === "在用").length, 1);
  assert.ok(statuses.filter((s) => s === "从未使用").length >= 7);
});

test("truncated 时明确标注为部分样本", async () => {
  const dom = domHarness();
  const panel = createProductHealthPanel({
    request: async () => ({
      enabled: true, total: 200000, dropped: 0, truncated: true, byType: {}, byView: {},
      observedViews: [], trustedDelegationRate: null, delegations: 0, interventions: 0,
    }),
    byId: dom.byId,
  });
  await panel.loadProductHealth();
  assert.match(dom.textOf("ph-total-detail"), /部分样本/);
});

test("关闭状态在 meta 与按钮文案上同步反映", async () => {
  const dom = domHarness();
  const panel = createProductHealthPanel({
    request: async () => ({
      enabled: false, total: 0, dropped: 0, byType: {}, byView: {},
      observedViews: [], trustedDelegationRate: null, delegations: 0, interventions: 0,
    }),
    byId: dom.byId,
  });
  await panel.loadProductHealth();
  assert.equal(dom.textOf("ph-meta"), "已关闭");
  assert.equal(dom.textOf("ph-toggle-label"), "开启埋点");
});

test("缺少依赖时构造即失败，不静默变成空实现", () => {
  assert.throws(() => createProductHealthPanel({ byId: () => null }), /requires request/);
  assert.throws(() => createProductHealthPanel({ request: async () => ({}) }), /requires byId/);
});
