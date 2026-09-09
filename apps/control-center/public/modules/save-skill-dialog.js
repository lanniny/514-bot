/**
 * save-skill-dialog.js — 成功 run → Private skill 编辑保存（G-5）。
 * 草稿由 private-skill-from-run 派生；保存走既有 POST /api/bots/private-skills。
 */

import { PRIVATE_SKILL_DRAFT_LIMITS } from "./private-skill-from-run.js";

function field(dialog, name) {
  return dialog?.querySelector(`[data-save-skill-field="${name}"]`) || null;
}

function setText(node, value) {
  if (node) node.textContent = value;
}

export function bindSaveSkillDialog({ dialog, request, toast, onSaved } = {}) {
  if (!dialog || dialog.dataset.saveSkillBound === "1") return dialog;
  const form = dialog.querySelector("form");
  const errorEl = dialog.querySelector("[data-save-skill-error]");
  const emptyEl = dialog.querySelector("[data-save-skill-empty]");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = {
      name: String(field(dialog, "name")?.value || "").trim(),
      description: String(field(dialog, "description")?.value || "").trim(),
      instructions: String(field(dialog, "instructions")?.value || "").trim(),
    };
    if (!body.name || !body.description || !body.instructions) {
      if (errorEl) {
        errorEl.hidden = false;
        errorEl.textContent = "Private skill 需要名字、描述和指令——空字段不会保存。";
      } else {
        toast?.("Private skill 需要名字、描述和指令", "warning");
      }
      return;
    }
    const submit = form.querySelector("[type='submit']");
    if (submit) submit.disabled = true;
    if (errorEl) {
      errorEl.hidden = true;
      errorEl.textContent = "";
    }
    try {
      const payload = await request("/api/bots/private-skills", { method: "POST", body });
      const skill = payload?.skill;
      if (!skill?.id) throw new Error("控制面没有返回已保存的 skill");
      dialog.returnValue = "saved";
      dialog.close();
      form.reset();
      toast?.("已存为 Private skill", "success", 3200);
      await onSaved?.(skill);
    } catch (error) {
      const message = error?.message || "保存失败";
      if (errorEl) {
        errorEl.hidden = false;
        errorEl.textContent = `保存失败：${message}`;
      } else {
        toast?.(`私有技能保存失败：${message}`, "error", 5000);
      }
    } finally {
      if (submit) submit.disabled = false;
    }
  });
  dialog.querySelectorAll("[data-save-skill-close]").forEach((button) => {
    button.addEventListener("click", () => dialog.close());
  });
  dialog.dataset.saveSkillBound = "1";
  return dialog;
}

export function openSaveSkillDialog(dialog, draft) {
  if (!dialog) return false;
  const form = dialog.querySelector("form");
  const errorEl = dialog.querySelector("[data-save-skill-error]");
  const emptyEl = dialog.querySelector("[data-save-skill-empty]");
  const sourceEl = dialog.querySelector("[data-save-skill-source]");
  form?.reset();
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
  const nameInput = field(dialog, "name");
  const descriptionInput = field(dialog, "description");
  const instructionsInput = field(dialog, "instructions");
  if (nameInput) {
    nameInput.maxLength = PRIVATE_SKILL_DRAFT_LIMITS.nameMax;
    nameInput.value = draft?.name || "";
  }
  if (descriptionInput) {
    descriptionInput.maxLength = PRIVATE_SKILL_DRAFT_LIMITS.descriptionMax;
    descriptionInput.value = draft?.description || "";
  }
  if (instructionsInput) {
    instructionsInput.maxLength = PRIVATE_SKILL_DRAFT_LIMITS.instructionsMax;
    instructionsInput.value = draft?.instructions || "";
  }
  setText(sourceEl, draft?.sourceRunId ? `来源 run ${draft.sourceRunId}` : "来源 run 未知");
  if (emptyEl) {
    const notes = [];
    if (draft?.missingGoal) notes.push("这次 run 没有捕获到目标文本（prompt / title 皆空）。");
    if (draft?.missingOutcome) notes.push("这次 run 没有捕获到可用结果，指令里不会编造成果。");
    if (!draft?.ready) notes.push("请先补全名字和描述再保存。");
    emptyEl.hidden = notes.length === 0;
    emptyEl.textContent = notes.join(" ");
  }
  dialog.returnValue = "";
  if (typeof dialog.showModal === "function") dialog.showModal();
  nameInput?.focus({ preventScroll: true });
  return true;
}
