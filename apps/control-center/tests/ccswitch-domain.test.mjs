import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderStore } from "../src/providers.mjs";
import { CcSwitchDomainService } from "../src/ccswitch/domain.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

async function fixture(t, options = {}) {
  const root = await mkdtemp(resolve(appRoot, ".test-ccswitch-domain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  const runtimeHome = join(root, "home");
  await mkdir(runtimeHome, { recursive: true });
  const providers = await new ProviderStore({ dataRoot, runtimeHome }).init();
  const domain = await new CcSwitchDomainService({ dataRoot, runtimeHome, providerStore: providers, ...options }).init();
  return { root, dataRoot, runtimeHome, providers, domain };
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => {
      server.close(resolveClose);
      server.closeAllConnections?.();
    }),
  };
}

test("Prompt CRUD：启用前回填 live、互斥写入、激活项拒删", async (t) => {
  const { domain, runtimeHome } = await fixture(t);
  const promptPath = join(runtimeHome, ".claude", "CLAUDE.md");
  await mkdir(join(runtimeHome, ".claude"), { recursive: true });
  await writeFile(promptPath, "legacy prompt", "utf8");

  const first = await domain.upsertPrompt("claude", { name: "A", content: "prompt A" });
  await domain.enablePrompt("claude", first.id);
  assert.equal(await readFile(promptPath, "utf8"), "prompt A");
  assert.ok(domain.prompts("claude").some((item) => item.name.startsWith("原始提示词") && item.content === "legacy prompt"));

  await domain.upsertPrompt("claude", { id: first.id, name: "A2", content: "prompt A2" });
  assert.equal(await readFile(promptPath, "utf8"), "prompt A2", "editing the active prompt updates live content");
  await assert.rejects(() => domain.deletePrompt("claude", first.id), (error) => error.code === "PROMPT_ACTIVE");

  const second = await domain.upsertPrompt("claude", { name: "B", content: "prompt B", enabled: true });
  assert.equal(await readFile(promptPath, "utf8"), "prompt B");
  assert.equal(domain.prompts("claude").find((item) => item.id === first.id).enabled, false);
  await domain.disablePrompt("claude", second.id);
  assert.equal(await readFile(promptPath, "utf8"), "");
});

