import { escapeHtml, redact, compactHash } from "../utils.js";
import { isSucceededRun, saveSkillActionMarkup } from "./private-skill-from-run.js";

export const BOT_SETTLEMENT_SCHEMA = "514cc.run-settlement/v1";
export const RUN_SETTLEMENT_TTL_MS = 15_000;

const BOT_SETTLEMENT_VERDICT_LABELS = Object.freeze({
  unknown: "结算未知",
  "remote-unsupported": "远程未支持",
  blocked: "需要处理",
  partial: "部分结算",
  reviewable: "可审阅",
});
const BOT_ARTIFACT_AVAILABILITY_LABELS = Object.freeze({
  available: "可用",
  missing: "缺失",
  truncated: "已截断",
  "digest-changed": "摘要已变化",
  "stale-run": "来源已过期",
});
const BOT_SETTLEMENT_REQUIRED_ACTIONS = Object.freeze(["merge", "rebase", "commit", "push", "gitAdd"]);
const BOT_SETTLEMENT_TTL_MS = 15_000;

function validSettlementObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function validateBotSettlementEnvelope(value, expectedRunId = null) {
  const invalid = (reason) => ({ ok: false, reason });
  if (!validSettlementObject(value)) return invalid("结算响应不是对象");
  if (value.schema !== BOT_SETTLEMENT_SCHEMA) return invalid("结算 schema 不受支持");
  if (expectedRunId && String(value.runId || "") !== String(expectedRunId)) return invalid("结算响应的 run 归属不一致");
  const verdict = String(value.verdict || "");
  if (!Object.hasOwn(BOT_SETTLEMENT_VERDICT_LABELS, verdict)) return invalid("结算 verdict 不受支持");
  if (!validSettlementObject(value.autoLanding)) return invalid("缺少自动落地策略");
  for (const action of BOT_SETTLEMENT_REQUIRED_ACTIONS) {
    if (value.autoLanding[action] !== false) return invalid(`自动落地策略 ${action} 未明确关闭`);
  }
  if (!validSettlementObject(value.workspace) || typeof value.workspace.kind !== "string") return invalid("工作区结算字段不完整");
  if (!validSettlementObject(value.diff) || typeof value.diff.available !== "boolean" || typeof value.diff.dirty !== "boolean") {
    return invalid("diff 结算字段不完整");
  }
  if (value.diff.endpoint !== null && typeof value.diff.endpoint !== "string") return invalid("diff endpoint 类型错误");
  if (!Array.isArray(value.artifacts) || value.artifacts.length > 16) return invalid("artifact 列表不完整");
  const allowedAvailability = new Set(Object.keys(BOT_ARTIFACT_AVAILABILITY_LABELS));
  for (const artifact of value.artifacts) {
    if (!validSettlementObject(artifact)
      || typeof artifact.id !== "string" || !artifact.id
      || typeof artifact.kind !== "string" || !artifact.kind
      || !allowedAvailability.has(String(artifact.availability || ""))
      || artifact.published !== false) return invalid("artifact 字段未通过校验");
    if (artifact.endpoint !== null && typeof artifact.endpoint !== "string") return invalid("artifact endpoint 类型错误");
  }
  if (!Array.isArray(value.risks) || value.risks.length > 16) return invalid("风险列表不完整");
  for (const risk of value.risks) {
    if (!validSettlementObject(risk) || typeof risk.id !== "string" || typeof risk.status !== "string" || typeof risk.reason !== "string") {
      return invalid("风险字段未通过校验");
    }
  }
  if (!validSettlementObject(value.nextAction)
    || typeof value.nextAction.id !== "string"
    || typeof value.nextAction.reason !== "string") return invalid("下一步字段不完整");
  return { ok: true, data: value };
}

function botSettlementAvailabilityClass(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9-]/g, "-") || "unknown";
}

function botSettlementArtifactMarkup(artifact) {
  const id = String(artifact?.id || "").trim();
  const label = redact(String(artifact?.label || artifact?.kind || "未命名产物")).slice(0, 160);
  const kind = redact(String(artifact?.kind || "artifact")).slice(0, 40);
  const availability = String(artifact?.availability || "unknown").toLowerCase();
  const availabilityLabel = BOT_ARTIFACT_AVAILABILITY_LABELS[availability] || "状态未知";
  const digest = artifact?.digest ? compactHash(artifact.digest) : "无摘要";
  const published = artifact?.published === true ? "服务端标记已发布" : "未发布";
  return `<li class="bot-artifact-row is-${escapeHtml(botSettlementAvailabilityClass(availability))}" data-bot-artifact-id="${escapeHtml(id)}"><span class="bot-artifact-status" aria-hidden="true"></span><span class="bot-artifact-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(kind)} · ${escapeHtml(availabilityLabel)} · ${escapeHtml(published)}</small></span><code title="${escapeHtml(String(artifact?.digest || ""))}">${escapeHtml(digest)}</code></li>`;
}

