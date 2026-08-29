/**
 * hosts-panel.js — 远程主机视图（Codex「连接」页对齐，2026-08-11 波）。
 *
 * 形态：标题「来自此电脑的 SSH 连接」+ 行列表（toggle / globe / 名称+状态 / ⋯菜单 / exec / SFTP）。
 * 能力契约（Wave G 保留，不砍）：
 *   - toggle = 启用开关（持久化 host.enabled）；停用即拒连，不假装实时连接
 *   - 状态点如实探测：未探测 / 探测中 / 已连接 / 待确认指纹 / 不可达 / 已停用，绝不伪造在线
 *   - 「添加」对话框自动发现 ~/.ssh/config Host 条目（GET /api/ssh/discover），复选批量登记；
 *     已登记条目置灰；手动添加展开原表单；凭据仍只进 secrets 台账，API 永不回显
 *   - 指纹确认、移除收进 ⋯ 菜单；exec / SFTP 行内图标按钮；SFTP 浏览区保留在下方
 */
import { request, apiReady } from "./api.js";
import { lucideIcon } from "./lucide.js";

const state = {
  hosts: [],
  probes: new Map(), // hostId → { phase: "idle"|"probing"|"ok"|"unconfirmed"|"fail", message? }
  envProbes: new Map(), // hostId → { status: "loading"|"ok"|"error", data?, error? }（远程环境探测卡）
  envExpanded: new Set(), // hostId 集合：行内环境卡展开态
  sftp: { hostId: null, path: "", items: [], fileContent: null },
  dialog: { mode: "discover", discovered: [], source: null, defaultUser: null, selected: new Set(), loaded: false, error: null },
  // app.js 是恢复证据真源；共享桥不可用时只保留会话级 fail-closed 证据。
  localRecoveries: new Map(),
};

let docMenuListenerBound = false;
const CONFIG_REMOTE_RECOVERY_STORAGE_KEY = "514cc-config-remote-recovery-v1";

