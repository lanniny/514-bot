import { request } from "../api.js";
import { runStatusText } from "../utils.js";
import { PET_DEFAULTS, PET_MODELS, PET_PRESETS, matchPetPreset } from "../pet/pet-settings.js";

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
};

function button(label, action, className = "button secondary") {
  const node = el("button", label, className);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function lucideIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon lucide");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#lucide-${name}`);
  svg.append(use);
  return svg;
}

function iconForPlugin(id) {
  switch (id) {
    case "desktop-pet": return "sparkles";
    case "project-context": return "brain";
    case "delivery-review": return "shield-check";
    case "project-overview": return "layout-dashboard";
    default: return "puzzle";
  }
}

function dataPanel(data) {
  const node = el("div", null, "plugin-data-panel");
  if (data.title) {
    const fields = el("dl");
    for (const [label, value] of [["项目", data.title], ["工作目录", data.cwd], ["运行记录", data.runCount]]) {
      fields.append(el("dt", label), el("dd", String(value ?? "")));
    }
    node.append(fields);

    if (data.pet) {
      const petBox = el("div", null, "plugin-pet-panel-card");
      petBox.append(el("h4", "桌宠伴侣状态"));
      const petList = el("dl");
      for (const [k, v] of [
        ["模型预设", data.pet.model || "bongo-standard"],
        ["互动模式", data.pet.interactive ? "开启 (可拖拽/戳一戳)" : "穿透模式"],
        ["不透明度", `${data.pet.opacity}%`],
        ["大小缩放", `${data.pet.scale}%`],
        ["Web 浮窗", data.pet.web_dock ? "启用" : "停用"]
      ]) {
        petList.append(el("dt", k), el("dd", v));
      }
      petBox.append(petList);
      node.append(petBox);
    }

    node.append(el("h4", "已启用扩展"));
    const list = el("ul");
    for (const item of data.enabledPlugins || []) list.append(el("li", `${item.name} ${item.version}`));
    node.append(list);
  } else if (Array.isArray(data.runs)) {
    if (!data.runs.length) {
      node.append(el("p", "暂无运行记录"));
    } else {
      const table = el("table");
      const header = el("tr");
      for (const name of ["运行", "状态", "创建时间"]) header.append(el("th", name));
      const head = el("thead");
      head.append(header);
      const body = el("tbody");
      for (const run of data.runs) {
        const row = el("tr");
        for (const value of [run.id.slice(0, 8), runStatusText(run.status), new Date(run.createdAt).toLocaleString()]) {
          row.append(el("td", value));
        }
        body.append(row);
      }
      table.append(head, body);
      node.append(table);
    }
  }
  return node;
}

function selectProject(select, projects, selected) {
  select.replaceChildren();
  const empty = el("option", "选择项目");
  empty.value = "";
  select.append(empty);
  for (const project of projects) {
    const option = el("option", project.title);
    option.value = project.projectId;
    select.append(option);
  }
  select.value = selected;
}

