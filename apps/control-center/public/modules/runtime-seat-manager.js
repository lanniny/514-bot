const PERMISSION_MODE_LABELS = Object.freeze({
  plan: "规划 / 只读",
  "read-only": "只读执行",
  "workspace-write": "工作区写入（仍需 Build 审批）",
});

const ELIGIBILITY_LABELS = Object.freeze({
  "profile-disabled": "席位已停用",
  "command-not-configured": "缺少执行命令",
  "adapter-not-team-eligible": "Adapter 不可作为团队席位",
  "adapter-not-coordinator-capable": "Adapter 不支持主脑职责",
  "runtime-coordinator-disabled": "席位未开放主脑资格",
  "runtime-profile-ineligible": "席位配置不完整",
});

/** T5：席位品牌 → 原生设置端点 agent（新 CLI 接入后端 builder 后在此补条目）。 */
const NATIVE_SETTINGS_AGENT_BY_BRAND = Object.freeze({
  grok: "grok-build",
  codex: "codex-technical",
});

const NATIVE_SETTINGS_UNAVAILABLE_REASONS = Object.freeze({
  "config-not-found": "未找到 config.toml——CLI 可能尚未初始化，先在终端跑一次 /config。",
  "config-unreadable": "config.toml 读取失败，稍后重试或检查文件权限。",
  "no-whitelisted-fields": "配置文件存在但没有可展示的白名单字段——CLI 可能还在用默认值。",
});

function today() {
  return new Date().toISOString().slice(0, 10);
}

function cleanId(value) {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) ? id : "";
}

