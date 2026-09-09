/**
 * market-panel.js — 插件设置：仓库扫描 Skill + Registry MCP，审查后写入 live 配置。
 */
import { request, apiReady } from "./api.js";
import { lucideIcon } from "./lucide.js";

const MCP_TARGETS = Object.freeze([
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["gemini", "Gemini"],
  ["grokbuild", "Grok Build"],
  ["kimi", "Kimi Code"],
  ["opencode", "OpenCode"],
  ["openclaw", "OpenClaw"],
  ["hermes", "Hermes"],
  ["claude-desktop", "Claude Desktop"],
]);

const SKILL_TARGETS = MCP_TARGETS.filter(([id]) => id !== "claude-desktop");
const TAB_KEY = "514cc-market-tab";
const TABS = Object.freeze([
  ["installed", "已安装"],
  ["skills", "Skills"],
  ["mcp", "MCP"],
  ["repos", "仓库"],
]);

const state = {
  tab: readSavedTab(),
  query: "",
  composer: "",
  kindFilter: "all",
  openId: "",
  mcp: { query: "", source: "official", items: [], searched: false },
  catalog: [],
  catalogQuery: "",
  repos: [],
  installed: [],
  skills: [],
  review: null,
  message: "",
  addOpen: false,
};

let refreshGeneration = 0;
let mcpSearchGeneration = 0;

function readSavedTab() {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (TABS.some(([id]) => id === saved)) return saved;
  } catch { /* private mode */ }
  return "installed";
}

