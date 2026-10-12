import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapters } from "../src/adapters/index.mjs";
import { ADAPTER_BINDINGS, ADAPTER_TEMPLATES, createTeamCatalog } from "../src/adapters/manifest.mjs";
import { ProviderStore } from "../src/providers.mjs";
import { validateContent, validateRepositoryTruth } from "../src/validator.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(appRoot, "..", "..");

test("module.yaml passes its schema and all repository truth checks", async () => {
  const path = resolve(repoRoot, "module.yaml");
  const content = await readFile(path, "utf8");
  const moduleResult = await validateContent({ id: "core.module", path, kind: "yaml" }, content);
  assert.equal(moduleResult.valid, true, moduleResult.errors.join("\n"));
  assert.equal(moduleResult.parser, "python-yaml-jsonschema");

  const truth = await validateRepositoryTruth(repoRoot);
  assert.deepEqual(
    truth.map((result) => result.id),
    [
      "registry.skills",
      "registry.adapters",
      "registry.plugin",
      "registry.customize",
      "registry.models",
      "framework.version",
      "runtime.contracts",
      "governance.handoff",
      "governance.hooks",
    ],
  );
  assert.equal(truth.every((result) => result.valid), true, JSON.stringify(truth, null, 2));
});

test("runtime adapter factories realize enabled manifest bindings exactly", async () => {
  const models = JSON.parse(await readFile(resolve(repoRoot, "config/control-center/models.json"), "utf8"));
  const enabledProfiles = new Set(models.profiles.filter((profile) => profile.enabled !== false).map((profile) => profile.id));
  const adapters = createAdapters({
    profiles: models.profiles,
    eventStore: { emit: async () => {} },
    cwd: repoRoot,
    approvalResolver: null,
  });
  // 固定绑定之外，自定义席位（builtin === false）也必须按其声明的模板实例化——
  // 席位引用的 provider 当前环境解析不到时降级为 Adapter 管理，不再阻断实例化。
  const customSeats = models.profiles
    .filter((profile) => profile.builtin === false && profile.enabled !== false)
    .map((profile) => ({ profileId: profile.id, adapterId: profile.adapter }));
  const byProfileId = (list) => [...list].sort((a, b) => a.profileId.localeCompare(b.profileId));
  assert.deepEqual(
    byProfileId([...adapters].map(([profileId, adapter]) => ({ profileId, adapterId: adapter.id }))),
    byProfileId([
      ...ADAPTER_BINDINGS
        .filter((binding) => enabledProfiles.has(binding.fallbackFor || binding.profileId))
        .map(({ profileId, adapterId }) => ({ profileId, adapterId })),
      ...customSeats,
    ]),
  );
  await Promise.all([...adapters.values()].map((adapter) => adapter.close?.()));
});

test("adapter templates do not expose capability envelopes", () => {
  for (const template of ADAPTER_TEMPLATES) {
    assert.equal(Object.hasOwn(template, "capabilityEnvelope"), false, `${template.id} still exposes a capability envelope`);
  }
});

test("seat provider bindings degrade to adapter-managed instead of crashing the control plane", async () => {
  const profile = {
    id: "qa-degraded-seat",
    builtin: false,
    label: "降级探针",
    adapter: "opencode-run-json",
    command: "opencode",
    providerId: "provider-missing-0000",
    capabilities: [],
  };
  const warnings = [];
  const catalog = createTeamCatalog([profile], { onProviderDegraded: (info) => warnings.push(info) });
  assert.equal(catalog[0].providerId, null, "ProviderStore 缺席时降级为 Adapter 管理");
  assert.equal(catalog[0].providerDegraded?.providerId, "provider-missing-0000");
  assert.equal(catalog[0].providerDegraded?.reason, "provider-store-unavailable");
  assert.equal(catalog[0].teamMemberEligible, true, "降级不影响席位可执行性");
  assert.deepEqual(warnings.map((item) => item.runtimeProfileId), ["qa-degraded-seat"]);

  const missing = createTeamCatalog([profile], {
    providerStore: { get: () => { throw Object.assign(new Error("nope"), { code: "PROVIDER_NOT_FOUND" }); } },
  });
  assert.equal(missing[0].providerDegraded?.reason, "provider-missing");

  const wrongApp = createTeamCatalog([profile], {
    providerStore: { get: () => ({ name: "x", apps: { claude: true } }) },
  });
  assert.equal(wrongApp[0].providerDegraded?.reason, "provider-app-disabled");
  assert.equal(wrongApp[0].providerDegraded?.providerApp, "opencode");

  const resolved = createTeamCatalog([profile], {
    providerStore: { get: () => ({ name: "Micu", providerType: "relay", apps: { opencode: true } }) },
  });
  assert.equal(resolved[0].providerId, "provider-missing-0000");
  assert.equal(resolved[0].providerDegraded, null);
  assert.equal(resolved[0].provider, "Micu");

  // 结构性矛盾（模板不支持 provider 绑定）保持 fail-closed
  assert.throws(
    () => createTeamCatalog([{ ...profile, adapter: "pi-rpc" }]),
    { code: "ADAPTER_MANIFEST_INVALID" },
  );

  // 执行侧同一语义：降级席位照样实例化 adapter（不挂 provider 投影）
  const adapters = createAdapters({
    profiles: [profile],
    eventStore: { emit: async () => {} },
    cwd: repoRoot,
    approvalResolver: null,
  });
  assert.equal(adapters.get("qa-degraded-seat")?.id, "opencode-run-json");
  await Promise.all([...adapters.values()].map((adapter) => adapter.close?.()));
});

