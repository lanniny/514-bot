#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, realpath, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultRepoRoot = resolve(appRoot, "..", "..");

export const DEFAULT_FOCUS_PATHS = Object.freeze([
  "apps/control-center/src",
  "apps/control-center/public",
  "apps/control-center/tests",
  "apps/control-center/scripts",
  "apps/control-center/vendor",
  "apps/control-center/server.mjs",
  "apps/control-center/delivery-ownership.json",
  "apps/control-center/package.json",
  "apps/control-center/package-lock.json",
]);

/**
 * P0-11：桌面壳（Tauri）的独立交付闭包焦点面。Web 侧 gate 不能证明桌面壳完整，
 * 也不该把 `apps/desktop/src-tauri/target/` 的构建产物与 `.cargo-test-*` 拉进 Web manifest。
 * 这里用显式源码路径（Cargo、src、capability、icons、permissions、schemas、conf、README）
 * 组成桌面闭包，并机械排除 target 与 cargo test 产物，使 Web/desktop 两份 manifest 各自闭合。
 */
export const DESKTOP_FOCUS_PATHS = Object.freeze([
  "apps/desktop/README.md",
  "apps/desktop/ui",
  "apps/desktop/src-tauri/Cargo.toml",
  "apps/desktop/src-tauri/Cargo.lock",
  "apps/desktop/src-tauri/build.rs",
  "apps/desktop/src-tauri/src",
  "apps/desktop/src-tauri/capabilities",
  "apps/desktop/src-tauri/icons",
  "apps/desktop/src-tauri/permissions",
  "apps/desktop/src-tauri/gen",
  "apps/desktop/src-tauri/tauri.conf.json",
]);

export const DESKTOP_EXCLUDE_SCOPE_PATHS = Object.freeze(["apps/desktop/src-tauri/target"]);
export const OWNERSHIP_CLASSES = Object.freeze(["must_ship", "generated", "scratch", "deferred"]);
const INTENTIONAL_UNTRACKED = new Set(["generated", "scratch", "deferred"]);

const CODE_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".jsx", ".js", ".json", ".mjs", ".ps1", ".py", ".rs", ".ts", ".tsx", ".yaml", ".yml", ".tgz",
]);

function toRepoPath(path) {
  return path.split(sep).join("/");
}

function isInside(repoRoot, path) {
  const rel = relative(repoRoot, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isCodeOrTestPath(repoPath) {
  const normalized = toRepoPath(repoPath);
  if (normalized.includes("/tests/") || normalized.startsWith("apps/control-center/tests/")) return true;
  const dot = normalized.lastIndexOf(".");
  if (dot < 0) return false;
  const extension = normalized.slice(dot).toLowerCase();
  return CODE_EXTENSIONS.has(extension);
}

function pathKey(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function globToRegExp(pattern) {
  const escaped = String(pattern)
    .split("/")
    .map((part) => {
      if (part === "**") return ".*";
      return part
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*");
    })
    .join("/");
  return new RegExp(`^${escaped}$`);
}

export function classifyOwnedPath(repoPath, ownership) {
  if (!ownership?.rules) return null;
  const normalized = toRepoPath(repoPath);
  let matched = null;
  for (const rule of ownership.rules) {
    if (globToRegExp(rule.pattern).test(normalized)) {
      matched = {
        class: OWNERSHIP_CLASSES.includes(rule.class) ? rule.class : "must_ship",
        owner: rule.owner || "unassigned",
        kind: rule.kind || "source",
        pattern: rule.pattern,
      };
    }
  }
  return matched;
}

export function assertPackageLockConsistent(pkg, lock) {
  if (!pkg || !lock) {
    throw new Error("package.json or package-lock.json is missing");
  }
  if (Number(lock.lockfileVersion) < 3) {
    throw new Error(`package-lock.json lockfileVersion ${lock.lockfileVersion} is below 3`);
  }
  if (lock.name && pkg.name && lock.name !== pkg.name) {
    throw new Error(`package-lock name ${lock.name} does not match package.json ${pkg.name}`);
  }
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  const missing = Object.keys(declared).filter((name) => !lock.packages?.[`node_modules/${name}`]);
  if (missing.length) {
    throw new Error(`package-lock.json is missing declared packages: ${missing.join(", ")}`);
  }
  return true;
}

async function loadOwnership(repoRoot, ownershipPath) {
  const candidate = ownershipPath || resolve(repoRoot, "apps/control-center/delivery-ownership.json");
  try {
    return JSON.parse(await readFile(candidate, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function listPhysicalFiles(repoRealRoot, current, result = []) {
  let currentRealPath;
  try {
    currentRealPath = await realpath(current);
  } catch (error) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }
  if (!isInside(repoRealRoot, currentRealPath)) {
    throw new Error(`focus path resolves outside repository root: ${current}`);
  }
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOTDIR") {
      result.push(current);
      return result;
    }
    if (error?.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) {
      await listPhysicalFiles(repoRealRoot, path, result);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      result.push(path);
    }
  }
  return result;
}

async function gitLsFiles(repoRoot, focusPaths) {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "--", ...focusPaths],
    { encoding: "utf8", windowsHide: true },
  );
  return stdout.split("\0").filter(Boolean).map(toRepoPath);
}

async function gitLsUntrackedFiles(repoRoot, focusPaths) {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "--others", "--exclude-standard", "--", ...focusPaths],
    { encoding: "utf8", windowsHide: true },
  );
  return stdout.split("\0").filter(Boolean).map(toRepoPath);
}

