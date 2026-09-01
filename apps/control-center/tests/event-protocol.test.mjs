import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVENT_ENVELOPE_SCHEMA,
  EVENT_ENVELOPE_SCHEMA_VERSION,
  SUPPORTED_EVENT_SCHEMA_VERSIONS,
  EVENT_PROTOCOL_FAULT_TYPE,
  isSupportedEventSchemaVersion,
  classifyEventEnvelope,
  unsupportedEventEnvelope,
  readServerEventSchemaVersions,
} from "../public/modules/event-protocol.js";
import { EventStore } from "../src/event-store.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

function assertIncludes(text, snippet, message) {
  assert.ok(text.includes(snippet), message ?? `缺少：${snippet}`);
}

// ── 1. 共享模块单元测试 ─────────────────────────────────────────

test("isSupportedEventSchemaVersion accepts v1 and rejects everything else", () => {
  assert.equal(isSupportedEventSchemaVersion(1), true);
  assert.equal(isSupportedEventSchemaVersion(2), false);
  assert.equal(isSupportedEventSchemaVersion(undefined), false);
  assert.equal(isSupportedEventSchemaVersion("1"), false);
  assert.equal(isSupportedEventSchemaVersion(1.5), false);
  assert.equal(isSupportedEventSchemaVersion(null), false);
  assert.equal(isSupportedEventSchemaVersion(0), false);
});

test("classifyEventEnvelope returns ok / unversioned / unsupported", () => {
  assert.equal(classifyEventEnvelope({ schemaVersion: 1 }), "ok");
  assert.equal(classifyEventEnvelope({}), "unversioned");
  assert.equal(classifyEventEnvelope({ schemaVersion: undefined }), "unversioned");
  assert.equal(classifyEventEnvelope(null), "unversioned");
  assert.equal(classifyEventEnvelope("string"), "unversioned");
  assert.equal(classifyEventEnvelope({ schemaVersion: 2 }), "unsupported");
  assert.equal(classifyEventEnvelope({ schemaVersion: "1" }), "unsupported");
});

test("unsupportedEventEnvelope preserves sequence/runId but never leaks original data", () => {
  const original = {
    schemaVersion: 99,
    eventId: "evt-abc",
    sequence: 42,
    timestamp: "2026-09-01T00:00:00.000Z",
    type: "secret.internal",
    runId: "run-x",
    data: { password: "hunter2", token: "abc123" },
  };
  const tombstone = unsupportedEventEnvelope(original);

  assert.equal(tombstone.schemaVersion, EVENT_ENVELOPE_SCHEMA_VERSION);
  assert.equal(tombstone.eventId, "evt-abc");
  assert.equal(tombstone.sequence, 42);
  assert.equal(tombstone.timestamp, "2026-09-01T00:00:00.000Z");
  assert.equal(tombstone.type, EVENT_PROTOCOL_FAULT_TYPE);
  assert.equal(tombstone.runId, "run-x");
  assert.equal(tombstone.sensitivity, "public");
  assert.deepEqual(tombstone.data, { unsupportedSchemaVersion: 99 });
  assert.equal(tombstone.data.password, undefined, "original data must not leak");
  assert.equal(tombstone.data.token, undefined, "original data must not leak");
});

test("unsupportedEventEnvelope handles null/missing fields gracefully", () => {
  const tombstone = unsupportedEventEnvelope(null);
  assert.equal(tombstone.sequence, 0);
  assert.equal(tombstone.runId, null);
  assert.equal(tombstone.data.unsupportedSchemaVersion, null);
  assert.ok(tombstone.eventId);
  assert.ok(tombstone.timestamp);
});

test("readServerEventSchemaVersions extracts versions from ready payload", () => {
  assert.deepEqual(readServerEventSchemaVersions({ eventSchemaVersions: [1, 2] }), [1, 2]);
  assert.deepEqual(readServerEventSchemaVersions({}), []);
  assert.deepEqual(readServerEventSchemaVersions(null), []);
  assert.deepEqual(readServerEventSchemaVersions({ eventSchemaVersions: "not-array" }), []);
});

test("SUPPORTED_EVENT_SCHEMA_VERSIONS is frozen and contains only v1", () => {
  assert.ok(Object.isFrozen(SUPPORTED_EVENT_SCHEMA_VERSIONS));
  assert.deepEqual([...SUPPORTED_EVENT_SCHEMA_VERSIONS], [1]);
});

test("EVENT_ENVELOPE_SCHEMA matches the versioned identifier format", () => {
  assert.equal(EVENT_ENVELOPE_SCHEMA, "514cc.event-envelope/v1");
  assert.equal(EVENT_ENVELOPE_SCHEMA_VERSION, 1);
});

// ── 2. Producer 一致性 ──────────────────────────────────────────

test("EventStore.emit stamps every event with EVENT_ENVELOPE_SCHEMA_VERSION", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-protocol-producer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new EventStore(resolve(root, "events.jsonl")).init();

  const emitted = await store.emit("test.event", { value: 1 }, { runId: "run-a" });
  assert.equal(emitted.schemaVersion, EVENT_ENVELOPE_SCHEMA_VERSION);

  const persisted = await store.list(10);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].schemaVersion, EVENT_ENVELOPE_SCHEMA_VERSION);
  assert.equal(persisted[0].type, "test.event");
  await store.close();
});

// ── 3. Schema 漂移哨兵 ──────────────────────────────────────────

