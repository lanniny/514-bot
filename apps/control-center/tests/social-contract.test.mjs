import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  classifyAgentRoute,
  projectSocialContract,
  resolveComposerOrchestration,
  resolveOrchestrationMode,
} from "../src/social-contract.mjs";

test("social is opt-in; unknown modes fail closed", () => {
  assert.equal(resolveOrchestrationMode({}), "pipeline");
  assert.equal(resolveOrchestrationMode({ orchestrationMode: "pipeline" }), "pipeline");
  assert.equal(resolveOrchestrationMode({ orchestrationMode: "social" }), "social");
  assert.throws(() => resolveOrchestrationMode({ orchestrationMode: "autonomous" }), { code: "VALIDATION_FAILED" });
  assert.deepEqual(resolveComposerOrchestration("普通任务"), { mode: "pipeline", prompt: "普通任务" });
  assert.deepEqual(resolveComposerOrchestration("/social 互评一下"), { mode: "social", prompt: "互评一下" });
  assert.deepEqual(resolveComposerOrchestration("/pipeline 走旧拓扑"), { mode: "pipeline", prompt: "走旧拓扑" });
});

test("social contract requires recipient, budget, depth and loop caps", () => {
  const contract = projectSocialContract({
    orchestrationMode: "social",
    maxRounds: 6,
    delegationDepthLimit: 3,
    maxBudgetUsdPerTurn: 0.5,
  });
  assert.equal(contract.optedIn, true);
  assert.equal(contract.pingPongLimit, 2);
  assert.throws(() => classifyAgentRoute({ to: "", contract }), { code: "SOCIAL_RECIPIENT_REQUIRED" });
  assert.throws(() => classifyAgentRoute({ to: "codex-technical", hops: 1, depth: 1, contract: { optedIn: false } }), {
    code: "SOCIAL_OPT_IN_REQUIRED",
  });
  assert.equal(classifyAgentRoute({ to: "codex-technical", hops: 2, depth: 1, contract }).disposition, "queued");
  assert.equal(classifyAgentRoute({ to: "codex-technical", hops: 3, depth: 1, contract }).reason, "PING_PONG_LIMIT");
  assert.equal(classifyAgentRoute({ to: "codex-technical", hops: 1, depth: 4, contract }).reason, "DELEGATION_DEPTH_LIMIT");
  assert.equal(projectSocialContract({ orchestrationMode: "pipeline" }).optedIn, false);
});

test("composer submit sends social only after /social", async () => {
  const app = await readFile(resolve(import.meta.dirname, "../public/app.js"), "utf8");
  assert.match(app, /const socialOptIn = pickMode === "social" \|\| \/\^\\\/social/);
  assert.match(app, /const botSocialOptIn = botSubmissionCandidate\?\.orchestrationMode === "social"/);
  assert.match(app, /orchestrationMode: socialMode \? "social" : "pipeline"/);
  assert.match(app, /includeRequestedAgents: !legacy/);
});

test("social contract rejects an unlimited per-turn budget with a dedicated code", () => {
  assert.throws(
    () => projectSocialContract({
      orchestrationMode: "social",
      maxRounds: 4,
      delegationDepthLimit: 2,
      maxBudgetUsdPerTurn: Number.POSITIVE_INFINITY,
    }),
    { code: "SOCIAL_UNLIMITED_BUDGET_REJECTED" },
  );
  // 有限预算路径不受影响
  const contract = projectSocialContract({
    orchestrationMode: "social",
    maxRounds: 4,
    delegationDepthLimit: 2,
    maxBudgetUsdPerTurn: 1.5,
  });
  assert.equal(contract.maxBudgetUsdPerTurn, 1.5);
});
