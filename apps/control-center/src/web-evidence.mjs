import { createHash } from "node:crypto";

const DISALLOWED_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "127.0.0.1",
  "169.254.169.254", // Cloud metadata
]);

const DISALLOWED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
];

function isPrivateOrLoopbackIPv4(ip) {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  // 127.0.0.0/8
  if (parts[0] === 127) return true;
  // 10.0.0.0/8
  if (parts[0] === 10) return true;
  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 169.254.0.0/16
  if (parts[0] === 169 && parts[1] === 254) return true;
  // 0.0.0.0/8
  if (parts[0] === 0) return true;
  return false;
}

function isPrivateOrLoopbackIPv6(host) {
  const clean = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (clean === "::1" || clean === "::") return true;
  if (clean.startsWith("fe80:") || clean.startsWith("fe80::")) return true;
  if (clean.startsWith("fc00:") || clean.startsWith("fd00:")) return true;
  return false;
}

export function validateSafeWebUrl(rawUrl) {
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

  return {
    safe: true,
    url: parsed.href,
    domain: host,
  };
}

export function extractWebCitations(text) {
  if (!text || typeof text !== "string") {
    return [];
  }

  const citations = [];
  const seenUrls = new Set();

  // Pattern 1: [title](https://...) or [来源: title](https://...)
  const linkRegex = /\[([^\]]+)\]\((https:\/\/[^\s\)]+)\)/gi;
  let match;
  while ((match = linkRegex.exec(text)) !== null) {
    const rawTitle = match[1].trim();
    const rawUrl = match[2].trim();
    const validation = validateSafeWebUrl(rawUrl);
    if (validation.safe && !seenUrls.has(validation.url)) {
      seenUrls.add(validation.url);
      const key = createHash("sha256").update(validation.url).digest("hex").slice(0, 12);
      const title = rawTitle.replace(/^来源:\s*/i, "").slice(0, 100);
      citations.push({
        key,
        title: title || validation.domain,
        url: validation.url,
        domain: validation.domain,
      });
    }
  }

  // Pattern 2: [^1]: https://...
  const footnoteRegex = /\[\^(\d+)\]:\s*(https:\/\/[^\s]+)/gi;
  while ((match = footnoteRegex.exec(text)) !== null) {
    const rawIndex = match[1].trim();
    const rawUrl = match[2].trim();
    const validation = validateSafeWebUrl(rawUrl);
    if (validation.safe && !seenUrls.has(validation.url)) {
      seenUrls.add(validation.url);
      const key = createHash("sha256").update(validation.url).digest("hex").slice(0, 12);
      citations.push({
        key,
        title: `来源 [${rawIndex}] · ${validation.domain}`,
        url: validation.url,
        domain: validation.domain,
      });
    }
  }

  return citations;
}