export function createProjectPluginsPanel({ navigate, getContext, appendDraft, confirm }) {
  const root = document.getElementById("view-plugins");
  const output = root.querySelector("[data-plugin-output]");
  const list = root.querySelector("[data-plugin-list]");
  const projectSelect = root.querySelector("[data-plugin-project]");
  const search = root.querySelector("[data-plugin-search]");
  const dialog = document.getElementById("project-plugin-dialog");

  const drawer = root.querySelector("[data-drawer]");
  const drawerBackdrop = root.querySelector("[data-drawer-backdrop]");
  const drawerCloseBtn = root.querySelector("[data-drawer-close]");
  const drawerDoneBtn = root.querySelector("[data-drawer-done]");
  const drawerInstallBtn = root.querySelector("[data-drawer-install]");
  const drawerUninstallBtn = root.querySelector("[data-drawer-uninstall]");

  let snapshot = null;
  let projectsList = [];
  const projectsMap = new Map();
  let generation = 0;
  let busy = false;
  let selected = "";
  let activeTab = "installed";
  let activeCategory = "all";
  let activeDrawerPluginId = null;
  let drawerOpener = null;
  let dialogGeneration = 0;
  let dialogContext = null;
  const configDrafts = new Map();

  function status(message, error = false) {
    output.textContent = message;
    output.classList.toggle("is-error", error);
  }

  function resetPetPreview() {
    window.dispatchEvent(new CustomEvent("514cc:pet-preview", { detail: { reset: true } }));
  }

  function closeDrawer({ restoreFocus = true } = {}) {
    const closingPluginId = activeDrawerPluginId;
    const wasPet = activeDrawerPluginId === "desktop-pet";
    activeDrawerPluginId = null;
    if (drawer) drawer.hidden = true;
    if (drawerBackdrop) drawerBackdrop.hidden = true;
    if (wasPet) resetPetPreview();
    if (restoreFocus) {
      const fallback = closingPluginId
        ? [...(list.querySelector(`[data-plugin-id="${CSS.escape(closingPluginId)}"]`)?.querySelectorAll("button") || [])]
            .find((node) => node.textContent.includes("查看"))
        : null;
      (drawerOpener?.isConnected ? drawerOpener : fallback)?.focus?.({ preventScroll: true });
    }
    drawerOpener = null;
  }

  function openDrawer(item, binding) {
    if (!drawer) return;
    const leavingPet = activeDrawerPluginId === "desktop-pet" && item.id !== "desktop-pet";
    const opening = activeDrawerPluginId !== item.id || drawer.hidden;
    if (opening) drawerOpener = document.activeElement;
    const installedEntry = snapshot.installed.find((entry) => entry.id === item.id);
    const resolvedItem = installedEntry || item;
    const installed = Boolean(installedEntry);
    const currentBinding = snapshot.bindings.find((entry) => entry.pluginId === item.id) || binding;
    activeDrawerPluginId = resolvedItem.id;
    drawer.hidden = false;
    drawer.dataset.pluginKind = resolvedItem.id === "desktop-pet" ? "pet" : "standard";
    if (drawerBackdrop) drawerBackdrop.hidden = false;

    const titleEl = drawer.querySelector("[data-drawer-title]");
    const versionEl = drawer.querySelector("[data-drawer-version]");
    const descEl = drawer.querySelector("[data-drawer-desc]");
    const stateEl = drawer.querySelector("[data-drawer-state]");
    const hintEl = drawer.querySelector("[data-drawer-project-hint]");

    if (titleEl) titleEl.textContent = resolvedItem.manifest.name;
    if (versionEl) versionEl.textContent = resolvedItem.manifest.version;
    if (descEl) descEl.textContent = resolvedItem.manifest.description;
    if (stateEl) {
      stateEl.textContent = !installed ? "未安装" : currentBinding?.enabled ? "当前项目已启用" : "已安装";
      stateEl.dataset.state = !installed ? "available" : currentBinding?.enabled ? "enabled" : "installed";
    }

    const proj = projectsMap.get(selected);
    if (hintEl) {
      hintEl.textContent = !installed
        ? "安装后可配置项目生效范围"
        : selected
          ? `生效项目：${proj?.title || selected}`
          : "请先在工具栏选择配置项目";
    }

    const formContainer = drawer.querySelector("[data-drawer-form-container]");
    if (formContainer) {
      formContainer.replaceChildren(configForm(resolvedItem, currentBinding, { installed }));
      if (resolvedItem.id === "desktop-pet") {
        queueMicrotask(() => window.dispatchEvent(new CustomEvent("514cc:pet-settings-mounted")));
      } else if (leavingPet) {
        resetPetPreview();
      }
    }

    const contribContainer = drawer.querySelector("[data-drawer-contributions]");
    if (contribContainer) {
      contribContainer.replaceChildren();
      for (const [type, label] of [["tools", "工具"], ["workflows", "工作流"], ["panels", "面板"]]) {
        for (const entry of resolvedItem.manifest[type] || []) {
          const chip = el("span", `${label} · ${entry.name}`, "plugin-contribution-tag");
          contribContainer.append(chip);
        }
      }
    }

    const metaContainer = drawer.querySelector("[data-drawer-meta]");
    if (metaContainer) {
      metaContainer.replaceChildren();
      const metaItems = [
        ["插件标识", resolvedItem.id],
        ["协议规范", resolvedItem.manifest.schema],
        ["数字签名", resolvedItem.digest ? `${resolvedItem.digest.slice(0, 16)}...` : "系统内置官方源"],
        ["安装时间", resolvedItem.installedAt ? new Date(resolvedItem.installedAt).toLocaleString() : "尚未安装"]
      ];
      for (const [k, v] of metaItems) {
        metaContainer.append(el("dt", k), el("dd", v));
      }
    }

    if (drawerInstallBtn) {
      drawerInstallBtn.hidden = installed;
      drawerInstallBtn.disabled = busy || installed;
      drawerInstallBtn.onclick = () => void mutate("install", { catalogId: resolvedItem.id });
    }
    if (drawerUninstallBtn) {
      drawerUninstallBtn.hidden = !installed;
      drawerUninstallBtn.disabled = busy || !installed;
      drawerUninstallBtn.onclick = async () => {
        if (await confirm(`卸载 ${resolvedItem.manifest.name}`, "卸载会移除该插件及已停用的项目配置。")) {
          closeDrawer();
          void mutate("remove", { pluginId: resolvedItem.id });
        }
      };
    }
    if (opening) queueMicrotask(() => drawerCloseBtn?.focus({ preventScroll: true }));
  }

  async function load({ projectId } = {}) {
    const ticket = ++generation;
    snapshot = null;
    if (projectId !== undefined) selected = projectId || "";
    list.replaceChildren(el("p", "正在读取插件…", "plugin-empty"));
    try {
      const [data, projectData] = await Promise.all([
        request(`/api/plugins${selected ? `?projectId=${encodeURIComponent(selected)}` : ""}`),
        request("/api/projects?includeArchived=1")
      ]);
      if (ticket !== generation) return false;
      snapshot = data;
      projectsList = projectData.projects || [];
      projectsMap.clear();
      for (const p of projectsList) projectsMap.set(p.projectId, p);
      selectProject(projectSelect, projectsList, selected);
      status("");
      render();
      window.dispatchEvent(new CustomEvent("514cc:plugin-snapshot", { detail: { snapshot, projectId: selected } }));
      return true;
    } catch (error) {
      if (ticket === generation) {
        list.replaceChildren();
        status(error.message, true);
      }
      return false;
    } finally {
      projectSelect.disabled = busy;
    }
  }

  async function mutate(action, payload) {
    if (busy || !snapshot) return;
    const active = document.activeElement;
    const focus = active?.closest("[data-plugin-id]")
      ? { pluginId: active.closest("[data-plugin-id]").dataset.pluginId, name: active.name, label: active.getAttribute("aria-label"), text: active.textContent }
      : null;
    const drawerFocus = active?.closest("[data-drawer]") && activeDrawerPluginId
      ? { pluginId: activeDrawerPluginId, name: active.name, label: active.getAttribute("aria-label"), text: active.textContent }
      : null;
    const owner = selected;
    busy = true;
    status("正在保存…");
    render();
    try {
      await request(`/api/plugins/${action}`, { method: "POST", body: { ...payload, expectedRevision: snapshot.revision } });
      const eventPayload = action === "configure" && payload.pluginId === "desktop-pet"
        ? { ...payload, config: { ...payload.config, enabled: payload.enabled } }
        : payload;
      const draftKey = JSON.stringify([payload.projectId, payload.pluginId]);
      if (action === "configure") {
        const draft = configDrafts.get(draftKey);
        const draftConfig = draft && Object.fromEntries(Object.entries(draft).filter(([key]) => key !== "__enabled"));
        if (draftConfig && JSON.stringify(draftConfig) === JSON.stringify(payload.config)
            && (draft.__enabled === undefined || draft.__enabled === payload.enabled)) {
          configDrafts.delete(draftKey);
        }
      }
      window.dispatchEvent(new CustomEvent("514cc:plugin-changed", { detail: { action, payload: eventPayload } }));
      const loaded = await load();
      if (loaded) status("已保存");
      else status("配置已保存，但列表刷新失败。请刷新后查看。", true);
    } catch (error) {
      status(error.message, true);
    } finally {
      busy = false;
      projectSelect.disabled = false;
      render();
      if (drawerFocus && owner === selected && activeDrawerPluginId === drawerFocus.pluginId && [document.body, null].includes(document.activeElement)) {
        const target = [...drawer.querySelectorAll("input, select, button")].find((node) =>
          drawerFocus.name ? node.name === drawerFocus.name : drawerFocus.label ? node.getAttribute("aria-label") === drawerFocus.label : node.textContent === drawerFocus.text
        );
        target?.focus({ preventScroll: true });
      } else if (focus && owner === selected && [document.body, null].includes(document.activeElement)) {
        const row = list.querySelector(`[data-plugin-id="${CSS.escape(focus.pluginId)}"]`);
        const target = [...(row?.querySelectorAll("input, select, button") || [])].find((node) =>
          focus.name ? node.name === focus.name : focus.label ? node.getAttribute("aria-label") === focus.label : node.textContent === focus.text
        );
        target?.focus({ preventScroll: true });
      }
    }
  }

  function petConfigForm(item, binding, { installed }) {
    const form = el("form", null, "plugin-config-form pet-plugin-config");
    const inputs = new Map();
    const draftKey = JSON.stringify([selected, item.id]);
    const draft = configDrafts.get(draftKey);
    const defaults = Object.fromEntries(item.manifest.settings.map((field) => [field.id, field.default]));
    const initial = { ...defaults, ...(binding?.config || {}), ...(draft || {}) };
    initial.enabled = draft?.enabled ?? (binding?.enabled === true);
    const canEdit = installed && Boolean(selected) && !busy;
    const pending = el("span", draft ? "未保存修改" : "", "plugin-state");

    const statusBand = el("div", null, "pet-settings-status");
    const statusGlyph = el("span", null, "pet-settings-status-glyph");
    statusGlyph.setAttribute("aria-hidden", "true");
    statusGlyph.append(lucideIcon("bot"));
    const statusCopy = el("div", null, "pet-settings-state-copy");
    statusCopy.setAttribute("role", "status");
    statusCopy.setAttribute("aria-live", "polite");
    const statusTitle = el("strong");
    const statusMeta = el("span");
    statusCopy.append(statusTitle, statusMeta);
    const master = el("label", null, "pet-switch pet-master-switch");
    master.append(el("span", "在当前项目启用桌宠", "sr-only"));
    const masterInput = el("input");
    masterInput.type = "checkbox";
    masterInput.name = "enabled";
    masterInput.checked = Boolean(initial.enabled);
    masterInput.disabled = !canEdit;
    master.append(masterInput, el("span", null, "pet-switch-track"));
    inputs.set("enabled", masterInput);
    statusBand.append(statusGlyph, statusCopy, master);
    form.append(statusBand);

    const modelSection = el("section", null, "pet-settings-section");
    const modelHead = el("div", null, "pet-settings-section-head");
    modelHead.append(el("h4", "模型模式"));
    const modelSelect = el("select");
    modelSelect.name = "model";
    modelSelect.setAttribute("aria-label", "模型模式");
    for (const [value, model] of Object.entries(PET_MODELS)) {
      const option = el("option", model.label);
      option.value = value;
      modelSelect.append(option);
    }
    modelSelect.value = initial.model;
    modelSelect.disabled = !canEdit;
    inputs.set("model", modelSelect);
    const modelControl = el("label", null, "pet-model-control");
    modelControl.append(lucideIcon("image"), modelSelect);
    const fpsSelect = el("select");
    fpsSelect.name = "max-fps";
    fpsSelect.setAttribute("aria-label", "最大帧率");
    for (const value of ["30", "60", "120"]) {
      const option = el("option", `${value} FPS`);
      option.value = value;
      fpsSelect.append(option);
    }
    fpsSelect.value = String(initial["max-fps"]);
    fpsSelect.disabled = !canEdit;
    inputs.set("max-fps", fpsSelect);
    const fpsControl = el("label", null, "pet-model-control");
    fpsControl.append(lucideIcon("gauge"), fpsSelect);
    const renderGrid = el("div", null, "pet-render-grid");
    renderGrid.append(modelControl, fpsControl);
    modelSection.append(modelHead, renderGrid);
    form.append(modelSection);

    const preview = el("div", null, "pet-settings-preview");
    preview.id = "plugin-pet-preview";
    preview.setAttribute("aria-label", "桌宠实时预览");
    preview.hidden = typeof window.__TAURI_INTERNALS__?.invoke === "function";
    const previewHead = el("div", null, "pet-settings-preview-head");
    previewHead.append(el("span", "实时预览"), el("small", "Live2D 桌宠"));
    const previewSlot = el("div");
    previewSlot.dataset.petPreviewSlot = "";
    preview.append(previewHead, previewSlot);
    form.append(preview);

    const presetSection = el("section", null, "pet-settings-section");
    const presetHead = el("div", null, "pet-settings-section-head");
    presetHead.append(el("h4", "陪伴强度"));
    const presetOut = el("output", "自定义");
    presetHead.append(presetOut);
    const presetControl = el("div", null, "pet-preset-control");
    presetControl.setAttribute("role", "group");
    presetControl.setAttribute("aria-label", "桌宠陪伴强度");
    const presetButtons = new Map();
    for (const [name, label, icon] of [["quiet", "安静", "moon"], ["companion", "日常", "gauge"], ["lively", "活力", "sparkles"]]) {
      const presetButton = button(label, () => {}, "");
      presetButton.dataset.petPreset = name;
      presetButton.setAttribute("aria-pressed", "false");
      presetButton.replaceChildren(lucideIcon(icon), el("span", label));
      presetButton.disabled = !canEdit;
      presetButtons.set(name, presetButton);
      presetControl.append(presetButton);
    }
    presetSection.append(presetHead, presetControl);
    form.append(presetSection);

    const displaySection = el("section", null, "pet-settings-section");
    const displayHead = el("div", null, "pet-settings-section-head");
    displayHead.append(el("h4", "显示"));
    const rangeGrid = el("div", null, "pet-range-grid");
    const rangeOutputs = new Map();
    for (const [id, labelText, min, max, step, low, high] of [
      ["opacity", "不透明度", 30, 100, 5, "轻", "清晰"],
      ["scale", "大小", 60, 180, 10, "紧凑", "醒目"],
    ]) {
      const label = el("label", null, "pet-range-control");
      const heading = el("span");
      const output = el("output", `${initial[id]}%`);
      heading.append(el("b", labelText), output);
      const input = el("input");
      input.type = "range";
      input.name = id;
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(initial[id]);
      input.disabled = !canEdit;
      const limits = el("small");
      limits.append(el("span", low), el("span", high));
      label.append(heading, input, limits);
      inputs.set(id, input);
      rangeOutputs.set(id, output);
      rangeGrid.append(label);
    }
    displaySection.append(displayHead, rangeGrid);
    form.append(displaySection);

    const behaviorSection = el("section", null, "pet-settings-section");
    const behaviorHead = el("div", null, "pet-settings-section-head");
    behaviorHead.append(el("h4", "互动与反馈"));
    const toggleGrid = el("div", null, "pet-toggle-grid");
    for (const [id, labelText, icon] of [
      ["mouse-tracking", "指针追踪", "eye"],
      ["lightning-combo", "连击闪电", "zap"],
      ["sound", "敲击与庆祝音效", "waves"],
      ["interactive", "互动模式", "fingerprint"],
      ["web-dock", "网页挂件", "monitor"],
      ["model-mirror", "模型镜像", "repeat"],
      ["pointer-mirror", "指针镜像", "radar"],
      ["random-expression", "随机表情", "sparkles"],
    ]) {
      const label = el("label", null, "pet-toggle-row");
      label.append(lucideIcon(icon), el("span", labelText));
      const input = el("input");
      input.type = "checkbox";
      input.name = id;
      input.checked = Boolean(initial[id]);
      input.disabled = !canEdit;
      label.append(input, el("span", null, "pet-switch-track"));
      inputs.set(id, input);
      toggleGrid.append(label);
    }
    behaviorSection.append(behaviorHead, toggleGrid);
    form.append(behaviorSection);

    const collect = () => Object.fromEntries(item.manifest.settings.map((field) => {
      const input = inputs.get(field.id);
      return [field.id, field.type === "boolean" ? input.checked : field.type === "number" ? Number(input.value) : input.value];
    }));
    const renderState = () => {
      const config = collect();
      const preset = matchPetPreset({
        opacity: config.opacity / 100,
        scale: config.scale / 100,
        mouseTracking: config["mouse-tracking"],
        lightningCombo: config["lightning-combo"],
        sound: config.sound,
      });
      const labels = { quiet: "安静", companion: "日常", lively: "活力", custom: "自定义" };
      presetOut.textContent = labels[preset];
      for (const [name, presetButton] of presetButtons) presetButton.setAttribute("aria-pressed", String(name === preset));
      for (const [id, output] of rangeOutputs) output.textContent = `${inputs.get(id).value}%`;
      statusTitle.textContent = !installed ? "安装后可使用" : !selected ? "选择项目后配置" : config.enabled ? "桌宠将在当前项目启用" : "桌宠在当前项目停用";
      statusMeta.textContent = installed ? "配置保存后同步到桌宠运行时" : "桌宠资源包尚未安装";
      window.dispatchEvent(new CustomEvent("514cc:pet-preview", { detail: { config } }));
    };
    const preserve = () => {
      const values = collect();
      configDrafts.set(draftKey, values);
      pending.textContent = "未保存修改";
      renderState();
    };
    for (const input of inputs.values()) {
      input.addEventListener("input", preserve);
      input.addEventListener("change", preserve);
    }
    for (const [name, presetButton] of presetButtons) {
      presetButton.onclick = () => {
        const preset = PET_PRESETS[name];
        inputs.get("opacity").value = String(Math.round(preset.opacity * 100));
        inputs.get("scale").value = String(Math.round(preset.scale * 100));
        inputs.get("mouse-tracking").checked = preset.mouseTracking;
        inputs.get("lightning-combo").checked = preset.lightningCombo;
        inputs.get("sound").checked = preset.sound;
        preserve();
      };
    }

    const actions = el("div", null, "pet-settings-actions");
    const poke = button("戳一戳", () => window.dispatchEvent(new CustomEvent("514cc:pet-preview", { detail: { action: "poke" } })));
    poke.prepend(lucideIcon("heart-pulse"));
    poke.disabled = !installed || binding?.enabled !== true;
    const reset = button("恢复默认", () => {
      for (const [key, value] of Object.entries(PET_DEFAULTS)) {
        const fieldId = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        const input = inputs.get(fieldId);
        if (!input) continue;
        if (input.type === "checkbox") input.checked = value;
        else if (input.type === "range") input.value = String(Math.round(value * 100));
        else input.value = String(value);
      }
      preserve();
    }, "bot-text-button");
    reset.prepend(lucideIcon("rotate-ccw"));
    reset.disabled = !canEdit;
    const save = button("保存并应用", () => {}, "button primary");
    save.type = "submit";
    save.prepend(lucideIcon("save"));
    save.disabled = !canEdit;
    actions.append(poke, reset, save, pending);
    form.append(actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const config = collect();
      void mutate("configure", { projectId: selected, pluginId: item.id, enabled: config.enabled, config });
    });
    renderState();
    return form;
  }

  function configForm(item, binding, { installed }) {
    if (item.id === "desktop-pet") return petConfigForm(item, binding, { installed });
    const form = el("form", null, "plugin-config-form");
    const inputs = new Map();
    const draftKey = JSON.stringify([selected, item.id]);
    const draft = configDrafts.get(draftKey);
    const canEdit = installed && Boolean(selected) && !busy;
    const pending = el("span", draft ? "未保存修改" : "", "plugin-state");
    const enabledField = el("label", null, "plugin-enable-field");
    const enabledInput = el("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = draft?.__enabled ?? binding?.enabled === true;
    enabledInput.disabled = !canEdit;
    enabledField.append(enabledInput, el("span", "在当前项目启用"));
    form.append(enabledField);

    for (const field of item.manifest.settings) {
      const label = el("label", null, "plugin-field");
      label.append(el("span", field.label));
      let input;
      if (field.type === "select") {
        input = el("select");
        for (const value of field.options) {
          const option = el("option", value);
          option.value = value;
          input.append(option);
        }
      } else {
        input = el("input");
        input.type = field.type === "boolean" ? "checkbox" : field.type === "number" ? "number" : "text";
        if (field.type === "string") input.maxLength = 2000;
      }
      const value = draft?.[field.id] ?? binding?.config[field.id] ?? field.default;
      if (field.type === "boolean") input.checked = value;
      else input.value = value;
      input.name = field.id;
      input.disabled = !canEdit;
      label.append(input);
      form.append(label);
      inputs.set(field.id, input);
    }

    const collect = () => Object.fromEntries(item.manifest.settings.map((field) => {
      const input = inputs.get(field.id);
      return [field.id, field.type === "boolean" ? input.checked : field.type === "number" ? Number(input.value) : input.value];
    }));
    const preserve = () => {
      configDrafts.set(draftKey, { ...collect(), __enabled: enabledInput.checked });
      pending.textContent = "未保存修改";
    };
    enabledInput.addEventListener("change", preserve);
    for (const input of inputs.values()) {
      input.addEventListener("input", preserve);
      input.addEventListener("change", preserve);
    }
    const actions = el("div", null, "plugin-form-actions");
    const save = button("保存并应用", () => {}, "button primary");
    save.type = "submit";
    save.disabled = !canEdit;
    actions.append(save, pending);
    form.append(actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void mutate("configure", { projectId: selected, pluginId: item.id, enabled: enabledInput.checked, config: collect() });
    });
    return form;
  }

  function matchesCategory(item, category) {
    if (category === "all") return true;
    if (category === "workflow") return (item.manifest.workflows?.length || 0) > 0;
    if (category === "panel") return (item.manifest.panels?.length || 0) > 0;
    if (category === "pet") return item.id === "desktop-pet" || item.manifest.name.includes("宠") || item.manifest.description.includes("Live2D");
    return true;
  }

  function updateMetrics(installed, catalog, bindings) {
    const statInstalled = root.querySelector("[data-stat-installed]");
    const statEnabled = root.querySelector("[data-stat-enabled]");
    const statExtensions = root.querySelector("[data-stat-extensions]");
    const statPet = root.querySelector("[data-stat-pet]");
    const statProjectDesc = root.querySelector("[data-stat-project-desc]");
    const tabInstalledBadge = root.querySelector("[data-tab-installed-count]");
    const tabCatalogBadge = root.querySelector("[data-tab-catalog-count]");

    if (tabInstalledBadge) tabInstalledBadge.textContent = String(installed.length);
    if (tabCatalogBadge) tabCatalogBadge.textContent = String(catalog.length);
    if (statInstalled) statInstalled.textContent = `${installed.length} 项`;

    const enabledCount = bindings.filter((b) => b.enabled).length;
    if (statEnabled) statEnabled.textContent = `${enabledCount} 项`;
    if (statProjectDesc) {
      const proj = projectsMap.get(selected);
      statProjectDesc.textContent = proj ? `当前项目：${proj.title}` : "请在工具栏选择项目";
    }

    let extCount = 0;
    for (const item of installed) {
      extCount += (item.manifest.tools?.length || 0) + (item.manifest.workflows?.length || 0) + (item.manifest.panels?.length || 0);
    }
    if (statExtensions) statExtensions.textContent = `${extCount} 种`;

    if (statPet) {
      const petInstalled = installed.some((entry) => entry.id === "desktop-pet");
      const petEnabled = bindings.some((entry) => entry.pluginId === "desktop-pet" && entry.enabled);
      statPet.textContent = petEnabled ? "活跃运行" : petInstalled ? "已安装" : "未安装";
      const petDesc = root.querySelector("[data-stat-pet-desc]");
      if (petDesc) petDesc.textContent = petEnabled ? "小猫正在随敲击与任务起舞" : petInstalled ? "在当前项目开启即可唤醒" : "从发现插件安装后使用";
    }
  }

  function render() {
    if (!snapshot) return;
    projectSelect.disabled = busy;
    const query = search.value.trim().toLowerCase();
    list.replaceChildren();

    root.querySelectorAll("[data-plugin-tab]").forEach((tab) => {
      const active = tab.dataset.pluginTab === activeTab;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    list.setAttribute("aria-labelledby", `plugin-tab-${activeTab}`);

    updateMetrics(snapshot.installed, snapshot.catalog, snapshot.bindings);

    const items = activeTab === "catalog"
      ? snapshot.catalog.map((manifest) => ({ id: manifest.id, manifest }))
      : snapshot.installed;

    const filtered = items.filter((entry) => {
      const textMatch = `${entry.manifest.name} ${entry.manifest.description} ${entry.id}`.toLowerCase().includes(query);
      const catMatch = matchesCategory(entry, activeCategory);
      return textMatch && catMatch;
    });

    for (const item of filtered) {
      const manifest = item.manifest;
      const card = el("article", null, "plugin-card");
      card.dataset.pluginId = item.id;

      // Card Header
      const header = el("header", null, "plugin-card-header");
      const iconWrap = el("div", null, "plugin-icon-wrap");
      iconWrap.append(lucideIcon(iconForPlugin(item.id)));

      const titleGroup = el("div", null, "plugin-card-title-group");
      const titleRow = el("div", null, "plugin-card-title-row");
      const h3 = el("h3", manifest.name);
      const versionPill = el("span", `v${manifest.version}`, "plugin-version-pill");
      titleRow.append(h3, versionPill);

      const metaRow = el("div", null, "plugin-card-meta-row");
      const badge = el("span", item.id === "desktop-pet" ? "Live2D 萌宠" : "官方内置", "plugin-scope-badge");
      metaRow.append(badge);

      titleGroup.append(titleRow, metaRow);
      header.append(iconWrap, titleGroup);
      card.append(header);

      // Card Body
      const desc = el("p", manifest.description, "plugin-card-desc");
      card.append(desc);

      // Contributions Tag Chips
      const contributions = el("div", null, "plugin-contributions");
      for (const [type, label] of [["tools", "工具"], ["workflows", "工作流"], ["panels", "面板"]]) {
        if (manifest[type]?.length) {
          contributions.append(el("span", `${label} ${manifest[type].length}`, "plugin-chip-mini"));
        }
      }
      contributions.append(el("span", "项目范围", "plugin-chip-mini is-muted"));
      card.append(contributions);

      // Card Footer / Actions
      const footer = el("footer", null, "plugin-card-footer");
      const actions = el("div", null, "plugin-card-actions");
      const installed = snapshot.installed.some((entry) => entry.id === item.id);
      const binding = snapshot.bindings.find((entry) => entry.pluginId === item.id);
      const detailsBtn = button(installed && selected ? "查看与配置" : "查看详情", () => openDrawer(item, binding), "button secondary");
      detailsBtn.disabled = busy;

      if (!installed) {
        const installBtn = button("安装插件", () => void mutate("install", { catalogId: item.id }), "button primary");
        installBtn.disabled = busy;
        actions.append(detailsBtn, installBtn);
      } else if (activeTab === "catalog") {
        actions.append(el("span", "已安装", "plugin-state-installed"), detailsBtn);
      } else {
        const toggle = el("label", null, "plugin-toggle");
        const input = el("input");
        input.type = "checkbox";
        input.checked = binding?.enabled === true;
        input.disabled = busy || !selected;
        input.setAttribute("aria-label", `在当前项目启用 ${manifest.name}`);
        input.addEventListener("change", () => {
          void mutate("configure", { projectId: selected, pluginId: item.id, enabled: input.checked, config: binding?.config || {} });
        });
        toggle.append(input, el("span", binding?.enabled ? "已在当前项目启用" : "未启用"));

        actions.append(toggle, detailsBtn);
      }

      footer.append(actions);
      card.append(footer);

      // 如果当前抽屉打开的就是这个插件，保持抽屉内容同步
      if (activeDrawerPluginId === item.id) {
        openDrawer(item, binding);
      }

      list.append(card);
    }

    if (!list.childElementCount) {
      list.append(el("p", query ? "没有找到符合条件的插件" : activeTab === "installed" ? "暂无已安装插件，可在「发现插件」中挑选安装" : "暂无可用插件", "plugin-empty"));
    }
  }

  function close() {
    dialogGeneration += 1;
    dialogContext = null;
    dialog.close();
  }

  async function open(context = getContext()) {
    if (!context?.projectId) {
      navigate("plugins");
      void load();
      return;
    }
    dialogContext = { ...context };
    const ticket = ++dialogGeneration;
    const content = dialog.querySelector("[data-plugin-workspace]");
    content.replaceChildren(el("p", "正在读取项目扩展…"));
    dialog.querySelector("[data-plugin-dialog-status]").textContent = "";
    if (!dialog.open) dialog.showModal();

    try {
      const data = await request(`/api/plugins?projectId=${encodeURIComponent(context.projectId)}`);
      if (ticket !== dialogGeneration || !dialog.open) return;
      content.replaceChildren();

      for (const binding of data.bindings.filter((entry) => entry.enabled)) {
        const item = data.installed.find((entry) => entry.id === binding.pluginId);
        if (!item) continue;
        const section = el("section", null, "plugin-workspace-section");
        section.append(el("h3", item.manifest.name));

        for (const type of ["tools", "workflows", "panels"]) {
          for (const contribution of item.manifest[type] || []) {
            const resultArea = el("div", null, "plugin-result");
            const action = button(contribution.name, async () => {
              action.disabled = true;
              try {
                const result = await request("/api/plugins/execute", {
                  method: "POST",
                  body: { projectId: context.projectId, pluginId: item.id, contributionId: contribution.id, type }
                });
                if (ticket !== dialogGeneration || !dialog.open) return;
                resultArea.replaceChildren();
                if (result.prompt) {
                  appendDraft(context, result.prompt);
                  close();
                  return;
                }
                const pre = el("pre", JSON.stringify(result.data, null, 2));
                resultArea.append(dataPanel(result.data));
                if (type === "tools") {
                  const details = el("details", null, "plugin-details");
                  details.append(el("summary", "原始数据"), pre);
                  resultArea.append(details);
                }
                if (type === "tools" && context.conversationId) {
                  resultArea.append(
                    button("加入对话", () => {
                      try {
                        appendDraft(context, `${result.name}\n${pre.textContent}`);
                        close();
                      } catch (error) {
                        dialog.querySelector("[data-plugin-dialog-status]").textContent = error.message;
                      }
                    })
                  );
                }
                resultArea.append(el("small", `${result.version} · ${new Date(result.at).toLocaleTimeString()}`));
              } catch (error) {
                if (ticket === dialogGeneration) dialog.querySelector("[data-plugin-dialog-status]").textContent = error.message;
              } finally {
                action.disabled = false;
              }
            });
            section.append(action, resultArea);
          }
        }
        content.append(section);
      }
      if (!content.childElementCount) content.append(el("p", "当前项目尚未启用任何插件。请在插件中心为该项目启用扩展。"));
    } catch (error) {
      if (ticket === dialogGeneration) content.replaceChildren(el("p", error.message));
    }
  }

  // 事件绑定
  projectSelect.addEventListener("change", () => {
    if (!busy) void load({ projectId: projectSelect.value });
  });

  search.addEventListener("input", render);

  root.querySelectorAll("[data-plugin-tab]").forEach((tab) =>
    tab.addEventListener("click", () => {
      activeTab = tab.dataset.pluginTab;
      render();
    })
  );

  root.querySelector("[role=tablist]").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    activeTab = event.key === "Home" ? "installed" : event.key === "End" ? "catalog" : activeTab === "installed" ? "catalog" : "installed";
    render();
    root.querySelector(`[data-plugin-tab="${activeTab}"]`).focus();
  });

  root.querySelectorAll("[data-plugin-category]").forEach((chip) => {
    chip.addEventListener("click", () => {
      activeCategory = chip.dataset.pluginCategory;
      root.querySelectorAll("[data-plugin-category]").forEach((c) => c.classList.toggle("is-active", c === chip));
      render();
    });
  });

  root.querySelector("[data-plugin-refresh]").addEventListener("click", () => void load());

  const file = root.querySelector("[data-plugin-file]");
  root.querySelector("[data-plugin-import]").addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const source = file.files[0];
    file.value = "";
    if (!source) return;
    try {
      if (source.size > 128 * 1024) throw new Error("插件包不能超过 128 KB");
      const manifest = JSON.parse(await source.text());
      if (await confirm(`安装 ${manifest.name || "插件"}`, "该包可提供项目上下文工具、工作流与数据面板，安装后需要按项目启用。")) {
        await mutate("install", { manifest });
      }
    } catch (error) {
      status(error.message, true);
    }
  });

  if (drawerCloseBtn) drawerCloseBtn.addEventListener("click", closeDrawer);
  if (drawerDoneBtn) drawerDoneBtn.addEventListener("click", closeDrawer);
  if (drawerBackdrop) drawerBackdrop.addEventListener("click", closeDrawer);
  window.addEventListener("514cc:pet-runtime-status", (event) => {
    if (activeDrawerPluginId !== "desktop-pet") return;
    const message = String(event.detail?.error || "");
    if (message) status(message, true);
  });
  document.addEventListener("keydown", (event) => {
    if (!drawer || drawer.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (event.key === "Tab") {
      const focusable = [...drawer.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((node) => !node.hidden && node.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  dialog.querySelector("[data-plugin-close]").addEventListener("click", close);
  dialog.addEventListener("cancel", () => {
    dialogGeneration += 1;
    dialogContext = null;
  });
  dialog.querySelector("[data-plugin-manage]").addEventListener("click", () => {
    const context = dialogContext;
    close();
    navigate("plugins");
    void load({ projectId: context?.projectId || "" });
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-project-plugins]")) void open();
  });

  return {
    load,
    open,
    close,
    deactivate() {
      generation += 1;
      close();
      closeDrawer({ restoreFocus: false });
    },
    get projectId() {
      return selected;
    }
  };
}