test("MCP 统一管理：JSON/TOML/YAML live 配置保留用户字段并可关闭", async (t) => {
  const { domain, runtimeHome } = await fixture(t);
  await mkdir(join(runtimeHome, ".claude"), { recursive: true });
  await writeFile(join(runtimeHome, ".claude.json"), JSON.stringify({ keep: true, mcpServers: { old: { command: "old" } } }), "utf8");
  await mkdir(join(runtimeHome, ".codex"), { recursive: true });
  await writeFile(join(runtimeHome, ".codex", "config.toml"), 'model = "gpt-test"\n', "utf8");
  await mkdir(join(runtimeHome, ".hermes"), { recursive: true });
  await writeFile(join(runtimeHome, ".hermes", "config.yaml"), "keep: true\n", "utf8");

  const mcp = await domain.upsertMcp({
    id: "filesystem",
    name: "Filesystem",
    config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], env: { ROOT: "C:/work" } },
    apps: { claude: true, codex: true, hermes: true, kimi: true },
  });
  assert.equal(mcp.apps.claude, true);
  const claude = JSON.parse(await readFile(join(runtimeHome, ".claude.json"), "utf8"));
  assert.equal(claude.keep, true);
  assert.equal(claude.mcpServers.old.command, "old");
  assert.equal(claude.mcpServers.filesystem.command, "npx");
  const codex = await readFile(join(runtimeHome, ".codex", "config.toml"), "utf8");
  assert.match(codex, /514-forge-mcp \(filesystem\)/);
  assert.match(codex, /command = "npx"/);
  const hermes = await readFile(join(runtimeHome, ".hermes", "config.yaml"), "utf8");
  assert.match(hermes, /mcp_servers:/);
  assert.match(hermes, /filesystem:/);
  // kimi → ~/.kimi-code/mcp.json（官方 mcpServers 形态）
  const kimiMcp = JSON.parse(await readFile(join(runtimeHome, ".kimi-code", "mcp.json"), "utf8"));
  assert.equal(kimiMcp.mcpServers.filesystem.command, "npx");
  assert.deepEqual(kimiMcp.mcpServers.filesystem.args, ["-y", "@modelcontextprotocol/server-filesystem"]);

  await domain.toggleMcp("filesystem", "codex", false);
  const disabled = await readFile(join(runtimeHome, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(disabled, /514-forge-mcp/);
  assert.match(disabled, /model = "gpt-test"/);
  await domain.toggleMcp("filesystem", "kimi", false);
  const kimiDisabled = JSON.parse(await readFile(join(runtimeHome, ".kimi-code", "mcp.json"), "utf8"));
  assert.equal(kimiDisabled.mcpServers.filesystem, undefined);

  await domain.upsertMcp({
    id: "remote-docs",
    name: "Remote Docs",
    config: {
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer secret-token", "X-Trace": "ok" },
      env: { MCP_BEARER_TOKEN: "secret-token" },
    },
    apps: { claude: true },
  });
  const httpClaude = JSON.parse(await readFile(join(runtimeHome, ".claude.json"), "utf8"));
  assert.equal(httpClaude.mcpServers["remote-docs"].type, "http");
  assert.equal(httpClaude.mcpServers["remote-docs"].url, "https://mcp.example.com/mcp");
  assert.equal(httpClaude.mcpServers["remote-docs"].headers.Authorization, "Bearer secret-token");
  assert.equal(httpClaude.mcpServers["remote-docs"].headers["X-Trace"], "ok");

  await domain.upsertMcp({
    id: "local-cwd",
    name: "Local Cwd",
    config: {
      type: "stdio",
      command: "node",
      args: ["server.mjs"],
      cwd: "C:/work/mcp",
      envPassthrough: ["PATH", "HOME"],
    },
    apps: { claude: true, codex: true },
  });
  const cwdClaude = JSON.parse(await readFile(join(runtimeHome, ".claude.json"), "utf8"));
  assert.equal(cwdClaude.mcpServers["local-cwd"].cwd, "C:/work/mcp");
  assert.deepEqual(cwdClaude.mcpServers["local-cwd"].envPassthrough, ["PATH", "HOME"]);
  const cwdCodex = await readFile(join(runtimeHome, ".codex", "config.toml"), "utf8");
  assert.match(cwdCodex, /cwd = "C:\/work\/mcp"/);
});

test("Skill 管理：规范存储、跨应用物化和禁用备份", async (t) => {
  const { domain, runtimeHome, dataRoot } = await fixture(t);
  const skill = await domain.installSkillFiles({
    name: "demo-skill",
    description: "demo",
    files: {
      "SKILL.md": "---\nname: demo-skill\ndescription: demo\n---\n# Demo\n",
      "scripts/run.mjs": "export default true;\n",
    },
    apps: { claude: true, codex: true, kimi: true },
  });
  assert.equal(await readFile(join(runtimeHome, ".claude", "skills", "demo-skill", "SKILL.md"), "utf8"), "---\nname: demo-skill\ndescription: demo\n---\n# Demo\n");
  assert.equal(await readFile(join(runtimeHome, ".codex", "skills", "demo-skill", "scripts", "run.mjs"), "utf8"), "export default true;\n");
  // kimi → ~/.kimi-code/skills/<name>/（官方用户级技能目录）
  assert.equal(await readFile(join(runtimeHome, ".kimi-code", "skills", "demo-skill", "SKILL.md"), "utf8"), "---\nname: demo-skill\ndescription: demo\n---\n# Demo\n");
  await domain.toggleSkill(skill.id, "codex", false);
  await assert.rejects(() => readFile(join(runtimeHome, ".codex", "skills", "demo-skill", "SKILL.md"), "utf8"), /ENOENT/);
  assert.ok((await domain.skills()).some((item) => item.id === "demo-skill"));
  assert.ok((await readFile(join(dataRoot, "ccswitch", "skills", "demo-skill", "SKILL.md"), "utf8")).includes("# Demo"));
  assert.throws(() => domain.uninstallSkill(skill.id), (error) => error.code === "CONFIRMATION_REQUIRED");
});

