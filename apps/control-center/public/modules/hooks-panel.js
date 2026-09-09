import { request as apiRequest } from "../api.js";
import { escapeHtml } from "../utils.js";

const RUNTIME_LABELS = Object.freeze({
  claude: "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  gemini: "Gemini CLI",
  kimi: "Kimi Code",
});
const RUNTIME_GROUPS = Object.freeze([
  ["claude", "Claude Code"],
  ["cursor", "Cursor"],
  ["codex", "Codex"],
  ["gemini", "Gemini CLI"],
  ["kimi", "Kimi Code"],
]);
const FALLBACK_STORES = Object.freeze([
  { id: "claude-user", runtime: "claude", scope: "user", layer: "shared", label: "用户 · Claude Code" },
  { id: "claude-user-local", runtime: "claude", scope: "user", layer: "local", label: "用户本地 · Claude Code" },
  { id: "cursor-user", runtime: "cursor", scope: "user", layer: "shared", label: "用户 · Cursor" },
  { id: "codex-user", runtime: "codex", scope: "user", layer: "shared", label: "用户 · Codex" },
  { id: "gemini-user", runtime: "gemini", scope: "user", layer: "shared", label: "用户 · Gemini CLI" },
  { id: "kimi-user", runtime: "kimi", scope: "user", layer: "shared", readonly: true, label: "用户 · Kimi Code（只读）" },
  { id: "claude-project", runtime: "claude", scope: "project", layer: "shared", label: "项目 · Claude Code" },
  { id: "claude-project-local", runtime: "claude", scope: "project", layer: "local", label: "项目本地 · Claude Code" },
  { id: "cursor-project", runtime: "cursor", scope: "project", layer: "shared", label: "项目 · Cursor" },
  { id: "codex-project", runtime: "codex", scope: "project", layer: "shared", label: "项目 · Codex" },
]);
const SCOPE_LABELS = Object.freeze({ user: "用户", project: "项目" });
const TYPE_LABELS = Object.freeze({ command: "进程", http: "HTTP", prompt: "prompt", shell: "Shell" });
const PRIMARY_EVENTS = Object.freeze([
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
  "PostToolUse", "PostToolUseFailure", "Stop",
]);
const GEMINI_EVENTS = Object.freeze([
  "SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent",
  "BeforeTool", "AfterTool", "Notification", "PreCompress",
]);
const CURSOR_EVENTS = Object.freeze([
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "PostToolUseFailure", "Stop", "SessionEnd", "SubagentStart", "SubagentStop",
  "PreCompact", "AfterAgentThought",
]);
const icon = (name) => `<svg class="icon lucide" aria-hidden="true"><use href="#lucide-${name}"></use></svg>`;

export function resolveHookStoreId({ store, scope = "user", layer = "shared", runtime = "claude" } = {}) {
  if (store) return String(store);
  const rt = String(runtime || "claude");
  if (rt === "cursor") return scope === "user" ? "cursor-user" : "cursor-project";
  if (rt === "codex") return scope === "user" ? "codex-user" : "codex-project";
  if (rt === "gemini") return "gemini-user";
  if (rt === "kimi") return "kimi-user";
  if (scope === "project") return layer === "local" ? "claude-project-local" : "claude-project";
  return layer === "local" ? "claude-user-local" : "claude-user";
}

export function eventsForStore(store) {
  const runtime = store?.runtime || "";
  const id = String(store?.id || store || "");
  if (runtime === "cursor" || id.startsWith("cursor-")) return [...CURSOR_EVENTS];
  if (runtime === "gemini" || id.startsWith("gemini-")) return [...GEMINI_EVENTS];
  return [...PRIMARY_EVENTS];
}

export function hookTitle(item) {
  const matcher = String(item?.matcher ?? item?.name ?? "").trim();
  if (matcher) return matcher;
  const command = String(item?.command || item?.url || "").trim();
  if (!command) return "匹配全部";
  const token = command.split(/\s+/).find((part) => /[\\/]/.test(part)) || command.split(/\s+/)[0] || "";
  const base = token.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1);
  return base || "匹配全部";
}

export function hookSearchText(item) {
  return [item.event, item.matcher, item.command, item.url, item.runtime, item.scope, item.layer, item.cwd, item.statusMessage]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
}

export function hookMatchesScope(item, scope) {
  if (scope === "all") return true;
  if (scope === "local") return item.layer === "local";
  return item.scope === scope;
}

