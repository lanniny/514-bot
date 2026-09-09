const TYPING_EVENTS = new Set([
  "assistant.message", "tool.event", "tool.result", "agent.turn_started",
  "codex.item/completed", "grok.thinking", "grok.completed", "prompt.transport",
]);

export function createPetActivity({ now = Date.now } = {}) {
  const pending = new Map();
  let lastActivity = now();
  let typingUntil = 0;
  let celebrateUntil = 0;
  let failureUntil = 0;

  function activity() {
    lastActivity = now();
    typingUntil = lastActivity + 2500;
  }

  function ingest(event) {
    const time = now();
    const data = event?.data || {};
    const type = event?.type;
    const id = data.id;
    if (type === "approval.resolved" || type === "approval.expired") {
      if (id) pending.delete(id);
      return;
    }
    if (type === "approval.pending") {
      const expiresAt = Date.parse(data.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= time) return;
      pending.set(id || "legacy", { runId: event.runId, expiresAt: Number.isFinite(expiresAt) ? expiresAt : time + 90_000 });
      lastActivity = time;
      return;
    }
    // Replayed activity must not wake the pet or replay old completion effects.
    const timestamp = Date.parse(event?.timestamp);
    if (Number.isFinite(timestamp) && time - timestamp > 10_000) return;
    if (["run.failed", "run.recovery_required"].includes(type)) {
      failureUntil = time + 5000;
      celebrateUntil = 0;
      lastActivity = time;
      return "failure";
    }
    if (TYPING_EVENTS.has(type)) {
      activity();
      return "typing";
    }
    if (type === "agent.turn_completed") {
      lastActivity = time;
      const failed = data.status === "failed" || data.status === "error" || data.ok === false;
      if (failed) failureUntil = time + 5000;
      else celebrateUntil = time + 3500;
      return failed ? "failure" : "celebrate";
    }
  }

  function snapshot() {
    const time = now();
    for (const [id, item] of pending) if (item.expiresAt <= time) pending.delete(id);
    if (pending.size) return { name: "attention", text: `${pending.size} 项审批待处理` };
    if (time < failureUntil) return { name: "failure", text: "任务需要关注" };
    if (time < celebrateUntil) return { name: "celebrate", text: "" };
    if (time - lastActivity >= 5 * 60_000) return { name: "sleep", text: "" };
    return { name: time < typingUntil ? "typing" : "ready", text: "" };
  }

  return { activity, ingest, snapshot, reset: () => { pending.clear(); celebrateUntil = failureUntil = typingUntil = 0; lastActivity = now(); } };
}