function persistTab() {
  try { localStorage.setItem(TAB_KEY, state.tab); } catch { /* ignore */ }
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function appBoxes(prefix, selected = { claude: true, codex: true }, targets = MCP_TARGETS) {
  return `<div class="market-app-grid">${targets.map(([id, label]) => `
    <label class="market-app-pill ccs-check is-app-${esc(id)}${selected[id] ? " is-checked" : ""}">
      <input type="checkbox" data-${prefix}-app="${esc(id)}"${selected[id] ? " checked" : ""} />
      <span class="market-app-pill-dot" aria-hidden="true"></span>
      <span class="market-app-pill-label">${esc(label)}</span>
    </label>`).join("")}</div>`;
}

function readApps(root, prefix, targets = MCP_TARGETS) {
  const apps = {};
  for (const [id] of targets) {
    apps[id] = Boolean(root.querySelector(`[data-${prefix}-app="${id}"]`)?.checked);
  }
  return apps;
}

function installedMcp() {
  return state.installed.filter((item) => item.kind === "mcp");
}

function ledgerSkill(name) {
  return state.installed.find((item) => item.kind === "skill" && item.id === name);
}

function counts() {
  return {
    installed: state.skills.length + installedMcp().length,
    skills: state.catalog.length,
    mcp: state.mcp.searched ? state.mcp.items.length : installedMcp().length,
    repos: state.repos.length,
  };
}

function currentQuery() {
  if (state.tab === "mcp") return state.mcp.query;
  if (state.tab === "skills") return state.catalogQuery;
  return state.query;
}

function matchesQuery(parts) {
  const q = currentQuery().trim().toLowerCase();
  if (!q) return true;
  return parts.some((part) => String(part || "").toLowerCase().includes(q));
}

function iconFor(kind) {
  if (kind === "mcp") return "plug-zap";
  if (kind === "repo") return "folder-git-2";
  return "wand-sparkles";
}

function rowKey(kind, id) {
  return `${kind}:${id}`;
}

function appBadges(apps) {
  const on = MCP_TARGETS.filter(([id]) => apps?.[id]);
  const short = (label) => label.replace(" Code", "").replace(" Desktop", "").replace(" Build", "");
  const shown = on.slice(0, 3).map(([id, label]) => ({ id, text: short(label), on: true }));
  if (on.length > 3) shown.push({ id: "more", text: `+${on.length - 3}`, on: false });
  return shown;
}

function formatWhen(value) {
  if (!value) return "";
  const text = String(value);
  return text.length >= 16 ? text.slice(0, 16).replace("T", " ") : text;
}

function hashHint(value) {
  const hash = String(value || "");
  return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

async function refresh(root) {
  const generation = ++refreshGeneration;
  const catalogQuery = state.catalogQuery;
  try {
    const [skills, installed, repos, catalog] = await Promise.all([
      request("/api/market/skills"),
      request("/api/market/installed"),
      request("/api/market/repos"),
      request(`/api/market/catalog?q=${encodeURIComponent(catalogQuery)}`),
    ]);
    if (generation !== refreshGeneration) return;
    state.skills = skills?.skills ?? [];
    state.installed = installed?.items ?? [];
    state.repos = repos?.repos ?? [];
    state.catalog = catalog?.skills ?? [];
  } catch (error) {
    if (generation !== refreshGeneration) return;
    if (/REMOTE_GATE/.test(error.message || "")) {
      root.innerHTML = `
        <div class="forge-empty-waveg">
          ${lucideIcon("lock", "icon lucide icon-lg")}
          <h2>插件门闸未开放</h2>
          <p class="subtle">${esc(error.message)}</p>
          <button type="button" class="button" id="market-retry">${lucideIcon("rotate-ccw", "icon lucide")} 授权后重试</button>
        </div>`;
      root.querySelector("#market-retry")?.addEventListener("click", () => void refresh(root));
      return;
    }
    state.message = error.message;
  }
  render(root);
}

function tabButton(id, label, count) {
  return `<button type="button" class="market-tab${state.tab === id ? " is-active" : ""}" role="tab" aria-selected="${state.tab === id}" data-market-tab="${id}">${label} <em>${count}</em></button>`;
}

function render(root) {
  const tally = counts();
  const searchPh = state.tab === "mcp" ? "搜索 filesystem / github / sqlite…" : state.tab === "skills" ? "搜索技能或仓库…" : state.tab === "repos" ? "筛选仓库…" : "搜索已安装…";
  root.innerHTML = `
    <section class="settings-card market-shell" aria-labelledby="market-panel-title">
      <header class="settings-card-head market-shell-head">
        <div>
          <h2 id="market-panel-title">插件</h2>
          <p>管理已安装的 Skill 与 MCP。Skills 来自 GitHub 仓库扫描，MCP 来自官方 Registry / Smithery；确认后写入项目与 CLI live 配置。</p>
        </div>
        <div class="market-head-actions">
          <button type="button" class="button secondary compact market-bridge-btn" data-config-surface-jump="capabilities" data-cap-workspace="skills" title="前往项目成员 Skill 声明矩阵">${lucideIcon("shield-check", "icon lucide")} 成员授权矩阵</button>
          <button type="button" class="button secondary" data-market-tab="repos">${lucideIcon("folder-git-2", "icon lucide")} 仓库</button>
          <div class="market-add">
            <button type="button" class="button primary" id="market-add-toggle" aria-expanded="${state.addOpen}">${lucideIcon("plus", "icon lucide")} 添加</button>
            ${state.addOpen ? `
              <div class="market-add-menu" role="menu">
                <button type="button" role="menuitem" data-market-composer="repo">添加技能仓库</button>
                <button type="button" role="menuitem" data-market-composer="zip">从 ZIP 安装 Skill</button>
                <button type="button" role="menuitem" data-market-composer="mcp">搜索 MCP</button>
              </div>` : ""}
          </div>
        </div>
      </header>
      <div class="market-toolbar">
        <div class="market-tabs" role="tablist" aria-label="插件分类">
          ${TABS.map(([id, label]) => tabButton(id, label, tally[id])).join("")}
        </div>
        <label class="market-search">
          <span class="sr-only">搜索</span>
          ${lucideIcon("search", "icon lucide")}
          <input class="input" id="market-query" type="search" value="${esc(currentQuery())}" placeholder="${searchPh}" />
        </label>
      </div>
      ${renderExtraBar()}
      ${state.message ? `<p class="market-banner" role="status">${esc(state.message)}</p>` : ""}
      <div id="market-review"></div>
      ${renderComposer()}
      <div id="market-pane">${renderPane()}</div>
    </section>`;

  root.querySelectorAll("[data-market-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tab = button.dataset.marketTab;
      state.message = "";
      state.addOpen = false;
      persistTab();
      render(root);
    });
  });
  root.querySelector("#market-add-toggle")?.addEventListener("click", (event) => {
    event.stopPropagation();
    state.addOpen = !state.addOpen;
    render(root);
  });
  root.querySelectorAll("[data-market-composer]").forEach((button) => {
    button.addEventListener("click", () => {
      state.composer = button.dataset.marketComposer;
      state.addOpen = false;
      if (state.composer === "mcp") state.tab = "mcp";
      if (state.composer === "repo") state.tab = "repos";
      if (state.composer === "zip") state.tab = "skills";
      persistTab();
      render(root);
    });
  });
  root.querySelectorAll("[data-kind-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.kindFilter = button.dataset.kindFilter;
      paintPane(root);
      root.querySelectorAll("[data-kind-filter]").forEach((item) => {
        item.classList.toggle("is-active", item.dataset.kindFilter === state.kindFilter);
      });
    });
  });
  const queryInput = root.querySelector("#market-query");
  queryInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const value = event.target.value.trim();
    if (state.tab === "mcp") {
      state.mcp.query = value;
      void mcpSearch(root);
      return;
    }
    if (state.tab === "skills") {
      state.catalogQuery = value;
      void refresh(root);
      return;
    }
    state.query = value;
    paintPane(root);
  });
  queryInput?.addEventListener("input", (event) => {
    const value = event.target.value;
    if (state.tab === "mcp") {
      state.mcp.query = value;
      if (state.mcp.searched) paintPane(root);
      return;
    }
    if (state.tab === "skills") state.catalogQuery = value;
    else state.query = value;
    paintPane(root);
  });
  bindComposer(root);
  bindPane(root);
  if (state.review) renderReview(root);
}

