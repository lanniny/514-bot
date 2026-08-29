import { createHash } from "node:crypto";
import { scrub } from "./redaction.mjs";

export const RUN_ARTIFACT_SCHEMA = "514cc.run-artifact/v1";

function shortText(value, limit = 180, fallback = "") {
  const clean = scrub(String(value ?? ""))
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!clean) return fallback;
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function timestamp(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function digestOf(parts) {
  return createHash("sha256").update(parts.filter(Boolean).join("\0"), "utf8").digest("hex").slice(0, 16);
}

function artifactId(runId, kind, identity) {
  return `artifact-${digestOf(["514cc.run-artifact/v1", runId, kind, identity])}`;
}

export function artifactAvailability({
  exists = true,
  truncated = false,
  digest = null,
  expectedDigest = null,
  sourceRunId = null,
  runId = null,
} = {}) {
  if (exists !== true) return "missing";
  if (truncated === true) return "truncated";
  if (expectedDigest && digest && expectedDigest !== digest) return "digest-changed";
  if (sourceRunId && runId && sourceRunId !== runId) return "stale-run";
  return "available";
}

export function projectEvidenceArtifact(input = {}) {
  const runId = shortText(input.runId, 80);
  const kind = shortText(input.kind, 24, "handoff");
  const name = shortText(input.name, 180, kind);
  const digest = input.digest ? shortText(input.digest, 64) : (input.content ? digestOf([input.content]) : null);
  const availability = artifactAvailability({
    exists: input.exists !== false,
    truncated: input.truncated === true,
    digest,
    expectedDigest: input.expectedDigest || null,
    sourceRunId: input.sourceRunId || null,
    runId,
  });
  return {
    id: artifactId(runId, kind, input.id || name || digest),
    kind,
    label: name,
    availability,
    count: Number.isSafeInteger(input.count) ? input.count : null,
    endpoint: input.endpoint || null,
    digest,
    generatedAt: timestamp(input.generatedAt || input.modifiedAt),
    verifyCommand: shortText(input.verifyCommand, 160) || null,
    attemptId: shortText(input.attemptId, 80) || null,
    published: false,
    sourceRunId: input.sourceRunId ? shortText(input.sourceRunId, 80) : null,
  };
}

function tokenContainsRunId(value, runId) {
  const haystack = String(value ?? "").toLowerCase();
  const needle = String(runId ?? "").trim().toLowerCase();
  if (!haystack || !needle) return false;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return false;
    const before = haystack[index - 1] || "";
    const after = haystack[index + needle.length] || "";
    // Run ids are opaque identifiers. A token boundary prevents run-1 from
    // claiming evidence named for run-10 (or an arbitrary title containing it).
    if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) return true;
    offset = index + Math.max(1, needle.length);
  }
  return false;
}

function evidenceBelongsToRun(value, run) {
  const runId = String(run?.id ?? "").trim();
  if (!runId || !value || typeof value !== "object") return false;
  const explicitRunId = String(value.runId ?? value.sourceRunId ?? "").trim();
  // An explicit source is authoritative. Never rescue a cross-run record with
  // a coincidental mention in its filename or prose.
  if (explicitRunId) return explicitRunId === runId;
  return [value.name, value.content, value.topic, value.evidence, value.id]
    .some((candidate) => tokenContainsRunId(candidate, runId));
}

export function collectRunEvidenceArtifacts({
  run,
  handoffs = [],
  deltas = [],
} = {}) {
  if (!run?.id) return [];
  const cards = [];
  for (const file of handoffs) {
    if (!evidenceBelongsToRun(file, run)) continue;
    cards.push(projectEvidenceArtifact({
      runId: run.id,
      kind: "handoff",
      name: file.name,
      exists: file.exists !== false,
      truncated: file.truncated === true,
      digest: file.digest,
      expectedDigest: file.expectedDigest,
      sourceRunId: file.runId || null,
      generatedAt: file.modifiedAt,
      content: file.content,
      verifyCommand: "rg \"^__DELTA__:\" .ai-shared/handoff",
      endpoint: `/api/observability/handoffs/${encodeURIComponent(file.name || "")}`,
    }));
  }
  for (const entry of deltas) {
    if (!evidenceBelongsToRun(entry, run)) continue;
    cards.push(projectEvidenceArtifact({
      runId: run.id,
      kind: "delta",
      name: `DELTA ${entry.agent || "unknown"} · ${entry.score ?? "?"}`,
      exists: true,
      digest: digestOf([entry.id, entry.agent, entry.score, entry.evidence]),
      generatedAt: entry.ts,
      verifyCommand: "rg \"^__DELTA__:\" .ai-shared/handoff .ai-shared/decisions.md",
      sourceRunId: entry.runId || null,
    }));
  }
  return cards.slice(0, 16);
}
