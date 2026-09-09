import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRepo = resolve(appRoot, "../..");

// An unavailable research harness must expose the reason in HTTP and the ledger.
async function createIsolatedRepo(root) {
  const repoRoot = resolve(root, "repo");
  const configRoot = resolve(repoRoot, "config/control-center");
  const schemaRoot = resolve(repoRoot, "schemas/control-center");
  await Promise.all([mkdir(configRoot, { recursive: true }), mkdir(schemaRoot, { recursive: true })]);
  for (const name of [
    "models.json",
    "routing.json",
    "permissions.json",
    "claude-coordinator.md",
    "claude-headless-settings.json",
  ]) {
    await copyFile(resolve(sourceRepo, "config/control-center", name), resolve(configRoot, name));
  }
  await copyFile(
    resolve(sourceRepo, "schemas/control-center/contracts.schema.json"),
    resolve(schemaRoot, "contracts.schema.json"),
  );

  const modelsPath = resolve(configRoot, "models.json");
  const models = JSON.parse(await readFile(modelsPath, "utf8"));
  for (const profile of models.profiles) {
    // 健康探针只执行 `<command> --version`；统一用当前 Node，避免测试依赖宿主机安装任一付费 CLI。
    if (profile.command) profile.command = process.execPath;
    if (profile.id === "codex-technical") profile.command = resolve(root, "unavailable-codex.exe");
  }
  await Promise.all([
    writeFile(modelsPath, `${JSON.stringify(models, null, 2)}\n`, "utf8"),
    writeFile(resolve(configRoot, "sources.json"), `${JSON.stringify({
      version: 1,
      explicit: [],
      discover: [],
      runtime: [],
    }, null, 2)}\n`, "utf8"),
  ]);
  return repoRoot;
}

test("NO_ROUTE carries per-seat blockers in message, response and events ledger", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-no-route-ledger-"));
  const repoRoot = await createIsolatedRepo(root);
  const dataRoot = resolve(root, "data");
  const token = "no-route-ledger-http-token";

  const child = spawnTestServer({ env: {
    CONTROL_CENTER_TOKEN: token,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_TEST_REPO_ROOT: repoRoot,
    CONTROL_CENTER_PORT: "0",
  } });
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) await stopTestServer(child, { token });
    await rm(root, { recursive: true, force: true });
  });
  const origin = new URL(await waitForUrl(child)).origin;

  const response = await fetch(`${origin}/api/router/preview`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "查当前资料", taskType: "current-research", teamId: "team-514cc" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 422);
  assert.equal(payload.error.code, "NO_ROUTE");
  assert.match(payload.error.message, /^no healthy provider can satisfy current-research/);
  assert.match(payload.error.message, /codex-technical:/);

  const responseCandidate = payload.error.candidates?.find((candidate) => candidate.id === "codex-technical");
  assert.ok(responseCandidate, "HTTP 响应必须带 candidates 明细");
  assert.equal(responseCandidate.excluded, true);
  assert.ok(
    responseCandidate.excludedReasons.some((reason) => /unavailable-codex|not found|ENOENT|installed/i.test(reason)),
    "missing research harness must be visible in the exclusion reason",
  );

  const ledger = await readFile(resolve(dataRoot, "events.jsonl"), "utf8");
  const errors = ledger.split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "server.error");
  assert.ok(errors.length >= 1, "server.error 必须进账本");
  const ledgerCandidate = errors[errors.length - 1].data.candidates?.find((candidate) => candidate.id === "codex-technical");
  assert.ok(ledgerCandidate, "账本 server.error 必须落盘 candidates 排除明细");
  assert.equal(ledgerCandidate.excluded, true);
  assert.ok(
    ledgerCandidate.reasons.some((reason) => /unavailable-codex|not found|ENOENT|installed/i.test(reason)),
  );
});
