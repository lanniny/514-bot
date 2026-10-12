/**
 * sessions-hub.js — 跨 CLI 历史会话聚合中心（v4.1 深度增强版）
 *
 * 核心设计目标：
 * 1. 摆脱纯只读静态表格的死板与低效，升级为现代 Forge 卡片化工作流中心。
 * 2. 交互式多轮对话抽屉预览（对接 GET /api/sessions/preview），原生呈现 User / Assistant 气泡。
 * 3. 514 Bot 跨端接续（"导入到 514 Bot 继续"）：自动提炼会话关键上下文，注入 Bot Composer 并一键切换工作台。
 * 4. 实时搜索与源筛选（All / Claude / Codex / Cursor / Kimi / Pi / Grok 等），毫秒级响应。
 * 5. 本地安全资源定位（对接 POST /api/sessions/reveal）与一键复制。
 * 6. 严密契约：完全遵循 Forge 设计系统、暗黑/明亮自适应及壁纸全沉浸透视。
 */

import { escapeHtml, escapeAttr, formatDate, formatRelative } from "../utils.js";
import { API } from "../api.js";
import { emptyState, skeleton } from "./placeholders.js";

const SOURCE_META = {
  claude: {
    label: "Claude Code",
    badgeClass: "badge-claude",
    iconSymbol: "icon-cli-claude",
    isCliLogo: true,
    color: "oklch(0.68 0.18 45)",
  },
  codex: {
    label: "Codex CLI",
    badgeClass: "badge-codex",
    iconSymbol: "icon-cli-codex",
    isCliLogo: true,
    color: "oklch(0.65 0.16 160)",
  },
  cursor: {
    label: "Cursor",
    badgeClass: "badge-cursor",
    iconSymbol: "lucide-terminal",
    isCliLogo: false,
    color: "oklch(0.62 0.17 265)",
  },
  kimi: {
    label: "Kimi Code",
    badgeClass: "badge-kimi",
    iconSymbol: "icon-cli-kimi",
    isCliLogo: true,
    color: "oklch(0.66 0.19 210)",
  },
  pi: {
    label: "Inflection Pi",
    badgeClass: "badge-pi",
    iconSymbol: "icon-cli-pi",
    isCliLogo: true,
    color: "oklch(0.70 0.15 80)",
  },
  grok: {
    label: "Grok Build",
    badgeClass: "badge-grok",
    iconSymbol: "icon-cli-grok",
    isCliLogo: true,
    color: "oklch(0.64 0.18 320)",
  },
  bridge: {
    label: "对话桥 (Roster)",
    badgeClass: "badge-bridge",
    iconSymbol: "lucide-git-merge",
    isCliLogo: false,
    color: "oklch(0.60 0.14 180)",
  },
};

function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function compactId(id) {
  const str = String(id ?? "").trim();
  if (!str) return "--";
  if (str.length <= 26) return str;
  return `${str.slice(0, 14)}…${str.slice(-8)}`;
}

