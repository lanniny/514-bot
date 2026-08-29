import { appendFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { sanitizeForPersistence } from "./redaction.mjs";

const DEFAULT_RECENT_LIMIT = 2000;
const DEFAULT_PER_RUN_LIMIT = 10_000;
const DEFAULT_MAX_RUN_INDEXES = 128;
const DEFAULT_RUN_INDEX_EVENT_BUDGET = 50_000;
const DEFAULT_RECENT_BYTE_LIMIT = 16 * 1024 * 1024;
const DEFAULT_PER_RUN_BYTE_LIMIT = 16 * 1024 * 1024;
const DEFAULT_RUN_INDEX_BYTE_BUDGET = 64 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_HISTORICAL_EVENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PENDING_RUN_LOADS = 16;
const MAX_PENDING_RUN_LOADS = 64;
const INIT_INCOMPLETE_FILTER_BYTES = 128 * 1024;
const MAX_INLINE_EVENT_ID_BYTES = 256;
const eventIdentityCache = new WeakMap();

class BoundedRing {
  constructor(capacity, byteCapacity = Infinity) {
    this.capacity = Math.max(1, Math.floor(Number(capacity) || 1));
    this.byteCapacity = Number.isFinite(Number(byteCapacity))
      ? Math.max(1, Math.floor(Number(byteCapacity)))
      : Infinity;
    this.items = [];
    this.sizes = [];
    this.start = 0;
    this.length = 0;
    this.bytes = 0;
    this.lastPushHadByteDrop = false;
    this.lastByteDroppedValue = undefined;
  }

  clear() {
    this.items = [];
    this.sizes = [];
    this.start = 0;
    this.length = 0;
    this.bytes = 0;
    this.lastPushHadByteDrop = false;
    this.lastByteDroppedValue = undefined;
  }

  #dropOldest() {
    if (!this.length) return;
    const value = this.items[this.start];
    this.bytes -= this.sizes[this.start] ?? 0;
    this.items[this.start] = undefined;
    this.sizes[this.start] = 0;
    this.start = (this.start + 1) % this.capacity;
    this.length -= 1;
    if (!this.length) this.start = 0;
    return value;
  }

  push(value, serializedBytes = null) {
    this.lastPushHadByteDrop = false;
    this.lastByteDroppedValue = undefined;
    const hasSerializedBytes = serializedBytes !== null && serializedBytes !== undefined;
    const bytes = hasSerializedBytes && Number.isFinite(Number(serializedBytes))
      ? Math.max(1, Math.floor(Number(serializedBytes)))
      : Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
    // Oversized historical entries remain on disk but are not allowed to defeat the in-memory
    // bound. New events are rejected before persistence by EventStore.emit().
    if (bytes > this.byteCapacity) return false;
    while (this.length && (this.length >= this.capacity || this.bytes + bytes > this.byteCapacity)) {
      const overCount = this.length >= this.capacity;
      const overBytes = this.bytes + bytes > this.byteCapacity;
      const dropped = this.#dropOldest();
      // A count eviction is the normal tail-window contract. Flag only additional evictions that
      // bytes forced while the value would otherwise still fit inside the requested count window.
      if (overBytes && !overCount) {
        this.lastPushHadByteDrop = true;
        this.lastByteDroppedValue = dropped;
      }
    }
    const index = (this.start + this.length) % this.capacity;
    this.items[index] = value;
    this.sizes[index] = bytes;
    this.length += 1;
    this.bytes += bytes;
    return true;
  }

  toArray() {
    const result = new Array(this.length);
    for (let index = 0; index < this.length; index += 1) {
      result[index] = this.items[(this.start + index) % this.capacity];
    }
    return result;
  }
}

// Initialization only needs a no-false-negative record of run keys whose earlier tail was
// evicted. A fixed Bloom filter keeps restart memory O(1); saturation merely causes safe lazy
// rebuilds for additional runs (false positives), never a truncated cache hit.
class FixedBloomFilter {
  constructor(byteLength = INIT_INCOMPLETE_FILTER_BYTES) {
    this.bits = new Uint8Array(byteLength);
    this.bitLength = this.bits.length * 8;
  }

  #hashes(value) {
    const text = String(value);
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x85ebca6b);
      second = (second << 13) | (second >>> 19);
    }
    return [first >>> 0, (second >>> 0) | 1];
  }

  add(value) {
    const [first, second] = this.#hashes(value);
    for (let probe = 0; probe < 4; probe += 1) {
      const bit = (first + Math.imul(probe, second)) >>> 0;
      const offset = bit % this.bitLength;
      this.bits[offset >>> 3] |= 1 << (offset & 7);
    }
  }

  has(value) {
    const [first, second] = this.#hashes(value);
    for (let probe = 0; probe < 4; probe += 1) {
      const bit = (first + Math.imul(probe, second)) >>> 0;
      const offset = bit % this.bitLength;
      if ((this.bits[offset >>> 3] & (1 << (offset & 7))) === 0) return false;
    }
    return true;
  }
}

function eventSequence(event) {
  return Number(event?.sequence) || 0;
}

