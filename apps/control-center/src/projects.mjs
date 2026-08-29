import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, join, parse, resolve } from "node:path";
import { inspectProjectIdentity } from "./project-bridge.mjs";

export const PROJECT_SCHEMA = "514cc.projects/v1";

const MAX_PROJECTS = 500;
const MAX_CONVERSATIONS = 2_000;
const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

function fail(message, code = "VALIDATION_FAILED", details = {}) {
  throw Object.assign(new Error(message), { code, ...details });
}

function cleanText(value, label, max = 120, { required = false } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) fail(`${label} is required`);
  if (text.length > max) fail(`${label} exceeds ${max} characters`);
  return text;
}

function cleanId(value, label, { required = false } = {}) {
  const id = cleanText(value, label, 160, { required });
  if (id && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) fail(`${label} contains unsupported characters`);
  return id || null;
}

function cleanRevision(value, label = "revision") {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) fail(`${label} must be a non-negative safe integer`, "PROJECT_STORE_INVALID");
  return revision;
}

function cleanTimestamp(value, label) {
  if (value == null || value === "") return null;
  const timestamp = String(value);
  if (!Number.isFinite(Date.parse(timestamp))) fail(`${label} must be an ISO timestamp`, "PROJECT_STORE_INVALID");
  return timestamp;
}

function cleanConversationIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail("conversationIds must be an array", "PROJECT_STORE_INVALID");
  const ids = [...new Set(value.map((item) => cleanId(item, "conversation id", { required: true })))];
  if (ids.length > MAX_CONVERSATIONS) fail(`conversationIds exceeds ${MAX_CONVERSATIONS} entries`, "PROJECT_STORE_INVALID");
  return ids;
}

function pathKey(value) {
  let normalized = resolve(String(value));
  const root = parse(normalized).root;
  while (normalized.length > root.length && /[\\/]$/.test(normalized)) normalized = normalized.slice(0, -1);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("project record must be an object", "PROJECT_STORE_INVALID");
  const canonicalCwd = cleanText(raw.canonicalCwd, "canonicalCwd", 4_096, { required: true });
  const conversationIds = cleanConversationIds(raw.conversationIds);
  const defaultConversationId = cleanId(raw.defaultConversationId, "defaultConversationId");
  if (defaultConversationId && !conversationIds.includes(defaultConversationId)) {
    fail("defaultConversationId must be present in conversationIds", "PROJECT_STORE_INVALID");
  }
  return {
    projectId: cleanId(raw.projectId, "projectId", { required: true }),
    anchorId: cleanId(raw.anchorId, "anchorId", { required: true }),
    title: cleanText(raw.title, "title", 120, { required: true }),
    canonicalCwd,
    cwdKey: pathKey(canonicalCwd),
    previousCwd: raw.previousCwd ? cleanText(raw.previousCwd, "previousCwd", 4_096) : null,
    defaultConversationId,
    conversationIds,
    pinned: raw.pinned === true,
    archivedAt: cleanTimestamp(raw.archivedAt, "archivedAt"),
    revision: cleanRevision(raw.revision),
    createdAt: cleanTimestamp(raw.createdAt, "createdAt"),
    updatedAt: cleanTimestamp(raw.updatedAt, "updatedAt"),
  };
}

function compareUpdatedAt(left, right) {
  const a = left.updatedAt == null ? -1 : Date.parse(left.updatedAt);
  const b = right.updatedAt == null ? -1 : Date.parse(right.updatedAt);
  if (a === -1 && b === -1) return 0;
  if (a === -1) return 1;
  if (b === -1) return -1;
  return b - a;
}

function publicRecord(record) {
  const { cwdKey: _cwdKey, ...value } = record;
  return structuredClone(value);
}

function assertExpectedRevision(record, expectedRevision) {
  if (expectedRevision == null) return;
  const expected = Number(expectedRevision);
  if (!Number.isSafeInteger(expected) || expected < 0) {
    fail("expectedRevision must be a non-negative safe integer");
  }
  if (expected !== record.revision) {
    fail("project revision does not match", "PROJECT_REVISION_MISMATCH", {
      expectedRevision: expected,
      actualRevision: record.revision,
    });
  }
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_ERRORS.has(error?.code) || attempt >= 4) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10 * (2 ** attempt)));
    }
  }
}

