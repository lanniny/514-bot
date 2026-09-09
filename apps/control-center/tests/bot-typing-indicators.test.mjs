import test from "node:test";
import assert from "node:assert/strict";
import {
  botRunIsTypingActive,
  botTypingMemberPhase,
  botTypingMembers,
  botTypingMarkup,
} from "../public/modules/bot-typing-indicators.js";

const group = { kind: "workspace_group", memberIds: ["claude-fable", "codex-technical"] };
const direct = { kind: "direct", directMemberId: "claude-fable", memberIds: ["claude-fable"] };

test("waiting / ask / idle runs never claim typing", () => {
  assert.equal(botRunIsTypingActive(null), false);
  assert.equal(botRunIsTypingActive({ status: "waiting_approval" }), false);
  assert.equal(botRunIsTypingActive({ status: "running", pendingAsk: { id: "q1" } }), false);
  assert.equal(botRunIsTypingActive({ status: "succeeded" }), false);
  assert.deepEqual(botTypingMembers({ status: "waiting_input" }, { conversation: group, fallbackMemberId: "claude-fable" }), []);
});

test("direct chat keeps session-level fallback when no live member signal exists", () => {
  const run = { status: "queued", startAgentId: "claude-fable" };
  assert.deepEqual(botTypingMembers(run, { conversation: direct, fallbackMemberId: "claude-fable" }), ["claude-fable"]);
  assert.equal(botTypingMemberPhase(run, "claude-fable"), "typing");
});

test("group chat attributes queued run to start/execution owner, not the UI-selected fallback", () => {
  const run = { status: "queued", startAgentId: "codex-technical", conversationKind: "workspace_group" };
  assert.deepEqual(
    botTypingMembers(run, { conversation: group, fallbackMemberId: "claude-fable" }),
    ["codex-technical"],
  );
});

test("group chat lists every member with an incomplete turn or inflight/task signal", () => {
  const run = {
    status: "running",
    startAgentId: "claude-fable",
    inflightTurns: { "codex-technical": { phase: "submitted" } },
    turnAttempts: [
      { agentId: "claude-fable", phase: "submitted" },
      { agentId: "codex-technical", phase: "completed" },
    ],
    taskGraph: { tasks: [{ assigneeId: "claude-fable", status: "running" }] },
  };
  assert.deepEqual(botTypingMembers(run, { conversation: group, fallbackMemberId: "unused" }), [
    "codex-technical",
    "claude-fable",
  ]);
  assert.equal(botTypingMemberPhase(run, "claude-fable"), "running");
  assert.equal(botTypingMemberPhase(run, "codex-technical"), "running");
});

test("group roster drops strangers and does not invent a second member", () => {
  const run = {
    status: "running",
    inflightTurns: { "outsider": {}, "claude-fable": {} },
  };
  assert.deepEqual(botTypingMembers(run, { conversation: group }), ["claude-fable"]);
});

test("markup names group members and keeps direct chat anonymous dots", () => {
  const run = { status: "running", startAgentId: "claude-fable" };
  const groupHtml = botTypingMarkup({
    members: ["claude-fable", "codex-technical"],
    run: { ...run, turnAttempts: [{ agentId: "codex-technical", phase: "submitted" }] },
    conversation: group,
    avatarHtml: (id) => `<span data-avatar="${id}"></span>`,
    labelFor: (id) => (id === "codex-technical" ? "烛" : "Fable"),
  });
  assert.match(groupHtml, /data-bot-typing-member="claude-fable"/);
  assert.match(groupHtml, /data-bot-typing-member="codex-technical"/);
  assert.match(groupHtml, /data-bot-typing-phase="running"/);
  assert.match(groupHtml, /<span class="bot-typing-name">烛<\/span>/);
  assert.match(groupHtml, /aria-label="烛 正在执行"/);
  assert.match(groupHtml, /aria-label="Fable 正在输入"/);

  const directHtml = botTypingMarkup({
    members: ["claude-fable"],
    run,
    conversation: direct,
    avatarHtml: () => "<i class=av></i>",
    labelFor: () => "Fable",
  });
  assert.match(directHtml, /data-bot-typing-member="claude-fable"/);
  assert.doesNotMatch(directHtml, /bot-typing-name/);
  assert.match(directHtml, /aria-label="Fable 正在输入"/);
});

test("markup escapes member identity", () => {
  const html = botTypingMarkup({
    members: ['<img src=x onerror="alert(1)">'],
    run: { status: "queued" },
    conversation: { kind: "workspace_group", memberIds: ['<img src=x onerror="alert(1)">'] },
    avatarHtml: () => "",
    labelFor: () => '<script>alert(1)</script>',
  });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /onerror=/);
  assert.match(html, /&lt;script&gt;/);
});