test("adapter provider binding descriptor is re-resolved for every execution attempt", async () => {
  const profile = {
    id: "qa-dynamic-provider-seat",
    builtin: false,
    adapter: "opencode-run-json",
    command: "opencode",
    providerId: "provider-dynamic-0001",
    capabilities: [],
  };
  let provider = null;
  let beforeProjection = null;
  const projections = [];
  const providerStore = {
    current: {},
    proxyRuntime: { takeover: new Set() },
    get() {
      if (!provider) throw Object.assign(new Error("missing"), { code: "PROVIDER_NOT_FOUND" });
      return provider;
    },
    async withProviderProjection(app, providerIdOrResolver, operation) {
      await beforeProjection?.();
      const providerId = typeof providerIdOrResolver === "function"
        ? await providerIdOrResolver()
        : providerIdOrResolver;
      if (providerId) {
        projections.push({ app, providerId });
        this.current[app] = providerId;
      }
      return operation(providerId ?? null);
    },
  };
  const adapters = createAdapters({
    profiles: [profile],
    eventStore: { emit: async () => {} },
    cwd: repoRoot,
    approvalResolver: null,
    providerStore,
  });
  const adapter = adapters.get(profile.id);
  adapter.send = async () => ({ sessionId: "qa-session", text: "ok" });
  assert.deepEqual(adapter.getProviderBinding(), {
    requestedProviderId: profile.providerId,
    effectiveProviderId: null,
    mode: "adapter-managed",
    degradedReason: "provider-missing",
    degradedDetail: { providerId: profile.providerId, reason: "provider-missing", detail: "PROVIDER_NOT_FOUND" },
    providerApp: "opencode",
    adapterId: "opencode-run-json",
    routeMode: "adapter-managed",
    bindingScope: "adapter",
    upstreamProviderId: null,
    upstreamAttribution: "unavailable",
  });
  assert.equal((await adapter.send({})).providerBinding.mode, "adapter-managed");
  assert.equal(projections.length, 0);

  provider = { id: profile.providerId, apps: { opencode: true } };
  assert.equal(adapter.getProviderBinding().mode, "bound");
  assert.equal(adapter.getProviderBinding().effectiveProviderId, profile.providerId);
  assert.equal(adapter.getProviderBinding().bindingScope, "upstream");
  assert.equal(adapter.getProviderBinding().upstreamProviderId, profile.providerId);
  assert.equal(adapter.getProviderBinding().upstreamAttribution, "exact");
  assert.equal((await adapter.send({})).providerBinding.effectiveProviderId, profile.providerId);
  assert.deepEqual(projections, [{ app: "opencode", providerId: profile.providerId }]);

  beforeProjection = async () => {
    providerStore.proxyRuntime.takeover.add("opencode");
    beforeProjection = null;
  };
  const queuedEnable = await adapter.send({});
  assert.equal(queuedEnable.providerBinding.routeMode, "local-proxy");
  assert.equal(queuedEnable.providerBinding.bindingScope, "dispatch");
  assert.equal(queuedEnable.providerBinding.upstreamProviderId, null);
  assert.equal(queuedEnable.providerBinding.upstreamAttribution, "proxy-request-unlinked");

  const proxyBinding = adapter.getProviderBinding();
  assert.equal(proxyBinding.routeMode, "local-proxy");
  assert.equal(proxyBinding.bindingScope, "dispatch");
  assert.equal(proxyBinding.effectiveProviderId, profile.providerId);
  assert.equal(proxyBinding.upstreamProviderId, null);
  assert.equal(proxyBinding.upstreamAttribution, "proxy-request-unlinked");
  assert.equal((await adapter.send({})).providerBinding.bindingScope, "dispatch");
  assert.equal(projections.length, 3);

  beforeProjection = async () => {
    providerStore.proxyRuntime.takeover.delete("opencode");
    beforeProjection = null;
  };
  const queuedDisable = await adapter.send({});
  assert.equal(queuedDisable.providerBinding.routeMode, "direct-projection");
  assert.equal(queuedDisable.providerBinding.bindingScope, "upstream");
  assert.equal(queuedDisable.providerBinding.upstreamProviderId, profile.providerId);
  assert.equal(queuedDisable.providerBinding.upstreamAttribution, "exact");

  beforeProjection = async () => {
    provider = { id: profile.providerId, apps: { opencode: false } };
    beforeProjection = null;
  };
  const disabledWhileQueued = await adapter.send({});
  assert.equal(disabledWhileQueued.providerBinding.mode, "adapter-managed");
  assert.equal(disabledWhileQueued.providerBinding.degradedReason, "provider-app-disabled");
  assert.equal(projections.length, 4);

  provider = { id: profile.providerId, apps: { opencode: true } };
  beforeProjection = async () => {
    provider = null;
    beforeProjection = null;
  };
  const removedWhileQueued = await adapter.send({});
  assert.equal(removedWhileQueued.providerBinding.mode, "adapter-managed");
  assert.equal(removedWhileQueued.providerBinding.degradedReason, "provider-missing");
  assert.equal(projections.length, 4);
  await adapter.close?.();
});

test("adapter provider binding falls back after a real projection TOCTOU invalidates the provider", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-adapter-provider-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new ProviderStore({
    dataRoot: resolve(root, "data"),
    runtimeHome: resolve(root, "home"),
  }).init();
  const incumbent = await store.create({
    name: "Projection incumbent",
    baseUrl: "https://incumbent.example.test/v1",
    apiKey: "sk-incumbent-test",
    apps: { claude: true, opencode: true },
    models: { opencode: { model: "incumbent-model" } },
  });
  const target = await store.create({
    name: "Projection target",
    baseUrl: "https://target.example.test/v1",
    apiKey: "sk-target-test",
    apps: { claude: true, opencode: true },
    models: { opencode: { model: "target-model" } },
  });
  await store.switchTo("opencode", incumbent.id);

  let invalidated = false;
  // 保持真实 ProviderStore 的 projection lock，只在 resolver 返回旧 id 后注入
  // 一个真实 update；这样能稳定覆盖 resolver 与 #switchToSerialized 之间的窗口。
  const providerStore = new Proxy(store, {
    get(realStore, property) {
      if (property === "withProviderProjection") {
        return (app, resolver, operation) => realStore.withProviderProjection(
          app,
          async () => {
            const providerId = await resolver();
            if (!invalidated) {
              invalidated = true;
              await realStore.update(target.id, { apps: { opencode: false } });
            }
            return providerId;
          },
          operation,
        );
      }
      const value = Reflect.get(realStore, property, realStore);
      return typeof value === "function" ? value.bind(realStore) : value;
    },
  });
  const adapters = createAdapters({
    profiles: [{
      id: "qa-real-provider-race",
      builtin: false,
      adapter: "opencode-run-json",
      command: "opencode",
      providerId: target.id,
      capabilities: [],
    }],
    eventStore: { emit: async () => {} },
    cwd: repoRoot,
    approvalResolver: null,
    providerStore,
  });
  const adapter = adapters.get("qa-real-provider-race");
  let sends = 0;
  adapter.send = async () => {
    sends += 1;
    return { sessionId: "degraded-session", text: "adapter-managed" };
  };

  const result = await adapter.send({ prompt: "race" });
  assert.equal(invalidated, true);
  assert.equal(sends, 1, "invalidated projection must retry exactly once through the adapter");
  assert.equal(result.providerBinding.mode, "adapter-managed");
  assert.equal(result.providerBinding.degradedReason, "provider-app-disabled");
  assert.equal(store.get(target.id).apps.opencode, false);
  await adapter.close?.();
});

