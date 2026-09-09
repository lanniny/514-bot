/**
 * private-skill-from-run.js — 从成功 run 派生 Private skill 草稿（G-5 / v48 P-05）。
 *
 * 只使用 run 上已有的目标与结果文本，不编造成果。缺字段保持空，由 UI 如实提示。
 * 字段上限对齐 bots/private-skills.mjs PRIVATE_SKILL_LIMITS。
 */

export const SUCCESS_RUN_STATES = Object.freeze(["complete", "completed", "succeeded"]);

export const PRIVATE_SKILL_DRAFT_LIMITS = Object.freeze({
  nameMax: 80,
  descriptionMax: 200,
  instructionsMax: 4_000,
});

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function clip(text, max) {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function shortRunId(runId) {
  const id = String(runId || "").trim();
  return id.length > 12 ? id.slice(0, 8) : id;
}

export function isSucceededRun(run) {
  return Boolean(run?.id) && SUCCESS_RUN_STATES.includes(String(run.status || ""));
}

export function extractRunGoal(run) {
  return firstNonEmpty(run?.prompt, run?.title);
}

export function extractRunOutcome(run) {
  const result = run?.result && typeof run.result === "object" && !Array.isArray(run.result)
    ? run.result
    : null;
  const fromResult = result
    ? firstNonEmpty(result.final, result.verified, result.specialist, result.plan, result.continued)
    : "";
  if (fromResult) return fromResult;
  const turns = Array.isArray(run?.turns) ? run.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const text = String(turns[index]?.text || "").trim();
    if (text) return text;
  }
  return "";
}

function buildInstructions({ goal, outcome, runId }) {
  const parts = [];
  if (goal) {
    parts.push("Goal", goal);
  } else {
    parts.push("Goal", "(this run has no captured goal text)");
  }
  parts.push("");
  if (outcome) {
    parts.push("Useful outcome", outcome);
  } else {
    parts.push("Useful outcome", "(this run has no captured outcome text — edit before saving)");
  }
  if (runId) {
    parts.push("", `Source run: ${runId}`);
  }
  return clip(parts.join("\n"), PRIVATE_SKILL_DRAFT_LIMITS.instructionsMax);
}

/**
 * 从成功 run 派生可编辑草稿。失败/进行中的 run 返回 null。
 * missingGoal / missingOutcome 为真时 UI 必须展示诚实空态，不得补假文案。
 */
export function draftPrivateSkillFromRun(run) {
  if (!isSucceededRun(run)) return null;
  const goal = extractRunGoal(run);
  const outcome = extractRunOutcome(run);
  const headline = firstLine(goal);
  const name = clip(headline, PRIVATE_SKILL_DRAFT_LIMITS.nameMax);
  const description = clip(
    headline ? `From succeeded run ${shortRunId(run.id)}: ${headline}` : "",
    PRIVATE_SKILL_DRAFT_LIMITS.descriptionMax,
  );
  return {
    sourceRunId: String(run.id),
    name,
    description,
    instructions: buildInstructions({ goal, outcome, runId: run.id }),
    missingGoal: !goal,
    missingOutcome: !outcome,
    ready: Boolean(name && description),
  };
}

export function saveSkillActionMarkup(runId, { className = "bot-text-button", label = "存为 Private skill" } = {}) {
  const id = String(runId || "").trim();
  if (!id) return "";
  const safeId = id.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const safeClass = String(className || "bot-text-button").replaceAll('"', "");
  const safeLabel = String(label || "存为 Private skill")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<button class="${safeClass}" type="button" data-save-private-skill="${safeId}">${safeLabel}</button>`;
}
