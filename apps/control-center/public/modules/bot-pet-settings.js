/**
 * bot-pet-settings.js — Bot 设置里的桌宠页。复用插件 configure API，不经过协作台。
 */
import { PET_DEFAULTS, PET_MODELS, PET_PRESETS, matchPetPreset } from "../pet/pet-settings.js";

function writeMarkup(node, html) {
  if (!node) return;
  node.replaceChildren();
  if (!html || typeof document === "undefined") return;
  const holder = document.createElement("div");
  holder.insertAdjacentHTML("afterbegin", html);
  node.append(...holder.childNodes);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function petConfigFromBinding(binding) {
  const raw = binding?.config && typeof binding.config === "object" ? binding.config : {};
  const numberOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    enabled: binding?.enabled === true,
    model: PET_MODELS[raw.model] ? raw.model : PET_DEFAULTS.model,
    "max-fps": String(raw["max-fps"] || PET_DEFAULTS.maxFps),
    opacity: numberOr(raw.opacity, Math.round(PET_DEFAULTS.opacity * 100)),
    scale: numberOr(raw.scale, Math.round(PET_DEFAULTS.scale * 100)),
    "mouse-tracking": raw["mouse-tracking"] ?? PET_DEFAULTS.mouseTracking,
    "lightning-combo": raw["lightning-combo"] ?? PET_DEFAULTS.lightningCombo,
    sound: raw.sound ?? PET_DEFAULTS.sound,
    interactive: raw.interactive ?? PET_DEFAULTS.interactive,
    "web-dock": raw["web-dock"] ?? PET_DEFAULTS.webDock,
    "model-mirror": raw["model-mirror"] ?? PET_DEFAULTS.modelMirror,
    "pointer-mirror": raw["pointer-mirror"] ?? PET_DEFAULTS.pointerMirror,
    "random-expression": raw["random-expression"] ?? PET_DEFAULTS.randomExpression,
  };
}

export function defaultPetConfig() {
  return {
    enabled: false,
    model: PET_DEFAULTS.model,
    "max-fps": PET_DEFAULTS.maxFps,
    opacity: Math.round(PET_DEFAULTS.opacity * 100),
    scale: Math.round(PET_DEFAULTS.scale * 100),
    "mouse-tracking": PET_DEFAULTS.mouseTracking,
    "lightning-combo": PET_DEFAULTS.lightningCombo,
    sound: PET_DEFAULTS.sound,
    interactive: PET_DEFAULTS.interactive,
    "web-dock": PET_DEFAULTS.webDock,
    "model-mirror": PET_DEFAULTS.modelMirror,
    "pointer-mirror": PET_DEFAULTS.pointerMirror,
    "random-expression": PET_DEFAULTS.randomExpression,
  };
}

export function applyPetPresetToConfig(config, name) {
  const preset = PET_PRESETS[name];
  if (!preset) return { ...config };
  return {
    ...config,
    opacity: Math.round(preset.opacity * 100),
    scale: Math.round(preset.scale * 100),
    "mouse-tracking": preset.mouseTracking,
    "lightning-combo": preset.lightningCombo,
    sound: preset.sound,
  };
}

export function readPetForm(form) {
  if (!form) return defaultPetConfig();
  const value = (name, fallback) => form.elements.namedItem(name)?.value ?? fallback;
  const checked = (name, fallback) => {
    const input = form.elements.namedItem(name);
    return input ? Boolean(input.checked) : fallback;
  };
  return {
    enabled: checked("enabled", false),
    model: value("model", PET_DEFAULTS.model),
    "max-fps": value("max-fps", PET_DEFAULTS.maxFps),
    opacity: Number(value("opacity", Math.round(PET_DEFAULTS.opacity * 100))),
    scale: Number(value("scale", Math.round(PET_DEFAULTS.scale * 100))),
    "mouse-tracking": checked("mouse-tracking", PET_DEFAULTS.mouseTracking),
    "lightning-combo": checked("lightning-combo", PET_DEFAULTS.lightningCombo),
    sound: checked("sound", PET_DEFAULTS.sound),
    interactive: checked("interactive", PET_DEFAULTS.interactive),
    "web-dock": checked("web-dock", PET_DEFAULTS.webDock),
    "model-mirror": checked("model-mirror", PET_DEFAULTS.modelMirror),
    "pointer-mirror": checked("pointer-mirror", PET_DEFAULTS.pointerMirror),
    "random-expression": checked("random-expression", PET_DEFAULTS.randomExpression),
  };
}