test("module schema rejects a structurally incomplete registry", async () => {
  const path = resolve(repoRoot, "module.yaml");
  const content = (await readFile(path, "utf8")).replace(/^skills:/m, "unregistered_skills:");
  const result = await validateContent({ id: "core.module", path, kind: "yaml" }, content);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /skills.*required|required.*skills/i);
});

test("module schema rejects a missing handoff governance contract", async () => {
  const path = resolve(repoRoot, "module.yaml");
  const content = (await readFile(path, "utf8")).replace(/^  handoff_sources:/m, "  unregistered_handoff_sources:");
  const result = await validateContent({ id: "core.module", path, kind: "yaml" }, content);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /handoff_sources.*required|required.*handoff_sources/i);
});

test("module schema rejects a missing Codex route hook registration", async () => {
  const path = resolve(repoRoot, "module.yaml");
  const content = (await readFile(path, "utf8")).replace(
    /^    - file: \.codex\/hooks\/route-gate-codex\.py$/m,
    "    - file: .codex/hooks/unregistered-route-gate-codex.py",
  );
  const result = await validateContent({ id: "core.module", path, kind: "yaml" }, content);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /route-gate-codex\.py|UserPromptSubmit/);
});

test("module schema rejects a missing adapter manifest contract", async () => {
  const path = resolve(repoRoot, "module.yaml");
  const content = (await readFile(path, "utf8")).replace(/^  adapter_manifest:/m, "  unregistered_adapter_manifest:");
  const result = await validateContent({ id: "core.module", path, kind: "yaml" }, content);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /adapter_manifest.*required|required.*adapter_manifest/i);
});

/**
 * 2026-10-09 删除的五个"零消费者"配置块必须**禁止回流**（烛 R1 致命 1：
 * 断言本身有效但零测试覆盖——删掉整块断言测试仍全绿，即"无机械承载的规则"，
 * 正是本轮要消灭的形态出现在修它的补丁里）。
 *
 * 这五个字段各有更权威真源（称呼→CLAUDE.md:3 / 语言→rules.md §七 / 项目名→cwd /
 * 产物目录→rules.md §六 持久化表），故按 intent-without-mechanical-carrier 的正解
 * 删表 + 断言，而非给它们加消费者。
 */
test("module schema rejects the removed zero-consumer config blocks", async () => {
  const path = resolve(repoRoot, "module.yaml");
  const base = await readFile(path, "utf8");
  const removed = ["user_name", "communication_language", "document_output_language", "project_name", "output_folder"];
  // 基线：当前 module.yaml（已删除这五个）必须通过
  const baseline = await validateContent({ id: "core.module", path, kind: "yaml" }, base);
  assert.equal(baseline.valid, true, baseline.errors.join("\n"));

  for (const field of removed) {
    // 逐字段注入回流：标量、空表、有内容的表三种形态都必须被拒
    for (const [shape, block] of [
      ["scalar", `${field}: "回流测试"\n`],
      ["empty-table", `${field}: {}\n`],
      ["table", `${field}:\n  prompt: "回流测试"\n  default: "x"\n`],
    ]) {
      const content = `${base}\n${block}`;
      const result = await validateContent({ id: "core.module", path, kind: "yaml" }, content);
      assert.equal(result.valid, false, `re-adding ${field} as ${shape} must be rejected`);
      assert.match(
        result.errors.join("\n"),
        new RegExp(field),
        `rejection for ${field} (${shape}) must name the offending field`,
      );
    }
  }
});

function fixtureModule({ version = "3.5.0", includeBeta = true, adapters = ["foo"] } = {}) {
  return [
    "code: 514cc",
    "name: fixture",
    `version: "${version}"`,
    "description: fixture",
    "license: test",
    "agents: []",
    "skills:",
    "  - code: alpha",
    "    path: skills/alpha",
    ...(includeBeta ? [
      "  - code: beta",
      "    path: .agents/skills/beta",
    ] : []),
    "  - code: co-review",
    "    path: .agents/skills/co-review",
    "  - code: codex-reviewer",
    "    path: skills/review/codex-reviewer",
    "    type: agent",
    "  - code: grok-researcher",
    "    path: skills/research/grok-researcher",
    "dependencies:",
    "  node: \">=22.5.0\"",
    "  python: \">=3.11\"",
    "  kimi-code-cli: \"0.28.0\"",
    "  validation-python-packages: requirements-validation.txt",
    "control_center:",
    "  adapter_manifest: apps/control-center/src/adapters/manifest.mjs",
    "  adapters:",
    ...adapters.map((adapter) => `    - ${adapter}`),
    "  provider_contracts:",
    "    kimi:",
    "      cli_version: \"0.28.0\"",
    "      profile: kimi-frontend",
    "      adapter: kimi-headless-resume",
    "      read_only_permission_flag: --plan",
    "      workspace_write_policy: fail-closed",
    "harness_hooks:",
    "  handoff_sources: .claude/hooks/handoff-sources.json",
    "  required_handoff_prefixes: [codex-to-, grok-to-, gemini-to-, kimi-to-, synthesis__]",
    "  delta_contract:",
    "    scores: [0, 1, 2]",
    "    evidence_required: true",
    "    hooks:",
    "      claude: .claude/hooks/stop-gate.py",
    "      codex: .codex/hooks/stop-gate-codex.py",
    "    template_assets: [AGENTS.md, .agents/skills/co-review/SKILL.md, skills/review/codex-reviewer/SKILL.md, skills/research/grok-researcher/SKILL.md]",
    "  hooks:",
    "    - file: .claude/hooks/stop-gate.py",
    "      event: Stop",
    "      role: codex-to- grok-to- gemini-to- kimi-to- synthesis__ missing malformed DELTA fixture",
    "    - file: .codex/hooks/stop-gate-codex.py",
    "      event: Stop",
    "      role: fixture",
    "    - file: .codex/hooks/route-gate-codex.py",
    "      event: UserPromptSubmit",
    "      role: fixture",
    "    - file: .codex/hooks/mirror-gate-codex.py",
    "      event: SessionStart",
    "      role: fixture",
    "",
  ].join("\n");
}

