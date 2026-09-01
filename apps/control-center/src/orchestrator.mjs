import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { BusStore, parseDirectives } from "./bus.mjs";
import { findSecretCandidates, sanitizeForPersistence } from "./redaction.mjs";
import { ADAPTER_TEMPLATES, adapterTemplateForRuntimeProfileId } from "./adapters/manifest.mjs";
import { resolveNativeCommand } from "./adapters/native-commands.mjs";
import { createRemoteAdapter } from "./adapters/index.mjs";
import { attestRunWorkspace } from "./run-workspace.mjs";
import { normalizeRunSources, promptWithRunSources, visualSourceType } from "./run-sources.mjs";
import { withManagedClipboardSourceRegistration } from "./clipboard-lifecycle.mjs";
import { isAbnormalProviderTurnStop } from "./provider-turn-outcome.mjs";
import { isPromptTransportError } from "./prompt-transport.mjs";
import { createWorktreeLedger } from "./worktree-ledger.mjs";
import {
  classifyAgentRoute,
  projectSocialContract,
  resolveOrchestrationMode,
  socialContractOf,
} from "./social-contract.mjs";

export { normalizeRunSources, promptWithRunSources } from "./run-sources.mjs";

const execFileAsync = promisify(execFile);

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const CONVERSATION_KINDS = new Set(["direct", "workspace_group", "legacy_pipeline"]);

function markPromptTransportFailure(run, error) {
  if (!isPromptTransportError(error)) return;
  run.failureClass = "provider_error";
}

// 预算"无限"哨兵：run 持久化与 wire 上只允许这个字符串（JSON 存不了 Infinity）。
// 语义 = 该轮不按美元止损，只受步数/压缩/超时等既定上限兜底（LO 2026-08-30：硬上限门槛已废）。
export const UNLIMITED_BUDGET = "unlimited";

// 数字预算的防手滑天花板（"无限"不受它管）。遗留真源字段 maxBudgetUsdPerTurn（"安全硬上限"）
// 已废弃不再读取：resolve 不钳制、运行图不校验，schema 仅容忍旧配置文件里的残留键。
const BUDGET_NUMERIC_CEILING = 50;

export function isUnlimitedBudgetValue(value) {
  if (value === null || value === undefined) return false;
  const raw = String(value).trim().toLowerCase();
  return raw === UNLIMITED_BUDGET || raw === "∞" || raw === "inf" || raw === "infinity";
}

export function resolveBudgetUsdPerTurn(value, policy = {}, { legacyDefault = 0.75 } = {}) {
  const limits = policy?.limits || policy || {};
  // "无限"就是无限——不再有硬上限钳制。
  if (isUnlimitedBudgetValue(value)) return Number.POSITIVE_INFINITY;
  const defaultRequested = isUnlimitedBudgetValue(limits.defaultBudgetUsdPerTurn)
    ? Number.POSITIVE_INFINITY
    : Number(limits.defaultBudgetUsdPerTurn ?? legacyDefault);
  const requested = value !== undefined && value !== null && String(value).trim() !== ""
    ? Number(value)
    : defaultRequested;
  // +Infinity（无限默认/无限请求）必须原样通过：Number.isFinite 守卫会把它误杀回 legacy 默认
  const fallback = requested === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Number.isFinite(requested) && requested >= 0.05
      ? requested
      : Math.min(legacyDefault, BUDGET_NUMERIC_CEILING);
  if (fallback === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return Math.max(0.05, Math.min(fallback, BUDGET_NUMERIC_CEILING));
}

// adapter 透传用：无限预算 → null（调用方省略 CLI 预算旗标），有限 → 数字。
function turnBudgetUsdPerTurn(run, policy) {
  const resolved = resolveBudgetUsdPerTurn(run?.maxBudgetUsdPerTurn, policy);
  return Number.isFinite(resolved) ? resolved : null;
}

const MAX_REQUESTED_AGENTS = 4;
// social 协作：显式 @N 个成员的闭环 = N+1 步（各回一句 + 主脑汇总），另留该余量给 agent 间
// 自主往复（追问/补强/复核），避免一次多 agent 协作被"单交互自主步骤"闸在闭环边界截断。
const SOCIAL_INTERACTION_HEADROOM = 2;
const CODEX_TRANSPORT_FAILURES = new Set(["APP_SERVER_EXIT", "APP_SERVER_TIMEOUT", "EPIPE", "ECONNRESET", "ENOENT", "UNSAFE_COMMAND_SHIM"]);
// 自动续跑只针对"已提交但被打断"的超时轮：打断经 provider 确认 + 只读/plan 轮（无写盘残留）
// 才有安全续跑语义。次数按当前用户交互计，不把一次超时变成整场会话的永久惩罚。
const AUTO_RECOVERY_TIMEOUT_CODES = new Set(["TURN_TIMEOUT", "TURN_IDLE_TIMEOUT"]);
const MAX_AUTO_RECOVERIES_PER_INTERACTION = 2;
// 原生上下文压缩预算按"当前用户交互"计，且必须是显式计数器而非递归参数：压缩链与自动续跑链
// 会互相嵌套（压缩轮超时 → 自动续跑 → 新轮又带默认 allowContextRecovery），任何一处递归漏传
// 参数都会让"一次压缩上限"失效，把单次「继续」拉成数轮 5 分钟静默。计数器落在 run 上、可审计。
const MAX_CONTEXT_COMPACTIONS_PER_INTERACTION = 1;
// Codex 官方权限档（LO 2026-08-09：与 Codex 桌面批准菜单一致，不再用 514cc 自造档位替代）：
// composer mode → 原生组合 id（sandbox+approvalPolicy 由 codex adapter 解析，见 codex-app-server.mjs）。
// 官方语义不走 514cc 的 build 审批/租约门——审批发生在 Codex 层（on-request/on-failure 升级到
// approvalBroker）或按官方含义不询问（full-access/never、config.toml 自定义）。
const CODEX_PRESET_NATIVE_MODES = Object.freeze({
  ask: "workspace-write",
  auto: "workspace-write:on-failure",
  "full-access": "danger-full-access",
  config: "config-default",
});
// 会话中权限热改白名单（2026-08-10 LO：固化不应一刀切）。只放开机制上每轮可改、治理上安全的迁移：
// - 降档（build→review/plan、review→plan）：写面收缩，无审批语义被破坏；
// - Codex ask↔auto：sandbox 同为 workspace-write 不变，只动 turn 级 approvalPolicy。
// 其余一律拒绝：升 build 必须走创建时审批门；Codex sandbox 轴（read-only/workspace-write/
// full-access/config 互转）绑在 thread/start，原生会话存续期真固化；跨族迁移语义不明。
const PERMISSION_HOT_TRANSITIONS = Object.freeze({
  plan: [],
  review: ["plan"],
  build: ["review", "plan"],
  ask: ["auto"],
  auto: ["ask"],
  "full-access": [],
  // CLI 原生审批档（native:* 透传 override）：与治理档同款降档哲学——只放开收缩方向，
  // 升档要求新建任务；与前端 public/app.js 的同名表严格同源（语义不得分叉）。
  "native:auto": [],
  "native:acceptEdits": ["native:auto"],
  "native:always-approve": ["native:acceptEdits", "native:auto"],
  config: [],
});
const AUTO_RECOVERY_CONTINUATION_PROMPT = "[514cc 编排器自动恢复] 你的上一轮原生轮因超时被编排器打断，打断已获 provider 确认，会话内无残留活跃工作，但任务尚未交付。请利用本会话已保留的排查进展继续完成当前任务：不要从头重复已完成的读取与分析，直接补齐剩余工作并给出最终交付与可验证证据。";
const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100];
const CODEX_RESUME_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Codex 交互恢复吃线程 uuid；rollout 文件名里夹着同一枚，抽出来再用。 */
export function codexInteractiveResumeId(sessionId) {
  const text = String(sessionId ?? "").trim();
  const match = CODEX_RESUME_UUID.exec(text);
  return match ? match[1] : text;
}

const ADAPTER_RESUME_FEATURES = Object.freeze({
  "claude-stream-json": { defaultCommand: "claude", args: (sessionId) => ["-r", sessionId] },
  // 交互 TUI 必须是 `codex resume <uuid>`。`codex exec resume` 是无交互一轮，没 prompt 会立刻
  // 报 "No prompt provided" 然后进程退出——这正是罩层打开 Codex 会话时看到的那句。
  "codex-app-server": { defaultCommand: "codex", args: (sessionId) => ["resume", codexInteractiveResumeId(sessionId)] },
  "codex-exec-json": { defaultCommand: "codex", args: (sessionId) => ["resume", codexInteractiveResumeId(sessionId)] },
  "gemini-stream-json": { defaultCommand: "gemini", args: (sessionId) => ["--resume", sessionId] },
  "grok-build-headless": { defaultCommand: "grok", args: (sessionId) => ["-r", sessionId] },
  "kimi-headless-resume": { defaultCommand: "kimi", args: (sessionId) => ["-S", sessionId] },
  // OpenCode TUI 默认命令直接吃全局 --session（1.18 --help 实证）；会话在 opencode 自有 SQLite，cwd 无关
  "opencode-run-json": { defaultCommand: "opencode", args: (sessionId) => ["--session", sessionId] },
  // Pi 交互 TUI 用 --session-id 精确打开既有 project session（与 RPC 创建旗标同源；--session 是模糊前缀查找，不用）
  "pi-rpc": { defaultCommand: "pi", args: (sessionId) => ["--session-id", sessionId] },
});

function commandHintToken(value) {
  const text = String(value ?? "");
  return /^[A-Za-z0-9._:/\\-]+$/.test(text) ? text : JSON.stringify(text);
}

function resumeCommandForAdapter(adapter, sessionId) {
  const feature = ADAPTER_RESUME_FEATURES[adapter?.id];
  if (!feature || !sessionId) return null;
  if (typeof adapter.canResume === "function" && adapter.canResume(sessionId) !== true) return null;
  const command = String(adapter.command || feature.defaultCommand || "").trim();
  if (!command) return null;
  return [command, ...feature.args(String(sessionId))].map(commandHintToken).join(" ");
}

function legacyTeamMember(memberId) {
  const id = String(memberId ?? "").trim();
  return {
    id,
    runtimeProfileId: id,
    label: id,
    role: "",
    description: "",
    systemPrompt: "",
    capabilities: ["*"],
    defaultModel: null,
    defaultEffort: null,
    teamMemberEligible: true,
    coordinatorEligible: true,
  };
}

function normalizeTeamMember(raw, expectedId = null) {
  const fallbackId = String(expectedId ?? "").trim();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw Object.assign(new Error(`team member snapshot is missing or invalid: ${fallbackId || "<missing>"}`), {
      code: "TEAM_MEMBER_SNAPSHOT_INVALID",
    });
  }
  const id = String(raw?.id ?? fallbackId).trim();
  if (!id || (fallbackId && id !== fallbackId)) {
    throw Object.assign(new Error(`team member snapshot is invalid: ${fallbackId || "<missing>"}`), {
      code: "TEAM_MEMBER_SNAPSHOT_INVALID",
    });
  }
  const runtimeProfileId = String(raw?.runtimeProfileId ?? raw?.profileId ?? id).trim();
  if (!runtimeProfileId) {
    throw Object.assign(new Error(`team member ${id} has no runtime profile binding`), {
      code: "TEAM_MEMBER_SNAPSHOT_INVALID",
    });
  }
  return {
    id,
    runtimeProfileId,
    label: String(raw?.label ?? raw?.name ?? id).trim() || id,
    role: String(raw?.role ?? "").trim(),
    description: String(raw?.description ?? "").trim(),
    systemPrompt: String(raw?.systemPrompt ?? raw?.personaPrompt ?? "").trim(),
    capabilities: ["*"],
    defaultModel: String(raw?.defaultModel ?? "").trim() || null,
    defaultEffort: String(raw?.defaultEffort ?? "").trim().toLowerCase() || null,
    teamMemberEligible: raw.teamMemberEligible === true,
    coordinatorEligible: raw.coordinatorEligible === true,
    ...(raw?.eligibilityReason ? { eligibilityReason: String(raw.eligibilityReason) } : {}),
  };
}

function rosterSnapshotEntries(snapshot) {
  if (snapshot instanceof Map) return [...snapshot.values()];
  if (Array.isArray(snapshot)) return snapshot;
  if (Array.isArray(snapshot?.members)) return snapshot.members;
  if (snapshot?.members instanceof Map) return [...snapshot.members.values()];
  if (snapshot?.members && typeof snapshot.members === "object") {
    return Object.entries(snapshot.members)
      .map(([id, member]) => member && typeof member === "object" ? { id, ...member } : member);
  }
  if (Array.isArray(snapshot?.roster)) return snapshot.roster;
  if (snapshot?.id && typeof snapshot === "object") return [snapshot];
  if (snapshot && typeof snapshot === "object") {
    return Object.entries(snapshot)
      .filter(([key]) => !["version", "createdAt", "updatedAt"].includes(key))
      .map(([id, member]) => member && typeof member === "object" ? { id, ...member } : member);
  }
  return [];
}

function migrateRunRosterCapabilities(run) {
  if (!Object.hasOwn(run || {}, "teamRoster") || run.teamRoster == null) return false;
  let changed = false;
  const entries = rosterSnapshotEntries(run.teamRoster).map((member) => {
    if (!member || typeof member !== "object" || Array.isArray(member)) return member;
    if (Array.isArray(member.capabilities) && member.capabilities.length === 1 && member.capabilities[0] === "*") {
      return member;
    }
    changed = true;
    return { ...member, capabilities: ["*"] };
  });
  if (changed) run.teamRoster = entries;
  return changed;
}

function rosterMember(roster, memberId) {
  if (!Array.isArray(roster)) return null;
  return roster.find((member) => member?.id === memberId) || null;
}

function runtimeRouteId(routeEntry) {
  return String(routeEntry?.runtimeProfileId ?? routeEntry?.id ?? "").trim();
}

function mergeResumeQueues(...queues) {
  const merged = [];
  const seen = new Set();
  for (const queue of queues) {
    for (const raw of queue || []) {
      if (!raw || typeof raw.to !== "string" || !raw.to) continue;
      const itemId = raw.itemId
        ? String(raw.itemId)
        : operationMessageId("work", raw.busMessageId || JSON.stringify({
            to: raw.to,
            kind: raw.kind || "legacy",
            sourceAttemptId: raw.sourceAttemptId || null,
          }));
      const item = {
        itemId,
        to: raw.to,
        ...(raw.busMessageId ? { busMessageId: String(raw.busMessageId) } : {}),
        ...(raw.sourceAttemptId ? { sourceAttemptId: String(raw.sourceAttemptId) } : {}),
        ...(raw.kind ? { kind: String(raw.kind) } : {}),
        ...(raw.interactionId ? { interactionId: String(raw.interactionId) } : {}),
        ...(Number.isInteger(Number(raw.interactionSeq)) && Number(raw.interactionSeq) > 0
          ? { interactionSeq: Math.trunc(Number(raw.interactionSeq)) }
          : {}),
        ...(Array.isArray(raw.sources) ? { sources: normalizeRunSources(raw.sources) } : {}),
      };
      if (seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      merged.push(item);
    }
  }
  return merged;
}

export function normalizeRequestedAgentIds(value, teamMembers) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw Object.assign(new Error("requestedAgentIds must be an array"), { code: "VALIDATION_FAILED" });
  }
  const requested = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (requested.length > MAX_REQUESTED_AGENTS) {
    throw Object.assign(new Error(`requestedAgentIds supports at most ${MAX_REQUESTED_AGENTS} targets`), { code: "VALIDATION_FAILED" });
  }
  const members = Array.isArray(teamMembers) ? new Set(teamMembers) : null;
  if (requested.length && (!members?.size || requested.some((id) => !members.has(id)))) {
    throw Object.assign(new Error("every requested agent must belong to the selected team"), { code: "NOT_TEAM_MEMBER" });
  }
  return requested;
}

export function normalizeConversationRecipientIds(value, conversation) {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw Object.assign(new Error("recipientMemberIds must be an array"), { code: "VALIDATION_FAILED" });
  }
  const requested = value.map((item) => String(item || "").trim());
  if (requested.some((id) => !id)) {
    throw Object.assign(new Error("recipientMemberIds cannot contain empty member IDs"), { code: "VALIDATION_FAILED" });
  }
  if (new Set(requested).size !== requested.length) {
    throw Object.assign(new Error("recipientMemberIds cannot contain duplicate member IDs"), { code: "VALIDATION_FAILED" });
  }
  if (requested.length > 1) {
    throw Object.assign(new Error("a Conversation message can target at most one member"), { code: "VALIDATION_FAILED" });
  }
  if (!requested.length) return null;
  const allowed = new Set((conversation?.memberIds || []).map(String));
  if (requested.some((id) => !allowed.has(id))) {
    throw Object.assign(new Error("every recipient must belong to the selected Conversation"), { code: "NOT_TEAM_MEMBER" });
  }
  if (conversation?.kind === "direct" && requested[0] !== String(conversation.directMemberId || "")) {
    throw Object.assign(new Error("a direct Conversation can only target its bound member"), { code: "NOT_TEAM_MEMBER" });
  }
  return requested;
}

export function resolveStartAgentId(value, teamMembers, fallbackId) {
  const explicit = value == null ? "" : String(value).trim();
  const members = Array.isArray(teamMembers) ? new Set(teamMembers) : null;
  if (explicit) {
    if (members && !members.has(explicit)) {
      throw Object.assign(new Error("startAgentId must belong to the selected team"), { code: "NOT_TEAM_MEMBER" });
    }
    return explicit;
  }
  const fallback = String(fallbackId || "").trim();
  if (!fallback || (members && !members.has(fallback))) {
    throw Object.assign(new Error("the selected team has no valid direct target"), { code: "NOT_TEAM_MEMBER" });
  }
  return fallback;
}

export function initialSocialTargets(startAgentId, requestedAgentIds = []) {
  return [...new Set([startAgentId, ...(requestedAgentIds || [])].map((id) => String(id || "").trim()).filter(Boolean))];
}

function executionOwnerIdOf(run) {
  return String(run?.executionOwnerId || run?.route?.selected?.id || run?.startAgentId || run?.coordinatorId || "claude-fable");
}

function operationMessageId(kind, ownerId) {
  return `${kind}:${createHash("sha256").update(String(ownerId)).digest("hex")}`;
}

function legacyAskMessageId(run, ask) {
  return operationMessageId("legacy-ask", JSON.stringify({
    runId: run.id,
    from: ask?.from || null,
    at: ask?.at || null,
    text: ask?.text || "",
  }));
}

function answerOwnsAsk(run, answer, ask) {
  const askerIsMember = !Array.isArray(run.teamMembers)
    || run.teamMembers.length === 0
    || run.teamMembers.includes(ask.from);
  return askerIsMember
    && answer?.kind === "answer"
    && answer.from === "lo"
    && answer.to === ask.from
    && answer.refs?.answerToAskId === ask.id;
}

