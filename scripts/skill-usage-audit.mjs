#!/usr/bin/env node
/**
 * F-073 skill 使用度盘点。
 *
 * 扫描所有 skill 的实际调用频率，识别零调用 skill 并给出处置建议。
 *
 * 用法：
 *   node scripts/skill-usage-audit.mjs [--days N]
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const HANDOFF_DIR = join(import.meta.dirname, "..", ".ai-shared", "handoff");
const ROUTE_GATE_LOG = join(import.meta.dirname, "..", ".ai-shared", "route-gate.log");
const MODULE_YAML = join(import.meta.dirname, "..", "module.yaml");

async function loadSkillsFromModuleYaml() {
  let content;
  try {
    content = await readFile(MODULE_YAML, "utf8");
  } catch {
    return [];
  }

  const skills = [];
  const seen = new Set();
  const matches = content.match(/- code: (.+)/g);
  if (matches) {
    for (const match of matches) {
      const name = match.replace("- code: ", "").trim();
      if (!seen.has(name)) {
        seen.add(name);
        skills.push({ name, registered: true });
      }
    }
  }

  return skills;
}

async function scanHandoffReferences(skills) {
  const files = await readdir(HANDOFF_DIR);
  const mdFiles = files.filter(f => f.endsWith(".md"));

  const usageCount = {};
  for (const skill of skills) {
    usageCount[skill.name] = 0;
  }

  for (const file of mdFiles) {
    const path = join(HANDOFF_DIR, file);
    let content;
    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }

    for (const skill of skills) {
      // 匹配 skill 引用模式：/skill-name, skill-name, 或提到 skill 名
      const regex = new RegExp(`\\b${skill.name}\\b`, "i");
      if (regex.test(content)) {
        usageCount[skill.name]++;
      }
    }
  }

  return usageCount;
}

async function scanRouteGateLog() {
  let content;
  try {
    content = await readFile(ROUTE_GATE_LOG, "utf8");
  } catch {
    return {};
  }

  const routeHits = {};
  const lines = content.split("\n");

  for (const line of lines) {
    // 提取路由命中信息（简化：统计 RED/gray 分布）
    if (line.includes("RED") || line.includes("gray")) {
      const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        const date = dateMatch[1];
        routeHits[date] = (routeHits[date] || 0) + 1;
      }
    }
  }

  return routeHits;
}

function getDaysSince(dateStr) {
  const parsed = Date.parse(dateStr);
  if (!Number.isFinite(parsed)) return Infinity;
  return Math.floor((Date.now() - parsed) / 86_400_000);
}

function getSuggestion(skill, handoffRefs, daysSinceLastCall) {
  if (handoffRefs === 0) {
    if (daysSinceLastCall > 60 || daysSinceLastCall === Infinity) {
      return "退场（零调用且注册超60天）";
    }
    return "观察（新注册或近期刚注册）";
  }
  if (handoffRefs < 3) {
    return "合并候选（低频调用，检查功能重叠）";
  }
  return "保留";
}

async function main() {
  const daysThreshold = Number(process.argv[2]) || 90;

  console.log("F-073 skill 使用度盘点");
  console.log(`陈旧阈值：${daysThreshold} 天`);
  console.log();

  // 加载已注册 skill
  const skills = await loadSkillsFromModuleYaml();
  console.log(`已注册 skill 数量：${skills.length}`);
  console.log();

  // 扫描 handoff 引用
  const usageCount = await scanHandoffReferences(skills);

  // 扫描 route-gate 日志
  const routeHits = await scanRouteGateLog();
  const totalRouteHits = Object.values(routeHits).reduce((a, b) => a + b, 0);

  // 构建排名表
  const table = skills.map(skill => {
    const refs = usageCount[skill.name] || 0;
    const suggestion = getSuggestion(skill, refs, Infinity); // 简化：暂不追踪最后调用时间
    return {
      name: skill.name,
      handoffRefs: refs,
      suggestion,
    };
  });

  // 按引用数排序
  table.sort((a, b) => b.handoffRefs - a.handoffRefs);

  // 输出表格
  console.log("## Skill 使用度排名");
  console.log();
  console.log("| Skill 名 | handoff引用 | 建议 |");
  console.log("|----------|------------|------|");
  for (const row of table) {
    console.log(`| ${row.name} | ${row.handoffRefs} | ${row.suggestion} |`);
  }

  console.log();
  console.log("## 路由统计");
  console.log(`route-gate.log 总命中：${totalRouteHits}`);
  console.log(`活跃日期数：${Object.keys(routeHits).length}`);

  // 零调用 skill
  const zeroUsage = table.filter(r => r.handoffRefs === 0);
  if (zeroUsage.length > 0) {
    console.log();
    console.log(`## 零调用 skill（${zeroUsage.length} 个）`);
    for (const skill of zeroUsage) {
      console.log(`  - ${skill.name}`);
    }
  }

  // 低频 skill
  const lowUsage = table.filter(r => r.handoffRefs > 0 && r.handoffRefs < 3);
  if (lowUsage.length > 0) {
    console.log();
    console.log(`## 低频 skill（<3次，${lowUsage.length} 个）`);
    for (const skill of lowUsage) {
      console.log(`  - ${skill.name} (${skill.handoffRefs} 次)`);
    }
  }
}

main();