function renderExtraBar() {
  if (state.tab === "installed") {
    return `
      <div class="market-extra">
        <div class="market-kind-filters" role="group" aria-label="已安装类型">
          <button type="button" class="market-chip${state.kindFilter === "all" ? " is-active" : ""}" data-kind-filter="all">全部</button>
          <button type="button" class="market-chip${state.kindFilter === "skill" ? " is-active" : ""}" data-kind-filter="skill">Skills</button>
          <button type="button" class="market-chip${state.kindFilter === "mcp" ? " is-active" : ""}" data-kind-filter="mcp">MCP</button>
        </div>
        <p class="market-extra-note">${state.skills.length} 个 Skill · ${installedMcp().length} 个 MCP。点开一行可改投影到哪些 CLI。</p>
      </div>`;
  }
  if (state.tab === "repos") {
    return `
      <div class="market-extra">
        <button type="button" class="button" id="repos-scan-all">${lucideIcon("refresh-cw", "icon lucide")} 扫描全部仓库</button>
        <p class="market-extra-note">扫描 GitHub 树，找出 SKILL.md。skills.sh 公开 API 需登录，发现面走仓库。</p>
      </div>`;
  }
  return "";
}

function renderComposer() {
  if (state.composer === "repo") {
    return `
      <div class="market-composer">
        <strong>添加技能仓库</strong>
        <p>只接受 GitHub owner/name。添加后扫描才能进 Skills 目录。</p>
        <div class="waveg-form-row">
          <label>仓库 URL<input class="input" id="repo-url" type="text" placeholder="owner/name 或 https://github.com/owner/name" /></label>
          <label>分支<input class="input" id="repo-branch" type="text" value="main" /></label>
        </div>
        <div class="waveg-card-actions">
          <button type="button" class="button primary" id="repo-add">${lucideIcon("plus", "icon lucide")} 添加仓库</button>
          <button type="button" class="button" data-composer-close>取消</button>
        </div>
      </div>`;
  }
  if (state.composer === "zip") {
    return `
      <div class="market-composer">
        <strong>从 ZIP 安装 Skill</strong>
        <p>仅 https，且主机在 allowlist（github.com / codeload）。先审查再写入。</p>
        <div class="waveg-form-row">
          <label>Skill 压缩包 URL<input class="input" id="skill-url" type="text" placeholder="https://github.com/org/repo/archive/refs/heads/main.zip" /></label>
        </div>
        <div class="waveg-card-actions">
          <button type="button" class="button primary" id="skill-stage">${lucideIcon("download-cloud", "icon lucide")} 下载并审查</button>
          <button type="button" class="button" data-composer-close>取消</button>
        </div>
      </div>`;
  }
  if (state.composer === "mcp") {
    return `
      <div class="market-composer">
        <strong>搜索 MCP</strong>
        <p>官方 Registry 或 Smithery。目录没给 command/url 会拒绝安装，不会只写台账。</p>
        <div class="waveg-form-row">
          <label>关键词<input class="input" id="mcp-query" type="text" value="${esc(state.mcp.query)}" placeholder="filesystem / github / sqlite…" /></label>
          <label>来源
            <select class="input" id="mcp-source">
              <option value="official" ${state.mcp.source === "official" ? "selected" : ""}>官方 Registry</option>
              <option value="smithery" ${state.mcp.source === "smithery" ? "selected" : ""}>Smithery</option>
            </select>
          </label>
        </div>
        <div class="waveg-card-actions">
          <button type="button" class="button primary" id="mcp-search">${lucideIcon("search", "icon lucide")} 搜索</button>
          <button type="button" class="button" data-composer-close>取消</button>
        </div>
      </div>`;
  }
  return "";
}

function emptyState(title, detail, actionLabel, action = {}) {
  const attr = action.composer
    ? `data-market-composer="${esc(action.composer)}"`
    : action.tab
      ? `data-market-tab="${esc(action.tab)}"`
      : "";
  return `
    <div class="market-empty">
      <span class="market-empty-icon" aria-hidden="true">${lucideIcon(action.icon || "package", "icon lucide")}</span>
      <strong>${esc(title)}</strong>
      <p>${esc(detail)}</p>
      ${actionLabel && attr ? `<button type="button" class="button primary" ${attr}>${esc(actionLabel)}</button>` : ""}
    </div>`;
}

