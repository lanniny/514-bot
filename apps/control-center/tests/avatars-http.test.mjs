import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

function minimalJpeg() {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0xff, 0xd9,
  ]);
}

async function jsonRequest(origin, path, token, { method = "GET", body = undefined } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { response, payload };
}

test("operator and member avatars require auth and survive a process restart", { timeout: 90_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-avatars-http-"));
  const token = "e2e-avatars-token-0123456789";
  const env = {
    CONTROL_CENTER_TOKEN: token,
    CONTROL_CENTER_DATA_DIR: dataRoot,
    CONTROL_CENTER_PORT: "0",
  };
  let child = spawnTestServer({ env });
  t.after(async () => {
    if (child && child.exitCode == null && child.signalCode == null) {
      await stopTestServer(child, { token });
    }
    await rm(dataRoot, { recursive: true, force: true });
  });

  const origin = new URL(await waitForUrl(child)).origin;
  const dataUrl = `data:image/jpeg;base64,${minimalJpeg().toString("base64")}`;

  const denied = await fetch(`${origin}/api/avatars/operator`);
  assert.equal(denied.status, 401);

  const uploaded = await jsonRequest(origin, "/api/avatars/operator", token, {
    method: "POST",
    body: { dataUrl },
  });
  assert.equal(uploaded.response.status, 200);
  assert.equal(uploaded.payload.avatar, "custom");

  const renamed = await jsonRequest(origin, "/api/operator-profile", token, {
    method: "PUT",
    body: { label: "LO 的工作台", hiddenMemberIds: ["grok-search"] },
  });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.payload.label, "LO 的工作台");
  assert.equal(renamed.payload.avatar, "custom");
  assert.deepEqual(renamed.payload.hiddenMemberIds, ["grok-search"]);

  const member = await jsonRequest(origin, "/api/avatars/members/codex-technical", token, {
    method: "POST",
    body: { dataUrl },
  });
  assert.equal(member.response.status, 200);
  assert.equal(member.payload.avatar, "custom");

  const image = await fetch(`${origin}/api/avatars/members/codex-technical`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.ok(Buffer.from(await image.arrayBuffer()).equals(minimalJpeg()));

  const bootstrap = await jsonRequest(origin, "/api/bootstrap", token);
  assert.equal(bootstrap.payload.operatorProfile.avatar, "custom");
  assert.deepEqual(bootstrap.payload.operatorProfile.hiddenMemberIds, ["grok-search"]);
  assert.equal(bootstrap.payload.memberCatalog.find((item) => item.id === "codex-technical").avatar, "custom");

  await stopTestServer(child, { token });
  child = spawnTestServer({ env });
  const nextOrigin = new URL(await waitForUrl(child)).origin;
  const persisted = await jsonRequest(nextOrigin, "/api/operator-profile", token);
  assert.equal(persisted.payload.avatar, "custom");
  assert.equal(persisted.payload.label, "LO 的工作台");
  assert.deepEqual(persisted.payload.hiddenMemberIds, ["grok-search"]);
  const persistedMember = await jsonRequest(nextOrigin, "/api/team-members/codex-technical", token);
  assert.equal(persistedMember.payload.avatar, "custom");
});
