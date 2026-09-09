import test from "node:test";
import assert from "node:assert/strict";
import {
  draftPrivateSkillFromRun,
  extractRunGoal,
  extractRunOutcome,
  isSucceededRun,
  PRIVATE_SKILL_DRAFT_LIMITS,
  saveSkillActionMarkup,
} from "../public/modules/private-skill-from-run.js";

test("only succeeded runs can be drafted into a private skill", () => {
  assert.equal(isSucceededRun({ id: "r1", status: "succeeded" }), true);
  assert.equal(isSucceededRun({ id: "r1", status: "complete" }), true);
  assert.equal(isSucceededRun({ id: "r1", status: "failed" }), false);
  assert.equal(isSucceededRun({ id: "r1", status: "running" }), false);
  assert.equal(draftPrivateSkillFromRun({ id: "r1", status: "failed", prompt: "x" }), null);
});

test("draft uses real goal and outcome text and does not invent a result", () => {
  const draft = draftPrivateSkillFromRun({
    id: "run-abc-123456",
    status: "succeeded",
    title: "Inbox triage",
    prompt: "Summarize new mail and suggest labels",
    result: { final: "Labeled 12 threads; no secrets found." },
  });
  assert.equal(draft.sourceRunId, "run-abc-123456");
  assert.equal(draft.name, "Summarize new mail and suggest labels");
  assert.match(draft.description, /Inbox triage|Summarize new mail/);
  assert.match(draft.instructions, /Summarize new mail and suggest labels/);
  assert.match(draft.instructions, /Labeled 12 threads/);
  assert.match(draft.instructions, /Source run: run-abc-123456/);
  assert.equal(draft.missingGoal, false);
  assert.equal(draft.missingOutcome, false);
  assert.equal(draft.ready, true);
});

test("missing outcome stays honest instead of fabricating success", () => {
  const draft = draftPrivateSkillFromRun({
    id: "run-empty",
    status: "completed",
    prompt: "Review the settlement card",
  });
  assert.equal(extractRunGoal(draft && { prompt: "Review the settlement card" }), "Review the settlement card");
  assert.equal(extractRunOutcome({ status: "completed", prompt: "Review the settlement card" }), "");
  assert.equal(draft.missingOutcome, true);
  assert.match(draft.instructions, /no captured outcome text/);
  assert.doesNotMatch(draft.instructions, /successfully completed the review/i);
});

test("empty goal and outcome leave name/description blank for the editor", () => {
  const draft = draftPrivateSkillFromRun({
    id: "run-blank",
    status: "succeeded",
    result: {},
    turns: [],
  });
  assert.equal(draft.name, "");
  assert.equal(draft.description, "");
  assert.equal(draft.missingGoal, true);
  assert.equal(draft.missingOutcome, true);
  assert.equal(draft.ready, false);
  assert.match(draft.instructions, /no captured goal text/);
});

test("draft fields respect private-skill store limits", () => {
  const long = "目标".repeat(300);
  const draft = draftPrivateSkillFromRun({
    id: "run-long",
    status: "succeeded",
    prompt: long,
    result: { final: "结果".repeat(3000) },
  });
  assert.ok(draft.name.length <= PRIVATE_SKILL_DRAFT_LIMITS.nameMax);
  assert.ok(draft.description.length <= PRIVATE_SKILL_DRAFT_LIMITS.descriptionMax);
  assert.ok(draft.instructions.length <= PRIVATE_SKILL_DRAFT_LIMITS.instructionsMax);
});

test("save skill action markup is a real button bound to the run id", () => {
  const html = saveSkillActionMarkup("run-1");
  assert.match(html, /data-save-private-skill="run-1"/);
  assert.match(html, /存为 Private skill/);
  assert.equal(saveSkillActionMarkup(""), "");
});
