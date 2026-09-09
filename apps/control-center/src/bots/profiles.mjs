/**
 * bots/profiles.mjs — 514 Bot 协作体系 · Bot 定义模型（Grok Bot 对标层一）。
 *
 * 对标 docs.x.ai/grok-bot/bots（Create and manage Bots）：
 *   Bot = durable AI teammate —— 名字 + 职位 + description（持久规则）+ 一份持续的 job。
 *   好的 job 用运营语言写：Owns 什么结果、拉哪些源、什么风格、哪些动作必须审批。
 *
 * 本模块是【叠加层】不是第二 roster：成员席位真源仍在 team-members.mjs
 * （runtimeProfileId / provider 绑定 / capabilities），这里只补 Grok 式「工作定义」：
 *   - job.owns / job.goals      —— 端到端结果所有权（Grok: "Owns: ..."）
 *   - standingRules             —— 持久规则（Grok: description 放 lasting rules，会话放任务指令）
 *   - approvalBoundary          —— 需审批动作 + 永不允许动作（fail-closed 清单）
 *   - skills                    —— 按 Bot 启用的 skill code（Grok: enabled per Bot）
 *   - handle（@别名）           —— 协作指派锚点（Grok: @ 提及 Bot）
 *   - routineQuota              —— 例行任务配额（Grok: 每 Bot 50 条）
 *
 * 治理纪律（对齐 team-members/automations 同源模式）：
 *   fail-closed 校验、密钥字面量拒绝入库、序列化互斥链、原子替换写盘、schema 版本化。
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { findSecretCandidates } from "../redaction.mjs";
import { renameWithRetry } from "../atomic-rename.mjs";

export const PROFILE_SCHEMA = "514cc.bot-profiles/v1";
export const PROFILE_STORE_FILE = "bot-profiles.json";

export const PROFILE_LIMITS = Object.freeze({
  maxProfiles: 512,          // 对齐 team-members MEMBER_MAX
  maxStoreBytes: 2 * 1024 * 1024,
  idMax: 128,                // memberId 上限（对齐 team-members ID_MAX）
  handleMax: 32,
  ownsMax: 2_000,            // job.owns 单段上限（对齐 team-members DESCRIPTION_MAX）
  goalsMax: 12,              // job.goals 条数
  goalTextMax: 240,
  rulesMax: 32,              // standingRules / requireApproval / neverAllowed 条数
  ruleTextMax: 240,
  skillsMax: 24,             // per-Bot 启用 skill 数
  skillCodeMax: 64,
  notesMax: 2_000,
});

const HANDLE_PATTERN = /^@[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SKILL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const PROFILE_FIELDS = new Set([
  "memberId",
  "handle",
  "job",
  "standingRules",
  "approvalBoundary",
  "skills",
  "routineQuota",
  "pinned",
  "hidden",
  "notes",
  "createdAt", // 持久化字段：读盘校验时容忍，不作为用户输入处理
  "updatedAt",
]);

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

function cleanMemberId(value) {
  if (typeof value !== "string") fail("memberId must be a string");
  const id = value.trim();
  if (!id || id.length > PROFILE_LIMITS.idMax || !ID_PATTERN.test(id)) fail("memberId is invalid");
  return id;
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

function cleanStringList(value, label, maxItems, itemMax) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (value.length > maxItems) fail(`${label} exceeds ${maxItems} items`);
  return value.map((item, index) => cleanText(item, `${label}[${index}]`, itemMax));
}

function cleanHandle(value, { required = true } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== "string") fail("handle must be a string");
  const handle = value.trim();
  if (!HANDLE_PATTERN.test(handle)) {
    fail("handle must match @name (letters/digits/dot/dash/underscore/colon, max 32 chars)");
  }
  return handle;
}

function defaultHandleFor(memberId) {
  // 默认 handle = @ + memberId（保证任何成员都可被 @ 指派，无需先建 profile）
  const candidate = `@${memberId}`;
  if (!HANDLE_PATTERN.test(candidate)) fail("memberId cannot derive a valid handle");
  return candidate;
}

function cleanSkillCodes(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail("skills must be an array");
  if (value.length > PROFILE_LIMITS.skillsMax) fail(`skills exceeds ${PROFILE_LIMITS.skillsMax} items`);
  return [...new Set(value.map((item, index) => {
    if (typeof item !== "string") fail(`skills[${index}] must be a string`);
    const code = item.trim();
    if (!code || code.length > PROFILE_LIMITS.skillCodeMax || !SKILL_CODE_PATTERN.test(code)) {
      fail(`skills[${index}] is not a valid skill code`);
    }
    return code;
  }))];
}

function cleanJob(value) {
  if (value == null) return { owns: "", goals: [] };
  assertPlainRecord(value, "job");
  for (const key of Object.keys(value)) {
    if (key !== "owns" && key !== "goals") fail(`job contains an unsupported field: ${key}`);
  }
  return {
    owns: cleanText(value.owns ?? "", "job.owns", PROFILE_LIMITS.ownsMax),
    goals: cleanStringList(value.goals, "job.goals", PROFILE_LIMITS.goalsMax, PROFILE_LIMITS.goalTextMax),
  };
}

function cleanApprovalBoundary(value) {
  if (value == null) return { requireApproval: [], neverAllowed: [] };
  assertPlainRecord(value, "approvalBoundary");
  for (const key of Object.keys(value)) {
    if (key !== "requireApproval" && key !== "neverAllowed") {
      fail(`approvalBoundary contains an unsupported field: ${key}`);
    }
  }
  return {
    requireApproval: cleanStringList(value.requireApproval, "approvalBoundary.requireApproval", PROFILE_LIMITS.rulesMax, PROFILE_LIMITS.ruleTextMax),
    neverAllowed: cleanStringList(value.neverAllowed, "approvalBoundary.neverAllowed", PROFILE_LIMITS.rulesMax, PROFILE_LIMITS.ruleTextMax),
  };
}

function cleanRoutineQuota(value) {
  if (value == null) return ROUTINE_QUOTA_DEFAULT;
  if (!Number.isSafeInteger(value) || value < 0 || value > 50) fail("routineQuota must be an integer between 0 and 50");
  return value;
}

export const ROUTINE_QUOTA_DEFAULT = 50; // Grok Bot: "A Bot can own up to 50 routines"

function normalizeProfileInput(memberId, input = {}) {
  assertPlainRecord(input, "profile");
  for (const key of Object.keys(input)) {
    if (!PROFILE_FIELDS.has(key)) fail(`profile contains an unsupported field: ${key}`);
  }
  return {
    memberId: cleanMemberId(memberId),
    handle: cleanHandle(input.handle ?? defaultHandleFor(memberId)),
    job: cleanJob(input.job),
    standingRules: cleanStringList(input.standingRules, "standingRules", PROFILE_LIMITS.rulesMax, PROFILE_LIMITS.ruleTextMax),
    approvalBoundary: cleanApprovalBoundary(input.approvalBoundary),
    skills: cleanSkillCodes(input.skills),
    routineQuota: cleanRoutineQuota(input.routineQuota),
    pinned: input.pinned === true,
    hidden: input.hidden === true,
    notes: cleanText(input.notes ?? "", "notes", PROFILE_LIMITS.notesMax, { nullable: true }) || null,
  };
}

function profileForPersistence(profile, existing = null) {
  const now = new Date().toISOString();
  return {
    memberId: profile.memberId,
    handle: profile.handle,
    job: profile.job,
    standingRules: profile.standingRules,
    approvalBoundary: profile.approvalBoundary,
    skills: profile.skills,
    routineQuota: profile.routineQuota,
    pinned: profile.pinned,
    hidden: profile.hidden,
    notes: profile.notes,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function validatePersistedStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("bot-profiles store has an unsupported shape", "PROFILE_STORE_INVALID");
  }
  if (value.schema !== PROFILE_SCHEMA || !Array.isArray(value.items)) {
    fail("bot-profiles store has an unsupported schema", "PROFILE_STORE_INVALID");
  }
  if (value.items.length > PROFILE_LIMITS.maxProfiles) fail("bot-profiles store exceeds the profile limit", "PROFILE_STORE_INVALID");
  const seenMembers = new Set();
  const seenHandles = new Set();
  for (const raw of value.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("bot-profile entry is malformed", "PROFILE_STORE_INVALID");
    const normalized = normalizeProfileInput(raw.memberId, raw);
    if (seenMembers.has(normalized.memberId)) fail(`duplicate profile for member ${normalized.memberId}`, "PROFILE_STORE_INVALID");
    if (seenHandles.has(normalized.handle)) fail(`duplicate handle ${normalized.handle}`, "PROFILE_STORE_INVALID");
    seenMembers.add(normalized.memberId);
    seenHandles.add(normalized.handle);
  }
  return {
    schema: PROFILE_SCHEMA,
    items: value.items.map((raw) => profileForPersistence(normalizeProfileInput(raw.memberId, raw), raw)),
  };
}

export class BotProfileStore {
  /**
   * @param {object} options
   * @param {string} options.dataRoot —— 控制面数据根（bot-profiles.json 落点）
   * @param {(memberId: string) => object|null} [options.resolveMember] —— 席位真源校验回调（teamMembers.get）
   *   传入时 upsert 校验成员存在，查不到 fail-closed；测试可注入假 roster。
   */
  constructor({ dataRoot, resolveMember = null } = {}) {
    if (!dataRoot || typeof dataRoot !== "string") fail("dataRoot is required");
    this.filePath = join(dataRoot, PROFILE_STORE_FILE);
    this.resolveMember = typeof resolveMember === "function" ? resolveMember : null;
    this.items = new Map(); // memberId -> profile
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
      throw Object.assign(new Error("bot-profiles store could not be read"), { code: "PROFILE_STORE_READ_FAILED", cause: error });
    }
    if (Buffer.byteLength(raw, "utf8") > PROFILE_LIMITS.maxStoreBytes) {
      this.storeStatus = { state: "error", source: "oversized", path: this.filePath };
      fail("bot-profiles store exceeds the size limit", "PROFILE_STORE_INVALID");
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.storeStatus = { state: "error", source: "corrupt-json", path: this.filePath };
      fail("bot-profiles store is not valid JSON", "PROFILE_STORE_INVALID");
    }
    const validated = validatePersistedStore(parsed);
    this.items = new Map(validated.items.map((profile) => [profile.memberId, profile]));
    this.storeStatus = { state: "ready", source: "loaded", path: this.filePath };
    return this;
  }

  async #persist(reason) {
    const payload = JSON.stringify({ schema: PROFILE_SCHEMA, items: [...this.items.values()] }, null, 2);
    if (Buffer.byteLength(payload, "utf8") > PROFILE_LIMITS.maxStoreBytes) {
      fail("bot-profiles store exceeds the size limit", "PROFILE_STORE_INVALID");
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
      fail(`bot-profiles store could not be written (${reason})`, "PROFILE_STORE_WRITE_FAILED", { causeCode: error?.code ?? null });
    }
  }

  #assertMemberKnown(memberId) {
    if (!this.resolveMember) return; // 未接席位真源时跳过（独立测试/导入模式）
    if (!this.resolveMember(memberId)) {
      fail(`member ${memberId} does not exist in the team roster`, "MEMBER_NOT_FOUND");
    }
  }

  #assertHandleFree(handle, exceptMemberId) {
    for (const [memberId, profile] of this.items) {
      if (memberId === exceptMemberId) continue;
      if (profile.handle === handle) fail(`handle ${handle} is already used by member ${memberId}`, "HANDLE_CONFLICT");
    }
  }

  list({ includeHidden = true } = {}) {
    return [...this.items.values()]
      .filter((profile) => includeHidden || !profile.hidden)
      .map((profile) => ({ ...profile, job: { ...profile.job }, approvalBoundary: { ...profile.approvalBoundary }, skills: [...profile.skills], standingRules: [...profile.standingRules] }))
      .sort((left, right) => left.memberId.localeCompare(right.memberId));
  }

  get(memberId) {
    return this.items.get(cleanMemberId(memberId)) ?? null;
  }

  /** @handle → memberId（协作指派解析；未建 profile 的成员回落默认 handle，但必须真实存在于 roster）。 */
  resolveHandle(handle) {
    if (typeof handle !== "string") return null;
    const normalized = handle.trim();
    if (HANDLE_PATTERN.test(normalized)) {
      for (const profile of this.items.values()) {
        if (profile.handle === normalized) return profile.memberId;
      }
      // 回落：@memberId 直接命中——只在成员真实存在（或未接 roster 的独立模式）时放行，
      // 否则 @ghost 也能被指派，kickoff/handoff 就失去 fail-closed 语义。
      const bare = normalized.slice(1);
      if (ID_PATTERN.test(bare) && bare.length <= PROFILE_LIMITS.idMax) {
        if (!this.resolveMember || this.resolveMember(bare)) return bare;
      }
      return null;
    }
    // 也接受裸 memberId（不带 @）
    if (ID_PATTERN.test(normalized) && normalized.length <= PROFILE_LIMITS.idMax) {
      if (!this.resolveMember || this.resolveMember(normalized)) return normalized;
    }
    return null;
  }

  /** 成员有效 handle（有 profile 用 profile.handle，否则默认 @memberId）。 */
  effectiveHandle(memberId) {
    const profile = this.items.get(memberId);
    return profile ? profile.handle : defaultHandleFor(memberId);
  }

  async upsert(memberId, input = {}) {
    const normalized = normalizeProfileInput(memberId, input);
    this.#assertMemberKnown(normalized.memberId);
    if (this.items.size >= PROFILE_LIMITS.maxProfiles && !this.items.has(normalized.memberId)) {
      fail(`bot-profiles store exceeds ${PROFILE_LIMITS.maxProfiles} profiles`, "PROFILE_LIMIT");
    }
    return serializeMutation(this.filePath, async () => {
      this.#assertHandleFree(normalized.handle, normalized.memberId);
      const existing = this.items.get(normalized.memberId) ?? null;
      const persisted = profileForPersistence(normalized, existing);
      this.items.set(normalized.memberId, persisted);
      await this.#persist(`upsert ${normalized.memberId}`);
      return { ...persisted };
    });
  }

  async remove(memberId) {
    const id = cleanMemberId(memberId);
    return serializeMutation(this.filePath, async () => {
      if (!this.items.delete(id)) fail(`profile for member ${id} does not exist`, "PROFILE_NOT_FOUND");
      await this.#persist(`remove ${id}`);
      return { removed: id };
    });
  }
}
