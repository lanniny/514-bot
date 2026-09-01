#!/usr/bin/env node
/**
 * UI-AUDIT 门禁（UI-AUDIT P0-1/P0-2/P0-4/P1-3 的"治好不复发"护栏）
 *
 * 基线制：以 scripts/ui-baseline.json 中的历史存量为上限，任何新增违规即失败。
 * 存量为技术债、允许存在；新增为零容忍。清零后重跑 --update-baseline 收紧闸门。
 *
 * 规则：
 *   1. bare-hex      CSS 中非变量定义处的裸 hex 颜色（主题切换漏改 + 品牌漂移源）
 *   2. bare-font     CSS 中裸 font-size px 字面值（绕过 --text-* scale）
 *   3. odd-breakpoint 非标准断点（标准档 560/820/1100/1440）
 *   4. inner-html    JS 中 innerHTML 赋值（XSS 面 + 组件复用障碍，仅作趋势观测）
 *
 * 用法：
 *   node scripts/ui-lint.mjs                    # 门禁检查（超出基线退出码 1）
 *   node scripts/ui-lint.mjs --update-baseline  # 以当前实测值刷新基线
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const BASELINE_PATH = join(ROOT, "scripts", "ui-baseline.json");

/**
 * 标准断点档位。min-width 侧普遍写成 N+1（如 min-width:821px 配合 max-width:820px），
 * 这是避免同一像素同时命中两条互斥规则的正确写法，不是笔误，故一并放行。
 */
const STANDARD_BREAKPOINTS = new Set([560, 820, 1100, 1440, 561, 821, 1101, 1441]);
const BARE_HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const CUSTOM_PROP_DEF_RE = /^\s*--[\w-]+\s*:/;
const BARE_FONT_RE = /font-size\s*:\s*[0-9]*\.?[0-9]+px\b/g;
const MEDIA_PX_RE = /@media[^{]*?([0-9]{3,4})px/g;
const INNER_HTML_RE = /\.innerHTML\s*=/g;
const SVG_TAG_RE = /<svg(\s[^>]*)>/g;
const DECORATIVE_SVG_RE = /viewBox="0 0 24 24"|class="[^"]*(?:lucide|\bicon\b)/;

/** 装饰性图标 SVG 未标 aria-hidden / role / aria-label —— 读屏会念出"未命名图形"。 */
function countBareIcons(source) {
  let count = 0;
  for (const match of source.matchAll(SVG_TAG_RE)) {
    const attrs = match[1];
    if (/aria-hidden|role="img"|aria-label/.test(attrs)) continue;
    if (!DECORATIVE_SVG_RE.test(attrs)) continue;
    count += 1;
  }
  return count;
}
const TRANSITION_RE = /transition:\s*[^;}]*/g;
const DURATION_RE = /(^|[\s,])([0-9]*\.?[0-9]+)(ms|s)\b/g;

/** transition 声明里未走 --dur-* token 的裸时长（0s 与有意超长动效除外）。 */
function countBareDurations(source) {
  let count = 0;
  for (const declaration of source.match(TRANSITION_RE) ?? []) {
    const stripped = declaration.replace(/var\(--dur-[a-z]+\)/g, "");
    for (const match of stripped.matchAll(DURATION_RE)) {
      const ms = match[3] === "s" ? Number.parseFloat(match[2]) * 1000 : Number.parseFloat(match[2]);
      if (ms === 0 || ms > 400) continue; // 有意设计：瞬时关闭 / 超长环境动效
      count += 1;
    }
  }
  return count;
}

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "vendor") continue;
      await walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

/* mask 渐变的色标只取 alpha 通道（mask-mode 默认 alpha），用 #000 是惯用写法、
   不参与主题，与 codemod 的 MASK_DECL_RE 保持一致，不计为裸色值违规。 */
const MASK_DECL_RE = /^\s*(?:-webkit-)?mask(?:-image)?\s*:/;

function countBareHex(source, { isTokenFile }) {
  if (isTokenFile) return 0; // tokens.css 的 hex 是定义源，不是违规
  let count = 0;
  for (const line of source.split("\n")) {
    if (CUSTOM_PROP_DEF_RE.test(line)) continue; // 允许自定义属性定义
    if (MASK_DECL_RE.test(line)) continue; // mask 色标只取 alpha，与主题无关
    count += line.match(BARE_HEX_RE)?.length ?? 0;
  }
  return count;
}

async function measure() {
  const files = await walk(PUBLIC_DIR);
  const result = { "bare-hex": 0, "bare-font": 0, "odd-breakpoint": 0, "bare-duration": 0, "bare-icon": 0, "inner-html": 0 };
  const hotspots = new Map();
  const bump = (key, file, n) => {
    result[key] += n;
    if (n > 0) hotspots.set(`${key} ${relative(ROOT, file)}`, (hotspots.get(`${key} ${relative(ROOT, file)}`) ?? 0) + n);
  };

  for (const file of files) {
    const ext = extname(file);
    const source = await readFile(file, "utf8");
    if (ext === ".css") {
      bump("bare-hex", file, countBareHex(source, { isTokenFile: file.endsWith(join("forge", "tokens.css")) }));
      bump("bare-font", file, source.match(BARE_FONT_RE)?.length ?? 0);
      const odd = [...source.matchAll(MEDIA_PX_RE)]
        .map((match) => Number(match[1]))
        .filter((px) => !STANDARD_BREAKPOINTS.has(px)).length;
      bump("odd-breakpoint", file, odd);
      bump("bare-duration", file, countBareDurations(source));
    } else if (ext === ".js" || ext === ".html") {
      bump("inner-html", file, source.match(INNER_HTML_RE)?.length ?? 0);
      bump("bare-icon", file, countBareIcons(source));
    }
  }
  return { result, hotspots };
}

async function main() {
  const args = process.argv.slice(2);
  const { result, hotspots } = await measure();

  if (args.includes("--update-baseline")) {
    await writeFile(BASELINE_PATH, `${JSON.stringify({ updatedAt: new Date().toISOString(), ...result }, null, 2)}\n`, "utf8");
    console.log("✅ 基线已刷新：");
    console.log(result);
    return;
  }

  let baseline = {};
  try {
    baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
  } catch {
    console.error("❌ 缺少基线文件，请先运行：node scripts/ui-lint.mjs --update-baseline");
    process.exit(2);
  }

  let failed = false;
  console.log("规则            实测    基线    结论");
  for (const key of Object.keys(result)) {
    const current = result[key];
    const limit = baseline[key] ?? 0;
    const ok = current <= limit;
    if (!ok) failed = true;
    console.log(`${key.padEnd(15)} ${String(current).padStart(5)} ${String(limit).padStart(7)}    ${ok ? "✅" : `❌ 新增 ${current - limit} 处`}`);
  }

  if (failed) {
    console.log("\n违规热点 Top 10：");
    for (const [key, count] of [...hotspots.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  ${key}：${count}`);
    }
    console.log("\n❌ UI 门禁未通过：新增违规必须清零，或证明属必要后再更新基线。");
    process.exit(1);
  }
  console.log("\n✅ UI 门禁通过（无新增违规）。");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
