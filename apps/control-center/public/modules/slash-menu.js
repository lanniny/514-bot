// slash-menu.js — / 命令菜单渲染/选中/应用（Wave B 切片 8）
//
// 从 app.js 抽取的 Slash 命令集群：菜单渲染/选中/隐藏 + 命令应用。
// LOCAL_SLASH_COMMANDS / fallbackRuntimeSlashCommands / applyRuntimeSlashControl 留在 app.js
// （它们闭包了大量 app.js 全局函数），通过 DI 注入。
import { escapeHtml } from "../utils.js";

export function createSlashMenu({
  elements,
  state,
  byId,
  toast,
  activeComposerTarget,
  LOCAL_SLASH_COMMANDS,
  fallbackRuntimeSlashCommands,
  applyRuntimeSlashControl,
  openRunCliTerminal,
}) {
  function slashCommandsForContext() {
    const agentId = activeComposerTarget().memberId || "";
    const catalog = state.agentControlCatalog;
    const catalogCommands = catalog?.context?.memberId === agentId && Array.isArray(catalog.commands)
      ? catalog.commands
      : [];
    const runtimeCommands = (catalogCommands.length ? catalogCommands.filter((command) => command.execution === "composer-control" || command.control !== "native") : fallbackRuntimeSlashCommands())
      .filter((command) => command.control !== "native")
      .map((command) => ({
        ...command,
        group: "composer",
        apply() { applyRuntimeSlashControl(this); },
      }));
    const nativeCommands = catalogCommands
      .filter((command) => command.control === "native")
      .map((command) => ({
        ...command,
        native: command.execution === "passthrough" || command.execution === "adapter-hook",
        group: "member-native",
        apply() {
          if (command.execution === "cli-attach") {
            toast(command.detail || "请用 /cli 附着原生 TUI", "warning", 2800);
            void openRunCliTerminal();
          }
        },
      }));
    return [...runtimeCommands, ...nativeCommands, ...LOCAL_SLASH_COMMANDS.map((item) => ({ ...item, group: "composer" }))];
  }

  function hideSlashMenu() {
    const menu = byId("slash-menu");
    if (menu) {
      menu.hidden = true;
      menu.innerHTML = "";
    }
    state.slashActive = false;
    state.slashIndex = -1;
    state.slashCandidates = [];
    state.slashRange = null;
    elements["task-input"]?.setAttribute("aria-expanded", "false");
    elements["task-input"]?.removeAttribute("aria-activedescendant");
  }

  function slashQueryAtCursor(textarea) {
    if (!textarea) return null;
    const value = textarea.value;
    const caret = textarea.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const match = before.match(/(^|[\s\n])\/([A-Za-z0-9_-]*(?:[ \t]+[A-Za-z0-9._:/-]*)?)$/);
    if (!match) return null;
    return {
      start: caret - match[2].length - 1,
      end: caret,
      query: match[2].toLowerCase().replace(/[ \t]+/g, " "),
    };
  }

  function syncSlashActiveOption() {
    const menu = byId("slash-menu");
    const textarea = elements["task-input"];
    if (!menu || !textarea) return;
    menu.querySelectorAll(".slash-item").forEach((element, index) => {
      const active = index === state.slashIndex;
      element.classList.toggle("is-active", active);
      element.setAttribute("aria-selected", String(active));
      if (active) {
        textarea.setAttribute("aria-activedescendant", element.id);
        element.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function renderSlashMenu() {
    const menu = byId("slash-menu");
    const textarea = elements["task-input"];
    if (!menu || !textarea) return;
    if (state.mentionActive) {
      hideSlashMenu();
      return;
    }
    const hit = slashQueryAtCursor(textarea);
    if (!hit) {
      hideSlashMenu();
      return;
    }
    const candidates = slashCommandsForContext().filter((item) => {
      if (!hit.query) return true;
      const normalizedLabel = item.label.slice(1).toLowerCase().replace(/[ \t]+/g, " ");
      return hit.query.includes(" ")
        ? normalizedLabel.startsWith(hit.query)
        : `${normalizedLabel} ${item.detail} ${item.id}`.toLowerCase().includes(hit.query);
    });
    const passthrough = [];
    if (!candidates.length && hit.query) {
      const rawCommand = textarea.value.slice(hit.start, hit.end).trim();
      if (/^\/[A-Za-z0-9_-]+([ \t]+\S+){0,8}$/.test(rawCommand)) {
        const nativeHit = slashCommandsForContext().find((item) => item.control === "native" && (item.token === rawCommand || rawCommand.startsWith(`${item.token} `)));
        if (nativeHit && nativeHit.native) {
          passthrough.push({
            ...nativeHit,
            id: "native-passthrough",
            label: rawCommand,
            detail: nativeHit.detail || "作为当前成员原生命令发送",
          });
        } else {
          passthrough.push({
            id: "native-unsupported",
            label: rawCommand,
            detail: nativeHit?.detail || "当前成员不支持这条原生命令。完整 TUI 请用 /cli 附着。",
            native: false,
            apply() {
              toast(this.detail, "warning", 3200);
            },
          });
        }
      }
    }
    if (!candidates.length && !passthrough.length) {
      hideSlashMenu();
      return;
    }
    state.slashActive = true;
    state.slashCandidates = [...candidates, ...passthrough];
    state.slashIndex = 0;
    state.slashRange = hit;
    menu.hidden = false;
    menu.innerHTML = state.slashCandidates.map((item, index) => `
    <button class="slash-item${index === 0 ? " is-active" : ""}${item.native ? " is-native" : ""}" id="slash-option-${index}" type="button" role="option" aria-selected="${index === 0}" data-slash-id="${escapeHtml(item.id)}">
      <strong>${escapeHtml(item.label)}</strong>
      <span>${escapeHtml(item.detail)}</span>
    </button>`).join("");
    textarea.setAttribute("aria-expanded", "true");
    textarea.setAttribute("aria-activedescendant", "slash-option-0");
  }

  function applySlashCommand(id) {
    const command = state.slashCandidates.find((item) => item.id === id);
    const textarea = elements["task-input"];
    const range = state.slashRange;
    if (!command || !textarea || !range) return;
    if (command.native) {
      state.pendingNativeCommand = true;
      hideSlashMenu();
      toast(`${command.label} 将作为原生命令发送给 CLI —— 按 Enter 提交`, "success", 2800);
      textarea.focus({ preventScroll: true });
      return;
    }
    state.pendingNativeCommand = false;
    const before = textarea.value.slice(0, range.start);
    const after = textarea.value.slice(range.end);
    textarea.value = before + after;
    const caret = before.length;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    hideSlashMenu();
    try {
      command.apply();
      toast(`已应用 ${command.label}`, "success", 1800);
    } catch (error) {
      toast(error.message, "error");
    }
    textarea.focus({ preventScroll: true });
  }

  return {
    slashCommandsForContext,
    hideSlashMenu,
    slashQueryAtCursor,
    syncSlashActiveOption,
    renderSlashMenu,
    applySlashCommand,
  };
}