export function petFormMarkup(config, { canEdit, projectOptions, selectedProjectId, installed }) {
  const preset = matchPetPreset({
    opacity: config.opacity / 100,
    scale: config.scale / 100,
    mouseTracking: config["mouse-tracking"],
    lightningCombo: config["lightning-combo"],
    sound: config.sound,
  });
  const disabled = canEdit ? "" : " disabled";
  const projects = (projectOptions || []).map((project) => (
    `<option value="${escapeHtml(project.id)}"${project.id === selectedProjectId ? " selected" : ""}>${escapeHtml(project.label)}</option>`
  )).join("");
  const models = Object.entries(PET_MODELS).map(([id, model]) => (
    `<option value="${escapeHtml(id)}"${id === config.model ? " selected" : ""}>${escapeHtml(model.label)}</option>`
  )).join("");
  const toggles = [
    ["mouse-tracking", "指针追踪"],
    ["lightning-combo", "连击闪电"],
    ["sound", "敲击与庆祝音效"],
    ["interactive", "互动模式"],
    ["web-dock", "网页挂件"],
    ["model-mirror", "模型镜像"],
    ["pointer-mirror", "指针镜像"],
    ["random-expression", "随机表情"],
  ].map(([id, label]) => (
    `<label class="bot-settings-checkbox"><input type="checkbox" name="${id}"${config[id] ? " checked" : ""}${disabled} /><span>${escapeHtml(label)}</span></label>`
  )).join("");
  const presetLabel = { quiet: "安静", companion: "日常", lively: "活力", custom: "自定义" }[preset] || "自定义";
  return `<label class="bot-settings-field"><span>项目</span><select name="projectId" aria-label="桌宠所属项目">${projects || '<option value="">选择项目</option>'}</select></label>
    <p class="bot-settings-lead" data-pet-status>${installed ? (canEdit ? "配置保存后同步到桌宠运行时" : "选择项目后可编辑") : "桌宠资源包尚未安装；可先改草稿，安装后再生效"}</p>
    <label class="bot-settings-checkbox"><input type="checkbox" name="enabled"${config.enabled ? " checked" : ""}${disabled} /><span>在当前项目启用桌宠</span></label>
    <div class="bot-pet-preset" role="group" aria-label="陪伴强度">
      ${[["quiet", "安静"], ["companion", "日常"], ["lively", "活力"]].map(([id, label]) => (
        `<button type="button" data-pet-preset="${id}" aria-pressed="${id === preset}"${disabled}>${escapeHtml(label)}</button>`
      )).join("")}
      <span data-pet-preset-label>${escapeHtml(presetLabel)}</span>
    </div>
    <div class="bot-pet-grid">
      <label class="bot-settings-field"><span>Live2D 模型</span><select name="model"${disabled}>${models}</select></label>
      <label class="bot-settings-field"><span>最大帧率</span><select name="max-fps"${disabled}><option value="30"${config["max-fps"] === "30" ? " selected" : ""}>30 FPS</option><option value="60"${config["max-fps"] === "60" ? " selected" : ""}>60 FPS</option><option value="120"${config["max-fps"] === "120" ? " selected" : ""}>120 FPS</option></select></label>
      <label class="bot-settings-field"><span>不透明度 ${escapeHtml(String(config.opacity))}%</span><input type="range" name="opacity" min="30" max="100" step="5" value="${escapeHtml(String(config.opacity))}"${disabled} /></label>
      <label class="bot-settings-field"><span>大小 ${escapeHtml(String(config.scale))}%</span><input type="range" name="scale" min="60" max="180" step="10" value="${escapeHtml(String(config.scale))}"${disabled} /></label>
    </div>
    <div class="bot-pet-toggles">${toggles}</div>
    <div class="bot-agent-settings-actions">
      <button class="bot-text-button" type="button" data-pet-reset${disabled}>恢复默认</button>
      <button class="bot-card-confirm" type="submit"${disabled}>保存桌宠设置</button>
    </div>
    <p class="bot-member-settings-status" data-pet-save-status role="status">桌宠设置保存在当前项目插件绑定</p>`;
}

