import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectSources, sourceRole } from "../scripts/source-inventory.mjs";

test("source inventory separates runtime, tests, tooling, local probes and third-party files", () => {
  assert.equal(sourceRole("apps/control-center/public/app.js"), "frontend");
  assert.equal(sourceRole("apps/control-center/src/orchestrator.mjs"), "backend");
  assert.equal(sourceRole("apps/control-center/tests/example.test.mjs"), "test");
  assert.equal(sourceRole("apps/control-center/.probe.mjs"), "local-probe");
  assert.equal(sourceRole("apps/control-center/public/vendor/lib.js"), null);
  assert.equal(sourceRole("apps/desktop/src-tauri/target/debug/build.rs"), null);
  assert.equal(sourceRole(".codex/hooks/check.py"), "tooling");
  assert.equal(sourceRole("config/credentials.json"), null);
});

test("inventory binds parser results to bytes without executing source or claiming human review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "514cc-source-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/good.mjs"), 'throw new Error("must not execute");\n');
  await writeFile(join(root, "src/bad.mjs"), "export const = ;\n");
  const records = await inspectSources(["src/good.mjs", "src/bad.mjs", "src/missing.mjs"], { repoRoot: root, checkJavaScript: true });
  assert.equal(records.find((file) => file.path === "src/good.mjs").syntax, "passed");
  assert.equal(records.find((file) => file.path === "src/bad.mjs").syntax, "failed");
  assert.equal(records.find((file) => file.path === "src/missing.mjs").inspection, "unavailable");
  assert.equal(records[0].review, "not-recorded");
  assert.match(records[0].sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(inspectSources(["../outside.mjs"], { repoRoot: root }), /inside the repository/);
});
