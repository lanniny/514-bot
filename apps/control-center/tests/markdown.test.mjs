import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, escapeHtml } from "../public/markdown.js";

test("escapes HTML metacharacters before any markdown construction", () => {
  const html = renderMarkdown("<script>alert(1)</script>");
  assert.ok(!html.includes("<script>"), "raw script tag must not survive");
  assert.ok(html.includes("&lt;script&gt;"), "angle brackets escaped");
});

test("no attribute breakout via crafted markdown link", () => {
  // 攻击：想用 " 闭合 href 注入事件属性——escape 先行使其成为 &quot;，无法击穿
  const html = renderMarkdown('[x](https://a"onmouseover=alert(1))');
  assert.ok(!/onmouseover=/i.test(html.replace(/&quot;/g, "")) || html.includes("&quot;"), "quote is entity-encoded");
  assert.ok(!html.includes('"onmouseover'), "no literal quote breakout in attribute");
});

test("only http(s) links become anchors; other schemes stay text", () => {
  const evil = renderMarkdown("[click](javascript:alert(1))");
  assert.ok(!evil.includes("<a "), "javascript: scheme must not form a link");
  const ok = renderMarkdown("[docs](https://example.com/path)");
  assert.ok(ok.includes('<a href="https://example.com/path"'), "https link renders");
  assert.ok(ok.includes('rel="noopener noreferrer"'), "external link hardened");
});

test("code fences preserve content literally and are not parsed as markdown", () => {
  const html = renderMarkdown("```js\nconst x = `<b>` + '**no**';\n```");
  assert.ok(html.includes("<pre class=\"md-code\""), "fence becomes pre block");
  assert.ok(html.includes("&lt;b&gt;"), "html inside code escaped");
  assert.ok(!html.includes("<strong>"), "markdown not parsed inside code fence");
});

test("headings, lists, quotes, inline emphasis and code render as friendly HTML", () => {
  const html = renderMarkdown("# 标题\n\n- 一\n- 二\n\n> 引用\n\n**粗** 与 `代码`");
  assert.ok(html.includes('<div class="md-h md-h1">标题</div>'));
  assert.ok(html.includes("<ul><li>一</li><li>二</li></ul>"));
  assert.ok(html.includes("<blockquote>引用</blockquote>"));
  assert.ok(html.includes("<strong>粗</strong>"));
  assert.ok(html.includes("<code>代码</code>"));
});

test("ordered lists and nested inline links inside list items are safe", () => {
  const html = renderMarkdown("1. 见 [源](https://x.io)\n2. 次条");
  assert.ok(html.includes("<ol>"));
  assert.ok(html.includes('<a href="https://x.io"'));
  assert.ok(!html.includes("<script"));
});

test("redact hook runs before escaping so secrets never reach the DOM string", () => {
  const redact = (value) => value.replace(/sk-[a-z0-9]+/gi, "[REDACTED]");
  const html = renderMarkdown("key sk-abc123def456", redact);
  assert.ok(html.includes("[REDACTED]"));
  assert.ok(!html.includes("sk-abc123"));
});

test("escapeHtml is exported and total on the five metacharacters", () => {
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#039;");
});

test("RTL runs are bidi-isolated so trailing digits keep logical order", () => {
  const html = renderMarkdown("stage(•̀ᴗ•́)و 39!");
  assert.ok(html.includes("<bdi>و</bdi> 39!"), html);
  // 连续 RTL 词（含中间空格/数字）是同一个隔离段，不被拆成逐词倒序
  const arabic = renderMarkdown("说：مرحبا بالعالم 2024 م。");
  assert.ok(arabic.includes("<bdi>مرحبا بالعالم 2024 م</bdi>"), arabic);
  // 生成的标签属性不被改写（src/alt 保持原样）
  const img = renderMarkdown("![و](https://example.com/و.png)");
  assert.ok(img.includes('src="https://example.com/و.png"'), img);
  assert.ok(img.includes('alt="و"'), img);
  // 无 RTL 文本输出不变
  assert.ok(!renderMarkdown("hello 39!").includes("<bdi>"));
  // 代码块内不加工
  assert.ok(!renderMarkdown("```\nو 39\n```").includes("<bdi>"));
});