function row({ kind, id, title, meta, badges = [], actions = "", detail = "" }) {
  const key = rowKey(kind, id);
  const open = state.openId === key;
  return `
    <article class="market-row${open ? " is-open" : ""}" data-kind="${esc(kind)}" data-row-toggle="${esc(key)}">
      <span class="market-row-icon" aria-hidden="true">${lucideIcon(iconFor(kind), "icon lucide")}</span>
      <div class="market-row-copy">
        <div class="market-row-heading">
          <strong>${esc(title)}</strong>
          <span class="market-kind-pill is-kind-${esc(kind)}">${esc(kind.toUpperCase())}</span>
        </div>
        <span class="market-row-desc">${esc(meta)}</span>
      </div>
      <div class="market-row-meta">${badges.map((badge) => `<span class="waveg-badge${badge.on ? " is-on" : ""}${badge.id ? ` is-app-${badge.id}` : ""}">${esc(badge.text)}</span>`).join("")}</div>
      <div class="market-row-actions">${actions}</div>
      <span class="market-row-chevron" aria-hidden="true">${lucideIcon(open ? "chevron-up" : "chevron-down", "icon lucide")}</span>
    </article>
    ${open && detail ? `<div class="market-row-detail" data-row-detail="${esc(key)}">${detail}</div>` : ""}`;
}

function renderPane() {
  if (state.tab === "mcp") return renderMcp();
  if (state.tab === "skills") return renderSkills();
  if (state.tab === "repos") return renderRepos();
  return renderInstalled();
}

function paintPane(root) {
  const pane = root.querySelector("#market-pane");
  if (!pane) return;
  pane.innerHTML = renderPane();
  bindPane(root);
}

function skillDetail(skill, apps) {
  const ledger = ledgerSkill(skill.name);
  return `
    <div class="market-detail-shell">
      <div class="market-detail-hero">
        <p class="market-detail-desc">${esc(skill.description || "本地 Skill 扩展")}</p>
        <dl class="waveg-kv market-detail-kv">
          <div><dt>安装时间</dt><dd>${esc(formatWhen(ledger?.installedAt) || "已随仓库注册")}</dd></div>
          <div><dt>哈希指纹</dt><dd><code>${esc(hashHint(ledger?.hash || ledger?.review?.sha256) || "本地真源")}</code></dd></div>
        </dl>
      </div>
      <div class="market-detail-projections">
        <div class="market-detail-projections-head">
          <strong>运行时投影目标</strong>
          <span class="subtle">勾选允许该 CLI 在启动时加载此 Skill</span>
        </div>
        ${appBoxes(`skill-${skill.name}`, apps || { claude: true, codex: true }, SKILL_TARGETS)}
      </div>
      <div class="waveg-card-actions market-detail-actions">
        <button type="button" class="button primary" data-skill-apps="${esc(skill.name)}">${lucideIcon("check", "icon lucide")} 更新投影</button>
        <button type="button" class="button secondary compact" data-config-surface-jump="capabilities" data-cap-workspace="skills" title="前往项目成员 Skill 声明矩阵">
          ${lucideIcon("shield-check", "icon lucide")} 项目成员授权
        </button>
      </div>
    </div>`;
}

function mcpDetail(item) {
  const review = item.review ?? {};
  const cmd = review.command ?? review.config?.command ?? "—";
  const args = (review.args ?? review.config?.args ?? []).join(" ") || "—";
  const url = review.url ?? review.config?.url ?? "—";
  return `
    <div class="market-detail-shell">
      <div class="market-detail-hero">
        <p class="market-detail-desc">${esc(review.description || item.id)}</p>
        <dl class="waveg-kv market-detail-kv">
          <div><dt>协议传输</dt><dd><code>${esc(review.transport || (url !== "—" ? "SSE / HTTP" : "stdio"))}</code></dd></div>
          <div><dt>执行入口</dt><dd><code>${esc(cmd)} ${esc(args)}</code></dd></div>
          <div><dt>端点 URL</dt><dd><code>${esc(url)}</code></dd></div>
          <div><dt>扩展来源</dt><dd>${esc(item.source || "MCP Registry")}</dd></div>
          <div><dt>安装时间</dt><dd>${esc(formatWhen(item.installedAt) || "—")}</dd></div>
        </dl>
      </div>
      <div class="market-detail-projections">
        <div class="market-detail-projections-head">
          <strong>运行时投影目标</strong>
          <span class="subtle">勾选允许写入该 CLI 的 live MCP 配置文件</span>
        </div>
        ${appBoxes(`mcp-${item.id}`, item.apps || { claude: true })}
      </div>
      <div class="waveg-card-actions market-detail-actions">
        <button type="button" class="button primary" data-mcp-apps="${esc(item.id)}">${lucideIcon("check", "icon lucide")} 更新投影</button>
        <button type="button" class="button secondary compact" data-config-surface-jump="capabilities" data-cap-workspace="mcp" title="前往 MCP 运行与启停状态">
          ${lucideIcon("server", "icon lucide")} 查看运行态
        </button>
      </div>
    </div>`;
}

