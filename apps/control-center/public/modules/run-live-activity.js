import { escapeHtml, redact } from "../utils.js";
import { lucideIcon } from "../lucide.js";
import { memberAvatarMarkup } from "./avatars.js";

// ── 静态导出（纯函数/常量，无 DI） ──

export const FILE_CHANGE_LABELS = { add: "新增", update: "修改", delete: "删除", rename: "重命名" };
export const FILE_CHANGE_VERBS = { add: "已新增", update: "已编辑", delete: "已删除", rename: "已重命名" };

/** 从 unified diff 文本数 +/- 行（跳过 +++/--- 头），给 summary 行右侧的彩色统计。 */
export function diffLineStats(diff) {
  let add = 0;
  let del = 0;
  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add += 1;
    else if (line.startsWith("-")) del += 1;
  }
  return { add, del };
}

export function diffStatsMarkup(changes) {
  let add = 0;
  let del = 0;
  for (const change of changes) {
    const stats = diffLineStats(change?.diff);
    add += stats.add;
    del += stats.del;
  }
  if (!add && !del) return "";
  const parts = [];
  if (add) parts.push(`<em class="is-add">+${add}</em>`);
  if (del) parts.push(`<em class="is-del">−${del}</em>`);
  return `<span class="process-diffstat">${parts.join("")}</span>`;
}

/** 命令的首个词——折叠态一眼分辨 npm / git / node，不用展开。 */
export function commandHeadline(command) {
  const text = String(command || "").trim();
  if (!text) return "命令";
  const firstLine = text.split("\n")[0];
  return firstLine.length > 96 ? `${firstLine.slice(0, 96)}…` : firstLine;
}

/** 活跃轮已运行时长文案；超过 5 分钟追加提示，帮助区分"慢"与"停"。 */
export function liveElapsedText(since) {
  const startedMs = Date.parse(String(since ?? ""));
  if (!Number.isFinite(startedMs)) return "";
  const elapsed = Math.max(0, Date.now() - startedMs);
  const totalSeconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  // formatDuration 输出的是 "263 s"，分钟级读起来费劲——活跃轮要的是一眼看懂
  const span = minutes ? `${minutes} 分 ${String(totalSeconds % 60).padStart(2, "0")} 秒` : `${totalSeconds} 秒`;
  return elapsed >= 5 * 60_000 ? `已运行 ${span} · 长时间执行中` : `已运行 ${span}`;
}

/** 秒级走时：只改那一个 time 节点的文本，不触发会话流重绘；页面不可见时整秒扫描直接跳过。 */
export function tickLiveElapsed() {
  if (document.hidden) return;
  for (const node of document.querySelectorAll("[data-live-since]")) {
    node.textContent = liveElapsedText(node.dataset.liveSince);
  }
}

// ── 工厂（有状态 + DI） ──

