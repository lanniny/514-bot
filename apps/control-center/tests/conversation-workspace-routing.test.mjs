import test from "node:test";
import assert from "node:assert/strict";
import { createConversationWorkspace } from "../public/modules/conversation-workspace.js";

function fixture(t, openRun = async () => {}) {
  class Node extends EventTarget {
    value = "";
    dataset = {};
    classList = { toggle() {} };
    setAttribute() {}
    replaceChildren() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }
  const nodes = new Map();
  const doc = new Node();
  doc.getElementById = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Node());
    return nodes.get(id);
  };
  doc.createElement = () => new Node();
  const root = new Node();
  root.ownerDocument = doc;
  const previousHistory = globalThis.history;
  globalThis.history = { replaceState() {} };
  t.after(() => { if (previousHistory === undefined) delete globalThis.history; else globalThis.history = previousHistory; });
  const snapshot = { active: true, conversations: [], projects: [], activeConversationId: "", selectedRunId: "", connection: {}, memberLabel: (id) => id, resolveRun: () => null };
  const opened = [];
  const workspace = createConversationWorkspace({
    root, input: new Node(), getSnapshot: () => snapshot, renderInsights() {},
    openConversation(id) {
      workspace.beforeSelection();
      opened.push(id);
      snapshot.activeConversationId = id;
      return true;
    },
    openRun,
  });
  return { workspace, snapshot, opened };
}
const conversation = (id) => ({ id, kind: "direct", memberIds: ["member"], runIds: [] });

test("cold routes retain Run and tab until the member catalog permits selection", async (t) => {
  const fx = fixture(t, async (_id, runId) => { fx.snapshot.selectedRunId = runId; });
  fx.snapshot.conversations = [conversation("a")];
  fx.snapshot.selectionReady = false;
  await fx.workspace.activate("#bot?conversation=a&run=history&tab=process");
  assert.deepEqual(fx.opened, []);
  fx.snapshot.selectionReady = true;
  fx.workspace.sync();
  await new Promise(setImmediate);
  assert.deepEqual(fx.opened, ["a"]);
  assert.equal(fx.workspace.getRoute(), "#bot?conversation=a&run=history&tab=process");
});

test("a user selection cancels a route awaiting its Conversation index", async (t) => {
  const { workspace, snapshot, opened } = fixture(t);
  await workspace.activate("#bot?conversation=a&tab=results");
  workspace.beforeSelection();
  snapshot.activeConversationId = "b";
  snapshot.conversations = [conversation("b")];
  workspace.sync();
  snapshot.conversations.push(conversation("a"));
  workspace.sync();
  assert.deepEqual(opened, []);
  assert.equal(snapshot.activeConversationId, "b");
  assert.match(workspace.getRoute(), /conversation=b/);
});

test("leaving Bot cancels pending index restoration", async (t) => {
  const { workspace, snapshot, opened } = fixture(t);
  await workspace.activate("#bot?conversation=a");
  workspace.deactivate();
  snapshot.active = false;
  snapshot.conversations.push(conversation("a"));
  workspace.sync();
  snapshot.active = true;
  workspace.sync();
  assert.deepEqual(opened, []);
});

test("an obsolete route completion cannot unblock or replace a newer route", async (t) => {
  const releases = new Map();
  const { workspace, snapshot, opened } = fixture(t, (id) => new Promise((resolve) => releases.set(id, resolve)));
  snapshot.conversations = [conversation("a"), conversation("b")];
  const a = workspace.activate("#bot?conversation=a&run=old&tab=process");
  await Promise.resolve();
  const b = workspace.activate("#bot?conversation=b&run=new&tab=results");
  await Promise.resolve();
  releases.get("a")();
  await a;
  workspace.sync();
  assert.equal(workspace.getRoute(), "#bot?conversation=b&run=new&tab=results");
  assert.deepEqual(opened, ["a", "b"]);
  snapshot.selectedRunId = "new";
  releases.get("b")();
  await b;
  assert.equal(workspace.getRoute(), "#bot?conversation=b&run=new&tab=results");
});

test("history navigation waits for real Conversation selection before accepting its receipt", async (t) => {
  const fx = fixture(t);
  fx.snapshot.conversations = [conversation("a")];
  fx.snapshot.selectionReady = false;
  const navigationToken = { isCurrent: () => true };
  let settled = false;
  const result = fx.workspace.activate("#bot?conversation=a&tab=process", { navigationToken }).then((accepted) => { settled = true; return accepted; });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  assert.deepEqual(fx.opened, []);
  fx.snapshot.selectionReady = true;
  fx.workspace.sync();
  assert.equal(await result, true);
  assert.deepEqual(fx.opened, ["a"]);
});

test("an obsolete or user-superseded pending history route cannot replay later", async (t) => {
  for (const action of ["expire", "tab"]) {
    const fx = fixture(t);
    let current = true;
    const result = fx.workspace.activate("#bot?conversation=a&tab=process", { navigationToken: { isCurrent: () => current } });
    if (action === "expire") current = false;
    else fx.workspace.setTab("results");
    fx.snapshot.conversations = [conversation("a")];
    fx.snapshot.selectionReady = true;
    fx.workspace.sync();
    assert.equal(await result, false);
    await new Promise(setImmediate);
    assert.deepEqual(fx.opened, []);
    assert.ok(!fx.workspace.getRoute().includes("conversation=a"));
    if (action === "tab") assert.ok(fx.workspace.getRoute().includes("tab=results"));
  }
});

test("an already loaded index rejects a missing history target without changing the route", async (t) => {
  const fx = fixture(t);
  fx.snapshot.indexReady = true;
  fx.snapshot.selectionReady = true;
  const before = fx.workspace.getRoute();
  assert.equal(await fx.workspace.activate("#bot?conversation=missing", { navigationToken: { isCurrent: () => true } }), false);
  assert.equal(fx.workspace.getRoute(), before);
  assert.deepEqual(fx.opened, []);
});
