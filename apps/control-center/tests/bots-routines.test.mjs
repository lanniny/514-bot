import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BotRoutineStore, renderRoutinePrompt, toAutomationSpec, ROUTINE_SCHEMA, ROUTINE_LIMITS } from "../src/bots/routines.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

const fakeRoster = new Map([
  ["weaver", { label: "织" }],
  ["candle", { label: "烛" }],
]);
const resolveMember = (memberId) => fakeRoster.get(memberId) ?? null;

const fakeProfile = {
  memberId: "weaver",
  handle: "@weaver",
  job: { owns: "每周配置健康巡检", goals: ["漂移发现率 100%"] },
  standingRules: ["来源必须带出处"],
  approvalBoundary: { requireApproval: ["外发消息"], neverAllowed: ["git push --force"] },
};

async function freshStore(t, options = {}) {
  const root = await mkdtemp(resolve(appRoot, ".test-bots-routines-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new BotRoutineStore({
    dataRoot: root,
    resolveMember,
    routineQuotaFor: options.routineQuotaFor ?? null,
    resolveProfile: options.withProfile ? (memberId) => (memberId === "weaver" ? fakeProfile : null) : null,
  }).init();
  return { root, store };
}

const validRoutine = () => ({
  owningMemberId: "weaver",
  title: "每周账号健康巡检",
  skillRef: null,
  instructions: "汇总 route-gate/DELTA/handoff 三块账本",
  schedule: "at:08:00@1",
  inputSource: { kind: "prompt", value: "近 7 天账本" },
  expectedOutput: "链接化观察清单",
  approvalBoundary: "不外发；产出仅回帖到会话",
  noDataPolicy: "report-failure",
});

test("create enforces the six-element confirmation checklist", async (t) => {
  const { store } = await freshStore(t);
  await assert.rejects(() => store.create({ ...validRoutine(), expectedOutput: "" }), { code: "VALIDATION_FAILED" });
  await assert.rejects(() => store.create({ ...validRoutine(), approvalBoundary: "" }), { code: "VALIDATION_FAILED" });
  await assert.rejects(() => store.create({ ...validRoutine(), instructions: "" }), { code: "ROUTINE_MISSING_SOURCE" });
  await assert.rejects(
    () => store.create({ ...validRoutine(), skillRef: "grok-researcher" }),
    { code: "ROUTINE_AMBIGUOUS_SOURCE" }, // instructions 与 skillRef 互斥
  );
  await assert.rejects(() => store.create({ ...validRoutine(), schedule: "cron:* * * * *" }), { code: "VALIDATION_FAILED" });
  await assert.rejects(() => store.create({ ...validRoutine(), noDataPolicy: "use-old-data" }), { code: "VALIDATION_FAILED" });
  await assert.rejects(() => store.create({ ...validRoutine(), owningMemberId: "ghost" }), { code: "MEMBER_NOT_FOUND" });
  await assert.rejects(
    () => store.create({ ...validRoutine(), instructions: "token=ghp_abcdef1234567890abcdef" }),
    { code: "SENSITIVE_PROMPT" },
  );
});

test("create persists and survives reload with defaults applied", async (t) => {
  const { store, root } = await freshStore(t);
  const created = await store.create({ ...validRoutine(), skillRef: "grok-researcher", instructions: null });
  assert.ok(created.id);
  assert.equal(created.noDataPolicy, "report-failure"); // 缺省 = 报告失败
  assert.equal(created.enabled, false); // 创建即启用是反模式：先 test 再 enable
  assert.equal(created.automationRef, null);

  const reloaded = await new BotRoutineStore({ dataRoot: root, resolveMember }).init();
  assert.equal(reloaded.status().source, "loaded");
  const restored = reloaded.get(created.id);
  assert.equal(restored.title, "每周账号健康巡检");
  assert.equal(restored.skillRef, "grok-researcher");
  assert.equal(restored.schedule, "at:08:00@1");
  assert.deepEqual(restored.inputSource, { kind: "prompt", value: "近 7 天账本" });
});

test("per-bot quota is enforced from profile", async (t) => {
  const { store } = await freshStore(t, { routineQuotaFor: () => 1 });
  await store.create(validRoutine());
  await assert.rejects(
    () => store.create({ ...validRoutine(), title: "第二条" }),
    { code: "ROUTINE_QUOTA_EXCEEDED" },
  );
  // 别的 Bot 不受 weaver 配额影响
  const other = await store.create({ ...validRoutine(), owningMemberId: "candle", title: "烛的例行" });
  assert.ok(other.id);
});

test("testRun produces a plan-only snapshot with the six elements rendered", async (t) => {
  const { store } = await freshStore(t, { withProfile: true });
  const created = await store.create(validRoutine());
  const result = await store.testRun(created.id);
  assert.equal(result.plan.mode, "plan-only");
  assert.ok(result.plan.promptPreview.includes("【例行任务】每周账号健康巡检"));
  assert.ok(result.plan.promptPreview.includes("【期望产出】链接化观察清单"));
  assert.ok(result.plan.promptPreview.includes("【审批边界】不外发；产出仅回帖到会话"));
  assert.ok(result.plan.promptPreview.includes("【缺数据策略】report-failure"));
  assert.ok(result.plan.promptPreview.includes("【职责】每周配置健康巡检")); // profile 装配
  assert.ok(result.plan.promptPreview.includes("git push --force"));
  assert.equal(result.testRun.status, "planned");
  assert.equal(store.get(created.id).testRun.status, "planned");
});