export async function renameWithRetry(source, target, {
  renameFile = rename,
  sleep = (delayMs) => new Promise((resolveTimer) => setTimeout(resolveTimer, delayMs)),
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(source, target);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_ERRORS.has(error?.code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error;
      await sleep(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function closeWithin(adapter, timeoutMs = 10_000) {
  let timer;
  const result = await Promise.race([
    Promise.resolve().then(() => adapter.close?.()).then(() => null, (error) => error),
    new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(new Error(`adapter close timed out after ${timeoutMs}ms`)), timeoutMs); }),
  ]);
  clearTimeout(timer);
  return result;
}

export class Orchestrator {
  constructor({
    router,
    adapters,
    eventStore,
    dataRoot,
    policy,
    approvalBroker,
    teams = null,
    teamMembers = null,
    projects = null,
    conversations = null,
    conversationContexts = null,
    models = null,
    modelDiscovery = null,
    capabilities = null,
    storage = null,
    macroStore = null, // W3.11 用户宏（/token 展开为普通提示词轮）；null=宏不可用
    remoteRunner = null, // v41 波二：远程 run 桥（ssh/remote-run.mjs）；null=远程 run 如实不可用
    repoRoot = null, // 远程 adapter 工厂表的 assertWithin 锚点（claude settings/grok 脚本 containment）
    interruptTimeoutMs = 30_000,
  }) {
    this.router = router;
    this.adapters = adapters;
    this.eventStore = eventStore;
    this.dataRoot = dataRoot;
    // W3.10 worktree 台账：建树/清树打点（append-only JSONL；dataRoot 缺失时如实退化为无台账）
    this.worktreeLedger = dataRoot ? createWorktreeLedger({ dataRoot }) : null;
    this.policy = policy;
    this.approvalBroker = approvalBroker;
    this.teams = teams;
    this.teamMembers = teamMembers;
    this.projects = projects;
    this.conversations = conversations;
    this.conversationContexts = conversationContexts;
    this.remoteRunner = remoteRunner;
    this.repoRoot = repoRoot;
    this.interruptTimeoutMs = Math.max(1, Math.trunc(Number(interruptTimeoutMs) || 30_000));
    // 远程 run 专用 adapter 缓存：`${runId}:${runtimeProfileId}` → Promise<{adapter, fallback}>。
    // 与本机席位池隔离；常驻型（codex app-server）靠它跨轮复用同一只远端进程（会话连续性）。
    this.remoteAdapters = new Map();
    this.models = models; // 可选：models.json 注册表（modelOptions 目录校验）；缺省回退 claude 白名单正则
    this.modelDiscovery = modelDiscovery; // 可选：CLI 原生动态目录（优先于静态 modelOptions/effortLevels）
    this.capabilities = capabilities; // dispatch 必需：缺失时 turn() fail-closed，不静默放行
    this.macroStore = macroStore; // W3.11 用户宏：原生命令未命中时兜底展开（null=不可用）
    this.runs = new Map();
    this.controllers = new Map();
    this.executions = new Map();
    this.createClaims = new Map(); // `${conversationId || "global"}\0${idempotencyKey}` -> in-flight create promise
    this.conversationMessageChains = new Map(); // conversationId -> serialized message admission promise
    this.contextClaimRunIds = new Set(); // Run persisted 前也必须占住 Conversation native session
    this.closing = false;
    this.closePromise = null;
    this.runDir = join(dataRoot, "runs");
    this.bus = new BusStore({ dataRoot }); // v3.6 社会模拟编排：消息总线（proposals/v36）
    this.rosterChain = Promise.resolve(); // 运行时 roster 读改写串行
    this.saveChains = new Map(); // per-run 写盘串行链（save 竞态修复），完成即自清
    this.transitionChains = new Map(); // per-run 短状态事务；串行 CAS + mutation + save，不包 provider
    this.lifecycleChains = new Map(); // provider 轮 checkpoint/mutation；前后复验 owner，close 固定点排空
    this.projectionChains = new Map(); // provider 结果投影；cancel 等当前投影收口后再清最终状态
    this.cancelEpochs = new Map(); // continue 入口捕获 epoch；并发 cancel 后旧准入必须失效
    this.cancellingRuns = new Set();
    this.interruptingRuns = new Set(); // 只中断当前 provider turn；不撤销 run 授权与原生会话
    this.askClaims = new Map(); // runId -> askId；仅保护同进程内 answer 所有权，不进入持久化状态
    // `${runId}::${agentId}` -> 在途直发续聊的原文：重复提交幂等门用（见 continue）。
    // 只活在内存：重启后没有在途轮，语义上就该清空，落盘只会留下永不过期的假在途。
    this.inflightContinuations = new Map();
    this.storage = { mkdir, readdir, readFile, ...(storage || {}) }; // init I/O seam；故障测试不依赖平台权限技巧
    // 已清除 run 的墓碑：终态尾巴协程（drain 收尾/emitEvent 降级路径）持有 run 引用的迟到 save
    // 会绕过 Map 复活文件——墓碑让 save 直接丢弃。uuid 每条约 40B、清除频率低，不回收。
    this.clearedRuns = new Set();
  }

  maxStepsForInteraction(run) {
    const configured = Number(run?.maxStepsPerInteraction ?? run?.maxRounds ?? this.policy.limits.maxRounds);
    const baseCap = Math.max(1, Math.trunc(Number(this.policy.limits.maxRounds) || 1));
    // social 模式上限高于 pipeline：显式派工闭环 + 往复余量；顶由 MAX_REQUESTED_AGENTS + 余量机械限制。
    const policyCap = run?.orchestrationMode === "social"
      ? baseCap + MAX_REQUESTED_AGENTS + SOCIAL_INTERACTION_HEADROOM
      : baseCap;
    return Math.max(1, Math.min(Math.trunc(Number.isFinite(configured) ? configured : policyCap), policyCap));
  }

  /**
   * 旧 run 兼容迁移：maxRounds 保留为审批/配置兼容名，但语义改为单次用户交互的自主步骤上限。
   * round 从此只做全会话单调 provider-turn 序号，不再承担封顶或配额回退。
   */
  ensureInteractionState(run) {
    let changed = false;
    const maxSteps = this.maxStepsForInteraction(run);
    if (run.maxStepsPerInteraction !== maxSteps) {
      run.maxStepsPerInteraction = maxSteps;
      changed = true;
    }
    if (!Number.isFinite(Number(run.maxRounds)) || Number(run.maxRounds) <= 0) {
      run.maxRounds = maxSteps;
      changed = true;
    }
    const hasConversation = Number(run.round || 0) > 0
      || Boolean((run.turnAttempts || []).length)
      || Boolean((run.resumeQueue || []).length)
      || run.execute === true;
    const sequence = Math.max(0, Math.trunc(Number(run.interactionSeq) || 0));
    if (sequence === 0 && hasConversation) {
      run.interactionSeq = 1;
      changed = true;
    } else if (run.interactionSeq !== sequence) {
      run.interactionSeq = sequence;
      changed = true;
    }
    if (!run.activeInteractionId && run.interactionSeq > 0) {
      run.activeInteractionId = `legacy:${run.id}:${run.interactionSeq}`;
      changed = true;
    }
    const activeSequence = Math.max(0, Math.trunc(Number(run.activeInteractionSeq) || 0));
    if (run.activeInteractionId && activeSequence === 0) {
      run.activeInteractionSeq = Math.max(1, run.interactionSeq || 1);
      changed = true;
    }
    if (!Number.isFinite(Number(run.interactionStep)) || Number(run.interactionStep) < 0) {
      // 老 run 没有 interactionStep；按已发生总轮数收紧当前旧交互，但下一条用户消息会新开预算。
      run.interactionStep = Math.min(Math.max(0, Math.trunc(Number(run.round) || 0)), maxSteps);
      changed = true;
    } else {
      const step = Math.max(0, Math.trunc(Number(run.interactionStep) || 0));
      if (run.interactionStep !== step) {
        run.interactionStep = step;
        changed = true;
      }
    }
    for (const field of ["interactionCostUsd", "interactionStepsRefunded", "interactionAutoRecoveries", "interactionContextCompactions"]) {
      const value = Math.max(0, Number(run[field]) || 0);
      if (run[field] !== value) {
        run[field] = value;
        changed = true;
      }
    }
    if (!Array.isArray(run.refundedAttemptIds)) {
      run.refundedAttemptIds = [];
      changed = true;
    }
    const activeSources = normalizeRunSources(
      Array.isArray(run.activeInteractionSources) ? run.activeInteractionSources : run.sources,
    );
    if (JSON.stringify(activeSources) !== JSON.stringify(run.activeInteractionSources || [])) {
      // 旧 run 的当前交互继续看到历史附件；下一条消息激活新交互后只绑定本次新附件。
      run.activeInteractionSources = activeSources;
      changed = true;
    }
    const pendingSources = normalizeRunSources(run.pendingInteractionSources || []);
    if (JSON.stringify(pendingSources) !== JSON.stringify(run.pendingInteractionSources || [])) {
      run.pendingInteractionSources = pendingSources;
      changed = true;
    }
    const rawStates = run.interactionStates && typeof run.interactionStates === "object" && !Array.isArray(run.interactionStates)
      ? run.interactionStates
      : {};
    const interactionStates = {};
    for (const [interactionId, rawState] of Object.entries(rawStates)) {
      if (!interactionId || !rawState || typeof rawState !== "object" || Array.isArray(rawState)) continue;
      interactionStates[interactionId] = {
        interactionSeq: Math.max(1, Math.trunc(Number(rawState.interactionSeq) || 1)),
        interactionStep: Math.max(0, Math.trunc(Number(rawState.interactionStep) || 0)),
        interactionCostUsd: Math.max(0, Number(rawState.interactionCostUsd) || 0),
        interactionStepsRefunded: Math.max(0, Math.trunc(Number(rawState.interactionStepsRefunded) || 0)),
        interactionAutoRecoveries: Math.max(0, Math.trunc(Number(rawState.interactionAutoRecoveries) || 0)),
        interactionContextCompactions: Math.max(0, Math.trunc(Number(rawState.interactionContextCompactions) || 0)),
        interactionStartedAt: rawState.interactionStartedAt || null,
        sources: normalizeRunSources(rawState.sources || []),
      };
    }
    if (run.activeInteractionId) {
      // 活跃标量是当前进程的即时真相；每次进入交互闸时同步回私有 ledger，供插话后恢复。
      interactionStates[run.activeInteractionId] = {
        interactionSeq: Math.max(1, Math.trunc(Number(run.activeInteractionSeq) || 1)),
        interactionStep: Math.max(0, Math.trunc(Number(run.interactionStep) || 0)),
        interactionCostUsd: Math.max(0, Number(run.interactionCostUsd) || 0),
        interactionStepsRefunded: Math.max(0, Math.trunc(Number(run.interactionStepsRefunded) || 0)),
        interactionAutoRecoveries: Math.max(0, Math.trunc(Number(run.interactionAutoRecoveries) || 0)),
        interactionContextCompactions: Math.max(0, Math.trunc(Number(run.interactionContextCompactions) || 0)),
        interactionStartedAt: run.interactionStartedAt || null,
        sources: activeSources,
      };
    }
    if (JSON.stringify(interactionStates) !== JSON.stringify(rawStates)) {
      run.interactionStates = interactionStates;
      changed = true;
    }
    return changed;
  }

  allocateInteraction(run, interactionId = randomUUID()) {
    this.ensureInteractionState(run);
    const interactionSeq = Math.max(0, Math.trunc(Number(run.interactionSeq) || 0)) + 1;
    run.interactionSeq = interactionSeq;
    return { interactionId, interactionSeq };
  }

  bindWorkToInteraction(run, descriptor) {
    if (!descriptor?.interactionId) return;
    const sources = normalizeRunSources(descriptor.sources || []);
    const bind = (item) => item && typeof item === "object"
      ? { ...item, interactionId: descriptor.interactionId, interactionSeq: descriptor.interactionSeq, sources }
      : item;
    run.resumeQueue = (run.resumeQueue || []).map(bind);
    if (run.resumeClaim) run.resumeClaim = bind(run.resumeClaim);
  }

  activateInteraction(run, descriptor, { adoptDurableWork = true } = {}) {
    if (!descriptor?.interactionId) throw Object.assign(new Error("interaction identity is required"), { code: "INTERACTION_INVALID" });
    this.ensureInteractionState(run);
    const interactionId = String(descriptor.interactionId);
    const interactionSeq = Math.max(1, Math.trunc(Number(descriptor.interactionSeq) || 1));
    if (run.activeInteractionId === descriptor.interactionId) return false;
    const stored = run.interactionStates?.[interactionId] || null;
    const sources = normalizeRunSources(stored?.sources ?? descriptor.sources ?? []);
    run.activeInteractionId = interactionId;
    run.activeInteractionSeq = stored?.interactionSeq || interactionSeq;
    run.interactionStep = stored?.interactionStep || 0;
    run.interactionCostUsd = stored?.interactionCostUsd || 0;
    run.interactionStepsRefunded = stored?.interactionStepsRefunded || 0;
    run.interactionAutoRecoveries = stored?.interactionAutoRecoveries || 0;
    run.interactionContextCompactions = stored?.interactionContextCompactions || 0;
    run.activeInteractionSources = sources;
    run.interactionStartedAt = stored?.interactionStartedAt || new Date().toISOString();
    run.stopReason = null;
    run.attention = null;
    run.interactionStates ||= {};
    run.interactionStates[interactionId] = {
      interactionSeq: run.activeInteractionSeq,
      interactionStep: run.interactionStep,
      interactionCostUsd: run.interactionCostUsd,
      interactionStepsRefunded: run.interactionStepsRefunded,
      interactionAutoRecoveries: run.interactionAutoRecoveries,
      interactionContextCompactions: run.interactionContextCompactions,
      interactionStartedAt: run.interactionStartedAt,
      sources,
    };
    if (adoptDurableWork) this.bindWorkToInteraction(run, descriptor);
    return true;
  }

  currentInteraction(run) {
    this.ensureInteractionState(run);
    return {
      interactionId: run.activeInteractionId,
      interactionSeq: run.activeInteractionSeq,
      sources: normalizeRunSources(run.activeInteractionSources || []),
    };
  }

  consumePendingInteractionSources(run) {
    this.ensureInteractionState(run);
    const sources = normalizeRunSources(run.pendingInteractionSources || []);
    run.pendingInteractionSources = [];
    return sources;
  }

  prepareInteractionSources(run, value) {
    const directSources = normalizeRunSources(value || []);
    const previous = {
      sources: normalizeRunSources(run.sources || []),
      pendingInteractionSources: normalizeRunSources(run.pendingInteractionSources || []),
    };
    const sources = normalizeRunSources([...previous.pendingInteractionSources, ...directSources]);
    run.sources = normalizeRunSources([...previous.sources, ...directSources]);
    run.pendingInteractionSources = [];
    return { sources, previous };
  }

  restorePreparedInteractionSources(run, previous) {
    if (!previous) return;
    run.sources = previous.sources;
    run.pendingInteractionSources = previous.pendingInteractionSources;
  }

  interactionSnapshot(run) {
    this.ensureInteractionState(run);
    return {
      interactionSeq: run.interactionSeq,
      activeInteractionId: run.activeInteractionId,
      activeInteractionSeq: run.activeInteractionSeq,
      interactionStep: run.interactionStep,
      interactionCostUsd: run.interactionCostUsd,
      interactionStepsRefunded: run.interactionStepsRefunded,
      interactionAutoRecoveries: run.interactionAutoRecoveries,
      interactionContextCompactions: run.interactionContextCompactions,
      interactionStartedAt: run.interactionStartedAt,
      activeInteractionSources: normalizeRunSources(run.activeInteractionSources || []),
      pendingInteractionSources: normalizeRunSources(run.pendingInteractionSources || []),
      interactionStates: structuredClone(run.interactionStates || {}),
    };
  }

  restoreInteraction(run, snapshot) {
    if (!snapshot) return;
    Object.assign(run, snapshot);
  }

  interactionLimitReached(run, reserve = 0) {
    this.ensureInteractionState(run);
    return Number(run.interactionStep || 0) + Math.max(0, Number(reserve) || 0) >= this.maxStepsForInteraction(run);
  }

  async init() {
    await this.storage.mkdir(this.runDir, { recursive: true });
    const resumeAfterRestart = [];
    const steerAfterRestart = [];
    let names;
    try {
      names = await this.storage.readdir(this.runDir);
    } catch (cause) {
      throw Object.assign(new Error(`run store cannot be listed: ${cause?.message || String(cause)}`), {
        code: "RUN_STORE_UNAVAILABLE",
        cause,
      });
    }
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      let run;
      let serialized;
      try {
        serialized = await this.storage.readFile(join(this.runDir, name), "utf8");
      } catch (cause) {
        throw Object.assign(new Error(`run store record cannot be read (${name}): ${cause?.message || String(cause)}`), {
          code: "RUN_STORE_READ_FAILED",
          record: name,
          cause,
        });
      }
      try {
        run = JSON.parse(serialized);
      } catch {
        // JSON 真损坏时没有可信 run 身份可投影；文件原样留盘待查。
        continue;
      }
      if (!run?.id) continue;
      // P0-07：异常 createdAt（null / 非 ISO / 不可解析）会让公共 list() 的
      // 时间序排序崩溃并污染恢复链。这里把它隔离——仍保留在控制面可见（可诊断），
      // 但标记为不可自动恢复，绝不让它参与 resume/replay 或把 /api/runs 打到 500。
      if (!(typeof run.createdAt === "string") || !Number.isFinite(Date.parse(run.createdAt))) {
        run.createdAt = run.createdAt == null ? null : run.createdAt;
        this.markRecoveryIssue(run, "RUN_CREATED_AT_INVALID", Object.assign(
          new Error("persisted run has an invalid createdAt; quarantined from recovery"),
          { code: "RUN_CREATED_AT_INVALID" },
        ));
        this.runs.set(run.id, run);
        continue;
      }
      this.runs.set(run.id, run); // 先建立控制面可见性；后续 bus/save 故障不能把有效 run 隐藏成 404。
      let restatedOnRestart = false;
      try {
        restatedOnRestart ||= this.ensureInteractionState(run);
        if (run.conversationKind == null) {
          run.conversationKind = "legacy_pipeline";
          restatedOnRestart = true;
        } else if (!CONVERSATION_KINDS.has(run.conversationKind)) {
          throw Object.assign(new Error(`persisted run has an invalid conversation kind: ${run.conversationKind}`), {
            code: "CONVERSATION_KIND_INVALID",
          });
        }
        if (run.conversationId === undefined) {
          run.conversationId = null;
          restatedOnRestart = true;
        }
        const persistedConversation = run.conversationId && this.conversations
          ? this.conversations.get(run.conversationId)
          : null;
        const persistedProjectId = persistedConversation?.projectId || null;
        if (run.projectId === undefined) {
          run.projectId = persistedProjectId;
          restatedOnRestart = true;
        } else if ((run.projectId || null) !== persistedProjectId && persistedConversation) {
          throw Object.assign(new Error("persisted run project does not match its conversation"), {
            code: "RUN_PROJECT_MISMATCH",
          });
        }
        if (run.projectId) {
          if (!this.projects) throw Object.assign(new Error("persisted project run has no project registry"), { code: "PROJECT_STORE_UNAVAILABLE" });
          const project = this.projects.get(run.projectId);
          if (run.cwd) {
            const actualKey = process.platform === "win32" ? resolve(run.cwd).toLowerCase() : resolve(run.cwd);
            const expectedKey = process.platform === "win32" ? resolve(project.canonicalCwd).toLowerCase() : resolve(project.canonicalCwd);
            if (actualKey !== expectedKey) {
              throw Object.assign(new Error("persisted run cwd does not match its project"), { code: "RUN_PROJECT_MISMATCH" });
            }
          }
        }
        const rosterCapabilitiesMigrated = migrateRunRosterCapabilities(run);
        restatedOnRestart = rosterCapabilitiesMigrated || restatedOnRestart;
        const currentInteraction = this.currentInteraction(run);
        const normalizedQueue = mergeResumeQueues(run.resumeQueue).map((item) => item.interactionId
          ? item
          : { ...item, ...currentInteraction });
        if (JSON.stringify(normalizedQueue) !== JSON.stringify(run.resumeQueue || [])) {
          run.resumeQueue = normalizedQueue;
          restatedOnRestart = true;
        }
        if (run.resumeClaim && !run.resumeClaim.interactionId) {
          run.resumeClaim = { ...run.resumeClaim, ...currentInteraction };
          restatedOnRestart = true;
        }
        if (run.resumeClaim && !Array.isArray(run.resumeClaim.sources)) {
          const claimed = (run.resumeQueue || []).find((item) => item?.itemId === run.resumeClaim.itemId);
          run.resumeClaim = {
            ...run.resumeClaim,
            sources: normalizeRunSources(claimed?.sources || currentInteraction.sources || []),
          };
          restatedOnRestart = true;
        }
        if (Array.isArray(run.pendingSteer)) {
          run.pendingSteer = run.pendingSteer.map((item) => {
            let normalized = item;
            if (!item?.interactionId) {
              normalized = { ...normalized, ...this.allocateInteraction(run) };
              restatedOnRestart = true;
            }
            if (!Array.isArray(normalized?.sources)) {
              normalized = { ...normalized, sources: [] };
              restatedOnRestart = true;
            }
            return normalized;
          });
        }
        if (run.activeSteer && !run.activeSteer.interactionId) {
          const queued = (run.pendingSteer || []).find((item) => item?.id === run.activeSteer.steerId);
          run.activeSteer = { ...run.activeSteer, ...(queued?.interactionId ? {
            interactionId: queued.interactionId,
            interactionSeq: queued.interactionSeq,
          } : currentInteraction) };
          restatedOnRestart = true;
        }
        const requestedAgentIds = normalizeRequestedAgentIds(run.requestedAgentIds, run.teamMembers);
        if (JSON.stringify(requestedAgentIds) !== JSON.stringify(run.requestedAgentIds || [])) {
          run.requestedAgentIds = requestedAgentIds;
          restatedOnRestart = true;
        }
        const executionOwnerId = executionOwnerIdOf(run);
        if (run.teamMembers?.length && !run.teamMembers.includes(executionOwnerId)) {
          throw Object.assign(new Error(`execution owner is outside the persisted team: ${executionOwnerId}`), { code: "NOT_TEAM_MEMBER" });
        }
        if (run.executionOwnerId !== executionOwnerId) {
          run.executionOwnerId = executionOwnerId;
          restatedOnRestart = true;
        }
        if (run.orchestrationMode === "social") {
          const members = new Set(run.teamMembers || []);
          const invalidTarget = (run.resumeQueue || []).find((item) => !members.has(item.to));
          if (invalidTarget) {
            throw Object.assign(new Error(`durable work target is outside the persisted team: ${invalidTarget.to}`), { code: "NOT_TEAM_MEMBER" });
          }
        }
        if (run.execute === true
          && run.orchestrationMode === "social"
          && Number(run.round || 0) === 0
          && !(run.turnAttempts || []).length
          && !run.pendingAsk
          && !run.resumeClaim
          && !(run.resumeQueue || []).length
          && !TERMINAL.has(run.status)) {
          const startAgentId = resolveStartAgentId(
            run.startAgentId,
            run.teamMembers,
            requestedAgentIds[0] || run.coordinatorId || "claude-fable",
          );
          const targets = initialSocialTargets(startAgentId, requestedAgentIds);
          if (targets.some((id) => !(run.teamMembers || []).includes(id))) {
            throw Object.assign(new Error("initial social work target is outside the persisted team"), { code: "NOT_TEAM_MEMBER" });
          }
          run.resumeQueue = mergeResumeQueues(targets.map((to) => ({
            to,
            busMessageId: operationMessageId("task", targets.length === 1 && to === startAgentId ? run.id : `${run.id}:${to}`),
            kind: "task",
            ...this.currentInteraction(run),
          })));
          for (const item of run.resumeQueue) {
            if (item.to === startAgentId) continue;
            this.recordTaskGraphDelegation(run, {
              fromAgentId: "lo",
              toAgentId: item.to,
              busMessageId: item.busMessageId,
              kind: "mention",
              state: "queued",
            });
          }
          restatedOnRestart = true;
        }
        const busReconciliation = await this.reconcileSocialBus(run);
        restatedOnRestart ||= busReconciliation.changed;
      } catch (error) {
        this.markRecoveryIssue(run, "BUS_RECONCILIATION_FAILED", error);
        restatedOnRestart = true;
      }
      try {
        if (run.status === "waiting_approval") {
          restatedOnRestart = true;
          run.status = "cancelled";
          if (run.buildApproval) run.buildApproval.status = "expired";
          run.error = "Pending approval expired when the control plane restarted.";
          run.recoveryNote = "Submit a new build run to create a fresh action-bound approval.";
        } else if (["running", "waiting_agent"].includes(run.status)) {
          restatedOnRestart = true;
          if (run.permissionMode === "build") {
            run.status = "cancelled";
            if (run.buildApproval) run.buildApproval.status = "revoked";
            this.revokeCapabilityLease(run, "control-plane-restart");
            run.error = "A write-capable run cannot resume automatically after a control-plane restart.";
            run.recoveryNote = "Native session IDs are retained for read-only inspection; submit a new build run for further writes.";
          } else if (this.hasAmbiguousRestartWork(run)) {
            run.status = "recovery_required";
            run.error = "A native turn may have been submitted before the control plane stopped.";
            run.recoveryNote = "Inspect the persisted session and explicitly acknowledge recovery before sending another prompt; automatic replay is blocked.";
          } else {
            run.status = "waiting_agent";
            run.recoveryNote = "Control plane restarted; native session IDs are retained and can be continued.";
          }
        }
        if (restatedOnRestart) {
          try {
            await this.save(run);
          } catch (error) {
            this.markRecoveryIssue(run, "RESTART_PERSISTENCE_FAILED", error);
            this.runs.set(run.id, run);
          }
        }
        if (["queued", "waiting_agent"].includes(run.status)
          && run.permissionMode !== "build"
          && !run.pendingAsk
          && ((run.resumeQueue || []).length || run.resumeClaim)) {
          resumeAfterRestart.push(run.id);
        } else if (["waiting_agent", "succeeded"].includes(run.status)
          && ((run.pendingSteer || []).length || run.activeSteer)) {
          steerAfterRestart.push(run.id);
        }
      } catch (error) {
        this.markRecoveryIssue(run, "RESTART_RESTATEMENT_FAILED", error);
        this.runs.set(run.id, run);
      }
    }
    for (const id of resumeAfterRestart) {
      setImmediate(() => {
        const run = this.runs.get(id);
        if (!this.closing && ["queued", "waiting_agent"].includes(run?.status) && run.permissionMode !== "build" && !run.pendingAsk
          && ((run.resumeQueue || []).length || run.resumeClaim)) {
          void this.startExecution(id);
        }
      });
    }
    for (const id of steerAfterRestart) {
      setImmediate(() => {
        const run = this.runs.get(id);
        if (this.closing || !run || !["waiting_agent", "succeeded"].includes(run.status)) return;
        if (!((run.pendingSteer || []).length || run.activeSteer) || this.controllers.has(id)) return;
        const controller = new AbortController();
        this.controllers.set(id, controller);
        void this.startSteerDrain(id, controller);
      });
    }
    return this;
  }

  async snapshotTeamRoster(memberIds) {
    const ids = [...new Set((memberIds || []).map((id) => String(id).trim()).filter(Boolean))];
    if (!ids.length) return [];
    // Transitional compatibility for legacy callers whose team members are runtime profiles.
    if (!this.teamMembers) return ids.map((id) => legacyTeamMember(id));

    const byId = new Map();
    if (typeof this.teamMembers.snapshot === "function") {
      const pendingSnapshot = this.teamMembers.snapshot(ids);
      const snapshot = pendingSnapshot && typeof pendingSnapshot.then === "function"
        ? await pendingSnapshot
        : pendingSnapshot;
      for (const raw of rosterSnapshotEntries(snapshot)) {
        if (!raw || typeof raw !== "object") continue;
        const member = normalizeTeamMember(raw);
        if (member.teamMemberEligible !== true) {
          throw Object.assign(new Error(`team member is not executable: ${member.id}`), {
            code: "RUNTIME_PROFILE_INELIGIBLE",
            eligibilityReason: member.eligibilityReason || null,
          });
        }
        if (ids.includes(member.id)) byId.set(member.id, member);
      }
    }
    for (const id of ids) {
      if (byId.has(id)) continue;
      if (typeof this.teamMembers.get !== "function") {
        throw Object.assign(new Error(`team member snapshot is missing ${id}`), { code: "TEAM_MEMBER_NOT_FOUND" });
      }
      const pendingMember = this.teamMembers.get(id);
      const raw = pendingMember && typeof pendingMember.then === "function"
        ? await pendingMember
        : pendingMember;
      const member = normalizeTeamMember(raw, id);
      if (member.teamMemberEligible !== true) {
        throw Object.assign(new Error(`team member is not executable: ${id}`), {
          code: "RUNTIME_PROFILE_INELIGIBLE",
          eligibilityReason: member.eligibilityReason || null,
        });
      }
      byId.set(id, member);
    }
    return ids.map((id) => byId.get(id));
  }

  rosterForRun(run) {
    const rosterVersion = Number(run?.teamRosterVersion || 0);
    if (!Object.hasOwn(run || {}, "teamRoster") || run.teamRoster == null) {
      if (rosterVersion >= 1) {
        throw Object.assign(new Error("persisted team roster is missing"), {
          code: "TEAM_MEMBER_SNAPSHOT_INVALID",
        });
      }
      return null;
    }
    const entries = rosterSnapshotEntries(run.teamRoster);
    if (rosterVersion >= 1) {
      const expectedIds = Array.isArray(run.teamMembers) ? run.teamMembers : null;
      const rosterIds = entries.map((member) => member?.id);
      const snapshotMatchesTeam = expectedIds
        && entries.length === expectedIds.length
        && rosterIds.every((id, index) => id === expectedIds[index]);
      const runtimeBindingsAreExplicit = entries.every((member) =>
        typeof member?.runtimeProfileId === "string" && member.runtimeProfileId.trim());
      if (!snapshotMatchesTeam || !runtimeBindingsAreExplicit || entries.some((member) => member?.teamMemberEligible !== true)) {
        throw Object.assign(new Error("persisted team roster does not match its executable-member assertions"), {
          code: "TEAM_MEMBER_SNAPSHOT_INVALID",
        });
      }
    }
    return entries.map((member) => normalizeTeamMember(member));
  }

  memberForRun(run, memberId) {
    const id = String(memberId ?? "").trim();
    const roster = this.rosterForRun(run);
    if (roster == null) return legacyTeamMember(id);
    const member = rosterMember(roster, id);
    if (!member) {
      throw Object.assign(new Error(`${id} is absent from this run's persisted team roster`), {
        code: "NOT_TEAM_MEMBER",
      });
    }
    if (member.teamMemberEligible !== true) {
      throw Object.assign(new Error(`team member is not executable: ${id}`), {
        code: "RUNTIME_PROFILE_INELIGIBLE",
        eligibilityReason: member.eligibilityReason || null,
      });
    }
    if (id === run.coordinatorId && member.coordinatorEligible !== true) {
      throw Object.assign(new Error(`team coordinator is not executable: ${id}`), {
        code: "RUNTIME_PROFILE_INELIGIBLE",
        eligibilityReason: member.eligibilityReason || null,
      });
    }
    return member;
  }

  runtimeProfileIdFor(run, memberId) {
    return this.memberForRun(run, memberId).runtimeProfileId;
  }

  mapRuntimeRoute(route, teamRoster, preferredMemberIds = []) {
    const mapEntry = (entry, excludedMemberId = null, requireUnclaimed = false) => {
      if (!entry) return null;
      const runtimeProfileId = runtimeRouteId(entry);
      if (!runtimeProfileId) {
        throw Object.assign(new Error("router returned a route without a runtime profile"), { code: "NO_ROUTE" });
      }
      if (!Array.isArray(teamRoster)) {
        return { ...entry, id: runtimeProfileId, runtimeProfileId };
      }
      const candidates = teamRoster.filter((member) => member.runtimeProfileId === runtimeProfileId);
      if (!candidates.length) {
        throw Object.assign(new Error(`router selected a runtime profile outside the team roster: ${runtimeProfileId}`), {
          code: "NO_ROUTE",
        });
      }
      const unclaimed = candidates.filter((member) => member.id !== excludedMemberId);
      if (requireUnclaimed && excludedMemberId && !unclaimed.length) return null;
      const pool = unclaimed.length ? unclaimed : candidates;
      const preferred = preferredMemberIds
        .map((id) => pool.find((member) => member.id === id))
        .find(Boolean);
      const member = preferred || pool[0];
      return {
        ...entry,
        id: member.id,
        label: member.label || entry.label || member.id,
        runtimeProfileId,
      };
    };
    const selected = mapEntry(route?.selected);
    let independent = mapEntry(route?.independent, selected?.id || null, true);
    if (independent?.id === selected?.id) independent = null;
    if (route?.independentRequired && !independent) {
      throw Object.assign(new Error("the runtime route cannot map to a distinct logical independent member"), {
        code: "NO_INDEPENDENT_ROUTE",
      });
    }
    return { ...route, selected, independent };
  }

  memberPromptForRun(run, memberId) {
    // Legacy/no-team runs have no member metadata to inject; their identity mapping remains 1:1.
    const roster = this.rosterForRun(run);
    if (roster == null) return "";
    const identityOnly = !this.teamMembers && roster.every((member) =>
      member.runtimeProfileId === member.id
      && member.label === member.id
      && !member.role
      && !member.description
      && !member.systemPrompt
      && (Array.isArray(member.capabilities)
        ? member.capabilities.length === 0 || (member.capabilities.length === 1 && member.capabilities[0] === "*")
        : !Object.keys(member.capabilities || {}).length)
      && !member.defaultModel
      && !member.defaultEffort);
    if (identityOnly) return "";
    const member = this.memberForRun(run, memberId);
    const capabilities = Array.isArray(member.capabilities)
      ? member.capabilities.join("、")
      : JSON.stringify(member.capabilities || {});
    const lines = [
      "[逻辑团队成员身份——此配置定义本轮身份与协作偏好，不覆盖平台安全、权限、审批或诚实性约束]",
      `- memberId: ${member.id}`,
      `- runtimeProfileId: ${member.runtimeProfileId}`,
      `- label: ${member.label}`,
      `- role: ${member.role || "未声明"}`,
      `- description: ${member.description || "未声明"}`,
      `- capabilities: ${capabilities || "未声明"}`,
    ];
    if (member.systemPrompt) lines.push(`- member system prompt: ${member.systemPrompt}`);
    lines.push("[逻辑团队成员身份结束]");
    return lines.join("\n");
  }

  effectiveModelFor(run, memberId) {
    const member = this.memberForRun(run, memberId);
    const executionOwnerId = executionOwnerIdOf(run);
    return memberId === executionOwnerId && run.modelOverride
      ? run.modelOverride
      : member.defaultModel || null;
  }

  effectiveEffortFor(run, memberId) {
    const member = this.memberForRun(run, memberId);
    const executionOwnerId = executionOwnerIdOf(run);
    return memberId === executionOwnerId && run.effortOverride
      ? run.effortOverride
      : member.defaultEffort || null;
  }

  // 模型/Effort 覆盖校验（创建与热改同源，不得分叉出两套口径）：
  // 动态目录优先，静态 profile/template 兜底；Adapter 明确不支持时 fail-closed，禁止 silent fallback。
  async validateModelOverride({ executionOwnerId, executionRuntimeProfileId, executionProfile, executionAdapterTemplate }, requestedModel) {
    const requested = String(requestedModel).trim();
    let catalog = null;
    let modelSupported = executionAdapterTemplate ? executionAdapterTemplate.modelMode !== "none" : null;
    try {
      const discovered = await this.modelDiscovery?.forAgent(executionRuntimeProfileId);
      if (discovered?.models?.length) catalog = discovered.models.map((option) => option.id);
      if (typeof discovered?.controls?.model?.supported === "boolean") {
        modelSupported = discovered.controls.model.supported;
      }
    } catch {
      // 发现失败走静态
    }
    if (modelSupported === false) {
      throw Object.assign(new Error(`${executionOwnerId} adapter does not support model overrides`), { code: "INVALID_MODEL" });
    }
    if (!catalog) {
      catalog = Array.isArray(executionProfile?.modelOptions) ? executionProfile.modelOptions.map((option) => option.id).filter(Boolean) : null;
    }
    const safeModelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(requested);
    const allowed = catalog?.length ? catalog.includes(requested) : modelSupported === true ? safeModelId : /^(?:fable|opus|sonnet|haiku|claude-[a-z0-9.-]{1,48})$/i.test(requested);
    if (!allowed) {
      throw Object.assign(new Error(`unsupported model for ${executionOwnerId}: ${requested}`), { code: "INVALID_MODEL" });
    }
    return requested;
  }

  async validateEffortOverride({ executionOwnerId, executionRuntimeProfileId, executionProfile, executionAdapterTemplate }, requestedEffort) {
    const requested = String(requestedEffort).trim().toLowerCase();
    let levels = null;
    let effortSupported = executionAdapterTemplate ? executionAdapterTemplate.effortMode !== "none" : null;
    try {
      const discovered = await this.modelDiscovery?.forAgent(executionRuntimeProfileId);
      if (discovered?.effortLevels?.length) levels = discovered.effortLevels;
      if (typeof discovered?.controls?.effort?.supported === "boolean") {
        effortSupported = discovered.controls.effort.supported;
      }
    } catch {
      // 发现失败走静态
    }
    if (effortSupported === false) {
      throw Object.assign(new Error(`${executionOwnerId} adapter does not support effort overrides`), { code: "INVALID_EFFORT" });
    }
    if (!levels) {
      if (executionProfile?.effortLevels?.length) levels = executionProfile.effortLevels;
      else if (executionAdapterTemplate?.effortLevels?.length) levels = executionAdapterTemplate.effortLevels;
    }
    const allowed = levels?.length
      ? levels.includes(requested)
      : effortSupported === true
        ? false
        : /^(?:low|medium|high|xhigh|max)$/.test(requested);
    if (!allowed) {
      throw Object.assign(new Error(`unsupported effort level for ${executionOwnerId}: ${requested}`), { code: "INVALID_EFFORT" });
    }
    return requested;
  }

  // 权限覆盖校验（与 effort 覆盖同款位置：创建与热改同源）：值必须在当前模板声明的
  // permissionModes 内（含 native:* 透传档），否则拒绝并回报原因（fail-closed）。
  // 接线层只对 native: 前缀的值透传给 Adapter；普通三档维持原路径。
  validatePermissionOverride({ executionOwnerId, executionAdapterTemplate }, requestedPermission) {
    const requested = String(requestedPermission).trim();
    const modes = executionAdapterTemplate?.permissionModes;
    if (!Array.isArray(modes) || !modes.length || !modes.includes(requested)) {
      throw Object.assign(new Error(`unsupported permission override for ${executionOwnerId}: ${requested}`), { code: "INVALID_PERMISSION" });
    }
    return requested;
  }

  markRecoveryIssue(run, code, error) {
    run.auditDegraded = true;
    run.persistenceDegraded = true;
    run.recoveryIssue = {
      code,
      message: error?.message || String(error),
      at: new Date().toISOString(),
    };
    if (!TERMINAL.has(run.status)) run.status = "recovery_required";
    run.recoveryNote = `Automatic recovery is blocked: ${code}. Inspect the persisted run and bus before acknowledging recovery.`;
  }

  hasAmbiguousRestartWork(run) {
    const attempts = run.turnAttempts || [];
    if (attempts.some((attempt) => ["submitting", "submitted", "ambiguous"].includes(attempt.phase))) return true;
    const claims = [run.resumeClaim?.itemId, run.activeSteer?.steerId].filter(Boolean);
    return claims.some((claimId) => attempts.some((attempt) =>
      attempt.sourceWorkItemId === claimId
      && ["submitting", "submitted", "ambiguous", "completed"].includes(attempt.phase)));
  }

  requiresRecovery(run, error = null) {
    if (error?.code === "RECOVERY_REQUIRED") return true;
    if (error?.nativeSessionBusy === true) return true;
    if (isPromptTransportError(error)) return false;
    if (error?.nativeTurnSettled === true) return false;
    return Boolean(run.resumeClaim)
      || Boolean((run.resumeQueue || []).length)
      || Boolean(run.activeSteer)
      || this.hasAmbiguousRestartWork(run);
  }

  /**
   * 超时轮自动续跑判决。四个条件缺一不可：
   * ① 超时家族错误（TURN_TIMEOUT/TURN_IDLE_TIMEOUT）——其它 ambiguous（如 OUTPUT_LIMIT）续跑只会重演；
   * ② interruptConfirmed === true——provider 确认原生轮已死，续跑不与任何活跃工作并发；
   * ③ 只读/plan 轮——被打断的轮不可能留下写盘残留（workspace-write 轮必须人工检查半成品）；
   * ④ 有原生会话可续且当前交互仍有 step/自动恢复预算（防脚本化白烧，超限回落人工闸）。
   */
  autoRecoveryDecision(run, agentId, error, effectivePermissionMode) {
    if (!AUTO_RECOVERY_TIMEOUT_CODES.has(error?.code)) return { ok: false, reason: "not-a-timeout" };
    if (error.interruptConfirmed !== true) return { ok: false, reason: "interrupt-unconfirmed" };
    if (!["read-only", "plan"].includes(effectivePermissionMode)) return { ok: false, reason: "write-turn" };
    if (!(error.sessionId || run.sessions?.[agentId])) return { ok: false, reason: "no-native-session" };
    if (this.interactionLimitReached(run)) return { ok: false, reason: "step-limit" };
    if ((run.interactionAutoRecoveries || 0) >= MAX_AUTO_RECOVERIES_PER_INTERACTION) return { ok: false, reason: "cap-exhausted" };
    return { ok: true };
  }

  async withRunTransition(runId, operation) {
    const previous = this.transitionChains.get(runId) || Promise.resolve();
    const transition = previous.catch(() => {}).then(operation);
    this.transitionChains.set(runId, transition);
    try {
      return await transition;
    } finally {
      if (this.transitionChains.get(runId) === transition) this.transitionChains.delete(runId);
    }
  }

  async withRunLifecycle(runId, operation) {
    const previous = this.lifecycleChains.get(runId) || Promise.resolve();
    const lifecycle = previous.catch(() => {}).then(operation);
    this.lifecycleChains.set(runId, lifecycle);
    try {
      return await lifecycle;
    } finally {
      if (this.lifecycleChains.get(runId) === lifecycle) this.lifecycleChains.delete(runId);
    }
  }

  async withRunProjection(runId, operation) {
    const previous = this.projectionChains.get(runId) || Promise.resolve();
    const projection = previous.catch(() => {}).then(operation);
    this.projectionChains.set(runId, projection);
    try {
      return await projection;
    } finally {
      if (this.projectionChains.get(runId) === projection) this.projectionChains.delete(runId);
    }
  }

  cancelEpoch(runId) {
    return this.cancelEpochs.get(runId) || 0;
  }

  assertContinuationAdmission(runId, expectedEpoch) {
    if (this.closing) {
      throw Object.assign(new Error("control plane is shutting down"), { code: "CONTROL_PLANE_CLOSING" });
    }
    if (this.interruptingRuns.has(runId)) {
      throw Object.assign(new Error("the current provider turn is still being interrupted"), { code: "RUN_INTERRUPTING" });
    }
    if (this.cancellingRuns.has(runId) || this.cancelEpoch(runId) !== expectedEpoch) {
      throw Object.assign(new Error("run cancellation superseded this continuation"), { code: "RUN_CANCELLED" });
    }
  }

  async withLifecycleEffect(run, controller, operation) {
    return this.withRunLifecycle(run.id, async () => {
      this.assertLifecycleOwner(run, controller);
      const result = await operation();
      this.assertLifecycleOwner(run, controller);
      return result;
    });
  }


  async withProjectionEffect(run, controller, operation) {
    return this.withRunProjection(run.id, async () => {
      this.assertLifecycleOwner(run, controller);
      const result = await operation();
      this.assertLifecycleOwner(run, controller);
      return result;
    });
  }

  /**
   * v41 波二：远程 run 的专用 adapter（缓存 Promise 防并发双建——同键两轮并发会各起一只远端
   * 常驻进程，先者泄漏）。grok-mcp 在 createRemoteAdapter 模板层如实拒绝（REMOTE_ADAPTER_UNSUPPORTED）。
   */
  remoteAdapterFor(run, runtimeProfileId) {
    const key = `${run.id}:${runtimeProfileId}`;
    let pending = this.remoteAdapters.get(key);
    if (!pending) {
      const requiredRemoteMethods = ["validateRemote", "assertRunnable", "assertDispatchable"];
      const missingRemoteMethods = requiredRemoteMethods.filter((method) => typeof this.remoteRunner?.[method] !== "function");
      if (missingRemoteMethods.length) {
        throw Object.assign(
          new Error(`remote runner cannot enforce the current run contract: missing ${missingRemoteMethods.join(", ")}`),
          { code: "REMOTE_UNAVAILABLE" },
        );
      }
      const profile = (this.models?.profiles || []).find((item) => item.id === runtimeProfileId);
      if (!profile) {
        throw Object.assign(new Error(`no runtime profile for remote adapter: ${runtimeProfileId}`), { code: "ADAPTER_UNAVAILABLE" });
      }
      const remote = {
        spawnImpl: this.remoteRunner.spawnImpl(run.remote.hostId, run.remote.path),
        runProcessImpl: this.remoteRunner.runProcessImpl(run.remote.hostId, run.remote.path),
      };
      pending = Promise.resolve().then(() => createRemoteAdapter({
        profile,
        eventStore: this.eventStore,
        cwd: this.repoRoot || this.dataRoot,
        approvalResolver: (message, context) => this.approvalBroker.request(message, context),
        remote,
      }));
      this.remoteAdapters.set(key, pending);
      void pending.catch(() => {
        if (this.remoteAdapters.get(key) === pending) this.remoteAdapters.delete(key);
      });
    }
    return pending;
  }

  assertRemoteDispatchable(run) {
    if (!run?.remote) return;
    if (typeof this.remoteRunner?.assertDispatchable !== "function") {
      throw Object.assign(new Error("remote runner cannot enforce per-dispatch SSH authorization"), { code: "REMOTE_UNAVAILABLE" });
    }
    this.remoteRunner.assertDispatchable(run.remote.hostId, run.remote.path);
  }

  providerBindingFor(adapter, runtimeProfileId, { remote = false } = {}) {
    const profile = (this.models?.profiles || []).find((item) => item.id === runtimeProfileId) || null;
    const requestedProviderId = profile?.providerId == null ? null : String(profile.providerId).trim() || null;
    if (!remote && typeof adapter?.getProviderBinding === "function") {
      const binding = adapter.getProviderBinding();
      return {
        requestedProviderId: binding?.requestedProviderId ?? requestedProviderId,
        effectiveProviderId: binding?.effectiveProviderId ?? null,
        mode: binding?.mode === "bound" ? "bound" : "adapter-managed",
        degradedReason: binding?.degradedReason ?? null,
        degradedDetail: binding?.degradedDetail ?? null,
        providerApp: binding?.providerApp ?? null,
        adapterId: binding?.adapterId || adapter?.id || null,
        routeMode: binding?.routeMode ?? (binding?.mode === "bound" ? "direct-projection" : "adapter-managed"),
        bindingScope: binding?.bindingScope ?? (binding?.mode === "bound" ? "upstream" : "adapter"),
        upstreamProviderId: binding?.upstreamProviderId ?? (binding?.mode === "bound" ? binding?.effectiveProviderId ?? null : null),
        upstreamAttribution: binding?.upstreamAttribution ?? (binding?.mode === "bound" ? "exact" : "unavailable"),
      };
    }
    return {
      requestedProviderId,
      effectiveProviderId: null,
      mode: "adapter-managed",
      degradedReason: requestedProviderId
        ? (remote ? "remote-provider-projection-disabled" : "binding-descriptor-unavailable")
        : null,
      degradedDetail: null,
      providerApp: null,
      adapterId: adapter?.id || null,
      routeMode: "adapter-managed",
      bindingScope: "adapter",
      upstreamProviderId: null,
      upstreamAttribution: "unavailable",
    };
  }

  conversationContextPlan({ conversation, conversationKind, projectId, sessionCwd, sessionRemote, teamRoster, executionOwnerId }) {
    if (!conversation || conversationKind === "legacy_pipeline" || !this.conversationContexts) return null;
    // Remote adapters are instantiated per Run and bind host-local process state. Until that
    // factory exposes a stable cross-Run resume contract, local and remote epochs stay isolated.
    if (sessionRemote) return null;
    const memberIds = conversationKind === "direct"
      ? [executionOwnerId]
      : [...new Set(conversation.memberIds || [])].sort();
    const cwdKey = sessionCwd
      ? (process.platform === "win32" ? sessionCwd.toLowerCase() : sessionCwd)
      : null;
    const candidates = [];
    const topologyMembers = [];
    for (const memberId of memberIds) {
      const runtimeProfileId = teamRoster
        ? rosterMember(teamRoster, memberId)?.runtimeProfileId || null
        : memberId;
      const adapter = runtimeProfileId ? this.adapters.get(runtimeProfileId) : null;
      const providerBinding = adapter && runtimeProfileId
        ? this.providerBindingFor(adapter, runtimeProfileId, { remote: false })
        : null;
      topologyMembers.push({
        memberId,
        runtimeProfileId,
        adapterId: adapter?.id || null,
        providerBinding,
      });
      if (!runtimeProfileId || !adapter?.id || !ADAPTER_RESUME_FEATURES[adapter.id]) continue;
      candidates.push({
        memberId,
        runtimeProfileId,
        adapterId: adapter.id,
        providerBinding,
        cwdKey,
        remoteKey: null,
      });
    }
    const topology = {
      conversationId: conversation.id,
      conversationKind,
      projectId: projectId || null,
      roomRole: conversation.roomRole || null,
      cwdKey,
      remoteKey: null,
      members: topologyMembers,
    };
    return {
      topologyKey: createHash("sha256").update(stableJson(topology)).digest("hex"),
      candidates,
    };
  }

  async publishConversationContext(run, agentId, attemptId, response, adapter, providerBinding) {
    if (!this.conversationContexts || !run.conversationId || !run.contextTopologyKey) return { published: false, reason: "disabled" };
    const attempt = (run.turnAttempts || []).find((item) => item.attemptId === attemptId) || null;
    if (!response?.sessionId || attempt?.sessionResumable === false || !ADAPTER_RESUME_FEATURES[adapter?.id]) {
      return { published: false, reason: "not-resumable" };
    }
    try {
      const result = await this.conversationContexts.publish({
        conversationId: run.conversationId,
        topologyKey: run.contextTopologyKey,
        runId: run.id,
        ownerIsValid: () => {
          this.assertLifecycleOwner(run, this.controllers.get(run.id));
          return true;
        },
        binding: {
          memberId: agentId,
          sessionId: response.sessionId,
          runtimeProfileId: this.runtimeProfileIdFor(run, agentId),
          adapterId: adapter.id,
          protocol: response.protocol || attempt?.protocol || adapter.id,
          providerBinding,
          sourceAttemptId: attemptId,
          cwdKey: run.cwd ? (process.platform === "win32" ? run.cwd.toLowerCase() : run.cwd) : null,
          remoteKey: null,
        },
      });
      run.contextPublication = {
        state: result.published ? "published" : "skipped",
        agentId,
        sourceAttemptId: attemptId,
        reason: result.reason || null,
        epoch: result.epoch || run.contextEpoch || null,
        updatedAt: new Date().toISOString(),
      };
      await this.save(run);
      return result;
    } catch (error) {
      run.contextPublication = {
        state: "failed",
        agentId,
        sourceAttemptId: attemptId,
        code: error?.code || "CONVERSATION_CONTEXT_STORE_UNAVAILABLE",
        message: error?.message || "conversation context publication failed",
        updatedAt: new Date().toISOString(),
      };
      await this.save(run).catch(() => {});
      await this.emitEvent(run, "run.context_publication_failed", {
        agentId,
        sourceAttemptId: attemptId,
        code: run.contextPublication.code,
        message: run.contextPublication.message,
      }, { runId: run.id, sessionId: response.sessionId, agentId });
      return { published: false, reason: "store-unavailable" };
    }
  }

  async invalidateConversationContext(run, agentId, sessionId, reason) {
    if (!this.conversationContexts || !run.conversationId || !sessionId) return { invalidated: false };
    return this.conversationContexts.invalidate({
      conversationId: run.conversationId,
      memberId: agentId,
      sessionId,
      reason,
    });
  }

  isConversationContextBindingUnsafe(conversationId, memberId, binding) {
    const bindingUpdatedAt = Number.isFinite(Date.parse(binding?.updatedAt)) ? Date.parse(binding.updatedAt) : -1;
    return [...this.runs.values()].some((candidate) => {
      if (candidate.conversationId !== conversationId) return false;
      if ((candidate.invalidatedSessions || []).some((entry) => (
        entry?.agentId === memberId && entry?.sessionId === binding?.sessionId
      ))) return true;
      const publication = candidate.contextPublication;
      return publication?.state === "failed"
        && publication.agentId === memberId
        && (!Number.isFinite(Date.parse(publication.updatedAt)) || Date.parse(publication.updatedAt) >= bindingUpdatedAt);
    });
  }

  /** 远程 run 终态处置：关闭其专用 adapter（codex app-server close → 通道收 + pgid kill 远端进程树）。 */
  async disposeRemoteAdapters(runId) {
    const prefix = `${runId}:`;
    const entries = [...this.remoteAdapters.entries()].filter(([key]) => key.startsWith(prefix));
    for (const [key, pending] of entries) {
      if (this.remoteAdapters.get(key) !== pending) continue; // 不删后入的新主（同名键竞态纪律）
      this.remoteAdapters.delete(key);
      const pair = await pending.catch(() => null);
      for (const adapter of [pair?.adapter, pair?.fallback]) {
        if (typeof adapter?.close === "function") await adapter.close().catch(() => {});
      }
    }
  }

  assertLifecycleOwner(run, controller) {
    if (!controller || controller.signal.aborted || this.controllers.get(run.id) !== controller || run.status === "cancelled") {
      throw Object.assign(new Error("run cancelled or execution ownership changed"), { code: "ABORTED" });
    }
  }

  policySha256() {
    return createHash("sha256").update(JSON.stringify(this.policy)).digest("hex");
  }

  buildApprovalMessage(run) {
    const policySha256 = this.policySha256();
    const executionOwnerId = executionOwnerIdOf(run);
    const executionOwnerRuntimeProfileId = this.runtimeProfileIdFor(run, executionOwnerId);
    const routeSelectedAgent = run.route.selected.id;
    const routeSelectedRuntimeProfileId = this.runtimeProfileIdFor(run, routeSelectedAgent);
    const coordinatorId = run.coordinatorId || "claude-fable";
    const startAgentId = run.startAgentId || coordinatorId;
    const adapterWorkspace = this.adapters.get(executionOwnerRuntimeProfileId)?.cwd || null;
    // 远程 run：工作区=规范化 ssh:// 串（§3.3 审批哈希口径）——绝不进本机 resolve()/git 语义
    const workspace = run.remote
      ? this.remoteRunner?.workspaceLabel(run.remote.hostId, run.remote.path) ?? `ssh://${run.remote.hostId}${run.remote.path}`
      : run.cwd || adapterWorkspace;
    return {
      method: "control/runBuild/requestApproval",
      params: {
        runId: run.id,
        promptSha256: createHash("sha256").update(run.prompt).digest("hex"),
        workspace: run.remote ? workspace : workspace ? resolve(workspace) : null,
        workspaceSource: run.remote ? "run.remote" : run.cwd ? "run.cwd" : "adapter.cwd",
        isolation: run.remote ? "remote-unsupported" : run.cwd ? "git-worktree" : "none",
        selectedAgent: executionOwnerId,
        selectedRuntimeProfileId: executionOwnerRuntimeProfileId,
        executionOwnerId,
        executionOwnerRuntimeProfileId,
        routeSelectedAgent,
        routeSelectedRuntimeProfileId,
        coordinatorId,
        coordinatorRuntimeProfileId: this.runtimeProfileIdFor(run, coordinatorId),
        startAgentId,
        startRuntimeProfileId: this.runtimeProfileIdFor(run, startAgentId),
        model: this.effectiveModelFor(run, executionOwnerId),
        effort: this.effectiveEffortFor(run, executionOwnerId),
        permissionMode: run.permissionMode,
        collaborationMode: run.collaborationMode,
        // 兼容字段 maxRounds 的实际语义是「单次用户交互的自主步骤上限」。锚定批准时的值，
        // 让后续每条消息复用同一授权边界；全会话 round 只做审计序号，不进入封顶语义。
        // 工作区 / 执行者 / 权限档 / prompt / policy 仍全部入哈希，每个写盘 turn 继续校验 lease。
        maxRounds: run.buildApproval?.approvedMaxRounds ?? run.maxRounds,
        policyVersion: this.policy.version,
        policySha256,
      },
    };
  }

  buildApprovalIsValid(run) {
    if (run.permissionMode !== "build" || run.buildApproval?.status !== "approved") return false;
    const message = this.buildApprovalMessage(run);
    const expectedActionSha256 = createHash("sha256")
      .update(JSON.stringify({ method: message.method, params: message.params }))
      .digest("hex");
    return run.permissionMode === "build"
      && run.buildApproval.policySha256 === this.policySha256()
      && run.buildApproval.actionSha256 === expectedActionSha256;
  }

  // Capability Lease 强制闸（EX-05）：workspace-write 必须持有未过期、哈希匹配的 active 租约。
  // 审批可见对象 ≠ 执行授权；adapter 边界以本方法为准 fail-closed。
  buildLeaseTtlMs() {
    const brokerTtl = Number(this.approvalBroker?.ttlMs) || 300_000;
    // 构建轮可能长于审批弹窗 TTL；租约至少 4h，仍绑定 action 哈希与工作区。
    return Math.max(brokerTtl, 4 * 60 * 60_000);
  }

  issueCapabilityLease(run, { actor = "operator" } = {}) {
    if (!run?.buildApproval?.actionSha256) return null;
    const now = Date.now();
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + this.buildLeaseTtlMs()).toISOString();
    const lease = {
      id: `lease-${run.id}`,
      approvalId: run.buildApproval.approvalId || null,
      status: "active",
      issuedAt,
      revokedAt: null,
      expiresAt,
      actionSha256: run.buildApproval.actionSha256,
      policySha256: run.buildApproval.policySha256 || this.policySha256(),
      runId: run.id,
      sessionId: null,
      method: "control/runBuild/requestApproval",
      actor,
      revocable: true,
      scope: "attempt+action-hash+ttl+worktree",
      workspace: this.buildApprovalMessage(run).params.workspace,
    };
    run.buildApproval.lease = lease;
    return lease;
  }

  activeCapabilityLease(run) {
    const lease = run?.buildApproval?.lease;
    if (!lease || lease.status !== "active") return null;
    if (!this.buildApprovalIsValid(run)) return null;
    if (lease.actionSha256 !== run.buildApproval.actionSha256) return null;
    const exp = Date.parse(lease.expiresAt);
    if (Number.isFinite(exp) && exp <= Date.now()) {
      lease.status = "expired";
      lease.revokedAt = new Date().toISOString();
      return null;
    }
    return lease;
  }

  revokeCapabilityLease(run, reason = "revoked") {
    const lease = run?.buildApproval?.lease;
    if (!lease || lease.status !== "active") return null;
    lease.status = "revoked";
    lease.revokedAt = new Date().toISOString();
    lease.revokeReason = reason;
    return lease;
  }

  capabilityLeaseView(run) {
    const lease = run?.buildApproval?.lease;
    if (!lease) return null;
    const expiresAt = Date.parse(lease.expiresAt);
    const approvalValid = this.buildApprovalIsValid(run);
    const expired = Number.isFinite(expiresAt) && expiresAt <= Date.now();
    const gateOpen = lease.status === "active" && !expired && approvalValid;
    return {
      ...lease,
      status: lease.status === "active" && expired ? "expired" : lease.status,
      gateOpen,
      invalidReason: gateOpen
        ? null
        : lease.status !== "active"
          ? `LEASE_${String(lease.status || "UNKNOWN").toUpperCase()}`
          : expired
            ? "LEASE_EXPIRED"
            : "APPROVAL_BINDING_INVALID",
    };
  }

  listCapabilityLeases() {
    return this.list()
      .map((run) => this.capabilityLeaseView(run))
      .filter(Boolean)
      .sort((left, right) => Date.parse(right.issuedAt || 0) - Date.parse(left.issuedAt || 0));
  }

  async revokeCapabilityLeaseForRun(id, { reason = "operator-revoke", actor = "operator" } = {}) {
    return this.withRunTransition(id, async () => {
      const run = this.get(id);
      const lease = run.buildApproval?.lease;
      if (!lease) throw Object.assign(new Error("capability lease not found for run"), { code: "LEASE_NOT_FOUND" });
      if (lease.status === "active") {
        this.revokeCapabilityLease(run, String(reason || "operator-revoke").slice(0, 160));
        lease.revokedBy = String(actor || "operator").slice(0, 80);
        await this.save(run);
        await this.emitEvent(run, "capability.lease_revoked", lease, {
          runId: run.id,
          sessionId: lease.sessionId || null,
          agentId: "control-plane",
          sensitivity: "sensitive",
        });
      }
      return this.capabilityLeaseView(run);
    });
  }

  #delegationContext(run, sourceAttemptId = null) {
    const graph = run?.taskGraph;
    const rootTaskId = graph?.rootTaskId || `task-${run?.id}`;
    const sourceAttempt = sourceAttemptId
      ? (run?.turnAttempts || []).find((item) => item?.attemptId === sourceAttemptId) || null
      : null;
    const inboundEdge = sourceAttemptId
      ? (graph?.delegations || []).find((item) =>
          item?.targetAttemptId === sourceAttemptId
          || (sourceAttempt?.sourceBusMessageId && item?.busMessageId === sourceAttempt.sourceBusMessageId)) || null
      : null;
    const inboundTask = inboundEdge?.busMessageId
      ? (graph?.tasks || []).find((item) => item?.busMessageId === inboundEdge.busMessageId) || null
      : null;
    return {
      parentTaskId: inboundTask?.id || rootTaskId,
      depth: Math.max(1, (Number(inboundEdge?.depth) || 0) + 1),
    };
  }

  // 权威 taskGraph 写边（AG-12B/13）：social 路由成功后持久化，不靠 Mission 从 chat 反推。
  recordTaskGraphDelegation(run, {
    fromAgentId,
    toAgentId,
    busMessageId = null,
    kind = "route",
    state = "queued",
    attemptId = null,
  } = {}) {
    if (!run) return null;
    const stamp = new Date().toISOString();
    run.taskGraph ||= {
      version: 1,
      rootTaskId: `task-${run.id}`,
      tasks: [],
      delegations: [],
      updatedAt: stamp,
    };
    const rootId = run.taskGraph.rootTaskId || `task-${run.id}`;
    run.taskGraph.rootTaskId = rootId;
    if (!Array.isArray(run.taskGraph.tasks)) run.taskGraph.tasks = [];
    if (!Array.isArray(run.taskGraph.delegations)) run.taskGraph.delegations = [];
    if (!run.taskGraph.tasks.some((item) => item.id === rootId || item.kind === "root")) {
      run.taskGraph.tasks.unshift({
        id: rootId,
        kind: "root",
        title: String(run.prompt || "task").slice(0, 180),
        status: "running",
        assigneeId: run.startAgentId || run.coordinatorId || null,
        parentTaskId: null,
        createdAt: run.createdAt || stamp,
        updatedAt: stamp,
      });
    } else {
      const root = run.taskGraph.tasks.find((item) => item.id === rootId || item.kind === "root");
      if (root && !["succeeded", "failed", "cancelled"].includes(root.status)) {
        root.status = "running";
        root.updatedAt = stamp;
      }
    }
    const edgeId = busMessageId ? `del-${busMessageId}` : `del-${randomUUID()}`;
    const existingEdge = run.taskGraph.delegations.find((item) =>
      item.id === edgeId || (busMessageId && item.busMessageId === busMessageId));
    if (existingEdge) return existingEdge;
    const { parentTaskId, depth } = this.#delegationContext(run, attemptId);
    const depthLimit = Math.max(1, Math.min(8, Number(run.delegationDepthLimit) || 4));
    const depthLimitReached = depth > depthLimit;
    const edge = {
      id: edgeId,
      fromAgentId,
      toAgentId,
      kind,
      state: depthLimitReached ? "rejected" : state,
      busMessageId,
      parentTaskId,
      sourceAttemptId: attemptId,
      targetAttemptId: null,
      depth,
      limit: depthLimit,
      depthLimitReached,
      timestamp: stamp,
    };
    run.taskGraph.delegations.push(edge);
    if (run.taskGraph.delegations.length > 200) {
      run.taskGraph.delegations = run.taskGraph.delegations.slice(-200);
    }
    if (toAgentId && toAgentId !== "team" && toAgentId !== "lo" && toAgentId !== "memo") {
      const childId = busMessageId ? `task-route-${busMessageId}` : `task-route-${randomUUID()}`;
      if (!run.taskGraph.tasks.some((item) => item.id === childId)) {
        run.taskGraph.tasks.push({
          id: childId,
          kind: "attempt",
          title: `${fromAgentId || "?"} → ${toAgentId}`,
          status: depthLimitReached ? "blocked" : state === "queued" ? "queued" : state,
          assigneeId: toAgentId,
          parentTaskId,
          sourceAttemptId: attemptId,
          attemptId: null,
          busMessageId,
          createdAt: stamp,
          updatedAt: stamp,
        });
        if (run.taskGraph.tasks.length > 128) {
          const root = run.taskGraph.tasks.find((item) => item.kind === "root") || run.taskGraph.tasks[0];
          run.taskGraph.tasks = [root, ...run.taskGraph.tasks.filter((item) => item !== root).slice(-127)];
        }
      }
    }
    run.taskGraph.updatedAt = stamp;
    return edge;
  }

  #syncTaskGraph(run, stamp) {
    const graph = run?.taskGraph;
    if (!graph || !Array.isArray(graph.tasks) || !Array.isArray(graph.delegations)) return;
    let changed = false;
    const update = (record, field, value) => {
      if (!record || Object.is(record[field], value)) return;
      record[field] = value;
      changed = true;
    };
    const setStatus = (record, field, value) => {
      if (!record || !value || Object.is(record[field], value)) return;
      record[field] = value;
      record.updatedAt = stamp;
      changed = true;
    };
    const root = graph.tasks.find((item) => item?.id === graph.rootTaskId || item?.kind === "root") || null;
    const rootStatus = run.status === "succeeded"
      ? "succeeded"
      : run.status === "failed"
        ? "failed"
        : run.status === "cancelled"
          ? "cancelled"
          : run.status === "recovery_required"
            ? "recovery_required"
            : ["queued", "planning"].includes(run.status)
              ? "queued"
              : ["waiting_approval", "waiting_for_approval"].includes(run.status)
                ? "waiting_approval"
                : "running";
    setStatus(root, "status", rootStatus);

    const attemptStatus = (phase) => {
      if (phase === "completed") return { task: "succeeded", edge: "completed" };
      if (phase === "failed") return { task: "failed", edge: "failed" };
      if (phase === "rejected") return { task: "failed", edge: "rejected" };
      if (phase === "ambiguous") return { task: "recovery_required", edge: "ambiguous" };
      if (["prepared", "session_ready", "submitting", "submitted"].includes(phase)) return { task: "running", edge: "running" };
      return null;
    };
    for (const attempt of run.turnAttempts || []) {
      if (!attempt?.sourceBusMessageId) continue;
      const edge = graph.delegations.find((item) => item?.busMessageId === attempt.sourceBusMessageId) || null;
      const task = graph.tasks.find((item) => item?.busMessageId === attempt.sourceBusMessageId) || null;
      if (!edge && !task) continue;
      update(edge, "targetAttemptId", attempt.attemptId || null);
      update(task, "attemptId", attempt.attemptId || null);
      const projected = attemptStatus(attempt.phase);
      if (projected) {
        setStatus(edge, "state", projected.edge);
        setStatus(task, "status", projected.task);
      }
    }

    const terminalProjection = run.status === "succeeded"
      ? { task: "skipped", edge: "skipped" }
      : run.status === "failed"
        ? { task: "failed", edge: "failed" }
        : run.status === "cancelled"
          ? { task: "cancelled", edge: "cancelled" }
          : run.status === "recovery_required"
            ? { task: "recovery_required", edge: "ambiguous" }
            : null;
    if (terminalProjection) {
      const finalTaskStates = new Set(["succeeded", "failed", "cancelled", "skipped", "blocked", "recovery_required"]);
      const finalEdgeStates = new Set(["completed", "failed", "cancelled", "skipped", "rejected", "ambiguous"]);
      for (const task of graph.tasks) {
        if (task === root || finalTaskStates.has(task?.status)) continue;
        setStatus(task, "status", terminalProjection.task);
      }
      for (const edge of graph.delegations) {
        if (finalEdgeStates.has(edge?.state)) continue;
        setStatus(edge, "state", terminalProjection.edge);
      }
    }
    if (changed) graph.updatedAt = stamp;
  }

  // 异构 resume 契约（AG-15 最小路径）：按 provider 返回可恢复命令，禁止跨 CLI 静默 resume。
  resumeHintsForRun(run) {
    const sessions = run?.sessions || {};
    const hints = [];
    for (const [agentId, session] of Object.entries(sessions)) {
      const sessionId = typeof session === "string" ? session : (session?.sessionId || session?.id || null);
      if (!sessionId) continue;
      const runtimeProfileId = this.runtimeProfileIdFor(run, agentId);
      const adapter = this.adapters.get(runtimeProfileId);
      const protocol = adapter?.id || "unknown";
      const command = resumeCommandForAdapter(adapter, sessionId);
      const canResume = Boolean(command);
      hints.push({
        agentId,
        runtimeProfileId,
        sessionId,
        protocol,
        canResume,
        command,
        note: canResume
          ? "native-session resume only; never cross-provider"
          : "no verified native resume for this adapter",
      });
    }
    return hints;
  }

  /**
   * 交互式 CLI 接续规格（一键跳终端用）：返回可直接 spawn 的 { command, args, cwd }。
   * 交互式 resume 用 ADAPTER_RESUME_FEATURES（TUI 命令，不是 headless `codex exec`）。
   * 用户拿到的是真 CLI 界面，与控制台共享同一个原生会话（同一 session 文件）。
   * 优先级：显式指定成员 → 执行所有者 → 任一已有原生会话的成员。
   */
  interactiveCliSpecForRun(run, preferredAgentId = null, { strict = false } = {}) {
    const preferred = String(preferredAgentId || "").trim();
    if (preferred) {
      const spec = this.#interactiveCliSpecForMember(run, preferred);
      if (spec) return spec;
      // 严格模式（罩层成员页签点击）：点名要谁就是谁，点名落空如实报不支持——
      // 不能静默回落到别的成员，否则用户以为在跟 A 说话其实开的是 B 的终端
      if (strict) return null;
    }
    return this.interactiveCliSpecsForRun(run)[0] ?? null;
  }

  /**
   * 全成员接续规格（沉浸罩层的成员切换页签用，LO 2026-08-17）：每个已有原生会话、
   * 且所属 adapter 支持交互式 resume 的成员一条；执行所有者排最前，其余按 sessions 台账序。
   * 没有任何可接续成员时返回空数组。
   */
  interactiveCliSpecsForRun(run) {
    const sessions = run?.sessions || {};
    const specs = [];
    for (const agentId of Object.keys(sessions)) {
      const spec = this.#interactiveCliSpecForMember(run, agentId);
      if (spec) specs.push(spec);
    }
    const owner = executionOwnerIdOf(run);
    if (owner) specs.sort((a, b) => (a.agentId === owner ? -1 : b.agentId === owner ? 1 : 0));
    return specs;
  }

  /** 单成员接续规格解析：无原生会话 / adapter 不支持交互 resume / 无可用命令 → null。 */
  #interactiveCliSpecForMember(run, agentId) {
    const sessions = run?.sessions || {};
    const session = sessions[agentId];
    const sessionId = typeof session === "string" ? session : (session?.sessionId || session?.id || null);
    if (!sessionId) return null;
    const runtimeProfileId = this.runtimeProfileIdFor(run, agentId);
    const adapter = this.adapters.get(runtimeProfileId);
    const feature = ADAPTER_RESUME_FEATURES[adapter?.id];
    if (!feature) return null;
    if (typeof adapter.canResume === "function" && adapter.canResume(sessionId) !== true) return null;
    const command = String(adapter.command || feature.defaultCommand || "").trim();
    if (!command) return null;
    return {
      agentId,
      runtimeProfileId,
      protocol: adapter.id,
      sessionId,
      command,
      args: feature.args(String(sessionId)),
      cwd: run.cwd || null,
    };
  }

  async save(run) {
    if (this.clearedRuns.has(run.id)) return run; // 墓碑：已清除 run 的迟到写盘直接丢弃，不复活文件
    // 竞态修复（烛 wave2 P1）：旧序"快照 → await 写盘 → 回写旧快照"会把写盘窗口内的并发变更
    // （pendingSteer.push/shift、turns.push）用旧快照覆盖抹掉——用户插话可能静默丢失或已执行项
    // 被写回重复执行。现序两根支柱：①快照+回写在同一 tick 内完成（事件循环内原子，无覆盖窗口）；
    // ②写盘挂 per-run 链串行（防旧快照后落盘造成磁盘回退）。
    run.updatedAt = new Date().toISOString();
    this.#syncTaskGraph(run, run.updatedAt);
    const safe = sanitizeForPersistence(run);
    Object.assign(run, safe);
    this.runs.set(run.id, run);
    const previous = this.saveChains.get(run.id) || Promise.resolve();
    const flush = previous.catch(() => {}).then(async () => {
      // 写盘前复查墓碑（纵深防御，烛 R6）：清理窗口内已通过入口检查、排在链上的迟到写盘也丢弃
      if (this.clearedRuns.has(run.id)) return;
      const target = join(this.runDir, `${run.id}.json`);
      const temp = join(this.runDir, `.${run.id}.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, `${JSON.stringify(safe, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await renameWithRetry(temp, target);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
      }
    });
    this.saveChains.set(run.id, flush);
    try {
      await flush; // 自身写盘失败仍如实抛给调用方；前序失败已被链上 catch 隔离
    } finally {
      if (this.saveChains.get(run.id) === flush) this.saveChains.delete(run.id);
    }
    return run;
  }

  async emitEvent(run, type, data = {}, context = {}) {
    try {
      return await this.eventStore.emit(type, data, {
        ...context,
        sourceRefs: normalizeRunSources(run?.sources),
      });
    } catch (error) {
      run.auditDegraded = true;
      run.auditErrors = [...(run.auditErrors || []), { type, message: error.message, at: new Date().toISOString() }].slice(-20);
      await this.save(run).catch(() => {});
      return null;
    }
  }

  list() {
    return [...this.runs.values()].sort((a, b) => {
      const at = a.createdAt == null ? -1 : Date.parse(a.createdAt);
      const bt = b.createdAt == null ? -1 : Date.parse(b.createdAt);
      if (at === -1 && bt === -1) return 0;
      if (at === -1) return 1;
      if (bt === -1) return -1;
      return bt - at;
    });
  }

  // 清除已结束任务（succeeded/failed/cancelled）——活跃与 recovery_required 一律不动
  async clearFinished() {
    const cleared = [];
    for (const run of [...this.runs.values()]) {
      // 活跃协程门闩（烛 R7）：终态置位与协程收尾之间（emitEvent/排干轮间的 await 窗口）不清理——
      // 否则协程持有的 run 被删、get 抛 RUN_NOT_FOUND 或"记录已清、agent 仍执行"。跳过本轮，下次再收。
      const coroutineActive = () =>
        this.controllers.has(run.id) || this.executions.has(run.id) || this.executions.has(`continue:${run.id}`);
      if (!TERMINAL.has(run.status) || coroutineActive()) continue;
      try {
        // 清理屏障（烛 wave2 回炉 P1a）：①循环收敛在途写链——等待期间挂上的新链继续等，
        // 只删自己等完的那条引用，不误删新链②复查 terminal（等待期间被续聊激活则放过）
        // ③先摘内存 Map 再删文件——摘除后 continue 必 RUN_NOT_FOUND，rm 的 await 窗口内
        // 不可能再产生新 save 链或激活，迟到 rename 复活与误删活跃 run 两个口同时堵死。
        let chain;
        while ((chain = this.saveChains.get(run.id))) {
          await chain.catch(() => {});
          if (this.saveChains.get(run.id) === chain) {
            this.saveChains.delete(run.id);
            break;
          }
        }
        if (!TERMINAL.has(run.status) || coroutineActive()) continue; // 链等待期间被激活/新协程接管则放过
        this.runs.delete(run.id);
        this.clearedRuns.add(run.id); // 墓碑先立（与 Map 摘除同 tick）：rm 的 await 窗口内迟到 save 直接被丢弃（烛 R6）
        try {
          await rm(join(this.runDir, `${run.id}.json`), { force: true });
        } catch (removeError) {
          this.clearedRuns.delete(run.id); // 删盘失败撤销墓碑并恢复内存可见性——磁盘还在就不能装作已清除
          this.runs.set(run.id, run);
          throw removeError;
        }
        // 辅助资产随 run 一并回收（烛致命10）：bus 消息流 / git worktree / roster 条目。
        // best-effort——run 记录已删是既成事实，资产清理失败不回滚（下次清理或人工兜底）
        await this.bus.remove(run.id).catch(() => {});
        await this.removeRunWorktree(run).catch(() => {});
        await this.removeRosterEntries(run.id).catch(() => {});
        cleared.push(run.id);
      } catch {
        // 删除失败的保留在列表，如实反映磁盘状态
      }
    }
    await this.eventStore
      .emit("run.finished_cleared", { count: cleared.length, runIds: cleared }, { sensitivity: "internal", agentId: "control-plane" })
      .catch(() => {});
    return { cleared: cleared.length, runIds: cleared };
  }

  get(id) {
    const run = this.runs.get(id);
    if (!run) throw Object.assign(new Error("run not found"), { code: "RUN_NOT_FOUND" });
    return run;
  }

  async create(input = {}) {
    const idempotencyKey = input.idempotencyKey == null ? "" : String(input.idempotencyKey).trim();
    if (!idempotencyKey || idempotencyKey.length > 200 || !/^[A-Za-z0-9:._-]+$/.test(idempotencyKey)) {
      return this.#createOnce(input);
    }
    const conversationScope = input.conversationId == null ? "global" : String(input.conversationId).trim();
    const claimKey = `${conversationScope}\0${idempotencyKey}`;
    const active = this.createClaims.get(claimKey);
    if (active) return active;
    const operation = this.#createOnce(input);
    this.createClaims.set(claimKey, operation);
    try {
      return await operation;
    } finally {
      if (this.createClaims.get(claimKey) === operation) this.createClaims.delete(claimKey);
    }
  }

  async conversationMessage(conversationId, request = {}) {
    const id = String(conversationId || "").trim();
    if (!id) throw Object.assign(new Error("conversationId is required"), { code: "VALIDATION_FAILED" });
    const previous = this.conversationMessageChains.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.#conversationMessageOnce(id, request));
    const tail = operation.catch(() => {});
    this.conversationMessageChains.set(id, tail);
    try {
      return await operation;
    } finally {
      if (this.conversationMessageChains.get(id) === tail) this.conversationMessageChains.delete(id);
    }
  }

  async #conversationMessageOnce(conversationId, request = {}) {
    if (!this.conversations) {
      throw Object.assign(new Error("persisted conversations require a conversation store"), { code: "CONVERSATION_STORE_UNAVAILABLE" });
    }
    const conversation = this.conversations.get(conversationId);
    if (conversation.deletedAt) {
      throw Object.assign(new Error("deleted conversations cannot accept messages"), { code: "CONVERSATION_DELETED" });
    }
    const recipientMemberIds = normalizeConversationRecipientIds(request.recipientMemberIds, conversation);
    const continuationRequest = { ...request };
    delete continuationRequest.recipientMemberIds;
    if (conversation.kind === "direct") {
      continuationRequest.agentId = String(conversation.directMemberId || "");
    } else if (recipientMemberIds?.length) {
      continuationRequest.agentId = recipientMemberIds[0];
    }

    const activeRunId = String(conversation.activeRunId || "").trim();
    let activeRun = null;
    if (activeRunId) {
      try {
        activeRun = this.get(activeRunId);
      } catch (error) {
        if (error?.code !== "RUN_NOT_FOUND") throw error;
        // clearFinished may have removed the terminal Run body while the Conversation
        // intentionally retains its bounded runIds audit chain.
      }
      if (activeRun && String(activeRun.conversationId || "") !== conversationId) {
        throw Object.assign(new Error("conversation active run ownership is inconsistent"), {
          code: "TRANSACTION_INCONSISTENT",
          httpStatus: 503,
          conversationId,
          runId: activeRunId,
        });
      }
      if (activeRun && !TERMINAL.has(activeRun.status)) {
        return { run: await this.continue(activeRun.id, continuationRequest), created: false };
      }
    }

    if (request.messageIntent === "answer" || request.answerToAskId) {
      throw Object.assign(new Error("a terminal conversation has no pending ask to answer"), { code: "ASK_NOT_PENDING" });
    }
    if (request.acknowledgeRecovery === true || request.nativeCommand === true) {
      throw Object.assign(new Error("recovery acknowledgement and native commands require an active run"), { code: "RUN_TERMINAL" });
    }

    const memberIds = [...new Set((conversation.memberIds || []).map(String).filter(Boolean))];
    if (!memberIds.length) {
      throw Object.assign(new Error("conversation has no executable members"), { code: "NOT_TEAM_MEMBER" });
    }
    const roster = await this.snapshotTeamRoster(memberIds);
    let coordinator = roster.find((member) => member.coordinatorEligible === true)?.id || null;
    const teamMembers = [...memberIds];
    if (!coordinator && conversation.kind === "direct" && this.teamMembers?.list) {
      const fallback = this.teamMembers.list().find((member) => (
        member?.teamMemberEligible === true && member?.coordinatorEligible === true
      ));
      if (fallback?.id) {
        coordinator = String(fallback.id);
        if (!teamMembers.includes(coordinator)) teamMembers.push(coordinator);
      }
    }
    if (!coordinator) {
      throw Object.assign(new Error("conversation has no coordinator-eligible member"), { code: "RUNTIME_PROFILE_INELIGIBLE" });
    }

    const previousRunId = [...(conversation.runIds || [])].reverse().find((runId) => this.runs.has(String(runId))) || null;
    const previousRun = previousRunId ? this.runs.get(String(previousRunId)) : null;
    const selectedMemberIds = recipientMemberIds?.length ? recipientMemberIds : memberIds;
    const startAgentId = conversation.kind === "direct"
      ? String(conversation.directMemberId)
      : selectedMemberIds.includes(String(previousRun?.startAgentId || ""))
        ? String(previousRun.startAgentId)
        : selectedMemberIds[0];
    const requestedAgentIds = conversation.kind === "workspace_group"
      ? selectedMemberIds.filter((memberId) => memberId !== startAgentId).slice(0, MAX_REQUESTED_AGENTS)
      : [];
    const prompt = String(request.prompt || "").trim();
    const createInput = {
      prompt,
      execute: true,
      conversationId,
      conversationKind: conversation.kind,
      orchestrationMode: conversation.kind === "workspace_group" ? "social" : "pipeline",
      startAgentId,
      requestedProvider: startAgentId,
      requestedAgentIds,
      ephemeralTeam: {
        name: String(conversation.title || "514 Bot Conversation").slice(0, 60),
        description: "由持久化 Conversation 重建的运行快照",
        systemPrompt: "",
        coordinator,
        members: teamMembers,
        skills: [],
        mcp: [],
        providers: {},
      },
      sources: request.sources,
      collaborationMode: previousRun?.collaborationMode === "deep" ? "deep" : "standard",
      model: previousRun?.modelOverride || undefined,
      effort: previousRun?.effortOverride || undefined,
      maxBudgetUsdPerTurn: request.maxBudgetUsdPerTurn,
      permissionMode: "plan",
    };
    return { run: await this.create(createInput), created: true };
  }

  async #createOnce(input = {}) {
    if (this.closing) throw Object.assign(new Error("control plane is shutting down"), { code: "CONTROL_PLANE_CLOSING" });
    const prompt = String(input.prompt || "").trim();
    if (!prompt) throw Object.assign(new Error("prompt is required"), { code: "INVALID_PROMPT" });
    if (Buffer.byteLength(prompt, "utf8") > 256 * 1024) throw Object.assign(new Error("prompt exceeds 256 KiB"), { code: "INVALID_PROMPT" });
    if (findSecretCandidates(prompt).length) {
      throw Object.assign(new Error("prompt contains secret-like material; pass credential references instead of values"), { code: "SENSITIVE_PROMPT" });
    }
    const idempotencyKey = input.idempotencyKey == null ? null : String(input.idempotencyKey).trim();
    if (idempotencyKey && (idempotencyKey.length > 200 || !/^[A-Za-z0-9:._-]+$/.test(idempotencyKey))) {
      throw Object.assign(new Error("idempotencyKey contains unsupported characters or exceeds 200 characters"), { code: "VALIDATION_FAILED" });
    }
    const runSources = normalizeRunSources(input.sources);
    const conversationIdProvided = input.conversationId != null;
    const conversationId = conversationIdProvided ? String(input.conversationId).trim() : null;
    if (conversationIdProvided && !conversationId) {
      throw Object.assign(new Error("conversationId cannot be empty"), { code: "VALIDATION_FAILED" });
    }
    const requestedConversationKind = input.conversationKind == null ? null : String(input.conversationKind).trim();
    if ((conversationId || requestedConversationKind === "workspace_group") && !this.conversations) {
      throw Object.assign(new Error("persisted conversations require a conversation store"), { code: "CONVERSATION_STORE_UNAVAILABLE" });
    }
    const conversation = conversationId && this.conversations ? this.conversations.get(conversationId) : null;
    if (conversationId && !conversation) {
      throw Object.assign(new Error("conversation not found"), { code: "CONVERSATION_NOT_FOUND" });
    }
    if (!conversation && input.projectId != null) {
      throw Object.assign(new Error("projectId must be derived from a persisted conversation"), { code: "VALIDATION_FAILED" });
    }
    const projectId = conversation?.projectId || null;
    if (input.projectId != null && String(input.projectId).trim() !== projectId) {
      throw Object.assign(new Error("projectId does not match the persisted conversation"), { code: "VALIDATION_FAILED" });
    }
    if (projectId && !this.projects) {
      throw Object.assign(new Error("project conversations require a project registry"), { code: "PROJECT_STORE_UNAVAILABLE" });
    }
    const project = projectId && this.projects ? this.projects.get(projectId) : null;
    if (conversation?.scope === "project" && !project) {
      throw Object.assign(new Error("project conversation has no verified project"), { code: "PROJECT_NOT_FOUND" });
    }
    const conversationKind = String(input.conversationKind || conversation?.kind || "legacy_pipeline").trim();
    if (!CONVERSATION_KINDS.has(conversationKind)) {
      throw Object.assign(new Error(`unsupported conversation kind: ${conversationKind}`), { code: "VALIDATION_FAILED" });
    }
    if (conversation && conversation.kind !== conversationKind) {
      throw Object.assign(new Error("conversation kind does not match the persisted conversation"), { code: "VALIDATION_FAILED" });
    }
    if (conversationKind === "workspace_group" && !conversation) {
      throw Object.assign(new Error("workspace group runs require a persisted conversation"), { code: "CONVERSATION_NOT_FOUND" });
    }
    if (project?.archivedAt) {
      throw Object.assign(new Error("archived projects must be restored before starting runs"), {
        code: "PROJECT_ARCHIVED",
        projectId: project.projectId,
      });
    }
    if (idempotencyKey) {
      const existing = [...this.runs.values()].find((item) => (
        item.idempotencyKey === idempotencyKey
        && (item.conversationId || null) === conversationId
      ));
      if (existing) return existing;
    }
    // 团队 = 会话级能力配比：成员进路由白名单，提示词/能力声明注入主脑规划轮
    let team = null;
    if (this.teams) {
      const hasEphemeralTeam = input.ephemeralTeam != null;
      if (hasEphemeralTeam && input.teamId != null && String(input.teamId).trim()) {
        throw Object.assign(new Error("teamId and ephemeralTeam cannot be used together"), { code: "VALIDATION_FAILED" });
      }
      team = hasEphemeralTeam
        ? this.teams.materializeEphemeral(input.ephemeralTeam)
        : this.teams.get(String(input.teamId || "team-514cc")); // 不存在 → SOURCE_NOT_FOUND
    } else if (input.ephemeralTeam != null) {
      throw Object.assign(new Error("ephemeral teams require a team store"), { code: "VALIDATION_FAILED" });
    }
    const teamMemberIds = team ? [...team.members] : null;
    const teamRoster = team ? await this.snapshotTeamRoster(teamMemberIds) : null;
    const requestedAgentIds = normalizeRequestedAgentIds(input.requestedAgentIds, teamMemberIds);
    // 会话入口与所有持久化身份都是逻辑成员；只有路由器和运行时边界消费 profile id。
    const coordinatorId = team?.coordinator || "claude-fable";
    if (teamMemberIds && !teamMemberIds.includes(coordinatorId)) {
      throw Object.assign(new Error("team coordinator must be a logical team member"), { code: "NOT_TEAM_MEMBER" });
    }
    const coordinatorMember = teamRoster ? rosterMember(teamRoster, coordinatorId) : null;
    if (coordinatorMember && coordinatorMember.coordinatorEligible !== true) {
      throw Object.assign(new Error(`team coordinator is not executable: ${coordinatorId}`), {
        code: "RUNTIME_PROFILE_INELIGIBLE",
        eligibilityReason: coordinatorMember.eligibilityReason || null,
      });
    }
    const orchestrationMode = resolveOrchestrationMode(input);
    if (conversationKind === "direct" && orchestrationMode === "social") {
      throw Object.assign(new Error("direct conversations cannot use social orchestration"), { code: "VALIDATION_FAILED" });
    }
    if (conversationKind === "workspace_group" && orchestrationMode !== "social") {
      throw Object.assign(new Error("workspace group conversations require social orchestration"), { code: "VALIDATION_FAILED" });
    }
    if (orchestrationMode !== "social" && requestedAgentIds.length) {
      throw Object.assign(new Error("requestedAgentIds is only supported by social orchestration"), { code: "VALIDATION_FAILED" });
    }
    const explicitStartAgentId = String(input.startAgentId ?? conversation?.directMemberId ?? "").trim();
    if (conversationKind === "direct" && !explicitStartAgentId) {
      throw Object.assign(new Error("direct conversations require an explicit member"), { code: "VALIDATION_FAILED" });
    }
    const startAgentId = resolveStartAgentId(explicitStartAgentId || null, teamMemberIds, requestedAgentIds[0] || coordinatorId);
    const initialTargets = initialSocialTargets(startAgentId, requestedAgentIds);
    const startRuntimeProfileId = teamRoster
      ? rosterMember(teamRoster, startAgentId)?.runtimeProfileId
      : startAgentId;
    if (!startRuntimeProfileId) {
      throw Object.assign(new Error(`team roster is missing the start member ${startAgentId}`), { code: "NOT_TEAM_MEMBER" });
    }
    const requestedProvider = input.requestedProvider == null ? null : String(input.requestedProvider).trim();
    const requestedProviderMember = teamRoster ? rosterMember(teamRoster, requestedProvider) : null;
    const requestedRuntimeProfileId = requestedProviderMember?.runtimeProfileId || requestedProvider || null;
    if (explicitStartAgentId && requestedRuntimeProfileId && requestedRuntimeProfileId !== startRuntimeProfileId) {
      throw Object.assign(new Error("requestedProvider must match the explicit startAgentId runtime profile"), {
        code: "VALIDATION_FAILED",
      });
    }
    // 直接收件人就是实际执行 owner；显式 start 未另传 provider 时，路由也必须验证同一 runtime。
    // 自动化只持久化 startAgentId，依赖这条服务端不变量，不能退回 UI 软接线。
    const routedProviderId = requestedRuntimeProfileId || (explicitStartAgentId ? startRuntimeProfileId : undefined);
    const visualAttachmentType = visualSourceType(runSources);
    const runtimeRoute = await this.router.preview({
      prompt,
      taskType: input.taskType,
      // multimodal 由真实附件决定（见 classifyTask）；与 1630 行的 run.sources 同一份归一化口径
      hasVisualAttachment: visualAttachmentType !== null,
      visualAttachmentType,
      requestedProvider: routedProviderId,
      risk: input.risk,
      needsCurrentSource: input.needsCurrentSource === true,
      allowedProviders: teamRoster
        ? [...new Set(teamRoster.map((member) => member.runtimeProfileId))]
        : null,
    });
    const selectedRuntimeProfileId = runtimeRouteId(runtimeRoute?.selected);
    if (routedProviderId && selectedRuntimeProfileId !== routedProviderId) {
      throw Object.assign(new Error("router did not honor the explicitly routed runtime provider"), {
        code: "TRANSACTION_INCONSISTENT",
        expectedRuntimeProfileId: routedProviderId,
        actualRuntimeProfileId: selectedRuntimeProfileId || null,
      });
    }
    const route = this.mapRuntimeRoute(runtimeRoute, teamRoster, [
      explicitStartAgentId ? startAgentId : requestedProviderMember?.id,
      requestedProviderMember?.id,
      startAgentId,
      ...requestedAgentIds,
      coordinatorId,
    ].filter(Boolean));
    const executionOwnerId = explicitStartAgentId ? startAgentId : route.selected.id;
    if (teamMemberIds && !teamMemberIds.includes(executionOwnerId)) {
      throw Object.assign(new Error("execution owner must belong to the selected team"), { code: "NOT_TEAM_MEMBER" });
    }
    const executionRuntimeProfileId = teamRoster
      ? rosterMember(teamRoster, executionOwnerId)?.runtimeProfileId
      : executionOwnerId;
    if (!executionRuntimeProfileId) {
      throw Object.assign(new Error(`team roster is missing the execution owner ${executionOwnerId}`), { code: "NOT_TEAM_MEMBER" });
    }
    // plan=只读规划；review=只读深审（允许 read-only shell 语义，仍禁止写盘）；build=审批后可写；
    // ask/auto/full-access/config=Codex 官方权限档（桌面批准菜单同款，组合见 CODEX_PRESET_NATIVE_MODES）
    const rawPermission = String(input.permissionMode ?? "").trim().toLowerCase();
    const requestedPermissionMode = rawPermission || "plan";
    if (!["plan", "review", "build", ...Object.keys(CODEX_PRESET_NATIVE_MODES)].includes(requestedPermissionMode)) {
      throw Object.assign(new Error(`unsupported permission mode: ${requestedPermissionMode}`), { code: "VALIDATION_FAILED" });
    }
    const permissionContract = this.policy.modes?.[requestedPermissionMode];
    if (!permissionContract) throw Object.assign(new Error(`permission mode ${requestedPermissionMode} is not configured`), { code: "POLICY_VIOLATION" });
    if (requestedPermissionMode === "build" && permissionContract.approvalRequired !== true) {
      throw Object.assign(new Error("build mode must remain approval-bound"), { code: "POLICY_VIOLATION" });
    }
    if (requestedPermissionMode === "review" && permissionContract.write && permissionContract.write !== false) {
      throw Object.assign(new Error("review mode must remain non-writing"), { code: "POLICY_VIOLATION" });
    }
    // 会话项目地址：CLI 子进程的工作目录。地址=项目身份（claude 原生按 cwd 归属 ~/.claude/projects）。
    // 校验绝对路径 + 真实存在的目录；不存在/不是目录如实拒绝，不静默回退 repoRoot。
    let sessionCwd = null;
    if (conversation?.scope === "global" && input.cwd) {
      throw Object.assign(new Error("global conversations cannot override cwd"), { code: "INVALID_CWD" });
    }
    const requestedConversationCwd = project?.canonicalCwd || (conversation ? null : input.cwd) || null;
    if (requestedConversationCwd) {
      const requested = String(requestedConversationCwd).trim();
      if (!isAbsolute(requested)) {
        throw Object.assign(new Error("session cwd must be an absolute path"), { code: "INVALID_CWD" });
      }
      let info;
      try {
        info = await stat(requested);
      } catch {
        throw Object.assign(new Error(`session cwd does not exist: ${requested}`), { code: "INVALID_CWD" });
      }
      if (!info.isDirectory()) {
        throw Object.assign(new Error(`session cwd is not a directory: ${requested}`), { code: "INVALID_CWD" });
      }
      sessionCwd = await realpath(requested);
    }
    if (project && input.cwd) {
      const requestedOverride = String(input.cwd).trim();
      if (!isAbsolute(requestedOverride)) {
        throw Object.assign(new Error("session cwd must be an absolute path"), { code: "INVALID_CWD" });
      }
      const overrideCwd = await realpath(requestedOverride).catch(() => null);
      const overrideKey = overrideCwd && (process.platform === "win32" ? overrideCwd.toLowerCase() : overrideCwd);
      const projectKey = sessionCwd && (process.platform === "win32" ? sessionCwd.toLowerCase() : sessionCwd);
      if (!overrideKey || overrideKey !== projectKey) {
        throw Object.assign(new Error("client cwd does not match the persisted project"), { code: "INVALID_CWD" });
      }
    }
    if (conversationKind === "direct" && conversation?.directMemberId !== undefined
      && conversation.directMemberId !== executionOwnerId) {
      throw Object.assign(new Error("direct conversation member must be the execution owner"), { code: "VALIDATION_FAILED" });
    }
    if (conversationKind === "workspace_group") {
      if (!sessionCwd) throw Object.assign(new Error("workspace group conversations require cwd"), { code: "INVALID_CWD" });
      if (project?.canonicalCwd) {
        const actualKey = process.platform === "win32" ? sessionCwd.toLowerCase() : sessionCwd;
        const expectedKey = process.platform === "win32" ? project.canonicalCwd.toLowerCase() : project.canonicalCwd;
        if (actualKey !== expectedKey) {
          throw Object.assign(new Error("run cwd does not match the workspace group"), { code: "INVALID_CWD" });
        }
      }
      const runMembers = [...new Set(teamMemberIds || [])].sort();
      const conversationMembers = [...new Set(conversation?.memberIds || [])].sort();
      if (JSON.stringify(runMembers) !== JSON.stringify(conversationMembers)) {
        throw Object.assign(new Error("run team does not match the workspace group members"), { code: "VALIDATION_FAILED" });
      }
    }
    // v41 波二：远程 run（{hostId, path}）——远端探针校验目录真实存在；与 cwd 互斥（两套 cwd 语义绝不混用）。
    // 门闸（ssh）+ 主机存在/启用 + 远端 test -d 全在 assertRunnable 一处；失败如实 422/404/409/501。
    let sessionRemote = null;
    if (input.remote != null) {
      if (sessionCwd) {
        throw Object.assign(new Error("remote and cwd are mutually exclusive run targets"), { code: "VALIDATION_FAILED" });
      }
      const requiredRemoteMethods = ["validateRemote", "assertRunnable", "assertDispatchable"];
      const missingRemoteMethods = requiredRemoteMethods.filter((method) => typeof this.remoteRunner?.[method] !== "function");
      if (missingRemoteMethods.length) {
        throw Object.assign(
          new Error(`remote runner cannot enforce the current run contract: missing ${missingRemoteMethods.join(", ")}`),
          { code: "REMOTE_UNAVAILABLE" },
        );
      }
      const normalized = this.remoteRunner.validateRemote(input.remote);
      await this.remoteRunner.assertRunnable(normalized.hostId, normalized.path);
      sessionRemote = normalized;
    }
    // v42 R2-03：pipeline 为默认；socialLoop 必须显式 opt-in（orchestrationMode:"social" 或 /social）。
    // startAgentId=「从谁开始」，缺省团队 leader——主脑不再是强制入口（白名单=团队成员）
    // /model 会话级模型覆盖：优先 CLI 原生动态目录（新模型即日出可用），
    // 发现失败回退静态 modelOptions；Adapter 明确不支持时在 spawn 前拒绝。
    const executionProfile = this.models?.profiles?.find((item) => item.id === executionRuntimeProfileId) || null;
    const executionAdapterTemplate = executionProfile
      ? ADAPTER_TEMPLATES.find((item) => item.id === executionProfile.adapter) || null
      : null;
    const nativePermissionMode = CODEX_PRESET_NATIVE_MODES[requestedPermissionMode]
      || { plan: "plan", review: "read-only", build: "workspace-write" }[requestedPermissionMode];
    // Codex 官方档要求 adapter 明确声明预设族（danger-full-access 是标记位）——ask 原生映射
    // 与 build 同为 workspace-write，不能仅凭原生 id 放行，否则 claude 等模板会被 ask 绕过 build 审批门。
    if (CODEX_PRESET_NATIVE_MODES[requestedPermissionMode]
      && !executionAdapterTemplate?.permissionModes?.includes("danger-full-access")) {
      throw Object.assign(new Error(`${executionOwnerId} adapter does not support Codex official preset ${requestedPermissionMode}`), { code: "UNSUPPORTED_PERMISSION" });
    }
    if (executionAdapterTemplate && !executionAdapterTemplate.permissionModes.includes(nativePermissionMode)) {
      throw Object.assign(new Error(`${executionOwnerId} adapter does not support ${requestedPermissionMode} mode`), { code: "UNSUPPORTED_PERMISSION" });
    }
    let modelOverride = null;
    if (input.model) {
      modelOverride = await this.validateModelOverride(
        { executionOwnerId, executionRuntimeProfileId, executionProfile, executionAdapterTemplate },
        input.model,
      );
    }
    // /effort 会话级推理力度覆盖：档位各家独立（codex 有 max/ultra、grok 有 --reasoning-effort）——
    // 动态目录优先，静态/manifest 档位兜底；Adapter 未接线时明确拒绝，禁止 silent fallback。
    let effortOverride = null;
    if (input.effort) {
      effortOverride = await this.validateEffortOverride(
        { executionOwnerId, executionRuntimeProfileId, executionProfile, executionAdapterTemplate },
        input.effort,
      );
    }
    // 权限覆盖（同款机制）：只接受当前模板 permissionModes 内的值；仅 native: 前缀的值会透传给
    // Adapter（如 grok 原生审批档），不影响 run.permissionMode 的三档治理路径。
    let permissionOverride = null;
    if (input.permission) {
      permissionOverride = this.validatePermissionOverride(
        { executionOwnerId, executionAdapterTemplate },
        input.permission,
      );
    }
    // v4.0 codeg 对标：委托深度限制（1-8，默认 4）——防止无限递归委派
    // codeg 的 DelegationBroker 含 depth_limit（1-8）、per-agent defaults、cancel 传播
    const delegationDepthLimit = Math.max(1, Math.min(8, Number(input.delegationDepthLimit) || 4));
    // maxRounds 是公开 API/审批哈希的兼容名；实际语义是每条用户消息可触发的自主 provider 步数。
    const explicitSteps = Number(input.maxStepsPerInteraction ?? input.maxRounds) || 0;
    const topologyMinimumRounds = conversationKind === "direct"
      ? 1
      : executionOwnerId === coordinatorId ? (route.independentRequired ? 3 : 1) : 3;
    // social 模式：显式 @N 个成员的协作闭环 = N+1 步，另留往复余量。不再被 pipeline 的
    // policy.maxRounds（默认 6）硬顶——否则 @4 成员时闭环正好占满 6 步、任何一次追问即截断。
    const socialMinimumRounds = orchestrationMode === "social"
      ? initialTargets.length + 1 + SOCIAL_INTERACTION_HEADROOM
      : 0;
    const minimumRounds = Math.max(topologyMinimumRounds, socialMinimumRounds);
    // social 步数硬顶 = policy.maxRounds + 可 @ 成员数 + 往复余量，机械防失控；MAX_REQUESTED_AGENTS
    // 已把 requestedAgentIds 限在 4，故 initialTargets ≤ 5、闭环 ≤ 8，远低于该顶。
    const socialCap = this.policy.limits.maxRounds + MAX_REQUESTED_AGENTS + SOCIAL_INTERACTION_HEADROOM;
    const effectiveCap = orchestrationMode === "social" ? socialCap : this.policy.limits.maxRounds;
    const effectiveDefault = orchestrationMode === "social"
      ? Math.max(socialMinimumRounds, this.policy.limits.maxRounds)
      : this.policy.limits.maxRounds;
    if (orchestrationMode !== "social" && this.policy.limits.maxRounds < minimumRounds) {
      throw Object.assign(new Error(`permission policy maxRounds cannot satisfy the selected ${minimumRounds}-round topology`), { code: "POLICY_VIOLATION" });
    }
    if (explicitSteps && explicitSteps < minimumRounds) {
      throw Object.assign(new Error(`selected topology requires at least ${minimumRounds} collaboration rounds`), {
        code: "INSUFFICIENT_ROUNDS",
        minimumRounds,
      });
    }
    const now = new Date().toISOString();
    const runId = randomUUID();
    const initialInteraction = { interactionId: randomUUID(), interactionSeq: 1 };
    const initialResumeQueue = input.execute === true && orchestrationMode === "social"
      ? mergeResumeQueues(initialTargets.map((to) => ({
          to,
          busMessageId: operationMessageId("task", initialTargets.length === 1 && to === startAgentId ? runId : `${runId}:${to}`),
          kind: "task",
          ...initialInteraction,
        })))
      : [];
    const maxStepsPerInteraction = Math.max(minimumRounds, Math.min(explicitSteps || effectiveDefault, effectiveCap));
    // "unlimited" 原样落 run（JSON 可持久化、UI 可回显）；结算与 social 契约用解析值——
    // 解析出 Infinity 时 social 契约会拒绝（social 协作必须有限预算），普通模式自然永不触发美元止损。
    const budgetUnlimited = isUnlimitedBudgetValue(input.maxBudgetUsdPerTurn);
    const maxBudgetUsdPerTurn = budgetUnlimited
      ? UNLIMITED_BUDGET
      : resolveBudgetUsdPerTurn(input.maxBudgetUsdPerTurn, this.policy);
    const socialContract = projectSocialContract({
      orchestrationMode,
      maxRounds: maxStepsPerInteraction,
      delegationDepthLimit,
      maxBudgetUsdPerTurn: budgetUnlimited ? Number.POSITIVE_INFINITY : maxBudgetUsdPerTurn,
    });
    const contextPlan = this.conversationContextPlan({
      conversation,
      conversationKind,
      projectId,
      sessionCwd,
      sessionRemote,
      teamRoster,
      executionOwnerId,
    });
    const run = {
      id: runId,
      status: "queued",
      prompt,
      taskType: route.taskType,
      createdAt: now,
      updatedAt: now,
      maxRounds: maxStepsPerInteraction,
      maxStepsPerInteraction,
      round: 0,
      interactionSeq: initialInteraction.interactionSeq,
      activeInteractionId: initialInteraction.interactionId,
      activeInteractionSeq: initialInteraction.interactionSeq,
      interactionStep: 0,
      interactionCostUsd: 0,
      interactionStepsRefunded: 0,
      interactionAutoRecoveries: 0,
      interactionContextCompactions: 0,
      interactionStartedAt: now,
      activeInteractionSources: runSources,
      pendingInteractionSources: [],
      interactionStates: {
        [initialInteraction.interactionId]: {
          interactionSeq: initialInteraction.interactionSeq,
          interactionStep: 0,
          interactionCostUsd: 0,
          interactionStepsRefunded: 0,
          interactionAutoRecoveries: 0,
          interactionContextCompactions: 0,
          interactionStartedAt: now,
          sources: runSources,
        },
      },
      roundsRefunded: 0, // 兼容审计累计值；round 不回退，真正退还的是当前 interactionStep
      refundedAttemptIds: [],
      route,
      sessions: {},
      contextEpoch: null,
      contextTopologyKey: contextPlan?.topologyKey || null,
      contextInheritedFromRunId: null,
      contextInheritedMembers: [],
      turns: [],
      turnAttempts: [],
      inflightTurns: {},
      resumeQueue: initialResumeQueue,
      resumeClaim: null,
      execute: input.execute === true,
      teamId: team?.id ?? null,
      teamName: team?.name ?? null,
      teamBrief: team && typeof this.teams.briefFor === "function" ? this.teams.briefFor(team) : null,
      teamEphemeral: team?.ephemeral === true,
      teamMembers: teamMemberIds, // 逻辑成员白名单快照，续聊按此服务端强制隔离（团队删除后仍固化）
      teamRoster, // 逻辑成员 → runtime profile 与人格/默认档快照；既有 run 不受后续成员编辑漂移
      teamRosterVersion: team ? 1 : null,
      teamSkills: team ? [...(team.skills ?? [])] : null, // 团队 skill 声明快照（成员轮按 agent 负名单过滤注入）
      teamMcp: team ? [...(team.mcp ?? [])] : null, // 团队 MCP 声明快照（隔离区过滤后注入，不假装服务器还在）
      coordinatorId,
      projectId,
      conversationId,
      conversationKind,
      orchestrationMode,
      socialContract,
      startAgentId,
      executionOwnerId,
      requestedAgentIds,
      modelOverride,
      effortOverride,
      permissionOverride,
      idempotencyKey,
      cwd: sessionCwd, // null=控制面默认（repoRoot）；有值=会话项目地址，CLI 原生会话落该项目
      remote: sessionRemote, // v41：{hostId, path}=远端运行位置；null=本机。与 cwd 互斥（create 校验）
      sources: runSources, // 结构化来源台账；prompt 仍保留 CLI 可读路径说明
      collaborationMode: input.collaborationMode === "deep" ? "deep" : "standard",
      permissionMode: requestedPermissionMode,
      delegationDepthLimit, // v4.0：委托深度限制（codeg DelegationBroker 对标）
      maxBudgetUsdPerTurn,
      buildApproval: requestedPermissionMode === "build" && input.execute === true
        ? { status: "pending", policySha256: this.policySha256(), actionSha256: null, approvedAt: null }
        : null,
      // 轻量 Task 图（AG-13 读/写起点）：根任务 + 后续委派边由 social 路由/投影增补
      taskGraph: {
        version: 1,
        rootTaskId: `task-${runId}`,
        tasks: [{
          id: `task-${runId}`,
          kind: "root",
          title: String(prompt).slice(0, 180),
          status: "queued",
          assigneeId: startAgentId,
          parentTaskId: null,
          createdAt: now,
          updatedAt: now,
        }],
        delegations: [],
        updatedAt: now,
      },
      result: null,
      error: null,
    };
    for (const item of initialResumeQueue) {
      if (item.to === startAgentId) continue;
      this.recordTaskGraphDelegation(run, {
        fromAgentId: "lo",
        toAgentId: item.to,
        busMessageId: item.busMessageId,
        kind: "mention",
        state: "queued",
      });
    }
    await withManagedClipboardSourceRegistration({
      dataRoot: this.dataRoot,
      sources: run.sources,
      operation: async () => {
        let conversationLinked = false;
        let contextClaimed = false;
        let contextClaimOwnerRegistered = false;
        try {
          if (conversationId && this.conversations) {
            await this.conversations.attachRun(conversationId, run.id);
            conversationLinked = true;
          }
          if (run.execute && contextPlan && this.conversationContexts) {
            this.contextClaimRunIds.add(run.id);
            contextClaimOwnerRegistered = true;
            const claim = await this.conversationContexts.claim({
              conversationId,
              topologyKey: contextPlan.topologyKey,
              runId: run.id,
              candidates: contextPlan.candidates,
              ownerIsActive: (ownerRunId) => {
                const owner = this.runs.get(ownerRunId);
                return this.contextClaimRunIds.has(ownerRunId)
                  || Boolean(owner && !TERMINAL.has(owner.status));
              },
            });
            contextClaimed = true;
            for (const [memberId, binding] of Object.entries(claim.inherited)) {
              if (!this.isConversationContextBindingUnsafe(conversationId, memberId, binding)) continue;
              await this.conversationContexts.invalidate({
                conversationId,
                memberId,
                sessionId: binding.sessionId,
                reason: "run-ledger-invalidated",
              });
              delete claim.inherited[memberId];
            }
            run.contextEpoch = claim.epoch;
            run.sessions = Object.fromEntries(Object.entries(claim.inherited).map(([memberId, binding]) => [memberId, binding.sessionId]));
            run.contextInheritedMembers = Object.keys(claim.inherited).sort();
            const sourceRunIds = [...new Set(Object.values(claim.inherited).map((binding) => binding.sourceRunId).filter(Boolean))];
            run.contextInheritedFromRunId = sourceRunIds.length === 1 ? sourceRunIds[0] : null;
          }
          await this.save(run);
        } catch (error) {
          let contextCompensationError = null;
          if (contextClaimed) {
            try {
              await this.conversationContexts.releaseClaim(conversationId, run.id);
            } catch (releaseError) {
              contextCompensationError = releaseError;
            }
          }
          if (conversationLinked) {
            try {
              await this.conversations.detachRun(conversationId, run.id);
            } catch (compensationError) {
              if (typeof this.conversations.markTransactionInconsistent === "function") {
                throw this.conversations.markTransactionInconsistent("run-create rollback", error, compensationError);
              }
              throw Object.assign(new Error("run and conversation stores are inconsistent; operator recovery is required"), {
                code: "TRANSACTION_INCONSISTENT",
                httpStatus: 503,
                recoveryRequired: true,
              });
            }
          }
          if (contextCompensationError) throw contextCompensationError;
          throw error;
        } finally {
          if (contextClaimOwnerRegistered) this.contextClaimRunIds.delete(run.id);
        }
      },
    });
    await this.emitEvent(run, "run.created", {
      taskType: run.taskType,
      execute: run.execute,
      route: route.selected,
      collaborationMode: run.collaborationMode,
      conversationId: run.conversationId,
      conversationKind: run.conversationKind,
    }, { runId: run.id });
    if (!run.execute) {
      run.status = "succeeded";
      run.result = { type: "route-preview", route };
      await this.save(run);
      await this.emitEvent(run, "run.completed", { status: run.status, dryRun: true }, { runId: run.id });
    } else if (run.permissionMode === "build") {
      run.status = "waiting_approval";
      await this.save(run);
      await this.emitEvent(run, "run.waiting_approval", { permissionMode: run.permissionMode }, { runId: run.id });
      queueMicrotask(() => void this.awaitBuildApproval(run.id));
    } else {
      queueMicrotask(() => void this.startExecution(run.id));
    }
    return this.get(run.id);
  }

  async awaitBuildApproval(id) {
    const run = this.get(id);
    const policySha256 = this.policySha256();
    // 先固化批准时的单交互自主步骤上限，再算哈希；后续消息开启新 interaction，
    // 但不会扩大这次动作绑定审批允许的自主执行边界。
    run.buildApproval.approvedMaxRounds = run.maxRounds;
    const message = this.buildApprovalMessage(run);
    run.buildApproval.actionSha256 = createHash("sha256").update(JSON.stringify({ method: message.method, params: message.params })).digest("hex");
    await this.save(run);
    try {
      const response = await this.approvalBroker.request(message, { runId: run.id, sessionId: null });
      let accepted = false;
      let denied = false;
      await this.withRunTransition(id, async () => {
        const waiting = run.status === "waiting_approval" || run.status === "waiting_for_approval";
        if (!waiting || run.buildApproval?.status !== "pending") return;
        if (response.decision !== "accept") {
          run.status = "cancelled";
          run.error = "Build permission was denied or expired.";
          run.buildApproval.status = "denied";
          await this.save(run);
          denied = true;
          return;
        }
        run.buildApproval.status = "approved";
        run.buildApproval.approvalId = response.approvalId || null;
        run.buildApproval.approvedAt = new Date().toISOString();
        this.issueCapabilityLease(run, { actor: "operator" });
        await this.save(run);
        accepted = true;
      });
      if (denied) {
        await this.emitEvent(run, "run.cancelled", { reason: "build approval denied" }, { runId: run.id });
        return;
      }
      if (!accepted) return;
      const lease = run.buildApproval?.lease || null;
      await this.emitEvent(run, "run.approved", {
        permissionMode: run.permissionMode,
        policySha256,
        leaseId: lease?.id || null,
        leaseExpiresAt: lease?.expiresAt || null,
      }, { runId: run.id });
      if (lease) {
        await this.emitEvent(run, "capability.lease_issued", lease, { runId: run.id, agentId: "control-plane", sensitivity: "sensitive" });
      }
      await this.startExecution(run.id);
    } catch (error) {
      if (run.status === "cancelled" || run.status === "interrupted" || run.buildApproval?.status === "withdrawn") return;
      run.status = "failed";
      markPromptTransportFailure(run, error);
      run.error = error.message;
      await this.save(run);
      await this.emitEvent(run, "run.failed", { code: error.code || null, message: error.message, failureClass: run.failureClass || null }, { runId: run.id });
    }
  }

  async checkpointTurn(run, agentId, attemptId, phase, patch = {}) {
    const attempt = (run.turnAttempts || []).find((item) => item.attemptId === attemptId);
    if (!attempt) throw Object.assign(new Error("turn attempt checkpoint is missing"), { code: "CHECKPOINT_MISSING" });
    const durableIdentifiers = ["sessionId", "tentativeSessionId", "protocol", "clientUserMessageId", "nativeTurnId"];
    for (const field of durableIdentifiers) {
      if (patch[field] == null && attempt[field] != null) patch[field] = attempt[field];
    }
    if (patch.sessionResumable == null && attempt.sessionResumable != null) {
      patch.sessionResumable = attempt.sessionResumable;
    }
    Object.assign(attempt, patch, { phase, updatedAt: new Date().toISOString() });
    // tentativeSessionId 只能证明控制面为原生 CLI 预留了标识。Adapter 必须用
    // sessionResumable=true 明确提升后，Grok 新会话才可进入 run.sessions。
    // 未声明该字段的既有 Adapter 保持向后兼容。
    if (attempt.sessionId && attempt.sessionResumable !== false) run.sessions[agentId] = attempt.sessionId;
    run.inflightTurns ||= {};
    // rejected/ambiguous 同属终结相位：该 attempt 不会再推进，留在 inflight 只会让 UI 永远显示"正在准备会话"。
    // "可能已占用原生轮"的语义由 run.status=recovery_required + recoveryNote + resumeClaim 承载，
    // 不需要 inflight 记账兼任，后者反而挡住了操作者确认恢复后的继续发送。
    if (["completed", "failed", "rejected", "ambiguous", "interrupted"].includes(phase)) delete run.inflightTurns[agentId];
    else run.inflightTurns[agentId] = attemptId;
    await this.save(run);
    await this.emitEvent(
      run,
      "agent.turn_checkpoint",
      {
        attemptId,
        round: attempt.round,
        interactionId: attempt.interactionId || run.activeInteractionId || null,
        interactionSeq: attempt.interactionSeq || run.activeInteractionSeq || null,
        interactionStep: attempt.interactionStep || run.interactionStep || null,
        maxStepsPerInteraction: this.maxStepsForInteraction(run),
        agentId,
        phase,
        protocol: attempt.protocol || null,
        clientUserMessageId: attempt.clientUserMessageId || null,
        nativeTurnId: attempt.nativeTurnId || null,
        providerBinding: attempt.providerBinding || null,
      },
      { runId: run.id, sessionId: attempt.sessionId || null, agentId },
    );
  }

  async turn(run, agentId, prompt, {
    allowWorkspaceWrite = false,
    cwd = null,
    sourceWorkItemId = null,
    sourceBusMessageId = null,
    allowAutoRecovery = true,
    allowContextRecovery = true,
    nativeCommand = false,
  } = {}) {
    const contextRetryPrompt = prompt;
    const member = this.memberForRun(run, agentId);
    const runtimeProfileId = member.runtimeProfileId;
    if (nativeCommand && !/^\/[A-Za-z0-9_-]+([ \t]+\S+){0,8}$/.test(String(prompt))) {
      throw Object.assign(new Error("nativeCommand prompt must be a single-line slash command"), { code: "VALIDATION_FAILED" });
    }
    // Source paths stay in the private run ledger and are injected only at the adapter boundary.
    // Public run/event prompts keep the operator's original text and receive a filename-only projection.
    // 原生命令轮（/compact 等）例外：CLI 需要裸命令作为完整输入，附件/团队声明/成员人格
    // 任何包装都会让 CLI 把它当成普通文本——Desktop 的做法同样是把斜杠命令原样作为用户输入传递。
    prompt = nativeCommand ? String(prompt) : promptWithRunSources(prompt, run.activeInteractionSources ?? run.sources);
    const promptSha256 = createHash("sha256").update(prompt).digest("hex");
    const preparedAttempt = sourceWorkItemId
      ? [...(run.turnAttempts || [])].reverse().find((attempt) =>
          attempt.agentId === agentId
          && attempt.sourceWorkItemId === sourceWorkItemId
          && attempt.phase === "prepared") || null
      : null;
    if (preparedAttempt && preparedAttempt.promptSha256 !== promptSha256) {
      throw Object.assign(new Error("prepared turn prompt changed before safe recovery"), { code: "RECOVERY_REQUIRED" });
    }
    this.ensureInteractionState(run);
    if (!preparedAttempt && this.interactionLimitReached(run)) {
      throw Object.assign(new Error("maximum autonomous steps reached for this interaction"), { code: "INTERACTION_STEP_LIMIT" });
    }
    const controller = this.controllers.get(run.id);
    if (!controller || controller.signal.aborted) throw Object.assign(new Error("run cancelled"), { code: "ABORTED" });
    // 所有 provider turn 的共同准入：social / pipeline / steer / terminal continue 都只能从这里
    // 进入 adapter。即使团队没有声明任何 Skill，也要读取一次配置，防止损坏文件被绕成“全启用”。
    if (typeof this.capabilities?.agentDisabledSkills !== "function") {
      throw Object.assign(new Error("agent capability provider is unavailable; provider dispatch is blocked"), {
        code: "CAPABILITY_CONFIG_UNAVAILABLE",
      });
    }
    let enabledSkillDeclarations = [];
    if (!nativeCommand) {
      const disabled = await this.capabilities.agentDisabledSkills(agentId);
      enabledSkillDeclarations = (run.teamSkills ?? []).filter((skill) => !disabled.has(skill));
      // teamBrief 是团队级快照，含未按成员过滤的 Skill 总表；provider prompt 中移除该行，
      // 再由下方成员级声明取代，避免被禁用项仍从另一段提示词漏入。
      if (run.teamBrief && prompt.includes(run.teamBrief)) {
        const filteredBrief = run.teamBrief
          .split(/\r?\n/)
          .filter((line) => !line.startsWith("团队 Skill（声明，供派工参考）：") && !line.startsWith("团队 MCP（声明，供派工参考）："))
          .join("\n");
        prompt = prompt.replace(run.teamBrief, filteredBrief);
      }
      let enabledMcpDeclarations = [];
      if (Array.isArray(run.teamMcp) && run.teamMcp.length) {
        if (typeof this.capabilities.disabledMcpNames === "function") {
          const mcpState = await this.capabilities.disabledMcpNames();
          const disabledNames = mcpState?.names instanceof Set ? mcpState.names : new Set();
          enabledMcpDeclarations = mcpState?.failClosed ? [] : run.teamMcp.filter((name) => !disabledNames.has(name));
        }
      }
      const kitBlocks = [];
      if (run.teamSkills?.length) {
        const declared = enabledSkillDeclarations.length ? enabledSkillDeclarations.join("、") : "无";
        kitBlocks.push(`[团队 Skill 提示声明]\n- 本成员本轮声明：${declared}\n- 这只是注入模型的提示词声明，不授予工具、文件、网络或沙箱权限；真实调用仍受 adapter 与运行时策略约束。`);
      }
      if (run.teamMcp?.length) {
        const declared = enabledMcpDeclarations.length ? enabledMcpDeclarations.join("、") : "无";
        kitBlocks.push(`[团队 MCP 提示声明]\n- 本轮可用声明：${declared}\n- 隔离或读不到的服务器不会出现在这里；真实调用仍受运行时约束。`);
      }
      if (kitBlocks.length) prompt = `${kitBlocks.join("\n\n")}\n\n${prompt}`;
    }
    const memberPrompt = nativeCommand ? null : this.memberPromptForRun(run, agentId);
    if (memberPrompt) prompt = `${memberPrompt}\n\n${prompt}`;
    this.assertLifecycleOwner(run, controller);
    const coordinatorId = run.coordinatorId || "claude-fable";
    const executionOwnerId = executionOwnerIdOf(run);
    const requestsWorkspaceWrite = allowWorkspaceWrite
      && run.permissionMode === "build"
      && agentId === executionOwnerId;
    if (requestsWorkspaceWrite && !this.buildApprovalIsValid(run)) {
      throw Object.assign(new Error("workspace-write requires a current action-bound build approval"), { code: "POLICY_VIOLATION" });
    }
    // Lease 强制：声明式审批通过后仍须 active 租约（哈希+TTL+工作区绑定）
    if (requestsWorkspaceWrite && !this.activeCapabilityLease(run)) {
      throw Object.assign(
        new Error("workspace-write requires an active capability lease (issued, unexpired, action-hash matched)"),
        { code: "POLICY_VIOLATION", detail: "CAPABILITY_LEASE_REQUIRED" },
      );
    }
    const effectivePermissionMode = run.permissionMode === "plan"
      ? "plan"
      : run.permissionMode === "review"
        ? "read-only"
        : run.permissionMode === "build"
          ? requestsWorkspaceWrite
            ? "workspace-write"
            : agentId === coordinatorId ? "plan" : "read-only"
          : CODEX_PRESET_NATIVE_MODES[run.permissionMode]
            // Codex 官方档：执行拥有者拿原生组合；其余成员保持只读/plan，写面不扩散
            ? agentId === executionOwnerId
              ? CODEX_PRESET_NATIVE_MODES[run.permissionMode]
              : agentId === coordinatorId ? "plan" : "read-only"
            : null;
    if (!effectivePermissionMode) {
      throw Object.assign(new Error(`persisted run has unsupported permission mode: ${run.permissionMode}`), { code: "POLICY_VIOLATION" });
    }
    // 远程 run：专用 adapter（SSH 桥 spawn），与本机席位池隔离；fallback 同样远程（绝不回本机执行）
    const remotePair = run.remote ? await this.remoteAdapterFor(run, runtimeProfileId) : null;
    const adapter = remotePair ? remotePair.adapter : this.adapters.get(runtimeProfileId);
    if (!adapter) throw Object.assign(new Error(`no executable adapter for ${agentId}`), { code: "ADAPTER_UNAVAILABLE" });
    let effectiveAdapter = adapter;
    let providerBinding = this.providerBindingFor(adapter, runtimeProfileId, { remote: Boolean(run.remote) });
    const adapterTemplate = adapter.id ? ADAPTER_TEMPLATES.find((item) => item.id === adapter.id) : null;
    if (adapterTemplate && !adapterTemplate.permissionModes.includes(effectivePermissionMode)) {
      throw Object.assign(new Error(`${agentId} adapter cannot honor ${effectivePermissionMode}`), { code: "UNSUPPORTED_PERMISSION" });
    }
    // worktree 隔离 fail-closed（烛 v3.6 致命7：codex app-server 常驻进程 cwd 固定在控制面仓库，
    // "隔离"若只是传了个被忽略的参数=写盘发生在错误目录还自称隔离）：写盘轮存在 worktree 时，
    // adapter 必须声明支持 per-turn cwd，否则拒绝派工——绝不静默降级到 adapter 默认目录
    if (requestsWorkspaceWrite && run.worktreePath) {
      const workspace = await attestRunWorkspace(run);
      cwd = cwd ?? workspace.path;
      if (adapter.supportsPerTurnCwd !== true) {
        throw Object.assign(
          new Error(`${agentId} (${runtimeProfileId}) adapter cannot honor per-turn cwd for worktree isolation; dispatch write turns to a spawn-type adapter (claude/grok-build)`),
          { code: "UNSUPPORTED_PERMISSION" },
        );
      }
    }
    const attemptId = preparedAttempt?.attemptId || randomUUID();
    await this.withLifecycleEffect(run, controller, async () => {
      if (!preparedAttempt && this.interactionLimitReached(run)) {
        throw Object.assign(new Error("maximum autonomous steps reached for this interaction"), { code: "INTERACTION_STEP_LIMIT" });
      }
      run.status = "waiting_agent";
      run.turnAttempts ||= [];
      run.inflightTurns ||= {};
      if (preparedAttempt) {
        preparedAttempt.updatedAt = new Date().toISOString();
        preparedAttempt.providerBinding = providerBinding;
      } else {
        run.round += 1;
        run.interactionStep += 1;
        run.turnAttempts.push({
          attemptId,
          round: run.round,
          interactionId: run.activeInteractionId,
          interactionSeq: run.activeInteractionSeq,
          interactionStep: run.interactionStep,
          agentId,
          phase: "prepared",
          promptSha256,
          sessionId: run.sessions[agentId] || null,
          tentativeSessionId: null,
          // null 表示既有 Adapter 未声明新契约，仍按 sessionId 直接提升；只有 Grok
          // 预分配新会话时会在 submitting checkpoint 显式写 false。
          sessionResumable: run.sessions[agentId] ? true : null,
          protocol: null,
          clientUserMessageId: null,
          nativeTurnId: null,
          providerBinding,
          sourceWorkItemId,
          sourceBusMessageId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      run.inflightTurns[agentId] = attemptId;
      await this.save(run);
      await this.emitEvent(run, "agent.turn_started", {
        round: preparedAttempt?.round || run.round,
        interactionId: preparedAttempt?.interactionId || run.activeInteractionId,
        interactionSeq: preparedAttempt?.interactionSeq || run.activeInteractionSeq,
        interactionStep: preparedAttempt?.interactionStep || run.interactionStep,
        maxStepsPerInteraction: this.maxStepsForInteraction(run),
        agentId,
        resumedPrepared: Boolean(preparedAttempt),
        providerBinding,
      }, { runId: run.id, sessionId: run.sessions[agentId] || null, agentId });
    });

    let response;
    const checkpoint = (phase, data = {}) => this.withLifecycleEffect(run, controller, () =>
      this.checkpointTurn(run, agentId, attemptId, phase, {
        sessionId: Object.hasOwn(data, "sessionId") ? data.sessionId : (run.sessions[agentId] || null),
        tentativeSessionId: data.tentativeSessionId ?? null,
        sessionResumable: data.sessionResumable,
        protocol: data.protocol || null,
        clientUserMessageId: data.clientUserMessageId || null,
        nativeTurnId: data.turnId || null,
        providerBinding: data.providerBinding ?? providerBinding,
        ...(Object.hasOwn(data, "failureCostUsd") ? { failureCostUsd: data.failureCostUsd } : {}),
        ...(Object.hasOwn(data, "failureTokens") ? { failureTokens: data.failureTokens } : {}),
        ...(Object.hasOwn(data, "failureUsageAccounted") ? { failureUsageAccounted: data.failureUsageAccounted } : {}),
        ...(Object.hasOwn(data, "failureUsages") ? { failureUsages: data.failureUsages } : {}),
      }));
    const accountFailureUsage = (error, failedAdapter, binding = providerBinding) => {
      const attempt = (run.turnAttempts || []).find((item) => item.attemptId === attemptId) || null;
      const costUsd = Number.isFinite(error?.costUsd) ? Math.max(0, Number(error.costUsd)) : null;
      const tokens = Number.isFinite(error?.tokens) ? Math.max(0, Number(error.tokens)) : null;
      if (!attempt || (costUsd === null && tokens === null)) {
        return { attempt, costUsd, tokens, changed: false, usageKey: null };
      }
      const adapterId = failedAdapter?.id || runtimeProfileId;
      const usageKey = createHash("sha256").update(JSON.stringify({
        adapterId,
        code: error?.code || null,
        failureKind: error?.failureKind || null,
        resultSubtype: error?.resultSubtype || null,
        costUsd,
        tokens,
        providerBinding: binding ?? null,
        sessionId: error?.sessionId ?? attempt.sessionId ?? null,
        clientUserMessageId: error?.clientUserMessageId ?? attempt.clientUserMessageId ?? null,
        nativeTurnId: error?.turnId ?? attempt.nativeTurnId ?? null,
      })).digest("hex");
      if (!Array.isArray(attempt.failureUsages)) {
        const legacyCostUsd = Number.isFinite(attempt.failureCostUsd) ? Math.max(0, Number(attempt.failureCostUsd)) : null;
        const legacyTokens = Number.isFinite(attempt.failureTokens) ? Math.max(0, Number(attempt.failureTokens)) : null;
        const hasLegacyUsage = attempt.failureUsageAccounted === true
          && (legacyCostUsd !== null || legacyTokens !== null);
        const sameAsCurrent = hasLegacyUsage && legacyCostUsd === costUsd && legacyTokens === tokens;
        attempt.failureUsages = hasLegacyUsage ? [{
          usageKey: sameAsCurrent ? usageKey : `legacy-${attemptId}`,
          adapterId: null,
          code: null,
          costUsd: legacyCostUsd,
          tokens: legacyTokens,
          providerBinding: attempt.providerBinding ?? null,
          accountedAt: attempt.updatedAt || attempt.createdAt || null,
          legacy: true,
        }] : [];
      }
      if (attempt.failureUsages.some((entry) => entry?.usageKey === usageKey)) {
        return { attempt, costUsd, tokens, changed: false, usageKey };
      }
      attempt.failureUsages.push({
        usageKey,
        adapterId,
        code: error?.code || null,
        failureKind: error?.failureKind || null,
        resultSubtype: error?.resultSubtype || null,
        costUsd,
        tokens,
        providerBinding: binding ?? null,
        accountedAt: new Date().toISOString(),
      });
      if (costUsd !== null) {
        run.costUsdTotal = (run.costUsdTotal || 0) + costUsd;
        run.interactionCostUsd = (run.interactionCostUsd || 0) + costUsd;
      }
      const costEntries = attempt.failureUsages.filter((entry) => Number.isFinite(entry?.costUsd));
      const tokenEntries = attempt.failureUsages.filter((entry) => Number.isFinite(entry?.tokens));
      attempt.failureCostUsd = costEntries.length
        ? costEntries.reduce((total, entry) => total + Math.max(0, Number(entry.costUsd)), 0)
        : null;
      attempt.failureTokens = tokenEntries.length
        ? tokenEntries.reduce((total, entry) => total + Math.max(0, Number(entry.tokens)), 0)
        : null;
      attempt.failureUsageAccounted = true;
      return { attempt, costUsd, tokens, changed: true, usageKey };
    };
    const recordTurnFailure = async (error, { failedAdapter = adapter, phase = "failed" } = {}) => {
      providerBinding = error?.providerBinding ?? providerBinding;
      const attempt = (run.turnAttempts || []).find((item) => item.attemptId === attemptId);
      const usage = accountFailureUsage(error, failedAdapter, providerBinding);
      const failureCostUsd = usage.costUsd;
      const failureTokens = usage.tokens;
      const terminalPhases = new Set(["failed", "rejected", "ambiguous", "interrupted"]);
      const currentPhase = attempt?.phase || null;
      const bindingChanged = JSON.stringify(attempt?.providerBinding ?? null) !== JSON.stringify(providerBinding ?? null);
      const identifiersChanged = [
        ["sessionId", error?.sessionId],
        ["tentativeSessionId", error?.tentativeSessionId],
        ["protocol", error?.protocol],
        ["clientUserMessageId", error?.clientUserMessageId],
        ["nativeTurnId", error?.turnId],
      ].some(([field, value]) => value != null && attempt?.[field] !== value);
      const usageChanged = usage.changed;
      const nativeSettlementUnknown = ["submitting", "submitted"].includes(currentPhase)
        && error?.nativeTurnSettled !== true
        && error?.submissionRejected !== true;
      const settledPhase = terminalPhases.has(currentPhase) || nativeSettlementUnknown ? currentPhase : phase;
      if (!terminalPhases.has(currentPhase) || bindingChanged || identifiersChanged || usageChanged) {
        await checkpoint(settledPhase, {
          sessionId: error?.sessionId ?? run.sessions[agentId] ?? null,
          tentativeSessionId: error?.tentativeSessionId ?? null,
          sessionResumable: error?.sessionResumable,
          protocol: error?.protocol || null,
          clientUserMessageId: error?.clientUserMessageId || null,
          turnId: error?.turnId || null,
          providerBinding,
          ...(usage.attempt?.failureCostUsd !== undefined ? { failureCostUsd: usage.attempt.failureCostUsd } : {}),
          ...(usage.attempt?.failureTokens !== undefined ? { failureTokens: usage.attempt.failureTokens } : {}),
          ...(usage.attempt?.failureUsageAccounted === true ? { failureUsageAccounted: true } : {}),
          ...(Array.isArray(usage.attempt?.failureUsages) ? { failureUsages: usage.attempt.failureUsages } : {}),
        });
      }
      const settledAttempt = (run.turnAttempts || []).find((item) => item.attemptId === attemptId) || attempt;
      await this.emitEvent(run, "agent.turn_failed", {
        attemptId,
        round: settledAttempt?.round || run.round,
        interactionId: settledAttempt?.interactionId || run.activeInteractionId || null,
        interactionSeq: settledAttempt?.interactionSeq || run.activeInteractionSeq || null,
        interactionStep: settledAttempt?.interactionStep || run.interactionStep || null,
        maxStepsPerInteraction: this.maxStepsForInteraction(run),
        agentId,
        phase: settledAttempt?.phase || settledPhase,
        adapterId: failedAdapter?.id || runtimeProfileId,
        code: error?.code || null,
        message: error?.message || "provider turn failed",
        timeoutKind: error?.timeoutKind || null,
        timeoutMs: Number.isFinite(error?.timeoutMs) ? error.timeoutMs : null,
        idleTimeoutMs: Number.isFinite(error?.idleTimeoutMs) ? error.idleTimeoutMs : null,
        interruptConfirmed: error?.interruptConfirmed === true,
        protocol: error?.protocol || settledAttempt?.protocol || null,
        costUsd: failureCostUsd,
        tokens: failureTokens,
        usageScope: "provider-failure",
        attemptFailureCostUsd: settledAttempt?.failureCostUsd ?? null,
        attemptFailureTokens: settledAttempt?.failureTokens ?? null,
        attemptFailureUsageCount: Array.isArray(settledAttempt?.failureUsages)
          ? settledAttempt.failureUsages.length
          : 0,
        failureUsageKey: usage.usageKey,
        providerBinding,
      }, { runId: run.id, sessionId: error?.sessionId || settledAttempt?.sessionId || null, agentId });
    };
    const lifecycle = {
      onSessionStarted: (data) => checkpoint("session_ready", data),
      onTurnSubmitting: (data) => checkpoint("submitting", data),
      onTurnAccepted: (data) => checkpoint("submitted", data),
    };
    const sendInput = {
      agentId,
      sessionId: run.sessions[agentId] || null,
      prompt,
      runId: run.id,
      signal: controller.signal,
      permissionMode: effectivePermissionMode,
      // 无限预算不下发数字上限（adapter 侧 null=省略 --max-budget-usd）；止损仍在 orchestrator 结算层
      maxBudgetUsd: turnBudgetUsdPerTurn(run, this.policy),
      timeoutMs: this.policy.limits.turnTimeoutMs,
      idleTimeoutMs: this.policy.limits.turnIdleTimeoutMs,
      model: this.effectiveModelFor(run, agentId),
      effort: this.effectiveEffortFor(run, agentId),
      // 原生审批透传：仅执行拥有者拿到，写面不扩散；只接 native: 前缀，其余值不下发（普通三档维持原路径）。
      nativeApprovalMode: agentId === executionOwnerId && String(run.permissionOverride || "").startsWith("native:")
        ? run.permissionOverride
        : null,
      cwd: cwd ?? run.cwd ?? null,
      nativeCommand,
      ...lifecycle,
    };
    try {
      const nativeResolved = nativeCommand
        ? resolveNativeCommand(adapterTemplateForRuntimeProfileId(runtimeProfileId), prompt)
        : null;
      if (nativeResolved && !nativeResolved.ok) {
        throw Object.assign(new Error(nativeResolved.message), { code: nativeResolved.code || "NATIVE_COMMAND_UNSUPPORTED" });
      }
      if (nativeResolved?.command?.execution === "adapter-hook") {
        if (nativeResolved.command.hook !== "compactThread") {
          throw Object.assign(new Error(`${adapter.id || runtimeProfileId} 不支持钩子 ${nativeResolved.command.hook || "(missing)"}`), {
            code: "NATIVE_COMMAND_UNSUPPORTED",
          });
        }
        const sessionId = run.sessions[agentId] || null;
        if (!sessionId) {
          throw Object.assign(new Error("没有可压缩的原生会话；先完成一轮对话或用 /cli 附着。"), {
            code: "NATIVE_COMMAND_UNSUPPORTED",
          });
        }
        if (typeof adapter.compactThread !== "function") {
          throw Object.assign(new Error(`${adapter.id || runtimeProfileId} 不支持原生上下文压缩`), {
            code: "NATIVE_COMMAND_UNSUPPORTED",
          });
        }
        await lifecycle.onTurnSubmitting({ sessionId, protocol: adapter.id, sessionResumable: true });
        await lifecycle.onTurnAccepted({ sessionId, protocol: adapter.id, sessionResumable: true, turnId: null });
        run.contextRecovery = {
          state: "compacting",
          agentId,
          sessionId,
          sourceAttemptId: attemptId,
          startedAt: new Date().toISOString(),
          operator: true,
        };
        await this.save(run);
        await this.emitEvent(run, "run.context_compaction_started", {
          agentId,
          sessionId,
          sourceAttemptId: attemptId,
          operator: true,
          timeoutMs: adapter.contextCompactionTimeoutMs ?? null,
        }, { runId: run.id, sessionId, agentId });
        this.assertRemoteDispatchable(run);
        const compacted = await adapter.compactThread(sessionId, {
          signal: controller.signal,
          runId: run.id,
          agentId,
        });
        run.contextRecovery = {
          ...run.contextRecovery,
          state: "completed",
          compactTurnId: compacted?.turnId || null,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await this.save(run);
        await this.emitEvent(run, "run.context_compaction_completed", {
          agentId,
          sessionId,
          sourceAttemptId: attemptId,
          compactTurnId: compacted?.turnId || null,
          operator: true,
        }, { runId: run.id, sessionId, agentId });
        response = {
          sessionId,
          text: "已压缩当前线程上下文。",
          protocol: adapter.id,
          nativePersistence: true,
          turnId: compacted?.turnId || null,
        };
      } else {
        this.assertRemoteDispatchable(run);
        response = await adapter.send(sendInput);
      }
      providerBinding = response?.providerBinding ?? providerBinding;
    } catch (error) {
      providerBinding = error?.providerBinding ?? providerBinding;
      const fallback = run.remote
        ? (remotePair?.fallback ?? null) // 远程 run 的 fallback 必须同样远程——本机 fallback 会把写盘落到错误机器
        : this.adapters.get(`${runtimeProfileId}-fallback`);
      const attempt = (run.turnAttempts || []).find((item) => item.attemptId === attemptId);
      if (error.submissionRejected === true && attempt?.phase === "submitting") {
        await checkpoint("rejected", {
          sessionId: error.sessionId ?? run.sessions[agentId] ?? null,
          tentativeSessionId: error.tentativeSessionId ?? null,
          sessionResumable: error.sessionResumable,
          protocol: error.protocol || null,
          clientUserMessageId: error.clientUserMessageId || null,
          turnId: error.turnId || null,
        });
      }
      if (error.nativeTurnSettled === true && ["submitting", "submitted"].includes(attempt?.phase)) {
        await checkpoint("failed", {
          sessionId: error.sessionId ?? run.sessions[agentId] ?? null,
          tentativeSessionId: error.tentativeSessionId ?? null,
          sessionResumable: error.sessionResumable,
          protocol: error.protocol || null,
          clientUserMessageId: error.clientUserMessageId || null,
          turnId: error.turnId || null,
        });
      }
      if (error.failureKind === "budget_exhausted") {
        await recordTurnFailure(error, { failedAdapter: adapter });
        this.markBudgetAttention(run, error, { attemptId });
        await this.save(run);
        await this.emitBudgetAttention(run, error, { attemptId, source: "provider-turn" });
        throw error;
      }

      if (error.code === "CONTEXT_WINDOW_EXCEEDED" && error.nativeTurnSettled === true && !controller.signal.aborted) {
        const exhaustedSessionId = error.sessionId || run.sessions[agentId] || null;
        await recordTurnFailure(error, { failedAdapter: adapter });

        const invalidateContextSession = async (compactionError) => {
          const invalidatedAt = new Date().toISOString();
          // fail-closed 必须 abort-safe：压缩窗口最长 5 分钟，LO 在窗口内点中断/取消是最高频的真实
          // 操作。若这里走 withLifecycleEffect，owner 断言会在 abort 后直接抛 ABORTED，作废动作
          // 整个被跳过——耗尽的原生线程原样留在 run.sessions，下一次「继续」resume 它必然重演
          // CONTEXT_WINDOW_EXCEEDED。改走无断言的 withRunLifecycle：删除仍受
          // `sessions[agentId] === exhaustedSessionId` 守卫，新执行者已换会话时天然不误删。
          await this.withRunLifecycle(run.id, async () => {
            if (exhaustedSessionId && run.sessions[agentId] === exhaustedSessionId) delete run.sessions[agentId];
            const failedAttempt = (run.turnAttempts || []).find((item) => item.attemptId === attemptId);
            if (failedAttempt) {
              failedAttempt.sessionResumable = false;
              failedAttempt.invalidatedAt = invalidatedAt;
              failedAttempt.invalidationReason = "context-compaction-failed";
            }
            run.invalidatedSessions = [...(run.invalidatedSessions || []), {
              agentId,
              sessionId: exhaustedSessionId,
              reason: "context-compaction-failed",
              code: compactionError?.code || "CONTEXT_COMPACTION_UNAVAILABLE",
              at: invalidatedAt,
            }].slice(-50);
            run.contextRecovery = {
              state: "failed",
              agentId,
              sessionId: exhaustedSessionId,
              sourceAttemptId: attemptId,
              code: compactionError?.code || "CONTEXT_COMPACTION_UNAVAILABLE",
              message: compactionError?.message || "native context compaction is unavailable",
              updatedAt: invalidatedAt,
            };
            await this.save(run);
            await this.emitEvent(run, "run.context_compaction_failed", {
              agentId,
              sessionId: exhaustedSessionId,
              sourceAttemptId: attemptId,
              code: run.contextRecovery.code,
              message: run.contextRecovery.message,
              sessionInvalidated: true,
            }, { runId: run.id, sessionId: exhaustedSessionId, agentId });
          });
          try {
            await this.invalidateConversationContext(run, agentId, exhaustedSessionId, "context-compaction-failed");
          } catch (contextError) {
            run.contextRecovery = {
              ...run.contextRecovery,
              contextBindingInvalidationFailed: true,
              contextBindingInvalidationCode: contextError?.code || "CONVERSATION_CONTEXT_STORE_UNAVAILABLE",
            };
            await this.save(run).catch(() => {});
          }
          // 取消语义优先于恢复语义：LO 主动 abort 时本轮仍按 ABORTED 收束（否则会把一次取消
          // 改写成 recovery_required 状态），但线程作废已经在上面无条件落盘，账目照样是干净的。
          if (controller?.signal?.aborted) {
            return Object.assign(
              new Error(`run cancelled during native context compaction; the exhausted native thread was invalidated: ${compactionError?.message || "compaction aborted"}`),
              {
                code: "ABORTED",
                contextRecoveryCode: compactionError?.code || "CONTEXT_COMPACTION_UNAVAILABLE",
                contextRecoveryFailed: true,
                invalidatedSessionId: exhaustedSessionId,
                sessionId: null,
              },
            );
          }
          return Object.assign(
            new Error(`Codex context compaction failed; the exhausted native thread was invalidated before another continuation: ${compactionError?.message || "compaction unavailable"}`),
            {
              code: "RECOVERY_REQUIRED",
              contextRecoveryCode: compactionError?.code || "CONTEXT_COMPACTION_UNAVAILABLE",
              contextRecoveryFailed: true,
              nativeTurnSettled: true,
              invalidatedSessionId: exhaustedSessionId,
              sessionId: null,
            },
          );
        };

        const compactionsUsed = Math.max(0, Math.trunc(Number(run.interactionContextCompactions) || 0));
        const compactionBudgetExhausted = compactionsUsed >= MAX_CONTEXT_COMPACTIONS_PER_INTERACTION;
        if (!allowContextRecovery || compactionBudgetExhausted || nativeCommand || !exhaustedSessionId || typeof adapter.compactThread !== "function") {
          throw await invalidateContextSession(Object.assign(
            new Error(!allowContextRecovery || compactionBudgetExhausted
              ? `context was still exhausted after ${MAX_CONTEXT_COMPACTIONS_PER_INTERACTION} compaction retry in this interaction`
              : nativeCommand ? "native command turns are not replayed automatically"
                : !exhaustedSessionId ? "the exhausted turn did not expose a resumable session"
                  : "the active adapter does not support native context compaction"),
            { code: "CONTEXT_COMPACTION_UNAVAILABLE" },
          ));
        }

        await this.withLifecycleEffect(run, controller, async () => {
          // 预算在发起前扣：压缩被中断/超时后若不计数，重来一次又能白拿一次 5 分钟窗口。
          run.interactionContextCompactions = compactionsUsed + 1;
          run.contextRecovery = {
            state: "compacting",
            agentId,
            sessionId: exhaustedSessionId,
            sourceAttemptId: attemptId,
            startedAt: new Date().toISOString(),
          };
          await this.save(run);
          await this.emitEvent(run, "run.context_compaction_started", {
            agentId,
            sessionId: exhaustedSessionId,
            sourceAttemptId: attemptId,
            attempt: run.interactionContextCompactions,
            cap: MAX_CONTEXT_COMPACTIONS_PER_INTERACTION,
            timeoutMs: adapter.contextCompactionTimeoutMs ?? null,
            nextRound: run.round + 1,
          }, { runId: run.id, sessionId: exhaustedSessionId, agentId });
        });

        let compacted;
        try {
          this.assertRemoteDispatchable(run);
          compacted = await adapter.compactThread(exhaustedSessionId, {
            signal: controller.signal,
            runId: run.id,
            agentId,
          });
        } catch (compactionError) {
          throw await invalidateContextSession(compactionError);
        }

        await this.withLifecycleEffect(run, controller, async () => {
          run.contextRecovery = {
            ...run.contextRecovery,
            state: "completed",
            compactTurnId: compacted?.turnId || null,
            completedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          await this.save(run);
          await this.emitEvent(run, "run.context_compaction_completed", {
            agentId,
            sessionId: exhaustedSessionId,
            sourceAttemptId: attemptId,
            compactTurnId: compacted?.turnId || null,
            nextRound: run.round + 1,
          }, { runId: run.id, sessionId: exhaustedSessionId, agentId });
        });

        return await this.turn(run, agentId, contextRetryPrompt, {
          allowWorkspaceWrite,
          cwd,
          sourceWorkItemId,
          sourceBusMessageId,
          allowAutoRecovery,
          allowContextRecovery: false,
          nativeCommand,
        });
      }
      // The registry owns fallback identity. A known app-server may report its no-replay
      // boundary even when transport loss prevented lifecycle callbacks from persisting.
      const isCodexAppServer = adapter.id === "codex-app-server" || Boolean(fallback);
      const replayBlocked = (candidate) => candidate?.safeToFallback === false
        && candidate?.nativeTurnSettled !== true
        && (isCodexAppServer || ["submitting", "submitted", "ambiguous"].includes(attempt?.phase));
      // ambiguous 封存 + 阻断事件只有一个出口：首轮失败与自动续跑失败都经这里，避免两套台账漂移。
      const markAmbiguous = async (blockedError) => {
        if (blockedError.sessionId) run.sessions[agentId] = blockedError.sessionId;
        await checkpoint("ambiguous", {
          sessionId: blockedError.sessionId || run.sessions[agentId] || null,
          protocol: blockedError.protocol || null,
          clientUserMessageId: blockedError.clientUserMessageId || null,
          turnId: blockedError.turnId || null,
        });
        await this.emitEvent(
          run,
          "adapter.replay_blocked",
          {
            from: adapter.id || runtimeProfileId,
            reason: blockedError.message,
            phase: blockedError.codexPhase || attempt?.phase || "unknown",
            clientUserMessageId: blockedError.clientUserMessageId || attempt?.clientUserMessageId || null,
            interruptConfirmed: blockedError.interruptConfirmed === true,
          },
          { runId: run.id, sessionId: blockedError.sessionId || run.sessions[agentId] || null, agentId },
        );
      };
      // 已确认打断的只读超时轮：原生会话完好留存且无写盘残留，自动续跑一轮比进人工闸
      // 更安全也更省——人工"检查"在没有半成品可写的只读轮里没有可检查对象。
      if (allowAutoRecovery && replayBlocked(error) && !controller.signal.aborted) {
        const recovery = this.autoRecoveryDecision(run, agentId, error, effectivePermissionMode);
        if (recovery.ok) {
          await checkpoint("failed", {
            sessionId: error.sessionId || run.sessions[agentId] || null,
            protocol: error.protocol || null,
            clientUserMessageId: error.clientUserMessageId || null,
            turnId: error.turnId || null,
          });
          await recordTurnFailure(error, { failedAdapter: adapter });
          if (this.budgetExhausted(run)) {
            await this.emitEvent(run, "run.budget_exhausted", {
              interactionId: run.activeInteractionId,
              interactionSeq: run.activeInteractionSeq,
              interactionCostUsd: run.interactionCostUsd || 0,
              source: "failed-turn",
            }, { runId: run.id, sessionId: error.sessionId || run.sessions[agentId] || null, agentId });
            error.autoRecoveryBlocked = "budget-exhausted";
            throw error;
          }
          run.autoRecoveries = (run.autoRecoveries || 0) + 1;
          run.interactionAutoRecoveries = (run.interactionAutoRecoveries || 0) + 1;
          await this.emitEvent(
            run,
            "run.auto_recovery",
            {
              agentId,
              round: run.round,
              interactionId: run.activeInteractionId,
              interactionSeq: run.activeInteractionSeq,
              interactionStep: run.interactionStep,
              count: run.interactionAutoRecoveries,
              cap: MAX_AUTO_RECOVERIES_PER_INTERACTION,
              nextRound: run.round + 1,
              reason: error.message,
            },
            { runId: run.id, sessionId: error.sessionId || run.sessions[agentId] || null, agentId },
          );
          return await this.turn(run, agentId, AUTO_RECOVERY_CONTINUATION_PROMPT, {
            allowWorkspaceWrite,
            cwd,
            sourceWorkItemId,
            sourceBusMessageId,
            allowAutoRecovery: false,
            // 与压缩链的递归（allowContextRecovery: false）对称。压缩预算另有 run 级计数器兜底，
            // 但这里显式传递才能让"续跑轮不得再开压缩"这条语义在读代码时是自明的；
            // nativeCommand 同样必须透传，否则原生命令轮会被静默降级成散文轮。
            allowContextRecovery: false,
            nativeCommand,
          });
        }
      }
      if (!response) {
        if (replayBlocked(error)) await markAmbiguous(error);
        // Fallback ownership is declared by the adapter registry, not by a reserved profile id.
        if (
          !isCodexAppServer
          || controller.signal.aborted
          || !CODEX_TRANSPORT_FAILURES.has(error.code)
          || error.safeToFallback !== true
        ) {
          if (!controller.signal.aborted && error.code !== "ABORTED") {
            await recordTurnFailure(error, { failedAdapter: adapter });
          }
          throw error;
        }
        if (!fallback) {
          await recordTurnFailure(error, { failedAdapter: adapter });
          throw error;
        }
        const primaryProviderBinding = providerBinding;
        const primaryUsage = accountFailureUsage(error, adapter, primaryProviderBinding);
        if (this.budgetExhausted(run)) {
          await recordTurnFailure(error, { failedAdapter: adapter });
          await this.emitEvent(run, "run.budget_exhausted", {
            interactionId: run.activeInteractionId,
            interactionSeq: run.activeInteractionSeq,
            interactionCostUsd: run.interactionCostUsd || 0,
            source: "failed-turn-fallback",
          }, { runId: run.id, sessionId: error.sessionId || run.sessions[agentId] || null, agentId });
          error.fallbackBlocked = "budget-exhausted";
          throw error;
        }
        providerBinding = this.providerBindingFor(fallback, runtimeProfileId, { remote: Boolean(run.remote) });
        effectiveAdapter = fallback;
        const fallbackAttempt = (run.turnAttempts || []).find((item) => item.attemptId === attemptId);
        if (fallbackAttempt) {
          fallbackAttempt.providerBinding = providerBinding;
          await this.save(run);
        }
        await this.emitEvent(
          run,
          "adapter.fallback",
          {
            from: adapter.id || "codex-app-server",
            to: fallback.id || "codex-exec-json",
            reason: error.message,
            fromProviderBinding: primaryProviderBinding,
            toProviderBinding: providerBinding,
            fromCostUsd: primaryUsage.costUsd,
            fromTokens: primaryUsage.tokens,
            failureUsageKey: primaryUsage.usageKey,
          },
          { runId: run.id, sessionId: run.sessions[agentId] || null, agentId },
        );
        run.adapterFallbackCount = (Number(run.adapterFallbackCount) || 0) + 1;
        this.assertLifecycleOwner(run, controller);
        this.assertRemoteDispatchable(run);
        try {
          response = await fallback.send(sendInput);
          providerBinding = response?.providerBinding ?? providerBinding;
        } catch (fallbackError) {
          providerBinding = fallbackError?.providerBinding ?? providerBinding;
          if (!controller.signal.aborted && fallbackError?.code !== "ABORTED") {
            await recordTurnFailure(fallbackError, { failedAdapter: fallback });
          }
          throw fallbackError;
        }
      }
    }
    // provider 返回 end 事件不等于交付完成：Grok 会用 exit 0 + stopReason=cancelled 表示
    // 权限/用户中断。零文本也不是可交付答复。两者都必须在写 completed/turn_completed 前分流。
    const stopReason = response.stopReason ?? null;
    const hasPartialOutput = Boolean(String(response.text ?? "").trim());
    const unproductive = !hasPartialOutput
      ? "EMPTY_OUTPUT"
      : isAbnormalProviderTurnStop(stopReason) ? "ABNORMAL_STOP" : null;
    let incompleteError = null;
    // Some CLIs cannot or do not honor AbortSignal. Response mutation is owner-gated;
    // all later bus/result projections use projectionChains, which cancel drains before
    // publishing the terminal cancellation state.
    await this.withLifecycleEffect(run, controller, async () => {
      run.sessions[agentId] = response.sessionId;
      if (run.contextRecovery?.state === "failed"
        && run.contextRecovery.agentId === agentId
        && response.sessionId
        && response.sessionId !== run.contextRecovery.sessionId) {
        run.contextRecovery = {
          ...run.contextRecovery,
          state: "replaced",
          replacementSessionId: response.sessionId,
          recoveredAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      // 全会话成本只做审计；派发硬闸按当前 interaction 已知成本计算，避免聊天久了永久锁死。
      // 无成本回执的 CLI（codex/grok/kimi）仍如实计不到，不能把这道闸宣称为普适保证。
      if (Number.isFinite(response.costUsd)) {
        run.costUsdTotal = (run.costUsdTotal || 0) + response.costUsd;
        run.interactionCostUsd = (run.interactionCostUsd || 0) + response.costUsd;
      }
      const attemptRecord = (run.turnAttempts || []).find((item) => item.attemptId === attemptId) || null;
      const turnRecord = {
        // id/createdAt/role 供前端重启后从 turns 恢复对话时稳定去重、真实时序排序、正确归属（避免倒置/全显 Agent）
        id: attemptId,
        round: run.round,
        interactionId: attemptRecord?.interactionId || run.activeInteractionId,
        interactionSeq: attemptRecord?.interactionSeq || run.activeInteractionSeq,
        interactionStep: attemptRecord?.interactionStep || run.interactionStep,
        role: "assistant",
        agentId,
        createdAt: new Date().toISOString(),
        sessionId: response.sessionId,
        protocol: response.protocol,
        permissionMode: effectivePermissionMode,
        requestedModel: response.requestedModel ?? null,
        effectiveModel: response.effectiveModel ?? null,
        providerBinding,
        costUsd: response.costUsd ?? null,
        tokens: response.tokens ?? null, // 状态栏累计用量
        text: response.text,
        stopReason,
      };
      if (unproductive) {
        // partial text/usage 保留用于排查，但明确标成 incomplete；外层 social/pipeline/continue
        // 收到错误后按 durable claim 所有权进入 recovery_required 或 failed，绝不再落 succeeded。
        run.turns.push({ ...turnRecord, outcome: "incomplete" });
        await this.checkpointTurn(run, agentId, attemptId, "failed", {
          sessionId: response.sessionId,
          protocol: response.protocol,
          clientUserMessageId: (run.turnAttempts || []).find((item) => item.attemptId === attemptId)?.clientUserMessageId || null,
          providerBinding,
        });
        await this.emitEvent(run, "agent.turn_unproductive", {
          round: run.round,
          interactionId: turnRecord.interactionId,
          interactionSeq: turnRecord.interactionSeq,
          interactionStep: turnRecord.interactionStep,
          maxStepsPerInteraction: this.maxStepsForInteraction(run),
          agentId,
          reason: unproductive,
          stopReason,
          hasPartialOutput,
          tokens: response.tokens ?? null,
          providerBinding,
        }, { runId: run.id, sessionId: response.sessionId, agentId });
        const reason = stopReason ? `provider stopReason=${stopReason}` : "empty provider response";
        incompleteError = Object.assign(
          new Error(`provider turn did not produce a deliverable result (${reason}); partial output, if any, was retained for diagnosis`),
          {
            code: "PROVIDER_TURN_INCOMPLETE",
            stopReason,
            sessionId: response.sessionId,
            partialOutput: hasPartialOutput,
            interruptConfirmed: true,
          },
        );
        return;
      }
      run.turns.push({ ...turnRecord, outcome: "completed" });
      await this.checkpointTurn(run, agentId, attemptId, "completed", {
        sessionId: response.sessionId,
        protocol: response.protocol,
        clientUserMessageId: (run.turnAttempts || []).find((item) => item.attemptId === attemptId)?.clientUserMessageId || null,
        providerBinding,
      });
      this.assertLifecycleOwner(run, controller);
      await this.publishConversationContext(run, agentId, attemptId, response, effectiveAdapter, providerBinding);
      this.assertLifecycleOwner(run, controller);
      await this.emitEvent(run, "agent.turn_completed", {
        round: run.round,
        interactionId: turnRecord.interactionId,
        interactionSeq: turnRecord.interactionSeq,
        interactionStep: turnRecord.interactionStep,
        maxStepsPerInteraction: this.maxStepsForInteraction(run),
        agentId,
        protocol: response.protocol,
        permissionMode: effectivePermissionMode,
        requestedModel: response.requestedModel ?? null,
        effectiveModel: response.effectiveModel ?? null,
        providerBinding,
        costUsd: response.costUsd ?? null,
        tokens: response.tokens ?? null,
      }, { runId: run.id, sessionId: response.sessionId, agentId });
    });
    if (incompleteError) throw incompleteError;
    return response.text;
  }

  /**
   * 续轮（轮间插话 / 直发续聊）的写权限预检。
   *
   * 建 run 时批过的授权在同一 run 的后续轮里继续有效——否则 LO 说「继续执行」时执行所有者
   * 只拿到 plan，只能反复回「请确认是否要我立即执行」，指令与权限两端一起锁死（LO 2026-08-14
   * 报障：run d63b839d 第 1 轮 workspace-write，之后 4 轮全 plan，审批/租约/工作树全部就绪
   * 却没有任何一条续轮路径去申请）。
   *
   * 这里只做**预检**：真正的把关仍在 turn() 内部（审批有效性 / 租约 / worktree 校验 /
   * adapter per-turn cwd fail-closed），本方法不绕过、不放宽任何一道闸。授权链缺失时返回
   * allow:false + reason，调用方降级为只读并明确播报——续聊里「这一轮只能读」是可继续的
   * 状态，直接抛 POLICY_VIOLATION 会把整轮打死，比只读更糟。
   *
   * reason=null 表示本来就该只读（非执行所有者 / 非 build 档位），不是降级，无需播报。
   */
  continuationWriteGrant(run, agentId) {
    if (run.permissionMode !== "build" || agentId !== executionOwnerIdOf(run)) {
      return { allow: false, reason: null };
    }
    if (!this.buildApprovalIsValid(run)) return { allow: false, reason: "BUILD_APPROVAL_INVALID" };
    if (!this.activeCapabilityLease(run)) return { allow: false, reason: "CAPABILITY_LEASE_INACTIVE" };
    return { allow: true, reason: null };
  }

  /** 写权限降级必须看得见：静默降级 = LO 以为在写盘、其实只读（安全底座禁 silent fallback）。 */
  async emitWriteDegraded(run, agentId, reason) {
    if (!reason) return;
    await this.emitEvent(run, "run.write_degraded", { agentId, reason }, { runId: run.id, agentId });
  }

  /** 当前交互已知成本止损：只覆盖会回传 costUsd 的 adapter，不冒充所有 provider 的货币硬顶。
   *  无限预算 → cap=Infinity，`spent >= Infinity` 恒假——美元止损自然关闭，步数上限仍兜底。 */
  budgetExhausted(run) {
    const cap = resolveBudgetUsdPerTurn(run.maxBudgetUsdPerTurn, this.policy) * this.maxStepsForInteraction(run);
    return cap > 0 && Number(run.interactionCostUsd || 0) >= cap;
  }

  markBudgetAttention(run, error, { attemptId = null } = {}) {
    const budget = resolveBudgetUsdPerTurn(run.maxBudgetUsdPerTurn, this.policy);
    // Infinity 无法 JSON 序列化（会静默变 null）：非有限值显式落 null，事件里不撒谎
    const budgetForWire = Number.isFinite(budget) ? budget : null;
    const at = new Date().toISOString();
    run.status = "waiting_agent";
    run.failureKind = "budget_exhausted";
    run.error = error?.message || "Reached maximum budget";
    run.recoveryNote = null;
    run.stopReason = {
      type: "budget_exhausted",
      scope: "provider_turn",
      attemptId,
      interactionId: run.activeInteractionId || null,
      at,
    };
    run.attention = {
      type: "budget_exhausted",
      severity: "warning",
      maxBudgetUsdPerTurn: budgetForWire,
      interactionCostUsd: Math.max(0, Number(run.interactionCostUsd) || 0),
      maxInteractionCostUsd: Number.isFinite(budget) ? budget * this.maxStepsForInteraction(run) : null,
      autoResume: false,
      actions: ["adjust_budget", "lower_effort", "send_message"],
    };
  }

  async emitBudgetAttention(run, error, { attemptId = null, source = "provider-turn" } = {}) {
    await this.emitEvent(run, "run.budget_exhausted", {
      code: error?.code || "CLAUDE_BUDGET_EXHAUSTED",
      source,
      attemptId,
      interactionId: run.activeInteractionId || null,
      interactionSeq: run.activeInteractionSeq || null,
      interactionCostUsd: run.attention?.interactionCostUsd || 0,
      maxBudgetUsdPerTurn: run.attention?.maxBudgetUsdPerTurn || null,
      maxInteractionCostUsd: run.attention?.maxInteractionCostUsd || null,
      autoResume: false,
    }, { runId: run.id, sessionId: error?.sessionId || null });
  }

  async ensureStablePendingAsk(run, { messages = null, persist = true } = {}) {
    if (!run.pendingAsk || run.pendingAsk.id) return run.pendingAsk || null;
    const materialize = async () => {
      if (!run.pendingAsk || run.pendingAsk.id) return run.pendingAsk || null;
      const legacy = { ...run.pendingAsk };
      const members = new Set(run.teamMembers || []);
      if (!legacy.from || (members.size && !members.has(legacy.from))) {
        throw Object.assign(new Error("legacy pending ask is not owned by a run team member"), { code: "LEGACY_ASK_INVALID" });
      }
      const history = messages || await this.bus.read(run.id);
      let durable = history.find((message) => message.kind === "ask"
        && message.to === "lo"
        && message.from === legacy.from
        && message.text === legacy.text
        && (!legacy.at || message.ts === legacy.at));
      if (!durable) {
        if (!run.busExpectedAt) run.busExpectedAt = new Date().toISOString();
        durable = await this.bus.append(run.id, {
          id: legacyAskMessageId(run, legacy),
          from: legacy.from,
          to: "lo",
          kind: "ask",
          text: legacy.text,
          refs: { legacyMigrated: true },
        });
        if (!run.busMaterializedAt) run.busMaterializedAt = durable.ts;
      }
      run.pendingAsk = { id: durable.id, from: durable.from, text: durable.text, at: durable.ts };
      run.pausedForInput = true;
      if (persist) await this.save(run);
      return run.pendingAsk;
    };
    return persist ? this.withRunTransition(run.id, materialize) : materialize();
  }

  async reconcileSocialBus(run) {
    if (run.orchestrationMode !== "social" || TERMINAL.has(run.status)) {
      return { changed: false, resume: false };
    }
    let messages = await this.bus.read(run.id);
    let changed = false;
    if (run.pendingAsk && !run.pendingAsk.id) {
      await this.ensureStablePendingAsk(run, { messages, persist: false });
      messages = await this.bus.read(run.id);
      changed = true;
    }
    if (!messages.length) return { changed, resume: false };

    const members = new Set(run.teamMembers || []);
    const asks = messages.filter((message) => message.kind === "ask"
      && message.to === "lo"
      && (!members.size || members.has(message.from)));
    const answersByAsk = new Map();
    for (const ask of asks) {
      const answer = messages.find((message) => answerOwnsAsk(run, message, ask));
      if (answer) answersByAsk.set(ask.id, answer);
    }

    const consumedRouteIds = new Set((run.turnAttempts || [])
      .filter((attempt) => attempt.sourceBusMessageId
        && ["submitting", "submitted", "ambiguous", "completed"].includes(attempt.phase))
      .map((attempt) => attempt.sourceBusMessageId));
    const queuedRoutes = messages
      .filter((message) => message.kind === "say"
        && message.refs?.routeDisposition === "queued"
        && members.has(message.to)
        && !consumedRouteIds.has(message.id))
      .map((message) => ({
        to: message.to,
        busMessageId: message.id,
        sourceAttemptId: message.refs?.sourceAttemptId || null,
        kind: "route",
      }));
    const restoredQueue = mergeResumeQueues(run.resumeQueue, queuedRoutes);
    if (JSON.stringify(run.resumeQueue || []) !== JSON.stringify(restoredQueue)) {
      run.resumeQueue = restoredQueue;
      changed = true;
    }

    const persistedAsk = run.pendingAsk?.id
      ? asks.find((message) => message.id === run.pendingAsk.id) || null
      : null;
    const unansweredAsk = [...asks].reverse().find((message) => !answersByAsk.has(message.id)) || null;

    if (unansweredAsk) {
      const normalized = {
        id: unansweredAsk.id,
        from: unansweredAsk.from,
        text: unansweredAsk.text,
        at: unansweredAsk.ts,
      };
      if (JSON.stringify(run.pendingAsk ?? null) !== JSON.stringify(normalized)) {
        run.pendingAsk = normalized;
        changed = true;
      }
      if (run.pausedForInput !== true) {
        run.pausedForInput = true;
        changed = true;
      }
      return { changed, resume: false };
    }

    if (persistedAsk && answersByAsk.has(persistedAsk.id)) {
      const answer = answersByAsk.get(persistedAsk.id);
      run.pendingAsk = null;
      run.pausedForInput = false;
      const promotedSteerId = answer.refs?.queuedSteerId || null;
      if (promotedSteerId) {
        const retained = (run.pendingSteer || []).filter((item) => item?.id !== promotedSteerId);
        if (retained.length !== (run.pendingSteer || []).length) {
          run.pendingSteer = retained;
        }
        if (run.activeSteer?.steerId === promotedSteerId) run.activeSteer = null;
      }
      run.resumeQueue = mergeResumeQueues(
        [{ to: persistedAsk.from, busMessageId: answer.id, kind: "answer" }],
        run.resumeQueue,
      );
      run.recoveryNote = "A durable user answer was reconciled after restart and is queued for safe read-only continuation.";
      changed = true;
      return { changed, resume: true };
    }

    return { changed, resume: false };
  }

  async appendBus(run, message) {
    const recipient = String(message?.to ?? "").trim();
    if (!recipient) {
      throw Object.assign(new Error("bus message requires a recipient"), { code: "SOCIAL_RECIPIENT_REQUIRED" });
    }
    if (!run.busExpectedAt) {
      run.busExpectedAt = new Date().toISOString();
      await this.save(run);
    }
    const appended = await this.bus.append(run.id, message);
    if (!run.busMaterializedAt) {
      run.busMaterializedAt = appended.ts;
      await this.save(run);
    }
    await this.emitEvent(run, "bus.appended", {
      messageId: appended.id,
      from: appended.from,
      to: appended.to,
      kind: appended.kind,
    }, { runId: run.id, agentId: appended.from });
    return appended;
  }

  async execute(id) {
    const run = this.get(id);
    if (TERMINAL.has(run.status) || run.status === "recovery_required" || run.status === "interrupted") return run;
    if (run.buildApproval?.status === "withdrawn") return run;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    run.status = "running";
    await this.save(run);
    try {
      // P3 build 隔离（social 与 pipeline 统一，烛致命8：显式 pipeline 曾绕过 worktree）：
      // build 会话先建 git worktree，全部轮次 cwd 指向隔离副本——真实项目目录零污染。
      // 无 cwd 的 build（写盘落 adapter 默认目录）不再静默——审计事件如实可见
      if (run.permissionMode === "build" && run.execute) {
        if (run.cwd) await this.ensureRunWorktree(run);
        else if (run.remote && !run.worktreeSkipNoted) {
          // v41：worktree 是本机 fs+git 语义，远程 run 首波禁用——如实标注，不假装隔离（§3.3）
          run.worktreeSkipNoted = true;
          await this.emitEvent(run, "run.worktree_skipped", {
            reason: "remote run: git worktree isolation is local-only; agent writes directly on the remote host",
            workspaceIsolation: "remote-unsupported",
          }, { runId: run.id });
        } else if (!run.worktreeSkipNoted) {
          run.worktreeSkipNoted = true;
          await this.emitEvent(run, "run.worktree_skipped", { reason: "run has no cwd; write turns run in the adapter default directory without worktree isolation" }, { runId: run.id });
        }
      }
      if (run.orchestrationMode === "social") {
        // v3.6 社会模拟编排：消息驱动主循环（bus.jsonl），与 pipeline 拓扑分治
        await this.socialLoop(run, controller);
        // 只有无定向目标的 legacy continuation 才可在 ask 出现后升级为回答。显式 agentId
        // 始终保留 steer 所有权，成员独立页不会因为同时出现 pendingAsk 而被静默改投发问者。
        while (run.pausedForInput && run.pendingAsk && !controller.signal.aborted) {
          const promoted = await this.withProjectionEffect(run, controller, () => this.promoteQueuedAnswer(run));
          if (!promoted) break;
          await this.socialLoop(run, controller);
        }
      } else if (run.conversationKind === "direct") {
        const direct = await this.turn(
          run,
          executionOwnerIdOf(run),
          run.prompt,
          { allowWorkspaceWrite: run.permissionMode === "build" },
        );
        run.result = { direct, final: direct };
      } else {
      const specialistId = executionOwnerIdOf(run);
      const independentId = run.route.independent?.id || null;
      const coordinatorId = run.coordinatorId || "claude-fable";
      const teamContext = run.teamBrief ? `${run.teamBrief}\n\n` : "";
      // 轮间插话：每个 turn 边界尝试注入最早一条排队追问（turn 原子性不变——只在边界接管，不打断子进程）
      let lastPipelineAttemptId = null;
      const turn = async (...args) => {
        const topologyInteraction = this.currentInteraction(run);
        const text = await this.turn(run, ...args);
        lastPipelineAttemptId = run.turns.at(-1)?.id || null;
        if ((run.pendingSteer || []).length || run.activeSteer) {
          await this.injectNextSteer(run);
          // 插话处理完后恢复旧拓扑的独立步骤/成本/附件账；下一阶段不能继承插话图片。
          await this.withRunTransition(run.id, async () => {
            this.activateInteraction(run, topologyInteraction, { adoptDurableWork: false });
            await this.save(run);
          });
        }
        return text;
      };
      const recordPipelineDelegation = (fromAgentId, toAgentId, kind, sourceAttemptId) => {
        if (!fromAgentId || !toAgentId || fromAgentId === toAgentId) return null;
        const busMessageId = operationMessageId("pipeline", [
          run.id,
          run.activeInteractionId || "initial",
          kind,
          fromAgentId,
          toAgentId,
          sourceAttemptId || "root",
        ].join(":"));
        this.recordTaskGraphDelegation(run, {
          fromAgentId,
          toAgentId,
          busMessageId,
          kind,
          state: "queued",
          attemptId: sourceAttemptId,
        });
        return busMessageId;
      };
      const coordinatorOwnsBuild = run.permissionMode === "build" && specialistId === coordinatorId;
      const plan = await turn(
        coordinatorId,
        coordinatorOwnsBuild
          ? `${teamContext}你是 514cc 团队主脑，也是用户明确选择并获批的执行所有者。请在获批工作区内完成目标并给出可验证证据，不输出隐藏思维链。\n\n用户目标：\n${run.prompt}\n\n路由器建议：${run.route.selected.id}\n路由理由：${run.route.reason}`
          : `${teamContext}你是 514cc 团队主脑与总协调者。本轮是规划阶段（plan 权限模式，只读不落盘）；禁止声称已写入、已部署或未验证的完成。请输出可公开审计的计划、派工理由、验收标准和给执行者的任务包，不输出隐藏思维链。\n\n用户目标：\n${run.prompt}\n\n执行所有者：${specialistId}\n路由器建议：${run.route.selected.id}\n路由理由：${run.route.reason}`,
        { allowWorkspaceWrite: coordinatorOwnsBuild },
      );
      const planAttemptId = lastPipelineAttemptId;
      if (specialistId === coordinatorId || this.interactionLimitReached(run)) {
        if (independentId && !this.interactionLimitReached(run)) {
          const reviewMessageId = recordPipelineDelegation(coordinatorId, independentId, "pipeline-review", planAttemptId);
          const independent = await turn(
            independentId,
            `你是独立验证者，不受主脑结论约束。请核查以下计划的正确性、遗漏、风险和可执行性，给出证据化 verdict。不要输出隐藏思维链。\n\n原始目标：\n${run.prompt}\n\n主脑计划：\n${plan}`,
            { sourceBusMessageId: reviewMessageId },
          );
          const independentAttemptId = lastPipelineAttemptId;
          const final = !this.interactionLimitReached(run)
            ? await turn(
                coordinatorId,
                `独立验证者 ${independentId} 已审查你的计划。请吸收有效纠偏并给出最终可执行结论、验收证据和剩余风险。\n\n原始计划：\n${plan}\n\n独立审查：\n${independent}`,
                { sourceBusMessageId: recordPipelineDelegation(independentId, coordinatorId, "pipeline-synthesis", independentAttemptId) },
              )
            : independent;
          run.result = { plan, independent, final };
        } else {
          run.result = { plan, final: plan };
        }
      } else {
        const specialistMessageId = recordPipelineDelegation(coordinatorId, specialistId, "pipeline-dispatch", planAttemptId);
        const specialist = await turn(
          specialistId,
          `主脑（${coordinatorId}）派发以下任务。请作为独立技术/研究执行者完成，保留证据、指出阻塞并提出明确反问。\n\n原始目标：\n${run.prompt}\n\n主脑计划：\n${plan}`,
          { allowWorkspaceWrite: true, sourceBusMessageId: specialistMessageId },
        );
        const specialistAttemptId = lastPipelineAttemptId;
        if (this.interactionLimitReached(run)) {
          // 自动恢复也消耗当前交互的真实 step。预算已尽时保留已完成执行结果并明确标记未复核，
          // 不能再调用 provider，也不能伪造 independent critique。
          run.result = { plan, specialist, critique: null, verified: specialist, final: specialist, truncated: true };
        } else {
          const verifierId = independentId || coordinatorId;
          const verifierMessageId = recordPipelineDelegation(specialistId, verifierId, "pipeline-review", specialistAttemptId);
          const critique = await turn(
            verifierId,
            `你是本轮独立验证者。执行者 ${specialistId} 已返回结果。请检查它是否满足原目标，指出缺口、核验证据，并输出可直接作为最终审计结论使用的 verdict；如仍有轮次，再附给执行者的补强指令。\n\n原始目标：\n${run.prompt}\n\n执行结果：\n${specialist}`,
            { sourceBusMessageId: verifierMessageId },
          );
          const verifierAttemptId = lastPipelineAttemptId;
          let verified = specialist;
          let synthesisSourceId = verifierId;
          let synthesisAttemptId = verifierAttemptId;
          if (run.collaborationMode === "deep" && !this.interactionLimitReached(run, 1)) {
            const reworkMessageId = recordPipelineDelegation(verifierId, specialistId, "pipeline-rework", verifierAttemptId);
            verified = await turn(
              specialistId,
              `独立验证者（${verifierId}）对上一轮结果的复核如下。请在同一个原生会话中完成补强并给出最终证据。\n\n${critique}`,
              { allowWorkspaceWrite: true, sourceBusMessageId: reworkMessageId },
            );
            synthesisSourceId = specialistId;
            synthesisAttemptId = lastPipelineAttemptId;
          }
          const final = !this.interactionLimitReached(run)
            ? await turn(
                coordinatorId,
                `作为主脑，请综合原始目标、执行结果和复核结果，输出最终结论、已验证证据、未完成风险与下一步。不要隐藏工具失败。\n\n原始目标：${run.prompt}\n\n初次执行：${specialist}\n\n复核/补强：${verified}`,
                { sourceBusMessageId: recordPipelineDelegation(synthesisSourceId, coordinatorId, "pipeline-synthesis", synthesisAttemptId) },
              )
            : critique;
          run.result = { plan, specialist, critique, verified, final };
        }
      }
      }
      // 协程所有权闸（ask 熔断 flaky 追凶根因）：挂起置位（socialLoop 设 pendingAsk/pausedForInput）
      // 到本收尾之间存在 await 窗口——turn() 每轮开始把 status 写成 waiting_agent，"waiting_agent +
      // pendingAsk" 对在收尾前就可被观测，LO/UI 此刻回答 → resumePendingAsk 同步清 pausedForInput
      // 并接管 controller 键。垂死协程若照旧写终态：①pausedForInput 被清 → 误判自然收敛写
      // succeeded → resume 的 startExecution 撞 execute() 的 TERMINAL 早退 → 回答被吞、run 假成功。
      // 只有仍持有 controller 键的协程才允许写挂起/终态；键已易主则状态交由新协程决定。
      const ownsLifecycle = this.controllers.get(id) === controller;
      if (run.status === "recovery_required") {
        if (ownsLifecycle) await this.save(run).catch(() => {});
      } else if (run.pausedForInput) {
        // v3.6 ask/answer 挂起：队列已空但有未回答的 [[msg:lo]]——run 转为等待输入，
        // LO 的回答经 continue 恢复主循环（不收敛、不判终、不排干）
        if (ownsLifecycle) {
          await this.withProjectionEffect(run, controller, async () => {
            run.status = "waiting_agent";
            await this.save(run);
            await this.emitEvent(run, "run.waiting_input", { from: run.pendingAsk?.from ?? null, text: run.pendingAsk?.text ?? null }, { runId: run.id });
          });
        }
      } else if (ownsLifecycle) {
      // 轮间插话收尾：拓扑走完后仍排队的追问按 FIFO 逐条续跑；每条追问开启独立 interaction，
      // 因此只受自己的自主步骤上限约束，不消耗整场会话额度。
      while ((run.pendingSteer || []).length || run.activeSteer) {
        if (!(await this.injectNextSteer(run))) break;
        run.result = { ...(run.result || {}), continued: run.turns.at(-1)?.text ?? null };
      }
      await this.withProjectionEffect(run, controller, async () => {
        run.status = "succeeded";
        await this.save(run);
        await this.emitEvent(run, "run.completed", { status: run.status, rounds: run.round, sessions: run.sessions }, { runId: run.id });
      });
      }
    } catch (error) {
      // 同类所有权闸：resume/continue 已接管时不写 failed/cancelled 终态（否则新协程撞 TERMINAL
      // 早退、回答/追问被吞）——错误如实进 auditErrors 留痕，run 结果由接管协程呈现
      if (controller.signal.aborted || error.code === "ABORTED") return this.get(id);
      if (this.controllers.get(id) === controller) {
        if (error.failureKind === "budget_exhausted" && run.attention?.type === "budget_exhausted") {
          await this.save(run);
        } else {
          const recoveryBlocked = this.requiresRecovery(run, error);
          run.status = recoveryBlocked
            ? "recovery_required"
            : controller.signal.aborted || error.code === "ABORTED" ? "cancelled" : "failed";
        markPromptTransportFailure(run, error);
        run.failureKind = error.failureKind || null;
        run.error = error.message;
        if (recoveryBlocked) {
          // 分级恢复文案：interrupt 已获 provider 确认时"可能有活跃工作占用会话"不再成立，
          // 如实降级为"确认无活跃占用、可能有部分产出"——否则等于对操作者撒谎式恐吓。
          run.recoveryNote = error.interruptConfirmed === true
            ? `Native turn was confirmed interrupted (${error.code || "TURN_TIMEOUT"}); no live work owns the session. Partial output may exist — inspect the transcript before acknowledging continuation.`
            : `Execution stopped while durable work may still own a native turn (${error.code || "EXECUTION_RECOVERY_REQUIRED"}). Inspect the claimed work before acknowledging recovery.`;
        }
        await this.save(run);
        await this.emitEvent(run, run.status === "recovery_required" ? "run.recovery_required" : "run.failed", {
          status: run.status,
          code: error.code || null,
          message: error.message,
          timeoutKind: error?.timeoutKind || null,
          timeoutMs: Number.isFinite(error?.timeoutMs) ? error.timeoutMs : null,
          idleTimeoutMs: Number.isFinite(error?.idleTimeoutMs) ? error.idleTimeoutMs : null,
          interruptConfirmed: error?.interruptConfirmed === true,
          failureClass: run.failureClass || null,
        }, { runId: run.id });
        }
      } else {
        run.auditErrors = [...(run.auditErrors || []), { type: "execute.superseded", message: error.message, at: new Date().toISOString() }].slice(-20);
        await this.save(run).catch(() => {});
      }
    } finally {
      // 只删自己的 controller：terminal 置位到此处之间新 continue 可能已接管同键（烛 wave2 R5 余波）
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
      // 远程 run 终态处置其专用 adapter（远端进程树随关通道+pgid kill 回收）；
      // waiting_agent/recovery_required 保留——续跑/确认后复用同一只（会话连续性）
      if (run.remote && TERMINAL.has(run.status)) await this.disposeRemoteAdapters(id);
    }
    return this.get(id);
  }

  startExecution(id) {
    if (this.executions.has(id)) return this.executions.get(id);
    const execution = this.execute(id)
      .finally(() => this.executions.delete(id))
      .then(() => this.ensureSteerDrained(id));
    this.executions.set(id, execution);
    return execution;
  }

  // P3 build 隔离：build 会话在执行前为 run 建 git worktree，写盘轮 cwd 指到隔离副本——
  // 真实项目目录不被多 agent 写冲突/半成品污染。限 spawn 型适配器（codex app-server 常驻进程 cwd 固定，如实不适用）。
  async ensureRunWorktree(run) {
    if (run.worktreePath) return (await attestRunWorkspace(run)).path;
    if (run.permissionMode !== "build" || !run.execute || !run.cwd) return null;
    const probe = await execFileAsync("git", ["-C", run.cwd, "rev-parse", "--show-toplevel"], { timeout: 15_000 }).catch((error) => {
      throw Object.assign(new Error(`build 会话需要 git 仓库以隔离工作树，${run.cwd} 不是 git 仓库：${error.message}`), { code: "VALIDATION_FAILED" });
    });
    const repoTop = probe.stdout.trim();
    // 随机后缀防同秒并发 run 撞路径（烛建议5：秒级时间戳不是唯一性保证）
    const stamp = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const worktreePath = join(repoTop, "..", `${basename(repoTop)}-wt-${stamp}`);
    await execFileAsync("git", ["-C", repoTop, "worktree", "add", "--detach", worktreePath], { timeout: 60_000 }).catch((error) => {
      throw Object.assign(new Error(`git worktree add 失败：${String(error.message).slice(0, 200)}`), { code: "VALIDATION_FAILED" });
    });
    run.worktreePath = worktreePath;
    run.worktreeBase = repoTop; // 清理时 git -C <base> worktree remove 用（烛致命10）
    try {
      await attestRunWorkspace(run);
      await this.save(run);
    } catch (error) {
      // save 失败即回滚 worktree（烛建议5）：不留没有台账的孤儿工作树
      await execFileAsync("git", ["-C", repoTop, "worktree", "remove", "--force", worktreePath], { timeout: 60_000 }).catch(() => {});
      run.worktreePath = null;
      run.worktreeBase = null;
      throw error;
    }
    await this.emitEvent(run, "run.worktree_created", { worktree: worktreePath, base: repoTop }, { runId: run.id });
    await this.worktreeLedger?.recordCreated({ path: worktreePath, base: repoTop, runId: run.id, source: "run" }).catch(() => {});
    return worktreePath;
  }

  /** run 清除时的 worktree 回收：git 感知删除 + prune 兜底；失败如实留痕不阻断清除。 */
  async removeRunWorktree(run) {
    if (!run.worktreePath || !run.worktreeBase) return;
    try {
      await execFileAsync("git", ["-C", run.worktreeBase, "worktree", "remove", "--force", run.worktreePath], { timeout: 60_000 });
    } catch {
      await execFileAsync("git", ["-C", run.worktreeBase, "worktree", "prune"], { timeout: 30_000 }).catch(() => {});
    }
    await this.worktreeLedger?.recordRemoved({ path: run.worktreePath }).catch(() => {});
  }

  async claimResumeItem(run) {
    return this.withRunTransition(run.id, async () => {
      const previousQueue = run.resumeQueue;
      const previousClaim = run.resumeClaim || null;
      run.resumeQueue = mergeResumeQueues(run.resumeQueue);
      let item = null;
      if (run.resumeClaim?.itemId) {
        item = run.resumeQueue.find((candidate) => candidate.itemId === run.resumeClaim.itemId) || null;
        if (!item) {
          this.markRecoveryIssue(run, "RESUME_CLAIM_ORPHANED", new Error("resume claim no longer owns a queued item"));
          await this.save(run).catch(() => {});
          throw Object.assign(new Error("resume claim is orphaned"), { code: "RECOVERY_REQUIRED" });
        }
        return item;
      }
      item = run.resumeQueue[0] || null;
      if (!item) return null;
      run.resumeClaim = {
        itemId: item.itemId,
        busMessageId: item.busMessageId || null,
        to: item.to,
        interactionId: item.interactionId || run.activeInteractionId,
        interactionSeq: item.interactionSeq || run.activeInteractionSeq,
        sources: normalizeRunSources(item.sources || run.activeInteractionSources || []),
        claimedAt: new Date().toISOString(),
      };
      try {
        await this.save(run);
      } catch (error) {
        run.resumeQueue = previousQueue;
        run.resumeClaim = previousClaim;
        throw error;
      }
      return item;
    });
  }

  async ackResumeItem(run, item, generatedQueue = []) {
    return this.withRunTransition(run.id, async () => {
      if (run.resumeClaim?.itemId !== item.itemId) {
        throw Object.assign(new Error("resume item acknowledgement lost ownership"), { code: "RESUME_OWNERSHIP_LOST" });
      }
      const previousQueue = [...(run.resumeQueue || [])];
      const previousClaim = run.resumeClaim;
      const remaining = previousQueue.filter((candidate) => candidate.itemId !== item.itemId);
      if (remaining.length === previousQueue.length) {
        throw Object.assign(new Error("resume item is missing from the durable queue"), { code: "RESUME_OWNERSHIP_LOST" });
      }
      const currentInteraction = this.currentInteraction(run);
      const boundGeneratedQueue = generatedQueue.map((candidate) => candidate?.interactionId
        ? candidate
        : { ...candidate, ...currentInteraction });
      run.resumeQueue = mergeResumeQueues(remaining, boundGeneratedQueue);
      run.resumeClaim = null;
      try {
        await this.save(run);
      } catch (error) {
        run.resumeQueue = previousQueue;
        run.resumeClaim = previousClaim;
        throw error;
      }
      return true;
    });
  }

  /**
   * finalize（leader 收敛轮）只在真有多方产出需要综合时才值得烧一轮。
   *
   * 单成员会话里它是纯冗余：同一个 agent 被要求「综合」自己刚说完的那句话，产出一段
     * 「线程已收敛，无后续输入 / 已验证证据：仅初始问候记录」的官腔，还吃掉当前 interaction 的 1 个 step
   * 预算（LO 2026-08-14 报障：只说了「你好」，系统自己派了第 2 轮）。判据用发言者数量——
   * 有第二个 agent 发过言，才存在「需要 leader 综合」的对象。
   */
  socialFinalizationWorthwhile(run) {
    const speakers = new Set((run.turns || []).map((turn) => turn?.agentId).filter(Boolean));
    return speakers.size >= 2;
  }

  async enqueueSocialFinalization(run, coordinatorId) {
    return this.withRunTransition(run.id, async () => {
      const existing = run.resumeClaim?.itemId
        ? (run.resumeQueue || []).find((item) => item.itemId === run.resumeClaim.itemId && item.kind === "finalize")
        : (run.resumeQueue || []).find((item) => item.kind === "finalize");
      if (existing) return existing;
      const priorAttemptId = run.turnAttempts?.at(-1)?.attemptId || "initial";
      const item = {
        itemId: operationMessageId("work", JSON.stringify({ runId: run.id, kind: "finalize", priorAttemptId })),
        to: coordinatorId,
        kind: "finalize",
        ...this.currentInteraction(run),
      };
      const previousQueue = run.resumeQueue;
      run.resumeQueue = mergeResumeQueues(run.resumeQueue, [item]);
      try {
        await this.save(run);
      } catch (error) {
        run.resumeQueue = previousQueue;
        throw error;
      }
      return item;
    });
  }

  async processSocialFinalization(run, controller, item, { coordinatorId, teamContext }) {
    if (!item || item.kind !== "finalize" || item.to !== coordinatorId) {
      throw Object.assign(new Error("social finalization work item is invalid"), { code: "RECOVERY_REQUIRED" });
    }
    const snapshot = this.bus.snapshot(await this.bus.read(run.id), { forAgent: coordinatorId });
    const final = await this.turn(
      run,
      coordinatorId,
      `${teamContext}你是团队 leader「${coordinatorId}」。团队对话已收敛，请基于以下线程输出最终答复：结论、已验证证据、未完成风险与下一步。不要隐藏工具失败。\n\n线程快照：\n${snapshot}`,
      { sourceWorkItemId: item.itemId },
    );
    await this.withProjectionEffect(run, controller, async () => {
      await this.appendBus(run, {
        id: operationMessageId("decision", item.itemId),
        from: coordinatorId,
        to: "lo",
        kind: "decide",
        text: final,
      });
      run.result = { mode: "social", final, bus: this.bus.file(run.id), worktree: run.worktreePath ?? null };
      // The ack save is the durable commit for both the final result and work ownership. If
      // shutdown aborts the projection postcheck immediately afterwards, restart still sees a
      // truthful terminal result instead of a queue-less waiting_agent with no execution owner.
      run.status = "succeeded";
      await this.ackResumeItem(run, item);
    });
    return final;
  }

  // ===== v3.6 社会模拟编排：消息驱动主循环 =====
  // bus.jsonl 是唯一真相：任务/各轮输出全落 bus，turn 上下文从 bus 有界快照编织（不再由主脑人肉转述）。
  // agent 用 [[msg:目标]] 发起对话；同对往返>2 轮转 leader 收敛（防互问死循环）；非强制沟通——
  // 没被点名可以不发言，leader 默认拆解任务但不再是唯一入口（startAgentId 可选）。
  async socialLoop(run, controller) {
    const coordinatorId = run.coordinatorId || "claude-fable";
    const members = (run.teamMembers ?? []).length ? run.teamMembers : [coordinatorId];
    const startAgentId = run.startAgentId && members.includes(run.startAgentId) ? run.startAgentId : coordinatorId;
    const teamContext = run.teamBrief ? `${run.teamBrief}\n\n` : "";
    const rosterLine = members.map((member) => `- ${member}`).join("\n");
    // worktree 隔离已统一在 execute() 入口（social/pipeline 同一道闸，烛致命8）
    // 恢复队列是 durable work ledger：队首在 provider 前 claim，但直到输出、路由和 ask
    // 投影全部持久化后才 ack。崩溃时项目仍留在 run JSON，禁止 splice(0) 先清空所有权。
    if (!run.resumeClaim && !(run.resumeQueue || []).length) {
      await this.withRunTransition(run.id, async () => {
        if (run.resumeClaim || (run.resumeQueue || []).length) return;
        run.resumeQueue = mergeResumeQueues([{
          to: startAgentId,
          busMessageId: operationMessageId("task", run.id),
          kind: "task",
          ...this.currentInteraction(run),
        }]);
        await this.save(run);
      });
    }
    const pingPong = new Map(); // "from>to" → 已路由次数
    let guard = 0;
    let finalizationCompleted = false;
    let budgetStopped = false;
    const guardLimit = Math.max(4, this.maxStepsForInteraction(run) * 2); // turn() step 闸之外的循环保险
    const hasWork = () => Boolean(run.resumeClaim || (run.resumeQueue || []).length);
    while (hasWork() && !controller.signal.aborted) {
      const ownedWork = run.resumeClaim?.itemId
        ? (run.resumeQueue || []).find((item) => item?.itemId === run.resumeClaim.itemId)
        : (run.resumeQueue || [])[0];
      if (ownedWork?.interactionId) {
        this.activateInteraction(run, ownedWork, { adoptDurableWork: false });
      }
      const preparedClaim = run.resumeClaim?.itemId
        ? (run.turnAttempts || []).some((attempt) =>
            attempt.sourceWorkItemId === run.resumeClaim.itemId && attempt.phase === "prepared")
        : false;
      if (guard++ >= guardLimit || (this.interactionLimitReached(run) && !preparedClaim)) break;
      if (this.budgetExhausted(run)) {
        // 当前交互的已知成本回执超硬顶即停派。队列保留，下一条用户消息会开启新交互预算。
        await this.withProjectionEffect(run, controller, async () => {
          await this.appendBus(run, { from: "system", to: coordinatorId, kind: "system", text: `本次交互已知成本 ${Number(run.interactionCostUsd || 0).toFixed(4)} USD 已达硬顶，暂停自主派发；下一条用户消息可继续` });
          await this.save(run);
          await this.emitEvent(run, "run.budget_exhausted", {
            interactionId: run.activeInteractionId,
            interactionSeq: run.activeInteractionSeq,
            interactionCostUsd: run.interactionCostUsd || 0,
          }, { runId: run.id });
        });
        budgetStopped = true;
        break;
      }
      const next = await this.claimResumeItem(run);
      if (!next) break;
      if (!members.includes(next.to)) {
        this.markRecoveryIssue(run, "RESUME_TARGET_NOT_TEAM_MEMBER", new Error(`durable work target is outside the persisted team: ${next.to}`));
        await this.save(run).catch(() => {});
        throw Object.assign(new Error(`durable work target is outside the persisted team: ${next.to}`), { code: "RECOVERY_REQUIRED" });
      }
      if (next.kind === "finalize") {
        await this.processSocialFinalization(run, controller, next, { coordinatorId, teamContext });
        finalizationCompleted = true;
        await this.injectNextSteer(run);
        continue;
      }
      if (next.kind === "task") {
        await this.withProjectionEffect(run, controller, async () => {
          run.pausedForInput = false;
          const existingTask = (await this.bus.read(run.id)).find((message) =>
            message.kind === "task"
            && message.from === "lo"
            && message.to === next.to
            && message.text === run.prompt);
          if (!existingTask) {
            await this.appendBus(run, {
              id: next.busMessageId || operationMessageId("task", run.id),
              from: "lo",
              to: next.to,
              kind: "task",
              text: run.prompt,
            });
          }
          if (!run.initialTaskProjectedAt) {
            await this.emitEvent(run, "user.message", { text: run.prompt }, { runId: run.id, agentId: "LO" });
            run.initialTaskProjectedAt = new Date().toISOString();
            await this.save(run);
          }
        });
      }
      const snapshot = this.bus.snapshot(await this.bus.read(run.id), { forAgent: next.to });
      const prompt = `${teamContext}你是 514cc 团队成员「${next.to}」，正在参与一次团队对话（社会模拟编排）。
团队名录（可对任意成员发起对话）：
${rosterLine}
对话规则：
- 需要谁回答，另起一行写 [[msg:目标]]，内容随其后；对全员说话写 [[msg:team]]；需要用户拍板写 [[msg:lo]]。
- 有值得所有后续成员共享的事实/结论/坑，写 [[memo]] 内容（全员黑板，后续轮自动可见）。
- 指令以外的正文视为发给 team；没被点名可以不发言，只输出有价值的部分。
- 你只按既有权限行动，禁止声称已写入、已部署或未验证的完成；证据优先。
对话快照（bus 有界尾部）：
      ${snapshot}`;
      const writeGrant = this.continuationWriteGrant(run, next.to);
      await this.emitWriteDegraded(run, next.to, writeGrant.reason);
      const text = await this.turn(run, next.to, prompt, {
        allowWorkspaceWrite: writeGrant.allow,
        cwd: writeGrant.allow && run.worktreePath ? run.worktreePath : null,
        sourceWorkItemId: next.itemId || null,
        sourceBusMessageId: next.busMessageId || null,
      });
      let askRaised = false;
      await this.withProjectionEffect(run, controller, async () => {
        await this.registerRoster(run, next.to);
        const sourceAttemptId = run.turns.at(-1)?.id || null;
        const { cleaned, directives } = parseDirectives(text);
        const body = cleaned || (directives.length ? "" : text);
        if (body) await this.appendBus(run, { from: next.to, to: "team", kind: "say", text: body });
        let loDirectiveSeen = false;
        const generatedQueue = [];
        for (const directive of directives) {
        if (directive.to === "memo") {
          // P3 共享黑板：[[memo]] 写入全员可见的运行记忆（快照治理类恒入选，成员间认知互补）
          await this.appendBus(run, { from: next.to, to: "team", kind: "memo", text: directive.text });
          await this.emitEvent(run, "bus.routed", { from: next.to, to: "memo", text: directive.text.slice(0, 140) }, { runId: run.id, agentId: next.to });
          continue;
        }
        if (directive.to === "lo") {
          if (loDirectiveSeen) {
            await this.emitEvent(run, "run.directive_rejected", {
              from: next.to,
              to: "lo",
              reason: "MULTIPLE_LO_ASKS",
            }, { runId: run.id, agentId: next.to });
            continue;
          }
          loDirectiveSeen = true;
          const askMessage = await this.appendBus(run, {
            from: next.to,
            to: "lo",
            kind: "ask",
            text: directive.text,
            refs: sourceAttemptId ? { sourceAttemptId } : null,
          });
          // ask/answer 挂起语义：ask 是硬状态转换，本次 interaction 停止自主派发；LO 的回答
          // 会开启新 interaction，因此回答次数不受整场会话累计轮数限制。
          run.pendingAsk = { id: askMessage.id, from: next.to, text: directive.text, at: askMessage.ts };
          askRaised = true;
          await this.emitEvent(run, "bus.routed", { from: next.to, to: "lo", text: directive.text.slice(0, 140) }, { runId: run.id, agentId: next.to });
          continue;
        }
        let routeDisposition = "broadcast";
        let hops = null;
        let delegationContext = null;
        let depthLimitReached = false;
        if (directive.to !== "team") {
          if (!members.includes(directive.to)) {
            routeDisposition = "dropped";
          } else {
            const pairKey = `${next.to}>${directive.to}`;
            hops = (pingPong.get(pairKey) ?? 0) + 1;
            pingPong.set(pairKey, hops);
            delegationContext = this.#delegationContext(run, sourceAttemptId);
            const decision = classifyAgentRoute({
              to: directive.to,
              hops,
              depth: delegationContext.depth,
              contract: socialContractOf(run),
            });
            depthLimitReached = decision.reason === "DELEGATION_DEPTH_LIMIT";
            routeDisposition = decision.disposition === "queued" ? "queued" : "dropped";
          }
        }
        const routedMessage = await this.appendBus(run, {
          from: next.to,
          to: directive.to,
          kind: "say",
          text: directive.text,
          refs: {
            ...(sourceAttemptId ? { sourceAttemptId } : {}),
            routeDisposition,
            ...(delegationContext ? {
              delegationDepth: delegationContext.depth,
              delegationDepthLimit: Math.max(1, Math.min(8, Number(run.delegationDepthLimit) || 4)),
              ...(depthLimitReached ? { rejectionReason: "DELEGATION_DEPTH_LIMIT" } : {}),
            } : {}),
          },
        });
        await this.emitEvent(run, "bus.routed", {
          from: next.to,
          to: directive.to,
          text: directive.text.slice(0, 140),
          disposition: routeDisposition,
        }, { runId: run.id, agentId: next.to });
        if (directive.to === "team") continue; // team 广播成员在快照自取
        if (routeDisposition === "dropped") {
          if (depthLimitReached) {
            this.recordTaskGraphDelegation(run, {
              fromAgentId: next.to,
              toAgentId: directive.to,
              busMessageId: routedMessage.id,
              kind: "route",
              state: "rejected",
              attemptId: sourceAttemptId,
            });
            await this.appendBus(run, {
              from: "system",
              to: coordinatorId,
              kind: "system",
              text: `${next.to} → ${directive.to} 达到委派深度上限 ${Math.max(1, Math.min(8, Number(run.delegationDepthLimit) || 4))}，本条路由已拒绝`,
            });
          }
          if (members.includes(directive.to) && hops > Number(socialContractOf(run).pingPongLimit || 2)) {
          // 同对往返超限：指令丢弃 + 系统注记（不补队——否则 leader 的同类输出会自我续队）
            await this.appendBus(run, { from: "system", to: coordinatorId, kind: "system", text: `${next.to} 与 ${directive.to} 的往返已超 ${socialContractOf(run).pingPongLimit || 2} 轮，本条路由被丢弃，移交 leader 收敛` });
          }
          continue;
        }
        const delegation = this.recordTaskGraphDelegation(run, {
          fromAgentId: next.to,
          toAgentId: directive.to,
          busMessageId: routedMessage.id,
          kind: "route",
          state: "queued",
          attemptId: sourceAttemptId,
        });
        if (delegation?.depthLimitReached) continue;
        generatedQueue.push({
          to: directive.to,
          busMessageId: routedMessage.id,
          sourceAttemptId,
          kind: "route",
          ...this.currentInteraction(run),
        });
        }
        await this.ackResumeItem(run, next, generatedQueue);
      });
      // Persist every bus projection of the provider response before consuming
      // a continuation that arrived while that provider turn was in flight.
      // If the response raised an ask, ownership stays with the ask/answer path. Only an
      // explicitly legacy/untargeted queued continuation may be promoted by execute().
      if (!askRaised) await this.injectNextSteer(run);
      if (askRaised) {
        break; // 队列剩余项持久冻结；LO 回答后连同 asker 一起复跑
      }
    }
    if (finalizationCompleted) return;
    if (budgetStopped) {
      run.result = {
        mode: "social",
        final: run.turns.at(-1)?.text ?? null,
        bus: this.bus.file(run.id),
        worktree: run.worktreePath ?? null,
        truncated: true,
        reason: "budget_exhausted",
      };
      return;
    }
    // 挂起优先于收敛：有未回答的 [[msg:lo]] → 等 LO 回答（execute 收尾转 waiting_agent，continue 恢复）。
    // ask 等待的是下一条用户交互；当前 step 用尽不能清掉它，否则用户永远失去回答入口。
    if (run.pendingAsk && !controller.signal.aborted) {
      await this.withProjectionEffect(run, controller, async () => {
        run.pausedForInput = true;
        await this.save(run);
      });
      return;
    }
    run.pausedForInput = false;
    // 自然收敛后将 leader 最终答复先登记为 durable work；prepared checkpoint 可安全复跑，
    // submitted/ambiguous/completed-but-unacked 则由重启门 fail closed，避免无 owner 永久停车。
    if (!controller.signal.aborted && !this.interactionLimitReached(run) && this.socialFinalizationWorthwhile(run)) {
      await this.enqueueSocialFinalization(run, coordinatorId);
      const finalization = await this.claimResumeItem(run);
      await this.processSocialFinalization(run, controller, finalization, { coordinatorId, teamContext });
      await this.injectNextSteer(run);
    } else {
      // truncated 只在真被本次交互的自主步骤上限截断时标记：跳过冗余 finalize 是正常收敛，谎报截断
      // 会让 UI 显示「结果不完整」并诱导 LO 白续一轮
      run.result = {
        mode: "social",
        final: run.turns.at(-1)?.text ?? null,
        bus: this.bus.file(run.id),
        worktree: run.worktreePath ?? null,
        ...(this.interactionLimitReached(run) ? { truncated: true, reason: "interaction_step_limit" } : {}),
      };
    }
  }

  // 运行时 roster：seats 是并发真相（runId + memberId），agents 仅保留最新席位兼容投影。
  async registerRoster(run, agentId) {
    const file = join(this.dataRoot, "roster.json");
    const seatId = `${run.id}:${agentId}`;
    const entry = {
      seatId,
      memberId: agentId,
      agentId,
      sessionId: run.sessions[agentId] ?? null,
      runId: run.id,
      teamId: run.teamId ?? null,
      cwd: run.cwd ?? null,
      status: run.status,
      lastSeenAt: new Date().toISOString(),
    };
    this.rosterChain = this.rosterChain
      .then(async () => {
        let roster = { agents: {}, seats: {} };
        try {
          roster = JSON.parse(await readFile(file, "utf8"));
        } catch {
          // 首写/坏文件：从空开始
        }
        roster.agents ||= {};
        roster.seats ||= {};
        roster.seats[seatId] = entry;
        roster.agents[agentId] = entry;
        await mkdir(this.dataRoot, { recursive: true });
        await writeFile(file, `${JSON.stringify(roster, null, 2)}\n`, "utf8");
      })
      .catch(() => {}); // roster 是辅助资产，写失败不打断编排
    await this.rosterChain;
  }

  /** run 清除时的 roster 回收（烛致命10）：runId 归属的条目一并移除。 */
  async removeRosterEntries(runId) {
    const file = join(this.dataRoot, "roster.json");
    this.rosterChain = this.rosterChain
      .then(async () => {
        let roster;
        try {
          roster = JSON.parse(await readFile(file, "utf8"));
        } catch {
          return; // 无 roster 文件即无事可清
        }
        const agents = roster?.agents ?? {};
        const seats = roster?.seats ?? {};
        let dirty = false;
        for (const [seatId, entry] of Object.entries(seats)) {
          if (entry?.runId === runId) {
            delete seats[seatId];
            dirty = true;
          }
        }
        for (const [agentId, entry] of Object.entries(agents)) {
          if (entry?.runId === runId) {
            const replacement = Object.values(seats)
              .filter((seat) => (seat?.memberId || seat?.agentId) === agentId)
              .sort((left, right) => Date.parse(right?.lastSeenAt || 0) - Date.parse(left?.lastSeenAt || 0))[0];
            if (replacement) agents[agentId] = replacement;
            else delete agents[agentId];
            dirty = true;
          }
        }
        if (dirty) await writeFile(file, `${JSON.stringify(roster, null, 2)}\n`, "utf8");
      })
      .catch(() => {});
    await this.rosterChain;
  }

  // 收尾窗口兜底：terminal 置位与 controller/executions 释放之间排入的插话没有活跃消费者，
  // 协程链彻底结束后补启后台 drain——排队项最多滞留一瞬，绝不静默丢失。队列空/run 已清除时 no-op。
  ensureSteerDrained(id) {
    if (this.closing || this.interruptingRuns.has(id)) return; // 关闭/显式中断中不重启任何排干
    const run = this.runs.get(id);
    if (!run || this.clearedRuns.has(id)) return;
    if (this.executions.has(id)) return; // 已有 execute/drain 在消费——再建 controller 只会覆盖占位（烛 R6）
    if (!(run.pendingSteer || []).length && !run.activeSteer) return;
    // 仅 succeeded 补收：cancelled/failed 的留队是取消/失败语义的如实呈现，重启消费违背用户意图（烛 R6）
    if (run.status !== "succeeded") return;
    const controller = new AbortController();
    this.controllers.set(id, controller); // cancel(id) 仍可中止补启的排干
    this.startSteerDrain(id, controller);
  }

  /**
   * 放弃可疑轮的唯一收口。两条恢复确认路径（queueSteer 排队 / continue 直发）语义必须完全一致——
   * 各写一份的结果就是漂移：注记文案不同、`inflightTurns` 只有排队那条清（同一个坑修了一半，
   * 直发路径照旧卡在"正在准备会话"）。改动请只改这里。
   *
   * 调用方负责：先快照 abandonmentSnapshot(run)，save 失败时 restoreAbandonment 回滚。
   */
  acknowledgeAbandonedWork(run) {
    const resumeItemId = run.resumeClaim?.itemId || null;
    const steerId = run.activeSteer?.steerId || null;
    if (resumeItemId) run.resumeQueue = (run.resumeQueue || []).filter((item) => item?.itemId !== resumeItemId);
    if (steerId) run.pendingSteer = (run.pendingSteer || []).filter((item) => item?.id !== steerId);
    run.resumeClaim = null;
    run.activeSteer = null;
    // inflight 记账必须一并作废：否则该成员永远显示"正在准备会话"，新消息被当成排队而发不出去，
    // 确认恢复按钮等于无效（LO 2026-08-08：余额恢复后既不能发送也不能恢复）。
    run.inflightTurns = {};
    run.recoveryAcknowledgedAt = new Date().toISOString();
    run.recoveryNote = "Operator acknowledged and abandoned the claimed work before continuing.";
    return this.refundAbandonedRound(run);
  }

  /**
   * 只有机械证明未被 provider 接受的轮次才可退：prepared/session_ready 尚未提交 prompt，
   * rejected 是 turn/start 的窄白名单准入拒绝。submitting/submitted/ambiguous 都可能已经
   * 到达 provider，退还会允许超过当前 interaction 的自主步骤上限。
   * 注意：函数名沿历史叫 "Round"，实际退的是当前 interaction 的 interactionStep；round 是
   * 全会话单调审计序号，永不回退。
   */
  refundableAbandonedAttempt(run) {
    this.ensureInteractionState(run);
    const refunded = Math.max(0, Math.trunc(Number(run.interactionStepsRefunded) || 0));
    const cap = this.maxStepsForInteraction(run);
    const round = Math.max(0, Math.trunc(Number(run.round) || 0));
    const interactionStep = Math.max(0, Math.trunc(Number(run.interactionStep) || 0));
    if (refunded >= cap || round === 0 || interactionStep === 0) return null;
    const attempt = (run.turnAttempts || []).at(-1);
    if (!attempt || Number(attempt.round) !== round) return null;
    if (attempt.interactionId && attempt.interactionId !== run.activeInteractionId) return null;
    if ((run.refundedAttemptIds || []).includes(attempt.attemptId)) return null;
    if (!["prepared", "session_ready", "rejected"].includes(attempt.phase)) return null;
    return { attempt, refunded, round, interactionStep };
  }

  canRefundAbandonedRound(run) {
    return Boolean(this.refundableAbandonedAttempt(run));
  }

  refundAbandonedRound(run) {
    const candidate = this.refundableAbandonedAttempt(run);
    if (!candidate) return null;
    const { attempt, refunded, round, interactionStep } = candidate;
    run.interactionStep = interactionStep - 1;
    run.interactionStepsRefunded = refunded + 1;
    run.roundsRefunded = Math.max(0, Math.trunc(Number(run.roundsRefunded) || 0)) + 1;
    run.refundedAttemptIds = [...new Set([...(run.refundedAttemptIds || []), attempt.attemptId])].slice(-200);
    return {
      round,
      interactionId: run.activeInteractionId,
      interactionSeq: run.activeInteractionSeq,
      interactionStep: run.interactionStep,
      interactionStepsRefunded: run.interactionStepsRefunded,
      roundsRefunded: run.roundsRefunded,
      attemptId: attempt.attemptId,
      phase: attempt.phase,
    };
  }

  /** 恢复确认涉及的全部字段快照——save 失败必须整体回滚，不能留半套状态。 */
  abandonmentSnapshot(run) {
    return {
      resumeQueue: [...(run.resumeQueue || [])],
      pendingSteer: [...(run.pendingSteer || [])],
      resumeClaim: run.resumeClaim || null,
      activeSteer: run.activeSteer || null,
      inflightTurns: { ...(run.inflightTurns || {}) },
      round: run.round,
      roundsRefunded: run.roundsRefunded,
      interactionStep: run.interactionStep,
      interactionStepsRefunded: run.interactionStepsRefunded,
      interactionContextCompactions: run.interactionContextCompactions,
      refundedAttemptIds: [...(run.refundedAttemptIds || [])],
      recoveryAcknowledgedAt: run.recoveryAcknowledgedAt,
      recoveryNote: run.recoveryNote,
      // ensureInteractionState 在退款路径会把 activeInteraction 同步进私有 ledger；快照必须一并覆盖，
      // 否则 save 失败回滚后 interactionStates 残留半套同步（拆账引入的缺口，见 round-refund-contract）。
      // 保留 undefined 语义：|| {} 会把"无 ledger"伪造成空对象，回滚后仍与放弃前不一致。
      interactionStates: run.interactionStates == null ? undefined : structuredClone(run.interactionStates),
    };
  }

  restoreAbandonment(run, snapshot) {
    if (!snapshot) return;
    Object.assign(run, snapshot);
  }

  async queueSteer(run, {
    prompt,
    agentId,
    sources = [],
    answerCandidate = false,
    admissionEpoch = null,
    acknowledgeRecovery = false,
  }) {
    const queued = {
      id: randomUUID(),
      prompt,
      agentId,
      queuedAt: new Date().toISOString(),
      ...(answerCandidate ? { answerCandidate: true } : {}),
    };
    let refund = null;
    await withManagedClipboardSourceRegistration({
      dataRoot: this.dataRoot,
      sources,
      operation: () => this.withRunTransition(run.id, async () => {
        if (admissionEpoch != null) this.assertContinuationAdmission(run.id, admissionEpoch);
        const previousInteraction = this.interactionSnapshot(run);
        const preparedSources = this.prepareInteractionSources(run, sources);
        Object.assign(queued, this.allocateInteraction(run), { sources: preparedSources.sources });
        const previousRecovery = acknowledgeRecovery ? this.abandonmentSnapshot(run) : null;
        if (run.status === "recovery_required" && acknowledgeRecovery) {
          refund = this.acknowledgeAbandonedWork(run);
        }
        run.pendingSteer ||= [];
        run.pendingSteer.push(queued);
        try {
          await this.save(run);
          await this.emitEvent(run, "run.steer_queued", {
            text: prompt,
            agentId,
            depth: run.pendingSteer.length,
            interactionId: queued.interactionId,
            interactionSeq: queued.interactionSeq,
          }, { runId: run.id, agentId: "LO" });
        } catch (error) {
          const ownedIndex = run.pendingSteer.findIndex((item) => item?.id === queued.id);
          if (ownedIndex >= 0) run.pendingSteer.splice(ownedIndex, 1);
          this.restoreAbandonment(run, previousRecovery);
          this.restoreInteraction(run, previousInteraction);
          this.restorePreparedInteractionSources(run, preparedSources.previous);
          refund = null;
          throw error;
        }
      }),
    });
    // 退还只在落盘成功后才播报，避免回滚过的账目出现在会话流里
    if (refund) await this.emitRoundRefund(run, refund);
    return queued;
  }

  /** 轮次退还的审计与可见性：不落事件就等于悄悄改配额，人看不见也审计不到。 */
  async emitRoundRefund(run, refund) {
    await this.emitEvent(run, "run.round_refunded", {
      round: refund.round,
      interactionId: refund.interactionId,
      interactionSeq: refund.interactionSeq,
      interactionStep: refund.interactionStep,
      maxStepsPerInteraction: this.maxStepsForInteraction(run),
      interactionStepsRefunded: refund.interactionStepsRefunded,
      roundsRefunded: refund.roundsRefunded,
      attemptId: refund.attemptId,
      phase: refund.phase,
    }, { runId: run.id });
  }

  // Provider 在途时，旧客户端可能在 ask 尚未出现前发送无定向 continuation。只有这种
  // answerCandidate 可以升级；先把 answer 追加到 durable bus，成功后才转移 pendingAsk/queue 所有权。
  async promoteQueuedAnswer(run) {
    await this.ensureStablePendingAsk(run);
    const ask = run.pendingAsk;
    if (!ask) return false;
    const candidateIndex = (run.pendingSteer || []).findIndex((item) => item?.answerCandidate === true);
    if (candidateIndex < 0) return false;
    if (this.askClaims.has(run.id)) return false;
    const candidate = run.pendingSteer[candidateIndex];
    const claimId = ask.id;
    this.askClaims.set(run.id, claimId);
    try {
      const answerMessage = await this.appendBus(run, {
        id: operationMessageId("answer", ask.id),
        from: "lo",
        to: ask.from,
        kind: "answer",
        text: candidate.prompt,
        refs: { answerToAskId: ask.id, queuedSteerId: candidate.id },
      });
      await this.withRunTransition(run.id, async () => {
        if (run.pendingAsk?.id !== ask.id) {
          throw Object.assign(new Error("the pending ask changed before the queued answer committed"), { code: "ASK_MISMATCH" });
        }
        const liveIndex = (run.pendingSteer || []).findIndex((item) => item?.id === candidate.id);
        if (liveIndex < 0) {
          throw Object.assign(new Error("the queued answer no longer owns its pending steer"), { code: "ANSWER_OWNERSHIP_LOST" });
        }
        const previous = {
          pendingAsk: run.pendingAsk,
          pausedForInput: run.pausedForInput,
          resumeQueue: [...(run.resumeQueue || [])],
          interaction: this.interactionSnapshot(run),
        };
        run.pendingSteer.splice(liveIndex, 1);
        run.pendingAsk = null;
        run.pausedForInput = false;
        run.resumeQueue = mergeResumeQueues(
          [{
            to: ask.from,
            busMessageId: answerMessage.id,
            kind: "answer",
            interactionId: candidate.interactionId,
            interactionSeq: candidate.interactionSeq,
            sources: candidate.sources,
          }],
          run.resumeQueue,
        );
        if (!candidate.interactionId) Object.assign(candidate, this.allocateInteraction(run));
        this.activateInteraction(run, candidate);
        try {
          await this.save(run);
        } catch (error) {
          if (!(run.pendingSteer || []).some((item) => item?.id === candidate.id)) {
            run.pendingSteer.splice(Math.min(liveIndex, run.pendingSteer.length), 0, candidate);
          }
          run.pendingAsk = previous.pendingAsk;
          run.pausedForInput = previous.pausedForInput;
          run.resumeQueue = previous.resumeQueue;
          this.restoreInteraction(run, previous.interaction);
          throw error;
        }
      });
      await this.emitEvent(run, "user.message", { text: candidate.prompt }, { runId: run.id, agentId: "LO" });
      return true;
    } catch (error) {
      run.auditErrors = [...(run.auditErrors || []), {
        type: "answer.promotion_deferred",
        message: error.message,
        at: new Date().toISOString(),
      }].slice(-20);
      if (error.code === "BUS_MESSAGE_CONFLICT") {
        await this.withRunTransition(run.id, async () => {
          this.markRecoveryIssue(run, "ANSWER_MESSAGE_CONFLICT", error);
          await this.save(run).catch(() => {});
        });
      }
      await this.emitEvent(run, "run.answer_deferred", {
        code: error.code || null,
        message: error.message,
      }, { runId: run.id, agentId: "LO" });
      return false;
    } finally {
      if (this.askClaims.get(run.id) === claimId) this.askClaims.delete(run.id);
    }
  }

  // 取最早一条排队追问注入为下一次用户交互：先发 user.message，再走既有 turn 路径。
  // 只在 turn 边界被调用（execute 轮间 / 排干 driver），绝不打断进行中的子进程。
  // 每条排队消息在入队时已分配 interactionId，激活时获得独立 step/cost/ask 预算。
  async injectNextSteer(run) {
    const controller = this.controllers.get(run.id);
    if (controller) this.assertLifecycleOwner(run, controller);
    const project = (operation) => controller
      ? this.withProjectionEffect(run, controller, operation)
      : operation();
    const steer = run.activeSteer?.steerId
      ? (run.pendingSteer || []).find((item) => item?.id === run.activeSteer.steerId)
      : (run.pendingSteer || [])[0];
    if (!steer) {
      if (run.activeSteer) {
        this.markRecoveryIssue(run, "STEER_CLAIM_ORPHANED", new Error("active steer no longer owns a queued item"));
        await this.save(run).catch(() => {});
        throw Object.assign(new Error("active steer claim is orphaned"), { code: "RECOVERY_REQUIRED" });
      }
      return true;
    }
    const targetAgentId = steer.agentId || run.coordinatorId || "claude-fable";
    let steerMessage = null;
    await project(async () => {
      if (run.orchestrationMode === "social") {
        steerMessage = await this.appendBus(run, {
          id: operationMessageId("steer", steer.id),
          from: "lo",
          to: targetAgentId,
          kind: "steer",
          text: steer.prompt,
          refs: steer.id ? { queuedSteerId: steer.id } : null,
        });
      }
      await this.withRunTransition(run.id, async () => {
        const liveIndex = (run.pendingSteer || []).findIndex((item) => item?.id === steer.id);
        if (liveIndex < 0) {
          throw Object.assign(new Error("the queued steer no longer owns its pending entry"), { code: "STEER_OWNERSHIP_LOST" });
        }
        if (run.activeSteer && run.activeSteer.steerId !== steer.id) {
          throw Object.assign(new Error("another queued steer already owns the active claim"), { code: "STEER_OWNERSHIP_LOST" });
        }
        const previousActive = run.activeSteer || null;
        const previousInteraction = this.interactionSnapshot(run);
        if (!steer.interactionId) Object.assign(steer, this.allocateInteraction(run));
        run.activeSteer ||= {
          steerId: steer.id,
          busMessageId: steerMessage?.id || null,
          to: targetAgentId,
          interactionId: steer.interactionId,
          interactionSeq: steer.interactionSeq,
          claimedAt: new Date().toISOString(),
        };
        // 插话只拥有自己的 turn；旧 pipeline/social durable work 保留原 interaction 与附件。
        this.activateInteraction(run, steer, { adoptDurableWork: false });
        try {
          await this.save(run);
        } catch (error) {
          run.activeSteer = previousActive;
          this.restoreInteraction(run, previousInteraction);
          throw error;
        }
      });
      await this.emitEvent(run, "user.message", {
        text: steer.prompt,
        interactionId: steer.interactionId,
        interactionSeq: steer.interactionSeq,
      }, { runId: run.id, agentId: "LO" });
    });
    // 排队插话与 socialLoop 派轮同权：批过的授权在续轮继续有效，缺失则降级只读并播报
    const writeGrant = this.continuationWriteGrant(run, targetAgentId);
    await this.emitWriteDegraded(run, targetAgentId, writeGrant.reason);
    const response = await this.turn(run, targetAgentId, steer.prompt, {
      allowWorkspaceWrite: writeGrant.allow,
      cwd: writeGrant.allow && run.worktreePath ? run.worktreePath : null,
      sourceWorkItemId: steer.id,
      sourceBusMessageId: steerMessage?.id || run.activeSteer?.busMessageId || null,
      nativeCommand: steer.nativeCommand === true,
    });
    await project(async () => {
      // 空回复不进 bus：空气泡既骗人（看着像回答了）又污染后续轮的对话快照。无产出本身
      // 已由 turn() 的 agent.turn_unproductive 如实播报，这里只是不再伪造一条“发言”。
      if (run.orchestrationMode === "social" && String(response ?? "").trim()) {
        await this.appendBus(run, {
          id: operationMessageId("steer-reply", steer.id),
          from: targetAgentId,
          to: "lo",
          kind: "say",
          text: response,
          refs: { queuedSteerId: steer.id },
        });
      }
      await this.withRunTransition(run.id, async () => {
        if (run.activeSteer?.steerId !== steer.id) {
          throw Object.assign(new Error("queued steer acknowledgement lost ownership"), { code: "STEER_OWNERSHIP_LOST" });
        }
        const liveIndex = (run.pendingSteer || []).findIndex((item) => item?.id === steer.id);
        if (liveIndex < 0) {
          throw Object.assign(new Error("queued steer disappeared before acknowledgement"), { code: "STEER_OWNERSHIP_LOST" });
        }
        const previousActive = run.activeSteer;
        run.pendingSteer.splice(liveIndex, 1);
        run.activeSteer = null;
        try {
          await this.save(run);
        } catch (error) {
          run.pendingSteer.splice(Math.min(liveIndex, run.pendingSteer.length), 0, steer);
          run.activeSteer = previousActive;
          throw error;
        }
      });
    });
    return true;
  }

  // 排干 driver 主体（与 execute 同构：内部自捕获，不向调用方抛错）；失败如实落 failed + run.failed 事件
  async drainSteer(id, controller) {
    const run = this.get(id);
    try {
      while (((run.pendingSteer || []).length || run.activeSteer) && !controller.signal.aborted) {
        if (!(await this.injectNextSteer(run))) break;
        await this.withProjectionEffect(run, controller, async () => {
          run.status = "succeeded";
          run.result = { ...(run.result || {}), continued: run.turns.at(-1)?.text ?? null };
          await this.save(run);
        });
      }
    } catch (error) {
      if (controller.signal.aborted || error.code === "ABORTED" || error.code === "RUN_CANCELLED") return;
      if (error.failureKind === "budget_exhausted" && run.attention?.type === "budget_exhausted") {
        await this.save(run);
        return;
      }
      const recoveryBlocked = this.requiresRecovery(run, error);
      run.status = recoveryBlocked
        ? "recovery_required"
        : controller.signal.aborted ? "cancelled" : "failed";
      run.failureKind = error.failureKind || null;
      run.error = error.message;
      if (recoveryBlocked) {
        run.recoveryNote = `Queued continuation stopped while its durable claim may own a native turn (${error.code || "STEER_RECOVERY_REQUIRED"}). Inspect the claimed work before acknowledging recovery.`;
      }
      await this.save(run);
      await this.emitEvent(run, run.status === "recovery_required" ? "run.recovery_required" : "run.failed", {
        status: run.status,
        code: error.code || null,
        message: error.message,
      }, { runId: id });
    } finally {
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
    }
  }

  // 轮间插话排干：接管续聊的 controller，按 FIFO 把排队追问逐条注入直到清空或取消。
  // 与 startExecution 同构的后台执行：进 executions（close() 会等待、isBusy() 计入），不进 HTTP 等待路径。
  startSteerDrain(id, controller) {
    if (this.executions.has(id)) return this.executions.get(id);
    const drain = this.drainSteer(id, controller)
      .finally(() => this.executions.delete(id))
      .then(() => this.ensureSteerDrained(id)); // 排干尾窗又排入的继续补收，队列空即终止递归
    this.executions.set(id, drain);
    return drain;
  }

  /**
   * W3.5 A/B shadow run：同一任务双成员并行。A 按原始输入创建；B 改派 shadowAgentId
   * 并强制 plan（只读对照，不双写工作树），shadowOf 反向指路。两 run 各自走完整治理链，
   * 对比报告走 GET /api/runs/compare?a=&b=。
   */
  async createShadowPair(input = {}) {
    const { shadowAgentId, ...baseInput } = input;
    const shadowTarget = String(shadowAgentId || "").trim();
    if (!shadowTarget) {
      throw Object.assign(new Error("shadowAgentId is required for shadow pair"), { code: "VALIDATION_FAILED" });
    }
    const primary = await this.create(baseInput);
    let shadow;
    try {
      shadow = await this.create({
        ...baseInput,
        startAgentId: shadowTarget,
        requestedProvider: undefined, // 防止 A 的 provider 与 B 的 startAgentId 不一致被一致性门拒绝
        permissionMode: "plan",
      });
      shadow.shadowOf = primary.id;
      await this.save(shadow);
    } catch (error) {
      // 对照腿建不出来时不留孤儿主腿：如实失败，让调用方决定是否重试
      try {
        await this.cancel(primary.id);
      } catch {
        // 取消失败不影响原始错误抛出
      }
      throw error;
    }
    return { primary, shadow };
  }

  async continue(id, request = {}) {
    const run = this.get(id);
    if (run.status === "cancelled") {
      throw Object.assign(new Error("cancelled runs cannot be continued"), { code: "RUN_TERMINAL" });
    }
    if (run.conversationId) {
      if (!this.conversations) {
        throw Object.assign(new Error("persisted conversations require a conversation store"), { code: "CONVERSATION_STORE_UNAVAILABLE" });
      }
      const conversation = this.conversations.get(run.conversationId);
      if (conversation.deletedAt) {
        throw Object.assign(new Error("deleted conversations cannot be continued"), { code: "CONVERSATION_DELETED" });
      }
      if ((conversation.projectId || null) !== (run.projectId || null)) {
        throw Object.assign(new Error("run project no longer matches its conversation"), { code: "TRANSACTION_INCONSISTENT" });
      }
      if (run.projectId) {
        if (!this.projects) {
          throw Object.assign(new Error("project conversations require a project registry"), { code: "PROJECT_STORE_UNAVAILABLE" });
        }
        const project = this.projects.get(run.projectId);
        if (project.archivedAt) {
          throw Object.assign(new Error("archived projects must be restored before continuing runs"), {
            code: "PROJECT_ARCHIVED",
            projectId: project.projectId,
          });
        }
      }
      if (conversation.kind === "workspace_group" && Array.isArray(run.teamMembers)) {
        const currentMembers = [...new Set(conversation.memberIds || [])].sort();
        const runMembers = [...new Set(run.teamMembers)].sort();
        if (JSON.stringify(currentMembers) !== JSON.stringify(runMembers)) {
          throw Object.assign(new Error("project members changed; start a new run for the updated conversation"), {
            code: "CONVERSATION_MEMBERS_CHANGED",
          });
        }
      }
    }
    const admissionEpoch = this.cancelEpoch(id);
    this.assertContinuationAdmission(id, admissionEpoch);
    const explicitAgentTarget = typeof request.agentId === "string" && request.agentId.trim().length > 0;
    // HTTP 必须 waitForTurn:false：准入落盘后立刻返回，turn 走 executions/SSE。
    // 进程内测试默认仍等整轮，避免把上百个结算断言改成轮询。
    const waitForTurn = request.waitForTurn !== false;
    let {
      prompt,
      agentId = null,
      answerToAskId = null,
      messageIntent = null,
      acknowledgeRecovery = false,
      sources = [],
      nativeCommand = false,
    } = request;
    sources = normalizeRunSources(sources);
    answerToAskId = answerToAskId == null ? null : String(answerToAskId).trim();
    messageIntent = messageIntent == null ? null : String(messageIntent).trim().toLowerCase();
    if (messageIntent && !["answer", "steer"].includes(messageIntent)) {
      throw Object.assign(new Error("messageIntent must be answer or steer"), { code: "VALIDATION_FAILED" });
    }
    if (answerToAskId && !/^[A-Za-z0-9._:-]{1,160}$/.test(answerToAskId)) {
      throw Object.assign(new Error("answerToAskId is invalid"), { code: "VALIDATION_FAILED" });
    }
    if (messageIntent === "answer" && !answerToAskId) {
      if (run.pendingAsk && !run.pendingAsk.id) {
        await this.ensureStablePendingAsk(run);
        answerToAskId = run.pendingAsk?.id || null;
      }
      if (!answerToAskId) {
        throw Object.assign(new Error("messageIntent answer requires answerToAskId"), { code: "VALIDATION_FAILED" });
      }
    }
    if (messageIntent === "steer" && answerToAskId) {
      throw Object.assign(new Error("messageIntent steer cannot include answerToAskId"), { code: "VALIDATION_FAILED" });
    }
    const pendingAskOwnerId = String(run.pendingAsk?.from || "").trim();
    agentId = agentId || (run.pendingAsk && messageIntent !== "steer" ? pendingAskOwnerId : executionOwnerIdOf(run));
    if (this.closing) throw Object.assign(new Error("control plane is shutting down"), { code: "CONTROL_PLANE_CLOSING" });
    let nextPrompt = String(prompt || "").trim();
    if (!nextPrompt) throw Object.assign(new Error("prompt is required"), { code: "INVALID_PROMPT" });
    if (Buffer.byteLength(nextPrompt, "utf8") > 256 * 1024) throw Object.assign(new Error("prompt exceeds 256 KiB"), { code: "INVALID_PROMPT" });
    if (findSecretCandidates(nextPrompt).length) throw Object.assign(new Error("prompt contains secret-like material"), { code: "SENSITIVE_PROMPT" });
    // 原生斜杠命令轮（/compact 等）：整条消息就是命令本身，CLI 原样执行（与 Desktop 同通道）。
    // 只接受显式标记 + 严格单行命令形态——消息内容里的 "/" 不会隐式触发，防提示注入伪造命令轮。
    if (nativeCommand) {
      if (answerToAskId || messageIntent === "answer") {
        throw Object.assign(new Error("native commands cannot answer a pending ask"), { code: "VALIDATION_FAILED" });
      }
      if (sources.length) {
        throw Object.assign(new Error("native commands cannot carry attachments"), { code: "VALIDATION_FAILED" });
      }
      if (!/^\/[A-Za-z0-9_-]+([ \t]+\S+){0,8}$/.test(nextPrompt)) {
        throw Object.assign(new Error("nativeCommand prompt must be a single-line slash command like /compact"), { code: "VALIDATION_FAILED" });
      }
    }
    // 重复提交幂等门：同一 run、同一收件人、同一段文本，在它还没被处理时再次提交没有语义——
    // 客户端在途锁被 UI 同步冲掉时会把同一句话派成两轮（LO 2026-08-14 报障：同一条 19 字消息
    // 占掉第 3、4 两轮，同一个问题被回答两遍还给出互相矛盾的结论，各烧一轮预算）。
    // 只拦「尚未被消费」的重复：已经回答过的同一句话是 LO 有意重发，照常放行。
    const continuationKey = `${id}::${agentId}`;
    if (this.inflightContinuations.get(continuationKey) === nextPrompt
      || (run.pendingSteer || []).some((item) => item?.prompt === nextPrompt && (item.agentId || null) === agentId)) {
      throw Object.assign(new Error("the same message is already queued or in flight for this recipient"), {
        code: "DUPLICATE_MESSAGE",
      });
    }
    if (run.status === "waiting_approval" || run.buildApproval?.status === "pending") {
      throw Object.assign(new Error("run is waiting for its action-bound build approval"), { code: "APPROVAL_REQUIRED" });
    }
    if (run.status === "recovery_required" && acknowledgeRecovery !== true) {
      throw Object.assign(new Error("the previous native turn has an ambiguous submission state"), { code: "RECOVERY_REQUIRED" });
    }
    // 续聊只能派给团队成员（派工白名单服务端强制，不信前端下拉）——旧 run 无快照时放行兼容
    if (Array.isArray(run.teamMembers) && !run.teamMembers.includes(agentId)) {
      throw Object.assign(new Error(`${agentId} is not a member of this run's team`), { code: "NOT_TEAM_MEMBER" });
    }
    const runtimeProfileId = this.runtimeProfileIdFor(run, agentId);
    if (!this.adapters.get(runtimeProfileId)) {
      throw Object.assign(new Error(`no executable adapter for ${agentId} (${runtimeProfileId})`), { code: "ADAPTER_UNAVAILABLE" });
    }
    if (nativeCommand) {
      const template = adapterTemplateForRuntimeProfileId(runtimeProfileId);
      const resolved = resolveNativeCommand(template, nextPrompt);
      if (!resolved.ok) {
        // W3.11 用户宏兜底：不是 CLI 原生命令时先查宏表，命中即降级为普通提示词轮；
        // 未命中保持原样 fail-closed（不假装任何 /token 都能执行）
        const expanded = this.macroStore ? await this.macroStore.expand(nextPrompt) : null;
        if (expanded == null) {
          throw Object.assign(new Error(resolved.message), { code: resolved.code || "NATIVE_COMMAND_UNSUPPORTED" });
        }
        nextPrompt = expanded;
        nativeCommand = false;
      }
    }
    // 显式 answerToAskId 是 answer 所有权凭据；messageIntent 区分新客户端的 answer/steer。
    // 旧客户端没有 messageIntent，继续按历史 pendingAsk=answer 语义兼容。
    if ((answerToAskId || messageIntent === "answer") && !run.pendingAsk) {
      throw Object.assign(new Error("the referenced ask is no longer pending"), { code: "ASK_NOT_PENDING" });
    }
    if (run.orchestrationMode === "social" && run.pendingAsk) {
      if (answerToAskId && answerToAskId !== run.pendingAsk.id) {
        throw Object.assign(new Error("answerToAskId does not own the current pending ask"), { code: "ASK_MISMATCH" });
      }
      // No messageIntent is the compatibility path for pre-contract clients, whose UI always
      // included agentId even when submitting an answer. New clients must state answer/steer.
      const wantsAnswer = Boolean(answerToAskId) || messageIntent === "answer" || messageIntent == null;
      if (wantsAnswer && (!pendingAskOwnerId || agentId !== pendingAskOwnerId)) {
        throw Object.assign(new Error("answers must be sent from the member tab that owns the pending ask"), {
          code: "ASK_OWNER_MISMATCH",
          expectedAgentId: pendingAskOwnerId || null,
        });
      }
      if (wantsAnswer && !this.askClaims.has(id)) {
        await this.resumePendingAsk(id, nextPrompt, { answerToAskId, admissionEpoch, sources });
        return this.get(id);
      }
      if (wantsAnswer) {
        throw Object.assign(new Error("an answer for this ask is already being persisted"), { code: "ANSWER_IN_PROGRESS" });
      }
      if (messageIntent === "steer") {
        await this.queueSteer(run, { prompt: nextPrompt, agentId, sources, admissionEpoch, acknowledgeRecovery, nativeCommand });
        return this.get(id);
      }
    }
    if (this.controllers.has(id)) {
      // 轮间插话：run 活跃时 continue 不再抛 RUN_ACTIVE——准入校验同上，排队持久化到 run.pendingSteer，
      // 当前 turn 边界由编排器按 FIFO 取出注入（injectNextSteer：先 user.message 再续轮），不打断子进程。
      await this.queueSteer(run, {
        prompt: nextPrompt,
        agentId,
        sources,
        answerCandidate: messageIntent == null && !answerToAskId && !run.pendingAsk && !explicitAgentTarget,
        admissionEpoch,
        acknowledgeRecovery,
        nativeCommand,
      });
      return this.get(id);
    }
    // HTTP 直接续聊注册进 executions（烛 wave2 回炉 R5/R6）：close() 等待、isBusy() 计入——
    // 否则关闭时在途续聊的落盘不被等待、可能被进程 exit 截断。键加前缀避免与
    // startExecution/startSteerDrain 的裸 id 去重键冲突（drain 启动需 has(id) 为空）。
    // controller 建立、状态变更与 executions 注册同 tick 完成（首个 await 前）——close 的
    // active 快照不再有"已进入但未注册"的漏等窗口。
    const controller = new AbortController();
    // 同步占住 run 级生命周期。第二个并发 continue 会进入 queueSteer，而不是在 transition
    // 后半段争抢 controller、覆盖 continue:<id> execution owner 或把第一条运行写成 failed。
    this.controllers.set(id, controller);
    // 在途记账与 controller 同 tick 建立（首个 await 前）：晚一步就留出「同一句话第二次提交
    // 已经过了幂等门」的窗口
    this.inflightContinuations.set(continuationKey, nextPrompt);
    let admitContinuation;
    const admissionGate = new Promise((resolve, reject) => {
      admitContinuation = { resolve, reject };
    });
    const settleAdmission = (error) => {
      if (!admitContinuation) return;
      const pending = admitContinuation;
      admitContinuation = null;
      if (error) pending.reject(error);
      else pending.resolve(this.get(id));
    };
    const directInteractionId = randomUUID();
    const directPromptMessageId = run.orchestrationMode === "social"
      ? operationMessageId("steer", randomUUID())
      : null;
    const continuation = (async () => {
      let drainStarted = false;
      let admissionCommitted = false;
      let promptProjected = false;
      let directRefund = null;
      try {
        await withManagedClipboardSourceRegistration({
          dataRoot: this.dataRoot,
          sources,
          operation: () => this.withRunTransition(id, async () => {
            this.assertContinuationAdmission(id, admissionEpoch);
            if (this.controllers.get(id) !== controller) {
              throw Object.assign(new Error("another continuation owns this run"), { code: "RUN_ACTIVE" });
            }
            const previous = { status: run.status, ...this.abandonmentSnapshot(run) };
            const previousInteraction = this.interactionSnapshot(run);
            const preparedSources = this.prepareInteractionSources(run, sources);
            const acknowledgedRecovery = run.status === "recovery_required";
            if (acknowledgedRecovery) {
              directRefund = this.acknowledgeAbandonedWork(run);
            } else if (this.canRefundAbandonedRound(run)) {
              // A definitively rejected/pre-submit attempt needs no ambiguous-recovery acknowledgement.
              // Refund at continuation admission, then persist it atomically with the new running state.
              directRefund = this.refundAbandonedRound(run);
            }
            const interaction = {
              ...this.allocateInteraction(run, directInteractionId),
              sources: preparedSources.sources,
            };
            this.activateInteraction(run, interaction);
            run.status = "running";
            // 中断粘性注记随新一轮清掉；确认放弃的 audit 注记必须留下（refund 可能为空）。
            if (!acknowledgedRecovery) run.recoveryNote = null;
            try {
              await this.save(run);
              admissionCommitted = true;
            } catch (error) {
              if (this.controllers.get(id) === controller) this.controllers.delete(id);
              Object.assign(run, previous);
              this.restoreInteraction(run, previousInteraction);
              this.restorePreparedInteractionSources(run, preparedSources.previous);
              directRefund = null;
              throw error;
            }
          }),
        });
        settleAdmission();
        if (directRefund) await this.emitRoundRefund(run, directRefund);
        await this.withProjectionEffect(run, controller, async () => {
          if (run.orchestrationMode === "social") {
            await this.appendBus(run, {
              id: directPromptMessageId,
              from: "lo",
              to: agentId,
              kind: "steer",
              text: nextPrompt,
              refs: { directContinuation: true },
            });
            promptProjected = true;
          }
          // 续聊的用户追问进对话历史（实时+重启后都可见）——否则只有 assistant 回复、看不到问的是什么
          await this.emitEvent(run, "user.message", {
            text: nextPrompt,
            interactionId: run.activeInteractionId,
            interactionSeq: run.activeInteractionSeq,
          }, { runId: run.id, agentId: "LO" });
          if (run.orchestrationMode !== "social") promptProjected = true;
        });
        // 直发续聊与 socialLoop 派轮同权（同上）：LO 说「继续执行」时执行所有者必须真能落盘
        const writeGrant = this.continuationWriteGrant(run, agentId);
        await this.emitWriteDegraded(run, agentId, writeGrant.reason);
        const text = await this.turn(run, agentId, nextPrompt, {
          allowWorkspaceWrite: writeGrant.allow,
          cwd: writeGrant.allow && run.worktreePath ? run.worktreePath : null,
          nativeCommand,
        });
        await this.withProjectionEffect(run, controller, async () => {
          // 同上：空回复不伪造成一条发言（LO 那次的空白气泡就是从这里 append 的）
          if (run.orchestrationMode === "social" && String(text ?? "").trim()) {
            await this.appendBus(run, { from: agentId, to: "lo", kind: "say", text });
          }
          run.result = { ...(run.result || {}), continued: text };
        });
        if (run.orchestrationMode === "social" && (run.resumeClaim || (run.resumeQueue || []).length)) {
          await this.socialLoop(run, controller);
        }
        await this.withProjectionEffect(run, controller, async () => {
          if (run.pausedForInput) {
            run.status = "waiting_agent";
            await this.save(run);
            await this.emitEvent(run, "run.waiting_input", {
              from: run.pendingAsk?.from ?? null,
              text: run.pendingAsk?.text ?? null,
            }, { runId: run.id });
          } else if (run.resumeClaim) {
            run.status = "recovery_required";
            run.recoveryNote = "A claimed durable work item still owns an unfinished provider turn.";
            await this.save(run);
            await this.emitEvent(run, "run.recovery_required", {
              status: run.status,
              code: "RESUME_WORK_REMAINS",
              message: run.recoveryNote,
            }, { runId: run.id });
          } else if ((run.resumeQueue || []).length && this.interactionLimitReached(run)) {
            run.status = "succeeded";
            run.result = { ...(run.result || {}), truncated: true, reason: "interaction_step_limit" };
            await this.save(run);
            await this.emitEvent(run, "run.interaction_steps_exhausted", {
              interactionId: run.activeInteractionId,
              interactionSeq: run.activeInteractionSeq,
              interactionStep: run.interactionStep,
              maxStepsPerInteraction: this.maxStepsForInteraction(run),
              queuedWork: run.resumeQueue.length,
            }, { runId: run.id });
          } else {
            run.status = "succeeded";
            await this.save(run);
          }
        });
        // 本轮结束后仍有排队追问 → 后台 driver 接管同一 controller 逐轮排干（HTTP 即刻返回，不等排干）
        if (run.status === "succeeded" && ((run.pendingSteer || []).length || run.activeSteer)) {
          this.startSteerDrain(id, controller);
          drainStarted = true;
        }
        return this.get(id);
      } catch (error) {
        settleAdmission(error);
        if (controller.signal.aborted || ["ABORTED", "RUN_CANCELLED", "CONTROL_PLANE_CLOSING"].includes(error.code)) {
          if (admissionCommitted && !this.interruptingRuns.has(id) && this.controllers.get(id) === controller && run.status === "running") {
            await this.withRunTransition(id, async () => {
              if (this.controllers.get(id) !== controller || run.status !== "running") return;
              run.status = "cancelled";
              const shutdown = this.closing;
              run.error = shutdown
                ? "Continuation was cancelled while the control plane was shutting down."
                : "Continuation was superseded by run cancellation.";
              run.recoveryNote = promptProjected
                ? shutdown
                  ? "Control plane shutdown cancelled this continuation after the prompt was recorded but before provider completion."
                  : "Run cancellation superseded this continuation after the prompt was recorded."
                : shutdown
                  ? "Control plane shutdown cancelled this continuation before prompt was projected."
                  : "Run cancellation superseded this continuation before prompt was projected.";
              await this.save(run);
            }).catch(() => {});
          }
          return this.get(id);
        }
        if (!admissionCommitted || this.controllers.get(id) !== controller || run.status === "cancelled") {
          // 生命周期已被另一条 continuation/cancel 接管；失败只能回给本请求，禁止改写 owner 的 run。
          throw error;
        }
        const recoveryBlocked = this.requiresRecovery(run, error);
        if (error.failureKind === "budget_exhausted" && run.attention?.type === "budget_exhausted") {
          await this.save(run);
          throw error;
        }
        run.status = recoveryBlocked ? "recovery_required" : "failed";
        run.failureKind = error.failureKind || null;
        run.error = error.message;
        if (recoveryBlocked) {
          run.recoveryNote = `Recovery acknowledgement could not drain durable work (${error.code || "RESUME_DRAIN_FAILED"}). Inspect the claimed work before acknowledging another continuation.`;
        }
        await this.save(run);
        if (recoveryBlocked) {
          await this.emitEvent(run, "run.recovery_required", {
            status: run.status,
            code: error.code || "RESUME_DRAIN_FAILED",
            message: run.error,
          }, { runId: run.id });
        } else {
          await this.emitEvent(run, "run.failed", {
            status: run.status,
            code: error.code || null,
            message: run.error,
          }, { runId: run.id });
        }
        throw error;
      } finally {
        // 只清自己那条记账：期间可能已被另一次续聊接管
        if (this.inflightContinuations.get(continuationKey) === nextPrompt) {
          this.inflightContinuations.delete(continuationKey);
        }
        if (!drainStarted && this.controllers.get(id) === controller) this.controllers.delete(id);
      }
    })();
    const executionKey = `continue:${id}`;
    const tracked = continuation.finally(() => {
      if (this.executions.get(executionKey) === tracked) this.executions.delete(executionKey);
      this.ensureSteerDrained(id); // 直接续聊的收尾窗兜底（同 startExecution 链）；同步 no-op 不阻塞 HTTP 返回
    });
    this.executions.set(executionKey, tracked);
    // HTTP continuation returns after durable admission. The tracked provider promise can reject
    // later; executions still retains the original promise for close/interrupt ownership, while
    // this observer prevents a handled run failure from surfacing as process-level unhandledRejection.
    void tracked.catch(() => {});
    return waitForTurn ? tracked : admissionGate;
  }

  async addSources(id, value) {
    const sources = normalizeRunSources(value);
    const run = this.get(id);
    if (!sources.length) return run;
    let addedSources = [];
    let queuedSources = [];
    await withManagedClipboardSourceRegistration({
      dataRoot: this.dataRoot,
      sources,
      operation: () => this.withRunTransition(id, async () => {
        const existing = normalizeRunSources(run.sources || []);
        const existingPaths = new Set(existing.map((source) => (
          process.platform === "win32" ? source.path.toLowerCase() : source.path
        )));
        const merged = normalizeRunSources([...existing, ...sources]);
        addedSources = merged.filter((source) => !existingPaths.has(
          process.platform === "win32" ? source.path.toLowerCase() : source.path,
        ));
        const previousPending = normalizeRunSources(run.pendingInteractionSources || []);
        const previousPendingPaths = new Set(previousPending.map((source) => (
          process.platform === "win32" ? source.path.toLowerCase() : source.path
        )));
        const nextPending = normalizeRunSources([...previousPending, ...sources]);
        queuedSources = nextPending.filter((source) => !previousPendingPaths.has(
          process.platform === "win32" ? source.path.toLowerCase() : source.path,
        ));
        if (!addedSources.length && !queuedSources.length) return;
        const previous = {
          sources: existing,
          pendingInteractionSources: previousPending,
          updatedAt: run.updatedAt,
        };
        try {
          run.sources = merged;
          run.pendingInteractionSources = nextPending;
          run.updatedAt = new Date().toISOString();
          await this.save(run);
        } catch (error) {
          Object.assign(run, previous);
          addedSources = [];
          queuedSources = [];
          throw error;
        }
      }),
    });
    if (addedSources.length) {
      await this.emitEvent(run, "run.sources_added", {
        count: addedSources.length,
        names: addedSources.map((item) => item.name),
      }, { runId: run.id, agentId: "LO" });
    }
    return run;
  }

  // answer 恢复主体：claim/controller 在首个 await 前占位；pendingAsk 直到 durable bus append
  // 成功后才转移，EIO 时原 ask 保持可回答。显式 answerToAskId 同时阻止陈旧 UI 回答新问题。
  async resumePendingAsk(id, answerText, {
    answerToAskId = null,
    admissionEpoch = this.cancelEpoch(id),
    sources = [],
  } = {}) {
    const run = this.get(id);
    sources = normalizeRunSources(sources);
    await this.ensureStablePendingAsk(run);
    this.assertContinuationAdmission(id, admissionEpoch);
    const ask = run.pendingAsk;
    if (!ask) throw Object.assign(new Error("run has no pending ask"), { code: "ASK_NOT_PENDING" });
    if (answerToAskId && answerToAskId !== ask.id) {
      throw Object.assign(new Error("answerToAskId does not own the current pending ask"), { code: "ASK_MISMATCH" });
    }
    const claimId = ask.id;
    if (this.askClaims.has(id)) throw Object.assign(new Error("an answer is already being persisted"), { code: "ANSWER_IN_PROGRESS" });
    const answerInteractionId = randomUUID();
    this.askClaims.set(id, claimId);
    const placeholder = new AbortController();
    this.controllers.set(id, placeholder);
    let transferError = null;
    let committed = false;
    try {
      // 挂起置位（waiting_agent save）与 execute 协程 settle 之间有窗口：executions 里的旧链
      // 未删时 startExecution 会拿到垂死链直接返回、复跑被静默吞掉——先等旧链收尾再重启
      const previous = this.executions.get(id);
      if (previous) await Promise.resolve(previous).catch(() => {});
      if (placeholder.signal.aborted || this.closing) return;
      if (run.pendingAsk?.id !== ask.id) {
        throw Object.assign(new Error("the pending ask changed before the answer could commit"), { code: "ASK_MISMATCH" });
      }
      let answerMessage = null;
      await withManagedClipboardSourceRegistration({
        dataRoot: this.dataRoot,
        sources,
        operation: async () => {
          answerMessage = await this.withProjectionEffect(run, placeholder, () => this.appendBus(run, {
            id: operationMessageId("answer", ask.id),
            from: "lo",
            to: ask.from,
            kind: "answer",
            text: answerText,
            refs: { answerToAskId: ask.id },
          }));
          // cancel/close wins after the durable append: answer remains auditable but no new execution starts.
          if (placeholder.signal.aborted || this.closing) return;
          await this.withRunTransition(id, async () => {
            this.assertContinuationAdmission(id, admissionEpoch);
            if (placeholder.signal.aborted || this.closing || run.status === "cancelled") return;
            if (run.pendingAsk?.id !== ask.id) {
              throw Object.assign(new Error("the pending ask changed before the answer state committed"), { code: "ASK_MISMATCH" });
            }
            const previousState = {
              pendingAsk: run.pendingAsk,
              pausedForInput: run.pausedForInput,
              resumeQueue: [...(run.resumeQueue || [])],
              interaction: this.interactionSnapshot(run),
            };
            const preparedSources = this.prepareInteractionSources(run, sources);
            const interaction = {
              ...this.allocateInteraction(run, answerInteractionId),
              sources: preparedSources.sources,
            };
            run.pendingAsk = null;
            run.pausedForInput = false;
            run.resumeQueue = mergeResumeQueues(
              [{ to: ask.from, busMessageId: answerMessage.id, kind: "answer", ...interaction }],
              run.resumeQueue,
            );
            this.activateInteraction(run, interaction);
            try {
              await this.save(run);
              committed = true;
            } catch (error) {
              run.pendingAsk = previousState.pendingAsk;
              run.pausedForInput = previousState.pausedForInput;
              run.resumeQueue = previousState.resumeQueue;
              this.restoreInteraction(run, previousState.interaction);
              this.restorePreparedInteractionSources(run, preparedSources.previous);
              transferError = error;
            }
          });
        },
      });
      if (committed) {
        await this.withProjectionEffect(run, placeholder, () =>
          this.emitEvent(run, "user.message", {
            text: answerText,
            interactionId: run.activeInteractionId,
            interactionSeq: run.activeInteractionSeq,
          }, { runId: id, agentId: "LO" }));
      }
    } finally {
      if (this.askClaims.get(id) === claimId) this.askClaims.delete(id);
      if (this.controllers.get(id) === placeholder) this.controllers.delete(id);
    }
    // 占位期间被 cancel（cancel 会 abort 占位并置 cancelled）：如实返回，不复跑
    if (placeholder.signal.aborted || this.closing) return;
    this.assertContinuationAdmission(id, admissionEpoch);
    if (transferError) throw transferError;
    if (!committed) return;
    this.startExecution(id); // execute 同 tick 自建 controller 接管同键，socialLoop 从 resumeQueue 复跑
  }

  // 会话元数据（侧栏右键菜单）：白名单字段浅更新——置顶/归档/未读/重命名，全部走 save 持久化
  async updateMeta(id, patch = {}) {
    const run = this.get(id);
    if (patch.pinned !== undefined) run.pinned = Boolean(patch.pinned);
    if (patch.archived !== undefined) run.archived = Boolean(patch.archived);
    if (patch.unread !== undefined) run.unread = Boolean(patch.unread);
    if (patch.title !== undefined) {
      const title = String(patch.title).trim().slice(0, 120);
      if (!title) throw Object.assign(new Error("title cannot be empty"), { code: "VALIDATION_FAILED" });
      run.title = title;
    }
    await this.save(run);
    return this.get(id);
  }

  // 会话中控制热改：模型（Codex turn/start 接受 per-turn 覆盖）与 Effort 随改随下一轮生效；
  // 权限仅放行 PERMISSION_HOT_TRANSITIONS 白名单（降档 / Codex ask↔auto），sandbox 轴不开口子。
  // 每次实改落 run.control_changed 审计事件——热改不等于免审计。
  async updateRunControls(id, patch = {}, { actor = "operator", acknowledgeRecovery = false } = {}) {
    const run = this.get(id);
    // 闸与 continue() 准入对齐：审批待决（改动会污染动作绑定审批语义）不可热改；
    // 恢复未确认（提交状态不明）须先确认——确认语义与 continue() 相同，可随热改一次性携带。
    // succeeded/failed/cancelled 的闲置会话可改，下一轮生效。
    if (run.status === "waiting_approval" || run.buildApproval?.status === "pending") {
      throw Object.assign(new Error("run is waiting for its action-bound build approval; controls cannot change mid-approval"), { code: "APPROVAL_REQUIRED" });
    }
    const recovery = run.status === "recovery_required";
    if (recovery && acknowledgeRecovery !== true) {
      throw Object.assign(new Error("the previous native turn has an ambiguous submission state; acknowledge recovery before changing controls"), { code: "RECOVERY_REQUIRED" });
    }
    const executionOwnerId = executionOwnerIdOf(run);
    const executionRuntimeProfileId = this.runtimeProfileIdFor(run, executionOwnerId);
    const executionProfile = this.models?.profiles?.find((item) => item.id === executionRuntimeProfileId) || null;
    const executionAdapterTemplate = executionProfile
      ? ADAPTER_TEMPLATES.find((item) => item.id === executionProfile.adapter) || null
      : null;
    const changes = [];
    // 恢复确认与热改必须原子：确认放弃 claim 之后任何校验/落盘失败都要整体回滚，
    // 否则留下"claim 已作废但档位没改成"的半状态。
    const previous = recovery
      ? {
        status: run.status,
        modelOverride: run.modelOverride ?? null,
        effortOverride: run.effortOverride ?? null,
        permissionOverride: run.permissionOverride ?? null,
        permissionMode: run.permissionMode,
        maxBudgetUsdPerTurn: run.maxBudgetUsdPerTurn,
        ...this.abandonmentSnapshot(run),
      }
      : { maxBudgetUsdPerTurn: run.maxBudgetUsdPerTurn };
    let recoveryRefund = null;
    try {
      if (recovery) {
        // 与 continue() 准入同一确认：放弃可能仍占用原生轮的 claim。热改本身不跑轮，
        // 确认后停在 failed 闲置终态（可续聊/可再热改），recoveryNote 如实记录"已确认放弃"。
        recoveryRefund = this.acknowledgeAbandonedWork(run);
        run.status = "failed";
      }

      if (patch.maxBudgetUsdPerTurn !== undefined) {
        if (this.controllers.has(id) || this.executions.has(id) || this.executions.has(`continue:${id}`)
          || Object.keys(run.inflightTurns || {}).length) {
          throw Object.assign(new Error("budget cannot change while a provider turn is active"), { code: "RUN_ACTIVE" });
        }
        // "unlimited" 合法热改：落哨兵原样存储；数字路径维持既有钳制（≥0.05，硬上限内）
        const unlimitedRequested = isUnlimitedBudgetValue(patch.maxBudgetUsdPerTurn);
        const requested = Number(patch.maxBudgetUsdPerTurn);
        if (!unlimitedRequested && (!Number.isFinite(requested) || requested < 0.05)) {
          throw Object.assign(new Error("maxBudgetUsdPerTurn must be at least 0.05 or \"unlimited\""), { code: "VALIDATION_FAILED" });
        }
        const next = unlimitedRequested ? UNLIMITED_BUDGET : resolveBudgetUsdPerTurn(requested, this.policy);
        const current = run.maxBudgetUsdPerTurn;
        if (next !== current) {
          run.maxBudgetUsdPerTurn = next;
          changes.push({ field: "maxBudgetUsdPerTurn", from: resolveBudgetUsdPerTurn(current, this.policy), to: resolveBudgetUsdPerTurn(next, this.policy) });
        }
      }

      if (patch.model !== undefined) {
        const requested = String(patch.model ?? "").trim();
        // 空串 = 清除 override，回席位/CLI 默认；Codex 实证 turn/start 接受 per-turn model（0.146.0 探针）
        const next = requested
          ? await this.validateModelOverride(
            { executionOwnerId, executionRuntimeProfileId, executionProfile, executionAdapterTemplate },
            requested,
          )
          : null;
        const current = run.modelOverride ?? null;
        if (next !== current) {
          run.modelOverride = next;
          changes.push({ field: "model", from: current, to: next });
        }
      }

      if (patch.effort !== undefined) {
        const requested = String(patch.effort ?? "").trim().toLowerCase();
        // 空串 = 清除 override，回席位/CLI 默认
        const next = requested
          ? await this.validateEffortOverride(
            { executionOwnerId, executionRuntimeProfileId, executionProfile, executionAdapterTemplate },
            requested,
          )
          : null;
        const current = run.effortOverride ?? null;
        if (next !== current) {
          run.effortOverride = next;
          changes.push({ field: "effort", from: current, to: next });
        }
      }

      if (patch.permission !== undefined) {
        const requested = String(patch.permission ?? "").trim();
        // 空串 = 清除 override，回席位默认；非空值必须过模板 permissionModes 白名单（创建与热改同源，不得分叉）
        const next = requested
          ? this.validatePermissionOverride({ executionOwnerId, executionAdapterTemplate }, requested)
          : null;
        const current = run.permissionOverride ?? null;
        if (next !== current) {
          // 服务端同源把守转换方向（与 permissionMode 分支同款纪律）：已有值 → 新值只允许
          // 同级保持/降档（写面收缩）/清除；升档（如 native:auto → native:always-approve）
          // 绕开创建时的动作绑定审批门，必须拒绝。首次设置（无值）不受限，与创建路径一致。
          if (current != null && next != null && !(PERMISSION_HOT_TRANSITIONS[current] || []).includes(next)) {
            throw Object.assign(
              new Error(`permission override ${current} → ${next} is not hot-switchable: 会话中只允许降档（写面收缩）或清除，升档请新建任务`),
              { code: "CONTROL_TRANSITION_FORBIDDEN" },
            );
          }
          run.permissionOverride = next;
          changes.push({ field: "permission", from: current, to: next });
        }
      }

      if (patch.permissionMode !== undefined) {
        const target = String(patch.permissionMode ?? "").trim().toLowerCase();
        if (!["plan", "review", "build", ...Object.keys(CODEX_PRESET_NATIVE_MODES)].includes(target)) {
          throw Object.assign(new Error(`unsupported permission mode: ${target}`), { code: "VALIDATION_FAILED" });
        }
        if (!this.policy.modes?.[target]) {
          throw Object.assign(new Error(`permission mode ${target} is not configured`), { code: "POLICY_VIOLATION" });
        }
        if (CODEX_PRESET_NATIVE_MODES[target] && !executionAdapterTemplate?.permissionModes?.includes("danger-full-access")) {
          throw Object.assign(new Error(`${executionOwnerId} adapter does not support Codex official preset ${target}`), { code: "UNSUPPORTED_PERMISSION" });
        }
        if (target !== run.permissionMode) {
          const allowed = PERMISSION_HOT_TRANSITIONS[run.permissionMode] || [];
          if (!allowed.includes(target)) {
            const reason = CODEX_PRESET_NATIVE_MODES[run.permissionMode] || CODEX_PRESET_NATIVE_MODES[target]
              ? "Codex 沙箱轴绑在原生 thread（thread/start），会话存续期不可变——请新建任务"
              : target === "build"
                ? "升 build 必须走创建时的动作绑定审批门——请新建任务"
                : "会话中只允许降档（写面收缩），升档请新建任务";
            throw Object.assign(
              new Error(`permission ${run.permissionMode} → ${target} is not hot-switchable: ${reason}`),
              { code: "CONTROL_TRANSITION_FORBIDDEN" },
            );
          }
          const from = run.permissionMode;
          run.permissionMode = target;
          changes.push({ field: "permissionMode", from, to: target });
        }
      }

      // 纯确认（无档位变化）也要落盘：status/recoveryNote/inflight 清理都是状态变更
      if (changes.length || recovery) await this.save(run);
    } catch (error) {
      if (previous) Object.assign(run, previous);
      throw error;
    }
    // 事件只在落盘成功后播报——确认恢复与轮次退还都不能出现"回了滚却已广播"的假账
    if (recovery) {
      await this.emitEvent(run, "run.recovery_acknowledged", { actor, via: "controls" }, { runId: run.id });
      if (recoveryRefund) await this.emitRoundRefund(run, recoveryRefund);
    }
    if (changes.length) {
      await this.emitEvent(run, "run.control_changed", { changes, actor }, { runId: run.id });
    }
    return this.get(id);
  }

  async archiveFinishedByProjectId(projectId) {
    if (!this.projects) {
      throw Object.assign(new Error("project archive requires a project registry"), { code: "PROJECT_STORE_UNAVAILABLE" });
    }
    const project = this.projects.get(String(projectId || "").trim());
    const archived = [];
    for (const run of this.runs.values()) {
      if (!TERMINAL.has(run.status) || run.archived) continue;
      if ((run.projectId || null) !== project.projectId) continue;
      run.archived = true;
      await this.save(run);
      archived.push(run.id);
    }
    return { archived: archived.length, runIds: archived, projectId: project.projectId, matchedBy: "projectId" };
  }

  // 旧侧栏兼容入口：能解析到 Project 时立即转为 projectId 精确匹配；仅无 Project 的历史 run 才按 realpath 比较。
  async archiveFinishedByCwd(cwd) {
    const requested = String(cwd || "").trim();
    if (!requested || !isAbsolute(requested)) {
      throw Object.assign(new Error("archive cwd must be an absolute path"), { code: "INVALID_CWD" });
    }
    const target = await realpath(requested).catch(() => null);
    if (!target) throw Object.assign(new Error(`archive cwd does not exist: ${requested}`), { code: "INVALID_CWD" });
    if (this.projects) {
      const project = await this.projects.findByCwd(target);
      if (project) return this.archiveFinishedByProjectId(project.projectId);
    }
    const targetKey = process.platform === "win32" ? target.toLowerCase() : target;
    const archived = [];
    for (const run of this.runs.values()) {
      if (!TERMINAL.has(run.status) || run.archived || run.projectId || !run.cwd) continue;
      const canonicalRunCwd = await realpath(run.cwd).catch(() => null);
      const runKey = canonicalRunCwd && (process.platform === "win32" ? canonicalRunCwd.toLowerCase() : canonicalRunCwd);
      if (!runKey || runKey !== targetKey) continue;
      run.archived = true;
      await this.save(run);
      archived.push(run.id);
    }
    return { archived: archived.length, runIds: archived, projectId: null, matchedBy: "legacy-cwd" };
  }

  /**
   * 审批挂起时的停止：撤回尚未开始的执行，而不是假装 interrupt 成功。
   * 必须先翻走 waiting_approval，再 deny broker——否则 deny 回唤醒 awaitBuildApproval 把 run 写成 cancelled。
   */
  async withdrawPendingApproval(id) {
    const run = this.get(id);
    let withdrawn = false;
    await this.withRunTransition(id, async () => {
      if (run.status !== "waiting_approval" && run.status !== "waiting_for_approval") return;
      run.status = "interrupted";
      run.error = null;
      run.recoveryNote = "Build approval was withdrawn before execution started. Send another message to continue in the same session.";
      if (run.buildApproval && run.buildApproval.status === "pending") {
        run.buildApproval.status = "withdrawn";
      }
      run.result = { ...(run.result || {}), interrupted: true, approvalWithdrawn: true };
      await this.save(run);
      withdrawn = true;
    });
    if (!withdrawn) return this.get(id);
    await this.approvalBroker.denyRun(id, "operator withdrew pending build approval");
    await this.emitEvent(run, "run.interrupted", {
      round: run.round,
      interactionId: run.activeInteractionId || null,
      interactionSeq: run.activeInteractionSeq || null,
      approvalWithdrawn: true,
      sessionPreserved: true,
    }, { runId: id });
    return this.get(id);
  }

  /**
   * 只中断当前 provider turn。与 cancel 的关键区别：保留原生 session、worktree、build approval、
   * capability lease、pending ask 与 durable queue；待子进程确认退出后进入可续聊的 interrupted 状态。
   */
  async interrupt(id) {
    const run = this.get(id);
    if (this.interruptingRuns.has(id)) {
      throw Object.assign(new Error("the current provider turn is already being interrupted"), { code: "RUN_INTERRUPTING" });
    }
    if (run.status === "waiting_approval" || run.status === "waiting_for_approval") {
      return this.withdrawPendingApproval(id);
    }
    const controller = this.controllers.get(id) || null;
    const activeExecutions = [
      this.executions.get(id),
      this.executions.get(`continue:${id}`),
    ].filter(Boolean);
    const hasInflightTurn = Object.keys(run.inflightTurns || {}).length > 0;
    if (!controller && !activeExecutions.length && !hasInflightTurn) return this.get(id);

    const interruptEpoch = this.cancelEpoch(id);
    const cancellationWon = () => run.status === "cancelled"
      || this.cancellingRuns.has(id)
      || this.cancelEpoch(id) !== interruptEpoch;
    this.interruptingRuns.add(id);
    controller?.abort();
    let settled = false;
    let interruptTimer = null;
    const settlement = Promise.allSettled(activeExecutions).then(() => { settled = true; });
    try {
      await Promise.race([
        settlement,
        new Promise((resolveTimeout) => {
          interruptTimer = setTimeout(resolveTimeout, this.interruptTimeoutMs);
        }),
      ]);
      if (!settled) {
        let timeoutCommitted = false;
        await this.withRunTransition(id, async () => {
          if (cancellationWon()) return;
          run.status = "recovery_required";
          run.error = `The provider turn did not confirm termination within ${this.interruptTimeoutMs} ms.`;
          // 闸只在执行链 settle 后释放，理论上可能永不释放（adapter 死锁）。自动放闸会让原生轮
          // 并发占用，不做；但唯一的人工出口必须写明，否则 LO 侧就是无提示的死锁。
          run.recoveryNote = "Do not continue yet: the native turn may still be stopping. The control plane releases the interrupt gate once the execution settles; if it never does, cancel this run to release it.";
          await this.save(run);
          timeoutCommitted = !cancellationWon();
        });
        if (!timeoutCommitted || cancellationWon()) return this.get(id);
        await this.emitEvent(run, "run.interrupt_timeout", {
          round: run.round,
          interactionId: run.activeInteractionId || null,
          interactionSeq: run.activeInteractionSeq || null,
          timeoutMs: this.interruptTimeoutMs, // 前端文案按实配置渲染，写死秒数会在改配置后变成假话
        }, { runId: id });
        void settlement.finally(() => this.interruptingRuns.delete(id));
        return this.get(id);
      }

      const projection = this.projectionChains.get(id);
      if (projection) await projection.catch(() => {});
      if (cancellationWon()) return this.get(id);
      const interruptedAttempts = [];
      let interruptCommitted = false;
      await this.withRunTransition(id, async () => {
        if (cancellationWon()) return;
        const inflightIds = new Set(Object.values(run.inflightTurns || {}).filter(Boolean));
        for (const attempt of run.turnAttempts || []) {
          if (!inflightIds.has(attempt.attemptId)) continue;
          attempt.phase = "interrupted";
          attempt.interruptedAt = new Date().toISOString();
          attempt.updatedAt = attempt.interruptedAt;
          interruptedAttempts.push(attempt.attemptId);
        }
        run.inflightTurns = {};
        if (run.resumeClaim?.itemId) {
          const claimedId = run.resumeClaim.itemId;
          run.resumeQueue = (run.resumeQueue || []).filter((item) => item.itemId !== claimedId);
          run.resumeClaim = null;
        }
        run.status = "interrupted";
        run.error = null;
        run.recoveryNote = "Current provider turn was interrupted and confirmed stopped. Send another message to continue in the same native session.";
        run.result = { ...(run.result || {}), interrupted: true };
        await this.save(run);
        interruptCommitted = !cancellationWon();
      });
      if (!interruptCommitted || cancellationWon()) return this.get(id);
      await this.emitEvent(run, "run.interrupted", {
        round: run.round,
        interactionId: run.activeInteractionId || null,
        interactionSeq: run.activeInteractionSeq || null,
        interactionStep: run.interactionStep || 0,
        attempts: interruptedAttempts,
        sessionPreserved: true,
        buildApprovalPreserved: run.buildApproval?.status === "approved",
        leasePreserved: Boolean(this.activeCapabilityLease(run)),
      }, { runId: id });
      return this.get(id);
    } finally {
      if (interruptTimer) {
        clearTimeout(interruptTimer);
        interruptTimer = null;
      }
      if (settled) this.interruptingRuns.delete(id);
    }
  }

  async cancel(id) {
    const run = this.get(id);
    // Cancellation ownership must cross the in-memory execution boundary before any
    // broker or persistence await; otherwise an active provider can still complete.
    const cancelEpoch = this.cancelEpoch(id) + 1;
    this.cancelEpochs.set(id, cancelEpoch);
    this.cancellingRuns.add(id);
    this.controllers.get(id)?.abort();
    try {
      const projection = this.projectionChains.get(id);
      if (projection) await projection.catch(() => {});
      const contextInvalidatedMembers = [];
      const contextInvalidationFailures = [];
      if (this.conversationContexts && run.conversationId) {
        for (const [agentId, session] of Object.entries(run.sessions || {})) {
          const sessionId = typeof session === "string" ? session : (session?.sessionId || session?.id || null);
          if (!sessionId) continue;
          try {
            const result = await this.conversationContexts.invalidate({
              conversationId: run.conversationId,
              memberId: agentId,
              sessionId,
              ownerRunId: run.id,
              reason: "run-cancelled",
            });
            if (result.invalidated) contextInvalidatedMembers.push(agentId);
          } catch (error) {
            contextInvalidationFailures.push({
              agentId,
              code: error?.code || "CONVERSATION_CONTEXT_STORE_UNAVAILABLE",
              message: error?.message || "conversation context invalidation failed",
            });
          }
        }
      }
      await this.withRunTransition(id, async () => {
        run.status = "cancelled";
        if (contextInvalidatedMembers.length || contextInvalidationFailures.length) {
          run.contextCancellation = {
            state: contextInvalidationFailures.length ? "degraded" : "invalidated",
            invalidatedMembers: contextInvalidatedMembers.sort(),
            failures: contextInvalidationFailures,
            updatedAt: new Date().toISOString(),
          };
        }
        // 挂起态一并清场：取消后不存在"等回答"或排队追问。
        run.pendingAsk = null;
        run.pausedForInput = false;
        run.resumeQueue = [];
        run.resumeClaim = null;
        run.pendingSteer = [];
        run.pendingInteractionSources = [];
        run.activeSteer = null;
        if (run.buildApproval && run.buildApproval.status !== "denied") run.buildApproval.status = "revoked";
        this.revokeCapabilityLease(run, "run-cancelled");
        if (run.taskGraph?.tasks?.length) {
          const stamp = new Date().toISOString();
          for (const task of run.taskGraph.tasks) {
            if (!["succeeded", "failed", "cancelled"].includes(task.status)) {
              task.status = "cancelled";
              task.updatedAt = stamp;
            }
          }
          if (Array.isArray(run.taskGraph.delegations)) {
            for (const edge of run.taskGraph.delegations) {
              if (!["cancelled", "completed", "failed"].includes(edge.state)) edge.state = "cancelled";
            }
          }
          run.taskGraph.updatedAt = stamp;
        }
        await this.save(run);
      });
      let brokerError = null;
      try {
        await this.approvalBroker.denyRun(id);
      } catch (error) {
        brokerError = error;
        await this.emitEvent(run, "run.cancel_degraded", {
          code: error.code || null,
          message: error.message,
        }, { runId: id });
      }
      // 多 CLI 取消可见性：返回/广播本 run 涉及的成员与会话，前端可展示「级联中止」
      const cancelledAgents = [...new Set([
        ...(Array.isArray(run.teamMembers) ? run.teamMembers : []),
        run.coordinatorId,
        run.startAgentId,
        ...Object.keys(run.sessions || {}),
        ...(Array.isArray(run.turns) ? run.turns.map((turn) => turn?.agentId) : []),
      ].filter(Boolean))];
      const cancelledSessions = Object.fromEntries(
        Object.entries(run.sessions || {}).map(([agentId, session]) => [
          agentId,
          typeof session === "string" ? session : (session?.sessionId || session?.id || null),
        ]),
      );
      await this.emitEvent(run, "run.cancelled", {
        round: run.round,
        cascade: "run",
        agents: cancelledAgents,
        sessions: cancelledSessions,
        scope: "self|descendants|provider-tree",
      }, { runId: id });
      if (brokerError) {
        brokerError.runCancelled = true;
        throw brokerError;
      }
      const snapshot = this.get(id);
      snapshot.cancelCascade = {
        agents: cancelledAgents,
        sessions: cancelledSessions,
        scope: "self|descendants|provider-tree",
      };
      return snapshot;
    } finally {
      if (this.cancelEpoch(id) === cancelEpoch) this.cancellingRuns.delete(id);
      this.interruptingRuns.delete(id);
      // 远程 run 取消=终态：waiting_agent 挂起的 run 没有 execute 在飞（不会走那边的 finally），
      // 这里兜底处置专用 adapter——远端进程树绝不因取消路径不同而漏杀
      if (run.remote) await this.disposeRemoteAdapters(id);
    }
  }

  async revokeBuildGrants(reason = "runtime policy changed") {
    for (const run of this.runs.values()) {
      if (run.permissionMode !== "build" || !run.buildApproval || ["revoked", "denied", "expired", "withdrawn"].includes(run.buildApproval.status)) continue;
      run.buildApproval.status = "revoked";
      this.revokeCapabilityLease(run, reason);
      run.recoveryNote = `Build authorization revoked: ${reason}`;
      this.controllers.get(run.id)?.abort();
      await this.approvalBroker.denyRun(run.id, reason);
      await this.save(run);
      await this.emitEvent(run, "run.authorization_revoked", { reason }, { runId: run.id });
    }
  }

  close({ deadlineMs = null } = {}) {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = Promise.resolve().then(async () => {
      // 统一 shutdown deadline（烛 wave-shutdown 复审）：每阶段只拿剩余预算，
      // adapter 关闭不再各自独占 10s 叠加超时；超期只降级留证，不拖住整条关闭链。
      const remainingMs = (fallback) => (deadlineMs == null ? fallback : Math.max(1, deadlineMs - Date.now()));
      for (const controller of this.controllers.values()) controller.abort();
      const initialExecutions = [...this.executions.values()];
      if (initialExecutions.length) {
        let drainTimer;
        await Promise.race([
          Promise.allSettled(initialExecutions),
          new Promise((resolveTimeout) => { drainTimer = setTimeout(resolveTimeout, Math.min(2_000, remainingMs(2_000))); }),
        ]);
        clearTimeout(drainTimer);
      }
      const closeErrors = await Promise.all([...new Set(this.adapters.values())].map((adapter) => closeWithin(adapter, remainingMs(10_000))));
      for (const error of closeErrors.filter(Boolean)) {
        await this.eventStore.emit("adapter.close_degraded", { message: error.message }, { agentId: "control-plane" }).catch(() => {});
      }
      // 远程 run 专用 adapter 一并关闭（控制面关停绝不把远端常驻进程留成孤儿）；
      // 与主 adapter 共享同一剩余预算，迟到的远端关闭同样降级留证而不是无限等待。
      const remotePending = [...this.remoteAdapters.values()];
      this.remoteAdapters.clear();
      for (const pending of remotePending) {
        const pair = await pending.catch(() => null);
        for (const adapter of [pair?.adapter, pair?.fallback]) {
          if (typeof adapter?.close === "function") {
            const remoteError = await closeWithin(adapter, remainingMs(10_000));
            if (remoteError) {
              await this.eventStore.emit("adapter.close_degraded", { message: `remote: ${remoteError.message}` }, { agentId: "control-plane" }).catch(() => {});
            }
          }
        }
      }

      // Fixed-point drain: shutdown admission is closed, so every chain that appears here
      // was spawned by work already in flight. Waiting snapshots until all maps are empty
      // covers successor chains without deleting a newer owner under the same run key.
      // The shared shutdown deadline bounds this loop: overdue chains are reported and
      // left to their own abort semantics instead of stalling the whole close chain.
      const chainMaps = [this.executions, this.transitionChains, this.projectionChains, this.lifecycleChains, this.saveChains];
      while (chainMaps.some((map) => map.size)) {
        if (deadlineMs != null && Date.now() >= deadlineMs) {
          const pendingChains = chainMaps.reduce((total, map) => total + map.size, 0);
          void this.eventStore.emit("adapter.close_degraded", {
            message: `orchestrator close chain drain exceeded the shutdown deadline (${pendingChains} chain(s) still pending)`,
          }, { agentId: "control-plane" }).catch(() => {});
          break;
        }
        const snapshot = chainMaps.flatMap((map) => [...map.entries()].map(([key, chain]) => ({ map, key, chain })));
        let settled = true;
        if (deadlineMs != null) {
          const remaining = deadlineMs - Date.now();
          if (remaining <= 0) {
            settled = false;
          } else {
            let timer;
            settled = await Promise.race([
              Promise.allSettled(snapshot.map(({ chain }) => chain)).then(() => true),
              new Promise((resolveTimeout) => {
                timer = setTimeout(() => resolveTimeout(false), remaining);
              }),
            ]);
            clearTimeout(timer);
          }
        } else {
          await Promise.allSettled(snapshot.map(({ chain }) => chain));
        }
        if (!settled) {
          const pendingChains = chainMaps.reduce((total, map) => total + map.size, 0);
          void this.eventStore.emit("adapter.close_degraded", {
            message: `orchestrator close chain drain exceeded the shutdown deadline (${pendingChains} chain(s) still pending)`,
          }, { agentId: "control-plane" }).catch(() => {});
          break;
        }
        for (const { map, key, chain } of snapshot) {
          if (map.get(key) === chain) map.delete(key);
        }
      }
    });
    return this.closePromise;
  }

  isBusy() {
    return this.controllers.size > 0 || this.executions.size > 0;
  }

  swapRuntime({ router, adapters, policy, models = this.models }) {
    if (this.isBusy()) throw Object.assign(new Error("active runs prevent an atomic runtime graph swap"), { code: "RUNTIME_BUSY" });
    const previousAdapters = this.adapters;
    this.router = router;
    this.adapters = adapters;
    this.policy = policy;
    this.models = models;
    const retained = new Set(adapters.values());
    const retired = [...new Set(previousAdapters.values())].filter((adapter) => !retained.has(adapter));
    return Promise.all(retired.map((adapter) => closeWithin(adapter)))
      .then((results) => results.filter(Boolean).map((error) => error.message || String(error)));
  }

  async replaceRuntime(runtime) {
    return this.swapRuntime(runtime);
  }
}