export function createSessionsHubPage({
  state,
  elements,
  request,
  toast,
  switchView,
  byId,
}) {
  let activeSource = "all";
  let searchQuery = "";
  let previewSession = null;
  let previewLoading = false;
  let previewData = null;
  let previewError = null;
  const previewCache = new Map();

  function getContainer() {
    return elements["sessions-groups"] || byId("sessions-groups");
  }

  function getSourceConfig(sourceKey) {
    return (
      SOURCE_META[sourceKey] || {
        label: sourceKey || "其他",
        badgeClass: "badge-generic",
        iconSymbol: "lucide-bot",
        isCliLogo: false,
        color: "var(--primary)",
      }
    );
  }

  function renderIcon(config) {
    if (config.isCliLogo) {
      return `<svg class="icon cli-logo" aria-hidden="true"><use href="#${config.iconSymbol}"></use></svg>`;
    }
    return `<svg class="icon lucide" aria-hidden="true"><use href="#${config.iconSymbol}"></use></svg>`;
  }

  function buildRelayPrompt(session, messages = []) {
    const meta = getSourceConfig(session.source);
    const timeStr = session.modifiedAt ? formatDate(session.modifiedAt) : "--";
    const header = [
      `【接续来自 ${meta.label} 的会话上下文】`,
      `· 来源工具: ${meta.label}`,
      `· 关联范围: ${session.scope || session.project || "全局 / 默认"}`,
      `· 会话标识: ${session.id}`,
      `· 更新时间: ${timeStr}`,
    ].join("\n");

    let contextSection = "";
    if (Array.isArray(messages) && messages.length > 0) {
      // 选取最近的最多 6 条消息
      const recent = messages.slice(-6);
      contextSection = recent
        .map((m) => {
          const roleLabel = m.role === "user" ? "用户" : meta.label;
          return `[${roleLabel}]:\n${m.text}`;
        })
        .join("\n\n");
    } else if (session.summary) {
      contextSection = `[历史首轮摘要]:\n${session.summary}`;
    } else {
      contextSection = `[说明]: 尚未加载具体消息记录，请在本地通过会话标识排查。`;
    }

    return `${header}\n\n【最近会话记录】\n${contextSection}\n\n---\n请基于上述历史会话的背景与上下文，接续协助我推进接下来的工作。`;
  }

  async function continueInBot(session, explicitMessages = null) {
    let messages = explicitMessages;
    if (!messages) {
      const cacheKey = `${session.source}:${session.project || session.scope}:${session.id}`;
      if (previewCache.has(cacheKey)) {
        messages = previewCache.get(cacheKey).messages;
      } else {
        try {
          const params = new URLSearchParams({
            source: session.source,
            id: session.id,
            project: session.project || session.scope || "",
            scope: session.scope || "",
          });
          const res = await request(`${API.sessions}/preview?${params.toString()}`);
          if (res?.messages) {
            messages = res.messages;
            previewCache.set(cacheKey, res);
          }
        } catch {
          // 优雅降级到 summary
        }
      }
    }

    const promptText = buildRelayPrompt(session, messages);

    if (typeof switchView === "function") {
      switchView("bot", { focus: true });
    }

    setTimeout(() => {
      const composer = byId("bot-composer-input") || byId("task-input");
      if (composer) {
        composer.removeAttribute("disabled");
        composer.disabled = false;
        composer.value = promptText;
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        composer.dispatchEvent(new Event("change", { bubbles: true }));
        composer.style.height = "auto";
        composer.style.height = `${Math.min(composer.scrollHeight, 260)}px`;
        composer.focus();
      }
      toast("已将会话上下文导入到 514 Bot，可直接编辑与发送", "success");
    }, 100);

    closePreviewDrawer();
  }

  async function revealFile(session) {
    try {
      const payload = {
        source: session.source ?? "claude",
        project: session.project ?? session.scope ?? "",
        scope: session.scope ?? "",
        id: session.id,
      };
      await request(`${API.sessions}/reveal`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast("已在系统资源管理器中定位会话文件", "success");
    } catch (err) {
      toast(`定位文件失败: ${err.message}`, "error");
    }
  }

  async function copyContext(session) {
    const cacheKey = `${session.source}:${session.project || session.scope}:${session.id}`;
    const cached = previewCache.get(cacheKey);
    const text = buildRelayPrompt(session, cached?.messages);
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制会话上下文到剪贴板", "success");
    } catch {
      toast("复制失败，请手动选取", "warning");
    }
  }

  async function openPreview(session) {
    previewSession = session;
    previewLoading = true;
    previewError = null;
    previewData = null;
    render();

    const cacheKey = `${session.source}:${session.project || session.scope}:${session.id}`;
    if (previewCache.has(cacheKey)) {
      previewData = previewCache.get(cacheKey);
      previewLoading = false;
      render();
      return;
    }

    try {
      const params = new URLSearchParams({
        source: session.source,
        id: session.id,
        project: session.project || session.scope || "",
        scope: session.scope || "",
      });
      const res = await request(`${API.sessions}/preview?${params.toString()}`);
      previewData = res;
      previewCache.set(cacheKey, res);
    } catch (err) {
      previewError = err.message || "加载预览失败";
    } finally {
      previewLoading = false;
      render();
    }
  }

  function closePreviewDrawer() {
    if (previewSession) {
      previewSession = null;
      previewLoading = false;
      previewError = null;
      render();
    }
  }

  function render() {
    const container = getContainer();
    if (!container) return;

    const data = state.sessionsData;
    if (!data) {
      container.innerHTML = state.sessionsError
        ? `<section class="content-section">${emptyState({
            tone: "error",
            title: "会话扫描失败",
            desc: `${state.sessionsError} — 请检查本地 CLI 历史目录或稍后重试`,
            action: { label: "重新扫描", actionId: "refresh-sessions", icon: "refresh-cw" },
          })}</section>`
        : `<section class="content-section">${skeleton({ variant: "card", rows: 4, label: "正在扫描本地历史会话…" })}</section>`;
      return;
    }

    // 统计各源及展平会话
    const sources = Array.isArray(data.sources) ? data.sources : [];
    let allSessions = [];
    let totalCount = 0;
    let availableSourcesCount = 0;
    let totalBytes = 0;
    let latestTimestamp = null;

    for (const group of sources) {
      if (group.available) availableSourcesCount += 1;
      const groupCount = Number(group.sessionCount) || (group.sessions?.length ?? 0);
      totalCount += groupCount;

      for (const item of group.sessions || []) {
        const fullItem = {
          ...item,
          source: group.source,
          sourceLabel: group.label,
        };
        allSessions.push(fullItem);

        if (item.size && Number.isFinite(item.size)) {
          totalBytes += item.size;
        }
        if (item.modifiedAt) {
          const itemTime = new Date(item.modifiedAt).getTime();
          if (!latestTimestamp || itemTime > latestTimestamp) {
            latestTimestamp = itemTime;
          }
        }
      }
    }

    // 筛选
    let filtered = allSessions;
    if (activeSource !== "all") {
      filtered = filtered.filter((s) => s.source === activeSource);
    }
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter((s) => {
        const matchId = String(s.id ?? "").toLowerCase().includes(query);
        const matchScope = String(s.scope ?? "").toLowerCase().includes(query);
        const matchSummary = String(s.summary ?? "").toLowerCase().includes(query);
        const matchSource = String(s.sourceLabel ?? "").toLowerCase().includes(query);
        return matchId || matchScope || matchSummary || matchSource;
      });
    }

    // 按修改时间降序排
    filtered.sort((a, b) => {
      const timeA = a.modifiedAt ? new Date(a.modifiedAt).getTime() : 0;
      const timeB = b.modifiedAt ? new Date(b.modifiedAt).getTime() : 0;
      return timeB - timeA;
    });

    // 1. 顶部指标栏
    const metricsHtml = `
      <div class="sessions-hub-metrics" aria-label="会话聚合核心指标">
        <article class="sessions-metric-card">
          <div class="sessions-metric-icon"><svg class="icon lucide" aria-hidden="true"><use href="#lucide-messages-square"></use></svg></div>
          <div class="sessions-metric-content">
            <span class="sessions-metric-label">聚合会话总数</span>
            <strong class="sessions-metric-value">${totalCount}</strong>
            <span class="sessions-metric-sub">当前载入 ${allSessions.length} 个快照</span>
          </div>
        </article>
        <article class="sessions-metric-card">
          <div class="sessions-metric-icon"><svg class="icon lucide" aria-hidden="true"><use href="#lucide-terminal"></use></svg></div>
          <div class="sessions-metric-content">
            <span class="sessions-metric-label">已接入 CLI 工具</span>
            <strong class="sessions-metric-value">${availableSourcesCount} <span class="sessions-metric-unit">/ ${sources.length}</span></strong>
            <span class="sessions-metric-sub">Claude · Codex · Cursor · Kimi 等</span>
          </div>
        </article>
        <article class="sessions-metric-card">
          <div class="sessions-metric-icon"><svg class="icon lucide" aria-hidden="true"><use href="#lucide-clock"></use></svg></div>
          <div class="sessions-metric-content">
            <span class="sessions-metric-label">最近活跃更新</span>
            <strong class="sessions-metric-value" title="${latestTimestamp ? formatDate(latestTimestamp) : "--"}">${latestTimestamp ? formatRelative(latestTimestamp) : "无记录"}</strong>
            <span class="sessions-metric-sub">${latestTimestamp ? formatDate(latestTimestamp) : "尚未扫描到活动"}</span>
          </div>
        </article>
        <article class="sessions-metric-card">
          <div class="sessions-metric-icon"><svg class="icon lucide" aria-hidden="true"><use href="#lucide-folder"></use></svg></div>
          <div class="sessions-metric-content">
            <span class="sessions-metric-label">历史文件体量</span>
            <strong class="sessions-metric-value">${formatBytes(totalBytes) || "0 B"}</strong>
            <span class="sessions-metric-sub">本地磁盘 JSONL 记录集</span>
          </div>
        </article>
      </div>
    `;

    // 2. 交互式工具栏（搜索 + 筛选胶囊）
    const sourcePillsHtml = [
      `<button type="button" class="sessions-pill ${activeSource === "all" ? "is-active" : ""}" data-filter-source="all">
        <span class="sessions-pill-title">全部来源</span>
        <span class="sessions-pill-count">${allSessions.length}</span>
      </button>`,
      ...sources.map((s) => {
        const meta = getSourceConfig(s.source);
        const count = s.sessions?.length ?? 0;
        const isSelected = activeSource === s.source;
        return `
          <button type="button" class="sessions-pill ${isSelected ? "is-active" : ""} ${!s.available ? "is-unavailable" : ""}" data-filter-source="${escapeAttr(s.source)}" title="${s.available ? meta.label : `${meta.label} (未接入)`}">
            ${renderIcon(meta)}
            <span class="sessions-pill-title">${escapeHtml(meta.label)}</span>
            <span class="sessions-pill-count">${count}</span>
          </button>
        `;
      }),
    ].join("");

    const toolbarHtml = `
      <div class="sessions-hub-toolbar">
        <div class="sessions-search-wrap">
          <svg class="icon lucide sessions-search-icon" aria-hidden="true"><use href="#lucide-search"></use></svg>
          <input type="search" id="sessions-search-input" class="sessions-search-input" placeholder="搜索范围、项目路径、会话 ID 或任务指令关键字…" value="${escapeAttr(searchQuery)}" autocomplete="off" />
          ${searchQuery ? `<button type="button" class="sessions-search-clear" id="sessions-search-clear" title="清空搜索" aria-label="清空搜索"><svg class="icon lucide" aria-hidden="true"><use href="#lucide-x"></use></svg></button>` : ""}
        </div>
        <div class="sessions-pills-row" role="radiogroup" aria-label="CLI 来源筛选">
          ${sourcePillsHtml}
        </div>
      </div>
    `;

    // 3. 会话卡片网格
    let contentHtml = "";
    if (filtered.length === 0) {
      if (allSessions.length === 0) {
        contentHtml = emptyState({
          tone: "first-run",
          title: "暂无检测到的本地会话",
          desc: "当前系统环境中尚未扫描到 Claude Code、Codex、Cursor、Kimi 等 CLI 工具的历史对话文件。",
          action: { label: "重新扫描", actionId: "refresh-sessions", icon: "refresh-cw" },
        });
      } else {
        contentHtml = emptyState({
          tone: "no-result",
          title: "未找到匹配会话",
          desc: `没有找到符合「${escapeHtml(searchQuery || activeSource)}」筛选条件的本地会话记录。`,
          action: { label: "清除筛选", actionId: "clear-filters", icon: "refresh-cw" },
        });
      }
    } else {
      const cards = filtered.map((session) => {
        const meta = getSourceConfig(session.source);
        const relTime = session.modifiedAt ? formatRelative(session.modifiedAt) : "--";
        const fullTime = session.modifiedAt ? formatDate(session.modifiedAt) : "--";
        const sizeBadge = session.size ? formatBytes(session.size) : "";
        const summaryText = session.summary
          ? `<p class="session-card-summary">${escapeHtml(session.summary)}</p>`
          : `<p class="session-card-summary is-empty">（暂未生成摘要片段，可展开查看详细消息记录）</p>`;

        return `
          <article class="session-card" data-session-id="${escapeAttr(session.id)}" data-session-source="${escapeAttr(session.source)}">
            <header class="session-card-head">
              <span class="session-source-badge ${meta.badgeClass}">
                ${renderIcon(meta)}
                <span class="session-source-name">${escapeHtml(meta.label)}</span>
              </span>
              <time class="session-time" title="${escapeAttr(fullTime)}" datetime="${escapeAttr(session.modifiedAt ?? "")}">
                <svg class="icon lucide" aria-hidden="true"><use href="#lucide-clock"></use></svg>
                <span>${escapeHtml(relTime)}</span>
              </time>
            </header>

            <div class="session-card-body">
              <div class="session-card-scope" title="${escapeAttr(session.scope ?? session.project ?? "")}">
                <svg class="icon lucide" aria-hidden="true"><use href="#lucide-folder"></use></svg>
                <span class="mono">${escapeHtml(session.scope ?? session.project ?? "全局 / 未绑定")}</span>
              </div>
              <div class="session-card-id mono" title="${escapeAttr(session.id)}">
                <span class="session-id-label">ID:</span>
                <span class="session-id-val">${escapeHtml(compactId(session.id))}</span>
              </div>
              ${summaryText}
            </div>

            <footer class="session-card-foot">
              <span class="session-card-size">${escapeHtml(sizeBadge)}</span>
              <div class="session-card-actions">
                <button type="button" class="button secondary compact-btn session-action-btn" data-action="preview" title="查看对话消息详情">
                  <svg class="icon lucide" aria-hidden="true"><use href="#lucide-book-open"></use></svg>
                  <span>浏览记录</span>
                </button>
                <button type="button" class="button primary compact-btn session-action-btn session-relay-btn" data-action="relay" title="将此会话上下文带入 514 Bot 继续探讨">
                  <svg class="icon lucide" aria-hidden="true"><use href="#lucide-sparkles"></use></svg>
                  <span>导入 Bot</span>
                </button>
                <button type="button" class="icon-button compact-btn" data-action="reveal" title="在系统资源管理器中定位此文件" aria-label="在资源管理器中定位">
                  <svg class="icon lucide" aria-hidden="true"><use href="#lucide-folder-open"></use></svg>
                </button>
                <button type="button" class="icon-button compact-btn" data-action="copy" title="复制此会话引用与上下文" aria-label="复制上下文">
                  <svg class="icon lucide" aria-hidden="true"><use href="#lucide-copy"></use></svg>
                </button>
              </div>
            </footer>
          </article>
        `;
      });
      contentHtml = `<div class="sessions-cards-grid">${cards.join("")}</div>`;
    }

    // 4. 预览抽屉 (Slide-over Drawer)
    let drawerHtml = "";
    if (previewSession) {
      const meta = getSourceConfig(previewSession.source);
      const isDrawerOpen = Boolean(previewSession);

      let drawerBodyContent = "";
      if (previewLoading) {
        drawerBodyContent = `
          <div class="sessions-drawer-loading">
            <svg class="icon lucide spin" aria-hidden="true"><use href="#lucide-refresh-cw"></use></svg>
            <p>正在读取与脱敏历史会话记录…</p>
          </div>
        `;
      } else if (previewError) {
        drawerBodyContent = `
          <div class="sessions-drawer-error">
            <svg class="icon lucide" aria-hidden="true"><use href="#lucide-circle-alert"></use></svg>
            <p>读取会话详情失败：${escapeHtml(previewError)}</p>
            <button type="button" class="button secondary" data-action="retry-preview">重试读取</button>
          </div>
        `;
      } else if (previewData) {
        const messages = Array.isArray(previewData.messages) ? previewData.messages : [];
        if (messages.length === 0) {
          drawerBodyContent = `
            <div class="sessions-drawer-empty">
              <svg class="icon lucide" aria-hidden="true"><use href="#lucide-messages-square"></use></svg>
              <p>此会话中没有文本消息或包含仅有元事件/工具调用记录。</p>
            </div>
          `;
        } else {
          const bubbles = messages.map((m) => {
            const isUser = m.role === "user";
            const roleName = isUser ? "用户" : meta.label;
            const timeFormatted = m.timestamp ? formatDate(m.timestamp) : "";
            return `
              <div class="session-bubble ${isUser ? "is-user" : "is-assistant"}">
                <div class="session-bubble-meta">
                  <strong class="session-bubble-author">${escapeHtml(roleName)}</strong>
                  ${timeFormatted ? `<span class="session-bubble-time">${escapeHtml(timeFormatted)}</span>` : ""}
                </div>
                <div class="session-bubble-content">${escapeHtml(m.text)}</div>
              </div>
            `;
          });

          const notice = previewData.truncated
            ? `<div class="sessions-drawer-notice"><svg class="icon lucide" aria-hidden="true"><use href="#lucide-circle-alert"></use></svg> 会话记录较长，已截取最新轮次以保障性能。</div>`
            : "";

          drawerBodyContent = `${notice}<div class="sessions-bubbles-list">${bubbles.join("")}</div>`;
        }
      }

      drawerHtml = `
        <div class="sessions-drawer-backdrop" data-action="close-drawer"></div>
        <aside class="sessions-drawer" role="dialog" aria-modal="true" aria-labelledby="sessions-drawer-title">
          <header class="sessions-drawer-head">
            <div class="sessions-drawer-title-wrap">
              <span class="session-source-badge ${meta.badgeClass}">
                ${renderIcon(meta)}
                <span>${escapeHtml(meta.label)}</span>
              </span>
              <h2 id="sessions-drawer-title" class="sessions-drawer-title mono">${escapeHtml(compactId(previewSession.id))}</h2>
              <p class="sessions-drawer-scope" title="${escapeAttr(previewSession.scope ?? previewSession.project ?? "")}">
                <svg class="icon lucide" aria-hidden="true"><use href="#lucide-folder"></use></svg>
                <span>${escapeHtml(previewSession.scope ?? previewSession.project ?? "默认")}</span>
              </p>
            </div>
            <button type="button" class="icon-button sessions-drawer-close" data-action="close-drawer" title="关闭预览 (ESC)" aria-label="关闭预览">
              <svg class="icon lucide" aria-hidden="true"><use href="#lucide-x"></use></svg>
            </button>
          </header>

          <div class="sessions-drawer-body">
            ${drawerBodyContent}
          </div>

          <footer class="sessions-drawer-foot">
            <button type="button" class="button primary session-relay-btn" data-action="drawer-relay">
              <svg class="icon lucide" aria-hidden="true"><use href="#lucide-sparkles"></use></svg>
              <span>导入到 514 Bot 接续</span>
            </button>
            <button type="button" class="button secondary" data-action="drawer-reveal">
              <svg class="icon lucide" aria-hidden="true"><use href="#lucide-folder-open"></use></svg>
              <span>定位文件</span>
            </button>
            <button type="button" class="button secondary" data-action="drawer-copy">
              <svg class="icon lucide" aria-hidden="true"><use href="#lucide-copy"></use></svg>
              <span>复制上下文</span>
            </button>
          </footer>
        </aside>
      `;
    }

    container.innerHTML = `
      <div class="sessions-hub-root">
        ${metricsHtml}
        ${toolbarHtml}
        <div class="sessions-content-container">
          ${contentHtml}
        </div>
        ${drawerHtml}
      </div>
    `;

    bindEvents(container, filtered);
  }

  function bindEvents(container, filteredSessions) {
    // 搜索输入
    const searchInput = container.querySelector("#sessions-search-input");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        searchQuery = e.target.value;
        render();
        const nextInput = getContainer()?.querySelector("#sessions-search-input");
        if (nextInput) {
          nextInput.focus();
          const len = nextInput.value.length;
          nextInput.setSelectionRange(len, len);
        }
      });
    }

    // 清空搜索
    const searchClear = container.querySelector("#sessions-search-clear");
    if (searchClear) {
      searchClear.addEventListener("click", () => {
        searchQuery = "";
        render();
      });
    }

    // 来源胶囊点击
    const pills = container.querySelectorAll("[data-filter-source]");
    for (const pill of pills) {
      pill.addEventListener("click", () => {
        activeSource = pill.getAttribute("data-filter-source") || "all";
        render();
      });
    }

    // 统一点击事件委托
    container.onclick = (e) => {
      const target = e.target.closest("[data-action], [data-empty-action]");
      if (!target) return;

      const action = target.getAttribute("data-action") || target.getAttribute("data-empty-action");

      if (action === "refresh-sessions") {
        const refreshBtn = elements["sessions-refresh-button"] || byId("sessions-refresh-button");
        refreshBtn?.click();
        return;
      }

      if (action === "clear-filters") {
        activeSource = "all";
        searchQuery = "";
        render();
        return;
      }

      if (action === "close-drawer") {
        closePreviewDrawer();
        return;
      }

      if (action === "retry-preview") {
        if (previewSession) openPreview(previewSession);
        return;
      }

      if (action === "drawer-relay") {
        if (previewSession) continueInBot(previewSession, previewData?.messages);
        return;
      }

      if (action === "drawer-reveal") {
        if (previewSession) revealFile(previewSession);
        return;
      }

      if (action === "drawer-copy") {
        if (previewSession) copyContext(previewSession);
        return;
      }

      // 卡片操作
      const card = target.closest(".session-card");
      if (!card) return;
      const sessionId = card.getAttribute("data-session-id");
      const sessionSource = card.getAttribute("data-session-source");
      const session = filteredSessions.find((s) => s.id === sessionId && s.source === sessionSource);
      if (!session) return;

      if (action === "preview") {
        openPreview(session);
      } else if (action === "relay") {
        continueInBot(session);
      } else if (action === "reveal") {
        revealFile(session);
      } else if (action === "copy") {
        copyContext(session);
      }
    };

    // 键盘 ESC 键关闭抽屉
    const onKeydown = (e) => {
      if (e.key === "Escape" && previewSession) {
        closePreviewDrawer();
      }
    };
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", window.__sessionsHubEscHandler);
      window.__sessionsHubEscHandler = onKeydown;
      window.addEventListener("keydown", onKeydown);
    }
  }

  return {
    render,
    openPreview,
    closePreviewDrawer,
    continueInBot,
  };
}
