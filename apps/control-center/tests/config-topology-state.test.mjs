import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
// UI-AUDIT P0-6：app.js 里被本测试 eval 的段落现在会调用占位组件（骨架屏/空态），
// evaluateSection 用 new Function 求值，不会继承模块 import，必须显式注入。
import { skeleton } from "../public/modules/placeholders.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
// 归一化行尾：Windows 工作区 checkout 后 app.js 是 CRLF，而 sourceSection 的 marker 用 LF；
// 不归一化会让含换行的 end marker（如 beforeunload 那处）在 CRLF 工作区永远匹配不到。
const appSource = (await readFile(`${appRoot}/public/app.js`, "utf8")).replace(/\r\n/g, "\n");

function sourceSection(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return appSource.slice(start, end);
}

function evaluateSection(source, exportedNames, dependencies = {}) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  const factory = new Function(...names, `${source}\nreturn { ${exportedNames.join(", ")} };`);
  return factory(...values);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function bounded(promise, label, timeoutMs = 2_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${label} timed out`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    value: (key) => values.get(key),
  };
}

function fakeSyncDialogDocument({ fileId = "codex-config" } = {}) {
  const node = (dataset = {}) => {
    const listeners = new Map();
    return {
      dataset,
      disabled: false,
      isConnected: true,
      textContent: "",
      addEventListener(type, listener) {
        const current = listeners.get(type) ?? [];
        current.push(listener);
        listeners.set(type, current);
      },
      async dispatch(type = "click") {
        for (const listener of listeners.get(type) ?? []) await listener({ target: this });
      },
    };
  };
  const push = node({ act: "push" });
  const cancel = node({ act: "cancel" });
  const message = node();
  const body = node();
  const checkbox = node({ syncFile: fileId });
  checkbox.checked = true;
  const closeListeners = [];
  const dialog = {
    className: "",
    innerHTML: "",
    open: false,
    removed: false,
    addEventListener(type, listener) {
      if (type === "close") closeListeners.push(listener);
    },
    querySelector(selector) {
      if (selector === '[data-act="push"]') return push;
      if (selector === '[data-act="cancel"]') return cancel;
      if (selector === "[data-sync-msg]") return message;
      if (selector === ".dialog-body") return body;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-act="cancel"]') return [cancel];
      if (selector === "[data-sync-file]:checked") return checkbox.checked ? [checkbox] : [];
      return [];
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      for (const listener of closeListeners) listener();
    },
    remove() {
      this.removed = true;
      push.isConnected = false;
      cancel.isConnected = false;
    },
  };
  const document = {
    body: {
      appended: null,
      appendChild(value) {
        this.appended = value;
      },
    },
    createElement(tag) {
      assert.equal(tag, "dialog");
      return dialog;
    },
  };
  return { document, dialog, push, cancel, message, checkbox };
}

function recoveryHarness(state, {
  localStorage = memoryStorage(),
  currentTargetKey = () => "local",
  request = async () => ({ recoveries: [] }),
  renderConfigRemotePanel = noop,
} = {}) {
  state.configRemoteRecoveryLoaded ??= true;
  state.configRemoteRecoveryLoadError ??= null;
  return evaluateSection(
    `${sourceSection("const CONFIG_REMOTE_RECOVERY_STORAGE_KEY", "function configRemoteGraphEndpoint")}\n${sourceSection("function configRemoteRecoveryEvidence", "/* ===== \u8fdc\u7a0b\u4e09\u9762\u56fe\u8c31")}`,
    [
      "configRemoteTargetSnapshotForKey",
      "configRemoteRecoveryKey",
      "configRemoteRecoveryEntriesForTarget",
      "configRemoteRecoveryEntryForTarget",
      "configRemoteRecoveryForTarget",
      "clearConfigRemoteRecovery",
      "persistConfigRemoteRecoveries",
      "restoreConfigRemoteRecoveries",
      "loadConfigRemoteRecoveries",
      "configRemoteRecoveryEvidence",
      "configRemotePendingRecoveryEvidence",
      "rememberConfigRemoteRecovery",
      "configRemoteWriteBlocked",
    ],
    {
      state,
      localStorage,
      configRemoteTargetKey: currentTargetKey,
      request,
      renderConfigRemotePanel,
      toast: noop,
      console: { warn: noop },
    },
  );
}

function recoveryRecord(kind, transactionId, {
  targetKey = "project:p1",
  hostId = "h1",
  projectId = "p1",
  scope = projectId ? "project" : "host",
  message = `${kind} recovery`,
} = {}) {
  return {
    kind,
    transactionId,
    targetKey,
    hostId,
    projectId,
    scope,
    appliedCount: 0,
    uncertainCount: 1,
    causeCode: null,
    message,
    recordedAt: 1,
  };
}

function configSyncDialogHarness({
  document,
  targetSnapshot,
  project = () => null,
  writeBlocked = () => false,
  request,
  confirmAction = async () => true,
  rememberRecovery = () => null,
  loadRecoveries = async () => {},
  result = noop,
  toast = noop,
}) {
  return evaluateSection(
    sourceSection("async function openConfigSyncDialog", "const observabilityPage"),
    ["openConfigSyncDialog"],
    {
      document,
      configRemoteProviderTargetSnapshot: targetSnapshot,
      configRemoteProject: project,
      configRemoteWriteBlocked: writeBlocked,
      request,
      confirmAction,
      rememberConfigRemoteRecovery: rememberRecovery,
      loadConfigRemoteRecoveries: loadRecoveries,
      configRemoteResult: result,
      escapeHtml: (value) => String(value),
      skeleton,
      toast,
    },
  ).openConfigSyncDialog;
}

const successfulLoadResult = (data = null, details = {}) => ({ __forgeLoadResult: true, ok: true, data, ...details });
const failedLoadResult = (error) => ({ __forgeLoadResult: true, ok: false, error });
const loadResultFailed = (value) => value?.__forgeLoadResult === true && value.ok === false;
const noop = () => {};

test("config hash routes preserve member targets with deterministic provider defaults", () => {
  const routeSource = sourceSection("const CONFIG_SURFACES", "// API, TOKEN_KEY");
  const { configRouteHash, parseForgeRoute } = evaluateSection(routeSource, ["configRouteHash", "parseForgeRoute"], {
    location: { hash: "#workbench" },
    retireWorkbenchView: (view) => (view === "workbench" || view === "experience" ? "bot" : view),
  });

  // parseForgeRoute 现统一带 settingsFocus（observability/memory 路由用），期望对象补齐该键
  const emptyTarget = { memberId: null, runtimeProfileId: null, settingsFocus: null };
  assert.deepEqual(parseForgeRoute("#config"), { view: "config", configSurface: "sources", ...emptyTarget });
  assert.deepEqual(parseForgeRoute("#config/unknown"), { view: "config", configSurface: "sources", ...emptyTarget });
  assert.deepEqual(parseForgeRoute("#config/providers"), { view: "config", configSurface: "providers", ...emptyTarget });
  assert.deepEqual(parseForgeRoute("#config/local-runtime"), { view: "config", configSurface: "local-runtime", ...emptyTarget });
  assert.deepEqual(parseForgeRoute("#config/hooks"), { view: "config", configSurface: "hooks", ...emptyTarget });
  assert.deepEqual(parseForgeRoute("#config/sources"), { view: "config", configSurface: "sources", ...emptyTarget });
  assert.deepEqual(parseForgeRoute("#capabilities"), { view: "config", configSurface: "capabilities", ...emptyTarget });
  assert.deepEqual(parseForgeRoute("#workbench"), { view: "bot", configSurface: null, ...emptyTarget });
  assert.deepEqual(parseForgeRoute(""), { view: "bot", configSurface: null, ...emptyTarget });
  assert.deepEqual(parseForgeRoute("#"), { view: "bot", configSurface: null, ...emptyTarget });
  assert.deepEqual(parseForgeRoute("#experience?conversation=c&run=r"), { view: "bot", configSurface: null, ...emptyTarget });
  const hash = configRouteHash("capabilities", {
    memberId: "member-custom-1",
    runtimeProfileId: "codex-technical",
  });
  assert.equal(hash, "#config/capabilities?member=member-custom-1&runtime=codex-technical");
  assert.deepEqual(parseForgeRoute(hash), {
    view: "config",
    configSurface: "capabilities",
    memberId: "member-custom-1",
    runtimeProfileId: "codex-technical",
    settingsFocus: null,
  });
  assert.deepEqual(parseForgeRoute("#config/capabilities?member=%3Cscript%3E&runtime=codex-technical"), {
    view: "config",
    configSurface: "capabilities",
    memberId: null,
    runtimeProfileId: "codex-technical",
    settingsFocus: null,
  });
  assert.deepEqual(parseForgeRoute("#observability?focus=memory"), {
    view: "observability",
    configSurface: null,
    memberId: null,
    runtimeProfileId: null,
    settingsFocus: "memory",
  });
});

test("remote runtime mode and selected CLI stay isolated per host or project target", () => {
  const state = {
    configRemoteRuntimeModes: new Map(),
    configRemoteSelectedClis: new Map(),
  };
  let targetKey = "host:h1";
  const modeFunctions = evaluateSection(
    sourceSection("function configRemoteRuntimeMode", "function configRemoteCliGraphId"),
    ["configRemoteRuntimeMode", "setConfigRemoteRuntimeMode"],
    { state, configRemoteTargetKey: () => targetKey, renderConfigRemotePanel: noop },
  );
  const cliFunctions = evaluateSection(
    sourceSection("function configRemoteCliGraphId", "function configRemoteSourceList"),
    ["configRemoteSelectedCli", "setConfigRemoteSelectedCli"],
    { state, configRemoteTargetKey: () => targetKey, renderConfigRemotePanel: noop },
  );
  const host = { id: "h1" };
  state.configHostProbes = new Map([["h1", { data: { clis: [
    { id: "claude", installed: true },
    { id: "codex", installed: true },
  ] } }]]);
  const graph = { providers: [{ cli: "claude" }], sources: [] };

  modeFunctions.setConfigRemoteRuntimeMode("sources");
  cliFunctions.setConfigRemoteSelectedCli("codex");
  assert.equal(modeFunctions.configRemoteRuntimeMode(), "sources");
  assert.equal(cliFunctions.configRemoteSelectedCli(host, graph), "codex");

  targetKey = "project:p1";
  assert.equal(modeFunctions.configRemoteRuntimeMode(), "seats");
  assert.equal(cliFunctions.configRemoteSelectedCli(host, graph), "claude");
  modeFunctions.setConfigRemoteRuntimeMode("sources");
  cliFunctions.setConfigRemoteSelectedCli("claude");

  targetKey = "host:h1";
  assert.equal(modeFunctions.configRemoteRuntimeMode(), "sources");
  assert.equal(cliFunctions.configRemoteSelectedCli(host, graph), "codex");
});

test("remote metric helpers reject null as zero and history is bounded to real samples", async () => {
  const helpers = evaluateSection(
    sourceSection("function formatRemoteMetricBytes", "function configRemoteActionMarkup"),
    ["configRemoteMetricNumber", "configRemoteHealthLevel"],
    { state: { configRemoteMetricHistory: new Map() }, escapeHtml: String },
  );
  assert.equal(helpers.configRemoteMetricNumber(null), null);
  assert.equal(helpers.configRemoteMetricNumber(""), null);
  assert.equal(helpers.configRemoteMetricNumber("0"), 0);
  assert.deepEqual(helpers.configRemoteHealthLevel({}), { level: "unknown", label: "数据不足", value: null });

  const state = { configHostProbes: new Map(), configRemoteMetricHistory: new Map() };
  let sequence = 0;
  const { probeConfigHost } = evaluateSection(
    sourceSection("async function probeConfigHost", "/** 远程安装 CLI"),
    ["probeConfigHost"],
    {
      state,
      request: async () => ({ probe: { metrics: { cpu: { usagePercent: sequence++ } } } }),
      configRemoteMetricNumber: helpers.configRemoteMetricNumber,
      renderConfigTopology: noop,
      renderConfigRemotePanel: noop,
    },
  );
  for (let index = 0; index < 30; index += 1) await probeConfigHost("h1");
  const history = state.configRemoteMetricHistory.get("h1");
  assert.equal(history.length, 24);
  assert.equal(history[0].cpu, 6);
  assert.equal(history.at(-1).cpu, 29);
});

test("stale team loads and active drafts cannot hydrate the team form", () => {
  const { shouldHydrateTeamFormAfterLoad } = evaluateSection(
    sourceSection("function shouldHydrateTeamFormAfterLoad", "function parseForgeRoute"),
    ["shouldHydrateTeamFormAfterLoad"],
    { loadResultFailed },
  );
  const clean = { initialized: false, dirty: false, busy: false };

  assert.equal(shouldHydrateTeamFormAfterLoad(successfulLoadResult(), clean), true);
  assert.equal(shouldHydrateTeamFormAfterLoad(successfulLoadResult(null, { stale: true }), clean), false);
  assert.equal(shouldHydrateTeamFormAfterLoad(failedLoadResult(new Error("load failed")), clean), false);
  assert.equal(shouldHydrateTeamFormAfterLoad(successfulLoadResult(), { ...clean, initialized: true }), false);
  assert.equal(shouldHydrateTeamFormAfterLoad(successfulLoadResult(), { ...clean, dirty: true }), false);
  assert.equal(shouldHydrateTeamFormAfterLoad(successfulLoadResult(), { ...clean, busy: true }), false);
});

test("capability, team and provider loaders share their in-flight promise", async () => {
  const capabilityGate = deferred();
  let capabilityRequests = 0;
  const capabilityState = { capabilitiesLoading: false, capabilitiesData: null, capabilitiesError: null, teams: [] };
  const { loadCapabilities } = evaluateSection(
    sourceSection("let capabilitiesLoadPromise", "function capabilitySourceButton"),
    ["loadCapabilities"],
    {
      state: capabilityState,
      request: () => { capabilityRequests += 1; return capabilityGate.promise; },
      API: { capabilities: "/capabilities" },
      successfulLoadResult,
      failedLoadResult,
      renderCapabilities: noop,
      renderConfigTopology: noop,
      elements: {},
      checkedChipValues: noop,
      renderTeamChips: noop,
    },
  );
  const capabilityFirst = loadCapabilities();
  const capabilitySecond = loadCapabilities();
  assert.strictEqual(capabilityFirst, capabilitySecond);
  assert.equal(capabilityRequests, 1);
  capabilityGate.resolve({ skills: { items: [] }, mcp: { servers: [] } });
  assert.equal((await capabilityFirst).ok, true);
  assert.equal(capabilityState.capabilitiesLoading, false);

  const teamGate = deferred();
  let teamRequests = 0;
  const teamState = { teams: [], selectedTeamId: "team-514cc" };
  const { loadTeams } = evaluateSection(
    sourceSection("let teamsLoadPromise", "// ===== 团队层级树"),
    ["loadTeams"],
    {
      state: teamState,
      request: () => { teamRequests += 1; return teamGate.promise; },
      API: { teams: "/teams" },
      toast: noop,
      BUILTIN_TEAM_ID: "team-514cc",
      TEAM_KEY: "selected-team",
      localStorage: { setItem: noop },
      renderTeams: noop,
      refreshTeamData: noop,
      renderTeamActivation: noop,
      applyActiveTeamBackground: noop,
      missionControlDock: null,
      successfulLoadResult,
      failedLoadResult,
      elements: {},
      emptyMarkup: noop,
    },
  );
  const teamFirst = loadTeams();
  const teamSecond = loadTeams();
  assert.strictEqual(teamFirst, teamSecond);
  assert.equal(teamRequests, 1);
  teamGate.resolve({ teams: [{ id: "team-514cc" }] });
  assert.equal((await teamFirst).ok, true);

  const providerGate = deferred();
  let providerRequests = 0;
  const providerState = { providersLoading: false, providersData: null, teams: [] };
  const { loadProviders } = evaluateSection(
    sourceSection("let providersLoadPromise", "// cc-switch autoQueryInterval"),
    ["loadProviders"],
    {
      state: providerState,
      request: () => { providerRequests += 1; return providerGate.promise; },
      API: { providers: "/providers" },
      successfulLoadResult,
      failedLoadResult,
      renderProviders: noop,
      renderConfigTopology: noop,
      reconcileUsageAutoQuery: noop,
      reconcileProviderLivePoll: noop,
      elements: {},
      populateTeamProviderSelects: noop,
      runtimeSeatManager: null,
    },
  );
  const providerFirst = loadProviders();
  const providerSecond = loadProviders();
  assert.strictEqual(providerFirst, providerSecond);
  assert.equal(providerRequests, 1);
  providerGate.resolve({ providers: [] });
  assert.equal((await providerFirst).ok, true);
  assert.equal(providerState.providersLoading, false);
});

test("capability fresh loads drain invalidated in-flight snapshots", async () => {
  const gates = [deferred(), deferred(), deferred()];
  const starts = [deferred(), deferred(), deferred()];
  let requests = 0;
  const state = { capabilitiesLoading: false, capabilitiesData: null, capabilitiesError: null, teams: [] };
  const { invalidateCapabilitiesCatalog, loadCapabilities } = evaluateSection(
    sourceSection("let capabilitiesLoadPromise", "function capabilitySourceButton"),
    ["invalidateCapabilitiesCatalog", "loadCapabilities"],
    {
      state,
      request: () => {
        const index = requests++;
        starts[index]?.resolve();
        return gates[index].promise;
      },
      API: { capabilities: "/capabilities" },
      successfulLoadResult,
      failedLoadResult,
      renderCapabilities: noop,
      renderConfigTopology: noop,
      elements: {},
      checkedChipValues: noop,
      renderTeamChips: noop,
    },
  );

  loadCapabilities();
  const fresh = invalidateCapabilitiesCatalog();
  gates[0].resolve({ skills: { memberIds: ["stale"] }, mcp: { servers: [] } });
  await bounded(starts[1].promise, "second capability GET");
  const fresher = loadCapabilities({ fresh: true });
  assert.strictEqual(fresher, fresh);
  gates[1].resolve({ skills: { memberIds: ["middle"] }, mcp: { servers: [] } });
  await bounded(starts[2].promise, "third capability GET");
  gates[2].resolve({ skills: { memberIds: ["member-current"] }, mcp: { servers: [] } });

  assert.equal((await bounded(fresh, "capability fresh drain")).ok, true);
  assert.equal(requests, 3);
  assert.deepEqual(state.capabilitiesData.skills.memberIds, ["member-current"]);
  assert.equal(state.capabilitiesLoading, false);
});

test("team and provider fresh loaders invalidate stale snapshots and drain repeated writes", async () => {
  const teamGates = [deferred(), deferred(), deferred()];
  const teamStarts = [deferred(), deferred(), deferred()];
  let teamRequests = 0;
  const teamState = { teams: [], selectedTeamId: "team-514cc" };
  const { loadTeams } = evaluateSection(
    sourceSection("let teamsLoadPromise", "// ===== 团队层级树"),
    ["loadTeams"],
    {
      state: teamState,
      request: () => {
        const index = teamRequests++;
        teamStarts[index]?.resolve();
        return teamGates[index].promise;
      },
      API: { teams: "/teams" },
      toast: noop,
      BUILTIN_TEAM_ID: "team-514cc",
      TEAM_KEY: "selected-team",
      localStorage: { setItem: noop },
      renderTeams: noop,
      refreshTeamData: noop,
      renderTeamActivation: noop,
      applyActiveTeamBackground: noop,
      missionControlDock: null,
      successfulLoadResult,
      failedLoadResult,
      elements: {},
      emptyMarkup: noop,
    },
  );

  loadTeams();
  const teamFresh = loadTeams({ fresh: true });
  teamGates[0].resolve({ teams: [{ id: "team-514cc", revision: 0 }] });
  await bounded(teamStarts[1].promise, "second team GET");
  const teamFresher = loadTeams({ fresh: true });
  assert.strictEqual(teamFresher, teamFresh, "fresh calls while queued share the drain promise");
  teamGates[1].resolve({ teams: [{ id: "team-514cc", revision: 1 }] });
  await bounded(teamStarts[2].promise, "third team GET");
  teamGates[2].resolve({ teams: [{ id: "team-514cc", revision: 2 }] });
  assert.equal((await bounded(teamFresh, "team fresh drain")).ok, true);
  assert.equal(teamRequests, 3);
  assert.equal(teamState.teams[0].revision, 2);

  const providerGates = [deferred(), deferred(), deferred()];
  const providerStarts = [deferred(), deferred(), deferred()];
  let providerRequests = 0;
  const providerState = { providersLoading: false, providersData: null, teams: [] };
  const { loadProviders } = evaluateSection(
    sourceSection("let providersLoadPromise", "// cc-switch autoQueryInterval"),
    ["loadProviders"],
    {
      state: providerState,
      request: () => {
        const index = providerRequests++;
        providerStarts[index]?.resolve();
        return providerGates[index].promise;
      },
      API: { providers: "/providers" },
      successfulLoadResult,
      failedLoadResult,
      renderProviders: noop,
      renderConfigTopology: noop,
      reconcileUsageAutoQuery: noop,
      reconcileProviderLivePoll: noop,
      elements: {},
      populateTeamProviderSelects: noop,
      runtimeSeatManager: null,
    },
  );

  loadProviders();
  const providerFresh = loadProviders({ fresh: true });
  providerGates[0].resolve({ providers: [{ id: "stale" }] });
  await bounded(providerStarts[1].promise, "second provider GET");
  const providerFresher = loadProviders({ fresh: true });
  assert.strictEqual(providerFresher, providerFresh);
  providerGates[1].resolve({ providers: [{ id: "middle" }] });
  await bounded(providerStarts[2].promise, "third provider GET");
  providerGates[2].resolve({ providers: [{ id: "latest" }] });
  assert.equal((await bounded(providerFresh, "provider fresh drain")).ok, true);
  assert.equal(providerRequests, 3);
  assert.equal(providerState.providersData.providers[0].id, "latest");
});

test("team form preserves Skill and MCP declarations while the capability catalog is unavailable", () => {
  const elements = {
    "team-members-list": {
      querySelectorAll: () => [{ checked: true, value: "codex-technical" }],
      querySelector: () => ({ value: "codex-technical" }),
    },
    "team-form": { dataset: { coordinator: "codex-technical" } },
    "team-name-input": { value: "保留能力团队" },
    "team-description-input": { value: "" },
    "team-prompt-input": { value: "" },
  };
  const state = {
    editingTeamId: "team-custom",
    capabilitiesData: null,
    teamChipsPending: { skills: ["co-review"], mcp: ["codex-agent"] },
  };
  const fallbacks = [];
  const { collectTeamForm } = evaluateSection(
    sourceSection("function teamChipFallback", "async function saveTeamForm"),
    ["collectTeamForm"],
    {
      state,
      teamById: () => ({
        id: "team-custom",
        members: ["codex-technical", "external-member"],
        skills: ["old-skill"],
        mcp: ["old-mcp"],
      }),
      elements,
      checkedChipValues: (id, fallback) => {
        fallbacks.push({ id, fallback });
        return fallback;
      },
      collectTeamProviderBindings: () => ({}),
    },
  );

  const payload = collectTeamForm();
  assert.deepEqual(payload.members, ["codex-technical", "external-member"], "an existing member missing from the rendered catalog must be retained without injecting Claude");
  assert.equal(payload.coordinator, "codex-technical");
  assert.deepEqual(payload.skills, ["co-review"]);
  assert.deepEqual(payload.mcp, ["codex-agent"]);
  assert.deepEqual(fallbacks.map((item) => item.fallback), [["co-review"], ["codex-agent"]]);

  state.capabilitiesData = { skills: { items: [] }, mcp: { servers: [] } };
  const persistedFallback = collectTeamForm();
  assert.deepEqual(persistedFallback.skills, ["old-skill"], "stale pending data must not leak after the catalog becomes available");
  assert.deepEqual(persistedFallback.mcp, ["old-mcp"]);
});

test("source refresh keeps a dirty orphan draft and clears a clean stale selection", async () => {
  let dirty = true;
  const warnings = [];
  const originalConfig = { id: "old", baselineContent: "base" };
  const state = {
    selectedSourceId: "old",
    sources: [{ id: "old" }],
    config: originalConfig,
    versions: [{ id: "v1" }],
    pendingPlan: { id: "plan" },
    capabilitiesData: null,
  };
  const { loadSources } = evaluateSection(sourceSection("async function loadSources", "async function loadRuns"), ["loadSources"], {
    state,
    request: async () => ({ sources: [{ id: "new" }] }),
    API: { sources: "/sources" },
    unwrapList: (payload) => payload.sources,
    normalizeSource: (source) => source,
    configIsDirty: () => dirty,
    appendDiagnostic: (message) => warnings.push(message),
    toast: noop,
    renderConfig: noop,
    renderSources: noop,
    renderCapabilities: noop,
    renderConfigTopology: noop,
    renderOverview: noop,
  });

  await loadSources();
  assert.equal(state.selectedSourceId, "old");
  assert.strictEqual(state.config, originalConfig);
  assert.equal(warnings.length, 1);

  dirty = false;
  await loadSources();
  assert.equal(state.selectedSourceId, "new");
  assert.equal(state.config, null);
  assert.deepEqual(state.versions, []);
  assert.equal(state.pendingPlan, null);
});

test("source details start only after source refresh and use the refreshed selection", async () => {
  const sourceGate = deferred();
  const state = { selectedSourceId: "old" };
  const events = [];
  const { refreshSourcesAndSelectedConfig } = evaluateSection(
    sourceSection("async function refreshSourcesAndSelectedConfig", "async function refreshCurrentView"),
    ["refreshSourcesAndSelectedConfig"],
    {
      loadSources: async () => {
        events.push("sources:start");
        await sourceGate.promise;
        state.selectedSourceId = "new";
        events.push("sources:end");
      },
      state,
      configIsDirty: () => false,
      successfulLoadResult,
      loadSelectedConfig: async () => {
        events.push(`config:${state.selectedSourceId}`);
        return successfulLoadResult();
      },
    },
  );

  const refresh = refreshSourcesAndSelectedConfig();
  await Promise.resolve();
  assert.deepEqual(events, ["sources:start"]);
  sourceGate.resolve();
  await refresh;
  assert.deepEqual(events, ["sources:start", "sources:end", "config:new"]);
});

test("selected config loader is latest-wins when source requests overlap", async () => {
  const detailA = deferred();
  const detailB = deferred();
  const state = {
    selectedSourceId: "a",
    sources: [
      { id: "a", name: "A", path: "a.json", format: "json", scope: "repo" },
      { id: "b", name: "B", path: "b.json", format: "json", scope: "repo" },
    ],
    config: null,
    versions: [],
  };
  const { loadSelectedConfig } = evaluateSection(
    sourceSection("let selectedConfigLoadGeneration", "function renderConfig"),
    ["loadSelectedConfig"],
    {
      state,
      successfulLoadResult,
      failedLoadResult,
      setConfigBusy: noop,
      request: (path) => {
        if (path.endsWith("/versions")) return Promise.resolve({ versions: [] });
        return path.endsWith("/a") ? detailA.promise : detailB.promise;
      },
      unwrapList: (payload) => payload.versions,
      appendDiagnostic: noop,
      setValidationStatus: noop,
      toast: noop,
      renderSources: noop,
      renderConfig: noop,
    },
  );

  const loadA = loadSelectedConfig();
  state.selectedSourceId = "b";
  const loadB = loadSelectedConfig();
  detailB.resolve({ config: { content: "B", sha256: "b" } });
  await loadB;
  assert.equal(state.config.id, "b");
  assert.equal(state.config.content, "B");
  detailA.resolve({ config: { content: "A", sha256: "a" } });
  const staleResult = await loadA;
  assert.equal(staleResult.stale, true);
  assert.equal(state.config.id, "b");
});

test("historical config previews are latest-wins when version responses arrive out of order", async () => {
  const first = deferred();
  const second = deferred();
  const requests = [];
  const diffs = [];
  const state = {
    config: { id: "control.routing" },
    versions: [{ versionId: "older" }, { versionId: "newer" }],
    configVersionPreview: null,
  };
  const { previewConfigVersion } = evaluateSection(
    // 切片起点上移到行尾工具块：previewConfigVersion 的 diff 要走 normalizeNewlines /
    // editorValue（CRLF 假 dirty 的修法），二者必须落在同一个 sandbox 里。
    sourceSection("function normalizeNewlines", "function renderConfigVersionPreview"),
    ["previewConfigVersion"],
    {
      state,
      renderVersions: noop,
      request: (path) => {
        requests.push(path);
        return requests.length === 1 ? first.promise : second.promise;
      },
      createLocalDiff: (historical, current) => {
        const diff = `${historical}->${current}`;
        diffs.push(diff);
        return diff;
      },
      elements: { "config-editor": { value: "current\n" } },
      appendDiagnostic: noop,
    },
  );

  const older = previewConfigVersion("older");
  const newer = previewConfigVersion("newer");
  second.resolve({ version: { content: "newer\n", sha256: "newer-sha" } });
  await newer;
  first.resolve({ version: { content: "older\n", sha256: "older-sha" } });
  await older;

  assert.deepEqual(requests, [
    "/api/config/control.routing/versions/older/content",
    "/api/config/control.routing/versions/newer/content",
  ]);
  assert.equal(state.configVersionPreview.versionId, "newer");
  assert.equal(state.configVersionPreview.status, "ok");
  assert.equal(state.configVersionPreview.data.sha256, "newer-sha");
  assert.equal(state.configVersionPreview.data.diff, "newer\n->current\n");
  assert.deepEqual(diffs, ["newer\n->current\n"], "stale history must not compute or publish a diff");
});

test("remote source drafts participate in the shared beforeunload dirty-state gate", () => {
  const state = {
    configHostSourceDrafts: new Map([
      ["host:h1:codex-config", { content: "clean", dirty: false }],
      ["project:p1:claude-settings", { content: "edited", dirty: true }],
    ]),
    eventController: { abortCalls: 0, abort() { this.abortCalls += 1; } },
  };
  const dirtyHelpers = evaluateSection(
    sourceSection("function configRemoteDirtyDraftCount", "function selectConfigHost"),
    ["configRemoteDirtyDraftCount", "hasUnsavedConfigChanges"],
    {
      state,
      configIsDirty: () => false,
      teamFormDirty: false,
      memberLibrary: null,
      runtimeSeatManager: null,
    },
  );
  assert.equal(dirtyHelpers.configRemoteDirtyDraftCount(), 1);
  assert.equal(dirtyHelpers.configRemoteDirtyDraftCount("host:h1"), 0);
  assert.equal(dirtyHelpers.configRemoteDirtyDraftCount("project:p1"), 1);
  assert.equal(dirtyHelpers.hasUnsavedConfigChanges(), true);

  let beforeUnload = null;
  const missionControlDock = { destroyCalls: 0, destroy() { this.destroyCalls += 1; } };
  const listenerSource = sourceSection(
    '  window.addEventListener("beforeunload"',
    "\n}\n\n// ─── v4.0 新增辅助函数",
  );
  evaluateSection(listenerSource, [], {
    window: { addEventListener: (type, handler) => { if (type === "beforeunload") beforeUnload = handler; } },
    state,
    missionControlDock,
    hasUnsavedConfigChanges: dirtyHelpers.hasUnsavedConfigChanges,
  });
  assert.equal(typeof beforeUnload, "function");
  const event = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
  beforeUnload(event);
  assert.equal(event.prevented, true);
  assert.equal(event.returnValue, "");
  assert.equal(state.eventController.abortCalls, 1);
  assert.equal(missionControlDock.destroyCalls, 1);

  state.configHostSourceDrafts.get("project:p1:claude-settings").dirty = false;
  const cleanEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  beforeUnload(cleanEvent);
  assert.equal(cleanEvent.prevented, false);
});

test("remote target chips distinguish online, offline, probing, unprobed and untrusted states", () => {
  const bar = { innerHTML: "" };
  const state = {
    configHostId: null,
    configProjectId: null,
    configHosts: [
      { id: "online", name: "Online", trusted: true, user: "u", host: "online.test", port: 22 },
      { id: "offline", name: "Offline", trusted: true, user: "u", host: "offline.test", port: 22 },
      { id: "probing", name: "Probing", trusted: true, user: "u", host: "probing.test", port: 22 },
      { id: "unprobed", name: "Unprobed", trusted: true, user: "u", host: "new.test", port: 22 },
      { id: "untrusted", name: "Untrusted", trusted: false, user: "u", host: "unknown.test", port: 22 },
    ],
    remoteProjects: [
      { id: "p-offline", name: "Offline project", hostId: "offline", path: "/repo", host: { id: "offline", name: "Offline" } },
      { id: "p-unprobed", name: "Fresh project", hostId: "unprobed", path: "/fresh", host: { id: "unprobed", name: "Unprobed" } },
    ],
    configHostProbes: new Map([
      ["online", { status: "ok", data: {} }],
      ["offline", { status: "error", error: "connection refused" }],
      ["probing", { status: "loading" }],
    ]),
    configHostSourceDrafts: new Map(),
    configHostsError: null,
    remoteProjectsError: null,
  };
  const { renderConfigHostBar } = evaluateSection(
    sourceSection("function renderConfigHostBar", "function configRemoteDirtyDraftCount"),
    ["renderConfigHostBar"],
    {
      state,
      elements: { "config-host-bar": bar },
      escapeHtml: (value) => String(value),
      configRemoteDirtyDraftCount: () => 0,
    },
  );

  renderConfigHostBar();
  const chip = (attribute, id) => bar.innerHTML.match(new RegExp(`<button[^>]+${attribute}="${id}"[\\s\\S]*?</button>`))?.[0] ?? "";
  assert.match(chip("data-config-host", "online"), /is-ok[\s\S]*在线/);
  assert.match(chip("data-config-host", "offline"), /is-error[\s\S]*离线/);
  assert.match(chip("data-config-host", "probing"), /is-loading[\s\S]*探测中/);
  assert.match(chip("data-config-host", "unprobed"), /config-host-chip-status">未探测/);
  assert.match(chip("data-config-host", "untrusted"), /config-host-chip-status">待信任/);
  assert.match(chip("data-config-project", "p-offline"), /is-error[\s\S]*离线/);
  assert.match(chip("data-config-project", "p-unprobed"), /config-host-chip-status">未探测/);
  assert.doesNotMatch(chip("data-config-host", "unprobed"), /is-ok|is-error|is-loading/);
});

test("remote provider matching does not confuse an endpoint match with confirmed profile identity", () => {
  const state = {
    providerLatency: {},
    configRemoteBusy: new Set(),
    configRemoteRecovery: new Map(),
  };
  // 身份块（名称/徽标/端点/模型行）自 v42 起本机与远程共用一份实现，这里连真实现一起取，
  // 行断言才仍然是在验证用户真正看到的那段 markup，而不是测试自造的替身。
  const { providerRowIdentityMarkup } = evaluateSection(
    sourceSection("function providerRowIdentityMarkup", "function providerAppTabsMarkup"),
    ["providerRowIdentityMarkup"],
    { escapeHtml: (value) => String(value), usageLineOf: () => "", PRESET_CATEGORY_LABELS: {} },
  );
  const helpers = evaluateSection(
    sourceSection("function normalizeRemoteProviderUrl", "function configRemoteLiveSummary"),
    ["configRemoteProviderMatchState", "configRemoteProviderProfileRow"],
    {
      state,
      configRemoteTargetKey: () => "host:h1",
      configRemoteRecoveryForTarget: () => null,
      healthBadgeOf: () => ({ level: "unknown", title: "未探测" }),
      usageLineOf: () => "",
      escapeHtml: (value) => String(value),
      PRESET_CATEGORY_LABELS: {},
      providerRowIdentityMarkup,
    },
  );
  const graph = { providers: [{ cli: "codex", exists: true, baseUrl: "HTTPS://API.EXAMPLE.COM/v1/" }] };
  const first = { id: "profile-a", name: "Profile A", baseUrl: "https://api.example.com/v1", apps: { codex: true } };
  const second = { id: "profile-b", name: "Profile B", baseUrl: "https://api.example.com/v1/", apps: { codex: true } };
  const meta = { modelHint: () => "" };

  assert.equal(helpers.configRemoteProviderMatchState(graph, "codex", first), "endpoint");
  assert.equal(helpers.configRemoteProviderMatchState(graph, "codex", second), "endpoint");
  const row = helpers.configRemoteProviderProfileRow(graph, first, meta, "codex");
  assert.match(row, /is-endpoint-match/);
  assert.match(row, /端点相同 · 档案待确认/);
  assert.match(row, /重新应用并确认/);
  assert.doesNotMatch(row, /is-current|档案已确认/);

  const confirmed = { providers: [{ cli: "codex", exists: true, providerId: "profile-a", baseUrl: "https://other.example/v1" }] };
  assert.equal(helpers.configRemoteProviderMatchState(confirmed, "codex", first), "confirmed");
});

test("remote provider failures normalize nested recovery payloads and block subsequent writes", async () => {
  const target = { key: "host:h1", hostId: "h1", projectId: null, label: "主机 H1" };
  const provider = { id: "profile-a", name: "Profile A" };
  const state = {
    configRemoteBusy: new Set(),
    configRemoteRecovery: new Map(),
    configRemoteRecoveryLoaded: true,
    configRemoteRecoveryLoadError: null,
  };
  const recovery = recoveryHarness(state, { currentTargetKey: () => target.key });
  const calls = [];
  const toasts = [];
  const publishError = Object.assign(new Error("remote result is ambiguous"), {
    payload: { error: { recoveryRequired: true, recovery: {
      transactionId: "tx-123",
      applied: [{ remote: "/home/u/.codex/config.toml" }],
      uncertain: [{ remote: "/home/u/.codex/auth.json" }],
      backups: [{ remote: "/backup/config.toml" }],
    } } },
  });
  const functions = evaluateSection(
    sourceSection("function configRemoteRecoveryEvidence", "const CONFIG_REMOTE_WORKBENCH_TABS"),
    ["configRemoteRecoveryEvidence", "applyConfigRemoteProvider", "applyConfigRemoteTeam"],
    {
      state,
      providerById: (id) => id === provider.id ? provider : null,
      PROVIDER_APP_META: [{ app: "codex", label: "Codex" }],
      PROVIDER_APPS: ["codex"],
      configRemoteProviderTargetSnapshot: () => ({ ...target }),
      configRemoteTargetKey: () => target.key,
      configRemoteRecoveryKey: recovery.configRemoteRecoveryKey,
      configRemoteRecoveryForTarget: recovery.configRemoteRecoveryForTarget,
      configRemoteTargetSnapshotForKey: recovery.configRemoteTargetSnapshotForKey,
      persistConfigRemoteRecoveries: recovery.persistConfigRemoteRecoveries,
      notifyConfigRemoteRecoveryChanged: noop,
      renderConfigRemotePanel: noop,
      request: async (path, options) => {
        calls.push({ path, options });
        throw publishError;
      },
      confirmAction: async () => true,
      configRemoteResult: noop,
      escapeHtml: (value) => String(value),
      toast: (...args) => toasts.push(args),
      loadConfigHostGraph: async () => {},
    },
  );

  await assert.rejects(
    functions.applyConfigRemoteProvider("codex", provider.id, {
      skipConfirm: true,
      target,
      plan: { planRevision: "plan-1", files: [] },
    }),
    /ambiguous/,
  );
  const recoveryKey = "h1:provider:tx-123";
  assert.deepEqual(state.configRemoteRecovery.get(recoveryKey), {
    kind: "provider",
    transactionId: "tx-123",
    applied: [{ remote: "/home/u/.codex/config.toml" }],
    uncertain: [{ remote: "/home/u/.codex/auth.json" }],
    backups: [{ remote: "/backup/config.toml" }],
    locks: [],
    rollbackErrors: [],
    causeCode: null,
    serverPersisted: false,
    message: "remote result is ambiguous",
    targetKey: target.key,
    hostId: target.hostId,
    projectId: null,
    scope: "host",
    appliedCount: 1,
    uncertainCount: 1,
    recordedAt: state.configRemoteRecovery.get(recoveryKey).recordedAt,
  });
  assert.deepEqual(functions.configRemoteRecoveryEvidence({
    status: "recovery_required",
    transactionId: "tx-flat",
    uncertain: ["auth.json"],
  }), {
    kind: null,
    transactionId: "tx-flat",
    applied: [],
    uncertain: ["auth.json"],
    backups: [],
    locks: [],
    rollbackErrors: [],
    causeCode: null,
    serverPersisted: false,
    message: "远端提交状态需要核对",
  });
  assert.equal(state.configRemoteBusy.size, 0);

  calls.length = 0;
  await functions.applyConfigRemoteProvider("codex", provider.id, {
    skipConfirm: false,
    target,
    plan: { planRevision: "plan-2", files: [] },
  });
  assert.equal(calls.length, 0, "an unresolved recovery must block a direct provider write before HTTP");
  assert.ok(toasts.some(([message]) => /未和解|状态不确定|核对/.test(message)), "the operator must see why the write was blocked");
});

test("an unresolved remote recovery blocks team batch planning before any application is touched", async () => {
  const target = { key: "project:p1", hostId: "h1", projectId: "p1", label: "项目 P1" };
  const provider = { id: "profile-a", name: "Profile A" };
  const state = {
    teams: [{ id: "team-a", name: "Team A", providers: { codex: provider.id } }],
    configRemoteBusy: new Set(),
    configRemoteRecovery: new Map([[target.key, { transactionId: "tx-pending" }]]),
    configRemoteRecoveryLoaded: true,
    configRemoteRecoveryLoadError: null,
  };
  let requests = 0;
  let confirmations = 0;
  const toasts = [];
  const { configRemoteWriteBlocked } = evaluateSection(
    sourceSection("function configRemoteWriteBlocked", "/* ===== 远程三面图谱"),
    ["configRemoteWriteBlocked"],
    {
      state,
      configRemoteRecoveryForTarget: (targetOrKey) => state.configRemoteRecovery.get(
        typeof targetOrKey === "string" ? targetOrKey : targetOrKey?.key,
      ) ?? null,
      toast: (...args) => toasts.push(args),
    },
  );
  const { applyConfigRemoteTeam } = evaluateSection(
    sourceSection("async function applyConfigRemoteTeam", "const CONFIG_REMOTE_WORKBENCH_TABS"),
    ["applyConfigRemoteTeam"],
    {
      state,
      providerById: (id) => id === provider.id ? provider : null,
      PROVIDER_APP_META: [{ app: "codex", label: "Codex" }],
      PROVIDER_APPS: ["codex"],
      configRemoteProviderTargetSnapshot: () => ({ ...target }),
      configRemoteTargetKey: () => target.key,
      configRemoteWriteBlocked,
      renderConfigRemotePanel: noop,
      request: async () => { requests += 1; return { files: [], planRevision: "unexpected" }; },
      confirmAction: async () => { confirmations += 1; return true; },
      configRemoteResult: noop,
      escapeHtml: (value) => String(value),
      toast: (...args) => toasts.push(args),
      loadConfigHostGraph: async () => {},
    },
  );

  await applyConfigRemoteTeam("team-a");
  assert.equal(requests, 0);
  assert.equal(confirmations, 0);
  assert.equal(state.configRemoteBusy.size, 0);
  assert.ok(toasts.some(([message]) => /未和解|状态不确定|核对/.test(message)));
});

test("remote writes fail closed until the server recovery ledger is loaded", () => {
  const state = {
    remoteProjects: [{ id: "p1", hostId: "h1" }],
    configRemoteRecovery: new Map(),
    configRemoteRecoveryLoaded: false,
    configRemoteRecoveryLoadError: null,
  };
  const recovery = recoveryHarness(state);

  assert.equal(recovery.configRemoteWriteBlocked("project:p1", { notify: false }), true);
  state.configRemoteRecoveryLoaded = true;
  assert.equal(recovery.configRemoteWriteBlocked("project:p1", { notify: false }), false);
  state.configRemoteRecoveryLoadError = "ledger unavailable";
  assert.equal(recovery.configRemoteWriteBlocked("project:p1", { notify: false }), true);
});

test("a blocked response immediately materializes server recovery cards and blocks the whole host", () => {
  const state = {
    remoteProjects: [
      { id: "p1", hostId: "h1" },
      { id: "p2", hostId: "h1" },
      { id: "p3", hostId: "h2" },
    ],
    configRemoteRecovery: new Map(),
  };
  const recovery = recoveryHarness(state);
  const pendingTransactionId = "44444444-4444-4444-8444-444444444444";
  const remembered = recovery.rememberConfigRemoteRecovery({
    key: "project:p2", hostId: "h1", projectId: "p2",
  }, {
    payload: {
      code: "REMOTE_RECOVERY_BLOCKED",
      error: {
        message: "another window owns an unresolved transaction",
        pending: [{
          kind: "provider",
          transactionId: pendingTransactionId,
          targetKey: "project:p1",
          appliedCount: 2,
          uncertainCount: 1,
        }],
      },
    },
  });

  assert.equal(remembered?.transactionId, pendingTransactionId);
  assert.deepEqual(state.configRemoteRecovery.get(`h1:provider:${pendingTransactionId}`), {
    kind: "provider",
    transactionId: pendingTransactionId,
    targetKey: "project:p1",
    applied: [],
    uncertain: [],
    backups: [],
    locks: [],
    rollbackErrors: [],
    appliedCount: 2,
    uncertainCount: 1,
    causeCode: null,
    serverPersisted: true,
    message: "another window owns an unresolved transaction",
    hostId: "h1",
    projectId: "p1",
    scope: "project",
    recordedAt: state.configRemoteRecovery.get(`h1:provider:${pendingTransactionId}`).recordedAt,
  });
  assert.equal(recovery.configRemoteWriteBlocked("project:p1", { notify: false }), true);
  assert.equal(recovery.configRemoteWriteBlocked("project:p2", { notify: false }), true);
  assert.equal(recovery.configRemoteWriteBlocked("host:h1", { notify: false }), true);
  assert.equal(recovery.configRemoteWriteBlocked("project:p3", { notify: false }), false);
});

test("sync dialog freezes its opening host and project while the selected target changes", async () => {
  const ui = fakeSyncDialogDocument();
  const calls = [];
  const results = [];
  let currentTarget = { key: "project:p1", hostId: "h1", projectId: "p1" };
  const planFile = {
    id: "codex-config", label: "Codex", local: "a", remote: "b", exists: true,
    size: 1, containsSecrets: false, digest: "d".repeat(64),
  };
  const openConfigSyncDialog = configSyncDialogHarness({
    document: ui.document,
    targetSnapshot: () => ({ ...currentTarget }),
    project: () => ({ id: currentTarget.projectId, name: currentTarget.projectId, path: `/srv/${currentTarget.projectId}` }),
    request: async (path, options) => {
      calls.push({ path, options });
      return options ? { complete: true, results: [{ ok: true, label: "Codex", remote: "b", bytes: 1 }] } : { files: [planFile] };
    },
    result: (html, targetKey) => results.push({ html, targetKey }),
  });

  await openConfigSyncDialog({ id: "h1", name: "Host 1" });
  currentTarget = { key: "project:p2", hostId: "h2", projectId: "p2" };
  await ui.push.dispatch();

  assert.deepEqual(calls[1], {
    path: "/api/ssh/hosts/h1/env-sync",
    options: {
      method: "POST",
      body: { files: [{ id: "codex-config", digest: "d".repeat(64), allowSecrets: false }] },
    },
  });
  assert.equal(results.at(-1)?.targetKey, "project:p1");
});

test("sync dialog rechecks recovery after opening and prevents the POST", async () => {
  const ui = fakeSyncDialogDocument();
  const calls = [];
  let gateChecks = 0;
  const openConfigSyncDialog = configSyncDialogHarness({
    document: ui.document,
    targetSnapshot: () => ({ key: "project:p1", hostId: "h1", projectId: "p1" }),
    project: () => ({ id: "p1", name: "P1", path: "/srv/p1" }),
    writeBlocked: () => ++gateChecks > 1,
    request: async (path, options) => {
      calls.push({ path, options });
      return { files: [{
        id: "codex-config", label: "Codex", local: "a", remote: "b", exists: true,
        size: 1, containsSecrets: false, digest: "e".repeat(64),
      }] };
    },
  });

  await openConfigSyncDialog({ id: "h1", name: "Host 1" });
  await ui.push.dispatch();

  assert.equal(calls.length, 1);
  assert.equal(ui.message.textContent, "该主机出现未和解事务，本次同步已阻止。");
});

test("HTTP 200 recovery state cannot be presented as a completed sync", async () => {
  const ui = fakeSyncDialogDocument();
  const results = [];
  const toasts = [];
  const recovery = { kind: "sync", transactionId: "55555555-5555-4555-8555-555555555555" };
  const openConfigSyncDialog = configSyncDialogHarness({
    document: ui.document,
    targetSnapshot: () => ({ key: "project:p1", hostId: "h1", projectId: "p1" }),
    project: () => ({ id: "p1", name: "P1", path: "/srv/p1" }),
    request: async (_path, options) => options
      ? {
        complete: true,
        status: "recovery_required",
        recoveryRequired: true,
        transactionId: recovery.transactionId,
        results: [{ ok: true, label: "Codex", remote: "b", bytes: 1 }],
      }
      : { files: [{
        id: "codex-config", label: "Codex", local: "a", remote: "b", exists: true,
        size: 1, containsSecrets: false, digest: "f".repeat(64),
      }] },
    rememberRecovery: () => recovery,
    result: (html, targetKey) => results.push({ html, targetKey }),
    toast: (...args) => toasts.push(args),
  });

  await openConfigSyncDialog({ id: "h1", name: "Host 1" });
  await ui.push.dispatch();

  assert.match(results.at(-1)?.html ?? "", /同步状态不确定/);
  assert.doesNotMatch(results.at(-1)?.html ?? "", /同步完成/);
  assert.ok(toasts.some(([message, level]) => /同步状态不确定/.test(message) && level === "error"));
});

test("remote recovery keeps concurrent transactions and blocks every target on the affected host", () => {
  const state = {
    remoteProjects: [
      { id: "p1", hostId: "h1" },
      { id: "p2", hostId: "h1" },
      { id: "p3", hostId: "h2" },
    ],
    configRemoteRecovery: new Map(),
  };
  const storage = memoryStorage();
  const recovery = recoveryHarness(state, { localStorage: storage });
  const project = { key: "project:p1", hostId: "h1", projectId: "p1" };

  recovery.rememberConfigRemoteRecovery(project, {
    recoveryRequired: true,
    kind: "provider",
    transactionId: "11111111-1111-4111-8111-111111111111",
  });
  recovery.rememberConfigRemoteRecovery(project, {
    recoveryRequired: true,
    kind: "graph",
    transactionId: "22222222-2222-4222-8222-222222222222",
  });
  recovery.rememberConfigRemoteRecovery(project, {
    status: "recovery_required",
    kind: "sync",
    transactionId: "33333333-3333-4333-8333-333333333333",
  });

  assert.deepEqual(
    [...state.configRemoteRecovery.values()].map((entry) => entry.transactionId).sort(),
    [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ],
    "recording a second transaction must not overwrite the first unresolved transaction",
  );
  const provider = [...state.configRemoteRecovery.values()].find((entry) => entry.kind === "provider");
  const graph = [...state.configRemoteRecovery.values()].find((entry) => entry.kind === "graph");
  const sync = [...state.configRemoteRecovery.values()].find((entry) => entry.kind === "sync");
  assert.deepEqual({ targetKey: provider.targetKey, projectId: provider.projectId, scope: provider.scope }, {
    targetKey: "project:p1", projectId: "p1", scope: "project",
  });
  assert.deepEqual({ targetKey: graph.targetKey, projectId: graph.projectId, scope: graph.scope }, {
    targetKey: "project:p1", projectId: "p1", scope: "project",
  });
  assert.deepEqual({ targetKey: sync.targetKey, projectId: sync.projectId, scope: sync.scope }, {
    targetKey: "host:h1", projectId: null, scope: "host",
  });
  assert.equal(recovery.configRemoteWriteBlocked("project:p2", { notify: false }), true);
  assert.equal(recovery.configRemoteWriteBlocked("host:h1", { notify: false }), true);
  assert.equal(recovery.configRemoteWriteBlocked("project:p3", { notify: false }), false);

  const saved = JSON.parse(storage.value("514cc-config-remote-recovery-v1"));
  assert.equal(saved.records.length, 3);
});

test("remote recovery restore preserves all valid records and is wired into startup", () => {
  const records = [
    recoveryRecord("provider", "11111111-1111-4111-8111-111111111111"),
    recoveryRecord("graph", "22222222-2222-4222-8222-222222222222"),
    recoveryRecord("sync", "33333333-3333-4333-8333-333333333333", {
      targetKey: "host:h1", projectId: null, scope: "host",
    }),
    { kind: "provider", transactionId: "bad", targetKey: "../../bad", hostId: "h1" },
  ];
  const storage = memoryStorage({
    "514cc-config-remote-recovery-v1": JSON.stringify({ schema: 1, records }),
  });
  const state = {
    remoteProjects: [
      { id: "p1", hostId: "h1" },
      { id: "p2", hostId: "h1" },
      { id: "p3", hostId: "h2" },
    ],
    configRemoteRecovery: new Map(),
  };
  const recovery = recoveryHarness(state, { localStorage: storage });

  recovery.restoreConfigRemoteRecoveries();

  assert.deepEqual(
    [...state.configRemoteRecovery.values()].map((entry) => entry.transactionId).sort(),
    records.slice(0, 3).map((entry) => entry.transactionId).sort(),
  );
  assert.equal(recovery.configRemoteWriteBlocked("project:p2", { notify: false }), true);
  assert.equal(recovery.configRemoteWriteBlocked("project:p3", { notify: false }), false);
  assert.match(
    sourceSection("async function start()", "void start().catch"),
    /restoreConfigRemoteRecoveries\(\)/,
    "persisted recovery evidence must be restored before the first interactive render",
  );
});

test("remote recovery reconciliation uses original scope and is single-flight across host chips", async () => {
  const transactionId = "11111111-1111-4111-8111-111111111111";
  const state = {
    remoteProjects: [{ id: "p1", hostId: "h1" }, { id: "p2", hostId: "h1" }],
    configRemoteRecovery: new Map([["project:p1:provider:tx", {
      ...recoveryRecord("provider", transactionId),
      applied: [], uncertain: [], backups: [], locks: [], rollbackErrors: [],
    }]]),
    configRemoteBusy: new Set(),
  };
  const storage = memoryStorage();
  let currentTargetKey = "project:p1";
  const recovery = recoveryHarness(state, { localStorage: storage, currentTargetKey: () => currentTargetKey });
  const gate = deferred();
  const calls = [];
  const { reconcileConfigRemoteRecovery } = evaluateSection(
    sourceSection("async function reconcileConfigRemoteRecovery", "async function diagnoseConfigRemoteProxy"),
    ["reconcileConfigRemoteRecovery"],
    {
      state,
      configRemoteRecoveryEntryForTarget: recovery.configRemoteRecoveryEntryForTarget,
      configRemoteTargetKey: () => currentTargetKey,
      request: (path, options) => {
        calls.push({ path, options });
        return gate.promise;
      },
      clearConfigRemoteRecovery: recovery.clearConfigRemoteRecovery,
      persistConfigRemoteRecoveries: recovery.persistConfigRemoteRecoveries,
      configRemoteRecoveryEvidence: recovery.configRemoteRecoveryEvidence,
      configRemoteHost: () => ({ id: "h1" }),
      notifyConfigRemoteRecoveryChanged: noop,
      renderConfigRemotePanel: noop,
      configRemoteResult: noop,
      refreshConfigRemoteTarget: async () => {},
      escapeHtml: (value) => String(value),
      toast: noop,
    },
  );

  const fromProject = reconcileConfigRemoteRecovery("project:p1");
  await Promise.resolve();
  currentTargetKey = "host:h1";
  const fromHost = reconcileConfigRemoteRecovery("host:h1");
  await Promise.resolve();
  assert.equal(calls.length, 1, "the same transaction must have one reconcile owner across related chips");
  assert.equal(calls[0].path, "/api/remote-projects/p1/recovery/reconcile");
  assert.deepEqual(calls[0].options.body, { kind: "provider", transactionId });
  gate.resolve({ recoveryRequired: false, released: [] });
  await Promise.all([fromProject, fromHost]);
  assert.equal(state.configRemoteRecovery.size, 0);
  assert.equal(state.configRemoteBusy.size, 0);
});

test("a late reconcile failure cannot resurrect evidence already cleared by another owner", async () => {
  const transactionId = "11111111-1111-4111-8111-111111111111";
  const recoveryKey = "host:h1:sync:tx";
  const state = {
    remoteProjects: [],
    configRemoteRecovery: new Map([[recoveryKey, {
      ...recoveryRecord("sync", transactionId, { targetKey: "host:h1", projectId: null, scope: "host" }),
      applied: [], uncertain: [], backups: [], locks: [], rollbackErrors: [],
    }]]),
    configRemoteBusy: new Set(),
  };
  const recovery = recoveryHarness(state, { currentTargetKey: () => "host:h1" });
  const gate = deferred();
  const { reconcileConfigRemoteRecovery } = evaluateSection(
    sourceSection("async function reconcileConfigRemoteRecovery", "async function diagnoseConfigRemoteProxy"),
    ["reconcileConfigRemoteRecovery"],
    {
      state,
      configRemoteRecoveryEntryForTarget: recovery.configRemoteRecoveryEntryForTarget,
      configRemoteTargetKey: () => "host:h1",
      request: () => gate.promise,
      clearConfigRemoteRecovery: recovery.clearConfigRemoteRecovery,
      persistConfigRemoteRecoveries: recovery.persistConfigRemoteRecoveries,
      configRemoteRecoveryEvidence: recovery.configRemoteRecoveryEvidence,
      configRemoteHost: () => ({ id: "h1" }),
      notifyConfigRemoteRecoveryChanged: noop,
      renderConfigRemotePanel: noop,
      configRemoteResult: noop,
      refreshConfigRemoteTarget: async () => {},
      escapeHtml: (value) => String(value),
      toast: noop,
    },
  );

  const pending = reconcileConfigRemoteRecovery("host:h1");
  await Promise.resolve();
  recovery.clearConfigRemoteRecovery("sync", transactionId);
  gate.reject(new Error("late transport failure"));
  await pending;

  assert.equal(state.configRemoteRecovery.size, 0, "a stale catch path must not recreate a settled transaction");
  assert.equal(state.configRemoteBusy.size, 0);
});

test("remote graph refresh is latest-wins for the same host target", async () => {
  const first = deferred();
  const second = deferred();
  const requests = [];
  const state = {
    configHostId: "host-a",
    configHostGraph: new Map(),
  };
  const target = { key: "host:host-a", hostId: "host-a", projectId: null };
  const { loadConfigHostGraph } = evaluateSection(
    sourceSection("async function loadConfigHostGraph", "/** 真源文件点击展开/收起"),
    ["loadConfigHostGraph"],
    {
      state,
      configRemoteProviderTargetSnapshot: () => ({ ...target }),
      configRemoteTargetKey: () => target.key,
      configRemoteGraphEndpoint: ({ target: requestTarget }) => `/graph/${requestTarget.key}`,
      request: (path) => {
        requests.push(path);
        return requests.length === 1 ? first.promise : second.promise;
      },
      renderConfigTopology: noop,
      renderConfigRemotePanel: noop,
    },
  );

  const older = loadConfigHostGraph("host-a", { force: true });
  const newer = loadConfigHostGraph("host-a", { force: true });
  second.resolve({ revision: 2 });
  await newer;
  first.resolve({ revision: 1 });
  await older;

  assert.deepEqual(requests, ["/graph/host:host-a", "/graph/host:host-a"]);
  assert.equal(state.configHostGraph.get(target.key).data.revision, 2);
});

test("remote source reload freezes its target across confirmation and rejects stale responses", async () => {
  const confirmGate = deferred();
  const gates = [deferred(), deferred(), deferred()];
  const endpoints = [];
  let current = { key: "host:host-a", hostId: "host-a", projectId: null };
  const sourceKey = `${current.key}:codex-agents`;
  const state = {
    configHostSourceCache: new Map([[sourceKey, { status: "ok", data: { content: "base", digest: "old" } }]]),
    configHostSourceDrafts: new Map([[sourceKey, { content: "dirty", digest: "old", dirty: true }]]),
    configRemoteBusy: new Set(),
  };
  let requestCount = 0;
  const { reloadConfigRemoteSource } = evaluateSection(
    sourceSection("async function reloadConfigRemoteSource", "async function saveConfigRemoteSource"),
    ["reloadConfigRemoteSource"],
    {
      state,
      configRemoteProviderTargetSnapshot: () => ({ ...current }),
      configRemoteTargetKey: () => current.key,
      configRemoteGraphEndpoint: ({ sourceFile, target }) => {
        const endpoint = `${target.key}/${sourceFile}`;
        endpoints.push(endpoint);
        return endpoint;
      },
      confirmAction: () => confirmGate.promise,
      request: () => gates[requestCount++].promise,
      renderConfigRemotePanel: noop,
    },
  );

  const frozen = reloadConfigRemoteSource("codex-agents");
  current = { key: "project:project-b", hostId: "host-b", projectId: "project-b" };
  confirmGate.resolve(true);
  await Promise.resolve();
  gates[0].resolve({ content: "host-a", digest: "a" });
  await frozen;
  assert.deepEqual(endpoints, ["host:host-a/codex-agents"]);
  assert.equal(state.configHostSourceCache.get(sourceKey).data.content, "host-a");

  current = { key: "host:host-a", hostId: "host-a", projectId: null };
  state.configHostSourceDrafts.set(sourceKey, { content: "host-a", digest: "a", dirty: false });
  const older = reloadConfigRemoteSource("codex-agents");
  const newer = reloadConfigRemoteSource("codex-agents");
  gates[2].resolve({ content: "latest", digest: "b" });
  await newer;
  gates[1].resolve({ content: "stale", digest: "c" });
  await older;
  assert.equal(state.configHostSourceCache.get(sourceKey).data.content, "latest");
});

test("remote source save preserves edits made while the request is in flight and rebases their digest", async () => {
  const response = deferred();
  const target = { key: "host:host-a", hostId: "host-a", projectId: null };
  const sourceKey = `${target.key}:codex-agents`;
  const submittedDraft = { content: "submitted\n", digest: "old-digest", dirty: true };
  const state = {
    configHostSourceCache: new Map([[sourceKey, { status: "ok", data: {
      id: "codex-agents",
      label: "Codex AGENTS.md",
      remote: "/root/.codex/AGENTS.md",
      exists: true,
      editable: true,
      content: "base\n",
      digest: "old-digest",
    } }]]),
    configHostSourceDrafts: new Map([[sourceKey, submittedDraft]]),
    configRemoteBusy: new Set(),
  };
  let requestInput = null;
  let graphRefreshes = 0;
  const { saveConfigRemoteSource } = evaluateSection(
    sourceSection("async function saveConfigRemoteSource", "async function openConfigRemoteProviderSource"),
    ["saveConfigRemoteSource"],
    {
      state,
      configRemoteProviderTargetSnapshot: () => ({ ...target }),
      configRemoteTargetKey: () => target.key,
      confirmAction: async () => true,
      renderConfigRemotePanel: noop,
      configRemoteWriteBlocked: () => false,
      request: (endpoint, options) => {
        requestInput = { endpoint, options };
        return response.promise;
      },
      configRemoteResult: noop,
      escapeHtml: (value) => String(value),
      toast: noop,
      loadConfigHostGraph: async () => { graphRefreshes += 1; },
    },
  );

  const saving = saveConfigRemoteSource("codex-agents");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(requestInput.options.body.content, "submitted\n");
  state.configHostSourceDrafts.set(sourceKey, { content: "edited during save\n", digest: "old-digest", dirty: true });
  response.resolve({
    remote: "/root/.codex/AGENTS.md",
    bytes: 10,
    backup: "/root/.codex/AGENTS.md.514forge-backup-tx",
    digest: "new-digest",
    created: false,
  });
  await bounded(saving, "remote source save");

  const draft = state.configHostSourceDrafts.get(sourceKey);
  assert.deepEqual(draft, { content: "edited during save\n", digest: "new-digest", dirty: true });
  assert.equal(state.configHostSourceCache.get(sourceKey).data.content, "submitted\n");
  assert.equal(state.configHostSourceCache.get(sourceKey).data.digest, "new-digest");
  assert.equal(graphRefreshes, 1);
  assert.equal(state.configRemoteBusy.size, 0);
});

test("native CC-Switch deeplinks switch to local-runtime and drain in FIFO order", async () => {
  const firstOpen = deferred();
  const events = [];
  const window = {
    __forgeCcSwitchPanel: {
      openDeeplink: async (url) => {
        events.push(`open:${url}`);
        if (url === "ccswitch://a") await firstOpen.promise;
      },
    },
  };
  const { enqueueCcSwitchDeeplink } = evaluateSection(
    sourceSection("let ccSwitchDeeplinkQueue", "async function previewProviderDeeplink"),
    ["enqueueCcSwitchDeeplink"],
    {
      setView: (view, options) => events.push(`view:${view}/${options.configSurface}`),
      window,
      openProviderDeeplink: noop,
      toast: noop,
      appendDiagnostic: noop,
    },
  );

  const first = enqueueCcSwitchDeeplink("ccswitch://a");
  const second = enqueueCcSwitchDeeplink("ccswitch://b");
  await Promise.resolve();
  assert.deepEqual(events, ["view:config/local-runtime", "open:ccswitch://a"]);
  firstOpen.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "view:config/local-runtime",
    "open:ccswitch://a",
    "view:config/local-runtime",
    "open:ccswitch://b",
  ]);
  assert.match(appSource, /__FORGE_CCSWITCH_DEEPLINKS__\.splice\(0\)/);
  assert.doesNotMatch(sourceSection("const pendingCcSwitchDeeplinks", "elements[\"cap-skills-body\"]"), /\bbreak\b/);
});

test("provider-dialog fallback keeps native deeplinks in FIFO order", async () => {
  const firstOpen = deferred();
  const events = [];
  const window = {};
  const { enqueueCcSwitchDeeplink } = evaluateSection(
    sourceSection("let ccSwitchDeeplinkQueue", "async function previewProviderDeeplink"),
    ["enqueueCcSwitchDeeplink"],
    {
      setView: (view, options) => events.push(`view:${view}/${options.configSurface}`),
      window,
      openProviderDeeplink: async (url) => {
        events.push(`fallback:${url}`);
        if (url === "ccswitch://a") await firstOpen.promise;
      },
      toast: noop,
      appendDiagnostic: noop,
    },
  );

  const first = enqueueCcSwitchDeeplink("ccswitch://a");
  const second = enqueueCcSwitchDeeplink("ccswitch://b");
  await Promise.resolve();
  assert.deepEqual(events, ["view:config/sources", "fallback:ccswitch://a"]);
  firstOpen.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "view:config/sources",
    "fallback:ccswitch://a",
    "view:config/sources",
    "fallback:ccswitch://b",
  ]);
  assert.match(appSource, /async function openProviderDeeplink[\s\S]+if \(url\) await previewProviderDeeplink\(\)/);
  assert.match(appSource, /await openProviderDeeplink\(normalizedUrl\)/);
});

test("config refresh reports resolved loader failures", async () => {
  const messages = [];
  const failed = failedLoadResult(new Error("capabilities unavailable"));
  const { refreshCurrentView } = evaluateSection(
    sourceSection("async function refreshCurrentView", "function confirmAction"),
    ["refreshCurrentView"],
    {
      elements: { "refresh-button": { disabled: false } },
      state: { view: "config" },
      refreshSourcesAndSelectedConfig: async () => successfulLoadResult(),
      loadCapabilities: async () => failed,
      loadTeams: async () => successfulLoadResult(),
      loadProviders: async () => successfulLoadResult(),
      runtimeSeatManager: null,
      loadResultFailed,
      window: {},
      toast: (message, type) => messages.push({ message, type }),
      renderAll: noop,
    },
  );

  await refreshCurrentView();
  assert.deepEqual(messages, [{ message: "1 项刷新失败", type: "warning" }]);
});
