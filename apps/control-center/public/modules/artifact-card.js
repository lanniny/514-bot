/**
 * W1.3 Artifact 出卡（bot 对话流）：DELTA 账本 / handoff / 发布门禁记录
 * 以可展开卡片出现在对话流，点开左侧列表 + 右侧内容面板（对标 Claude Artifact）。
 *
 * 纪律：
 * - 数据只读三源：/api/observability/delta、/api/observability/handoffs(+/:name)、/api/release-record。
 * - 展开状态与缓存保存在单例上：会话流 innerHTML 全量重建后 mount() 恢复，不闪不重拉。
 * - fail-closed：三源独立 try/catch，单源失败显示该源错误，不拖垮整卡。
 * - handoff 内容渲染前剥离 Markdown 标记并截断——预览不是全文，全文看文件。
 */

const DELTA_PATH = "/api/observability/delta";
const HANDOFFS_PATH = "/api/observability/handoffs";
const RECORD_PATH = "/api/release-record";
const HANDOFF_PREVIEW_CHARS = 1200;
const DELTA_PREVIEW_CHARS = 110;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripMarkdown(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " [代码块] ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_>]+/g, "");
}

function scoreBadge(score) {
  const tone = score === 2 ? "is-score2" : score === 1 ? "is-score1" : score === 0 ? "is-score0" : "is-invalid";
  const label = score === null || score === undefined ? "?" : String(score);
  return `<span class="bot-artifact-score ${tone}" title="DELTA 分数 ${escapeHtml(label)}（0 白发 / 1 补强 / 2 推翻）">${escapeHtml(label)}</span>`;
}

function formatDate(iso) {
  const value = String(iso || "");
  return value.length >= 10 ? value.slice(0, 10) : value || "?";
}

