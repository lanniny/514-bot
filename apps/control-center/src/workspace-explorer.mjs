import { constants as fsConstants } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { assertWithin, isWithin, toPortablePath } from "./paths.mjs";
import { scrub } from "./redaction.mjs";
import { attestRunWorkspace } from "./run-workspace.mjs";

export const WORKSPACE_EXPLORER_SCHEMA = "514cc.workspace.snapshot/v1";

export const WORKSPACE_EXPLORER_LIMITS = Object.freeze({
  entries: 240,
  scanEntries: 4_096,
  previewBytes: 256 * 1024,
  pathCharacters: 1_024,
  nameCharacters: 260,
});

const LANGUAGE_BY_EXTENSION = Object.freeze({
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".css": "css",
  ".go": "go",
  ".h": "c",
  ".hpp": "cpp",
  ".html": "html",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "javascript",
  ".md": "markdown",
  ".mjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".sh": "shell",
  ".sql": "sql",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".txt": "text",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
});

const DEFAULT_FS = Object.freeze({
  lstat: fsPromises.lstat,
  open: fsPromises.open,
  opendir: fsPromises.opendir,
  realpath: fsPromises.realpath,
  rename: fsPromises.rename,
  unlink: fsPromises.unlink,
});

const OPEN_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const OPEN_DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const READ_FLAGS = fsConstants.O_RDONLY | OPEN_NOFOLLOW;
const DIRECTORY_FLAGS = READ_FLAGS | OPEN_DIRECTORY;
const CREATE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | OPEN_NOFOLLOW;

const SENSITIVE_DIRECTORIES = new Set([
  ".aws",
  ".azure",
  ".docker",
  ".git",
  ".gnupg",
  ".hg",
  ".kube",
  ".ssh",
  ".svn",
]);

const SENSITIVE_EXACT_FILES = new Set([
  ".envrc",
  ".git-credentials",
  ".gitcredentials",
  ".netrc",
  ".npmrc",
  ".pnpmrc",
  ".pypirc",
  ".yarnrc",
  "_netrc",
  "auth.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);

const SENSITIVE_FILE_EXTENSION = /\.(?:credentials?|jks|kdbx|key|keystore|p12|pfx|pkcs12|pem)$/i;
const SENSITIVE_FILE_WORD = /(?:^|[._-])(?:api[._-]?keys?|access[._-]?keys?|auth[._-]?tokens?|client[._-]?secrets?|credentials?|keys?|passwords?|passwds?|private[._-]?keys?|refresh[._-]?tokens?|secrets?|service[._-]?accounts?|tokens?)(?:$|[._-])/i;
const SENSITIVE_DIRECTORY_WORD = /(?:^|[._-])(?:credentials?|keys?|secrets?|tokens?)(?:$|[._-])/i;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9_+/=-]{40,}/g;

function invalid(message, code = "VALIDATION_FAILED") {
  return Object.assign(new Error(message), { code });
}

function boundary(message) {
  return invalid(message, "PATH_BOUNDARY");
}

function changed(message = "workspace changed while it was being inspected") {
  return boundary(message);
}

function cleanDisplayName(value) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "�")
    .slice(0, WORKSPACE_EXPLORER_LIMITS.nameCharacters);
  return scrub(normalized);
}

function unsafePortableSegment(segment) {
  return !segment
    || segment === "."
    || segment === ".."
    || /[\u0000-\u001f\u007f]/.test(segment)
    || /[\\/:]/.test(segment)
    || /[ .]$/.test(segment)
    || WINDOWS_DEVICE_NAME.test(segment);
}

function sensitiveSegment(segment, { directory = false } = {}) {
  const name = String(segment).toLowerCase();
  if (SENSITIVE_DIRECTORIES.has(name) || /^\.env(?:\..*)?$/i.test(name) || SENSITIVE_EXACT_FILES.has(name)) return true;
  if (directory) return SENSITIVE_DIRECTORY_WORD.test(name);
  return SENSITIVE_FILE_EXTENSION.test(name)
    || SENSITIVE_FILE_WORD.test(name);
}

function cleanRelativePath(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === ".") return "";
  if (raw.length > WORKSPACE_EXPLORER_LIMITS.pathCharacters) throw invalid("workspace path is too long");
  if (raw.includes("\0") || isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw boundary("workspace path must be relative");
  }
  const segments = raw.replaceAll("\\", "/").split("/");
  if (segments.some(unsafePortableSegment)) throw boundary("workspace path contains an unsafe segment");
  if (segments.some((segment, index) => sensitiveSegment(segment, { directory: index < segments.length - 1 }))) {
    throw boundary("sensitive workspace paths are not previewable");
  }
  return segments.join(sep);
}

