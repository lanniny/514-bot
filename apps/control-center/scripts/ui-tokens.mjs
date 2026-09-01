#!/usr/bin/env node
/**
 * UI-AUDIT codemod — 把散落的裸样式值收敛到 forge/tokens.css 设计令牌。
 *
 * 子任务：
 *   font-size      把 CSS 中裸 font-size px 字面值映射到 --text-* scale（P0-2）
 *                  8–12→xs ｜ 12.5–13→sm ｜ 13.5–14→base ｜ 15–15.5→md ｜ 16–17→lg
 *                  18–20→xl ｜ 21–26→2xl ｜ 28–30→3xl ｜ 32–36→4xl ｜ 44→5xl
 *   fallback-rose  把 var(--primary, #b4234d) 的旧"暗夜玫瑰"兜底色换成铜橙（P0-1）
 *
 * 用法：
 *   node scripts/ui-tokens.mjs report              # 只报告，不改文件
 *   node scripts/ui-tokens.mjs apply               # 执行全部子任务
 *   node scripts/ui-tokens.mjs apply --only=font-size
 *
 * 设计原则：只做机械、可审计、可回滚的替换；主题相关的语义色映射（需要人工判断
 * 亮/暗两态取值）不在此脚本范围内，交由 ui-lint.mjs 门禁 + 人工分批清零。
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");

/** 字号 → token 的映射表（上界含）。顺序敏感：从小到小大逐个匹配。 */
const FONT_SIZE_RULES = [
  { max: 12, token: "--text-xs", note: "可读性硬下限 12px" },
  { max: 13, token: "--text-sm" },
  { max: 14, token: "--text-base" },
  { max: 15.5, token: "--text-md" },
  { max: 17, token: "--text-lg" },
  { max: 20, token: "--text-xl" },
  { max: 26, token: "--text-2xl" },
  { max: 30, token: "--text-3xl" },
  { max: 36, token: "--text-4xl" },
  { max: Number.POSITIVE_INFINITY, token: "--text-5xl" },
];

export function fontSizeToken(px) {
  return FONT_SIZE_RULES.find((rule) => px <= rule.max).token;
}

/** 只匹配声明式 font-size，不动 font 简写与 var() 引用。 */
const FONT_SIZE_RE = /(font-size\s*:\s*)([0-9]*\.?[0-9]+)px\b/g;
const LEGACY_ROSE_RE = /#b4234d\b/gi;
const LEGACY_ROSE_REPLACEMENT = "#d97757";

/* —— 动效时长收敛（UI-AUDIT P1-5）——
   只改 transition 声明里的时长，不改 animation（旋转/进度类动效的节奏是有意设计的），
   也不改缓动函数（linear 常用于循环动效，替换会破坏观感）。
   分档：≤120ms→instant ｜ ≤180ms→fast ｜ ≤300ms→base ｜ ≤400ms→slow ｜ >400ms 视为有意设计，保留。 */
const TRANSITION_RE = /transition:\s*[^;}]*/g;
const DURATION_RE = /([0-9]*\.?[0-9]+)(ms|s)\b/g;
const MOTION_RULES = [
  { max: 120, token: "--dur-instant" },
  { max: 180, token: "--dur-fast" },
  { max: 300, token: "--dur-base" },
  { max: 400, token: "--dur-slow" },
];

/* —— 对比度专项（UI-AUDIT P1-4）——
   实测：铜橙 #D97757 在暖纸底（#faf9f5）对比度仅 2.94:1，连"大字号 3:1"都不到，
   作文字色即违反 WCAG AA。--accent-ink 是同色相加深的文字档（亮态 #a95430 ≈ 4.9:1、
   暗态 #f0a483 ≈ 8.5:1），主题自适应，故可整体替换。
   只动 `color:` 声明——填充/描边/图形场景继续用原品牌色，那是它的主场。 */