function eventIdentity(event) {
  if (event && typeof event === "object") {
    const cached = eventIdentityCache.get(event);
    if (cached) return cached;
  }
  const rawId = typeof event?.eventId === "string" ? event.eventId : null;
  const identity = rawId == null
    ? `sequence:${eventSequence(event)}`
    : Buffer.byteLength(rawId, "utf8") <= MAX_INLINE_EVENT_ID_BYTES
      ? `id:${rawId}`
      : `sha256:${createHash("sha256").update(rawId, "utf8").digest("base64url")}`;
  if (event && typeof event === "object") eventIdentityCache.set(event, identity);
  return identity;
}

function eventIdentityEntry(event) {
  return { id: eventIdentity(event), sequence: eventSequence(event) };
}

function cloneEvents(events) {
  return typeof structuredClone === "function"
    ? structuredClone(events)
    : JSON.parse(JSON.stringify(events));
}

function serializedEventBytes(event) {
  return Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
}

function historyTooLarge(message, details = {}) {
  return Object.assign(new Error(message), { code: "EVENT_HISTORY_TOO_LARGE", ...details });
}

function abortError(reason = "run history request was aborted") {
  if (reason instanceof Error) return reason;
  return Object.assign(new Error(String(reason || "run history request was aborted")), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal.reason);
}

// --- 追加式哈希链（F-048）---------------------------------------------------
//
// 每条事件携带两个字段：
//   prev = 前一条事件的链哈希（首条为 CHAIN_GENESIS）
//   hash = sha256(prev + "\n" + <本行 JSON，其中 hash 值为空占位>)
//
// 为什么用"先留空占位、算完再回填"的两步写：哈希要覆盖整行原文，但哈希值本身
// 又必须写在这一行里。占位回填只需一次 lastIndexOf + 切片，比"二次序列化整对象"
// 便宜一个数量级，且验证时同样对**原始行文本**操作——不经过 JSON 往返，因此不受
// 外部工具重排版（缩进/键序）影响，也就不存在"文件被重排就误报篡改"的假阳性。
//
// 占位字段恒为对象的最后一个键，故 lastIndexOf 定位不会被 data 内的同名文本干扰。

export const CHAIN_ALGO = "sha256";
export const CHAIN_GENESIS = "genesis";
const CHAIN_HASH_KEY = '"hash":"';
const CHAIN_PREV_KEY = '"prev":"';
const CHAIN_HASH_PLACEHOLDER = `${CHAIN_HASH_KEY}"`;

function chainHashOf(prevHash, rawLine) {
  return createHash(CHAIN_ALGO).update(prevHash, "utf8").update("\n").update(rawLine, "utf8").digest("base64url");
}

// 从原始行里取出某个键的字符串值。before 用于限定只在该位置之前搜索，
// 使得 prev（倒数第二个键）不会被 data 内的同名文本误命中。
function readChainField(rawLine, key, before = rawLine.length) {
  const at = rawLine.lastIndexOf(key, before);
  if (at === -1) return null;
  const start = at + key.length;
  const end = rawLine.indexOf('"', start);
  if (end === -1) return null;
  return { value: rawLine.slice(start, end), start, end };
}

/**
 * 校验一行在链上的位置。
 *  - { legacy: true }      无 hash 字段（F-048 之前写入的历史行），不参与校验
 *  - { malformed: true }   有 hash 键但结构不完整（缺闭引号）
 *  - { ok, hashOk, prevOk, stored, computed, prev }
 */
function inspectChainLine(rawLine, prevHash) {
  const hashField = readChainField(rawLine, CHAIN_HASH_KEY);
  if (!hashField) return { legacy: true };
  const prevField = readChainField(rawLine, CHAIN_PREV_KEY, hashField.start);
  if (prevField === undefined) return { malformed: true };
  // 把 hash 值清空，还原成写入哈希时的形态
  const stripped = `${rawLine.slice(0, hashField.start)}${rawLine.slice(hashField.end)}`;
  const computed = chainHashOf(prevHash, stripped);
  const prev = prevField?.value ?? null;
  const hashOk = computed === hashField.value;
  const prevOk = (prev ?? CHAIN_GENESIS) === prevHash;
  return {
    ok: hashOk && prevOk,
    // 分开判定，让断裂原因可诊断：hash 依赖 prev，所以"删掉一条"会同时让两者
    // 都不匹配，但根因是前驱缺失。先判 prev 才能报出真正的原因。
    hashOk,
    prevOk,
    stored: hashField.value,
    computed,
    prev,
  };
}

/** 把空占位回填为真实哈希，得到最终落盘行。 */
function finalizeChainLine(rawLine, hash) {
  const at = rawLine.lastIndexOf(CHAIN_HASH_PLACEHOLDER);
  if (at === -1) return rawLine;
  const start = at + CHAIN_HASH_KEY.length;
  return `${rawLine.slice(0, start)}${hash}${rawLine.slice(start)}`;
}

/**
 * 累积式链校验器：喂原始行，输出链状态。
 * 遗留段（无 hash 的行）会把链切断并从 CHAIN_GENESIS 重新起链，
 * 这样 F-048 之前的历史文件可以平滑升级，而不是整体判为不可信。
 */