test("Skill 同 ID 并发安装：swap/backup/state 恒对应单一完整版本", async (t) => {
  const { domain, runtimeHome, dataRoot } = await fixture(t);
  const bodyA = "---\nname: race-skill\ndescription: vA\n---\n# AA\n".repeat(20);
  const bodyB = "---\nname: race-skill\ndescription: vB\n---\n# BB\n".repeat(20);
  const [a, b] = await Promise.all([
    domain.installSkillFiles({ name: "race-skill", description: "A", files: { "SKILL.md": bodyA }, apps: { claude: true } }),
    domain.installSkillFiles({ name: "race-skill", description: "B", files: { "SKILL.md": bodyB }, apps: { claude: true } }),
  ]);
  assert.equal(a.id, b.id, "同 id 安装收敛到同一 skill");
  const fs = await import("node:fs/promises");
  const { readdir } = fs;
  const entries = await readdir(join(dataRoot, "ccswitch", "skills", "race-skill")).catch(() => []);
  assert.deepEqual(entries.sort(), ["SKILL.md"], "不得残留 .old 或多余 swap 目录——文件交换被串行化");
  const onDisk = await readFile(join(dataRoot, "ccswitch", "skills", "race-skill", "SKILL.md"), "utf8");
  // 终局必须是 A 或 B 完整一份，绝不能被另一实例的 rename/rm 剪枝成混合或截断
  assert.ok(onDisk === bodyA || onDisk === bodyB, "final file is exactly one complete install, never mixed");
  const finalState = (await domain.skills()).find((item) => item.id === "race-skill");
  assert.ok(finalState, "state records a single race-skill entry");
});

test("Profile 快照/应用：供应商、MCP、Skill、Prompt 同组恢复", async (t) => {
  const { domain, providers } = await fixture(t);
  const a = await providers.create({ name: "A", baseUrl: "https://a.example.com", apiKey: "a-key", apps: { claude: true } });
  const b = await providers.create({ name: "B", baseUrl: "https://b.example.com", apiKey: "b-key", apps: { claude: true } });
  await providers.switchTo("claude", a.id);
  const prompt = await domain.upsertPrompt("claude", { name: "Project", content: "project rules", enabled: true });
  const mcp = await domain.upsertMcp({ id: "profile-mcp", name: "Profile MCP", config: { command: "node", args: ["server.mjs"] }, apps: { claude: true } });
  const skill = await domain.installSkillFiles({ name: "profile-skill", files: { "SKILL.md": "---\nname: profile-skill\ndescription: profile\n---\n" }, apps: { claude: true } });
  const profile = await domain.profileSnapshot({ name: "Project A", apps: ["claude"] });

  await providers.switchTo("claude", b.id);
  await domain.toggleMcp(mcp.id, "claude", false);
  await domain.toggleSkill(skill.id, "claude", false);
  await domain.disablePrompt("claude", prompt.id);
  const result = await domain.applyProfile(profile.id, { apps: ["claude"] });
  assert.deepEqual(result.warnings, []);
  assert.equal(providers.list().current.claude, a.id);
  assert.equal(domain.mcps().find((item) => item.id === mcp.id).apps.claude, true);
  assert.equal(domain.skills().find((item) => item.id === skill.id).apps.claude, true);
  assert.equal(domain.prompts("claude").find((item) => item.id === prompt.id).enabled, true);
  assert.equal(domain.profiles().current.claude, profile.id);
});

test("备份/恢复：ProviderStore 与领域状态一体恢复，删除需确认", async (t) => {
  const { domain, providers } = await fixture(t);
  const provider = await providers.create({ name: "Backup provider", baseUrl: "https://backup.example.com", apiKey: "secret", apps: { codex: true } });
  await providers.switchTo("codex", provider.id);
  const prompt = await domain.upsertPrompt("codex", { name: "Backup prompt", content: "backup content", enabled: true });
  const backup = await domain.createBackup("golden");
  await domain.disablePrompt("codex", prompt.id);
  await providers.update(provider.id, { name: "Changed" });

  const restored = await domain.restoreBackup(backup.filename);
  assert.deepEqual(restored.warnings, []);
  assert.equal(providers.list().providers[0].name, "Backup provider");
  assert.equal(domain.prompts("codex").find((item) => item.id === prompt.id).enabled, true);
  await assert.rejects(() => domain.deleteBackup(backup.filename), (error) => error.code === "CONFIRMATION_REQUIRED");
  assert.equal((await domain.deleteBackup(backup.filename, { confirmed: true })).removed, backup.filename);
});

