/**
 * bot-routines-panel.js — 右栏「Routines」区真实化（Grok Bot 对标）。
 *
 * 替换 v43 切片的硬编码假数据（"每周工作台巡检"/"收件箱摘要"）：
 * 列表 = GET /api/bots/routines?owning=<memberId>；
 * toggle = enable/pause（automation 桥接失败时如实报错并回滚开关态）；
 * 新建 = 六要素表单（Grok "Confirm:" 清单的表单化）；
 * test = plan-only 计划预览（真实试跑走 enable 后的 automation，诚实边界）。
 */

import {
  fetchRoutines,
  createRoutine,
  deleteRoutine,
  testRoutine,
  enableRoutine,
  pauseRoutine,
} from "./bot-collab-api.js";

const DAY_LABELS = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** schedule 语法 → 人话（automations 语法：manual / every:Nmhd / at:HH:MM@1-7）。 */
export function describeSchedule(schedule) {
  if (!schedule || schedule === "manual") return "手动触发";
  const every = /^every:(\d{1,4})([mhd])$/.exec(schedule);
  if (every) {
    const unit = { m: "分钟", h: "小时", d: "天" }[every[2]];
    return `每 ${every[1]} ${unit}`;
  }
  const at = /^at:(\d{2}):(\d{2})(?:@([1-7](?:,[1-7])*))?$/.exec(schedule);
  if (at) {
    const time = `${at[1]}:${at[2]}`;
    if (!at[3]) return `每天 ${time}`;
    const days = at[3].split(",").map((day) => DAY_LABELS[Number(day)] || day).join("/");
    return `${days} ${time}`;
  }
  return schedule;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function routineHistoryMarkup(routine) {
  const history = Array.isArray(routine.runHistory) ? routine.runHistory.slice(-3).reverse() : [];
  if (!history.length) return "";
  const statusLabel = { triggered: "已触发", succeeded: "成功", failed: "失败" };
  const rows = history.map((entry) => `<li><span class="bot-routine-history-status is-${escapeHtml(entry.status || "unknown")}">${escapeHtml(statusLabel[entry.status] || entry.status || "未知")}</span><time>${escapeHtml(String(entry.at || "").replace("T", " ").slice(5, 16))}</time></li>`).join("");
  return `<ul class="bot-routine-history" aria-label="最近运行">${rows}</ul>`;
}

function routineRow(routine) {
  const enabled = routine.enabled === true;
  const bridge = routine.automationRef ? "已接调度" : "未接调度";
  const lastTest = routine.testRun?.lastTestAt ? ` · 测试 ${routine.testRun.lastTestAt.slice(0, 10)}` : "";
  return `<div class="bot-routine-row" data-routine-id="${escapeHtml(routine.id)}">
  <span class="bot-routine-icon"><svg aria-hidden="true" class="icon lucide"><use href="#lucide-timer"></use></svg></span>
  <div class="bot-routine-copy">
    <strong>${escapeHtml(routine.title)}</strong>
    <small>${escapeHtml(describeSchedule(routine.schedule))} · ${escapeHtml(routine.expectedOutput)} · ${bridge}${escapeHtml(lastTest)}</small>
    ${routineHistoryMarkup(routine)}
  </div>
  <span class="bot-routine-actions">
    <button class="bot-icon-button" type="button" title="测试运行（计划预览，不真实执行）" aria-label="测试运行 ${escapeHtml(routine.title)}" data-routine-action="test"><svg aria-hidden="true" class="icon lucide"><use href="#lucide-flask-conical"></use></svg></button>
    <button class="bot-icon-button" type="button" title="删除例行（联动删除调度，不可撤销）" aria-label="删除 ${escapeHtml(routine.title)}" data-routine-action="delete"><svg aria-hidden="true" class="icon lucide"><use href="#lucide-trash-2"></use></svg></button>
    <button class="bot-toggle${enabled ? " is-on" : ""}" type="button" aria-label="${enabled ? "已启用" : "未启用"}" aria-pressed="${enabled}" data-routine-action="toggle"></button>
  </span>
</div>`;
}

/**
 * 渲染某个成员的 Routines 区。
 * @param {object} options
 * @param {HTMLElement} options.listEl — 行容器
 * @param {HTMLElement|null} options.emptyEl — 空态元素（可空，缺省用 listEl 内置空态）
 * @param {string} options.memberId — owning Bot
 * @param {(text: string, tone?: string) => void} options.toast
 * @param {(capability: string, fields?: object) => void} [options.onTrack]
 */
export async function renderBotRoutines({ listEl, emptyEl = null, memberId, toast = () => {}, onTrack } = {}) {
  if (!listEl || !memberId) return;
  listEl.innerHTML = `<p class="bot-panel-empty">正在读取例行任务…</p>`;
  let routines;
  try {
    routines = await fetchRoutines(memberId);
  } catch (error) {
    listEl.innerHTML = `<p class="bot-panel-empty is-error">例行任务读取失败：${escapeHtml(error.message)}</p>`;
    return;
  }
  if (!routines.length) {
    listEl.innerHTML = `<p class="bot-panel-empty">还没有例行任务——把重复性工作交给 ${escapeHtml(memberId)} 按节奏执行</p>`;
  } else {
    listEl.innerHTML = routines.map(routineRow).join("");
  }
  if (emptyEl) emptyEl.hidden = routines.length > 0;

  listEl.querySelectorAll("[data-routine-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest("[data-routine-id]");
      const id = row?.dataset.routineId;
      const action = button.dataset.routineAction;
      if (!id || button.disabled) return;
      button.disabled = true;
      try {
        if (action === "toggle") {
          const routine = routines.find((item) => item.id === id);
          const turningOn = routine?.enabled !== true;
          try {
            if (turningOn) {
              await enableRoutine(id);
              onTrack?.("routine.enable", { outcome: "success" });
            } else {
              await pauseRoutine(id);
            }
            toast(turningOn ? "例行已启用（已接调度器）" : "例行已暂停", "ok");
          } catch (error) {
            // enable 桥接失败（503）如实告知：不留下「看起来在跑」的假状态
            toast(`例行${turningOn ? "启用" : "暂停"}失败：${error.message}`, "error");
          }
        } else if (action === "test") {
          const result = await testRoutine(id);
          const preview = String(result?.plan?.promptPreview ?? "").slice(0, 200);
          toast(`测试完成为计划预览（不真实执行）：${preview}${preview.length >= 200 ? "…" : ""}`, "neutral");
        } else if (action === "delete") {
          await deleteRoutine(id);
          toast("例行已删除（调度已联动移除）", "ok");
        }
      } catch (error) {
        toast(`操作失败：${error.message}`, "error");
      } finally {
        button.disabled = false;
        await renderBotRoutines({ listEl, emptyEl, memberId, toast, onTrack });
      }
    });
  });
}

