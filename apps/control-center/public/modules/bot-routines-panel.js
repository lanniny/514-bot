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
import { escapeHtml } from "../utils.js";

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

// 本成员的上次结果。右栏会被**按键级**重渲染（搜索框每次输入都会走到这里），
// 无缓存时每次都要闪一遍"正在读取" + 重发一次 /api/bots/routines——可见抖动 + 无谓流量。
// 缓存键是 memberId：换成员必须重取；本成员数据只由**显式 force**（增删改/启用暂停后）刷新。
let routinesCache = { memberId: "", routines: null };

// 上一次写进每个容器的 markup。内容没变就不碰 DOM——innerHTML 全量替换会连带重排、
// 并让容器内已绑的交互失效，高频重绘下这是实打实的浪费。
const lastMarkupByList = new WeakMap();

function paintMarkup(listEl, markup) {
  if (lastMarkupByList.get(listEl) === markup) return false;
  lastMarkupByList.set(listEl, markup);
  listEl.replaceChildren(document.createRange().createContextualFragment(markup));
  return true;
}

function routinesMarkup(memberId, routines) {
  return routines.length
    ? routines.map(routineRow).join("")
    : `<p class="bot-panel-empty">还没有例行任务——把重复性工作交给 ${escapeHtml(memberId)} 按节奏执行</p>`;
}

function paintRoutines(listEl, emptyEl, memberId, routines) {
  paintMarkup(listEl, routinesMarkup(memberId, routines));
  if (emptyEl) emptyEl.hidden = routines.length > 0;
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
export async function renderBotRoutines({ listEl, emptyEl = null, memberId, toast = () => {}, onTrack, force = false } = {}) {
  if (!listEl || !memberId) return;
  const cached = routinesCache.memberId === memberId ? routinesCache.routines : null;
  // 已有本成员数据且非显式刷新 → 直接复绘，**不闪加载态、不发请求**。
  if (cached && !force) {
    paintRoutines(listEl, emptyEl, memberId, cached);
    return;
  }
  // 手上没有该成员数据时才闪加载态；已有数据时静默刷新，不打断阅读。
  if (!cached) listEl.replaceChildren(document.createRange().createContextualFragment('<p class="bot-panel-empty">正在读取例行任务…</p>'));
  let routines;
  try {
    routines = await fetchRoutines(memberId);
  } catch (error) {
    paintMarkup(listEl, `<p class="bot-panel-empty is-error">例行任务读取失败：${escapeHtml(error.message)}</p>`);
    return;
  }
  routinesCache = { memberId, routines };
  paintRoutines(listEl, emptyEl, memberId, routines);

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
        // 变更类动作（启用/暂停/删除/测试）后必须**强制重取**：缓存里是变更前的快照，
        // 不 force 就会把刚改完的界面又画回旧状态。
        await renderBotRoutines({ listEl, emptyEl, memberId, toast, onTrack, force: true });
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

const ROUTINE_DIALOG_TITLE_BLANK = "新建例行";
const ROUTINE_DIALOG_TITLE_DISTILLED = "沉淀为例行任务";

/**
 * 把「从成功 Run 提炼出的工作流草稿」填进六要素表单。
 *
 * 只写表单**真的支持**的取值：schedule / noDataPolicy / owningMemberId 是固定枚举
 * select，草稿给了枚举外的值就留着不写，由用户自己选——悄悄塞一个提交必被后端拒的值，
 * 只会把失败推迟到点「创建」的那一刻。
 */
function applyRoutineDraft(dialog, draft) {
  if (!draft || typeof draft !== "object") return;
  const field = (name) => dialog.querySelector(`[data-routine-field='${name}']`);
  const setText = (name, value) => {
    if (value == null || value === "") return;
    const el = field(name);
    if (!el || el.tagName === "SELECT") return;
    el.value = String(value);
  };
  const setEnum = (name, value) => {
    if (!value) return;
    const el = field(name);
    if (!el || el.tagName !== "SELECT") return;
    if (![...el.options].some((option) => option.value === value)) return;
    el.value = String(value);
  };
  setText("title", draft.title);
  setText("instructions", draft.instructions);
  setText("expectedOutput", draft.expectedOutput);
  setText("approvalBoundary", draft.approvalBoundary);
  setText("inputSource", typeof draft.inputSource === "string" ? draft.inputSource : draft.inputSource?.value);
  setEnum("schedule", draft.schedule);
  setEnum("noDataPolicy", draft.noDataPolicy);
  setEnum("owningMemberId", draft.owningMemberId);
}

/**
 * 打开新建例行 dialog（刷新 owning 候选后 showModal）。
 * @param {HTMLDialogElement} dialog
 * @param {{draft?: object}} [options] 带 draft 即「从成功 Run 沉淀」路径：预填字段并改标题口径。
 */
export function openRoutineDialog(dialog, { draft = null } = {}) {
  if (!dialog) return;
  // 归属候选会整体重建 option，必须在预填之前刷新，否则预填的成员会被覆盖掉。
  dialog.__fillRoutineOwners?.();
  const titleEl = dialog.querySelector("#bot-routine-dialog-title");
  if (draft) {
    applyRoutineDraft(dialog, draft);
    if (titleEl) titleEl.textContent = ROUTINE_DIALOG_TITLE_DISTILLED;
  } else if (titleEl) {
    titleEl.textContent = ROUTINE_DIALOG_TITLE_BLANK;
  }
  dialog.returnValue = "";
  dialog.showModal();
}
