import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";
import {
  cleanupClipboardImages,
  CLIPBOARD_CLEANUP_CONFIRMATION,
  detectClipboardImageType,
  MAX_CLIPBOARD_IMAGE_BYTES,
  saveClipboardImage,
} from "../src/clipboard-attachment.mjs";
import {
  claimPendingClipboardUpload,
  isManagedClipboardPath,
  PENDING_CLIPBOARD_UPLOAD_TTL_MS,
  withManagedClipboardSourceRegistration,
} from "../src/clipboard-lifecycle.mjs";

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function minimalJpeg(width = 1, height = 1) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0xff, 0xd9,
  ]);
}

function progressiveJpeg() {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc2, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12,
    0xff, 0xc4, 0x00, 0x02,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x34,
    0xff, 0xd9,
  ]);
}

function webpFile(chunks) {
  const chunkBytes = chunks.map(({ type, payload }) => Buffer.concat([
    Buffer.from(type, "ascii"),
    Buffer.from([payload.length & 0xff, (payload.length >> 8) & 0xff, (payload.length >> 16) & 0xff, (payload.length >> 24) & 0xff]),
    payload,
    payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]));
  const bytes = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii"), ...chunkBytes]);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  return bytes;
}

function vp8xPayload(width = 1, height = 1, flags = 0) {
  const payload = Buffer.alloc(10);
  payload[0] = flags;
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return payload;
}

function minimalWebp(width = 1, height = 1) {
  const payload = Buffer.from([0x2f, (width - 1) & 0xff, ((width - 1) >> 8) & 0x3f, 0x00, 0x00]);
  if (height !== 1) throw new Error("minimalWebp test fixture only supports height=1");
  return webpFile([{ type: "VP8L", payload }]);
}

function animatedWebpFrame() {
  const image = Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00]);
  const frameHeader = Buffer.alloc(16);
  return Buffer.concat([
    frameHeader,
    Buffer.from("VP8L", "ascii"), Buffer.from([5, 0, 0, 0]), image, Buffer.alloc(1),
  ]);
}

function minimalAnimatedWebp() {
  return webpFile([
    { type: "VP8X", payload: vp8xPayload(1, 1, 0x02) },
    { type: "ANIM", payload: Buffer.alloc(6) },
    { type: "ANMF", payload: animatedWebpFrame() },
  ]);
}

const images = {
  "image/png": Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X6bQyQAAAABJRU5ErkJggg==", "base64"),
  "image/jpeg": minimalJpeg(),
  "image/gif": Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
  "image/webp": minimalWebp(),
};

function dataUrl(mimeType, bytes) {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

test("clipboard image structure validation covers complete PNG/JPEG/GIF/WebP", () => {
  for (const [mimeType, bytes] of Object.entries(images)) {
    assert.equal(detectClipboardImageType(bytes), mimeType);
    assert.equal(detectClipboardImageType(bytes.subarray(0, bytes.length - 1)), null, `${mimeType} truncation was accepted`);
  }
  assert.equal(detectClipboardImageType(Buffer.from("<svg/>")), null);
  assert.equal(detectClipboardImageType(progressiveJpeg()), "image/jpeg");
  assert.equal(detectClipboardImageType(minimalAnimatedWebp()), "image/webp");
  assert.equal(detectClipboardImageType(webpFile([{ type: "VP8X", payload: vp8xPayload() }])), null, "VP8X-only shell was accepted");
  assert.equal(detectClipboardImageType(webpFile([
    { type: "ANIM", payload: Buffer.alloc(6) },
    { type: "ANMF", payload: animatedWebpFrame() },
  ])), null, "animation without VP8X was accepted");
  assert.equal(detectClipboardImageType(webpFile([
    { type: "VP8X", payload: vp8xPayload(1, 1, 0) },
    { type: "ANIM", payload: Buffer.alloc(6) },
    { type: "ANMF", payload: animatedWebpFrame() },
  ])), null, "animation without the VP8X animation flag was accepted");
  assert.equal(detectClipboardImageType(webpFile([
    { type: "VP8X", payload: vp8xPayload(1, 1, 0x02) },
    { type: "ANMF", payload: animatedWebpFrame() },
    { type: "ANIM", payload: Buffer.alloc(6) },
  ])), null, "ANMF before ANIM was accepted");
  assert.equal(detectClipboardImageType(webpFile([
    { type: "VP8L", payload: Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00]) },
    { type: "ANIM", payload: Buffer.alloc(6) },
  ])), null, "static image with an orphan ANIM chunk was accepted");
  assert.equal(detectClipboardImageType(minimalJpeg(0, 1)), null);
  assert.equal(detectClipboardImageType(webpFile([{ type: "VP8X", payload: vp8xPayload(32_769, 1) }])), null);
});

