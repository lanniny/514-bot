/**
 * static-assets.mjs — 控制台静态资源服务（UI-AUDIT P0-3）
 *
 * 从 server.mjs 抽出，目的有两个：
 *   1. 让"压缩 / 条件请求 / 路径白名单"这套逻辑可单测（此前埋在 3300 行入口脚本
 *      里，改一行只能靠起服务手点验证）；
 *   2. 把性能策略集中在一处，后续接构建指纹（immutable 强缓存）只改本文件。
 *
 * 策略：无构建指纹，故采用「ETag + 短 max-age 重验证」——内容一改立刻失效，
 * 内容未改只回 304（省掉整个响应体）。压缩结果按 etag 缓存，避免重复 CPU 开销。
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

export const PUBLIC_ASSET_PREFIXES = ["/forge/", "/modules/", "/vendor/"];
export const PUBLIC_ASSET_EXTS = new Set([".css", ".js", ".mjs", ".svg", ".json"]);

export const STATIC_MAX_AGE_SECONDS = 60;
export const COMPRESS_MIN_BYTES = 1024;
export const BROTLI_FAST_QUALITY_ABOVE_BYTES = 256 * 1024;

/** 顶层资产的显式路由表（子目录由 resolvePublicAsset 白名单放行）。 */
export const STATIC_ROUTES = Object.freeze({
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/mission-control.js": "mission-control.js",
  "/environment-panel.js": "environment-panel.js",
  "/rail-tools.js": "rail-tools.js",
  "/path-key.js": "path-key.js",
  "/markdown.js": "markdown.js",
  "/theme.js": "theme.js",
  "/styles.css": "styles.css",
  "/atelier.css": "atelier.css",
  "/atelier-canvas.js": "atelier-canvas.js",
  "/lucide.js": "lucide.js",
  "/lucide-sprite.svg": "lucide-sprite.svg",
  "/modules/stream-epoch.js": "modules/stream-epoch.js",
  "/modules/welcome-tips.js": "modules/welcome-tips.js",
  "/modules/resume-hints.js": "modules/resume-hints.js",
  "/modules/agent-roles.js": "modules/agent-roles.js",
  "/rich-render.js": "rich-render.js",
  "/command-palette.js": "command-palette.js",
  "/team-panel.js": "team-panel.js",
  "/channels-panel.js": "channels-panel.js",
  "/office-panel.js": "office-panel.js",
  "/terminal-panel.js": "terminal-panel.js",
  "/market-panel.js": "market-panel.js",
  "/hosts-panel.js": "hosts-panel.js",
  "/splitter.js": "splitter.js",
  "/workbench-chrome.js": "workbench-chrome.js",
  "/hero-starmap.js": "hero-starmap.js",
  "/delta-timeline.js": "delta-timeline.js",
  "/project-bootstrapper.js": "project-bootstrapper.js",
  "/collab-flow.js": "collab-flow.js",
  "/memory-browser.js": "memory-browser.js",
  "/utils.js": "utils.js",
  "/api.js": "api.js",
  "/state.js": "state.js",
});

export function contentTypeFor(file) {
  const ext = extname(file);
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml; charset=utf-8";
  return "text/html; charset=utf-8";
}

/** 子目录资产按段校验放行，拒绝路径逃逸与未知扩展。 */
export function resolvePublicAsset(pathname) {
  if (!PUBLIC_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  if (segments.some((segment) => segment === ".." || segment.includes("\\") || segment.includes("\0"))) return null;
  if (!PUBLIC_ASSET_EXTS.has(extname(segments.at(-1) || ""))) return null;
  return segments.join("/");
}

export function preferredEncoding(request) {
  const header = String(request?.headers?.["accept-encoding"] ?? "");
  if (/\bbr\b/.test(header)) return "br";
  if (/\bgzip\b/.test(header)) return "gzip";
  return "identity";
}

/**
 * 按内容编码压缩。实测（app.js 1.6MB）：brotli q11 = 307KB/2911ms，q5 = 356KB/90ms；
 * q11 会在单核上同步阻塞事件循环近 3 秒，只多省 49KB——首屏首次访问不值得。
 * 大文件走 q5，小文件（绝对成本本就很低）仍用 q11 榨干体积。
 */
export function encodeBody(entry, encoding) {
  if (encoding === "identity" || entry.size < COMPRESS_MIN_BYTES) return { body: entry.body, encoding: "identity" };
  const hit = entry.encodings.get(encoding);
  if (hit) return { body: hit, encoding };
  const quality = entry.size > BROTLI_FAST_QUALITY_ABOVE_BYTES ? 5 : 11;
  const compressed = encoding === "br"
    ? brotliCompressSync(entry.body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: quality } })
    : gzipSync(entry.body, { level: 9 });
  // 压缩收益为负（小文件或已压缩格式）时回退到原文
  if (compressed.length >= entry.body.length) return { body: entry.body, encoding: "identity" };
  entry.encodings.set(encoding, compressed);
  return { body: compressed, encoding };
}

/**
 * @param {object} options
 * @param {string} options.publicRoot
 * @param {object} [options.securityHeaders] 每个响应都要带的安全头
 */
export function createStaticServer({ publicRoot, securityHeaders = {} } = {}) {
  if (!publicRoot) throw new Error("createStaticServer: publicRoot is required");
  /** file → { etag, mtimeMs, size, body, encodings: Map<string, Buffer> } */
  const cache = new Map();

  async function loadStaticEntry(file) {
    let info;
    try {
      info = await stat(join(publicRoot, file));
    } catch {
      return null;
    }
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;
    const body = await readFile(join(publicRoot, file));
    const entry = {
      etag: `W/"${createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`,
      mtimeMs: info.mtimeMs,
      size: info.size,
      body,
      encodings: new Map(),
    };
    cache.set(file, entry);
    return entry;
  }

  /**
   * @returns {Promise<boolean>} 命中静态资产并已响应时为 true，否则 false（交给上层 404）
   */
  async function serveStatic(pathname, response, request = null) {
    if (pathname === "/favicon.ico") {
      response.writeHead(204, { ...securityHeaders, "cache-control": "public, max-age=86400" });
      response.end();
      return true;
    }
    // 子目录资产（/forge/*、/modules/*、/vendor/*）走白名单，顶层资产走显式路由表
    const file = STATIC_ROUTES[pathname] ?? resolvePublicAsset(pathname);
    if (!file) return false;
    const entry = await loadStaticEntry(file);
    if (!entry) return false;
    const type = contentTypeFor(file);
    const headers = {
      ...securityHeaders,
      "content-type": type,
      etag: entry.etag,
      // HTML 每次重验（视图壳可能变）；静态资产 60s 内可复用，之后带 ETag 重验
      "cache-control": extname(file) === ".html" ? "no-cache" : `public, max-age=${STATIC_MAX_AGE_SECONDS}, must-revalidate`,
      vary: "Accept-Encoding",
    };
    const isHead = request?.method === "HEAD";
    // 条件请求：内容未变只回 304，不传响应体
    if (request?.headers?.["if-none-match"] === entry.etag) {
      response.writeHead(304, { ...headers, "content-length": 0 });
      response.end();
      return true;
    }
    const { body, encoding } = encodeBody(entry, preferredEncoding(request));
    if (encoding !== "identity") headers["content-encoding"] = encoding;
    headers["content-length"] = body.length;
    response.writeHead(200, headers);
    response.end(isHead ? undefined : body);
    return true;
  }

  return { serveStatic, loadStaticEntry, cacheSize: () => cache.size };
}
