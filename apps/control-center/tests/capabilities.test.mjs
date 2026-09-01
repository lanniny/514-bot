import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCapabilities } from "../src/capabilities.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const TEST_TEAMS = [{
  id: "team-test",
  members: ["grok-build", "claude-fable"],
  skills: ["co-review", "docx", "ssh", "co-status"],
}];

async function fixture(t, { claudeJson = null, codexToml = null, teams = TEST_TEAMS, members = null, sourceIdForPath = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "514cc-caps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await rm(home, { recursive: true, force: true }).catch(() => {});
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(home, ".codex"), { recursive: true });
  if (claudeJson) await writeFile(join(home, ".claude.json"), JSON.stringify(claudeJson, null, 2), "utf8");
  if (codexToml) await writeFile(join(home, ".codex", "config.toml"), codexToml, "utf8");
  const dataRoot = join(root, "data");
  const teamsStore = { list: () => teams };
  const membersStore = members === null ? null : { list: () => members };
  const caps = createCapabilities({ repoRoot: resolve(appRoot, "../.."), homeDir: home, teamsStore, membersStore, dataRoot, eventStore: null, sourceIdForPath });
  const { mkdir: mkdir2 } = await import("node:fs/promises");
  await mkdir2(dataRoot, { recursive: true });
  return { root, home, dataRoot, teamsStore, membersStore, caps };
}

async function waitForRun(orchestrator, id) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !["succeeded", "failed", "cancelled", "recovery_required"].includes(orchestrator.get(id).status)) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  return orchestrator.get(id);
}

function injectedIoError(message) {
  return Object.assign(new Error(message), { code: "EIO" });
}

async function assertNoAtomicTemps(...directories) {
  const names = (await Promise.all(directories.map((directory) => readdir(directory).catch(() => [])))).flat();
  assert.deepEqual(names.filter((name) => name.endsWith(".tmp")), [], "failed atomic replacements must clean their temp files");
}

async function skillRepoFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "514cc-skill-create-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoRoot = join(root, "repo");
  const dataRoot = join(root, "data");
  const home = join(root, "home");
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await mkdir(repoRoot, { recursive: true });
  const caps = createCapabilities({
    repoRoot,
    homeDir: home,
    teamsStore: { list: () => [] },
    membersStore: { list: () => [] },
    dataRoot,
    eventStore: null,
  });
  return { root, repoRoot, caps };
}

test("createSkill writes repo .agents/skills and refuses overwrite or path escape", async (t) => {
  const { repoRoot, caps } = await skillRepoFixture(t);
  const created = await caps.createSkill({
    name: "wizard-demo",
    description: 'say "hello"',
    body: "Use this skill to greet LO.",
  });
  assert.deepEqual(created, {
    code: "wizard-demo",
    path: ".agents/skills/wizard-demo",
    description: 'say "hello"',
    created: true,
  });
  const skillFile = join(repoRoot, ".agents", "skills", "wizard-demo", "SKILL.md");
  const text = await readFile(skillFile, "utf8");
  assert.match(text, /^---\nname: wizard-demo\ndescription: "say \\"hello\\""\n---\n/);
  assert.match(text, /Use this skill to greet LO\./);
  const summary = await caps.summary();
  assert.ok(summary.skills.items.some((skill) => skill.code === "wizard-demo" && skill.path.replace(/\\/g, "/") === ".agents/skills/wizard-demo"));

  await assert.rejects(() => caps.createSkill({ name: "wizard-demo", description: "again" }), { code: "SKILL_EXISTS" });
  await assert.rejects(() => caps.createSkill({ name: "../escape" }), { code: "VALIDATION_FAILED" });
  await assert.rejects(() => caps.createSkill({ name: "foo/bar" }), { code: "VALIDATION_FAILED" });
  await assert.rejects(() => caps.createSkill({ name: "__proto__" }), { code: "VALIDATION_FAILED" });
  await assert.rejects(() => caps.createSkill({ name: "" }), { code: "VALIDATION_FAILED" });
  const escaped = await readdir(repoRoot);
  assert.deepEqual(escaped.filter((name) => name !== ".agents"), []);
});

