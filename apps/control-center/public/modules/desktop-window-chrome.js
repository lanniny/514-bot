const mounts = new WeakMap();
const commands = new Map([
  ["window-minimize", "plugin:window|minimize"],
  ["window-maximize", "plugin:window|toggle_maximize"],
  ["window-close", "plugin:window|close"],
  ["bot-window-minimize", "plugin:window|minimize"],
  ["bot-window-maximize", "plugin:window|toggle_maximize"],
  ["bot-window-close", "plugin:window|close"],
]);
const dragSurfaces = ".topbar, .bot-roster-header, .bot-conversation-header, .bot-panel-header, .bot-computer-view-header, .bot-settings-header";
const interactive = "button, a, input, select, textarea, .topbar-nav, .topbar-actions, [contenteditable]:not([contenteditable=\"false\"]), [role=\"button\"]";

export function mountDesktopWindowChrome({ document, window, invoke, reload, onError }) {
  mounts.get(document)?.dispose();
  const controls = document.getElementById("window-controls");
  const botControls = document.getElementById("bot-window-controls");
  const enabled = typeof invoke === "function";
  const active = enabled && Boolean(controls || botControls);
  const wasDesktop = document.documentElement.classList.contains("is-desktop-shell");
  const hidden = [controls, botControls].filter(Boolean).map((element) => [element, element.hidden]);
  const listeners = [];
  let disposed = false;
  const listen = (target, event, handler) => {
    if (!target) return;
    target.addEventListener(event, handler);
    listeners.push(() => target.removeEventListener(event, handler));
  };
  const controller = {
    get active() { return active && !disposed; },
    async run(command) {
      if (disposed) return false;
      try {
        if (!enabled) throw new Error("native window bridge is unavailable");
        await invoke(command);
        return true;
      } catch (error) {
        if (!disposed) onError(error, command);
        return false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const remove of listeners) remove();
      if (active) {
        document.documentElement.classList.toggle("is-desktop-shell", wasDesktop);
        for (const [element, value] of hidden) element.hidden = value;
      }
      if (mounts.get(document) === controller) mounts.delete(document);
    },
  };
  mounts.set(document, controller);
  if (!active) return controller;
  document.documentElement.classList.add("is-desktop-shell");
  if (controls) controls.hidden = false;
  if (botControls) botControls.hidden = Boolean(controls);
  for (const [id, command] of commands) listen(document.getElementById(id), "click", () => { void controller.run(command); });
  const canDrag = (event) => event.button === 0 && !event.defaultPrevented && !event.target?.closest?.(interactive);
  for (const surface of document.querySelectorAll(dragSurfaces)) {
    // PointerEvent.detail is zero for a mouse; MouseEvent carries the click count.
    listen(surface, "mousedown", (event) => {
      if (!canDrag(event)) return;
      event.preventDefault();
      void controller.run(event.detail === 2 ? "plugin:window|toggle_maximize" : "plugin:window|start_dragging");
    });
    listen(surface, "pointerdown", (event) => {
      if (event.pointerType === "mouse" || event.isPrimary === false || !canDrag(event)) return;
      event.preventDefault();
      void controller.run("plugin:window|start_dragging");
    });
  }
  listen(window, "keydown", (event) => {
    if (event.defaultPrevented || event.repeat || event.isComposing || !event.ctrlKey || String(event.key).toLowerCase() !== "r") return;
    event.preventDefault();
    reload();
  });
  return controller;
}
