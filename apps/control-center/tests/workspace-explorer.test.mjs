import test from "node:test";
import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open as fsOpen,
  opendir as fsOpendir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWorkspaceExplorer,
  inspectRunWorkspace,
  updateRunWorkspaceFile,
  WORKSPACE_EXPLORER_LIMITS,
  WORKSPACE_EXPLORER_SCHEMA,
} from "../src/workspace-explorer.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const LINK_UNAVAILABLE = new Set(["EACCES", "EINVAL", "ENOSYS", "ENOTSUP", "EPERM", "UNKNOWN"]);

function fsAdapter(overrides = {}) {
  return { lstat, open: fsOpen, opendir: fsOpendir, realpath, ...overrides };
}

function sameResolvedPath(left, right) {
  const normalize = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

async function createDirectoryLink(target, path) {
  try {
    await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (LINK_UNAVAILABLE.has(error.code)) return false;
    throw error;
  }
}

async function createFileLink(target, path) {
  try {
    await symlink(target, path, "file");
    return true;
  } catch (error) {
    if (LINK_UNAVAILABLE.has(error.code)) return false;
    throw error;
  }
}

test("workspace explorer lists, previews, redacts and bounds one run root", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-workspace-explorer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, "src"));
  await writeFile(resolve(root, "src", "app.js"), "const token = 'workspace-secret-value';\n", "utf8");
  await writeFile(resolve(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(resolve(root, "invalid-utf8.txt"), Buffer.from([0xc3, 0x28]));
  await writeFile(
    resolve(root, "large.txt"),
    "x".repeat(WORKSPACE_EXPLORER_LIMITS.previewBytes + 128),
    "utf8",
  );
  for (let index = 0; index < WORKSPACE_EXPLORER_LIMITS.entries + 4; index += 1) {
    await writeFile(resolve(root, `item-${String(index).padStart(3, "0")}.txt`), "ok", "utf8");
  }
  const run = { id: "run-workspace", cwd: root };

  const listing = await inspectRunWorkspace(run);
  assert.equal(listing.schema, WORKSPACE_EXPLORER_SCHEMA);
  assert.equal(listing.type, "directory");
  assert.equal(listing.path, "");
  assert.equal(listing.parent, null);
  assert.equal(listing.entries.length, WORKSPACE_EXPLORER_LIMITS.entries);
  assert.equal(listing.truncated, true);
  assert.equal(listing.entries[0].type, "directory");
  assert.equal(JSON.stringify(listing).includes(root), false, "absolute root must stay server-side");

  const preview = await inspectRunWorkspace(run, { path: "src/app.js" });
  assert.equal(preview.type, "file");
  assert.equal(preview.file.language, "javascript");
  assert.equal(preview.file.binary, false);
  assert.equal(preview.file.redacted, true);
  assert.match(preview.file.content, /\[REDACTED\]/);
  assert.equal(preview.file.content.includes("workspace-secret-value"), false);

  const binary = await inspectRunWorkspace(run, { path: "binary.bin" });
  assert.equal(binary.file.binary, true);
  assert.equal(binary.file.content, null);

  const invalidUtf8 = await inspectRunWorkspace(run, { path: "invalid-utf8.txt" });
  assert.equal(invalidUtf8.file.binary, true);
  assert.equal(invalidUtf8.file.content, null);

  const large = await inspectRunWorkspace(run, { path: "large.txt" });
  assert.equal(Buffer.byteLength(large.file.content), WORKSPACE_EXPLORER_LIMITS.previewBytes);
  assert.equal(large.file.truncated, true);
});

test("workspace editor atomically saves a full text preview and returns its new revision", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-workspace-editor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "notes.md");
  await writeFile(target, "before\n", "utf8");
  const run = { id: "run-editor", cwd: root };
  const opened = await inspectRunWorkspace(run, { path: "notes.md" });

  assert.equal(opened.file.editable, true);
  assert.match(opened.file.revision, /^[a-f0-9]{64}$/);
  const saved = await updateRunWorkspaceFile(run, {
    path: "notes.md",
    content: "after\n",
    expectedRevision: opened.file.revision,
  });

  assert.equal(await readFile(target, "utf8"), "after\n");
  assert.equal(saved.file.content, "after\n");
  assert.equal(saved.file.editable, true);
  assert.notEqual(saved.file.revision, opened.file.revision);
  assert.deepEqual(await readdir(root), ["notes.md"], "atomic temp file must not remain beside the saved file");
});

