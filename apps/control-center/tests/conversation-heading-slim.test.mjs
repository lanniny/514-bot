// 收敛层·第六轮契约：会话头单行 slim 标题栏（LO 2026-08-17 供图 Codex 桌面顶栏红圈处）
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

async function source(path) {
  // Windows 工作区源码是 CRLF：统一归一化为 LF（同 codex-process-visibility）
  return (await readFile(`${root}/${path}`, "utf8")).replace(/\r\n/g, "\n");
}

function assertIncludes(source, snippet, message) {
  assert.ok(source.includes(snippet), message ?? `缺少：${snippet}`);
}

test("title glyph is a class-only span before h2 (no id → no elements registry entry)", async () => {
  const html = await source("public/index.html");
  assert.match(
    html,
    /<span class="conversation-title-glyph" aria-hidden="true"><svg[^>]*class="icon lucide"[^>]*><use href="#lucide-messages-square"><\/use><\/svg><\/span>\s*<h2 id="conversation-title">/,
  );
  const app = await source("public/app.js");
  assert.ok(!app.includes('"conversation-title-glyph"'), "glyph 不得进 elements 清单（无 id 元素）");
});

test("heading-main becomes a single-line row with ellipsis title", async () => {
  const css = await source("public/forge/console-form.css");
  assertIncludes(css, "#view-workbench .conversation-heading .conversation-heading-main {\n  flex-direction: row;\n  align-items: center;\n  flex-wrap: wrap;");
  const h2 = css.slice(css.indexOf("#view-workbench .conversation-heading h2 {", css.indexOf("收敛层·第六轮")));
  assertIncludes(h2, "white-space: nowrap;");
  assertIncludes(h2, "text-overflow: ellipsis;");
  assertIncludes(h2, "-webkit-line-clamp: unset;");
  assertIncludes(css, "#view-workbench .conversation-title-glyph {");
});

test("meta pill shows only the step budget; audit segments live in the tooltip", async () => {
  const app = await source("public/app.js");
  assertIncludes(app, "const metaParts = [maxSteps > 0 ? `本次步骤 ${interactionStep}/${maxSteps}` : `总轮次 ${totalRounds}`];");
  const titleBlock = app.slice(app.indexOf('elements["conversation-meta"].title'), app.indexOf('elements["conversation-meta"].title') + 600);
  for (const seg of ["`run ${run.id}`", "`创建于 ${formatDate(run.createdAt)}`", "总轮次 ${totalRounds} · 交互 ${interactionSeq}", "写盘隔离于工作树：${run.worktreePath}"]) {
    assertIncludes(titleBlock, seg, `tooltip 缺审计段：${seg}`);
  }
  const css = await source("public/forge/console-form.css");
  assertIncludes(css, "#view-workbench #conversation-meta {\n  max-width: 30%;\n}");
});

test("wave-6 glyph icon exists in the lucide manifest", async () => {
  const manifest = JSON.parse(await source("public/lucide-icons.json"));
  const names = new Set((manifest.icons ?? []).map((icon) => icon.name ?? icon));
  assert.ok(names.has("messages-square"), "lucide manifest 缺少 messages-square");
});

// 第六轮实机抓获：`var(--line)` 从未在任何文件定义过——console-form 前四轮 9 处
// border 发丝线（含会话头分隔线）全部静默失效（borderBottomWidth 实测 0px）。
// var() 未定义 = 整条 border shorthand 无效，node --check 与人工 review 都看不出来。
test("no reference to the never-defined --line token remains", async () => {
  for (const path of ["public/forge/console-form.css", "public/styles.css"]) {
    const css = await source(path);
    assert.ok(!css.includes("var(--line)"), `${path} 仍引用未定义的 --line（应为 --border）`);
  }
});
