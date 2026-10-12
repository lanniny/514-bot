import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelDiscovery } from "../src/model-discovery.mjs";
import { ProviderStore } from "../src/providers.mjs";
import { EventStore } from "../src/event-store.mjs";

test("ModelDiscovery discovers models from upstream provider when CLI discovery is unavailable", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "514-md-upstream-"));
  try {
    const eventStore = await new EventStore(join(tmp, "events.jsonl")).init();
    const providerStore = await new ProviderStore({ dataRoot: tmp, runtimeHome: tmp, eventStore }).init();

    await providerStore.create({
      name: "514 Upstream Proxy",
      baseUrl: "https://514claude.xyz",
      apiKey: "sk-upstream-test-key",
      apps: { claude: true },
    });

    let fetchCalls = 0;
    const mockFetchModels = async ({ baseUrl, apiKey }) => {
      fetchCalls += 1;
      assert.equal(baseUrl, "https://514claude.xyz");
      assert.equal(apiKey, "sk-upstream-test-key");
      return {
        models: [
          { id: "claude-3-7-sonnet-20250219", ownedBy: "anthropic" },
          { id: "claude-opus-5", ownedBy: "anthropic" },
          { id: "deepseek-v4-pro", ownedBy: "deepseek" },
        ],
      };
    };

    const discovery = new ModelDiscovery({
      profiles: [
        {
          id: "claude-fable",
          adapter: "claude-stream-json",
          command: "claude",
          model: "claude-opus-5",
          modelOptions: [{ id: "static-fallback", label: "Static Fallback" }],
          effortLevels: ["low", "medium", "high", "max"],
        },
      ],
      providerStore,
      fetchProviderModelsImpl: mockFetchModels,
      runProcessImpl: async () => ({ code: 1, stdout: "", stderr: "command not found" }),
    });

    const catalog = await discovery.forAgent("claude-fable");
    assert.equal(fetchCalls, 1);
    assert.equal(catalog.source, "upstream-provider");
    assert.equal(catalog.modelSource, "upstream-provider");
    assert.equal(catalog.providerName, "514 Upstream Proxy");
    assert.equal(catalog.models.length, 3);
    assert.equal(catalog.models[0].id, "claude-3-7-sonnet-20250219");
    assert.equal(catalog.models[1].id, "claude-opus-5");
    assert.equal(catalog.models[2].id, "deepseek-v4-pro");

    // Cache hit: subsequent call within TTL does not refetch
    const cached = await discovery.forAgent("claude-fable");
    assert.equal(fetchCalls, 1);
    assert.equal(cached.models.length, 3);

    // Invalidation clears cache and refetches
    discovery.invalidate("claude-fable");
    const refetched = await discovery.forAgent("claude-fable");
    assert.equal(fetchCalls, 2);
    assert.equal(refetched.models.length, 3);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ModelDiscovery prefers bound providerId when configured", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "514-md-bound-"));
  try {
    const eventStore = await new EventStore(join(tmp, "events.jsonl")).init();
    const providerStore = await new ProviderStore({ dataRoot: tmp, eventStore }).init();

    const p1 = await providerStore.create({
      name: "Bound Custom Provider",
      baseUrl: "https://bound.custom.api",
      apiKey: "sk-bound-key",
      apps: { codex: true },
    });

    let calledBaseUrl = null;
    const mockFetchModels = async ({ baseUrl }) => {
      calledBaseUrl = baseUrl;
      return {
        models: [{ id: "gpt-5.6-sol", ownedBy: "openai" }],
      };
    };

    const discovery = new ModelDiscovery({
      profiles: [
        {
          id: "codex-custom",
          adapter: "codex-app-server",
          command: "codex",
          builtin: false,
          providerId: p1.id,
          modelOptions: [],
        },
      ],
      providerStore,
      fetchProviderModelsImpl: mockFetchModels,
      runProcessImpl: async () => ({ code: 0, stdout: JSON.stringify({ models: [{ slug: "local-cli-model", visibility: "list" }] }) }),
    });

    const catalog = await discovery.forAgent("codex-custom");
    assert.equal(calledBaseUrl, "https://bound.custom.api");
    assert.equal(catalog.models[0].id, "gpt-5.6-sol");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ModelDiscovery discovers upstream models for claude-fable via active claude provider without explicit providerId", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "514-md-claude-"));
  try {
    const eventStore = await new EventStore(join(tmp, "events.jsonl")).init();
    const providerStore = await new ProviderStore({ dataRoot: tmp, runtimeHome: tmp, eventStore }).init();

    await providerStore.create({
      name: "514 Claude Proxy",
      baseUrl: "https://514claude.xyz",
      apiKey: "sk-test-proxy",
      apps: { claude: true },
    });

    let fetchCalled = false;
    const mockFetchModels = async ({ baseUrl, apiKey }) => {
      fetchCalled = true;
      assert.equal(baseUrl, "https://514claude.xyz");
      assert.equal(apiKey, "sk-test-proxy");
      return {
        models: [
          { id: "deepseek-v3.2", ownedBy: "openai" },
          { id: "deepseek-v4-pro", ownedBy: "openai" },
        ],
      };
    };

    const discovery = new ModelDiscovery({
      profiles: [
        {
          id: "claude-fable",
          adapter: "claude-stream-json",
          command: "claude",
          model: "claude-opus-5",
          modelOptions: [{ id: "fallback-model", label: "Fallback Model" }],
          effortLevels: ["low", "max"],
        },
      ],
      providerStore,
      fetchProviderModelsImpl: mockFetchModels,
      runProcessImpl: async () => {
        throw new Error("CLI should not be called when provider is active");
      },
    });

    const catalog = await discovery.forAgent("claude-fable");
    assert.equal(fetchCalled, true);
    assert.equal(catalog.source, "upstream-provider");
    assert.equal(catalog.providerName, "514 Claude Proxy");
    assert.equal(catalog.models.length, 2);
    assert.equal(catalog.models[0].id, "deepseek-v3.2");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("UI contract: index.html contains bot model refresh button and status badge", () => {
  const html = readFileSync(join(import.meta.dirname, "../public/index.html"), "utf8");
  assert.match(html, /id="bot-refresh-models-btn"/);
  assert.match(html, /id="bot-model-status"/);
  assert.match(html, /id="bot-effort-status"/);
  assert.match(html, /id="bot-next-model"/);
  assert.match(html, /id="bot-next-effort"/);
});

test("UI style contract: CSS contains spin animation and refresh button styling", () => {
  const css = readFileSync(join(import.meta.dirname, "../public/forge/bot-grok-face.css"), "utf8");
  assert.match(css, /\.bot-refresh-models-btn/);
  assert.match(css, /@keyframes bot-refresh-spin/);
  assert.match(css, /\.bot-model-status/);
  assert.match(css, /\.bot-effort-status/);
});

test("UI logic contract: app.js contains dynamic upstream model discovery and refresh handlers", () => {
  const appJs = readFileSync(join(import.meta.dirname, "../public/app.js"), "utf8");
  assert.match(appJs, /function renderBotComposerModelOptions\(/);
  assert.match(appJs, /function renderBotComposerEffortOptions\(/);
  assert.match(appJs, /async function syncBotComposerDynamicModels\(/);
  assert.match(appJs, /byId\("bot-refresh-models-btn"\)\?\.addEventListener\("click"/);
  assert.match(appJs, /\/api\/agents\/models\?agent=/);
  assert.match(appJs, /上游 ·/);
});

test("ModelDiscovery parses multi-model Codex catalog with union of effort levels and per-model effort", async () => {
  const { parseCodexCatalog } = await import("../src/model-discovery.mjs");
  const raw = JSON.stringify({
    models: [
      { slug: "model-a", display_name: "Model A", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }] },
      { slug: "model-b", display_name: "Model B", visibility: "list", supported_reasoning_levels: [{ effort: "high" }, { effort: "ultra" }] },
    ]
  });
  const catalog = parseCodexCatalog(raw);
  assert.deepEqual(catalog.effortLevels.sort(), ["high", "low", "medium", "ultra"].sort());
  assert.deepEqual(catalog.models[0].effortLevels, ["low", "medium"]);
  assert.deepEqual(catalog.models[1].effortLevels, ["high", "ultra"]);
});

test("ModelDiscovery parses Claude catalog with ultracode and native effort levels", async () => {
  const { parseClaudeCatalog } = await import("../src/model-discovery.mjs");
  const catalog = parseClaudeCatalog("claude-opus-5\nclaude-sonnet-5\n");
  assert.ok(catalog.effortLevels.includes("ultracode"));
  assert.deepEqual(catalog.effortLevels, ["low", "medium", "high", "xhigh", "max", "ultracode"]);
});

test("ModelDiscovery prioritizes live Claude settings.json connection over database fallback", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const tmp = await mkdtemp(join(tmpdir(), "514-md-live-priority-"));
  try {
    const eventStore = await new EventStore(join(tmp, "events.jsonl")).init();
    const providerStore = await new ProviderStore({ dataRoot: tmp, runtimeHome: tmp, eventStore }).init();

    // Create a database provider that would have been mistakenly picked previously
    await providerStore.create({
      name: "Unrelated Database Proxy",
      baseUrl: "https://514claude.xyz",
      apiKey: "sk-unrelated-key",
      apps: { claude: true },
    });

    // Write real live settings into tmp/.claude/settings.json
    await mkdir(join(tmp, ".claude"), { recursive: true });
    await writeFile(join(tmp, ".claude", "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://api.stepfun.com/step_plan",
        ANTHROPIC_AUTH_TOKEN: "sk-stepfun-live-key",
        ANTHROPIC_DEFAULT_FABLE_MODEL: "step-5-preview[1M]",
      },
    }), "utf8");

    let calledBaseUrl = null;
    const mockFetchModels = async ({ baseUrl, apiKey }) => {
      calledBaseUrl = baseUrl;
      assert.equal(baseUrl, "https://api.stepfun.com/step_plan");
      assert.equal(apiKey, "sk-stepfun-live-key");
      return {
        models: [
          { id: "step-5-preview", ownedBy: "stepai" },
          { id: "step-3.7-flash", ownedBy: "stepai" },
        ],
      };
    };

    const discovery = new ModelDiscovery({
      profiles: [
        {
          id: "claude-fable",
          adapter: "claude-stream-json",
          command: "claude",
          modelOptions: [],
        },
      ],
      providerStore,
      fetchProviderModelsImpl: mockFetchModels,
      runProcessImpl: async () => ({ code: 1, stdout: "", stderr: "" }),
    });

    const catalog = await discovery.forAgent("claude-fable");
    assert.equal(calledBaseUrl, "https://api.stepfun.com/step_plan");
    assert.equal(catalog.source, "upstream-provider");
    assert.ok(catalog.providerName.includes("api.stepfun.com"));
    assert.equal(catalog.models.length, 2);
    assert.equal(catalog.models[0].id, "step-5-preview");
    assert.equal(catalog.models[1].id, "step-3.7-flash");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});


