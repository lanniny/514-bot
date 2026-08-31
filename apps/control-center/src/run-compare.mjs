/**
 * W3.5 A/B shadow run 的对比面：两个 run 的元数据对比矩阵 + 可分享 Markdown 报告。
 * 文件级 worktree diff 仍归 src/run-diff.mjs（run vs HEAD）；这里做 run vs run。
 *
 * 消费方式：
 *   - shadow 入口（orchestrator.createShadowPair）返回两个 runId
 *   - GET /api/runs/compare?a=<id>&b=<id> → { schema, left, right, matrix, verdicts, markdown }
 */

const DURATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function runStatus(run) {
  return String(run?.status || "unknown").toLowerCase();
}

function runDurationMs(run) {
  const start = Date.parse(run?.createdAt || "");
  const end = Date.parse(run?.updatedAt || run?.completedAt || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function runAdapters(run) {
  const attempts = Array.isArray(run?.turnAttempts) ? run.turnAttempts : [];
  const ids = attempts.map((item) => String(item?.adapterId || item?.adapter || "")).filter(Boolean);
  return [...new Set(ids)];
}

function attemptsPhases(run) {
  const attempts = Array.isArray(run?.turnAttempts) ? run.turnAttempts : [];
  return attempts.map((item) => String(item?.phase || "?")).slice(0, 12);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "–";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

export function compareRuns(left, right) {
  if (!left?.id || !right?.id) {
    throw Object.assign(new Error("two persisted runs are required for comparison"), { code: "VALIDATION_FAILED" });
  }
  const pickCost = (run) => Number.isFinite(Number(run?.costUsdTotal)) ? Number(run.costUsdTotal) : null;
  const durationLeft = runDurationMs(left);
  const durationRight = runDurationMs(right);
  const costLeft = pickCost(left);
  const costRight = pickCost(right);
  const succeededLeft = ["succeeded", "complete", "completed"].includes(runStatus(left));
  const succeededRight = ["succeeded", "complete", "completed"].includes(runStatus(right));

  const matrix = [
    { field: "状态", left: runStatus(left), right: runStatus(right) },
    { field: "起始 agent", left: left?.startAgentId ?? "–", right: right?.startAgentId ?? "–" },
    { field: "编排模式", left: left?.orchestrationMode ?? "–", right: right?.orchestrationMode ?? "–" },
    { field: "耗时", left: formatDuration(durationLeft), right: formatDuration(durationRight) },
    { field: "累计成本 USD", left: costLeft ?? "–", right: costRight ?? "–" },
    { field: "轮次（attempts）", left: Array.isArray(left?.turnAttempts) ? left.turnAttempts.length : 0, right: Array.isArray(right?.turnAttempts) ? right.turnAttempts.length : 0 },
    { field: "adapter", left: runAdapters(left).join(", ") || "–", right: runAdapters(right).join(", ") || "–" },
    { field: "失败/错误", left: left?.error ? String(left.error).slice(0, 120) : "–", right: right?.error ? String(right.error).slice(0, 120) : "–" },
  ];

  const verdicts = [];
  if (succeededLeft !== succeededRight) {
    verdicts.push(succeededLeft ? "左（A）成功而右（B）未成功" : "右（B）成功而左（A）未成功");
  }
  if (costLeft != null && costRight != null && costLeft !== costRight) {
    verdicts.push(costLeft < costRight ? "左（A）成本更低" : "右（B）成本更低");
  }
  if (durationLeft != null && durationRight != null && durationLeft !== durationRight) {
    verdicts.push(durationLeft < durationRight ? "左（A）更快" : "右（B）更快");
  }
  if (!verdicts.length) verdicts.push("两轮在可见元数据上无显著差异");

  return {
    left: { id: left.id, status: runStatus(left), durationMs: durationLeft, costUsd: costLeft, adapters: runAdapters(left), attemptPhases: attemptsPhases(left) },
    right: { id: right.id, status: runStatus(right), durationMs: durationRight, costUsd: costRight, adapters: runAdapters(right), attemptPhases: attemptsPhases(right) },
    matrix,
    verdicts,
  };
}

export function renderCompareMarkdown({ generatedAt, comparison }) {
  const lines = [];
  lines.push("# Run 对比报告（A/B）");
  lines.push("");
  lines.push(`- 生成时间：${generatedAt}`);
  lines.push(`- A：\`${comparison.left.id}\`（${comparison.left.status}）`);
  lines.push(`- B：\`${comparison.right.id}\`（${comparison.right.status}）`);
  lines.push("");
  lines.push("| 维度 | A | B |");
  lines.push("|------|---|---|");
  for (const row of comparison.matrix) {
    lines.push(`| ${row.field} | ${String(row.left).replace(/\|/g, "\\|")} | ${String(row.right).replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  lines.push("## 结论");
  lines.push("");
  for (const verdict of comparison.verdicts) {
    lines.push(`- ${verdict}`);
  }
  lines.push("");
  lines.push(`> 对比基于 run 元数据快照；文件级改动请另见各 run 的 worktree diff（GET /api/runs/:id/diff）。窗口 ${Math.round(DURATION_WINDOW_MS / 86400000)} 天内有效。`);
  lines.push("");
  return lines.join("\n");
}
