/**
 * W3.10 worktree 台账：dataRoot 下 append-only JSONL（worktrees.jsonl）。
 * 每次建树/清树打点，list() 折叠出当前活跃视图；孤儿判定交给读方
 * （removedAt=null 且 run 已清除 = 清理时打点失败的候选，自行核对磁盘）。
 *
 * 行形态：
 *   { kind:"created", path, base, runId, source, createdAt }
 *   { kind:"removed", path, removedAt }
 * 追加写 + 原子不要求（JSONL 尾行损坏读方容错跳过）。
 */

import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";

const LEDGER_FILE = "worktrees.jsonl";
const LIST_LIMIT = 200;

async function readEntries(path) {
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean) continue;
    try {
      entries.push(JSON.parse(clean));
    } catch {
      // 尾行损坏/半写：跳过，不拖垮整个台账
    }
  }
  return entries;
}

export function createWorktreeLedger({ dataRoot, nowFn = Date.now } = {}) {
  if (!dataRoot) throw new TypeError("worktree ledger needs dataRoot");
  const ledgerPath = join(dataRoot, LEDGER_FILE);

  async function append(entry) {
    await mkdir(dirname(ledgerPath), { recursive: true });
    await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async function recordCreated({ path, base, runId = null, source = "run" }) {
    if (!path) throw Object.assign(new Error("worktree path is required"), { code: "VALIDATION_FAILED" });
    await append({
      kind: "created",
      path: String(path),
      base: base ? String(base) : null,
      runId: runId ? String(runId) : null,
      source: String(source),
      createdAt: new Date(nowFn()).toISOString(),
    });
  }

  async function recordRemoved({ path }) {
    if (!path) throw Object.assign(new Error("worktree path is required"), { code: "VALIDATION_FAILED" });
    await append({
      kind: "removed",
      path: String(path),
      removedAt: new Date(nowFn()).toISOString(),
    });
  }

  /** 折叠视图：每个 path 的最新状态；removedAt=null = 活跃。 */
  async function list({ limit = LIST_LIMIT } = {}) {
    const entries = await readEntries(ledgerPath);
    const byPath = new Map();
    for (const entry of entries) {
      if (!entry?.path) continue;
      const current = byPath.get(entry.path) ?? { path: entry.path, base: null, runId: null, source: null, createdAt: null, removedAt: null };
      if (entry.kind === "created") {
        current.base = entry.base ?? current.base;
        current.runId = entry.runId ?? current.runId;
        current.source = entry.source ?? current.source;
        current.createdAt = entry.createdAt ?? current.createdAt;
      } else if (entry.kind === "removed") {
        current.removedAt = entry.removedAt ?? current.removedAt;
      }
      byPath.set(entry.path, current);
    }
    const items = [...byPath.values()]
      .sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")))
      .slice(0, Math.max(1, Math.min(limit, LIST_LIMIT * 5)));
    return {
      schema: "514cc.worktree-ledger/v1",
      total: byPath.size,
      activeCount: items.filter((item) => !item.removedAt).length,
      worktrees: items,
    };
  }

  return Object.freeze({ recordCreated, recordRemoved, list, path: ledgerPath });
}
