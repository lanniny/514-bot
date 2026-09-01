import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarketService } from "../src/market.mjs";

async function fixture(t, fetchImpl = async () => { throw new Error("no fetch"); }) {
  const dir = await mkdtemp(join(tmpdir(), "514cc-market-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 测试域名 local.fixture 走本地文件分支，注入进 allowlist
  const service = createMarketService({
    dataRoot: dir,
    fetchImpl,
    skillHostAllowlist: ["local.fixture", "github.com", "codeload.github.com"],
  });
  return { dir, service };
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function storedZip(filename, content) {
  const name = Buffer.from(filename, "utf8");
  const data = Buffer.from(content, "utf8");
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralOffset = local.length + name.length + data.length;
  const centralSize = central.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

/** 在 temp 造一个含 SKILL.md 的无压缩 ZIP，零系统命令依赖。 */
async function makeSkillZip(t, rootDir, skillName = "demo-skill", withFrontmatter = true) {
  const stage = join(rootDir, "zip-src");
  await rm(stage, { recursive: true, force: true }).catch(() => {});
  await mkdir(stage, { recursive: true });
  const content = withFrontmatter
    ? `---\nname: ${skillName}\ndescription: 演示技能\n---\n\n# demo\n`
    : "# no frontmatter\n";
  await writeFile(join(stage, "SKILL.md"), content, "utf8");
  const zipPath = join(rootDir, `${skillName}.zip`);
  await writeFile(zipPath, storedZip("zip-src/SKILL.md", content));
  return zipPath;
}

test("market: mcp search normalizes entries; unreachable registry is an explicit 502", async (t) => {
  const fetchImpl = async (url) => {
    if (url.includes("registry.modelcontextprotocol.io")) {
      return { ok: true, json: async () => ({ servers: [{ server: { name: "io.x/fs", title: "Filesystem", description: "fs server" } }] }) };
    }
    throw new Error("boom");
  };
  const { service } = await fixture(t, fetchImpl);
  const items = await service.mcpSearch("fs", "official");
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "io.x/fs");
  assert.equal(items[0].source, "official");
  await assert.rejects(() => service.mcpSearch("x", "smithery"), { code: "MARKET_REGISTRY_UNREACHABLE" });
});

test("market: mcp stage → review report → install requires confirmation and records hash", async (t) => {
  const detail = { server: { name: "io.x/fs", title: "Filesystem", description: "d", command: "npx", args: ["-y", "@x/fs"], env: { API_KEY: "" } } };
  const fetchImpl = async () => ({ ok: true, json: async () => detail });
  const { service } = await fixture(t, fetchImpl);
  const staged = await service.mcpStage({ source: "official", id: "io.x/fs" });
  assert.equal(staged.review.command, "npx");
  assert.deepEqual(staged.review.envKeys, ["API_KEY"]);
  assert.ok(staged.review.hash.length === 64);

  await assert.rejects(() => service.mcpInstall({ stageId: staged.stageId }), { code: "MARKET_NOT_CONFIRMED" });
  const installed = await service.mcpInstall({ stageId: staged.stageId, confirmed: true });
  assert.equal(installed.ok, true);
  const ledger = await service.installedList();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].hash, staged.review.hash);
  // staging 已清
  await assert.rejects(() => service.mcpInstall({ stageId: staged.stageId, confirmed: true }), { code: "MARKET_STAGE_NOT_FOUND" });
});

test("market: skill url allowlist refuses non-allowlisted hosts and non-https", async (t) => {
  const { service } = await fixture(t);
  assert.throws(() => service.assertSkillUrl("http://github.com/x.zip"), { code: "MARKET_URL_FORBIDDEN" });
  assert.throws(() => service.assertSkillUrl("https://evil.example.com/x.zip"), { code: "MARKET_URL_FORBIDDEN" });
  assert.equal(service.assertSkillUrl("https://github.com/a/b/archive/main.zip").hostname, "github.com");
});

test("market: skill stage validates SKILL.md and rejects bad archives", async (t) => {
  const { dir, service } = await fixture(t);
  const goodZip = await makeSkillZip(t, dir, "good-skill", true);
  const staged = await service.skillsStage({ url: `https://local.fixture/${goodZip}` });
  assert.equal(staged.review.name, "good-skill");
  assert.equal(staged.review.description, "演示技能");
  assert.ok(staged.review.sha256.length === 64);
  assert.ok(staged.review.files.some((file) => String(file).endsWith("SKILL.md")));

  const badZip = await makeSkillZip(t, dir, "bad-skill", false);
  await assert.rejects(() => service.skillsStage({ url: `https://local.fixture/${badZip}` }), { code: "MARKET_SKILL_INVALID" });

  const traversalZip = join(dir, "traversal.zip");
  await writeFile(traversalZip, storedZip("../escaped/SKILL.md", "---\nname: escaped\ndescription: no\n---\n"));
  await assert.rejects(() => service.skillsStage({ url: `https://local.fixture/${traversalZip}` }), { code: "MARKET_ARCHIVE_PATH" });
  await assert.rejects(() => stat(join(dir, "market", "escaped", "SKILL.md")), { code: "ENOENT" });
});

test("market: skill install is atomic stage-then-swap and serialized under the write lock", async (t) => {
  const { dir, service } = await fixture(t);
  const zipA = await makeSkillZip(t, dir, "lock-skill", true);
  const stagedA = await service.skillsStage({ url: `https://local.fixture/${zipA}` });
  const zipB = await makeSkillZip(t, dir, "lock-skill2", true);
  // 同名第二份：改名复用
  const stagedB = await service.skillsStage({ url: `https://local.fixture/${zipB}` });

  const [first, second] = await Promise.all([
    service.skillsInstall({ stageId: stagedA.stageId, confirmed: true }),
    service.skillsInstall({ stageId: stagedB.stageId, confirmed: true }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const skills = await service.skillsList();
  assert.deepEqual(skills.map((skill) => skill.name).sort(), ["lock-skill", "lock-skill2"]);
  // 目标目录完整可读（swap 后无半残）
  const content = await readFile(join(dir, "market", "skills", "lock-skill", "SKILL.md"), "utf8");
  assert.ok(content.includes("name: lock-skill"));
  const ledger = await service.installedList();
  assert.equal(ledger.filter((entry) => entry.kind === "skill").length, 2);
});

test("market: skill remove also drops the installed ledger row", async (t) => {
  const { dir, service } = await fixture(t);
  const zip = await makeSkillZip(t, dir, "ledger-skill", true);
  const staged = await service.skillsStage({ url: `https://local.fixture/${zip}` });
  await service.skillsInstall({ stageId: staged.stageId, confirmed: true });
  assert.equal((await service.installedList()).some((item) => item.id === "ledger-skill"), true);
  assert.equal(await service.skillsRemove("ledger-skill"), true);
  assert.equal((await service.installedList()).some((item) => item.id === "ledger-skill"), false);
});

test("market: skill remove also asks ccswitch to uninstall a projected skill", async (t) => {
  const removed = [];
  const { dir } = await fixture(t);
  const service = createMarketService({
    dataRoot: dir,
    skillHostAllowlist: ["local.fixture", "github.com", "codeload.github.com"],
    ccswitchDomain: {
      installSkillFiles: async (input) => ({ id: input.name }),
      uninstallSkill: async (id, opts) => { removed.push({ id, confirmed: opts?.confirmed }); return { removed: id }; },
    },
  });
  const zip = await makeSkillZip(t, dir, "cli-skill", true);
  const staged = await service.skillsStage({ url: `https://local.fixture/${zip}` });
  await service.skillsInstall({ stageId: staged.stageId, confirmed: true });
  assert.equal(await service.skillsRemove("cli-skill"), true);
  assert.deepEqual(removed, [{ id: "cli-skill", confirmed: true }]);
});

test("market: skill install projects from the swapped copy, not the deleted stage", async (t) => {
  const projected = [];
  const { dir } = await fixture(t);
  const service = createMarketService({
    dataRoot: dir,
    skillHostAllowlist: ["local.fixture", "github.com", "codeload.github.com"],
    ccswitchDomain: {
      installSkillFiles: async (input) => {
        projected.push(Object.keys(input.files || {}));
        return { id: input.name };
      },
    },
  });
  const zip = await makeSkillZip(t, dir, "swap-skill", true);
  const staged = await service.skillsStage({ url: `https://local.fixture/${zip}` });
  await service.skillsInstall({ stageId: staged.stageId, confirmed: true });
  assert.equal(projected.length, 1);
  assert.equal(projected[0].some((name) => name.replace(/\\/g, "/").endsWith("SKILL.md")), true);
});

test("market: mcp update apps re-upserts the projected server", async (t) => {
  const upserts = [];
  const detail = { server: { name: "io.x/fs", title: "Filesystem", description: "d", command: "npx", args: ["-y", "@x/fs"] } };
  const { dir } = await fixture(t);
  const service = createMarketService({
    dataRoot: dir,
    fetchImpl: async () => ({ ok: true, json: async () => detail }),
    ccswitchDomain: {
      upsertMcp: async (input) => { upserts.push(input); return { id: input.id }; },
    },
  });
  const staged = await service.mcpStage({ source: "official", id: "io.x/fs" });
  await service.mcpInstall({ stageId: staged.stageId, confirmed: true, apps: { claude: true } });
  const updated = await service.mcpUpdateApps({ id: "io.x-fs", apps: { claude: true, kimi: true } });
  assert.equal(updated.apps.kimi, true);
  assert.equal(upserts.at(-1).apps.kimi, true);
  await assert.rejects(() => service.mcpUpdateApps({ id: "missing", apps: { claude: true } }), { code: "MARKET_NOT_FOUND" });
});

test("market: skill update apps re-projects and disables unchecked CLIs", async (t) => {
  const toggled = [];
  const { dir } = await fixture(t);
  const service = createMarketService({
    dataRoot: dir,
    skillHostAllowlist: ["local.fixture", "github.com", "codeload.github.com"],
    ccswitchDomain: {
      installSkillFiles: async (input) => ({ id: input.name, apps: input.apps }),
      toggleSkill: async (id, app, enabled) => { toggled.push({ id, app, enabled }); return { id }; },
    },
  });
  const zip = await makeSkillZip(t, dir, "proj-skill", true);
  const staged = await service.skillsStage({ url: `https://local.fixture/${zip}` });
  await service.skillsInstall({ stageId: staged.stageId, confirmed: true, apps: { claude: true, codex: true } });
  const updated = await service.skillUpdateApps({ name: "proj-skill", apps: { claude: true, codex: false } });
  assert.equal(updated.apps.claude, true);
  assert.equal(updated.apps.codex, false);
  assert.deepEqual(toggled, [{ id: "proj-skill", app: "codex", enabled: false }]);
});

test("market: scan all repos continues after one failure", async (t) => {
  const { service } = await fixture(t, async (url) => {
    if (String(url).includes("cexll")) throw new Error("boom");
    if (String(url).includes("/git/trees/")) {
      return { ok: true, json: async () => ({ tree: [{ path: "SKILL.md", type: "blob" }] }) };
    }
    if (String(url).includes("raw.githubusercontent.com")) {
      return { ok: true, text: async () => "---\nname: demo\ndescription: d\n---\n" };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  await service.addRepo({ url: "cexll/myclaude", branch: "main" });
  const result = await service.scanAllRepos();
  assert.equal(result.repos.some((item) => item.id === "cexll/myclaude" && item.ok === false), true);
  assert.equal(result.repos.some((item) => item.id === "anthropics/skills" && item.ok === true), true);
});

test("market: mcp remove drops ledger and asks ccswitch to delete a projected server", async (t) => {
  const removed = [];
  const detail = { server: { name: "io.x/fs", title: "Filesystem", description: "d", command: "npx", args: ["-y", "@x/fs"] } };
  const { dir } = await fixture(t);
  const service = createMarketService({
    dataRoot: dir,
    fetchImpl: async () => ({ ok: true, json: async () => detail }),
    ccswitchDomain: {
      upsertMcp: async (input) => ({ id: input.id }),
      deleteMcp: async (id) => { removed.push(id); return { removed: id }; },
    },
  });
  const staged = await service.mcpStage({ source: "official", id: "io.x/fs" });
  await service.mcpInstall({ stageId: staged.stageId, confirmed: true, apps: { claude: true } });
  const gone = await service.mcpRemove("io.x-fs");
  assert.equal(gone.removed, "io.x-fs");
  assert.deepEqual(removed, ["io.x-fs"]);
  assert.equal((await service.installedList()).length, 0);
  await assert.rejects(() => service.mcpRemove("missing"), { code: "MARKET_NOT_FOUND" });
});

test("market: skill remove deletes directory and refuses unsafe names", async (t) => {
  const { dir, service } = await fixture(t);
  const zip = await makeSkillZip(t, dir, "rm-skill", true);
  const staged = await service.skillsStage({ url: `https://local.fixture/${zip}` });
  await service.skillsInstall({ stageId: staged.stageId, confirmed: true });
  assert.ok((await stat(join(dir, "market", "skills", "rm-skill"))).isDirectory());
  assert.equal(await service.skillsRemove("rm-skill"), true);
  assert.equal(await service.skillsRemove("rm-skill"), false);
  await assert.rejects(() => service.skillsRemove("../x"), { code: "MARKET_BAD_ID" });
});

test("market: MCP 安装把 registry 配置投影进 ccswitch，缺 command/url 则拒绝", async (t) => {
  const calls = [];
  const detail = { server: { name: "io.x/fs", title: "Filesystem", description: "d", packages: [{ identifier: "@x/fs", registryType: "npm" }] } };
  const { dir } = await fixture(t);
  const withDomain = createMarketService({
    dataRoot: dir,
    fetchImpl: async () => ({ ok: true, json: async () => detail }),
    ccswitchDomain: { upsertMcp: async (input) => { calls.push(input); return { id: input.id }; } },
  });
  const staged = await withDomain.mcpStage({ source: "official", id: "io.x/fs" });
  assert.equal(staged.review.config.command, "npx");
  assert.deepEqual(staged.review.config.args, ["-y", "@x/fs"]);
  const installed = await withDomain.mcpInstall({
    stageId: staged.stageId,
    confirmed: true,
    apps: { claude: true, kimi: true, hermes: false },
  });
  assert.equal(installed.projected, true);
  assert.equal(calls[0].apps.kimi, true);
  assert.equal(calls[0].id, "io.x-fs");

  const { dir: emptyDir } = await fixture(t);
  const empty = createMarketService({
    dataRoot: emptyDir,
    fetchImpl: async () => ({ ok: true, json: async () => ({ server: { name: "bare", title: "Bare" } }) }),
  });
  const bare = await empty.mcpStage({ source: "official", id: "bare" });
  await assert.rejects(() => empty.mcpInstall({ stageId: bare.stageId, confirmed: true }), { code: "MARKET_MCP_INCOMPLETE" });
});

test("market: 仓库添加/扫描/目录，skillPath 能从多 skill zip 里取出指定目录", async (t) => {
  const { dir, service } = await fixture(t, async (url) => {
    if (String(url).includes("/git/trees/")) {
      return {
        ok: true,
        json: async () => ({ tree: [{ path: "skills/pdf/SKILL.md", type: "blob" }, { path: "skills/docx/SKILL.md", type: "blob" }] }),
      };
    }
    if (String(url).includes("raw.githubusercontent.com")) {
      const name = String(url).includes("/pdf/") ? "pdf" : "docx";
      return { ok: true, text: async () => `---\nname: ${name}\ndescription: ${name} skill\n---\n` };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const listed = await service.listRepos();
  assert.ok(listed.some((item) => item.id === "anthropics/skills"));
  const scanned = await service.scanRepo("anthropics/skills");
  assert.equal(scanned.skills.length, 2);
  assert.equal(scanned.skills[0].description.includes("skill"), true);
  const catalog = await service.catalogSkills("pdf");
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].repoId, "anthropics/skills");
  const extra = await service.addRepo({ url: "cexll/myclaude", branch: "master" });
  assert.equal(extra.id, "cexll/myclaude");

  const zip = storedZip("wrap/skills/pdf/SKILL.md", "---\nname: pdf\ndescription: PDF 工具\n---\n# pdf\n");
  const zipPath = join(dir, "multi.zip");
  await writeFile(zipPath, zip);
  const staged = await service.skillsStage({ url: `https://local.fixture/${zipPath}`, skillPath: "skills/pdf" });
  assert.equal(staged.review.name, "pdf");
});

test("W3.12 team template library: stage → install → templates → pack", async (t) => {
  const { service } = await fixture(t);
  const pack = {
    format: "514cc-team-pack",
    version: 1,
    exportedAt: "2026-08-30T00:00:00.000Z",
    team: { name: "示例小队", description: "W3.12 测试包", members: [], skills: [], mcp: [], providers: {}, systemPrompt: "", coordinator: "" },
    members: { custom: [], builtinRefs: ["claude-fable", "codex-technical"] },
  };
  const staged = await service.teamStage({ pack });
  assert.ok(staged.stageId);
  await assert.rejects(() => service.teamInstall({ stageId: staged.stageId }), { code: "MARKET_NOT_CONFIRMED" });
  const installed = await service.teamInstall({ stageId: staged.stageId, confirmed: true });
  assert.equal(installed.name, "示例小队");

  const templates = await service.teamTemplates();
  assert.equal(templates.templates.length, 1);
  assert.equal(templates.templates[0].memberCount, 2);
  const fetched = await service.teamPack({ id: "示例小队" });
  assert.equal(fetched.pack.format, "514cc-team-pack");

  await assert.rejects(() => service.teamStage({ pack: { format: "x" } }), { code: "MARKET_TEAM_PACK_INVALID" });
  await assert.rejects(() => service.teamPack({ id: "不存在" }), { code: "MARKET_TEAM_NOT_FOUND" });
});
