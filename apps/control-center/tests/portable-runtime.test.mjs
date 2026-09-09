import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultControlConfig } from "../src/default-config.mjs";
import { validateRuntimeGraph } from "../src/app.mjs";
import { copyRuntimeTree, fingerprintTree } from "../scripts/build-portable.mjs";
import { resolveControlSchemaPath } from "../src/paths.mjs";

test("portable defaults have no developer configuration and retain governed runtime modes", () => {
  const files = createDefaultControlConfig();
  const config = (name) => JSON.parse(files[`config/control-center/${name}.json`]);
  const models = config("models");
  assert.deepEqual(models.profiles.map(profile => profile.id), ["claude-fable", "codex-technical", "grok-build", "kimi-frontend", "pi-resident"]);
  assert.ok(models.profiles.every((profile) => !profile.providerId && !profile.apiKey && !profile.systemPromptFile));
  assert.ok(models.profiles.every((profile) => !profile.command || !/[\\/]/.test(profile.command)));
  assert.equal(config("permissions").defaultMode, "plan");
  assert.equal(config("permissions").modes.build.approvalRequired, true);
  assert.ok(config("permissions").modes["full-access"]);
  validateRuntimeGraph({ models, routing: config("routing"), permissions: config("permissions") });
});

test("core JSON schemas validate with bundled Node and no system Python on PATH", async () => {
  const source = new URL("../src/json-schema-worker.mjs", import.meta.url);
  const schema = JSON.parse(await readFile(new URL("../../../schemas/control-center/contracts.schema.json", import.meta.url)));
  const input = { schema, definition: "permissionPolicy", instance: JSON.parse(createDefaultControlConfig()["config/control-center/permissions.json"]) };
  const run = (value) => new Promise((resolveRun, reject) => {
    const child = execFile(process.execPath, [fileURLToPath(source)], {
      windowsHide: true, env: { ...process.env, PATH: "", Path: "" }, timeout: 15_000,
    }, (error, stdout) => error ? reject(Object.assign(error, { message: stdout || error.message })) : resolveRun(stdout));
    child.stdin.end(JSON.stringify(value));
  });
  assert.deepEqual(JSON.parse(await run(input)), []);
  for (const [name, definition] of [["models", "modelRegistry"], ["routing", "routingPolicy"], ["sources", "sourceRegistry"]]) {
    assert.deepEqual(JSON.parse(await run({ schema, definition, instance: JSON.parse(createDefaultControlConfig()[`config/control-center/${name}.json`]) })), []);
  }
  await assert.rejects(run({ ...input, instance: { ...input.instance, defaultMode: "invalid-mode" } }));
});

test("runtime copy refuses overwrite and fingerprints exact file bytes", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "514cc-portable-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, "source"));
  await writeFile(resolve(root, "source/file.mjs"), "source bytes");
  await copyRuntimeTree(resolve(root, "source"), resolve(root, "target"));
  const files = await fingerprintTree(resolve(root, "target"));
  assert.equal(files[0].path, "file.mjs");
  assert.match(files[0].sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(copyRuntimeTree(resolve(root, "source"), resolve(root, "target")), { code: "EEXIST" });
});

test("portable schema belongs to the running kernel and never falls back to a stale seed", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "514cc-contract-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = resolve(root, "bundle/resources/control-center");
  const source = resolve(root, "user/config/control-center/routing.json");
  const oldSchema = resolve(root, "user/schemas/control-center/contracts.schema.json");
  await mkdir(resolve(root, "bundle"));
  await mkdir(resolve(root, "user/schemas/control-center"), { recursive: true });
  await writeFile(oldSchema, "{\"old\":true}");
  assert.equal(await resolveControlSchemaPath(source, resolve(root, "repo/apps/control-center")), oldSchema);
  await assert.rejects(resolveControlSchemaPath(source, appRoot), /manifest is missing/);
  const marker = resolve(root, "bundle/514cc-bundle.json");
  await writeFile(marker, JSON.stringify({ schema: "514cc.portable/v1" }));
  const current = resolve(appRoot, "schemas/control-center/contracts.schema.json");
  assert.equal(await resolveControlSchemaPath(source, appRoot), current);
  await assert.rejects(readFile(current), { code: "ENOENT" });
  assert.equal(await readFile(oldSchema, "utf8"), "{\"old\":true}");
  await writeFile(marker, "{");
  await assert.rejects(resolveControlSchemaPath(source, appRoot), SyntaxError);
  await writeFile(marker, JSON.stringify({ schema: "unknown" }));
  await assert.rejects(resolveControlSchemaPath(source, appRoot), /unsupported portable/);
});