function renderInstalled() {
  const showSkill = state.kindFilter !== "mcp";
  const showMcp = state.kindFilter !== "skill";
  const skillRows = showSkill ? state.skills.filter((skill) => matchesQuery([skill.name, skill.description])).map((skill) => {
    const ledger = ledgerSkill(skill.name);
    return row({
      kind: "skill",
      id: skill.name,
      title: skill.name,
      meta: skill.description || "本地 Skill",
      badges: [{ text: "Skill", on: false }, ...appBadges(ledger?.apps)],
      actions: `<button type="button" class="button" data-skill-remove="${esc(skill.name)}">${lucideIcon("trash-2", "icon lucide")} 卸载</button>`,
      detail: skillDetail(skill, ledger?.apps),
    });
  }) : [];
  const mcpRows = showMcp ? installedMcp().filter((item) => matchesQuery([item.review?.name, item.id, item.source])).map((item) => row({
    kind: "mcp",
    id: item.id,
    title: item.review?.name || item.id,
    meta: `${item.source || "mcp"} · ${item.projected === false ? "仅台账（目录未给出 command/url）" : "已写入 live 配置"}`,
    badges: [{ text: "MCP", on: true }, ...appBadges(item.apps)],
    actions: `<button type="button" class="button" data-mcp-remove="${esc(item.id)}">${lucideIcon("trash-2", "icon lucide")} 卸载</button>`,
    detail: mcpDetail(item),
  })) : [];
  if (!skillRows.length && !mcpRows.length) {
    if (state.kindFilter !== "all" || currentQuery().trim()) {
      return emptyState("没有匹配的已安装组件", "换个关键词，或把类型筛回「全部」。");
    }
    return emptyState("还没有安装任何组件", "去 Skills 页从仓库安装，或搜索 MCP 后审查写入。", "去 Skills", { tab: "skills" });
  }
  return `<div class="market-list">${skillRows.join("")}${mcpRows.join("")}</div>`;
}

function renderSkills() {
  const rows = state.catalog.filter((skill) => matchesQuery([skill.name, skill.description, skill.repo, skill.path])).map((skill) => row({
    kind: "skill",
    id: `${skill.repoId}:${skill.path}`,
    title: skill.name,
    meta: `${skill.path || "."} · ${skill.repo || ""}`,
    badges: skill.installed ? [{ text: "已安装", on: true }] : [],
    actions: skill.installed
      ? `<button type="button" class="button" data-skill-remove="${esc(skill.name)}">${lucideIcon("trash-2", "icon lucide")} 卸载</button>`
      : `<button type="button" class="button primary" data-skill-stage-repo="${esc(skill.repoId)}" data-skill-path="${esc(skill.path)}">${lucideIcon("download", "icon lucide")} 安装</button>`,
    detail: `<p>${esc(skill.description || "仓库里的 Skill")}</p><p class="subtle">${esc(skill.repo || "")} · ${esc(skill.path || ".")}</p>`,
  }));
  if (!state.catalog.length) {
    return emptyState("仓库还没扫描到 Skill", "先到「仓库」添加 owner/name 并扫描。skills.sh 公开 API 需登录，发现面走 GitHub。", "去仓库", { tab: "repos" });
  }
  return rows.length ? `<div class="market-list">${rows.join("")}</div>` : emptyState("没有匹配的技能", "换个关键词，或清空搜索。");
}

function renderMcp() {
  const searchRows = state.mcp.items.filter((item) => matchesQuery([item.name, item.id, item.description, item.source])).map((item) => row({
    kind: "mcp",
    id: item.id,
    title: item.name || item.id,
    meta: `${item.source} · ${item.description || "（无描述）"}`,
    badges: [{ text: item.source, on: false }],
    actions: `<button type="button" class="button primary" data-mcp-stage="${esc(item.id)}" data-source="${esc(item.source)}">${lucideIcon("scan-search", "icon lucide")} 审查安装</button>`,
    detail: `<p>${esc(item.description || "（无描述）")}</p><p class="subtle">${esc(item.id)}</p>`,
  }));
  if (state.mcp.searched) {
    if (!searchRows.length) return emptyState("没有命中", "换关键词或换来源再搜。");
    return `<div class="market-list">${searchRows.join("")}</div>`;
  }
  const localRows = installedMcp().filter((item) => matchesQuery([item.review?.name, item.id, item.source])).map((item) => row({
    kind: "mcp",
    id: item.id,
    title: item.review?.name || item.id,
    meta: `${item.source || "mcp"} · 已安装`,
    badges: [{ text: "已安装", on: true }, ...appBadges(item.apps)],
    actions: `<button type="button" class="button" data-mcp-remove="${esc(item.id)}">${lucideIcon("trash-2", "icon lucide")} 卸载</button>`,
    detail: mcpDetail(item),
  }));
  const hint = emptyState("搜索 MCP 目录", "官方 Registry 或 Smithery。点右上角「添加 → 搜索 MCP」，或在搜索框回车。", "搜索 MCP", { composer: "mcp" });
  if (!localRows.length) return hint;
  return `<div class="market-list">${localRows.join("")}</div>${hint}`;
}

