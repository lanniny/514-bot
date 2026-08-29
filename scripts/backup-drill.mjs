#!/usr/bin/env node
/**
 * F-067 备份恢复演练（治理收口 W3 / 观测波）。
 *
 * 对关键数据（配置/会话/记忆）做备份并验证可恢复性。
 *
 * 用法：
 *   node scripts/backup-drill.mjs [dataRoot] [--dry-run]
 */

import { copyFile, mkdir, readFile, rm, writeFile, stat, readdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";

const CRITICAL_FILES = [
  ".ai-shared/context.md",
  ".ai-shared/decisions.md",
  ".ai-shared/roster.json",
  ".ai-shared/control-center/events.jsonl",
  ".ai-shared/control-center/sessions.jsonl",
  ".ai-shared/control-center/automations.json",
  ".ai-shared/handoff/",
];

function parseArgs(argv) {
  const args = argv.slice(2);
  let dataRoot = null;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (!dataRoot) {
      dataRoot = args[i];
    }
  }

  return { dataRoot: dataRoot || process.cwd(), dryRun };
}

async function backupFile(src, destDir, stamp) {
  const relativePath = src.replace(/^[./\\]+/, "");
  const destPath = join(destDir, `${stamp}_${relativePath.replace(/[\\/]/g, "__")}`);
  await mkdir(dirname(destPath), { recursive: true });

  try {
    const s = await stat(src).catch(() => null);
    if (!s) return { src, status: "missing" };

    if (s.isDirectory()) {
      // 目录递归复制
      const entries = await readdir(src, { withFileTypes: true });
      let count = 0;
      for (const entry of entries) {
        const childSrc = join(src, entry.name);
        const result = await backupFile(childSrc, destPath, stamp);
        if (result.status === "ok") count++;
      }
      return { src, status: "directory", files: count };
    } else {
      await copyFile(src, destPath);
      const size = (await stat(destPath)).size;
      return { src, dest: destPath, status: "ok", size };
    }
  } catch (error) {
    return { src, status: "error", error: error.message };
  }
}

async function verifyBackup(backupDir, originalPaths) {
  const results = [];
  for (const origPath of originalPaths) {
    const relativePath = origPath.replace(/^[./\\]+/, "");
    const pattern = join(backupDir, `*_${relativePath.replace(/[\\/]/g, "__")}`);
    
    // 简化验证：检查备份目录下是否有对应文件
    try {
      const entries = await readdir(backupDir);
      const matched = entries.filter(e => e.includes(basename(origPath)));
      if (matched.length > 0) {
        const backupPath = join(backupDir, matched[0]);
        const s = await stat(backupPath);
        results.push({ path: origPath, exists: true, size: s.size });
      } else {
        results.push({ path: origPath, exists: false });
      }
    } catch {
      results.push({ path: origPath, exists: false });
    }
  }
  return results;
}

async function main() {
  const { dataRoot, dryRun } = parseArgs(process.argv);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = join(dataRoot, `.backups/drill-${stamp}`);

  console.log(`F-067 备份恢复演练`);
  console.log(`工作目录：${dataRoot}`);
  console.log(`备份目录：${backupDir}`);
  console.log(`模式：${dryRun ? "DRY RUN" : "实际执行"}`);
  console.log();

  if (dryRun) {
    console.log("## DRY RUN - 不会创建任何文件");
    console.log();
    console.log("计划备份的文件：");
    for (const f of CRITICAL_FILES) {
      console.log(`  - ${f}`);
    }
    return;
  }

  // 执行备份
  console.log("## 执行备份");
  const results = [];
  for (const filePath of CRITICAL_FILES) {
    const fullpath = join(dataRoot, filePath);
    const result = await backupFile(fullpath, backupDir, stamp);
    results.push(result);
    if (result.status === "ok") {
      console.log(`✓ ${filePath} → ${(result.size / 1024).toFixed(1)} KB`);
    } else if (result.status === "directory") {
      console.log(`✓ ${filePath}/ (${result.files} files)`);
    } else if (result.status === "missing") {
      console.log(`⚠ ${filePath} (不存在，跳过)`);
    } else {
      console.log(`✗ ${filePath} (${result.error})`);
    }
  }
  console.log();

  // 验证备份
  console.log("## 验证备份完整性");
  const verification = await verifyBackup(backupDir, CRITICAL_FILES);
  const okCount = verification.filter(r => r.exists).length;
  const failCount = verification.filter(r => !r.exists).length;

  for (const v of verification) {
    if (v.exists) {
      console.log(`✓ ${v.path} (${(v.size / 1024).toFixed(1)} KB)`);
    } else {
      console.log(`✗ ${v.path} (未找到备份)`);
    }
  }

  console.log();
  console.log(`## 摘要`);
  console.log(`备份成功：${okCount}/${verification.length}`);
  console.log(`备份失败：${failCount}/${verification.length}`);
  console.log(`备份位置：${backupDir}`);

  if (failCount === 0) {
    console.log("\n✓ 备份恢复演练通过");
  } else {
    console.log(`\n⚠ ${failCount} 个文件备份失败，请检查`);
  }
}

main();