test("默认批量重写和快照恢复不触碰 legacy Claude Desktop，显式兼容范围仍可同步", async (t) => {
  const { domain, providers, runtimeHome } = await fixture(t);
  const provider = await providers.create({
    name: "Legacy Desktop provider",
    baseUrl: "https://desktop-legacy.example.com",
    apiKey: "desktop-secret",
    apps: { "claude-desktop": true },
    models: { "claude-desktop": { model: "claude-desktop-model" } },
  });
  await providers.switchTo("claude-desktop", provider.id);
  const snapshot = domain.snapshot();
  const desktopConfig = join(runtimeHome, "AppData", "Local", "Claude", "claude_desktop_config.json");
  const sentinel = '{"sentinel":"keep-hidden-desktop"}\n';
  await writeFile(desktopConfig, sentinel, "utf8");

  await domain.syncAllLive();
  assert.equal(await readFile(desktopConfig, "utf8"), sentinel);
  await domain.restoreSnapshot(snapshot);
  assert.equal(await readFile(desktopConfig, "utf8"), sentinel);

  await domain.syncAllLive({ apps: ["claude-desktop"] });
  assert.notEqual(await readFile(desktopConfig, "utf8"), sentinel);
});

test("快照恢复在替换本地状态前拒绝无效 live 应用范围", async (t) => {
  const { domain, providers } = await fixture(t);
  await providers.create({ name: "Before invalid restore", baseUrl: "https://before.example.com", apps: { codex: true } });
  const before = domain.snapshot();
  const incoming = structuredClone(before);
  incoming.providers.providers[0].name = "Must not install";

  await assert.rejects(domain.restoreSnapshot(incoming, { apps: ["not-an-app"] }), { code: "VALIDATION_FAILED" });
  assert.equal(providers.list().providers[0].name, "Before invalid restore");
});

test("完整深链：Prompt/MCP 解析导入，MCP base64url 配置兼容", async (t) => {
  const { domain } = await fixture(t);
  const promptUrl = "ccswitch://v1/import?resource=prompt&app=codex&name=Review&content=Read%20first&enabled=true";
  const prompt = domain.parseDeeplink(promptUrl);
  assert.equal(prompt.resource, "prompt");
  assert.equal(prompt.payload.content, "Read first");
  const importedPrompt = await domain.importDeeplink(promptUrl);
  assert.equal(importedPrompt.item.enabled, true);

  const config = Buffer.from(JSON.stringify({ id: "deep-mcp", name: "Deep MCP", command: "node", args: ["index.mjs"] })).toString("base64url");
  const mcpUrl = `ccswitch://v1/import?resource=mcp&apps=claude%2Ccodex&config=${encodeURIComponent(config)}`;
  const parsed = domain.parseDeeplink(mcpUrl);
  assert.equal(parsed.payload.name, "Deep MCP");
  const importedMcp = await domain.importDeeplink(mcpUrl);
  assert.equal(importedMcp.item.apps.codex, true);
  assert.equal(importedMcp.item.config.command, "node");
});

test("WebDAV 真实 PUT/GET/HEAD：上传完整快照并可下载恢复", async (t) => {
  let stored = "";
  const remote = await listen(async (request, response) => {
    if (request.method === "OPTIONS") { response.writeHead(204, { dav: "1" }); response.end(); return; }
    if (request.method === "PUT") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      stored = Buffer.concat(chunks).toString("utf8");
      response.writeHead(201, { etag: '"v1"' }); response.end(); return;
    }
    if (request.method === "HEAD") { response.writeHead(stored ? 200 : 404, { etag: '"v1"', "content-length": String(Buffer.byteLength(stored)) }); response.end(); return; }
    if (request.method === "GET") { response.writeHead(stored ? 200 : 404, { "content-type": "application/json" }); response.end(stored); return; }
    response.writeHead(405); response.end();
  });
  t.after(remote.close);
  const { domain } = await fixture(t);
  await domain.saveSyncSettings("webdav", { enabled: true, baseUrl: `${remote.origin}/dav/`, username: "alice", password: "secret", passwordTouched: true, remotePath: "ccswitch/backup.json" });
  assert.deepEqual(await domain.testSync("webdav"), { ok: true, kind: "webdav" });
  await domain.upsertPrompt("codex", { name: "Remote", content: "before upload" });
  const upload = await domain.syncUpload("webdav");
  assert.ok(upload.bytes > 100);
  assert.equal(JSON.parse(stored).schema, "514cc.ccswitch-snapshot/v1");
  await domain.upsertPrompt("codex", { name: "After", content: "local only" });
  await domain.syncDownload("webdav", { syncLive: false });
  assert.equal(domain.prompts("codex").some((item) => item.name === "After"), false);
  assert.equal((await domain.syncRemoteInfo("webdav")).etag, '"v1"');
});