export function groupHooks(items, { query = "", scope = "all" } = {}) {
  const needle = String(query ?? "").trim().toLowerCase();
  const filtered = (items ?? []).filter((item) => {
    if (!hookMatchesScope(item, scope)) return false;
    return !needle || hookSearchText(item).includes(needle);
  });
  const groups = new Map();
  for (const item of filtered) {
    const key = item.event || "Unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([event, hooks]) => ({ event, hooks }));
}

export function hooksEmptyReason({ loaded = false, loadError = "", items = [], query = "", scope = "all" } = {}) {
  if (loadError) {
    return /NOT_FOUND|404|API route not found/i.test(String(loadError)) ? "stale-kernel" : "error";
  }
  if (!loaded) return "loading";
  if (!items.length) return "none";
  if (!groupHooks(items, { query, scope }).length) return "filtered";
  return "ready";
}

export function mountHooksPanel({
  root,
  request = apiRequest,
  notify = () => {},
  confirmAction = null,
  onChanged = null,
} = {}) {
  if (!root) return null;
  const state = {
    items: [],
    stores: [],
    events: [],
    query: "",
    scope: "all",
    editing: null,
    composing: false,
    loading: false,
    loaded: false,
    loadError: "",
  };

  function message(text, tone = "success") {
    notify(text, tone === "error" ? "error" : tone === "warning" ? "warning" : "success");
  }

  async function ask(options) {
    if (typeof confirmAction === "function") return confirmAction(options);
    return window.confirm(options?.title || "确认？");
  }

  function storeById(id) {
    return state.stores.find((store) => store.id === id) || null;
  }

  async function load() {
    state.loading = true;
    if (!state.composing && !state.editing) paint();
    try {
      const payload = await request("/api/hooks");
      state.items = payload.items ?? [];
      state.stores = payload.stores ?? [];
      state.events = payload.events ?? [];
      state.loadError = "";
      state.loaded = true;
    } catch (error) {
      state.loadError = error.message || String(error);
      state.loaded = true;
      message(`钩子读取失败：${state.loadError}`, "error");
    } finally {
      state.loading = false;
      if (state.composing || state.editing) {
        const form = root.querySelector("[data-hooks-form]");
        if (form) syncFormVisibility(form);
      } else {
        paint();
      }
      onChanged?.();
    }
  }

  function eventOptions(selected, store) {
    const events = eventsForStore(store);
    const extra = (state.events || []).filter((event) => !events.includes(event) && store?.runtime === "claude");
    const option = (event) => `<option value="${escapeHtml(event)}"${event === selected ? " selected" : ""}>${escapeHtml(event)}</option>`;
    const primary = events.filter((event) => PRIMARY_EVENTS.includes(event));
    const rest = [...events.filter((event) => !PRIMARY_EVENTS.includes(event)), ...extra];
    if (rest.length && primary.length) {
      return `<optgroup label="常用">${primary.map(option).join("")}</optgroup><optgroup label="更多事件">${rest.map(option).join("")}</optgroup>`;
    }
    return [...primary, ...rest].map(option).join("");
  }

  function storeLayerLabel(store) {
    if (store.scope === "project" && store.layer === "local") return "项目本地";
    if (store.scope === "project") return "项目";
    if (store.layer === "local") return "用户本地";
    return store.readonly ? "用户（只读）" : "用户";
  }

  function storeOptions(selected) {
    const stores = state.stores.length ? state.stores : FALLBACK_STORES;
    const groups = RUNTIME_GROUPS.map(([runtime, label]) => {
      const items = stores.filter((store) => store.runtime === runtime || String(store.id || "").startsWith(`${runtime}-`));
      if (!items.length) return "";
      return `<optgroup label="${escapeHtml(label)}">${items.map((store) => (
        `<option value="${escapeHtml(store.id)}"${store.id === selected ? " selected" : ""}>${escapeHtml(storeLayerLabel(store))}</option>`
      )).join("")}</optgroup>`;
    }).filter(Boolean);
    groups.push(`<optgroup label="其他运行时"><option disabled>Grok / OpenCode / Pi — 无独立 hooks 文件</option></optgroup>`);
    return groups.join("");
  }

  function runModeOf(draft) {
    if (draft.type === "http" || draft.runMode === "http") return "http";
    if (draft.shell || draft.runMode === "shell") return "shell";
    return "process";
  }

  function formMarkup(draft = {}) {
    const isEdit = Boolean(draft.id);
    const storeId = draft.store || resolveHookStoreId(draft);
    const store = storeById(storeId);
    const runMode = runModeOf(draft);
    const customText = draft.custom && Object.keys(draft.custom).length
      ? JSON.stringify(draft.custom, null, 2)
      : "{\n  \"customKey\": \"value\"\n}";
    return `<form class="hooks-form" data-hooks-form="${isEdit ? "edit" : "create"}">
      <header class="hooks-form-bar">
        <div class="hooks-form-bar-copy">
          <button class="hooks-back" type="button" data-hooks-action="cancel-form">${icon("arrow-left")} 返回</button>
          <div>
            <p class="eyebrow">${isEdit ? "编辑钩子" : "新建钩子"}</p>
            <h3>${isEdit ? escapeHtml(hookTitle(draft)) : "新钩子"}</h3>
            <p class="hooks-store-path" data-hooks-store-path>${escapeHtml(store?.path || "选择作用域后显示真源路径")}</p>
          </div>
        </div>
        <div class="hooks-form-actions">
          <button class="button primary" type="submit">保存</button>
          <button class="button secondary" type="button" data-hooks-action="cancel-form">取消</button>
        </div>
      </header>
      <div class="hooks-form-body">
        <section class="hooks-form-section">
          <h4>身份</h4>
          <div class="hooks-form-grid">
            <label class="field"><span class="field-label">事件</span>
              <select name="event">${eventOptions(draft.event || "PreToolUse", store || { id: storeId })}</select>
              <small class="subtle">事件名随作用域变化。</small>
            </label>
            <label class="field"><span class="field-label">真源</span>
              <select name="store">${storeOptions(storeId)}</select>
              <small class="subtle">Claude / Cursor / Codex / Gemini / Kimi。Grok 没有自己的 hooks 文件。</small>
            </label>
          </div>
        </section>
        <section class="hooks-form-section">
          <h4>执行</h4>
          <div class="hooks-form-grid">
            <label class="field"><span class="field-label">运行方式</span>
              <select name="runMode">
                <option value="process"${runMode === "process" ? " selected" : ""}>进程</option>
                <option value="shell"${runMode === "shell" ? " selected" : ""}>Shell 命令</option>
                <option value="http"${runMode === "http" ? " selected" : ""}>HTTP</option>
              </select>
              <small class="subtle">进程直接拉命令；Shell 走本机 shell。</small>
            </label>
            <label class="field" data-hooks-field="matcher"><span class="field-label">匹配器</span>
              <input name="matcher" value="${escapeHtml(draft.matcher || "")}" placeholder="例如 Write, Edit, Bash">
              <small class="subtle">留空时匹配该事件的所有输入。</small>
            </label>
            <label class="field is-hidden" data-hooks-field="shell"><span class="field-label">Shell</span>
              <select name="shell">
                <option value="powershell"${draft.shell !== "cmd" ? " selected" : ""}>PowerShell</option>
                <option value="cmd"${draft.shell === "cmd" ? " selected" : ""}>cmd</option>
              </select>
              <small class="subtle">Windows 默认 PowerShell。</small>
            </label>
          </div>
          <label class="field field-block" data-hooks-field="command"><span class="field-label">命令</span>
            <input name="command" value="${escapeHtml(draft.command || "")}" placeholder="例如 echo 'Hello from hook'">
          </label>
          <label class="field field-block" data-hooks-field="argv"><span class="field-label">参数</span>
            <textarea name="argv" rows="4" placeholder="每一行一个 argv 参数">${escapeHtml((draft.argv || []).join("\n"))}</textarea>
            <small class="subtle">每一行一个 argv 参数。</small>
          </label>
          <label class="field field-block is-hidden" data-hooks-field="url"><span class="field-label">HTTP URL</span>
            <input name="url" value="${escapeHtml(draft.url || "")}" placeholder="http://127.0.0.1:23333/permission">
          </label>
        </section>
        <section class="hooks-form-section">
          <h4>高级</h4>
          <div class="hooks-form-grid">
            <label class="field"><span class="field-label">超时时间（秒）</span>
              <input name="timeout" type="number" min="1" max="600" value="${Number(draft.timeout || 60)}">
              <small class="subtle">超时时间，单位秒。</small>
            </label>
            <label class="field"><span class="field-label">状态消息</span>
              <input name="statusMessage" value="${escapeHtml(draft.statusMessage || "")}" placeholder="例如 正在检查工作区">
              <small class="subtle">钩子运行时的状态文案。</small>
            </label>
          </div>
          <label class="field checkbox"><input name="async" type="checkbox"${draft.async ? " checked" : ""}> 异步执行</label>
          <label class="field field-block"><span class="field-label">自定义字段 JSON</span>
            <textarea name="customJson" rows="8" spellcheck="false">${escapeHtml(customText)}</textarea>
          </label>
        </section>
        <p class="hooks-readonly-note is-hidden" data-hooks-readonly>这份真源目前只读，列表能看，不能从这里改。</p>
      </div>
    </form>`;
  }

  function cardMarkup(item) {
    const command = item.type === "http" ? item.url : item.command;
    const typeLabel = item.shell ? "Shell" : (TYPE_LABELS[item.type] || item.type);
    return `<article class="hooks-card${item.protected ? " is-protected" : ""}" data-hook-id="${escapeHtml(item.id)}">
      <span class="hooks-card-icon">${icon("webhook")}</span>
      <div class="hooks-card-copy">
        <div class="hooks-card-title">
          <strong>${escapeHtml(hookTitle(item))}</strong>
          <span class="hooks-tag">${escapeHtml(typeLabel)}</span>
          <span class="hooks-tag">${escapeHtml(RUNTIME_LABELS[item.runtime] || item.runtime)}</span>
          <span class="hooks-tag">${escapeHtml(SCOPE_LABELS[item.scope] || item.scope)}${item.layer === "local" ? " · 本地" : ""}</span>
          ${item.protected ? `<span class="hooks-tag is-warn">治理</span>` : ""}
          ${item.async ? `<span class="hooks-tag">async</span>` : ""}
        </div>
        <code class="hooks-command">${escapeHtml(command)}</code>
        <small class="hooks-path">${escapeHtml(item.statusMessage || item.cwd || storeById(item.store)?.label || item.store)}</small>
      </div>
      <div class="hooks-card-actions">
        <button class="icon-button" type="button" data-hooks-edit="${escapeHtml(item.id)}" title="编辑钩子" aria-label="编辑钩子">${icon("pencil")}</button>
        <button class="icon-button" type="button" data-hooks-delete="${escapeHtml(item.id)}" title="删除钩子" aria-label="删除钩子">${icon("trash-2")}</button>
      </div>
    </article>`;
  }

  function storesStrip() {
    if (!state.stores.length) return "";
    return `<div class="hooks-stores" aria-label="钩子真源">
      ${state.stores.map((store) => {
        const tone = !store.readable ? "is-error" : store.missing && !store.count ? "is-muted" : "";
        return `<span class="hooks-store-chip ${tone}">
          <strong>${escapeHtml(store.label)}</strong>
          <em>${store.readable ? `${store.count} 条` : "读失败"}</em>
        </span>`;
      }).join("")}
    </div>`;
  }

  function emptyMarkup() {
    const reason = hooksEmptyReason(state);
    if (reason === "loading") return `<div class="hooks-empty"><p>正在读取本机钩子…</p></div>`;
    if (reason === "stale-kernel") {
      return `<div class="hooks-empty is-error">
        <p>控制面内核还是旧进程</p>
        <small>本机 Claude 用户 settings 里已经有钩子。关掉桌面端再开一次，<code>/api/hooks</code> 才会接上。</small>
        <button class="button secondary" type="button" data-hooks-action="refresh">重试</button>
      </div>`;
    }
    if (reason === "error") {
      return `<div class="hooks-empty is-error">
        <p>钩子真源读不到</p>
        <small>${escapeHtml(state.loadError)}</small>
        <button class="button secondary" type="button" data-hooks-action="refresh">重试</button>
      </div>`;
    }
    if (reason === "none") {
      return `<div class="hooks-empty">
        <p>这几个真源里还没有钩子</p>
        <small>用户写 ~/.claude/settings.json，项目写仓库里的 .claude / .cursor / .codex。</small>
      </div>`;
    }
    return `<div class="hooks-empty">
      <p>没有匹配的钩子</p>
      <small>当前筛选或搜索把 ${state.items.length} 条都藏起来了。切回「全部」或清空搜索。</small>
    </div>`;
  }

  function paint() {
    const groups = groupHooks(state.items, { query: state.query, scope: state.scope });
    const count = groups.reduce((sum, group) => sum + group.hooks.length, 0);
    const formOpen = state.composing || state.editing;
    root.innerHTML = `<div class="hooks-chrome${formOpen ? " is-form" : ""}">
      ${formOpen ? formMarkup(state.editing || { store: "claude-user", event: "PreToolUse", type: "command", timeout: 60 }) : `
      <div class="hooks-heading">
        <div>
          <p class="eyebrow">任务生命周期</p>
          <h2>钩子</h2>
          <p>管理任务生命周期钩子，在特定事件发生时自动执行命令。</p>
        </div>
        <div class="hooks-heading-actions">
          <button class="icon-button" type="button" data-hooks-action="compose" title="新建钩子" aria-label="新建钩子">${icon("plus")}</button>
          <button class="icon-button" type="button" data-hooks-action="refresh" title="刷新钩子" aria-label="刷新钩子">${icon("refresh-cw")}</button>
        </div>
      </div>
      ${storesStrip()}
      <label class="search-field hooks-search">
        ${icon("search")}
        <input type="search" value="${escapeHtml(state.query)}" placeholder="搜索钩子..." data-hooks-query aria-label="搜索钩子">
      </label>
      <div class="hooks-toolbar">
        <div class="hooks-scope" role="tablist" aria-label="钩子作用域">
          ${[["all", "全部", "layers"], ["user", "用户", "users"], ["project", "项目", "folder"], ["local", "本地", "lock"]].map(([id, label, glyph]) => (
            `<button type="button" class="hooks-scope-chip${state.scope === id ? " is-active" : ""}" data-hooks-scope="${id}">${icon(glyph)}${label}</button>`
          )).join("")}
        </div>
        <p class="hooks-hint">${icon("info")} Hook 配置变更将在新会话中生效。${state.loading ? " 读取中…" : ` 当前 ${count} 条`}。</p>
      </div>
      <div class="hooks-groups" data-surface-body>
        ${groups.length ? groups.map((group) => `<section class="hooks-group">
          <h3>${escapeHtml(group.event)}<em>${group.hooks.length}</em></h3>
          ${group.hooks.map(cardMarkup).join("")}
        </section>`).join("") : emptyMarkup()}
      </div>`}
    </div>`;
    const form = root.querySelector("[data-hooks-form]");
    if (form) syncFormVisibility(form);
  }

  function syncFormVisibility(form) {
    const store = storeById(form.elements.store?.value || "claude-user");
    const runMode = form.elements.runMode?.value || "process";
    const httpOk = store?.runtime === "claude" || store?.runtime === "gemini" || store?.runtime === "codex";
    form.querySelector("[data-hooks-field=url]")?.classList.toggle("is-hidden", runMode !== "http");
    form.querySelector("[data-hooks-field=command]")?.classList.toggle("is-hidden", runMode === "http");
    form.querySelector("[data-hooks-field=argv]")?.classList.toggle("is-hidden", runMode === "http");
    form.querySelector("[data-hooks-field=shell]")?.classList.toggle("is-hidden", runMode !== "shell");
    if (runMode === "http" && !httpOk && form.elements.runMode) form.elements.runMode.value = "process";
    const selected = form.elements.event?.value;
    if (form.elements.event) {
      form.elements.event.innerHTML = eventOptions(selected, store);
      const allowed = new Set(eventsForStore(store));
      if (selected && !allowed.has(selected)) form.elements.event.value = eventsForStore(store)[0] || "SessionStart";
    }
    const hint = form.querySelector("[data-hooks-store-path]");
    if (hint) hint.textContent = store?.path || "选择作用域后显示真源路径";
    const readonly = store?.readonly === true;
    form.querySelector("[data-hooks-readonly]")?.classList.toggle("is-hidden", !readonly);
    const submit = form.querySelector("button[type=submit]");
    if (submit) submit.disabled = readonly;
  }

  function readForm(form) {
    const data = new FormData(form);
    const store = String(data.get("store") || "claude-user");
    const runMode = String(data.get("runMode") || "process");
    return {
      store,
      event: String(data.get("event") || ""),
      runMode,
      type: runMode === "http" ? "http" : "command",
      matcher: String(data.get("matcher") || ""),
      command: String(data.get("command") || ""),
      argv: String(data.get("argv") || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      url: String(data.get("url") || ""),
      timeout: Number(data.get("timeout") || 60),
      async: form.elements.async?.checked === true,
      shell: runMode === "shell" ? String(data.get("shell") || "powershell") : "",
      statusMessage: String(data.get("statusMessage") || ""),
      customJson: String(data.get("customJson") || ""),
    };
  }

  async function submitForm(form) {
    const payload = readForm(form);
    if (payload.customJson.trim()) {
      try {
        const parsed = JSON.parse(payload.customJson);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.customKey === "value" && Object.keys(parsed).length === 1) {
          payload.customJson = "";
        }
      } catch {
        message("自定义字段 JSON 无法解析", "error");
        return;
      }
    }
    try {
      if (state.editing?.id) {
        // 治理钩子改写必须过显式确认（与删除同礼）：此前静默带 confirmProtected，一次误点保存即改写守卫命令
        if (state.editing.protected) {
          const ok = await ask({
            title: "改写这条治理钩子？",
            rows: [["事件", state.editing.event], ["命令", state.editing.command || state.editing.url]],
            warning: "这是 514cc route/stop/mirror-gate。保存会立即改写守卫命令，可能改变路由/门禁行为。",
            confirmLabel: "确认改写",
            danger: true,
          });
          if (!ok) return;
          payload.confirmProtected = true;
        }
        // CAS：带当前台账 mtime，表单基于的文件被外部改写时服务端拒写（STALE_BASE）
        const store = storeById(payload.store);
        if (store?.mtimeMs != null) payload.knownMtimeMs = store.mtimeMs;
        const listed = await request(`/api/hooks/${encodeURIComponent(state.editing.id)}`, { method: "PUT", body: payload });
        state.items = listed.items ?? [];
        state.stores = listed.stores ?? state.stores;
        state.editing = null;
        message("钩子已更新");
      } else {
        const listed = await request("/api/hooks", { method: "POST", body: payload });
        state.items = listed.items ?? [];
        state.stores = listed.stores ?? state.stores;
        state.composing = false;
        message("钩子已保存");
      }
      paint();
      onChanged?.();
    } catch (error) {
      message(error.message, "error");
    }
  }

  async function removeHook(id) {
    const item = state.items.find((entry) => entry.id === id);
    if (!item) return;
    const ok = await ask({
      eyebrow: "钩子",
      title: item.protected ? "删除这条治理钩子？" : `删除「${hookTitle(item)}」？`,
      rows: [["事件", item.event], ["作用域", `${SCOPE_LABELS[item.scope] || item.scope}${item.layer === "local" ? " · 本地" : ""}`], ["命令", item.command || item.url]],
      warning: item.protected ? "这是 514cc route/stop/mirror-gate。删掉后新会话不再强制路由门或 DELTA 门禁。" : "变更将在新会话中生效。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      const listed = await request(`/api/hooks/${encodeURIComponent(id)}`, {
        method: "DELETE",
        body: { confirmProtected: item.protected, knownMtimeMs: storeById(item.store)?.mtimeMs },
      });
      state.items = listed.items ?? [];
      state.stores = listed.stores ?? state.stores;
      message("钩子已删除");
      paint();
      onChanged?.();
    } catch (error) {
      message(error.message, "error");
    }
  }

  root.addEventListener("input", (event) => {
    if (event.target.dataset.hooksQuery == null) return;
    state.query = event.target.value;
    paint();
    const input = root.querySelector("[data-hooks-query]");
    if (input) {
      input.focus();
      input.setSelectionRange(state.query.length, state.query.length);
    }
  });

  root.addEventListener("change", (event) => {
    const form = event.target.closest("[data-hooks-form]");
    if (!form) return;
    syncFormVisibility(form);
  });

  root.addEventListener("click", (event) => {
    const action = event.target.closest("[data-hooks-action]")?.dataset.hooksAction;
    if (action === "refresh") { void load(); return; }
    if (action === "compose") { state.composing = true; state.editing = null; paint(); return; }
    if (action === "cancel-form") { state.composing = false; state.editing = null; paint(); return; }
    const scope = event.target.closest("[data-hooks-scope]")?.dataset.hooksScope;
    if (scope) { state.scope = scope; paint(); return; }
    const editId = event.target.closest("[data-hooks-edit]")?.dataset.hooksEdit;
    if (editId) {
      state.editing = state.items.find((item) => item.id === editId) ?? null;
      state.composing = false;
      paint();
      return;
    }
    const deleteId = event.target.closest("[data-hooks-delete]")?.dataset.hooksDelete;
    if (deleteId) void removeHook(deleteId);
  });

  root.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-hooks-form]");
    if (!form) return;
    event.preventDefault();
    void submitForm(form);
  });

  paint();
  void load();
  const api = { refresh: load, state };
  window.__forgeHooksPanel = api;
  return api;
}
