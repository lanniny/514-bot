/**
 * pty.mjs — Wave G 本机 PTY 终端核心（node-pty ConPTY）。
 *
 * 契约（v40 设计 §3.4）：
 *   - cwd 沙箱：默认 repoRoot；显式 cwd 必须在 repoRoot 内或 allowlist 根内
 *   - 输出：256KB 环形缓冲 + SSE 推流，redaction 过滤敏感模式
 *   - 输入：单飞有序写队列（promise chain）
 *   - 生命周期：spawn 登记 child-registry，exit/kill 注销；审计 pty.spawn/exit/kill
 */

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isWithin } from "./paths.mjs";
import { childRegistry } from "./child-registry.mjs";
import { scrub } from "./redaction.mjs";
import { envLookup, withRuntimeExecutablePath } from "./runtime-executable-dirs.mjs";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const BUFFER_CAP = 256 * 1024;
const SESSION_CAP = 16;
const ARGS_CAP = 32;
const ARGS_CHARS_CAP = 4096;
const TITLE_CAP = 120;

/** spawn 参数白名单清洗：必须数组、逐元素 String 化、拒 NUL；超帽如实 400，不静默截断。 */
function sanitizeArgs(args) {
  if (args == null) return [];
  if (!Array.isArray(args)) {
    throw Object.assign(new Error("pty args must be an array of strings"), { code: "PTY_BAD_ARGS", httpStatus: 400 });
  }
  if (args.length > ARGS_CAP) {
    throw Object.assign(new Error(`pty args cap reached (${ARGS_CAP})`), { code: "PTY_BAD_ARGS", httpStatus: 400 });
  }
  const out = args.map((item) => String(item));
  if (out.some((item) => item.includes("\0")) || out.join("").length > ARGS_CHARS_CAP) {
    throw Object.assign(new Error("pty args contain NUL or exceed size cap"), { code: "PTY_BAD_ARGS", httpStatus: 400 });
  }
  return out;
}

/** 页签标题（如「lanniny-45 · /srv/data」）：去 NUL/trim，超长截断，空则 null 走 shell 名。 */
function sanitizeTitle(title) {
  if (title == null) return null;
  const clean = String(title).replace(/\0/g, "").trim().slice(0, TITLE_CAP);
  return clean || null;
}

/**
 * 默认 shell（LO 2026-08-08：终端要和自己的 PowerShell 一致，而不是 cmd）。
 * Windows 依次探测 PowerShell 7 → Windows PowerShell → COMSPEC/cmd.exe：
 * 命中哪个都会加载用户自己的 profile，提示符与配色自然与本机一致。
 * 只认 PATH 中真实存在的可执行文件，探测失败一律回落 cmd.exe，不猜路径。
 */
export function defaultShell(platform = process.platform, env = process.env, exists = existsSync) {
  if (platform !== "win32") return env.SHELL || "sh";
  const dirs = String(env.PATH || env.Path || "").split(";").map((item) => item.trim()).filter(Boolean);
  for (const candidate of ["pwsh.exe", "powershell.exe"]) {
    for (const dir of dirs) {
      const full = join(dir, candidate);
      try {
        if (exists(full)) return full;
      } catch { /* 不可读目录不算命中 */ }
    }
  }
  return env.COMSPEC || "cmd.exe";
}

/**
 * Windows spawn 命令解析：npm 系 CLI（opencode/codex/pi…）在 PATH 里往往只有 .cmd 批处理
 * shim，node-pty 的 CreateProcess 只认真可执行文件，裸名直接 spawn 报 error 2（找不到
 * <name>.exe）。语义与在终端手敲完全一致：按 PATH 顺序逐目录扫 PATHEXT，首个命中目录取
 * 首个扩展名——.exe/.com 直接全路径 spawn；.cmd/.bat 等脚本 shim 交 cmd.exe /d /c 用裸名
 * （由 cmd 自己做 PATH+PATHEXT 解析，这里不重复实现引号/转义规则）。显式路径、显式
 * .exe/.com、非 Windows、PATH 找不到——一律原样透传，spawn 错误如实冒泡给调用方。
 */
export function resolveSpawnCommand(command, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const name = String(command ?? "").trim();
  if (platform !== "win32" || !name || /[\\/]/.test(name) || /\.(exe|com)$/i.test(name)) {
    return { command: name, prefixArgs: [] };
  }
  env = withRuntimeExecutablePath(env, { exists });
  const dirs = String(env.PATH || env.Path || "").split(";").map((dir) => dir.trim()).filter(Boolean);
  const exts = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, name + ext);
      let hit = false;
      try {
        hit = exists(full);
      } catch { /* 不可读目录不算命中 */ }
      if (!hit) continue;
      if (ext === ".exe" || ext === ".com") return { command: full, prefixArgs: [] };
      return { command: envLookup(env, "COMSPEC") || "cmd.exe", prefixArgs: ["/d", "/c", name] };
    }
  }
  return { command: name, prefixArgs: [] };
}

