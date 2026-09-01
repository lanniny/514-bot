// modules/settings-rail-chrome.js — Wave B slice 20
// 设置轨导航：表面激活态/工作台快捷/自动化面板显隐/过滤/铬层显隐/入口跳转。
// 工厂 + DI：state/setView/byId 从 app.js 注入。

export function createSettingsRailChrome({
  state,
  setView,
  byId,
}) {
  function isSettingsChrome(view = state.view) {
    return view !== "workbench" && view !== "automations" && view !== "bot";
  }

  function syncSettingsRailActive(view = state.view, surface = state.configSurface) {
    const rail = byId("settings-rail");
    if (!rail) return;
    const workspace = state.capabilityWorkspace;
    const focus = state.settingsFocus;
    // is-active 允许多入口同亮（连接/运行席位都指向 sources 面）；aria-current="page" 必须唯一
    let currentPageMarked = false;
    rail.querySelectorAll(".settings-rail-item").forEach((button) => {
      if (button.classList.contains("settings-rail-back")) return;
      let on = false;
      const jump = button.dataset.configSurfaceJump;
      if (jump) {
        on = view === "config" && surface === jump;
        if (on && button.dataset.capWorkspace) on = workspace === button.dataset.capWorkspace;
      } else if (button.dataset.view === "observability") {
        const wantsMemory = button.dataset.settingsFocus === "memory";
        on = view === "observability" && (wantsMemory ? focus === "memory" : focus !== "memory");
      } else {
        on = Boolean(button.dataset.view) && button.dataset.view === view && view !== "config";
      }
      button.classList.toggle("is-active", on);
      if (on && !currentPageMarked) {
        button.setAttribute("aria-current", "page");
        currentPageMarked = true;
      } else {
        button.removeAttribute("aria-current");
      }
    });
  }

  function syncWorkbenchRailShortcuts(view = state.view, surface = state.configSurface) {
    const skillsRow = byId("rail-skills-row");
    const on = view === "config" && surface === "capabilities";
    skillsRow?.classList.toggle("is-active", on);
    if (on) skillsRow?.setAttribute("aria-current", "page");
    else skillsRow?.removeAttribute("aria-current");
  }

  function revealWorkbenchAutomations(on) {
    const shell = document.querySelector(".workbench-shell");
    const pane = byId("automations-workbench");
    const paneInBotWorkspace = pane?.closest("#bot-workspace-panel");
    byId("view-workbench")?.classList.toggle("is-automations-open", on);
    shell?.classList.toggle("is-automations", on);
    // Bot 工作区会临时挂载同一个自动化节点；此时旧 workbench 的 hidden/inert
    // 状态不能再反向覆盖 Bot 当前可见面板。
    if (pane && !paneInBotWorkspace) {
      pane.hidden = !on;
      pane.inert = !on;
    }
  }

  function settingsRailHaystack(item) {
    let label = "";
    let prev = item.previousElementSibling;
    while (prev) {
      if (prev.classList.contains("settings-rail-label")) {
        label = prev.textContent || "";
        break;
      }
      prev = prev.previousElementSibling;
    }
    return `${item.textContent || ""} ${item.title || ""} ${label} ${item.dataset.view || ""} ${item.dataset.configSurfaceJump || ""}`.toLowerCase();
  }

  function filterSettingsRail(query) {
    const rail = byId("settings-rail");
    if (!rail) return;
    const q = String(query || "").trim().toLowerCase();
    rail.querySelectorAll(".settings-rail-item:not(.settings-rail-back)").forEach((item) => {
      item.hidden = Boolean(q) && !settingsRailHaystack(item).includes(q);
    });
    rail.querySelectorAll(".settings-rail-label").forEach((label) => {
      let next = label.nextElementSibling;
      let visible = false;
      while (next && !next.classList.contains("settings-rail-label")) {
        if (next.classList.contains("settings-rail-item") && !next.hidden) visible = true;
        next = next.nextElementSibling;
      }
      label.hidden = Boolean(q) && !visible;
    });
  }

  function syncSettingsChrome(view = state.view) {
    const settings = isSettingsChrome(view);
    document.querySelector(".app-shell")?.classList.toggle("is-settings", settings);
    const rail = byId("settings-rail");
    if (rail) rail.hidden = !settings;
    if (!settings) {
      const query = byId("settings-rail-query");
      if (query?.value) {
        query.value = "";
        filterSettingsRail("");
      }
    }
    byId("account-dock")?.setAttribute("aria-pressed", String(settings));
    byId("account-heading-chip")?.setAttribute("aria-pressed", String(settings));
  }

  function openSettings(view = "appearance") {
    setView(view && view !== "workbench" ? view : "appearance");
  }

  return {
    isSettingsChrome,
    syncSettingsRailActive,
    syncWorkbenchRailShortcuts,
    revealWorkbenchAutomations,
    filterSettingsRail,
    syncSettingsChrome,
    openSettings,
  };
}
