import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

async function source(path) {
  // Windows 工作区源码是 CRLF：统一归一化为 LF（同 codex-process-visibility）
  return (await readFile(`${root}/${path}`, "utf8")).replace(/\r\n/g, "\n");
}

// 源文件正则断言失败会把整份文件打进输出——一律用 includes 断言字面片段
function assertIncludes(source, snippet, message) {
  assert.ok(source.includes(snippet), message ?? `缺少：${snippet}`);
}

// LO 2026-08-16 实拍：审批卡 / 「已创建隔离工作树」系统卡 / 「第 N 轮」分隔全部贴左而非居中。
// 居中机制 = codex-desktop.css 的 .conversation-stream > * { width:100%; max-width; margin-inline:auto }。
// 两个破口：①console-form.css 曾写 .gov-note/.approval-inline { margin-left:0 }——同特异性且最后加载，
// 盖掉 margin-inline:auto 的左半（右 auto 残留 → 贴左）；②styles.css 的
// .conversation-stream .turn-divider { margin:14px 0 10px } 特异性更高，一直钉死左右 margin 为 0（存量）。
test("governance notes and inline approvals stay centered in the reading column", async () => {
  const css = await source("public/forge/console-form.css");
  assertIncludes(css, ".gov-note,\n.approval-inline,\n.process-note,\n.process-card {\n  margin-inline: auto;\n}");
  // 不许再出现把 auto 左半盖掉的写法
  const block = css.slice(css.indexOf(".gov-note,"), css.indexOf(".gov-note,") + 400);
  assert.ok(!block.includes("margin-left: 0"), "gov-note/approval-inline 不允许 margin-left:0（会盖掉 margin-inline:auto）");
});

test("turn divider re-centers against the higher-specificity margin shorthand", async () => {
  const css = await source("public/forge/console-form.css");
  assertIncludes(css, ".conversation-stream .turn-divider {\n  margin-inline: auto;\n}");
});

test("the centering mechanism itself stays intact upstream", async () => {
  const codexDesktop = await source("public/forge/codex-desktop.css");
  assertIncludes(codexDesktop, ".conversation-stream > * {");
  assertIncludes(codexDesktop, "margin-inline: auto;");
  const formCss = await source("public/forge/console-form.css");
  assertIncludes(formCss, ".conversation-stream > * {\n  max-width: 768px;\n}");
});
