import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDefaultControlConfig } from "../src/default-config.mjs";
import { copyRuntimeTree } from "../scripts/build-portable.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

test("two kernel generations use their own contracts while preserving the same user configuration", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-portable-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoRoot = resolve(root, "workspace");
  for (const [name, content] of Object.entries(createDefaultControlConfig())) {
    await mkdir(dirname(resolve(repoRoot, name)), { recursive: true });
    await writeFile(resolve(repoRoot, name), content);
  }
  const older = JSON.stringify({ $defs: { routingPolicy: { properties: { requireHealthyProvider: { const: true } } } } });
  const current = await readFile(new URL("../../../schemas/control-center/contracts.schema.json", import.meta.url), "utf8");
  const stalePath = resolve(repoRoot, "schemas/control-center/contracts.schema.json");
  await mkdir(dirname(stalePath), { recursive: true });
  await writeFile(stalePath, older);
  async function generation(name, schema) {
    const bundle = resolve(root, name);
    const kernel = resolve(bundle, "resources/control-center");
    await copyRuntimeTree(resolve(appRoot, "src"), resolve(kernel, "src"));
    const schemaPath = resolve(kernel, "schemas/control-center/contracts.schema.json");
    await mkdir(dirname(schemaPath), { recursive: true });
    await writeFile(schemaPath, schema);
    const marker = resolve(bundle, "514cc-bundle.json");
    await writeFile(marker, JSON.stringify({ schema: "514cc.portable/v1" }));
    const { ConfigManager } = await import(pathToFileURL(resolve(kernel, "src/config-manager.mjs")).href);
    const manager = await new ConfigManager({ repoRoot, dataRoot: resolve(root, "data"),
      registryPath: resolve(repoRoot, "config/control-center/sources.json"), eventStore: { emit: async () => {} } }).init();
    return { manager, marker, schemaPath };
  }
  const first = await generation("v1", older);
  const second = await generation("v2", current);
  const id = "control.routing";
  const original = await first.manager.read(id);
  const content = JSON.stringify({ ...JSON.parse(original.content), requireHealthyProvider: false });
  assert.equal((await first.manager.validate(id, content)).valid, false);
  assert.equal((await second.manager.validate(id, content)).valid, true);
  const plan = await second.manager.plan(id, content, original.sha256);
  assert.equal(plan.validation.valid, true);
  await second.manager.apply(id, { content, baseSha256: original.sha256, planId: plan.planId, confirmation: id });
  assert.equal((await first.manager.read(id)).content, content);
  assert.equal(await readFile(stalePath, "utf8"), older);
  const invalid = JSON.stringify({ ...JSON.parse(content), maxRounds: "invalid" });
  assert.equal((await second.manager.validate(id, invalid)).valid, false);
  for (const failure of ["broken-json", "missing-schema", "missing-manifest"]) {
    if (failure === "broken-json") await writeFile(second.schemaPath, "{");
    if (failure === "missing-schema") await rm(second.schemaPath);
    if (failure === "missing-manifest") { await writeFile(second.schemaPath, current); await rm(second.marker); }
    const validation = await second.manager.validate(id, content);
    assert.equal(validation.valid, false, failure);
    assert.match(validation.errors.join(" "), /cannot load control schema/);
    const currentSource = await second.manager.read(id);
    await assert.rejects(second.manager.apply(id, { content, baseSha256: currentSource.sha256, confirmation: id }), { code: "VALIDATION_FAILED" });
    assert.equal((await second.manager.read(id)).content, content);
  }
});