function fixtureCodexHooks(root, { routeEvent = "UserPromptSubmit" } = {}) {
  const command = (file) => `python "${resolve(root, file)}"`;
  return JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: command(".codex/hooks/mirror-gate-codex.py") }] }],
      [routeEvent]: [{ hooks: [{ type: "command", command: command(".codex/hooks/route-gate-codex.py") }] }],
      Stop: [{ hooks: [{ type: "command", command: command(".codex/hooks/stop-gate-codex.py") }] }],
    },
  }, null, 2);
}

function fixtureHandoffRegistry({ includeKimi = true } = {}) {
  const sources = [
    { id: "codex-reviewer", prefixes: ["codex-to-"] },
    { id: "grok-researcher", prefixes: ["grok-to-"] },
    { id: "gemini-legacy", prefixes: ["gemini-to-"] },
    ...(includeKimi ? [{ id: "kimi-driver", prefixes: ["kimi-to-"] }] : []),
    { id: "multi-agent-synthesis", prefixes: ["synthesis__"] },
  ];
  return JSON.stringify({ schemaVersion: 1, sources }, null, 2);
}

const FIXTURE_ADAPTER_BINDINGS = [
  {
    profileId: "alpha-profile",
    adapterId: "foo-alpha",
    factoryKey: "foo",
    requiresCommand: true,
    teamMemberEligible: true,
    coordinatorEligible: true,
  },
  {
    profileId: "kimi-frontend",
    adapterId: "kimi-headless-resume",
    factoryKey: "foo",
    requiresCommand: true,
    teamMemberEligible: true,
    coordinatorEligible: true,
  },
];

function fixtureAdapterManifest(bindings = FIXTURE_ADAPTER_BINDINGS) {
  const templates = [...new Map(bindings.map((binding) => [binding.adapterId, {
    id: binding.adapterId,
    factoryKey: binding.factoryKey,
    requiresCommand: binding.requiresCommand,
    teamMemberEligible: binding.teamMemberEligible,
    coordinatorCapable: binding.coordinatorEligible,
    selectable: true,
  }])).values()];
  return [
    `export const ADAPTER_BINDINGS = ${JSON.stringify(bindings, null, 2)};`,
    `export const ADAPTER_TEMPLATES = ${JSON.stringify(templates, null, 2)};`,
    "",
  ].join("\n");
}

function fixtureDeltaHook({ lax = false, includeMain = true, allowAllMain = false } = {}) {
  const statusBody = lax
    ? "return 'valid' if '__DELTA__:' in content else 'missing'"
    : [
      "saw_token = False",
      "for line in content.splitlines():",
      "    if not DELTA_TOKEN_RE.match(line):",
      "        continue",
      "    saw_token = True",
      "    if not DELTA_LINE_RE.fullmatch(line):",
      "        return 'invalid'",
      "return 'valid' if saw_token else 'missing'",
    ].join("\n    ");
  return [
    "import json",
    "import re",
    "import sys",
    "from pathlib import Path",
    "HANDOFF_SOURCE_REGISTRY = Path(__file__).resolve().parents[2] / '.claude' / 'hooks' / 'handoff-sources.json'",
    "DELTA_LINE_RE = re.compile(r'^__DELTA__:\\s*([^\\s|](?:[^|\\r\\n]*[^\\s|])?)\\s*\\|\\s*([012])\\s*\\|\\s*(\\S(?:[^\\r\\n]*\\S)?)\\s*$')",
    "DELTA_TOKEN_RE = re.compile(r'^__DELTA__:')",
    "SESSION_MARKER_RE = re.compile(r'^<!--\\s*514cc-session-id:\\s*([^\\s>]+)\\s*-->\\s*$', re.MULTILINE)",
    "def load_handoff_sources(registry_file=HANDOFF_SOURCE_REGISTRY):",
    "    raw = json.loads(Path(registry_file).read_text(encoding='utf-8'))",
    "    return tuple(sorted(((prefix, item['id']) for item in raw['sources'] for prefix in item['prefixes']), key=lambda item: len(item[0]), reverse=True))",
    "def handoff_source(name, sources):",
    "    return next((source for prefix, source in sources if name.startswith(prefix)), None)",
    "def delta_status(content):",
    `    ${statusBody}`,
    ...(includeMain && allowAllMain ? [
      "def main():",
      "    return 0",
    ] : includeMain ? [
      "def main():",
      "    try:",
      "        data = json.load(sys.stdin)",
      "    except Exception:",
      "        return 0",
      "    root = Path(data.get('cwd', ''))",
      "    handoff = root / '.ai-shared' / 'handoff'",
      "    session = data.get('session_id', '')",
      "    if not handoff.is_dir() or not session:",
      "        return 0",
      "    sources = load_handoff_sources()",
      "    for path in handoff.glob('*.md'):",
      "        if handoff_source(path.name, sources) is None:",
      "            continue",
      "        content = path.read_text(encoding='utf-8')",
      "        markers = SESSION_MARKER_RE.findall(content)",
      "        if len(markers) != 1 or markers[0] != session:",
      "            continue",
      "        if delta_status(content) != 'valid':",
      "            return 2",
      "    return 0",
    ] : []),
    "",
  ].join("\n");
}