function createChainInspector() {
  let prev = CHAIN_GENESIS;
  const status = {
    ok: true,
    checked: 0,
    legacy: 0,
    malformed: 0,
    segments: 1,
    breaks: [],
    tip: CHAIN_GENESIS,
  };
  return {
    status,
    onLine(rawLine, lineNo) {
      if (!rawLine.trim()) return;
      const result = inspectChainLine(rawLine, prev);
      if (result.legacy) {
        status.legacy += 1;
        if (status.checked > 0 || prev !== CHAIN_GENESIS) status.segments += 1;
        prev = CHAIN_GENESIS;
        status.tip = CHAIN_GENESIS;
        return;
      }
      if (result.malformed) {
        status.malformed += 1;
        status.ok = false;
        status.breaks.push({ line: lineNo, reason: "malformed-hash-field" });
        // 结构已损坏，无法得知它本该的哈希。重新起链，让后续至少内部自洽，
        // 断裂本身已记入 breaks，不会被掩盖。
        if (status.checked > 0) status.segments += 1;
        prev = CHAIN_GENESIS;
        status.tip = CHAIN_GENESIS;
        return;
      }
      status.checked += 1;
      if (!result.ok) {
        status.ok = false;
        status.breaks.push({
          line: lineNo,
          reason: result.prevOk === false ? "prev-mismatch" : "hash-mismatch",
          expectedPrev: prev,
          actualPrev: result.prev,
        });
      }
      // 以文件里存的值继续向后链接：即便这一条已被改坏，
      // 也能继续定位后续断裂，而不是一次性放弃整条链。
      prev = result.stored || result.computed;
      status.tip = prev;
    },
  };
}

async function* boundedLfLines(input, maxLineBytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let parts = [];
  let lineBytes = 0;

  const decode = () => {
    let bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts, lineBytes);
    if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, bytes.length - 1);
    parts = [];
    lineBytes = 0;
    try {
      return decoder.decode(bytes);
    } catch (cause) {
      throw Object.assign(new Error("historical event line is not valid UTF-8"), {
        code: "EVENT_HISTORY_CORRUPT",
        cause,
      });
    }
  };

  for await (const rawChunk of input) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      const length = end - offset;
      if (lineBytes + length > maxLineBytes) {
        throw historyTooLarge(`historical event line exceeds the ${maxLineBytes} byte limit`, {
          bytes: lineBytes + length,
          limit: maxLineBytes,
        });
      }
      if (length) {
        parts.push(chunk.subarray(offset, end));
        lineBytes += length;
      }
      if (newline < 0) break;
      yield decode();
      offset = newline + 1;
    }
  }
  if (lineBytes) yield decode();
}

export class EventStore {
  constructor(path, {
    recentLimit = DEFAULT_RECENT_LIMIT,
    perRunLimit = DEFAULT_PER_RUN_LIMIT,
    maxRunIndexes = DEFAULT_MAX_RUN_INDEXES,
    runIndexEventBudget = DEFAULT_RUN_INDEX_EVENT_BUDGET,
    recentByteLimit = DEFAULT_RECENT_BYTE_LIMIT,
    perRunByteLimit = DEFAULT_PER_RUN_BYTE_LIMIT,
    runIndexByteBudget = DEFAULT_RUN_INDEX_BYTE_BUDGET,
    maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
    maxHistoricalEventBytes = DEFAULT_MAX_HISTORICAL_EVENT_BYTES,
    maxPendingRunLoads = DEFAULT_MAX_PENDING_RUN_LOADS,
    onRunIndexScan = null,
    verifyChain = true,
  } = {}) {
    this.path = path;
    this.sequence = 0;
    this.subscribers = new Set();
    this.writeChain = Promise.resolve();
    this.maxEventBytes = Math.min(64 * 1024 * 1024, Math.max(1024, Math.floor(Number(maxEventBytes) || DEFAULT_MAX_EVENT_BYTES)));
    this.maxHistoricalEventBytes = Math.min(64 * 1024 * 1024, Math.max(
      this.maxEventBytes,
      Math.floor(Number(maxHistoricalEventBytes) || DEFAULT_MAX_HISTORICAL_EVENT_BYTES),
    ));
    this.recentByteLimit = Math.max(this.maxEventBytes, Math.floor(Number(recentByteLimit) || DEFAULT_RECENT_BYTE_LIMIT));
    this.perRunByteLimit = Math.max(this.maxEventBytes, Math.floor(Number(perRunByteLimit) || DEFAULT_PER_RUN_BYTE_LIMIT));
    this.runIndexByteBudget = Math.max(this.perRunByteLimit, Math.floor(Number(runIndexByteBudget) || DEFAULT_RUN_INDEX_BYTE_BUDGET));
    this.recentLimit = Math.min(DEFAULT_RECENT_LIMIT, Math.max(1, recentLimit));
    this.recent = new BoundedRing(this.recentLimit, this.recentByteLimit);
    this.recentExpected = new BoundedRing(this.recentLimit);
    this.perRunLimit = Math.min(DEFAULT_PER_RUN_LIMIT, Math.max(1, Math.floor(Number(perRunLimit) || DEFAULT_PER_RUN_LIMIT)));
    this.maxRunIndexes = Math.min(1024, Math.max(1, Math.floor(Number(maxRunIndexes) || DEFAULT_MAX_RUN_INDEXES)));
    this.runIndexEventBudget = Math.max(this.perRunLimit, Math.floor(Number(runIndexEventBudget) || DEFAULT_RUN_INDEX_EVENT_BUDGET));
    this.maxConcurrentRunLoads = Math.max(1, Math.min(
      this.maxRunIndexes,
      Math.floor(this.runIndexEventBudget / this.perRunLimit),
      Math.floor(this.runIndexByteBudget / this.perRunByteLimit),
    ));
    this.maxPendingRunLoads = Math.min(MAX_PENDING_RUN_LOADS, Math.max(
      this.maxConcurrentRunLoads,
      Math.floor(Number(maxPendingRunLoads) || DEFAULT_MAX_PENDING_RUN_LOADS),
    ));
    this.onRunIndexScan = typeof onRunIndexScan === "function" ? onRunIndexScan : null;
    this.byRun = new Map();
    this.completeRunIndexes = new Set();
    this.initIncompleteRunFilter = null;
    this.initializing = false;
    this.recentByteDropThrough = 0;
    this.indexedRunEvents = 0;
    this.indexedRunBytes = 0;
    this.runIndexInflight = new Map();
    this.pendingRunLoadBatch = null;
    this.runLoadScanChain = Promise.resolve();
    this.recentReadScanChain = Promise.resolve();
    this.readTasks = new Set();
    this.lifecycleAbort = new AbortController();
    this.accepting = true;
    // 注意：字段名不能叫 verifyChain —— 会遮蔽原型上的同名方法。
    this.verifyChainOnLoad = verifyChain !== false;
    // 链状态（F-048）。chainTip 是下一条事件要引用的 prev；
    // chainFault 记录"已落盘失败"的写入——此时链必然断裂，必须显式可见。
    this.chainTip = CHAIN_GENESIS;
    this.chainStatus = null;
    this.chainFault = null;
  }

