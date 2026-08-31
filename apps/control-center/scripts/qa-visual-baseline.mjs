#!/usr/bin/env node
/**
 * W2.6 视觉回归基线（人肉 diff 起步）：
 *   node scripts/qa-visual-baseline.mjs --save  [.qa-output/workbench-environment → .qa-baseline/workbench-environment]
 *   node scripts/qa-visual-baseline.mjs          [默认 compare：列出新截图与基线的差异对，人肉开图对比]
 *   node scripts/qa-visual-baseline.mjs --save --source=<name>  [切换源 run 目录]
 *
 * 设计：只拷贝不渲染、只列差异不判定通过/失败——判定权在人（LO）。
 * 基线入库 .qa-baseline/（.gitignore 由 * 开头规则豁免与否由 LO 定，先按忽略处理）。
 */
import { mkdirSync, readdirSync, statSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const save = args.includes("--save");
const sourceArg = args.find((a) => a.startsWith("--source="))?.slice("--source=".length) || "workbench-environment";
const sourceDir = resolve(appRoot, ".qa-output", sourceArg);
const baselineDir = resolve(appRoot, ".qa-baseline", sourceArg);

function listPngs(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".png")).sort();
  } catch {
    return null;
  }
}

if (!existsSync(sourceDir)) {
  console.error(`qa-visual-baseline: source not found: ${sourceDir}`);
  console.error("run `npm run qa:environment` first, then retry.");
  process.exit(2);
}

const current = listPngs(sourceDir);
if (save) {
  rmSync(baselineDir, { recursive: true, force: true });
  mkdirSync(baselineDir, { recursive: true });
  let count = 0;
  for (const name of current) {
    copyFileSync(join(sourceDir, name), join(baselineDir, name));
    count += 1;
  }
  console.log(`qa-visual-baseline: saved ${count} shots -> ${baselineDir}`);
  process.exit(0);
}

if (!existsSync(baselineDir)) {
  console.log(`qa-visual-baseline: no baseline yet for "${sourceArg}".`);
  console.log(`run: node scripts/qa-visual-baseline.mjs --save --source=${sourceArg}`);
  process.exit(0);
}

const baseline = listPngs(baselineDir);
const added = current.filter((name) => !baseline.includes(name));
const removed = baseline.filter((name) => !current.includes(name));
const changed = [];
for (const name of current.filter((name) => baseline.includes(name))) {
  const a = statSync(join(sourceDir, name)).size;
  const b = statSync(join(baselineDir, name)).size;
  if (Math.abs(a - b) / Math.max(a, b) > 0.05) changed.push({ name, current: a, baseline: b }); // >5% 尺寸差 = 大概率视觉变化
}

console.log(`qa-visual-baseline [${sourceArg}]: current=${current.length} baseline=${baseline.length}`);
console.log(`added:   ${added.length ? added.join(", ") : "-"}`);
console.log(`removed: ${removed.length ? removed.join(", ") : "-"}`);
console.log(`changed(>5% size): ${changed.length ? "" : "-"}`);
for (const item of changed) {
  console.log(`  ${item.name}  current=${item.current}B baseline=${item.baseline}B`);
  console.log(`    diff: ${join(sourceDir, item.name)}  vs  ${join(baselineDir, item.name)}`);
}
