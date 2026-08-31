/**
 * W3.18 周报生成器：从 .ai-shared 的 handoff / DELTA 账本聚合近 7 天工作面摘要，
 * 出可分享 Markdown 报告（进 W1.3 artifact 出卡体系预览）。
 *
 * 数据源（全部只读、有界）：
 *   - .ai-shared/handoff/*.md（不含 archive/，按 mtime 近 7 天）
 *   - .ai-shared/decisions.md 中的 __DELTA__: 行（总数 + 最近条目）
 *   - 可选 listRuns()（控制面 orchestrator.list）：近 7 天 run 终态统计
 * 报告是快照投影，不写任何文件；LO 拿去发人即可。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HANDOFF_LIST_LIMIT = 40;
const DELTA_RECENT_LIMIT = 8;
const REPORT_RUNS_LIMIT = 200;

function parseDeltaEntries(content) {
  const entries = [];
  for (const line of String(content ?? "").split(/\r?\n/)) {
    const match = /^\s*__DELTA__:\s*(.+)$/.exec(line);
    if (match) entries.push(match[1].trim());
  }
  return entries;
}

export function renderWeeklyMarkdown({ generatedAt, windowDays = 7, handoffs, deltaTotal, deltaRecent, runs }) {
  const lines = [];
  lines.push(`# 514cc 周报（近 ${windowDays} 天）`);
  lines.push("");
  lines.push(`- 生成时间：${generatedAt}`);
  lines.push(`- handoff 产物：${handoffs.count} 份`);
  lines.push(`- DELTA 账本：累计 ${deltaTotal} 条`);
  if (runs) {
    lines.push(`- Run 终态：完成 ${runs.succeeded} · 失败 ${runs.failed} · 取消 ${runs.cancelled} · 活跃 ${runs.active}`);
  }
  lines.push("");
  lines.push("## 最近 handoff");
  lines.push("");
  if (handoffs.recent.length) {
    for (const file of handoffs.recent) {
      lines.push(`- \`${file.name}\`（${file.modifiedAt.slice(0, 10)}）`);
    }
  } else {
    lines.push("- （近 7 天无新 handoff）");
  }
  lines.push("");
  lines.push("## 最近 DELTA");
  lines.push("");
  if (deltaRecent.length) {
    for (const entry of deltaRecent) {
      lines.push(`- ${entry}`);
    }
  } else {
    lines.push("- （无 DELTA 记录）");
  }
  lines.push("");
  return lines.join("\n");
}

export function createWeeklyReportService({ aiSharedRoot, listRuns = null, nowFn = Date.now } = {}) {
  if (!aiSharedRoot) throw new TypeError("weekly report service needs aiSharedRoot");

  async function collect() {
    const now = nowFn();
    const cutoff = now - WEEK_MS;

    const handoffDir = join(aiSharedRoot, "handoff");
    let files = [];
    try {
      const names = await readdir(handoffDir);
      const candidates = names.filter((name) => name.endsWith(".md"));
      const bounded = candidates.slice(0, HANDOFF_LIST_LIMIT * 3);
      const withTimes = await Promise.all(bounded.map(async (name) => {
        try {
          const info = await stat(join(handoffDir, name));
          return { name, modifiedAt: info.mtime.toISOString(), mtimeMs: info.mtimeMs };
        } catch {
          return null;
        }
      }));
      files = withTimes
        .filter(Boolean)
        .filter((file) => file.mtimeMs >= cutoff)
        .sort((left, right) => right.mtimeMs - left.mtimeMs)
        .slice(0, HANDOFF_LIST_LIMIT);
    } catch {
      files = [];
    }

    let deltaTotal = 0;
    let deltaRecent = [];
    try {
      const decisions = await readFile(join(aiSharedRoot, "decisions.md"), "utf8");
      const entries = parseDeltaEntries(decisions);
      deltaTotal = entries.length;
      deltaRecent = entries.slice(-DELTA_RECENT_LIMIT).reverse();
    } catch {
      // decisions.md 缺失时如实留空，不伪造账本
    }

    let runs = null;
    if (typeof listRuns === "function") {
      try {
        const all = (listRuns() || []).slice(0, REPORT_RUNS_LIMIT);
        const inWindow = all.filter((run) => {
          const created = Date.parse(run.createdAt || "") || 0;
          return created >= cutoff;
        });
        const statusOf = (run) => String(run.status || "").toLowerCase();
        runs = {
          succeeded: inWindow.filter((run) => ["succeeded", "complete", "completed"].includes(statusOf(run))).length,
          failed: inWindow.filter((run) => statusOf(run) === "failed").length,
          cancelled: inWindow.filter((run) => statusOf(run) === "cancelled").length,
          active: inWindow.filter((run) => !["succeeded", "complete", "completed", "failed", "cancelled"].includes(statusOf(run))).length,
        };
      } catch {
        runs = null;
      }
    }

    return { handoffs: { count: files.length, recent: files }, deltaTotal, deltaRecent, runs };
  }

  async function report() {
    const data = await collect();
    const generatedAt = new Date(nowFn()).toISOString();
    const markdown = renderWeeklyMarkdown({ generatedAt, ...data });
    return { schema: "514cc.weekly-report/v1", generatedAt, windowDays: 7, ...data, markdown };
  }

  return Object.freeze({ report });
}
