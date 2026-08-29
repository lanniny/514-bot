// 514cc 治理观测服务（v3.5 桌面版增量）：把 .ai-shared 里已经在写、但只有 hook 在
// 机械消费的治理数据源（route-gate.log / DELTA 账本 / handoff / mirror-gate.log /
// 双地落漂移）接到 Console 前端——"体系被 LO 看见"的面板层。
// 口径对齐既有 hook：route-gate.log TSV 5 列（route-gate.py:159）、DELTA 行
// ^__DELTA__:（mirror-gate.py DELTA_RE）、外部发火前缀（mirror-gate FIRE_PREFIXES）。
import { createReadStream } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { childProcessEnv, spawnCommand } from "./process-runner.mjs";

const DELTA_LINE = /^__DELTA__:\s*(.+)\s*$/;
const FIRE_PREFIXES = ["codex-to-", "gemini-to-", "grok-to-"];

async function* logLines(path) {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
    input.destroy();
  }
}

function summonedState(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["yes", "true", "1", "y"].includes(normalized)) return "yes";
  if (["no", "false", "0", "n"].includes(normalized)) return "no";
  if (["", "?", "unknown", "pending", "-"].includes(normalized)) return "unknown";
  return null;
}

function parseDelta(line, source) {
  const match = line.match(DELTA_LINE);
  if (!match) return null;
  const parts = match[1].split("|").map((part) => part.trim());
  const score = Number(parts[1]);
  return {
    source,
    agent: parts[0] || "unknown",
    score: Number.isInteger(score) && score >= 0 && score <= 2 ? score : null,
    evidence: parts.slice(2).join(" | ") || "",
  };
}

// handoff 命名约定：<direction>__<topic>__<YYYYMMDD-HHmm>.md —— 提取 ts/topic 供 deltas[]
// 规范化；形态不符时 ts 回退文件 mtime、topic 回退文件名，绝不丢条目
function handoffEntryMeta(file) {
  const base = file.name.replace(/\.md$/, "");
  const stamp = base.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  const ts = stamp
    ? `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:00`
    : new Date(file.mtimeMs).toISOString();
  const topic = stamp
    ? base.slice(0, stamp.index).split("__").filter(Boolean).pop() || base
    : base;
  return { ts, topic };
}

export class ObservabilityService {
  constructor({ aiSharedRoot, repoRoot }) {
    this.aiSharedRoot = aiSharedRoot;
    this.repoRoot = repoRoot;
    this.driftBusy = false;
  }

  async routeGate({ days = 7, recent = 40 } = {}) {
    const result = {
      total: 0,
      red: 0,
      gray: 0,
      byReason: {},
      summoned: { yes: 0, no: 0, unknown: 0 },
      recent: [],
      available: false,
    };
    const cutoff = Date.now() - days * 86_400_000;
    const recentLimit = Math.max(0, Math.floor(Number(recent) || 0));
    const rows = [];
    try {
      // 逐行扫完整文件而非固定字节尾巴：days 才是统计窗口，recent 只限制返回明细。
      // rows 是有界环形尾部，日志再大也不会按总行数占内存。
      for await (const line of logLines(join(this.aiSharedRoot, "route-gate.log"))) {
        const parts = line.split("\t");
        if (parts.length < 2) continue;
        const ts = Date.parse(parts[0].replace(" ", "T"));
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        const flag = parts[1].trim().toUpperCase().startsWith("RED") ? "red" : "gray";
        // v3.5 前日志为 ts/flag/prompt 三列，且旧 prompt 可能自带 TAB；新格式固定至少五列。
        // 只有列数和 summoned token 都符合新契约才按新格式解释，避免把旧 prompt 误计为 reason。
        const parsedSummoned = summonedState(parts[3]);
        const modern = parts.length >= 5 && parsedSummoned !== null;
        const reason = modern ? (parts[2] || "-").trim() || "-" : "-";
        const summoned = modern ? parsedSummoned : "unknown";
        const prompt = (modern ? parts.slice(4) : parts.slice(2)).join("\t").trim();
        const row = { ts: parts[0], flag, reason, summoned, prompt };
        if (recentLimit > 0) {
          rows.push(row);
          if (rows.length > recentLimit) rows.shift();
        }
        result.total += 1;
        result[flag] += 1;
        if (flag === "red") {
          result.summoned[summoned] += 1;
          for (const tag of reason.split(",")) {
            if (tag && tag !== "-") result.byReason[tag] = (result.byReason[tag] || 0) + 1;
          }
        }
      }
    } catch {
      return result;
    }
    result.available = true;
    result.recent = rows.reverse();
    return result;
  }

