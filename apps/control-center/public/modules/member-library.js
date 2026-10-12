/**
 * Team member registry UI. A logical member owns identity and dispatch metadata;
 * runtimeProfileId remains a read-through binding to a manifest-backed adapter.
 */
import {
  fileToAvatarDataUrl,
  hydrateAvatar,
  hydrateAvatarCatalog,
  memberAvatarMarkup,
} from "./avatars.js";
export function normalizeMemberModelOptions(options = [], defaultModel = null) {
  const normalized = new Map();
  for (const option of Array.isArray(options) ? options : []) {
    const id = String(typeof option === "string" ? option : option?.id ?? "").trim();
    if (!id || normalized.has(id)) continue;
    const label = String(typeof option === "string" ? option : option?.label ?? id).trim() || id;
    normalized.set(id, { id, label });
  }
  const fallback = String(defaultModel ?? "").trim();
  if (fallback && !normalized.has(fallback)) normalized.set(fallback, { id: fallback, label: fallback });
  return [...normalized.values()];
}

export function memberRuntimeFactValues(member = {}, profile = {}) {
  const runtime = profile?.id ? profile : member;
  const providerId = runtime.providerId || null;
  const provider = runtime.provider || (providerId ? "Provider" : "CLI / 环境 / Adapter 管理");
  return {
    provider: providerId ? `${provider} · ${providerId}` : provider,
    adapter: runtime.adapterLabel || runtime.adapter || "未接线",
    connectionScope: runtime.providerBindingMode || "Adapter 管理",
  };
}