export function createBotSettlement({
  runProjection, settlementRunSignature, settlementViewNeedsRefresh,
  requestSettlement, cancelSettlementRequest, shouldPaintSettlement,
  state, botState, botRunForAgent, botRenderConversationMessages,
  normalizeRunMessages, botSyncConversation, botRenderCollaborationWorkspace,
}) {
  function retryBotSettlement(runId) {
    const id = String(runId || "").trim();
    if (!id) return;
    const run = runProjection.resolveRun(id);
    const signature = settlementRunSignature(run);
    cancelSettlementRequest("bot", id);
    runProjection.nextSettlementGeneration("bot", id);
    runProjection.setSettlementView("bot", id, { runId: id, status: "loading", runSignature: signature });
    if (state.view === "bot" && String(botRunForAgent()?.id || "") === id) {
      botRenderConversationMessages(botState.agentId, run, run ? normalizeRunMessages(run, { agentId: botState.agentId }) : []);
    }
    void loadBotSettlement(id, { force: true, runSignature: signature, skipLoadingGuard: true });
  }

  function botSettlementMarkup(run) {
    if (!run?.id || !shouldPaintSettlement(run)) return "";
    const runId = String(run.id);
    const view = runProjection.settlementView("bot", runId);
    const runSignature = settlementRunSignature(run);
    if (settlementViewNeedsRefresh(view, run, BOT_SETTLEMENT_TTL_MS)) {
      runProjection.queueSettlementLoad("bot", runId, () => loadBotSettlement(runId, { force: Boolean(view), runSignature }));
    }
    if (!view || view.status === "loading") {
      return `<article class="bot-card bot-settlement-card is-dynamic" data-bot-card="settlement" data-bot-card-source="settlement" data-run-id="${escapeHtml(runId)}" data-settlement-state="loading"><div class="bot-card-head"><span class="bot-card-icon"><svg aria-hidden="true" class="icon lucide"><use href="#lucide-loader-circle"></use></svg></span><div><strong>正在整理交付记录</strong><span>读取此 run 的结算与证据投影</span></div><span class="bot-card-state is-waiting">loading</span></div><p class="bot-card-copy">不会自动 merge、commit 或 push。</p></article>`;
    }
    if (view.status === "loading") {
      return `<article class="bot-card bot-settlement-card is-dynamic" data-bot-card="settlement" data-bot-card-source="settlement" data-run-id="${escapeHtml(runId)}" data-settlement-state="loading"><div class="bot-card-head"><span class="bot-card-icon"><svg aria-hidden="true" class="icon lucide"><use href="#lucide-loader-circle"></use></svg></span><div><strong>正在整理交付记录</strong><span>结算请求仍在进行</span></div><span class="bot-card-state is-waiting">loading</span></div></article>`;
    }
    if (view.status === "error" || view.status === "invalid") {
      const invalid = view.status === "invalid";
      return `<article class="bot-card bot-settlement-card is-dynamic is-error" data-bot-card="settlement" data-bot-card-source="settlement" data-run-id="${escapeHtml(runId)}" data-settlement-state="error"><div class="bot-card-head"><span class="bot-card-icon"><svg aria-hidden="true" class="icon lucide"><use href="#lucide-circle-alert"></use></svg></span><div><strong>${invalid ? "交付记录未通过校验" : "交付记录暂时不可用"}</strong><span>${invalid ? "未经识别的数据不会渲染" : "这不代表没有产物"}</span></div><span class="bot-card-state is-error">${invalid ? "blocked" : "unavailable"}</span></div><p class="bot-card-copy">${escapeHtml(redact(String(view.error || (invalid ? "结算契约不完整" : "结算读取失败")).slice(0, 240)))}</p><div class="bot-card-actions bot-settlement-actions"><button class="bot-text-button" type="button" data-bot-settlement-retry="${escapeHtml(runId)}">重新读取结算</button></div></article>`;
    }
    const envelope = view.data && typeof view.data === "object" ? view.data : null;
    if (!envelope || envelope.schema !== BOT_SETTLEMENT_SCHEMA) {
      return `<article class="bot-card bot-settlement-card is-dynamic is-error" data-bot-card="settlement" data-bot-card-source="settlement" data-run-id="${escapeHtml(runId)}" data-settlement-state="invalid"><div class="bot-card-head"><span class="bot-card-icon"><svg aria-hidden="true" class="icon lucide"><use href="#lucide-shield"></use></svg></span><div><strong>交付记录未通过校验</strong><span>控制面返回了未知结算契约</span></div><span class="bot-card-state is-error">blocked</span></div><p class="bot-card-copy">未渲染未经识别的产物数据。</p></article>`;
    }
    const verdict = String(envelope.verdict || "unknown").toLowerCase();
    const verdictLabel = BOT_SETTLEMENT_VERDICT_LABELS[verdict] || "状态未知";
    const partial = verdict === "partial";
    const settlementState = partial ? "partial" : verdict === "blocked" || verdict === "remote-unsupported" || verdict === "unknown" ? "blocked" : "ready";
    const heading = partial ? "交付尚未确认" : "准备交付";
    const nextAction = redact(String(envelope.nextAction?.reason || "先核对产物和风险，再决定下一步。")).slice(0, 260);
    const diff = envelope.diff && typeof envelope.diff === "object" ? envelope.diff : {};
    const diffSummary = [
      Number.isFinite(Number(diff.filesChanged)) ? `${Number(diff.filesChanged)} 个文件` : null,
      Number.isFinite(Number(diff.additions)) ? `+${Number(diff.additions)}` : null,
      Number.isFinite(Number(diff.deletions)) ? `-${Number(diff.deletions)}` : null,
      diff.truncated === true ? "diff 已截断" : null,
    ].filter(Boolean).join(" · ");
    const artifacts = Array.isArray(envelope.artifacts) ? envelope.artifacts.slice(0, 16) : [];
    const risks = Array.isArray(envelope.risks) ? envelope.risks.slice(0, 4) : [];
    const diffAction = diff.endpoint && run.worktreePath && !run.remote
      ? `<button class="bot-text-button" type="button" data-bot-settlement-diff="${escapeHtml(runId)}">查看产物 diff</button>`
      : "";
    const saveSkillAction = isSucceededRun(run) ? saveSkillActionMarkup(runId) : "";
    const actions = [diffAction, saveSkillAction].filter(Boolean).join("");
    return `<article class="bot-card bot-settlement-card is-dynamic is-${escapeHtml(botSettlementAvailabilityClass(verdict))}" data-bot-card="settlement" data-bot-card-source="settlement" data-run-id="${escapeHtml(runId)}" data-settlement-state="${settlementState}" data-settlement-verdict="${escapeHtml(verdict)}">
    <div class="bot-card-head"><span class="bot-card-icon"><svg aria-hidden="true" class="icon lucide"><use href="#lucide-git-branch"></use></svg></span><div><strong>${heading}</strong><span>run ${escapeHtml(runId)} · ${escapeHtml(verdictLabel)}</span></div><span class="bot-card-state ${verdict === "reviewable" ? "is-complete" : settlementState === "blocked" ? "is-error" : "is-waiting"}">${escapeHtml(verdict)}</span></div>
    <p class="bot-card-copy">${escapeHtml(nextAction)}</p>
    <div class="bot-settlement-meta"><span>${escapeHtml(envelope.isolation || "unknown")}</span>${diffSummary ? `<span>${escapeHtml(diffSummary)}</span>` : ""}<span>自动落地关闭</span></div>
    ${risks.length ? `<ul class="bot-settlement-risks">${risks.map((risk) => `<li>${escapeHtml(redact(String(risk?.reason || risk?.id || "风险未知")).slice(0, 180))}</li>`).join("")}</ul>` : ""}
    <div class="bot-settlement-artifacts"><div class="bot-settlement-section-head"><strong>证据产物</strong><span>${artifacts.length ? `${artifacts.length} 项` : "暂无"}</span></div>${artifacts.length ? `<ul class="bot-artifact-list">${artifacts.map(botSettlementArtifactMarkup).join("")}</ul>` : `<p class="bot-settlement-empty">当前结算没有可显示的 artifact；不会虚构发布状态。</p>`}</div>
    ${actions ? `<div class="bot-card-actions bot-settlement-actions">${actions}</div>` : ""}
  </article>`;
  }

  async function loadBotSettlement(runId, { force = false, runSignature = "", skipLoadingGuard = false } = {}) {
    const id = String(runId || "").trim();
    await runProjection.loadSettlement("bot", id, {
      force,
      runSignature,
      skipLoadingGuard,
      request: (rid) => requestSettlement("bot", rid),
      validate: (data, rid) => validateBotSettlementEnvelope(data, rid),
      getRun: () => runProjection.resolveRun(id),
      onChange: () => {
        if (state.view === "bot" && String(botRunForAgent()?.id || "") === id) {
          void botSyncConversation(botState.agentId);
          botRenderCollaborationWorkspace();
        }
      },
      dropStaleResponses: false,
    });
  }

  return {
    retryBotSettlement,
    botSettlementMarkup,
    loadBotSettlement,
  };
}
