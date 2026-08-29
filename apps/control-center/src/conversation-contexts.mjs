import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const CONVERSATION_CONTEXT_SCHEMA = "514cc.conversation-contexts/v1";

const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const MAX_ITEMS = 2_000;
const MAX_BINDINGS = 40;

function fail(message, code = "CONVERSATION_CONTEXT_STORE_INVALID", details = {}) {
  throw Object.assign(new Error(message), { code, ...details });
}

function cleanText(value, label, max, { required = false } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) fail(`${label} is required`);
  if (text.length > max) fail(`${label} exceeds ${max} characters`);
  return text || null;
}

function cleanId(value, label, { required = false } = {}) {
  const id = cleanText(value, label, 200, { required });
  if (id && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) fail(`${label} contains unsupported characters`);
  return id;
}

function cleanRevision(value, label = "revision") {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) fail(`${label} must be a non-negative safe integer`);
  return revision;
}

function cleanTimestamp(value, label) {
  if (value == null || value === "") return null;
  const timestamp = String(value);
  if (!Number.isFinite(Date.parse(timestamp))) fail(`${label} must be an ISO timestamp`);
  return timestamp;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function cleanBinding(raw, memberId = null) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("context binding must be an object");
  const normalizedMemberId = cleanId(memberId ?? raw.memberId, "memberId", { required: true });
  const sessionId = cleanText(raw.sessionId, "sessionId", 1_000, { required: true });
  const runtimeProfileId = cleanId(raw.runtimeProfileId, "runtimeProfileId", { required: true });
  const adapterId = cleanId(raw.adapterId, "adapterId", { required: true });
  const protocol = cleanText(raw.protocol, "protocol", 120, { required: true });
  const sourceRunId = cleanId(raw.sourceRunId, "sourceRunId", { required: true });
  return {
    memberId: normalizedMemberId,
    sessionId,
    runtimeProfileId,
    adapterId,
    protocol,
    providerBinding: raw.providerBinding == null ? null : structuredClone(raw.providerBinding),
    sessionResumable: raw.sessionResumable === true,
    sourceRunId,
    sourceAttemptId: cleanId(raw.sourceAttemptId, "sourceAttemptId"),
    ownerRunId: cleanId(raw.ownerRunId, "ownerRunId") || sourceRunId,
    cwdKey: cleanText(raw.cwdKey, "cwdKey", 2_048),
    remoteKey: cleanText(raw.remoteKey, "remoteKey", 2_048),
    claimedAt: cleanTimestamp(raw.claimedAt, "claimedAt"),
    updatedAt: cleanTimestamp(raw.updatedAt, "updatedAt"),
  };
}

function cleanRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("context record must be an object");
  const bindings = {};
  const rawBindings = raw.bindings == null ? {} : raw.bindings;
  if (!rawBindings || typeof rawBindings !== "object" || Array.isArray(rawBindings)) fail("bindings must be an object");
  const entries = Object.entries(rawBindings);
  if (entries.length > MAX_BINDINGS) fail(`bindings exceeds ${MAX_BINDINGS} entries`);
  for (const [memberId, binding] of entries) bindings[memberId] = cleanBinding(binding, memberId);
  const epoch = Number(raw.epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 1) fail("epoch must be a positive safe integer");
  return {
    conversationId: cleanId(raw.conversationId, "conversationId", { required: true }),
    epoch,
    topologyKey: cleanText(raw.topologyKey, "topologyKey", 200, { required: true }),
    bindings,
    revision: cleanRevision(raw.revision),
    createdAt: cleanTimestamp(raw.createdAt, "createdAt"),
    updatedAt: cleanTimestamp(raw.updatedAt, "updatedAt"),
  };
}

