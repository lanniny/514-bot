#!/usr/bin/env node
/**
 * F-074 context.md 自动摘要（治理收口 W3）。
 *
 * 从 decisions.md + handoff/ 提取关键信息，生成结构化摘要，
 * 解决「context.md 手工维护会过期」的根因。
 *
 * 用法：
 *   node scripts/context-summary.mjs              # 输出 Markdown 摘要到 stdout
 *   node scripts/context-summary.mjs --json        # 输出 JSON 结构化数据
 *   node scripts/context-summary.mjs --days 14     # 只覆盖最近 N 天（默认 30）
 *
 * 设计原则：
 *   - 只读操作，不修改任何文件
 *   - 幂等：相同输入产生相同输出
 *   - 不依赖外部 npm 包
 */

import { readFile, readdir } from "node:fs/promises";
import { resolve, basename } from "node:path";

const SHARED_DIR = resolve(import.meta.dirname, "..", ".ai-shared");
const DECISIONS_PATH = resolve(SHARED_DIR, "decisions.md");
const HANDOFF_DIR = resolve(SHARED_DIR, "handoff");
const CONTEXT_PATH = resolve(SHARED_DIR, "context.md");

// ─── decisions.md 解析 ──────────────────────────────────────────────────────

async function parseDecisions() {
  let text;
  try {
    text = await readFile(DECISIONS_PATH, "utf8");
  } catch {
    return { decisions: [], deltaEntries: [], lastUpdated: null };
  }

  const decisions = [];
  const deltaEntries = [];

  // 提取 D-YYYY-MM-DD-NNN 格式的决策 ID
  const decisionPattern = /^#{1,4}\s+.*?(D-\d{4}-\d{2}-\d{2}-\d{3})/gm;
  let match;
  while ((match = decisionPattern.exec(text)) !== null) {
    decisions.push({ id: match[1], line: text.slice(0, match.index).split("\n").length });
  }

  // 提取 __DELTA__ 条目
  const deltaPattern = /__DELTA__:\s*(.+)/g;
  while ((match = deltaPattern.exec(text)) !== null) {
    deltaEntries.push(match[1].trim());
  }

  // 最后更新日期
  const datePattern = /(\d{4}-\d{2}-\d{2})/;
  const dateMatch = text.match(datePattern);

  return {
    decisions,
    deltaEntries,
    lastUpdated: dateMatch?.[1] ?? null,
    totalLines: text.split("\n").length,
  };
}

// ─── handoff/ 解析 ──────────────────────────────────────────────────────────