test("agent skill toggle persists and reads back (negative list, default enabled)", async (t) => {
  const { caps, dataRoot } = await fixture(t);
  assert.deepEqual(await caps.agentConfigStatus(), {
    state: "ready",
    source: "missing-default",
    writable: true,
    failClosed: false,
    path: join(dataRoot, "agent-capabilities.json"),
    code: null,
    message: null,
    causeCode: null,
  });
  assert.deepEqual([...(await caps.agentDisabledSkills("grok-build"))], []);
  await caps.setAgentSkill("grok-build", "co-review", false);
  await caps.setAgentSkill("grok-build", "docx", false);
  assert.deepEqual([...(await caps.agentDisabledSkills("grok-build"))].sort(), ["co-review", "docx"]);
  await caps.setAgentSkill("grok-build", "co-review", true);
  assert.deepEqual([...(await caps.agentDisabledSkills("grok-build"))], ["docx"]);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(dataRoot, "agent-capabilities.json"))).mode & 0o777, 0o600, "new capability state is private");
  }
  // 新实例读同一文件（持久化实证）
  const caps2 = createCapabilities({ repoRoot: resolve(appRoot, "../.."), homeDir: process.env.USERPROFILE, teamsStore: { list: () => [] }, dataRoot: caps.__capsPath ?? undefined });
  assert.ok(caps2); // 构造不依赖内存态
});

test("member registry drives the skill matrix before a custom member joins any team", async (t) => {
  const standaloneId = "member-standalone";
  const { caps } = await fixture(t, {
    teams: [{ id: "team-existing", members: ["grok-build"], skills: ["co-review"] }],
    members: [
      { id: "grok-build", teamMemberEligible: true },
      { id: standaloneId, teamMemberEligible: true },
      { id: "member-disabled", teamMemberEligible: false },
    ],
  });

  const summary = await caps.summary();
  assert.deepEqual(summary.skills.memberIds, ["grok-build", standaloneId]);
  assert.ok(summary.skills.agentSkillStates[standaloneId]);
  assert.equal(summary.skills.agentSkillStates["member-disabled"], undefined);
  await caps.setAgentSkill(standaloneId, "co-review", false);
  assert.deepEqual(await caps.agentDisabledSkills(standaloneId), new Set(["co-review"]));
});

test("concurrent agent skill mutations preserve every update across capabilities instances", async (t) => {
  const { home, dataRoot, teamsStore, caps } = await fixture(t);
  const caps2 = createCapabilities({
    repoRoot: resolve(appRoot, "../.."),
    homeDir: home,
    teamsStore,
    dataRoot,
    eventStore: null,
  });

  await Promise.all([
    caps.setAgentSkill("grok-build", "co-review", false),
    caps2.setAgentSkill("grok-build", "docx", false),
    caps.setAgentSkill("claude-fable", "ssh", false),
    caps2.setAgentSkill("claude-fable", "co-status", false),
  ]);

  assert.deepEqual([...(await caps.agentDisabledSkills("grok-build"))].sort(), ["co-review", "docx"]);
  assert.deepEqual([...(await caps2.agentDisabledSkills("claude-fable"))].sort(), ["co-status", "ssh"]);
  const onDisk = JSON.parse(await readFile(join(dataRoot, "agent-capabilities.json"), "utf8"));
  assert.deepEqual(onDisk.agents["grok-build"].disabledSkills.sort(), ["co-review", "docx"]);
  assert.deepEqual(onDisk.agents["claude-fable"].disabledSkills.sort(), ["co-status", "ssh"]);
});

test("sensitive atomic writes restrict an empty temp before writing content", async (t) => {
  const { home, dataRoot, teamsStore } = await fixture(t);
  const securedSizes = [];
  const caps = createCapabilities({
    repoRoot: resolve(appRoot, "../.."),
    homeDir: home,
    teamsStore,
    dataRoot,
    eventStore: null,
    secureFile: async (path) => { securedSizes.push((await stat(path)).size); },
  });

  await caps.setAgentSkill("grok-build", "co-review", false);
  assert.deepEqual(securedSizes, [0]);
  assert.match(await readFile(join(dataRoot, "agent-capabilities.json"), "utf8"), /co-review/);
});

test("corrupt agent capability config is explicit degraded state and fails closed without overwrite", async (t) => {
  const { caps, dataRoot } = await fixture(t);
  const path = join(dataRoot, "agent-capabilities.json");
  const original = '{"agents":{"grok-build":{"disabledSkills":["co-review"]}}';
  await writeFile(path, original, "utf8");

  const status = await caps.agentConfigStatus();
  assert.equal(status.state, "degraded");
  assert.equal(status.code, "CAPABILITY_CONFIG_CORRUPT");
  assert.equal(status.failClosed, true);
  assert.equal(status.writable, false);
  await assert.rejects(() => caps.agentDisabledSkills("grok-build"), { code: "CAPABILITY_CONFIG_CORRUPT" });
  await assert.rejects(() => caps.setAgentSkill("grok-build", "co-review", false), { code: "CAPABILITY_CONFIG_CORRUPT" });
  assert.equal(await readFile(path, "utf8"), original, "a corrupt capability file must remain byte-for-byte untouched");

  const summary = await caps.summary();
  assert.equal(summary.skills.configurationStatus.code, "CAPABILITY_CONFIG_CORRUPT");
  assert.equal(summary.skills.agentSkillStates["grok-build"].failClosed, true);
  assert.ok(
    summary.skills.agentSkillStates["grok-build"].disabledSkills.includes("co-review"),
    "summary must project a disabled fail-closed state instead of visually implying all skills are enabled",
  );
});

