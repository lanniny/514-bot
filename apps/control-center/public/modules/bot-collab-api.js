/**
 * bot-collab-api.js — /api/bots 协作体系客户端封装（Grok Bot 对标语义层的前端入口）。
 *
 * 后端面：src/bots/routes.mjs（profiles / relay / routines）。
 * 约定：404 一律折叠为 null（profile/routine 不存在是常态——成员未建 profile 时用草稿态），
 * 其余错误原样上抛（调用方 toast 展示 message）。
 */

import { request } from "../api.js";

function isNotFound(error) {
  return error?.status === 404 || error?.payload?.code === "PROFILE_NOT_FOUND" || error?.payload?.code === "ROUTINE_NOT_FOUND";
}

export async function fetchBots({ signal } = {}) {
  const payload = await request("/api/bots", { signal });
  return Array.isArray(payload?.bots) ? payload.bots : [];
}

export async function fetchBotProfile(memberId, { signal } = {}) {
  try {
    const payload = await request(`/api/bots/${encodeURIComponent(memberId)}`, { signal });
    return payload?.bot ?? null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function saveBotProfile(memberId, profile) {
  const payload = await request(`/api/bots/${encodeURIComponent(memberId)}`, {
    method: "PUT",
    body: profile,
  });
  return payload?.bot ?? null;
}

export async function deleteBotProfile(memberId) {
  try {
    await request(`/api/bots/${encodeURIComponent(memberId)}`, { method: "DELETE" });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function fetchBotProtocol({ signal } = {}) {
  return request("/api/bots/protocol", { signal });
}

export async function fetchRoutines(owningMemberId = null, { signal } = {}) {
  const query = owningMemberId ? `?owning=${encodeURIComponent(owningMemberId)}` : "";
  const payload = await request(`/api/bots/routines${query}`, { signal });
  return Array.isArray(payload?.routines) ? payload.routines : [];
}

export async function fetchRoutine(id, { signal } = {}) {
  try {
    const payload = await request(`/api/bots/routines/${encodeURIComponent(id)}`, { signal });
    return payload?.routine ?? null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function createRoutine(input) {
  const payload = await request("/api/bots/routines", { method: "POST", body: input });
  return payload?.routine ?? null;
}

export async function updateRoutine(id, patch) {
  const payload = await request(`/api/bots/routines/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: patch,
  });
  return payload?.routine ?? null;
}

export async function deleteRoutine(id) {
  await request(`/api/bots/routines/${encodeURIComponent(id)}`, { method: "DELETE" });
  return true;
}

export async function testRoutine(id) {
  return request(`/api/bots/routines/${encodeURIComponent(id)}/test`, { method: "POST", body: {} });
}

export async function enableRoutine(id) {
  const payload = await request(`/api/bots/routines/${encodeURIComponent(id)}/enable`, { method: "POST", body: {} });
  return payload?.routine ?? null;
}

export async function pauseRoutine(id) {
  const payload = await request(`/api/bots/routines/${encodeURIComponent(id)}/pause`, { method: "POST", body: {} });
  return payload?.routine ?? null;
}

export async function fetchRelayBoard(runId, { signal } = {}) {
  try {
    return await request(`/api/bots/relay/${encodeURIComponent(runId)}`, { signal });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function postRelayKickoff({ runId, from = "lo", text, strictStages = false }) {
  return request("/api/bots/relay/kickoff", {
    method: "POST",
    body: { runId, from, text, strictStages },
  });
}

export async function postRelayHandoff({ runId, from, to, stage = null, text }) {
  return request("/api/bots/relay/handoff", {
    method: "POST",
    body: { runId, from, to, stage, text },
  });
}

export async function postRelayAck({ runId, from, handoffId }) {
  return request("/api/bots/relay/ack", {
    method: "POST",
    body: { runId, from, handoffId },
  });
}
