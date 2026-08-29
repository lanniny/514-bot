import { readFile } from "node:fs/promises";
import { closeChannelService } from "./channels/routes.mjs";
import { join, resolve } from "node:path";
import { EventStore } from "./event-store.mjs";
import { configureChildRegistry } from "./child-registry.mjs";
import { ConfigManager } from "./config-manager.mjs";
import { HealthService } from "./health.mjs";
import { ModelRouter } from "./router.mjs";
import { ApprovalBroker } from "./approval-broker.mjs";
import { createAdapters } from "./adapters/index.mjs";
import { createTeamCatalog, resolveAdapterTemplate } from "./adapters/manifest.mjs";
import { Orchestrator } from "./orchestrator.mjs";
import { AutomationStore, seedBuiltinAutomations } from "./automations.mjs";
import { createCapabilities } from "./capabilities.mjs";
import { ModelDiscovery } from "./model-discovery.mjs";
import { CapabilityWatcher, capabilityWatchTargets } from "./capability-watcher.mjs";
import { ObservabilityService } from "./observability.mjs";
import { SessionAggregator } from "./sessions.mjs";
import { TeamStore } from "./teams.mjs";
import { TeamMemberStore } from "./team-members.mjs";
import { ConversationStore } from "./conversations.mjs";
import { ConversationContextStore } from "./conversation-contexts.mjs";
import { ProjectRegistry } from "./projects.mjs";
import { ProviderStore } from "./providers.mjs";
import { CcSwitchProxyService } from "./ccswitch/proxy.mjs";
import { CcSwitchDomainService } from "./ccswitch/domain.mjs";
import { CcSwitchAuthService } from "./ccswitch/auth.mjs";
import { APP_ROOT, DATA_ROOT, REPO_ROOT } from "./paths.mjs";
import { acquireInstanceLock } from "./instance-lock.mjs";
import { createAnchorStore } from "./project-bridge.mjs";
import { createInboxLifecycleStore } from "./inbox-lifecycle.mjs";
import { createFirstRunDraftStore } from "./first-run-readiness.mjs";
import { createReleaseCommandEvidenceStore } from "./release-record.mjs";
import { createReleaseCommandRunner } from "./release-command-runner.mjs";
import { createRemoteGateService } from "./security/remote-gates.mjs";
import { createRemoteRunner } from "./ssh/remote-run.mjs";
import { getSshService } from "./ssh/routes.mjs";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// 关闭链统一预算默认值（烛 wave-shutdown 复审）：proxy→orchestrator→eventStore 共享
// 同一份剩余预算，不再各自独占计时叠加出无界总时长。server.mjs 可用
// CONTROL_CENTER_SHUTDOWN_BUDGET_MS 覆盖（测试 fixture 收紧到 5s 退出窗口内）。
export const DEFAULT_CLOSE_BUDGET_MS = 8_000;

function closeTimeoutError(step, deadline) {
  const remainingMs = Math.max(0, deadline - Date.now());
  return Object.assign(
    new Error(`Control Center close step ${step} exceeded its remaining shutdown budget (${remainingMs}ms left)`),
    {
      code: "CONTROL_CENTER_CLOSE_TIMEOUT",
      step,
      deadline,
    },
  );
}