function bindingMatchesCandidate(binding, candidate) {
  return binding.sessionResumable === true
    && binding.runtimeProfileId === candidate.runtimeProfileId
    && binding.adapterId === candidate.adapterId
    && binding.cwdKey === (candidate.cwdKey || null)
    && binding.remoteKey === (candidate.remoteKey || null)
    && stableJson(binding.providerBinding) === stableJson(candidate.providerBinding ?? null);
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

export class ConversationContextStore {
  #items = new Map();
  #queue = Promise.resolve();
  #closed = false;

  constructor({ dataRoot }) {
    this.dataRoot = dataRoot;
    this.path = join(dataRoot, "conversation-contexts.json");
    this.revision = 0;
    this.storeStatus = { state: "ready", failClosed: false, code: null, message: null };
  }

  #assertAvailable() {
    if (this.#closed) fail("conversation context store is closed", "CONVERSATION_CONTEXT_STORE_UNAVAILABLE");
    if (!this.storeStatus.failClosed) return;
    fail(this.storeStatus.message || "conversation context store is unavailable", "CONVERSATION_CONTEXT_STORE_UNAVAILABLE", {
      storeStatus: { ...this.storeStatus },
    });
  }

  #serialize(operation) {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async init() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (!parsed || parsed.schema !== CONVERSATION_CONTEXT_SCHEMA || !Array.isArray(parsed.items)) {
        fail("conversation-contexts.json has an unsupported schema");
      }
      if (parsed.items.length > MAX_ITEMS) fail(`conversation-contexts.json exceeds ${MAX_ITEMS} records`);
      const items = new Map();
      for (const raw of parsed.items) {
        const item = cleanRecord(raw);
        if (items.has(item.conversationId)) fail(`duplicate conversation context: ${item.conversationId}`);
        items.set(item.conversationId, item);
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
          code: error instanceof SyntaxError ? "CONVERSATION_CONTEXT_STORE_INVALID" : (error?.code || "CONVERSATION_CONTEXT_STORE_UNREADABLE"),
          message: `conversation context store cannot be verified: ${error.message}`,
        };
      }
    }
    return this;
  }

  status() {
    return { ...this.storeStatus, revision: this.revision, count: this.#items.size };
  }

  get(conversationId) {
    this.#assertAvailable();
    const record = this.#items.get(String(conversationId));
    return record ? structuredClone(record) : null;
  }

  async #persist(nextItems) {
    this.#assertAvailable();
    await mkdir(this.dataRoot, { recursive: true });
    const nextRevision = this.revision + 1;
    const temp = join(this.dataRoot, `.conversation-contexts.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({
        schema: CONVERSATION_CONTEXT_SCHEMA,
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
    } catch (error) {
      this.storeStatus = {
        state: "blocked",
        failClosed: true,
        code: "CONVERSATION_CONTEXT_STORE_UNAVAILABLE",
        message: `conversation context store write failed: ${error.message}`,
      };
      throw error;
    } finally {
      await handle?.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  async claim({ conversationId, topologyKey, runId, candidates = [], ownerIsActive = () => false }) {
    return this.#serialize(async () => {
      this.#assertAvailable();
      const id = cleanId(conversationId, "conversationId", { required: true });
      const key = cleanText(topologyKey, "topologyKey", 200, { required: true });
      const normalizedRunId = cleanId(runId, "runId", { required: true });
      const now = new Date().toISOString();
      const current = this.#items.get(id) || null;
      const topologyChanged = Boolean(current && current.topologyKey !== key);
      const base = !current || topologyChanged
        ? {
            conversationId: id,
            epoch: (current?.epoch || 0) + 1,
            topologyKey: key,
            bindings: {},
            revision: (current?.revision || -1) + 1,
            createdAt: current?.createdAt || now,
            updatedAt: now,
          }
        : structuredClone(current);
      const inherited = {};
      let changed = !current || topologyChanged;
      for (const rawCandidate of candidates) {
        const candidate = {
          memberId: cleanId(rawCandidate.memberId, "memberId", { required: true }),
          runtimeProfileId: cleanId(rawCandidate.runtimeProfileId, "runtimeProfileId", { required: true }),
          adapterId: cleanId(rawCandidate.adapterId, "adapterId", { required: true }),
          providerBinding: rawCandidate.providerBinding == null ? null : structuredClone(rawCandidate.providerBinding),
          cwdKey: cleanText(rawCandidate.cwdKey, "cwdKey", 2_048),
          remoteKey: cleanText(rawCandidate.remoteKey, "remoteKey", 2_048),
        };
        const binding = base.bindings[candidate.memberId];
        if (!binding || !bindingMatchesCandidate(binding, candidate)) continue;
        const ownerRunId = binding.ownerRunId || binding.sourceRunId;
        const ownerAvailable = ownerRunId === normalizedRunId
          || ownerIsActive(ownerRunId) !== true;
        if (!ownerAvailable) continue;
        binding.ownerRunId = normalizedRunId;
        binding.claimedAt = now;
        binding.updatedAt = now;
        inherited[candidate.memberId] = structuredClone(binding);
        changed = true;
      }
      if (changed) {
        base.revision += current && !topologyChanged ? 1 : 0;
        base.updatedAt = now;
        const next = new Map(this.#items);
        next.set(id, base);
        await this.#persist(next);
      }
      return {
        conversationId: id,
        epoch: base.epoch,
        topologyChanged,
        inherited,
        revision: base.revision,
      };
    });
  }

  async publish({ conversationId, topologyKey, runId, binding, ownerIsValid = () => true }) {
    return this.#serialize(async () => {
      this.#assertAvailable();
      const id = cleanId(conversationId, "conversationId", { required: true });
      const key = cleanText(topologyKey, "topologyKey", 200, { required: true });
      const normalizedRunId = cleanId(runId, "runId", { required: true });
      const current = this.#items.get(id);
      if (!current || current.topologyKey !== key) return { published: false, reason: "topology-changed" };
      const ownerValid = () => {
        try {
          return ownerIsValid() === true;
        } catch {
          return false;
        }
      };
      if (!ownerValid()) return { published: false, reason: "owner-invalid" };
      const normalized = cleanBinding({
        ...binding,
        sourceRunId: normalizedRunId,
        ownerRunId: normalizedRunId,
        sessionResumable: true,
        updatedAt: new Date().toISOString(),
      });
      const previous = current.bindings[normalized.memberId] || null;
      if (previous && previous.ownerRunId !== normalizedRunId) {
        return { published: false, reason: "owner-changed" };
      }
      const nextRecord = structuredClone(current);
      nextRecord.bindings[normalized.memberId] = normalized;
      nextRecord.revision += 1;
      nextRecord.updatedAt = normalized.updatedAt;
      const next = new Map(this.#items);
      next.set(id, nextRecord);
      await this.#persist(next);
      if (!ownerValid()) {
        const rollbackRecord = structuredClone(nextRecord);
        const published = rollbackRecord.bindings[normalized.memberId];
        if (published?.ownerRunId === normalizedRunId && published.sessionId === normalized.sessionId) {
          delete rollbackRecord.bindings[normalized.memberId];
          rollbackRecord.revision += 1;
          rollbackRecord.updatedAt = new Date().toISOString();
          const rollback = new Map(this.#items);
          rollback.set(id, rollbackRecord);
          await this.#persist(rollback);
        }
        return { published: false, reason: "owner-invalidated", epoch: rollbackRecord.epoch, revision: rollbackRecord.revision };
      }
      return { published: true, epoch: nextRecord.epoch, revision: nextRecord.revision };
    });
  }

  async invalidate({ conversationId, memberId, sessionId, ownerRunId = null, reason = "invalidated" }) {
    return this.#serialize(async () => {
      this.#assertAvailable();
      const id = cleanId(conversationId, "conversationId", { required: true });
      const normalizedMemberId = cleanId(memberId, "memberId", { required: true });
      const normalizedSessionId = cleanText(sessionId, "sessionId", 1_000, { required: true });
      const normalizedOwnerRunId = cleanId(ownerRunId, "ownerRunId");
      const current = this.#items.get(id);
      const binding = current?.bindings?.[normalizedMemberId];
      if (!binding || binding.sessionId !== normalizedSessionId) return { invalidated: false };
      if (normalizedOwnerRunId && binding.ownerRunId !== normalizedOwnerRunId) {
        return { invalidated: false, reason: "owner-changed" };
      }
      const nextRecord = structuredClone(current);
      delete nextRecord.bindings[normalizedMemberId];
      nextRecord.revision += 1;
      nextRecord.updatedAt = new Date().toISOString();
      nextRecord.lastInvalidation = {
        memberId: normalizedMemberId,
        sessionId: normalizedSessionId,
        reason: String(reason || "invalidated").slice(0, 160),
        at: nextRecord.updatedAt,
      };
      const next = new Map(this.#items);
      next.set(id, nextRecord);
      await this.#persist(next);
      return { invalidated: true, epoch: nextRecord.epoch, revision: nextRecord.revision };
    });
  }

  async releaseClaim(conversationId, runId) {
    return this.#serialize(async () => {
      this.#assertAvailable();
      const id = cleanId(conversationId, "conversationId", { required: true });
      const normalizedRunId = cleanId(runId, "runId", { required: true });
      const current = this.#items.get(id);
      if (!current) return { released: 0 };
      const nextRecord = structuredClone(current);
      let released = 0;
      for (const binding of Object.values(nextRecord.bindings)) {
        if (binding.ownerRunId !== normalizedRunId || binding.sourceRunId === normalizedRunId) continue;
        binding.ownerRunId = binding.sourceRunId;
        binding.claimedAt = null;
        binding.updatedAt = new Date().toISOString();
        released += 1;
      }
      if (!released) return { released: 0 };
      nextRecord.revision += 1;
      nextRecord.updatedAt = new Date().toISOString();
      const next = new Map(this.#items);
      next.set(id, nextRecord);
      await this.#persist(next);
      return { released, epoch: nextRecord.epoch, revision: nextRecord.revision };
    });
  }

  async close() {
    this.#closed = true;
    await this.#queue.catch(() => {});
    return { closed: true };
  }
}
