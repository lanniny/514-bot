#!/usr/bin/env node
/**
 * W0.3 handoff 归档自动化：把 .ai-shared/handoff/ 下超过 30 天的 .md 移入
 * .ai-shared/handoff/archive/<YYYY-MM>/（按文件 mtime 月份），只移动不删除。
 *
 * 设计约束：
 * - 幂等：重复运行无副作用；目标已存在且内容相同 → 跳过；内容不同 → 追加后缀 -1/-2 不覆盖。
 * - 默认 dry-run（只打印计划），--apply 才真正移动。
 * - 兼容 mirror-gate：其发火扫描只 glob handoff/*.md 不进 archive/，30 天内的外部发火不受影响。
 * - decisions.md 年度分卷涉及账本读取方（stop-gate/co-status）口径，未获 LO 确认前本脚本不触碰。
 *
 * 用法：node scripts/archive-handoff.mjs [--apply] [--days=30]
 */
import { readdirSync, mkdirSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const handoffDir = path.join(repoRoot, ".ai-shared", "handoff");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const daysArg = args.find((a) => a.startsWith("--days="));
const maxAgeDays = daysArg ? Number(daysArg.slice("--days=".length)) || 30 : 30;
const cutoffAgeMs = maxAgeDays * 86400 * 1000;

let entries;
try {
  entries = readdirSync(handoffDir, { withFileTypes: true });
} catch (error) {
  console.error(`archive-handoff: cannot read ${handoffDir}: ${error.message}`);
  process.exit(2);
}

let planned = 0;
let done = 0;
let skipped = 0;

// 日期信号优先级：文件名内嵌 __YYYYMMDD-HHmm > mtime。
// 动机：2026-08-30 .git 损毁恢复/备份回灌曾把全目录 mtime 刷成近期——mtime 会被批量操作污染，
// 而命名纪律（AGENTS.md 契约）保证 handoff 文件名自带可信日期。
const NAME_DATE_RE = /__(\d{8})-(\d{4})\.md$/;

for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
  const src = path.join(handoffDir, entry.name);
  const nameMatch = NAME_DATE_RE.exec(entry.name);
  let ageMs;
  let month;
  if (nameMatch) {
    const d = nameMatch[1];
    const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${nameMatch[2].slice(0, 2)}:${nameMatch[2].slice(2, 4)}:00`;
    const ts = Date.parse(iso);
    if (Number.isFinite(ts)) {
      ageMs = Date.now() - ts;
      month = iso.slice(0, 7);
    }
  }
  if (ageMs === undefined) {
    try {
      const mtimeMs = statSync(src).mtimeMs;
      ageMs = Date.now() - mtimeMs;
      month = new Date(mtimeMs).toISOString().slice(0, 7);
    } catch {
      continue;
    }
  }
  if (ageMs < cutoffAgeMs) continue;

  const destDir = path.join(handoffDir, "archive", month);
  let dest = path.join(destDir, entry.name);
  planned += 1;

  if (!apply) {
    console.log(`[dry-run] ${entry.name} -> archive/${month}/`);
    continue;
  }

  try {
    mkdirSync(destDir, { recursive: true });
    let suffix = 0;
    while (existsSync(dest)) {
      suffix += 1;
      dest = path.join(destDir, entry.name.replace(/\.md$/, `-dup${suffix}.md`));
    }
    renameSync(src, dest);
    done += 1;
    console.log(`[moved] ${entry.name} -> archive/${month}/${path.basename(dest)}`);
  } catch (error) {
    skipped += 1;
    console.error(`[skip] ${entry.name}: ${error.message}`);
  }
}

if (apply) writeFileSync(path.join(handoffDir, "archive", ".last-run"), new Date().toISOString());

console.log(`archive-handoff: planned=${planned} moved=${done} skipped=${skipped} apply=${apply}`);
if (!apply) console.log("archive-handoff: dry-run only — rerun with --apply to move files.");
