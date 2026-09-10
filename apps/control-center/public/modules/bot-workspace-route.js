const TABS = ["conversation", "process", "results"];
const safeId = (value) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(value || "")) ? String(value) : "";

export function readBotWorkspaceRoute(hash) {
  const raw = String(hash || "");
  if (!/^#\/?(?:bot|experience|workbench)(?:\?|$)/.test(raw)) return null;
  const query = new URLSearchParams(raw.split("?")[1] || "");
  return { conversationId: safeId(query.get("conversation")), runId: safeId(query.get("run")), tab: TABS.includes(query.get("tab")) ? query.get("tab") : "conversation" };
}

export function botWorkspaceRoute(view = {}) {
  const query = new URLSearchParams();
  if (safeId(view.conversationId)) query.set("conversation", view.conversationId);
  if (safeId(view.runId)) query.set("run", view.runId);
  if (TABS.includes(view.tab) && view.tab !== "conversation") query.set("tab", view.tab);
  return `#bot${query.size ? `?${query}` : ""}`;
}

export function ownsBotWorkspaceHash(hash) {
  const raw = String(hash || "");
  if (!raw || readBotWorkspaceRoute(raw)) return true;
  if (!/^#(?:conversation|run|project|session|token|bootstrap)=/.test(raw)) return false;
  return Boolean(safeId(new URLSearchParams(raw.slice(1)).get("conversation")));
}