test("existing unreadable agent capability path is not treated as a missing default", async (t) => {
  const { caps, dataRoot } = await fixture(t);
  const path = join(dataRoot, "agent-capabilities.json");
  await mkdir(path);

  const status = await caps.agentConfigStatus();
  assert.equal(status.state, "degraded");
  assert.equal(status.code, "CAPABILITY_CONFIG_UNREADABLE");
  assert.equal(status.failClosed, true);
  await assert.rejects(() => caps.agentDisabledSkills("grok-build"), { code: "CAPABILITY_CONFIG_UNREADABLE" });
  await assert.rejects(() => caps.setAgentSkill("grok-build", "docx", false), { code: "CAPABILITY_CONFIG_UNREADABLE" });
  assert.equal((await stat(path)).isDirectory(), true, "the unreadable original path must not be replaced");
});

test("agent skill APIs reject prototype keys and unknown catalog combinations", async (t) => {
  const { caps } = await fixture(t);
  for (const poisoned of ["__proto__", "prototype", "constructor"]) {
    await assert.rejects(() => caps.setAgentSkill(poisoned, "co-review", false), { code: "VALIDATION_FAILED" });
    await assert.rejects(() => caps.setAgentSkill("grok-build", poisoned, false), { code: "VALIDATION_FAILED" });
    await assert.rejects(() => caps.agentDisabledSkills(poisoned), { code: "VALIDATION_FAILED" });
  }
  await assert.rejects(() => caps.setAgentSkill("missing-agent", "co-review", false), { code: "VALIDATION_FAILED" });
  await assert.rejects(() => caps.setAgentSkill("grok-build", "missing-skill", false), { code: "VALIDATION_FAILED" });
  assert.equal(Object.prototype.disabledSkills, undefined, "capability input must not mutate Object.prototype");
});

const CLAUDE_CONFIG = {
  mcpServers: {
    serena: { type: "stdio", command: "uvx", args: ["--from", "serena", "serena"], env: { SECRET: "topsecret-value" } },
    fetch: { type: "stdio", command: "uvx" },
  },
  projects: {},
};

test("capability summary attaches exact backend source IDs and leaves unknown paths null", async (t) => {
  const repoRoot = resolve(appRoot, "../..");
  const skillPath = resolve(repoRoot, ".agents/skills/co-review/SKILL.md");
  let codexPath = null;
  const resolvedPaths = [];
  const sourceIdForPath = (path) => {
    resolvedPaths.push(path);
    if (path === skillPath) return "repo:.agents/skills/co-review/SKILL.md";
    if (path === codexPath) return "runtime.codex-config";
    return null;
  };
  const { caps, home } = await fixture(t, {
    claudeJson: CLAUDE_CONFIG,
    codexToml: '[mcp_servers.source-id-test]\ncommand = "source-id-command"\n',
    sourceIdForPath,
  });
  codexPath = resolve(home, ".codex/config.toml");

  const summary = await caps.summary();
  const skill = summary.skills.items.find((item) => item.scope === "codex" && item.code === "co-review");
  const codexServer = summary.mcp.servers.find((server) => server.name === "source-id-test");
  const claudeServer = summary.mcp.servers.find((server) => server.name === "serena");
  assert.equal(skill?.sourceId, "repo:.agents/skills/co-review/SKILL.md");
  assert.equal(codexServer?.sourceId, "runtime.codex-config");
  assert.equal(claudeServer?.sourceId, null, "unregistered .claude.json must not be guessed");
  assert.ok(summary.skills.items.every((item) => Object.hasOwn(item, "sourceId")));
  assert.ok(summary.mcp.servers.every((server) => Object.hasOwn(server, "sourceId")));
  assert.ok(resolvedPaths.length > 0 && resolvedPaths.every(isAbsolute), "resolver only receives absolute paths");
});

test("missing MCP quarantine is an explicit writable empty state", async (t) => {
  const { caps, dataRoot } = await fixture(t, { claudeJson: CLAUDE_CONFIG });
  const summary = await caps.summary();
  assert.deepEqual(summary.mcp.configurationStatus, {
    state: "ready",
    source: "missing-default",
    writable: true,
    failClosed: false,
    path: join(dataRoot, "mcp-quarantine.json"),
    code: null,
    message: null,
    causeCode: null,
  });
});

