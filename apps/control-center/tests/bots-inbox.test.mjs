/**
 * bots-inbox.test.mjs — Bot 面协作收件箱（方案 B）的契约与隔离测试。
 *
 * 守三件事：
 *  1. 投影复用：载荷形状/诊断/限额与 collaboration-inbox 同源，不自造第二实现。
 *  2. 作用域隔离：只包含本会话的 run —— 这既是方案 B 的存在理由，
 *     也是既有 /api/teams/<id>/inbox 做不到的那一步（Bot 会话 run.teamId 是 team-ephemeral-<uuid>）。
 *  3. 路由不被吞：/api/bots/inbox 必须注册在泛型 /api/bots/<memberId> 之前，
 *     否则会被当成 memberId="inbox" 返回 PROFILE_NOT_FOUND。
 *
 * 注意：BusStore 的 assertRunId 只接受服务端 UUID（src/bus.mjs:14），runId 必须用 randomUUID。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { BusStore } from "../src/bus.mjs";
import { INBOX_LIMITS } from "../src/collaboration-inbox.mjs";
import { registerBotsRoutes, resetBotsServicesForTest } from "../src/bots/routes.mjs";
import {
  BOT_INBOX_SCHEMA,
  BOT_INBOX_SCOPE_PREFIX,
  botInboxScopeId,
  conversationRunIds,
  collectBotConversationInbox,
} from "../src/bots/inbox.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

const roster = new Map([
  ["weaver", { label: "织", shortLabel: "织", role: "情报编织者", runtimeProfileId: "grok-research", builtin: true }],
]);

/** 假 orchestrator：list/get/bus 三件套齐全，run 可被 inbox 投影消费。 */
function fakeOrchestrator(bus, runs) {
  return {
    list: () => [...runs.values()],
    get: (id) => {
      const run = runs.get(id);
      if (!run) throw Object.assign(new Error("run not found"), { code: "RUN_NOT_FOUND" });
      return run;
    },
    bus,
  };
}

