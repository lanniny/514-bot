import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { BusStore } from "../src/bus.mjs";
import { AutomationStore } from "../src/automations.mjs";
import { registerBotsRoutes, resetBotsServicesForTest } from "../src/bots/routes.mjs";
import { draftPrivateSkillFromRun } from "../public/modules/private-skill-from-run.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

const roster = new Map([
  ["candle", { label: "烛", shortLabel: "烛", role: "代码守夜人", runtimeProfileId: "codex-review", builtin: true }],
  ["weaver", { label: "织", shortLabel: "织", role: "情报编织者", runtimeProfileId: "grok-research", builtin: true }],
  ["smith", { label: "匠", role: "老匠人", runtimeProfileId: "opus-domain", builtin: true }],
]);

function fakeOrchestrator() {
  const runs = new Map();
  return {
    runs,
    async create(input) {
      const run = { id: `run-${runs.size + 1}`, status: "succeeded", input };
      runs.set(run.id, run);
      return run;
    },
    get(id) {
      const run = runs.get(id);
      if (!run) throw Object.assign(new Error("run not found"), { code: "RUN_NOT_FOUND" });
      return run;
    },
  };
}

async function freshSurface(t) {
  const root = await mkdtemp(resolve(appRoot, ".test-bots-routes-"));
  const autoRoot = await mkdtemp(resolve(appRoot, ".test-bots-routes-auto-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(autoRoot, { recursive: true, force: true }),
  ]));
  const automations = await new AutomationStore({
    dataRoot: autoRoot,
    orchestrator: fakeOrchestrator(),
    eventStore: { emit: async () => ({}) },
  }).init();

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
      orchestrator: { bus: new BusStore({ dataRoot: root }) },
      automations,
    },
    json: (response, status, payload) => {
      response.status = status;
      response.payload = payload;
    },
    body: async (request) => request.payload ?? {},
  };
  registerBotsRoutes(router, ctx);

  async function call(method, pathname, payload = undefined) {
    const url = new URL(`http://127.0.0.1${pathname}`);
    const response = { status: null, payload: null };
    for (const route of routes) {
      if (method !== route.method) continue;
      if (!url.pathname.startsWith(route.prefix)) continue;
      if (await route.handler({ payload, on() {} }, response, url)) return response;
    }
    return { status: 404, payload: { ok: false, code: "NOT_FOUND" } };
  }
  return { call, automations, ctx };
}

test.beforeEach(() => resetBotsServicesForTest());
test.after(() => resetBotsServicesForTest());

test("profile CRUD over HTTP with member projection", async (t) => {
  const { call } = await freshSurface(t);
  const put = await call("PUT", "/api/bots/weaver", {
    job: { owns: "每周配置健康巡检", goals: ["漂移发现率 100%"] },
    standingRules: ["来源必须带出处"],
    approvalBoundary: { requireApproval: ["外发"], neverAllowed: ["force push"] },
    skills: ["grok-researcher"],
  });
  assert.equal(put.status, 200);
  assert.equal(put.payload.bot.member.label, "织");
  assert.equal(put.payload.bot.member.role, "情报编织者");

  const get = await call("GET", "/api/bots/weaver");
  assert.equal(get.status, 200);
  assert.equal(get.payload.bot.job.owns, "每周配置健康巡检");

  const list = await call("GET", "/api/bots");
  assert.equal(list.status, 200);
  assert.equal(list.payload.count, 1);
  assert.equal(list.payload.bots[0].memberId, "weaver");

  const missing = await call("GET", "/api/bots/candle");
  assert.equal(missing.status, 404);

  const ghost = await call("PUT", "/api/bots/ghost", { job: { owns: "x" } });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.payload.code, "MEMBER_NOT_FOUND");

  const removed = await call("DELETE", "/api/bots/weaver");
  assert.equal(removed.status, 200);
  assert.equal((await call("GET", "/api/bots/weaver")).status, 404);
});

