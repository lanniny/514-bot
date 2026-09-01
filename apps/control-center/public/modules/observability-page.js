// modules/observability-page.js — Wave B slice 18
// 体系观测面：route-gate / DELTA / handoff / ops 指标 / worktree 台账 / 漂移检查。
// 工厂 + DI：state/elements/request/toast 从 app.js 注入；
// escapeHtml/inlineEmpty/runAsyncAction/API 走静态导入。

import { escapeHtml } from "../utils.js";
import { API } from "../api.js";
import { inlineEmpty } from "./placeholders.js";
import { runAsyncAction } from "./async-action.js";

export function createObservabilityPage({
  state,
  elements,
  request,
  toast,
}) {
  let observabilityLoadGeneration = 0;

  async function loadObservability() {
    const generation = ++observabilityLoadGeneration;
    state.obsLoaded = true;
    try {
      const [summary, routeGate, delta, handoffs, ops, worktrees] = await Promise.all([
        request(API.obsSummary),
        request(API.obsRouteGate),
        request(API.obsDelta),
        request(API.obsHandoffs),
        request(API.obsOps),
        request(API.worktrees).catch(() => null),
      ]);
      if (generation !== observabilityLoadGeneration) return;
      state.obsSummary = summary;
      state.obsRouteGate = routeGate;
      state.obsDelta = delta;
      state.obsHandoffs = handoffs.handoffs ?? [];
      state.obsOps = ops;
      state.obsWorktrees = worktrees ?? null;
    } catch (error) {
      if (generation !== observabilityLoadGeneration) return;
      state.obsLoaded = false;
      const failRow = (cols) => `<tr><td colspan="${cols}" class="subtle">加载失败：${escapeHtml(error.message)} — 点击「刷新数据」重试</td></tr>`;
      elements["obs-routegate-body"].innerHTML = failRow(4);
      elements["obs-delta-body"].innerHTML = failRow(3);
      elements["obs-handoff-body"].innerHTML = failRow(4);
      if (elements["obs-ops-body"]) elements["obs-ops-body"].innerHTML = failRow(3);
      toast(`体系观测数据加载失败：${error.message}`, "error");
      return;
    }
    renderObservability();
  }

  async function runDriftCheck() {
    const button = elements["obs-drift-button"];
    const status = elements["obs-drift-status"];
    try {
      await runAsyncAction(button, async () => {
        status.textContent = "检查中…";
        state.obsDrift = await request(API.obsDrift, { method: "POST" });
      }, { busyLabel: "检查中…" });
    } catch (error) {
      state.obsDrift = null;
      status.textContent = "检查失败";
      elements["obs-drift-body"].innerHTML = `<tr><td colspan="2">${inlineEmpty(`检查失败：${error.message}`)}</td></tr>`;
      toast(`漂移检查失败：${error.message}`, "error");
    }
    renderObservability();
  }

  function formatOpsUnknown(value, suffix = "") {
    if (value == null || (typeof value === "number" && !Number.isFinite(value))) return "未知";
    return `${value}${suffix}`;
  }

  function formatOpsRate(rate) {
    if (rate == null || !Number.isFinite(rate)) return "未知";
    return `${Math.round(rate * 100)}%`;
  }

  function formatOpsUsd(value) {
    if (value == null || !Number.isFinite(value)) return "未知";
    return `$${value.toFixed(4)}`;
  }

  function setMetricValue(id, value) {
    const node = elements[id];
    if (!node) return;
    node.textContent = value;
    const shortNumeric = /^[-—\d./% ]*$/.test(String(value).trim()) && String(value).trim().length <= 8;
    node.classList.toggle("metric-word", !shortNumeric);
  }

  function renderOpsMetrics(ops) {
    if (!ops || !elements["obs-ops-body"]) return;
    const first = ops.firstUsefulResponse || {};
    const outcomes = ops.outcomes || {};
    const cost = ops.costUsd || {};
    const stale = ops.stale || {};
    const approval = ops.approvalWait || {};
    const fallback = ops.routeFallback || {};
    const evidence = ops.evidence || {};
    const transport = ops.promptTransport || {};
    setMetricValue("obs-ops-first", formatOpsUnknown(first.p50Ms, " ms"));
    elements["obs-ops-first-detail"].textContent = first.samples
      ? `${first.samples} 个样本 · ${first.unknown || 0} 个未知时钟`
      : "无样本时不填 0";
    setMetricValue("obs-ops-outcomes", [
      formatOpsRate(outcomes.successRate),
      formatOpsRate(outcomes.failureRate),
      formatOpsRate(outcomes.recoveryRate),
    ].join(" / "));
    elements["obs-ops-outcomes-detail"].textContent = outcomes.total
      ? `成功 ${outcomes.succeeded || 0} · 失败 ${outcomes.failed || 0} · 恢复 ${outcomes.recoveryRequired || 0}`
      : "空窗口比率保持未知";
    setMetricValue("obs-ops-cost", cost.receiptTurns
      ? `${cost.known || 0}/${cost.receiptTurns} 已知`
      : "未知");
    const knownMean = formatOpsUsd(cost.knownMeanUsd);
    elements["obs-ops-cost-detail"].textContent = cost.unknown
      ? `${cost.unknown} 次回执无成本，不计入均值（已知均值 ${knownMean}）`
      : `缺失成本不当 $0 · 已知均值 ${knownMean}`;
    setMetricValue("obs-ops-stale", formatOpsUnknown(stale.total));
    elements["obs-ops-stale-detail"].textContent = stale.healthCacheStale
      ? `健康缓存过期 · 在途 stale ${stale.staleRunCount || 0}`
      : `健康缓存有效 · 在途 stale ${stale.staleRunCount || 0}`;
    const rows = [
      ["首个有效响应 p50", formatOpsUnknown(first.p50Ms, " ms"), `${first.samples || 0} 样本 / ${first.unknown || 0} 未知`],
      ["成功 / 失败 / 恢复率", `${formatOpsRate(outcomes.successRate)} / ${formatOpsRate(outcomes.failureRate)} / ${formatOpsRate(outcomes.recoveryRate)}`, "无结局样本时为未知"],
      ["审批等待 p50", formatOpsUnknown(approval.p50Ms, " ms"), `仅 pending 队列可观测 · ${approval.pending || 0} 条`],
      ["stale 合计", formatOpsUnknown(stale.total), `健康 ${stale.staleHealthItemCount || 0} + run ${stale.staleRunCount || 0}`],
      ["route fallback", formatOpsUnknown(fallback.events), `路由 ${fallback.runs || 0} + adapter ${fallback.adapterEvents || 0}`],
      ["证据完整率", formatOpsRate(evidence.rate), `${evidence.complete || 0}/${evidence.terminal || 0} 终态执行`],
      ["costUsd 可用率", formatOpsRate(cost.availability), `已知均值 ${knownMean}，未知 ${cost.unknown || 0}`],
      ["中文传输失败", formatOpsUnknown(transport.failures), `UNSAFE ${transport.codes?.PROMPT_TRANSPORT_UNSAFE || 0} · CORRUPT ${transport.codes?.PROMPT_TRANSPORT_CORRUPT || 0}`],
    ];
    elements["obs-ops-body"].innerHTML = rows.map(([name, value, note]) => `<tr>
    <td>${escapeHtml(name)}</td>
    <td class="mono">${escapeHtml(value)}</td>
    <td class="subtle">${escapeHtml(note)}</td>
  </tr>`).join("");
  }

  function renderObservability() {
    const gate = state.obsRouteGate;
    if (gate) {
      setMetricValue("obs-routegate-count", gate.available ? String(gate.total) : "无日志");
      elements["obs-routegate-detail"].textContent = gate.available
        ? `${gate.red} RED / ${gate.gray} gray`
        : "route-gate.log 不存在";
      elements["obs-routegate-body"].innerHTML = (gate.recent ?? [])
        .map(
          (row) => `<tr>
          <td class="mono">${escapeHtml(row.ts)}</td>
          <td><span class="status-label ${row.flag === "red" ? "is-error" : "is-neutral"}">${row.flag === "red" ? "RED" : "gray"}</span></td>
          <td class="mono">${escapeHtml(row.reason)}</td>
          <td>${escapeHtml(row.prompt)}</td>
        </tr>`,
        )
        .join("") || `<tr><td colspan="4">近 7 天无记录</td></tr>`;
    }
    const delta = state.obsDelta;
    if (delta) {
      setMetricValue("obs-delta-count", String(delta.total));
      elements["obs-delta-detail"].textContent = `白发 ${delta.byScore[0]} · 补强 ${delta.byScore[1]} · 推翻 ${delta.byScore[2]}`;
      elements["obs-delta-body"].innerHTML = (delta.recent ?? [])
        .map(
          (entry) => `<tr>
          <td>${escapeHtml(entry.agent)}</td>
          <td><span class="status-label ${entry.score === 2 ? "is-error" : entry.score === 1 ? "is-warning" : "is-neutral"}">${entry.score ?? "?"}</span></td>
          <td>${escapeHtml(entry.evidence)}</td>
        </tr>`,
        )
        .join("") || `<tr><td colspan="3">账本为空</td></tr>`;
    }
    const summary = state.obsSummary;
    if (summary) {
      setMetricValue("obs-fire-days",
        summary.handoffs.daysSinceLastFire === null ? "无记录" : `${summary.handoffs.daysSinceLastFire} 天`);
      elements["obs-fire-detail"].textContent = summary.handoffs.lastFire ?? "尚无外部发火 handoff";
    }
    const drift = state.obsDrift;
    if (drift) {
      const pairCount = (drift.pairs ?? []).length;
      setMetricValue("obs-drift-status", drift.drifted ? `${drift.drifted} 对不一致` : pairCount ? "全部一致" : "无对账数据");
      elements["obs-drift-status"].classList.toggle("is-error", drift.drifted > 0 || !pairCount);
      const pairs = [...(drift.pairs ?? [])].sort((a, b) => (a.status !== "consistent" ? -1 : 0) - (b.status !== "consistent" ? -1 : 0));
      elements["obs-drift-body"].innerHTML = pairs
        .map((pair) => {
          const label = pair.status === "drift" ? "漂移" : pair.status === "missing" ? "缺失" : "一致";
          const tone = pair.status === "drift" ? "is-error" : pair.status === "missing" ? "is-warning" : "is-ok";
          return `<tr>
          <td class="mono">${escapeHtml(pair.name)}</td>
          <td><span class="status-label ${tone}">${label}</span></td>
        </tr>`;
        })
        .join("") || `<tr><td colspan="2" class="subtle">漂移检查未返回配对明细。</td></tr>`;
    }
    elements["obs-handoff-body"].innerHTML = state.obsHandoffs
      .map(
        (item) => `<tr class="handoff-row" data-handoff="${escapeHtml(item.name)}" title="点击查看内容">
        <td class="mono">${escapeHtml(item.name)}</td>
        <td><span class="status-label ${item.direction === "external-fire" ? "is-warning" : "is-neutral"}">${escapeHtml(item.direction)}</span></td>
        <td>${(item.size / 1024).toFixed(1)} KB</td>
        <td class="mono">${escapeHtml(item.modifiedAt.slice(0, 16).replace("T", " "))}</td>
      </tr>`,
      )
      .join("") || `<tr><td colspan="4">暂无 handoff</td></tr>`;
    elements["obs-handoff-meta"].textContent = `${state.obsHandoffs.length} 个交接件 · 点击行查看内容`;
    renderObservabilityWorktrees();
    renderOpsMetrics(state.obsOps);
  }

  function renderObservabilityWorktrees() {
    const body = document.getElementById("obs-worktree-body");
    const meta = document.getElementById("obs-worktree-meta");
    if (!body || !meta) return;
    const view = state.obsWorktrees;
    if (!view) {
      body.innerHTML = `<tr><td colspan="6" class="subtle">台账不可用（旧数据根或读取失败）</td></tr>`;
      meta.textContent = "台账不可用";
      return;
    }
    meta.textContent = `共 ${view.total} 条记录 · 活跃 ${view.activeCount}`;
    body.innerHTML = (view.worktrees ?? [])
      .map((item) => `<tr class="worktree-row">
      <td class="mono" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</td>
      <td>${escapeHtml(item.source ?? "–")}</td>
      <td class="mono">${escapeHtml(item.runId ? item.runId.slice(0, 8) : "–")}</td>
      <td class="mono">${escapeHtml(String(item.createdAt ?? "–").slice(0, 16).replace("T", " "))}</td>
      <td><span class="status-label ${item.removedAt ? "is-neutral" : "is-ok"}">${item.removedAt ? "已清理" : "活跃"}</span></td>
      <td>${item.removedAt ? "" : `<button class="button danger compact" type="button" data-worktree-remove="${escapeHtml(item.path)}">清理</button>`}</td>
    </tr>`)
      .join("") || `<tr><td colspan="6" class="subtle">台账为空——还没有过建树记录</td></tr>`;
  }

  async function removeWorktree(path) {
    try {
      await request(`${API.worktrees}?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      toast("工作树已清理", "success", 2200);
    } catch (error) {
      toast(`清理失败：${error.message}`, "error");
      return;
    }
    void loadObservability();
  }

  async function openHandoff(name) {
    try {
      const payload = await request(`${API.obsHandoffs}/${encodeURIComponent(name)}`);
      elements["obs-handoff-content"].hidden = false;
      elements["obs-handoff-content"].textContent = payload.content;
      elements["obs-handoff-content"].scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) {
      toast(`读取 handoff 失败：${error.message}`, "error");
    }
  }

  return {
    loadObservability,
    runDriftCheck,
    removeWorktree,
    openHandoff,
  };
}