test("clipboard image structure validation tolerates trailing padding and strips them upon saving", async (t) => {
  for (const [mimeType, bytes] of Object.entries(images)) {
    const trailingBytes = Buffer.concat([bytes, Buffer.from([0x00, 0x00, 0x00, 0x00])]);
    assert.equal(detectClipboardImageType(trailingBytes), mimeType, `${mimeType} with trailing bytes should be detected`);
  }

  const root = await mkdtemp(join(tmpdir(), "514cc-clipboard-trailing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pngBytes = images["image/png"];
  const pngWithTrailing = Buffer.concat([pngBytes, Buffer.from("EXTRA_PADDING_1234")]);
  const saved = await saveClipboardImage({
    dataUrl: dataUrl("image/png", pngWithTrailing),
    dataRoot: root,
    now: () => new Date("2026-08-14T12:00:00.000Z"),
    id: () => "trailing-id",
  });
  assert.equal(saved.size, pngBytes.length);
  assert.deepEqual(await readFile(saved.path), pngBytes);
});

test("clipboard image is atomically persisted under the control-center data root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "514cc-clipboard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = images["image/png"];
  const saved = await saveClipboardImage({
    dataUrl: dataUrl("image/png", bytes),
    dataRoot: root,
    now: () => new Date("2026-08-14T12:00:00.000Z"),
    id: () => "fixed-id",
  });
  assert.equal(saved.mimeType, "image/png");
  assert.equal(saved.size, bytes.length);
  assert.match(saved.name, /^clipboard-2026-08-14T12-00-00-000Z-fixed-id\.png$/);
  assert.deepEqual(await readFile(saved.path), bytes);
  assert.deepEqual((await readdir(join(root, "uploads", "clipboard"))).filter((name) => name.endsWith(".tmp")), []);
});

test("clipboard image rejects MIME mismatch, unsupported types, invalid base64, truncation and oversize data", async () => {
  await assert.rejects(
    () => saveClipboardImage({ dataUrl: dataUrl("image/jpeg", images["image/png"]), dataRoot: "unused" }),
    { code: "IMAGE_TYPE_MISMATCH" },
  );
  await assert.rejects(
    () => saveClipboardImage({ dataUrl: "data:image/svg+xml;base64,PHN2Zy8+", dataRoot: "unused" }),
    { code: "UNSUPPORTED_IMAGE_TYPE" },
  );
  await assert.rejects(
    () => saveClipboardImage({ dataUrl: "data:image/png;base64,AAAA===", dataRoot: "unused" }),
    { code: "INVALID_IMAGE_DATA" },
  );
  await assert.rejects(
    () => saveClipboardImage({ dataUrl: dataUrl("image/png", images["image/png"].subarray(0, 20)), dataRoot: "unused" }),
    { code: "INVALID_IMAGE_DATA" },
  );
  const oversize = Buffer.concat([images["image/png"], Buffer.alloc(MAX_CLIPBOARD_IMAGE_BYTES)]);
  await assert.rejects(
    () => saveClipboardImage({ dataUrl: dataUrl("image/png", oversize), dataRoot: "unused" }),
    { code: "IMAGE_TOO_LARGE" },
  );
});

function mockStorage({ writeError = null, openError = null, usage = [] } = {}) {
  const calls = [];
  const handle = {
    writeFile: async (bytes) => {
      calls.push(["write", bytes.length]);
      if (writeError) throw writeError;
    },
    close: async () => calls.push(["close"]),
  };
  return {
    calls,
    storage: {
      mkdir: async () => {},
      readdir: async () => usage.map((item) => ({ name: item.name, isFile: () => true })),
      stat: async (path) => ({ size: usage.find((item) => path.endsWith(item.name))?.size ?? 0 }),
      open: async (path) => {
        calls.push(["open", path]);
        if (openError) throw openError;
        return handle;
      },
      rename: async (from, to) => calls.push(["rename", from, to]),
      rm: async (path) => calls.push(["rm", path]),
    },
  };
}

test("clipboard image removes its owned temporary file when write or rename fails", async () => {
  for (const stage of ["write", "rename"]) {
    const failure = Object.assign(new Error(`${stage} failed`), { code: "EIO" });
    const fixture = mockStorage({ writeError: stage === "write" ? failure : null });
    if (stage === "rename") fixture.storage.rename = async (from, to) => {
      fixture.calls.push(["rename", from, to]);
      throw failure;
    };
    await assert.rejects(
      () => saveClipboardImage({
        dataUrl: dataUrl("image/png", images["image/png"]),
        dataRoot: "C:/bounded-data-root",
        id: () => `${stage}-cleanup-id`,
        storage: fixture.storage,
      }),
      failure,
    );
    assert.ok(fixture.calls.some(([kind]) => kind === "rm"), `${stage} failure did not clean its temporary file`);
    assert.equal(fixture.calls.find(([kind]) => kind === "open")[1], fixture.calls.find(([kind]) => kind === "rm")[1]);
  }
});

test("clipboard image never deletes a temporary path when exclusive open fails", async () => {
  const failure = Object.assign(new Error("already exists"), { code: "EEXIST" });
  const fixture = mockStorage({ openError: failure });
  await assert.rejects(
    () => saveClipboardImage({
      dataUrl: dataUrl("image/png", images["image/png"]),
      dataRoot: "C:/bounded-data-root",
      id: () => "collision-id",
      storage: fixture.storage,
    }),
    failure,
  );
  assert.equal(fixture.calls.some(([kind]) => kind === "rm"), false);
});

test("clipboard image storage quota rejects before creating a temporary file", async () => {
  const fixture = mockStorage({ usage: [{ name: "existing.png", size: 10 }] });
  await assert.rejects(
    () => saveClipboardImage({
      dataUrl: dataUrl("image/png", images["image/png"]),
      dataRoot: "C:/bounded-data-root",
      storage: fixture.storage,
      limits: { files: 1, bytes: 1000 },
    }),
    { code: "CLIPBOARD_STORAGE_QUOTA_EXCEEDED" },
  );
  assert.equal(fixture.calls.some(([kind]) => kind === "open"), false);
});

test("clipboard cleanup requires confirmation and removes fresh or stale unreferenced managed files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "514cc-clipboard-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uploadRoot = join(root, "uploads", "clipboard");
  const protectedPath = join(uploadRoot, "clipboard-2026-08-14T09-00-00-000Z-protected.png");
  const stalePath = join(uploadRoot, "clipboard-2026-08-14T09-00-00-000Z-stale.png");
  const staleTemporaryPath = join(uploadRoot, ".clipboard-stale.123.tmp");
  const freshPath = join(uploadRoot, "clipboard-2026-08-14T11-30-00-000Z-fresh.png");
  const unknownPath = join(uploadRoot, "operator-note.txt");
  const fixedNow = new Date("2026-08-14T12:00:00.000Z");
  const old = new Date("2026-08-14T09:00:00.000Z");
  await mkdir(uploadRoot, { recursive: true });
  await Promise.all([
    writeFile(protectedPath, "protected"),
    writeFile(stalePath, "stale"),
    writeFile(staleTemporaryPath, "temporary"),
    writeFile(freshPath, "fresh"),
    writeFile(unknownPath, "unknown"),
  ]);
  await Promise.all([
    utimes(protectedPath, old, old),
    utimes(stalePath, old, old),
    utimes(staleTemporaryPath, old, old),
    utimes(freshPath, fixedNow, fixedNow),
    utimes(unknownPath, old, old),
  ]);

  await assert.rejects(
    () => cleanupClipboardImages({ dataRoot: root }),
    { code: "CONFIRMATION_REQUIRED" },
  );
  const result = await cleanupClipboardImages({
    dataRoot: root,
    confirmation: CLIPBOARD_CLEANUP_CONFIRMATION,
    protectedPaths: [protectedPath],
    now: () => fixedNow,
  });

  assert.equal(result.deletedFiles, 3);
  assert.equal(result.freedBytes, Buffer.byteLength("stale") + Buffer.byteLength("temporary") + Buffer.byteLength("fresh"));
  await assert.rejects(() => readFile(stalePath), { code: "ENOENT" });
  await assert.rejects(() => readFile(staleTemporaryPath), { code: "ENOENT" });
  await assert.rejects(() => readFile(freshPath), { code: "ENOENT" });
  assert.equal(await readFile(protectedPath, "utf8"), "protected");
  assert.equal(await readFile(unknownPath, "utf8"), "unknown");
});