function esc(text) {
  return String(text ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function recoveryBridge() {
  return typeof window !== "undefined" ? window.__514ccConfigRemoteRecovery : null;
}

function persistedRecoveriesForHost(hostId) {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(CONFIG_REMOTE_RECOVERY_STORAGE_KEY);
    // hosts-panel 比 app.js 先加载；桥尚未装载且没有可验证持久化快照时禁止短暂放行。
    if (raw == null) return null;
    const saved = JSON.parse(raw);
    if (saved?.schema !== 1 || !Array.isArray(saved.records)) return null;
    return saved.records.filter((record) => record?.hostId === hostId && record?.transactionId);
  } catch {
    return null;
  }
}

function recoveryBridgeReady(bridge) {
  try {
    const readiness = bridge?.isReady ?? bridge?.ledgerReady;
    return typeof readiness === "function" ? readiness.call(bridge) === true : readiness === true;
  } catch {
    return false;
  }
}

/** 同一主机任一未和解事务都阻断写入；共享桥不可用/异常时按持久化证据 fail-closed。 */
function isHostRecoveryBlocked(hostId) {
  if (!hostId) return true;
  const bridge = recoveryBridge();
  if (typeof bridge?.isHostBlocked === "function") {
    try {
      if (!recoveryBridgeReady(bridge)) return true;
      const pending = state.localRecoveries.get(hostId);
      if (pending && typeof bridge.remember === "function") {
        const remembered = bridge.remember(hostId, pending, "sync");
        if (remembered && bridge.isHostBlocked(hostId) === true) state.localRecoveries.delete(hostId);
        else return true;
      }
      return bridge.isHostBlocked(hostId) !== false;
    } catch {
      return true;
    }
  }
  if (state.localRecoveries.has(hostId)) return true;
  const persisted = persistedRecoveriesForHost(hostId);
  return persisted === null || persisted.length > 0;
}

function guardHostWrite(root, hostId, actionLabel) {
  if (!isHostRecoveryBlocked(hostId)) return false;
  actionResult(root, `<div class="waveg-review is-error"><strong>${esc(actionLabel)}已阻止</strong><p class="subtle">该主机存在未核对的远端事务。请先到配置图谱核对事务，再执行新的写入操作。</p></div>`);
  return true;
}

function resultRequiresRecovery(value) {
  const input = value?.payload ?? value ?? {};
  const error = input?.error && typeof input.error === "object" ? input.error : {};
  const recovery = error?.recovery && typeof error.recovery === "object"
    ? error.recovery
    : input?.recovery && typeof input.recovery === "object"
      ? input.recovery
      : {};
  const pick = (field) => recovery[field] ?? error[field] ?? input[field] ?? value?.[field];
  return pick("recoveryRequired") === true || pick("status") === "recovery_required" || Object.keys(recovery).length > 0;
}

function rememberSyncRecovery(hostId, value) {
  if (!resultRequiresRecovery(value)) return false;
  state.localRecoveries.set(hostId, value);
  const bridge = recoveryBridge();
  try {
    if (typeof bridge?.remember === "function") {
      const remembered = bridge.remember(hostId, value, "sync");
      if (remembered && typeof bridge.isHostBlocked === "function" && bridge.isHostBlocked(hostId) === true) {
        state.localRecoveries.delete(hostId);
      }
      return true;
    }
  } catch {
    // 桥异常时仍必须阻断，不能把 recovery_required 当普通失败放过。
  }
  return true;
}

function plannedSyncSelections(files, selectedIds, secretIds) {
  const secrets = new Set(secretIds);
  return selectedIds.map((id) => {
    const file = files.find((entry) => entry.id === id);
    return { id: file?.id ?? id, digest: file?.digest ?? null, allowSecrets: secrets.has(id) };
  });
}

function configSyncResultMarkup(result) {
  const entries = Array.isArray(result?.results) ? result.results : [];
  const recoveryRequired = resultRequiresRecovery(result);
  const complete = result?.complete === true && !recoveryRequired && entries.length > 0 && entries.every((entry) => entry?.ok === true);
  const title = recoveryRequired
    ? "同步状态不确定，远端写入已阻断，请核对事务"
    : complete
      ? `同步完成（远端 HOME=${String(result?.home ?? "?")}）`
      : result?.status === "rolled_back"
        ? "同步未完成，远端改动已回滚"
        : "同步未完成";
  const lines = entries.map((entry) => {
    const label = entry?.label ?? entry?.id ?? "未知文件";
    const remote = entry?.remote ?? "未知目标";
    const suffix = entry?.ok === true
      ? `（${String(entry?.bytes ?? 0)}B）`
      : `：${String(entry?.error ?? "未知错误")}`;
    return `${entry?.ok === true ? "已写入" : "失败"} ${String(label)} → ${String(remote)}${suffix}`;
  }).join("\n");
  return {
    complete,
    recoveryRequired,
    html: `<div class="waveg-review${recoveryRequired ? " is-error" : ""}"><strong>${esc(title)}</strong><div class="waveg-log">${esc(lines)}</div></div>`,
  };
}

async function refresh(root) {
  try {
    state.hosts = (await request("/api/ssh/hosts"))?.hosts ?? [];
  } catch (error) {
    if (/REMOTE_GATE/.test(error.message || "")) {
      root.innerHTML = `
        <div class="forge-empty-waveg">
          ${lucideIcon("lock", "icon lucide icon-lg")}
          <h2>远程主机门闸未开放</h2>
          <p class="subtle">${esc(error.message)}</p>
        </div>`;
      return;
    }
    state.hosts = [];
  }
  // 清理已移除主机的探测缓存
  const alive = new Set(state.hosts.map((host) => host.id));
  for (const id of [...state.probes.keys()]) if (!alive.has(id)) state.probes.delete(id);
  render(root);
  autoProbe(root);
}

/* —— 状态探测（如实，不伪造在线）—— */

function statusInner(host, probe) {
  if (host.enabled === false) return `<span class="sshconn-dot is-off"></span>已停用`;
  switch (probe?.phase) {
    case "probing": return `<span class="sshconn-dot is-probing"></span>探测中…`;
    case "ok": return `<span class="sshconn-dot is-ok"></span>已连接`;
    case "unconfirmed": return `<span class="sshconn-dot is-warn"></span>待确认指纹`;
    case "fail": return `<span class="sshconn-dot is-fail"></span>不可达`;
    default: return `<span class="sshconn-dot"></span>未探测`;
  }
}

function paintStatus(root, host) {
  const el = root.querySelector(`[data-host-status="${host.id}"]`);
  if (!el) return;
  const probe = state.probes.get(host.id) ?? { phase: "idle" };
  el.innerHTML = statusInner(host, probe);
  el.title = probe.phase === "fail" && probe.message ? `不可达：${probe.message}` : "点击重新探测";
}

async function probeHost(root, id) {
  const host = state.hosts.find((entry) => entry.id === id);
  if (!host) return;
  if (host.enabled === false) {
    state.probes.set(id, { phase: "idle" });
    paintStatus(root, host);
    return;
  }
  state.probes.set(id, { phase: "probing" });
  paintStatus(root, host);
  try {
    await request(`/api/ssh/hosts/${id}/test`, { method: "POST", body: JSON.stringify({}) });
    state.probes.set(id, { phase: "ok" });
  } catch (error) {
    const code = error?.payload?.code ?? "";
    if (code === "SSH_HOSTKEY_UNCONFIRMED" || code === "SSH_HOSTKEY_CHANGED") state.probes.set(id, { phase: "unconfirmed" });
    else if (code === "SSH_HOST_DISABLED") state.probes.set(id, { phase: "idle" });
    else state.probes.set(id, { phase: "fail", message: error.message });
  }
  paintStatus(root, host);
}

function autoProbe(root) {
  for (const host of state.hosts) {
    if (host.enabled === false) continue;
    const probe = state.probes.get(host.id);
    if (probe && (probe.phase === "ok" || probe.phase === "probing")) continue;
    void probeHost(root, host.id);
  }
}

/* —— 行渲染 —— */

function rowHtml(host) {
  const probe = state.probes.get(host.id) ?? { phase: "idle" };
  const off = host.enabled === false;
  const writeBlocked = isHostRecoveryBlocked(host.id);
  const blockedTitle = "存在未核对的远端事务；请先到配置图谱核对";
  const blockedAttrs = writeBlocked ? ` disabled title="${blockedTitle}"` : "";
  return `
    <div class="sshconn-row${off ? " is-off" : ""}" data-host-row="${host.id}">
      <button type="button" class="sshconn-toggle${off ? "" : " is-on"}" data-host-toggle="${host.id}"${writeBlocked ? " disabled" : ""}
              role="switch" aria-checked="${off ? "false" : "true"}" title="${writeBlocked ? blockedTitle : off ? "启用" : "停用"}">
        <span class="sshconn-toggle-thumb"></span>
      </button>
      <span class="sshconn-row-icon">${lucideIcon("globe", "icon lucide")}</span>
      <div class="sshconn-main">
        <div class="sshconn-name">
          ${esc(host.name)}
          ${host.trusted ? "" : `<span class="sshconn-badge is-warn">待确认指纹</span>`}
        </div>
        <button type="button" class="sshconn-status" data-host-status="${host.id}" title="点击重新探测">${statusInner(host, probe)}</button>
        <span class="sshconn-addr">${esc(host.user)}@${esc(host.host)}:${host.port}${host.hasSecret ? " · 凭据已登记" : ""}</span>
      </div>
      <div class="sshconn-actions">
        <button type="button" class="icon-button" data-host-exec="${host.id}"${writeBlocked ? " disabled" : ""} title="${writeBlocked ? blockedTitle : "执行命令"}" aria-label="执行命令">${lucideIcon("square-terminal", "icon lucide")}</button>
        <button type="button" class="icon-button" data-host-sftp="${host.id}" title="SFTP 浏览" aria-label="SFTP 浏览">${lucideIcon("folder", "icon lucide")}</button>
        <div class="sshconn-menu-wrap">
          <button type="button" class="icon-button" data-host-menu="${host.id}" title="更多操作" aria-label="更多操作">⋯</button>
          <div class="sshconn-menu" hidden>
            <button type="button" data-host-probe="${host.id}">${lucideIcon("activity", "icon lucide")} 远程探测</button>
            <button type="button" data-host-syncconfig="${host.id}"${blockedAttrs}>${lucideIcon("cloud-upload", "icon lucide")} 同步本机配置</button>
            <button type="button" data-host-trust="${host.id}"${blockedAttrs}>${lucideIcon("fingerprint", "icon lucide")} 确认指纹</button>
            <button type="button" data-host-sync="${host.id}"${blockedAttrs}>${lucideIcon("refresh-cw", "icon lucide")} 同步 ssh config</button>
            <button type="button" class="is-danger" data-host-delete="${host.id}"${blockedAttrs}>${lucideIcon("trash-2", "icon lucide")} 移除</button>
          </div>
        </div>
      </div>
    </div>`;
}

function render(root) {
  root.innerHTML = `
    <div class="sshconn-head">
      <div class="sshconn-head-text">
        <h2>来自此电脑的 SSH 连接</h2>
        <p class="subtle">状态点按需如实探测，不伪造在线；toggle 是启用开关，停用即拒连。</p>
      </div>
      <div class="sshconn-head-actions">
        <button type="button" class="button" id="hosts-reprobe">${lucideIcon("refresh-cw", "icon lucide")} 探测状态</button>
        <button type="button" class="button primary" id="hosts-add">${lucideIcon("plus", "icon lucide")} 添加</button>
      </div>
    </div>

    <div class="sshconn-list">
      ${state.hosts.map((host) => rowHtml(host) + detailHtml(host)).join("") || `
        <div class="sshconn-empty">
          ${lucideIcon("satellite-dish", "icon lucide icon-lg")}
          <p>还没有 SSH 连接。点「添加」自动识别 ~/.ssh/config 里已配置的主机，或手动登记。</p>
        </div>`}
    </div>

    <div id="host-action-result"></div>

    <h2 class="waveg-section-title">${lucideIcon("folder", "icon lucide")} SFTP 浏览</h2>
    <div class="waveg-form">
      <div class="waveg-form-row">
        <label>路径<input class="input" id="sftp-path" type="text" value="${esc(state.sftp.path)}" placeholder="/srv/data" /></label>
      </div>
      <div class="waveg-card-actions">
        <button type="button" class="button" id="sftp-list" ${state.sftp.hostId ? "" : "disabled"}>${lucideIcon("list", "icon lucide")} 列目录</button>
      </div>
      <div class="waveg-log" id="sftp-result">${state.sftp.fileContent != null
        ? esc(state.sftp.fileContent)
        : state.sftp.items.map((item) => `${item.isDirectory ? "[目录]" : "[文件]"} ${esc(item.name)}\t${item.size}B`).join("\n") || "先在某台主机行上点 SFTP 图标，再列目录。"}</div>
    </div>`;

  wireRows(root);
  root.querySelector("#hosts-add")?.addEventListener("click", () => void openAddDialog(root));
  root.querySelector("#hosts-reprobe")?.addEventListener("click", () => {
    for (const host of state.hosts) state.probes.set(host.id, { phase: "idle" });
    for (const host of state.hosts) paintStatus(root, host);
    autoProbe(root);
  });
  root.querySelector("#sftp-list")?.addEventListener("click", () => void sftpList(root));

  if (!docMenuListenerBound) {
    docMenuListenerBound = true;
    document.addEventListener("click", () => {
      document.querySelectorAll(".sshconn-menu").forEach((menu) => { menu.hidden = true; });
    });
  }
}

function wireRows(root) {
  root.querySelectorAll("[data-host-toggle]").forEach((button) => {
    button.addEventListener("click", () => void toggleHost(root, button.dataset.hostToggle));
  });
  root.querySelectorAll("[data-host-status]").forEach((button) => {
    button.addEventListener("click", () => void probeHost(root, button.dataset.hostStatus));
  });
  root.querySelectorAll("[data-host-exec]").forEach((button) => {
    button.addEventListener("click", () => void execOnHost(root, button.dataset.hostExec));
  });
  root.querySelectorAll("[data-host-sftp]").forEach((button) => {
    button.addEventListener("click", () => {
      state.sftp.hostId = button.dataset.hostSftp;
      state.sftp.fileContent = null;
      render(root);
      root.querySelector("#sftp-path")?.focus();
    });
  });
  root.querySelectorAll("[data-host-menu]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = button.parentElement?.querySelector(".sshconn-menu");
      const willOpen = menu?.hidden;
      root.querySelectorAll(".sshconn-menu").forEach((entry) => { entry.hidden = true; });
      if (menu && willOpen) {
        // 方向自适应：视口下方空间不足一个菜单高度时向上展开（列表 overflow 不裁切，但贴底行下展开会出视口）
        const spaceBelow = window.innerHeight - button.getBoundingClientRect().bottom;
        menu.classList.toggle("is-up", spaceBelow < 160);
        menu.hidden = false;
      }
    });
  });
  root.querySelectorAll("[data-host-trust]").forEach((button) => {
    button.addEventListener("click", () => void trustHost(root, button.dataset.hostTrust));
  });
  root.querySelectorAll("[data-host-probe]").forEach((button) => {
    button.addEventListener("click", () => void probeHostEnv(root, button.dataset.hostProbe));
  });
  root.querySelectorAll("[data-host-syncconfig]").forEach((button) => {
    const host = state.hosts.find((entry) => entry.id === button.dataset.hostSyncconfig);
    if (host) button.addEventListener("click", () => void openSyncConfigDialog(root, host));
  });
  root.querySelectorAll("[data-host-detail-close]").forEach((button) => {
    button.addEventListener("click", () => {
      state.envExpanded.delete(button.dataset.hostDetailClose);
      render(root);
    });
  });
  root.querySelectorAll("[data-install-cli]").forEach((button) => {
    button.addEventListener("click", () => {
      const [hostId, toolId] = String(button.dataset.installCli).split(":");
      void installCliRemote(root, hostId, toolId);
    });
  });
  root.querySelectorAll("[data-host-sync]").forEach((button) => {
    button.addEventListener("click", () => void syncConfig(root, button.dataset.hostSync));
  });
  root.querySelectorAll("[data-host-delete]").forEach((button) => {
    button.addEventListener("click", () => void deleteHost(root, button.dataset.hostDelete));
  });
}

