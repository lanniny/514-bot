import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator.mjs";
import { applyKickoffTaskGraph, executeConversationKickoff, kickoffTaskTextFor } from "../src/bot-kickoff.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

function route(selectedId = "codex-technical") {
  return {
    taskType: "coding",
    risk: "medium",
    selected: { id: selectedId, label: selectedId },
    independent: { id: "claude-fable", label: "Fable" },
    independentRequired: false,
    reason: "test route",
  };
}

function fakeTeams() {
  return {
    get(id) {
      if (id !== "team-514cc") throw Object.assign(new Error("not found"), { code: "SOURCE_NOT_FOUND" });
      return { id: "team-514cc", name: "514cc", coordinator: "claude-fable", members: ["claude-fable", "codex-technical"] };
    },
    materializeEphemeral(input = {}) {
      return {
        id: "team-ephemeral-kickoff",
        ephemeral: true,
        builtin: false,
        name: input.name || "kickoff",
        coordinator: input.coordinator,
        members: [...(input.members || [])],
        skills: [],
        mcp: [],
        providers: {},
      };
    },
    briefFor() {
      return "";
    },
  };
}

async function fixture() {
  const root = await mkdtemp(resolve(appRoot, ".test-bot-kickoff-"));
  const conversation = {
    id: "conversation-group",
    kind: "workspace_group",
    title: "Kickoff Room",
    scope: "project",
    roomRole: "task",
    projectId: "project-kickoff",
    directMemberId: null,
    memberIds: ["claude-fable", "codex-technical"],
    runIds: [],
    activeRunId: null,
    deletedAt: null,
  };
  const orchestrator = await new Orchestrator({
    router: { preview: async ({ requestedProvider } = {}) => route(requestedProvider || "codex-technical") },
    adapters: new Map(),
    eventStore: { emit: async () => undefined },
    dataRoot: root,
    policy: {
      version: 1,
      modes: { plan: { write: false, approvalRequired: false }, build: { write: "workspace", approvalRequired: true } },
      limits: { maxRounds: 6, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 10_000 },
    },
    approvalBroker: { request: async () => ({ decision: "accept" }), denyRun() {} },
    teams: fakeTeams(),
    projects: {
      get(id) {
        if (id !== "project-kickoff") throw Object.assign(new Error("project not found"), { code: "PROJECT_NOT_FOUND" });
        return { id: "project-kickoff", canonicalCwd: root, archivedAt: null };
      },
    },
    conversations: {
      get(id) {
        if (id !== conversation.id) throw Object.assign(new Error("conversation not found"), { code: "CONVERSATION_NOT_FOUND" });
        return conversation;
      },
      async attachRun(_id, runId) {
        conversation.runIds.push(runId);
        conversation.activeRunId = runId;
      },
      async detachRun() {},
    },
    capabilities: { agentDisabledSkills: async () => new Set() },
  }).init();
  return { root, conversation, orchestrator };
}

test("applyKickoffTaskGraph writes one handoff task per assignee", () => {
  const run = {
    id: "run-kickoff",
    prompt: "@A do X @B do Y",
    status: "queued",
    startAgentId: "claude-fable",
    taskGraph: { version: 1, rootTaskId: "task-run-kickoff", tasks: [], delegations: [] },
    resumeQueue: [
      { to: "claude-fable", kind: "task" },
      { to: "codex-technical", kind: "task" },
    ],
  };
  applyKickoffTaskGraph(run, [
    { assigneeId: "claude-fable", text: "do X" },
    { assigneeId: "codex-technical", text: "do Y" },
  ]);
  const handoffs = run.taskGraph.tasks.filter((task) => task.kind === "handoff");
  assert.equal(handoffs.length, 2);
  assert.deepEqual(handoffs.map((task) => [task.assigneeId, task.title]), [
    ["claude-fable", "do X"],
    ["codex-technical", "do Y"],
  ]);
  assert.equal(kickoffTaskTextFor(run, "codex-technical"), "do Y");
  assert.equal(run.resumeQueue[1].text, "do Y");
  assert.equal(run.taskGraph.delegations.filter((edge) => edge.kind === "mention").length, 2);
});

test("conversationKickoff creates a social run with handoff tasks for multi-@", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const result = await fx.orchestrator.conversationKickoff(fx.conversation.id, {
    prompt: "@claude-fable 规划方案 @codex-technical 写补丁",
    execute: false,
  });
  assert.equal(result.created, true);
  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.tasks.map((task) => task.assigneeId), ["claude-fable", "codex-technical"]);
  assert.match(result.tasks[0].text, /规划方案/);
  assert.match(result.tasks[1].text, /写补丁/);
  const handoffs = result.run.taskGraph.tasks.filter((task) => task.kind === "handoff");
  assert.equal(handoffs.length, 2);
  assert.equal(result.run.orchestrationMode, "social");
  assert.equal(result.run.conversationId, fx.conversation.id);
  assert.equal(fx.conversation.activeRunId, result.run.id);
});

test("conversationKickoff accepts explicit task ids and rejects single-target / direct rooms", async (t) => {
  const fx = await fixture();
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const explicit = await executeConversationKickoff(fx.orchestrator, fx.conversation.id, {
    prompt: "please do the split work",
    execute: false,
    tasks: [
      { assigneeId: "codex-technical", text: "write the patch" },
      { assigneeId: "claude-fable", text: "review the plan" },
    ],
  });
  assert.deepEqual(explicit.tasks.map((task) => [task.assigneeId, task.text]), [
    ["codex-technical", "write the patch"],
    ["claude-fable", "review the plan"],
  ]);

  await assert.rejects(
    () => fx.orchestrator.conversationKickoff(fx.conversation.id, {
      prompt: "@codex-technical only one person",
      execute: false,
    }),
    { code: "VALIDATION_FAILED" },
  );

  fx.orchestrator.conversations.get = () => ({
    ...fx.conversation,
    kind: "direct",
    directMemberId: "codex-technical",
    memberIds: ["codex-technical"],
  });
  await assert.rejects(
    () => fx.orchestrator.conversationKickoff(fx.conversation.id, {
      prompt: "@claude-fable a @codex-technical b",
      execute: false,
    }),
    { code: "VALIDATION_FAILED" },
  );
});
