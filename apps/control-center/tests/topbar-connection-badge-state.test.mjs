import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { spawnTestServer, stopTestServer, waitForUrl } from "./server-fixture.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

// 页面内把任意 CSS 颜色归一成 [r,g,b,a]（0-255 / 0-1）。canvas 接受 rgb/color(srgb)/oklch 等
// 计算值，draw 到透明画布后 getImageData 拿回具体通道与 alpha。
const NORMALIZE_COLOR = `(cssColor) => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "rgba(0,0,0,0)";
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2], d[3] / 255];
}`;

// WCAG 2.x 相对亮度与对比度（烛 M1 复算同口径）。
function relLuminance([r, g, b]) {
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(rgbA, rgbB) {
  const l1 = relLuminance(rgbA);
  const l2 = relLuminance(rgbB);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
// 把半透明徽标底合成到给定不透明背板（白=浅色顶栏、暗=深色顶栏玻璃近似），复现两主题。
function compositeOver([r, g, b, a], [br, bg, bb]) {
  return [a * r + (1 - a) * br, a * g + (1 - a) * bg, a * b + (1 - a) * bb, 1];
}
const WHITE = [255, 255, 255];
const DARK = [15, 15, 15]; // --bot-glass-bg over #050505 ≈ #0f0f0f

// 回归锚点：2026-10-10。bot-grok-face.css 曾用 ID 选择器 #api-connection-badge 无条件把圆点刷绿，
// 压过 styles.css 的状态类 → apiState=error 时圆点仍渲染 rgb(34,197,94) 绿（健康指示灯撒谎）。
// 契约（三层，全部机械判定，防恒真/恒弱断言）：
//   ① 圆点 hue 跟随状态（ok 绿 / warning 琥珀 / error 红 / pending·unknown 灰）；
//   ② error 徽标底须红主导（非仅"非绿"——透明/白底不得蒙混）；
//   ③ 状态文字 vs 徽标底在浅/深两顶板下 WCAG 对比度均 ≥4.5:1（烛 M1：12px/600 需 AA）。
test("连接徽标三态：圆点跟随状态、error 底红主导、文字对比度过 AA", { timeout: 90_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-badge-state-"));
  const token = "badge-state-token";
  const child = spawnTestServer({
    env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    await stopTestServer(child, { token }).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
  });

  const fullUrl = await waitForUrl(child);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(fullUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#api-connection-badge", { timeout: 15_000 });

  const result = await page.evaluate((normalizeSrc) => {
    const normalize = eval(normalizeSrc);
    const html = document.documentElement;
    const badge = document.getElementById("api-connection-badge");
    const dot = badge.querySelector(".status-dot");
    const label = badge.querySelector(".connection-badge-label");
    const readState = (cls) => {
      badge.className = `connection-badge ${cls}`;
      dot.className = `status-dot ${cls}`;
      return {
        dot: normalize(getComputedStyle(dot).backgroundColor),
        dotRaw: getComputedStyle(dot).backgroundColor,
        bg: normalize(getComputedStyle(badge).backgroundColor),
        bgRaw: getComputedStyle(badge).backgroundColor,
        text: normalize(getComputedStyle(label).color),
        textRaw: getComputedStyle(label).color,
      };
    };
    return {
      onGrokFace: html.classList.contains("is-bot-grok-face") && html.classList.contains("is-bot-surface"),
      ok: readState("is-ok"),
      warning: readState("is-warning"),
      error: readState("is-error"),
      pending: readState("is-pending"),
      unknown: readState("is-unknown"),
    };
  }, NORMALIZE_COLOR);

  assert.equal(result.onGrokFace, true, "必须在 grok-face bot 表面上跑，否则测不到那条 ID 规则");

  // ── ① 圆点 hue ──
  const [gr, gg, gb] = result.ok.dot;
  assert.ok(gg > gr + 30 && gg > gb + 30, `ok 圆点必须绿主导，实测 ${result.ok.dotRaw}`);
  const [wr, wg, wb] = result.warning.dot;
  assert.ok(wr > wb + 40 && wg > wb + 40, `warning 圆点必须琥珀主导（R、G 均显著高于 B），实测 ${result.warning.dotRaw}`);
  const [er, eg, eb] = result.error.dot;
  assert.ok(er > eg + 30 && er > eb + 30, `error 圆点必须红主导，实测 ${result.error.dotRaw}`);

  // pending/unknown 圆点必须灰主导（低饱和）——锁死「pending 不得飘绿」的原始契约
  for (const key of ["pending", "unknown"]) {
    const [r, g, b] = result[key].dot;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    assert.ok(sat < 40, `${key} 圆点必须灰主导（饱和度<40，不得飘绿/飘红），实测 ${result[key].dotRaw}`);
  }

  // ── ② error 徽标底红主导（非仅"非绿"）──
  const [ebr, ebg, ebb] = result.error.bg;
  assert.ok(ebr > ebg && ebr > ebb, `error 徽标底必须红主导（R≥G 且 R≥B），实测 ${result.error.bgRaw}`);

  // ── ③ 文字对比度 AA（浅/深两顶板）──
  for (const key of ["ok", "warning", "error"]) {
    const s = result[key];
    const onWhite = contrast(s.text, compositeOver(s.bg, WHITE));
    const onDark = contrast(s.text, compositeOver(s.bg, DARK));
    assert.ok(onWhite >= 4.5,
      `${key} 文字在浅色顶板对比度须 ≥4.5:1，实测 ${onWhite.toFixed(2)}（text=${s.textRaw} bg=${s.bgRaw}）`);
    assert.ok(onDark >= 4.5,
      `${key} 文字在深色顶板对比度须 ≥4.5:1，实测 ${onDark.toFixed(2)}（text=${s.textRaw} bg=${s.bgRaw}）`);
  }
});

// 回归锚点：2026-10-10。bot 面桌面宽度下 chrome-ops-toggle 与 global-mc-toggle 曾并排出现
// 两个一模一样的 panel-right 图标（都切 bot-agent-panel）。global-mc-toggle 的 workbench
// 分支已随协作台退役失效，只剩与 chrome-ops-toggle 完全重复这一条活路；现于 bot 面隐藏
// global-mc-toggle（bot-shell.css），chrome-ops-toggle 成为唯一右栏入口。
// 契约：bot 面顶栏里可见的右栏开关（aria-controls=bot-agent-panel）必须恰好一个是 chrome-ops-toggle。
test("bot 面顶栏只暴露一个右栏开关（chrome-ops-toggle），重复的 global-mc-toggle 不显示", { timeout: 60_000 }, async (t) => {
  const dataRoot = await mkdtemp(resolve(appRoot, ".test-topbar-dedup-"));
  const token = "topbar-dedup-token";
  const child = spawnTestServer({
    env: { CONTROL_CENTER_TOKEN: token, CONTROL_CENTER_DATA_DIR: dataRoot, CONTROL_CENTER_PORT: "0" },
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    await stopTestServer(child, { token }).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
  });
  const fullUrl = await waitForUrl(child);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(fullUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chrome-ops-toggle", { timeout: 15_000 });

  const snapshot = await page.evaluate(() => {
    const shown = (el) => Boolean(el) && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
    const rightRail = [...document.querySelectorAll(".topbar [aria-controls='bot-agent-panel']")]
      .filter(shown).map((el) => el.id);
    return {
      onBotSurface: document.documentElement.classList.contains("is-bot-surface"),
      rightRail,
      mcShown: shown(document.getElementById("global-mc-toggle")),
      opsShown: shown(document.getElementById("chrome-ops-toggle")),
    };
  });

  assert.equal(snapshot.onBotSurface, true, "必须在 bot 表面上跑");
  assert.equal(snapshot.mcShown, false, "global-mc-toggle 在 bot 面不得显示（与 chrome-ops-toggle 重复）");
  assert.equal(snapshot.opsShown, true, "chrome-ops-toggle 必须可见（唯一右栏入口）");
  assert.deepEqual(snapshot.rightRail, ["chrome-ops-toggle"], "可见右栏开关必须恰好是 chrome-ops-toggle 一个");
});