async function createTruthFixture() {
  const root = await mkdtemp(resolve(appRoot, ".test-governance-"));
  const directories = [
    "skills/alpha",
    ".agents/skills/beta",
    "apps/control-center/src/adapters",
    "config/control-center",
    ".claude-plugin",
    ".claude/hooks",
    ".codex/hooks",
    ".agents/skills/co-review",
    "skills/review/codex-reviewer",
    "skills/research/grok-researcher",
    "guardrails",
    "customize",
  ];
  await Promise.all(directories.map((directory) => mkdir(resolve(root, directory), { recursive: true })));
  await Promise.all([
    writeFile(resolve(root, "skills/alpha/SKILL.md"), "---\nname: alpha\n---\n"),
    writeFile(resolve(root, ".agents/skills/beta/SKILL.md"), "---\nname: beta\n---\n"),
    writeFile(
      resolve(root, "skills/review/codex-reviewer/customize.toml"),
      [
        "[agent]",
        'name = "codex-reviewer"',
        'title = "fixture reviewer"',
        'principles = ["fixture principle"]',
        "",
        "[[agent.menu]]",
        'code = "SR"',
        'description = "Standard Review"',
        "",
        "[[agent.menu]]",
        'code = "SC"',
        'description = "Security Audit"',
        "",
      ].join("\n"),
    ),
    writeFile(resolve(root, "guardrails/deny-paths.txt"), "nothing\n"),
    writeFile(resolve(root, "customize/README.md"), "# customize fixture\n"),
    writeFile(resolve(root, "apps/control-center/src/adapters/foo.mjs"), "export class Foo {}\n"),
    writeFile(resolve(root, "apps/control-center/src/adapters/manifest.mjs"), fixtureAdapterManifest()),
    writeFile(
      resolve(root, "apps/control-center/src/adapters/index.mjs"),
      [
        'import { Foo } from "./foo.mjs";',
        'import { ADAPTER_BINDINGS } from "./manifest.mjs";',
        "export function createAdapters() {",
        "  return new Map(ADAPTER_BINDINGS.map((binding) => [binding.profileId, new Foo()]));",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      resolve(root, "config/control-center/models.json"),
      JSON.stringify({
        profiles: [
          { id: "alpha-profile", adapter: "foo-alpha" },
          {
            id: "kimi-frontend",
            adapter: "kimi-headless-resume",
            evidence: [{ source: "local-cli", detail: "Kimi Code CLI 0.28.0; fixture" }],
          },
        ],
      }),
    ),
    writeFile(
      resolve(root, "rules.md"),
      [
        "# 514cc fixture v3.5",
        "",
        "## 四、外部 CLI（fixture）",
        "**Kimi Code CLI**：`kimi` 0.28.0 --plan read-only; workspace-write fail-closed.",
        "",
        "## 八、版本",
        "- **v3.5.0** fixture",
        "",
      ].join("\n"),
    ),
    writeFile(resolve(root, "CHANGELOG.md"), "## 2026-07-17 - v3.5.0 fixture\n"),
    writeFile(
      resolve(root, "AGENTS.md"),
      "## 项目概览\n\n- **版本**：v3.5.0\n\n`__DELTA__: 烛(Codex) | 1 | evidence`\n",
    ),
    writeFile(resolve(root, "CLAUDE.md"), "## 项目概览\n\n- **当前版本**：**v3.5.0**\n"),
    writeFile(resolve(root, "README.md"), "# fixture\n\nv3.5.0 | 2026-07-17 | fixture\n"),
    writeFile(
      resolve(root, ".claude-plugin/plugin.json"),
      JSON.stringify({
        version: "3.5.0",
        components: {
          agents: { "codex-reviewer": { source: "skills/review/codex-reviewer/SKILL.md", customize: "skills/review/codex-reviewer/customize.toml" } },
          skills: ["skills/review/codex-reviewer/SKILL.md"],
          guardrails: "guardrails/",
          customize: "customize/",
          module_config: "module.yaml",
          rules: "rules.md",
        },
      }),
    ),
    writeFile(resolve(root, "apps/control-center/package.json"), JSON.stringify({ engines: { node: ">=22.5.0" } })),
    writeFile(resolve(root, ".claude/hooks/handoff-sources.json"), fixtureHandoffRegistry()),
    writeFile(resolve(root, ".claude/hooks/stop-gate.py"), fixtureDeltaHook()),
    writeFile(resolve(root, ".codex/hooks/stop-gate-codex.py"), fixtureDeltaHook()),
    writeFile(resolve(root, ".codex/hooks/route-gate-codex.py"), "raise SystemExit(0)\n"),
    writeFile(resolve(root, ".codex/hooks/mirror-gate-codex.py"), "raise SystemExit(0)\n"),
    writeFile(resolve(root, ".codex/hooks.json"), fixtureCodexHooks(root)),
    writeFile(
      resolve(root, ".agents/skills/co-review/SKILL.md"),
      "`__DELTA__: 烛(Codex) | 1 | evidence`\n",
    ),
    writeFile(
      resolve(root, "skills/review/codex-reviewer/SKILL.md"),
      "__DELTA__: {评审对象} | 1 | {evidence}\n",
    ),
    writeFile(
      resolve(root, "skills/research/grok-researcher/SKILL.md"),
      "__DELTA__: {调研对象} | 1 | {evidence}\n",
    ),
    writeFile(resolve(root, "module.yaml"), fixtureModule()),
  ]);
  return root;
}

test("repository truth checks fail closed on registry and version drift", async (t) => {
  const root = await createTruthFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const baseline = await validateRepositoryTruth(root);
  assert.equal(baseline.every((result) => result.valid), true, JSON.stringify(baseline, null, 2));

  await writeFile(resolve(root, "module.yaml"), fixtureModule({
    version: "3.4.3",
    includeBeta: false,
    adapters: ["foo", "ghost"],
  }));
  await writeFile(
    resolve(root, "config/control-center/models.json"),
    JSON.stringify({ profiles: [{ id: "unwired-profile" }] }),
  );
  // plugin.json 声明面漂移：把 skills[0] 指向一个磁盘不存在的路径（复现 2026-08-30
  // F-073 删目录但 plugin.json 没跟着删、静默漂移 40 天的形态）。
  await writeFile(
    resolve(root, ".claude-plugin/plugin.json"),
    JSON.stringify({
      version: "3.5.0",
      components: { skills: ["skills/research/web-intel/SKILL.md"] },
    }),
  );

  const drifted = await validateRepositoryTruth(root);
  const byId = new Map(drifted.map((result) => [result.id, result]));
  assert.equal(byId.get("registry.skills").valid, false);
  assert.match(byId.get("registry.skills").errors.join("\n"), /missing disk entries.*\.agents\/skills\/beta/);
  assert.equal(byId.get("registry.adapters").valid, false);
  assert.match(byId.get("registry.adapters").errors.join("\n"), /absent from disk.*ghost/);
  assert.equal(byId.get("registry.plugin").valid, false);
  assert.match(
    byId.get("registry.plugin").errors.join("\n"),
    /plugin\.json components\.skills\[0\] points at a path absent from disk: skills\/research\/web-intel\/SKILL\.md/,
  );
  assert.equal(byId.get("registry.models").valid, false);
  assert.match(byId.get("registry.models").errors.join("\n"), /unwired-profile.*no fixed adapter binding/);
  assert.equal(byId.get("framework.version").valid, false);
  assert.match(byId.get("framework.version").errors.join("\n"), /module\.yaml declares 3\.4\.3, expected 3\.5\.0/);
});

test("plugin manifest rejects component paths that escape the repository", async (t) => {
  const root = await createTruthFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  // 逃逸形态必须逐一被拦，且报"escapes"而非"absent from disk"——
  // 两者混淆会让守卫看似生效实则放行（烛 R1 致命 2：只测存在性分支 = 逃逸分支无保护）。
  const cases = [
    { label: "parent escape", value: "../outside-plugin.json" },
    // 跨盘符绝对路径：Windows 上 path.relative 跨盘符返回**绝对路径**（既非空也不以 .. 开头），
    // 只查前两条判据会静默放行。烛 R1 致命 1 实测注入 C:\Windows\win.ini 曾得 valid=true。
    { label: "cross-drive absolute", value: "C:\\Windows\\win.ini" },
  ];
  for (const { label, value } of cases) {
    await writeFile(
      resolve(root, ".claude-plugin/plugin.json"),
      JSON.stringify({ version: "3.5.0", components: { skills: [value] } }),
    );
    const truth = await validateRepositoryTruth(root);
    const pluginResult = truth.find((result) => result.id === "registry.plugin");
    assert.equal(pluginResult.valid, false, `${label} must fail the plugin manifest check`);
    assert.match(
      pluginResult.errors.join("\n"),
      /escapes the repository/,
      `${label} must be reported as an escape, not silently passed or misreported`,
    );
  }
});

test("plugin manifest rejects component paths that escape through a link", async (t) => {
  const root = await createTruthFixture();
  const outside = await mkdtemp(resolve(appRoot, ".test-governance-outside-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  // 链接穿透（烛 R2 实测）：纯字符串判据挡不住，因为 access 会**跟随** symlink/junction。
  // 声明字符串本身完全合法（`linked` 在仓库内），真实路径却在仓库外。
  await writeFile(resolve(outside, "secret.md"), "outside the repository\n");
  try {
    await symlink(outside, resolve(root, "linked"), "junction");
  } catch (error) {
    // Windows 上 junction 不需要管理员权限；若本机仍拒绝（EPERM/EEXIST），
    // 如实跳过而非假装通过——静默 pass 会让这条契约变成假保护。
    t.diagnostic(`link fixture unavailable on this host: ${error.code}`);
    return;
  }

  await writeFile(
    resolve(root, ".claude-plugin/plugin.json"),
    JSON.stringify({ version: "3.5.0", components: { skills: ["linked/secret.md"] } }),
  );
  const truth = await validateRepositoryTruth(root);
  const pluginResult = truth.find((result) => result.id === "registry.plugin");
  assert.equal(pluginResult.valid, false, "a path resolving outside the repo through a link must fail");
  assert.match(pluginResult.errors.join("\n"), /resolves outside the repository through a link/);
});

test("customize layers reject read-only overrides, unknown keys, and menu additions", async (t) => {
  const root = await createTruthFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, "customize/team"), { recursive: true });

  const overridePath = resolve(root, "customize/team/codex-reviewer.toml");
  const validate = async () => {
    const truth = await validateRepositoryTruth(root);
    return truth.find((result) => result.id === "registry.customize");
  };

  // 基线：合法 override（只改 base 已有的标量 / 替换已有 menu code）必须通过
  await writeFile(overridePath, '[agent]\nprinciples = ["覆盖后的原则"]\n\n[[agent.menu]]\ncode = "SR"\ndescription = "覆盖后的描述"\n');
  assert.equal((await validate()).valid, true, "a sparse, in-schema override must pass");

  // 基线 2：**新增** menu code 是合法的（README:17「新键追加」）——
  // 主驾初版曾据"无删除机制"推出"menu 只能替换不能新增"，烛 R2 判为过严假约束。
  await writeFile(overridePath, '[[agent.menu]]\ncode = "ZZ"\ndescription = "自定义菜单项"\n');
  assert.equal((await validate()).valid, true, "appending a new menu code must stay legal (README: new-key append)");

  // 判据 1：只读字段（rules.md §五 明文 agent.name / agent.title 只读）
  await writeFile(overridePath, '[agent]\nname = "被篡改的名字"\n');
  let result = await validate();
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /overrides read-only agent\.name/);

  // 判据 2：未知键（agent 层）
  await writeFile(overridePath, '[agent]\nunknown_field = "x"\n');
  result = await validate();
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /declares key absent from skills\/review\/codex-reviewer\/customize\.toml: agent\.unknown_field/);

  // 判据 2b：未知键在**更深一层**也必须被抓（烛 R2：只查 agent 一层等于挡一半）。
  // fixture 的 base 只有 [agent]，故这里用 agent 下的二级表做对照——
  // 真实场景对应 `[codex] invoke_patern = "typo"` 这类拼错键名。
  await writeFile(overridePath, '[agent.menu]\ncode = "SR"\n');
  result = await validate();
  assert.equal(result.valid, false, "shape mismatch (base menu is an array, override is a table) must fail");

  // 判据 3：同一 override 内 menu code 不得重复
  await writeFile(overridePath, '[[agent.menu]]\ncode = "SR"\ndescription = "a"\n\n[[agent.menu]]\ncode = "SR"\ndescription = "b"\n');
  result = await validate();
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /menu has duplicate codes: SR/);
});

