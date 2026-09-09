const REQUIRED_DATA = new Map([
  ["/api/bootstrap", null],
  ["/api/runs", "runs"],
  ["/api/projects", "projects"],
  ["/api/conversations", "conversations"],
]);

// A local session's authentication is independent of execution permissions.
// Only whitelisted status metadata is retained, never URLs, bodies or tokens.
export function createControlConnectionState() {
  let epoch = 0;
  let sequence = 0;
  let transportSequence = 0;
  let rejectedThrough = 0;
  let recoveredThrough = 0;
  let service = "pending";
  let auth = "pending";
  const resources = new Map();
  const listeners = new Set();
  const notify = () => {
    for (const listener of listeners) {
      try { listener(snapshot()); } catch (error) { console.error("Connection observer failed", error); }
    }
  };

  function snapshot() {
    const values = [...REQUIRED_DATA.keys()].map((key) => resources.get(key)?.state || "pending");
    const ready = values.filter((value) => value === "ok").length;
    const data = values.includes("error") ? "error" : ready === values.length ? "ok" : "pending";
    return {
      service, auth, data, ready, total: values.length, interrupted: values.includes("cancelled"),
      apiState: service === "error" || auth === "error" || data === "error" ? "error"
        : service === "ok" && auth === "ok" && data === "ok" ? "ok" : "pending",
    };
  }

  return {
    snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    reset() {
      epoch += 1;
      service = "pending";
      auth = "pending";
      rejectedThrough = sequence;
      recoveredThrough = sequence;
      resources.clear();
      notify();
    },
    begin(path, { method = "GET", data = true } = {}) {
      const key = new URL(String(path), "http://localhost").pathname;
      const required = data && String(method).toUpperCase() === "GET" && REQUIRED_DATA.has(key);
      const ticket = { epoch, sequence: ++sequence, key, required, gated: key.startsWith("/api/") };
      if (required) {
        const previous = resources.get(key)?.state;
        resources.set(key, { sequence: ticket.sequence, state: previous === "ok" || previous === "error" ? previous : "pending" });
      }
      notify();
      return ticket;
    },
    finish(ticket, { status = 0, payload, decoded = true, aborted = false } = {}) {
      if (ticket.epoch !== epoch) return;
      if (!aborted && ticket.sequence >= transportSequence) {
        transportSequence = ticket.sequence;
        service = status > 0 ? "ok" : "error";
      }
      if (ticket.gated && !aborted) {
        // A concurrent success cannot clear a rejection. Only a request started
        // after that rejection can verify recovery for the current token epoch.
        if (status === 401 && ticket.sequence > recoveredThrough) {
          auth = "error";
          rejectedThrough = sequence;
        } else if (status >= 200 && status < 300 && ticket.sequence > rejectedThrough) {
          auth = "ok";
          recoveredThrough = rejectedThrough;
        }
      }
      if (ticket.required && resources.get(ticket.key)?.sequence === ticket.sequence) {
        if (aborted) {
          // Latest-wins loaders may already have discarded older requests. Do
          // not accept their data, but do not imply an ongoing load either.
          if (resources.get(ticket.key).state === "pending") resources.set(ticket.key, { sequence: ticket.sequence, state: "cancelled" });
          notify();
          return;
        }
        const field = REQUIRED_DATA.get(ticket.key);
        const shapeOk = payload && typeof payload === "object" && !Array.isArray(payload)
          && (field === null || Array.isArray(payload[field]));
        resources.set(ticket.key, { sequence: ticket.sequence, state: decoded && shapeOk && status >= 200 && status < 300 ? "ok" : "error" });
      }
      notify();
    },
  };
}

export function connectionPresentation(state) {
  return {
    service: { tone: state.service, label: state.service === "ok" ? "服务可达" : state.service === "error" ? "服务不可达" : "服务检查中" },
    auth: { tone: state.auth === "error" ? "error" : state.service === "error" ? "pending" : state.auth,
      label: state.auth === "error" ? "会话未授权" : state.service === "error" ? "授权待复核" : state.auth === "ok" ? "会话授权有效" : "授权未验证" },
    data: { tone: state.auth === "error" || state.service === "error" ? "error" : state.data,
      label: state.auth === "error" ? "数据访问受阻" : state.service === "error" ? "数据已离线"
        : state.data === "ok" ? "工作数据已加载" : state.data === "error" ? "工作数据加载失败"
          : state.interrupted ? "工作数据待刷新" : `工作数据加载中 ${state.ready}/${state.total}` },
  };
}
