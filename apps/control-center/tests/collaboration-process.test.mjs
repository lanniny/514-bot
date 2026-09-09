import test from "node:test";
import assert from "node:assert/strict";
import { collaborationProcessModel, collaborationProcessMarkup, collaborationPage, collaborationReviewMarkup } from "../public/modules/collaboration-process.js";

test("historical process uses Run roster and shows overlapping responsibilities", () => {
  const model = collaborationProcessModel({
    conversation: { memberIds: ["replacement"] },
    run: { id: "old", coordinatorId: "a", executionOwnerId: "a", teamMembers: ["a", "b"], teamRoster: [{ id: "a", name: "Original owner" }], taskGraph: { delegations: [{ id: "review", kind: "pipeline-review", toAgentId: "b", state: "completed" }] } },
  });
  assert.deepEqual(model.members.map((member) => member.id), ["a", "b"]);
  assert.equal(model.members[0].label, "Original owner");
  assert.deepEqual(model.members[0].roles, ["协调", "执行"]);
  assert.deepEqual(model.members[1].roles, ["复核"]);
});

test("root completion is not counted twice and success never claims acceptance", () => {
  const model = collaborationProcessModel({ run: { id: "r", status: "succeeded", taskGraph: { tasks: [
    { id: "root", kind: "root", status: "succeeded" },
    { id: "work", status: "succeeded" },
    { id: "error", status: "lost" },
    { id: "future", status: "future-state" },
  ] } } });
  assert.equal(model.counts.total, 3);
  assert.equal(model.counts.complete, 1);
  assert.equal(model.counts.attention, 1);
  assert.equal(model.counts.unknown, 1);
  assert.equal(model.tasks[3].state.label, "状态未知");
  assert.equal(model.status, "运行结束，仍有未闭环事项");
});

test("social narrative cannot manufacture review or rework evidence", () => {
  const model = collaborationProcessModel({ run: { id: "r", status: "succeeded", orchestrationMode: "social", result: { final: "independently reviewed and accepted", verified: "legacy copy of execution" } } });
  assert.equal(model.method, "按需协作");
  assert.equal(model.review.recorded, false);
  assert.equal(model.review.reworked, false);
  assert.equal(model.review.reworkText, "");
  assert.equal(model.status, "运行结束，验收待确认");
});

test("pending review is distinct from recorded review and rework preserves critique", () => {
  const run = { id: "r", taskGraph: { delegations: [{ id: "e", kind: "pipeline-review", state: "queued" }] } };
  assert.equal(collaborationProcessModel({ run }).review.label, "复核尚未完成");
  run.result = { critique: "Unresolved correctness issue", verified: "Fix receipt", reworked: true };
  const model = collaborationProcessModel({ run });
  assert.equal(model.review.text, "Unresolved correctness issue");
  assert.equal(model.review.reworkText, "Fix receipt");
  assert.equal(model.review.label, "已有复核记录");
});

test("paging stays bounded, clamps stale indices and retains access to the tail", () => {
  const entries = Array.from({ length: 1001 }, (_, id) => ({ id }));
  assert.equal(collaborationPage(entries, 0).entries.length, 50);
  assert.equal(collaborationPage(entries, 1).entries[0].id, 50);
  assert.equal(collaborationPage(entries, 900).entries[0].id, 1000);
  assert.equal(collaborationPage(entries, -1).page, 0);
});

test("process markup escapes data and keeps stable identities and failure filter", () => {
  const model = collaborationProcessModel({ run: { id: "r", prompt: '<img src=x onerror="alert(1)">', teamMembers: ["<script>"], taskGraph: { tasks: [
    { id: 'bad" onclick="x', title: "<script>attack</script>", status: "failed" },
    { id: "ok", status: "succeeded" },
  ] } } });
  const markup = collaborationProcessMarkup(model, { filter: "attention" });
  assert.doesNotMatch(markup, /<script>|<img src=x|data-bot-task-id="ok"/);
  assert.match(markup, /&lt;script&gt;attack/);
  assert.match(markup, /data-stream-key="task:bad&quot;/);
  assert.match(markup, /data-workspace-task-filter="attention" aria-pressed="true"/);
  assert.equal((markup.match(/data-bot-task-id=/g) || []).length, 1);
});

test("empty and malformed optional records render as empty, not validated success", () => {
  const model = collaborationProcessModel({ run: { id: "r", taskGraph: { tasks: {}, delegations: [null] } } });
  assert.equal(model.tasks.length, 0);
  assert.equal(model.review.recorded, false);
  assert.match(collaborationProcessMarkup(model), /暂无执行分工/);
  assert.equal(collaborationReviewMarkup(collaborationProcessModel(), () => ""), "");
});

test("initial and direct native turns appear without inventing delegation edges", () => {
  const run = { id: "r", teamMembers: ["a"], turnAttempts: [
    { attemptId: "first", agentId: "a", phase: "submitted", round: 1 },
    { attemptId: "second", agentId: "a", phase: "completed", round: 2, sourceBusMessageId: "m" },
  ], taskGraph: { tasks: [{ id: "second-task", attemptId: "second", busMessageId: "m", assigneeId: "a", status: "succeeded" }] } };
  const model = collaborationProcessModel({ run });
  assert.equal(model.counts.total, 2);
  assert.equal(model.counts.running, 1);
  assert.equal(model.members[0].running, 1);
  assert.equal(model.delegations.length, 0);
  assert.equal(model.tasks[0].attemptId, "first");
});

test("stopped Runs never display stale live attempts, tasks or delegations as running", () => {
  for (const status of ["succeeded", "failed", "cancelled", "recovery_required", "interrupted"]) {
    const run = { id: "r", status, conversationKind: "direct", teamMembers: ["a"], turnAttempts: [{ attemptId: "first", agentId: "a", phase: "submitted" }], taskGraph: { tasks: [{ id: "stale", assigneeId: "a", status: "running" }], delegations: [{ id: "edge", state: "running" }] } };
    const original = structuredClone(run);
    const model = collaborationProcessModel({ run });
    assert.equal(model.counts.running, 0);
    assert.equal(model.counts.attention, 2);
    assert.equal(model.members[0].running, 0);
    assert.equal(model.delegations[0].stateView.label, "执行状态待核对");
    assert.equal(model.method, "单席直达");
    assert.deepEqual(run, original, "projection must not rewrite historical execution evidence");
  }
});
