// live 配置备份台账与一键回退：清单归属 / 凭据载体不出服务端 / CAS 拒写 / 恢复可再回退 / 路径围栏
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ProviderStore } from "../src/providers.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(resolve(appRoot, ".test-provider-backups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const runtimeHome = join(root, "home");
  await mkdir(runtimeHome, { recursive: true });
  const store = await new ProviderStore({ dataRoot, runtimeHome }).init();
  return { root, dataRoot, runtimeHome, store, backupDir: join(dataRoot, "backups", "providers") };
}

const CLAUDE_PATH = [".claude", "settings.json"];

async function seedClaudeLive(runtimeHome, content) {
  await mkdir(join(runtimeHome, ".claude"), { recursive: true });
  await writeFile(join(runtimeHome, ...CLAUDE_PATH), content, "utf8");
}

async function createProvider(store, name, baseUrl) {
  return store.create({ name, baseUrl, apiKey: `sk-${name}-0123456789abcdef`, apps: { claude: true }, models: { claude: { model: "claude-sonnet-4-5" } } });
}

test("switchTo 留下的备份带归属清单：app/档案/原因/目标路径全部可回读", async (t) => {
  const { store, runtimeHome, backupDir } = await fixture(t);
  await seedClaudeLive(runtimeHome, `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://old.example.com" } }, null, 2)}\n`);
  const first = await createProvider(store, "First", "https://first.example.com");
  await store.switchTo("claude", first.id);

  const { backups, targets } = await store.listBackups();
  assert.equal(backups.length, 1);
  const entry = backups[0];
  assert.equal(entry.app, "claude");
  assert.equal(entry.providerId, first.id);
  assert.equal(entry.providerName, "First");
  assert.equal(entry.reason, "switch");
  assert.equal(entry.targetPath, "~/.claude/settings.json");
  assert.equal(entry.hasManifest, true);
  assert.equal(entry.restorable, true);
  assert.equal(entry.credential, false);
  assert.ok(entry.size > 0);
  // 登记表同时回报可恢复目标清单（前端空态说明用）
  assert.ok(targets.some((item) => item.displayPath === "~/.claude/settings.json" && item.app === "claude"));
  // 清单是 sidecar，不进备份列表本体
  const files = await readdir(backupDir);
  assert.equal(files.filter((name) => name.endsWith(".manifest.json")).length, 1);
});

test("一键回退：备份原文写回 live，且恢复自身再留一份备份（回退可再回退）", async (t) => {
  const { store, runtimeHome } = await fixture(t);
  const original = `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://old.example.com" }, keepMe: true }, null, 2)}\n`;
  await seedClaudeLive(runtimeHome, original);
  const provider = await createProvider(store, "Switched", "https://switched.example.com");
  await store.switchTo("claude", provider.id);

  const livePath = join(runtimeHome, ...CLAUDE_PATH);
  const afterSwitch = await readFile(livePath, "utf8");
  assert.match(afterSwitch, /switched\.example\.com/);

  const [entry] = (await store.listBackups()).backups;
  const restored = await store.restoreBackup(entry.name);
  assert.equal(restored.app, "claude");
  assert.equal(restored.target, "~/.claude/settings.json");
  assert.ok(restored.undoBackup, "恢复前应为当前内容再留一份备份");
  assert.equal(await readFile(livePath, "utf8"), original);

  const after = await store.listBackups();
  assert.equal(after.backups.length, 2);
  const undo = after.backups.find((item) => item.name === restored.undoBackup);
  assert.equal(undo.reason, "restore");
  // 再回退一次 = 回到切换后的内容
  await store.restoreBackup(undo.name);
  assert.equal(await readFile(livePath, "utf8"), afterSwitch);
});

