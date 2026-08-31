// 514cc 会话聚合服务（v3.5 桌面版增量，codeg "读各 CLI 本地会话存储"思路）：
// 统一列出四源会话元数据——Claude Code（~/.claude/projects/*/*.jsonl）、
// Codex（~/.codex/sessions 递归 rollout jsonl）、对话桥（.ai-shared/roster.json）、
// Grok Build（~/.grok 会话目录，best-effort 探测）。
// 项目树另按 cwd 归并 Kimi/Pi/Cursor（v3.7 codeg 对标扩源，共用 #foldSessionGroups 管线）。
// 每源独立 try/catch：拿得到就列，拿不到如实标 unavailable——绝不伪造。
// 只读元数据 + 首条用户消息摘要（截断），不回传完整会话内容（隐私面最小化）。
import { cp, open, readFile, readdir, realpath, rename, rm, stat, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { normalizePathKey } from "../public/path-key.js";
import { scrub } from "./redaction.mjs";

const SUMMARY_SCAN_BYTES = 64 * 1024;
const SUMMARY_MAX_CHARS = 140;
// Cursor 预览/摘要的点查上限：bubble 按 key 逐条参数化点查（绝无 LIKE 全表扫），
// assistant 空 text 顺延但不能无界——预览取最近 50 条有文本的，最多点查 150 个 bubble
const CURSOR_PREVIEW_MAX_MESSAGES = 50;
const CURSOR_PREVIEW_MAX_BUBBLES = 150;
const CURSOR_SUMMARY_MAX_BUBBLES = 12;
const PROJECT_SNAPSHOT_TTL_MS = 1500;
const PROJECT_SNAPSHOT_MAX_KEYS = 16;
const KIMI_INDEX_BATCH_SIZE = 64;
const KIMI_INDEX_IO_CONCURRENCY = 8;

async function mapConcurrent(items, concurrency, visit) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await visit(items[index], index);
      }
    }),
  );
  return results;
}

function compareSessionRecency(left, right) {
  return (right._ms ?? 0) - (left._ms ?? 0) || (left._ordinal ?? 0) - (right._ordinal ?? 0);
}

// sessions 始终按新到旧排列，插入后只保留 capacity 个候选；索引再大也不会让单 cwd 线性涨内存。
function retainNewestSession(sessions, session, capacity) {
  let low = 0;
  let high = sessions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareSessionRecency(session, sessions[middle]) < 0) high = middle;
    else low = middle + 1;
  }
  sessions.splice(low, 0, session);
  if (sessions.length > capacity) sessions.pop();
}

function cloneSnapshot(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

// 项目目录名 / 会话 id 白名单（preview 直接拼文件路径，必须拒绝分隔符与 ".." 遍历）
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Windows 设备保留名（CON/NUL/COM1…）打开的是设备不是文件；尾点名 Win32 层会静默去点（烛 R5 建议）
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const PREVIEW_TAIL_BYTES = 1024 * 1024;
const PREVIEW_MAX_MESSAGES = 60;
const PREVIEW_CHAR_LIMIT = 600;
const HEAD_SCAN_MAX_BYTES = 4 * 1024 * 1024;
const HEAD_SCAN_MAX_LINE = 2 * 1024 * 1024;

function safePathName(value) {
  const name = String(value ?? "");
  return SAFE_NAME.test(name) && !WINDOWS_RESERVED.test(name) && !name.endsWith(".");
}

// 双层脱敏（高熵凭据 + 赋值型低熵秘密）单一信源在 redaction.mjs（烛 v3.6 致命4 收敛正则副本）。

// 流式逐行扫头部：对每个完整行调用 visit(line)，返回非空即早停。
// 固定 64KB 窗口的旧实现会被 >64KB 的单行大事件挡住（烛 R5 实测：本机有会话首行 522KB）——
// 这里跳过超过 maxLine 的行继续扫，找到目标即停，避免为长会话整读大块。
async function scanHeadLines(path, visit, { maxBytes = HEAD_SCAN_MAX_BYTES, maxLine = HEAD_SCAN_MAX_LINE } = {}) {
  const handle = await open(path, "r");
  try {
    const chunkSize = SUMMARY_SCAN_BYTES;
    const buffer = Buffer.alloc(chunkSize);
    const decoder = new StringDecoder("utf8"); // chunk 边界的多字节字符不撕裂
    let position = 0;
    let carry = "";
    let skippingOversizedLine = false;
    while (position < maxBytes) {
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
      if (!bytesRead) break;
      position += bytesRead;
      const lines = (carry + decoder.write(buffer.subarray(0, bytesRead))).split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (skippingOversizedLine) {
          skippingOversizedLine = false; // 超长行的尾巴，丢弃后恢复正常扫描
          continue;
        }
        const result = visit(line);
        if (result != null) return result;
      }
      if (carry.length > maxLine) {
        carry = "";
        skippingOversizedLine = true;
      }
    }
    if (!skippingOversizedLine && carry) {
      const result = visit(carry + decoder.end());
      if (result != null) return result;
    }
    return null;
  } finally {
    await handle.close();
  }
}

function clip(text) {
  // 先脱敏再截断（烛 R-P2 致命1）：截断不是脱敏。双层——redactString（高熵凭据格式）
  // + scrub 赋值型（password=xxx 这类 redactString 盲区，烛 R8 致命）。
  const flat = scrub(text).replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_MAX_CHARS ? `${flat.slice(0, SUMMARY_MAX_CHARS)}…` : flat;
}

// Claude Code 会话开头常见的系统包装块（本地命令 caveat / 命令回显 / system-reminder）——
// 不剥掉的话会话标题全是 "<local-command-caveat>Caveat: ..." 这类无区分度文本
const SYSTEM_WRAPPER_BLOCKS =
  /<(local-command-caveat|local-command-stdout|command-name|command-message|command-args|system-reminder|task-notification)>[\s\S]*?<\/\1>/g;

/** 剥掉系统包装块后剩余的真实用户文本；全是包装（或包装被扫描窗口截断）则返回 null。 */
function meaningfulUserText(raw) {
  const text = String(raw).replace(SYSTEM_WRAPPER_BLOCKS, " ").trim();
  if (!text) return null;
  if (/^<(?:local-command|command-|system-reminder|task-notification)/.test(text)) return null; // 未闭合的包装块
  // Codex rollout 注入样板：AGENTS.md 全文 / 环境上下文 / user_instructions 包裹——不是真实输入
  if (/^# AGENTS\.md instructions\b/.test(text)) return null;
  if (/^<(?:environment_context|user_instructions|INSTRUCTIONS)\b/.test(text)) return null;
  return text;
}

/** 单行判定：这一行是否携带真实用户消息文本（Claude/Codex 事件行格式差异都走 best-effort）。 */
function userTextFromLine(line) {
  if (!line.trim().startsWith("{")) return null;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null; // 截断的半行
  }
  if (event.isMeta === true) return null; // 命令回显等元事件不算用户输入
  // 候选形态（烛 R-P2：Codex rollout 行是 payload:{role,content} 直挂）：
  // Claude {message:{role,content}} / Codex {payload:{role,content}} 或 {payload:{message:{...}}} / 裸 {role,content}
  const message = event.message ?? event.payload?.message ?? event.payload ?? event;
  const role = message?.role ?? event.role ?? event.type;
  if (role !== "user") return null;
  const content = message?.content ?? event.content;
  let candidate = null;
  if (typeof content === "string") candidate = content;
  else if (Array.isArray(content)) {
    const parts = content.filter((part) => typeof part?.text === "string" && part.text.trim()).map((part) => part.text);
    if (parts.length) candidate = parts.join("\n");
  }
  if (!candidate?.trim()) return null;
  const meaningful = meaningfulUserText(candidate);
  return meaningful ? clip(meaningful) : null;
}

/** 从文件头部流式找第一条用户消息摘要。 */
function firstUserTextFromFile(path) {
  return scanHeadLines(path, userTextFromLine);
}

/** 单行判定：cwd 字段（Claude 顶层 cwd；Codex rollout 在 session_meta 的 payload.cwd）。 */
function cwdFromLine(line) {
  if (!line.trim().startsWith("{")) return null;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof event.cwd === "string" && event.cwd.trim()) return event.cwd.trim();
  const payloadCwd = event.payload?.cwd;
  return typeof payloadCwd === "string" && payloadCwd.trim() ? payloadCwd.trim() : null;
}

/**
 * cwd 归一化分组键。会话可能来自另一平台，不能用当前 process.platform 猜语义：
 * - Windows drive / UNC：分隔符统一为反斜杠，大小写不敏感；
 * - POSIX：只去多余尾部正斜杠，保留大小写，反斜杠仍是合法文件名字面量。
 */
export const normalizeCwdKey = normalizePathKey;

/** FNV-1a 32bit：合成项目 id 的稳定散列——中文路径 slug 化会塌缩（G:\learn\数据结构 → g-learn），
   必须靠散列保唯一，否则整组中文目录共享一个 id（菜单/展开/选中全部串台，实测踩过）。 */
function fnv1aHex(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Codex rollout 文件名 → 树内短标签：rollout-2026-07-18T21-30-02-… → "07-18 21:30"。 */
function codexFileLabel(name) {
  const match = /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/.exec(name);
  return match ? `${match[2]}-${match[3]} ${match[4]}:${match[5]}` : null;
}

/** 单行判定：codex session_meta（cwd + 子代理来源 + 昵称）——主对话与编排派生会话的区分依据。 */
function codexMetaFromLine(line) {
  if (!line.trim().startsWith("{")) return null;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event.type !== "session_meta" || !event.payload || typeof event.payload !== "object") return null;
  const payload = event.payload;
  const cwd = typeof payload.cwd === "string" && payload.cwd.trim() ? payload.cwd.trim() : null;
  if (!cwd) return null;
  return {
    cwd,
    subagent: payload.thread_source === "subagent" || Boolean(payload.source?.subagent),
    nickname: typeof payload.agent_nickname === "string" && payload.agent_nickname.trim() ? payload.agent_nickname.trim() : null,
  };
}

/** 路径末段（跨 win32/posix 分隔符），用作项目显示名。 */
function lastSegment(path) {
  return String(path).split(/[\\/]/).filter(Boolean).pop() ?? String(path);
}

