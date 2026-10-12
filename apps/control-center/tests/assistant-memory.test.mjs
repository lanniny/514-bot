import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssistantMemoryStore,
  formatMemoryPromptChunk,
  validateMemoryItem,
  MEMORY_LIMITS,
} from "../src/assistant-memory.mjs";

test("validateMemoryItem validates structure and defaults correctly", () => {
  const item = validateMemoryItem({
    category: "preference",
    title: "常用 ESM 模块规范",
    content: "全工程优先使用 import/export，不使用 require",
    pinned: true,
  }, { isNew: true });

  assert.match(item.id, /^mem-[0-9a-f-]+/);
  assert.equal(item.category, "preference");
  assert.equal(item.title, "常用 ESM 模块规范");
  assert.equal(item.content, "全工程优先使用 import/export，不使用 require");
  assert.equal(item.pinned, true);
  assert.equal(item.enabled, true);
  assert.ok(item.createdAt);
  assert.ok(item.updatedAt);
});

test("validateMemoryItem rejects invalid categories and overlarge content", () => {
  assert.throws(
    () => validateMemoryItem({ id: "mem-test", category: "invalid_cat", title: "T", content: "C" }),
    /unsupported memory category/
  );
  assert.throws(
    () => validateMemoryItem({ id: "mem-test", category: "preference", title: "T", content: "a".repeat(MEMORY_LIMITS.contentMax + 1) }),
    /content exceeds/
  );
  assert.throws(
    () => validateMemoryItem({ id: "mem-test", category: "preference", title: "a".repeat(MEMORY_LIMITS.titleMax + 1), content: "C" }),
    /title exceeds/
  );
});

test("formatMemoryPromptChunk orders by pinned and respects maxBytes limit", () => {
  const memories = [
    { id: "1", category: "workflow_fact", title: "测试先跑", content: "每轮改动先跑单测", pinned: false, enabled: true, updatedAt: "2026-09-18T10:00:00Z" },
    { id: "2", category: "preference", title: "ESM 优先", content: "用 import", pinned: true, enabled: true, updatedAt: "2026-09-18T09:00:00Z" },
    { id: "3", category: "project_rule", title: "CRLF 换行", content: "Windows 保持 CRLF", pinned: true, enabled: true, updatedAt: "2026-09-18T08:00:00Z" },
    { id: "4", category: "decision", title: "废弃能力", content: "已禁用", pinned: false, enabled: false, updatedAt: "2026-09-18T11:00:00Z" },
  ];

  const chunk = formatMemoryPromptChunk(memories, { maxBytes: 8192 });
  assert.ok(chunk.includes("[长期记忆与用户已知设定]"));
  assert.ok(chunk.includes("★ [偏好习惯] ESM 优先: 用 import"));
  assert.ok(chunk.includes("★ [项目规则] CRLF 换行: Windows 保持 CRLF"));
  assert.ok(chunk.includes("[工作流事实] 测试先跑: 每轮改动先跑单测"));
  assert.ok(!chunk.includes("已禁用"), "disabled items should be excluded");

  // Verify byte limit cutoff
  const smallChunk = formatMemoryPromptChunk(memories, { maxBytes: 65 });
  assert.ok(smallChunk.length <= 65);
});

test("AssistantMemoryStore CRUD lifecycle and persistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assistant-memory-test-"));
  try {
    const store = new AssistantMemoryStore({ dataRoot: dir });
    await store.init();

    // 1. Create
    const created = await store.create({
      category: "preference",
      title: "简洁回答",
      content: "代码交付优先，减少套话",
      pinned: true,
    });
    assert.equal(created.title, "简洁回答");
    assert.equal(created.pinned, true);

    const second = await store.create({
      category: "project_rule",
      title: "单测全覆盖",
      content: "新增端点必须有配套 test.mjs",
      pinned: false,
    });

    // 2. List
    const all = await store.list();
    assert.equal(all.length, 2);
    assert.equal(all[0].id, created.id, "pinned should be first");

    const pinnedOnly = await store.list({ pinned: true });
    assert.equal(pinnedOnly.length, 1);
    assert.equal(pinnedOnly[0].id, created.id);

    const searchResult = await store.list({ search: "单测" });
    assert.equal(searchResult.length, 1);
    assert.equal(searchResult[0].id, second.id);

    // 3. Get
    const fetched = await store.get(created.id);
    assert.equal(fetched.title, "简洁回答");

    // 4. Update
    const updated = await store.update(created.id, { content: "直接给出方案与代码", pinned: false });
    assert.equal(updated.content, "直接给出方案与代码");
    assert.equal(updated.pinned, false);

    // 5. Prompt chunk
    const promptChunk = await store.getPromptChunk();
    assert.ok(promptChunk.includes("直接给出方案与代码"));

    // 6. Delete
    const delResult = await store.delete(second.id);
    assert.equal(delResult.success, true);
    assert.equal((await store.list()).length, 1);

    // 7. Re-init to verify disk persistence
    const reloaded = new AssistantMemoryStore({ dataRoot: dir });
    await reloaded.init();
    const reloadedList = await reloaded.list();
    assert.equal(reloadedList.length, 1);
    assert.equal(reloadedList[0].id, created.id);
    assert.equal(reloadedList[0].content, "直接给出方案与代码");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
