import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeSeatManager, runtimeSeatProviderModelFacts } from "../public/modules/runtime-seat-manager.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("seat model catalog merges the selected connection default, role mappings and catalog labels", () => {
  const facts = runtimeSeatProviderModelFacts({
    id: "provider-a",
    name: "主连接",
    models: {
      claude: {
        model: "model-default",
        sonnetModel: "model-sonnet",
        sonnetModelName: "Sonnet 显示名",
      },
    },
    meta: {
      modelCatalog: [
        { model: "model-catalog", displayName: "目录模型" },
        { model: "model-default", displayName: "默认模型" },
      ],
    },
  }, { providerApp: "claude" });

  assert.equal(facts.defaultModel, "model-default");
  assert.deepEqual(facts.options, [
    { id: "model-catalog", label: "目录模型" },
    { id: "model-default", label: "默认模型" },
    { id: "model-sonnet", label: "model-sonnet" },
  ]);
  assert.equal(facts.options.some((option) => option.id === "Sonnet 显示名"), false);
});

test("concurrent runtime-seat loads await one shared snapshot instead of returning early", async (t) => {
  const previousDocument = globalThis.document;
  const elements = new Map([
    ["runtime-seat-editor-empty", { hidden: true }],
    ["runtime-seat-form", { hidden: false }],
  ]);
  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
  };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });

  const templateRequest = deferred();
  const seatRequest = deferred();
  const requests = [];
  const state = {
    adapterTemplatesData: null,
    runtimeSeatsData: null,
    runtimeSeatsLoading: false,
    selectedRuntimeSeatId: null,
    configRuntimeFocusId: null,
  };
  const manager = createRuntimeSeatManager({
    state,
    api: { adapterTemplates: "/api/adapter-templates", runtimeSeats: "/api/runtime-seats" },
    request: (path) => {
      requests.push(path);
      return path === "/api/adapter-templates" ? templateRequest.promise : seatRequest.promise;
    },
    escapeHtml: String,
    toast: () => {},
    confirmAction: async () => true,
  });

  const first = manager.load({ fresh: true });
  const concurrent = manager.load();
  templateRequest.resolve({ templates: [] });
  seatRequest.resolve({ seats: [], runtimeProfiles: [] });

  assert.deepEqual(await Promise.all([first, concurrent]), [true, true]);
  assert.deepEqual(requests.sort(), ["/api/adapter-templates", "/api/runtime-seats"]);
  assert.equal(state.runtimeSeatsLoading, false);
  assert.deepEqual(state.adapterTemplatesData.templates, []);
  assert.deepEqual(state.runtimeSeatsData.seats, []);
});

test("failed fresh runtime-seat load invalidates the previous snapshot and remains retryable", async (t) => {
  const previousDocument = globalThis.document;
  const elements = new Map([
    ["runtime-seat-editor-empty", { hidden: true }],
    ["runtime-seat-form", { hidden: false }],
  ]);
  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
  };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });

  const state = {
    adapterTemplatesData: { templates: [] },
    runtimeSeatsData: { seats: [{ id: "stale-seat", enabled: true }], runtimeProfiles: [{ id: "stale-seat" }] },
    runtimeSeatsLoading: false,
    selectedRuntimeSeatId: null,
    configRuntimeFocusId: null,
  };
  let unavailable = true;
  const loadStates = [];
  const manager = createRuntimeSeatManager({
    state,
    api: { adapterTemplates: "/api/adapter-templates", runtimeSeats: "/api/runtime-seats" },
    request: async (path) => {
      if (path === "/api/adapter-templates") return { templates: [] };
      if (unavailable) throw new Error("runtime seats unavailable");
      return { seats: [], runtimeProfiles: [] };
    },
    escapeHtml: String,
    toast: () => {},
    confirmAction: async () => true,
    onLoadStateChanged: () => loadStates.push(state.runtimeSeatsLoading),
  });

  assert.equal(await manager.load({ fresh: true }), false);
  assert.deepEqual(state.runtimeSeatsData.seats, []);
  assert.equal(state.runtimeSeatsData.error, "runtime seats unavailable");
  assert.equal(loadStates[0], true);
  assert.equal(loadStates.at(-1), false);

  unavailable = false;
  assert.equal(await manager.load(), true, "error snapshots must not satisfy the non-fresh cache");
  assert.deepEqual(state.runtimeSeatsData.seats, []);
  assert.equal(state.runtimeSeatsData.error, undefined);
});

