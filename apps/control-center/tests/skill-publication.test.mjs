import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderStore } from "../src/providers.mjs";
import { CcSwitchDomainService } from "../src/ccswitch/domain.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "514cc-skill-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const runtimeHome = join(root, "home");
  await mkdir(runtimeHome);
  const providerStore = await new ProviderStore({ dataRoot, runtimeHome }).init();
  const domain = await new CcSwitchDomainService({ dataRoot, runtimeHome, providerStore }).init();
  return { dataRoot, runtimeHome, domain, providerStore };
}
const skill = (name, body = "old", apps = {}) => ({ name, files: { "SKILL.md": `# ${body}\n` }, apps });
const readSkill = (root, name) => readFile(join(root, name, "SKILL.md"), "utf8");
function mockFs(t, name, handler) {
  const original = fs.promises[name];
  const mock = t.mock.method(fs.promises, name, (...args) => handler(original, ...args));
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

test("skill publication never treats another valid .old skill as disposable backup", async (t) => {
  const { domain } = await fixture(t);
  await domain.installSkillFiles(skill("demo.old", "neighbor"));
  await domain.installSkillFiles(skill("demo"));
  await domain.installSkillFiles(skill("demo", "new"));
  assert.equal(await readSkill(domain.skillRoot, "demo.old"), "# neighbor\n");
  assert.equal(await readSkill(domain.skillRoot, "demo"), "# new\n");
});

test("invalid skill metadata or file paths leave both versions and the staging namespace unchanged", async (t) => {
  const { domain } = await fixture(t);
  await domain.installSkillFiles(skill("demo"));
  const before = await readdir(domain.skillRoot);
  await assert.rejects(domain.installSkillFiles({ ...skill("demo", "invalid"), description: "x".repeat(1001) }), { code: "VALIDATION_FAILED" });
  await assert.rejects(domain.installSkillFiles({ ...skill("demo", "invalid"), files: { "SKILL.md": "new", "../outside": "bad" } }), { code: "VALIDATION_FAILED" });
  assert.equal(await readSkill(domain.skillRoot, "demo"), "# old\n");
  assert.deepEqual(await readdir(domain.skillRoot), before);
});

test("a domain-store publication failure restores the canonical and every live skill without changing metadata", async (t) => {
  const { domain, runtimeHome, dataRoot, providerStore } = await fixture(t);
  await domain.installSkillFiles(skill("demo", "old", { claude: true, codex: true }));
  const before = JSON.stringify(domain.skills());
  const stored = await readFile(domain.path, "utf8");
  mockFs(t, "rename", (original, source, target) => {
    if (target === domain.path) throw Object.assign(new Error("injected store failure"), { code: "EIO" });
    return original(source, target);
  });
  await assert.rejects(domain.installSkillFiles(skill("demo", "new")));
  for (const root of [domain.skillRoot, join(runtimeHome, ".claude/skills"), join(runtimeHome, ".codex/skills")]) assert.equal(await readSkill(root, "demo"), "# old\n");
  assert.equal(JSON.stringify(domain.skills()), before);
  assert.equal(await readFile(domain.path, "utf8"), stored);
  const reloaded = await new CcSwitchDomainService({ dataRoot, runtimeHome, providerStore }).init();
  assert.equal(JSON.stringify(reloaded.skills()), before);
});

test("an enabled skill rename and explicit disable remove old live locations without losing its canonical files", async (t) => {
  const { domain, runtimeHome } = await fixture(t);
  await domain.installSkillFiles(skill("old-name", "old", { claude: true, codex: true }));
  await domain.installSkillFiles({ ...skill("new-name", "new", { codex: false }), id: "old-name" });
  assert.equal(await readSkill(domain.skillRoot, "old-name"), "# new\n");
  assert.equal(await readSkill(join(runtimeHome, ".claude/skills"), "new-name"), "# new\n");
  await assert.rejects(readSkill(join(runtimeHome, ".claude/skills"), "old-name"), { code: "ENOENT" });
  await assert.rejects(readSkill(join(runtimeHome, ".codex/skills"), "old-name"), { code: "ENOENT" });
});

test("skill publication uses bounded transient rename retry without deleting the target to force success", async (t) => {
  const { domain } = await fixture(t);
  await domain.installSkillFiles(skill("demo"));
  let attempts = 0;
  mockFs(t, "rename", (original, source, target) => {
    if (target === join(domain.skillRoot, "demo") && source.endsWith(".stage")) {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error("temporary lock"), { code: "EPERM" });
    }
    return original(source, target);
  });
  await domain.installSkillFiles(skill("demo", "new"));
  assert.equal(attempts, 3);
  assert.equal(await readSkill(domain.skillRoot, "demo"), "# new\n");
});

test("failed rollback freezes further writes across restart while preserving recovery directories", async (t) => {
  const { domain, dataRoot, runtimeHome, providerStore } = await fixture(t);
  await domain.installSkillFiles(skill("demo"));
  mockFs(t, "rename", (original, source, target) => {
    if (target === domain.path || source.endsWith(".previous")) throw Object.assign(new Error("unrecoverable fixture lock"), { code: "EIO" });
    return original(source, target);
  });
  await assert.rejects(domain.installSkillFiles(skill("demo", "new")), { code: "SKILL_TRANSACTION_RECOVERY_REQUIRED" });
  assert.equal(domain.storeStatus.state, "blocked");
  const entries = await readdir(domain.skillRoot);
  assert.ok(entries.some((entry) => entry.endsWith(".previous")));
  await assert.rejects(domain.installSkillFiles(skill("another")), { code: "SKILL_TRANSACTION_RECOVERY_REQUIRED" });
  const restarted = await new CcSwitchDomainService({ dataRoot, runtimeHome, providerStore }).init();
  assert.equal(restarted.storeStatus.state, "blocked");
  await assert.rejects(restarted.toggleSkill("demo", "claude", true), { code: "SKILL_TRANSACTION_RECOVERY_REQUIRED" });
});

