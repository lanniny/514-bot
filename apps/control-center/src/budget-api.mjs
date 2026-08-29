#!/usr/bin/env node
/**
 * F-080 子 agent 预算/轮次/深度可视化 API。
 *
 * GET /api/runs/:id/budget
 * 返回当前 run 的预算消耗状态。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SESSIONS_FILE = join(import.meta.dirname, "..", ".ai-shared", "control-center", "sessions.jsonl");

async function getRunBudget(runId) {
  let content;
  try {
    content = await readFile(SESSIONS_FILE, "utf8");
  } catch {
    return null;
  }

  const lines = content.split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const session = JSON.parse(line);
      if (session.runId === runId || session.id === runId) {
        return {
          runId: session.runId || session.id,
          maxRounds: session.maxRounds || 6,
          currentRound: session.currentRound || 0,
          maxDepth: session.maxDepth || 2,
          currentDepth: session.currentDepth || 0,
          maxParallelAgents: session.maxParallelAgents || 4,
          activeAgents: session.activeAgents || [],
          pingPongLimit: session.pingPongLimit || 3,
          currentPingPong: session.currentPingPong || 0,
          budgetUsdPerTurn: session.budgetUsdPerTurn || 0.5,
          spentUsd: session.spentUsd || 0,
          status: session.status || "running",
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

// 简易 HTTP server 用于测试
if (process.argv[1] && process.argv[1].includes("budget-api")) {
  import("node:http").then(({ createServer }) => {
    const server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url.startsWith("/api/runs/")) {
        const runId = req.url.split("/")[3];
        const budget = await getRunBudget(runId);
        
        res.setHeader("Content-Type", "application/json");
        if (budget) {
          res.writeHead(200);
          res.end(JSON.stringify(budget, null, 2));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Run not found" }));
        }
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
      }
    });

    server.listen(3456, () => {
      console.log("F-080 Budget API listening on http://localhost:3456");
      console.log("Test: curl http://localhost:3456/api/runs/test-run-id");
    });
  });
}

export { getRunBudget };
