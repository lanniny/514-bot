const mounts = new WeakMap();

export function mountBotApprovalShortcuts({ document, enabled, getView, getActiveRun, getApprovals, isInFlight, resolveApproval, onError }) {
  mounts.get(document)?.();
  let disposed = false;
  const onKeyDown = (event) => {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = String(event.key || "").toLowerCase();
    if ((key !== "y" && key !== "n") || getView() !== "bot") return;
    const active = document.activeElement;
    if (active && (active.isContentEditable || ["input", "textarea", "select"].includes(String(active.tagName || "").toLowerCase()))) return;
    if (document.querySelector("dialog[open], .cmd-palette-overlay.is-open")) return;
    const run = getActiveRun();
    if (!run?.id) return;
    const pending = getApprovals().filter((item) => String(item.runId || "") === String(run.id) && (item.status ?? "pending") === "pending");
    const latest = pending.at(-1);
    if (!latest?.id || isInFlight(String(latest.id))) return;
    event.preventDefault();
    // The business resolver retains permission/hash checks and the authoritative write.
    try {
      Promise.resolve(resolveApproval(latest.id, key === "y" ? "approve" : "deny")).catch((error) => { if (!disposed) onError(error); });
    } catch (error) { onError(error); }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("keydown", onKeyDown);
    if (mounts.get(document) === dispose) mounts.delete(document);
  };
  mounts.set(document, dispose);
  if (enabled) document.addEventListener("keydown", onKeyDown);
  return dispose;
}
