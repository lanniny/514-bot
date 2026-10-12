/**
 * web-evidence-url.js — 「这个 https 链接能不能作为来源卡片展示」的唯一前端判据。
 *
 * 为什么单独成模块（2026-09-18）：这条判据过去在 `src/web-evidence.mjs`（服务端）
 * 与 `public/app.js`（前端）各写了一份，并且**已经漂移**：
 *   - 前端漏拦 169.254.* / 0.0.0.0 / ::1 / fe80: / fc00: / .home.arpa；
 *   - 前端又多拦了全部 `172.*`，连公网 172.15.x / 172.32.x 一起拦。
 * 同一个 URL 在两处得到不同结论，用户看到的卡片取决于哪一层先跑。
 *
 * 现在：本模块是前端唯一入口，规则与服务端逐条对齐，并由
 * `tests/web-evidence-parity.test.mjs` 用同一组 fixture 双向钉死——
 * 任一侧改了规则而另一侧没跟上，测试必红。服务端权威实现见 `src/web-evidence.mjs`。
 *
 * 注意：本模块只判定「URL 合不合规」，不发起任何取网请求。
 * 卡片里的链接来自模型回复文本，未经系统抓取核验。
 */

const DISALLOWED_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "127.0.0.1",
  "169.254.169.254", // 云元数据服务
]);

const DISALLOWED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
];

function isPrivateOrLoopbackIPv4(host) {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  if (parts[0] === 127) return true;                                        // 127.0.0.0/8
  if (parts[0] === 10) return true;                                         // 10.0.0.0/8
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;    // 172.16.0.0/12
  if (parts[0] === 192 && parts[1] === 168) return true;                    // 192.168.0.0/16
  if (parts[0] === 169 && parts[1] === 254) return true;                    // 169.254.0.0/16
  if (parts[0] === 0) return true;                                          // 0.0.0.0/8
  return false;
}

function isPrivateOrLoopbackIPv6(host) {
  const clean = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (clean === "::1" || clean === "::") return true;
  if (clean.startsWith("fe80:") || clean.startsWith("fe80::")) return true;
  if (clean.startsWith("fc00:") || clean.startsWith("fd00:")) return true;
  return false;
}

/**
 * 与 `src/web-evidence.mjs` 的 `validateSafeWebUrl` 同形同判：只放行无凭据的 https 公网地址。
 * @returns {{safe: boolean, url?: string, domain?: string, error?: string}}
 */
export function validateClientWebUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { safe: false, error: "URL string is required" };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (err) {
    return { safe: false, error: `Invalid URL format: ${err.message}` };
  }

  if (parsed.protocol !== "https:") {
    return { safe: false, error: `Disallowed protocol '${parsed.protocol}'; only 'https:' is permitted` };
  }

  if (parsed.username || parsed.password) {
    return { safe: false, error: "Embedded credentials in URL are forbidden" };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) {
    return { safe: false, error: "Hostname is missing" };
  }

  if (DISALLOWED_HOSTNAMES.has(host)) {
    return { safe: false, error: `Forbidden local or loopback host: ${host}` };
  }

  for (const suffix of DISALLOWED_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return { safe: false, error: `Forbidden local domain suffix: ${suffix}` };
    }
  }

  if (isPrivateOrLoopbackIPv4(host)) {
    return { safe: false, error: `Forbidden private/loopback IPv4 address: ${host}` };
  }

  if (isPrivateOrLoopbackIPv6(host)) {
    return { safe: false, error: `Forbidden private/loopback IPv6 address: ${host}` };
  }

  return { safe: true, url: parsed.href, domain: host };
}
