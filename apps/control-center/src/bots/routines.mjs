/**
 * bots/routines.mjs — 514 Bot 协作体系 · 例行任务层（Grok Bot 对标层三）。
 *
 * 对标 docs.x.ai/grok-bot/skills-routines-and-automations（Skills and routines）：
 *   - routine = owning Bot +（skill 或内联指令）+ schedule + 输入源 + 期望产出
 *     + 审批边界 + 缺数据策略；创建即确认六要素（Grok "Confirm:" 清单）。
 *   - Test before enabling：Test run 先行（本层为 dry-run 计划装配，真实执行仍走
 *     orchestrator 全准入链——分两步是诚实边界，不是半成品）。
 *   - A Bot can own up to 50 routines；app keeps the 20 most recent run records。
 *   - Design routines for trust：先草稿后执行、外部动作审批后、缺数据报告失败而非用旧数据
 *     （noDataPolicy 不允许 stale-data 默认）、幂等重试。
 *
 * 桥接策略（不造第二调度器）：真实调度复用 AutomationStore——enable 时把 routine 翻译成
 * automation（toAutomationSpec）并记录 automationRef；pause → automation.enabled=false；
 * 删除 routine 联动删除 automation。桥接失败 fail-closed：routine 保持 enabled=false 并报错，
 * 不留下「看起来在跑其实没接电」的假状态。
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { findSecretCandidates } from "../redaction.mjs";
import { renameWithRetry } from "../atomic-rename.mjs";
import { scheduleIntervalMs, parseAtSchedule } from "../automations.mjs";

export const ROUTINE_SCHEMA = "514cc.bot-routines/v1";
export const ROUTINE_STORE_FILE = "bot-routines.json";

export const ROUTINE_LIMITS = Object.freeze({
  maxRoutines: 512,
  perBotDefault: 50,          // Grok Bot: "A Bot can own up to 50 routines"
  maxStoreBytes: 2 * 1024 * 1024,
  idMax: 128,
  titleMax: 120,
  skillRefMax: 64,
  instructionsMax: 8_000,
  expectedOutputMax: 240,
  approvalBoundaryMax: 240,
  notesMax: 2_000,
  runHistoryMax: 20,         // Grok: "the app keeps the 20 most recent run records for each routine"
});

export const NO_DATA_POLICIES = Object.freeze(["report-failure", "skip-and-report"]);
export const INPUT_SOURCE_KINDS = Object.freeze(["prompt", "conversation"]);

const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// 用户可写字段。内部字段（automationRef/testRun/runHistory/createdAt/updatedAt）
// 仅供读盘校验容忍——normalizeRoutineInput 接受它们的存在但【绝不读取其值】；
// automationRef 唯一写入通道是 setAutomationRef（桥接接线成功后回写），
// 客户端在 PUT 体里伪造 automationRef 会被静默丢弃（探子 2026-09-09 致命1 修复）。
const ROUTINE_USER_FIELDS = new Set([
  "id",
  "owningMemberId",
  "title",
  "skillRef",
  "instructions",
  "schedule",
  "inputSource",
  "expectedOutput",
  "approvalBoundary",
  "noDataPolicy",
  "enabled",
  "notes",
]);
const ROUTINE_INTERNAL_FIELDS = new Set(["automationRef", "testRun", "runHistory", "createdAt", "updatedAt"]);
const ROUTINE_FIELDS = new Set([...ROUTINE_USER_FIELDS, ...ROUTINE_INTERNAL_FIELDS]);

function fail(message, code = "VALIDATION_FAILED", details = undefined) {
  throw Object.assign(new Error(message), { code }, details);
}

function serializeMutation(path, operation) {
  const previous = MUTATION_CHAINS.get(path) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.catch(() => {});
  MUTATION_CHAINS.set(path, tail);
  void tail.then(() => {
    if (MUTATION_CHAINS.get(path) === tail) MUTATION_CHAINS.delete(path);
  });
  return result;
}
const MUTATION_CHAINS = new Map();

function assertPlainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} has an unsafe prototype`);
  for (const key of Object.keys(value)) {
    if (PROTOTYPE_KEYS.has(key)) fail(`${label} contains a forbidden key: ${key}`);
  }
  return value;
}

function cleanText(value, label, max, { required = false, nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== "string") fail(`${label} must be a string`);
  const text = value.trim();
  if (required && !text) fail(`${label} is required`);
  if (text.length > max) fail(`${label} exceeds ${max} characters`);
  if (findSecretCandidates(text).length) {
    fail(`${label} contains secret-like material; use a credential reference instead`, "SENSITIVE_PROMPT");
  }
  return text;
}

function cleanMemberId(value) {
  if (typeof value !== "string") fail("owningMemberId must be a string");
  const id = value.trim();
  if (!id || id.length > ROUTINE_LIMITS.idMax || !ID_PATTERN.test(id)) fail("owningMemberId is invalid");
  return id;
}

function cleanSchedule(value) {
  if (typeof value !== "string") fail("schedule must be a string");
  const schedule = value.trim();
  if (!schedule) fail("schedule is required");
  if (schedule === "manual") return schedule;
  if (scheduleIntervalMs(schedule) == null && parseAtSchedule(schedule) == null) {
    fail('schedule must be "manual", "every:N(m|h|d)", or "at:HH:MM@1-7" (same grammar as automations)');
  }
  return schedule;
}

function cleanSkillRef(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") fail("skillRef must be a string");
  const ref = value.trim();
  if (!ref || ref.length > ROUTINE_LIMITS.skillRefMax || !ID_PATTERN.test(ref)) fail("skillRef is invalid");
  return ref;
}

function cleanInputSource(value) {
  if (value == null) return { kind: "prompt", value: "" };
  assertPlainRecord(value, "inputSource");
  for (const key of Object.keys(value)) {
    if (key !== "kind" && key !== "value") fail(`inputSource contains an unsupported field: ${key}`);
  }
  const kind = value.kind == null ? "prompt" : String(value.kind);
  if (!INPUT_SOURCE_KINDS.includes(kind)) fail(`inputSource.kind must be one of ${INPUT_SOURCE_KINDS.join(", ")}`);
  return { kind, value: cleanText(value.value ?? "", `inputSource.value`, 2_000) };
}

function cleanNoDataPolicy(value) {
  if (value == null || value === "") return null; // 缺省在 routineForPersistence 补 report-failure
  if (!NO_DATA_POLICIES.includes(value)) {
    fail(`noDataPolicy must be one of ${NO_DATA_POLICIES.join(", ")}; using stale data is never an option`);
  }
  return value;
}

/** 指令来源必须有且仅有一处：skillRef（可复用技能）或 instructions（内联指令）。 */
function assertInstructionSource(skillRef, instructions) {
  if (skillRef && instructions) {
    fail("skillRef and instructions are mutually exclusive; reference a saved skill or inline the steps", "ROUTINE_AMBIGUOUS_SOURCE");
  }
  if (!skillRef && !instructions) {
    fail("a routine needs either a skillRef or inline instructions", "ROUTINE_MISSING_SOURCE");
  }
}

