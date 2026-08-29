import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationStore, CONVERSATION_SCHEMA } from "../src/conversations.mjs";
import { ProjectRegistry } from "../src/projects.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "514cc-conversations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("list survives records whose updatedAt is null and orders them last", async (t) => {
  const dataRoot = await fixture(t);
  await writeFile(
    join(dataRoot, "conversations.json"),
    JSON.stringify({
      schema: CONVERSATION_SCHEMA,
      revision: 0,
      items: [
        {
          id: "c-null-a", kind: "direct", title: "null-a", directMemberId: "miku-fast",
          memberIds: ["miku-fast"], runIds: [], activeRunId: null, projectId: null,
          scope: "global", roomRole: "task", pinned: false, unread: false,
          hiddenAt: null, deletedAt: null, sourceConversationId: null,
          revision: 0, createdAt: null, updatedAt: null,
        },
        {
          id: "c-null-b", kind: "direct", title: "null-b", directMemberId: "miku-fast",
          memberIds: ["miku-fast"], runIds: [], activeRunId: null, projectId: null,
          scope: "global", roomRole: "task", pinned: false, unread: false,
          hiddenAt: null, deletedAt: null, sourceConversationId: null,
          revision: 1, createdAt: null, updatedAt: null,
        },
        {
          id: "c-live", kind: "direct", title: "live", directMemberId: "miku-fast",
          memberIds: ["miku-fast"], runIds: [], activeRunId: null, projectId: null,
          scope: "global", roomRole: "task", pinned: true, unread: false,
          hiddenAt: null, deletedAt: null, sourceConversationId: null,
          revision: 2, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z",
        },
      ],
    }),
    "utf8",
  );
  const store = await new ConversationStore({ dataRoot }).init();
  const list = store.list();
  assert.deepEqual(
    list.map((item) => item.id),
    ["c-live", "c-null-a", "c-null-b"],
    "pinned live record first, null-updatedAt records stable and not disposed by an exception",
  );
  assert.equal(store.status().count, 3);
});

test("direct conversations persist identity without copying message content", async (t) => {
  const dataRoot = await fixture(t);
  const store = await new ConversationStore({ dataRoot }).init();
  const created = await store.create({ kind: "direct", title: "Miku", directMemberId: "miku-fast" });
  const attached = await store.attachRun(created.id, "run-1");
  assert.deepEqual(attached.memberIds, ["miku-fast"]);
  assert.deepEqual(attached.runIds, ["run-1"]);
  assert.equal(attached.activeRunId, "run-1");
  assert.equal(Object.hasOwn(attached, "messages"), false);

  const restarted = await new ConversationStore({ dataRoot }).init();
  assert.equal(restarted.get(created.id).activeRunId, "run-1");
  const disk = JSON.parse(await readFile(join(dataRoot, "conversations.json"), "utf8"));
  assert.equal(disk.schema, CONVERSATION_SCHEMA);
});

test("purgeDeleted removes only deletion tombstones with store-level CAS", async (t) => {
  const dataRoot = await fixture(t);
  const store = await new ConversationStore({ dataRoot }).init();
  const deleted = await store.create({ kind: "direct", title: "Deleted", directMemberId: "codex-technical" });
  const hidden = await store.create({ kind: "direct", title: "Hidden", directMemberId: "miku-fast" });
  await store.remove(deleted.id, { expectedRevision: deleted.revision });
  await store.update(hidden.id, { expectedRevision: hidden.revision, hidden: true });
  const revision = store.status().revision;

  await assert.rejects(
    store.purgeDeleted({ expectedStoreRevision: revision - 1 }),
    (error) => error.code === "CONVERSATION_STORE_REVISION_MISMATCH"
      && error.actualRevision === revision,
  );
  assert.equal(store.list({ includeHidden: true, includeDeleted: true }).length, 2);

  const result = await store.purgeDeleted({ expectedStoreRevision: revision });
  assert.deepEqual(result.conversationIds, [deleted.id]);
  assert.equal(result.purged, 1);
  assert.equal(store.list({ includeHidden: true, includeDeleted: true }).some((item) => item.id === deleted.id), false);
  assert.ok(store.get(hidden.id).hiddenAt, "hidden conversation must not be purged");
});

