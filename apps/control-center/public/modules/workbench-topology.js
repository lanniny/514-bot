import { escapeHtml, formatTime, normalizeStatus, runStatusText } from "../utils.js";
import { ACTIVE_RUN_STATES } from "../state.js";
import { selectPipelineRoot, sessionAgentId } from "../team-panel.js";

// v3.6 社会模拟拓扑：从 bus.jsonl 的 from/to 消息流构建参与者链（谁说了几句、谁是 leader）。
// 成功短 TTL + 失败指数负缓存；旧 run 请求可取消，避免离线 bus 在 SSE 热路径形成请求风暴。
export function createWorkbenchTopology({
  request, elements, state, selectedRun, commitMarkup,
  agentLabel, AGENT_SHORT, agentSlug, agentCli, cliIconMarkup,
  historyEventsForRun, eventTracksEvent, runReplayScrubber,
}) {
  const socialTopologyCache = new Map(); // runId → { at, messages, diagnostics } | { error, failures, retryAt }
  const socialTopologyInflight = new Map(); // runId → { promise, controller }
  let socialTopologyGeneration = 0;
  let runReplayScrubberMounted = false;
  const SOCIAL_TOPOLOGY_TTL_MS = 30_000; // bus.routed 会精确失效；TTL 只兜底外部写入
  const SOCIAL_TOPOLOGY_MAX_BACKOFF_MS = 30_000;

  function trimSocialTopologyCache() {
    while (socialTopologyCache.size > 30) socialTopologyCache.delete(socialTopologyCache.keys().next().value);
  }

  function abortSocialTopologyRequest(runId) {
    const entry = socialTopologyInflight.get(runId);
    if (!entry) return;
    // Delete ownership before aborting. A transport that ignores AbortSignal is
    // still fenced out by the promise-identity gate in the completion handler.
    socialTopologyInflight.delete(runId);
    entry.controller.abort();
  }

  function invalidateSocialTopology(runId) {
    socialTopologyCache.delete(runId);
    abortSocialTopologyRequest(runId);
  }

  function cancelSocialTopologyRequestsExcept(runId) {
    for (const id of socialTopologyInflight.keys()) {
      if (id !== runId) abortSocialTopologyRequest(id);
    }
  }

  function supersededSocialTopologyError() {
    return Object.assign(new Error("social topology request was superseded"), {
      name: "AbortError",
      code: "ABORT_ERR",
    });
  }

  function loadSocialTopologyMessages(runId) {
    const now = Date.now();
    const cached = socialTopologyCache.get(runId);
    if (cached?.messages && now - cached.at < SOCIAL_TOPOLOGY_TTL_MS) {
      return Promise.resolve({ messages: cached.messages, diagnostics: cached.diagnostics ?? null });
    }
    if (cached?.error && now < cached.retryAt) return Promise.reject(cached.error);
    const existing = socialTopologyInflight.get(runId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const pending = request(`/api/runs/${encodeURIComponent(runId)}/bus`, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted || socialTopologyInflight.get(runId)?.promise !== pending) {
          throw supersededSocialTopologyError();
        }
        const messages = Array.isArray(payload?.messages) ? payload.messages : [];
        const diagnostics = payload?.diagnostics && typeof payload.diagnostics === "object" ? payload.diagnostics : null;
        socialTopologyCache.set(runId, { at: Date.now(), messages, diagnostics });
        trimSocialTopologyCache();
        return { messages, diagnostics };
      })
      .catch((error) => {
        const ownsRequest = socialTopologyInflight.get(runId)?.promise === pending;
        if (!controller.signal.aborted && ownsRequest && error?.name !== "AbortError") {
          const failures = (cached?.failures ?? 0) + 1;
          const retryAfter = Math.min(1_000 * (2 ** (failures - 1)), SOCIAL_TOPOLOGY_MAX_BACKOFF_MS);
          socialTopologyCache.set(runId, { error, failures, retryAt: Date.now() + retryAfter });
          trimSocialTopologyCache();
        }
        throw error;
      })
      .finally(() => {
        if (socialTopologyInflight.get(runId)?.promise === pending) socialTopologyInflight.delete(runId);
      });
    socialTopologyInflight.set(runId, { promise: pending, controller });
    return pending;
  }

  async function renderSocialTopology(run, generation) {
    const container = elements["session-topology"];
    const canCommit = () =>
      generation === socialTopologyGeneration
      && state.selectedRunId === run.id
      && selectedRun()?.orchestrationMode === "social";
    try {
      const { messages, diagnostics } = await loadSocialTopologyMessages(run.id);
      if (!canCommit()) return;
      const degraded = diagnostics?.status === "degraded";
      const truncated = diagnostics?.truncated?.bytes === true || diagnostics?.truncated?.messages === true;
      const windowed = truncated || degraded;
      if (!messages.length) {
        commitMarkup(container, degraded
          ? `<div class="empty-state" role="alert"><span>bus 审计降级，暂无法完整重建团队拓扑</span></div>`
          : `<div class="empty-state"><span>暂无对话</span></div>`);
        return;
      }
      const participants = [];
      for (const message of messages) {
        for (const party of [message.from, message.to]) {
          if (party && !participants.includes(party)) participants.push(party);
        }
      }
      const notice = degraded
        ? `<div class="topology-window-note is-degraded" role="alert">bus 审计降级，以下拓扑可能不完整</div>`
        : truncated
          ? `<div class="topology-window-note" role="status">仅按最近 ${messages.length} 条消息重建</div>`
          : "";
      commitMarkup(container, notice + participants
        .map((party) => {
          const label = party === "lo" ? "LO" : party === "team" ? "全员" : party === "system" ? "系统" : agentLabel(party);
          const role = party === "lo" ? "用户" : party === "team" ? "广播" : party === "system" ? "编排器" : party === run.coordinatorId ? "leader" : "成员";
          const spoken = messages.filter((message) => message.from === party).length;
          // 参与者卡与会话流同一套 agent 配色槽/双字码（群聊视觉一致性）；最近发言者呼吸高亮
          const chip = party === "lo" ? "LO" : party === "team" ? "全" : party === "system" ? "系" : AGENT_SHORT[party] ?? label.slice(0, 2).toUpperCase();
          const partyCli = agentCli(party);
          const chipContent = partyCli ? cliIconMarkup(partyCli) : escapeHtml(chip);
          const slug = ["lo", "team", "system"].includes(party) ? "" : ` is-agent-${agentSlug(party)}`;
          const speaking = messages.at(-1)?.from === party ? " is-speaking" : "";
          const interactive = party !== "lo" && party !== "team" && party !== "system";
          const tag = interactive ? "button" : "div";
          const attributes = interactive
            ? ` type="button" data-topology-agent="${escapeHtml(party)}" title="打开 ${escapeHtml(label)} 的独立页" aria-label="打开 ${escapeHtml(label)} 的独立页"`
            : "";
          const countLabel = windowed ? `${spoken} 条近期发言` : `${spoken} 条发言`;
          return `<${tag} class="topology-node${slug}${speaking}"${attributes}><span class="topology-chip${partyCli ? " has-cli-logo" : ""}" aria-hidden="true">${chipContent}</span><div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(role)} · ${countLabel}</span></div></${tag}>`;
        })
        .join(""));
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "ABORT_ERR") return;
      if (canCommit()) {
        const retryAt = socialTopologyCache.get(run.id)?.retryAt ?? Date.now();
        const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
        commitMarkup(container, `<div class="empty-state"><span>bus 读取失败，${seconds} 秒后可重试</span></div>`);
      }
    }
  }

  function renderRouteDecision(route) {
    if (!route) {
      elements["route-decision"].innerHTML = `<span class="route-model">尚未路由</span><p>任务提交后显示候选模型、路由权重和守卫条件。</p>`;
      return;
    }
    const name = route.primary?.name || "未选择";
    const reason = route.reasons?.[0] || `策略 ${route.policy || "未标注"}`;
    elements["route-decision"].innerHTML = `<span class="route-model">${escapeHtml(name)}</span><p>${escapeHtml(reason)}</p>`;
  }

  function renderTopology(run) {
    const generation = ++socialTopologyGeneration;
    cancelSocialTopologyRequestsExcept(run?.orchestrationMode === "social" ? run.id : null);
    if (!run) {
      commitMarkup(elements["session-topology"], `<div class="empty-state"><span>暂无会话</span></div>`);
      return;
    }
    if (run.orchestrationMode === "social") {
      void renderSocialTopology(run, generation); // 请求去重 + 选中 run/渲染代次双门，旧响应不得倒灌
      return;
    }
    const sessions = Array.isArray(run.sessions) ? run.sessions : [];
    const coordinatorId = run.coordinatorId || "";
    const coordinatorName = coordinatorId ? agentLabel(coordinatorId) : "团队主脑";
    const root = selectPipelineRoot(sessions, coordinatorId) ?? {
      name: coordinatorName,
      agentId: coordinatorId || null,
      role: "orchestrator",
      status: run.status,
    };
    const children = sessions.filter((session) => session !== root).slice(0, 5);
    const nodes = [root, ...children];
    commitMarkup(elements["session-topology"], nodes
      .map((session, index) => {
        const agentId = sessionAgentId(session);
        const name = session.name ?? session.agent_name ?? (agentId ? agentLabel(agentId) : null) ?? session.adapter ?? (index === 0 ? coordinatorName : `Agent ${index}`);
        const role = session === root ? "orchestrator" : session.role ?? session.kind ?? "worker";
        const status = session.status ?? session.state ?? run.status;
        return `<div class="topology-node"><span class="status-dot is-${normalizeStatus(status === "complete" ? "ok" : ACTIVE_RUN_STATES.has(String(status)) ? "pending" : status)}"></span><div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(role)} · ${escapeHtml(runStatusText(status))}</span></div></div>`;
      })
      .join(""));
  }

  function renderWorkbenchEvents() {
    const run = selectedRun();
    // W2.8 回放 scrubber：静态挂载点只 mount 一次，run 切换时按 id diff 拉取 /replay
    if (!runReplayScrubberMounted) {
      const replayMount = document.querySelector("[data-replay-mount]");
      if (replayMount) {
        runReplayScrubber.mount(replayMount);
        runReplayScrubberMounted = true;
      }
    }
    void runReplayScrubber.update(run?.id || null);
    // 选中 run 时合并磁盘回放历史（fetchRunEvents）——旧 run 的事件早已滚出 SSE 实时窗口，
    // 只吃 state.events 会让右栏空报"等待事件"（历史在磁盘上明明有）
    const historical = run ? [...historyEventsForRun(run.id)].reverse() : []; // 磁盘回放旧→新，时间线要新→旧
    const merged = [];
    for (const event of [...state.events.filter((item) => !run || item.runId === run.id), ...historical]) {
      // 实时窗口会把连续 delta 聚合成一个 envelope，而磁盘历史保留原始片段。
      // 复用聚合项的 ID/sequence 覆盖关系，避免右栏同时显示聚合项和每个原始片段。
      if (merged.some((tracked) => eventTracksEvent(tracked, event))) continue;
      merged.push(event);
      if (merged.length >= 30) break;
    }
    const events = merged;
    // 事件流彩色分类（精致化波次）：类型前缀→色调，告警词→红，一眼分出治理/总线/agent/自动化
    const eventTone = (type) => {
      const value = String(type);
      if (/fail|error|denied|dropped|blocked/i.test(value)) return "red";
      if (value.startsWith("bus.")) return "aqua";
      if (value.startsWith("agent.")) return "blue";
      if (value.startsWith("automation.")) return "amber";
      if (value.startsWith("run.")) return "rose";
      if (value === "user.message") return "violet";
      return "neutral";
    };
    elements["workbench-event-list"].innerHTML = events.length
      ? events
          .map(
            (event) => `
          <li class="timeline-item is-tone-${eventTone(event.type)}">
            <strong>${escapeHtml(event.type)}</strong>
            <span>${escapeHtml(event.summary)}</span>
            <time>${escapeHtml(formatTime(event.timestamp))}</time>
          </li>`,
          )
          .join("")
      : `<li class="timeline-item"><strong>等待事件</strong><span>${run ? "该任务暂无事件记录" : "SSE 建立后自动刷新"}</span></li>`;
  }

  return {
    renderRouteDecision,
    renderTopology,
    renderWorkbenchEvents,
    invalidateSocialTopology,
    loadSocialTopologyMessages,
    socialTopologyCache,
    socialTopologyInflight,
  };
}
