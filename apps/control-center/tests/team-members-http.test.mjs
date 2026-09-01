import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

async function jsonRequest(origin, path, token, { method = "GET", body = undefined } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { response, payload };
}

test("team member CRUD, team assignment and restart persistence share one executable identity graph", { timeout: 90_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(tmpdir(), "514cc-team-members-http-"));
  const token = "e2e-team-members-token-0123456789";
  const env = {
    CONTROL_CENTER_TOKEN: token,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_PORT: "0",
  };
  let child = spawnTestServer({ env });
  t.after(async () => {
    if (child && child.exitCode == null && child.signalCode == null) {
      await stopTestServer(child, { token });
    }
    await rm(dataRoot, { recursive: true, force: true });
  });

  const firstOrigin = new URL(await waitForUrl(child)).origin;
  const initial = await jsonRequest(firstOrigin, "/api/team-members", token);
  assert.equal(initial.response.status, 200);
  assert.ok(initial.payload.members.some((member) => (
    member.id === "codex-technical"
    && member.runtimeProfileId === "codex-technical"
    && member.builtin === true
  )));
  assert.ok(initial.payload.runtimeProfiles.some((profile) => (
    profile.id === "codex-technical"
    && profile.teamMemberEligible === true
    && profile.coordinatorEligible === true
  )));

  const builtinEdit = await jsonRequest(firstOrigin, "/api/team-members/codex-technical", token, {
    method: "PUT",
    body: {
      label: "烛 · 技术执行",
      shortLabel: "烛",
      role: "code-watchman",
      description: "实现、评审与验证",
      defaultModel: "gpt-5.6-sol",
      defaultEffort: "xhigh",
    },
  });
  assert.equal(builtinEdit.response.status, 200);
  assert.equal(builtinEdit.payload.label, "烛 · 技术执行");
  assert.equal(builtinEdit.payload.runtimeProfileId, "codex-technical");

  const created = await jsonRequest(firstOrigin, "/api/team-members", token, {
    method: "POST",
    body: {
      label: "架构实现席",
      shortLabel: "架构",
      role: "architecture-implementer",
      description: "负责架构落地和回归验证",
      systemPrompt: "先确认边界，再实现并给出机械验证。",
      runtimeProfileId: "codex-technical",
      capabilities: ["architecture", "coding", "testing"],
      defaultModel: "gpt-5.6-sol",
      defaultEffort: "xhigh",
    },
  });
  assert.equal(created.response.status, 201);
  assert.match(created.payload.id, /^member-[0-9a-f-]{36}$/);
  assert.equal(created.payload.runtimeProfileId, "codex-technical");
  assert.equal(created.payload.provider, "openai");
  assert.equal(created.payload.coordinatorEligible, true);
  const memberId = created.payload.id;

  const ephemeralOnlyMember = await jsonRequest(firstOrigin, "/api/team-members", token, {
    method: "POST",
    body: {
      label: "仅群聊成员",
      shortLabel: "群聊",
      role: "ephemeral-collaborator",
      runtimeProfileId: "codex-technical",
      capabilities: ["coding", "testing"],
    },
  });
  assert.equal(ephemeralOnlyMember.response.status, 201);
  const ephemeralOnlyMemberId = ephemeralOnlyMember.payload.id;

  const teamCreated = await jsonRequest(firstOrigin, "/api/teams", token, {
    method: "POST",
    body: {
      name: "自定义架构队",
      description: "由逻辑成员担任主脑",
      coordinator: memberId,
      members: [memberId],
      skills: [],
      mcp: [],
      providers: {},
    },
  });
  assert.equal(teamCreated.response.status, 201);
  assert.equal(teamCreated.payload.coordinator, memberId);
  assert.deepEqual(teamCreated.payload.members, [memberId]);
  const teamId = teamCreated.payload.id;

  const previewTeam = await jsonRequest(firstOrigin, "/api/teams", token, {
    method: "POST",
    body: {
      name: "共享 Codex 运行席位",
      description: "验证同一 runtime 下的逻辑成员预览映射",
      coordinator: "codex-technical",
      members: ["codex-technical", memberId],
      skills: [],
      mcp: [],
      providers: {},
    },
  });
  assert.equal(previewTeam.response.status, 201);
  const routePreview = await jsonRequest(firstOrigin, "/api/router/preview", token, {
    method: "POST",
    body: {
      prompt: "实现并验证团队成员管理",
      taskType: "coding",
      risk: "low",
      teamId: previewTeam.payload.id,
      startAgentId: memberId,
      requestedAgentIds: [memberId],
    },
  });
  assert.equal(routePreview.response.status, 200);
  assert.equal(routePreview.payload.selected.id, memberId);
  assert.equal(routePreview.payload.selected.runtimeProfileId, "codex-technical");
  const invalidRequestedAgents = await jsonRequest(firstOrigin, "/api/router/preview", token, {
    method: "POST",
    body: {
      prompt: "拒绝错误点名结构",
      taskType: "coding",
      teamId: previewTeam.payload.id,
      requestedAgentIds: { memberId },
    },
  });
  assert.equal(invalidRequestedAgents.response.status, 422);
  assert.equal(invalidRequestedAgents.payload.error.code, "VALIDATION_FAILED");
  const outsideStartPreview = await jsonRequest(firstOrigin, "/api/router/preview", token, {
    method: "POST",
    body: {
      prompt: "显式目标不在团队时必须拒绝预览",
      taskType: "coding",
      teamId: previewTeam.payload.id,
      startAgentId: "outside-agent",
    },
  });
  assert.equal(outsideStartPreview.response.status, 422);
  assert.equal(outsideStartPreview.payload.error.code, "NOT_TEAM_MEMBER");
  const outsideStartRun = await jsonRequest(firstOrigin, "/api/runs", token, {
    method: "POST",
    body: {
      prompt: "显式目标不在团队时必须拒绝创建",
      execute: false,
      permissionMode: "plan",
      teamId: previewTeam.payload.id,
      startAgentId: "outside-agent",
    },
  });
  assert.equal(outsideStartRun.response.status, 422);
  assert.equal(outsideStartRun.payload.error.code, "NOT_TEAM_MEMBER");
  const outsideTeamProvider = await jsonRequest(firstOrigin, "/api/router/preview", token, {
    method: "POST",
    body: {
      prompt: "团队外逻辑成员不得借共享 runtime 进入预览",
      taskType: "coding",
      teamId: "team-514cc",
      requestedProvider: memberId,
    },
  });
  assert.equal(outsideTeamProvider.response.status, 422);
  assert.equal(outsideTeamProvider.payload.error.code, "PROVIDER_NOT_FOUND");
  const previewTeamRemoved = await jsonRequest(
    firstOrigin,
    `/api/teams/${encodeURIComponent(previewTeam.payload.id)}`,
    token,
    { method: "DELETE" },
  );
  assert.equal(previewTeamRemoved.response.status, 200);

  const teamsBeforeEphemeralRun = await jsonRequest(firstOrigin, "/api/teams", token);
  const ephemeralRun = await jsonRequest(firstOrigin, "/api/runs", token, {
    method: "POST",
    body: {
      prompt: "验证完整通讯录群聊只固化运行快照",
      execute: false,
      permissionMode: "plan",
      orchestrationMode: "social",
      maxRounds: 5,
      maxBudgetUsdPerTurn: 0.10,
      startAgentId: "codex-technical",
      requestedProvider: "codex-technical",
      requestedAgentIds: [ephemeralOnlyMemberId],
      ephemeralTeam: {
        name: "通讯录临时群聊",
        description: "不进入 TeamStore",
        coordinator: "codex-technical",
        members: ["codex-technical", ephemeralOnlyMemberId],
        skills: [],
        mcp: [],
        providers: {},
      },
    },
  });
  assert.equal(ephemeralRun.response.status, 202);
  assert.match(ephemeralRun.payload.teamId, /^team-ephemeral-/);
  assert.equal(ephemeralRun.payload.teamEphemeral, true);
  assert.deepEqual(ephemeralRun.payload.teamMembers, ["codex-technical", ephemeralOnlyMemberId]);
  assert.equal(ephemeralRun.payload.teamRoster.length, 2);
  const teamsAfterEphemeralRun = await jsonRequest(firstOrigin, "/api/teams", token);
  assert.deepEqual(
    teamsAfterEphemeralRun.payload.teams.map((team) => team.id),
    teamsBeforeEphemeralRun.payload.teams.map((team) => team.id),
    "ephemeral run teams must never enter TeamStore",
  );
  const unauthorizedEphemeralRun = await fetch(`${firstOrigin}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "unauthorized", ephemeralTeam: { name: "unauthorized", members: ["codex-technical"] } }),
  });
  assert.equal(unauthorizedEphemeralRun.status, 401);
  const conflictingTeamInput = await jsonRequest(firstOrigin, "/api/runs", token, {
    method: "POST",
    body: {
      prompt: "拒绝两种团队来源",
      execute: false,
      permissionMode: "plan",
      teamId: "team-514cc",
      ephemeralTeam: { name: "冲突群聊", coordinator: "codex-technical", members: ["codex-technical"] },
    },
  });
  assert.equal(conflictingTeamInput.response.status, 422);
  assert.equal(conflictingTeamInput.payload.error.code, "VALIDATION_FAILED");
  const unknownEphemeralMember = await jsonRequest(firstOrigin, "/api/runs", token, {
    method: "POST",
    body: {
      prompt: "拒绝未知群聊成员",
      execute: false,
      permissionMode: "plan",
      ephemeralTeam: { name: "未知成员群聊", coordinator: "codex-technical", members: ["codex-technical", "ghost-member"] },
    },
  });
  assert.equal(unknownEphemeralMember.response.status, 422);
  assert.equal(unknownEphemeralMember.payload.error.code, "VALIDATION_FAILED");
  const secretEphemeralTeam = await jsonRequest(firstOrigin, "/api/runs", token, {
    method: "POST",
    body: {
      prompt: "拒绝团队提示词中的凭据",
      execute: false,
      permissionMode: "plan",
      ephemeralTeam: {
        name: "敏感群聊",
        systemPrompt: "api_key=sk-proj-ABCDEFGH12345678",
        coordinator: "codex-technical",
        members: ["codex-technical"],
      },
    },
  });
  assert.equal(secretEphemeralTeam.response.status, 422);
  assert.equal(secretEphemeralTeam.payload.error.code, "VALIDATION_FAILED");
  const removedEphemeralMember = await jsonRequest(
    firstOrigin,
    `/api/team-members/${encodeURIComponent(ephemeralOnlyMemberId)}`,
    token,
    { method: "DELETE" },
  );
  assert.equal(removedEphemeralMember.response.status, 200);
  const reloadedEphemeralRun = await jsonRequest(firstOrigin, `/api/runs/${encodeURIComponent(ephemeralRun.payload.id)}`, token);
  assert.equal(reloadedEphemeralRun.response.status, 200);
  assert.deepEqual(reloadedEphemeralRun.payload.teamMembers, ["codex-technical", ephemeralOnlyMemberId]);
  assert.equal(reloadedEphemeralRun.payload.teamRoster[1].id, ephemeralOnlyMemberId);

  const blockedRebind = await jsonRequest(firstOrigin, `/api/team-members/${encodeURIComponent(memberId)}`, token, {
    method: "PUT",
    body: { runtimeProfileId: "kimi-frontend", capabilities: ["coding"] },
  });
  assert.equal(blockedRebind.response.status, 409);
  assert.equal(blockedRebind.payload.error.code, "MEMBER_IN_USE");
  assert.deepEqual(blockedRebind.payload.error.references, [teamId]);

  const blockedDelete = await jsonRequest(firstOrigin, `/api/team-members/${encodeURIComponent(memberId)}`, token, {
    method: "DELETE",
  });
  assert.equal(blockedDelete.response.status, 409);
  assert.equal(blockedDelete.payload.error.code, "MEMBER_IN_USE");

  assert.deepEqual(await stopTestServer(child, { token }), { graceful: true, fallback: false });
  child = spawnTestServer({ env });
  const secondOrigin = new URL(await waitForUrl(child)).origin;

  const persistedMember = await jsonRequest(secondOrigin, `/api/team-members/${encodeURIComponent(memberId)}`, token);
  assert.equal(persistedMember.response.status, 200);
  assert.equal(persistedMember.payload.label, "架构实现席");
  assert.equal(persistedMember.payload.runtimeProfileId, "codex-technical");
  const persistedBuiltin = await jsonRequest(secondOrigin, "/api/team-members/codex-technical", token);
  assert.equal(persistedBuiltin.response.status, 200);
  assert.equal(persistedBuiltin.payload.label, "烛 · 技术执行");
  const persistedTeams = await jsonRequest(secondOrigin, "/api/teams", token);
  assert.equal(persistedTeams.response.status, 200);
  assert.ok(persistedTeams.payload.teams.some((team) => (
    team.id === teamId
    && team.coordinator === memberId
    && team.members.length === 1
    && team.members[0] === memberId
  )));
  const restartedEphemeralRun = await jsonRequest(secondOrigin, `/api/runs/${encodeURIComponent(ephemeralRun.payload.id)}`, token);
  assert.equal(restartedEphemeralRun.response.status, 200);
  assert.deepEqual(restartedEphemeralRun.payload.teamMembers, ["codex-technical", ephemeralOnlyMemberId]);
  assert.equal(restartedEphemeralRun.payload.teamRoster[1].id, ephemeralOnlyMemberId);

  const removedTeam = await jsonRequest(secondOrigin, `/api/teams/${encodeURIComponent(teamId)}`, token, {
    method: "DELETE",
  });
  assert.equal(removedTeam.response.status, 200);
  const rebound = await jsonRequest(secondOrigin, `/api/team-members/${encodeURIComponent(memberId)}`, token, {
    method: "PUT",
    body: {
      runtimeProfileId: "kimi-frontend",
      capabilities: ["frontend", "ui", "coding"],
    },
  });
  assert.equal(rebound.response.status, 200);
  assert.equal(rebound.payload.runtimeProfileId, "kimi-frontend");
  assert.equal(rebound.payload.provider, "moonshot");
  assert.equal(rebound.payload.defaultModel, null);
  assert.equal(rebound.payload.defaultEffort, null);

  const removedMember = await jsonRequest(secondOrigin, `/api/team-members/${encodeURIComponent(memberId)}`, token, {
    method: "DELETE",
  });
  assert.equal(removedMember.response.status, 200);
  assert.deepEqual(removedMember.payload, { removed: memberId });
  const missing = await jsonRequest(secondOrigin, `/api/team-members/${encodeURIComponent(memberId)}`, token);
  assert.equal(missing.response.status, 404);
  assert.equal(missing.payload.error.code, "SOURCE_NOT_FOUND");
});