const ACCENT_TEXT_VARS = ["--rose", "--rose-deep", "--rose-bright", "--primary", "--accent"];
// 负向后顾是必须的：早期版本漏了它，把 border-color / accent-color / caret-color /
// outline-color 也一并换成了文字档（描边与控件填充被压暗）。派生属性保留品牌原色。
const ACCENT_TEXT_RE = new RegExp(`(?<![\\w-])(color\\s*:\\s*)var\\((${ACCENT_TEXT_VARS.join("|")})\\)`, "g");

function migrateAccentText(source) {
  const hits = source.match(ACCENT_TEXT_RE)?.length ?? 0;
  return { next: source.replace(ACCENT_TEXT_RE, "$1var(--accent-ink)"), hits };
}

/* —— 语义色收敛（UI-AUDIT P0-1 安全子集）——
   核心思路：**只替换「亮态值与某 token 的亮态定义完全相同」的裸色值**。
   这样亮态渲染结果与改前逐像素一致（零视觉风险），而暗态会自动跟随 token 变化，
   正好修掉"暗色主题漏改"这个根因。
   位于 [data-theme="dark"] 块内的裸色值一律跳过：它们的正确取值需要人工判定
   （暗态可能本来就想用另一个色阶），机械替换会改变现有暗态观感。 */
const TOKENS_CSS = join(PUBLIC_DIR, "forge", "tokens.css");
/** 同名冲突时的取名优先级：语义色 > 纸墨 > 状态色 > 品牌色 */
const TOKEN_PRIORITY = [
  /^--text-(strong|primary)$/, /^--text-(muted|secondary|soft)$/, /^--text$/,
  /^--surface(-|$)/, /^--bg$/, /^--border(-|$)/, /^--sidebar(-|$)/,
  /^--(success|warning|danger|info)(-|$)/,
  /^--rose(-|$)/, /^--accent(-|$)/,
];

/** #abc 与 #aabbcc 是同色，查表前统一展开成 6 位。 */
function normalizeHex(raw) {
  const body = raw.replace("#", "").toLowerCase();
  if (body.length === 3) return `#${body.split("").map((ch) => ch + ch).join("")}`;
  return `#${body}`;
}

async function loadTokenColorMaps() {
  // 必须先剥注释：文件头注释里同时出现 ":root" 与 "[data-theme=dark]" 字样，
  // 不剥离会让首个 :root 块被误判为暗态块而整段跳过（--on-accent 就定义在里面）。
  const raw = await readFile(TOKENS_CSS, "utf8");
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const light = new Map();

  const take = (blockText, bucket) => {
    for (const match of blockText.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
      const name = match[1];
      const hex = normalizeHex(match[2]);
      const current = bucket.get(hex);
      if (!current) { bucket.set(hex, name); continue; }
      const rank = (token) => TOKEN_PRIORITY.findIndex((rule) => rule.test(token));
      if (rank(name) >= 0 && (rank(current) < 0 || rank(name) < rank(current))) bucket.set(hex, name);
    }
  };

  // 逐块扫描：遇到 ":root {" 归入亮态，遇到 [data-theme="dark"] 归入暗态
  const blockRe = /((?::root|\[data-theme="dark"\]|\.dark)[^{]*)\{/g;
  let match;
  while ((match = blockRe.exec(source))) {
    const header = match[1];
    let depth = 1;
    let index = blockRe.lastIndex;
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
      index += 1;
    }
    const body = source.slice(blockRe.lastIndex, index - 1);
    if (header.includes('data-theme="dark"')) continue; // 暗态值需要人工判定，不参与自动映射
    take(body, light);
  }
  return light;
}

const CUSTOM_PROP_DEF_RE = /^\s*--[\w-]+\s*:/;
/* mask 渐变的色标只取 alpha 通道（mask-mode 默认 alpha），换成语义色 token 反而
   误导读者以为那是墨色，且会打破锁死该写法的契约测试。同理跳过变量定义行。 */
const MASK_DECL_RE = /^\s*(?:-webkit-)?mask(?:-image)?\s*:/;

function migrateSemanticColors(source, lightTokens) {
  const touched = new Map();
  const lines = source.split("\n");
  let depth = 0;
  let darkDepth = -1; // >=0 表示当前处于该深度起始的暗态块内

  const next = lines.map((line) => {
    const inDark = darkDepth >= 0;
    const entersDark = !inDark && /\[data-theme="dark"\]/.test(line);
    if (entersDark) darkDepth = depth;

    let rewritten = line;
    if (!inDark && !CUSTOM_PROP_DEF_RE.test(line) && !MASK_DECL_RE.test(line)) {
      rewritten = line.replace(/#([0-9a-fA-F]{3,8})\b/g, (whole, raw) => {
        const hex = normalizeHex(`#${raw}`);
        const token = lightTokens.get(hex);
        if (!token) return whole;
        touched.set(`${hex}→var(${token})`, (touched.get(`${hex}→var(${token})`) ?? 0) + 1);
        return `var(${token})`;
      });
    }

    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (darkDepth >= 0 && depth <= darkDepth) darkDepth = -1;
    return rewritten;
  });

  return { next: next.join("\n"), touched };
}

