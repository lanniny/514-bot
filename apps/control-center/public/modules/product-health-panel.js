/**
 * P-23 产品健康看板（v48 S0-4）。
 *
 * 与"体系观测"的分工：那里看**系统**健康（路由门 / DELTA / 漂移 / ops 指标），
 * 这里看**产品**健康——能力实际被用到什么程度、哪些视图从未被打开、托付敢不敢放手。
 *
 * 数据源：GET /api/telemetry/summary（纯本地聚合，见 src/product-telemetry.mjs）。
 *
 * 实现纪律：全程 DOM API，零 innerHTML —— `ui:lint` 的 inner-html 基线是 389，
 * 新写的模块不该往这笔债上加，顺手也给后续模块做个示范。
 */

import { NAV_ITEMS } from "./nav-config.js";
import { PRODUCT_ACTIONS, unusedRegistered } from "./product-telemetry-catalog.js";
import { API } from "../api.js";

/** 未被观察到的视图 = 已知全集 − 埋点里出现过的。这是 P-20 死能力回收的直接判据。 */
export function computeViewCoverage(observedViews = [], knownViews = Object.keys(NAV_ITEMS)) {
  const coverage = unusedRegistered(observedViews, knownViews);
  return {
    used: coverage.used,
    unused: coverage.unused,
    total: coverage.known.length,
    ratio: coverage.known.length ? coverage.used.length / coverage.known.length : 0,
  };
}

/** 优先信服务端差集（C5）；旧 summary 没有 unusedViews 时回退到本地计算。 */
export function viewCoverageFromSummary(summary = {}) {
  if (Array.isArray(summary.unusedViews) && Array.isArray(summary.knownViews) && summary.knownViews.length) {
    return {
      used: Array.isArray(summary.usedViews) ? summary.usedViews : summary.knownViews.filter((view) => !summary.unusedViews.includes(view)),
      unused: summary.unusedViews,
      total: summary.knownViews.length,
      ratio: summary.knownViews.length ? (summary.knownViews.length - summary.unusedViews.length) / summary.knownViews.length : 0,
    };
  }
  return computeViewCoverage(summary.observedViews || []);
}

export function actionCoverageFromSummary(summary = {}) {
  const known = Array.isArray(summary.knownCapabilities) && summary.knownCapabilities.length
    ? summary.knownCapabilities
    : Object.keys(PRODUCT_ACTIONS);
  if (Array.isArray(summary.unusedCapabilities)) {
    return {
      used: Array.isArray(summary.usedCapabilities) ? summary.usedCapabilities : known.filter((id) => !summary.unusedCapabilities.includes(id)),
      unused: summary.unusedCapabilities,
      total: known.length,
    };
  }
  return unusedRegistered(Object.keys(summary.byCapability || {}), known);
}

/** 摩擦信号合计：friction.* 三类之和。 */
export function countFriction(byType = {}) {
  return ["friction.error", "friction.abandon", "friction.repeat"]
    .reduce((sum, key) => sum + (Number(byType[key]) || 0), 0);
}

function text(node, value) {
  if (node) node.textContent = String(value);
}

function cell(row, value, className) {
  const td = row.insertCell();
  td.textContent = String(value);
  if (className) td.className = className;
  return td;
}

