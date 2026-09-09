// modules/settings-rail-chrome.js — Wave B slice 20
// 设置轨导航：表面激活态/工作台快捷/过滤/铬层显隐/入口跳转。
// 工厂 + DI：state/setView/byId 从 app.js 注入。

export function createSettingsRailChrome({
  state,
  setView,
  byId,
}) {
  function isSettingsChrome(view = state.view) {
    return ["config", "appearance", "browser", "security"].includes(view);
  }

  function syncSettingsRailActive(view = state.view, surface = state.configSurface) {
    const rail = byId("settings-rail");
    if (!rail) return;
    const workspace = state.capabilityWorkspace;
    const focus = state.settingsFocus;
    // Each destination has one owner in the settings navigation.
    let currentPageMarked = false;
    rail.querySelectorAll(".settings-rail-item").forEach((button) => {
      if (button.classList.contains("settings-rail-back")) return;
      let on = false;
      const jump = button.dataset.configSurface ?? button.dataset.configSurfaceJump;
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
      if (button.getAttribute("role") === "tab") {
        button.setAttribute("aria-selected", String(on));
      }
      if (on && !currentPageMarked) {
        button.setAttribute("aria-current", "page");
        currentPageMarked = true;
      } else {
        button.removeAttribute("aria-current");
      }
    });
    syncSettingsTabStop(rail);
  }

  function syncSettingsTabStop(rail) {
    const tabs = [...rail.querySelectorAll(".settings-rail-item")];
    const visible = tabs.filter(button => !button.hidden && !button.disabled);
    const current = visible.find(button => button.classList.contains("is-active")) || visible[0];
    for (const tab of tabs) tab.tabIndex = tab === current ? 0 : -1;
  }

  function handleSettingsRailKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const rail = byId("settings-rail");
    const tabs = [...rail.querySelectorAll(".settings-rail-item")].filter(button => !button.hidden && !button.disabled);
    const current = tabs.indexOf(event.target.closest(".settings-rail-item"));
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click();
    tabs[next].focus({ preventScroll: true });
    tabs[next].scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function toggleSettingsSearch(open = !byId("settings-rail")?.classList.contains("is-search-open")) {
    byId("settings-rail")?.classList.toggle("is-search-open", open);
    byId("settings-search-toggle")?.setAttribute("aria-expanded", String(open));
    const query = byId("settings-rail-query");
    if (open) query?.focus();
    else {
      if (query) query.value = "";
      filterSettingsRail("");
    }
  }

  function handleSettingsQueryKey(event) {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      toggleSettingsSearch(false);
      const toggle = byId("settings-search-toggle");
      if (toggle?.getClientRects().length) toggle.focus();
    } else if (event.key === "ArrowDown" || event.key === "Enter") {
      event.preventDefault();
      const first = [...byId("settings-rail").querySelectorAll(".settings-rail-item")].find(button => !button.hidden && !button.disabled);
      if (!first) return;
      if (event.key === "Enter") first.click();
      first.focus({ preventScroll: true });
      first.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  function syncWorkbenchRailShortcuts(view = state.view, surface = state.configSurface) {
    const skillsRow = byId("rail-skills-row");
    const on = view === "config" && surface === "capabilities";
    skillsRow?.classList.toggle("is-active", on);
    if (on) skillsRow?.setAttribute("aria-current", "page");
    else skillsRow?.removeAttribute("aria-current");
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
    return `${item.textContent || ""} ${item.title || ""} ${label} ${item.dataset.view || ""} ${item.dataset.configSurface || item.dataset.configSurfaceJump || ""}`.toLowerCase();
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
    syncSettingsTabStop(rail);
    const empty = byId("settings-rail-empty");
    const hasResults = [...rail.querySelectorAll(".settings-rail-item")].some(item => !item.hidden);
    if (empty) empty.hidden = hasResults;
    const nav = byId("settings-destinations");
    if (nav) nav.hidden = !hasResults;
  }

  function syncSettingsChrome(view = state.view) {
    const settings = isSettingsChrome(view);
    document.querySelector(".app-shell")?.classList.toggle("is-settings", settings);
    const rail = byId("settings-rail");
    if (rail) rail.hidden = !settings;
    if (!settings) toggleSettingsSearch(false);
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
    filterSettingsRail,
    handleSettingsRailKey,
    handleSettingsQueryKey,
    toggleSettingsSearch,
    syncSettingsChrome,
    openSettings,
  };
}
