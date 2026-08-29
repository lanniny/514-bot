import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexNativeSettings, buildGrokNativeSettings, buildNativeSettings, GROK_NATIVE_SETTINGS_AGENT } from "../src/cli-config-panel.mjs";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

// fixture 注入的机密值：断言整个响应 JSON 字符串绝不包含其子串（掩码红线）。
const SECRET_API_KEY = "xai-t5fixtureSecretKey0123456789ABCDEF";
const SECRET_BASE_URL_HOST = "internal-fixture.invalid";

const GROK_FIXTURE_TOML = `
[models]
default = "grok-4.6"
default_reasoning_effort = "xhigh"

[model."grok-4.6"]
base_url = "https://${SECRET_BASE_URL_HOST}/grok"
api_key = "${SECRET_API_KEY}"

[ui]
max_thoughts_width = 120
fork_secondary_model = "grok-4.5"
yolo = false
compact_mode = true
permission_mode = "always-approve"

[features]
remote_fetch = false

[plugins]
disabled = ["noop"]

[cli]
installer = "internal"
`;

async function jsonRequest(origin, path, token) {
  const response = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await response.json();
  return { response, payload };
}

function fieldOf(snapshot, key) {
  for (const group of snapshot.groups) {
    const field = group.fields.find((candidate) => candidate.key === key);
    if (field) return field;
  }
  return null;
}

function assertNoSecrets(serialized) {
  assert.equal(serialized.includes(SECRET_API_KEY), false, "api_key 值不得出现在快照中");
  assert.equal(serialized.includes(SECRET_BASE_URL_HOST), false, "base_url 值不得出现在快照中");
  assert.equal(serialized.includes("api_key"), false, "api_key 键名不得出现在快照中");
  assert.equal(serialized.includes("base_url"), false, "base_url 键名不得出现在快照中");
}