export class ProjectRegistry {
  #items = new Map();
  #queue = Promise.resolve();
  #closed = false;

  constructor({ dataRoot, identityResolver = inspectProjectIdentity }) {
    this.dataRoot = dataRoot;
    this.path = join(dataRoot, "projects.json");
    this.identityResolver = identityResolver;
    this.revision = 0;
    this.storeStatus = { state: "ready", failClosed: false, code: null, message: null };
  }

  #assertAvailable() {
    if (this.#closed) fail("project registry is closed", "PROJECT_STORE_UNAVAILABLE");
    if (!this.storeStatus.failClosed) return;
    fail(this.storeStatus.message || "project registry is unavailable", "PROJECT_STORE_UNAVAILABLE", {
      storeStatus: { ...this.storeStatus },
    });
  }

  #serialize(operation) {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }

  #findByCwdKey(cwdKey) {
    return [...this.#items.values()].find((item) => item.cwdKey === cwdKey) || null;
  }

  async init() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (!parsed || parsed.schema !== PROJECT_SCHEMA || !Array.isArray(parsed.items)) {
        fail("projects.json has an unsupported schema", "PROJECT_STORE_INVALID");
      }
      if (parsed.items.length > MAX_PROJECTS) fail(`projects.json exceeds ${MAX_PROJECTS} records`, "PROJECT_STORE_INVALID");
      const items = new Map();
      const cwdKeys = new Set();
      for (const raw of parsed.items) {
        const item = normalizeRecord(raw);
        if (items.has(item.projectId)) fail(`duplicate project id: ${item.projectId}`, "PROJECT_STORE_INVALID");
        if (cwdKeys.has(item.cwdKey)) fail(`duplicate project cwd: ${item.canonicalCwd}`, "PROJECT_STORE_INVALID");
        items.set(item.projectId, item);
        cwdKeys.add(item.cwdKey);
      }
      this.#items = items;
      this.revision = cleanRevision(parsed.revision);
      this.storeStatus = { state: "ready", failClosed: false, code: null, message: null };
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.storeStatus = { state: "missing", failClosed: false, code: null, message: null };
      } else {
        this.storeStatus = {
          state: "blocked",
          failClosed: true,
          code: error instanceof SyntaxError ? "PROJECT_STORE_INVALID" : (error?.code || "PROJECT_STORE_UNREADABLE"),
          message: `project registry cannot be verified: ${error.message}`,
        };
      }
    }
    return this;
  }

  status() {
    return { ...this.storeStatus, revision: this.revision, count: this.#items.size };
  }

  list({ includeArchived = false } = {}) {
    this.#assertAvailable();
    return [...this.#items.values()]
      .filter((item) => includeArchived || !item.archivedAt)
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || compareUpdatedAt(left, right))
      .map(publicRecord);
  }

  get(projectId) {
    this.#assertAvailable();
    const record = this.#items.get(String(projectId));
    if (!record) fail("project not found", "PROJECT_NOT_FOUND");
    return publicRecord(record);
  }

  async findByCwd(cwd) {
    this.#assertAvailable();
    const identity = await this.identityResolver(cwd);
    const record = this.#findByCwdKey(pathKey(identity.canonicalCwd));
    return record ? publicRecord(record) : null;
  }

  async #persist(nextItems) {
    this.#assertAvailable();
    await mkdir(this.dataRoot, { recursive: true });
    const nextRevision = this.revision + 1;
    const temp = join(this.dataRoot, `.projects.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({
        schema: PROJECT_SCHEMA,
        revision: nextRevision,
        items: [...nextItems.values()].map(publicRecord),
      }, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await renameWithRetry(temp, this.path);
      this.#items = nextItems;
      this.revision = nextRevision;
      this.storeStatus = { state: "ready", failClosed: false, code: null, message: null };
    } finally {
      await handle?.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  async ensure(input = {}) {
    return this.#serialize(async () => {
      this.#assertAvailable();
      const identity = await this.identityResolver(input.cwd);
      const cwdKey = pathKey(identity.canonicalCwd);
      const existing = this.#findByCwdKey(cwdKey);
      if (existing) return publicRecord(existing);
      if (this.#items.size >= MAX_PROJECTS) fail(`project registry exceeds ${MAX_PROJECTS} records`, "PROJECT_STORE_UNAVAILABLE");
      const collision = this.#items.get(identity.projectId);
      if (collision) {
        fail("project identity collides with another canonical cwd", "PROJECT_ID_CONFLICT", {
          projectId: identity.projectId,
          canonicalCwd: collision.canonicalCwd,
        });
      }
      const now = new Date().toISOString();
      const record = {
        projectId: identity.projectId,
        anchorId: identity.anchorId,
        title: cleanText(input.title || basename(identity.canonicalCwd) || identity.canonicalCwd, "title", 120, { required: true }),
        canonicalCwd: identity.canonicalCwd,
        cwdKey,
        previousCwd: null,
        defaultConversationId: null,
        conversationIds: [],
        pinned: input.pinned === true,
        archivedAt: null,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      const next = new Map(this.#items);
      next.set(record.projectId, record);
      await this.#persist(next);
      return publicRecord(record);
    });
  }

  async update(projectId, input = {}) {
    return this.#serialize(async () => {
      this.#assertAvailable();
      const current = this.#items.get(String(projectId));
      if (!current) fail("project not found", "PROJECT_NOT_FOUND");
      assertExpectedRevision(current, input.expectedRevision);
      const nextRecord = { ...current };
      if (Object.hasOwn(input, "title")) nextRecord.title = cleanText(input.title, "title", 120, { required: true });
      if (Object.hasOwn(input, "pinned")) nextRecord.pinned = input.pinned === true;
      if (Object.hasOwn(input, "archived")) nextRecord.archivedAt = input.archived === true ? new Date().toISOString() : null;
      nextRecord.revision += 1;
      nextRecord.updatedAt = new Date().toISOString();
      const next = new Map(this.#items);
      next.set(nextRecord.projectId, nextRecord);
      await this.#persist(next);
      return publicRecord(nextRecord);
    });
  }

  async attachConversation(projectId, conversationId, { roomRole = "task" } = {}) {
    return this.#serialize(async () => {
      this.#assertAvailable();
      const current = this.#items.get(String(projectId));
      if (!current) fail("project not found", "PROJECT_NOT_FOUND");
      const id = cleanId(conversationId, "conversation id", { required: true });
      const role = cleanText(roomRole, "roomRole", 16, { required: true });
      if (!["default", "task"].includes(role)) fail("roomRole must be default or task");
      if (role === "default" && current.defaultConversationId && current.defaultConversationId !== id) {
        fail("project already has a default collaboration room", "PROJECT_DEFAULT_CONVERSATION_CONFLICT", {
          conversationId: current.defaultConversationId,
        });
      }
      if (current.conversationIds.includes(id)
        && (role !== "default" || current.defaultConversationId === id)) {
        return publicRecord(current);
      }
      if (current.archivedAt) {
        fail("archived projects must be restored before adding conversations", "PROJECT_ARCHIVED", {
          projectId: current.projectId,
        });
      }
      const conversationIds = current.conversationIds.includes(id)
        ? [...current.conversationIds]
        : [...current.conversationIds, id];
      const nextRecord = {
        ...current,
        conversationIds,
        defaultConversationId: role === "default" ? id : current.defaultConversationId,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const next = new Map(this.#items);
      next.set(nextRecord.projectId, nextRecord);
      await this.#persist(next);
      return publicRecord(nextRecord);
    });
  }

  async detachConversation(projectId, conversationId) {
    return this.#serialize(async () => {
      this.#assertAvailable();
      const current = this.#items.get(String(projectId));
      if (!current) fail("project not found", "PROJECT_NOT_FOUND");
      const id = cleanId(conversationId, "conversation id", { required: true });
      if (!current.conversationIds.includes(id)) return publicRecord(current);
      const nextRecord = {
        ...current,
        conversationIds: current.conversationIds.filter((item) => item !== id),
        defaultConversationId: current.defaultConversationId === id ? null : current.defaultConversationId,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const next = new Map(this.#items);
      next.set(nextRecord.projectId, nextRecord);
      await this.#persist(next);
      return publicRecord(nextRecord);
    });
  }

  async close() {
    this.#closed = true;
    await this.#queue.catch(() => {});
    return { closed: true };
  }
}
