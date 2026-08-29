import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BusStore, parseDirectives, scrub } from "../src/bus.mjs";
import { Orchestrator } from "../src/orchestrator.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

// ===== bus 基础件 =====

test("parseDirectives splits body and routed messages", () => {
  const { cleaned, directives } = parseDirectives(
    "这是我给全员的结论。\n\n[[msg:codex-technical]] 这段路由你看下\n有没有坑，特别是并发。\n[[msg:lo]] 需要你拍板预算\n[[msg:team]] 广播一条\n\n完毕。",
  );
  assert.equal(cleaned, "这是我给全员的结论。");
  assert.deepEqual(directives, [
    { to: "codex-technical", text: "这段路由你看下\n有没有坑，特别是并发。" },
    { to: "lo", text: "需要你拍板预算" },
    { to: "team", text: "广播一条\n\n完毕。" },
  ]);
  assert.deepEqual(parseDirectives("没有指令的输出").directives, []);
});

test("scrub strips assignment-style secrets before persistence", () => {
  const out = scrub("配置如下 password=hunter2secret，api_key: abcdef123456");
  assert.ok(!out.includes("hunter2secret"));
  assert.ok(!out.includes("abcdef123456"));
});

// 烛 v3.6 致命4：JSON 键值形态与 Authorization: Bearer 短值曾是脱敏盲区
test("scrub covers JSON-quoted keys and short bearer values (candle fatal 4)", () => {
  const jsonForm = scrub('{"token":"shortsecret","note":"ok"}');
  assert.ok(!jsonForm.includes("shortsecret"), jsonForm);
  const bearerForm = scrub("Authorization: Bearer shortsec");
  assert.ok(!bearerForm.includes("shortsec"), bearerForm);
  const colonForm = scrub("password: hunter2");
  assert.ok(!colonForm.includes("hunter2"), colonForm);
});

// 烛 v3.6 致命3：runId 直接拼路径可穿越读 dataRoot 外任意 .jsonl（如 ../events）
test("BusStore rejects non-UUID runIds (path traversal fail-closed)", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-bus-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bus = new BusStore({ dataRoot: root });
  for (const evil of ["../events", "..\\events", "run/../../secrets", "", "run-1"]) {
    assert.throws(() => bus.file(evil), { code: "VALIDATION_FAILED" }, `should reject: ${evil}`);
    await assert.rejects(() => bus.append(evil, { from: "x", text: "y" }), { code: "VALIDATION_FAILED" });
    await assert.rejects(() => bus.read(evil), { code: "VALIDATION_FAILED" });
  }
});

