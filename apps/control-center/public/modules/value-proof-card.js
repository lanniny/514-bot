/**
 * value-proof-card.js — Phase C4 / v48 P-01 · P-02
 *
 * 成功 run 的结算「收获证明」：只投影 run / settlement / event-store 里已有的信号。
 * 提案里的「省了多少手工步骤 / 花了多少钱换来什么」若仓库里没有对应字段，就省略——不编造。
 *
 * DELTA 这里指治理账本（settlement artifact.kind === "delta"），
 * 不是流式 token 的 *.delta 事件。
 */

import { escapeHtml } from "../utils.js";
import { isSucceededRun } from "./private-skill-from-run.js";

export const VALUE_PROOF_CARD = "514cc.value-proof/v1";

/** 一键跳到已有表面，不重建 Mission Control。 */
export const VALUE_PROOF_TARGETS = Object.freeze({
  evidence: Object.freeze({
    id: "evidence",
    action: "value-proof:evidence",
    dest: "bot-evidence-or-results",
    label: "看证据",
  }),
  delta: Object.freeze({
    id: "delta",
    action: "value-proof:delta",
    dest: "view:observability#obs-delta-title",
    label: "看 DELTA",
  }),
  replay: Object.freeze({
    id: "replay",
    action: "value-proof:replay",
    dest: "workbench-mission-activity#replay",
    label: "回放这次",
  }),
});