async function freshSurface(t) {
  const root = await mkdtemp(resolve(appRoot, ".test-bots-inbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const bus = new BusStore({ dataRoot: root });
  const runs = new Map();
  const conversations = new Map();

  const routes = [];
  const router = {
    use(method, prefix, handler) { routes.push({ method, prefix, handler }); },
    get(prefix, handler) { this.use("GET", prefix, handler); },
    post(prefix, handler) { this.use("POST", prefix, handler); },
    put(prefix, handler) { this.use("PUT", prefix, handler); },
    delete(prefix, handler) { this.use("DELETE", prefix, handler); },
  };
  const ctx = {
    state: {
      dataRoot: root,
      teamMembers: { get: (id) => roster.get(id) ?? null },
      orchestrator: fakeOrchestrator(bus, runs),
      // 与真 store 同语义：ConversationStore.get 对不存在的会话**抛错**而非返回 null
      // （src/conversations.mjs:313）。早年这里返回 null 是「假货比真货宽容」——
      // 正因为宽容，才让路由缺失会话时穿透成 400 的缺陷逃过单测（2026-09-11 E2E 才照出来）。
      conversations: {
        get: (id) => {
          const found = conversations.get(id);
          if (!found) throw Object.assign(new Error("conversation not found"), { code: "CONVERSATION_NOT_FOUND" });
          return found;
        },
      },
      inboxLifecycle: { snapshot: async () => ({}) },
    },
    json: (response, status, payload) => {
      response.status = status;
      response.payload = payload;
    },
    body: async (request) => request.payload ?? {},
  };
  registerBotsRoutes(router, ctx);

  async function call(method, pathname) {
    const url = new URL(`http://127.0.0.1${pathname}`);
    const response = { status: null, payload: null };
    for (const route of routes) {
      if (method !== route.method) continue;
      if (!url.pathname.startsWith(route.prefix)) continue;
      if (await route.handler({ payload: undefined, on() {} }, response, url)) return response;
    }
    return { status: 404, payload: { ok: false, code: "NOT_FOUND" } };
  }

  /** 造一个会话 + 若干 run。run 的 teamId 刻意用 ephemeral id，证明作用域不依赖它。 */
  function seedConversation({ title = "巡检协作室", runCount = 1, kind = "workspace_group" } = {}) {
    const conversationId = `conversation-${randomUUID()}`;
    const runIds = [];
    for (let index = 0; index < runCount; index += 1) {
      const runId = randomUUID();
      runIds.push(runId);
      runs.set(runId, {
        id: runId,
        status: "waiting_approval",
        title: `巡检运行 ${index + 1}`,
        conversationId,
        teamId: `team-ephemeral-${randomUUID()}`,
        updatedAt: new Date(Date.now() - index * 1000).toISOString(),
      });
    }
    conversations.set(conversationId, {
      id: conversationId,
      title,
      kind,
      runIds,
      activeRunId: runIds.at(-1) ?? null,
    });
    return { conversationId, runIds };
  }

  /** 真实 bus 读取：与路由里的 readTail 同形，直接透传 bus 自己的 diagnostics。 */
  const readTail = async (runId, options) => bus.readTail(runId, {
    maxBytes: 64 * 1024,
    maxMessages: 64,
    signal: options?.signal,
  });

  const allRuns = () => [...runs.values()];
  const conversationOf = (id) => conversations.get(id) ?? null;

  return { call, seedConversation, bus, runs, conversations, allRuns, conversationOf, readTail, ctx };
}

test.beforeEach(() => resetBotsServicesForTest());
test.after(() => resetBotsServicesForTest());

test("作用域 id 带前缀，可与真实 teamId 一眼区分", () => {
  assert.equal(botInboxScopeId("abc"), `${BOT_INBOX_SCOPE_PREFIX}abc`);
  assert.equal(BOT_INBOX_SCOPE_PREFIX, "bot-conversation:");
  assert.equal(botInboxScopeId("  "), "");
});

test("conversationRunIds 取 runIds 与 activeRunId 的并集", () => {
  assert.deepEqual([...conversationRunIds({ runIds: ["a", "b"], activeRunId: "c" })].sort(), ["a", "b", "c"]);
  assert.deepEqual([...conversationRunIds({})], []);
  assert.deepEqual([...conversationRunIds(null)], []);
});

test("缺少会话或 readTail 时 fail-closed，不返回空载荷冒充成功", async () => {
  await assert.rejects(
    () => collectBotConversationInbox({ conversation: null, readTail: async () => ({}) }),
    (error) => error.code === "VALIDATION_FAILED",
  );
  await assert.rejects(
    () => collectBotConversationInbox({ conversation: { id: "c1" } }),
    (error) => error.code === "VALIDATION_FAILED",
  );
});

test("只投影本会话的 run，并把真实 ephemeral teamId 换成合成 scope", async (t) => {
  const { readTail } = await freshSurface(t);
  const mine = randomUUID();
  const others = randomUUID();
  const stamp = (id, teamId) => ({ id, teamId, status: "waiting_approval", title: `运行 ${id.slice(0, 4)}` });

  const inbox = await collectBotConversationInbox({
    conversation: { id: "c-mine", title: "我的会话", runIds: [mine], activeRunId: mine },
    runs: [stamp(mine, `team-ephemeral-${randomUUID()}`), stamp(others, `team-ephemeral-${randomUUID()}`)],
    readTail,
  });

  assert.equal(inbox.schema, BOT_INBOX_SCHEMA);
  assert.equal(inbox.scope, botInboxScopeId("c-mine"));
  assert.equal(inbox.team.synthetic, true);
  assert.equal(inbox.team.id, botInboxScopeId("c-mine"));
  assert.equal(inbox.conversation.id, "c-mine");
  assert.equal(inbox.conversation.runCount, 1);
  assert.deepEqual(inbox.sources.map((source) => source.runId), [mine], "不得混入其它会话的 run");
});

test("空会话如实报 empty，不伪装成有内容的 ok", async (t) => {
  const { readTail } = await freshSurface(t);
  const inbox = await collectBotConversationInbox({
    conversation: { id: "c-empty", title: "空会话", runIds: [], activeRunId: null },
    runs: [],
    readTail,
  });
  assert.equal(inbox.diagnostics.status, "empty");
  assert.equal(inbox.conversation.runCount, 0);
  assert.deepEqual(inbox.messages, []);
  assert.deepEqual(inbox.pendingAsks, []);
});

test("bus 里的 ask(to=lo) 进入 pendingAsks 并带 run 归属；其它 kind 不进", async (t) => {
  const { bus, seedConversation, allRuns, conversationOf, readTail } = await freshSurface(t);
  const { conversationId, runIds } = seedConversation({ runCount: 1 });
  await bus.append(runIds[0], { from: "weaver", to: "lo", kind: "ask", text: "需要你确认账本范围" });
  await bus.append(runIds[0], { from: "weaver", to: "candle", kind: "say", text: "已开工" });

  const inbox = await collectBotConversationInbox({
    conversation: conversationOf(conversationId),
    runs: allRuns(),
    readTail,
  });

  assert.equal(inbox.pendingAsks.length, 1);
  assert.equal(inbox.pendingAsks[0].text, "需要你确认账本范围");
  assert.equal(inbox.pendingAsks[0].needsOperator, true);
  assert.equal(inbox.pendingAsks[0].runId, runIds[0]);
  // say 不是协作消息 kind，不得混进 messages
  assert.equal(inbox.messages.some((message) => message.text === "已开工"), false);
});

test("消息窗口满时必须升级为 partial 并带专项 issue，不得让旧待办静默消失", async (t) => {
  const { bus, seedConversation, allRuns, conversationOf, readTail } = await freshSurface(t);
  const { conversationId, runIds } = seedConversation({ runCount: 1 });
  for (let index = 0; index < 6; index += 1) {
    await bus.append(runIds[0], { from: "weaver", to: "lo", kind: "ask", text: `待办 ${index}` });
  }
  const inbox = await collectBotConversationInbox({
    conversation: conversationOf(conversationId),
    runs: allRuns(),
    readTail,
    maxMessages: 3,
  });
  assert.equal(inbox.diagnostics.messageCount, 3, "窗口只保留 3 条");
  assert.equal(inbox.diagnostics.status, "partial", "窗口满必须显式降级——报 ok 就是对「待我处理」的假阴性");
  assert.equal(inbox.diagnostics.issues[0]?.code, "INBOX_MESSAGES_TRUNCATED");
  assert.match(inbox.diagnostics.issues[0].message, /更早的待办可能未列出/);
  // 不得谎报具体条数——公开投影拿不到精确的"被切掉多少"
  assert.doesNotMatch(inbox.diagnostics.issues[0].message, /\d+ 条更早的消息未列出/);
});

test("窗口恰好装满也保守报警（已知并接受的轻微假阳性，方向安全）", async (t) => {
  const { bus, seedConversation, allRuns, conversationOf, readTail } = await freshSurface(t);
  const { conversationId, runIds } = seedConversation({ runCount: 1 });
  for (let index = 0; index < 3; index += 1) {
    await bus.append(runIds[0], { from: "weaver", to: "lo", kind: "ask", text: `待办 ${index}` });
  }
  const inbox = await collectBotConversationInbox({
    conversation: conversationOf(conversationId),
    runs: allRuns(),
    readTail,
    maxMessages: 3,
  });
  // 恰好 3 条 / 窗口 3：公开数据（sources 不含 messages，parsedMessages 是 kind 过滤前的原始数）
  // 分辨不出「刚好装满」与「刚被截断」，故按「满即报」处理。
  // 这是刻意的取舍：宁可多提醒一次「可能不全」，也不放过反方向的静默假阴性
  // ——旧 ask 掉出窗口而面板说"没有待办"才是真正会害人的那一侧。
  assert.equal(inbox.diagnostics.messageCount, 3);
  assert.equal(inbox.diagnostics.status, "partial");
  assert.equal(inbox.diagnostics.issues[0]?.code, "INBOX_MESSAGES_TRUNCATED");
});

// —— HTTP 契约 ——

test("GET /api/bots/inbox 缺少 conversationId → 400（不是被泛型处理器吞成 PROFILE_NOT_FOUND）", async (t) => {
  const { call } = await freshSurface(t);
  const response = await call("GET", "/api/bots/inbox");
  assert.equal(response.status, 400);
  assert.equal(response.payload.code, "VALIDATION_FAILED");
  assert.notEqual(response.payload.code, "PROFILE_NOT_FOUND");
});

test("GET /api/bots/inbox 未知会话 → 404 CONVERSATION_NOT_FOUND", async (t) => {
  const { call } = await freshSurface(t);
  // 假 store 与真 store 同语义（抛错），因此本断言守的是「路由显式折叠缺失会话」这条真实路径：
  // 若哪天折叠被删，异常会穿透到 httpStatusFor 的兜底 400，这里必须变红。
  const response = await call("GET", "/api/bots/inbox?conversationId=does-not-exist");
  assert.equal(response.status, 404);
  assert.equal(response.payload.code, "CONVERSATION_NOT_FOUND");
});

test("会话存储抛出的非「不存在」错误必须穿透，不得被折叠成 404 吞掉", async (t) => {
  const { call, ctx } = await freshSurface(t);
  ctx.state.conversations = {
    get: () => { throw Object.assign(new Error("store exploded"), { code: "CONVERSATION_STORE_UNAVAILABLE" }); },
  };
  const response = await call("GET", "/api/bots/inbox?conversationId=whatever");
  assert.equal(response.status, 400, "未知 code 走兜底，但绝不能变成 404");
  assert.equal(response.payload.code, "CONVERSATION_STORE_UNAVAILABLE", "真故障必须原样冒出来");
  assert.match(response.payload.message, /store exploded/);
});

test("GET /api/bots/inbox 正常返回 scope / 会话元数据 / 真实投影", async (t) => {
  const { call, seedConversation, bus } = await freshSurface(t);
  const { conversationId, runIds } = seedConversation({ title: "Grok 对标协作室", runCount: 2 });
  await bus.append(runIds[0], { from: "weaver", to: "lo", kind: "ask", text: "请确认本周巡检范围" });

  const response = await call("GET", `/api/bots/inbox?conversationId=${encodeURIComponent(conversationId)}`);
  assert.equal(response.status, 200);
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.schema, BOT_INBOX_SCHEMA);
  assert.equal(response.payload.scope, botInboxScopeId(conversationId));
  assert.equal(response.payload.conversation.id, conversationId);
  assert.equal(response.payload.conversation.title, "Grok 对标协作室");
  assert.equal(response.payload.conversation.runCount, 2);
  assert.equal(response.payload.team.synthetic, true);
  assert.equal(response.payload.inboxSource, "collaboration-inbox");
  assert.ok(Array.isArray(response.payload.blockedRuns));
  assert.equal(response.payload.diagnostics.runsTotal, 2, "必须保留 collaboration-inbox 的诊断形状");
  assert.equal(response.payload.pendingAsks.length, 1);
});

test("limit 超上限被夹紧而不是抛错", async (t) => {
  const { call, seedConversation } = await freshSurface(t);
  const { conversationId } = await seedConversation({ runCount: 1 });
  const response = await call("GET", `/api/bots/inbox?conversationId=${encodeURIComponent(conversationId)}&limit=99999`);
  assert.equal(response.status, 200);
  assert.ok(response.payload.diagnostics.messageCount <= INBOX_LIMITS.maxMessages);
});

test("原有泛型路由未被破坏：未知 memberId 仍是 PROFILE_NOT_FOUND", async (t) => {
  const { call } = await freshSurface(t);
  const response = await call("GET", "/api/bots/nobody");
  assert.equal(response.status, 404);
  assert.equal(response.payload.code, "PROFILE_NOT_FOUND");
});