/* —— 装饰图标可访问性（UI-AUDIT P2-3）——
   实测：全站 24px / lucide 装饰图标 155 个，仅 61 个标了 aria-hidden，
   其余 94 个会被读屏当作"未命名图形"念出来，纯噪声。
   前置核查：仅含图标、又无 aria-label/title/文本的按钮为 **0 个**
   （由 scripts 内的一次性核查确认），因此补 aria-hidden 不会让任何按钮失去可访问名称。 */
const SVG_TAG_RE = /<svg(\s[^>]*)>/g;
const DECORATIVE_SVG_RE = /viewBox="0 0 24 24"|class="[^"]*(?:lucide|\bicon\b)/;

function migrateIconA11y(source) {
  let hits = 0;
  const next = source.replace(SVG_TAG_RE, (whole, attrs) => {
    if (/aria-hidden|role="img"|aria-label/.test(attrs)) return whole;
    if (!DECORATIVE_SVG_RE.test(attrs)) return whole;
    hits += 1;
    return `<svg aria-hidden="true"${attrs}>`;
  });
  return { next, hits };
}

function migrateMotion(source) {
  const touched = new Map();
  const next = source.replace(TRANSITION_RE, (declaration) => declaration.replace(DURATION_RE, (match, raw, unit) => {
    const ms = unit === "s" ? Number.parseFloat(raw) * 1000 : Number.parseFloat(raw);
    if (ms === 0 || ms > 400) return match; // 0s 与超长动效视为有意设计
    const rule = MOTION_RULES.find((item) => ms <= item.max);
    if (!rule) return match;
    touched.set(`${match}→var(${rule.token})`, (touched.get(`${match}→var(${rule.token})`) ?? 0) + 1);
    return `var(${rule.token})`;
  }));
  return { next, touched };
}

/**
 * 按扩展名收集文件。作用域必须按任务隔离：
 * 样式类任务（字号/色值/动效）只吃 .css，否则会把 JS 字符串与 HTML 内联样式
 * 一起改掉（例如 JS 里恰好出现的 `transition:` 字面量）。
 */
