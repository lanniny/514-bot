/**
 * conversations-purge-liveness.test.mjs — 清空已删除会话的**保留判据必须看 run 此刻是否活着**。
 *
 * 病灶（LO 2026-10-11 实机）：点「清空已删除」弹「已清空 0 条；另有 6 条因仍关联运行记录而保留」，
 * 列表里 6 条一条没少。查盘上真相：6 条已删除会话里 **5 条的 activeRunId 指向的 run 文件根本不存在**
 * （ENOENT），第 6 条指向一条 10 天前就 recovery_required 的旧 run。
 *
 * 根因：`purgeDeleted` 的保留判据是「activeRunId 非空 **或** runIds 非空」。
 *   - `activeRunId` 只在 attachRun 时写入（conversations.mjs:530），**run 终态后从不清除**；
 *   - run 文件还可能从未落盘、或已被 clearFinished 清掉。
 * 于是这道判据在保护鬼魂——任何有过 run 的会话都永远清不掉，而那几乎是全部真实会话。
 * 确认弹窗里承诺的「仅清除 Conversation 删除墓碑 / 保留 Run 事件、审批、产物」从未兑现：
 * run 与会话记录本就相互独立（remove() 只打墓碑，编排器不跟着清 run），删墓碑不动审计。
 *
 * 契约：
 *   ① activeRunId 指向的 run 已不存在 → 必须清掉（鬼魂不得成为保留理由）；
 *   ② activeRunId 指向**此刻仍活着**的 run → 必须保留（真保护，一条不让）；
 *   ③ 只有 run 历史、没有 activeRunId → 必须清掉（历史永不拦清空）；
 *   ④ 不传 isRunLive 判据 → 保守跳过（purge 是永久操作，调用方忘了传判据不该凭空获得更大的删除权）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationStore } from "../src/conversations.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "514cc-purge-liveness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// 读当前 revision：每一步写入都会 +1，硬编码 expectedRevision 只会换来一串 revision mismatch
const revisionOf = (store, id) => store.get(id).revision;
const present = (store, id) => store
  .list({ includeHidden: true, includeDeleted: true })
  .some((item) => item.id === id);

// 造一条「已删除且挂着 activeRunId」的会话
async function deletedWithActiveRun(store, title, runId) {
  const created = await store.create({ kind: "direct", title, directMemberId: "codex-technical" });
  await store.attachRun(created.id, runId);
  return store.remove(created.id, { expectedRevision: revisionOf(store, created.id) });
}

test("purgeDeleted 清掉 activeRunId 指向已消失 run 的墓碑（鬼魂不得成为保留理由）", async (t) => {
  const dataRoot = await fixture(t);
  const store = await new ConversationStore({ dataRoot }).init();
  const ghost = await deletedWithActiveRun(store, "run 文件已消失", "run-ghost");
  const live = await deletedWithActiveRun(store, "run 还活着", "run-live");

  // 同一次调用里两种 run 混排：验证判据是**逐条**判的，不是一刀切
  const result = await store.purgeDeleted({
    expectedStoreRevision: store.status().revision,
    isRunLive: (runId) => runId === "run-live",
  });

  assert.deepEqual(result.conversationIds, [ghost.id], "run 已消失的墓碑必须被清掉");
  assert.equal(result.purged, 1);
  assert.deepEqual(result.skipped, [{ conversationId: live.id, reason: "active-run", runId: "run-live" }],
    "run 仍活着的墓碑必须保留，且 skipped 要带上 runId 好让上层说清「哪一条、为什么」");
  assert.equal(present(store, ghost.id), false, "清掉的墓碑不得再出现在列表里");
  assert.equal(present(store, live.id), true, "保留的墓碑必须原样还在");
});

test("purgeDeleted 清掉只有 run 历史、没有 activeRunId 的墓碑（历史永不拦清空）", async (t) => {
  const dataRoot = await fixture(t);
  const store = await new ConversationStore({ dataRoot }).init();
  const created = await store.create({ kind: "direct", title: "只有历史", directMemberId: "codex-technical" });
  // activate:false → 只进 runIds，不设 activeRunId（真实形态：run 早终态、字段已脱钩）
  await store.attachRun(created.id, "run-history", { activate: false });
  await store.remove(created.id, { expectedRevision: revisionOf(store, created.id) });

  const result = await store.purgeDeleted({
    expectedStoreRevision: store.status().revision,
    isRunLive: () => true, // 即便判据恒真，没有 activeRunId 就无从判断，必须放行
  });

  assert.equal(result.purged, 1, "runIds 非空 alone 不得成为保留理由");
  assert.deepEqual(result.skipped, []);
  assert.equal(present(store, created.id), false, "只有历史的墓碑必须被清掉");
});

test("purgeDeleted 不传 isRunLive 时保守跳过（永久操作不许因调用方疏忽而放大删除面）", async (t) => {
  const dataRoot = await fixture(t);
  const store = await new ConversationStore({ dataRoot }).init();
  const tombstone = await deletedWithActiveRun(store, "无判据", "run-x");

  const result = await store.purgeDeleted({ expectedStoreRevision: store.status().revision });

  assert.equal(result.purged, 0, "缺判据时必须维持旧有的保守口径");
  assert.deepEqual(result.skipped, [{ conversationId: tombstone.id, reason: "active-run", runId: "run-x" }]);
  assert.equal(present(store, tombstone.id), true, "墓碑必须原样保留");
});
