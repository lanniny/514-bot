import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const defaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
const extensions = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".ps1", ".sh", ".rs", ".css", ".html"]);
const excludedDirectories = new Set(["vendor", "node_modules", "target", ".scratch", ".workflow", ".git"]);

export function sourceRole(path) {
  const parts = path.replaceAll("\\", "/").split("/");
  if (parts.some((part) => excludedDirectories.has(part)) || !extensions.has(extname(path))) return null;
  if (parts.some((part) => part.startsWith(".test-")) || /(?:^|\/)\.[^/]+\.(?:mjs|js)$/.test(path)) return "local-probe";
  if (parts.includes("tests") || /(?:^|\/)test[_-]/.test(path)) return "test";
  if (parts.includes("scripts") || parts.includes("hooks")) return "tooling";
  if (path.startsWith("apps/desktop/")) return "desktop";
  if (path.startsWith("apps/control-center/public/")) return "frontend";
  if (path.startsWith("apps/control-center/")) return "backend";
  return "extension";
}

export async function inspectSources(paths, { repoRoot = defaultRoot, checkJavaScript = false } = {}) {
  const root = resolve(repoRoot);
  const records = [];
  for (const path of [...new Set(paths)].sort()) {
    const role = sourceRole(path);
    if (!role) continue;
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (isAbsolute(path) || !rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("source path must stay inside the repository");
    const record = { path: path.replaceAll("\\", "/"), role, review: "not-recorded", syntax: "not-checked" };
    try {
      const entry = await lstat(absolute);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        records.push({ ...record, inspection: "not-regular-file" });
        continue;
      }
      const source = await readFile(absolute);
      record.bytes = source.length;
      record.lines = source.length ? source.toString("utf8").split(/\r?\n/).length - Number(source.at(-1) === 10) : 0;
      record.sha256 = createHash("sha256").update(source).digest("hex");
      record.inspection = "indexed";
      if (checkJavaScript && role !== "local-probe" && [".js", ".mjs", ".cjs"].includes(extname(path))) {
        try {
          await execFileAsync(process.execPath, ["--check", absolute], { cwd: root, windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024 });
          record.syntax = "passed";
        } catch {
          record.syntax = "failed";
        }
        // Bind the parser verdict to the exact bytes that were indexed.
        const after = await readFile(absolute);
        if (createHash("sha256").update(after).digest("hex") !== record.sha256) record.syntax = "stale";
      }
    } catch (error) {
      record.inspection = "unavailable";
      record.errorCode = typeof error.code === "string" ? error.code : "READ_FAILED";
    }
    records.push(record);
  }
  return records;
}

export async function collectSourceInventory({ repoRoot = defaultRoot, checkJavaScript = false } = {}) {
  const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  const files = await inspectSources(stdout.split("\0").filter(Boolean), { repoRoot, checkJavaScript });
  const roles = Object.create(null);
  for (const file of files) roles[file.role] = (roles[file.role] || 0) + 1;
  return {
    schema: "514cc.sourceInventory/v1", generatedAt: new Date().toISOString(),
    boundary: "Mechanical inventory and optional parser checks only; not a human review or release verdict.",
    summary: { files: files.length, roles, syntaxPassed: files.filter((file) => file.syntax === "passed").length,
      syntaxFailed: files.filter((file) => ["failed", "stale"].includes(file.syntax)).length,
      unavailable: files.filter((file) => file.inspection !== "indexed").length },
    files,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check-js" && !arg.startsWith("--output="))) throw new Error("unknown inventory option");
  const inventory = await collectSourceInventory({ checkJavaScript: args.includes("--check-js") });
  const output = args.find((arg) => arg.startsWith("--output="))?.slice(9);
  if (output) {
    const target = resolve(output);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(inventory, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(inventory.summary)}\n`);
  } else process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  if (inventory.summary.syntaxFailed || inventory.summary.unavailable) process.exitCode = 1;
}
