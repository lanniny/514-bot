#!/usr/bin/env node
/**
 * F-075 stop-gate 等价性校验（治理收口 W3）。
 *
 * 比较 Claude (.claude/hooks/stop-gate.py) 和 Codex (.codex/hooks/stop-gate-codex.py)
 * 的 stop-gate 脚本，确保核心治理契约保持一致。
 *
 * 检查项：
 *   1. 常量等价 — WORKSPACE_ANCHOR, FRESH_WINDOW_SEC 等
 *   2. 正则等价 — DELTA_LINE_RE, SESSION_MARKER_RE 等
 *   3. 函数签名等价 — find_aishared, load_handoff_sources 等核心函数
 *   4. 关键行为 — fail-open 策略、loop prevention
 *
 * 退出码：
 *   0 = 等价（核心契约一致）
 *   1 = 有差异（需人工确认是否预期）
 *   2 = 无法比较（文件缺失等）
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CLAUDE_HOOK = resolve(ROOT, ".claude/hooks/stop-gate.py");
const CODEX_HOOK = resolve(ROOT, ".codex/hooks/stop-gate-codex.py");

// 必须等价的常量
const REQUIRED_CONSTANTS = [
  "WORKSPACE_ANCHOR",
  "FRESH_WINDOW_SEC",
  "TRANSCRIPT_SCAN_BYTES",
  "TRANSCRIPT_SCAN_LINES",
];

// 必须等价的正则（提取 pattern 字符串比较）
const REQUIRED_PATTERNS = [
  "DELTA_LINE_RE",
  "DELTA_TOKEN_RE",
  "SESSION_MARKER_RE",
  "SOURCE_ID_RE",
  "PREFIX_RE",
  "SESSION_ID_RE",
];

// 必须存在的核心函数
const REQUIRED_FUNCTIONS = [
  "find_aishared",
  "load_handoff_sources",
];

function extractConstant(source, name) {
  // 匹配 Python 赋值：NAME = value
  const pattern = new RegExp(`^${name}\\s*=\\s*(.+)$`, "m");
  const match = source.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function extractRegexPattern(source, name) {
  // 匹配 re.compile(r"...", ...) 或 re.compile("...", ...)
  // 处理跨行的情况
  const startPattern = new RegExp(`${name}\\s*=\\s*re\\.compile\\(\\s*r?"`, "m");
  const startMatch = source.match(startPattern);
  if (!startMatch) return null;

  const startIdx = startMatch.index + startMatch[0].length;
  // 找到结束的未转义引号
  let i = startIdx;
  while (i < source.length) {
    if (source[i] === '"' && source[i - 1] !== "\\") break;
    i++;
  }
  return source.slice(startIdx, i);
}

function extractFunctionSignature(source, name) {
  // 匹配 def func_name(...):
  const pattern = new RegExp(`def\\s+${name}\\s*\\(([^)]*)\\)`, "m");
  const match = source.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function hasFeature(source, feature) {
  switch (feature) {
    case "fail_open_on_error":
      return /except.*:\s*\n\s*(sys\.exit\(0\)|return)/.test(source) ||
             /allow.*stop/i.test(source) ||
             /fail.?open/i.test(source);
    case "loop_prevention":
      return /fingerprint|loop.?prev|already.?block/i.test(source);
    case "session_marker":
      return /session.?id|SESSION_MARKER/i.test(source);
    case "delta_validation":
      return /DELTA_LINE_RE|delta.*score|__DELTA__/i.test(source);
    case "handoff_source_registry":
      return /handoff.?source|HANDOFF_SOURCE_REGISTRY/i.test(source);
    default:
      return false;
  }
}

async function main() {
  let claudeSrc, codexSrc;
  try {
    [claudeSrc, codexSrc] = await Promise.all([
      readFile(CLAUDE_HOOK, "utf8"),
      readFile(CODEX_HOOK, "utf8"),
    ]);
  } catch (error) {
    console.error(`Cannot read hook files: ${error.message}`);
    process.exit(2);
  }

  const issues = [];
  const notes = [];

  // 1. 常量比较
  for (const name of REQUIRED_CONSTANTS) {
    const claudeVal = extractConstant(claudeSrc, name);
    const codexVal = extractConstant(codexSrc, name);
    if (claudeVal === null && codexVal === null) {
      notes.push(`CONST ${name}: not found in either (may not be required)`);
    } else if (claudeVal === null) {
      notes.push(`CONST ${name}: only in Codex (${codexVal})`);
    } else if (codexVal === null) {
      notes.push(`CONST ${name}: only in Claude (${claudeVal})`);
    } else if (claudeVal !== codexVal) {
      issues.push(`CONST ${name}: Claude=${claudeVal} vs Codex=${codexVal}`);
    } else {
      notes.push(`CONST ${name}: ✓ (${claudeVal})`);
    }
  }

  // 2. 正则比较
  for (const name of REQUIRED_PATTERNS) {
    const claudePattern = extractRegexPattern(claudeSrc, name);
    const codexPattern = extractRegexPattern(codexSrc, name);
    if (claudePattern === null && codexPattern === null) {
      issues.push(`REGEX ${name}: not found in either script`);
    } else if (claudePattern === null) {
      notes.push(`REGEX ${name}: only in Codex`);
    } else if (codexPattern === null) {
      notes.push(`REGEX ${name}: only in Claude`);
    } else if (claudePattern !== codexPattern) {
      issues.push(`REGEX ${name}: patterns differ`);
    } else {
      notes.push(`REGEX ${name}: ✓`);
    }
  }

  // 3. 函数签名比较
  for (const name of REQUIRED_FUNCTIONS) {
    const claudeSig = extractFunctionSignature(claudeSrc, name);
    const codexSig = extractFunctionSignature(codexSrc, name);
    if (claudeSig === null && codexSig === null) {
      issues.push(`FUNC ${name}: not found in either script`);
    } else if (claudeSig === null) {
      notes.push(`FUNC ${name}: only in Codex`);
    } else if (codexSig === null) {
      notes.push(`FUNC ${name}: only in Claude`);
    } else {
      // 比较时忽略空白
      const normalize = (s) => s.replace(/\s+/g, "");
      if (normalize(claudeSig) !== normalize(codexSig)) {
        notes.push(`FUNC ${name}: signatures differ (Claude: (${claudeSig}) vs Codex: (${codexSig}))`);
      } else {
        notes.push(`FUNC ${name}: ✓`);
      }
    }
  }

  // 4. 关键行为检查
  const features = ["fail_open_on_error", "loop_prevention", "session_marker", "delta_validation", "handoff_source_registry"];
  for (const feature of features) {
    const claudeHas = hasFeature(claudeSrc, feature);
    const codexHas = hasFeature(codexSrc, feature);
    if (claudeHas && codexHas) {
      notes.push(`FEATURE ${feature}: ✓ (both)`);
    } else if (claudeHas && !codexHas) {
      notes.push(`FEATURE ${feature}: Claude only (Codex may not need it)`);
    } else if (!claudeHas && codexHas) {
      notes.push(`FEATURE ${feature}: Codex only (Claude may not need it)`);
    } else {
      issues.push(`FEATURE ${feature}: missing from both`);
    }
  }

  // 5. 规模差异（信息性）
  const claudeLines = claudeSrc.split("\n").length;
  const codexLines = codexSrc.split("\n").length;

  // 输出
  console.log(`stop-gate equivalence check`);
  console.log(`Claude: ${CLAUDE_HOOK} (${claudeLines} lines)`);
  console.log(`Codex:  ${CODEX_HOOK} (${codexLines} lines)`);
  console.log();

  if (issues.length > 0) {
    console.log(`ISSUES (${issues.length}):`);
    for (const i of issues) console.log(`  ✗ ${i}`);
    console.log();
  }

  console.log(`NOTES (${notes.length}):`);
  for (const n of notes) console.log(`  · ${n}`);
  console.log();

  if (issues.length === 0) {
    console.log("✓ Core governance contract is equivalent between Claude and Codex");
    process.exit(0);
  } else {
    console.log(`⚠ ${issues.length} issue(s) found — review whether differences are intentional`);
    process.exit(1);
  }
}

main();