export function createArtifactCard({ request } = {}) {
  if (typeof request !== "function") throw new TypeError("artifact card needs request()");

  let root = null;
  const ui = {
    expanded: false,
    loading: false,
    activeHandoff: null,
    handoffContent: null,
    handoffError: null,
    activeReport: null, // "weekly"
    reportContent: null,
    reportError: null,
    data: null, // { delta, handoffs, record, errors: { delta, handoffs, record } }
  };

  function lucide(name) {
    return `<svg class="icon lucide" aria-hidden="true"><use href="#lucide-${name}"></use></svg>`;
  }

  function counts(data) {
    const delta = data?.delta?.total;
    const handoffs = Array.isArray(data?.handoffs) ? data.handoffs.length : null;
    const verdict = data?.record?.verdict || null;
    return { delta, handoffs, verdict };
  }

  function headerMarkup() {
    const data = ui.data;
    const loadingDot = ui.loading ? ' <span class="bot-artifact-loading" role="status" aria-label="加载中"></span>' : "";
    if (!data) {
      return `<button class="bot-artifact-toggle" type="button" data-artifact-toggle aria-expanded="false">
        <span class="bot-card-icon">${lucide("clipboard-list")}</span>
        <strong>证据产物</strong><span class="bot-artifact-sub">DELTA 账本 · handoff · 发布门禁</span>${loadingDot}
        <span class="bot-artifact-chevron">${lucide("chevron-down")}</span></button>`;
    }
    const c = counts(data);
    const verdictTone = c.verdict === "ready" ? "is-passed" : c.verdict === "blocked" ? "is-failed" : "is-muted";
    return `<button class="bot-artifact-toggle" type="button" data-artifact-toggle aria-expanded="${ui.expanded ? "true" : "false"}">
      <span class="bot-card-icon">${lucide("clipboard-list")}</span>
      <strong>证据产物</strong>
      <span class="bot-artifact-chip">DELTA ${c.delta ?? "–"}</span>
      <span class="bot-artifact-chip">handoff ${c.handoffs ?? "–"}</span>
      <span class="bot-artifact-chip ${verdictTone}">门禁 ${escapeHtml(c.verdict || "–")}</span>${loadingDot}
      <span class="bot-artifact-chevron">${lucide("chevron-down")}</span></button>`;
  }

  function deltaSection() {
    const error = ui.data?.errors?.delta;
    if (error) return `<section class="bot-artifact-section"><h4>DELTA 账本</h4><p class="bot-artifact-error">读取失败：${escapeHtml(error)}</p></section>`;
    const deltas = Array.isArray(ui.data?.delta?.deltas) ? ui.data.delta.deltas.slice(0, 6) : [];
    return `<section class="bot-artifact-section"><h4>DELTA 账本 <span>最近 ${deltas.length}</span></h4>
      ${deltas.length ? deltas.map((entry) => `<div class="bot-artifact-row">
        ${scoreBadge(entry.score)}<span class="bot-artifact-agent">${escapeHtml(entry.agent || "?")}</span>
        <span class="bot-artifact-copy">${escapeHtml(String(entry.evidence || "").slice(0, DELTA_PREVIEW_CHARS))}${String(entry.evidence || "").length > DELTA_PREVIEW_CHARS ? "…" : ""}</span>
      </div>`).join("") : '<p class="bot-artifact-empty">暂无条目</p>'}</section>`;
  }

  function handoffSection() {
    const error = ui.data?.errors?.handoffs;
    if (error) return `<section class="bot-artifact-section"><h4>handoff</h4><p class="bot-artifact-error">读取失败：${escapeHtml(error)}</p></section>`;
    const files = Array.isArray(ui.data?.handoffs) ? ui.data.handoffs.slice(0, 6) : [];
    return `<section class="bot-artifact-section"><h4>handoff <span>最近 ${files.length} · 点击右侧预览</span></h4>
      ${files.length ? files.map((file) => `<button class="bot-artifact-row is-clickable${ui.activeHandoff === file.name ? " is-active" : ""}" type="button" data-artifact-handoff="${escapeHtml(file.name)}">
        ${lucide("file-text")}<span class="bot-artifact-copy">${escapeHtml(file.name)}</span>
        <span class="bot-artifact-meta">${escapeHtml(formatDate(file.modifiedAt))}</span>
      </button>`).join("") : '<p class="bot-artifact-empty">暂无文件</p>'}</section>`;
  }

  function gateSection() {
    const error = ui.data?.errors?.record;
    if (error) return `<section class="bot-artifact-section"><h4>发布门禁</h4><p class="bot-artifact-error">读取失败：${escapeHtml(error)}</p></section>`;
    const record = ui.data?.record;
    if (!record) return `<section class="bot-artifact-section"><h4>发布门禁</h4><p class="bot-artifact-empty">暂无记录</p></section>`;
    const tone = record.verdict === "ready" ? "is-passed" : record.verdict === "blocked" ? "is-failed" : "is-muted";
    const unfinished = Array.isArray(record.unfinished) ? record.unfinished.slice(0, 2) : [];
    return `<section class="bot-artifact-section"><h4>发布门禁 <span class="bot-artifact-verdict ${tone}">${escapeHtml(String(record.verdict || "?"))}</span></h4>
      ${unfinished.map((item) => `<div class="bot-artifact-row"><span class="bot-artifact-meta">${escapeHtml(String(item.status || ""))}</span>
        <span class="bot-artifact-copy">${escapeHtml(String(item.reason || item.id || ""))}</span></div>`).join("")}
      ${record.nextAction ? `<p class="bot-artifact-next">${escapeHtml(String(record.nextAction))}</p>` : ""}</section>`;
  }

  function reportSection() {
    const rows = [
      { id: "weekly", label: "周报（近 7 天）", icon: "gauge", hint: "handoff · DELTA · run 聚合" },
    ];
    return `<section class="bot-artifact-section"><h4>报表 <span>点击生成预览</span></h4>
      ${rows.map((row) => `<button class="bot-artifact-row is-clickable${ui.activeReport === row.id ? " is-active" : ""}" type="button" data-artifact-report="${row.id}">
        ${lucide(row.icon)}<span class="bot-artifact-copy">${escapeHtml(row.label)}</span>
        <span class="bot-artifact-meta">${escapeHtml(row.hint)}</span>
      </button>`).join("")}</section>`;
  }

  function bodyMarkup() {
    if (!ui.expanded) return "";
    if (!ui.data) {
      return `<div class="bot-artifact-body"><p class="bot-artifact-empty">${ui.loading ? "读取三源中…" : "未加载数据"}</p></div>`;
    }
    let preview;
    if (ui.activeReport) {
      preview = ui.reportError
        ? `<p class="bot-artifact-error">报表生成失败：${escapeHtml(ui.reportError)}</p>`
        : `<h4>周报（近 7 天）</h4><pre class="bot-artifact-preview">${escapeHtml(String(ui.reportContent || "生成中…"))}</pre>`;
    } else if (ui.activeHandoff) {
      preview = ui.handoffError
        ? `<p class="bot-artifact-error">预览失败：${escapeHtml(ui.handoffError)}</p>`
        : `<h4>${escapeHtml(ui.activeHandoff)}</h4><pre class="bot-artifact-preview">${escapeHtml(String(ui.handoffContent || "").slice(0, HANDOFF_PREVIEW_CHARS))}${String(ui.handoffContent || "").length > HANDOFF_PREVIEW_CHARS ? "\n…" : ""}</pre>`;
    } else {
      preview = '<p class="bot-artifact-empty">从左侧选择 handoff 预览内容</p>';
    }
    return `<div class="bot-artifact-body">
      <div class="bot-artifact-list">${deltaSection()}${handoffSection()}${gateSection()}${reportSection()}</div>
      <div class="bot-artifact-detail" aria-live="polite">${preview}</div>
    </div>`;
  }

  function render() {
    if (!root) return;
    root.innerHTML = `<article class="bot-card bot-artifact-card is-dynamic" data-bot-card="artifacts" aria-label="证据产物">${headerMarkup()}${bodyMarkup()}</article>`;
  }

  async function loadAll({ force = false } = {}) {
    if (ui.loading) return;
    if (ui.data && !force) return;
    ui.loading = true;
    render();
    const errors = {};
    const [delta, handoffs, record] = await Promise.all([
      request(DELTA_PATH).catch((error) => { errors.delta = error.message || "unknown"; return null; }),
      request(HANDOFFS_PATH).catch((error) => { errors.handoffs = error.message || "unknown"; return null; }),
      request(RECORD_PATH).catch((error) => { errors.record = error.message || "unknown"; return null; }),
    ]);
    ui.loading = false;
    ui.data = {
      delta: delta && typeof delta === "object" ? delta : null,
      handoffs: handoffs && Array.isArray(handoffs.handoffs) ? handoffs.handoffs : null,
      record: record && typeof record === "object" && record.verdict ? record : null,
      errors,
    };
    render();
  }

  async function loadHandoff(name) {
    ui.activeHandoff = name;
    ui.handoffContent = null;
    ui.handoffError = null;
    render();
    try {
      const payload = await request(`/api/observability/handoffs/${encodeURIComponent(name)}`);
      ui.handoffContent = payload?.content ?? "";
    } catch (error) {
      ui.handoffError = error.message || "unknown";
    }
    render();
  }

  async function loadReport(kind) {
    if (kind !== "weekly") return;
    ui.activeReport = kind;
    ui.activeHandoff = null;
    ui.reportContent = null;
    ui.reportError = null;
    render();
    try {
      const payload = await request("/api/reports/weekly");
      ui.reportContent = payload?.markdown ?? "";
    } catch (error) {
      ui.reportError = error.message || "unknown";
    }
    render();
  }

  async function toggle() {
    ui.expanded = !ui.expanded;
    render();
    if (ui.expanded) await loadAll();
  }

  function bind() {
    root?.addEventListener("click", (event) => {
      const toggleButton = event.target.closest("[data-artifact-toggle]");
      if (toggleButton) {
        void toggle();
        return;
      }
      const handoffButton = event.target.closest("[data-artifact-handoff]");
      if (handoffButton) {
        ui.activeReport = null;
        void loadHandoff(handoffButton.dataset.artifactHandoff);
        return;
      }
      const reportButton = event.target.closest("[data-artifact-report]");
      if (reportButton) void loadReport(reportButton.dataset.artifactReport);
    });
  }

  function mount(el) {
    if (!el) return;
    root = el;
    render();
    bind();
    if (ui.expanded) {
      if (ui.data) render();
      else void loadAll();
    }
  }

  function dispose() {
    root = null;
  }

  return Object.freeze({ markup: headerMarkup, mount, dispose, isExpanded: () => ui.expanded });
}