  async deltaLedger({ recent = 40, strict = false } = {}) {
    // stop-gate 双扫口径：decisions.md + handoff/*.md
    const entries = [];
    const metas = []; // 与 entries 平行：v4.0 deltas[] 的规范化元数据（id/ts/topic 合成源）
    const collect = (text, source, meta) => {
      let lineNo = 0;
      for (const line of text.split(/\r?\n/)) {
        lineNo += 1;
        const entry = parseDelta(line, source);
        if (!entry) continue;
        entries.push(entry);
        metas.push({ id: `${source}#${lineNo}`, ...meta });
      }
    };
    try {
      // decisions.md 行内无时间戳：ts 如实置 null，由前端决定如何呈现
      collect(await readFile(join(this.aiSharedRoot, "decisions.md"), "utf8"), "decisions.md", { ts: null, topic: "decisions" });
    } catch (error) {
      // decisions.md 缺失时账本仍可由 handoff 侧构成
      if (strict) throw Object.assign(new Error("decisions.md is unavailable"), { code: "OBSERVABILITY_DECISIONS_UNAVAILABLE", cause: error });
    }
    for (const file of await this.#handoffFiles({ strict })) {
      try {
        collect(await readFile(file.path, "utf8"), file.name, handoffEntryMeta(file));
      } catch (error) {
        // 单文件读取失败不阻塞账本
        if (strict) throw Object.assign(new Error(`handoff ${file.name} is unavailable`), { code: "OBSERVABILITY_HANDOFF_UNAVAILABLE", cause: error });
      }
    }
    const byScore = { 0: 0, 1: 0, 2: 0, invalid: 0 };
    for (const entry of entries) {
      if (entry.score === null) byScore.invalid += 1;
      else byScore[entry.score] += 1;
    }
    return {
      total: entries.length,
      byScore,
      recent: entries.slice(-recent).reverse(),
      // v4.0 Forge 前端时间线契约：与 recent 同源的规范化全量明细；
      // id 由 来源#行号 合成（稳定唯一），ts/topic 从 handoff 文件名提取，缺失如实置 null
      deltas: entries.map((entry, index) => ({
        id: metas[index].id,
        ts: metas[index].ts,
        agent: entry.agent,
        score: entry.score,
        topic: metas[index].topic,
        evidence: entry.evidence,
      })),
    };
  }

  async handoffs({ limit = 120, strict = false } = {}) {
    const files = await this.#handoffFiles({ strict });
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files.slice(0, limit).map((file) => ({
      name: file.name,
      size: file.size,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
      direction: FIRE_PREFIXES.some((prefix) => file.name.startsWith(prefix))
        ? "external-fire"
        : file.name.startsWith("claude-to-")
          ? "dispatch"
          : file.name.startsWith("synthesis__")
            ? "synthesis"
            : "other",
    }));
  }