test("purgeDeleted preserves tombstones that still own run history", async (t) => {
  const dataRoot = await fixture(t);
  const store = await new ConversationStore({ dataRoot }).init();
  const deleted = await store.create({ kind: "direct", title: "Has history", directMemberId: "codex-technical" });
  await store.attachRun(deleted.id, "run-audit");
  const tombstone = await store.remove(deleted.id, { expectedRevision: deleted.revision + 1 });
  const result = await store.purgeDeleted({ expectedStoreRevision: store.status().revision });
  assert.equal(result.purged, 0);
  assert.deepEqual(result.skipped, [{ conversationId: deleted.id, reason: "active-run" }]);
  assert.equal(store.get(deleted.id).deletedAt, tombstone.deletedAt);
});

test("a run can belong to only one conversation", async (t) => {
  const dataRoot = await fixture(t);
  const store = await new ConversationStore({ dataRoot }).init();
  const first = await store.create({ kind: "direct", title: "First", directMemberId: "miku-fast" });
  const second = await store.create({ kind: "direct", title: "Second", directMemberId: "codex-technical" });
  await store.attachRun(first.id, "run-shared");
  await assert.rejects(
    store.attachRun(second.id, "run-shared"),
    (error) => error.code === "RUN_CONVERSATION_CONFLICT"
      && error.runId === "run-shared"
      && error.ownerConversationId === first.id
      && error.conversationId === second.id,
  );
  assert.deepEqual(store.get(second.id).runIds, []);
});

