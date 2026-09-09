import { conversationOwnsRun } from "./conversation-run-ownership.js";

// Compatibility exports for B1 consumers. All generated links now belong to Bot.
export { readBotWorkspaceRoute as readExperienceRoute, botWorkspaceRoute as experienceRoute } from "./bot-workspace-route.js";

export function experienceSelection(snapshot, view) {
  const conversations = snapshot.conversations || [];
  const conversation = conversations.find((item) => item.id === view.conversationId) || null;
  const runId = view.runId || conversation?.activeRunId || "";
  const claimed = conversation && (conversation.activeRunId === runId || (conversation.runIds || []).includes(runId));
  const run = claimed ? snapshot.resolveRun(runId) : null;
  return {
    conversation,
    project: (snapshot.projects || []).find((item) => item.projectId === conversation?.projectId) || null,
    run: !conversation?.deletedAt && conversationOwnsRun(run, conversation, conversations) ? run : null,
  };
}
