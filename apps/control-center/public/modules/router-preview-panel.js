import { escapeHtml, redact, formatDate, normalizeStatus, statusText } from "../utils.js";

export function createRouterPreviewPanel({
  elements,
  state,
  currentTeam,
  currentTeamMembers,
  teamById,
  agentLabel,
}) {
  const ROUTER_TASK_LABELS = Object.freeze({
    auto: "自动判断",
    planning: "规划",
    coding: "实现",
    review: "评审",
    debugging: "诊断",
    "current-research": "当前资料",
    "long-context": "长上下文",
    multimodal: "多模态",
    "web-search": "检索",
    architecture: "架构",
    testing: "测试",
  });

  const ROUTER_RISK_LABELS = Object.freeze({
    low: "低",
    medium: "中",
    normal: "中",
    high: "高",
    security: "安全",
    production: "生产",
    governance: "治理",
  });

  function routerTaskLabel(value) {
    const key = String(value || "").trim();
    return ROUTER_TASK_LABELS[key] || key || "未判定";
  }

  function routerRiskLabel(value) {
    const key = String(value || "").trim();
    return ROUTER_RISK_LABELS[key] || key || "未标注";
  }

  function routerVerifierLabel(route) {
    const verifier = route?.verifier;
    if (route?.independentRequired === false && !verifier) return "不要求";
    if (!verifier || verifier === "--") return route?.independentRequired ? "未找到健康验证席" : "不要求";
    if (typeof verifier === "string") return verifier;
    return verifier.label || verifier.name || verifier.id || "未标注";
  }

  function syncRouterKindChips(kind = elements["router-kind"]?.value || "auto") {
    document.querySelectorAll("[data-router-kind]").forEach((button) => {
      const active = button.dataset.routerKind === kind;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
  }

  function syncRouterTeamContext() {
    const meta = elements["router-team-context"];
    const team = currentTeam();
    if (meta) {
      const count = team?.members?.length || 0;
      meta.textContent = team
        ? `当前团队「${team.name}」· ${count} 个席位进入白名单`
        : "未选择团队 · 预览会按内置团队 fail-closed";
    }
    const seat = elements["router-preferred-seat"];
    if (!seat) return;
    const previous = seat.value;
    const { members, coordinator } = currentTeamMembers();
    seat.innerHTML = [
      `<option value="">自动（按团队评分）</option>`,
      ...members.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(agentLabel(id))}${id === coordinator ? " · 主脑" : ""}</option>`),
    ].join("");
    if ([...seat.options].some((option) => option.value === previous)) seat.value = previous;
  }

  function renderRouter() {
    const status = elements["router-status"];
    const meta = elements["route-result-meta"];
    const primaryNode = elements["router-primary-decision"];
    const facts = elements["router-decision-facts"];
    const reasonsNode = elements["router-reason-list"];
    const candidatesNode = elements["router-candidate-body"];
    if (!status || !primaryNode || !candidatesNode) return;

    const route = state.routePreview;
    if (!route) {
      status.textContent = "等待预览";
      status.className = "status-label is-neutral";
      if (meta) meta.textContent = "尚无路由记录";
      primaryNode.innerHTML = `<span class="agent-avatar">--</span><div><span>主执行</span><strong>等待任务画像</strong></div>`;
      if (facts) facts.innerHTML = "";
      if (reasonsNode) reasonsNode.innerHTML = "";
      candidatesNode.innerHTML = `<p class="team-router-empty">写一段任务，按当前团队白名单生成可审计预览。</p>`;
      return;
    }

    const failed = Boolean(route.failed);
    const primary = route.primary ?? { name: "未选择", adapter: "" };
    const hasPrimary = Boolean(route.selected?.id || (primary.name && primary.name !== "未选择"));
    status.textContent = failed ? "预览失败" : "预览完成";
    status.className = `status-label ${failed ? "is-error" : "is-ok"}`;
    if (meta) {
      const teamName = teamById(route.teamId)?.name || currentTeam()?.name || "";
      meta.textContent = [teamName && `团队 ${teamName}`, `生成于 ${formatDate(route.createdAt)}`].filter(Boolean).join(" · ");
    }
    const avatar = (primary.name || primary.adapter || "--").slice(0, 2).toUpperCase();
    primaryNode.innerHTML = `
      <span class="agent-avatar">${escapeHtml(avatar)}</span>
      <div><span>${failed ? "未能选出主执行" : "主执行"} · ${escapeHtml(primary.adapter || primary.role || primary.runtimeProfileId || "adapter 未标注")}</span><strong>${escapeHtml(hasPrimary ? primary.name : "等待任务画像")}</strong></div>`;
    if (facts) {
      facts.innerHTML = [
        ["任务类型", routerTaskLabel(route.taskType)],
        ["综合得分", route.confidence],
        ["风险", routerRiskLabel(route.risk)],
        ["独立验证", routerVerifierLabel(route)],
        ["策略依据", route.policy],
        ["软偏好", route.fallbackUsed ? "已偏离首选席" : (route.preferredProvider ? "命中首选或显式选择" : "无软偏好")],
        ["权限档", route.permissionMode || "--"],
        ["成本", route.cost?.status === "known" ? `$${route.cost.usd}` : "未知"],
        ["回退额外", route.fallback?.used ? `调用 ${route.fallback.extraCalls} / 审批 ${route.fallback.extraApprovals}` : "无"],
      ]
        .filter(([, value]) => value != null && value !== "" && value !== "--")
        .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`)
        .join("");
    }
    if (reasonsNode) {
      const reasons = route.reasons?.length ? route.reasons : failed ? [route.failedReason || "没有健康通道能满足当前任务与团队边界。"] : [];
      reasonsNode.innerHTML = reasons
        .map((reason, index) => `<div class="reason-row"><span class="reason-index">${index + 1}</span><p>${escapeHtml(reason)}</p></div>`)
        .join("");
    }

    const selectedId = route.selected?.id ?? route.primary?.id ?? null;
    const candidates = route.candidates ?? [];
    const maxScore = Math.max(0.0001, ...candidates.map((item) => Number(item.score) || 0));
    candidatesNode.innerHTML = candidates.length
      ? candidates.map((candidate) => {
        const isSelected = candidate.id === selectedId && !candidate.excluded;
        const healthStatus = candidate.health?.status ?? "unknown";
        const verdict = candidate.excluded
          ? (candidate.excludedReasons ?? []).join("、") || "已排除"
          : isSelected ? "已选主执行" : "备选";
        const score = Number(candidate.score);
        const width = Number.isFinite(score) ? Math.max(6, Math.round((score / maxScore) * 100)) : 6;
        return `<article class="team-router-candidate ${candidate.excluded ? "is-excluded" : isSelected ? "is-selected" : ""}" data-score="${width}">
          <header>
            <div>
              <strong>${escapeHtml(candidate.label ?? candidate.id ?? "?")}</strong>
              <span class="subtle mono">${escapeHtml(candidate.runtimeProfileId || candidate.id || "")}</span>
            </div>
            <span class="team-router-score">${escapeHtml(String(candidate.score ?? "--"))}</span>
          </header>
          <div class="team-router-score-track" aria-hidden="true"><i data-score-bar="${width}"></i></div>
          <footer>
            <span class="status-label is-${normalizeStatus(healthStatus)}">${escapeHtml(statusText(healthStatus))}</span>
            <p>${escapeHtml(redact(verdict))}</p>
          </footer>
        </article>`;
      }).join("")
      : `<p class="team-router-empty">路由结果未携带候选明细。</p>`;
    candidatesNode.querySelectorAll("[data-score-bar]").forEach((bar) => {
      bar.style.width = `${Number(bar.dataset.scoreBar) || 6}%`;
    });
  }

  return {
    ROUTER_TASK_LABELS,
    ROUTER_RISK_LABELS,
    routerTaskLabel,
    routerRiskLabel,
    routerVerifierLabel,
    syncRouterKindChips,
    syncRouterTeamContext,
    renderRouter,
  };
}
