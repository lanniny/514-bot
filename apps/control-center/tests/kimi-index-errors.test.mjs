import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SessionAggregator } from "../src/sessions.mjs";

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "514cc-kimi-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = resolve(root, ".kimi-code/sessions");
  const good = resolve(sessions, "good");
  await mkdir(good, { recursive: true });
  await writeFile(resolve(good, "state.json"), JSON.stringify({ title: "fixture", isCustomTitle: true }));
  const writeIndex = (entries) => writeFile(resolve(root, ".kimi-code/session_index.jsonl"), entries.join("\n") + "\n");
  const entry = (id, sessionDir = good, workDir = "C:/Work/Kimi") => JSON.stringify({ sessionId: id, sessionDir, workDir });
  const aggregator = new SessionAggregator({ home: root, aiSharedRoot: resolve(root, ".ai-shared"), projectSnapshotTtlMs: 0 });
  return { root, sessions, good, writeIndex, entry, aggregator };
}

test("Kimi index diagnostics distinguish invalid, stale, outside and metadata fallback records without exposing paths", async (t) => {
  const { root, sessions, good, writeIndex, entry, aggregator } = await fixture(t);
  const fallback = resolve(sessions, "fallback");
  const outside = resolve(root, "outside-private-directory");
  await mkdir(fallback);
  await mkdir(outside);
  await writeIndex([
    entry("good"), entry("fallback", fallback), entry("missing", resolve(sessions, "removed")),
    entry("outside", outside), entry("no-cwd", good, ""), "{broken", entry(123), entry("invalid-dir", {}),
  ]);
  const result = await aggregator.projects();
  const source = result.sources.find((item) => item.source === "kimi");
  assert.equal(source.available, true);
  assert.equal(source.sessionCount, 2);
  assert.deepEqual(source.diagnostics, { indexLines: 8, invalidEntries: 3, acceptedEntries: 2, missingDirectories: 1, outsideRoot: 1, missingWorkdir: 1, metadataFallbacks: 1, readErrors: 0 });
  assert.ok(Object.values(source.diagnostics).every(Number.isInteger));
  assert.doesNotMatch(JSON.stringify(source), /outside-private-directory|removed|broken/);
  const listed = (await aggregator.list()).sources.find((item) => item.source === "kimi");
  assert.deepEqual(listed.diagnostics, source.diagnostics);
  assert.equal(listed.sessionCount, 2);
});

for (const code of ["EACCES", "EIO"]) {
  test(`Kimi ${code} is not silently treated as a deleted directory or a complete partial count`, async (t) => {
    const { sessions, writeIndex, entry, aggregator } = await fixture(t);
    const bad = resolve(sessions, "unreadable");
    await mkdir(bad);
    await writeIndex([...Array.from({ length: 64 }, (_, index) => entry(`good-${index}`)), entry("bad", bad)]);
    const original = fs.promises.realpath;
    const mock = t.mock.method(fs.promises, "realpath", async (path, ...args) => {
      if (path === bad) throw Object.assign(new Error("fixture-sensitive-marker"), { code });
      return original(path, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    const result = await aggregator.projects();
    const source = result.sources.find((item) => item.source === "kimi");
    assert.equal(source.available, false);
    assert.equal(source.sessionCount, 0);
    assert.equal(source.error, code);
    assert.equal(source.diagnostics.acceptedEntries, 64);
    assert.equal(source.diagnostics.readErrors, 1);
    assert.equal(source.diagnostics.missingDirectories, 0);
    assert.deepEqual(result.projects, []);
    assert.doesNotMatch(JSON.stringify(source), /fixture-sensitive-marker|unreadable/);
  });
}
