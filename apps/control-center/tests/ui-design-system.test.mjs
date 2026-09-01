import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_TONES, emptyState, inlineEmpty, loadingBlock, skeleton } from "../public/modules/placeholders.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const source = (relative) => readFile(join(appRoot, relative), "utf8");

// ─── 1. 设计令牌：密度乘数与可读性底线 ─────────────────────────────────────────

test("design tokens expose density multipliers with a no-op default", async () => {
  const tokens = await source("public/forge/tokens.css");
  // 默认档必须是 1：不切换密度时与改前逐像素一致
  assert.match(tokens, /--density-space:\s*1\s*;/);
  assert.match(tokens, /--density-leading:\s*1\s*;/);
  assert.match(tokens, /:root\[data-density="compact"\]\s*\{[\s\S]{0,200}--density-space:\s*0\.78/);
  assert.match(tokens, /:root\[data-density="comfortable"\]\s*\{[\s\S]{0,200}--density-space:\s*1\.28/);
  // 间距 scale 必须挂到密度乘数上，否则密度开关只是个摆设
  assert.match(tokens, /--space-4:\s*calc\(16px \* var\(--density-space\)\)/);
});

test("density rules never leak into the default档", async () => {
  const css = await source("public/forge/density.css");
  const rules = [...css.matchAll(/([^{}]+)\{/g)].map((match) => match[1].trim());
  const meaningful = rules.filter((selector) => selector && !selector.startsWith("/*") && !selector.startsWith("@"));
  assert.ok(meaningful.length > 0, "密度表必须有规则");
  for (const selector of meaningful) {
    assert.match(selector, /\[data-density="(compact|comfortable)"\]/, `未加档位限定的规则会污染默认档：${selector}`);
  }
});

test("index.html loads the new design-system layers", async () => {
  const html = await source("public/index.html");
  for (const file of ["./forge/placeholders.css", "./forge/density.css"]) {
    assert.ok(html.includes(file), `index.html 未加载 ${file}`);
  }
  // 密度三档必须可达（否则 CSS 规则永远命中不了）
  for (const value of ["compact", "default", "comfortable"]) {
    assert.match(html, new RegExp(`data-appearance-density="${value}"`), `外观面板缺「${value}」档`);
  }
});

// ─── 2. 占位组件：空状态三分类 ────────────────────────────────────────────────

test("empty state covers the three documented tones", () => {
  assert.deepEqual([...EMPTY_TONES].sort(), ["error", "first-run", "no-result"]);
  for (const tone of EMPTY_TONES) {
    const html = emptyState({ tone, title: "标题" });
    assert.ok(html.includes(`empty-state--${tone}`), `${tone} 缺分类类目`);
    assert.match(html, /role="status"/, "空态必须对辅助技术可感知");
  }
});

test("empty state escapes user text and renders an icon + description", () => {
  const html = emptyState({
    tone: "first-run",
    title: "<img src=x onerror=alert(1)>",
    desc: "说明 & 更多",
    icon: "archive",
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.ok(html.includes("&lt;img src=x"));
  assert.ok(html.includes("&amp;"));
  assert.ok(html.includes('#lucide-archive'));
  assert.ok(html.includes("empty-state-desc"));
});

test("empty state actions wire to a real handler instead of a dead button", () => {
  // view → 复用 app.js 全局点击委托切视图
  assert.match(emptyState({ title: "t", action: { label: "去主机", view: "hosts" } }), /data-view="hosts"/);
  // attrs → 复用调用方现成的委托属性
  assert.match(emptyState({ title: "t", action: { label: "重试", attrs: { "data-config-host-probe": "h1" } } }), /data-config-host-probe="h1"/);
  // 退化路径：至少给出 data-empty-action，不做无属性按钮
  assert.match(emptyState({ title: "t", action: { label: "重试" } }), /data-empty-action="retry"/);
  assert.equal(emptyState({ title: "t" }).includes("<button"), false, "无动作时不渲染按钮");
});

test("inline empty is the single escape hatch for cramped spots", () => {
  const html = inlineEmpty("尚未添加", { className: "provider-opencode-empty" });
  assert.ok(html.startsWith("<p"));
  assert.ok(html.includes("inline-empty provider-opencode-empty"));
  assert.ok(html.includes("尚未添加"));
  assert.ok(inlineEmpty("<b>").includes("&lt;b&gt;"), "行内空提示同样必须转义");
});

// ─── 3. 骨架屏 ───────────────────────────────────────────────────────────────

test("skeleton exposes loading semantics and the requested row count", () => {
  const html = skeleton({ variant: "table", rows: 4, columns: 3, label: "正在读取供应商档案" });
  assert.match(html, /role="status"/);
  assert.match(html, /aria-busy="true"/);
  assert.equal((html.match(/skeleton-row/g) ?? []).length, 4);
  assert.ok(html.includes("skeleton--table"));
  assert.ok(html.includes("sr-only"), "骨架屏必须给屏幕阅读器一句可朗读的文案");
  assert.ok(html.includes("正在读取供应商档案"));
});

test("loadingBlock defaults to a list skeleton", () => {
  assert.ok(loadingBlock({ rows: 2 }).includes("skeleton--list"));
});

test("skeleton respects the reduced-motion contract", async () => {
  const css = await source("public/forge/placeholders.css");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:root\[data-motion="reduce"\]/, "用户级动效开关必须 honored");
});