test("protocol summary endpoint reports live store state", async (t) => {
  const { call } = await freshSurface(t);
  const summary = await call("GET", "/api/bots/protocol");
  assert.equal(summary.status, 200);
  assert.equal(summary.payload.schema, "514cc.bot-collab-protocol/v1");
  assert.equal(summary.payload.layers.length, 4);
  assert.equal(summary.payload.live.profilesStore, "ready");
});

test("relay kickoff / handoff / ack / board over HTTP", async (t) => {
  const { call } = await freshSurface(t);
  const runId = randomUUID();

  const kickoff = await call("POST", "/api/bots/relay/kickoff", {
    runId,
    text: "复核治理账本。\n@weaver 收集数据。\n@candle 核对账本。",
  });
  assert.equal(kickoff.status, 201);
  assert.equal(kickoff.payload.dispatched.length, 2);
  assert.deepEqual(kickoff.payload.dispatched.map((item) => item.to), ["weaver", "candle"]);

  const duplicate = await call("POST", "/api/bots/relay/kickoff", {
    runId,
    text: "@weaver 甲\n@weaver 乙",
  });
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.payload.code, "RELAY_DUPLICATE_OWNER");

  const handoff = await call("POST", "/api/bots/relay/handoff", {
    runId, from: "weaver", to: "@smith", stage: "triage", text: "请复核 diff",
  });
  assert.equal(handoff.status, 201);
  const handoffId = (await call("GET", `/api/bots/relay/${runId}`)).payload.openHandoffs
    .find((item) => item.to === "smith").handoffId;

  const forbidden = await call("POST", "/api/bots/relay/ack", { runId, from: "weaver", handoffId });
  assert.equal(forbidden.status, 400);
  assert.equal(forbidden.payload.code, "RELAY_ACK_FORBIDDEN");

  const acked = await call("POST", "/api/bots/relay/ack", { runId, from: "smith", handoffId });
  assert.equal(acked.status, 200);
  assert.equal(acked.payload.state, "acknowledged");

  const board = await call("GET", `/api/bots/relay/${runId}`);
  assert.equal(board.payload.openHandoffs.length, 2); // kickoff 的两条仍开放
  assert.equal(board.payload.acknowledgedHandoffs.length, 1);
});

test("routine lifecycle over HTTP including automation bridge", async (t) => {
  const { call, automations } = await freshSurface(t);
  const created = await call("POST", "/api/bots/routines", {
    owningMemberId: "weaver",
    title: "每周账号健康巡检",
    instructions: "汇总三块账本",
    schedule: "every:1d",
    expectedOutput: "链接化观察清单",
    approvalBoundary: "不外发；产出仅回帖",
    noDataPolicy: "report-failure",
  });
  assert.equal(created.status, 201);
  const routineId = created.payload.routine.id;
  assert.equal(created.payload.routine.enabled, false);

  const invalid = await call("POST", "/api/bots/routines", { owningMemberId: "weaver", title: "x" });
  assert.equal(invalid.status, 400);

  const tested = await call("POST", `/api/bots/routines/${routineId}/test`);
  assert.equal(tested.status, 200);
  assert.equal(tested.payload.plan.mode, "plan-only");

  const enabled = await call("POST", `/api/bots/routines/${routineId}/enable`);
  assert.equal(enabled.status, 200);
  assert.ok(enabled.payload.automationRef);
  const bridged = automations.get(enabled.payload.automationRef);
  assert.equal(bridged.enabled, true);
  assert.equal(bridged.name, "[routine] 每周账号健康巡检");
  assert.equal(bridged.schedule, "every:1d");
  assert.deepEqual(bridged.requestedAgentIds, ["weaver"]);

  // enable→pause→enable 幂等：不产生第二条 automation
  const paused = await call("POST", `/api/bots/routines/${routineId}/pause`);
  assert.equal(paused.status, 200);
  assert.equal(automations.get(enabled.payload.automationRef).enabled, false);
  const reEnabled = await call("POST", `/api/bots/routines/${routineId}/enable`);
  assert.equal(reEnabled.payload.automationRef, enabled.payload.automationRef);

  // PUT 同步 automation（不留两张皮）
  const renamed = await call("PUT", `/api/bots/routines/${routineId}`, { title: "每周账本巡检" });
  assert.equal(renamed.status, 200);
  assert.equal(automations.get(enabled.payload.automationRef).name, "[routine] 每周账本巡检");

  // DELETE 先删 automation 再删 routine（fail-closed 联动）
  const deleted = await call("DELETE", `/api/bots/routines/${routineId}`);
  assert.equal(deleted.status, 200);
  assert.throws(() => automations.get(enabled.payload.automationRef), { code: "AUTOMATION_NOT_FOUND" });
  assert.equal((await call("GET", `/api/bots/routines/${routineId}`)).status, 404);

  const list = await call("GET", "/api/bots/routines?owning=weaver");
  assert.equal(list.payload.count, 0);
});

