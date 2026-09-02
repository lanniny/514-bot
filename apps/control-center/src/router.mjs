export function classifyTask(prompt = "", { hasVisualAttachment = false } = {}) {
  // 真实附件只用于选择路由规则，不再触发能力准入门。普通模型和成员默认拥有全部能力；
  // 只有 routing.json 中带 constraints + reason 的特殊规则才能限制候选通道。
  if (hasVisualAttachment) return "multimodal";
  const tests = [
    ["current-research", /最新|当前|今天|实时|搜索|search|news|202[5-9]/i],
    ["long-context", /长文档|全文|超过\s*\d+\s*(?:kb|mb)|long[- ]?context|document/i],
    ["review", /评审|审计|review|security|安全/i],
    ["debugging", /修复|报错|错误|异常|故障|debug|bug|exception|失败/i],
    ["coding", /实现|写代码|开发|编码|implement|code|build/i],
    ["planning", /规划|方案|架构|设计|plan|architecture/i],
  ];
  const matched = tests.find(([, pattern]) => pattern.test(prompt));
  if (matched) return matched[0];
  // 短 prompt 且不含任何任务关键词 → 打招呼/闲聊/简单问答，不值得跑完整多 agent pipeline。
  // 15 字符阈值：中文打招呼通常 2-6 字，"这个怎么用" 5 字，"帮我看看" 4 字；
  // 带任务意图的短 prompt（"修复 bug" 6 字、"帮我实现 X"）已被上方关键词先命中。
  if (prompt.trim().length <= 15 && !/实现|修复|写|开发|设计|规划|搜索|分析|评审|调试|部署|测试|代码|架构|方案|bug|debug|plan|code|build|review|search/i.test(prompt)) {
    return "simple";
  }
  return "planning";
}

function healthValue(providerHealth) {
  return providerHealth.status === "online" ? 1 : providerHealth.status === "degraded" ? 0.5 : 0;
}

function routeScore(profile, providerHealth, weights, preference = 0) {
  return (
    profile.quality * weights.quality
    + profile.speed * weights.speed
    + healthValue(providerHealth) * weights.health
    + ((6 - profile.costTier) / 5) * weights.cost
    + preference
  );
}

function constrainedProviders(rule) {
  const ids = rule?.constraints?.allowedProviders;
  return Array.isArray(ids) ? new Set(ids) : null;
}

// 结构性排除（特殊路由/白名单/显式指定/同供应商复核）是设计使然，不算故障；
// NO_ROUTE 文案只需要让 LO 一眼看见真正卡路的健康/禁用原因。
const STRUCTURAL_EXCLUSIONS = new Set(["not a team member", "not explicitly requested", "same provider as primary"]);

function routeBlockers(candidates, limit = 3) {
  return candidates
    .filter((candidate) => candidate.excluded)
    .map((candidate) => ({
      id: candidate.id,
      reasons: candidate.excludedReasons.filter((reason) => !STRUCTURAL_EXCLUSIONS.has(reason) && !reason.startsWith("special route:")),
    }))
    .filter((candidate) => candidate.reasons.length > 0)
    .slice(0, limit)
    .map((candidate) => `${candidate.id}: ${candidate.reasons.join("; ")}`);
}

function previewCost(profile) {
  const usd = Number(profile?.costUsd);
  if (Number.isFinite(usd)) return { usd, status: "known", tier: profile?.costTier ?? null };
  return { usd: null, status: "unknown", tier: profile?.costTier ?? null };
}

function previewPermission(profile, requestedMode) {
  const modes = Array.isArray(profile?.permissionModes) ? profile.permissionModes : [];
  const fallback = profile?.defaultPermissionMode || "unknown";
  const requested = String(requestedMode || "").trim();
  return requested && (!modes.length || modes.includes(requested)) ? requested : fallback;
}

function enrichDispatchPreview(result, profiles, { permissionMode = null, risk = "normal" } = {}) {
  const selectedProfile = profiles.find((profile) => profile.id === result.selected?.id) || null;
  const cost = previewCost(selectedProfile);
  const mode = previewPermission(selectedProfile, permissionMode);
  const fallbackUsed = result.fallbackUsed === true;
  return {
    ...result,
    createdRun: false,
    permissionMode: mode,
    permissionModes: Array.isArray(selectedProfile?.permissionModes) ? selectedProfile.permissionModes : [],
    cost,
    fallback: {
      used: fallbackUsed,
      from: result.preferredProvider,
      to: result.selected?.id || null,
      extraCalls: fallbackUsed ? 1 : 0,
      extraApprovals: fallbackUsed && ["high", "critical"].includes(risk) ? 1 : 0,
    },
    signals: {
      capability: selectedProfile?.role || selectedProfile?.label || null,
      quality: selectedProfile?.quality ?? null,
      speed: selectedProfile?.speed ?? null,
      health: result.selected?.health || null,
      cost: cost.status === "known" ? cost.usd : null,
      costStatus: cost.status,
    },
  };
}

export class ModelRouter {
  constructor({ profiles, policy, healthService }) {
    this.profiles = profiles;
    this.policy = policy;
    this.healthService = healthService;
  }

