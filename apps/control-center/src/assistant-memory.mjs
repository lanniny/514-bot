/**
 * assistant-memory.mjs — 514cc 桌面助手跨会话可控记忆系统 (A5)。
 *
 * 区别于只读治理文件与 MEMORY.md，本模块为助手提供用户完全掌控的结构化记忆库：
 *   - 结构化条目：偏好、项目规则、经验事实与决策；
 *   - 用户可控：支持查看、增删改、置顶 (pinned) 与临时禁用 (enabled=false)；
 *   - 模型上下文安全注入：严格限制字节预算 (<= 8 KiB) 与条目数量 (<= 20)，不撑爆 API 上下文；
 *   - 磁盘持久化：原子重命名写入 dataRoot/assistant-memory.json，防并发冲突。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renameWithRetry } from "./atomic-rename.mjs";

export const ASSISTANT_MEMORY_SCHEMA = "514cc.assistant-memory/v1";
export const ASSISTANT_MEMORY_FILE = "assistant-memory.json";

export const MEMORY_CATEGORIES = Object.freeze([
  "preference",
  "project_rule",
  "workflow_fact",
  "decision",
]);

export const MEMORY_CATEGORY_LABELS = Object.freeze({
  preference: "偏好习惯",
  project_rule: "项目规则",
  workflow_fact: "工作流事实",
  decision: "关键决策",
});

export const MEMORY_LIMITS = Object.freeze({
  maxItems: 500,
  maxStoreBytes: 2 * 1024 * 1024,
  titleMax: 120,
  contentMax: 2000,
  promptMaxBytes: 8 * 1024,
  promptMaxItems: 20,
});

const CATEGORY_SET = new Set(MEMORY_CATEGORIES);

function fail(message, code = "VALIDATION_FAILED", details = {}) {
  throw Object.assign(new Error(message), { code, ...details });
}

function cleanText(value, label, max, { required = false, nullable = false } = {}) {
  if (value == null && nullable) return null;
  const text = String(value ?? "").trim();
  if (required && !text) fail(`${label} is required`);
  if (text.length > max) fail(`${label} exceeds ${max} characters`);
  return text;
}

function cleanId(value, label, { required = false } = {}) {
  const id = cleanText(value, label, 128, { required, nullable: !required });
  if (id && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    fail(`${label} contains unsupported characters`);
  }
  return id || null;
}

export function validateMemoryItem(raw, { isNew = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("memory item must be an object");
  }
  const id = isNew
    ? (raw.id ? cleanId(raw.id, "memory id") : `mem-${randomUUID()}`)
    : cleanId(raw.id, "memory id", { required: true });

  const category = cleanText(raw.category, "category", 32, { required: true });
  if (!CATEGORY_SET.has(category)) {
    fail(`unsupported memory category: ${category}`);
  }

  const title = cleanText(raw.title, "title", MEMORY_LIMITS.titleMax, { required: true });
  const content = cleanText(raw.content, "content", MEMORY_LIMITS.contentMax, { required: true });
  const pinned = raw.pinned === true;
  const enabled = raw.enabled !== false;
  const sourceConversationId = cleanId(raw.sourceConversationId, "sourceConversationId", { required: false });
  const sourceRunId = cleanId(raw.sourceRunId, "sourceRunId", { required: false });

  const now = new Date().toISOString();
  const createdAt = raw.createdAt ? new Date(raw.createdAt).toISOString() : now;
  const updatedAt = raw.updatedAt ? new Date(raw.updatedAt).toISOString() : now;

  return {
    id,
    category,
    title,
    content,
    pinned,
    enabled,
    sourceConversationId: sourceConversationId || null,
    sourceRunId: sourceRunId || null,
    createdAt,
    updatedAt,
  };
}

export function formatMemoryPromptChunk(memories, { maxBytes = MEMORY_LIMITS.promptMaxBytes, maxItems = MEMORY_LIMITS.promptMaxItems } = {}) {
  if (!Array.isArray(memories) || !memories.length) return "";

  const active = memories
    .filter((m) => m && m.enabled !== false)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
    })
    .slice(0, maxItems);

  if (!active.length) return "";

  const lines = ["[长期记忆与用户已知设定]"];
  for (const item of active) {
    const label = MEMORY_CATEGORY_LABELS[item.category] || item.category;
    const pinBadge = item.pinned ? "★ " : "";
    const line = `- ${pinBadge}[${label}] ${item.title}: ${item.content}`;
    const candidate = lines.concat(line).join("\n");
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) break;
    lines.push(line);
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

export class AssistantMemoryStore {
  #items = new Map();
  #queue = Promise.resolve();
  #closed = false;

  constructor({ dataRoot }) {
    if (!dataRoot) throw new Error("dataRoot is required");
    this.dataRoot = dataRoot;
    this.path = join(dataRoot, ASSISTANT_MEMORY_FILE);
  }

  #serialize(operation) {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async init() {
    await mkdir(this.dataRoot, { recursive: true });
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.schema !== ASSISTANT_MEMORY_SCHEMA || !Array.isArray(parsed.items)) {
        throw fail("corrupt assistant memory store schema", "MEMORY_STORE_CORRUPT");
      }
      this.#items.clear();
      for (const item of parsed.items) {
        const validated = validateMemoryItem(item);
        this.#items.set(validated.id, validated);
      }
    } catch (err) {
      if (err?.code === "ENOENT") {
        await this.#persist();
        return;
      }
      throw err;
    }
  }

  async #persist() {
    const envelope = {
      schema: ASSISTANT_MEMORY_SCHEMA,
      updatedAt: new Date().toISOString(),
      items: Array.from(this.#items.values()),
    };
    const body = JSON.stringify(envelope, null, 2);
    if (Buffer.byteLength(body, "utf8") > MEMORY_LIMITS.maxStoreBytes) {
      fail("memory store exceeds maximum byte limit", "MEMORY_STORE_TOO_LARGE");
    }
    const tempPath = `${this.path}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(tempPath, body, "utf8");
    await renameWithRetry(tempPath, this.path);
  }

  async list({ category = null, pinned = null, enabled = null, search = "" } = {}) {
    let items = Array.from(this.#items.values());

    if (category) {
      items = items.filter((item) => item.category === category);
    }
    if (pinned != null) {
      const isPinned = pinned === true || pinned === "true";
      items = items.filter((item) => item.pinned === isPinned);
    }
    if (enabled != null) {
      const isEnabled = enabled === true || enabled === "true";
      items = items.filter((item) => item.enabled === isEnabled);
    }
    if (search) {
      const q = search.trim().toLowerCase();
      items = items.filter(
        (item) => item.title.toLowerCase().includes(q) || item.content.toLowerCase().includes(q)
      );
    }

    return items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
  }

  async get(id) {
    const item = this.#items.get(id);
    if (!item) {
      throw fail(`memory item not found: ${id}`, "MEMORY_NOT_FOUND", { httpStatus: 404 });
    }
    return structuredClone(item);
  }

  async create(data) {
    return this.#serialize(async () => {
      if (this.#closed) fail("memory store is closed", "MEMORY_STORE_CLOSED");
      if (this.#items.size >= MEMORY_LIMITS.maxItems) {
        fail(`memory store reached maximum of ${MEMORY_LIMITS.maxItems} items`, "MEMORY_LIMIT_REACHED");
      }
      const item = validateMemoryItem(data, { isNew: true });
      if (this.#items.has(item.id)) {
        fail(`memory item already exists: ${item.id}`, "MEMORY_ALREADY_EXISTS");
      }
      this.#items.set(item.id, item);
      await this.#persist();
      return structuredClone(item);
    });
  }

  async update(id, updates) {
    return this.#serialize(async () => {
      if (this.#closed) fail("memory store is closed", "MEMORY_STORE_CLOSED");
      const existing = this.#items.get(id);
      if (!existing) {
        throw fail(`memory item not found: ${id}`, "MEMORY_NOT_FOUND", { httpStatus: 404 });
      }
      const merged = {
        ...existing,
        ...updates,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      };
      const validated = validateMemoryItem(merged);
      this.#items.set(id, validated);
      await this.#persist();
      return structuredClone(validated);
    });
  }

  async delete(id) {
    return this.#serialize(async () => {
      if (this.#closed) fail("memory store is closed", "MEMORY_STORE_CLOSED");
      if (!this.#items.has(id)) {
        throw fail(`memory item not found: ${id}`, "MEMORY_NOT_FOUND", { httpStatus: 404 });
      }
      this.#items.delete(id);
      await this.#persist();
      return { success: true, id };
    });
  }

  async getPromptChunk(options = {}) {
    const items = await this.list({ enabled: true });
    return formatMemoryPromptChunk(items, options);
  }

  close() {
    this.#closed = true;
  }
}
