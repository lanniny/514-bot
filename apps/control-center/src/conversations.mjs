import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const CONVERSATION_SCHEMA = "514cc.conversations/v2";
export const LEGACY_CONVERSATION_SCHEMA = "514cc.conversations/v1";
export const CONVERSATION_KINDS = Object.freeze(["direct", "workspace_group", "legacy_pipeline"]);
export const CONVERSATION_SCOPES = Object.freeze(["global", "project"]);
export const CONVERSATION_ROOM_ROLES = Object.freeze(["default", "task"]);

const KIND_SET = new Set(CONVERSATION_KINDS);
const SCOPE_SET = new Set(CONVERSATION_SCOPES);
const ROOM_ROLE_SET = new Set(CONVERSATION_ROOM_ROLES);
const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const MAX_ITEMS = 2_000;
const MAX_RUNS = 500;

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

function cleanMemberIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail("memberIds must be an array");
  const ids = [...new Set(value.map((item) => cleanId(item, "member id", { required: true })))];
  if (ids.length > 40) fail("memberIds exceeds 40 entries");
  return ids;
}

function cleanRunIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail("runIds must be an array");
  const ids = [...new Set(value.map((item) => cleanId(item, "run id", { required: true })))];
  if (ids.length > MAX_RUNS) fail(`runIds exceeds ${MAX_RUNS} entries`);
  return ids;
}

function cleanTimestamp(value, label) {
  if (value == null || value === "") return null;
  const timestamp = String(value);
  if (!Number.isFinite(Date.parse(timestamp))) fail(`${label} must be an ISO timestamp`, "CONVERSATION_STORE_INVALID");
  return timestamp;
}

function cleanRevision(value, label = "revision") {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) fail(`${label} must be a non-negative safe integer`, "CONVERSATION_STORE_INVALID");
  return revision;
}

const MAX_PREVIEW_TEXT = 240;
const MAX_PREVIEW_FROM = 64;

// 最近消息预览（Grok 式列表副标题）是派生展示数据：磁盘上的坏值降级为 null，
// 不像 title 那样让整库 fail-closed；唯一写入通道是 noteMessagePreview——
// HTTP update/create 均不读取该字段，请求体无法伪造预览。
function cleanPreview(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const text = String(value.text ?? "").trim();
  if (!text || text.length > MAX_PREVIEW_TEXT) return null;
  const at = value.at == null ? null : String(value.at);
  if (at != null && !Number.isFinite(Date.parse(at))) return null;
  const from = String(value.from ?? "").trim().slice(0, MAX_PREVIEW_FROM) || null;
  return { text, from, at };
}

function compareUpdatedAt(left, right) {
  const a = left.updatedAt == null ? -1 : Date.parse(left.updatedAt);
  const b = right.updatedAt == null ? -1 : Date.parse(right.updatedAt);
  if (a === -1 && b === -1) return 0;
  if (a === -1) return 1;
  if (b === -1) return -1;
  return b - a;
}

function publicRecord(record, projects = null) {
  const value = structuredClone(record);
  if (record.projectId && projects) {
    const project = projects.get(record.projectId);
    value.cwd = project.canonicalCwd;
    value.projectTitle = project.title;
  } else {
    value.cwd = null;
    value.projectTitle = null;
  }
  return value;
}

function assertExpectedRevision(record, expectedRevision) {
  if (expectedRevision == null) return;
  const expected = Number(expectedRevision);
  if (!Number.isSafeInteger(expected) || expected < 0) {
    fail("expectedRevision must be a non-negative safe integer");
  }
  if (expected !== record.revision) {
    fail("conversation revision does not match", "CONVERSATION_REVISION_MISMATCH", {
      expectedRevision: expected,
      actualRevision: record.revision,
    });
  }
}

function assertExpectedStoreRevision(actualRevision, expectedRevision) {
  if (expectedRevision == null) return;
  const expected = Number(expectedRevision);
  if (!Number.isSafeInteger(expected) || expected < 0) {
    fail("expectedStoreRevision must be a non-negative safe integer");
  }
  if (expected !== actualRevision) {
    fail("conversation store revision does not match", "CONVERSATION_STORE_REVISION_MISMATCH", {
      expectedRevision: expected,
      actualRevision,
    });
  }
}

