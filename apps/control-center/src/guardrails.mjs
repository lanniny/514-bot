/**
 * W3.7 Guardrails 测试器：读取仓库 guardrails/deny-paths.txt，输入路径实时判定
 * 会被哪条守卫规则命中。改权限/动文件前自测用，不替代运行时守卫。
 *
 * 匹配语义对齐 deny-paths.txt 头注：路径前缀匹配（开头匹配即拒）、~ 展开为用户
 * 主目录、支持 * 通配与 ** 深层通配。Windows 反斜杠归一为斜杠后比对；
 * 判定偏保守（deny-biased）：目录前缀与 glob 命中任一即拒。
 */

import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DENY_PATHS_RELATIVE = join("guardrails", "deny-paths.txt");
const MAX_TEST_PATH_LENGTH = 1024;

function normalizeSlashes(value) {
  return String(value ?? "").replace(/\\/g, "/").trim();
}

export function expandHome(pattern, home = homedir()) {
  const clean = normalizeSlashes(pattern);
  if (clean === "~") return normalizeSlashes(home);
  if (clean.startsWith("~/")) return `${normalizeSlashes(home)}/${clean.slice(2)}`;
  return clean;
}

export function globToRegExp(pattern) {
  const expanded = expandHome(pattern);
  // 尾缀 `/**`：目录本身与其下一切都拒（保守语义，防止 /var/lib 本体漏网）
  const trailingDeepGlob = expanded.endsWith("/**") ? expanded.slice(0, -3) : null;
  const source = trailingDeepGlob ?? expanded;
  let regex = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "*") {
      if (source[index + 1] === "*") {
        // `**/` 允许零层目录；其余 `**` 吞任意深度
        if (source[index + 2] === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index += 1;
        }
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${regex}(?:/.*)?$`, "i");
}

export function parseDenyPaths(content, home = homedir()) {
  const rules = [];
  for (const rawLine of String(content ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (!line.includes("*") && !line.includes("?")) {
      rules.push({ kind: "prefix", pattern: expandHome(line, home) });
    } else {
      rules.push({ kind: "glob", pattern: expandHome(line, home) });
    }
  }
  return rules;
}

export function createGuardrailsService({ repoRoot, home = homedir(), readFileImpl = readFile } = {}) {
  if (!repoRoot) throw new TypeError("guardrails service needs repoRoot");

  async function loadRulesOrNull() {
    try {
      return await readFileImpl(join(repoRoot, DENY_PATHS_RELATIVE), "utf8");
    } catch {
      // deny-paths.txt 缺失/不可读（如最小化部署或隔离 QA 仓）：如实降级为"不可判定"，
      // 绝不假装规则为空（那等于把未知当安全）
      return null;
    }
  }

  async function rules() {
    const content = await loadRulesOrNull();
    if (content == null) {
      return { available: false, source: DENY_PATHS_RELATIVE.replace(/\\/g, "/"), count: 0, rules: [] };
    }
    const parsed = parseDenyPaths(content, home);
    return { available: true, source: DENY_PATHS_RELATIVE.replace(/\\/g, "/"), count: parsed.length, rules: parsed };
  }

  async function testPath(inputPath) {
    const candidate = normalizeSlashes(inputPath);
    if (!candidate) {
      throw Object.assign(new Error("path is required"), { code: "VALIDATION_FAILED" });
    }
    if (candidate.length > MAX_TEST_PATH_LENGTH) {
      throw Object.assign(new Error("path exceeds length limit"), { code: "VALIDATION_FAILED" });
    }
    const content = await loadRulesOrNull();
    if (content == null) {
      return {
        path: candidate,
        home: normalizeSlashes(home),
        available: false,
        denied: null,
        reason: `guardrails/deny-paths.txt 不可读——无法判定（deny-biased：未知≠安全）`,
        matchedRules: [],
        evaluatedRules: 0,
      };
    }
    const parsed = parseDenyPaths(content, home);
    const hits = [];
    for (const rule of parsed) {
      if (rule.kind === "prefix") {
        const base = rule.pattern.endsWith("/") ? rule.pattern : `${rule.pattern}/`;
        if (candidate === rule.pattern || candidate.startsWith(base) || candidate.startsWith(rule.pattern)) {
          hits.push(rule);
        }
      } else if (globToRegExp(rule.pattern).test(candidate)) {
        hits.push(rule);
      }
    }
    return {
      path: candidate,
      home: normalizeSlashes(home),
      available: true,
      denied: hits.length > 0,
      matchedRules: hits,
      evaluatedRules: parsed.length,
    };
  }

  return Object.freeze({ rules, testPath });
}