function actionResult(root, html) {
  const box = root.querySelector("#host-action-result");
  if (box) box.innerHTML = html;
}

/* —— 启用开关 —— */

async function toggleHost(root, id) {
  if (guardHostWrite(root, id, "切换主机状态")) return;
  const host = state.hosts.find((entry) => entry.id === id);
  if (!host) return;
  const next = host.enabled === false;
  try {
    const result = await request(`/api/ssh/hosts/${id}/enabled`, { method: "POST", body: JSON.stringify({ enabled: next }) });
    host.enabled = result?.host?.enabled !== false;
  } catch (error) {
    actionResult(root, `<div class="waveg-review"><strong>${next ? "启用" : "停用"}失败</strong><p class="subtle">${esc(error.message)}</p></div>`);
    return;
  }
  const row = root.querySelector(`[data-host-row="${id}"]`);
  const toggle = root.querySelector(`[data-host-toggle="${id}"]`);
  if (row) row.classList.toggle("is-off", host.enabled === false);
  if (toggle) {
    toggle.classList.toggle("is-on", host.enabled !== false);
    toggle.setAttribute("aria-checked", String(host.enabled !== false));
    toggle.title = host.enabled === false ? "启用" : "停用";
  }
  state.probes.set(id, { phase: "idle" });
  paintStatus(root, host);
  if (host.enabled !== false) void probeHost(root, id);
}

