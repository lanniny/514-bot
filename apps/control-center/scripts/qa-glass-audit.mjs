#!/usr/bin/env node
// 玻璃审计探针：壁纸激活态下逐视图扫描「大面积且几乎不透明」的表面
// （元素自身 / ::before / ::after，含渐变底），输出选择器路径 + 面积，
// 作为玻璃质感统一补齐的权威清单。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, testModelProfiles, waitForUrl } from "../tests/server-fixture.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const token = "glass-audit-token-0123456789";
const VIEWS = ["bot", "workbench", "team", "channels", "overview", "observability", "sessions", "market", "hosts", "config", "automations", "security"];

async function writeConfig(repoRoot) {
  await mkdir(resolve(repoRoot, "config/control-center"), { recursive: true });
  await writeFile(resolve(repoRoot, "config/app.json"), '{"enabled":true}\n');
  await writeFile(resolve(repoRoot, "config/control-center/models.json"), JSON.stringify({
    version: 1,
    profiles: testModelProfiles().map((profile) => ({ ...profile, enabled: true, capabilities: ["*"] })),
  }));
  await writeFile(resolve(repoRoot, "config/control-center/routing.json"), JSON.stringify({
    version: 1, primaryCoordinator: "claude-fable", technicalExecutor: "codex-technical",
    maxRounds: 6, maxDepth: 2, maxParallelAgents: 4, requireHealthyProvider: false,
    failOnUnavailableExplicitProvider: false, weights: { quality: 0.44, speed: 0.26, health: 0.22, cost: 0.08 },
    rules: [], independentPass: { requiredFor: [], mustDifferFromPrimary: true },
  }));
  await writeFile(resolve(repoRoot, "config/control-center/permissions.json"), JSON.stringify({
    version: 1, defaultMode: "plan",
    modes: { plan: { write: false, approvalRequired: false }, build: { write: "workspace", approvalRequired: true } },
    limits: { maxRounds: 8, maxBudgetUsdPerTurn: 2, turnTimeoutMs: 30_000, turnIdleTimeoutMs: 10_000 },
    approval: { ttlMs: 60_000 },
  }));
  await writeFile(resolve(repoRoot, "config/control-center/sources.json"), JSON.stringify({
    version: 1,
    explicit: [
      { id: "control.models", path: "config/control-center/models.json", label: "models", kind: "json", scope: "repo", critical: true },
      { id: "control.routing", path: "config/control-center/routing.json", label: "routing", kind: "json", scope: "repo", critical: true },
      { id: "control.permissions", path: "config/control-center/permissions.json", label: "permissions", kind: "json", scope: "repo", critical: true },
      { id: "control.sources", path: "config/control-center/sources.json", label: "sources", kind: "json", scope: "repo", critical: true },
    ],
    discover: [], runtime: [],
  }));
}