export function createProductHealthPanel({ request, byId, toast = () => {} } = {}) {
  if (typeof request !== "function") throw new Error("createProductHealthPanel requires request()");
  if (typeof byId !== "function") throw new Error("createProductHealthPanel requires byId()");

  let latest = null;

  function renderUsageTable(bodyId, rows, { emptyLabel, unusedLabel = "从未打开" } = {}) {
    const body = byId(bodyId);
    if (!body) return;
    body.replaceChildren();
    if (!rows.length) {
      const row = body.insertRow();
      cell(row, emptyLabel, "subtle").colSpan = 3;
      return;
    }
    for (const item of rows) {
      const row = body.insertRow();
      cell(row, item.label);
      cell(row, item.count);
      cell(row, item.unused ? unusedLabel : "在用", item.unused ? "warn-text" : "subtle");
    }
  }

  function renderViewsTable(summary) {
    const coverage = viewCoverageFromSummary(summary);
    const rows = [
      ...coverage.used
        .map((view) => ({ label: NAV_ITEMS[view]?.label ?? view, count: summary.byView?.[view] ?? 0, unused: false }))
        .sort((a, b) => b.count - a.count),
      ...coverage.unused.map((view) => ({ label: NAV_ITEMS[view]?.label ?? view, count: 0, unused: true })),
    ];
    renderUsageTable("ph-views-body", rows, { emptyLabel: "暂无注册视图" });
  }

  function renderActionsTable(summary) {
    const coverage = actionCoverageFromSummary(summary);
    const rows = [
      ...coverage.used
        .map((id) => ({ label: PRODUCT_ACTIONS[id]?.label ?? id, count: summary.byCapability?.[id] ?? 0, unused: false }))
        .sort((a, b) => b.count - a.count),
      ...coverage.unused.map((id) => ({ label: PRODUCT_ACTIONS[id]?.label ?? id, count: 0, unused: true })),
    ];
    renderUsageTable("ph-actions-body", rows, { emptyLabel: "暂无注册动作", unusedLabel: "从未使用" });
  }

  function render(summary) {
    latest = summary;
    const coverage = viewCoverageFromSummary(summary);
    // 没有托付数据时显示"暂无"而不是 100% —— 空数据不得被读成完美表现
    text(byId("ph-trust-rate"), summary.trustedDelegationRate === null
      ? "暂无"
      : `${Math.round(summary.trustedDelegationRate * 100)}%`);
    text(byId("ph-trust-detail"), summary.delegations
      ? `${summary.delegations} 次托付 · ${summary.interventions} 次干预`
      : "尚未记录托付");
    text(byId("ph-coverage"), `${coverage.used.length}/${coverage.total}`);
    text(byId("ph-coverage-detail"), coverage.unused.length
      ? `${coverage.unused.length} 个视图从未打开`
      : "全部视图均有使用");
    text(byId("ph-total"), summary.total ?? 0);
    text(byId("ph-total-detail"), summary.truncated
      ? "已达扫描上限，统计为部分样本"
      : `丢弃 ${summary.dropped ?? 0} 条 · 纯本地不外发`);
    text(byId("ph-friction"), countFriction(summary.byType));
    text(byId("ph-meta"), summary.enabled
      ? `已启用 · ${summary.lastAt ? new Date(summary.lastAt).toLocaleString() : "尚无事件"}`
      : "已关闭");
    text(byId("ph-toggle-label"), summary.enabled ? "关闭埋点" : "开启埋点");
    renderViewsTable(summary);
    renderActionsTable(summary);
  }

  function renderUnavailable(message) {
    for (const id of ["ph-trust-rate", "ph-coverage", "ph-total", "ph-friction"]) text(byId(id), "--");
    text(byId("ph-meta"), message);
    for (const id of ["ph-views-body", "ph-actions-body"]) {
      const body = byId(id);
      if (!body) continue;
      body.replaceChildren();
      const row = body.insertRow();
      cell(row, message, "subtle").colSpan = 3;
    }
  }

  async function loadProductHealth() {
    try {
      render(await request(API.telemetrySummary));
    } catch (error) {
      // 如实降级：显示读取失败，绝不用旧数据或零值冒充"一切正常"
      renderUnavailable(`读取失败：${error?.message ?? "未知错误"}`);
    }
  }

  async function toggleTelemetry() {
    const next = !(latest?.enabled ?? true);
    try {
      await request(API.telemetrySettings, { method: "POST", body: JSON.stringify({ enabled: next }) });
      toast(next ? "埋点已开启" : "埋点已关闭");
      await loadProductHealth();
    } catch (error) {
      toast(`切换失败：${error?.message ?? "未知错误"}`, "error");
    }
  }

  async function clearTelemetry() {
    try {
      await request(API.telemetryClear, { method: "DELETE" });
      toast("埋点数据已清空");
      await loadProductHealth();
    } catch (error) {
      toast(`清空失败：${error?.message ?? "未知错误"}`, "error");
    }
  }

  return { loadProductHealth, toggleTelemetry, clearTelemetry, render, computeViewCoverage };
}
