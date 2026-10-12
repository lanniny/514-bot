import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("assistant A5 controllable memory, workflow distillation, and session residence HTTP endpoints", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-a5-http-"));
  const repoRoot = resolve(root, "repo");
  const dataRoot = resolve(root, "data");
  const fakeHome = resolve(root, "home");
  await mkdir(resolve(repoRoot, "config/control-center"), { recursive: true });
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

  const token = "a5-token-0123456789abcdef";
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

  // ==========================================
  // 1. Assistant Memory API
  // ==========================================
  // 1.1 List initial memories
  const listInitRes = await request("/api/assistant/memories");
  assert.equal(listInitRes.status, 200);
  const listInitData = await listInitRes.json();
  assert.equal(listInitData.schema, "514cc.assistant-memory/v1");
  assert.deepEqual(listInitData.items, []);

  // 1.2 Create first memory item (preference)
  const create1Res = await request("/api/assistant/memories", {
    method: "POST",
    body: JSON.stringify({
      category: "preference",
      title: "代码回答简洁优先",
      content: "直接输出代码变更与测试，避免套话",
      pinned: true,
    }),
  });
  assert.equal(create1Res.status, 201);
  const create1Data = await create1Res.json();
  assert.equal(create1Data.schema, "514cc.assistant-memory/v1");
  const mem1 = create1Data.item;
  assert.equal(mem1.title, "代码回答简洁优先");
  assert.equal(mem1.pinned, true);

  // 1.3 Create second memory item (project_rule)
  const create2Res = await request("/api/assistant/memories", {
    method: "POST",
    body: JSON.stringify({
      category: "project_rule",
      title: "Windows CRLF 换行规范",
      content: "修改代码时保持文件原本的 CRLF 行尾",
      pinned: false,
    }),
  });
  assert.equal(create2Res.status, 201);
  const mem2 = (await create2Res.json()).item;

  // 1.4 List with filter
  const listPinnedRes = await request("/api/assistant/memories?pinned=true");
  assert.equal(listPinnedRes.status, 200);
  const listPinnedData = await listPinnedRes.json();
  assert.equal(listPinnedData.items.length, 1);
  assert.equal(listPinnedData.items[0].id, mem1.id);

  // 1.5 Get single memory
  const getMemRes = await request(`/api/assistant/memories/${mem1.id}`);
  assert.equal(getMemRes.status, 200);
  assert.equal((await getMemRes.json()).item.title, "代码回答简洁优先");

  // 1.6 Update memory
  const patchMemRes = await request(`/api/assistant/memories/${mem1.id}`, {
    method: "PATCH",
    body: JSON.stringify({ content: "直接输出代码变更与测试，并保留出处", pinned: false }),
  });
  assert.equal(patchMemRes.status, 200);
  assert.equal((await patchMemRes.json()).item.content, "直接输出代码变更与测试，并保留出处");

  // 1.7 Get Prompt Chunk
  const promptChunkRes = await request("/api/assistant/memories/prompt-chunk");
  assert.equal(promptChunkRes.status, 200);
  const promptChunkData = await promptChunkRes.json();
  assert.equal(promptChunkData.schema, "514cc.assistant-memory-prompt/v1");
  assert.ok(promptChunkData.promptChunk.includes("[长期记忆与用户已知设定]"));
  assert.ok(promptChunkData.promptChunk.includes("Windows CRLF 换行规范"));

  // 1.8 Delete memory
  const delMemRes = await request(`/api/assistant/memories/${mem2.id}`, { method: "DELETE" });
  assert.equal(delMemRes.status, 200);
  assert.equal((await delMemRes.json()).success, true);
  const listAfterDel = await (await request("/api/assistant/memories")).json();
  assert.equal(listAfterDel.items.length, 1);

  // ==========================================
  // 2. Workflow Distillation API
  // ==========================================
  // 2.1 Create a conversation and run to distill from
  const convRes = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ kind: "direct", title: "工作流提炼测试对话", directMemberId: "grok-build" }),
  });
  assert.equal(convRes.status, 201);
  const conv = (await convRes.json()).conversation;

  const runRes = await request("/api/runs", {
    method: "POST",
    body: JSON.stringify({
      prompt: "全自动化构建与验证流程",
      execute: false,
      permissionMode: "plan",
      conversationId: conv.id,
      conversationKind: "direct",
    }),
  });
  assert.equal(runRes.status, 202);
  const run = await runRes.json();

  // Record a checkpoint on the run
  await request(`/api/runs/${run.id}/checkpoints`, {
    method: "POST",
    body: JSON.stringify({
      phase: "execute",
      label: "核心构建",
      status: "completed",
      findings: [{ text: "构建产物有效", category: "fact" }],
    }),
  });

  // 2.2 Distill workflow from Run
  const distillRunRes = await request(`/api/runs/${run.id}/distill-workflow`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(distillRunRes.status, 200);
  const distillRunData = await distillRunRes.json();
  assert.equal(distillRunData.schema, "514cc.workflow-distiller/v1");
  assert.ok(distillRunData.draft);
  assert.equal(distillRunData.draft.schema, "514cc.bot-routines/v1");
  assert.ok(distillRunData.draft.instructions.includes("核心构建"));

  // 2.3 Distill workflow from Conversation
  const distillConvRes = await request(`/api/conversations/${conv.id}/distill-workflow`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(distillConvRes.status, 200);
  const distillConvData = await distillConvRes.json();
  assert.equal(distillConvData.schema, "514cc.workflow-distiller/v1");
  assert.ok(distillConvData.draft);
  assert.equal(distillConvData.draft.inputSource.conversationId, conv.id);

  // ==========================================
  // 3. Session Residence & Recovery API
  // ==========================================
  // 3.1 Initial residence state
  const residenceInitRes = await request("/api/assistant/residence");
  assert.equal(residenceInitRes.status, 200);
  const residenceInitData = await residenceInitRes.json();
  assert.equal(residenceInitData.schema, "514cc.session-residence/v1");

  // 3.2 Send heartbeat to set active conversation
  const heartbeatRes = await request("/api/assistant/residence/heartbeat", {
    method: "POST",
    body: JSON.stringify({
      conversationId: conv.id,
      residenceMode: "resident",
    }),
  });
  assert.equal(heartbeatRes.status, 200);
  const heartbeatData = await heartbeatRes.json();
  assert.equal(heartbeatData.activeConversationId, conv.id);
  assert.equal(heartbeatData.residenceMode, "resident");
  assert.ok(heartbeatData.lastHeartbeat);

  // 3.3 Verify updated residence
  const residenceAfterHeartbeat = await (await request("/api/assistant/residence")).json();
  assert.equal(residenceAfterHeartbeat.activeConversationId, conv.id);
  assert.equal(residenceAfterHeartbeat.residenceMode, "resident");
});
