/**
 * ccline 式状态条渲染（Wave B extraction, 2026-09-01）。
 * 从 app.js "ccline 式状态条" 段抽取：模型 · 目录 · 用量 · 团队 · 权限 · 工作树 · 偏好锁。
 * 纯展示层——所有数据通过依赖注入获取，不直接访问 app.js 全局。
 */

import { escapeHtml } from "../utils.js";

export function createStatusline({
  getBar,
  getModelInput,
  getPermissionInput,
  getSelectedRun,
  getPendingCwd,
  getProjectPrefsStatus,
  getProjectPrefsError,
  getProjectPrefsPendingSave,
  getCurrentTeam,
  getTeamPulseMembers,
  lucideIcon,
  renderTeamPulse,
}) {
  return function renderStatusline() {
    const bar = getBar();
    if (!bar) return;
    const run = getSelectedRun();
    const lastTurn = run?.turns?.length ? run.turns[run.turns.length - 1] : null;
    const model = lastTurn?.effectiveModel || run?.modelOverride || getModelInput()?.value || "fable";
    const modelShort = String(model).replace(/^claude-/, "").replace(/-\d{8}$/, "");
    const cwd = run?.cwd || getPendingCwd() || "I:\\514claude\\514cc";
    const cwdShort = String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd;
    const totalTokens = (run?.turns || []).reduce((sum, turn) => sum + (Number(turn.tokens) || 0), 0);
    const totalCost = Number(run?.costUsdTotal) || (run?.turns || []).reduce((sum, turn) => sum + (Number(turn.costUsd) || 0), 0);
    const tokensText = totalTokens
      ? `${((totalTokens / 200000) * 100).toFixed(1)}% · ${(totalTokens / 1000).toFixed(1)}k tokens${totalCost ? ` · $${totalCost.toFixed(2)}` : ""}`
      : "0 tokens";
    const team = getCurrentTeam();
    const memberCount = team?.members?.length || getTeamPulseMembers().length;
    const permission = run?.permissionMode || getPermissionInput()?.value || "plan";
    const seg = (icon, text, cls = "") =>
      `<span class="sl-seg${cls}"><span class="sl-icon">${lucideIcon(icon)}</span><span class="sl-text">${escapeHtml(text)}</span></span>`;
    const segments = [
      seg("cpu", modelShort, " sl-seg-model"),
      seg("folder", cwdShort),
      `<span class="sl-seg sl-seg-tokens"><span class="sl-icon">${lucideIcon("gauge")}</span><span class="sl-text sl-dim">${escapeHtml(tokensText)}</span></span>`,
      seg("users", `${team?.name ?? "514cc"} · ${memberCount} CLI`, " sl-seg-team"),
      seg("shield", permission, " sl-seg-perm"),
    ];
    if (run?.worktreePath) {
      segments.push(seg("git-branch", String(run.worktreePath).split(/[\\/]/).pop(), " sl-seg-worktree"));
    }
    const prefsStatus = getProjectPrefsStatus();
    if (prefsStatus === "loading") {
      segments.push(`<span class="sl-seg" data-project-prefs-lock><span class="sl-icon">${lucideIcon("refresh-cw")}</span><span class="sl-text">偏好读取中</span></span>`);
    } else if (prefsStatus === "error") {
      const pending = getProjectPrefsPendingSave();
      segments.push(`<span class="sl-seg" data-project-prefs-lock><span class="sl-icon">${lucideIcon("shield")}</span><span class="sl-text">${pending ? "偏好写入锁定 · 本地修改待重试" : "偏好写入锁定"}</span></span>`);
    }
    bar.innerHTML = segments.join("");
    bar.dataset.projectPrefsStatus = prefsStatus;
    bar.title = [
      `模型 ${model} · 地址 ${cwd} · 团队 ${team?.name ?? "514cc"} · 权限 ${permission}`,
      run?.worktreePath ? `工作树 ${run.worktreePath}` : "",
      prefsStatus === "error" ? `项目偏好写入锁定：${getProjectPrefsError() || "权威状态不可用"}` : "",
    ].filter(Boolean).join("\n");
    renderTeamPulse();
  };
}
