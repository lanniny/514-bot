#!/usr/bin/env node

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createStaticServer } from "./src/static-assets.mjs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createControlCenter } from "./src/app.mjs";
import { createShutdownController, shouldSetShutdownFailureExitCode } from "./src/shutdown.mjs";
import { normalizeRequestedAgentIds, resolveStartAgentId } from "./src/orchestrator.mjs";
import { runDiffForRun } from "./src/run-diff.mjs";
import {
  checkReachability,
  defaultBillingProbe,
  fetchProviderModels,
  parseDeeplink,
  queryProviderUsage,
  queryUsageScript,
  testEndpoints,
  testModelRequest,
  USAGE_TEMPLATES,
} from "./src/provider-net.mjs";
import { PROVIDER_APPS } from "./src/providers.mjs";
import { adapterTemplateCatalog } from "./src/adapters/manifest.mjs";
import { childProcessEnv, runProcess } from "./src/process-runner.mjs";
import { createAgentControlActionRunner } from "./src/agent-actions.mjs";
import { buildNativeSettings, hasNativeSettingsAgent } from "./src/cli-config-panel.mjs";
import { ResponseLeaseLimiter } from "./src/response-limiter.mjs";
import { collectPulseSnapshot } from "./src/pulse.mjs";
import { handleHealthz, handleReadyz, createReadinessChecker, traceIdFromRequest, collectCrashSnapshot, writeCrashSnapshot } from "./src/observability-probes.mjs";
import { eventForUi } from "./src/event-view.mjs";
import { EVENT_ENVELOPE_SCHEMA, EVENT_PROTOCOL_FAULT_TYPE, SUPPORTED_EVENT_SCHEMA_VERSIONS, unsupportedEventEnvelope } from "./public/modules/event-protocol.js";
import { auditBusDiagnostics, MISSION_CONTROL_LIMITS, projectMissionControl } from "./src/mission-control.mjs";
import { collectTeamInbox, INBOX_LIMITS } from "./src/collaboration-inbox.mjs";
import { collectTeamAttention } from "./src/team-attention.mjs";
import {
  inspectRunWorkspace,
  updateRunWorkspaceFile,
  WORKSPACE_EXPLORER_LIMITS,
} from "./src/workspace-explorer.mjs";
import { collectWorkbenchEnvironment, GitActionBroker } from "./src/workbench-environment.mjs";
import { collectReleaseTruth } from "./src/release-truth.mjs";
import { collectReleaseRecord, summarizeServerObservedValidation } from "./src/release-record.mjs";
import { collectOpsMetrics } from "./src/ops-metrics.mjs";
import { collectProjectBridge } from "./src/project-bridge.mjs";
import { projectRunReplay } from "./src/run-replay.mjs";
import { collectRunEvidenceArtifacts } from "./src/run-artifacts.mjs";
import { collectRunSettlement } from "./src/run-settlement.mjs";
import { collectFirstRunReadiness } from "./src/first-run-readiness.mjs";
import { attestRunWorkspace, resolveRunWorkspace } from "./src/run-workspace.mjs";
import { normalizeRunSources, publicSourceEntries, redactSourcePaths as redactPublicSourcePaths, visualSourceType } from "./src/run-sources.mjs";
import {
  cleanupClipboardImages,
  MAX_CLIPBOARD_IMAGE_REQUEST_BYTES,
  saveClipboardImage,
} from "./src/clipboard-attachment.mjs";
import { claimPendingClipboardUpload } from "./src/clipboard-lifecycle.mjs";
import { SearchService } from "./src/search.mjs";
import { MemoryService } from "./src/memory.mjs";
import { createGuardrailsService } from "./src/guardrails.mjs";
import { createWeeklyReportService } from "./src/weekly-report.mjs";
import { createMonthlyBudgetService } from "./src/monthly-budget.mjs";
import { createSecretSweepService } from "./src/secret-sweep.mjs";
import { compareRuns, renderCompareMarkdown } from "./src/run-compare.mjs";
import { renderDiffMarkdown } from "./src/run-diff.mjs";
import { scaffoldProject, scaffoldRemoteProject } from "./src/bootstrap.mjs";
import { createAvatarStore, MAX_AVATAR_REQUEST_BYTES, MAX_TEAM_BACKGROUND_REQUEST_BYTES } from "./src/avatars.mjs";
import { registerChannelsRoutes } from "./src/channels/routes.mjs";
import { getSshService, registerSshRoutes } from "./src/ssh/routes.mjs";
import { registerRemoteProjectRoutes } from "./src/remote-projects/routes.mjs";
import { registerOfficeRoutes } from "./src/office/routes.mjs";
import { registerPtyRoutes, getPtyServiceFor } from "./src/pty/routes.mjs";
import { registerMarketRoutes } from "./src/market/routes.mjs";
import { registerCcSwitchRoutes } from "./src/ccswitch/routes.mjs";
import { registerCliEnvRoutes } from "./src/cli-env/routes.mjs";
import { registerHooksRoutes } from "./src/hooks/routes.mjs";
import { homedir } from "node:os";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(appRoot, "public");

// 内核致命错误兜底（桌面端把内核 stderr 设成 Stdio::null，且 Node 15+ 默认把 unhandledRejection
// 当致命错误直接退出进程——桌面端 supervisor 检测到 stdout EOF 就 app.exit(1)，整窗闪退且零痕迹）。
// 这里把致命错误落到文件，并把 unhandledRejection 从"默认崩溃"降级为"记录不退出"——
// 未处理的 rejection 大多不是同步状态损坏，不值得为此整窗闪退。
function logKernelFatal(kind, error) {
  try {
    const root = process.env.CC_ROOT || appRoot;
    const file = join(root, ".scratch", "control-center-fatal.log");
    const detail = error instanceof Error ? (error.stack || error.message) : String(error);
    appendFileSync(file, `${new Date().toISOString()} [${kind}] ${detail}\n`, "utf8");
  } catch {
    // 日志路径不可写时静默，不能再抛一次
  }
}
process.on("uncaughtException", (error) => {
  logKernelFatal("uncaughtException", error);
  // F-063 崩溃快照：uncaughtException 时写 JSON 诊断文件（同步，写完再退出）
  try {
    const snapshot = collectCrashSnapshot({ pid: process.pid });
    writeCrashSnapshot(snapshot, join(process.env.CC_ROOT || appRoot, ".scratch", "crash-snapshots"));
  } catch { /* 崩溃路径不能再抛 */ }
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logKernelFatal("unhandledRejection", reason);
});
// cc-switch 3.18 预设供应商目录（src/data/provider-presets.json，转换自官方 *ProviderPresets.ts）
let providerPresetsCache = null;
async function loadProviderPresets() {
  if (!providerPresetsCache) {
    providerPresetsCache = JSON.parse(await readFile(join(appRoot, "src", "data", "provider-presets.json"), "utf8"));
  }
  return providerPresetsCache;
}
function maskSensitivePreview(value) {
  if (Array.isArray(value)) return value.map(maskSensitivePreview);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/^(api[_-]?key|token|password|secret|access[_-]?token|refresh[_-]?token)$/i.test(key) && typeof entry === "string" && entry) {
      result[key] = entry.length > 4 ? `••••${entry.slice(-4)}` : "••••";
    } else result[key] = maskSensitivePreview(entry);
  }
  return result;
}
const token = process.env.CONTROL_CENTER_TOKEN || randomBytes(32).toString("base64url");
// W3.15 只读观察者模式：设置 CONTROL_CENTER_OBSERVER_TOKEN 后，第二设备/移动端可用该
// token 建立只读看板——观察者 token 可过 /api 鉴权门，但仅限幂等方法（GET/HEAD），
// 任何写操作一律 403 OBSERVER_READ_ONLY。未设置该环境变量时观察者通道完全不存在。
const observerToken = process.env.CONTROL_CENTER_OBSERVER_TOKEN || null;
const bootstrapNonce = randomBytes(32).toString("base64url");
const bootstrapExpiresAt = Date.now() + 2 * 60_000;
let bootstrapConsumed = false;
const port = Number(process.env.CONTROL_CENTER_PORT || process.argv.find((value) => value.startsWith("--port="))?.split("=")[1] || 0);
const host = "127.0.0.1";
const testRunHistoryScanDelayMs = process.env.CONTROL_CENTER_TEST_MODE === "1"
  ? Math.min(30_000, Math.max(0, Number(process.env.CONTROL_CENTER_TEST_RUN_HISTORY_SCAN_DELAY_MS) || 0))
  : 0;
const testBusTailReadDelayMs = process.env.CONTROL_CENTER_TEST_MODE === "1"
  ? Math.min(30_000, Math.max(0, Number(process.env.CONTROL_CENTER_TEST_BUS_TAIL_READ_DELAY_MS) || 0))
  : 0;
const testMissionHealthDelayMs = process.env.CONTROL_CENTER_TEST_MODE === "1"
  ? Math.min(30_000, Math.max(0, Number(process.env.CONTROL_CENTER_TEST_MISSION_HEALTH_DELAY_MS) || 0))
  : 0;
const testAgentActionDelayMs = process.env.CONTROL_CENTER_TEST_MODE === "1"
  ? Math.min(30_000, Math.max(0, Number(process.env.CONTROL_CENTER_TEST_AGENT_ACTION_DELAY_MS) || 0))
  : 0;
const testBusTailGateEnabled = process.env.CONTROL_CENTER_TEST_MODE === "1"
  && process.env.CONTROL_CENTER_TEST_BUS_TAIL_GATE === "1";
// 关闭链统一预算（烛 wave-shutdown 复审）：state.close 各阶段共享这一份预算。
// 测试 fixture 通过 CONTROL_CENTER_SHUTDOWN_BUDGET_MS 收紧到其 5s 退出窗口内。
const shutdownBudgetMs = Math.min(30_000, Math.max(500, Number(process.env.CONTROL_CENTER_SHUTDOWN_BUDGET_MS) || 8_000));
// 测试钩子：拉长 health probe 让并发 mission 请求有窗口汇合到同一共享 batch，
// 并通过 /api/test/health-stats 观察 inflight/waiters/retiring 生命周期。
const testHealthProbeDelayMs = process.env.CONTROL_CENTER_TEST_MODE === "1"
  ? Math.min(30_000, Math.max(0, Number(process.env.CONTROL_CENTER_TEST_HEALTH_PROBE_DELAY_MS) || 0))
  : 0;
const testHealthProbeStats = { calls: 0 };
const state = await createControlCenter({
  repoRoot: process.env.CONTROL_CENTER_TEST_MODE === "1"
    ? process.env.CONTROL_CENTER_TEST_REPO_ROOT || undefined
    : undefined,
  eventStoreOptions: testRunHistoryScanDelayMs > 0
    ? {
        onRunIndexScan: ({ signal }) => delay(testRunHistoryScanDelayMs, undefined, { signal }),
      }
    : undefined,
});
state.avatars = await createAvatarStore({
  dataRoot: state.dataRoot,
  teamMembers: state.teamMembers,
}).init();

// ===== 外观偏好持久化：桌面壳按地址+端口隔离 localStorage，端口随机变化后本地偏好全部失联，
// 所以外观键改存服务端数据目录（与 operator-profile.json 同级同约定），前端双写 + 启动补齐。 =====
// 键白名单与 public/theme.js 首帧引导、app.js 外观域严格一一对应；白名单外的键一律丢弃。
const PREFERENCE_KEYS = new Set([
  "514cc-control-theme",
  "514cc-ui-font-size",
  "514cc-code-font-size",
  "514cc-ui-font-face",
  "514cc-code-font-face",
  "514cc-accent",
  "514cc-density",
  "514cc-code-wrap",
  "514cc-code-lines",
  "514cc-motion",
  // 背景与玻璃三件套（任务 #3）：透明度百分比字符串 / 模糊像素数字符串 / 底色预设 ID，
  // 与 app.js 的 APPEARANCE_PREF_KEYS 严格一一对应；前端读取时各自收敛合法值域。
  "514cc-glass-alpha",
  "514cc-glass-blur",
  "514cc-glass-tint",
  // 壁纸态玻璃不透明度（2026-08-29 自定义程度波）："auto" 或 "20"–"95" 百分比字符串；
  // 手动值直接接管壁纸激活态的 --forge-glass-alpha，auto 回到亮度分档。
  "514cc-wallpaper-glass-alpha",
  // 壁纸态磨砂强度（v6）："auto" 或 "0"–"30" 像素字符串；0 = 壁纸完全清晰。
  "514cc-wallpaper-glass-blur",
  // 内容卡玻璃度（v7）："auto" 或 "40"–"95" 百分比字符串；恢复条/气泡/输入台/成员卡
  // 等浮层卡的实体感，auto 随透出档位。
  "514cc-card-glass-alpha",
  // 背景视频失焦暂停档（任务 #4）："on"/"off"，默认关（键缺失即关）；
  // 控制窗口失焦时是否冻结团队背景视频解码与氛围动画。
  "514cc-bg-pause-blur",
  // 全局壁纸（对标 dsh-wallpaper-engine 的全局设置面）：JSON 快照
  // {preset,fit,overrideTeam,rotate{enabled,intervalMin,shuffle}}，≤512 字符上限内；
  // 自定义媒体字节不进偏好（走 /api/wallpapers/global 字节管线），这里只存配置。
  "514cc-global-wallpaper",
]);
const MAX_PREFERENCES_BYTES = 64 * 1024;
const MAX_PREFERENCE_VALUE_LENGTH = 512;
const preferencesPath = join(state.dataRoot, "preferences.json");
// 内存合并区：连续 PUT 先落这里，200ms 防抖后一次落盘，避免逐键连写。
let preferencesPending = null;
let preferencesFlushTimer = null;

function preferencesFail(message, code = "VALIDATION_FAILED") {
  throw Object.assign(new Error(message), { code, httpStatus: 400 });
}

function sanitizePreferenceInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    preferencesFail("preferences must be a plain object", "INVALID_PREFERENCES");
  }
  const clean = {};
  for (const [key, value] of Object.entries(input)) {
    if (!PREFERENCE_KEYS.has(key)) continue; // 白名单外的键直接丢弃，不进存储
    if (typeof value !== "string") preferencesFail(`preference value for ${key} must be a string`, "INVALID_PREFERENCES");
    if (value.length > MAX_PREFERENCE_VALUE_LENGTH) preferencesFail(`preference value for ${key} is too long`, "INVALID_PREFERENCES");
    clean[key] = value;
  }
  return clean;
}

/** 读取偏好文件；文件不存在或 JSON 损坏都回退空对象——
    损坏时只降级读取路径，绝不覆盖/删除用户文件（下一次成功写入自然修复）。 */