async function settleCloseStep(operation, deadline, step) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw closeTimeoutError(step, deadline);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(closeTimeoutError(step, deadline)), remainingMs);
  });
  try {
    return await Promise.race([
      typeof operation === "function" ? Promise.resolve().then(operation) : Promise.resolve(operation),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const HOT_RELOAD_SOURCES = new Set([
  "control.models",
  "control.routing",
  "control.permissions",
  "control.claude-coordinator",
]);

async function readRuntimeConfig(repoRoot) {
  const configRoot = join(repoRoot, "config", "control-center");
  const [models, routing, permissions] = await Promise.all([
    readJson(join(configRoot, "models.json")),
    readJson(join(configRoot, "routing.json")),
    readJson(join(configRoot, "permissions.json")),
  ]);
  validateRuntimeGraph({ models, routing, permissions });
  return { configRoot, models, routing, permissions };
}

export function validateRuntimeGraph({ models, routing, permissions }) {
  const ids = models.profiles.map((profile) => profile.id);
  if (new Set(ids).size !== ids.length) throw Object.assign(new Error("model profile ids must be unique"), { code: "RUNTIME_GRAPH_INVALID" });
  const known = new Set(ids);
  for (const id of [routing.primaryCoordinator, routing.technicalExecutor]) {
    if (!known.has(id)) throw Object.assign(new Error(`routing references unknown profile ${id}`), { code: "RUNTIME_GRAPH_INVALID" });
  }
  for (const rule of routing.rules || []) {
    for (const id of rule.prefer || []) {
      if (!known.has(id)) throw Object.assign(new Error(`routing rule ${rule.id} references unknown profile ${id}`), { code: "RUNTIME_GRAPH_INVALID" });
    }
    const constrained = rule.constraints?.allowedProviders;
    if (rule.constraints && (!String(rule.reason || "").trim() || !Array.isArray(constrained) || !constrained.length)) {
      throw Object.assign(new Error(`special routing rule ${rule.id} requires a reason and allowedProviders`), { code: "RUNTIME_GRAPH_INVALID" });
    }
    for (const id of constrained || []) {
      if (!known.has(id)) throw Object.assign(new Error(`routing rule ${rule.id} constrains unknown profile ${id}`), { code: "RUNTIME_GRAPH_INVALID" });
    }
  }
  if (permissions.modes?.build?.approvalRequired !== true) {
    throw Object.assign(new Error("build mode must remain approval-bound"), { code: "RUNTIME_GRAPH_INVALID" });
  }
  if (Number(permissions.limits?.maxRounds) < 3) {
    throw Object.assign(new Error("permission maxRounds must allow planner, executor and verifier"), { code: "RUNTIME_GRAPH_INVALID" });
  }
  const maxBudgetUsdPerTurn = Number(permissions.limits?.maxBudgetUsdPerTurn);
  const defaultBudgetUsdPerTurn = permissions.limits?.defaultBudgetUsdPerTurn == null
    ? null
    : Number(permissions.limits.defaultBudgetUsdPerTurn);
  if (!Number.isFinite(maxBudgetUsdPerTurn) || maxBudgetUsdPerTurn < 0.05 || maxBudgetUsdPerTurn > 50) {
    throw Object.assign(new Error("permission maxBudgetUsdPerTurn must be between 0.05 and 50"), { code: "RUNTIME_GRAPH_INVALID" });
  }
  if (defaultBudgetUsdPerTurn != null
    && (!Number.isFinite(defaultBudgetUsdPerTurn)
      || defaultBudgetUsdPerTurn < 0.05
      || defaultBudgetUsdPerTurn > maxBudgetUsdPerTurn)) {
    throw Object.assign(new Error("permission defaultBudgetUsdPerTurn must be between 0.05 and maxBudgetUsdPerTurn"), { code: "RUNTIME_GRAPH_INVALID" });
  }
}

export function createRuntimeMemberCatalog(profiles = [], { providerStore = null } = {}) {
  const executableCatalog = createTeamCatalog(profiles, { providerStore });
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  return executableCatalog.map((entry) => {
    const profile = profileById.get(entry.id) || {};
    const { adapterTemplate } = resolveAdapterTemplate(profile);
    const modelOptions = (profile.modelOptions || []).map((option) => (
      typeof option === "string" ? { id: option, label: option } : { ...option }
    ));
    const defaultModel = profile.defaultModel ?? profile.model ?? null;
    if (defaultModel && !modelOptions.some((option) => option.id === defaultModel)) {
      modelOptions.push({ id: defaultModel, label: defaultModel });
    }
    const effortLevels = [...new Set([
      ...(profile.effortLevels || []),
      ...(adapterTemplate.effortLevels || []),
    ])];
    return Object.freeze({
      ...entry,
      shortLabel: String(profile.shortLabel || profile.label || entry.label || entry.id),
      description: String(profile.description || ""),
      systemPrompt: String(profile.systemPrompt || ""),
      capabilities: Object.freeze(["*"]),
      defaultModel,
      defaultEffort: profile.defaultEffort ?? null,
      command: profile.command ?? null,
      model: profile.model ?? null,
      defaultPermissionMode: profile.defaultPermissionMode ?? "read-only",
      quality: profile.quality ?? null,
      speed: profile.speed ?? null,
      costTier: profile.costTier ?? null,
      modelOptions: Object.freeze(modelOptions.map((option) => Object.freeze(option))),
      effortLevels: Object.freeze(effortLevels),
    });
  });
}

function createRuntimeComponents({ models, routing, permissions, eventStore, repoRoot, approvalBroker, providerStore }) {
  // Provider 绑定降级（席位引用的连接当前环境解析不到）：席位按 Adapter 管理继续运行，
  // 同时留下显眼痕迹——控制台 + 事件流（catalog 条目另有 providerDegraded 供 UI 展示）。
  const onProviderDegraded = (info) => {
    console.error(`[control-plane] runtime seat ${info.runtimeProfileId} provider binding degraded: ${info.providerId} (${info.reason}) — running adapter-managed`);
    eventStore?.emit?.(
      "control.provider_binding_degraded",
      info,
      { sensitivity: "internal", agentId: "control-plane" },
    )?.catch?.(() => {});
  };
  const adapters = createAdapters({
    profiles: models.profiles,
    eventStore,
    cwd: repoRoot,
    approvalResolver: (message, context) => approvalBroker.request(message, context),
    providerStore,
    onProviderDegraded,
  });
  const externalProbes = new Map();
  for (const profile of models.profiles) {
    const adapter = adapters.get(profile.id);
    if (typeof adapter?.health === "function") {
      externalProbes.set(profile.id, (_profile, { signal } = {}) => adapter.health({ signal }));
    }
  }
  const healthService = new HealthService(models.profiles, { externalProbes });
  const router = new ModelRouter({ profiles: models.profiles, policy: routing, healthService });
  const runtimeCatalog = createRuntimeMemberCatalog(models.profiles, { providerStore });
  return { models, routing, permissions, adapters, healthService, router, runtimeCatalog };
}

async function closeCandidateAdapters(adapters, timeoutMs = 10_000) {
  const warnings = [];
  await Promise.all([...new Set(adapters?.values?.() ?? [])].map(async (adapter) => {
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => adapter.close?.()).then(() => null, (error) => error),
        new Promise((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(new Error(`candidate adapter close timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      if (result) warnings.push(result.message || String(result));
    } finally {
      clearTimeout(timer);
    }
  }));
  return warnings;
}

export async function createControlCenter(options = {}) {
  const repoRoot = resolve(options.repoRoot || REPO_ROOT);
  const dataRoot = resolve(options.dataRoot || DATA_ROOT);
  // 实例锁域 = dataRoot（烛建议2：锁与 children.json 台账同命名空间）。默认 dataRoot 就在
  // <repoRoot>/.ai-shared/control-center，生产行为不变；显式分 dataRoot 的实例（测试/多开）自然分域
  const instanceLock = await acquireInstanceLock(dataRoot, { repoRoot, dataRoot });
  try {
  // 孤儿收割：实例锁在手即旧主已死——台账里的子进程（codex app-server/MCP 孙子等）连树清理，
  // 防强制重启残留内存堆叠（2026-07-19 LO 报障，含 pid 复用防护）
  const childReg = configureChildRegistry({ dataRoot });
  const { reaped, skipped, failed = 0, pending = 0 } = await childReg.reapPrevious();
  if (reaped || skipped || failed || pending) {
    const guarded = Math.max(0, skipped - failed);
    process.stdout.write(`control-center: previous children reaped=${reaped} guarded=${guarded} failed=${failed} pending=${pending}\n`);
  }
  const { configRoot, models, routing, permissions } = await readRuntimeConfig(repoRoot);
  const eventStore = await new EventStore(join(dataRoot, "events.jsonl"), options.eventStoreOptions).init();
  // Provider 连接先于运行图加载：席位只保存 providerId，凭据仍由 ProviderStore 私有持有。
  let providerReferenceCatalogs = { live: [], candidate: null };
  const providerStore = await new ProviderStore({
    dataRoot,
    eventStore,
    referencesForProvider: async (providerId) => {
      const references = new Map();
      for (const catalog of [providerReferenceCatalogs.live, providerReferenceCatalogs.candidate]) {
        for (const seat of catalog ?? []) {
          if (seat.providerId !== providerId) continue;
          const reference = { seatId: seat.id, providerApp: seat.providerApp };
          references.set(JSON.stringify([reference.seatId, reference.providerApp]), reference);
        }
      }
      return [...references.values()];
    },
  }).init();
  // Wave G v2：授权感知门闸（grant 账本 + 实现注册表）。各面路由注册时 registerImplementation。
  const remoteGates = await createRemoteGateService({ dataRoot, eventStore }).init();
  const approvalBroker = new ApprovalBroker({ eventStore, ttlMs: permissions.approval.ttlMs });
  const runtime = createRuntimeComponents({ models, routing, permissions, eventStore, repoRoot, approvalBroker, providerStore });
  providerReferenceCatalogs = { live: runtime.runtimeCatalog, candidate: null };
  // 运行席位与逻辑成员分层：adapter manifest 仍是执行真源；成员库只绑定真实席位并承载人物元数据。
  const runtimeCatalogRef = { current: runtime.runtimeCatalog };
  let teams = null;
  let projects = null;
  let conversations = null;
  let conversationContexts = null;
  const teamMembers = await new TeamMemberStore({
    dataRoot,
    runtimeCatalog: () => runtimeCatalogRef.current,
    referencesForMember: async (memberId) => [
      ...(teams?.referencesForMember(memberId) ?? []),
      ...(conversations?.referencesForMember(memberId) ?? []),
    ],
    guardMemberMutation: async (memberId, mutation) => {
      if (!teams) throw Object.assign(new Error("team store is not ready"), { code: "TEAM_STORE_UNAVAILABLE" });
      const guardTeams = () => teams.withMemberReferenceGuard(memberId, mutation);
      return conversations
        ? conversations.withMemberReferenceGuard(memberId, guardTeams)
        : guardTeams();
    },
    beginCatalogTransition: async (catalog, transitionOptions = {}) => {
      if (!teams) throw Object.assign(new Error("team store is not ready"), { code: "TEAM_STORE_UNAVAILABLE" });
      return teams.beginCatalogTransition(catalog, transitionOptions);
    },
  }).init();
  teamMembers.assertRuntimeCompatible(runtime.runtimeCatalog);
  teams = await new TeamStore({
    dataRoot,
    teamCatalog: () => teamMembers.list(),
  }).init();
  teams.assertCatalogCompatible(teamMembers.list());
  projects = await new ProjectRegistry({ dataRoot }).init();
  conversations = await new ConversationStore({ dataRoot, projects }).init();
  conversationContexts = await new ConversationContextStore({ dataRoot }).init();
  // cc-switch 迁移：统一供应商档案（baseUrl+apiKey 一处录入，按 app 投影 live 配置）；
  // runtimeHome 默认 homedir()，测试/隔离环境走 CONTROL_CENTER_RUNTIME_HOME
  const ccswitchProxy = await new CcSwitchProxyService({ dataRoot, providerStore, eventStore }).init();
  const ccswitchAuth = await new CcSwitchAuthService({ dataRoot }).init();
  const ccswitchDomain = await new CcSwitchDomainService({ dataRoot, providerStore, eventStore, authService: ccswitchAuth }).init();
  const modelDiscovery = new ModelDiscovery({ profiles: models.profiles });
  // T4：外部 CLI 配置变更感知（~/.grok/config.toml 等）。watch 事件驱动，经既有
  // eventStore → /api/events SSE 管道推送 capability.changed；payload 只带键名与哈希，
  // 配置文件内容/密钥永不进事件流。清单路径复用 ProviderStore.liveConfigTargets()。
  const capabilityWatcher = new CapabilityWatcher({
    targets: capabilityWatchTargets(providerStore.runtimeHome)
      .filter((entry) => providerStore.liveConfigTargets().some((target) => target.path === entry.path && !target.credential)),
    onChanged: async (change) => {
      if (closed) return;
      modelDiscovery.invalidate(change.runtimeProfileId);
      try {
        await eventStore.emit("capability.changed", {
          runtimeProfileId: change.runtimeProfileId,
          changedKeys: change.changedKeys,
          degraded: change.degraded === true,
          changedAt: change.at,
        }, { sensitivity: "internal", agentId: "control-plane" });
      } catch {
        // 事件库关闭竞态：监听本身继续收尾，不阻止应用关闭
      }
    },
  });
  capabilityWatcher.start();
  let configManager = null;
  const capabilities = createCapabilities({
    repoRoot,
    homeDir: process.env.USERPROFILE ?? process.env.HOME ?? null,
    teamsStore: teams,
    membersStore: teamMembers,
    dataRoot,
    eventStore,
    sourceIdForPath: (path) => configManager?.sourceIdForPath(path) ?? null,
  });
  const orchestrator = await new Orchestrator({
    router: runtime.router,
    adapters: runtime.adapters,
    eventStore,
    dataRoot,
    policy: permissions,
    approvalBroker,
    teams,
    teamMembers,
    projects,
    conversations,
    conversationContexts,
    models: runtime.models, // modelOptions 目录：/model 覆盖按起始 agent 校验（v3.6 P2）
    modelDiscovery, // 动态模型/档位发现（codex debug models / grok models，5min 缓存）
    capabilities, // agent skill 启停负名单：成员轮提示词 skill 声明按此过滤（LO 拍板可配置面）
    repoRoot, // v41：远程 adapter 工厂表 assertWithin 锚点
    // v41 波二：远程 run 桥——懒解析 ssh service 单例（registerSshRoutes 建），ssh 门闸随 assertRunnable
    remoteRunner: createRemoteRunner({ getService: getSshService, gates: remoteGates }),
  }).init();
  let generation = 1;
  let closed = false;
  let closeFailure = null;
  let closePromise = null;
  let closeResult = null;
  // 每个关闭步骤只启动一次；超时后下一次 close() 继续等待同一 Promise，避免
  // 对仍在运行的资源操作重复发起并发清理。已拒绝的步骤会在下一次尝试重新创建。
  const closeTasks = new Map();
  let state;
  configManager = await new ConfigManager({
    repoRoot,
    dataRoot,
    registryPath: join(configRoot, "sources.json"),
    eventStore,
    beforeCommit: async ({ sourceId, content }) => {
      if (!["control.models", "control.routing", "control.permissions"].includes(sourceId)) return;
      const candidate = await readRuntimeConfig(repoRoot);
      if (sourceId === "control.models") candidate.models = JSON.parse(content);
      if (sourceId === "control.routing") candidate.routing = JSON.parse(content);
      if (sourceId === "control.permissions") candidate.permissions = JSON.parse(content);
      validateRuntimeGraph(candidate);
      if (sourceId === "control.models") {
        // 配置事务在写盘前同时验证 adapter wiring 与所有已存团队。ConfigManager 的
        // onCommitted 是提交后激活，不能把这种冲突留到那一步才发现。
        const candidateRuntimeCatalog = createRuntimeMemberCatalog(candidate.models.profiles, { providerStore });
        teamMembers.assertRuntimeCompatible(candidateRuntimeCatalog);
        const catalogTransition = await teams.beginCatalogTransition(teamMembers.catalogForRuntime(candidateRuntimeCatalog));
        const previousProviderReferences = providerReferenceCatalogs;
        // Provider 写操作必须从 models 写盘开始就同时看见 live 与候选引用。若热重载因繁忙延期，
        // 两个代际都继续受保护；只有提交失败才恢复进入事务前的候选状态。
        const transitionProviderReferences = {
          live: previousProviderReferences.live,
          candidate: candidateRuntimeCatalog,
        };
        providerReferenceCatalogs = transitionProviderReferences;
        return {
          async release(outcome) {
            if (outcome?.committed !== true && providerReferenceCatalogs === transitionProviderReferences) {
              providerReferenceCatalogs = previousProviderReferences;
            }
            await catalogTransition.release(outcome);
          },
        };
      }
    },
    onCommitted: async ({ sourceId }) => {
      if (sourceId === "control.permissions") await orchestrator.revokeBuildGrants("permission policy changed");
      if (sourceId === "control.sources") {
        return { status: "restart-required", reason: "the source registry is loaded during control-plane startup" };
      }
      if (!HOT_RELOAD_SOURCES.has(sourceId)) return { status: "not-required", generation };
      return state.reloadRuntime({
        sourceId,
        reason: "configuration commit",
        catalogGuarded: sourceId === "control.models",
      });
    },
  }).init();

  const aiSharedRoot = join(repoRoot, ".ai-shared");
  const observability = new ObservabilityService({ aiSharedRoot, repoRoot });
  const sessions = new SessionAggregator({ aiSharedRoot });
  // v3.7 Automations：composer 快照定时/手动 headless 执行（走 orchestrator 全治理链）。
  // pulseProvider 惰性引用 state.collectPulse（server 层组装 observability+runtime 双面数据）
  const automations = await new AutomationStore({
    dataRoot,
    orchestrator,
    eventStore,
    pulseProvider: () => state?.collectPulse?.() ?? null,
  }).init();
  // 损坏/不可读库保持 degraded 供 API 诊断，绝不让内置播种覆盖原文件；缺文件仍是
  // 正常首次初始化，会在播种时原子创建。
  if (automations.status().writable) {
    await seedBuiltinAutomations(automations); // 内置「体系体检」播种（幂等，manual 不产生费用）
    automations.start();
  }

  let reloadInProgress = false;
  // state getter 内部引用 state 自身的惰性句柄（releaseCommandRunner 需要 evidenceStore）。
  const app = { lazy: {} };
  state = {
    repoRoot,
    dataRoot,
    observability,
    sessions,
    automations,
    capabilities,
    providers: providerStore,
    ccswitchProxy,
    ccswitchDomain,
    ccswitchAuth,
    teams,
    teamMembers,
    projects,
    conversations,
    conversationContexts,
    get teamCatalog() { return teamMembers.list(); },
    get runtimeCatalog() { return runtimeCatalogRef.current; },
    models: runtime.models,
    routing: runtime.routing,
    permissions: runtime.permissions,
    eventStore,
    childRegistry: childReg,
    remoteGates,
    healthService: runtime.healthService,
    router: runtime.router,
    approvalBroker,
    orchestrator,
    configManager,
    modelDiscovery,
    capabilityWatcher,
    get generation() { return generation; },
    get pid() { return process.pid; },
    get startedAt() { return instanceLock.owner.startedAt; },
    projectAnchors: createAnchorStore(),
    inboxLifecycle: createInboxLifecycleStore({ dataRoot }),
    firstRunDraft: createFirstRunDraftStore({ dataRoot }),
    releaseCommandEvidence: createReleaseCommandEvidenceStore({ dataRoot }),
    get releaseCommandRunner() {
      // 惰性构建：runner 需要 evidenceStore 引用，而本对象字面量尚未构造完成。
      app.lazy.releaseCommandRunner ??= createReleaseCommandRunner({
        appRoot: options.appRoot ? resolve(options.appRoot) : APP_ROOT,
        evidenceStore: state.releaseCommandEvidence,
        collectRuntimeIdentity: () => ({
          pid: state.pid,
          generation: state.generation,
          startedAt: state.startedAt,
        }),
      });
      return app.lazy.releaseCommandRunner;
    },
    async reloadRuntime({ sourceId = "manual", reason = "manual reload", catalogGuarded = false } = {}) {
      const releaseAttempt = app.lazy.releaseCommandRunner?.snapshot().active;
      if (releaseAttempt) {
        return {
          status: "restart-required",
          generation,
          reason: `release QA runner ${releaseAttempt.runId} is active`,
        };
      }
      if (reloadInProgress) {
        return {
          status: "restart-required",
          generation,
          reason: "another runtime reload is already in progress",
        };
      }
      reloadInProgress = true;
      let catalogGuard = null;
      let activation = null;
      let next = null;
      let swapped = false;
      try {
        if (catalogGuarded) {
          const nextConfig = await readRuntimeConfig(repoRoot);
          next = createRuntimeComponents({ ...nextConfig, eventStore, repoRoot, approvalBroker, providerStore });
          teamMembers.assertRuntimeCompatible(next.runtimeCatalog);
          teams.assertCatalogCompatible(teamMembers.catalogForRuntime(next.runtimeCatalog));
        } else {
          // 先占用团队目录迁移门，再读盘。否则 models 提交可能在 read 与 swap 之间插入，
          // 让手动 reload 用旧快照覆盖刚提交的新目录。
          catalogGuard = await teams.beginCatalogTransition(async () => {
            const nextConfig = await readRuntimeConfig(repoRoot);
            next = createRuntimeComponents({ ...nextConfig, eventStore, repoRoot, approvalBroker, providerStore });
            teamMembers.assertRuntimeCompatible(next.runtimeCatalog);
            return teamMembers.catalogForRuntime(next.runtimeCatalog);
          });
        }
        if (orchestrator.isBusy() || approvalBroker.list().length) {
          const candidateCloseWarnings = await closeCandidateAdapters(next.adapters);
          activation = {
            status: "restart-required",
            generation,
            reason: "active runs or approvals prevent an atomic runtime graph swap",
            candidateCloseWarnings,
          };
          return activation;
        }
        const retirement = orchestrator.swapRuntime({
          router: next.router,
          adapters: next.adapters,
          policy: next.permissions,
          models: next.models,
        });
        swapped = true;
        // swapRuntime 在返回 retirement promise 前已同步替换 Orchestrator 指针；同一 tick
        // 发布 state/catalog/generation，之后才等待旧 adapter 退役，避免代际可观测分裂。
        approvalBroker.ttlMs = next.permissions.approval.ttlMs;
        runtimeCatalogRef.current = next.runtimeCatalog;
        providerReferenceCatalogs = { live: next.runtimeCatalog, candidate: null };
        state.models = next.models;
        state.modelDiscovery.profiles = next.models.profiles; // 动态发现的静态回退随热重载刷新
        state.modelDiscovery.cache.clear();
        state.routing = next.routing;
        state.permissions = next.permissions;
        state.healthService = next.healthService;
        state.router = next.router;
        generation += 1;
        const closeWarnings = await retirement;
        await eventStore.emit(
          "control.runtime_reloaded",
          { generation, sourceId, reason, closeWarnings },
          { sensitivity: "internal", agentId: "control-plane" },
        ).catch(() => {});
        activation = { status: "reloaded", generation, closeWarnings };
        return activation;
      } catch (error) {
        if (next && !swapped) {
          const warnings = await closeCandidateAdapters(next.adapters);
          if (warnings.length) error.candidateCloseWarnings = warnings;
        }
        throw error;
      } finally {
        // 只有明确发布成功或已完成 swap 才提交候选目录。swapRuntime 之前失败时，
        // pending catalog 必须回到上一个值，否则团队写入会被一代未激活的目录卡死。
        const catalogCommitted = Boolean(activation?.status === "reloaded" || swapped);
        await catalogGuard?.release({
          committed: catalogCommitted,
          activation: activation ?? (swapped ? { status: "reloaded" } : null),
        });
        reloadInProgress = false;
      }
    },
    async close({ budgetMs = DEFAULT_CLOSE_BUDGET_MS, deadlineMs = null, onPhase = null } = {}) {
      if (closed) {
        return closeResult || {
          schema: "514cc.close-result/v1",
          closed: true,
          idempotent: true,
          retryable: false,
          phases: [],
        };
      }
      if (closePromise) return closePromise;
      const resumeAutomations = Boolean(automations.timer);
      closePromise = (async () => {
        // 统一 shutdown deadline：所有阶段共享同一份剩余预算。onPhase 逐阶段上报耗时，
        // 关闭超时/失败时能定位到具体阶段，而不是只剩一句“优雅关闭超时”。
        const budgetDeadline = Date.now() + Math.max(500, Number(budgetMs) || DEFAULT_CLOSE_BUDGET_MS);
        const requestedDeadline = Number(deadlineMs);
        const deadline = Number.isFinite(requestedDeadline) && requestedDeadline > 0
          ? Math.min(budgetDeadline, requestedDeadline)
          : budgetDeadline;
        const phases = [];
        const reportPhase = (step, startedAt, error = null) => {
          const entry = {
            step,
            ms: Date.now() - startedAt,
            ok: !error,
            code: error?.code ?? null,
            remainingMs: Math.max(0, deadline - Date.now()),
          };
          phases.push(entry);
          if (typeof onPhase !== "function") return;
          try { onPhase(entry); } catch {}
        };
        const runCloseStep = async (step, operation) => {
          let task = closeTasks.get(step);
          if (task?.status === "rejected") {
            closeTasks.delete(step);
            task = null;
          }
          if (!task) {
            task = { status: "pending" };
            task.promise = Promise.resolve()
              .then(operation)
              .then(
                (value) => {
                  task.status = "fulfilled";
                  return value;
                },
                (error) => {
                  task.status = "rejected";
                  throw error;
                },
              );
            closeTasks.set(step, task);
          }
          return settleCloseStep(task.promise, deadline, step);
        };

        let phaseAt = Date.now();
        try {
          await runCloseStep("automations.stop", () => automations.stop()); // 先停调度器：关闭窗口不再产生新 run
          reportPhase("automations.stop", phaseAt);
        } catch (error) {
          reportPhase("automations.stop", phaseAt, error);
          if (resumeAutomations) automations.start();
          closeTasks.delete("automations.stop");
          throw error;
        }
        let proxyStatus;
        try {
          phaseAt = Date.now();
          proxyStatus = await runCloseStep("ccswitchProxy.close", async () => {
            const status = await ccswitchProxy.close();
            if (status?.closed !== true) {
              throw Object.assign(
                new Error("Control Center close aborted because CC-Switch takeover restore is incomplete"),
                {
                  code: "CONTROL_CENTER_CLOSE_INCOMPLETE",
                  proxyStatus: status ?? null,
                },
              );
            }
            return status;
          });
          reportPhase("ccswitchProxy.close", phaseAt);
        } catch (error) {
          reportPhase("ccswitchProxy.close", phaseAt, error);
          if (resumeAutomations) automations.start();
          closeTasks.delete("automations.stop");
          throw error;
        }

        // Proxy restore is the shutdown commit point. Before it succeeds, the instance lock and
        // every other runtime service remain live so a failed close can be retried safely.
        const cleanupErrors = [];
        // Orchestrator/event-store may drain provider chains. Reserve a small finalization window
        // for lock/channel cleanup so a long-running run cannot consume the entire close budget.
        const finalizationReserveMs = Math.min(250, Math.max(0, deadline - Date.now()));
        const resourceDeadline = Math.max(Date.now() + 1, deadline - finalizationReserveMs);
        const cleanupSteps = [
          // 先摘配置监听：关闭窗口内不再产生 capability.changed，避免与 eventStore.close 竞态
          ["capabilityWatcher.stop", () => capabilityWatcher.stop()],
          ...(app.lazy.releaseCommandRunner
            ? [["releaseCommandRunner.close", () => app.lazy.releaseCommandRunner.close()]]
            : []),
          ["approvalBroker.denyAll", () => approvalBroker.denyAll()],
          ["orchestrator.close", () => orchestrator.close({ deadlineMs: resourceDeadline })],
          ["conversationContexts.close", () => conversationContexts.close()],
          ["conversations.close", () => conversations.close()],
          ["projects.close", () => projects.close()],
          ["eventStore.close", () => eventStore.close({ deadlineMs: resourceDeadline })],
          ["childRegistry.flush", () => childReg.flush()],
          ["channels.close", () => closeChannelService()],
          ["instanceLock.release", () => instanceLock.release()],
        ];
        for (const [step, operation] of cleanupSteps) {
          const stepStarted = Date.now();
          try {
            await runCloseStep(step, operation);
            reportPhase(step, stepStarted);
          } catch (error) {
            reportPhase(step, stepStarted, error);
            cleanupErrors.push({
              step,
              code: error?.code ?? null,
              message: String(error?.message || error),
              error,
            });
          }
        }
        if (cleanupErrors.length) {
          closeFailure = Object.assign(
            new AggregateError(
              cleanupErrors.map((entry) => entry.error),
              `Control Center cleanup failed: ${cleanupErrors.map((entry) => entry.step).join(", ")}`,
            ),
            {
              code: "CONTROL_CENTER_CLOSE_FAILED",
              retryable: true,
              phases,
              cleanupErrors: cleanupErrors.map(({ step, code, message }) => ({ step, code, message })),
            },
          );
          throw closeFailure;
        }
        closed = true;
        closeFailure = null;
        closeResult = {
          schema: "514cc.close-result/v1",
          closed: true,
          idempotent: false,
          retryable: false,
          phases,
        };
        return closeResult;
      })();
      try {
        return await closePromise;
      } finally {
        if (!closed) closePromise = null;
      }
    },
  };
  return state;
  } catch (error) {
    await instanceLock.release();
    throw error;
  }
}
