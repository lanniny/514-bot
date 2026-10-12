/**
 * delta-timeline.js — DELTA 问责时间线 v2
 *
 * 可视化展示每次"发火"（召唤 subagent）的 DELTA 证据：
 *   - 谁发的火（烛/织/匠/策/鉴）
 *   - 净增量评分（0=白发/1=补强/2=推翻主驾判断）
 *   - 证据（file:line 或被推翻的原判断）
 *   - 时间线展示
 *
 * v4.0 Forge：自取数（/api/observability/delta），优先 data.deltas[]（新契约
 * {id,ts,agent,score,topic,evidence}），缺失时把旧契约 data.recent[]
 * ({source,agent,score,evidence}) 归一化成同形；图标全部走 Lucide。
 *
 * 这是 514cc 独有特色的可视化——DELTA 问责制。
 */
import { API, request } from "./api.js";
import { lucideIcon } from "./lucide.js";
import { agentBrandKey } from "./team-panel.js";
import { escapeHtml } from "./utils.js";

let _containerEl = null;
let _deltas = [];
let _loading = false;

/**
 * 初始化 DELTA 时间线（契约不变：app.js 传入容器元素）
 * @param {HTMLElement} container - 容器
 */
export function initDeltaTimeline(container) {
  _containerEl = container;
  renderTimeline();
}

/**
 * 更新 DELTA 数据
 * @param {Array} deltas - [{agent, score, evidence, ts|timestamp, topic}]
 */
export function updateDeltaData(deltas) {
  _deltas = (Array.isArray(deltas) ? deltas : []).map(normalizeDelta).filter(Boolean);
  renderTimeline();
}

/**
 * 追加一条 DELTA 记录
 * @param {Object} delta - {agent, score, evidence, ts|timestamp, topic}
 */
export function appendDelta(delta) {
  const normalized = normalizeDelta(delta);
  if (normalized) {
    _deltas.unshift(normalized);
    renderTimeline();
  }
}

/**
 * 自取数刷新：优先新契约 data.deltas，回退归一化旧契约 data.recent。
 * 由观测页自举调用（app.js 的启动序列），不经过中间状态层。
 * @returns {Promise<Array>} 当前已渲染的 deltas
 */
export async function refreshDeltaTimeline() {
  if (_loading) return _deltas;
  _loading = true;
  try {
    const data = await request(API.obsDelta);
    const deltas = normalizeDeltaPayload(data);
    if (deltas) {
      updateDeltaData(deltas);
    } else {
      renderError("DELTA 响应格式未识别");
    }
  } catch (error) {
    renderError(error?.message || "DELTA 数据加载失败");
  } finally {
    _loading = false;
  }
  return _deltas;
}

/** 新契约 deltas[] 或旧契约 recent[] → 统一 {id, ts, agent, score, topic, evidence}；不可识别返回 null。 */
export function normalizeDeltaPayload(data) {
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.deltas)) return data.deltas.map(normalizeDelta).filter(Boolean);
  if (Array.isArray(data.recent)) {
    return data.recent
      .map((entry) => normalizeDelta({
        agent: entry?.agent,
        score: entry?.score,
        evidence: entry?.evidence,
        topic: entry?.source || entry?.topic || null,
        ts: entry?.ts ?? entry?.timestamp ?? null,
      }))
      .filter(Boolean);
  }
  return null;
}

function normalizeDelta(raw) {
  if (!raw || typeof raw !== "object") return null;
  const score = Number.isInteger(raw.score) && raw.score >= 0 && raw.score <= 2 ? raw.score : null;
  const ts = raw.ts ?? raw.timestamp ?? null;
  return {
    id: raw.id || `${ts || "no-ts"}:${raw.agent || "unknown"}:${String(raw.evidence || "").slice(0, 24)}`,
    ts,
    agent: String(raw.agent || "未知"),
    score,
    topic: raw.topic || null,
    evidence: String(raw.evidence || ""),
  };
}

const SCORE_META = Object.freeze({
  0: { label: "白发", icon: "circle-dot", className: "dt-score-0" },
  1: { label: "补强", icon: "arrow-up-right", className: "dt-score-1" },
  2: { label: "推翻", icon: "zap", className: "dt-score-2" },
});

