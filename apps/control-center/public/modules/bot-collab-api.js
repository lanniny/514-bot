/**
 * Bot collaboration API wrappers.
 *
 * Kickoff/relay is the multi-@ group path. The composer send main path must
 * call this instead of run-create when ≥2 distinct members are mentioned.
 */

export function createBotCollabApi({ request } = {}) {
  if (typeof request !== "function") {
    throw new TypeError("createBotCollabApi requires request()");
  }

  async function kickoff({
    conversationId,
    prompt,
    tasks,
    sources,
    execute,
    maxBudgetUsdPerTurn,
  } = {}) {
    const id = String(conversationId || "").trim();
    if (!id) throw new Error("conversationId is required");
    const body = {
      conversationId: id,
      prompt: String(prompt || "").trim(),
    };
    if (Array.isArray(tasks) && tasks.length) {
      body.tasks = tasks.map((task) => ({
        assigneeId: String(task?.assigneeId || "").trim(),
        text: String(task?.text || "").trim(),
      })).filter((task) => task.assigneeId);
    }
    if (Array.isArray(sources) && sources.length) body.sources = sources;
    if (execute === false) body.execute = false;
    if (maxBudgetUsdPerTurn != null) body.maxBudgetUsdPerTurn = maxBudgetUsdPerTurn;
    return request("/api/bots/relay/kickoff", { method: "POST", body });
  }

  return Object.freeze({ kickoff });
}
