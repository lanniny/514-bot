/**
 * async-action.js — 异步按钮的忙态统一处理（UI-AUDIT P1-6）
 *
 * 背景：全站异步按钮各自手写 `button.disabled = true` → try/catch → 恢复，
 * 三件事因此反复出错：① 连点造成重复提交；② 失败路径漏恢复，按钮永久卡死；
 * ③ 没有 aria-busy，读屏用户不知道"正在处理"。
 *
 * 用法：
 *   await runAsyncAction(button, async () => { await request(...); toast("已保存"); });
 *
 * 约定：
 *   - 忙态期间进入同一按钮的调用被直接忽略（防重复提交），返回 undefined；
 *   - 无论成功失败都在 finally 恢复，异常继续抛给调用方（保留既有 toast 逻辑）；
 *   - 若按钮在异步期间被重渲染移除（innerHTML 重建），恢复时静默跳过，不报错。
 */

const BUSY_FLAG = "busy";

function spinnerMarkup() {
  return `<svg class="icon lucide async-action-spinner" aria-hidden="true"><use href="#lucide-loader-circle"></use></svg>`;
}

/**
 * @param {HTMLElement|null} button
 * @param {Function} task 实际执行的异步任务
 * @param {object} [options]
 * @param {string} [options.busyLabel] 忙态文案；缺省保留原文案
 * @param {boolean} [options.spinner] 是否插入旋转图标（lucide-loader-circle）
 * @returns {Promise<any>} 任务返回值；按钮忙态中被拦击时返回 undefined
 */
export async function runAsyncAction(button, task, { busyLabel, spinner = false } = {}) {
  if (!button) return task();
  // 防重复提交：同一按钮在忙态中再次触发直接忽略
  if (button.dataset?.[BUSY_FLAG] === "1") return undefined;

  const labelNode = button.querySelector("span") ?? null;
  const originalHtml = button.innerHTML;
  const originalLabel = labelNode ? labelNode.textContent : button.textContent;
  const wasDisabled = Boolean(button.disabled);

  button.dataset[BUSY_FLAG] = "1";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");

  try {
    if (spinner || busyLabel) {
      const text = busyLabel ?? originalLabel ?? "";
      button.innerHTML = `${spinner ? spinnerMarkup() : ""}<span>${text}</span>`;
    }
    return await task();
  } finally {
    // 视图可能已被重渲染替换，此时恢复无意义且无副作用，静默跳过
    if (button.isConnected) {
      button.innerHTML = originalHtml;
      button.removeAttribute("aria-busy");
      delete button.dataset[BUSY_FLAG];
      button.disabled = wasDisabled;
    }
  }
}

/** 判断某个按钮此刻是否处于忙态（供调用方做额外拦截）。 */
export function isBusy(button) {
  return Boolean(button?.dataset?.[BUSY_FLAG] === "1");
}
