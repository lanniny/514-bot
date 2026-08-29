import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../src/process-runner.mjs";
import { RELEASE_COMMAND_EVIDENCE_SCHEMA, RELEASE_COMMAND_IDS } from "../src/release-record.mjs";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRepo = resolve(appRoot, "../..");

async function runGit(repoRoot, args) {
  const result = await runProcess("git", ["-C", repoRoot, ...args], { provider: null, timeoutMs: 10_000 });
  assert.equal(result.code, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function createReleaseFixtureRepo(root) {
  const repoRoot = resolve(root, "repo");
  const configRoot = resolve(repoRoot, "config/control-center");
  const schemaRoot = resolve(repoRoot, "schemas/control-center");
  await mkdir(configRoot, { recursive: true });
  await mkdir(schemaRoot, { recursive: true });
  for (const name of ["models.json", "routing.json", "permissions.json", "claude-coordinator.md"]) {
    await cp(resolve(sourceRepo, "config/control-center", name), resolve(configRoot, name));
  }
  await cp(resolve(sourceRepo, "schemas/control-center/contracts.schema.json"), resolve(schemaRoot, "contracts.schema.json"));
  await writeFile(resolve(configRoot, "sources.json"), `${JSON.stringify({
    version: 1,
    explicit: [
      { id: "control.models", path: "config/control-center/models.json", label: "Models", kind: "json", scope: "repo", critical: true },
      { id: "control.routing", path: "config/control-center/routing.json", label: "Routing", kind: "json", scope: "repo", critical: true },
      { id: "control.permissions", path: "config/control-center/permissions.json", label: "Permissions", kind: "json", scope: "repo", critical: true },
      { id: "control.claude-coordinator", path: "config/control-center/claude-coordinator.md", label: "Coordinator", kind: "markdown", scope: "repo", critical: true },
    ],
    discover: [],
    runtime: [],
  }, null, 2)}\n`, "utf8");
  await runGit(repoRoot, ["init", "-q"]);
  await runGit(repoRoot, ["config", "user.email", "release-fixture@514cc.local"]);
  await runGit(repoRoot, ["config", "user.name", "514cc Release Fixture"]);
  await runGit(repoRoot, ["add", "."]);
  await runGit(repoRoot, ["commit", "-q", "-m", "release fixture"]);
  return repoRoot;
}

async function waitFor(predicate, { timeoutMs = 10_000, message = "condition was not met" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 25));
  }
  throw new Error(message);
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function getWithoutAccept(url, headers = {}) {
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest(url, { method: "GET", headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolveResponse({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.once("error", rejectResponse);
    });
    request.once("error", rejectResponse);
    request.end();
  });
}

test("run history supports incremental NDJSON without changing the JSON contract", { timeout: 45_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-run-history-stream-"));
  const token = "e2e-run-history-stream-token";
  const runId = "stream-history-run";
  const events = Array.from({ length: 300 }, (_, index) => ({
    schemaVersion: 1,
    eventId: `stream-history-${index + 1}`,
    sequence: index + 1,
    timestamp: new Date(index).toISOString(),
    type: index % 2 ? "assistant.message" : "runtime.heartbeat",
    runId,
    data: index % 2 ? { text: `message ${index + 1}` } : { status: "ok" },
  }));
  await writeFile(resolve(dataRoot, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  const child = spawnTestServer({
    env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
  });
  t.after(async () => {
    await stopTestServer(child, { token });
    await rm(dataRoot, { recursive: true, force: true });
  });
  const origin = new URL(await waitForUrl(child)).origin;
  const authorization = `Bearer ${token}`;

  const jsonResponse = await fetch(`${origin}/api/runs/${runId}/events`, {
    headers: { authorization, accept: "application/json" },
  });
  assert.equal(jsonResponse.status, 200);
  assert.match(jsonResponse.headers.get("content-type"), /application\/json/);
  const jsonEvents = (await jsonResponse.json()).events;

  const implicitJson = await getWithoutAccept(`${origin}/api/runs/${runId}/events`, { authorization });
  assert.equal(implicitJson.status, 200, "a missing Accept header must retain the legacy JSON default");
  assert.match(String(implicitJson.headers["content-type"] ?? ""), /application\/json/);
  assert.deepEqual(JSON.parse(implicitJson.body).events, jsonEvents);

  const streamResponse = await fetch(`${origin}/api/runs/${runId}/events`, {
    headers: { authorization, accept: "application/x-ndjson, application/json;q=0.9" },
  });
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get("content-type"), /application\/x-ndjson/);
  const streamedEvents = (await streamResponse.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(streamedEvents, jsonEvents);
  assert.deepEqual(streamedEvents.map((event) => event.sequence), events.map((event) => event.sequence));

  for (const accept of [
    "Application/X-NDJSON",
    "application/x-ndjson;q=0, application/json",
    "application/x-ndjson;q=0.4, application/json;q=0.9",
    "application/json, application/x-ndjson",
  ]) {
    const response = await fetch(`${origin}/api/runs/${runId}/events`, {
      headers: { authorization, accept },
    });
    assert.equal(response.status, 200);
    const contentType = response.headers.get("content-type") ?? "";
    if (accept === "Application/X-NDJSON") assert.match(contentType, /application\/x-ndjson/);
    else assert.match(contentType, /application\/json/);
    await response.arrayBuffer();
  }

  for (const accept of [
    "text/plain",
    "application/x-ndjson;q=0",
    "application/json;q=0, application/x-ndjson;q=0",
  ]) {
    const response = await fetch(`${origin}/api/runs/${runId}/events`, {
      headers: { authorization, accept },
    });
    assert.equal(response.status, 406, `unsupported Accept must fail: ${accept}`);
    assert.equal((await response.json()).error?.code, "NOT_ACCEPTABLE");
  }
});

test("bounded UI event views omit oversized history and SSE payloads", { timeout: 45_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-ui-event-view-"));
  const token = "e2e-ui-event-view-token";
  const runId = "ui-event-view-run";
  const secret = "token=e2e-ui-event-view-secret";
  const text = `${secret}\n${"L".repeat(512 * 1024)}`;
  const event = {
    schemaVersion: 1,
    eventId: "ui-event-view-large",
    sequence: 1,
    timestamp: new Date(0).toISOString(),
    type: "assistant.message",
    runId,
    agentId: "codex-technical",
    data: { text },
  };
  await writeFile(resolve(dataRoot, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  const child = spawnTestServer({
    env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
  });
  t.after(async () => {
    await stopTestServer(child, { token });
    await rm(dataRoot, { recursive: true, force: true });
  });
  const origin = new URL(await waitForUrl(child)).origin;
  const authorization = `Bearer ${token}`;

  const historyResponse = await fetch(`${origin}/api/runs/${runId}/events?view=ui`, {
    headers: { authorization, accept: "application/x-ndjson" },
  });
  assert.equal(historyResponse.status, 200);
  const historyText = await historyResponse.text();
  const projected = JSON.parse(historyText.trim());
  assert.equal(projected.data.text, "");
  assert.equal(projected.data.textLength, text.length);
  assert.equal(projected.data.textOmitted, true);
  assert.equal(historyText.includes(secret), false);
  assert.ok(historyText.length < 20_000, `UI history response remained too large: ${historyText.length}`);

  const controller = new AbortController();
  const streamResponse = await fetch(`${origin}/api/events?after=0&view=ui`, {
    headers: { authorization },
    signal: controller.signal,
  });
  const reader = streamResponse.body.getReader();
  const decoder = new TextDecoder();
  let streamText = "";
  try {
    while (!streamText.includes("ui-event-view-large")) {
      const { done, value } = await reader.read();
      if (done) break;
      streamText += decoder.decode(value, { stream: true });
      assert.ok(streamText.length < 50_000, "bounded SSE view retained an oversized payload");
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  assert.match(streamText, /ui-event-view-large/);
  assert.equal(streamText.includes(secret), false);
  assert.match(streamText, new RegExp(`\"textLength\":${text.length}`));
});

test("aborting real run-history sockets cancels the shared scan and restores response capacity", { timeout: 45_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-run-history-abort-"));
  const token = "e2e-run-history-abort-token";
  const runId = "evicted-run-0";
  const rows = Array.from({ length: 129 }, (_, index) => ({
    schemaVersion: 1,
    eventId: `history-abort-${index + 1}`,
    sequence: index + 1,
    timestamp: new Date(index).toISOString(),
    type: "runtime.heartbeat",
    runId: index === 0 ? runId : `retained-run-${index}`,
    data: { index },
  }));
  await writeFile(resolve(dataRoot, "events.jsonl"), `${rows.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  const child = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: token,
      CONTROL_CENTER_DATA_DIR: dataRoot,
      CONTROL_CENTER_PORT: "0",
      CONTROL_CENTER_TEST_RUN_HISTORY_SCAN_DELAY_MS: "750",
    },
  });
  t.after(async () => {
    await stopTestServer(child, { token });
    await rm(dataRoot, { recursive: true, force: true });
  });
  const origin = new URL(await waitForUrl(child)).origin;
  const headers = { authorization: `Bearer ${token}`, accept: "application/x-ndjson" };
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map((controller) => fetch(`${origin}/api/runs/${runId}/events`, {
    headers,
    signal: controller.signal,
  }).catch((error) => error));

  await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
  const saturated = await fetch(`${origin}/api/runs/${runId}/events`, { headers });
  assert.equal(saturated.status, 503, "four live same-run leases must enforce the capacity gate");
  assert.equal(saturated.headers.get("retry-after"), "1");
  await saturated.arrayBuffer();

  for (const controller of controllers) controller.abort();
  const cancelled = await Promise.all(pending);
  assert.ok(cancelled.every((result) => result?.name === "AbortError"));

  const recovered = await fetch(`${origin}/api/runs/${runId}/events`, { headers });
  assert.equal(recovered.status, 200, "disconnect cancellation must release every same-run lease");
  const recoveredEvents = (await recovered.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(recoveredEvents.map((event) => event.sequence), [1]);
});

test("disconnecting observability pulse cancels the final health subscriber's probe", { timeout: 45_000 }, async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-pulse-abort-"));
  const repoRoot = resolve(root, "repo");
  const dataRoot = resolve(root, "data");
  const configRoot = resolve(repoRoot, "config", "control-center");
  const sourceConfigRoot = resolve(appRoot, "..", "..", "config", "control-center");
  const probeScript = resolve(root, process.platform === "win32" ? "pulse-probe.ps1" : "pulse-probe");
  const probePidFile = resolve(root, "pulse-probe.pid");
  const token = "e2e-pulse-abort-token";
  await mkdir(configRoot, { recursive: true });

  const [modelsText, routingText, permissionsText] = await Promise.all([
    readFile(resolve(sourceConfigRoot, "models.json"), "utf8"),
    readFile(resolve(sourceConfigRoot, "routing.json"), "utf8"),
    readFile(resolve(sourceConfigRoot, "permissions.json"), "utf8"),
  ]);
  const models = JSON.parse(modelsText);
  for (const profile of models.profiles) {
    profile.enabled = true;
    if (profile.command !== null) {
      profile.command = profile.id === "claude-fable" ? probeScript : process.execPath;
    }
    profile.healthTimeoutMs = 30_000;
  }
  const quotedPidFile = probePidFile.replaceAll("'", "''");
  const probeSource = process.platform === "win32"
    ? [
        `if (Test-Path -LiteralPath '${quotedPidFile}') { Write-Output 'pulse-probe 1.0'; exit 0 }`,
        `Set-Content -LiteralPath '${quotedPidFile}' -Value $PID -Encoding ASCII`,
        "Start-Sleep -Seconds 30",
        "Write-Output 'pulse-probe 1.0'",
      ].join("\r\n")
    : [
        "#!/usr/bin/env node",
        "const { existsSync, writeFileSync } = require('node:fs');",
        `const marker = ${JSON.stringify(probePidFile)};`,
        "if (existsSync(marker)) { process.stdout.write('pulse-probe 1.0\\n'); process.exit(0); }",
        "writeFileSync(marker, String(process.pid), 'ascii');",
        "setTimeout(() => process.stdout.write('pulse-probe 1.0\\n'), 30_000);",
      ].join("\n");
  await Promise.all([
    writeFile(resolve(configRoot, "models.json"), `${JSON.stringify(models, null, 2)}\n`, "utf8"),
    writeFile(resolve(configRoot, "routing.json"), routingText, "utf8"),
    writeFile(resolve(configRoot, "permissions.json"), permissionsText, "utf8"),
    writeFile(resolve(configRoot, "sources.json"), `${JSON.stringify({ version: 1, explicit: [], discover: [], runtime: [] }, null, 2)}\n`, "utf8"),
    writeFile(probeScript, probeSource, "ascii"),
  ]);
  if (process.platform !== "win32") await chmod(probeScript, 0o755);

  const child = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: token,
      CONTROL_CENTER_DATA_DIR: dataRoot,
      CONTROL_CENTER_REPO_ROOT: repoRoot,
      CONTROL_CENTER_PORT: "0",
    },
  });
  t.after(async () => {
    await stopTestServer(child, { token });
    await rm(root, { recursive: true, force: true });
  });
  const origin = new URL(await waitForUrl(child)).origin;
  const endpoint = `${origin}/api/observability/pulse`;
  const headers = { authorization: `Bearer ${token}` };
  const request = httpRequest(endpoint, { method: "GET", headers }, (response) => response.resume());
  const requestClosed = new Promise((resolveClosed) => {
    request.once("error", resolveClosed);
    request.once("close", resolveClosed);
  });
  request.end();

  let probePid;
  try {
    const pidText = await waitFor(async () => {
      try {
        return (await readFile(probePidFile, "utf8")).trim() || false;
      } catch (error) {
        // Windows 瞬时锁也按未就绪重试：probe 落 pid 文件瞬间 readFile 会撞 EBUSY/EPERM（全量并行时高频复现）
        if (["ENOENT", "EBUSY", "EPERM"].includes(error?.code)) return false;
        throw error;
      }
    }, { timeoutMs: 20_000, message: "pulse request never reached the underlying health probe" });
    probePid = Number(pidText);
    assert.equal(Number.isSafeInteger(probePid) && probePid > 0, true);
    assert.equal(processIsRunning(probePid), true, "probe must still be active before the client disconnects");
  } finally {
    request.destroy();
    await requestClosed;
  }

  await waitFor(() => !processIsRunning(probePid), {
    message: `health probe process ${probePid} survived after the final pulse subscriber disconnected`,
  });
  assert.equal(processIsRunning(probePid), false);

  const recovered = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10_000) });
  assert.equal(recovered.status, 200, "a cancelled pulse must release its response lease and health inflight slot");
  const pulse = await recovered.json();
  assert.ok(pulse.runtime.components.some((item) => item.id === "claude-fable" && item.status === "online"));
});

test("SSE replay honors socket backpressure and preserves every sequence", { timeout: 90_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-sse-pressure-"));
  const token = "e2e-sse-token-0123456789";
  const total = 1300;
  const payload = "x".repeat(8 * 1024);
  const historical = Array.from({ length: total }, (_, index) => JSON.stringify({
    schemaVersion: 1,
    eventId: `pressure-${index + 1}`,
    sequence: index + 1,
    timestamp: new Date(index).toISOString(),
    type: "pressure.event",
    runId: "pressure-run",
    data: { index: index + 1, payload },
  })).join("\n");
  await writeFile(resolve(dataRoot, "events.jsonl"), `${historical}\n`, "utf8");
  const child = spawnTestServer({
    env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
  });
  t.after(async () => {
    await stopTestServer(child, { token });
    await rm(dataRoot, { recursive: true, force: true });
  });
  const origin = new URL(await waitForUrl(child)).origin;

  let resumeStream = () => {};
  let markStreamReady;
  let rejectStreamReady;
  let targetSequence = total;
  const streamReady = new Promise((resolveReady, rejectReady) => {
    markStreamReady = resolveReady;
    rejectStreamReady = rejectReady;
  });
  const idsPromise = new Promise((resolveIds, rejectIds) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? rejectIds(error) : resolveIds(value);
    };
    const timeout = setTimeout(() => finish(new Error("timed out waiting for backpressured SSE replay")), 60_000);
    const request = httpRequest(`${origin}/api/events?after=1`, {
      headers: { authorization: `Bearer ${token}` },
    }, (response) => {
      if (response.statusCode !== 200) {
        const error = new Error(`unexpected SSE status ${response.statusCode}`);
        rejectStreamReady(error);
        return finish(error);
      }
      const seen = [];
      let carry = "";
      response.pause();
      resumeStream = () => response.resume();
      markStreamReady();
      response.on("data", (chunk) => {
        const lines = (carry + chunk.toString("utf8")).split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) {
          const match = /^id: (\d+)$/.exec(line.trim());
          if (match) seen.push(Number(match[1]));
        }
        if (seen.at(-1) === targetSequence) {
          response.destroy();
          request.destroy();
          finish(null, seen);
        }
      });
      response.once("error", (error) => finish(error));
      response.once("close", () => {
        if (seen.at(-1) !== targetSequence) finish(new Error(`SSE closed early at ${seen.at(-1) ?? "none"}`));
      });
    });
    request.once("error", (error) => {
      if (!settled) finish(error);
    });
    request.end();
  });
  await streamReady;
  // Emit live events while historical replay is backpressured. On Windows ReadStream can observe
  // these appends too, so the server must discard their queued duplicate copies as replay advances.
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const createdRuns = await Promise.all(Array.from({ length: 8 }, (_, index) => fetch(`${origin}/api/runs`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ prompt: `SSE live merge ${index}`, taskType: "planning", execute: false, permissionMode: "plan" }),
  })));
  assert.ok(createdRuns.every((response) => response.status === 202));
  const runs = await Promise.all(createdRuns.map((response) => response.json()));
  const runEvents = await Promise.all(runs.map(async (run) => {
    const response = await fetch(`${origin}/api/runs/${run.id}/events`, { headers: auth });
    assert.equal(response.status, 200);
    return (await response.json()).events;
  }));
  targetSequence = Math.max(total, ...runEvents.flat().map((event) => event.sequence));
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 300));
  resumeStream();
  const ids = await idsPromise;
  assert.equal(ids.length, targetSequence - 1);
  assert.equal(ids[0], 2);
  assert.equal(ids.at(-1), targetSequence);
  assert.ok(ids.every((id, index) => index === 0 || id === ids[index - 1] + 1), "replay order has no gap or duplicate");
});

test("custom teams survive a control-plane restart through the real assembly path", { timeout: 90_000 }, async (t) => {
  // 烛 R11 致命回归防线：knownProviders 在 TeamStore.init() 期间求值——任何装配时序错误
  // （如 TDZ）都会让重启后的自定义团队被静默拒载。必须踩 createControlCenter 真实装配路径。
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-teams-e2e-"));
  const token = "e2e-teams-token-0123456789";
  const env = { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" };
  const spawnServer = () => spawnTestServer({ env });
  let child = spawnServer();
  t.after(async () => {
    await stopTestServer(child, { token });
    await rm(dataRoot, { recursive: true, force: true });
  });
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const firstOrigin = new URL(await waitForUrl(child)).origin;
  const created = await fetch(`${firstOrigin}/api/teams`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "重启存续队", members: ["codex-technical"], skills: ["co-review"] }),
  });
  assert.equal(created.status, 201);
  const team = await created.json();

  assert.deepEqual(await stopTestServer(child, { token }), { graceful: true, fallback: false });
  child = spawnServer();
  const secondOrigin = new URL(await waitForUrl(child)).origin;
  const listed = await fetch(`${secondOrigin}/api/teams`, { headers: auth });
  assert.equal(listed.status, 200);
  const payload = await listed.json();
  assert.ok(
    payload.teams.some((item) => item.id === team.id
      && item.name === "重启存续队"
      && item.coordinator === "codex-technical"
      && item.members.length === 1
      && item.members[0] === "codex-technical"),
    "custom team must survive restart via the real assembly path",
  );
  assert.deepEqual(payload.rejectedOnLoad, [], "no records may be silently rejected on load");
});

test("release truth consumes a complete server-observed evidence set from the current runtime", { timeout: 45_000 }, async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-release-truth-http-"));
  const repoRoot = await createReleaseFixtureRepo(root);
  const dataRoot = resolve(root, "data");
  const token = "e2e-release-truth-token-0123456789";
  const child = spawnTestServer({ env: {
    CONTROL_CENTER_TOKEN: token,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_TEST_REPO_ROOT: repoRoot,
    CONTROL_CENTER_PORT: "0",
  } });
  t.after(async () => {
    await stopTestServer(child, { token });
    await rm(root, { recursive: true, force: true });
  });

  const origin = new URL(await waitForUrl(child)).origin;
  const owner = JSON.parse(await readFile(resolve(dataRoot, "control-center.lock"), "utf8"));
  const sourceCommit = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  const diffDigest = createHash("sha256").update("", "utf8").digest("hex");
  const checkedAt = "2026-08-18T22:30:00.000Z";
  const commands = Object.fromEntries(RELEASE_COMMAND_IDS.map((id) => [id, {
    status: "passed",
    exitCode: 0,
    durationMs: 10,
    sourceCommit,
    diffDigest,
    workspaceClean: true,
    checkedAt,
    provenance: "server-observed",
    evidenceTrust: "independent",
    runId: "current-runtime-cohort",
    runtimePid: owner.pid,
    runtimeGeneration: 1,
    runtimeStartedAt: owner.startedAt,
  }]));
  await writeFile(resolve(dataRoot, "release-command-evidence.json"), `${JSON.stringify({
    schema: RELEASE_COMMAND_EVIDENCE_SCHEMA,
    updatedAt: checkedAt,
    commands,
  })}\n`, "utf8");

  const response = await fetch(`${origin}/api/release-truth`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const truth = await response.json();
  assert.equal(truth.validationEvidence.status, "passed");
  assert.equal(truth.validationEvidence.matchesSource, true);
  assert.equal(truth.validationEvidence.matchesWorkspace, true);
  assert.equal(truth.validationEvidence.matchesRuntime, true);
  assert.equal(truth.validationEvidence.evidenceTrust, "independent");
  assert.equal(truth.consistency, "consistent");
  assert.equal(truth.activation.claimed, true);
});

// timeout 120s：瓶颈是 CLI 健康探测冷启动（bootstrap/preview/dry-run 各 25-30s+），
// 高系统负载下 60s 线稳定超时——实测三端点计时定位，非业务回归（2026-07-17）
test("loopback API enforces bearer auth and supports the operator workflow", { timeout: 120_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-http-"));
  const token = "e2e-control-token-0123456789";
  const child = spawnTestServer({
    env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
  });
  t.after(async () => {
    await stopTestServer(child, { token });
    await rm(dataRoot, { recursive: true, force: true });
  });

  const printedUrl = await waitForUrl(child);
  const url = new URL(printedUrl);
  const bootstrapNonce = new URLSearchParams(url.hash.slice(1)).get("bootstrap");
  assert.match(bootstrapNonce ?? "", /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(printedUrl.includes(token), false, "persistent bearer must not be printed in the startup URL");
  const origin = url.origin;
  const auth = { Authorization: `Bearer ${token}` };

  const unauthorizedShutdown = await fetch(`${origin}/api/test/shutdown`, { method: "POST" });
  assert.equal(unauthorizedShutdown.status, 401, "the test-only shutdown endpoint still requires bearer authorization");

  const exchange = await fetch(`${origin}/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: bootstrapNonce }),
  });
  assert.equal(exchange.status, 200);
  assert.equal((await exchange.json()).token, token);
  const replay = await fetch(`${origin}/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: bootstrapNonce }),
  });
  assert.equal(replay.status, 401, "bootstrap nonce must be single-use");

  const favicon = await fetch(`${origin}/favicon.ico`);
  assert.equal(favicon.status, 204);

  const unauthorized = await fetch(`${origin}/api/bootstrap?token=${encodeURIComponent(token)}`);
  assert.equal(unauthorized.status, 401);

  const bootstrapResponse = await fetch(`${origin}/api/bootstrap`, { headers: auth });
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  assert.ok(bootstrap.providers.some((profile) => profile.id === "claude-fable"));
  assert.ok(bootstrap.teamCatalog.some((profile) => profile.id === "codex-technical" && profile.coordinatorEligible === true));
  assert.ok(bootstrap.teamCatalog.some((profile) => profile.id === "grok-search" && profile.teamMemberEligible === true && profile.coordinatorEligible === false));
  assert.ok(bootstrap.teamCatalog.some((profile) => profile.id === "gemini-research" && profile.teamMemberEligible === false && profile.eligibilityReason === "profile-disabled"));
  assert.ok(bootstrap.sources.some((source) => source.id === "control.routing"));
  assert.ok(bootstrap.security.secrets.some((item) => item.id === "grok-search-env" && typeof item.configured === "boolean"));
  assert.ok(Array.isArray(bootstrap.approvals), "legacy bootstrap approvals array remains available");
  assert.ok(Array.isArray(bootstrap.approvalSnapshot?.approvals));
  assert.match(bootstrap.approvalSnapshot?.epoch ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(Number.isSafeInteger(bootstrap.approvalSnapshot?.revision), true);
  assert.equal(String(bootstrap.approvalSnapshot?.runtimeGeneration), String(bootstrap.runtime.generation));
  const approvalSnapshotResponse = await fetch(`${origin}/api/approvals`, { headers: auth });
  assert.equal(approvalSnapshotResponse.status, 200);
  const approvalSnapshot = await approvalSnapshotResponse.json();
  assert.match(approvalSnapshot.epoch ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(Number.isSafeInteger(approvalSnapshot.revision), true);
  assert.equal(String(approvalSnapshot.runtimeGeneration), String(bootstrap.runtime.generation));

  const reload = await fetch(`${origin}/api/runtime/reload`, { method: "POST", headers: auth });
  assert.equal(reload.status, 200);
  const reloaded = await reload.json();
  assert.equal(reloaded.status, "reloaded");
  assert.equal(reloaded.generation, 2);

  const runnerSnapshot = await fetch(`${origin}/api/release-record/runner`, { headers: auth });
  assert.equal(runnerSnapshot.status, 200);
  assert.equal((await runnerSnapshot.json()).commands.length, 4);
  for (const commandIds of [[], ["validate", "validate"], ["deployProd"]]) {
    const rejectedRunner = await fetch(`${origin}/api/release-record/runner/run`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ commandIds }),
    });
    assert.equal(rejectedRunner.status, 400);
    assert.match((await rejectedRunner.json()).code, /^RELEASE_RUNNER_/);
  }

  const configResponse = await fetch(`${origin}/api/config/core.readme`, { headers: auth });
  const config = await configResponse.json();
  assert.equal(config.sha256.length, 64);
  const validate = await fetch(`${origin}/api/config/core.readme/validate`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ content: config.content }),
  });
  assert.equal(validate.status, 200);
  assert.equal((await validate.json()).valid, true);
  const plan = await fetch(`${origin}/api/config/core.readme/plan`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ content: config.content, baseSha256: config.sha256 }),
  });
  const planned = await plan.json();
  assert.equal(plan.status, 200);
  assert.ok(planned.planId);

  const schemaValidation = await fetch(`${origin}/api/config/control.routing/validate`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ content: '{"version":1}' }),
  });
  assert.equal(schemaValidation.status, 200);
  const schemaResult = await schemaValidation.json();
  assert.equal(schemaResult.valid, false);
  assert.equal(schemaResult.parser, "python-jsonschema");

  const route = await fetch(`${origin}/api/router/preview`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "实现并验证控制面", taskType: "coding", risk: "high" }),
  });
  const routed = await route.json();
  assert.equal(route.status, 200);
  assert.equal(routed.selected.id, "codex-technical");
  assert.equal(routed.independentRequired, true);
  assert.notEqual(routed.independent.id, routed.selected.id);
  const selectedProfile = bootstrap.providers.find((profile) => profile.id === routed.selected.id);
  const independentProfile = bootstrap.providers.find((profile) => profile.id === routed.independent.id);
  assert.ok(selectedProfile, `missing selected profile ${routed.selected.id}`);
  assert.ok(independentProfile, `missing independent profile ${routed.independent.id}`);
  assert.notEqual(independentProfile.provider, selectedProfile.provider, "independent route must use a different runtime provider");

  const dryRun = await fetch(`${origin}/api/runs`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "规划一个只读核验", taskType: "planning", execute: false, permissionMode: "plan" }),
  });
  assert.equal(dryRun.status, 202);
  assert.equal((await dryRun.json()).status, "succeeded");

  const controller = new AbortController();
  const events = await fetch(`${origin}/api/events?after=0`, { headers: auth, signal: controller.signal });
  assert.equal(events.status, 200);
  assert.match(events.headers.get("content-type"), /text\/event-stream/);
  const first = await events.body.getReader().read();
  assert.match(new TextDecoder().decode(first.value), /event: ready/);
  controller.abort();
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
  const afterDisconnect = await fetch(`${origin}/api/health`, { headers: auth });
  assert.equal(afterDisconnect.status, 200);
});