test("app directory overrides cannot disable or overwrite a canonical library through an alias", async (t) => {
  const { domain, dataRoot } = await fixture(t);
  await domain.installSkillFiles(skill("demo"));
  await domain.setConfigDir("claude", join(dataRoot, "ccswitch"));
  await domain.toggleSkill("demo", "claude", true);
  await assert.rejects(domain.toggleSkill("demo", "claude", false), { code: "SKILL_TARGET_CONFLICT" });
  assert.equal(await readSkill(domain.skillRoot, "demo"), "# old\n");
  assert.equal(domain.skills()[0].apps.claude, true);
});

test("shared app directories cannot lose an enabled binding or be claimed by another skill", async (t) => {
  const { domain, runtimeHome } = await fixture(t);
  const shared = join(runtimeHome, "shared");
  await domain.setConfigDir("claude", shared);
  await domain.setConfigDir("codex", shared);
  await domain.installSkillFiles(skill("demo", "old", { claude: true, codex: true }));
  await assert.rejects(domain.toggleSkill("demo", "claude", false), { code: "SKILL_TARGET_CONFLICT" });
  assert.equal(domain.skills()[0].apps.claude, true);
  assert.equal(domain.skills()[0].apps.codex, true);
  assert.equal(await readSkill(join(shared, "skills"), "demo"), "# old\n");
  await domain.installSkillFiles(skill("demo", "old", { claude: false, codex: false }));
  await domain.toggleSkill("demo", "claude", true);
  await assert.rejects(domain.installSkillFiles({ ...skill("demo", "conflict", { codex: true }), id: "other" }), { code: "SKILL_TARGET_CONFLICT" });
  assert.equal(await readSkill(join(shared, "skills"), "demo"), "# old\n");
});

test("post-commit journal failure is reported and stops the remaining live synchronization writes", async (t) => {
  const { domain, runtimeHome } = await fixture(t);
  await domain.installSkillFiles(skill("demo", "old", { claude: true }));
  await domain.upsertPrompt("claude", { name: "active", content: "managed prompt", enabled: true });
  const promptPath = join(runtimeHome, ".claude", "CLAUDE.md");
  await writeFile(promptPath, "external sentinel");
  mockFs(t, "rename", async (original, source, target) => {
    if (target.startsWith(domain.skillJournalRoot) && JSON.parse(await readFile(source, "utf8")).phase === "committed") throw Object.assign(new Error("injected journal failure"), { code: "EIO" });
    return original(source, target);
  });
  const warnings = await domain.syncAllLive({ apps: ["claude"] });
  assert.ok(warnings.some((item) => item.kind === "skill" && item.message === "SKILL_TRANSACTION_RECOVERY_REQUIRED"));
  assert.equal(domain.storeStatus.state, "blocked");
  assert.equal(await readFile(promptPath, "utf8"), "external sentinel");
  await assert.rejects(domain.syncAllLive({ apps: ["claude"] }), { code: "SKILL_TRANSACTION_RECOVERY_REQUIRED" });
});

test("disabling or uninstalling a parent directory cannot remove a remaining nested live skill", async (t) => {
  const { domain, runtimeHome } = await fixture(t);
  await domain.installSkillFiles(skill("parent", "parent", { claude: true }));
  await domain.installSkillFiles(skill("child", "child", { codex: true }));
  const nestedConfig = join(runtimeHome, ".claude", "skills", "parent");
  await domain.setConfigDir("codex", nestedConfig);
  await mkdir(join(nestedConfig, "skills", "child"), { recursive: true });
  await writeFile(join(nestedConfig, "skills", "child", "SKILL.md"), "nested sentinel");
  await assert.rejects(domain.toggleSkill("parent", "claude", false), { code: "SKILL_TARGET_CONFLICT" });
  await assert.rejects(domain.uninstallSkill("parent", { confirmed: true }), { code: "SKILL_TARGET_CONFLICT" });
  assert.equal(await readSkill(join(nestedConfig, "skills"), "child"), "nested sentinel");
  assert.equal(domain.skills().find((item) => item.id === "parent").apps.claude, true);
});

test("exclusive copy works with runtimes that reject an already-created destination directory", async (t) => {
  const { domain } = await fixture(t);
  mockFs(t, "cp", async (original, source, target, options) => {
    const exists = await fs.promises.lstat(target).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
    if (options?.errorOnExist && exists) throw Object.assign(new Error("strict exclusive copy"), { code: "ERR_FS_CP_EEXIST" });
    return original(source, target, options);
  });
  await domain.installSkillFiles({ ...skill("strict-copy"), files: { "SKILL.md": "old", "scripts/nested/run.mjs": "old" }, apps: { claude: true } });
  await domain.installSkillFiles({ ...skill("strict-copy"), files: { "SKILL.md": "new", "scripts/nested/run.mjs": "new" } });
  assert.equal(await readSkill(domain.skillRoot, "strict-copy"), "new");
});
