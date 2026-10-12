/**
 * project-bootstrapper.js — 项目启动器
 *
 * 可视化配置静态 starter：选风味 / 色板 / 主题，dryRun 出计划，确认后落盘。
 * 后端只写 5 个静态文件（index.html + styles.css + app.js + README.md + 514.json），
 * 零 npm、零构建。向导选项必须与 src/bootstrap.mjs 的 allowlist 对齐——
 * 不准再展示 Next / Vite / Laravel 这种不会真正生成的框架。
 *
 * 流程：类型 -> 配置 -> dryRun 计划 -> 确认 -> 创建 -> 成功/失败/占用目录。
 * 远程：读 /api/ssh/hosts，有主机就走 SFTP 写同样 5 个文件；没主机如实说，不挂假「暂未接入」。
 * 后端不可用（404/网络错误）时回退为 onCreate(config, null) 通知（工作台预填）。
 *
 * 约定：
 *   - 图标一律走 lucide.js 的 lucideIcon()，UI 无 emoji。
 *   - 颜色一律走 forge tokens（var(--primary) 等），无内联样式。
 *   - onCreate(config, result) 仅作通知：真实创建成功后调用；
 *     后端不可用时以 (config, null) 调用。
 */

import { lucideIcon } from "./lucide.js";
import { request } from "./api.js";
import { escapeHtml } from "./utils.js";

const FRAMEWORKS = [
  { id: "vanilla", name: "Vanilla", desc: "一张卡片 + 按钮，打开就能点", icon: "code", popular: true },
  { id: "react", name: "组件化", desc: "函数组件结构，无 JSX、无构建", icon: "boxes" },
  { id: "dashboard", name: "Dashboard", desc: "侧栏 + 卡片网格骨架", icon: "layout-dashboard" },
];

const STYLES = [
  { id: "paper", name: "暖纸", desc: "铜橙令牌，贴近 Console", icon: "palette", popular: true },
  { id: "minimal", name: "极简", desc: "冷灰底，少装饰", icon: "file-text" },
  { id: "ink", name: "墨色", desc: "高对比，近黑白", icon: "type" },
];

const THEMES = [
  { id: "light", name: "亮色", swatch: "is-light" },
  { id: "dark", name: "暗色", swatch: "is-dark" },
  { id: "auto", name: "跟随系统", swatch: "is-auto" },
];

const ICON_LIBS = [
  { id: "lucide", name: "Lucide", desc: "写进 514.json 的约定，不装包", icon: "sparkles" },
  { id: "none", name: "无约定", desc: "不写图标库指纹", icon: "x" },
];

const FONTS = [
  { id: "system", name: "系统字体", desc: "system-ui，零依赖", icon: "type", sample: "The quick brown fox" },
  { id: "inter", name: "Inter 优先", desc: "本机有 Inter 才生效，不拉 CDN", icon: "type", sample: "The quick brown fox" },
  { id: "mono", name: "等宽", desc: "代码编辑器风格", icon: "terminal", sample: "const x = 42;" },
];

const PLANNED_FILES = ["index.html", "styles.css", "app.js", "README.md", "514.json"];
const SCAFFOLD_API = "/api/bootstrap/scaffold";
const MAX_NAME = 60;
const MAX_DESCRIPTION = 200;
const DEFAULTS = Object.freeze({
  framework: "vanilla",
  style: "paper",
  theme: "auto",
  icons: "lucide",
  font: "system",
  name: "",
  dir: "",
  description: "",
});

let _containerEl = null;
let _config = { ...DEFAULTS };
let _onCreate = null;
let _onOpenWorkbench = null;
let _onOpenHosts = null;
// 脚手架阶段：idle | planning | plan | creating | done | error | fallback | occupied
let _stage = "idle";
let _plan = null;
let _result = null;
let _error = "";
let _force = false;
let _advancedOpen = false;

const PROJECT_TYPES = [
  { id: "local", name: "本地", desc: "在你的电脑上编辑、运行和测试文件", icon: "terminal" },
  { id: "remote", name: "远程", desc: "在已登记主机上写入同样的 5 个静态文件", icon: "globe" },
];
let _step = "type";
let _type = "local";
let _hosts = [];
let _hostsStatus = "loading"; // loading | ready | gate | error
let _remoteHostId = "";
let _remoteBrowse = { key: "", items: [], loading: false, error: null };

/**
 * 初始化项目启动器
 * @param {HTMLElement} container - 容器（允许为 null，安全自守护）
 * @param {Object} opts
 * @param {Function} opts.onCreate - (config, result) => void，仅通知回调
 * @param {Function} [opts.onOpenWorkbench] - (targetDir) => void，成功后带到协作台
 * @param {Function} [opts.onOpenHosts] - () => void，去登记远程主机
 */
export function initProjectBootstrapper(container, opts = {}) {
  if (!container) {
    console.warn("project-bootstrapper: 挂载点不存在，跳过初始化");
    return;
  }
  _containerEl = container;
  _onCreate = typeof opts.onCreate === "function" ? opts.onCreate : () => {};
  _onOpenWorkbench = typeof opts.onOpenWorkbench === "function" ? opts.onOpenWorkbench : null;
  _onOpenHosts = typeof opts.onOpenHosts === "function" ? opts.onOpenHosts : null;
  render();
  void loadRemoteHosts();
}

function isFocusStage() {
  return ["planning", "plan", "creating", "done", "occupied"].includes(_stage);
}

