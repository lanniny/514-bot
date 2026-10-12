/**
 * bots-inbox-e2e.test.mjs — 真服务器上的收件箱端到端验证（不是假 ctx 单测）。
 *
 * 为什么必须有这一层：`bots-inbox.test.mjs` 用的是手搓假 ctx，只能证明**投影逻辑**对；
 * 证明不了真实服务里 `ctx.state.conversations.get` / `orchestrator.list()` / `bus.readTail`
 * 这条链路真的通。P-1 开工闸是**静态读码**判定的，本文件把那个判定放到活体上复核。
 *
 * 守三件事：
 *  1. 真 Bot 会话的 run.teamId 确实是 `team-ephemeral-<uuid>`（结构性问题的证据）。
 *  2. `/api/bots/inbox` 能读到这个 run（方案 B 解决了它）。
 *  3. 既有 `/api/teams/<id>/inbox` 对它不可用（方案 B 的存在理由，不是过度设计）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("真服务器：Bot 会话收件箱读得到自己的 run，团队收件箱读不到", { timeout: 120_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-bots-inbox-e2e-"));
  const workspace = resolve(dataRoot, "workspace");
  const token = "bots-inbox-e2e-token";
  await mkdir(workspace, { recursive: true });

  const child = spawnTestServer({
    env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
  });
  t.after(async () => {
    await stopTestServer(child, { token });
    await rm(dataRoot, { recursive: true, force: true });
  });

  const origin = new URL(await waitForUrl(child)).origin;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const api = async (path, { method = "GET", body, allowStatus = [] } = {}) => {
    const response = await fetch(new URL(path, origin), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok && !allowStatus.includes(response.status)) {
      throw new Error(`${method} ${path} → ${response.status}: ${JSON.stringify(payload)}`);
    }
    return { status: response.status, ok: response.ok, payload };
  };

  const catalog = (await api("/api/team-members")).payload?.members ?? [];
  const seat = catalog.find((member) => member.id === "claude-fable") ?? catalog[0];
  assert.ok(seat, "团队目录不能为空——本测试要求真实花名册");
  const peer = catalog.find((member) => member.id !== seat.id);
  assert.ok(peer, "群会话需要第二个成员");

  const project = (await api("/api/projects", {
    method: "POST",
    body: { title: "收件箱 E2E", cwd: workspace },
  })).payload.project;
  const group = (await api("/api/conversations", {
    method: "POST",
    body: {
      kind: "workspace_group",
      title: "收件箱 E2E 协作室",
      projectId: project.projectId,
      roomRole: "task",
      memberIds: [seat.id, peer.id],
    },
  })).payload.conversation;

  const run = (await api("/api/runs", {
    method: "POST",
    body: {
      prompt: "BOTS_INBOX_E2E_MARK",
      execute: false,
      permissionMode: "plan",
      conversationId: group.id,
      conversationKind: "workspace_group",
      orchestrationMode: "social",
      startAgentId: seat.id,
      requestedAgentIds: [peer.id],
      ephemeralTeam: {
        name: "inbox e2e team",
        coordinator: seat.id,
        members: [seat.id, peer.id],
        skills: [], mcp: [], providers: {}, systemPrompt: "",
      },
    },
  })).payload;

  // 让总线里**真的有东西**。`execute:false` 的 run 从不排初始 task 消息（orchestrator 只在
  // execute:true 时排），没有这一步就不会有 bus 文件，readTail 会 ENOENT → source.status
  // 变成 "missing"、diagnostics 退成 partial——而只看 runsTotal/sources[].runId 的断言
  // 在「一条消息都读不出来」时**依然全绿**。那样这条测试就证明不了 readTail 接线是通的。
  // 走 relay/handoff 写一条真消息：不烧 token、不启 CLI，是真实路径。
  await api("/api/bots/relay/handoff", {
    method: "POST",
    body: { runId: run.id, from: seat.id, to: peer.id, stage: "collect", text: "E2E 总线可读性探针" },
  });

  // —— 证据 1：结构性问题真实存在 ——
  // 群会话走 ephemeralTeam，编排器把它物化成独立 id 写进 run.teamId，
  // 这个 id 不落 TeamStore。这正是既有团队收件箱读不到 Bot 会话的根因。
  assert.match(String(run.teamId ?? ""), /^team-ephemeral-/, "Bot 群会话的 run.teamId 必须是临时团队 id");
  const conversations = (await api("/api/conversations")).payload?.conversations ?? [];
  const conversationAfter = conversations.find((item) => String(item?.id) === String(group.id));
  assert.ok(conversationAfter, "会话必须出现在列表里");
  assert.ok(
    (conversationAfter.runIds ?? []).map(String).includes(String(run.id)),
    "run 必须已挂到会话上，否则收件箱按 runIds 裁剪时看不到它",
  );

  // —— 证据 2：方案 B 读得到 ——
  const inbox = (await api(`/api/bots/inbox?conversationId=${encodeURIComponent(group.id)}`)).payload;
  assert.equal(inbox.ok, true);
  assert.equal(inbox.schema, "514cc.bot-inbox/v1");
  assert.equal(inbox.scope, `bot-conversation:${group.id}`);
  assert.equal(inbox.team.synthetic, true, "不得把合成作用域冒充成真实团队");
  assert.equal(inbox.conversation.id, group.id);
  assert.equal(inbox.conversation.runCount, 1);
  assert.equal(inbox.diagnostics.runsTotal, 1, "收件箱必须真的看见这个 run（这正是 P-1 的复核点）");
  assert.deepEqual(inbox.sources.map((source) => source.runId), [run.id], "只投影本会话的 run");
  // —— 证据 2b：总线是真读通的（readTail 接线坏掉时这条必须变红）——
  assert.equal(inbox.sources[0]?.status, "ok", "总线必须真读通；ENOENT/参数错会让这里变 missing/error");
  assert.equal(inbox.diagnostics.status, "ok", "真总线读通时不得退化成 partial/empty");
  assert.deepEqual(inbox.diagnostics.issues, [], "读通时不该有源诊断 issue");

  // —— 证据 3：既有团队收件箱对它不可用（方案 B 不是过度设计）——
  const legacy = await api(`/api/teams/${encodeURIComponent(String(run.teamId))}/inbox`, { allowStatus: [400, 403, 404, 409, 422, 500] });
  assert.equal(legacy.ok, false, "临时团队 id 不在 TeamStore 里，既有团队收件箱必须拒绝而不是返回空板冒充可用");

  // —— 副作用核对：不存在的会话如实 404，不静默降级 ——
  // 2026-09-11：本条最初实测为 400——真 ConversationStore.get 对缺失会话是抛错而非返回 null，
  // 异常穿透到 httpStatusFor 的兜底 400（同一 code 在 server.mjs:1104 本是 404）。
  // 修复 = 路由显式折叠 CONVERSATION_NOT_FOUND + httpStatusFor 对齐 404。本断言即该修复的活体门禁。
  const missing = await api("/api/bots/inbox?conversationId=does-not-exist", { allowStatus: [404] });
  assert.equal(missing.status, 404);
  assert.equal(missing.payload.code, "CONVERSATION_NOT_FOUND");
});
