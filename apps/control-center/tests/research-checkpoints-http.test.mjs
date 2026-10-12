import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("research checkpoints and evidence matrix HTTP endpoints work end-to-end", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-checkpoints-http-"));
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

  const token = "chk-token-0123456789abcdef";
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

  // 1. 创建会话
  const convRes = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ kind: "direct", title: "研究对话", directMemberId: "grok-build" }),
  });
  assert.equal(convRes.status, 201);
  const conv = (await convRes.json()).conversation;

  // 2. 获取空检查点
  const emptyCheckpointsRes = await request(`/api/conversations/${conv.id}/checkpoints`);
  assert.equal(emptyCheckpointsRes.status, 200);
  const emptyCheckpoints = await emptyCheckpointsRes.json();
  assert.equal(emptyCheckpoints.schema, "514cc.research-checkpoints/v1");
  assert.deepEqual(emptyCheckpoints.checkpoints, []);

  // 3. 记录新检查点
  const postCheckpointRes = await request(`/api/conversations/${conv.id}/checkpoints`, {
    method: "POST",
    body: JSON.stringify({
      phase: "analyze",
      progress: 55,
      status: "in_progress",
      findings: [
        { text: "文件切片解析正常", category: "fact" },
      ],
      budget: {
        turnsUsed: 2,
        tokensUsed: 800,
        costUsd: 0.02,
      },
    }),
  });
  assert.equal(postCheckpointRes.status, 201);
  const postCheckpointData = await postCheckpointRes.json();
  assert.equal(postCheckpointData.schema, "514cc.research-checkpoint/v1");
  assert.equal(postCheckpointData.checkpoint.phase, "analyze");
  assert.equal(postCheckpointData.checkpoint.phaseLabel, "分析定位");
  assert.equal(postCheckpointData.checkpoint.progress, 55);
  assert.equal(postCheckpointData.checkpoint.findings.length, 1);

  // 4. 再次获取会话检查点
  const getCheckpointsRes = await request(`/api/conversations/${conv.id}/checkpoints`);
  assert.equal(getCheckpointsRes.status, 200);
  const getCheckpointsData = await getCheckpointsRes.json();
  assert.equal(getCheckpointsData.checkpoints.length, 1);

  // 5. 获取会话证据矩阵
  const matrixRes = await request(`/api/conversations/${conv.id}/evidence-matrix`);
  assert.equal(matrixRes.status, 200);
  const matrixData = await matrixRes.json();
  assert.equal(matrixData.schema, "514cc.evidence-matrix/v1");
  assert.equal(matrixData.conversationId, conv.id);

  // 6. 获取会话证据矩阵 Markdown 格式
  const matrixMdRes = await request(`/api/conversations/${conv.id}/evidence-matrix?format=markdown`);
  assert.equal(matrixMdRes.status, 200);
  const matrixMdData = await matrixMdRes.json();
  assert.equal(matrixMdData.format, "markdown");
  assert.ok(typeof matrixMdData.markdown === "string");

  // 7. 不存在的会话返回 404
  const notFoundRes = await request("/api/conversations/non-existent-conv/checkpoints");
  assert.equal(notFoundRes.status, 404);

  // 8. 创建 Run 并在 Run 级别记录检查点与获取证据表
  const runRes = await request("/api/runs", {
    method: "POST",
    body: JSON.stringify({
      prompt: "执行研究任务并生成证据",
      execute: false,
      permissionMode: "plan",
      conversationId: conv.id,
      conversationKind: "direct",
      orchestrationMode: "pipeline",
      startAgentId: "grok-build",
      requestedProvider: "grok-build",
      maxRounds: 1,
    }),
  });
  assert.equal(runRes.status, 202);
  const run = await runRes.json();

  const runCheckpointPostRes = await request(`/api/runs/${run.id}/checkpoints`, {
    method: "POST",
    body: JSON.stringify({
      phase: "execute",
      progress: 80,
      status: "in_progress",
      findings: [
        { text: "测试用例编写完成", category: "fact" },
      ],
    }),
  });
  assert.equal(runCheckpointPostRes.status, 201);
  const runCheckpointData = await runCheckpointPostRes.json();
  assert.equal(runCheckpointData.checkpoint.runId, run.id);
  assert.equal(runCheckpointData.checkpoint.phase, "execute");

  const runCheckpointsGetRes = await request(`/api/runs/${run.id}/checkpoints`);
  assert.equal(runCheckpointsGetRes.status, 200);
  const runCheckpointsList = await runCheckpointsGetRes.json();
  assert.equal(runCheckpointsList.checkpoints.length, 1);

  // 9. 获取 Run 证据矩阵与统一交付物
  const runMatrixRes = await request(`/api/runs/${run.id}/evidence-matrix`);
  assert.equal(runMatrixRes.status, 200);
  const runMatrixData = await runMatrixRes.json();
  assert.equal(runMatrixData.schema, "514cc.evidence-matrix/v1");
  assert.equal(runMatrixData.runId, run.id);

  const runDeliverableRes = await request(`/api/runs/${run.id}/deliverable`);
  assert.equal(runDeliverableRes.status, 200);
  const runDeliverableData = await runDeliverableRes.json();
  assert.equal(runDeliverableData.schema, "514cc.unified-deliverable/v1");
  assert.equal(runDeliverableData.runId, run.id);
  assert.equal(runDeliverableData.checkpoints.total, 1);

  // 10. 检查结算接口中的扩展成果物
  const settlementRes = await request(`/api/runs/${run.id}/settlement?diff=0`);
  assert.equal(settlementRes.status, 200);
  const settlementData = await settlementRes.json();
  assert.equal(settlementData.schema, "514cc.run-settlement/v1");
  assert.ok(settlementData.checkpoints);
  assert.equal(settlementData.checkpoints.total, 1);
  assert.ok(settlementData.evidenceMatrix);
  assert.ok(settlementData.deliverable);
});
