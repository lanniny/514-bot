import { escapeHtml } from "../utils.js";

const STARTERS = [
  { label: "解释一个问题", icon: "lucide-sparkles", prompt: "请帮我解释这个问题：" },
  { label: "分析内容", icon: "lucide-chart-column", prompt: "请帮我分析以下内容，并指出需要核实的地方：" },
  { label: "制定计划", icon: "lucide-file-text", prompt: "请根据以下目标制定可执行的计划：" },
];

export function assistantEmptyMarkup(hint, title = "还没有消息", { readiness = "", home = false } = {}) {
  const chips = STARTERS.map((item) => `<button type="button" role="listitem" data-bot-suggest="${escapeHtml(item.prompt)}"><svg aria-hidden="true" class="icon lucide"><use href="#${item.icon}"></use></svg><span>${escapeHtml(item.label)}</span></button>`).join("");
  return `<div class="bot-message-empty bot-empty-hero${home ? " assistant-home" : ""}">
    <strong class="bot-empty-brand">514</strong>
    <span class="bot-empty-kicker">${home ? "从一个问题，开始一起工作" : escapeHtml(title)}</span>
    <span class="bot-empty-subtitle">${home ? "选择助手开始对话，或进入项目继续工作。" : "想法、上下文与后续成果，都留在这段对话里。"}</span>
    ${home ? `<div class="assistant-home-actions"><button type="button" class="primary-button" data-assistant-start>新对话</button><button type="button" class="secondary-button" data-assistant-project>新建项目</button></div>` : hint && hint !== title && hint !== "还没有消息" ? `<span class="bot-empty-hint">${escapeHtml(hint)}</span>` : ""}
    ${readiness ? `<details class="assistant-readiness"><summary>查看工作环境准备情况</summary><div class="bot-readiness-slot">${readiness}</div></details>` : ""}
    ${home ? "" : `<div class="bot-empty-chips" role="list">${chips}</div>`}
  </div>`;
}