function asText(value) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function runDurationMs(run) {
  const start = Date.parse(run?.createdAt || "");
  const end = Date.parse(run?.completedAt || run?.updatedAt || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

export function formatValueProofDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

function artifactsOf(settlement) {
  return Array.isArray(settlement?.artifacts) ? settlement.artifacts.filter((item) => item && typeof item === "object") : [];
}

function eventsForRun(events, runId) {
  const id = asText(runId);
  if (!id || !Array.isArray(events)) return [];
  return events.filter((event) => event && asText(event.runId) === id);
}

function projectRoute(run) {
  const mode = asText(run?.orchestrationMode);
  const who = asText(run?.startAgentId || run?.executionOwnerId);
  const seat = asText(
    run?.startRuntimeProfileId
    || run?.executionOwnerRuntimeProfileId
    || (Array.isArray(run?.teamRoster) ? run.teamRoster.find((member) => asText(member?.runtimeProfileId))?.runtimeProfileId : "")
    || (Array.isArray(run?.turnAttempts) ? run.turnAttempts.find((attempt) => asText(attempt?.adapterId || attempt?.adapter))?.adapterId || run.turnAttempts.find((attempt) => asText(attempt?.adapter))?.adapter : ""),
  );
  const parts = [mode, who, seat].filter(Boolean);
  if (!parts.length) return null;
  return { id: "route", label: "路线", value: parts.join(" · ") };
}

function projectDuration(run) {
  const ms = runDurationMs(run);
  if (ms == null) return null;
  return { id: "duration", label: "用时", value: formatValueProofDuration(ms), ms };
}

function projectEvidence(settlement) {
  if (!settlement || typeof settlement !== "object") return null;
  const artifacts = artifactsOf(settlement);
  if (!artifacts.length) {
    return { id: "evidence", label: "证据", value: "这次没有证据产物", count: 0, empty: true };
  }
  return { id: "evidence", label: "证据", value: `${artifacts.length} 份产物`, count: artifacts.length, empty: false };
}

function projectDelta(settlement) {
  if (!settlement || typeof settlement !== "object") return null;
  const count = artifactsOf(settlement).filter((item) => asText(item.kind).toLowerCase() === "delta").length;
  if (!count) {
    return { id: "delta", label: "DELTA", value: "这次没有 DELTA 账本", count: 0, empty: true };
  }
  return { id: "delta", label: "DELTA", value: `${count} 条收获证明`, count, empty: false };
}

function projectHandoff(run, settlement) {
  const fromSettlement = settlement && typeof settlement === "object"
    ? artifactsOf(settlement).filter((item) => asText(item.kind).toLowerCase() === "handoff").length
    : null;
  const tasks = Array.isArray(run?.taskGraph?.tasks) ? run.taskGraph.tasks.length : null;
  if (fromSettlement == null && (tasks == null || tasks === 0)) return null;
  if (fromSettlement === 0 && (tasks == null || tasks === 0)) {
    return { id: "handoff", label: "交接", value: "没有交接件", count: 0, empty: true };
  }
  const parts = [];
  if (Number.isFinite(fromSettlement) && fromSettlement > 0) parts.push(`${fromSettlement} 份交接`);
  if (Number.isFinite(tasks) && tasks > 0) parts.push(`${tasks} 项任务`);
  if (!parts.length) return null;
  return { id: "handoff", label: "交接", value: parts.join(" · "), count: (fromSettlement || 0) + (tasks || 0), empty: false };
}

function projectBudget(run) {
  const stop = run?.stopReason && typeof run.stopReason === "object" ? run.stopReason : null;
  const stopType = asText(stop?.type || (typeof run?.stopReason === "string" ? run.stopReason : ""));
  if (stopType === "budget_exhausted" || asText(run?.failureKind) === "budget_exhausted") {
    return { id: "budget", label: "止损", value: "预算用尽后停下", stop: stopType || "budget_exhausted" };
  }
  if (stopType) {
    return { id: "budget", label: "停下", value: stopType, stop: stopType };
  }
  const spent = finiteNumber(run?.costUsdTotal ?? run?.interactionCostUsd);
  const cap = finiteNumber(run?.maxBudgetUsdPerTurn);
  if (spent != null && spent > 0) {
    const capText = cap != null && cap > 0 ? ` / 上限 $${cap}` : "";
    return { id: "budget", label: "花费", value: `$${spent.toFixed(2)}${capText}` };
  }
  return null;
}

function projectLinks({ delta, replayEvents }) {
  const links = [{ ...VALUE_PROOF_TARGETS.evidence }];
  if (delta && delta.empty !== true) links.push({ ...VALUE_PROOF_TARGETS.delta });
  if (replayEvents > 0) links.push({ ...VALUE_PROOF_TARGETS.replay });
  return links;
}

/**
 * @param {{ run?: object, settlement?: object|null, events?: object[] }} input
 * settlement 未加载时不要把证据/DELTA 报成 0。
 */
export function projectValueProof({ run = null, settlement = null, events = null } = {}) {
  if (!isSucceededRun(run)) {
    return {
      schema: VALUE_PROOF_CARD,
      shown: false,
      runId: asText(run?.id) || null,
      summary: "",
      signals: [],
      links: [],
    };
  }
  const runId = asText(run.id);
  const matchedEvents = eventsForRun(events, runId);
  const route = projectRoute(run);
  const duration = projectDuration(run);
  const evidence = projectEvidence(settlement);
  const delta = projectDelta(settlement);
  const handoff = projectHandoff(run, settlement);
  const budget = projectBudget(run);
  const signals = [route, duration, evidence, delta, handoff, budget].filter(Boolean);
  const links = projectLinks({ delta, replayEvents: matchedEvents.length });
  const present = signals.filter((item) => item.empty !== true);
  let summary = "做完了。下面是这次能对上账的部分。";
  if (delta && delta.empty !== true) summary = "做完了。这次留下了可核对的 DELTA。";
  else if (evidence && evidence.empty !== true) summary = "做完了。证据在，可以点进去看。";
  else if (!settlement && present.length) summary = "做完了。结算还在整理时，先看已经记下的路线和用时。";
  else if (present.length === 0) summary = "做完了。这一轮还没有可对账的记录，就不编数字。";
  return {
    schema: VALUE_PROOF_CARD,
    shown: true,
    runId,
    summary,
    signals,
    links,
  };
}

export function valueProofCardMarkup(model, { surface = "bot", variant = "settlement" } = {}) {
  if (!model?.shown) return "";
  const isBot = surface !== "workbench";
  const cardClass = isBot
    ? `bot-card bot-value-proof-card is-${escapeHtml(variant)}`
    : `value-proof-card is-${escapeHtml(variant)}`;
  const signals = (model.signals || []).map((signal) => (
    `<span class="value-proof-chip${signal.empty ? " is-empty" : ""}" data-value-proof-signal="${escapeHtml(signal.id)}"><small>${escapeHtml(signal.label)}</small><b>${escapeHtml(signal.value)}</b></span>`
  )).join("");
  const links = (model.links || []).map((link) => (
    `<button class="${isBot ? "bot-text-button" : "text-button"}" type="button" data-value-proof-open="${escapeHtml(link.id)}" data-value-proof-dest="${escapeHtml(link.dest)}" data-run-id="${escapeHtml(model.runId || "")}">${escapeHtml(link.label)}</button>`
  )).join("");
  const heading = variant === "stream" ? "这次留下了什么" : "收获证明";
  return `<article class="${cardClass}" data-bot-card="value-proof" data-value-proof="1" data-value-proof-surface="${escapeHtml(surface)}" data-run-id="${escapeHtml(model.runId || "")}">
    <div class="${isBot ? "bot-card-head" : "value-proof-head"}">
      ${isBot ? `<span class="bot-card-icon"><svg aria-hidden="true" class="icon lucide"><use href="#lucide-shield-check"></use></svg></span>` : ""}
      <div><strong>${heading}</strong><span>${escapeHtml(model.summary)}</span></div>
    </div>
    ${signals ? `<div class="value-proof-signals">${signals}</div>` : ""}
    ${links ? `<div class="${isBot ? "bot-card-actions value-proof-actions" : "settlement-actions value-proof-actions"}">${links}</div>` : ""}
  </article>`;
}
