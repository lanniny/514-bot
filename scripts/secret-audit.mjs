#!/usr/bin/env node
/**
 * 514cc 凭据审计器 —— 全仓历史扫描（F-052 凭据清单 / F-053 脱敏契约的外部验证）。
 *
 * 与 .githooks/pre-commit（F-004）的分工：
 *   钩子  = 提交闸门。只扫本次暂存的新增行，模式库刻意保持极小、误报率极低。
 *   本脚本 = 深度盘点。扫全仓历史，回答"从仓库建立至今，有没有密钥已经进去了"。
 *
 * 因此本脚本**不自己维护模式库**，而是从 .githooks/pre-commit 解析出 PATTERN /
 * PLACEHOLDER 复用——改钩子即改审计，杜绝两套标准各自漂移。
 *
 * 在此之上补一层钩子没有的能力：无前缀高熵随机串检测（见下方 OPAQUE 章节）。
 *
 * 用法：
 *   node scripts/secret-audit.mjs                  # 扫 git 追踪文件（默认；CI 用这个）
 *   node scripts/secret-audit.mjs --scope=worktree # 扫工作区全部（含未追踪，工作区体检用）
 *   node scripts/secret-audit.mjs --json           # 机器可读
 *   node scripts/secret-audit.mjs --no-entropy     # 只跑高置信模式
 *
 * 退出码：0 = 干净；1 = 命中；2 = 执行失败。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const HOOK_PATH = join(REPO_ROOT, ".githooks", "pre-commit");

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const useEntropy = !args.has("--no-entropy");
const scopeArg = [...args].find((arg) => arg.startsWith("--scope="));
const scope = scopeArg ? scopeArg.slice("--scope=".length) : "tracked";
if (!["tracked", "worktree"].includes(scope)) {
  console.error(`未知 scope：${scope}（可用：tracked | worktree）`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 1. 从 F-004 钩子复用模式库（单一事实来源）
// ---------------------------------------------------------------------------
const HOOK_PATTERN = /^PATTERN='(.*)'$/m;
const HOOK_PLACEHOLDER = /^PLACEHOLDER='(.*)'$/m;

function loadHookPatterns() {
  let source;
  try {
    source = readFileSync(HOOK_PATH, "utf8");
  } catch {
    return null;
  }
  const pattern = HOOK_PATTERN.exec(source)?.[1];
  const placeholder = HOOK_PLACEHOLDER.exec(source)?.[1];
  if (!pattern) return null;
  return {
    secret: new RegExp(pattern, "g"),
    placeholder: placeholder ? new RegExp(placeholder) : null,
  };
}

const hook = loadHookPatterns();
if (!hook) {
  console.error(`无法从 ${HOOK_PATH} 解析 PATTERN —— 审计拒绝降级运行。`);
  console.error("原则：宁可不扫，也不能用一个和闸门不一致的弱规则给出『干净』的结论。");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 2. 无前缀高熵随机串 —— 补钩子模式库的盲区
//
// 钩子（以及 redaction.mjs 的 6 条 secretPatterns）全靠**已知前缀**识别：
// sk- / AIza / AKIA / ghp_ / eyJ…。本仓真实出现过的 CC-Switch 代理令牌是
// `tEP1_` + 38 位随机串：43 字符、熵 4.94 bits/char、四字符集齐全。
// 只要它脱离 `token:` 这类键名上下文出现在日志行、PTY 回显、SSH stdout 里，
// 现有规则一条都认不出——除非前缀本身在名单里（tEP1_ 是事后才补进去的）。
// 本层不依赖前缀，改靠统计特征兜底这一类。
//
// 阈值必须能把凭据和最常见的两类高熵非秘密分开：
//   UUID / runId（36 字符，hex + 固定位连字符）  → 熵 ≈ 3.6，被 4.5 挡下
//   SHA-1/256 提交哈希（40/64 字符，纯 hex）      → 熵 ≤ 4.0，被 4.5 挡下
//   混合大小写是硬门槛：纯小写高熵串几乎都是哈希或 slug，不是凭据
//
// 已知的、必须显式排除的误报源：
//   npm lock 文件的 integrity 字段（sha512- + base64，熵 5.2+）——按文件排除
//   base64 图片 data URI / 压缩产物                            ——按长度与上下文排除
// ---------------------------------------------------------------------------
const ENTROPY_MIN_BITS_PER_CHAR = 4.5;
const ENTROPY_MIN_LENGTH = 32;
const OPAQUE_RUN = /[A-Za-z0-9_-]{32,}/g;

// 包管理锁文件的完整性哈希是设计上的高熵串，扫它只会产生数百条噪音
const ENTROPY_EXCLUDED_FILE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|npm-shrinkwrap\.json)$|\.min\.js$|\.js\.map$|\.css\.map$/;
const INTEGRITY_PREFIX = /^(?:sha1|sha256|sha384|sha512|md5)-/i;

function shannonEntropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function charClassCount(value) {
  let classes = 0;
  if (/[a-z]/.test(value)) classes += 1;
  if (/[A-Z]/.test(value)) classes += 1;
  if (/[0-9]/.test(value)) classes += 1;
  if (/[-_]/.test(value)) classes += 1;
  return classes;
}

function isOpaqueHighEntropy(value) {
  if (value.length < ENTROPY_MIN_LENGTH) return false;
  if (INTEGRITY_PREFIX.test(value)) return false;
  if (charClassCount(value) < 3) return false;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value)) return false;
  return shannonEntropy(value) >= ENTROPY_MIN_BITS_PER_CHAR;
}

// ---------------------------------------------------------------------------
// 3. 文件收集
// ---------------------------------------------------------------------------
const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|ico|bmp|svgz|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|zip|gz|tgz|bz2|7z|rar|pdf|rlib|rmeta|pdb|exe|dll|so|dylib|node|wasm|class|jar)$/i;
// 说明：前两行是常规的依赖/产物目录；后两行是 514cc 特有的大体积暂存区与
// npm 缓存——它们的命中量占了 worktree 模式的 99%，且本身已被 .gitignore 覆盖，
// 纳入扫描只会淹没真正的信号。tracked 模式不受此影响（git 不会追踪它们）。
const SKIP_DIR = new Set([
  "node_modules", ".git", ".workbuddy", "dist", "build", "coverage",
  ".cache", ".next", ".turbo", "__pycache__", "target",
  ".scratch", ".workflow", ".npm-cache", ".tmp",
]);
const MAX_FILE_BYTES = 8 << 20; // 更大的单文件交给人工，避免审计自身成为性能事故

function listTracked() {
  const stdout = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, maxBuffer: 1 << 28, encoding: "utf8" });
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function listWorktree(dir = REPO_ROOT, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      listWorktree(join(dir, entry.name), acc);
      continue;
    }
    if (entry.isFile()) acc.push(relative(REPO_ROOT, join(dir, entry.name)).replaceAll("\\", "/"));
  }
  return acc;
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/**
 * 行内豁免，与 .githooks/pre-commit 同一套记号（# gitleaks:allow）。
 * 两个工具对同一行给出一致结论，才不会出现"钩子放行、审计报警"或反之。
 * 豁免必须写在同一行——这样理由就紧贴着被豁免的内容，不会随代码漂移。
 */
