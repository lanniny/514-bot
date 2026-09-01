import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRepo = resolve(appRoot, "../..");

async function jsonRequest(origin, path, token, { method = "GET", body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { response, payload };
}

async function createIsolatedRepo(root) {
  const repoRoot = resolve(root, "repo");
  const configRoot = resolve(repoRoot, "config/control-center");
  const schemaRoot = resolve(repoRoot, "schemas/control-center");
  await mkdir(configRoot, { recursive: true });
  await mkdir(schemaRoot, { recursive: true });
  for (const name of [
    "models.json",
    "routing.json",
    "permissions.json",
    "claude-coordinator.md",
    "claude-headless-settings.json",
  ]) {
    await copyFile(resolve(sourceRepo, "config/control-center", name), resolve(configRoot, name));
  }
  const modelsPath = resolve(configRoot, "models.json");
  const modelRegistry = JSON.parse(await readFile(modelsPath, "utf8"));
  const kimiProfile = modelRegistry.profiles.find((profile) => profile.id === "kimi-frontend");
  if (kimiProfile) kimiProfile.command = "missing-kimi-cli-for-isolated-test";
  const codexProfile = modelRegistry.profiles.find((profile) => profile.id === "codex-technical");
  if (codexProfile) codexProfile.command = process.execPath;
  await writeFile(modelsPath, `${JSON.stringify(modelRegistry, null, 2)}\n`, "utf8");
  await copyFile(
    resolve(sourceRepo, "schemas/control-center/contracts.schema.json"),
    resolve(schemaRoot, "contracts.schema.json"),
  );
  await writeFile(resolve(configRoot, "sources.json"), `${JSON.stringify({
    version: 1,
    explicit: [
      { id: "control.models", path: "config/control-center/models.json", label: "Models", kind: "json", scope: "repo", critical: true },
      { id: "control.routing", path: "config/control-center/routing.json", label: "Routing", kind: "json", scope: "repo", critical: true },
      { id: "control.permissions", path: "config/control-center/permissions.json", label: "Permissions", kind: "json", scope: "repo", critical: true },
      { id: "control.claude-coordinator", path: "config/control-center/claude-coordinator.md", label: "Coordinator", kind: "markdown", scope: "repo", critical: true },
    ],
    discover: [],
    runtime: [],
  }, null, 2)}\n`, "utf8");
  return repoRoot;
}

test("Provider -> runtime seat -> member -> non-Claude coordinator is editable without JSON", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "514cc-runtime-seats-http-"));
  const repoRoot = await createIsolatedRepo(root);
  const dataRoot = resolve(root, "data");
  const runtimeHome = resolve(root, "home");
  await mkdir(runtimeHome, { recursive: true });
  const token = "runtime-seat-http-token-0123456789";
  let child = spawnTestServer({ env: {
    CONTROL_CENTER_TOKEN: token,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_RUNTIME_HOME: runtimeHome,
    CONTROL_CENTER_TEST_REPO_ROOT: repoRoot,
    CONTROL_CENTER_PORT: "0",
  } });
  t.after(async () => {
    if (child && child.exitCode == null && child.signalCode == null) await stopTestServer(child, { token });
    await rm(root, { recursive: true, force: true });
  });

  const origin = new URL(await waitForUrl(child)).origin;
  const initialMembers = await jsonRequest(origin, "/api/team-members", token);
  assert.equal(initialMembers.response.status, 200);
  assert.ok(initialMembers.payload.members.every((member) => member.description && member.systemPrompt));
  const codexMember = initialMembers.payload.members.find((member) => member.runtimeProfileId === "codex-technical");
  assert.ok(codexMember, "isolated runtime must expose a Codex logical member");

  const versionAction = await jsonRequest(origin, "/api/agents/actions", token, {
    method: "POST",
    body: { agent: codexMember.id, action: "version" },
  });
  assert.equal(versionAction.response.status, 200);
  assert.equal(versionAction.payload.status, "ok");
  assert.equal(versionAction.payload.runtimeProfileId, "codex-technical");
  assert.match(versionAction.payload.output, /^v\d+\./);
  assert.equal(JSON.stringify(versionAction.payload).includes(token), false);

  const unknownAction = await jsonRequest(origin, "/api/agents/actions", token, {
    method: "POST",
    body: { agent: codexMember.id, action: "shell" },
  });
  assert.equal(unknownAction.response.status, 422);
  assert.equal(unknownAction.payload.error.code, "AGENT_ACTION_UNSUPPORTED");

  const templates = await jsonRequest(origin, "/api/adapter-templates", token);
  assert.equal(templates.response.status, 200);
  assert.ok(templates.payload.templates.some((item) => (
    item.id === "codex-app-server"
    && item.providerApp === "codex"
    && item.coordinatorCapable === true
  )));

  const unknownPermission = await jsonRequest(origin, "/api/runs", token, {
    method: "POST",
    body: { prompt: "reject unknown permission", execute: false, permissionMode: "superuser" },
  });
  assert.equal(unknownPermission.response.status, 422);
  assert.equal(unknownPermission.payload.error.code, "VALIDATION_FAILED");

  const provider = await jsonRequest(origin, "/api/providers", token, {
    method: "POST",
    body: {
      name: "隔离 Codex Provider",
      providerType: "openai-compatible",
      baseUrl: "https://provider.invalid",
      apiKey: "sk-runtime-seat-test-secret",
      apps: { codex: true },
      models: { codex: { model: "gpt-seat-test", reasoningEffort: "high" } },
    },
  });
  assert.equal(provider.response.status, 201);
  assert.equal(provider.payload.apiKey, undefined);
  assert.equal(provider.payload.hasApiKey, true);

  // 无用脚本的供应商：用量路由回落 one-api 缺省探测，失败折叠为 success:false 且不回显 key
  const usageFallback = await jsonRequest(origin, `/api/providers/${provider.payload.id}/usage`, token, { method: "POST", body: {} });
  assert.equal(usageFallback.response.status, 200);
  assert.equal(usageFallback.payload.success, false);
  assert.equal(usageFallback.payload.code, "BALANCE_REQUEST_FAILED");
  assert.ok(!JSON.stringify(usageFallback.payload).includes("sk-runtime-seat-test-secret"));

  const unknown = await jsonRequest(origin, "/api/runtime-seats", token, {
    method: "POST",
    body: { id: "seat-unknown", adapter: "unknown-adapter" },
  });
  assert.equal(unknown.response.status, 422);
  assert.equal(unknown.payload.error.code, "ADAPTER_MANIFEST_INVALID");

  const commandWithArguments = await jsonRequest(origin, "/api/runtime-seats", token, {
    method: "POST",
    body: { id: "seat-command-args", adapter: "codex-app-server", command: "codex --profile executor" },
  });
  assert.equal(commandWithArguments.response.status, 422);
  assert.equal(commandWithArguments.payload.error.code, "VALIDATION_FAILED");

  // effort env 线接入后：managed k3 档位（low/high/max）放行，超出目录的档位仍 fail-closed
  const unsupportedKimiEffort = await jsonRequest(origin, "/api/runtime-seats", token, {
    method: "POST",
    body: {
      id: "seat-kimi-invalid-effort",
      adapter: "kimi-headless-resume",
      command: "kimi",
      defaultEffort: "ultra",
    },
  });
  assert.equal(unsupportedKimiEffort.response.status, 422);
  assert.equal(unsupportedKimiEffort.payload.error.code, "INVALID_EFFORT");

  const supportedKimiEffort = await jsonRequest(origin, "/api/runtime-seats", token, {
    method: "POST",
    body: {
      id: "seat-kimi-valid-effort",
      adapter: "kimi-headless-resume",
      command: "kimi",
      defaultEffort: "high",
    },
  });
  assert.equal(supportedKimiEffort.response.status, 201);
  assert.equal(supportedKimiEffort.payload.seat.defaultEffort, "high");

  // 未显式填写路由权重时按 Adapter 模板校准缺省回填；能力始终归一为默认全能力。
  const templateDefaults = await jsonRequest(origin, "/api/runtime-seats", token, {
    method: "POST",
    body: { id: "seat-opencode-defaults", adapter: "opencode-run-json", command: "opencode" },
  });
  assert.equal(templateDefaults.response.status, 201);
  assert.equal(templateDefaults.payload.seat.quality, 0.8);
  assert.equal(templateDefaults.payload.seat.speed, 0.85);
  assert.equal(templateDefaults.payload.seat.costTier, 2);
  assert.deepEqual(templateDefaults.payload.seat.capabilities, ["*"]);

  const seat = await jsonRequest(origin, "/api/runtime-seats", token, {
    method: "POST",
    body: {
      id: "seat-codex-custom",
      label: "自定义 Codex 主脑席",
      role: "technical-coordinator",
      description: "隔离测试中的可视化自定义运行席位。",
      systemPrompt: "作为当前团队主脑规划并编排任务，保留验证证据。",
      adapter: "codex-app-server",
      providerId: provider.payload.id,
      command: "C:\\Program Files\\Codex\\codex.exe",
      model: "gpt-seat-test",
      defaultEffort: "high",
      defaultPermissionMode: "read-only",
      capabilities: ["coding", "architecture", "testing"],
      coordinatorEligible: true,
      quality: 0.9,
      speed: 0.8,
      costTier: 3,
      enabled: true,
    },
  });
  assert.equal(seat.response.status, 201, JSON.stringify(seat.payload));
  assert.equal(seat.payload.seat.builtin, false);
  assert.equal(seat.payload.seat.command, "C:\\Program Files\\Codex\\codex.exe");
  assert.deepEqual(seat.payload.seat.capabilities, ["*"], "客户端旧能力子集不得收窄席位");
  assert.equal(seat.payload.seat.live.coordinatorEligible, true);
  assert.equal(seat.payload.seat.activation, "live");
  assert.equal(seat.payload.transaction.activation.status, "reloaded");

  const catalogSeat = await jsonRequest(origin, "/api/runtime-seats", token, {
    method: "POST",
    body: {
      id: "seat-adapter-switch",
      label: "待切换 Adapter 的席位",
      role: "catalog-regression",
      description: "验证切换 Adapter 后旧目录不会进入动态发现回退。",
      systemPrompt: "只用于隔离目录回归。",
      adapter: "codex-app-server",
      providerId: provider.payload.id,
      command: "codex",
      model: "gpt-seat-test",
      defaultEffort: "high",
      defaultPermissionMode: "read-only",
      capabilities: ["coding", "testing"],
      coordinatorEligible: false,
      modelOptions: [{ id: "gpt-seat-test", label: "GPT seat test" }],
      effortLevels: ["high", "xhigh"],
    },
  });
  assert.equal(catalogSeat.response.status, 201);
  const switchedSeat = await jsonRequest(origin, "/api/runtime-seats/seat-adapter-switch", token, {
    method: "PUT",
    body: {
      adapter: "kimi-headless-resume",
      provider: "moonshot",
      providerId: null,
      command: "missing-kimi-cli-for-isolated-test",
      model: null,
      defaultEffort: null,
      defaultPermissionMode: "read-only",
      capabilities: ["frontend", "ui", "coding"],
    },
  });
  assert.equal(switchedSeat.response.status, 200);
  assert.deepEqual(switchedSeat.payload.seat.capabilities, ["*"]);
  assert.equal(switchedSeat.payload.transaction.activation.status, "reloaded");
  assert.equal(Object.hasOwn(switchedSeat.payload.seat, "modelOptions"), false);
  assert.equal(Object.hasOwn(switchedSeat.payload.seat, "effortLevels"), false);
  const switchedOnDisk = JSON.parse(await readFile(resolve(repoRoot, "config/control-center/models.json"), "utf8"))
    .profiles.find((profile) => profile.id === "seat-adapter-switch");
  assert.equal(Object.hasOwn(switchedOnDisk, "modelOptions"), false);
  assert.equal(Object.hasOwn(switchedOnDisk, "effortLevels"), false);

  const switchedMember = await jsonRequest(origin, "/api/team-members", token, {
    method: "POST",
    body: {
      label: "切换目录探针",
      runtimeProfileId: "seat-adapter-switch",
      capabilities: ["coding"],
    },
  });
  assert.equal(switchedMember.response.status, 201);
  assert.deepEqual(switchedMember.payload.capabilities, ["*"]);
  const switchedFallback = await jsonRequest(origin, `/api/agents/models?agent=${encodeURIComponent(switchedMember.payload.id)}`, token);
  assert.equal(switchedFallback.response.status, 200);
  assert.equal(switchedFallback.payload.source, "fallback");
  assert.equal(switchedFallback.payload.models.some((model) => model.id === "gpt-seat-test"), false);
  assert.deepEqual(switchedFallback.payload.effortLevels, ["low", "high", "max"], "kimi 模板档位经 adapter-manifest 回退暴露");
  assert.equal((await jsonRequest(origin, `/api/team-members/${encodeURIComponent(switchedMember.payload.id)}`, token, { method: "DELETE" })).response.status, 200);
  assert.equal((await jsonRequest(origin, "/api/runtime-seats/seat-adapter-switch", token, { method: "DELETE" })).response.status, 200);

  const seatSnapshot = await jsonRequest(origin, "/api/runtime-seats", token);
  assert.equal(seatSnapshot.response.status, 200);
  assert.equal(seatSnapshot.payload.runtime.activation, "live");
  assert.equal(JSON.stringify(seatSnapshot.payload).includes("sk-runtime-seat-test-secret"), false);

  const missingMemberCatalog = await jsonRequest(origin, "/api/agents/models?agent=missing-member", token);
  assert.equal(missingMemberCatalog.response.status, 404);
  assert.equal(missingMemberCatalog.payload.error.code, "SOURCE_NOT_FOUND");

  const member = await jsonRequest(origin, "/api/team-members", token, {
    method: "POST",
    body: {
      label: "自定义主脑成员",
      shortLabel: "主脑",
      role: "technical-coordinator",
      description: "不依赖 Claude 的团队主脑。",
      systemPrompt: "负责当前团队的规划、编排和综合。",
      runtimeProfileId: "seat-codex-custom",
      capabilities: ["coding", "architecture"],
      mainBrainAllowed: true,
      defaultModel: "gpt-seat-test",
      defaultEffort: "high",
    },
  });
  assert.equal(member.response.status, 201);
  assert.equal(member.payload.coordinatorEligible, true);
  assert.deepEqual(member.payload.capabilities, ["*"]);

  const kimiMember = await jsonRequest(origin, "/api/team-members", token, {
    method: "POST",
    body: {
      label: "Kimi 模型目录成员",
      shortLabel: "Kimi",
      role: "frontend-engineer",
      description: "验证逻辑成员到 Kimi 运行席位的动态控制目录。",
      systemPrompt: "负责前端工程与浏览器验证。",
      runtimeProfileId: "kimi-frontend",
      capabilities: ["frontend", "ui"],
      mainBrainAllowed: false,
    },
  });
  assert.equal(kimiMember.response.status, 201);
  assert.deepEqual(kimiMember.payload.capabilities, ["*"]);

  const kimiCatalog = await jsonRequest(origin, `/api/agents/models?agent=${encodeURIComponent(kimiMember.payload.id)}`, token);
  assert.equal(kimiCatalog.response.status, 200);
  assert.equal(kimiCatalog.payload.context.memberId, kimiMember.payload.id);
  assert.equal(kimiCatalog.payload.context.runtimeProfileId, "kimi-frontend");
  assert.equal(kimiCatalog.payload.context.adapterId, "kimi-headless-resume");
  assert.ok(kimiCatalog.payload.models.some((model) => model.id === "kimi-code/k3"));
  assert.equal(kimiCatalog.payload.controls.effort.supported, true);
  assert.equal(kimiCatalog.payload.controls.effort.mode, "env");
  assert.deepEqual(kimiCatalog.payload.controls.effort.options.map((option) => option.value), ["low", "high", "max"]);
  assert.equal(kimiCatalog.payload.commands.filter((command) => command.token === "/effort").length, 3);

  const team = await jsonRequest(origin, "/api/teams", token, {
    method: "POST",
    body: {
      name: "无 Claude 自定义团队",
      members: [member.payload.id],
      coordinator: member.payload.id,
      startAgentId: member.payload.id,
    },
  });
  assert.equal(team.response.status, 201);
  assert.deepEqual(team.payload.members, [member.payload.id]);
  assert.equal(team.payload.coordinator, member.payload.id);
  assert.equal(team.payload.members.includes("claude-fable"), false);

  const denyMemberCoordinator = await jsonRequest(origin, `/api/team-members/${encodeURIComponent(member.payload.id)}`, token, {
    method: "PUT",
    body: { mainBrainAllowed: false },
  });
  assert.equal(denyMemberCoordinator.response.status, 409);
  assert.equal(denyMemberCoordinator.payload.error.code, "TEAM_CATALOG_CONFLICT");

  const providerInUse = await jsonRequest(origin, `/api/providers/${encodeURIComponent(provider.payload.id)}`, token, { method: "DELETE" });
  assert.equal(providerInUse.response.status, 409);
  assert.equal(providerInUse.payload.error.code, "PROVIDER_IN_USE");
  const seatInUse = await jsonRequest(origin, "/api/runtime-seats/seat-codex-custom", token, { method: "DELETE" });
  assert.equal(seatInUse.response.status, 409);
  assert.equal(seatInUse.payload.error.code, "RUNTIME_SEAT_IN_USE");

  assert.equal((await jsonRequest(origin, `/api/teams/${encodeURIComponent(team.payload.id)}`, token, { method: "DELETE" })).response.status, 200);
  assert.equal((await jsonRequest(origin, `/api/team-members/${encodeURIComponent(kimiMember.payload.id)}`, token, { method: "DELETE" })).response.status, 200);
  assert.equal((await jsonRequest(origin, `/api/team-members/${encodeURIComponent(member.payload.id)}`, token, { method: "DELETE" })).response.status, 200);
  assert.equal((await jsonRequest(origin, "/api/runtime-seats/seat-codex-custom", token, { method: "DELETE" })).response.status, 200);
  assert.equal((await jsonRequest(origin, `/api/providers/${encodeURIComponent(provider.payload.id)}`, token, { method: "DELETE" })).response.status, 200);

  const models = JSON.parse(await readFile(resolve(repoRoot, "config/control-center/models.json"), "utf8"));
  assert.equal(models.profiles.some((profile) => profile.id === "seat-codex-custom"), false);
});