test("S3 SigV4：自定义 path-style 端点执行 HEAD/PUT/GET 且签名不泄露 secret", async (t) => {
  let stored = "";
  const seen = [];
  const remote = await listen(async (request, response) => {
    seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization, date: request.headers["x-amz-date"] });
    if (!request.headers.authorization?.startsWith("AWS4-HMAC-SHA256 Credential=AKID/")) { response.writeHead(403); response.end(); return; }
    if (request.method === "HEAD") { response.writeHead(200, { etag: '"s3-v1"', "content-length": String(Buffer.byteLength(stored)) }); response.end(); return; }
    if (request.method === "PUT") { const chunks = []; for await (const chunk of request) chunks.push(chunk); stored = Buffer.concat(chunks).toString("utf8"); response.writeHead(200); response.end(); return; }
    if (request.method === "GET") { response.writeHead(200, { "content-type": "application/json" }); response.end(stored); return; }
    response.writeHead(405); response.end();
  });
  t.after(remote.close);
  const { domain } = await fixture(t);
  await domain.saveSyncSettings("s3", { enabled: true, endpoint: remote.origin, region: "us-test-1", bucket: "forge", accessKeyId: "AKID", secretAccessKey: "TOPSECRET", secretTouched: true, key: "ccswitch/state.json", forcePathStyle: true });
  await domain.testSync("s3");
  await domain.syncUpload("s3");
  await domain.syncDownload("s3", { syncLive: false });
  assert.ok(seen.some((item) => item.method === "PUT" && item.url === "/forge/ccswitch/state.json"));
  assert.equal(JSON.stringify(seen).includes("TOPSECRET"), false);
  assert.equal(domain.summary().settings.s3.secretAccessKey, undefined);
  assert.equal(domain.summary().settings.s3.hasSecretAccessKey, true);
});

test("环境变量删除/恢复：双确认门、备份和 adapter 回读", async (t) => {
  const values = { OPENAI_API_KEY: "env-secret" };
  const envAdapter = {
    async inspect() { return values.OPENAI_API_KEY === undefined ? [] : [{ app: "codex", name: "OPENAI_API_KEY", value: values.OPENAI_API_KEY, scope: "User", source: "test" }]; },
    async remove(item) { const value = values[item.name]; delete values[item.name]; delete process.env[item.name]; return value; },
    async set(item) { values[item.name] = item.value; process.env[item.name] = item.value; },
  };
  process.env.OPENAI_API_KEY = values.OPENAI_API_KEY;
  t.after(() => { delete process.env.OPENAI_API_KEY; });
  const { domain } = await fixture(t, { envAdapter });
  assert.throws(() => domain.deleteEnv(["OPENAI_API_KEY"]), (error) => error.code === "CONFIRMATION_REQUIRED");
  const backup = await domain.deleteEnv(["OPENAI_API_KEY"], { confirmed: true });
  assert.equal(values.OPENAI_API_KEY, undefined);
  assert.equal(backup.items[0].scope, "User");
  assert.equal(backup.items[0].valueMasked, "••••cret");
  await domain.restoreEnv(backup.id, { confirmed: true });
  assert.equal(values.OPENAI_API_KEY, "env-secret");
});

