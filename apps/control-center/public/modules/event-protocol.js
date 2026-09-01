/**
 * Event envelope protocol constants (HX-02, 2026-09-01).
 * Single source of truth for schema version — imported by both server (event-store.mjs, server.mjs)
 * and client (app.js). Pure ESM, no DOM/Node dependencies.
 *
 * Fail-closed rule: present-but-unknown schemaVersion is rejected on both ends.
 * Absent schemaVersion is tolerated (server-synthetic frames like replay_error/ready lack it).
 */

export const EVENT_ENVELOPE_SCHEMA = "514cc.event-envelope/v1";
export const EVENT_ENVELOPE_SCHEMA_VERSION = 1;
export const SUPPORTED_EVENT_SCHEMA_VERSIONS = Object.freeze([1]);
export const EVENT_PROTOCOL_FAULT_TYPE = "protocol.unsupported_envelope";

export function isSupportedEventSchemaVersion(version) {
  return version !== undefined && SUPPORTED_EVENT_SCHEMA_VERSIONS.includes(version);
}

export function classifyEventEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return "unversioned";
  if (envelope.schemaVersion === undefined) return "unversioned";
  return isSupportedEventSchemaVersion(envelope.schemaVersion) ? "ok" : "unsupported";
}

export function unsupportedEventEnvelope(event) {
  return {
    schemaVersion: EVENT_ENVELOPE_SCHEMA_VERSION,
    eventId: event?.eventId || String(Date.now()),
    sequence: event?.sequence ?? 0,
    timestamp: event?.timestamp ?? new Date().toISOString(),
    type: EVENT_PROTOCOL_FAULT_TYPE,
    runId: event?.runId ?? null,
    sensitivity: "public",
    data: { unsupportedSchemaVersion: event?.schemaVersion ?? null },
  };
}

export function readServerEventSchemaVersions(readyPayload) {
  if (!readyPayload || typeof readyPayload !== "object") return [];
  return Array.isArray(readyPayload.eventSchemaVersions) ? readyPayload.eventSchemaVersions : [];
}