async function readPreferencesFromDisk() {
  try {
    const parsed = JSON.parse(await readFile(preferencesPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (PREFERENCE_KEYS.has(key) && typeof value === "string" && value.length <= MAX_PREFERENCE_VALUE_LENGTH) clean[key] = value;
    }
    return clean;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    if (error instanceof SyntaxError) return {}; // 损坏：回退默认，不碰用户文件
    throw error;
  }
}

// 原子写：与 avatars.mjs writeAtomicBytes 同构（临时文件 + fsync + rename），中途崩溃不留半截 JSON。
async function writePreferencesAtomic(value) {
  await mkdir(dirname(preferencesPath), { recursive: true, mode: 0o700 });
  const temp = join(dirname(preferencesPath), `.preferences.${process.pid}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, 0o600).catch(() => {});
    await rename(temp, preferencesPath);
    renamed = true;
  } finally {
    if (!renamed) await rm(temp, { force: true });
  }
}

// 落盘失败的重试策略：合回暂存区 + 1s 退避，最多 PREFERENCES_RETRY_MAX 次；超限后暂存区保留，
// 等下一次 PUT 重新触发（GET 合并视图全程可读，不产生「写已确认、读未见」的丢失感）。
const PREFERENCES_RETRY_MAX = 5;
let preferencesRetryCount = 0;

async function flushPreferences() {
  clearTimeout(preferencesFlushTimer);
  preferencesFlushTimer = null;
  const snapshot = preferencesPending;
  preferencesPending = null;
  if (!snapshot) return;
  try {
    await writePreferencesAtomic(snapshot);
    preferencesRetryCount = 0;
  } catch (error) {
    // 落盘失败不再静默丢弃：快照合回暂存区（期间新到的更鲜 PUT 优先），退避重试。
    preferencesPending = { ...snapshot, ...(preferencesPending ?? {}) };
    preferencesRetryCount += 1;
    if (preferencesRetryCount <= PREFERENCES_RETRY_MAX) {
      schedulePreferencesFlush(1000);
    }
    process.stderr.write(
      `preferences flush failed (attempt ${Math.min(preferencesRetryCount, PREFERENCES_RETRY_MAX)}/${PREFERENCES_RETRY_MAX}, kept in memory): ${error?.message ?? error}\n`,
    );
  }
}

function schedulePreferencesFlush(delayMs = 200) {
  clearTimeout(preferencesFlushTimer);
  preferencesFlushTimer = setTimeout(() => { void flushPreferences(); }, delayMs);
  preferencesFlushTimer.unref?.();
}
if (testHealthProbeDelayMs > 0) {
  const baseProbe = state.healthService.probeProfile.bind(state.healthService);
  state.healthService.probeProfile = async (profile, options = {}) => {
    testHealthProbeStats.calls += 1;
    await delay(testHealthProbeDelayMs, undefined, { signal: options.signal });
    return baseProbe(profile, options);
  };
}

// 审批快照的代际信息必须和 pending 列表一起发出；bootstrap 不能再成为
// 绕过 `/api/approvals` revision 守卫的第二条裸列表通道。
function approvalSnapshotForPublic() {
  return {
    ...state.approvalBroker.snapshot(),
    runtimeGeneration: state.generation,
  };
}
// Wave G 面路由注册表：各面 src/<surface>/routes.mjs 导出 register<SX>Routes(router, ctx)。
// router.get/post/put/delete(prefix, handler)；handler(request, response, url, ctx) 返回 true 表示已处理。
// 工位纪律：面模块不碰本文件；主驾在下方统一接线（import + register）。
const surfaceRoutes = [];
const surfaceRouter = Object.freeze({
  use(method, prefix, handler) { surfaceRoutes.push({ method, prefix, handler }); },
  get(prefix, handler) { this.use("GET", prefix, handler); },
  post(prefix, handler) { this.use("POST", prefix, handler); },
  put(prefix, handler) { this.use("PUT", prefix, handler); },
  delete(prefix, handler) { this.use("DELETE", prefix, handler); },
});
const surfaceCtx = { state, remoteGates: state.remoteGates, json, body, rawBody };
// ---- Wave G 面接线（五面全部就位；门闸 v2 在 register 内登记实现）----
registerChannelsRoutes(surfaceRouter, surfaceCtx);
registerSshRoutes(surfaceRouter, surfaceCtx);
registerRemoteProjectRoutes(surfaceRouter, surfaceCtx); // 必须在 registerSshRoutes 之后：主机解析依赖 getSshService()
registerOfficeRoutes(surfaceRouter, surfaceCtx);
registerPtyRoutes(surfaceRouter, surfaceCtx);
registerMarketRoutes(surfaceRouter, surfaceCtx);
registerCcSwitchRoutes(surfaceRouter, surfaceCtx);
registerCliEnvRoutes(surfaceRouter, surfaceCtx);
registerHooksRoutes(surfaceRouter, surfaceCtx);
async function dispatchSurfaceRoute(request, response, url) {
  for (const route of surfaceRoutes) {
    if (request.method !== route.method) continue;
    if (!url.pathname.startsWith(route.prefix)) continue;
    if (await route.handler(request, response, url, surfaceCtx)) return true;
  }
  return false;
}

function runtimeProfileIdForMember(memberId) {
  return state.teamMembers.get(String(memberId || "")).runtimeProfileId;
}

const runAgentControlAction = createAgentControlActionRunner({
  resolveMember: (memberId) => state.teamMembers.get(memberId),
  resolveProfile: (runtimeProfileId) => state.models.profiles.find((item) => item.id === runtimeProfileId) || null,
  modelDiscovery: state.modelDiscovery,
  repoRoot: state.repoRoot,
  eventStore: state.eventStore,
  runProcessImpl: testAgentActionDelayMs > 0
    ? async (...args) => {
        await delay(testAgentActionDelayMs);
        return runProcess(...args);
      }
    : runProcess,
});
const gitActionBroker = new GitActionBroker();

function projectRouteToTeamMembers(route, team, preferredMemberIds = []) {
  const roster = (team?.members || []).map((memberId) => state.teamMembers.get(memberId));
  const preferences = preferredMemberIds
    .map((memberId) => String(memberId || "").trim())
    .filter((memberId, index, all) => memberId && all.indexOf(memberId) === index);
  const memberForRuntime = (runtimeProfileId, excludedMemberIds = []) => {
    const excluded = new Set(excludedMemberIds.filter(Boolean));
    const candidates = roster.filter((member) => (
      !excluded.has(member.id) && member.runtimeProfileId === runtimeProfileId
    ));
    return preferences
      .map((memberId) => candidates.find((member) => member.id === memberId))
      .find(Boolean)
      || candidates[0]
      || null;
  };
  const project = (candidate, excludedMemberIds = []) => {
    if (!candidate) return null;
    const member = memberForRuntime(candidate.id, excludedMemberIds);
    if (!member) return { ...candidate, runtimeProfileId: candidate.id };
    return {
      ...candidate,
      id: member.id,
      label: member.label,
      role: member.role,
      runtimeProfileId: candidate.id,
    };
  };
  const selected = project(route.selected);
  return {
    ...route,
    selected,
    independent: project(route.independent, [selected?.id]),
    candidates: (route.candidates || []).map((candidate) => project(candidate)).filter(Boolean),
  };
}

function liveRuntimeIdentity() {
  return {
    pid: state.pid,
    generation: state.generation,
    cwd: state.repoRoot,
    startedAt: state.startedAt,
  };
}

async function collectLiveReleaseTruth({ commandEvidence = null } = {}) {
  const runtime = liveRuntimeIdentity();
  const evidence = commandEvidence ?? await state.releaseCommandEvidence.snapshot().catch(() => ({}));
  return collectReleaseTruth({
    repoRoot: state.repoRoot,
    runtime,
    validationEvidence: summarizeServerObservedValidation(evidence, { runtime }),
  });
}

async function collectLiveReadiness({ probeHealth = false } = {}) {
  const draft = await state.firstRunDraft.load();
  const health = probeHealth
    ? await state.healthService.all({ refresh: false }).catch(() => [])
    : [];
  const healthMeta = probeHealth && typeof state.healthService.peekMeta === "function"
    ? state.healthService.peekMeta()
    : null;
  const gates = typeof state.remoteGates?.list === "function" ? state.remoteGates.list() : [];
  return collectFirstRunReadiness({
    projectBridge: await collectProjectBridge({
      cwd: state.repoRoot,
      runtime: { pid: state.pid, generation: state.generation, startedAt: state.startedAt },
      processes: state.childRegistry.snapshot(),
      store: state.projectAnchors,
    }),
    teams: state.teams.list(),
    runtimeCatalog: state.runtimeCatalog || [],
    health: Array.isArray(health) ? health : health?.items || [],
    healthMeta,
    releaseTruth: await collectLiveReleaseTruth(),
    draft,
    remoteGates: Array.isArray(gates) ? gates : gates?.items || [],
  });
}

async function collectLiveReleaseRecord({ releaseTruth = null } = {}) {
  const commandEvidence = await state.releaseCommandEvidence.snapshot().catch(() => ({}));
  const runtime = liveRuntimeIdentity();
  const truth = releaseTruth || await collectLiveReleaseTruth({ commandEvidence });
  return collectReleaseRecord({
    repoRoot: state.repoRoot,
    runtime,
    releaseTruth: truth,
    commandEvidence,
    executeCommands: false,
  });
}

async function readRuntimeRoster() {
  try {
    return JSON.parse(await readFile(join(state.dataRoot, "roster.json"), "utf8"));
  } catch {
    return { agents: {} };
  }
}

async function collectLiveTeamInbox(teamId, { signal, limit } = {}) {
  const team = state.teams.get(teamId);
  const lifecycleByKey = await state.inboxLifecycle.snapshot().catch(() => ({}));
  return collectTeamInbox({
    teamId,
    team,
    runs: state.orchestrator.list(),
    maxRuns: INBOX_LIMITS.maxRuns,
    maxMessages: Math.min(
      INBOX_LIMITS.maxMessages,
      Math.max(1, Number(limit) || INBOX_LIMITS.maxMessages),
    ),
    lifecycleByKey,
    readTail: async (runId, options) => {
      const run = structuredClone(state.orchestrator.get(runId));
      const tail = await state.orchestrator.bus.readTail(runId, {
        maxBytes: MISSION_CONTROL_LIMITS.busBytes,
        maxMessages: MISSION_CONTROL_LIMITS.busMessages,
        signal: options?.signal || signal,
      });
      return {
        ...tail,
        diagnostics: auditBusDiagnostics(run, tail.diagnostics, tail.messages.length),
      };
    },
    signal,
  });
}

const RUNTIME_SEAT_SOURCE_ID = "control.models";
const RUNTIME_SEAT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
let runtimeSeatMutationChain = Promise.resolve();

function runtimeSeatError(message, code = "VALIDATION_FAILED", details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function normalizeRuntimeSeatId(value) {
  const id = String(value ?? "").trim();
  if (!RUNTIME_SEAT_ID.test(id)) {
    throw runtimeSeatError("runtime seat id must be 1-80 characters using letters, numbers, dot, underscore or hyphen");
  }
  return id;
}

function runtimeSeatPayload(input) {
  const payload = input?.seat ?? input;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw runtimeSeatError("runtime seat payload must be an object");
  }
  return payload;
}

function runtimeSeatTemplate(adapter, runtimeProfileId) {
  const template = adapterTemplateCatalog().find((item) => item.id === adapter && item.selectable !== false);
  if (!template) {
    throw runtimeSeatError(`unsupported adapter template: ${adapter || "missing"}`, "ADAPTER_MANIFEST_INVALID", {
      runtimeProfileId,
    });
  }
  return template;
}

function normalizeRuntimeSeatControls(profile, template) {
  const runtimeProfileId = String(profile.id || "");
  let command = profile.command == null ? "" : String(profile.command).trim();
  if (template.commandMode === "none") {
    if (command) throw runtimeSeatError(`${template.id} does not accept an execution command`, "ADAPTER_MANIFEST_INVALID", { runtimeProfileId });
    command = "";
  } else {
    if (template.requiresCommand && !command) {
      throw runtimeSeatError(`${template.id} requires an execution command`, "ADAPTER_MANIFEST_INVALID", { runtimeProfileId });
    }
    if (/[\0\r\n]/.test(command) || /^['"]|['"]$/.test(command)) {
      throw runtimeSeatError("execution command must be an unquoted executable name or path", "VALIDATION_FAILED", { runtimeProfileId });
    }
    const looksAbsolute = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(command);
    if (!looksAbsolute && /\s/.test(command)) {
      throw runtimeSeatError("execution command cannot include arguments; enter only the executable name or an absolute path", "VALIDATION_FAILED", { runtimeProfileId });
    }
  }

  const model = profile.model == null ? "" : String(profile.model).trim();
  if (model && template.modelMode === "none") {
    throw runtimeSeatError(`${template.id} does not support model overrides`, "INVALID_MODEL", { runtimeProfileId });
  }
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)) {
    throw runtimeSeatError("model id contains unsupported characters", "INVALID_MODEL", { runtimeProfileId });
  }

  const defaultEffort = profile.defaultEffort == null ? "" : String(profile.defaultEffort).trim().toLowerCase();
  if (defaultEffort && template.effortMode === "none") {
    throw runtimeSeatError(`${template.id} does not support effort overrides`, "INVALID_EFFORT", { runtimeProfileId });
  }
  if (defaultEffort && template.effortLevels?.length && !template.effortLevels.includes(defaultEffort)) {
    throw runtimeSeatError(`unsupported effort level for ${template.id}: ${defaultEffort}`, "INVALID_EFFORT", { runtimeProfileId });
  }

  const defaultPermissionMode = String(profile.defaultPermissionMode || template.defaultPermissionMode || "read-only");
  if (!template.permissionModes.includes(defaultPermissionMode)) {
    throw runtimeSeatError(`unsupported permission mode for ${template.id}: ${defaultPermissionMode}`, "UNSUPPORTED_PERMISSION", { runtimeProfileId });
  }
  return {
    ...profile,
    capabilities: ["*"],
    command: command || null,
    model: model || null,
    defaultEffort: defaultEffort || null,
    defaultPermissionMode,
  };
}

function buildCustomRuntimeSeat(input) {
  const payload = runtimeSeatPayload(input);
  const id = normalizeRuntimeSeatId(payload.id);
  const adapter = String(payload.adapter ?? "").trim();
  const template = runtimeSeatTemplate(adapter, id);
  return normalizeRuntimeSeatControls({
    id,
    builtin: false,
    label: id,
    role: "custom-runtime-seat",
    description: "",
    systemPrompt: "",
    provider: template.defaultProvider || "custom",
    adapter,
    command: template.defaultCommand ?? null,
    model: null,
    capabilities: ["*"],
    defaultPermissionMode: template.defaultPermissionMode || "read-only",
    coordinatorEligible: false,
    quality: template.routingDefaults?.quality ?? 0.5,
    speed: template.routingDefaults?.speed ?? 0.5,
    costTier: template.routingDefaults?.costTier ?? 3,
    enabled: true,
    evidence: [{
      source: "operator-configured",
      detail: "Created through the Control Center runtime seat editor; executability remains subject to adapter and health gates.",
      verifiedAt: new Date().toISOString().slice(0, 10),
    }],
    ...payload,
    id,
    builtin: false,
    adapter,
  }, template);
}

async function readRuntimeSeatRegistry() {
  const source = await state.configManager.read(RUNTIME_SEAT_SOURCE_ID);
  let registry;
  try {
    registry = JSON.parse(source.content);
  } catch (error) {
    throw runtimeSeatError("runtime seat registry is not valid JSON", "RUNTIME_GRAPH_INVALID", { cause: error });
  }
  if (!registry || typeof registry !== "object" || Array.isArray(registry) || !Array.isArray(registry.profiles)) {
    throw runtimeSeatError("runtime seat registry profiles must be an array", "RUNTIME_GRAPH_INVALID");
  }
  return { source, registry };
}

function runtimeSeatReferences(runtimeProfileId) {
  return state.teamMembers.list()
    .filter((member) => member.runtimeProfileId === runtimeProfileId)
    .map((member) => ({
      type: "team-member",
      id: member.id,
      label: member.label,
      builtin: member.builtin,
      runtimeProfileId,
    }));
}

function configuredRuntimeSeatView(profile) {
  const live = state.runtimeCatalog.find((item) => item.id === profile.id) ?? null;
  const active = state.models.profiles.find((item) => item.id === profile.id) ?? null;
  const activation = active && JSON.stringify(active) === JSON.stringify(profile)
    ? "live"
    : "restart-required";
  return { ...profile, live, activation };
}

async function runtimeSeatSnapshot() {
  const { source, registry } = await readRuntimeSeatRegistry();
  const providerState = state.providers.list();
  const seats = registry.profiles.map(configuredRuntimeSeatView);
  const activation = seats.every((seat) => seat.activation === "live") ? "live" : "restart-required";
  return {
    seats,
    runtimeProfiles: state.runtimeCatalog,
    adapterTemplates: adapterTemplateCatalog(),
    providers: providerState.providers,
    providerCurrent: providerState.current,
    providerApps: [...PROVIDER_APPS],
    source: { id: source.id, sha256: source.sha256 },
    runtime: { generation: state.generation, activation },
  };
}

function withRuntimeSeatMutation(operation) {
  const result = runtimeSeatMutationChain.catch(() => {}).then(operation);
  runtimeSeatMutationChain = result.catch(() => {});
  return result;
}

function mutateRuntimeSeats(reason, mutation) {
  return withRuntimeSeatMutation(async () => {
    const { source, registry } = await readRuntimeSeatRegistry();
    const outcome = await mutation(registry.profiles, registry);
    const content = `${JSON.stringify(registry, null, 2)}\n`;
    const plan = await state.configManager.plan(RUNTIME_SEAT_SOURCE_ID, content, source.sha256);
    const transaction = await state.configManager.apply(RUNTIME_SEAT_SOURCE_ID, {
      content,
      baseSha256: source.sha256,
      planId: plan.planId,
      confirmation: RUNTIME_SEAT_SOURCE_ID,
      actor: "control-center-runtime-seat",
      reason,
    });
    return { outcome, transaction };
  });
}

let projectPrefsWriteChain = Promise.resolve();
const runEventResponses = new ResponseLeaseLimiter({ maxActive: 16, maxActivePerKey: 4 });
const testBusTailGate = (() => {
  let open = !testBusTailGateEnabled;
  const waiters = new Set();
  return {
    async wait(signal) {
      if (open) return;
      if (signal?.aborted) throw signal.reason;
      await new Promise((resolveWait, rejectWait) => {
        let settled = false;
        const settle = (callback, value) => {
          if (settled) return;
          settled = true;
          waiters.delete(release);
          signal?.removeEventListener("abort", onAbort);
          callback(value);
        };
        const release = () => settle(resolveWait);
        const onAbort = () => settle(rejectWait, signal.reason);
        waiters.add(release);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (open) release();
        else if (signal?.aborted) onAbort();
      });
    },
    release() {
      open = true;
      const released = waiters.size;
      for (const waiter of [...waiters]) waiter();
      return released;
    },
  };
})();

function cleanProjectPrefs(payload, { persisted = false } = {}) {
  const invalid = (message) => Object.assign(new Error(message), { code: persisted ? "PREFS_CORRUPT" : "VALIDATION_FAILED" });
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw invalid("project prefs must be an object");
  const projects = payload.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) throw invalid("projects object is required");
  const clean = Object.create(null);
  for (const [key, value] of Object.entries(projects)) {
    if (typeof key !== "string" || key.length > 500 || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = {};
    if (value.pinned !== undefined) entry.pinned = Boolean(value.pinned);
    if (value.hidden !== undefined) entry.hidden = Boolean(value.hidden);
    if (typeof value.name === "string" && value.name.trim()) entry.name = value.name.trim().slice(0, 120);
    if (typeof value.teamId === "string" && value.teamId.trim()) entry.teamId = value.teamId.trim().slice(0, 80);
    if (Object.keys(entry).length) clean[key] = entry;
  }

  const cleanSessions = Object.create(null);
  const sessions = payload.sessions;
  if (sessions !== undefined && (!sessions || typeof sessions !== "object" || Array.isArray(sessions))) {
    if (persisted) throw invalid("persisted sessions must be an object");
  } else if (sessions) {
    for (const [key, value] of Object.entries(sessions)) {
      if (typeof key !== "string" || key.length > 700 || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = {};
      if (value.pinned !== undefined) entry.pinned = Boolean(value.pinned);
      if (value.archived !== undefined) entry.archived = Boolean(value.archived);
      if (value.unread !== undefined) entry.unread = Boolean(value.unread);
      if (typeof value.alias === "string" && value.alias.trim()) entry.alias = value.alias.trim().slice(0, 160);
      if (typeof value.teamId === "string" && value.teamId.trim()) entry.teamId = value.teamId.trim().slice(0, 80);
      if (Object.keys(entry).length) cleanSessions[key] = entry;
    }
  }

  const revision = payload.revision === undefined ? 0 : Number(payload.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw invalid("project prefs revision is invalid");
  return { revision, projects: clean, sessions: cleanSessions };
}

async function readProjectPrefs(path) {
  try {
    return cleanProjectPrefs(JSON.parse(await readFile(path, "utf8")), { persisted: true });
  } catch (error) {
    if (error.code === "ENOENT") return { revision: 0, projects: {}, sessions: {} };
    if (error instanceof SyntaxError) {
      throw Object.assign(new Error(`project prefs JSON is corrupt: ${error.message}`), { code: "PREFS_CORRUPT" });
    }
    throw error;
  }
}

async function atomicWriteProjectPrefs(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, path);
        return;
      } catch (error) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 5) throw error;
        await delay(10 * (2 ** attempt));
      }
    }
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

// v3.7 体检脉搏：治理数据面（observability）+ 运行时实况（runs/health/automations）合一——
// 体检自动化的 prompt 注入源，也是 GET /api/observability/pulse 的响应体
async function collectPulse({ signal } = {}) {
  return collectPulseSnapshot({
    observability: state.observability,
    orchestrator: state.orchestrator,
    healthService: state.healthService,
    automations: state.automations,
    signal,
  });
}
state.collectPulse = collectPulse; // AutomationStore 注入 prompt 用（app 装配期拿不到闭包，挂 state 上）

// v4.0 Forge：统一搜索 / 记忆浏览器 / 项目脚手架服务（全部本地只读，脚手架是唯一写口且限根）
const aiSharedRoot = join(state.repoRoot, ".ai-shared");
const searchService = new SearchService({ repoRoot: state.repoRoot, aiSharedRoot, sessions: state.sessions });
const memoryService = new MemoryService({ repoRoot: state.repoRoot, aiSharedRoot });
// W3.7 Guardrails 测试器：deny-paths 只读加载 + 路径命中预览（每请求重读文件，改完即生效）
const guardrailsService = createGuardrailsService({ repoRoot: state.repoRoot });
// W3.18 周报生成器：handoff/DELTA/run 聚合快照（runs 经惰性取用，orchestrator 后于本行初始化）
const weeklyReportService = createWeeklyReportService({
  aiSharedRoot,
  listRuns: () => (typeof state.orchestrator?.list === "function" ? state.orchestrator.list() : []),
});
// W3.1 月度预算告警：成本报表面已有，补预算设定与 warn/exceeded 观测状态
const monthlyBudgetService = createMonthlyBudgetService({
  dataRoot: state.dataRoot,
  listRuns: () => (typeof state.orchestrator?.list === "function" ? state.orchestrator.list() : []),
});
// W3.8 安全巡检：启动后台扫一次 + 手动触发（报告只含规则名，不回传密钥内容）
const secretSweepService = createSecretSweepService({
  dataRoot: state.dataRoot,
  aiSharedRoot,
  eventStore: state.eventStore ?? null,
});
void secretSweepService.sweep().catch(() => {});

const securityHeaders = {
  // media-src 需要 blob:：团队背景视频经 requestBlob → URL.createObjectURL 喂给 <video>，
  // 缺省回落 default-src 'self' 会被 Chromium 的 URL safety check 拒载（视频壁纸硬阻塞）。
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function json(response, status, payload) {
  response.writeHead(status, { ...securityHeaders, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function sendBytes(response, status, bytes, contentType) {
  response.writeHead(status, {
    ...securityHeaders,
    "content-type": contentType,
    "cache-control": "no-store",
    "content-length": bytes.length,
  });
  response.end(bytes);
}

function redactOrphanedRunPaths(value) {
  const seen = new WeakSet();
  const redact = (item) => {
    if (typeof item === "string") {
      return item
        .replace(/\b[A-Za-z]:[\\/][^\r\n]*/g, "[本地路径]")
        .replace(/\\\\[^\\/\r\n]+[\\/][^\r\n]*/g, "[本地路径]")
        .replace(/(^|[\s(])\/(?!\/)[^\r\n]*/g, "$1[本地路径]");
    }
    if (!item || typeof item !== "object") return item;
    if (seen.has(item)) return item;
    seen.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) item[index] = redact(item[index]);
    } else {
      for (const key of Object.keys(item)) item[key] = redact(item[key]);
    }
    return item;
  };
  return redact(structuredClone(value));
}

function runForPublic(run) {
  if (!run || typeof run !== "object") return run;
  const sources = publicSourceEntries(run.sources);
  const value = redactPublicSourcePaths(run, sources);
  if (Array.isArray(value.sources)) {
    value.sources = sources.map(({ kind, name }) => ({ kind, name }));
  }
  delete value.activeInteractionSources;
  delete value.pendingInteractionSources;
  delete value.interactionStates;
  delete value.contextTopologyKey;
  if (Array.isArray(value.pendingSteer)) {
    value.pendingSteer = value.pendingSteer.map(({ sources: _privateSources, ...steer }) => steer);
  }
  try {
    value.resumeHints = typeof state.orchestrator?.resumeHintsForRun === "function"
      ? state.orchestrator.resumeHintsForRun(run)
      : [];
  } catch {
    value.resumeHints = [];
  }
  return value;
}

function runsForPublic(runs) {
  return (Array.isArray(runs) ? runs : []).map(runForPublic);
}

function automationForPublic(automation) {
  if (!automation || typeof automation !== "object") return automation;
  const sources = publicSourceEntries(automation.sources);
  const value = redactPublicSourcePaths(automation, sources);
  if (Array.isArray(value.sources)) value.sources = sources.map(({ kind, name }) => ({ kind, name }));
  return value;
}

function automationsForPublic(automations) {
  return (Array.isArray(automations) ? automations : []).map(automationForPublic);
}

const eventProtocolFaults = { count: 0, lastSequence: null, lastSchemaVersion: null };

function eventForPublic(event, run, uiView = false) {
  if (event && typeof event === "object" && event.schemaVersion !== undefined
      && !SUPPORTED_EVENT_SCHEMA_VERSIONS.includes(event.schemaVersion)) {
    eventProtocolFaults.count++;
    eventProtocolFaults.lastSequence = event.sequence ?? null;
    eventProtocolFaults.lastSchemaVersion = event.schemaVersion;
    return unsupportedEventEnvelope(event);
  }
  const sourceRefs = Array.isArray(run?.sources) && run.sources.length
    ? run.sources
    : event?.sourceRefs;
  let value = redactPublicSourcePaths(event, sourceRefs);
  if (event?.runId && !run && !sourceRefs?.length) value = redactOrphanedRunPaths(value);
  if (value && typeof value === "object") delete value.sourceRefs;
  return uiView ? eventForUi(value) : value;
}

async function writeWithBackpressure(response, chunk) {
  if (response.destroyed || response.writableEnded) return false;
  if (response.write(chunk)) return true;
  return new Promise((resolveDrain) => {
    const settle = (value) => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onClose);
      resolveDrain(value);
    };
    const onDrain = () => settle(!response.destroyed && !response.writableEnded);
    const onClose = () => settle(false);
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onClose);
    if (response.destroyed || response.writableEnded) settle(false);
  });
}

async function ndjson(response, events, {
  batchSize = 128,
  maxBatchBytes = 64 * 1024,
  maxBatchMs = 8,
  transform = (event) => event,
} = {}) {
  response.writeHead(200, {
    ...securityHeaders,
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
  });
  let lines = [];
  let bytes = 0;
  let batchStartedAt = performance.now();
  for (let index = 0; index < events.length; index += 1) {
    const line = JSON.stringify(transform(events[index]));
    lines.push(line);
    bytes += Buffer.byteLength(line, "utf8") + 1;
    const elapsed = performance.now() - batchStartedAt;
    const shouldFlush = lines.length >= batchSize || bytes >= maxBatchBytes || elapsed >= maxBatchMs;
    if (!shouldFlush && index + 1 < events.length) continue;
    if (!(await writeWithBackpressure(response, `${lines.join("\n")}\n`))) return;
    lines = [];
    bytes = 0;
    if (index + 1 < events.length) {
      await new Promise((resolveYield) => setImmediate(resolveYield));
      batchStartedAt = performance.now();
    }
  }
  response.end();
}

async function body(request, maxBytes = 6 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("request body is too large"), { code: "BODY_TOO_LARGE" });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("request body must be valid JSON"), { code: "INVALID_JSON" });
  }
}

/** Wave G：HMAC 验签等场景需要原文字节（重序列化会破坏签名）。 */
async function rawBody(request, maxBytes = 6 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("request body is too large"), { code: "BODY_TOO_LARGE" });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function authorized(request) {
  // 常数时间比较，与 bootstrap nonce 的 secretEquals 同基线
  if (observerToken && secretEquals(request.headers.authorization, `Bearer ${observerToken}`)) {
    return { observer: true };
  }
  if (secretEquals(request.headers.authorization, `Bearer ${token}`)) {
    return { observer: false };
  }
  return null;
}

function secretEquals(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 跨平台"在文件管理器中定位/打开"。Windows 用 explorer /select，其余平台退化为打开所在目录。 */
function revealInFileManager(target, { select = true } = {}) {
  if (process.platform === "win32") {
    const args = select ? [`/select,${target}`] : [target];
    spawn("explorer.exe", args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
    return;
  }
  // explorer.exe 常以非 0 退出码返回（历史行为），fire-and-forget 不据此报错
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "darwin" && select ? ["-R", target] : [select ? dirname(target) : target];
  const child = spawn(opener, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {}); // 桌面环境无 opener 时不拖垮请求
  child.unref();
}

function secretReferenceStatus(health) {
  const byId = new Map(health.map((item) => [item.id, item]));
  const grokReferences = ["GROK_SEARCH_RS_COMPAT_API_URL", "GROK_SEARCH_RS_COMPAT_API_KEY", "GROK_SEARCH_RS_COMPAT_MODEL"];
  return [
    {
      id: "control-access",
      name: "Control Center Access",
      reference: "URL fragment -> sessionStorage -> Authorization header",
      configured: true,
    },
    {
      id: "claude-cli-session",
      name: "Claude CLI Session",
      reference: "local CLI credential store",
      configured: byId.get("claude-fable")?.available ?? null,
    },
    {
      id: "codex-cli-session",
      name: "Codex CLI Session",
      reference: "CODEX_HOME credential store",
      configured: byId.get("codex-technical")?.available ?? null,
    },
    {
      id: "grok-search-env",
      name: "Grok Search",
      reference: grokReferences.join(" + "),
      configured: grokReferences.every((name) => Boolean(process.env[name])),
    },
  ];
}

function statusFor(error) {
  if (error.httpStatus) return error.httpStatus; // 渠道/office 等自带语义化状态码的错误，避免误报 500
  if (["CHANNEL_NOT_FOUND"].includes(error.code)) return 404;
  if (["CHANNELS_STORE_UNAVAILABLE", "APPROVAL_AUDIT_TIMEOUT"].includes(error.code)) return 503;
  if (["SOURCE_NOT_FOUND", "RUN_NOT_FOUND", "PROJECT_NOT_FOUND", "CONVERSATION_NOT_FOUND", "VERSION_NOT_FOUND", "APPROVAL_NOT_FOUND", "LEASE_NOT_FOUND", "AUTOMATION_NOT_FOUND", "RUNTIME_SEAT_NOT_FOUND", "REMOTE_HOST_NOT_FOUND", "BACKUP_NOT_FOUND", "MODEL_FETCH_NOT_FOUND", "AVATAR_NOT_FOUND", "BACKGROUND_NOT_FOUND", "SSH_NOT_FOUND"].includes(error.code)) return 404;
  if (["STALE_BASE", "RUN_ACTIVE", "RUN_TERMINAL", "RUN_INTERRUPTING", "TURN_ACTIVE", "CONTROL_TRANSITION_FORBIDDEN", "APPROVAL_HASH_MISMATCH", "APPROVAL_IN_PROGRESS", "PLAN_REQUIRED", "PLAN_MISMATCH", "PLAN_EXPIRED", "PLAN_STALE", "APPROVAL_REQUIRED", "RECOVERY_REQUIRED", "RUNTIME_BUSY", "AGENT_ACTION_BUSY", "AUTOMATION_BUSY", "AUTOMATION_RECOVERY_REQUIRED", "PREFS_REVISION_MISMATCH", "PROJECT_REVISION_MISMATCH", "PROJECT_ID_CONFLICT", "PROJECT_DEFAULT_CONVERSATION_CONFLICT", "PROJECT_ARCHIVED", "CONVERSATION_REVISION_MISMATCH", "CONVERSATION_STORE_REVISION_MISMATCH", "WORKSPACE_CONVERSATION_CONFLICT", "RUN_CONVERSATION_CONFLICT", "CONVERSATION_DELETED", "CONVERSATION_MEMBERS_CHANGED", "MCP_RESTORE_CONFLICT", "MCP_QUARANTINE_CONFLICT", "MCP_SOURCE_CONFLICT", "SKILL_EXISTS", "TEAM_CATALOG_CONFLICT", "MEMBER_IN_USE", "MEMBER_RUNTIME_CONFLICT", "RUNTIME_SEAT_EXISTS", "RUNTIME_SEAT_IN_USE", "PROVIDER_IN_USE", "PROVIDER_RESERVED_NAME", "ASK_NOT_PENDING", "ASK_MISMATCH", "ASK_OWNER_MISMATCH", "ANSWER_IN_PROGRESS", "DUPLICATE_MESSAGE", "GIT_ACTION_FAILED", "REMOTE_HOST_DISABLED", "BACKUP_TARGET_CHANGED", "CODEX_MODEL_CATALOG_CONFLICT", "SSH_HOST_DISABLED", "OFFICE_FILE_EXISTS", "WORKSPACE_VERSION_CONFLICT"].includes(error.code)) return 409;
  if (["CONFIRMATION_REQUIRED", "DEPLOYMENT_REQUIRED", "READ_ONLY_SOURCE", "FROZEN_BLOCK", "SFTP_PATH_BOUNDARY", "SFTP_BAD_PATH"].includes(error.code)) return 403;
  if (["VALIDATION_FAILED", "CLI_HANDOFF_UNSUPPORTED", "PROVIDER_CREDENTIAL_SCOPE_MISMATCH", "CODEX_MODEL_CATALOG_REQUIRED", "MODEL_FETCH_URL_INVALID", "MODEL_FETCH_HTTPS_REQUIRED", "MODEL_FETCH_INVALID_RESPONSE", "RUNTIME_GRAPH_INVALID", "ADAPTER_MANIFEST_INVALID", "RUNTIME_CATALOG_INVALID", "RUNTIME_PROFILE_NOT_FOUND", "RUNTIME_PROFILE_INELIGIBLE", "AGENT_ACTION_UNSUPPORTED", "PATH_BOUNDARY", "INVALID_PROMPT", "INVALID_JSON", "INVALID_DECISION", "INVALID_CWD", "INVALID_MODEL", "INVALID_EFFORT", "INVALID_IMAGE_DATA", "IMAGE_TYPE_MISMATCH", "UNSUPPORTED_IMAGE_TYPE", "CLIPBOARD_CLAIM_INVALID", "NOT_TEAM_MEMBER", "PROVIDER_NOT_FOUND", "PROVIDER_UNAVAILABLE", "NO_ROUTE", "NO_INDEPENDENT_ROUTE", "ROUND_LIMIT", "INTERACTION_STEP_LIMIT", "INTERACTION_INVALID", "INSUFFICIENT_ROUNDS", "SENSITIVE_PROMPT", "UNSUPPORTED_APPROVAL", "UNSUPPORTED_PERMISSION", "POLICY_VIOLATION", "ADAPTER_UNAVAILABLE", "GIT_STATE_UNAVAILABLE", "NOTHING_STAGED", "NOTHING_TO_PUSH", "NO_UPSTREAM", "MULTIPLE_PUSH_TARGETS", "PUSH_URL_REWRITE", "DETACHED_HEAD", "WORKTREE_NOT_READY", "WORKTREE_INVALID", "INVALID_REMOTE", "INVALID_REMOTE_PATH", "REMOTE_ADAPTER_UNSUPPORTED", "BACKUP_NAME_INVALID", "BACKUP_TARGET_UNRESOLVED", "SOCIAL_UNLIMITED_BUDGET_REJECTED"].includes(error.code)) return 422;
  if (["BODY_TOO_LARGE", "IMAGE_TOO_LARGE", "MODEL_FETCH_RESPONSE_TOO_LARGE"].includes(error.code)) return 413;
  if (["EVENT_TOO_LARGE", "EVENT_HISTORY_TOO_LARGE"].includes(error.code)) return 413;
  if (error.code === "CLIPBOARD_STORAGE_QUOTA_EXCEEDED") return 507;
  if (error.code === "PROCESS_TIMEOUT") return 408; // 系统选择框挂满 5 分钟未选属预期流程，不是服务端故障
  if (error.code === "MODEL_FETCH_TIMEOUT") return 504;
  if (["PROVIDER_TURN_INCOMPLETE", "MODEL_FETCH_UNAUTHORIZED", "MODEL_FETCH_UPSTREAM_FAILED", "MODEL_FETCH_REDIRECT_BLOCKED", "MODEL_FETCH_REDIRECT_LIMIT", "SFTP_FAILED", "SSH_CONNECT_FAILED"].includes(error.code)) return 502;
  if (error.code === "OUTPUT_LIMIT") return 413;
  if (["AGENT_ACTION_CAPACITY", "MODEL_DISCOVERY_CAPACITY", "APPROVAL_CAPACITY"].includes(error.code)) return 429;
  if (["EVENT_INDEX_BUSY", "HEALTH_PROBE_BUSY", "TEAM_STORE_UNAVAILABLE", "PROJECT_STORE_UNAVAILABLE", "CONVERSATION_STORE_UNAVAILABLE", "CONVERSATION_CONTEXT_STORE_UNAVAILABLE", "TRANSACTION_INCONSISTENT", "MEMBER_REFERENCE_CHECK_FAILED", "PROVIDER_REFERENCE_CHECK_FAILED", "REMOTE_UNAVAILABLE", "SSH_UNAVAILABLE"].includes(error.code)) return 503;
  if ([
    "AUTOMATION_STORE_CORRUPT",
    "AUTOMATION_STORE_UNREADABLE",
    "AUTOMATION_STORE_DEGRADED",
    "AUTOMATION_STORE_WRITE_FAILED",
    "CAPABILITY_CONFIG_CORRUPT",
    "CAPABILITY_CONFIG_UNREADABLE",
    "CAPABILITY_CONFIG_UNAVAILABLE",
    "MCP_QUARANTINE_CORRUPT",
    "MCP_QUARANTINE_UNREADABLE",
    "MCP_QUARANTINE_UNAVAILABLE",
    "MCP_SOURCE_CORRUPT",
    "MCP_SOURCE_UNREADABLE",
    "MCP_TRANSACTION_INCOMPLETE",
    "SENSITIVE_FILE_PERMISSION_FAILED",
    "SENSITIVE_TEMP_CLEANUP_FAILED",
    "OPERATOR_PROFILE_UNREADABLE",
  ].includes(error.code)) return 503;
  if (error.code === "NOT_ACCEPTABLE") return 406;
  if (["REMOTE_GATE_BLOCKED", "REMOTE_GATE_NOT_IMPLEMENTED"].includes(error.code)) return 501; // 远程门闸未授权（ssh/sftp）——各面路由同语义
  return 500;
}

function parseAcceptHeader(header) {
  return String(header ?? "")
    .split(",")
    .map((raw, order) => {
      const [rawMediaType, ...rawParameters] = raw.split(";");
      const mediaType = rawMediaType.trim().toLowerCase();
      const match = /^([^\s/]+)\/([^\s/]+)$/.exec(mediaType);
      if (!match) return null;
      let quality = 1;
      for (const rawParameter of rawParameters) {
        const separator = rawParameter.indexOf("=");
        if (separator < 0 || rawParameter.slice(0, separator).trim().toLowerCase() !== "q") continue;
        const value = rawParameter.slice(separator + 1).trim();
        quality = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0;
        break;
      }
      return { type: match[1], subtype: match[2], quality, order };
    })
    .filter(Boolean);
}

function acceptMatch(ranges, type, subtype) {
  let best = { quality: 0, specificity: -1, order: Number.POSITIVE_INFINITY };
  for (const range of ranges) {
    if (range.type !== "*" && range.type !== type) continue;
    if (range.subtype !== "*" && range.subtype !== subtype) continue;
    const specificity = Number(range.type !== "*") + Number(range.subtype !== "*");
    if (specificity > best.specificity || (specificity === best.specificity && range.order < best.order)) {
      best = { quality: range.quality, specificity, order: range.order };
    }
  }
  return best;
}

function selectRunHistoryRepresentation(header) {
  // RFC 9110: a missing Accept header means the client accepts any media type.
  // Keep the historical JSON representation as the deterministic default.
  if (!String(header ?? "").trim()) return "json";
  const ranges = parseAcceptHeader(header);
  const ndjson = acceptMatch(ranges, "application", "x-ndjson");
  const jsonPreference = acceptMatch(ranges, "application", "json");
  if (ndjson.quality <= 0 && jsonPreference.quality <= 0) return null;
  if (ndjson.quality <= 0) return "json";
  if (jsonPreference.quality <= 0) return "ndjson";
  if (ndjson.quality !== jsonPreference.quality) return ndjson.quality > jsonPreference.quality ? "ndjson" : "json";
  if (ndjson.specificity !== jsonPreference.specificity) return ndjson.specificity > jsonPreference.specificity ? "ndjson" : "json";
  if (ndjson.order !== jsonPreference.order) return ndjson.order < jsonPreference.order ? "ndjson" : "json";
  return "json"; // Equal wildcards retain the backward-compatible JSON default.
}

// UI-AUDIT P0-3：静态资源服务（brotli/gzip 压缩 + ETag 条件请求 + 路径白名单）
// 已抽出为可单测模块 src/static-assets.mjs，见 tests/static-assets.test.mjs
const { serveStatic } = createStaticServer({ publicRoot, securityHeaders });


async function api(request, response, url) {
  const { pathname } = url;
  if (request.method === "POST" && pathname === "/api/test/shutdown" && process.env.CONTROL_CENTER_TEST_MODE === "1") {
    json(response, 202, { status: "shutting_down" });
    setImmediate(() => requestShutdown("test-api"));
    return;
  }
  if (request.method === "GET" && pathname === "/api/test/response-leases" && process.env.CONTROL_CENTER_TEST_MODE === "1") {
    return json(response, 200, runEventResponses.snapshot(url.searchParams.get("key")));
  }
  if (request.method === "GET" && pathname === "/api/test/health-stats" && process.env.CONTROL_CENTER_TEST_MODE === "1") {
    const healthService = state.healthService;
    return json(response, 200, {
      probeCalls: testHealthProbeStats.calls,
      inflight: Boolean(healthService.inflight),
      waiters: healthService.inflight?.waiters ?? 0,
      retiring: healthService.retiring.size,
    });
  }
  if (request.method === "POST" && pathname === "/api/test/bus-tail-gate/release" && testBusTailGateEnabled) {
    return json(response, 200, { released: testBusTailGate.release() });
  }
  if (request.method === "GET" && pathname === "/api/bootstrap") {
    return await runEventResponses.run("bootstrap", response, async (signal) => {
      const [health, sources] = await Promise.all([
        state.healthService.all({ signal }),
        state.configManager.listSources(),
      ]);
      const approvalSnapshot = approvalSnapshotForPublic();
      return json(response, 200, {
        version: "0.1.0",
        runtime: { generation: state.generation, activation: "live" },
        repoRoot: state.repoRoot,
        providers: state.models.profiles,
        runtimeSeats: state.models.profiles,
        adapterTemplates: adapterTemplateCatalog(),
        teamCatalog: state.teamCatalog,
        memberCatalog: state.teamCatalog,
        runtimeCatalog: state.runtimeCatalog,
        operatorProfile: await state.avatars.operatorProfile(),
        health,
        sources,
        runs: runsForPublic(state.orchestrator.list()),
        // 保留 `approvals` 数组供旧消费者读取；新的客户端必须使用带版本的嵌套快照。
        approvals: approvalSnapshot.approvals,
        approvalSnapshot,
        routing: state.routing,
        permissions: state.permissions,
        security: { secrets: secretReferenceStatus(health) },
      });
    }, { request });
  }
  if (request.method === "GET" && pathname === "/api/health") {
    return await runEventResponses.run("health", response, async (signal) => json(response, 200, {
      items: await state.healthService.all({
        refresh: url.searchParams.get("refresh") === "1",
        signal,
      }),
    }), { request });
  }
  if (request.method === "GET" && pathname === "/api/workbench/environment") {
    const requestedRunId = String(url.searchParams.get("runId") || "").trim();
    const run = requestedRunId ? structuredClone(state.orchestrator.get(requestedRunId)) : null;
    const workspace = run
      ? await attestRunWorkspace(run)
      : resolveRunWorkspace(null, { fallbackPath: state.repoRoot });
    // Snapshot before Git/GitHub probes start so the probe processes never list themselves.
    const processes = state.childRegistry.snapshot();
    return await runEventResponses.run(`environment:${requestedRunId || "idle"}`, response, async (signal) => {
      const runtime = {
        pid: state.pid,
        generation: state.generation,
        cwd: state.repoRoot,
        startedAt: state.startedAt,
      };
      const releaseTruth = await collectLiveReleaseTruth();
      const projectBridge = await collectProjectBridge({
        cwd: workspace.path,
        runtime,
        processes,
        store: state.projectAnchors,
      });
      const environment = await collectWorkbenchEnvironment({
        cwd: workspace.path,
        run,
        runs: state.orchestrator.list(),
        processes,
        signal,
        workspaceSource: workspace.kind === "worktree" ? "worktree" : run ? "run" : "control-center",
        releaseTruth,
        releaseRecord: await collectLiveReleaseRecord({ releaseTruth }).catch((error) => ({
          schema: "514cc.releaseRecord/v1",
          verdict: "unknown",
          publishable: false,
          autoGit: { add: false, commit: false, push: false },
          unfinished: [{ id: "release-record", status: "blocked", reason: "发布记录读取失败，不能涂绿" }],
          nextAction: { id: "release-record", text: "发布记录读取失败，不能涂绿" },
          error: String(error?.message || "release-record-unavailable").slice(0, 180),
        })),
        projectBridge,
        readiness: await collectLiveReadiness().catch((error) => ({
          schema: "514cc.first-run-readiness/v1",
          ready: false,
          degraded: true,
          nextAction: { text: "首次就绪读取失败，不能称为已就绪" },
          steps: [],
          error: String(error?.message || "readiness-unavailable").slice(0, 180),
        })),
      });
      return json(response, 200, environment);
    }, { request });
  }
  if (request.method === "GET" && pathname === "/api/release-truth") {
    return json(response, 200, await collectLiveReleaseTruth());
  }
  if (request.method === "GET" && pathname === "/api/release-record") {
    return json(response, 200, await collectLiveReleaseRecord());
  }
  if (request.method === "PUT" && pathname === "/api/release-record/commands") {
    const payload = await body(request);
    try {
      const saved = await state.releaseCommandEvidence.save(payload?.commands || payload || {});
      return json(response, 200, {
        ...saved,
        record: await collectLiveReleaseRecord(),
      });
    } catch (error) {
      if (error?.code === "RELEASE_COMMAND_EVIDENCE_INCOMPLETE") {
        return json(response, 400, { error: error.message, code: error.code });
      }
      throw error;
    }
  }
  // server-observed QA runner：命令目录固定在服务端，HTTP 只能选择跑哪些，不能改命令或 provenance。
  if (request.method === "GET" && pathname === "/api/release-record/runner") {
    return json(response, 200, state.releaseCommandRunner.snapshot());
  }
  if (request.method === "POST" && pathname === "/api/release-record/runner/run") {
    const payload = await body(request);
    try {
      const result = await state.releaseCommandRunner.run({
        commandIds: payload?.commandIds ?? null,
        // Client input is only an expectation. The runner always reads server HEAD itself.
        expectedSourceCommit: typeof payload?.sourceCommit === "string" ? payload.sourceCommit : null,
        // W1.1 一键收口：策略开关可由客户端选择，命令目录与判定仍固定在服务端。
        stopOnFailure: payload?.stopOnFailure === true,
      });
      return json(response, 200, {
        ...result,
        record: await collectLiveReleaseRecord(),
      });
    } catch (error) {
      const badRequest = [
        "RELEASE_RUNNER_INVALID_SELECTION",
        "RELEASE_RUNNER_UNKNOWN_COMMAND",
        "RELEASE_RUNNER_DUPLICATE_COMMAND",
      ];
      const conflict = [
        "RELEASE_RUNNER_BUSY",
        "RELEASE_RUNNER_SOURCE_COMMIT_MISMATCH",
        "RELEASE_RUNNER_DIRTY_WORKTREE",
      ];
      const unavailable = [
        "RELEASE_RUNNER_SOURCE_COMMIT_UNAVAILABLE",
        "RELEASE_RUNNER_WORKSPACE_STATE_UNAVAILABLE",
        "RELEASE_RUNNER_RUNTIME_IDENTITY_UNAVAILABLE",
        "RELEASE_RUNNER_CLOSED",
      ];
      if (badRequest.includes(error?.code) || conflict.includes(error?.code) || unavailable.includes(error?.code)) {
        const status = badRequest.includes(error.code) ? 400 : conflict.includes(error.code) ? 409 : 503;
        return json(response, status, {
          error: error.message,
          code: error.code,
          runId: error.runId ?? undefined,
          sourceCommit: error.sourceCommit ?? undefined,
          diffDigest: error.diffDigest ?? undefined,
        });
      }
      throw error;
    }
  }
  if (request.method === "GET" && pathname === "/api/readiness") {
    return json(response, 200, await collectLiveReadiness({ probeHealth: true }));
  }
  if (request.method === "POST" && pathname === "/api/readiness/draft") {
    return json(response, 200, await state.firstRunDraft.save(await body(request)));
  }
  if (request.method === "GET" && pathname === "/api/project-bridge") {
    // cwd query is ignored on purpose: clients cannot submit an arbitrary path.
    const requestedRunId = String(url.searchParams.get("runId") || "").trim();
    const run = requestedRunId ? structuredClone(state.orchestrator.get(requestedRunId)) : null;
    const workspace = run
      ? await attestRunWorkspace(run)
      : resolveRunWorkspace(null, { fallbackPath: state.repoRoot });
    return json(response, 200, await collectProjectBridge({
      cwd: workspace.path,
      runtime: {
        pid: state.pid,
        generation: state.generation,
        startedAt: state.startedAt,
      },
      processes: state.childRegistry.snapshot(),
      store: state.projectAnchors,
    }));
  }
  if (request.method === "POST" && pathname === "/api/workbench/git/plan") {
    const input = await body(request);
    const runId = String(input?.runId || "").trim();
    const run = runId ? state.orchestrator.get(runId) : null;
    const workspace = run
      ? await attestRunWorkspace(run)
      : resolveRunWorkspace(null, { fallbackPath: state.repoRoot });
    return json(response, 200, await gitActionBroker.plan({
      cwd: workspace.path,
      action: String(input?.action || ""),
      message: String(input?.message || ""),
      revalidateWorkspace: workspace.kind === "worktree"
        ? async () => attestRunWorkspace(state.orchestrator.get(runId))
        : null,
    }));
  }
  if (request.method === "POST" && pathname === "/api/workbench/git/execute") {
    const input = await body(request);
    return json(response, 200, await gitActionBroker.execute({
      planId: input?.planId,
      confirmation: input?.confirmation,
    }));
  }
  // Wave G v2：门闸清单（grant 账本 + 实现注册表；未授权/未实现即 501）
  if (request.method === "GET" && pathname === "/api/security/remote-gates") {
    return json(response, 200, state.remoteGates.snapshot());
  }
  if (request.method === "POST" && pathname === "/api/security/remote-gates/open") {
    const payload = await body(request);
    const gate = String(payload?.gate || payload?.id || "");
    try {
      state.remoteGates.assert(gate);
      return json(response, 200, { ok: true });
    } catch (error) {
      return json(response, error.httpStatus || 501, {
        ok: false,
        code: error.code || "REMOTE_GATE_BLOCKED",
        gate: error.gate || gate,
        message: error.message,
      });
    }
  }
  if (request.method === "POST" && pathname === "/api/security/remote-gates/grant") {
    const payload = await body(request);
    const gate = String(payload?.gate || payload?.id || "");
    try {
      const entry = await state.remoteGates.grant(gate, {
        source: String(payload?.source || "operator"),
        note: String(payload?.note || ""),
      });
      return json(response, 200, { ok: true, gate: entry });
    } catch (error) {
      return json(response, error.httpStatus || 501, { ok: false, code: error.code, gate, message: error.message });
    }
  }
  if (request.method === "POST" && pathname === "/api/security/remote-gates/revoke") {
    const payload = await body(request);
    const gate = String(payload?.gate || payload?.id || "");
    try {
      const entry = await state.remoteGates.revoke(gate, { source: String(payload?.source || "operator") });
      return json(response, 200, { ok: true, gate: entry });
    } catch (error) {
      return json(response, error.httpStatus || 501, { ok: false, code: error.code, gate, message: error.message });
    }
  }
  if (request.method === "POST" && pathname === "/api/runtime/reload") {
    return json(response, 200, await withRuntimeSeatMutation(() => state.reloadRuntime({ reason: "operator request" })));
  }
  if (request.method === "GET" && pathname === "/api/config/sources") {
    return json(response, 200, { sources: await state.configManager.listSources() });
  }
  if (request.method === "GET" && pathname === "/api/observability/summary") return json(response, 200, await state.observability.summary());
  if (request.method === "GET" && pathname === "/api/observability/ops") {
    return json(response, 200, collectOpsMetrics({
      orchestrator: state.orchestrator,
      approvalBroker: state.approvalBroker,
      healthService: state.healthService,
      now: Date.now(),
    }));
  }
  // 能力图谱（codeg 对标 P2）：skills 只读矩阵 + MCP 本地扫描（白名单字段，密钥面不外发）
  if (request.method === "GET" && pathname === "/api/capabilities") return json(response, 200, await state.capabilities.summary());
  // agent skill 启停（LO 可配置面）：负名单落 dataRoot，成员轮提示词按此过滤（真接线非摆设）
  if (request.method === "PUT" && pathname === "/api/capabilities/agent-skill") {
    const payload = await body(request);
    const agentId = String(payload?.agentId ?? "");
    const skill = String(payload?.skill ?? "");
    if (!agentId || !skill) throw Object.assign(new Error("agentId and skill are required"), { code: "VALIDATION_FAILED" });
    return json(response, 200, await state.capabilities.setAgentSkill(agentId, skill, payload?.enabled !== false));
  }
  // MCP 启停（claude.json 全局 server 隔离式）：mtime 乐观锁防覆写 Claude Code 并发写
  if (request.method === "POST" && pathname === "/api/capabilities/skills") {
    const payload = await body(request);
    return json(response, 201, await state.capabilities.createSkill(payload));
  }
  if (request.method === "POST" && pathname === "/api/capabilities/mcp/toggle") {
    const payload = await body(request);
    return json(response, 200, await state.capabilities.toggleMcpServer({
      name: String(payload?.name ?? ""),
      source: String(payload?.source ?? ""),
      action: String(payload?.action ?? ""),
      knownMtimeMs: Number(payload?.knownMtimeMs),
    }));
  }
  if (request.method === "GET" && pathname === "/api/observability/pulse") {
    return await runEventResponses.run("observability:pulse", response, async (signal) => {
      return json(response, 200, await collectPulse({ signal }));
    }, { request });
  }
  if (request.method === "GET" && pathname === "/api/observability/routegate") {
    return json(response, 200, await state.observability.routeGate({ days: Number(url.searchParams.get("days")) || 7 }));
  }
  if (request.method === "GET" && pathname === "/api/observability/delta") return json(response, 200, await state.observability.deltaLedger());
  if (request.method === "GET" && pathname === "/api/observability/handoffs") return json(response, 200, { handoffs: await state.observability.handoffs() });
  const handoffMatch = pathname.match(/^\/api\/observability\/handoffs\/([^/]+)$/);
  if (request.method === "GET" && handoffMatch) return json(response, 200, await state.observability.handoffContent(decodeURIComponent(handoffMatch[1])));
  if (request.method === "POST" && pathname === "/api/observability/drift") return json(response, 200, await state.observability.drift());
  // v4.0 Forge 统一搜索：handoff/doc/memory/session/skill 五源分组（空 q 回空 groups）
  if (request.method === "GET" && pathname === "/api/search") {
    return json(response, 200, await searchService.search({
      query: url.searchParams.get("q") ?? "",
      limit: Number(url.searchParams.get("limit")) || 50,
    }));
  }
  // v4.0 Forge 记忆浏览器：只读三根视图 + 全文检索（路径全部由仓库根派生）
  if (request.method === "GET" && pathname === "/api/memory") return json(response, 200, await memoryService.roots());
  if (request.method === "GET" && pathname === "/api/memory/search") {
    return json(response, 200, await memoryService.search({ query: url.searchParams.get("q") ?? "" }));
  }
  // 文件内容只读：root+name 或 rel path 必须命中服务端枚举清单（不接受任意路径），512KB 上限
  if (request.method === "GET" && pathname === "/api/memory/file") {
    return json(response, 200, await memoryService.read({
      root: url.searchParams.get("root") ?? "",
      name: url.searchParams.get("name") ?? "",
      path: url.searchParams.get("path") ?? "",
    }));
  }
  // W3.7 Guardrails 测试器：规则清单（只读）+ 路径命中预览（改权限/动文件前自测）
  if (request.method === "GET" && pathname === "/api/guardrails/rules") {
    return json(response, 200, await guardrailsService.rules());
  }
  // W3.6 记忆编辑：只允许 memory:* 根（MEMORY.md/auto-memory）；账本与 handoff 只读
  if (request.method === "PUT" && pathname === "/api/memory/file") {
    const payload = await body(request);
    return json(response, 200, await memoryService.write({
      root: payload?.root ?? "",
      name: payload?.name ?? "",
      path: payload?.path ?? "",
      content: payload?.content ?? "",
      expectedMtime: payload?.expectedMtime ?? null,
    }));
  }
  if (request.method === "POST" && pathname === "/api/guardrails/test") {
    const payload = await body(request);
    return json(response, 200, await guardrailsService.testPath(payload?.path ?? ""));
  }
  // W3.18 周报生成器：近 7 天 handoff/DELTA/run 聚合快照（只读，不落文件）
  if (request.method === "GET" && pathname === "/api/reports/weekly") {
    return json(response, 200, await weeklyReportService.report());
  }
  // W3.1 月度预算：GET 状态 / PUT 设定（warn ≥80%，exceeded ≥100%；只告警不拦 run）
  if (pathname === "/api/budget/monthly") {
    if (request.method === "GET") return json(response, 200, await monthlyBudgetService.status());
    if (request.method === "PUT") return json(response, 200, await monthlyBudgetService.setBudget(await body(request)));
  }
  // W3.8 安全巡检：POST 手动触发；GET 最近一次报告（无则 404 语义由 null 表达）
  if (request.method === "POST" && pathname === "/api/security/sweep") {
    return json(response, 200, await secretSweepService.sweep());
  }
  if (request.method === "GET" && pathname === "/api/security/sweep") {
    return json(response, 200, { report: await secretSweepService.latest() });
  }
  // W3.11 用户宏 CRUD（数据源 dataRoot/macros.json；expand 在 orchestrator 原生命令 fail-closed 前兜底）
  if (pathname === "/api/macros") {
    const macroStore = state.orchestrator.macroStore;
    if (!macroStore) throw Object.assign(new Error("macro store unavailable"), { code: "MACRO_STORE_UNAVAILABLE" });
    if (request.method === "GET") return json(response, 200, { macros: await macroStore.list() });
    if (request.method === "POST") return json(response, 200, await macroStore.create(await body(request)));
  }
  const macroMatch = pathname.match(/^\/api\/macros\/([^/]+)$/);
  if (request.method === "DELETE" && macroMatch) {
    const macroStore = state.orchestrator.macroStore;
    if (!macroStore) throw Object.assign(new Error("macro store unavailable"), { code: "MACRO_STORE_UNAVAILABLE" });
    return json(response, 200, await macroStore.remove(decodeURIComponent(macroMatch[1])));
  }
  // v4.0 Forge 项目脚手架：静态模板生成（零网络零安装）；dryRun 只出计划，dir 限根 home/仓库父目录
  // hostId 在场 → 远程 SFTP 写入（先过 sftp 门闸，不假装落到本机）
  if (request.method === "POST" && pathname === "/api/bootstrap/scaffold") {
    const payload = await body(request);
    if (payload?.hostId) {
      state.remoteGates.assert("sftp");
      const ssh = getSshService();
      if (!ssh) throw Object.assign(new Error("SSH service is not wired"), { code: "SSH_UNAVAILABLE", httpStatus: 503 });
      if (ssh._initPromise) await ssh._initPromise;
      return json(response, 200, await scaffoldRemoteProject(payload, { ssh }));
    }
    return json(response, 200, await scaffoldProject(payload, {
      homeDir: homedir(),
      allowedRoots: [homedir(), dirname(state.repoRoot)],
    }));
  }
  if (request.method === "GET" && pathname === "/api/sessions") {
    return json(response, 200, await state.sessions.list({ includeSummaries: url.searchParams.get("summaries") === "1" }));
  }
  if (request.method === "GET" && pathname === "/api/sessions/projects") {
    return json(response, 200, await state.sessions.projects({
      includeSummaries: url.searchParams.get("summaries") === "1",
      refresh: url.searchParams.get("refresh") === "1",
    }));
  }
  const previewMatch = pathname.match(/^\/api\/sessions\/claude\/([^/]+)\/([^/]+)\/preview$/);
  if (request.method === "GET" && previewMatch) {
    return json(response, 200, await state.sessions.preview({
      project: decodeURIComponent(previewMatch[1]),
      id: decodeURIComponent(previewMatch[2]),
    }));
  }
  // 通用预览（query 形）：codex 的 scope 含日期层级斜杠，走 query 参数而非路径段；
  // kimi/pi/cursor（v3.7 扩源）按 id 定位（kimi 走索引、pi 走限量扫描、cursor 走 vscdb 点查），无需 scope
  if (request.method === "GET" && pathname === "/api/sessions/preview") {
    const source = url.searchParams.get("source") ?? "claude";
    const id = url.searchParams.get("id") ?? "";
    if (source === "codex") {
      return json(response, 200, await state.sessions.previewCodex({ scope: url.searchParams.get("scope") ?? "", id }));
    }
    if (source === "kimi") return json(response, 200, await state.sessions.previewKimi({ id }));
    if (source === "pi") return json(response, 200, await state.sessions.previewPi({ id }));
    if (source === "cursor") return json(response, 200, await state.sessions.previewCursor({ id }));
    return json(response, 200, await state.sessions.preview({
      project: url.searchParams.get("project") ?? "",
      id,
    }));
  }

  if (request.method === "GET" && pathname === "/api/adapter-templates") {
    return json(response, 200, {
      templates: adapterTemplateCatalog(),
      providerApps: [...PROVIDER_APPS],
    });
  }
  if (request.method === "GET" && pathname === "/api/runtime-seats") {
    return json(response, 200, await runtimeSeatSnapshot());
  }
  if (request.method === "POST" && pathname === "/api/runtime-seats") {
    const seat = buildCustomRuntimeSeat(await body(request));
    const result = await mutateRuntimeSeats(`runtime-seat:create:${seat.id}`, (profiles) => {
      if (profiles.some((profile) => profile.id === seat.id)) {
        throw runtimeSeatError(`runtime seat already exists: ${seat.id}`, "RUNTIME_SEAT_EXISTS", { runtimeProfileId: seat.id });
      }
      profiles.push(seat);
      return seat;
    });
    return json(response, 201, {
      seat: configuredRuntimeSeatView(result.outcome),
      transaction: result.transaction,
    });
  }
  const runtimeSeatMatch = pathname.match(/^\/api\/runtime-seats\/([^/]+)$/);
  if (runtimeSeatMatch) {
    const runtimeProfileId = normalizeRuntimeSeatId(decodeURIComponent(runtimeSeatMatch[1]));
    if (request.method === "GET") {
      const snapshot = await runtimeSeatSnapshot();
      const seat = snapshot.seats.find((item) => item.id === runtimeProfileId);
      if (!seat) throw runtimeSeatError(`runtime seat not found: ${runtimeProfileId}`, "RUNTIME_SEAT_NOT_FOUND", { runtimeProfileId });
      return json(response, 200, { seat, source: snapshot.source, runtime: snapshot.runtime });
    }
    if (request.method === "PUT") {
      const patch = runtimeSeatPayload(await body(request));
      if (patch.id != null && normalizeRuntimeSeatId(patch.id) !== runtimeProfileId) {
        throw runtimeSeatError("runtime seat id is immutable");
      }
      const result = await mutateRuntimeSeats(`runtime-seat:update:${runtimeProfileId}`, (profiles) => {
        const index = profiles.findIndex((profile) => profile.id === runtimeProfileId);
        if (index < 0) {
          throw runtimeSeatError(`runtime seat not found: ${runtimeProfileId}`, "RUNTIME_SEAT_NOT_FOUND", { runtimeProfileId });
        }
        const existing = profiles[index];
        if (patch.builtin != null && patch.builtin !== existing.builtin) {
          throw runtimeSeatError("runtime seat builtin status is immutable");
        }
        const candidate = { ...existing, ...patch, id: runtimeProfileId, builtin: existing.builtin === true };
        const adapterChanged = String(existing.adapter || "").trim() !== String(candidate.adapter || "").trim();
        if (adapterChanged) {
          delete candidate.modelOptions;
          delete candidate.effortLevels;
        }
        const template = runtimeSeatTemplate(String(candidate.adapter || "").trim(), runtimeProfileId);
        const updated = normalizeRuntimeSeatControls(candidate, template);
        profiles[index] = updated;
        return updated;
      });
      return json(response, 200, {
        seat: configuredRuntimeSeatView(result.outcome),
        transaction: result.transaction,
      });
    }
    if (request.method === "DELETE") {
      const result = await mutateRuntimeSeats(`runtime-seat:delete:${runtimeProfileId}`, (profiles) => {
        const index = profiles.findIndex((profile) => profile.id === runtimeProfileId);
        if (index < 0) {
          throw runtimeSeatError(`runtime seat not found: ${runtimeProfileId}`, "RUNTIME_SEAT_NOT_FOUND", { runtimeProfileId });
        }
        if (profiles[index].builtin === true) {
          throw runtimeSeatError("builtin runtime seats cannot be deleted; copy or edit the seat instead", "FROZEN_BLOCK", { runtimeProfileId });
        }
        const references = runtimeSeatReferences(runtimeProfileId);
        if (references.length) {
          throw runtimeSeatError(`runtime seat is referenced by ${references.length} team member(s)`, "RUNTIME_SEAT_IN_USE", {
            runtimeProfileId,
            references,
          });
        }
        profiles.splice(index, 1);
        return { removed: runtimeProfileId };
      });
      return json(response, 200, { ...result.outcome, transaction: result.transaction });
    }
  }

  if (request.method === "GET" && pathname === "/api/teams") {
    // rejectedOnLoad 暴露给前端——团队被拒载必须可见，不许静默消失（烛 R11 建议）
    return json(response, 200, {
      teams: state.teams.list(),
      rejectedOnLoad: state.teams.rejectedOnLoad,
      storeStatus: state.teams.storeStatus,
    });
  }

  if (request.method === "GET" && pathname === "/api/team-members") {
    return json(response, 200, {
      members: state.teamMembers.list(),
      runtimeProfiles: state.runtimeCatalog,
    });
  }
  if (request.method === "POST" && pathname === "/api/team-members") {
    return json(response, 201, await state.teamMembers.create(await body(request)));
  }
  const memberMatch = pathname.match(/^\/api\/team-members\/([^/]+)$/);
  if (memberMatch) {
    const memberId = decodeURIComponent(memberMatch[1]);
    if (request.method === "GET") return json(response, 200, state.teamMembers.get(memberId));
    if (request.method === "PUT") return json(response, 200, await state.teamMembers.update(memberId, await body(request)));
    if (request.method === "DELETE") {
      const removed = await state.teamMembers.remove(memberId);
      await state.avatars.removeMemberFile(memberId);
      return json(response, 200, removed);
    }
  }
  if (request.method === "GET" && pathname === "/api/operator-profile") {
    return json(response, 200, await state.avatars.operatorProfile());
  }
  if (request.method === "PUT" && pathname === "/api/operator-profile") {
    return json(response, 200, await state.avatars.setOperatorProfile(await body(request)));
  }
  if (pathname === "/api/preferences") {
    // GET：文件不存在/损坏都返回 200 {}，读路径永不报错打断前端首帧。
    // 返回「磁盘 + 内存暂存区」合并视图：200ms 防抖窗口内写已确认的键立即可读。
    if (request.method === "GET") {
      const merged = { ...(await readPreferencesFromDisk()), ...(preferencesPending ?? {}) };
      return json(response, 200, { preferences: merged });
    }
    // PUT：白名单键合并进内存区，200ms 防抖一次落盘；连续多次 PUT 只产生一次写。
    if (request.method === "PUT") {
      let input;
      try {
        input = await body(request, MAX_PREFERENCES_BYTES + 4096);
      } catch (error) {
        if (error?.code === "INVALID_JSON") preferencesFail("request body must be valid JSON", "INVALID_PREFERENCES");
        throw error;
      }
      const clean = sanitizePreferenceInput(input);
      const current = await readPreferencesFromDisk();
      const merged = { ...current, ...(preferencesPending ?? {}), ...clean };
      preferencesPending = merged;
      schedulePreferencesFlush();
      return json(response, 200, { preferences: merged });
    }
    return json(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "unsupported method" } });
  }
  if (request.method === "POST" && pathname === "/api/avatars/operator") {
    const input = await body(request, MAX_AVATAR_REQUEST_BYTES);
    return json(response, 200, await state.avatars.setOperatorAvatar(input?.dataUrl));
  }
  if (request.method === "DELETE" && pathname === "/api/avatars/operator") {
    return json(response, 200, await state.avatars.clearOperatorAvatar());
  }
  if (request.method === "GET" && pathname === "/api/avatars/operator") {
    const file = await state.avatars.readOperatorFile();
    return sendBytes(response, 200, file.bytes, file.mimeType);
  }
  const memberAvatarMatch = pathname.match(/^\/api\/avatars\/members\/([^/]+)$/);
  if (memberAvatarMatch) {
    const memberId = decodeURIComponent(memberAvatarMatch[1]);
    if (request.method === "POST") {
      const input = await body(request, MAX_AVATAR_REQUEST_BYTES);
      return json(response, 200, await state.avatars.setMemberAvatar(memberId, input?.dataUrl));
    }
    if (request.method === "DELETE") {
      return json(response, 200, await state.avatars.clearMemberAvatar(memberId));
    }
    if (request.method === "GET") {
      const file = await state.avatars.readMemberFile(memberId);
      return sendBytes(response, 200, file.bytes, file.mimeType);
    }
  }
  if (request.method === "POST" && pathname === "/api/teams") return json(response, 201, await state.teams.create(await body(request)));
  // 全局壁纸（对标 dsh-wallpaper-engine：壁纸是全局设置而非实体属性）：复用
  // team-backgrounds 字节管线（avatars store 按 safeFileStem 落盘，伪 id "__global__"
  // 保留字符集内），不挂团队存在性校验——伪 id 不在团队表，get() 必 404，故独立路由。
  if (pathname === "/api/wallpapers/global") {
    const GLOBAL_WALLPAPER_ID = "__global__";
    if (request.method === "POST") {
      const input = await body(request, MAX_TEAM_BACKGROUND_REQUEST_BYTES);
      return json(response, 200, await state.avatars.setTeamBackground(GLOBAL_WALLPAPER_ID, input?.dataUrl));
    }
    if (request.method === "DELETE") {
      await state.avatars.clearTeamBackground(GLOBAL_WALLPAPER_ID);
      return json(response, 200, { ok: true });
    }
    if (request.method === "GET" || request.method === "HEAD") {
      const file = await state.avatars.readTeamBackgroundFile(GLOBAL_WALLPAPER_ID);
      // HEAD 只探存在性（Node 对 HEAD 自动丢弃 body，头信息照发）：客户端启动对账
      // hasCustom 用，避免为确认文件在不在而拉全量字节。
      return sendBytes(response, 200, request.method === "HEAD" ? Buffer.alloc(0) : file.bytes, file.mimeType);
    }
    return json(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "unsupported method" } });
  }
  const teamBackgroundMatch = pathname.match(/^\/api\/team-backgrounds\/([^/]+)$/);
  if (teamBackgroundMatch) {
    const teamId = decodeURIComponent(teamBackgroundMatch[1]);
    // 内置团队冻结：背景也属于其配置面，统一 FROZEN_BLOCK；预先 get() 保证 404 语义一致。
    if (!["POST", "GET", "DELETE"].includes(request.method)) {
      return json(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "unsupported method" } });
    }
    state.teams.get(teamId);
    if (request.method === "POST") {
      if (teamId === "team-514cc") {
        return json(response, 403, { error: { code: "FROZEN_BLOCK", message: "the builtin 514cc team is frozen and cannot be modified" } });
      }
      const input = await body(request, MAX_TEAM_BACKGROUND_REQUEST_BYTES);
      await state.avatars.setTeamBackground(teamId, input?.dataUrl);
      const team = await state.teams.markBackgroundImage(teamId);
      return json(response, 200, team);
    }
    if (request.method === "DELETE") {
      if (teamId === "team-514cc") {
        return json(response, 403, { error: { code: "FROZEN_BLOCK", message: "the builtin 514cc team is frozen and cannot be modified" } });
      }
      await state.avatars.clearTeamBackground(teamId);
      return json(response, 200, state.teams.get(teamId));
    }
    const file = await state.avatars.readTeamBackgroundFile(teamId);
    return sendBytes(response, 200, file.bytes, file.mimeType);
  }
  const teamMatch = pathname.match(/^\/api\/teams\/([^/]+)$/);
  if (teamMatch) {
    const teamId = decodeURIComponent(teamMatch[1]);
    if (request.method === "GET") return json(response, 200, state.teams.get(teamId));
    if (request.method === "PUT") return json(response, 200, await state.teams.update(teamId, await body(request)));
    if (request.method === "DELETE") {
      const removed = await state.teams.remove(teamId);
      await state.avatars.clearTeamBackground(teamId);
      return json(response, 200, removed);
    }
  }

  const teamInboxMatch = pathname.match(/^\/api\/teams\/([^/]+)\/inbox$/);
  if (request.method === "GET" && teamInboxMatch) {
    const teamId = decodeURIComponent(teamInboxMatch[1]);
    return await runEventResponses.run(`team-inbox:${teamId}`, response, async (signal) => {
      return json(response, 200, await collectLiveTeamInbox(teamId, {
        signal,
        limit: url.searchParams.get("limit"),
      }));
    }, { request });
  }

  const teamAttentionMatch = pathname.match(/^\/api\/teams\/([^/]+)\/attention$/);
  if (request.method === "GET" && teamAttentionMatch) {
    const teamId = decodeURIComponent(teamAttentionMatch[1]);
    const team = state.teams.get(teamId);
    return await runEventResponses.run(`team-attention:${teamId}`, response, async (signal) => {
      const inbox = await collectLiveTeamInbox(teamId, {
        signal,
        limit: url.searchParams.get("limit"),
      });
      return json(response, 200, collectTeamAttention({
        teamId,
        team,
        inbox,
        runs: state.orchestrator.list(),
        healthItems: state.healthService.peek(),
        roster: await readRuntimeRoster(),
      }));
    }, { request });
  }

  const teamInboxActionMatch = pathname.match(/^\/api\/teams\/([^/]+)\/inbox\/(answer|acknowledge|fail|expire)$/);
  if (request.method === "POST" && teamInboxActionMatch) {
    const teamId = decodeURIComponent(teamInboxActionMatch[1]);
    const action = teamInboxActionMatch[2];
    const team = state.teams.get(teamId);
    const input = await body(request);
    const runId = String(input?.runId ?? "").trim();
    const messageId = String(input?.messageId ?? input?.askId ?? "").trim();
    const run = structuredClone(state.orchestrator.get(runId));
    if ((run.teamId || "team-514cc") !== team.id) {
      throw Object.assign(new Error("inbox action must stay inside the selected team"), { code: "VALIDATION_FAILED" });
    }
    if (action === "answer") {
      const text = String(input?.text || "").trim();
      if (!text) {
        throw Object.assign(new Error("inbox answer text is required"), { code: "VALIDATION_FAILED" });
      }
      await state.orchestrator.bus.append(runId, {
        id: String(input?.answerId || `inbox-answer:${runId}:${messageId}`),
        from: "lo",
        to: String(input?.to || "team"),
        kind: "answer",
        text,
        refs: { answerToAskId: messageId },
      });
    }
    if (action === "acknowledge") {
      await state.orchestrator.bus.append(runId, {
        id: String(input?.ackId || `inbox-ack:${runId}:${messageId}`),
        from: "lo",
        to: "team",
        kind: "system",
        text: "ACK：已确认消息交付，不等于 provider 任务成功",
        refs: { ackToAskId: messageId },
      });
    }
    const record = await state.inboxLifecycle.apply({
      runId,
      messageId,
      conversationId: input?.conversationId || runId,
      action,
      actor: String(input?.actor || "lo"),
      text: String(input?.text || ""),
      idempotencyKey: input?.idempotencyKey || null,
      expectedRevision: input?.expectedRevision ?? null,
    });
    await state.eventStore.emit(
      `inbox.${action}`,
      { runId, messageId, teamId: team.id, state: record.state, ackMeansProviderSuccess: false },
      { runId, sensitivity: "internal", agentId: "lo" },
    ).catch(() => {});
    return json(response, 200, {
      schema: "514cc.inbox-lifecycle/v1",
      teamId: team.id,
      record,
      createdRun: false,
    });
  }

  // cc-switch 配置方式迁移：统一供应商档案 + 一键切换 live 配置（切换即备份）；list/live 永不含 apiKey 明文
  if (request.method === "GET" && pathname === "/api/providers") {
    return json(response, 200, { ...state.providers.list(), live: await state.providers.liveStatus() });
  }
  // live 热加载轮询面：只回 live 回读 + 漂移，不带档案列表——供应商页可见时高频轮询也很轻。
  // 外部工具/手改 CLI 配置（cc-switch、grok CLI 自己改档位）后，界面不必等手动刷新就跟上真实运行态。
  if (request.method === "GET" && pathname === "/api/providers/live") {
    return json(response, 200, { live: await state.providers.liveStatus() });
  }
  if (request.method === "POST" && pathname === "/api/providers") {
    const input = await body(request);
    return json(response, 201, await withRuntimeSeatMutation(() => state.providers.create(input)));
  }
  // cc-switch 3.18 预设供应商目录（claude/codex/gemini 三家，转换产物只读）
  if (request.method === "GET" && pathname === "/api/providers/presets") {
    return json(response, 200, await loadProviderPresets());
  }
  if (request.method === "POST" && pathname === "/api/providers/switch") {
    const input = await body(request);
    return json(response, 200, await withRuntimeSeatMutation(() => (
      state.providers.switchTo(String(input.app ?? ""), String(input.providerId ?? ""))
    )));
  }
  // 配置预览干跑：表单草稿经 applier 原逻辑跑一遍，回显「启用后完整文件」（不落盘；默认密钥掩码，reveal 显式取明文供编辑）
  if (request.method === "POST" && pathname === "/api/providers/preview") {
    const input = await body(request);
    return json(response, 200, await state.providers.previewSwitch(String(input.app ?? ""), input.provider ?? {}, { reveal: input.reveal === true }));
  }
  // 团队绑定扩展：teamId → 逐 app 应用绑定供应商（部分失败如实回报，不吞）
  if (request.method === "POST" && pathname === "/api/providers/apply-team") {
    const input = await body(request);
    return json(response, 200, await withRuntimeSeatMutation(() => (
      state.providers.applyTeamBindings(state.teams.get(String(input.teamId ?? "")), { apps: input.apps })
    )));
  }
  // cc-switch 完全迁移第二波——网络服务面与队列面（literal 路由必须先于 :id 匹配）：
  // 端点测速（speedtest.rs 复刻：并发 GET 热身+计时）
  if (request.method === "POST" && pathname === "/api/providers/test-endpoints") {
    const input = await body(request);
    return json(response, 200, { results: await testEndpoints(input.urls ?? [], input.timeoutSecs) });
  }
  if (request.method === "POST" && pathname === "/api/providers/fetch-models") {
    const input = await body(request, 16 * 1024);
    const stored = input.providerId ? state.providers.get(String(input.providerId)) : null;
    if (stored && !stored.apps?.codex && !stored.apps?.grokbuild) {
      throw Object.assign(new Error("provider is not enabled for Codex or Grok Build"), { code: "VALIDATION_FAILED" });
    }
    const requestedBaseUrl = String(input.baseUrl ?? "").trim();
    const baseUrl = requestedBaseUrl || stored?.baseUrl || "";
    let apiKey = String(input.apiKey ?? "").trim();
    if (!apiKey && stored?.apiKey) {
      let requestedOrigin = null;
      let storedOrigin = null;
      try {
        requestedOrigin = new URL(baseUrl).origin;
        storedOrigin = new URL(stored.baseUrl).origin;
      } catch {
        // fetchProviderModels owns detailed URL validation below.
      }
      if (!requestedOrigin || requestedOrigin !== storedOrigin) {
        throw Object.assign(new Error("请求地址已切换到不同来源；请重新输入 API Key 后再获取模型列表"), {
          code: "PROVIDER_CREDENTIAL_SCOPE_MISMATCH",
        });
      }
      apiKey = stored.apiKey;
    }
    return json(response, 200, await fetchProviderModels({
      baseUrl,
      apiKey,
      isFullUrl: input.isFullUrl ?? stored?.meta?.isFullUrl ?? false,
      customUserAgent: String(input.customUserAgent ?? stored?.meta?.proxyOverrides?.userAgent ?? ""),
    }));
  }
  // 用量脚本内置模板（UsageScriptModal PRESET_TEMPLATES 搬运）
  if (request.method === "GET" && pathname === "/api/providers/usage-templates") {
    return json(response, 200, { templates: USAGE_TEMPLATES });
  }
  // 未保存脚本试跑（test_usage_script 复刻：凭据可临时覆盖，不落盘）
  if (request.method === "POST" && pathname === "/api/providers/usage-test") {
    const input = await body(request);
    const provider = input.providerId ? state.providers.get(String(input.providerId)) : null;
    if (input.providerId && !provider) return json(response, 404, { error: { code: "SOURCE_NOT_FOUND", message: "provider not found" } });
    const script = {
      code: String(input.code ?? ""),
      apiKey: String(input.apiKey ?? "") || provider?.apiKey || "",
      baseUrl: String(input.baseUrl ?? "") || provider?.baseUrl || "",
      timeout: input.timeout ?? 10,
      accessToken: String(input.accessToken ?? "") || provider?.meta?.usageScript?.accessToken || "",
      userId: String(input.userId ?? "") || provider?.meta?.usageScript?.userId || "",
      templateType: String(input.templateType ?? "custom"),
    };
    try {
      return json(response, 200, await queryUsageScript(script));
    } catch (error) {
      return json(response, 200, { success: false, data: null, error: error.message, code: error.code ?? null });
    }
  }
  // 排序（update_providers_sort_order 复刻）
  if (request.method === "POST" && pathname === "/api/providers/sort") {
    const input = await body(request);
    return json(response, 200, await state.providers.sort(input.orderedIds, { app: input.app ?? null }));
  }
  // 导入导出（export/import config 复刻；默认掩码导出，includeSecrets 显式才带明文）
  if (request.method === "GET" && pathname === "/api/providers/export") {
    return json(response, 200, state.providers.exportProviders({ includeSecrets: url.searchParams.get("includeSecrets") === "1" }));
  }
  if (request.method === "POST" && pathname === "/api/providers/import") {
    const input = await body(request);
    return json(response, 200, await withRuntimeSeatMutation(() => (
      state.providers.importProviders(input, { mode: String(input.mode ?? "merge") })
    )));
  }
  if (request.method === "POST" && pathname === "/api/providers/parse-deeplink") {
    const input = await body(request);
    return json(response, 200, { resource: "provider", preview: maskSensitivePreview(parseDeeplink(String(input.url ?? ""))) });
  }
  // ccswitch:// 深链接导入（粘贴 URL 解析，不注册系统协议）
  if (request.method === "POST" && pathname === "/api/providers/import-deeplink") {
    const input = await body(request);
    const parsed = parseDeeplink(String(input.url ?? ""));
    return json(response, 201, await state.providers.create(parsed));
  }
  // 环境变量冲突检查（env_checker 514cc 化）
  if (request.method === "GET" && pathname === "/api/providers/env-conflicts") {
    return json(response, 200, state.providers.envConflicts());
  }
  // live 配置备份台账与一键回退（本机侧补齐远程 graph/backup 同款闭环；literal 段先于 :id）
  if (request.method === "GET" && pathname === "/api/providers/backups") {
    return json(response, 200, await state.providers.listBackups({ app: url.searchParams.get("app") || null }));
  }
  const backupMatch = pathname.match(/^\/api\/providers\/backups\/([^/]+)(\/restore)?$/);
  if (backupMatch) {
    const backupName = decodeURIComponent(backupMatch[1]);
    if (request.method === "GET" && !backupMatch[2]) {
      return json(response, 200, await state.providers.readBackup(backupName));
    }
    if (request.method === "POST" && backupMatch[2]) {
      const input = await body(request);
      return json(response, 200, await state.providers.restoreBackup(backupName, {
        expectedDigest: typeof input?.expectedDigest === "string" ? input.expectedDigest : null,
      }));
    }
    if (request.method === "DELETE" && !backupMatch[2]) {
      return json(response, 200, await state.providers.removeBackup(backupName));
    }
  }
  // common config snippet：per-app 通用片段（切换时并入 live 写入）
  if (request.method === "GET" && pathname === "/api/providers/common-config") {
    return json(response, 200, state.providers.commonConfigView({ includeSecrets: url.searchParams.get("includeSecrets") === "1" }));
  }
  if (request.method === "PUT" && pathname === "/api/providers/common-config") {
    const input = await body(request);
    return json(response, 200, await state.providers.setCommonConfig(String(input.app ?? ""), input.commonConfig ?? ""));
  }
  // failover 队列与自动转移开关（per app；literal 段带 app 参数）
  const failoverMatch = pathname.match(/^\/api\/providers\/failover\/([^/]+)$/);
  if (failoverMatch) {
    const app = decodeURIComponent(failoverMatch[1]);
    if (request.method === "GET") return json(response, 200, state.providers.getFailover(app));
    if (request.method === "PUT") return json(response, 200, await state.providers.setFailover(app, await body(request)));
  }
  const providerDuplicateMatch = pathname.match(/^\/api\/providers\/([^/]+)\/duplicate$/);
  if (request.method === "POST" && providerDuplicateMatch) {
    const providerId = decodeURIComponent(providerDuplicateMatch[1]);
    return json(response, 201, await withRuntimeSeatMutation(() => state.providers.duplicate(providerId)));
  }
  const providerMatch = pathname.match(/^\/api\/providers\/([^/]+)$/);
  if (providerMatch) {
    const providerId = decodeURIComponent(providerMatch[1]);
    if (request.method === "GET") {
      return json(response, 200, state.providers.view(providerId, { includeSecrets: url.searchParams.get("includeSecrets") === "1" }));
    }
    if (request.method === "PUT") {
      const input = await body(request);
      return json(response, 200, await withRuntimeSeatMutation(() => state.providers.update(providerId, input)));
    }
    if (request.method === "DELETE") {
      return json(response, 200, await withRuntimeSeatMutation(() => state.providers.remove(providerId)));
    }
  }
  // 连通性检查（stream_check.rs 复刻）：可达性探测 + autoFailover 开启时失败自动转移
  const providerCheckMatch = pathname.match(/^\/api\/providers\/([^/]+)\/check$/);
  if (request.method === "POST" && providerCheckMatch) {
    const providerId = decodeURIComponent(providerCheckMatch[1]);
    const provider = state.providers.get(providerId);
    const input = await body(request).catch(() => ({}));
    const testConfig = { ...provider.meta?.testConfig, ...(input.testConfig ?? {}) };
    const result = await checkReachability(provider.baseUrl, testConfig);
    let failover = null;
    if (!result.success) {
      for (const app of PROVIDER_APPS) {
        if (!provider.apps[app] || state.providers.current[app] !== providerId) continue;
        failover = await state.providers.failoverNext(app, providerId);
        if (failover?.switched) break;
      }
    }
    return json(response, 200, { ...result, failover });
  }
  // 模型可用性真实请求（testConfig.testModel 落地：回答鉴权/模型是否正确）
  const providerModelTestMatch = pathname.match(/^\/api\/providers\/([^/]+)\/model-test$/);
  if (request.method === "POST" && providerModelTestMatch) {
    const providerId = decodeURIComponent(providerModelTestMatch[1]);
    const provider = state.providers.get(providerId);
    const input = await body(request).catch(() => ({}));
    const app = String(input.app ?? "");
    const effective = input.testConfig && typeof input.testConfig === "object"
      ? { ...provider, meta: { ...(provider.meta ?? {}), testConfig: { ...(provider.meta?.testConfig ?? {}), ...input.testConfig } } }
      : provider;
    return json(response, 200, await testModelRequest(effective, app));
  }
  // 已保存用量脚本查询（query_usage 复刻）；无/未启用脚本时回落 one-api 计费端点缺省探测
  const providerUsageMatch = pathname.match(/^\/api\/providers\/([^/]+)\/usage$/);
  if (request.method === "POST" && providerUsageMatch) {
    const providerId = decodeURIComponent(providerUsageMatch[1]);
    const provider = state.providers.get(providerId);
    const result = await queryProviderUsage(provider);
    if (!result.success && (result.code === "USAGE_SCRIPT_MISSING" || result.code === "USAGE_DISABLED")) {
      return json(response, 200, await defaultBillingProbe(provider));
    }
    return json(response, 200, result);
  }

  if (request.method === "GET" && pathname === "/api/projects") {
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    return json(response, 200, {
      schema: "514cc.projects/v1",
      revision: state.projects.status().revision,
      projects: state.projects.list({ includeArchived }),
    });
  }
  if (request.method === "POST" && pathname === "/api/projects") {
    const project = await state.projects.ensure(await body(request));
    return json(response, 201, { schema: "514cc.project/v1", project, revision: state.projects.status().revision });
  }
  // Project IDs are deterministic 16-char hex digests. Keeping this route
  // shape strict prevents legacy endpoints such as /api/projects/prefs from
  // being mistaken for a project record.
  const projectMatch = pathname.match(/^\/api\/projects\/([0-9a-f]{16})$/i);
  if (request.method === "GET" && projectMatch) {
    return json(response, 200, {
      schema: "514cc.project/v1",
      project: state.projects.get(decodeURIComponent(projectMatch[1])),
      revision: state.projects.status().revision,
    });
  }
  if (request.method === "PATCH" && projectMatch) {
    const project = await state.projects.update(decodeURIComponent(projectMatch[1]), await body(request));
    return json(response, 200, { schema: "514cc.project/v1", project, revision: state.projects.status().revision });
  }

  if (request.method === "GET" && pathname === "/api/conversations") {
    const includeHidden = url.searchParams.get("includeHidden") === "1";
    const includeDeleted = url.searchParams.get("includeDeleted") === "1";
    return json(response, 200, {
      schema: "514cc.conversations/v2",
      revision: state.conversations.status().revision,
      conversations: state.conversations.list({ includeHidden, includeDeleted }),
    });
  }
  if (request.method === "POST" && pathname === "/api/conversations") {
    const input = await body(request);
    const memberIds = input?.kind === "direct"
      ? [input.directMemberId]
      : Array.isArray(input?.memberIds) ? input.memberIds : [];
    for (const memberId of [...new Set(memberIds.filter(Boolean))]) state.teamMembers.get(String(memberId));
    const conversation = await state.conversations.create(input);
    return json(response, 201, { schema: "514cc.conversation/v2", conversation, revision: state.conversations.status().revision });
  }
  const conversationMessagesMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (request.method === "POST" && conversationMessagesMatch) {
    const conversationId = decodeURIComponent(conversationMessagesMatch[1]);
    const input = await body(request) ?? {};
    delete input.waitForTurn;
    delete input.conversationId;
    delete input.projectId;
    const result = await state.orchestrator.conversationMessage(conversationId, {
      ...input,
      waitForTurn: false,
    });
    return json(response, result.created ? 202 : 200, runForPublic(result.run));
  }
  const conversationDuplicateMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/duplicate$/);
  if (request.method === "POST" && conversationDuplicateMatch) {
    const conversation = await state.conversations.duplicate(
      decodeURIComponent(conversationDuplicateMatch[1]),
      await body(request),
    );
    return json(response, 201, { schema: "514cc.conversation/v2", conversation, revision: state.conversations.status().revision });
  }
  if (request.method === "DELETE" && pathname === "/api/conversations/deleted") {
    const result = await state.conversations.purgeDeleted(await body(request) || {});
    return json(response, 200, { schema: "514cc.conversations-purge/v1", ...result });
  }
  const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (request.method === "GET" && conversationMatch) {
    return json(response, 200, {
      schema: "514cc.conversation/v2",
      conversation: state.conversations.get(decodeURIComponent(conversationMatch[1])),
      revision: state.conversations.status().revision,
    });
  }
  if (request.method === "PATCH" && conversationMatch) {
    const input = await body(request);
    for (const memberId of [...new Set((Array.isArray(input?.memberIds) ? input.memberIds : []).filter(Boolean))]) {
      state.teamMembers.get(String(memberId));
    }
    const conversation = await state.conversations.update(decodeURIComponent(conversationMatch[1]), input);
    return json(response, 200, { schema: "514cc.conversation/v2", conversation, revision: state.conversations.status().revision });
  }
if (request.method === "DELETE" && conversationMatch) {
    const input = await body(request);
    const conversation = await state.conversations.remove(decodeURIComponent(conversationMatch[1]), input || {});
    return json(response, 200, { schema: "514cc.conversation/v2", conversation, revision: state.conversations.status().revision });
  }

  if (request.method === "GET" && pathname === "/api/runs") return json(response, 200, { runs: runsForPublic(state.orchestrator.list()) });
  if (request.method === "POST" && pathname === "/api/runs") return json(response, 202, runForPublic(await state.orchestrator.create(await body(request))));
  // W3.5 A/B shadow run：同一任务双成员并行（对照腿强制 plan 只读），对比走 /api/runs/compare
  if (request.method === "POST" && pathname === "/api/runs/shadow") {
    const payload = await body(request);
    const { primary, shadow } = await state.orchestrator.createShadowPair(payload?.input ?? {});
    return json(response, 202, {
      primary: runForPublic(primary),
      shadow: runForPublic(shadow),
      compare: `/api/runs/compare?a=${encodeURIComponent(primary.id)}&b=${encodeURIComponent(shadow.id)}`,
    });
  }
  // W3.5：双 run 元数据对比矩阵 + 可分享 Markdown 报告
  if (request.method === "GET" && pathname === "/api/runs/compare") {
    const aId = url.searchParams.get("a") ?? "";
    const bId = url.searchParams.get("b") ?? "";
    if (!aId || !bId) throw Object.assign(new Error("query params a and b are required"), { code: "VALIDATION_FAILED" });
    if (aId === bId) throw Object.assign(new Error("a and b must differ"), { code: "VALIDATION_FAILED" });
    const left = state.orchestrator.get(aId);
    const right = state.orchestrator.get(bId);
    const generatedAt = new Date().toISOString();
    const comparison = compareRuns(left, right);
    return json(response, 200, { schema: "514cc.run-compare/v1", generatedAt, ...comparison, markdown: renderCompareMarkdown({ generatedAt, comparison }) });
  }
  if (request.method === "POST" && pathname === "/api/runs/clear-finished") return json(response, 200, await state.orchestrator.clearFinished());
  const runMatch = pathname.match(/^\/api\/runs\/([0-9a-fA-F-]+)$/);
  if (request.method === "GET" && runMatch) {
    const run = state.orchestrator.get(runMatch[1]);
    if (!run) throw Object.assign(new Error(`run not found: ${runMatch[1]}`), { code: "RUN_NOT_FOUND" });
    return json(response, 200, runForPublic(run));
  }
  // run 产物 diff（codeg 对标 P2）：逻辑在 src/run-diff.mjs（可注入 runner 单测）；超 2MB 如实 OUTPUT_LIMIT
  const runDiffMatch = pathname.match(/^\/api\/runs\/([0-9a-fA-F-]+)\/diff$/);
  if (request.method === "GET" && runDiffMatch) {
    const run = state.orchestrator.get(runDiffMatch[1]);
    if (!run) throw Object.assign(new Error(`run not found: ${runDiffMatch[1]}`), { code: "RUN_NOT_FOUND" });
    const diff = await runDiffForRun(run);
    // W3.17 会话对比报告：?format=markdown 渲染可分享报告（同一只读数据源）
    if (url.searchParams.get("format") === "markdown") {
      return json(response, 200, { runId: diff.runId, format: "markdown", markdown: renderDiffMarkdown(diff) });
    }
    return json(response, 200, diff);
  }
  const runSettlementMatch = pathname.match(/^\/api\/runs\/([0-9a-fA-F-]+)\/settlement$/);
  if (request.method === "GET" && runSettlementMatch) {
    const runId = runSettlementMatch[1];
    const rawRun = state.orchestrator.get(runId);
    if (!rawRun) throw Object.assign(new Error(`run not found: ${runId}`), { code: "RUN_NOT_FOUND" });
    const run = structuredClone(rawRun);
    const includeDiff = url.searchParams.get("diff") !== "0";
    // Settlement 的 artifact 投影必须读取同一份治理证据源；只传 run 会让
    // handoff/DELTA 永远退化为空列表。列表接口本身有界，读取失败仍由
    // collectRunSettlement 的 fail-closed 结果承接，不把缺失证据伪装成已发布。
    const [handoffsResult, deltaResult] = await Promise.all([
      state.observability.handoffs({ limit: 80, strict: true })
        .then((value) => ({ ok: true, value }))
        .catch((error) => ({ ok: false, error })),
      state.observability.deltaLedger({ recent: 80, strict: true })
        .then((value) => ({ ok: true, value }))
        .catch((error) => ({ ok: false, error })),
    ]);
    const handoffs = handoffsResult.ok && Array.isArray(handoffsResult.value) ? handoffsResult.value : [];
    const deltaLedger = deltaResult.ok && deltaResult.value && typeof deltaResult.value === "object" ? deltaResult.value : {};
    const evidenceIssues = [
      ["handoffs", handoffsResult],
      ["delta-ledger", deltaResult],
    ].filter(([, result]) => !result.ok).map(([id, result]) => ({
      id,
      ok: false,
      reason: result.error?.code
        ? `证据源 ${id} 不可用（${String(result.error.code).slice(0, 80)}）`
        : `证据源 ${id} 不可用`,
    }));
    return json(response, 200, await collectRunSettlement({
      run,
      includeDiff,
      handoffs: handoffs.map((file) => ({ ...file, exists: true })),
      deltas: Array.isArray(deltaLedger?.deltas) ? deltaLedger.deltas : [],
      evidenceSource: { status: evidenceIssues.length ? "unavailable" : "available", issues: evidenceIssues },
    }));
  }
  if (request.method === "POST" && pathname === "/api/system/clipboard-image") {
    const input = await body(request, MAX_CLIPBOARD_IMAGE_REQUEST_BYTES);
    return json(response, 201, await saveClipboardImage({ dataUrl: input?.dataUrl, dataRoot: state.dataRoot }));
  }
  if (request.method === "POST" && pathname === "/api/system/clipboard-image/claim") {
    const input = await body(request);
    return json(response, 200, await claimPendingClipboardUpload({
      dataRoot: state.dataRoot,
      path: input?.path,
      claimToken: input?.claimToken,
    }));
  }
  if (request.method === "POST" && pathname === "/api/system/clipboard-images/cleanup") {
    const input = await body(request);
    return json(response, 200, await cleanupClipboardImages({
      dataRoot: state.dataRoot,
      confirmation: input?.confirmation,
      protectedPaths: () => [
        ...state.orchestrator.list()
          .flatMap((run) => Array.isArray(run.sources) ? run.sources : [])
          .map((source) => source?.path)
          .filter(Boolean),
        ...(Array.isArray(input?.protectedPaths) ? input.protectedPaths : []),
      ],
    }));
  }
  if (request.method === "POST" && pathname === "/api/system/pick-directory") {
    // 弹本机资源管理器目录选择框（Console 是 loopback 本地服务的特权面）。
    // 单例锁：同时只允许一个系统对话框，重复请求 409 而非叠窗。
    if (state.pickingDirectory) return json(response, 409, { error: { code: "PICKER_BUSY", message: "a directory picker is already open" } });
    state.pickingDirectory = true;
    try {
      const script = [
        // stdout 编码钉死 UTF-8：中文 Windows 的 powershell 管道默认 OEM 码页（GBK），
        // runProcess 按 UTF-8 解码会把含中文的路径整条打成 U+FFFD（附件/项目地址静默失效）
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "Add-Type -AssemblyName System.Windows.Forms",
        "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$f.Description = '选择会话项目地址'",
        "$f.ShowNewFolderButton = $true",
        "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }",
        "$owner.Show(); $owner.Activate()",
        "$result = $f.ShowDialog($owner)",
        "$owner.Close()",
        "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }",
      ].join("; ");
      const picked = await runProcess("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
        timeoutMs: 5 * 60_000, // 给用户足够的翻找时间
        maxOutputBytes: 64 * 1024,
      });
      const path = picked.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      return json(response, 200, path ? { path } : { cancelled: true });
    } finally {
      state.pickingDirectory = false;
    }
  }
  if (request.method === "POST" && pathname === "/api/system/pick-file") {
    // 附件文件选择框（与目录选择器共用单例锁：同时只弹一个系统对话框）
    if (state.pickingDirectory) return json(response, 409, { error: { code: "PICKER_BUSY", message: "a system picker is already open" } });
    state.pickingDirectory = true;
    try {
      const script = [
        // stdout 编码钉死 UTF-8：中文 Windows 的 powershell 管道默认 OEM 码页（GBK），
        // runProcess 按 UTF-8 解码会把含中文的路径整条打成 U+FFFD（附件/项目地址静默失效）
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "Add-Type -AssemblyName System.Windows.Forms",
        "$f = New-Object System.Windows.Forms.OpenFileDialog",
        "$f.Title = '附加资料文件'",
        "$f.Multiselect = $true",
        "$f.CheckFileExists = $true",
        "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }",
        "$owner.Show(); $owner.Activate()",
        "$result = $f.ShowDialog($owner)",
        "$owner.Close()",
        "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $f.FileNames | ForEach-Object { Write-Output $_ } }",
      ].join("; ");
      const picked = await runProcess("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
        timeoutMs: 5 * 60_000,
        maxOutputBytes: 256 * 1024, // Multiselect 数百条长路径也容得下
      });
      const paths = picked.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return json(response, 200, paths.length ? { paths } : { cancelled: true });
    } finally {
      state.pickingDirectory = false;
    }
  }
  if (request.method === "POST" && pathname === "/api/sessions/reveal") {
    // 资源管理器中定位历史会话 jsonl（路径由服务端安全解析，不信任前端拼装）
    const { source, project, scope, id } = await body(request);
    const filePath = await state.sessions.resolveFilePath({ source: source ?? "claude", project, scope, id });
    revealInFileManager(filePath, { select: true });
    return json(response, 200, { revealed: filePath });
  }
  if (request.method === "POST" && pathname === "/api/system/reveal") {
    // 在资源管理器中打开（本地特权面）：目录直接开，文件定位选中；路径必须真实存在
    const { path } = await body(request);
    const target = String(path || "").trim();
    if (!target) throw Object.assign(new Error("path is required"), { code: "VALIDATION_FAILED" });
    let info;
    try {
      info = await stat(target);
    } catch {
      throw Object.assign(new Error(`path does not exist: ${target}`), { code: "SOURCE_NOT_FOUND" });
    }
    revealInFileManager(target, { select: !info.isDirectory() });
    return json(response, 200, { revealed: target });
  }
  if (request.method === "POST" && pathname === "/api/system/worktree") {
    // 在新工作树中继续：基于该目录 HEAD 建 detached worktree（同级 <name>-wt-<stamp>），返回新路径
    const { path } = await body(request);
    const target = String(path || "").trim();
    if (!target) throw Object.assign(new Error("path is required"), { code: "VALIDATION_FAILED" });
    const probe = await runProcess("git", ["-C", target, "rev-parse", "--show-toplevel"], { timeoutMs: 15_000, maxOutputBytes: 16 * 1024 });
    if (probe.code !== 0) {
      throw Object.assign(new Error(`${target} 不在 git 仓库内，无法创建工作树：${probe.stderr.trim().slice(0, 160)}`), { code: "VALIDATION_FAILED" });
    }
    const repoTop = probe.stdout.trim().split(/\r?\n/).pop();
    // 随机后缀防同秒并发撞路径（对照 orchestrator 同款修复：秒级时间戳不是唯一性保证）
    const stamp = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const worktreePath = join(dirname(repoTop), `${basename(repoTop)}-wt-${stamp}`);
    const created = await runProcess("git", ["-C", repoTop, "worktree", "add", "--detach", worktreePath], { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });
    if (created.code !== 0) {
      throw Object.assign(new Error(`git worktree add 失败：${created.stderr.trim().slice(0, 200)}`), { code: "VALIDATION_FAILED" });
    }
    await state.orchestrator.worktreeLedger?.recordCreated({ path: worktreePath, base: repoTop, runId: null, source: "manual" }).catch(() => {});
    return json(response, 200, { worktree: worktreePath, base: repoTop });
  }
  // W3.10 worktree 台账视图：折叠后的建树/清树记录（只读，供 UI 列表与孤儿核对）
  if (request.method === "GET" && pathname === "/api/system/worktrees") {
    const ledger = state.orchestrator.worktreeLedger;
    if (!ledger) return json(response, 200, { schema: "514cc.worktree-ledger/v1", total: 0, activeCount: 0, worktrees: [] });
    return json(response, 200, await ledger.list());
  }
  // W3.10 清理入口：只允许清理台账内"活跃"的工作树（fail-closed：不在台账 = 不认识 = 不动）
  if (request.method === "DELETE" && pathname === "/api/system/worktrees") {
    const target = String(url.searchParams.get("path") ?? "").trim();
    if (!target) throw Object.assign(new Error("query param path is required"), { code: "VALIDATION_FAILED" });
    const ledger = state.orchestrator.worktreeLedger;
    const view = ledger ? await ledger.list() : { worktrees: [] };
    const entry = view.worktrees.find((item) => item.path === target);
    if (!entry || entry.removedAt) {
      throw Object.assign(new Error("该工作树不在活跃台账中，拒绝清理（防误删未知目录）"), { code: "WORKTREE_UNKNOWN" });
    }
    const base = entry.base || dirname(target);
    const removed = await runProcess("git", ["-C", base, "worktree", "remove", "--force", target], { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });
    if (removed.code !== 0) {
      throw Object.assign(new Error(`git worktree remove 失败：${removed.stderr.trim().slice(0, 200)}`), { code: "WORKTREE_REMOVE_FAILED" });
    }
    await ledger?.recordRemoved({ path: target }).catch(() => {});
    return json(response, 200, { ok: true, path: target });
  }
  if (pathname === "/api/projects/prefs") {
    // 项目侧栏偏好（置顶/重命名/隐藏）：dataRoot 下单文件，键=归一化项目路径
    const prefsPath = join(state.dataRoot, "project-prefs.json");
    if (request.method === "GET") {
      return json(response, 200, await readProjectPrefs(prefsPath));
    }
    if (request.method === "PUT") {
      const payload = await body(request);
      const baseRevision = Number(payload?.baseRevision);
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
        throw Object.assign(new Error("baseRevision must be a non-negative safe integer"), { code: "VALIDATION_FAILED" });
      }
      const clean = cleanProjectPrefs({ ...payload, revision: 0 });
      const write = projectPrefsWriteChain.catch(() => {}).then(async () => {
        const current = await readProjectPrefs(prefsPath);
        if (current.revision !== baseRevision) {
          throw Object.assign(new Error(`project prefs revision changed from ${baseRevision} to ${current.revision}`), {
            code: "PREFS_REVISION_MISMATCH",
            currentRevision: current.revision,
          });
        }
        const nextPrefs = { revision: current.revision + 1, projects: clean.projects, sessions: clean.sessions };
        await atomicWriteProjectPrefs(prefsPath, nextPrefs);
        return nextPrefs;
      });
      projectPrefsWriteChain = write;
      return json(response, 200, await write);
    }
  }
  if (request.method === "POST" && pathname === "/api/projects/delete-sessions") {
    // 移除项目时的可选同步删除：会话文件移入 dataRoot/trash 隔离区（系统目录清空，仍可恢复）
    const { project, path } = await body(request);
    if (typeof project !== "string" || !project.trim()) {
      throw Object.assign(new Error("project is required"), { code: "VALIDATION_FAILED" });
    }
    const result = await state.sessions.deleteProjectSessions({
      project: project.trim(),
      path: typeof path === "string" ? path : null,
      trashRoot: join(state.dataRoot, "trash"),
    });
    return json(response, 200, result);
  }
  if (request.method === "POST" && pathname === "/api/projects/archive-finished") {
    const { projectId, cwd } = await body(request);
    if (String(projectId || "").trim()) {
      return json(response, 200, await state.orchestrator.archiveFinishedByProjectId(projectId));
    }
    if (!String(cwd || "").trim()) throw Object.assign(new Error("projectId or cwd is required"), { code: "VALIDATION_FAILED" });
    return json(response, 200, await state.orchestrator.archiveFinishedByCwd(cwd));
  }

  const runEventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (request.method === "GET" && runEventsMatch) {
    // per-run 全量事件回放——不受全局最近窗口限制，供前端重建长会话完整历史（含工具过程）
    const runId = decodeURIComponent(runEventsMatch[1]);
    return await runEventResponses.run(runId, response, async (signal) => {
      let run = null;
      try {
        run = state.orchestrator.get(runId);
      } catch (error) {
        if (error?.code !== "RUN_NOT_FOUND") throw error;
      }
      const representation = selectRunHistoryRepresentation(request.headers.accept);
      if (!representation) {
        throw Object.assign(new Error("Accept does not allow application/json or application/x-ndjson"), {
          code: "NOT_ACCEPTABLE",
        });
      }
      const events = await state.eventStore.listByRun(runId, 5000, { signal });
      const uiView = url.searchParams.get("view") === "ui";
      const projectEvent = (event) => eventForPublic(event, run, uiView);
      if (representation === "ndjson") {
        return ndjson(response, events, { transform: projectEvent });
      }
      return json(response, 200, { events: events.map(projectEvent) });
    }, { request });
  }
  const replayMatch = pathname.match(/^\/api\/runs\/([^/]+)\/replay$/);
  if (request.method === "GET" && replayMatch) {
    const runId = decodeURIComponent(replayMatch[1]);
    return await runEventResponses.run(`replay:${runId}`, response, async (signal) => {
      const run = structuredClone(state.orchestrator.get(runId));
      const relatedApprovals = structuredClone(state.approvalBroker.list().filter((item) => item.runId === runId));
      const [busRead, events] = await Promise.all([
        state.orchestrator.bus.readTail(runId, {
          maxBytes: MISSION_CONTROL_LIMITS.busBytes,
          maxMessages: MISSION_CONTROL_LIMITS.busMessages,
          signal,
        }),
        state.eventStore.listByRun(runId, 500, { signal }),
      ]);
      return json(response, 200, projectRunReplay({
        run,
        events,
        busMessages: busRead.messages,
        approvals: relatedApprovals,
        eventsMayBeTruncated: events.length === 500,
        busTruncated: busRead.diagnostics?.truncated?.bytes === true || busRead.diagnostics?.truncated?.messages === true,
      }));
    }, { request });
  }
  const runBusMatch = pathname.match(/^\/api\/runs\/([^/]+)\/bus$/);
  if (request.method === "GET" && runBusMatch) {
    // v3.6 社会模拟编排：拓扑只消费有界尾部；诊断与 Mission Control 使用同一审计语义。
    const runId = decodeURIComponent(runBusMatch[1]);
    return await runEventResponses.run(`bus:${runId}`, response, async (signal) => {
      // 先确认 run 存在（已清除的 run 不许继续读旧 bus）；runId 白名单在 bus.file() fail-closed。
      const run = structuredClone(state.orchestrator.get(runId));
      if (testBusTailGateEnabled) await testBusTailGate.wait(signal);
      else if (testBusTailReadDelayMs > 0) await delay(testBusTailReadDelayMs, undefined, { signal });
      const result = await state.orchestrator.bus.readTail(runId, {
        maxBytes: MISSION_CONTROL_LIMITS.busBytes,
        maxMessages: MISSION_CONTROL_LIMITS.busMessages,
        signal,
      });
      return json(response, 200, {
        messages: result.messages,
        diagnostics: auditBusDiagnostics(run, result.diagnostics, result.messages.length),
      });
    }, { request });
  }
  const missionMatch = pathname.match(/^\/api\/runs\/([^/]+)\/mission$/);
  if (request.method === "GET" && missionMatch) {
    // Mission Control is a bounded read model, never a second orchestration state store.
    // Confirm the run before touching auxiliary files so cleared/unknown runs cannot expose stale assets.
    const runId = decodeURIComponent(missionMatch[1]);
    return await runEventResponses.run(`mission:${runId}`, response, async (signal) => {
      // Capture one immutable orchestration instant before auxiliary reads. A
      // later bus marker must never be combined with an earlier ENOENT result.
      const run = structuredClone(state.orchestrator.get(runId));
      const relatedApprovals = structuredClone(state.approvalBroker.list().filter((item) => item.runId === runId));
      const [busRead, events, health] = await Promise.all([
        state.orchestrator.bus.readTail(runId, {
          maxBytes: MISSION_CONTROL_LIMITS.busBytes,
          maxMessages: MISSION_CONTROL_LIMITS.busMessages,
          signal,
        }),
        state.eventStore.listByRun(runId, MISSION_CONTROL_LIMITS.events, { signal }),
        (async () => {
          if (testMissionHealthDelayMs > 0) await delay(testMissionHealthDelayMs, undefined, { signal });
          return state.healthService.all({ signal });
        })(),
      ]);
      return json(response, 200, projectMissionControl({
        run,
        busMessages: busRead.messages,
        busDiagnostics: busRead.diagnostics,
        events,
        approvals: relatedApprovals,
        health,
        // The store deliberately reads at most 200. A full window is conservatively marked
        // truncated because proving otherwise would require an unbounded/counting scan.
        eventsMayBeTruncated: events.length === MISSION_CONTROL_LIMITS.events,
        evidenceArtifacts: collectRunEvidenceArtifacts({
          run,
          handoffs: (await state.observability.handoffs({ limit: 80 }).catch(() => [])).map((file) => ({
            ...file,
            exists: true,
          })),
          deltas: (await state.observability.deltaLedger({ recent: 80 }).catch(() => ({ deltas: [] }))).deltas || [],
        }),
      }));
    }, { request });
  }
  const workspaceMatch = pathname.match(/^\/api\/runs\/([^/]+)\/workspace$/);
  if (request.method === "GET" && workspaceMatch) {
    const runId = decodeURIComponent(workspaceMatch[1]);
    const run = state.orchestrator.get(runId);
    if (!run) throw Object.assign(new Error(`run not found: ${runId}`), { code: "RUN_NOT_FOUND" });
    return json(response, 200, await inspectRunWorkspace(run, { path: url.searchParams.get("path") ?? "" }));
  }
  if (request.method === "PUT" && workspaceMatch) {
    const runId = decodeURIComponent(workspaceMatch[1]);
    const run = state.orchestrator.get(runId);
    if (!run) throw Object.assign(new Error(`run not found: ${runId}`), { code: "RUN_NOT_FOUND" });
    const payload = await body(request, WORKSPACE_EXPLORER_LIMITS.previewBytes + 32 * 1024);
    return json(response, 200, await updateRunWorkspaceFile(run, {
      path: url.searchParams.get("path") ?? "",
      content: payload.content,
      expectedRevision: payload.expectedRevision,
    }));
  }
  // v3.7 Automations：composer 快照的保存/管理/触发（调度产生的 run 与手动同一治理链）
  if (request.method === "GET" && pathname === "/api/automations") {
    return json(response, 200, { automations: automationsForPublic(state.automations.list()), status: state.automations.status() });
  }
  if (request.method === "POST" && pathname === "/api/automations") {
    return json(response, 201, automationForPublic(await state.automations.create(await body(request))));
  }
  const automationMatch = pathname.match(/^\/api\/automations\/([^/]+)(\/(?:run|cancel))?$/);
  if (automationMatch) {
    const automationId = decodeURIComponent(automationMatch[1]);
    if (request.method === "POST" && automationMatch[2] === "/run") {
      return json(response, 202, runForPublic(await state.automations.trigger(automationId, { source: "manual" })));
    }
    if (request.method === "POST" && automationMatch[2] === "/cancel") {
      return json(response, 200, runForPublic(await state.automations.cancel(automationId)));
    }
    if (!automationMatch[2]) {
      if (request.method === "GET") return json(response, 200, automationForPublic(state.automations.get(automationId)));
      if (request.method === "PATCH") return json(response, 200, automationForPublic(await state.automations.update(automationId, await body(request))));
      if (request.method === "DELETE") return json(response, 200, await state.automations.remove(automationId));
    }
  }
  if (request.method === "GET" && pathname === "/api/roster") {
    return json(response, 200, await readRuntimeRoster());
  }
  if (request.method === "GET" && pathname === "/api/agents/models") {
    // 动态模型/推理档位目录：CLI 原生发现（codex debug models / grok models / claude models），
    // 5min 缓存；发现失败如实回退 models.json 静态目录（source 字段标明出处）
    const agentId = url.searchParams.get("agent") ?? "";
    if (!agentId) throw Object.assign(new Error("agent is required"), { code: "VALIDATION_FAILED" });
    const runtimeProfileId = runtimeProfileIdForMember(agentId);
    const catalog = await state.modelDiscovery.forAgent(runtimeProfileId);
    return json(response, 200, {
      ...catalog,
      context: { ...(catalog.context || {}), memberId: agentId, runtimeProfileId },
    });
  }
  if (request.method === "GET" && pathname === "/api/agents/native-settings") {
    // T5：CLI 原生 /config 设置只读快照（第一期只有 grok）。只读、白名单制、全链路脱敏；
    // agent 参数兼容成员 ID 与 runtimeProfileId（如 grok-build）。无任何写端点。
    const agentId = url.searchParams.get("agent") ?? "";
    if (!agentId) throw Object.assign(new Error("agent is required"), { code: "VALIDATION_FAILED" });
    let runtimeProfileId = "";
    try {
      runtimeProfileId = runtimeProfileIdForMember(agentId);
    } catch {
      runtimeProfileId = "";
    }
    if (!runtimeProfileId) runtimeProfileId = agentId;
    if (!hasNativeSettingsAgent(runtimeProfileId)) {
      throw Object.assign(new Error(`native settings are not available for agent: ${agentId}`), { code: "SOURCE_NOT_FOUND" });
    }
    return json(response, 200, await buildNativeSettings(runtimeProfileId));
  }
  if (request.method === "POST" && pathname === "/api/agents/actions") {
    const input = await body(request);
    const agentId = String(input?.agent ?? input?.memberId ?? "").trim();
    const actionId = String(input?.action ?? input?.actionId ?? "").trim();
    if (!agentId || !actionId) {
      throw Object.assign(new Error("agent and action are required"), { code: "VALIDATION_FAILED" });
    }
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(actionId)) {
      throw Object.assign(new Error("action id must use 1-48 lowercase letters, digits or hyphens"), { code: "VALIDATION_FAILED" });
    }
    return json(response, 200, await runAgentControlAction(agentId, actionId));
  }
  if (request.method === "POST" && pathname === "/api/router/preview") {
    const input = await body(request);
    delete input.allowedProviders; // 白名单只能由服务端从 teamId 推导，不信客户端直提（烛 R10 致命2）
    // 同理：multimodal 判据由服务端从 sources 推导，不信客户端直提的 hasVisualAttachment
    const visualAttachmentType = visualSourceType(normalizeRunSources(input.sources));
    delete input.sources;
    input.hasVisualAttachment = visualAttachmentType !== null;
    input.visualAttachmentType = visualAttachmentType;
    // 缺省解析内置团队——预览与 orchestrator.create 完全同契约（烛 R11 建议）
    const team = state.teams.get(String(input.teamId || "team-514cc"));
    const requestedProvider = input.requestedProvider == null ? null : String(input.requestedProvider).trim();
    const requestedProviderMember = requestedProvider && team.members.includes(requestedProvider)
      ? state.teamMembers.get(requestedProvider)
      : null;
    const requestedAgentIds = normalizeRequestedAgentIds(input.requestedAgentIds, team.members);
    const explicitStartAgentId = String(input.startAgentId ?? "").trim();
    const startAgentId = resolveStartAgentId(explicitStartAgentId || null, team.members, requestedAgentIds[0] || team.coordinator);
    const startRuntimeProfileId = runtimeProfileIdForMember(startAgentId);
    const requestedRuntimeProfileId = requestedProviderMember?.runtimeProfileId || requestedProvider || null;
    if (explicitStartAgentId && requestedRuntimeProfileId && requestedRuntimeProfileId !== startRuntimeProfileId) {
      throw Object.assign(new Error("requestedProvider must match the explicit startAgentId runtime profile"), {
        code: "VALIDATION_FAILED",
      });
    }
    const preferredMemberIds = [
      explicitStartAgentId ? startAgentId : requestedProviderMember?.id,
      requestedProviderMember?.id,
      startAgentId,
      ...requestedAgentIds,
      team.coordinator,
    ].filter(Boolean);
    input.requestedAgentIds = requestedAgentIds;
    input.allowedProviders = [...new Set(team.members.map(runtimeProfileIdForMember))];
    input.requestedProvider = requestedRuntimeProfileId || (explicitStartAgentId ? startRuntimeProfileId : undefined);
    return json(response, 200, projectRouteToTeamMembers(await state.router.preview(input), team, preferredMemberIds));
  }
  if (request.method === "GET" && pathname === "/api/approvals") return json(response, 200, approvalSnapshotForPublic());
  if (request.method === "GET" && pathname === "/api/leases") {
    return json(response, 200, { leases: state.orchestrator.listCapabilityLeases() });
  }

  let match = pathname.match(/^\/api\/approvals\/([^/]+)\/resolve$/);
  if (request.method === "POST" && match) {
    const payload = await body(request);
    const resolution = await state.approvalBroker.resolve(decodeURIComponent(match[1]), {
      ...payload,
      // F-047：actor 不接受请求体自证。控制面只有一份共享 bearer 凭证（/api 全局门已校验），
      // 所有持有者等价，鉴别不到具体的人 —— 所以账本只写"经本地凭证"，由服务端盖章；
      // 请求体自称的身份另存 clientActor 留档，事后审计不得把它当作身份证据。
      actor: "local-operator",
      actorSource: "local-bearer",
      clientActor: typeof payload?.actor === "string" ? payload.actor.slice(0, 128) : null,
    });
    let lease = null;
    if (resolution.decision === "approve" && resolution.method === "control/runBuild/requestApproval" && resolution.runId) {
      // The approval promise wakes Orchestrator asynchronously. Return only its authoritative,
      // persisted execution lease; never synthesize a second display-only lease in the broker.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        lease = state.orchestrator.capabilityLeaseView(state.orchestrator.get(resolution.runId));
        if (lease?.approvalId === resolution.id) break;
        lease = null;
        await delay(10);
      }
    }
    return json(response, 200, { ...resolution, lease });
  }

  match = pathname.match(/^\/api\/runs\/([^/]+)\/lease\/revoke$/);
  if (request.method === "POST" && match) {
    return json(response, 200, await state.orchestrator.revokeCapabilityLeaseForRun(
      decodeURIComponent(match[1]),
      await body(request),
    ));
  }

  match = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === "GET" && match) return json(response, 200, runForPublic(state.orchestrator.get(decodeURIComponent(match[1]))));
  // 一键跳到当前会话的 CLI 界面：用原生 session ID 开交互式 CLI 终端（claude -r / codex resume…），
  // 与控制台共享同一原生会话，双向实时。门闸与终端面板同闸（pty）。
  match = pathname.match(/^\/api\/runs\/([^/]+)\/cli-terminal$/);
  if (request.method === "POST" && match) {
    const id = decodeURIComponent(match[1]);
    state.remoteGates.assert("pty");
    const run = state.orchestrator.get(id);
    if (!run) throw Object.assign(new Error(`run not found: ${id}`), { code: "RUN_NOT_FOUND" });
    const payload = await body(request).catch(() => ({}));
    const spec = state.orchestrator.interactiveCliSpecForRun(run, payload?.agentId, { strict: payload?.strict === true });
    if (!spec) {
      // 两种落空要分清：一句"先完成一轮对话"对 pi 这类根本没有交互 resume 通道的席位是误导
      const hasNativeSessions = Object.keys(run.sessions || {}).length > 0;
      throw Object.assign(new Error(hasNativeSessions
        ? "该会话的原生记录不支持交互式接续（此 CLI 没有已验证的 resume 通道）"
        : "当前会话还没有原生 CLI 会话（先至少完成一轮对话）"), { code: "CLI_HANDOFF_UNSUPPORTED" });
    }
    const pty = getPtyServiceFor(surfaceCtx);
    // 外部系统终端（真终端窗口）：同一条原生会话、同一份 resume 命令，宿主从罩层换成系统终端。
    // 系统级 spawn 与 revealInFileManager 同信任级（操作者本机）；非 Windows 的终端生态太碎，
    // 如实拒绝而不是猜一个 x-terminal-emulator。
    if (payload?.external === true) {
      if (process.platform !== "win32") {
        throw Object.assign(new Error("外部系统终端当前仅支持 Windows；内置罩层终端在所有平台可用"), { code: "CLI_HANDOFF_UNSUPPORTED" });
      }
      spawn("cmd.exe", ["/d", "/c", "start", "", spec.command, ...spec.args], {
        detached: true,
        stdio: "ignore",
        cwd: spec.cwd ?? undefined,
        windowsHide: false,
      }).unref();
      return json(response, 201, {
        ok: true,
        external: true,
        spec: { agentId: spec.agentId, protocol: spec.protocol, sessionId: spec.sessionId, command: [spec.command, ...spec.args].join(" ") },
        busy: state.orchestrator.controllers.has(id),
      });
    }
    const session = pty.create({
      shell: spec.command,
      args: spec.args,
      // run.cwd 是操作者选定的项目地址，adapter 子进程本就以其为 cwd——终端同权，
      // 通过按次 extraCwdRoots 放行，通用 /api/pty 沙箱不变
      cwd: spec.cwd ?? undefined,
      extraCwdRoots: spec.cwd ? [spec.cwd] : [],
      title: `${spec.agentId} · ${run.title || String(run.id).slice(0, 8)} · CLI`,
      // 同一 run 同一席位重复点开 = 同一原生会话：复用在途 PTY，不再 spawn 第二个进程抢 session 文件
      dedupeKey: `run-cli:${run.id}:${spec.agentId}`,
      // CLI 接续会话只属于沉浸罩层；底部抽屉/终端视图按 kind 过滤掉它，保持纯 shell
      kind: "cli",
    });
    return json(response, 201, {
      ok: true,
      session,
      spec: { agentId: spec.agentId, protocol: spec.protocol, sessionId: spec.sessionId, command: [spec.command, ...spec.args].join(" ") },
      // 全成员可接续清单：罩层成员页签据此渲染（点击未启动成员时按 agentId 再调本接口懒起 PTY）
      members: state.orchestrator.interactiveCliSpecsForRun(run)
        .map((entry) => ({ agentId: entry.agentId, protocol: entry.protocol, sessionId: entry.sessionId })),
      busy: state.orchestrator.controllers.has(id),
    });
  }
  match = pathname.match(/^\/api\/runs\/([^/]+)\/(cancel|interrupt|messages)$/);
  if (request.method === "POST" && match) {
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    if (action === "messages") {
      const input = await body(request) ?? {};
      delete input.waitForTurn;
      return json(response, 200, runForPublic(await state.orchestrator.continue(id, {
        ...input,
        waitForTurn: false,
      })));
    }
    return json(response, 200, runForPublic(action === "cancel"
      ? await state.orchestrator.cancel(id)
      : await state.orchestrator.interrupt(id)));
  }
  match = pathname.match(/^\/api\/runs\/([^/]+)\/sources$/);
  if (request.method === "POST" && match) {
    const input = await body(request);
    return json(response, 200, runForPublic(await state.orchestrator.addSources(
      decodeURIComponent(match[1]),
      input?.sources,
    )));
  }
  match = pathname.match(/^\/api\/runs\/([^/]+)\/meta$/);
  if (request.method === "PATCH" && match) {
    return json(response, 200, runForPublic(await state.orchestrator.updateMeta(decodeURIComponent(match[1]), await body(request))));
  }
  match = pathname.match(/^\/api\/runs\/([^/]+)\/controls$/);
  if (request.method === "PATCH" && match) {
    // 会话中热改 模型/Effort/权限（白名单迁移），审计事件 run.control_changed；
    // recovery_required 时 body.acknowledgeRecovery===true 随热改一次性携带恢复确认
    const input = await body(request) ?? {};
    const { acknowledgeRecovery, ...patch } = input;
    return json(response, 200, runForPublic(await state.orchestrator.updateRunControls(
      decodeURIComponent(match[1]),
      patch,
      { actor: "operator", acknowledgeRecovery: acknowledgeRecovery === true },
    )));
  }

  match = pathname.match(/^\/api\/config\/(.+?)\/versions\/([^/]+)\/content$/);
  if (request.method === "GET" && match) {
    // 回滚预览：指定版本原文（鉴权走 /api 全局 bearer；VERSION_NOT_FOUND/SOURCE_NOT_FOUND→404 由 statusFor 映射）
    return json(response, 200, await state.configManager.versionContent(decodeURIComponent(match[1]), decodeURIComponent(match[2])));
  }
  match = pathname.match(/^\/api\/config\/(.+?)\/(versions|validate|plan|apply|rollback)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    if (request.method === "GET" && action === "versions") return json(response, 200, { versions: await state.configManager.versions(id) });
    if (request.method === "POST") {
      const input = await body(request);
      if (action === "validate") return json(response, 200, await state.configManager.validate(id, input.content));
      if (action === "plan") return json(response, 200, await state.configManager.plan(id, input.content, input.baseSha256));
      if (action === "apply") {
        const operation = () => state.configManager.apply(id, input);
        return json(response, 200, await (id === RUNTIME_SEAT_SOURCE_ID ? withRuntimeSeatMutation(operation) : operation()));
      }
      if (action === "rollback") {
        const operation = () => state.configManager.rollback(id, input);
        return json(response, 200, await (id === RUNTIME_SEAT_SOURCE_ID ? withRuntimeSeatMutation(operation) : operation()));
      }
    }
  }
  match = pathname.match(/^\/api\/config\/(.+)$/);
  if (request.method === "GET" && match) return json(response, 200, await state.configManager.read(decodeURIComponent(match[1])));

  if (request.method === "GET" && pathname === "/api/events") {
    // RT-03：显式 stream epoch——客户端可检测控制面重启并重置 Last-Event-ID 回放游标
    const streamEpoch = state.streamEpoch || (state.streamEpoch = `epoch-${Date.now().toString(36)}`);
    response.writeHead(200, {
      ...securityHeaders,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-514cc-stream-epoch": streamEpoch,
    });
    const requestedAfter = Number(url.searchParams.get("after") || request.headers["last-event-id"] || 0);
    const afterSequence = Number.isSafeInteger(requestedAfter) && requestedAfter >= 0 ? requestedAfter : 0;
    const uiView = url.searchParams.get("view") === "ui";
    const maxPendingEvents = 2048;
    const maxPendingBytes = 2 * 1024 * 1024;
    let replaying = true;
    let lastSequence = afterSequence;
    let closed = false;
    let heartbeat = null;
    let pumping = false;
    let queuedBytes = 0;
    let queueHead = 0;
    let liveQueue = [];
    let unsubscribe = () => {};
    const replayAbort = new AbortController();
    const closeStream = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      replayAbort.abort();
      liveQueue = [];
      queueHead = 0;
      queuedBytes = 0;
    };
    const writeChunk = async (chunk) => {
      if (closed) return false;
      try {
        if (response.write(chunk)) return true;
      } catch {
        closeStream();
        return false;
      }
      // response.write(false) means the kernel/userland buffer is full. Replay must pause here,
      // otherwise a slow browser turns one disk scan into an unbounded JS heap queue.
      return new Promise((resolveDrain) => {
        const settle = (value) => {
          response.off("drain", onDrain);
          response.off("close", onClose);
          response.off("error", onClose);
          resolveDrain(value);
        };
        const onDrain = () => settle(!closed);
        const onClose = () => settle(false);
        response.once("drain", onDrain);
        response.once("close", onClose);
        response.once("error", onClose);
        if (closed) settle(false);
      });
    };
    const eventChunk = (event) => {
      let run = null;
      const runId = String(event?.runId || "").trim();
      if (runId) {
        try { run = state.orchestrator.get(runId); } catch {}
      }
      const visibleEvent = eventForPublic(event, run, uiView);
      return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(visibleEvent)}\n\n`;
    };
    const compactQueue = () => {
      if (queueHead >= 1024 && queueHead * 2 >= liveQueue.length) {
        liveQueue = liveQueue.slice(queueHead);
        queueHead = 0;
      }
    };
    const discardReplayDuplicates = () => {
      while (queueHead < liveQueue.length) {
        const sequence = Number(liveQueue[queueHead].event?.sequence) || 0;
        if (!sequence || sequence > lastSequence) break;
        queuedBytes -= liveQueue[queueHead++].bytes;
      }
      compactQueue();
    };
    const enqueue = (item) => {
      if (closed) return false;
      const pendingCount = liveQueue.length - queueHead;
      if (pendingCount >= maxPendingEvents || queuedBytes + item.bytes > maxPendingBytes) {
        // The client reconnects with its last delivered event id; destroying is safer than silently
        // dropping a middle event or retaining arbitrary data while it is not reading.
        closeStream();
        response.destroy();
        return false;
      }
      liveQueue.push(item);
      queuedBytes += item.bytes;
      if (!replaying) void pumpQueue();
      return true;
    };
    const enqueueEvent = (event) => {
      if ((Number(event.sequence) || 0) <= lastSequence) return;
      const chunk = eventChunk(event);
      enqueue({ event, chunk, bytes: Buffer.byteLength(chunk) });
    };
    const enqueueRaw = (chunk) => enqueue({ event: null, chunk, bytes: Buffer.byteLength(chunk) });
    async function pumpQueue() {
      if (pumping || replaying || closed) return;
      pumping = true;
      try {
        while (!closed && queueHead < liveQueue.length) {
          const item = liveQueue[queueHead++];
          queuedBytes -= item.bytes;
          compactQueue();
          const sequence = Number(item.event?.sequence) || 0;
          if (sequence && sequence <= lastSequence) continue;
          if (!(await writeChunk(item.chunk))) break;
          if (sequence) lastSequence = sequence;
        }
      } finally {
        pumping = false;
        if (!closed && queueHead < liveQueue.length) queueMicrotask(() => void pumpQueue());
      }
    }
    const writeReplayEvent = async (event) => {
      const sequence = Number(event.sequence) || 0;
      if (sequence <= lastSequence) return true;
      if (!(await writeChunk(eventChunk(event)))) return false;
      lastSequence = sequence;
      // createReadStream can observe appends made during replay. Those events also entered the live
      // safety queue via subscribe(); discard the now-delivered head copies so duplicates cannot
      // consume the bounded queue and force a reconnect under sustained activity.
      discardReplayDuplicates();
      return true;
    };
    unsubscribe = state.eventStore.subscribe((event) => {
      enqueueEvent(event);
    });
    response.once("error", closeStream);
    response.once("close", closeStream);
    if (!(await writeChunk(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ requestId: randomUUID(), afterSequence, streamEpoch, eventSchema: EVENT_ENVELOPE_SCHEMA, eventSchemaVersions: [...SUPPORTED_EVENT_SCHEMA_VERSIONS] })}\n\n`))) return;
    try {
      if (afterSequence > 0) {
        for await (const event of state.eventStore.iterate({ afterSequence, signal: replayAbort.signal })) {
          if (closed) break;
          if (!(await writeReplayEvent(event))) break;
        }
      } else {
        for (const event of await state.eventStore.list(50)) {
          if (!(await writeReplayEvent(event))) break;
        }
      }
    } catch (error) {
      if (!closed) await writeChunk(`event: replay_error\ndata: ${JSON.stringify({ code: "EVENT_REPLAY_FAILED", message: error.message })}\n\n`);
      closeStream();
      response.end();
      return;
    }
    if (closed) return;
    replaying = false;
    void pumpQueue();
    heartbeat = setInterval(() => enqueueRaw(": heartbeat\n\n"), 20_000);
    return;
  }
  if (await dispatchSurfaceRoute(request, response, url)) return;
  return json(response, 404, { error: { code: "NOT_FOUND", message: "API route not found" } });
}

const readiness = createReadinessChecker();
let serverReady = false;

const server = createServer(async (request, response) => {
  const requestId = traceIdFromRequest(request);
  response.setHeader("x-request-id", requestId);
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || host}`);
    // F-060 健康探针（无认证，K8s/桌面壳标准 liveness + readiness）
    if (request.method === "GET" && url.pathname === "/healthz") return handleHealthz(response);
    if (request.method === "GET" && url.pathname === "/readyz") return await handleReadyz(response, readiness);
    if (request.method === "POST" && url.pathname === "/auth/bootstrap") {
      const payload = await body(request, 4 * 1024);
      if (bootstrapConsumed || Date.now() > bootstrapExpiresAt || !secretEquals(payload.nonce, bootstrapNonce)) {
        return json(response, 401, { error: { code: "BOOTSTRAP_INVALID", message: "Bootstrap token is invalid, expired, or already used", requestId } });
      }
      bootstrapConsumed = true;
      return json(response, 200, { token });
    }
    if (url.pathname.startsWith("/api/")) {
      // 入站 webhook 是给外部系统回调的：它们拿不到本地 Bearer token，
      // 安全边界由渠道自身的 HMAC 验签 + 限流承担（channels.mjs receiveWebhook）。
      const inboundWebhook = request.method === "POST" && /^\/api\/channels\/webhook\/[\w-]+$/.test(url.pathname);
      const auth = inboundWebhook ? { observer: false } : authorized(request);
      if (!auth) {
        return json(response, 401, { error: { code: "UNAUTHORIZED", message: "Missing or invalid local access token", requestId } });
      }
      // W3.15 观察者 token：只放行幂等读，写操作一律拒绝（fail-closed）
      if (auth.observer && request.method !== "GET" && request.method !== "HEAD") {
        return json(response, 403, { error: { code: "OBSERVER_READ_ONLY", message: "Observer token is read-only; writes are not permitted", requestId } });
      }
      return await api(request, response, url);
    }
    if ((request.method === "GET" || request.method === "HEAD") && (await serveStatic(url.pathname, response, request))) return;
    return json(response, 404, { error: { code: "NOT_FOUND", message: "Not found", requestId } });
  } catch (error) {
    const disconnected = error?.code === "CLIENT_DISCONNECTED" || (
      error?.name === "AbortError" && Boolean(request.aborted || request.destroyed || response.destroyed)
    );
    if (disconnected || response.destroyed || response.writableEnded) return;
    await state.eventStore.emit("server.error", {
      requestId,
      code: error.code || null,
      message: error.message,
      // NO_ROUTE/NO_INDEPENDENT_ROUTE 必须把每个席位的排除原因留进账本：
      // 只有 message 的账本无法事后回答"当时谁被什么卡住"（2026-08-19 current-research 60 连发复盘）。
      ...(Array.isArray(error.candidates) && {
        candidates: error.candidates.map((candidate) => ({
          id: candidate.id,
          excluded: candidate.excluded === true,
          reasons: Array.isArray(candidate.excludedReasons) ? candidate.excludedReasons : [],
        })),
      }),
    }, { sensitivity: "internal" }).catch(() => {});
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (["EVENT_INDEX_BUSY", "HEALTH_PROBE_BUSY", "AGENT_ACTION_CAPACITY", "MODEL_DISCOVERY_CAPACITY"].includes(error.code) && !response.headersSent) {
      response.setHeader("retry-after", "1");
    }
    return json(response, statusFor(error), {
      error: {
        code: error.code || "INTERNAL_ERROR",
        message: error.message,
        requestId,
        validation: error.validation,
        currentSha256: error.currentSha256,
        currentRevision: error.currentRevision,
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision,
        conversationId: error.conversationId,
        candidates: error.candidates,
        references: error.references,
        conflicts: error.conflicts,
        usage: error.usage,
        limits: error.limits,
        runtimeProfileId: error.runtimeProfileId,
        eligibilityReason: error.eligibilityReason,
        automationStatus: error.automationStatus,
        capabilityStatus: error.capabilityStatus,
      },
    });
  }
});