test("contracts.schema.json eventEnvelope properties cover actual emitted envelope keys", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-protocol-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new EventStore(resolve(root, "events.jsonl")).init();
  const emitted = await store.emit("test.event", { value: 1 }, {
    runId: "run-a",
    sessionId: "sess-1",
    sourceRefs: [{ kind: "file", path: "/tmp/x", name: "x" }],
  });
  await store.close();

  const schemaPath = resolve(appRoot, "../../schemas/control-center/contracts.schema.json");
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const envelopeSchema = schema.$defs?.eventEnvelope ?? schema.definitions?.eventEnvelope;
  assert.ok(envelopeSchema, "eventEnvelope definition must exist in contracts.schema.json");

  const schemaProperties = new Set(Object.keys(envelopeSchema.properties ?? {}));
  const actualKeys = Object.keys(emitted).filter((key) => key !== "data");

  for (const key of actualKeys) {
    assert.ok(schemaProperties.has(key), `schema is missing key: ${key}`);
  }
  assert.ok(schemaProperties.has("data"), "schema must declare data property");
  assert.ok(schemaProperties.has("sourceRefs"), "schema must declare sourceRefs property");
  assert.ok(schemaProperties.has("prev"), "schema must declare prev property");
  assert.ok(schemaProperties.has("hash"), "schema must declare hash property");
});

// ── 4. Fail-closed: unknown version events are tombstoned ───────

test("unknown schemaVersion events on disk are surfaced with tombstone shape", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-protocol-failclosed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, "events.jsonl");

  const v2Event = {
    schemaVersion: 2,
    eventId: "future-evt-1",
    sequence: 1,
    timestamp: "2026-09-01T00:00:00.000Z",
    type: "future.type",
    runId: "run-future",
    sensitivity: "internal",
    data: { secretPayload: "must-not-leak" },
  };
  await writeFile(path, `${JSON.stringify(v2Event)}\n`, "utf8");

  const store = await new EventStore(path).init();
  const events = await store.list(10);
  await store.close();

  assert.equal(events.length, 1);
  assert.equal(events[0].schemaVersion, 2, "store loads raw events regardless of version");

  const tombstone = unsupportedEventEnvelope(events[0]);
  assert.equal(tombstone.type, EVENT_PROTOCOL_FAULT_TYPE);
  assert.equal(tombstone.sequence, 1);
  assert.equal(tombstone.runId, "run-future");
  assert.equal(tombstone.data.secretPayload, undefined, "tombstone never carries original data");
  assert.deepEqual(tombstone.data, { unsupportedSchemaVersion: 2 });
});

test("eventForPublic gate pattern: supported versions pass, unknown versions tombstone", () => {
  const supportedEvent = { schemaVersion: 1, type: "test.event", data: { value: 1 }, sequence: 1, runId: "run-a" };
  const unknownEvent = { schemaVersion: 99, type: "secret.type", data: { password: "x" }, sequence: 2, runId: "run-b" };
  const unversionedEvent = { type: "synthetic.ready", data: {}, sequence: 3 };

  assert.equal(classifyEventEnvelope(supportedEvent), "ok");
  assert.equal(classifyEventEnvelope(unknownEvent), "unsupported");
  assert.equal(classifyEventEnvelope(unversionedEvent), "unversioned");

  const tombstone = unsupportedEventEnvelope(unknownEvent);
  assert.equal(tombstone.data.password, undefined);
  assert.equal(tombstone.data.unsupportedSchemaVersion, 99);
});

// ── 5. Client 契约（源码断言） ──────────────────────────────────

test("app.js normalizeEvent has a schemaVersion fail-closed gate", async () => {
  const app = await readFile(resolve(appRoot, "public/app.js"), "utf8").then((text) => text.replace(/\r\n/g, "\n"));
  assertIncludes(app, "isSupportedEventSchemaVersion");
  assertIncludes(app, "envelope.schemaVersion !== undefined && !isSupportedEventSchemaVersion(envelope.schemaVersion)");
});

test("app.js parseSseFrame drops null events from normalizeEvent and logs diagnostic", async () => {
  const app = await readFile(resolve(appRoot, "public/app.js"), "utf8").then((text) => text.replace(/\r\n/g, "\n"));
  assertIncludes(app, "noteDroppedProtocolVersion(parsed?.schemaVersion)");
  assertIncludes(app, "function noteDroppedProtocolVersion(version)");
  assertIncludes(app, "droppedProtocolVersions");
});

test("app.js ready handler checks server protocol version compatibility", async () => {
  const app = await readFile(resolve(appRoot, "public/app.js"), "utf8").then((text) => text.replace(/\r\n/g, "\n"));
  assertIncludes(app, "readServerEventSchemaVersions(parsed)");
  assertIncludes(app, "服务端事件协议版本不受支持，部分事件可能丢失");
});

test("server.mjs eventForPublic gate returns tombstone for unknown schemaVersion", async () => {
  const server = await readFile(resolve(appRoot, "server.mjs"), "utf8").then((text) => text.replace(/\r\n/g, "\n"));
  assertIncludes(server, "SUPPORTED_EVENT_SCHEMA_VERSIONS.includes(event.schemaVersion)");
  assertIncludes(server, "unsupportedEventEnvelope(event)");
  assertIncludes(server, "eventProtocolFaults.count++");
});

test("server.mjs ready payload declares eventSchema and eventSchemaVersions", async () => {
  const server = await readFile(resolve(appRoot, "server.mjs"), "utf8").then((text) => text.replace(/\r\n/g, "\n"));
  assertIncludes(server, "eventSchema: EVENT_ENVELOPE_SCHEMA");
  assertIncludes(server, "eventSchemaVersions: [...SUPPORTED_EVENT_SCHEMA_VERSIONS]");
});