test("corrupt MCP quarantine fails closed and leaves both source and quarantine byte-identical", async (t) => {
  const { home, dataRoot, caps } = await fixture(t, { claudeJson: CLAUDE_CONFIG });
  const claudeJsonPath = join(home, ".claude.json");
  const quarantinePath = join(dataRoot, "mcp-quarantine.json");
  const corruptBytes = Buffer.from('{"servers":{"serena":', "utf8");
  await writeFile(quarantinePath, corruptBytes);
  const sourceBytes = await readFile(claudeJsonPath);

  const summary = await caps.summary();
  assert.equal(summary.mcp.configurationStatus.code, "MCP_QUARANTINE_CORRUPT");
  assert.equal(summary.mcp.configurationStatus.failClosed, true);
  await assert.rejects(
    () => caps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "disable" }),
    { code: "MCP_QUARANTINE_CORRUPT" },
  );
  assert.deepEqual(await readFile(quarantinePath), corruptBytes);
  assert.deepEqual(await readFile(claudeJsonPath), sourceBytes);
});

test("MCP disable refuses divergent source and quarantine copies without modifying either", async (t) => {
  const { home, dataRoot, caps } = await fixture(t, { claudeJson: CLAUDE_CONFIG });
  const claudeJsonPath = join(home, ".claude.json");
  const quarantinePath = join(dataRoot, "mcp-quarantine.json");
  const quarantine = {
    servers: {
      serena: {
        entry: { type: "stdio", command: "older-serena", env: { SECRET: "older-secret" } },
        disabledAt: "2026-07-23T00:00:00.000Z",
      },
    },
  };
  await writeFile(quarantinePath, `${JSON.stringify(quarantine, null, 2)}\n`, "utf8");
  const sourceBefore = await readFile(claudeJsonPath);
  const quarantineBefore = await readFile(quarantinePath);

  await assert.rejects(
    () => caps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "disable" }),
    { code: "MCP_QUARANTINE_CONFLICT" },
  );
  assert.deepEqual(await readFile(claudeJsonPath), sourceBefore);
  assert.deepEqual(await readFile(quarantinePath), quarantineBefore);
  await assert.rejects(() => readFile(`${claudeJsonPath}.514cc-backup`), { code: "ENOENT" });
});

test("MCP disable preserves sibling fields written after the transaction starts", async (t) => {
  const { home, dataRoot, teamsStore } = await fixture(t, { claudeJson: CLAUDE_CONFIG });
  const claudeJsonPath = join(home, ".claude.json");
  const quarantinePath = join(dataRoot, "mcp-quarantine.json");
  let injected = false;
  const caps = createCapabilities({
    repoRoot: resolve(appRoot, "../.."), homeDir: home, teamsStore, dataRoot, eventStore: null,
    fileOps: { rename: async (from, to) => {
      await rename(from, to);
      if (!injected && to === quarantinePath) {
        injected = true;
        const latest = JSON.parse(await readFile(claudeJsonPath, "utf8"));
        latest.externalState = { keep: true };
        await writeFile(claudeJsonPath, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
      }
    } },
  });

  await caps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "disable" });
  const source = JSON.parse(await readFile(claudeJsonPath, "utf8"));
  assert.deepEqual(source.externalState, { keep: true });
  assert.equal(source.mcpServers.serena, undefined);
  assert.ok(source.mcpServers.fetch);
});

test("MCP disable keeps both copies when the target entry changes during the transaction", async (t) => {
  const { home, dataRoot, teamsStore } = await fixture(t, { claudeJson: CLAUDE_CONFIG });
  const claudeJsonPath = join(home, ".claude.json");
  const quarantinePath = join(dataRoot, "mcp-quarantine.json");
  let injected = false;
  const caps = createCapabilities({
    repoRoot: resolve(appRoot, "../.."), homeDir: home, teamsStore, dataRoot, eventStore: null,
    fileOps: { rename: async (from, to) => {
      await rename(from, to);
      if (!injected && to === quarantinePath) {
        injected = true;
        const latest = JSON.parse(await readFile(claudeJsonPath, "utf8"));
        latest.mcpServers.serena = { type: "stdio", command: "externally-updated" };
        await writeFile(claudeJsonPath, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
      }
    } },
  });

  await assert.rejects(
    () => caps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "disable" }),
    { code: "MCP_SOURCE_CONFLICT" },
  );
  assert.equal(JSON.parse(await readFile(claudeJsonPath, "utf8")).mcpServers.serena.command, "externally-updated");
  assert.deepEqual(JSON.parse(await readFile(quarantinePath, "utf8")).servers.serena.entry, CLAUDE_CONFIG.mcpServers.serena);
});

