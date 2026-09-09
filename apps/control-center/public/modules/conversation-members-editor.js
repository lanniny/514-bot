export function createConversationMembersEditor({ dialog, getSnapshot, saveMembers, onChanged }) {
  const doc = dialog.ownerDocument;
  const list = dialog.querySelector("[data-workspace-members-list]");
  const status = dialog.querySelector("[data-workspace-members-status]");
  const save = dialog.querySelector("[data-workspace-members-save]");
  let owner = null;
  let opener = null;
  let pending = false;
  let generation = 0;
  function close({ force = false, restoreFocus = true } = {}) {
    if (!dialog.open || (pending && !force)) return;
    generation++;
    dialog.close();
    if (restoreFocus) opener?.focus?.({ preventScroll: true });
  }
  dialog.querySelectorAll("[data-workspace-members-close]").forEach((button) => button.addEventListener("click", () => close()));
  dialog.addEventListener("cancel", (event) => { if (pending) event.preventDefault(); else generation++; });
  dialog.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!owner || pending) return;
    const snapshot = getSnapshot(owner.id);
    if (snapshot.readOnly || snapshot.running) { status.textContent = "当前执行或封存状态不允许修改成员"; return; }
    const memberIds = [...list.querySelectorAll("input:checked")].map((input) => input.value);
    if (memberIds.length > 40) { status.textContent = "工作对话最多保留 40 位成员"; return; }
    if (memberIds.length && !snapshot.members.some((member) => memberIds.includes(member.id) && member.coordinatorEligible)) {
      status.textContent = "非空团队至少需要一位可协调成员";
      return;
    }
    const commandOwner = owner;
    const token = generation;
    pending = true;
    save.disabled = true;
    status.textContent = "正在保存成员";
    try {
      // The captured revision is intentional: concurrent edits must fail CAS,
      // not silently overwrite another client's roster with the visible draft.
      const updated = await saveMembers(commandOwner, memberIds);
      onChanged(updated);
      if (token === generation) close({ force: true });
    } catch (error) {
      if (token === generation) status.textContent = `成员未保存：${error.message}`;
    } finally {
      pending = false;
      save.disabled = false;
    }
  });
  return {
    close,
    open(conversationId, trigger) {
      if (pending) return;
      const snapshot = getSnapshot(conversationId);
      if (snapshot.conversation?.kind !== "workspace_group") return;
      owner = { ...snapshot.conversation, memberIds: [...snapshot.conversation.memberIds] };
      opener = trigger || doc.activeElement;
      generation++;
      dialog.querySelector("[data-workspace-members-title]").textContent = `${owner.title} · 协作成员`;
      const candidates = new Map(snapshot.members.map((member) => [member.id, member]));
      for (const id of owner.memberIds) if (!candidates.has(id)) candidates.set(id, { id, label: id, eligible: false });
      list.replaceChildren(...[...candidates.values()].map((member) => {
        const label = doc.createElement("label");
        const checkbox = doc.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = member.id;
        checkbox.checked = owner.memberIds.includes(member.id);
        checkbox.disabled = Boolean(snapshot.readOnly || snapshot.running || (!member.eligible && !checkbox.checked));
        const name = doc.createElement("span");
        name.textContent = `${member.label}${member.coordinatorEligible ? " · 可协调" : ""}${!member.eligible ? " · 席位不可用" : ""}`;
        label.append(checkbox, name);
        return label;
      }));
      save.disabled = Boolean(snapshot.readOnly || snapshot.running);
      status.textContent = snapshot.running ? "当前运行结束后可调整成员" : snapshot.readOnly ? "当前工作对话只读" : "成员变更后使用新的执行上下文，历史运行保留原成员";
      if (!dialog.open) dialog.showModal();
    },
  };
}