export function createMemberLibrary({
  state,
  request,
  apiPath,
  escapeHtml,
  toast,
  confirmAction,
  onCatalogChanged,
  onToggleTeamMember,
  teamMemberState,
  onOpenConfig,
  onOpenTeam,
  onMemberSaved,
  cliIconMarkup,
  requestBlob,
  onAvatarsChanged,
} = {}) {
  const byId = (id) => document.getElementById(id);
  let filter = "all";
  let query = "";
  let draft = null;
  let source = null;
  let dirty = false;
  let busy = false;
  let revision = 0;
  let initialized = false;

  const members = () => Array.isArray(state.memberCatalog) ? state.memberCatalog : [];
  const runtimeCatalog = () => Array.isArray(state.runtimeCatalog) ? state.runtimeCatalog : [];
  const configuredProfiles = () => Array.isArray(state.bootstrap?.providers) ? state.bootstrap.providers : [];
  const memberById = (id) => members().find((member) => member.id === id) || null;

  function runtimeProfile(id) {
    const runtime = runtimeCatalog().find((profile) => profile.id === id) || {};
    const configured = configuredProfiles().find((profile) => profile.id === id) || {};
    return { ...configured, ...runtime, capabilities: configured.capabilities || runtime.capabilities || [] };
  }

  function brandFor(member) {
    const value = `${member?.provider || ""} ${member?.runtimeProfileId || ""}`.toLowerCase();
    if (value.includes("anthropic") || value.includes("claude")) return "claude";
    if (value.includes("openai") || value.includes("codex")) return "codex";
    if (value.includes("grok") || value.includes("xai")) return "grok";
    if (value.includes("kimi") || value.includes("moonshot")) return "kimi";
    if (value.includes("gemini") || value.includes("google")) return "gemini";
    if (value.includes("pi")) return "pi";
    return "other";
  }

  /** 引用该成员的团队清单（含主脑归属），驱动使用情况区块与删除前置说明。 */
  function usageOf(memberId) {
    if (!memberId) return [];
    return (Array.isArray(state.teams) ? state.teams : [])
      .filter((team) => Array.isArray(team?.members) && team.members.includes(memberId))
      .map((team) => ({
        id: team.id,
        name: team.name || team.id,
        builtin: team.builtin === true,
        isCoordinator: team.coordinator === memberId,
      }));
  }

  function setStatus(text, tone = "neutral") {
    const status = byId("member-form-status");
    if (!status) return;
    status.textContent = text;
    status.className = `status-label is-${tone}`;
  }

  function setBusy(next) {
    busy = Boolean(next);
    byId("member-form")?.querySelectorAll("input, textarea, select, button").forEach((control) => {
      control.disabled = busy;
    });
    const runtimeConfig = byId("member-open-config-button");
    if (runtimeConfig) runtimeConfig.disabled = busy || !draft?.runtimeProfileId;
    const capabilityConfig = byId("member-open-capabilities-button");
    if (capabilityConfig) capabilityConfig.disabled = busy || !source?.id;
    if (draft) renderAvatarSlot(source || draft, { isNew: !source?.id });
    if (busy) setStatus("正在保存", "neutral");
  }

  function markDirty() {
    if (busy || !draft) return;
    dirty = true;
    revision += 1;
    setStatus("未保存", "warning");
  }

  function visibleMembers() {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return members().filter((member) => {
      if (filter === "builtin" && !member.builtin) return false;
      if (filter === "custom" && member.builtin) return false;
      if (!needle) return true;
      return [member.id, member.label, member.shortLabel, member.role, member.runtimeProfileId]
        .some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(needle));
    });
  }

  function renderList() {
    const root = byId("member-library-list");
    if (!root) return;
    const list = visibleMembers();
    root.innerHTML = list.length ? list.map((member) => {
      const active = member.id === state.selectedMemberId && source?.id === member.id;
      const ready = member.teamMemberEligible === true;
      const brand = brandFor(member);
      const initials = String(member.shortLabel || member.label || member.id).slice(0, 2);
      const logo = memberAvatarMarkup(member, {
        className: "avatar-photo",
        iconClass: "member-library-logo",
        fallback: typeof cliIconMarkup === "function" ? cliIconMarkup(brand, "member-library-logo") : "",
      });
      const usageCount = usageOf(member.id).length;
      const badges = [
        member.coordinatorEligible === true ? '<span class="member-badge is-coordinator" title="许可、Adapter 与席位均满足主脑条件">主脑可任</span>' : "",
        usageCount ? `<span class="member-badge is-usage" title="被 ${usageCount} 个团队引用">团队 ${usageCount}</span>` : "",
      ].join("");
      return `<button class="member-library-item${active ? " is-active" : ""}" type="button" role="option" aria-selected="${active}" data-member-id="${escapeHtml(member.id)}" data-brand="${escapeHtml(brand)}">
        <span class="member-library-avatar" aria-hidden="true">${logo || escapeHtml(initials)}</span>
        <span class="member-library-copy"><strong>${escapeHtml(member.label || member.id)}</strong><span>${escapeHtml(member.role || member.runtimeProfileId || "未设置职责")}</span>${badges ? `<span class="member-library-badges">${badges}</span>` : ""}</span>
        <span class="member-library-state${ready ? " is-ready" : ""}" title="${ready ? "可加入团队" : "执行席位不可用"}"></span>
      </button>`;
    }).join("") : '<div class="member-library-empty">没有匹配的团队成员</div>';
  }

  function runtimeOptions(selectedId) {
    return runtimeCatalog().map((profile) => {
      const eligible = profile.teamMemberEligible === true;
      return `<option value="${escapeHtml(profile.id)}"${profile.id === selectedId ? " selected" : ""}${eligible || profile.id === selectedId ? "" : " disabled"}>${escapeHtml(profile.label || profile.id)}${eligible ? "" : "（不可用）"}</option>`;
    }).join("");
  }

  // —— 运行席位自定义选择器（2026-08-03 LO：席位一多原生 select 难挑）——
  // 原生 select 仍是表单真源（collect / change 换绑链 / 契约测试不动），上面叠可搜索、
  // 按 Adapter 品牌分组、带官方徽标与资格徽章的下拉；选择后回写 select 并派发 change。
  const SEAT_GROUP_ORDER = ["claude", "codex", "grok", "kimi", "gemini", "opencode", "pi", "other"];
  const SEAT_GROUP_LABELS = { claude: "Claude", codex: "Codex", grok: "Grok", kimi: "Kimi", gemini: "Gemini", opencode: "OpenCode", pi: "Pi", other: "其他" };
  let seatPickerQuery = "";

  /** 席位品牌：优先 Adapter 前缀（与席位管理器同纪律），回退 provider/id 关键字。 */
  function seatProfileBrand(profile) {
    const adapter = String(profile?.adapter || "").toLowerCase();
    for (const brand of ["claude", "codex", "grok", "kimi", "opencode", "gemini", "pi"]) {
      if (adapter.startsWith(brand)) return brand;
    }
    const rest = `${profile?.provider || ""} ${profile?.id || ""}`.toLowerCase();
    if (rest.includes("anthropic") || rest.includes("claude")) return "claude";
    if (rest.includes("openai") || rest.includes("codex")) return "codex";
    if (rest.includes("grok") || rest.includes("xai")) return "grok";
    if (rest.includes("kimi") || rest.includes("moonshot")) return "kimi";
    if (rest.includes("gemini") || rest.includes("google")) return "gemini";
    if (rest.includes("opencode")) return "opencode";
    if (/(^|[^a-z])pi([^a-z]|$)/.test(rest)) return "pi";
    return "other";
  }

  function seatPickerEls() {
    return {
      trigger: byId("member-seat-picker-trigger"),
      panel: byId("member-seat-picker-panel"),
      search: byId("member-seat-picker-search-input"),
      options: byId("member-seat-picker-options"),
      select: byId("member-runtime-profile-select"),
    };
  }

  /** 与 runtimeOptions 同一资格纪律：不可用席位仅当前绑定项可选中（避免换绑卡死）。 */
  function seatOptionMeta(profile, selectedId) {
    const eligible = profile.teamMemberEligible === true;
    return {
      eligible,
      selectable: eligible || profile.id === selectedId,
      reason: eligible ? "" : eligibilityReasonText(profile.eligibilityReason),
      coordinator: profile.coordinatorEligible === true,
    };
  }

  function seatIconMarkup(brand) {
    const logo = brand && typeof cliIconMarkup === "function" ? cliIconMarkup(brand, "member-seat-picker-logo") : "";
    return logo || '<svg class="icon lucide member-seat-picker-logo-fallback" aria-hidden="true"><use href="#lucide-cpu"></use></svg>';
  }

  function seatSubLine(profile) {
    return [profile.id, profile.adapterLabel || profile.adapter, profile.provider || profile.providerId]
      .filter(Boolean).join(" · ");
  }

  function seatBadgeMarkup(meta) {
    return [
      meta.coordinator ? '<span class="member-seat-picker-badge is-coord">主脑可任</span>' : "",
      !meta.eligible ? `<span class="member-seat-picker-badge is-warn">${escapeHtml(meta.reason)}</span>` : "",
    ].join("");
  }

  /** 触发器内容随 select 真源重绘；面板开着时同步刷新选项。 */
  function renderSeatPicker() {
    const { trigger, select, panel } = seatPickerEls();
    if (!trigger || !select) return;
    const selectedId = select.value || "";
    const profile = selectedId ? runtimeProfile(selectedId) : null;
    const found = Boolean(profile?.id);
    const brand = found ? seatProfileBrand(profile) : "other";
    const meta = found ? seatOptionMeta(profile, selectedId) : null;
    trigger.innerHTML = `<span class="member-seat-picker-icon" data-brand="${escapeHtml(brand)}" aria-hidden="true">${found ? seatIconMarkup(brand) : seatIconMarkup("")}</span>
      <span class="member-seat-picker-copy"><strong id="member-seat-picker-current">${escapeHtml(found ? profile.label || profile.id : "选择运行席位")}</strong><span>${escapeHtml(found ? seatSubLine(profile) : "搜索并按 Adapter 品牌分组挑选")}</span></span>
      ${meta ? seatBadgeMarkup(meta) : ""}
      <svg class="icon lucide member-seat-picker-chevron" aria-hidden="true"><use href="#lucide-chevron-down"></use></svg>`;
    trigger.dataset.empty = found ? "false" : "true";
    trigger.disabled = busy;
    if (panel && !panel.hidden) renderSeatPickerOptions();
  }

  function renderSeatPickerOptions() {
    const { options, select } = seatPickerEls();
    if (!options || !select) return;
    const selectedId = select.value || "";
    const catalog = runtimeCatalog();
    if (!catalog.length) {
      options.innerHTML = '<div class="member-seat-picker-empty">正在读取运行席位…</div>';
      return;
    }
    const rows = catalog.map((profile) => {
      const brand = seatProfileBrand(profile);
      const meta = seatOptionMeta(profile, selectedId);
      const search = `${profile.id} ${profile.label || ""} ${profile.adapter || ""} ${profile.adapterLabel || ""} ${profile.provider || ""} ${profile.providerId || ""} ${SEAT_GROUP_LABELS[brand] || ""}`.toLowerCase();
      const badges = seatBadgeMarkup(meta);
      const html = `<button class="member-seat-picker-option${profile.id === selectedId ? " is-selected" : ""}${meta.selectable ? "" : " is-disabled"}" type="button" role="option"
        aria-selected="${profile.id === selectedId}"${meta.selectable ? "" : ' aria-disabled="true"'}
        data-seat-id="${escapeHtml(profile.id)}" data-search="${escapeHtml(search)}">
        <span class="member-seat-picker-icon" data-brand="${escapeHtml(brand)}" aria-hidden="true">${seatIconMarkup(brand)}</span>
        <span class="member-seat-picker-copy"><strong>${escapeHtml(profile.label || profile.id)}</strong><span>${escapeHtml(seatSubLine(profile))}</span></span>
        ${badges ? `<span class="member-seat-picker-badges">${badges}</span>` : ""}
      </button>`;
      return { brand, html };
    });
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.brand)) groups.set(row.brand, []);
      groups.get(row.brand).push(row);
    }
    const ordered = [...groups.entries()].sort(([a], [b]) => {
      const ia = SEAT_GROUP_ORDER.indexOf(a);
      const ib = SEAT_GROUP_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });
    options.innerHTML = ordered.map(([brand, groupRows]) => `<section class="member-seat-picker-group" data-group-brand="${escapeHtml(brand)}">
        <div class="member-seat-picker-group-header">${seatIconMarkup(brand)}<strong>${escapeHtml(SEAT_GROUP_LABELS[brand] || brand)}</strong><span>${groupRows.length} 席</span></div>
        ${groupRows.map((row) => row.html).join("")}
      </section>`).join("") + '<div class="member-seat-picker-empty" hidden>没有匹配的席位</div>';
    applySeatPickerFilter();
  }

  /** 搜索只切 hidden，不重建 DOM——选中态与键盘导航行保持稳定。 */
  function applySeatPickerFilter() {
    const { options } = seatPickerEls();
    if (!options) return;
    const tokens = seatPickerQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = [...options.querySelectorAll(".member-seat-picker-option")];
    for (const row of rows) {
      row.hidden = tokens.length > 0 && !tokens.every((token) => (row.dataset.search || "").includes(token));
    }
    for (const group of options.querySelectorAll(".member-seat-picker-group")) {
      const groupRows = [...group.querySelectorAll(".member-seat-picker-option")];
      group.hidden = groupRows.length > 0 && !groupRows.some((row) => !row.hidden);
    }
    const empty = options.querySelector(".member-seat-picker-empty");
    if (empty) empty.hidden = tokens.length === 0 || rows.some((row) => !row.hidden);
  }

  function openSeatPicker() {
    const { trigger, panel, search } = seatPickerEls();
    if (!trigger || !panel || trigger.disabled || !panel.hidden) return;
    seatPickerQuery = "";
    if (search) search.value = "";
    renderSeatPickerOptions();
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onSeatPickerOutside, true);
    requestAnimationFrame(() => search?.focus());
  }

  function closeSeatPicker({ refocus = false } = {}) {
    const { trigger, panel } = seatPickerEls();
    if (!trigger || !panel || panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onSeatPickerOutside, true);
    if (refocus) trigger.focus();
  }

  function onSeatPickerOutside(event) {
    if (!event.target.closest?.("#member-seat-picker")) closeSeatPicker();
  }

  /** 回写真源 select 并派发 change——既有换绑链（模型/推理/能力跟随席位）原样接管。 */
  function pickSeatOption(id) {
    const { select } = seatPickerEls();
    if (!select || !id) return;
    closeSeatPicker({ refocus: true });
    if (select.value === id) return;
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function seatPickerRows() {
    const { options } = seatPickerEls();
    return options
      ? [...options.querySelectorAll(".member-seat-picker-option:not(.is-disabled)")].filter((row) => !row.hidden)
      : [];
  }

  function moveSeatPickerActive(delta) {
    const rows = seatPickerRows();
    if (!rows.length) return;
    const current = rows.findIndex((row) => row.classList.contains("is-active"));
    const next = current === -1
      ? (delta > 0 ? rows[0] : rows[rows.length - 1])
      : rows[(current + delta + rows.length) % rows.length];
    rows.forEach((row) => row.classList.toggle("is-active", row === next));
    next.scrollIntoView({ block: "nearest" });
  }

  function capabilityMarkup() {
    return '<span class="chip is-on" title="成员能力不再按运行席位子集收窄">默认全能力</span>';
  }

  function eligibilityReasonText(reason) {
    const labels = {
      "member-main-brain-disabled": "成员已关闭主脑资格",
      "adapter-not-coordinator-capable": "当前 Adapter 不支持主脑职责",
      "seat-main-brain-disabled": "运行席位未开放主脑资格",
      "runtime-coordinator-disabled": "运行席位未开放主脑资格",
      "profile-disabled": "运行席位已停用",
      "command-not-configured": "运行席位缺少执行命令",
      "API_PROVIDER_REQUIRED": "请为文本席位选择连接",
      "API_PROVIDER_MISSING": "绑定的模型连接不可用",
      "API_KEY_REQUIRED": "模型连接尚未配置 API Key",
      "API_MODEL_REQUIRED": "请为文本席位填写模型 ID",
      "API_PROTOCOL_UNSUPPORTED": "该连接不支持 Chat Completions",
      "API_ENDPOINT_INVALID": "模型连接地址无效",
      "runtime-profile-missing": "绑定的运行席位不存在",
      "runtime-profile-ineligible": "运行席位当前不可执行",
    };
    return labels[reason] || "运行席位当前不可执行";
  }

  function renderRuntimeDetails(member, { preferServerEligibility = false } = {}) {
    const profile = runtimeProfile(member.runtimeProfileId);
    const select = byId("member-runtime-profile-select");
    select.innerHTML = runtimeOptions(member.runtimeProfileId);
    select.value = member.runtimeProfileId || "";
    select.disabled = busy;
    renderSeatPicker();

    const profileDefaultModel = String(profile.defaultModel ?? profile.model ?? "").trim();
    const modelOptions = normalizeMemberModelOptions(profile.modelOptions, profileDefaultModel);
    byId("member-model-options").innerHTML = modelOptions
      .map((option) => `<option value="${escapeHtml(option.id)}" label="${escapeHtml(option.label)}"></option>`)
      .join("");
    const efforts = [...new Set(profile.effortLevels || [])];
    const currentEffort = member.defaultEffort || "";
    byId("member-default-effort-select").innerHTML = ["", ...efforts]
      .map((effort) => `<option value="${escapeHtml(effort)}"${effort === currentEffort ? " selected" : ""}>${escapeHtml(effort || "跟随运行席位")}</option>`)
      .join("");
    byId("member-capabilities-wall").innerHTML = capabilityMarkup();

    const mainBrainAllowed = member.mainBrainAllowed !== false;
    const coordinatorEligible = preferServerEligibility && typeof member.coordinatorEligible === "boolean"
      ? member.coordinatorEligible
      : mainBrainAllowed && profile.coordinatorEligible === true;
    const derivedCoordinatorReason = !mainBrainAllowed
      ? "成员已关闭主脑资格"
      : profile.coordinatorCapable !== true
        ? "当前 Adapter 不支持主脑职责"
        : profile.coordinatorAllowed === false
          ? "运行席位未开放主脑资格"
          : profile.enabled === false
            ? "运行席位已停用"
            : eligibilityReasonText(profile.coordinatorEligibilityReason || profile.eligibilityReason);
    const coordinatorReason = coordinatorEligible
      ? "成员许可、Adapter 与运行席位均满足主脑条件"
      : preferServerEligibility && member.coordinatorEligibilityReason
        ? eligibilityReasonText(member.coordinatorEligibilityReason)
        : derivedCoordinatorReason;
    const runtimeFacts = memberRuntimeFactValues(member, profile);
    const facts = [
      ["Provider", runtimeFacts.provider],
      ["Adapter", runtimeFacts.adapter],
      ["连接作用域", runtimeFacts.connectionScope],
      ["有效主脑资格", coordinatorEligible ? "可担任主脑" : "当前不可担任"],
    ];
    byId("member-runtime-facts").innerHTML = facts.map(([label, value]) => `<div class="member-runtime-fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
    byId("member-main-brain-input").checked = mainBrainAllowed;
    byId("member-main-brain-reason").textContent = coordinatorReason;
    const runtimeStatus = byId("member-runtime-status");
    const runtimeEligible = preferServerEligibility && typeof member.teamMemberEligible === "boolean"
      ? member.teamMemberEligible
      : profile.teamMemberEligible === true;
    runtimeStatus.textContent = runtimeEligible ? "执行席位可用" : "执行席位不可用";
    runtimeStatus.className = `status-label is-${runtimeEligible ? "ok" : "warning"}`;
  }

  /** 使用情况区块：引用此成员的团队 chip（主脑标记），点击跳转团队编排面；空态明示删除安全。 */
  function renderUsage(member) {
    const list = byId("member-usage-list");
    if (!list) return;
    const usage = member?.id ? usageOf(member.id) : [];
    list.innerHTML = usage.length
      ? usage.map((team) => `<button class="member-usage-chip${team.isCoordinator ? " is-coordinator" : ""}" type="button"
          data-usage-team="${escapeHtml(team.id)}" title="${team.isCoordinator ? "此成员是该团队主脑；" : ""}点击前往该团队的编排面">
          ${escapeHtml(team.name)}${team.builtin ? "（内置）" : ""}${team.isCoordinator ? " · 主脑" : ""}
        </button>`).join("")
      : `<span class="member-usage-empty">${member?.id ? "未被任何团队引用——删除/换绑都安全" : "保存后才会出现团队引用"}</span>`;
    const deleteButton = byId("member-delete-button");
    if (deleteButton && member?.id) {
      deleteButton.title = usage.length
        ? `被 ${usage.length} 个团队引用（${usage.map((team) => team.name).join("、")}），服务端会阻止删除；需先移出`
        : "未被团队引用，可安全删除";
    }
  }

  /** 简介/提示词字数统计（maxlength 截断前可见，避免长文盲编）。 */
  function updateCounters() {
    const pairs = [
      ["member-description-input", "member-description-count", 2000],
      ["member-system-prompt-input", "member-system-prompt-count", 12000],
    ];
    for (const [inputId, countId, max] of pairs) {
      const input = byId(inputId);
      const counter = byId(countId);
      if (!input || !counter) continue;
      const length = input.value.length;
      counter.textContent = `${length}/${max}`;
      counter.classList.toggle("is-near-limit", length >= max * 0.9);
    }
  }

  function renderEditor(member, { isNew = false } = {}) {
    closeSeatPicker();
    draft = { ...member, capabilities: [...(member.capabilities || [])] };
    source = isNew ? null : member;
    state.selectedMemberId = isNew ? null : member.id;
    dirty = false;
    revision += 1;

    byId("member-editor-empty").hidden = true;
    byId("member-editor-body").hidden = false;
    byId("member-editor-actions").hidden = false;
    byId("member-form-title").textContent = isNew ? "新建自定义成员" : `编辑成员 · ${member.label || member.id}`;
    byId("member-source-kind").textContent = isNew ? "新成员" : member.builtin ? "内置成员" : "自定义成员";
    byId("member-id-value").textContent = isNew ? "保存后生成成员 ID" : member.id;
    byId("member-label-input").value = member.label || "";
    byId("member-short-label-input").value = member.shortLabel || "";
    byId("member-role-input").value = member.role || "";
    byId("member-description-input").value = member.description || "";
    byId("member-default-model-input").value = member.defaultModel || "";
    byId("member-system-prompt-input").value = member.systemPrompt || "";
    renderRuntimeDetails(member, { preferServerEligibility: !isNew });
    byId("member-delete-button").hidden = isNew || member.builtin;
    byId("member-duplicate-button").hidden = isNew;
    byId("member-team-toggle-button").hidden = isNew || member.teamMemberEligible !== true;
    byId("member-open-config-button").disabled = !member.runtimeProfileId;
    byId("member-new-runtime-button").disabled = busy;
    byId("member-open-capabilities-button").disabled = isNew;
    byId("member-reset-label").textContent = member.builtin && !isNew ? "恢复系统默认" : "重置";
    setStatus(isNew ? "尚未保存" : "已保存", isNew ? "warning" : "ok");
    renderUsage(isNew ? null : member);
    renderAvatarSlot(member, { isNew });
    updateCounters();
    renderList();
    updateTeamToggle();
  }

  function renderAvatarSlot(member, { isNew = false } = {}) {
    const preview = byId("member-avatar-preview");
    const hint = byId("member-avatar-hint");
    const upload = byId("member-avatar-upload");
    const reset = byId("member-avatar-reset");
    if (!preview) return;
    const brand = brandFor(member);
    const fallback = typeof cliIconMarkup === "function" ? cliIconMarkup(brand, "cli-logo") : "";
    preview.innerHTML = memberAvatarMarkup(member, {
      className: "avatar-photo",
      iconClass: "cli-logo",
      fallback: fallback || `<span>${escapeHtml(String(member.shortLabel || member.label || "?").slice(0, 2))}</span>`,
    });
    const custom = member?.avatar === "custom";
    if (hint) {
      hint.textContent = isNew
        ? "先保存成员，再更换头像。未设置时默认使用官方 CLI 图标。"
        : custom
          ? "当前使用自定义照片。恢复后回到该成员的官方 CLI 图标。"
          : "默认使用该成员的官方 CLI 图标。可以换成自己的照片。";
    }
    if (upload) upload.disabled = isNew || busy;
    if (reset) reset.hidden = isNew || !custom;
  }

  function blankMember(copy = null) {
    const fallback = runtimeCatalog().find((profile) => profile.teamMemberEligible === true) || {};
    const runtimeProfileId = copy?.runtimeProfileId || fallback.id || "";
    const profile = runtimeProfile(runtimeProfileId);
    return {
      id: null,
      builtin: false,
      label: copy ? `${copy.label || "成员"} 副本` : "",
      shortLabel: copy?.shortLabel || "",
      role: copy?.role || "",
      description: copy?.description || "",
      systemPrompt: copy?.systemPrompt || "",
      capabilities: ["*"],
      runtimeProfileId,
      defaultModel: copy?.defaultModel || profile.defaultModel || profile.model || null,
      defaultEffort: copy?.defaultEffort || profile.defaultEffort || null,
      mainBrainAllowed: copy?.mainBrainAllowed !== false,
      provider: profile.provider || null,
      adapter: profile.adapter || null,
      teamMemberEligible: profile.teamMemberEligible === true,
      coordinatorEligible: profile.coordinatorEligible === true,
    };
  }

  async function canDiscard() {
    if (!dirty) return true;
    return confirmAction({
      eyebrow: "未保存修改",
      title: "放弃当前成员修改？",
      rows: [["成员", draft?.label || source?.label || "新成员"], ["状态", "修改尚未保存"]],
      warning: "切换后无法恢复这份成员草稿。",
      confirmLabel: "放弃修改",
      danger: true,
    });
  }

  async function selectMember(id) {
    if (id === source?.id) return;
    if (!await canDiscard()) return;
    const member = memberById(id);
    if (member) renderEditor(member);
  }

  function collect() {
    return {
      label: byId("member-label-input").value.trim(),
      shortLabel: byId("member-short-label-input").value.trim(),
      role: byId("member-role-input").value.trim(),
      description: byId("member-description-input").value.trim(),
      systemPrompt: byId("member-system-prompt-input").value.trim(),
      capabilities: ["*"],
      runtimeProfileId: byId("member-runtime-profile-select").value,
      defaultModel: byId("member-default-model-input").value.trim() || null,
      defaultEffort: byId("member-default-effort-select").value || null,
      mainBrainAllowed: byId("member-main-brain-input").checked,
    };
  }

  async function refreshCatalog(preferredId = null) {
    const payload = await request(apiPath);
    state.memberCatalog = Array.isArray(payload?.members) ? payload.members : [];
    state.runtimeCatalog = Array.isArray(payload?.runtimeProfiles) ? payload.runtimeProfiles : state.runtimeCatalog;
    state.bootstrap.memberCatalog = state.memberCatalog;
    state.bootstrap.teamCatalog = state.memberCatalog;
    state.bootstrap.runtimeCatalog = state.runtimeCatalog;
    await onCatalogChanged?.(state.memberCatalog);
    if (typeof requestBlob === "function") {
      await hydrateAvatarCatalog(requestBlob, {
        members: state.memberCatalog,
        operatorProfile: state.operatorProfile,
      });
      await onAvatarsChanged?.();
    }
    renderList();
    const next = memberById(preferredId || source?.id);
    if (next) renderEditor(next);
    return next;
  }

  async function save(event) {
    event.preventDefault();
    if (busy || !draft) return;
    const payload = collect();
    if (!payload.label) return toast("成员名称不能为空", "error");
    if (!payload.role) return toast("成员职责不能为空", "error");
    if (!payload.runtimeProfileId) return toast("请选择真实运行席位", "error");
    const wasNew = !source?.id;
    const submissionRevision = revision;
    setBusy(true);
    try {
      const path = source?.id ? `${apiPath}/${encodeURIComponent(source.id)}` : apiPath;
      const saved = await request(path, { method: source?.id ? "PUT" : "POST", body: payload });
      await refreshCatalog(saved.id);
      if (revision === submissionRevision) dirty = false;
      toast(wasNew ? "自定义成员已创建" : "成员已保存", "success");
      // 新建保存成功→通知宿主（团队编排面自动勾入草稿）；目录已在 refreshCatalog 内刷新，宿主读到的必是新列表。
      if (wasNew && saved?.id) onMemberSaved?.(saved.id);
    } catch (error) {
      toast(`成员保存失败：${error.message}`, "error");
      setStatus("保存失败", "error");
    } finally {
      setBusy(false);
      if (!dirty && source) setStatus("已保存", "ok");
    }
  }

  async function remove() {
    if (!source || source.builtin || busy) return;
    const usage = usageOf(source.id);
    const accepted = await confirmAction({
      eyebrow: "删除成员",
      title: `删除成员「${source.label}」？`,
      rows: [
        ["运行席位", source.runtimeProfileId],
        usage.length
          ? ["团队引用", `${usage.length} 个：${usage.map((team) => `${team.name}${team.isCoordinator ? "（主脑）" : ""}`).join("、")}——服务端将阻止删除`]
          : ["团队引用", "无——可安全删除"],
      ],
      warning: usage.length
        ? "该成员仍被团队引用，需先在各团队编排面将其移出后再删除。"
        : "成员配置删除后无法恢复；历史运行快照不受影响。",
      confirmLabel: "删除成员",
      danger: true,
    });
    if (!accepted) return;
    setBusy(true);
    try {
      await request(`${apiPath}/${encodeURIComponent(source.id)}`, { method: "DELETE" });
      const removedLabel = source.label;
      source = null;
      draft = null;
      state.selectedMemberId = null;
      await refreshCatalog();
      byId("member-editor-empty").hidden = false;
      byId("member-editor-body").hidden = true;
      byId("member-editor-actions").hidden = true;
      byId("member-form-title").textContent = "选择成员";
      setStatus("等待选择", "neutral");
      toast(`成员「${removedLabel}」已删除`, "success");
    } catch (error) {
      toast(`成员删除失败：${error.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function resetBuiltin() {
    if (!source?.builtin || busy) return;
    const accepted = await confirmAction({
      eyebrow: "恢复内置成员",
      title: `恢复「${source.label}」的系统默认配置？`,
      rows: [["成员 ID", source.id], ["恢复范围", "身份、席位、能力、模型、推理强度、主脑许可与自定义头像"]],
      warning: "只清除该内置成员的可编辑覆盖，不删除成员，也不修改运行席位本身。",
      confirmLabel: "恢复系统默认",
      danger: false,
    });
    if (!accepted) return;
    setBusy(true);
    try {
      const payload = Object.fromEntries([
        "label", "shortLabel", "role", "description", "systemPrompt", "capabilities",
        "defaultModel", "defaultEffort", "runtimeProfileId", "mainBrainAllowed",
      ].map((key) => [key, null]));
      await request(`${apiPath}/${encodeURIComponent(source.id)}`, { method: "PUT", body: payload });
      if (source.avatar === "custom") {
        await request(`/api/avatars/members/${encodeURIComponent(source.id)}`, { method: "DELETE" });
      }
      dirty = false;
      await refreshCatalog(source.id);
      toast("内置成员已恢复系统默认", "success");
    } catch (error) {
      toast(`恢复系统默认失败：${error.message}`, "error");
      setStatus("恢复失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function uploadAvatar(file) {
    if (!source?.id || busy || typeof request !== "function") return;
    setBusy(true);
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      const saved = await request(`/api/avatars/members/${encodeURIComponent(source.id)}`, {
        method: "POST",
        body: { dataUrl },
      });
      if (typeof requestBlob === "function") await hydrateAvatar(requestBlob, "member", source.id);
      await refreshCatalog(saved?.id || source.id);
      await onAvatarsChanged?.();
      toast("成员头像已更新", "success");
    } catch (error) {
      toast(`头像更新失败：${error.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function resetAvatar() {
    if (!source?.id || source.avatar !== "custom" || busy) return;
    setBusy(true);
    try {
      await request(`/api/avatars/members/${encodeURIComponent(source.id)}`, { method: "DELETE" });
      await refreshCatalog(source.id);
      await onAvatarsChanged?.();
      toast("已恢复官方图标", "success");
    } catch (error) {
      toast(`恢复官方图标失败：${error.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  function updateTeamToggle() {
    const button = byId("member-team-toggle-button");
    if (!button || !source) return;
    const selection = teamMemberState?.(source.id) || { available: false, included: false };
    const included = selection.included === true;
    button.disabled = busy || selection.available !== true;
    byId("member-team-toggle-label").textContent = included ? "从当前团队移除" : "加入当前团队";
    button.dataset.included = included ? "true" : "false";
  }

  const TEAM_SURFACES = ["orchestration", "members", "settings"];

  function setSurface(surface, { focus = true } = {}) {
    const next = TEAM_SURFACES.includes(surface) ? surface : "orchestration";
    state.teamSurface = next;
    document.querySelectorAll("[data-team-surface]").forEach((tab) => {
      const active = tab.dataset.teamSurface === next;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    for (const name of TEAM_SURFACES) {
      const panel = byId(`team-surface-${name}`);
      if (panel) panel.hidden = name !== next;
    }
    byId("team-settings-panel")?.setAttribute("data-active-surface", next);
    if (focus) byId(`team-surface-${next}-tab`)?.focus({ preventScroll: true });
  }

  async function open(memberId = null) {
    setSurface("members", { focus: false });
    const target = memberId ? memberById(memberId) : memberById(state.selectedMemberId) || members()[0];
    if (target && (!dirty || target.id === source?.id || await canDiscard())) renderEditor(target);
    requestAnimationFrame(() => byId("member-library-title")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }

  /** 新建自定义成员草稿（成员库按钮与团队编排面「新建成员」共用入口）。 */
  async function createNew() {
    if (!await canDiscard()) return false;
    const button = byId("member-new-button");
    if (!runtimeCatalog().some((profile) => profile.teamMemberEligible === true)) {
      if (button) button.disabled = true;
      try {
        await refreshCatalog();
      } catch (error) {
        toast(`运行席位读取失败：${error.message}`, "error");
      } finally {
        if (button) button.disabled = false;
      }
    }
    if (!runtimeCatalog().some((profile) => profile.teamMemberEligible === true)) {
      toast("没有可绑定的运行席位", "warning");
      return false;
    }
    setSurface("members", { focus: false });
    renderEditor(blankMember(), { isNew: true });
    requestAnimationFrame(() => byId("member-library-title")?.scrollIntoView({ block: "start", behavior: "smooth" }));
    return true;
  }

  function syncBootstrap() {
    state.memberCatalog = Array.isArray(state.bootstrap?.memberCatalog)
      ? state.bootstrap.memberCatalog
      : Array.isArray(state.bootstrap?.teamCatalog) ? state.bootstrap.teamCatalog : [];
    state.runtimeCatalog = Array.isArray(state.bootstrap?.runtimeCatalog) ? state.bootstrap.runtimeCatalog : [];
    renderList();
    if (source?.id) {
      const fresh = memberById(source.id);
      if (fresh && !dirty && !busy) renderEditor(fresh);
    } else if (draft && !busy) {
      const current = dirty ? { ...draft, ...collect() } : draft;
      if (!current.runtimeProfileId && !dirty && runtimeCatalog().some((profile) => profile.teamMemberEligible === true)) {
        renderEditor(blankMember(), { isNew: true });
      } else {
        draft = { ...draft, ...current };
        renderRuntimeDetails(draft);
        if (!draft.runtimeProfileId) setStatus("请选择运行席位", "warning");
      }
    }
  }

  function init() {
    if (initialized) return;
    initialized = true;
    byId("team-surface-tabs")?.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-team-surface]");
      if (tab) setSurface(tab.dataset.teamSurface);
    });
    byId("team-surface-tabs")?.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const index = TEAM_SURFACES.indexOf(state.teamSurface);
      const dir = event.key === "ArrowRight" ? 1 : -1;
      setSurface(TEAM_SURFACES[(index + dir + TEAM_SURFACES.length) % TEAM_SURFACES.length]);
    });
    byId("member-library-list")?.addEventListener("click", (event) => {
      const item = event.target.closest("[data-member-id]");
      if (item) void selectMember(item.dataset.memberId);
    });
    byId("member-search-input")?.addEventListener("input", (event) => {
      query = event.target.value;
      renderList();
    });
    byId("member-library-filters")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-member-filter]");
      if (!button) return;
      filter = button.dataset.memberFilter;
      byId("member-library-filters").querySelectorAll("button").forEach((item) => {
        const active = item === button;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      renderList();
    });
    byId("member-avatar-upload")?.addEventListener("click", () => {
      if (!source?.id || busy) return;
      byId("member-avatar-file")?.click();
    });
    byId("member-avatar-reset")?.addEventListener("click", () => void resetAvatar());
    byId("member-avatar-file")?.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) void uploadAvatar(file);
    });
    byId("member-new-button")?.addEventListener("click", () => void createNew());
    byId("member-duplicate-button")?.addEventListener("click", async () => {
      if (source && await canDiscard()) renderEditor(blankMember(source), { isNew: true });
    });
    byId("member-delete-button")?.addEventListener("click", () => void remove());
    byId("member-reset-button")?.addEventListener("click", () => {
      if (source?.builtin) void resetBuiltin();
      else if (source) renderEditor(memberById(source.id) || source);
      else renderEditor(blankMember(), { isNew: true });
    });
    byId("member-form")?.addEventListener("submit", (event) => void save(event));
    // 运行席位自定义选择器：触发器开合、搜索过滤（不触 dirty）、键盘导航、点选回写
    byId("member-seat-picker-trigger")?.addEventListener("click", () => {
      const { panel } = seatPickerEls();
      if (panel?.hidden) openSeatPicker();
      else closeSeatPicker({ refocus: true });
    });
    byId("member-seat-picker-trigger")?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeSeatPicker();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openSeatPicker();
        moveSeatPickerActive(event.key === "ArrowDown" ? 1 : -1);
      }
    });
    byId("member-seat-picker-search-input")?.addEventListener("input", (event) => {
      event.stopPropagation(); // 搜索输入不算表单修改
      seatPickerQuery = event.target.value;
      applySeatPickerFilter();
    });
    byId("member-seat-picker-panel")?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSeatPicker({ refocus: true });
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSeatPickerActive(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault(); // 拦隐式表单提交
        const rows = seatPickerRows();
        const target = rows.find((row) => row.classList.contains("is-active")) || rows[0];
        if (target) pickSeatOption(target.dataset.seatId);
      }
    });
    byId("member-seat-picker-options")?.addEventListener("click", (event) => {
      const option = event.target.closest(".member-seat-picker-option");
      if (!option || option.classList.contains("is-disabled")) return;
      pickSeatOption(option.dataset.seatId);
    });
    byId("member-editor-body")?.addEventListener("input", (event) => {
      markDirty();
      if (event.target.id === "member-description-input" || event.target.id === "member-system-prompt-input") updateCounters();
    });
    byId("member-usage-list")?.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-usage-team]");
      if (chip) onOpenTeam?.(chip.dataset.usageTeam);
    });
    byId("member-editor-body")?.addEventListener("change", (event) => {
      markDirty();
      if (event.target.id === "member-runtime-profile-select") {
        const current = collect();
        const profile = runtimeProfile(current.runtimeProfileId);
        const rebound = {
          ...draft,
          ...current,
          runtimeProfileId: current.runtimeProfileId,
          defaultModel: profile.defaultModel ?? profile.model ?? null,
          defaultEffort: profile.defaultEffort ?? null,
          capabilities: [...(profile.capabilities || [])],
          builtin: false,
        };
        draft = rebound;
        byId("member-default-model-input").value = rebound.defaultModel || "";
        renderRuntimeDetails(rebound);
      }
      if (event.target.id === "member-main-brain-input") {
        const current = collect();
        renderRuntimeDetails({ ...draft, ...runtimeProfile(current.runtimeProfileId), ...current });
      }
    });
    byId("member-team-toggle-button")?.addEventListener("click", async () => {
      if (!source) return;
      await onToggleTeamMember?.(source.id, byId("member-team-toggle-button").dataset.included !== "true");
      updateTeamToggle();
    });
    byId("member-open-config-button")?.addEventListener("click", () => onOpenConfig?.({
      surface: "runtime",
      memberId: source?.id || draft?.id || null,
      runtimeProfileId: draft?.runtimeProfileId || null,
    }));
    byId("member-new-runtime-button")?.addEventListener("click", () => onOpenConfig?.({
      surface: "runtime",
      memberId: source?.id || draft?.id || null,
      runtimeProfileId: null,
      create: true,
    }));
    byId("member-open-capabilities-button")?.addEventListener("click", () => onOpenConfig?.({
      surface: "capabilities",
      memberId: source?.id || null,
      runtimeProfileId: draft?.runtimeProfileId || null,
    }));
    syncBootstrap();
    setSurface(state.teamSurface, { focus: false });
  }

  return {
    init,
    open,
    createNew,
    setSurface,
    syncBootstrap,
    refreshCatalog,
    updateTeamToggle,
    refreshUsage: () => { renderList(); renderUsage(source); },
    isDirty: () => dirty,
    isBusy: () => busy,
  };
}
