import { request as apiRequest } from "../api.js";
import { escapeHtml } from "../utils.js";

const icon = (name) => `<svg class="icon lucide" aria-hidden="true"><use href="#lucide-${name}"></use></svg>`;

export const AUTOMATION_TEMPLATES = Object.freeze([
  {
    id: "idle-standup",
    kind: "idle",
    icon: "git-branch",
    name: "Git 站会摘要",
    blurb: "扫最近提交，用一段话交代谁改了什么、有没有该拦的风险。",
    footer: "闲时自动 · 空闲时排队执行",
    schedule: "idle",
    permissionMode: "plan",
    prompt: "回顾当前仓库最近 24 小时的 git 提交。输出：1）按作者的站会摘要 2）可能引入的回归 3）建议下一步。不要改文件。",
  },
  {
    id: "idle-risk",
    kind: "idle",
    icon: "shield",
    name: "风险扫描",
    blurb: "只读扫密钥痕迹、deny-paths 和明显的危险写入口。",
    footer: "闲时自动 · 空闲时排队执行",
    schedule: "idle",
    permissionMode: "plan",
    prompt: "对当前仓库做一次只读风险扫描：密钥字面量、guardrails/deny-paths 命中、明显的危险写入口。输出结论 + 文件路径，不要改文件。",
  },
  {
    id: "idle-docs",
    kind: "idle",
    icon: "file-text",
    name: "文档同步检查",
    blurb: "对照 CLAUDE.md / AGENTS.md / decisions，看声明和磁盘是否还对得上。",
    footer: "闲时自动 · 空闲时排队执行",
    schedule: "idle",
    permissionMode: "plan",
    prompt: "检查 CLAUDE.md、AGENTS.md、.ai-shared/decisions.md 与当前仓库事实是否漂移。只报告不一致，不要改文件。",
  },
  {
    id: "cron-pulse",
    kind: "scheduled",
    icon: "sun",
    name: "晨间脉搏",
    blurb: "每天跑一轮体系体检：路由门、DELTA、运行面故障。",
    footer: "每天",
    schedule: "every:1d",
    permissionMode: "plan",
    prompt: "对 514cc 做一次健康体检。看 route-gate 未召唤、DELTA 账本是否停摆、运行面故障。一段话结论，正常就收敛。",
  },
  {
    id: "cron-risk",
    kind: "scheduled",
    icon: "shield",
    name: "风险扫描",
    blurb: "每天扫一遍密钥和危险写入口。",
    footer: "每天",
    schedule: "every:1d",
    permissionMode: "plan",
    prompt: "对当前仓库做一次只读风险扫描：密钥字面量、deny-paths、危险写入口。输出结论 + 路径，不要改文件。",
  },
  {
    id: "cron-brief",
    kind: "scheduled",
    icon: "file-text",
    name: "发布简报",
    blurb: "归纳昨天的提交和 handoff，写成可发给 LO 的短简报。",
    footer: "每天",
    schedule: "every:1d",
    permissionMode: "plan",
    prompt: "根据最近 24 小时的 git 提交和 .ai-shared/handoff 写一份短简报：做了什么、还堵在哪、LO 要不要拍板。不要改文件。",
  },
]);

export function parseAutomationRoute(hashValue = "") {
  const path = String(hashValue).replace(/^#/, "").split("?")[0];
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "bot" && parts[1] === "automations") parts.splice(0, 1);
  if (parts[0] !== "automations") return { mode: "list", id: null };
  if (parts[1] === "new") return { mode: "create", id: null };
  if (parts[1] && parts[2] === "history") return { mode: "history", id: parts[1] };
  if (parts[1]) return { mode: "edit", id: parts[1] };
  return { mode: "list", id: null };
}

export function scheduleLabel(schedule) {
  const value = String(schedule || "manual");
  if (value === "manual") return "仅手动";
  if (value === "idle") return "闲时";
  const match = /^every:(\d+)([mhd])$/.exec(value);
  if (!match) return value;
  const unit = { m: "分钟", h: "小时", d: "天" }[match[2]];
  return match[1] === "1" && match[2] === "d" ? "每天" : `每 ${match[1]} ${unit}`;
}

export function scheduleIssue(schedule) {
  const value = String(schedule || "manual").trim();
  if (!value || value === "manual" || value === "idle") return "";
  return /^every:\d{1,4}[mhd]$/.test(value) ? "" : "计划必须是 manual、idle 或 every:<n>m/h/d";
}