test("unreadable MCP quarantine fails closed without replacing the original path", async (t) => {
  const { home, dataRoot, caps } = await fixture(t, { claudeJson: CLAUDE_CONFIG });
  const claudeJsonPath = join(home, ".claude.json");
  const quarantinePath = join(dataRoot, "mcp-quarantine.json");
  await mkdir(quarantinePath);
  const sourceBytes = await readFile(claudeJsonPath);

  await assert.rejects(
    () => caps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "disable" }),
    { code: "MCP_QUARANTINE_UNREADABLE" },
  );
  assert.equal((await stat(quarantinePath)).isDirectory(), true);
  assert.deepEqual(await readFile(claudeJsonPath), sourceBytes);
});

test("mcp disable quarantines the entry verbatim (env included), enable restores it", async (t) => {
  const { home, dataRoot, caps } = await fixture(t, { claudeJson: CLAUDE_CONFIG });
  const claudeJsonPath = join(home, ".claude.json");
  const before = JSON.parse(await readFile(claudeJsonPath, "utf8"));
  const result = await caps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "disable", knownMtimeMs: undefined });
  assert.equal(result.disabled, true);
  const after = JSON.parse(await readFile(claudeJsonPath, "utf8"));
  assert.equal(after.mcpServers.serena, undefined);
  assert.ok(after.mcpServers.fetch, "其他 server 不受影响");
  // 写前备份含完整 serena 条目（此时 enable 尚未覆写备份）
  const backup = await readFile(`${claudeJsonPath}.514cc-backup`, "utf8");
  assert.ok(backup.includes("serena"), "禁用前的备份必须含被禁条目");
  // env 凭据原样在隔离区（恢复的前提），且不出现在 API 返回体
  const restore = await caps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "enable" });
  assert.equal(restore.disabled, false);
  const restored = JSON.parse(await readFile(claudeJsonPath, "utf8"));
  assert.deepEqual(restored.mcpServers.serena, before.mcpServers.serena, "恢复后条目逐字节一致（含 env）");
  const repeated = await caps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "enable" });
  assert.equal(repeated.disabled, false);
  assert.match(repeated.note, /已启用/);
  assert.deepEqual(JSON.parse(await readFile(claudeJsonPath, "utf8")).mcpServers.serena, before.mcpServers.serena);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(dataRoot, "mcp-quarantine.json"))).mode & 0o777, 0o600, "new quarantine file is private");
    assert.equal((await stat(`${claudeJsonPath}.514cc-backup`)).mode & 0o777, 0o600, "new secret-bearing backup is private");
  }
});

test("disabledMcpNames mirrors quarantine and fail-closes when unreadable", async (t) => {
  const { caps, home, dataRoot } = await fixture(t, { claudeJson: CLAUDE_CONFIG });
  const empty = await caps.disabledMcpNames();
  assert.equal(empty.failClosed, false);
  assert.deepEqual([...empty.names], []);
  await caps.toggleMcpServer({ name: "serena", source: join(home, ".claude.json"), action: "disable" });
  const held = await caps.disabledMcpNames();
  assert.equal(held.failClosed, false);
  assert.deepEqual([...held.names], ["serena"]);
  await writeFile(join(dataRoot, "mcp-quarantine.json"), "{", "utf8");
  const broken = await caps.disabledMcpNames();
  assert.equal(broken.failClosed, true);
});

test("concurrent MCP mutations preserve every config and quarantine update", async (t) => {
  const { home, dataRoot, teamsStore, caps } = await fixture(t, { claudeJson: CLAUDE_CONFIG });
  const caps2 = createCapabilities({
    repoRoot: resolve(appRoot, "../.."),
    homeDir: home,
    teamsStore,
    dataRoot,
    eventStore: null,
  });
  const claudeJsonPath = join(home, ".claude.json");

  await Promise.all([
    caps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "disable" }),
    caps2.toggleMcpServer({ name: "fetch", source: claudeJsonPath, action: "disable" }),
  ]);
  const disabledConfig = JSON.parse(await readFile(claudeJsonPath, "utf8"));
  const quarantine = JSON.parse(await readFile(join(dataRoot, "mcp-quarantine.json"), "utf8"));
  assert.deepEqual(disabledConfig.mcpServers, {});
  assert.deepEqual(Object.keys(quarantine.servers).sort(), ["fetch", "serena"]);

  await Promise.all([
    caps2.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "enable" }),
    caps.toggleMcpServer({ name: "fetch", source: claudeJsonPath, action: "enable" }),
  ]);
  const restored = JSON.parse(await readFile(claudeJsonPath, "utf8"));
  assert.deepEqual(restored.mcpServers, CLAUDE_CONFIG.mcpServers);
  const emptiedQuarantine = JSON.parse(await readFile(join(dataRoot, "mcp-quarantine.json"), "utf8"));
  assert.deepEqual(emptiedQuarantine.servers, {});
});

