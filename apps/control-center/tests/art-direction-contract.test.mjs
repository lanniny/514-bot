import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicRoot = `${root}/public`;
const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

async function source(path) {
  return (await readFile(`${root}/${path}`, "utf8")).replace(/\r\n/g, "\n");
}

function stripComments(text, extension) {
  let value = text;
  if (extension === "html") value = value.replace(/<!--[\s\S]*?-->/g, "");
  if (["js", "css"].includes(extension)) {
    value = value
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }
  return value;
}

function relativeLuminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map((channel) => Number.parseInt(channel, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(a, b) {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

test("Living Orchestration art direction is the final visual owner", async () => {
  const html = await source("public/index.html");
  const polishIndex = html.indexOf("./forge/experience-polish.css");
  const consoleIndex = html.indexOf("./forge/console-form.css");
  const artIndex = html.indexOf("./forge/art-direction.css");
  assert.ok(
    polishIndex >= 0 && consoleIndex > polishIndex && artIndex > consoleIndex,
    "艺术指导层必须晚于 polish 与 console-form，才能成为明确的视觉所有者",
  );
  const grokFaceIndex = html.indexOf("./forge/bot-grok-face.css");
  const uiPolishIndex = html.indexOf("./forge/ui-polish.css");
  assert.ok(
    grokFaceIndex > uiPolishIndex && grokFaceIndex > artIndex,
    "Grok 默认 Bot 面必须晚于艺术指导与 ui-polish，才能压过工作台浅色与壁纸玻璃",
  );

  const css = await source("public/forge/art-direction.css");
  for (const signature of [
    "--forge-paper:",
    "--forge-ink:",
    "--forge-copper:",
    ".atelier-stage {",
    "#view-team .team-hero {",
    ".team-starmap-shell {",
    ".task-composer .composer-shell:focus-within",
    "@media (prefers-reduced-motion: reduce)",
  ]) {
    assert.ok(css.includes(signature), `艺术指导层缺少签名契约：${signature}`);
  }
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.atelier-stage,\s*#atelier-canvas \{\s*display: none;/,
    "减少动态效果时必须关闭整个环境画布，而非只停 CSS 动画",
  );
  assert.ok(
    contrastRatio("#984126", "#f4f0e7") >= 4.5,
    "亮色暖纸上的铜色小字必须达到 WCAG AA 对比度",
  );
});

test("public UI copy contains no emoji glyphs", async () => {
  const entries = await readdir(publicRoot, { recursive: true });
  const candidates = entries.filter((path) => /\.(?:html|js|css)$/.test(path));
  const violations = [];

  for (const relative of candidates) {
    const extension = relative.split(".").at(-1);
    const text = stripComments(await readFile(`${publicRoot}/${relative}`, "utf8"), extension);
    const match = text.match(emoji);
    if (match) violations.push(`${relative}: ${match[0]}`);
  }

  assert.deepEqual(violations, [], `UI 文案检测到表情符号：${violations.join(", ")}`);
});

test("static icon references use Lucide or explicitly preserved CLI brand marks", async () => {
  const html = await source("public/index.html");
  const references = [...html.matchAll(/<use\s+href="#([^"]+)"/g)].map((match) => match[1]);
  // icon-514-bot = 514 产品自有品牌标（2026-09-09 品牌更新，从 lucide-flame 换成产品 logo），
  // 与 icon-cli-*（CLI 厂商品牌标）同属「显式保留的品牌资产」，不进 Lucide 体系。
  const invalid = references.filter((id) => !id.startsWith("lucide-") && !id.startsWith("icon-cli-") && id !== "icon-514-bot");
  assert.deepEqual(invalid, [], `发现非 Lucide 的界面图标引用：${invalid.join(", ")}`);
  assert.match(html, /id="chrome-rail-toggle"[\s\S]*?<use href="#lucide-panel-left"><\/use>/, "左栏开关必须使用 Lucide 图标");
  assert.doesNotMatch(html, /class="chrome-rail-glyph-(?:frame|bar|hint)"/, "左栏开关不得保留自绘图标路径");
});

test("ambient canvas never schedules animation while reduced motion is active", async () => {
  const canvasSource = await source("public/atelier-canvas.js");
  const motionListeners = new Map();
  const documentListeners = new Map();
  let rafCalls = 0;
  let cancelled = 0;
  const context2d = {
    setTransform() {},
    clearRect() {},
    createRadialGradient() {
      return { addColorStop() {} };
    },
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    arc() {},
    fill() {},
  };
  const canvas = { getContext: () => context2d, style: {} };
  const motionQuery = {
    matches: true,
    addEventListener: (type, listener) => motionListeners.set(type, listener),
    removeEventListener: (type) => motionListeners.delete(type),
  };
  const document = {
    hidden: false,
    documentElement: { dataset: {}, classList: { contains: () => false } },
    getElementById: () => canvas,
    addEventListener: (type, listener) => documentListeners.set(type, listener),
    removeEventListener: (type) => documentListeners.delete(type),
  };
  const window = {
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 720,
    matchMedia: () => motionQuery,
    addEventListener() {},
    removeEventListener() {},
  };

  vm.runInNewContext(canvasSource, {
    document,
    window,
    requestAnimationFrame: () => ++rafCalls,
    cancelAnimationFrame: () => { cancelled += 1; },
  });

  assert.equal(rafCalls, 0, "初始减少动态效果时不得启动 RAF");
  motionListeners.get("change")?.({ matches: false });
  assert.equal(rafCalls, 1, "关闭减少动态效果后应恢复一条 RAF");
  document.hidden = true;
  documentListeners.get("visibilitychange")?.();
  assert.equal(cancelled, 1, "页面转入后台必须取消活动 RAF");
});