function lineTextAt(text, index) {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end);
}

const ALLOW_MARKER = /gitleaks:allow/;

// ---------------------------------------------------------------------------
// 4. 扫描
// ---------------------------------------------------------------------------
function scanFile(relPath) {
  if (BINARY_EXT.test(relPath)) return [];
  let text;
  try {
    const stat = statSync(join(REPO_ROOT, relPath));
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];
    const buffer = readFileSync(join(REPO_ROOT, relPath));
    if (buffer.includes(0)) return []; // 二进制
    text = buffer.toString("utf8");
  } catch {
    return [];
  }

  const findings = [];

  // 4a. 钩子模式库（高置信）
  for (const match of text.matchAll(hook.secret)) {
    const candidate = match[0];
    if (hook.placeholder?.test(candidate)) continue;
    findings.push({
      kind: "known-pattern",
      reason: "命中 F-004 高置信密钥特征",
      sample: `${candidate.slice(0, 8)}…（长度 ${candidate.length}）`,
      index: match.index ?? 0,
    });
  }

  // 4b. 无前缀高熵（补盲区）
  if (useEntropy && !ENTROPY_EXCLUDED_FILE.test(relPath)) {
    for (const match of text.matchAll(OPAQUE_RUN)) {
      const candidate = match[0];
      if (hook.placeholder?.test(candidate)) continue;
      if (!isOpaqueHighEntropy(candidate)) continue;
      findings.push({
        kind: "high-entropy",
        reason: `无前缀高熵随机串（${candidate.length} 字符，${shannonEntropy(candidate).toFixed(2)} bits/char）`,
        sample: `${candidate.slice(0, 6)}…${candidate.slice(-3)}`,
        index: match.index ?? 0,
      });
    }
  }

  return findings
    .filter((finding) => !ALLOW_MARKER.test(lineTextAt(text, finding.index)))
    .map(({ index, ...finding }) => ({ ...finding, file: relPath, line: lineAt(text, index) }));
}

// ---------------------------------------------------------------------------
// 5. 主流程
// ---------------------------------------------------------------------------
const files = scope === "worktree" ? listWorktree() : listTracked();
const results = [];
for (const file of files) {
  try {
    results.push(...scanFile(file));
  } catch (error) {
    results.push({ file, line: 0, kind: "scan-error", reason: String(error?.message ?? error), sample: null });
  }
}

const trackedSet = new Set(scope === "tracked" ? files : listTracked());
const publicHits = results.filter((finding) => trackedSet.has(finding.file));

if (asJson) {
  console.log(JSON.stringify({ scope, scanned: files.length, findings: results }, null, 2));
} else {
  console.log(`514cc 凭据审计 · scope=${scope} · 文件 ${files.length} 个 · 命中 ${results.length} 处`);
  if (results.length) {
    console.log("");
    for (const finding of results) {
      console.log(`  ${finding.file}:${finding.line}`);
      console.log(`      ${finding.kind}: ${finding.reason}${finding.sample ? `  [${finding.sample}]` : ""}`);
    }
  }
  console.log("");
  if (publicHits.length) {
    console.log(`⚠️  ${publicHits.length} 处位于已追踪文件——会进入远端公开仓库。先轮换凭据，再清理历史。`);
  } else if (scope === "worktree") {
    console.log("已追踪文件干净。未追踪命中仅存在于本地工作区，不会被推送。");
  } else {
    console.log("干净。");
  }
}

process.exit(results.length ? 1 : 0);
