import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectRegistry, PROJECT_SCHEMA } from "../src/projects.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "514cc-projects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("list survives records whose updatedAt is null and orders them last", async (t) => {
  const dataRoot = await fixture(t);
  await writeFile(
    join(dataRoot, "projects.json"),
    JSON.stringify({
      schema: PROJECT_SCHEMA,
      revision: 0,
      items: [
        {
          projectId: "p-null-a", anchorId: "anchor-a", title: "null-a",
          canonicalCwd: join(dataRoot, "null-a"), previousCwd: null,
          defaultConversationId: null, conversationIds: [], pinned: false,
          archivedAt: null, revision: 0, createdAt: null, updatedAt: null,
        },
        {
          projectId: "p-null-b", anchorId: "anchor-b", title: "null-b",
          canonicalCwd: join(dataRoot, "null-b"), previousCwd: null,
          defaultConversationId: null, conversationIds: [], pinned: false,
          archivedAt: null, revision: 1, createdAt: null, updatedAt: null,
        },
        {
          projectId: "p-live", anchorId: "anchor-live", title: "live",
          canonicalCwd: join(dataRoot, "live"), previousCwd: null,
          defaultConversationId: null, conversationIds: [], pinned: true,
          archivedAt: null, revision: 2, createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
        },
      ],
    }),
    "utf8",
  );
  const registry = await new ProjectRegistry({ dataRoot }).init();
  const list = registry.list();
  assert.deepEqual(
    list.map((item) => item.projectId),
    ["p-live", "p-null-a", "p-null-b"],
    "pinned live project first, null-updatedAt projects stable and listed without exception",
  );
  assert.equal(registry.status().count, 3);
});

test("one canonical cwd resolves to one durable project under concurrent ensure", async (t) => {
  const dataRoot = await fixture(t);
  const workspace = join(dataRoot, "workspace");
  await mkdir(workspace);
  const registry = await new ProjectRegistry({ dataRoot }).init();
  const [first, second] = await Promise.all([
    registry.ensure({ cwd: workspace, title: "514 Bot" }),
    registry.ensure({ cwd: `${workspace}/`, title: "ignored duplicate" }),
  ]);
  assert.equal(first.projectId, second.projectId);
  assert.equal(registry.list().length, 1);
  const restarted = await new ProjectRegistry({ dataRoot }).init();
  assert.equal(restarted.get(first.projectId).canonicalCwd, first.canonicalCwd);
  const disk = JSON.parse(await readFile(join(dataRoot, "projects.json"), "utf8"));
  assert.equal(disk.schema, PROJECT_SCHEMA);
});

test("a project has at most one default collaboration room and many task rooms", async (t) => {
  const dataRoot = await fixture(t);
  const workspace = join(dataRoot, "workspace");
  await mkdir(workspace);
  const registry = await new ProjectRegistry({ dataRoot }).init();
  const project = await registry.ensure({ cwd: workspace, title: "Project" });
  await registry.attachConversation(project.projectId, "conversation-default", { roomRole: "default" });
  await registry.attachConversation(project.projectId, "conversation-task-a", { roomRole: "task" });
  await registry.attachConversation(project.projectId, "conversation-task-b", { roomRole: "task" });
  await assert.rejects(
    registry.attachConversation(project.projectId, "conversation-default-2", { roomRole: "default" }),
    (error) => error.code === "PROJECT_DEFAULT_CONVERSATION_CONFLICT"
      && error.conversationId === "conversation-default",
  );
  const stored = registry.get(project.projectId);
  assert.equal(stored.defaultConversationId, "conversation-default");
  assert.deepEqual(stored.conversationIds, ["conversation-default", "conversation-task-a", "conversation-task-b"]);
});

test("project metadata is CAS protected and archive state is reversible", async (t) => {
  const dataRoot = await fixture(t);
  const workspace = join(dataRoot, "workspace");
  await mkdir(workspace);
  const registry = await new ProjectRegistry({ dataRoot }).init();
  const project = await registry.ensure({ cwd: workspace, title: "Project" });
  const archived = await registry.update(project.projectId, { expectedRevision: 0, archived: true });
  assert.ok(archived.archivedAt);
  assert.equal(registry.list().length, 0);
  assert.equal(registry.list({ includeArchived: true }).length, 1);
  await assert.rejects(
    registry.attachConversation(project.projectId, "conversation-after-archive", { roomRole: "task" }),
    (error) => error.code === "PROJECT_ARCHIVED" && error.projectId === project.projectId,
  );
  await assert.rejects(
    registry.update(project.projectId, { expectedRevision: 0, title: "stale" }),
    (error) => error.code === "PROJECT_REVISION_MISMATCH" && error.actualRevision === 1,
  );
  const restored = await registry.update(project.projectId, { expectedRevision: 1, archived: false });
  assert.equal(restored.archivedAt, null);
});

test("corrupt project registries fail closed without overwriting source bytes", async (t) => {
  const dataRoot = await fixture(t);
  const path = join(dataRoot, "projects.json");
  await writeFile(path, "{broken", "utf8");
  const registry = await new ProjectRegistry({ dataRoot }).init();
  assert.equal(registry.status().failClosed, true);
  assert.throws(() => registry.list(), (error) => error.code === "PROJECT_STORE_UNAVAILABLE");
  assert.equal(await readFile(path, "utf8"), "{broken");
});
