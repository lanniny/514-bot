import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretSweepService } from "../src/secret-sweep.mjs";

test("secret sweep scans bounded data files, reports rule names only, and persists latest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "secret-sweep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "automations.json"), JSON.stringify([
    { name: "ok", prompt: "体检一次" },
    { name: "leaky", prompt: "使用 GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 跑" },
  ]), "utf8");
  await writeFile(join(root, "macros.json"), JSON.stringify({ macros: [{ token: "/ok", promptTemplate: "没事" }] }), "utf8");
  const events = [];
  const service = createSecretSweepService({
    dataRoot: root,
    aiSharedRoot: root,
    eventStore: { emit: async (type, data) => events.push({ type, data }) },
  });

  const report = await service.sweep();
  assert.equal(report.schema, "514cc.secret-sweep/v1");
  assert.ok(report.scannedFiles >= 2);
  assert.ok(report.findingCount >= 1, "the leaky automation prompt trips at least one rule");
  assert.equal(report.findings[0].file, "automations.json");
  // 报告绝不回传密钥内容：findings 里只有规则描述文本
  assert.equal(JSON.stringify(report).includes("ghp_abcdefghijklmnopqrstuvwxyz"), false);
  assert.deepEqual(events, [{ type: "security.secret_sweep", data: { findingCount: report.findingCount, scannedFiles: report.scannedFiles } }]);

  const latest = await service.latest();
  assert.ok((latest?.findingCount ?? 0) >= 1, "latest report persisted");
});

test("secret sweep reports missing files honestly and tolerates missing persistence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "secret-sweep-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createSecretSweepService({ dataRoot: root, aiSharedRoot: join(root, "nope") });
  const report = await service.sweep();
  assert.ok(report.scannedFiles >= 0);
  assert.equal(report.findingCount, 0);
  assert.equal((await service.latest())?.findingCount, 0, "clean sweep still persists a latest report");
  assert.throws(() => createSecretSweepService({}), { name: "TypeError" });
});