function normalizeFocusPaths(repoRoot, focusPaths) {
  return focusPaths.map((path) => {
    const absolute = resolve(repoRoot, path);
    if (!isInside(repoRoot, absolute)) {
      throw new Error(`focus path escapes repository root: ${path}`);
    }
    return toRepoPath(relative(repoRoot, absolute));
  });
}

export async function collectDeliveryManifest({
  repoRoot = defaultRepoRoot,
  focusPaths = DEFAULT_FOCUS_PATHS,
  ownershipPath = null,
  excludePaths = [],
} = {}) {
  const resolvedRepoRoot = resolve(repoRoot);
  const normalizedFocusPaths = normalizeFocusPaths(resolvedRepoRoot, focusPaths);
  const uniqueFocusPaths = [...new Map(normalizedFocusPaths.map((path) => [pathKey(path), path])).values()];
  const repoRealRoot = await realpath(resolvedRepoRoot);
  const excludedPrefixes = excludePaths.map((path) => pathKey(toRepoPath(resolve(resolvedRepoRoot, path))));
  const isExcluded = (repoPath) => {
    const key = pathKey(toRepoPath(repoPath));
    return excludedPrefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}/`));
  };
  const [trackedFiles, untrackedFiles, physicalByRoot] = await Promise.all([
    gitLsFiles(resolvedRepoRoot, uniqueFocusPaths),
    gitLsUntrackedFiles(resolvedRepoRoot, uniqueFocusPaths),
    Promise.all(uniqueFocusPaths.map((path) => {
      const absolute = resolve(resolvedRepoRoot, path);
      return isExcluded(absolute) ? [] : listPhysicalFiles(repoRealRoot, absolute);
    })),
  ]);
  const physicalFilesOnDisk = [...new Map(physicalByRoot
    .flat()
    .map((path) => toRepoPath(relative(resolvedRepoRoot, path)))
    .filter((path) => !isExcluded(path))
    .map((path) => [pathKey(path), path])).values()].sort();
  const physicalSet = new Set(physicalFilesOnDisk.map(pathKey));
  const physicalFiles = [...new Map([
    ...trackedFiles.filter((path) => physicalSet.has(pathKey(path)) && !isExcluded(path)),
    ...untrackedFiles.filter((path) => !isExcluded(path)),
  ].map((path) => [pathKey(path), path])).values()].sort();
  const deletedTrackedFiles = trackedFiles.filter((path) => !physicalSet.has(pathKey(path)) && !isExcluded(path)).sort();
  const sortedUntrackedFiles = [...untrackedFiles].filter((path) => !isExcluded(path)).sort();
  const untrackedSourceOrTests = sortedUntrackedFiles.filter(isCodeOrTestPath);
  const missingSourceOrTests = deletedTrackedFiles.filter(isCodeOrTestPath);
  const ownership = await loadOwnership(resolvedRepoRoot, ownershipPath);
  const classifiedUntracked = untrackedSourceOrTests.map((path) => ({
    path,
    ...(classifyOwnedPath(path, ownership) || { class: "undeclared", owner: "unassigned", kind: "source" }),
  }));
  const declaredMustShipSourceOrTests = classifiedUntracked
    .filter((item) => item.class === "must_ship")
    .map((item) => item.path);
  const undeclaredSourceOrTests = classifiedUntracked
    .filter((item) => item.class === "undeclared")
    .map((item) => item.path);
  const intentionalUntracked = classifiedUntracked
    .filter((item) => INTENTIONAL_UNTRACKED.has(item.class))
    .map((item) => item.path);
  const associations = {
    source: [...trackedFiles, ...untrackedSourceOrTests].filter((path) => (classifyOwnedPath(path, ownership)?.kind || (isCodeOrTestPath(path) ? "source" : "other")) === "source").length,
    test: [...trackedFiles, ...untrackedSourceOrTests].filter((path) => path.includes("/tests/") || classifyOwnedPath(path, ownership)?.kind === "test").length,
    config: [...trackedFiles].filter((path) => classifyOwnedPath(path, ownership)?.kind === "config").length,
    doc: [...trackedFiles].filter((path) => classifyOwnedPath(path, ownership)?.kind === "doc").length,
  };
  const strictFailure = ownership
    ? declaredMustShipSourceOrTests.length > 0 || undeclaredSourceOrTests.length > 0 || missingSourceOrTests.length > 0
    : untrackedSourceOrTests.length > 0 || missingSourceOrTests.length > 0;

  return {
    repoRoot: resolvedRepoRoot,
    focusPaths: uniqueFocusPaths,
    trackedFiles: [...trackedFiles].sort(),
    physicalFiles,
    untrackedFiles: sortedUntrackedFiles,
    untrackedSourceOrTests,
    deletedTrackedFiles,
    missingSourceOrTests,
    ownership: ownership
      ? {
        schema: ownership.schema || null,
        cut: ownership.cut || null,
        declaredMustShipSourceOrTests,
        undeclaredSourceOrTests,
        intentionalUntracked,
        classifiedUntracked,
      }
      : null,
    associations,
    clean: sortedUntrackedFiles.length === 0 && deletedTrackedFiles.length === 0,
    strictFailure,
  };
}

export async function collectDesktopManifest({
  repoRoot = defaultRepoRoot,
} = {}) {
  const manifest = await collectDeliveryManifest({
    repoRoot,
    focusPaths: DESKTOP_FOCUS_PATHS,
    ownershipPath: null,
    excludePaths: DESKTOP_EXCLUDE_SCOPE_PATHS,
  });
  const requiredFiles = ["apps/desktop/ui/index.html"];
  const missingRequiredFiles = requiredFiles.filter((path) => !manifest.physicalFiles.includes(path));
  // Desktop focus paths are an explicit must-ship allowlist. Unlike the Web manifest,
  // there is no ownership table that can classify a focused asset as intentional drift,
  // so any non-ignored untracked or deleted file must fail strict delivery.
  return {
    ...manifest,
    missingRequiredFiles,
    clean: manifest.clean && missingRequiredFiles.length === 0,
    strictFailure: manifest.untrackedFiles.length > 0 || manifest.deletedTrackedFiles.length > 0 || missingRequiredFiles.length > 0,
  };
}

function formatList(title, entries) {
  if (!entries.length) return `${title}: 0`;
  return [`${title}: ${entries.length}`, ...entries.map((entry) => `  - ${entry}`)].join("\n");
}

export function renderDeliveryReport(manifest, { json = false, desktop = false } = {}) {
  if (json) return `${JSON.stringify(manifest, null, 2)}\n`;
  const lines = [
    `${desktop ? "514cc desktop delivery manifest (read-only)" : "514cc delivery manifest (read-only)"}`,
    `repo: ${manifest.repoRoot}`,
    `focus: ${manifest.focusPaths.join(", ")}`,
    `tracked: ${manifest.trackedFiles.length}; physical: ${manifest.physicalFiles.length}`,
    `cut: ${manifest.ownership?.cut?.id || "unspecified"}; formalRelease: ${manifest.ownership?.cut?.formalRelease === true ? "yes" : "no"}`,
    `associations: source=${manifest.associations?.source ?? 0} test=${manifest.associations?.test ?? 0} config=${manifest.associations?.config ?? 0} doc=${manifest.associations?.doc ?? 0}`,
    `status: ${manifest.clean ? "clean" : "drift"}; strict: ${manifest.strictFailure ? "fail" : "pass"}`,
    `excluded targets: ${desktop ? DESKTOP_EXCLUDE_SCOPE_PATHS.join(", ") : "none"}`,
    formatList("declared but untracked source/test", manifest.ownership?.declaredMustShipSourceOrTests || []),
    formatList("undeclared source/test", manifest.ownership?.undeclaredSourceOrTests || (manifest.ownership ? [] : manifest.untrackedSourceOrTests)),
    formatList("intentional untracked", manifest.ownership?.intentionalUntracked || []),
    formatList("untracked source/test", manifest.untrackedSourceOrTests),
    formatList("untracked other focus files", manifest.untrackedFiles.filter((entry) => !manifest.untrackedSourceOrTests.includes(entry))),
    formatList("deleted tracked source/test", manifest.missingSourceOrTests),
    formatList("deleted tracked other focus files", manifest.deletedTrackedFiles.filter((entry) => !manifest.missingSourceOrTests.includes(entry))),
  ];
  return `${lines.join("\n")}\n`;
}

export async function main(argv = process.argv.slice(2), {
  repoRoot = defaultRepoRoot,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const strict = argv.includes("--strict");
  const json = argv.includes("--json");
  const desktop = argv.includes("--desktop");
  const unknown = argv.filter((argument) => !["--strict", "--json", "--desktop"].includes(argument));
  if (unknown.length) {
    stderr.write(`Unknown option: ${unknown.join(", ")}\nUsage: node scripts/qa-delivery-manifest.mjs [--strict] [--json] [--desktop]\n`);
    return 2;
  }
  try {
    if (strict && !desktop) {
      const pkg = JSON.parse(await readFile(resolve(appRoot, "package.json"), "utf8"));
      const lock = JSON.parse(await readFile(resolve(appRoot, "package-lock.json"), "utf8"));
      assertPackageLockConsistent(pkg, lock);
    }
    const manifest = desktop
      ? await collectDesktopManifest({ repoRoot })
      : await collectDeliveryManifest({ repoRoot });
    stdout.write(renderDeliveryReport(manifest, { json, desktop }));
    return strict && manifest.strictFailure ? 1 : 0;
  } catch (error) {
    stderr.write(`delivery manifest failed: ${error?.message || error}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