  #closedError() {
    return Object.assign(new Error("event store is closed"), { code: "EVENT_STORE_CLOSED" });
  }

  #throwIfClosed() {
    if (!this.accepting || this.lifecycleAbort.signal.aborted) throw this.#closedError();
  }

  #trackRead(task) {
    this.readTasks.add(task);
    task.then(
      () => this.readTasks.delete(task),
      () => this.readTasks.delete(task),
    );
    return task;
  }

  #scheduleRecentRead(work) {
    const task = this.recentReadScanChain.catch(() => {}).then(async () => {
      this.#throwIfClosed();
      return work();
    });
    this.recentReadScanChain = task.then(() => undefined, () => undefined);
    return this.#trackRead(task);
  }

  #evictRunIndexes() {
    while (
      this.byRun.size > this.maxRunIndexes
      || this.indexedRunEvents > this.runIndexEventBudget
      || this.indexedRunBytes > this.runIndexByteBudget
    ) {
      const oldestKey = this.byRun.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.byRun.get(oldestKey);
      if (this.initializing) this.initIncompleteRunFilter?.add(oldestKey);
      this.indexedRunEvents -= oldest?.length ?? 0;
      this.indexedRunBytes -= oldest?.bytes ?? 0;
      this.byRun.delete(oldestKey);
      this.completeRunIndexes.delete(oldestKey);
    }
  }

  #retainRunRing(key, ring) {
    const existing = this.byRun.get(key);
    if (existing) {
      this.indexedRunEvents -= existing.length;
      this.indexedRunBytes -= existing.bytes;
      this.byRun.delete(key);
    }
    this.byRun.set(key, ring);
    this.completeRunIndexes.add(key);
    this.indexedRunEvents += ring.length;
    this.indexedRunBytes += ring.bytes;
    this.#evictRunIndexes();
  }

  #index(event, serializedBytes = null) {
    const hasSerializedBytes = serializedBytes !== null && serializedBytes !== undefined;
    const eventBytes = hasSerializedBytes && Number.isFinite(Number(serializedBytes))
      ? Math.max(1, Math.floor(Number(serializedBytes)))
      : Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
    this.recentExpected.push(eventIdentityEntry(event), 1);
    const recentAccepted = this.recent.push(event, eventBytes);
    if (!recentAccepted) {
      this.recentByteDropThrough = Math.max(this.recentByteDropThrough, eventSequence(event));
    } else if (this.recent.lastPushHadByteDrop) {
      this.recentByteDropThrough = Math.max(
        this.recentByteDropThrough,
        eventSequence(this.recent.lastByteDroppedValue),
      );
    }
    if (event.runId == null) return;
    const key = String(event.runId);
    let ring = this.byRun.get(key);
    if (!ring) {
      ring = new BoundedRing(this.perRunLimit, this.perRunByteLimit);
    } else {
      this.indexedRunEvents -= ring.length;
      this.indexedRunBytes -= ring.bytes;
      this.byRun.delete(key);
    }
    const runAccepted = ring.push(event, eventBytes);
    if (!runAccepted || ring.lastPushHadByteDrop) {
      if (this.initializing) this.initIncompleteRunFilter?.add(key);
      this.completeRunIndexes.delete(key);
    }
    this.byRun.set(key, ring); // Map insertion order is the run-index LRU.
    this.indexedRunEvents += ring.length;
    this.indexedRunBytes += ring.bytes;
    this.#evictRunIndexes();
  }

  init() {
    return this.#trackRead(this.#initFromDisk());
  }

  async #initFromDisk() {
    this.#throwIfClosed();
    await mkdir(dirname(this.path), { recursive: true });
    this.sequence = 0;
    this.recent.clear();
    this.recentExpected.clear();
    this.byRun.clear();
    this.completeRunIndexes.clear();
    this.initIncompleteRunFilter = new FixedBloomFilter();
    this.recentByteDropThrough = 0;
    this.indexedRunEvents = 0;
    this.indexedRunBytes = 0;
    this.runIndexInflight.clear();
    this.pendingRunLoadBatch = null;
    this.initializing = true;
    const inspector = this.verifyChainOnLoad ? createChainInspector() : null;
    try {
      // 索引与链校验共用一次顺序扫描：onRawLine 拿原文做哈希，
      // yield 出来的对象照旧用于建索引。多出的成本只有 lastIndexOf + 比较。
      const options = inspector ? { onRawLine: (line, lineNo) => inspector.onLine(line, lineNo) } : undefined;
      for await (const event of this.iterate(options)) {
        this.sequence = Math.max(this.sequence, eventSequence(event));
        this.#index(event);
      }
      this.#throwIfClosed();
      if (inspector) {
        this.chainTip = inspector.status.tip;
        this.chainStatus = inspector.status;
      }
      for (const key of this.byRun.keys()) {
        if (!this.initIncompleteRunFilter.has(key)) this.completeRunIndexes.add(key);
      }
    } finally {
      this.initializing = false;
      // Completeness now lives in completeRunIndexes; release even the fixed startup filter.
      this.initIncompleteRunFilter = null;
    }
    return this;
  }

  async emit(type, data = {}, context = {}) {
    if (!this.accepting) {
      throw Object.assign(new Error("event store is closed"), { code: "EVENT_STORE_CLOSED" });
    }
    const sourceRefs = Array.isArray(context.sourceRefs)
      ? context.sourceRefs.slice(0, 16).map((source) => ({
        kind: String(source?.kind || "file"),
        path: String(source?.path || ""),
        name: String(source?.name || "source").slice(0, 180),
      })).filter((source) => source.path)
      : [];
    const event = sanitizeForPersistence({
      schemaVersion: 1,
      eventId: randomUUID(),
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      type,
      runId: context.runId ?? null,
      sessionId: context.sessionId ?? null,
      parentSessionId: context.parentSessionId ?? null,
      agentId: context.agentId ?? null,
      correlationId: context.correlationId ?? null,
      causationId: context.causationId ?? null,
      sensitivity: context.sensitivity ?? "internal",
      ...(sourceRefs.length ? { sourceRefs } : {}),
      data,
    });
    // 哈希链（F-048）：prev/hash 必须在 sanitize 之后附加，否则可能被脱敏改写。
    // 整段计算保持在第一个 await 之前，使并发 emit 各自拿到不同的 prev。
    const prevTip = this.chainTip;
    event.prev = prevTip;
    event.hash = "";
    const stubLine = JSON.stringify(event);
    const hash = chainHashOf(prevTip, stubLine);
    const finalized = finalizeChainLine(stubLine, hash);
    if (finalized === stubLine) {
      // 占位丢失意味着这条事件落盘后没有哈希，链会静默断裂。不该发生，
      // 但宁可显式标出故障，也不能让一条无哈希的事件混进 append-only 日志。
      this.chainFault = { sequence: this.sequence, reason: "chain-placeholder-missing" };
    }
    event.hash = hash;
    this.chainTip = hash;

    const line = `${finalized}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > this.maxEventBytes) {
      this.sequence -= 1;
      this.chainTip = prevTip;
      throw Object.assign(new Error(`event exceeds ${this.maxEventBytes} byte persistence limit`), {
        code: "EVENT_TOO_LARGE",
        bytes: lineBytes,
        limit: this.maxEventBytes,
      });
    }
    const write = this.writeChain.catch(() => {}).then(() => appendFile(this.path, line, "utf8"));
    this.writeChain = write;
    try {
      await write;
    } catch (error) {
      // 未落盘但 tip 已推进：后续事件的 prev 会指向一个文件中不存在的哈希，
      // verifyChain 必然报 prev-mismatch —— 故障不会悄悄消失。
      this.chainFault = {
        sequence: this.sequence,
        reason: "append-failed",
        message: String(error?.message ?? error),
      };
      throw error;
    }
    this.#index(event, lineBytes);
    for (const subscriber of this.subscribers) {
      try {
        subscriber(cloneEvents([event])[0]);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
    return cloneEvents([event])[0];
  }

  subscribe(listener) {
    if (!this.accepting) return () => {};
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  async close({ deadlineMs = null } = {}) {
    this.accepting = false;
    this.lifecycleAbort.abort();
    // Let a pending lazy-load batch enter its guarded start path before taking the chain snapshot.
    await Promise.resolve();
    // 统一 shutdown deadline（烛 wave-shutdown 复审）：读取任务与扫描链只等到截止点。
    // 超期不再无限等待——lifecycleAbort 已广播，尾部任务按各自 abort 语义收尾。
    const withinDeadline = async (pending) => {
      if (deadlineMs == null) {
        await pending;
        return true;
      }
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) {
        void Promise.resolve(pending).catch(() => {});
        return false;
      }
      let timer = null;
      try {
        return await Promise.race([
          Promise.resolve(pending).then(() => true, () => true),
          new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), remaining); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    while (this.readTasks.size) {
      if (!await withinDeadline(Promise.allSettled([...this.readTasks]))) break;
    }
    await withinDeadline(Promise.all([
      this.writeChain.catch(() => {}),
      this.runLoadScanChain.catch(() => {}),
      this.recentReadScanChain.catch(() => {}),
    ]));
    this.subscribers.clear();
  }

  async list(limit = 200, { afterSequence = 0 } = {}) {
    this.#throwIfClosed();
    const cappedLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 1), DEFAULT_RECENT_LIMIT));
    const events = this.recent.toArray().filter((event) => eventSequence(event) > afterSequence).slice(-cappedLimit);
    const expectedIds = this.recentExpected.toArray()
      .filter((entry) => entry.sequence > afterSequence)
      .slice(-cappedLimit)
      .map((entry) => entry.id);
    const actualIds = events.map(eventIdentity);
    const hotWindowComplete = actualIds.length === expectedIds.length
      && actualIds.every((id, index) => id === expectedIds[index]);
    if (hotWindowComplete) return cloneEvents(events);

    // A legacy event may predate the current per-event memory cap. Preserve the API contract by
    // taking the slow disk path instead of silently returning a hole from the hot ring.
    return this.#scheduleRecentRead(async () => {
      const latest = new BoundedRing(cappedLimit, this.recentByteLimit);
      const selectedOrdinals = new BoundedRing(cappedLimit);
      let ordinal = 0;
      for await (const event of this.iterate({ afterSequence })) {
        ordinal += 1;
        selectedOrdinals.push(ordinal, 1);
        latest.push({ ordinal, event }, serializedEventBytes(event));
      }
      this.#throwIfClosed();
      const selected = selectedOrdinals.toArray();
      const retained = latest.toArray();
      if (retained.length !== selected.length || retained.some((entry, index) => entry.ordinal !== selected[index])) {
        throw historyTooLarge("recent event history exceeds the response byte limit", { limit: this.recentByteLimit });
      }
      return cloneEvents(retained.map((entry) => entry.event));
    });
  }

  async listByRun(runId, limit = 5000, { signal } = {}) {
    this.#throwIfClosed();
    throwIfAborted(signal);
    const cappedLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 1), DEFAULT_PER_RUN_LIMIT));
    const key = String(runId);
    // A miss scan owns the authoritative reconstruction. An emit during that scan creates a
    // provisional hot ring; callers must still join the scan or they would see only the live tail.
    let inflight = this.runIndexInflight.get(key);
    if (inflight?.controller.signal.aborted) {
      if (this.runIndexInflight.get(key) === inflight) this.runIndexInflight.delete(key);
      inflight = null;
    }
    if (inflight) {
      const load = await this.#waitForRunLoad(inflight, signal);
      throwIfAborted(signal);
      return cloneEvents(this.#selectRunLoad(load, cappedLimit, key));
    }
    const cached = this.byRun.get(key);
    if (cached && this.completeRunIndexes.has(key)) {
      this.byRun.delete(key);
      this.byRun.set(key, cached);
      return cloneEvents(cached.toArray().slice(-cappedLimit));
    }
    if (this.runIndexInflight.size >= this.maxPendingRunLoads) {
      throw Object.assign(new Error("too many run history requests are pending"), { code: "EVENT_INDEX_BUSY" });
    }
    inflight = this.#scheduleRunRingLoad(key);
    const load = await this.#waitForRunLoad(inflight, signal);
    throwIfAborted(signal);
    return cloneEvents(this.#selectRunLoad(load, cappedLimit, key));
  }

  async #waitForRunLoad(load, signal) {
    throwIfAborted(signal);
    load.waiters += 1;
    let onAbort = null;
    try {
      if (!signal) return await load.promise;
      const cancelled = new Promise((resolveCancelled, rejectCancelled) => {
        onAbort = () => rejectCancelled(abortError(signal.reason));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      return await Promise.race([load.promise, cancelled]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      load.waiters = Math.max(0, load.waiters - 1);
      // A shared scan belongs to its current waiters, not to the first HTTP request that created
      // it. Only the last cancelled waiter may stop the underlying disk work.
      if (!load.settled && load.waiters === 0) load.controller.abort(abortError());
    }
  }

  #selectRunLoad(load, limit, key) {
    const events = load.ring.toArray().slice(-limit);
    const expectedIds = load.expectedIds.slice(-limit);
    const actualIds = events.map(eventIdentity);
    if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
      throw historyTooLarge(`run ${key} exceeds the requested history byte limit`, {
        runId: key,
        limit: this.perRunByteLimit,
      });
    }
    return events;
  }

  #scheduleRunRingLoad(key) {
    let resolveLoad;
    let rejectLoad;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolveLoad = resolvePromise;
      rejectLoad = rejectPromise;
    });
    const controller = new AbortController();
    const load = {
      key,
      promise,
      controller,
      waiters: 0,
      settled: false,
      resolve: resolveLoad,
      reject: rejectLoad,
    };
    const onAbort = () => rejectLoad(abortError(controller.signal.reason));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => {
        load.settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        if (this.runIndexInflight.get(key) === load) this.runIndexInflight.delete(key);
      },
      () => {
        load.settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        if (this.runIndexInflight.get(key) === load) this.runIndexInflight.delete(key);
      },
    );
    this.runIndexInflight.set(key, load);
    if (!this.pendingRunLoadBatch) {
      this.pendingRunLoadBatch = { requests: new Map() };
      const batch = this.pendingRunLoadBatch;
      queueMicrotask(() => void this.#startRunLoadBatch(batch));
    }
    this.pendingRunLoadBatch.requests.set(key, load);
    return load;
  }

  async #startRunLoadBatch(batch) {
    if (this.pendingRunLoadBatch === batch) this.pendingRunLoadBatch = null;
    if (!this.accepting) {
      const error = Object.assign(new Error("event store is closed"), { code: "EVENT_STORE_CLOSED" });
      for (const load of batch.requests.values()) load.reject(error);
      return;
    }
    const entries = [...batch.requests.entries()];
    for (let offset = 0; offset < entries.length; offset += this.maxConcurrentRunLoads) {
      const chunk = entries.slice(offset, offset + this.maxConcurrentRunLoads);
      if (!this.accepting) {
        const error = this.#closedError();
        for (const [, load] of chunk) load.reject(error);
        for (const [, load] of entries.slice(offset + chunk.length)) load.reject(error);
        return;
      }
      const active = chunk.filter(([key, load]) => (
        !load.controller.signal.aborted && this.runIndexInflight.get(key) === load
      ));
      if (!active.length) continue;
      const scanAbort = new AbortController();
      const maybeAbortScan = () => {
        if (active.every(([, load]) => load.controller.signal.aborted)) {
          scanAbort.abort(abortError("all run history waiters disconnected"));
        }
      };
      for (const [, load] of active) load.controller.signal.addEventListener("abort", maybeAbortScan);
      maybeAbortScan();
      const keys = new Set(active.map(([key]) => key));
      const scan = this.#trackRead(this.runLoadScanChain.catch(() => {}).then(() => this.#loadRunRings(keys, {
        signal: scanAbort.signal,
        isKeyActive: (key) => {
          const load = active.find(([candidate]) => candidate === key)?.[1];
          return Boolean(load && !load.controller.signal.aborted && this.runIndexInflight.get(key) === load);
        },
      })));
      this.runLoadScanChain = scan.then(() => undefined, () => undefined);
      try {
        const { results, errors } = await scan;
        for (const [key, load] of active) {
          if (load.controller.signal.aborted) continue;
          const error = errors.get(key);
          if (error) load.reject(error);
          else load.resolve(results.get(key));
        }
      } catch (error) {
        for (const [, load] of active) {
          if (!load.controller.signal.aborted) load.reject(error);
        }
      } finally {
        for (const [, load] of active) load.controller.signal.removeEventListener("abort", maybeAbortScan);
      }
    }
  }

  async #loadRunRings(keys, { signal, isKeyActive = () => true } = {}) {
    const historical = new Map([...keys].map((key) => [key, new BoundedRing(this.perRunLimit, this.perRunByteLimit)]));
    const historicalExpected = new Map([...keys].map((key) => [key, new BoundedRing(this.perRunLimit)]));
    const live = new Map([...keys].map((key) => [key, new BoundedRing(this.perRunLimit, this.perRunByteLimit)]));
    const liveExpected = new Map([...keys].map((key) => [key, new BoundedRing(this.perRunLimit)]));
    const errors = new Map();
    const unsubscribe = this.subscribe((event) => {
      const key = event.runId == null ? null : String(event.runId);
      liveExpected.get(key)?.push(eventIdentityEntry(event), 1);
      live.get(key)?.push(event);
    });
    try {
      await this.onRunIndexScan?.({ keys: [...keys], signal });
      throwIfAborted(signal);
      for await (const event of this.iterate({ signal })) {
        const key = event.runId == null ? null : String(event.runId);
        const ring = historical.get(key);
        if (ring) {
          historicalExpected.get(key).push(eventIdentityEntry(event), 1);
          ring.push(event);
        }
      }
      throwIfAborted(signal);
      this.#throwIfClosed();
    } finally {
      unsubscribe();
    }

    // createReadStream may or may not observe appends made while it is scanning. Merge the live
    // capture and any hot ring created by emit(), then deduplicate by stable event identity.
    const results = new Map();
    for (const key of keys) {
      if (!isKeyActive(key)) continue;
      const combined = [
        ...historical.get(key).toArray(),
        ...live.get(key).toArray(),
        ...(this.byRun.get(key)?.toArray() ?? []),
      ];
      const unique = new Map();
      for (const event of combined) unique.set(eventIdentity(event), event);
      const ordered = [...unique.values()].sort((left, right) => eventSequence(left) - eventSequence(right));
      const expectedUnique = new Map();
      for (const entry of [...historicalExpected.get(key).toArray(), ...liveExpected.get(key).toArray()]) {
        expectedUnique.set(entry.id, entry);
      }
      const expectedIds = [...expectedUnique.values()]
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-this.perRunLimit)
        .map((entry) => entry.id);
      const ring = new BoundedRing(this.perRunLimit, this.perRunByteLimit);
      for (const event of ordered) {
        ring.push(event);
      }
      const retainedIds = ring.toArray().map(eventIdentity);
      const cacheable = retainedIds.length === expectedIds.length
        && retainedIds.every((id, index) => id === expectedIds[index]);
      if (cacheable) {
        this.#retainRunRing(key, ring);
      }
      results.set(key, { ring, expectedIds });
    }
    return { results, errors };
  }

  async replay(afterSequence = 0, limit = DEFAULT_RECENT_LIMIT) {
    this.#throwIfClosed();
    const cappedLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 1), DEFAULT_RECENT_LIMIT));
    const recent = this.recent.toArray();
    const expected = this.recentExpected.toArray();
    const earliest = expected[0]?.sequence ?? 0;
    const expectedMatched = expected.filter((entry) => entry.sequence > afterSequence);
    const matchedEvents = recent.filter((event) => eventSequence(event) > afterSequence);
    const actualIds = matchedEvents.map(eventIdentity);
    const expectedIds = expectedMatched.map((entry) => entry.id);
    const hotWindowComplete = actualIds.length === expectedIds.length
      && actualIds.every((id, index) => id === expectedIds[index]);
    if (expected.length && afterSequence >= earliest - 1 && hotWindowComplete) {
      return {
        events: cloneEvents(matchedEvents.slice(0, cappedLimit)),
        hasMore: matchedEvents.length > cappedLimit,
        matched: matchedEvents.length,
      };
    }
    if (!recent.length && this.sequence === 0) return { events: [], hasMore: false, matched: 0 };

    return this.#scheduleRecentRead(async () => {
      const events = [];
      let matched = 0;
      let responseBytes = 0;
      for await (const event of this.iterate({ afterSequence })) {
        matched += 1;
        if (events.length < cappedLimit) {
          responseBytes += serializedEventBytes(event);
          if (responseBytes > this.recentByteLimit) {
            throw historyTooLarge("event replay exceeds the response byte limit", { limit: this.recentByteLimit });
          }
          events.push(event);
        }
      }
      this.#throwIfClosed();
      return { events: cloneEvents(events), hasMore: matched > events.length, matched };
    });
  }

  // 顺序流式扫描历史日志。signal 用于 SSE 断连时立即销毁底层句柄，避免后台继续扫大文件。
  /**
   * 全量重扫并校验哈希链（F-048）。init 时已随索引扫描做过一次，结果留在
   * `chainStatus`；这里供运行期按需复核——导出审计报告、或怀疑文件被外部改动时。
   * 只读：不改动 chainTip，也不因校验失败抛错（断裂体现在返回值的 breaks 里）。
   */
  async verifyChain({ signal } = {}) {
    this.#throwIfClosed();
    const inspector = createChainInspector();
    return this.#trackRead((async () => {
      // 只关心原始行；解析结果无用，但仍需驱动 generator 走完整个扫描。
      const scan = this.iterate({
        signal,
        onRawLine: (line, lineNo) => inspector.onLine(line, lineNo),
      });
      for (;;) {
        const step = await scan.next();
        if (step.done) break;
      }
      return { ...inspector.status, fault: this.chainFault };
    })());
  }

  // onRawLine 在 JSON 解析**之前**拿到原始行，供哈希链校验使用（F-048）。
  // 走同一套 boundedLfLines，保证验证与索引看到完全相同的行切分。
  async *iterate({ afterSequence = 0, signal, onRawLine = null } = {}) {
    const effectiveSignal = signal
      ? AbortSignal.any([signal, this.lifecycleAbort.signal])
      : this.lifecycleAbort.signal;
    if (effectiveSignal.aborted) return;
    const input = createReadStream(this.path, { signal: effectiveSignal });
    let lineNo = 0;
    try {
      for await (const line of boundedLfLines(input, this.maxHistoricalEventBytes)) {
        if (effectiveSignal.aborted) break;
        lineNo += 1;
        if (onRawLine) onRawLine(line, lineNo);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (eventSequence(event) > afterSequence) yield event;
        } catch {
          // Preserve malformed historical lines for forensic inspection.
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ABORT_ERR" && error.name !== "AbortError") throw error;
    } finally {
      input.destroy();
    }
  }
}