  async preview({ prompt = "", taskType, requestedProvider, risk = "normal", needsCurrentSource = false, allowedProviders = null, hasVisualAttachment = false, visualAttachmentType = null, permissionMode = null } = {}) {
    // 团队成员白名单由服务端推导。空数组必须 fail-closed，不能退化为“不设限制”。
    const allowed = Array.isArray(allowedProviders) ? new Set(allowedProviders) : null;
    const resolvedTaskType = hasVisualAttachment === true || visualAttachmentType !== null
      ? "multimodal"
      : needsCurrentSource
        ? "current-research"
        : taskType || classifyTask(prompt);
    const health = await this.healthService.map();
    const rule = this.policy.rules.find((item) => item.taskTypes.includes(resolvedTaskType));
    const specialAllowed = constrainedProviders(rule);
    const preference = new Map((rule?.prefer || []).map((id, index) => [id, Math.max(0, 0.12 - index * 0.03)]));

    if (requestedProvider) {
      const explicit = this.profiles.find((profile) => profile.id === requestedProvider);
      if (!explicit) throw Object.assign(new Error(`unknown requested provider: ${requestedProvider}`), { code: "PROVIDER_NOT_FOUND" });
      if (!health.get(explicit.id)?.available && this.policy.failOnUnavailableExplicitProvider) {
        throw Object.assign(new Error(`requested provider ${requestedProvider} is unavailable`), { code: "PROVIDER_UNAVAILABLE" });
      }
    }

    const candidates = this.profiles.map((profile) => {
      const providerHealth = health.get(profile.id) || { available: false, status: "unknown", reason: "no probe" };
      const excludedReasons = [];
      if (!profile.enabled) excludedReasons.push("disabled");
      if (allowed && !allowed.has(profile.id)) excludedReasons.push("not a team member");
      if (requestedProvider && profile.id !== requestedProvider) excludedReasons.push("not explicitly requested");
      if (specialAllowed && !specialAllowed.has(profile.id)) excludedReasons.push(`special route: ${rule.reason}`);
      if (this.policy.requireHealthyProvider && !providerHealth.available) excludedReasons.push(providerHealth.reason || "unhealthy");
      const score = routeScore(profile, providerHealth, this.policy.weights, preference.get(profile.id) || 0);
      return {
        id: profile.id,
        label: profile.label,
        role: profile.role,
        score: Number(score.toFixed(4)),
        health: providerHealth,
        excluded: excludedReasons.length > 0,
        excludedReasons,
      };
    });

    const eligible = candidates.filter((candidate) => !candidate.excluded).sort((a, b) => b.score - a.score);
    if (!eligible.length) {
      const blockers = routeBlockers(candidates);
      const error = new Error(`no healthy provider can satisfy ${resolvedTaskType}${blockers.length ? ` (${blockers.join("; ")})` : ""}`);
      error.code = "NO_ROUTE";
      error.candidates = candidates;
      throw error;
    }
    const selected = eligible[0];
    const independentRequired = this.policy.independentPass?.requiredFor?.includes(risk) || false;
    const selectedProfile = this.profiles.find((profile) => profile.id === selected.id);
    const independentCandidates = independentRequired
      ? this.profiles
          .filter((profile) => profile.id !== selected.id)
          .map((profile) => {
            const providerHealth = health.get(profile.id) || { available: false, status: "unknown", reason: "no probe" };
            const excludedReasons = [];
            if (!profile.enabled) excludedReasons.push("disabled");
            if (allowed && !allowed.has(profile.id)) excludedReasons.push("not a team member");
            if (specialAllowed && !specialAllowed.has(profile.id)) excludedReasons.push(`special route: ${rule.reason}`);
            if (this.policy.requireHealthyProvider && !providerHealth.available) excludedReasons.push(providerHealth.reason || "unhealthy");
            if (this.policy.independentPass?.mustDifferFromPrimary && profile.provider === selectedProfile?.provider) {
              excludedReasons.push("same provider as primary");
            }
            const score = routeScore(profile, providerHealth, this.policy.weights);
            return {
              id: profile.id,
              label: profile.label,
              role: profile.role,
              score: Number(score.toFixed(4)),
              health: providerHealth,
              excluded: excludedReasons.length > 0,
              excludedReasons,
            };
          })
          .sort((a, b) => b.score - a.score)
      : [];
    const independent = independentCandidates.find((candidate) => !candidate.excluded) || null;
    if (independentRequired && !independent) {
      const blockers = routeBlockers(independentCandidates);
      const error = new Error(`risk ${risk} requires a healthy independent provider${blockers.length ? ` (${blockers.join("; ")})` : ""}`);
      error.code = "NO_INDEPENDENT_ROUTE";
      error.candidates = independentCandidates;
      throw error;
    }
    const specialRoute = specialAllowed
      ? { ruleId: rule.id, reason: rule.reason, allowedProviders: [...specialAllowed] }
      : null;
    return enrichDispatchPreview({
      taskType: resolvedTaskType,
      risk,
      selected,
      independent,
      independentRequired,
      candidates: candidates.sort((a, b) => b.score - a.score),
      reason: `${selected.label} 通过健康与团队边界，按质量、速度、健康和成本综合得分 ${selected.score}${rule?.reason ? `；规则依据：${rule.reason}` : ""}`,
      specialRoute,
      // 显式选席是用户决策，不是路由降级；即使策略首选席位已禁用也不得误标 fallback。
      fallbackUsed: !requestedProvider && Boolean(rule?.prefer?.[0] && selected.id !== rule.prefer[0]),
      preferredProvider: rule?.prefer?.[0] || null,
    }, this.profiles, { permissionMode, risk });
  }
}