test("personal customize layer uses the .user.toml suffix declared by the README", async (t) => {
  const root = await createTruthFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, "customize/personal"), { recursive: true });

  const validate = async () => {
    const truth = await validateRepositoryTruth(root);
    return truth.find((result) => result.id === "registry.customize");
  };

  // README:8,56 + personal/.gitignore 的 `*.user.toml` 都规定 personal 层是 `.user.toml`。
  // 初版一律拼 `${code}.toml`，导致 personal 层**永不校验**——而它正是最没人 review 的
  // 本地层（烛 R1 实测：照 README 写的违规 override 可完整绕过三条判据）。
  await writeFile(resolve(root, "customize/personal/codex-reviewer.user.toml"), '[agent]\nname = "绕过尝试"\n');
  let result = await validate();
  assert.equal(result.valid, false, "a violating override in customize/personal/*.user.toml must be caught");
  assert.match(result.errors.join("\n"), /customize\/personal\/codex-reviewer\.user\.toml overrides read-only agent\.name/);

  // 反向：`${code}.toml`（缺 .user 后缀）不是 README 声明的路径，不应被当作 personal 层读取。
  await rm(resolve(root, "customize/personal/codex-reviewer.user.toml"));
  await writeFile(resolve(root, "customize/personal/codex-reviewer.toml"), '[agent]\nname = "不该被当 personal 层"\n');
  result = await validate();
  assert.equal(result.valid, true, "`${code}.toml` is not the declared personal-layer path and must not be read as one");
});

