export const DEFAULT_ORCHESTRATION_MODE = "pipeline";
export const SOCIAL_ORCHESTRATION_MODE = "social";
export const SOCIAL_PING_PONG_LIMIT = 2;
export const SOCIAL_BROADCAST_TARGETS = new Set(["team", "lo", "memo", "system", "all"]);

function fail(message, code = "VALIDATION_FAILED", extras = {}) {
  throw Object.assign(new Error(message), { code, ...extras });
}

export function resolveOrchestrationMode(input = {}) {
  const raw = String(input?.orchestrationMode ?? "").trim().toLowerCase();
  if (!raw || raw === DEFAULT_ORCHESTRATION_MODE) return DEFAULT_ORCHESTRATION_MODE;
  if (raw === SOCIAL_ORCHESTRATION_MODE) return SOCIAL_ORCHESTRATION_MODE;
  fail(`unsupported orchestration mode: ${raw}`);
}

export function resolveComposerOrchestration(prompt) {
  const text = String(prompt ?? "");
  if (/^\/social(?:\s+|$)/i.test(text)) {
    return { mode: SOCIAL_ORCHESTRATION_MODE, prompt: text.replace(/^\/social\s*/i, "").trim() };
  }
  if (/^\/pipeline\s+/i.test(text)) {
    return { mode: DEFAULT_ORCHESTRATION_MODE, prompt: text.replace(/^\/pipeline\s+/i, "").trim() };
  }
  return { mode: DEFAULT_ORCHESTRATION_MODE, prompt: text };
}

export function projectSocialContract({
  orchestrationMode,
  maxRounds,
  delegationDepthLimit,
  maxBudgetUsdPerTurn,
  pingPongLimit = SOCIAL_PING_PONG_LIMIT,
} = {}) {
  const mode = resolveOrchestrationMode({ orchestrationMode });
  if (mode !== SOCIAL_ORCHESTRATION_MODE) {
    return { optedIn: false, mode: DEFAULT_ORCHESTRATION_MODE };
  }
  const rounds = Number(maxRounds);
  const depth = Math.max(1, Math.min(8, Number(delegationDepthLimit) || 4));
  const budget = Number(maxBudgetUsdPerTurn);
  const hops = Number(pingPongLimit) || SOCIAL_PING_PONG_LIMIT;
  if (!Number.isFinite(rounds) || rounds < 1) fail("social 协作需要设置轮次上限");
  // social 多 agent 往复成本不可控："无限"单轮预算被显式拒绝（区别于缺失预算的报错）
  if (budget > 0 && !Number.isFinite(budget)) fail("social 协作需要有限的单轮预算上限：当前为无限，请设置有限金额（如 $5.00）", "SOCIAL_UNLIMITED_BUDGET_REJECTED");
  if (!Number.isFinite(budget) || budget <= 0) fail("social 协作需要设置单轮预算上限");
  if (!Number.isFinite(depth) || depth < 1) fail("social 协作需要设置委派深度上限");
  if (!Number.isFinite(hops) || hops < 1) fail("social 协作需要设置往复轮次上限");
  return {
    optedIn: true,
    mode: SOCIAL_ORCHESTRATION_MODE,
    maxRounds: rounds,
    delegationDepthLimit: depth,
    maxBudgetUsdPerTurn: budget,
    pingPongLimit: hops,
  };
}

export function socialContractOf(run) {
  if (run?.socialContract?.optedIn === true && run.socialContract.mode === SOCIAL_ORCHESTRATION_MODE) {
    return run.socialContract;
  }
  if (String(run?.orchestrationMode ?? "").toLowerCase() === SOCIAL_ORCHESTRATION_MODE) {
    return projectSocialContract({
      orchestrationMode: SOCIAL_ORCHESTRATION_MODE,
      maxRounds: run.maxStepsPerInteraction || run.maxRounds,
      delegationDepthLimit: run.delegationDepthLimit,
      maxBudgetUsdPerTurn: run.maxBudgetUsdPerTurn,
      pingPongLimit: run.socialContract?.pingPongLimit,
    });
  }
  return { optedIn: false, mode: DEFAULT_ORCHESTRATION_MODE };
}

export function classifyAgentRoute({ to, hops = 0, depth = 0, contract = null } = {}) {
  const recipient = String(to ?? "").trim();
  if (!recipient) fail("agent-to-agent message requires a recipient", "SOCIAL_RECIPIENT_REQUIRED");
  if (SOCIAL_BROADCAST_TARGETS.has(recipient.toLowerCase())) {
    return { disposition: recipient.toLowerCase() === "team" || recipient.toLowerCase() === "all" ? "broadcast" : "special" };
  }
  if (!contract?.optedIn) fail("agent-to-agent routing requires explicit social opt-in", "SOCIAL_OPT_IN_REQUIRED");
  if (Number(hops) > Number(contract.pingPongLimit || SOCIAL_PING_PONG_LIMIT)) {
    return { disposition: "dropped", reason: "PING_PONG_LIMIT" };
  }
  if (Number(depth) > Number(contract.delegationDepthLimit || 4)) {
    return { disposition: "dropped", reason: "DELEGATION_DEPTH_LIMIT" };
  }
  return { disposition: "queued" };
}
