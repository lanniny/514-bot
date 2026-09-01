import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createControlCenter, validateRuntimeGraph } from "../src/app.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRepo = resolve(appRoot, "../..");

test("runtime reload only commits a catalog transition after a live swap", async () => {
  const source = await readFile(resolve(appRoot, "src/app.mjs"), "utf8");
  assert.match(source, /const catalogCommitted = Boolean\(activation\?\.status === "reloaded" \|\| swapped\);/);
  assert.match(source, /catalogGuard\?\.release\(\{\s*\n\s*committed: catalogCommitted,/);
  assert.match(source, /activation: activation \?\? \(swapped \? \{ status: "reloaded" \} : null\)/);
});

test("runtime graph rejects unauditable or unknown routing references", async () => {
  const [models, routing, permissions] = await Promise.all([
    readFile(resolve(sourceRepo, "config/control-center/models.json"), "utf8").then(JSON.parse),
    readFile(resolve(sourceRepo, "config/control-center/routing.json"), "utf8").then(JSON.parse),
    readFile(resolve(sourceRepo, "config/control-center/permissions.json"), "utf8").then(JSON.parse),
  ]);
  const assertInvalid = (mutate) => {
    const candidate = structuredClone(routing);
    mutate(candidate);
    assert.throws(() => validateRuntimeGraph({ models, routing: candidate, permissions }), { code: "RUNTIME_GRAPH_INVALID" });
  };
  assertInvalid((candidate) => { candidate.rules[0].prefer = ["missing-profile"]; });
  assertInvalid((candidate) => {
    candidate.rules[0].constraints = { allowedProviders: ["missing-profile"] };
  });
  assertInvalid((candidate) => {
    candidate.rules[0].reason = "   ";
    candidate.rules[0].constraints = { allowedProviders: [models.profiles[0].id] };
  });
});

test("committing core routing atomically activates a new runtime generation", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "514cc-runtime-reload-"));
  const repoRoot = resolve(root, "repo");
  const configRoot = resolve(repoRoot, "config/control-center");
  const schemaRoot = resolve(repoRoot, "schemas/control-center");
  await mkdir(configRoot, { recursive: true });
  await mkdir(schemaRoot, { recursive: true });
  for (const name of ["models.json", "routing.json", "permissions.json", "claude-coordinator.md"]) {
    await cp(resolve(sourceRepo, "config/control-center", name), resolve(configRoot, name));
  }
  await cp(resolve(sourceRepo, "schemas/control-center/contracts.schema.json"), resolve(schemaRoot, "contracts.schema.json"));
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
  }, null, 2)}\n`);
  const state = await createControlCenter({ repoRoot, dataRoot: resolve(repoRoot, ".ai-shared/control-center") });
  t.after(async () => { await state.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(state.orchestrator.adapters.has("gemini-research"), false, "disabled profiles must not retain executable adapters");

  const current = await state.configManager.read("control.routing");
  const candidateObject = JSON.parse(current.content);
  candidateObject.weights.speed = 0.15;
  candidateObject.weights.quality = 0.55;
  const candidate = `${JSON.stringify(candidateObject, null, 2)}\n`;
  const plan = await state.configManager.plan("control.routing", candidate, current.sha256);
  const result = await state.configManager.apply("control.routing", {
    content: candidate,
    baseSha256: current.sha256,
    planId: plan.planId,
    confirmation: "control.routing",
  });
  assert.equal(result.activation.status, "reloaded");
  assert.equal(state.generation, 2);
  assert.equal(state.routing.weights.speed, 0.15);

  const updated = await state.configManager.read("control.routing");
  const invalidObject = JSON.parse(updated.content);
  invalidObject.primaryCoordinator = "missing-profile";
  const invalid = `${JSON.stringify(invalidObject, null, 2)}\n`;
  const invalidPlan = await state.configManager.plan("control.routing", invalid, updated.sha256);
  await assert.rejects(
    () => state.configManager.apply("control.routing", {
      content: invalid,
      baseSha256: updated.sha256,
      planId: invalidPlan.planId,
      confirmation: "control.routing",
    }),
    { code: "RUNTIME_GRAPH_INVALID" },
  );
  assert.equal(JSON.parse(await readFile(resolve(configRoot, "routing.json"), "utf8")).primaryCoordinator, "claude-fable");

  const kimiTeam = await state.teams.create({
    name: "Kimi 热重载守卫",
    coordinator: "kimi-frontend",
    members: ["kimi-frontend"],
  });
  const modelsCurrent = await state.configManager.read("control.models");
  const modelsObject = JSON.parse(modelsCurrent.content);
  modelsObject.profiles.find((profile) => profile.id === "kimi-frontend").label = "Kimi 自定义主脑";
  const modelsCandidate = `${JSON.stringify(modelsObject, null, 2)}\n`;
  const modelsPlan = await state.configManager.plan("control.models", modelsCandidate, modelsCurrent.sha256);
  const modelsResult = await state.configManager.apply("control.models", {
    content: modelsCandidate,
    baseSha256: modelsCurrent.sha256,
    planId: modelsPlan.planId,
    confirmation: "control.models",
  });
  assert.equal(modelsResult.activation.status, "reloaded");
  assert.equal(state.generation, 3);
  assert.equal(state.teamCatalog.find((item) => item.id === "kimi-frontend")?.label, "Kimi 自定义主脑");
  assert.equal(state.orchestrator.models.profiles.find((item) => item.id === "kimi-frontend")?.label, "Kimi 自定义主脑");
  assert.equal(state.teams.get(kimiTeam.id).coordinator, "kimi-frontend");

  const liveProvider = await state.providers.create({
    name: "Live Codex Provider P1",
    baseUrl: "https://live-provider.invalid",
    apps: { claude: true, codex: true },
  });
  const candidateProvider = await state.providers.create({
    name: "Candidate Codex Provider P2",
    baseUrl: "https://candidate-provider.invalid",
    apps: { claude: true, codex: true },
  });
  const preLiveModels = await state.configManager.read("control.models");
  const liveObject = JSON.parse(preLiveModels.content);
  liveObject.profiles.push({
    ...structuredClone(liveObject.profiles.find((profile) => profile.id === "codex-technical")),
    id: "pending-provider-seat",
    builtin: false,
    label: "Pending Provider Seat",
    providerId: liveProvider.id,
  });
  const liveCandidate = `${JSON.stringify(liveObject, null, 2)}\n`;
  const livePlan = await state.configManager.plan("control.models", liveCandidate, preLiveModels.sha256);
  const liveResult = await state.configManager.apply("control.models", {
    content: liveCandidate,
    baseSha256: preLiveModels.sha256,
    planId: livePlan.planId,
    confirmation: "control.models",
  });
  assert.equal(liveResult.activation.status, "reloaded");
  assert.equal(state.generation, 4);
  assert.equal(
    state.runtimeCatalog.find((item) => item.id === "pending-provider-seat")?.providerId,
    liveProvider.id,
    "P1 must be the live provider before the deferred candidate is committed",
  );

  const prePendingModels = await state.configManager.read("control.models");
  const pendingObject = JSON.parse(prePendingModels.content);
  pendingObject.profiles.find((profile) => profile.id === "gemini-research").enabled = true;
  pendingObject.profiles.find((profile) => profile.id === "pending-provider-seat").providerId = candidateProvider.id;
  const pendingCandidate = `${JSON.stringify(pendingObject, null, 2)}\n`;
  await assert.rejects(
    () => state.configManager.apply("control.models", {
      content: pendingCandidate,
      baseSha256: prePendingModels.sha256,
      planId: "missing-plan",
      confirmation: "control.models",
    }),
    { code: "PLAN_REQUIRED" },
  );
  await assert.rejects(
    () => state.providers.remove(liveProvider.id),
    (error) => error.code === "PROVIDER_IN_USE"
      && error.references?.length === 1
      && error.references[0]?.seatId === "pending-provider-seat",
  );
  await state.providers.update(candidateProvider.id, { apps: { codex: false } });
  await state.providers.update(candidateProvider.id, { apps: { codex: true } });

  const pendingPlan = await state.configManager.plan("control.models", pendingCandidate, prePendingModels.sha256);
  const originalIsBusy = state.orchestrator.isBusy.bind(state.orchestrator);
  state.orchestrator.isBusy = () => true;
  const pendingResult = await state.configManager.apply("control.models", {
    content: pendingCandidate,
    baseSha256: prePendingModels.sha256,
    planId: pendingPlan.planId,
    confirmation: "control.models",
  });
  assert.equal(pendingResult.activation.status, "restart-required");
  assert.equal(state.generation, 4, "busy activation must retain the live generation");
  assert.equal(
    state.runtimeCatalog.find((item) => item.id === "pending-provider-seat")?.providerId,
    liveProvider.id,
    "busy activation must retain P1 in the live runtime catalog",
  );
  await assert.rejects(
    () => state.providers.remove(liveProvider.id),
    (error) => error.code === "PROVIDER_IN_USE"
      && error.references?.length === 1
      && error.references[0]?.seatId === "pending-provider-seat",
  );
  await assert.rejects(
    () => state.providers.update(liveProvider.id, { apps: { codex: false } }),
    { code: "PROVIDER_IN_USE" },
  );
  await assert.rejects(
    () => state.providers.remove(candidateProvider.id),
    (error) => error.code === "PROVIDER_IN_USE"
      && error.references?.length === 1
      && error.references[0]?.seatId === "pending-provider-seat",
  );
  await assert.rejects(
    () => state.providers.update(candidateProvider.id, { apps: { codex: false } }),
    { code: "PROVIDER_IN_USE" },
  );
  assert.equal(state.teamCatalog.find((item) => item.id === "gemini-research")?.teamMemberEligible, false);
  await assert.rejects(
    () => state.teams.create({ name: "尚未激活的 Gemini", members: ["gemini-research"], coordinator: "gemini-research" }),
    { code: "VALIDATION_FAILED" },
  );
  const stillCompatible = await state.teams.create({ name: "迁移期间 Codex", members: ["codex-technical"] });
  assert.equal(stillCompatible.coordinator, "codex-technical");
  state.orchestrator.isBusy = originalIsBusy;
  let releaseRetirement;
  let retirementEntered;
  const retirementGate = new Promise((resolveGate) => { releaseRetirement = resolveGate; });
  const retirementObserved = new Promise((resolveEntered) => { retirementEntered = resolveEntered; });
  state.orchestrator.adapters.get("grok-build").close = async () => {
    retirementEntered();
    await retirementGate;
  };
  const pendingActivationPromise = state.reloadRuntime({ reason: "test pending catalog activation" });
  await retirementObserved;
  try {
    assert.equal(state.generation, 5, "the published generation must advance before old adapters finish retiring");
    assert.equal(state.teamCatalog.find((item) => item.id === "gemini-research")?.teamMemberEligible, true);
  } finally {
    releaseRetirement();
  }
  const pendingActivation = await pendingActivationPromise;
  assert.equal(pendingActivation.status, "reloaded");
  assert.equal(state.generation, 5);
  assert.equal(state.teamCatalog.find((item) => item.id === "gemini-research")?.teamMemberEligible, true);
  assert.equal(state.orchestrator.adapters.has("gemini-research"), true, "activation must install the newly enabled adapter");
  assert.equal(
    state.runtimeCatalog.find((item) => item.id === "pending-provider-seat")?.providerId,
    candidateProvider.id,
    "successful activation must converge the live catalog on P2",
  );
  await state.providers.update(liveProvider.id, { apps: { codex: false } });
  assert.equal((await state.providers.remove(liveProvider.id)).removed, liveProvider.id, "P1 must be releasable after activation");
  await assert.rejects(
    () => state.providers.remove(candidateProvider.id),
    (error) => error.code === "PROVIDER_IN_USE"
      && error.references?.length === 1
      && error.references[0]?.seatId === "pending-provider-seat",
  );
  await assert.rejects(
    () => state.providers.update(candidateProvider.id, { apps: { codex: false } }),
    { code: "PROVIDER_IN_USE" },
  );
  const geminiTeam = await state.teams.create({ name: "Gemini 已激活", members: ["gemini-research"], coordinator: "gemini-research" });
  assert.equal(geminiTeam.coordinator, "gemini-research");

  const reloadedModels = await state.configManager.read("control.models");
  const incompatibleObject = JSON.parse(reloadedModels.content);
  incompatibleObject.profiles = incompatibleObject.profiles.filter((profile) => profile.id !== "kimi-frontend");
  const incompatible = `${JSON.stringify(incompatibleObject, null, 2)}\n`;
  const incompatiblePlan = await state.configManager.plan("control.models", incompatible, reloadedModels.sha256);
  await assert.rejects(
    () => state.configManager.apply("control.models", {
      content: incompatible,
      baseSha256: reloadedModels.sha256,
      planId: incompatiblePlan.planId,
      confirmation: "control.models",
    }),
    (error) => error.code === "TEAM_CATALOG_CONFLICT"
      && error.conflicts.some((item) => item.id === kimiTeam.id),
  );
  const readback = JSON.parse(await readFile(resolve(configRoot, "models.json"), "utf8"));
  assert.ok(readback.profiles.some((profile) => profile.id === "kimi-frontend"), "incompatible models must be rejected before write");

  const unwiredObject = structuredClone(readback);
  unwiredObject.profiles.push({
    ...structuredClone(unwiredObject.profiles.find((profile) => profile.id === "kimi-frontend")),
    id: "custom-command-only",
    label: "Command Only",
    adapter: "custom-stream-json",
    command: "custom-cli",
  });
  const unwired = `${JSON.stringify(unwiredObject, null, 2)}\n`;
  const unwiredPlan = await state.configManager.plan("control.models", unwired, reloadedModels.sha256);
  await assert.rejects(
    () => state.configManager.apply("control.models", {
      content: unwired,
      baseSha256: reloadedModels.sha256,
      planId: unwiredPlan.planId,
      confirmation: "control.models",
    }),
    { code: "ADAPTER_MANIFEST_INVALID" },
  );
  assert.ok(!JSON.parse(await readFile(resolve(configRoot, "models.json"), "utf8")).profiles.some((profile) => profile.id === "custom-command-only"));
});