test("new clipboard uploads stay leased until claim and expire without a permanent quota block", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "514cc-clipboard-pending-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saved = await saveClipboardImage({
    dataUrl: dataUrl("image/png", images["image/png"]),
    dataRoot: root,
    id: () => "pending-upload-id",
    claimId: () => "pending-claim-token-123456",
    claimNow: () => 1_000,
  });
  const protectedResult = await cleanupClipboardImages({
    dataRoot: root,
    confirmation: CLIPBOARD_CLEANUP_CONFIRMATION,
    now: () => 1_001,
  });
  assert.equal(protectedResult.deletedFiles, 0);
  assert.deepEqual(await readFile(saved.path), images["image/png"]);
  await assert.rejects(
    () => claimPendingClipboardUpload({
      dataRoot: root,
      path: saved.path,
      claimToken: "wrong-claim-token-123456",
      now: () => 1_001,
    }),
    { code: "CLIPBOARD_CLAIM_INVALID" },
  );
  await claimPendingClipboardUpload({
    dataRoot: root,
    path: saved.path,
    claimToken: saved.claimToken,
    now: () => 1_001,
  });
  const claimedResult = await cleanupClipboardImages({
    dataRoot: root,
    confirmation: CLIPBOARD_CLEANUP_CONFIRMATION,
    now: () => 1_002,
  });
  assert.equal(claimedResult.deletedFiles, 1);
  await assert.rejects(() => readFile(saved.path), { code: "ENOENT" });

  const expired = await saveClipboardImage({
    dataUrl: dataUrl("image/png", images["image/png"]),
    dataRoot: root,
    id: () => "expired-upload-id",
    claimId: () => "expired-claim-token-123456",
    claimNow: () => 2_000,
  });
  const expiredResult = await cleanupClipboardImages({
    dataRoot: root,
    confirmation: CLIPBOARD_CLEANUP_CONFIRMATION,
    now: () => 2_000 + PENDING_CLIPBOARD_UPLOAD_TTL_MS + 1,
  });
  assert.equal(expiredResult.deletedFiles, 1);
  await assert.rejects(() => readFile(expired.path), { code: "ENOENT" });
});