test("model wiring ignores comment decoys and reads only the pure manifest", async (t) => {
  const root = await createTruthFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const modelsPath = resolve(root, "config/control-center/models.json");
  const manifestPath = resolve(root, "apps/control-center/src/adapters/manifest.mjs");
  const indexPath = resolve(root, "apps/control-center/src/adapters/index.mjs");
  const models = JSON.parse(await readFile(modelsPath, "utf8"));
  models.profiles.push({ id: "comment-only-profile", adapter: "foo-alpha" });
  await writeFile(modelsPath, JSON.stringify(models));
  const manifestText = await readFile(manifestPath, "utf8");
  await writeFile(
    manifestPath,
    `${manifestText}// { profileId: "comment-only-profile", adapterId: "foo-alpha", factoryKey: "foo" }\n`,
  );
  await writeFile(indexPath, `throw new Error("validator imported production adapter index");\n${await readFile(indexPath, "utf8")}`);

  const truth = await validateRepositoryTruth(root);
  const modelResult = truth.find((result) => result.id === "registry.models");
  assert.equal(modelResult.valid, false);
  assert.match(modelResult.errors.join("\n"), /comment-only-profile.*no fixed adapter binding/);
});

test("adapter index import discovery ignores comment and template decoys", async (t) => {
  const root = await createTruthFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const indexPath = resolve(root, "apps/control-center/src/adapters/index.mjs");
  await writeFile(
    indexPath,
    [
      '// import { Foo } from "./foo.mjs";',
      '/* import { Foo } from "./foo.mjs"; */',
      'const decoy = `import { Foo } from "./foo.mjs";`;',
      'import { ADAPTER_BINDINGS } from "./manifest.mjs";',
      "export function createAdapters() {",
      "  return new Map(ADAPTER_BINDINGS.map((binding) => [binding.profileId, new Foo()]));",
      "}",
      "",
    ].join("\n"),
  );

  const truth = await validateRepositoryTruth(root);
  const adapterResult = truth.find((result) => result.id === "registry.adapters");
  assert.equal(adapterResult.valid, false);
  assert.match(adapterResult.errors.join("\n"), /adapter index imports is missing disk entries: foo/);
});

test("adapter manifest rejects duplicate ids, adapter mismatches, and ghost bindings", async (t) => {
  const root = await createTruthFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = resolve(root, "apps/control-center/src/adapters/manifest.mjs");

  await writeFile(manifestPath, fixtureAdapterManifest([
    ...FIXTURE_ADAPTER_BINDINGS,
    { profileId: "alpha-profile", adapterId: "foo-shadow", factoryKey: "foo" },
  ]));
  let truth = await validateRepositoryTruth(root);
  let modelResult = truth.find((result) => result.id === "registry.models");
  assert.equal(modelResult.valid, false);
  assert.match(modelResult.errors.join("\n"), /manifest profile ids are duplicated.*alpha-profile/);

  await writeFile(manifestPath, fixtureAdapterManifest(FIXTURE_ADAPTER_BINDINGS.map((binding) => (
    binding.profileId === "kimi-frontend" ? { ...binding, adapterId: "wrong-kimi-adapter" } : binding
  ))));
  truth = await validateRepositoryTruth(root);
  modelResult = truth.find((result) => result.id === "registry.models");
  assert.equal(modelResult.valid, false);
  assert.match(modelResult.errors.join("\n"), /kimi-frontend declares adapter kimi-headless-resume, expected wrong-kimi-adapter/);

  await writeFile(manifestPath, fixtureAdapterManifest([
    ...FIXTURE_ADAPTER_BINDINGS,
    { profileId: "ghost-profile", adapterId: "foo-shadow", factoryKey: "foo" },
  ]));
  truth = await validateRepositoryTruth(root);
  modelResult = truth.find((result) => result.id === "registry.models");
  assert.equal(modelResult.valid, false);
  assert.match(modelResult.errors.join("\n"), /manifest binding without model profile: ghost-profile/);
});

