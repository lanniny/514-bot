#!/usr/bin/env node
/**
 * ui-audit-report.mjs — 需要人工判断的 UI 分诊报告（只读，不改任何文件）
 *
 * 背景：P0-4 断点收敛与 P2-4 触控目标两项，都不是"机械替换"能解决的——
 * 断点合并要回答"这个视图在哪一档折叠"，触控目标要回答"这个控件在移动端
 * 是否真的可点"。本脚本把散落在 16k 行 CSS 里的证据聚成一张可执行的清单，
 * 让人工判断从"翻代码"变成"过清单"。
 *
 * 用法：
 *   node scripts/ui-audit-report.mjs                # 控制台输出
 *   node scripts/ui-audit-report.mjs --md=report.md # 同时写入 markdown
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");

/** 标准断点档（与 forge/tokens.css 的 --bp-* 保持一致） */
const STANDARD = new Set([560, 820, 1100, 1440]);
/** 视作交互控件的 selector 特征 */
const INTERACTIVE = /(^|[\s,>+~])(button|a|input|select|textarea)(\.|\[|:|$)|\[role="(button|tab|menuitem|switch|radio|checkbox)"\]|\.(btn|button|nav-item|topnav-item|mobile-nav-item|icon-button|settings-rail-item|rail-[a-z-]+|chip|tag|pill|switch|toggle|tab)\b/i;
const MIN_TOUCH_PX = 32;

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "vendor") continue;
      await walk(full, out);
    } else if (extname(entry.name) === ".css") {
      out.push(full);
    }
  }
  return out;
}

/** 按顶层规则块切分，保留起止行号，便于给出 file:line 证据。 */
function ruleBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  let buffer = "";
  let start = 0;
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!buffer.trim()) start = index + 1;
    buffer += `${line}\n`;
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth === 0 && line.includes("}")) {
      const selector = buffer.slice(0, buffer.indexOf("{")).trim().replace(/\s+/g, " ");
      if (selector && !selector.startsWith("@") && !selector.startsWith("/*")) {
        blocks.push({ selector, body: buffer.slice(buffer.indexOf("{")), start, end: index + 1 });
      }
      buffer = "";
    }
  }
  return blocks;
}

function collectBreakpoints(files) {
  const rows = [];
  for (const { file, source } of files) {
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (!/@media/.test(line)) return;
      for (const match of line.matchAll(/(\d{3,4})px/g)) {
        const px = Number(match[1]);
        if (STANDARD.has(px)) return;
        // 取该媒体查询后第一条规则的选择器作为上下文
        let context = "";
        for (let probe = index; probe < Math.min(lines.length, index + 12) && !context; probe += 1) {
          const candidate = lines[probe].trim();
          if (candidate && !candidate.startsWith("@") && candidate.includes("{")) {
            context = candidate.slice(0, candidate.indexOf("{")).trim().replace(/\s+/g, " ");
          }
        }
        rows.push({ px, file: relative(ROOT, file), line: index + 1, media: line.trim(), context });
      }
    });
  }
  return rows;
}

/* 降噪：伪类/伪元素本身不定尺寸；以文本子节点结尾的选择器（.nav-item span）
   量的是文本不是控件，都不该进"触控目标"清单。 */
const PSEUDO_STATE = /::?(hover|focus|active|visited|disabled|checked|first-child|last-child|nth-child|before|after|placeholder)/;
const TEXT_CHILD = /(^|[\s,>+~])(strong|span|em|p|label|i|svg|use|path|code|small|time)\b/;

function collectTouchTargets(files) {
  const rows = [];
  for (const { file, source } of files) {
    for (const block of ruleBlocks(source)) {
      if (PSEUDO_STATE.test(block.selector)) continue;
      // 只认"最后一个 compound 本身是控件"的选择器：
      // `.button .icon`（量的是图标、不是控件）与 `.nav-item span`（量的是文本）都不算。
      const lastCompound = block.selector.split(/[\s,>+~]+/).pop() ?? "";
      if (!INTERACTIVE.test(lastCompound)) continue;
      if (TEXT_CHILD.test(lastCompound)) continue;
      const declarations = block.body;
      const heightMatch = declarations.match(/(?:min-)?height\s*:\s*(\d+(?:\.\d+)?)px/);
      const paddingMatch = declarations.match(/padding(?:-block)?\s*:\s*(\d+(?:\.\d+)?)px/);
      const declared = heightMatch ? Number(heightMatch[1]) : null;
      const padding = paddingMatch ? Number(paddingMatch[1]) : null;
      // A 类：显式声明了 <32px 的高度 —— 确定过小，可直接改
      // B 类：完全没给高度/内边距线索 —— 需实测，仅提示
      let level = null;
      if (declared !== null && declared < MIN_TOUCH_PX) level = "A 明确过小";
      else if (declared === null && padding === null) level = "B 线索不足";
      else if (declared === null && padding !== null && padding * 2 < MIN_TOUCH_PX) level = "A 明确过小";
      if (!level) continue;
      rows.push({ file: relative(ROOT, file), line: block.start, selector: block.selector.slice(0, 80), declared, padding, level });
    }
  }
  const order = { "A 明确过小": 0, "B 线索不足": 1 };
  return rows.sort((a, b) => order[a.level] - order[b.level]);
}