export function isAutomationWritable(status = {}) {
  return status?.writable !== false
    && status?.failClosed !== true
    && !["degraded", "unavailable"].includes(status?.state);
}

const EMPTY_DRAFT = () => ({
  name: "",
  prompt: "",
  schedule: "manual",
  permissionMode: "review",
  model: "",
  effort: "",
  cwd: "",
  teamId: "",
  startAgentId: "",
  requestedAgentIds: [],
  sources: [],
});

export function mountAutomationsPage({
  root,
  request = apiRequest,
  notify = () => {},
  confirmAction = null,
  getSnapshot = () => ({}),
  onChanged = null,
  onOpenRun = null,
  routePrefix = "",
} = {}) {
  if (!root) return null;
  let draft = EMPTY_DRAFT();
  let composing = false;
  const inFlight = new Set();

  function snapshot() {
    return getSnapshot() || {};
  }

  function writable() {
    const current = snapshot();
    const status = current.status || {};
    return isAutomationWritable({
      ...current,
      ...status,
      writable: current.writable === false || status.writable === false
        ? false
        : status.writable ?? current.writable,
    });
  }

  async function runOnce(key, operation) {
    if (inFlight.has(key)) return false;
    inFlight.add(key);
    try {
      await operation();
      return true;
    } finally {
      inFlight.delete(key);
    }
  }

  function setHash(path) {
    const normalized = String(path || "#automations");
    const prefix = typeof routePrefix === "function" ? routePrefix() : routePrefix;
    const prefixed = prefix
      ? `#${String(prefix).replace(/^#|\/+$/g, "")}/${normalized.replace(/^#\/?/, "")}`
      : normalized;
    history.replaceState(null, "", prefixed);
  }

  function route() {
    return parseAutomationRoute(location.hash);
  }

  function items() {
    return Array.isArray(snapshot().automations) ? snapshot().automations : [];
  }

  function findItem(id) {
    return items().find((item) => item.id === id) || null;
  }

  function message(text, tone = "success") {
    notify(text, tone);
  }

  async function ask(options) {
    if (typeof confirmAction === "function") return confirmAction(options);
    return window.confirm(options?.title || "确认？");
  }

  function projectOptions(selected) {
    // 项目源是会话分组（多个 CLI 按 cwd 归并）：值用真实路径，显示友好名 + 路径；
    // 同名 slug（I--xxx）对 LO 无意义，不得再进下拉。
    const seen = new Set();
    const rows = [];
    for (const project of snapshot().projects || []) {
      const path = String(project.path || project.cwd || project.root || "").trim();
      if (!path) continue;
      const key = path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const label = String(project.label || project.name || "").trim()
        || path.replace(/[\\/]+$/, "").split(/[\\/]/).pop()
        || path;
      rows.push({ path, label, latestMs: Number(project.latestMs) || 0 });
    }
    rows.sort((a, b) => b.latestMs - a.latestMs);
    const options = [`<option value="">当前工作区</option>`];
    for (const row of rows) {
      options.push(`<option value="${escapeHtml(row.path)}"${row.path === selected ? " selected" : ""}>${escapeHtml(row.label)} · ${escapeHtml(row.path)}</option>`);
    }
    if (selected && !rows.some((row) => row.path === selected)) {
      options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>`);
    }
    return options.join("");
  }

  function modelOptions(selected) {
    // 模型目录跟随真实配置：按运行时档案分组，组名透出绑定的供应商；
    // 不写死 claude/codex/grok——那是把运行时名伪装成模型，且与磁盘配置漂移。
    const groups = Array.isArray(snapshot().runtimes) ? snapshot().runtimes : [];
    const options = [`<option value=""${!selected ? " selected" : ""}>运行时默认</option>`];
    let found = !selected;
    for (const group of groups) {
      if (!Array.isArray(group?.models) || !group.models.length) continue;
      const opts = group.models.map((model) => {
        if (model.id === selected) found = true;
        return `<option value="${escapeHtml(model.id)}"${model.id === selected ? " selected" : ""}>${escapeHtml(model.label || model.id)}</option>`;
      }).join("");
      options.push(`<optgroup label="${escapeHtml(group.label || group.id)}">${opts}</optgroup>`);
    }
    if (!found) options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>`);
    return options.join("");
  }

  function templateCard(template) {
    return `<button class="auto-template is-${escapeHtml(template.kind)}" type="button" data-auto-template="${escapeHtml(template.id)}">
      <span class="auto-template-top">
        <span class="auto-template-icon">${icon(template.icon)}</span>
        <span class="auto-template-go">${icon("chevron-right")}</span>
      </span>
      <strong>${escapeHtml(template.name)}</strong>
      <span class="auto-template-blurb">${escapeHtml(template.blurb)}</span>
      <em>${escapeHtml(template.footer)}</em>
    </button>`;
  }

  function itemCard(item) {
    return `<article class="auto-card${item.enabled ? "" : " is-off"}">
      <button class="auto-card-main" type="button" data-auto-open="${escapeHtml(item.id)}">
        <strong>${item.lastError ? `<span class="auto-error-dot" aria-label="上次失败"></span>` : ""}${escapeHtml(item.name)}</strong>
        <span class="auto-pills">
          <span class="auto-pill">${icon("timer")}${escapeHtml(scheduleLabel(item.schedule))}</span>
          <span class="auto-pill ${item.enabled ? "is-on" : "is-paused"}">${item.enabled ? "已启用" : "已停用"}</span>
        </span>
        <small>${escapeHtml((item.prompt || "").slice(0, 88))}${(item.prompt || "").length > 88 ? "…" : ""}</small>
      </button>
      <div class="auto-card-actions">
        <button class="icon-button" type="button" data-auto-run="${escapeHtml(item.id)}" title="立即执行" ${writable() ? "" : "disabled"}>${icon("play")}</button>
        <button class="icon-button" type="button" data-auto-edit="${escapeHtml(item.id)}" title="编辑">${icon("pencil")}</button>
      </div>
    </article>`;
  }

  function statusCopy(status = {}) {
    if (status.state === "unavailable") {
      return ["自动化状态不可用", "现有数据保持只读，请恢复控制面连接后重试。"];
    }
    if (status.code === "AUTOMATION_STORE_CORRUPT") {
      return ["自动化已暂停", "存储文件损坏，原文件已保留。修复文件后重启控制面。"];
    }
    if (status.code === "AUTOMATION_STORE_UNREADABLE") {
      return ["自动化已暂停", "存储文件不可读，原路径已保留。检查权限后重启控制面。"];
    }
    return ["自动化已暂停", status.message || "存储当前不可写；现有数据不会被修改。"];
  }

  function listMarkup() {
    const list = items();
    const status = snapshot().status || {};
    const blocked = status.writable === false || status.failClosed === true || ["degraded", "unavailable"].includes(status.state);
    const [statusTitle, statusDetail] = statusCopy(status);
    const alert = blocked
      ? `<div class="auto-alert" role="alert"><strong>${escapeHtml(statusTitle)}</strong><span>${escapeHtml(statusDetail)}</span></div>`
      : "";
    return `<div class="auto-page">
      <div class="auto-heading">
        <div>
          <h1 id="automations-title">自动化</h1>
          <p>创建定时与闲时任务。闲时任务在控制面空闲时自动排队执行。</p>
        </div>
        <div class="auto-heading-actions">
          <button class="button primary" type="button" data-auto-action="create" ${writable() ? "" : "disabled"}>${icon("plus")} 创建定时任务</button>
          <button class="button secondary" type="button" data-auto-action="create-idle" title="新建闲时任务（控制面空闲时自动执行）" ${writable() ? "" : "disabled"}>创建闲时任务</button>
        </div>
      </div>
      ${alert}
      ${list.length ? `<section class="auto-section">
        <div class="auto-section-head">
          <h2 class="auto-section-label">我的自动化</h2>
          <span class="auto-count">${list.length}</span>
        </div>
        <div class="auto-list">${list.map(itemCard).join("")}</div>
      </section>` : `<div class="auto-empty">
        <span class="auto-empty-icon">${icon("timer")}</span>
        <strong>还没有定时任务</strong>
        <p>从下方模板一键开始，或点右上角「创建定时任务」。</p>
      </div>`}
      <section class="auto-section">
        <div class="auto-section-head">
          <h2 class="auto-section-label">闲时任务模板</h2>
          <span class="auto-section-hint">控制面空闲时自动执行，也可随时手动跑</span>
        </div>
        <div class="auto-templates">${AUTOMATION_TEMPLATES.filter((item) => item.kind === "idle").map(templateCard).join("")}</div>
      </section>
      <section class="auto-section">
        <div class="auto-section-head">
          <h2 class="auto-section-label">定时任务模板</h2>
          <span class="auto-section-hint">点击模板即可创建，调度已预填</span>
        </div>
        <div class="auto-templates">${AUTOMATION_TEMPLATES.filter((item) => item.kind === "scheduled").map(templateCard).join("")}</div>
      </section>
    </div>`;
  }

  function editorMarkup(item, tab) {
    const isCreate = !item;
    const data = item ? {
      name: item.name,
      prompt: item.prompt,
      schedule: item.schedule || "manual",
      permissionMode: item.permissionMode || "review",
      model: item.model || "",
      effort: item.effort || "",
      cwd: item.cwd || "",
    } : draft;
    const history = Array.isArray(item?.runHistory) ? item.runHistory : [];
    const scheduled = data.schedule && data.schedule !== "manual";
    return `<div class="auto-page is-editor">
      <div class="auto-editor-top">
        <button class="auto-back" type="button" data-auto-action="list">${icon("arrow-left")} 自动化</button>
        <div class="auto-tabs" role="tablist">
          <button type="button" class="${tab === "edit" ? "is-active" : ""}" data-auto-tab="edit" ${isCreate ? "" : `data-auto-hash="#automations/${escapeHtml(item.id)}"`}>设置</button>
          <button type="button" class="${tab === "history" ? "is-active" : ""}" data-auto-tab="history" ${isCreate ? "disabled" : `data-auto-hash="#automations/${escapeHtml(item.id)}/history"`}>历史</button>
        </div>
        <button class="button primary" type="button" data-auto-action="save" ${writable() ? "" : "disabled"}>${isCreate ? "创建" : "保存"}</button>
      </div>
      ${tab === "history" ? `
        <div class="auto-history-box">${history.length ? history.map((row) => `
          <button class="auto-history-row${row.status === "failed" ? " is-failed" : ""}" type="button" data-auto-run-id="${escapeHtml(row.runId || "")}">
            <strong>${escapeHtml(row.source || "manual")} · ${escapeHtml(row.status || "?")}</strong>
            <span>${escapeHtml(row.at || "")}</span>
          </button>`).join("") : "<p>还没有运行记录。</p>"}</div>
      ` : `
        <form class="auto-form" data-auto-form="${isCreate ? "create" : "edit"}">
          ${item ? `<input type="hidden" name="id" value="${escapeHtml(item.id)}">` : ""}
          <label class="auto-field"><span>任务标题</span>
            <input name="name" maxlength="80" value="${escapeHtml(data.name)}" placeholder="未命名定时任务" required>
          </label>
          <div class="auto-field">
            <span>调度</span>
            <div class="auto-schedule">
              ${scheduled ? `<button class="auto-schedule-chip" type="button" data-auto-schedule="manual">${escapeHtml(scheduleLabel(data.schedule))} ×</button>` : ""}
              <button class="auto-schedule-add" type="button" data-auto-schedule="every:1d">${scheduled ? "更改计划" : "+ 添加计划"}</button>
              <input type="hidden" name="schedule" value="${escapeHtml(data.schedule || "manual")}">
            </div>
            <div class="auto-schedule-presets">
              <button class="chip" type="button" data-auto-schedule="manual">仅手动</button>
              <button class="chip" type="button" data-auto-schedule="idle">闲时</button>
              <button class="chip" type="button" data-auto-schedule="every:30m">每 30 分钟</button>
              <button class="chip" type="button" data-auto-schedule="every:6h">每 6 小时</button>
              <button class="chip" type="button" data-auto-schedule="every:1d">每天</button>
            </div>
          </div>
          <label class="auto-field auto-prompt-field"><span>指令</span>
            <textarea name="prompt" rows="10" maxlength="65536" required placeholder="例如：Review 最近 24 小时的提交，总结可能引入的 bug 和修复建议">${escapeHtml(data.prompt)}</textarea>
            <div class="auto-prompt-bar">
              <label class="auto-mini">
                ${icon("folder")}
                <select name="cwd">${projectOptions(data.cwd)}</select>
              </label>
              <label class="auto-mini">
                ${icon("shield")}
                <select name="permissionMode">
                  <option value="plan"${data.permissionMode === "plan" ? " selected" : ""}>只读</option>
                  <option value="review"${data.permissionMode === "review" ? " selected" : ""}>变更前确认</option>
                  <option value="build"${data.permissionMode === "build" ? " selected" : ""}>直接写盘</option>
                </select>
              </label>
              <span class="auto-prompt-spacer"></span>
              <label class="auto-mini">
                <select name="model">${modelOptions(data.model)}</select>
              </label>
              <label class="auto-mini">
                <select name="effort">
                  <option value=""${!data.effort ? " selected" : ""}>标准</option>
                  <option value="high"${data.effort === "high" ? " selected" : ""}>高</option>
                  <option value="xhigh"${data.effort === "xhigh" ? " selected" : ""}>最高</option>
                </select>
              </label>
            </div>
          </label>
          <div class="auto-form-actions">
            ${isCreate ? `<button class="button primary" type="submit" ${writable() ? "" : "disabled"}>创建</button>` : `
              <button class="button primary" type="submit" ${writable() ? "" : "disabled"}>保存</button>
              <button class="button secondary" type="button" data-auto-run="${escapeHtml(item.id)}" ${writable() ? "" : "disabled"}>立即执行</button>
              <button class="button secondary" type="button" data-auto-toggle="${escapeHtml(item.id)}" ${writable() ? "" : "disabled"}>${item.enabled ? "停用" : "启用"}</button>
            `}
            <button class="button secondary" type="button" data-auto-action="list">取消</button>
          </div>
        </form>
      `}
    </div>`;
  }

  function paint() {
    const current = route();
    if (current.mode === "create" || composing) {
      root.innerHTML = editorMarkup(null, "edit");
      return;
    }
    if (current.mode === "edit" || current.mode === "history") {
      const item = findItem(current.id);
      if (!item) {
        root.innerHTML = listMarkup();
        return;
      }
      root.innerHTML = editorMarkup(item, current.mode === "history" ? "history" : "edit");
      return;
    }
    composing = false;
    root.innerHTML = listMarkup();
  }

  function readForm(form) {
    const data = new FormData(form);
    return {
      id: String(data.get("id") || ""),
      name: String(data.get("name") || "").trim(),
      prompt: String(data.get("prompt") || "").trim(),
      schedule: String(data.get("schedule") || "manual").trim() || "manual",
      permissionMode: String(data.get("permissionMode") || "review"),
      model: String(data.get("model") || "") || null,
      effort: String(data.get("effort") || "") || null,
      cwd: String(data.get("cwd") || "") || null,
    };
  }

  function applyTemplate(id) {
    const template = AUTOMATION_TEMPLATES.find((item) => item.id === id);
    if (!template) return;
    if (!writable()) return message("自动化存储不可写", "error");
    draft = {
      ...EMPTY_DRAFT(),
      name: template.name,
      prompt: template.prompt,
      schedule: template.schedule,
      permissionMode: template.permissionMode,
    };
    composing = true;
    setHash("#automations/new");
    paint();
  }

  async function submitForm(form) {
    const payload = readForm(form);
    if (!payload.name) return message("先写任务标题", "warning");
    if (!payload.prompt) return message("先写指令", "warning");
    const issue = scheduleIssue(payload.schedule);
    if (issue) return message(issue, "warning");
    if (!writable()) return message("自动化已暂停，无法保存", "error");
    await runOnce(`save:${payload.id || "new"}`, async () => {
      try {
        if (payload.id) {
          await request(`/api/automations/${encodeURIComponent(payload.id)}`, { method: "PATCH", body: payload });
          message("自动化已更新");
          setHash(`#automations/${payload.id}`);
        } else {
          const created = await request("/api/automations", {
            method: "POST",
            body: {
              ...payload,
              teamId: draft.teamId || undefined,
              startAgentId: draft.startAgentId || undefined,
              requestedAgentIds: draft.requestedAgentIds?.length ? draft.requestedAgentIds : undefined,
              sources: draft.sources?.length ? draft.sources : undefined,
            },
          });
          message(`自动化「${payload.name}」已保存`);
          composing = false;
          draft = EMPTY_DRAFT();
          setHash(created?.id ? `#automations/${created.id}` : "#automations");
        }
        await onChanged?.();
        paint();
      } catch (error) {
        message(error.message, "error");
      }
    });
  }

  async function runItem(id) {
    if (!writable()) return message("自动化已暂停，无法执行", "error");
    await runOnce(`run:${id}`, async () => {
      try {
        await request(`/api/automations/${encodeURIComponent(id)}/run`, { method: "POST", body: {} });
        message("自动化已触发");
        await onChanged?.();
        paint();
      } catch (error) {
        message(error.message, "error");
      }
    });
  }

  async function toggleItem(id) {
    const item = findItem(id);
    if (!item || !writable()) return;
    await runOnce(`toggle:${id}`, async () => {
      try {
        await request(`/api/automations/${encodeURIComponent(id)}`, { method: "PATCH", body: { enabled: !item.enabled } });
        await onChanged?.();
        paint();
      } catch (error) {
        message(error.message, "error");
      }
    });
  }

  function openEditor(id) {
    composing = false;
    setHash(`#automations/${id}`);
    paint();
  }

  function openList() {
    composing = false;
    draft = EMPTY_DRAFT();
    setHash("#automations");
    paint();
  }

  function applySchedule(preset) {
    const form = root.querySelector("[data-auto-form]");
    const hidden = form?.elements.schedule;
    if (hidden) hidden.value = preset;
    draft.schedule = preset;
    const host = root.querySelector(".auto-schedule");
    if (!host) return;
    const add = host.querySelector(".auto-schedule-add");
    const chip = host.querySelector(".auto-schedule-chip");
    if (preset && preset !== "manual") {
      if (chip) chip.textContent = `${scheduleLabel(preset)} ×`;
      else add?.insertAdjacentHTML("beforebegin", `<button class="auto-schedule-chip" type="button" data-auto-schedule="manual">${escapeHtml(scheduleLabel(preset))} ×</button>`);
      if (add) add.textContent = "更改计划";
      return;
    }
    chip?.remove();
    if (add) add.textContent = "+ 添加计划";
  }

  function compose(seed = {}) {
    draft = { ...EMPTY_DRAFT(), ...seed };
    composing = true;
    setHash("#automations/new");
    paint();
  }

  root.addEventListener("click", (event) => {
    const action = event.target.closest("[data-auto-action]")?.dataset.autoAction;
    if (action === "create") { compose(); return; }
    if (action === "create-idle") { compose({ schedule: "idle", permissionMode: "plan" }); return; }
    if (action === "list") { openList(); return; }
    if (action === "save") {
      const form = root.querySelector("[data-auto-form]");
      if (form) void submitForm(form);
      return;
    }
    const templateId = event.target.closest("[data-auto-template]")?.dataset.autoTemplate;
    if (templateId) { applyTemplate(templateId); return; }
    const hash = event.target.closest("[data-auto-hash]")?.dataset.autoHash;
    if (hash) { setHash(hash); paint(); return; }
    const openId = event.target.closest("[data-auto-open]")?.dataset.autoOpen
      || event.target.closest("[data-auto-edit]")?.dataset.autoEdit;
    if (openId) { openEditor(openId); return; }
    const runId = event.target.closest("[data-auto-run]")?.dataset.autoRun;
    if (runId) { void runItem(runId); return; }
    const toggleId = event.target.closest("[data-auto-toggle]")?.dataset.autoToggle;
    if (toggleId) { void toggleItem(toggleId); return; }
    const historyRun = event.target.closest("[data-auto-run-id]")?.dataset.autoRunId;
    if (historyRun) {
      onOpenRun?.(historyRun);
      return;
    }
    const preset = event.target.closest("[data-auto-schedule]")?.dataset.autoSchedule;
    if (preset) applySchedule(preset);
  });

  root.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-auto-form]");
    if (!form) return;
    event.preventDefault();
    void submitForm(form);
  });

  paint();
  // CLI 动态模型目录到达后原位刷新编辑器里的模型下拉（不整页重绘，保住未保存的输入）
  function refreshModels() {
    const select = root.querySelector('select[name="model"]');
    if (!select) return;
    const value = select.value;
    select.innerHTML = modelOptions(value);
    select.value = value;
  }

  const api = { refresh: paint, compose, open: openEditor, list: openList, refreshModels };
  window.__forgeAutomationsPage = api;
  return api;
}
