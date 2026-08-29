import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CONVERSATION_CONTEXT_SCHEMA,
  ConversationContextStore,
} from "../src/conversation-contexts.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "514cc-conversation-contexts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function candidate(overrides = {}) {
  return {
    memberId: "codex-technical",
    runtimeProfileId: "codex-technical",
    adapterId: "codex-app-server",
    providerBinding: { mode: "bound", effectiveProviderId: "openai-main" },
    cwdKey: "i:/workspace",
    remoteKey: null,
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    ...candidate(),
    sessionId: "session-1",
    protocol: "app-server-v2",
    sourceAttemptId: "attempt-1",
    ...overrides,
  };
}

test("context epochs inherit only completed bindings and serialize native session ownership", async (t) => {
  const dataRoot = await fixture(t);
  const store = await new ConversationContextStore({ dataRoot }).init();
  const first = await store.claim({
    conversationId: "conversation-1",
    topologyKey: "topology-a",
    runId: "run-1",
    candidates: [candidate()],
  });
  assert.equal(first.epoch, 1);
  assert.deepEqual(first.inherited, {});

  assert.deepEqual(await store.publish({
    conversationId: "conversation-1",
    topologyKey: "topology-a",
    runId: "run-1",
    binding: binding(),
  }), { published: true, epoch: 1, revision: 1 });

  const second = await store.claim({
    conversationId: "conversation-1",
    topologyKey: "topology-a",
    runId: "run-2",
    candidates: [candidate()],
  });
  assert.equal(second.inherited["codex-technical"].sessionId, "session-1");
  assert.equal(second.inherited["codex-technical"].ownerRunId, "run-2");

  const concurrent = await store.claim({
    conversationId: "conversation-1",
    topologyKey: "topology-a",
    runId: "run-3",
    candidates: [candidate()],
    ownerIsActive: (runId) => runId === "run-2",
  });
  assert.deepEqual(concurrent.inherited, {}, "an active Run must retain exclusive ownership of the native session");
  assert.deepEqual(await store.invalidate({
    conversationId: "conversation-1",
    memberId: "codex-technical",
    sessionId: "session-1",
    ownerRunId: "run-1",
    reason: "stale-owner-cancelled",
  }), { invalidated: false, reason: "owner-changed" });
  assert.equal(store.get("conversation-1").bindings["codex-technical"].ownerRunId, "run-2");

  const late = await store.publish({
    conversationId: "conversation-1",
    topologyKey: "topology-a",
    runId: "run-1",
    binding: binding({ sessionId: "late-session", sourceAttemptId: "attempt-late" }),
  });
  assert.deepEqual(late, { published: false, reason: "owner-changed" });

  const promoted = await store.publish({
    conversationId: "conversation-1",
    topologyKey: "topology-a",
    runId: "run-2",
    binding: binding({ sessionId: "session-2", sourceAttemptId: "attempt-2" }),
  });
  assert.equal(promoted.published, true);
  assert.equal((await store.invalidate({
    conversationId: "conversation-1",
    memberId: "codex-technical",
    sessionId: "session-1",
  })).invalidated, false, "a stale invalidation must not delete a newer binding");
  assert.equal((await store.invalidate({
    conversationId: "conversation-1",
    memberId: "codex-technical",
    sessionId: "session-2",
    reason: "context-compaction-failed",
  })).invalidated, true);

  const disk = JSON.parse(await readFile(join(dataRoot, "conversation-contexts.json"), "utf8"));
  assert.equal(disk.schema, CONVERSATION_CONTEXT_SCHEMA);
  assert.equal(disk.items[0].bindings["codex-technical"], undefined);
});

test("topology changes open a fresh epoch without inheriting stale sessions", async (t) => {
  const dataRoot = await fixture(t);
  const store = await new ConversationContextStore({ dataRoot }).init();
  await store.claim({ conversationId: "conversation-1", topologyKey: "topology-a", runId: "run-1", candidates: [] });
  await store.publish({
    conversationId: "conversation-1",
    topologyKey: "topology-a",
    runId: "run-1",
    binding: binding(),
  });
  const changed = await store.claim({
    conversationId: "conversation-1",
    topologyKey: "topology-b",
    runId: "run-2",
    candidates: [candidate({ runtimeProfileId: "codex-next" })],
  });
  assert.equal(changed.epoch, 2);
  assert.equal(changed.topologyChanged, true);
  assert.deepEqual(changed.inherited, {});
  assert.deepEqual(store.get("conversation-1").bindings, {});
});

test("publication rolls back before releasing the store queue when its owner is cancelled mid-write", async (t) => {
  const dataRoot = await fixture(t);
  const store = await new ConversationContextStore({ dataRoot }).init();
  await store.claim({ conversationId: "conversation-1", topologyKey: "topology-a", runId: "run-1", candidates: [] });
  let ownerChecks = 0;
  const result = await store.publish({
    conversationId: "conversation-1",
    topologyKey: "topology-a",
    runId: "run-1",
    binding: binding(),
    ownerIsValid: () => ownerChecks++ === 0,
  });
  assert.equal(result.published, false);
  assert.equal(result.reason, "owner-invalidated");
  assert.deepEqual(store.get("conversation-1").bindings, {});
  const disk = JSON.parse(await readFile(join(dataRoot, "conversation-contexts.json"), "utf8"));
  assert.deepEqual(disk.items[0].bindings, {});
  assert.equal(disk.revision, 3);
});

test("valid context ledgers survive restart and keep epoch ownership", async (t) => {
  const dataRoot = await fixture(t);
  const first = await new ConversationContextStore({ dataRoot }).init();
  await first.claim({ conversationId: "conversation-1", topologyKey: "topology-a", runId: "run-1", candidates: [] });
  await first.publish({
    conversationId: "conversation-1",
    topologyKey: "topology-a",
    runId: "run-1",
    binding: binding(),
  });
  await first.close();

  const restarted = await new ConversationContextStore({ dataRoot }).init();
  assert.deepEqual(restarted.status(), {
    state: "ready",
    failClosed: false,
    code: null,
    message: null,
    revision: 2,
    count: 1,
  });
  assert.equal(restarted.get("conversation-1").bindings["codex-technical"].sessionId, "session-1");
  const inherited = await restarted.claim({
    conversationId: "conversation-1",
    topologyKey: "topology-a",
    runId: "run-2",
    candidates: [candidate()],
  });
  assert.equal(inherited.epoch, 1);
  assert.equal(inherited.revision, 2);
  assert.equal(inherited.inherited["codex-technical"].ownerRunId, "run-2");
  await restarted.close();
});

test("corrupt context stores fail closed and remain untouched", async (t) => {
  const dataRoot = await fixture(t);
  const path = join(dataRoot, "conversation-contexts.json");
  await writeFile(path, "{broken", "utf8");
  const store = await new ConversationContextStore({ dataRoot }).init();
  assert.equal(store.status().failClosed, true);
  assert.throws(() => store.get("conversation-1"), { code: "CONVERSATION_CONTEXT_STORE_UNAVAILABLE" });
  await assert.rejects(
    store.claim({ conversationId: "conversation-1", topologyKey: "topology-a", runId: "run-1", candidates: [] }),
    { code: "CONVERSATION_CONTEXT_STORE_UNAVAILABLE" },
  );
  assert.equal(await readFile(path, "utf8"), "{broken");
});
