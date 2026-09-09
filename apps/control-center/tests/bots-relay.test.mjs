import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { BusStore } from "../src/bus.mjs";
import { BotRelayService, parseKickoff, singleOwnerConflicts, stageOwnerWarning, projectRelayBoard } from "../src/bots/relay.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

const MEMBERS = new Set(["weaver", "candle", "smith"]);
const resolveHandle = (value) => {
  const bare = String(value ?? "").replace(/^@/, "");
  return MEMBERS.has(bare) ? bare : null;
};
const resolveMember = (memberId) => (MEMBERS.has(memberId) ? { label: memberId } : null);

async function freshRelay(t) {
  const root = await mkdtemp(resolve(appRoot, ".test-bots-relay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bus = new BusStore({ dataRoot: root });
  const relay = new BotRelayService({ bus, resolveHandle, resolveMember });
  return { root, bus, relay };
}

test("parseKickoff splits shared goal and per-handle assignments", () => {
  const parsed = parseKickoff([
    "复核本周治理账本完整性，产出链接化清单。",
    "@weaver 收集 route-gate.log 近 7 天数据，每条判断带出处。",
    "@candle 核对 DELTA 账本，逐条列缺失。",
    "@everyone 完成后回报。",
  ].join("\n"));
  assert.ok(parsed.sharedGoal.includes("复核本周治理账本完整性"));
  assert.ok(parsed.sharedGoal.includes("完成后回报")); // 广播哨兵后文本归共享目标（全员可见）
  assert.equal(parsed.assignments.length, 2);
  assert.equal(parsed.assignments[0].handle, "@weaver");
  assert.ok(parsed.assignments[0].text.includes("收集 route-gate.log"));
  assert.equal(parsed.assignments[1].handle, "@candle");
  assert.ok(!parsed.assignments[1].text.includes("完成后回报"));
});

test("singleOwnerConflicts flags duplicate handle assignment", () => {
  const parsed = parseKickoff("@weaver 先收集\n@weaver 再汇总");
  const conflicts = singleOwnerConflicts(parsed.assignments);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].handle, "@weaver");
  assert.equal(singleOwnerConflicts(parseKickoff("@weaver a\n@candle b").assignments).length, 0);
});

test("kickoff fails fast on duplicate owner and unknown handle", async (t) => {
  const { relay, bus } = await freshRelay(t);
  const runId = randomUUID();
  await assert.rejects(
    () => relay.kickoff({ runId, text: "@weaver 做甲\n@weaver 做乙" }),
    { code: "RELAY_DUPLICATE_OWNER" },
  );
  await assert.rejects(
    () => relay.kickoff({ runId, text: "@ghost 做什么" }),
    { code: "RELAY_TARGET_UNKNOWN" },
  );
  await assert.rejects(
    () => relay.kickoff({ runId, text: "没有任何指派" }),
    { code: "RELAY_NO_ASSIGNMENT" },
  );
  assert.equal((await bus.read(runId)).length, 0); // fail-fast 无部分写入
});

test("kickoff dispatches one task message per handle with shared goal prefix", async (t) => {
  const { relay, bus } = await freshRelay(t);
  const runId = randomUUID();
  const result = await relay.kickoff({
    runId,
    text: "复核治理账本。\n@weaver 收集数据。\n@candle 核对账本。",
  });
  assert.equal(result.dispatched.length, 2);
  const messages = await bus.read(runId);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].kind, "task");
  assert.equal(messages[0].to, "weaver");
  assert.equal(messages[0].from, "lo");
  assert.ok(messages[0].text.includes("【共享目标】复核治理账本。"));
  assert.ok(messages[0].text.includes("收集数据。"));
  assert.ok(messages[0].refs.handoffId);
  assert.equal(messages[1].to, "candle");
});

test("handoff then acknowledge: only the receiver may ack, repeat ack is idempotent", async (t) => {
  const { relay, bus } = await freshRelay(t);
  const runId = randomUUID();
  const sent = await relay.handoff({
    runId,
    from: "weaver",
    to: "@candle",
    stage: "review",
    text: "清单已出，请复核完整性",
  });
  assert.equal(sent.to, "candle");
  assert.equal(sent.stage, "review");

  const messages = await bus.read(runId);
  const handoffId = messages[0].refs.handoffId;

  await assert.rejects(
    () => relay.acknowledge({ runId, from: "weaver", handoffId }),
    { code: "RELAY_ACK_FORBIDDEN" },
  );
  const acked = await relay.acknowledge({ runId, from: "candle", handoffId });
  assert.equal(acked.state, "acknowledged");
  const again = await relay.acknowledge({ runId, from: "candle", handoffId });
  assert.equal(again.state, "already-acknowledged");

  const board = await relay.readBoard(runId);
  assert.equal(board.openHandoffs.length, 0);
  assert.equal(board.acknowledgedHandoffs.length, 1);
  assert.equal(board.acknowledgedHandoffs[0].ack.from, "candle");
});

test("readBoard keeps unacked handoffs open", async (t) => {
  const { relay } = await freshRelay(t);
  const runId = randomUUID();
  await relay.handoff({ runId, from: "weaver", to: "smith", text: "复核这个 diff" });
  const board = await relay.readBoard(runId);
  assert.equal(board.openHandoffs.length, 1);
  assert.equal(board.openHandoffs[0].to, "smith");
  assert.equal(board.acknowledgedHandoffs.length, 0);
});

test("stageOwnerWarning detects cross-message duplicate stage ownership", () => {
  const existing = [
    { kind: "task", from: "weaver", to: "candle", refs: { stage: "review" } },
  ];
  const warning = stageOwnerWarning(existing, { stage: "review", ownerMemberId: "smith" });
  assert.ok(warning);
  assert.equal(warning.claimedBy, "weaver");
  assert.equal(stageOwnerWarning(existing, { stage: "review", ownerMemberId: "weaver" }), null); // 同 owner 不告警
  assert.equal(stageOwnerWarning(existing, { stage: "triage", ownerMemberId: "smith" }), null); // 不同 stage 不告警
  assert.equal(stageOwnerWarning(existing, { stage: null, ownerMemberId: "smith" }), null);
});

test("handoff rejects forged sender identity", async (t) => {
  const { relay } = await freshRelay(t);
  const runId = randomUUID();
  await assert.rejects(
    () => relay.handoff({ runId, from: "ghost", to: "weaver", text: "伪造署名" }),
    { code: "MEMBER_NOT_FOUND" },
  );
  await assert.rejects(
    () => relay.kickoff({ runId, from: "ghost", text: "@weaver 做事" }),
    { code: "MEMBER_NOT_FOUND" },
  );
  // "lo"（主人）与真实成员放行
  const ok = await relay.handoff({ runId, from: "lo", to: "weaver", text: "主人派工" });
  assert.equal(ok.to, "weaver");
});

test("projectRelayBoard ignores non-handoff task messages", () => {
  const projected = projectRelayBoard([
    { id: "m1", from: "a", to: "b", kind: "task", text: "plain", refs: null, ts: "2026-09-09T00:00:00Z" },
    { id: "m2", from: "a", to: "b", kind: "task", text: "handoff", refs: { handoffId: "h1", stage: "x" }, ts: "2026-09-09T00:01:00Z" },
  ]);
  assert.equal(projected.handoffs.length, 1);
  assert.equal(projected.handoffs[0].handoffId, "h1");
  assert.equal(projected.openHandoffs.length, 1);
});