test("MCP disable never removes the source before quarantine persistence succeeds", async (t) => {
  const { home, dataRoot, teamsStore } = await fixture(t, { claudeJson: CLAUDE_CONFIG });
  const claudeJsonPath = join(home, ".claude.json");
  const quarantinePath = join(dataRoot, "mcp-quarantine.json");
  let failOnce = true;
  const caps = createCapabilities({
    repoRoot: resolve(appRoot, "../.."), homeDir: home, teamsStore, dataRoot, eventStore: null,
    fileOps: { rename: async (from, to) => {
      if (failOnce && to === quarantinePath) { failOnce = false; throw injectedIoError("quarantine rename failed"); }
      return rename(from, to);
    } },
  });

  await assert.rejects(() => caps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "disable" }), { code: "MCP_TRANSACTION_INCOMPLETE" });
  assert.ok(JSON.parse(await readFile(claudeJsonPath, "utf8")).mcpServers.serena, "source entry remains after quarantine failure");
  await assert.rejects(() => readFile(quarantinePath), { code: "ENOENT" });
  await assertNoAtomicTemps(home, dataRoot);
  await caps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "disable" });
  assert.equal(JSON.parse(await readFile(claudeJsonPath, "utf8")).mcpServers.serena, undefined);
});

test("MCP disable keeps the persisted quarantine entry when source removal fails", async (t) => {
  const { home, dataRoot, teamsStore } = await fixture(t, { claudeJson: CLAUDE_CONFIG });
  const claudeJsonPath = join(home, ".claude.json");
  const quarantinePath = join(dataRoot, "mcp-quarantine.json");
  let failOnce = true;
  const caps = createCapabilities({
    repoRoot: resolve(appRoot, "../.."), homeDir: home, teamsStore, dataRoot, eventStore: null,
    fileOps: { rename: async (from, to) => {
      if (failOnce && to === claudeJsonPath) { failOnce = false; throw injectedIoError("source rename failed"); }
      return rename(from, to);
    } },
  });

  await assert.rejects(() => caps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "disable" }), { code: "MCP_TRANSACTION_INCOMPLETE" });
  assert.ok(JSON.parse(await readFile(claudeJsonPath, "utf8")).mcpServers.serena);
  assert.deepEqual(JSON.parse(await readFile(quarantinePath, "utf8")).servers.serena.entry, CLAUDE_CONFIG.mcpServers.serena);
  await assertNoAtomicTemps(home, dataRoot);
  await caps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "disable" });
  assert.equal(JSON.parse(await readFile(claudeJsonPath, "utf8")).mcpServers.serena, undefined);
});

test("MCP enable is retryable across source-restore and quarantine-cleanup failures", async (t) => {
  const { home, dataRoot, teamsStore, caps: normalCaps } = await fixture(t, { claudeJson: CLAUDE_CONFIG });
  const claudeJsonPath = join(home, ".claude.json");
  const quarantinePath = join(dataRoot, "mcp-quarantine.json");
  await normalCaps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "disable" });

  let failSourceOnce = true;
  const sourceFaultCaps = createCapabilities({
    repoRoot: resolve(appRoot, "../.."), homeDir: home, teamsStore, dataRoot, eventStore: null,
    fileOps: { rename: async (from, to) => {
      if (failSourceOnce && to === claudeJsonPath) { failSourceOnce = false; throw injectedIoError("restore rename failed"); }
      return rename(from, to);
    } },
  });
  await assert.rejects(() => sourceFaultCaps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "enable" }), { code: "MCP_TRANSACTION_INCOMPLETE" });
  assert.equal(JSON.parse(await readFile(claudeJsonPath, "utf8")).mcpServers.serena, undefined);
  assert.ok(JSON.parse(await readFile(quarantinePath, "utf8")).servers.serena);
  await assertNoAtomicTemps(home, dataRoot);
  await sourceFaultCaps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "enable" });

  await normalCaps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "disable" });
  let failCleanupOnce = true;
  const cleanupFaultCaps = createCapabilities({
    repoRoot: resolve(appRoot, "../.."), homeDir: home, teamsStore, dataRoot, eventStore: null,
    fileOps: { rename: async (from, to) => {
      if (failCleanupOnce && to === quarantinePath) { failCleanupOnce = false; throw injectedIoError("cleanup rename failed"); }
      return rename(from, to);
    } },
  });
  await assert.rejects(() => cleanupFaultCaps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "enable" }), { code: "MCP_TRANSACTION_INCOMPLETE" });
  assert.deepEqual(JSON.parse(await readFile(claudeJsonPath, "utf8")).mcpServers.serena, CLAUDE_CONFIG.mcpServers.serena);
  assert.ok(JSON.parse(await readFile(quarantinePath, "utf8")).servers.serena, "cleanup failure leaves a second recovery copy");
  await assertNoAtomicTemps(home, dataRoot);
  await cleanupFaultCaps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "enable" });
  assert.deepEqual(JSON.parse(await readFile(quarantinePath, "utf8")).servers, {});
});