test("renderRoutinePrompt stays self-contained without a profile", async () => {
  const prompt = renderRoutinePrompt({ ...validRoutine(), id: "r1" });
  assert.ok(prompt.includes("【指令】"));
  assert.ok(!prompt.includes("【职责】"));
});

test("toAutomationSpec translates to a schedulable automation input", async (t) => {
  const { store } = await freshStore(t, { withProfile: true });
  const created = await store.create(validRoutine());
  const spec = toAutomationSpec(created, fakeProfile);
  assert.equal(spec.name, "[routine] 每周账号健康巡检");
  assert.equal(spec.schedule, "at:08:00@1");
  assert.deepEqual(spec.requestedAgentIds, ["weaver"]);
  assert.equal(spec.teamId, "team-514cc");
  assert.ok(spec.prompt.includes("【例行任务】"));
  assert.equal(spec.sources, undefined); // 关联靠 automationRef 回写，不进 automation.sources schema
});

test("runHistory keeps the 20 most recent records", async (t) => {
  const { store } = await freshStore(t);
  const created = await store.create(validRoutine());
  for (let index = 0; index < ROUTINE_LIMITS.runHistoryMax + 5; index += 1) {
    await store.appendRunHistory(created.id, { runId: `run-${index}`, source: "scheduled", status: "succeeded" });
  }
  const routine = store.get(created.id);
  assert.equal(routine.runHistory.length, ROUTINE_LIMITS.runHistoryMax);
  assert.equal(routine.runHistory.at(-1).runId, `run-${ROUTINE_LIMITS.runHistoryMax + 4}`);
});

test("setAutomationRef round-trips and update keeps the ref", async (t) => {
  const { store } = await freshStore(t);
  const created = await store.create(validRoutine());
  await store.setAutomationRef(created.id, "auto-123");
  const updated = await store.update(created.id, { title: "改名后", enabled: true });
  assert.equal(updated.title, "改名后");
  assert.equal(updated.automationRef, "auto-123");
  assert.equal(updated.enabled, true);
  await store.setAutomationRef(created.id, null);
  assert.equal(store.get(created.id).automationRef, null);
});

test("remove returns the automationRef for bridge cleanup", async (t) => {
  const { store } = await freshStore(t);
  const created = await store.create(validRoutine());
  await store.setAutomationRef(created.id, "auto-xyz");
  const removed = await store.remove(created.id);
  assert.equal(removed.automationRef, "auto-xyz");
  assert.equal(store.get(created.id), null);
  await assert.rejects(() => store.remove(created.id), { code: "ROUTINE_NOT_FOUND" });
});

test("internal fields are not user-writable (automationRef injection stays inert)", async (t) => {
  const { store } = await freshStore(t);
  const created = await store.create(validRoutine());
  await store.setAutomationRef(created.id, "auto-real");
  // 客户端在 PUT 体里伪造 automationRef/testRun/runHistory：静默丢弃，继承既有值
  const updated = await store.update(created.id, {
    title: "改名",
    automationRef: "auto-victim",
    testRun: { lastTestAt: "2020-01-01", status: "forged" },
    runHistory: [{ at: "2020-01-01", runId: "forged" }],
  });
  assert.equal(updated.automationRef, "auto-real");
  assert.equal(updated.testRun, null);
  assert.deepEqual(updated.runHistory, []);
  // create 时同样不可注入
  const second = await store.create({ ...validRoutine(), title: "第二条", automationRef: "auto-victim" });
  assert.equal(second.automationRef, null);
});

test("custom routine id is validated at the door", async (t) => {
  const { store } = await freshStore(t);
  await assert.rejects(
    () => store.create({ ...validRoutine(), id: "../escape" }),
    { code: "VALIDATION_FAILED" },
  );
  await assert.rejects(
    () => store.create({ ...validRoutine(), id: "has space" }),
    { code: "VALIDATION_FAILED" },
  );
  const ok = await store.create({ ...validRoutine(), id: "weekly-health-01" });
  assert.equal(ok.id, "weekly-health-01");
});

test("foreign schema on disk is rejected", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-bots-routines-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "bot-routines.json"), JSON.stringify({ schema: "other/v1", items: [] }), "utf8");
  await assert.rejects(
    () => new BotRoutineStore({ dataRoot: root }).init(),
    { code: "ROUTINE_STORE_INVALID" },
  );
  // schema 对但缺 noDataPolicy 的持久记录同样拒收（读盘 fail-closed）
  const item = { ...validRoutine(), id: "r1", noDataPolicy: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await writeFile(join(root, "bot-routines.json"), JSON.stringify({ schema: ROUTINE_SCHEMA, items: [item] }), "utf8");
  await assert.rejects(
    () => new BotRoutineStore({ dataRoot: root }).init(),
    { code: "ROUTINE_STORE_INVALID" },
  );
});
