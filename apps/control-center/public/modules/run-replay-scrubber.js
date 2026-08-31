/**
 * W2.8 会话回放时间线 scrubber：拖动时间轴逐格查看 run 的事件流。
 * 数据源：GET /api/runs/:id/replay（projectRunReplay 已有，前端从未消费——api.js:44 一直悬空）。
 * 只读投影：不发起任何 provider 请求（replayActionability 语义），拖动只改视图下标。
 * 纯渲染 + 可注入 request；零依赖，node --test 可直测纯函数。
 */

const REPLAY_SEEN = 4; // 当前条目之后预览的条数

export function normalizeReplayTimeline(payload) {
  const timeline = Array.isArray(payload?.timeline) ? payload.timeline : [];
  const entries = timeline
    .filter((item) => item && typeof item === "object")
    .map((item, index) => ({
      id: String(item.id || `entry-${index}`),
      type: String(item.type || "unknown"),
      source: String(item.source || "event-store"),
      agentId: item.agentId ? String(item.agentId) : null,
      timestamp: item.timestamp ? String(item.timestamp) : null,
    }));
  const times = entries.map((entry) => Date.parse(entry.timestamp || "")).filter(Number.isFinite);
  return {
    entries,
    startAt: times.length ? Math.min(...times) : null,
    endAt: times.length ? Math.max(...times) : null,
    truncated: Boolean(payload?.truncated?.events || payload?.truncated?.bus || payload?.truncated?.attempts || payload?.truncated?.approvals),
    status: String(payload?.status || "unknown"),
  };
}

export function clampIndex(value, length) {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (length <= 0) return 0;
  return Math.min(Math.floor(value), length - 1);
}

export function replayEntryLabel(entry) {
  if (!entry) return "";
  const agent = entry.agentId ? ` · ${entry.agentId}` : "";
  const time = entry.timestamp ? ` · ${new Date(entry.timestamp).toLocaleTimeString()}` : "";
  return `${entry.type}${agent}${time}`;
}

export function createRunReplayScrubber({ request, setIntervalFn = globalThis.setTimeout.bind(globalThis), clearIntervalFn = globalThis.clearTimeout.bind(globalThis) } = {}) {
  if (typeof request !== "function") throw new TypeError("run replay scrubber needs request()");

  let root = null;
  let runId = null;
  let entries = [];
  let position = 0;
  let loading = false;
  let playTimer = null;

  function markup() {
    return `<section class="rrs" data-replay-scrubber hidden aria-label="会话回放时间线">
      <div class="rrs-head">
        <strong>回放时间线</strong>
        <span class="rrs-meta" data-rrs-meta></span>
        <button class="rrs-play" type="button" data-rrs-play>播放</button>
      </div>
      <input class="rrs-range" type="range" min="0" max="0" step="1" value="0" aria-label="回放时间轴" data-rrs-range />
      <div class="rrs-view">
        <div class="rrs-current" data-rrs-current></div>
        <ol class="rrs-upcoming" data-rrs-upcoming></ol>
      </div>
    </section>`;
  }

  function clock(at) {
    return Number.isFinite(at) ? new Date(at).toLocaleTimeString() : "--:--:--";
  }

  function render() {
    if (!root) return;
    const meta = root.querySelector("[data-rrs-meta]");
    const range = root.querySelector("[data-rrs-range]");
    const current = root.querySelector("[data-rrs-current]");
    const upcoming = root.querySelector("[data-rrs-upcoming]");
    const play = root.querySelector("[data-rrs-play]");
    if (!meta || !range || !current || !upcoming || !play) return;
    if (!entries.length) {
      meta.textContent = "";
      range.max = "0";
      range.value = "0";
      range.disabled = true;
      current.textContent = "暂无可回放事件";
      upcoming.innerHTML = "";
      play.disabled = true;
      return;
    }
    range.disabled = loading;
    range.max = String(entries.length - 1);
    range.value = String(clampIndex(position, entries.length));
    play.disabled = loading;
    const at = entries.length ? Date.parse(entries[Math.min(position, entries.length - 1)].timestamp || "") : NaN;
    const startAt = Date.parse(entries[0].timestamp || "");
    const endAt = Date.parse(entries[entries.length - 1].timestamp || "");
    meta.textContent = `${runId ? `run ${runId.slice(0, 8)}` : ""} · ${position + 1}/${entries.length} · ${clock(startAt)} → ${clock(endAt)}${loading ? " · 加载中" : ""}`;
    const entry = entries[clampIndex(position, entries.length)];
    current.textContent = replayEntryLabel(entry);
    upcoming.innerHTML = entries
      .slice(clampIndex(position, entries.length) + 1, clampIndex(position, entries.length) + 1 + REPLAY_SEEN)
      .map((item) => `<li>${replayEntryLabel(item)}</li>`)
      .join("");
  }

  function stopPlayback() {
    if (playTimer) {
      clearIntervalFn(playTimer);
      playTimer = null;
    }
    const play = root?.querySelector("[data-rrs-play]");
    if (play) play.textContent = "播放";
  }

  function step() {
    if (position >= entries.length - 1) {
      stopPlayback();
      return;
    }
    position += 1;
    render();
  }

  async function update(nextRunId, { force = false } = {}) {
    const id = nextRunId ? String(nextRunId) : null;
    if (!id) {
      runId = null;
      entries = [];
      position = 0;
      stopPlayback();
      if (root) root.hidden = true;
      return;
    }
    if (!force && id === runId && entries.length) {
      render();
      return;
    }
    runId = id;
    loading = true;
    stopPlayback();
    if (root) root.hidden = false;
    render();
    try {
      const payload = await request(`/api/runs/${encodeURIComponent(id)}/replay`);
      const model = normalizeReplayTimeline(payload);
      entries = model.entries;
      position = entries.length ? entries.length - 1 : 0;
    } catch {
      entries = [];
      position = 0;
      runId = id;
    } finally {
      loading = false;
      if (root) render();
    }
  }

  function mount(container) {
    root = container || null;
    if (!root) return;
    root.innerHTML = markup();
    root.querySelector("[data-rrs-range]")?.addEventListener("input", (event) => {
      position = clampIndex(Number(event.target.value), entries.length);
      render();
    });
    root.querySelector("[data-rrs-play]")?.addEventListener("click", () => {
      if (playTimer) {
        stopPlayback();
        return;
      }
      if (position >= entries.length - 1) position = 0;
      const play = root.querySelector("[data-rrs-play]");
      if (play) play.textContent = "暂停";
      playTimer = setIntervalFn(step, 700);
    });
    render();
  }

  function dispose() {
    stopPlayback();
    root = null;
    entries = [];
    runId = null;
  }

  return Object.freeze({ markup, mount, update, dispose, isRunning: () => Boolean(playTimer) });
}