export function mountBotPetSettings(root, { request, toast = () => {} } = {}) {
  if (!root) return { refresh() {}, destroy() {} };
  let generation = 0;
  let snapshot = null;
  let projects = [];
  let selected = "";
  let draft = defaultPetConfig();
  let busy = false;

  const status = (text, tone = "neutral") => {
    const node = root.querySelector("[data-pet-save-status]");
    if (node) {
      node.textContent = text;
      node.className = `bot-member-settings-status is-${tone}`;
    }
  };

  const currentBinding = () => (snapshot?.bindings || []).find((item) => item.pluginId === "desktop-pet") || null;
  const isInstalled = () => (snapshot?.installed || []).some((item) => item.id === "desktop-pet");

  const render = () => {
    const projectOptions = projects.map((project) => ({
      id: String(project.projectId || project.id || ""),
      label: project.title || project.name || project.projectId || "未命名项目",
    })).filter((item) => item.id);
    writeMarkup(root, `<form class="bot-pet-settings-form" id="bot-pet-settings-form">${petFormMarkup(draft, {
      canEdit: Boolean(selected) && !busy,
      projectOptions,
      selectedProjectId: selected,
      installed: isInstalled(),
    })}</form>`);
  };

  async function load(projectId = selected) {
    const ticket = ++generation;
    selected = String(projectId || "");
    try {
      const [pluginData, projectData] = await Promise.all([
        request(`/api/plugins${selected ? `?projectId=${encodeURIComponent(selected)}` : ""}`),
        request("/api/projects?includeArchived=1"),
      ]);
      if (ticket !== generation) return;
      snapshot = pluginData;
      projects = projectData?.projects || [];
      if (!selected && projects[0]) selected = String(projects[0].projectId || projects[0].id || "");
      draft = petConfigFromBinding(currentBinding());
      render();
    } catch (error) {
      if (ticket !== generation) return;
      writeMarkup(root, `<p class="bot-plugin-empty">桌宠设置读取失败：${escapeHtml(error.message)}</p>`);
    }
  }

  const onClick = (event) => {
    const form = root.querySelector("#bot-pet-settings-form");
    if (!form) return;
    const preset = event.target.closest("[data-pet-preset]");
    if (preset) {
      event.preventDefault();
      draft = applyPetPresetToConfig(readPetForm(form), preset.dataset.petPreset);
      render();
      return;
    }
    if (event.target.closest("[data-pet-reset]")) {
      event.preventDefault();
      draft = defaultPetConfig();
      render();
    }
  };

  const onChange = (event) => {
    if (event.target?.name === "projectId") {
      void load(event.target.value);
      return;
    }
    const form = root.querySelector("#bot-pet-settings-form");
    if (form) draft = readPetForm(form);
  };

  const onSubmit = async (event) => {
    event.preventDefault();
    const form = event.target.closest("form");
    if (!form || !selected || busy) return;
    draft = readPetForm(form);
    busy = true;
    status("正在保存…");
    try {
      await request("/api/plugins/configure", {
        method: "POST",
        body: {
          projectId: selected,
          pluginId: "desktop-pet",
          enabled: draft.enabled,
          config: draft,
          expectedRevision: snapshot?.revision,
        },
      });
      window.dispatchEvent(new CustomEvent("514cc:plugin-changed", {
        detail: { action: "configure", payload: { pluginId: "desktop-pet", projectId: selected, enabled: draft.enabled, config: draft } },
      }));
      await load(selected);
      status("桌宠设置已保存", "ok");
      toast("桌宠设置已保存", "success");
    } catch (error) {
      status(`保存失败：${error.message}`, "error");
      toast(`桌宠设置未保存：${error.message}`, "error");
    } finally {
      busy = false;
    }
  };

  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("submit", onSubmit);
  render();

  return {
    refresh(projectId) { return load(projectId); },
    destroy() {
      root.removeEventListener("click", onClick);
      root.removeEventListener("change", onChange);
      root.removeEventListener("submit", onSubmit);
    },
  };
}
