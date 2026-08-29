/**
 * egress-guard.mjs — 出站目标守卫（F-044 SSRF 防护）。
 *
 * 背景：webhook_out 渠道允许用户配置任意 URL，服务端随后代替用户发起请求。
 * 若只校验协议而不校验目标主机，攻击者可借服务端之手访问：
 *   - 云元数据 http://169.254.169.254/...  → 直接窃取云厂商临时凭证
 *   - 本机控制面 http://127.0.0.1:51400/... → 绕过 loopback-only 边界
 *   - 内网服务 http://10.0.0.1/...          → 内网探测
 * 这就是 SSRF。修复前 normalizeWebhookUrl() 只查了协议。
 *
 * 设计原则：
 *   1. **默认拒绝**：一切私有/环回/链路本地/保留地址默认阻断，不依赖调用方记得校验。
 *   2. **双层校验**：
 *      - 同步层：配置落库时拦截 IP 字面量（快、可测、不破坏现有同步签名）
 *      - 异步层：真正发送前解析 DNS 再校验一次，防 DNS rebinding
 *        （域名先解析到公网 IP 通过检查，再重绑定到 127.0.0.1）
 *   3. **可逃逸但需显式**：确有内网 webhook 需求时，用 allowedHosts 白名单逐个放行，
 *      而不是关闭整个守卫。
 *   4. **绝不静默放行**：DNS 解析失败也阻断（拿不到 IP 就无法证明目标安全）。
 */

import { isIP } from "node:net";

/** 阻断原因码，便于上层映射 HTTP 状态与前端提示。 */
export const EGRESS_BLOCKED = "EGRESS_TARGET_BLOCKED";

export function egressError(code, message, detail = {}) {
  return Object.assign(new Error(message), { code, httpStatus: 400, ...detail });
}

// ---------------------------------------------------------------------------
// IPv4
// ---------------------------------------------------------------------------

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/**
 * 出站策略。
 *
 * - `strict`（默认）：任何保留段一律拒绝。用于 webhook 这类**目标由远端/第三方
 *   指定**的出站——本机只是执行者，没有理由访问内网。
 * - `lan`：放行环回与私网段，其余保留段仍然拒绝。用于 provider / 自建端点这类
 *   目标由**本机用户自己键入**的场景——Ollama(127.0.0.1:11434)、LM Studio、
 *   公司内网网关都是正当用法，一刀切会直接弄坏产品。
 *
 * 无论哪种策略，`deny` 层（云元数据 169.254.169.254、链路本地、RFC2544
 * 测速段、组播、未指定地址）都不可放行：那里不存在任何正当的模型服务，
 * 只存在凭证窃取和内网测绘。
 */
export const EGRESS_POLICY = Object.freeze({ STRICT: "strict", LAN: "lan" });

/** IPv4 CIDR 表：addr/prefix 形式，直接按整数前缀比较。 */
const BLOCKED_V4 = Object.freeze([
  { cidr: "0.0.0.0/8", label: "reserved (this-network)", tier: "deny" },
  { cidr: "10.0.0.0/8", label: "private network", tier: "lan" },
  { cidr: "100.64.0.0/10", label: "carrier-grade NAT", tier: "deny" },
  { cidr: "127.0.0.0/8", label: "loopback", tier: "lan" },
  { cidr: "169.254.0.0/16", label: "link-local (cloud metadata)", tier: "deny" },
  { cidr: "172.16.0.0/12", label: "private network", tier: "lan" },
  { cidr: "192.0.0.0/24", label: "IETF protocol assignments", tier: "deny" },
  { cidr: "192.0.2.0/24", label: "TEST-NET-1", tier: "deny" },
  { cidr: "192.168.0.0/16", label: "private network", tier: "lan" },
  { cidr: "198.18.0.0/15", label: "benchmark", tier: "deny" },
  { cidr: "198.51.100.0/24", label: "TEST-NET-2", tier: "deny" },
  { cidr: "203.0.113.0/24", label: "TEST-NET-3", tier: "deny" },
  { cidr: "224.0.0.0/4", label: "multicast", tier: "deny" },
  { cidr: "240.0.0.0/4", label: "reserved (includes broadcast)", tier: "deny" },
]);

const V4_RULES = BLOCKED_V4.map(({ cidr, label, tier }) => {
  const [addr, bits] = cidr.split("/");
  const prefix = Number(bits);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  // JS 位运算返回**有符号** int32：网络号 >= 128.0.0.0 时 network 会变成负数，
  // 与下方 `>>> 0` 的无符号结果比较就永远不相等，导致 172.16/12、192.168/16、
  // 169.254/16 这些高位段集体失效。必须统一为无符号。
  return { network: (ipv4ToInt(addr) & mask) >>> 0, mask, label, cidr, tier };
});

function matchBlockedV4(ip, policy = EGRESS_POLICY.STRICT) {
  const value = ipv4ToInt(ip);
  if (value === null) return { label: "unparseable IPv4", cidr: null, tier: "deny" };
  for (const rule of V4_RULES) {
    if (rule.tier === "lan" && policy === EGRESS_POLICY.LAN) continue;
    if ((value & rule.mask) >>> 0 === rule.network) return rule;
  }
  return null;
}

