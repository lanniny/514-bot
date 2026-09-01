import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVENT_ENVELOPE_FIELDS,
  getRequiredEventFields,
  buildEventEnvelopeSchema,
} from "../public/modules/event-shape.js";
import { EventStore } from "../src/event-store.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const appRoot = resolve(__dirname, "..");

// ── 1. 形状完整性 ────────────────────────────────────────────────

test("EVENT_ENVELOPE_FIELDS covers all fields emitted by EventStore.emit()", async (t) => {
  const expectedFields = [
    "schemaVersion",
    "eventId",
    "sequence",
    "timestamp",
    "type",
    "runId",
    "sessionId",
    "parentSessionId",
    "agentId",
    "correlationId",
    "causationId",
    "sensitivity",
    "data",
    "sourceRefs",
    "prev",
    "hash",
  ];
  for (const field of expectedFields) {
    assert.ok(field in EVENT_ENVELOPE_FIELDS, `missing field: ${field}`);
  }
});

test("EVENT_ENVELOPE_FIELDS is frozen", () => {
  assert.ok(Object.isFrozen(EVENT_ENVELOPE_FIELDS));
});

// ── 2. Required 字段 ─────────────────────────────────────────────

test("getRequiredEventFields returns expected required fields", () => {
  const required = getRequiredEventFields();
  const expected = [
    "schemaVersion",
    "eventId",
    "sequence",
    "timestamp",
    "type",
    "runId",
    "sensitivity",
    "data",
  ];
  assert.deepEqual(required.sort(), expected.sort());
});

test("required fields match schema.required", () => {
  const schema = buildEventEnvelopeSchema();
  assert.deepEqual(schema.required.sort(), getRequiredEventFields().sort());
});

// ── 3. 类型约束 ──────────────────────────────────────────────────

test("sensitivity has correct enum constraint", () => {
  const field = EVENT_ENVELOPE_FIELDS.sensitivity;
  assert.deepEqual(field.enum, ["public", "internal", "sensitive"]);
  assert.equal(field.type, "string");
});

test("sequence has minimum constraint", () => {
  const field = EVENT_ENVELOPE_FIELDS.sequence;
  assert.equal(field.type, "integer");
  assert.equal(field.minimum, 1);
});

test("schemaVersion has const constraint", () => {
  const field = EVENT_ENVELOPE_FIELDS.schemaVersion;
  assert.equal(field.const, 1);
  assert.equal(field.type, "integer");
});

test("eventId has uuid format", () => {
  const field = EVENT_ENVELOPE_FIELDS.eventId;
  assert.equal(field.type, "string");
  assert.equal(field.format, "uuid");
});

test("sourceRefs has correct structure", () => {
  const field = EVENT_ENVELOPE_FIELDS.sourceRefs;
  assert.equal(field.type, "array");
  assert.equal(field.maxItems, 16);
  assert.equal(field.items.type, "object");
  assert.deepEqual(field.items.required.sort(), ["kind", "name", "path"].sort());
  assert.equal(field.items.properties.name.maxLength, 180);
  assert.equal(field.items.additionalProperties, false);
});

// ── 4. Schema 生成 ───────────────────────────────────────────────

test("buildEventEnvelopeSchema produces valid schema structure", () => {
  const schema = buildEventEnvelopeSchema();
  assert.equal(schema.type, "object");
  assert.ok(Array.isArray(schema.required));
  assert.ok(typeof schema.properties === "object");
  assert.equal(schema.additionalProperties, false);
});

test("generated schema properties match EVENT_ENVELOPE_FIELDS", () => {
  const schema = buildEventEnvelopeSchema();
  const fieldNames = Object.keys(EVENT_ENVELOPE_FIELDS);
  const propNames = Object.keys(schema.properties);
  assert.deepEqual(propNames.sort(), fieldNames.sort());
});

test("generated schema strips 'required' from field specs", () => {
  const schema = buildEventEnvelopeSchema();
  for (const [name, prop] of Object.entries(schema.properties)) {
    assert.ok(!("required" in prop), `${name} should not have 'required' in properties`);
  }
});

test("generated contracts.schema.json eventEnvelope matches buildEventEnvelopeSchema()", async () => {
  const schemaPath = resolve(appRoot, "../../schemas/control-center/contracts.schema.json");
  const raw = JSON.parse(await readFile(schemaPath, "utf8"));
  const actual = raw.$defs?.eventEnvelope;
  assert.ok(actual, "eventEnvelope not found in $defs");
  const expected = buildEventEnvelopeSchema();

  // Compare structure, but sort required arrays for order-independence
  const normalize = (obj) => {
    if (Array.isArray(obj)) return obj.map(normalize);
    if (obj && typeof obj === "object") {
      const result = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = k === "required" && Array.isArray(v) ? [...v].sort() : normalize(v);
      }
      return result;
    }
    return obj;
  };

  assert.deepEqual(normalize(actual), normalize(expected));
});

// ── 5. Producer 一致性 ───────────────────────────────────────────

test("EventStore.emit() produces events conforming to shape", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const dir = await mkdtemp(resolve(appRoot, ".test-shape-producer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = await new EventStore(resolve(dir, "events.jsonl")).init();
  await store.emit("test.event", { message: "hello" }, { runId: "run-1" });
  await store.close();

  const lines = (await readFile(resolve(dir, "events.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);

  const required = getRequiredEventFields();
  for (const field of required) {
    assert.ok(field in event, `emitted event missing required field: ${field}`);
  }
  assert.equal(event.schemaVersion, EVENT_ENVELOPE_FIELDS.schemaVersion.const);
  assert.equal(event.type, "test.event");
  assert.equal(event.runId, "run-1");
});
