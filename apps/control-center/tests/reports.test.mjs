import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDiffMarkdown } from "../src/run-diff.mjs";
import { compareRuns, renderCompareMarkdown } from "../src/run-compare.mjs";
import { createWeeklyReportService, renderWeeklyMarkdown } from "../src/weekly-report.mjs";

test("compareRuns builds an honest metadata matrix and verdicts", () => {
  const left = {
    id: "run-a",
    status: "succeeded",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:01:00.000Z",
    costUsdTotal: 0.2,
    startAgentId: "claude-fable",
    orchestrationMode: "pipeline",
    turnAttempts: [{ phase: "completed", adapterId: "claude-cli" }],
  };
  const right = {
    id: "run-b",
    status: "failed",
    error: "provider blew up",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:03:00.000Z",
    costUsdTotal: 0.5,
    startAgentId: "codex-technical",
    orchestrationMode: "pipeline",
    turnAttempts: [{ phase: "failed", adapterId: "codex-cli" }],
  };
  const comparison = compareRuns(left, right);
  assert.equal(comparison.left.costUsd, 0.2);
  assert.equal(comparison.right.durationMs, 180_000);
  assert.ok(comparison.verdicts.some((v) => v.includes("成功")));
  assert.ok(comparison.verdicts.some((v) => v.includes("成本更低")));
  assert.ok(comparison.verdicts.some((v) => v.includes("更快")));
  const markdown = renderCompareMarkdown({ generatedAt: "2026-08-30T01:00:00.000Z", comparison });
  assert.match(markdown, /# Run 对比报告（A\/B）/);
  assert.match(markdown, /\| 状态 \| succeeded \| failed \|/);
  assert.match(markdown, /## 结论/);
  assert.throws(() => compareRuns({ id: "only-one" }, {}), { code: "VALIDATION_FAILED" });
});

test("renderDiffMarkdown projects run-diff output into a shareable report", () => {
  const markdown = renderDiffMarkdown({
    runId: "run-abc",
    worktree: "514cc-wt-01",
    base: "514cc",
    status: " M src/x.mjs",
    stat: " src/x.mjs | 2 +-",
    diff: "diff --git a/src/x.mjs b/src/x.mjs\n--- a/src/x.mjs\n+++ b/src/x.mjs",
    truncated: false,
  }, { generatedAt: "2026-08-30T01:00:00.000Z" });
  assert.match(markdown, /# Run 产物对比报告/);
  assert.match(markdown, /`run-abc`/);
  assert.match(markdown, /```diff/);
});

test("weekly report aggregates handoffs, DELTA and run stats with honest empty states", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weekly-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "handoff"), { recursive: true });
  await writeFile(join(root, "handoff", "fresh.md"), "# fresh", "utf8");
  const recentMs = Date.now() - 1000;
  await utimes(join(root, "handoff", "fresh.md"), recentMs / 1000, recentMs / 1000);
  await writeFile(join(root, "handoff", "stale.md"), "# stale", "utf8");
  const staleMs = Date.now() - 30 * 86_400_000;
  await utimes(join(root, "handoff", "stale.md"), staleMs / 1000, staleMs / 1000);
  await writeFile(join(root, "decisions.md"), [
    "# 决策",
    "__DELTA__: 烛(Codex) | 1 | 证据：a.mjs:1",
    "__DELTA__: 织 | 0 | 白发",
  ].join("\n"), "utf8");

  const listRuns = () => [
    { id: "r1", status: "succeeded", createdAt: new Date(Date.now() - 3600_000).toISOString() },
    { id: "r2", status: "failed", createdAt: new Date(Date.now() - 7200_000).toISOString() },
    { id: "r3", status: "running", createdAt: new Date(Date.now() - 60_000).toISOString() },
    { id: "r4", status: "succeeded", createdAt: "2020-01-01T00:00:00.000Z" },
  ];
  const service = createWeeklyReportService({ aiSharedRoot: root, listRuns });
  const report = await service.report();
  assert.equal(report.handoffs.count, 1, "only in-window handoffs count");
  assert.equal(report.handoffs.recent[0].name, "fresh.md");
  assert.equal(report.deltaTotal, 2);
  assert.equal(report.deltaRecent[0], "织 | 0 | 白发");
  assert.deepEqual(
    { succeeded: report.runs.succeeded, failed: report.runs.failed, active: report.runs.active },
    { succeeded: 1, failed: 1, active: 1 },
    "run stats exclude out-of-window entries",
  );
  assert.match(report.markdown, /# 514cc 周报（近 7 天）/);
  assert.match(report.markdown, /`fresh\.md`/);
  assert.match(report.markdown, /烛\(Codex\) \| 1 \| 证据：a\.mjs:1/);
});

test("weekly report fails soft when data sources are missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weekly-report-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createWeeklyReportService({ aiSharedRoot: root, listRuns: () => { throw new Error("no orchestrator"); } });
  const report = await service.report();
  assert.equal(report.handoffs.count, 0);
  assert.equal(report.deltaTotal, 0);
  assert.equal(report.runs, null);
  assert.match(renderWeeklyMarkdown({ generatedAt: "2026-08-30T00:00:00.000Z", ...report }), /（近 7 天无新 handoff）/);
});