test("OpenClaw workspace 与每日记忆：白名单、原子写入、检索、备份和确认删除", async (t) => {
  const { domain, runtimeHome } = await fixture(t);
  const first = await domain.writeWorkspaceFile("AGENTS.md", "first");
  assert.equal(first.backup, null);
  const second = await domain.writeWorkspaceFile("AGENTS.md", "second");
  assert.ok(second.backup);
  assert.equal((await domain.readWorkspaceFile("AGENTS.md")).content, "second");
  assert.throws(() => domain.writeWorkspaceFile("../escape.md", "x"), (error) => error.code === "VALIDATION_FAILED");

  await domain.writeDailyMemoryFile("2026-07-27.md", "alpha needle omega");
  await domain.writeDailyMemoryFile("2026-07-26.md", "older");
  assert.deepEqual((await domain.listDailyMemoryFiles()).map((item) => item.filename), ["2026-07-27.md", "2026-07-26.md"]);
  const search = await domain.searchDailyMemoryFiles("needle");
  assert.equal(search.length, 1);
  assert.match(search[0].snippet, /needle/);
  assert.throws(() => domain.deleteDailyMemoryFile("2026-07-27.md"), (error) => error.code === "CONFIRMATION_REQUIRED");
  const removed = await domain.deleteDailyMemoryFile("2026-07-27.md", { confirmed: true });
  assert.ok(removed.backup);
  assert.equal((await domain.readDailyMemoryFile("2026-07-27.md")).content, null);
  assert.equal(await readFile(join(runtimeHome, ".openclaw", "workspace", "AGENTS.md"), "utf8"), "second");
});

test("Hermes memory：双文件隔离、默认限额和 YAML 开关保留其他字段", async (t) => {
  const { domain, runtimeHome } = await fixture(t);
  await domain.writeHermesMemory("memory", "long memory");
  await domain.writeHermesMemory("user", "user profile");
  assert.equal((await domain.readHermesMemory("memory")).content, "long memory");
  assert.equal((await domain.readHermesMemory("user")).content, "user profile");
  assert.deepEqual(await domain.hermesMemoryLimits(), { memory: 2200, user: 1375, memoryEnabled: true, userEnabled: true });

  const configPath = join(runtimeHome, ".hermes", "config.yaml");
  await mkdir(join(runtimeHome, ".hermes"), { recursive: true });
  await writeFile(configPath, "memory:\n  memory_char_limit: 4096\n  user_char_limit: 2048\n  memory_enabled: true\n  user_profile_enabled: true\n  provider: mem0\n", "utf8");
  const toggled = await domain.setHermesMemoryEnabled("memory", false);
  assert.ok(toggled.backup);
  const written = await readFile(configPath, "utf8");
  assert.match(written, /memory_enabled: false/);
  assert.match(written, /provider: mem0/);
  assert.deepEqual(await domain.hermesMemoryLimits(), { memory: 4096, user: 2048, memoryEnabled: false, userEnabled: true });
});