test("BusStore append/read/snapshot honors recipient scoping and budget", async (t) => {
  const { randomUUID } = await import("node:crypto");
  const root = await mkdtemp(resolve(appRoot, ".test-bus-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bus = new BusStore({ dataRoot: root });
  const runId = randomUUID(); // runId 白名单只收服务端 UUID（致命3 修复后非 UUID 直接拒）
  await bus.append(runId, { from: "lo", to: "claude-fable", kind: "task", text: "做一个评审" });
  await bus.append(runId, { from: "claude-fable", to: "codex-technical", kind: "say", text: "你来看看" });
  await bus.append(runId, { from: "codex-technical", to: "claude-fable", kind: "say", text: "password=topsecret99 顺便说" });
  const messages = await bus.read(runId);
  assert.equal(messages.length, 3);
  assert.ok(!messages[2].text.includes("topsecret99")); // 写入即脱敏
  const snapForCodex = bus.snapshot(messages, { forAgent: "codex-technical" });
  assert.ok(snapForCodex.includes("做一个评审")); // task 类全员可见
  assert.ok(snapForCodex.includes("你来看看")); // 发给它的
  assert.ok(snapForCodex.includes("顺便说")); // team 广播链上的问答也在（to: claude-fable 不入选？——decide/task/team 之外按收件过滤）
  const tiny = bus.snapshot(messages, { forAgent: "codex-technical", maxChars: 20 });
  assert.ok(tiny.length <= 30); // 预算裁剪：从旧到新丢
});

test("BusStore stable message ids are idempotent and conflicting reuse fails closed", async (t) => {
  const { randomUUID } = await import("node:crypto");
  const root = await mkdtemp(resolve(appRoot, ".test-bus-idempotency-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bus = new BusStore({ dataRoot: root });
  const runId = randomUUID();
  const message = {
    id: "steer:stable-operation",
    from: "lo",
    to: "codex-technical",
    kind: "steer",
    text: "只追加一次",
    refs: { queuedSteerId: "stable-operation" },
  };

  const first = await bus.append(runId, message);
  const retried = await bus.append(runId, message);
  assert.equal(retried.id, first.id);
  assert.equal((await bus.read(runId)).filter((item) => item.id === message.id).length, 1);
  await assert.rejects(
    () => bus.append(runId, { ...message, text: "冲突内容" }),
    { code: "BUS_MESSAGE_CONFLICT" },
  );
});

// ===== 社会模拟主循环（mock 适配器） =====

function policy() {
  return {
    version: 1,
    modes: { plan: { approvalRequired: false }, build: { approvalRequired: true } },
    limits: { maxRounds: 8, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 10_000 },
  };
}

function route(selectedId = "codex-technical") {
  return {
    taskType: "coding",
    risk: "medium",
    selected: { id: selectedId, label: selectedId },
    independent: { id: "claude-fable", label: "Fable" },
    independentRequired: false,
    reason: "test route",
  };
}

const fakeTeams = {
  get(id) {
    if (id !== "team-514cc") throw Object.assign(new Error("not found"), { code: "SOURCE_NOT_FOUND" });
    return { id: "team-514cc", name: "514cc", coordinator: "claude-fable", members: ["claude-fable", "codex-technical"] };
  },
  brief() {
    return "[团队配置开始] 测试团队 [结束]";
  },
};

async function fixture(replies, { models = null, policyOverride = null, costUsdPerTurn = 0.01 } = {}) {
  const root = await mkdtemp(resolve(appRoot, ".test-social-"));
  const calls = [];
  const adapter = (id) => ({
    cwd: root,
    supportsPerTurnCwd: true, // mock 等价 spawn 型：cwd 参数真实生效（worktree fail-closed 门槛）
    async send(input) {
      calls.push({ id, prompt: input.prompt, model: input.model, effort: input.effort, cwd: input.cwd, permissionMode: input.permissionMode });
      await input.onSessionStarted?.({ sessionId: `${id}-session` });
      const index = calls.filter((call) => call.id === id).length;
      const reply = replies[id]?.[Math.min(index - 1, (replies[id]?.length ?? 1) - 1)] ?? `${id} 的静默答复`;
      return { sessionId: `${id}-session`, text: reply, protocol: `${id}-mock`, tokens: 100, costUsd: costUsdPerTurn };
    },
    async close() {},
  });
  const adapters = new Map([
    ["claude-fable", adapter("claude-fable")],
    ["codex-technical", adapter("codex-technical")],
  ]);
  const events = [];
  const orchestrator = await new Orchestrator({
    router: { preview: async ({ requestedProvider } = {}) => route(requestedProvider || "codex-technical") },
    adapters,
    eventStore: { emit: async (type, data) => { events.push({ type, data }); } },
    dataRoot: root,
    policy: { ...policy(), ...(policyOverride ? { limits: { ...policy().limits, ...policyOverride } } : {}) },
    approvalBroker: { request: async () => ({ decision: "accept" }), denyRun() {} },
    teams: fakeTeams,
    models,
    capabilities: { agentDisabledSkills: async () => new Set() },
  }).init();
  return { root, calls, orchestrator, events };
}

async function restartFixtureOrchestrator({ root, orchestrator }) {
  return new Orchestrator({
    router: orchestrator.router,
    adapters: orchestrator.adapters,
    eventStore: orchestrator.eventStore,
    dataRoot: root,
    policy: orchestrator.policy,
    approvalBroker: orchestrator.approvalBroker,
    teams: orchestrator.teams,
    models: orchestrator.models,
    modelDiscovery: orchestrator.modelDiscovery,
    capabilities: orchestrator.capabilities,
  }).init();
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function deferFirstTurn({ orchestrator, calls }, agentId, text) {
  const adapter = orchestrator.adapters.get(agentId);
  const send = adapter.send.bind(adapter);
  let releaseTurn;
  let markStarted;
  let deferred = true;
  const started = new Promise((resolveStarted) => { markStarted = resolveStarted; });
  const released = new Promise((resolveReleased) => { releaseTurn = resolveReleased; });
  adapter.send = async (input) => {
    if (!deferred) return send(input);
    deferred = false;
    calls.push({ id: agentId, prompt: input.prompt, model: input.model, effort: input.effort, cwd: input.cwd, permissionMode: input.permissionMode });
    await input.onSessionStarted?.({ sessionId: `${agentId}-session` });
    markStarted();
    await released;
    return { sessionId: `${agentId}-session`, text, protocol: `${agentId}-mock`, tokens: 100, costUsd: 0.01 };
  };
  return { started, release: releaseTurn };
}

// 15s：全量并行（多测试文件同机竞争）下 5s 窗口偶发不够——mock turn 本身毫秒级，
// 放宽只影响失败用例的报错等待，不拖慢绿色路径
async function waitTerminal(orchestrator, id) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const run = orchestrator.get(id);
    if (["succeeded", "failed", "cancelled"].includes(run.status)) {
      // Terminal status is persisted before the execution coroutine completes its final audit/save.
      // Tests must wait for that ownership boundary before deleting the fixture root.
      const execution = orchestrator.executions.get(id) ?? orchestrator.executions.get(`continue:${id}`);
      if (execution) await Promise.resolve(execution);
      return orchestrator.get(id);
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  // 抖动追凶相位 dump：run did not finish 时必须看到卡在哪一格
  const stuck = orchestrator.get(id);
  throw new Error(`run did not finish | diag=${JSON.stringify({
    status: stuck.status, round: stuck.round, maxRounds: stuck.maxRounds,
    pendingAsk: Boolean(stuck.pendingAsk), pausedForInput: stuck.pausedForInput,
    pendingSteer: (stuck.pendingSteer ?? []).length, resumeQueue: stuck.resumeQueue ?? null,
    controllers: orchestrator.controllers?.size ?? null, executions: [...(orchestrator.executions?.keys() ?? [])],
    attempts: (stuck.turnAttempts ?? []).map((a) => `${a.agentId}:${a.phase}`),
  })}`);
}

async function waitRecoveryOrTerminal(orchestrator, id) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const run = orchestrator.get(id);
    if (run.status === "recovery_required" || ["succeeded", "failed", "cancelled"].includes(run.status)) {
      const execution = orchestrator.executions.get(id) ?? orchestrator.executions.get(`continue:${id}`);
      if (execution) await Promise.resolve(execution);
      return orchestrator.get(id);
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  const stuck = orchestrator.get(id);
  throw new Error(`run did not settle | diag=${JSON.stringify({
    status: stuck.status,
    round: stuck.round,
    resumeClaim: stuck.resumeClaim ?? null,
    resumeQueue: stuck.resumeQueue ?? null,
    controllers: orchestrator.controllers?.size ?? null,
    executions: [...(orchestrator.executions?.keys() ?? [])],
    attempts: (stuck.turnAttempts ?? []).map((attempt) => `${attempt.agentId}:${attempt.phase}`),
  })}`);
}

async function waitPausedForInput(orchestrator, id) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const run = orchestrator.get(id);
    const execution = orchestrator.executions.get(id) ?? orchestrator.executions.get(`continue:${id}`);
    if (run.status === "waiting_agent" && run.pendingAsk?.from && run.pausedForInput && !execution) return run;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  const stuck = orchestrator.get(id);
  throw new Error(`run did not fully park for input | diag=${JSON.stringify({
    status: stuck.status,
    pendingAsk: stuck.pendingAsk ?? null,
    pausedForInput: stuck.pausedForInput,
    executions: [...orchestrator.executions.keys()],
  })}`);
}

async function waitRestartRecoveryOrTerminal(orchestrator, id) {
  // init() schedules restart consumers with setImmediate. Once that callback has
  // run, a recoverable item must either own an execution or be fail-closed.
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  let run = orchestrator.get(id);
  if (run.status === "recovery_required" || ["succeeded", "failed", "cancelled"].includes(run.status)) return run;
  const execution = orchestrator.executions.get(id) ?? orchestrator.executions.get(`continue:${id}`);
  assert.ok(execution, `restart silently parked recoverable work | status=${run.status}`);
  await Promise.resolve(execution);
  run = orchestrator.get(id);
  assert.ok(
    run.status === "recovery_required" || ["succeeded", "failed", "cancelled"].includes(run.status),
    `restart consumer returned without a terminal or recovery decision | status=${run.status}`,
  );
  return run;
}

test("social mode routes [[msg:]] between agents and converges with leader final", async (t) => {
  const { root, calls, orchestrator, events } = await fixture({
    "claude-fable": ["计划如下：先拆成两步。\n[[msg:codex-technical]] 你评估下技术可行性", "收敛后的最终答复"],
    "codex-technical": ["可行性 OK，没有坑。"],
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const run = await orchestrator.create({ prompt: "评审这个方案", execute: true, permissionMode: "plan", teamId: "team-514cc", orchestrationMode: "social" });
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  // 轮序：leader 规划 → 路由到 codex → leader 收敛轮
  assert.deepEqual(calls.map((call) => call.id), ["claude-fable", "codex-technical", "claude-fable"]);
  // codex 的 prompt 里带着 bus 快照（含 leader 的规划），不再靠人肉转述模板
  assert.ok(calls[1].prompt.includes("先拆成两步"));
  // bus.jsonl：task + team 正文 + 路由 say + decide 收敛
  const bus = new BusStore({ dataRoot: root });
  const messages = await bus.read(run.id);
  const kinds = messages.map((message) => message.kind);
  assert.ok(kinds.includes("task") && kinds.includes("say") && kinds.includes("decide"));
  assert.ok(messages.some((message) => message.from === "claude-fable" && message.to === "codex-technical"));
  assert.ok(terminal.busExpectedAt, "social execution must persist a write-ahead bus intent marker");
  assert.ok(terminal.busMaterializedAt, "first durable bus append must leave an audit marker on the run");
  const persisted = JSON.parse(await readFile(resolve(root, "runs", `${run.id}.json`), "utf8"));
  assert.equal(persisted.busExpectedAt, terminal.busExpectedAt);
  assert.equal(persisted.busMaterializedAt, terminal.busMaterializedAt);
  // 运行时 roster：两个 agent 都登记了会话
  const roster = JSON.parse(await readFile(resolve(root, "roster.json"), "utf8"));
  assert.equal(roster.agents["claude-fable"].sessionId, "claude-fable-session");
  assert.equal(roster.agents["codex-technical"].sessionId, "codex-technical-session");
  // 前端可见性：bus.routed 事件已发
  assert.ok(events.some((event) => event.type === "bus.routed"));
  assert.ok(events.some((event) => event.type === "bus.appended"));
});

test("social direct continuation and queued steer remain in the run bus", async (t) => {
  const { root, orchestrator, events } = await fixture({
    "claude-fable": ["初始结论", "排队补充"],
    "codex-technical": ["技术续聊答复"],
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const created = await orchestrator.create({
    prompt: "先完成社会编排",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  await waitTerminal(orchestrator, created.id);
  await orchestrator.continue(created.id, { prompt: "继续核对", agentId: "codex-technical" });

  const run = orchestrator.get(created.id);
  run.pendingSteer = [{ prompt: "补一条排队意见", agentId: "claude-fable", queuedAt: new Date().toISOString() }];
  const steerController = new AbortController();
  orchestrator.controllers.set(created.id, steerController);
  try {
    await orchestrator.injectNextSteer(run);
  } finally {
    if (orchestrator.controllers.get(created.id) === steerController) orchestrator.controllers.delete(created.id);
  }
  const messages = await new BusStore({ dataRoot: root }).read(created.id);
  assert.ok(messages.some((item) => item.kind === "steer" && item.to === "codex-technical" && item.text === "继续核对"));
  assert.ok(messages.some((item) => item.kind === "say" && item.from === "codex-technical" && item.text === "技术续聊答复"));
  assert.ok(messages.some((item) => item.kind === "steer" && item.to === "claude-fable" && item.text === "补一条排队意见"));
  assert.ok(messages.some((item) => item.kind === "say" && item.from === "claude-fable" && item.text === "排队补充"));
  assert.ok(events.filter((event) => event.type === "bus.appended").length >= 4);
});

test("steer ownership rolls back before durability and transfers only after bus append", async (t) => {
  const { root, orchestrator } = await fixture({ "claude-fable": ["初始结论", "不会执行"] });
  t.after(() => rm(root, { recursive: true, force: true }));
  const created = await orchestrator.create({
    prompt: "steer durable ownership",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  await waitTerminal(orchestrator, created.id);
  const run = orchestrator.get(created.id);

  const heldController = new AbortController();
  orchestrator.controllers.set(run.id, heldController);
  const originalSave = orchestrator.save.bind(orchestrator);
  orchestrator.save = async () => { throw Object.assign(new Error("run save failed"), { code: "EIO" }); };
  await assert.rejects(
    () => orchestrator.continue(run.id, { prompt: "保存失败不得假排队", agentId: "claude-fable" }),
    { code: "EIO" },
  );
  assert.equal(run.pendingSteer?.length ?? 0, 0, "failed queue save retained an unaccepted steer");
  orchestrator.save = originalSave;
  orchestrator.controllers.delete(run.id);

  run.pendingSteer = [{ id: "steer-eio", prompt: "bus EIO 后仍归队列", agentId: "claude-fable", queuedAt: new Date().toISOString() }];
  const originalAppend = orchestrator.bus.append.bind(orchestrator.bus);
  orchestrator.bus.append = async (runId, message) => {
    if (message.kind === "steer") throw Object.assign(new Error("bus append failed"), { code: "EIO" });
    return originalAppend(runId, message);
  };
  const maxRoundsBefore = run.maxRounds;
  await assert.rejects(() => orchestrator.injectNextSteer(run), { code: "EIO" });
  assert.equal(run.pendingSteer[0]?.id, "steer-eio");
  assert.equal(run.maxRounds, maxRoundsBefore);
  orchestrator.bus.append = originalAppend;

  run.pendingSteer = [{ id: "steer-durable", prompt: "durable 后保存失败", agentId: "claude-fable", queuedAt: new Date().toISOString() }];
  orchestrator.save = async () => { throw Object.assign(new Error("post-append save failed"), { code: "EIO" }); };
  await assert.rejects(() => orchestrator.injectNextSteer(run), { code: "EIO" });
  orchestrator.save = originalSave;
  assert.equal(run.pendingSteer[0]?.id, "steer-durable", "failed run checkpoint must retain the retry owner");
  const retryController = new AbortController();
  orchestrator.controllers.set(run.id, retryController);
  try {
    await orchestrator.injectNextSteer(run);
  } finally {
    if (orchestrator.controllers.get(run.id) === retryController) orchestrator.controllers.delete(run.id);
  }
  const messages = await new BusStore({ dataRoot: root }).read(run.id);
  assert.equal(
    messages.filter((item) => item.kind === "steer" && item.text === "durable 后保存失败").length,
    1,
    "retry must reuse the durable bus operation instead of appending a duplicate",
  );
});

test("queued steer is appended after the provider turn body it followed", async (t) => {
  const fx = await fixture({
    "claude-fable": ["unused deferred reply", "最终收敛"],
    "codex-technical": ["插话响应"],
  });
  const { root, orchestrator } = fx;
  t.after(() => rm(root, { recursive: true, force: true }));
  const gate = deferFirstTurn(fx, "claude-fable", "当前 provider 正文");
  const created = await orchestrator.create({
    prompt: "验证 provider 与 steer 的总线顺序",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  await gate.started;
  await orchestrator.continue(created.id, { prompt: "在途插话", agentId: "codex-technical" });
  gate.release();

  const terminal = await waitTerminal(orchestrator, created.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  const messages = await new BusStore({ dataRoot: root }).read(created.id);
  const bodyIndex = messages.findIndex((item) => item.kind === "say" && item.from === "claude-fable" && item.text === "当前 provider 正文");
  const steerIndex = messages.findIndex((item) => item.kind === "steer" && item.from === "lo" && item.text === "在途插话");
  const replyIndex = messages.findIndex((item) => item.kind === "say" && item.from === "codex-technical" && item.text === "插话响应");
  assert.ok(bodyIndex >= 0 && steerIndex >= 0 && replyIndex >= 0, JSON.stringify(messages));
  assert.ok(bodyIndex < steerIndex, "queued steer overtook the provider body in the durable bus");
  assert.ok(steerIndex < replyIndex, "steer response preceded its user message");
});

test("an untargeted legacy continuation can become the answer when the provider raises ask", async (t) => {
  const fx = await fixture({
    "claude-fable": ["unused deferred reply", "已消费提前到达的回答", "最终收敛"],
  });
  const { root, orchestrator } = fx;
  t.after(() => rm(root, { recursive: true, force: true }));
  const gate = deferFirstTurn(fx, "claude-fable", "先给出当前正文。\n[[msg:lo]] 请确认方向");
  const created = await orchestrator.create({
    prompt: "验证 ask 所有权",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  await gate.started;
  await orchestrator.continue(created.id, { prompt: "方向 A" });
  gate.release();

  const terminal = await waitTerminal(orchestrator, created.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  assert.equal(terminal.pendingAsk, null);
  const messages = await new BusStore({ dataRoot: root }).read(created.id);
  const bodyIndex = messages.findIndex((item) => item.kind === "say" && item.text === "先给出当前正文。");
  const askIndex = messages.findIndex((item) => item.kind === "ask" && item.to === "lo");
  const answerIndex = messages.findIndex((item) => item.kind === "answer" && item.from === "lo" && item.text === "方向 A");
  assert.ok(bodyIndex >= 0 && askIndex >= 0 && answerIndex >= 0, JSON.stringify(messages));
  assert.ok(bodyIndex < askIndex && askIndex < answerIndex, "ask/answer ownership did not follow provider persistence order");
  assert.ok(!messages.some((item) => item.kind === "steer" && item.text === "方向 A"), "early answer was drained as an ordinary steer");
});

test("a targeted legacy continuation queued before an ask stays a steer for that member", async (t) => {
  const fx = await fixture({
    "claude-fable": ["unused deferred reply", "回答已消费", "最终收敛"],
    "codex-technical": ["定向 legacy 消息已处理"],
  });
  const { root, calls, orchestrator } = fx;
  t.after(() => rm(root, { recursive: true, force: true }));
  const gate = deferFirstTurn(fx, "claude-fable", "正文先落盘。\n[[msg:lo]] 请确认方向");
  const created = await orchestrator.create({
    prompt: "验证 legacy 定向所有权",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  await gate.started;
  await orchestrator.continue(created.id, { prompt: "只问 Codex", agentId: "codex-technical" });
  gate.release();

  const paused = await waitPausedForInput(orchestrator, created.id);
  assert.equal(paused.pendingSteer?.[0]?.answerCandidate, undefined);
  const previousInteractionId = paused.activeInteractionId;
  const previousInteractionSeq = paused.interactionSeq;
  paused.interactionStep = paused.maxStepsPerInteraction;
  await orchestrator.save(paused);
  await orchestrator.continue(created.id, { prompt: "方向 A", answerToAskId: paused.pendingAsk.id });
  const answered = orchestrator.get(created.id);
  assert.notEqual(answered.activeInteractionId, previousInteractionId, "回答必须开启新 interaction，不能继承已耗尽预算");
  assert.equal(answered.interactionSeq, previousInteractionSeq + 1);
  const terminal = await waitTerminal(orchestrator, created.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  const messages = await new BusStore({ dataRoot: root }).read(created.id);
  assert.ok(messages.some((item) => item.kind === "steer" && item.to === "codex-technical" && item.text === "只问 Codex"));
  assert.ok(!messages.some((item) => item.kind === "answer" && item.text === "只问 Codex"));
  assert.ok(calls.some((call) => call.id === "codex-technical"));
});

test("an image answer reaches the asking member without a capability subset gate", async (t) => {
  const fx = await fixture({ "claude-fable": ["unused"] }, {
    models: {
      profiles: [
        { id: "claude-fable", capabilities: [] },
        { id: "codex-technical", capabilities: ["image-analysis"] },
      ],
    },
  });
  const { root, orchestrator } = fx;
  t.after(async () => {
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "answer attachment validation",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  run.status = "waiting_agent";
  const ask = await orchestrator.appendBus(run, {
    from: "claude-fable",
    to: "lo",
    kind: "ask",
    text: "请提供证据",
  });
  run.pendingAsk = { id: ask.id, from: ask.from, text: ask.text, at: ask.ts };
  run.pausedForInput = true;
  await orchestrator.save(run);
  const image = resolve(root, "default-full-capability-answer.png");

  await orchestrator.continue(created.id, {
    prompt: "这是图片证据",
    answerToAskId: ask.id,
    agentId: "claude-fable",
    sources: [image],
  });

  const after = orchestrator.get(created.id);
  assert.equal(after.pendingAsk, null);
  assert.equal(after.pausedForInput, false);
  assert.deepEqual(after.sources.map((source) => source.path), [image]);
  assert.deepEqual(after.pendingInteractionSources, []);
  const messages = await orchestrator.bus.read(created.id);
  assert.equal(
    messages.filter((message) => message.kind === "answer" && message.refs?.answerToAskId === ask.id).length,
    1,
    "图片回答必须先 durable append 再恢复提问成员",
  );
});

test("a targeted member-page steer is never repointed to a pending ask", async (t) => {
  const fx = await fixture({
    "claude-fable": ["unused deferred reply", "回答已消费", "最终收敛"],
    "codex-technical": ["定向消息已处理"],
  });
  const { root, orchestrator } = fx;
  t.after(() => rm(root, { recursive: true, force: true }));
  const gate = deferFirstTurn(fx, "claude-fable", "正文先落盘。\n[[msg:lo]] 请确认方向");
  const created = await orchestrator.create({
    prompt: "验证定向 steer 所有权",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  await gate.started;
  await orchestrator.continue(created.id, { prompt: "只问 Codex", agentId: "codex-technical", messageIntent: "steer" });
  gate.release();

  const paused = await waitPausedForInput(orchestrator, created.id);
  assert.ok(paused.pendingAsk?.id, "pending ask must expose a stable answer ownership id");
  assert.equal(paused.pendingSteer?.[0]?.agentId, "codex-technical");
  const beforeAnswer = await new BusStore({ dataRoot: root }).read(created.id);
  assert.ok(!beforeAnswer.some((item) => item.kind === "answer" && item.text === "只问 Codex"));
  assert.ok(!beforeAnswer.some((item) => item.kind === "steer" && item.text === "只问 Codex"));

  await assert.rejects(
    () => orchestrator.continue(created.id, { prompt: "陈旧回答", answerToAskId: "stale-ask-id" }),
    { code: "ASK_MISMATCH" },
  );
  await assert.rejects(
    () => orchestrator.continue(created.id, {
      prompt: "错误标签回答",
      answerToAskId: paused.pendingAsk.id,
      agentId: "codex-technical",
    }),
    { code: "ASK_OWNER_MISMATCH" },
  );
  await orchestrator.continue(created.id, {
    prompt: "方向 A",
    answerToAskId: paused.pendingAsk.id,
    agentId: "claude-fable",
  });
  const terminal = await waitTerminal(orchestrator, created.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  const messages = await new BusStore({ dataRoot: root }).read(created.id);
  assert.ok(messages.some((item) => item.kind === "answer" && item.to === "claude-fable" && item.text === "方向 A"));
  assert.ok(messages.some((item) => item.kind === "steer" && item.to === "codex-technical" && item.text === "只问 Codex"));
});

test("fresh-process reconciliation restores an ask that reached the bus before run state", async (t) => {
  const fx = await fixture({ "claude-fable": ["unused"] });
  const { root, orchestrator } = fx;
  let restarted;
  t.after(async () => {
    await restarted?.close();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "orphan ask recovery",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  run.status = "running";
  run.pendingAsk = null;
  run.pausedForInput = false;
  await orchestrator.save(run);
  const ask = await orchestrator.appendBus(run, {
    from: "claude-fable",
    to: "lo",
    kind: "ask",
    text: "重启后仍需回答",
    refs: { sourceAttemptId: "attempt-before-crash" },
  });

  restarted = await restartFixtureOrchestrator(fx);
  const recovered = restarted.get(created.id);
  assert.equal(recovered.status, "waiting_agent");
  assert.equal(recovered.pendingAsk?.id, ask.id);
  assert.equal(recovered.pendingAsk?.text, "重启后仍需回答");
  assert.equal(recovered.pausedForInput, true);
  const persisted = JSON.parse(await readFile(resolve(root, "runs", `${created.id}.json`), "utf8"));
  assert.equal(persisted.pendingAsk?.id, ask.id);
});

test("fresh-process answer reconciliation resumes once without duplicating the durable answer", async (t) => {
  const fx = await fixture({ "claude-fable": ["恢复回答", "最终收敛"] });
  const { root, orchestrator } = fx;
  let restarted;
  t.after(async () => {
    await restarted?.close();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "answer crash recovery",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  run.status = "waiting_agent";
  const ask = await orchestrator.appendBus(run, { from: "claude-fable", to: "lo", kind: "ask", text: "继续吗" });
  run.pendingAsk = { id: ask.id, from: ask.from, text: ask.text, at: ask.ts };
  run.pausedForInput = true;
  await orchestrator.save(run);

  const originalSave = orchestrator.save.bind(orchestrator);
  orchestrator.save = async (candidate) => {
    if (!candidate.pendingAsk) throw Object.assign(new Error("answer commit failed"), { code: "EIO" });
    return originalSave(candidate);
  };
  await assert.rejects(
    () => orchestrator.resumePendingAsk(created.id, "继续", { answerToAskId: ask.id }),
    { code: "EIO" },
  );
  orchestrator.save = originalSave;
  assert.equal(run.pendingAsk?.id, ask.id, "failed checkpoint must restore answer ownership in memory");

  restarted = await restartFixtureOrchestrator(fx);
  const terminal = await waitTerminal(restarted, created.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  const messages = await new BusStore({ dataRoot: root }).read(created.id);
  assert.equal(messages.filter((item) => item.kind === "answer" && item.refs?.answerToAskId === ask.id).length, 1);
});

test("fresh-process steer retry reuses queuedSteerId instead of appending twice", async (t) => {
  const fx = await fixture({ "claude-fable": ["steer handled"] });
  const { root, orchestrator } = fx;
  let restarted;
  t.after(async () => {
    await restarted?.close();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "steer crash recovery",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  run.status = "waiting_agent";
  await orchestrator.appendBus(run, { from: "lo", to: "claude-fable", kind: "task", text: run.prompt });
  run.pendingSteer = [{ id: "restart-steer", prompt: "只执行一次", agentId: "claude-fable", queuedAt: new Date().toISOString() }];
  await orchestrator.save(run);
  const originalSave = orchestrator.save.bind(orchestrator);
  orchestrator.save = async (candidate) => {
    if (candidate.activeSteer?.steerId === "restart-steer") {
      throw Object.assign(new Error("steer claim failed"), { code: "EIO" });
    }
    return originalSave(candidate);
  };
  await assert.rejects(() => orchestrator.injectNextSteer(run), { code: "EIO" });
  orchestrator.save = originalSave;

  restarted = await restartFixtureOrchestrator(fx);
  const retryController = new AbortController();
  restarted.controllers.set(created.id, retryController);
  try {
    await restarted.injectNextSteer(restarted.get(created.id));
  } finally {
    if (restarted.controllers.get(created.id) === retryController) restarted.controllers.delete(created.id);
  }
  const messages = await new BusStore({ dataRoot: root }).read(created.id);
  assert.equal(messages.filter((item) => item.kind === "steer" && item.refs?.queuedSteerId === "restart-steer").length, 1);
});

test("fresh-process startup drains a persisted resume queue without requiring a new bus reconciliation", async (t) => {
  const fx = await fixture({ "claude-fable": ["恢复项已处理", "最终收敛"] });
  const { root, orchestrator, calls } = fx;
  let restarted;
  t.after(async () => {
    await restarted?.close();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "persisted resume startup",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  run.status = "waiting_agent";
  run.resumeQueue = [{ to: "claude-fable", busMessageId: "answer-before-restart", kind: "answer" }];
  await orchestrator.save(run);

  restarted = await restartFixtureOrchestrator(fx);
  const terminal = await waitTerminal(restarted, created.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  assert.equal(terminal.resumeClaim, null);
  assert.deepEqual(terminal.resumeQueue, []);
  // 单成员会话只跑恢复轮：冗余 leader 收敛轮已取消（本用例测的是队列排干，不是收敛轮存在）
  assert.equal(calls.filter((call) => call.id === "claude-fable").length, 1, "恢复轮执行一次");
});

test("a two-item resume queue remains fully durable while the first item is only prepared", async (t) => {
  const fx = await fixture({ "claude-fable": ["unused"] });
  const { root, orchestrator } = fx;
  t.after(async () => {
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "two durable items",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  run.status = "waiting_agent";
  run.resumeQueue = [
    { to: "claude-fable", busMessageId: "resume-one", kind: "route" },
    { to: "codex-technical", busMessageId: "resume-two", kind: "route" },
  ];
  await orchestrator.save(run);

  const entered = deferred();
  const release = deferred();
  orchestrator.adapters.get("claude-fable").send = async () => {
    entered.resolve();
    await release.promise;
    return { sessionId: "late", text: "late", protocol: "mock" };
  };
  const controller = new AbortController();
  orchestrator.controllers.set(run.id, controller);
  const looping = orchestrator.socialLoop(run, controller);
  await entered.promise;
  const persisted = JSON.parse(await readFile(resolve(root, "runs", `${run.id}.json`), "utf8"));
  assert.equal(persisted.resumeQueue.length, 2, "prepared checkpoint cannot clear later work items");
  assert.equal(persisted.resumeClaim?.itemId, persisted.resumeQueue[0].itemId);
  assert.equal(persisted.turnAttempts.at(-1)?.phase, "prepared");
  controller.abort();
  release.resolve();
  await assert.rejects(looping, { code: "ABORTED" });
  if (orchestrator.controllers.get(run.id) === controller) orchestrator.controllers.delete(run.id);
});

test("queued-answer promotion save failure preserves a concurrently queued steer and never terminalizes the run", async (t) => {
  const fx = await fixture({ "claude-fable": ["unused"] });
  const { root, orchestrator } = fx;
  t.after(async () => {
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "promotion transaction",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  run.status = "waiting_agent";
  const ask = await orchestrator.appendBus(run, { from: "claude-fable", to: "lo", kind: "ask", text: "请确认" });
  run.pendingAsk = { id: ask.id, from: ask.from, text: ask.text, at: ask.ts };
  run.pausedForInput = true;
  run.pendingSteer = [{
    id: "legacy-answer-candidate",
    prompt: "候选回答",
    agentId: "claude-fable",
    queuedAt: new Date().toISOString(),
    answerCandidate: true,
  }];
  await orchestrator.save(run);

  const saveEntered = deferred();
  const releaseSave = deferred();
  const originalSave = orchestrator.save.bind(orchestrator);
  let failPromotion = true;
  orchestrator.save = async (candidate) => {
    if (failPromotion && !candidate.pendingAsk && (candidate.resumeQueue || []).some((item) => item.kind === "answer")) {
      failPromotion = false;
      saveEntered.resolve();
      await releaseSave.promise;
      throw Object.assign(new Error("promotion disk full"), { code: "EIO" });
    }
    return originalSave(candidate);
  };
  const promoting = orchestrator.promoteQueuedAnswer(run);
  await saveEntered.promise;
  const steering = orchestrator.queueSteer(run, { prompt: "并发 steer", agentId: "codex-technical" });
  releaseSave.resolve();
  assert.equal(await promoting, false);
  await steering;
  orchestrator.save = originalSave;

  assert.equal(run.status, "waiting_agent");
  assert.equal(run.pendingAsk?.id, ask.id);
  assert.deepEqual(run.pendingSteer.map((item) => item.prompt), ["候选回答", "并发 steer"]);
  const persisted = JSON.parse(await readFile(resolve(root, "runs", `${run.id}.json`), "utf8"));
  assert.deepEqual(persisted.pendingSteer.map((item) => item.prompt), ["候选回答", "并发 steer"]);
  assert.equal(persisted.pendingAsk?.id, ask.id);
});

test("fresh process recovers an initial social run whose bus intent was durable before task append", async (t) => {
  const fx = await fixture({ "claude-fable": ["recovered initial dispatch"] });
  const { root, calls, orchestrator } = fx;
  let restarted;
  t.after(async () => {
    await restarted?.close();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "restart before initial task append",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  run.execute = true;
  run.status = "running";
  run.result = null;
  run.maxRounds = 1;
  run.busExpectedAt = new Date().toISOString();
  delete run.busMaterializedAt;
  await orchestrator.save(run);
  assert.deepEqual(await orchestrator.bus.read(run.id), []);

  restarted = await restartFixtureOrchestrator(fx);
  const outcome = await waitRestartRecoveryOrTerminal(restarted, run.id);
  const messages = await restarted.bus.read(run.id);
  assert.equal(outcome.status, "succeeded", outcome.error);
  assert.equal(calls.length, 1, "the interrupted initial provider dispatch must recover exactly once");
  assert.equal(messages.filter((item) => item.kind === "task" && item.text === run.prompt).length, 1);
});

test("fresh process recovers a durable initial task exactly once", async (t) => {
  const fx = await fixture({ "claude-fable": ["recovered durable task"] });
  const { root, calls, orchestrator } = fx;
  let restarted;
  t.after(async () => {
    await restarted?.close();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "restart after initial task append",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  run.execute = true;
  run.status = "running";
  run.result = null;
  run.maxRounds = 1;
  await orchestrator.appendBus(run, { from: "lo", to: "claude-fable", kind: "task", text: run.prompt });
  await orchestrator.save(run);
  assert.equal((await orchestrator.bus.read(run.id)).filter((item) => item.kind === "task").length, 1);

  restarted = await restartFixtureOrchestrator(fx);
  const outcome = await waitRestartRecoveryOrTerminal(restarted, run.id);
  const messages = await restarted.bus.read(run.id);
  assert.equal(messages.filter((item) => item.kind === "task" && item.text === run.prompt).length, 1, "restart must not duplicate the durable task");
  assert.equal(outcome.status, "succeeded", outcome.error);
  assert.equal(calls.length, 1, "the durable task must be dispatched exactly once after restart");
});

test("initial native acceptance failure is recovery_required in memory, on disk, and after restart without replay", async (t) => {
  const fx = await fixture({ "codex-technical": ["must not recover by replay"] });
  const { root, orchestrator } = fx;
  let restarted;
  let nativeDispatches = 0;
  t.after(async () => {
    await restarted?.close();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });

  const accepted = {
    sessionId: "initial-native-session",
    protocol: "app-server-v2",
    clientUserMessageId: "initial-client-message",
    turnId: "initial-native-turn",
  };
  orchestrator.adapters.get("codex-technical").send = async (input) => {
    nativeDispatches += 1;
    await input.onTurnAccepted?.(accepted);
    throw Object.assign(new Error("initial transport failed after native acceptance"), {
      code: "EPIPE",
      safeToFallback: false,
      sessionId: accepted.sessionId,
      clientUserMessageId: accepted.clientUserMessageId,
      codexPhase: "turn/accepted",
    });
  };

  const created = await orchestrator.create({
    prompt: "initial accepted turn must never replay",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
    startAgentId: "codex-technical",
  });
  const execution = orchestrator.executions.get(created.id) ?? orchestrator.startExecution(created.id);
  await execution;

  const assertAmbiguousInitial = (candidate, layer) => {
    assert.equal(candidate.status, "recovery_required", `${layer}: ${candidate.error || candidate.status}`);
    assert.ok(candidate.resumeClaim?.itemId, `${layer}: initial work lost its claim`);
    assert.ok(
      candidate.resumeQueue?.some((item) => item.itemId === candidate.resumeClaim.itemId && item.kind === "task"),
      `${layer}: initial work disappeared from the durable queue`,
    );
    const attempt = candidate.turnAttempts?.find((item) => item.sourceWorkItemId === candidate.resumeClaim.itemId);
    assert.equal(attempt?.phase, "ambiguous", `${layer}: accepted attempt was not marked ambiguous`);
    assert.equal(attempt?.sessionId, accepted.sessionId, `${layer}: native session identity was lost`);
    assert.equal(attempt?.protocol, accepted.protocol, `${layer}: accepted protocol was lost`);
    assert.equal(attempt?.clientUserMessageId, accepted.clientUserMessageId, `${layer}: client message identity was lost`);
    assert.equal(attempt?.nativeTurnId, accepted.turnId, `${layer}: native turn identity was lost`);
  };

  assert.equal(nativeDispatches, 1, "the initial provider turn must be attempted exactly once");
  assertAmbiguousInitial(orchestrator.get(created.id), "memory");
  const persistedBeforeRestart = JSON.parse(await readFile(resolve(root, "runs", `${created.id}.json`), "utf8"));
  assertAmbiguousInitial(persistedBeforeRestart, "disk");

  restarted = await restartFixtureOrchestrator(fx);
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assertAmbiguousInitial(restarted.get(created.id), "fresh restart");
  assert.equal(nativeDispatches, 1, "fresh restart replayed an accepted native turn");
  assert.equal(restarted.executions.has(created.id), false, "ambiguous initial work acquired an automatic execution");
  assert.equal(restarted.controllers.has(created.id), false, "ambiguous initial work acquired an automatic controller");
});

test("prepared leader finalization resumes from its durable work item exactly once after restart", async (t) => {
  // finalize 只在真有多方产出需要综合时才发生（socialFinalizationWorthwhile）——首轮把话
  // 路由给第二个成员，才构造出「leader 需要收敛」的真实场景。单成员会话已不再有收敛轮，
  // 用它做 setup 就永远到不了本用例要测的 prepared 边界。
  const fx = await fixture({ "claude-fable": ["unused"], "codex-technical": ["unused"] });
  const { root, orchestrator } = fx;
  let restarted;
  let initialDispatches = 0;
  let routeDispatches = 0;
  let finalDispatches = 0;
  t.after(async () => {
    await restarted?.close();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });

  orchestrator.adapters.get("claude-fable").send = async (input) => {
    const isFinal = input.prompt.includes("团队对话已收敛") && input.prompt.includes("线程快照");
    if (isFinal) {
      finalDispatches += 1;
      return {
        sessionId: "final-recovered-session",
        text: "durably recovered final answer",
        protocol: "final-recovery-mock",
        tokens: 100,
        costUsd: 0.01,
      };
    }
    initialDispatches += 1;
    return {
      sessionId: "initial-completed-session",
      text: "[[msg:codex-technical]] 你接手技术部分。",
      protocol: "initial-mock",
      tokens: 100,
      costUsd: 0.01,
    };
  };
  orchestrator.adapters.get("codex-technical").send = async () => {
    routeDispatches += 1;
    return {
      sessionId: "route-completed-session",
      text: "技术部分已完成。",
      protocol: "route-mock",
      tokens: 100,
      costUsd: 0.01,
    };
  };

  const originalEmitEvent = orchestrator.emitEvent.bind(orchestrator);
  let simulatedShutdown = false;
  orchestrator.emitEvent = async (run, type, data, context) => {
    if (!simulatedShutdown && type === "agent.turn_started" && data.round === 3) { // 第 3 轮 = leader 收敛轮
      simulatedShutdown = true;
      orchestrator.controllers.get(run.id)?.abort();
      throw Object.assign(new Error("simulated shutdown after prepared final checkpoint"), { code: "ABORTED" });
    }
    return originalEmitEvent(run, type, data, context);
  };

  const created = await orchestrator.create({
    prompt: "durable finalization restart",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const interrupted = orchestrator.executions.get(created.id) ?? orchestrator.startExecution(created.id);
  await interrupted;

  assert.equal(simulatedShutdown, true, "test never reached the prepared finalization boundary");
  assert.equal(initialDispatches, 1, "the initial social turn must complete once before finalization");
  assert.equal(routeDispatches, 1, "the routed member turn must complete once before finalization");
  assert.equal(finalDispatches, 0, "the final provider dispatched before the prepared checkpoint boundary");
  const prepared = JSON.parse(await readFile(resolve(root, "runs", `${created.id}.json`), "utf8"));
  const finalItem = prepared.resumeQueue?.find((item) => item.kind === "finalize");
  assert.ok(finalItem?.itemId, "prepared finalization has no durable work item");
  assert.equal(prepared.resumeClaim?.itemId, finalItem.itemId, "prepared finalization lost queue ownership");
  const preparedAttempts = prepared.turnAttempts?.filter((attempt) => attempt.sourceWorkItemId === finalItem.itemId) ?? [];
  assert.equal(preparedAttempts.length, 1, "prepared finalization created more than one attempt");
  assert.equal(preparedAttempts[0].phase, "prepared");
  assert.equal((await orchestrator.bus.read(created.id)).filter((item) => item.kind === "decide").length, 0);

  restarted = await restartFixtureOrchestrator(fx);
  const terminal = await waitTerminal(restarted, created.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  assert.equal(initialDispatches, 1, "restart repeated the already completed initial social turn");
  assert.equal(finalDispatches, 1, "prepared finalization must dispatch exactly once after restart");
  assert.equal(terminal.round, 3, "prepared-attempt recovery must not consume another round");
  assert.equal(terminal.resumeClaim, null);
  assert.deepEqual(terminal.resumeQueue, []);
  const finalAttempts = terminal.turnAttempts.filter((attempt) => attempt.sourceWorkItemId === finalItem.itemId);
  assert.equal(finalAttempts.length, 1, "restart created a second finalization attempt");
  assert.equal(finalAttempts[0].phase, "completed");
  const decisions = (await restarted.bus.read(created.id)).filter((item) => item.kind === "decide");
  assert.equal(decisions.length, 1, "leader final decision was appended more than once");
  assert.equal(decisions[0].text, "durably recovered final answer");
  assert.match(decisions[0].id, /^decision:/);

  const persistedTerminal = JSON.parse(await readFile(resolve(root, "runs", `${created.id}.json`), "utf8"));
  assert.equal(persistedTerminal.status, "succeeded");
  assert.equal(persistedTerminal.resumeClaim, null);
  assert.deepEqual(persistedTerminal.resumeQueue, []);
});

test("cancel after completed checkpoint suppresses every later social projection", async (t) => {
  const fx = await fixture({ "claude-fable": ["unused"] });
  const { root, orchestrator, events } = fx;
  t.after(async () => {
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  orchestrator.adapters.get("claude-fable").send = async (input) => {
    await input.onSessionStarted?.({ sessionId: "completed-before-cancel" });
    return {
      sessionId: "completed-before-cancel",
      text: "不得投影的正文\n[[msg:lo]] 不得投影的提问",
      protocol: "completed-checkpoint-gate",
      tokens: 100,
      costUsd: 0.01,
    };
  };
  const completed = deferred();
  const allowProjection = deferred();
  const originalCheckpoint = orchestrator.checkpointTurn.bind(orchestrator);
  orchestrator.checkpointTurn = async (...args) => {
    const result = await originalCheckpoint(...args);
    if (args[3] === "completed") {
      completed.resolve();
      await allowProjection.promise;
    }
    return result;
  };

  const created = await orchestrator.create({
    prompt: "cancel after completed checkpoint",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  await completed.promise;
  const checkpointed = JSON.parse(await readFile(resolve(root, "runs", `${created.id}.json`), "utf8"));
  assert.equal(checkpointed.turnAttempts.at(-1)?.phase, "completed");
  assert.equal(checkpointed.turns.at(-1)?.text.includes("不得投影的正文"), true);
  assert.equal(events.some((event) => event.type === "agent.turn_completed"), false);

  const cancelled = await orchestrator.cancel(created.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pendingAsk, null);
  const eventBoundary = events.length;
  const execution = orchestrator.executions.get(created.id);
  assert.ok(execution, "completed checkpoint must still be owned by the blocked execution");
  allowProjection.resolve();
  await execution;

  const after = orchestrator.get(created.id);
  const messages = await orchestrator.bus.read(created.id);
  const lateEvents = events.slice(eventBoundary);
  assert.equal(after.status, "cancelled");
  assert.equal(after.pendingAsk, null);
  assert.ok(!messages.some((item) => item.kind === "say" && item.text.includes("不得投影的正文")));
  assert.ok(!messages.some((item) => item.kind === "ask" && item.text.includes("不得投影的提问")));
  assert.ok(!lateEvents.some((event) => event.type === "agent.turn_completed" || event.type === "run.completed"));
});

test("fresh process blocks completed but unacknowledged resume and steer claims", async (t) => {
  const fx = await fixture({ "claude-fable": ["must not dispatch"] });
  const { root, calls, orchestrator } = fx;
  let restarted;
  t.after(async () => {
    await restarted?.close();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const makeRun = async (prompt) => orchestrator.create({
    prompt,
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });

  const resumeCreated = await makeRun("completed resume claim");
  const resumeRun = orchestrator.get(resumeCreated.id);
  resumeRun.status = "waiting_agent";
  resumeRun.result = null;
  resumeRun.resumeQueue = [{ itemId: "completed-resume-item", to: "claude-fable", busMessageId: "resume-source", kind: "answer" }];
  resumeRun.resumeClaim = { itemId: "completed-resume-item", to: "claude-fable", busMessageId: "resume-source", claimedAt: new Date().toISOString() };
  resumeRun.turnAttempts = [{ attemptId: "completed-resume-attempt", agentId: "claude-fable", phase: "completed", sourceWorkItemId: "completed-resume-item", sourceBusMessageId: "resume-source" }];
  await orchestrator.save(resumeRun);

  const steerCreated = await makeRun("completed active steer");
  const steerRun = orchestrator.get(steerCreated.id);
  steerRun.status = "waiting_agent";
  steerRun.result = null;
  steerRun.pendingSteer = [{ id: "completed-active-steer", prompt: "must not replay", agentId: "claude-fable", queuedAt: new Date().toISOString() }];
  steerRun.activeSteer = { steerId: "completed-active-steer", busMessageId: "steer-source", to: "claude-fable", priorMaxRounds: steerRun.maxRounds, maxRounds: steerRun.maxRounds, claimedAt: new Date().toISOString() };
  steerRun.turnAttempts = [{ attemptId: "completed-steer-attempt", agentId: "claude-fable", phase: "completed", sourceWorkItemId: "completed-active-steer", sourceBusMessageId: "steer-source" }];
  await orchestrator.save(steerRun);

  restarted = await restartFixtureOrchestrator(fx);
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  for (const runId of [resumeRun.id, steerRun.id]) {
    const recovered = restarted.get(runId);
    assert.equal(recovered.status, "recovery_required");
    assert.equal(restarted.executions.has(runId), false);
    assert.equal(restarted.controllers.has(runId), false);
  }
  assert.equal(calls.length, 0, "completed but unacknowledged claims are ambiguous and must never auto-dispatch");
});

test("fresh process never replays a promoted durable answer as a steer after its state save failed", async (t) => {
  const fx = await fixture({ "claude-fable": ["answer resumed", "leader converged", "must not see a third dispatch"] });
  const { root, orchestrator } = fx;
  let restarted;
  t.after(async () => {
    await restarted?.close();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "promotion durable answer restart",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  run.status = "waiting_agent";
  run.result = null;
  const ask = await orchestrator.appendBus(run, { from: "claude-fable", to: "lo", kind: "ask", text: "confirm promotion" });
  const candidate = {
    id: "promoted-answer-candidate",
    prompt: "same text must remain an answer",
    agentId: "claude-fable",
    queuedAt: new Date().toISOString(),
    answerCandidate: true,
  };
  run.pendingAsk = { id: ask.id, from: ask.from, text: ask.text, at: ask.ts };
  run.pausedForInput = true;
  run.pendingSteer = [candidate];
  await orchestrator.save(run);

  const originalSave = orchestrator.save.bind(orchestrator);
  let failAnswerState = true;
  orchestrator.save = async (next) => {
    if (failAnswerState && !next.pendingAsk && (next.resumeQueue || []).some((item) => item.kind === "answer")) {
      failAnswerState = false;
      throw Object.assign(new Error("promotion state checkpoint failed"), { code: "EIO" });
    }
    return originalSave(next);
  };
  assert.equal(await orchestrator.promoteQueuedAnswer(run), false);
  orchestrator.save = originalSave;
  const beforeRestart = await orchestrator.bus.read(run.id);
  assert.equal(beforeRestart.filter((item) => item.kind === "answer" && item.refs?.queuedSteerId === candidate.id).length, 1);
  assert.equal(beforeRestart.filter((item) => item.kind === "steer" && item.refs?.queuedSteerId === candidate.id).length, 0);

  restarted = await restartFixtureOrchestrator(fx);
  const outcome = await waitRestartRecoveryOrTerminal(restarted, run.id);
  const messages = await restarted.bus.read(run.id);
  assert.ok(outcome.status === "succeeded" || outcome.status === "recovery_required", outcome.error || outcome.status);
  assert.equal(
    messages.filter((item) => item.kind === "steer" && item.refs?.queuedSteerId === candidate.id && item.text === candidate.prompt).length,
    0,
    "the queued item already materialized as an answer must not be replayed as a steer",
  );
  assert.equal(
    (outcome.turnAttempts || []).filter((attempt) => attempt.sourceWorkItemId === candidate.id).length,
    0,
    "provider dispatch must not consume the promoted answer candidate as a steer work item",
  );
});

test("cancel save-chain barrier rejects a concurrent direct continue without a late provider dispatch", async (t) => {
  const fx = await fixture({ "claude-fable": ["must never dispatch"] });
  const { root, calls, orchestrator, events } = fx;
  t.after(async () => {
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "cancel versus direct continue",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  const priorSave = deferred();
  orchestrator.saveChains.set(run.id, priorSave.promise);
  const eventBoundary = events.length;
  let cancelSettled = false;
  const cancelling = orchestrator.cancel(run.id).finally(() => { cancelSettled = true; });

  // cancel() has crossed its synchronous epoch gate and enqueued its durable
  // cancelled snapshot behind the unresolved prior save.
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(cancelSettled, false);
  assert.equal(orchestrator.cancellingRuns.has(run.id), true);
  assert.notEqual(orchestrator.saveChains.get(run.id), priorSave.promise, "cancel must be waiting on a real successor save");

  const continuing = orchestrator.continue(run.id, {
    prompt: "must not start after cancel began",
    agentId: "claude-fable",
    messageIntent: "steer",
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(calls.length, 0, "provider dispatch crossed the unresolved cancellation barrier");

  priorSave.resolve();
  const [cancelled, continuationOutcome] = await Promise.all([cancelling, continuing]);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(
    ["RUN_CANCELLED", "ABORTED", "RUN_TERMINAL"].includes(continuationOutcome.error?.code)
      || continuationOutcome.value?.status === "cancelled",
    `concurrent continuation escaped cancellation | ${continuationOutcome.error?.code || continuationOutcome.value?.status}`,
  );
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  const persisted = JSON.parse(await readFile(resolve(root, "runs", `${run.id}.json`), "utf8"));
  const messages = await orchestrator.bus.read(run.id);
  assert.equal(orchestrator.get(run.id).status, "cancelled");
  assert.equal(persisted.status, "cancelled");
  assert.equal(calls.length, 0, "cancel return must be a no-new-dispatch boundary");
  assert.ok(!messages.some((message) => message.text === "must not start after cancel began"));
  assert.ok(!events.slice(eventBoundary).some((event) => event.type === "run.completed" && event.data?.status === "succeeded"));
});

test("acknowledged recovery abandons completed resume and steer claims so a second restart cannot revive them", async (t) => {
  const fx = await fixture({ "claude-fable": ["fresh resume prompt handled", "fresh steer prompt handled"] });
  const { root, calls, orchestrator } = fx;
  let recovered;
  let restartedAgain;
  t.after(async () => {
    await restartedAgain?.close();
    await recovered?.close();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const createDormantRun = async (prompt) => {
    const created = await orchestrator.create({
      prompt,
      execute: false,
      permissionMode: "plan",
      teamId: "team-514cc",
      orchestrationMode: "social",
    });
    const run = orchestrator.get(created.id);
    run.status = "waiting_agent";
    run.result = null;
    run.round = 1;
    return run;
  };

  const resumeRun = await createDormantRun("acknowledge completed resume claim");
  const resumeItemId = "ack-completed-resume";
  resumeRun.resumeQueue = [{ itemId: resumeItemId, to: "claude-fable", busMessageId: "ack-resume-source", kind: "answer" }];
  resumeRun.resumeClaim = { itemId: resumeItemId, to: "claude-fable", busMessageId: "ack-resume-source", claimedAt: new Date().toISOString() };
  resumeRun.turnAttempts = [{ attemptId: "ack-resume-attempt", agentId: "claude-fable", phase: "completed", sourceWorkItemId: resumeItemId, sourceBusMessageId: "ack-resume-source" }];
  await orchestrator.save(resumeRun);

  const steerRun = await createDormantRun("acknowledge completed steer claim");
  const steerId = "ack-completed-steer";
  steerRun.pendingSteer = [{ id: steerId, prompt: "ambiguous old steer", agentId: "claude-fable", queuedAt: new Date().toISOString() }];
  steerRun.activeSteer = { steerId, busMessageId: "ack-steer-source", to: "claude-fable", priorMaxRounds: steerRun.maxRounds, maxRounds: steerRun.maxRounds, claimedAt: new Date().toISOString() };
  steerRun.turnAttempts = [{ attemptId: "ack-steer-attempt", agentId: "claude-fable", phase: "completed", sourceWorkItemId: steerId, sourceBusMessageId: "ack-steer-source" }];
  await orchestrator.save(steerRun);

  recovered = await restartFixtureOrchestrator(fx);
  assert.equal(recovered.get(resumeRun.id).status, "recovery_required");
  assert.equal(recovered.get(steerRun.id).status, "recovery_required");
  assert.equal(calls.length, 0);

  await recovered.continue(resumeRun.id, {
    prompt: "new prompt after resume recovery",
    agentId: "claude-fable",
    messageIntent: "steer",
    acknowledgeRecovery: true,
  });
  await recovered.continue(steerRun.id, {
    prompt: "new prompt after steer recovery",
    agentId: "claude-fable",
    messageIntent: "steer",
    acknowledgeRecovery: true,
  });

  for (const [runId, abandonedId, queueName] of [
    [resumeRun.id, resumeItemId, "resumeQueue"],
    [steerRun.id, steerId, "pendingSteer"],
  ]) {
    const acknowledged = recovered.get(runId);
    assert.equal(acknowledged.status, "succeeded", acknowledged.error);
    assert.equal(acknowledged.resumeClaim, null);
    assert.equal(acknowledged.activeSteer, null);
    assert.ok(acknowledged.recoveryAcknowledgedAt);
    assert.match(acknowledged.recoveryNote, /abandoned/i);
    assert.ok(!(acknowledged[queueName] || []).some((item) => item?.itemId === abandonedId || item?.id === abandonedId));
    assert.equal(
      acknowledged.turnAttempts.filter((attempt) => attempt.sourceWorkItemId === abandonedId).length,
      1,
      "the completed ambiguous attempt remains audit evidence but must not be dispatched again",
    );
    const persisted = JSON.parse(await readFile(resolve(root, "runs", `${runId}.json`), "utf8"));
    assert.equal(persisted.resumeClaim, null);
    assert.equal(persisted.activeSteer, null);
    assert.ok(!(persisted[queueName] || []).some((item) => item?.itemId === abandonedId || item?.id === abandonedId));
  }
  assert.equal(calls.filter((call) => call.prompt === "new prompt after resume recovery").length, 1);
  assert.equal(calls.filter((call) => call.prompt === "new prompt after steer recovery").length, 1);

  const callsAfterAcknowledgement = calls.length;
  restartedAgain = await restartFixtureOrchestrator({ root, orchestrator: recovered });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(calls.length, callsAfterAcknowledgement, "second restart revived an abandoned claim");
  for (const [runId, abandonedId, queueName] of [
    [resumeRun.id, resumeItemId, "resumeQueue"],
    [steerRun.id, steerId, "pendingSteer"],
  ]) {
    const afterRestart = restartedAgain.get(runId);
    assert.equal(afterRestart.status, "succeeded");
    assert.equal(afterRestart.resumeClaim, null);
    assert.equal(afterRestart.activeSteer, null);
    assert.ok(!(afterRestart[queueName] || []).some((item) => item?.itemId === abandonedId || item?.id === abandonedId));
  }
});

test("cancelling while the safe fallback audit is pending prevents fallback provider dispatch", async (t) => {
  const fx = await fixture({ "claude-fable": ["must not converge"] });
  const { root, orchestrator } = fx;
  const fallbackAuditEntered = deferred();
  const releaseFallbackAudit = deferred();
  let primaryDispatches = 0;
  let fallbackDispatches = 0;
  t.after(async () => {
    releaseFallbackAudit.resolve();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });

  orchestrator.adapters.get("codex-technical").send = async () => {
    primaryDispatches += 1;
    throw Object.assign(new Error("safe pre-submit transport failure"), {
      code: "EPIPE",
      safeToFallback: true,
    });
  };
  orchestrator.adapters.set("codex-technical-fallback", {
    async send() {
      fallbackDispatches += 1;
      return { sessionId: "fallback-session", text: "must not dispatch", protocol: "fallback-mock" };
    },
    async close() {},
  });
  const emit = orchestrator.eventStore.emit.bind(orchestrator.eventStore);
  orchestrator.eventStore.emit = async (type, data, context) => {
    if (type === "adapter.fallback") {
      fallbackAuditEntered.resolve();
      await releaseFallbackAudit.promise;
    }
    return emit(type, data, context);
  };

  const created = await orchestrator.create({
    prompt: "cancel inside fallback audit window",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
    startAgentId: "codex-technical",
    maxRounds: 8,
  });
  await fallbackAuditEntered.promise;

  const cancelled = await orchestrator.cancel(created.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(primaryDispatches, 1);
  assert.equal(fallbackDispatches, 0, "fallback dispatched before the pending audit await released");

  const execution = orchestrator.executions.get(created.id);
  releaseFallbackAudit.resolve();
  if (execution) await execution;
  assert.equal(orchestrator.get(created.id).status, "cancelled");
  assert.equal(fallbackDispatches, 0, "an aborted safe-fallback branch must re-check ownership before dispatch");
});

test("recovery acknowledgement preserves later safe resume work across a second restart", async (t) => {
  const fx = await fixture({
    "claude-fable": ["new operator prompt handled", "leader convergence"],
    "codex-technical": ["safe queued route handled"],
  });
  const { root, orchestrator } = fx;
  let recovered;
  let restartedAgain;
  t.after(async () => {
    await restartedAgain?.close();
    await recovered?.close();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });

  const created = await orchestrator.create({
    prompt: "recovery queue ownership",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  const ambiguousItemId = "ambiguous-completed-resume";
  const safeItemId = "safe-followup-resume";
  run.execute = true;
  run.status = "waiting_agent";
  run.result = null;
  run.round = 1;
  run.resumeQueue = [
    { itemId: ambiguousItemId, to: "claude-fable", busMessageId: "ambiguous-resume-source", kind: "answer" },
    { itemId: safeItemId, to: "codex-technical", busMessageId: "safe-resume-source", kind: "route" },
  ];
  run.resumeClaim = {
    itemId: ambiguousItemId,
    to: "claude-fable",
    busMessageId: "ambiguous-resume-source",
    claimedAt: new Date().toISOString(),
  };
  run.turnAttempts = [{
    attemptId: "ambiguous-completed-attempt",
    agentId: "claude-fable",
    phase: "completed",
    sourceWorkItemId: ambiguousItemId,
    sourceBusMessageId: "ambiguous-resume-source",
  }];
  await orchestrator.save(run);

  recovered = await restartFixtureOrchestrator(fx);
  assert.equal(recovered.get(run.id).status, "recovery_required");
  await recovered.continue(run.id, {
    prompt: "new prompt after abandoning only the ambiguous item",
    agentId: "claude-fable",
    messageIntent: "steer",
    acknowledgeRecovery: true,
  });
  const acknowledged = recovered.get(run.id);
  assert.equal(acknowledged.resumeClaim, null);
  assert.ok(!acknowledged.resumeQueue.some((item) => item.itemId === ambiguousItemId));
  assert.equal(
    acknowledged.turnAttempts.filter((attempt) => attempt.sourceWorkItemId === ambiguousItemId).length,
    1,
    "the ambiguous completed item must remain audit evidence but never replay",
  );

  restartedAgain = await restartFixtureOrchestrator({ root, orchestrator: recovered });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  const restartExecution = restartedAgain.executions.get(run.id)
    ?? restartedAgain.executions.get(`continue:${run.id}`);
  if (restartExecution) await restartExecution;
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

  const afterRestart = restartedAgain.get(run.id);
  const safeQueued = (afterRestart.resumeQueue || []).some((item) => item.itemId === safeItemId);
  const safeAttempts = (afterRestart.turnAttempts || [])
    .filter((attempt) => attempt.sourceWorkItemId === safeItemId);
  const safeConsumed = !safeQueued && safeAttempts.length === 1;
  const safeStillRecoverable = ["waiting_agent", "recovery_required"].includes(afterRestart.status)
    && (safeQueued || restartedAgain.controllers.has(run.id) || restartedAgain.executions.has(run.id));
  assert.ok(!afterRestart.resumeQueue.some((item) => item.itemId === ambiguousItemId));
  assert.equal(
    afterRestart.turnAttempts.filter((attempt) => attempt.sourceWorkItemId === ambiguousItemId).length,
    1,
    "a second restart must not revive the acknowledged ambiguous item",
  );
  assert.ok(
    safeConsumed || safeStillRecoverable,
    `safe resume work became unreachable after acknowledgement | ${JSON.stringify({
      status: afterRestart.status,
      safeQueued,
      safeAttemptPhases: safeAttempts.map((attempt) => attempt.phase),
      controllers: [...restartedAgain.controllers.keys()],
      executions: [...restartedAgain.executions.keys()],
    })}`,
  );
});

test("an acknowledged safe resume tail that becomes ambiguous stays recovery_required across restart", async (t) => {
  const fx = await fixture({
    "claude-fable": ["new operator prompt handled"],
  });
  const { root, calls, orchestrator } = fx;
  let recovered;
  let restartedAgain;
  let unsafeTailDispatches = 0;
  t.after(async () => {
    await restartedAgain?.close();
    await recovered?.close();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });

  orchestrator.adapters.get("codex-technical").send = async (input) => {
    unsafeTailDispatches += 1;
    const checkpoint = {
      sessionId: "safe-tail-native-session",
      clientUserMessageId: "safe-tail-client-message",
      turnId: "safe-tail-native-turn",
    };
    await input.onSessionStarted?.(checkpoint);
    await input.onTurnSubmitting?.(checkpoint);
    await input.onTurnAccepted?.(checkpoint);
    throw Object.assign(new Error("safe tail transport failed after native acceptance"), {
      code: "EPIPE",
      safeToFallback: false,
      sessionId: checkpoint.sessionId,
      clientUserMessageId: checkpoint.clientUserMessageId,
      codexPhase: "turn/accepted",
    });
  };

  const created = await orchestrator.create({
    prompt: "recovery tail failure ownership",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  const ambiguousItemId = "completed-ambiguous-head";
  const safeItemId = "safe-tail-after-ack";
  run.execute = true;
  run.status = "waiting_agent";
  run.result = null;
  run.round = 1;
  run.resumeQueue = [
    { itemId: ambiguousItemId, to: "claude-fable", busMessageId: "completed-ambiguous-source", kind: "answer" },
    { itemId: safeItemId, to: "codex-technical", busMessageId: "safe-tail-source", kind: "route" },
  ];
  run.resumeClaim = {
    itemId: ambiguousItemId,
    to: "claude-fable",
    busMessageId: "completed-ambiguous-source",
    claimedAt: new Date().toISOString(),
  };
  run.turnAttempts = [{
    attemptId: "completed-ambiguous-attempt",
    agentId: "claude-fable",
    phase: "completed",
    sourceWorkItemId: ambiguousItemId,
    sourceBusMessageId: "completed-ambiguous-source",
  }];
  await orchestrator.save(run);

  recovered = await restartFixtureOrchestrator(fx);
  assert.equal(recovered.get(run.id).status, "recovery_required");
  assert.equal(unsafeTailDispatches, 0, "the safe tail must not auto-dispatch before acknowledgement");

  await assert.rejects(
    () => recovered.continue(run.id, {
      prompt: "new prompt before draining the safe tail",
      agentId: "claude-fable",
      messageIntent: "steer",
      acknowledgeRecovery: true,
    }),
    (error) => error.code === "EPIPE" && error.safeToFallback === false,
  );

  const blocked = recovered.get(run.id);
  assert.equal(calls.filter((call) => call.prompt === "new prompt before draining the safe tail").length, 1);
  assert.equal(blocked.result?.continued, "new operator prompt handled", "the acknowledged operator prompt did not complete before tail drain");
  assert.equal(unsafeTailDispatches, 1);
  assert.equal(blocked.status, "recovery_required", blocked.error);
  assert.equal(blocked.resumeClaim?.itemId, safeItemId);
  assert.ok(blocked.resumeQueue.some((item) => item.itemId === safeItemId));
  assert.ok(!blocked.resumeQueue.some((item) => item.itemId === ambiguousItemId));
  assert.match(blocked.error ?? "", /failed after native acceptance/);
  assert.match(blocked.recoveryNote ?? "", /could not drain durable work/i);
  const tailAttempts = blocked.turnAttempts.filter((attempt) => attempt.sourceWorkItemId === safeItemId);
  assert.equal(tailAttempts.length, 1);
  assert.equal(tailAttempts[0].phase, "ambiguous");
  assert.equal(tailAttempts[0].clientUserMessageId, "safe-tail-client-message");

  await assert.rejects(
    () => recovered.continue(run.id, {
      prompt: "must remain blocked without a second acknowledgement",
      agentId: "claude-fable",
      messageIntent: "steer",
    }),
    { code: "RECOVERY_REQUIRED" },
  );

  const persisted = JSON.parse(await readFile(resolve(root, "runs", `${run.id}.json`), "utf8"));
  assert.equal(persisted.status, "recovery_required");
  assert.equal(persisted.resumeClaim?.itemId, safeItemId);
  assert.ok(persisted.resumeQueue.some((item) => item.itemId === safeItemId));
  assert.equal(
    persisted.turnAttempts.filter((attempt) => attempt.sourceWorkItemId === safeItemId)[0]?.phase,
    "ambiguous",
  );

  const callsBeforeRestart = calls.length;
  restartedAgain = await restartFixtureOrchestrator({ root, orchestrator: recovered });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

  const afterRestart = restartedAgain.get(run.id);
  assert.equal(afterRestart.status, "recovery_required");
  assert.equal(afterRestart.resumeClaim?.itemId, safeItemId);
  assert.ok(afterRestart.resumeQueue.some((item) => item.itemId === safeItemId));
  assert.equal(unsafeTailDispatches, 1, "fresh restart replayed an ambiguous safe-tail provider turn");
  assert.equal(calls.length, callsBeforeRestart, "fresh restart dispatched a provider without acknowledgement");
  assert.equal(
    afterRestart.turnAttempts.find((attempt) => attempt.sourceWorkItemId === safeItemId)?.nativeTurnId,
    "safe-tail-native-turn",
    "the ambiguous checkpoint erased the accepted native turn identity needed for operator recovery",
  );
});

test("cancel discards a provider response that ignores AbortSignal before any late turn or ask projection", async (t) => {
  const fx = await fixture({ "claude-fable": ["unused"] });
  const { root, orchestrator, events } = fx;
  t.after(async () => {
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const entered = deferred();
  const release = deferred();
  orchestrator.adapters.get("claude-fable").send = async () => {
    entered.resolve();
    await release.promise;
    return { sessionId: "late-session", text: "[[msg:lo]] 迟到问题", protocol: "ignores-abort" };
  };
  const created = await orchestrator.create({
    prompt: "late cancellation boundary",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  await entered.promise;
  await orchestrator.cancel(created.id);
  release.resolve();
  const execution = orchestrator.executions.get(created.id);
  if (execution) await execution;
  const cancelled = orchestrator.get(created.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.turns.length, 0);
  assert.equal(cancelled.pendingAsk, null);
  assert.ok(!events.some((event) => event.type === "agent.turn_completed" || event.type === "run.completed"));
});

test("a corrupted bus tail keeps the run visible and blocks automatic recovery", async (t) => {
  const fx = await fixture({ "claude-fable": ["unused"] });
  const { root, orchestrator } = fx;
  let restarted;
  t.after(async () => {
    await restarted?.close();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "corrupt bus visibility",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  run.status = "running";
  await orchestrator.appendBus(run, { from: "lo", to: "claude-fable", kind: "task", text: run.prompt });
  await orchestrator.save(run);
  await appendFile(orchestrator.bus.file(run.id), "{malformed-tail\n", "utf8");

  restarted = await restartFixtureOrchestrator(fx);
  const visible = restarted.get(run.id);
  assert.equal(visible.status, "recovery_required");
  assert.equal(visible.auditDegraded, true);
  assert.equal(visible.recoveryIssue?.code, "BUS_RECONCILIATION_FAILED");
  assert.equal(restarted.executions.has(run.id), false);
});

test("idless legacy ask migration gives retries one stable ask and answer identity", async (t) => {
  const fx = await fixture({ "claude-fable": ["恢复 legacy 回答", "最终收敛"] });
  const { root, orchestrator } = fx;
  t.after(async () => {
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "legacy idless ask",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  run.status = "waiting_agent";
  run.pendingAsk = { from: "claude-fable", text: "旧问题", at: "2026-07-20T00:00:00.000Z" };
  run.pausedForInput = true;
  await orchestrator.save(run);

  const originalSave = orchestrator.save.bind(orchestrator);
  let failCommit = true;
  orchestrator.save = async (candidate) => {
    if (failCommit && candidate.pendingAsk == null && (candidate.resumeQueue || []).some((item) => item.kind === "answer")) {
      failCommit = false;
      throw Object.assign(new Error("legacy answer checkpoint failed"), { code: "EIO" });
    }
    return originalSave(candidate);
  };
  await assert.rejects(() => orchestrator.resumePendingAsk(run.id, "继续旧任务"), { code: "EIO" });
  orchestrator.save = originalSave;
  const stableAskId = run.pendingAsk?.id;
  assert.match(stableAskId, /^legacy-ask:/);

  await orchestrator.resumePendingAsk(run.id, "继续旧任务", { answerToAskId: stableAskId });
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  const messages = await new BusStore({ dataRoot: root }).read(run.id);
  assert.equal(messages.filter((item) => item.kind === "ask" && item.id === stableAskId).length, 1);
  assert.equal(messages.filter((item) => item.kind === "answer" && item.refs?.answerToAskId === stableAskId).length, 1);
});

test("reconciliation restores every unconsumed queued route and never revives dropped or completed routes", async (t) => {
  const fx = await fixture({ "claude-fable": ["unused"] });
  const { root, orchestrator } = fx;
  t.after(async () => {
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "route disposition recovery",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  run.status = "waiting_agent";
  const queued = await orchestrator.appendBus(run, {
    from: "claude-fable",
    to: "codex-technical",
    kind: "say",
    text: "早期待处理路由",
    refs: { sourceAttemptId: "attempt-old", routeDisposition: "queued" },
  });
  const dropped = await orchestrator.appendBus(run, {
    from: "claude-fable",
    to: "codex-technical",
    kind: "say",
    text: "熔断丢弃路由",
    refs: { sourceAttemptId: "attempt-new", routeDisposition: "dropped" },
  });
  const completed = await orchestrator.appendBus(run, {
    from: "claude-fable",
    to: "codex-technical",
    kind: "say",
    text: "已完成路由",
    refs: { sourceAttemptId: "attempt-done", routeDisposition: "queued" },
  });
  run.turnAttempts.push({
    attemptId: "consumer",
    sourceWorkItemId: "completed-work",
    sourceBusMessageId: completed.id,
    phase: "completed",
  });
  const ask = await orchestrator.appendBus(run, { from: "claude-fable", to: "lo", kind: "ask", text: "保持挂起" });
  run.pendingAsk = { id: ask.id, from: ask.from, text: ask.text, at: ask.ts };
  run.pausedForInput = true;
  await orchestrator.save(run);

  const result = await orchestrator.reconcileSocialBus(run);
  assert.equal(result.changed, true);
  assert.deepEqual(run.resumeQueue.map((item) => item.busMessageId), [queued.id]);
  assert.ok(!run.resumeQueue.some((item) => item.busMessageId === dropped.id || item.busMessageId === completed.id));
});

test("answer reconciliation requires LO ownership and the original asker as recipient", async (t) => {
  const fx = await fixture({ "claude-fable": ["unused"] });
  const { root, orchestrator } = fx;
  t.after(async () => {
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "answer semantic ownership",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  run.status = "waiting_agent";
  const ask = await orchestrator.appendBus(run, { from: "claude-fable", to: "lo", kind: "ask", text: "谁能解锁" });
  run.pendingAsk = { id: ask.id, from: ask.from, text: ask.text, at: ask.ts };
  run.pausedForInput = true;
  await orchestrator.appendBus(run, {
    from: "system",
    to: "claude-fable",
    kind: "answer",
    text: "系统伪答",
    refs: { answerToAskId: ask.id },
  });
  await orchestrator.appendBus(run, {
    from: "lo",
    to: "codex-technical",
    kind: "answer",
    text: "发错成员",
    refs: { answerToAskId: ask.id },
  });
  let result = await orchestrator.reconcileSocialBus(run);
  assert.equal(result.resume, false);
  assert.equal(run.pendingAsk?.id, ask.id);
  assert.deepEqual(run.resumeQueue || [], []);

  const owned = await orchestrator.appendBus(run, {
    from: "lo",
    to: "claude-fable",
    kind: "answer",
    text: "正确回答",
    refs: { answerToAskId: ask.id },
  });
  result = await orchestrator.reconcileSocialBus(run);
  assert.equal(result.resume, true);
  assert.equal(run.pendingAsk, null);
  assert.equal(run.resumeQueue[0].busMessageId, owned.id);
});

test("fresh-process steer recovery reuses a durable active claim and request message", async (t) => {
  const fx = await fixture({ "claude-fable": ["steer recovered"] });
  const { root, orchestrator } = fx;
  let restarted;
  t.after(async () => {
    await restarted?.close();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "active steer restart",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  run.status = "waiting_agent";
  const steer = { id: "active-steer-restart", prompt: "恢复这条 steer", agentId: "claude-fable", queuedAt: new Date().toISOString() };
  run.pendingSteer = [steer];
  const request = await orchestrator.appendBus(run, {
    id: `steer:${createHash("sha256").update(steer.id).digest("hex")}`,
    from: "lo",
    to: "claude-fable",
    kind: "steer",
    text: steer.prompt,
    refs: { queuedSteerId: steer.id },
  });
  run.activeSteer = {
    steerId: steer.id,
    busMessageId: request.id,
    to: "claude-fable",
    priorMaxRounds: run.maxRounds,
    maxRounds: run.maxRounds,
    claimedAt: new Date().toISOString(),
  };
  await orchestrator.save(run);

  restarted = await restartFixtureOrchestrator(fx);
  const terminal = await waitTerminal(restarted, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  assert.deepEqual(terminal.pendingSteer, []);
  assert.equal(terminal.activeSteer, null);
  const messages = await new BusStore({ dataRoot: root }).read(run.id);
  assert.equal(messages.filter((item) => item.kind === "steer" && item.refs?.queuedSteerId === steer.id).length, 1);
});

test("explicit answer claim blocks legacy promotion and CAS preserves a newer ask", async (t) => {
  const fx = await fixture({ "claude-fable": ["unused"] });
  const { root, orchestrator } = fx;
  t.after(async () => {
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({
    prompt: "answer claim CAS",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const run = orchestrator.get(created.id);
  run.status = "waiting_agent";
  const ask1 = await orchestrator.appendBus(run, { from: "claude-fable", to: "lo", kind: "ask", text: "ask one" });
  run.pendingAsk = { id: ask1.id, from: ask1.from, text: ask1.text, at: ask1.ts };
  run.pausedForInput = true;
  run.pendingSteer = [{ id: "legacy-answer", prompt: "legacy", agentId: "claude-fable", answerCandidate: true }];
  await orchestrator.save(run);

  const oldExecution = deferred();
  orchestrator.executions.set(created.id, oldExecution.promise);
  const explicit = orchestrator.resumePendingAsk(created.id, "explicit", { answerToAskId: ask1.id });
  assert.equal(await orchestrator.promoteQueuedAnswer(run), false, "legacy promotion must yield to the explicit answer claim");
  const ask2 = await orchestrator.appendBus(run, { from: "claude-fable", to: "lo", kind: "ask", text: "ask two" });
  run.pendingAsk = { id: ask2.id, from: ask2.from, text: ask2.text, at: ask2.ts };
  run.pausedForInput = true;
  await orchestrator.save(run);
  oldExecution.resolve();
  await assert.rejects(explicit, { code: "ASK_MISMATCH" });
  orchestrator.executions.delete(created.id);
  assert.equal(run.pendingAsk?.id, ask2.id, "a stale answer claimant must not clear the newer ask");
  const messages = await new BusStore({ dataRoot: root }).read(created.id);
  assert.equal(messages.filter((item) => item.kind === "answer" && item.refs?.answerToAskId === ask1.id).length, 0);
});

test("cancel aborts the provider before a slow approval broker can yield", async (t) => {
  const fx = await fixture({ "claude-fable": ["unused", "must not run"] });
  const { root, calls, orchestrator } = fx;
  t.after(async () => {
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const turn = deferFirstTurn(fx, "claude-fable", "provider completed after cancellation");
  const brokerEntered = deferred();
  const brokerRelease = deferred();
  orchestrator.approvalBroker.denyRun = async () => {
    brokerEntered.resolve();
    await brokerRelease.promise;
  };
  const created = await orchestrator.create({
    prompt: "cancel ordering",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  await turn.started;
  const cancelling = orchestrator.cancel(created.id);
  await brokerEntered.promise;
  assert.equal(orchestrator.controllers.get(created.id)?.signal.aborted, true);
  assert.equal(orchestrator.get(created.id).status, "cancelled");
  turn.release();
  await orchestrator.executions.get(created.id);
  assert.equal(orchestrator.get(created.id).status, "cancelled");
  assert.equal(calls.length, 1, "an aborted social loop must not dispatch its final convergence turn");
  brokerRelease.resolve();
  const cancelled = await cancelling;
  assert.equal(cancelled.status, "cancelled");
});

test("new intent contract rejects answer without ownership and contradictory steer", async (t) => {
  const { root, orchestrator } = await fixture({ "claude-fable": ["unused"] });
  t.after(async () => {
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = await orchestrator.create({ prompt: "intent validation", execute: false, permissionMode: "plan" });
  await assert.rejects(
    () => orchestrator.continue(created.id, { prompt: "answer", messageIntent: "answer" }),
    { code: "VALIDATION_FAILED" },
  );
  await assert.rejects(
    () => orchestrator.continue(created.id, { prompt: "steer", messageIntent: "steer", answerToAskId: "ask-1" }),
    { code: "VALIDATION_FAILED" },
  );
});

test("social mode persists bus intent before the first append", async (t) => {
  const { root, orchestrator } = await fixture({
    "claude-fable": ["直接给出最终答复"],
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalAppend = orchestrator.bus.append.bind(orchestrator.bus);
  let beforeFirstAppend = null;
  orchestrator.bus.append = async (runId, message) => {
    if (!beforeFirstAppend && message.kind === "task") {
      beforeFirstAppend = JSON.parse(await readFile(resolve(root, "runs", `${runId}.json`), "utf8"));
    }
    return originalAppend(runId, message);
  };

  const run = await orchestrator.create({
    prompt: "验证 bus 写前审计标记",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  assert.ok(beforeFirstAppend?.busExpectedAt, "write-ahead marker must be durable before append starts");
  assert.equal(beforeFirstAppend?.busMaterializedAt, undefined);
});

test("social mode honors startAgentId (leader is not the mandatory entry)", async (t) => {
  const { root, calls, orchestrator } = await fixture({
    "codex-technical": ["直接开干。"],
    "claude-fable": ["最终综合答复"],
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await orchestrator.create({ prompt: "技术任务", execute: true, permissionMode: "plan", teamId: "team-514cc", orchestrationMode: "social", startAgentId: "codex-technical" });
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  // 首轮直接给指定成员；只有它一个发言 → 不再派 leader 收敛轮（LO 点某个成员对话时，
  // leader 插一轮"综合"是零信息增量的冗余轮）
  assert.deepEqual(calls.map((call) => call.id), ["codex-technical"]);
  assert.equal(terminal.executionOwnerId, "codex-technical");
  assert.ok(calls.every((call) => call.permissionMode === "plan"));
});

test("social Build validates and assigns workspace-write to the explicit direct recipient", async (t) => {
  const { root, calls, orchestrator } = await fixture({
    "claude-fable": ["已按批准执行。", "最终综合。"],
    "codex-technical": ["不应获得写权限。"],
  });
  t.after(async () => { await orchestrator.close(); await rm(root, { recursive: true, force: true }); });
  const run = await orchestrator.create({
    prompt: "明确交给 Claude 写入",
    execute: true,
    permissionMode: "build",
    teamId: "team-514cc",
    orchestrationMode: "social",
    startAgentId: "claude-fable",
    maxRounds: 8,
  });
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  assert.equal(terminal.route.selected.id, "claude-fable");
  assert.equal(terminal.executionOwnerId, "claude-fable");
  assert.equal(calls[0].id, "claude-fable");
  assert.equal(calls[0].permissionMode, "workspace-write");
  assert.equal(calls.some((call) => call.id === "codex-technical" && call.permissionMode === "workspace-write"), false);
});

test("an explicit startAgentId outside the team fails closed instead of silently retargeting", async (t) => {
  const { root, calls, orchestrator } = await fixture({ "claude-fable": ["不应执行"] });
  t.after(async () => {
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    () => orchestrator.create({
      prompt: "这条消息只能发给显式目标",
      execute: true,
      permissionMode: "plan",
      teamId: "team-514cc",
      orchestrationMode: "social",
      startAgentId: "outside-agent",
    }),
    { code: "NOT_TEAM_MEMBER" },
  );
  assert.equal(calls.length, 0, "an invalid explicit target must never reach the coordinator as a fallback");
  assert.equal(orchestrator.list().length, 0, "a rejected target must not leave a retargeted run behind");
});

test("the active direct target stays first when requestedAgentIds adds collaborators", async (t) => {
  const { root, calls, orchestrator } = await fixture({
    "codex-technical": ["直接目标先执行"],
    "claude-fable": ["协作者意见", "主脑最终收敛"],
  });
  t.after(async () => {
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });

  const run = await orchestrator.create({
    prompt: "直接交给 Codex，并 @ Claude 协作",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
    startAgentId: "codex-technical",
    requestedAgentIds: ["claude-fable"],
    maxRounds: 8,
  });
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  assert.deepEqual(
    calls.map((call) => call.id),
    ["codex-technical", "claude-fable", "claude-fable"],
    "@ collaborators must extend the dispatch set without replacing the active direct target",
  );
  const tasks = (await new BusStore({ dataRoot: root }).read(run.id)).filter((message) => message.kind === "task");
  assert.deepEqual(tasks.map((message) => message.to), ["codex-technical", "claude-fable"]);
});

test("structured multi-mention validates team ownership, mode and stable ordering", async (t) => {
  const { root, orchestrator } = await fixture({ "claude-fable": ["preview"] });
  t.after(async () => { await orchestrator.close(); await rm(root, { recursive: true, force: true }); });

  await assert.rejects(
    () => orchestrator.create({ prompt: "bad shape", execute: false, permissionMode: "plan", teamId: "team-514cc", requestedAgentIds: "codex-technical" }),
    { code: "VALIDATION_FAILED" },
  );
  await assert.rejects(
    () => orchestrator.create({ prompt: "outsider", execute: false, permissionMode: "plan", teamId: "team-514cc", requestedAgentIds: ["outside-agent"] }),
    { code: "NOT_TEAM_MEMBER" },
  );
  await assert.rejects(
    () => orchestrator.create({ prompt: "legacy mode", execute: false, permissionMode: "plan", teamId: "team-514cc", orchestrationMode: "pipeline", requestedAgentIds: ["codex-technical"] }),
    { code: "VALIDATION_FAILED" },
  );
  for (const budget of [{ maxStepsPerInteraction: 4 }, { maxRounds: 4 }]) {
    await assert.rejects(
      () => orchestrator.create({
        prompt: "insufficient social budget",
        execute: false,
        permissionMode: "plan",
        teamId: "team-514cc",
        requestedAgentIds: ["codex-technical", "claude-fable"],
        orchestrationMode: "social",
        ...budget,
      }),
      { code: "INSUFFICIENT_ROUNDS", minimumRounds: 5 },
    );
  }

  const preview = await orchestrator.create({
    prompt: "dedupe mentions",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    requestedAgentIds: ["codex-technical", "codex-technical", "claude-fable"],
    orchestrationMode: "social",
    maxStepsPerInteraction: 5,
  });
  assert.deepEqual(preview.requestedAgentIds, ["codex-technical", "claude-fable"]);
  assert.equal(preview.startAgentId, "codex-technical");
  assert.equal(preview.maxStepsPerInteraction, 5);
  assert.equal(preview.maxRounds, 5);
});

test("structured multi-mention dispatches every explicit target before leader finalization", async (t) => {
  const { root, calls, orchestrator } = await fixture({
    "claude-fable": ["规划意见", "最终综合"],
    "codex-technical": ["技术意见"],
  });
  t.after(async () => { await orchestrator.close(); await rm(root, { recursive: true, force: true }); });

  const run = await orchestrator.create({
    prompt: "请两位分别评估",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
    requestedAgentIds: ["claude-fable", "codex-technical"],
    maxRounds: 8,
  });
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  assert.deepEqual(calls.map((call) => call.id), ["claude-fable", "codex-technical", "claude-fable"]);
  const tasks = (await new BusStore({ dataRoot: root }).read(run.id)).filter((message) => message.kind === "task");
  assert.deepEqual(tasks.map((message) => message.to), ["claude-fable", "codex-technical"]);
  const mention = terminal.taskGraph.delegations.find((edge) => edge.kind === "mention" && edge.toAgentId === "codex-technical");
  assert.equal(mention?.fromAgentId, "lo");
  assert.equal(mention?.state, "completed");
  assert.ok(mention?.targetAttemptId);
  const mentionTask = terminal.taskGraph.tasks.find((task) => task.busMessageId === mention.busMessageId);
  assert.equal(mentionTask?.status, "succeeded");
  assert.equal(mentionTask?.attemptId, mention.targetAttemptId);
});

test("multi-mention restart rebuilds an empty durable queue and preserves order", async (t) => {
  const fixtureState = await fixture({
    "claude-fable": ["规划意见", "最终综合"],
    "codex-technical": ["技术意见"],
  });
  const { root, calls, orchestrator } = fixtureState;
  let restarted;
  t.after(async () => {
    await restarted?.close();
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const preview = await orchestrator.create({
    prompt: "restart fanout",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
    requestedAgentIds: ["codex-technical", "claude-fable"],
    maxRounds: 8,
  });
  await orchestrator.close();
  const runPath = resolve(root, "runs", `${preview.id}.json`);
  const persisted = JSON.parse(await readFile(runPath, "utf8"));
  Object.assign(persisted, {
    execute: true,
    status: "queued",
    result: null,
    round: 0,
    turns: [],
    turnAttempts: [],
    resumeQueue: [],
    resumeClaim: null,
  });
  await writeFile(runPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

  restarted = await restartFixtureOrchestrator(fixtureState);
  const terminal = await waitTerminal(restarted, preview.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  assert.deepEqual(calls.map((call) => call.id), ["codex-technical", "claude-fable", "claude-fable"]);
  assert.deepEqual(terminal.requestedAgentIds, ["codex-technical", "claude-fable"]);
  assert.ok(terminal.taskGraph.delegations.some((edge) => edge.kind === "mention" && edge.toAgentId === "claude-fable"));
  assert.ok(terminal.taskGraph.delegations.every((edge) => edge.fromAgentId !== edge.toAgentId), "explicit mention graph cannot create a leader self-edge");
});

test("social mode drops ping-pong directives beyond 2 hops instead of looping forever", async (t) => {
  const ping = { "claude-fable": ["[[msg:codex-technical]] 再看"], "codex-technical": ["[[msg:claude-fable]] 回你"] };
  const { root, calls, orchestrator } = await fixture({
    "claude-fable": ["[[msg:codex-technical]] 再看", "[[msg:codex-technical]] 再看", "[[msg:codex-technical]] 再看", "收敛答复"],
    "codex-technical": ["[[msg:claude-fable]] 回你", "[[msg:claude-fable]] 回你", "[[msg:claude-technical]] 回你"],
  });
  void ping;
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await orchestrator.create({ prompt: "互相检验", execute: true, permissionMode: "plan", teamId: "team-514cc", orchestrationMode: "social", maxRounds: 8 });
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  // f>c 第 3 跳被丢弃、收敛轮兜底：总轮数有限且不 failed
  assert.ok(calls.length <= 8, `calls=${calls.length}`);
  const bus = new BusStore({ dataRoot: root });
  const messages = await bus.read(run.id);
  assert.ok(messages.some((message) => message.kind === "system" && message.text.includes("往返已超 2 轮")));
  assert.ok(messages.some((message) => message.kind === "decide"));
});

test("pipeline is the default orchestration mode; social requires explicit opt-in", async (t) => {
  const { root, orchestrator } = await fixture({
    "claude-fable": ["直接答复。"],
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await orchestrator.create({ prompt: "默认模式验证", execute: false, permissionMode: "plan", teamId: "team-514cc" });
  assert.equal(run.orchestrationMode, "pipeline");
  assert.equal(run.socialContract.optedIn, false);
  const social = await orchestrator.create({
    prompt: "显式社会模拟",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  assert.equal(social.orchestrationMode, "social");
  assert.equal(social.socialContract.optedIn, true);
  assert.equal(social.socialContract.pingPongLimit, 2);
});

test("ask/answer: [[msg:lo]] pauses the run and continue() resumes back to the asker", async (t) => {
  const { root, calls, orchestrator, events } = await fixture({
    "claude-fable": ["有个问题要先拍板。\n[[msg:lo]] 预算上限给多少？", "收到回答，继续推进完成。", "最终答复：全部完成。"],
  });
  t.after(async () => {
    await orchestrator.close();
    await rm(root, { recursive: true, force: true });
  });
  const run = await orchestrator.create({ prompt: "做个需要拍板的任务", execute: true, permissionMode: "plan", teamId: "team-514cc", orchestrationMode: "social", maxRounds: 8 });
  // 标准 ask/answer 用例等待完整泊车边界；窗口期抢答由后面的 ownership-gate 用例单独覆盖。
  const paused = await waitPausedForInput(orchestrator, run.id);
  assert.equal(paused.status, "waiting_agent", `expected waiting_agent, got ${paused.status} (${paused.error ?? "no error"})`);
  assert.equal(paused.pendingAsk?.from, "claude-fable");
  assert.ok(paused.pendingAsk?.id);
  const askId = paused.pendingAsk.id;
  assert.ok(events.some((event) => event.type === "run.waiting_input"));
  // LO 回答 → 恢复主循环：回答轮给发问者（单成员会话不再追加冗余 leader 收敛轮）
  await orchestrator.continue(run.id, { prompt: "预算给 2 刀" });
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  assert.equal(terminal.pendingAsk, null);
  assert.deepEqual(calls.map((call) => call.id), ["claude-fable", "claude-fable"]);
  assert.ok(calls[1].prompt.includes("预算给 2 刀")); // 回答进快照
  const bus = new BusStore({ dataRoot: root });
  const messages = await bus.read(run.id);
  assert.ok(messages.some((message) => message.kind === "ask" && message.to === "lo"));
  assert.ok(messages.some((message) => message.kind === "answer" && message.from === "lo" && message.refs?.answerToAskId === askId));
  // 恢复后的答复以 say 落 bus；decide 只在真跑 leader 收敛轮时才有（前端不消费 decide）
  assert.ok(messages.some((message) => message.kind === "say" && message.text.includes("继续推进完成")));
});

test("one provider turn accepts only one [[msg:lo]] ask", async (t) => {
  const { root, orchestrator, events } = await fixture({
    "claude-fable": ["先停一下。\n[[msg:lo]] 第一个问题\n[[msg:lo]] 第二个问题不得入总线"],
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await orchestrator.create({
    prompt: "多 ask fail closed",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const paused = await waitPausedForInput(orchestrator, run.id);
  assert.equal(paused.pendingAsk?.text, "第一个问题");
  const messages = await new BusStore({ dataRoot: root }).read(run.id);
  assert.deepEqual(messages.filter((item) => item.kind === "ask").map((item) => item.text), ["第一个问题"]);
  assert.ok(events.some((item) => item.type === "run.directive_rejected" && item.data.reason === "MULTIPLE_LO_ASKS"));
  await orchestrator.cancel(run.id);
});

test("answer append EIO keeps pendingAsk ownership intact", async (t) => {
  const { root, orchestrator } = await fixture({
    "claude-fable": ["[[msg:lo]] 需要确认"],
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await orchestrator.create({
    prompt: "answer durable ownership",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
  });
  const paused = await waitPausedForInput(orchestrator, run.id);
  const before = structuredClone(paused.pendingAsk);
  const originalAppend = orchestrator.bus.append.bind(orchestrator.bus);
  orchestrator.bus.append = async (runId, message) => {
    if (message.kind === "answer") throw Object.assign(new Error("answer bus EIO"), { code: "EIO" });
    return originalAppend(runId, message);
  };
  await assert.rejects(
    () => orchestrator.continue(run.id, { prompt: "不会丢的回答", answerToAskId: before.id }),
    { code: "EIO" },
  );
  orchestrator.bus.append = originalAppend;
  const after = orchestrator.get(run.id);
  assert.deepEqual(after.pendingAsk, before);
  assert.equal(after.pausedForInput, true);
  assert.equal(after.status, "waiting_agent");
  assert.equal(orchestrator.askClaims.has(run.id), false);
  assert.equal(orchestrator.controllers.has(run.id), false);
  const messages = await new BusStore({ dataRoot: root }).read(run.id);
  assert.ok(!messages.some((item) => item.kind === "answer" && item.text === "不会丢的回答"));
  await orchestrator.cancel(run.id);
});

const MODELS_REGISTRY = {
  profiles: [
    { id: "claude-fable", adapter: "claude-stream-json", modelOptions: [{ id: "", label: "默认" }, { id: "claude-opus-4-8", label: "opus" }] },
    { id: "codex-technical", adapter: "codex-app-server", modelOptions: [{ id: "", label: "默认" }, { id: "gpt-5-codex", label: "codex" }] },
  ],
};

test("/model override validates against the start agent's catalog and reaches its turns", async (t) => {
  const { root, calls, orchestrator } = await fixture(
    { "codex-technical": ["直接开干。"], "claude-fable": ["收敛。"] },
    { models: MODELS_REGISTRY },
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await orchestrator.create({
    prompt: "模型覆盖", execute: true, permissionMode: "plan", teamId: "team-514cc",
    orchestrationMode: "social", startAgentId: "codex-technical", model: "gpt-5-codex",
  });
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  const codexCalls = calls.filter((call) => call.id === "codex-technical");
  assert.ok(codexCalls.length && codexCalls.every((call) => call.model === "gpt-5-codex"), JSON.stringify(codexCalls));
  const claudeCalls = calls.filter((call) => call.id === "claude-fable");
  assert.ok(claudeCalls.every((call) => call.model === null), "收敛轮不受起始 agent 覆盖影响");
  // 非目录内模型被拒（claude 模型串给 codex 起始 → INVALID_MODEL）
  await assert.rejects(
    () => orchestrator.create({ prompt: "x", execute: false, permissionMode: "plan", teamId: "team-514cc", orchestrationMode: "social", startAgentId: "codex-technical", model: "claude-opus-4-8" }),
    (error) => error.code === "INVALID_MODEL",
  );
});

test("memo blackboard: [[memo]] becomes visible in every later agent's snapshot", async (t) => {
  const { root, calls, orchestrator } = await fixture({
    "claude-fable": ["先说结论。\n[[memo]] 关键结论X：路由层不能有单点\n[[msg:codex-technical]] 你基于结论评估", "收敛。"],
    "codex-technical": ["评估完毕。"],
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await orchestrator.create({ prompt: "黑板验证", execute: true, permissionMode: "plan", teamId: "team-514cc", orchestrationMode: "social" });
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  assert.ok(calls[1].prompt.includes("关键结论X"), "codex 的 prompt 快照里没有 memo");
  const bus = new BusStore({ dataRoot: root });
  const messages = await bus.read(run.id);
  assert.ok(messages.some((message) => message.kind === "memo" && message.text.includes("关键结论X")));
});

test("build run isolates writes into a git worktree (P3)", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { root, calls, orchestrator } = await fixture({
    "claude-fable": ["计划。\n[[msg:codex-technical]] 去写", "收敛。"],
    "codex-technical": ["已写入。"],
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = resolve(root, "repo");
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "qa@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "QA"]);
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"]);
  const run = await orchestrator.create({
    prompt: "build 写入", execute: true, permissionMode: "build", teamId: "team-514cc",
    orchestrationMode: "social", cwd: repo, maxRounds: 6,
  });
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  assert.ok(terminal.worktreePath, "worktreePath 未生成");
  assert.ok(terminal.worktreePath.startsWith(resolve(root, "")), `worktree 不在预期位置：${terminal.worktreePath}`);
  const { stat } = await import("node:fs/promises");
  assert.ok((await stat(terminal.worktreePath)).isDirectory());
  const writeCall = calls.find((call) => call.id === "codex-technical" && call.permissionMode === "workspace-write");
  assert.ok(writeCall, "没有写盘轮");
  assert.equal(writeCall.cwd, terminal.worktreePath); // 写盘轮 cwd=隔离 worktree，真实 repo 零污染
  // 烛致命10：清除 run 一并回收 worktree（git worktree remove）
  const worktreePath = terminal.worktreePath;
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 100)); // 等收尾协程释放
  const { cleared } = await orchestrator.clearFinished();
  assert.ok(cleared >= 1, "run 未被清除");
  await assert.rejects(() => stat(worktreePath), { code: "ENOENT" }, "worktree 未随 run 清除回收");
});

// 烛 v3.6 致命7：常驻型适配器（codex app-server）cwd 固定，无法真正切进 worktree——
// 有 worktree 的写盘轮派给不支持 per-turn cwd 的适配器必须 fail-closed，绝不静默写错目录
test("write turns fail closed when the adapter cannot honor the worktree cwd", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { root, calls, orchestrator } = await fixture({
    "claude-fable": ["计划。\n[[msg:codex-technical]] 去写", "收敛。"],
    "codex-technical": ["已写入。"],
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  // 模拟常驻型：撤掉 supportsPerTurnCwd 声明
  delete orchestrator.adapters.get("codex-technical").supportsPerTurnCwd;
  const repo = resolve(root, "repo-resident");
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "qa@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "QA"]);
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"]);
  const run = await orchestrator.create({
    prompt: "常驻适配器写盘", execute: true, permissionMode: "build", teamId: "team-514cc",
    orchestrationMode: "social", cwd: repo, maxRounds: 6,
  });
  const settled = await waitRecoveryOrTerminal(orchestrator, run.id);
  assert.equal(settled.status, "recovery_required", `期望保留 durable claim 并 fail-closed，得到 ${settled.status}`);
  assert.match(settled.error ?? "", /cannot honor per-turn cwd/);
  assert.ok(settled.resumeClaim?.itemId, "rejected write turn lost its durable route claim");
  assert.ok(settled.resumeQueue.some((item) => item.itemId === settled.resumeClaim.itemId));
  assert.equal(calls.filter((call) => call.id === "codex-technical").length, 0, "unsupported write adapter reached provider dispatch");
});

// ===== LO 2026-08-14 报障（run d63b839d）：协作台对话逻辑四条根因的反例闸 =====
// 现象：新建会话点成员对话 → ①只说「你好」，系统自己派了第 2 轮官腔收敛（见上方 social
// 默认模式/startAgentId 用例的轮数断言）②同一句话被回答两遍且结论互相矛盾 ③说「请你继续
// 执行」它反复要授权、永不动手 ④第 5 轮一片空白。②③④ 的闸如下。

test("续轮沿用建 run 时批过的写权限——直发续聊不再被降成只读", async (t) => {
  const { root, calls, orchestrator } = await fixture({ "claude-fable": ["首轮已执行。", "续轮已执行。"] });
  t.after(async () => { await orchestrator.close(); await rm(root, { recursive: true, force: true }); });
  const run = await orchestrator.create({
    prompt: "先做第一步",
    execute: true,
    permissionMode: "build",
    teamId: "team-514cc",
    orchestrationMode: "social",
    startAgentId: "claude-fable",
    maxRounds: 6,
  });
  const first = await waitTerminal(orchestrator, run.id);
  assert.equal(first.status, "succeeded", first.error);
  assert.equal(calls[0].permissionMode, "workspace-write");
  await orchestrator.continue(run.id, { prompt: "请你继续执行", agentId: "claude-fable", messageIntent: "steer" });
  const continued = await waitTerminal(orchestrator, run.id);
  assert.equal(continued.status, "succeeded", continued.error);
  // 这一条就是 LO 撞的死循环：审批/租约/工作树全就绪却只给 plan，成员只能反复回
  // 「请确认是否要我立即执行」，指令与权限两端一起锁死
  assert.equal(calls.at(-1).permissionMode, "workspace-write", "直发续轮仍被降级为只读");
});

test("排队插话（轮间边界送达）同样沿用批过的写权限", async (t) => {
  const fx = await fixture({ "claude-fable": ["插话轮已执行。"] });
  const { root, calls, orchestrator } = fx;
  t.after(async () => { await orchestrator.close(); await rm(root, { recursive: true, force: true }); });
  const gate = deferFirstTurn(fx, "claude-fable", "首轮已执行。");
  const run = await orchestrator.create({
    prompt: "先做第一步",
    execute: true,
    permissionMode: "build",
    teamId: "team-514cc",
    orchestrationMode: "social",
    startAgentId: "claude-fable",
    maxRounds: 6,
  });
  await gate.started;
  await orchestrator.continue(run.id, { prompt: "顺手把第二步也做掉", agentId: "claude-fable", messageIntent: "steer" });
  gate.release();
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  const steerCall = calls.find((call) => call.prompt === "顺手把第二步也做掉");
  assert.ok(steerCall, "排队插话没有派出去");
  assert.equal(steerCall.permissionMode, "workspace-write", "排队插话轮被降级为只读");
});

test("续轮授权链失效时降级只读并明确播报，而不是把整轮打死", async (t) => {
  const { root, calls, orchestrator, events } = await fixture({ "claude-fable": ["首轮已执行。", "本轮只读。"] });
  t.after(async () => { await orchestrator.close(); await rm(root, { recursive: true, force: true }); });
  const run = await orchestrator.create({
    prompt: "先做第一步",
    execute: true,
    permissionMode: "build",
    teamId: "team-514cc",
    orchestrationMode: "social",
    startAgentId: "claude-fable",
    maxRounds: 6,
  });
  const first = await waitTerminal(orchestrator, run.id);
  assert.equal(calls[0].permissionMode, "workspace-write");
  // 模拟租约到期/被吊销：预检拿不到授权 → 只读续跑 + 播报，绝不静默（安全底座禁 silent fallback）
  const live = orchestrator.get(run.id);
  live.buildApproval.lease.status = "revoked";
  await orchestrator.save(live);
  await orchestrator.continue(run.id, { prompt: "继续执行", agentId: "claude-fable", messageIntent: "steer" });
  const continued = await waitTerminal(orchestrator, run.id);
  assert.equal(continued.status, "succeeded", continued.error); // 降级可继续，不是 POLICY_VIOLATION
  assert.equal(calls.at(-1).permissionMode, "plan");
  const degraded = events.filter((event) => event.type === "run.write_degraded");
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0].data.reason, "CAPABILITY_LEASE_INACTIVE");
  assert.equal(degraded[0].data.agentId, "claude-fable");
});

test("同一条未消费的消息重复提交被幂等门拦住；已消费后的重发照常放行", async (t) => {
  const fx = await fixture({ "claude-fable": ["插话轮。", "重发轮。"] });
  const { root, calls, orchestrator } = fx;
  t.after(async () => { await orchestrator.close(); await rm(root, { recursive: true, force: true }); });
  const gate = deferFirstTurn(fx, "claude-fable", "首轮已执行。");
  const run = await orchestrator.create({
    prompt: "任务",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
    startAgentId: "claude-fable",
    maxRounds: 8,
  });
  await gate.started;
  await orchestrator.continue(run.id, { prompt: "同一句话", agentId: "claude-fable", messageIntent: "steer" });
  try {
    // 客户端在途锁被 UI 同步冲掉时的第二次提交：拦住，否则同一句话派两轮、各烧一轮预算
    await assert.rejects(
      () => orchestrator.continue(run.id, { prompt: "同一句话", agentId: "claude-fable", messageIntent: "steer" }),
      (error) => error.code === "DUPLICATE_MESSAGE",
    );
  } finally {
    gate.release(); // 断言失败也必须放行首轮，否则 t.after 的 close() 会等一个永不结束的 turn
  }
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  assert.equal(calls.filter((call) => call.prompt === "同一句话").length, 1, "同一句话被派了不止一轮");
  // 已经被回答过之后，LO 有意重发同一句话是合法的——幂等门只拦「还没被处理」的重复
  await orchestrator.continue(run.id, { prompt: "同一句话", agentId: "claude-fable", messageIntent: "steer" });
  assert.equal(calls.filter((call) => call.prompt === "同一句话").length, 2, "已消费的重发被误拦");
});

test("social durable claim 遇到 cancelled 时进入 recovery_required，不伪造完成", async (t) => {
  const { root, orchestrator, events } = await fixture({ "claude-fable": ["unused"] });
  t.after(async () => { await orchestrator.close(); await rm(root, { recursive: true, force: true }); });
  const adapter = orchestrator.adapters.get("claude-fable");
  adapter.send = async (input) => {
    await input.onSessionStarted?.({ sessionId: "cancelled-session" });
    // Grok 现场形态：exit 0 + partial text + stopReason=cancelled（reasoning/token 已计费）
    return { sessionId: "cancelled-session", text: "开始处理，但写工具未获授权。", protocol: "mock", stopReason: "cancelled", tokens: 443, costUsd: 0.01 };
  };
  const run = await orchestrator.create({
    prompt: "会被中断的任务",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
    startAgentId: "claude-fable",
    maxRounds: 6,
  });
  const first = await waitRecoveryOrTerminal(orchestrator, run.id);
  assert.equal(first.status, "recovery_required", first.error);
  assert.equal(first.turnAttempts.at(-1).phase, "failed");
  assert.equal(first.turns.at(-1).outcome, "incomplete");
  assert.equal(first.turns.at(-1).text, "开始处理，但写工具未获授权。");
  assert.equal(first.turns.at(-1).tokens, 443);
  const unproductive = events.filter((event) => event.type === "agent.turn_unproductive");
  assert.equal(unproductive.length, 1, "异常收束轮没有如实播报");
  assert.equal(unproductive[0].data.reason, "ABNORMAL_STOP");
  assert.equal(unproductive[0].data.stopReason, "cancelled");
  assert.equal(unproductive[0].data.hasPartialOutput, true);
  assert.equal(events.some((event) => event.type === "agent.turn_completed"), false, "cancelled 轮仍写了 turn_completed");
  assert.equal(events.some((event) => event.type === "run.completed"), false, "cancelled 轮仍把根任务写成成功");
  // partial text 只留诊断记录，不进 team bus 冒充交付
  const messages = await new BusStore({ dataRoot: root }).read(run.id);
  assert.equal(messages.some((message) => message.kind === "say" && message.text.includes("写工具未获授权")), false);
});

test("无 durable claim 的直发续轮遇到零文本时进入 failed，轮次不退还", async (t) => {
  const { root, orchestrator, events } = await fixture({ "claude-fable": ["首轮正常完成。"] });
  t.after(async () => { await orchestrator.close(); await rm(root, { recursive: true, force: true }); });
  const run = await orchestrator.create({
    prompt: "先正常执行一轮",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
    startAgentId: "claude-fable",
    maxRounds: 6,
  });
  const first = await waitTerminal(orchestrator, run.id);
  assert.equal(first.status, "succeeded", first.error);
  const adapter = orchestrator.adapters.get("claude-fable");
  adapter.send = async (input) => {
    await input.onSessionStarted?.({ sessionId: "empty-session" });
    return { sessionId: "empty-session", text: "", protocol: "mock", stopReason: "end_turn", tokens: 19, costUsd: 0.01 };
  };
  await assert.rejects(
    () => orchestrator.continue(run.id, { prompt: "继续", agentId: "claude-fable", messageIntent: "steer" }),
    { code: "PROVIDER_TURN_INCOMPLETE" },
  );
  const failed = orchestrator.get(run.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.round, 2, "provider 已执行并计费的轮次被错误退还");
  assert.equal(failed.turnAttempts.at(-1).phase, "failed");
  assert.equal(failed.turns.at(-1).outcome, "incomplete");
  const unproductive = events.filter((event) => event.type === "agent.turn_unproductive").at(-1);
  assert.equal(unproductive.data.reason, "EMPTY_OUTPUT");
  assert.equal(unproductive.data.hasPartialOutput, false);
  assert.equal(events.filter((event) => event.type === "agent.turn_completed").length, 1, "异常续轮仍写了 turn_completed");
});

test("socialFinalizationWorthwhile：只有第二个成员发过言才值得烧 leader 收敛轮", async (t) => {
  const { root, orchestrator } = await fixture({ "claude-fable": ["unused"] });
  t.after(async () => { await orchestrator.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(orchestrator.socialFinalizationWorthwhile({ turns: [] }), false);
  assert.equal(orchestrator.socialFinalizationWorthwhile({ turns: [{ agentId: "a" }] }), false);
  assert.equal(orchestrator.socialFinalizationWorthwhile({ turns: [{ agentId: "a" }, { agentId: "a" }] }), false);
  assert.equal(orchestrator.socialFinalizationWorthwhile({ turns: [{ agentId: "a" }, { agentId: "b" }] }), true);
  assert.equal(orchestrator.socialFinalizationWorthwhile({ turns: [{ agentId: null }, { agentId: "a" }] }), false);
});

import { parseCodexCatalog, parseGrokCatalog } from "../src/model-discovery.mjs";

test("parseCodexCatalog maps codex debug models JSON (slug/display_name/reasoning levels)", () => {
  const raw = JSON.stringify({
    models: [
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        default_reasoning_level: "low",
        visibility: "list",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }],
      },
      { slug: "gpt-hidden", display_name: "Hidden", visibility: "hidden" },
    ],
  });
  const result = parseCodexCatalog(raw);
  assert.deepEqual(result.models, [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", defaultReasoning: "low" }]);
  assert.deepEqual(result.effortLevels, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(result.defaultModel, "gpt-5.6-sol");
});

test("parseGrokCatalog parses text list with default marker", () => {
  const result = parseGrokCatalog("Default model: grok45-514\n\nAvailable models:\n  * grok45-514 (default)\n  - grok43-long\n");
  assert.deepEqual(result.models, [
    { id: "grok45-514", label: "grok45-514（默认）" },
    { id: "grok43-long", label: "grok43-long" },
  ]);
  assert.equal(result.defaultModel, "grok45-514");
});

// ask 立即停止当前 interaction；LO 的回答开启新 interaction，冻结的同轮成员路由和最终收敛
// 都从新预算继续，不再与提问前的全会话 round 争最后一个名额。
test("an answer starts a fresh interaction and preserves routes frozen beside the ask", async (t) => {
  const { root, calls, orchestrator } = await fixture(
    {
      // 起始轮就 ask，且单 interaction 上限收得很紧；回答后的新 interaction 恰好容纳三步完整链。
      "claude-fable": ["先问一句。\n[[msg:lo]] 方向 A 还是 B？\n[[msg:codex-technical]] 你先预研", "答案收到，收敛。"],
      "codex-technical": ["预研完毕。"],
    },
    { policyOverride: { maxRounds: 3 } },
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await orchestrator.create({ prompt: "紧轮次拍板任务", execute: true, permissionMode: "plan", teamId: "team-514cc", orchestrationMode: "social", maxRounds: 4 });
  const deadline = Date.now() + 15_000;
  let paused = orchestrator.get(run.id);
  while (Date.now() < deadline && !(paused.status === "waiting_agent" && paused.pendingAsk && paused.pausedForInput)) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
    paused = orchestrator.get(run.id);
  }
  assert.ok(paused.status === "waiting_agent" && paused.pendingAsk && paused.pausedForInput, `expected a parked ask, got ${paused.status} (${paused.error ?? "no error"}) | diag=${JSON.stringify({ round: paused.round, maxRounds: paused.maxRounds, pendingAsk: paused.pendingAsk, pausedForInput: paused.pausedForInput, attempts: (paused.turnAttempts ?? []).map((a) => `${a.agentId}:${a.phase}`) })}`);
  // ask 是硬状态转换：挂起时队列剩余项（codex 预研轮）被冻结，等待下一次用户交互。
  assert.equal(paused.round, 1, `ask 后不该继续消费队列，round=${paused.round}`);
  // 关键断言：回答不被全会话累计 round 拒绝。
  await orchestrator.continue(run.id, { prompt: "方向 A" });
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  assert.equal(terminal.pendingAsk, null);
  assert.deepEqual(
    calls.map((call) => call.id),
    ["claude-fable", "claude-fable", "codex-technical", "claude-fable"],
    "the fresh answer interaction must consume the answer, run the frozen route, then finalize",
  );
});

test("social durable work restores its original interaction after an image steer", async (t) => {
  const initialImage = resolve(appRoot, "social-initial.png");
  const steerImage = resolve(appRoot, "social-steer.png");
  const { root, calls, orchestrator } = await fixture({
    "claude-fable": ["初始结论。\n[[msg:codex-technical]] 继续旧工作", "最终收敛。"],
    "codex-technical": ["图片插话已答。", "旧工作已完成。"],
  }, {
    models: { profiles: [{ id: "codex-technical", capabilities: ["image-analysis"] }] },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const claude = orchestrator.adapters.get("claude-fable");
  const originalSend = claude.send.bind(claude);
  const entered = deferred();
  const release = deferred();
  let first = true;
  claude.send = async (input) => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return originalSend(input);
  };

  const created = await orchestrator.create({
    prompt: "social 主任务",
    execute: true,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
    maxRounds: 8,
    sources: [initialImage],
  });
  await entered.promise;
  await orchestrator.continue(created.id, {
    prompt: "只看这张新图",
    agentId: "codex-technical",
    messageIntent: "steer",
    sources: [steerImage],
  });
  release.resolve();
  const terminal = await waitTerminal(orchestrator, created.id);
  assert.equal(terminal.status, "succeeded", terminal.error);

  const steerCalls = calls.filter((call) => call.prompt.includes(steerImage));
  assert.equal(steerCalls.length, 1, "新图只能进入 steer turn");
  assert.doesNotMatch(steerCalls[0].prompt, /social-initial\.png/);
  const originalWorkCalls = calls.filter((call) => call !== steerCalls[0]);
  assert.ok(originalWorkCalls.some((call) => call.id === "codex-technical" && call.prompt.includes(initialImage)), "旧 durable route 没有恢复原附件");
  for (const call of originalWorkCalls) assert.doesNotMatch(call.prompt, /social-steer\.png/);
  assert.deepEqual(terminal.activeInteractionSources.map((source) => source.path), [initialImage]);
  const steerState = Object.values(terminal.interactionStates || {}).find((state) =>
    state.sources?.some((source) => source.path === steerImage));
  assert.equal(steerState?.interactionStep, 1);
  assert.ok(terminal.interactionStep >= 2, "旧 durable work 的 interaction step 没有恢复");
});

// 烛 v3.6 致命6：两个并发 answer 曾会并行执行（一个走恢复、一个走直接续聊）
test("double answer submissions do not run concurrently (second one queues)", async (t) => {
  const { root, orchestrator } = await fixture({
    "claude-fable": ["[[msg:lo]] 拍板？", "第一个答案处理中。", "收敛。"],
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await orchestrator.create({ prompt: "双提交竞态", execute: true, permissionMode: "plan", teamId: "team-514cc", orchestrationMode: "social", maxRounds: 8 });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && orchestrator.get(run.id).status !== "waiting_agent") {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  assert.equal(orchestrator.get(run.id).status, "waiting_agent");
  // 同 tick 双提交：第一个接管恢复，第二个必须排队（pendingSteer）或被拒，绝不并行执行
  const [first, second] = await Promise.allSettled([
    orchestrator.continue(run.id, { prompt: "答案一" }),
    orchestrator.continue(run.id, { prompt: "答案二" }),
  ]);
  assert.equal(first.status, "fulfilled");
  if (second.status === "fulfilled") {
    // 本质安全属性=绝不并行执行：executions 至多一个活跃链；排队条数不是不变量
    // （极端调度下两条都可合法进 steer 队列，由 turn 边界逐条消费——照样安全）
    assert.ok(orchestrator.executions.size <= 1, `并行执行泄漏：executions=${orchestrator.executions.size}`);
  }
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.ok(["succeeded", "failed"].includes(terminal.status));
  // bus 里 answer 消息只有一条进入 resume 路由（第二条要么 steer 要么 answer 落账但不并行跑）
  const bus = new BusStore({ dataRoot: root });
  const answers = (await bus.read(run.id)).filter((message) => message.kind === "answer");
  assert.ok(answers.length >= 1);
});

// 回归：ask 挂起置位到 execute 收尾之间的窗口内提交回答，曾被垂死协程误判自然收敛写
// succeeded（pausedForInput 被 resume 清掉），resume 的 startExecution 撞 TERMINAL 早退——
// 回答被吞、run 假成功。修复=execute 收尾的协程所有权闸。此测试紧轮询在第一时间作答，
// 确定性压进该窗口；所有权闸保证回答必被消费（第 2 轮真实发生）。
test("answer submitted inside the pause-parking window is still consumed (ownership gate)", async (t) => {
  const { root, calls, orchestrator } = await fixture({
    "claude-fable": ["[[msg:lo]] 窗口期提问？", "答案收到，收敛。"],
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await orchestrator.create({ prompt: "窗口期作答竞态", execute: true, permissionMode: "plan", teamId: "team-514cc", orchestrationMode: "social", maxRounds: 8 });
  // 紧轮询：pendingAsk 一置位立刻回答——不等 execute 收尾泊进 waiting_agent
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !orchestrator.get(run.id).pendingAsk) {
    await new Promise((resolveTimer) => setImmediate(resolveTimer));
  }
  assert.ok(orchestrator.get(run.id).pendingAsk, "run 未挂起（未进入窗口场景）");
  await orchestrator.continue(run.id, { prompt: "窗口期答案" });
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  // 回答必被消费：第 2 轮真实执行（修复前被 TERMINAL 早退吞掉，calls 只有 1+收敛轮）
  const fableCalls = calls.filter((call) => call.id === "claude-fable").length;
  assert.ok(fableCalls >= 2, `回答未被消费：claude-fable 仅 ${fableCalls} 轮`);
  const bus = new BusStore({ dataRoot: root });
  const answers = (await bus.read(run.id)).filter((message) => message.kind === "answer");
  assert.equal(answers.length, 1, "回答未落 bus");
});

// 对话往返不占用自主执行额度：即使同一 agent 连续澄清，LO 的每次回答都开启新 interaction。
test("ask->answer remains available beyond two replies in the same conversation", async (t) => {
  const { root, orchestrator, events } = await fixture({
    // grok 模式复刻：每一轮都用 [[msg:lo]] 结尾
    "claude-fable": ["[[msg:lo]] 第一次提问？", "[[msg:lo]] 第二次提问？", "[[msg:lo]] 第三次提问？", "最终收敛。"],
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await orchestrator.create({ prompt: "复刻死循环", execute: true, permissionMode: "plan", teamId: "team-514cc", orchestrationMode: "social", maxRounds: 8 });
  const waitPaused = async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = orchestrator.get(run.id);
      if (current.status === "waiting_agent" && current.pendingAsk) return current;
      if (["succeeded", "failed"].includes(current.status)) return current;
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
    }
    throw new Error("run neither paused nor finished");
  };
  // 第 1 次 ask：挂起 → 回答
  let paused = await waitPaused();
  assert.equal(paused.pendingAsk?.text?.includes("第一次"), true, `status=${paused.status} error=${paused.error} ask=${JSON.stringify(paused.pendingAsk)}`);
  await orchestrator.continue(run.id, { prompt: "答一" });
  // 第 2 次 ask：仍允许（真澄清场景）→ 回答
  paused = await waitPaused();
  assert.equal(paused.pendingAsk?.text?.includes("第二次"), true);
  await orchestrator.continue(run.id, { prompt: "答二" });
  // 第 3 次 ask：仍允许回答，不因整场对话累计轮数被截断
  paused = await waitPaused();
  assert.equal(paused.pendingAsk?.text?.includes("第三次"), true);
  await orchestrator.continue(run.id, { prompt: "答三" });
  const terminal = await waitTerminal(orchestrator, run.id);
  const diag = () => JSON.stringify({
    status: terminal.status, round: terminal.round, maxRounds: terminal.maxRounds,
    interactionSeq: terminal.interactionSeq, interactionStep: terminal.interactionStep, error: terminal.error,
    events: events.map((event) => event.type),
  });
  assert.equal(terminal.status, "succeeded", `${terminal.error} | ${diag()}`);
  assert.equal(terminal.pendingAsk, null, `第三次回答后应正常收敛 | ${diag()}`);
  assert.ok(!events.some((event) => event.type === "run.ask_throttled"), `不得再产生 run 级回答限额 | ${diag()}`);
  const bus = new BusStore({ dataRoot: root });
  const messages = await bus.read(run.id);
  const asks = messages.filter((message) => message.kind === "ask");
  const answers = messages.filter((message) => message.kind === "answer");
  assert.equal(asks.length, 3, `ask 消息应恰好 3 条，得到 ${asks.length}`);
  assert.equal(answers.length, 3, `answer 消息应恰好 3 条，得到 ${answers.length}`);
});

// 当前 interaction 的已知成本回执超硬顶即停派；新用户消息可开启新预算。
test("social loop stops dispatching when the interaction cost hits its cap", async (t) => {
  const { root, orchestrator, events } = await fixture(
    {
      // 每轮互相点名（修复前会一直路由到轮顶）；单轮成本 0.5、单轮预算 0.05 → cap=0.05*8=0.4，首轮即超
      "claude-fable": ["[[msg:codex-technical]] 看看", "收敛。"],
      "codex-technical": ["[[msg:claude-fable]] 回你"],
    },
    { costUsdPerTurn: 0.5 },
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await orchestrator.create({
    prompt: "预算闸验证", execute: true, permissionMode: "plan", teamId: "team-514cc",
    orchestrationMode: "social", maxRounds: 8, maxBudgetUsdPerTurn: 0.05,
  });
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  assert.ok(terminal.costUsdTotal >= 0.4, `累计成本未入账：${terminal.costUsdTotal}`);
  assert.ok(events.some((event) => event.type === "run.budget_exhausted"), "预算耗尽事件未发");
  const bus = new BusStore({ dataRoot: root });
  const messages = await bus.read(run.id);
  assert.ok(messages.some((message) => message.kind === "system" && message.text.includes("成本")), "bus 无预算停派证据");
});

// 烛 v3.6 致命10：清除 run 必须一并回收 bus / roster（worktree 在 git e2e 里单独验证）
test("clearFinished removes the bus file and roster entries of cleared runs", async (t) => {
  const { root, orchestrator } = await fixture({
    "claude-fable": ["直接答复。"],
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await orchestrator.create({ prompt: "清理验证", execute: true, permissionMode: "plan", teamId: "team-514cc", orchestrationMode: "social" });
  await waitTerminal(orchestrator, run.id);
  const bus = new BusStore({ dataRoot: root });
  assert.ok((await bus.read(run.id)).length > 0, "前置：bus 有消息");
  const { stat } = await import("node:fs/promises");
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 100)); // 等收尾协程释放（coroutineActive 门闩）
  const { cleared } = await orchestrator.clearFinished();
  assert.ok(cleared >= 1, "run 未被清除");
  await assert.rejects(() => stat(bus.file(run.id)), { code: "ENOENT" }); // bus 文件已回收
  const roster = JSON.parse(await readFile(resolve(root, "roster.json"), "utf8"));
  const stale = Object.values(roster.agents ?? {}).filter((entry) => entry.runId === run.id);
  assert.equal(stale.length, 0, "roster 残留已清除 run 的条目");
});

test("runtime roster keeps concurrent seats for the same logical member", async (t) => {
  const { root, orchestrator } = await fixture({
    "claude-fable": ["unused"],
  });
  t.after(async () => { await orchestrator.close(); await rm(root, { recursive: true, force: true }); });
  const first = {
    id: "run-seat-first",
    sessions: { "codex-technical": "session-first" },
    teamId: "team-514cc",
    cwd: null,
    status: "running",
  };
  const second = {
    id: "run-seat-second",
    sessions: { "codex-technical": "session-second" },
    teamId: "team-514cc",
    cwd: null,
    status: "waiting_agent",
  };
  await orchestrator.registerRoster(first, "codex-technical");
  await orchestrator.registerRoster(second, "codex-technical");
  let roster = JSON.parse(await readFile(resolve(root, "roster.json"), "utf8"));
  assert.equal(roster.seats["run-seat-first:codex-technical"].sessionId, "session-first");
  assert.equal(roster.seats["run-seat-second:codex-technical"].sessionId, "session-second");
  assert.equal(roster.agents["codex-technical"].runId, "run-seat-second");

  await orchestrator.removeRosterEntries("run-seat-second");
  roster = JSON.parse(await readFile(resolve(root, "roster.json"), "utf8"));
  assert.equal(roster.seats["run-seat-second:codex-technical"], undefined);
  assert.equal(roster.seats["run-seat-first:codex-technical"].runId, "run-seat-first");
  assert.equal(roster.agents["codex-technical"].runId, "run-seat-first");
});

test("effort validation honors dynamically discovered levels (codex max/ultra)", async (t) => {
  const dynamicDiscovery = {
    forAgent: async () => ({
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }],
      effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultModel: "gpt-5.6-sol",
      source: "dynamic",
    }),
  };
  const { root, calls, orchestrator } = await fixture(
    { "codex-technical": ["开干。"], "claude-fable": ["收敛。"] },
    { models: MODELS_REGISTRY },
  );
  orchestrator.modelDiscovery = dynamicDiscovery;
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await orchestrator.create({
    prompt: "动态档位验证", execute: true, permissionMode: "plan", teamId: "team-514cc",
    orchestrationMode: "social", startAgentId: "codex-technical", model: "gpt-5.6-sol", effort: "max",
  });
  const terminal = await waitTerminal(orchestrator, run.id);
  assert.equal(terminal.status, "succeeded", terminal.error);
  assert.ok(calls.filter((c) => c.id === "codex-technical").every((c) => c.model === "gpt-5.6-sol" && c.effort === "max"));
  // 静态五档外的 ultracode 对 codex 起始仍如实拒绝
  await assert.rejects(
    () => orchestrator.create({ prompt: "x", execute: false, permissionMode: "plan", teamId: "team-514cc", orchestrationMode: "social", startAgentId: "codex-technical", effort: "ultracode" }),
    (error) => error.code === "INVALID_EFFORT",
  );
});

test("maxStepsForInteraction grants social headroom while pipeline stays clamped", async (t) => {
  const fx = await fixture({}, { policyOverride: { maxRounds: 6 } });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const orchestrator = fx.orchestrator;
  assert.equal(
    orchestrator.maxStepsForInteraction({ orchestrationMode: "social", maxStepsPerInteraction: 8 }),
    8,
    "social 不钳到 pipeline 的 policy 6",
  );
  assert.equal(
    orchestrator.maxStepsForInteraction({ orchestrationMode: "pipeline", maxStepsPerInteraction: 8 }),
    6,
    "pipeline 仍钳到 policy 6",
  );
  assert.equal(
    orchestrator.maxStepsForInteraction({ orchestrationMode: "social", maxRounds: 8 }),
    8,
    "兼容字段 maxRounds 在 social 模式同样按 headroom 放宽",
  );
});

test("social create budgets explicit targets plus headroom above pipeline clamp", async (t) => {
  const fx = await fixture({}, { policyOverride: { maxRounds: 6 } });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const orchestrator = fx.orchestrator;
  const members = ["claude-fable", "codex-technical", "kimi-frontend", "grok-build"];
  orchestrator.teams = {
    get(id) {
      if (id !== "team-514cc") throw Object.assign(new Error("not found"), { code: "SOURCE_NOT_FOUND" });
      return { id: "team-514cc", name: "514cc", coordinator: "claude-fable", members };
    },
    brief: () => "[团队配置开始] 测试团队 [结束]",
  };
  for (const id of ["kimi-frontend", "grok-build"]) {
    orchestrator.adapters.set(id, {
      cwd: fx.root,
      supportsPerTurnCwd: true,
      async send(input) {
        await input.onSessionStarted?.({ sessionId: `${id}-session` });
        return { sessionId: `${id}-session`, text: `${id} 的静默答复`, protocol: `${id}-mock`, tokens: 100, costUsd: 0.01 };
      },
      async close() {},
    });
  }
  const created = await orchestrator.create({
    prompt: "协作",
    execute: false,
    permissionMode: "plan",
    teamId: "team-514cc",
    orchestrationMode: "social",
    startAgentId: "claude-fable",
    requestedAgentIds: ["codex-technical", "kimi-frontend", "grok-build"],
  });
  // initialTargets = [claude-fable, codex-technical, kimi-frontend, grok-build] = 4 → socialFloor = 4+1+2 = 7
  assert.ok(created.maxStepsPerInteraction >= 7, `social 预算应含往复余量，实际 ${created.maxStepsPerInteraction}`);
  assert.ok(created.maxStepsPerInteraction > 6, "social 预算不得钳到 pipeline 的 6 步");
});

test("allocateInteraction advances seq without ledger; activateInteraction backfills it", async (t) => {
  const fx = await fixture({}, { policyOverride: { maxRounds: 6 } });
  t.after(async () => { await fx.orchestrator.close(); await rm(fx.root, { recursive: true, force: true }); });
  const orchestrator = fx.orchestrator;
  const created = await orchestrator.create({
    prompt: "账本契约", execute: false, permissionMode: "plan", teamId: "team-514cc", orchestrationMode: "pipeline",
  });
  const seqBefore = created.interactionSeq;
  const allocated = orchestrator.allocateInteraction(created);
  assert.equal(created.interactionSeq, seqBefore + 1);
  assert.equal(created.interactionStates?.[allocated.interactionId], undefined, "allocate 只递增 seq，不写 ledger");
  orchestrator.activateInteraction(created, allocated);
  assert.ok(created.interactionStates?.[allocated.interactionId], "activate 补写 ledger，重启后 pendingSteer 的 interaction 自愈");
  assert.equal(created.interactionStates[allocated.interactionId].interactionSeq, allocated.interactionSeq);
});