test("mcp toggle rejects stale mtime (optimistic lock) and non-claude sources", async (t) => {
  const { home, caps } = await fixture(t, { claudeJson: CLAUDE_CONFIG });
  const claudeJsonPath = join(home, ".claude.json");
  await assert.rejects(
    () => caps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "disable", knownMtimeMs: 1 }),
    { code: "STALE_BASE" },
  );
  await assert.rejects(
    () => caps.toggleMcpServer({ name: "x", source: join(home, ".codex", "config.toml"), action: "disable" }),
    { code: "READ_ONLY_SOURCE" },
  );
  await assert.rejects(
    () => caps.toggleMcpServer({ name: "serena", source: join(home, "other", ".claude.json"), action: "disable" }),
    { code: "READ_ONLY_SOURCE" },
  );
  for (const poisoned of ["__proto__", "prototype", "constructor"]) {
    await assert.rejects(
      () => caps.toggleMcpServer({ name: poisoned, source: claudeJsonPath, action: "disable" }),
      { code: "VALIDATION_FAILED" },
    );
  }
});

test("MCP source stat permission failures are unavailable, not false 404s", async (t) => {
  const { home, dataRoot, teamsStore } = await fixture(t, { claudeJson: CLAUDE_CONFIG });
  const claudeJsonPath = join(home, ".claude.json");
  const caps = createCapabilities({
    repoRoot: resolve(appRoot, "../.."), homeDir: home, teamsStore, dataRoot, eventStore: null,
    fileOps: { stat: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } },
  });
  await assert.rejects(
    () => caps.toggleMcpServer({ name: "serena", source: claudeJsonPath, action: "disable" }),
    { code: "MCP_SOURCE_UNREADABLE" },
  );
});