/** 单行判定：kimi wire.jsonl 的用户输入（turn.prompt 事件，origin.kind==="user"，2026-07-20 实测）。 */
function kimiPromptFromLine(line) {
  if (!line.trim().startsWith("{")) return null;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event.type !== "turn.prompt" || event.origin?.kind !== "user") return null;
  const parts = (Array.isArray(event.input) ? event.input : [])
    .filter((part) => typeof part?.text === "string" && part.text.trim())
    .map((part) => part.text);
  if (!parts.length) return null;
  const meaningful = meaningfulUserText(parts.join("\n"));
  return meaningful ? clip(meaningful) : null;
}

/** 单行判定：pi 会话首行 meta 的 cwd（{type:"session", cwd}，v3 格式 2026-07-20 实测）。 */
function piCwdFromLine(line) {
  if (!line.trim().startsWith("{")) return null;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event.type !== "session") return null;
  return typeof event.cwd === "string" && event.cwd.trim() ? event.cwd.trim() : null;
}

/** Pi 会话文件名 → 树内短标签：2026-06-18T13-30-40-328Z_uuid → "06-18 13:30"。 */
function piFileLabel(name) {
  const match = /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/.exec(name);
  return match ? `${match[2]}-${match[3]} ${match[4]}:${match[5]}` : null;
}

// ===== Cursor 存储（state.vscdb，2026-07-20 本机实测格式，fail-closed 不猜旧 key） =====
// 权威列表：ItemTable key=composer.composerHeaders → JSON allComposers[]（composerId/name/
// createdAt(ms)/lastUpdatedAt(ms)/isArchived/isDraft/workspaceIdentifier.uri.fsPath/trackedGitRepos）。
// 消息：cursorDiskKV key=composerData:<id> → fullConversationHeadersOnly[{bubbleId,type,createdAt}]，
// 再按 bubbleId:<id>:<bubbleId> 点查单条（type 1=user/2=assistant，text 字段，assistant 常为空）。
// 坑：agentKv:blob:* 是逗号分隔字节数组编码——不读不解析。

/** Cursor globalStorage 目录（已知 CLI 会话存储根，与 ~/.claude/projects 同待遇；限根只到这一层）。 */
function cursorGlobalStorageDir(home) {
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Cursor", "User", "globalStorage");
  if (process.platform === "win32") return join(home, "AppData", "Roaming", "Cursor", "User", "globalStorage");
  return join(home, ".config", "Cursor", "User", "globalStorage");
}

/** 只读打开 state.vscdb；node:sqlite 缺失或 WAL 占用时回退 immutable URI；全失败返回 null（fail-closed）。 */
async function openCursorDb(dbPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite")); // 懒加载：老 Node 无此模块时只影响 cursor 源
  } catch {
    return null;
  }
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    try {
      return new DatabaseSync(`file:${dbPath.replaceAll("\\", "/")}?immutable=1`);
    } catch {
      return null;
    }
  }
}

/** sqlite 值 → utf8 文本（node:sqlite 的 BLOB 可能是 Buffer 或 Uint8Array，后者 toString 不带编码）。 */
function dbText(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  return String(value);
}

/** 会话列表权威来源；key 缺失/表漂移/JSON 损坏一律返回 null（fail-closed，不猜旧格式伪造）。 */
function readCursorComposerHeaders(db) {
  let row;
  try {
    row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("composer.composerHeaders");
  } catch {
    return null;
  }
  const text = dbText(row?.value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.allComposers) ? parsed.allComposers : null;
  } catch {
    return null;
  }
}

/** 项目归并 cwd：优先 workspace fsPath，回退首个 trackedGitRepos.repoPath。 */
function cursorComposerCwd(composer) {
  const fsPath = composer?.workspaceIdentifier?.uri?.fsPath;
  if (typeof fsPath === "string" && fsPath.trim()) return fsPath.trim();
  const repo = Array.isArray(composer?.trackedGitRepos) ? composer.trackedGitRepos[0]?.repoPath : null;
  return typeof repo === "string" && repo.trim() ? repo.trim() : null;
}

/** composerData:<id> 的消息头数组；缺 key/损坏返回 null。 */
function cursorConversationHeaders(db, composerId) {
  let row;
  try {
    row = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(`composerData:${composerId}`);
  } catch {
    return null;
  }
  const text = dbText(row?.value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.fullConversationHeadersOnly) ? parsed.fullConversationHeadersOnly : null;
  } catch {
    return null;
  }
}

/** 按 key 精确点查单条 bubble（参数化查询；bubbleId 形态不符直接放弃，绝不拼 LIKE）。 */
function cursorBubble(db, composerId, bubbleId) {
  if (!/^[A-Za-z0-9-]+$/.test(String(bubbleId))) return null;
  let row;
  try {
    row = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(`bubbleId:${composerId}:${bubbleId}`);
  } catch {
    return null;
  }
  const text = dbText(row?.value);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 首条摘要：第一条 type=1 且 text 非空的 bubble（assistant 空 text 顺延，点查有界）。 */
function cursorFirstUserText(db, composerId) {
  const headers = cursorConversationHeaders(db, composerId);
  if (!headers) return null;
  let probed = 0;
  for (const header of headers) {
    if (header?.type !== 1 || typeof header.bubbleId !== "string") continue;
    if (++probed > CURSOR_SUMMARY_MAX_BUBBLES) break;
    const text = cursorBubble(db, composerId, header.bubbleId)?.text;
    if (typeof text !== "string" || !text.trim()) continue;
    const meaningful = meaningfulUserText(text);
    if (meaningful) return clip(meaningful);
  }
  return null;
}

/** 读文件尾部 maxBytes（大会话文件不整读）。 */
async function tailText(path, maxBytes) {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return { text: buffer.toString("utf8"), truncatedHead: start > 0 };
  } finally {
    await handle.close();
  }
}

async function collectJsonl(root, { maxDepth, limit }) {
  const capacity = Math.max(0, Math.floor(Number(limit) || 0));
  if (capacity === 0) return Object.assign([], { totalCount: 0 });

  // 扫完整棵树，但只在内存中保留 top-k。heap[0] 永远是当前候选里最旧（同 mtime
  // 时路径字典序较大的排后），因此目录枚举顺序不会在全局 mtime 排序前淘汰新文件。
  const newest = [];
  let totalCount = 0;
  const compareQuality = (a, b) => a.mtimeMs - b.mtimeMs || b.path.localeCompare(a.path);
  const swap = (left, right) => {
    [newest[left], newest[right]] = [newest[right], newest[left]];
  };
  const siftDown = (start) => {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < newest.length && compareQuality(newest[left], newest[worst]) < 0) worst = left;
      if (right < newest.length && compareQuality(newest[right], newest[worst]) < 0) worst = right;
      if (worst === index) return;
      swap(index, worst);
      index = worst;
    }
  };
  const retainIfNewest = (file) => {
    if (newest.length < capacity) {
      newest.push(file);
      let index = newest.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (compareQuality(newest[index], newest[parent]) >= 0) break;
        swap(index, parent);
        index = parent;
      }
      return;
    }
    if (compareQuality(file, newest[0]) <= 0) return;
    newest[0] = file;
    siftDown(0);
  };

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let names;
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    names.sort((a, b) => a.name.localeCompare(b.name)); // 稳定遍历，回归与同 mtime 取舍不依赖文件系统枚举顺序
    for (const entry of names) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const info = await stat(path);
          totalCount += 1;
          retainIfNewest({ path, name: entry.name, dir, size: info.size, mtimeMs: info.mtimeMs });
        } catch {
          // 扫描期间消失的文件跳过
        }
      }
    }
  }
  await walk(root, 0);
  newest.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  return Object.assign(newest, { totalCount });
}

// 完整遍历 JSONL 树，但按固定页交给调用者；用于删除这类不能接受 top-k 漏扫的操作。
// 页大小限制内存，页内再由调用者施加有限并发，避免一次性收集大型会话树。
async function visitJsonlPages(root, { maxDepth, pageSize = 128 }, visitPage) {
  const capacity = Math.max(1, Math.min(1000, Math.floor(Number(pageSize) || 128)));
  let page = [];
  let totalCount = 0;
  let traversalFailures = 0;
  const flush = async () => {
    if (!page.length) return;
    const current = page;
    page = [];
    await visitPage(current);
  };
  async function walk(dir, depth) {
    if (depth > maxDepth) {
      traversalFailures += 1;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      traversalFailures += 1;
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const info = await stat(path);
          page.push({ path, name: entry.name, dir, size: info.size, mtimeMs: info.mtimeMs });
          totalCount += 1;
          if (page.length >= capacity) await flush();
        } catch {
          traversalFailures += 1;
        }
      }
    }
  }
  await walk(root, 0);
  await flush();
  return { totalCount, traversalFailures };
}

export class SessionAggregator {
  constructor({
    aiSharedRoot,
    home = homedir(),
    projectSnapshotTtlMs = PROJECT_SNAPSHOT_TTL_MS,
    onProjectScan = null,
    onProjectScanComplete = null,
  } = {}) {
    this.aiSharedRoot = aiSharedRoot;
    this.home = home;
    this.projectSnapshotTtlMs = Math.max(0, Math.min(30_000, Number(projectSnapshotTtlMs) || 0));
    this.onProjectScan = typeof onProjectScan === "function" ? onProjectScan : null;
    this.onProjectScanComplete = typeof onProjectScanComplete === "function" ? onProjectScanComplete : null;
    this.projectSnapshots = new Map();
    this.projectInflight = new Map();
    this.projectScanChain = Promise.resolve();
    this.projectSnapshotEpoch = 0;
  }