/* —— 添加对话框（自动发现 + 手动添加）—— */

function ensureDialog() {
  let dialog = document.getElementById("ssh-add-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "ssh-add-dialog";
    dialog.className = "action-dialog sshconn-dialog";
    document.body.appendChild(dialog);
    dialog.addEventListener("close", () => {
      state.dialog.mode = "discover";
      state.dialog.selected = new Set();
    });
  }
  return dialog;
}

function isRegistered(entry) {
  return state.hosts.some((host) => (
    host.name === entry.alias
    || (host.host === entry.host && Number(host.port) === Number(entry.port) && (!entry.user || host.user === entry.user))
  ));
}

async function openAddDialog(root) {
  const dialog = ensureDialog();
  state.dialog.mode = "discover";
  renderDialog(root);
  if (!dialog.open) dialog.showModal();
  await loadDiscover(root);
}

async function loadDiscover(root) {
  state.dialog.loaded = false;
  state.dialog.error = null;
  renderDialog(root);
  try {
    const result = await request("/api/ssh/discover");
    state.dialog.discovered = result?.hosts ?? [];
    state.dialog.source = result?.source ?? null;
    state.dialog.defaultUser = result?.defaultUser ?? null;
  } catch (error) {
    state.dialog.error = error.message;
    state.dialog.discovered = [];
    state.dialog.source = null;
  }
  state.dialog.loaded = true;
  // 默认勾选全部可导入条目（已登记的置灰不选）
  state.dialog.selected = new Set(state.dialog.discovered.filter((entry) => !isRegistered(entry)).map((entry) => entry.alias));
  renderDialog(root);
}

function discoverListHtml() {
  if (!state.dialog.loaded) return `<p class="subtle">正在扫描 ~/.ssh/config …</p>`;
  if (state.dialog.error) {
    return `
      <p class="subtle">扫描失败：${esc(state.dialog.error)}</p>
      <button type="button" class="button" data-dialog-rescan>${lucideIcon("refresh-cw", "icon lucide")} 重新扫描</button>`;
  }
  if (!state.dialog.discovered.length) {
    return `<p class="subtle">未在 ${esc(state.dialog.source ?? "~/.ssh/config")} 发现可导入的主机。可用下方「手动添加」。</p>`;
  }
  return `
    <div class="sshconn-discover-list">
      ${state.dialog.discovered.map((entry) => {
        const registered = isRegistered(entry);
        return `
          <label class="sshconn-discover-row${registered ? " is-registered" : ""}">
            ${lucideIcon("server", "icon lucide")}
            <span class="sshconn-discover-main">
              <span class="sshconn-discover-alias">${esc(entry.alias)}${entry.knownFingerprint ? ` <span class="sshconn-badge is-ok">known_hosts 已信任</span>` : ""}</span>
              <span class="sshconn-discover-host">${esc(entry.host)}${entry.port !== 22 ? `:${entry.port}` : ""}${entry.user ? ` · ${esc(entry.user)}` : state.dialog.defaultUser ? ` · ${esc(state.dialog.defaultUser)}（缺省）` : ""}</span>
            </span>
            ${registered
              ? `<span class="sshconn-badge">已登记</span>`
              : `<input type="checkbox" class="sshconn-check" data-discover-check="${esc(entry.alias)}" ${state.dialog.selected.has(entry.alias) ? "checked" : ""} />`}
          </label>`;
      }).join("")}
    </div>`;
}

function manualFormHtml() {
  return `
    <div class="sshconn-manual">
      <label class="field"><span class="field-label">名称</span><input class="input" id="sshdlg-name" type="text" placeholder="生产盒 01" /></label>
      <label class="field"><span class="field-label">主机</span><input class="input" id="sshdlg-host" type="text" placeholder="192.168.1.10 或 host.example.com" /></label>
      <div class="sshconn-manual-pair">
        <label class="field"><span class="field-label">端口</span><input class="input" id="sshdlg-port" type="number" value="22" /></label>
        <label class="field"><span class="field-label">用户</span><input class="input" id="sshdlg-user" type="text" placeholder="lo" /></label>
      </div>
      <label class="field"><span class="field-label">密码（可选，与私钥/agent 二选一）</span><input class="input" id="sshdlg-password" type="password" autocomplete="off" /></label>
      <label class="field"><span class="field-label">私钥路径（可选，缺省自动试 ~/.ssh 默认密钥与 ssh-agent）</span><input class="input" id="sshdlg-keyfile" type="text" placeholder="~/.ssh/id_ed25519" /></label>
      <label class="field"><span class="field-label">SFTP 根白名单（逗号分隔，可选）</span><input class="input" id="sshdlg-roots" type="text" placeholder="/srv/data,/home/lo" /></label>
      <p class="subtle">凭据只写入本机 secrets 台账，API 永不回显。首次连接需确认主机指纹后才放行。</p>
      <p class="subtle" id="sshdlg-msg"></p>
    </div>`;
}