async function vividWallpaperPng() {
  const W = 800, H = 500;
  const raw = Buffer.alloc(H * (1 + W * 3));
  const blobs = [
    { cx: 0.22, cy: 0.3, r: 0.28, color: [255, 196, 0] },
    { cx: 0.72, cy: 0.68, r: 0.34, color: [255, 61, 87] },
    { cx: 0.5, cy: 0.1, r: 0.2, color: [0, 208, 255] },
  ];
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 3);
    raw[row] = 0;
    for (let x = 0; x < W; x++) {
      const t = (x / W + y / H) / 2;
      let r = Math.round(30 + t * 90);
      let g = Math.round(60 + (1 - t) * 60);
      let b = Math.round(160 + t * 80);
      for (const blob of blobs) {
        const dx = x / W - blob.cx, dy = y / H - blob.cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < blob.r) {
          const k = 1 - d / blob.r;
          r = Math.round(r * (1 - k) + blob.color[0] * k);
          g = Math.round(g * (1 - k) + blob.color[1] * k);
          b = Math.round(b * (1 - k) + blob.color[2] * k);
        }
      }
      const o = row + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const { deflateSync } = await import("node:zlib");
  const idat = deflateSync(raw, { level: 6 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crcTable = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main() {
  const root = await mkdtemp(resolve(appRoot, ".qa-glass-audit-"));
  const repoRoot = resolve(root, "repo");
  const dataRoot = resolve(root, "data");
  const fakeHome = resolve(root, "home");
  await writeConfig(repoRoot);
  await mkdir(fakeHome, { recursive: true });
  const server = spawnTestServer({
    env: {
      CONTROL_CENTER_TOKEN: token,
      CONTROL_CENTER_REPO_ROOT: repoRoot,
      CONTROL_CENTER_DATA_DIR: dataRoot,
      CONTROL_CENTER_PORT: "0",
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
  });
  let browser;
  try {
    const url = await waitForUrl(server);
    const origin = new URL(url).origin;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const api = async (path, { method = "GET", body } = {}) => {
      const response = await fetch(new URL(path, origin), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const payload = await response.json();
      assert.ok(response.ok, `${method} ${path} failed (${response.status})`);
      return payload;
    };
    const wallpaperBytes = await vividWallpaperPng();
    await api("/api/wallpapers/global", { method: "POST", body: { dataUrl: `data:image/png;base64,${wallpaperBytes.toString("base64")}` } });
    await api("/api/preferences", { method: "PUT", body: { "514cc-global-wallpaper": JSON.stringify({
      preset: "custom", fit: "cover", overrideTeam: true,
      rotate: { enabled: false, intervalMin: 5, order: "sequential" },
      hasCustom: true, filter: { dim: 0, blur: 0, saturation: 1 },
    }) } });

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#api-connection-badge")?.classList.contains("is-ok") === true, null, { timeout: 30_000 });
    await page.waitForFunction(() => document.body.classList.contains("team-bg-active"), null, { timeout: 30_000 });

    for (const view of VIEWS) {
      await page.evaluate((v) => { location.hash = `#${v}`; }, view);
      await page.waitForTimeout(900);
      const offenders = await page.evaluate(() => {
        const parseAlpha = (color) => {
          const parts = color.match(/^(?:rgba?|color\(|oklab\(|oklch\(|lab\(|lch\()(.*)\)$/);
          if (!parts) return null; // 真不认识的格式不计入
          const segs = parts[1].split(/[\s,]+/).filter(Boolean);
          const last = Number(segs[segs.length - 1]);
          // CSS 语义：无 alpha 分量 = 完全不透明
          if (!Number.isFinite(last) || last > 1) return 1;
          return last;
        };
        const hasPaint = (style) => style.backgroundColor !== "rgba(0, 0, 0, 0)" || (style.backgroundImage && style.backgroundImage !== "none");
        const maxStopAlpha = (image) => {
          if (!image || image === "none") return 0;
          const stops = [...image.matchAll(/\/ ([\d.]+)\)|,\s*([\d.]+)\s*\)/g)].map((m) => Number(m[1] ?? m[2])).filter((n) => Number.isFinite(n) && n <= 1);
          return stops.length ? Math.max(...stops) : 1; // 渐变无显式 alpha 视为不透明
        };
        const path = (el) => {
          const parts = [];
          let node = el;
          while (node && node !== document.body && parts.length < 4) {
            let part = node.tagName.toLowerCase();
            if (node.id) part += `#${node.id}`;
            else if (node.classList?.length) part += `.${[...node.classList].slice(0, 2).join(".")}`;
            parts.unshift(part);
            node = node.parentElement;
          }
          return parts.join(" > ");
        };
        const offenders = [];
        for (const el of document.querySelectorAll("body *")) {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
          if (el.closest("#atelier-stage")) continue; // 壁纸层本身
          const rect = el.getBoundingClientRect();
          const area = rect.width * rect.height;
          if (area < 24_000 || rect.width < 120 || rect.height < 60) continue;
          const layers = [["el", cs]];
          if (getComputedStyle(el, "::before").content !== "none") layers.push(["::before", getComputedStyle(el, "::before")]);
          if (getComputedStyle(el, "::after").content !== "none") layers.push(["::after", getComputedStyle(el, "::after")]);
          for (const [label, style] of layers) {
            if (!hasPaint(style)) continue;
            const alpha = parseAlpha(style.backgroundColor);
            const grad = maxStopAlpha(style.backgroundImage);
            const opaque = (alpha !== null && alpha >= 0.85) || grad >= 0.85;
            if (!opaque) continue;
            offenders.push({
              path: path(el) + (label === "el" ? "" : ` ${label}`),
              area: Math.round(area),
              rect: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
              bg: style.backgroundColor === "rgba(0, 0, 0, 0)" ? `gradient:${style.backgroundImage.slice(0, 60)}` : style.backgroundColor.slice(0, 60),
            });
            break;
          }
        }
        offenders.sort((a, b) => b.area - a.area);
        const seen = new Set();
        return offenders.filter((o) => {
          const key = o.path.replace(/#[^ ]+/g, "#");
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, 12);
      });
      console.log(`\n=== ${view} ===`);
      if (view === "workbench") {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
        const { root } = await cdp.send("DOM.getDocument");
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "form#task-form #composer-shell" });
        const matched = await cdp.send("CSS.getMatchedStylesForNode", { nodeId });
        const win = [];
        for (const m of matched.matchedCSSRules ?? []) {
          const bg = m.rule.style.cssProperties?.find?.((p) => p.name === "background-color") ?? m.rule.style.cssText?.match(/background(?:-color)?:([^;]+);?/)?.[1];
          win.push(`${m.rule.origin} ${(m.rule.selectorList?.text ?? "").slice(0, 60)} => bg:${String(bg).slice(0, 50)}`);
        }
        console.log("  [cdp]", JSON.stringify(win.slice(0, 10), null, 1).slice(0, 1500));
        console.log("  [tokens]", await page.evaluate(() => JSON.stringify({
          wallGlass: document.body.dataset.wallGlass ?? document.documentElement.dataset.wallGlass ?? "none",
          cardAlpha: getComputedStyle(document.documentElement).getPropertyValue("--forge-card-alpha").trim(),
          glassTint: getComputedStyle(document.documentElement).getPropertyValue("--glass-tint").trim(),
          wallTint: getComputedStyle(document.documentElement).getPropertyValue("--wall-tint").trim(),
          surface: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(),
          atShell: (() => {
            const el = document.querySelector("form#task-form #composer-shell");
            if (!el) return "(missing)";
            const cs = getComputedStyle(el);
            const chain = "color-mix(in oklab, var(--glass-tint, var(--wall-tint, var(--surface))) var(--forge-card-alpha, 72%), transparent)";
            const probe = document.createElement("div");
            el.appendChild(probe);
            probe.style.backgroundColor = chain;
            const result = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return JSON.stringify({
              glassTint: cs.getPropertyValue("--glass-tint"),
              wallTint: cs.getPropertyValue("--wall-tint"),
              cardAlpha: cs.getPropertyValue("--forge-card-alpha"),
              surface: cs.getPropertyValue("--surface"),
              mixAtShell: result,
            });
          })(),
          allShells: (() => {
            const views = [...document.querySelectorAll("main section[data-view-panel]")];
            return views.map((view) => {
              const shell = view.querySelector(".composer-shell");
              if (!shell) return `${view.dataset.viewPanel}: (none)`;
              const cs = getComputedStyle(shell);
              const hit = shell.matches("body.team-bg-active .task-composer .composer-shell");
              return `${view.dataset.viewPanel}: ${cs.backgroundColor} hidden=${view.hidden} match=${hit} taskComposer=${!!shell.closest(".task-composer")}`;
            });
          })(),
          mixTest: (() => {
            const el = document.querySelector("#composer-shell");
            const tests = {};
            const probe = document.createElement("div");
            document.body.appendChild(probe);
            const cases = {
              direct: "color-mix(in oklab, var(--wall-tint) 72%, transparent)",
              chain: "color-mix(in oklab, var(--glass-tint, var(--wall-tint, var(--surface))) var(--forge-card-alpha, 72%), transparent)",
              literal: "color-mix(in oklab, oklch(0.965 0.035 287.6) 72%, transparent)",
            };
            for (const [name, value] of Object.entries(cases)) {
              probe.style.backgroundColor = "";
              probe.style.backgroundColor = value;
              tests[name] = getComputedStyle(probe).backgroundColor;
            }
            probe.remove();
            return tests;
          })(),
          workbenchMatches: (() => {
            const el = document.querySelector("form#task-form #composer-shell");
            if (!el) return "(missing)";
            const teamSheet = [...document.styleSheets].find((sheet) => sheet.href?.includes("team.css"));
            const out = { selectorMatch: el.matches("body.team-bg-active .task-composer .composer-shell"), teamRules: [] };
            for (const rule of teamSheet?.cssRules ?? []) {
              if (rule.selectorText?.includes("composer-shell")) {
                let matches = false; try { matches = el.matches(rule.selectorText); } catch {}
                out.teamRules.push(`${matches ? "HIT " : "miss"} ${rule.selectorText.slice(0, 70)} -> ${rule.style?.background?.slice(0, 50) ?? ""}`);
              }
            }
            return out;
          })(),
          matchedRules: (() => {
            const el = document.querySelector("#composer-shell");
            const hits = [];
            for (const sheet of document.styleSheets) {
              let rules; try { rules = sheet.cssRules; } catch { continue; }
              for (const rule of rules) {
                if (rule.selectorText && rule.selectorText.includes("composer-shell") && rule.style?.background) {
                  try { if (el.matches(rule.selectorText)) hits.push(`${sheet.href?.split("/").pop()} :: ${rule.selectorText} -> ${rule.style.background.slice(0, 60)}`); } catch {}
                }
              }
            }
            return hits;
          })(),
          bodyClass: document.body.className.slice(0, 120),
        })));
      }
      for (const o of offenders) console.log(`  ${String(o.area).padStart(9)}  ${o.rect.padEnd(11)} ${o.path}`);
      for (const o of offenders.slice(0, 3)) console.log(`      bg: ${o.bg}`);
    }
    console.log("GLASS-AUDIT-DONE");
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopTestServer(server).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error("GLASS-AUDIT-FAIL:", error?.message ?? error);
  process.exitCode = 1;
});