function cleanRoutineId(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") fail("routine id must be a string");
  const id = value.trim();
  // 非法 id 一旦写盘，下次 init 的 validatePersistedStore 会把整个 store 读砖（探子 2026-09-09 高危2）——入口即拒
  if (!ID_PATTERN.test(id) || id.length > ROUTINE_LIMITS.idMax) fail("routine id is invalid");
  return id;
}

function normalizeRoutineInput(input = {}) {
  assertPlainRecord(input, "routine");
  for (const key of Object.keys(input)) {
    if (!ROUTINE_FIELDS.has(key)) fail(`routine contains an unsupported field: ${key}`);
  }
  const skillRef = cleanSkillRef(input.skillRef);
  const instructions = cleanText(input.instructions ?? "", "instructions", ROUTINE_LIMITS.instructionsMax);
  assertInstructionSource(skillRef, instructions);
  return {
    id: cleanRoutineId(input.id),
    owningMemberId: cleanMemberId(input.owningMemberId),
    title: cleanText(input.title, "title", ROUTINE_LIMITS.titleMax, { required: true }),
    skillRef,
    instructions: instructions || null,
    schedule: cleanSchedule(input.schedule),
    inputSource: cleanInputSource(input.inputSource),
    // Grok "Confirm: The expected result / The approval boundary" —— 两项必填
    expectedOutput: cleanText(input.expectedOutput, "expectedOutput", ROUTINE_LIMITS.expectedOutputMax, { required: true }),
    approvalBoundary: cleanText(input.approvalBoundary, "approvalBoundary", ROUTINE_LIMITS.approvalBoundaryMax, { required: true }),
    noDataPolicy: cleanNoDataPolicy(input.noDataPolicy),
    enabled: input.enabled === true,
    notes: cleanText(input.notes ?? "", "notes", ROUTINE_LIMITS.notesMax, { nullable: true }) || null,
    // automationRef/testRun/runHistory 不从此函数读取：内部字段只走专用通道
  };
}

