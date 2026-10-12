/**
 * residence-recovery.js — 关机/异常退出后的恢复提示条（A5 会话驻留）。
 *
 * 与 modules/resume-hints.js **不是一回事**：那份是"异构 CLI 的原生 resume 命令"
 * （claude -r / codex resume…），本份是"上次关机时还没收尾的 Run / 检查点"。
 *
 * 口径纪律（2026-09-18）：服务端 `claimRecoveryHint` 只做两件事——把提示标为已认领、
 * 把 activeConversationId 切回原会话。它**不重跑任何东西**（submitted/ambiguous 的 run
 * 自动重放是被明令禁止的）。所以这里的文案只能是"回到会话"，绝不能写"恢复执行/继续任务"，
 * 否则用户会以为按一下就把任务续上了。
 */

export const RESIDENCE_HINT_LABELS = Object.freeze({
  interrupted_run: "任务未完成",
  unsettled_checkpoint: "研究阶段未收尾",
});

export function residenceRecoveryMarkup(hints, { escapeHtml }) {
  const list = (Array.isArray(hints) ? hints : [])
    .filter((hint) => hint && hint.id && hint.status !== "dismissed" && hint.status !== "resumed");
  if (!list.length) return "";

  const rows = list.map((hint) => {
    const id = escapeHtml(String(hint.id));
    const kind = RESIDENCE_HINT_LABELS[hint.type] || "未收尾";
    const phase = hint.interruptedPhase
      ? `<span class="bot-residence-hint-phase">停在 ${escapeHtml(String(hint.interruptedPhase))}</span>`
      : "";
    // 没有 conversationId 时「回到会话」不可达——置灰而不是留一个点了没反应的按钮
    const canOpen = Boolean(hint.conversationId);
    return `<li class="bot-residence-hint" data-bot-residence-hint-item="${id}">
      <span class="bot-residence-hint-kind">${escapeHtml(kind)}</span>
      <span class="bot-residence-hint-copy">
        <strong>${escapeHtml(String(hint.title || "上次会话没有正常结束"))}</strong>
        <small>${escapeHtml(String(hint.description || ""))}${phase}</small>
      </span>
      <span class="bot-residence-hint-actions">
        <button class="bot-text-button" type="button" data-bot-residence-open="${id}"${canOpen ? "" : " disabled title=\"该提示没有可回到的会话\""}>回到会话</button>
        <button class="bot-text-button" type="button" data-bot-residence-dismiss="${id}">忽略</button>
      </span>
    </li>`;
  }).join("");

  return `<div class="bot-residence-inner">
    <header class="bot-residence-head">
      <strong>上次没有正常退出</strong>
      <span class="bot-residence-note">回到会话只是导航——上一步不会自动重跑</span>
    </header>
    <ul class="bot-residence-list">${rows}</ul>
  </div>`;
}
