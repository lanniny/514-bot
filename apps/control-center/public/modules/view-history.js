/**
 * 顶栏 ‹ › 双栈：纯函数，不碰 DOM。
 * setView 全程 replaceState，浏览器历史不涨，这里自养后退/前进。
 */
import { botWorkspaceRoute, readBotWorkspaceRoute } from "./bot-workspace-route.js";
import { automationRouteHash } from "./automations-page.js";
export const VIEW_HISTORY_LIMIT = 50;

export function routeKey(route) {
  if (!route?.view) return "";
  if (route.view === "automations") return `automations|${automationRouteHash(route.automationHash)}`;
  const workspaceHash = route.botWorkspaceHash || route.experienceHash;
  if (route.view === "experience" || (route.view === "bot" && workspaceHash)) return `bot|${botWorkspaceRoute(readBotWorkspaceRoute(workspaceHash) || {})}`;
  const surface = route.view === "config" ? String(route.configSurface || "") : "";
  const workspace = route.view === "config" && route.configSurface === "capabilities"
    ? (route.capabilityWorkspace === "mcp" ? "mcp" : "skills")
    : "";
  const focus = route.view === "observability" ? String(route.settingsFocus || "") : "";
  return `${route.view}|${surface}|${workspace}|${focus}`;
}

export function sameRoute(left, right) {
  return routeKey(left) === routeKey(right);
}

export function pushUnique(stack, route, limit = VIEW_HISTORY_LIMIT) {
  if (!route?.view) return stack;
  const last = stack.at(-1);
  if (last && sameRoute(last, route)) return stack;
  const next = stack.concat({ ...route });
  if (next.length > limit) next.shift();
  return next;
}

export function recordRouteChange(previous, current, { back, mute = false } = {}) {
  if (mute || !previous?.view || sameRoute(previous, current)) {
    return { back, recorded: false };
  }
  return { back: pushUnique(back, previous), recorded: true };
}

export function stepHistory(direction, { back, forward, current }) {
  const from = direction === "back" ? back : forward;
  if (!from.length) return { back, forward, target: null };
  const target = from[from.length - 1];
  if (sameRoute(target, current)) {
    const rest = from.slice(0, -1);
    return direction === "back"
      ? { back: rest, forward, target: null }
      : { back, forward: rest, target: null };
  }
  const rest = from.slice(0, -1);
  if (direction === "back") {
    return { back: rest, forward: pushUnique(forward, current), target };
  }
  return { back: pushUnique(back, current), forward: rest, target };
}

export function historyShortcutBlocked(event, document = globalThis.document) {
  if (!event || event.defaultPrevented) return true;
  if (document?.querySelector("dialog[open], .cmd-palette-overlay.is-open")) {
    return true;
  }
  const target = event.target;
  if (target?.isContentEditable) return true;
  if (!target?.closest) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
}
