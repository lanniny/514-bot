import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryService } from "../src/memory.mjs";
import { ObservabilityService } from "../src/observability.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

async function seedRepo(t) {
  const root = await mkdtemp(resolve(appRoot, ".test-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const aiShared = join(root, ".ai-shared");
  await mkdir(join(aiShared, "handoff"), { recursive: true });
  await writeFile(join(aiShared, "handoff", "claude-to-codex__forge-wave__20260725-1011.md"), "# Forge\n\n__DELTA__: 烛(Codex) | 1 | 证据：server.mjs:42 补强限根\n", "utf8");
  await writeFile(join(aiShared, "context.md"), "# 上下文\n\n记忆浏览器契约。\n", "utf8");
  await writeFile(join(aiShared, "decisions.md"), "# 决策\n\n__DELTA__: 织(Grok) | 0 | 证据：无新增发现\n__DELTA__: 鉴(Claude) | 2 | 证据：推翻主驾判断\n", "utf8");
  await writeFile(join(root, "MEMORY.md"), "# 记忆\n\n长期记忆条目。\n", "utf8");
  return { root, aiShared };
}

test("memory roots expose handoff, ai-shared docs and MEMORY.md files", async (t) => {
  const { root, aiShared } = await seedRepo(t);
  const service = new MemoryService({ repoRoot: root, aiSharedRoot: aiShared });
  const { roots } = await service.roots();
  const names = roots.map((entry) => entry.name);
  assert.ok(names.includes("handoff"));
  assert.ok(names.includes("ai-shared"));
  assert.ok(names.some((name) => name.startsWith("memory:")), "expected a MEMORY.md root");
  for (const entry of roots) {
    assert.ok(!entry.path.startsWith(".."), `root path escapes repo: ${entry.path}`);
    for (const file of entry.files) {
      assert.ok(file.name && Number.isFinite(file.size) && !Number.isNaN(Date.parse(file.mtime)));
    }
  }
  const handoff = roots.find((entry) => entry.name === "handoff");
  assert.deepEqual(handoff.files.map((file) => file.name), ["claude-to-codex__forge-wave__20260725-1011.md"]);
});

test("memory search finds snippets and returns empty for empty query", async (t) => {
  const { root, aiShared } = await seedRepo(t);
  const service = new MemoryService({ repoRoot: root, aiSharedRoot: aiShared });
  assert.deepEqual(await service.search({ query: "" }), { results: [] });
  const { results } = await service.search({ query: "长期记忆" });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "MEMORY.md");
  assert.equal(results[0].path, "MEMORY.md");
  assert.ok(results[0].snippet.includes("长期记忆"));
  assert.ok(results[0].score > 0);
  // 缺失的目录不应报错（删掉 handoff 后仍可用）
  await rm(join(aiShared, "handoff"), { recursive: true, force: true });
  const after = await service.search({ query: "记忆" });
  assert.ok(Array.isArray(after.results));
});

test("delta ledger keeps existing fields and adds normalized deltas[]", async (t) => {
  const { root, aiShared } = await seedRepo(t);
  const service = new ObservabilityService({ aiSharedRoot: aiShared, repoRoot: root });
  const result = await service.deltaLedger();
  // 既有字段原样保留
  assert.equal(result.total, 3);
  assert.deepEqual(result.byScore, { 0: 1, 1: 1, 2: 1, invalid: 0 });
  assert.equal(result.recent.length, 3);
  for (const entry of result.recent) {
    assert.deepEqual(Object.keys(entry).sort(), ["agent", "evidence", "score", "source"]);
  }
  // v4.0 新增 deltas[]：全量规范化明细，六键齐备，id 稳定唯一
  assert.equal(result.deltas.length, 3);
  const ids = new Set();
  for (const delta of result.deltas) {
    assert.deepEqual(Object.keys(delta).sort(), ["agent", "evidence", "id", "score", "topic", "ts"]);
    assert.ok(!ids.has(delta.id), `duplicate delta id ${delta.id}`);
    ids.add(delta.id);
    assert.ok(typeof delta.agent === "string" && delta.agent.length > 0);
    assert.ok(delta.score === null || (delta.score >= 0 && delta.score <= 2));
  }
  // handoff 文件名可提取 ts/topic；decisions.md 无时间戳如实置 null
  const fromHandoff = result.deltas.find((delta) => delta.id.startsWith("claude-to-codex__forge-wave"));
  assert.equal(fromHandoff.topic, "forge-wave");
  assert.equal(fromHandoff.ts, "2026-07-25T10:11:00");
  const fromDecisions = result.deltas.filter((delta) => delta.id.startsWith("decisions.md"));
  assert.equal(fromDecisions.length, 2);
  for (const delta of fromDecisions) assert.equal(delta.ts, null);
});

test("memory read serves enumerated files only (root+name and rel path), never raw traversal", async (t) => {
  const { root, aiShared } = await seedRepo(t);
  const service = new MemoryService({ repoRoot: root, aiSharedRoot: aiShared });
  // root+name 定位（文件树行）
  const byRoot = await service.read({ root: "handoff", name: "claude-to-codex__forge-wave__20260725-1011.md" });
  assert.ok(byRoot.content.includes("__DELTA__"));
  assert.equal(byRoot.root, "handoff");
  assert.ok(byRoot.path.endsWith(".md"));
  // rel path 定位（搜索结果行）
  const byPath = await service.read({ path: "MEMORY.md" });
  assert.ok(byPath.content.includes("长期记忆"));
  // 清单外路径与未命中 root/name 一律 404，不接受任意路径
  await assert.rejects(() => service.read({ path: "config/control-center/models.json" }), { code: "MEMORY_FILE_NOT_FOUND" });
  await assert.rejects(() => service.read({ path: "../../package.json" }), { code: "MEMORY_FILE_NOT_FOUND" });
  await assert.rejects(() => service.read({ root: "nope", name: "x.md" }), { code: "MEMORY_FILE_NOT_FOUND" });
});
