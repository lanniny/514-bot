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
 *   5. bare-duration transition 里未走 --dur-* token 的裸时长
 *   6. bare-icon     装饰性图标 SVG 缺 aria-hidden
 *   7. emoji         用户可见字符串中的表情符号（注释豁免）
 *   8. token-redefine tokens.css 之外重定义尺度令牌（层叠契约的机械承载，v49 U0）
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

/* ── emoji 门禁（UI-ELEVATION W0）─────────────────────────────────────────
 * 图标一律走 Lucide，界面用户可见处禁止表情符号。
 *
 * 只检测「用户可见字符串」：先剥离三种注释再扫。原因——本仓库的存量表情符号
 * 全部位于开发注释内（如「➕ 新建工具标签」），不触达用户，清零它们只制造噪音。
 *
 * 用 \p{Extended_Pictographic} 而非宽泛的符号类，是为了不误伤排版符号：
 * 项目里有 260 余处 → ↑ ↓ ↵，它们属于 Sm/So 而非 Extended_Pictographic，
 * 是文本语义的一部分（如「Provider → Adapter → 席位」），必须保留。
 * ↔（U+2194 双向排版箭头，如「ask↔auto」）同属排版标点，不归入表情符号。
 * -------------------------------------------------------------------------- */
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
/* `//` 前必须是行首或空白/分号/括号，避开 https:// 与协议相对 URL。 */
const LINE_COMMENT_RE = /(^|[\s;{}()])\/\/[^\n]*/g;

function stripComments(source, ext) {
  let text = source.replace(BLOCK_COMMENT_RE, " ").replace(HTML_COMMENT_RE, " ");
  if (ext !== ".css") text = text.replace(LINE_COMMENT_RE, "$1");
  return text;
}

function countEmoji(source, ext) {
  const matches = [...stripComments(source, ext).matchAll(EMOJI_RE)];
  return matches.filter((m) => m[0] !== "↔").length;
}
const TRANSITION_RE = /transition:\s*[^;}]*/g;
const DURATION_RE = /(^|[\s,])([0-9]*\.?[0-9]+)(ms|s)\b/g;

/* ── token-redefine 门禁（v49 U0）────────────────────────────────────────
 * forge/README.md 的「Single sources of truth」表写明：颜色与尺度令牌
 * （--text-* / --display-* / --space-* / --radius-* / --dur-*）由 forge/tokens.css
 * 独占，"never touch from elsewhere"。本轮之前这条契约**零机械消费者** —— 是
 * 文档承诺，不是护栏。
 *
 * 它拦的真实缺陷（v49 实测）：experience-polish.css 把 --text-xs 在内容面重定义
 * 为 calc(var(--ui-font-size) * 0.79)。--ui-font-size 是用户可拖的滑杆（12–18px），
 * 于是默认档产出 11.06px、最小档 9.48px，全部击穿 tokens.css 自述的 12px 硬下限
 * （"中文 10px 以下字形糊化"）。协作台首屏 57% 的可见文字落在 11.06px。
 *
 * 而既有五条规则**结构上都拦不到**：bare-font 只认字面 `font-size: Npx`
 * （这里是自定义属性定义）；bare-hex 的 CUSTOM_PROP_DEF_RE 又主动跳过所有
 * `--` 开头的行。缺的不是更严的正则，是这一整类规则。
 *
 * 基线制的用意在此处尤其重要：experience-polish 的密度缩放是**有意设计**
 * （字号滑杆要生效就必须重定义），它需要的是 max() 地板而不是禁止重定义。
 * 所以存量计入基线、新增零容忍 —— 下一个人再加一处按比例缩放的尺度令牌时，
 * 门禁会要求他显式说明为什么这一处不需要地板。
 *
 * 配套：静态扫描算不出 calc() 的运行值（11.06px 这个数任何静态工具都得不到），
 * 真实地板由 scripts/qa-ui.mjs 的全滑杆档位实测断言把守，两者缺一不可。
 *
 * 只匹配**尺度阶梯**令牌，显式列出后缀而非用 [\w-]+ 通配：--text-strong /
 * --text-muted / --text-soft / --text-primary / --radius-card 等是**颜色与别名**
 * 令牌，本就该由各层按语义覆写（bot-shell.css 给对话框换墨色是正确用法），
 * 用宽正则会把它们一起报进来，规则就会因噪音被人忽略。
 *
 * 边界前置 `(?:^|[{;\s])` 而非行首锚定 `^\s*`：写元验收时实测发现，行首锚定版
 * 能被单行规则块 `.foo { --text-xs: 8px; }` 整个绕过（追加一行后门禁仍报 4 处，
 * 我最初误以为是规则漏检，实际是我的元验收样本没贴合规则语义 —— 但绕过风险
 * 是真的）。放宽后同行多声明与单行块都命中，且四类不应命中的写法
 * （消费 var()、颜色别名、radius-card、ease-*）仍全部正确漏过。 */
const SCALE_STEPS = "xs|sm|base|md|lg|xl|2xl|3xl|4xl|5xl";
const TOKEN_SCALE_REDEFINE_RE = new RegExp(
  `(?:^|[{;\\s])--(?:text-(?:${SCALE_STEPS})|display-(?:${SCALE_STEPS})|space-\\d+|radius-(?:${SCALE_STEPS})|dur-[a-z]+)\\s*:`,
  "g",
);

function countTokenRedefines(source, { isTokenFile }) {
  if (isTokenFile) return 0; // tokens.css 是定义源，不是重定义
  return source.match(TOKEN_SCALE_REDEFINE_RE)?.length ?? 0;
}

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
  const result = { "bare-hex": 0, "bare-font": 0, "odd-breakpoint": 0, "bare-duration": 0, "bare-icon": 0, "inner-html": 0, emoji: 0, "token-redefine": 0 };
  const hotspots = new Map();
  const bump = (key, file, n) => {
    result[key] += n;
    if (n > 0) hotspots.set(`${key} ${relative(ROOT, file)}`, (hotspots.get(`${key} ${relative(ROOT, file)}`) ?? 0) + n);
  };

  for (const file of files) {
    const ext = extname(file);
    const source = await readFile(file, "utf8");
    if (ext === ".css") {
      const isTokenFile = file.endsWith(join("forge", "tokens.css"));
      bump("bare-hex", file, countBareHex(source, { isTokenFile }));
      bump("bare-font", file, source.match(BARE_FONT_RE)?.length ?? 0);
      const odd = [...source.matchAll(MEDIA_PX_RE)]
        .map((match) => Number(match[1]))
        .filter((px) => !STANDARD_BREAKPOINTS.has(px)).length;
      bump("odd-breakpoint", file, odd);
      bump("bare-duration", file, countBareDurations(source));
      bump("token-redefine", file, countTokenRedefines(source, { isTokenFile }));
    } else if (ext === ".js" || ext === ".html") {
      bump("inner-html", file, source.match(INNER_HTML_RE)?.length ?? 0);
      bump("bare-icon", file, countBareIcons(source));
    }
    if (ext === ".css" || ext === ".js" || ext === ".html") {
      bump("emoji", file, countEmoji(source, ext));
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