  async handoffContent(name) {
    // 防路径穿越：只接受纯文件名，且必须真实存在于 handoff 清单
    if (basename(name) !== name || !name.endsWith(".md")) {
      throw Object.assign(new Error("invalid handoff name"), { code: "VALIDATION_FAILED" });
    }
    const files = await this.#handoffFiles();
    const file = files.find((item) => item.name === name);
    if (!file) throw Object.assign(new Error("handoff not found"), { code: "SOURCE_NOT_FOUND" });
    // 符号链接限根（烛 R-P2 建议）：解析真实路径后必须仍在 handoff 根内，堵链接逃逸
    const handoffRoot = await realpath(join(this.aiSharedRoot, "handoff"));
    const resolved = await realpath(file.path);
    if (resolved !== join(handoffRoot, name) && !resolved.startsWith(handoffRoot + sep)) {
      throw Object.assign(new Error("handoff resolves outside its root"), { code: "VALIDATION_FAILED" });
    }
    return { name, content: await readFile(resolved, "utf8") };
  }

  async summary() {
    const [routeGate, delta, handoffs] = await Promise.all([
      this.routeGate({ recent: 0 }),
      this.deltaLedger({ recent: 0 }),
      this.handoffs({ limit: 500 }),
    ]);
    let daysSinceLastFire = null;
    const lastFire = handoffs.find((item) => item.direction === "external-fire");
    if (lastFire) {
      daysSinceLastFire = Math.floor((Date.now() - Date.parse(lastFire.modifiedAt)) / 86_400_000);
    }
    return {
      routeGate: {
        total: routeGate.total,
        red: routeGate.red,
        gray: routeGate.gray,
        summoned: routeGate.summoned,
        available: routeGate.available,
      },
      delta: { total: delta.total, byScore: delta.byScore },
      handoffs: { total: handoffs.length, lastFire: lastFire?.name || null, daysSinceLastFire },
    };
  }

  /** v3.7 体检脉搏：把治理数据面聚合成一份"agent 可直接判断"的结构化摘要——
     体检自动化把它注入 prompt，agent 不用自己跑工具轮抓数据（省一整圈工具调用与出错面）。
     runtime 段由调用方（server）注入 orchestrator/health 侧数据，本方法只聚合 .ai-shared 数据面。 */
  async pulse({ routeGateDays = 7 } = {}) {
    const [routeGate, delta, handoffs] = await Promise.all([
      this.routeGate({ days: routeGateDays, recent: 5 }),
      this.deltaLedger({ recent: 5 }),
      this.handoffs({ limit: 500 }),
    ]);
    const lastFire = handoffs.find((item) => item.direction === "external-fire");
    const daysSinceLastFire = lastFire ? Math.floor((Date.now() - Date.parse(lastFire.modifiedAt)) / 86_400_000) : null;
    // numeric 表示至少已有这么多条确认 no；若没有确认 no 但仍有 unknown，则不能假报 0。
    // summoned breakdown 保留完整三态，供体检 agent 判断待对账规模。
    const redUnsummoned = !routeGate.available
      ? null
      : routeGate.summoned.no > 0
        ? routeGate.summoned.no
        : routeGate.summoned.unknown > 0
          ? null
          : 0;
    return {
      generatedAt: new Date().toISOString(),
      routeGate: {
        available: routeGate.available,
        windowDays: routeGateDays,
        total: routeGate.total,
        red: routeGate.red,
        redUnsummoned,
        summoned: routeGate.summoned,
      },
      delta: { total: delta.total, byScore: delta.byScore, recent: delta.recent },
      handoffs: { total: handoffs.length, lastFire: lastFire?.name ?? null, daysSinceLastFire },
    };
  }

