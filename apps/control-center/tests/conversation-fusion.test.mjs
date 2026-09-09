import test from "node:test";
import assert from "node:assert/strict";
import { createConversationCommands } from "../public/modules/conversation-commands.js";
import { createConversationDrafts, workspaceContext, pageWorkspaceIndex } from "../public/modules/conversation-workspace.js";
import { createMessageWindow } from "../public/modules/bounded-message-view.js";
import { createConversationWindow } from "../public/modules/conversation-window.js";

const conversation = (id = "a") => ({ id, kind: "workspace_group", memberIds: ["lead", "worker"], activeRunId: "current", runIds: ["history", "current"], projectId: "project" });

test("Conversation command freezes identity and does not submit a selected historical Run", async () => {
  const selected = conversation();
  let captured;
  let release;
  const command = createConversationCommands({ request: async (path, options) => {
    captured = { path, body: options.body };
    await new Promise((resolve) => { release = resolve; });
    return { id: "accepted", conversationId: "a" };
  } });
  const recipients = ["worker"];
  const submit = command.submit({ conversation: selected, prompt: "review", recipientMemberIds: recipients, sources: [{ id: "image-a" }], permissionMode: "plan" });
  recipients[0] = "lead";
  selected.id = "b";
  assert.equal(command.isPending("a"), true);
  assert.equal(captured.path, "/api/conversations/a/messages");
  assert.equal(captured.body.runId, undefined);
  assert.deepEqual(captured.body.recipientMemberIds, ["worker"]);
  release();
  assert.equal((await submit).id, "accepted");
  assert.equal(command.isPending("a"), false);
});

test("duplicate admission is blocked per Conversation, but another Conversation remains usable", async () => {
  const releases = [];
  const commands = createConversationCommands({ request: async (path) => {
    await new Promise((resolve) => releases.push(resolve));
    return { id: "run", conversationId: path.split("/")[3] };
  } });
  const a = commands.submit({ conversation: conversation("a"), prompt: "first" });
  await assert.rejects(commands.submit({ conversation: conversation("a"), prompt: "second" }), /准入回执/);
  const b = commands.submit({ conversation: conversation("b"), prompt: "independent" });
  assert.equal(releases.length, 2);
  releases.forEach((release) => release());
  await Promise.all([a, b]);
});

test("unknown transport outcome is not retried and an alien receipt is never accepted", async () => {
  let calls = 0;
  let accepted = 0;
  const commands = createConversationCommands({ request: async () => { calls++; throw new Error("offline"); }, onAccepted: () => accepted++ });
  await assert.rejects(commands.submit({ conversation: conversation(), prompt: "work" }), /offline/);
  assert.equal(calls, 1);
  assert.equal(accepted, 0);
  assert.equal(commands.isPending("a"), false);
  const wrong = createConversationCommands({ request: async () => ({ id: "run", conversationId: "b" }), onAccepted: () => accepted++ });
  await assert.rejects(wrong.submit({ conversation: conversation(), prompt: "work" }), /归属不匹配/);
  assert.equal(accepted, 0);
});

test("roster and recipient rules are not changed into a new fan-out engine", async () => {
  const commands = createConversationCommands({ request: () => { throw new Error("must not call"); } });
  await assert.rejects(commands.submit({ conversation: { ...conversation(), memberIds: [] }, prompt: "work" }), /没有执行成员/);
  await assert.rejects(commands.submit({ conversation: conversation(), prompt: "work", recipientMemberIds: ["lead", "worker"] }), /一位成员/);
  await assert.rejects(commands.submit({ conversation: conversation(), prompt: "work", recipientMemberIds: ["outsider"] }), /一位成员/);
});

test("admission timeout is explicit and rendering failure cannot erase a valid receipt", async () => {
  let requests = 0;
  const slow = createConversationCommands({ timeoutMs: 5, request: (_path, options) => {
    requests++;
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("abort", "AbortError")), { once: true }));
  } });
  await assert.rejects(slow.submit({ conversation: conversation(), prompt: "work" }), /准入超时/);
  assert.equal(requests, 1);
  assert.equal(slow.isPending("a"), false);
  let presentationFailed = false;
  const accepted = createConversationCommands({ request: async () => ({ id: "accepted", conversationId: "a" }), onAccepted: () => { throw new Error("render"); }, onPresentationError: () => { presentationFailed = true; } });
  assert.equal((await accepted.submit({ conversation: conversation(), prompt: "work" })).id, "accepted");
  assert.equal(presentationFailed, true);
});

