/**
 * 体系内输入对话框（Wave B extraction, 2026-09-01）。
 * 替代原生 prompt，语言与 action-dialog 一致。
 * 从 app.js "体系内输入对话框" 段抽取：纯 UI 交互，无 app.js 业务状态依赖。
 */

export function createPromptDialog({
  getDialog,
  getEyebrow,
  getTitle,
  getConfirm,
  getInput,
  getForm,
  getCancel,
}) {
  return function promptDialog({ eyebrow = "重命名", title, value = "", confirmLabel = "保存", placeholder = "" }) {
    return new Promise((resolveDialog) => {
      const dialog = getDialog();
      getEyebrow().textContent = eyebrow;
      getTitle().textContent = title;
      getConfirm().textContent = confirmLabel;
      const input = getInput();
      const form = getForm();
      const cancel = getCancel();
      input.value = value;
      input.placeholder = placeholder;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        form.removeEventListener("submit", onSubmit);
        cancel.removeEventListener("click", onCancel);
        dialog.removeEventListener("cancel", onEscape);
        dialog.close();
        resolveDialog(result);
      };
      const onSubmit = (event) => {
        event.preventDefault();
        finish(input.value.trim());
      };
      const onCancel = () => finish(null);
      const onEscape = (event) => {
        event.preventDefault();
        finish(null);
      };
      form.addEventListener("submit", onSubmit);
      cancel.addEventListener("click", onCancel);
      dialog.addEventListener("cancel", onEscape);
      dialog.showModal();
      input.select();
    });
  };
}