async function walk(dir, exts = [".css"], out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "vendor") continue; // 第三方资产不治理
      await walk(full, exts, out);
    } else if (exts.includes(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function migrateFontSize(source) {
  const touched = new Map();
  const next = source.replace(FONT_SIZE_RE, (match, prefix, raw) => {
    const px = Number.parseFloat(raw);
    const token = fontSizeToken(px);
    touched.set(`${raw}px→var(${token})`, (touched.get(`${raw}px→var(${token})`) ?? 0) + 1);
    return `${prefix}var(${token})`;
  });
  return { next, touched };
}

function migrateLegacyRose(source) {
  const hits = source.match(LEGACY_ROSE_RE)?.length ?? 0;
  return { next: source.replaceAll(LEGACY_ROSE_RE, LEGACY_ROSE_REPLACEMENT), hits };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] ?? "report";
  const only = args.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
  const apply = mode === "apply";
  const runFontSize = !only || only === "font-size";
  const runRose = !only || only === "fallback-rose";
  const runMotion = !only || only === "motion";
  const runSemanticColors = !only || only === "semantic-colors";
  const runIconA11y = !only || only === "icon-a11y";
  const runAccentText = !only || only === "accent-text";

  const lightTokens = await loadTokenColorMaps();
  // 样式任务只扫 CSS；装饰图标任务单独扫 JS/HTML（作用域隔离，见 walk 注释）
  const files = await walk(PUBLIC_DIR, runIconA11y && only ? [".js", ".html"] : [".css"]);
  const summary = { files: 0, changed: 0, fontSize: 0, rose: 0, accentText: 0, semanticColors: 0, iconA11y: 0, motion: 0 };
  const perValue = new Map();

  for (const file of files) {
    const original = await readFile(file, "utf8");
    let next = original;
    if (runFontSize) {
      const result = migrateFontSize(next);
      next = result.next;
      summary.fontSize += [...result.touched.values()].reduce((a, b) => a + b, 0);
      for (const [key, count] of result.touched) perValue.set(key, (perValue.get(key) ?? 0) + count);
    }
    if (runRose) {
      const result = migrateLegacyRose(next);
      next = result.next;
      summary.rose += result.hits;
    }
    if (runAccentText) {
      const result = migrateAccentText(next);
      next = result.next;
      summary.accentText += result.hits;
    }
    if (runSemanticColors && !file.endsWith(join("forge", "tokens.css"))) {
      const result = migrateSemanticColors(next, lightTokens);
      next = result.next;
      summary.semanticColors += [...result.touched.values()].reduce((a, b) => a + b, 0);
      for (const [key, count] of result.touched) perValue.set(key, (perValue.get(key) ?? 0) + count);
    }
    if (runIconA11y && /.(js|html)$/.test(file)) {
      const result = migrateIconA11y(next);
      next = result.next;
      summary.iconA11y += result.hits;
    }
    if (runMotion) {
      const result = migrateMotion(next);
      next = result.next;
      summary.motion += [...result.touched.values()].reduce((a, b) => a + b, 0);
      for (const [key, count] of result.touched) perValue.set(key, (perValue.get(key) ?? 0) + count);
    }
    summary.files += 1;
    if (next !== original) {
      summary.changed += 1;
      const rel = relative(ROOT, file);
      if (apply) await writeFile(file, next, "utf8");
      console.log(`${apply ? "✏️  已写入" : "🔍 待改"}  ${rel}`);
    }
  }

  console.log("\n—— 汇总 ——");
  console.log(`扫描文件：${summary.files} 个，命中改动：${summary.changed} 个`);
  console.log(`font-size 收敛：${summary.fontSize} 处`);
  console.log(`旧玫瑰兜底色清理：${summary.rose} 处`);
  console.log(`主色文字→--accent-ink（对比度 AA）：${summary.accentText} 处`);
  console.log(`裸色值→语义 token（亮态零视觉变化）：${summary.semanticColors} 处`);
  console.log(`transition 时长收敛：${summary.motion} 处`);
  console.log(`装饰图标补 aria-hidden：${summary.iconA11y} 处`);
  if (perValue.size) {
    console.log("\n字号映射明细（原值 → token：次数）");
    for (const [key, count] of [...perValue.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${key}：${count}`);
    }
  }
  console.log(apply ? "\n✅ 已应用。请跑 `node scripts/ui-lint.mjs --update-baseline` 刷新门禁基线。" : "\n（dry-run：加 apply 参数才写盘）");
}

// 仅在作为 CLI 直接执行时运行；被 tests/ 以模块方式导入映射表时不触发全库扫描
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
