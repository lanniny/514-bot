/**
 * bot-profile-editor.js — 成员设置面板的「协作职责定义」区（Grok Bot 对标 profiles 层）。
 *
 * Grok Bot 的 Bot = durable teammate：job（Owns 什么结果）+ description（持久规则）+ 审批边界。
 * 本模块把这套定义挂进既有成员设置表单：
 *   load  — GET /api/bots/<memberId>（404 = 尚未定义，显示草稿态，不算错误）；
 *   save  — 成员保存成功后 PUT profile（创建模式拿到新 id 后再写）；
 *   清空  — 全空提交 = DELETE profile（回到「未定义」草稿态）。
 */

import { fetchBotProfile, saveBotProfile, deleteBotProfile } from "./bot-collab-api.js";

const FIELD_IDS = Object.freeze({
  handle: "bot-profile-handle",
  owns: "bot-profile-owns",
  goals: "bot-profile-goals",
  standingRules: "bot-profile-rules",
  requireApproval: "bot-profile-require-approval",
  neverAllowed: "bot-profile-never-allowed",
  skills: "bot-profile-skills",
  routineQuota: "bot-profile-routine-quota",
  status: "bot-profile-status",
});

function byId(id) {
  return document.getElementById(id);
}

function setFieldValue(id, value) {
  const control = byId(id);
  if (control) control.value = value;
}

function getFieldValue(id) {
  return String(byId(id)?.value ?? "").trim();
}

function linesToList(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function listToLines(list) {
  return Array.isArray(list) ? list.join("\n") : "";
}

function setStatus(text, tone = "neutral") {
  const el = byId(FIELD_IDS.status);
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

/** 表单是否全空（用于「清空 = 删除 profile」语义）。 */
function profileSectionIsEmpty() {
  return !getFieldValue(FIELD_IDS.owns)
    && !getFieldValue(FIELD_IDS.goals)
    && !getFieldValue(FIELD_IDS.standingRules)
    && !getFieldValue(FIELD_IDS.requireApproval)
    && !getFieldValue(FIELD_IDS.neverAllowed)
    && !getFieldValue(FIELD_IDS.skills);
}

/** 从表单收集 profile payload（供 PUT）。 */
export function collectBotProfileSection() {
  const handleRaw = getFieldValue(FIELD_IDS.handle);
  const handle = handleRaw ? (handleRaw.startsWith("@") ? handleRaw : `@${handleRaw}`) : undefined;
  const quotaText = getFieldValue(FIELD_IDS.routineQuota);
  const payload = {
    job: {
      owns: getFieldValue(FIELD_IDS.owns),
      goals: linesToList(getFieldValue(FIELD_IDS.goals)),
    },
    standingRules: linesToList(getFieldValue(FIELD_IDS.standingRules)),
    approvalBoundary: {
      requireApproval: linesToList(getFieldValue(FIELD_IDS.requireApproval)),
      neverAllowed: linesToList(getFieldValue(FIELD_IDS.neverAllowed)),
    },
    skills: getFieldValue(FIELD_IDS.skills)
      ? getFieldValue(FIELD_IDS.skills).split(/[，,]/).map((item) => item.trim()).filter(Boolean)
      : [],
  };
  if (handle) payload.handle = handle;
  if (quotaText) {
    const quota = Number(quotaText);
    if (Number.isSafeInteger(quota)) payload.routineQuota = quota;
  }
  return payload;
}

/**
 * 打开成员设置时填充协作职责区。
 * @param {string|null} memberId — 编辑模式成员 id；创建模式传 null（空白草稿）
 */
export async function loadBotProfileSection(memberId) {
  const section = byId("bot-profile-section");
  if (!section) return;
  if (!memberId) {
    ["handle", "owns", "goals", "standingRules", "requireApproval", "neverAllowed", "skills", "routineQuota"]
      .forEach((key) => setFieldValue(FIELD_IDS[key], ""));
    setStatus("创建成员后可补充协作职责（保存时一并写入）", "neutral");
    return;
  }
  setStatus("正在读取协作职责…", "busy");
  let profile = null;
  try {
    profile = await fetchBotProfile(memberId);
  } catch (error) {
    setStatus(`协作职责读取失败：${error.message}`, "error");
    return;
  }
  if (!profile) {
    ["handle", "owns", "goals", "standingRules", "requireApproval", "neverAllowed", "skills", "routineQuota"]
      .forEach((key) => setFieldValue(FIELD_IDS[key], ""));
    setStatus("尚未定义协作职责——保存后将创建 Grok 式 Bot 定义", "neutral");
    return;
  }
  setFieldValue(FIELD_IDS.handle, profile.handle ?? "");
  setFieldValue(FIELD_IDS.owns, profile.job?.owns ?? "");
  setFieldValue(FIELD_IDS.goals, listToLines(profile.job?.goals));
  setFieldValue(FIELD_IDS.standingRules, listToLines(profile.standingRules));
  setFieldValue(FIELD_IDS.requireApproval, listToLines(profile.approvalBoundary?.requireApproval));
  setFieldValue(FIELD_IDS.neverAllowed, listToLines(profile.approvalBoundary?.neverAllowed));
  setFieldValue(FIELD_IDS.skills, Array.isArray(profile.skills) ? profile.skills.join(", ") : "");
  setFieldValue(FIELD_IDS.routineQuota, profile.routineQuota != null ? String(profile.routineQuota) : "");
  setStatus(`已读取协作职责（更新于 ${String(profile.updatedAt ?? "").slice(0, 10)}）`, "ok");
}

/**
 * 成员保存成功后写入 profile。
 * @param {string} memberId
 * @returns {Promise<"saved"|"deleted"|"skipped">}
 */
export async function saveBotProfileSection(memberId) {
  if (!byId("bot-profile-section") || !memberId) return "skipped";
  if (profileSectionIsEmpty()) {
    const removed = await deleteBotProfile(memberId);
    if (removed) {
      setStatus("协作职责已清空（回到未定义草稿态）", "ok");
      return "deleted";
    }
    return "skipped";
  }
  const payload = collectBotProfileSection();
  await saveBotProfile(memberId, payload);
  setStatus("协作职责已保存", "ok");
  return "saved";
}

/** 表单脏检查状态联动（有未保存修改时提示）。 */
export function markBotProfileDirty() {
  if (!byId("bot-profile-section")) return;
  setStatus("协作职责有未保存修改", "warning");
}