// 编排接线实证：成员轮提示词只含该成员启用中的 skill（禁用=不进提示词，不是 UI 摆设）
test("social loop injects only enabled skills into member prompts", async (t) => {
  const { Orchestrator } = await import("../src/orchestrator.mjs");
  const root = await mkdtemp(join(tmpdir(), "514cc-caps-orch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const replies = { "claude-fable": ["[[msg:codex-technical]] 看看", "收敛。"], "codex-technical": ["嗯。"] };
  const adapter = (id) => ({
    cwd: root,
    supportsPerTurnCwd: true,
    async send(input) {
      calls.push({ id, prompt: input.prompt });
      const index = calls.filter((call) => call.id === id).length;
      return { sessionId: `${id}-s`, text: replies[id][Math.min(index - 1, replies[id].length - 1)], protocol: "mock", tokens: 1, costUsd: 0 };
    },
    async close() {},
  });
  const orchestrator = await new Orchestrator({
    router: { preview: async () => ({ taskType: "coding", risk: "low", selected: { id: "codex-technical" }, independent: { id: "claude-fable" }, independentRequired: false, reason: "t" }) },
    adapters: new Map([["claude-fable", adapter("claude-fable")], ["codex-technical", adapter("codex-technical")]]),
    eventStore: { emit: async () => {} },
    dataRoot: root,
    policy: { version: 1, modes: { plan: { approvalRequired: false } }, limits: { maxRounds: 4, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 1000 } },
    approvalBroker: { request: async () => ({ decision: "accept" }), denyRun() {} },
    teams: {
      get: () => ({ id: "team-514cc", name: "514cc", coordinator: "claude-fable", members: ["claude-fable", "codex-technical"], skills: ["co-review", "docx", "ssh"], mcp: ["serena", "exa"] }),
      brief: () => "[团队]\n团队 Skill（声明，供派工参考）：co-review、docx、ssh\n团队 MCP（声明，供派工参考）：serena、exa",
    },
    capabilities: {
      agentDisabledSkills: async (id) => new Set(id === "codex-technical" ? ["docx"] : []),
      disabledMcpNames: async () => ({ failClosed: false, names: new Set(["serena"]) }),
    },
  }).init();
  const run = await orchestrator.create({ prompt: "接线验证", execute: true, permissionMode: "plan", teamId: "team-514cc", orchestrationMode: "social", maxRounds: 4 });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !["succeeded", "failed"].includes(orchestrator.get(run.id).status)) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  assert.equal(orchestrator.get(run.id).status, "succeeded", orchestrator.get(run.id).error);
  const codexPrompt = calls.find((call) => call.id === "codex-technical")?.prompt ?? "";
  assert.ok(codexPrompt.includes("co-review") && codexPrompt.includes("ssh"), "启用中的 skill 必须注入");
  assert.ok(!codexPrompt.includes("docx"), "被禁用的 skill 不得进提示词");
  assert.ok(codexPrompt.includes("exa") && !codexPrompt.includes("serena"), "隔离的 MCP 不得进提示词");
  assert.doesNotMatch(codexPrompt, /团队 Skill（声明，供派工参考）/);
  assert.doesNotMatch(codexPrompt, /团队 MCP（声明，供派工参考）/);
  assert.match(codexPrompt, /只是注入模型的提示词声明，不授予工具、文件、网络或沙箱权限/);
  await orchestrator.close();
});

test("real corrupt capability config blocks social, pipeline, and terminal continue with zero provider calls", async (t) => {
  const { Orchestrator } = await import("../src/orchestrator.mjs");
  const root = await mkdtemp(join(tmpdir(), "514cc-caps-orch-degraded-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const team = { id: "team-514cc", name: "514cc", coordinator: "claude-fable", members: ["claude-fable", "codex-technical"], skills: ["co-review", "docx"] };

  for (const mode of ["social", "pipeline", "terminal-continue"]) {
    const dataRoot = join(root, mode);
    await mkdir(dataRoot, { recursive: true });
    await writeFile(join(dataRoot, "agent-capabilities.json"), '{"agents":', "utf8");
    const calls = [];
    const events = [];
    const adapter = {
      cwd: root,
      supportsPerTurnCwd: true,
      async send(input) {
        calls.push(input);
        return { sessionId: "unexpected", text: "must not run", protocol: "mock", tokens: 1, costUsd: 0 };
      },
      async close() {},
    };
    const teams = { get: () => team, brief: () => "[团队]", list: () => [team] };
    const capabilities = createCapabilities({ repoRoot: resolve(appRoot, "../.."), homeDir: join(dataRoot, "home"), teamsStore: teams, dataRoot, eventStore: null });
    const orchestrator = await new Orchestrator({
      router: { preview: async () => ({ taskType: "coding", risk: "low", selected: { id: "codex-technical" }, independent: null, independentRequired: false, reason: "t" }) },
      adapters: new Map([["claude-fable", adapter], ["codex-technical", adapter]]),
      eventStore: { emit: async (type, data) => { events.push({ type, data }); } },
      dataRoot,
      policy: { version: 1, modes: { plan: { approvalRequired: false } }, limits: { maxRounds: 4, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 1000 } },
      approvalBroker: { request: async () => ({ decision: "accept" }), denyRun() {} },
      teams,
      capabilities,
    }).init();
    try {
      const run = await orchestrator.create({
        prompt: `不得越过损坏能力配置-${mode}`,
        execute: mode !== "terminal-continue",
        permissionMode: "plan",
        teamId: "team-514cc",
        orchestrationMode: mode === "pipeline" ? "pipeline" : "social",
        maxRounds: 4,
      });
      if (mode === "terminal-continue") {
        await assert.rejects(() => orchestrator.continue(run.id, { prompt: "终态续聊也不得派发" }), { code: "CAPABILITY_CONFIG_CORRUPT" });
        assert.equal(orchestrator.get(run.id).status, "failed");
      } else {
        const failed = await waitForRun(orchestrator, run.id);
        const expectedStatus = mode === "social" ? "recovery_required" : "failed";
        const expectedEvent = mode === "social" ? "run.recovery_required" : "run.failed";
        assert.equal(failed.status, expectedStatus, mode);
        assert.match(failed.error ?? "", /capability configuration is corrupt/);
        if (mode === "social") {
          assert.ok(failed.resumeClaim?.itemId, "social failure must retain its durable task claim");
          assert.ok(failed.resumeQueue?.some((item) => item.itemId === failed.resumeClaim.itemId));
        }
        const auditDeadline = Date.now() + 2_000;
        while (
          Date.now() < auditDeadline
          && !events.some((event) => event.type === expectedEvent && event.data?.code === "CAPABILITY_CONFIG_CORRUPT")
        ) {
          await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
        }
        assert.ok(events.some((event) => event.type === expectedEvent && event.data?.code === "CAPABILITY_CONFIG_CORRUPT"));
      }
      assert.equal(calls.length, 0, `${mode} must not dispatch a provider turn`);
    } finally {
      await orchestrator.close();
    }
  }
});
