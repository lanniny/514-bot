/**
 * bot-relay-board.js — 交接板（Grok Bot「handoff 在会话里可见」的 UI 落点）。
 *
 * 数据源：GET /api/bots/relay/<runId>（openHandoffs / acknowledgedHandoffs / handoffs）。
 * 挂在协作面板「任务」tab 尾部：开放交接（待确认）+ 已确认交接两段；
 * 接收方是当前成员时给「确认接手」按钮（POST /api/bots/relay/ack）。
 */

import { fetchRelayBoard, postRelayAck } from "./bot-collab-api.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shortTime(ts) {
  const parsed = Date.parse(String(ts ?? ""));
  if (!Number.isFinite(parsed)) return "";
  const date = new Date(parsed);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function handoffRow(item, { acked, currentMemberId }) {
  const stage = item.stage ? `<span class="bot-relay-stage">${escapeHtml(item.stage)}</span>` : "";
  const canAck = !acked && currentMemberId && item.to === currentMemberId;
  return `<li class="bot-relay-row${acked ? " is-acked" : ""}" data-handoff-id="${escapeHtml(item.handoffId)}">
    <span class="bot-relay-route"><strong>${escapeHtml(item.from)}</strong><svg aria-hidden="true" class="icon lucide"><use href="#lucide-arrow-right"></use></svg><strong>${escapeHtml(item.to)}</strong>${stage}</span>
    <p class="bot-relay-text">${escapeHtml(item.text)}</p>
    <span class="bot-relay-meta">
      <small>${escapeHtml(shortTime(item.ts))}</small>
      ${acked
        ? `<small class="bot-relay-acked">已由 ${escapeHtml(item.ack?.from ?? item.to)} 确认</small>`
        : canAck
          ? `<button class="bot-text-button" type="button" data-relay-ack="${escapeHtml(item.handoffId)}">确认接手</button>`
          : `<small class="bot-relay-open">待 ${escapeHtml(item.to)} 确认</small>`}
    </span>
  </li>`;
}

/**
 * 渲染交接板。
 * @param {object} options
 * @param {HTMLElement} options.container
 * @param {string|null} options.runId — 当前 run（无 run 时渲染空态）
 * @param {string|null} options.currentMemberId — 当前会话成员（决定谁能「确认接手」）
 * @param {(text: string, tone?: string) => void} options.toast
 */
export async function renderRelayBoard({ container, runId, currentMemberId = null, toast = () => {} }) {
  if (!container) return;
  if (!runId) {
    container.innerHTML = `<p class="bot-panel-empty">当前会话还没有运行——交接随运行产生</p>`;
    return;
  }
  container.innerHTML = `<p class="bot-panel-empty">正在读取交接…</p>`;
  let board;
  try {
    board = await fetchRelayBoard(runId);
  } catch (error) {
    container.innerHTML = `<p class="bot-panel-empty is-error">交接读取失败：${escapeHtml(error.message)}</p>`;
    return;
  }
  const open = Array.isArray(board?.openHandoffs) ? board.openHandoffs : [];
  const acked = Array.isArray(board?.acknowledgedHandoffs) ? board.acknowledgedHandoffs : [];
  if (!open.length && !acked.length) {
    container.innerHTML = `<p class="bot-panel-empty">本次运行暂无成员间交接</p>`;
    return;
  }
  container.innerHTML = `
    <div class="bot-relay-summary"><strong>${open.length}</strong> 条待确认 · <strong>${acked.length}</strong> 条已确认</div>
    ${open.length ? `<h4 class="bot-relay-heading">待确认交接</h4><ul class="bot-relay-list">${open.map((item) => handoffRow(item, { acked: false, currentMemberId })).join("")}</ul>` : ""}
    ${acked.length ? `<h4 class="bot-relay-heading">已确认</h4><ul class="bot-relay-list">${acked.map((item) => handoffRow(item, { acked: true, currentMemberId })).join("")}</ul>` : ""}
  `;
  container.querySelectorAll("[data-relay-ack]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await postRelayAck({ runId, from: currentMemberId, handoffId: button.dataset.relayAck });
        toast("已确认接手", "ok");
      } catch (error) {
        toast(`确认失败：${error.message}`, "error");
      } finally {
        await renderRelayBoard({ container, runId, currentMemberId, toast });
      }
    });
  });
}