test("startup fails closed when two conversations reference the same run", async (t) => {
  const dataRoot = await fixture(t);
  const now = new Date().toISOString();
  const record = (id, memberId) => ({
    id,
    kind: "direct",
    title: id,
    projectId: null,
    scope: "global",
    roomRole: "task",
    directMemberId: memberId,
    memberIds: [memberId],
    runIds: ["run-shared"],
    activeRunId: "run-shared",
    pinned: false,
    unread: false,
    hiddenAt: null,
    deletedAt: null,
    sourceConversationId: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
  await writeFile(join(dataRoot, "conversations.json"), JSON.stringify({
    schema: CONVERSATION_SCHEMA,
    revision: 1,
    items: [record("conversation-a", "miku-fast"), record("conversation-b", "codex-technical")],
  }), "utf8");
  const store = await new ConversationStore({ dataRoot }).init();
  assert.equal(store.status().failClosed, true);
  assert.equal(store.status().code, "CONVERSATION_STORE_INVALID");
  assert.throws(() => store.list(), { code: "CONVERSATION_STORE_UNAVAILABLE" });
});

test("one project can own one default room and multiple task conversations", async (t) => {
  const dataRoot = await fixture(t);
  const workspace = join(dataRoot, "Workspace");
  await mkdir(workspace);
  const projects = await new ProjectRegistry({ dataRoot }).init();
  const store = await new ConversationStore({ dataRoot, projects }).init();
  const first = await store.create({ kind: "workspace_group", title: "A", memberIds: ["miku-fast"], cwd: `${workspace}/` });
  const second = await store.create({ kind: "workspace_group", title: "B", memberIds: ["codex-technical"], cwd: workspace });
  assert.equal(first.projectId, second.projectId);
  assert.equal(first.roomRole, "default");
  assert.equal(second.roomRole, "task");
  assert.equal(store.list().filter((item) => item.kind === "workspace_group").length, 2);
  assert.equal(projects.get(first.projectId).defaultConversationId, first.id);
});

test("project rooms may remain unstaffed until the user is ready to start a run", async (t) => {
  const dataRoot = await fixture(t);
  const workspace = join(dataRoot, "Unstaffed");
  await mkdir(workspace);
  const projects = await new ProjectRegistry({ dataRoot }).init();
  const store = await new ConversationStore({ dataRoot, projects }).init();
  const room = await store.create({ kind: "workspace_group", title: "Draft", memberIds: [], cwd: workspace });
  assert.deepEqual(room.memberIds, []);
  assert.equal(room.roomRole, "default");
  const staffed = await store.update(room.id, { expectedRevision: room.revision, memberIds: ["codex-technical"] });
  assert.deepEqual(staffed.memberIds, ["codex-technical"]);
  const unstaffed = await store.update(room.id, { expectedRevision: staffed.revision, memberIds: [] });
  assert.deepEqual(unstaffed.memberIds, []);
  const restarted = await new ConversationStore({ dataRoot, projects }).init();
  assert.deepEqual(restarted.get(room.id).memberIds, []);
});

test("metadata uses record revisions and delete is a tombstone", async (t) => {
  const dataRoot = await fixture(t);
  const store = await new ConversationStore({ dataRoot }).init();
  const created = await store.create({ kind: "direct", title: "Codex", directMemberId: "codex-technical" });
  const pinned = await store.update(created.id, { expectedRevision: 0, pinned: true, unread: true });
  assert.equal(pinned.revision, 1);
  assert.deepEqual(store.referencesForMember("codex-technical"), [`conversation:${created.id}`]);
  await assert.rejects(
    store.withMemberReferenceGuard("codex-technical", async () => undefined),
    (error) => error.code === "MEMBER_IN_USE" && error.references[0] === `conversation:${created.id}`,
  );
  await assert.rejects(
    store.update(created.id, { expectedRevision: 0, title: "stale" }),
    (error) => error.code === "CONVERSATION_REVISION_MISMATCH" && error.actualRevision === 1,
  );
  const removed = await store.remove(created.id, { expectedRevision: 1 });
  assert.ok(removed.deletedAt);
  assert.deepEqual(store.referencesForMember("codex-technical"), []);
  assert.equal(store.list().length, 0);
  assert.equal(store.list({ includeHidden: true, includeDeleted: true }).length, 1);
});

test("workspace duplicates require a new directory and do not copy run state", async (t) => {
  const dataRoot = await fixture(t);
  const first = join(dataRoot, "first");
  const second = join(dataRoot, "second");
  await mkdir(first);
  await mkdir(second);
  const projects = await new ProjectRegistry({ dataRoot }).init();
  const store = await new ConversationStore({ dataRoot, projects }).init();
  const source = await store.create({ kind: "workspace_group", title: "Group", memberIds: ["miku-fast"], cwd: first });
  await store.attachRun(source.id, "run-source");
  const sameProjectDuplicate = await store.duplicate(source.id);
  assert.equal(sameProjectDuplicate.projectId, source.projectId);
  assert.equal(sameProjectDuplicate.roomRole, "task");
  const duplicate = await store.duplicate(source.id, { cwd: second });
  assert.equal(duplicate.sourceConversationId, source.id);
  assert.deepEqual(duplicate.runIds, []);
  assert.equal(duplicate.activeRunId, null);
});

test("archived projects seal conversation and run creation until restored", async (t) => {
  const dataRoot = await fixture(t);
  const workspace = join(dataRoot, "sealed-workspace");
  await mkdir(workspace);
  const projects = await new ProjectRegistry({ dataRoot }).init();
  const store = await new ConversationStore({ dataRoot, projects }).init();
  const room = await store.create({ kind: "workspace_group", title: "Sealed", memberIds: ["miku-fast"], cwd: workspace });
  const project = projects.get(room.projectId);
  await projects.update(project.projectId, { expectedRevision: project.revision, archived: true });
  await assert.rejects(
    store.create({ kind: "workspace_group", title: "Blocked", memberIds: ["miku-fast"], projectId: project.projectId }),
    { code: "PROJECT_ARCHIVED" },
  );
  await assert.rejects(store.attachRun(room.id, "run-blocked"), { code: "PROJECT_ARCHIVED" });
  const archived = projects.get(project.projectId);
  await projects.update(project.projectId, { expectedRevision: archived.revision, archived: false });
  assert.equal((await store.attachRun(room.id, "run-restored")).activeRunId, "run-restored");
});

test("failed create compensation blocks an inconsistent conversation store", async (t) => {
  const root = await fixture(t);
  const dataRoot = join(root, "create-store");
  await mkdir(dataRoot);
  const project = { projectId: "project-create", canonicalCwd: root, title: "Project", archivedAt: null };
  const projects = {
    get: () => project,
    async attachConversation() {},
    async detachConversation() { throw Object.assign(new Error("detach failed"), { code: "DETACH_FAILED" }); },
  };
  const store = await new ConversationStore({ dataRoot, projects }).init();
  await rm(dataRoot, { recursive: true, force: true });
  await writeFile(dataRoot, "persistence blocked", "utf8");
  await assert.rejects(
    store.create({ kind: "workspace_group", title: "Inconsistent", memberIds: ["miku-fast"], projectId: project.projectId }),
    (error) => error.code === "TRANSACTION_INCONSISTENT" && error.recoveryRequired === true,
  );
  assert.deepEqual(store.status(), {
    state: "blocked",
    failClosed: true,
    code: "TRANSACTION_INCONSISTENT",
    message: "conversation transaction is inconsistent after conversation-create rollback; operator recovery is required",
    revision: 0,
    count: 0,
  });
  assert.throws(() => store.list(), { code: "CONVERSATION_STORE_UNAVAILABLE" });
});

test("failed remove compensation blocks an inconsistent conversation store", async (t) => {
  const root = await fixture(t);
  const dataRoot = join(root, "remove-store");
  await mkdir(dataRoot);
  const project = { projectId: "project-remove", canonicalCwd: root, title: "Project", archivedAt: null };
  let attachCalls = 0;
  const projects = {
    get: () => project,
    async attachConversation() {
      attachCalls += 1;
      if (attachCalls > 1) throw Object.assign(new Error("reattach failed"), { code: "REATTACH_FAILED" });
    },
    async detachConversation() {},
  };
  const store = await new ConversationStore({ dataRoot, projects }).init();
  const room = await store.create({ kind: "workspace_group", title: "Inconsistent", memberIds: ["miku-fast"], projectId: project.projectId });
  await rm(dataRoot, { recursive: true, force: true });
  await writeFile(dataRoot, "persistence blocked", "utf8");
  await assert.rejects(
    store.remove(room.id),
    (error) => error.code === "TRANSACTION_INCONSISTENT" && error.operation === "conversation-remove rollback",
  );
  assert.equal(store.status().failClosed, true);
  assert.equal(store.status().code, "TRANSACTION_INCONSISTENT");
});

test("v1 workspace groups migrate to a project default room while directs stay global", async (t) => {
  const dataRoot = await fixture(t);
  const workspace = join(dataRoot, "legacy-workspace");
  await mkdir(workspace);
  const now = new Date().toISOString();
  await writeFile(join(dataRoot, "conversations.json"), `${JSON.stringify({
    schema: "514cc.conversations/v1",
    revision: 4,
    items: [
      {
        id: "legacy-group",
        kind: "workspace_group",
        title: "Legacy Project",
        directMemberId: null,
        memberIds: ["miku-fast"],
        cwd: workspace,
        workspaceKey: workspace,
        runIds: [],
        activeRunId: null,
        pinned: false,
        unread: false,
        hiddenAt: null,
        deletedAt: null,
        sourceConversationId: null,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "legacy-direct",
        kind: "direct",
        title: "Miku",
        directMemberId: "miku-fast",
        memberIds: ["miku-fast"],
        cwd: null,
        workspaceKey: null,
        runIds: [],
        activeRunId: null,
        pinned: false,
        unread: false,
        hiddenAt: null,
        deletedAt: null,
        sourceConversationId: null,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      },
    ],
  }, null, 2)}\n`, "utf8");
  const projects = await new ProjectRegistry({ dataRoot }).init();
  const store = await new ConversationStore({ dataRoot, projects }).init();
  const group = store.get("legacy-group");
  const direct = store.get("legacy-direct");
  assert.equal(group.scope, "project");
  assert.equal(group.roomRole, "default");
  assert.ok(group.projectId);
  assert.equal(direct.scope, "global");
  assert.equal(direct.projectId, null);
  assert.equal(JSON.parse(await readFile(join(dataRoot, "conversations.json"), "utf8")).schema, CONVERSATION_SCHEMA);
});

test("corrupt stores fail closed and are not overwritten", async (t) => {
  const dataRoot = await fixture(t);
  const path = join(dataRoot, "conversations.json");
  await writeFile(path, "{broken", "utf8");
  const store = await new ConversationStore({ dataRoot }).init();
  assert.equal(store.status().failClosed, true);
  assert.throws(() => store.list(), (error) => error.code === "CONVERSATION_STORE_UNAVAILABLE");
  await assert.rejects(
    store.create({ kind: "direct", title: "Miku", directMemberId: "miku-fast" }),
    (error) => error.code === "CONVERSATION_STORE_UNAVAILABLE",
  );
  assert.equal(await readFile(path, "utf8"), "{broken");
});
