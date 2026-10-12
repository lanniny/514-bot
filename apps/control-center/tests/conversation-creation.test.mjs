import test from "node:test";
import assert from "node:assert/strict";
import { createConversationCreation } from "../public/modules/conversation-creation.js";

const record = { id: "conversation-1", kind: "direct", directMemberId: "assistant-a", projectId: null };
const command = { memberId: "assistant-a", title: "今天的想法" };

test("new conversation freezes its target, prevents duplicate creation, and never starts a Run", async () => {
  let finish;
  const requests = [];
  const created = [];
  const creation = createConversationCreation({
    request: (path, options) => { requests.push({ path, ...options }); return new Promise((resolve) => { finish = resolve; }); },
    onCreated: (value) => created.push(value),
  });
  const mutable = { ...command };
  const first = creation.createDirect(mutable);
  mutable.memberId = "assistant-b";
  await assert.rejects(creation.createDirect(command), /正在创建/);
  assert.equal(creation.isPending(), true);
  finish({ conversation: record });
  assert.deepEqual(await first, record);
  assert.equal(creation.isPending(), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/conversations");
  assert.deepEqual(requests[0].body, { kind: "direct", title: command.title, directMemberId: "assistant-a" });
  assert.deepEqual(created, [record]);
});

test("unknown outcomes and foreign receipts are not retried or accepted", async () => {
  for (const outcome of [new Error("offline"), { conversation: { ...record, directMemberId: "assistant-b" } }, { conversation: { ...record, projectId: "project-other" } }]) {
    let calls = 0;
    const creation = createConversationCreation({
      request: async () => { calls++; if (outcome instanceof Error) throw outcome; return outcome; },
      onCreated: () => assert.fail("foreign/unknown receipt must not be published"),
    });
    await assert.rejects(creation.createDirect(command), (error) => error.outcomeUnknown === true);
    assert.equal(calls, 1);
    assert.equal(creation.isPending(), false);
  }
});

test("known rejection can be corrected, while a presentation failure preserves the accepted receipt", async () => {
  const rejection = Object.assign(new Error("成员已删除"), { status: 404 });
  let calls = 0;
  const errors = [];
  const creation = createConversationCreation({
    request: async () => { if (++calls === 1) throw rejection; return { conversation: record }; },
    onCreated: () => { throw new Error("render failed"); },
    onPresentationError: (error) => errors.push(error.message),
  });
  await assert.rejects(creation.createDirect(command), (error) => error === rejection);
  assert.deepEqual(await creation.createDirect(command), record);
  assert.deepEqual(errors, ["render failed"]);
});

test("a timed out creation aborts its transport and releases the pending guard", async () => {
  let aborted = false;
  const creation = createConversationCreation({ timeoutMs: 5, request: (_path, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
  }) });
  await assert.rejects(creation.createDirect(command), (error) => error.outcomeUnknown === true);
  assert.equal(aborted, true);
  assert.equal(creation.isPending(), false);
});