test("clipboard cleanup and managed source registration serialize both race orders", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "514cc-clipboard-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uploadRoot = join(root, "uploads", "clipboard");
  const protectedPath = join(uploadRoot, "clipboard-registration-first.png");
  const sweptPath = join(uploadRoot, "clipboard-sweep-first.png");
  const caseVariantSweptPath = process.platform === "win32"
    ? `${sweptPath[0] === sweptPath[0].toLowerCase() ? sweptPath[0].toUpperCase() : sweptPath[0].toLowerCase()}${sweptPath.slice(1)}`
    : sweptPath;
  assert.equal(isManagedClipboardPath(root, caseVariantSweptPath), true, "Windows-equivalent path escaped managed classification");
  await mkdir(uploadRoot, { recursive: true });
  await Promise.all([writeFile(protectedPath, "protected"), writeFile(sweptPath, "swept")]);

  const registrationEntered = deferred();
  const releaseRegistration = deferred();
  const registered = [];
  const registration = withManagedClipboardSourceRegistration({
    dataRoot: root,
    sources: [protectedPath],
    operation: async () => {
      registered.push(protectedPath);
      registrationEntered.resolve();
      await releaseRegistration.promise;
    },
  });
  await registrationEntered.promise;
  const cleanupAfterRegistration = cleanupClipboardImages({
    dataRoot: root,
    confirmation: CLIPBOARD_CLEANUP_CONFIRMATION,
    protectedPaths: () => registered,
  });
  releaseRegistration.resolve();
  await registration;
  const firstResult = await cleanupAfterRegistration;
  assert.equal(firstResult.deletedFiles, 1);
  assert.equal(await readFile(protectedPath, "utf8"), "protected");
  await assert.rejects(() => readFile(sweptPath), { code: "ENOENT" });

  await writeFile(sweptPath, "swept-again");
  const cleanupEntered = deferred();
  const releaseCleanup = deferred();
  let lateRegistrationRan = false;
  const cleanupFirst = cleanupClipboardImages({
    dataRoot: root,
    confirmation: CLIPBOARD_CLEANUP_CONFIRMATION,
    protectedPaths: async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
      return [protectedPath];
    },
  });
  await cleanupEntered.promise;
  const lateRegistration = withManagedClipboardSourceRegistration({
    dataRoot: root,
    sources: [caseVariantSweptPath],
    operation: async () => { lateRegistrationRan = true; },
  });
  releaseCleanup.resolve();
  const secondResult = await cleanupFirst;
  assert.equal(secondResult.deletedFiles, 1);
  await assert.rejects(() => lateRegistration, { code: "SOURCE_NOT_FOUND" });
  assert.equal(lateRegistrationRan, false);
});