function renderDialog(root) {
  const dialog = ensureDialog();
  const isDiscover = state.dialog.mode === "discover";
  dialog.innerHTML = `
    <div class="dialog-heading">
      <div>
        <span class="eyebrow">远程主机</span>
        <h2>${isDiscover ? "添加 SSH 连接" : "手动添加"}</h2>
      </div>
      <button type="button" class="icon-button" data-dialog-close aria-label="关闭对话框" title="关闭">${lucideIcon("x", "icon lucide")}</button>
    </div>
    <div class="dialog-body">
      ${isDiscover ? discoverListHtml() : manualFormHtml()}
    </div>
    <div class="dialog-actions">
      ${isDiscover ? `
        <button type="button" class="button" data-dialog-manual>${lucideIcon("pencil", "icon lucide")} 手动添加</button>
        <span class="dialog-actions-spacer"></span>
        <button type="button" class="button secondary" data-dialog-close>取消</button>
        <button type="button" class="button primary" data-dialog-import ${state.dialog.selected.size ? "" : "disabled"}>添加${state.dialog.selected.size ? `（${state.dialog.selected.size}）` : ""}</button>` : `
        <button type="button" class="button" data-dialog-back>返回列表</button>
        <span class="dialog-actions-spacer"></span>
        <button type="button" class="button secondary" data-dialog-close>取消</button>
        <button type="button" class="button primary" data-dialog-create>登记主机</button>`}
    </div>`;

  dialog.querySelectorAll("[data-dialog-close]").forEach((button) => {
    button.addEventListener("click", () => dialog.close());
  });
  dialog.querySelector("[data-dialog-manual]")?.addEventListener("click", () => {
    state.dialog.mode = "manual";
    renderDialog(root);
  });
  dialog.querySelector("[data-dialog-back]")?.addEventListener("click", () => {
    state.dialog.mode = "discover";
    renderDialog(root);
  });
  dialog.querySelector("[data-dialog-rescan]")?.addEventListener("click", () => void loadDiscover(root));
  dialog.querySelectorAll("[data-discover-check]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.dialog.selected.add(checkbox.dataset.discoverCheck);
      else state.dialog.selected.delete(checkbox.dataset.discoverCheck);
      const importButton = dialog.querySelector("[data-dialog-import]");
      if (importButton) {
        importButton.disabled = !state.dialog.selected.size;
        importButton.textContent = `添加${state.dialog.selected.size ? `（${state.dialog.selected.size}）` : ""}`;
      }
    });
  });
  dialog.querySelector("[data-dialog-import]")?.addEventListener("click", () => void importSelected(root));
  dialog.querySelector("[data-dialog-create]")?.addEventListener("click", () => void createFromDialog(root, dialog));
}

async function importSelected(root) {
  const dialog = ensureDialog();
  const entries = state.dialog.discovered.filter((entry) => state.dialog.selected.has(entry.alias));
  if (!entries.length) return;
  let created = 0;
  let inherited = 0;
  const failed = [];
  for (const entry of entries) {
    const user = entry.user || state.dialog.defaultUser || "";
    if (!user) {
      failed.push(`${entry.alias}：缺用户（config 未写 User，本机用户名也不可得）`);
      continue;
    }
    try {
      const result = await request("/api/ssh/hosts", {
        method: "POST",
        body: JSON.stringify({
          name: entry.alias, host: entry.host, port: entry.port, user, auth: {},
          identityFile: entry.identityFile ?? undefined, // undefined 被 JSON 丢弃，null 不覆盖旧语义
        }),
      });
      created += 1;
      // known_hosts 已信任的主机键直接继承，登记完即是可信状态
      if (entry.knownFingerprint && result?.host?.id) {
        try {
          await request(`/api/ssh/hosts/${result.host.id}/trust`, { method: "POST", body: JSON.stringify({ fingerprint: entry.knownFingerprint }) });
          inherited += 1;
        } catch { /* 继承失败不阻断登记，后续走一键确认 */ }
      }
    } catch (error) {
      failed.push(`${entry.alias}：${error.message}`);
    }
  }
  dialog.close();
  await refresh(root);
  actionResult(root, `
    <div class="waveg-review">
      <strong>${lucideIcon("check", "icon lucide")} 已登记 ${created} 台主机${inherited ? `，其中 ${inherited} 台已继承 known_hosts 信任` : ""}</strong>
      ${failed.length ? `<p class="subtle">${failed.map(esc).join("；")}</p>` : ""}
    </div>`);
}

async function createFromDialog(root, dialog) {
  const payload = {
    name: dialog.querySelector("#sshdlg-name")?.value?.trim() || "",
    host: dialog.querySelector("#sshdlg-host")?.value?.trim() || "",
    port: Number(dialog.querySelector("#sshdlg-port")?.value) || 22,
    user: dialog.querySelector("#sshdlg-user")?.value?.trim() || "",
    auth: {},
    rootAllowlist: (dialog.querySelector("#sshdlg-roots")?.value || "").split(",").map((entry) => entry.trim()).filter(Boolean),
  };
  const password = dialog.querySelector("#sshdlg-password")?.value || "";
  if (password) payload.auth.password = password;
  const keyfile = dialog.querySelector("#sshdlg-keyfile")?.value?.trim() || "";
  if (keyfile) payload.identityFile = keyfile;
  const msg = dialog.querySelector("#sshdlg-msg");
  try {
    await request("/api/ssh/hosts", { method: "POST", body: JSON.stringify(payload) });
    dialog.close();
    await refresh(root);
  } catch (error) {
    if (msg) msg.textContent = `登记失败：${error.message}`;
  }
}

/* —— v41 波一：远程环境探测卡 / CLI 安装 / 一键同步本机配置 —— */

function detailHtml(host) {
  if (!state.envExpanded.has(host.id)) return "";
  const env = state.envProbes.get(host.id);
  let body;
  if (!env || env.status === "loading") {
    body = `<p class="subtle">正在探测远程环境（OS / Shell / CLI 矩阵）…</p>`;
  } else if (env.status === "error") {
    body = `<p class="subtle">探测失败：${esc(env.error)}</p>`;
  } else {
    const probe = env.data ?? {};
    body = `
      <div class="sshconn-env-grid">
        <span>OS</span><b>${esc(probe.os ?? "?")}</b>
        <span>Shell</span><b>${esc(probe.shell ?? "?")}</b>
        <span>Home</span><b>${esc(probe.home ?? "?")}</b>
        <span>磁盘</span><b>${esc(probe.disk ?? "?")}</b>
        <span>内存</span><b>${esc(probe.memory ?? "?")}</b>
      </div>
      <div class="sshconn-clis">
        ${(probe.clis ?? []).map((cli) => `
          <div class="sshconn-cli${cli.installed ? "" : " is-missing"}">
            <span class="sshconn-cli-name">${esc(cli.label)}</span>
            <code>${esc(cli.command)}</code>
            ${cli.installed
              ? `<span class="sshconn-cli-ver" title="${esc(cli.rawVersion ?? "")}">${esc(cli.version ?? "已安装")}</span>`
              : `<span class="subtle">未安装</span>
                 <button type="button" class="button mini" data-install-cli="${host.id}:${cli.id}"${isHostRecoveryBlocked(host.id) ? ' disabled title="存在未核对的远端事务；请先到配置图谱核对"' : ""}>安装</button>`}
          </div>`).join("")}
      </div>`;
  }
  return `<div class="sshconn-detail" data-host-detail="${host.id}">
    <div class="sshconn-detail-head">
      <strong>${lucideIcon("activity", "icon lucide")} 远程环境</strong>
      <button type="button" class="icon-button" data-host-detail-close="${host.id}" title="收起" aria-label="收起">${lucideIcon("x", "icon lucide")}</button>
    </div>
    ${body}
  </div>`;
}

