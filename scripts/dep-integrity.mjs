#!/usr/bin/env node
/**
 * 依赖完整性审计（F-051）
 *
 *   node scripts/dep-integrity.mjs                      # 默认：官方源 + 已登记镜像
 *   node scripts/dep-integrity.mjs --strict             # 只允许官方 registry
 *   node scripts/dep-integrity.mjs --allow-host=x.com   # 追加受信源（可重复）
 *   node scripts/dep-integrity.mjs --json
 *
 * 检查四件事：
 *   1. registry 来源 —— 包从哪儿下的。integrity 能防内容篡改，但防不住"整包被
 *      替换成一个自带合法哈希的恶意包"，所以 resolved 的 host 是独立的一道闸。
 *   2. integrity 缺失 —— 没有哈希的包等于完全无校验。
 *   3. 声明漂移 —— package.json 写了、lock 里没有，或反过来。
 *   4. lock 与 package.json 的版本一致性（仅精确版本可判，范围依赖交给 npm）。
 *
 * 退出码：0 干净 / 1 发现问题 / 2 无法运行（缺文件、解析失败）
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const OFFICIAL_REGISTRY = "registry.npmjs.org";

// 本仓现状：lock 里已存在 npmmirror 镜像源，默认认可，用 --strict 可收紧。
const DEFAULT_ALLOWED_HOSTS = new Set([OFFICIAL_REGISTRY, "registry.npmmirror.com"]);

const SKIP_DIR = new Set([
  "node_modules", ".git", ".workbuddy", "dist", "build", "coverage",
  ".cache", ".next", ".turbo", "__pycache__", "target", ".scratch", ".qa-output",
]);

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");

function parseAllowedHosts() {
  const hosts = new Set(strict ? [OFFICIAL_REGISTRY] : DEFAULT_ALLOWED_HOSTS);
  for (const arg of args) {
    if (!arg.startsWith("--allow-host=")) continue;
    const host = arg.slice("--allow-host=".length).trim();
    if (host) hosts.add(host);
  }
  return hosts;
}

// .npmrc 里配了 registry 就按它来——团队统一走私有源时不必改脚本
async function readNpmrcRegistry() {
  for (const path of [join(REPO_ROOT, ".npmrc"), join(REPO_ROOT, "apps", "control-center", ".npmrc")]) {
    if (!existsSync(path)) continue;
    const text = await readFile(path, "utf8");
    const match = text.match(/^\s*registry\s*=\s*(\S+)/m);
    if (!match) continue;
    try {
      return new URL(match[1]).host;
    } catch {
      return null;
    }
  }
  return null;
}

async function findWorkspaces() {
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === "package.json")) {
      const lockPath = join(dir, "package-lock.json");
      if (existsSync(lockPath)) found.push({ dir, lockPath, manifestPath: join(dir, "package.json") });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIR.has(entry.name)) continue;
      await walk(join(dir, entry.name));
    }
  }
  await walk(REPO_ROOT);
  return found;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`无法解析 ${relative(REPO_ROOT, path)}：${error.message}`);
  }
}

function collectDirectDeps(manifest) {
  const deps = new Map();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(manifest[field] || {})) {
      deps.set(name, { range, field });
    }
  }
  return deps;
}

function hostOf(resolved) {
  if (!resolved) return null;
  try {
    return new URL(resolved).host;
  } catch {
    return null;
  }
}

function auditWorkspace({ dir, lockPath, manifestPath }, allowedHosts) {
  const rel = relative(REPO_ROOT, dir) || ".";
  const manifest = JSON.parse(manifestRaw.get(manifestPath));
  const lock = JSON.parse(lockRaw.get(lockPath));

  const findings = [];
  const packages = lock.packages || {};
  const direct = collectDirectDeps(manifest);

  const hostCounts = new Map();
  let missingIntegrity = 0;

  for (const [key, entry] of Object.entries(packages)) {
    if (!key) continue; // "" 是根包自身，没有 resolved/integrity
    // link/workspace 包（如 file: 依赖）不来自 registry，跳过来源检查
    if (entry.link) continue;

    const host = hostOf(entry.resolved);
    if (host) hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
    if (host && !allowedHosts.has(host)) {
      findings.push({
        kind: "untrusted-registry",
        severity: "error",
        detail: `${key} 的下载地址来自未登记源 ${host}`,
      });
    }
    if (!entry.integrity) {
      missingIntegrity += 1;
      findings.push({
        kind: "missing-integrity",
        severity: "error",
        detail: `${key} 缺少 integrity，安装时无法校验内容`,
      });
    }
  }

  // 声明漂移：package.json 写了但 lock 里找不到对应条目
  for (const [name, { range, field }] of direct) {
    const entry = packages[`node_modules/${name}`];
    if (!entry) {
      findings.push({
        kind: "declared-but-unlocked",
        severity: "error",
        detail: `${field}.${name}@${range} 在 lock 中无对应条目（改了 package.json 未更新 lock？）`,
      });
      continue;
    }
    // 精确版本声明必须与 lock 完全一致；范围声明交给 npm，这里不越权判断
    if (!/^[\^~><=*\s]/.test(range) && !range.includes("||") && entry.version !== range) {
      findings.push({
        kind: "version-mismatch",
        severity: "error",
        detail: `${name} 声明 ${range}，lock 中却是 ${entry.version}`,
      });
    }
  }

  const hosts = [...hostCounts.entries()].sort((a, b) => b[1] - a[1]);
  return {
    workspace: rel,
    packages: Object.keys(packages).length - 1,
    hosts: hosts.map(([host, count]) => ({ host, count, trusted: allowedHosts.has(host) })),
    mixedRegistry: hosts.length > 1,
    missingIntegrity,
    findings,
  };
}

// 预读，避免在 audit 里混异步
const manifestRaw = new Map();
const lockRaw = new Map();

async function main() {
  const allowedHosts = parseAllowedHosts();
  const npmrcHost = await readNpmrcRegistry();
  if (npmrcHost && !strict) allowedHosts.add(npmrcHost);

  const workspaces = await findWorkspaces();
  if (!workspaces.length) {
    console.error("未找到任何带 package-lock.json 的工作区");
    process.exit(2);
  }

  for (const ws of workspaces) {
    manifestRaw.set(ws.manifestPath, await readFile(ws.manifestPath, "utf8"));
    lockRaw.set(ws.lockPath, await readFile(ws.lockPath, "utf8"));
  }

  let results;
  try {
    results = workspaces.map((ws) => auditWorkspace(ws, allowedHosts));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  const totalFindings = results.reduce((sum, r) => sum + r.findings.length, 0);
  const mixed = results.filter((r) => r.mixedRegistry);

  if (asJson) {
    console.log(JSON.stringify({ allowedHosts: [...allowedHosts], results, totalFindings }, null, 2));
    process.exit(totalFindings ? 1 : 0);
  }

  console.log(`514cc 依赖完整性 · 工作区 ${results.length} 个 · 受信源 ${[...allowedHosts].join(", ")}`);
  for (const r of results) {
    console.log(`\n  ${r.workspace}  (${r.packages} 个包)`);
    for (const h of r.hosts) {
      console.log(`    来源 ${h.trusted ? "✓" : "✗"} ${h.host}  ${h.count} 个包`);
    }
    if (r.mixedRegistry) {
      console.log("    ⚠ 混合 registry：同一 lock 里存在多个下载源，环境不一致时难以复现");
    }
    for (const f of r.findings) console.log(`    [${f.kind}] ${f.detail}`);
  }

  if (totalFindings) {
    console.log(`\n发现 ${totalFindings} 处问题。`);
  } else if (mixed.length) {
    console.log(`\n无完整性缺陷，但 ${mixed.length} 个工作区存在混合 registry（已登记的源，非错误）。`);
  } else {
    console.log("\n干净。");
  }
  process.exit(totalFindings ? 1 : 0);
}

await main();