// ---------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------

/** 将 IPv6 展开为 16 字节；支持 :: 压缩与 ::ffff:a.b.c.d 内嵌 IPv4。 */
export function ipv6ToBytes(ip) {
  let text = ip;

  // 内嵌 IPv4（::ffff:127.0.0.1 / ::ffff:7f00:1）
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    text = `${text.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (segment) =>
    segment
      ? segment.split(":").filter(Boolean).map((group) => {
          if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
          return parseInt(group, 16);
        })
      : [];

  const head = parseGroups(halves[0]);
  const tailGroups = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (head.includes(null) || tailGroups.includes(null)) return null;

  const missing = 8 - head.length - tailGroups.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;

  const groups = [...head, ...Array(Math.max(missing, 0)).fill(0), ...tailGroups];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

/** IPv6 CIDR：按字节前缀比较（prefix 为比特数）。 */
const BLOCKED_V6 = Object.freeze([
  { bytes: "::/128", label: "unspecified", tier: "deny" },
  { bytes: "::1/128", label: "loopback", tier: "lan" },
  { bytes: "fc00::/7", label: "unique-local (private)", tier: "lan" },
  { bytes: "fe80::/10", label: "link-local", tier: "deny" },
  { bytes: "ff00::/8", label: "multicast", tier: "deny" },
  // IPv4-mapped / IPv4-compatible：交给 IPv4 规则判定，见 classifyIp
]);

const V6_RULES = BLOCKED_V6.map(({ bytes, label, tier }) => {
  const [addr, bits] = bytes.split("/");
  return { network: ipv6ToBytes(addr), prefix: Number(bits), label, tier };
});

function matchBlockedV6(bytes, policy = EGRESS_POLICY.STRICT) {
  for (const rule of V6_RULES) {
    if (!rule.network) continue;
    if (rule.tier === "lan" && policy === EGRESS_POLICY.LAN) continue;
    let matched = true;
    for (let bit = 0; bit < rule.prefix; bit += 1) {
      const byteIndex = bit >> 3;
      const mask = 0x80 >> (bit & 7);
      if ((bytes[byteIndex] & mask) !== (rule.network[byteIndex] & mask)) {
        matched = false;
        break;
      }
    }
    if (matched) return rule;
  }
  return null;
}

/** IPv4-mapped（::ffff:a.b.c.d）与 IPv4-compatible（::a.b.c.d）：取出内嵌 v4 走 v4 规则。 */
function extractMappedV4(bytes) {
  const firstTenZero = bytes.slice(0, 10).every((byte) => byte === 0);
  if (!firstTenZero) return null;
  const isMapped = bytes[10] === 0xff && bytes[11] === 0xff;
  const isCompatible = bytes[10] === 0 && bytes[11] === 0;
  if (!isMapped && !isCompatible) return null;
  return [bytes[12], bytes[13], bytes[14], bytes[15]].join(".");
}

// ---------------------------------------------------------------------------
// 判定入口
// ---------------------------------------------------------------------------

/**
 * 判定单个 IP 是否命中阻断段。
 * @returns {null | {label: string, cidr: string|null, tier: string}} null 表示允许
 */
export function classifyIp(ip, { policy = EGRESS_POLICY.STRICT } = {}) {
  const version = isIP(ip);
  if (version === 4) return matchBlockedV4(ip, policy);
  if (version === 6) {
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return { label: "unparseable IPv6", cidr: null, tier: "deny" };
    // `::` 与 `::1` 是 IPv6 自己的未指定/环回地址。它们同时也满足
    // IPv4-compatible 的形状（前 12 字节全零），若先走 v4 规则会被解释成
    // 0.0.0.0 / 0.0.0.1 从而命中 0.0.0.0/8——环回于是被误报成 this-network。
    // v6 表对这两者已有定义，必须优先。
    const isUnspecified = bytes.every((byte) => byte === 0);
    const isLoopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
    const mapped = isUnspecified || isLoopback ? null : extractMappedV4(bytes);
    if (mapped) {
      // ::ffff:127.0.0.1 必须当 127.0.0.1 处理，否则可绕过 v4 规则
      return matchBlockedV4(mapped, policy);
    }
    return matchBlockedV6(bytes, policy);
  }
  return { label: "not an IP address", cidr: null, tier: "deny" };
}

export function isBlockedIp(ip, options) {
  return classifyIp(ip, options) !== null;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * 保留域名：不查 DNS 也能确定它们指向环回或云元数据。
 * 放在同步层拦截，是为了让「保存配置」这一步就失败，而不是等到发送时才报错。
 *   - localhost / *.localhost —— RFC 6761 明确保留，恒指环回
 *   - metadata.google.internal 等 —— 云厂商元数据服务的内部域名
 */
const RESERVED_HOSTNAMES = Object.freeze([
  { host: "localhost", tier: "lan", label: "reserved name (loopback)" },
  { host: "metadata.google.internal", tier: "deny", label: "cloud metadata endpoint" },
  { host: "metadata.goog", tier: "deny", label: "cloud metadata endpoint" },
  { host: "instance-data", tier: "deny", label: "cloud metadata endpoint" },
]);

const RESERVED_SUFFIXES = Object.freeze([
  { suffix: ".localhost", tier: "lan", label: "reserved name (loopback)" },
  { suffix: ".localhost.localdomain", tier: "lan", label: "reserved name (loopback)" },
  { suffix: ".ec2.internal", tier: "lan", label: "cloud internal DNS (private range)" },
]);

function reservedNameVerdict(host, policy = EGRESS_POLICY.STRICT) {
  const exact = RESERVED_HOSTNAMES.find((entry) => entry.host === host);
  if (exact) return exact.tier === "lan" && policy === EGRESS_POLICY.LAN ? null : exact;
  const suffix = RESERVED_SUFFIXES.find((entry) => host.endsWith(entry.suffix));
  if (suffix) return suffix.tier === "lan" && policy === EGRESS_POLICY.LAN ? null : suffix;
  return null;
}

function normalizeHost(hostname) {
  let host = String(hostname ?? "").trim().toLowerCase();
  // URL 主机名可能是 [::1] 这种括号形式
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  // 去掉 IPv6 zone id（fe80::1%eth0）
  if (host.includes("%")) host = host.split("%")[0];
  return host;
}

/**
 * 同步层：配置落库时调用。只处理 IP 字面量——域名的真实 IP 要等 DNS 解析，
 * 由 assertEgressAllowed() 在发送前把关（防 DNS rebinding）。
 */
export function assertHostAllowed(hostname, { allowedHosts = [], policy = EGRESS_POLICY.STRICT } = {}) {
  const host = normalizeHost(hostname);
  if (!host) throw egressError(EGRESS_BLOCKED, "outbound target host is empty");

  if (allowedHosts.map(normalizeHost).includes(host)) return host;

  if (isIP(host) === 0) {
    // 普通域名交给异步层 DNS 校验；但保留域名此刻就能定案，不必等 DNS
    const reserved = reservedNameVerdict(host, policy);
    if (reserved) {
      throw egressError(
        EGRESS_BLOCKED,
        `outbound target ${host} is not publicly routable (${reserved.label})`,
        { host, label: reserved.label, tier: reserved.tier },
      );
    }
    return host;
  }

  const verdict = classifyIp(host, { policy });
  if (verdict) {
    throw egressError(
      EGRESS_BLOCKED,
      `outbound target ${host} is not publicly routable (${verdict.label})`,
      { host, ...verdict },
    );
  }
  return host;
}

/**
 * 同步层：完整 URL 校验（协议 + 主机）。供 normalizeWebhookUrl 等调用。
 */
export function assertUrlAllowedSync(value, { allowedHosts = [], policy = EGRESS_POLICY.STRICT } = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw egressError(EGRESS_BLOCKED, "outbound target must be a valid http(s) URL");
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw egressError(EGRESS_BLOCKED, `outbound target protocol must be http or https (got ${parsed.protocol})`);
  }
  assertHostAllowed(parsed.hostname, { allowedHosts, policy });
  return parsed.toString();
}

/**
 * 异步层：真正发起请求前调用。解析 DNS 并校验**每一个**解析结果，
 * 阻断 DNS rebinding（域名先答公网 IP 通过检查、随后重绑定到内网）。
 *
 * 解析失败也阻断——拿不到 IP 就无法证明目标安全。
 *
 * @param {string} value 目标 URL
 * @param {{dnsLookup?: Function, allowedHosts?: string[]}} options
 */
export async function assertEgressAllowed(value, { dnsLookup, allowedHosts = [], policy = EGRESS_POLICY.STRICT } = {}) {
  const normalized = assertUrlAllowedSync(value, { allowedHosts, policy });
  const parsed = new URL(normalized);
  const host = normalizeHost(parsed.hostname);

  if (isIP(host) !== 0) return normalized; // 字面量已在同步层校验
  if (allowedHosts.map(normalizeHost).includes(host)) return normalized;

  const lookup = dnsLookup ?? defaultDnsLookup;
  let addresses = [];
  try {
    addresses = await lookup(host);
  } catch (error) {
    throw egressError(
      EGRESS_BLOCKED,
      `outbound target ${host} could not be resolved; refusing to send`,
      { host, cause: error?.message },
    );
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw egressError(EGRESS_BLOCKED, `outbound target ${host} resolved to no address; refusing to send`, { host });
  }

  for (const address of addresses) {
    const ip = typeof address === "string" ? address : address?.address;
    if (!ip) continue;
    const verdict = classifyIp(ip, { policy });
    if (verdict) {
      throw egressError(
        EGRESS_BLOCKED,
        `outbound target ${host} resolves to ${ip}, which is not publicly routable (${verdict.label})`,
        { host, ip, ...verdict },
      );
    }
  }
  return normalized;
}

/** 默认 DNS 解析：注入点，测试可替换。 */
async function defaultDnsLookup(host) {
  const dns = await import("node:dns/promises");
  return dns.lookup(host, { all: true, verbatim: true });
}