async function probeHostEnv(root, id) {
  state.envExpanded.add(id);
  state.envProbes.set(id, { status: "loading" });
  render(root);
  try {
    const result = await request(`/api/ssh/hosts/${id}/probe`, { method: "POST", body: JSON.stringify({}) });
    state.envProbes.set(id, { status: "ok", data: result?.probe ?? null });
  } catch (error) {
    state.envProbes.set(id, { status: "error", error: error.message });
  }
  render(root);
}

/** 远程安装 CLI：确认对话框明示命令全文，结果如实回显，成功后重探测刷新矩阵。 */
async function installCliRemote(root, hostId, toolId) {
  if (guardHostWrite(root, hostId, "远程安装")) return;
  const host = state.hosts.find((entry) => entry.id === hostId);
  const env = state.envProbes.get(hostId);
  const cli = env?.data?.clis?.find((entry) => entry.id === toolId);
  const platform = /darwin/i.test(env?.data?.os ?? "") ? "darwin" : "linux";
  const confirmed = await confirmRemoteAction({
    eyebrow: "远程安装",
    title: `在 ${host?.name ?? hostId} 安装 ${cli?.label ?? toolId}？`,
    body: `<p class="subtle">将经 SSH 执行官方安装命令（输出如实回显，失败不伪造成功）：</p><code class="sshconn-fp">${esc(cli?.command ?? toolId)} 的官方安装通道（npm i -g / 官方脚本）</code>`,
    confirmLabel: "执行安装",
  });
  if (!confirmed) return;
  if (guardHostWrite(root, hostId, "远程安装")) return;
  actionResult(root, `<p class="subtle">正在安装 ${esc(cli?.label ?? toolId)}（最长 120s）…</p>`);
  try {
    const result = await request(`/api/ssh/hosts/${hostId}/install-cli`, { method: "POST", body: JSON.stringify({ toolId, platform }) });
    actionResult(root, `
      <div class="waveg-review">
        <strong>${result.ok ? lucideIcon("check", "icon lucide") + " 安装完成" : `安装失败（退出码 ${result.code ?? "?"}）`}：${esc(result.display ?? "")}</strong>
        <div class="waveg-log">${esc(result.stdout || "")}${result.stderr ? `\n[stderr]\n${esc(result.stderr)}` : ""}</div>
      </div>`);
    if (result.ok) await probeHostEnv(root, hostId);
  } catch (error) {
    actionResult(root, `<div class="waveg-review"><strong>安装失败</strong><p class="subtle">${esc(error.message)}</p></div>`);
  }
}

/** 通用远程操作确认框（页内 dialog，替代哑弹 window.confirm）。 */
function confirmRemoteAction({ eyebrow, title, body, confirmLabel }) {
  return new Promise((resolve) => {
    const dialog = ensureModal("ssh-remote-action-dialog");
    dialog.innerHTML = `
      <div class="dialog-heading">
        <div><span class="eyebrow">${esc(eyebrow)}</span><h2>${esc(title)}</h2></div>
        <button type="button" class="icon-button" data-act="cancel" aria-label="关闭对话框" title="关闭">${lucideIcon("x", "icon lucide")}</button>
      </div>
      <div class="dialog-body">${body}</div>
      <div class="dialog-actions">
        <button type="button" class="button secondary" data-act="cancel">取消</button>
        <button type="button" class="button primary" data-act="ok">${esc(confirmLabel)}</button>
      </div>`;
    const done = (value) => { if (dialog.open) dialog.close(); resolve(value); };
    dialog.querySelectorAll('[data-act="cancel"]').forEach((button) => button.addEventListener("click", () => done(false)));
    dialog.querySelector('[data-act="ok"]')?.addEventListener("click", () => done(true));
    dialog.addEventListener("close", () => resolve(false), { once: true });
    dialog.showModal();
  });
}

