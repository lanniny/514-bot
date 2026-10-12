/**
 * conversations-purge-route.test.mjs — 「清空已删除会话」在**活服务器**上的保留判据。
 *
 * 为什么必须有这一层：`conversations-purge-liveness.test.mjs` 用手搓判据证明了 store 的逻辑，
 * 证明不了 server.mjs 那条路由真的把 `isRunLive` 接对了、`PURGE_TERMINAL_RUN_STATES`
 * 的成员判定符合预期。路由少接一根线，单测照样全绿。
 *
 * 播种的数据形态对齐 LO 2026-10-11 的盘上真相（.ai-shared/control-center/）：
 * 6 条已删除会话，其中 5 条的 activeRunId 指向**不存在的 run 文件**，第 6 条指向一条
 * 10 天前就 recovery_required 的旧 run。旧判据下这 6 条一条都清不掉。
 *
 * 契约（逐分支，覆盖终态集合的两个方向 + 文件缺失 + 仅历史）：
 *   run 文件缺失        → 清掉
 *   run 终态(succeeded) → 清掉
 *   run 终态(cancelled) → 清掉
 *   run 仍活(recovery_required) → 保留
 *   run 仍活(running)          → 保留
 *   只有 runIds、无 activeRunId → 清掉
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONVERSATION_SCHEMA } from "../src/conversations.mjs";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

// 一条已删除的 direct 会话。runIds 必须包含 activeRunId（normalizeRecord 强校验）。
function tombstone(id, title, runIds, activeRunId) {
  return {
    id,
    kind: "direct",
    title,
    projectId: null,
    scope: "global",
    roomRole: "task",
    directMemberId: "codex-technical",
    memberIds: ["codex-technical"],
    runIds,
    activeRunId,
    pinned: false,
    unread: false,
    hiddenAt: "2026-10-01T00:00:00.000Z",
    deletedAt: "2026-10-01T00:00:00.000Z",
    sourceConversationId: null,
    revision: 1,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

test("活服务器：清空已删除会话只保留仍挂着活 run 的墓碑", { timeout: 120_000 }, async (t) => {
  const dataRoot = await mkdtemp(join(appRoot, ".test-purge-route-"));
  const token = "purge-route-token";

  // run 文件：只给「仍活着」和「终态」的各两条，缺失的那两条刻意不建文件
  const runFiles = {
    "run-succeeded": "succeeded",
    "run-cancelled": "cancelled",
    "run-recovery": "recovery_required",
    "run-running": "running",
  };

  const items = [
    tombstone("c-ghost", "run 文件缺失", ["run-ghost"], "run-ghost"),
    tombstone("c-succeeded", "run 已成功", ["run-succeeded"], "run-succeeded"),
    tombstone("c-cancelled", "run 已取消", ["run-cancelled"], "run-cancelled"),
    tombstone("c-recovery", "run 待恢复", ["run-recovery"], "run-recovery"),
    tombstone("c-running", "run 进行中", ["run-running"], "run-running"),
    tombstone("c-history", "只有历史", ["run-old"], null),
  ];

  await writeFile(
    join(dataRoot, "conversations.json"),
    `${JSON.stringify({ schema: CONVERSATION_SCHEMA, revision: 0, items }, null, 2)}\n`,
    "utf8",
  );
  await mkdir(join(dataRoot, "runs"), { recursive: true });
  for (const [runId, status] of Object.entries(runFiles)) {
    await writeFile(
      join(dataRoot, "runs", `${runId}.json`),
      `${JSON.stringify({
        id: runId,
        status,
        createdAt: "2026-10-01T00:00:00.000Z",
        execute: false,
        conversationId: null,
      }, null, 2)}\n`,
      "utf8",
    );
  }

  const child = spawnTestServer({
    env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
  });
  t.after(async () => {
    await stopTestServer(child, { token }).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
  });

  const origin = new URL(await waitForUrl(child)).origin;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  // 墓碑同时带 hiddenAt 与 deletedAt，两个开关都得带上，否则 list() 会先被 hiddenAt 过滤掉
  const listUrl = "/api/conversations?includeDeleted=1&includeHidden=1";
  const before = await (await fetch(new URL(listUrl, origin), { headers })).json();
  const deletedBefore = (before.conversations ?? []).filter((item) => item.deletedAt).map((item) => item.id).sort();
  assert.equal(deletedBefore.length, 6, "播种的 6 条墓碑必须都被加载");

  const response = await fetch(new URL("/api/conversations/deleted", origin), {
    method: "DELETE",
    headers,
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200, `purge 必须成功，实测 HTTP ${response.status}`);
  const payload = await response.json();

  const purgedIds = (payload.conversationIds ?? []).slice().sort();
  assert.deepEqual(purgedIds,
    ["c-cancelled", "c-ghost", "c-history", "c-succeeded"],
    "run 缺失/终态、以及只有历史的墓碑必须被清掉");
  assert.equal(payload.purged, 4);

  const skipped = Object.fromEntries((payload.skipped ?? []).map((item) => [item.conversationId, item]));
  assert.deepEqual(Object.keys(skipped).sort(), ["c-recovery", "c-running"],
    "只有仍挂着活 run 的墓碑该被保留");
  assert.deepEqual(skipped["c-recovery"], { conversationId: "c-recovery", reason: "active-run", runId: "run-recovery" });
  assert.deepEqual(skipped["c-running"], { conversationId: "c-running", reason: "active-run", runId: "run-running" });

  const after = await (await fetch(new URL(listUrl, origin), { headers })).json();
  const remaining = (after.conversations ?? []).map((item) => item.id).sort();
  assert.deepEqual(remaining, ["c-recovery", "c-running"], "盘上必须正好剩下那两条");
  // 保留的墓碑不能被 purge 改动（deletedAt 原样）
  for (const id of ["c-recovery", "c-running"]) {
    const record = (after.conversations ?? []).find((item) => item.id === id);
    assert.ok(record?.deletedAt, `${id} 必须仍是墓碑`);
  }
});
