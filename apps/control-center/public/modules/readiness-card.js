/**
 * readiness-card.js — 首次就绪清单的产品投影。
 *
 * 数据来自 /api/readiness；本模块只负责把真实状态翻译成首屏可执行的下一步，
 * 不把“没有证据”渲染成已就绪，也不在客户端复制服务端判定逻辑。
 */

import { escapeHtml } from "../utils.js";

export const READINESS_STATUS_META = Object.freeze({
  ready: { label: "已完成", tone: "ok", icon: "check" },
  attention: { label: "需要确认", tone: "warning", icon: "circle-alert" },
  blocked: { label: "待处理", tone: "error", icon: "lock-keyhole" },
  gated: { label: "受门闸保护", tone: "neutral", icon: "shield" },
});

const STEP_ACTIONS = Object.freeze({
  "project-anchor": { label: "检查项目", action: "config:sources" },
  "default-team": { label: "打开团队", action: "team" },
  "executable-seat": { label: "配置席位", action: "config:sources" },
  "unpaid-validation": { label: "运行健康检查", action: "overview" },
  "capability-gate": { label: "查看门闸", action: "security" },
});

function safeStatus(value) {
  const key = String(value ?? "").trim().toLowerCase();
  return Object.hasOwn(READINESS_STATUS_META, key) ? key : "attention";
}

export function readinessViewModel(payload) {
  if (!payload || typeof payload !== "object") return { state: "loading", ready: false, steps: [], next: null };
  if (payload.error && !Array.isArray(payload.steps)) {
    return { state: "error", ready: false, steps: [], next: null, error: String(payload.error) };
  }
  const steps = (Array.isArray(payload.steps) ? payload.steps : []).map((step) => {
    const id = String(step?.id ?? "").trim();
    const status = safeStatus(step?.status);
    const action = STEP_ACTIONS[id] || null;
    return {
      id,
      status,
      title: String(step?.title ?? (id || "就绪检查")),
      detail: String(step?.detail ?? "").trim(),
      nextStep: String(step?.nextStep ?? "").trim(),
      action,
    };
  }).filter((step) => step.id);
  const next = steps.find((step) => step.status === "blocked")
    || steps.find((step) => step.status === "gated")
    || steps.find((step) => step.status === "attention")
    || null;
  return {
    state: "ready",
    ready: payload.ready === true,
    steps,
    next,
    nextAction: String(payload.nextAction?.text ?? "").trim(),
  };
}

function statusIcon(name) {
  return `<svg aria-hidden="true" class="icon lucide"><use href="#lucide-${escapeHtml(name)}"></use></svg>`;
}

export function readinessCardMarkup(payload, { compact = false } = {}) {
  const model = readinessViewModel(payload);
  if (model.state === "loading") {
    return `<section class="readiness-card is-loading" aria-label="首次就绪检查" aria-busy="true"><div class="readiness-card-head"><div><span class="readiness-kicker">首次就绪</span><h3>正在检查你的工作环境</h3></div></div><p class="readiness-card-copy">读取项目、团队和可执行席位的真实状态…</p></section>`;
  }
  if (model.state === "error") {
    return `<section class="readiness-card is-error" aria-label="首次就绪检查"><div class="readiness-card-head"><div><span class="readiness-kicker">首次就绪</span><h3>检查暂时不可用</h3></div><span class="readiness-status is-error">${statusIcon("circle-alert")}未确认</span></div><p class="readiness-card-copy">${escapeHtml(model.error || "服务端没有返回就绪状态")}。可以先打开健康页检查，完成后再回到这里。</p><button class="button secondary readiness-action" type="button" data-readiness-action="overview">打开健康页</button></section>`;
  }
  const completeCount = model.steps.filter((step) => step.status === "ready").length;
  const heading = model.ready ? "可以开始派工" : "完成这几步，再放心派工";
  const copy = model.ready
    ? "项目、团队、席位和一次非付费验证都已对上账。"
    : (model.next?.nextStep || model.nextAction || "先处理第一项待处理事项，系统会在这里更新");
  const rows = model.steps.map((step) => {
    const meta = READINESS_STATUS_META[step.status];
    const action = step.action;
    const actionButton = action && step.status !== "ready"
      ? `<button class="readiness-step-action" type="button" data-readiness-action="${escapeHtml(action.action)}">${escapeHtml(action.label)}</button>`
      : "";
    return `<li class="readiness-step is-${escapeHtml(meta.tone)}" data-readiness-step="${escapeHtml(step.id)}"><span class="readiness-step-icon">${statusIcon(meta.icon)}</span><div class="readiness-step-copy"><strong>${escapeHtml(step.title)}</strong><span>${escapeHtml(step.detail || "尚未提供说明")}</span>${step.nextStep && step.status !== "ready" ? `<small>${escapeHtml(step.nextStep)}</small>` : ""}</div><span class="readiness-step-state is-${escapeHtml(meta.tone)}">${escapeHtml(meta.label)}</span>${actionButton}</li>`;
  }).join("");
  return `<section class="readiness-card${compact ? " is-compact" : ""}${model.ready ? " is-ready" : ""}" aria-label="首次就绪检查" data-readiness-state="${model.ready ? "ready" : "pending"}">
    <div class="readiness-card-head"><div><span class="readiness-kicker">首次就绪 · ${completeCount}/${model.steps.length || 0}</span><h3>${escapeHtml(heading)}</h3></div><span class="readiness-status is-${model.ready ? "ok" : "warning"}">${statusIcon(model.ready ? "check-circle-2" : "list-check")} ${model.ready ? "已就绪" : "进行中"}</span></div>
    <p class="readiness-card-copy">${escapeHtml(copy)}</p>
    <ol class="readiness-steps">${rows || '<li class="readiness-step"><span class="readiness-step-copy"><strong>没有可显示的检查项</strong><span>服务端尚未返回就绪清单。</span></span></li>'}</ol>
  </section>`;
}
