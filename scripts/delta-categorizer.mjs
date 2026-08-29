#!/usr/bin/env node
/**
 * F-072 DELTA 账本类别标注工具。
 *
 * 交互式 CLI，扫描 handoff/ 中的 __DELTA__ 行，为未分类条目补上 category。
 *
 * 用法：
 *   node scripts/delta-categorizer.mjs [--dry-run]
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CATEGORIES = [
  "security",      // 安全相关（SSRF/注入/越权/密钥）
  "performance",   // 性能优化（首屏/内存/启动速度）
  "correctness",   // 正确性修复（bug fix/边界检查）
  "architecture",  // 架构改进（解耦/模块化/依赖治理）
  "governance",    // 治理收口（rules/context/decisions/handoff）
  "observability", // 观测运维（日志/监控/备份/容量）
];

const DELTA_NEW_RE = /^__DELTA__:\s*([^\s|]+)\s*\|\s*([012])\s*\|\s*([^\s|]*)\s*\|\s*(.+)$/;
const DELTA_LEGACY_RE = /^__DELTA__:\s*([^\s|]+)\s*\|\s*([012])\s*\|\s*(.+)$/;

async function scanHandoff(dir) {
  const files = await readdir(dir);
  const mdFiles = files.filter(f => f.endsWith(".md"));
  const uncategorized = [];

  for (const file of mdFiles) {
    const path = join(dir, file);
    let content;
    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("__DELTA__:")) continue;

      const newMatch = DELTA_NEW_RE.exec(line);
      if (newMatch) {
        const [, agent, score, category, evidence] = newMatch;
        if (!category || category.trim() === "") {
          uncategorized.push({ file, lineNum: i + 1, agent, score, evidence, category: "" });
        }
        continue;
      }

      const legacyMatch = DELTA_LEGACY_RE.exec(line);
      if (legacyMatch) {
        const [, agent, score, evidence] = legacyMatch;
        uncategorized.push({ file, lineNum: i + 1, agent, score, evidence, category: "", isLegacy: true });
      }
    }
  }

  return uncategorized;
}

function formatEntry(entry) {
  const prefix = entry.isLegacy ? "[旧格式]" : "[新格式]";
  return `${prefix} ${entry.file}:${entry.lineNum} | ${entry.agent} | ${entry.score} | ${entry.evidence.slice(0, 60)}...`;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const handoffDir = join(import.meta.dirname, "..", ".ai-shared", "handoff");

  console.log("F-072 DELTA 账本类别标注工具");
  console.log(`模式：${dryRun ? "DRY RUN" : "实际执行"}`);
  console.log();

  const uncategorized = await scanHandoff(handoffDir);
  console.log(`发现 ${uncategorized.length} 个未分类 DELTA 条目`);
  console.log();

  if (uncategorized.length === 0) {
    console.log("✓ 所有 DELTA 条目已分类");
    return;
  }

  if (dryRun) {
    console.log("## DRY RUN - 不会修改任何文件");
    console.log();
    console.log("未分类条目预览（前 10 条）：");
    for (const entry of uncategorized.slice(0, 10)) {
      console.log(`  ${formatEntry(entry)}`);
    }
    if (uncategorized.length > 10) {
      console.log(`  ... 还有 ${uncategorized.length - 10} 条`);
    }
    return;
  }

  // 交互式标注（简化版：自动按证据关键词分类）
  console.log("开始自动分类（基于证据关键词匹配）...");
  console.log();

  const keywordMap = {
    security: ["ssrf", "注入", "越权", "密钥", "token", "csp", "egress", "sandbox"],
    performance: ["性能", "首屏", "内存", "启动", "体积", "bundle", "minify"],
    correctness: ["bug", "修复", "边界", "校验", "测试失败", "regression"],
    architecture: ["解耦", "模块", "依赖", "重构", "拆分", "esbuild", "esm"],
    governance: ["rules", "context", "decisions", "handoff", "roster", "归档"],
    observability: ["日志", "监控", "备份", "容量", "quota", "drill", "trace"],
  };

  let categorized = 0;
  let manualNeeded = 0;

  for (const entry of uncategorized) {
    const evidenceLower = entry.evidence.toLowerCase();
    let matchedCategory = null;

    for (const [cat, keywords] of Object.entries(keywordMap)) {
      if (keywords.some(kw => evidenceLower.includes(kw))) {
        matchedCategory = cat;
        break;
      }
    }

    if (matchedCategory) {
      const oldLine = entry.isLegacy
        ? `__DELTA__: ${entry.agent} | ${entry.score} | ${entry.evidence}`
        : `__DELTA__: ${entry.agent} | ${entry.score} |  | ${entry.evidence}`;
      const newLine = `__DELTA__: ${entry.agent} | ${entry.score} | ${matchedCategory} | ${entry.evidence}`;

      const filePath = join(handoffDir, entry.file);
      let content = await readFile(filePath, "utf8");
      content = content.replace(oldLine, newLine);
      await writeFile(filePath, content, "utf8");

      console.log(`✓ ${entry.file}:${entry.lineNum} → ${matchedCategory}`);
      categorized++;
    } else {
      console.log(`? ${entry.file}:${entry.lineNum} （需手动标注）`);
      manualNeeded++;
    }
  }

  console.log();
  console.log(`## 摘要`);
  console.log(`自动分类：${categorized}`);
  console.log(`需手动标注：${manualNeeded}`);
  console.log();
  console.log("提示：剩余未分类条目可手动编辑 handoff 文件，在 score 后添加 category 字段");
}

main();
