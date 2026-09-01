import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("conversation HTTP API persists direct and workspace identities with CAS", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-conversations-http-"));
  const repoRoot = resolve(root, "repo");
  const dataRoot = resolve(root, "data");
  const fakeHome = resolve(root, "home");
  const workspaceA = resolve(root, "workspace-a");
  const workspaceB = resolve(root, "workspace-b");
  await mkdir(resolve(repoRoot, "config/control-center"), { recursive: true });
  await mkdir(workspaceA);
  await mkdir(workspaceB);
  await writeFile(resolve(repoRoot, "config/app.json"), '{"enabled":true}\n');
  await writeFile(resolve(repoRoot, "config/control-center/models.json"), JSON.stringify({
    version: 1,
    profiles: testModelProfiles().map((profile, index) => ({
      ...profile,
      ...(profile.id === "grok-build" ? { command: process.execPath } : {}),
      quality: 0.9 - index * 0.01,
      speed: 0.8,
      costTier: 2,
    })),
  }));
  await writeFile(resolve(repoRoot, "config/control-center/routing.json"), JSON.stringify({
    version: 1,
    primaryCoordinator: "claude-fable",
    technicalExecutor: "codex-technical",
    requireHealthyProvider: false,
    failOnUnavailableExplicitProvider: false,
    weights: { quality: 0.44, speed: 0.26, health: 0.22, cost: 0.08 },
    rules: [],
  }));
  await writeFile(resolve(repoRoot, "config/control-center/permissions.json"), JSON.stringify({
    version: 1,
    defaultMode: "plan",
    modes: { plan: { write: false, approvalRequired: false }, build: { write: "workspace", approvalRequired: true } },
    limits: { maxRounds: 6, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 10_000 },
    approval: { ttlMs: 60_000 },
  }));
  await writeFile(resolve(repoRoot, "config/control-center/sources.json"), JSON.stringify({
    version: 1, explicit: [], discover: [], runtime: [],
  }));
  const token = "conversations-token-0123456789abcdef";
  const child = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: token,
      CONTROL_CENTER_REPO_ROOT: repoRoot,
      CONTROL_CENTER_DATA_DIR: dataRoot,
      CONTROL_CENTER_PORT: "0",
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
  });
  t.after(async () => {
    await stopTestServer(child, { token });
    await rm(root, { recursive: true, force: true });
  });
  const baseUrl = new URL(await waitForUrl(child));
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const request = (path, init = {}) => fetch(new URL(path, baseUrl), { ...init, headers: { ...headers, ...(init.headers || {}) } });

  assert.equal((await fetch(new URL("/api/conversations", baseUrl))).status, 401);
  assert.equal((await fetch(new URL("/api/projects", baseUrl))).status, 401);
  const directResponse = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ kind: "direct", title: "Codex 单聊", directMemberId: "codex-technical" }),
  });
  assert.equal(directResponse.status, 201);
  const direct = (await directResponse.json()).conversation;
  assert.equal(direct.kind, "direct");

  const concurrent = await Promise.all([
    request(`/api/conversations/${direct.id}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: 0, pinned: true }),
    }),
    request(`/api/conversations/${direct.id}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: 0, unread: true }),
    }),
  ]);
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409]);
  const conflict = await concurrent.find((response) => response.status === 409).json();
  assert.equal(conflict.error.code, "CONVERSATION_REVISION_MISMATCH");
  assert.equal(conflict.error.actualRevision, 1);

  const groupResponse = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({
      kind: "workspace_group",
      title: "Workspace A",
      memberIds: ["claude-fable", "codex-technical"],
      cwd: workspaceA,
    }),
  });
  assert.equal(groupResponse.status, 201);
  const group = (await groupResponse.json()).conversation;
  assert.equal(group.scope, "project");
  assert.equal(group.roomRole, "default");
  assert.ok(group.projectId);
  const duplicateCwd = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ kind: "workspace_group", title: "Conflict", memberIds: ["codex-technical"], cwd: `${workspaceA}/` }),
  });
  assert.equal(duplicateCwd.status, 201);
  const taskRoom = (await duplicateCwd.json()).conversation;
  assert.equal(taskRoom.projectId, group.projectId);
  assert.equal(taskRoom.roomRole, "task");
  const draftRoomResponse = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ kind: "workspace_group", title: "Unstaffed draft", memberIds: [], projectId: group.projectId }),
  });
  assert.equal(draftRoomResponse.status, 201);
  const draftRoom = (await draftRoomResponse.json()).conversation;
  assert.deepEqual(draftRoom.memberIds, []);

  const unauthorizedMessage = await fetch(new URL(`/api/conversations/${draftRoom.id}/messages`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "unauthorized" }),
  });
  assert.equal(unauthorizedMessage.status, 401);
  const missingConversationMessage = await request("/api/conversations/missing-conversation/messages", {
    method: "POST",
    body: JSON.stringify({ prompt: "missing" }),
  });
  assert.equal(missingConversationMessage.status, 404);
  assert.equal((await missingConversationMessage.json()).error.code, "CONVERSATION_NOT_FOUND");
  const noMemberMessage = await request(`/api/conversations/${draftRoom.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ prompt: "no active run" }),
  });
  assert.equal(noMemberMessage.status, 422);
  assert.equal((await noMemberMessage.json()).error.code, "NOT_TEAM_MEMBER");

  const messageConversationResponse = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ kind: "direct", title: "Message endpoint", directMemberId: "grok-build" }),
  });
  assert.equal(messageConversationResponse.status, 201);
  const messageConversation = (await messageConversationResponse.json()).conversation;
  const messageRunResponse = await request("/api/runs", {
    method: "POST",
    body: JSON.stringify({
      prompt: "bootstrap message route",
      execute: false,
      permissionMode: "plan",
      conversationId: messageConversation.id,
      conversationKind: "direct",
      orchestrationMode: "pipeline",
      startAgentId: "grok-build",
      requestedProvider: "grok-build",
      maxRounds: 1,
    }),
  });
  const messageRun = await messageRunResponse.json();
  assert.equal(messageRunResponse.status, 202, JSON.stringify(messageRun));
  const runReadResponse = await request(`/api/runs/${messageRun.id}`);
  assert.equal(runReadResponse.status, 200);
  assert.equal((await runReadResponse.json()).id, messageRun.id);
  const missingRunResponse = await request("/api/runs/00000000-0000-4000-8000-000000000000");
  assert.equal(missingRunResponse.status, 404);
  assert.equal((await missingRunResponse.json()).error.code, "RUN_NOT_FOUND");
  const wrongDirectRecipient = await request(`/api/conversations/${messageConversation.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ prompt: "wrong recipient", recipientMemberIds: ["claude-fable"] }),
  });
  assert.equal(wrongDirectRecipient.status, 422);
  assert.equal((await wrongDirectRecipient.json()).error.code, "NOT_TEAM_MEMBER");
  const duplicateDirectRecipient = await request(`/api/conversations/${messageConversation.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ prompt: "duplicate recipient", recipientMemberIds: ["grok-build", "grok-build"] }),
  });
  assert.equal(duplicateDirectRecipient.status, 422);
  assert.equal((await duplicateDirectRecipient.json()).error.code, "VALIDATION_FAILED");
  const continuedMessage = await request(`/api/conversations/${messageConversation.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      prompt: "continue through conversation identity",
      waitForTurn: true,
      conversationId: "client-must-not-override",
      projectId: "client-must-not-override",
      recipientMemberIds: ["grok-build"],
      permissionMode: "build",
      maxBudgetUsdPerTurn: 2,
    }),
  });
  assert.equal(continuedMessage.status, 202);
  const continuedRun = await continuedMessage.json();
  assert.notEqual(continuedRun.id, messageRun.id);
  assert.equal(continuedRun.conversationId, messageConversation.id);
  assert.equal(continuedRun.projectId, null);
  assert.equal(continuedRun.permissionMode, "plan");
  assert.equal(continuedRun.buildApproval, null);
  assert.equal(continuedRun.remote, null);
  assert.equal(continuedRun.contextInheritedFromRunId, null);
  // 预算合同（LO 2026-08-30）：硬上限门槛已废，客户端显式给出的 maxBudgetUsdPerTurn 按实接受
  assert.equal(continuedRun.maxBudgetUsdPerTurn, 2);

  const sameProjectDuplicate = await request(`/api/conversations/${group.id}/duplicate`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(sameProjectDuplicate.status, 201);
  assert.equal((await sameProjectDuplicate.json()).conversation.projectId, group.projectId);
  const duplicatedResponse = await request(`/api/conversations/${group.id}/duplicate`, {
    method: "POST",
    body: JSON.stringify({ cwd: workspaceB }),
  });
  assert.equal(duplicatedResponse.status, 201);
  const duplicated = (await duplicatedResponse.json()).conversation;
  assert.equal(duplicated.sourceConversationId, group.id);
  assert.deepEqual(duplicated.runIds, []);

  const projectsPayload = await (await request("/api/projects?includeArchived=1")).json();
  assert.equal(projectsPayload.schema, "514cc.projects/v1");
  assert.equal(projectsPayload.projects.length, 2);
  const project = projectsPayload.projects.find((item) => item.projectId === group.projectId);
  assert.equal(project.defaultConversationId, group.id);
  assert.ok(project.conversationIds.includes(taskRoom.id));
  assert.ok(project.conversationIds.includes(draftRoom.id));
  const projectPatch = await request(`/api/projects/${project.projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: project.revision, pinned: true }),
  });
  assert.equal(projectPatch.status, 200);
  const pinnedProject = (await projectPatch.json()).project;
  const exactArchive = await request("/api/projects/archive-finished", {
    method: "POST",
    body: JSON.stringify({ projectId: project.projectId, cwd: workspaceB }),
  });
  assert.equal(exactArchive.status, 200);
  assert.equal((await exactArchive.json()).matchedBy, "projectId");
  const staleProjectPatch = await request(`/api/projects/${project.projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: project.revision, title: "stale" }),
  });
  assert.equal(staleProjectPatch.status, 409);
  assert.equal((await staleProjectPatch.json()).error.code, "PROJECT_REVISION_MISMATCH");
  const archiveProject = await request(`/api/projects/${project.projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: pinnedProject.revision, archived: true }),
  });
  assert.equal(archiveProject.status, 200);
  const archivedProject = (await archiveProject.json()).project;
  const archivedMessage = await request(`/api/conversations/${group.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ prompt: "must remain read only" }),
  });
  const archivedMessagePayload = await archivedMessage.json();
  assert.equal(archivedMessage.status, 409);
  assert.equal(archivedMessagePayload.error.code, "PROJECT_ARCHIVED");
  const blockedTask = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ kind: "workspace_group", title: "Blocked", memberIds: ["codex-technical"], projectId: project.projectId }),
  });
  assert.equal(blockedTask.status, 409);
  assert.equal((await blockedTask.json()).error.code, "PROJECT_ARCHIVED");
  const restoreProject = await request(`/api/projects/${project.projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: archivedProject.revision, archived: false }),
  });
  assert.equal(restoreProject.status, 200);

  const hiddenDraftResponse = await request(`/api/conversations/${draftRoom.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: draftRoom.revision, hidden: true }),
  });
  assert.equal(hiddenDraftResponse.status, 200);
  const hiddenDraft = (await hiddenDraftResponse.json()).conversation;
  assert.ok(hiddenDraft.hiddenAt);
  const withoutHidden = await (await request("/api/conversations")).json();
  assert.equal(withoutHidden.conversations.some((item) => item.id === draftRoom.id), false);
  const includeHidden = await (await request("/api/conversations?includeHidden=1")).json();
  assert.equal(includeHidden.conversations.some((item) => item.id === draftRoom.id && item.hiddenAt), true);
  const restoredDraftResponse = await request(`/api/conversations/${draftRoom.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: hiddenDraft.revision, hidden: false }),
  });
  assert.equal(restoredDraftResponse.status, 200);
  assert.equal((await restoredDraftResponse.json()).conversation.hiddenAt, null);
  const afterRestore = await (await request("/api/conversations")).json();
  assert.equal(afterRestore.conversations.some((item) => item.id === draftRoom.id), true);

  const latestDirect = concurrent.find((response) => response.status === 200);
  const updatedDirect = (await latestDirect.json()).conversation;
  const invalidJson = await request(`/api/conversations/${direct.id}`, {
    method: "DELETE",
    body: "{broken-json",
  });
  assert.equal(invalidJson.status, 422);
  assert.equal((await invalidJson.json()).error.code, "INVALID_JSON");
  const afterInvalidJson = await (await request("/api/conversations")).json();
  assert.equal(afterInvalidJson.conversations.some((item) => item.id === direct.id), true);

  const malformedRevision = await request(`/api/conversations/${direct.id}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedRevision: "not-a-revision" }),
  });
  assert.equal(malformedRevision.status, 422);
  assert.equal((await malformedRevision.json()).error.code, "VALIDATION_FAILED");

  const staleDelete = await request(`/api/conversations/${direct.id}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedRevision: Math.max(0, updatedDirect.revision - 1) }),
  });
  assert.equal(staleDelete.status, 409);
  assert.equal((await staleDelete.json()).error.code, "CONVERSATION_REVISION_MISMATCH");

  const emptyBodyDirectResponse = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ kind: "direct", title: "Empty body delete", directMemberId: "claude-fable" }),
  });
  assert.equal(emptyBodyDirectResponse.status, 201);
  const emptyBodyDirect = (await emptyBodyDirectResponse.json()).conversation;
  const emptyBodyDelete = await request(`/api/conversations/${emptyBodyDirect.id}`, { method: "DELETE" });
  assert.equal(emptyBodyDelete.status, 200);

  const removed = await request(`/api/conversations/${direct.id}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedRevision: updatedDirect.revision }),
  });
  assert.equal(removed.status, 200);
  const visible = await (await request("/api/conversations")).json();
  assert.equal(visible.conversations.some((item) => item.id === direct.id), false);
  const withDeleted = await (await request("/api/conversations?includeHidden=1&includeDeleted=1")).json();
  assert.equal(withDeleted.conversations.some((item) => item.id === direct.id && item.deletedAt), true);
  const stalePurge = await request("/api/conversations/deleted", {
    method: "DELETE",
    body: JSON.stringify({ expectedStoreRevision: withDeleted.revision - 1 }),
  });
  assert.equal(stalePurge.status, 409);
  assert.equal((await stalePurge.json()).error.code, "CONVERSATION_STORE_REVISION_MISMATCH");
  const purge = await request("/api/conversations/deleted", {
    method: "DELETE",
    body: JSON.stringify({ expectedStoreRevision: withDeleted.revision }),
  });
  assert.equal(purge.status, 200);
  const purged = await purge.json();
  assert.equal(purged.schema, "514cc.conversations-purge/v1");
  assert.ok(purged.conversationIds.includes(direct.id));
  assert.ok(purged.conversationIds.includes(emptyBodyDirect.id));
  const afterPurge = await (await request("/api/conversations?includeHidden=1&includeDeleted=1")).json();
  assert.equal(afterPurge.conversations.some((item) => item.deletedAt), false);
  assert.equal(afterPurge.conversations.some((item) => item.id === draftRoom.id), true);
});