async function parseHandoffs(daysBack = 30) {
  let files;
  try {
    files = await readdir(HANDOFF_DIR);
  } catch {
    return { recent: [], byAgent: {}, total: 0 };
  }

  const cutoff = Date.now() - daysBack * 86_400_000;
  const handoffFiles = files.filter((f) => f.endsWith(".md"));
  const recent = [];
  const byAgent = {};

  for (const file of handoffFiles) {
    // 从文件名提取日期：...__YYYYMMDD-HHMM.md
    const dateMatch = file.match(/__(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.md$/);
    if (!dateMatch) continue;

    const [, year, month, day, hour, minute] = dateMatch;
    const fileDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:00`);

    // 从文件名提取 agent 路径：{from}-to-{to}__...
    const agentMatch = file.match(/^([^-]+)-to-([^-]+)__/) ?? file.match(/^([^-]+)__/);
    const fromAgent = agentMatch?.[1] ?? "unknown";
    const toAgent = agentMatch?.[2] ?? "all";

    // 统计
    const agentKey = fromAgent;
    byAgent[agentKey] = (byAgent[agentKey] ?? 0) + 1;

    if (fileDate.getTime() >= cutoff) {
      recent.push({
        file,
        date: fileDate.toISOString(),
        from: fromAgent,
        to: toAgent,
        topic: extractTopic(file),
      });
    }
  }

  recent.sort((a, b) => b.date.localeCompare(a.date));

  return {
    recent,
    byAgent,
    total: handoffFiles.length,
  };
}

function extractTopic(filename) {
  // 从文件名提取主题部分：去掉前缀（xxx-to-yyy__）和后缀（__YYYYMMDD-HHMM.md）
  const withoutDate = filename.replace(/__\d{8}-\d{4}\.md$/, "");
  const topicPart = withoutDate.replace(/^[^-]+-to-[^-]+__/, "").replace(/^[^-]+__/, "");
  return topicPart.replace(/-/g, " ");
}

// ─── context.md 元信息 ──────────────────────────────────────────────────────

async function getContextMeta() {
  let text;
  try {
    text = await readFile(CONTEXT_PATH, "utf8");
  } catch {
    return { exists: false, lines: 0, lastUpdated: null };
  }

  const dateMatch = text.match(/最后更新[：:]\s*(\d{4}-\d{2}-\d{2})/);
  return {
    exists: true,
    lines: text.split("\n").length,
    lastUpdated: dateMatch?.[1] ?? null,
  };
}

// ─── 主逻辑 ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const daysIdx = args.indexOf("--days");
  const daysBack = daysIdx >= 0 ? Number(args[daysIdx + 1]) || 30 : 30;

  const [decisions, handoffs, contextMeta] = await Promise.all([
    parseDecisions(),
    parseHandoffs(daysBack),
    getContextMeta(),
  ]);

  if (jsonMode) {
    console.log(JSON.stringify({ decisions, handoffs, contextMeta, generatedAt: new Date().toISOString() }, null, 2));
    return;
  }

  // Markdown 输出
  console.log(`# context.md 自动摘要`);
  console.log(`> 生成时间：${new Date().toISOString()}`);
  console.log(`> 覆盖窗口：最近 ${daysBack} 天`);
  console.log();

  // context.md 状态
  console.log(`## context.md 状态`);
  if (contextMeta.exists) {
    console.log(`- 存在：是（${contextMeta.lines} 行）`);
    console.log(`- 最后更新标记：${contextMeta.lastUpdated ?? "未找到"}`);
    const daysSinceUpdate = contextMeta.lastUpdated
      ? Math.floor((Date.now() - Date.parse(contextMeta.lastUpdated)) / 86_400_000)
      : null;
    if (daysSinceUpdate !== null) {
      console.log(`- 距今：${daysSinceUpdate} 天${daysSinceUpdate > 7 ? " ⚠️ 可能需要更新" : " ✓"}`);
    }
  } else {
    console.log(`- ❌ context.md 不存在`);
  }
  console.log();

  // decisions.md 摘要
  console.log(`## decisions.md 摘要`);
  console.log(`- 总行数：${decisions.totalLines}`);
  console.log(`- 决策条目（D-YYYY-MM-DD-NNN）：${decisions.decisions.length}`);
  console.log(`- DELTA 账本条目：${decisions.deltaEntries.length}`);
  console.log(`- 最后日期标记：${decisions.lastUpdated ?? "未找到"}`);
  if (decisions.deltaEntries.length > 0) {
    console.log(`- 最近 5 条 DELTA：`);
    for (const d of decisions.deltaEntries.slice(-5)) {
      console.log(`  - ${d}`);
    }
  }
  console.log();

  // handoff 摘要
  console.log(`## handoff 活动（最近 ${daysBack} 天）`);
  console.log(`- 总文件数：${handoffs.total}`);
  console.log(`- 窗口内文件数：${handoffs.recent.length}`);
  if (Object.keys(handoffs.byAgent).length > 0) {
    console.log(`- 按来源 agent：`);
    for (const [agent, count] of Object.entries(handoffs.byAgent).sort((a, b) => b[1] - a[1])) {
      console.log(`  - ${agent}：${count} 份`);
    }
  }
  if (handoffs.recent.length > 0) {
    console.log(`- 最近 10 份：`);
    for (const h of handoffs.recent.slice(0, 10)) {
      console.log(`  - [${h.date.slice(0, 10)}] ${h.from} → ${h.to}：${h.topic}`);
    }
  }
  console.log();

  // 健康判断
  console.log(`## 健康判断`);
  if (contextMeta.lastUpdated) {
    const daysSince = Math.floor((Date.now() - Date.parse(contextMeta.lastUpdated)) / 86_400_000);
    if (daysSince > 14) {
      console.log(`⚠️ context.md 已超过 ${daysSince} 天未更新，建议根据上述摘要刷新。`);
    } else {
      console.log(`✓ context.md 在 ${daysSince} 天前更新过，尚在保鲜期内。`);
    }
  }
  if (handoffs.recent.length > 0 && contextMeta.lastUpdated) {
    const latestHandoff = handoffs.recent[0].date.slice(0, 10);
    const contextDate = contextMeta.lastUpdated;
    if (latestHandoff > contextDate) {
      console.log(`⚠️ 有比 context.md 更新的 handoff（${latestHandoff} > ${contextDate}），context.md 可能遗漏了近期工作。`);
    }
  }
}

main();