test("live MCP/Skill 导入进投影账本，不改写 live；表单回写保留密钥", async (t) => {
  const { domain, runtimeHome } = await fixture(t);
  const claudeJson = join(runtimeHome, ".claude.json");
  const originalClaude = JSON.stringify({
    keep: true,
    mcpServers: {
      "ace-tool": { command: "npx", args: ["-y", "ace-tool"], env: { ACE_API_KEY: "real-secret-value" } },
      github: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer secret-token" } },
    },
    projects: {
      "I:/demo": { mcpServers: { "project-only": { command: "node", args: ["proj.mjs"] } } },
    },
  }, null, 2);
  await writeFile(claudeJson, originalClaude, "utf8");
  await mkdir(join(runtimeHome, ".claude"), { recursive: true });
  await writeFile(join(runtimeHome, ".claude", "settings.json"), JSON.stringify({
    mcpServers: { "from-settings": { command: "node", args: ["settings-mcp.mjs"] } },
  }), "utf8");
  await mkdir(join(runtimeHome, ".codex"), { recursive: true });
  await writeFile(join(runtimeHome, ".codex", "config.toml"), "model = \"gpt-test\"\r\n\r\n[mcp_servers.serena]\r\ncommand = \"uvx\"\r\nargs = [\"serena\"]\r\n\r\n[mcp_servers.ace-tool]\r\ncommand = \"uvx\"\r\nargs = [\"other-ace\"]\r\n", "utf8");
  await mkdir(join(runtimeHome, ".claude", "skills", "live-skill"), { recursive: true });
  await writeFile(join(runtimeHome, ".claude", "skills", "live-skill", "SKILL.md"), "---\nname: live-skill\ndescription: from live\n---\n# Live\n", "utf8");

  const observed = await domain.observeLiveResources();
  assert.equal(observed.mcps.find((item) => item.id === "ace-tool")?.managed, false);
  assert.equal(observed.mcps.find((item) => item.id === "ace-tool")?.importable, true);
  assert.equal(observed.mcps.find((item) => item.id === "ace-tool")?.apps.claude, true);
  assert.equal(observed.mcps.find((item) => item.id === "ace-tool")?.apps.codex, false, "同名但 command 不同时不得把 Codex 标成可投影");
  assert.equal(observed.mcps.find((item) => item.id === "from-settings")?.importable, true);
  assert.equal(observed.mcps.find((item) => item.id === "project-only")?.importable, false);
  assert.equal(observed.skills.find((item) => item.id === "live-skill")?.importable, true);

  const adopted = await domain.adoptLiveMcps();
  assert.ok(adopted.imported.includes("ace-tool"));
  assert.ok(adopted.imported.includes("github"));
  assert.ok(adopted.imported.includes("serena"));
  assert.ok(adopted.imported.includes("from-settings"));
  assert.ok(adopted.skipped.some((item) => item.id === "project-only"));
  assert.equal(await readFile(claudeJson, "utf8"), originalClaude, "导入不得改写 live .claude.json");
  assert.equal(domain.summary().mcps["ace-tool"].apps.codex, false);

  const publicMcp = domain.summary().mcps["ace-tool"];
  assert.match(publicMcp.config.env.ACE_API_KEY, /••••alue/);
  await domain.upsertMcp({
    id: "ace-tool",
    name: "ace-tool",
    config: publicMcp.config,
    apps: { claude: true, codex: false },
  });
  const afterSave = JSON.parse(await readFile(claudeJson, "utf8"));
  assert.equal(afterSave.keep, true);
  assert.equal(afterSave.mcpServers["ace-tool"].env.ACE_API_KEY, "real-secret-value");
  const codexAfterClaudeSave = await readFile(join(runtimeHome, ".codex", "config.toml"), "utf8");
  assert.match(codexAfterClaudeSave, /other-ace/, "未托管的 Codex 同名 server 不得被 Claude 保存删掉");

  const publicGithub = domain.summary().mcps.github;
  assert.match(publicGithub.config.headers.Authorization, /••••oken/);
  await domain.upsertMcp({
    id: "github",
    name: "github",
    config: publicGithub.config,
    apps: { claude: true },
  });
  const githubSaved = JSON.parse(await readFile(claudeJson, "utf8"));
  assert.equal(githubSaved.mcpServers.github.headers.Authorization, "Bearer secret-token");

  await domain.toggleMcp("serena", "codex", true);
  const codex = await readFile(join(runtimeHome, ".codex", "config.toml"), "utf8");
  assert.match(codex, /514-forge-mcp \(serena\)/);
  assert.equal([...codex.matchAll(/\[mcp_servers(?:\."serena"|\.serena)\]/g)].length, 1, "不得留下未托管表与托管块双份");

  const skillAdopt = await domain.adoptLiveSkills({ ids: ["live-skill"] });
  assert.deepEqual(skillAdopt.imported, ["live-skill"]);
  assert.equal(await readFile(join(runtimeHome, ".claude", "skills", "live-skill", "SKILL.md"), "utf8"), "---\nname: live-skill\ndescription: from live\n---\n# Live\n");
  assert.equal(domain.skills().find((item) => item.id === "live-skill")?.apps.claude, true);
  assert.equal(domain.skills().find((item) => item.id === "live-skill")?.apps.codex, false);
});

test("损坏领域存储冻结写入，不覆盖原字节", async (t) => {
  const { dataRoot, runtimeHome, providers } = await fixture(t);
  const path = join(dataRoot, "ccswitch-domain.json");
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path, "{broken", "utf8");
  const blocked = await new CcSwitchDomainService({ dataRoot, runtimeHome, providerStore: providers }).init();
  assert.equal(blocked.summary().storeStatus.state, "blocked");
  await assert.rejects(() => blocked.upsertPrompt("claude", { name: "No", content: "write" }), (error) => error.httpStatus === 503);
  assert.equal(await readFile(path, "utf8"), "{broken");
});