export function createPtyService({
  repoRoot,
  eventStore = null,
  spawnImpl = pty.spawn.bind(pty),
  registry = null,
  extraCwdRoots = [],
} = {}) {
  const sessions = new Map(); // id → session
  const root = resolve(repoRoot);

  function currentAllowedRoots() {
    const extra = typeof extraCwdRoots === "function" ? extraCwdRoots() : extraCwdRoots;
    return [root, ...[...extra].map((entry) => resolve(String(entry)))];
  }

  function audit(type, detail) {
    void eventStore?.emit?.(type, detail, { sensitivity: "internal", agentId: "control-plane" })?.catch?.(() => {});
  }

  function assertCwd(candidate, extraRoots = []) {
    if (candidate == null || candidate === "") return root;
    const resolved = resolve(String(candidate));
    const allowed = extraRoots.length
      ? [...currentAllowedRoots(), ...extraRoots.map((entry) => resolve(String(entry)))]
      : currentAllowedRoots();
    // 词法关闸先跑，快路径（已存在、无符号链接）与历史行为一致
    const lexicalRoot = allowed.find((rootEntry) => isWithin(rootEntry, resolved));
    if (!lexicalRoot) {
      throw Object.assign(new Error("pty cwd escapes its allowed roots"), {
        code: "PTY_CWD_BOUNDARY",
        httpStatus: 403,
      });
    }
    // 语义关闸：词法 isWithin 挡不住根内 symlink/junction 指向根外。取 candidate
    // 最深已存在祖先的 realpath 与每个 allowed root 的 realpath 再比对；realpathSync
    // 会把 Windows junction/reparse point 一并解析到目标真实路径。
    const realAllowed = allowed.map((entry) => safeRealpath(entry));
    const realCandidate = safeRealpath(resolved);
    if (!realAllowed.some((rootEntry) => isWithin(rootEntry, realCandidate))) {
      throw Object.assign(new Error("pty cwd resolves outside its allowed roots"), {
        code: "PTY_CWD_BOUNDARY",
        httpStatus: 403,
      });
    }
    return resolved;
  }

  function safeRealpath(targetPath) {
    let current = resolve(targetPath);
    while (true) {
      try {
        return realpathSync(current);
      } catch {
        const parent = dirname(current);
        if (parent === current) {
          return resolve(targetPath);
        }
        current = parent;
      }
    }
  }

  function pushOutput(session, chunk) {
    const clean = scrub(String(chunk));
    if (!clean) return;
    session.buffer = (session.buffer + clean).slice(-BUFFER_CAP);
    session.bytes += clean.length;
    for (const listener of session.listeners) {
      try {
        listener(clean);
      } catch { /* 单个订阅者异常不阻断广播 */ }
    }
  }

  function create({ shell, cwd, cols = 80, rows = 24, args = null, title = null, extraCwdRoots = [], dedupeKey = null, kind = null } = {}) {
    // 幂等复用（run CLI 接续）：同一原生会话重复点开终端时归还在途 PTY，
    // 不重复 spawn 第二个进程抢同一份 session 文件。终态会话不复用，照常新起。
    if (dedupeKey != null) {
      const existing = [...sessions.values()].find((entry) => entry.dedupeKey === dedupeKey && !entry.exited);
      if (existing) {
        return {
          id: existing.id, shell: existing.shell, title: existing.title, cwd: existing.cwd,
          pid: existing.pid, cols: existing.cols, rows: existing.rows, createdAt: existing.createdAt,
          kind: existing.kind ?? null,
          reused: true,
        };
      }
    }
    // 容量只数活会话：已退出的条目留着供 UI 呈现终态/滚动回看，不应把新会话顶成 429
    const liveSessions = [...sessions.values()].filter((entry) => !entry.exited).length;
    if (liveSessions >= SESSION_CAP) {
      throw Object.assign(new Error(`pty session cap reached (${SESSION_CAP})`), { code: "PTY_CAP", httpStatus: 429 });
    }
    // extraCwdRoots 仅供专用路由（如 run CLI 接续）按次放行 run.cwd——
    // 通用 /api/pty 面不透传该参数，沙箱边界不变
    const safeCwd = assertCwd(cwd, Array.isArray(extraCwdRoots) ? extraCwdRoots : []);
    const safeCols = Math.min(500, Math.max(1, Number(cols) || 80));
    const safeRows = Math.min(500, Math.max(1, Number(rows) || 24));
    const safeArgs = sanitizeArgs(args);
    const safeTitle = sanitizeTitle(title);
    const command = typeof shell === "string" && shell.trim() ? shell.trim() : defaultShell();
    // Windows npm shim（.cmd）不能直接 CreateProcess——按需包 cmd /d /c，语义同终端手敲
    const spawnEnv = withRuntimeExecutablePath(process.env);
    const resolved = resolveSpawnCommand(command, { env: spawnEnv });
    const proc = spawnImpl(resolved.command, [...resolved.prefixArgs, ...safeArgs], {
      name: "xterm-color",
      cwd: safeCwd,
      cols: safeCols,
      rows: safeRows,
      env: spawnEnv,
    });
    const id = randomUUID().slice(0, 8);
    const session = {
      id,
      shell: command,
      title: safeTitle,
      cwd: safeCwd,
      dedupeKey: dedupeKey == null ? null : String(dedupeKey),
      // 会话种类标记：CLI 接续（kind:"cli"）只属于沉浸罩层，通用终端面板（底部抽屉/终端视图）
      // 按此标记过滤，保持纯 shell——LO 2026-08-17：下侧栏终端只显示项目路径下的命令行
      kind: kind == null ? null : String(kind),
      pid: proc.pid,
      cols: safeCols,
      rows: safeRows,
      buffer: "",
      bytes: 0,
      exited: false,
      exitCode: null,
      createdAt: new Date().toISOString(),
      listeners: new Set(),
      writeChain: Promise.resolve(),
      proc,
    };
    sessions.set(id, session);
    try {
      (registry ?? childRegistry())?.register(proc.pid, command);
    } catch { /* 台账未初始化不阻断会话（测试场景） */ }
    proc.onData((chunk) => pushOutput(session, chunk));
    proc.onExit(({ exitCode }) => {
      session.exited = true;
      session.exitCode = exitCode;
      try {
        (registry ?? childRegistry())?.unregister(proc.pid);
      } catch { /* 同上 */ }
      for (const listener of session.listeners) {
        try {
          listener(null, { exited: true, exitCode });
        } catch { /* 忽略 */ }
      }
      audit("pty.exit", { id, pid: proc.pid, exitCode });
    });
    audit("pty.spawn", { id, pid: proc.pid, shell: command, cwd: safeCwd });
    return { id, shell: command, title: safeTitle, cwd: safeCwd, pid: proc.pid, cols: safeCols, rows: safeRows, createdAt: session.createdAt, kind: session.kind };
  }

  function get(id) {
    return sessions.get(String(id)) ?? null;
  }

  function list() {
    return [...sessions.values()].map((session) => ({
      id: session.id,
      shell: session.shell,
      title: session.title ?? null,
      cwd: session.cwd,
      kind: session.kind ?? null,
      pid: session.pid,
      cols: session.cols,
      rows: session.rows,
      exited: session.exited,
      exitCode: session.exitCode,
      createdAt: session.createdAt,
      bytes: session.bytes,
    }));
  }

  /** 订阅输出。listener(chunk) 数据块；listener(null, { exited, exitCode }) 终态。返回退订函数。 */
  function subscribe(id, listener, { replay = true } = {}) {
    const session = get(id);
    if (!session) return null;
    if (replay && session.buffer) listener(session.buffer);
    session.listeners.add(listener);
    if (session.exited) listener(null, { exited: true, exitCode: session.exitCode });
    return () => session.listeners.delete(listener);
  }

  function write(id, data) {
    const session = get(id);
    if (!session) {
      throw Object.assign(new Error(`pty session not found: ${id}`), { code: "PTY_NOT_FOUND", httpStatus: 404 });
    }
    if (session.exited) {
      throw Object.assign(new Error("pty session already exited"), { code: "PTY_EXITED", httpStatus: 409 });
    }
    const payload = String(data ?? "");
    // 单次写失败不得毒化整条队列：先吞掉链上已有拒绝再挂本次写入，否则此后每个输入都拿到陈旧错误（对照 event-store 同款做法）
    session.writeChain = session.writeChain.catch(() => {}).then(() => {
      if (!session.exited) session.proc.write(payload);
    });
    return session.writeChain;
  }

  function resize(id, cols, rows) {
    const session = get(id);
    if (!session) {
      throw Object.assign(new Error(`pty session not found: ${id}`), { code: "PTY_NOT_FOUND", httpStatus: 404 });
    }
    const safeCols = Math.min(500, Math.max(1, Number(cols) || session.cols));
    const safeRows = Math.min(500, Math.max(1, Number(rows) || session.rows));
    session.cols = safeCols;
    session.rows = safeRows;
    if (!session.exited) session.proc.resize(safeCols, safeRows);
    return { cols: safeCols, rows: safeRows };
  }

  function kill(id) {
    const session = get(id);
    if (!session) return false;
    sessions.delete(session.id);
    if (!session.exited) {
      session.exited = true;
      try {
        session.proc.kill();
      } catch { /* 已死 */ }
      try {
        (registry ?? childRegistry())?.unregister(session.pid);
      } catch { /* 同上 */ }
      audit("pty.kill", { id: session.id, pid: session.pid });
    }
    for (const listener of session.listeners) {
      try {
        listener(null, { exited: true, exitCode: session.exitCode, killed: true });
      } catch { /* 忽略 */ }
    }
    session.listeners.clear();
    return true;
  }

  async function closeAll() {
    for (const session of [...sessions.values()]) kill(session.id);
  }

  return { create, get, list, subscribe, write, resize, kill, closeAll, assertCwd };
}
