import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import { findHighConfidenceSecrets, findSecretCandidates } from "./redaction.mjs";

export const FILE_EVIDENCE_LIMITS = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024,   // 2 MiB maximum file scan
  maxExcerptBytes: 64 * 1024,      // 64 KiB maximum excerpt size
  maxExcerptLines: 1_000,          // 1000 lines maximum per excerpt
});

const SENSITIVE_FILENAME_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /\.(?:pem|key|pkcs12|pfx|p12)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /(?:credentials|token|secret|password)[^/\\]*$/i,
  // 2026-09-18 P0：按文件名判据必须覆盖"配置即密钥库"这一类。
  // 实测漏网：`.ai-shared/control-center/providers.json`（31 KB，含 14 个真实
  // sk- 云 API key）文件名不含 token/secret/credential，却能整份载入并随消息
  // 出境。文件名判据是第二道防线，真正的防线是下面的内容层扫描。
  /^(?:providers?|credentials?|secrets?)(?:[-._][^/\\]*)?\.(?:json|ya?ml|toml|ini|conf|config)$/i,
  /(?:cc-?switch)[^/\\]*$/i,
  /^\.(?:npmrc|netrc|pgpass|htpasswd)$/i,
];

const BLOCKED_DIRECTORY_NAMES = new Set([
  ".git",
  ".ssh",
  ".gnupg",
  ".aws",
  ".docker",
]);

function fail(message, code = "FILE_EVIDENCE_ERROR") {
  throw Object.assign(new Error(message), { code });
}

/** 结构化配置类扩展名：这类文件里出现赋值型键值就是凭据本体的强信号。 */
const STRUCTURED_CONFIG_EXT = /\.(?:json5?|jsonc|ya?ml|toml|ini|cfg|conf|config|properties|env(?:\..+)?)$/i;

export function isSensitivePath(relativePath) {
  const normalized = normalize(String(relativePath || "")).replace(/^[/\\]+/, "");
  const parts = normalized.split(/[/\\]/);
  for (const part of parts) {
    if (BLOCKED_DIRECTORY_NAMES.has(part.toLowerCase())) return true;
    for (const pattern of SENSITIVE_FILENAME_PATTERNS) {
      if (pattern.test(part)) return true;
    }
  }
  return false;
}

export function isBinaryBuffer(buffer, sampleSize = 8192) {
  const length = Math.min(buffer.length, sampleSize);
  for (let i = 0; i < length; i++) {
    if (buffer[i] === 0x00) return true;
  }
  return false;
}

