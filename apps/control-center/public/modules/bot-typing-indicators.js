/**
 * bot-typing-indicators.js — 群聊成员级打字/执行指示（Grok 对标 W7）。
 *
 * 不另开实时总线：只投影既有 run / turnAttempts / inflightTurns / taskGraph。
 * 会话级 fallback 仅用于 direct；workspace_group 必须落到具体成员，不能用「当前选中席位」冒充。
 */

import { escapeHtml } from "../utils.js";

export const TYPING_RUN_STATES = new Set([
  "queued", "planning", "running", "executing", "integrating", "verifying", "active",
]);

export const WAITING_RUN_STATES = new Set([
  "waiting_approval", "waiting_for_approval", "waiting_agent", "waiting_input", "waiting", "recovery_required",
]);

export const INCOMPLETE_ATTEMPT_PHASES = new Set([
  "prepared", "session_ready", "submitting", "submitted", "ambiguous",
]);

export const RUNNING_TASK_STATES = new Set([
  "queued", "pending", "running", "executing",
]);

function normalizeStatus(value) {
  return String(value || "").toLowerCase().replaceAll("-", "_");
}

function memberId(value) {
  return String(value || "").trim();
}

function uniqueIds(ids, roster = null) {
  const seen = new Set();
  const out = [];
  for (const raw of ids) {
    const id = memberId(raw);
    if (!id || seen.has(id)) continue;
    if (roster && roster.size && !roster.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function botRunIsTypingActive(run) {
  if (!run || run.pendingAsk) return false;
  const status = normalizeStatus(run.status);
  if (!status || WAITING_RUN_STATES.has(status)) return false;
  return TYPING_RUN_STATES.has(status);
}

function conversationKind(run, conversation) {
  return String(conversation?.kind || run?.conversationKind || "direct");
}

function liveMemberSignals(run) {
  const inflight = Object.keys(run?.inflightTurns && typeof run.inflightTurns === "object" ? run.inflightTurns : {});
  const attempts = Array.isArray(run?.turnAttempts) ? run.turnAttempts : [];
  const fromAttempts = attempts
    .filter((attempt) => INCOMPLETE_ATTEMPT_PHASES.has(String(attempt?.phase || "")))
    .map((attempt) => attempt.agentId);
  const tasks = Array.isArray(run?.taskGraph?.tasks) ? run.taskGraph.tasks : [];
  const fromTasks = tasks
    .filter((task) => RUNNING_TASK_STATES.has(normalizeStatus(task?.status)) && task?.assigneeId)
    .map((task) => task.assigneeId);
  return [...inflight, ...fromAttempts, ...fromTasks];
}

/**
 * 当前正在输入/执行的成员 id 列表（稳定去重，群聊按会话花名册约束）。
 * @param {object|null} run
 * @param {{ conversation?: object|null, fallbackMemberId?: string }} [options]
 */
export function botTypingMembers(run, { conversation = null, fallbackMemberId = "" } = {}) {
  if (!botRunIsTypingActive(run)) return [];
  const kind = conversationKind(run, conversation);
  const roster = new Set((conversation?.memberIds || []).map(memberId).filter(Boolean));
  const live = uniqueIds(liveMemberSignals(run), roster.size ? roster : null);
  if (live.length) return live;
  if (kind === "workspace_group") {
    return uniqueIds([run.executionOwnerId, run.startAgentId], roster.size ? roster : null);
  }
  return uniqueIds([conversation?.directMemberId, fallbackMemberId, run.startAgentId], roster.size ? roster : null);
}

export function botTypingMemberPhase(run, memberIdValue) {
  const id = memberId(memberIdValue);
  if (!id) return "typing";
  const inflight = run?.inflightTurns && typeof run.inflightTurns === "object" ? run.inflightTurns[id] : null;
  const attempts = Array.isArray(run?.turnAttempts) ? run.turnAttempts : [];
  const attempt = [...attempts].reverse().find((item) => memberId(item?.agentId) === id && INCOMPLETE_ATTEMPT_PHASES.has(String(item?.phase || "")));
  const tasks = Array.isArray(run?.taskGraph?.tasks) ? run.taskGraph.tasks : [];
  const task = tasks.find((item) => memberId(item?.assigneeId) === id && RUNNING_TASK_STATES.has(normalizeStatus(item?.status)));
  if (inflight || ["submitted", "submitting"].includes(String(attempt?.phase || "")) || normalizeStatus(task?.status) === "running") {
    return "running";
  }
  return "typing";
}

function phaseVerb(phase) {
  return phase === "running" ? "正在执行" : "正在输入";
}

/**
 * Grok 式三球气泡。群聊带成员名；单聊保持匿名三球（身份在头像上）。
 */
export function botTypingMarkup({
  members = [],
  run = null,
  conversation = null,
  avatarHtml = () => "",
  labelFor = (id) => id,
} = {}) {
  if (!Array.isArray(members) || !members.length) return "";
  const isGroup = conversationKind(run, conversation) === "workspace_group";
  return members.map((id) => {
    const phase = botTypingMemberPhase(run, id);
    const label = String(labelFor(id) || id);
    const verb = phaseVerb(phase);
    const name = isGroup ? `<span class="bot-typing-name">${escapeHtml(label)}</span>` : "";
    return `<div class="bot-message bot-message-agent" data-bot-typing="1" data-bot-typing-member="${escapeHtml(id)}" data-bot-typing-phase="${escapeHtml(phase)}">${avatarHtml(id)}<div><div class="bot-bubble bot-typing" role="status" aria-label="${escapeHtml(`${label} ${verb}`)}">${name}<i></i><i></i><i></i></div></div></div>`;
  }).join("");
}