function normalizeRecord(raw, { legacy = false, project = null, roomRole = null } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("conversation record must be an object", "CONVERSATION_STORE_INVALID");
  const id = cleanId(raw.id, "conversation id", { required: true });
  const kind = cleanText(raw.kind, "conversation kind", 32, { required: true });
  if (!KIND_SET.has(kind)) fail(`unsupported conversation kind: ${kind}`, "CONVERSATION_STORE_INVALID");
  const memberIds = cleanMemberIds(raw.memberIds);
  const directMemberId = cleanId(raw.directMemberId, "directMemberId");
  const runIds = cleanRunIds(raw.runIds);
  const activeRunId = cleanId(raw.activeRunId, "activeRunId");
  const projectId = legacy
    ? project?.projectId || null
    : cleanId(raw.projectId, "projectId");
  const scope = legacy
    ? kind === "workspace_group" ? "project" : "global"
    : cleanText(raw.scope, "scope", 16, { required: true });
  const normalizedRoomRole = legacy
    ? roomRole || "task"
    : cleanText(raw.roomRole, "roomRole", 16, { required: true });
  if (!SCOPE_SET.has(scope)) fail(`unsupported conversation scope: ${scope}`, "CONVERSATION_STORE_INVALID");
  if (!ROOM_ROLE_SET.has(normalizedRoomRole)) fail(`unsupported conversation roomRole: ${normalizedRoomRole}`, "CONVERSATION_STORE_INVALID");
  if (activeRunId && !runIds.includes(activeRunId)) fail("activeRunId must be present in runIds", "CONVERSATION_STORE_INVALID");
  if (kind === "direct" && (!directMemberId || memberIds.length !== 1 || memberIds[0] !== directMemberId)) {
    fail("direct conversation must contain exactly its direct member", "CONVERSATION_STORE_INVALID");
  }
  if (kind === "workspace_group" && (!projectId || scope !== "project" || directMemberId)) {
    fail("workspace group must belong to a project and cannot have a direct member", "CONVERSATION_STORE_INVALID");
  }
  if (kind !== "workspace_group" && (projectId || scope !== "global" || normalizedRoomRole !== "task")) {
    fail("direct and legacy conversations must remain global task rooms", "CONVERSATION_STORE_INVALID");
  }
  return {
    id,
    kind,
    title: cleanText(raw.title, "title", 120, { required: true }),
    projectId,
    scope,
    roomRole: normalizedRoomRole,
    directMemberId: directMemberId || null,
    memberIds,
    runIds,
    activeRunId: activeRunId || null,
    pinned: raw.pinned === true,
    unread: raw.unread === true,
    preview: cleanPreview(raw.preview),
    hiddenAt: cleanTimestamp(raw.hiddenAt, "hiddenAt"),
    deletedAt: cleanTimestamp(raw.deletedAt, "deletedAt"),
    sourceConversationId: cleanId(raw.sourceConversationId, "sourceConversationId"),
    revision: cleanRevision(raw.revision),
    createdAt: cleanTimestamp(raw.createdAt, "createdAt"),
    updatedAt: cleanTimestamp(raw.updatedAt, "updatedAt"),
  };
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

export class ConversationStore {
  #items = new Map();
  #queue = Promise.resolve();
  #closed = false;

  constructor({ dataRoot, projects = null }) {
    this.dataRoot = dataRoot;
    this.projects = projects;
    this.path = join(dataRoot, "conversations.json");
    this.revision = 0;
    this.storeStatus = { state: "ready", failClosed: false, code: null, message: null };
  }

  #assertAvailable() {
    if (this.#closed) fail("conversation store is closed", "CONVERSATION_STORE_UNAVAILABLE");
    if (!this.storeStatus.failClosed) return;
    fail(this.storeStatus.message || "conversation store is unavailable", "CONVERSATION_STORE_UNAVAILABLE", {
      storeStatus: { ...this.storeStatus },
    });
  }

  #serialize(operation) {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }

  #public(record) {
    return publicRecord(record, this.projects);
  }

  markTransactionInconsistent(operation, cause, compensationError) {
    const message = `conversation transaction is inconsistent after ${operation}; operator recovery is required`;
    this.storeStatus = {
      state: "blocked",
      failClosed: true,
      code: "TRANSACTION_INCONSISTENT",
      message,
    };
    return Object.assign(new Error(message), {
      code: "TRANSACTION_INCONSISTENT",
      httpStatus: 503,
      recoveryRequired: true,
      operation,
      causeCode: cause?.code || null,
      compensationCode: compensationError?.code || null,
    });
  }

  async init() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (!parsed || ![CONVERSATION_SCHEMA, LEGACY_CONVERSATION_SCHEMA].includes(parsed.schema) || !Array.isArray(parsed.items)) {
        fail("conversations.json has an unsupported schema", "CONVERSATION_STORE_INVALID");
      }
      if (parsed.items.length > MAX_ITEMS) fail(`conversations.json exceeds ${MAX_ITEMS} records`, "CONVERSATION_STORE_INVALID");
      const items = new Map();
      const runOwners = new Map();
      const legacy = parsed.schema === LEGACY_CONVERSATION_SCHEMA;
      if (legacy && !this.projects) fail("legacy conversation migration requires a project registry", "CONVERSATION_STORE_INVALID");
      for (const raw of parsed.items) {
        let project = null;
        let roomRole = null;
        if (legacy && raw?.kind === "workspace_group") {
          project = await this.projects.ensure({ cwd: raw.cwd, title: raw.title });
          roomRole = project.defaultConversationId ? "task" : "default";
        }
        const item = normalizeRecord(raw, { legacy, project, roomRole });
        if (items.has(item.id)) fail(`duplicate conversation id: ${item.id}`, "CONVERSATION_STORE_INVALID");
        for (const runId of item.runIds) {
          const ownerId = runOwners.get(runId);
          if (ownerId && ownerId !== item.id) {
            fail(`run ${runId} is linked to multiple conversations`, "CONVERSATION_STORE_INVALID");
          }
          runOwners.set(runId, item.id);
        }
        if (item.projectId) {
          const persistedProject = this.projects?.get(item.projectId);
          if (!persistedProject) fail(`conversation project is unavailable: ${item.projectId}`, "CONVERSATION_STORE_INVALID");
          if (!item.deletedAt) await this.projects.attachConversation(item.projectId, item.id, { roomRole: item.roomRole });
        }
        items.set(item.id, item);
      }
      this.#items = items;
      this.revision = cleanRevision(parsed.revision);
      this.storeStatus = { state: "ready", failClosed: false, code: null, message: null };
      if (legacy) await this.#persist(items);
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.storeStatus = { state: "missing", failClosed: false, code: null, message: null };
      } else {
        this.storeStatus = {
          state: "blocked",
          failClosed: true,
          code: error instanceof SyntaxError ? "CONVERSATION_STORE_INVALID" : (error?.code || "CONVERSATION_STORE_UNREADABLE"),
          message: `conversation store cannot be verified: ${error.message}`,
        };
      }
    }
    return this;
  }

  status() {
    return { ...this.storeStatus, revision: this.revision, count: this.#items.size };
  }

  list({ includeHidden = false, includeDeleted = false } = {}) {
    this.#assertAvailable();
    return [...this.#items.values()]
      .filter((item) => (includeHidden || !item.hiddenAt) && (includeDeleted || !item.deletedAt))
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || compareUpdatedAt(left, right))
      .map((item) => this.#public(item));
  }

  get(id) {
    this.#assertAvailable();
    const record = this.#items.get(String(id));
    if (!record) fail("conversation not found", "CONVERSATION_NOT_FOUND");
    return this.#public(record);
  }

  referencesForMember(memberId) {
    this.#assertAvailable();
    const id = cleanId(memberId, "member id", { required: true });
    return [...this.#items.values()]
      .filter((item) => !item.deletedAt && item.memberIds.includes(id))
      .map((item) => `conversation:${item.id}`);
  }

  async withMemberReferenceGuard(memberId, mutation) {
    if (typeof mutation !== "function") fail("member guard mutation must be a function");
    return this.#serialize(async () => {
      const references = this.referencesForMember(memberId);
      if (references.length) {
        fail(`team member is referenced and cannot be deleted or rebound: ${memberId}`, "MEMBER_IN_USE", {
          memberId: String(memberId),
          references,
        });
      }
      return mutation();
    });
  }

  async #persist(nextItems) {
    this.#assertAvailable();
    await mkdir(this.dataRoot, { recursive: true });
    const nextRevision = this.revision + 1;
    const temp = join(this.dataRoot, `.conversations.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({
        schema: CONVERSATION_SCHEMA,
        revision: nextRevision,
        items: [...nextItems.values()],
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

  async create(input = {}) {
    return this.#serialize(async () => {
      this.#assertAvailable();
      if (this.#items.size >= MAX_ITEMS) fail(`conversation store exceeds ${MAX_ITEMS} records`, "CONVERSATION_STORE_UNAVAILABLE");
      const kind = cleanText(input.kind, "conversation kind", 32, { required: true });
      if (!KIND_SET.has(kind)) fail(`unsupported conversation kind: ${kind}`);
      const now = new Date().toISOString();
      let memberIds = cleanMemberIds(input.memberIds);
      let directMemberId = cleanId(input.directMemberId, "directMemberId");
      let project = null;
      let projectId = null;
      let scope = "global";
      let roomRole = "task";
      if (kind === "direct") {
        if (input.projectId || input.cwd || input.scope === "project") fail("direct conversations must remain global");
        directMemberId = cleanId(input.directMemberId ?? memberIds[0], "directMemberId", { required: true });
        if (memberIds.length && (memberIds.length !== 1 || memberIds[0] !== directMemberId)) {
          fail("direct conversation must contain exactly its direct member");
        }
        memberIds = [directMemberId];
      } else if (kind === "workspace_group") {
        if (!this.projects) fail("workspace conversations require a project registry", "PROJECT_STORE_UNAVAILABLE");
        project = input.projectId
          ? this.projects.get(cleanId(input.projectId, "projectId", { required: true }))
          : await this.projects.ensure({ cwd: input.cwd, title: input.projectTitle || input.title });
        if (project.archivedAt) fail("archived projects must be restored before adding conversations", "PROJECT_ARCHIVED", { projectId: project.projectId });
        projectId = project.projectId;
        scope = "project";
        roomRole = input.roomRole == null
          ? project.defaultConversationId ? "task" : "default"
          : cleanText(input.roomRole, "roomRole", 16, { required: true });
        if (!ROOM_ROLE_SET.has(roomRole)) fail("roomRole must be default or task");
        directMemberId = null;
      } else if (input.cwd || input.projectId || directMemberId || input.scope === "project") {
        fail("legacy pipeline conversations cannot bind a member or project");
      }
      const id = randomUUID();
      const runIds = cleanRunIds(input.runIds);
      const activeRunId = cleanId(input.activeRunId, "activeRunId");
      if (activeRunId && !runIds.includes(activeRunId)) runIds.push(activeRunId);
      const record = {
        id,
        kind,
        title: cleanText(input.title, "title", 120, { required: true }),
        projectId,
        scope,
        roomRole,
        directMemberId,
        memberIds,
        runIds,
        activeRunId,
        pinned: input.pinned === true,
        unread: input.unread === true,
        preview: null,
        hiddenAt: null,
        deletedAt: null,
        sourceConversationId: cleanId(input.sourceConversationId, "sourceConversationId"),
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      const next = new Map(this.#items);
      next.set(id, record);
      let projectLinked = false;
      try {
        if (projectId) {
          await this.projects.attachConversation(projectId, id, { roomRole });
          projectLinked = true;
        }
        await this.#persist(next);
      } catch (error) {
        if (projectLinked) {
          try {
            await this.projects.detachConversation(projectId, id);
          } catch (compensationError) {
            throw this.markTransactionInconsistent("conversation-create rollback", error, compensationError);
          }
        }
        throw error;
      }
      return this.#public(record);
    });
  }

  async update(id, input = {}) {
    return this.#serialize(async () => {
      this.#assertAvailable();
      const current = this.#items.get(String(id));
      if (!current) fail("conversation not found", "CONVERSATION_NOT_FOUND");
      if (current.deletedAt) fail("deleted conversation cannot be updated", "CONVERSATION_DELETED");
      assertExpectedRevision(current, input.expectedRevision);
      const nextRecord = { ...current };
      if (Object.hasOwn(input, "title")) nextRecord.title = cleanText(input.title, "title", 120, { required: true });
      if (Object.hasOwn(input, "pinned")) nextRecord.pinned = input.pinned === true;
      if (Object.hasOwn(input, "unread")) nextRecord.unread = input.unread === true;
      if (Object.hasOwn(input, "hidden")) nextRecord.hiddenAt = input.hidden === true ? new Date().toISOString() : null;
      if (Object.hasOwn(input, "memberIds")) {
        if (current.kind !== "workspace_group") fail("only workspace groups may change memberIds");
        nextRecord.memberIds = cleanMemberIds(input.memberIds);
        if (JSON.stringify(nextRecord.memberIds) !== JSON.stringify(current.memberIds)) nextRecord.activeRunId = null;
      }
      nextRecord.revision += 1;
      nextRecord.updatedAt = new Date().toISOString();
      const next = new Map(this.#items);
      next.set(nextRecord.id, nextRecord);
      await this.#persist(next);
      return this.#public(nextRecord);
    });
  }

  // Grok 式列表预览的唯一写入通道（内部字段纪律：update/create 不碰 preview）。
  // 调用方是事件订阅回填（user.message / assistant.message），at 取事件时间戳；
  // 乱序/迟到事件不允许把 updatedAt 倒车——排序锚点只前进。
  async noteMessagePreview(id, { text, from = null, at = null } = {}) {
    return this.#serialize(async () => {
      this.#assertAvailable();
      const current = this.#items.get(String(id));
      if (!current) fail("conversation not found", "CONVERSATION_NOT_FOUND");
      if (current.deletedAt) fail("deleted conversation cannot accept previews", "CONVERSATION_DELETED");
      const stamp = cleanTimestamp(at, "preview.at") || new Date().toISOString();
      const preview = cleanPreview({ text, from, at: stamp });
      if (!preview) fail("preview text is required");
      const currentStamp = Date.parse(current.updatedAt || "") || 0;
      const nextStamp = Date.parse(stamp) || 0;
      const nextRecord = {
        ...current,
        preview,
        revision: current.revision + 1,
        updatedAt: nextStamp > currentStamp ? stamp : current.updatedAt,
      };
      const next = new Map(this.#items);
      next.set(nextRecord.id, nextRecord);
      await this.#persist(next);
      return this.#public(nextRecord);
    });
  }

  async attachRun(id, runId, { activate = true } = {}) {
    return this.#serialize(async () => {
      this.#assertAvailable();
      const current = this.#items.get(String(id));
      if (!current) fail("conversation not found", "CONVERSATION_NOT_FOUND");
      if (current.deletedAt) fail("deleted conversation cannot accept runs", "CONVERSATION_DELETED");
      if (current.projectId) {
        if (!this.projects) fail("project conversation cannot be verified", "PROJECT_STORE_UNAVAILABLE");
        const project = this.projects.get(current.projectId);
        if (project.archivedAt) fail("archived projects must be restored before starting runs", "PROJECT_ARCHIVED", { projectId: project.projectId });
      }
      const normalizedRunId = cleanId(runId, "run id", { required: true });
      const conflictingOwner = [...this.#items.values()].find((item) => (
        item.id !== current.id && item.runIds.includes(normalizedRunId)
      ));
      if (conflictingOwner) {
        fail("run is already linked to another conversation", "RUN_CONVERSATION_CONFLICT", {
          runId: normalizedRunId,
          conversationId: current.id,
          ownerConversationId: conflictingOwner.id,
        });
      }
      const runIds = current.runIds.includes(normalizedRunId)
        ? [...current.runIds]
        : [...current.runIds, normalizedRunId].slice(-MAX_RUNS);
      const nextRecord = {
        ...current,
        runIds,
        activeRunId: activate ? normalizedRunId : current.activeRunId,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const next = new Map(this.#items);
      next.set(nextRecord.id, nextRecord);
      await this.#persist(next);
      return this.#public(nextRecord);
    });
  }

  async detachRun(id, runId) {
    return this.#serialize(async () => {
      this.#assertAvailable();
      const current = this.#items.get(String(id));
      if (!current) fail("conversation not found", "CONVERSATION_NOT_FOUND");
      const normalizedRunId = cleanId(runId, "run id", { required: true });
      if (!current.runIds.includes(normalizedRunId)) return this.#public(current);
      const runIds = current.runIds.filter((item) => item !== normalizedRunId);
      const nextRecord = {
        ...current,
        runIds,
        activeRunId: current.activeRunId === normalizedRunId ? (runIds.at(-1) || null) : current.activeRunId,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const next = new Map(this.#items);
      next.set(nextRecord.id, nextRecord);
      await this.#persist(next);
      return this.#public(nextRecord);
    });
  }

  async duplicate(id, input = {}) {
    const source = this.get(id);
    assertExpectedRevision(source, input.expectedRevision);
    return this.create({
      kind: source.kind,
      title: cleanText(input.title || `${source.title} 副本`, "title", 120, { required: true }),
      directMemberId: source.directMemberId,
      memberIds: source.memberIds,
      projectId: source.kind === "workspace_group" && !input.cwd ? source.projectId : null,
      cwd: source.kind === "workspace_group" ? input.cwd : null,
      roomRole: source.kind === "workspace_group" ? "task" : "task",
      sourceConversationId: source.id,
    });
  }

  async remove(id, { expectedRevision = null } = {}) {
    return this.#serialize(async () => {
      this.#assertAvailable();
      const current = this.#items.get(String(id));
      if (!current) fail("conversation not found", "CONVERSATION_NOT_FOUND");
      assertExpectedRevision(current, expectedRevision);
      if (current.deletedAt) return this.#public(current);
      const now = new Date().toISOString();
      const nextRecord = { ...current, deletedAt: now, hiddenAt: now, revision: current.revision + 1, updatedAt: now };
      const next = new Map(this.#items);
      next.set(nextRecord.id, nextRecord);
      let projectDetached = false;
      try {
        if (current.projectId && this.projects) {
          await this.projects.detachConversation(current.projectId, current.id);
          projectDetached = true;
        }
        await this.#persist(next);
      } catch (error) {
        if (projectDetached) {
          try {
            await this.projects.attachConversation(current.projectId, current.id, { roomRole: current.roomRole });
          } catch (compensationError) {
            throw this.markTransactionInconsistent("conversation-remove rollback", error, compensationError);
          }
        }
        throw error;
      }
      return this.#public(nextRecord);
    });
  }

  async purgeDeleted({ expectedStoreRevision = null } = {}) {
    return this.#serialize(async () => {
      this.#assertAvailable();
      assertExpectedStoreRevision(this.revision, expectedStoreRevision);
      const deletedItems = [...this.#items.values()].filter((item) => item.deletedAt);
      const purgeable = deletedItems.filter((item) => !item.activeRunId && item.runIds.length === 0);
      const skipped = deletedItems
        .filter((item) => !purgeable.includes(item))
        .map((item) => ({ conversationId: item.id, reason: item.activeRunId ? "active-run" : "run-history" }));
      const deletedIds = purgeable.map((item) => item.id);
      if (!deletedIds.length) {
        return { purged: 0, conversationIds: [], skipped, revision: this.revision };
      }
      const deleted = new Set(deletedIds);
      const next = new Map([...this.#items].filter(([id]) => !deleted.has(id)));
      await this.#persist(next);
      return { purged: deletedIds.length, conversationIds: deletedIds, skipped, revision: this.revision };
    });
  }

  async close() {
    this.#closed = true;
    await this.#queue.catch(() => {});
    return { closed: true };
  }
}