test("sub-paths do not fall through to the member handler", async (t) => {
  const { call } = await freshSurface(t);
  // /api/bots/relay/... 与 /api/bots/routines 不被 memberId 处理器吞掉
  assert.equal((await call("GET", "/api/bots/relay/not-a-uuid")).status, 400); // assertRunId 拒绝而非 404 PROFILE
  assert.equal((await call("GET", "/api/bots/routines")).status, 200);
  assert.equal((await call("GET", "/api/bots/protocol")).status, 200);
});

// ---- W1（Grok 对标）：LO 私有技能 CRUD 落盘 ----
test("private skills CRUD round-trips through the API surface and persists to disk", async (t) => {
  const { call, ctx } = await freshSurface(t);
  const root = ctx.state.dataRoot;
  const created = await call("POST", "/api/bots/private-skills", {
    name: "Inbox triage", description: "Summarize and label incoming mail",
    instructions: "Read new messages, summarize them, and suggest a label.",
  });
  assert.equal(created.status, 201);
  const id = created.payload.skill.id;
  assert.match(id, /^[A-Za-z0-9-]+$/);

  const list = await call("GET", "/api/bots/private-skills");
  assert.equal(list.status, 200);
  assert.equal(list.payload.count, 1);
  assert.equal(list.payload.skills[0].name, "Inbox triage");

  const updated = await call("PUT", `/api/bots/private-skills/${id}`, { description: "Triage and label mail, twice daily" });
  assert.equal(updated.status, 200);
  assert.equal(updated.payload.skill.description, "Triage and label mail, twice daily");
  // 未提供字段保留（partial patch 语义：create 校验必填，update 合并既有）
  assert.equal(updated.payload.skill.name, "Inbox triage");

  const removed = await call("DELETE", `/api/bots/private-skills/${id}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.payload.removed, id);
  const after = await call("GET", "/api/bots/private-skills");
  assert.equal(after.payload.count, 0);

  // 落盘核验：文件存在且 schema 正确
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const disk = JSON.parse(await readFile(join(root, "bot-private-skills.json"), "utf8"));
  assert.equal(disk.schema, "514cc.bot-private-skills/v1");
  assert.equal(disk.items.length, 0);
});

test("a succeeded-run draft persists through the existing private-skills API", async (t) => {
  const { call } = await freshSurface(t);
  const draft = draftPrivateSkillFromRun({
    id: "run-from-settlement",
    status: "succeeded",
    title: "Weekly ledger sweep",
    prompt: "Summarize route-gate / DELTA / handoff drift",
    result: { final: "Three open drifts; no secrets in the summary." },
  });
  assert.ok(draft?.ready);
  const created = await call("POST", "/api/bots/private-skills", {
    name: draft.name,
    description: draft.description,
    instructions: draft.instructions,
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.skill.name, draft.name);
  assert.match(created.payload.skill.instructions, /Source run: run-from-settlement/);
  const list = await call("GET", "/api/bots/private-skills");
  assert.equal(list.payload.count, 1);
  assert.equal(list.payload.skills[0].id, created.payload.skill.id);
});

test("private skills fail closed on unknown id, secrets, and missing fields", async (t) => {
  const { call } = await freshSurface(t);
  const missing = await call("PUT", "/api/bots/private-skills/nope", { name: "x", description: "y", instructions: "z" });
  assert.equal(missing.status, 404);
  assert.equal(missing.payload.code, "PRIVATE_SKILL_NOT_FOUND");

  const secret = await call("POST", "/api/bots/private-skills", {
    name: "leak", description: "sk", instructions: "api key sk-ant-1234567890abcdefghijklmnop use it",
  });
  assert.equal(secret.status, 400);
  assert.equal(secret.payload.code, "SENSITIVE_PROMPT");

  const blank = await call("POST", "/api/bots/private-skills", { name: "", description: "", instructions: "" });
  assert.equal(blank.status, 400);
});

test("private skills routes do not shadow bot profiles and vice versa", async (t) => {
  const { call } = await freshSurface(t);
  // 建 profile 后，私有技能端点不受影响（前缀注册序）
  const profile = await call("PUT", "/api/bots/candle", { handle: "@candle", job: { owns: "守夜" } });
  assert.equal(profile.status, 200);
  const skills = await call("GET", "/api/bots/private-skills");
  assert.equal(skills.status, 200);
  assert.equal(skills.payload.count, 0);
  // 私有技能子路径不被 profile 单条处理器吞掉
  const del = await call("DELETE", "/api/bots/private-skills/ghost");
  assert.equal(del.status, 404);
  assert.equal(del.payload.code, "PRIVATE_SKILL_NOT_FOUND");
});

// ---- W3（Grok 对标）：automation.triggered → routine runHistory 回填 ----
test("automation.triggered events backfill routine runHistory via the event subscription", async (t) => {
  const { call, ctx } = await freshSurface(t);
  // 触发一次任意 /api/bots 请求让 ensureServices 建立订阅（惰性初始化）
  await call("GET", "/api/bots");
  const created = await call("POST", "/api/bots/routines", {
    owningMemberId: "candle", title: "每周巡检", instructions: "汇总账本",
    schedule: "manual", expectedOutput: "清单", approvalBoundary: "不外发", noDataPolicy: "report-failure",
  });
  const routineId = created.payload.routine.id;
  const enabled = await call("POST", `/api/bots/routines/${routineId}/enable`);
  assert.ok(enabled.payload.routine.automationRef, "enable 必须桥接 automation");

  // 模拟调度器触发事件：订阅按 automationRef 反查并追加历史
  const listeners = [];
  ctx.state.eventStore = { subscribe: (listener) => { listeners.push(listener); return () => {}; } };
  // 重新初始化服务让新订阅挂上
  resetBotsServicesForTest();
  await call("GET", "/api/bots");
  assert.ok(listeners.length >= 1, "initServices 必须挂事件订阅");

  const automationRef = enabled.payload.routine.automationRef;
  for (const listener of listeners) {
    listener({ type: "automation.triggered", data: { id: automationRef, runId: "run-trig-1", source: "schedule" } });
  }
  await new Promise((resolve) => setTimeout(resolve, 150));

  const detail = await call("GET", `/api/bots/routines/${routineId}`);
  const history = detail.payload.routine.runHistory || [];
  assert.equal(history.length, 1, "triggered 事件必须回填 runHistory");
  assert.equal(history[0].runId, "run-trig-1");
  assert.equal(history[0].status, "triggered");
  // subscriber 绝不外抛：喂垃圾事件不炸
  for (const listener of listeners) {
    listener(null);
    listener({ type: "automation.triggered", data: null });
    listener({ type: "automation.triggered", data: { id: 42 } });
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
});
