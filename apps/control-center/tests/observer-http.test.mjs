import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../scripts/qa-ui-fixture.mjs";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

test("observers can read masked providers but cannot reveal credentials or write", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "514cc-observer-http-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  await writeConfig(repo);
  await mkdir(home);
  const operator = "test-operator-0123456789abcdef";
  const observer = "test-observer-0123456789abcdef";
  const secret = "test-only-provider-value-0123456789";
  const child = spawnTestServer({ env: {
    CONTROL_CENTER_TEST_REPO_ROOT: repo, CONTROL_CENTER_DATA_DIR: join(root, "data"),
    CONTROL_CENTER_RUNTIME_HOME: home, HOME: home, USERPROFILE: home,
    CONTROL_CENTER_PORT: "0", CONTROL_CENTER_TOKEN: operator, CONTROL_CENTER_OBSERVER_TOKEN: observer,
  } });
  t.after(async () => {
    await stopTestServer(child, { token: operator });
    await rm(root, { recursive: true, force: true });
  });
  const origin = new URL(await waitForUrl(child)).origin;
  const request = (path, token = operator, method = "GET", body) => fetch(origin + path, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const created = await request("/api/providers", operator, "POST", {
    name: "Isolated observer boundary", baseUrl: "https://example.invalid", apiKey: secret,
    apps: { claude: true, codex: true, gemini: false },
  });
  assert.equal(created.status, 201);
  const provider = await created.json();
  assert.ok(provider.id);
  const config = await request("/api/providers/common-config", operator, "PUT", {
    app: "claude", commonConfig: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: secret } }),
  });
  assert.equal(config.status, 200);
  for (const path of ["/api/providers/export", "/api/providers/common-config", `/api/providers/${provider.id}`]) {
    const masked = await request(path, observer);
    assert.equal(masked.status, 200);
    assert.equal((await masked.text()).includes(secret), false);
    for (const query of ["?includeSecrets=1", "?includeSecrets=0&includeSecrets=1", "?include%53ecrets=1"]) {
      const denied = await request(path + query, observer);
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error.code, "OBSERVER_SECRET_ACCESS_DENIED");
    }
    const revealed = await request(path + "?includeSecrets=1");
    assert.equal(revealed.status, 200);
    assert.equal((await revealed.text()).includes(secret), true);
  }
  const head = await request("/api/providers/export?includeSecrets=1", observer, "HEAD");
  assert.equal(head.status, 403);
  const deniedWrite = await request("/api/providers", observer, "POST", {});
  assert.equal(deniedWrite.status, 403);
  assert.equal((await deniedWrite.json()).error.code, "OBSERVER_READ_ONLY");
  assert.equal((await request("/api/providers/export?includeSecrets=1", "invalid-token")).status, 401);
});