export function createRunLiveActivity({
  ACTIVE_RUN_STATES,
  agentSlug,
  agentCli,
  agentLabel,
  cliIconMarkup,
  toolGlyphFor,
  historyEventsForRun,
  isDeltaEventType,
  getMemberCatalog,
}) {
  const compactingRuns = new Map();
  const codexActivity = new Map();
  const turnFileStats = new Map();

  function trackContextCompaction(event) {
    if (!event?.runId) return false;
    if (event.type === "run.context_compaction_started") {
      compactingRuns.set(event.runId, {
        agentId: event.data?.agentId || event.agentId || "",
        startedAt: event.timestamp || new Date().toISOString(),
      });
      return true;
    }
    if (event.type === "run.context_compaction_completed" || event.type === "run.context_compaction_failed") {
      return compactingRuns.delete(event.runId);
    }
    if (/^run\.(completed|failed|cancelled|interrupted)$/.test(event.type)) {
      return compactingRuns.delete(event.runId);
    }
    return false;
  }

  function liveTurnMarkup(run) {
    if (!ACTIVE_RUN_STATES.has(run.status)) return "";
    if (run.status === "waiting_approval" || run.status === "recovery_required" || run.pendingAsk) return ""; // 等的是人，不是 agent
    const inflight = Object.keys(run.inflightTurns || {}).length > 0;
    if (run.recoveryNote && !inflight && run.status !== "running") return ""; // 粘性注记只在没有在途 turn 时藏呼吸行
    const liveCompaction = compactingRuns.get(run.id);
    const compacting = run.contextRecovery?.state === "compacting" || Boolean(liveCompaction);
    // 压缩窗口必须盖过「上轮 failed → 编排器正在路由下一轮」的空隙文案：耗尽轮已经 failed，
    // 但原生 compact 最长 5 分钟——不写专门相位，LO 会以为卡住然后去点中断。
    if (compacting) {
      const compactAgentId = run.contextRecovery?.agentId || liveCompaction?.agentId || (run.turnAttempts ?? []).at(-1)?.agentId || "";
      const compactSince = run.contextRecovery?.startedAt || liveCompaction?.startedAt || run.updatedAt || null;
      const compactSlug = agentSlug(compactAgentId);
      const compactCli = agentCli(compactAgentId);
      return `
    <div class="live-turn is-agent-${compactSlug}" data-stream-key="tail:live">
      <span class="message-avatar live-avatar${compactCli ? ` has-cli-avatar is-cli-${compactCli}` : ""}" aria-hidden="true">${memberAvatarMarkup(
        (getMemberCatalog()).find((item) => item.id === compactAgentId) || { id: compactAgentId, avatar: "" },
        { className: "avatar-photo", iconClass: "cli-logo", fallback: compactCli ? cliIconMarkup(compactCli) : lucideIcon("bot") },
      )}</span>
      <span><strong>${escapeHtml(agentLabel(compactAgentId))}</strong> 正在压缩上下文，请勿中断</span>
      <span class="live-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      ${compactSince ? `<time class="live-elapsed" data-live-since="${escapeHtml(compactSince)}">${escapeHtml(liveElapsedText(compactSince))}</time>` : ""}
    </div>`;
    }
    const attempt = (run.turnAttempts ?? []).at(-1);
    // 时效兜底：相位 30 分钟没动过=协程大概率已死（超时上限量级），不假装还在跑
    const staleMs = Date.now() - Date.parse(attempt?.updatedAt ?? run.updatedAt ?? 0);
    if (Number.isFinite(staleMs) && staleMs > 30 * 60_000) return "";
    if (!attempt || ["completed", "failed"].includes(attempt.phase)) {
      // 轮间空隙（上轮已结、下轮未起）：编排器在路由/编织上下文
      return run.status === "running"
        ? `<div class="live-turn" data-stream-key="tail:live"><span class="live-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>编排器正在路由下一轮</span></div>`
        : "";
    }
    const phaseText = {
      prepared: "正在准备会话",
      session_ready: "会话已就绪，正在提交",
      submitting: "正在提交任务",
      submitted: "正在执行",
      ambiguous: "提交状态待确认",
    }[attempt.phase] ?? "正在执行";
    const slug = agentSlug(attempt.agentId);
    const attemptCli = agentCli(attempt.agentId);
    // 已运行时长：submitted 期间没有中间 checkpoint，只显示"正在执行"时 4 分钟和 40 分钟长得一样，
    // 用户无法区分"在深度思考"和"已经死了"（LO 2026-08-08：发继续没反应，实为 Codex 正常长跑）。
    const since = attempt.updatedAt || attempt.createdAt || null;
    // 具体在跑什么 > 泛泛的"正在执行"。第五轮起 command/file 活跃项已独立成进行态过程行
    // （liveProcessRowsMarkup）——呼吸行只为 reasoning 保留「正在思考」，其余退回相位文案，一活不两显。
    const latestActivity = codexLiveActivities(run.id).at(-1);
    const activity = latestActivity?.progress.kind === "reasoning" ? "正在思考" : "";
    return `
    <div class="live-turn is-agent-${slug}" data-stream-key="tail:live">
      <span class="message-avatar live-avatar${attemptCli ? ` has-cli-avatar is-cli-${attemptCli}` : ""}" aria-hidden="true">${memberAvatarMarkup(
        (getMemberCatalog()).find((item) => item.id === attempt.agentId) || { id: attempt.agentId, avatar: "" },
        { className: "avatar-photo", iconClass: "cli-logo", fallback: attemptCli ? cliIconMarkup(attemptCli) : lucideIcon("bot") },
      )}</span>
      <span><strong>${escapeHtml(agentLabel(attempt.agentId))}</strong> ${escapeHtml(activity || phaseText)}</span>
      <span class="live-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      ${since ? `<time class="live-elapsed" data-live-since="${escapeHtml(since)}">${escapeHtml(liveElapsedText(since))}</time>` : ""}
    </div>`;
  }

  function liveDeltaMarkup(run, { agentId = null } = {}) {
    if (!ACTIVE_RUN_STATES.has(run.status)) return "";
    if (run.status === "waiting_approval" || run.status === "recovery_required" || run.pendingAsk) return "";
    const events = historyEventsForRun(run.id);
    const delta = events.findLast((event) => isDeltaEventType(event.type)
      && (!agentId || event.agentId === agentId || event.data?.agentId === agentId));
    const text = String(delta?.content || delta?.data?.delta || delta?.data?.text || "").trim();
    // 气泡节点常驻（无文本时 hidden 占位）：delta 流式到达只改气泡内部文本，
    // 不增删会话流直系节点——连续 delta 与会话流 DOM 隔离（qa:ui continuous-delta 契约）。
    // 原位更新路径见 app.js renderSelectedRun 的 live-delta 短路。
    // 过短碎片（刚起流的 1–3 字，如“值。”）不单独成泡：呼吸行已表达存活，
    // 碎片泡常驻会被当成渲染 bug；原位短路会同步 hidden 翻转，隔离契约不受影响。
    if (Array.from(text).length < 4) return `<div class="live-delta-bubble" data-stream-key="tail:live-delta" hidden><div class="md-body"></div></div>`;
    return `<div class="live-delta-bubble" data-stream-key="tail:live-delta"><div class="md-body">${escapeHtml(redact(text.slice(-4000)))}</div></div>`;
  }

  // 正在执行的 Codex item：item/started 记入、item/completed 抹去。历史卡片只认完成态
  // （每条命令一行），"此刻在跑什么"由这里承接——两者合起来才等于 CLI 的可见度。
  // reasoning 也在册：模型长考时没有 command/file 活跃，没有它呼吸行只剩干巴巴的相位文案
  // （LO 2026-08-10：要 Codex 官方那种「正在思考」状态）。
  function trackCodexActivity(event) {
    if (!event?.runId) return false;
    const progress = event.data?.progress;
    if (event.type === "codex.item/started" && progress?.id && ["command", "file", "reasoning", "tool"].includes(progress.kind)) {
      codexActivity.set(`${event.runId}\u0000${progress.id}`, { runId: event.runId, progress, since: event.timestamp });
      return true;
    }
    if (event.type === "codex.item/completed" && progress?.id) {
      return codexActivity.delete(`${event.runId}\u0000${progress.id}`);
    }
    // run 收尾时清掉残留（进程被杀/轮失败时不会有 completed），否则会一直显示假的"正在执行"
    if (/^run\.(completed|failed|cancelled)$/.test(event.type)) {
      let removed = false;
      for (const key of [...codexActivity.keys()]) {
        if (key.startsWith(`${event.runId}\u0000`)) removed = codexActivity.delete(key) || removed;
      }
      return removed;
    }
    return false;
  }

  /** 当前 run 的全部活跃 item（started 登记、completed 核销），按发生序。 */
  function codexLiveActivities(runId) {
    return [...codexActivity.values()].filter((item) => item.runId === runId);
  }

  /** 当前 run 正在跑的那条命令/改动的人话摘要；没有则空串。 */
  function codexActivityText(runId) {
    const entry = codexLiveActivities(runId).at(-1);
    if (!entry) return "";
    if (entry.progress.kind === "reasoning") return "正在思考";
    if (entry.progress.kind === "tool") return `正在调用 ${commandHeadline(entry.progress.name)}`;
    if (entry.progress.kind === "file") {
      const count = Number(entry.progress.changesTotal || entry.progress.changes?.length || 0);
      return count ? `正在写入 ${count} 个文件` : "正在写入文件";
    }
    return `正在执行 ${commandHeadline(entry.progress.command)}`;
  }

  /**
   * 进行态过程行（收敛层·第五轮，参考 Codex 桌面「运行了命令…」转圈行）：
   * codexActivity 里 started 未核销的 command/file 项逐条成行——此前它们只折算成呼吸行
   * 的一句文案，"此刻在跑什么"的可见度差一档。reasoning 不进这里（呼吸行的
   * 「正在思考」已表达，一活不两显）。行内时长复用 data-live-since 秒级走时
   * （tickLiveElapsed），不靠重渲。无 item 信号的席位（kimi/gemini 等）天然无此行，不造假活。
   */
  function liveProcessRowsMarkup(run) {
    if (!run || !ACTIVE_RUN_STATES.has(run.status)) return "";
    if (run.status === "waiting_approval" || run.status === "recovery_required" || run.pendingAsk) return ""; // 等的是人：在途 item 已暂停，不挂转圈假活
    const rows = codexLiveActivities(run.id)
      .filter((entry) => entry.progress.kind === "command" || entry.progress.kind === "file" || entry.progress.kind === "tool")
      .map((entry) => {
        const progress = entry.progress;
        const isFile = progress.kind === "file";
        const isTool = progress.kind === "tool";
        const count = Number(progress.changesTotal || progress.changes?.length || 0);
        const singlePath = isFile && count === 1 ? String(progress.changes?.[0]?.path || "") : "";
        const target = isFile
          ? singlePath
            ? redact(singlePath).split(/[\\/]/).pop() || "文件"
            : `${count || 1} 个文件`
          : isTool
          ? `${commandHeadline(progress.name)}${progress.input ? ` ${String(progress.input).replace(/\s+/g, " ").slice(0, 96)}` : ""}`
          : commandHeadline(progress.command);
        const since = entry.since
          ? `<time class="live-elapsed" data-live-since="${escapeHtml(entry.since)}">${escapeHtml(liveElapsedText(entry.since))}</time>`
          : "";
        return `<div class="live-process-row${isFile ? " is-file" : isTool ? " is-tool" : " is-command"}">`
          + `<span class="live-process-spin" aria-hidden="true">${lucideIcon("loader-circle", "icon forge-spin", 13)}</span>`
          + `<span class="process-glyph" aria-hidden="true">${lucideIcon(isFile ? "file-pen-line" : isTool ? toolGlyphFor(progress.name) : "terminal")}</span>`
          + `<span class="process-verb">${isFile ? "正在编辑" : isTool ? "正在调用" : "正在执行"}</span>`
          + `<code class="process-summary-text">${escapeHtml(redact(target))}</code>${since}</div>`;
      })
      .join("");
    return rows
      ? `<details class="bot-live-process" data-stream-key="tail:live-items"><summary class="bot-process-toggle">过程</summary><div class="live-process-rows">${rows}</div></details>`
      : "";
  }

  // 本次交互的文件变更累加器（runId → {files: Map(path→{change,add,del}), add, del}）。
  // 与顶栏「更改 pill」分工：那是终态 worktree 权威口径，这是进行中的实时口径
  // （参考形态「N 个文件已更改 +150 −24」）。只收 completed 的 file progress
  // （started 的 diff 为空）；user.message 开新交互即重置；run 收尾清账防串交互。
  function trackTurnFileStats(event) {
    if (!event?.runId) return false;
    if (event.type === "user.message" || /^run\.(completed|failed|cancelled)$/.test(event.type)) {
      return turnFileStats.delete(event.runId);
    }
    if (event.type !== "codex.item/completed") return false;
    const progress = event.data?.progress;
    if (progress?.kind !== "file" || !Array.isArray(progress.changes)) return false;
    let stats = turnFileStats.get(event.runId);
    if (!stats) {
      stats = { files: new Map(), add: 0, del: 0 };
      turnFileStats.set(event.runId, stats);
    }
    for (const change of progress.changes) {
      const path = typeof change?.path === "string" ? change.path : "";
      if (!path) continue;
      const lines = diffLineStats(change.diff);
      const entry = stats.files.get(path) ?? { change: change.change ?? "update", add: 0, del: 0 };
      entry.change = typeof change?.change === "string" ? change.change : entry.change;
      entry.add += lines.add;
      entry.del += lines.del;
      stats.files.set(path, entry);
      stats.add += lines.add;
      stats.del += lines.del;
    }
    return true;
  }

  /**
   * 流尾步进进度条：「◌ 第 X / Y 步 · N 个文件已更改 +A −D」，可展开 per-file 明细。
   * 步进口径与顶栏 meta 同源（interactionStep/maxStepsPerInteraction）；文件统计来自
   * turnFileStats 实时累加。无 item 信号的席位没有文件段，只显示步进——不猜不编。
   */
  function turnProgressMarkup(run) {
    if (!run || !ACTIVE_RUN_STATES.has(run.status)) return "";
    if (run.status === "waiting_approval" || run.status === "recovery_required" || run.pendingAsk) return ""; // 等的是人：审批/问答卡才是此刻焦点
    const interactionStep = Number(run.interactionStep) || 0;
    const maxSteps = Number(run.maxStepsPerInteraction ?? run.maxRounds) || 0;
    const stepText = maxSteps > 0 ? `第 ${interactionStep} / ${maxSteps} 步` : "";
    const stats = turnFileStats.get(run.id);
    const fileCount = stats?.files.size ?? 0;
    if (!stepText && !fileCount) return "";
    const statBits = [
      stats?.add ? `<em class="is-add">+${stats.add}</em>` : "",
      stats?.del ? `<em class="is-del">−${stats.del}</em>` : "",
    ].filter(Boolean);
    const headline = [stepText, fileCount ? `${fileCount} 个文件已更改` : ""]
      .filter(Boolean)
      .join('<span class="turn-progress-sep">·</span>');
    const summaryInner = `<span class="live-process-spin" aria-hidden="true">${lucideIcon("loader-circle", "icon forge-spin", 13)}</span>`
      + `<span class="turn-progress-text">${headline}</span>`
      + (statBits.length ? `<span class="process-diffstat">${statBits.join("")}</span>` : "");
    if (!fileCount) {
      return `<div class="turn-progress" data-stream-key="tail:progress"><div class="turn-progress-line">${summaryInner}</div></div>`;
    }
    const rows = [...stats.files.entries()].map(([path, entry]) => {
      const bits = [
        entry.add ? `<em class="is-add">+${entry.add}</em>` : "",
        entry.del ? `<em class="is-del">−${entry.del}</em>` : "",
      ].filter(Boolean);
      const label = FILE_CHANGE_LABELS[entry.change] ?? entry.change ?? "改动";
      return `<div class="turn-progress-file">`
        + `<span class="process-file-kind is-${escapeHtml(entry.change ?? "update")}">${escapeHtml(label)}</span>`
        + `<code>${escapeHtml(redact(path))}</code>`
        + (bits.length ? `<span class="process-diffstat">${bits.join("")}</span>` : "")
        + `</div>`;
    }).join("");
    return `<details class="turn-progress" data-stream-key="tail:progress">`
      + `<summary>${summaryInner}<span class="turn-progress-caret" aria-hidden="true">${lucideIcon("chevron-right")}</span></summary>`
      + `<div class="turn-progress-files">${rows}</div>`
      + `</details>`;
  }

  return {
    trackContextCompaction,
    trackCodexActivity,
    trackTurnFileStats,
    liveProcessRowsMarkup,
    turnProgressMarkup,
    liveTurnMarkup,
    liveDeltaMarkup,
    codexActivityText,
  };
}
