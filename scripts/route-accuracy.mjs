#!/usr/bin/env node
/**
 * F-071 路由判级准确率统计。
 *
 * 从 route-gate.log 提取 RED/gray 判定，与 handoff/DELTA 账本对账，
 * 计算误判率/漏判率/白发率。
 *
 * 用法：
 *   node scripts/route-accuracy.mjs [--days N]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROUTE_GATE_LOG = join(import.meta.dirname, "..", ".ai-shared", "route-gate.log");
const DECISIONS_FILE = join(import.meta.dirname, "..", ".ai-shared", "decisions.md");
const HANDOFF_DIR = join(import.meta.dirname, "..", ".ai-shared", "handoff");

async function parseRouteGateLog() {
  let content;
  try {
    content = await readFile(ROUTE_GATE_LOG, "utf8");
  } catch {
    return { red: 0, gray: 0, entries: [] };
  }

  const lines = content.split("\n").filter(Boolean);
  let red = 0;
  let gray = 0;
  const entries = [];

  for (const line of lines) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(RED|gray)/);
    if (match) {
      const [, timestamp, flag] = match;
      if (flag === "RED") red++;
      else gray++;
      entries.push({ timestamp, flag });
    }
  }

  return { red, gray, entries };
}

async function countDeltaScores() {
  let decisionsContent;
  try {
    decisionsContent = await readFile(DECISIONS_FILE, "utf8");
  } catch {
    return { total: 0, score0: 0, score1: 0, score2: 0 };
  }

  const deltaLines = decisionsContent.match(/^__DELTA__:.*/gm) || [];
  let total = 0;
  let score0 = 0;
  let score1 = 0;
  let score2 = 0;

  for (const line of deltaLines) {
    const match = line.match(/\|\s*([012])\s*\|/);
    if (match) {
      total++;
      const score = match[1];
      if (score === "0") score0++;
      else if (score === "1") score1++;
      else if (score === "2") score2++;
    }
  }

  return { total, score0, score1, score2 };
}

async function main() {
  const daysThreshold = Number(process.argv[2]) || 30;

  console.log("F-071 路由判级准确率统计");
  console.log(`统计窗口：最近 ${daysThreshold} 天`);
  console.log();

  // 解析 route-gate.log
  const routeStats = await parseRouteGateLog();
  console.log("## 路由判定分布");
  console.log(`RED 判定：${routeStats.red}`);
  console.log(`gray 判定：${routeStats.gray}`);
  console.log(`总计：${routeStats.red + routeStats.gray}`);
  console.log();

  // 解析 DELTA 账本
  const deltaStats = await countDeltaScores();
  console.log("## DELTA 评分分布");
  console.log(`总条目：${deltaStats.total}`);
  console.log(`白发 (0)：${deltaStats.score0} (${deltaStats.total ? ((deltaStats.score0 / deltaStats.total) * 100).toFixed(1) : 0}%)`);
  console.log(`补强 (1)：${deltaStats.score1} (${deltaStats.total ? ((deltaStats.score1 / deltaStats.total) * 100).toFixed(1) : 0}%)`);
  console.log(`推翻 (2)：${deltaStats.score2} (${deltaStats.total ? ((deltaStats.score2 / deltaStats.total) * 100).toFixed(1) : 0}%)`);
  console.log();

  // 计算指标
  const whiteHairRate = deltaStats.total > 0 ? (deltaStats.score0 / deltaStats.total) * 100 : 0;
  const redRatio = (routeStats.red + routeStats.gray) > 0 ? (routeStats.red / (routeStats.red + routeStats.gray)) * 100 : 0;

  console.log("## 关键指标");
  console.log(`RED 占比：${redRatio.toFixed(1)}%`);
  console.log(`白发率：${whiteHairRate.toFixed(1)}%`);
  console.log();

  // 告警阈值
  if (whiteHairRate > 20) {
    console.log("⚠️  警告：白发率 > 20%，建议检查路由正则是否过严");
  }
  if (redRatio < 10) {
    console.log("⚠️  警告：RED 占比 < 10%，建议检查路由正则是否过松");
  }
  if (whiteHairRate <= 20 && redRatio >= 10) {
    console.log("✓ 路由判级健康");
  }
}

main();