function entryType(entry) {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}

function statType(info) {
  if (info.isSymbolicLink()) return "symlink";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}

function probablyBinary(buffer) {
  if (buffer.includes(0)) return true;
  if (!buffer.length) return false;
  let controls = 0;
  for (const byte of buffer) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return controls / buffer.length > 0.08;
}

function shannonEntropy(value) {
  const frequencies = new Map();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function hasOpaqueHighEntropyToken(value) {
  HIGH_ENTROPY_TOKEN.lastIndex = 0;
  for (const match of String(value).matchAll(HIGH_ENTROPY_TOKEN)) {
    const token = match[0];
    if (new Set(token).size >= 16 && shannonEntropy(token) >= 4.3) return true;
  }
  return false;
}

function contentRevision(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function editableText(content) {
  const scrubbed = scrub(content);
  if (scrubbed !== content) throw boundary("workspace content contains sensitive material and is not editable");
  if (hasOpaqueHighEntropyToken(content)) throw boundary("workspace content contains opaque high-entropy material");
}

function parentPath(portablePath) {
  if (!portablePath) return null;
  const parts = portablePath.split("/");
  parts.pop();
  return parts.join("/");
}

function samePath(left, right) {
  const normalize = (value) => {
    const absolute = resolve(value);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  return normalize(left) === normalize(right);
}

function identityComparable(info) {
  return typeof info?.ino === "bigint" && info.ino !== 0n;
}

function samePathIdentity(left, right) {
  if (!identityComparable(left) || !identityComparable(right)) return false;
  if (left.ino !== right.ino) return false;
  if (left.dev !== 0n && right.dev !== 0n && left.dev !== right.dev) return false;
  if (left.birthtimeNs !== 0n && right.birthtimeNs !== 0n && left.birthtimeNs !== right.birthtimeNs) return false;
  return statType(left) === statType(right);
}

function sameHandleIdentity(left, right) {
  return identityComparable(left)
    && identityComparable(right)
    && left.dev !== 0n
    && right.dev !== 0n
    && left.dev === right.dev
    && left.ino === right.ino
    && (left.birthtimeNs === 0n || right.birthtimeNs === 0n || left.birthtimeNs === right.birthtimeNs)
    && statType(left) === statType(right);
}

function sameFileVersion(left, right) {
  return sameHandleIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function bigLstat(fs, path, missingMessage) {
  try {
    return await fs.lstat(path, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") throw invalid(missingMessage, "SOURCE_NOT_FOUND");
    throw error;
  }
}

async function canonicalPath(fs, path, missingMessage) {
  try {
    return await fs.realpath(path);
  } catch (error) {
    if (error.code === "ENOENT") throw invalid(missingMessage, "SOURCE_NOT_FOUND");
    if (["ELOOP", "EMLINK"].includes(error.code)) throw boundary("workspace links are not traversable");
    throw error;
  }
}

function absoluteComponents(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  const components = [];
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    components.push(current);
  }
  return components.length ? components : [root];
}

function relativeComponents(root, target) {
  const rel = relative(root, target);
  if (!rel) return [root];
  const components = [root];
  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    components.push(current);
  }
  return components;
}

async function assertNoLinks(fs, components, missingMessage) {
  let finalInfo = null;
  for (let index = 0; index < components.length; index += 1) {
    const info = await bigLstat(fs, components[index], missingMessage);
    if (info.isSymbolicLink()) throw boundary("workspace links and junctions are not traversable");
    if (index < components.length - 1 && !info.isDirectory()) {
      throw boundary("workspace path contains a non-directory ancestor");
    }
    finalInfo = info;
  }
  return finalInfo;
}

async function openHandle(fs, path, flags) {
  try {
    return await fs.open(path, flags);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes(error.code)) throw boundary("workspace links are not traversable");
    if (error.code === "ENOENT") throw changed();
    throw error;
  }
}

async function verifyRoot(fs, context) {
  const pathInfo = await assertNoLinks(fs, absoluteComponents(context.lexicalRoot), "项目目录不存在");
  if (!pathInfo?.isDirectory()) throw invalid("项目根路径不是目录");
  const canonical = await canonicalPath(fs, context.lexicalRoot, "项目目录不存在");
  if (!samePath(canonical, context.root)) throw boundary("workspace root resolves through a link or junction");

  const held = await context.handle.stat({ bigint: true });
  if (!samePathIdentity(pathInfo, held) || !samePathIdentity(context.snapshot, held)) throw changed("workspace root changed during inspection");

  const verifier = await openHandle(fs, context.root, DIRECTORY_FLAGS);
  try {
    const verified = await verifier.stat({ bigint: true });
    if (!sameHandleIdentity(held, verified) || !verified.isDirectory()) {
      throw changed("workspace root identity could not be verified");
    }
  } finally {
    await verifier.close();
  }
  return held;
}

async function openRoot(fs, run) {
  const candidate = await attestRunWorkspace(run);
  const lexicalRoot = resolve(candidate.path);
  if (sensitiveSegment(basename(lexicalRoot), { directory: true })) {
    throw boundary("sensitive workspace roots are not browseable");
  }
  const snapshot = await assertNoLinks(fs, absoluteComponents(lexicalRoot), "项目目录不存在");
  if (!snapshot?.isDirectory()) throw invalid("项目根路径不是目录");
  const root = await canonicalPath(fs, lexicalRoot, "项目目录不存在");
  if (!samePath(root, lexicalRoot)) throw boundary("workspace root resolves through a link or junction");

  const handle = await openHandle(fs, root, DIRECTORY_FLAGS);
  const context = { handle, lexicalRoot, root, rootKind: candidate.kind, snapshot };
  try {
    const held = await handle.stat({ bigint: true });
    if (!samePathIdentity(snapshot, held) || !held.isDirectory()) throw changed("workspace root changed before it was opened");
    await verifyRoot(fs, context);
    return context;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function resolveTarget(fs, rootContext, requestedPath) {
  await verifyRoot(fs, rootContext);
  const relativePath = cleanRelativePath(requestedPath);
  const lexicalTarget = assertWithin(rootContext.root, resolve(rootContext.root, relativePath), "workspace path");
  const targetSnapshot = await assertNoLinks(
    fs,
    relativeComponents(rootContext.root, lexicalTarget),
    "文件或目录不存在",
  );
  const target = await canonicalPath(fs, lexicalTarget, "文件或目录不存在");
  if (!isWithin(rootContext.root, target) || !samePath(target, lexicalTarget)) {
    throw boundary("workspace path escapes its allowed root or resolves through a link");
  }
  await verifyRoot(fs, rootContext);
  return {
    ...rootContext,
    target,
    targetSnapshot,
    portablePath: toPortablePath(relative(rootContext.root, target)),
  };
}

async function verifyTarget(fs, context, handle) {
  await verifyRoot(fs, context);
  const pathInfo = await assertNoLinks(fs, relativeComponents(context.root, context.target), "文件或目录不存在");
  const canonical = await canonicalPath(fs, context.target, "文件或目录不存在");
  if (!isWithin(context.root, canonical) || !samePath(canonical, context.target)) {
    throw boundary("workspace target resolves through a link or junction");
  }

  const held = await handle.stat({ bigint: true });
  if (!samePathIdentity(context.targetSnapshot, held) || !samePathIdentity(pathInfo, held)) {
    throw changed("workspace target changed during inspection");
  }
  if (held.isFile() && held.nlink !== 1n) throw boundary("hard-linked workspace files are not previewable");

  const flags = held.isDirectory() ? DIRECTORY_FLAGS : READ_FLAGS;
  const verifier = await openHandle(fs, context.target, flags);
  try {
    const verified = await verifier.stat({ bigint: true });
    if (!sameHandleIdentity(held, verified)) throw changed("workspace target identity could not be verified");
  } finally {
    await verifier.close();
  }
  await verifyRoot(fs, context);
  return held;
}

async function openTarget(fs, context) {
  const handle = await openHandle(fs, context.target, READ_FLAGS);
  try {
    const held = await handle.stat({ bigint: true });
    if (!samePathIdentity(context.targetSnapshot, held)) throw changed("workspace target changed before it was opened");
    if (held.isFile() && held.nlink !== 1n) throw boundary("hard-linked workspace files are not previewable");
    await verifyTarget(fs, context, handle);
    return { handle, metadata: held };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function directorySnapshot(fs, target) {
  const entries = [];
  let truncated = false;
  const directory = await fs.opendir(target);
  for await (const entry of directory) {
    if (entries.length >= WORKSPACE_EXPLORER_LIMITS.scanEntries) {
      truncated = true;
      break;
    }
    entries.push({ name: entry.name, type: entryType(entry) });
  }
  return { entries, truncated };
}

function sameDirectorySnapshot(left, right) {
  if (left.truncated !== right.truncated || left.entries.length !== right.entries.length) return false;
  const signature = ({ name, type }) => `${name}\0${type}`;
  const leftEntries = left.entries.map(signature).sort();
  const rightEntries = right.entries.map(signature).sort();
  return leftEntries.every((entry, index) => entry === rightEntries[index]);
}

async function validatedDirectoryEntries(fs, context, snapshot) {
  const entries = [];
  for (const entry of snapshot.entries) {
    if (unsafePortableSegment(entry.name)) continue;
    const child = assertWithin(context.target, resolve(context.target, entry.name), "workspace entry");
    let info;
    try {
      info = await fs.lstat(child, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT") throw changed("workspace directory entries changed during inspection");
      throw error;
    }
    const actualType = statType(info);
    if (entry.type !== "other" && entry.type !== actualType) {
      throw changed("workspace directory entry type changed during inspection");
    }
    const isDirectory = actualType === "directory";
    if (sensitiveSegment(entry.name, { directory: isDirectory })) continue;
    if (actualType === "symlink" || actualType === "other") continue;
    if (actualType === "file" && info.nlink !== 1n) continue;

    const canonical = await canonicalPath(fs, child, "文件或目录不存在");
    if (!isWithin(context.root, canonical) || !samePath(canonical, child)) {
      throw boundary("workspace directory entry resolves through a link or junction");
    }
    entries.push({
      name: cleanDisplayName(entry.name),
      path: toPortablePath(relative(context.root, child)),
      type: actualType,
      openable: true,
    });
  }
  return entries;
}

async function listDirectory(fs, context, handle) {
  const first = await directorySnapshot(fs, context.target);
  await verifyTarget(fs, context, handle);
  const second = await directorySnapshot(fs, context.target);
  await verifyTarget(fs, context, handle);
  if (!sameDirectorySnapshot(first, second)) throw changed("workspace directory changed while it was listed");

  const scannedEntries = await validatedDirectoryEntries(fs, context, first);
  await verifyTarget(fs, context, handle);
  scannedEntries.sort((left, right) => {
    const leftRank = left.type === "directory" ? 0 : 1;
    const rightRank = right.type === "directory" ? 0 : 1;
    return leftRank - rightRank || left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
  const entries = scannedEntries.slice(0, WORKSPACE_EXPLORER_LIMITS.entries);

  return {
    schema: WORKSPACE_EXPLORER_SCHEMA,
    schemaVersion: 1,
    rootKind: context.rootKind,
    type: "directory",
    path: context.portablePath,
    parent: parentPath(context.portablePath),
    entries,
    truncated: first.truncated || scannedEntries.length > entries.length,
    bounds: { ...WORKSPACE_EXPLORER_LIMITS },
  };
}

async function previewFile(fs, context, handle, initialMetadata) {
  const bytesToRead = Number(
    initialMetadata.size > BigInt(WORKSPACE_EXPLORER_LIMITS.previewBytes)
      ? BigInt(WORKSPACE_EXPLORER_LIMITS.previewBytes)
      : initialMetadata.size,
  );
  const buffer = Buffer.alloc(bytesToRead);
  const { bytesRead } = bytesToRead ? await handle.read(buffer, 0, bytesToRead, 0) : { bytesRead: 0 };
  const finalMetadata = await verifyTarget(fs, context, handle);
  if (!sameFileVersion(initialMetadata, finalMetadata)) throw changed("workspace file changed while it was read");

  const payload = buffer.subarray(0, bytesRead);
  let binary = probablyBinary(payload);
  let content = null;
  let redacted = false;
  if (!binary) {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(payload, {
        stream: initialMetadata.size > BigInt(bytesRead),
      });
      content = scrub(decoded);
      redacted = content !== decoded;
      if (hasOpaqueHighEntropyToken(content)) {
        throw boundary("workspace preview contains opaque high-entropy material");
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      binary = true;
      content = null;
      redacted = false;
    }
  }
  return {
    schema: WORKSPACE_EXPLORER_SCHEMA,
    schemaVersion: 1,
    rootKind: context.rootKind,
    type: "file",
    path: context.portablePath,
    parent: parentPath(context.portablePath),
    file: {
      name: cleanDisplayName(context.portablePath.split("/").at(-1)),
      size: Number(initialMetadata.size),
      language: LANGUAGE_BY_EXTENSION[extname(context.target).toLowerCase()] ?? "text",
      binary,
      truncated: initialMetadata.size > BigInt(bytesRead),
      redacted,
      content,
      editable: !binary && !redacted && initialMetadata.size <= BigInt(bytesRead),
      revision: !binary && !redacted && initialMetadata.size <= BigInt(bytesRead)
        ? contentRevision(payload)
        : null,
    },
    bounds: { ...WORKSPACE_EXPLORER_LIMITS },
  };
}

async function replaceFile(fs, context, handle, initialMetadata, { content, expectedRevision, closeTarget }) {
  if (typeof content !== "string") throw invalid("workspace content must be a string");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > WORKSPACE_EXPLORER_LIMITS.previewBytes) {
    throw invalid(`workspace content exceeds ${WORKSPACE_EXPLORER_LIMITS.previewBytes} bytes`, "BODY_TOO_LARGE");
  }
  if (!/^[a-f0-9]{64}$/i.test(String(expectedRevision ?? ""))) {
    throw invalid("workspace expectedRevision is required");
  }
  editableText(content);

  const current = await previewFile(fs, context, handle, initialMetadata);
  if (!current.file.editable) throw invalid("workspace file is not editable", "READ_ONLY_SOURCE");
  if (current.file.revision !== expectedRevision) {
    throw invalid("workspace file changed after it was opened; reload before saving", "WORKSPACE_VERSION_CONFLICT");
  }

  const tempPath = join(
    context.target.slice(0, context.target.length - basename(context.target).length),
    `.${basename(context.target)}.514cc-save-${randomUUID()}.tmp`,
  );
  let tempHandle = null;
  try {
    tempHandle = await fs.open(tempPath, CREATE_FLAGS, Number(initialMetadata.mode & 0o777n));
    await tempHandle.writeFile(bytes);
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = null;

    const finalMetadata = await verifyTarget(fs, context, handle);
    if (!sameFileVersion(initialMetadata, finalMetadata)) {
      throw changed("workspace file changed while the replacement was prepared");
    }
    await verifyRoot(fs, context);
    // Windows does not permit replacing a destination while our read handle is
    // still open. Keep it held through every identity/version check, then close
    // it exactly once immediately before the atomic rename.
    await closeTarget();
    await fs.rename(tempPath, context.target);
  } catch (error) {
    await tempHandle?.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

export function createWorkspaceExplorer({ fs = DEFAULT_FS } = {}) {
  for (const method of ["lstat", "open", "opendir", "realpath"]) {
    if (typeof fs?.[method] !== "function") throw new TypeError(`workspace explorer fs.${method} must be a function`);
  }
  return async function inspect(run, { path = "" } = {}) {
    if (!run?.id) throw invalid("run is required");
    const rootContext = await openRoot(fs, run);
    try {
      const context = await resolveTarget(fs, rootContext, path);
      const { handle, metadata } = await openTarget(fs, context);
      try {
        if (metadata.isDirectory()) return { runId: String(run.id), ...await listDirectory(fs, context, handle) };
        if (metadata.isFile()) return { runId: String(run.id), ...await previewFile(fs, context, handle, metadata) };
        throw invalid("workspace path is not a regular file or directory");
      } finally {
        await handle.close();
      }
    } finally {
      await rootContext.handle.close();
    }
  };
}

export const inspectRunWorkspace = createWorkspaceExplorer();

export function createWorkspaceEditor({ fs = DEFAULT_FS, inspect = createWorkspaceExplorer({ fs }) } = {}) {
  for (const method of ["lstat", "open", "opendir", "realpath", "rename", "unlink"]) {
    if (typeof fs?.[method] !== "function") throw new TypeError(`workspace editor fs.${method} must be a function`);
  }
  return async function update(run, { path = "", content, expectedRevision } = {}) {
    if (!run?.id) throw invalid("run is required");
    const rootContext = await openRoot(fs, run);
    try {
      const context = await resolveTarget(fs, rootContext, path);
      const { handle, metadata } = await openTarget(fs, context);
      let targetClosed = false;
      const closeTarget = async () => {
        if (targetClosed) return;
        await handle.close();
        targetClosed = true;
      };
      try {
        if (!metadata.isFile()) throw invalid("workspace path is not an editable file");
        await replaceFile(fs, context, handle, metadata, { content, expectedRevision, closeTarget });
      } finally {
        await closeTarget();
      }
    } finally {
      await rootContext.handle.close();
    }
    return inspect(run, { path });
  };
}

export const updateRunWorkspaceFile = createWorkspaceEditor();
