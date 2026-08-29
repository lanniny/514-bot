import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalBroker } from "../src/approval-broker.mjs";
import { acquireInstanceLock, lockOwnerIsActive } from "../src/instance-lock.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const eventStore = { emit: async () => {} };

test("permission denial matches the generated app-server response shape", async () => {
  const broker = new ApprovalBroker({ eventStore, ttlMs: 5_000 });
  assert.equal(broker.snapshot().revision, 0);
  assert.match(broker.snapshot().epoch, /^[0-9a-f-]{36}$/);
  const responsePromise = broker.request({ method: "item/permissions/requestApproval", params: { permissions: {} } });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  const [pending] = broker.list();
  assert.ok(pending);
  assert.equal(broker.snapshot().revision, 1);
  assert.equal(broker.snapshot().approvals.length, 1);
  await broker.resolve(pending.id, { decision: "deny", actionSha256: pending.actionSha256 });
  assert.equal(broker.snapshot().revision, 2);
  assert.equal(broker.snapshot().approvals.length, 0);
  const response = await responsePromise;
  assert.deepEqual(response, { permissions: {}, scope: "turn" });
  const schemaPath = resolve(appRoot, "..", "..", ".workflow/ultracode/agent-control-plane-v1/references/codex-app-server-0.144.2/PermissionsRequestApprovalResponse.json");
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  assert.equal(schema.required.includes("permissions"), true);
  assert.equal(schema.definitions.GrantedPermissionProfile.type, "object");
  assert.equal(Array.isArray(response.permissions), false);
});

test("unsupported server methods never enter the approval queue", async () => {
  const broker = new ApprovalBroker({ eventStore, ttlMs: 5_000 });
  await assert.rejects(() => broker.request({ method: "item/tool/requestUserInput", params: {} }), { code: "UNSUPPORTED_APPROVAL" });
  assert.deepEqual(broker.list(), []);
});

test("an approval is not released until its decision is durably audited", async () => {
  let failResolutionAudit = true;
  const broker = new ApprovalBroker({
    eventStore: {
      async emit(type) {
        if (type === "approval.resolved" && failResolutionAudit) throw new Error("audit disk unavailable");
      },
    },
    ttlMs: 5_000,
  });
  let released = false;
  const responsePromise = broker
    .request({ method: "item/fileChange/requestApproval", params: { path: "src/a.mjs" } })
    .then((value) => { released = true; return value; });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  const [pending] = broker.list();
  await assert.rejects(
    () => broker.resolve(pending.id, { decision: "approve", actionSha256: pending.actionSha256 }),
    { code: "APPROVAL_AUDIT_FAILED" },
  );
  assert.equal(released, false);
  assert.equal(broker.list()[0].status, "pending");

  failResolutionAudit = false;
  await broker.resolve(pending.id, { decision: "approve", actionSha256: pending.actionSha256 });
  assert.deepEqual(await responsePromise, { decision: "accept" });
});

test("approval broker stays approval-only and returns the build approval identity", async () => {
  const events = [];
  const broker = new ApprovalBroker({
    eventStore: {
      async emit(type, data) {
        events.push({ type, data });
      },
    },
    ttlMs: 5_000,
  });
  const responsePromise = broker.request({ method: "item/fileChange/requestApproval", params: { path: "src/a.mjs" } });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  const [pending] = broker.list();
  const resolved = await broker.resolve(pending.id, { decision: "approve", actionSha256: pending.actionSha256 });
  assert.equal("lease" in resolved, false);
  assert.equal(events.some((item) => item.type.startsWith("capability.lease_")), false);
  assert.deepEqual(await responsePromise, { decision: "accept" });

  const buildResponsePromise = broker.request({
    method: "control/runBuild/requestApproval",
    params: { runId: "run-1", workspace: "C:/repo" },
  }, { runId: "run-1" });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  const buildApproval = broker.list()[0];
  const buildResolved = await broker.resolve(buildApproval.id, {
    decision: "approve",
    actionSha256: buildApproval.actionSha256,
  });
  assert.equal(buildResolved.id, buildApproval.id);
  assert.deepEqual(await buildResponsePromise, { decision: "accept", approvalId: buildApproval.id });
});

test("instance lock is exclusive for a repository control root", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await acquireInstanceLock(root, { repoRoot: "C:/repo" });
  await assert.rejects(() => acquireInstanceLock(root, { repoRoot: "C:/repo" }), { code: "INSTANCE_ACTIVE" });
  await first.release();
  const second = await acquireInstanceLock(root, { repoRoot: "C:/repo" });
  await second.release();
});

test("instance lock rejects PID reuse instead of trusting liveness alone", async () => {
  const owner = {
    pid: process.pid,
    image: "node.exe",
    startedAt: "2026-07-23T00:00:00.000Z",
  };

  assert.equal(await lockOwnerIsActive(owner, {
    platform: "win32",
    identityProbe: async () => ({
      image: "node.exe",
      createdAt: "2026-07-23T00:00:03.000Z",
    }),
  }), false);
  assert.equal(await lockOwnerIsActive(owner, {
    platform: "win32",
    identityProbe: async () => ({
      image: "node.exe",
      createdAt: "2026-07-22T23:59:59.000Z",
    }),
  }), true);
  assert.equal(await lockOwnerIsActive(owner, {
    platform: "win32",
    identityProbe: async () => undefined,
  }), true);
});

test("instance lock replaces a stale owner selected by the ownership probe", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-lock-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, "control-center.lock"), `${JSON.stringify({
    pid: process.pid,
    image: "node.exe",
    startedAt: "2026-07-23T00:00:00.000Z",
  })}\n`, "utf8");

  const lock = await acquireInstanceLock(root, { repoRoot: "C:/repo" }, {
    ownerIsActive: async () => false,
  });
  assert.equal(lock.owner.pid, process.pid);
  await lock.release();
});