  /** 双地落漂移检查：跑仓库自带 sync-runtime.ps1（只检不改），解析对账行。 */
  async drift() {
    if (this.driftBusy) throw Object.assign(new Error("drift check already running"), { code: "RUNTIME_BUSY" });
    this.driftBusy = true;
    try {
      const script = join(this.repoRoot, "scripts", "sync-runtime.ps1");
      await stat(script);
      // Windows PowerShell 5.1 继承 pwsh7/其他父链的 PSModulePath 会指向 Core 模块目录，
      // Get-FileHash 等 Utility cmdlet 自动加载失败 → 脚本 exit 1、零输出。剥掉让 5.1 重建默认模块路径。
      const env = childProcessEnv();
      for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
      const { output, exitCode } = await new Promise((resolvePromise, rejectPromise) => {
        // spawnCommand：进子进程台账（drift 检查跑 90s，强杀主进程时不残留 powershell 树）
        const child = spawnCommand(
          "powershell",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
          { cwd: this.repoRoot, env, windowsHide: true },
        );
        // 锁语义（烛 R-P2 建议：防重叠）：settle 尽量等 close（进程真实退出）后发生——
        // 外层 finally 在 promise settle 后才解 driftBusy。超时先 kill 并置标记，
        // close 到达时按超时 reject（不把半截输出当成功）；close 迟迟不来则 5s 兜底 reject。
        let settled = false;
        let timedOut = false;
        const settle = (fn, value) => {
          if (settled) return;
          settled = true;
          fn(value);
        };
        const timeoutError = () => Object.assign(new Error("drift check timed out"), { code: "RUNTIME_BUSY" });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
          setTimeout(() => settle(rejectPromise, timeoutError()), 5_000);
        }, 90_000);
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("error", (error) => { clearTimeout(timer); settle(rejectPromise, error); });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (timedOut) settle(rejectPromise, timeoutError());
          else settle(resolvePromise, { output: stdout + stderr, exitCode: code });
        });
      });
      // 退出码三分（与 sync-runtime.ps1 契约对齐，烛 wave2 P0）：0=全一致 / 1=有漂移或缺失（正常业务
      // 结果，照常解析明细）/ 其余=脚本执行异常。此前把 exit 1 一律抛错，真有漂移时明细反而不可达。
      if (exitCode !== 0 && exitCode !== 1) {
        const detail = output.trim().split(/\r?\n/).find(Boolean) || "no output";
        throw Object.assign(new Error(`sync-runtime.ps1 exited ${exitCode}: ${detail.slice(0, 200)}`), { code: "DRIFT_SCRIPT_FAILED" });
      }
      const pairs = [];
      for (const line of output.split(/\r?\n/)) {
        const consistency = line.match(/^(\S[^=!]*?)\s*(=|!=)\s*(consistent|drift)\s*$/);
        if (consistency) {
          pairs.push({ name: consistency[1].trim(), status: consistency[3] === "consistent" ? "consistent" : "drift" });
          continue;
        }
        // 缺失行同样是对账结果（脚本把 missing 计入 $drift、exit 1）——名字可含冒号，非贪婪吃到标记词前
        const missing = line.match(/^(\S.*?)\s+(?:x source missing|! runtime missing)/);
        if (missing) pairs.push({ name: missing[1].trim(), status: "missing" });
      }
      // exit 0/1 都意味着脚本跑完了对账循环，必有逐对输出；0 对 = 输出被截/格式漂移，如实抛出
      if (!pairs.length) {
        throw Object.assign(new Error(`sync-runtime.ps1 exited ${exitCode} but produced no parseable pair lines`), { code: "DRIFT_SCRIPT_FAILED" });
      }
      return {
        checkedAt: new Date().toISOString(),
        pairs,
        drifted: pairs.filter((pair) => pair.status !== "consistent").length,
      };
    } finally {
      this.driftBusy = false;
    }
  }

  async #handoffFiles({ strict = false } = {}) {
    const root = join(this.aiSharedRoot, "handoff");
    let names;
    try {
      names = await readdir(root);
    } catch (error) {
      if (strict) throw Object.assign(new Error("handoff directory is unavailable"), { code: "OBSERVABILITY_HANDOFF_ROOT_UNAVAILABLE", cause: error });
      return [];
    }
    const files = [];
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      try {
        const info = await stat(join(root, name));
        if (info.isFile()) files.push({ name, path: join(root, name), size: info.size, mtimeMs: info.mtimeMs });
      } catch (error) {
        // 列表期间被移动/删除的文件直接跳过
        if (strict) throw Object.assign(new Error(`handoff ${name} is unavailable`), { code: "OBSERVABILITY_HANDOFF_UNAVAILABLE", cause: error });
      }
    }
    return files;
  }
}
