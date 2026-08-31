/**
 * W1.1 一键收口卡（bot 证据面）：单动作触发服务端固定命令链
 *   validate → focusedTests → fullTests → browserQa（stopOnFailure: 首个未通过即停）
 * 完成后渲染 live release record 的 gate 判定；任何一环失败给出指路文案。
 *
 * 纪律：
 * - 命令目录与判定标准固定在服务端（release-command-runner），本模块只能启动与观察。
 * - 进度来自 GET /api/release-record/runner 的 active 快照轮询；POST 本身长阻塞，不作为进度源。
 * - fail-closed：网络/快照异常一律渲染失败态并指路，绝不静默吞掉。
 */

const RUNNER_SNAPSHOT_PATH = "/api/release-record/runner";
const RUNNER_RUN_PATH = "/api/release-record/runner/run";
const POLL_INTERVAL_MS = 2000;

const COMMAND_LABELS = {
  validate: "配置校验",
  focusedTests: "聚焦测试",
  fullTests: "全量测试",
  browserQa: "浏览器 QA",
};

const FAILURE_HINTS = {
  validate: "配置校验未通过——查看 validate 输出定位非法配置项，修复后重跑。",
  focusedTests: "聚焦测试未通过——先修 tests/release-record / release-truth / app-close / http-e2e 相关用例。",
  fullTests: "全量测试未通过——按失败用例修复；注意 clean-exit gate 会抓句柄泄漏。",
  browserQa: "浏览器 QA 未通过——运行 npm run qa:environment 查看视口走查详情。",
  DIRTY_WORKTREE: "工作树不干净——runner 拒绝在脏工作树上产证据；先提交或收口改动。",
  BUSY: "收口已在进行中——等待当前链条跑完。",
  SOURCE_COMMIT_MISMATCH: "请求提交与服务端 HEAD 不一致——刷新页面后重试。",
};

