/**
 * Conversation kickoff relay (W2 / G-3).
 *
 * Turns a group composer message with ≥2 distinct @-mentions into handoff
 * tasks on the existing social run / taskGraph. Does not invent a second
 * message runtime — create/continue still go through Orchestrator.
 */

import {
  KICKOFF_MAX_ASSIGNEES,
  KICKOFF_MIN_ASSIGNEES,
  kickoffMemberAliases,
  normalizeKickoffTasks,
  parseComposerKickoff,
  shouldComposerKickoff,
} from "../public/modules/bot-kickoff-parse.js";

export {
  KICKOFF_MAX_ASSIGNEES,
  KICKOFF_MIN_ASSIGNEES,
  parseComposerKickoff,
  shouldComposerKickoff,
};

function fail(message, code, extra = {}) {
  throw Object.assign(new Error(message), { code, ...extra });
}

function memberLabel(member, fallbackId) {
  return String(member?.label || member?.shortLabel || fallbackId || "").trim();
}

export function resolveKickoffMembers(conversation, { teamMembers = null, roster = [] } = {}) {
  const ids = [...new Set((conversation?.memberIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  const byId = new Map((Array.isArray(roster) ? roster : []).map((item) => [String(item?.id || ""), item]));
  return ids.map((id) => {
    let member = byId.get(id) || null;
    if (!member && typeof teamMembers?.get === "function") {
      try {
        member = teamMembers.get(id);
      } catch {
        member = null;
      }
    }
    return kickoffMemberAliases({
      id,
      label: memberLabel(member, id),
      shortLabel: member?.shortLabel,
      tokens: [id, memberLabel(member, id), member?.shortLabel],
    });
  }).filter(Boolean);
}

export function kickoffTaskTextFor(run, assigneeId) {
  const id = String(assigneeId || "").trim();
  const tasks = Array.isArray(run?.kickoff?.tasks) ? run.kickoff.tasks : [];
  const hit = tasks.find((task) => String(task?.assigneeId || "") === id);
  return String(hit?.text || "").trim();
}

export function applyKickoffTaskGraph(run, tasks, { now = new Date().toISOString() } = {}) {
  if (!run || !Array.isArray(tasks) || tasks.length < KICKOFF_MIN_ASSIGNEES) return run;
  const rootId = run.taskGraph?.rootTaskId || `task-${run.id}`;
  run.taskGraph ||= {
    version: 1,
    rootTaskId: rootId,
    tasks: [],
    delegations: [],
    updatedAt: now,
  };
  run.taskGraph.rootTaskId = rootId;
  if (!Array.isArray(run.taskGraph.tasks)) run.taskGraph.tasks = [];
  if (!Array.isArray(run.taskGraph.delegations)) run.taskGraph.delegations = [];

  run.kickoff = {
    version: 1,
    tasks: tasks.map((task, index) => ({
      id: `task-handoff-${run.id}-${index + 1}`,
      assigneeId: String(task.assigneeId),
      text: String(task.text || run.prompt || "").trim(),
      busMessageId: String(task.busMessageId || `task:${run.id}:${task.assigneeId}`),
    })),
  };

  const root = run.taskGraph.tasks.find((item) => item?.id === rootId || item?.kind === "root") || {
    id: rootId,
    kind: "root",
    title: String(run.prompt || "kickoff").slice(0, 180),
    status: run.status === "queued" ? "queued" : "running",
    assigneeId: run.startAgentId || run.coordinatorId || null,
    parentTaskId: null,
    createdAt: run.createdAt || now,
    updatedAt: now,
  };
  const handoffTasks = run.kickoff.tasks.map((task) => ({
    id: task.id,
    kind: "handoff",
    title: String(task.text || "").slice(0, 180),
    status: "queued",
    assigneeId: task.assigneeId,
    parentTaskId: rootId,
    busMessageId: task.busMessageId,
    createdAt: now,
    updatedAt: now,
  }));
  run.taskGraph.tasks = [root, ...handoffTasks];

  for (const task of run.kickoff.tasks) {
    const edgeId = `del-${task.busMessageId}`;
    if (run.taskGraph.delegations.some((edge) => edge?.id === edgeId || edge?.busMessageId === task.busMessageId)) {
      continue;
    }
    run.taskGraph.delegations.push({
      id: edgeId,
      fromAgentId: "lo",
      toAgentId: task.assigneeId,
      kind: "mention",
      state: "queued",
      busMessageId: task.busMessageId,
      parentTaskId: rootId,
      sourceAttemptId: null,
      targetAttemptId: null,
      depth: 1,
      limit: Math.max(1, Math.min(8, Number(run.delegationDepthLimit) || 4)),
      depthLimitReached: false,
      timestamp: now,
    });
  }
  if (Array.isArray(run.resumeQueue)) {
    const texts = new Map(run.kickoff.tasks.map((task) => [task.assigneeId, task.text]));
    for (const item of run.resumeQueue) {
      if (item?.kind === "task" && texts.has(item.to) && !item.text) item.text = texts.get(item.to);
    }
  }
  run.taskGraph.updatedAt = now;
  return run;
}

function resolveKickoffTasks(prompt, conversation, request, members) {
  const allowed = new Set((conversation.memberIds || []).map(String));
  const explicit = request.tasks == null
    ? null
    : normalizeKickoffTasks(request.tasks, { allowedIds: allowed, maxAssignees: KICKOFF_MAX_ASSIGNEES });
  if (explicit?.length >= KICKOFF_MIN_ASSIGNEES) {
    return explicit.map((task) => ({
      ...task,
      text: task.text || String(prompt || "").trim(),
    }));
  }
  const parsed = parseComposerKickoff(prompt, members, {
    minAssignees: KICKOFF_MIN_ASSIGNEES,
    maxAssignees: KICKOFF_MAX_ASSIGNEES,
  });
  if (!parsed) {
    fail("kickoff requires at least two distinct @-mentioned members", "VALIDATION_FAILED");
  }
  return parsed.tasks;
}

export async function executeConversationKickoff(orchestrator, conversationId, request = {}) {
  if (!orchestrator?.conversations) {
    fail("persisted conversations require a conversation store", "CONVERSATION_STORE_UNAVAILABLE");
  }
  const conversation = orchestrator.conversations.get(conversationId);
  if (!conversation) fail("conversation not found", "CONVERSATION_NOT_FOUND");
  if (conversation.deletedAt) fail("deleted conversations cannot accept messages", "CONVERSATION_DELETED");
  if (conversation.kind !== "workspace_group") {
    fail("kickoff is only available in workspace group conversations", "VALIDATION_FAILED");
  }

  const prompt = String(request.prompt || "").trim();
  if (!prompt) fail("prompt is required", "INVALID_PROMPT");

  const memberIds = [...new Set((conversation.memberIds || []).map(String).filter(Boolean))];
  if (memberIds.length < KICKOFF_MIN_ASSIGNEES) {
    fail("kickoff requires a group with at least two executable members", "NOT_TEAM_MEMBER");
  }
  const roster = await orchestrator.snapshotTeamRoster(memberIds);
  const members = resolveKickoffMembers(conversation, {
    teamMembers: orchestrator.teamMembers,
    roster,
  });
  const tasks = resolveKickoffTasks(prompt, conversation, request, members);
  const [startAgentId, ...requestedAgentIds] = tasks.map((task) => task.assigneeId);

  let coordinator = roster.find((member) => member.coordinatorEligible === true)?.id || null;
  const teamMembers = [...memberIds];
  if (!coordinator && orchestrator.teamMembers?.list) {
    const fallback = orchestrator.teamMembers.list().find((member) => (
      member?.teamMemberEligible === true && member?.coordinatorEligible === true
    ));
    if (fallback?.id) {
      coordinator = String(fallback.id);
      if (!teamMembers.includes(coordinator)) teamMembers.push(coordinator);
    }
  }
  if (!coordinator) fail("conversation has no coordinator-eligible member", "RUNTIME_PROFILE_INELIGIBLE");

  const previousRunId = [...(conversation.runIds || [])].reverse().find((runId) => orchestrator.runs.has(String(runId))) || null;
  const previousRun = previousRunId ? orchestrator.runs.get(String(previousRunId)) : null;
  const execute = request.execute === false ? false : true;
  const created = await orchestrator.create({
    prompt,
    execute,
    conversationId,
    conversationKind: conversation.kind,
    orchestrationMode: "social",
    startAgentId,
    requestedProvider: startAgentId,
    requestedAgentIds,
    kickoffTasks: tasks,
    ephemeralTeam: {
      name: String(conversation.title || "514 Bot Conversation").slice(0, 60),
      description: "由持久化 Conversation 重建的 kickoff 运行快照",
      systemPrompt: "",
      coordinator,
      members: teamMembers,
      skills: [],
      mcp: [],
      providers: {},
    },
    sources: request.sources,
    collaborationMode: previousRun?.collaborationMode === "deep" ? "deep" : "standard",
    model: previousRun?.modelOverride || undefined,
    effort: previousRun?.effortOverride || undefined,
    maxBudgetUsdPerTurn: request.maxBudgetUsdPerTurn,
    permissionMode: "plan",
  });
  return {
    run: created,
    created: true,
    tasks: created.kickoff?.tasks || tasks,
  };
}
