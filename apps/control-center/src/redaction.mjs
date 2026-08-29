const secretKey = /(?:api[_-]?key|access[_-]?key|token|secret|password|authorization|cookie|private[_-]?key|credential|(?:^|[_-])key$)/i;
const privateReasoningKey = /^(?:thinking|chain[_-]?of[_-]?thought|reasoning[_-]?content|internal[_-]?monologue)$/i;

export function isSensitiveKeyName(value) {
  return secretKey.test(String(value ?? ""));
}

const secretPatterns = [
  { name: "provider credential", pattern: /\b(?:sk-(?:proj-)?|xai-|gh[pousr]_|github_pat_|pat-)[A-Za-z0-9_\-.]{12,}\b/g },
  { name: "Google API credential", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "bearer credential", pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/gi },
  { name: "basic-auth credential", pattern: /\bBasic\s+[A-Za-z0-9+/]{12,}={0,2}\b/gi },
  { name: "JWT-like credential", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];

const PRIVATE_KEY_BOUNDARY = /-----(BEGIN|END) ([A-Z0-9][A-Z0-9 -]{0,160})-----/g;
const PRIVATE_KEY_LABEL = /\bPRIVATE KEY\b/;

export function findPrivateKeyBoundary(value, fromIndex = 0) {
  const text = String(value);
  const matcher = new RegExp(PRIVATE_KEY_BOUNDARY.source, PRIVATE_KEY_BOUNDARY.flags);
  matcher.lastIndex = Math.max(0, Number.isSafeInteger(fromIndex) ? fromIndex : 0);
  while (true) {
    const match = matcher.exec(text);
    if (!match) return null;
    const label = match[2].trim();
    if (PRIVATE_KEY_LABEL.test(label)) {
      return {
        type: match[1],
        label,
        index: match.index,
        end: matcher.lastIndex,
      };
    }
  }
}

function redactPrivateKeyBlocks(value) {
  const text = String(value);
  let cursor = 0;
  let searchFrom = 0;
  let output = "";
  while (true) {
    let begin = findPrivateKeyBoundary(text, searchFrom);
    while (begin && begin.type !== "BEGIN") begin = findPrivateKeyBoundary(text, begin.end);
    if (!begin) return `${output}${text.slice(cursor)}`;

    output += `${text.slice(cursor, begin.index)}[REDACTED]`;
    let end = findPrivateKeyBoundary(text, begin.end);
    while (end && (end.type !== "END" || end.label !== begin.label)) {
      end = findPrivateKeyBoundary(text, end.end);
    }
    if (!end) return output;
    cursor = end.end;
    searchFrom = cursor;
  }
}

export function redactString(value) {
  let output = redactPrivateKeyBlocks(value);
  for (const { pattern } of secretPatterns) output = output.replace(pattern, "[REDACTED]");
  return output;
}

// Strong credential names plus arbitrary identifier suffixes such as
// OPENAI_API_KEY, refresh_token and client_secret. Requiring an assignment
// separator keeps ordinary prose containing words like "token" untouched.
const ASSIGNMENT_KEY = String.raw`(?:api[_-]?keys?|access[_-]?keys?(?:[_-]?ids?)?|private[_-]?keys?|(?:refresh|access|auth|id)[_-]?tokens?|client[_-]?secrets?|passwords?|passwds?|pwd|tokens?|secrets?|keys?|authorization|auth|bearer|cookies?|credentials?|passphrases?|[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*[_-](?:api[_-]?keys?|access[_-]?keys?(?:[_-]?ids?)?|private[_-]?keys?|tokens?|secrets?|keys?|passwords?|cookies?|credentials?|passphrases?))`;
const REFERENCE_VALUE = String.raw`(?:\$\{[A-Z0-9_]+\}|\$env:[A-Z0-9_]+|\$[A-Z_][A-Z0-9_]*|%[A-Z0-9_]+%|(?:env|credential):[A-Z0-9_.-]+)`;
const INLINE_VALUE = String.raw`(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\r\n])*(?:"|(?=\r?\n|$))|'(?:\\.|[^'\\\r\n])*(?:'|(?=\r?\n|$))|(?:Bearer|Basic)\s+${REFERENCE_VALUE}|${REFERENCE_VALUE}|(?:Bearer|Basic)\s+[^\s,"'，;；&?#}\]]+|[^\s,"'，;；&?#}\]]+)`;

// Values stop at structured delimiters, so URL query parameters and adjacent
// JSON fields remain visible. Quoted values support escaped quote characters.
const ASSIGNMENT_SECRET = new RegExp(
  String.raw`(?<![A-Za-z0-9_])(?<keySyntax>(?<keyQuote>["']?)(?<key>${ASSIGNMENT_KEY})\k<keyQuote>)(?<separator>\s*[:=]\s*)(?<value>${INLINE_VALUE})`,
  "gi",
);

const CLI_SECRET = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(?<keySyntax>--(?<key>${ASSIGNMENT_KEY}))(?<separator>\s+)(?<value>${INLINE_VALUE})`,
  "gi",
);

const YAML_BLOCK_HEADER = new RegExp(
  String.raw`^(?<indent>[ \t]*)(?<keySyntax>(?<keyQuote>["']?)(?<key>${ASSIGNMENT_KEY})\k<keyQuote>)(?<separator>\s*:\s*)(?<indicator>[|>](?:[+-][1-9]?|[1-9][+-]?|))\s*(?:#.*)?$`,
  "i",
);

const URL_USERINFO = /(?<prefix>\b[a-z][a-z0-9+.-]*:\/\/)(?<value>[^@\s/?#]+)(?=@)/gi;

const SAFE_REFERENCE = /^(?:\$\{[A-Z0-9_]+\}|\$env:[A-Z0-9_]+|\$[A-Z_][A-Z0-9_]*|%[A-Z0-9_]+%|(?:env|credential):[A-Z0-9_.-]+)$/i;

function unquote(value) {
  if (value.length >= 6 && ((value.startsWith('"""') && value.endsWith('"""')) || (value.startsWith("'''") && value.endsWith("'''")))) {
    return value.slice(3, -3);
  }
  if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function isSafeReference(value) {
  const plain = unquote(value);
  const credential = plain.replace(/^(?:Bearer|Basic)\s+/i, "");
  return SAFE_REFERENCE.test(credential);
}

function isNonSecretScalar(value) {
  return /^(?:true|false|null|-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.test(unquote(value).trim());
}

function splitLines(text) {
  const lines = [];
  let start = 0;
  for (const match of text.matchAll(/\r\n|\n|\r/g)) {
    lines.push({ body: text.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  if (start < text.length) lines.push({ body: text.slice(start), eol: "" });
  return lines;
}

function transformYamlBlocks(text, transform) {
  const lines = splitLines(text);
  const output = [];
  for (let index = 0; index < lines.length;) {
    const header = YAML_BLOCK_HEADER.exec(lines[index].body);
    if (!header) {
      output.push(lines[index].body, lines[index].eol);
      index += 1;
      continue;
    }

    const headerIndent = header.groups.indent.length;
    const explicitIndent = /[1-9]/.exec(header.groups.indicator)?.[0];
    let contentIndent = explicitIndent ? headerIndent + Number(explicitIndent) : null;
    let end = index + 1;
    while (end < lines.length) {
      const line = lines[end].body;
      if (!line.trim()) {
        end += 1;
        continue;
      }
      const indent = /^[ \t]*/.exec(line)[0].length;
      if (contentIndent == null) {
        if (indent <= headerIndent) break;
        contentIndent = indent;
      }
      if (indent < contentIndent) break;
      end += 1;
    }

    const original = lines.slice(index, end).map((line) => `${line.body}${line.eol}`).join("");
    const value = lines.slice(index + 1, end).map((line) => `${line.body}${line.eol}`).join("");
    output.push(transform({ header, headerLine: lines[index], original, value }));
    index = end;
  }
  return output.join("");
}

export function scrubAssignments(text) {
  const redactAssignment = (match, ...args) => {
    const groups = args.at(-1);
    if (isSafeReference(groups.value) || isNonSecretScalar(groups.value)) return match;
    const quote = groups.value.startsWith('"""') ? '"""' : groups.value.startsWith("'''") ? "'''" : groups.value[0];
    const marker = quote === '"' || quote === "'" || quote === '"""' || quote === "'''" ? `${quote}[REDACTED]${quote}` : "[REDACTED]";
    return `${groups.keySyntax}${groups.separator}${marker}`;
  };
  return transformYamlBlocks(String(text), ({ header, headerLine, original, value }) => {
    if (isSafeReference(value.trim())) return original;
    return `${header.groups.indent}${header.groups.keySyntax}${header.groups.separator}"[REDACTED]"${headerLine.eol}`;
  })
    .replace(ASSIGNMENT_SECRET, redactAssignment)
    .replace(CLI_SECRET, redactAssignment);
}

/** 双层文本脱敏：高熵凭据格式 + 赋值型低熵秘密。写盘/出站文本统一入口。 */
export function scrub(text) {
  return scrubAssignments(redactString(String(text))).replace(URL_USERINFO, (match, ...args) => {
    const groups = args.at(-1);
    return isSafeReference(groups.value) ? match : `${groups.prefix}[REDACTED]`;
  });
}

// --- 结构化落盘的健壮性边界 -------------------------------------------------
//
// 下面三条不是理论防御，是实测复现过的故障：
//   1. 循环引用 / 深嵌套 → RangeError 栈溢出。sanitizeForPersistence 位于写盘
//      关键路径（event-store / bus / orchestrator#persistRun / approval-broker），
//      一崩就是整条事件流丢数据，而不是"少脱敏了一点"。
//   2. Buffer 被 Object.entries 拆成 {"0":115,"1":107,...} 的字节索引字典——
//      既把数据毁成无意义形状，又让二进制内容绕过所有字符串脱敏规则。
//   3. Map/Set/Date/URL/Error 被静默压成 {}，BigInt 直接抛 TypeError。
//
// 原则：脱敏器的职责是**去秘密**，不是重新定义数据结构。凡是它认不出来的类型，
// 默认动作应该是"保守放行或显式标记"，绝不应该是"悄悄改成空对象"。
const MAX_PERSIST_DEPTH = 96;
const BINARY_SCRUB_LIMIT = 1 << 20; // 1 MiB：再大就让脱敏本身变成性能事故

function decodeLatin1(bytes) {
  // 分块避免 String.fromCharCode(...arr) 在超大数组上爆栈
  const CHUNK = 0x8000;
  if (bytes.length <= CHUNK) return String.fromCharCode.apply(null, bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function encodeLatin1(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * 二进制分支。latin1 是字节与码位的 1:1 映射，因此"解码 → 脱敏 → 回写"在
 * 没有命中时**完全无损**；一旦命中凭据格式，则按 fail-closed 覆写该区段。
 * 超过上限的 blob 不逐字节扫（避免 DoS），改为显式截断标记——宁可丢内容，
 * 也不能让一个大文件成为凭据的免检通道。
 *
 * 这里刻意只跑 redactString（已知前缀的模式层），不用完整 scrub：
 * scrub 的 scrubAssignments 会做 YAML 分块逐行切分，而二进制内容不是 YAML——
 * 一个 1 MiB 全换行符的 blob 就能让行数组膨胀到百万级，把脱敏器本身变成 DoS 面。
 * 二进制里真正需要拦的（sk-/AIza/AKIA/Bearer/JWT/PEM）redactString 全覆盖。
 */
function sanitizeBinary(view) {
  const bytes = view instanceof ArrayBuffer ? new Uint8Array(view) : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (bytes.byteLength > BINARY_SCRUB_LIMIT) return `[BINARY_TRUNCATED ${bytes.byteLength}B]`;
  const text = decodeLatin1(bytes);
  const safe = redactString(text);
  return safe === text ? view : encodeLatin1(safe);
}

function sanitizeNode(value, key, seen, depth) {
  if (privateReasoningKey.test(key)) return "[NOT_PERSISTED]";
  // 键名疑似凭据时只遮字符串——数字/布尔不可能是密钥（否则 tokens 计量字段被误伤成 [REDACTED]）
  if (isSensitiveKeyName(key)) {
    return value == null || typeof value === "number" || typeof value === "boolean" ? value : "[REDACTED]";
  }

  if (value === null) return null;
  const type = typeof value;
  if (type === "string") return scrub(value);
  if (type === "number" || type === "boolean") return value;
  if (type === "bigint") return `${value}`;          // JSON.stringify 会抛，先降级
  if (type === "function" || type === "symbol") return "[NOT_SERIALIZABLE]";
  if (type !== "object") return String(value);

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return sanitizeBinary(value);
  if (value instanceof Date) return value;           // 无凭据面，原样保留
  if (value instanceof RegExp) return value;
  if (value instanceof URL) return scrub(value.href); // URL 可携带 userinfo 凭据
  if (value instanceof Error) return { name: String(value.name || "Error"), message: scrub(String(value.message ?? "")) };

  if (depth >= MAX_PERSIST_DEPTH) return "[TRUNCATED:depth]";
  if (seen.has(value)) return "[CIRCULAR]";

  if (value instanceof Map) {
    seen.add(value);
    try {
      return Object.fromEntries([...value.entries()].map(([mapKey, mapValue]) => [
        String(mapKey),
        sanitizeNode(mapValue, String(mapKey), seen, depth + 1),
      ]));
    } finally {
      seen.delete(value); // 路径作用域：同一个对象在不同分支重复出现不算环
    }
  }
  if (value instanceof Set) {
    seen.add(value);
    try {
      return [...value].map((item) => sanitizeNode(item, "", seen, depth + 1));
    } finally {
      seen.delete(value);
    }
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitizeNode(item, "", seen, depth + 1));
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeNode(childValue, childKey, seen, depth + 1),
      ]),
    );
  } finally {
    seen.delete(value);
  }
}

export function sanitizeForPersistence(value, key = "") {
  return sanitizeNode(value, key, new WeakSet(), 0);
}

export function findSecretCandidates(content) {
  const blockers = new Set();
  let privateBoundary = findPrivateKeyBoundary(content);
  while (privateBoundary && privateBoundary.type !== "BEGIN") {
    privateBoundary = findPrivateKeyBoundary(content, privateBoundary.end);
  }
  if (privateBoundary) blockers.add("private key material is not allowed in repository configuration");
  for (const { name, pattern } of secretPatterns) {
    const tester = new RegExp(pattern.source, pattern.flags.replace("g", ""));
    if (tester.test(content)) blockers.add(`${name} is not allowed in repository configuration`);
  }
  transformYamlBlocks(String(content), ({ original, value }) => {
    const plain = value.trim();
    if (!isSafeReference(plain) && plain.length >= 12) {
      blockers.add("secret-like literal detected; use an environment or OS credential reference");
    }
    return original;
  });
  for (const source of [ASSIGNMENT_SECRET, CLI_SECRET]) {
    const assignment = new RegExp(source.source, source.flags);
    for (const match of String(content).matchAll(assignment)) {
      const value = match.groups?.value?.trim() ?? "";
      if (!isSafeReference(value)) {
        const plain = unquote(value);
        if (plain.length >= 12 || /^(?:Basic|Bearer)\s+/i.test(plain)) {
          blockers.add("secret-like literal detected; use an environment or OS credential reference");
        }
      }
    }
  }
  for (const match of String(content).matchAll(new RegExp(URL_USERINFO.source, URL_USERINFO.flags))) {
    if (!isSafeReference(match.groups?.value ?? "")) {
      blockers.add("secret-like literal detected; use an environment or OS credential reference");
    }
  }
  return [...blockers];
}