/** 一键同步本机配置：plan 列清单（含 secret 红字警示）→ 显式勾选确认 → 逐文件推送回报。 */
async function openSyncConfigDialog(root, host) {
  if (guardHostWrite(root, host?.id, "同步配置")) return;
  const dialog = ensureModal("ssh-syncconfig-dialog");
  dialog.innerHTML = `<div class="dialog-heading"><div><span class="eyebrow">同步配置</span><h2>同步到 ${esc(host.name)}</h2></div></div><div class="dialog-body"><p class="subtle">正在读取本机配置清单…</p></div>`;
  if (!dialog.open) dialog.showModal();
  let plan;
  try {
    plan = await request(`/api/ssh/hosts/${host.id}/env-sync/plan`);
  } catch (error) {
    dialog.querySelector(".dialog-body").innerHTML = `<p class="subtle">读取失败：${esc(error.message)}</p>`;
    return;
  }
  const files = plan?.files ?? [];
  dialog.innerHTML = `
    <div class="dialog-heading">
      <div><span class="eyebrow">同步配置</span><h2>同步到 ${esc(host.name)}</h2></div>
      <button type="button" class="icon-button" data-act="cancel" aria-label="关闭对话框" title="关闭">${lucideIcon("x", "icon lucide")}</button>
    </div>
    <div class="dialog-body">
      <p class="subtle">推送本机运行时实况文件到远端用户主目录同名路径（整文件覆盖远端同名文件）。凭据文件（auth.json / .env）永不在清单内。</p>
      <div class="sshconn-sync-list">
        ${files.map((file) => `
          <label class="sshconn-sync-row${file.exists ? "" : " is-missing"}">
            <input type="checkbox" data-sync-file="${esc(file.id)}" ${file.exists && !file.containsSecrets ? "checked" : ""} ${file.exists ? "" : "disabled"} />
            <span class="sshconn-sync-main">
              <span>${esc(file.label)}${file.containsSecrets ? ` <span class="sshconn-badge is-warn">检测到疑似秘密</span>` : ""}</span>
              <span class="subtle">${esc(file.local)} → ~/${esc(file.remote)}${file.exists ? ` · ${file.size}B` : " · 本机不存在"}</span>
            </span>
          </label>`).join("")}
      </div>
      <p class="subtle" id="syncconfig-msg"></p>
    </div>
    <div class="dialog-actions">
      <button type="button" class="button secondary" data-act="cancel">取消</button>
      <button type="button" class="button primary" data-act="push">${lucideIcon("cloud-upload", "icon lucide")} 推送所选</button>
    </div>`;
  dialog.querySelectorAll('[data-act="cancel"]').forEach((button) => button.addEventListener("click", () => dialog.close()));
  dialog.querySelector('[data-act="push"]')?.addEventListener("click", async () => {
    const selected = [...dialog.querySelectorAll("[data-sync-file]:checked")].map((box) => box.dataset.syncFile);
    const msg = dialog.querySelector("#syncconfig-msg");
    if (!selected.length) {
      if (msg) msg.textContent = "未选择任何文件。";
      return;
    }
    const secretPicks = selected.filter((id) => files.find((file) => file.id === id)?.containsSecrets);
    if (secretPicks.length) {
      const verdict = await confirmRemoteAction({
        eyebrow: "二次确认",
        title: "所选文件含疑似秘密",
        body: `<p class="subtle">${secretPicks.map((id) => esc(files.find((file) => file.id === id)?.label ?? id)).join("、")} 含疑似秘密字面量，将经 SSH 出本机写入远端。确认继续？</p>`,
        confirmLabel: "仍要推送",
      });
      if (!verdict) return;
    }
    if (guardHostWrite(root, host.id, "同步配置")) {
      if (msg) msg.textContent = "该主机出现未核对事务，本次同步已阻止。";
      return;
    }
    if (msg) msg.textContent = "正在推送…";
    try {
      const selections = plannedSyncSelections(files, selected, secretPicks);
      const result = await request(`/api/ssh/hosts/${host.id}/env-sync`, { method: "POST", body: { files: selections } });
      const summary = configSyncResultMarkup(result);
      rememberSyncRecovery(host.id, result);
      dialog.close();
      render(root);
      actionResult(root, summary.html);
    } catch (error) {
      if (rememberSyncRecovery(host.id, error)) {
        dialog.close();
        render(root);
        actionResult(root, `<div class="waveg-review is-error"><strong>同步状态不确定，远端写入已阻断</strong><p class="subtle">${esc(error.message)}</p></div>`);
      } else if (msg) {
        msg.textContent = `推送失败：${error.message}`;
      }
    }
  });
}

/* —— 既有能力：指纹 / exec / 移除 / SFTP —— */
/* 原生 window.confirm/prompt 在桌面壳（Electron 类）里是哑弹——调用被吞立即返回假值， */
/* 看上去就是「点完闪退」（LO 2026-08-11）。一律改走页内 <dialog>。 */

function ensureModal(id) {
  let dialog = document.getElementById(id);
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = id;
    dialog.className = "action-dialog sshconn-dialog";
    document.body.appendChild(dialog);
  }
  return dialog;
}

/** 指纹信任确认对话框：展示捕获的指纹请人工核对，resolve(true)=信任。 */
function confirmTrustDialog(host, fingerprint) {
  return new Promise((resolve) => {
    const dialog = ensureModal("ssh-trust-dialog");
    dialog.innerHTML = `
      <div class="dialog-heading">
        <div>
          <span class="eyebrow">确认指纹</span>
          <h2>信任主机指纹</h2>
        </div>
        <button type="button" class="icon-button" data-act="cancel" aria-label="关闭对话框" title="关闭">${lucideIcon("x", "icon lucide")}</button>
      </div>
      <div class="dialog-body">
        <p>请核对 <strong>${esc(host.name)}</strong>（${esc(host.user)}@${esc(host.host)}:${host.port}）的主机指纹：</p>
        <code class="sshconn-fp">${esc(fingerprint)}</code>
        <p class="subtle">与可信来源（服务器控制台、首次部署记录）核对一致再信任。信任后写入本机 known-hosts 台账；此后指纹变更将拒绝连接并告警。</p>
      </div>
      <div class="dialog-actions">
        <button type="button" class="button secondary" data-act="cancel">取消</button>
        <button type="button" class="button primary" data-act="trust">${lucideIcon("fingerprint", "icon lucide")} 信任并连接</button>
      </div>`;
    const done = (value) => {
      if (dialog.open) dialog.close();
      resolve(value);
    };
    dialog.querySelectorAll('[data-act="cancel"]').forEach((button) => button.addEventListener("click", () => done(false)));
    dialog.querySelector('[data-act="trust"]')?.addEventListener("click", () => done(true));
    dialog.addEventListener("close", () => resolve(false), { once: true }); // Esc/外力关闭；按钮路径先 resolve 者为胜
    dialog.showModal();
  });
}

/** exec 命令输入对话框：resolve(命令字符串) 或 null=取消。 */
function promptCommandDialog(host) {
  return new Promise((resolve) => {
    const dialog = ensureModal("ssh-exec-dialog");
    dialog.innerHTML = `
      <div class="dialog-heading">
        <div>
          <span class="eyebrow">执行命令</span>
          <h2>${esc(host.name)}</h2>
        </div>
        <button type="button" class="icon-button" data-act="cancel" aria-label="关闭对话框" title="关闭">${lucideIcon("x", "icon lucide")}</button>
      </div>
      <div class="dialog-body">
        <label class="field">
          <span class="field-label">命令（超时 30s，输出封顶 256KB 并过脱敏）</span>
          <input class="input" id="ssh-exec-command" type="text" value="uname -a" autocomplete="off" />
        </label>
      </div>
      <div class="dialog-actions">
        <button type="button" class="button secondary" data-act="cancel">取消</button>
        <button type="button" class="button primary" data-act="run">${lucideIcon("square-terminal", "icon lucide")} 执行</button>
      </div>`;
    const input = dialog.querySelector("#ssh-exec-command");
    const done = (value) => {
      if (dialog.open) dialog.close();
      resolve(value);
    };
    dialog.querySelectorAll('[data-act="cancel"]').forEach((button) => button.addEventListener("click", () => done(null)));
    dialog.querySelector('[data-act="run"]')?.addEventListener("click", () => done(input?.value?.trim() || null));
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        done(input.value.trim() || null);
      }
    });
    dialog.addEventListener("close", () => resolve(null), { once: true });
    dialog.showModal();
    input?.focus();
    input?.select();
  });
}

