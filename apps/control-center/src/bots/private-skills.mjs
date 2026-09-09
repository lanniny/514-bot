/**
 * bots/private-skills.mjs — 514 Bot 协作体系 · LO 私有技能（Grok Bot 对标补全）。
 *
 * 对标 docs.x.ai/grok-bot/skills-routines-and-automations（Private skills）：
 *   用户级可复用流程（Name / Description / Instructions），与 per-Bot 的 profile.skills
 *   （启用清单）分工不同——这里是「技能本体的用户库」，那里是「谁启用了什么」。
 *
 * 治理纪律（对齐 profiles.mjs 同源模式）：
 *   fail-closed 校验、密钥字面量拒绝入库、序列化互斥链、原子替换写盘、schema 版本化。
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { findSecretCandidates } from "../redaction.mjs";
import { renameWithRetry } from "../atomic-rename.mjs";

export const PRIVATE_SKILL_SCHEMA = "514cc.bot-private-skills/v1";
export const PRIVATE_SKILL_STORE_FILE = "bot-private-skills.json";

export const PRIVATE_SKILL_LIMITS = Object.freeze({
  maxSkills: 50,            // 对齐 Grok private skills 量级（514 取保守上限）
  maxStoreBytes: 512 * 1024,
  nameMax: 80,
  descriptionMax: 200,
  instructionsMax: 4_000,
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function fail(message, code = "VALIDATION_FAILED", details = undefined) {
  throw Object.assign(new Error(message), { code, details });
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

function cleanText(value, label, max, { required = false } = {}) {
  if (typeof value !== "string") fail(`${label} must be a string`);
  const text = value.trim();
  if (required && !text) fail(`${label} is required`);
  if (text.length > max) fail(`${label} exceeds ${max} characters`);
  if (findSecretCandidates(text).length) {
    fail(`${label} contains secret-like material; use a credential reference instead`, "SENSITIVE_PROMPT");
  }
  return text;
}

function normalizeSkill(raw, existing = null) {
  assertPlainRecord(raw, "private skill");
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? randomUUID(),
    name: cleanText(raw.name, "name", PRIVATE_SKILL_LIMITS.nameMax, { required: true }),
    description: cleanText(raw.description, "description", PRIVATE_SKILL_LIMITS.descriptionMax, { required: true }),
    instructions: cleanText(raw.instructions, "instructions", PRIVATE_SKILL_LIMITS.instructionsMax, { required: true }),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function validatePersistedStore(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("private-skills store must be an object", "PRIVATE_SKILL_STORE_INVALID");
  if (parsed.schema !== PRIVATE_SKILL_SCHEMA) fail("private-skills store has an unsupported schema", "PRIVATE_SKILL_STORE_INVALID");
  if (!Array.isArray(parsed.items)) fail("private-skills store items must be an array", "PRIVATE_SKILL_STORE_INVALID");
  if (parsed.items.length > PRIVATE_SKILL_LIMITS.maxSkills) fail(`private-skills store exceeds ${PRIVATE_SKILL_LIMITS.maxSkills} items`, "PRIVATE_SKILL_STORE_INVALID");
  const seen = new Set();
  const items = parsed.items.map((raw) => {
    const skill = normalizeSkill(raw);
    if (seen.has(skill.id)) fail(`duplicate private skill id: ${skill.id}`, "PRIVATE_SKILL_STORE_INVALID");
    seen.add(skill.id);
    return skill;
  });
  return { items };
}

export class BotPrivateSkillStore {
  constructor({ dataRoot } = {}) {
    if (!dataRoot || typeof dataRoot !== "string") fail("dataRoot is required");
    this.filePath = join(dataRoot, PRIVATE_SKILL_STORE_FILE);
    this.items = new Map(); // id -> skill
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
      throw Object.assign(new Error("private-skills store could not be read"), { code: "PRIVATE_SKILL_STORE_READ_FAILED", cause: error });
    }
    if (Buffer.byteLength(raw, "utf8") > PRIVATE_SKILL_LIMITS.maxStoreBytes) {
      this.storeStatus = { state: "error", source: "oversized", path: this.filePath };
      fail("private-skills store exceeds the size limit", "PRIVATE_SKILL_STORE_INVALID");
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.storeStatus = { state: "error", source: "corrupt-json", path: this.filePath };
      fail("private-skills store is not valid JSON", "PRIVATE_SKILL_STORE_INVALID");
    }
    const validated = validatePersistedStore(parsed);
    this.items = new Map(validated.items.map((skill) => [skill.id, skill]));
    this.storeStatus = { state: "ready", source: "loaded", path: this.filePath };
    return this;
  }

  async #persist(reason) {
    const payload = JSON.stringify({ schema: PRIVATE_SKILL_SCHEMA, items: [...this.items.values()] }, null, 2);
    if (Buffer.byteLength(payload, "utf8") > PRIVATE_SKILL_LIMITS.maxStoreBytes) {
      fail("private-skills store exceeds the size limit", "PRIVATE_SKILL_STORE_INVALID");
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
      fail(`private-skills store could not be written (${reason})`, "PRIVATE_SKILL_STORE_WRITE_FAILED", { causeCode: error?.code ?? null });
    }
  }

  list() {
    return [...this.items.values()]
      .map((skill) => ({ ...skill }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  get(id) {
    const key = typeof id === "string" ? id.trim() : "";
    if (!key || !ID_PATTERN.test(key)) return null;
    return this.items.get(key) ?? null;
  }

  async create(input = {}) {
    return serializeMutation(this.filePath, async () => {
      if (this.items.size >= PRIVATE_SKILL_LIMITS.maxSkills) {
        fail(`private skills exceed the ${PRIVATE_SKILL_LIMITS.maxSkills} item limit`, "PRIVATE_SKILL_QUOTA_EXCEEDED");
      }
      const skill = normalizeSkill(input);
      this.items.set(skill.id, skill);
      await this.#persist(`create ${skill.id}`);
      return { ...skill };
    });
  }

  async update(id, patch = {}) {
    return serializeMutation(this.filePath, async () => {
      const current = this.get(id);
      if (!current) fail(`private skill ${id} does not exist`, "PRIVATE_SKILL_NOT_FOUND");
      const skill = normalizeSkill({ ...current, ...patch }, current);
      this.items.set(skill.id, skill);
      await this.#persist(`update ${skill.id}`);
      return { ...skill };
    });
  }

  async remove(id) {
    return serializeMutation(this.filePath, async () => {
      const current = this.get(id);
      if (!current) fail(`private skill ${id} does not exist`, "PRIVATE_SKILL_NOT_FOUND");
      this.items.delete(current.id);
      await this.#persist(`remove ${current.id}`);
      return { removed: current.id };
    });
  }
}
