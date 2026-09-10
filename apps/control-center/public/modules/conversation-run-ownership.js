function conversationClaimsRun(conversation, runId) {
  if (!conversation?.id || !runId) return false;
  if (String(conversation.activeRunId || "") === runId) return true;
  return Array.isArray(conversation.runIds)
    && conversation.runIds.some((candidate) => String(candidate) === runId);
}

export function conversationListsRun(conversation, runId) {
  return conversationClaimsRun(conversation, String(runId || ""));
}

export function conversationOwnsRun(run, conversation, conversations = []) {
  if (!run?.id || !conversation?.id) return false;
  if (run.conversationId) {
    return String(run.conversationId) === String(conversation.id);
  }

  const runId = String(run.id);
  const ownerIds = new Set(
    (Array.isArray(conversations) ? conversations : [])
      .filter((candidate) => conversationClaimsRun(candidate, runId))
      .map((candidate) => String(candidate.id)),
  );
  return ownerIds.size === 1 && ownerIds.has(String(conversation.id));
}