test("version truth ignores section-external and HTML-comment decoys", async (t) => {
  const root = await createTruthFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(
    resolve(root, "rules.md"),
    [
      "# 514cc fixture v3.5",
      "- **v3.5.0** section-external decoy",
      "## 四、外部 CLI（fixture）",
      "**Kimi Code CLI**：`kimi` 0.28.0 --plan read-only; workspace-write fail-closed.",
      "## 八、版本",
      "- **v3.4.3** actual release",
      "",
    ].join("\n"),
  );
  let truth = await validateRepositoryTruth(root);
  let versionResult = truth.find((result) => result.id === "framework.version");
  assert.equal(versionResult.valid, false);
  assert.match(versionResult.errors.join("\n"), /module\.yaml declares 3\.5\.0, expected 3\.4\.3/);

  await writeFile(
    resolve(root, "rules.md"),
    [
      "# 514cc fixture v3.5",
      "## 四、外部 CLI（fixture）",
      "**Kimi Code CLI**：`kimi` 0.28.0 --plan read-only; workspace-write fail-closed.",
      "## 八、版本",
      "- **v3.5.0** actual release",
      "",
    ].join("\n"),
  );
  await writeFile(
    resolve(root, "CHANGELOG.md"),
    "<!-- ## 2099-01-01 - v3.5.0 decoy -->\n## 2026-07-16 - v3.4.3 actual\n",
  );
  truth = await validateRepositoryTruth(root);
  versionResult = truth.find((result) => result.id === "framework.version");
  assert.equal(versionResult.valid, false);
  assert.match(versionResult.errors.join("\n"), /CHANGELOG\.md latest release declares 3\.4\.3, expected 3\.5\.0/);
});

test("version truth fails closed on duplicate visible sections and version lines", async (t) => {
  const root = await createTruthFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(
    resolve(root, "rules.md"),
    `${await readFile(resolve(root, "rules.md"), "utf8")}\n## 八、版本\n- **v3.5.0** duplicate\n`,
  );
  await writeFile(
    resolve(root, "AGENTS.md"),
    "## 项目概览\n\n- **版本**：v3.5.0\n- **版本**：v3.4.3\n\n`__DELTA__: 烛(Codex) | 1 | evidence`\n",
  );
  await writeFile(
    resolve(root, "CLAUDE.md"),
    "## 项目概览\n\n- **当前版本**：**v3.5.0**\n\n## 项目概览\n\n- **当前版本**：**v3.4.3**\n",
  );
  await writeFile(
    resolve(root, "README.md"),
    "# fixture\n\nv3.5.0 | current\nv3.4.3 | duplicate visible version line\n",
  );
  await writeFile(
    resolve(root, "CHANGELOG.md"),
    "## 2026-07-17 - v3.5.0 fixture\n## 2026-07-16 - v3.5.0 duplicate\n",
  );

  const truth = await validateRepositoryTruth(root);
  const errors = truth.find((result) => result.id === "framework.version").errors.join("\n");
  assert.match(errors, /rules\.md must contain exactly one visible section 8 version heading, found 2/);
  assert.match(errors, /AGENTS\.md project overview must contain exactly one target version line, found 2/);
  assert.match(errors, /CLAUDE\.md must contain exactly one visible project overview section, found 2/);
  assert.match(errors, /README\.md must contain exactly one formal version line before the first H2, found 2/);
  assert.match(errors, /CHANGELOG\.md has duplicate release headings: 3\.5\.0/);
});

test("handoff governance rejects missing Kimi coverage, hook drift, and legacy templates", async (t) => {
  const root = await createTruthFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryPath = resolve(root, ".claude/hooks/handoff-sources.json");
  const codexHookPath = resolve(root, ".codex/hooks/stop-gate-codex.py");
  const templatePath = resolve(root, ".agents/skills/co-review/SKILL.md");

  await writeFile(registryPath, fixtureHandoffRegistry({ includeKimi: false }));
  let truth = await validateRepositoryTruth(root);
  let governance = truth.find((result) => result.id === "governance.handoff");
  assert.equal(governance.valid, false);
  assert.match(governance.errors.join("\n"), /missing required prefix: kimi-to-|missing disk entries: kimi-to-/);

  await writeFile(registryPath, fixtureHandoffRegistry());
  await writeFile(codexHookPath, fixtureDeltaHook({ lax: true }));
  truth = await validateRepositoryTruth(root);
  governance = truth.find((result) => result.id === "governance.handoff");
  assert.equal(governance.valid, false);
  assert.match(governance.errors.join("\n"), /Codex hook DELTA grammar|codex hook DELTA grammar|different DELTA grammars/);

  await writeFile(codexHookPath, fixtureDeltaHook());
  await writeFile(
    templatePath,
    "<!-- __DELTA__: decoy | 1 | evidence -->\n`__DELTA__: 烛(Codex) | 1补强 | evidence`\n",
  );
  truth = await validateRepositoryTruth(root);
  governance = truth.find((result) => result.id === "governance.handoff");
  assert.equal(governance.valid, false);
  assert.match(governance.errors.join("\n"), /non-copyable DELTA template|missing a copyable/);

  await writeFile(templatePath, "`__DELTA__: 烛(Codex) | 1 | evidence`\n");
  await writeFile(codexHookPath, fixtureDeltaHook({ includeMain: false }));
  truth = await validateRepositoryTruth(root);
  governance = truth.find((result) => result.id === "governance.handoff");
  assert.equal(governance.valid, false);
  assert.match(governance.errors.join("\n"), /codex hook lacks main/i);

  await writeFile(codexHookPath, fixtureDeltaHook({ allowAllMain: true }));
  truth = await validateRepositoryTruth(root);
  governance = truth.find((result) => result.id === "governance.handoff");
  assert.equal(governance.valid, false);
  assert.match(governance.errors.join("\n"), /codex hook main does not enforce.*session contract/i);
});

test("Codex hook registry rejects event drift between module and hooks.json", async (t) => {
  const root = await createTruthFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(resolve(root, ".codex/hooks.json"), fixtureCodexHooks(root, { routeEvent: "PreToolUse" }));
  const truth = await validateRepositoryTruth(root);
  const hooks = truth.find((result) => result.id === "governance.hooks");
  assert.equal(hooks.valid, false);
  assert.match(hooks.errors.join("\n"), /UserPromptSubmit.*route-gate-codex\.py|PreToolUse.*route-gate-codex\.py/);
});
