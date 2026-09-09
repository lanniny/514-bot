import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

import { ccSwitchCapabilityEntries, CCSWITCH_UPSTREAM } from "../src/ccswitch/capability-map.mjs";
import {
  compareCommandCoverage,
  normalizeGeneratedLedger,
  validateCcSwitchMigration,
} from "../scripts/validate-ccswitch-migration.mjs";

test("CC-Switch 3.18.0 command ledger maps the pinned 287+1 registry baseline", async () => {
  const result = await validateCcSwitchMigration();
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  assert.equal(result.commandCount, 288);
  assert.equal(result.namespacedCommandCount, 287);
  assert.equal(typeof result.registryVerified, "boolean");
  assert.equal(Object.values(result.statuses).reduce((sum, count) => sum + count, 0), CCSWITCH_UPSTREAM.commandCount);
});

test("CC-Switch ledger comparison ignores Windows CRLF checkouts", async () => {
  const current = await readFile(resolve(repoRoot, "proposals/ccswitch-3.18.0-capability-ledger.md"), "utf8");
  assert.equal(normalizeGeneratedLedger("a\r\nb\r\n"), "a\nb\n");
  const root = await mkdtemp(join(tmpdir(), "ccswitch-ledger-"));
  const crlfLedger = join(root, "ccswitch-3.18.0-capability-ledger.md");
  await writeFile(crlfLedger, normalizeGeneratedLedger(current).replaceAll("\n", "\r\n"), "utf8");
  try {
    const result = await validateCcSwitchMigration({
      registryPath: resolve(".test-fixtures", "missing-ccswitch-registry.rs"),
      ledgerPath: crlfLedger,
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CC-Switch ledger stays valid when the optional upstream scratch tree is absent", async () => {
  const result = await validateCcSwitchMigration({
    registryPath: resolve(".test-fixtures", "missing-ccswitch-registry.rs"),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  assert.equal(result.registryVerified, false);
});

test("CC-Switch command coverage fails closed for a newly added or omitted command", () => {
  const mapped = ccSwitchCapabilityEntries();
  const registry = mapped.map((item) => item.command);
  const added = compareCommandCoverage([...registry, "new_upstream_command"], mapped);
  assert.deepEqual(added.missing, ["new_upstream_command"]);
  assert.equal(added.orderMatches, false);

  const omitted = compareCommandCoverage(registry, mapped.slice(0, -1));
  assert.deepEqual(omitted.missing, [registry.at(-1)]);
  assert.equal(omitted.orderMatches, false);
});
