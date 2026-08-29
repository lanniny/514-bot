import test from "node:test";
import assert from "node:assert/strict";
import { conversationOwnsRun } from "../public/modules/conversation-run-ownership.js";

test("modern runs belong only to their explicit conversationId", () => {
  const conversationA = { id: "conversation-a", activeRunId: "run-1", runIds: ["run-1"] };
  const conversationB = { id: "conversation-b", activeRunId: "run-1", runIds: ["run-1"] };
  const run = { id: "run-1", conversationId: "conversation-b" };

  assert.equal(conversationOwnsRun(run, conversationA, [conversationA, conversationB]), false);
  assert.equal(conversationOwnsRun(run, conversationB, [conversationA, conversationB]), true);
});

test("legacy runs require one unique Conversation-owned link", () => {
  const conversationA = { id: "conversation-a", activeRunId: "run-a", runIds: ["run-a", "run-old"] };
  const conversationB = { id: "conversation-b", activeRunId: "run-b", runIds: ["run-b"] };

  assert.equal(conversationOwnsRun({ id: "run-a" }, conversationA, [conversationA, conversationB]), true);
  assert.equal(conversationOwnsRun({ id: "run-old" }, conversationA, [conversationA, conversationB]), true);
  assert.equal(conversationOwnsRun({ id: "run-missing" }, conversationA, [conversationA, conversationB]), false);
});

test("ambiguous legacy ownership fails closed for every Conversation", () => {
  const conversationA = { id: "conversation-a", activeRunId: "run-shared", runIds: ["run-shared"] };
  const conversationB = { id: "conversation-b", activeRunId: "run-shared", runIds: ["run-shared"] };
  const run = { id: "run-shared" };

  assert.equal(conversationOwnsRun(run, conversationA, [conversationA, conversationB]), false);
  assert.equal(conversationOwnsRun(run, conversationB, [conversationA, conversationB]), false);
});

test("duplicate projections of the same Conversation do not create a false conflict", () => {
  const original = { id: "conversation-a", activeRunId: "run-1", runIds: ["run-1"] };
  const duplicate = { ...original };

  assert.equal(conversationOwnsRun({ id: "run-1" }, original, [original, duplicate]), true);
});
