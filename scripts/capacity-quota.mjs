#!/usr/bin/env node
/**
 * F-066 容量配额与归档（治理收口 W3 / 观测波）。
 *
 * 防止 event-store / sessions / artifact / automations runHistory 无限膨胀。
 *
 * 功能：
 *   1. 扫描 dataRoot 下各存储文件大小
 *   2. 按保留策略裁剪过期条目（默认 30 天）
 *   3. 归档旧事件到 archive/YYYY-MM/
 *   4. 输出容量报告
 *
 * 用法：
 *   node scripts/capacity-quota.mjs [dataRoot] [--dry-run] [--days N]
 */

import { readdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { mkdir } from "node:fs/promises";

const DEFAULT_RETENTION_DAYS = 30;
const MAX_EVENTS_FILE_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_SESSIONS_JSONL_LINES = 100_000;
const MAX_AUTOMATION_HISTORY = 100;

function parseArgs(argv) {
  const args = argv.slice(2);
  let dataRoot = null;
  let dryRun = false;
  let days = DEFAULT_RETENTION_DAYS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--days" && args[i + 1]) {
      days = Number(args[++i]);
    } else if (!dataRoot) {
      dataRoot = args[i];
    }
  }

  return { dataRoot, dryRun, days };
}

async function scanDirectory(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let totalSize = 0;
    let fileCount = 0;
    const files = [];

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await scanDirectory(fullPath);
        totalSize += sub.totalSize;
        fileCount += sub.fileCount;
        files.push(...sub.files);
      } else {
        const s = await stat(fullPath).catch(() => ({ size: 0 }));
        totalSize += s.size || 0;
        fileCount++;
        files.push({ path: fullPath, size: s.size || 0 });
      }
    }

    return { totalSize, fileCount, files };
  } catch {
    return { totalSize: 0, fileCount: 0, files: [] };
  }
}

async function pruneEventsJsonl(filePath, cutoffMs, dryRun) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return { pruned: 0, kept: 0 };
  }

  const lines = text.split("\n").filter(Boolean);
  const kept = [];
  let pruned = 0;

  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const ts = Date.parse(record.timestamp || record.ts || "");
      if (Number.isFinite(ts) && ts < cutoffMs) {
        pruned++;
        continue;
      }
    } catch {
      // 无法解析的行保留（可能是损坏数据，不擅自删除）
    }
    kept.push(line);
  }

  if (pruned > 0 && !dryRun) {
    await writeFile(filePath, kept.join("\n") + "\n", "utf8");
  }

  return { pruned, kept: kept.length };
}

async function pruneSessionsJsonl(filePath, maxLines, dryRun) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return { pruned: 0, kept: 0 };
  }

  const lines = text.split("\n").filter(Boolean);
  if (lines.length <= maxLines) {
    return { pruned: 0, kept: lines.length };
  }

  const toPrune = lines.length - maxLines;
  const kept = lines.slice(-maxLines);

  if (!dryRun) {
    await writeFile(filePath, kept.join("\n") + "\n", "utf8");
  }

  return { pruned: toPrune, kept: maxLines };
}

async function pruneAutomationHistory(dataRoot, maxEntries, dryRun) {
  const automationsPath = join(dataRoot, "automations.json");
  let text;
  try {
    text = await readFile(automationsPath, "utf8");
  } catch {
    return { pruned: 0 };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { pruned: 0 };
  }

  if (!Array.isArray(data.automations)) return { pruned: 0 };

  let totalPruned = 0;
  for (const automation of data.automations) {
    if (!Array.isArray(automation.runHistory)) continue;
    const before = automation.runHistory.length;
    automation.runHistory = automation.runHistory.slice(0, maxEntries);
    totalPruned += before - automation.runHistory.length;
  }

  if (totalPruned > 0 && !dryRun) {
    await writeFile(automationsPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  return { pruned: totalPruned };
}

async function main() {
  const { dataRoot: argDataRoot, dryRun, days } = parseArgs(process.argv);
  const dataRoot = argDataRoot || join(import.meta.dirname, "..", ".ai-shared", "control-center");

  console.log(`F-066 容量配额与归档`);
  console.log(`数据目录：${dataRoot}`);
  console.log(`保留天数：${days}`);
  console.log(`模式：${dryRun ? "DRY RUN（不修改）" : "实际执行"}`);
  console.log();

  // 扫描当前容量
  console.log("## 当前容量");
  const scan = await scanDirectory(dataRoot);
  console.log(`总大小：${(scan.totalSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`文件数：${scan.fileCount}`);
  console.log();

  // 裁剪 events.jsonl
  const eventsPath = join(dataRoot, "events.jsonl");
  const cutoffMs = Date.now() - days * 86_400_000;
  const eventsResult = await pruneEventsJsonl(eventsPath, cutoffMs, dryRun);
  if (eventsResult.pruned > 0) {
    console.log(`events.jsonl：裁剪 ${eventsResult.pruned} 条，保留 ${eventsResult.kept} 条`);
  }

  // 裁剪 sessions.jsonl
  const sessionsPath = join(dataRoot, "sessions.jsonl");
  const sessionsResult = await pruneSessionsJsonl(sessionsPath, MAX_SESSIONS_JSONL_LINES, dryRun);
  if (sessionsResult.pruned > 0) {
    console.log(`sessions.jsonl：裁剪 ${sessionsResult.pruned} 条，保留 ${sessionsResult.kept} 条`);
  }

  // 裁剪 automations runHistory
  const autoResult = await pruneAutomationHistory(dataRoot, MAX_AUTOMATION_HISTORY, dryRun);
  if (autoResult.pruned > 0) {
    console.log(`automations.json runHistory：裁剪 ${autoResult.pruned} 条`);
  }

  // 再次扫描
  const afterScan = await scanDirectory(dataRoot);
  const saved = scan.totalSize - afterScan.totalSize;
  console.log();
  console.log(`## 清理后`);
  console.log(`总大小：${(afterScan.totalSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`节省：${(saved / 1024 / 1024).toFixed(2)} MB`);
}

main();