test("buildGrokNativeSettings 白名单分组解析 + 全链路脱敏", async () => {
  const root = await mkdtemp(resolve(appRoot, ".test-cli-config-panel-"));
  const home = resolve(root, "home");
  await mkdir(join(home, ".grok"), { recursive: true });
  await writeFile(join(home, ".grok", "config.toml"), GROK_FIXTURE_TOML, "utf8");
  try {
    const snapshot = await buildGrokNativeSettings({ home });
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.agent, GROK_NATIVE_SETTINGS_AGENT);
    assert.equal(snapshot.source, "~/.grok/config.toml");
    assert.ok(snapshot.generatedAt, "必须带生成时间戳");
    assert.ok(!Number.isNaN(Date.parse(snapshot.generatedAt)));
    assert.deepEqual(snapshot.groups.map((group) => group.id), ["agentApproval", "models", "appearance"]);

    // 字段形态 { key, label, value, group, type }（schema 驱动）
    for (const group of snapshot.groups) {
      for (const field of group.fields) {
        assert.equal(field.group, group.id);
        for (const property of ["key", "label", "value", "group", "type"]) {
          assert.equal(Object.hasOwn(field, property), true, `字段缺 ${property}: ${field.key}`);
        }
      }
    }

    const permission = fieldOf(snapshot, "permission_mode");
    assert.equal(permission.value, "always-approve");
    assert.equal(permission.type, "string");
    assert.equal(permission.group, "agentApproval");
    assert.equal(permission.semantic, "全自动");

    assert.equal(fieldOf(snapshot, "yolo").value, false);
    assert.equal(fieldOf(snapshot, "default").value, "grok-4.6");
    // 默认推理档位：白名单新字段，只是档位字符串，与 model-discovery 同源读取
    const defaultEffort = fieldOf(snapshot, "default_reasoning_effort");
    assert.equal(defaultEffort.value, "xhigh");
    assert.equal(defaultEffort.group, "models");
    assert.equal(defaultEffort.type, "string");
    assert.equal(fieldOf(snapshot, "fork_secondary_model").value, "grok-4.5");
    assert.equal(fieldOf(snapshot, "compact_mode").value, true);
    assert.equal(fieldOf(snapshot, "max_thoughts_width").value, 120);

    assertNoSecrets(JSON.stringify(snapshot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildGrokNativeSettings 缺失键给 null、缺文件给 available: false 且不抛错", async () => {
  const root = await mkdtemp(resolve(appRoot, ".test-cli-config-panel-"));
  try {
    // 空配置：白名单字段全在，值如实为 null
    const emptyHome = resolve(root, "empty-config-home");
    await mkdir(join(emptyHome, ".grok"), { recursive: true });
    await writeFile(join(emptyHome, ".grok", "config.toml"), "[cli]\ninstaller = \"internal\"\n", "utf8");
    const sparse = await buildGrokNativeSettings({ home: emptyHome });
    assert.equal(sparse.available, true);
    assert.equal(fieldOf(sparse, "permission_mode").value, null);
    assert.equal(fieldOf(sparse, "permission_mode").semantic, null);
    assert.equal(fieldOf(sparse, "default").value, null);
    assert.equal(fieldOf(sparse, "default_reasoning_effort").value, null, "白名单字段在，键缺失如实给 null");

    // 文件缺失：结构化降级，不抛错
    const missing = await buildGrokNativeSettings({ home: resolve(root, "no-such-home") });
    assert.equal(missing.available, false);
    assert.equal(missing.reason, "config-not-found");
    assert.deepEqual(missing.groups, []);
    assert.equal(JSON.stringify(missing).includes(SECRET_API_KEY), false);

    // 未知 agent：拒绝（端点据此返回 404）
    assert.equal(await buildNativeSettings("claude-fable"), null);
    assert.equal(await buildNativeSettings(""), null);
    assert.ok(await buildNativeSettings(GROK_NATIVE_SETTINGS_AGENT), "grok-build 必须命中白名单");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildGrokNativeSettings 容忍表头行尾注释（TOML 允许 [models] # comment）", async () => {
  const root = await mkdtemp(resolve(appRoot, ".test-cli-config-panel-"));
  const home = resolve(root, "home");
  await mkdir(join(home, ".grok"), { recursive: true });
  await writeFile(join(home, ".grok", "config.toml"), [
    "[models] # 默认模型档位区",
    'default = "grok-4.6"',
    'default_reasoning_effort = "high"',
    "",
    "[ui]\t# 界面区",
    "compact_mode = true",
    "",
  ].join("\n"), "utf8");
  try {
    const snapshot = await buildGrokNativeSettings({ home });
    assert.equal(snapshot.available, true);
    assert.equal(fieldOf(snapshot, "default").value, "grok-4.6", "带行尾注释的 [models] 表头必须命中");
    assert.equal(fieldOf(snapshot, "default_reasoning_effort").value, "high");
    assert.equal(fieldOf(snapshot, "compact_mode").value, true, "带行尾注释与制表符的 [ui] 表头必须命中");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GET /api/agents/native-settings HTTP 契约（只读 + 白名单 + 掩码）", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-cli-config-panel-http-"));
  const runtimeHome = resolve(root, "home");
  await mkdir(join(runtimeHome, ".grok"), { recursive: true });
  const configPath = join(runtimeHome, ".grok", "config.toml");
  await writeFile(configPath, GROK_FIXTURE_TOML, "utf8");
  const dataRoot = resolve(root, "data");
  const token = "cli-config-panel-http-token-0123456789";
  let child = spawnTestServer({ env: {
    CONTROL_CENTER_TOKEN: token,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_RUNTIME_HOME: runtimeHome,
    CONTROL_CENTER_PORT: "0",
  } });
  t.after(async () => {
    if (child && child.exitCode == null && child.signalCode == null) await stopTestServer(child, { token });
    await rm(root, { recursive: true, force: true });
  });

  const origin = new URL(await waitForUrl(child)).origin;

  const ok = await jsonRequest(origin, `/api/agents/native-settings?agent=${encodeURIComponent(GROK_NATIVE_SETTINGS_AGENT)}`, token);
  assert.equal(ok.response.status, 200);
  assert.equal(ok.payload.available, true);
  assert.equal(ok.payload.agent, GROK_NATIVE_SETTINGS_AGENT);
  assert.equal(ok.payload.groups.length, 3);
  assert.equal(fieldOf(ok.payload, "permission_mode").semantic, "全自动");
  assertNoSecrets(JSON.stringify(ok.payload));

  const missingAgent = await jsonRequest(origin, "/api/agents/native-settings", token);
  assert.equal(missingAgent.response.status, 422);
  assert.equal(missingAgent.payload.error.code, "VALIDATION_FAILED");

  const unknownAgent = await jsonRequest(origin, "/api/agents/native-settings?agent=claude-fable", token);
  assert.equal(unknownAgent.response.status, 404);
  assert.equal(unknownAgent.payload.error.code, "SOURCE_NOT_FOUND");

  // 配置文件消失：端点如实回 available: false，不 500
  await rm(configPath, { force: true });
  const gone = await jsonRequest(origin, `/api/agents/native-settings?agent=${encodeURIComponent(GROK_NATIVE_SETTINGS_AGENT)}`, token);
  assert.equal(gone.response.status, 200);
  assert.equal(gone.payload.available, false);
  assert.equal(gone.payload.reason, "config-not-found");
});

test("buildCodexNativeSettings 顶层白名单解析 + 语义映射 + 越表不读", async () => {
  const home = await mkdtemp(join(tmpdir(), "cc-codex-native-"));
  try {
    const codexDir = join(home, ".codex");
    await mkdir(codexDir, { recursive: true });
    // model_providers 段带 api key 引用：白名单只切顶层，绝不能读到
    const secret = "sk-codexFixtureShouldNeverLeak0123456789";
    await writeFile(join(codexDir, "config.toml"), `
model = "gpt-5.3-codex"
model_reasoning_effort = "high"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[model_providers.custom]
api_key = "${secret}"
base_url = "https://internal.invalid/v1"
`);
    const snapshot = await buildCodexNativeSettings({ home });
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.cli, "codex");
    assert.equal(snapshot.agent, "codex-technical");
    const flat = snapshot.groups.flatMap((group) => group.fields);
    const byKey = new Map(flat.map((field) => [field.key, field]));
    assert.equal(byKey.get("model").value, "gpt-5.3-codex");
    assert.equal(byKey.get("model_reasoning_effort").semantic, "高");
    assert.equal(byKey.get("approval_policy").value, "on-request");
    assert.equal(byKey.get("sandbox_mode").semantic, "工作区可写");
    const serialized = JSON.stringify(snapshot);
    assert.ok(!serialized.includes(secret), "provider secrets must never leak into the snapshot");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("buildCodexNativeSettings 缺文件/无白名单字段都如实报不可用", async () => {
  const missing = await buildCodexNativeSettings({ home: await mkdtemp(join(tmpdir(), "cc-codex-missing-")) });
  assert.equal(missing.available, false);
  assert.equal(missing.reason, "config-not-found");
  const emptyHome = await mkdtemp(join(tmpdir(), "cc-codex-empty-"));
  try {
    const codexDir = join(emptyHome, ".codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "config.toml"), "[features]\nremote_fetch = false\n");
    const snapshot = await buildCodexNativeSettings({ home: emptyHome });
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.reason, "no-whitelisted-fields");
  } finally {
    await rm(emptyHome, { recursive: true, force: true });
  }
});