test("readBackup：普通配置回脱敏内容 + 双摘要；凭据载体内容不出服务端", async (t) => {
  const { store, runtimeHome } = await fixture(t);
  await seedClaudeLive(runtimeHome, `${JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-secret-plaintext-value-1234567890" } }, null, 2)}\n`);
  await mkdir(join(runtimeHome, ".gemini"), { recursive: true });
  await writeFile(join(runtimeHome, ".gemini", ".env"), "GOOGLE_GEMINI_BASE_URL=https://old.gemini.example.com\nGEMINI_API_KEY=key-plaintext-abcdefghij\n", "utf8");
  const provider = await store.create({
    name: "Dual", baseUrl: "https://dual.example.com", apiKey: "sk-dual-0123456789abcdef",
    apps: { claude: true, gemini: true }, models: { claude: { model: "claude-sonnet-4-5" }, gemini: { model: "gemini-2.5-pro" } },
  });
  await store.switchTo("claude", provider.id);
  await store.switchTo("gemini", provider.id);

  const { backups } = await store.listBackups();
  const claudeEntry = backups.find((item) => item.targetPath === "~/.claude/settings.json");
  const geminiEntry = backups.find((item) => item.targetPath === "~/.gemini/.env");

  const claudeRead = await store.readBackup(claudeEntry.name);
  assert.equal(claudeRead.contentHidden, false);
  assert.ok(!claudeRead.content.includes("sk-secret-plaintext-value-1234567890"), "备份预览必须脱敏密钥");
  assert.equal(claudeRead.redacted, true);
  assert.match(claudeRead.digest, /^[0-9a-f]{64}$/);
  assert.match(claudeRead.currentDigest, /^[0-9a-f]{64}$/);

  const geminiRead = await store.readBackup(geminiEntry.name);
  assert.equal(geminiRead.credential, true);
  assert.equal(geminiRead.contentHidden, true);
  assert.equal(geminiRead.content, "");
  assert.ok(!JSON.stringify(geminiRead).includes("key-plaintext-abcdefghij"));
  // 凭据载体不能预览，但仍可恢复（原文只在服务端流动）
  const restored = await store.restoreBackup(geminiEntry.name);
  assert.equal(restored.target, "~/.gemini/.env");
  assert.match(await readFile(join(runtimeHome, ".gemini", ".env"), "utf8"), /old\.gemini\.example\.com/);
});

test("expectedDigest 不匹配即 409 拒绝恢复，不覆盖别人刚改的 live 文件", async (t) => {
  const { store, runtimeHome } = await fixture(t);
  await seedClaudeLive(runtimeHome, `${JSON.stringify({ env: {} }, null, 2)}\n`);
  const provider = await createProvider(store, "Casing", "https://casing.example.com");
  await store.switchTo("claude", provider.id);
  const [entry] = (await store.listBackups()).backups;
  const stale = createHash("sha256").update("someone else's content").digest("hex");
  await assert.rejects(() => store.restoreBackup(entry.name, { expectedDigest: stale }), (error) => {
    assert.equal(error.code, "BACKUP_TARGET_CHANGED");
    return true;
  });
  // 真实摘要通过
  const fresh = await store.readBackup(entry.name);
  const ok = await store.restoreBackup(entry.name, { expectedDigest: fresh.currentDigest });
  assert.equal(ok.backup, entry.name);
});

test("无清单历史备份：basename 唯一命中可恢复，同名多目标如实标不可自动恢复", async (t) => {
  const { store, runtimeHome, backupDir } = await fixture(t);
  await mkdir(backupDir, { recursive: true });
  // 唯一命中（config.toml 在登记表里同时属 codex/grok/kimi → 多目标；
  // settings.json 自 v4.0 antigravity 加入后同属 claude + antigravity，也是多目标）
  await writeFile(join(backupDir, "20260812-101010-settings.json"), '{"env":{}}\n', "utf8");
  await writeFile(join(backupDir, "20260812-101011-config.toml"), "model = \"x\"\n", "utf8");
  await writeFile(join(backupDir, "20260812-101012-openclaw.json"), "{}\n", "utf8");

  const { backups } = await store.listBackups();
  const settings = backups.find((item) => item.name.endsWith("settings.json"));
  const toml = backups.find((item) => item.name.endsWith("config.toml"));
  const openclaw = backups.find((item) => item.name.endsWith("openclaw.json"));

  assert.equal(settings.hasManifest, false);
  assert.equal(settings.restorable, false, "settings.json 同属 claude + antigravity，多目标不可自动恢复");
  assert.equal(settings.unresolved, "ambiguous");
  assert.equal(toml.restorable, false);
  assert.equal(toml.unresolved, "ambiguous");
  assert.equal(openclaw.restorable, true);
  await assert.rejects(() => store.restoreBackup(toml.name), (error) => {
    assert.equal(error.code, "BACKUP_TARGET_UNRESOLVED");
    return true;
  });
  assert.equal((await readdir(runtimeHome)).includes(".codex"), false, "不可解析的备份绝不写盘");
});