async function trustHost(root, id) {
  if (guardHostWrite(root, id, "确认主机指纹")) return;
  const host = state.hosts.find((entry) => entry.id === id);
  actionResult(root, `<p class="subtle">正在连接获取主机指纹…</p>`);
  let captured;
  try {
    captured = await request(`/api/ssh/hosts/${id}/fingerprint`, { method: "POST", body: JSON.stringify({}) });
  } catch (error) {
    actionResult(root, `<div class="waveg-review"><strong>获取指纹失败</strong><p class="subtle">${esc(error.message)}</p></div>`);
    return;
  }
  actionResult(root, "");
  const confirmed = await confirmTrustDialog(
    host ?? { id, name: id, user: "", host: "", port: "" },
    captured.fingerprint,
  );
  if (!confirmed) return;
  if (guardHostWrite(root, id, "确认主机指纹")) return;
  try {
    await request(`/api/ssh/hosts/${id}/trust`, { method: "POST", body: JSON.stringify({ fingerprint: captured.fingerprint }) });
    state.probes.set(id, { phase: "idle" });
  } catch (error) {
    actionResult(root, `<div class="waveg-review"><strong>信任失败</strong><p class="subtle">${esc(error.message)}</p></div>`);
  }
  await refresh(root);
}

async function execOnHost(root, id) {
  if (guardHostWrite(root, id, "执行远程命令")) return;
  const host = state.hosts.find((entry) => entry.id === id);
  const command = await promptCommandDialog(host ?? { id, name: id });
  if (!command) return;
  if (guardHostWrite(root, id, "执行远程命令")) return;
  actionResult(root, `<p class="subtle">执行中…</p>`);
  try {
    const result = await request(`/api/ssh/hosts/${id}/exec`, { method: "POST", body: JSON.stringify({ command, timeoutMs: 30000 }) });
    actionResult(root, `
      <div class="waveg-review">
        <strong>${lucideIcon("square-terminal", "icon lucide")} 退出码 ${result.code ?? "?"}</strong>
        <div class="waveg-log">${esc(result.stdout || "")}${result.stderr ? `\n[stderr]\n${esc(result.stderr)}` : ""}</div>
      </div>`);
  } catch (error) {
    actionResult(root, `<div class="waveg-review"><strong>执行失败</strong><p class="subtle">${esc(error.message)}</p></div>`);
  }
}

async function deleteHost(root, id) {
  if (guardHostWrite(root, id, "移除主机")) return;
  const host = state.hosts.find((entry) => entry.id === id);
  const confirmed = await confirmRemoteAction({
    eyebrow: "移除远程主机",
    title: `移除 ${host?.name ?? id}？`,
    body: `<p class="subtle">这会从本机 SSH 主机台账移除 <strong>${esc(host?.name ?? id)}</strong>。远端文件不会删除，但该主机的连接、SFTP 和配置入口会立即消失。</p>`,
    confirmLabel: "确认移除",
  });
  if (!confirmed) return;
  if (guardHostWrite(root, id, "移除主机")) return;
  try {
    await request(`/api/ssh/hosts/${id}`, { method: "DELETE" });
    await refresh(root);
    actionResult(root, `<div class="waveg-review"><strong>${lucideIcon("check", "icon lucide")} 主机已移除</strong><p class="subtle">${esc(host?.name ?? id)} 已从本机 SSH 台账移除。</p></div>`);
  } catch (error) {
    actionResult(root, `<div class="waveg-review is-error"><strong>移除失败</strong><p class="subtle">${esc(error.message)}</p></div>`);
  }
}

/** 从 ~/.ssh/config 回同步连接参数（含 IdentityFile 路径）——老台账记录缺 identityFile 的补救通道。 */
async function syncConfig(root, id) {
  if (guardHostWrite(root, id, "同步 SSH 配置")) return;
  actionResult(root, `<p class="subtle">正在对照 ssh config …</p>`);
  try {
    const result = await request(`/api/ssh/hosts/${id}/sync-config`, { method: "POST", body: JSON.stringify({}) });
    const host = result?.host;
    actionResult(root, `
      <div class="waveg-review">
        <strong>${lucideIcon("check", "icon lucide")} 已同步 ${esc(host?.name ?? id)}</strong>
        <p class="subtle">${esc(host?.user ?? "")}@${esc(host?.host ?? "")}:${host?.port ?? ""}${host?.identityFile ? ` · 私钥 ${esc(host.identityFile)}` : " · config 未配 IdentityFile，走默认密钥/agent"}</p>
      </div>`);
    state.probes.set(id, { phase: "idle" });
  } catch (error) {
    actionResult(root, `<div class="waveg-review"><strong>同步失败</strong><p class="subtle">${esc(error.message)}</p></div>`);
    return;
  }
  await refresh(root);
}

async function sftpList(root) {
  if (!state.sftp.hostId) return;
  const path = root.querySelector("#sftp-path")?.value?.trim() || "/";
  state.sftp.path = path;
  const box = root.querySelector("#sftp-result");
  if (box) box.textContent = "读取中…";
  try {
    const result = await request(`/api/ssh/hosts/${state.sftp.hostId}/sftp/list?path=${encodeURIComponent(path)}`);
    state.sftp.items = result?.items ?? [];
    state.sftp.fileContent = null;
  } catch (error) {
    state.sftp.items = [];
    state.sftp.fileContent = `列目录失败：${error.message}`;
  }
  render(root);
}

function bootWhenReady() {
  if (typeof document === "undefined") return;
  const start = () => void apiReady.then(() => {
    const root = document.getElementById("hosts-container");
    if (root) void refresh(root);
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

// v41 波三：远程项目「浏览文件（SFTP）」快显——协作台右键切到本视图并预填主机+路径
if (typeof window !== "undefined") {
  window.addEventListener("forge:config-remote-recovery-changed", (event) => {
    void event;
    const root = document.getElementById("hosts-container");
    if (root) render(root);
  });

  window.addEventListener("forge:hosts-open-sftp", (event) => {
    const { hostId, path } = event.detail || {};
    const root = document.getElementById("hosts-container");
    if (!root || !hostId) return;
    state.sftp.hostId = hostId;
    state.sftp.path = String(path || "/");
    state.sftp.fileContent = null;
    void apiReady.then(async () => {
      if (!state.hosts.length) await refresh(root);
      render(root); // render 用 state.sftp.path 回填 #sftp-path
      void sftpList(root); // sftpList 从 input 读路径，render 已填好
    });
  });
}

bootWhenReady();