function renderRepos() {
  const rows = state.repos.filter((repo) => matchesQuery([repo.id, repo.owner, repo.name, repo.branch])).map((repo) => row({
    kind: "repo",
    id: repo.id,
    title: repo.id,
    meta: `分支 ${repo.branch} · 识别到 ${repo.skills?.length ?? 0} 个技能${repo.scannedAt ? ` · 扫描于 ${formatWhen(repo.scannedAt)}` : ""}`,
    actions: `
      <a class="icon-button" href="https://github.com/${esc(repo.owner)}/${esc(repo.name)}" target="_blank" rel="noreferrer" title="打开仓库">${lucideIcon("external-link", "icon lucide")}</a>
      <button type="button" class="button" data-repo-scan="${esc(repo.id)}">${lucideIcon("refresh-cw", "icon lucide")} 扫描</button>
      <button type="button" class="icon-button" data-repo-remove="${esc(repo.id)}" title="移除">${lucideIcon("trash-2", "icon lucide")}</button>`,
    detail: repo.skills?.length
      ? `<p>${repo.skills.slice(0, 12).map((skill) => esc(skill.name)).join(" · ")}${repo.skills.length > 12 ? ` 等 ${repo.skills.length} 个` : ""}</p>`
      : `<p class="subtle">还没扫描。点「扫描」读取 GitHub 树里的 SKILL.md。</p>`,
  }));
  if (!rows.length) {
    return emptyState("还没有仓库", "默认会列出 anthropics/skills。添加 owner/name 后扫描即可进 Skills。", "添加仓库", { composer: "repo" });
  }
  return `<div class="market-list">${rows.join("")}</div>`;
}

function bindComposer(root) {
  root.querySelector("[data-composer-close]")?.addEventListener("click", () => {
    state.composer = "";
    render(root);
  });
  root.querySelector("#mcp-search")?.addEventListener("click", () => void mcpSearch(root));
  root.querySelector("#mcp-query")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void mcpSearch(root);
  });
  root.querySelector("#skill-stage")?.addEventListener("click", () => void skillStage(root));
  root.querySelector("#repo-add")?.addEventListener("click", () => void repoAdd(root));
  root.querySelector("#repos-scan-all")?.addEventListener("click", () => void reposScanAll(root));
}

function bindPane(root) {
  root.querySelectorAll("#market-pane [data-market-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tab = button.dataset.marketTab;
      state.message = "";
      persistTab();
      render(root);
    });
  });
  root.querySelectorAll("#market-pane [data-market-composer]").forEach((button) => {
    button.addEventListener("click", () => {
      state.composer = button.dataset.marketComposer;
      if (state.composer === "mcp") state.tab = "mcp";
      if (state.composer === "repo") state.tab = "repos";
      if (state.composer === "zip") state.tab = "skills";
      persistTab();
      render(root);
    });
  });
  root.querySelectorAll("[data-row-toggle]").forEach((el) => {
    el.addEventListener("click", (event) => {
      if (event.target.closest(".market-row-actions, button, a, input, label, select")) return;
      const key = el.dataset.rowToggle;
      state.openId = state.openId === key ? "" : key;
      paintPane(root);
    });
  });
  root.querySelectorAll("[data-mcp-stage]").forEach((button) => {
    button.addEventListener("click", () => void mcpStage(root, button.dataset.source, button.dataset.mcpStage));
  });
  root.querySelectorAll("[data-mcp-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!window.confirm(`确定卸载 MCP「${button.dataset.mcpRemove}」？会从台账和已投影的 CLI 配置里撤掉。`)) return;
      void mcpRemove(root, button.dataset.mcpRemove);
    });
  });
  root.querySelectorAll("[data-mcp-apps]").forEach((button) => {
    button.addEventListener("click", () => void mcpUpdateApps(root, button.dataset.mcpApps));
  });
  root.querySelectorAll("[data-skill-stage-repo]").forEach((button) => {
    button.addEventListener("click", () => void skillStageRepo(root, button.dataset.skillStageRepo, button.dataset.skillPath));
  });
  root.querySelectorAll("[data-skill-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!window.confirm(`确定卸载 Skill「${button.dataset.skillRemove}」？会从项目和已投影的 CLI 里撤掉，不可恢复。`)) return;
      void skillRemove(root, button.dataset.skillRemove);
    });
  });
  root.querySelectorAll("[data-skill-apps]").forEach((button) => {
    button.addEventListener("click", () => void skillUpdateApps(root, button.dataset.skillApps));
  });
  root.querySelectorAll("[data-repo-scan]").forEach((button) => {
    button.addEventListener("click", () => void repoScan(root, button.dataset.repoScan));
  });
  root.querySelectorAll("[data-repo-remove]").forEach((button) => {
    button.addEventListener("click", () => void repoRemove(root, button.dataset.repoRemove));
  });
}