test("路径围栏：备份名不接目录穿越，手改清单指向表外路径等同无清单", async (t) => {
  const { store, runtimeHome, backupDir } = await fixture(t);
  await mkdir(backupDir, { recursive: true });
  for (const bad of ["../escape.json", "sub/dir.json", "..", "x.manifest.json"]) {
    await assert.rejects(() => store.readBackup(bad), (error) => {
      assert.ok(["BACKUP_NAME_INVALID", "BACKUP_NOT_FOUND"].includes(error.code), `unexpected code ${error.code}`);
      return true;
    });
  }
  // 手改清单越权：target 不在登记表内 → 退化为 basename 归属（此处 basename 无命中 → 不可恢复）
  await writeFile(join(backupDir, "20260812-101013-evil.txt"), "pwned\n", "utf8");
  await writeFile(
    join(backupDir, "20260812-101013-evil.txt.manifest.json"),
    JSON.stringify({ schema: "514cc.provider-backup/v1", target: join(runtimeHome, "..", "escaped.txt"), app: "claude" }),
    "utf8",
  );
  const entry = (await store.listBackups()).backups.find((item) => item.name.endsWith("evil.txt"));
  assert.equal(entry.restorable, false);
  assert.equal(entry.unresolved, "no-target");
  await assert.rejects(() => store.restoreBackup(entry.name), (error) => {
    assert.equal(error.code, "BACKUP_TARGET_UNRESOLVED");
    return true;
  });
});

test("removeBackup：只删该份备份与它的清单，其余台账不动", async (t) => {
  const { store, runtimeHome, backupDir } = await fixture(t);
  await seedClaudeLive(runtimeHome, '{"env":{}}\n');
  const provider = await createProvider(store, "Prune", "https://prune.example.com");
  await store.switchTo("claude", provider.id);
  await store.switchTo("claude", provider.id);
  const before = (await store.listBackups()).backups;
  assert.equal(before.length, 2);
  const removed = await store.removeBackup(before[0].name);
  assert.equal(removed.removed, before[0].name);
  const after = (await store.listBackups()).backups;
  assert.equal(after.length, 1);
  assert.equal(after[0].name, before[1].name);
  const files = await readdir(backupDir);
  assert.equal(files.includes(`${before[0].name}.manifest.json`), false);
});

test("按 app 过滤备份台账", async (t) => {
  const { store, runtimeHome } = await fixture(t);
  await seedClaudeLive(runtimeHome, '{"env":{}}\n');
  await mkdir(join(runtimeHome, ".kimi-code"), { recursive: true });
  await writeFile(join(runtimeHome, ".kimi-code", "config.toml"), 'default_model = "old"\n', "utf8");
  const provider = await store.create({
    name: "Filter", baseUrl: "https://filter.example.com", apiKey: "sk-filter-0123456789abcdef",
    apps: { claude: true, kimi: true }, models: { claude: { model: "claude-sonnet-4-5" }, kimi: { model: "kimi-k2" } },
  });
  await store.switchTo("claude", provider.id);
  await store.switchTo("kimi", provider.id);
  const claudeOnly = await store.listBackups({ app: "claude" });
  assert.equal(claudeOnly.backups.length, 1);
  assert.equal(claudeOnly.backups[0].app, "claude");
  const kimiOnly = await store.listBackups({ app: "kimi" });
  assert.equal(kimiOnly.backups.length, 1);
  assert.equal(kimiOnly.backups[0].app, "kimi");
});