export async function parseProjectFileExcerpt(projectCwd, relativePath, options = {}) {
  const {
    startLine: rawStart = 1,
    endLine: rawEnd = null,
    maxBytes = FILE_EVIDENCE_LIMITS.maxExcerptBytes,
    maxLines = FILE_EVIDENCE_LIMITS.maxExcerptLines,
  } = options;

  if (!projectCwd || typeof projectCwd !== "string") {
    fail("projectCwd must be a valid directory path", "INVALID_PROJECT_CWD");
  }

  const cleanRelative = String(relativePath || "").trim().replace(/^[/\\]+/, "");
  if (!cleanRelative) {
    fail("relativePath is required", "INVALID_RELATIVE_PATH");
  }

  if (isSensitivePath(cleanRelative)) {
    fail(`access to sensitive or protected path is forbidden: ${cleanRelative}`, "FILE_ACCESS_FORBIDDEN");
  }

  const rootNormalized = resolve(projectCwd);
  const targetResolved = resolve(rootNormalized, cleanRelative);

  const relCheck = relative(rootNormalized, targetResolved);
  if (relCheck.startsWith("..") || isAbsolute(relCheck)) {
    fail("path traversal outside project workspace is blocked", "PATH_TRAVERSAL_BLOCKED");
  }

  let fileStat;
  try {
    fileStat = await stat(targetResolved);
  } catch (error) {
    if (error.code === "ENOENT") {
      fail(`file not found: ${cleanRelative}`, "FILE_NOT_FOUND");
    }
    fail(`failed to access file: ${error.message}`, "FILE_ACCESS_ERROR");
  }

  if (!fileStat.isFile()) {
    fail(`target path is not a regular file: ${cleanRelative}`, "NOT_A_FILE");
  }

  if (fileStat.size > FILE_EVIDENCE_LIMITS.maxFileBytes) {
    fail(`file size (${fileStat.size} bytes) exceeds limit of ${FILE_EVIDENCE_LIMITS.maxFileBytes} bytes`, "FILE_TOO_LARGE");
  }

  // Symlink check via realpath
  try {
    const realTarget = await realpath(targetResolved);
    const realRel = relative(rootNormalized, realTarget);
    if (realRel.startsWith("..") || isAbsolute(realRel)) {
      fail("symbolic link pointing outside workspace is forbidden", "SYMLINK_OUTSIDE_WORKSPACE");
    }
  } catch (error) {
    fail(`failed to resolve real path: ${error.message}`, "REALPATH_ERROR");
  }

  // 2026-09-18：经句柄读取，并在读前复核 stat 与句柄指向同一 inode。
  // 上面的 stat/realpath 与随后的 readFile 之间存在替换窗口（TOCTOU）——
  // 校验过的软链/常规文件可以在读取瞬间被换成别的东西。句柄绑定 inode，
  // 因此句柄自述的 dev/ino 才是"实际读到的那个文件"的可信来源。
  let handle;
  try {
    handle = await open(targetResolved, "r");
  } catch (error) {
    if (error.code === "ENOENT") {
      fail(`file not found: ${cleanRelative}`, "FILE_NOT_FOUND");
    }
    fail(`failed to access file: ${error.message}`, "FILE_ACCESS_ERROR");
  }

  let buffer;
  try {
    const handleStat = await handle.stat();
    if (!handleStat.isFile()) {
      fail(`target path is not a regular file: ${cleanRelative}`, "NOT_A_FILE");
    }
    if (fileStat.ino && handleStat.ino && fileStat.ino !== handleStat.ino) {
      fail("target file was replaced between validation and read", "FILE_CHANGED_DURING_READ");
    }
    buffer = await handle.readFile();
    if (buffer.length !== handleStat.size) {
      // 读到的字节数与句柄自述不符 = 读取期间被改写，内容不再可信
      fail("target file changed while being read", "FILE_CHANGED_DURING_READ");
    }
  } finally {
    await handle.close().catch(() => {});
  }

  if (isBinaryBuffer(buffer)) {
    fail(`binary file format not supported for text evidence: ${cleanRelative}`, "BINARY_FILE_UNSUPPORTED");
  }

  const rawText = buffer.toString("utf8");

  // 内容层密钥检测：整份文件扫，不只看被摘录的那几行——否则"请求 1-50 行"
  // 就能绕过第 500 行的密钥。判据复用运行时脱敏模块（src/redaction.mjs），
  // 不另立一套弱规则（原则同 scripts/secret-audit.mjs：两个工具对同一段内容
  // 必须给出一致结论）。
  // 这是本模块真正的安全边界：文件名可以被随便取，内容里的 sk-/AKIA/JWT/PEM
  // 骗不了人。宁可误拒一个含示例密钥的文档，也不能把真密钥送出境。
  // 分层：配置类文件吃完整判据（含赋值型），源码/文档只吃凭据格式层——
  // 见 redaction.mjs findHighConfidenceSecrets 的实测误报说明。
  const secretReasons = STRUCTURED_CONFIG_EXT.test(cleanRelative)
    ? findSecretCandidates(rawText)
    : findHighConfidenceSecrets(rawText);
  if (secretReasons.length) {
    fail(
      `file content contains secret-like material (${secretReasons.length} rule(s) matched) and cannot be loaded as evidence`,
      "FILE_ACCESS_FORBIDDEN",
    );
  }

  const allLines = rawText.split(/\r?\n/);
  const totalLines = allLines.length;

  let startLine = Number.parseInt(rawStart, 10);
  if (!Number.isFinite(startLine) || startLine < 1) startLine = 1;
  if (startLine > totalLines) startLine = totalLines;

  let endLine = rawEnd != null ? Number.parseInt(rawEnd, 10) : null;
  if (endLine == null || !Number.isFinite(endLine) || endLine < startLine) {
    endLine = Math.min(totalLines, startLine + maxLines - 1);
  }
  if (endLine > totalLines) endLine = totalLines;

  if (endLine - startLine + 1 > maxLines) {
    endLine = startLine + maxLines - 1;
  }

  const excerptLines = allLines.slice(startLine - 1, endLine);
  let content = excerptLines.join("\n");
  let contentBuffer = Buffer.from(content, "utf8");

  let truncated = false;
  if (contentBuffer.length > maxBytes) {
    contentBuffer = contentBuffer.subarray(0, maxBytes);
    content = contentBuffer.toString("utf8");
    truncated = true;
  }

  const sha256 = createHash("sha256").update(contentBuffer).digest("hex");

  return {
    relativePath: cleanRelative.replace(/\\/g, "/"),
    startLine,
    endLine,
    totalLines,
    lineCount: endLine - startLine + 1,
    content,
    byteLength: contentBuffer.length,
    sha256,
    truncated,
  };
}

export function formatFileEvidenceBlock(excerpt) {
  if (!excerpt || typeof excerpt !== "object") return "";
  const header = `--- [文件证据: ${excerpt.relativePath}#L${excerpt.startLine}-L${excerpt.endLine} (共 ${excerpt.totalLines} 行${excerpt.truncated ? " · 已截断" : ""})] ---`;
  const footer = `--- [文件证据结束: ${excerpt.sha256.slice(0, 12)}] ---`;
  return `${header}\n${excerpt.content}\n${footer}`;
}
