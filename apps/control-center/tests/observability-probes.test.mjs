import test from "node:test";
import assert from "node:assert/strict";
import {
  handleHealthz,
  createReadinessChecker,
  handleReadyz,
  traceIdFromRequest,
  traceShort,
  collectCrashSnapshot,
  writeCrashSnapshot,
} from "../src/observability-probes.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── 1. /healthz ─────────────────────────────────────────────────────────────

test("healthz returns 200 with status ok and timestamp", () => {
  let statusCode = null;
  let headers = {};
  let body = "";
  const response = {
    writeHead(code, hdrs) { statusCode = code; headers = hdrs; },
    end(data) { body = data; },
  };
  handleHealthz(response);
  assert.equal(statusCode, 200);
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["cache-control"], "no-store");
  const parsed = JSON.parse(body);
  assert.equal(parsed.status, "ok");
  assert.ok(parsed.timestamp, "must include timestamp");
});

// ─── 2. /readyz ──────────────────────────────────────────────────────────────

test("readyz returns 200 when all checks pass", async () => {
  const readiness = createReadinessChecker();
  readiness.register("db", () => true);
  readiness.register("cache", () => true);

  let statusCode = null;
  let body = "";
  const response = {
    writeHead(code) { statusCode = code; },
    end(data) { body = data; },
  };
  await handleReadyz(response, readiness);
  assert.equal(statusCode, 200);
  const parsed = JSON.parse(body);
  assert.equal(parsed.ready, true);
  assert.deepEqual(parsed.details, { db: { ready: true }, cache: { ready: true } });
});

test("readyz returns 503 when any check fails", async () => {
  const readiness = createReadinessChecker();
  readiness.register("db", () => true);
  readiness.register("cache", () => false);

  let statusCode = null;
  let body = "";
  const response = {
    writeHead(code) { statusCode = code; },
    end(data) { body = data; },
  };
  await handleReadyz(response, readiness);
  assert.equal(statusCode, 503);
  const parsed = JSON.parse(body);
  assert.equal(parsed.ready, false);
  assert.equal(parsed.details.cache.ready, false);
});

test("readyz handles check errors gracefully", async () => {
  const readiness = createReadinessChecker();
  readiness.register("db", () => { throw new Error("connection refused"); });

  let statusCode = null;
  let body = "";
  const response = {
    writeHead(code) { statusCode = code; },
    end(data) { body = data; },
  };
  await handleReadyz(response, readiness);
  assert.equal(statusCode, 503);
  const parsed = JSON.parse(body);
  assert.equal(parsed.ready, false);
  assert.equal(parsed.details.db.ready, false);
  assert.match(parsed.details.db.error, /connection refused/);
});

test("readyz with no checks returns ready=true", async () => {
  const readiness = createReadinessChecker();
  let body = "";
  const response = {
    writeHead() {},
    end(data) { body = data; },
  };
  await handleReadyz(response, readiness);
  const parsed = JSON.parse(body);
  assert.equal(parsed.ready, true);
  assert.deepEqual(parsed.details, {});
});

test("readiness checker supports async checks", async () => {
  const readiness = createReadinessChecker();
  readiness.register("slow", async () => {
    await new Promise((r) => setTimeout(r, 10));
    return true;
  });

  const result = await readiness.check();
  assert.equal(result.ready, true);
  assert.equal(result.details.slow.ready, true);
});

test("readiness checker supports unregister", async () => {
  const readiness = createReadinessChecker();
  readiness.register("a", () => true);
  readiness.register("b", () => false);
  readiness.unregister("b");

  const result = await readiness.check();
  assert.equal(result.ready, true);
  assert.equal(result.details.b, undefined);
});

// ─── 3. Trace ID ─────────────────────────────────────────────────────────────

test("traceIdFromRequest passes through valid x-request-id", () => {
  const request = { headers: { "x-request-id": "abc-123-def" } };
  assert.equal(traceIdFromRequest(request), "abc-123-def");
});

test("traceIdFromRequest generates UUID when header is missing", () => {
  const request = { headers: {} };
  const id = traceIdFromRequest(request);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("traceIdFromRequest rejects overly long header", () => {
  const request = { headers: { "x-request-id": "x".repeat(200) } };
  const id = traceIdFromRequest(request);
  // Should generate a new one instead of using the too-long header
  assert.match(id, /^[0-9a-f]{8}-/);
});

test("traceShort returns first 8 chars", () => {
  assert.equal(traceShort("abcdef12-3456-7890-abcd-ef1234567890"), "abcdef12");
  assert.equal(traceShort(null), "--------");
  assert.equal(traceShort(""), "--------");
});

// ─── 4. 崩溃快照 ─────────────────────────────────────────────────────────────

test("collectCrashSnapshot captures process info", () => {
  const snapshot = collectCrashSnapshot({
    pid: 12345,
    generation: 42,
    startedAt: "2026-08-30T00:00:00.000Z",
    repoRoot: "/test/repo",
    getActiveRuns: () => [{ id: "run-1", status: "running" }],
    getPendingApprovals: () => 3,
    getChildProcesses: () => [{ pid: 99, command: "claude" }],
  });

  assert.equal(snapshot.pid, 12345);
  assert.equal(snapshot.generation, 42);
  assert.ok(snapshot.uptime >= 0);
  assert.equal(snapshot.repoRoot, "/test/repo");
  assert.ok(snapshot.nodeVersion);
  assert.ok(snapshot.memory.rss > 0);
  assert.deepEqual(snapshot.activeRuns, [{ id: "run-1", status: "running" }]);
  assert.equal(snapshot.pendingApprovals, 3);
  assert.deepEqual(snapshot.childProcesses, [{ pid: 99, command: "claude" }]);
});

test("collectCrashSnapshot handles missing callbacks", () => {
  const snapshot = collectCrashSnapshot({ pid: 1 });
  assert.equal(snapshot.pid, 1);
  assert.equal(snapshot.activeRuns, null);
  assert.equal(snapshot.pendingApprovals, null);
  assert.equal(snapshot.childProcesses, null);
});

test("writeCrashSnapshot writes JSON file and returns path", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "crash-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const snapshot = { timestamp: "2026-08-30T00:00:00.000Z", pid: 12345 };
  const filepath = writeCrashSnapshot(snapshot, dir);
  assert.ok(filepath, "should return a file path");

  const content = JSON.parse(await readFile(filepath, "utf8"));
  assert.equal(content.pid, 12345);
  assert.equal(content.timestamp, "2026-08-30T00:00:00.000Z");
});

test("writeCrashSnapshot never throws on write failure", () => {
  // 写到不存在的路径（/dev/null 在 Windows 上不存在）
  const result = writeCrashSnapshot({ timestamp: "2026-08-30T00:00:00.000Z", pid: 1 }, "Z:\\nonexistent\\impossible\\path");
  assert.equal(result, null);
});