// F-060 就绪检查注册：核心服务初始化完成后 /readyz 才返回 200
readiness.register("event-store", () => Boolean(state.eventStore));
readiness.register("orchestrator", () => Boolean(state.orchestrator));
readiness.register("health-service", () => Boolean(state.healthService));

let actualPort = null;
server.listen(port, host, () => {
  serverReady = true;
  const address = server.address();
  actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}/#bootstrap=${bootstrapNonce}`;
  process.stdout.write(`514cc Control Center: ${url}\n`);
  process.stdout.write("Bootstrap link is single-use and expires after two minutes; the API bearer is not written to logs.\n");
  if (process.env.CONTROL_CENTER_OPEN === "1") {
    const opener = process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
    const child = spawn(opener[0], opener[1], { env: childProcessEnv(), stdio: "ignore", windowsHide: true, detached: true, shell: false });
    child.once("error", (error) => process.stderr.write(`Could not open browser: ${error.message}\n`));
    child.unref();
  }
});

async function closeHttpTransport() {
  if (!server.listening) return;
  await new Promise((resolveClosed, rejectClosed) => {
    server.close((error) => {
      if (error) rejectClosed(error);
      else resolveClosed();
    });
    server.closeAllConnections?.();
  });
}

async function reopenHttpTransport() {
  if (!Number.isInteger(actualPort) || actualPort <= 0) {
    throw Object.assign(new Error("Control Center HTTP port is unavailable for shutdown rollback"), {
      code: "CONTROL_CENTER_HTTP_REOPEN_FAILED",
    });
  }
  await new Promise((resolveListening, rejectListening) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListening(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListening();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(actualPort, host);
  });
}

const shutdownController = createShutdownController({
  closeTransport: closeHttpTransport,
  reopenTransport: reopenHttpTransport,
  closeState: ({ deadlineMs } = {}) => state.close({
    budgetMs: shutdownBudgetMs,
    deadlineMs,
    onPhase: (phase) => process.stdout.write(
      `[shutdown] ${phase.step} ${phase.ok ? "ok" : "FAILED"} in ${phase.ms}ms${phase.code ? ` [${phase.code}]` : ""}\n`,
    ),
  }),
  onClosed: () => process.exit(0),
  onError(error, signal) {
    const code = error?.code || "CONTROL_CENTER_SHUTDOWN_FAILED";
    const reopen = error?.transportReopenError
      ? `; HTTP reopen failed: ${error.transportReopenError.message || error.transportReopenError}`
      : "";
    process.stderr.write(`Shutdown failed (${signal}, ${code}): ${error?.message || error}${reopen}\n`);
    if (shouldSetShutdownFailureExitCode(error)) process.exitCode = 1;
  },
  budgetMs: shutdownBudgetMs,
  log: (message) => process.stdout.write(message),
});

function requestShutdown(signal) {
  shutdownController.request(signal);
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));