test("workspace editor rejects stale, redacted and oversized write bases without changing disk", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-workspace-editor-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "notes.txt");
  await writeFile(target, "base\n", "utf8");
  const run = { id: "run-editor-guard", cwd: root };
  const opened = await inspectRunWorkspace(run, { path: "notes.txt" });
  await writeFile(target, "external\n", "utf8");

  await assert.rejects(
    () => updateRunWorkspaceFile(run, {
      path: "notes.txt",
      content: "stale overwrite\n",
      expectedRevision: opened.file.revision,
    }),
    { code: "WORKSPACE_VERSION_CONFLICT" },
  );
  assert.equal(await readFile(target, "utf8"), "external\n");

  const current = await inspectRunWorkspace(run, { path: "notes.txt" });
  await assert.rejects(
    () => updateRunWorkspaceFile(run, {
      path: "notes.txt",
      content: "const token = 'workspace-secret-value';\n",
      expectedRevision: current.file.revision,
    }),
    { code: "PATH_BOUNDARY" },
  );
  assert.equal(await readFile(target, "utf8"), "external\n");

  const large = join(root, "large.txt");
  await writeFile(large, "x".repeat(WORKSPACE_EXPLORER_LIMITS.previewBytes + 1), "utf8");
  const largePreview = await inspectRunWorkspace(run, { path: "large.txt" });
  assert.equal(largePreview.file.editable, false);
  assert.equal(largePreview.file.revision, null);
});

test("workspace explorer rejects absolute paths, traversal and missing roots", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-workspace-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = { id: "run-boundary", cwd: root };

  await assert.rejects(() => inspectRunWorkspace(run, { path: "../outside.txt" }), { code: "PATH_BOUNDARY" });
  await assert.rejects(() => inspectRunWorkspace(run, { path: resolve(root, "absolute.txt") }), { code: "PATH_BOUNDARY" });
  await assert.rejects(() => inspectRunWorkspace(run, { path: "safe.txt:alternate" }), { code: "PATH_BOUNDARY" });
  await assert.rejects(() => inspectRunWorkspace(run, { path: "missing.txt" }), { code: "SOURCE_NOT_FOUND" });
  await assert.rejects(() => inspectRunWorkspace({ id: "run-empty" }), { code: "VALIDATION_FAILED" });
});

test("workspace explorer hard-denies sensitive names while ordinary key-like names remain previewable", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-workspace-sensitive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".ssh"));
  await mkdir(join(root, ".env.d"));
  await mkdir(join(root, "secrets"));
  await writeFile(join(root, ".env"), "OPAQUE=value", "utf8");
  await writeFile(join(root, ".env.production"), "OPAQUE=value", "utf8");
  await writeFile(join(root, ".env.example"), "OPAQUE=${OPAQUE}", "utf8");
  await writeFile(join(root, ".npmrc"), "registry=https://example.invalid", "utf8");
  await writeFile(join(root, "credentials.json"), "{}", "utf8");
  await writeFile(join(root, "api-token.txt"), "opaque", "utf8");
  await writeFile(join(root, "private.key"), "opaque", "utf8");
  await writeFile(join(root, ".ssh", "id_rsa"), "opaque", "utf8");
  await writeFile(join(root, ".env.d", "notes.txt"), "opaque", "utf8");
  await writeFile(join(root, "secrets", "notes.txt"), "opaque", "utf8");
  await writeFile(join(root, "monkey.txt"), "ordinary", "utf8");
  await writeFile(join(root, "keybindings.js"), "export default {};", "utf8");
  const run = { id: "run-sensitive", cwd: root };

  const listing = await inspectRunWorkspace(run);
  const listedNames = new Set(listing.entries.map((entry) => entry.name));
  for (const hidden of [
    ".env",
    ".env.production",
    ".env.example",
    ".env.d",
    ".npmrc",
    ".ssh",
    "api-token.txt",
    "credentials.json",
    "private.key",
    "secrets",
  ]) {
    assert.equal(listedNames.has(hidden), false, `${hidden} must not be listed`);
  }
  assert.equal((await inspectRunWorkspace(run, { path: "monkey.txt" })).file.content, "ordinary");
  assert.equal((await inspectRunWorkspace(run, { path: "keybindings.js" })).file.language, "javascript");

  for (const path of [
    ".env",
    ".env.production",
    ".env.example",
    ".npmrc",
    "credentials.json",
    "api-token.txt",
    "private.key",
    ".ssh/id_rsa",
    ".env.d/notes.txt",
    "secrets/notes.txt",
  ]) {
    await assert.rejects(
      () => inspectRunWorkspace(run, { path }),
      (error) => error.code === "PATH_BOUNDARY" && /sensitive/.test(error.message),
    );
  }
});

test("workspace explorer rejects unknown high-entropy text after known redaction", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-workspace-entropy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opaque = "A7bK9mQ2xR5vT8zC1dF4gH6jL0nP3sU7wY9eB2iD5kM8oS1qV4";
  await writeFile(join(root, "notes.txt"), `opaque material follows\n${opaque}\n`, "utf8");

  await assert.rejects(
    () => inspectRunWorkspace({ id: "run-entropy", cwd: root }, { path: "notes.txt" }),
    (error) => error.code === "PATH_BOUNDARY" && /high-entropy/.test(error.message),
  );
});

