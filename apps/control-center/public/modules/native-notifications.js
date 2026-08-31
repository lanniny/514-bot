/**
 * W2.4 原生通知（桌面壳 roadmap #4）：审批请求 / 长任务完成 / 收口失败
 * 走系统通知（Web Notification API——WebView2 直通 Windows 通知中心，无需 Rust 改动）。
 *
 * 纪律：
 * - 幂等 diff：sync* 由多个渲染/快照入口重复调用，内部按 id 去重，绝不重复轰炸。
 * - 优雅降级：API 不可用 / 权限被拒 → 静默停用（一次性 toast 说明），绝不阻塞主流程。
 * - 开关记忆 localStorage("514cc-native-notifications")，默认关闭（首次开启才请求权限）。
 */

const STORAGE_KEY = "514cc-native-notifications";
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "interrupted", "error", "cancelled"]);

export function createNativeNotifications({ toast } = {}) {
  if (typeof toast !== "function") throw new TypeError("native notifications need toast()");

  let seenApprovalIds = new Set();
  let seenTerminalRunIds = new Set();
  let approvalsPrimed = false;
  let runsPrimed = false;
  let warnedUnavailable = false;

  function supported() {
    return typeof globalThis.Notification === "function";
  }

  function storedEnabled() {
    try {
      return globalThis.localStorage?.getItem(STORAGE_KEY) === "on";
    } catch {
      return false;
    }
  }

  function storeEnabled(value) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, value ? "on" : "off");
    } catch {
      // 私隐模式等存储失败：仅本次会话内生效
    }
  }

  function permission() {
    return supported() ? globalThis.Notification.permission : "unsupported";
  }

  function canSend() {
    return storedEnabled() && supported() && globalThis.Notification.permission === "granted";
  }

  function deliver(title, body, tag) {
    if (!canSend()) return;
    try {
      const notification = new globalThis.Notification(String(title), {
        body: String(body || "").slice(0, 200),
        tag: tag ? String(tag) : undefined,
      });
      notification.onclick = () => {
        globalThis.focus?.();
        notification.close();
      };
    } catch {
      // 个别环境构造即抛（WebView 策略）：静默降级
    }
  }

  async function toggle() {
    if (!supported()) {
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        toast("当前环境不支持系统通知，开关保持关闭", "warning");
      }
      return false;
    }
    const next = !storedEnabled();
    if (next && globalThis.Notification.permission === "default") {
      try {
        await globalThis.Notification.requestPermission();
      } catch {
        // 请求被环境拦截：按 denied 处理
      }
    }
    if (next && globalThis.Notification.permission !== "granted") {
      toast("系统通知权限未授予（被浏览器/壳拒绝），开关保持关闭", "warning");
      return false;
    }
    storeEnabled(next);
    toast(next ? "原生通知已开启：审批 / 任务完成 / 收口失败将走系统通知" : "原生通知已关闭", "info");
    return next;
  }

  function syncApprovals(approvals) {
    const list = Array.isArray(approvals) ? approvals : [];
    const pending = list.filter((item) => (item?.status ?? "pending") === "pending" && item?.id != null);
    if (!approvalsPrimed) {
      // 首轮建档：历史 pending 不补发通知（用户打开页面即可见钉顶条）
      approvalsPrimed = true;
      seenApprovalIds = new Set(pending.map((item) => String(item.id)));
      return;
    }
    const fresh = pending.filter((item) => !seenApprovalIds.has(String(item.id)));
    if (!canSend()) return; // 关闭期间不记账：开启后首个 sync 会把存量如实补发一次（诚实语义）
    for (const item of fresh) seenApprovalIds.add(String(item.id));
    for (const gone of [...seenApprovalIds]) {
      if (!pending.some((item) => String(item.id) === gone)) seenApprovalIds.delete(gone); // 已决议的清档
    }
    const latest = fresh[fresh.length - 1];
    if (latest) {
      deliver(
        "待决议审批",
        `${fresh.length > 1 ? `${fresh.length} 项待决议，最新：` : ""}${String(latest.summary || latest.title || latest.id).slice(0, 160)}`,
        "514cc-approval",
      );
    }
  }

  function syncRuns(runs) {
    const list = Array.isArray(runs) ? runs : [];
    const terminal = list.filter((run) => run?.id != null && TERMINAL_RUN_STATES.has(String(run.status)));
    if (!runsPrimed) {
      runsPrimed = true;
      seenTerminalRunIds = new Set(terminal.map((run) => String(run.id)));
      return;
    }
    const fresh = terminal.filter((run) => !seenTerminalRunIds.has(String(run.id)));
    if (!canSend()) return;
    for (const run of fresh) seenTerminalRunIds.add(String(run.id));
    for (const gone of [...seenTerminalRunIds]) {
      if (!terminal.some((run) => String(run.id) === gone)) seenTerminalRunIds.delete(gone);
    }
    for (const run of fresh.slice(-3)) { // 突发批量终态最多提示 3 条，防通知风暴
      const failed = String(run.status) !== "completed";
      deliver(
        failed ? "任务失败" : "任务完成",
        `${String(run.title || run.id).slice(0, 120)} · ${String(run.status)}`,
        `514cc-run-${run.id}`,
      );
    }
  }

  // closeout-card 等 UI 主动上报的失败（不依赖 diff）
  function notifyCloseoutFailure(detail) {
    deliver("收口失败", String(detail || "收口链条中断，查看 bot 证据面定位"), "514cc-closeout");
  }

  // 供测试/设置面展示状态
  function status() {
    return { enabled: storedEnabled(), supported: supported(), permission: permission() };
  }

  return Object.freeze({
    toggle,
    syncApprovals,
    syncRuns,
    notifyCloseoutFailure,
    status,
  });
}