async function mcpSearch(root) {
  const query = root.querySelector("#mcp-query")?.value?.trim() || root.querySelector("#market-query")?.value?.trim() || "";
  const source = root.querySelector("#mcp-source")?.value || state.mcp.source || "official";
  const generation = ++mcpSearchGeneration;
  state.mcp = { query, source, items: [], searched: false };
  state.tab = "mcp";
  state.message = "搜索中…";
  persistTab();
  render(root);
  try {
    const result = await request(`/api/market/mcp/search?q=${encodeURIComponent(query)}&source=${encodeURIComponent(source)}`);
    if (generation !== mcpSearchGeneration) return;
    state.mcp.items = result?.items ?? [];
    state.message = "";
  } catch (error) {
    if (generation !== mcpSearchGeneration) return;
    state.mcp.items = [];
    state.message = `搜索失败：${error.message}`;
  }
  state.mcp.searched = true;
  render(root);
}

async function mcpStage(root, source, id) {
  try {
    const result = await request("/api/market/mcp/stage", { method: "POST", body: { source, id } });
    state.review = { kind: "mcp", stageId: result.stageId, review: result.review };
    state.message = "";
  } catch (error) {
    state.review = { kind: "error", error: error.message };
  }
  render(root);
}

async function mcpRemove(root, id) {
  try {
    await request(`/api/market/mcp/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.message = `已卸载 ${id}`;
    if (state.openId === rowKey("mcp", id)) state.openId = "";
  } catch (error) {
    state.message = `卸载失败：${error.message}`;
  }
  await refresh(root);
}

async function mcpUpdateApps(root, id) {
  try {
    await request(`/api/market/mcp/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: { apps: readApps(root, `mcp-${id}`) },
    });
    state.message = `已更新 ${id} 的投影目标`;
  } catch (error) {
    state.message = `更新失败：${error.message}`;
  }
  await refresh(root);
}

