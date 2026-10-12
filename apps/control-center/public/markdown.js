// escape-first Markdown 渲染器——用户友好呈现 CLI 输出，不吐源码，也不给注入面。
// 安全模型：raw 先 redact 再全量 escapeHtml，之后只在"已转义文本"上构造固定白名单标签
// （p/strong/em/del/code/pre/ul/ol/li/blockquote/table/img/hr/a/div/span/input）。用户内容里的
// < > " ' & 已成实体，无法击穿属性或注入标签；链接/图片仅放行 http(s)，其余协议保持纯文本。
// 零第三方依赖，纯字符串操作，CSP-safe。这份 escapeHtml 与 app.js 的同名函数刻意各自内联：
// 安全边界不依赖外部实现，改动别处不破渲染。

// 代码块着色：fence 段先 unescape 还原交给 highlight.js（vendored，自转义输出），
// 未知语言/异常一律回落到已转义原文——着色不引入任何新的注入面。
import hljs from "./vendor/highlight/highlight.mjs";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function unescapeHtml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&amp;", "&");
}

/** 已转义代码 + data-lang → hljs 着色 HTML；任何失败回落已转义原文。 */
function highlightCode(escapedCode, lang) {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(unescapeHtml(escapedCode), { language: lang, ignoreIllegals: true }).value;
    }
  } catch { /* 着色失败不炸渲染，回落纯文本 */ }
  return escapedCode;
}

// 双向隔离：混排中英文里的 RTL 片段（阿拉伯/希伯来，常见于颜文字 `(•̀ᴗ•́)و`）
// 会按 Unicode 双向算法把紧随的数字一起反排——`و 39!` 显示成 `39 و!`。
// 把每段 RTL 包进 <bdi>，让它自成方向岛。段 = 以 RTL 字符起止、中间可夹空格/数字/标点，
// 故连续阿拉伯语句（含年份）是一个整体，而 `و 39` 只隔离 `و`。
const RTL_CHAR = "\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFF";
const RTL_RUN = new RegExp(`[${RTL_CHAR}](?:[${RTL_CHAR}\\s\\d.,،؛-]*[${RTL_CHAR}])?`, "g");

function isolateBidi(html) {
  if (!new RegExp(`[${RTL_CHAR}]`).test(html)) return html;
  // 只改标签之间的文本；标签本身（含 src/alt/href 属性值）原样保留。
  // 输入是已转义文本 + 本模块生成的标签，文本段里不可能出现裸 "<"。
  return html
    .split(/(<[^>]*>)/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(RTL_RUN, "<bdi>$&</bdi>")))
    .join("");
}

function mdInline(escaped) {
  return isolateBidi(mdInlineMarks(escaped));
}

function mdInlineMarks(escaped) {
  return escaped
    // 图片必须先于链接解析（![alt](url) 内含 [alt](url) 结构）；仅 http(s)，alt 已是实体文本
    .replace(/!\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, `<img class="md-img" src="$2" alt="$1" loading="lazy">`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[\s(（])\*([^*\s][^*\n]*?)\*(?=[\s).,;:，。）]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, `<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>`);
}

// —— 表格解析（作用于已转义文本；"|" 不是 HTML 元字符，原样保留） ——

function isTableSeparator(line) {
  const text = String(line || "").trim();
  // 形如 |---|:---:|---:|，必须含 | 与 -，免得把 hr 的 --- 误判成表分隔
  return text.includes("|") && /^\|?[\s:|-]*-[\s:|-]*\|?$/.test(text);
}

function isTableRow(line) {
  const text = String(line || "").trim();
  return text.includes("|") && !isTableSeparator(line) && /[^|\s]/.test(text);
}

function splitTableRow(line) {
  let text = String(line || "").trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
}

function tableAligns(separatorLine) {
  return splitTableRow(separatorLine).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });
}

function tableMarkup(headerLine, separatorLine, bodyLines) {
  const aligns = tableAligns(separatorLine);
  const alignAttr = (index) => (aligns[index] ? ` class="md-ta-${aligns[index]}"` : "");
  const head = splitTableRow(headerLine)
    .map((cell, index) => `<th${alignAttr(index)}>${mdInline(cell)}</th>`)
    .join("");
  const rows = bodyLines
    .map((line) => `<tr>${splitTableRow(line).map((cell, index) => `<td${alignAttr(index)}>${mdInline(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// —— 列表项：普通项保持 <li>…</li> 原样；任务项渲染禁用态 checkbox ——

function listItemMarkup(item) {
  const task = item.match(/^\[( |x|X)\]\s+([\s\S]*)$/);
  if (!task) return `<li>${mdInline(item)}</li>`;
  const checked = task[1].toLowerCase() === "x" ? " checked" : "";
  return `<li class="md-task"><input type="checkbox" class="md-task-check" disabled${checked}><span class="md-task-text">${mdInline(task[2])}</span></li>`;
}

function mdBlocks(escaped) {
  const lines = escaped.split("\n");
  const out = [];
  let list = null; // { tag: "ul"|"ol", items: [] }
  let quote = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${mdInline(paragraph.join("<br>"))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map(listItemMarkup).join("")}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${mdInline(quote.join("<br>"))}</blockquote>`);
    quote = [];
  };
  const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const quoted = line.match(/^&gt;\s?(.*)$/); // 已转义文本里的 "> "
    const hr = line.match(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/);
    // 表格：当前行是数据行且下一行是分隔行时触发，吞掉后续连续数据行
    if (!heading && !bullet && !ordered && !quoted && !hr
      && isTableRow(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      flushAll();
      const bodyLines = [];
      let cursor = index + 2;
      while (cursor < lines.length && isTableRow(lines[cursor]) && lines[cursor].trim()) {
        bodyLines.push(lines[cursor]);
        cursor += 1;
      }
      out.push(tableMarkup(line, lines[index + 1], bodyLines));
      index = cursor - 1; // for 循环会再 +1
    } else if (heading) {
      flushAll();
      out.push(`<div class="md-h md-h${heading[1].length}">${mdInline(heading[2])}</div>`);
    } else if (hr) {
      flushAll();
      out.push('<hr class="md-hr">');
    } else if (bullet || ordered) {
      flushParagraph(); flushQuote();
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((bullet || ordered)[1]);
    } else if (quoted) {
      flushParagraph(); flushList();
      quote.push(quoted[1]);
    } else if (!line.trim()) {
      flushAll();
    } else {
      flushList(); flushQuote();
      paragraph.push(line);
    }
  }
  flushAll();
  return out.join("");
}

/** raw → 安全 HTML。redact 是可选脱敏钩子（默认恒等），在转义前作用于原文。 */
export function renderMarkdown(raw, redact = (value) => value) {
  const segments = escapeHtml(redact(String(raw ?? ""))).split("```");
  let html = "";
  segments.forEach((segment, index) => {
    if (index % 2 === 1) {
      // fence 内不解析任何行内元素，保持代码原貌
      const newline = segment.indexOf("\n");
      const lang = newline >= 0 ? segment.slice(0, newline).trim() : "";
      const code = (newline >= 0 ? segment.slice(newline + 1) : segment).replace(/\n$/, "");
      html += `<div class="code-wrap"><button class="code-copy" type="button" data-copy-code aria-label="复制代码">复制</button><pre class="md-code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${highlightCode(code, lang)}</code></pre></div>`;
    } else {
      html += mdBlocks(segment);
    }
  });
  return html || "<p></p>";
}
