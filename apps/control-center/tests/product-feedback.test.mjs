/**
 * P-24 产品反馈闭环测试（v48 S0-5）。
 *
 * 核心断言：不丢用户的声音（非法分类归 other 而非拒收）、误贴的密钥不落盘、
 * 反馈能被"处理掉"（否则只是收集箱不是闭环）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductFeedbackStore, FEEDBACK_KINDS, FEEDBACK_STATUSES } from "../src/product-feedback.mjs";

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), "514cc-feedback-"));
  const store = await new ProductFeedbackStore({ path: join(dir, "product-feedback.json") }).init();
  try {
    return await run(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("提交后落盘且可读回", async () => {
  await withStore(async (store) => {
    const entry = await store.submit({ kind: "confusing", note: "配置页找不到入口", view: "config" });
    assert.equal(entry.kind, "confusing");
    assert.equal(entry.status, "open");
    assert.ok(entry.id);
    const raw = JSON.parse(await readFile(store.path, "utf8"));
    assert.equal(raw.entries.length, 1);
    assert.equal(raw.entries[0].note, "配置页找不到入口");
  });
});

test("非法分类归为 other 而非拒收——不能因为没选对分类就丢掉用户的声音", async () => {
  await withStore(async (store) => {
    const entry = await store.submit({ kind: "随便写的", note: "有问题" });
    assert.equal(entry.kind, "other");
    assert.equal(entry.note, "有问题", "描述必须保留");
  });
});

test("自由文本中误贴的密钥被脱敏", async () => {
  await withStore(async (store) => {
    await store.submit({ kind: "broken", note: "报错了，我的 key 是 sk-proj-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH 结果 401" });
    const raw = await readFile(store.path, "utf8");
    assert.ok(!raw.includes("sk-proj-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"), "用户手滑贴的密钥不得原样落盘");
    assert.ok(raw.includes("401"), "非敏感内容应当保留，否则反馈失去价值");
  });
});

test("超长描述被截断而非拒收", async () => {
  await withStore(async (store) => {
    const entry = await store.submit({ kind: "other", note: "长".repeat(5000) });
    assert.ok(entry.note.length <= 2000);
  });
});

test("view 走标识符过滤，路径进不来", async () => {
  await withStore(async (store) => {
    const entry = await store.submit({ kind: "other", note: "x", view: "C:/Users/secret/path" });
    assert.ok(!String(entry.view).includes("/"));
    const empty = await store.submit({ kind: "other", note: "x", view: "全中文" });
    assert.equal(empty.view, null, "无法构成标识符时应为 null 而非脏值");
  });
});

test("状态可被标记——反馈必须能被处理掉才算闭环", async () => {
  await withStore(async (store) => {
    const entry = await store.submit({ kind: "broken", note: "崩了" });
    const updated = await store.setStatus(entry.id, "done");
    assert.equal(updated.status, "done");
    assert.ok(updated.updatedAt);
    const listed = await store.list();
    assert.equal(listed.open, 0);
    assert.equal(listed.byStatus.done, 1);
  });
});

test("非法状态被拒绝", async () => {
  await withStore(async (store) => {
    const entry = await store.submit({ kind: "other", note: "x" });
    await assert.rejects(() => store.setStatus(entry.id, "已修复"), { code: "VALIDATION_FAILED" });
    await assert.rejects(() => store.setStatus("不存在的id", "done"), { code: "NOT_FOUND" });
  });
});

test("list 按状态过滤并给出分类统计", async () => {
  await withStore(async (store) => {
    await store.submit({ kind: "broken", note: "a" });
    await store.submit({ kind: "broken", note: "b" });
    const third = await store.submit({ kind: "slow", note: "c" });
    await store.setStatus(third.id, "done");
    const all = await store.list();
    assert.equal(all.total, 3);
    assert.equal(all.open, 2);
    assert.equal(all.byKind.broken, 2);
    const openOnly = await store.list({ status: "open" });
    assert.equal(openOnly.entries.length, 2);
  });
});

test("最新反馈排在最前", async () => {
  await withStore(async (store) => {
    await store.submit({ kind: "other", note: "第一条" });
    await store.submit({ kind: "other", note: "第二条" });
    const listed = await store.list();
    assert.equal(listed.entries[0].note, "第二条");
  });
});

test("损坏的存储文件被侧移备份，绝不静默覆盖用户数据", async () => {
  const dir = await mkdtemp(join(tmpdir(), "514cc-feedback-bad-"));
  const path = join(dir, "product-feedback.json");
  try {
    await writeFile(path, '{ "entries": [{"id":"旧数据不能丢"}] 这里坏了', "utf8");
    const store = await new ProductFeedbackStore({ path }).init();
    const listed = await store.list();
    assert.equal(listed.total, 0, "损坏后降级为空列表，不挡启动");
    // 关键：原始损坏内容必须被保住，而不是等下次 submit 覆写掉
    assert.ok(store.corrupted, "必须记录损坏事实");
    assert.ok(listed.corrupted?.backup, "list 要向调用方暴露备份位置");
    const backupContent = await readFile(store.corrupted.backup, "utf8");
    assert.ok(backupContent.includes("旧数据不能丢"), "原始内容必须完整保留在备份里");
    // 且仍可正常写入
    await store.submit({ kind: "other", note: "恢复后仍可提交" });
    assert.equal((await store.list()).total, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 烛 R2 四致命项的回归防线（2026-09-04）─────────────────────────────────

test("F-1：并发 submit 不丢写", async () => {
  await withStore(async (store) => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.submit({ kind: "other", note: `并发-${i}` })));
    const listed = await store.list();
    assert.equal(listed.total, 25, "并发提交不得互相覆盖");
    const onDisk = JSON.parse(await readFile(store.path, "utf8"));
    assert.equal(onDisk.entries.length, 25, "落盘结果必须与内存一致——旧快照不得覆盖新反馈");
    assert.equal(new Set(onDisk.entries.map((e) => e.id)).size, 25, "id 不得重复或丢失");
  });
});

test("F-2：裁剪保住 triaged——已分诊未完成的工作不得被删", async () => {
  await withStore(async (store) => {
    // 先塞 3 条并标为 triaged
    const triaged = [];
    for (let i = 0; i < 3; i += 1) {
      const entry = await store.submit({ kind: "broken", note: `分诊中-${i}` });
      await store.setStatus(entry.id, "triaged");
      triaged.push(entry.id);
    }
    // 再塞 2 条标为 done（可回收）
    for (let i = 0; i < 2; i += 1) {
      const entry = await store.submit({ kind: "other", note: `已结案-${i}` });
      await store.setStatus(entry.id, "done");
    }
    // 直接把内存撑到超限，触发裁剪
    store.entries = [...store.entries, ...Array.from({ length: 500 }, (_, i) => ({
      id: `filler-${i}`, kind: "other", note: "", status: "done", createdAt: new Date().toISOString(),
    }))];
    await store.submit({ kind: "other", note: "触发裁剪" });
    const remaining = new Set(store.entries.map((e) => e.id));
    for (const id of triaged) {
      assert.ok(remaining.has(id), "triaged 反馈不得因裁剪被删——那等于丢掉已投入的分诊工作");
    }
  });
});

test("F-3：setStatus 与 submit 并发不互相覆盖", async () => {
  await withStore(async (store) => {
    const seed = await store.submit({ kind: "broken", note: "种子" });
    await Promise.all([
      store.setStatus(seed.id, "done"),
      ...Array.from({ length: 10 }, (_, i) => store.submit({ kind: "other", note: `并发写-${i}` })),
    ]);
    const onDisk = JSON.parse(await readFile(store.path, "utf8"));
    assert.equal(onDisk.entries.length, 11, "11 条都要在");
    const seedOnDisk = onDisk.entries.find((e) => e.id === seed.id);
    assert.equal(seedOnDisk.status, "done", "状态变更不得被并发的 submit 覆盖回去");
  });
});

test("F-4：临时文件名唯一，并发写不互相踩", async () => {
  await withStore(async (store, dir) => {
    await Promise.all(Array.from({ length: 15 }, () => store.submit({ kind: "other", note: "x" })));
    const { readdir } = await import("node:fs/promises");
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "不得残留临时文件");
  });
});

test("分类与状态枚举保持稳定契约", () => {
  assert.deepEqual([...FEEDBACK_KINDS], ["confusing", "broken", "slow", "missing", "other"]);
  assert.deepEqual([...FEEDBACK_STATUSES], ["open", "triaged", "done", "wontfix"]);
});

test("缺少 path 时构造即失败", () => {
  assert.throws(() => new ProductFeedbackStore({}), /requires a path/);
});