function render() {
  if (!_containerEl) return;
  const busy = _stage === "planning" || _stage === "creating";
  const focused = _step === "config" && isFocusStage();
  _containerEl.innerHTML = `
    <div class="bootstrapper">
      <div class="bootstrapper-header">
        <div class="boot-steps" aria-label="向导进度">
          <span class="boot-step${_step === "type" ? " is-current" : " is-done"}">1 类型</span>
          <span class="boot-step-rule" aria-hidden="true"></span>
          <span class="boot-step${_step === "config" && !focused ? " is-current" : _step === "config" ? " is-done" : ""}">2 配置</span>
          <span class="boot-step-rule" aria-hidden="true"></span>
          <span class="boot-step${focused ? " is-current" : ""}">3 写入</span>
        </div>
        <h3 class="bootstrapper-title">
          <span class="bootstrapper-icon">${lucideIcon("rocket", "icon lucide")}</span>
          项目启动器
        </h3>
        <p class="bootstrapper-desc">${typeStepCopy(focused)}</p>
      </div>

      ${renderScaffoldPanel()}
      ${focused ? renderFocusSummary() : _step === "type" ? renderTypeStep(busy) : renderConfigStep(busy)}
    </div>
  `;

  bindEvents();
  if (_step === "config" && _type === "remote" && selectedHost()) void loadBootRemoteBrowser();
  const panel = _containerEl.querySelector("#boot-scaffold");
  if (panel) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function isRemote() {
  return _type === "remote";
}

function selectedHost() {
  return _hosts.find((host) => host.id === _remoteHostId) ?? null;
}

function typeCards() {
  return PROJECT_TYPES.map((type) => {
    if (type.id !== "remote") return { ...type, disabled: false, badge: "" };
    if (_hostsStatus === "loading") return { ...type, disabled: false, badge: "加载中" };
    if (_hostsStatus === "gate") {
      return { ...type, disabled: true, badge: "门闸未开", desc: "SSH/SFTP 门闸未开放，打开后才能写到远程。" };
    }
    if (_hostsStatus === "error") {
      return { ...type, disabled: true, badge: "加载失败", desc: "主机台账读不到。可先用本地，或去远程主机页重试。" };
    }
    if (!_hosts.length) {
      return { ...type, disabled: false, badge: "先登记主机", desc: "还没有可用主机。下一步会带你去登记。" };
    }
    return { ...type, disabled: false, badge: `${_hosts.length} 台主机` };
  });
}

function typeStepCopy(focused) {
  if (focused) return "确认计划后才会落盘。取消就回到配置。";
  if (_step !== "type") {
    return isRemote()
      ? "远程写入同一套 5 个静态文件。选主机和目录，确认后走 SFTP。"
      : "静态 starter：5 个文件，无 npm、无构建。选什么，磁盘就长什么样。";
  }
  if (_hostsStatus === "loading") return "先选落在哪。正在看有没有可用的远程主机。";
  if (_hostsStatus === "gate") return "先选落在哪。远程写盘要先开 SSH/SFTP 门闸。";
  if (_hostsStatus === "error") return "先选落在哪。远程主机台账这次没读到。";
  if (!_hosts.length) return "先选落在哪。远程要先在「远程主机」里登记一台。";
  return "先选落在哪。本地写本机，远程写到已登记主机。";
}

async function loadRemoteHosts() {
  _hostsStatus = "loading";
  try {
    const data = await request("/api/ssh/hosts");
    _hosts = (data?.hosts ?? []).filter((host) => host.enabled !== false);
    _hostsStatus = "ready";
    if (!_remoteHostId || !_hosts.some((host) => host.id === _remoteHostId)) {
      _remoteHostId = _hosts[0]?.id || "";
    }
  } catch (error) {
    _hosts = [];
    _remoteHostId = "";
    _hostsStatus = /REMOTE_GATE/.test(error?.message || "") ? "gate" : "error";
    if (_type === "remote") _type = "local";
  }
  render();
}

function renderFocusSummary() {
  return `
    <div class="boot-summary">
      <span class="boot-summary-name">${escapeHtml(projectName() || "未命名")}</span>
      <span class="boot-summary-meta">${getFrameworkName()} · ${getStyleName()} · ${getThemeName()}</span>
      <code>${escapeHtml(targetDir())}</code>
    </div>
  `;
}

function renderTypeStep(busy) {
  const cards = typeCards();
  const selectedType = cards.find((t) => t.id === _type);
  return `
    <div class="boot-wizard forge-enter">
      <div class="boot-step-label">项目类型</div>
      <div class="boot-type-grid">
        ${cards.map((t) => {
          const selected = t.id === _type;
          return `
            <button class="boot-type-card${selected ? " is-selected" : ""}" data-type-id="${t.id}" type="button"
              ${t.disabled ? "disabled" : ""} aria-pressed="${selected}">
              <span class="boot-type-icon">${lucideIcon(t.icon, "icon lucide")}</span>
              <span class="boot-type-radio${selected ? " is-on" : ""}" aria-hidden="true"></span>
              <span class="boot-type-name">${t.name}${t.badge ? `<span class="boot-type-badge">${t.badge}</span>` : ""}</span>
              <span class="boot-type-desc">${t.desc}</span>
            </button>
          `;
        }).join("")}
      </div>
      <div class="bootstrapper-footer">
        <button class="button primary" id="boot-next" type="button" ${busy || selectedType?.disabled ? "disabled" : ""}>
          <span>下一步</span>
          ${lucideIcon("arrow-right", "icon lucide")}
        </button>
      </div>
    </div>
  `;
}

function renderDestinationSection() {
  if (!isRemote()) {
    return `
          <div class="boot-section">
            <label class="boot-label">目标目录</label>
            <div class="boot-dirpick${_config.dir ? " has-dir" : ""}">
              <button class="boot-dirpick-main" id="boot-dirpick" type="button" title="选择项目落盘目录（原生目录选择框）">
                ${lucideIcon(_config.dir ? "folder" : "folder-open", "icon lucide")}
                ${_config.dir ? `<code>${escapeHtml(_config.dir)}</code>` : "<span>添加项目落盘目录</span>"}
              </button>
              ${_config.dir ? `<button class="boot-dirpick-clear" id="boot-dir-clear" type="button" title="清除目录，回到默认" aria-label="清除目录">${lucideIcon("x", "icon lucide")}</button>` : ""}
            </div>
            <span class="boot-hint" id="boot-dir-hint">${_config.dir ? "目录须在家目录或仓库父目录内" : `留空则使用默认目录 ${escapeHtml(defaultDir())}`}</span>
          </div>`;
  }
  if (!_hosts.length) {
    return `
          <div class="boot-section">
            <div class="boot-honest">
              ${lucideIcon("server", "icon lucide")}
              <p>还没有可用主机。先去「远程主机」登记一台，再回到这里写盘。</p>
            </div>
            ${_onOpenHosts ? `<button class="button secondary" id="boot-go-hosts" type="button">${lucideIcon("arrow-right", "icon lucide")}<span>去登记主机</span></button>` : ""}
          </div>`;
  }
  const host = selectedHost();
  return `
          <div class="boot-section">
            <label class="boot-label" for="boot-remote-host">远程主机</label>
            <select class="boot-input boot-remote-host" id="boot-remote-host">
              ${_hosts.map((entry) => `<option value="${escapeAttr(entry.id)}"${entry.id === _remoteHostId ? " selected" : ""}>${escapeHtml(entry.name)} · ${escapeHtml(`${entry.user}@${entry.host}:${entry.port}`)}</option>`).join("")}
            </select>
          </div>
          <div class="boot-section">
            <label class="boot-label" for="boot-remote-path">远程目录</label>
            <div class="remote-path-row">
              <button class="icon-button remote-path-up" id="boot-remote-up" type="button" title="上级目录" aria-label="上级目录">
                ${lucideIcon("arrow-up", "icon lucide")}
              </button>
              <input class="boot-input" id="boot-remote-path" autocomplete="off" placeholder="${escapeAttr(defaultDir())}" value="${escapeAttr(_config.dir)}" />
            </div>
            <div class="remote-browser" id="boot-remote-browser" aria-live="polite"></div>
            <span class="boot-hint" id="boot-dir-hint">${_config.dir ? `${escapeHtml(host?.name || "远程")} · 路径须在该主机 SFTP 允许根内` : `留空则使用 ${escapeHtml(defaultDir())}`}</span>
          </div>`;
}

function renderConfigStep(busy) {
  const nameOk = Boolean(_config.name.trim());
  const nameLen = _config.name.trim().length;
  return `
    <div class="boot-wizard forge-enter">
      <div class="boot-honest">
        ${lucideIcon("info", "icon lucide")}
        <p>会写入 <strong>5 个静态文件</strong>。不是 Next / Vite / Laravel，打开 <code>index.html</code> 就能跑。</p>
      </div>
      <div class="bootstrapper-body">
        <div class="bootstrapper-config">
          <div class="boot-section">
            <label class="boot-label" for="boot-name">项目名称</label>
            <div class="boot-input-affix">
              ${lucideIcon("folder", "icon lucide")}
              <input class="boot-input" type="text" id="boot-name" maxlength="${MAX_NAME}" placeholder="my-awesome-project" value="${escapeAttr(_config.name)}" autocomplete="off" />
            </div>
            <span class="boot-hint" id="boot-name-hint">${nameOk ? `${nameLen} / ${MAX_NAME}` : "必填，会写进标题和 README"}</span>
          </div>
          ${renderDestinationSection()}
          <div class="boot-section">
            <label class="boot-label" for="boot-desc">一句话描述</label>
            <input class="boot-input" type="text" id="boot-desc" maxlength="${MAX_DESCRIPTION}" placeholder="可选，写进页面和 README" value="${escapeAttr(_config.description)}" />
          </div>

          <div class="boot-section">
            <label class="boot-label">骨架风味</label>
            <div class="boot-options boot-flavors">
              ${FRAMEWORKS.map((f) => optionCard("framework", f, _config.framework)).join("")}
            </div>
          </div>

          <div class="boot-section">
            <label class="boot-label">色板</label>
            <div class="boot-options">
              ${STYLES.map((s) => optionCard("style", s, _config.style)).join("")}
            </div>
          </div>

          <div class="boot-section">
            <label class="boot-label">主题</label>
            <div class="boot-themes">
              ${THEMES.map((t) => `
                <button class="boot-theme ${t.id === _config.theme ? "is-selected" : ""}" data-type="theme" data-value="${t.id}" type="button">
                  <span class="boot-theme-preview ${t.swatch}">
                    <span class="boot-theme-accent"></span>
                  </span>
                  <span class="boot-theme-name">${t.name}</span>
                </button>
              `).join("")}
            </div>
          </div>

          <details class="boot-advanced" id="boot-advanced" ${_advancedOpen ? "open" : ""}>
            <summary>
              ${lucideIcon("chevron-right", "icon lucide")}
              <span>更多约定</span>
              <span class="boot-advanced-meta">${getFontName()} · ${getIconName()}</span>
            </summary>
            <div class="boot-advanced-body">
              <div class="boot-section">
                <label class="boot-label">字体栈</label>
                <div class="boot-options boot-options-small">
                  ${FONTS.map((f) => optionCard("font", f, _config.font, { sample: f.sample })).join("")}
                </div>
              </div>
              <div class="boot-section">
                <label class="boot-label">图标约定</label>
                <div class="boot-options boot-options-small">
                  ${ICON_LIBS.map((i) => optionCard("icons", i, _config.icons, { compact: true })).join("")}
                </div>
                <span class="boot-hint">只写进 514.json，不会下载图标包。</span>
              </div>
            </div>
          </details>
        </div>

        <div class="bootstrapper-preview">
          <div class="boot-preview-header">
            <span class="boot-preview-title">将得到</span>
            <span class="boot-preview-badge">${getFrameworkName()} · ${getStyleName()}</span>
          </div>
          <div class="boot-preview-content" id="boot-preview">
            ${renderPreview()}
          </div>
        </div>
      </div>

      <div class="bootstrapper-footer">
        <button class="button secondary boot-prev" id="boot-prev" type="button" ${busy ? "disabled" : ""}>
          ${lucideIcon("chevron-right", "icon lucide boot-flip")}
          <span>上一步</span>
        </button>
        <button class="button secondary" id="boot-reset" type="button" ${busy ? "disabled" : ""}>
          ${lucideIcon("refresh-cw", "icon lucide")}
          <span>重置</span>
        </button>
        <button class="button primary" id="boot-create" type="button" ${busy || !nameOk || (isRemote() && !selectedHost()) ? "disabled" : ""} title="${!nameOk ? "先填项目名称" : isRemote() && !selectedHost() ? "先选一台远程主机" : "先出创建计划，确认后再落盘"}">
          <span>${busy ? "处理中" : "查看创建计划"}</span>
          ${lucideIcon(busy ? "loader-circle" : "arrow-right", busy ? "icon lucide boot-spin" : "icon lucide")}
        </button>
      </div>
    </div>
  `;
}

function optionCard(type, item, selectedId, opts = {}) {
  const selected = item.id === selectedId;
  return `
    <button class="boot-option forge-enter ${selected ? "is-selected" : ""} ${item.popular ? "is-popular" : ""}" data-type="${type}" data-value="${item.id}" type="button">
      <span class="boot-option-icon">${lucideIcon(item.icon, "icon lucide boot-glyph")}</span>
      <span class="boot-option-name">${item.name}</span>
      ${opts.compact ? "" : `<span class="boot-option-desc">${item.desc || ""}</span>`}
      ${opts.sample ? `<span class="boot-option-sample">${escapeHtml(opts.sample)}</span>` : ""}
      ${item.popular ? '<span class="boot-option-badge">推荐</span>' : ""}
    </button>
  `;
}

function bindEvents() {
  _containerEl.querySelectorAll(".boot-type-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      _type = btn.dataset.typeId;
      render();
    });
  });

  _containerEl.querySelector("#boot-next")?.addEventListener("click", () => {
    if (typeCards().find((t) => t.id === _type)?.disabled) return;
    _step = "config";
    if (isRemote() && looksLikeLocalPath(_config.dir)) _config.dir = "";
    render();
  });

  _containerEl.querySelector("#boot-prev")?.addEventListener("click", () => {
    _step = "type";
    render();
  });

  _containerEl.querySelector("#boot-advanced")?.addEventListener("toggle", (event) => {
    _advancedOpen = event.currentTarget.open;
  });

  _containerEl.querySelector("#boot-dirpick")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await request("/api/system/pick-directory", { method: "POST" });
      if (result?.path) {
        _config.dir = result.path;
        render();
      }
    } catch (error) {
      console.warn("目录选择失败：", error?.message || error);
    } finally {
      button.disabled = false;
    }
  });

  _containerEl.querySelector("#boot-dir-clear")?.addEventListener("click", () => {
    _config.dir = "";
    render();
  });

  _containerEl.querySelector("#boot-go-hosts")?.addEventListener("click", () => {
    _onOpenHosts?.();
  });

  _containerEl.querySelector("#boot-remote-host")?.addEventListener("change", (event) => {
    _remoteHostId = event.currentTarget.value;
    if (!_config.dir.trim() || looksLikeDefaultRemote(_config.dir)) _config.dir = "";
    _remoteBrowse = { key: "", items: [], loading: false, error: null };
    render();
  });

  _containerEl.querySelector("#boot-remote-path")?.addEventListener("input", (event) => {
    _config.dir = event.currentTarget.value;
    const hint = _containerEl.querySelector("#boot-dir-hint");
    if (hint) {
      hint.textContent = _config.dir.trim()
        ? `${selectedHost()?.name || "远程"} · 路径须在该主机 SFTP 允许根内`
        : `留空则使用 ${defaultDir()}`;
    }
  });

  _containerEl.querySelector("#boot-remote-path")?.addEventListener("change", () => {
    void loadBootRemoteBrowser({ force: true });
  });

  _containerEl.querySelector("#boot-remote-up")?.addEventListener("click", () => {
    _config.dir = remotePathParent(targetDir());
    render();
  });

  _containerEl.querySelector("#boot-remote-browser")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remote-cd]");
    if (!button) return;
    _config.dir = remotePathJoin(targetDir(), button.dataset.remoteCd);
    render();
  });

  _containerEl.querySelectorAll(".boot-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.type;
      const value = btn.dataset.value;
      if (!type || !value) return;
      _config[type] = value;
      render();
    });
  });

  _containerEl.querySelectorAll(".boot-theme").forEach((btn) => {
    btn.addEventListener("click", () => {
      _config.theme = btn.dataset.value;
      render();
    });
  });

  _containerEl.querySelector("#boot-name")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    void startPlan();
  });

  _containerEl.querySelector("#boot-name")?.addEventListener("input", (e) => {
    _config.name = e.target.value;
    const hint = _containerEl.querySelector("#boot-name-hint");
    const trimmed = _config.name.trim();
    if (hint) hint.textContent = trimmed ? `${trimmed.length} / ${MAX_NAME}` : "必填，会写进标题和 README";
    const dirHint = _containerEl.querySelector("#boot-dir-hint");
    if (dirHint && !_config.dir) dirHint.textContent = `留空则使用默认目录 ${defaultDir()}`;
    const create = _containerEl.querySelector("#boot-create");
    if (create) create.disabled = _stage === "planning" || _stage === "creating" || !trimmed;
    updatePreview();
  });

  _containerEl.querySelector("#boot-desc")?.addEventListener("input", (e) => {
    _config.description = e.target.value;
    updatePreview();
  });

  _containerEl.querySelector("#boot-reset")?.addEventListener("click", () => {
    _config = { ...DEFAULTS };
    _type = "local";
    _step = "type";
    _force = false;
    _advancedOpen = false;
    resetFlow();
    render();
  });

  _containerEl.querySelector("#boot-create")?.addEventListener("click", () => {
    void startPlan();
  });

  _containerEl.querySelector("#boot-confirm")?.addEventListener("click", () => {
    void confirmCreate();
  });

  _containerEl.querySelector("#boot-cancel")?.addEventListener("click", () => {
    resetFlow();
    render();
  });

  _containerEl.querySelector("#boot-dismiss")?.addEventListener("click", () => {
    resetFlow();
    render();
  });

  _containerEl.querySelector("#boot-retry")?.addEventListener("click", () => {
    resetFlow();
    void startPlan();
  });

  _containerEl.querySelector("#boot-force")?.addEventListener("change", (event) => {
    _force = event.currentTarget.checked;
    const planBtn = _containerEl.querySelector("#boot-force-plan");
    if (planBtn) planBtn.disabled = !_force;
  });

  _containerEl.querySelector("#boot-force-plan")?.addEventListener("click", () => {
    if (!_force) return;
    void startPlan();
  });

  _containerEl.querySelector("#boot-copy-dir")?.addEventListener("click", () => {
    const dir = String(_result?.targetDir || _plan?.targetDir || targetDir());
    if (!dir || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(dir).catch((error) => {
      console.warn("复制目录失败：", error?.message || error);
    });
  });

  _containerEl.querySelector("#boot-again")?.addEventListener("click", () => {
    _config = { ...DEFAULTS };
    _step = "type";
    _force = false;
    resetFlow();
    render();
  });

  _containerEl.querySelector("#boot-reveal")?.addEventListener("click", async () => {
    const dir = String(_result?.targetDir || "");
    if (!dir) return;
    try {
      await request("/api/system/reveal", { method: "POST", body: { path: dir } });
    } catch (error) {
      console.warn("打开目录失败：", error?.message || error);
    }
  });

  _containerEl.querySelector("#boot-workbench")?.addEventListener("click", () => {
    const dir = String(_result?.targetDir || "");
    if (!dir || !_onOpenWorkbench) return;
    _onOpenWorkbench(dir);
  });

  _containerEl.querySelector("#boot-open-hosts")?.addEventListener("click", () => {
    _onOpenHosts?.();
  });
}