async function main() {
  const args = process.argv.slice(2);
  const mdOut = args.find((arg) => arg.startsWith("--md="))?.slice("--md=".length);
  const files = [];
  for (const file of await walk(PUBLIC_DIR)) files.push({ file, source: await readFile(file, "utf8") });

  const breakpoints = collectBreakpoints(files);
  const byBreakpoint = new Map();
  for (const row of breakpoints) {
    if (!byBreakpoint.has(row.px)) byBreakpoint.set(row.px, []);
    byBreakpoint.get(row.px).push(row);
  }

  const touch = collectTouchTargets(files);

  const lines = [];
  const push = (text = "") => lines.push(text);

  push("# UI 分诊报告（只读 · 人工判断清单）");
  push("");
  push(`生成时间：${new Date().toISOString()}`);
  push("");
  push("## 1. 非标准断点（P0-4）");
  push("");
  push(`标准档：560 / 820 / 1100 / 1440。共 **${breakpoints.length} 处**落在标准档之外，涉及 **${byBreakpoint.size} 个不同数值**。`);
  push("");
  push("> 注意：821 / 1121 这类「±1px」通常是与相邻 `max-width` 成对出现的互斥区间写法，**不是笔误**，不要简单对齐。");
  push("");
  push("| 断点 | 处数 | 代表位置 | 建议动作 |");
  push("|---|---|---|---|");
  const allValues = new Set(byBreakpoint.keys());
  for (const [px, rows] of [...byBreakpoint.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const nearest = [...STANDARD].sort((a, b) => Math.abs(a - px) - Math.abs(b - px))[0];
    // 成对判定：与标准档相差 1px，或与清单内另一个值相差 1px（如 699/700、680/681、
    // 1120/1121）——这类是"min-width:X+1 与 max-width:X"的互斥区间写法，不是笔误。
    const paired = STANDARD.has(px - 1) || STANDARD.has(px + 1) || allValues.has(px - 1) || allValues.has(px + 1);
    const action = paired ? "与相邻档成对，保留（互斥区间）" : `人工确认后并入 ${nearest}`;
    const first = rows[0];
    push(`| ${px}px | ${rows.length} | \`${first.file}:${first.line}\` | ${action} |`);
  }
  push("");
  push("### 明细（按出现次数降序，每条附规则上下文）");
  push("");
  for (const [px, rows] of [...byBreakpoint.entries()].sort((a, b) => b[1].length - a[1].length)) {
    push(`**${px}px（${rows.length} 处）**`);
    for (const row of rows.slice(0, 12)) {
      push(`- \`${row.file}:${row.line}\` — \`${row.media}\`${row.context ? ` → \`${row.context}\`` : ""}`);
    }
    if (rows.length > 12) push(`- …另有 ${rows.length - 12} 处`);
    push("");
  }

  push("## 2. 触控目标疑似过小（P2-4）");
  push("");
  const levelA = touch.filter((row) => row.level === "A 明确过小").length;
  push(`以 **${MIN_TOUCH_PX}px** 为下限：**A 类（确定过小，可直接改）${levelA} 条**，B 类（无线索，需实测）${touch.length - levelA} 条。`);
  push("");
  push("> 已过滤 :hover 等伪类态，以及 `.nav-item span` 这类「量的是文本、不是控件」的选择器。仍属启发式，用途是缩小人工核对范围。");
  push("");
  push("| 分类 | 位置 | 选择器 | 声明高度 | 声明 padding |");
  push("|---|---|---|---|---|");
  for (const row of touch.slice(0, 40)) {
    push(`| ${row.level} | \`${row.file}:${row.line}\` | \`${row.selector}\` | ${row.declared ?? "未声明"} | ${row.padding ?? "未声明"} |`);
  }
  if (touch.length > 40) push("");
  if (touch.length > 40) push(`（另有 ${touch.length - 40} 条，用 \`--md=<file>\` 输出完整清单）`);

  const output = lines.join("\n");
  console.log(output);
  if (mdOut) {
    await writeFile(mdOut, `${output}\n`, "utf8");
    console.log(`\n✅ 已写入 ${mdOut}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