async function skillUpdateApps(root, name) {
  try {
    await request(`/api/market/skills/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: { apps: readApps(root, `skill-${name}`, SKILL_TARGETS) },
    });
    state.message = `已更新 ${name} 的投影目标`;
  } catch (error) {
    state.message = `更新失败：${error.message}`;
  }
  await refresh(root);
}

async function skillStage(root) {
  const url = root.querySelector("#skill-url")?.value?.trim() || "";
  try {
    const result = await request("/api/market/skills/stage", { method: "POST", body: { url } });
    state.review = { kind: "skill", stageId: result.stageId, review: result.review };
    state.message = "";
    state.composer = "";
  } catch (error) {
    state.review = { kind: "error", error: error.message };
  }
  render(root);
}

async function skillStageRepo(root, repoId, skillPath) {
  try {
    const result = await request("/api/market/skills/stage-repo", { method: "POST", body: { repoId, skillPath } });
    state.review = { kind: "skill", stageId: result.stageId, review: result.review };
    state.message = "";
  } catch (error) {
    state.review = { kind: "error", error: error.message };
  }
  render(root);
}

async function repoAdd(root) {
  const url = root.querySelector("#repo-url")?.value?.trim() || "";
  const branch = root.querySelector("#repo-branch")?.value?.trim() || "main";
  try {
    await request("/api/market/repos", { method: "POST", body: { url, branch } });
    state.message = "仓库已添加，接着扫描。";
    state.composer = "";
    state.tab = "repos";
    persistTab();
    await refresh(root);
  } catch (error) {
    state.message = error.message;
    render(root);
  }
}

async function repoScan(root, id) {
  state.message = `正在扫描 ${id}…`;
  render(root);
  try {
    const result = await request(`/api/market/repos/${encodeURIComponent(id)}/scan`, { method: "POST", body: {} });
    state.message = `识别到 ${result.repo?.skills?.length ?? 0} 个技能`;
    state.tab = "skills";
    persistTab();
    await refresh(root);
  } catch (error) {
    state.message = error.message;
    render(root);
  }
}

async function reposScanAll(root) {
  state.message = "正在扫描全部仓库…";
  render(root);
  try {
    const result = await request("/api/market/repos/scan-all", { method: "POST", body: {} });
    const failed = (result.repos ?? []).filter((item) => !item.ok).length;
    state.message = failed
      ? `扫到 ${result.skills ?? 0} 个技能，${failed} 个仓库失败`
      : `扫到 ${result.skills ?? 0} 个技能`;
    state.tab = "skills";
    persistTab();
    await refresh(root);
  } catch (error) {
    state.message = error.message;
    render(root);
  }
}

async function repoRemove(root, id) {
  try {
    await request(`/api/market/repos/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refresh(root);
  } catch (error) {
    state.message = error.message;
    render(root);
  }
}

function renderReview(root) {
  const box = root.querySelector("#market-review");
  if (!box || !state.review) return;
  if (state.review.kind === "error") {
    box.innerHTML = `<div class="waveg-review market-review-card is-error"><strong>${lucideIcon("triangle-alert", "icon lucide")} 审查失败</strong><p class="subtle">${esc(state.review.error)}</p></div>`;
    return;
  }
  const { kind, review } = state.review;
  const rows = kind === "mcp"
    ? `<div><dt>执行命令</dt><dd><code>${esc(review.command ?? review.config?.command ?? "（远端未声明）")}</code></dd></div>
       <div><dt>启动参数</dt><dd><code>${esc((review.args ?? review.config?.args ?? []).join(" ") || "无附加参数")}</code></dd></div>
       <div><dt>端点 URL</dt><dd><code>${esc(review.url ?? review.config?.url ?? "—")}</code></dd></div>
       <div><dt>环境变量</dt><dd>${esc((review.envKeys ?? []).join("、") || "无敏感环境变量声明")}</dd></div>`
    : `<div><dt>技能名称</dt><dd><strong>${esc(review.name)}</strong></dd></div>
       <div><dt>技能描述</dt><dd>${esc(review.description || "—")}</dd></div>
       <div><dt>文件数量</dt><dd>${review.files?.length ?? 0} 个文件（含 SKILL.md）</dd></div>`;
  box.innerHTML = `
    <div class="waveg-review market-review-card">
      <div class="market-review-head">
        <span class="market-review-icon" aria-hidden="true">${lucideIcon("shield-check", "icon lucide")}</span>
        <div>
          <strong>安装前安全审查（${kind === "mcp" ? "MCP 扩展服务" : "Skill 技能指令"}）</strong>
          <p class="subtle">安装即写入勾选应用的 live 配置；Skill 会同时落到当前项目 .agents/skills。</p>
        </div>
      </div>
      <dl class="waveg-kv market-review-kv">${rows}</dl>
      <div class="market-review-projections">
        <div class="market-detail-projections-head">
          <strong>投影到哪些 CLI 运行时</strong>
          <span class="subtle">各客户端将在重启或重载时加载此扩展</span>
        </div>
        ${appBoxes("review", { claude: true, codex: kind === "skill" }, kind === "skill" ? SKILL_TARGETS : MCP_TARGETS)}
      </div>
      <div class="waveg-card-actions market-review-actions">
        <button type="button" class="button primary" id="review-confirm">${lucideIcon("check", "icon lucide")} 确认安装并生效</button>
        <button type="button" class="button secondary" id="review-cancel">放弃</button>
      </div>
    </div>`;
  box.querySelector("#review-confirm").addEventListener("click", () => void reviewConfirm(root));
  box.querySelector("#review-cancel").addEventListener("click", () => {
    state.review = null;
    render(root);
  });
}

async function reviewConfirm(root) {
  if (!state.review || state.review.kind === "error") return;
  const { kind, stageId } = state.review;
  try {
    await request(`/api/market/${kind === "mcp" ? "mcp" : "skills"}/install`, {
      method: "POST",
      body: { stageId, confirmed: true, apps: readApps(root, "review", kind === "skill" ? SKILL_TARGETS : MCP_TARGETS) },
    });
    state.review = null;
    state.message = kind === "mcp" ? "MCP 已投影到勾选的 CLI。" : "Skill 已写入项目与勾选的 CLI。";
    state.tab = "installed";
    persistTab();
    await refresh(root);
  } catch (error) {
    state.review = { kind: "error", error: error.message };
    render(root);
  }
}

async function skillRemove(root, name) {
  try {
    await request(`/api/market/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
    state.message = `已卸载 ${name}`;
    if (state.openId === rowKey("skill", name)) state.openId = "";
  } catch (error) {
    state.message = `卸载失败：${error.message}`;
  }
  await refresh(root);
}

function onDocumentClick(event) {
  if (!state.addOpen) return;
  const root = document.getElementById("market-container");
  if (!root || event.target.closest(".market-add")) return;
  state.addOpen = false;
  render(root);
}

function onDocumentKey(event) {
  if (event.key !== "Escape") return;
  const root = document.getElementById("market-container");
  if (!root) return;
  if (state.addOpen || state.composer || state.review) {
    state.addOpen = false;
    state.composer = "";
    state.review = null;
    render(root);
  }
}

/** 供 app.js 在切入视图时按需刷新（门闸授权后切回不再是死屏）。 */
export function refreshMarketPanel() {
  const root = document.getElementById("market-container");
  if (root) void refresh(root);
}

function bootWhenReady() {
  if (typeof document === "undefined") return;
  const start = () => void apiReady.then(() => {
    const root = document.getElementById("market-container");
    if (root) void refresh(root);
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onDocumentKey);
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

bootWhenReady();