test("claude-fable prioritizes fableModel from provider and falls back to default model", () => {
  const providerWithFable = {
    id: "provider-claude-test",
    name: "Claude Provider",
    models: {
      claude: {
        model: "claude-3-7-sonnet-20250219",
        fableModel: "claude-opus-5",
        sonnetModel: "claude-3-7-sonnet",
      },
    },
    meta: {
      modelCatalog: [
        { model: "claude-opus-5", displayName: "Claude Opus 5 (Fable)" },
      ],
    },
  };

  const factsFable = runtimeSeatProviderModelFacts(providerWithFable, { providerApp: "claude" }, { id: "claude-fable", role: "primary-coordinator" });
  assert.equal(factsFable.defaultModel, "claude-opus-5");
  assert.equal(factsFable.options.some((opt) => opt.id === "claude-opus-5"), true);

  const providerWithoutFable = {
    id: "provider-claude-fallback",
    name: "Claude Provider Fallback",
    models: {
      claude: {
        model: "claude-3-5-haiku-20241022",
      },
    },
  };

  const factsFallback = runtimeSeatProviderModelFacts(providerWithoutFable, { providerApp: "claude" }, { id: "claude-fable" });
  assert.equal(factsFallback.defaultModel, "claude-3-5-haiku-20241022");

  const factsOther = runtimeSeatProviderModelFacts(providerWithFable, { providerApp: "claude" }, { id: "other-seat", role: "developer" });
  assert.equal(factsOther.defaultModel, "claude-3-7-sonnet-20250219");
});

test("runtimeSeatProviderModelFacts handles synthesized live provider with models and fableModel", () => {
  const liveProvider = {
    id: "live-claude",
    name: "当前活跃连接（api.stepfun.com）",
    baseUrl: "https://api.stepfun.com/step_plan",
    models: {
      claude: {
        model: "step-5-preview",
        fableModel: "step-5-preview[1M]",
      },
    },
    meta: {
      modelCatalog: [
        { id: "step-5-preview", model: "step-5-preview", label: "step-5-preview" },
        { id: "step-3.7-flash", model: "step-3.7-flash", label: "step-3.7-flash" },
      ],
    },
  };
  const facts = runtimeSeatProviderModelFacts(liveProvider, { providerApp: "claude" }, { id: "claude-fable" });
  assert.equal(facts.defaultModel, "step-5-preview[1M]");
  assert.ok(facts.options.some((opt) => opt.id === "step-5-preview"));
  assert.ok(facts.options.some((opt) => opt.id === "step-3.7-flash"));
});

test("runtimeSeatManager falls back to live provider and discovered models when following current connection", () => {
  const state = {
    providersData: {
      current: {},
      live: {
        claude: {
          baseUrl: "https://api.stepfun.com/step_plan",
          model: "step-5-preview",
          fableModel: "step-5-preview[1M]",
          models: ["step-5-preview", "step-3.7-flash"],
        },
      },
    },
    runtimeSeatsData: {
      seats: [{ id: "claude-fable", providerId: "", adapter: "claude-stream-json" }],
      runtimeProfiles: [],
      providerCurrent: {},
    },
    adapterTemplatesData: {
      templates: [{ id: "claude-stream-json", providerApp: "claude" }],
    },
    discoveredAgentModels: {
      "claude-fable": {
        models: [
          { id: "step-5-preview", label: "Step-5 Preview (Discovered)" },
          { id: "step-reasoning-preview", label: "Step Reasoning Preview" },
        ],
      },
    },
  };

  const manager = createRuntimeSeatManager({
    state,
    api: { adapterTemplates: "/api/adapter-templates", runtimeSeats: "/api/runtime-seats" },
    request: async () => ({}),
    escapeHtml: String,
    toast: () => {},
    confirmAction: async () => true,
  });

  const template = { id: "claude-stream-json", providerApp: "claude" };
  const seat = { id: "claude-fable", providerId: "" };

  const facts = manager.providerModelFacts(template, "", seat);
  assert.equal(facts.isFollowGlobal, true);
  assert.equal(facts.defaultModel, "step-5-preview[1M]");

  const options = manager.modelOptionsFor(template, seat, "");
  assert.ok(options.some((opt) => opt.id === "step-5-preview"));
  assert.ok(options.some((opt) => opt.id === "step-reasoning-preview"));
});


