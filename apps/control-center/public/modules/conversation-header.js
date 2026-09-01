export function createConversationHeader({
  elements,
  state,
  escapeHtml,
  lucideIcon,
  request,
  API,
  TERMINAL_RUN_STATES,
  getSelectedRun,
  toast,
  setComposerMode,
  renderSelectedRun,
}) {
  const HEADING_ENV_TTL_MS = 30_000;
  const headingEnvCache = new Map();
  let headingEnvPendingKey = null;

  function headingEnvKey(run) {
    return run?.id || "idle";
  }

  function headingEnvEntry(run) {
    const entry = headingEnvCache.get(headingEnvKey(run));
    return entry && Date.now() - entry.at < HEADING_ENV_TTL_MS ? entry : null;
  }

  function runLocalEnvironmentId(run) {
    return run?.id && (run.cwd || (run.worktreePath && run.worktreeBase)) ? String(run.id) : null;
  }

  function loadHeadingEnvironment(run) {
    if (run && !runLocalEnvironmentId(run)) return;
    const key = headingEnvKey(run);
    if (headingEnvEntry(run) || headingEnvPendingKey === key) return;
    headingEnvPendingKey = key;
    request(`${API.workbenchEnvironment}${run ? `?runId=${encodeURIComponent(run.id)}` : ""}`)
      .then((env) => headingEnvCache.set(key, { at: Date.now(), env }))
      .catch((error) => headingEnvCache.set(key, { at: Date.now(), error: String(error?.message || error) }))
      .finally(() => {
        if (headingEnvPendingKey === key) headingEnvPendingKey = null;
        const current = state.sessionPreview ? null : getSelectedRun();
        if (headingEnvKey(current) === key) paintConversationChips(current);
        if (!current && !state.sessionPreview && key === "idle") setComposerMode(null);
      });
  }

  function envBranchLabel(entry) {
    const git = entry?.env?.git;
    if (!git?.available) return null;
    return git.detached ? `detached · ${git.head || "HEAD"}` : git.branch || null;
  }

  function conversationChipMarkup({ icon, label, title, copy = "" }) {
    const labelHtml = `<span class="conv-chip-label">${escapeHtml(label)}</span>`;
    if (!copy) return `<span class="conv-chip" title="${escapeHtml(title)}">${lucideIcon(icon, "icon lucide")} ${labelHtml}</span>`;
    return `<button class="conv-chip" type="button" data-chip-copy="${escapeHtml(copy)}" title="${escapeHtml(title)}（点击复制）">${lucideIcon(icon, "icon lucide")} ${labelHtml}</button>`;
  }

  function diffStatTotals(stat) {
    const tail = String(stat ?? "").trim().split("\n").filter(Boolean).pop() || "";
    const pick = (re) => {
      const match = re.exec(tail);
      return match ? Number(match[1]) : null;
    };
    const files = pick(/(\d+)\s+files?\s+changed/);
    return {
      files,
      adds: files === null ? null : (pick(/(\d+)\s+insertions?\(\+\)/) ?? 0),
      dels: files === null ? null : (pick(/(\d+)\s+deletions?\(-\)/) ?? 0),
    };
  }

  function paintChangesPill(run) {
    const pill = elements["changes-pill"];
    if (!pill) return;
    if (!run || !run.worktreePath || !TERMINAL_RUN_STATES.has(run.status)) {
      pill.hidden = true;
      pill.innerHTML = "";
      pill.dataset.runId = "";
      return;
    }
    let adds = null;
    let dels = null;
    const view = state.runDiffView;
    if (view?.runId === run.id && view.status === "ok") {
      ({ adds, dels } = diffStatTotals(view.data?.stat));
    }
    if (adds === null) {
      const changes = headingEnvEntry(run)?.env?.git?.changes;
      if (changes && Number.isFinite(Number(changes.additions))) {
        adds = Number(changes.additions);
        dels = Number(changes.deletions) || 0;
      }
    }
    const open = view?.runId === run.id;
    pill.innerHTML = `${lucideIcon("file-pen-line", "icon lucide")}<span>更改${adds === null ? "" : ` <em class="is-add">+${adds}</em> <em class="is-del">−${dels}</em>`}</span>`;
    pill.title = `${open ? "收起" : "查看"}产物 diff（工作树相对 HEAD 的未提交改动）`;
    pill.dataset.runId = run.id;
    pill.hidden = false;
  }

  function paintComposerBranch(run) {
    const chip = elements["composer-branch"];
    if (!chip) return;
    const preview = state.sessionPreview;
    const continuing = Boolean(run) && !preview;
    const envApplies = !preview && (continuing || (!state.pendingCwd && !state.pendingRemote));
    const branch = envApplies ? envBranchLabel(headingEnvEntry(continuing ? run : null)) : null;
    if (!branch) {
      chip.hidden = true;
      chip.innerHTML = "";
      return;
    }
    chip.innerHTML = `${lucideIcon("git-branch", "icon lucide")} <span>${escapeHtml(branch)}</span>`;
    chip.title = `当前分支：${branch}（只读）`;
    chip.hidden = false;
  }

  function paintConversationChips(run) {
    const chips = elements["conversation-chips"];
    const overflow = elements["conversation-overflow"];
    if (!chips) return;
    const preview = state.sessionPreview;
    if (preview) {
      chips.innerHTML = conversationChipMarkup({
        icon: "folder",
        label: preview.projectLabel,
        title: `来源项目：${preview.projectLabel}`,
        copy: preview.projectLabel,
      });
      if (overflow) overflow.hidden = true;
      chips.hidden = false;
      paintChangesPill(null);
      paintComposerBranch(null);
      return;
    }
    if (!run) {
      chips.hidden = true;
      chips.innerHTML = "";
      paintChangesPill(null);
      paintComposerBranch(null);
      loadHeadingEnvironment(null);
      return;
    }
    const parts = [];
    if (run.remote) {
      const short = String(run.remote.path || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || run.remote.path || "远程项目";
      parts.push(conversationChipMarkup({
        icon: "globe",
        label: short,
        title: `远程项目：${run.remote.hostName || run.remote.hostId || ""} · ${run.remote.path || ""}`,
        copy: run.remote.path || "",
      }));
    } else if (run.cwd) {
      const short = String(run.cwd).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || run.cwd;
      parts.push(conversationChipMarkup({ icon: "folder", label: short, title: `项目目录：${run.cwd}`, copy: run.cwd }));
    }
    const entry = headingEnvEntry(run);
    const branch = envBranchLabel(entry);
    if (branch) {
      const git = entry?.env?.git ?? {};
      const divergence = git.upstream
        ? [git.ahead ? `↑${git.ahead}` : null, git.behind ? `↓${git.behind}` : null].filter(Boolean).join(" ") || "已同步"
        : "无上游";
      parts.push(conversationChipMarkup({ icon: "git-branch", label: branch, title: `当前分支：${branch} · ${divergence}`, copy: git.branch || branch }));
    } else if (!entry && headingEnvPendingKey === headingEnvKey(run)) {
      parts.push('<span class="conv-chip is-loading" aria-hidden="true">…</span>');
    }
    chips.innerHTML = parts.join("");
    if (overflow) {
      overflow.hidden = false;
      chips.appendChild(overflow);
    }
    chips.hidden = false;
    paintChangesPill(run);
    paintComposerBranch(run);
    loadHeadingEnvironment(run);
  }

  async function copyTextWithToast(text, message) {
    try {
      await navigator.clipboard.writeText(String(text ?? ""));
      toast(message, "success", 1800);
    } catch (error) {
      toast(`复制失败：${error.message}`, "error");
    }
  }

  async function toggleRunDiff(runId) {
    if (state.runDiffView?.runId === runId) {
      state.runDiffView = null;
      renderSelectedRun();
      return;
    }
    state.runDiffView = { runId, status: "loading" };
    renderSelectedRun();
    try {
      const data = await request(`${API.runs}/${encodeURIComponent(runId)}/diff`);
      if (state.runDiffView?.runId !== runId) return;
      state.runDiffView = { runId, status: "ok", data };
    } catch (error) {
      if (state.runDiffView?.runId !== runId) return;
      state.runDiffView = { runId, status: "error", error: error.message };
    }
    renderSelectedRun();
  }

  function buildMenuItems(run) {
    const items = [
      { icon: "id", label: `复制 run id（${String(run.id).slice(0, 8)}…）`, action: () => void copyTextWithToast(run.id, "run id 已复制") },
      { icon: "copy", label: "复制任务标题", action: () => void copyTextWithToast(run.title || "", "任务标题已复制") },
    ];
    if (run.cwd) items.push({ icon: "folder", label: "复制项目路径", action: () => void copyTextWithToast(run.cwd, "项目路径已复制") });
    if (run.worktreePath) items.push({ icon: "branch", label: "复制工作树路径", action: () => void copyTextWithToast(run.worktreePath, "工作树路径已复制") });
    if (run.worktreePath && TERMINAL_RUN_STATES.has(run.status)) {
      items.push("---", {
        icon: "eye",
        label: state.runDiffView?.runId === run.id ? "收起产物 diff" : "查看产物 diff",
        action: () => void toggleRunDiff(run.id),
      });
    }
    return items;
  }

  return { paintConversationChips, toggleRunDiff, buildMenuItems, runLocalEnvironmentId, headingEnvEntry };
}