function routineForPersistence(routine, existing = null) {
  const now = new Date().toISOString();
  return {
    id: routine.id ?? randomUUID(),
    owningMemberId: routine.owningMemberId,
    title: routine.title,
    skillRef: routine.skillRef,
    instructions: routine.instructions,
    schedule: routine.schedule,
    inputSource: routine.inputSource,
    expectedOutput: routine.expectedOutput,
    approvalBoundary: routine.approvalBoundary,
    noDataPolicy: routine.noDataPolicy ?? "report-failure", // 缺省 = 报告失败，绝不用旧数据冒充（design for trust）
    enabled: routine.enabled,
    // automationRef 唯一来源 = 既有记录或 setAutomationRef；用户输入永不直达
    automationRef: routine.automationRef ?? existing?.automationRef ?? null,
    testRun: existing?.testRun ?? null,
    runHistory: routine.runHistory ?? existing?.runHistory ?? [],
    notes: routine.notes,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function validatePersistedStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("bot-routines store has an unsupported shape", "ROUTINE_STORE_INVALID");
  if (value.schema !== ROUTINE_SCHEMA || !Array.isArray(value.items)) {
    fail("bot-routines store has an unsupported schema", "ROUTINE_STORE_INVALID");
  }
  if (value.items.length > ROUTINE_LIMITS.maxRoutines) fail("bot-routines store exceeds the routine limit", "ROUTINE_STORE_INVALID");
  const seenIds = new Set();
  for (const raw of value.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("routine entry is malformed", "ROUTINE_STORE_INVALID");
    const normalized = normalizeRoutineInput(raw);
    if (!raw.id || !ID_PATTERN.test(raw.id)) fail("routine id is invalid", "ROUTINE_STORE_INVALID");
    if (seenIds.has(raw.id)) fail(`duplicate routine id ${raw.id}`, "ROUTINE_STORE_INVALID");
    if (!normalized.noDataPolicy) fail("routine noDataPolicy is required on disk", "ROUTINE_STORE_INVALID");
    if (normalized.owningMemberId == null) fail("routine owningMemberId is required", "ROUTINE_STORE_INVALID");
    seenIds.add(raw.id);
  }
  return { schema: ROUTINE_SCHEMA, items: value.items };
}

/**
 * 装配发给执行 Bot 的 routine 指令（prompt）——把 Grok 的六要素确认清单机械化：
 * 指令来源 + 输入源 + 期望产出 + 审批边界 + 缺数据策略 + 持久规则。
 */
export function renderRoutinePrompt(routine, profile = null) {
  const lines = [];
  lines.push(`【例行任务】${routine.title}`);
  if (routine.skillRef) lines.push(`【技能】按已保存 skill "${routine.skillRef}" 的流程执行。`);
  if (routine.instructions) lines.push(`【指令】\n${routine.instructions}`);
  if (routine.inputSource.kind === "prompt" && routine.inputSource.value) {
    lines.push(`【输入】${routine.inputSource.value}`);
  } else if (routine.inputSource.kind === "conversation") {
    lines.push("【输入】以当前会话上下文为准。");
  }
  lines.push(`【期望产出】${routine.expectedOutput}`);
  lines.push(`【审批边界】${routine.approvalBoundary}`);
  lines.push(`【缺数据策略】${routine.noDataPolicy}（缺源时报告失败，绝不使用旧数据冒充新结果）。`);
  if (profile?.job?.owns) lines.push(`【职责】${profile.job.owns}`);
  if (profile?.standingRules?.length) lines.push(`【持久规则】\n${profile.standingRules.map((rule) => `- ${rule}`).join("\n")}`);
  if (profile?.approvalBoundary?.requireApproval?.length) {
    lines.push(`【需审批动作】\n${profile.approvalBoundary.requireApproval.map((rule) => `- ${rule}`).join("\n")}`);
  }
  if (profile?.approvalBoundary?.neverAllowed?.length) {
    lines.push(`【禁止动作】\n${profile.approvalBoundary.neverAllowed.map((rule) => `- ${rule}`).join("\n")}`);
  }
  return lines.join("\n\n");
}

/**
 * 桥接翻译：routine → AutomationStore.create 输入。
 * 幂等键绑定 routine id：enable→disable→enable 不会创建第二条 automation。
 */
export function toAutomationSpec(routine, profile = null) {
  const prompt = renderRoutinePrompt(routine, profile);
  if (!prompt.trim()) fail("routine prompt assembly is empty", "ROUTINE_PROMPT_EMPTY");
  return {
    name: `[routine] ${routine.title}`,
    prompt,
    schedule: routine.schedule,
    teamId: "team-514cc",
    requestedAgentIds: [routine.owningMemberId],
    enabled: routine.enabled,
    // 关联不靠 automation.sources（它有独立 schema）：routine.automationRef 是单一回写点
  };
}

export class BotRoutineStore {
  /**
   * @param {object} options
   * @param {string} options.dataRoot
   * @param {(memberId: string) => object|null} [options.resolveMember] —— owning Bot 席位校验
   * @param {(memberId: string) => number} [options.routineQuotaFor] —— per-Bot 配额查询（来自 profile，缺省 50）
   */
  constructor({ dataRoot, resolveMember = null, routineQuotaFor = null, resolveProfile = null } = {}) {
    if (!dataRoot || typeof dataRoot !== "string") fail("dataRoot is required");
    this.filePath = join(dataRoot, ROUTINE_STORE_FILE);
    this.resolveMember = typeof resolveMember === "function" ? resolveMember : null;
    this.routineQuotaFor = typeof routineQuotaFor === "function" ? routineQuotaFor : null;
    this.resolveProfile = typeof resolveProfile === "function" ? resolveProfile : null;
    this.items = new Map(); // id -> routine
    this.storeStatus = { state: "uninitialized", source: null, path: this.filePath };
  }

  status() {
    return { ...this.storeStatus, count: this.items.size };
  }

  async init() {
    let raw;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.items = new Map();
        this.storeStatus = { state: "ready", source: "missing-default", path: this.filePath };
        return this;
      }
      this.storeStatus = { state: "error", source: "read-failed", path: this.filePath, code: error?.code ?? null };
      throw Object.assign(new Error("bot-routines store could not be read"), { code: "ROUTINE_STORE_READ_FAILED", cause: error });
    }
    if (Buffer.byteLength(raw, "utf8") > ROUTINE_LIMITS.maxStoreBytes) {
      this.storeStatus = { state: "error", source: "oversized", path: this.filePath };
      fail("bot-routines store exceeds the size limit", "ROUTINE_STORE_INVALID");
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.storeStatus = { state: "error", source: "corrupt-json", path: this.filePath };
      fail("bot-routines store is not valid JSON", "ROUTINE_STORE_INVALID");
    }
    const validated = validatePersistedStore(parsed);
    this.items = new Map(validated.items.map((routine) => [routine.id, routineForPersistence(routine)]));
    this.storeStatus = { state: "ready", source: "loaded", path: this.filePath };
    return this;
  }

  async #persist(reason) {
    const payload = JSON.stringify({ schema: ROUTINE_SCHEMA, items: [...this.items.values()] }, null, 2);
    if (Buffer.byteLength(payload, "utf8") > ROUTINE_LIMITS.maxStoreBytes) {
      fail("bot-routines store exceeds the size limit", "ROUTINE_STORE_INVALID");
    }
    const directory = join(this.filePath, "..");
    await mkdir(directory, { recursive: true });
    const tempPath = `${this.filePath}.tmp-${randomUUID()}`;
    let handle;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(`${payload}\n`, "utf8");
      await handle.sync();
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    try {
      await renameWithRetry(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      fail(`bot-routines store could not be written (${reason})`, "ROUTINE_STORE_WRITE_FAILED", { causeCode: error?.code ?? null });
    }
  }

  #assertMemberKnown(memberId) {
    if (!this.resolveMember) return;
    if (!this.resolveMember(memberId)) {
      fail(`member ${memberId} does not exist in the team roster`, "MEMBER_NOT_FOUND");
    }
  }

  #assertQuota(owningMemberId, exceptRoutineId = null) {
    const owned = [...this.items.values()].filter(
      (routine) => routine.owningMemberId === owningMemberId && routine.id !== exceptRoutineId,
    ).length;
    const quota = this.routineQuotaFor ? this.routineQuotaFor(owningMemberId) : ROUTINE_LIMITS.perBotDefault;
    if (Number.isSafeInteger(quota) && owned >= quota) {
      fail(`member ${owningMemberId} already owns ${owned} routines (quota ${quota})`, "ROUTINE_QUOTA_EXCEEDED");
    }
  }

  list({ owningMemberId = null, includeDisabled = true } = {}) {
    return [...this.items.values()]
      .filter((routine) => (owningMemberId ? routine.owningMemberId === owningMemberId : true))
      .filter((routine) => includeDisabled || routine.enabled)
      .sort((left, right) => (Date.parse(right.updatedAt) - Date.parse(left.updatedAt)) || left.id.localeCompare(right.id))
      .map((routine) => ({ ...routine, inputSource: { ...routine.inputSource }, runHistory: [...routine.runHistory] }));
  }

  get(id) {
    if (typeof id !== "string" || !id.trim()) return null;
    return this.items.get(id) ?? null;
  }

  async create(input = {}) {
    const normalized = normalizeRoutineInput(input);
    this.#assertMemberKnown(normalized.owningMemberId);
    if (this.items.size >= ROUTINE_LIMITS.maxRoutines) fail(`bot-routines store exceeds ${ROUTINE_LIMITS.maxRoutines} routines`, "ROUTINE_LIMIT");
    this.#assertQuota(normalized.owningMemberId);
    return serializeMutation(this.filePath, async () => {
      const persisted = routineForPersistence({ ...normalized, id: normalized.id ?? randomUUID() });
      if (this.items.has(persisted.id)) fail(`routine ${persisted.id} already exists`, "ROUTINE_CONFLICT");
      this.items.set(persisted.id, persisted);
      await this.#persist(`create ${persisted.id}`);
      return { ...persisted };
    });
  }

  async update(id, patch = {}) {
    const routineId = typeof id === "string" ? id.trim() : "";
    return serializeMutation(this.filePath, async () => {
      const current = this.items.get(routineId);
      if (!current) fail(`routine ${routineId} does not exist`, "ROUTINE_NOT_FOUND");
      const merged = normalizeRoutineInput({
        ...current,
        ...patch,
        id: routineId,
        // 结构化字段整体替换（不深合并嵌套对象）；内部字段不回灌
        inputSource: patch.inputSource ?? current.inputSource,
      });
      this.#assertMemberKnown(merged.owningMemberId);
      this.#assertQuota(merged.owningMemberId, routineId);
      const persisted = routineForPersistence(merged, current);
      this.items.set(routineId, persisted);
      await this.#persist(`update ${routineId}`);
      return { ...persisted };
    });
  }

  async remove(id) {
    const routineId = typeof id === "string" ? id.trim() : "";
    return serializeMutation(this.filePath, async () => {
      const removed = this.items.get(routineId);
      if (!removed) fail(`routine ${routineId} does not exist`, "ROUTINE_NOT_FOUND");
      this.items.delete(routineId);
      await this.#persist(`remove ${routineId}`);
      return { removed: routineId, automationRef: removed.automationRef };
    });
  }

  /** 记录 automation 桥接引用（enable 接线成功后回写）。 */
  async setAutomationRef(id, automationRef) {
    const routineId = typeof id === "string" ? id.trim() : "";
    return serializeMutation(this.filePath, async () => {
      const current = this.items.get(routineId);
      if (!current) fail(`routine ${routineId} does not exist`, "ROUTINE_NOT_FOUND");
      const ref = automationRef == null ? null : String(automationRef).trim() || null;
      const persisted = { ...current, automationRef: ref, updatedAt: new Date().toISOString() };
      this.items.set(routineId, persisted);
      await this.#persist(`automationRef ${routineId}`);
      return { ...persisted };
    });
  }

  /**
   * Test run（dry-run 计划装配）：只产出「将如何执行」的计划快照，不触发 orchestrator。
   * Grok: "A test run performs real work" —— 真实试跑走 enable 后的 automation.trigger；
   * 本方法承担的是「先看装配对不对」这一步，输出如实标注 plan-only。
   */
  async testRun(id) {
    const routineId = typeof id === "string" ? id.trim() : "";
    return serializeMutation(this.filePath, async () => {
      const routine = this.items.get(routineId);
      if (!routine) fail(`routine ${routineId} does not exist`, "ROUTINE_NOT_FOUND");
      const profile = this.resolveProfile ? this.resolveProfile(routine.owningMemberId) : null;
      const plan = {
        mode: "plan-only",
        promptPreview: renderRoutinePrompt(routine, profile),
        schedule: routine.schedule,
        owningMemberId: routine.owningMemberId,
        approvalBoundary: routine.approvalBoundary,
        noDataPolicy: routine.noDataPolicy,
        nextFireHint: routine.schedule === "manual" ? "manual" : "scheduled",
      };
      const testRun = { lastTestAt: new Date().toISOString(), status: "planned" };
      const persisted = { ...routine, testRun, updatedAt: new Date().toISOString() };
      this.items.set(routineId, persisted);
      await this.#persist(`testRun ${routineId}`);
      return { routineId, testRun, plan };
    });
  }

  /** 追加运行历史（供 automation 桥接回调；保留最近 runHistoryMax 条——对齐 Grok 20 条）。 */
  async appendRunHistory(id, entry) {
    const routineId = typeof id === "string" ? id.trim() : "";
    return serializeMutation(this.filePath, async () => {
      const current = this.items.get(routineId);
      if (!current) fail(`routine ${routineId} does not exist`, "ROUTINE_NOT_FOUND");
      const history = [...current.runHistory];
      history.push({
        at: new Date().toISOString(),
        runId: typeof entry?.runId === "string" ? entry.runId : null,
        source: typeof entry?.source === "string" ? entry.source : "manual",
        status: typeof entry?.status === "string" ? entry.status : "unknown",
      });
      const persisted = { ...current, runHistory: history.slice(-ROUTINE_LIMITS.runHistoryMax), updatedAt: new Date().toISOString() };
      this.items.set(routineId, persisted);
      await this.#persist(`runHistory ${routineId}`);
      return { ...persisted };
    });
  }
}
