#!/usr/bin/env node
/**
 * F-077 roster.json 健康检查（治理收口 W3）。
 *
 * 检查项：
 *   1. 结构完整性 — 必要字段存在且类型正确
 *   2. threadId 有效性 — lastThreadId 格式校验（UUID v4）
 *   3. 陈旧检测 — lastRunAt 距今超过 N 天视为 stale
 *   4. transport 合法性 — 只允许已知 transport 类型
 *   5. 孤儿检测 — 有 lastRunAt 但无 lastThreadId 的异常记录
 *
 * 退出码：
 *   0 = 健康
 *   1 = 有警告（stale / 孤儿）
 *   2 = 有错误（结构损坏 / 无效字段）
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROSTER_PATH = resolve(import.meta.dirname, "..", ".ai-shared", "roster.json");
const KNOWN_TRANSPORTS = new Set(["mcp", "exec", "api", "cli"]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_STALE_DAYS = 30;

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const parsed = Date.parse(dateStr);
  if (!Number.isFinite(parsed)) return Infinity;
  return (Date.now() - parsed) / 86_400_000;
}

function checkStructure(roster) {
  const errors = [];
  if (!roster || typeof roster !== "object") {
    errors.push("roster.json root is not an object");
    return errors;
  }
  if (typeof roster.updated !== "string") {
    errors.push("missing or invalid 'updated' field");
  }
  if (!roster.agents || typeof roster.agents !== "object" || Array.isArray(roster.agents)) {
    errors.push("missing or invalid 'agents' field (must be an object)");
  }
  return errors;
}

function checkAgent(agentId, agent, staleDays) {
  const errors = [];
  const warnings = [];

  if (!agent || typeof agent !== "object") {
    errors.push(`${agentId}: agent record is not an object`);
    return { errors, warnings };
  }

  // 必要字段
  if (typeof agent.name !== "string" || !agent.name) {
    errors.push(`${agentId}: missing 'name'`);
  }
  if (typeof agent.role !== "string" || !agent.role) {
    errors.push(`${agentId}: missing 'role'`);
  }
  if (typeof agent.transport !== "string") {
    errors.push(`${agentId}: missing 'transport'`);
  } else if (!KNOWN_TRANSPORTS.has(agent.transport)) {
    warnings.push(`${agentId}: unknown transport '${agent.transport}' (known: ${[...KNOWN_TRANSPORTS].join(", ")})`);
  }

  // threadId 有效性
  if (agent.lastThreadId !== null && agent.lastThreadId !== undefined) {
    if (typeof agent.lastThreadId === "string" && agent.lastThreadId && !UUID_V4.test(agent.lastThreadId)) {
      errors.push(`${agentId}: lastThreadId '${agent.lastThreadId}' is not a valid UUID`);
    }
  }

  // 陈旧检测
  const stale = daysSince(agent.lastRunAt);
  if (stale > staleDays && agent.lastRunAt) {
    warnings.push(`${agentId}: lastRunAt '${agent.lastRunAt}' is ${Math.floor(stale)} days ago (>${staleDays}d)`);
  }

  // 孤儿检测：有 lastRunAt 但无 lastThreadId
  if (agent.lastRunAt && !agent.lastThreadId) {
    warnings.push(`${agentId}: has lastRunAt but no lastThreadId (orphan activity)`);
  }

  // 完全未活动
  if (!agent.lastRunAt && !agent.lastThreadId) {
    warnings.push(`${agentId}: never active (no lastRunAt, no lastThreadId)`);
  }

  return { errors, warnings };
}

async function main() {
  const staleDays = Number(process.argv[2]) || DEFAULT_STALE_DAYS;
  let text;
  try {
    text = await readFile(ROSTER_PATH, "utf8");
  } catch (error) {
    console.error(`Cannot read roster.json: ${error.message}`);
    process.exit(2);
  }

  let roster;
  try {
    roster = JSON.parse(text);
  } catch {
    console.error("roster.json is not valid JSON");
    process.exit(2);
  }

  const structErrors = checkStructure(roster);
  if (structErrors.length > 0) {
    for (const e of structErrors) console.error(`ERROR: ${e}`);
    process.exit(2);
  }

  const allErrors = [];
  const allWarnings = [];
  const agentIds = Object.keys(roster.agents);

  for (const agentId of agentIds) {
    const { errors, warnings } = checkAgent(agentId, roster.agents[agentId], staleDays);
    allErrors.push(...errors);
    allWarnings.push(...warnings);
  }

  // 输出摘要
  console.log(`roster.json health check (stale threshold: ${staleDays}d)`);
  console.log(`agents: ${agentIds.length}`);
  console.log(`last updated: ${roster.updated}`);
  console.log();

  if (allErrors.length > 0) {
    console.log(`ERRORS (${allErrors.length}):`);
    for (const e of allErrors) console.log(`  ✗ ${e}`);
    console.log();
  }

  if (allWarnings.length > 0) {
    console.log(`WARNINGS (${allWarnings.length}):`);
    for (const w of allWarnings) console.log(`  ⚠ ${w}`);
    console.log();
  }

  if (allErrors.length === 0 && allWarnings.length === 0) {
    console.log("✓ roster.json is healthy");
  }

  // 退出码
  if (allErrors.length > 0) process.exit(2);
  if (allWarnings.length > 0) process.exit(1);
  process.exit(0);
}

main();
