/**
 * W3.1 成本观测中心补缺：月度预算与告警状态。
 * 成本报表面已有（overview-usage 按 provider/model 聚合 + ccswitch proxy usage 趋势 +
 * ops-metrics 单 run 成本），唯一真缺口是"月度预算告警"。本模块：
 *   - dataRoot/monthly-budget.json 持久化 { monthlyBudgetUsd }
 *   - spent 由 listRuns() 注入聚合（本自然月、costUsdTotal 可知部分）
 *   - status: ok(<80%) | warn(≥80%) | exceeded(≥100%) | none(未设预算)
 * 只读聚合 + 一个可写字段；不阻塞任何 run（告警是观测面，不是闸门）。
 */

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const BUDGET_FILE = "monthly-budget.json";

export function monthWindow(nowMs = Date.now()) {
  const date = new Date(nowMs);
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  return { startMs: start.getTime(), endMs: end.getTime(), month: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}` };
}

export function summarizeMonthlySpend(runs, nowMs = Date.now()) {
  const window = monthWindow(nowMs);
  let spentUsd = 0;
  let knownRuns = 0;
  for (const run of Array.isArray(runs) ? runs : []) {
    const created = Date.parse(run?.createdAt || "");
    if (!Number.isFinite(created) || created < window.startMs || created >= window.endMs) continue;
    if (run?.costUsdTotal == null) continue; // costUsdTotal:null = 无限预算/未知成本，不算"可知"
    const cost = Number(run.costUsdTotal);
    if (Number.isFinite(cost) && cost >= 0) {
      spentUsd += cost;
      knownRuns += 1;
    }
  }
  return { month: window.month, spentUsd: Math.round(spentUsd * 10000) / 10000, knownRuns };
}

export function budgetStatus(budgetUsd, spentUsd) {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return { level: "none", percent: null };
  const percent = Math.round((Math.max(0, spentUsd) / budgetUsd) * 100);
  const level = percent >= 100 ? "exceeded" : percent >= 80 ? "warn" : "ok";
  return { level, percent };
}

export function createMonthlyBudgetService({ dataRoot, listRuns = null, nowFn = Date.now } = {}) {
  if (!dataRoot) throw new TypeError("monthly budget service needs dataRoot");
  const budgetPath = join(dataRoot, BUDGET_FILE);

  async function readBudget() {
    try {
      const parsed = JSON.parse(await readFile(budgetPath, "utf8"));
      const value = Number(parsed?.monthlyBudgetUsd);
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  async function status() {
    const [budgetUsd, runs] = await Promise.all([
      readBudget(),
      (async () => {
        if (typeof listRuns !== "function") return [];
        try {
          return listRuns() ?? [];
        } catch {
          return [];
        }
      })(),
    ]);
    const spend = summarizeMonthlySpend(runs, nowFn());
    const state = budgetStatus(budgetUsd, spend.spentUsd);
    return {
      schema: "514cc.monthly-budget/v1",
      month: spend.month,
      monthlyBudgetUsd: budgetUsd,
      spentUsd: spend.spentUsd,
      knownRuns: spend.knownRuns,
      level: state.level,
      percent: state.percent,
      note: budgetUsd == null ? "未设月度预算——只观测不告警" : "告警是观测信号，不阻塞 run",
    };
  }

  async function setBudget(input) {
    const raw = input?.monthlyBudgetUsd;
    if (raw === null || raw === undefined || raw === "" || String(raw).trim().toLowerCase() === "none") {
      await mkdir(dirname(budgetPath), { recursive: true });
      const tempPath = `${budgetPath}.${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(tempPath, JSON.stringify({ monthlyBudgetUsd: null }), "utf8");
      await rename(tempPath, budgetPath);
      return status();
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw Object.assign(new Error("monthlyBudgetUsd must be a positive number or null/none"), { code: "VALIDATION_FAILED" });
    }
    await mkdir(dirname(budgetPath), { recursive: true });
    const tempPath = `${budgetPath}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tempPath, JSON.stringify({ monthlyBudgetUsd: Math.round(value * 100) / 100 }), "utf8");
    await rename(tempPath, budgetPath);
    return status();
  }

  return Object.freeze({ status, setBudget });
}
