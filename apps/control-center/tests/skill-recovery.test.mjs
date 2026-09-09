import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRecovery } from "../src/ccswitch/skill-recovery.mjs";
import { skillDigest, skillTreeProof } from "../src/ccswitch/skill-recovery-proof.mjs";
import { listSkillPublications } from "../src/ccswitch/skill-publication.mjs";

async function fixture(t, outcome = "after") {
  const root = await mkdtemp(join(tmpdir(), "514cc-recovery-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journalRoot = join(root, "journals"), skillRoot = join(root, "skills"), target = join(skillRoot, "demo"), statePath = join(root, "state.json");
  await mkdir(journalRoot); await mkdir(target, { recursive: true });
  const old = '{"v":1}', current = '{"v":2}';
  await writeFile(join(target, "SKILL.md"), "old"); const beforeDigest = await skillTreeProof(target);
  await writeFile(join(target, "SKILL.md"), "new"); const afterDigest = await skillTreeProof(target);
  if (outcome === "before") await writeFile(join(target, "SKILL.md"), "old");
  await writeFile(statePath, outcome === "after" ? current : old);
  const id = randomUUID();
  const journal = { schema: "514cc.skill-publication/v2", id, phase: "pending", stateProof: { before: skillDigest(Buffer.from(old)), after: skillDigest(Buffer.from(current)) }, records: [{ target, beforeDigest, afterDigest }] };
  const path = join(journalRoot, `${id}.json`); await writeFile(path, JSON.stringify(journal));
  let now = Date.now();
  const recovery = new SkillRecovery({ journalRoot, backupRoot: join(root, "backups"), statePath, roots: () => [skillRoot], validateState: (value) => value, clock: () => now });
  return { recovery, id, target, statePath, path, journal, expire: () => { now += 60001; } };
}
for (const outcome of ["before", "after"]) test(`recovery confirms consistent ${outcome} state without changing live files`, async (t) => {
  const f = await fixture(t, outcome), plan = await f.recovery.check(f.id);
  assert.equal(plan.status, "ready"); assert.equal(plan.outcome, outcome === "after" ? "committed" : "rolled-back");
  const before = await readFile(f.statePath, "utf8"), live = await readFile(join(f.target, "SKILL.md"), "utf8");
  await f.recovery.confirm(f.id, { confirmed: true, planToken: plan.planToken });
  assert.equal(await readFile(f.statePath, "utf8"), before); assert.equal(await readFile(join(f.target, "SKILL.md"), "utf8"), live);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).recovery.mode, "record-only");
  await assert.rejects(f.recovery.confirm(f.id, { confirmed: true, planToken: plan.planToken }), { code: "SKILL_RECOVERY_PLAN_EXPIRED" });
});
test("recovery rejects mixed state, expiry and changes made after check", async (t) => {
  const f = await fixture(t);
  const plan = await f.recovery.check(f.id); f.expire();
  await assert.rejects(f.recovery.confirm(f.id, { confirmed: true, planToken: plan.planToken }), { code: "SKILL_RECOVERY_PLAN_EXPIRED" });
  const fresh = await f.recovery.check(f.id);
  await writeFile(join(f.target, "SKILL.md"), "outside update");
  await assert.rejects(f.recovery.confirm(f.id, { confirmed: true, planToken: fresh.planToken }), { code: "SKILL_RECOVERY_CHANGED" });
  assert.equal((await f.recovery.check(f.id)).reason, "SKILL_RECOVERY_MIXED_STATE");
});
test("legacy journals and paths outside server-owned roots remain blocked", async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, JSON.stringify({ ...f.journal, schema: "514cc.skill-publication/v1" }));
  assert.equal((await f.recovery.check(f.id)).reason, "SKILL_RECOVERY_LEGACY");
  f.journal.records[0].target = join(tmpdir(), "outside");
  await writeFile(f.path, JSON.stringify(f.journal));
  assert.equal((await f.recovery.check(f.id)).reason, "SKILL_RECOVERY_PATH_FORBIDDEN");
});
test("retained non-journal entries do not freeze recovery after 4096 publications", async (t) => {
  const f = await fixture(t);
  const original = fs.promises.opendir;
  const mock = t.mock.method(fs.promises, "opendir", async (path) => path === f.recovery.journalRoot ? {
    async *[Symbol.asyncIterator]() { for (let index = 0; index < 4100; index++) yield { name: `${index}.tmp` }; yield { name: `${f.id}.json` }; },
  } : original(path));
  syncBuiltinESMExports();
  try { const result = await listSkillPublications(f.recovery.journalRoot); assert.equal(result.unavailable, false); assert.equal(result.items[0].id, f.id); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
});