test("real HTTP endpoint saves a validated clipboard image and rejects MIME spoofing", { timeout: 45_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "514cc-clipboard-http-"));
  const token = "clipboard-http-token";
  const uploadRoot = join(root, "uploads", "clipboard");
  const protectedPath = join(uploadRoot, "clipboard-2026-08-14T09-00-00-000Z-run-source.png");
  const stalePath = join(uploadRoot, "clipboard-2026-08-14T09-00-00-000Z-unreferenced.png");
  const old = new Date(Date.now() - (2 * 60 * 60 * 1000));
  const runId = "clipboard-cleanup-protected-run";
  await Promise.all([
    mkdir(uploadRoot, { recursive: true }),
    mkdir(join(root, "runs"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(protectedPath, images["image/png"]),
    writeFile(stalePath, images["image/png"]),
  ]);
  await Promise.all([utimes(protectedPath, old, old), utimes(stalePath, old, old)]);
  await writeFile(join(root, "runs", `${runId}.json`), `${JSON.stringify({
    id: runId,
    prompt: "protect clipboard source during cleanup",
    status: "succeeded",
    taskType: "coding",
    orchestrationMode: "social",
    permissionMode: "plan",
    coordinatorId: "claude-fable",
    startAgentId: "claude-fable",
    executionOwnerId: "claude-fable",
    teamId: "team-514cc",
    teamMembers: ["claude-fable"],
    requestedAgentIds: [],
    cwd: root,
    sources: [{ kind: "file", path: protectedPath, name: "run-source.png" }],
    turns: [],
    turnAttempts: [],
    inflightTurns: {},
    round: 1,
    maxRounds: 6,
    createdAt: old.toISOString(),
    updatedAt: old.toISOString(),
    result: "done",
    error: null,
  }, null, 2)}\n`, "utf8");
  const child = spawnTestServer({ env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: root } });
  t.after(async () => {
    await stopTestServer(child, { token }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const origin = new URL(await waitForUrl(child)).origin;
  const post = (payload) => fetch(`${origin}/api/system/clipboard-image`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const created = await post({ dataUrl: dataUrl("image/png", images["image/png"]) });
  assert.equal(created.status, 201);
  const saved = await created.json();
  assert.ok(saved.path.startsWith(join(root, "uploads", "clipboard")), "attachment escaped the configured data root");
  assert.deepEqual(await readFile(saved.path), images["image/png"]);

  const claimed = await fetch(`${origin}/api/system/clipboard-image/claim`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ path: saved.path, claimToken: saved.claimToken }),
  });
  assert.equal(claimed.status, 200);
  assert.deepEqual(await claimed.json(), { claimed: true, path: saved.path });

  const addSource = (path) => fetch(`${origin}/api/runs/${runId}/sources`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sources: [path] }),
  });
  const registered = await addSource(saved.path);
  assert.equal(registered.status, 200);
  assert.ok((await registered.json()).sources.some((source) => source.name === saved.name));
  const missingSource = await addSource(join(uploadRoot, "clipboard-already-swept.png"));
  assert.equal(missingSource.status, 404);
  assert.equal((await missingSource.json()).error.code, "SOURCE_NOT_FOUND");

  const spoofed = await post({ dataUrl: dataUrl("image/jpeg", images["image/png"]) });
  assert.equal(spoofed.status, 422);
  assert.equal((await spoofed.json()).error.code, "IMAGE_TYPE_MISMATCH");

  const cleanup = (payload) => fetch(`${origin}/api/system/clipboard-images/cleanup`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const refused = await cleanup({});
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.code, "CONFIRMATION_REQUIRED");

  const cleaned = await cleanup({ confirmation: CLIPBOARD_CLEANUP_CONFIRMATION });
  assert.equal(cleaned.status, 200);
  assert.equal((await cleaned.json()).deletedFiles, 1);
  assert.deepEqual(await readFile(protectedPath), images["image/png"], "persisted run source was deleted");
  assert.deepEqual(await readFile(saved.path), images["image/png"], "newly registered run source was deleted");
  await assert.rejects(() => readFile(stalePath), { code: "ENOENT" });
});
