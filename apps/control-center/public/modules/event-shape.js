/**
 * Event envelope shape — single source of truth for field names, types, constraints (HX-03, 2026-09-01).
 * Consumed by: generate-event-schema.mjs (JSON Schema), event-store.mjs (dev validation),
 * contracts.schema.json (generated). Pure ESM, no DOM/Node dependencies.
 *
 * When adding a field to event-store.mjs emit(), add it here first.
 * Run `npm run schema:generate` to update contracts.schema.json.
 */

export const EVENT_ENVELOPE_FIELDS = Object.freeze({
  schemaVersion: { type: "integer", const: 1, required: true },
  eventId: { type: "string", format: "uuid", required: true },
  sequence: { type: "integer", minimum: 1, required: true },
  timestamp: { type: "string", format: "date-time", required: true },
  type: { type: "string", required: true },
  runId: { type: ["string", "null"], required: true },
  sessionId: { type: ["string", "null"] },
  parentSessionId: { type: ["string", "null"] },
  agentId: { type: ["string", "null"] },
  correlationId: { type: ["string", "null"] },
  causationId: { type: ["string", "null"] },
  traceId: { type: ["string", "null"] },
  sensitivity: { type: "string", enum: ["public", "internal", "sensitive"], required: true },
  data: { type: "object", required: true },
  sourceRefs: {
    type: "array",
    maxItems: 16,
    items: {
      type: "object",
      required: ["kind", "path", "name"],
      properties: {
        kind: { type: "string" },
        path: { type: "string" },
        name: { type: "string", maxLength: 180 },
      },
      additionalProperties: false,
    },
  },
  prev: { type: "string" },
  hash: { type: "string" },
});

export function getRequiredEventFields() {
  return Object.entries(EVENT_ENVELOPE_FIELDS)
    .filter(([, spec]) => spec.required)
    .map(([name]) => name);
}

export function buildEventEnvelopeSchema() {
  const properties = {};
  for (const [name, spec] of Object.entries(EVENT_ENVELOPE_FIELDS)) {
    const { required, ...jsonSchema } = spec;
    properties[name] = jsonSchema;
  }
  return {
    type: "object",
    required: getRequiredEventFields(),
    properties,
    additionalProperties: false,
  };
}
