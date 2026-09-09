import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDefaultControlConfig } from "../src/default-config.mjs";
import { installOfficialNode } from "./portable-node.mjs";

const execFileAsync = promisify(execFile);
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(appRoot, "../..");

export async function copyRuntimeTree(source, target) {
  const entry = await lstat(source);
  if (entry.isSymbolicLink()) throw new Error("runtime resources must not contain symbolic links");
  if (entry.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const child of await readdir(source)) await copyRuntimeTree(resolve(source, child), resolve(target, child));
  } else if (entry.isFile()) {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target, constants.COPYFILE_EXCL);
  } else throw new Error("unsupported runtime resource type");
}

export async function fingerprintTree(root) {
  const files = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = resolve(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error("runtime manifest cannot attest symbolic links");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        files.push({ path: relative(root, path).replaceAll("\\", "/"), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function buildPortable({ outputDir, desktopExe, nodeBinary = null, installDependencies = true } = {}) {
  if (process.platform !== "win32") throw new Error("portable staging currently supports Windows only");
  if (!outputDir || !desktopExe) throw new Error("--output and --desktop-exe are required");
  const root = resolve(outputDir);
  const exe = resolve(desktopExe);
  const node = nodeBinary ? resolve(nodeBinary) : null;
  await access(exe);
  if (node) await access(node);
  const desktopSha256 = createHash("sha256").update(await readFile(exe)).digest("hex");
  // A new directory is the output boundary. Existing bundles are never replaced.
  await mkdir(root);
  const kernel = resolve(root, "resources/control-center");
  const seed = resolve(root, "resources/seed");
  await mkdir(kernel, { recursive: true });
  await mkdir(resolve(root, "runtime"));
  await copyFile(exe, resolve(root, "514 Bot.exe"), constants.COPYFILE_EXCL);
  let nodeProvenance;
  if (node) {
    const localLicense = resolve(dirname(node), "LICENSE");
    await access(localLicense);
    await copyFile(node, resolve(root, "runtime/node.exe"), constants.COPYFILE_EXCL);
    await copyRuntimeTree(localLicense, resolve(root, "runtime/LICENSE"));
    nodeProvenance = { source: "explicit local Node runtime with license" };
  } else {
    nodeProvenance = await installOfficialNode(resolve(root, "runtime"));
  }
  for (const name of ["src", "public", "scripts", "vendor", "server.mjs", "package.json", "package-lock.json"]) {
    await copyRuntimeTree(resolve(appRoot, name), resolve(kernel, name));
  }
  for (const [path, content] of Object.entries(createDefaultControlConfig())) {
    const target = resolve(seed, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { flag: "wx" });
  }
  await copyRuntimeTree(resolve(repoRoot, "schemas/control-center"), resolve(kernel, "schemas/control-center"));
  if (installDependencies) {
    const npmCli = process.env.npm_execpath || resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    await access(npmCli);
    await execFileAsync(process.execPath, [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org"], {
      cwd: kernel, windowsHide: true, timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    });
    await execFileAsync(resolve(root, "runtime/node.exe"), ["-e", "require('node-pty');require('pptxgenjs');require('exceljs');require('ajv/dist/2020.js')"], {
      cwd: kernel, windowsHide: true, timeout: 15_000,
    });
  }
  const { stdout: nodeVersion } = await execFileAsync(resolve(root, "runtime/node.exe"), ["--version"], { windowsHide: true });
  for (const path of [exe, resolve(root, "514 Bot.exe")]) {
    if (createHash("sha256").update(await readFile(path)).digest("hex") !== desktopSha256) {
      throw new Error("desktop executable changed during staging; wait for the build to finish");
    }
  }
  const manifest = {
    schema: "514cc.portable/v1", platform: "win32", arch: process.arch,
    nodeVersion: nodeVersion.trim(), formalRelease: false, signed: false,
    desktopSha256,
    nodeProvenance,
    prerequisite: "Windows with WebView2; AI CLIs and advanced Python-based tooling are user-installed.",
    files: await fingerprintTree(root),
  };
  await writeFile(resolve(root, "514cc-bundle.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return { root, executable: resolve(root, "514 Bot.exe"), files: manifest.files.length, nodeVersion: manifest.nodeVersion };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--output=")) options.outputDir = arg.slice(9);
    else if (arg.startsWith("--desktop-exe=")) options.desktopExe = arg.slice(14);
    else if (arg.startsWith("--node=")) options.nodeBinary = arg.slice(7);
    else throw new Error(`unknown portable option: ${arg}`);
  }
  process.stdout.write(`${JSON.stringify(await buildPortable(options))}\n`);
}