export function createRuntimeSeatManager({
  state,
  request,
  api,
  escapeHtml,
  toast,
  confirmAction,
  getProviders = () => [],
  ensureProviders,
  onCatalogChanged,
  onModeChanged,
  onSelectionChanged,
  onOpenMember,
  onConnectionContextChanged,
  cliIconMarkup,
} = {}) {
  const byId = (id) => document.getElementById(id);
  let initialized = false;
  let busy = false;
  let dirty = false;
  let loadPromise = null;
  let loadPromiseFresh = false;
  let source = null;
  let draft = null;
  let query = "";
  let filter = "all";
  let nativeSettingsEpoch = 0; // 防陈旧响应：切席/换 Adapter 后旧 fetch 结果不再落屏

  const templates = () => Array.isArray(state.adapterTemplatesData?.templates)
    ? state.adapterTemplatesData.templates
    : [];
  // 新建席位下拉只列 CLI 执行后端；MCP/回退等非可选通道仅供内置席位固定绑定（仍保留在 templates() 供详情渲染）。
  const selectableTemplates = () => templates().filter((item) => item.selectable !== false);
  const seats = () => Array.isArray(state.runtimeSeatsData?.seats)
    ? state.runtimeSeatsData.seats
    : [];
  const runtimeProfiles = () => Array.isArray(state.runtimeSeatsData?.runtimeProfiles)
    ? state.runtimeSeatsData.runtimeProfiles
    : [];
  const templateById = (id) => templates().find((item) => item.id === id) || null;
  const seatById = (id) => seats().find((item) => item.id === id) || null;
  const runtimeById = (id) => runtimeProfiles().find((item) => item.id === id) || null;

  function seatView(seat) {
    if (!seat) return null;
    return { ...seat, ...(runtimeById(seat.id) || {}) };
  }

  /** Adapter id → 品牌 key，驱动席位列表官方徽标（与成员库同一视觉语言）。 */
  function seatBrand(adapterId) {
    const value = String(adapterId || "").toLowerCase();
    if (value.startsWith("claude")) return "claude";
    if (value.startsWith("codex")) return "codex";
    if (value.startsWith("grok")) return "grok";
    if (value.startsWith("kimi")) return "kimi";
    if (value.startsWith("opencode")) return "opencode";
    if (value.startsWith("gemini")) return "gemini";
    if (value.startsWith("pi")) return "pi";
    return "other";
  }

  /** 成员目录回退链：member-library 已同步 state.memberCatalog，否则读 bootstrap 原始目录。 */
  function memberCatalog() {
    if (Array.isArray(state.memberCatalog) && state.memberCatalog.length) return state.memberCatalog;
    if (Array.isArray(state.bootstrap?.memberCatalog)) return state.bootstrap.memberCatalog;
    return Array.isArray(state.bootstrap?.teamCatalog) ? state.bootstrap.teamCatalog : [];
  }

  /** 绑定此席位的成员清单，驱动绑定区块与删除前置说明（对称 MEMBER_IN_USE 服务端拦截）。 */
  function boundMembersOf(seatId) {
    if (!seatId) return [];
    return memberCatalog()
      .filter((member) => member?.runtimeProfileId === seatId)
      .map((member) => ({ id: member.id, label: member.label || member.id, builtin: member.builtin === true }));
  }

  function setStatus(text, tone = "neutral") {
    const status = byId("runtime-seat-form-status");
    if (!status) return;
    status.textContent = text;
    status.className = `status-label is-${tone}`;
  }

  function setBusy(next) {
    busy = Boolean(next);
    byId("runtime-seat-form")?.querySelectorAll("input, textarea, select, button").forEach((control) => {
      control.disabled = busy;
    });
    if (!busy && draft) applyFieldLocks();
    if (busy) setStatus("正在应用事务", "neutral");
  }

  function markDirty() {
    if (busy || !draft) return;
    dirty = true;
    setStatus("未保存", "warning");
  }

  function visibleSeats() {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return seats().filter((seat) => {
      if (filter === "builtin" && seat.builtin !== true) return false;
      if (filter === "custom" && seat.builtin === true) return false;
      if (!needle) return true;
      return [seat.id, seat.label, seat.role, seat.adapter, seat.provider, seat.providerId]
        .some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(needle));
    });
  }

  function renderList() {
    const root = byId("runtime-seat-list");
    if (!root) return;
    if (state.runtimeSeatsLoading && !seats().length) {
      root.innerHTML = '<div class="runtime-seat-empty">正在读取运行席位…</div>';
      return;
    }
    const list = visibleSeats();
    root.innerHTML = list.length ? list.map((seat) => {
      const live = seatView(seat);
      const active = source?.id === seat.id && state.selectedRuntimeSeatId === seat.id;
      const ready = live?.teamMemberEligible === true;
      const coordinator = live?.coordinatorEligible === true;
      const brand = seatBrand(seat.adapter);
      const logo = typeof cliIconMarkup === "function" ? cliIconMarkup(brand, "runtime-seat-logo") : "";
      const icon = logo || '<svg class="icon lucide"><use href="#lucide-cpu"></use></svg>';
      return `<button class="runtime-seat-item${active ? " is-active" : ""}" type="button" role="option" aria-selected="${active}" data-runtime-seat-id="${escapeHtml(seat.id)}" data-brand="${escapeHtml(brand)}">
        <span class="runtime-seat-item-icon" aria-hidden="true">${icon}</span>
        <span class="runtime-seat-item-copy"><strong>${escapeHtml(seat.label || seat.id)}</strong><span>${escapeHtml(live?.adapterLabel || seat.adapter || "未选择 Adapter")}</span></span>
        <span class="runtime-seat-item-state${ready ? " is-ready" : ""}" title="${ready ? coordinator ? "可执行且可担任主脑" : "可执行" : "当前不可执行"}"></span>
      </button>`;
    }).join("") : '<div class="runtime-seat-empty">没有匹配的运行席位</div>';
    byId("runtime-seat-count").textContent = `${seats().length}`;
  }

  function providerOptions(template, selectedId) {
    const select = byId("runtime-seat-provider-select");
    const scope = byId("runtime-seat-provider-scope");
    if (!select || !scope) return;
    if (!template?.providerApp) {
      select.innerHTML = '<option value="">不使用 ProviderStore 连接</option>';
      select.value = "";
      select.disabled = true;
      scope.textContent = template?.providerBindingMode === "cli-managed"
        ? "凭据与端点由 CLI 自身配置管理"
        : template?.providerBindingMode === "adapter-managed"
          ? "Provider 由 Adapter 内部路由"
          : "连接由环境或 Adapter 管理";
      scope.className = "runtime-seat-scope-note is-neutral";
      return;
    }
    const compatible = getProviders().filter((provider) => provider.apps?.[template.providerApp] === true);
    const knownSelected = compatible.some((provider) => provider.id === selectedId);
    select.innerHTML = [
      '<option value="">跟随该应用当前连接</option>',
      ...compatible.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name || provider.id)}</option>`),
      selectedId && !knownSelected ? `<option value="${escapeHtml(selectedId)}" disabled>${escapeHtml(selectedId)}（不可用）</option>` : "",
    ].join("");
    select.value = selectedId || "";
    select.disabled = busy;
    // Provider 绑定降级（服务端 manifest 语义直通）：当前环境解析不到绑定的连接时明示，
    // 席位按 Adapter 管理继续运行，引导用户重选或回到跟随应用连接。
    const degraded = selectedId && draft?.id ? runtimeById(draft.id)?.providerDegraded : null;
    if (degraded && degraded.providerId === selectedId) {
      const reasonText = degraded.reason === "provider-store-unavailable"
        ? "ProviderStore 不可用"
        : degraded.reason === "provider-app-disabled"
          ? `该连接未启用 ${degraded.providerApp || template.providerApp}`
          : "当前环境不存在该连接";
      scope.textContent = `绑定的 Provider 不可用（${reasonText}），席位按 Adapter 管理降级运行——重新选择连接，或改回「跟随该应用当前连接」。`;
      scope.className = "runtime-seat-scope-note is-warning";
      return;
    }
    const globalProjection = template.providerBindingMode === "serialized-live-projection";
    scope.textContent = globalProjection
      ? `${template.providerApp} 使用应用级全局连接；不同席位执行时会串行投影，避免配置互相覆盖。`
      : `仅显示已启用 ${template.providerApp} 的兼容 Provider。`;
    scope.className = `runtime-seat-scope-note ${globalProjection ? "is-warning" : "is-neutral"}`;
  }

  /** Provider 连接余额行：选中连接即查用量（POST /api/providers/:id/usage，key 只待在服务端），
      无用脚本的供应商由服务端回落 one-api 计费端点探测；结果写入 state.providerUsage 与供应商页共享缓存。 */
  function renderProviderBalance(usage) {
    const el = byId("runtime-seat-provider-balance");
    if (!el) return;
    if (!usage?.success) {
      el.textContent = `余额查询不可用：${usage?.error ?? "未知错误"}`;
      el.className = "runtime-seat-scope-note is-warning";
      return;
    }
    const entry = (usage.data ?? [])[0] ?? {};
    if (entry.remaining != null) {
      const usedTotal = entry.used != null && entry.total != null ? ` · 已用 ${entry.used}/${entry.total}` : "";
      el.textContent = `余额 ${entry.remaining} ${entry.unit ?? ""}${usedTotal}${entry.extra ? ` · ${entry.extra}` : ""}`;
      el.className = `runtime-seat-scope-note ${entry.remaining > 0 ? "is-neutral" : "is-warning"}`;
      return;
    }
    el.textContent = entry.extra ?? (entry.isValid === false ? entry.invalidMessage ?? "凭据无效" : "已查询，但供应商未返回余额字段");
    el.className = "runtime-seat-scope-note is-neutral";
  }

  async function refreshProviderBalance() {
    const el = byId("runtime-seat-provider-balance");
    if (!el) return;
    const providerId = byId("runtime-seat-provider-select")?.value || "";
    if (!providerId) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    const cached = state.providerUsage?.[providerId];
    if (cached) renderProviderBalance(cached);
    else {
      el.textContent = "余额查询中…";
      el.className = "runtime-seat-scope-note is-neutral";
    }
    try {
      const usage = await request(api.providerUsage(providerId), { method: "POST", body: {} });
      if (state.providerUsage) state.providerUsage[providerId] = usage;
      if ((byId("runtime-seat-provider-select")?.value || "") !== providerId) return; // 查询期间连接已切换，丢弃过期结果
      renderProviderBalance(usage);
    } catch (error) {
      if ((byId("runtime-seat-provider-select")?.value || "") !== providerId) return;
      renderProviderBalance({ success: false, error: error.message });
    }
  }

  function capabilityMarkup() {
    return '<span class="chip is-on" title="能力不参与准入或路由评分">默认全能力</span><span class="subtle">特殊通道只由带原因的显式路由规则限制</span>';
  }

  function modelOptionsFor(template, seat = {}) {
    const seen = new Map();
    // runtimeProfiles 是可执行投影，不保证携带 modelOptions；配置席位才是编辑目录真源。
    const profiles = [seat, ...seats(), ...runtimeProfiles()].filter((profile) => profile?.adapter === template?.id);
    for (const profile of profiles) {
      for (const option of profile?.modelOptions || []) {
        const id = String(option?.id ?? "").trim();
        if (id && !seen.has(id)) seen.set(id, String(option?.label || id));
      }
      const model = String(profile?.model || "").trim();
      if (model && !seen.has(model)) seen.set(model, model);
    }
    return [...seen].map(([id, label]) => ({ id, label }));
  }

  function effortOptionsFor(template, seat = {}) {
    return [...new Set([
      ...(template?.effortLevels || []),
      ...(seat?.effortLevels || []),
      ...seats()
        .filter((profile) => profile.adapter === template?.id)
        .flatMap((profile) => profile.effortLevels || []),
      ...runtimeProfiles()
        .filter((profile) => profile.adapter === template?.id)
        .flatMap((profile) => profile.effortLevels || []),
    ].map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  }

  function renderExecutionControls(template, seat = {}, { clearUnsupported = false } = {}) {
    const command = byId("runtime-seat-command-input");
    const commandHelp = byId("runtime-seat-command-help");
    const model = byId("runtime-seat-model-input");
    const modelList = byId("runtime-seat-model-options");
    const modelScope = byId("runtime-seat-model-scope");
    const effort = byId("runtime-seat-effort-input");
    const effortScope = byId("runtime-seat-effort-scope");
    const permission = byId("runtime-seat-permission-select");
    if (!template || !command || !model || !effort || !permission) return;

    commandHelp.textContent = template.commandHelp || "填写单个可执行文件名或完整路径，不包含参数。";
    if (template.commandMode === "none" && clearUnsupported) command.value = "";
    command.placeholder = template.defaultCommand || "由 Adapter 管理";

    const modelSupported = template.modelMode !== "none";
    const knownModels = modelOptionsFor(template, seat);
    modelList.innerHTML = knownModels
      .map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`)
      .join("");
    if (!modelSupported && clearUnsupported) model.value = "";
    model.placeholder = modelSupported ? "留空 = 跟随 CLI / Provider 默认" : "此 Adapter 不支持模型覆盖";
    modelScope.textContent = modelSupported
      ? knownModels.length
        ? `${knownModels.length} 个已知模型；也可填写 Provider 允许的模型 ID。`
        : "暂无已验证目录；保存席位后由 CLI 动态发现，仍可填写 Provider 模型 ID。"
      : "当前执行协议没有模型覆盖入口。";

    const effortSupported = template.effortMode !== "none";
    const effortLevels = effortOptionsFor(template, seat);
    const currentEffort = clearUnsupported && !effortSupported ? "" : String(seat.defaultEffort || effort.value || "");
    effort.innerHTML = effortSupported
      ? [
        '<option value="">跟随 Adapter 默认</option>',
        ...effortLevels.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`),
        currentEffort && !effortLevels.includes(currentEffort)
          ? `<option value="${escapeHtml(currentEffort)}">${escapeHtml(currentEffort)}（现有值）</option>`
          : "",
      ].join("")
      : '<option value="">未接入</option>';
    effort.value = effortSupported ? currentEffort : "";
    effortScope.textContent = effortSupported
      ? `${template.label} 的可执行推理档位。`
      : "该 CLI 当前没有接入可执行的通用 effort 参数。";

    const permissionModes = template.permissionModes || [];
    const currentPermission = String(seat.defaultPermissionMode || template.defaultPermissionMode || permissionModes[0] || "read-only");
    permission.innerHTML = [
      ...permissionModes.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(PERMISSION_MODE_LABELS[value] || value)}</option>`),
      currentPermission && !permissionModes.includes(currentPermission)
        ? `<option value="${escapeHtml(currentPermission)}">${escapeHtml(currentPermission)}（当前 Adapter 不支持）</option>`
        : "",
    ].join("");
    permission.value = currentPermission;
  }

  function coordinatorReason(view, template) {
    if (view?.coordinatorEligible === true) return "当前席位可作为成员主脑的执行底座";
    if (template?.coordinatorCapable !== true) return "此 Adapter 不具备主脑协议能力";
    if (view?.enabled === false) return "席位停用后不能担任主脑";
    return ELIGIBILITY_LABELS[view?.eligibilityReason] || "需要启用席位并开放主脑资格";
  }

  /* ===== T5：CLI 原生设置（只读快照）=====
   * 第一期只在 grok 席位的详情里渲染；其他 CLI 不渲染（NATIVE_SETTINGS_AGENT_BY_BRAND
   * 留扩展位）。数据全部来自 GET /api/agents/native-settings，schema 驱动，前端不解析 TOML。 */

  function nativeSettingsAgentFor(template) {
    return NATIVE_SETTINGS_AGENT_BY_BRAND[seatBrand(template?.id)] || "";
  }

  function nativeSettingsValueMarkup(field) {
    if (field.value === null || field.value === undefined) return '<span class="subtle">未设置</span>';
    let valueMarkup;
    if (field.type === "boolean") {
      valueMarkup = `<span class="chip ${field.value ? "is-on" : ""}">${field.value ? "开" : "关"}</span>`;
    } else {
      valueMarkup = `<strong>${escapeHtml(String(field.value))}</strong>`;
    }
    const semantic = field.semantic ? `<span class="runtime-seat-native-settings-semantic">${escapeHtml(field.semantic)}</span>` : "";
    return `${valueMarkup}${semantic}`;
  }

  function renderNativeSettings(payload) {
    const body = byId("runtime-seat-native-settings-body");
    const time = byId("runtime-seat-native-settings-time");
    const note = byId("runtime-seat-native-settings-note");
    if (!body) return;
    if (!payload?.available) {
      if (time) time.textContent = "";
      if (note) note.textContent = NATIVE_SETTINGS_UNAVAILABLE_REASONS[payload?.reason] || "快照不可用，稍后重试。";
      body.innerHTML = "";
      return;
    }
    if (note) note.textContent = "只读快照 · 修改请用 CLI /config";
    const stamp = payload.generatedAt
      ? new Date(payload.generatedAt).toLocaleString("zh-CN", { hour12: false })
      : "";
    if (time) time.textContent = stamp ? `快照时间 ${stamp}${payload.source ? ` · ${payload.source}` : ""}` : "";
    body.innerHTML = (payload.groups || []).filter((group) => Array.isArray(group.fields) && group.fields.length).map((group) => `
      <div class="runtime-seat-native-settings-group">
        <h5 class="runtime-seat-native-settings-group-title">${escapeHtml(group.label)}</h5>
        <dl class="runtime-seat-native-settings-fields">
          ${group.fields.map((field) => `<div class="runtime-seat-native-settings-field"><dt>${escapeHtml(field.label)}</dt><dd>${nativeSettingsValueMarkup(field)}</dd></div>`).join("")}
        </dl>
      </div>`).join("");
  }

  async function loadNativeSettings(agent) {
    const epoch = ++nativeSettingsEpoch;
    const body = byId("runtime-seat-native-settings-body");
    const note = byId("runtime-seat-native-settings-note");
    if (body) body.innerHTML = '<span class="subtle">正在读取原生设置快照…</span>';
    if (note) note.textContent = "只读快照 · 修改请用 CLI /config";
    try {
      const payload = await request(api.agentNativeSettings(agent));
      if (epoch !== nativeSettingsEpoch) return; // 期间已切席/换 Adapter，丢弃过期结果
      renderNativeSettings(payload);
    } catch (error) {
      if (epoch !== nativeSettingsEpoch) return;
      if (note) note.textContent = `快照拉取失败：${error.message}`;
      if (body) body.innerHTML = "";
    }
  }

  function syncNativeSettingsPanel(template) {
    const section = byId("runtime-seat-native-settings-section");
    if (!section) return;
    const agent = nativeSettingsAgentFor(template);
    if (!agent) {
      section.hidden = true;
      nativeSettingsEpoch += 1; // 非 grok 席位：在飞请求作废
      return;
    }
    section.hidden = false;
    void loadNativeSettings(agent);
  }

  /** SSE capability.changed 钩子：命中当前可见面板的 CLI 才重拉端点局部刷新，不整页刷。 */
  function refreshNativeSettings(runtimeProfileId) {
    const section = byId("runtime-seat-native-settings-section");
    if (!section || section.hidden || byId("runtime-seat-form")?.hidden) return;
    const template = templateById(byId("runtime-seat-adapter-select")?.value || draft?.adapter);
    const agent = nativeSettingsAgentFor(template);
    if (!agent || agent !== runtimeProfileId) return;
    void loadNativeSettings(agent);
  }

  function renderTemplateDetails(template, view = null) {
    const root = byId("runtime-seat-adapter-details");
    if (!root) return;
    const fieldIcon = byId("runtime-seat-adapter-icon");
    if (fieldIcon) {
      const brand = seatBrand(template?.id);
      fieldIcon.dataset.brand = brand;
      fieldIcon.innerHTML = typeof cliIconMarkup === "function" ? cliIconMarkup(brand, "runtime-seat-logo") : "";
    }
    if (!template) {
      root.innerHTML = '<span class="subtle">请选择受支持的 Adapter</span>';
      return;
    }
    const brand = seatBrand(template.id);
    const brandLogo = typeof cliIconMarkup === "function" ? cliIconMarkup(brand, "runtime-seat-logo runtime-seat-logo-inline") : "";
    root.innerHTML = `<div><span>执行后端</span><strong data-brand="${escapeHtml(brand)}">${brandLogo}${escapeHtml(template.label || template.id)}</strong></div>
      <div><span>传输</span><strong>${escapeHtml(template.transport || "未声明")}</strong></div>
      <div><span>Provider 作用域</span><strong>${escapeHtml(template.providerApp ? `${template.providerApp} · 应用级` : "CLI / 环境 / Adapter")}</strong></div>
      <div><span>模型 / effort</span><strong>${escapeHtml(`${template.modelMode} / ${template.effortMode}`)}</strong></div>
      <div><span>工作目录</span><strong>${escapeHtml(template.cwdMode === "per-turn" ? "逐轮可切换" : "进程启动时固定")}</strong></div>
      <div><span>主脑协议</span><strong>${template.coordinatorCapable ? "支持" : "不支持"}</strong></div>
      <p>${escapeHtml(template.description || "已注册执行协议")}</p>
      ${(template.controlNotes || []).map((note) => `<p>${escapeHtml(note)}</p>`).join("")}
      <p class="runtime-seat-coordinator-reason">${escapeHtml(coordinatorReason(view, template))}</p>`;
  }

  function applyFieldLocks() {
    const template = templateById(byId("runtime-seat-adapter-select")?.value);
    const isBuiltin = source?.builtin === true;
    byId("runtime-seat-id-input").readOnly = Boolean(source?.id);
    byId("runtime-seat-adapter-select").disabled = busy || isBuiltin;
    byId("runtime-seat-delete-button").hidden = !source || isBuiltin;
    byId("runtime-seat-duplicate-button").hidden = !source;
    const coordinator = byId("runtime-seat-coordinator-input");
    coordinator.disabled = busy || template?.coordinatorCapable !== true;
    if (template?.coordinatorCapable !== true) coordinator.checked = false;
    const command = byId("runtime-seat-command-input");
    command.required = template?.requiresCommand === true;
    command.disabled = busy || template?.commandMode === "none";
    byId("runtime-seat-model-input").disabled = busy || template?.modelMode === "none";
    byId("runtime-seat-effort-input").disabled = busy || template?.effortMode === "none";
    byId("runtime-seat-permission-select").disabled = busy;
    providerOptions(template, byId("runtime-seat-provider-select")?.value || draft?.providerId || "");
  }

  function setTemplate(templateId, { preserveCapabilities = true, preserveProvider = true, previousTemplate = null } = {}) {
    const template = templateById(templateId);
    if (!template) return;
    // 路由权重跟随模板：输入仍停在旧模板缺省值（未被手改）时换成新模板的校准缺省；手改过的值不抢
    const metricFallback = { quality: 0.8, speed: 0.8, costTier: 3 };
    for (const [inputId, key] of [["runtime-seat-quality-input", "quality"], ["runtime-seat-speed-input", "speed"], ["runtime-seat-cost-input", "costTier"]]) {
      const input = byId(inputId);
      if (!input) continue;
      const previousDefault = previousTemplate?.routingDefaults?.[key] ?? metricFallback[key];
      if (Number(input.value) === Number(previousDefault) && template.routingDefaults?.[key] != null) {
        input.value = String(template.routingDefaults[key]);
      }
    }
    syncMetricOutputs();
    byId("runtime-seat-capabilities-wall").innerHTML = capabilityMarkup();
    if (!preserveProvider || !template.providerApp) byId("runtime-seat-provider-select").value = "";
    if (!preserveCapabilities) {
      draft.model = null;
      draft.defaultEffort = null;
      draft.modelOptions = [];
      draft.effortLevels = [];
      draft.defaultPermissionMode = template.defaultPermissionMode || template.permissionModes?.[0] || "read-only";
      byId("runtime-seat-model-input").value = "";
      byId("runtime-seat-effort-input").value = "";
    }
    if (!byId("runtime-seat-command-input").value.trim() || !preserveCapabilities) {
      byId("runtime-seat-command-input").value = template.defaultCommand || "";
    }
    renderExecutionControls(template, draft, { clearUnsupported: !preserveCapabilities });
    renderTemplateDetails(template, draft);
    syncNativeSettingsPanel(template);
    providerOptions(template, preserveProvider ? draft?.providerId || "" : "");
    applyFieldLocks();
    notifyConnectionContext();
  }

  function renderEditor(seat, { isNew = false } = {}) {
    const live = isNew ? null : runtimeById(seat.id);
    draft = { ...seat, capabilities: [...(seat.capabilities || [])] };
    source = isNew ? null : seat;
    state.selectedRuntimeSeatId = isNew ? null : seat.id;
    onSelectionChanged?.(state.selectedRuntimeSeatId);
    dirty = false;
    const template = templateById(seat.adapter);

    byId("runtime-seat-editor-empty").hidden = true;
    byId("runtime-seat-form").hidden = false;
    byId("runtime-seat-form-title").textContent = isNew ? "新建运行席位" : `编辑席位 · ${seat.label || seat.id}`;
    byId("runtime-seat-source-kind").textContent = isNew ? "自定义席位" : seat.builtin ? "系统席位" : "自定义席位";
    byId("runtime-seat-id-input").value = seat.id || "";
    byId("runtime-seat-label-input").value = seat.label || "";
    byId("runtime-seat-role-input").value = seat.role || "";
    byId("runtime-seat-description-input").value = seat.description || "";
    byId("runtime-seat-system-prompt-input").value = seat.systemPrompt || "";
    byId("runtime-seat-adapter-select").innerHTML = (() => {
      const selectable = selectableTemplates();
      const known = selectable.some((item) => item.id === seat.adapter);
      return [
        ...selectable.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label || item.id)}</option>`),
        // 当前席位绑定的非可选通道（MCP/回退）：保留选中态如实呈现，但不进可选项
        seat.adapter && !known
          ? `<option value="${escapeHtml(seat.adapter)}">${escapeHtml(templateById(seat.adapter)?.label || seat.adapter)}（内置席位专用）</option>`
          : "",
      ].join("");
    })();
    byId("runtime-seat-adapter-select").value = seat.adapter || selectableTemplates()[0]?.id || "";
    // 职责不预设默认值——必填交给校验；既有席位职责作为 datalist 建议，不抢第一键
    byId("runtime-seat-role-options").innerHTML = [...new Set(seats().map((item) => String(item.role || "").trim()).filter(Boolean))]
      .map((role) => `<option value="${escapeHtml(role)}"></option>`).join("");
    byId("runtime-seat-command-input").value = seat.command || "";
    byId("runtime-seat-model-input").value = seat.model || "";
    renderExecutionControls(template, seat);
    byId("runtime-seat-enabled-input").checked = seat.enabled !== false;
    byId("runtime-seat-coordinator-input").checked = seat.coordinatorEligible !== false && template?.coordinatorCapable === true;
    byId("runtime-seat-quality-input").value = String(seat.quality ?? template?.routingDefaults?.quality ?? 0.8);
    byId("runtime-seat-speed-input").value = String(seat.speed ?? template?.routingDefaults?.speed ?? 0.8);
    byId("runtime-seat-cost-input").value = String(seat.costTier ?? template?.routingDefaults?.costTier ?? 3);
    syncMetricOutputs();
    byId("runtime-seat-capabilities-wall").innerHTML = capabilityMarkup();
    providerOptions(template, seat.providerId || "");
    void refreshProviderBalance();
    notifyConnectionContext();
    renderTemplateDetails(template, live ? { ...seat, ...live } : seat);
    syncNativeSettingsPanel(template);
    applyFieldLocks();

    const status = live?.teamMemberEligible === false ? "配置待修复" : isNew ? "尚未保存" : "已保存";
    setStatus(status, live?.teamMemberEligible === false || isNew ? "warning" : "ok");
    renderBindings(isNew ? null : seat);
    renderList();
  }

  /** 绑定成员区块：列出 runtimeProfileId 指向此席位的成员；chip 点击直达成员编辑器。 */
  function renderBindings(seat) {
    const list = byId("runtime-seat-bindings-list");
    if (!list) return;
    const bound = seat?.id ? boundMembersOf(seat.id) : [];
    list.innerHTML = bound.length
      ? bound.map((member) => `<button class="runtime-seat-binding-chip" type="button" data-binding-member="${escapeHtml(member.id)}"
          title="点击前往成员库编辑此成员">${escapeHtml(member.label)}${member.builtin ? "（内置）" : ""}</button>`).join("")
      : `<span class="runtime-seat-bindings-empty">${seat?.id ? "未被任何成员绑定——删除/改绑都安全" : "保存后才会出现成员绑定"}</span>`;
    const deleteButton = byId("runtime-seat-delete-button");
    if (deleteButton && seat?.id) {
      deleteButton.title = bound.length
        ? `被 ${bound.length} 个成员绑定（${bound.map((member) => member.label).join("、")}），服务端会阻止删除；需先解绑`
        : "未被成员绑定，可安全删除";
    }
  }

  function blankSeat(copy = null) {
    const template = templateById(copy?.adapter) || selectableTemplates()[0] || {};
    return {
      id: "",
      builtin: false,
      label: copy ? `${copy.label || "运行席位"} 副本` : "",
      role: copy?.role || "",
      description: copy?.description || "",
      systemPrompt: copy?.systemPrompt || "",
      provider: copy?.provider || template.defaultProvider || "custom",
      providerId: copy?.providerId || null,
      adapter: template.id || "",
      command: copy?.command ?? template.defaultCommand ?? null,
      model: copy?.model ?? null,
      defaultEffort: copy?.defaultEffort ?? null,
      defaultPermissionMode: copy?.defaultPermissionMode || template.defaultPermissionMode || "read-only",
      capabilities: ["*"],
      coordinatorEligible: copy?.coordinatorEligible !== false && template.coordinatorCapable === true,
      quality: copy?.quality ?? template.routingDefaults?.quality ?? 0.8,
      speed: copy?.speed ?? template.routingDefaults?.speed ?? 0.8,
      costTier: copy?.costTier ?? template.routingDefaults?.costTier ?? 3,
      enabled: copy?.enabled !== false,
      evidence: [{
        source: "control-center",
        detail: "由 Control Center 创建的自定义运行席位；尚待真实运行验证。",
        verifiedAt: today(),
      }],
      modelOptions: Array.isArray(copy?.modelOptions) ? copy.modelOptions.map((item) => ({ ...item })) : [{ id: "", label: "默认" }],
      effortLevels: Array.isArray(copy?.effortLevels) ? [...copy.effortLevels] : [],
    };
  }

  function syncMetricOutputs() {
    const quality = Number(byId("runtime-seat-quality-input")?.value || 0);
    const speed = Number(byId("runtime-seat-speed-input")?.value || 0);
    byId("runtime-seat-quality-output").textContent = quality.toFixed(2);
    byId("runtime-seat-speed-output").textContent = speed.toFixed(2);
  }

  function collect() {
    const template = templateById(byId("runtime-seat-adapter-select").value);
    const base = source || draft || {};
    const payload = {
      id: cleanId(byId("runtime-seat-id-input").value),
      builtin: false,
      label: byId("runtime-seat-label-input").value.trim(),
      role: byId("runtime-seat-role-input").value.trim(),
      description: byId("runtime-seat-description-input").value.trim(),
      systemPrompt: byId("runtime-seat-system-prompt-input").value.trim(),
      provider: template?.defaultProvider || base.provider || "custom",
      providerId: template?.providerApp ? byId("runtime-seat-provider-select").value || null : null,
      adapter: template?.id || "",
      command: byId("runtime-seat-command-input").value.trim() || null,
      model: byId("runtime-seat-model-input").value.trim() || null,
      defaultEffort: byId("runtime-seat-effort-input").value.trim() || null,
      defaultPermissionMode: byId("runtime-seat-permission-select").value,
      capabilities: ["*"],
      coordinatorEligible: template?.coordinatorCapable === true && byId("runtime-seat-coordinator-input").checked,
      quality: Number(byId("runtime-seat-quality-input").value),
      speed: Number(byId("runtime-seat-speed-input").value),
      costTier: Number(byId("runtime-seat-cost-input").value),
      enabled: byId("runtime-seat-enabled-input").checked,
      evidence: Array.isArray(base.evidence) && base.evidence.length ? base.evidence.map((item) => ({ ...item })) : blankSeat().evidence,
    };
    if (base.adapter === template?.id && Array.isArray(base.modelOptions)) payload.modelOptions = base.modelOptions.map((item) => ({ ...item }));
    if (base.adapter === template?.id && Array.isArray(base.effortLevels)) payload.effortLevels = [...base.effortLevels];
    if (base.healthMode) payload.healthMode = base.healthMode;
    if (base.systemPromptFile) payload.systemPromptFile = base.systemPromptFile;
    return payload;
  }

  async function canDiscard() {
    if (!dirty) return true;
    return confirmAction({
      eyebrow: "未保存席位",
      title: "放弃当前运行席位修改？",
      rows: [["席位", draft?.label || source?.label || "新席位"], ["状态", "结构化配置尚未保存"]],
      warning: "切换后无法恢复这份席位草稿。",
      confirmLabel: "放弃修改",
      danger: true,
    });
  }

  async function discard() {
    if (!await canDiscard()) return false;
    if (!dirty) return true;
    if (source) renderEditor(seatById(source.id) || source);
    else showEmpty();
    return true;
  }

  async function selectSeat(id) {
    if (source?.id === id) return;
    if (!await canDiscard()) return;
    const seat = seatById(id);
    if (seat) renderEditor(seat);
  }

  function validatePayload(payload) {
    if (!payload.id) return "席位 ID 限 1-80 位，只能包含字母、数字、点、下划线和连字符";
    if (!payload.label) return "席位名称不能为空";
    if (!payload.role) return "席位职责不能为空";
    if (!payload.adapter) return "请选择 Adapter";
    const template = templateById(payload.adapter);
    if (template?.requiresCommand && !payload.command) return "该 Adapter 需要执行命令";
    if (payload.command && template?.commandMode === "executable-only"
      && /\s/.test(payload.command) && !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(payload.command)) {
      return "执行命令只接受可执行文件名或完整路径，不能附加参数";
    }
    if (payload.model && template?.modelMode === "none") return "该 Adapter 不支持模型覆盖";
    if (payload.defaultEffort && template?.effortMode === "none") return "该 Adapter 尚未接入推理强度";
    if (!template?.permissionModes?.includes(payload.defaultPermissionMode)) return "默认权限不在该 Adapter 的支持范围内";
    return null;
  }

  async function save(event) {
    event.preventDefault();
    if (busy || !draft) return;
    const payload = collect();
    const validationError = validatePayload(payload);
    if (validationError) return toast(validationError, "error");
    const updating = Boolean(source?.id);
    setBusy(true);
    try {
      const id = source?.id || payload.id;
      const path = updating ? `${api.runtimeSeats}/${encodeURIComponent(id)}` : api.runtimeSeats;
      const body = { ...payload };
      if (updating) {
        delete body.id;
        delete body.builtin;
      }
      const result = await request(path, { method: updating ? "PUT" : "POST", body });
      dirty = false;
      await load({ fresh: true, preferredId: id, preserveDraft: false });
      await onCatalogChanged?.(id);
      const activation = result?.transaction?.activation?.status;
      const active = activation === "reloaded" || result?.seat?.activation === "live";
      const action = updating ? "运行席位已保存" : "运行席位已创建";
      setStatus(active ? "已保存并激活" : "已保存 · 待重载", active ? "ok" : "warning");
      toast(
        active ? `${action}并激活` : `${action}，待控制面重载后激活`,
        active ? "success" : "warning",
        active ? 3000 : 6000,
      );
    } catch (error) {
      setStatus("应用失败", "error");
      toast(`运行席位保存失败：${error.message}`, "error", 7000);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!source || source.builtin || busy) return;
    const bound = boundMembersOf(source.id);
    const accepted = await confirmAction({
      eyebrow: "删除运行席位",
      title: `删除「${source.label || source.id}」？`,
      rows: [
        ["席位 ID", source.id],
        bound.length
          ? ["成员绑定", `${bound.length} 个：${bound.map((member) => member.label).join("、")}——服务端将阻止删除`]
          : ["成员绑定", "无——可安全删除"],
      ],
      warning: bound.length
        ? "该席位仍被成员绑定，需先在成员库换绑或移除成员后再删除。"
        : "席位配置和事务版本会被删除；历史运行快照不受影响。",
      confirmLabel: "删除席位",
      danger: true,
    });
    if (!accepted) return;
    setBusy(true);
    try {
      await request(`${api.runtimeSeats}/${encodeURIComponent(source.id)}`, { method: "DELETE" });
      const removedId = source.id;
      source = null;
      draft = null;
      dirty = false;
      state.selectedRuntimeSeatId = null;
      await load({ fresh: true, preserveDraft: false });
      await onCatalogChanged?.(null);
      toast(`运行席位 ${removedId} 已删除`, "success");
    } catch (error) {
      toast(`运行席位删除失败：${error.message}`, "error", 7000);
    } finally {
      setBusy(false);
    }
  }

  async function load({ fresh = false, preferredId = null, preserveDraft = true } = {}) {
    if (loadPromise) {
      const activeWasFresh = loadPromiseFresh;
      const result = await loadPromise;
      if (fresh && !activeWasFresh) return load({ fresh, preferredId, preserveDraft });
      if (result !== false && preferredId && (!preserveDraft || !dirty)) {
        const target = seatById(preferredId);
        if (target) renderEditor(target);
      }
      return result;
    }
    if (!fresh && state.runtimeSeatsData && state.adapterTemplatesData) {
      renderList();
      if (preferredId) await focus(preferredId);
      return true;
    }
    loadPromiseFresh = fresh;
    const operation = (async () => {
      state.runtimeSeatsLoading = true;
      renderList();
      try {
        const [templatePayload, seatPayload] = await Promise.all([
          request(api.adapterTemplates),
          request(api.runtimeSeats),
          ensureProviders?.(),
        ]);
        state.adapterTemplatesData = Array.isArray(templatePayload)
          ? { templates: templatePayload }
          : { ...templatePayload, templates: templatePayload?.templates || [] };
        state.runtimeSeatsData = Array.isArray(seatPayload)
          ? { seats: seatPayload, runtimeProfiles: seatPayload }
          : { ...seatPayload, seats: seatPayload?.seats || [], runtimeProfiles: seatPayload?.runtimeProfiles || [] };
        renderList();
        const targetId = preferredId || state.configRuntimeFocusId || source?.id || state.selectedRuntimeSeatId;
        if (!preserveDraft || !dirty) {
          const target = seatById(targetId) || seats()[0] || null;
          if (target) renderEditor(target);
          else showEmpty();
        } else {
          syncProviders();
        }
        return true;
      } catch (error) {
        state.runtimeSeatsData = state.runtimeSeatsData || { seats: [], runtimeProfiles: [], error: error.message };
        setStatus("读取失败", "error");
        toast(`运行席位读取失败：${error.message}`, "error", 7000);
        return false;
      } finally {
        state.runtimeSeatsLoading = false;
        renderList();
      }
    })();
    loadPromise = operation;
    try {
      return await operation;
    } finally {
      if (loadPromise === operation) {
        loadPromise = null;
        loadPromiseFresh = false;
      }
    }
  }

  function connectionApp() {
    if (byId("runtime-seat-form")?.hidden) return "";
    const adapterId = byId("runtime-seat-adapter-select")?.value || draft?.adapter || "";
    return templateById(adapterId)?.providerApp || "";
  }

  function notifyConnectionContext() {
    onConnectionContextChanged?.(connectionApp(), byId("runtime-seat-provider-select")?.value || "");
  }

  function showEmpty() {
    source = null;
    draft = null;
    dirty = false;
    nativeSettingsEpoch += 1; // 编辑器关闭：在飞的原生设置快照作废
    byId("runtime-seat-editor-empty").hidden = false;
    byId("runtime-seat-form").hidden = true;
    setStatus("等待选择", "neutral");
    notifyConnectionContext();
  }

  async function focus(id, { scroll = true } = {}) {
    setMode("seats", { focus: false });
    if (!state.runtimeSeatsData || !state.adapterTemplatesData) await load();
    const target = seatById(id) || seats()[0] || null;
    if (!target) {
      showEmpty();
      return false;
    }
    if (source?.id !== target.id && !await canDiscard()) return false;
    renderEditor(target);
    if (scroll) requestAnimationFrame(() => byId("runtime-seat-form-title")?.scrollIntoView({ block: "start", behavior: "smooth" }));
    return target.id === id;
  }

  async function create() {
    setMode("seats", { focus: false });
    if (!state.runtimeSeatsData || !state.adapterTemplatesData) await load();
    if (!await canDiscard()) return false;
    renderEditor(blankSeat(), { isNew: true });
    requestAnimationFrame(() => byId("runtime-seat-id-input")?.focus({ preventScroll: true }));
    return true;
  }

  function setMode(mode, { focus = true } = {}) {
    const next = mode === "sources" ? "sources" : "seats";
    state.runtimeWorkspaceMode = next;
    document.querySelectorAll("[data-runtime-workspace-mode]").forEach((button) => {
      const active = button.dataset.runtimeWorkspaceMode === next;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    byId("runtime-seat-workspace").hidden = next !== "seats";
    byId("runtime-raw-source-workspace").hidden = next !== "sources";
    onModeChanged?.(next);
    if (next === "seats") void load();
    if (focus) byId(`runtime-workspace-${next}-tab`)?.focus({ preventScroll: true });
  }

  function syncProviders() {
    if (!draft || !byId("runtime-seat-provider-select")) return;
    const selected = byId("runtime-seat-provider-select").value || draft.providerId || "";
    providerOptions(templateById(byId("runtime-seat-adapter-select").value), selected);
  }

  function init() {
    if (initialized) return;
    initialized = true;
    byId("runtime-workspace-tabs")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-runtime-workspace-mode]");
      if (button) setMode(button.dataset.runtimeWorkspaceMode);
    });
    byId("runtime-seat-list")?.addEventListener("click", (event) => {
      const item = event.target.closest("[data-runtime-seat-id]");
      if (item) void selectSeat(item.dataset.runtimeSeatId);
    });
    byId("runtime-seat-bindings-list")?.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-binding-member]");
      if (chip) onOpenMember?.(chip.dataset.bindingMember);
    });
    byId("runtime-seat-search-input")?.addEventListener("input", (event) => {
      query = event.target.value;
      renderList();
    });
    byId("runtime-seat-filters")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-runtime-seat-filter]");
      if (!button) return;
      filter = button.dataset.runtimeSeatFilter;
      byId("runtime-seat-filters").querySelectorAll("button").forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
      renderList();
    });
    byId("runtime-seat-new-button")?.addEventListener("click", async () => {
      if (!await canDiscard()) return;
      if (!state.adapterTemplatesData) await load();
      renderEditor(blankSeat(), { isNew: true });
    });
    byId("runtime-seat-duplicate-button")?.addEventListener("click", async () => {
      if (source && await canDiscard()) renderEditor(blankSeat(source), { isNew: true });
    });
    byId("runtime-seat-delete-button")?.addEventListener("click", () => void remove());
    byId("runtime-seat-reset-button")?.addEventListener("click", () => {
      if (source) renderEditor(seatById(source.id) || source);
      else renderEditor(blankSeat(), { isNew: true });
    });
    byId("runtime-seat-form")?.addEventListener("submit", (event) => void save(event));
    byId("runtime-seat-native-settings-refresh")?.addEventListener("click", () => {
      const section = byId("runtime-seat-native-settings-section");
      if (!section || section.hidden) return;
      const template = templateById(byId("runtime-seat-adapter-select")?.value || draft?.adapter);
      const agent = nativeSettingsAgentFor(template);
      if (agent) void loadNativeSettings(agent);
    });
    byId("runtime-seat-form")?.addEventListener("input", (event) => {
      if (["runtime-seat-quality-input", "runtime-seat-speed-input"].includes(event.target.id)) syncMetricOutputs();
      markDirty();
    });
    byId("runtime-seat-form")?.addEventListener("change", (event) => {
      markDirty();
      if (event.target.id === "runtime-seat-adapter-select") {
        const previousTemplate = templateById(draft.adapter);
        draft.adapter = event.target.value;
        draft.providerId = null;
        setTemplate(event.target.value, { preserveCapabilities: false, preserveProvider: false, previousTemplate });
      }
      if (event.target.id === "runtime-seat-provider-select") {
        void refreshProviderBalance();
        notifyConnectionContext();
      }
      if (["runtime-seat-enabled-input", "runtime-seat-coordinator-input"].includes(event.target.id)) {
        renderTemplateDetails(templateById(byId("runtime-seat-adapter-select").value), {
          ...draft,
          enabled: byId("runtime-seat-enabled-input").checked,
          coordinatorEligible: byId("runtime-seat-coordinator-input").checked,
        });
      }
    });
    showEmpty();
    setMode(state.runtimeWorkspaceMode, { focus: false });
  }

  /** 成员目录晚到（bootstrap 慢聚合）或成员增删后，重渲当前编辑器的绑定区块——否则旧空态会撒谎。 */
  function refreshBindings() {
    if (source) renderBindings(source);
    else if (draft) renderBindings(null);
  }

  return {
    init,
    load,
    focus,
    create,
    setMode,
    syncProviders,
    renderList,
    refreshBindings,
    refreshNativeSettings,
    connectionApp,
    discard,
    isDirty: () => dirty,
    isBusy: () => busy,
  };
}
