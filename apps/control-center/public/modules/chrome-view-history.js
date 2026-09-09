import { historyShortcutBlocked, recordRouteChange, sameRoute, stepHistory } from "./view-history.js";

export function createChromeViewHistory({ document, window, captureRoute, applyRoute, titleForRoute, isKnownRoute, pulse, onError }) {
  let back = [];
  let forward = [];
  let pending = null;
  let revision = 0;
  let disposed = false;
  let binding = 0;
  let removeListeners = [];
  const issued = new WeakSet();
  const sync = () => {
    for (const [direction, stack, fallback] of [["back", back, "\u540e\u9000"], ["forward", forward, "\u524d\u8fdb"]]) {
      const button = document.getElementById(`chrome-nav-${direction}`);
      if (!button) continue;
      const target = stack.at(-1);
      button.disabled = Boolean(pending) || !target;
      const label = target ? `${fallback}\u5230\u300c${titleForRoute(target)}\u300d` : fallback;
      button.title = label;
      button.setAttribute("aria-label", label);
    }
  };
  const controller = {
    sync,
    snapshot: () => ({ back: back.map((route) => ({ ...route })), forward: forward.map((route) => ({ ...route })), pending: Boolean(pending) }),
    record(previous, navigationToken) {
      if (disposed || (navigationToken && issued.has(navigationToken))) { sync(); return; }
      if (!previous?.view || !isKnownRoute(previous)) { sync(); return; }
      const next = recordRouteChange(previous, captureRoute(), { back });
      back = next.back;
      if (next.recorded) {
        forward = [];
        revision++;
        if (pending) pending.cancelled = true;
      }
      sync();
    },
    async navigate(direction) {
      if (disposed || pending || !["back", "forward"].includes(direction)) return false;
      const current = captureRoute();
      const stepped = stepHistory(direction, { back, forward, current });
      if (!stepped.target) { back = stepped.back; forward = stepped.forward; sync(); return false; }
      const request = { revision, cancelled: false, origin: current };
      const token = { isCurrent: () => pending === request && !request.cancelled && !disposed };
      issued.add(token);
      pending = request;
      pulse(direction === "back" ? "chrome-nav-back" : "chrome-nav-forward");
      sync();
      try {
        const accepted = await applyRoute(stepped.target, token);
        const actual = captureRoute();
        if (accepted !== true || !token.isCurrent() || revision !== request.revision || (sameRoute(actual, request.origin) && !sameRoute(actual, stepped.target))) return false;
        back = stepped.back;
        forward = stepped.forward;
        revision++;
        return true;
      } catch (error) { onError(error); return false; }
      finally { if (pending === request) pending = null; sync(); }
    },
    initialize() {
      removeListeners.forEach((remove) => remove());
      removeListeners = [];
      disposed = false;
      const generation = ++binding;
      const listen = (target, type, handler) => {
        if (!target) return;
        target.addEventListener(type, handler);
        removeListeners.push(() => target.removeEventListener(type, handler));
      };
      listen(document.getElementById("chrome-nav-back"), "click", () => { void controller.navigate("back"); });
      listen(document.getElementById("chrome-nav-forward"), "click", () => { void controller.navigate("forward"); });
      listen(document, "keydown", (event) => {
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        if (historyShortcutBlocked(event, document)) return;
        event.preventDefault();
        void controller.navigate(event.key === "ArrowLeft" ? "back" : "forward");
      });
      listen(window, "mouseup", (event) => {
        if (event.button !== 3 && event.button !== 4) return;
        if (document.querySelector("dialog[open], .cmd-palette-overlay.is-open")) return;
        event.preventDefault();
        void controller.navigate(event.button === 3 ? "back" : "forward");
      });
      sync();
      return () => { if (generation === binding) controller.dispose(); };
    },
    dispose() {
      disposed = true;
      binding++;
      removeListeners.forEach((remove) => remove());
      removeListeners = [];
      if (pending) pending.cancelled = true;
      pending = null;
      sync();
    },
  };
  return controller;
}
