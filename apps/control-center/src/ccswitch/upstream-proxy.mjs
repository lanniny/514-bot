import { connect } from "node:net";
import { performance } from "node:perf_hooks";
import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from "undici";
import { assertHostAllowed } from "../security/egress-guard.mjs";

const DIRECT_DISPATCHER = getGlobalDispatcher();
const LOOPBACKS = new Set(["127.0.0.1", "::1", "localhost"]);
const DEFAULT_PORTS = Object.freeze([
  { port: 7890, type: "http", mixed: true },
  { port: 7891, type: "socks5", mixed: false },
  { port: 1080, type: "socks5", mixed: false },
  { port: 8080, type: "http", mixed: false },
  { port: 8888, type: "http", mixed: false },
  { port: 3128, type: "http", mixed: false },
  { port: 10808, type: "socks5", mixed: false },
  { port: 10809, type: "http", mixed: false },
]);

let activeAgent = null;
let activeUrl = null;

function fail(message, code = "UPSTREAM_PROXY_INVALID", httpStatus = 400) {
  throw Object.assign(new Error(message), { code, httpStatus });
}

export function normalizeUpstreamProxyUrl(value, { allowEmpty = true } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw && allowEmpty) return null;
  if (!raw) fail("upstream proxy URL is required");
  let url;
  try { url = new URL(raw); } catch { fail("upstream proxy URL is invalid"); }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    fail("upstream proxy must use http or https", "UPSTREAM_PROXY_SCHEME_UNSUPPORTED");
  }
  if (!url.hostname || url.pathname !== "/" || url.search || url.hash) {
    fail("upstream proxy URL must contain only scheme, authority, and optional credentials");
  }
  if (!url.port) url.port = url.protocol === "https:" ? "443" : "80";
  return url.href;
}

export function maskUpstreamProxyUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.username) url.username = "••••";
  if (url.password) url.password = "••••";
  return url.href;
}

export function upstreamProxyStatus() {
  if (!activeUrl) return { enabled: false, urlMasked: null, protocol: null, host: null, port: null };
  const url = new URL(activeUrl);
  return {
    enabled: true,
    urlMasked: maskUpstreamProxyUrl(activeUrl),
    protocol: url.protocol.slice(0, -1),
    host: url.hostname,
    port: Number(url.port),
  };
}

async function closeDispatcher(dispatcher, timeoutMs) {
  if (!dispatcher) return { timedOut: false, error: null };
  const timeout = Math.max(0, Number(timeoutMs) || 0);
  let timer = null;
  const closed = Promise.resolve().then(() => dispatcher.close()).then(
    () => ({ timedOut: false, error: null }),
    (error) => ({ timedOut: false, error: String(error?.message || error).slice(0, 300) }),
  );
  const result = timeout > 0
    ? await Promise.race([
      closed,
      new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true, error: null }), timeout); }),
    ])
    : { timedOut: true, error: null };
  if (timer) clearTimeout(timer);
  if (result.timedOut) {
    try {
      void Promise.resolve(dispatcher.destroy?.()).catch(() => {});
    } catch {
      // The global dispatcher has already switched; destroy is best-effort cleanup only.
    }
  }
  return result;
}

export async function configureUpstreamProxy(value, { closeTimeoutMs = 2_000 } = {}) {
  const normalized = normalizeUpstreamProxyUrl(value);
  const previous = activeAgent;
  if (!normalized) {
    setGlobalDispatcher(DIRECT_DISPATCHER);
    activeAgent = null;
    activeUrl = null;
  } else {
    const next = new ProxyAgent(normalized);
    setGlobalDispatcher(next);
    activeAgent = next;
    activeUrl = normalized;
  }
  const dispatcherClose = previous && previous !== activeAgent
    ? await closeDispatcher(previous, closeTimeoutMs)
    : { timedOut: false, error: null };
  return {
    ...upstreamProxyStatus(),
    dispatcherCloseTimedOut: dispatcherClose.timedOut,
    dispatcherCloseError: dispatcherClose.error,
  };
}

function validateTarget(value) {
  let url;
  try { url = new URL(String(value ?? "")); } catch { fail("proxy test target is invalid", "UPSTREAM_PROXY_TEST_TARGET_INVALID"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACKS.has(url.hostname))) {
    fail("proxy test target must use https (http is allowed only for loopback)", "UPSTREAM_PROXY_TEST_TARGET_FORBIDDEN", 403);
  }
  if (url.username || url.password) fail("proxy test target must not contain credentials", "UPSTREAM_PROXY_TEST_TARGET_FORBIDDEN", 403);
  // F-044：探测目标是让「代理去连它」，天然是个出站探针。用 lan 策略保留
  // 上面那条 loopback 豁免，同时挡掉云元数据与保留段。
  try {
    assertHostAllowed(url.hostname, { policy: "lan" });
  } catch (error) {
    fail(`proxy test target is not publicly routable: ${error.message}`, "UPSTREAM_PROXY_TEST_TARGET_FORBIDDEN", 403);
  }
  return url.href;
}

export async function testUpstreamProxy(value, {
  targetUrl = "https://api.anthropic.com/",
  timeoutMs = 10_000,
} = {}) {
  const normalized = normalizeUpstreamProxyUrl(value, { allowEmpty: false });
  const target = validateTarget(targetUrl);
  const dispatcher = new ProxyAgent(normalized);
  const started = performance.now();
  try {
    const response = await fetch(target, {
      method: "HEAD",
      dispatcher,
      signal: AbortSignal.timeout(Math.max(500, Math.min(30_000, Number(timeoutMs) || 10_000))),
    });
    await response.body?.cancel().catch(() => {});
    return { success: true, latencyMs: Math.round(performance.now() - started), status: response.status, target };
  } catch (error) {
    return {
      success: false,
      latencyMs: Math.round(performance.now() - started),
      error: String(error?.message || error).slice(0, 300),
      target,
    };
  } finally {
    await dispatcher.close().catch(() => {});
  }
}

function portOpen(port, timeoutMs = 150) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function scanLocalProxies({ ports = DEFAULT_PORTS, timeoutMs = 150 } = {}) {
  const found = [];
  await Promise.all(ports.map(async (entry) => {
    const item = typeof entry === "number" ? { port: entry, type: "http", mixed: false } : entry;
    const port = Number(item.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !await portOpen(port, timeoutMs)) return;
    found.push({ url: `${item.type}://127.0.0.1:${port}`, proxyType: item.type, port });
    if (item.mixed) {
      const alternate = item.type === "http" ? "socks5" : "http";
      found.push({ url: `${alternate}://127.0.0.1:${port}`, proxyType: alternate, port });
    }
  }));
  return found.sort((left, right) => left.port - right.port || left.proxyType.localeCompare(right.proxyType));
}