export function createCloseoutCard({ request, onFailure, setTimeoutFn = globalThis.setTimeout.bind(globalThis), clearTimeoutFn = globalThis.clearTimeout.bind(globalThis) } = {}) {
  if (typeof request !== "function") throw new TypeError("closeout card needs request()");

  let root = null;
  let pollTimer = null;
  let running = false;
  let disposed = false;

  function markup() {
    return `<article class="bot-card bot-closeout-card is-dynamic" data-bot-card="closeout" aria-label="一键收口">
      <div class="bot-card-head"><span class="bot-card-icon">${lucide("shield-check")}</span>
        <div><strong>一键收口</strong><span>校验 → 测试 → 浏览器 QA → 发布记录，任一环未过即停</span></div>
        <span class="bot-card-state is-waiting" data-closeout-state>待启动</span></div>
      <div class="bot-closeout-progress" data-closeout-progress hidden></div>
      <div class="bot-closeout-detail" data-closeout-detail hidden></div>
      <div class="bot-card-actions">
        <button class="bot-card-confirm" type="button" data-closeout-start>启动收口链</button>
      </div>
    </article>`;
  }

  function lucide(name) {
    return `<svg class="icon lucide" aria-hidden="true"><use href="#lucide-${name}"></use></svg>`;
  }

  function setState(text, tone = "waiting") {
    const el = root?.querySelector("[data-closeout-state]");
    if (!el) return;
    el.textContent = text;
    el.className = `bot-card-state is-${tone}`;
  }

  function renderProgress(progress) {
    const box = root?.querySelector("[data-closeout-progress]");
    if (!box) return;
    box.hidden = false;
    box.innerHTML = (Array.isArray(progress) ? progress : []).map((item) => {
      const tone = item.status === "passed" ? "is-passed" : item.status === "skipped" ? "is-muted" : item.status === "failed" || item.status === "blocked" ? "is-failed" : "is-running";
      return `<span class="bot-closeout-step ${tone}" data-step="${item.id}">${lucide(item.status === "passed" ? "check" : item.status === "failed" || item.status === "blocked" ? "x" : "loader-circle")} ${COMMAND_LABELS[item.id] || item.id} · ${item.status}</span>`;
    }).join("");
  }

  function renderDetail(lines, tone = "info") {
    const box = root?.querySelector("[data-closeout-detail]");
    if (!box) return;
    box.hidden = false;
    box.className = `bot-closeout-detail is-${tone}`;
    box.innerHTML = lines.map((line) => `<p>${line}</p>`).join("");
  }

  function hintFor(outcome) {
    if (FAILURE_HINTS[outcome?.status] && outcome.status !== "passed") return FAILURE_HINTS[outcome.status];
    const note = String(outcome?.note || "");
    if (note.includes("dirty worktree")) return FAILURE_HINTS.DIRTY_WORKTREE;
    return note || "命令未通过——查看服务端输出定位原因。";
  }

  async function pollSnapshot() {
    try {
      const snapshot = await request(RUNNER_SNAPSHOT_PATH);
      if (disposed || !root) return;
      if (snapshot?.active) {
        running = true;
        setState("收口进行中", "running");
        renderProgress(snapshot.active.progress);
      } else if (!running) {
        setState("待启动", "waiting");
      }
    } catch {
      // 快照读取失败不打断长跑；POST 结束时仍会给出终态
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setTimeoutFn(async function tick() {
      await pollSnapshot();
      if (running && !disposed) pollTimer = setTimeoutFn(tick, POLL_INTERVAL_MS);
    }, 0);
  }

  function stopPolling() {
    if (pollTimer) clearTimeoutFn(pollTimer);
    pollTimer = null;
  }

  async function start() {
    if (running || disposed || !root) return;
    running = true;
    setState("收口进行中", "running");
    const button = root.querySelector("[data-closeout-start]");
    if (button) button.disabled = true;
    const detail = root.querySelector("[data-closeout-detail]");
    if (detail) detail.hidden = true;
    renderProgress([]);
    startPolling();
    let result = null;
    let error = null;
    try {
      result = await request(RUNNER_RUN_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stopOnFailure: true }),
      });
    } catch (requestError) {
      error = requestError;
    }
    running = false;
    stopPolling();
    if (disposed || !root) return;
    if (button) button.disabled = false;
    const evidence = result?.evidence || null;
    if (error || !evidence) {
      const code = String(error?.code || "");
      setState("收口失败", "failed");
      renderProgress([]);
      const hint = hintFor({ status: FAILURE_HINTS[code] ? code : "", note: error?.message || "收口请求失败" });
      renderDetail([hint], "failed");
      onFailure?.(hint); // W2.4：收口失败 → 原生通知
      return;
    }
    renderProgress(Object.entries(evidence).map(([id, value]) => ({ id, status: value.status })));
    const failedEntry = Object.entries(evidence).find(([, v]) => v.status === "failed" || v.status === "blocked");
    if (failedEntry) {
      setState("收口失败", "failed");
      const hint = hintFor(failedEntry[1]);
      renderDetail([hint], "failed");
      onFailure?.(hint);
      return;
    }
    const allPassed = Object.values(evidence).every((v) => v.status === "passed");
    if (!allPassed) {
      const skipped = Object.entries(evidence).filter(([, v]) => v.status === "skipped").map(([id]) => COMMAND_LABELS[id] || id);
      setState("链条中断", "failed");
      const hint = `前一命令未通过，已跳过：${skipped.join("、")}。修复后重新启动收口链。`;
      renderDetail([hint], "failed");
      onFailure?.(hint);
      return;
    }
    const verdict = result?.record?.gate?.verdict || result?.record?.verdict || null;
    setState(verdict === "ready" ? "收口通过" : "证据已录，待门禁", verdict === "ready" ? "passed" : "waiting");
    const lines = [
      "四类服务端独立证据已按当前提交/工作树/运行实例绑定落账。",
      verdict === "ready"
        ? "发布门禁 ready——交付卡与发布记录见结算面。"
        : `发布门禁 ${verdict || "partial"}——证据已录，正式发布还需完成剩余门禁项（见发布记录 unfinished 列表）。`,
    ];
    renderDetail(lines, verdict === "ready" ? "passed" : "info");
  }

  function mount(el) {
    if (!el) return;
    dispose();
    disposed = false;
    running = false;
    root = el;
    el.innerHTML = markup();
    el.querySelector("[data-closeout-start]")?.addEventListener("click", () => {
      start();
    });
    pollSnapshot();
  }

  function dispose() {
    disposed = true;
    stopPolling();
    root = null;
  }

  return Object.freeze({ markup, mount, dispose, isRunning: () => running, startFromExternal: () => void start() });
}
