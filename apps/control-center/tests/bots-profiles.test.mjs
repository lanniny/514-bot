import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BotProfileStore, PROFILE_SCHEMA, ROUTINE_QUOTA_DEFAULT } from "../src/bots/profiles.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

const fakeRoster = new Map([
  ["candle", { label: "烛", role: "代码守夜人", runtimeProfileId: "codex-review" }],
  ["weaver", { label: "织", role: "情报编织者", runtimeProfileId: "grok-research" }],
]);
const resolveMember = (memberId) => fakeRoster.get(memberId) ?? null;

async function freshStore(t, { withRoster = true } = {}) {
  const root = await mkdtemp(resolve(appRoot, ".test-bots-profiles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new BotProfileStore({
    dataRoot: root,
    resolveMember: withRoster ? resolveMember : null,
  }).init();
  return { root, store };
}

test("init on missing store starts empty and writable", async (t) => {
  const { store } = await freshStore(t);
  assert.equal(store.status().state, "ready");
  assert.equal(store.status().source, "missing-default");
  assert.equal(store.status().count, 0);
});

test("upsert validates fail-closed", async (t) => {
  const { store } = await freshStore(t);
  const valid = {
    job: { owns: "每周配置健康巡检", goals: ["漂移发现率 100%"] },
    standingRules: ["来源必须带出处"],
    approvalBoundary: { requireApproval: ["外发消息"], neverAllowed: ["git push --force"] },
    skills: ["grok-researcher"],
  };

  await assert.rejects(() => store.upsert("ghost", valid), { code: "MEMBER_NOT_FOUND" });
  await assert.rejects(() => store.upsert("weaver", { ...valid, handle: "weaver" }), { code: "VALIDATION_FAILED" });
  await assert.rejects(() => store.upsert("weaver", { ...valid, routineQuota: 51 }), { code: "VALIDATION_FAILED" });
  await assert.rejects(() => store.upsert("weaver", { ...valid, routineQuota: -1 }), { code: "VALIDATION_FAILED" });
  await assert.rejects(() => store.upsert("weaver", { ...valid, unknownField: true }), { code: "VALIDATION_FAILED" });
  await assert.rejects(
    () => store.upsert("weaver", { ...valid, notes: "api_key=sk-proj-abcdef1234567890abcdef" }),
    { code: "SENSITIVE_PROMPT" },
  );
  await assert.rejects(
    () => store.upsert("weaver", { ...valid, job: { owns: "x", badKey: "y" } }),
    { code: "VALIDATION_FAILED" },
  );
});

test("upsert persists across init and projects defaults", async (t) => {
  const { store, root } = await freshStore(t);
  const saved = await store.upsert("weaver", {
    handle: "@weaver",
    job: { owns: "每周配置健康巡检：汇总三块账本", goals: ["每周一 08:00 前出清单"] },
    standingRules: ["来源必须带出处", "客户联系永不允许"],
    approvalBoundary: { requireApproval: ["外发"], neverAllowed: ["force push"] },
    skills: ["grok-researcher"],
    pinned: true,
  });
  assert.equal(saved.memberId, "weaver");
  assert.equal(saved.routineQuota, ROUTINE_QUOTA_DEFAULT);
  assert.equal(saved.pinned, true);
  assert.ok(saved.createdAt && saved.updatedAt);

  const reloaded = await new BotProfileStore({ dataRoot: root, resolveMember }).init();
  assert.equal(reloaded.status().source, "loaded");
  const restored = reloaded.get("weaver");
  assert.equal(restored.handle, "@weaver");
  assert.equal(restored.job.owns, "每周配置健康巡检：汇总三块账本");
  assert.deepEqual(restored.standingRules, ["来源必须带出处", "客户联系永不允许"]);
  assert.deepEqual(restored.approvalBoundary.neverAllowed, ["force push"]);
  assert.deepEqual(restored.skills, ["grok-researcher"]);
});

test("handle uniqueness is enforced across profiles", async (t) => {
  const { store } = await freshStore(t);
  await store.upsert("weaver", { handle: "@scout", job: { owns: "x" } });
  await assert.rejects(
    () => store.upsert("candle", { handle: "@scout", job: { owns: "y" } }),
    { code: "HANDLE_CONFLICT" },
  );
  // 同成员换 handle 允许（except 自身）
  const moved = await store.upsert("weaver", { handle: "@weaver", job: { owns: "x" } });
  assert.equal(moved.handle, "@weaver");
});

test("resolveHandle resolves profile handle, bare memberId, and falls back", async (t) => {
  const { store } = await freshStore(t);
  await store.upsert("weaver", { handle: "@scout", job: { owns: "x" } });
  assert.equal(store.resolveHandle("@scout"), "weaver");
  assert.equal(store.resolveHandle("weaver"), "weaver");
  assert.equal(store.resolveHandle("@weaver"), "weaver"); // 无 profile 的默认回落
  assert.equal(store.resolveHandle("@nobody"), null);
  assert.equal(store.resolveHandle(null), null);
  assert.equal(store.effectiveHandle("candle"), "@candle"); // 无 profile → 默认
  assert.equal(store.effectiveHandle("weaver"), "@scout");
});

test("remove deletes profile and stays fail-closed on missing", async (t) => {
  const { store } = await freshStore(t);
  await store.upsert("weaver", { job: { owns: "x" } });
  const removed = await store.remove("weaver");
  assert.deepEqual(removed, { removed: "weaver" });
  assert.equal(store.get("weaver"), null);
  await assert.rejects(() => store.remove("weaver"), { code: "PROFILE_NOT_FOUND" });
});

test("corrupt or foreign schema on disk is rejected", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-bots-profiles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "bot-profiles.json"), JSON.stringify({ schema: "something-else/v9", items: [] }), "utf8");
  await assert.rejects(
    () => new BotProfileStore({ dataRoot: root }).init(),
    { code: "PROFILE_STORE_INVALID" },
  );
  await writeFile(join(root, "bot-profiles.json"), "{ not json", "utf8");
  await assert.rejects(
    () => new BotProfileStore({ dataRoot: root }).init(),
    { code: "PROFILE_STORE_INVALID" },
  );
});

test("duplicate memberId on disk is rejected", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-bots-profiles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const item = {
    memberId: "weaver",
    handle: "@weaver",
    job: { owns: "x", goals: [] },
    standingRules: [],
    approvalBoundary: { requireApproval: [], neverAllowed: [] },
    skills: [],
    routineQuota: 50,
    pinned: false,
    hidden: false,
    notes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(
    join(root, "bot-profiles.json"),
    JSON.stringify({ schema: PROFILE_SCHEMA, items: [item, { ...item, handle: "@other" }] }),
    "utf8",
  );
  await assert.rejects(
    () => new BotProfileStore({ dataRoot: root }).init(),
    { code: "PROFILE_STORE_INVALID" },
  );
});