test("workspace separates execution owner from historical selection and refuses foreign history", () => {
  const runMap = new Map([["current", { id: "current", conversationId: "a" }], ["history", { id: "history", conversationId: "a" }], ["foreign", { id: "foreign", conversationId: "b" }]]);
  const data = { conversations: [conversation()], projects: [{ projectId: "project", archivedAt: "today" }], resolveRun: (id) => runMap.get(id) };
  const context = workspaceContext(data, "a", "history");
  assert.equal(context.selectedRun.id, "history");
  assert.equal(context.currentRun.id, "current");
  assert.equal(context.historical, true);
  assert.equal(context.readOnly, true);
  assert.equal(workspaceContext(data, "a", "foreign").selectedRun, null);
  data.conversations[0].deletedAt = "today";
  assert.equal(workspaceContext(data, "a").currentRun, null);
});

test("text drafts are isolated and reloadable without silently evicting or truncating user input", () => {
  const stored = new Map();
  const storage = { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  const drafts = createConversationDrafts({ storage });
  drafts.save("a", "中文草稿 A");
  drafts.save("b", "draft B");
  assert.equal(drafts.read("a"), "中文草稿 A");
  assert.equal(createConversationDrafts({ storage }).read("b"), "draft B");
  drafts.save("a", "");
  assert.equal(drafts.read("a"), "");
  for (let index = 0; index < 30; index++) drafts.save(`item-${index}`, "x");
  assert.equal(createConversationDrafts({ storage }).read("item-0"), "x");
  const long = "x".repeat(20000);
  drafts.save("long", long);
  assert.equal(createConversationDrafts({ storage }).read("long"), long);
  let failures = 0;
  const unavailable = createConversationDrafts({ storage: { getItem: () => null, setItem: () => { throw new Error("quota"); } }, onStorageError: () => failures++ });
  unavailable.save("keep", long);
  assert.equal(unavailable.read("keep"), long);
  assert.equal(failures, 1);
});

test("1,000 Conversations and empty Project drafts are all reachable without an unbounded rail", () => {
  const conversations = Array.from({ length: 1000 }, (_, index) => ({ id: `c${index}`, projectId: "p" }));
  const projects = [{ projectId: "p" }, { projectId: "empty-draft" }];
  const first = pageWorkspaceIndex(conversations, projects);
  assert.equal(first.conversations.length, 100);
  assert.equal(first.pages, 11);
  const ids = new Set();
  for (let page = 0; page < first.pages; page++) {
    const batch = pageWorkspaceIndex(conversations, projects, { page });
    assert.ok(batch.conversations.length <= 100);
    batch.conversations.forEach((item) => ids.add(item.id));
    if (page === 10) assert.equal(batch.projects[0].projectId, "empty-draft");
  }
  assert.equal(ids.size, 1000);
});

test("5,000 messages remain navigable in windows of 160 with stable reading anchor", () => {
  const messages = Array.from({ length: 5000 }, (_, index) => ({ key: `message-${index}` }));
  const window = createMessageWindow();
  assert.equal(window.page(messages).visible.length, 160);
  window.move(messages, "earlier");
  const anchor = window.page(messages).visible[0].key;
  messages.push({ key: "message-5000" });
  assert.equal(window.page(messages).visible[0].key, anchor);
  window.move(messages, "latest");
  assert.equal(window.page(messages).visible.at(-1).key, "message-5000");
  let count = 0;
  while (window.page(messages).before) { window.move(messages, "earlier"); count++; }
  assert.ok(count > 20);
  assert.equal(window.page(messages).visible[0].key, "message-0");
});

test("legacy team reading window freezes with the same render key as its renderer", () => {
  const messages = Array.from({ length: 200 }, (_, index) => ({ key: `m${index}` }));
  const run = { id: "r" };
  const source = createConversationWindow({
    state: { view: "workbench", selectedRunId: "r" },
    elements: { "conversation-stream": { dataset: { renderContext: "run:r:team" }, getAttribute: () => "false", scrollHeight: 2000, scrollTop: 100, clientHeight: 500, children: [{ dataset: { streamKey: "m40" } }] } },
    selectedRun: () => run, conversationTabs: { activeAgentId: () => null },
    normalizeRunMessages: () => messages, conversationMessageFromEvent: () => ({}), messageMatchesAgentPage: () => true, eventAffectsConversation: () => true,
  });
  source.freezeLatestConversationWindowForIncoming({ runId: "r" });
  messages.push({ key: "m200" });
  assert.equal(source.conversationWindow(run, null, messages).start, 40);
});