test("workspace explorer rejects a root directory link", async (t) => {
  const container = await mkdtemp(resolve(appRoot, ".test-workspace-root-link-"));
  t.after(() => rm(container, { recursive: true, force: true }));
  const realRoot = join(container, "real-workspace");
  const linkedRoot = join(container, "linked-workspace");
  await mkdir(realRoot);
  await writeFile(join(realRoot, "visible.txt"), "must not be reached through a linked root", "utf8");
  if (!await createDirectoryLink(realRoot, linkedRoot)) return t.skip("directory links are unavailable on this host");

  await assert.rejects(
    () => inspectRunWorkspace({ id: "run-root-link", cwd: linkedRoot }),
    (error) => error.code === "PATH_BOUNDARY" && /links|junction/.test(error.message),
  );
});

test("workspace explorer omits and rejects an escaping directory junction or symlink", async (t) => {
  const container = await mkdtemp(resolve(appRoot, ".test-workspace-dir-link-"));
  t.after(() => rm(container, { recursive: true, force: true }));
  const root = join(container, "root");
  const outside = join(container, "outside");
  const escape = join(root, "escape-dir");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "outside-secret.txt"), "outside", "utf8");
  if (!await createDirectoryLink(outside, escape)) return t.skip("directory links are unavailable on this host");
  const run = { id: "run-dir-link", cwd: root };

  const listing = await inspectRunWorkspace(run);
  assert.equal(listing.entries.some((entry) => entry.name === "escape-dir"), false);
  await assert.rejects(
    () => inspectRunWorkspace(run, { path: "escape-dir" }),
    (error) => error.code === "PATH_BOUNDARY" && /links|junction/.test(error.message),
  );
});

test("workspace explorer omits and rejects an escaping file symlink", async (t) => {
  const container = await mkdtemp(resolve(appRoot, ".test-workspace-file-link-"));
  t.after(() => rm(container, { recursive: true, force: true }));
  const root = join(container, "root");
  const outside = join(container, "outside.txt");
  const escape = join(root, "escape.txt");
  await mkdir(root);
  await writeFile(outside, "outside", "utf8");
  if (!await createFileLink(outside, escape)) return t.skip("file symlinks are unavailable on this host");
  const run = { id: "run-file-link", cwd: root };

  const listing = await inspectRunWorkspace(run);
  assert.equal(listing.entries.some((entry) => entry.name === "escape.txt"), false);
  await assert.rejects(
    () => inspectRunWorkspace(run, { path: "escape.txt" }),
    (error) => error.code === "PATH_BOUNDARY" && /links|junction/.test(error.message),
  );
});

test("workspace explorer omits and rejects a hard link to a file outside the root", async (t) => {
  const container = await mkdtemp(resolve(appRoot, ".test-workspace-hard-link-"));
  t.after(() => rm(container, { recursive: true, force: true }));
  const root = join(container, "root");
  const outside = join(container, "outside.txt");
  const alias = join(root, "alias.txt");
  await mkdir(root);
  await writeFile(outside, "outside", "utf8");
  await link(outside, alias);
  const run = { id: "run-hard-link", cwd: root };

  const listing = await inspectRunWorkspace(run);
  assert.equal(listing.entries.some((entry) => entry.name === "alias.txt"), false);
  await assert.rejects(
    () => inspectRunWorkspace(run, { path: "alias.txt" }),
    (error) => error.code === "PATH_BOUNDARY" && /hard-linked/.test(error.message),
  );
});

test("workspace explorer detects a deterministic file replacement after path checks", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-workspace-file-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "notes.txt");
  await writeFile(target, "original", "utf8");
  let replaced = false;
  const inspect = createWorkspaceExplorer({
    fs: fsAdapter({
      open: async (path, flags) => {
        if (!replaced && sameResolvedPath(path, target)) {
          replaced = true;
          await rename(target, join(root, "notes.original.txt"));
          await writeFile(target, "replacement", "utf8");
        }
        return fsOpen(path, flags);
      },
    }),
  });

  await assert.rejects(
    () => inspect({ id: "run-file-race", cwd: root }, { path: "notes.txt" }),
    (error) => error.code === "PATH_BOUNDARY" && /changed/.test(error.message),
  );
  assert.equal(replaced, true, "race adapter must replace the checked file before open");
});

test("workspace explorer detects a deterministic directory replacement after its handle opens", async (t) => {
  const root = await mkdtemp(resolve(appRoot, ".test-workspace-dir-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "src");
  await mkdir(target);
  await writeFile(join(target, "safe.txt"), "safe", "utf8");
  let replaced = false;
  const inspect = createWorkspaceExplorer({
    fs: fsAdapter({
      opendir: async (path, options) => {
        if (!replaced && sameResolvedPath(path, target)) {
          replaced = true;
          await rename(target, join(root, "src.original"));
          await mkdir(target);
          await writeFile(join(target, "outside-name.txt"), "replacement", "utf8");
        }
        return fsOpendir(path, options);
      },
    }),
  });

  await assert.rejects(
    () => inspect({ id: "run-dir-race", cwd: root }, { path: "src" }),
    (error) => error.code === "PATH_BOUNDARY" && /changed/.test(error.message),
  );
  assert.equal(replaced, true, "race adapter must replace the opened directory before listing");
});
