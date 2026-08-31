import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetStatus, createMonthlyBudgetService, monthWindow, summarizeMonthlySpend } from "../src/monthly-budget.mjs";

// 2026-08-30 12:00 本地时区
const NOW = new Date(2026, 7, 30, 12, 0, 0, 0).getTime();

test("monthWindow and summarizeMonthlySpend bound to the calendar month", () => {
  const window = monthWindow(NOW);
  assert.equal(window.month, "2026-08");
  const runs = [
    { id: "in1", costUsdTotal: 0.25, createdAt: new Date(NOW - 3600_000).toISOString() },
    { id: "in2", costUsdTotal: 1.5, createdAt: new Date(NOW - 7200_000).toISOString() },
    { id: "out", costUsdTotal: 99, createdAt: "2026-07-15T00:00:00.000Z" },
    { id: "nolimit", costUsdTotal: 0.5, createdAt: new Date(NOW - 60_000).toISOString() }, // "unlimited" 落盘形态 → costUsdTotal 为 null
    { id: "future", costUsdTotal: 5, createdAt: "2026-09-15T00:00:00.000Z" },
  ];
  runs[3].costUsdTotal = null;
  const spend = summarizeMonthlySpend(runs, NOW);
  assert.equal(spend.month, "2026-08");
  assert.equal(spend.spentUsd, 1.75);
  assert.equal(spend.knownRuns, 2);
});

test("budgetStatus thresholds: none / ok / warn / exceeded", () => {
  assert.equal(budgetStatus(null, 50).level, "none");
  assert.equal(budgetStatus(10, 5).level, "ok");
  assert.equal(budgetStatus(10, 8).level, "warn");
  assert.equal(budgetStatus(10, 8).percent, 80);
  assert.equal(budgetStatus(10, 12).level, "exceeded");
  assert.equal(budgetStatus(10, -3).percent, 0);
});

test("service persists budget, computes status, and clears on none", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "monthly-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const listRuns = () => [
    { id: "r1", status: "succeeded", costUsdTotal: 8.4, createdAt: new Date(NOW - 1000).toISOString() },
  ];
  const service = createMonthlyBudgetService({ dataRoot: root, listRuns, nowFn: () => NOW });

  const none = await service.status();
  assert.equal(none.level, "none");
  assert.equal(none.monthlyBudgetUsd, null);

  const warn = await service.setBudget({ monthlyBudgetUsd: 10 });
  assert.equal(warn.monthlyBudgetUsd, 10);
  assert.equal(warn.level, "warn");
  assert.equal(warn.percent, 84);

  const exceeded = await service.setBudget({ monthlyBudgetUsd: 5 });
  assert.equal(exceeded.level, "exceeded");

  const cleared = await service.setBudget({ monthlyBudgetUsd: "none" });
  assert.equal(cleared.level, "none");

  await assert.rejects(() => service.setBudget({ monthlyBudgetUsd: -1 }), { code: "VALIDATION_FAILED" });
});