function scoreMeta(score) {
  return SCORE_META[score] || { label: "未评", icon: "circle-dot", className: "dt-score-null" };
}

function renderTimeline() {
  if (!_containerEl) return;

  const header = `
    <div class="dt-header">
      <h3 class="dt-title">
        ${lucideIcon("zap")}
        DELTA 问责
      </h3>
      <span class="dt-badge num">${_deltas.length} 条记录</span>
    </div>
  `;

  if (!_deltas.length) {
    _containerEl.innerHTML = `
      <div class="delta-timeline">
        ${header}
        <div class="dt-empty">
          ${lucideIcon("zap", "icon lucide dt-empty-icon")}
          <p>暂无 DELTA 记录</p>
          <p class="dt-empty-hint">当 subagent 被召唤时，DELTA 证据会自动记录在这里</p>
        </div>
      </div>
    `;
    return;
  }

  const counts = { 0: 0, 1: 0, 2: 0, invalid: 0 };
  for (const d of _deltas) counts[d.score === null ? "invalid" : d.score] += 1;

  _containerEl.innerHTML = `
    <div class="delta-timeline">
      ${header}

      <div class="dt-stats">
        <div class="dt-stat">
          <span class="dt-stat-count num dt-score-0-text">${counts[0]}</span>
          <span class="dt-stat-label">白发</span>
        </div>
        <div class="dt-stat">
          <span class="dt-stat-count num dt-score-1-text">${counts[1]}</span>
          <span class="dt-stat-label">补强</span>
        </div>
        <div class="dt-stat">
          <span class="dt-stat-count num dt-score-2-text">${counts[2]}</span>
          <span class="dt-stat-label">推翻</span>
        </div>
      </div>

      <div class="dt-list">
        ${_deltas.map((d, i) => {
          const meta = scoreMeta(d.score);
          const brand = agentBrandKey(d.agent);
          const time = d.ts ? formatTime(d.ts) : "";

          return `
            <div class="dt-item forge-enter">
              <div class="dt-rail" aria-hidden="true">
                <span class="dt-marker ${meta.className}">${lucideIcon(meta.icon, "icon lucide dt-marker-icon")}</span>
              </div>
              <div class="dt-content">
                <div class="dt-item-header">
                  <span class="dt-agent" data-brand="${escapeHtml(brand)}"><span class="dt-agent-dot"></span>${escapeHtml(d.agent)}</span>
                  <span class="dt-score ${meta.className}">${meta.label}${d.score === null ? "" : ` = ${d.score}`}</span>
                  ${time ? `<span class="dt-time num">${time}</span>` : ""}
                </div>
                ${d.topic ? `<div class="dt-topic">${escapeHtml(d.topic)}</div>` : ""}
                <div class="dt-evidence" title="${escapeHtml(d.evidence || "无证据")}">${escapeHtml(d.evidence || "无证据")}</div>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

function renderError(message) {
  if (!_containerEl) return;
  // 已渲染过内容时保留旧数据，错误以角落提示呈现，不闪空（静默降级）
  if (_deltas.length) {
    renderTimeline();
    return;
  }
  _containerEl.innerHTML = `
    <div class="delta-timeline">
      <div class="dt-header">
        <h3 class="dt-title">${lucideIcon("zap")} DELTA 问责</h3>
      </div>
      <div class="dt-error" role="alert">
        ${lucideIcon("circle-alert", "icon lucide")}
        <span>数据加载失败：${escapeHtml(message)}</span>
        <button type="button" class="dt-retry">重试</button>
      </div>
    </div>
  `;
  _containerEl.querySelector(".dt-retry")?.addEventListener("click", () => refreshDeltaTimeline());
}

function formatTime(ts) {
  try {
    const date = new Date(ts);
    if (!Number.isFinite(date.getTime())) return String(ts);
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return String(ts);
  }
}

// escapeHtml 统一来自 ./utils.js（本文件此前自带副本，且未转义单引号，与规范不一致）