  // includeSummaries 默认关闭（烛 R-P2 R8：脱敏是尽力而为，纵深防御=默认不展示会话原文摘要，
  // 前端需要时显式 opt-in ?summaries=1；即便开启也过双层 scrub）。元数据（id/时间/大小）永远安全。
  async list({ limitPerSource = 25, includeSummaries = false } = {}) {
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(Number(limitPerSource) || 25)));
    // v4.0 codeg 对标扩源：原 7 源 + 新增 5 源 = 12 源（与 codeg 的 12 源对齐）
    // W1.6：+ Gemini CLI（~/.gemini/tmp 实证结构）= 13 源
    const [claude, codex, cursor, kimi, pi, bridge, grok, opencode, cline, openclaw, hermes, codebuddy, gemini] = await Promise.all([
      this.#claudeSessions(normalizedLimit, includeSummaries),
      this.#codexSessions(normalizedLimit, includeSummaries),
      this.#treeBackedSessions({
        source: "cursor",
        label: "Cursor",
        limit: normalizedLimit,
        includeSummaries,
        scan: (projects, options) => this.#mergeCursorProjects(projects, options),
      }),
      this.#treeBackedSessions({
        source: "kimi",
        label: "Kimi Code",
        limit: normalizedLimit,
        includeSummaries,
        scan: (projects, options) => this.#mergeKimiProjects(projects, options),
      }),
      this.#treeBackedSessions({
        source: "pi",
        label: "Pi",
        limit: normalizedLimit,
        includeSummaries,
        scan: (projects, options) => this.#mergePiProjects(projects, options),
      }),
      this.#bridgeThreads(),
      this.#grokSessions(normalizedLimit),
      // v4.0 新增 5 源（codeg 对标）
      this.#opencodeSessions(normalizedLimit),
      this.#clineSessions(normalizedLimit),
      this.#openclawSessions(normalizedLimit),
      this.#hermesSessions(normalizedLimit),
      this.#codebuddySessions(normalizedLimit),
      // W1.6：Gemini CLI（~/.gemini/tmp/<project>/chats/session-*.json）
      this.#geminiSessions(normalizedLimit, includeSummaries),
    ]);
    return { includeSummaries, sources: [claude, codex, cursor, kimi, pi, bridge, grok, opencode, cline, openclaw, hermes, codebuddy, gemini] };
  }

  // 协作台左栏「项目树」数据：Claude Code 会话按项目分组，项目下挂历史对话。
  // 项目真实路径从最新会话 jsonl 的 cwd 字段还原（无损）；summary 与 list() 同纪律——opt-in + 双层 scrub。
  async projects({ perProjectLimit = 10, includeSummaries = false, refresh = false } = {}) {
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(Number(perProjectLimit) || 10)));
    const normalizedSummaries = includeSummaries === true;
    const key = `${normalizedSummaries ? 1 : 0}:${normalizedLimit}`;
    const refreshKey = `refresh:${key}`;
    const now = Date.now();
    const forced = this.projectInflight.get(refreshKey);
    if (forced?.epoch === this.projectSnapshotEpoch) return cloneSnapshot(await forced.promise);
    let precedingNormal = null;
    if (!refresh) {
      const cached = this.projectSnapshots.get(key);
      if (cached && cached.expiresAt > now) return cloneSnapshot(cached.value);
      if (cached) this.projectSnapshots.delete(key);
      const existing = this.projectInflight.get(key);
      if (existing?.epoch === this.projectSnapshotEpoch) return cloneSnapshot(await existing.promise);
    } else {
      // A forced refresh cannot inherit a non-refresh scan that may have started from an older disk
      // snapshot. It gets its own coalescing lane and prevents that older scan from filling the cache.
      this.projectSnapshotEpoch += 1;
      // Every projection reads the same underlying directory tree. A forced refresh invalidates
      // all summary/limit variants so another key cannot serve a stale pre-refresh snapshot.
      this.projectSnapshots.clear();
      precedingNormal = this.projectInflight.get(key)?.promise ?? null;
    }

    const epoch = this.projectSnapshotEpoch;
    const inflightKey = refresh ? refreshKey : key;
    const runScan = async () => {
      // Refresh keeps a distinct result contract, but serializes behind an older same-key scan so
      // it cannot reuse stale work. The global chain below also serializes different summary/limit
      // keys: every key walks the same large Claude projects tree, so parallel keys only add disk
      // contention and UI stalls.
      if (precedingNormal) await precedingNormal.catch(() => {});
      await this.onProjectScan?.({ perProjectLimit: normalizedLimit, includeSummaries: normalizedSummaries, refresh: refresh === true });
      const value = await this.#scanProjects({ perProjectLimit: normalizedLimit, includeSummaries: normalizedSummaries });
      await this.onProjectScanComplete?.({ perProjectLimit: normalizedLimit, includeSummaries: normalizedSummaries, refresh: refresh === true });
      if (epoch === this.projectSnapshotEpoch && this.projectSnapshotTtlMs > 0) {
        this.projectSnapshots.delete(key);
        this.projectSnapshots.set(key, { expiresAt: Date.now() + this.projectSnapshotTtlMs, value: cloneSnapshot(value) });
        while (this.projectSnapshots.size > PROJECT_SNAPSHOT_MAX_KEYS) {
          this.projectSnapshots.delete(this.projectSnapshots.keys().next().value);
        }
      }
      return value;
    };
    const scan = this.projectScanChain.catch(() => {}).then(runScan);
    this.projectScanChain = scan.then(() => undefined, () => undefined);
    const inflight = { promise: scan, epoch, refresh: refresh === true };
    this.projectInflight.set(inflightKey, inflight);
    try {
      return cloneSnapshot(await scan);
    } finally {
      if (this.projectInflight.get(inflightKey) === inflight) this.projectInflight.delete(inflightKey);
    }
  }

  invalidateProjects() {
    this.projectSnapshotEpoch += 1;
    this.projectSnapshots.clear();
  }

  async #scanProjects({ perProjectLimit, includeSummaries }) {
    const root = join(this.home, ".claude", "projects");
    const result = { source: "claude", available: false, includeSummaries, projects: [] };
    // 每个非 Claude 源先在隔离数组中启动扫描：I/O 并行，但不并发写共享 projects，
    // 因而既消除 Claude 根的总开关，也避免两个源同时合成相同 cwd 时产生重复项目。
    const additionalScansPromise = Promise.all([
      this.#scanProjectSource("codex", (projects, options) => this.#mergeCodexProjects(projects, options), { perProjectLimit, includeSummaries }),
      this.#scanProjectSource("kimi", (projects, options) => this.#mergeKimiProjects(projects, options), { perProjectLimit, includeSummaries }),
      this.#scanProjectSource("pi", (projects, options) => this.#mergePiProjects(projects, options), { perProjectLimit, includeSummaries }),
      this.#scanProjectSource("cursor", (projects, options) => this.#mergeCursorProjects(projects, options), { perProjectLimit, includeSummaries }),
    ]);
    let dirs = [];
    let realRoot = null;
    try {
      [dirs, realRoot] = await Promise.all([readdir(root, { withFileTypes: true }), realpath(root)]);
      result.available = true;
    } catch (error) {
      result.error = error.code || error.message;
    }
    // 列表入口与 preview 共用同一条隐私不变量（烛 R6 致命1）：逃逸 projects 根的 symlink
    // 不只 preview 要拒，扫描阶段（cwd 提取/opt-in 摘要都会读文件）就不能读、不能列。
    // Claude 根缺失时 projects 保持空数组，后续非 Claude 扫描照常合入。
    const validDirs = realRoot ? dirs.filter((dir) => dir.isDirectory() && safePathName(dir.name)) : [];
    const projects = (await mapConcurrent(validDirs, 6, async (dir) => {
      const projectDir = join(root, dir.name);
      let names;
      try {
        names = await readdir(projectDir);
      } catch {
        return null;
      }
      const candidates = names.filter((name) => name.endsWith(".jsonl") && safePathName(name.replace(/\.jsonl$/, "")));
      const files = (await mapConcurrent(candidates, 4, async (name) => {
        try {
          const filePath = join(projectDir, name);
          const [info, real] = await Promise.all([stat(filePath), realpath(filePath)]);
          if (!info.isFile() || !real.startsWith(realRoot + sep)) return null;
          return { name, path: real, size: info.size, mtimeMs: info.mtimeMs };
        } catch {
          return null; // 扫描期间消失的文件跳过
        }
      })).filter(Boolean);
      if (!files.length) return null;
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const top = files.slice(0, perProjectLimit);
      const [rawPath, summaries] = await Promise.all([
        scanHeadLines(files[0].path, cwdFromLine).catch(() => null),
        includeSummaries
          ? mapConcurrent(top, 4, (file) => firstUserTextFromFile(file.path).catch(() => null))
          : Promise.resolve(new Array(top.length).fill(null)),
      ]);
      let realPath = rawPath;
      if (realPath) realPath = scrub(realPath); // 纵深防御：会话文件内容一律过脱敏，路径正常时无副作用
      const sessions = top.map((file, index) => ({
          id: file.name.replace(/\.jsonl$/, ""),
          cli: "claude",
          summary: summaries[index],
          size: file.size,
          modifiedAt: new Date(file.mtimeMs).toISOString(),
      }));
      return {
        id: dir.name,
        label: realPath ? lastSegment(realPath) : dir.name,
        path: realPath,
        sessionCount: files.length,
        latestMs: files[0].mtimeMs,
        sessions,
      };
    })).filter(Boolean);
    const claudeStatus = {
      source: "claude",
      available: result.available,
      sessionCount: projects.reduce((total, project) => total + project.sessionCount, 0),
      ...(result.error ? { error: result.error } : {}),
    };
    const additionalScans = await additionalScansPromise;
    for (const scan of additionalScans) this.#mergeProjectTrees(projects, scan.projects);
    projects.sort((a, b) => b.latestMs - a.latestMs);
    result.projects = projects.map(({ latestMs, ...rest }) => rest);
    result.sources = [claudeStatus, ...additionalScans.map(({ projects: _projects, ...status }) => status)];
    result.available = result.sources.some((source) => source.available);
    if (result.available) delete result.error;
    else result.error = result.sources.map((source) => `${source.source}:${source.error ?? "unavailable"}`).join(", ");
    return result;
  }

  async #scanProjectSource(source, scan, options) {
    const projects = [];
    try {
      const status = (await scan(projects, options)) ?? {};
      return {
        source,
        available: status.available === true,
        sessionCount: Number.isFinite(status.sessionCount)
          ? status.sessionCount
          : projects.reduce((total, project) => total + project.sessionCount, 0),
        ...(status.error ? { error: status.error } : {}),
        projects,
      };
    } catch (error) {
      return { source, available: false, sessionCount: 0, error: error.code || error.message, projects: [] };
    }
  }

  #mergeProjectTrees(projects, incoming) {
    const byPathKey = new Map();
    for (const project of projects) {
      const key = normalizeCwdKey(project.path);
      if (key) byPathKey.set(key, project);
    }
    for (const project of incoming) {
      const key = normalizeCwdKey(project.path);
      const hit = key ? byPathKey.get(key) : null;
      if (hit) {
        hit.sessions.push(...project.sessions);
        hit.sessionCount += project.sessionCount;
        hit.latestMs = Math.max(hit.latestMs ?? 0, project.latestMs ?? 0);
        continue;
      }
      projects.push(project);
      if (key) byPathKey.set(key, project);
    }
  }

  async #treeBackedSessions({ source, label, limit, includeSummaries, scan }) {
    const result = await this.#scanProjectSource(source, scan, { perProjectLimit: limit, includeSummaries });
    const sessions = result.projects
      .flatMap((project) => project.sessions
        .filter((session) => session.cli === source)
        .map((session) => ({ ...session, scope: session.scope ?? project.path ?? project.id })))
      .sort((left, right) => Date.parse(right.modifiedAt ?? "") - Date.parse(left.modifiedAt ?? ""))
      .slice(0, limit);
    return {
      source,
      label,
      available: result.available,
      sessionCount: result.sessionCount,
      sessions,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  // Kimi Code（~/.kimi-code）：session_index.jsonl 每行 {sessionId, sessionDir, workDir} 是现成索引；
  // 会话元数据在 <sessionDir>/state.json（createdAt/updatedAt/title），首条输入在 agents/main/wire.jsonl
  // 的 turn.prompt 事件（2026-07-20 本机 0.27.0 实测格式）。sessionDir 来自文件内容——realpath 限根到
  // ~/.kimi-code/sessions（索引被篡改指向任意路径时 fail-closed 跳过）。
  async #mergeKimiProjects(projects, { perProjectLimit, includeSummaries }) {
    const status = { available: false, sessionCount: 0 };
    const kimiRoot = join(this.home, ".kimi-code");
    const sessionsRoot = join(kimiRoot, "sessions");
    let realRoot;
    let input = null;
    let lines = null;
    const byCwd = new Map();
    const processBatch = async (batch) => {
      const records = await mapConcurrent(batch, KIMI_INDEX_IO_CONCURRENCY, async ({ entry, ordinal }) => {
        let realDir;
        try {
          realDir = await realpath(entry.sessionDir);
        } catch {
          return null; // 索引残留（会话目录已删）跳过
        }
        if (!realDir.startsWith(realRoot + sep)) return null; // 限根不变量
        let meta = null;
        try {
          meta = JSON.parse(await readFile(join(realDir, "state.json"), "utf8"));
        } catch {
          // 无 state.json 仍可列出（时间戳退化为 null）
        }
        const cwd = typeof entry.workDir === "string" && entry.workDir.trim() ? entry.workDir.trim() : meta?.workDir;
        const key = normalizeCwdKey(cwd);
        if (!key) return null;
        const modifiedMs = Date.parse(meta?.updatedAt ?? meta?.createdAt ?? "") || 0;
        return {
          key,
          cwd,
          session: {
            id: entry.sessionId,
            cli: "kimi",
            // 自定义标题是用户内容，过脱敏；默认 "New Session" 不当标题用
            label: meta?.isCustomTitle && meta?.title ? scrub(String(meta.title)).slice(0, 60) : null,
            summary: null,
            size: 0,
            modifiedAt: modifiedMs ? new Date(modifiedMs).toISOString() : null,
            _ms: modifiedMs,
            _ordinal: ordinal,
            _wire: join(realDir, "agents", "main", "wire.jsonl"),
          },
        };
      });
      for (const record of records) {
        if (!record) continue;
        if (!byCwd.has(record.key)) byCwd.set(record.key, { cwd: record.cwd, sessionCount: 0, sessions: [] });
        const group = byCwd.get(record.key);
        group.sessionCount += 1;
        status.sessionCount += 1;
        retainNewestSession(group.sessions, record.session, perProjectLimit);
      }
      // readline 可能已把多行缓冲在内存中；每个固定页主动让出一次，避免长索引独占事件循环。
      await yieldToEventLoop();
    };
    try {
      realRoot = await realpath(sessionsRoot);
      input = createReadStream(join(kimiRoot, "session_index.jsonl"), { encoding: "utf8" });
      lines = createInterface({ input, crlfDelay: Infinity });
      let batch = [];
      let lineCount = 0;
      for await (const line of lines) {
        lineCount += 1;
        if (line.trim().startsWith("{")) {
          try {
            const entry = JSON.parse(line);
            if (entry?.sessionId && entry?.sessionDir) batch.push({ entry, ordinal: lineCount });
          } catch {
            // 损坏或写到一半的索引行跳过
          }
        }
        if (lineCount % KIMI_INDEX_BATCH_SIZE === 0) {
          await processBatch(batch);
          batch = [];
        }
      }
      if (batch.length) await processBatch(batch);
    } catch (error) {
      status.error = error.code || error.message;
      return status; // 无 kimi 存储：如实不合并
    } finally {
      lines?.close();
      input?.destroy();
    }
    status.available = true;
    await this.#foldSessionGroups(projects, byCwd, {
      cliPrefix: "kimi",
      perProjectLimit,
      includeSummaries,
      summaryOf: (session) => scanHeadLines(session._wire, kimiPromptFromLine),
    });
    return status;
  }

  // Pi（~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl）：首行 {type:"session", id, cwd} meta 头，
  // 消息行 {type:"message", message:{role,content}}——与 codex rollout 同构（2026-07-20 本机实测 v3 格式）。
  async #mergePiProjects(projects, { perProjectLimit, includeSummaries }) {
    const status = { available: false, sessionCount: 0 };
    const root = join(this.home, ".pi", "agent", "sessions");
    let realRoot;
    try {
      await stat(root);
      realRoot = await realpath(root);
    } catch (error) {
      status.error = error.code || error.message;
      return status; // 无 pi 存储：如实不合并
    }
    status.available = true;
    const files = await collectJsonl(root, { maxDepth: 2, limit: 400 });
    const metas = new Array(files.length).fill(null);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(16, files.length) }, async () => {
        while (cursor < files.length) {
          const index = cursor++;
          const file = files[index];
          let real;
          try {
            real = await realpath(file.path);
          } catch {
            continue;
          }
          if (!real.startsWith(realRoot + sep)) continue;
          try {
            metas[index] = { cwd: await scanHeadLines(real, piCwdFromLine), real };
          } catch {
            // 单文件失败跳过
          }
        }
      }),
    );
    const byCwd = new Map();
    for (const [index, file] of files.entries()) {
      const cwd = metas[index]?.cwd;
      const key = normalizeCwdKey(cwd);
      if (!key) continue;
      if (!byCwd.has(key)) byCwd.set(key, { cwd, sessions: [] });
      byCwd.get(key).sessions.push({
        id: file.name.replace(/\.jsonl$/, ""),
        cli: "pi",
        label: piFileLabel(file.name),
        summary: null,
        size: file.size,
        modifiedAt: new Date(file.mtimeMs).toISOString(),
        _ms: file.mtimeMs,
        _path: metas[index].real,
      });
    }
    status.sessionCount = files.totalCount ?? [...byCwd.values()].reduce((total, group) => total + group.sessions.length, 0);
    await this.#foldSessionGroups(projects, byCwd, {
      cliPrefix: "pi",
      perProjectLimit,
      includeSummaries,
      summaryOf: (session) => firstUserTextFromFile(session._path),
    });
    return status;
  }

  // Cursor（%APPDATA%/Cursor/User/globalStorage/state.vscdb，WAL SQLite 只读）：
  // ItemTable 的 composer.composerHeaders 是权威会话列表（2026-07-20 本机 91 条实测格式）。
  // key 缺失/库打不开/JSON 损坏 → 如实不合并（版本漂移 fail-closed，不猜旧 key 伪造）。
  async #mergeCursorProjects(projects, { perProjectLimit, includeSummaries }) {
    const status = { available: false, sessionCount: 0 };
    const storageDir = cursorGlobalStorageDir(this.home);
    const dbPath = join(storageDir, "state.vscdb");
    let realRoot;
    let realDb;
    try {
      [realRoot, realDb] = await Promise.all([realpath(storageDir), realpath(dbPath)]);
    } catch (error) {
      status.error = error.code || error.message;
      return status; // 无 cursor 存储：如实不合并
    }
    if (!realDb.startsWith(realRoot + sep)) {
      status.error = "database path escapes globalStorage";
      return status;
    }
    const db = await openCursorDb(realDb);
    if (!db) {
      status.error = "cursor database unavailable";
      return status;
    }
    try {
      const composers = readCursorComposerHeaders(db);
      if (!composers) {
        status.error = "composer headers unavailable";
        return status; // 权威 key 读不出：fail-closed
      }
      status.available = true;
      const byCwd = new Map();
      for (const composer of composers) {
        if (composer?.isArchived || composer?.isDraft) continue; // 归档/草稿不进树
        const id = typeof composer?.composerId === "string" ? composer.composerId.trim() : "";
        if (!safePathName(id)) continue; // preview 按 id 点查，形态不符不列出
        const cwd = cursorComposerCwd(composer);
        const key = normalizeCwdKey(cwd);
        if (!key) continue;
        const modifiedMs = Number(composer.lastUpdatedAt ?? composer.createdAt) || 0;
        if (!byCwd.has(key)) byCwd.set(key, { cwd, sessions: [] });
        byCwd.get(key).sessions.push({
          id,
          cli: "cursor",
          // 会话名是用户内容，过脱敏；无名会话 label=null（前端回退摘要/短 id）
          label: typeof composer.name === "string" && composer.name.trim() ? scrub(composer.name.trim()).slice(0, 60) : null,
          summary: null,
          size: 0,
          modifiedAt: modifiedMs ? new Date(modifiedMs).toISOString() : null,
          _ms: modifiedMs,
          _composerId: id,
        });
      }
      status.sessionCount = [...byCwd.values()].reduce((total, group) => total + group.sessions.length, 0);
      await this.#foldSessionGroups(projects, byCwd, {
        cliPrefix: "cursor",
        perProjectLimit,
        includeSummaries,
        summaryOf: (session) => cursorFirstUserText(db, session._composerId),
      });
      return status;
    } finally {
      try {
        db.close();
      } catch {
        // 关闭失败不影响结果
      }
    }
  }

  // cwd 分组折叠进项目树（kimi/pi/cursor 共用）：命中既有项目则挂靠，否则合成新项目；
  // 摘要 best-effort；内部 _ 字段出网前剥除。
  async #foldSessionGroups(projects, byCwd, { cliPrefix, perProjectLimit, includeSummaries, summaryOf }) {
    const byPathKey = new Map();
    for (const project of projects) {
      if (project.path) byPathKey.set(normalizeCwdKey(project.path), project);
    }
    for (const [key, group] of byCwd) {
      group.sessions.sort((a, b) => (b._ms ?? 0) - (a._ms ?? 0));
      const top = group.sessions.slice(0, perProjectLimit);
      const latest = group.sessions[0]?._ms ?? 0;
      const sessionCount = group.sessionCount ?? group.sessions.length;
      if (includeSummaries) {
        const summaries = await mapConcurrent(top, 8, (session) => Promise.resolve(summaryOf(session)).catch(() => null));
        for (const [index, session] of top.entries()) session.summary = summaries[index];
      }
      for (const session of top) {
        for (const field of Object.keys(session)) if (field.startsWith("_")) delete session[field];
      }
      const hit = byPathKey.get(key);
      if (hit) {
        hit.sessions.push(...top);
        hit.sessionCount += sessionCount;
        hit.latestMs = Math.max(hit.latestMs ?? 0, latest);
      } else {
        const project = {
          id: `${cliPrefix}-${fnv1aHex(key)}`,
          label: lastSegment(group.cwd),
          path: scrub(group.cwd),
          sessionCount,
          latestMs: latest,
          sessions: top,
        };
        projects.push(project);
        byPathKey.set(key, project);
      }
    }
  }

  // Codex 会话（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl）按 session_meta.cwd 分组，
  // 归并进 claude 项目或合成 codex-only 项目。cap 400 个最近文件：树只展示每项目前 N 条，足够。
  async #mergeCodexProjects(projects, { perProjectLimit, includeSummaries }) {
    const status = { available: false, sessionCount: 0 };
    const root = join(this.home, ".codex", "sessions");
    let realRoot;
    try {
      await stat(root);
      realRoot = await realpath(root);
    } catch (error) {
      status.error = error.code || error.message;
      return status; // 无 codex 存储：如实不合并（不伪造空项目）
    }
    status.available = true;
    const files = await collectJsonl(root, { maxDepth: 4, limit: 400 });
    // 逐个 await 在慢盘上是 47 秒的灾难（实测）——16 路有界并发提取 meta
    const metas = new Array(files.length).fill(null);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(16, files.length) }, async () => {
        while (cursor < files.length) {
          const index = cursor++;
          const file = files[index];
          let real;
          try {
            real = await realpath(file.path);
          } catch {
            continue;
          }
          if (!real.startsWith(realRoot + sep)) continue; // 与 claude 同一条限根不变量
          try {
            metas[index] = { meta: await scanHeadLines(real, codexMetaFromLine), real };
          } catch {
            // 单个文件读失败不影响整体
          }
        }
      }),
    );
    const byCwd = new Map();
    for (const [index, file] of files.entries()) {
      const meta = metas[index]?.meta;
      const key = normalizeCwdKey(meta?.cwd);
      if (!key) continue;
      if (!byCwd.has(key)) byCwd.set(key, { cwd: meta.cwd, sessions: [] });
      byCwd.get(key).sessions.push({
        id: file.name.replace(/\.jsonl$/, ""),
        cli: "codex",
        scope: file.dir.slice(root.length + 1).replaceAll(sep, "/") || ".", // URL 字段统一正斜杠（深链/预览跨平台稳定）
        label: codexFileLabel(file.name),
        subagent: meta.subagent,
        nickname: meta.nickname ? scrub(meta.nickname) : null, // 内容字段一律过脱敏
        summary: null,
        size: file.size,
        modifiedAt: new Date(file.mtimeMs).toISOString(),
        _ms: file.mtimeMs,
        _path: metas[index].real,
      });
    }
    status.sessionCount = files.totalCount ?? [...byCwd.values()].reduce((total, group) => total + group.sessions.length, 0);
    const byPathKey = new Map();
    for (const project of projects) {
      if (project.path) byPathKey.set(normalizeCwdKey(project.path), project);
    }
    for (const [key, group] of byCwd) {
      group.sessions.sort((a, b) => b._ms - a._ms);
      const top = group.sessions.slice(0, perProjectLimit);
      const latest = group.sessions[0]?._ms ?? 0;
      if (includeSummaries) {
        const summaries = await mapConcurrent(top, 8, (session) => firstUserTextFromFile(session._path).catch(() => null));
        for (const [index, session] of top.entries()) session.summary = summaries[index];
      }
      for (const session of top) {
        delete session._ms;
        delete session._path;
      }
      const hit = byPathKey.get(key);
      if (hit) {
        hit.sessions.push(...top);
        hit.sessionCount += group.sessions.length;
        hit.latestMs = Math.max(hit.latestMs ?? 0, latest);
      } else {
        projects.push({
          id: `codex-${fnv1aHex(key)}`, // 稳定且唯一（slug 化对中文路径会塌缩，禁用）
          label: lastSegment(group.cwd),
          path: scrub(group.cwd), // 与 claude 同纪律：内容字段一律过脱敏
          sessionCount: group.sessions.length,
          latestMs: latest,
          sessions: top,
        });
      }
    }
    return status;
  }

  // 「移除项目」的可选同步删除：把项目会话文件移入隔离区（trashRoot/<时间戳>/）——
  // 系统目录即清空，效果等同删除；隔离区保留后悔药。Claude=整个项目目录；Codex=按 cwd 精确匹配 rollout。
  async deleteProjectSessions({ project, path, trashRoot } = {}) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const trashBase = join(trashRoot, stamp);
    const unsupported = (source, limitation) => ({
      source,
      supported: false,
      removed: 0,
      remaining: null,
      limited: true,
      limitations: [limitation],
    });
    const claudeStatus = { source: "claude", supported: true, removed: 0, remaining: 0, limited: false, limitations: [] };
    const codexStatus = { source: "codex", supported: true, removed: 0, remaining: 0, limited: false, limitations: [] };
    const result = {
      trash: null,
      // 兼容现有 UI；逐 source 契约才是完整、可扩展的能力描述。
      claudeRemoved: false,
      codexRemoved: 0,
      sources: [
        claudeStatus,
        codexStatus,
        unsupported("cursor", "Cursor project-session deletion is not supported"),
        unsupported("kimi", "Kimi project-session deletion is not supported"),
        unsupported("pi", "Pi project-session deletion is not supported"),
        // v4.0 五源 + bridge/grok：如实列出未支持，避免"删除成功但列表刷新后仍出现"的误导
        unsupported("bridge", "Bridge thread deletion is not supported"),
        unsupported("grok", "Grok project-session deletion is not supported"),
        unsupported("opencode", "OpenCode project-session deletion is not supported"),
        unsupported("cline", "Cline project-session deletion is not supported"),
        unsupported("openclaw", "OpenClaw project-session deletion is not supported"),
        unsupported("hermes", "Hermes project-session deletion is not supported"),
        unsupported("codebuddy", "CodeBuddy project-session deletion is not supported"),
      ],
    };
    const moveInto = async (source, dest) => {
      await mkdir(dirname(dest), { recursive: true });
      try {
        await rename(source, dest);
      } catch (error) {
        // 跨盘 rename 必 EXDEV（生产实况：会话在 C:\Users、trash 在 I:\ dataRoot，本机实证）——
        // 回退 copy+delete；copy 成功才删源，任一步失败源保持原样
        if (error.code !== "EXDEV") throw error;
        await cp(source, dest, { recursive: true, errorOnExist: true, force: false });
        await rm(source, { recursive: true, force: true });
      }
      result.trash = trashBase;
    };
    // Claude：~/.claude/projects/<project>/（safePathName + realpath 限根，与扫描同纪律）
    if (safePathName(project)) {
      const root = join(this.home, ".claude", "projects");
      try {
        const [real, realRoot] = await Promise.all([realpath(join(root, project)), realpath(root)]);
        if (real.startsWith(realRoot + sep) && (await stat(real)).isDirectory()) {
          const entries = await readdir(real, { withFileTypes: true });
          const sessionCount = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).length;
          await moveInto(real, join(trashBase, "claude-projects", project));
          result.claudeRemoved = true;
          claudeStatus.removed = sessionCount;
        } else {
          claudeStatus.remaining = null;
          claudeStatus.limited = true;
          claudeStatus.limitations.push("Claude project path is outside the projects root or is not a directory");
        }
      } catch (error) {
        // 目录不存在（codex-only 合成项目）表示没有 Claude 会话；其他错误必须显式呈现。
        if (error.code !== "ENOENT") {
          claudeStatus.remaining = null;
          claudeStatus.limited = true;
          claudeStatus.limitations.push(`Claude quarantine failed: ${error.code || error.message}`);
        }
      }
    } else {
      claudeStatus.remaining = null;
      claudeStatus.limited = true;
      claudeStatus.limitations.push("A valid Claude project identifier is required");
    }
    // Codex：rollout 按归一化 cwd 精确匹配。完整遍历、固定分页、页内有限并发；
    // 删除不能复用项目树的 top-k 列表，否则第 1001 个及更旧的命中会话会静默残留。
    const key = normalizeCwdKey(path);
    if (key) {
      const root = join(this.home, ".codex", "sessions");
      let realRoot = null;
      try {
        realRoot = await realpath(root);
      } catch (error) {
        if (error.code !== "ENOENT") {
          codexStatus.remaining = null;
          codexStatus.limited = true;
          codexStatus.limitations.push(`Codex sessions root unavailable: ${error.code || error.message}`);
        }
      }
      if (realRoot) {
        let inspectionFailures = 0;
        let moveFailures = 0;
        const traversal = await visitJsonlPages(root, { maxDepth: 4, pageSize: 128 }, async (files) => {
          const inspected = await mapConcurrent(files, 16, async (file) => {
            try {
              let real;
              real = await realpath(file.path);
              if (!real.startsWith(realRoot + sep)) return { error: "path escapes sessions root" };
              const meta = await scanHeadLines(real, codexMetaFromLine);
              return meta ? { file, real, meta } : { error: "session meta unavailable" };
            } catch (error) {
              return { error: error.code || error.message };
            }
          });
          const matches = [];
          for (const entry of inspected) {
            if (entry.error) {
              inspectionFailures += 1;
            } else if (entry.meta && normalizeCwdKey(entry.meta.cwd) === key) {
              matches.push(entry);
            }
          }
          const moved = await mapConcurrent(matches, 8, async (entry) => {
            try {
              const scope = entry.file.dir.slice(root.length + 1).replaceAll(sep, "/") || ".";
              await moveInto(entry.real, join(trashBase, "codex", scope, entry.file.name));
              return true;
            } catch {
              return false;
            }
          });
          for (const success of moved) {
            if (success) codexStatus.removed += 1;
            else moveFailures += 1;
          }
        });
        inspectionFailures += traversal.traversalFailures;
        if (inspectionFailures) {
          codexStatus.remaining = null;
          codexStatus.limited = true;
          codexStatus.limitations.push(
            `${inspectionFailures} Codex session file(s) could not be inspected; remaining is unknown`,
          );
        } else {
          codexStatus.remaining = moveFailures;
        }
        if (moveFailures) {
          codexStatus.limited = true;
          codexStatus.limitations.push(`${moveFailures} matched Codex session file(s) could not be quarantined`);
        }
      }
    } else {
      codexStatus.remaining = null;
      codexStatus.limited = true;
      codexStatus.limitations.push("A project path is required for Codex deletion");
    }
    result.codexRemoved = codexStatus.removed;
    this.invalidateProjects();
    return result;
  }

  // 会话文件的安全路径解析（白名单 + realpath 限根 + isFile）——
  // claude：root=~/.claude/projects/<project>/<id>.jsonl；codex：root=~/.codex/sessions/<scope…>/<id>.jsonl
  async resolveFilePath({ source = "claude", project, scope, id } = {}) {
    if (!safePathName(id)) {
      throw Object.assign(new Error("invalid session id"), { code: "VALIDATION_FAILED" });
    }
    let root;
    let path;
    if (source === "codex") {
      const segments = String(scope ?? "").split(/[\\/]+/).filter(Boolean);
      if (!segments.length || !segments.every(safePathName)) {
        throw Object.assign(new Error("invalid session scope"), { code: "VALIDATION_FAILED" });
      }
      root = join(this.home, ".codex", "sessions");
      path = join(root, ...segments, `${id}.jsonl`);
    } else {
      if (!safePathName(project)) {
        throw Object.assign(new Error("invalid project or session id"), { code: "VALIDATION_FAILED" });
      }
      root = join(this.home, ".claude", "projects");
      path = join(root, project, `${id}.jsonl`);
    }
    let real;
    let realRoot;
    try {
      [real, realRoot] = await Promise.all([realpath(path), realpath(root)]);
    } catch {
      throw Object.assign(new Error("session not found"), { code: "SOURCE_NOT_FOUND" });
    }
    if (!real.startsWith(realRoot + sep)) {
      throw Object.assign(new Error("session path escapes the sessions root"), { code: "VALIDATION_FAILED" });
    }
    const info = await stat(real).catch(() => null);
    if (!info?.isFile()) {
      throw Object.assign(new Error("session not found"), { code: "SOURCE_NOT_FOUND" });
    }
    return real;
  }

  // 历史对话只读预览：只回 user/assistant 文本骨架（不回 tool 结果/侧链——密钥最常藏在工具输出里），
  // 每条过双层 scrub + 截断。project/id 白名单校验防路径遍历。
  async preview({ project, id, maxMessages = PREVIEW_MAX_MESSAGES } = {}) {
    if (!safePathName(project) || !safePathName(id)) {
      throw Object.assign(new Error("invalid project or session id"), { code: "VALIDATION_FAILED" });
    }
    const projectsRoot = join(this.home, ".claude", "projects");
    const path = join(projectsRoot, project, `${id}.jsonl`);
    // realpath 限根（烛 R5 建议）：白名单挡不住目录 junction / 会话文件 symlink 指向根外。
    // 校验后统一用 resolved 路径 stat/读取，收窄校验-打开之间的 TOCTOU 窗口（烛 R6 建议）
    let real;
    let realRoot;
    try {
      [real, realRoot] = await Promise.all([realpath(path), realpath(projectsRoot)]);
    } catch {
      throw Object.assign(new Error("session not found"), { code: "SOURCE_NOT_FOUND" });
    }
    if (!real.startsWith(realRoot + sep)) {
      throw Object.assign(new Error("session path escapes the projects root"), { code: "VALIDATION_FAILED" });
    }
    let info;
    try {
      info = await stat(real);
    } catch {
      throw Object.assign(new Error("session not found"), { code: "SOURCE_NOT_FOUND" });
    }
    if (!info.isFile()) {
      throw Object.assign(new Error("session path escapes the projects root"), { code: "VALIDATION_FAILED" });
    }
    const { text, truncatedHead } = await tailText(real, PREVIEW_TAIL_BYTES);
    const lines = text.split(/\r?\n/);
    if (truncatedHead) lines.shift(); // 尾读窗口的首行可能是半行
    const messages = [];
    for (const line of lines) {
      if (!line.trim().startsWith("{")) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.isSidechain === true) continue; // 子代理侧链不进主对话预览
      if (event.isMeta === true) continue; // 命令回显等元事件不进预览
      const message = event.message ?? null;
      const role = message?.role;
      if (role !== "user" && role !== "assistant") continue;
      let body = null;
      if (typeof message.content === "string" && message.content.trim()) {
        body = message.content;
      } else if (Array.isArray(message.content)) {
        const parts = message.content
          .filter((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim())
          .map((part) => part.text);
        if (parts.length) body = parts.join("\n");
      }
      if (body && role === "user") body = meaningfulUserText(body); // 剥系统包装，纯包装行跳过
      if (!body) continue; // 纯工具调用/工具结果行不进预览
      const flat = scrub(body).trim();
      messages.push({
        role,
        text: flat.length > PREVIEW_CHAR_LIMIT ? `${flat.slice(0, PREVIEW_CHAR_LIMIT)}…` : flat,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : null,
      });
    }
    const clipped = messages.slice(-maxMessages);
    return {
      source: "claude",
      project,
      id,
      totalBytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      truncated: truncatedHead || clipped.length < messages.length,
      messages: clipped,
    };
  }

  // Kimi 只读预览（v3.7 扩源配套）：session_index.jsonl 查 sessionDir（realpath 限根）→
  // wire.jsonl 的 context.append_message（role user/assistant，与 claude content 形态同构，
  // 2026-07-20 实测）；一条 append 都没有时回退 turn.prompt（至少呈现用户输入侧）。
  async previewKimi({ id, maxMessages = PREVIEW_MAX_MESSAGES } = {}) {
    if (!safePathName(id)) {
      throw Object.assign(new Error("invalid session id"), { code: "VALIDATION_FAILED" });
    }
    const kimiRoot = join(this.home, ".kimi-code");
    let realRoot;
    let indexRaw;
    try {
      [realRoot, indexRaw] = await Promise.all([
        realpath(join(kimiRoot, "sessions")),
        readFile(join(kimiRoot, "session_index.jsonl"), "utf8"),
      ]);
    } catch {
      throw Object.assign(new Error("session not found"), { code: "SOURCE_NOT_FOUND" });
    }
    let sessionDir = null;
    for (const line of indexRaw.split(/\r?\n/)) {
      if (!line.trim().startsWith("{")) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.sessionId === id && entry?.sessionDir) sessionDir = entry.sessionDir;
      } catch {
        continue;
      }
    }
    if (!sessionDir) throw Object.assign(new Error("session not found"), { code: "SOURCE_NOT_FOUND" });
    let real;
    try {
      real = await realpath(join(sessionDir, "agents", "main", "wire.jsonl"));
    } catch {
      throw Object.assign(new Error("session not found"), { code: "SOURCE_NOT_FOUND" });
    }
    if (!real.startsWith(realRoot + sep)) {
      throw Object.assign(new Error("session path escapes the sessions root"), { code: "VALIDATION_FAILED" });
    }
    const info = await stat(real);
    const { text, truncatedHead } = await tailText(real, PREVIEW_TAIL_BYTES);
    const lines = text.split(/\r?\n/);
    if (truncatedHead) lines.shift();
    const messages = [];
    const prompts = []; // turn.prompt 兜底轨
    for (const line of lines) {
      if (!line.trim().startsWith("{")) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const collect = (role, content, timeMs) => {
        const parts = (Array.isArray(content) ? content : [])
          .filter((part) => typeof part?.text === "string" && part.text.trim())
          .map((part) => part.text);
        if (!parts.length) return null;
        let body = parts.join("\n");
        if (role === "user") body = meaningfulUserText(body);
        if (!body) return null;
        const flat = scrub(body).trim();
        return {
          role,
          text: flat.length > PREVIEW_CHAR_LIMIT ? `${flat.slice(0, PREVIEW_CHAR_LIMIT)}…` : flat,
          timestamp: Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : null,
        };
      };
      if (event.type === "context.append_message") {
        const role = event.message?.role;
        if (role !== "user" && role !== "assistant") continue;
        const message = collect(role, event.message?.content, event.time);
        if (message) messages.push(message);
      } else if (event.type === "turn.prompt" && event.origin?.kind === "user") {
        const message = collect("user", event.input, event.time);
        if (message) prompts.push(message);
      }
    }
    const chosen = messages.length ? messages : prompts;
    const clipped = chosen.slice(-maxMessages);
    return {
      source: "kimi",
      id,
      totalBytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      truncated: truncatedHead || clipped.length < chosen.length,
      messages: clipped,
    };
  }

  // Pi 只读预览（v3.7 扩源配套）：scope 目录名含空格进不了 safePathName 白名单——
  // 改为限量扫描按文件名精确匹配（≤400 文件），realpath 限根后解析 {type:"message"} 行。
  async previewPi({ id, maxMessages = PREVIEW_MAX_MESSAGES } = {}) {
    if (!safePathName(id)) {
      throw Object.assign(new Error("invalid session id"), { code: "VALIDATION_FAILED" });
    }
    const root = join(this.home, ".pi", "agent", "sessions");
    let realRoot;
    try {
      realRoot = await realpath(root);
    } catch {
      throw Object.assign(new Error("session not found"), { code: "SOURCE_NOT_FOUND" });
    }
    const files = await collectJsonl(root, { maxDepth: 2, limit: 400 });
    const hit = files.find((file) => file.name === `${id}.jsonl`);
    if (!hit) throw Object.assign(new Error("session not found"), { code: "SOURCE_NOT_FOUND" });
    const real = await realpath(hit.path);
    if (!real.startsWith(realRoot + sep)) {
      throw Object.assign(new Error("session path escapes the sessions root"), { code: "VALIDATION_FAILED" });
    }
    const info = await stat(real);
    const { text, truncatedHead } = await tailText(real, PREVIEW_TAIL_BYTES);
    const lines = text.split(/\r?\n/);
    if (truncatedHead) lines.shift();
    const messages = [];
    for (const line of lines) {
      if (!line.trim().startsWith("{")) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== "message") continue;
      const role = event.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const parts = (Array.isArray(event.message?.content) ? event.message.content : [])
        .filter((part) => typeof part?.text === "string" && part.text.trim())
        .map((part) => part.text);
      if (!parts.length) continue;
      let body = parts.join("\n");
      if (role === "user") body = meaningfulUserText(body);
      if (!body) continue;
      const flat = scrub(body).trim();
      messages.push({
        role,
        text: flat.length > PREVIEW_CHAR_LIMIT ? `${flat.slice(0, PREVIEW_CHAR_LIMIT)}…` : flat,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : Number.isFinite(event.message?.timestamp) ? new Date(event.message.timestamp).toISOString() : null,
      });
    }
    const clipped = messages.slice(-maxMessages);
    return {
      source: "pi",
      id,
      totalBytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      truncated: truncatedHead || clipped.length < messages.length,
      messages: clipped,
    };
  }

  // Cursor 只读预览（codeg 对标 P2 配套）：composerData 拿消息头，从尾部按 key 参数化点查 bubble
  // （取最近 maxMessages 条有文本的，与其他源"最近消息"尾窗语义一致；点查上限 CURSOR_PREVIEW_MAX_BUBBLES）。
  // 只回 user/assistant 文本骨架 + 双层 scrub + 截断；cursorDiskKV 点查失败/结构漂移 → 空消息列表
  // 如实呈现（前端显示"没有可预览的文本消息"），不报错不伪造；id 不在权威列表才 404。
  async previewCursor({ id, maxMessages = CURSOR_PREVIEW_MAX_MESSAGES } = {}) {
    if (!safePathName(id)) {
      throw Object.assign(new Error("invalid session id"), { code: "VALIDATION_FAILED" });
    }
    const storageDir = cursorGlobalStorageDir(this.home);
    const dbPath = join(storageDir, "state.vscdb");
    let realRoot;
    let realDb;
    try {
      [realRoot, realDb] = await Promise.all([realpath(storageDir), realpath(dbPath)]);
    } catch {
      throw Object.assign(new Error("session not found"), { code: "SOURCE_NOT_FOUND" });
    }
    if (!realDb.startsWith(realRoot + sep)) {
      throw Object.assign(new Error("session path escapes the storage root"), { code: "VALIDATION_FAILED" });
    }
    const db = await openCursorDb(realDb);
    if (!db) throw Object.assign(new Error("session not found"), { code: "SOURCE_NOT_FOUND" });
    try {
      // 存在性以权威列表为准（composerHeaders 读不出 = 源不可用；无此 id = 会话不存在）；
      // 归档/草稿与列表同一条过滤——树里不列出的会话预览也 fail-closed
      const composers = readCursorComposerHeaders(db);
      const composer = composers?.find((entry) => entry?.composerId === id && !entry?.isArchived && !entry?.isDraft) ?? null;
      if (!composer) throw Object.assign(new Error("session not found"), { code: "SOURCE_NOT_FOUND" });
      const headers = cursorConversationHeaders(db, id) ?? [];
      const collected = [];
      let probed = 0;
      let index = headers.length - 1;
      for (; index >= 0 && collected.length < maxMessages && probed < CURSOR_PREVIEW_MAX_BUBBLES; index -= 1) {
        const header = headers[index];
        const role = header?.type === 1 ? "user" : header?.type === 2 ? "assistant" : null;
        if (!role || typeof header.bubbleId !== "string") continue;
        probed += 1;
        const bubble = cursorBubble(db, id, header.bubbleId);
        const text = bubble?.text;
        if (typeof text !== "string" || !text.trim()) continue; // assistant 纯工具调用 text 为空：跳过
        const body = role === "user" ? meaningfulUserText(text) : text.trim();
        if (!body) continue;
        const flat = scrub(body).trim();
        if (!flat) continue;
        collected.push({
          role,
          text: flat.length > PREVIEW_CHAR_LIMIT ? `${flat.slice(0, PREVIEW_CHAR_LIMIT)}…` : flat,
          timestamp:
            typeof bubble?.createdAt === "string" ? bubble.createdAt : typeof header.createdAt === "string" ? header.createdAt : null,
        });
      }
      const modifiedMs = Number(composer.lastUpdatedAt ?? composer.createdAt) || 0;
      const info = await stat(realDb);
      return {
        source: "cursor",
        id,
        totalBytes: info.size,
        modifiedAt: modifiedMs ? new Date(modifiedMs).toISOString() : null,
        truncated: index >= 0,
        messages: collected.reverse(), // 尾窗收集后恢复时间正序
      };
    } finally {
      try {
        db.close();
      } catch {
        // 关闭失败不影响结果
      }
    }
  }

  // Codex rollout 只读预览：与 claude preview 同纪律（只回 user/assistant 文本骨架、双层 scrub、截断）。
  // 只取 type:"response_item" 的 message——event_msg 是同一事件的镜像，双取会重复。
  async previewCodex({ scope, id, maxMessages = PREVIEW_MAX_MESSAGES } = {}) {
    const real = await this.resolveFilePath({ source: "codex", scope, id });
    const info = await stat(real);
    const { text, truncatedHead } = await tailText(real, PREVIEW_TAIL_BYTES);
    const lines = text.split(/\r?\n/);
    if (truncatedHead) lines.shift(); // 尾读窗口首行可能是半行
    const messages = [];
    for (const line of lines) {
      if (!line.trim().startsWith("{")) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== "response_item") continue;
      const payload = event.payload;
      if (payload?.type !== "message") continue;
      const role = payload.role;
      if (role !== "user" && role !== "assistant") continue;
      const parts = (Array.isArray(payload.content) ? payload.content : [])
        .filter((part) => ["input_text", "output_text", "text"].includes(part?.type) && typeof part.text === "string" && part.text.trim())
        .map((part) => part.text);
      if (!parts.length) continue;
      let body = parts.join("\n");
      if (role === "user") body = meaningfulUserText(body); // 剥 AGENTS.md/环境上下文注入样板
      if (!body) continue;
      const flat = scrub(body).trim();
      messages.push({
        role,
        text: flat.length > PREVIEW_CHAR_LIMIT ? `${flat.slice(0, PREVIEW_CHAR_LIMIT)}…` : flat,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : null,
      });
    }
    const clipped = messages.slice(-maxMessages);
    return {
      source: "codex",
      id,
      totalBytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      truncated: truncatedHead || clipped.length < messages.length,
      messages: clipped,
    };
  }

  async #claudeSessions(limit, includeSummaries) {
    const source = { source: "claude", label: "Claude Code", available: false, sessionCount: 0, sessions: [] };
    const projectsRoot = join(this.home, ".claude", "projects");
    try {
      const projects = await readdir(projectsRoot, { withFileTypes: true });
      const realRoot = await realpath(projectsRoot);
      source.available = true;
      const perProjectFiles = await mapConcurrent(projects.filter((project) => project.isDirectory()), 6, async (project) => {
        const projectDir = join(projectsRoot, project.name);
        let names;
        try {
          names = await readdir(projectDir);
        } catch {
          return [];
        }
        const candidates = names.filter((name) => name.endsWith(".jsonl"));
        return (await mapConcurrent(candidates, 4, async (name) => {
          try {
            const filePath = join(projectDir, name);
            // 与 projects()/preview() 同一条限根不变量：逃逸 symlink 不列出、不读取（烛 R6 致命1）
            const [info, real] = await Promise.all([stat(filePath), realpath(filePath)]);
            if (!info.isFile() || !real.startsWith(realRoot + sep)) return null;
            return { project: project.name, name, path: real, size: info.size, mtimeMs: info.mtimeMs };
          } catch {
            return null; // 跳过瞬时消失文件
          }
        })).filter(Boolean);
      });
      const files = perProjectFiles.flat();
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      source.sessionCount = files.totalCount ?? files.length;
      const top = files.slice(0, limit);
      const summaries = includeSummaries
        ? await mapConcurrent(top, 8, (file) => firstUserTextFromFile(file.path).catch(() => null))
        : new Array(top.length).fill(null);
      for (const [index, file] of top.entries()) {
        source.sessions.push({
          id: file.name.replace(/\.jsonl$/, ""),
          scope: file.project,
          summary: summaries[index],
          size: file.size,
          modifiedAt: new Date(file.mtimeMs).toISOString(),
        });
      }
    } catch (error) {
      source.error = error.code || error.message;
    }
    return source;
  }

  async #codexSessions(limit, includeSummaries) {
    const source = { source: "codex", label: "Codex CLI", available: false, sessionCount: 0, sessions: [] };
    const root = join(this.home, ".codex", "sessions");
    try {
      await stat(root);
      source.available = true;
      const files = await collectJsonl(root, { maxDepth: 4, limit });
      source.sessionCount = files.totalCount ?? files.length;
      const summaries = includeSummaries
        ? await mapConcurrent(files, 8, (file) => firstUserTextFromFile(file.path).catch(() => null))
        : new Array(files.length).fill(null);
      for (const [index, file] of files.entries()) {
        source.sessions.push({
          id: file.name.replace(/\.jsonl$/, ""),
          scope: file.dir.slice(root.length + 1) || ".",
          summary: summaries[index],
          size: file.size,
          modifiedAt: new Date(file.mtimeMs).toISOString(),
        });
      }
    } catch (error) {
      source.error = error.code || error.message;
    }
    return source;
  }

  async #bridgeThreads() {
    const source = { source: "bridge", label: "对话桥（roster）", available: false, sessionCount: 0, sessions: [] };
    try {
      const roster = JSON.parse(await readFile(join(this.aiSharedRoot, "roster.json"), "utf8"));
      source.available = true;
      for (const [code, agent] of Object.entries(roster.agents || {})) {
        source.sessions.push({
          id: agent.lastThreadId || "(无活跃线程)",
          scope: `${agent.name || code} · ${agent.transport || "?"}`,
          // lastTopic 约定只写治理描述，但仍过 scrub（烛 R-P3 建议：不依赖写入契约，纵深防御）
          summary: agent.lastTopic ? scrub(agent.lastTopic) : null,
          size: null,
          modifiedAt: agent.lastRunAt || null,
        });
      }
      source.sessionCount = source.sessions.length;
    } catch (error) {
      source.error = error.code || error.message;
    }
    return source;
  }

  async #grokSessions(limit) {
    const source = { source: "grok", label: "Grok Build", available: false, sessionCount: 0, sessions: [] };
    // Grok Build 会话目录未在本机实证过固定结构——按常见候选探测，全部落空则如实 unavailable
    for (const candidate of ["sessions", "threads", "history"]) {
      const root = join(this.home, ".grok", candidate);
      try {
        await stat(root);
        source.available = true;
        const files = await collectJsonl(root, { maxDepth: 3, limit });
        source.sessionCount = files.totalCount ?? files.length;
        for (const file of files) {
          source.sessions.push({
            id: file.name.replace(/\.jsonl$/, ""),
            scope: file.dir.slice(root.length + 1) || candidate,
            summary: null,
            size: file.size,
            modifiedAt: new Date(file.mtimeMs).toISOString(),
          });
        }
        return source;
      } catch {
        // 尝试下一个候选目录
      }
    }
    source.error = "no known session directory";
    return source;
  }

  // W1.6 Gemini CLI 会话（2026-08-30 本机实证）：
  // ~/.gemini/tmp/<project>/chats/session-*.json——<project> 为明文 cwd 名或 64-hex sha256 哈希；
  // 明文/短哈希目录带 .project_root（首行 = cwd）；session json 头部字段
  // { sessionId, projectHash, startTime, lastUpdated, messages[{id,timestamp,type,content}] }。
  // 哈希目录无法逆映射 cwd——scope 如实标注为 "hash:<dir>" 或附 .project_root，不伪造路径。
  async #geminiSessions(limit, includeSummaries) {
    const source = { source: "gemini", label: "Gemini CLI", available: false, sessionCount: 0, sessions: [] };
    const tmpRoot = join(this.home, ".gemini", "tmp");
    const GEMINI_PARSE_LIMIT = 2 * 1024 * 1024; // >2MB 不解析内容，只用文件名时间戳（避免整文件 JSON 巨读）
    try {
      const realTmp = await realpath(tmpRoot);
      const projects = await readdir(tmpRoot, { withFileTypes: true });
      source.available = true;
      const collected = [];
      await mapConcurrent(projects.filter((entry) => entry.isDirectory()), 4, async (project) => {
        const projectDir = join(tmpRoot, project.name);
        // 限根同 claude/codex 纪律：逃逸 symlink 不列出、不读取
        let realProjectDir;
        try {
          realProjectDir = await realpath(projectDir);
        } catch {
          return;
        }
        if (!realProjectDir.startsWith(realTmp + sep)) return;
        // cwd 还原：.project_root 存在且真实位于本目录内才读（首行即 cwd）
        let cwd = null;
        try {
          const prPath = join(projectDir, ".project_root");
          const prReal = await realpath(prPath);
          if (prReal === join(realProjectDir, ".project_root")) {
            cwd = (await readFile(prPath, "utf8")).split(/\r?\n/)[0].trim() || null;
          }
        } catch {
          cwd = null; // 无映射如实置 null，不猜
        }
        const scope = cwd || (/^[0-9a-f]{64}$/.test(project.name) ? `hash:${project.name}` : project.name);
        const chatsDir = join(projectDir, "chats");
        let names;
        try {
          names = await readdir(chatsDir);
        } catch {
          return;
        }
        for (const name of names.filter((item) => /^session-.*\.json$/.test(item))) {
          try {
            const filePath = join(chatsDir, name);
            const [info, real] = await Promise.all([stat(filePath), realpath(filePath)]);
            if (!info.isFile() || !real.startsWith(realProjectDir + sep)) continue;
            let id = name.replace(/\.json$/, "");
            let summary = null;
            if (info.size <= GEMINI_PARSE_LIMIT) {
              try {
                const parsed = JSON.parse(await readFile(real, "utf8"));
                if (typeof parsed.sessionId === "string" && parsed.sessionId) id = parsed.sessionId;
                if (includeSummaries && Array.isArray(parsed.messages)) {
                  const firstUser = parsed.messages.find((message) => message?.type === "user" && typeof message.content === "string" && message.content.trim());
                  if (firstUser) summary = scrub(firstUser.content.trim().slice(0, 200));
                }
              } catch {
                // 解析失败退回文件名 id——如实降级，不伪造
              }
            }
            collected.push({
              id,
              scope,
              summary,
              size: info.size,
              modifiedAt: new Date(info.mtimeMs).toISOString(),
            });
          } catch {
            // 跳过瞬时消失文件
          }
        }
      });
      collected.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
      source.sessionCount = collected.length;
      source.sessions = collected.slice(0, limit);
    } catch (error) {
      source.error = error.code || error.message;
    }
    return source;
  }

  // v4.0 codeg 对标扩源：OpenCode / Cline / OpenClaw / Hermes / CodeBuddy 五源
  // 每源独立 try/catch：拿得到就列，拿不到如实标 unavailable——绝不伪造。
  // 只探测已知目录结构（codeg 源码实证），本机不存在时 gracefully unavailable。

  async #opencodeSessions(limit) {
    const source = { source: "opencode", label: "OpenCode", available: false, sessionCount: 0, sessions: [] };
    // OpenCode 会话存储在 SQLite DB（~/.local/share/opencode/opencode.db）
    const dbPath = join(this.home, ".local", "share", "opencode", "opencode.db");
    try {
      const info = await stat(dbPath);
      if (!info.isFile()) return source;
      source.available = true;
      // SQLite DB 无法直接 JSONL 扫描——标记可用但不解析内容（需 better-sqlite3 或 sql.js）
      source.sessionCount = -1; // -1 = 可用但数量未知
      source.note = "SQLite 数据库，需专用解析器";
    } catch {
      // 目录不存在 = unavailable
    }
    return source;
  }

  async #clineSessions(limit) {
    const source = { source: "cline", label: "Cline", available: false, sessionCount: 0, sessions: [] };
    // Cline 会话存储在 ~/.cline/data/tasks
    const root = join(this.home, ".cline", "data", "tasks");
    try {
      await stat(root);
      source.available = true;
      const files = await collectJsonl(root, { maxDepth: 2, limit });
      source.sessionCount = files.totalCount ?? files.length;
      for (const file of files) {
        source.sessions.push({
          id: file.name.replace(/\.jsonl$/, ""),
          scope: file.dir.slice(root.length + 1) || "tasks",
          summary: null,
          size: file.size,
          modifiedAt: new Date(file.mtimeMs).toISOString(),
        });
      }
    } catch {
      // 目录不存在 = unavailable
    }
    return source;
  }

  async #openclawSessions(limit) {
    const source = { source: "openclaw", label: "OpenClaw", available: false, sessionCount: 0, sessions: [] };
    // OpenClaw 会话存储在 ~/.openclaw/agents
    const root = join(this.home, ".openclaw", "agents");
    try {
      await stat(root);
      source.available = true;
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      let count = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const agentDir = join(root, entry.name);
        const files = await collectJsonl(agentDir, { maxDepth: 2, limit: Math.max(1, Math.floor(limit / entries.length)) });
        count += files.totalCount ?? files.length;
        for (const file of files.slice(0, 3)) { // 每个 agent 最多取 3 条
          source.sessions.push({
            id: file.name.replace(/\.jsonl$/, ""),
            scope: entry.name,
            summary: null,
            size: file.size,
            modifiedAt: new Date(file.mtimeMs).toISOString(),
          });
        }
      }
      source.sessionCount = count;
    } catch {
      // 目录不存在 = unavailable
    }
    return source;
  }

  async #hermesSessions(limit) {
    const source = { source: "hermes", label: "Hermes Agent", available: false, sessionCount: 0, sessions: [] };
    // Hermes Agent 会话存储在 SQLite DB（~/.hermes/state.db）
    const dbPath = join(this.home, ".hermes", "state.db");
    try {
      const info = await stat(dbPath);
      if (!info.isFile()) return source;
      source.available = true;
      source.sessionCount = -1;
      source.note = "SQLite 数据库，需专用解析器";
    } catch {
      // 目录不存在 = unavailable
    }
    return source;
  }

  async #codebuddySessions(limit) {
    const source = { source: "codebuddy", label: "CodeBuddy", available: false, sessionCount: 0, sessions: [] };
    // CodeBuddy 会话存储在 ~/.codebuddy/projects
    const root = join(this.home, ".codebuddy", "projects");
    try {
      await stat(root);
      source.available = true;
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      let count = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const projectDir = join(root, entry.name);
        const files = await collectJsonl(projectDir, { maxDepth: 2, limit: Math.max(1, Math.floor(limit / entries.length)) });
        count += files.totalCount ?? files.length;
        for (const file of files.slice(0, 3)) {
          source.sessions.push({
            id: file.name.replace(/\.jsonl$/, ""),
            scope: entry.name,
            summary: null,
            size: file.size,
            modifiedAt: new Date(file.mtimeMs).toISOString(),
          });
        }
      }
      source.sessionCount = count;
    } catch {
      // 目录不存在 = unavailable
    }
    return source;
  }
}