/**
 * 绑定「新建例行」dialog（六要素表单）。
 * @param {object} options
 * @param {HTMLDialogElement} options.dialog
 * @param {() => string} options.defaultOwningMemberId — 打开时的默认 owning Bot（当前会话成员）
 * @param {() => Array<{id: string, label: string}>} options.memberOptions — owning Bot 候选（roster）
 * @param {() => Promise<void>} options.onSaved — 保存成功后的列表刷新
 * @param {(text: string, tone?: string) => void} options.toast
 * @param {(capability: string, fields?: object) => void} [options.onTrack]
 */
export function bindRoutineDialog({ dialog, defaultOwningMemberId, memberOptions, onSaved, toast = () => {}, onTrack } = {}) {
  if (!dialog) return;
  const form = dialog.querySelector("form");
  const owningSelect = dialog.querySelector("[data-routine-field='owningMemberId']");
  const errorEl = dialog.querySelector("[data-routine-error]");

  const fillOwners = () => {
    if (!owningSelect) return;
    const options = memberOptions() ?? [];
    const current = defaultOwningMemberId();
    owningSelect.innerHTML = options
      .map((member) => `<option value="${escapeHtml(member.id)}"${member.id === current ? " selected" : ""}>${escapeHtml(member.label || member.id)}</option>`)
      .join("");
  };

  dialog.addEventListener("close", () => {
    if (dialog.returnValue !== "saved") form?.reset();
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (errorEl) {
      errorEl.hidden = true;
      errorEl.textContent = "";
    }
    const field = (name) => String(dialog.querySelector(`[data-routine-field='${name}']`)?.value ?? "").trim();
    const input = {
      owningMemberId: field("owningMemberId"),
      title: field("title"),
      instructions: field("instructions"),
      schedule: field("schedule"),
      expectedOutput: field("expectedOutput"),
      approvalBoundary: field("approvalBoundary"),
      noDataPolicy: field("noDataPolicy") || "report-failure",
      inputSource: { kind: "prompt", value: field("inputSource") },
    };
    const submit = form.querySelector("[type='submit']");
    if (submit) submit.disabled = true;
    try {
      await createRoutine(input);
      onTrack?.("routine.create", { outcome: "success" });
      toast("例行任务已创建（先测试再启用）", "ok");
      dialog.returnValue = "saved";
      dialog.close();
      form.reset();
      await onSaved();
    } catch (error) {
      if (errorEl) {
        errorEl.hidden = false;
        errorEl.textContent = error.message;
      } else {
        toast(`创建失败：${error.message}`, "error");
      }
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  // 打开前刷新 owning 候选（绑定方负责调 dialog.showModal()）
  dialog.dataset.routineDialogBound = "1";
  dialog.__fillRoutineOwners = fillOwners;
}

/** 打开新建例行 dialog（刷新 owning 候选后 showModal）。 */
export function openRoutineDialog(dialog) {
  if (!dialog) return;
  dialog.__fillRoutineOwners?.();
  dialog.returnValue = "";
  dialog.showModal();
}
