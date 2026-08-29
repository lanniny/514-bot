#!/usr/bin/env node
/**
 * F-072 DELTA 手动标注辅助工具。
 * 
 * 读取未分类 DELTA 条目，根据文件名和证据内容智能推荐 category。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";

const HANDOFF_DIR = join(import.meta.dirname, "..", ".ai-shared", "handoff");

// 基于文件名的启发式分类
const FILENAME_PATTERNS = {
  governance: ["context", "decisions", "roster", "handoff", "rules", "module", "skill", "audit", "governance"],
  security: ["security", "ssrf", "auth", "token", "key", "secret", "csp", "sandbox", "egress"],
  performance: ["perf", "performance", "memory", "startup", "bundle", "minify", "volume", "size"],
  correctness: ["bug", "fix", "test", "regression", "correctness", "boundary", "validation"],
  architecture: ["architecture", "refactor", "decouple", "modular", "split", "esm", "esbuild", "dependency"],
  observability: ["observability", "log", "monitor", "backup", "capacity", "quota", "trace", "drill"],
};

// 基于证据关键词的分类
const EVIDENCE_KEYWORDS = {
  governance: ["team.*setting", "roster", "context\\.md", "decisions\\.md", "handoff", "skill.*usage", "route.*gate", "stop.*gate", "DELTA", "RFC"],
  security: ["ssrf", "egress.*guard", "token", "密钥", "鉴权", "越权", "注入", "CSP", "sandbox"],
  performance: ["内存", "启动", "体积", "bundle", "minify", "首屏", "性能"],
  correctness: ["测试", "边界", "校验", "修复", "bug", "regression", "断言"],
  architecture: ["解耦", "模块", "依赖", "重构", "拆分", "ESM", "esbuild", "orchestrator", "providers"],
  observability: ["日志", "监控", "备份", "容量", "quota", "drill", "trace", "崩溃"],
};

async function categorizeByFilename(filename) {
  const lower = filename.toLowerCase();
  
  for (const [category, patterns] of Object.entries(FILENAME_PATTERNS)) {
    if (patterns.some(p => lower.includes(p))) {
      return category;
    }
  }
  
  return null;
}

async function categorizeByEvidence(evidence) {
  const lower = evidence.toLowerCase();
  
  for (const [category, patterns] of Object.entries(EVIDENCE_KEYWORDS)) {
    if (patterns.some(p => new RegExp(p, "i").test(lower))) {
      return category;
    }
  }
  
  return null;
}

async function scanAndCategorize() {
  const files = await import("node:fs/promises").then(fs => fs.readdir(HANDOFF_DIR));
  const mdFiles = files.filter(f => f.endsWith(".md"));
  
  let processed = 0;
  let skipped = 0;
  
  for (const file of mdFiles) {
    const path = join(HANDOFF_DIR, file);
    let content;
    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }
    
    const lines = content.split("\n");
    let modified = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("__DELTA__:")) continue;
      
      // 检查是否已有 category（新格式）
      const newFormatMatch = line.match(/^__DELTA__:\s*([^\s|]+)\s*\|\s*([012])\s*\|\s*([^\s|]+)\s*\|\s*(.+)$/);
      if (newFormatMatch && newFormatMatch[3].trim()) {
        continue; // 已有 category，跳过
      }
      
      // 旧格式：__DELTA__: agent | score | evidence
      const legacyMatch = line.match(/^__DELTA__:\s*([^\s|]+)\s*\|\s*([012])\s*\|\s*(.+)$/);
      if (!legacyMatch) continue;
      
      const [, agent, score, evidence] = legacyMatch;
      
      // 智能分类
      let category = await categorizeByFilename(file);
      if (!category) {
        category = await categorizeByEvidence(evidence);
      }
      
      if (!category) {
        skipped++;
        continue;
      }
      
      // 替换为新格式
      const oldLine = `__DELTA__: ${agent} | ${score} | ${evidence}`;
      const newLine = `__DELTA__: ${agent} | ${score} | ${category} | ${evidence}`;
      
      content = content.replace(oldLine, newLine);
      modified = true;
      processed++;
    }
    
    if (modified) {
      await writeFile(path, content, "utf8");
    }
  }
  
  console.log(`智能补标完成：${processed} 条`);
  console.log(`无法自动分类：${skipped} 条`);
}

scanAndCategorize();