function resetFlow() {
  _stage = "idle";
  _plan = null;
  _result = null;
  _error = "";
}

function projectName() {
  return _config.name.trim();
}

function defaultDir() {
  const slug = projectName() || "my-project";
  if (isRemote()) {
    const user = selectedHost()?.user || "you";
    return `/home/${user}/514-projects/${slug}`;
  }
  return `~/514-projects/${slug}`;
}

function targetDir() {
  return _config.dir.trim() || defaultDir();
}

function looksLikeLocalPath(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value || "")) || String(value || "").includes("\\");
}

function looksLikeDefaultRemote(value) {
  return /\/514-projects\//.test(String(value || ""));
}

function remotePathJoin(base, name) {
  return `${String(base || "/").replace(/\/+$/, "")}/${name}`;
}

function remotePathParent(path) {
  const trimmed = String(path || "/").replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

async function loadBootRemoteBrowser({ force = false } = {}) {
  const host = selectedHost();
  const browser = _containerEl?.querySelector("#boot-remote-browser");
  if (!host || !browser) return;
  const path = targetDir();
  const key = `${host.id}:${path}`;
  if (!force && _remoteBrowse.key === key && (_remoteBrowse.loading || _remoteBrowse.error || _remoteBrowse.items.length)) {
    renderBootRemoteBrowser();
    return;
  }
  _remoteBrowse = { key, items: [], loading: true, error: null };
  renderBootRemoteBrowser();
  try {
    const result = await request(`/api/ssh/hosts/${encodeURIComponent(host.id)}/sftp/list?path=${encodeURIComponent(path)}`);
    if (_remoteBrowse.key !== key) return;
    _remoteBrowse.items = (result?.items ?? [])
      .filter((item) => item.isDirectory)
      .sort((a, b) => a.name.localeCompare(b.name));
    _remoteBrowse.error = null;
  } catch (error) {
    if (_remoteBrowse.key !== key) return;
    _remoteBrowse.items = [];
    _remoteBrowse.error = /REMOTE_GATE/.test(error?.message || "")
      ? "SFTP 门闸未开放，目录浏览不可用——可手动输入路径。"
      : /no such file|ENOENT|not exist/i.test(error?.message || "")
        ? "这个目录还不存在，确认写入时会创建。"
        : `列目录失败：${error.message}（可手动输入路径）`;
  } finally {
    if (_remoteBrowse.key === key) {
      _remoteBrowse.loading = false;
      renderBootRemoteBrowser();
    }
  }
}

function renderBootRemoteBrowser() {
  const browser = _containerEl?.querySelector("#boot-remote-browser");
  if (!browser) return;
  if (_remoteBrowse.loading) {
    browser.innerHTML = `<p class="remote-browser-tip">正在列目录…</p>`;
    return;
  }
  if (_remoteBrowse.error) {
    browser.innerHTML = `<p class="remote-browser-tip is-error">${escapeHtml(_remoteBrowse.error)}</p>`;
    return;
  }
  browser.innerHTML = _remoteBrowse.items.length
    ? _remoteBrowse.items.map((item) => `<button type="button" class="remote-browser-item" data-remote-cd="${escapeAttr(item.name)}">${lucideIcon("folder", "icon lucide")}<span>${escapeHtml(item.name)}</span></button>`).join("")
    : `<p class="remote-browser-tip">该目录下没有子目录——可直接用当前路径。</p>`;
}

function scaffoldPayload(dryRun) {
  const payload = {
    framework: _config.framework,
    style: _config.style,
    theme: _config.theme,
    iconLibrary: _config.icons,
    font: _config.font,
    name: projectName(),
    description: _config.description.trim(),
    dir: _config.dir.trim(),
    dryRun,
    force: _force,
  };
  if (isRemote()) payload.hostId = _remoteHostId;
  return payload;
}

function isOccupiedError(error) {
  return /not empty/i.test(String(error?.message || ""));
}

async function startPlan() {
  if (_stage === "planning" || _stage === "creating") return;
  if (!projectName()) {
    _stage = "error";
    _error = "先填项目名称。";
    render();
    return;
  }
  if (isRemote() && !selectedHost()) {
    _stage = "error";
    _error = "先选一台远程主机，或先去「远程主机」登记。";
    render();
    return;
  }
  _stage = "planning";
  _error = "";
  render();
  try {
    const data = await request(SCAFFOLD_API, { method: "POST", body: scaffoldPayload(true) });
    _plan = data && typeof data === "object" ? data : {};
    _stage = "plan";
  } catch (error) {
    handleApiFailure(error);
  }
  render();
}

async function confirmCreate() {
  if (_stage !== "plan") return;
  _stage = "creating";
  _error = "";
  render();
  try {
    const data = await request(SCAFFOLD_API, { method: "POST", body: scaffoldPayload(false) });
    _result = data && typeof data === "object" ? data : {};
    if (isRemote() && _result.ok && _remoteHostId && _result.targetDir) {
      try {
        await request("/api/remote-projects", {
          method: "POST",
          body: { name: projectName(), hostId: _remoteHostId, path: _result.targetDir },
        });
        _result.registered = true;
      } catch (error) {
        if (/already registered|REMOTE_PROJECT_EXISTS/i.test(String(error?.message || error?.code || ""))) {
          _result.registered = true;
        } else {
          _result.registerError = String(error?.message || error);
        }
      }
    }
    _stage = "done";
    _onCreate({ ..._config, type: _type, hostId: isRemote() ? _remoteHostId : undefined }, _result);
  } catch (error) {
    handleApiFailure(error);
  }
  render();
}

function handleApiFailure(error) {
  const status = Number(error?.status ?? -1);
  const code = error?.code || error?.payload?.code || error?.payload?.error?.code;
  if (status === 0 || (status === 404 && (!code || code === "NOT_FOUND"))) {
    _stage = "fallback";
    _error = "";
    _onCreate({ ..._config }, null);
    return;
  }
  if (isOccupiedError(error)) {
    _stage = "occupied";
    _error = String(error?.message || error || "目标目录不是空的");
    return;
  }
  _stage = "error";
  _error = String(error?.message || error || "未知错误");
}

function fileNamesFrom(result) {
  const relative = normalizeList(result?.files);
  if (relative.length) return relative;
  const planned = normalizeList(result?.filesPlanned);
  if (planned.length) return planned.map((path) => String(path).split(/[/\\]/).pop());
  const written = normalizeList(result?.filesWritten);
  if (written.length) return written.map((path) => String(path).split(/[/\\]/).pop());
  if (typeof result?.filesWritten === "number") return PLANNED_FILES.slice(0, result.filesWritten);
  if (typeof result?.fileCount === "number" && result.fileCount > 0) return PLANNED_FILES.slice(0, result.fileCount);
  return [];
}

function renderScaffoldPanel() {
  if (_stage === "idle") return "";

  if (_stage === "planning" || _stage === "creating") {
    return `
      <div class="boot-scaffold forge-enter" id="boot-scaffold">
        <div class="boot-scaffold-status">
          ${lucideIcon("loader-circle", "icon lucide boot-spin")}
          <span>${_stage === "planning" ? "正在生成创建计划…" : isRemote() ? "正在经 SFTP 写入 5 个文件…" : "正在写入 5 个文件…"}</span>
        </div>
      </div>
    `;
  }

  if (_stage === "plan") {
    const files = fileNamesFrom(_plan);
    const log = normalizeList(_plan?.log);
    const dir = String(_plan?.targetDir || targetDir());
    return `
      <div class="boot-scaffold forge-enter" id="boot-scaffold">
        <div class="boot-scaffold-head">
          ${lucideIcon("file-text", "icon lucide")}
          <span class="boot-scaffold-title">创建计划</span>
          <span class="boot-scaffold-count num">${files.length || _plan?.fileCount || 0} 个文件</span>
        </div>
        <div class="boot-scaffold-dir">
          ${lucideIcon("folder", "icon lucide")}
          <code>${escapeHtml(_plan?.placement === "remote" && _plan?.hostName ? `${_plan.hostName}:${dir}` : dir)}</code>
        </div>
        ${files.length ? `<ul class="boot-file-list">${files.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>` : '<p class="boot-scaffold-empty">后端未返回文件清单</p>'}
        ${log.length ? `<div class="boot-log">${log.map((l) => `<div class="boot-log-line">${escapeHtml(l)}</div>`).join("")}</div>` : ""}
        <div class="boot-scaffold-actions">
          <button class="button secondary" id="boot-cancel" type="button">
            ${lucideIcon("x", "icon lucide")}
            <span>取消</span>
          </button>
          <button class="button primary" id="boot-confirm" type="button">
            <span>确认写入</span>
            ${lucideIcon("check", "icon lucide")}
          </button>
        </div>
      </div>
    `;
  }

  if (_stage === "occupied") {
    return `
      <div class="boot-scaffold is-error forge-enter" id="boot-scaffold">
        <div class="boot-scaffold-head">
          <span class="boot-scaffold-mark is-bad">${lucideIcon("circle-alert", "icon lucide")}</span>
          <span class="boot-scaffold-title">目录不是空的</span>
        </div>
        <p class="boot-scaffold-note">${escapeHtml(_error)}</p>
        <p class="boot-scaffold-note">勾选后会把 5 个 starter 文件写进去，<strong>已有文件不会被删</strong>，同名文件会被覆盖。</p>
        <label class="boot-force">
          <input type="checkbox" id="boot-force" ${_force ? "checked" : ""} />
          <span>我知道，强制写入</span>
        </label>
        <div class="boot-scaffold-actions">
          <button class="button secondary" id="boot-dismiss" type="button">
            <span>换个目录</span>
          </button>
          <button class="button primary" id="boot-force-plan" type="button" ${_force ? "" : "disabled"}>
            <span>查看写入计划</span>
            ${lucideIcon("arrow-right", "icon lucide")}
          </button>
        </div>
      </div>
    `;
  }

  if (_stage === "done") {
    const files = fileNamesFrom(_result);
    const log = normalizeList(_result?.log);
    const dir = String(_result?.targetDir || targetDir());
    const hints = normalizeList(_result?.runHint);
    const remote = _result?.placement === "remote" || isRemote();
    const where = remote && _result?.hostName ? `${_result.hostName}:${dir}` : dir;
    return `
      <div class="boot-scaffold is-done forge-enter" id="boot-scaffold">
        <div class="boot-scaffold-head">
          <span class="boot-scaffold-mark is-ok">${lucideIcon("circle-check", "icon lucide")}</span>
          <span class="boot-scaffold-title">${remote ? "静态 starter 已写到远程" : "静态 starter 已落盘"}</span>
          <span class="boot-scaffold-count num">${files.length || _result?.fileCount || 0} 个文件</span>
        </div>
        <div class="boot-scaffold-dir">
          ${lucideIcon("folder", "icon lucide")}
          <code>${escapeHtml(where)}</code>
          <button class="button secondary boot-copy" id="boot-copy-dir" type="button" title="复制路径">
            ${lucideIcon("copy", "icon lucide")}
            <span>复制路径</span>
          </button>
        </div>
        ${remote && _result?.registered ? `<p class="boot-scaffold-note">已登记为远程项目。</p>` : ""}
        ${remote && _result?.registerError ? `<p class="boot-scaffold-note">文件已写入，登记台账失败：${escapeHtml(_result.registerError)}</p>` : ""}
        ${files.length ? `<ul class="boot-file-list">${files.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>` : ""}
        <div class="boot-next">
          <div class="boot-next-title">${lucideIcon("lightbulb", "icon lucide")}<span>${remote ? "在那台主机上打开" : "打开它"}</span></div>
          <ul class="boot-next-list">
            <li><code>cd ${escapeHtml(dir)}</code></li>
            ${(hints.length ? hints : ["python -m http.server 8080", "npx --yes serve ."]).map((line) => `<li><code>${escapeHtml(line)}</code></li>`).join("")}
            <li>浏览器打开 <code>http://127.0.0.1:8080</code></li>
          </ul>
        </div>
        ${log.length ? `<div class="boot-log">${log.map((l) => `<div class="boot-log-line">${escapeHtml(l)}</div>`).join("")}</div>` : ""}
        <div class="boot-scaffold-actions">
          <button class="button secondary" id="boot-again" type="button">
            <span>再创建一个</span>
          </button>
          ${remote ? (_onOpenHosts ? `<button class="button primary" id="boot-open-hosts" type="button">
            ${lucideIcon("server", "icon lucide")}
            <span>去远程主机</span>
          </button>` : `<button class="button primary" id="boot-dismiss" type="button"><span>完成</span></button>`) : `
          <button class="button secondary" id="boot-reveal" type="button">
            ${lucideIcon("folder-open", "icon lucide")}
            <span>打开文件夹</span>
          </button>
          ${_onOpenWorkbench ? `<button class="button primary" id="boot-workbench" type="button">
            ${lucideIcon("messages-square", "icon lucide")}
            <span>带到协作台</span>
          </button>` : `<button class="button primary" id="boot-dismiss" type="button">
            <span>完成</span>
          </button>`}`}
        </div>
      </div>
    `;
  }

  if (_stage === "fallback") {
    return `
      <div class="boot-scaffold is-fallback forge-enter" id="boot-scaffold">
        <div class="boot-scaffold-head">
          <span class="boot-scaffold-mark is-info">${lucideIcon("info", "icon lucide")}</span>
          <span class="boot-scaffold-title">后端脚手架不可用</span>
        </div>
        <p class="boot-scaffold-note">未检测到 scaffold 接口，配置已发送到工作台，可由 Agent 手动创建。</p>
        <div class="boot-scaffold-actions">
          <button class="button secondary" id="boot-dismiss" type="button">
            <span>知道了</span>
          </button>
        </div>
      </div>
    `;
  }

  return `
    <div class="boot-scaffold is-error forge-enter" id="boot-scaffold">
      <div class="boot-scaffold-head">
        <span class="boot-scaffold-mark is-bad">${lucideIcon("circle-alert", "icon lucide")}</span>
        <span class="boot-scaffold-title">创建失败</span>
      </div>
      <p class="boot-scaffold-note">${escapeHtml(_error)}</p>
      <div class="boot-scaffold-actions">
        <button class="button secondary" id="boot-dismiss" type="button">
          <span>关闭</span>
        </button>
        <button class="button primary" id="boot-retry" type="button">
          <span>重试</span>
          ${lucideIcon("refresh-cw", "icon lucide")}
        </button>
      </div>
    </div>
  `;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String);
  return [];
}

function updatePreview() {
  const previewEl = _containerEl?.querySelector("#boot-preview");
  if (previewEl) previewEl.innerHTML = renderPreview();
}

function renderPreview() {
  const name = projectName() || "未命名项目";
  const desc = _config.description.trim() || "由 514cc 脚手架生成的静态 starter";
  return `
    <div class="boot-preview-card boot-preview-anim" data-theme-preview="${escapeAttr(_config.theme)}" data-style-preview="${escapeAttr(_config.style)}" data-font-preview="${escapeAttr(_config.font)}">
      <div class="boot-preview-topbar">
        <div class="boot-preview-dots">
          <span class="dot-r"></span>
          <span class="dot-y"></span>
          <span class="dot-g"></span>
        </div>
        <span class="boot-preview-url">index.html</span>
      </div>
      <div class="boot-preview-body">
        <div class="boot-preview-hero">
          <span class="boot-preview-hero-icon">${lucideIcon(currentOptionIcon(), "icon lucide")}</span>
          <h1 class="boot-preview-name">${escapeHtml(name)}</h1>
        </div>
        <p class="boot-preview-desc">${escapeHtml(desc)}</p>
        ${renderFlavorPreview()}
        <div class="boot-preview-stack">
          <span class="boot-preview-tag">${getFrameworkName()}</span>
          <span class="boot-preview-tag">${getStyleName()}</span>
          <span class="boot-preview-tag">${getThemeName()}</span>
          <span class="boot-preview-tag">${getFontName()}</span>
        </div>
        <ul class="boot-preview-files">
          ${PLANNED_FILES.map((file) => `<li>${escapeHtml(file)}</li>`).join("")}
        </ul>
      </div>
    </div>
  `;
}

function renderFlavorPreview() {
  if (_config.framework === "dashboard") {
    return `
      <div class="boot-preview-dash">
        <aside>
          <span class="is-on">概览</span>
          <span>指标</span>
          <span>设置</span>
        </aside>
        <section>
          <strong>概览</strong>
          <em>在这里填充 overview 视图的内容。</em>
        </section>
      </div>
    `;
  }
  if (_config.framework === "react") {
    return `
      <div class="boot-preview-cardish">
        <strong>就绪</strong>
        <em>createCard() · 无 JSX</em>
      </div>
    `;
  }
  return `
    <div class="boot-preview-cardish">
      <strong>就绪</strong>
      <em>编辑 app.js 开始搭建你的界面。</em>
      <span class="boot-preview-btn">点我</span>
    </div>
  `;
}

function currentOptionIcon() {
  return FRAMEWORKS.find((f) => f.id === _config.framework)?.icon || "rocket";
}

function getFrameworkName() {
  return FRAMEWORKS.find((f) => f.id === _config.framework)?.name || _config.framework;
}

function getStyleName() {
  return STYLES.find((s) => s.id === _config.style)?.name || _config.style;
}

function getIconName() {
  return ICON_LIBS.find((i) => i.id === _config.icons)?.name || _config.icons;
}

function getFontName() {
  return FONTS.find((f) => f.id === _config.font)?.name || _config.font;
}

function getThemeName() {
  return THEMES.find((t) => t.id === _config.theme)?.name || _config.theme;
}

// escapeHtml 统一来自 ./utils.js（本文件此前自带副本，且未转义单引号，与规范不一致）

function escapeAttr(s) {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