// This component owns only its dialog and the creation intent. Server records
// and conversation selection remain in the existing workspace controllers.
export function createAssistantStart({ dialog, getMembers, creation, beginSelection, selectionCurrent, openConversation, pickDirectory = null, onProject, onConfigure, onInspect, onError = () => {} }) {
  const doc = dialog.ownerDocument;
  const form = dialog.querySelector("form");
  const members = dialog.querySelector("[data-assistant-members]");
  const title = dialog.querySelector("[data-assistant-title]");
  const submit = dialog.querySelector("[data-assistant-create]");
  const status = dialog.querySelector("[data-assistant-status]");
  const cwd = dialog.querySelector("[data-assistant-cwd]");
  const cwdPick = dialog.querySelector("[data-assistant-cwd-pick]");
  const inspect = dialog.querySelector("[data-assistant-inspect]");
  let generation = 0;
  let opener = null;
  let busy = false;
  let uncertain = false;
  let membersPoll = 0; // 目录在途时的有界自愈轮询句柄

  function close({ restoreFocus = true } = {}) {
    generation++;
    clearTimeout(membersPoll);
    if (dialog.open) dialog.close();
    if (restoreFocus && opener?.isConnected) opener.focus({ preventScroll: true });
  }
  function selectedMember() { return getMembers().find((member) => member.id === members.value); }
  function sync(loading = false) {
    const member = selectedMember();
    members.disabled = busy;
    title.disabled = busy;
    if (cwd) cwd.disabled = busy;
    if (cwdPick) cwdPick.disabled = busy || !pickDirectory;
    submit.disabled = busy || uncertain || !member?.eligible;
    submit.textContent = busy ? "正在创建…" : "开始对话";
    form.setAttribute("aria-busy", String(busy));
    if (loading && !busy && !uncertain) status.textContent = "正在加载助手列表…";
    else if (!busy && !uncertain) status.textContent = member
      ? `${member.detail}。创建后再发送消息。`
      : "还没有可选助手，请先添加成员或配置连接。";
    inspect.hidden = !uncertain;
  }
  // 用当前目录重建选项；返回可选成员数。首次 open 时 bootstrap 可能仍在途——
  // 空列表不挡dialog，但必须有界轮询自愈（qa-api-chat 实测 reload 后立刻点开=空列表）。
  function populateMembers() {
    const choices = getMembers();
    members.replaceChildren(...choices.map((member) => {
      const option = doc.createElement("option");
      option.value = member.id;
      option.textContent = `${member.label} · ${member.detail}`;
      option.disabled = !member.eligible;
      return option;
    }));
    return choices.length;
  }
  function scheduleMembersRepoll() {
    clearTimeout(membersPoll);
    const repoll = () => {
      if (!dialog.open) return;
      if (populateMembers() > 0) { members.value = getMembers().find((member) => member.eligible)?.id || ""; sync(); return; }
      membersPoll = setTimeout(repoll, 150);
    };
    membersPoll = setTimeout(repoll, 150);
  }

  dialog.querySelectorAll("[data-assistant-close]").forEach((button) => button.addEventListener("click", () => close()));
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  members.addEventListener("change", sync);
  // 系统目录选择框是本机特权面（server 单例锁）；取消=不改输入，失败如实显示在状态行。
  cwdPick?.addEventListener("click", async () => {
    if (!pickDirectory || busy) return;
    const owner = generation;
    cwdPick.disabled = true;
    try {
      const picked = await pickDirectory();
      if (owner === generation && picked) cwd.value = picked;
    } catch (error) {
      if (owner === generation) status.textContent = `文件夹选择失败：${error.message}`;
    } finally {
      if (owner === generation) cwdPick.disabled = busy || !pickDirectory;
    }
  });
  dialog.querySelector("[data-assistant-project]").addEventListener("click", () => { const trigger = opener; close({ restoreFocus: false }); onProject(trigger); });
  dialog.querySelector("[data-assistant-configure]").addEventListener("click", () => { close({ restoreFocus: false }); onConfigure(); });
  inspect.addEventListener("click", () => { close({ restoreFocus: false }); onInspect(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || uncertain) return;
    const member = selectedMember();
    if (!member?.eligible) { sync(); return; }
    const owner = generation;
    const selection = beginSelection();
    const command = { memberId: member.id, title: title.value.trim() || `与 ${member.label} 的新对话` };
    const folder = String(cwd?.value || "").trim();
    busy = true;
    sync();
    status.textContent = folder ? "正在归入文件夹项目并创建对话" : "正在创建对话";
    try {
      // 选了文件夹 → 归入该文件夹的项目（服务端 ensure 按 cwd 去重）；不选 → 全局直接对话。
      const conversation = folder
        ? await creation.createInFolder({ ...command, cwd: folder })
        : await creation.createDirect(command);
      if (owner !== generation || !selectionCurrent(selection)) return;
      // Close before focusing the workspace; a modal would otherwise keep its
      // focus trap active when the newly selected composer receives focus.
      close({ restoreFocus: false });
      openConversation(conversation.id, selection);
    } catch (error) {
      // The request outcome survives closing its dialog. Only presentation is
      // generation-scoped; a late unknown result must still block a new POST.
      uncertain = error.outcomeUnknown === true;
      if (owner === generation) {
        status.textContent = error.message;
      } else onError(error);
    } finally {
      busy = false;
      if (owner === generation) {
        members.disabled = false;
        title.disabled = false;
        if (cwd) cwd.disabled = false;
        if (cwdPick) cwdPick.disabled = !pickDirectory;
        submit.disabled = uncertain || !selectedMember()?.eligible;
        submit.textContent = "开始对话";
        form.setAttribute("aria-busy", "false");
        inspect.hidden = !uncertain;
      }
    }
  });

  return {
    open(trigger) {
      if (busy) { onError(new Error("对话仍在创建，请稍后从列表查看")); return false; }
      generation++;
      opener = trigger || doc.activeElement;
      title.value = "";
      if (cwd) cwd.value = "";
      const previous = members.value;
      const count = populateMembers();
      const choices = getMembers();
      members.value = choices.find((member) => member.id === previous && member.eligible)?.id
        || choices.find((member) => member.eligible)?.id || "";
      sync(count === 0);
      if (uncertain) status.textContent = "上次创建状态未确认，请先刷新列表核对；重新加载页面后可新建。";
      if (!dialog.open) dialog.showModal();
      if (count === 0) scheduleMembersRepoll(); // 目录在途：开dialog不挡，但有界自愈
      (submit.disabled ? dialog.querySelector("[data-assistant-configure]") : members).focus();
      return true;
    },
    close,
  };
}
